// Multi-view plane-sweep stereo with zero-mean normalised cross-correlation (ZNCC).
// ZNCC makes the matching robust to the exposure and colour differences between
// different physical cameras on the same phone.
import { relativePose, inv3, matMul, matVec } from './linalg.js';
import { boxSum, sampleBilinear, medianFilterDepth } from './image.js';

function intrinsics(v) {
  return new Float64Array([v.f, 0, v.cx, 0, v.f, v.cy, 0, 0, 1]);
}

/**
 * Compute a depth map for the reference view.
 * @param ref {gray, w, h, f, cx, cy, R, t}
 * @param neighbors array of views with the same shape as ref
 * @param opts {dmin, dmax, numPlanes, radius, minZncc}
 * @returns {{depth: Float32Array, confidence: Float32Array}}
 */
export function computeDepthMap(ref, neighbors, opts = {}) {
  const { w, h } = ref;
  const numPlanes = opts.numPlanes ?? 64;
  const radius = opts.radius ?? 3;
  const minZncc = opts.minZncc ?? 0.55;
  const dmin = opts.dmin, dmax = opts.dmax;
  const invMin = 1 / dmax, invMax = 1 / dmin;
  const N = w * h;
  const Kr = intrinsics(ref), KrInv = inv3(Kr);

  // Reference statistics are recomputed per plane under the validity mask, so we
  // only need I and I^2 as images.
  const I = ref.gray;
  const I2 = new Float32Array(N);
  for (let i = 0; i < N; i++) I2[i] = I[i] * I[i];

  const nbInfo = neighbors.map((nb) => {
    const rel = relativePose(ref.R, ref.t, nb.R, nb.t);
    const Kn = intrinsics(nb);
    // H(d) = Kn (R + t n^T / d) Kr^-1 with n = (0,0,1): A = Kn R Kr^-1, B = Kn t (as column) * row(Kr^-1)[2]
    const A = matMul(matMul(Kn, rel.R, 3, 3, 3), KrInv, 3, 3, 3);
    const Kt = matVec(Kn, rel.t, 3, 3);
    const B = new Float64Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) B[r * 3 + c] = Kt[r] * KrInv[6 + c];
    return { A, B, gray: nb.gray, w: nb.w, h: nb.h };
  });

  const costVolume = new Float32Array(numPlanes * N).fill(2);
  const J = new Float32Array(N), J2 = new Float32Array(N), IJ = new Float32Array(N);
  const M = new Float32Array(N), IM = new Float32Array(N), I2M = new Float32Array(N);
  const sJ = new Float32Array(N), sJ2 = new Float32Array(N), sIJ = new Float32Array(N);
  const sM = new Float32Array(N), sIM = new Float32Array(N), sI2M = new Float32Array(N);
  const planeCost = new Float32Array(N);
  const planeCount = new Uint8Array(N);
  const nbCosts = nbInfo.map(() => new Float32Array(N));
  const minWindow = Math.max(4, Math.floor(0.6 * (2 * radius + 1) ** 2));

  for (let p = 0; p < numPlanes; p++) {
    const invD = invMin + (invMax - invMin) * (p / Math.max(1, numPlanes - 1));
    const d = 1 / invD;
    planeCost.fill(0); planeCount.fill(0);
    for (let ni = 0; ni < nbInfo.length; ni++) {
      const nb = nbInfo[ni];
      const H = new Float64Array(9);
      for (let k = 0; k < 9; k++) H[k] = nb.A[k] + nb.B[k] / d;
      // Warp neighbour into the reference view
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i++) {
          const zz = H[6] * x + H[7] * y + H[8];
          if (zz <= 1e-9) { M[i] = 0; J[i] = 0; J2[i] = 0; IJ[i] = 0; IM[i] = 0; I2M[i] = 0; continue; }
          const px = (H[0] * x + H[1] * y + H[2]) / zz;
          const py = (H[3] * x + H[4] * y + H[5]) / zz;
          const v = sampleBilinear(nb.gray, nb.w, nb.h, px, py);
          if (Number.isNaN(v)) { M[i] = 0; J[i] = 0; J2[i] = 0; IJ[i] = 0; IM[i] = 0; I2M[i] = 0; continue; }
          M[i] = 1; J[i] = v; J2[i] = v * v; IJ[i] = I[i] * v; IM[i] = I[i]; I2M[i] = I2[i];
        }
      }
      boxSum(M, w, h, radius, sM); boxSum(J, w, h, radius, sJ); boxSum(J2, w, h, radius, sJ2);
      boxSum(IJ, w, h, radius, sIJ); boxSum(IM, w, h, radius, sIM); boxSum(I2M, w, h, radius, sI2M);
      const nc = nbCosts[ni];
      for (let i = 0; i < N; i++) {
        const n = sM[i];
        if (n < minWindow) { nc[i] = NaN; continue; }
        const varI = sI2M[i] - sIM[i] * sIM[i] / n;
        const varJ = sJ2[i] - sJ[i] * sJ[i] / n;
        if (varI < 4 * n || varJ < 4 * n) { nc[i] = NaN; continue; } // textureless window
        const cov = sIJ[i] - sIM[i] * sJ[i] / n;
        const zncc = cov / Math.sqrt(varI * varJ);
        nc[i] = 1 - Math.max(-1, Math.min(1, zncc));
      }
    }
    // Aggregate over neighbours: mean of the best half (handles occlusions)
    const k = nbInfo.length;
    const keep = k >= 3 ? Math.ceil(k / 2) : k;
    const tmp = new Float32Array(k);
    for (let i = 0; i < N; i++) {
      let cnt = 0;
      for (let ni = 0; ni < k; ni++) { const c = nbCosts[ni][i]; if (!Number.isNaN(c)) tmp[cnt++] = c; }
      if (cnt === 0) continue;
      if (cnt > keep) { const arr = Array.from(tmp.subarray(0, cnt)).sort((a, b) => a - b); let s = 0; for (let q = 0; q < keep; q++) s += arr[q]; costVolume[p * N + i] = s / keep; }
      else { let s = 0; for (let q = 0; q < cnt; q++) s += tmp[q]; costVolume[p * N + i] = s / cnt; }
    }
  }

  // Winner takes all with sub-plane refinement and uniqueness confidence
  const depth = new Float32Array(N);
  const confidence = new Float32Array(N);
  const maxCost = 1 - minZncc;
  for (let i = 0; i < N; i++) {
    let best = Infinity, bi = -1;
    for (let p = 0; p < numPlanes; p++) { const c = costVolume[p * N + i]; if (c < best) { best = c; bi = p; } }
    if (bi < 0 || best > maxCost) continue;
    let second = Infinity;
    for (let p = 0; p < numPlanes; p++) { if (Math.abs(p - bi) <= 2) continue; const c = costVolume[p * N + i]; if (c < second) second = c; }
    const uniq = second === Infinity ? 1 : (second - best) / Math.max(1e-6, second);
    if (uniq < 0.08) continue;
    let pos = bi;
    if (bi > 0 && bi < numPlanes - 1) {
      const c0 = costVolume[(bi - 1) * N + i], c1 = best, c2 = costVolume[(bi + 1) * N + i];
      const den = c0 - 2 * c1 + c2;
      if (den > 1e-9) pos = bi + 0.5 * (c0 - c2) / den;
    }
    const invD = invMin + (invMax - invMin) * (pos / Math.max(1, numPlanes - 1));
    depth[i] = 1 / invD;
    confidence[i] = Math.min(1, (1 - best) * uniq * 2);
  }
  return { depth: medianFilterDepth(depth, w, h), confidence };
}

/**
 * Geometric consistency filter: keep a depth only when at least `minAgree` neighbouring
 * depth maps see the same 3D point at a consistent depth.
 * @param views [{depth, w, h, f, cx, cy, R, t}] all with depth maps
 * @param neighborIdx per-view array of neighbour indices
 */
export function filterDepthConsistency(views, neighborIdx, opts = {}) {
  const relTol = opts.relTol ?? 0.04;
  const minAgree = opts.minAgree ?? 1;
  const filtered = views.map((v) => (v && v.depth ? new Float32Array(v.depth.length) : null));
  for (let vi = 0; vi < views.length; vi++) {
    const v = views[vi];
    if (!v || !v.depth) continue;
    const nbs = neighborIdx[vi].filter((n) => views[n] && views[n].depth);
    const rels = nbs.map((n) => relativePose(v.R, v.t, views[n].R, views[n].t));
    for (let y = 0, i = 0; y < v.h; y++) {
      for (let x = 0; x < v.w; x++, i++) {
        const d = v.depth[i];
        if (!(d > 0)) continue;
        const X = [((x - v.cx) / v.f) * d, ((y - v.cy) / v.f) * d, d];
        let agree = 0;
        for (let k = 0; k < nbs.length; k++) {
          const nb = views[nbs[k]], rel = rels[k];
          const Xn = [
            rel.R[0] * X[0] + rel.R[1] * X[1] + rel.R[2] * X[2] + rel.t[0],
            rel.R[3] * X[0] + rel.R[4] * X[1] + rel.R[5] * X[2] + rel.t[1],
            rel.R[6] * X[0] + rel.R[7] * X[1] + rel.R[8] * X[2] + rel.t[2],
          ];
          if (Xn[2] <= 0) continue;
          const px = Math.round(nb.f * Xn[0] / Xn[2] + nb.cx), py = Math.round(nb.f * Xn[1] / Xn[2] + nb.cy);
          if (px < 0 || py < 0 || px >= nb.w || py >= nb.h) continue;
          const dn = nb.depth[py * nb.w + px];
          if (dn > 0 && Math.abs(dn - Xn[2]) < relTol * Xn[2]) agree++;
        }
        if (agree >= minAgree) filtered[vi][i] = d;
      }
    }
  }
  return filtered;
}
