// Incremental structure-from-motion: pairwise geometry, feature tracks, two-view
// initialisation, PnP registration, triangulation and bundle adjustment.
import { ransacEssential, recoverPose, triangulate, poseMatrix, ransacPnP, refinePose, projectPoint, triangulationAngle, undistortNormalized } from './geometry.js';
import { cameraCenter, transpose, matMul, matVec, cross, dot, relativePose, closestRotation, matToRotvec, similarityTransform } from './linalg.js';
import { bundleAdjust } from './ba.js';

class UnionFind {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
}

/**
 * @param frames [{f, cx, cy, width, height, keypoints: Float32Array, count}]
 * @param pairs [{i, j, matches: Int32Array}]
 * @param opts {pixelThreshold, minInliers, minAngleDeg, log}
 */
export function runSfM(frames, pairs, opts = {}) {
  const log = opts.log || (() => {});
  const pxThr = opts.pixelThreshold ?? 2.0;
  const minInliers = opts.minInliers ?? 15;
  const minAngle = (opts.minAngleDeg ?? 1.5) * Math.PI / 180;
  const nf = frames.length;

  // Normalized, undistorted keypoints (pinhole-equivalent) for the current intrinsics
  for (const fr of frames) fr.k1 = fr.k1 || 0;
  const computeNk = (fr) => {
    const out = new Float64Array(fr.count * 2);
    for (let k = 0; k < fr.count; k++) {
      const [x, y] = undistortNormalized((fr.keypoints[k * 2] - fr.cx) / fr.f, (fr.keypoints[k * 2 + 1] - fr.cy) / fr.f, fr.k1);
      out[k * 2] = x; out[k * 2 + 1] = y;
    }
    return out;
  };
  const nk = frames.map(computeNk);

  // Pairwise two-view geometry
  function verifyPair(pr) {
    const n = pr.matches.length / 2;
    if (n < 8) return null;
    const fi = frames[pr.i], fj = frames[pr.j];
    const p1 = new Float64Array(n * 2), p2 = new Float64Array(n * 2);
    for (let m = 0; m < n; m++) {
      const ki = pr.matches[m * 2], kj = pr.matches[m * 2 + 1];
      p1[m * 2] = nk[pr.i][ki * 2]; p1[m * 2 + 1] = nk[pr.i][ki * 2 + 1];
      p2[m * 2] = nk[pr.j][kj * 2]; p2[m * 2 + 1] = nk[pr.j][kj * 2 + 1];
    }
    const fmin = Math.min(fi.f, fj.f);
    const res = ransacEssential(p1, p2, n, pxThr / fmin, { maxIters: 600, seed: 1000 + pr.i * 131 + pr.j });
    if (!res || res.inliers.length < minInliers) return null;
    const ni = res.inliers.length;
    const a = new Float64Array(ni * 2), b = new Float64Array(ni * 2);
    res.inliers.forEach((m, k) => { a[k * 2] = p1[m * 2]; a[k * 2 + 1] = p1[m * 2 + 1]; b[k * 2] = p2[m * 2]; b[k * 2 + 1] = p2[m * 2 + 1]; });
    const pose = recoverPose(res.E, a, b, ni, 4 * pxThr / fmin);
    if (!pose || pose.good < minInliers) return null;
    const C2 = cameraCenter(pose.R, pose.t);
    const angles = [];
    const inlierPairs = [];
    pose.points.forEach((X, k) => {
      if (!X) return;
      angles.push(triangulationAngle([0, 0, 0], C2, X));
      const m = res.inliers[k];
      inlierPairs.push(pr.matches[m * 2], pr.matches[m * 2 + 1]);
    });
    angles.sort((x, y) => x - y);
    const medianAngle = angles[Math.floor(angles.length / 2)] || 0;
    return { i: pr.i, j: pr.j, R: pose.R, t: pose.t, inliers: Int32Array.from(inlierPairs), count: pose.good, medianAngle };
  }
  const goodPairs = [];
  for (const pr of pairs) { const gp = verifyPair(pr); if (gp) goodPairs.push(gp); }
  log(`Verified ${goodPairs.length}/${pairs.length} image pairs`);
  if (goodPairs.length === 0) return { cameras: frames.map(() => null), points: new Float64Array(0), tracks: [], registeredCount: 0, error: 'No image pair with enough geometrically consistent matches' };

  // Feature tracks
  const offsets = new Int32Array(nf + 1);
  for (let i = 0; i < nf; i++) offsets[i + 1] = offsets[i] + frames[i].count;
  const uf = new UnionFind(offsets[nf]);
  for (const gp of goodPairs) {
    for (let m = 0; m < gp.inliers.length; m += 2) uf.union(offsets[gp.i] + gp.inliers[m], offsets[gp.j] + gp.inliers[m + 1]);
  }
  const rootToTrack = new Map();
  const tracks = []; // {obs: [{frame, kp, ok}], point: Float64Array|null, bad: boolean}
  const nodeTrack = new Int32Array(offsets[nf]).fill(-1);
  for (const gp of goodPairs) {
    for (let m = 0; m < gp.inliers.length; m += 2) {
      for (const [fr, kp] of [[gp.i, gp.inliers[m]], [gp.j, gp.inliers[m + 1]]]) {
        const node = offsets[fr] + kp;
        if (nodeTrack[node] >= 0) continue;
        const root = uf.find(node);
        let tid = rootToTrack.get(root);
        if (tid === undefined) { tid = tracks.length; tracks.push({ obs: [], point: null, bad: false, frames: new Set() }); rootToTrack.set(root, tid); }
        const tr = tracks[tid];
        if (tr.frames.has(fr)) tr.bad = true; // two keypoints of one image in the same track
        tr.frames.add(fr);
        tr.obs.push({ frame: fr, kp, ok: false });
        nodeTrack[node] = tid;
      }
    }
  }
  for (const tr of tracks) if (tr.obs.length < 2) tr.bad = true;
  log(`Built ${tracks.filter((t) => !t.bad).length} feature tracks`);

  /** Merge the inlier matches of a newly verified pair into the existing tracks. */
  function addPairToTracks(gp) {
    for (let m = 0; m < gp.inliers.length; m += 2) {
      const na = offsets[gp.i] + gp.inliers[m], nb = offsets[gp.j] + gp.inliers[m + 1];
      const ta = nodeTrack[na], tb = nodeTrack[nb];
      if (ta >= 0 && ta === tb) continue;
      if (ta < 0 && tb < 0) {
        const tid = tracks.length;
        tracks.push({ obs: [{ frame: gp.i, kp: gp.inliers[m], ok: false }, { frame: gp.j, kp: gp.inliers[m + 1], ok: false }], point: null, bad: false, frames: new Set([gp.i, gp.j]) });
        nodeTrack[na] = tid; nodeTrack[nb] = tid;
        continue;
      }
      if (ta >= 0 && tb >= 0) {
        // merge tb into ta (a track may not contain two keypoints of one frame)
        const A = tracks[ta], B = tracks[tb];
        for (const fr of B.frames) if (A.frames.has(fr)) A.bad = true;
        for (const o of B.obs) { A.obs.push(o); A.frames.add(o.frame); nodeTrack[offsets[o.frame] + o.kp] = ta; }
        B.bad = true; B.obs = []; B.point = null;
        if (A.bad) A.point = null;
        continue;
      }
      const [tid, node, fr, kp] = ta >= 0 ? [ta, nb, gp.j, gp.inliers[m + 1]] : [tb, na, gp.i, gp.inliers[m]];
      const T = tracks[tid];
      if (T.frames.has(fr)) { T.bad = true; T.point = null; continue; }
      T.frames.add(fr); T.obs.push({ frame: fr, kp, ok: false }); nodeTrack[node] = tid;
    }
  }

  // Initial pair
  const sorted = goodPairs.slice().sort((a, b) => b.count - a.count);
  let init = sorted.find((p) => p.medianAngle >= 2 * Math.PI / 180) || sorted.reduce((a, b) => (b.medianAngle > a.medianAngle ? b : a));
  log(`Initial pair: frames ${init.i} & ${init.j} (${init.count} inliers, ${(init.medianAngle * 180 / Math.PI).toFixed(1)}° parallax)`);

  const camR = new Array(nf).fill(null), camT = new Array(nf).fill(null);
  const registered = [];
  const I3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  camR[init.i] = I3; camT[init.i] = new Float64Array(3); registered.push(init.i);
  camR[init.j] = init.R; camT[init.j] = init.t; registered.push(init.j);

  const reprojErrorPx = (fr, kp, X) => {
    const pr = projectPoint(camR[fr], camT[fr], X);
    if (pr[2] <= 0) return Infinity;
    return Math.hypot(pr[0] - nk[fr][kp * 2], pr[1] - nk[fr][kp * 2 + 1]) * frames[fr].f;
  };

  function tryTriangulate(tr) {
    const regObs = tr.obs.filter((o) => camR[o.frame]);
    if (regObs.length < 2) return false;
    const Ps = regObs.map((o) => poseMatrix(camR[o.frame], camT[o.frame]));
    const xs = [];
    for (const o of regObs) xs.push(nk[o.frame][o.kp * 2], nk[o.frame][o.kp * 2 + 1]);
    const X = triangulate(Ps, xs);
    if (!X) return false;
    let ok = 0, maxAng = 0;
    const centers = regObs.map((o) => cameraCenter(camR[o.frame], camT[o.frame]));
    for (let a = 0; a < regObs.length; a++) {
      if (reprojErrorPx(regObs[a].frame, regObs[a].kp, X) < pxThr * 2) ok++;
      for (let b = a + 1; b < regObs.length; b++) maxAng = Math.max(maxAng, triangulationAngle(centers[a], centers[b], X));
    }
    if (ok < 2 || maxAng < minAngle) return false;
    tr.point = X;
    for (const o of tr.obs) o.ok = !!camR[o.frame] && reprojErrorPx(o.frame, o.kp, X) < pxThr * 2;
    return true;
  }

  function triangulateNewTracks(frameIdx) {
    let n = 0;
    for (let k = 0; k < frames[frameIdx].count; k++) {
      const tid = nodeTrack[offsets[frameIdx] + k];
      if (tid < 0) continue;
      const tr = tracks[tid];
      if (tr.bad) continue;
      if (tr.point) {
        const o = tr.obs.find((ob) => ob.frame === frameIdx);
        if (o) o.ok = reprojErrorPx(frameIdx, k, tr.point) < pxThr * 2;
        continue;
      }
      if (tryTriangulate(tr)) n++;
    }
    return n;
  }

  triangulateNewTracks(init.i);
  triangulateNewTracks(init.j);
  log(`Initial triangulation: ${tracks.filter((t) => t.point).length} points`);

  const refineFocal = opts.refineFocal !== false;
  const refineDistortion = opts.refineDistortion !== false;
  const useRig = opts.useRig !== false;
  function runBA(iterations, withFocal = false) {
    const camList = registered.map((fr, idx) => ({ R: camR[fr], t: camT[fr], f: frames[fr].f, k1: frames[fr].k1, fixed: idx === 0, focalGroup: frames[fr].focalGroup ?? fr }));
    const camPos = new Int32Array(nf).fill(-1);
    registered.forEach((fr, idx) => { camPos[fr] = idx; });
    const ptTracks = [];
    const camIdx = [], ptIdx = [], xs = [];
    for (let tid = 0; tid < tracks.length; tid++) {
      const tr = tracks[tid];
      if (tr.bad || !tr.point) continue;
      const good = tr.obs.filter((o) => o.ok && camPos[o.frame] >= 0);
      if (good.length < 2) { tr.point = null; continue; }
      const p = ptTracks.length; ptTracks.push(tid);
      for (const o of good) {
        const fr = frames[o.frame];
        camIdx.push(camPos[o.frame]); ptIdx.push(p);
        // raw (distorted) normalised observations, as the BA camera model expects
        xs.push((fr.keypoints[o.kp * 2] - fr.cx) / fr.f, (fr.keypoints[o.kp * 2 + 1] - fr.cy) / fr.f);
      }
    }
    if (ptTracks.length < 8) return;
    const pts = new Float64Array(ptTracks.length * 3);
    ptTracks.forEach((tid, p) => pts.set(tracks[tid].point, p * 3));
    const useFocal = withFocal && refineFocal && registered.length >= 3;
    const useDist = withFocal && refineDistortion && registered.length >= 4 && ptTracks.length >= 100;
    const res = bundleAdjust(camList, pts, { cam: Int32Array.from(camIdx), pt: Int32Array.from(ptIdx), x: Float64Array.from(xs) }, { iterations, huber: pxThr * 1.5, refineFocal: useFocal, refineDistortion: useDist });
    registered.forEach((fr, idx) => { camR[fr] = camList[idx].R; camT[fr] = camList[idx].t; });
    if (useFocal || useDist) {
      // Apply the refined intrinsics to every frame of each camera group (registered or not)
      // and re-normalise their keypoints
      const groups = new Map();
      registered.forEach((fr, idx) => { groups.set(frames[fr].focalGroup ?? fr, { sc: camList[idx].focalScale || 1, k1: camList[idx].k1 || 0 }); });
      frames.forEach((frm, fr) => {
        const g = groups.get(frm.focalGroup ?? fr);
        if (!g) return;
        const changed = Math.abs(g.sc - 1) > 1e-6 || Math.abs(g.k1 - frm.k1) > 1e-6;
        frm.f *= g.sc; frm.k1 = g.k1;
        if (changed) nk[fr] = computeNk(frm);
      });
      log(`Intrinsics refinement: ` + Array.from(groups.values()).map((g) => `focal ${(g.sc * 100).toFixed(1)}%` + (useDist ? `, k1 ${g.k1.toFixed(3)}` : '')).join(' | '));
    }
    ptTracks.forEach((tid, p) => { tracks[tid].point = pts.subarray(p * 3, p * 3 + 3).slice(); });
    // Re-validate observations, drop weak points
    let removed = 0;
    for (const tid of ptTracks) {
      const tr = tracks[tid];
      let ok = 0;
      for (const o of tr.obs) {
        o.ok = !!camR[o.frame] && reprojErrorPx(o.frame, o.kp, tr.point) < pxThr * 2;
        if (o.ok) ok++;
      }
      if (ok < 2) { tr.point = null; removed++; }
    }
    log(`Bundle adjustment: ${res.initialRms.toFixed(2)}px -> ${res.finalRms.toFixed(2)}px over ${ptTracks.length} points (${removed} removed)`);
  }

  runBA(15);

  /**
   * Fallback registration for a frame that shares a verified two-view geometry with a
   * registered frame but too few triangulated points for PnP: chain the relative pose and
   * recover its scale from whatever 3D points the two frames do share.
   */
  const chainFailed = new Set();
  function tryChainRegistration() {
    let bestPair = null, bestN = 0;
    for (const gp of goodPairs) {
      const regI = !!camR[gp.i], regJ = !!camR[gp.j];
      if (regI === regJ) continue;
      const unreg = regI ? gp.j : gp.i;
      if (chainFailed.has(unreg) || gp.count <= bestN) continue;
      if (retryPass && failed.has(unreg)) continue;
      bestN = gp.count; bestPair = gp;
    }
    if (!bestPair || bestN < minInliers) return false;
    const reg = camR[bestPair.i] ? bestPair.i : bestPair.j;
    const unreg = reg === bestPair.i ? bestPair.j : bestPair.i;
    let Rrel = bestPair.R, trel = bestPair.t; // maps camera i coords to camera j coords
    if (reg === bestPair.j) {
      Rrel = transpose(bestPair.R, 3, 3);
      const Rt = matVec(Rrel, bestPair.t, 3, 3);
      trel = new Float64Array([-Rt[0], -Rt[1], -Rt[2]]);
    }
    const scales = [];
    for (let m = 0; m < bestPair.inliers.length; m += 2) {
      const kReg = reg === bestPair.i ? bestPair.inliers[m] : bestPair.inliers[m + 1];
      const kUn = reg === bestPair.i ? bestPair.inliers[m + 1] : bestPair.inliers[m];
      const tid = nodeTrack[offsets[reg] + kReg];
      if (tid < 0 || tracks[tid].bad || !tracks[tid].point) continue;
      const X = tracks[tid].point;
      const Xi = matVec(camR[reg], X, 3, 3);
      Xi[0] += camT[reg][0]; Xi[1] += camT[reg][1]; Xi[2] += camT[reg][2];
      const a = matVec(Rrel, Xi, 3, 3);
      const xu = [nk[unreg][kUn * 2], nk[unreg][kUn * 2 + 1], 1];
      // (a + s * trel) must be parallel to the observed ray xu
      const ca = cross(a, xu), cb = cross(trel, xu);
      const den = dot(cb, cb);
      if (den < 1e-12) continue;
      const sc = -dot(ca, cb) / den;
      if (sc > 0) scales.push(sc);
    }
    if (scales.length < 2) { chainFailed.add(unreg); return false; }
    scales.sort((a, b) => a - b);
    const sMed = scales[Math.floor(scales.length / 2)];
    const consistent = scales.filter((v) => Math.abs(v / sMed - 1) < 0.2).length;
    if (consistent < Math.max(2, scales.length * 0.5)) { chainFailed.add(unreg); return false; }
    const Rn = matMul(Rrel, camR[reg], 3, 3, 3);
    const Rt = matVec(Rrel, camT[reg], 3, 3);
    camR[unreg] = Rn;
    camT[unreg] = new Float64Array([Rt[0] + sMed * trel[0], Rt[1] + sMed * trel[1], Rt[2] + sMed * trel[2]]);
    registered.push(unreg);
    const newPts = triangulateNewTracks(unreg);
    log(`Registered frame ${unreg} by chaining from frame ${reg} (${bestN} pair inliers, scale from ${scales.length} shared points), +${newPts} points`);
    runBA(6);
    return true;
  }

  /**
   * Rig constraint. Frames captured in one shot come from cameras that are rigidly
   * attached to each other, so the pose of one gives the poses of all the others. The
   * fixed transform of each camera relative to a reference camera is estimated from the
   * shots where both are already registered, then used to place frames that structure
   * from motion could not register on their own.
   */
  const rigKey = frames.map((fr, i) => fr.rigKey ?? fr.focalGroup ?? i);
  const shotOf = frames.map((fr, i) => fr.shotIndex ?? i);
  const rigTransforms = new Map(); // rigKey -> {R, t, shots, spreadDeg}
  let rigRef = null;

  function averageRotations(Rs) {
    const M = new Float64Array(9);
    for (const R of Rs) for (let k = 0; k < 9; k++) M[k] += R[k] / Rs.length;
    return closestRotation(M);
  }
  function angleTo(Ra, Rb) {
    const D = matMul(Ra, transpose(Rb, 3, 3), 3, 3, 3);
    const v = matToRotvec(D);
    return Math.hypot(v[0], v[1], v[2]) * 180 / Math.PI;
  }

  function estimateRig() {
    // Reference camera: the one with the most registered frames
    const perKey = new Map();
    for (let fr = 0; fr < nf; fr++) {
      if (!camR[fr]) continue;
      if (!perKey.has(rigKey[fr])) perKey.set(rigKey[fr], []);
      perKey.get(rigKey[fr]).push(fr);
    }
    if (perKey.size < 2) return 0;
    rigRef = null;
    let bestN = 0;
    for (const [key, list] of perKey) if (list.length > bestN) { bestN = list.length; rigRef = key; }
    const refByShot = new Map();
    for (const fr of perKey.get(rigRef)) refByShot.set(shotOf[fr], fr);
    let learned = 0;
    for (const [key, list] of perKey) {
      if (key === rigRef) continue;
      const samples = [];
      for (const fr of list) {
        const refFr = refByShot.get(shotOf[fr]);
        if (refFr === undefined) continue;
        samples.push(relativePose(camR[refFr], camT[refFr], camR[fr], camT[fr]));
      }
      if (samples.length < 2) continue;
      // Robust average: chordal mean, drop rotations far from it, recompute
      let R = averageRotations(samples.map((s2) => s2.R));
      const keptIdx = samples.map((s2, i) => [angleTo(s2.R, R), i]).filter(([a]) => a < 6).map(([, i]) => i);
      if (keptIdx.length < 2) continue;
      R = averageRotations(keptIdx.map((i) => samples[i].R));
      const spread = Math.max(...keptIdx.map((i) => angleTo(samples[i].R, R)));
      const t = new Float64Array(3);
      for (let k = 0; k < 3; k++) {
        const vals = keptIdx.map((i) => samples[i].t[k]).sort((a, b) => a - b);
        t[k] = vals[vals.length >> 1];
      }
      const prev = rigTransforms.get(key);
      if (!prev || keptIdx.length > prev.shots) { rigTransforms.set(key, { R, t, shots: keptIdx.length, spreadDeg: spread }); learned++; }
    }
    if (learned) {
      log(`Rig calibration: ${rigTransforms.size} camera(s) tied to the reference camera ` +
        Array.from(rigTransforms.entries()).map(([k, v]) => `[${k}: ${v.shots} shots, ${v.spreadDeg.toFixed(1)}° spread]`).join(' '));
    }
    return learned;
  }

  /** Place an unregistered frame using the rig transform of its camera. */
  function tryRigRegistration() {
    if (rigTransforms.size === 0 && rigRef === null) return false;
    const refFrames = new Map(); // shot -> registered frame of the reference camera
    for (let fr = 0; fr < nf; fr++) if (camR[fr] && rigKey[fr] === rigRef) refFrames.set(shotOf[fr], fr);
    let placed = false;
    for (let fr = 0; fr < nf; fr++) {
      if (camR[fr]) continue;
      const rig = rigTransforms.get(rigKey[fr]);
      const refFr = refFrames.get(shotOf[fr]);
      if (refFr === undefined) continue;
      // The reference camera itself needs no transform
      const rel = rigKey[fr] === rigRef ? null : rig;
      if (rigKey[fr] !== rigRef && (!rel || rel.spreadDeg > 4)) continue;
      const Rn = rel ? matMul(rel.R, camR[refFr], 3, 3, 3) : Float64Array.from(camR[refFr]);
      const Rt = rel ? matVec(rel.R, camT[refFr], 3, 3) : camT[refFr];
      const tn = rel ? new Float64Array([Rt[0] + rel.t[0], Rt[1] + rel.t[1], Rt[2] + rel.t[2]]) : Float64Array.from(camT[refFr]);
      // Verify the predicted pose against this frame's own observations
      const X = [], x = [];
      for (let k = 0; k < frames[fr].count; k++) {
        const tid = nodeTrack[offsets[fr] + k];
        if (tid < 0 || tracks[tid].bad || !tracks[tid].point) continue;
        X.push(...tracks[tid].point); x.push(nk[fr][k * 2], nk[fr][k * 2 + 1]);
      }
      const nObs = x.length / 2;
      let R = Rn, t = tn, inliers = 0;
      if (nObs >= 6) {
        const Xa = Float64Array.from(X), xa = Float64Array.from(x);
        const ref = refinePose(Rn, tn, Xa, xa, nObs, { iters: 15 });
        const thr = pxThr * 2 / frames[fr].f;
        const count = (Rr, tt) => {
          let c = 0;
          for (let i = 0; i < nObs; i++) {
            const pr = projectPoint(Rr, tt, Xa.subarray(i * 3, i * 3 + 3));
            if (pr[2] > 0 && Math.hypot(pr[0] - xa[i * 2], pr[1] - xa[i * 2 + 1]) < thr) c++;
          }
          return c;
        };
        const cRaw = count(Rn, tn), cRef = count(ref.R, ref.t);
        if (cRef >= cRaw) { R = ref.R; t = ref.t; inliers = cRef; } else inliers = cRaw;
        // Too few of its own points agree: the rig prediction is not trustworthy here
        if (inliers < Math.max(5, 0.25 * nObs)) continue;
      } else if (nObs > 0 && rigKey[fr] === rigRef) {
        continue; // same camera, same shot as itself should not happen
      }
      camR[fr] = R; camT[fr] = t;
      registered.push(fr);
      const newPts = triangulateNewTracks(fr);
      log(`Registered frame ${fr} from the camera rig (shot ${shotOf[fr]}, ${nObs ? `${inliers}/${nObs} points agree` : 'no shared points'}), +${newPts} points`);
      placed = true;
    }
    if (placed) runBA(8, registered.length >= 4);
    return placed;
  }

  // Incremental registration (frames that fail PnP get one more attempt at the end,
  // when more points have been triangulated)
  let sinceBA = 0;
  const failed = new Set();
  let retryPass = false;
  function registerLoop() {
  let guard = 0;
  while (registered.length < nf && guard++ < nf * 4) {
    let best = -1, bestCount = 0;
    for (let fr = 0; fr < nf; fr++) {
      if (camR[fr] || failed.has(fr)) continue;
      let c = 0;
      for (let k = 0; k < frames[fr].count; k++) {
        const tid = nodeTrack[offsets[fr] + k];
        if (tid >= 0 && !tracks[tid].bad && tracks[tid].point) c++;
      }
      if (c > bestCount) { bestCount = c; best = fr; }
    }
    if (best < 0 || bestCount < 12) {
      if (tryChainRegistration()) { sinceBA = 0; continue; }
      if (useRig && estimateRig() >= 0 && tryRigRegistration()) { sinceBA = 0; continue; }
      if (!retryPass && (failed.size || chainFailed.size)) { retryPass = true; failed.clear(); chainFailed.clear(); continue; }
      break;
    }
    const X = [], x = [], kps = [];
    for (let k = 0; k < frames[best].count; k++) {
      const tid = nodeTrack[offsets[best] + k];
      if (tid < 0 || tracks[tid].bad || !tracks[tid].point) continue;
      X.push(...tracks[tid].point); x.push(nk[best][k * 2], nk[best][k * 2 + 1]); kps.push(k);
    }
    const n = kps.length;
    const res = ransacPnP(Float64Array.from(X), Float64Array.from(x), n, pxThr * 1.5 / frames[best].f, { seed: 99 + best });
    if (!res || res.inliers.length < 10 || res.inliers.length < 0.3 * n) {
      log(`Frame ${best}: PnP failed (${res ? res.inliers.length : 0}/${n} inliers)${retryPass ? '' : ', will retry later'}`);
      failed.add(best);
      continue;
    }
    camR[best] = res.R; camT[best] = res.t; registered.push(best);
    const newPts = triangulateNewTracks(best);
    log(`Registered frame ${best} with ${res.inliers.length}/${n} PnP inliers, +${newPts} points`);
    if (++sinceBA >= 3) { runBA(6, registered.length >= 4); sinceBA = 0; }
  }
  }
  registerLoop();

  // Refine intrinsics, then give the remaining frames a second chance with corrected geometry
  for (const tr of tracks) if (!tr.bad && !tr.point) tryTriangulate(tr);
  runBA(25, true);
  for (const tr of tracks) if (!tr.bad && !tr.point) tryTriangulate(tr);
  if (registered.length < nf) {
    const unreg = new Set(); for (let fr = 0; fr < nf; fr++) if (!camR[fr]) unreg.add(fr);
    let reverified = 0;
    for (const pr of pairs) {
      if (!unreg.has(pr.i) && !unreg.has(pr.j)) continue;
      const gp = verifyPair(pr);
      if (!gp) continue;
      const idx = goodPairs.findIndex((g) => g.i === gp.i && g.j === gp.j);
      if (idx >= 0) goodPairs[idx] = gp; else goodPairs.push(gp);
      addPairToTracks(gp);
      reverified++;
    }
    for (const fr of registered) triangulateNewTracks(fr);
    log(`Second pass: re-verified ${reverified} pairs involving the ${unreg.size} unregistered frame(s)`);
    failed.clear(); chainFailed.clear(); retryPass = false;
    registerLoop();
    for (const tr of tracks) if (!tr.bad && !tr.point) tryTriangulate(tr);
  }
  if (useRig && registered.length < nf) { estimateRig(); if (tryRigRegistration()) registerLoop(); }
  runBA(10, true);

  // Frames that share no features with the main reconstruction (the front camera looks the
  // other way) form their own component. Reconstruct it separately and bring it into the
  // main coordinate frame through the rig, which is the only thing connecting them.
  const merged = [];
  if (useRig && opts.allowSubComponents !== false && registered.length < nf) {
    const sub = mergeDisconnectedComponent();
    if (sub) merged.push(...sub);
  }

  function mergeDisconnectedComponent() {
    const unregIdx = [];
    for (let fr = 0; fr < nf; fr++) if (!camR[fr]) unregIdx.push(fr);
    if (unregIdx.length < 3) return null;
    const local = new Map(unregIdx.map((fr, i) => [fr, i]));
    const subFrames = unregIdx.map((fr) => frames[fr]);
    const subPairs = pairs.filter((pr) => local.has(pr.i) && local.has(pr.j))
      .map((pr) => ({ i: local.get(pr.i), j: local.get(pr.j), matches: pr.matches }));
    if (subPairs.length < 2) return null;
    log(`Reconstructing ${unregIdx.length} frames that share no features with the main model`);
    const subRes = runSfM(subFrames, subPairs, {
      ...opts, log: (m) => log('  [separate component] ' + m),
      useRig: false, allowSubComponents: false, refineFocal: false, refineDistortion: false,
    });
    if (subRes.registeredCount < 3) return null;

    // Hand-eye alignment: the rotation X with R_main = R_sub X, found from the relative
    // rotations of the reference camera in the main model and of this component's frames
    // between the same pairs of shots (B = X A X^T, so axis(B) = X axis(A)).
    const refPose = new Map(); // shot -> {R, t} of the reference camera in the main model
    for (let fr = 0; fr < nf; fr++) if (camR[fr] && rigKey[fr] === (rigRef ?? rigKey[fr])) refPose.set(shotOf[fr], { R: camR[fr], t: camT[fr] });
    const subByShot = new Map();
    unregIdx.forEach((fr, i) => { if (subRes.cameras[i]) subByShot.set(shotOf[fr], { R: subRes.cameras[i].R, t: subRes.cameras[i].t, frame: fr }); });
    const shots = Array.from(subByShot.keys()).filter((sh) => refPose.has(sh));
    if (shots.length < 3) { log(`  cannot align: only ${shots.length} shots seen by both`); return null; }
    // Both cameras are bolted to the same phone, so they travel the same path: aligning the
    // two camera trajectories gives the similarity between the reconstructions directly.
    // The few millimetres between the lenses are far below the scale of any scan.
    const Cmain = shots.map((sh) => Array.from(cameraCenter(refPose.get(sh).R, refPose.get(sh).t)));
    const Csub = shots.map((sh) => Array.from(cameraCenter(subByShot.get(sh).R, subByShot.get(sh).t)));
    // Robust fit: align, drop the worst quarter of the shots, align again. One badly placed
    // frame in either reconstruction should not drag the whole alignment with it.
    let sim = similarityTransform(Csub, Cmain);
    if (!sim) { log('  cannot align: the component has no camera motion'); return null; }
    if (shots.length >= 5) {
      const errs = Csub.map((c, i) => {
        const p = sim.apply(c);
        return [Math.hypot(p[0] - Cmain[i][0], p[1] - Cmain[i][1], p[2] - Cmain[i][2]), i];
      }).sort((a, b) => a[0] - b[0]);
      const keep = errs.slice(0, Math.max(4, Math.ceil(errs.length * 0.75))).map(([, i]) => i);
      const trimmed = similarityTransform(keep.map((i) => Csub[i]), keep.map((i) => Cmain[i]));
      if (trimmed && trimmed.residual < sim.residual) sim = trimmed;
    }
    if (sim.planarity < 0.02) { log('  cannot align: the camera path is a straight line, so the alignment is ambiguous'); return null; }
    // Judge the fit against the size of the scene, not the size of the camera path: what
    // matters is that the merged views land in the right place in the room.
    let sceneScale = 0;
    {
      const cc = [0, 1, 2].map((k) => Cmain.reduce((a, c) => a + c[k], 0) / shots.length);
      const d = [];
      for (const tr of tracks) {
        if (tr.bad || !tr.point) continue;
        d.push(Math.hypot(tr.point[0] - cc[0], tr.point[1] - cc[1], tr.point[2] - cc[2]));
      }
      d.sort((a, b) => a - b);
      sceneScale = d.length ? d[d.length >> 1] : 0;
    }
    if (!(sceneScale > 0)) { log('  cannot align: the main model has no points'); return null; }
    if (sim.residual > 0.08 * sceneScale) {
      log(`  cannot align: the two camera paths disagree by ${(100 * sim.residual / sceneScale).toFixed(1)}% of the scene size`);
      return null;
    }
    // World mapping: Xmain = scale * Q * Xsub + q, which makes R_main = R_sub * Q^T
    const X = transpose(sim.R, 3, 3);
    const toMain = sim.apply;
    const scale = sim.scale;

    // Independent check: the rig rotation implied by each shot must be the same one
    let rigSpread = 0;
    const rigRots = shots.map((sh) => matMul(matMul(subByShot.get(sh).R, X, 3, 3, 3), transpose(refPose.get(sh).R, 3, 3), 3, 3, 3));
    const meanRig = averageRotations(rigRots);
    for (const R2 of rigRots) rigSpread = Math.max(rigSpread, angleTo(R2, meanRig));
    if (rigSpread > 8) { log(`  cannot align: the implied rig rotation varies by ${rigSpread.toFixed(1)}° between shots`); return null; }
    const fitErr = sim.residual;

    // Apply the alignment and adopt the component's frames and points
    const placed = [];
    unregIdx.forEach((fr, i) => {
      const c = subRes.cameras[i];
      if (!c) return;
      const Rm = matMul(c.R, X, 3, 3, 3);
      const Cm = toMain(cameraCenter(c.R, c.t));
      camR[fr] = Rm;
      camT[fr] = new Float64Array([
        -(Rm[0] * Cm[0] + Rm[1] * Cm[1] + Rm[2] * Cm[2]),
        -(Rm[3] * Cm[0] + Rm[4] * Cm[1] + Rm[5] * Cm[2]),
        -(Rm[6] * Cm[0] + Rm[7] * Cm[1] + Rm[8] * Cm[2]),
      ]);
      registered.push(fr);
      placed.push(fr);
    });
    // Bring the component's 3D points across as tracks of the merged frames
    const extra = [];
    for (let p = 0; p < subRes.tracks.length; p++) {
      const obs = subRes.tracks[p].map(([li, kp]) => [unregIdx[li], kp]);
      extra.push({ point: toMain(subRes.points.subarray(p * 3, p * 3 + 3)), obs });
    }
    log(`Merged the separate component through the rig: ${placed.length} frames, ${extra.length} points, ` +
      `camera paths agree to ${(100 * fitErr / sceneScale).toFixed(1)}% of the scene size, rig rotation steady within ${rigSpread.toFixed(1)}°`);
    return extra;
  }

  // Output
  const pointList = [], pointTracks = [];
  for (const m of merged) {
    pointList.push(m.point[0], m.point[1], m.point[2]);
    pointTracks.push(m.obs);
  }
  for (let tid = 0; tid < tracks.length; tid++) {
    const tr = tracks[tid];
    if (tr.bad || !tr.point) continue;
    const good = tr.obs.filter((o) => o.ok && camR[o.frame]);
    if (good.length < 2) continue;
    pointList.push(tr.point[0], tr.point[1], tr.point[2]);
    pointTracks.push(good.map((o) => [o.frame, o.kp]));
  }
  const cameras = frames.map((_, i) => (camR[i] ? { R: camR[i], t: camT[i] } : null));
  log(`SfM done: ${registered.length}/${nf} frames registered, ${pointTracks.length} points`);
  const rig = Array.from(rigTransforms.entries()).map(([key, v]) => ({ key, R: v.R, t: v.t, shots: v.shots, spreadDeg: v.spreadDeg }));
  return { cameras, points: Float64Array.from(pointList), tracks: pointTracks, registeredCount: registered.length, focals: frames.map((fr) => fr.f), k1s: frames.map((fr) => fr.k1), rig, rigRef };
}
