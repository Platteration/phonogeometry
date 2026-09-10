// Mesh post-processing: normals, smoothing, component filtering, compaction.

export function computeNormals(positions, indices) {
  const n = positions.length / 3;
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
  }
  return normals;
}

function buildAdjacency(nVerts, indices) {
  const adj = Array.from({ length: nVerts }, () => new Set());
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  return adj;
}

/** Taubin-style smoothing (lambda then negative mu) to avoid shrinkage. */
export function smoothMesh(positions, indices, iterations = 3, lambda = 0.5, mu = -0.53) {
  const n = positions.length / 3;
  const adj = buildAdjacency(n, indices);
  let cur = Float32Array.from(positions);
  const next = new Float32Array(n * 3);
  const step = (factor) => {
    for (let i = 0; i < n; i++) {
      const nb = adj[i];
      if (nb.size === 0) { next[i * 3] = cur[i * 3]; next[i * 3 + 1] = cur[i * 3 + 1]; next[i * 3 + 2] = cur[i * 3 + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { sx += cur[j * 3]; sy += cur[j * 3 + 1]; sz += cur[j * 3 + 2]; }
      const k = nb.size;
      next[i * 3] = cur[i * 3] + factor * (sx / k - cur[i * 3]);
      next[i * 3 + 1] = cur[i * 3 + 1] + factor * (sy / k - cur[i * 3 + 1]);
      next[i * 3 + 2] = cur[i * 3 + 2] + factor * (sz / k - cur[i * 3 + 2]);
    }
    cur.set(next);
  };
  for (let it = 0; it < iterations; it++) { step(lambda); step(mu); }
  return cur;
}

/**
 * Remove connected components with fewer than `minFraction` of all triangles
 * (and always keep the largest component).
 *
 * Pass any per-vertex attributes that must survive. Omitting them silently drops colours and
 * normals: the pipeline gets away with that today only because it calls this before colours
 * exist and recomputes normals afterwards, so anything cleaning a finished mesh must pass them.
 */
export function removeSmallComponents(positions, indices, minFraction = 0.02, attributes = {}) {
  const n = positions.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(indices[i]), b = find(indices[i + 1]), c = find(indices[i + 2]);
    if (a !== b) parent[b] = a;
    if (find(c) !== a) parent[find(c)] = a;
  }
  const triCount = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const r = find(indices[i]);
    triCount.set(r, (triCount.get(r) || 0) + 1);
  }
  const total = indices.length / 3;
  let largest = -1, largestCount = 0;
  for (const [r, c] of triCount) if (c > largestCount) { largestCount = c; largest = r; }
  const keep = new Set();
  for (const [r, c] of triCount) if (c >= minFraction * total || r === largest) keep.add(r);
  const kept = [];
  for (let i = 0; i < indices.length; i += 3) if (keep.has(find(indices[i]))) kept.push(indices[i], indices[i + 1], indices[i + 2]);
  return compactMesh(positions, Uint32Array.from(kept), attributes);
}

/** Drop unreferenced vertices and remap indices. Extra per-vertex attributes are remapped too. */
export function compactMesh(positions, indices, attributes = {}) {
  const n = positions.length / 3;
  const map = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < indices.length; i++) if (map[indices[i]] < 0) map[indices[i]] = count++;
  const newPos = new Float32Array(count * 3);
  const newAttrs = {};
  for (const [k, arr] of Object.entries(attributes)) newAttrs[k] = new arr.constructor(count * (arr.length / n));
  for (let i = 0; i < n; i++) {
    const m = map[i];
    if (m < 0) continue;
    newPos[m * 3] = positions[i * 3]; newPos[m * 3 + 1] = positions[i * 3 + 1]; newPos[m * 3 + 2] = positions[i * 3 + 2];
    for (const [k, arr] of Object.entries(attributes)) {
      const stride = arr.length / n;
      for (let s = 0; s < stride; s++) newAttrs[k][m * stride + s] = arr[i * stride + s];
    }
  }
  const newIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) newIdx[i] = map[indices[i]];
  return { positions: newPos, indices: newIdx, ...newAttrs };
}

/** Euler characteristic V - E + F (2 for a closed genus-0 surface). */
export function eulerCharacteristic(positions, indices) {
  const edges = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      edges.add(a < b ? a * 4294967296 + b : b * 4294967296 + a);
    }
  }
  return positions.length / 3 - edges.size + indices.length / 3;
}
