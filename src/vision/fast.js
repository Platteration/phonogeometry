// FAST-9 corner detector with non-maximum suppression.

const CIRCLE = [
  [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

/**
 * Detect FAST-9 corners.
 * @param {Float32Array} img grayscale image
 * @returns {{x:number,y:number,score:number}[]} corners with NMS applied
 */
export function detectFAST(img, w, h, threshold = 20, border = 16) {
  const offsets = CIRCLE.map(([dx, dy]) => dy * w + dx);
  const scores = new Float32Array(w * h);
  const candidates = [];
  const N = 9;
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const idx = y * w + x;
      const p = img[idx];
      const hi = p + threshold, lo = p - threshold;
      // Quick rejection: pixels 0, 4, 8, 12
      let nb = 0, nd = 0;
      for (let k = 0; k < 16; k += 4) {
        const v = img[idx + offsets[k]];
        if (v > hi) nb++;
        else if (v < lo) nd++;
      }
      if (nb < 3 && nd < 3) continue;
      // Full contiguous arc test (wrap-around by scanning 16 + N)
      let brighter = 0, darker = 0, isCorner = false;
      for (let k = 0; k < 16 + N; k++) {
        const v = img[idx + offsets[k & 15]];
        if (v > hi) { brighter++; darker = 0; if (brighter >= N) { isCorner = true; break; } }
        else if (v < lo) { darker++; brighter = 0; if (darker >= N) { isCorner = true; break; } }
        else { brighter = 0; darker = 0; }
      }
      if (!isCorner) continue;
      // Score: sum of absolute differences beyond the threshold
      let s = 0;
      for (let k = 0; k < 16; k++) {
        const d = Math.abs(img[idx + offsets[k]] - p) - threshold;
        if (d > 0) s += d;
      }
      scores[idx] = s;
      candidates.push(idx);
    }
  }
  const out = [];
  for (const idx of candidates) {
    const s = scores[idx];
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (scores[idx + dy * w + dx] > s) { isMax = false; break; }
      }
    }
    if (isMax) out.push({ x: idx % w, y: Math.floor(idx / w), score: s });
  }
  return out;
}
