import { rotvecToMat, matMul, matVec } from '../src/vision/linalg.js';

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Make a camera looking at `target` from `center` with the given up hint. */
export function lookAt(center, target, up = [0, -1, 0]) {
  const f = norm3(sub(target, center));
  let r = norm3(cross3(f, up));
  if (Math.hypot(...r) < 1e-9) r = norm3(cross3(f, [1, 0, 0]));
  const d = cross3(r, f);
  // Rows of R are the camera axes expressed in world coordinates (x right, y down, z forward)
  const R = new Float64Array([r[0], r[1], r[2], -d[0], -d[1], -d[2], f[0], f[1], f[2]]);
  const t = matVec(R, center, 3, 3).map((v) => -v);
  return { R, t: Float64Array.from(t) };
}

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function norm3(a) { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; }

export function rotationError(Ra, Rb) {
  // angle of Ra * Rb^T
  const tr = Ra[0] * Rb[0] + Ra[1] * Rb[1] + Ra[2] * Rb[2] + Ra[3] * Rb[3] + Ra[4] * Rb[4] + Ra[5] * Rb[5] + Ra[6] * Rb[6] + Ra[7] * Rb[7] + Ra[8] * Rb[8];
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}

export function angleBetween(a, b) {
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

export { rotvecToMat, matMul, matVec };
