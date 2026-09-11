// The service worker decides what the app sees when the network misbehaves. A host that
// answers 404 or 502 must not beat a good copy sitting in the cache: that is the whole
// point of the offline shell. The origin it runs on is shared — the documented deploy target
// puts every project of an account on one — so the caches of other apps are here too.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example.test';
const FOREIGN = 'ambient-noiser-9f2c41';   // another app's cache, on the same origin
const listeners = {};
const store = new Map();   // cache name -> Map(url -> Response), standing in for Cache Storage
let opened;         // the cache names the worker asked to open, in order
let cache;          // this app's own cache, whatever it calls it
let networkAnswer;  // (url) -> Response | Promise rejection

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
  open: async (name) => {
    opened.push(name);
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    return {
      addAll: async () => {},
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
  const event = { request: { method: 'GET', url }, responded: null, respondWith(p) { this.responded = p; } };
  listeners.fetch(event);
  return event.responded;
}

beforeEach(() => {
  store.clear();
  store.set(OWN, new Map());
  cache = store.get(OWN);
  opened = [];
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
  assert.equal(await res.text(), 'new');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await cache.get(`${ORIGIN}/styles.css`).text(), 'new');
});

test('a bad status with nothing cached is passed through, not swallowed', async () => {
  networkAnswer = async () => new Response('gone', { status: 404 });
  const res = await get(`${ORIGIN}/src/app.js`);
  assert.equal(res.status, 404);
});

test('only shell files are written to the cache at runtime', async () => {
  networkAnswer = async () => new Response('something else on this origin', { status: 200 });
  await get(`${ORIGIN}/some/other/thing.json`);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cache.size, 0);

  networkAnswer = async () => new Response('shell', { status: 200 });
  await get(`${ORIGIN}/src/vision/sfm.js`);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cache.size, 1);
});

test('the page itself counts as shell, with or without index.html', async () => {
  networkAnswer = async () => new Response('page', { status: 200 });
  await get(`${ORIGIN}/`);
  await get(`${ORIGIN}/index.html`);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cache.size, 2);
});
