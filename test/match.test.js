import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDescriptors, hamming } from '../src/vision/match.js';
import { rng } from './helpers.js';

/** Reference matcher: compares every bit of every pair, no shortcuts. */
function referenceMatch(A, na, B, nb, { ratio = 0.8, maxDist = 64, crossCheck = true } = {}) {
  const bestB = [], bestBd = [], secondBd = [];
  const bestA = new Array(nb).fill(-1), bestAd = new Array(nb).fill(Infinity);
  for (let i = 0; i < na; i++) {
    let b1 = Infinity, b2 = Infinity, bj = -1;
    for (let j = 0; j < nb; j++) {
      const d = hamming(A, i, B, j);
      if (d < b1) { b2 = b1; b1 = d; bj = j; } else if (d < b2) b2 = d;
      if (d < bestAd[j]) { bestAd[j] = d; bestA[j] = i; }
    }
    bestB.push(bj); bestBd.push(b1); secondBd.push(b2);
  }
  const out = [];
  for (let i = 0; i < na; i++) {
    const j = bestB[i];
    if (j < 0 || bestBd[i] > maxDist) continue;
    if (ratio < 1 && bestBd[i] > ratio * secondBd[i]) continue;
    if (crossCheck && bestA[j] !== i) continue;
    out.push(i, j);
  }
  return out;
}

function randomDescriptors(n, r) {
  const d = new Uint8Array(n * 32);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256);
  return d;
}

test('the fast matcher returns exactly what an exhaustive comparison returns', () => {
  const r = rng(31);
  for (const [na, nb] of [[40, 60], [120, 90], [200, 200]]) {
    const A = randomDescriptors(na, r);
    const B = randomDescriptors(nb, r);
    // Make a third of them near-copies so there are real matches to find, with noise
    for (let i = 0; i < Math.min(na, nb) / 3; i++) {
      for (let k = 0; k < 32; k++) B[i * 32 + k] = A[i * 32 + k];
      for (let f = 0; f < 12; f++) B[i * 32 + Math.floor(r() * 32)] ^= 1 << Math.floor(r() * 8);
    }
    for (const opts of [{}, { ratio: 0.9 }, { maxDist: 100 }, { crossCheck: false }, { ratio: 1, maxDist: 128 }]) {
      const fast = Array.from(matchDescriptors(A, na, B, nb, opts));
      const slow = referenceMatch(A, na, B, nb, opts);
      assert.deepEqual(fast, slow, `mismatch for ${na}x${nb} with ${JSON.stringify(opts)}`);
    }
  }
});

test('identical descriptor sets match one to one', () => {
  const r = rng(7);
  const A = randomDescriptors(50, r);
  const m = matchDescriptors(A, 50, A, 50);
  assert.equal(m.length / 2, 50);
  for (let k = 0; k < m.length; k += 2) assert.equal(m[k], m[k + 1]);
});
