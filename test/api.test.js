// The website's API as this app deploys it: server/catalogue.js through the kit, by both ways in
// (functions/api/[[path]].js on Cloudflare Pages, server/start.mjs on a host of its own), with a
// fake Google and a fake Stripe handed to the kit through its `fetch` (test/apiFakes.js), never
// through a variable that names another host. The kit's own guards are its self-test's
// (server/kit/selftest.mjs, which `npm test` runs too); this is the app's catalogue, its entry
// points and the files the hosts read, end to end.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalogue from '../server/catalogue.js';
import { start } from '../server/start.mjs';
import { priceVariable, validateCatalogue } from '../server/kit/app.js';
import { pagesHandler } from '../server/kit/cloudflare.js';
import { SUPPORTER } from '../src/account.js';
import { createFakes, envFor, signedDelivery } from './apiFakes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Nothing here may reach the network: the fakes are injected instead, and a test that reached
// for the real Google or Stripe fails here. Loopback, where the API under test listens, goes
// through the real fetch.
const realFetch = globalThis.fetch;
const escaped = [];
before(() => {
  globalThis.fetch = async (input) => {
    escaped.push(String(input));
    throw new Error(`a test reached for the network: ${String(input)}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(escaped, []);
});

describe('the catalogue', () => {
  test('sells one "Support this app" payment, granting supporter, and nothing else', () => {
    const checked = validateCatalogue(catalogue);
    assert.equal(checked.app, 'phonogeometry');
    assert.deepEqual(checked.products.map((p) => [p.id, p.name, p.mode, p.grants]), [['supporter', 'Support this app', 'payment', 'supporter']]);
    assert.equal(priceVariable('supporter'), 'STRIPE_PRICE_SUPPORTER');
    // The page asks for that product and reads that entitlement.
    assert.equal(SUPPORTER, 'supporter');
  });

  test('is what the API is built from, and the test fakes are not', () => {
    for (const file of ['server/start.mjs', 'server/catalogue.js', 'functions/api/[[path]].js']) {
      for (const line of read(file).match(/^import .*$/gm) ?? []) assert.doesNotMatch(line, /fakes|test/i, `${file} imports nothing of the tests`);
    }
  });
});

describe('the files the hosts read', () => {
  test("Cloudflare Pages: functions/api/[[path]].js is the kit's three-line entry with this app's catalogue", () => {
    const entry = 'functions/api/[[path]].js';
    assert.equal(read(entry), [
      "import { pagesHandler } from '../../server/kit/cloudflare.js';",
      "import catalogue from '../../server/catalogue.js';",
      'export const onRequest = pagesHandler(catalogue);',
      '',
    ].join('\n'));
    for (const target of ['../../server/kit/cloudflare.js', '../../server/catalogue.js']) {
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(entry), target)), target);
    }
  });

  test('Cloudflare Pages: _routes.json sends /api/* to the function and nothing else', () => {
    assert.deepEqual(JSON.parse(read('_routes.json')), { version: 1, include: ['/api/*'], exclude: [] });
  });

  test("the site's api/config is the kit's own answer with nothing configured, byte for byte", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-off-'));
    const api = await start({ env: {}, dataDir, port: 0, fetch: async () => { throw new Error('no call expected'); }, log: () => {} });
    try {
      const answer = await realFetch(new URL('api/config', api.url));
      assert.equal(`${await answer.text()}\n`, read('api/config'));
    } finally {
      await api.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Cloudflare Pages: the entry, its KV store and the fakes', () => {
  /** A Workers KV namespace in memory, as much of one as the kit uses. */
  const kv = () => {
    const data = new Map();
    return {
      data,
      get: async (key) => (data.has(key) ? JSON.parse(data.get(key)) : null),
      put: async (key, value) => void data.set(key, value),
      delete: async (key) => void data.delete(key),
    };
  };

  test('reports nothing on, and answers nothing else, with no variables set', async () => {
    const onRequest = pagesHandler(catalogue);
    const env = { KIT_STORE: kv() };
    const config = await onRequest({ request: new Request('https://phonogeometry.example/api/config'), env });
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), { auth: { google: false }, shop: { products: [] } });
    assert.equal(config.headers.get('cache-control'), 'public, max-age=60');
    for (const route of ['me', 'auth/google/start', 'checkout', 'portal', 'webhooks/stripe', 'nothing']) {
      assert.equal((await onRequest({ request: new Request(`https://phonogeometry.example/api/${route}`), env })).status, 404, route);
    }
  });

  test('signs in and sells under a sub-path too, with every address taken from APP_URL', async () => {
    const fakes = await createFakes();
    const store = kv();
    const appUrl = 'https://example.com/phonogeometry/';
    const env = { ...envFor(appUrl), KIT_STORE: store };
    // The kit calls Google and Stripe through the Workers global fetch; the fakes stand in for it.
    const blocked = globalThis.fetch;
    globalThis.fetch = fakes.fetch;
    try {
      const onRequest = pagesHandler(catalogue);
      const call = (url, init) => onRequest({ request: new Request(url, init), env });
      const config = await (await call(`${appUrl}api/config`)).json();
      assert.deepEqual(config.shop.products.map((p) => [p.id, p.price]), [['supporter', { unit_amount: 400, currency: 'eur' }]]);
      const started = await call(`${appUrl}api/auth/google/start?return=${encodeURIComponent('/phonogeometry/')}`);
      assert.equal(started.status, 302);
      const google = new URL(started.headers.get('location'));
      assert.equal(google.searchParams.get('redirect_uri'), `${appUrl}api/auth/google/callback`);
      const oauth = started.headers.get('set-cookie').split(';')[0];
      assert.match(oauth, /^__Host-phonogeometry-oauth=/);
      const back = fakes.consent(google.href);
      const landed = await call(back.href, { headers: { cookie: oauth } });
      assert.equal(landed.status, 302);
      assert.equal(landed.headers.get('location'), 'https://example.com/phonogeometry/');
      const session = landed.headers.getSetCookie().find((c) => c.startsWith('__Host-phonogeometry-session='))?.split(';')[0];
      assert.ok(session, 'a session cookie');
      const me = await (await call(`${appUrl}api/me`, { headers: { cookie: session } })).json();
      assert.deepEqual(me, { user: { email: 'ada@example.com' }, entitlements: [] });
      const checkout = await call(`${appUrl}api/checkout`, {
        method: 'POST', headers: { cookie: session, origin: 'https://example.com', 'content-type': 'application/json' }, body: JSON.stringify({ product: 'supporter' }),
      });
      assert.equal(checkout.status, 200);
      const { url } = await checkout.json();
      const asked = fakes.sessions.get(new URL(url).pathname.split('/').pop());
      assert.equal(asked.get('success_url'), `${appUrl}?purchase=success`);
      assert.equal(asked.get('metadata[app]'), 'phonogeometry');
      const delivery = signedDelivery(fakes.paid(url));
      const hook = await call(`${appUrl}api/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': delivery.signature, 'content-type': 'application/json' }, body: delivery.body });
      assert.equal(hook.status, 200);
      assert.deepEqual((await (await call(`${appUrl}api/me`, { headers: { cookie: session } })).json()).entitlements, ['supporter']);
      // Every record is the app's own, so one namespace can be shared without one app reading another's.
      assert.ok([...store.data.keys()].every((key) => key.startsWith('phonogeometry:')), [...store.data.keys()].join(' '));
      assert.deepEqual(fakes.unexpected, []);
    } finally {
      globalThis.fetch = blocked;
    }
  });
});

describe('a host of its own: server/start.mjs through the Node adapter', () => {
  // The public address is the proxy's (deploy/nginx.conf), not the loopback port the API listens
  // on: the kit takes every absolute URL from APP_URL, and the CSRF gate the origin.
  const APP_URL = 'https://phonogeometry.example/';
  const ORIGIN = 'https://phonogeometry.example';
  let fakes;
  let api;
  let dataDir;
  const logs = [];

  before(async () => {
    fakes = await createFakes();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-api-'));
    api = await start({ env: envFor(APP_URL), dataDir, port: 0, fetch: fakes.fetch, log: (level, message) => logs.push(`${level}: ${message}`) });
  });
  after(async () => {
    await api?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** A browser's cookie jar, sending what the proxy would pass on. */
  const browser = () => {
    const jar = new Map();
    const send = async (method, target, { json } = {}) => {
      const url = new URL(target, APP_URL);
      const headers = new Headers();
      if (jar.size) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
      if (method !== 'GET') headers.set('origin', ORIGIN);
      if (json !== undefined) headers.set('content-type', 'application/json');
      const response = await realFetch(new URL(`${url.pathname}${url.search}`, api.url), {
        method, headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual',
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';');
        const name = pair.slice(0, pair.indexOf('='));
        if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
        else jar.set(name, pair.slice(pair.indexOf('=') + 1));
      }
      return response;
    };
    const signIn = async (person = { sub: '1001', email: 'ada@example.com' }) => {
      const started = await send('GET', 'api/auth/google/start?return=%2F');
      assert.equal(started.status, 302);
      const landed = await send('GET', fakes.consent(started.headers.get('location'), person).href);
      assert.equal(landed.status, 302);
      assert.equal(landed.headers.get('location'), `${ORIGIN}/`);
    };
    const me = async () => (await send('GET', 'api/me')).json();
    return { jar, send, signIn, me };
  };
  /** The records the file store holds that mention `text`, by key. */
  const recordsWith = (text) => fs.readdirSync(dataDir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'))).filter((entry) => JSON.stringify(entry.value).includes(text)).map((entry) => entry.key);
  const webhook = (delivery) => realFetch(new URL('api/webhooks/stripe', api.url), {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': delivery.signature }, body: delivery.body,
  });

  test('lists "Support this app" with its price from Stripe, and sends the API\'s own headers', async () => {
    const response = await browser().send('GET', 'api/config');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      auth: { google: true },
      shop: { products: [{ id: 'supporter', name: 'Support this app', description: catalogue.products[0].description, mode: 'payment', price: { unit_amount: 400, currency: 'eur' } }] },
    });
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(api.features, { signIn: true, shop: true });
  });

  test('signs in, sells the support payment, grants it on the signed webhook alone, signs out and deletes the account', async () => {
    const visitor = browser();
    assert.deepEqual(await visitor.me(), { user: null, entitlements: [] });
    assert.equal((await visitor.send('POST', 'api/checkout', { json: { product: 'supporter' } })).status, 401, 'signed out, nothing is sold');
    await visitor.signIn();
    assert.deepEqual(await visitor.me(), { user: { email: 'ada@example.com' }, entitlements: [] });
    // What About and the README say the site keeps: the email, in the session record alone.
    assert.deepEqual(recordsWith('ada@example.com').map((key) => key.replace(/[0-9a-f]{64}$/, '…')), ['phonogeometry:session:…'], 'the email is kept with the sign-in, and nowhere else');

    const checkout = await visitor.send('POST', 'api/checkout', { json: { product: 'supporter' } });
    assert.equal(checkout.status, 200);
    const { url } = await checkout.json();
    assert.match(url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_fake\d+$/);
    const asked = fakes.sessions.get(new URL(url).pathname.split('/').pop());
    assert.equal(asked.get('mode'), 'payment');
    assert.equal(asked.get('line_items[0][price]'), 'price_supporterFake');
    assert.equal(asked.get('metadata[app]'), 'phonogeometry');
    assert.equal(asked.get('metadata[product]'), 'supporter');
    assert.equal(asked.get('metadata[user]'), 'google:1001');
    // ...and what they say Stripe is told: the account id, with the payment.
    assert.equal(asked.get('client_reference_id'), 'google:1001');
    assert.equal(asked.get('payment_intent_data[metadata][user]'), 'google:1001');
    assert.equal([...asked.values()].some((value) => value.includes('ada@example.com')), false, 'and not the email');
    assert.equal(asked.get('success_url'), `${APP_URL}?purchase=success`);
    assert.equal(asked.get('cancel_url'), `${APP_URL}?purchase=cancelled`);
    assert.equal((await visitor.send('POST', 'api/checkout', { json: { product: 'pro' } })).status, 404, 'nothing outside the catalogue is sold');

    // Coming back from Checkout grants nothing: only Stripe's signed word does.
    assert.deepEqual((await visitor.me()).entitlements, []);
    assert.equal((await webhook(signedDelivery(fakes.paid(url), { secret: 'whsec_notTheEndpointsSecret000' }))).status, 400);
    assert.deepEqual((await visitor.me()).entitlements, [], 'a webhook signed with another secret grants nothing');
    const delivery = signedDelivery(fakes.paid(url));
    assert.equal((await webhook(delivery)).status, 200);
    assert.deepEqual(await visitor.me(), { user: { email: 'ada@example.com' }, entitlements: ['supporter'] });
    assert.equal((await webhook(delivery)).status, 200, 'a delivery Stripe repeats is acknowledged and applied once');
    assert.equal((await visitor.send('POST', 'api/checkout', { json: { product: 'supporter' } })).status, 409, 'a supporter is not sold it twice');

    assert.equal((await visitor.send('POST', 'api/auth/logout')).status, 204);
    assert.deepEqual(await visitor.me(), { user: null, entitlements: [] });
    assert.deepEqual(recordsWith('ada@example.com'), [], 'kept while signed in: signing out takes it');
    await visitor.signIn();
    assert.deepEqual((await visitor.me()).entitlements, ['supporter'], 'the purchase is the account\'s');
    assert.equal((await visitor.send('DELETE', 'api/me')).status, 204);
    assert.deepEqual(await visitor.me(), { user: null, entitlements: [] });
    assert.deepEqual(recordsWith('ada@example.com'), [], 'Delete account takes the email with it');
    assert.deepEqual(recordsWith('google:1001'), [], 'and every record of the account');
    await visitor.signIn();
    assert.deepEqual(await visitor.me(), { user: { email: 'ada@example.com' }, entitlements: [] }, 'deleting the account took the purchase with it');

    assert.deepEqual(fakes.unexpected, []);
    assert.deepEqual(logs, []);
    // The file store holds the records, one file per key named by its hash.
    assert.ok(fs.readdirSync(dataDir).every((name) => /^[0-9a-f]{64}\.json$/.test(name)));
  });

  test('refuses a write from another origin, and one without an Origin', async () => {
    const visitor = browser();
    await visitor.signIn({ sub: '2002', email: 'grace@example.com' });
    const cookie = [...visitor.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    for (const origin of ['https://evil.example', null]) {
      const response = await realFetch(new URL('api/checkout', api.url), {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ product: 'supporter' }),
      });
      assert.equal(response.status, 403, String(origin));
    }
  });
});

describe('server/start.mjs run as a program', () => {
  const script = path.join(root, 'server', 'start.mjs');
  /** The environment a service manager would start it with: none of the developer's. */
  const bare = (extra) => ({ PATH: process.env.PATH ?? '', ...extra });

  test('refuses to start without a data directory', () => {
    const run = spawnSync(process.execPath, [script], { env: bare({}), encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /set KIT_DATA_DIR/);
  });

  test('listens on loopback, with everything off when nothing is configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-start-'));
    const child = spawn(process.execPath, [script], { env: bare({ KIT_DATA_DIR: dir, KIT_PORT: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    try {
      const line = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); if (out.includes('\n')) resolve(out.trim()); });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${stderr}`)));
      });
      const match = /^phonogeometry api listening on (http:\/\/127\.0\.0\.1:\d+\/) \(sign-in off, shop off\)$/.exec(line);
      assert.ok(match, line);
      assert.deepEqual(await (await realFetch(new URL('api/config', match[1]))).json(), { auth: { google: false }, shop: { products: [] } });
      assert.equal((await realFetch(new URL('api/me', match[1]))).status, 404);
      assert.equal(stderr, '');
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
