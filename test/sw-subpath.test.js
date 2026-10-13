// The service worker as GitHub Pages and any sub-path deploy serve it: from
// <origin>/phonogeometry/sw.js, whose api/ is /phonogeometry/api/. A worker of its own here, in a
// process of its own, because sw.js reads its address once, when it is loaded (test/sw.test.js
// runs the one at the origin's root).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://example.test';
const SITE = `${ORIGIN}/phonogeometry/`;
const listeners = {};
let opened = 0;
globalThis.self = {
  addEventListener: (type, fn) => { listeners[type] = fn; },
  location: { href: `${SITE}sw.js` },
  skipWaiting: () => {},
  clients: { claim: () => {} },
};
globalThis.location = { origin: ORIGIN, href: `${SITE}sw.js` };
globalThis.caches = {
  keys: async () => [],
  delete: async () => true,
  open: async () => { opened++; return { addAll: async () => {}, match: async () => new Response('cached page'), put: async () => {} }; },
};
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
await import('../sw.js');

function get(url, mode) {
  const event = { request: { method: 'GET', url, mode }, responded: null, respondWith(p) { this.responded = p; }, waitUntil() {} };
  listeners.fetch(event);
  return event.responded;
}

test('under a sub-path, the site\'s own api/ is left to the browser, and the rest is the worker\'s', async () => {
  for (const url of [`${SITE}api/config`, `${SITE}api/auth/google/start?return=%2Fphonogeometry%2F`, `${SITE}api/auth/google/callback?code=c&state=s`]) {
    assert.equal(get(url, 'navigate'), null, url);
  }
  assert.equal(opened, 0);
  // The page itself, offline, is still answered from the cache, query string and all.
  assert.equal(await (await get(`${SITE}?purchase=success`, 'navigate')).text(), 'cached page');
});
