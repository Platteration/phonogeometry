import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSfM } from '../src/vision/sfm.js';
import { projectPoint } from '../src/vision/geometry.js';
import { relativePose } from '../src/vision/linalg.js';
import { rng, gauss, lookAt, rotationError, angleBetween } from './helpers.js';

test('incremental SfM registers all synthetic cameras from noisy matches with outliers', () => {
  const r = rng(7);
  const np = 400, f = 700, cx = 320, cy = 240;
  const X = new Float64Array(np * 3);
  for (let i = 0; i < np; i++) { X[i * 3] = r() * 2 - 1; X[i * 3 + 1] = r() * 2 - 1; X[i * 3 + 2] = r() * 1.2 - 0.6; }
  const nCams = 7;
  const truth = [];
  for (let c = 0; c < nCams; c++) {
    const ang = -0.6 + 1.2 * c / (nCams - 1);
    truth.push(lookAt([Math.sin(ang) * 5, 0.5 * Math.sin(c), -Math.cos(ang) * 5], [0, 0, 0]));
  }
  // Each frame observes every point (keypoint index == point index) with noise; some points dropped.
  const frames = truth.map((cam) => {
    const kps = new Float32Array(np * 2);
    for (let p = 0; p < np; p++) {
      const pr = projectPoint(cam.R, cam.t, X.subarray(p * 3, p * 3 + 3));
      kps[p * 2] = pr[0] * f + cx + gauss(r) * 0.4;
      kps[p * 2 + 1] = pr[1] * f + cy + gauss(r) * 0.4;
    }
    return { f, cx, cy, width: 640, height: 480, keypoints: kps, count: np };
  });
  const pairs = [];
  for (let i = 0; i < nCams; i++) for (let j = i + 1; j < nCams; j++) {
    if (j - i > 2) continue; // only neighbouring views are matched
    const m = [];
    for (let p = 0; p < np; p++) {
      if (r() < 0.3) continue;
      if (r() < 0.15) { m.push(p, Math.floor(r() * np)); continue; } // outlier match
      m.push(p, p);
    }
    pairs.push({ i, j, matches: Int32Array.from(m) });
  }
  const res = runSfM(frames, pairs, { pixelThreshold: 2 });
  assert.equal(res.registeredCount, nCams, 'all cameras registered');
  assert.ok(res.points.length / 3 > 250, `points ${res.points.length / 3}`);
  // Compare relative poses to the truth (up to global similarity)
  const ref = res.cameras.findIndex((c) => c);
  for (let c = 0; c < nCams; c++) {
    if (c === ref) continue;
    const estRel = relativePose(res.cameras[ref].R, res.cameras[ref].t, res.cameras[c].R, res.cameras[c].t);
    const trueRel = relativePose(truth[ref].R, truth[ref].t, truth[c].R, truth[c].t);
    assert.ok(rotationError(estRel.R, trueRel.R) < 0.01, `cam ${c} rotation error ${rotationError(estRel.R, trueRel.R)}`);
    assert.ok(angleBetween(estRel.t, trueRel.t) < 0.02, `cam ${c} translation direction error ${angleBetween(estRel.t, trueRel.t)}`);
  }
});

test('SfM terminates and ignores a frame whose matches are pure noise', () => {
  const r = rng(3);
  const np = 250, f = 600, cx = 320, cy = 240;
  const X = new Float64Array(np * 3).map(() => r() * 2 - 1);
  const truth = [[0, 0, -5], [1.5, 0.3, -4.8], [-1.5, -0.3, -4.9], [0.5, 1.5, -5]].map((c) => lookAt(c, [0, 0, 0]));
  const frames = truth.map((cam) => {
    const kps = new Float32Array(np * 2);
    for (let p = 0; p < np; p++) {
      const pr = projectPoint(cam.R, cam.t, X.subarray(p * 3, p * 3 + 3));
      kps[p * 2] = pr[0] * f + cx + gauss(r) * 0.3; kps[p * 2 + 1] = pr[1] * f + cy + gauss(r) * 0.3;
    }
    return { f, cx, cy, width: 640, height: 480, keypoints: kps, count: np };
  });
  // A fifth frame with random keypoints
  const junk = new Float32Array(np * 2).map((_, i) => (i % 2 ? 480 : 640) * r());
  frames.push({ f, cx, cy, width: 640, height: 480, keypoints: junk, count: np });
  const pairs = [];
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
    const m = [];
    for (let p = 0; p < np; p++) if (r() < 0.8) m.push(p, p);
    pairs.push({ i, j, matches: Int32Array.from(m) });
  }
  const res = runSfM(frames, pairs, { pixelThreshold: 2 });
  assert.equal(res.registeredCount, 4);
  assert.equal(res.cameras[4], null);
});
