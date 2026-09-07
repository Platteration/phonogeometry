import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleAdjust } from '../src/vision/ba.js';
import { projectPoint } from '../src/vision/geometry.js';
import { rng, gauss, lookAt, rotationError, rotvecToMat, matMul } from './helpers.js';

test('bundle adjustment reduces reprojection error on a perturbed scene', () => {
  const r = rng(42);
  const np = 150, f = 900;
  const X = new Float64Array(np * 3).map(() => r() * 2 - 1);
  const centers = [[0, 0, -5], [2, 0.5, -4.5], [-2, -0.5, -4.7], [1, 2, -5], [-1.5, 1.5, -4]];
  const truth = centers.map((c) => lookAt(c, [0, 0, 0]));
  const camIdx = [], ptIdx = [], xs = [];
  for (let c = 0; c < truth.length; c++) {
    for (let p = 0; p < np; p++) {
      const pr = projectPoint(truth[c].R, truth[c].t, X.subarray(p * 3, p * 3 + 3));
      camIdx.push(c); ptIdx.push(p);
      xs.push(pr[0] + gauss(r) * 0.3 / f, pr[1] + gauss(r) * 0.3 / f);
    }
  }
  const obs = { cam: Int32Array.from(camIdx), pt: Int32Array.from(ptIdx), x: Float64Array.from(xs) };
  // Perturb cameras (except the first, fixed) and points
  const cams = truth.map((c, i) => {
    if (i === 0) return { R: Float64Array.from(c.R), t: Float64Array.from(c.t), f, fixed: true };
    const dR = rotvecToMat([gauss(r) * 0.02, gauss(r) * 0.02, gauss(r) * 0.02]);
    return {
      R: matMul(dR, c.R, 3, 3, 3),
      t: Float64Array.from(c.t.map((v) => v + gauss(r) * 0.05)),
      f,
    };
  });
  const pts = Float64Array.from(X.map((v) => v + gauss(r) * 0.03));
  const res = bundleAdjust(cams, pts, obs, { iterations: 30 });
  assert.ok(res.initialRms > 5, `initial rms ${res.initialRms}`);
  assert.ok(res.finalRms < 0.5, `final rms ${res.finalRms}`);
  for (let i = 1; i < cams.length; i++) {
    assert.ok(rotationError(cams[i].R, truth[i].R) < 0.003, `cam ${i} rot ${rotationError(cams[i].R, truth[i].R)}`);
  }
});

test('bundle adjustment recovers a shared focal length error', () => {
  const r = rng(77);
  const np = 200, fTrue = 1000, fAssumed = 850; // 15% error in the assumed focal length
  const X = new Float64Array(np * 3).map(() => r() * 2 - 1);
  const centers = [[0, 0, -5], [2, 0.5, -4.5], [-2, -0.5, -4.7], [1, 2, -5], [-1.5, 1.5, -4], [0.5, -1.5, -5.5]];
  const truth = centers.map((c) => lookAt(c, [0, 0, 0]));
  const camIdx = [], ptIdx = [], xs = [];
  for (let c = 0; c < truth.length; c++) {
    for (let p = 0; p < np; p++) {
      const pr = projectPoint(truth[c].R, truth[c].t, X.subarray(p * 3, p * 3 + 3));
      // pixel measurement with the true focal, normalised with the assumed (wrong) focal
      const px = pr[0] * fTrue + gauss(r) * 0.3, py = pr[1] * fTrue + gauss(r) * 0.3;
      camIdx.push(c); ptIdx.push(p); xs.push(px / fAssumed, py / fAssumed);
    }
  }
  const obs = { cam: Int32Array.from(camIdx), pt: Int32Array.from(ptIdx), x: Float64Array.from(xs) };
  const cams = truth.map((c, i) => ({ R: Float64Array.from(c.R), t: Float64Array.from(c.t), f: fAssumed, fixed: i === 0, focalGroup: 0 }));
  const pts = Float64Array.from(X);
  const res = bundleAdjust(cams, pts, obs, { iterations: 40, refineFocal: true });
  assert.ok(res.finalRms < 0.6, `final rms ${res.finalRms}`);
  const est = fAssumed * res.focalScales[0];
  assert.ok(Math.abs(est / fTrue - 1) < 0.02, `estimated focal ${est.toFixed(1)} vs ${fTrue}`);
  assert.equal(cams[1].focalScale, res.focalScales[0]);
});

test('bundle adjustment recovers radial distortion together with focal length', () => {
  const r = rng(91);
  const np = 300, fTrue = 900, fAssumed = 800, k1True = -0.12;
  const X = new Float64Array(np * 3).map(() => r() * 2 - 1);
  const centers = [[0, 0, -3.5], [1.5, 0.5, -3], [-1.5, -0.5, -3.2], [0.8, 1.5, -4], [-1.2, 1.2, -2.6], [0.5, -1.5, -3.8], [0, 0.3, -2.4]];
  const truth = centers.map((c) => lookAt(c, [0, 0, 0]));
  const camIdx = [], ptIdx = [], xs = [];
  for (let c = 0; c < truth.length; c++) {
    for (let p = 0; p < np; p++) {
      const pr = projectPoint(truth[c].R, truth[c].t, X.subarray(p * 3, p * 3 + 3));
      const D = 1 + k1True * (pr[0] * pr[0] + pr[1] * pr[1]);
      const px = pr[0] * D * fTrue + gauss(r) * 0.3, py = pr[1] * D * fTrue + gauss(r) * 0.3;
      if (Math.abs(px) > 700 || Math.abs(py) > 500) continue; // outside a 1400x1000 sensor
      camIdx.push(c); ptIdx.push(p); xs.push(px / fAssumed, py / fAssumed);
    }
  }
  const obs = { cam: Int32Array.from(camIdx), pt: Int32Array.from(ptIdx), x: Float64Array.from(xs) };
  const cams = truth.map((c, i) => ({ R: Float64Array.from(c.R), t: Float64Array.from(c.t), f: fAssumed, k1: 0, fixed: i === 0, focalGroup: 0 }));
  const pts = Float64Array.from(X);
  const res = bundleAdjust(cams, pts, obs, { iterations: 60, refineFocal: true, refineDistortion: true });
  assert.ok(res.finalRms < 0.6, `final rms ${res.finalRms}`);
  const est = fAssumed * res.focalScales[0];
  assert.ok(Math.abs(est / fTrue - 1) < 0.03, `estimated focal ${est.toFixed(1)} vs ${fTrue}`);
  assert.ok(Math.abs(res.k1s[0] - k1True) < 0.02, `estimated k1 ${res.k1s[0].toFixed(4)} vs ${k1True}`);
  assert.equal(cams[2].k1, res.k1s[0]);
});
