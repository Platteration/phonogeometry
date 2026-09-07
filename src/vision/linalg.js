// Small dense linear-algebra toolkit used by the vision pipeline.
// Matrices are flat, row-major Float64Arrays with explicit dimensions.

export function zeros(n) {
  return new Float64Array(n);
}

export function identity(n) {
  const I = new Float64Array(n * n);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  return I;
}

export function matMul(A, B, n, m, p) {
  // A: n x m, B: m x p -> n x p
  const C = new Float64Array(n * p);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const a = A[i * m + k];
      if (a === 0) continue;
      for (let j = 0; j < p; j++) C[i * p + j] += a * B[k * p + j];
    }
  }
  return C;
}

export function transpose(A, n, m) {
  const T = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j * n + i] = A[i * m + j];
  return T;
}

export function matVec(A, v, n, m) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += A[i * m + j] * v[j];
    out[i] = s;
  }
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

export function normalize(a) {
  const n = norm(a);
  const out = new Float64Array(a.length);
  if (n === 0) return out;
  for (let i = 0; i < a.length; i++) out[i] = a[i] / n;
  return out;
}

export function cross(a, b) {
  return new Float64Array([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

export function skew(v) {
  return new Float64Array([0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0]);
}

export function det3(M) {
  return (
    M[0] * (M[4] * M[8] - M[5] * M[7]) -
    M[1] * (M[3] * M[8] - M[5] * M[6]) +
    M[2] * (M[3] * M[7] - M[4] * M[6])
  );
}

export function inv3(M) {
  const d = det3(M);
  if (Math.abs(d) < 1e-300) return null;
  const inv = new Float64Array(9);
  inv[0] = (M[4] * M[8] - M[5] * M[7]) / d;
  inv[1] = (M[2] * M[7] - M[1] * M[8]) / d;
  inv[2] = (M[1] * M[5] - M[2] * M[4]) / d;
  inv[3] = (M[5] * M[6] - M[3] * M[8]) / d;
  inv[4] = (M[0] * M[8] - M[2] * M[6]) / d;
  inv[5] = (M[2] * M[3] - M[0] * M[5]) / d;
  inv[6] = (M[3] * M[7] - M[4] * M[6]) / d;
  inv[7] = (M[1] * M[6] - M[0] * M[7]) / d;
  inv[8] = (M[0] * M[4] - M[1] * M[3]) / d;
  return inv;
}

/**
 * One-sided Jacobi SVD. A is m x n (any m, n). Returns {U (m x n), S (n), V (n x n)}
 * with singular values sorted in descending order, A = U * diag(S) * V^T.
 */
export function svd(Ain, m, n) {
  const A = Float64Array.from(Ain);
  const V = identity(n);
  const eps = 1e-15;
  for (let sweep = 0; sweep < 80; sweep++) {
    let rotated = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let k = 0; k < m; k++) {
          const ai = A[k * n + i], aj = A[k * n + j];
          alpha += ai * ai;
          beta += aj * aj;
          gamma += ai * aj;
        }
        if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta) || gamma === 0) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let k = 0; k < m; k++) {
          const ai = A[k * n + i], aj = A[k * n + j];
          A[k * n + i] = c * ai - s * aj;
          A[k * n + j] = s * ai + c * aj;
        }
        for (let k = 0; k < n; k++) {
          const vi = V[k * n + i], vj = V[k * n + j];
          V[k * n + i] = c * vi - s * vj;
          V[k * n + j] = s * vi + c * vj;
        }
      }
    }
    if (!rotated) break;
  }
  const S = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < m; k++) s += A[k * n + j] * A[k * n + j];
    S[j] = Math.sqrt(s);
  }
  // Sort descending
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => S[b] - S[a]);
  const U = new Float64Array(m * n);
  const Vs = new Float64Array(n * n);
  const Ss = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const j = order[c];
    Ss[c] = S[j];
    for (let k = 0; k < m; k++) U[k * n + c] = S[j] > 1e-300 ? A[k * n + j] / S[j] : 0;
    for (let k = 0; k < n; k++) Vs[k * n + c] = V[k * n + j];
  }
  return { U, S: Ss, V: Vs };
}

/** Right null vector of A (m x n): the column of V with the smallest singular value. */
export function nullVector(A, m, n) {
  const { V } = svd(A, m, n);
  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) v[k] = V[k * n + (n - 1)];
  return v;
}

/**
 * Solve the symmetric positive definite system A x = b (n x n) with Cholesky.
 * Returns null if the matrix is not positive definite.
 */
export function solveSPD(Ain, b, n) {
  const L = Float64Array.from(Ain);
  for (let j = 0; j < n; j++) {
    let d = L[j * n + j];
    for (let k = 0; k < j; k++) d -= L[j * n + k] * L[j * n + k];
    if (!(d > 1e-300)) return null;
    d = Math.sqrt(d);
    L[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = L[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = s / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** General small dense solve via Gaussian elimination with partial pivoting. */
export function solve(Ain, bin, n) {
  const A = Float64Array.from(Ain);
  const b = Float64Array.from(bin);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-300) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t;
      }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Rodrigues: rotation vector -> 3x3 rotation matrix. */
export function rotvecToMat(r) {
  const th = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  const R = identity(3);
  if (th < 1e-12) {
    const K = skew(r);
    for (let i = 0; i < 9; i++) R[i] += K[i];
    return R;
  }
  const k = [r[0] / th, r[1] / th, r[2] / th];
  const K = skew(k);
  const K2 = matMul(K, K, 3, 3, 3);
  const s = Math.sin(th), c = 1 - Math.cos(th);
  for (let i = 0; i < 9; i++) R[i] += s * K[i] + c * K2[i];
  return R;
}

/** Rodrigues: 3x3 rotation matrix -> rotation vector. */
export function matToRotvec(R) {
  const tr = R[0] + R[4] + R[8];
  const cosTh = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(cosTh);
  if (th < 1e-9) return new Float64Array(3);
  if (Math.PI - th < 1e-6) {
    // Near pi: extract axis from R + I
    const M = Float64Array.from(R);
    M[0] += 1; M[4] += 1; M[8] += 1;
    let col = 0, best = -1;
    for (let c = 0; c < 3; c++) {
      const nrm = M[c] * M[c] + M[3 + c] * M[3 + c] + M[6 + c] * M[6 + c];
      if (nrm > best) { best = nrm; col = c; }
    }
    const axis = normalize([M[col], M[3 + col], M[6 + col]]);
    return new Float64Array([axis[0] * th, axis[1] * th, axis[2] * th]);
  }
  const f = th / (2 * Math.sin(th));
  return new Float64Array([(R[7] - R[5]) * f, (R[2] - R[6]) * f, (R[3] - R[1]) * f]);
}

/** Project a 3x3 matrix onto the closest rotation matrix (det = +1). */
export function closestRotation(M) {
  const { U, V } = svd(M, 3, 3);
  let R = matMul(U, transpose(V, 3, 3), 3, 3, 3);
  if (det3(R) < 0) {
    // Flip the sign of the last column of U
    const U2 = Float64Array.from(U);
    U2[2] = -U2[2]; U2[5] = -U2[5]; U2[8] = -U2[8];
    R = matMul(U2, transpose(V, 3, 3), 3, 3, 3);
  }
  return R;
}

export function transformPoint(R, t, X) {
  return new Float64Array([
    R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0],
    R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1],
    R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2],
  ]);
}

/** Camera center in world coordinates for pose (R, t) with Xc = R Xw + t. */
export function cameraCenter(R, t) {
  return new Float64Array([
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ]);
}

/** Compose the relative pose taking points from camera a to camera b. */
export function relativePose(Ra, ta, Rb, tb) {
  const Rrel = matMul(Rb, transpose(Ra, 3, 3), 3, 3, 3);
  const Rt = matVec(Rrel, ta, 3, 3);
  const trel = new Float64Array([tb[0] - Rt[0], tb[1] - Rt[1], tb[2] - Rt[2]]);
  return { R: Rrel, t: trel };
}

/**
 * Best similarity (scale, rotation, translation) mapping the points `from` onto `to`
 * (Umeyama). Both are arrays of 3-element arrays of the same length.
 * @returns {{R, scale, t, apply, residual, planarity}} where planarity is the ratio of the
 *   smallest to the largest spread of `from`: near zero means the points are collinear and
 *   the rotation about that line is not determined.
 */
export function similarityTransform(from, to) {
  const n = from.length;
  if (n < 3) return null;
  const cf = [0, 0, 0], ct = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cf[k] += from[i][k] / n; ct[k] += to[i][k] / n; }
  const H = new Float64Array(9);
  const C = new Float64Array(9); // covariance of `from`, for the degeneracy check
  let sf = 0, st = 0;
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((k) => from[i][k] - cf[k]);
    const b = [0, 1, 2].map((k) => to[i][k] - ct[k]);
    sf += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    st += Math.hypot(b[0], b[1], b[2]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { H[r * 3 + c] += b[r] * a[c]; C[r * 3 + c] += a[r] * a[c]; }
  }
  if (!(sf > 1e-18)) return null;
  const R = closestRotation(H);
  let sumFrom = 0;
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((k) => from[i][k] - cf[k]);
    sumFrom += Math.hypot(a[0], a[1], a[2]);
  }
  const scale = sumFrom > 1e-12 ? st / sumFrom : 1;
  const Rcf = matVec(R, cf, 3, 3);
  const t = [0, 1, 2].map((k) => ct[k] - scale * Rcf[k]);
  const apply = (p) => {
    const r = matVec(R, p, 3, 3);
    return new Float64Array([scale * r[0] + t[0], scale * r[1] + t[1], scale * r[2] + t[2]]);
  };
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const p = apply(from[i]);
    residual += Math.hypot(p[0] - to[i][0], p[1] - to[i][1], p[2] - to[i][2]);
  }
  const { S } = svd(C, 3, 3);
  return { R, scale, t, apply, residual: residual / n, planarity: S[0] > 0 ? Math.sqrt(S[2] / S[0]) : 0 };
}
