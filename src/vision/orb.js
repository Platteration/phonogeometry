// ORB-style features: multi-scale FAST corners + oriented BRIEF descriptors (256 bits).
import { detectFAST } from './fast.js';
import { gaussianBlur, resizeGray } from './image.js';

const PATCH = 31;
const HALF = 15;
const N_BITS = 256;

// Deterministic BRIEF sampling pattern (Gaussian-distributed pairs inside the patch).
function makePattern() {
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pat = new Int8Array(N_BITS * 4);
  const clamp = (v) => Math.max(-HALF + 2, Math.min(HALF - 2, Math.round(v)));
  for (let i = 0; i < N_BITS; i++) {
    pat[i * 4] = clamp(gauss() * HALF / 2.5);
    pat[i * 4 + 1] = clamp(gauss() * HALF / 2.5);
    pat[i * 4 + 2] = clamp(gauss() * HALF / 2.5);
    pat[i * 4 + 3] = clamp(gauss() * HALF / 2.5);
  }
  return pat;
}
const PATTERN = makePattern();

// Precomputed circular patch row extents for the intensity centroid.
const UMAX = (() => {
  const u = new Int32Array(HALF + 1);
  for (let v = 0; v <= HALF; v++) u[v] = Math.floor(Math.sqrt(HALF * HALF - v * v));
  return u;
})();

function orientation(img, w, x, y) {
  let m01 = 0, m10 = 0;
  for (let v = -HALF; v <= HALF; v++) {
    const d = UMAX[Math.abs(v)];
    const row = (y + v) * w + x;
    for (let u = -d; u <= d; u++) {
      const val = img[row + u];
      m10 += u * val;
      m01 += v * val;
    }
  }
  return Math.atan2(m01, m10);
}

function describe(img, w, x, y, angle, out, offset) {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let byte = 0; byte < 32; byte++) {
    let val = 0;
    for (let bit = 0; bit < 8; bit++) {
      const i = (byte * 8 + bit) * 4;
      const ax = PATTERN[i], ay = PATTERN[i + 1], bx = PATTERN[i + 2], by = PATTERN[i + 3];
      const rax = Math.round(c * ax - s * ay), ray = Math.round(s * ax + c * ay);
      const rbx = Math.round(c * bx - s * by), rby = Math.round(s * bx + c * by);
      const pa = img[(y + ray) * w + x + rax];
      const pb = img[(y + rby) * w + x + rbx];
      if (pa < pb) val |= 1 << bit;
    }
    out[offset + byte] = val;
  }
}

/**
 * Extract ORB-like features.
 * @param {Float32Array} gray image (0..255)
 * @returns {{keypoints: Float32Array, scores: Float32Array, descriptors: Uint8Array, count: number}}
 *   keypoints are [x0,y0,x1,y1,...] in the input image coordinates.
 */
export function extractORB(gray, w, h, opts = {}) {
  const maxFeatures = opts.maxFeatures ?? 1200;
  const levels = opts.levels ?? 4;
  const scaleFactor = opts.scaleFactor ?? 1.25;
  const threshold = opts.threshold ?? 18;
  const gridCells = opts.gridCells ?? 8;

  const all = [];
  let scale = 1;
  let lvlImg = gray, lw = w, lh = h;
  for (let lvl = 0; lvl < levels; lvl++) {
    if (lvl > 0) {
      scale *= scaleFactor;
      const nw = Math.round(w / scale), nh = Math.round(h / scale);
      if (nw < PATCH * 3 || nh < PATCH * 3) break;
      lvlImg = resizeGray(gray, w, h, nw, nh);
      lw = nw; lh = nh;
    }
    const blurred = gaussianBlur(lvlImg, lw, lh, 1.2);
    const corners = detectFAST(lvlImg, lw, lh, threshold, HALF + 2);
    for (const c of corners) {
      all.push({ x: c.x, y: c.y, score: c.score, lvl, scale, img: blurred, lw, lh });
    }
  }

  // Distribute keypoints over a grid so that matching is not dominated by one texture patch.
  const perCell = Math.max(4, Math.ceil(maxFeatures / (gridCells * gridCells)));
  const cells = new Map();
  for (const kp of all) {
    const gx = Math.min(gridCells - 1, Math.floor((kp.x * kp.scale) / w * gridCells));
    const gy = Math.min(gridCells - 1, Math.floor((kp.y * kp.scale) / h * gridCells));
    const key = gy * gridCells + gx;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(kp);
  }
  let selected = [];
  for (const list of cells.values()) {
    list.sort((a, b) => b.score - a.score);
    selected.push(...list.slice(0, perCell));
  }
  selected.sort((a, b) => b.score - a.score);
  if (selected.length > maxFeatures) selected = selected.slice(0, maxFeatures);

  const count = selected.length;
  const keypoints = new Float32Array(count * 2);
  const scores = new Float32Array(count);
  const descriptors = new Uint8Array(count * 32);
  for (let i = 0; i < count; i++) {
    const kp = selected[i];
    const ang = orientation(kp.img, kp.lw, kp.x, kp.y);
    describe(kp.img, kp.lw, kp.x, kp.y, ang, descriptors, i * 32);
    keypoints[i * 2] = (kp.x + 0.5) * kp.scale - 0.5;
    keypoints[i * 2 + 1] = (kp.y + 0.5) * kp.scale - 0.5;
    scores[i] = kp.score;
  }
  return { keypoints, scores, descriptors, count };
}
