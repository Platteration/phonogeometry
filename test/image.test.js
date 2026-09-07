import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToGray, gaussianBlur, sharpness, resizeGray, boxSum, sampleBilinear, undistortGray } from '../src/vision/image.js';
import { renderObject } from './synthScene.js';
import { lookAt, rng, gauss } from './helpers.js';

function scene(w, h, { blur = 0, noise = 0, seed = 5 } = {}) {
  const f = 260 * w / 320, cx = (w - 1) / 2, cy = (h - 1) / 2;
  const r = renderObject(lookAt([0, 0, -3], [0, 0, 0]), w, h, f, cx, cy, 1, 3);
  let g = rgbaToGray(r.rgba, w, h);
  if (blur > 0) g = gaussianBlur(g, w, h, blur * w / 320);
  if (noise > 0) { const rr = rng(seed); for (let i = 0; i < g.length; i++) g[i] += gauss(rr) * noise; }
  return { gray: g, w, h, f, cx, cy };
}

test('sharpness falls with blur and ignores noise', () => {
  const sharp = sharpness(...Object.values(scene(320, 240)).slice(0, 3));
  const noisy = scene(320, 240, { noise: 20 });
  const noisyScore = sharpness(noisy.gray, 320, 240);
  // Heavy noise must not be mistaken for detail
  assert.ok(Math.abs(noisyScore / sharp - 1) < 0.15, `sharp ${sharp.toFixed(2)} vs noisy ${noisyScore.toFixed(2)}`);
  let previous = Infinity;
  for (const blur of [0, 1, 2, 3, 5]) {
    const s = scene(320, 240, { blur, noise: 8 });
    const score = sharpness(s.gray, 320, 240);
    assert.ok(score < previous, `blur ${blur} scored ${score.toFixed(2)}, not below ${previous.toFixed(2)}`);
    previous = score;
  }
  // A clearly blurred frame must fall below the threshold the pipeline warns at
  const blurred = scene(320, 240, { blur: 3, noise: 8 });
  assert.ok(sharpness(blurred.gray, 320, 240) < 0.45 * sharp, 'three pixels of blur should trip the warning');
});

test('sharpness does not depend on image resolution', () => {
  const scores = [[320, 240], [640, 480], [960, 720]].map(([w, h]) => sharpness(scene(w, h, { noise: 8 }).gray, w, h));
  const lo = Math.min(...scores), hi = Math.max(...scores);
  assert.ok(hi / lo < 1.15, `scores vary too much between resolutions: ${scores.map((s) => s.toFixed(2)).join(', ')}`);
});

test('box sums, bilinear sampling and undistortion behave', () => {
  const w = 9, h = 7;
  const img = new Float32Array(w * h).fill(2);
  const sums = boxSum(img, w, h, 1);
  assert.equal(sums[3 * w + 4], 18); // interior 3x3 window of 2s
  assert.equal(sums[0], 8); // corner sees a 2x2 window
  const ramp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp[y * w + x] = x;
  assert.ok(Math.abs(sampleBilinear(ramp, w, h, 2.5, 3) - 2.5) < 1e-6);
  assert.ok(Number.isNaN(sampleBilinear(ramp, w, h, -0.5, 3)));
  // Undistorting an image taken through a distorting lens should restore straight lines:
  // a point on the ideal grid must sample the matching distorted position
  const s = scene(160, 120);
  const k1 = -0.15;
  const out = undistortGray(s.gray, 160, 120, s.f, s.cx, s.cy, k1);
  assert.equal(out.length, s.gray.length);
  const nx = (40 - s.cx) / s.f, ny = (30 - s.cy) / s.f;
  const D = 1 + k1 * (nx * nx + ny * ny);
  const expected = sampleBilinear(s.gray, 160, 120, s.cx + s.f * nx * D, s.cy + s.f * ny * D);
  assert.ok(Math.abs(out[30 * 160 + 40] - expected) < 1e-3);
  assert.equal(undistortGray(s.gray, 160, 120, s.f, s.cx, s.cy, 0), s.gray);
});

test('resizeGray preserves the average brightness', () => {
  const s = scene(320, 240);
  const small = resizeGray(s.gray, 320, 240, 80, 60);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean(small) - mean(s.gray)) < 1.0);
  assert.equal(small.length, 80 * 60);
});
