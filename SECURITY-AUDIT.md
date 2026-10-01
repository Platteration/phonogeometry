# phonogeometry — security audit (2026-09-11)

A dedicated security pass, separate from and later than the review in `REVIEW.md`. Specialist reviewers read the repository through 3 independent lenses (L1, L3, L4), each required to *demonstrate* a finding rather than argue for it.

**8 findings** — 1 medium, 5 low, 2 info. 7 of 8 were reproduced with command output; the other is reasoned from the code.

## Status

Every finding below was fixed on `claude/repo-review-security-baiyud` in c5738c6, each with a regression test that was checked by reverting the fix and confirming the test fails. The findings are kept as written so the reasoning behind each change stays with it.

One exception, found by a later adversarial pass over those fixes and since closed: L4-2's fix is a flag in a CI workflow, and nothing in `test/` read that workflow, so it had no regression test at all while this section claimed otherwise. `test/workflow.test.js` is that test now — it fails if an install in CI loses `--ignore-scripts` or stops naming an exact version.

These were deliberately left for a decision rather than guessed at:

- L3-5 — no Content-Security-Policy. Shipping one means first removing the import map, which means editing the vendored three.js file the integrity check has just been tightened to require byte-identical to upstream; and frame-ancestors is ignored in a meta policy.

## Findings

### L3-1 · medium — One GET containing %00 terminates the dev server; anyone on the Wi-Fi can kill the documented LAN mode

`server.js`:61 · CWE-248 · reproduced

**Who.** Anyone who can reach the dev server's port. In the mode the README documents and the app actually needs (`npm run start:https`, which parseArgs binds to 0.0.0.0 so a phone can load it), that is every device on the same Wi-Fi — a cafe, a shared office, a conference network. No credentials, no prior interaction.

**How.** 1. The developer runs `npm run start:https` (or `npm start --host=0.0.0.0`) as README.md:44-51 instructs. 2. The attacker sends a single request whose path contains a percent-encoded null byte, e.g. `GET /a%00b HTTP/1.1`, or `GET /index.html%00.png`, or the absolute form `GET http://evil/%00`. 3. resolveRequest decodes it inside its try/catch — decodeURIComponent does not throw on %00, it yields a real NUL — the path stays inside root so the path.relative containment check and the dotted-segment check both pass, and it returns {status: 200, file: '<root>/a\0b'} (server.js:47). 4. handler passes that string straight to fs.stat (server.js:61). Node validates the path synchronously and throws ERR_INVALID_ARG_VALUE *before* the callback exists, so the throw escapes the 'request' listener. There is no 'uncaughtException' handler and no domain, so the process exits with code 1 and the dev session is gone.

**Why it matters.** Unauthenticated remote termination of the developer's server process. The phone loses the app mid-scan, and anything in progress stops; the attacker can re-kill it as fast as the developer restarts it. No file is disclosed and nothing is executed, so the loss is availability only — but it defeats the exact property the previous pass's SEC-1 fix and test/server.test.js:61 ('the running server survives the requests it refuses') were written to guarantee. The %00 door was simply not closed when the `/%` one was: the fix wrapped the *decode* in try/catch but never validated the *decoded* result before handing it to fs.

**Evidence.**

server.js:28-47  export function resolveRequest(url) { let urlPath; try { urlPath = decodeURIComponent(new URL(url, 'http://x').pathname); } catch { return { status: 400 }; } ... const rel = path.relative(root, file); if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 }; if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return { status: 403 }; return { status: 200, file }; }
server.js:61  fs.stat(file, (err, st) => { ... })

Node 22.22.2 behaviour, isolated:
  fs.stat THREW SYNCHRONOUSLY: ERR_INVALID_ARG_VALUE | The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/home/user/phonogeometry/index.html\x00.png'

Against the real server started exactly as `npm start` does:
  alive before      : true
  GET /index.html   -> {"status":200,"len":11312}
  GET /%            -> {"status":400,"len":11}          <- the SEC-1 fix still holds
  GET /index.html%00.png -> {"error":"ECONNRESET"}
  server exited     : {"code":1,"sig":null}
  GET /index.html again -> {"error":"ECONNREFUSED"}
  --- server stderr ---
  TypeError [ERR_INVALID_ARG_VALUE]: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/home/user/phonogeometry/index.html\x00.png'
      at Object.stat (node:fs:1670:16)
      at Server.handler (file:///home/user/phonogeometry/server.js:61:6)

A raw-socket sweep of 30 hostile request targets found no other killer: /%, /%zz, /%ff, /%C0%AF, /%ed%a0%80, /%f4%90%80%80 and /\\ answer 400; 6000-character paths, 2000-segment paths, /..%2f..%2f..%2fetc/passwd and /proc/self/environ answer 404 or 403; /?a=%00 and /#%00 are safe because the NUL is not in `pathname`. Every path-borne %00 — '/a%00b', '/%00', '/index.html%00.png', '/src/%00app.js', 'http://evil/%00' — kills it.

**Fix.** Reject the NUL in resolveRequest, where the file's own comment says every request-influenced decision is made, so handler keeps needing no defence of its own: after the decodeURIComponent try/catch add `if (urlPath.includes('\0')) return { status: 400 };` (or reject any control character: `if (/[\u0000-\u001f]/.test(urlPath)) return { status: 400 };`, which also covers a raw CR/LF should a future Node let one through). Extend test/server.test.js's 'a malformed percent-escape is a bad request, not a crash' case with `resolveRequest('/a%00b')`, `resolveRequest('/%00')` and `resolveRequest('/index.html%00.png')`, and add `/a%00b` to the live-server 'survives the requests it refuses' test so the socket-level regression is covered too. Belt and braces, and cheap: add `process.on('uncaughtException', (err) => console.error(err))` around the listen in startServer, or wrap the body of `handler` in try/catch returning 500 — the whole point of a dev server is that one bad request costs one response, not the session.


### L1-1 · low — A percent-encoded NUL in the request path crashes the dev server (fs.stat throws synchronously inside the request listener)

`server.js`:61 · CWE-158 · reproduced

**Who.** Anyone who can reach the dev server's port. The README's documented phone workflow is `npm run start:https`, which server.js deliberately binds to 0.0.0.0 (parseArgs: `const host = value('host') || (useHttps ? '0.0.0.0' : '127.0.0.1')`), so on a shared office/cafe/conference Wi-Fi that is every other device on the network. They need no credentials and no prior knowledge - one unauthenticated GET.

**How.** 1. Developer follows README.md and runs `npm run start:https` so a phone on the same Wi-Fi can load the app (this binds 0.0.0.0:8443). 2. Attacker on that network sends `GET /%00 HTTP/1.1`. 3. resolveRequest() URL-decodes the path to `/\u0000`; the containment test (`rel.startsWith('..')`) and the hidden-segment test (`seg.startsWith('.')`) both pass for a segment that is a lone NUL, so it returns `{status: 200, file: '<root>/\u0000'}`. 4. handler() calls `fs.stat(file, cb)`. Node validates the path before going async and throws ERR_INVALID_ARG_VALUE *synchronously*, inside the 'request' listener. 5. There is no uncaughtException handler and no try/catch around the fs call, so the process terminates. The attacker repeats the request after every restart. Variants that work identically: `/a%00b`, `/index.html%00.png`, `/%00/`.

**Why it matters.** Denial of service on the developer's dev server: the Node process exits and the port closes, so the phone under test loses the app mid-scan and the session has to be restarted (and can be killed again immediately). No file disclosure and no code execution - fs rejects the NUL rather than truncating on it - so the impact is availability of a development-only tool. It is worth reporting because it is the exact failure mode SEC-1 in REVIEW.md was fixed to prevent ('a malformed escape must not end the process', test/server.test.js:15): the try/catch added around decodeURIComponent covers URIError but not the NUL that decodeURIComponent happily produces, so the fix is incomplete and the regression test passes while the hole is open.

**Evidence.**

server.js:28-47 (resolveRequest) lets a NUL segment through:
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(url, 'http://x').pathname); } catch { return { status: 400 }; }
  ...
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 };
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return { status: 403 };
  return { status: 200, file };

server.js:61 is the sink, with no guard:
  fs.stat(file, (err, st) => { ... });

Observed:
  resolveRequest("/%00") -> {"status":200,"file":"/home/user/phonogeometry/\u0000"}
  listening on 32855
  GET /index.html -> {"status":200,"body":"<!doctype html>...
  UNCAUGHT (the dev server process would now exit): TypeError ERR_INVALID_ARG_VALUE The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/home/user/phonogeometry/\x00'

And against a real listening server (not a harness), the process died and the port closed:
  pid=14486
  index:200
  nul:000
  --- log ---
  READY 38123
  node:internal/errors:540
        throw error;
        ^
  TypeError [ERR_INVALID_ARG_VALUE]: The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/home/user/phonogeometry/\x00'
      at Object.stat (node:fs:1670:16)
      at Server.handler (file:///home/user/phonogeometry/server.js:61:6)
      at Server.emit (node:events:519:28)
      at parserOnIncoming (node:_http_server:1186:12)
  Node.js v22.22.2
  after:000        <- the port no longer answers

The existing suite does not cover it: the whole suite is green with the hole open - `npm test` -> 55 tests, 55 pass, 0 fail, exit code 0 (and the server-specific subset `node --test test/server.test.js test/storage.test.js test/sw.test.js` -> 20 pass, 0 fail), and a fuzz of 24 other odd paths (`/%`, `/%zz`, `/%c0%af`, `/%ed%a0%80`, `/..%2f..%2fetc/passwd`, `/.git/config`, `//evil.com/x`, `/\\..\\..\\etc`, `/%2f%2f`, a 4000-char path) all returned 400/403/404/200 with the server still answering afterwards - the NUL is the only one that kills it.

**Fix.** Reject the NUL where the rest of the path policy already lives, in resolveRequest, so it is testable without a socket: after decoding, `if (urlPath.includes('\u0000')) return { status: 400 };` (equivalently add a `seg.includes('\u0000')` case beside the existing dot-segment test). Add it to the existing regression test beside the malformed-escape case, e.g. `assert.equal(resolveRequest('/%00').status, 400)` and `assert.equal(resolveRequest('/index.html%00.png').status, 400)`, plus a live-server assertion in 'the running server survives the requests it refuses'. While in handler(), close the matching gap one line below: `fs.createReadStream(file).pipe(res)` (server.js:70) has no 'error' listener, so any open() failure after a successful stat - a file removed or made unreadable between the two calls - raises an unhandled 'error' event and ends the process the same way; attach `.on('error', () => { res.destroy(); })`. Belt and braces for a tool that is told to listen on 0.0.0.0: `process.on('uncaughtException', ...)` in main() so no future sink in the request path can take the server down.


### L3-2 · low — The service worker deletes every Cache Storage cache on the origin, not only its own, so co-hosted apps lose their offline shells (and this one loses its)

`sw.js`:17 · CWE-668 · reproduced

**Who.** No malice required: any other progressive web app deployed to the same origin. README.md:49 tells the operator to 'deploy the folder to any static host with HTTPS (GitHub Pages, Netlify, Cloudflare Pages…)', and a GitHub Pages user or organisation site puts every project of that account on one origin (`https://<account>.github.io/<project>/`). REVIEW.md records thirteen sibling repositories by the same author, several of them PWAs with their own service workers. A deliberately hostile co-tenant on a shared origin gets the same effects on purpose.

**How.** 1. Phonogeometry is copied to `https://account.github.io/phonogeometry/`; another PWA already lives at `https://account.github.io/other/` with its own service worker and its own cache. 2. A visitor opens phonogeometry. Cache Storage is partitioned by *origin*, not by service-worker scope, so `caches.keys()` inside phonogeometry's worker returns every cache on `account.github.io`. 3. The activate handler keeps only the one cache whose name equals VERSION and deletes all the rest (sw.js:17). The other app's precache is gone; it is offline-broken until its own worker reinstalls over the network. 4. The same thing happens in reverse whenever the sibling activates, which silently destroys phonogeometry's offline shell — the headline README claim ('works offline once loaded. That is tested, not assumed'). 5. Separately, `caches.match(e.request)` at sw.js:32 is not pinned to VERSION either, so it searches every cache on the origin: while the network is unavailable phonogeometry serves whatever *another* app on the origin has cached under one of phonogeometry's URLs.

**Why it matters.** Availability. Deploying this app onto a shared static origin silently disables offline mode for every other PWA there, and any of them disables it here. On a shared origin there is no trust boundary between the apps to begin with, so this is breakage rather than privilege escalation — but it is breakage the app inflicts on software it has nothing to do with, and it defeats the property the app's own browser suite asserts. The unscoped `caches.match` additionally makes what this worker serves offline depend on cache entries it did not write.

**Evidence.**

sw.js:16-18
  self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
  });
sw.js:31-32
  e.respondWith(
    caches.match(e.request).then((cached) => {   // no { cacheName: VERSION }

test/sw.test.js:23 stubs `keys: async () => []`, so the suite never exercises an origin that has other caches on it — which is why this is invisible today.

Run against the REAL sw.js under a stubbed worker global, registered at a project-site path (`https://platteration.github.io/phonogeometry/sw.js`, scope `/phonogeometry/`):
  caches on the origin BEFORE activate: [ 'phonogeometry-v16', 'ambient-noiser-9f2c41', 'simplacad-shell-v3', 'workbox-precache-v2-https://platteration.github.io/notes/' ]
  caches on the origin AFTER  activate: [ 'phonogeometry-v16' ]

And the unscoped read, same real sw.js, network offline:
  offline, both caches present -> the real app.js
  after another app's activate wiped this one's cache -> /* another app's copy */
  with nothing cached at all -> Response type=error

**Fix.** Delete only caches this worker owns, and read only from the cache it owns. Give the cache name a stable, unambiguous prefix and filter on it: `const PREFIX = 'phonogeometry-'; const VERSION = PREFIX + 'v16';` then in activate `keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION)`. In the fetch handler pin the read: `caches.open(VERSION).then((c) => c.match(e.request))` instead of the bare `caches.match(e.request)`, and keep the runtime write on the same named cache (sw.js:34 already does). Then widen test/sw.test.js: stub `caches.keys()` to return a foreign cache name alongside two phonogeometry versions and assert only the stale phonogeometry one is deleted, and give the match stub two caches so 'serves its own copy, not another app's' is pinned.


### L3-3 · low — Every camera stays streaming for the whole multi-minute reconstruction and for as long as the user stays in the viewer

`src/app.js`:54 · CWE-404 · reproduced

**Who.** No remote attacker: this is the app holding a granted phone capability far longer and far more visibly than its task needs. The people it costs are the user (a lit camera indicator and several encoders running for minutes on a phone that is already thermally loaded by the reconstruction) and anyone in front of the lenses — a person being scanned who reasonably believes the cameras stop when the shutter screen goes away.

**How.** 1. Tap 'Enable all cameras'. cams.openAll() opens a getUserMedia stream per lens and holds them in CameraManager.open (src/camera/cameraManager.js:104-117). 2. Take shots, tap 'Build 3D mesh'. showScreen('process') only flips `hidden` on the three <main> elements and calls viewer.setActive (src/app.js:54-62); it never touches cams. The <video> elements stay in the hidden #camera-grid with their MediaStreams attached. 3. The build runs — README.md:68 and :130 say a few minutes at Balanced and 'several minutes' at High — with every lens still capturing. 4. When it finishes the user sits in the viewer measuring and exporting; the cameras are still live. The only thing that ever calls cams.closeAll() is the `pagehide` listener at src/app.js:796, i.e. leaving the page altogether. There is no 'stop the cameras' control anywhere in the interface.

**Why it matters.** The camera permission is exercised continuously outside the only screen that needs it. On a phone that means the OS camera indicator burns through the whole reconstruction (either alarming the subject or, worse, teaching them the indicator means nothing here), several hardware encoders stay powered next to a CPU-bound worker and a GPU plane sweep, and a scan of a person keeps their image in the capture pipeline long after the user thinks capture ended. No frame is stored or sent — nothing here leaks — so this is a least-privilege and honesty defect, not a data-disclosure one.

**Evidence.**

src/app.js:54-62
  function showScreen(name) {
    for (const s of ['capture', 'process', 'view']) $(`#screen-${s}`).hidden = s !== name;
    $('#capture-bar').hidden = name !== 'capture';
    if (state.viewer) { if (name === 'view') state.viewer.resize(); state.viewer.setActive(name === 'view'); }
  }
src/app.js:796  window.addEventListener('pagehide', () => cams.closeAll());   // the only caller of closeAll in src/

The viewer's own background cost was fixed (setActive, viewer.js:82-88, REVIEW BUG-5) but the camera streams sitting beside it were not.

Measured in Chromium (Playwright, fake camera device, real app over the dev server); `screen` is which <main> is visible and `liveTracks` counts MediaStreamTracks in readyState 'live':
  {"tag":"capture screen, cameras enabled","screen":"capture","liveTracks":1,"tracks":[{"readyState":"live","enabled":true,"w":1280,"h":960}]}
  {"tag":"DURING BUILD (capture screen hidden)","screen":"process","liveTracks":1,"tracks":[{"readyState":"live","enabled":true,"w":1280,"h":960}]}
  {"tag":"AFTER BUILD SETTLED","screen":"process","liveTracks":1,"tracks":[{"readyState":"live","enabled":true,"w":1280,"h":960}]}
  {"tag":"8s later, still not on the capture screen","screen":"process","liveTracks":1,"tracks":[{"readyState":"live","enabled":true,"w":1280,"h":960}]}
Chromium's fake device provides one camera; on a phone this is one live track per lens.

**Fix.** Close the streams whenever the capture screen is not the screen the user is on, and reopen them when it is — the machinery already exists on both sides. In showScreen (src/app.js:54): `if (name === 'capture') reopenCameras(); else cams.closeAll();`. reopenCameras (src/app.js:148) already guards on `$('#screen-capture').hidden`, already skips cameras that are open, and already re-renders the tiles, and CameraManager keeps its <video> elements across a close (cameraManager.js:119-126) precisely so a tile survives one. Take care over the ordering with captureShot's sequential fallback (cameraManager.js:163-182), which closes and reopens cameras mid-capture: gate the close on a build actually being live, or on `state.building`, so a capture in flight is not cut off. Worth adding to test/browser/run.mjs next to the existing liveTiles check: after clicking Build, assert every video track is 'ended'.


### L3-4 · low — Captured photographs are kept in IndexedDB forever and the app now asks the browser never to evict them; the retention half of the previous fix was not done

`src/app.js`:270 · CWE-359 · reproduced

**Who.** Whoever picks up the unlocked phone next, or whoever the phone is handed to. This is a shared-device and hand-me-down exposure, not a remote one — and SECURITY.md:24-27 puts 'findings that require an attacker to already control the device' out of scope, so treat the severity accordingly. The part that is not a matter of scope is that the retention is stronger than the previous review's fix intended and stronger than the README describes.

**How.** 1. Someone scans a person or the inside of a home. Each shutter press writes one record per lens into IndexedDB database 'phonogeometry', store 'shots' — a full image/jpeg Blob plus a base64 data-URL thumbnail (src/storage.js:40-50, src/app.js:293). 2. On the first shot the app calls navigator.storage.persist() (src/app.js:266-271), asking the browser to exempt this origin's data from its own eviction under storage pressure — the one automatic mechanism that would ever have removed these images. 3. Nothing expires them. There is no cap on record count, no age limit, and the only deletions are the per-shot ×, 'Clear' and 'New scan' — all of which need someone to press them. 4. The next person to open the URL gets restoreShots(): every stored photograph is decoded back into the shot list and rendered as thumbnails, with a five-second toast and no confirmation.

**Why it matters.** Photographs of people and rooms sit on the device indefinitely, exempted from automatic eviction, and are re-displayed to whoever opens the app next. The images never leave the device — no code in src/ or index.html makes any network request (the only fetch in the repository is sw.js:33, for the app's own shell), so the app's 'no server, no account, entirely on-device' claim is true. What is not true is README.md:55, 'Shots are kept in the browser's IndexedDB, so if the tab reloads mid-scan (phones do this under memory pressure) they are restored when you come back' — that describes crash recovery within one session, not indefinite retention across sessions, days and browser restarts, and it says nothing about persist(). REVIEW.md VER-4 is marked fixed: the write-failure half was done well (saveShot now resolves 'saved'/'unavailable'/'failed' and the app toasts once, src/storage.js:34-50, src/app.js:273-280), but its retention recommendation — 'either drop restored shots older than a day or show the count and a one-tap Delete stored photos next to the restore toast' — was implemented as neither. The persist() call added in the same pass moved retention in the opposite direction.

**Evidence.**

src/app.js:266-271
  if (!askedToPersist && navigator.storage?.persist) {
    askedToPersist = true;
    // Ask the browser not to evict these photographs while a scan is in progress.
    navigator.storage.persisted?.().then((already) => already || navigator.storage.persist()).catch(() => {});
  }
src/app.js:383-389  restoreShots(): state.shots = saved.map(...); renderShots(); toast(`Restored ${saved.length} shot…  The photos stay on this device until you press Clear.`, 5000);
src/storage.js:40-50  saveShot writes { id, createdAt, frames: shot.frames.map((f) => ({ ...f, thumbUrl: f.thumbUrl })) } — the frame objects carry `blob`. Nothing in storage.js reads createdAt except loadAll's sort (line 69): no expiry exists.
README.md:55 is the only documentation of any of this.

Measured in Chromium against the real app (three lenses, four shots), dumping the object store directly:
  4 records, 12 frames, each {"blob":"image/jpeg ~23000B","thumbUrl":"data:image/jpeg;base64,/9j/4AAQSkZJRgABA…","label":"Back 1"/"Back 2"/"Front","w":1280,"h":960}
Then a fresh navigation in the same profile, as the next person picking up the phone would:
  after a fresh load, shots shown: 4 | toast: Restored 4 shots from your previous session. The photos stay on this device until you press Clear. | thumbnails in DOM: 12
(The blobs are small only because the fake camera renders a flat test pattern; at 1280 px q=0.92 a real frame is hundreds of kilobytes, and there is one per lens per press.)

**Fix.** Do the retention half that VER-4 asked for, and make the documentation match. (a) Expire on read: in ShotStore.loadAll (src/storage.js:64-71) the records already carry createdAt — drop and delete anything older than, say, 24 hours before returning, so a scan survives the crash it exists to survive without becoming an archive. (b) Give the restore toast an action, or put a 'Delete stored photos (N)' control next to 'Clear' on the capture screen, so removing them does not depend on recognising that 'Clear' means the disk as well as the screen. (c) Scope the persist() request to a scan that is actually in progress, or drop it — asking the platform never to evict photographs of people is a larger promise than crash recovery needs, and it is made silently on the first shutter press. (d) Correct README.md:55 to say plainly that captured photographs remain on the device across sessions until deleted, and that the app asks the browser to keep them.


### L4-1 · low — The vendored three.js integrity check is self-referential: nothing ever compares the blob to upstream, so a backdoored copy passes CI green

`test/vendor.test.js`:20 · CWE-494 · reproduced

**Who.** Anyone who can land a commit on this repository: an outside contributor whose pull request is merged, or someone who takes over the maintainer's GitHub account. They need no CI secrets (the repo has none) and no registry access. Downstream victim is every phone that installs the PWA, since vendor/three/three.module.min.js is precached by sw.js and runs same-origin with the scan data.

**How.** 1. Open a pull request that appends a payload to vendor/three/three.module.min.js (670 KB of minified code; a one-line append is invisible in review). 2. Recompute sha256 of the edited file and replace the matching row's hash in docs/vendored-three.md. 3. npm test passes: test/vendor.test.js only asserts that the note *mentions* the digest of whatever is on disk, so file and note are consistent again. 4. The note still says '**Version:** three@0.160.0' and 'All three files are byte-identical to the published package', which is now false, and no CI job or test checks that claim against the npm registry. 5. Reviewer sees a two-line markdown diff next to an unreadable minified blob diff and merges. The service worker then precaches the backdoored file (sw.js SHELL includes it) and serves it offline.

**Why it matters.** Arbitrary same-origin JavaScript in the deployed PWA, running alongside the camera streams, the IndexedDB shot store (photographs of the user's rooms and people) and the reconstruction worker, with an offline-persistent cache entry. The repository's only stated defence against exactly this ('an edit to a vendored file ... fails the suite rather than passing quietly', docs/vendored-three.md) does not detect it, because the guard verifies the tree against a note in the same tree rather than against upstream.

**Evidence.**

test/vendor.test.js:16-24 --  const files = ['three.module.min.js', 'OrbitControls.js', 'LICENSE'];
  for (const name of files) {
    const digest = sha256(path.join(root, 'vendor', 'three', name));
    assert.ok(
      note.includes(digest),
      `vendor/three/${name} hashes to ${digest}, which docs/vendored-three.md does not mention.`

Mutation run in a scratch copy of the tree (the real repo was not modified):
  --- baseline ---
  # pass 1
  # fail 0
  --- inject a backdoor into the vendored three.js and update the note to match ---
  note now records: b8dcf7ffa529d02c86d488ae546bd8b76a899cda25d118ead723c1115df62dc9   (version line untouched:)
  13:- **Version:** `three@0.160.0` (r160, December 2023), MIT licensed.
  ok 1 - the vendored three.js files are the ones the provenance note describes
  # pass 1
  # fail 0

The genuine upstream hash is unchanged, so the note is now simply lying:
  3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6  x/package/build/three.module.min.js

Second, smaller weakness in the same assertion: `note.includes(digest)` is not bound to the file's row, so the hashes can be right while the files are wrong. Swapping the contents of vendor/three/OrbitControls.js and vendor/three/LICENSE with the note untouched also passes:
  --- OrbitControls.js and LICENSE swapped, note untouched ---
  ok 1 - the vendored three.js files are the ones the provenance note describes
  # pass 1
  # fail 0

For the record, the files as they stand today ARE genuine: all three are byte-identical to three@0.160.0 from the npm registry, whose tarball matched dist.shasum cd1e4dbd01aee0719280a9086d75545db52b7a8f and dist.integrity sha512-DLU8lc0zNIPkM7rH5/e1Ks1Z8tWCGRq6g8mPowdDJpw1CFBJMU7UoJjC6PefXW7z//SSl0b2+GCw14LB+uDhng==, and whose registry signature verified against npm's published ECDSA key (keyid SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA): 'npm registry signature valid: true'. The finding is that nothing in the repository re-establishes that fact on any future change.

**Fix.** Verify against upstream, not against the note. (a) Add a CI step in .github/workflows/test.yml (own job, needs network, so keep it out of `npm test`): parse the version out of docs/vendored-three.md, download https://registry.npmjs.org/three/-/three-<version>.tgz, assert its sha512 equals dist.integrity from https://registry.npmjs.org/three/<version>, verify dist.signatures[0] against the keys at https://registry.npmjs.org/-/npm/v1/keys (the exact node one-liners above work), then extract build/three.module.min.js, examples/jsm/controls/OrbitControls.js and LICENSE and require each to be byte-identical to the file in vendor/three/. (b) Independently, tighten test/vendor.test.js so a hash is bound to its file: parse the markdown table into { filename -> sha256 } and assert `table[name] === digest` instead of `note.includes(digest)`. (a) is what stops a malicious update; (b) stops the table quietly going wrong.


### L3-5 · info — No Content-Security-Policy anywhere, on an origin that holds photographs of people and rooms

`index.html`:16 · CWE-693 · reasoned

**Who.** None today — I could not find an injection point, so this is defence in depth and I am reporting it as info rather than as a live defect. It is REVIEW.md SEC-3, still open ('Deliberately not done: SEC-3, CI-1'), and the lens asks what its absence costs, so here is the honest accounting.

**How.** There is no reachable attack. What a policy would cost an attacker if one ever appeared: src/app.js still builds markup by interpolation in three places (line 103 `tile.insertAdjacentHTML('beforeend', `<div class="cam-error">${msg}</div>`)`, line 690 the #stats template, plus two static innerHTML assignments), and a future edit that drops a camera label or a file name into one of those — exactly the mistake CLAUDE.md:87-90 exists to prevent — would run with nothing between it and the origin's data. The one thing the absence costs with no injection at all is framing: neither index.html nor server.js emits `frame-ancestors` or X-Frame-Options (measured response headers for `/` are content-type, content-length, cache-control: no-cache, cross-origin-opener-policy: same-origin, date, connection, keep-alive — nothing else), so any page may embed the app. I could not turn that into an attack: a cross-origin frame cannot read the app's pixels or its IndexedDB, camera access inside a frame needs both `allow="camera"` and the top-level site's own permission, and both destructive actions (Clear, New scan) sit behind confirm(), which cannot be clickjacked.

**Why it matters.** If an injection is ever introduced, the origin it lands on has no script-src to stop it, no connect-src or img-src to stop it shipping the contents of the 'phonogeometry' IndexedDB database — full JPEGs of whoever was scanned — to an attacker's host, and no base-uri to stop an injected <base> redirecting the module graph that index.html:16-23 resolves through its import map. This app's origin holds more sensitive data than most static sites, which is what makes the missing control worth the effort here rather than a formality.

**Evidence.**

index.html has no <meta http-equiv="Content-Security-Policy">; measured in the browser, `document.querySelectorAll('meta[http-equiv]').length` === 0.
server.js:63-68 sets Content-Type, Content-Length, Cache-Control and Cross-Origin-Opener-Policy and nothing else; a static host (GitHub Pages, the documented target) adds no CSP of its own and offers nowhere to configure one, so a <meta> policy is the only control available.
src/app.js:103  tile.insertAdjacentHTML('beforeend', `<div class="cam-error">${msg}</div>`);
src/app.js:690  $('#stats').innerHTML = `<span><b>${s.registered}</b>/${s.images} images used</span>` + …
What I checked and could not break: a tree-wide grep for location.search, location.hash, URLSearchParams, eval, new Function, document.write and importScripts returns nothing in first-party code; the interpolations above carry only fixed strings and numbers (`msg` is one of two literals; every #stats value is a number through toLocaleString/toFixed); camera labels and file names go through the el()/textContent helper; a tampered IndexedDB thumbUrl reaches only img.src, where neither javascript: nor data:text/html executes.

**Fix.** REVIEW.md SEC-3's recommendation still stands and is the right shape: rewrite vendor/three/OrbitControls.js's bare `three` import to './three.module.min.js' and import three by relative path from src/viewer/viewer.js, delete the import map, and then ship a hash-free policy in index.html — `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">` — adding frame-ancestors 'none', which the earlier recommendation omitted and which is the only clause that buys anything with no injection present. Note that frame-ancestors in a <meta> policy is ignored by browsers, so if framing is to be refused it has to come from the host's headers; add it to server.js:63-68 for the dev server and document it for the deploy target. Verify the page still loads in Chrome and Safari before committing, since CI cannot (REVIEW CI-2).


### L4-2 · info — CI's Playwright install carries no in-repo integrity pin, but the exposure is genuinely small: the resolved tree is exact-pinned, runs no install scripts on Linux, and the job holds a read-only token and no secrets

`.github/workflows/test.yml`:31 · CWE-1357 · reproduced

**Who.** Someone who compromises the npm registry itself, or the `playwright` / `playwright-core` publisher account and is able to replace the bytes served for an already-published exact version. A fork contributor is NOT this attacker: fork pull requests get a read-only GITHUB_TOKEN and no secrets, so running their code in this job is the ordinary CI bargain, not an escalation.

**How.** 1. Swap the tarball bytes served by the registry for playwright@1.56.1 or playwright-core@1.56.1 (npm version immutability makes this a registry- or account-level compromise, not an ordinary publish). 2. `npm install --no-save --no-package-lock playwright@1.56.1` re-resolves from the registry on every run and has no repository-side integrity hash to compare against, so it installs the substituted bytes. 3. The very next step, `npx playwright install --with-deps chromium`, executes playwright's CLI and shells out to `sudo apt-get install`, so the substituted code runs as root on the runner.

**Why it matters.** Root code execution on an ephemeral GitHub-hosted runner for a public repository that has no secrets, no publish step and a workflow-scoped `permissions: contents: read` token. There is nothing on that runner to steal and nothing the token can write. The practical loss is a poisoned test result and a foothold that dies with the job.

**Evidence.**

.github/workflows/test.yml:28-36 --
      # The app has no dependencies and no lockfile, so Playwright is pinned here and
      # installed for this job only, without touching package.json.
      - run: npm install --no-save --no-package-lock playwright@1.56.1
      - run: npx playwright install --with-deps chromium

Resolved the whole tree with `npm install --package-lock-only` in a scratch directory (nothing executed):
  node_modules/fsevents 2.3.2 resolved=fsevents-2.3.2.tgz integrity=yes INSTALL-SCRIPT
  node_modules/playwright 1.56.1 resolved=playwright-1.56.1.tgz integrity=yes
  node_modules/playwright-core 1.56.1 resolved=playwright-core-1.56.1.tgz integrity=yes

Every edge is an exact version, not a range: playwright@1.56.1 declares dependencies {"playwright-core":"1.56.1"} and optionalDependencies {"fsevents":"2.3.2"}, and neither playwright nor playwright-core declares any scripts. The one install script in the tree belongs to fsevents@2.3.2 ({"install":"node-gyp rebuild"}), which declares os: ["darwin"] and is therefore not installed at all on ubuntu-latest. npm's advisory database returns nothing for this version: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk {"three":["0.160.0"],"playwright":["1.56.1"]} -> {} (HTTP 200).

The workflow's other supply-chain posture checks out: top-level `permissions: contents: read` (line 6-7), no pull_request_target, no `github.event` value interpolated into any run step, no `secrets.` reference anywhere in the repository, no setup-node cache (so no cache to poison) and no artifact upload.

**Fix.** Do NOT add a package-lock.json for this: the repository's no-dependency design is intact (package.json declares none, nothing is installed at runtime, the app is still a folder you copy to a static host), and a lockfile would exist only to pin a test tool. Two cheap belt-and-braces changes if you want the exposure closed: (1) add `--ignore-scripts` to the install line -- `npm install --no-save --no-package-lock --ignore-scripts playwright@1.56.1` -- so the tree's one install script is skipped by policy rather than only by fsevents' own `os` field, which is a field the package controls; (2) if you want a repository-side integrity pin without a lockfile, record the three `dist.integrity` values in a comment or a tiny .github/playwright-pins.json and add a step that compares `npm view playwright@1.56.1 dist.integrity` (and playwright-core) against them before installing. Leave the version-in-the-workflow shape as it is; it is the right answer for this repo.


## Checked and sound

What the reviewers tried and could not break. Recorded so it is not re-raised, and so a future change that undoes one of these is recognisable as a regression.

- EXIF parser (src/camera/exif.js), the most attacker-controlled parser in the app: fuzzed it with 3000 random/semi-structured blobs plus eight hand-built hostile JPEGs - 20000 zero-length APP0 segments (marker-walk starvation), an IFD0 offset of 0xFFFFFFFF, an IFD claiming 65535 entries, an ExifIFD pointer aimed back at IFD0 (self-loop), a rational with denominator 0, and 256 KB of noise behind an SOI. Zero exceptions escaped readExifFov, zero hangs (worst case 103 ms, and the whole read is bounded by `blob.slice(0, 256 * 1024)`), every case returned null. The IFD walk writes `out[tag]` on a bare `{}` but only for tags already in the `wanted` Set (0x8769/0x0112/0xa405/0x920a), so no attacker-chosen key and no `__proto__`/`constructor` reachability.
- EXIF-driven focal length reaching the whole reconstruction pipeline: readExifFov's hfov is passed to intrinsicsFor() with none of the [20,140] clamping the Settings input enforces, so a crafted FocalLengthIn35mmFilm sets an arbitrary focal length. I ran the real reconstruct() on a synthetic six-camera room with the two extremes a uint32/rational can produce (focal35 = 2^32-1 -> hfov 4.8e-7 deg -> f = 3.8e10 px; focal35 = 1 -> hfov 173.6 deg -> f = 8.9 px), one poisoned frame and all frames poisoned. No hang, no unbounded allocation, no NaN-driven volume blow-up: worst case was 18 s and 188 MB RSS against 6.6 s/187 MB for the clean run, and the all-poisoned case failed closed with 'No depth maps could be computed'. fitVolume caps dims at `resolution + 2` per axis by construction, and a NaN extent produces a zero-length volume that then raises 'The fused volume contains no surface'. Wrong model, not a resource attack.
- Feature-extraction amplification from a crafted image: tried to make detectFAST/extractORB explode by importing maximally corner-dense content (2 px and 3 px checkerboards, a 3 px dot lattice) at the High-quality feature width. Non-maximum suppression at radius 3 bounds survivors to ~1/49 of the pixels and the grid selector then caps at maxFeatures, so the worst case was 4500 features, 381 ms and 114 MB RSS - the same as a benign frame. matchDescriptors is O(na*nb) but both are capped by maxFeatures, and selectCandidatePairs keeps pair count linear in frame count (shot window 3 + top-5 similar) once it exceeds 60.
- Every DOM sink in the app, against the CLAUDE.md convention that outside text must never be pasted into markup. There are exactly five innerHTML/insertAdjacentHTML sites (src/app.js:91, 100, 103, 200-201, 345, 690) and every one of them interpolates only literals or worker-computed numbers: the `msg` at app.js:103 is one of two fixed strings, and `$('#stats').innerHTML` at 690 interpolates s.registered/s.images/s.triangles/s.vertices/s.sparsePoints/s.densePoints/s.seconds, all numeric fields built in reconstruct.js. Camera labels (OS), file names, worker log lines, rig labels and calibrated-intrinsics labels all reach the page through el()/textContent, `img.alt`, `node.title` or `toast()`. The existing browser test already feeds a file named `x"><img src=x onerror="window.__injected=1">.png` and asserts it is shown as text.
- Prototype-chain reachability from every attacker-influenced string key: `overrides[key]` in cameraManager.discover() is keyed on the OS camera label against a JSON.parse'd object, but a hit on an inherited member yields `ov.lens === undefined`/`ov.hfov === undefined` and falls through to guessLens(); saveLensOverride's `all[cameraKey] = ...` with cameraKey '__proto__' re-points that one object's prototype and is then dropped by JSON.stringify rather than polluting Object.prototype. QUALITY[options.quality], PRESETS[options.preset], LENS_TYPES[cam.lens], viewer's setMode/setLayer tables and server.js's MIME[extname] are all keyed by values that come from fixed <select>/data-* markup or from a dotted extension ('.constructor' is not an Object.prototype key). Everything keyed on a rigKey/focalGroup inside sfm.js and reconstruct.js uses a Map, not an object.
- Loop and allocation bounds in the numeric core, looking for a data-driven hang: ransacEssential caps at maxIters and its adaptive `iters` can only shrink (w <= 1, and a NaN/-Infinity denominator yields -0 iterations); sampleIndices' do/while cannot spin because `n >= 8` is checked first; svd() is a fixed 80-sweep Jacobi; bundleAdjust runs a fixed `iterations` count; sfm's registerLoop carries an explicit `guard++ < nf * 4`; planeSweep/planeSweepGPU sizes all derive from q.depthWidth/q.numPlanes. The GPU path's four GLSL programs are static string constants with no interpolation, so there is no shader built from data.
- Dev-server path handling beyond the NUL: fuzzed 24 paths through a live socket. `/..%2f..%2fetc/passwd` -> 403, `/%2e%2e/%2e%2e/etc/passwd` -> 404 inside the root, `/.git/config` and `/.certs/key.pem` -> 403, `//evil.com/x` -> 404 (the URL parser moves the host out of pathname), a 4000-char path -> 404, over-long/invalid UTF-8 escapes (`/%c0%af`, `/%ed%a0%80`, `/%FF`) -> 400. path.relative containment plus the leading-dot segment rule holds for every encoded-separator and dot-segment variant I could construct; non-GET/HEAD is 405; clientError destroys the socket and headersTimeout/requestTimeout are set.
- The IndexedDB read path (storage.js loadAll -> app.js restoreShots): records are restored with no shape validation - a record whose `frames` is missing would throw inside renderShots, and the unhandledrejection handler swallows it while `state.building` is false, which would brick the capture screen on every launch. I did not report it because the store is same-origin and written only by this app's own saveShot(), so there is no attacker who can put a malformed record there; the restored `thumbUrl` is set on `img.src`, where neither a `javascript:` nor a `data:text/html` value executes. Worth a defensive coerce-on-read if the app is ever deployed on a shared-origin static host, but that is an L3 argument, not a reachable L1 defect.
- The worker trust boundary: worker.js's onmessage accepts anything, but a dedicated Worker can only be messaged by its own parent document, and the reply path back into the page (progress/preview/error/done) lands in textContent or numeric innerHTML. Transferred rgba buffers are neutered on the sender side and `releaseInputs` nulls them in the worker, so there is no reuse-after-transfer. There are no window/message listeners anywhere in src/, no fetch/XHR/WebSocket to any origin, and no eval/Function/import() built from data.
- Export and download paths: toGLB/toPLY/toOBJ/toPointCloudPLY write only numbers from typed arrays - no label, file name or camera string is embedded in any export - and exportName() is built from the fixed preset id plus an ISO timestamp, so a hostile file name cannot steer the download name.
- Re-checked the REVIEW.md items my lens touches rather than assuming: SEC-2's path.relative containment fix is correct and complete for traversal (only the NUL case above escapes, and it escapes into a crash rather than a read); VER-5's execSync interpolation in ensureCert() is still present but is fed only by the checkout's own absolute path, exactly as the review scoped it; SEC-3 (no CSP) remains open by a recorded decision and I found no new sink that would make it exploitable today.
- Dev server path containment. Fed 30 crafted request targets through the real resolveRequest and 30 more through a live server over a raw socket: /../../../../etc/passwd, /..%2f..%2f..%2fetc%2fpasswd (upper and lower case), /..%252f.., /.%2e/.%2e/, /%2e%2e%2f, /....//....//, /..;/..;/, /..%c0%af.., /\..\..\, //etc/passwd, /%2F..%2F.., a 200-segment ../ chain, and /src/..%2f..%2f.certs/key.pem. Not one escaped the project directory: path.relative beats the old startsWith prefix test, and the WHATWG URL parser resolves plain and %2e-encoded dot segments before decodeURIComponent ever sees them. The dotted-segment rule catches .git, .certs, .env and %2egit alike.
- Dev server bind address and method handling. startServer defaults to 127.0.0.1 and the test asserts it; --https implying 0.0.0.0 is the documented LAN mode, not an accident. POST/PUT/DELETE get 405 before any path work. headersTimeout 10 s, requestTimeout 30 s and the clientError handler are in place; a slow-header connection is dropped rather than held.
- Service worker runtime cache allow-list. isShell() is the fix for 'an unexpected 200 from elsewhere on the origin cannot displace a file the app needs offline', and it holds: /some/other/thing.json is served but never written, /evil/index.html does not match through the index.html->'' rewrite, and only the 30 SHELL URLs are cached. Confirmed programmatically that SHELL lists all 22 src/*.js files plus both vendor files, so the offline claim has no gap in it.
- Service worker never stores photographs. The cache holds only the app shell; captured images live in IndexedDB and are never fetched over HTTP, so nothing in the cache can leak them and no cached response is derived from them.
- Network-first with a cache fallback on a bad status (REVIEW VER-1) is correctly implemented: a 404/500/502/503 loses to a good cached copy, a good response wins and refreshes the cache, and a bad status with nothing cached is passed through rather than swallowed. Verified against the real sw.js.
- WebGL shader compilation path. All four fragment shaders and the vertex shader in planeSweepGPU.js are fixed template literals; no value from a photograph, an EXIF tag, a camera label or a setting is ever concatenated into GLSL. Everything variable (uR, uK, uKeep, uWin, uPlanes, uH, uNbSize, the bounds) crosses as a typed uniform. createGpuSweeper fails closed — null without WebGL2 or EXT_color_buffer_float, null on a compile or link error — every depth map is wrapped with a CPU fallback and an isContextLost check, and textures are deleted in a finally. Cost-volume allocation is bounded by the quality preset (High: 320x240x96 R32F, about 29 MB), so nothing a user can pick exhausts GPU memory.
- No third-party network surface at all. A grep for fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource and importScripts across src/, index.html, sw.js, styles.css and manifest.webmanifest returns exactly one hit: sw.js:33, the worker fetching the app's own shell. styles.css loads no url() or @import. three.js is vendored same-origin, so no subresource integrity is needed and no CDN can be compromised. The README's on-device claim is true.
- Message-passing trust boundaries. There is no window.addEventListener('message') anywhere, so no postMessage origin check is missing. The reconstruction worker is a same-origin module Worker whose port only its creator holds; app.js gates every worker message on a build-generation token (src/app.js:497, 511) so a cancelled build's queued messages cannot drive the screen.
- Web app manifest. scope './' and start_url './' keep it to the deployed folder; there is no share_target, no protocol_handlers and no file_handlers, so the app registers no deep-link or intent surface a hostile page or app could aim at.
- Markup construction. Camera labels (OS-supplied) and photo labels (file names) go through the el()/textContent helper at src/app.js:12-17 as CLAUDE.md requires; the surviving innerHTML/insertAdjacentHTML sites carry only fixed strings and computed numbers. A tampered IndexedDB thumbUrl reaches only img.src, where neither a javascript: nor a data:text/html URL executes.
- Service worker registration is gated on window.isSecureContext (src/app.js:818-821), and the lens-override localStorage read is wrapped in try/catch with a {} fallback (src/camera/intrinsics.js:36-38), so neither an insecure origin nor corrupt storage breaks startup.
- The permission probe stream in CameraManager.discover (src/camera/cameraManager.js:34-39) is stopped immediately after enumerateDevices, so the label-unlocking request does not leave a stream running.
- REVIEW.md VER-5 is still open and unchanged — ensureCert (server.js:88) interpolates its own key and certificate paths into an execSync shell command — but it is reachable only by the operator choosing a checkout path containing shell metacharacters, so I am not re-raising it as a new finding beyond noting it survives. execFileSync with an argument array is still the fix.
- Framing. The app can be embedded (no frame-ancestors, no X-Frame-Options, measured) but I could not build an attack on it: a cross-origin frame cannot read the app's DOM, canvas or IndexedDB; camera access inside a frame needs allow="camera" plus the top-level origin's own grant, and even then the captured pixels stay inside the framed origin; Clear and New scan sit behind confirm(). Recorded under L3-5 rather than as a finding of its own.
- The vendored three.js really is what docs/vendored-three.md claims, verified against upstream rather than taken on the note's word. Downloaded https://registry.npmjs.org/three/-/three-0.160.0.tgz; its sha1 matched dist.shasum (cd1e4dbd01aee0719280a9086d75545db52b7a8f) and its sha512 matched dist.integrity exactly; dist.signatures[0] verified against npm's published ECDSA key (keyid SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA) over the payload 'three@0.160.0:sha512-DLU8lc...' -> valid. `cmp` reports all three vendored files byte-identical to package/build/three.module.min.js, package/examples/jsm/controls/OrbitControls.js and package/LICENSE. The recorded sha256s (3e690ac7..., 5a44a9e8..., 852e0e86...) are correct, the 'Local edits: none' claim is true, and OrbitControls.js does still import the bare specifier 'three' resolved by index.html's import map, exactly as documented.
- three@0.160.0 has no known advisory: npm's bulk advisory endpoint (backed by the GitHub Advisory Database) returns {} for it and for playwright@1.56.1. Caveat on method: api.osv.dev and api.github.com/advisories are both blocked by this sandbox's egress policy, so npm's endpoint is the only source I could reach.
- Judged the staleness of three r160 (Dec 2023, 36 releases and 2.7 years behind the current 0.186.0) by reachability rather than by version number: the viewer imports only WebGLRenderer, BufferGeometry, standard materials, Raycaster and OrbitControls, and it renders geometry the app built itself in the worker. No three.js loader (GLTFLoader, OBJLoader, FBXLoader) is vendored or imported, so no attacker-authored file is ever parsed by three.js. Textures come from the browser's own createImageBitmap decode, not from three. The staleness is a maintenance cost, not an attack surface.
- Both pinned action SHAs are real upstream release commits, not typos or an attacker's fork: `git ls-remote --tags actions/checkout` resolves 11d5960a326750d5838078e36cf38b85af677262 to refs/tags/v4 and refs/tags/v4.4.0, and `git ls-remote --tags actions/setup-node` resolves 49933ea5288caeca8642d1e84afbd3f7d6820020 to refs/tags/v4 and refs/tags/v4.4.0. The `# v4` comments are a touch imprecise (both are v4.4.0) but the pins themselves are exact 40-character SHAs.
- Tried to find a fork- or contributor-influenced path to a privileged token in .github/workflows/test.yml and could not. There is no pull_request_target, no workflow_run, no issue_comment trigger, no self-hosted runner, no `secrets.` reference anywhere in the repository, no `github.event` value interpolated into any `run:` shell (grepped the whole tree), no setup-node cache key to poison, and no upload-artifact/download-artifact pair. Top-level `permissions: contents: read` applies to both jobs. A fork PR runs its own test code on an ephemeral runner with a read-only token and nothing to steal, which is the ordinary CI bargain.
- Judged the absence of a lockfile against the stated design and consider it correct here, not an automatic finding: package.json declares zero dependencies and zero devDependencies, there is no node_modules and no .npmrc, no shipped file references any external origin (grepped index.html, manifest.webmanifest, styles.css, sw.js and all of src/ for http(s) URLs -- zero hits outside localhost), and three.js is vendored same-origin. There is no runtime supply chain to lock. The single test-time dependency is pinned in the workflow line itself, which is what REVIEW.md's CI-2 recommendation asked for.
- Nothing ships to users that should not. `git ls-files` has no source maps, no .env, no .pem/.key, no vendored node_modules and no build artefacts; .gitignore excludes node_modules/, .certs/, *.log and scratch/. A secret-pattern grep over the tree (private keys, api keys, tokens, AKIA/ghp_/xox prefixes) hit only test/server.test.js's deliberately hostile path strings, and `git log --diff-filter=D` shows no file has ever been deleted from history, so there is nothing removed-but-recoverable either. The four tracked PNGs carry no tEXt/iTXt metadata chunks (no paths, device names or authoring tool strings). README does tell people to 'deploy the folder to any static host', which publishes test/, tools/, server.js and REVIEW.md alongside the app, but all of it is already public in the repository and none of it is a live endpoint: test/browser/index.html only imports src/vision modules and runs a GPU-vs-CPU plane sweep on synthetic data with no input handling, and server.js is served as inert text, not executed.
- package.json has no lifecycle scripts at all -- no preinstall, install, postinstall, prepare or prepublish -- so `npm install` in this repository executes nothing, and `private: true` with no `files` field means it cannot be published to npm by accident.
- sw.js does not create a stale-code hazard that would pin a security fix out of reach: the fetch handler is network-first (`fetched.then((r) => (r && r.ok ? r : (cached || r || Response.error())))`), so a deployed fix reaches an online client on the next load whether or not the hand-typed VERSION ('phonogeometry-v16') is bumped, and runtime cache.put is gated by isShell() so an unexpected 200 elsewhere on the origin cannot displace a shell entry. test/sw.test.js covers both behaviours and passes.
- Ran the full suite to confirm the guards are actually wired and green rather than just present: `npm test` -> 55 pass, 0 fail, including 'the vendored three.js files are the ones the provenance note describes'.
- The .github/dependabot.yml npm ecosystem entry is a no-op (there is no manifest dependency and no lockfile for it to update) but it is harmless and becomes correct the moment a devDependency lands; the github-actions entry is the one that matters and is configured weekly, which is what keeps the SHA pins moving.

