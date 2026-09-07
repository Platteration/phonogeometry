// WebGL2 implementation of the plane-sweep stereo in planeSweep.js. Same cost (ZNCC over a
// box window, mean of the best half of the neighbours), same winner selection, uniqueness
// test and sub-plane parabola refinement, but every plane is one handful of draw calls.
// Works on the main thread or in a worker (OffscreenCanvas). Returns null when WebGL2 with
// float render targets is unavailable so callers can fall back to the CPU version.
import { relativePose, inv3, matMul, matVec } from './linalg.js';
import { boxSum, medianFilterDepth } from './image.js';

const VS = `#version 300 es
void main() {
  // Fullscreen triangle
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Warp the neighbour into the reference view for one plane: (mask, J, J^2, I*J)
const FS_WARP = `#version 300 es
precision highp float;
uniform sampler2D uRef;
uniform sampler2D uNb;
uniform mat3 uH;
uniform vec2 uNbSize;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy - 0.5;
  vec3 q = uH * vec3(p, 1.0);
  if (q.z <= 1e-9) { o = vec4(0.0); return; }
  vec2 s = q.xy / q.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x > uNbSize.x - 1.0 || s.y > uNbSize.y - 1.0) { o = vec4(0.0); return; }
  float J = texture(uNb, (s + 0.5) / uNbSize).r * 255.0;
  float I = texelFetch(uRef, ivec2(p), 0).r * 255.0;
  o = vec4(1.0, J, J * J, I * J);
}`;

// Separable box sum
const FS_BOX = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uR;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uSrc, 0);
  vec4 s = vec4(0.0);
  for (int k = -uR; k <= uR; k++) {
    ivec2 q = p + k * uDir;
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
    s += texelFetch(uSrc, q, 0);
  }
  o = s;
}`;

// ZNCC cost per neighbour, aggregated as the mean of the best half
const FS_COST = `#version 300 es
precision highp float;
uniform sampler2D uS0; uniform sampler2D uS1; uniform sampler2D uS2; uniform sampler2D uS3;
uniform sampler2D uRefStats; // (sum I, sum I^2)
uniform int uK;
uniform int uKeep;
uniform float uWin;
out vec4 o;
float costOf(vec4 s, vec2 st) {
  if (s.x < uWin) return 3.0;
  float varI = st.y - st.x * st.x / uWin;
  float varJ = s.z - s.y * s.y / uWin;
  if (varI < 4.0 * uWin || varJ < 4.0 * uWin) return 3.0;
  float cov = s.w - st.x * s.y / uWin;
  float z = clamp(cov / sqrt(varI * varJ), -1.0, 1.0);
  return 1.0 - z;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 st = texelFetch(uRefStats, p, 0).rg;
  float c[4];
  c[0] = uK > 0 ? costOf(texelFetch(uS0, p, 0), st) : 3.0;
  c[1] = uK > 1 ? costOf(texelFetch(uS1, p, 0), st) : 3.0;
  c[2] = uK > 2 ? costOf(texelFetch(uS2, p, 0), st) : 3.0;
  c[3] = uK > 3 ? costOf(texelFetch(uS3, p, 0), st) : 3.0;
  // sort ascending (4-element network)
  #define SWAP(a,b) if (c[a] > c[b]) { float t = c[a]; c[a] = c[b]; c[b] = t; }
  SWAP(0,1) SWAP(2,3) SWAP(0,2) SWAP(1,3) SWAP(1,2)
  int valid = 0;
  for (int i = 0; i < 4; i++) if (c[i] < 3.0) valid++;
  if (valid == 0) { o = vec4(3.0); return; }
  int n = min(valid, valid > uKeep ? uKeep : valid);
  float s = 0.0;
  for (int i = 0; i < 4; i++) if (i < n) s += c[i];
  o = vec4(s / float(n));
}`;

// Winner-takes-all over the cost volume with uniqueness and parabola refinement
const FS_FINAL = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uCost;
uniform int uPlanes;
uniform float uInvMin;
uniform float uInvMax;
uniform float uMaxCost;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e9; int bi = -1;
  for (int i = 0; i < uPlanes; i++) {
    float c = texelFetch(uCost, ivec3(p, i), 0).r;
    if (c < best) { best = c; bi = i; }
  }
  if (bi < 0 || best > uMaxCost) { o = vec4(0.0); return; }
  float second = 1e9;
  for (int i = 0; i < uPlanes; i++) {
    if (abs(i - bi) <= 2) continue;
    float c = texelFetch(uCost, ivec3(p, i), 0).r;
    if (c < second) second = c;
  }
  float uniq = second >= 3.0 ? 1.0 : (second - best) / max(1e-6, second);
  if (uniq < 0.08) { o = vec4(0.0); return; }
  float pos = float(bi);
  if (bi > 0 && bi < uPlanes - 1) {
    float c0 = texelFetch(uCost, ivec3(p, bi - 1), 0).r;
    float c2 = texelFetch(uCost, ivec3(p, bi + 1), 0).r;
    float den = c0 - 2.0 * best + c2;
    if (den > 1e-9) pos = float(bi) + 0.5 * (c0 - c2) / den;
  }
  float invD = uInvMin + (uInvMax - uInvMin) * (pos / max(1.0, float(uPlanes - 1)));
  o = vec4(1.0 / invD, min(1.0, (1.0 - best) * uniq * 2.0), 0.0, 0.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  return sh;
}
function program(gl, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  return prog;
}

function intrinsics(v) { return new Float64Array([v.f, 0, v.cx, 0, v.f, v.cy, 0, 0, 1]); }

/**
 * @returns {{computeDepthMap: Function, dispose: Function, info: string}|null}
 */
export function createGpuSweeper() {
  let canvas;
  try {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  } catch { canvas = null; }
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;
  let progs;
  try {
    progs = { warp: program(gl, FS_WARP), box: program(gl, FS_BOX), cost: program(gl, FS_COST), final: program(gl, FS_FINAL) };
  } catch { return null; }
  const fbo = gl.createFramebuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL2';

  const tex2d = (internal, w, h, format, type, data, linear) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
    return t;
  };
  const grayTex = (gray, w, h) => {
    const u8 = new Uint8Array(w * h);
    for (let i = 0; i < u8.length; i++) u8[i] = gray[i] < 0 ? 0 : gray[i] > 255 ? 255 : gray[i] + 0.5;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    return tex2d(gl.R8, w, h, gl.RED, gl.UNSIGNED_BYTE, u8, true);
  };
  const bindTarget = (tex, w, h, layer = -1) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    if (layer >= 0) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  };
  const bindSampler = (prog, name, unit, tex, target = gl.TEXTURE_2D) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  function computeDepthMap(ref, neighbors, opts = {}) {
    const { w, h } = ref;
    const numPlanes = opts.numPlanes ?? 64;
    const radius = opts.radius ?? 3;
    const minZncc = opts.minZncc ?? 0.55;
    const invMin = 1 / opts.dmax, invMax = 1 / opts.dmin;
    const k = Math.min(4, neighbors.length);
    const keep = k >= 3 ? Math.ceil(k / 2) : k;
    const win = (2 * radius + 1) ** 2;
    const Kr = intrinsics(ref), KrInv = inv3(Kr);
    const allocated = [];
    const track = (t) => { allocated.push(t); return t; };
    try {
      // Reference textures: gray (R8) and window statistics (RG32F), stats computed on the CPU once
      const refTex = track(grayTex(ref.gray, w, h));
      const I2 = new Float32Array(w * h);
      for (let i = 0; i < I2.length; i++) I2[i] = ref.gray[i] * ref.gray[i];
      const sI = boxSum(ref.gray, w, h, radius), sI2 = boxSum(I2, w, h, radius);
      const stats = new Float32Array(w * h * 2);
      for (let i = 0; i < w * h; i++) { stats[i * 2] = sI[i]; stats[i * 2 + 1] = sI2[i]; }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      const statsTex = track(tex2d(gl.RG32F, w, h, gl.RG, gl.FLOAT, stats, false));
      const nbs = neighbors.slice(0, k).map((nb) => {
        const rel = relativePose(ref.R, ref.t, nb.R, nb.t);
        const Kn = intrinsics(nb);
        const A = matMul(matMul(Kn, rel.R, 3, 3, 3), KrInv, 3, 3, 3);
        const Kt = matVec(Kn, rel.t, 3, 3);
        const B = new Float64Array(9);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) B[r * 3 + c] = Kt[r] * KrInv[6 + c];
        return { A, B, w: nb.w, h: nb.h, tex: track(grayTex(nb.gray, nb.w, nb.h)) };
      });
      const warpTex = track(tex2d(gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null, false));
      const boxTmp = track(tex2d(gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null, false));
      const sumTex = nbs.map(() => track(tex2d(gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null, false)));
      const costTex = track(gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, costTex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, w, h, numPlanes);
      const outTex = track(tex2d(gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null, false));

      const H = new Float32Array(9);
      for (let p = 0; p < numPlanes; p++) {
        const d = 1 / (invMin + (invMax - invMin) * (p / Math.max(1, numPlanes - 1)));
        for (let ni = 0; ni < nbs.length; ni++) {
          const nb = nbs[ni];
          // GLSL mat3 is column-major
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[c * 3 + r] = nb.A[r * 3 + c] + nb.B[r * 3 + c] / d;
          gl.useProgram(progs.warp);
          bindTarget(warpTex, w, h);
          bindSampler(progs.warp, 'uRef', 0, refTex);
          bindSampler(progs.warp, 'uNb', 1, nb.tex);
          gl.uniformMatrix3fv(gl.getUniformLocation(progs.warp, 'uH'), false, H);
          gl.uniform2f(gl.getUniformLocation(progs.warp, 'uNbSize'), nb.w, nb.h);
          draw();
          gl.useProgram(progs.box);
          gl.uniform1i(gl.getUniformLocation(progs.box, 'uR'), radius);
          bindTarget(boxTmp, w, h);
          bindSampler(progs.box, 'uSrc', 0, warpTex);
          gl.uniform2i(gl.getUniformLocation(progs.box, 'uDir'), 1, 0);
          draw();
          bindTarget(sumTex[ni], w, h);
          bindSampler(progs.box, 'uSrc', 0, boxTmp);
          gl.uniform2i(gl.getUniformLocation(progs.box, 'uDir'), 0, 1);
          draw();
        }
        gl.useProgram(progs.cost);
        bindTarget(costTex, w, h, p);
        for (let ni = 0; ni < 4; ni++) bindSampler(progs.cost, `uS${ni}`, ni, sumTex[Math.min(ni, nbs.length - 1)]);
        bindSampler(progs.cost, 'uRefStats', 4, statsTex);
        gl.uniform1i(gl.getUniformLocation(progs.cost, 'uK'), nbs.length);
        gl.uniform1i(gl.getUniformLocation(progs.cost, 'uKeep'), keep);
        gl.uniform1f(gl.getUniformLocation(progs.cost, 'uWin'), win);
        draw();
      }
      gl.useProgram(progs.final);
      bindTarget(outTex, w, h);
      bindSampler(progs.final, 'uCost', 0, costTex, gl.TEXTURE_2D_ARRAY);
      gl.uniform1i(gl.getUniformLocation(progs.final, 'uPlanes'), numPlanes);
      gl.uniform1f(gl.getUniformLocation(progs.final, 'uInvMin'), invMin);
      gl.uniform1f(gl.getUniformLocation(progs.final, 'uInvMax'), invMax);
      gl.uniform1f(gl.getUniformLocation(progs.final, 'uMaxCost'), 1 - minZncc);
      draw();
      const out = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error('WebGL error ' + err);
      const depth = new Float32Array(w * h), confidence = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) { depth[i] = out[i * 4]; confidence[i] = out[i * 4 + 1]; }
      return { depth: medianFilterDepth(depth, w, h), confidence };
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const t of allocated) gl.deleteTexture(t);
    }
  }

  return {
    info,
    computeDepthMap,
    isLost: () => gl.isContextLost(),
    dispose() {
      for (const p of Object.values(progs)) gl.deleteProgram(p);
      gl.deleteFramebuffer(fbo);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
