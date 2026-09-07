# Phonogeometry

Progressive web app that captures from every camera on a phone at once and reconstructs
textured 3D meshes on-device. Plain ES modules, no build step, no runtime dependencies
(three.js is vendored in `vendor/three`).

## Commands

- `npm test` runs the node:test suites in `test/` (synthetic scenes with ground truth).
- `npm start` serves over HTTP on :8080 (desktop development, photo import only).
- `npm run start:https` serves over HTTPS with a self-signed certificate (phones need a
  secure origin for camera access).
- Browser-only checks (GPU plane sweep) live in `test/browser/`; open them through the dev
  server. Headless Chromium via Playwright works with fake camera devices
  (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`).

## Layout

- `src/app.js` UI and flow; `src/camera/` device discovery, capture, intrinsics, EXIF;
  `src/storage.js` IndexedDB shot persistence.
- `src/pipeline/reconstruct.js` orchestrates the pipeline; `worker.js` is the Web Worker entry.
- The camera rig (`sfm.js`) ties frames captured in the same shot together: `rigKey` names the
  physical camera, `shotIndex` the moment. It fills gaps and merges a camera that shares no
  features with the rest by aligning camera paths. Both merge checks (rig-rotation spread,
  path agreement against scene scale) must keep failing closed: never merge on a weak fit.
- `src/vision/` numerics: `linalg` (SVD, Cholesky, Rodrigues), `fast`/`orb`/`match`
  features, `geometry` (essential matrix, PnP, triangulation, distortion), `sfm`, `ba`
  (sparse LM with Schur complement, per-camera focal and k1), `planeSweep` (CPU) and
  `planeSweepGPU` (WebGL2, identical semantics).
- `src/mesh/` TSDF, surface nets, mesh utilities, exporters (GLB/PLY/OBJ/point PLY).

## Measured behaviour worth knowing

- Relaxing the descriptor ratio test doubles the image pairs that pass geometric verification
  but wrecks the reconstruction, because the extra wrong matches chain unrelated features into
  one track. Pairwise metrics mislead here: judge matching changes end to end.
- One frame blurred by three pixels roughly halves the number of frames that register, so
  frames are scored for sharpness and flagged rather than silently ruining a scan.
- Balanced quality is markedly more accurate than fast on the same input, not just denser.

## Conventions

- Camera model: `Xc = R Xw + t`, pixel = `c + f * distort(Xc.xy / Xc.z)` with
  `distort(x) = x (1 + k1 |x|^2)`. World frame = first registered camera; results are
  flipped to y-up (`x, -y, -z`) only when building the final output.
- Matrices are flat row-major Float64Arrays with explicit dimensions.
- Every pipeline change should keep `npm test` green; add a synthetic-scene test when
  adding a stage. Keep the CPU and GPU plane sweeps behaviourally identical.
- Do not add build tooling or npm dependencies without a strong reason: the app is meant to
  be deployable by copying the folder to any static HTTPS host.
