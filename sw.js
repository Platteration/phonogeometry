// Service worker: offline-capable app shell (all code, including three.js, is served from this origin).
// Cache Storage is partitioned by origin, not by worker scope, so on a shared static host
// (GitHub Pages puts every project of an account on one origin) this worker sees the caches
// of every other app there. The prefix is what tells its own caches from theirs.
//
// VERSION is derived, not typed: it is a hash of the SHELL files' contents, and
// test/sw.test.js recomputes it and fails, printing the value to paste in, when a shell file
// changes without it. A byte-identical sw.js is never reinstalled, so this name is what takes
// a deploy to an installed copy as a whole: the new worker caches every shell file afresh and
// the old cache goes on activate. A deploy that touches no shell file leaves it alone, and
// nobody downloads three.js again for a README edit.
const PREFIX = 'phonogeometry-';
const VERSION = `${PREFIX}e0ac7b4bb87b`;
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/app.js', 'src/storage.js', 'src/prefs.js', 'src/version.js', 'src/install.js', 'src/camera/cameraManager.js', 'src/camera/intrinsics.js', 'src/camera/exif.js',
  'src/pipeline/reconstruct.js', 'src/pipeline/worker.js',
  'src/vision/linalg.js', 'src/vision/image.js', 'src/vision/fast.js', 'src/vision/orb.js', 'src/vision/match.js',
  'src/vision/geometry.js', 'src/vision/ba.js', 'src/vision/sfm.js', 'src/vision/planeSweep.js', 'src/vision/planeSweepGPU.js',
  'src/mesh/tsdf.js', 'src/mesh/surfaceNets.js', 'src/mesh/meshUtils.js', 'src/mesh/exporters.js',
  'src/viewer/viewer.js', 'vendor/three/three.module.min.js', 'vendor/three/OrbitControls.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Only the shell is cached at runtime, so an unexpected 200 from elsewhere on the origin
// cannot displace a file the app needs offline.
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.location.href).href));
function isShell(url) {
  const bare = url.origin + url.pathname;
  return SHELL_URLS.has(bare) || SHELL_URLS.has(bare.replace(/index\.html$/, ''));
}

// Read from this app's own cache, not the origin's: the bare caches.match searches every
// cache there, so offline it could answer with a file another app cached under this URL.
// Opening a cache can fail where matching one cannot (it creates the cache when it is absent,
// so an evicted quota or a broken backend rejects), and this heads the fetch handler's chain:
// a rejection here would be a network error for every request the worker intercepts, the page
// itself included, online or offline. A lookup that cannot answer is a miss, and the network
// still gets its turn.
function lookup(req) {
  return caches.open(VERSION).then((c) => c.match(req)).catch(() => undefined);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(
      lookup(e.request).then((cached) => {
        const fetched = fetch(e.request).then((res) => {
          if (res && res.ok && isShell(url)) {
            // Copy the body before the response goes to the page, which reads it: a clone taken
            // after that throws, so one taken inside the cache open below never reached the cache.
            const copy = res.clone();
            e.waitUntil(caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => { /* the response still stands */ }));
          }
          return res;
        }).catch(() => null);
        // Network first so updates land quickly, falling back to the cache when offline —
        // and also when the network answers badly. A 404 during a partial deploy or a 502
        // from the host would otherwise break an app that is sitting complete in the cache.
        return fetched.then((r) => (r && r.ok ? r : (cached || r || Response.error())));
      }),
    );
  }
});
