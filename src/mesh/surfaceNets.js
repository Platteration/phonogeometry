// Naive surface nets (Lysenko) for extracting a triangle mesh from a signed distance grid.
// Cells with any unobserved corner (weight == 0) are skipped so unseen space stays open.

const CUBE_EDGES = [];
for (let i = 0; i < 8; i++) {
  for (let axis = 0; axis < 3; axis++) {
    const j = i | (1 << axis);
    if (j !== i) CUBE_EDGES.push([i, j]);
  }
}

/**
 * @param sdf Float32Array values on a (nx*ny*nz) grid, x fastest
 * @param dims [nx,ny,nz]
 * @param mask optional Uint8Array/Float32Array; entries <= 0 mark unknown voxels
 * @returns {{positions: Float32Array, indices: Uint32Array}} positions in grid units
 */
export function surfaceNets(sdf, dims, mask = null) {
  const [nx, ny, nz] = dims;
  const positions = [];
  const indices = [];
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const corners = new Float64Array(8);
  const idx = (x, y, z) => (z * ny + y) * nx + x;

  for (let z = 0; z < nz - 1; z++) {
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        let sign = 0, unknown = false;
        for (let c = 0; c < 8; c++) {
          const i = idx(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
          if (mask && !(mask[i] > 0)) { unknown = true; break; }
          const v = sdf[i];
          corners[c] = v;
          if (v < 0) sign |= 1 << c;
        }
        if (unknown || sign === 0 || sign === 0xff) continue;
        // Vertex = mean of the edge crossings
        let vx = 0, vy = 0, vz = 0, count = 0;
        for (const [a, b] of CUBE_EDGES) {
          const va = corners[a], vb = corners[b];
          if ((va < 0) === (vb < 0)) continue;
          const tt = va / (va - vb);
          const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
          const bx = b & 1, by = (b >> 1) & 1, bz = (b >> 2) & 1;
          vx += ax + (bx - ax) * tt; vy += ay + (by - ay) * tt; vz += az + (bz - az) * tt;
          count++;
        }
        const ci = idx(x, y, z);
        cellVert[ci] = positions.length / 3;
        positions.push(x + vx / count, y + vy / count, z + vz / count);
        // Faces: for each axis edge from corner 0 with a sign change
        for (let axis = 0; axis < 3; axis++) {
          const c1 = 1 << (1 << axis); // bit of corner (1 << axis)
          if (((sign & 1) !== 0) === ((sign & c1) !== 0)) continue;
          const u = (axis + 1) % 3, v = (axis + 2) % 3;
          const pos = [x, y, z];
          if (pos[u] === 0 || pos[v] === 0) continue;
          const du = [0, 0, 0], dv = [0, 0, 0];
          du[u] = 1; dv[v] = 1;
          const v0 = cellVert[ci];
          const v1 = cellVert[idx(x - du[0], y - du[1], z - du[2])];
          const v2 = cellVert[idx(x - du[0] - dv[0], y - du[1] - dv[1], z - du[2] - dv[2])];
          const v3 = cellVert[idx(x - dv[0], y - dv[1], z - dv[2])];
          if (v1 < 0 || v2 < 0 || v3 < 0) continue;
          if (sign & 1) indices.push(v0, v1, v2, v0, v2, v3);
          else indices.push(v0, v3, v2, v0, v2, v1);
        }
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
