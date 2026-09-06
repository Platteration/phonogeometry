import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ransacEssential, recoverPose, triangulate, poseMatrix, pnpDLT, ransacPnP, refinePose, projectPoint } from '../src/vision/geometry.js';
import { rng, gauss, lookAt, rotationError, angleBetween } from './helpers.js';
import { relativePose, cameraCenter } from '../src/vision/linalg.js';

function scene(seed, nPts = 200) {
  const r = rng(seed);
  const X = new Float64Array(nPts * 3);
  for (let i = 0; i < nPts; i++) {
    X[i * 3] = r() * 2 - 1; X[i * 3 + 1] = r() * 2 - 1; X[i * 3 + 2] = r() * 2 - 1;
  }
  return { r, X };
}

function project(cam, X, n, noise, r) {
  const x = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = projectPoint(cam.R, cam.t, X.subarray(i * 3, i * 3 + 3));
    x[i * 2] = p[0] + (noise ? gauss(r) * noise : 0);
    x[i * 2 + 1] = p[1] + (noise ? gauss(r) * noise : 0);
  }
  return x;
}

test('essential RANSAC + pose recovery recover relative pose with outliers', () => {
  const { r, X } = scene(11);
  const n = 200;
  const cam1 = lookAt([0, 0, -5], [0, 0, 0]);
  const cam2 = lookAt([1.5, 0.4, -4.6], [0, 0, 0]);
  const f = 800; // pixels
  const x1 = project(cam1, X, n, 0.5 / f, r), x2 = project(cam2, X, n, 0.5 / f, r);
  // 25% outliers
  for (let i = 0; i < n; i += 4) { x2[i * 2] = r() - 0.5; x2[i * 2 + 1] = r() - 0.5; }
  const res = ransacEssential(x1, x2, n, 2 / f);
  assert.ok(res, 'ransac failed');
  assert.ok(res.inliers.length >= 140, `inliers ${res.inliers.length}`);
  const inl = res.inliers;
  const a = new Float64Array(inl.length * 2), b = new Float64Array(inl.length * 2);
  inl.forEach((i, k) => { a[k * 2] = x1[i * 2]; a[k * 2 + 1] = x1[i * 2 + 1]; b[k * 2] = x2[i * 2]; b[k * 2 + 1] = x2[i * 2 + 1]; });
  const pose = recoverPose(res.E, a, b, inl.length, 4 / f);
  assert.ok(pose.good >= inl.length * 0.9, `cheirality good=${pose.good}`);
  const rel = relativePose(cam1.R, cam1.t, cam2.R, cam2.t);
  assert.ok(rotationError(pose.R, rel.R) < 0.01, `rot err ${rotationError(pose.R, rel.R)}`);
  assert.ok(angleBetween(pose.t, rel.t) < 0.02, `t dir err ${angleBetween(pose.t, rel.t)}`);
});

test('triangulation is accurate from three views', () => {
  const { X } = scene(4, 10);
  const cams = [lookAt([0, 0, -5], [0, 0, 0]), lookAt([2, 1, -4], [0, 0, 0]), lookAt([-2, 0.5, -4.5], [0, 0, 0])];
  const Ps = cams.map((c) => poseMatrix(c.R, c.t));
  for (let i = 0; i < 10; i++) {
    const Xi = X.subarray(i * 3, i * 3 + 3);
    const obs = [];
    for (const c of cams) { const p = projectPoint(c.R, c.t, Xi); obs.push(p[0], p[1]); }
    const Y = triangulate(Ps, obs);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(Y[k] - Xi[k]) < 1e-6);
  }
});

test('PnP recovers a camera pose (DLT, refinement and RANSAC with outliers)', () => {
  const { r, X } = scene(21, 120);
  const cam = lookAt([1, -2, -6], [0.2, 0, 0]);
  const f = 1000;
  const x = project(cam, X, 120, 0.3 / f, r);
  const lin = pnpDLT(X, x, 120);
  assert.ok(rotationError(lin.R, cam.R) < 0.01);
  const C = cameraCenter(lin.R, lin.t), Ct = cameraCenter(cam.R, cam.t);
  assert.ok(Math.hypot(C[0] - Ct[0], C[1] - Ct[1], C[2] - Ct[2]) < 0.02);
  const ref = refinePose(lin.R, lin.t, X, x, 120);
  assert.ok(Number.isFinite(ref.cost) && rotationError(ref.R, cam.R) <= rotationError(lin.R, cam.R) + 1e-6);
  // Outliers
  for (let i = 0; i < 120; i += 3) { x[i * 2] += 0.2; x[i * 2 + 1] -= 0.1; }
  const rs = ransacPnP(X, x, 120, 2 / f);
  assert.ok(rs && rs.inliers.length >= 78, `inliers ${rs && rs.inliers.length}`);
  assert.ok(rotationError(rs.R, cam.R) < 0.005, `rot ${rotationError(rs.R, cam.R)}`);
  const C2 = cameraCenter(rs.R, rs.t);
  assert.ok(Math.hypot(C2[0] - Ct[0], C2[1] - Ct[1], C2[2] - Ct[2]) < 0.01);
});
