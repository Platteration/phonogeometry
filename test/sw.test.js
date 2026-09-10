// The service worker decides what the app sees when the network misbehaves. A host that
// answers 404 or 502 must not beat a good copy sitting in the cache: that is the whole
// point of the offline shell.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example.test';
const listeners = {};
let cache;          // url -> Response, standing in for the named cache
let networkAnswer;  // (url) -> Response | Promise rejection

globalThis.self = {
  addEventListener: (type, fn) => { listeners[type] = fn; },
  location: { href: `${ORIGIN}/sw.js` },
  skipWaiting: () => {},
  clients: { claim: () => {} },
};
globalThis.location = { origin: ORIGIN, href: `${ORIGIN}/sw.js` };
globalThis.caches = {
  match: async (req) => cache.get(new URL(req.url).href),
  open: async () => ({ put: async (req, res) => { cache.set(new URL(req.url).href, res); } }),
  keys: async () => [],
  delete: async () => true,
};
globalThis.fetch = async (req) => networkAnswer(new URL(req.url).href);

await import('../sw.js');

function get(url) {
  const event = { request: { method: 'GET', url }, responded: null, respondWith(p) { this.responded = p; } };
  listeners.fetch(event);
  return event.responded;
}

beforeEach(() => {
  cache = new Map();
  networkAnswer = () => { throw new Error('no network expected'); };
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
