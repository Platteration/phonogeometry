// Synthetic textured scenes rendered analytically (ray casting) for end-to-end tests.
import { rng } from './helpers.js';
import { undistortNormalized } from '../src/vision/geometry.js';

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth-ish multi-octave value noise texture in [0,255]. */
export function texture(u, v) {
  let s = 0, amp = 1, freq = 1, total = 0;
  for (let o = 0; o < 4; o++) {
    const x = u * freq, y = v * freq;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const a = hash(x0, y0), b = hash(x0 + 1, y0), c = hash(x0, y0 + 1), d = hash(x0 + 1, y0 + 1);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const val = (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
    s += val * amp; total += amp; amp *= 0.6; freq *= 2.3;
  }
  // Add hard-edged blocks so that FAST has corners to find
  const block = (hash(Math.floor(u * 3.1), Math.floor(v * 3.1)) > 0.5) ? 0.25 : -0.25;
  return Math.max(0, Math.min(255, (s / total + block) * 255));
}

/**
 * Ray-cast the inside of a textured axis-aligned box (a "room") of half-size `half`
 * centred at the origin. Returns {gray, depth, rgba} at the given resolution.
 */
export function renderRoom(cam, w, h, f, cx, cy, half = 2, k1 = 0) {
  const gray = new Float32Array(w * h), depth = new Float32Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const R = cam.R, t = cam.t;
  // camera centre
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [ux, uy] = k1 ? undistortNormalized((x - cx) / f, (y - cy) / f, k1) : [(x - cx) / f, (y - cy) / f];
      const dc = [ux, uy, 1];
      const dw = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      let best = Infinity, uv = null, face = -1;
      for (let a = 0; a < 3; a++) {
        for (const s of [-1, 1]) {
          if (Math.abs(dw[a]) < 1e-9) continue;
          const tt = (s * half - C[a]) / dw[a];
          if (tt <= 0 || tt >= best) continue;
          const p = [C[0] + dw[0] * tt, C[1] + dw[1] * tt, C[2] + dw[2] * tt];
          const b = (a + 1) % 3, c = (a + 2) % 3;
          if (Math.abs(p[b]) <= half && Math.abs(p[c]) <= half) { best = tt; uv = [p[b] + 10 * a, p[c] + 10 * s]; face = a * 2 + (s > 0 ? 1 : 0); }
        }
      }
      const i = y * w + x;
      if (!uv) continue;
      const g = texture(uv[0] * 2.5, uv[1] * 2.5);
      gray[i] = g; depth[i] = best; // ray direction has z=1 in camera space -> tt is the camera depth
      const o = i * 4;
      rgba[o] = g * (face % 2 ? 1 : 0.8); rgba[o + 1] = g * 0.9; rgba[o + 2] = g * (face > 2 ? 1 : 0.7); rgba[o + 3] = 255;
    }
  }
  return { gray, depth, rgba };
}

/** Ray-cast a textured sphere in front of a textured back wall (an "object" scene). */
export function renderObject(cam, w, h, f, cx, cy, radius = 1, wallZ = 3, k1 = 0) {
  const gray = new Float32Array(w * h), depth = new Float32Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const R = cam.R, t = cam.t;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [ux, uy] = k1 ? undistortNormalized((x - cx) / f, (y - cy) / f, k1) : [(x - cx) / f, (y - cy) / f];
      const dc = [ux, uy, 1];
      const dw = [R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2], R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2], R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2]];
      // sphere at origin
      const b = C[0] * dw[0] + C[1] * dw[1] + C[2] * dw[2];
      const cc = C[0] * C[0] + C[1] * C[1] + C[2] * C[2] - radius * radius;
      const aa = dw[0] * dw[0] + dw[1] * dw[1] + dw[2] * dw[2];
      const disc = b * b - aa * cc;
      let best = Infinity, g = 0, col = [0, 0, 0];
      if (disc > 0) {
        const tt = (-b - Math.sqrt(disc)) / aa;
        if (tt > 0) {
          best = tt;
          const p = [C[0] + dw[0] * tt, C[1] + dw[1] * tt, C[2] + dw[2] * tt];
          const u = Math.atan2(p[0], p[2]), v = Math.asin(Math.max(-1, Math.min(1, p[1] / radius)));
          g = texture(u * 4, v * 4);
          col = [g, g * 0.6, g * 0.4];
        }
      }
      if (best === Infinity && Math.abs(dw[2]) > 1e-9) {
        const tt = (wallZ - C[2]) / dw[2];
        if (tt > 0) {
          best = tt;
          const p = [C[0] + dw[0] * tt, C[1] + dw[1] * tt];
          g = texture(p[0] * 2 + 50, p[1] * 2 + 50);
          col = [g * 0.5, g * 0.7, g];
        }
      }
      const i = y * w + x;
      if (best === Infinity) continue;
      gray[i] = g; depth[i] = best;
      rgba[i * 4] = col[0]; rgba[i * 4 + 1] = col[1]; rgba[i * 4 + 2] = col[2]; rgba[i * 4 + 3] = 255;
    }
  }
  return { gray, depth, rgba };
}

export { rng };
