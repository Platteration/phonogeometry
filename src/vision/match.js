// Brute-force Hamming matching of 256-bit descriptors with ratio test and cross-check.

function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function asWords(desc) {
  if (desc.byteOffset % 4 !== 0) desc = new Uint8Array(desc);
  return new Uint32Array(desc.buffer, desc.byteOffset, desc.byteLength >> 2);
}

/**
 * Match descriptors A (na x 32 bytes) against B (nb x 32 bytes).
 *
 * Filtering is Lowe's ratio test, a Hamming distance bound and a mutual nearest-neighbour
 * check. Relaxing the ratio test roughly doubles the number of image pairs that pass
 * geometric verification, which looks like a win pair by pair, but it was measured to wreck
 * the reconstruction: the extra wrong matches chain unrelated features into the same track
 * and the track graph collapses. Keep it strict.
 *
 * @returns {Int32Array} flat pairs [ia, ib, ia, ib, ...]
 */
export function matchDescriptors(descA, na, descB, nb, opts = {}) {
  const ratio = opts.ratio ?? 0.8;
  const maxDist = opts.maxDist ?? 64;
  const crossCheck = opts.crossCheck !== false;
  const A = asWords(descA), B = asWords(descB);
  const bestB = new Int32Array(na).fill(-1);
  const bestBd = new Int32Array(na).fill(1e9);
  const secondBd = new Int32Array(na).fill(1e9);
  const bestA = new Int32Array(nb).fill(-1);
  const bestAd = new Int32Array(nb).fill(1e9);
  // Abandoning a candidate part way through, once its partial distance already rules it out,
  // was tried and made no measurable difference: the extra branch costs about what the
  // skipped words save. Left as the plain full comparison.
  for (let i = 0; i < na; i++) {
    const a0 = A[i * 8], a1 = A[i * 8 + 1], a2 = A[i * 8 + 2], a3 = A[i * 8 + 3];
    const a4 = A[i * 8 + 4], a5 = A[i * 8 + 5], a6 = A[i * 8 + 6], a7 = A[i * 8 + 7];
    let b1 = 1e9, b2 = 1e9, bj = -1;
    for (let j = 0, o = 0; j < nb; j++, o += 8) {
      const d =
        popcount32(a0 ^ B[o]) + popcount32(a1 ^ B[o + 1]) + popcount32(a2 ^ B[o + 2]) +
        popcount32(a3 ^ B[o + 3]) + popcount32(a4 ^ B[o + 4]) + popcount32(a5 ^ B[o + 5]) +
        popcount32(a6 ^ B[o + 6]) + popcount32(a7 ^ B[o + 7]);
      if (d < b1) { b2 = b1; b1 = d; bj = j; }
      else if (d < b2) b2 = d;
      if (d < bestAd[j]) { bestAd[j] = d; bestA[j] = i; }
    }
    bestB[i] = bj; bestBd[i] = b1; secondBd[i] = b2;
  }
  const out = [];
  for (let i = 0; i < na; i++) {
    const j = bestB[i];
    if (j < 0 || bestBd[i] > maxDist) continue;
    if (ratio < 1 && bestBd[i] > ratio * secondBd[i]) continue;
    if (crossCheck && bestA[j] !== i) continue;
    out.push(i, j);
  }
  return Int32Array.from(out);
}

/** Hamming distance between two 32-byte descriptors. */
export function hamming(descA, ia, descB, ib) {
  let d = 0;
  for (let k = 0; k < 32; k++) d += popcount32(descA[ia * 32 + k] ^ descB[ib * 32 + k]);
  return d;
}
