// Service worker: offline-capable app shell (all code, including three.js, is served from this origin).
const VERSION = 'phonogeometry-v16';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/app.js', 'src/storage.js', 'src/camera/cameraManager.js', 'src/camera/intrinsics.js', 'src/camera/exif.js',
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
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Only the shell is cached at runtime, so an unexpected 200 from elsewhere on the origin
// cannot displace a file the app needs offline.
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.location.href).href));
function isShell(url) {
  const bare = url.origin + url.pathname;
  return SHELL_URLS.has(bare) || SHELL_URLS.has(bare.replace(/index\.html$/, ''));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fetched = fetch(e.request).then((res) => {
          if (res && res.ok && isShell(url)) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
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
