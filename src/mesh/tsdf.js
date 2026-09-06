// Truncated signed distance function volume with colour, fused from depth maps.

export class TSDFVolume {
  /**
   * @param origin [x,y,z] world position of voxel (0,0,0) centre
   * @param dims [nx,ny,nz]
   * @param voxelSize edge length of a voxel
   * @param trunc truncation distance (world units)
   */
  constructor(origin, dims, voxelSize, trunc) {
    this.origin = Float64Array.from(origin);
    this.dims = Int32Array.from(dims);
    this.voxelSize = voxelSize;
    this.trunc = trunc;
    const n = dims[0] * dims[1] * dims[2];
    this.tsdf = new Float32Array(n).fill(1);
    this.weight = new Float32Array(n);
    this.color = new Float32Array(n * 3);
  }

  index(x, y, z) {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }

  /**
   * Integrate one depth map.
   * @param view {depth: Float32Array, w, h, f, cx, cy, R, t, rgb?: Uint8ClampedArray (RGBA at depth resolution)}
   */
  integrate(view, opts = {}) {
    const { depth, w, h, f, cx, cy, R, t, rgb } = view;
    const maxWeight = opts.maxWeight ?? 64;
    const [nx, ny, nz] = this.dims;
    const vs = this.voxelSize, trunc = this.trunc;
    const ox = this.origin[0], oy = this.origin[1], oz = this.origin[2];
    for (let z = 0; z < nz; z++) {
      const wz = oz + z * vs;
      for (let y = 0; y < ny; y++) {
        const wy = oy + y * vs;
        // incremental camera coordinates along x
        let cxw = R[0] * ox + R[1] * wy + R[2] * wz + t[0];
        let cyw = R[3] * ox + R[4] * wy + R[5] * wz + t[1];
        let czw = R[6] * ox + R[7] * wy + R[8] * wz + t[2];
        const dx0 = R[0] * vs, dx1 = R[3] * vs, dx2 = R[6] * vs;
        let idx = this.index(0, y, z);
        for (let x = 0; x < nx; x++, idx++, cxw += dx0, cyw += dx1, czw += dx2) {
          if (czw <= 1e-6) continue;
          const px = Math.round(f * cxw / czw + cx), py = Math.round(f * cyw / czw + cy);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const d = depth[py * w + px];
          if (!(d > 0)) continue;
          const sdf = d - czw;
          if (sdf < -trunc) continue; // behind the surface, unobserved
          const tsdf = Math.min(1, sdf / trunc);
          const wOld = this.weight[idx];
          const wNew = Math.min(maxWeight, wOld + 1);
          this.tsdf[idx] = (this.tsdf[idx] * wOld + tsdf) / wNew;
          if (rgb && Math.abs(sdf) < trunc) {
            const o = (py * w + px) * 4, c = idx * 3;
            this.color[c] = (this.color[c] * wOld + rgb[o]) / wNew;
            this.color[c + 1] = (this.color[c + 1] * wOld + rgb[o + 1]) / wNew;
            this.color[c + 2] = (this.color[c + 2] * wOld + rgb[o + 2]) / wNew;
          }
          this.weight[idx] = wNew;
        }
      }
    }
  }

  /** Trilinear colour lookup at a world position, returns [r,g,b] in 0..255. */
  sampleColor(wx, wy, wz) {
    const vs = this.voxelSize;
    const gx = (wx - this.origin[0]) / vs, gy = (wy - this.origin[1]) / vs, gz = (wz - this.origin[2]) / vs;
    const x0 = Math.max(0, Math.min(this.dims[0] - 1, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(this.dims[1] - 1, Math.floor(gy)));
    const z0 = Math.max(0, Math.min(this.dims[2] - 1, Math.floor(gz)));
    let r = 0, g = 0, b = 0, wsum = 0;
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const x = Math.min(this.dims[0] - 1, x0 + dx), y = Math.min(this.dims[1] - 1, y0 + dy), z = Math.min(this.dims[2] - 1, z0 + dz);
      const idx = this.index(x, y, z);
      if (this.weight[idx] <= 0) continue;
      const wgt = (1 - Math.abs(gx - x)) * (1 - Math.abs(gy - y)) * (1 - Math.abs(gz - z));
      if (wgt <= 0) continue;
      r += this.color[idx * 3] * wgt; g += this.color[idx * 3 + 1] * wgt; b += this.color[idx * 3 + 2] * wgt; wsum += wgt;
    }
    if (wsum === 0) return [160, 160, 160];
    return [r / wsum, g / wsum, b / wsum];
  }
}

/**
 * Choose a volume that tightly bounds the given points (robust percentiles) at a
 * resolution such that the longest axis has `resolution` voxels.
 */
export function fitVolume(points, resolution, opts = {}) {
  const n = points.length / 3;
  if (n === 0) return null;
  const lo = opts.percentile ?? 0.02, hi = 1 - lo;
  const mins = [], maxs = [];
  for (let a = 0; a < 3; a++) {
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = points[i * 3 + a];
    arr.sort();
    mins.push(arr[Math.floor(lo * (n - 1))]);
    maxs.push(arr[Math.floor(hi * (n - 1))]);
  }
  const margin = opts.margin ?? 0.08;
  const size = [0, 1, 2].map((a) => Math.max(1e-6, maxs[a] - mins[a]));
  const longest = Math.max(...size);
  const voxelSize = (longest * (1 + 2 * margin)) / resolution;
  const dims = size.map((s) => Math.max(8, Math.ceil((s * (1 + 2 * margin)) / voxelSize) + 2));
  const origin = [0, 1, 2].map((a) => mins[a] - size[a] * margin - voxelSize);
  return { origin, dims, voxelSize };
}
