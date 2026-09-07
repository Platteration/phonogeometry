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
- How far apart consecutive shots may be is set by how many corners are detected, and the
  corner threshold matters more than the feature cap. At 1000 features and threshold 18 the
  geometry gives out past about 16 degrees of viewpoint change; at 3000 features and
  threshold 12 it survives 25 degrees, surface error improves several times over, and a
  blurred frame stops breaking the scan. Matching costs more per pair, which is paid back by
  needing fewer shots.
- Frames are still scored for sharpness and flagged, because blur remains a real failure
  cause on a phone even though the pipeline now tolerates it better.
- Balanced quality is markedly more accurate than fast on the same input, not just denser.

## Memory

The worker holds the whole scan at once, so per-frame buffers are released as soon as their
smaller derivatives exist: the depth-resolution copies are made during feature extraction and
the full-size image and greyscale are dropped there, and `releaseInputs` lets the worker free
the transferred pixel buffers as it goes (tests reuse their images and so must not set it).
Dense samples go straight into typed arrays. Forty frames at Balanced peak near 250 MB; keep
new per-frame state small or free it explicitly.

## Conventions

- Camera model: `Xc = R Xw + t`, pixel = `c + f * distort(Xc.xy / Xc.z)` with
  `distort(x) = x (1 + k1 |x|^2)`. World frame = first registered camera; results are
  flipped to y-up (`x, -y, -z`) only when building the final output.
- Matrices are flat row-major Float64Arrays with explicit dimensions.
- Every pipeline change should keep `npm test` green; add a synthetic-scene test when
  adding a stage. Keep the CPU and GPU plane sweeps behaviourally identical.
- Do not add build tooling or npm dependencies without a strong reason: the app is meant to
  be deployable by copying the folder to any static HTTPS host.
