# Phonogeometry

Turn every camera on your phone into a 3D scanner.

Phonogeometry is a progressive web app that opens **all the cameras your phone exposes** (wide, ultra-wide, telephoto, front) and captures from them simultaneously. From a handful of shots taken while you move around, it reconstructs a **textured 3D mesh** of a room, a person or an object, entirely on the device, and exports it as GLB, PLY or OBJ.

No app store, no server, no account: it runs in the phone's browser and works offline once
loaded. That is tested, not assumed: with the network cut after the first visit, the app
still opens, imports photos, reconstructs and exports.

<p align="center">
  <img src="docs/capture.png" width="30%" alt="Capture screen with live camera tiles" />
  &nbsp;
  <img src="docs/viewer.png" width="30%" alt="Reconstructed mesh in the viewer" />
</p>
<p align="center"><sub>Capture screen (with a browser test camera) and the viewer showing a reconstruction of a synthetic test scene with its eight camera frusta.</sub></p>

## How it works

Every shutter press grabs a frame from each camera at the same instant. Wide and ultra-wide lenses give context and coverage, the telephoto gives detail, and the front camera looks the opposite way, which is what you want when you scan a room. Between shots you move; the parallax between viewpoints is what makes the 3D.

The reconstruction pipeline is written from scratch in plain JavaScript and runs in a Web Worker:

| Stage | Method | Code |
| --- | --- | --- |
| Features | Multi-scale FAST corners with oriented BRIEF descriptors (ORB-style, 256 bit) | `src/vision/fast.js`, `src/vision/orb.js` |
| Matching | Brute-force Hamming with ratio test and mutual check; candidate pairs from shot order plus a global thumbnail descriptor | `src/vision/match.js` |
| Two-view geometry | Normalised eight-point essential matrix inside RANSAC, cheirality-based pose recovery; radial distortion model for keypoints and images | `src/vision/geometry.js` |
| Structure from motion | Incremental: feature tracks, best-pair initialisation, PnP registration (DLT + RANSAC + Levenberg–Marquardt), pairwise pose chaining fallback | `src/vision/sfm.js` |
| Camera rig | Calibrates the fixed transform between the phone's cameras from the shots where both are placed, then uses it to register frames structure from motion cannot, and to merge a camera that shares no features at all (the front one) by aligning the two camera paths | `src/vision/sfm.js` |
| Bundle adjustment | Sparse Levenberg–Marquardt with the Schur complement and Huber loss; refines one focal length per physical camera | `src/vision/ba.js` |
| Dense depth | Multi-view plane sweep with zero-mean normalised cross-correlation (robust to exposure differences between physical cameras), sub-plane refinement, cross-view consistency check; runs on the GPU through WebGL2 with an identical CPU fallback | `src/vision/planeSweepGPU.js`, `src/vision/planeSweep.js` |
| Fusion | Truncated signed distance volume with per-voxel colour; object and person scans focus the volume on the point the cameras converge on | `src/mesh/tsdf.js`, `src/pipeline/reconstruct.js` |
| Meshing | Naive surface nets, component filtering, Taubin smoothing, vertex colours | `src/mesh/surfaceNets.js`, `src/mesh/meshUtils.js` |
| Export | GLB (glTF 2.0 binary), binary PLY, OBJ, dense point cloud PLY | `src/mesh/exporters.js` |

The viewer uses three.js (vendored in `vendor/three`, MIT licensed).

## Running it

Phones only allow camera access from a secure origin, so you need HTTPS (or `localhost`).

```bash
npm run start:https
```

There are no dependencies to install and no build step.

The server prints a `https://<your LAN IP>:8443/` URL. Open it on the phone (same Wi-Fi), accept the self-signed certificate once, and tap **Enable all cameras**. Alternatively, deploy the folder to any static host with HTTPS (GitHub Pages, Netlify, Cloudflare Pages…).

On a desktop browser you can use **Import photos** instead of the cameras.

Shots are kept in the browser's IndexedDB, so if the tab reloads mid-scan (phones do this under memory pressure) they are restored when you come back.

### Scanning tips

- **Object**: circle it in small steps, roughly 10° apart, 20–40 shots. Matte, textured objects work best.
- **Person**: they stand still; you circle them at chest height in small steps, then add a higher and a lower pass.
- **Room**: stand near the centre, shoot, step half a metre sideways, shoot again; go round twice at two heights. Front and back cameras fire together, so each shot covers two walls.
- **Overlap generously.** Each shot should share well over half its view with the previous one. This is the single thing that decides whether a scan works. Measured on a synthetic object, consecutive views about 8° apart reconstruct completely, 12° apart partially, and beyond about 16° the matching gives out and the scan breaks into pieces. Fewer, wider-spaced shots are a false economy: the work grows with the number of image pairs, and a broken scan costs everything.
- Keep something with depth in view, such as furniture or a corner. A flat wall filling the frame is ambiguous: no method can recover its distance from photographs alone.
- Keep the phone steady. Phonogeometry measures the sharpness of every frame and marks any that are much softer than the others from the same camera, because one blurred shot in the middle of a sequence can fail to match its neighbours and strand everything after it: in testing a single frame blurred by three pixels halved the number of images that could be placed. Retake the ones it flags.
- Vary your distance to the subject in a few shots (step in, step back). That is what lets the app calibrate each lens's focal length, which browsers do not report.
- **Fast** quality takes well under a minute for a dozen shots on a recent phone; **High** can take several minutes.

### Camera lenses

Browsers do not report focal lengths. Each camera is mapped to a lens type (wide, ultra-wide, telephoto, front) from its label, which sets its initial field of view; bundle adjustment then refines one focal length and one radial distortion coefficient per physical camera. This corrects focal errors of 10–20% and the barrel distortion of ultra-wide lenses when the shots vary in distance. The calibrated values are printed under Details on the processing screen. If a phone reports generic names ("camera2 0, facing back") check the mapping under **Settings**: a closer starting guess still helps. Imported photos use the 35 mm-equivalent focal length from EXIF when present.

Some phones refuse to stream several rear cameras at the same time. Cameras that cannot be opened concurrently are captured sequentially right after the simultaneous ones (this is on by default and can be disabled in Settings); hold still for that half second.

## The camera rig

The cameras fired in one shot are bolted to the same phone, so the transform between them is
the same in every shot. Phonogeometry estimates that transform and puts it to work twice.

**Filling gaps.** A frame that cannot be placed on its own, because it is blurred or aimed at
a blank wall, is placed from its shot-mate's pose and then checked against whatever points it
does see.

**Joining the front camera.** The front camera looks the other way, so it shares no features
at all with the back cameras: no amount of feature matching can connect them. Phonogeometry
reconstructs the front camera's frames as their own model, then brings that model into the
main one by aligning the two camera paths, which are the same path walked by the same phone.
The result is checked twice before it is accepted: the implied rig rotation must come out the
same at every shot, and the two paths must agree to within a few percent of the size of the
scene. If either check fails the component is left out rather than merged wrongly.

That is what lets a single sweep of a room capture the wall in front of you and the wall
behind you at the same time. The few millimetres between the lenses are treated as zero,
which is far below the voxel size of any scan, so the cameras of one shot end up at the same
point.

## Watching a scan come together

Working out where each photo was taken is the slow and uncertain part of the job; turning
those positions into a surface takes a predictable amount of time. So as soon as the camera
positions are solved, the app shows them: the camera path and the sparse points appear in the
viewer with a bar reporting what is still being computed, and the finished surface replaces
them when it is ready. If the path looks wrong, stop there rather than waiting out the rest.

## When a scan comes out wrong

After processing, any photo that could not be placed in the model is greyed out and labelled
in the shot list, and the Details panel on the processing screen names them. The usual causes,
in order of how often they bite:

- **Too little overlap** between consecutive shots. Move less between shots.
- **A blurred frame**, flagged with a badge as soon as it is captured. Retake it.
- **A blank or glossy surface** with no texture to match.
- **Something moved** between shots.

## Limits

- The scale of the model is arbitrary. A single phone cannot measure absolute size from images alone; export and scale in your 3D tool if you need real units.
- Moving subjects, mirrors, glass, and textureless surfaces break photogrammetry, here as everywhere.
- A camera aimed at one flat wall and nothing else is a degenerate case, not merely a hard one: every distance explains the photographs equally well. Phonogeometry places the cameras correctly and returns a flat surface at the wrong distance rather than refusing. Keep something with depth in view.
- Feature matching, structure from motion and fusion run on the CPU in JavaScript; the dense depth stage runs on the GPU when the browser offers WebGL2 with float render targets (most phones since 2018). Resolutions and voxel counts are modest by design.
- Long scans are bounded by memory rather than patience. Forty frames at Balanced quality peak at about 250 MB in the worker, which fits comfortably on a modern phone; High quality costs roughly twice that, so keep High for scans of thirty frames or fewer unless the phone is a recent flagship.

## Development

```bash
npm test          # unit and end-to-end tests on synthetic scenes (Node >= 18)
npm start         # plain HTTP on :8080 for desktop development (imports only)
npm run icons     # regenerate the PWA icons
```

The tests render synthetic textured scenes with ground truth and check each stage (essential matrix and PnP recovery, bundle adjustment convergence and focal-length recovery, SfM pose accuracy, plane-sweep depth accuracy, TSDF/surface-nets geometry, exporter validity) as well as full reconstructions.

The GPU plane sweep cannot run under Node. Start the dev server and open `test/browser/index.html` in a browser: it compares the GPU and CPU depth maps of a synthetic scene against the ground truth and prints coverage, accuracy, agreement and timings.

## Project layout

```
index.html, styles.css, src/app.js   UI and application flow
src/camera/                          camera discovery, simultaneous capture, intrinsics, EXIF
src/pipeline/                        worker entry and the reconstruction orchestrator
src/vision/                          linear algebra, features, matching, geometry, SfM, BA, plane sweep
src/mesh/                            TSDF, surface nets, mesh utilities, exporters
src/viewer/                          three.js viewer
test/                                node:test suites and synthetic scene renderers
server.js                            dev server (HTTP/HTTPS with self-signed certificate)
sw.js, manifest.webmanifest, icons/  PWA
```

## License

MIT. three.js is © its authors, MIT licensed (see `vendor/three/LICENSE`).
