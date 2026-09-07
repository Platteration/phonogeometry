// Service worker: offline-capable app shell (all code, including three.js, is served from this origin).
const VERSION = 'phonogeometry-v4';
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
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fetched = fetch(e.request).then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
          return res;
        }).catch(() => cached);
        // Network first so updates land quickly, falling back to the cache when offline.
        return fetched.then((r) => r || cached);
      }),
    );
  }
});
