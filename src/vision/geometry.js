// Two-view and multi-view geometry: essential matrix estimation, pose recovery,
// triangulation and perspective-n-point, all in camera-normalized coordinates.
import {
  svd, nullVector, matMul, transpose, det3, matVec, cross, normalize, skew,
  closestRotation, rotvecToMat, solve, cameraCenter,
} from './linalg.js';

/** Pixel -> normalized camera coordinates. */
export function normalizePoint(x, y, f, cx, cy) {
  return [(x - cx) / f, (y - cy) / f];
}

/** Radial distortion x_d = x (1 + k1 |x|^2) applied to normalized coordinates. */
export function distortNormalized(x, y, k1) {
  const D = 1 + k1 * (x * x + y * y);
  return [x * D, y * D];
}

/** Inverse of distortNormalized (fixed-point iteration). */
export function undistortNormalized(xd, yd, k1) {
  if (k1 === 0) return [xd, yd];
  let x = xd, y = yd;
  for (let i = 0; i < 8; i++) {
    const D = 1 + k1 * (x * x + y * y);
    x = xd / D; y = yd / D;
  }
  return [x, y];
}

/** Hartley normalization of 2D points (flat [x,y,...] Float64Array). Returns {T, pts}. */
export function hartleyNormalize(pts, n) {
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pts[i * 2]; my += pts[i * 2 + 1]; }
  mx /= n; my /= n;
  let md = 0;
  for (let i = 0; i < n; i++) md += Math.hypot(pts[i * 2] - mx, pts[i * 2 + 1] - my);
  md /= n;
  const s = md > 1e-12 ? Math.SQRT2 / md : 1;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = (pts[i * 2] - mx) * s;
    out[i * 2 + 1] = (pts[i * 2 + 1] - my) * s;
  }
  const T = new Float64Array([s, 0, -s * mx, 0, s, -s * my, 0, 0, 1]);
  return { T, pts: out };
}

/**
 * Eight-point algorithm on normalized image coordinates.
 * p1, p2: flat arrays of n >= 8 points; returns the essential matrix (3x3) with
 * singular values forced to (1, 1, 0), satisfying p2^T E p1 = 0.
 */
export function essentialEightPoint(p1, p2, n) {
  const n1 = hartleyNormalize(p1, n), n2 = hartleyNormalize(p2, n);
  const A = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const x = n1.pts[i * 2], y = n1.pts[i * 2 + 1];
    const xp = n2.pts[i * 2], yp = n2.pts[i * 2 + 1];
    A.set([xp * x, xp * y, xp, yp * x, yp * y, yp, x, y, 1], i * 9);
  }
  const e = nullVector(A, n, 9);
  let E = matMul(matMul(transpose(n2.T, 3, 3), e, 3, 3, 3), n1.T, 3, 3, 3);
  const { U, V } = svd(E, 3, 3);
  const D = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 0]);
  E = matMul(matMul(U, D, 3, 3, 3), transpose(V, 3, 3), 3, 3, 3);
  return E;
}

/** Sampson distance of a correspondence with respect to E. */
export function sampsonError(E, x1, y1, x2, y2) {
  const Ex1 = [E[0] * x1 + E[1] * y1 + E[2], E[3] * x1 + E[4] * y1 + E[5], E[6] * x1 + E[7] * y1 + E[8]];
  const Etx2 = [E[0] * x2 + E[3] * y2 + E[6], E[1] * x2 + E[4] * y2 + E[7], E[2] * x2 + E[5] * y2 + E[8]];
  const num = x2 * Ex1[0] + y2 * Ex1[1] + Ex1[2];
  const den = Ex1[0] * Ex1[0] + Ex1[1] * Ex1[1] + Etx2[0] * Etx2[0] + Etx2[1] * Etx2[1];
  return den > 0 ? (num * num) / den : Infinity;
}

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function sampleIndices(rng, k, n, out) {
  for (let i = 0; i < k; i++) {
    let v, dup;
    do {
      v = Math.floor(rng() * n);
      dup = false;
      for (let j = 0; j < i; j++) if (out[j] === v) { dup = true; break; }
    } while (dup);
    out[i] = v;
  }
}

/**
 * RANSAC essential matrix estimation.
 * @param p1,p2 flat normalized coordinates (n points)
 * @param threshold Sampson threshold in normalized units (e.g. 1.5px / f)
 * @returns {{E: Float64Array, inliers: Int32Array}|null}
 */
export function ransacEssential(p1, p2, n, threshold, opts = {}) {
  if (n < 8) return null;
  const maxIters = opts.maxIters ?? 1000;
  const conf = opts.confidence ?? 0.999;
  const rng = makeRng(opts.seed ?? 12345);
  const thr2 = threshold * threshold;
  const idx = new Int32Array(8);
  const s1 = new Float64Array(16), s2 = new Float64Array(16);
  let bestInl = null, bestCount = 0, bestE = null;
  let iters = maxIters;
  const bailAt = opts.bailAt ?? 120, bailMin = Math.max(10, 0.12 * n);
  for (let it = 0; it < iters; it++) {
    // Hopeless pairs (mostly wrong matches) are abandoned early instead of exhausting maxIters
    if (it === bailAt && bestCount < bailMin) break;
    sampleIndices(rng, 8, n, idx);
    for (let k = 0; k < 8; k++) {
      s1[k * 2] = p1[idx[k] * 2]; s1[k * 2 + 1] = p1[idx[k] * 2 + 1];
      s2[k * 2] = p2[idx[k] * 2]; s2[k * 2 + 1] = p2[idx[k] * 2 + 1];
    }
    const E = essentialEightPoint(s1, s2, 8);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (sampsonError(E, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) count++;
    }
    if (count > bestCount) {
      bestCount = count; bestE = E;
      const w = count / n;
      const denom = Math.log(1 - Math.pow(w, 8));
      if (denom < 0) iters = Math.min(maxIters, Math.ceil(Math.log(1 - conf) / denom));
    }
  }
  if (!bestE || bestCount < 8) return null;
  // Refit on all inliers (two rounds).
  let E = bestE;
  for (let round = 0; round < 2; round++) {
    const inl = [];
    for (let i = 0; i < n; i++) {
      if (sampsonError(E, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) inl.push(i);
    }
    if (inl.length < 8) break;
    const a = new Float64Array(inl.length * 2), b = new Float64Array(inl.length * 2);
    inl.forEach((i, k) => {
      a[k * 2] = p1[i * 2]; a[k * 2 + 1] = p1[i * 2 + 1];
      b[k * 2] = p2[i * 2]; b[k * 2 + 1] = p2[i * 2 + 1];
    });
    const E2 = essentialEightPoint(a, b, inl.length);
    let c2 = 0;
    for (let i = 0; i < n; i++) {
      if (sampsonError(E2, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) c2++;
    }
    if (c2 >= inl.length) E = E2; else break;
  }
  bestInl = [];
  for (let i = 0; i < n; i++) {
    if (sampsonError(E, p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]) < thr2) bestInl.push(i);
  }
  return { E, inliers: Int32Array.from(bestInl) };
}

/** The four (R, t) decompositions of an essential matrix. */
export function decomposeEssential(E) {
  const { U, V } = svd(E, 3, 3);
  const Uc = Float64Array.from(U), Vc = Float64Array.from(V);
  if (det3(Uc) < 0) for (let i = 0; i < 9; i++) Uc[i] = -Uc[i];
  if (det3(Vc) < 0) for (let i = 0; i < 9; i++) Vc[i] = -Vc[i];
  const W = new Float64Array([0, -1, 0, 1, 0, 0, 0, 0, 1]);
  const Vt = transpose(Vc, 3, 3);
  const R1 = matMul(matMul(Uc, W, 3, 3, 3), Vt, 3, 3, 3);
  const R2 = matMul(matMul(Uc, transpose(W, 3, 3), 3, 3, 3), Vt, 3, 3, 3);
  const t = new Float64Array([Uc[2], Uc[5], Uc[8]]);
  const tn = new Float64Array([-t[0], -t[1], -t[2]]);
  return [
    { R: R1, t }, { R: R1, t: tn }, { R: R2, t }, { R: R2, t: tn },
  ];
}

/** Build a 3x4 projection matrix [R | t]. */
export function poseMatrix(R, t) {
  return new Float64Array([
    R[0], R[1], R[2], t[0],
    R[3], R[4], R[5], t[1],
    R[6], R[7], R[8], t[2],
  ]);
}

/**
 * Linear (DLT) triangulation from any number of views.
 * @param Ps array of 3x4 matrices, obs flat normalized [x,y,...]
 * @returns Float64Array(3) world point (or null when degenerate)
 */
export function triangulate(Ps, obs) {
  const m = Ps.length;
  const A = new Float64Array(m * 2 * 4);
  for (let i = 0; i < m; i++) {
    const P = Ps[i], x = obs[i * 2], y = obs[i * 2 + 1];
    for (let k = 0; k < 4; k++) {
      A[(i * 2) * 4 + k] = x * P[8 + k] - P[k];
      A[(i * 2 + 1) * 4 + k] = y * P[8 + k] - P[4 + k];
    }
  }
  const X = nullVector(A, m * 2, 4);
  if (Math.abs(X[3]) < 1e-12) return null;
  return new Float64Array([X[0] / X[3], X[1] / X[3], X[2] / X[3]]);
}

export function projectPoint(R, t, X) {
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  return [x / z, y / z, z];
}

/** Angle (radians) between the rays from two camera centers to a point. */
export function triangulationAngle(C1, C2, X) {
  const a = normalize([X[0] - C1[0], X[1] - C1[1], X[2] - C1[2]]);
  const b = normalize([X[0] - C2[0], X[1] - C2[1], X[2] - C2[2]]);
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d);
}

/**
 * Choose the physically valid pose among the essential-matrix decompositions
 * by triangulating the correspondences and counting points in front of both cameras.
 * Camera 1 is at the origin. Returns {R, t, points (Float64Array 3n or null entries), valid (Uint8Array)}.
 */
export function recoverPose(E, p1, p2, n, threshold) {
  const cands = decomposeEssential(E);
  const I = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const P1 = poseMatrix(I, [0, 0, 0]);
  let best = null;
  for (const c of cands) {
    const P2 = poseMatrix(c.R, c.t);
    let good = 0;
    const pts = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const X = triangulate([P1, P2], [p1[i * 2], p1[i * 2 + 1], p2[i * 2], p2[i * 2 + 1]]);
      if (!X) continue;
      const z1 = X[2];
      const pr = projectPoint(c.R, c.t, X);
      if (z1 <= 0 || pr[2] <= 0) continue;
      const e1 = Math.hypot(X[0] / z1 - p1[i * 2], X[1] / z1 - p1[i * 2 + 1]);
      const e2 = Math.hypot(pr[0] - p2[i * 2], pr[1] - p2[i * 2 + 1]);
      if (threshold && (e1 > threshold || e2 > threshold)) continue;
      pts[i] = X;
      good++;
    }
    if (!best || good > best.good) best = { R: c.R, t: c.t, good, points: pts };
  }
  return best;
}

/**
 * DLT perspective-n-point: 3D points X (flat, n>=6) and normalized 2D observations x.
 * Returns {R, t} or null.
 */
export function pnpDLT(X, x, n) {
  if (n < 6) return null;
  // Normalize 3D points for conditioning
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += X[i * 3]; cy += X[i * 3 + 1]; cz += X[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  let sc = 0;
  for (let i = 0; i < n; i++) sc += Math.hypot(X[i * 3] - cx, X[i * 3 + 1] - cy, X[i * 3 + 2] - cz);
  sc = sc > 0 ? n / sc : 1;
  const A = new Float64Array(n * 2 * 12);
  for (let i = 0; i < n; i++) {
    const px = (X[i * 3] - cx) * sc, py = (X[i * 3 + 1] - cy) * sc, pz = (X[i * 3 + 2] - cz) * sc;
    const u = x[i * 2], v = x[i * 2 + 1];
    A.set([px, py, pz, 1, 0, 0, 0, 0, -u * px, -u * py, -u * pz, -u], (i * 2) * 12);
    A.set([0, 0, 0, 0, px, py, pz, 1, -v * px, -v * py, -v * pz, -v], (i * 2 + 1) * 12);
  }
  const p = nullVector(A, n * 2, 12);
  // P = [M | p4] for normalized points; undo normalization: X' = sc (X - c)
  const M = new Float64Array([p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]]);
  let p4 = [p[3], p[7], p[11]];
  // Sign: make depths positive for the majority
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const px = (X[i * 3] - cx) * sc, py = (X[i * 3 + 1] - cy) * sc, pz = (X[i * 3 + 2] - cz) * sc;
    if (M[6] * px + M[7] * py + M[8] * pz + p4[2] > 0) pos++;
  }
  if (pos < n / 2) { for (let i = 0; i < 9; i++) M[i] = -M[i]; p4 = p4.map((v) => -v); }
  const { S } = svd(M, 3, 3);
  const scale = (S[0] + S[1] + S[2]) / 3;
  if (!(scale > 1e-12)) return null;
  const R = closestRotation(M);
  // In normalized coords: Xc = (M/scale) X' + p4/scale = R sc (X - c) + p4/scale
  // => Xc = (sc R) X + (p4/scale - sc R c). Fold sc into the translation (R stays a rotation,
  // depth is scaled uniformly by sc which cancels in the projection), then divide by sc.
  const Rc = matVec(R, [cx, cy, cz], 3, 3);
  const t = new Float64Array([
    p4[0] / scale / sc - Rc[0], p4[1] / scale / sc - Rc[1], p4[2] / scale / sc - Rc[2],
  ]);
  return { R, t };
}

/**
 * Refine a pose with Levenberg-Marquardt on the reprojection error (normalized coords).
 * Uses an SE(3) left perturbation: R <- exp(dθ) R, t <- exp(dθ) t + dt.
 */
export function refinePose(R0, t0, X, x, n, opts = {}) {
  let R = Float64Array.from(R0), t = Float64Array.from(t0);
  const iters = opts.iters ?? 10;
  const weights = opts.weights || null;
  const cost = (R, t) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const pr = projectPoint(R, t, X.subarray(i * 3, i * 3 + 3));
      if (pr[2] <= 0) return Infinity;
      const w = weights ? weights[i] : 1;
      c += w * ((pr[0] - x[i * 2]) ** 2 + (pr[1] - x[i * 2 + 1]) ** 2);
    }
    return c;
  };
  let lambda = 1e-3;
  let cur = cost(R, t);
  for (let it = 0; it < iters; it++) {
    const H = new Float64Array(36), g = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      const Xi = X.subarray(i * 3, i * 3 + 3);
      const Xc = [
        R[0] * Xi[0] + R[1] * Xi[1] + R[2] * Xi[2] + t[0],
        R[3] * Xi[0] + R[4] * Xi[1] + R[5] * Xi[2] + t[1],
        R[6] * Xi[0] + R[7] * Xi[1] + R[8] * Xi[2] + t[2],
      ];
      const z = Xc[2];
      if (z <= 1e-9) continue;
      const iz = 1 / z;
      const u = Xc[0] * iz, v = Xc[1] * iz;
      const ru = u - x[i * 2], rv = v - x[i * 2 + 1];
      const w = weights ? weights[i] : 1;
      // d(u,v)/dXc
      const Ju = [iz, 0, -u * iz], Jv = [0, iz, -v * iz];
      // dXc/d[dθ, dt] = [-[Xc]x | I]
      const Sx = skew(Xc);
      const J = new Float64Array(12); // 2 x 6
      for (let k = 0; k < 3; k++) {
        let su = 0, sv = 0;
        for (let m = 0; m < 3; m++) { su += Ju[m] * -Sx[m * 3 + k]; sv += Jv[m] * -Sx[m * 3 + k]; }
        J[k] = su; J[6 + k] = sv;
        J[3 + k] = Ju[k]; J[9 + k] = Jv[k];
      }
      for (let a = 0; a < 6; a++) {
        g[a] += w * (J[a] * ru + J[6 + a] * rv);
        for (let b = 0; b < 6; b++) H[a * 6 + b] += w * (J[a] * J[b] + J[6 + a] * J[6 + b]);
      }
    }
    let improved = false;
    for (let tries = 0; tries < 6; tries++) {
      const Hd = Float64Array.from(H);
      for (let a = 0; a < 6; a++) Hd[a * 6 + a] += lambda * (1 + Hd[a * 6 + a]);
      const ng = g.map((v) => -v);
      const d = solve(Hd, ng, 6);
      if (!d) { lambda *= 10; continue; }
      const dR = rotvecToMat([d[0], d[1], d[2]]);
      const Rn = matMul(dR, R, 3, 3, 3);
      const Rt = matVec(dR, t, 3, 3);
      const tn = new Float64Array([Rt[0] + d[3], Rt[1] + d[4], Rt[2] + d[5]]);
      const c = cost(Rn, tn);
      if (c < cur) {
        R = Rn; t = tn; cur = c; lambda = Math.max(1e-9, lambda / 3); improved = true; break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { R, t, cost: cur };
}

/**
 * RANSAC PnP with DLT minimal samples and LM refinement on the inliers.
 * @returns {{R, t, inliers: Int32Array}|null}
 */
export function ransacPnP(X, x, n, threshold, opts = {}) {
  if (n < 6) return null;
  const maxIters = opts.maxIters ?? 400;
  const rng = makeRng(opts.seed ?? 777);
  const idx = new Int32Array(6);
  const sX = new Float64Array(18), sx = new Float64Array(12);
  let best = null, bestCount = 0;
  let iters = maxIters;
  const thr2 = threshold * threshold;
  const countInliers = (R, t) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const pr = projectPoint(R, t, X.subarray(i * 3, i * 3 + 3));
      if (pr[2] <= 0) continue;
      const e = (pr[0] - x[i * 2]) ** 2 + (pr[1] - x[i * 2 + 1]) ** 2;
      if (e < thr2) c++;
    }
    return c;
  };
  for (let it = 0; it < iters; it++) {
    sampleIndices(rng, 6, n, idx);
    for (let k = 0; k < 6; k++) {
      sX.set(X.subarray(idx[k] * 3, idx[k] * 3 + 3), k * 3);
      sx[k * 2] = x[idx[k] * 2]; sx[k * 2 + 1] = x[idx[k] * 2 + 1];
    }
    const pose = pnpDLT(sX, sx, 6);
    if (!pose) continue;
    const c = countInliers(pose.R, pose.t);
    if (c > bestCount) {
      bestCount = c; best = pose;
      const w = c / n;
      const denom = Math.log(1 - Math.pow(w, 6));
      if (denom < 0) iters = Math.min(maxIters, Math.ceil(Math.log(1 - 0.999) / denom));
    }
  }
  if (!best || bestCount < 6) return null;
  // Refine on inliers (two rounds)
  let R = best.R, t = best.t;
  for (let round = 0; round < 2; round++) {
    const inl = [];
    for (let i = 0; i < n; i++) {
      const pr = projectPoint(R, t, X.subarray(i * 3, i * 3 + 3));
      if (pr[2] <= 0) continue;
      if ((pr[0] - x[i * 2]) ** 2 + (pr[1] - x[i * 2 + 1]) ** 2 < thr2) inl.push(i);
    }
    if (inl.length < 6) break;
    const iX = new Float64Array(inl.length * 3), ix = new Float64Array(inl.length * 2);
    inl.forEach((i, k) => { iX.set(X.subarray(i * 3, i * 3 + 3), k * 3); ix[k * 2] = x[i * 2]; ix[k * 2 + 1] = x[i * 2 + 1]; });
    const lin = inl.length >= 6 ? pnpDLT(iX, ix, inl.length) : null;
    const start = lin && countInliers(lin.R, lin.t) >= countInliers(R, t) ? lin : { R, t };
    const ref = refinePose(start.R, start.t, iX, ix, inl.length, { iters: 15 });
    if (countInliers(ref.R, ref.t) >= inl.length) { R = ref.R; t = ref.t; }
  }
  const inliers = [];
  for (let i = 0; i < n; i++) {
    const pr = projectPoint(R, t, X.subarray(i * 3, i * 3 + 3));
    if (pr[2] <= 0) continue;
    if ((pr[0] - x[i * 2]) ** 2 + (pr[1] - x[i * 2 + 1]) ** 2 < thr2) inliers.push(i);
  }
  return { R, t, inliers: Int32Array.from(inliers) };
}

export { cameraCenter, cross };
