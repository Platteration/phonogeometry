import { test } from 'node:test';
import assert from 'node:assert/strict';
import { svd, nullVector, solveSPD, solve, rotvecToMat, matToRotvec, matMul, transpose, inv3, closestRotation, det3 } from '../src/vision/linalg.js';
import { rng } from './helpers.js';

test('svd reconstructs the matrix and orders singular values', () => {
  const r = rng(3);
  for (const [m, n] of [[5, 3], [3, 3], [8, 9], [12, 4]]) {
    const A = new Float64Array(m * n).map(() => r() * 2 - 1);
    const { U, S, V } = svd(A, m, n);
    for (let i = 1; i < n; i++) assert.ok(S[i - 1] >= S[i] - 1e-12);
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) D[i * n + i] = S[i];
    const rec = matMul(matMul(U, D, m, n, n), transpose(V, n, n), m, n, n);
    for (let i = 0; i < m * n; i++) assert.ok(Math.abs(rec[i] - A[i]) < 1e-9, `entry ${i}`);
    const VtV = matMul(transpose(V, n, n), V, n, n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) assert.ok(Math.abs(VtV[i * n + j] - (i === j ? 1 : 0)) < 1e-9);
  }
});

test('nullVector finds the kernel of a rank-deficient matrix', () => {
  // rows are all orthogonal to (1, 2, 3)
  const A = new Float64Array([3, 0, -1, 0, 3, -2, 3, 3, -3]);
  const v = nullVector(A, 3, 3);
  const dotv = v[0] * 1 + v[1] * 2 + v[2] * 3;
  const len = Math.hypot(v[0], v[1], v[2]);
  assert.ok(Math.abs(Math.abs(dotv) / len - Math.sqrt(14)) < 1e-9);
});

test('solveSPD and solve agree on an SPD system', () => {
  const r = rng(9);
  const n = 7;
  const B = new Float64Array(n * n).map(() => r() - 0.5);
  const A = matMul(transpose(B, n, n), B, n, n, n);
  for (let i = 0; i < n; i++) A[i * n + i] += 1;
  const b = new Float64Array(n).map(() => r());
  const x1 = solveSPD(A, b, n), x2 = solve(A, b, n);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(x1[i] - x2[i]) < 1e-9);
  const Ax = matMul(A, x1, n, n, 1);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Ax[i] - b[i]) < 1e-9);
});

test('rodrigues round trip and inverse', () => {
  const r = rng(5);
  for (let k = 0; k < 20; k++) {
    const v = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2];
    const th = Math.hypot(...v);
    if (th > Math.PI - 0.05) continue;
    const R = rotvecToMat(v);
    assert.ok(Math.abs(det3(R) - 1) < 1e-9);
    const v2 = matToRotvec(R);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(v[i] - v2[i]) < 1e-8);
    const Ri = inv3(R), Rt = transpose(R, 3, 3);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(Ri[i] - Rt[i]) < 1e-9);
  }
  const noisy = rotvecToMat([0.3, -0.2, 0.9]).map((v, i) => v + (i % 3) * 0.01);
  const Rc = closestRotation(noisy);
  const RtR = matMul(transpose(Rc, 3, 3), Rc, 3, 3, 3);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(RtR[i] - (i % 4 === 0 ? 1 : 0)) < 1e-9);
});
