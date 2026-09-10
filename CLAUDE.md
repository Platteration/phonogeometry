# Phonogeometry

Progressive web app that captures from every camera on a phone at once and reconstructs
textured 3D meshes on-device. Plain ES modules, no build step, no runtime dependencies
(three.js is vendored in `vendor/three`).

## Commands

- `npm test` runs the node:test suites in `test/` (synthetic scenes with ground truth).
- `npm start` serves over HTTP on :8080 (desktop development, photo import only).
- `npm run start:https` serves over HTTPS with a self-signed certificate (phones need a
  secure origin for camera access).
- `npm run test:browser` runs the application end to end in Chromium (multi-camera capture, a
  good scan, a hopeless one, exports, reload, offline). `test/browser/fakeCameras.mjs` stands
  in a phone with three lenses and an adjustable limit on how many can stream at once, which
  is the only way to exercise the capture path: Chromium's own fake device provides one
  camera. It starts its own server and renders its own
  photographs, and skips itself when Playwright is absent, so it is safe to run anywhere.
  The GPU plane sweep check is a page, `test/browser/index.html`, opened through the dev
  server. Offline behaviour has to be tested over `http://localhost`, which browsers count as
  a secure context: a self-signed certificate blocks service worker registration outright, so
  the HTTPS dev server cannot exercise it. Headless Chromium via Playwright works with fake camera devices
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
- Matching is the dominant cost on a long scan and it grew, not shrank, when the feature
  settings were raised: a forty-frame Balanced scan spends about a minute there on a laptop.
  Cutting features back to 2000 halves that but loses the hardest inputs (the worst degraded
  case goes from 0.025 to 0.170 surface error), and 1500 fails to register them at all, so
  the cost is being paid deliberately. Fewer candidate pairs, not cheaper comparisons, is the
  lever that works: an early-exit inner loop was tried and measured no faster.
- How far apart consecutive shots may be is set by how many corners are detected, and the
  corner threshold matters more than the feature cap. At 1000 features and threshold 18 the
  geometry gives out past about 16 degrees of viewpoint change; at 3000 features and
  threshold 12 it survives 25 degrees, surface error improves several times over, and a
  blurred frame stops breaking the scan. Matching costs more per pair, which is paid back by
  needing fewer shots.
- Frames are still scored for sharpness and flagged, because blur remains a real failure
  cause on a phone even though the pipeline now tolerates it better.
- Balanced quality is markedly more accurate than fast on the same input, not just denser.
- The plane sweep's confidence map really does predict errors: on a synthetic room the less
  confident half of the accepted depths is wrong 11.7% of the time against 0.5% for the
  confident half. Acting on it still buys nothing. The cross-view consistency check cuts that
  11.7% to 4.7% on its own, and averaging over views outvotes what remains, so both weighting
  fusion by confidence and rejecting low-confidence depths were measured and left surface
  error unchanged (rejection merely cost three to six percent of the triangles). Tested down
  to four views, where fusion has fewest votes to spare. Do not spend time here again without
  a scenario that defeats the consistency check.
- Colour and depth want different resolutions, and colour is no longer sampled from the depth
  copy. Measured on the synthetic object, retained contrast against the photographs: 83% when
  vertex colours came from the volume fed by the 240 px depth copy, 86% from a 640 px colour
  copy, 93% projecting each vertex into a 480 px colour copy directly, 95% at 640 px. The
  volume's own colour field is as coarse as its grid whatever it is fed — raising `voxelRes`
  from 128 to 200 alone moved 86% to 89% — which is why the vertices are projected into the
  pictures instead and the volume's colour is only a fallback for vertices no view can see
  (7 of 33,415 on that scene). The colour copies cost about 0.7 MB a frame at Balanced and
  push the peak up around 6%.
- A texture atlas remains deferred, and by more than before. The median triangle covers 3.0
  source pixels, so an atlas would carry about 9.3x the samples the vertices hold — but with
  vertex colours now keeping 95% of the contrast at High there is very little left for it to
  win. The caveat still stands: this scene's procedural texture is smoother than wood grain,
  print or fabric. Re-measure on a genuinely detailed real object before deciding; below about
  60% retention there an atlas earns its weeks, near 80% it does not.

## Memory

The worker holds the whole scan at once, so per-frame buffers are released as soon as their
smaller derivatives exist: the depth-resolution copies are made during feature extraction and
the full-size image and greyscale are dropped there, and `releaseInputs` lets the worker free
the transferred pixel buffers as it goes (tests reuse their images and so must not set it).
Dense samples go straight into typed arrays. Forty frames at Balanced peak near 250 MB; keep
new per-frame state small or free it explicitly.

The one buffer that outlives the dense stage is the per-frame colour copy (`colorWidth` in
`QUALITY`), because the surface is coloured from the photographs after it is meshed. It is
freed as soon as that is done. A sixteen-frame scan measured 264 MB peak before it existed and
280 MB with it.

## Scale

A reconstruction has no absolute scale. The viewer lets the user tap two points on the mesh
and give the real distance between them, which sets `state.metresPerUnit`; exports multiply
positions by it (`scaledGeometry`) so a GLB opens at its true size, glTF being defined in
metres. The scale is cleared whenever a new build starts.

## Conventions

- Never paste text that came from outside into markup. Camera labels come from the operating
  system and photo labels from file names, so the interface builds those nodes with
  `document.createElement` and `textContent` (there is an `el()` helper in `app.js`).
  `innerHTML` is for fixed markup and computed numbers only.

- Camera model: `Xc = R Xw + t`, pixel = `c + f * distort(Xc.xy / Xc.z)` with
  `distort(x) = x (1 + k1 |x|^2)`. World frame = first registered camera; results are
  flipped to y-up (`x, -y, -z`) only when building the final output.
- Matrices are flat row-major Float64Arrays with explicit dimensions.
- Every pipeline change should keep `npm test` green; add a synthetic-scene test when
  adding a stage. Keep the CPU and GPU plane sweeps behaviourally identical.
- Do not add build tooling or npm dependencies without a strong reason: the app is meant to
  be deployable by copying the folder to any static HTTPS host.
