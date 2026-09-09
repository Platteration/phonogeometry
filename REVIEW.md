# Phonogeometry — security & upgrade review (2026-09-09)

Two independent reviewers read every first-party file in this repository; a third then re-read each security or bug claim against the code and tried to refute it. Only claims that survived that check are listed as findings; the ones that did not are recorded at the end so they are not re-raised.

## Status — what has been fixed

No finding here reached a severity that warranted a code change, so this repository's source is unchanged.

Repository hardening applied here as well: every GitHub Action is pinned to a commit rather than a floating tag, each workflow declares a least-privilege `permissions` block, and a Dependabot config, a licence and a security policy are in place.

## Summary

Phonogeometry is a dependency-free vanilla-JS PWA (index.html, src/, sw.js, vendored three.js r160) that opens every camera a phone exposes, captures from all of them per shutter press, and runs a from-scratch photogrammetry pipeline (ORB features, Hamming matching, incremental SfM with a camera-rig model, sparse LM bundle adjustment with per-camera focal/k1, GPU/CPU plane sweep, TSDF fusion, surface nets) in a Web Worker before exporting GLB/PLY/OBJ. It is an early but unusually well-tested prototype: 17 commits over two days (Sep 6-8 2026), version 0.1.0 never tagged, no lint/typecheck/format tooling, but node:test suites with ground-truth synthetic scenes for every numeric stage plus a Playwright suite (capture, blur flagging, exports, reload persistence, offline) that never runs in CI. Headline recommendations: (1) harden CI (Node 22/24 instead of the EOL 18/20 range, SHA-pinned actions, a permissions block, Dependabot, and a Playwright job so the browser suite actually gates changes); (2) parallelise the matching stage across a worker pool and move photo decoding off the main thread, since the repo's own notes say matching dominates long scans; (3) make 'Add more shots' incremental instead of a full rebuild and persist finished results so a reload does not lose the mesh; (4) break up the 600-line runSfM closure and the 300-line reconstruct() function, name the two dozen tuned thresholds, and add the missing unit tests for exif.js, intrinsics.js, selectCandidatePairs and opticalAxesFocus; (5) fix small product inconsistencies (README says four photos minimum, code says three; index.html's initial tip contradicts PRESET_TIPS) and finish PWA/accessibility polish (manifest id/screenshots, aria-live regions, remove user-scalable=no, reduced-motion).

## Attack surface

Phonogeometry is a static, dependency-free PWA (index.html, src/, sw.js, vendored three.js) that runs entirely in the phone's browser: it requests getUserMedia for every video input, opens several streams at once, imports user-picked image files, decodes them with createImageBitmap plus a hand-written EXIF parser, runs photogrammetry in a module Web Worker (with WebGL2 via OffscreenCanvas), renders in three.js, and exports GLB/PLY/OBJ through blob downloads or navigator.share. There is no backend, no account, no analytics and no request to any origin other than its own; the only listening component is server.js, a dev-only static server that binds 0.0.0.0 (HTTP :8080 or self-signed HTTPS :8443) and serves the project directory to the LAN so a phone can load the app. Untrusted inputs are limited to image files and their EXIF, OS-supplied camera labels, and previously persisted state in IndexedDB (captured photos, possibly of people and rooms, kept until the user clears them) and localStorage (lens overrides keyed by camera label). The realistic risks are therefore exposure and robustness of the dev server on shared Wi-Fi, local robustness/data-loss bugs in a multi-minute on-device build, and provenance of the vendored three.js; there are no secrets, tokens or server-side trust boundaries.

## Already done well

- Everything runs on-device: no fetch/XHR/WebSocket to any third party anywhere in src/, sw.js or index.html; exports are user-initiated downloads/shares (src/app.js:590-596, 663-667), matching the README's 'no server, no account' claim.
- External strings never reach markup: camera labels and file names are rendered with the el()/textContent helper (src/app.js:12-17, 88-93, 277-281), the convention is written down in CLAUDE.md:87-90, and a browser test feeds a file named x"><img src=x onerror=...> and asserts it is shown as text (test/browser/run.mjs:230-250).
- Service worker is done carefully: precache is atomic (skipWaiting only after addAll succeeds, sw.js:13-15), runtime strategy is network-first with cache fallback so there is no update starvation (sw.js:19-33), the cache name is bumped in every commit (git history of sw.js), and registration is gated on window.isSecureContext (src/app.js:681-683). Offline capture, build and export are exercised in test/browser/run.mjs:280-305.
- three.js is vendored and served same-origin through an import map (index.html:16-23, README.md:37) rather than from a CDN, and the project has zero npm dependencies (package.json), so there is no runtime supply chain to compromise.
- Heavy compute is isolated in a module Worker with transferred buffers and explicit release of input pixels (src/pipeline/worker.js, src/pipeline/reconstruct.js:194-196); failures are surfaced through both an error message and worker.onerror and shown on whichever screen the user is on (src/app.js:380-419).
- The GPU path fails closed: createGpuSweeper returns null without WebGL2 float targets or on shader errors, every depth map is wrapped in try/catch with CPU fallback, context loss is checked, and textures are deleted in finally (src/vision/planeSweepGPU.js:150-162, 211-292; src/pipeline/reconstruct.js:307-318).
- The EXIF reader reads at most 256 KB and wraps all DataView access in try/catch so malformed offsets cannot throw into the import flow (src/camera/exif.js:4-21); IndexedDB and localStorage access is wrapped with graceful memory-only fallback (src/storage.js:32-60, src/camera/intrinsics.js:36-44).
- Camera hygiene: the permission probe stream is stopped after enumerateDevices (src/camera/cameraManager.js:34-39), streams are closed on pagehide (src/app.js:671), and cameras that ended are reopened only when the page is visible (src/app.js:673-674).
- Dev server refuses .git/ and .certs/ paths and the self-signed key/cert live in a gitignored directory (server.js:28, .gitignore:2); no certificate or key material is committed.
- Unusually thorough ground-truth test suite: every pipeline stage has a synthetic-scene test (test/*.test.js) and the rig merge is required to fail closed on weak fits (src/vision/sfm.js:537-566, CLAUDE.md:30-33).

## Findings (17)

| # | Severity | Category | Title | Where | Effort | Status |
|---|---|---|---|---|---|---|
| SEC-1 | Low | security | Dev server crashes on a malformed percent-escape from anyone on the LAN | `server.js:25` | trivial | confirmed |
| SEC-2 | Low | security | Dev server serves the whole project directory (dotfiles, gitignored scratch/) to the LAN and its root check lacks a separator | `server.js:28` | small | confirmed |
| SEC-3 | Low | security | No Content-Security-Policy on a page that builds parts of its UI with innerHTML | `index.html:16` | small | confirmed |
| SUP-1 | Low | supply-chain | Vendored three.js r160 has no recorded version, source URL or checksum | `vendor/three/three.module.min.js:1` | small | confirmed |
| CI-1 | Low | ci-cd | GitHub Actions not pinned to commit SHAs and no permissions block | `.github/workflows/test.yml:13` | trivial | confirmed |
| CI-2 | Low | ci-cd | Browser suite (offline, capture, XSS-name checks) never runs in CI and skips silently; hardcoded machine-specific paths | `.github/workflows/test.yml:17` | small | confirmed |
| BUG-2 | Low | reliability | A frame that cannot be decoded leaves the build stuck on 'Decoding photos' with no error and the wake lock held | `src/app.js:371` | small | confirmed |
| BUG-3 | Low | bug | Cancel pressed while photos are still being decoded is ignored; the build starts anyway and later hijacks the screen | `src/app.js:615` | small | confirmed |
| BUG-4 | Low | reliability | Screen wake lock is not re-acquired after the page is hidden, so a long build can be lost to screen lock | `src/app.js:330` | trivial | confirmed |
| BUG-5 | Low | reliability | three.js render loop runs at full frame rate forever, including while the viewer is hidden and during the next build | `src/viewer/viewer.js:64` | small | confirmed |
| VER-1 | Low | reliability | Service worker prefers an HTTP error response over a good cached copy, so a 404/5xx breaks the app even though it is fully cached | `sw.js:25` | trivial | found by second reviewer |
| VER-2 | Low | bug | The capture-resolution setting is ignored above 1280 px: live streams are always requested at ideal 1280x720 | `src/camera/cameraManager.js:136` | small | found by second reviewer |
| VER-4 | Low | privacy | Photographs are persisted to IndexedDB indefinitely, and a failed write is silent so the promised restore may not happen | `src/storage.js:38` | small | found by second reviewer |
| BUG-1 | Info | bug | A stale lens override in localStorage throws in renderLensSettings and disables capture on every launch | `src/app.js:162` | trivial | confirmed, severity lowered |
| INFO-1 | Info | bug | README states the app refuses to build with fewer than four photos; the code allows three | `README.md:57` | trivial | confirmed |
| VER-3 | Info | bug | Space bar takes a photograph while the Settings or Help dialog is open | `src/app.js:670` | trivial | found by second reviewer |
| VER-5 | Info | security | Dev server builds an openssl command line by string interpolation of its own path | `server.js:56` | trivial | found by second reviewer |

### SEC-1 · Dev server crashes on a malformed percent-escape from anyone on the LAN

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `server.js:25`

The request handler calls decodeURIComponent on the raw path with no try/catch. A request such as GET /% throws URIError inside Node's 'request' listener; there is no error handler, so the process exits. Because the server binds 0.0.0.0 by default and the README tells the user to run it on the same Wi-Fi as the phone, any device on that network (a shared office or cafe network) can kill the dev session with one request. Reproduced in a scratchpad copy of the handler pattern: the URIError is uncaught. A non-numeric --port= also reaches server.listen as NaN and throws.

Evidence:

```
server.js:25: let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);  server.js:62: server.listen(port, '0.0.0.0', () => {  Repro: GET /%  ->  'UNCAUGHT in handler (process would exit): URIError URI malformed'
```

**Recommendation.** As written, plus one addition worth making at the same time: the same handler should return 405 for methods other than GET/HEAD, and 'server.on(\'clientError\', (err, socket) => socket.destroy())' should be paired with a short 'server.headersTimeout'/'requestTimeout' so a half-open connection from the LAN cannot hold the dev server either.

### SEC-2 · Dev server serves the whole project directory (dotfiles, gitignored scratch/) to the LAN and its root check lacks a separator

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `server.js:28`

There is no allow-list: any file under the repository directory except .git/ and .certs/ is served, including dotfiles (.env, .claude/, .DS_Store) and the gitignored scratch/ directory that .gitignore shows the developer keeps locally. In addition the containment test is file.startsWith(root) with no trailing path separator, so a path like /..%2fphonogeometry-old/.env resolves to /home/user/phonogeometry-old/.env (the URL parser keeps %2F, decodeURIComponent then turns it into a slash and path.normalize resolves the ..) and passes the check, exposing any sibling directory whose name begins with 'phonogeometry' (a backup copy, an older clone). Combined with binding 0.0.0.0 this is an information-disclosure risk whenever the LAN dev server is run on a network the developer does not control; the app itself has no secrets, which keeps the severity low.

Evidence:

```
server.js:27-30: const file = path.normalize(path.join(root, urlPath)); if (!file.startsWith(root) || file.includes(`${path.sep}.git${path.sep}`) || file.includes(`${path.sep}.certs${path.sep}`)) { res.writeHead(403); ...  Repro: GET /..%2fphonogeometry-old/.env -> file /home/user/phonogeometry-old/.env, passes startsWith(root): true; GET /scratch/notes.md and GET /.env pass as well. .gitignore:5: scratch/
```

**Recommendation.** The path.relative containment check is the right fix; drop the hidden-segment rule to a refusal of '.git', '.certs' and any segment starting with '.' only if you actually want dotfiles hidden (the app itself serves none). The higher-value half is the bind address: default to 127.0.0.1 and require an explicit --host=0.0.0.0 (or imply it from --https, which is the LAN mode the README documents), because that alone removes SEC-1 and SEC-2 from anyone else's reach.

### SEC-3 · No Content-Security-Policy on a page that builds parts of its UI with innerHTML

**Severity:** Low · **Category:** security · **Effort:** small · **Where:** `index.html:16`

Neither index.html nor server.js sets a CSP (the dev server only sends Cross-Origin-Opener-Policy). The app is meant to be copied to static hosts such as GitHub Pages where response headers cannot be configured, so a <meta http-equiv> policy is the only practical control. Today every external string is inserted with textContent, so this is defence in depth, but app.js still has five innerHTML/insertAdjacentHTML sites and a future regression (a camera label or file name pasted into one of those templates) would run with no mitigation. The page has a single external module script and one inline import map, so a strict hash-based policy is straightforward.

Evidence:

```
index.html:16: <script type="importmap"> (no <meta http-equiv="Content-Security-Policy"> anywhere in the file); server.js:33-37: res.writeHead(200, { 'Content-Type': ..., 'Cache-Control': 'no-cache', 'Cross-Origin-Opener-Policy': 'same-origin' }); src/app.js:85: tile.insertAdjacentHTML('beforeend', `<div class="cam-error">${msg}</div>`); src/app.js:568: $('#stats').innerHTML = `<span><b>${s.registered}</b>/${s.images} images used</span>`
```

**Recommendation.** The hash-for-the-import-map part is the shaky bit: an inline <script type="importmap"> is subject to script-src, external import maps are not supported, and hash matching for import maps has not been reliable across engines — so a policy of 'script-src \'self\' \'sha256-…\'' risks silently breaking the viewer on some browsers, which is exactly the failure this app cannot test in CI (see CI-2). Prefer removing the need for it: vendor/three/OrbitControls.js:1-12 imports the bare specifier 'three', so rewrite that one import to './three.module.min.js' (recording it in the vendor provenance note SUP-1 asks for) and import three by relative path from src/viewer/viewer.js:2-3. Then delete the import map and ship 'default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data: blob:; worker-src \'self\'; connect-src \'self\'; manifest-src \'self\'; base-uri \'none\'; form-action \'none\'' with no hash to maintain. If the import map is kept, verify the page still loads in Chrome and Safari with the policy on before committing it.

### SUP-1 · Vendored three.js r160 has no recorded version, source URL or checksum

**Severity:** Low · **Category:** supply-chain · **Effort:** small · **Where:** `vendor/three/three.module.min.js:1`

three.js (670 KB minified) and OrbitControls.js are committed without any provenance record: the only version indicator is the minified constant REVISION '160' inside the file (a December 2023 release), OrbitControls.js has no header at all, and README/CLAUDE.md only say 'vendored, MIT licensed'. That makes it impossible to verify the files match an upstream release, to notice when a security fix lands upstream, or to update them reproducibly. Vendoring itself is the right call for this app (no CDN, offline-capable), so the gap is bookkeeping rather than exposure.

Evidence:

```
vendor/three/three.module.min.js:1-6: '@license Copyright 2010-2023 Three.js Authors ... const t="160"'; vendor/three/OrbitControls.js:1-11 begins with the import block and no version comment; README.md:37: 'The viewer uses three.js (vendored in `vendor/three`, MIT licensed).' ; package.json declares no dependencies.
```

**Recommendation.** Same, with one simplification: rather than a downloader script for a dependency that is refreshed once a year, a vendor/three/PROVENANCE.md holding the npm version (three@0.160.x), the two upstream paths and 'sha256sum' output for both files is enough, plus the note that OrbitControls.js's bare 'three' import is the local edit (if SEC-3's fix is taken). package.json already declares no dependencies, so nothing else needs to change.

### CI-1 · GitHub Actions not pinned to commit SHAs and no permissions block

**Severity:** Low · **Category:** ci-cd · **Effort:** trivial · **Where:** `.github/workflows/test.yml:13`

Both actions are referenced by mutable major tags and the workflow has no permissions: key, so the job runs with the repository's default GITHUB_TOKEN scope. A compromised or force-moved v4 tag would run attacker code in CI. Impact is contained because the workflow only runs tests and the repository holds no secrets or publish steps, but pinning is free.

Evidence:

```
.github/workflows/test.yml:13-16: - uses: actions/checkout@v4 / - uses: actions/setup-node@v4 ; no top-level permissions: entry in the file.
```

**Recommendation.** As written. Note actions/setup-node is only setting a Node version here with no caching and no registry auth, so it could equally be dropped in favour of the runner's default Node plus a matrix on setup-node only where a specific version is needed — one fewer third-party action to pin.

### CI-2 · Browser suite (offline, capture, XSS-name checks) never runs in CI and skips silently; hardcoded machine-specific paths

**Severity:** Low · **Category:** ci-cd · **Effort:** small · **Where:** `.github/workflows/test.yml:17`

CI runs only `npm test` (node:test). The Playwright suite that verifies the README's headline claims (works offline, multi-camera capture, failure reporting, markup file names shown as text, shots surviving reload) is a separate script that returns success with a console message when Playwright is absent, so none of those behaviours are protected against regression on push. The script also embeds paths from one particular machine (/opt/pw-browsers/chromium-1194/..., /opt/node22/lib/node_modules/playwright/index.mjs) as fallbacks, which will silently stop matching when that environment changes.

Evidence:

```
.github/workflows/test.yml:17: - run: npm test ; test/browser/run.mjs:59-63: if (!chromium) { console.log('Playwright is not installed, so the browser tests were skipped.'); ... return 0; } ; test/browser/run.mjs:23,29: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/node22/lib/node_modules/playwright/index.mjs' ; README.md:7-9: 'works offline once loaded. That is tested, not assumed'
```

**Recommendation.** As written. One caveat on 'add a package-lock': the repo deliberately has no dependencies and no lockfile (package.json declares none, CLAUDE.md forbids adding npm dependencies without a strong reason), so pin the version in the workflow line itself ('npx --yes playwright@1.49.1 install --with-deps chromium') rather than introducing a lockfile the project has chosen not to have.

### BUG-2 · A frame that cannot be decoded leaves the build stuck on 'Decoding photos' with no error and the wake lock held

**Severity:** Low · **Category:** reliability · **Effort:** small · **Where:** `src/app.js:371`

reconstruct() decodes every stored frame with createImageBitmap(frame.blob) inside a loop that has no try/catch, and it is invoked directly from a click listener, so any rejection becomes an unhandled promise rejection: the processing screen keeps saying 'Decoding photos', no toast or failure banner appears, and the screen wake lock stays held until the user guesses to press Cancel. Realistic triggers on a phone: canvas.toBlob returning null under memory pressure (canvasToBlob resolves null and captureShot/importFiles store it as the frame's blob), or a record restored from IndexedDB whose blob can no longer be read. The same null blob is persisted, so the failure survives reloads.

Evidence:

```
src/app.js:200-202: function canvasToBlob(canvas, q = 0.92) { return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', q)); } ; src/app.js:315-316: async function decodeForWorker(frame, ...) { const bmp = await createImageBitmap(frame.blob); ; src/app.js:371-375: for (let s = 0; ...) { for (const fr of state.shots[s].frames) { images.push(await decodeForWorker(fr, targetWidth, `img-${k++}`, s)); } } ; src/app.js:614: $('#btn-reconstruct').addEventListener('click', reconstruct);
```

**Recommendation.** As written. Prefer the 'skip the offending frame and carry on if MIN_FRAMES remain' branch over failing the whole build: the shots are already on disk and a single unreadable blob should not cost a scan. The global unhandledrejection backstop is worth adding regardless, since reportFailure already does the right thing with a message.

### BUG-3 · Cancel pressed while photos are still being decoded is ignored; the build starts anyway and later hijacks the screen

**Severity:** Low · **Category:** bug · **Effort:** small · **Where:** `src/app.js:615`

stopBuild only terminates state.worker, but the worker is created after the sequential decode loop, which on a phone with 30-60 frames at 800 px takes several seconds (createImageBitmap + drawImage + getImageData per frame on the main thread). Pressing Cancel during that window returns the user to the capture screen, yet reconstruct() keeps running, creates the worker and posts the job; the first 'preview' message then calls showScreen('view') and pulls the user off the capture screen mid-shot, and a full multi-minute build runs that they tried to cancel.

Evidence:

```
src/app.js:615-622: const stopBuild = () => { if (state.worker) { state.worker.terminate(); state.worker = null; } releaseWakeLock(); ... showScreen('capture'); }; src/app.js:371-378: images decoded with await ... then const worker = new Worker(new URL('./pipeline/worker.js', import.meta.url), { type: 'module' }); src/app.js:439-444: async function showPreview(m) { if (state.failed) return; if (!(await ensureViewer()) || state.failed) return; showScreen('view');
```

**Recommendation.** The generation token is the right fix; add 'state.buildGen' to the state object at app.js:18-26 so it is not implicitly created, and set state.failed=false only after the token check. Disabling #btn-reconstruct for the duration would additionally stop two decode loops from overlapping if the user cancels and immediately builds again.

### BUG-4 · Screen wake lock is not re-acquired after the page is hidden, so a long build can be lost to screen lock

**Severity:** Low · **Category:** reliability · **Effort:** trivial · **Where:** `src/app.js:330`

Browsers release a 'screen' wake lock automatically whenever the document becomes hidden (notification shade, app switch, incoming call). holdWakeLock is called once at the start of a build and never again; worse, the released sentinel is kept in the wakeLock variable, so the `!wakeLock` guard would make a later call a no-op anyway. On a multi-minute Balanced/High build (README: 'a few minutes', 'several minutes') a single interruption leaves the screen free to lock, after which iOS Safari suspends the tab and the whole reconstruction is discarded.

Evidence:

```
src/app.js:329-336: let wakeLock = null; async function holdWakeLock() { try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { ... } } ; src/app.js:341: holdWakeLock(); (only call site) ; src/app.js:674: document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reopenCameras(); }); (does not touch the wake lock)
```

**Recommendation.** As written. Guard the re-request on the build actually being live — state.worker is set only between app.js:378 and stopBuild/reportFailure, so 'if (document.visibilityState === \'visible\' && state.worker) holdWakeLock();' is exact — and add the 'release' listener so the sentinel is nulled by the platform, which also fixes the no-op guard.

### BUG-5 · three.js render loop runs at full frame rate forever, including while the viewer is hidden and during the next build

**Severity:** Low · **Category:** reliability · **Effort:** small · **Where:** `src/viewer/viewer.js:64`

The Viewer starts a requestAnimationFrame loop in its constructor that renders the scene on every frame regardless of whether #screen-view is visible; showScreen only toggles the hidden attribute and dispose() is never called from app.js. After the first build, 'Add more shots' returns to the capture screen with several live camera streams plus a 60 fps WebGL render of a display:none canvas, and the following reconstruction runs with that render loop competing for the GPU the worker's plane sweep is using. On a phone this is a measurable battery and thermal cost over a session that already takes minutes. Each setPreview/setResult also allocates fresh PointsMaterial/LineBasicMaterial objects that clear() never disposes.

Evidence:

```
src/viewer/viewer.js:63-70: this._running = true; const loop = () => { if (!this._running) return; this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); }; requestAnimationFrame(loop); ; src/app.js:44-48: function showScreen(name) { for (const s of [...]) $(`#screen-${s}`).hidden = s !== name; ... } ; viewer.js:131-139 clear() disposes c.geometry only; viewer.js:153, 185, 214: new THREE.PointsMaterial(...) / new THREE.LineBasicMaterial(...) per call; no caller of dispose() in src/.
```

**Recommendation.** Render-on-demand is the right target, but the cheap first move is one line in showScreen: 'state.viewer?.setActive(name === \'view\')' driving this._running plus a re-kick of the loop, which removes the whole background cost without reworking the damping loop. Reusing two materials created in the constructor (as the existing this._materials cache already does for the mesh materials) is simpler than disposing per clear().

### VER-1 · Service worker prefers an HTTP error response over a good cached copy, so a 404/5xx breaks the app even though it is fully cached

**Severity:** Low · **Category:** reliability · **Effort:** trivial · **Where:** `sw.js:25`

The runtime strategy is network-first, but the fallback to the cache is only wired to fetch *rejection* (offline). When the network answers with a non-OK response — a 502/503 from the static host, a 404 during a partial deploy, or an intercepting captive-portal page — 'res' is truthy, so the handler returns that error response to the page while the correct file sits in the cache. A single 5xx on src/app.js or vendor/three/three.module.min.js therefore yields a broken app on a phone that could have run entirely from its cache, which is precisely the situation the README's offline claim exists for. Related smaller issue on the same lines: every same-origin GET that returns 200 is written into the shell cache, with no allow-list, so the cache also accumulates whatever else the origin serves.

Evidence:

```
sw.js:23-31: 'e.respondWith(\n        caches.match(e.request).then((cached) => {\n          const fetched = fetch(e.request).then((res) => {\n            if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));\n            return res;\n          }).catch(() => cached);\n          // Network first so updates land quickly, falling back to the cache when offline.\n          return fetched.then((r) => r || cached);\n        }),\n      );'
```

**Recommendation.** Fall back on a bad status as well as on a rejection: 'return fetched.then((r) => (r && r.ok ? r : (cached || r)))', keeping the existing catch. Optionally restrict the runtime cache.put to requests whose pathname is in SHELL, so an unexpected 200 cannot displace shell entries.

### VER-2 · The capture-resolution setting is ignored above 1280 px: live streams are always requested at ideal 1280x720

**Severity:** Low · **Category:** bug · **Effort:** small · **Where:** `src/camera/cameraManager.js:136`

Settings offers 960 / 1280 / 1920 px for the capture long side, but every concurrently-opened camera is opened with a hardcoded ideal of 1280x720 (app.js:114 for the initial open, app.js:138 when a stream is reopened, cameraManager.js:178 when the sequential fallback restores released cameras). grabFrame only ever downscales — 's = Math.min(1, maxDim / Math.max(vw, vh))' — so choosing 1920 px produces the same 1280 px frames as choosing 1280, while 960 px does work. Only the sequential-fallback path honours the setting (cameraManager.js:168/171 open at maxDim), so within a single shot the sequentially captured lens can come back at a higher resolution than the ones streaming live. The setting also is not re-applied to already-open cameras when it changes, so it takes effect only for cameras opened afterwards.

Evidence:

```
src/app.js:114: 'const results = await cams.openAll({ width: 1280, height: 720 });'; src/app.js:138: 'entry: await cams.openCamera(cam, { width: 1280, height: 720 })'; src/camera/cameraManager.js:133-137: 'grabFrame(entry, maxDim = 1280) {\n    const { video, cam, track } = entry;\n    const vw = video.videoWidth, vh = video.videoHeight;\n    const s = Math.min(1, maxDim / Math.max(vw, vh));'; src/camera/cameraManager.js:168: 'entry = await this.openCamera(cam, { width: maxDim, height: Math.round(maxDim * 0.75) });'; src/app.js:210: "const maxDim = parseInt($('#capture-res').value, 10);"
```

**Recommendation.** Read #capture-res once into state and pass it to openAll/openCamera/reopenCameras as the ideal width (with height = round(width * 0.75)), and re-open the enabled cameras when the select changes — or, if the 1280 cap is deliberate because the pipeline downsamples to featureWidth anyway, remove the 1920 option and say so in the settings copy.

### VER-4 · Photographs are persisted to IndexedDB indefinitely, and a failed write is silent so the promised restore may not happen

**Severity:** Low · **Category:** privacy · **Effort:** small · **Where:** `src/storage.js:38`

Every captured frame — a full JPEG blob plus a data-URL thumbnail — is written to IndexedDB and kept until the user presses Clear or New scan; there is no cap on the number of shots kept, no expiry, and nothing in the interface says the photographs of the room or person being scanned are still on the device from previous sessions until the restore toast appears on the next visit. Separately, saveShot is fire-and-forget (never awaited) and swallows every failure, so a quota-exceeded write on a phone with little free storage leaves the user believing a scan is safely persisted when it is not: the reload the README says the persistence exists to survive would lose everything from the failed shot onward, with no message at any point.

Evidence:

```
src/storage.js:34-39: 'async saveShot(shot) {\n    const db = await this.dbPromise;\n    if (!db) return;\n    const record = { id: shot.id, createdAt: shot.createdAt || Date.now(), frames: shot.frames.map((f) => ({ ...f, thumbUrl: f.thumbUrl })) };\n    try { await tx(db, \'readwrite\', (s) => s.put(record)); } catch { /* quota or serialisation failure: keep in memory */ }\n  }'; src/app.js:220: 'store.saveShot(shot);' (not awaited, no .catch); src/app.js:306-312 restoreShots(); README.md:52: 'Shots are kept in the browser\'s IndexedDB, so if the tab reloads mid-scan (phones do this under memory pressure) they are restored when you come back.'
```

**Recommendation.** Surface a write failure once per session ('This shot could not be saved for restore — storage is full') by resolving saveShot to a boolean and toasting on the first false, and request navigator.storage.persist() when a scan starts. For the retention half, either drop restored shots older than a day or show the count and a one-tap 'Delete stored photos' next to the restore toast, so the user knows the images are still on the device.

### BUG-1 · A stale lens override in localStorage throws in renderLensSettings and disables capture on every launch

**Severity:** Info (reported as low, adjusted after review) · **Category:** bug · **Effort:** trivial · **Where:** `src/app.js:162`

Lens overrides are read back from localStorage without validation and cam.lens is taken verbatim from them. Every other lookup uses LENS_TYPES[cam.lens]?. but renderLensSettings does LENS_TYPES[cam.lens].hfov unguarded. If the stored lens key is not one of the five current names (a renamed key after an app update, or any corruption of the JSON), renderCameraTiles throws after the streams have already been opened, startCameras reports 'Camera access failed: Cannot read properties of undefined (reading hfov)', the shutter button stays disabled, and because the value is persisted the same failure repeats on every visit until the user clears site data. loadLensOverrides also returns whatever JSON.parse produced (e.g. null), and overrides[key] then throws inside discover().

Evidence:

```
src/app.js:162: Object.assign(num, { type: 'number', ..., value: String(Math.round(cam.hfovOverride || LENS_TYPES[cam.lens].hfov)) }); src/camera/cameraManager.js:46-49: const ov = overrides[key]; ... lens: ov?.lens || guessLens(label, facing), hfovOverride: ov?.hfov || null ; src/camera/intrinsics.js:37: try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } ; contrast src/app.js:92: LENS_TYPES[cam.lens]?.label || cam.lens
```

**Recommendation.** Keep the validation in loadLensOverrides (intrinsics.js:36-38) — it is cheap and closes the 'null' case as well — and use '?? LENS_TYPES.unknown.hfov' at app.js:162/167/170. Do not treat it as an outstanding user-facing failure.

*Reviewer note (confirmed, severity lowered):* The asymmetry is real and worth fixing — app.js:162 dereferences LENS_TYPES[cam.lens] without the optional chaining that every other lookup uses, and a throw there does propagate out of renderCameraTiles into startCameras's catch, leaving #btn-capture disabled (app.js:119 is never reached). But I could not find any path in the shipped code that stores a lens key outside LENS_TYPES: guessLens (intrinsics.js:20-27) returns only ultrawide/telephoto/front/wide/unknown, cameraManager.js:76 writes only 'front'/'wide', and the only writer of the persisted override is saveLensOverride called with cam.lens taken from the select whose options are Object.keys(LENS_TYPES) (app.js:156-168). So triggering it needs hand-edited localStorage or a future rename of a lens key — and note that the two most likely tampered values, '__proto__' and 'constructor', do NOT throw (they resolve to Object.prototype/Object, .hfov is undefined, Math.round gives NaN). The null-overrides sub-claim likewise needs the literal string 'null' in storage. Real latent trap, no realistic present-day trigger: info, not low.

### INFO-1 · README states the app refuses to build with fewer than four photos; the code allows three

**Severity:** Info · **Category:** bug · **Effort:** trivial · **Where:** `README.md:57`

The scanning tips say four photographs is the fewest that can produce a surface and that the app will not offer to build with fewer, but app.js enables the Build button at three frames and the on-screen note says 'at least 3 needed'. Whichever number is right, the two should agree so users are not told different minimums by the README and the UI.

Evidence:

```
README.md:57-58: 'Four photographs is about the fewest that can produce any surface at all ... Fewer than that, and the app will not offer to build.' ; src/app.js:56-62: const MIN_FRAMES = 3; ... if (n && n < MIN_FRAMES) note = ` · at least ${MIN_FRAMES} needed`; ... $('#btn-reconstruct').disabled = n < MIN_FRAMES;
```

**Recommendation.** Export one constant from reconstruct.js (next to QUALITY) and use it for the UI note, the disabled check and the README wording; and gate on distinct shots as well as frames (e.g. state.shots.length >= 2 && frameCount() >= 3), since three frames from one shutter press cannot triangulate anything.

### VER-3 · Space bar takes a photograph while the Settings or Help dialog is open

**Severity:** Info · **Category:** bug · **Effort:** trivial · **Where:** `src/app.js:670`

The shutter shortcut fires whenever #screen-capture is not hidden and the focused element is not a BUTTON. Opening Settings or Help with showModal() does not hide the capture screen (the dialogs are siblings of it), and the first focusable element in the settings form is a <select> or <input>, so pressing space inside the dialog both suppresses the control's own space behaviour (opening a select, toggling a checkbox) and silently captures a shot from every camera behind the modal.

Evidence:

```
src/app.js:670: "document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !$('#screen-capture').hidden && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); captureShot(); } });"; index.html:151-173 (#settings) and index.html:175-189 (#help) are <dialog> elements outside #screen-capture; src/app.js:625-626: "$('#btn-settings').addEventListener('click', () => $('#settings').showModal());"
```

**Recommendation.** Add a modal check and widen the focus exclusion: 'if (document.querySelector(\'dialog[open]\')) return;' and skip when activeElement matches 'input, select, textarea, button'.

### VER-5 · Dev server builds an openssl command line by string interpolation of its own path

**Severity:** Info · **Category:** security · **Effort:** trivial · **Where:** `server.js:56`

ensureCert() interpolates the key and certificate paths — derived from the checkout location — into a shell command run with execSync. A checkout whose absolute path contains a double quote, a backtick or $( ) would execute that fragment as a shell command when the developer runs 'npm run start:https'. This is self-inflicted (the operator supplies the path) rather than remotely reachable, so it is info-level, but the fix is smaller than the risk of leaving a shell in the loop, and it also removes the quoting fragility on paths with spaces.

Evidence:

```
server.js:48-57: 'function ensureCert() {\n  const dir = path.join(root, \'.certs\');\n  const key = path.join(dir, \'key.pem\'), cert = path.join(dir, \'cert.pem\');\n  … execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 365 -subj "/CN=phonogeometry.local" -addext "subjectAltName=${san}"`, { stdio: \'inherit\' });'; server.js:12: 'const root = path.dirname(fileURLToPath(import.meta.url));'
```

**Recommendation.** Use execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','365','-subj','/CN=phonogeometry.local','-addext',`subjectAltName=${san}`], { stdio: 'inherit' }) — no shell, no quoting, same behaviour.

## Upgrades

| Value | Effort | Upgrade | Now | Move to |
|---|---|---|---|---|
| high | small | Run the Playwright browser suite in CI | npm run test:browser exists and covers capture, blur flagging, exports, measurement, reload persistence, XSS-safe labels, failure reporting and offline mode, but CI only runs 'npm test'. run.mjs skips itself when Playwright is absent. | Second job: setup-node 22, 'npx playwright@<pinned> install --with-deps chromium', then 'npm run test:browser' with SCREENSHOT_DIR uploaded via actions/upload-artifact. Gate on it. |
| high | small | Service worker correctness and update flow | sw.js: VERSION 'phonogeometry-v15' is bumped by hand; SHELL is a hand-maintained list of 30 paths; fetch handler resolves respondWith(undefined) when offline and uncached (TypeError); cache.put is not inside waitUntil; install uses skipWaiting + clients.claim with a network-first strategy, so a tab open across a deploy can load new app.js against a cached old worker.js module graph. | (a) tools/sw-version.mjs that hashes the SHELL files into VERSION (or a node test asserting every src/**/*.js and vendor file is listed); (b) return Response.error() or an offline fallback when both fail; (c) e.waitUntil around the cache update; (d) drop skipWaiting and surface registration.waiting as an 'Update ready, reload' toast in app.js. |
| medium | trivial | Node version policy: engines and CI matrix cover EOL releases | package.json engines '>=18'; test.yml matrix [20, 22]; no .nvmrc. Node 18 reached EOL April 2025 and Node 20 April 2026. | engines '>=22', matrix [22, 24] (24 is the active LTS), add .nvmrc = 24 so local, CI and README agree. |
| medium | trivial | Pin GitHub Actions to commit SHAs, add a permissions block and concurrency | actions/checkout@v4 and actions/setup-node@v4 by floating tag; no top-level permissions; no concurrency group; workflow runs on every branch push and pull_request. | Pin both to full SHAs (v5 of each exists) with a version comment, add 'permissions: contents: read' at the top, and 'concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }'. |
| medium | trivial | Add Dependabot for GitHub Actions | No .github/dependabot.yml. There are no npm dependencies, so only the actions ecosystem needs it today. | dependabot.yml with package-ecosystem: github-actions (weekly); add an npm entry the moment devDependencies (eslint/playwright) land. |
| medium | small | Lint and format tooling | No ESLint, Prettier, Biome or .editorconfig. Visible symptoms: mis-indented registerLoop in sfm.js (lines 419-455), a dead read of EXIF tag 0x920a in exif.js, a duplicated comment pair in app.js updateCounts, a stray double blank line in reconstruct.js. | Biome (single binary, lint + format, no config sprawl) or ESLint flat config with eslint:recommended, as devDependencies with a committed package-lock.json; add 'npm run lint' to CI. The CLAUDE.md rule against runtime dependencies is preserved because these are dev-only and the app still deploys by copying the folder. |
| medium | medium | Type-check with JSDoc and tsc --noEmit (no build step) | Frames, views, cameras and result objects are untyped bags that gain fields as they flow (reconstruct.js adds depthGray/df/dcx/k1 to frames at different stages; app.js adds state.failed/stats/measuredUnits at runtime). Some JSDoc exists but is not checked. | jsconfig.json with checkJs + strict, '// @ts-check' per file starting with linalg.js, geometry.js, exporters.js, and typedefs for Frame, View, Camera, Mesh in a src/types.js; 'npx tsc --noEmit' in CI. |
| medium | small | Refresh vendored three.js and record its provenance | vendor/three/three.module.min.js is r160 (Dec 2023, 670 KB) plus OrbitControls.js; only LICENSE is recorded, no VERSION file or fetch script says where the files came from. | Add tools/update-three.mjs that downloads a pinned version's build/three.module.min.js and examples/jsm/controls/OrbitControls.js from the npm tarball, writes vendor/three/VERSION, and re-run it against the current monthly release (r180+ in 2026). Viewer uses only stable API (WebGLRenderer, BufferGeometry, MeshStandardMaterial, Raycaster, OrbitControls); breaking changes since r160 to review: WebGL1 removed (r163), useLegacyLights removed (r165), OrbitControls rebased on the Controls class (r169). |
| medium | trivial | PWA manifest completeness | manifest.webmanifest has name, start_url, scope, display, colours and two icons; the 512 icon is declared 'any maskable' (a single image serving both purposes gets cropped in the maskable case). No id, screenshots, categories, description length check, or display_override. | Add 'id': '/', 'categories': ['photo', 'utilities'], 'screenshots' using the existing docs/capture.png and docs/viewer.png (form_factor: narrow), separate a padded maskable icon from the 'any' one via tools/make-icons.js, and 'display_override': ['standalone', 'minimal-ui']. |
| medium | small | Accessibility pass | viewport has user-scalable=no; #toast, #camera-status, #progress-message and #building have no aria-live; #progress-bar has no role=progressbar/aria-valuenow; camera tiles are click-only divs (no tabindex/role/aria-pressed); #view-mode lacks the radiogroup semantics #preset has, and neither handles arrow keys; .pulse and .flash animations ignore prefers-reduced-motion; .thumb-flag text is 9.5px; no :focus-visible styling. | Remove user-scalable=no; add role=status/aria-live=polite to the status and toast nodes and aria-live=assertive on failure; make .cam-tile a <button aria-pressed>; share one segmented-control helper for #preset and #view-mode with arrow-key support; wrap animations in @media (prefers-reduced-motion: no-preference); raise flag text to 11px; add a visible focus ring. |
| medium | small | Content Security Policy | No CSP. The app loads nothing cross-origin and already avoids innerHTML for external strings, so a strict policy is cheap. | <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; script-src 'self' 'sha256-<hash of the inline importmap>'; style-src 'self'; base-uri 'none'; form-action 'none'">, with the importmap hash generated by a tiny script. |
| medium | trivial | Project hygiene files and releases | LICENSE present. No SECURITY.md, CONTRIBUTING.md or CHANGELOG.md; package.json version 0.1.0 has never been tagged; package.json lacks repository/homepage/bugs. | Add the three files (CONTRIBUTING can be three paragraphs pointing at CLAUDE.md's conventions and the two test commands), tag v0.1.0, keep a Keep-a-Changelog file, and fill package.json metadata. |
| medium | small | GitHub Pages deployment workflow | README tells users to deploy the folder to GitHub Pages/Netlify/Cloudflare, but there is no workflow; the default branch is a claude/* feature branch. | pages.yml on tag push: checkout, run tests, upload-pages-artifact of the repo root minus test/ tools/ docs/, deploy-pages. Set a main branch as default. |
| medium | medium | Playwright as a devDependency instead of environment probing | test/browser/run.mjs searches '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/node22/lib/node_modules/playwright/index.mjs' and '/usr/local/lib/node_modules/playwright/index.mjs' (sandbox-specific paths), uses raw waitForTimeout sleeps, and is one 316-line script with hand-rolled check(). | Add @playwright/test as a devDependency with a lockfile, split the six scenarios into spec files with expect.poll/ toPass instead of sleeps, keep the fakeCameras init script, and keep the 'skip if not installed' behaviour behind an env flag. |
| medium | trivial | Global error capture and diagnostics | Only worker.onerror and try/catch around capture/import are handled; no window 'error' or 'unhandledrejection' listeners; worker.js posts err.stack but app.js discards it; the only console output is the SW registration warning. | Add both window listeners that append to #progress-log and toast once; write the worker stack into the Details pane; pair with the 'Copy diagnostics' feature below. Keep it local, no telemetry endpoint. |
| low | trivial | Dev server robustness | server.js: decodeURIComponent(req.url) is unguarded (a malformed %-sequence throws URIError inside the request handler and takes the process down); the traversal check is file.startsWith(root) without a trailing separator; ensureCert interpolates paths into an execSync openssl command; sends Cross-Origin-Opener-Policy without COEP, which achieves nothing on its own. | Wrap decode in try/catch -> 400; compare against root + path.sep; use execFileSync with an argv array; either add Cross-Origin-Embedder-Policy: require-corp (enabling SharedArrayBuffer for a future shared-memory worker pool) or drop COOP; add X-Content-Type-Options: nosniff. |
| low | small | Precache size and first-install time | sw.js precaches vendor/three/three.module.min.js (670 KB, ~170 KB gzipped) on install even though viewer.js is dynamically imported only when a result arrives. | Either keep precaching (simplest, offline-safe) but serve a tree-shaken subset built once by a tools/ script (WebGLRenderer + BufferGeometry + three materials + OrbitControls is well under 200 KB), or move vendor/three to runtime caching and adjust the offline test to visit the viewer once first. |
| low | trivial | Deprecated or changing Web APIs in use | planeSweepGPU.js uses WEBGL_debug_renderer_info (deprecated in Chromium, gl.getParameter(gl.RENDERER) now returns the unmasked string); index.html carries apple-mobile-web-app-capable (deprecated in favour of mobile-web-app-capable, both present); createImageBitmap imageOrientation 'from-image' is now the default and the fallback branch is reached only on very old engines. | Query gl.getParameter(gl.RENDERER) first and the extension only as fallback; keep the apple meta for iOS < 17.4; leave the bitmap fallback but comment why. |
| low | small | Theme and i18n readiness | styles.css declares color-scheme: dark only; every UI string is inline in index.html and app.js (PRESET_TIPS, toasts, progress stage names). | Low priority for a solo project: add light tokens under prefers-color-scheme if desired; if a second language is ever wanted, hoist strings to src/strings.js first. |

- **Run the Playwright browser suite in CI** (high value, small, `.github/workflows/test.yml, test/browser/run.mjs`). This is the only suite that exercises cameraManager.js, storage.js, sw.js, viewer.js and app.js; today a regression in any of them ships green.
- **Service worker correctness and update flow** (high value, small, `sw.js, src/app.js`). Offline is a headline README claim and is tested, but the update path is the classic mixed-version PWA failure and the hand-listed shell will silently miss the next module.
- **Node version policy: engines and CI matrix cover EOL releases** (medium value, trivial, `package.json, .github/workflows/test.yml`). The engines field promises support for a runtime nobody tests and that no longer receives security fixes; node --test glob semantics and TextEncoder/DataView behaviour used by tests are stable on 22+.
- **Pin GitHub Actions to commit SHAs, add a permissions block and concurrency** (medium value, trivial, `.github/workflows/test.yml`). Floating tags are the supply-chain vector that hit tj-actions in 2025; the default GITHUB_TOKEN has write scopes the job does not need.
- **Add Dependabot for GitHub Actions** (medium value, trivial, `.github/dependabot.yml`). Once actions are SHA-pinned, Dependabot is what keeps the pins moving.
- **Lint and format tooling** (medium value, small, `package.json`). The codebase is dense one-liner-heavy numeric code; unused-variable and formatting checks catch exactly the class of slip already present.
- **Type-check with JSDoc and tsc --noEmit (no build step)** (medium value, medium, `jsconfig.json, src/pipeline/reconstruct.js, src/vision/planeSweep.js`). Zero runtime impact, keeps the no-build promise, and the inter-module contracts (e.g. view objects handed to computeDepthMap in both CPU and GPU form) are exactly where shape bugs would hide.
- **Refresh vendored three.js and record its provenance** (medium value, small, `vendor/three/, tools/`). Two and a half years of renderer fixes (mobile GPU handling in particular) and a reproducible update path instead of hand-copied files.
- **PWA manifest completeness** (medium value, trivial, `manifest.webmanifest, tools/make-icons.js`). Chrome's richer install prompt requires screenshots; id keeps the installed app identity stable if start_url ever changes; the combined maskable icon is visibly cropped on Android launchers.
- **Accessibility pass** (medium value, small, `index.html, styles.css, src/app.js`). The app is mobile-first and the capture screen is used one-handed at arm's length; zoom blocking and unannounced status changes are the two WCAG failures most likely to bite real users.
- **Content Security Policy** (medium value, small, `index.html`). Defence in depth for the one input the app cannot control (file names and OS camera labels), and it also blocks accidental future CDN includes that would break the offline promise.
- **Project hygiene files and releases** (medium value, trivial, `SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, package.json`). The README invites deployment to static hosts and camera-permission software attracts security reports; a disclosure path and a version history are the minimum.
- **GitHub Pages deployment workflow** (medium value, small, `.github/workflows/pages.yml`). Gives the project a canonical HTTPS URL (required for camera access) that phones can install from, and makes the sw.js VERSION bump meaningful.
- **Playwright as a devDependency instead of environment probing** (medium value, medium, `test/browser/run.mjs, package.json`). Reproducible locally and in CI; per-scenario isolation gives useful failure output instead of one aggregated exit code.
- **Global error capture and diagnostics** (medium value, trivial, `src/app.js, src/pipeline/worker.js`). Phone failures (memory kills, WebGL context loss) currently vanish; the Details pane is already the right place to surface them.
- **Dev server robustness** (low value, trivial, `server.js`). Dev-only, but the crash is trivially triggered by a phone browser probing odd URLs on the LAN.
- **Precache size and first-install time** (low value, small, `sw.js, vendor/three/`). Install on a phone over mobile data is dominated by this one file; everything else in the shell is ~150 KB.
- **Deprecated or changing Web APIs in use** (low value, trivial, `src/vision/planeSweepGPU.js, index.html, src/app.js`). Small, but the GPU info string is what appears in the Details log users would paste into bug reports.
- **Theme and i18n readiness** (low value, small, `styles.css, src/app.js`). Listed so it is a conscious non-decision; no current user need.

## Features worth adding

- **Parallel matching across a worker pool and off-main-thread photo decoding** (high value, medium). CLAUDE.md records that matching dominates long scans (about a minute of a forty-frame Balanced scan) and that fewer pairs, not cheaper comparisons, is the lever; the other lever is cores. Candidate pairs from selectCandidatePairs are independent, so reconstruct.js step 2 can post batches of (descriptorsA, descriptorsB) to navigator.hardwareConcurrency-1 sub-workers (spawned from worker.js, descriptors shared via transfer or SharedArrayBuffer once COEP is set) and collect Int32Array results; expect near-linear speedup on 4-8 core phones. Separately, app.js decodeForWorker() decodes every Blob through a main-thread canvas sequentially before posting, which janks the UI for seconds on 40 frames; transfer the Blobs instead and decode in the worker with createImageBitmap + OffscreenCanvas (both available in workers on iOS 16.4+/Chrome).
- **Incremental 'Add more shots' instead of a full rebuild** (high value, large). The viewer's 'Add more shots' button returns to capture, but the next Build re-runs features, matching and SfM for every frame. Keep the worker alive between runs (app.js terminates it per build), cache per-image ORB features, the global descriptor and verified pair geometry keyed by image id inside reconstruct.js, and on a rebuild only extract/match pairs involving new ids, then re-run SfM from the previous camera poses as initialisation (runSfM already tolerates pre-set frame.k1/f). Halves the cost of the iterate-until-it-works loop the README encourages.
- **Persist finished results and settings across reloads** (high value, small). ShotStore (src/storage.js) keeps shots so a memory-pressure reload restores them, but the finished mesh, dense cloud, cameras, stats and metresPerUnit are lost, and every setting (quality, preset, capture resolution, sequential fallback, GPU, rig) resets. Add a 'results' object store holding the transferable typed arrays plus scale, restore it in restoreShots() -> showResult(), and persist the settings object in localStorage next to the existing lensOverrides key. A user who built a five-minute scan and got a tab reload before exporting currently loses everything.
- **Live overlap and motion guidance during capture** (high value, medium). The README's single biggest cause of failure is too little overlap, discovered only after minutes of processing. Run a lightweight worker that, every ~500 ms, takes a 320px grab from the primary open camera, extracts ORB at ~500 features (extractORB with maxFeatures 500, threshold 14) and matches against the last captured frame's descriptors; show a ring on the shutter button coloured by inlier count (>150 green, 60-150 amber, <60 red 'move back toward the last shot'). Hooks: cameraManager.js for the periodic grab, a new src/pipeline/overlapWorker.js reusing fast/orb/match, app.js for the indicator.
- **Full-resolution stills via ImageCapture.takePhoto()** (medium value, small). cameraManager.grabFrame() draws the 1280x720 preview stream to a canvas, so capture resolution is bounded by the video pipeline regardless of the 1920 setting. Where 'ImageCapture' in window (Chrome/Android), wrap the open track in an ImageCapture and call takePhoto({imageWidth: caps.imageWidth.max}) in captureAll(), falling back to the canvas grab; scale intrinsics by the new width. More pixels per feature directly raises corner counts, which CLAUDE.md identifies as what sets the allowable viewpoint step.
- **Receive photos from the OS share sheet and as a file handler** (medium value, medium). Desktop users import via #file-import, but on a phone the natural flow is selecting a burst in the gallery and sharing it to Phonogeometry. Add 'share_target' (method POST, enctype multipart/form-data, files accept image/*) and 'file_handlers' (image/jpeg, image/png, image/heic) to manifest.webmanifest, handle the POST in sw.js by stashing files in the Cache and redirecting to './?shared=1', and on launch drain them into importFiles(). HEIC needs a note: createImageBitmap rejects it on Chrome, so surface a clear toast rather than the generic 'Could not read'.
- **Textured export (UV atlas) alongside vertex colours** (medium value, large). Exports carry per-vertex colour only (TSDFVolume.color averaged over views), which looks muddy on a 96-176 voxel mesh once opened in Blender or AR viewers. After surfaceNets, group triangles by the depth view whose optical axis best faces their normal (data already in depthViews/cameras), project them into that view's depthRGBA (or keep a mid-resolution copy of the image for this purpose, memory permitting), pack the charts into a 2048 atlas, and emit TEXCOORD_0 plus an image bufferView and KHR-free material in toGLB (OBJ gets an .mtl + PNG). Large effort but the single most visible quality jump for object scans.
- **Mesh simplification before export** (medium value, medium). High quality at voxelRes 176 yields hundreds of thousands of triangles; the GLB/PLY sizes and AR-viewer load times balloon. Add a quadric-edge-collapse decimator in src/mesh/meshUtils.js (positions/indices/colours in, target triangle count out, preserving component boundaries), a 'Detail' slider in the viewer toolbar (25/50/100%), and apply it in scaledGeometry() before the exporters. Reuse compactMesh for the final remap.
- **Copy diagnostics button** (medium value, trivial). Failures on real phones are hard to reproduce. Add a 'Copy diagnostics' button next to Details on the processing screen (and in the failure banner) that copies to the clipboard: the full #progress-log, stats, quality/preset/settings, navigator.userAgent, hardwareConcurrency, deviceMemory, the GPU renderer string logged by createGpuSweeper, and the worker error stack (currently discarded by app.js). Also offer it as a text download via the existing download() helper for browsers without clipboard access.
- **Auto-skip near-duplicate frames and warn on gaps before building** (medium value, small). The pipeline already computes a 12x12 global descriptor per frame (reconstruct.js globalDescriptor) and a sharpness score. Before matching, drop frames whose global-descriptor correlation with the previous kept frame exceeds ~0.995 and whose shot index is adjacent (standing-still duplicates), logging them as 'skipped: duplicate of frame N'; conversely, if consecutive frames correlate below ~0.6 emit a 'large jump between shots N and N+1' warning into the Details log and the pre-build note in updateCounts(). Cuts wasted pair matching and tells the user where the chain is likely to break.

## Code quality

- **runSfM is a 600-line closure with a dozen nested functions and shared mutable state** (high value, large, `src/vision/sfm.js`). camR, camT, registered, tracks, nodeTrack, failed, chainFailed, retryPass, rigTransforms and rigRef are closed over by verifyPair, addPairToTracks, tryTriangulate, triangulateNewTracks, runBA, tryChainRegistration, estimateRig, tryRigRegistration, registerLoop and mergeDisconnectedComponent. tryChainRegistration (defined ~line 236) reads 'failed' and 'retryPass', which are declared with const/let ~180 lines later; it only avoids the temporal dead zone because registerLoop() happens to be invoked after those lines. registerLoop's body is mis-indented (lines 419-455). Refactor into a class (IncrementalSfM) holding the state explicitly, and move the rig code (estimateRig, tryRigRegistration, mergeDisconnectedComponent, averageRotations, angleTo) to src/vision/rig.js so the two 'must fail closed' checks CLAUDE.md calls out can be unit-tested in isolation.
- **reconstruct() is one 300-line function covering six stages** (high value, medium, `src/pipeline/reconstruct.js`). Lines 160-493 do preprocessing, matching, SfM, neighbour selection, plane sweep, dense sampling, focus cropping, fusion and meshing in one scope with ~40 locals. Split into extractFrames(), matchCandidates(), sparseReconstruct(), selectNeighbours(), denseDepth(), sampleDense(), fuseAndMesh() sharing a small context; then the per-stage tests (see missing tests) become possible without rendering whole scenes. Small cleanups on the way: 'midDepth = percentile(depths, 0.5)' inside the neighbour loop recomputes the 'median' already held; 'neighborIdx.map((nbs) => nbs)' is a no-op copy; 'Float32Array.from(denseColors)' copies an array that is transferred anyway; 'const src = f.depthRGBARaw || f.depthRGBA' can only be the Raw one at that point; there is a stray double blank line before nDense.
- **Missing unit tests for pipeline helpers that only e2e touches** (high value, small, `src/pipeline/reconstruct.js, src/vision/orb.js, src/vision/fast.js, src/mesh/tsdf.js, src/mesh/exporters.js, src/vision/linalg.js`). Add: test/candidatePairs.test.js (export selectCandidatePairs; below maxPairs all pairs; window pairs always kept; same-shot frames kept; a loop-closing frame with a near-identical global descriptor is picked via the similarity slots while neighbours are excluded from those slots). test/focus.test.js for opticalAxesFocus (8 cameras orbiting the origin -> point within 1e-6 of origin; outward-looking room cameras -> null; fewer than 3 -> null; 'front' fraction check). test/orb.test.js (descriptors of a synthetic image and its 30-degree rotation match with >50% mutual inliers; keypoints spread across gridCells). test/fast.test.js (a single synthetic corner yields exactly one keypoint after NMS with the tie-break). test/tsdf.test.js for sampleColor trilinear weights and fitVolume (dims >= 8, percentile trimming of an outlier point, null for empty input). exporters: toPointCloudPLY byte length and GLB COLOR_0/NORMAL accessor counts. linalg.similarityTransform: collinear input reports planarity ~0 and a known scale/rotation is recovered to 1e-9.
- **Service worker shell list has no test** (high value, trivial, `sw.js`). SHELL is a hand-typed list of 30 paths. Add test/sw.test.js that reads sw.js, extracts the SHELL array with a regex, and asserts it equals the set of git-tracked files under src/, vendor/, icons/ plus index.html, styles.css and manifest.webmanifest; also assert VERSION changed when any listed file changed (compare a stored hash) or generate VERSION from that hash.
- **Two dozen tuned thresholds are inline magic numbers** (medium value, small, `src/pipeline/reconstruct.js, src/vision/sfm.js`). reconstruct.js: 20 (min matches per pair), 15 (min shared points for a neighbour), 1.0/50 (parallax degree bounds), 8/25 (angle score knees), 10 (min sparse depths), 0.6/1.6 and 0.15/6 (depth range factors), 6000 (dense samples per view), 300 (min dense samples), relTol 0.04, pixelThreshold 2.0, margin 0.06. sfm.js: 12 (min tracked points for PnP), 10 and 0.3 (PnP inlier floor), 6 deg (rig sample rejection), 4 deg (rig spread limit), 8 deg (merged rig spread), 0.08 (path residual vs scene scale), 0.02 (planarity), 0.25 (rig verification fraction), 0.2 (chain scale consistency), 0.75 (trimmed fit). CLAUDE.md already documents why several were chosen; hoist them into a named TUNING object (or per-module constants) with those one-line rationales so future tuning is a diff to one place and tests can override them.
- **CPU and GPU plane sweeps duplicate the homography setup** (medium value, small, `src/vision/planeSweep.js, src/vision/planeSweepGPU.js`). Both files define intrinsics(v) and the A = Kn R Kr^-1, B = Kn t row(Kr^-1)[2] construction (planeSweep.js 32-41, planeSweepGPU.js 221-229), the inverse-depth plane schedule, keep = ceil(k/2), win = (2r+1)^2 and the maxCost = 1 - minZncc rule. CLAUDE.md requires the two to stay behaviourally identical; extract src/vision/planeSweepCommon.js with neighbourHomography(), planeDepths(numPlanes, dmin, dmax) and the shared constants so the invariant is enforced by sharing rather than by discipline, and add a node test that both produce the same depth on a 32x24 synthetic view when a headless-gl-free CPU path is used (the GPU test remains browser-only).
- **app.js mixes five screens' logic and duplicates the frame minimum** (medium value, medium, `src/app.js`). 686 lines cover camera tiles, lens settings, capture, import, shot list, reconstruction orchestration, preview/result display, measurement, stats, exports and wiring. MIN_FRAMES = 3 is declared inside updateCounts() and hard-coded again as 'frameCount() < 3' in reconstruct(), while README says 'Four photographs is about the fewest ... Fewer than that, and the app will not offer to build'. Lines 61-62 are two consecutive versions of the same comment. state gains failed, stats and measuredUnits at runtime without being declared. importFiles() stores a display string ('26mm eq.') in the frame.lens field that elsewhere holds a LENS_TYPES key. Split into src/ui/capture.js, src/ui/process.js, src/ui/viewerScreen.js with app.js as wiring; export one MIN_FRAMES from reconstruct.js and reconcile the README.
- **Initial preset tip in index.html contradicts PRESET_TIPS and the README** (medium value, trivial, `index.html, src/app.js`). index.html #preset-tip ships with 'capture every 20-30 deg ... Aim for 12-30 shots', while PRESET_TIPS.object in app.js says 'a hand-width of sideways movement ... 20-40 shots' and the README's measured guidance is 8-12 deg apart (beyond 16 deg the scan breaks). A first-time user reads the wrong advice until they click a preset. Set the tip from PRESET_TIPS in init() and remove the literal from the HTML.
- **exif.js reads a tag it never uses and has no tests** (medium value, small, `src/camera/exif.js`). readIfd fetches 0x920a (FocalLength) alongside 0xa405 but only 0xa405 is used, so a JPEG with FocalLength and no 35mm-equivalent yields null; the orientation tag is parsed and returned but unused by app.js (createImageBitmap handles it). Either drop the dead reads or add the fallback (FocalLength with FocalPlaneXResolution/Unit, else a 4.2 mm sensor-width guess). Add test/exif.test.js building minimal JPEG APP1 segments in-memory: little- and big-endian TIFF, missing EXIF IFD, truncated file, rational with zero denominator; expect hfov to within 0.01 deg for a 26 mm equivalent (~69.4 deg).
- **Lens/facing heuristics are untested and fragile** (medium value, trivial, `src/camera/intrinsics.js`). guessLens matches /uw/ as a substring (any label containing 'uw' becomes ultra-wide) and /camera/ as a catch-all for 'wide'; /3x|5x/ relies on the earlier /0\.5x/ branch to avoid misclassifying '0.5x'. Add test/intrinsics.test.js with real labels: 'camera2 0, facing back', 'camera2 2, facing back ultra wide', 'Back Ultra Wide Camera', 'Back Triple Camera', 'Back Telephoto Camera', 'FaceTime HD Camera', 'Front Camera', 'Integrated Webcam'; also focalFromFov round-trips and loadLensOverrides tolerating corrupt JSON. Anchor the regexes with word boundaries.
- **Viewer leaks materials and renders continuously** (medium value, small, `src/viewer/viewer.js`). setPreview()/setResult() allocate a new PointsMaterial and LineBasicMaterial per call and clear() only disposes geometries; dispose() never disposes this._materials and app.js never calls dispose() anyway. The render loop runs requestAnimationFrame unconditionally while the viewer screen is hidden, draining battery on the capture screen after a first build. Render on demand (controls 'change' event + after setResult/setLayer/setMode + one frame after resize), dispose materials, and dedupe the geometry-dispose loop shared by clear() and clearMeasurement(). setPreview also computes box.getSize(...).length()/2 three times.
- **Hot-loop micro-inefficiencies in the numerics** (medium value, small, `src/vision/orb.js, src/vision/image.js, src/mesh/meshUtils.js, src/mesh/surfaceNets.js`). orb.describe() rotates all 512 pattern points with cos/sin and Math.round per keypoint; precomputing 30 rotated patterns (12-degree bins, as OpenCV does) removes ~1.5 M trig/round calls per frame at 3000 features. image.medianFilterDepth allocates Array.from(buf).sort() per pixel; an insertion sort on the 9-slot Float32Array buffer is allocation-free. meshUtils.buildAdjacency creates one Set per vertex (100k+ Sets at High quality); a CSR layout (Int32Array offsets + neighbours) halves memory and speeds Taubin smoothing. surfaceNets pushes into plain arrays then copies into typed arrays; count cells first or grow typed arrays geometrically. None change results, so the existing tests cover them.
- **Test helper duplicates the production Umeyama fit** (low value, trivial, `test/helpers.js, src/vision/linalg.js`). fitSimilarity in test/helpers.js re-implements similarityTransform from linalg.js with the transposed H convention and different return names (rotation vs R). Either have the tests import the production function (and gain a check that it agrees with the test oracle once), or keep the helper but add one assertion that both produce the same scale/residual on random data.
- **PNG encoder duplicated between tooling and test fixtures** (low value, trivial, `tools/make-icons.js, test/browser/fixtures.mjs`). crc32(), chunk() and png() are copied verbatim (fixtures.mjs takes rgba, make-icons.js takes a pixel function). Move them to tools/png.js exporting encodePNG(w, h, rgba) and have make-icons build its rgba buffer first.
- **Synthetic renderers repeat the ray-cast boilerplate** (low value, small, `test/synthScene.js`). renderRoom, renderObject and renderFurnishedRoom each recompute the camera centre from (R, t), the per-pixel ray direction and the box-face intersection; renderRoom is renderFurnishedRoom with no spheres apart from the colour tint. Extract cameraRays(cam, w, h, f, cx, cy, k1) and intersectBox()/intersectSphere() primitives; keep the colour differences as parameters so existing test thresholds still hold.
- **Storage layer small issues** (low value, small, `src/storage.js, src/app.js`). saveShot maps frames with '{ ...f, thumbUrl: f.thumbUrl }' (redundant) and persists transient flags (used, soft, softReference) that are recomputed anyway; captureShot() and importFiles() fire store.saveShot() without awaiting, so a reload in the next few hundred milliseconds loses the shot the toast just confirmed; thumbnails are stored as base64 data URLs next to the JPEG Blob (double storage); DB version 1 has no migration hook for the results store proposed above. Await the save before updating the status line, store the thumb as a Blob and mint object URLs on restore, and centralise the record shape.
- **Browser-facing error messages pass raw DOMException text through** (low value, trivial, `src/app.js, src/camera/cameraManager.js`). startCameras() and captureShot() toast 'Camera access failed: ' + err.message and 'Capture failed: ' + err.message, so users see 'Permission denied', 'Could not start video source' or 'Requested device not found' verbatim, whereas the pipeline takes care to throw human-readable errors. Map NotAllowedError, NotReadableError, OverconstrainedError and NotFoundError to actionable sentences (e.g. 'Camera permission was refused; allow it in the browser site settings and tap Enable again') in one helper used by both call sites.
- **Undocumented tricky spots** (low value, trivial, `src/mesh/surfaceNets.js, src/vision/ba.js, src/vision/sfm.js`). surfaceNets' face emission (the 'sign & 1' test choosing winding for each axis edge from corner 0, and why cells at pos[u]==0 || pos[v]==0 are skipped) has no comment while the rest of the file is well annotated; ba.js derives the k1 and focal-scale Jacobian entries (Jc[6], Jc[7]) with a one-line comment that does not state the model f*s*(u D, v D) being differentiated; sfm.js tryChainRegistration's scale recovery from '(a + s t) parallel to x' deserves the closed form s = -(a x x).(t x x)/|t x x|^2 spelled out. Three short comments; the numerical correctness is already covered by tests.
- **Sequential-fallback capture reopens cameras with different constraints than it captured with** (low value, trivial, `src/camera/cameraManager.js`). captureAll() opens a pending camera at {width: maxDim, height: maxDim*0.75} (4:3), captures, closes it, then reopens the released cameras via openCamera(c) with the default {1280, 720} (16:9) regardless of the maxDim in effect, while openAll() is called from app.js with {1280, 720}. On phones where the 4:3 and 16:9 stream modes come from different sensor crops the horizontal field of view differs, so intrinsicsFor() assigns the same hfov to frames that do not share it within one focalGroup. Thread one 'preferred stream constraints' value through openAll/captureAll and derive the sequential constraints from it.

## Shared across all Platteration repositories

The same gaps recur in every repository; fixing them once as a template and copying it is cheaper than fixing them fourteen times.

### CI and supply chain

1. **No workflow sets `permissions:`** (except the two Pages deploy jobs). Add `permissions: { contents: read }` at the top of every workflow so the `GITHUB_TOKEN` handed to third-party actions cannot write to the repository.
2. **No action is pinned to a commit SHA** (0 of 50 `uses:` lines across the fourteen repositories). `actions/checkout@v4` follows a movable tag; pin to the full 40-character SHA with the version in a comment, and let Dependabot bump it.
3. **No repository has Dependabot or Renovate.** Add `.github/dependabot.yml` with `npm` (or `pip`) and `github-actions` ecosystems, weekly.
4. **No CI step runs `npm audit`** (two workflows pass `--no-audit` explicitly). Add `npm audit --audit-level=high` after `npm ci`; for the Expo apps the current transitive advisories are build-time only (`uuid` via `xcode` via `@expo/config-plugins`), so gate on `high` rather than `moderate` until Expo ships the fix.
5. **`tvsham` runs `npm ci || npm install` in CI and in its Dockerfile.** The fallback silently discards the lockfile guarantee; drop it and fix the lockfile instead.
6. **`selfreportle`, `simplacad` and `phonogeometry` have no lockfile** and install Playwright ad hoc in CI. Add a `package-lock.json` (even with devDependencies only) and use `npm ci`.
7. **Enable secret scanning and push protection** in each repository's settings; nothing is committed today, and this keeps it that way.

### Repository hygiene

8. **Ten repositories have no `LICENSE`** (battleshiple, collectcollect, drawdraw, multidcheckers, multidconnect4, notenote, randostats, selfreportle, simplacad, tvsham). Without one, nobody else may legally use or contribute to the code. The siblings that have one use MIT.
9. **Only `simplacad` has a `SECURITY.md`.** Copy it to the others with a private reporting address.
10. **No repository has a `main` branch.** In all fourteen the default branch is the original `claude/...` feature branch, so branch protection, Dependabot targets and the two GitHub Pages workflows (`abientnoiser`, `chesscheatser` both trigger on `main`/`master`) all point at a branch that does not exist; those deploys have never run. Create `main` from the current branch, make it the default, and protect it.
11. **`drawdraw` is the one repository still on Expo SDK 53** (the rest are on 57). Its eight high-severity `npm audit` findings (`image-size`, `metro`) disappear with the SDK upgrade; it is also the only app not written in TypeScript and the only one pinned to Node 20 in CI.
12. **`multidcheckers` and `multidconnect4` are near-identical copies** (same branch name, same 65-file layout, same dependencies). The timeline/multiverse engine, persistence and share code should live in one shared package so fixes land in both.

### A hardened workflow to copy

```yaml
name: CI
on:
  push:
    branches: ["**"]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<full-sha> # v4
      - uses: actions/setup-node@<full-sha> # v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint --if-present
      - run: npm run typecheck --if-present
      - run: npm test
```
