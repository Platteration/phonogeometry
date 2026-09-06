// Incremental structure-from-motion: pairwise geometry, feature tracks, two-view
// initialisation, PnP registration, triangulation and bundle adjustment.
import { ransacEssential, recoverPose, triangulate, poseMatrix, ransacPnP, projectPoint, triangulationAngle } from './geometry.js';
import { cameraCenter, transpose, matMul, matVec, cross, dot } from './linalg.js';
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

  // Normalized keypoints
  const nk = frames.map((fr) => {
    const out = new Float64Array(fr.count * 2);
    for (let k = 0; k < fr.count; k++) {
      out[k * 2] = (fr.keypoints[k * 2] - fr.cx) / fr.f;
      out[k * 2 + 1] = (fr.keypoints[k * 2 + 1] - fr.cy) / fr.f;
    }
    return out;
  });

  // Pairwise two-view geometry
  const goodPairs = [];
  for (const pr of pairs) {
    const n = pr.matches.length / 2;
    if (n < 8) continue;
    const fi = frames[pr.i], fj = frames[pr.j];
    const p1 = new Float64Array(n * 2), p2 = new Float64Array(n * 2);
    for (let m = 0; m < n; m++) {
      const ki = pr.matches[m * 2], kj = pr.matches[m * 2 + 1];
      p1[m * 2] = nk[pr.i][ki * 2]; p1[m * 2 + 1] = nk[pr.i][ki * 2 + 1];
      p2[m * 2] = nk[pr.j][kj * 2]; p2[m * 2 + 1] = nk[pr.j][kj * 2 + 1];
    }
    const fmin = Math.min(fi.f, fj.f);
    const res = ransacEssential(p1, p2, n, pxThr / fmin, { maxIters: 600, seed: 1000 + pr.i * 131 + pr.j });
    if (!res || res.inliers.length < minInliers) continue;
    const ni = res.inliers.length;
    const a = new Float64Array(ni * 2), b = new Float64Array(ni * 2);
    res.inliers.forEach((m, k) => { a[k * 2] = p1[m * 2]; a[k * 2 + 1] = p1[m * 2 + 1]; b[k * 2] = p2[m * 2]; b[k * 2 + 1] = p2[m * 2 + 1]; });
    const pose = recoverPose(res.E, a, b, ni, 4 * pxThr / fmin);
    if (!pose || pose.good < minInliers) continue;
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
    goodPairs.push({ i: pr.i, j: pr.j, R: pose.R, t: pose.t, inliers: Int32Array.from(inlierPairs), count: pose.good, medianAngle });
  }
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

  function runBA(iterations) {
    const camList = registered.map((fr, idx) => ({ R: camR[fr], t: camT[fr], f: frames[fr].f, fixed: idx === 0 }));
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
      for (const o of good) { camIdx.push(camPos[o.frame]); ptIdx.push(p); xs.push(nk[o.frame][o.kp * 2], nk[o.frame][o.kp * 2 + 1]); }
    }
    if (ptTracks.length < 8) return;
    const pts = new Float64Array(ptTracks.length * 3);
    ptTracks.forEach((tid, p) => pts.set(tracks[tid].point, p * 3));
    const res = bundleAdjust(camList, pts, { cam: Int32Array.from(camIdx), pt: Int32Array.from(ptIdx), x: Float64Array.from(xs) }, { iterations, huber: pxThr * 1.5 });
    registered.forEach((fr, idx) => { camR[fr] = camList[idx].R; camT[fr] = camList[idx].t; });
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

  // Incremental registration (frames that fail PnP get one more attempt at the end,
  // when more points have been triangulated)
  let sinceBA = 0;
  const failed = new Set();
  let retryPass = false;
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
    if (++sinceBA >= 3) { runBA(6); sinceBA = 0; }
  }
  // Final refinement: second triangulation pass for tracks that became triangulable
  for (const tr of tracks) if (!tr.bad && !tr.point) tryTriangulate(tr);
  runBA(25);
  runBA(10);

  // Output
  const pointList = [], pointTracks = [];
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
  return { cameras, points: Float64Array.from(pointList), tracks: pointTracks, registeredCount: registered.length };
}
