import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDepthMap, filterDepthConsistency } from '../src/vision/planeSweep.js';
import { renderRoom } from './synthScene.js';
import { lookAt } from './helpers.js';

test('plane sweep recovers depth of a textured room from three views', () => {
  const w = 160, h = 120, f = 130, cx = 80, cy = 60;
  const centers = [[0, 0, -0.6], [0.25, 0.05, -0.6], [-0.25, -0.05, -0.55]];
  const cams = centers.map((c) => lookAt(c, [0, 0, 5]));
  const views = cams.map((cam) => {
    const r = renderRoom(cam, w, h, f, cx, cy, 2);
    return { gray: r.gray, truth: r.depth, w, h, f, cx, cy, R: cam.R, t: cam.t };
  });
  const res = computeDepthMap(views[0], [views[1], views[2]], { dmin: 1.0, dmax: 4.0, numPlanes: 96, radius: 3, minZncc: 0.6 });
  let n = 0, good = 0, valid = 0;
  for (let i = 0; i < w * h; i++) {
    if (views[0].truth[i] === 0) continue;
    n++;
    const d = res.depth[i];
    if (!(d > 0)) continue;
    valid++;
    if (Math.abs(d - views[0].truth[i]) / views[0].truth[i] < 0.05) good++;
  }
  assert.ok(valid / n > 0.5, `coverage ${(valid / n).toFixed(2)}`);
  assert.ok(good / valid > 0.9, `accuracy ${(good / valid).toFixed(2)}`);
  // Consistency filter should keep most of the accurate depths
  views[0].depth = res.depth;
  views[1].depth = computeDepthMap(views[1], [views[0], views[2]], { dmin: 1.0, dmax: 4.0, numPlanes: 96, radius: 3, minZncc: 0.6 }).depth;
  views[2].depth = computeDepthMap(views[2], [views[0], views[1]], { dmin: 1.0, dmax: 4.0, numPlanes: 96, radius: 3, minZncc: 0.6 }).depth;
  const filtered = filterDepthConsistency(views, [[1, 2], [0, 2], [0, 1]], { relTol: 0.05 });
  let keptGood = 0, kept = 0;
  for (let i = 0; i < w * h; i++) {
    const d = filtered[0][i];
    if (!(d > 0)) continue;
    kept++;
    if (Math.abs(d - views[0].truth[i]) / views[0].truth[i] < 0.05) keptGood++;
  }
  assert.ok(kept > valid * 0.5, `kept ${kept} of ${valid}`);
  assert.ok(keptGood / kept > 0.95, `filtered accuracy ${(keptGood / kept).toFixed(3)}`);
});
