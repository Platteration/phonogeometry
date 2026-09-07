import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct } from '../src/pipeline/reconstruct.js';
import { renderRoom, renderObject } from './synthScene.js';
import { lookAt } from './helpers.js';
import { eulerCharacteristic } from '../src/mesh/meshUtils.js';

function depthAccuracy(view, truthDepth, w, h) {
  // estimate the global scale between the reconstruction and the truth, then measure agreement
  const ratios = [];
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const d = view.depth[y * w + x], t = truthDepth[y * w + x];
    if (d > 0 && t > 0) ratios.push(d / t);
  }
  ratios.sort((a, b) => a - b);
  const scale = ratios[Math.floor(ratios.length / 2)];
  let good = 0;
  for (const r of ratios) if (Math.abs(r / scale - 1) < 0.05) good++;
  return { coverage: ratios.length, accuracy: good / ratios.length, scale };
}

test('end-to-end: textured room from six simulated phone cameras', async () => {
  const w = 320, h = 240, f = 210, cx = 159.5, cy = 119.5;
  const centers = [[0, 0, -0.5], [0.3, 0.1, -0.4], [-0.3, -0.1, -0.45], [0.15, -0.25, -0.3], [-0.2, 0.2, -0.35], [0.05, 0.05, -0.15]];
  const images = centers.map((c, i) => {
    const cam = lookAt(c, [0.1 * i, 0, 5]);
    const r = renderRoom(cam, w, h, f, cx, cy, 2);
    return { id: `cam${i}`, label: `Simulated camera ${i}`, width: w, height: h, rgba: r.rgba, f, cx, cy, shotIndex: i, truth: r.depth };
  });
  const logs = [];
  const res = await reconstruct(images, { quality: 'fast', preset: 'room', debug: true, overrides: { featureWidth: 320, depthWidth: 160 } }, (stage, frac, msg) => { if (msg) logs.push(`${stage}: ${msg}`); });
  assert.equal(res.stats.registered, 6, `registered ${res.stats.registered}\n${logs.join('\n')}`);
  assert.ok(res.stats.triangles > 2000, `triangles ${res.stats.triangles}`);
  assert.equal(res.mesh.positions.length, res.mesh.colors.length);
  assert.equal(res.mesh.positions.length, res.mesh.normals.length);
  // Depth maps should agree with the truth up to one global scale
  const dv = res.debug.depthViews.find((v) => v);
  const idx = res.debug.depthViews.indexOf(dv);
  const truthSmall = new Float32Array(dv.w * dv.h);
  const sx = w / dv.w, sy = h / dv.h;
  for (let y = 0; y < dv.h; y++) for (let x = 0; x < dv.w; x++) truthSmall[y * dv.w + x] = images[idx].truth[Math.floor((y + 0.5) * sy) * w + Math.floor((x + 0.5) * sx)];
  const acc = depthAccuracy(dv, truthSmall, dv.w, dv.h);
  assert.ok(acc.coverage > 500, `coverage ${acc.coverage}`);
  assert.ok(acc.accuracy > 0.85, `depth accuracy ${acc.accuracy.toFixed(3)}\n${logs.join('\n')}`);
});

test('end-to-end: textured object in front of a wall', async () => {
  const w = 320, h = 240, f = 260, cx = 159.5, cy = 119.5;
  const images = [];
  for (let i = 0; i < 7; i++) {
    const ang = -0.5 + i * (1.0 / 6);
    const cam = lookAt([Math.sin(ang) * 3, 0.3 * Math.sin(i), -Math.cos(ang) * 3], [0, 0, 0]);
    const r = renderObject(cam, w, h, f, cx, cy, 1, 3);
    images.push({ id: `cam${i}`, label: `cam ${i}`, width: w, height: h, rgba: r.rgba, f, cx, cy, shotIndex: i });
  }
  const res = await reconstruct(images, { quality: 'fast', preset: 'object', overrides: { featureWidth: 320, depthWidth: 160 } });
  assert.ok(res.stats.registered >= 6, `registered ${res.stats.registered}`);
  assert.ok(res.stats.triangles > 1000, `triangles ${res.stats.triangles}`);
  assert.ok(Number.isFinite(eulerCharacteristic(res.mesh.positions, res.mesh.indices)));
  assert.ok(res.cameras.filter((c) => c).length === res.stats.registered);
});

test('end-to-end: a wrong assumed focal length is corrected by refinement', async () => {
  const w = 320, h = 240, fTrue = 260, cx = 159.5, cy = 119.5;
  const images = [];
  for (let i = 0; i < 7; i++) {
    const ang = -0.5 + i * (1.0 / 6);
    // Varying the distance to the subject is what makes the focal length observable
    const dist = 2.4 + 0.35 * i;
    const cam = lookAt([Math.sin(ang) * dist, 0.3 * Math.sin(i), -Math.cos(ang) * dist], [0, 0, 0]);
    const r = renderObject(cam, w, h, fTrue, cx, cy, 1, 3);
    // All frames come from the same "camera" whose focal length is assumed 15% too short
    images.push({ id: `cam${i}`, label: `cam ${i}`, width: w, height: h, rgba: r.rgba, f: fTrue * 0.85, cx, cy, shotIndex: i, focalGroup: 'back-wide' });
  }
  const logs = [];
  const res = await reconstruct(images, { quality: 'fast', preset: 'object', debug: true, overrides: { featureWidth: 320, depthWidth: 120 } }, (s, fr, m) => { if (m) logs.push(m); });
  assert.ok(res.stats.registered >= 6, `registered ${res.stats.registered}`);
  const refined = res.debug.frames[0].f; // processing resolution equals the input here
  assert.ok(Math.abs(refined / fTrue - 1) < 0.03, `refined focal ${refined.toFixed(1)} vs true ${fTrue}\n${logs.filter((l) => /Focal|Bundle/.test(l)).join('\n')}`);
});

test('end-to-end: a distorted (ultra-wide style) lens is calibrated and reconstructed', async () => {
  const w = 320, h = 240, f = 200, cx = 159.5, cy = 119.5, k1 = -0.15;
  const images = [];
  for (let i = 0; i < 8; i++) {
    const ang = -0.55 + i * (1.1 / 7);
    const dist = 2.2 + 0.3 * (i % 3);
    const cam = lookAt([Math.sin(ang) * dist, 0.3 * Math.sin(i), -Math.cos(ang) * dist], [0, 0, 0]);
    const r = renderObject(cam, w, h, f, cx, cy, 1, 3, k1);
    images.push({ id: `cam${i}`, label: `ultra ${i}`, width: w, height: h, rgba: r.rgba, f, cx, cy, shotIndex: i, focalGroup: 'ultrawide' });
  }
  const logs = [];
  const res = await reconstruct(images, { quality: 'fast', preset: 'object', debug: true, overrides: { featureWidth: 320, depthWidth: 160 } }, (s, fr, m) => { if (m) logs.push(m); });
  assert.ok(res.stats.registered >= 7, `registered ${res.stats.registered}\n${logs.join('\n')}`);
  const k1Est = res.debug.frames[0].k1;
  assert.ok(Math.abs(k1Est - k1) < 0.05, `estimated k1 ${k1Est.toFixed(3)} vs ${k1}\n${logs.filter((l) => /Intrinsics/.test(l)).join('\n')}`);
  assert.ok(res.stats.triangles > 1000);
  assert.equal(res.dense.positions.length, res.dense.colors.length);
  assert.ok(res.stats.densePoints > 1000);
});
