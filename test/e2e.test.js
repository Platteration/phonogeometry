import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct } from '../src/pipeline/reconstruct.js';
import { renderRoom, renderObject, renderFurnishedRoom } from './synthScene.js';
import { lookAt, fitSimilarity } from './helpers.js';
import { rotvecToMat, matMul, matVec } from '../src/vision/linalg.js';
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

test('end-to-end: the reconstructed surface matches the true sphere', async () => {
  const w = 320, h = 240, f = 260, cx = 159.5, cy = 119.5, radius = 1;
  const images = [], truthCenters = [];
  for (let i = 0; i < 8; i++) {
    const ang = -0.55 + i * (1.1 / 7);
    const dist = 2.6 + 0.25 * (i % 3);
    const C = [Math.sin(ang) * dist, 0.3 * Math.sin(i), -Math.cos(ang) * dist];
    const cam = lookAt(C, [0, 0, 0]);
    const r = renderObject(cam, w, h, f, cx, cy, radius, 3);
    images.push({ id: `c${i}`, label: `c${i}`, width: w, height: h, rgba: r.rgba, f, cx, cy, shotIndex: i, focalGroup: 'back' });
    truthCenters.push([C[0], -C[1], -C[2]]); // pipeline output is y-up
  }
  const res = await reconstruct(images, { quality: 'balanced', preset: 'object' });
  assert.equal(res.stats.registered, 8);
  const from = [], to = [];
  res.cameras.forEach((c, i) => { if (c) { from.push(c.center); to.push(truthCenters[i]); } });
  const sim = fitSimilarity(from, to);
  // Camera centres must line up with the truth (scene is ~3 units across)
  assert.ok(sim.residual < 0.08, `camera fit residual ${sim.residual.toFixed(4)}`);
  // Every mesh vertex should lie on the true sphere (radius 1) or the back wall (z = -3)
  const P = res.mesh.positions;
  const errs = [];
  for (let i = 0; i < P.length; i += 3) {
    const p = sim.apply([P[i], P[i + 1], P[i + 2]]);
    errs.push(Math.min(Math.abs(Math.hypot(p[0], p[1], p[2]) - radius), Math.abs(p[2] + 3)));
  }
  errs.sort((a, b) => a - b);
  const median = errs[errs.length >> 1], p95 = errs[Math.floor(errs.length * 0.95)];
  assert.ok(errs.length > 5000, `only ${errs.length} vertices`);
  assert.ok(median < 0.06, `median surface error ${median.toFixed(4)} of a unit radius`);
  assert.ok(p95 < 0.15, `p95 surface error ${p95.toFixed(4)} of a unit radius`);
});

test('end-to-end: front and back cameras fired together cover a whole room', async () => {
  // A phone carried around the middle of a box-shaped room. The back camera looks one way,
  // the front camera the other, so they never share a feature: only the rig joins them.
  const w = 240, h = 180, fBack = 110, fFront = 100, cx = 119.5, cy = 89.5, half = 3;
  const furniture = [
    { c: [1.6, 0.4, 2.2], r: 0.6 }, { c: [-1.7, -0.5, 2.0], r: 0.55 },
    { c: [1.5, -0.6, -2.1], r: 0.6 }, { c: [-1.6, 0.6, -2.2], r: 0.55 },
    { c: [0.1, 1.4, 2.4], r: 0.5 }, { c: [0.0, -1.5, -2.3], r: 0.5 },
    { c: [2.3, 0.2, 0.2], r: 0.5 }, { c: [-2.4, -0.2, -0.3], r: 0.5 },
  ];
  const images = [];
  const shots = 8;
  for (let s = 0; s < shots; s++) {
    const a = -0.85 + s * (1.7 / (shots - 1));
    const C = [Math.sin(a) * 1.5, 0.18 * Math.sin(s * 1.7), Math.cos(a) * 1.5 - 1.25];
    const back = lookAt(C, [C[0] + 0.5 * Math.sin(a * 1.4), C[1] + 0.35 * Math.sin(s * 0.9), C[2] + 3], [0, -1, 0.12 * Math.cos(s * 1.3)]);
    // The front camera is bolted to the same body: a fixed rotation of about 180 degrees
    // and a few millimetres of offset, identical at every shot.
    const flip = rotvecToMat([0, Math.PI * 0.97, 0]);
    const fR = matMul(flip, back.R, 3, 3, 3);
    const fRt = matVec(flip, back.t, 3, 3);
    const front = { R: fR, t: new Float64Array([fRt[0] + 0.004, fRt[1], fRt[2] + 0.006]) };
    const rb = renderFurnishedRoom(back, w, h, fBack, cx, cy, half, furniture);
    const rf = renderFurnishedRoom(front, w, h, fFront, cx, cy, half, furniture);
    images.push({ id: `b${s}`, label: 'Back', width: w, height: h, rgba: rb.rgba, f: fBack, cx, cy, shotIndex: s, rigKey: 'back', focalGroup: 'back' });
    images.push({ id: `f${s}`, label: 'Front', width: w, height: h, rgba: rf.rgba, f: fFront, cx, cy, shotIndex: s, rigKey: 'front', focalGroup: 'front' });
  }
  const logs = [];
  const onLog = (st, fr, m) => { if (m) logs.push(m); };

  const withoutRig = await reconstruct(images, { quality: 'fast', preset: 'room', useRig: false, overrides: { featureWidth: 240, depthWidth: 120 } }, onLog);
  const withRig = await reconstruct(images, { quality: 'fast', preset: 'room', useRig: true, overrides: { featureWidth: 240, depthWidth: 120 } }, onLog);

  assert.ok(withRig.stats.registered > withoutRig.stats.registered,
    `rig registered ${withRig.stats.registered}, without it ${withoutRig.stats.registered}\n${logs.filter((l) => /component|rig|Rig/i.test(l)).join('\n')}`);
  assert.ok(withRig.stats.registered >= 12, `registered ${withRig.stats.registered}/${images.length}`);
  // Covering both directions must widen the reconstructed volume along the viewing axis
  const spanOf = (r2) => {
    const p = r2.mesh.positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < p.length; i += 3) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    return hi - lo;
  };
  const scaleOf = (r2) => {
    const cs = r2.cameras.filter(Boolean).map((c) => c.center);
    let m = 0;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) m = Math.max(m, Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1], cs[i][2] - cs[j][2]));
    return m;
  };
  const relSpan = spanOf(withRig) / scaleOf(withRig);
  const relSpanNo = spanOf(withoutRig) / scaleOf(withoutRig);
  assert.ok(relSpan > relSpanNo * 1.3, `depth coverage ${relSpan.toFixed(2)} vs ${relSpanNo.toFixed(2)} camera-path units`);
});
