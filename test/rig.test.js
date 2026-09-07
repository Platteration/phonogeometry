import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSfM } from '../src/vision/sfm.js';
import { projectPoint } from '../src/vision/geometry.js';
import { relativePose, matMul, matVec, rotvecToMat, transpose, cameraCenter } from '../src/vision/linalg.js';
import { rng, gauss, lookAt, rotationError, fitSimilarity } from './helpers.js';

/**
 * A phone with three rigidly attached cameras (wide, ultra-wide and a front camera looking
 * roughly the other way) carried around the middle of a room. Points lie on a shell around
 * the cameras, so the back cameras and the front camera see opposite walls and share no
 * features at all: only the rig ties them together.
 */
function roomRig({ shots = 8, np = 8000, seed = 5, frontAngle = Math.PI * 0.94 } = {}) {
  const r = rng(seed);
  const X = new Float64Array(np * 3);
  for (let i = 0; i < np; i++) {
    // random direction on a shell of radius 9-11
    let x, y, z, n;
    do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; n = Math.hypot(x, y, z); } while (n < 0.2 || n > 1);
    const rad = 9 + r() * 2;
    X[i * 3] = (x / n) * rad; X[i * 3 + 1] = (y / n) * rad; X[i * 3 + 2] = (z / n) * rad;
  }
  const rigDefs = [
    { key: 'wide', R: rotvecToMat([0, 0, 0]), t: new Float64Array([0, 0, 0]), f: 700 },
    { key: 'ultra', R: rotvecToMat([0.02, 0.03, 0.01]), t: new Float64Array([0.012, 0, 0]), f: 430 },
    { key: 'front', R: rotvecToMat([0, frontAngle, 0]), t: new Float64Array([0.005, 0, 0.008]), f: 640 },
  ];
  const frames = [], truth = [], meta = [];
  for (let s = 0; s < shots; s++) {
    // Walk a small loop near the middle of the room, looking outward, with varying tilt so
    // the motions between shots have distinct rotation axes.
    const a = (s / shots) * Math.PI * 0.55;
    const C = [Math.cos(a) * 1.1, 0.25 * Math.sin(s * 1.7), Math.sin(a) * 1.1];
    const target = [C[0] * 8, C[1] * 8 + 1.2 * Math.sin(s * 0.9), C[2] * 8];
    const body = lookAt(C, target, [0, -1, 0.15 * Math.cos(s * 1.3)]);
    for (const rd of rigDefs) {
      const R = matMul(rd.R, body.R, 3, 3, 3);
      const Rt = matVec(rd.R, body.t, 3, 3);
      const t = new Float64Array([Rt[0] + rd.t[0], Rt[1] + rd.t[1], Rt[2] + rd.t[2]]);
      const cx = 320, cy = 240;
      const kps = new Float32Array(np * 2), visible = [];
      for (let p = 0; p < np; p++) {
        const pr = projectPoint(R, t, X.subarray(p * 3, p * 3 + 3));
        kps[p * 2] = pr[0] * rd.f + cx + gauss(r) * 0.4;
        kps[p * 2 + 1] = pr[1] * rd.f + cy + gauss(r) * 0.4;
        visible.push(pr[2] > 0 && Math.abs(pr[0] * rd.f) < cx && Math.abs(pr[1] * rd.f) < cy);
      }
      frames.push({ f: rd.f, cx, cy, width: 640, height: 480, keypoints: kps, count: np, rigKey: rd.key, shotIndex: s });
      truth.push({ R, t });
      meta.push({ key: rd.key, shot: s, visible });
    }
  }
  return { frames, truth, meta, rigDefs, r };
}

function buildPairs(frames, meta, r, { window = 2, drop = 0.2, minMatches = 40, skip = () => false } = {}) {
  const pairs = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      if (Math.abs(meta[i].shot - meta[j].shot) > window) continue;
      if (skip(i, j)) continue;
      const m = [];
      for (let p = 0; p < frames[i].count; p++) {
        if (!meta[i].visible[p] || !meta[j].visible[p]) continue;
        if (r() < drop) continue;
        m.push(p, p);
      }
      if (m.length >= minMatches) pairs.push({ i, j, matches: Int32Array.from(m) });
    }
  }
  return pairs;
}

test('the front camera, which shares no features with the back cameras, is merged through the rig', () => {
  const { frames, truth, meta, r } = roomRig({ shots: 8, seed: 5 });
  const pairs = buildPairs(frames, meta, r);
  const frontIdx = meta.map((m, i) => (m.key === 'front' ? i : -1)).filter((i) => i >= 0);
  // Sanity: the two groups really are disconnected
  const crossing = pairs.filter((p) => (meta[p.i].key === 'front') !== (meta[p.j].key === 'front'));
  assert.equal(crossing.length, 0, 'front and back cameras must share no verified matches');

  const without = runSfM(frames, pairs, { pixelThreshold: 2, useRig: false });
  for (const i of frontIdx) assert.equal(without.cameras[i], null, 'without the rig the front camera cannot be placed');

  const res = runSfM(frames, pairs, { pixelThreshold: 2, useRig: true });
  const placed = frontIdx.filter((i) => res.cameras[i]).length;
  assert.ok(placed >= frontIdx.length - 1, `rig placed ${placed}/${frontIdx.length} front frames`);
  assert.ok(res.registeredCount >= frames.length - 1, `registered ${res.registeredCount}/${frames.length}`);

  // The front camera must land in the right place in the shared coordinate frame. Fit the
  // one global similarity the reconstruction is defined up to, using only the back cameras,
  // then check where the front cameras ended up under that same transform.
  const backIdx = meta.map((m, i) => (m.key !== 'front' && res.cameras[i] ? i : -1)).filter((i) => i >= 0);
  const sim = fitSimilarity(backIdx.map((i) => Array.from(cameraCenter(res.cameras[i].R, res.cameras[i].t))),
    backIdx.map((i) => Array.from(cameraCenter(truth[i].R, truth[i].t))));
  const pathExtent = 2.2; // the camera loop has radius 1.1
  assert.ok(sim.residual < 0.02 * pathExtent, `back-camera fit residual ${sim.residual.toFixed(4)}`);
  let maxPos = 0, maxRot = 0;
  for (const i of frontIdx) {
    if (!res.cameras[i]) continue;
    const est = sim.apply(Array.from(cameraCenter(res.cameras[i].R, res.cameras[i].t)));
    const tru = cameraCenter(truth[i].R, truth[i].t);
    maxPos = Math.max(maxPos, Math.hypot(est[0] - tru[0], est[1] - tru[1], est[2] - tru[2]));
    // Rotation is comparable directly once the world alignment is known
    maxRot = Math.max(maxRot, rotationError(matMul(res.cameras[i].R, transpose(sim.rotation, 3, 3), 3, 3, 3), truth[i].R));
  }
  assert.ok(maxPos < 0.06 * pathExtent, `worst front-camera position error ${maxPos.toFixed(4)} (path extent ${pathExtent})`);
  assert.ok(maxRot < 0.05, `worst front-camera rotation error ${maxRot.toFixed(4)} rad`);
});

test('rig calibration recovers the transform between two back cameras', () => {
  const { frames, meta, rigDefs, r } = roomRig({ shots: 8, seed: 17 });
  const pairs = buildPairs(frames, meta, r);
  const res = runSfM(frames, pairs, { pixelThreshold: 2, useRig: true });
  const byKey = new Map(res.rig.map((x) => [x.key, x]));
  assert.ok(byKey.has('ultra'), 'the ultra-wide camera should be tied to the reference camera');
  const refDef = rigDefs.find((d) => d.key === res.rigRef);
  const est = byKey.get('ultra');
  const def = rigDefs.find((d) => d.key === 'ultra');
  const trueRel = matMul(def.R, transpose(refDef.R, 3, 3), 3, 3, 3);
  assert.ok(rotationError(est.R, trueRel) < 0.02, `rig rotation error ${rotationError(est.R, trueRel).toFixed(4)} rad`);
  assert.ok(est.spreadDeg < 3, `rig spread ${est.spreadDeg.toFixed(2)}°`);
  assert.ok(est.shots >= 5, `rig estimated from ${est.shots} shots`);
});

test('a camera whose own frames cannot be matched is placed by the rig', () => {
  const { frames, truth, meta, r } = roomRig({ shots: 8, seed: 23 });
  // Cut one ultra-wide frame out of the matching graph entirely
  const broken = meta.findIndex((m) => m.key === 'ultra' && m.shot === 4);
  const pairs = buildPairs(frames, meta, r, { skip: (i, j) => i === broken || j === broken });
  const res = runSfM(frames, pairs, { pixelThreshold: 2, useRig: true });
  assert.ok(res.cameras[broken], 'the rig should place the frame with no matches');
  const ref = res.cameras.findIndex((c, i) => c && meta[i].key === 'wide' && meta[i].shot === 4);
  const est = relativePose(res.cameras[ref].R, res.cameras[ref].t, res.cameras[broken].R, res.cameras[broken].t);
  const tru = relativePose(truth[ref].R, truth[ref].t, truth[broken].R, truth[broken].t);
  assert.ok(rotationError(est.R, tru.R) < 0.03, `rotation error ${rotationError(est.R, tru.R).toFixed(4)} rad`);
});
