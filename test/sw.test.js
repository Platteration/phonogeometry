// The service worker decides what the app sees when the network misbehaves. A host that
// answers 404 or 502 must not beat a good copy sitting in the cache: that is the whole
// point of the offline shell. The origin it runs on is shared — the documented deploy target
// puts every project of an account on one — so the caches of other apps are here too.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORIGIN = 'https://example.test';
const FOREIGN = 'ambient-noiser-9f2c41';   // another app's cache, on the same origin
const listeners = {};
const store = new Map();   // cache name -> Map(url -> Response), standing in for Cache Storage
let opened;         // the cache names the worker asked to open, in order
let cache;          // this app's own cache, whatever it calls it
let networkAnswer;  // (url) -> Response | Promise rejection
let installed;      // the list the install handler hands cache.addAll
let openFails;      // when set, caches.open rejects, as it does on an evicted quota or a broken backend
let extended = [];  // every promise the worker hands an event's waitUntil

globalThis.self = {
  addEventListener: (type, fn) => { listeners[type] = fn; },
  location: { href: `${ORIGIN}/sw.js` },
  skipWaiting: () => {},
  clients: { claim: () => {} },
};
globalThis.location = { origin: ORIGIN, href: `${ORIGIN}/sw.js` };
globalThis.caches = {
  keys: async () => [...store.keys()],
  delete: async (name) => store.delete(name),
  // A real Cache Storage answers on a later task, after the page has started reading the
  // response it was handed. A stub that answered in a microtask let a clone taken inside
  // the open pass here while Chromium threw ('body is already used') and cached nothing.
  open: async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened.push(name);
    if (openFails) throw new DOMException('The cache could not be opened', 'QuotaExceededError');
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      addAll: async (list) => { installed = list; },
      match: async (req) => entries.get(new URL(req.url).href),
      put: async (req, res) => { entries.set(new URL(req.url).href, res); },
    };
  },
  // The unscoped match searches every cache on the origin. Faithfully so: that is the thing
  // the worker must not use.
  match: async (req) => { for (const entries of store.values()) { const hit = entries.get(new URL(req.url).href); if (hit) return hit; } return undefined; },
};
globalThis.fetch = async (req) => networkAnswer(new URL(req.url).href);

await import('../sw.js');

// Take the worker's own cache name from the install it performs, rather than repeating the
// constant here: a version bump must not quietly turn these tests into checks of nothing.
opened = [];
const installing = [];
await listeners.install({ waitUntil: (p) => installing.push(p) });
await Promise.all(installing);
const OWN = opened[0];

async function activated() {
  const waits = [];
  await listeners.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

function get(url) {
  const event = {
    request: { method: 'GET', url },
    responded: null,
    respondWith(p) { this.responded = p; },
    waitUntil(p) { extended.push(p); },
  };
  listeners.fetch(event);
  return event.responded;
}

/** Until everything the worker asked to be kept alive for has finished, and two tasks more
 *  so that a write it left floating outside waitUntil is seen as well. */
async function settled() {
  do {
    await Promise.all(extended.splice(0));
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } while (extended.length > 0);
}

beforeEach(() => {
  store.clear();
  store.set(OWN, new Map());
  cache = store.get(OWN);
  opened = [];
  extended = [];
  openFails = false;
  networkAnswer = () => { throw new Error('no network expected'); };
});

test('activating clears this app\'s stale caches and leaves the other apps on the origin alone', async () => {
  const stale = `${OWN}-old`;
  store.set(stale, new Map());
  store.set(FOREIGN, new Map([[`${ORIGIN}/other-app/index.html`, new Response('their shell')]]));
  await activated();
  assert.deepEqual([...store.keys()].sort(), [OWN, FOREIGN].sort());
});

test('offline it serves its own copy, not one another app cached under the same URL', async () => {
  store.set(FOREIGN, new Map([[`${ORIGIN}/src/app.js`, new Response('another app\'s copy')]]));
  cache.set(`${ORIGIN}/src/app.js`, new Response('our app'));
  networkAnswer = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await (await get(`${ORIGIN}/src/app.js`)).text(), 'our app');

  // And with nothing of ours cached, the neighbour's entry is not a fallback either.
  cache.delete(`${ORIGIN}/src/app.js`);
  const res = await get(`${ORIGIN}/src/app.js`);
  assert.equal(res.type, 'error');
});

test('a bad status from the network loses to a good cached copy', async () => {
  cache.set(`${ORIGIN}/src/app.js`, new Response('cached app', { status: 200 }));
  for (const status of [404, 500, 502, 503]) {
    networkAnswer = async () => new Response('the host is unwell', { status });
    const res = await get(`${ORIGIN}/src/app.js`);
    assert.equal(res.status, 200, `status ${status}`);
    assert.equal(await res.clone().text(), 'cached app');
  }
});

test('an offline fetch falls back to the cache, as before', async () => {
  cache.set(`${ORIGIN}/index.html`, new Response('cached page', { status: 200 }));
  networkAnswer = async () => { throw new TypeError('Failed to fetch'); };
  const res = await get(`${ORIGIN}/index.html`);
  assert.equal(await res.text(), 'cached page');
});

test('a good response is preferred over the cache and refreshes it', async () => {
  cache.set(`${ORIGIN}/styles.css`, new Response('old', { status: 200 }));
  networkAnswer = async () => new Response('new', { status: 200 });
  const res = await get(`${ORIGIN}/styles.css`);
  assert.equal(await res.text(), 'new');   // the page reads the body first, as a browser does
  await settled();
  assert.equal(await cache.get(`${ORIGIN}/styles.css`).text(), 'new');
});

// caches.open creates the cache when it is absent, so it can fail where a match cannot: an
// evicted quota, a corrupt backend. It heads the fetch handler's chain, so a rejection there
// is not a cache miss but a network error for every request the worker intercepts, the page
// itself included, online or offline, with no way to reach the page that would unregister the
// worker. A lookup that cannot answer is a miss, and the network still gets its turn.
test('a cache that will not open is a miss, not a dead page', async () => {
  openFails = true;
  networkAnswer = async (url) => new Response(`network ${url}`, { status: 200 });
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/index.html`, `${ORIGIN}/src/app.js`, `${ORIGIN}/some/other/thing.json`]) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.equal(await res.text(), `network ${url}`, `${url} is answered from the network`);
  }
  await settled();   // the write-back fails as well, and is dropped rather than left rejected
  assert.ok(opened.length > 0 && opened.every((name) => name === OWN), `only this app's cache is asked for: ${opened.join(', ')}`);

  // The network answering badly with no cache to fall back on is passed through, as before.
  networkAnswer = async () => new Response('the host is unwell', { status: 502 });
  assert.equal((await get(`${ORIGIN}/src/app.js`)).status, 502);

  // No cache and no network: a network error the page can see as one, not a rejection.
  networkAnswer = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await get(`${ORIGIN}/`)).type, 'error');
});

test('a bad status with nothing cached is passed through, not swallowed', async () => {
  networkAnswer = async () => new Response('gone', { status: 404 });
  const res = await get(`${ORIGIN}/src/app.js`);
  assert.equal(res.status, 404);
});

test('only shell files are written to the cache at runtime', async () => {
  networkAnswer = async () => new Response('something else on this origin', { status: 200 });
  await get(`${ORIGIN}/some/other/thing.json`);
  await settled();
  assert.equal(cache.size, 0);

  networkAnswer = async () => new Response('shell', { status: 200 });
  await get(`${ORIGIN}/src/vision/sfm.js`);
  await settled();
  assert.equal(cache.size, 1);
});

test('the page itself counts as shell, with or without index.html', async () => {
  networkAnswer = async () => new Response('page', { status: 200 });
  await get(`${ORIGIN}/`);
  await get(`${ORIGIN}/index.html`);
  await settled();
  assert.equal(cache.size, 2);
});

// The runtime refresh above only rewrites what a visitor happens to fetch, so on its own a
// deploy would leave an installed copy half old and half new offline. What moves the whole
// shell is a new cache name, and a name typed by hand was left alone by three commits that
// changed shell files. So the name is a hash of the shell's bytes, and this recomputes it.
test('the cache name is derived from the shell files, so a deploy that changes one replaces the whole cache', () => {
  assert.ok(Array.isArray(installed) && installed.length > 0, 'the worker caches its shell on install');
  const hash = createHash('sha256');
  for (const entry of installed) {
    const file = new URL(entry, `${ORIGIN}/sw.js`).pathname.slice(1) || 'index.html';
    hash.update(`${entry}\0`).update(fs.readFileSync(path.join(root, file)));
  }
  const digest = hash.digest('hex').slice(0, 12);
  assert.equal(OWN, `phonogeometry-${digest}`,
    `sw.js VERSION does not match the shell: installed copies would keep the old files offline. Set it to \`\${PREFIX}${digest}\`.`);
});
