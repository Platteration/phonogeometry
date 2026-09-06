import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surfaceNets } from '../src/mesh/surfaceNets.js';
import { TSDFVolume, fitVolume } from '../src/mesh/tsdf.js';
import { computeNormals, smoothMesh, removeSmallComponents, eulerCharacteristic, compactMesh } from '../src/mesh/meshUtils.js';
import { toPLY, toOBJ, toGLB } from '../src/mesh/exporters.js';
import { lookAt } from './helpers.js';

function sphereGrid(n, r) {
  const sdf = new Float32Array(n * n * n);
  const c = (n - 1) / 2;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    sdf[(z * n + y) * n + x] = Math.hypot(x - c, y - c, z - c) - r;
  }
  return sdf;
}

test('surface nets extracts a closed sphere with outward normals', () => {
  const n = 32, r = 10;
  const mesh = surfaceNets(sphereGrid(n, r), [n, n, n]);
  assert.ok(mesh.indices.length > 1000);
  assert.equal(eulerCharacteristic(mesh.positions, mesh.indices), 2, 'closed genus-0 surface');
  const c = (n - 1) / 2;
  const normals = computeNormals(mesh.positions, mesh.indices);
  let outward = 0;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const p = [mesh.positions[i * 3] - c, mesh.positions[i * 3 + 1] - c, mesh.positions[i * 3 + 2] - c];
    const rad = Math.hypot(...p);
    assert.ok(Math.abs(rad - r) < 0.5, `radius ${rad}`);
    if (p[0] * normals[i * 3] + p[1] * normals[i * 3 + 1] + p[2] * normals[i * 3 + 2] > 0) outward++;
  }
  assert.ok(outward > 0.99 * mesh.positions.length / 3, 'normals point outward (positive SDF outside)');
});

test('TSDF fusion of synthetic sphere depth maps yields a sphere mesh', () => {
  const R = 0.5, f = 300, w = 200, h = 200, cx = 100, cy = 100;
  const views = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    const elev = (k % 2 ? 0.4 : -0.4);
    const cam = lookAt([Math.cos(ang) * 2.5, elev, Math.sin(ang) * 2.5], [0, 0, 0]);
    const depth = new Float32Array(w * h);
    const Rm = cam.R, t = cam.t;
    const C = [-(Rm[0] * t[0] + Rm[3] * t[1] + Rm[6] * t[2]), -(Rm[1] * t[0] + Rm[4] * t[1] + Rm[7] * t[2]), -(Rm[2] * t[0] + Rm[5] * t[1] + Rm[8] * t[2])];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dc = [(x - cx) / f, (y - cy) / f, 1];
      const dw = [Rm[0] * dc[0] + Rm[3] * dc[1] + Rm[6] * dc[2], Rm[1] * dc[0] + Rm[4] * dc[1] + Rm[7] * dc[2], Rm[2] * dc[0] + Rm[5] * dc[1] + Rm[8] * dc[2]];
      const b = C[0] * dw[0] + C[1] * dw[1] + C[2] * dw[2], cc = C[0] ** 2 + C[1] ** 2 + C[2] ** 2 - R * R, aa = dw[0] ** 2 + dw[1] ** 2 + dw[2] ** 2;
      const disc = b * b - aa * cc;
      if (disc > 0) { const tt = (-b - Math.sqrt(disc)) / aa; if (tt > 0) depth[y * w + x] = tt; }
    }
    views.push({ depth, w, h, f, cx, cy, R: cam.R, t: cam.t });
  }
  // Points for fitting the volume
  const pts = [];
  for (const v of views) for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 7) {
    const d = v.depth[y * w + x]; if (!(d > 0)) continue;
    const Xc = [((x - cx) / f) * d, ((y - cy) / f) * d, d];
    const Rm = v.R, t = v.t;
    const Xw = [Rm[0] * (Xc[0] - t[0]) + Rm[3] * (Xc[1] - t[1]) + Rm[6] * (Xc[2] - t[2]), Rm[1] * (Xc[0] - t[0]) + Rm[4] * (Xc[1] - t[1]) + Rm[7] * (Xc[2] - t[2]), Rm[2] * (Xc[0] - t[0]) + Rm[5] * (Xc[1] - t[1]) + Rm[8] * (Xc[2] - t[2])];
    pts.push(...Xw);
  }
  const vol = fitVolume(Float64Array.from(pts), 64);
  const tsdf = new TSDFVolume(vol.origin, vol.dims, vol.voxelSize, vol.voxelSize * 3);
  for (const v of views) tsdf.integrate(v);
  const mesh = surfaceNets(tsdf.tsdf, Array.from(tsdf.dims), tsdf.weight);
  assert.ok(mesh.indices.length > 500, `triangles ${mesh.indices.length / 3}`);
  let maxErr = 0;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const p = [0, 1, 2].map((k) => vol.origin[k] + mesh.positions[i * 3 + k] * vol.voxelSize);
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(...p) - R));
  }
  assert.ok(maxErr < vol.voxelSize * 2, `max radial error ${maxErr} (voxel ${vol.voxelSize})`);
  const smoothed = smoothMesh(mesh.positions, mesh.indices, 2);
  assert.equal(smoothed.length, mesh.positions.length);
});

test('small component removal keeps the main body', () => {
  const n = 24;
  const sdf = sphereGrid(n, 6);
  // add a tiny second blob (about 7% of the triangles)
  for (let z = 2; z < 5; z++) for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) sdf[(z * n + y) * n + x] = -0.5;
  const mesh = surfaceNets(sdf, [n, n, n]);
  const cleaned = removeSmallComponents(mesh.positions, mesh.indices, 0.1);
  assert.ok(cleaned.indices.length < mesh.indices.length);
  assert.equal(eulerCharacteristic(cleaned.positions, cleaned.indices), 2);
  const c = compactMesh(mesh.positions, mesh.indices, { colors: new Float32Array(mesh.positions.length) });
  assert.equal(c.colors.length, c.positions.length);
});

test('exporters produce well-formed PLY, OBJ and GLB', () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    normals: new Float32Array(12).fill(0.577),
    colors: new Float32Array(12).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]),
  };
  const ply = toPLY(mesh);
  const plyHead = new TextDecoder().decode(new Uint8Array(ply, 0, 400));
  assert.ok(plyHead.startsWith('ply\nformat binary_little_endian'));
  assert.ok(plyHead.includes('element vertex 4') && plyHead.includes('element face 4'));
  const headerLen = new TextEncoder().encode(plyHead.slice(0, plyHead.indexOf('end_header\n') + 11)).length;
  assert.equal(ply.byteLength, headerLen + 4 * 27 + 4 * 13);
  const obj = toOBJ(mesh);
  assert.equal(obj.split('\n').filter((l) => l.startsWith('v ')).length, 4);
  assert.equal(obj.split('\n').filter((l) => l.startsWith('f ')).length, 4);
  const glb = toGLB(mesh);
  const dv = new DataView(glb);
  assert.equal(dv.getUint32(0, true), 0x46546c67);
  assert.equal(dv.getUint32(8, true), glb.byteLength);
  assert.equal(glb.byteLength % 4, 0);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)));
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.accessors[0].count, 4);
  assert.deepEqual(json.accessors[0].max, [1, 1, 1]);
  const binLen = dv.getUint32(20 + jsonLen, true);
  assert.equal(json.buffers[0].byteLength, binLen);
  assert.equal(20 + jsonLen + 8 + binLen, glb.byteLength);
});
