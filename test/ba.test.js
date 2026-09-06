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
