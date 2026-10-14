# Phonogeometry

Read AGENTS.md first. It holds the working rules every coding agent follows in this repository; this file adds the notes specific to this project.

Progressive web app that captures from every camera on a phone at once and reconstructs
textured 3D meshes on-device. Plain ES modules, no build step, no runtime dependencies
(three.js is vendored in `vendor/three`). The website's optional API (sign in with Google and
"Support this app", off until the owner sets it up: see Sign-in and support) is the shared kit in
`server/kit/`, plain ES modules with no dependencies either.

## Commands

- `npm test` runs the node:test suites in `test/` (synthetic scenes with ground truth) and the
  shared kit's own self-test, `server/kit/selftest.mjs`.
- `npm run check` is the gate before a push: `npm test`, then `npm run test:conventions`.
- `npm start` serves over HTTP on :8080 (desktop development, photo import only).
- `npm run start:https` serves over HTTPS with a self-signed certificate (phones need a
  secure origin for camera access).
- `npm run test:e2e` runs the application end to end in Chromium (multi-camera capture, a
  good scan, a hopeless one, exports, reload, the website, offline). The sections at the dev
  server run under the policy `index.html` carries in its `<meta>` and fail on anything it
  refuses. The website step copies the site with `tools/site.js` (the files `pages.yml`
  publishes) and serves it from `/phonogeometry/` on a server of its own, as GitHub Pages serves
  a project site, sending every response the headers `_headers` writes and answering a missing
  address with `404.html`; it drives the main flow there (Chromium's own fake camera, so the
  Permissions-Policy decides, import, a build, the viewer, the exports, the worker's install,
  the manifest) and fails on any violation, console error, page error, request outside that
  sub-path or for a missing file. It also checks Trusted Types are enforced, the 404 page, that
  the repository's files are not published, framing, and the safety net. Then it checks that a
  file changed on the host reaches the worker's cache, and closes that server: Playwright's
  `setOffline` does not reach a service worker's own fetches, so a worker answering from the
  network would pass with the host still up. Its last section serves the site again with the
  API answering `api/` and goes through the account and Support this app under the same policy
  (see Sign-in and support). `test/browser/fakeCameras.mjs` stands
  in a phone with three lenses and an adjustable limit on how many can stream at once, which
  is the only way to exercise the capture path: Chromium's own fake device provides one
  camera. Its lenses draw on canvases kept in memory (`willReadFrequently`): captured from a
  GPU canvas under the suite's SwiftShader, a stream's first frame came seconds late or only
  once the track was stopped, and the camera checks passed or failed on timing. It starts its
  own server and renders its own photographs, and skips itself when Playwright is absent, so it is safe to run anywhere:
  `REQUIRE_BROWSER=1` turns that skip into a failure, which is how CI runs it (the workflow
  installs a pinned Playwright with `npm install --no-save`, so the repository keeps no
  dependencies). Every job runs on `ubuntu-24.04`, never `ubuntu-latest`, which GitHub moves to
  Ubuntu 26.04 from 2026-10-19, where 1.56.1's browser install stopped; `test/ci.test.js` reads
  the release the job that installs the browser names and holds the pin to the first Playwright
  with a Chromium build for it (1.45.0 for 24.04, 1.61.0 for 26.04, read off each release's
  playwright-core), so moving the runner and raising Playwright are one change. After the
  browser suite, `test/hosts.mjs` runs `deploy/nginx.conf`
  in the nginx installed here and the site's `.htaccess` in Apache, each serving the copied
  site with a checkout's files planted in it, Apache over TLS and behind a stand-in for a
  TLS-ending proxy: every site file 200 with `_headers`' headers, everything else the not-found
  page with them, plain http a 301, and a `Server` header naming no version (nginx's
  `server_tokens off`, the `ServerTokens Prod` README gives Apache's server configuration).
  Neither showed in any other suite: `http2 on;` stopped nginx
  1.24 loading the file, and Apache's `env=HTTPS` dropped HSTS behind a proxy. It also runs the
  API (`server/start.mjs`) behind nginx's `/api/` location and an Apache `ProxyPass`, then stops
  it: nginx must then answer as a site with no API (the folder's `api/config`, the not-found page
  for the rest, the site's headers), where it used to send its own 502 page with HSTS alone, and
  Apache with the `ProxyPass` answers 503, as the README says. It skips
  where a server is missing unless `CI` is set (GitHub sets it on every runner).
  The GPU plane sweep check is a page, `test/browser/index.html`, opened through the dev
  server. Offline behaviour has to be tested over `http://localhost`, which browsers count as
  a secure context: a self-signed certificate blocks service worker registration outright, so
  the HTTPS dev server cannot exercise it. Headless Chromium via Playwright works with fake camera devices
  (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`).
- `.github/workflows/pages.yml` publishes to GitHub Pages on a push to `main` (which exists,
  at `fed2c5f`, older than this work, and has to be a branch the `github-pages` environment
  accepts: by default the default branch; its one deploy, on 2026-09-23, built the site and was
  refused because Pages is not enabled for the repository) or by hand (offered only once the
  file is on the default branch):
  `npm test`, then a `git archive HEAD` of exactly the files the app serves (the page, its
  stylesheet, manifest and icons, `sw.js`, `src/`, and `vendor/three` with its licence, plus
  `404.html`, `robots.txt`, `.well-known/security.txt` and `api/config`), no build step.
  `test/pages.test.js` holds that list equal to the worker's `SHELL` plus `EXTRA` in
  `tools/site.js` (the files beside the shell), and to `node tools/site.js --list`, so a module
  added to one and not the other fails `npm test`, and pins the
  workflow line for line: the build job is checkout (no persisted credentials), Node, the
  tests, the assembly and the upload (with `include-hidden-files: true`: from v4 the upload
  action leaves out every path that starts with a dot, `.well-known/security.txt` with it), and
  only the deploy job holds `pages: write` and
  `id-token: write`, so a step, scope or trigger added to it fails there first. `sw.js` goes
  out as committed, not re-stamped per deploy: its `VERSION` is a hash of the shell files'
  contents, which `test/sw.test.js` recomputes (printing the value to paste in), so a deploy
  that changes a shell file reaches an installed copy as a new worker that caches the whole
  shell afresh, and one that changes none (a README edit) makes nobody download it again. The
  worker is network first and writes each shell file it fetches back into its own cache,
  cloning the response before the page reads it (a clone taken after throws, and for a long
  time nothing was written); that refresh covers only what a visit loads, so it is not how a
  deploy arrives. It keeps one copy per file: a URL with a query string (the `?fbclid=` a social
  site appends to every click) is fetched and never written, since keyed by it each link was
  another copy nothing read back, and a navigation is matched with `ignoreSearch`, so offline
  such a link still opens the page. A navigation the host answers with a redirect goes to the
  browser, never the cached page: a navigation's fetch resolves to an `opaqueredirect`, which is
  not `ok`, and while the cache won it a site that moved kept every installed copy at the old
  address on the old build for good (the update check of `sw.js` is redirected too, and a
  worker's script may not be). A cache that will not open counts as a miss, not as a failure:
  `lookup` heads the fetch handler's chain, and `caches.open` can reject where a match cannot (an
  evicted quota, a broken backend), so an uncaught rejection there is a network error for
  every request the worker intercepts, the page itself included, online or offline.
  `test/sw.test.js` stubs the worker's globals and drives the real fetch handler against a
  cache that refuses to open, which no browser stages on demand. `sw.js` is not one of the
  hashed shell files, so a change to the worker alone leaves `VERSION` where it is: the new
  bytes are what reinstall it.

## Layout

- `src/app.js` UI and flow; `src/camera/` device discovery, capture, intrinsics, EXIF;
  `src/storage.js` IndexedDB shot persistence; `src/guard.js` the safety net, `src/trust.js` the
  Trusted Types policy (see Website); `src/account.js` the Account section and Support this app
  (see Sign-in and support).
- `server/kit/` the shared sign-in, shop and webhook kit; `server/catalogue.js` what the site
  sells; `server/start.mjs` the API on a host of its own; `functions/api/[[path]].js` the API on
  Cloudflare Pages. None of it is published as a file of the site.
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

## Settings

Two localStorage records, both named in `src/prefs.js` (`KEYS`) and pinned as literals by
`test/settings-contract.test.js`. `phonogeometry.prefs.v1` holds the four controls of the
settings dialog (`captureRes`, `sequential`, `gpu`, `rig`): read once in `init()` through
`cleanPrefs`, written on every change. `phonogeometry.lensOverrides.v1` holds the per-camera
lens and field-of-view overrides: migrated from the unversioned `phonogeometry.lensOverrides`
at its one read site (`loadLensOverrides`, which copies the bytes and deletes the old key only
once the write has succeeded) and checked by `cleanLensOverrides` in `src/camera/intrinsics.js`,
which returns a null-prototype object because the camera label is the key. Every read goes
through a validator, `has` is an own-property lookup, and `test/prefs.test.js` walks
`Object.getOwnPropertyNames(Object.prototype)` through both records. There is no Theme row: the
app has one dark palette (`color-scheme: dark`) and no theme preference. There is no Reset:
four controls, each one click from its default. The About block's version is `APP_VERSION` in
`src/version.js`, pinned to `package.json`; the `VERSION` in `sw.js` is the service worker's
cache name, a hash of the shell files, and is not that. The shots are IndexedDB
(`src/storage.js`), not a preference, and none of this touches them. Nor is the account: the
page keeps nothing about it (the API's session cookie is HttpOnly, and `api/me` is asked afresh
on every load) but one sessionStorage record, `phonogeometry.purchasePending.v1`
(`SESSION_KEYS` in `src/prefs.js`, pinned beside `KEYS`): `{ at }`, written when Checkout sends
the tab back with a purchase `api/me` has not reported yet, read by `src/account.js`, which
offers no Buy within `PENDING_MS` (ten minutes) of it, and removed once the purchase is reported
or the account signs out or is deleted. It is the tab's own and ends with it; a value that is
not a number of milliseconds in that window counts as none.

## Website

The app is also a website, on the art app's model: everything still happens in the browser,
and the host only serves files and the headers around them (and, where it runs the optional API,
answers `api/`: see Sign-in and support). The site is `node tools/site.js --list` (the worker's
`SHELL` plus `EXTRA`: `sw.js`, three.js's licence, `404.html`, `robots.txt`,
`.well-known/security.txt`, `api/config`); `tools/site.js <folder> --host=…` copies it, and the
settings that host reads (`--host=cloudflare` adds `_routes.json`), into an empty folder.
Nothing is built.

- **One policy, five places**: `_headers` (Netlify, Cloudflare Pages), `.htaccess`,
  `deploy/nginx.conf`, and the `<meta>` of `index.html` and `404.html`, which leaves out
  `frame-ancestors` (a `<meta>` cannot carry it) and `upgrade-insecure-requests` (so the dev
  server still serves another device over plain http). `test/website.test.js` holds them equal,
  and walks every repository file through the nginx, Apache and Netlify rules (nginx and Apache
  allow a pattern of the site's paths; `_redirects` lists the repository's top-level entries, so
  a new one goes there too). Change one, change all five. No nginx location adds a header of its
  own (one that did would drop all of the server block's there), but the API's, `location ^~
  /api/`, whose one `add_header` is the server block's HSTS line as written there: the API sends
  its own headers, and the site's would contradict them. Nothing in `.htaccess` sits in an
  `<IfModule>`: a stock Debian or Ubuntu Apache loads neither mod_rewrite nor mod_headers, and
  wrapped, the rules were skipped without a word, so a checkout served by mistake published
  `.git/` and `.certs/key.pem` with no headers (measured on Ubuntu's 2.4.58). Unwrapped, a
  missing module is a 500 and a line in the error log; the website test holds it so. Every
  `Header` in `.htaccess` is unconditional, HSTS included: `env=HTTPS` is mod_ssl's alone, so
  behind a TLS-ending proxy (whose `X-Forwarded-Proto: https` the redirect lets through) it
  dropped HSTS. nginx asks for HTTP/2 with `listen 443 ssl http2;`, never `http2 on;`, which
  nginx before 1.25.1 (Ubuntu 24.04 ships 1.24) does not know and refuses the whole file over.
  The website test holds those lines, the https redirects and the not-found pages; `test/hosts.mjs`
  runs both files in the real servers.
- **Every source was measured** in Chromium with the policy sent as a header at a sub-path:
  `img-src data:` is the shot thumbnails (JPEG `data:` URLs); `connect-src 'self'` is the
  service worker (with `'none'` it registers and caches nothing, silently) and the account's
  requests to the site's own `api/` (Google and Stripe are top-level navigations, which the
  policy does not govern, so it names neither); `manifest-src
  'self'`; `form-action 'none'` leaves the `<form method="dialog">` dialogs working;
  `camera=(self)` and `screen-wake-lock=(self)` are the two features the app uses (with `()`,
  `getUserMedia` and the build's wake lock are refused), and the muted previews play with
  `autoplay=()`. Web Share is left out of the Permissions-Policy because Chromium on Linux
  reports it unrecognised; unlisted, it stays the browser's default (this origin).
- **Hashes**: `script-src` carries the sha256 of the import map in `index.html` and `style-src`
  that of `404.html`'s `<style>`; the test recomputes both and prints the new value. Editing the
  import map or that style means pasting the new hash into all five places, and since
  `index.html` carries both hashes in its `<meta>` and is a shell file, either edit changes
  `VERSION` too.
- **Trusted Types are enforced** (`require-trusted-types-for 'script'; trusted-types
  phonogeometry`). `new Worker()` and `serviceWorker.register()` take a TrustedScriptURL, so both
  go through `scriptURLs()` in `src/trust.js`, whose one policy vouches for exactly
  `src/pipeline/worker.js` and `sw.js`. No script writes HTML; the vendored three.js has one
  sink (`DOMParser` in `FileLoader`'s document mode), on a network path the app never takes.
- **The safety net**: `<html class="no-js">`, and `src/guard.js` loads first from `<head>`. With
  JavaScript off, a site file that fails to load, a throw from one of the site's own scripts, or
  a load event with the app not started, `#start-note` shows and the controls are hidden.
  `init()` in `src/app.js` adds `started` (and removes `no-js`) as its last step; after that the
  app reports its own failures. Inside another page's frame the note shows too, and `init()`
  returns before wiring or restoring anything: Pages cannot send `frame-ancestors`, and a
  frame's storage is partitioned by the top-level site, so in a frame on a page of the same site
  (on a custom domain, any other subdomain of it) in every browser, and on any page in a browser
  that does not partition, the app held the visitor's shots and a steered click on a shot's x
  deleted one. The browser suite stages that same-site case: its framer is `localhost` at
  another port, as the site is (`127.0.0.1` would be another site, whose frame a partitioning
  browser keeps away from the shots), and it reads the visitor's shot out of the database from
  inside the frame before it counts the app showing none.
- The shots database is the origin's, so on Pages every app the account publishes can write it.
  `loadAll` restores a record only through `cleanShot` in `src/storage.js` (`frames` a list, each
  frame an object), leaves out and counts the rest, and the restore toast says how many: one
  record whose frames were not a list stopped the shot list on every launch, and every capture
  after it was saved but never shown. A left-out record stays on the disk for the day rule and
  Clear, like any other. The fields the shot list sets as text, a frame's `label` and
  `thumbUrl`, are shown as nothing when they are not strings (text from `{toString: 0}`, which
  the database stores as it is, throws: the same stopped list), and only a number is a
  `createdAt` (`dateOf`): anything else is a record with no date, deleted as an old one is,
  where an object there threw out of the restore and emptied the list, with nothing said.
- On GitHub Pages only the `<meta>` applies, and only to the page: a worker takes its policy from
  the response that delivered its script, so there the reconstruction worker and the service
  worker run without one. `.well-known/security.txt` expires on 2027-10-08 and the website test
  fails once it has: renew it, a year ahead at most. Its contacts are the private report form,
  then the issues page, since the form is off until the owner switches it on, and its policy
  link is `SECURITY.md` on `main`, the branch the deploy publishes (the default branch has none).

## Sign-in and support

The owner asked every app of the account to be ready for sign in with Google, a shop and Stripe's
webhooks: per-app functions on the site's own origin, Stripe Checkout, web first. This app sells
one thing, "Support this app" (one-time, granting `supporter`), which changes nothing but a line
of thanks in About. The specification is the kit's README (`server/kit/README.md`).

- **The kit is shared and not ours to edit.** `server/kit/` is the canonical copy, byte for byte,
  its nine `.d.ts` declaration files included (21 files; `diff -r` against the canonical copy is
  empty, and the conventions test holds the copy to the canonical hash). The declarations are
  types for the TypeScript apps that import the kit, and nothing here reads them; they need no
  TypeScript here either, since the conventions count a declaration file as no source for
  `npm run typecheck` to reach, so the repository keeps no dependencies. A change the kit needs
  is made to the canonical copy and copied to every app. `npm test` runs its self-test here.
- **Off until configured, and drawing nothing then.** `src/account.js` asks `api/config` once,
  from `init()` after the frame check, and not at all when `navigator.onLine` is false (a request
  bound to fail would be a console error on every offline load). A 404, a network error, a body
  that is not the kit's shape, or sign-in off (the folder's own `api/config`, which equals the
  kit's answer with nothing set, and is published so that a host with no API answers rather than
  404s) leaves `#account` and About's account sentence hidden. So does sign-in on with nothing
  for sale (Google's variables set, Stripe's not), for a visitor not signed in: signing in would
  change nothing here; a visitor still signed in from before gets the section, to sign out or
  delete the account. Where it is on, Settings shows the Account section and the product, About's
  privacy sentence is swapped for the one that says what an account sends where (the email kept
  while signed in, the account id Stripe is told with a payment: `test/api.test.js` holds the kit
  to both), and a supporter reads the thank-you. Everything from the server is read field by
  field and drawn with `createElement` and `textContent`; Buy follows only a
  `https://checkout.stripe.com/` address; Delete account is confirmed with `window.confirm` (the
  app's confirm), saying the support goes with it.
- **No second Checkout for a payment on its way.** Stripe's webhook can land after the visitor
  is back, and Cloudflare KV can take a minute more to reach every location. So after
  `?purchase=success`, for a signed-in visitor, the product reads "Payment received —
  processing" where Buy was until `api/me` reports it: for the life of the page, and across a
  reload within `PENDING_MS` through the sessionStorage record above. Before, Buy came back after
  the fifteen-second poll and a second press charged the visitor twice. A `?purchase=success`
  link opened by someone not signed in says nothing and asks nothing. The kit now guards the API
  side as well (its README, Limits): it remembers the Checkout it gave a visitor for a product,
  gives a second Buy that same session while it is open, and once Stripe reports it paid answers
  409 `payment_pending` until the webhook's record is there, so a press from another tab, or after
  the page's hold has lapsed, is never a second payment; `test/api.test.js` holds that with this
  catalogue, against a fake Stripe that serves the session lookup and answers a repeated
  Idempotency-Key with its first answer. The page reads every 409 as owned and asks `api/me`
  again. Presses from two sign-ins of the account at once can still each make a session (the
  kit's README says when); the page's hold stays for those.
- **The service worker leaves `api/` alone.** `sw.js` returns before `respondWith` for anything
  under `api/` beside it (`API`, from its own address, so a sub-path deploy works): no cache
  is opened, nothing is written, and the sign-in navigations (the start, Google's redirect back
  to the callback) reach the API untouched. `test/sw.test.js` and `test/sw-subpath.test.js`
  drive the handler; the browser suite checks no API answer came from the worker and none is in
  its cache.
- **Hosting.** Cloudflare Pages runs `functions/api/[[path]].js` (three lines into the kit's
  `pagesHandler` with `server/catalogue.js`), with `_routes.json` (`--host=cloudflare`) sending it
  `/api/*` alone and a KV namespace bound as `KIT_STORE`; `_headers` does not reach a function's
  answer and `_redirects` does not apply to it, so the kit sends its own headers. Self-hosted,
  `server/start.mjs` (the kit's Node adapter, 127.0.0.1:8788, records under `KIT_DATA_DIR`)
  sits behind nginx's `location ^~ /api/` or an Apache virtual host's `ProxyPass` (`.htaccess`
  cannot proxy). With the process not running, nginx hands its own 502/503/504 (never the API's,
  since `proxy_intercept_errors` stays off) to `location @api-off`, which serves the folder's
  `api/config` and the not-found page for the rest with the server block's headers
  (`recursive_error_pages` lets that second error page follow); Apache answers 503, so the README
  says to add the `ProxyPass` once the process runs. GitHub Pages and Netlify run nothing, and
  the folder's `api/config` answers.
  `test/hosts.mjs` runs the API behind the real nginx and Apache.
- **Tests.** `test/api.test.js` (the catalogue, the Pages entry over a fake KV, `server/start.mjs`
  over a loopback socket, the static `api/config` equal to the kit's answer), `test/account.test.js`
  (the client on a fake page for every answer), and section 5 of the browser suite: the whole
  flow under the site's headers with the worker in control. Google and Stripe are faked through
  the kit's `fetch` (`test/apiFakes.js`), never through a variable naming another host.
  Playwright routes a request but not the ones its redirects make, so the suite takes Google's
  authorize URL from the API's own redirect at the sign-in start and sends the browser on to the
  callback; and Chromium reports a navigation the API redirects to the page (which the worker
  answers) as the worker's, so navigations to `api/` are counted at the host instead.

## Code conventions

- Never paste text that came from outside into markup. Camera labels come from the operating
  system and photo labels from file names, so the interface builds those nodes with
  `document.createElement` and `textContent` (there is an `el()` helper in `app.js`).
  Nothing uses `innerHTML`, not even for fixed markup: the site's policy enforces Trusted
  Types, under which every HTML string sink throws, and `test/website.test.js` fails on one.

- Camera model: `Xc = R Xw + t`, pixel = `c + f * distort(Xc.xy / Xc.z)` with
  `distort(x) = x (1 + k1 |x|^2)`. World frame = first registered camera; results are
  flipped to y-up (`x, -y, -z`) only when building the final output.
- Matrices are flat row-major Float64Arrays with explicit dimensions.
- Every pipeline change should keep `npm test` green; add a synthetic-scene test when
  adding a stage. Keep the CPU and GPU plane sweeps behaviourally identical.
- Do not add build tooling or npm dependencies without a strong reason: the app is meant to
  be deployable by copying the folder to any static HTTPS host. three.js is vendored; its
  version and checksums live in `docs/vendored-three.md`, and `test/vendor.test.js` fails when
  the files and the note disagree.
- The dev server (`server.js`) serves only non-hidden files inside the project directory and
  binds loopback unless `--https` or an explicit `--host=` asks otherwise. Anything that can
  reach the port can drive it, so its request handling is covered by `test/server.test.js`.
  The rule is applied twice: to the address as written (`resolveRequest`, which also refuses a
  backslash), and to the path the filesystem resolves it to (`servable`, through
  `fs.realpath.native`), so a link inside the checkout cannot reach a sibling directory or a
  hidden file, and on Windows neither can a short name such as `GIT~1`.
  It also refuses a request whose `Host` is not one of its own names (a page the developer
  visits can point its hostname at 127.0.0.1; the rebound request still says so in `Host`).
  Bound to loopback those names are the loopback ones; bound off it (`--host=`, `--https`)
  they are this machine's own names, because that is what a phone types: the bound address,
  every interface address in both spellings, the hostname, `<hostname>.local`, and any other
  name under `.local`, which is mDNS and cannot be pointed at 127.0.0.1 from the internet.
  A miss re-reads `os.networkInterfaces()` (throttled) before refusing, so the Wi-Fi joined
  after the server started is answered, and a refusal is logged once per name with the
  `ALLOWED_HOST=` that would allow it — that variable is a comma-separated list, for the
  forwarder or tunnel this process cannot see. No `Host` at all is answered: a browser always
  sends one. `hostGate` in `server.js` is abientnoiser's `scripts/hosts.js`, form for form;
  change one and change the other.

## Conventions

This repository follows `CONVENTIONS.md`, which is identical in every platteration
repository and pinned by the conventions test (`npm run test:conventions`, or
`tests/test_conventions.py` in a Python repository): the script set (`test`,
`typecheck`, `lint`, `check`, `test:e2e`, `test:all`), Node 22 via `.nvmrc`, one
`.editorconfig`, ESLint per stack, the `ci.yml` shape, the documents every repository
carries and the README skeleton. The repository's check command (`npm run check`, or
`ruff check .` then `pytest -q` in a Python repository) is the gate before a push. To
change a convention, change it in every repository in one pass and update the hashes in
the test.
