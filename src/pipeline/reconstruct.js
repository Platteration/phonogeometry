// End-to-end reconstruction pipeline: images -> features -> matches -> SfM ->
// plane-sweep depth -> TSDF fusion -> mesh. Platform agnostic (runs in a Worker or Node).
import { rgbaToGray, resizeGray, resizeRGBA, undistortGray, undistortRGBA, sharpness } from '../vision/image.js';
import { extractORB } from '../vision/orb.js';
import { matchDescriptors } from '../vision/match.js';
import { runSfM } from '../vision/sfm.js';
import { computeDepthMap, filterDepthConsistency } from '../vision/planeSweep.js';
import { createGpuSweeper } from '../vision/planeSweepGPU.js';
import { cameraCenter, inv3 } from '../vision/linalg.js';
import { triangulationAngle } from '../vision/geometry.js';
import { TSDFVolume, fitVolume } from '../mesh/tsdf.js';
import { surfaceNets } from '../mesh/surfaceNets.js';
import { computeNormals, smoothMesh, removeSmallComponents } from '../mesh/meshUtils.js';

// maxFeatures and cornerThreshold decide how far apart consecutive shots may be. Measured on
// a synthetic object, 1000 features at corner threshold 18 lose the geometry beyond about
// 16 degrees of viewpoint change, while 3000 features at threshold 12 still recover it at 25
// degrees. Being able to take fewer, wider-spaced shots more than pays for the extra matching
// time, because the number of image pairs grows with the square of the number of shots.
export const QUALITY = {
  fast: { featureWidth: 560, maxFeatures: 2000, cornerThreshold: 14, depthWidth: 160, numPlanes: 48, voxelRes: 96, neighbors: 2, radius: 3 },
  balanced: { featureWidth: 640, maxFeatures: 3000, cornerThreshold: 12, depthWidth: 240, numPlanes: 64, voxelRes: 128, neighbors: 3, radius: 3 },
  high: { featureWidth: 800, maxFeatures: 4500, cornerThreshold: 10, depthWidth: 320, numPlanes: 96, voxelRes: 176, neighbors: 4, radius: 3 },
};

export const PRESETS = {
  // focus: radius of the kept region around the cameras' common look-at point, as a fraction
  // of the mean camera distance (0 = keep everything)
  object: { percentile: 0.02, minComponent: 0.03, truncVoxels: 3, smoothIters: 3, minZncc: 0.55, focus: 0.55 },
  person: { percentile: 0.02, minComponent: 0.03, truncVoxels: 3, smoothIters: 4, minZncc: 0.5, focus: 0.6 },
  room: { percentile: 0.01, minComponent: 0.01, truncVoxels: 4, smoothIters: 2, minZncc: 0.5, focus: 0 },
};

/**
 * Least-squares intersection of the cameras' optical axes. Returns null when the axes do
 * not converge (e.g. a room scanned from its centre), so no cropping is applied.
 */
export function opticalAxesFocus(cameras, centers) {
  const A = new Float64Array(9), b = new Float64Array(3);
  let n = 0;
  cameras.forEach((cam, i) => {
    if (!cam) return;
    const d = [cam.R[6], cam.R[7], cam.R[8]]; // optical axis in world coordinates
    const C = centers[i];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const m = (r === c ? 1 : 0) - d[r] * d[c];
        A[r * 3 + c] += m;
        b[r] += m * C[c];
      }
    }
    n++;
  });
  if (n < 3) return null;
  const inv = inv3(A);
  if (!inv) return null;
  const P = [0, 1, 2].map((r) => inv[r * 3] * b[0] + inv[r * 3 + 1] * b[1] + inv[r * 3 + 2] * b[2]);
  let sumDist = 0, sumOff = 0, front = 0;
  cameras.forEach((cam, i) => {
    if (!cam) return;
    const C = centers[i], d = [cam.R[6], cam.R[7], cam.R[8]];
    const v = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
    const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    if (along > 0) front++;
    const off = Math.hypot(v[0] - along * d[0], v[1] - along * d[1], v[2] - along * d[2]);
    sumDist += Math.hypot(...v); sumOff += off;
  });
  const meanDistance = sumDist / n, meanOffset = sumOff / n;
  // Converging axes pass close to the focus; diverging (room) scans do not.
  if (front < 0.8 * n || meanOffset > 0.35 * meanDistance) return null;
  return { point: P, meanDistance, meanOffset };
}

/**
 * Flag frames that are much softer than the others taken with the same camera. Frames are
 * compared within a camera because different lenses see different things: an ultra-wide
 * frame of a whole room and a telephoto frame of one object have different amounts of
 * detail without either being blurred.
 * @param items objects with `sharpness` and a camera key (`rigKey`, `focalGroup` or `key`)
 * @param threshold fraction of the camera's median below which a frame counts as soft
 */
export function markSoftFrames(items, threshold = 0.7) {
  const groups = new Map();
  for (const it of items) {
    if (typeof it.sharpness !== 'number') continue;
    const key = it.rigKey ?? it.focalGroup ?? it.key ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const all = items.filter((it) => typeof it.sharpness === 'number');
  const globalMedian = all.length ? all.map((it) => it.sharpness).sort((a, b) => a - b)[all.length >> 1] : 0;
  for (const list of groups.values()) {
    // Too few frames from this camera to judge it on its own, so use them all
    const basis = list.length >= 3 ? list.map((it) => it.sharpness).sort((a, b) => a - b)[list.length >> 1] : globalMedian;
    for (const it of list) {
      it.softReference = basis;
      it.soft = basis > 0 && it.sharpness < threshold * basis;
    }
  }
  return items;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  return sortedArr[Math.min(sortedArr.length - 1, Math.max(0, Math.floor(p * (sortedArr.length - 1))))];
}

/** Coarse global descriptor (normalised 12x12 thumbnail) for candidate pair selection. */
function globalDescriptor(gray, w, h) {
  const t = resizeGray(gray, w, h, 12, 12);
  let mean = 0;
  for (let i = 0; i < t.length; i++) mean += t[i];
  mean /= t.length;
  let v = 0;
  for (let i = 0; i < t.length; i++) { t[i] -= mean; v += t[i] * t[i]; }
  const s = Math.sqrt(v / t.length) || 1;
  for (let i = 0; i < t.length; i++) t[i] /= s;
  return t;
}

/**
 * Choose which image pairs to match. Matching every pair costs time that grows with the
 * square of the number of shots and mostly buys nothing, because shots taken far apart in
 * a walk around a subject share no view. Pairs are kept when the shots were taken close
 * together, when the two frames come from the same shot (they are simultaneous, so they
 * always overlap), or when a coarse thumbnail descriptor says the views look alike, which
 * is what catches a loop closing back on itself.
 */
function selectCandidatePairs(frames, opts) {
  const n = frames.length;
  const pairs = new Set();
  const key = (i, j) => (i < j ? i * n + j : j * n + i);
  const allPairs = n * (n - 1) / 2;
  const shot = (i) => frames[i].shotIndex ?? i;
  if (allPairs <= (opts.maxPairs ?? 60)) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.add(key(i, j));
    return Array.from(pairs).map((k) => [Math.floor(k / n), k % n]);
  }
  const window = opts.shotWindow ?? 3;
  const topK = opts.similarK ?? 5;
  const desc = frames.map((f) => f.global);
  for (let i = 0; i < n; i++) {
    const sims = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (Math.abs(shot(i) - shot(j)) <= window) pairs.add(key(i, j));
      let s = 0;
      for (let k = 0; k < desc[i].length; k++) s += desc[i][k] * desc[j][k];
      sims.push([s, j]);
    }
    sims.sort((a, b) => b[0] - a[0]);
    for (let k = 0; k < Math.min(topK, sims.length); k++) pairs.add(key(i, sims[k][1]));
  }
  return Array.from(pairs).map((k) => [Math.floor(k / n), k % n]);
}

/**
 * @param images [{id, width, height, rgba: Uint8ClampedArray, f, cx, cy, shotIndex, label}]
 * @param options {quality: 'fast'|'balanced'|'high', preset: 'object'|'person'|'room', debug}
 * @param progress (stage, fraction, message) => void
 */
export async function reconstruct(images, options = {}, progress = () => {}) {
  const q = { ...QUALITY[options.quality || 'balanced'], ...(options.overrides || {}) };
  const preset = PRESETS[options.preset || 'object'];
  const log = (msg) => progress('log', null, msg);
  const t0 = Date.now();

  if (images.length < 2) throw new Error('At least two images are needed');

  // 1. Preprocess + features
  const frames = [];
  for (let i = 0; i < images.length; i++) {
    const im = images[i];
    progress('features', i / images.length, `Extracting features ${i + 1}/${images.length}`);
    const s = Math.min(1, q.featureWidth / Math.max(im.width, im.height));
    const fw = Math.max(32, Math.round(im.width * s)), fh = Math.max(32, Math.round(im.height * s));
    const grayFull = rgbaToGray(im.rgba, im.width, im.height);
    const gray = resizeGray(grayFull, im.width, im.height, fw, fh);
    const sx = fw / im.width, sy = fh / im.height;
    const sharp = sharpness(gray, fw, fh);
    const feat = extractORB(gray, fw, fh, { maxFeatures: q.maxFeatures, threshold: q.cornerThreshold });
    frames.push({
      id: im.id, label: im.label, shotIndex: im.shotIndex ?? i, focalGroup: im.focalGroup ?? im.id,
      rigKey: im.rigKey ?? im.focalGroup ?? im.id,
      width: fw, height: fh, gray, fullW: im.width, fullH: im.height, rgba: im.rgba,
      f: im.f * sx, cx: (im.cx + 0.5) * sx - 0.5, cy: (im.cy + 0.5) * sy - 0.5,
      keypoints: feat.keypoints, count: feat.count, descriptors: feat.descriptors,
      sharpness: sharp,
      global: globalDescriptor(gray, fw, fh),
    });
    log(`Frame ${i} (${im.label || im.id}): ${feat.count} features at ${fw}x${fh}, sharpness ${sharp.toFixed(2)}`);
  }

  // Warn about frames that are much softer than the rest. A blurred frame in the middle of a
  // sequence often fails to match its neighbours, which breaks the chain of images and can
  // strand everything on the far side of it: a single frame blurred by three pixels was
  // measured to cut the number of registered frames in half.
  markSoftFrames(frames);
  {
    const soft = frames.filter((fr) => fr.soft);
    if (soft.length) {
      log(`Warning: ${soft.length} frame(s) look blurred next to the others from the same camera ` +
        `(${soft.map((fr) => `${fr.label || fr.id}: ${fr.sharpness.toFixed(2)} against ${fr.softReference.toFixed(2)}`).join(', ')}). Retaking those shots would help.`);
    }
  }

  // 2. Matching
  const candidates = selectCandidatePairs(frames, q);
  const pairs = [];
  for (let k = 0; k < candidates.length; k++) {
    const [i, j] = candidates[k];
    progress('matching', k / candidates.length, `Matching pair ${k + 1}/${candidates.length}`);
    const m = matchDescriptors(frames[i].descriptors, frames[i].count, frames[j].descriptors, frames[j].count);
    if (m.length / 2 >= 20) pairs.push({ i, j, matches: m });
  }
  for (const fr of frames) fr.descriptors = null; // no longer needed
  log(`${pairs.length}/${candidates.length} pairs have enough matches`);
  if (pairs.length === 0) throw new Error('No overlapping image pairs found. Take photos with more overlap and texture.');

  // 3. Structure from motion
  progress('sfm', 0, 'Estimating camera poses');
  // Frames sharing a physical camera share one focal-length parameter in bundle adjustment
  const groupIds = new Map();
  for (const fr of frames) { if (!groupIds.has(fr.focalGroup)) groupIds.set(fr.focalGroup, groupIds.size); fr.focalGroup = groupIds.get(fr.focalGroup); }
  const sfm = runSfM(frames, pairs, {
    pixelThreshold: 2.0,
    refineFocal: options.refineFocal !== false,
    refineDistortion: options.refineDistortion !== false,
    useRig: options.useRig !== false,
    log,
  });
  if (sfm.registeredCount < 2) throw new Error(sfm.error || 'Could not register the cameras');
  const registered = [];
  sfm.cameras.forEach((c, i) => { if (c) registered.push(i); });

  // Visibility per frame: sparse depths and shared point counts
  const frameDepths = frames.map(() => []);
  const sharedCount = new Map();
  for (let p = 0; p < sfm.tracks.length; p++) {
    const tr = sfm.tracks[p];
    const X = sfm.points.subarray(p * 3, p * 3 + 3);
    for (const [fr] of tr) {
      const cam = sfm.cameras[fr];
      const z = cam.R[6] * X[0] + cam.R[7] * X[1] + cam.R[8] * X[2] + cam.t[2];
      frameDepths[fr].push(z);
    }
    for (let a = 0; a < tr.length; a++) for (let b = a + 1; b < tr.length; b++) {
      const k = tr[a][0] < tr[b][0] ? tr[a][0] * frames.length + tr[b][0] : tr[b][0] * frames.length + tr[a][0];
      sharedCount.set(k, (sharedCount.get(k) || 0) + 1);
    }
  }
  const centers = sfm.cameras.map((c) => (c ? cameraCenter(c.R, c.t) : null));

  // 4. Dense depth (GPU plane sweep when WebGL2 is available, CPU otherwise)
  let gpu = null;
  if (options.gpu !== false) {
    try { gpu = createGpuSweeper(); } catch { gpu = null; }
    log(gpu ? `Depth maps on the GPU (${gpu.info})` : 'Depth maps on the CPU (WebGL2 float rendering unavailable)');
  }
  const sweep = (ref, nbs, sweepOpts) => {
    if (gpu && !gpu.isLost()) {
      try { return gpu.computeDepthMap(ref, nbs, sweepOpts); }
      catch (err) { log(`GPU depth failed (${err.message}), falling back to the CPU`); gpu.dispose(); gpu = null; }
    }
    return computeDepthMap(ref, nbs, sweepOpts);
  };
  const depthViews = frames.map(() => null);
  const neighborIdx = frames.map(() => []);
  let done = 0;
  for (const fr of registered) {
    progress('depth', done / registered.length, `Depth map ${done + 1}/${registered.length}`);
    done++;
    const depths = frameDepths[fr].filter((z) => z > 0).sort((a, b) => a - b);
    if (depths.length < 10) { log(`Frame ${fr}: too few sparse points for a depth range, skipped`); continue; }
    const median = percentile(depths, 0.5);
    const dmin = Math.max(percentile(depths, 0.05) * 0.6, median * 0.15);
    const dmax = Math.min(percentile(depths, 0.95) * 1.6, median * 6);
    // Neighbour selection by shared points with reasonable parallax
    const scored = [];
    for (const other of registered) {
      if (other === fr) continue;
      const k = fr < other ? fr * frames.length + other : other * frames.length + fr;
      const shared = sharedCount.get(k) || 0;
      if (shared < 15) continue;
      const midDepth = percentile(depths, 0.5);
      const cam = sfm.cameras[fr];
      // point along the optical axis at median depth
      const Xc = [0, 0, midDepth];
      const Xw = [
        cam.R[0] * (Xc[0] - cam.t[0]) + cam.R[3] * (Xc[1] - cam.t[1]) + cam.R[6] * (Xc[2] - cam.t[2]),
        cam.R[1] * (Xc[0] - cam.t[0]) + cam.R[4] * (Xc[1] - cam.t[1]) + cam.R[7] * (Xc[2] - cam.t[2]),
        cam.R[2] * (Xc[0] - cam.t[0]) + cam.R[5] * (Xc[1] - cam.t[1]) + cam.R[8] * (Xc[2] - cam.t[2]),
      ];
      const ang = triangulationAngle(centers[fr], centers[other], Xw) * 180 / Math.PI;
      if (ang < 1.0 || ang > 50) continue;
      const angScore = Math.min(ang / 8, 1) * Math.max(0, 1 - Math.max(0, ang - 25) / 25);
      scored.push([shared * (0.3 + angScore), other]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const nbs = scored.slice(0, q.neighbors).map((s) => s[1]);
    if (nbs.length === 0) { log(`Frame ${fr}: no suitable neighbour views, skipped`); continue; }
    neighborIdx[fr] = nbs;
    const view = (idx) => {
      const f = frames[idx];
      if (!f.depthGray) {
        const s = Math.min(1, q.depthWidth / Math.max(f.width, f.height));
        const dw = Math.max(16, Math.round(f.width * s)), dh = Math.max(16, Math.round(f.height * s));
        f.dw = dw; f.dh = dh;
        f.df = f.f * (dw / f.width); f.dcx = (f.cx + 0.5) * (dw / f.width) - 0.5; f.dcy = (f.cy + 0.5) * (dh / f.height) - 0.5;
        // The plane sweep assumes pinhole cameras: resample distorted images onto the pinhole grid
        f.depthGray = undistortGray(resizeGray(f.gray, f.width, f.height, dw, dh), dw, dh, f.df, f.dcx, f.dcy, f.k1 || 0);
        f.depthRGBA = undistortRGBA(resizeRGBA(f.rgba, f.fullW, f.fullH, dw, dh), dw, dh, f.df, f.dcx, f.dcy, f.k1 || 0);
      }
      const cam = sfm.cameras[idx];
      return { gray: f.depthGray, w: f.dw, h: f.dh, f: f.df, cx: f.dcx, cy: f.dcy, R: cam.R, t: cam.t, rgb: f.depthRGBA };
    };
    const ref = view(fr);
    const res = sweep(ref, nbs.map(view), { dmin, dmax, numPlanes: q.numPlanes, radius: q.radius, minZncc: preset.minZncc });
    let valid = 0;
    for (let i = 0; i < res.depth.length; i++) if (res.depth[i] > 0) valid++;
    log(`Frame ${fr}: depth from ${nbs.length} neighbours, ${(100 * valid / res.depth.length).toFixed(0)}% coverage, range ${dmin.toFixed(2)}-${dmax.toFixed(2)}`);
    depthViews[fr] = { ...ref, depth: res.depth, confidence: res.confidence };
  }
  if (gpu) { gpu.dispose(); gpu = null; }
  const haveDepth = depthViews.filter((v) => v);
  if (haveDepth.length === 0) throw new Error('No depth maps could be computed. Add more overlapping photos.');

  progress('fusion', 0, 'Checking depth consistency');
  const filtered = filterDepthConsistency(depthViews, neighborIdx.map((nbs) => nbs), { relTol: 0.04, minAgree: 1 });
  depthViews.forEach((v, i) => { if (v) v.depth = filtered[i]; });

  // 5. Volume + fusion (the subsampled dense cloud is also exported for the user)
  const dense = [], denseColors = [];
  for (const v of depthViews) {
    if (!v) continue;
    const step = Math.max(1, Math.floor(Math.sqrt((v.w * v.h) / 6000)));
    for (let y = 0; y < v.h; y += step) for (let x = 0; x < v.w; x += step) {
      const d = v.depth[y * v.w + x];
      if (!(d > 0)) continue;
      const Xc = [((x - v.cx) / v.f) * d, ((y - v.cy) / v.f) * d, d];
      const R = v.R, t = v.t;
      dense.push(
        R[0] * (Xc[0] - t[0]) + R[3] * (Xc[1] - t[1]) + R[6] * (Xc[2] - t[2]),
        R[1] * (Xc[0] - t[0]) + R[4] * (Xc[1] - t[1]) + R[7] * (Xc[2] - t[2]),
        R[2] * (Xc[0] - t[0]) + R[5] * (Xc[1] - t[1]) + R[8] * (Xc[2] - t[2]),
      );
      const o = (y * v.w + x) * 4;
      denseColors.push(v.rgb ? v.rgb[o] / 255 : 0.6, v.rgb ? v.rgb[o + 1] / 255 : 0.6, v.rgb ? v.rgb[o + 2] / 255 : 0.6);
    }
  }
  if (dense.length < 300) throw new Error('Too few consistent depth samples to build a surface.');
  let densePts = Float64Array.from(dense);
  if (preset.focus) {
    // Object/person scans orbit their subject: crop the volume to where the optical axes converge
    const focus = opticalAxesFocus(sfm.cameras, centers);
    if (focus) {
      const radius = focus.meanDistance * preset.focus;
      const kept = [];
      for (let i = 0; i < densePts.length; i += 3) {
        if (Math.hypot(densePts[i] - focus.point[0], densePts[i + 1] - focus.point[1], densePts[i + 2] - focus.point[2]) <= radius) kept.push(densePts[i], densePts[i + 1], densePts[i + 2]);
      }
      if (kept.length >= 300) { densePts = Float64Array.from(kept); log(`Focused on the subject: kept ${(100 * kept.length / dense.length).toFixed(0)}% of depth samples within the scan radius`); }
    }
  }
  const vol = fitVolume(densePts, q.voxelRes, { percentile: preset.percentile, margin: 0.06 });
  const tsdf = new TSDFVolume(vol.origin, vol.dims, vol.voxelSize, vol.voxelSize * preset.truncVoxels);
  let k = 0;
  for (const v of depthViews) {
    if (!v) continue;
    progress('fusion', 0.2 + 0.6 * (k++ / haveDepth.length), `Fusing depth map ${k}/${haveDepth.length}`);
    tsdf.integrate(v);
  }
  log(`Volume ${vol.dims.join('x')} voxels, voxel size ${vol.voxelSize.toExponential(2)}`);

  // 6. Mesh
  progress('mesh', 0, 'Extracting surface');
  let mesh = surfaceNets(tsdf.tsdf, Array.from(tsdf.dims), tsdf.weight);
  if (mesh.indices.length === 0) throw new Error('The fused volume contains no surface.');
  mesh = removeSmallComponents(mesh.positions, mesh.indices, preset.minComponent);
  const smoothed = smoothMesh(mesh.positions, mesh.indices, preset.smoothIters);
  const nv = smoothed.length / 3;
  const positions = new Float32Array(nv * 3);
  const colors = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const wx = vol.origin[0] + smoothed[i * 3] * vol.voxelSize;
    const wy = vol.origin[1] + smoothed[i * 3 + 1] * vol.voxelSize;
    const wz = vol.origin[2] + smoothed[i * 3 + 2] * vol.voxelSize;
    const c = tsdf.sampleColor(wx, wy, wz);
    // Convert from the camera convention (y down, z forward) to y-up for viewing/export
    positions[i * 3] = wx; positions[i * 3 + 1] = -wy; positions[i * 3 + 2] = -wz;
    colors[i * 3] = c[0] / 255; colors[i * 3 + 1] = c[1] / 255; colors[i * 3 + 2] = c[2] / 255;
  }
  // Flipping two axes preserves handedness, so the winding stays valid.
  const normals = computeNormals(positions, mesh.indices);

  // Sparse cloud and cameras for display (same y-up flip)
  const nSparse = sfm.points.length / 3;
  const sparse = new Float32Array(nSparse * 3), sparseColors = new Float32Array(nSparse * 3);
  for (let p = 0; p < nSparse; p++) {
    sparse[p * 3] = sfm.points[p * 3]; sparse[p * 3 + 1] = -sfm.points[p * 3 + 1]; sparse[p * 3 + 2] = -sfm.points[p * 3 + 2];
    const [fr, kp] = sfm.tracks[p][0];
    const f = frames[fr];
    const px = Math.min(f.fullW - 1, Math.max(0, Math.round(f.keypoints[kp * 2] * (f.fullW / f.width))));
    const py = Math.min(f.fullH - 1, Math.max(0, Math.round(f.keypoints[kp * 2 + 1] * (f.fullH / f.height))));
    const o = (py * f.fullW + px) * 4;
    sparseColors[p * 3] = f.rgba[o] / 255; sparseColors[p * 3 + 1] = f.rgba[o + 1] / 255; sparseColors[p * 3 + 2] = f.rgba[o + 2] / 255;
  }
  const cameras = sfm.cameras.map((c, i) => {
    if (!c) return null;
    const C = cameraCenter(c.R, c.t);
    return {
      id: frames[i].id, label: frames[i].label,
      center: [C[0], -C[1], -C[2]],
      // Camera axes in world space (rows of R), flipped to y-up
      right: [c.R[0], -c.R[1], -c.R[2]], down: [c.R[3], -c.R[4], -c.R[5]], forward: [c.R[6], -c.R[7], -c.R[8]],
      aspect: frames[i].width / frames[i].height, fovTan: (frames[i].width / 2) / frames[i].f,
    };
  });

  const nDense = dense.length / 3;
  const densePositions = new Float32Array(nDense * 3);
  for (let i = 0; i < nDense; i++) { densePositions[i * 3] = dense[i * 3]; densePositions[i * 3 + 1] = -dense[i * 3 + 1]; densePositions[i * 3 + 2] = -dense[i * 3 + 2]; }
  const result = {
    mesh: { positions, normals, colors, indices: mesh.indices },
    sparse: { positions: sparse, colors: sparseColors },
    dense: { positions: densePositions, colors: Float32Array.from(denseColors) },
    cameras,
    stats: {
      images: images.length, registered: sfm.registeredCount, sparsePoints: nSparse, densePoints: nDense,
      rig: (sfm.rig || []).map((r2) => ({ camera: String(r2.key), shots: r2.shots, spreadDeg: r2.spreadDeg })),
      frames: frames.map((fr, i) => ({ id: fr.id, label: fr.label, used: !!sfm.cameras[i], sharpness: fr.sharpness, soft: !!fr.soft })),
      intrinsics: frames.map((fr, i) => (sfm.cameras[i] ? { label: fr.label, focalPx: fr.f * (fr.fullW / fr.width), k1: fr.k1 || 0 } : null)).filter(Boolean),
      depthMaps: haveDepth.length, vertices: nv, triangles: mesh.indices.length / 3,
      seconds: (Date.now() - t0) / 1000, voxelSize: vol.voxelSize, volumeDims: Array.from(vol.dims),
    },
  };
  if (options.debug) result.debug = { depthViews, sfm, frames };
  progress('done', 1, `Done: ${result.stats.triangles} triangles in ${result.stats.seconds.toFixed(1)}s`);
  return result;
}
