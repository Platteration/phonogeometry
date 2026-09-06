// End-to-end reconstruction pipeline: images -> features -> matches -> SfM ->
// plane-sweep depth -> TSDF fusion -> mesh. Platform agnostic (runs in a Worker or Node).
import { rgbaToGray, resizeGray, resizeRGBA } from '../vision/image.js';
import { extractORB } from '../vision/orb.js';
import { matchDescriptors } from '../vision/match.js';
import { runSfM } from '../vision/sfm.js';
import { computeDepthMap, filterDepthConsistency } from '../vision/planeSweep.js';
import { cameraCenter, relativePose } from '../vision/linalg.js';
import { triangulationAngle } from '../vision/geometry.js';
import { TSDFVolume, fitVolume } from '../mesh/tsdf.js';
import { surfaceNets } from '../mesh/surfaceNets.js';
import { computeNormals, smoothMesh, removeSmallComponents } from '../mesh/meshUtils.js';

export const QUALITY = {
  fast: { featureWidth: 480, maxFeatures: 800, depthWidth: 160, numPlanes: 48, voxelRes: 96, neighbors: 2, radius: 3 },
  balanced: { featureWidth: 640, maxFeatures: 1100, depthWidth: 240, numPlanes: 64, voxelRes: 128, neighbors: 3, radius: 3 },
  high: { featureWidth: 800, maxFeatures: 1500, depthWidth: 320, numPlanes: 96, voxelRes: 176, neighbors: 4, radius: 3 },
};

export const PRESETS = {
  object: { percentile: 0.04, minComponent: 0.03, truncVoxels: 3, smoothIters: 3, minZncc: 0.55 },
  person: { percentile: 0.03, minComponent: 0.03, truncVoxels: 3, smoothIters: 4, minZncc: 0.5 },
  room: { percentile: 0.01, minComponent: 0.01, truncVoxels: 4, smoothIters: 2, minZncc: 0.5 },
};

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

function selectCandidatePairs(frames, opts) {
  const n = frames.length;
  const pairs = new Set();
  const key = (i, j) => (i < j ? i * n + j : j * n + i);
  const allPairs = n * (n - 1) / 2;
  if (allPairs <= (opts.maxPairs ?? 300)) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.add(key(i, j));
  } else {
    const window = opts.shotWindow ?? 3;
    const topK = opts.similarK ?? 5;
    const desc = frames.map((f) => f.global);
    for (let i = 0; i < n; i++) {
      const sims = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const ds = Math.abs((frames[i].shotIndex ?? i) - (frames[j].shotIndex ?? j));
        if (ds <= window) pairs.add(key(i, j));
        let s = 0;
        for (let k = 0; k < desc[i].length; k++) s += desc[i][k] * desc[j][k];
        sims.push([s, j]);
      }
      sims.sort((a, b) => b[0] - a[0]);
      for (let k = 0; k < Math.min(topK, sims.length); k++) pairs.add(key(i, sims[k][1]));
    }
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
    const feat = extractORB(gray, fw, fh, { maxFeatures: q.maxFeatures });
    frames.push({
      id: im.id, label: im.label, shotIndex: im.shotIndex ?? i,
      width: fw, height: fh, gray, grayFull, fullW: im.width, fullH: im.height, rgba: im.rgba,
      f: im.f * sx, cx: (im.cx + 0.5) * sx - 0.5, cy: (im.cy + 0.5) * sy - 0.5,
      keypoints: feat.keypoints, count: feat.count, descriptors: feat.descriptors,
      global: globalDescriptor(gray, fw, fh),
    });
    log(`Frame ${i} (${im.label || im.id}): ${feat.count} features at ${fw}x${fh}`);
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
  log(`${pairs.length}/${candidates.length} pairs have enough matches`);
  if (pairs.length === 0) throw new Error('No overlapping image pairs found. Take photos with more overlap and texture.');

  // 3. Structure from motion
  progress('sfm', 0, 'Estimating camera poses');
  const sfm = runSfM(frames, pairs, { pixelThreshold: 2.0, log });
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

  // 4. Dense depth
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
        f.depthGray = resizeGray(f.gray, f.width, f.height, dw, dh);
        f.depthRGBA = resizeRGBA(f.rgba, f.fullW, f.fullH, dw, dh);
        f.dw = dw; f.dh = dh;
        f.df = f.f * (dw / f.width); f.dcx = (f.cx + 0.5) * (dw / f.width) - 0.5; f.dcy = (f.cy + 0.5) * (dh / f.height) - 0.5;
      }
      const cam = sfm.cameras[idx];
      return { gray: f.depthGray, w: f.dw, h: f.dh, f: f.df, cx: f.dcx, cy: f.dcy, R: cam.R, t: cam.t, rgb: f.depthRGBA };
    };
    const ref = view(fr);
    const res = computeDepthMap(ref, nbs.map(view), { dmin, dmax, numPlanes: q.numPlanes, radius: q.radius, minZncc: preset.minZncc });
    let valid = 0;
    for (let i = 0; i < res.depth.length; i++) if (res.depth[i] > 0) valid++;
    log(`Frame ${fr}: depth from ${nbs.length} neighbours, ${(100 * valid / res.depth.length).toFixed(0)}% coverage, range ${dmin.toFixed(2)}-${dmax.toFixed(2)}`);
    depthViews[fr] = { ...ref, depth: res.depth, confidence: res.confidence };
  }
  const haveDepth = depthViews.filter((v) => v);
  if (haveDepth.length === 0) throw new Error('No depth maps could be computed. Add more overlapping photos.');

  progress('fusion', 0, 'Checking depth consistency');
  const filtered = filterDepthConsistency(depthViews, neighborIdx.map((nbs) => nbs), { relTol: 0.04, minAgree: 1 });
  depthViews.forEach((v, i) => { if (v) v.depth = filtered[i]; });

  // 5. Volume + fusion
  const dense = [];
  for (const v of depthViews) {
    if (!v) continue;
    const step = Math.max(1, Math.floor(Math.sqrt((v.w * v.h) / 4000)));
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
    }
  }
  if (dense.length < 300) throw new Error('Too few consistent depth samples to build a surface.');
  const vol = fitVolume(Float64Array.from(dense), q.voxelRes, { percentile: preset.percentile, margin: 0.06 });
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

  const result = {
    mesh: { positions, normals, colors, indices: mesh.indices },
    sparse: { positions: sparse, colors: sparseColors },
    cameras,
    stats: {
      images: images.length, registered: sfm.registeredCount, sparsePoints: nSparse,
      depthMaps: haveDepth.length, vertices: nv, triangles: mesh.indices.length / 3,
      seconds: (Date.now() - t0) / 1000, voxelSize: vol.voxelSize, volumeDims: Array.from(vol.dims),
    },
  };
  if (options.debug) result.debug = { depthViews, sfm, frames };
  progress('done', 1, `Done: ${result.stats.triangles} triangles in ${result.stats.seconds.toFixed(1)}s`);
  return result;
}
