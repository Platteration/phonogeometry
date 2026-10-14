// @ts-check
// The kit's self-test: `node --test server/kit/selftest.mjs`. No network: Google and Stripe
// are fakes behind the injected `fetch` (an RSA key made with Web Crypto signs the ID tokens
// and its public half is the JWKS; webhooks are signed with node:crypto, independently of the
// kit's own HMAC). Any request to an address the fakes do not serve fails the test that made it.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { createApp, priceVariable, safeReturnPath, validateCatalogue } from './app.js';
import { kvStore, pagesHandler } from './cloudflare.js';
import { base64url, digestsEqual, fromBase64url, fromHex, hex, safeEqual } from './crypto.js';
import { AuthError, createKeyCache, verifyIdToken } from './google.js';
import { API_HEADERS, parseCookies, readBytes } from './http.js';
import { createFileStore, serve } from './node.js';
import { createMemoryStore } from './store.js';
import { StripeError, flattenParams, getPrice, parseSignatureHeader, verifySignature } from './stripe.js';

// The web globals this file uses, named once, so that it lints under a configuration that
// declares no environment at all (the strictest in the fleet).
const { crypto, console, Headers, ReadableStream, Request, Response, TextEncoder, URL, URLSearchParams } = globalThis;

// -------------------------------------------------------------------------------------------
// Fixtures. Secrets are assembled at run time so no scanner mistakes them for real ones.

const APP_URL = 'https://shop.example/';
const ORIGIN = 'https://shop.example';
const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = ['GOCSPX', 'selftest', 'not', 'a', 'secret'].join('-');
const SESSION_SECRET = base64url(new Uint8Array(32).fill(7));
const STRIPE_KEY = ['sk', 'test', 'selftest0000000000000000'].join('_');
const LIVE_KEY = ['sk', 'live', 'selftest0000000000000000'].join('_');
const WEBHOOK_SECRET = ['whsec', 'selftestselftestselftestselftest'].join('_');
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const USER = 'google:1001';

const CATALOGUE = {
  app: 'demo',
  name: 'Demo',
  products: [
    { id: 'pro', name: 'Pro', description: 'Everything unlocked', mode: 'payment', grants: 'pro' },
    { id: 'monthly', name: 'Monthly', description: 'Support every month', mode: 'subscription', grants: 'supporter' },
    { id: 'later', name: 'Later', description: 'Not priced yet', mode: 'payment', grants: 'later' },
  ],
};

/** @type {Record<string, string>} */
const ENV = {
  APP_URL,
  SESSION_SECRET,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PRO: 'price_pro123',
  STRIPE_PRICE_MONTHLY: 'price_monthly123',
};

/** @type {{ kid: string, privateKey: TestKey, jwk: Record<string, unknown> }} */
let KEY_A;
/** @type {{ kid: string, privateKey: TestKey, jwk: Record<string, unknown> }} */
let KEY_B;

/**
 * The key type the global `crypto.subtle.sign` takes, whichever library declares it: lib.dom's
 * where the DOM is loaded, Node's otherwise. Node's own `webcrypto.CryptoKey` is not that type
 * under @types/node 26, whose key usages lib.dom does not list.
 * @typedef {Parameters<typeof crypto.subtle.sign>[1]} TestKey
 */

/** @param {string} kid */
async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid } };
}

// The kit reaches Google and Stripe only through the fetch it is given. For the length of this
// run the global one fails, so a module that reached for it would fail its test rather than
// make a real request.
const globalFetch = globalThis.fetch;
before(async () => {
  KEY_A = await makeKey('key-a');
  KEY_B = await makeKey('key-b');
  globalThis.fetch = async (input) => {
    throw new Error(`the self-test reached for the network: ${String(input)}`);
  };
});
after(() => {
  globalThis.fetch = globalFetch;
});

const enc = new TextEncoder();
/** @param {string | Uint8Array | ArrayBuffer} data */
const b64 = (data) => base64url(typeof data === 'string' ? enc.encode(data) : new Uint8Array(data));

/**
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} claims
 * @param {TestKey} privateKey
 */
async function signJwt(header, claims, privateKey) {
  const head = b64(JSON.stringify(header));
  const body = b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64(signature)}`;
}

/**
 * Claims Google would put in a fresh ID token for `nonce`, at time `at` (ms).
 * @param {string} nonce
 * @param {number} at
 * @param {Record<string, unknown>} [extra]
 */
function claimsFor(nonce, at, extra = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '1001',
    email: 'ada@example.com',
    email_verified: true,
    iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 3600,
    nonce,
    ...extra,
  };
}

// -------------------------------------------------------------------------------------------
// The fake world: a clock, Google and Stripe behind one fetch.

/**
 * @typedef {{ sub?: string, email?: string, verified?: boolean, kid?: string, claims?: Record<string, unknown>, header?: Record<string, unknown> }} Profile
 */

function createWorld() {
  const world = {
    clock: T0,
    /** @type {{ url: string, method: string, headers: Headers, body: string }[]} */
    calls: [],
    /** @type {string[]} */
    unexpected: [],
    /** @type {Record<string, unknown>[]} */
    jwks: [KEY_A.jwk],
    jwksCacheControl: 'public, max-age=3600, must-revalidate',
    jwksStatus: 200,
    /** @type {'ok' | 'error' | 'hang' | 'throw' | 'error-with-token'} */
    token: 'ok',
    /** @type {Map<string, { challenge: string, redirectUri: string, nonce: string, profile: Profile }>} */
    codes: new Map(),
    codeSeq: 0,
    /** @type {Map<string, Record<string, unknown>>} */
    prices: new Map([
      ['price_pro123', { id: 'price_pro123', object: 'price', active: true, currency: 'eur', unit_amount: 499, recurring: null, type: 'one_time' }],
      ['price_monthly123', { id: 'price_monthly123', object: 'price', active: true, currency: 'eur', unit_amount: 199, recurring: { interval: 'month', interval_count: 1 }, type: 'recurring' }],
    ]),
    pricesFail: false,
    /** @type {'ok' | 'error' | 'drop-once'} */
    checkout: 'ok',
    /** @type {{ status: number, error: Record<string, unknown> } | null} what Stripe refuses the next Checkout Session with */
    checkoutRefusal: null,
    /** @type {URLSearchParams[]} */
    sessions: [],
    /** @type {URLSearchParams[]} */
    portals: [],
    sessionSeq: 0,
    /**
     * Each Checkout Session made, as Stripe keeps it: open until paid (`pay`) or past its
     * expires_at, when Stripe reports it expired; once paid, the PaymentIntent (payment mode) or
     * the Subscription (subscription mode) it made.
     * @type {Map<string, { status: 'open' | 'complete', expires: number, url: string, mode: string, paymentIntent: string | null, subscription: string | null }>}
     */
    checkouts: new Map(),
    /** @type {'ok' | number} how Stripe answers a Checkout Session lookup: as it keeps them, or with that status */
    sessionLookup: /** @type {'ok' | number} */ ('ok'),
    /**
     * What Stripe keeps of each Checkout Session request by its Idempotency-Key (its "Idempotent
     * requests"): the request's form and, once it has run, its answer, an error included, which a
     * later request with that key and the same form is given again (`replays` counts them). While
     * the first is still running, another with its key is refused, 409 `idempotency_key_in_use`,
     * and nothing of that is kept; another form under a key already used is refused, 400.
     * @type {Map<string, { form: string, answer: { status: number, body: Record<string, unknown> } | null }>}
     */
    idempotency: new Map(),
    replays: 0,
    /** @type {(() => Promise<unknown>) | null} awaited while a Checkout Session is being made, once its key is taken */
    making: /** @type {(() => Promise<unknown>) | null} */ (null),
    /** @type {Set<string>} customers Stripe no longer knows (deleted in the dashboard) */
    deletedCustomers: new Set(),
    /**
     * The visitor pays the Checkout Session the kit last gave them (or `id`): cs_test_<n> makes
     * pi_test<n> (payment mode) or sub_test<n> (subscription mode), unless `made` says otherwise
     * (a free checkout makes no PaymentIntent).
     * @param {string} [id]
     * @param {{ paymentIntent?: string | null, subscription?: string | null }} [made]
     */
    pay: (id, made = {}) => {
      const key = id ?? [...world.checkouts.keys()].at(-1) ?? '';
      const session = world.checkouts.get(key);
      assert.ok(session && session.status === 'open', 'an open session to pay');
      session.status = 'complete';
      const n = key.slice('cs_test_'.length);
      session.paymentIntent = made.paymentIntent !== undefined ? made.paymentIntent : session.mode === 'payment' ? `pi_test${n}` : null;
      session.subscription = made.subscription !== undefined ? made.subscription : session.mode === 'subscription' ? `sub_test${n}` : null;
    },
    now: () => world.clock,
    /**
     * @param {string} url
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    fetch: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : '';
      world.calls.push({ url, method, headers, body });
      if (url === 'https://www.googleapis.com/oauth2/v3/certs' && method === 'GET') {
        return Response.json({ keys: world.jwks }, { status: world.jwksStatus, headers: { 'cache-control': world.jwksCacheControl } });
      }
      if (url === 'https://oauth2.googleapis.com/token' && method === 'POST') return tokenEndpoint(headers, body, init.signal);
      if (url.startsWith('https://api.stripe.com/v1/')) {
        if (headers.get('authorization') !== `Bearer ${STRIPE_KEY}` && headers.get('authorization') !== `Bearer ${LIVE_KEY}`) {
          return Response.json({ error: { message: 'CANARY-stripe-auth' } }, { status: 401 });
        }
        return stripeEndpoint(url.slice('https://api.stripe.com/v1'.length), method, headers, body);
      }
      world.unexpected.push(`${method} ${url}`);
      throw new TypeError(`fetch to an address the fakes do not serve: ${url}`);
    },
    /** @param {string} prefix */
    callsTo: (prefix) => world.calls.filter((call) => call.url.startsWith(prefix)),
  };

  /**
   * @param {Headers} headers
   * @param {string} body
   * @param {AbortSignal | null | undefined} signal
   * @returns {Promise<Response>}
   */
  async function tokenEndpoint(headers, body, signal) {
    if (world.token === 'hang') {
      return new Promise((_resolve, reject) => {
        // AbortSignal.timeout's timer does not hold the event loop open; this one does,
        // until the kit gives up, as a real socket would.
        const pending = setTimeout(() => reject(new Error('the kit never gave up')), 30_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(pending);
          reject(signal.reason);
        });
      });
    }
    if (world.token === 'throw') throw new TypeError('CANARY-network-text');
    if (world.token === 'error') return Response.json({ error: 'invalid_grant', error_description: 'CANARY-upstream-text' }, { status: 400 });
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(body);
    const code = form.get('code') ?? '';
    const grant = world.codes.get(code);
    world.codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    const challenge = b64(createHash('sha256').update(verifier).digest());
    if (
      !grant ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('client_id') !== CLIENT_ID ||
      form.get('client_secret') !== CLIENT_SECRET ||
      form.get('redirect_uri') !== grant.redirectUri ||
      challenge !== grant.challenge
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    const profile = grant.profile;
    const claims = claimsFor(grant.nonce, world.clock, {
      sub: profile.sub ?? '1001',
      email: profile.email ?? 'ada@example.com',
      email_verified: profile.verified ?? true,
      ...profile.claims,
    });
    const key = profile.kid === KEY_B.kid ? KEY_B : KEY_A;
    const idToken = await signJwt({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...profile.header }, claims, key.privateKey);
    // A good token in a response that is not a success is still not a success.
    const status = world.token === 'error-with-token' ? 500 : 200;
    return Response.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer', expires_in: 3599 }, { status });
  }

  /**
   * Stripe making a Checkout Session from `body`: its answer, as kept under the request's key.
   * @param {string | null} customer
   * @param {string} body
   * @returns {{ status: number, body: Record<string, unknown> }}
   */
  function makeCheckout(customer, body) {
    if (world.checkout === 'error') return { status: 500, body: { error: { message: 'CANARY-checkout-text' } } };
    if (customer && world.deletedCustomers.has(customer)) {
      return { status: 400, body: { error: { type: 'invalid_request_error', code: 'resource_missing', param: 'customer', message: `CANARY-No such customer: '${customer}'` } } };
    }
    if (world.checkoutRefusal) return { status: world.checkoutRefusal.status, body: { error: world.checkoutRefusal.error } };
    const form = new URLSearchParams(body);
    world.sessions.push(form);
    world.sessionSeq += 1;
    const id = `cs_test_${world.sessionSeq}`;
    const url = `https://checkout.stripe.com/c/pay/${id}`;
    world.checkouts.set(id, { status: 'open', expires: Number(form.get('expires_at')) * 1000, url, mode: form.get('mode') ?? '', paymentIntent: null, subscription: null });
    return { status: 200, body: { id, object: 'checkout.session', url } };
  }

  /**
   * @param {string} path
   * @param {string} method
   * @param {Headers} headers
   * @param {string} body
   * @returns {Promise<Response>}
   */
  async function stripeEndpoint(path, method, headers, body) {
    if (method === 'GET' && path.startsWith('/prices/')) {
      if (world.pricesFail) return Response.json({ error: { message: 'CANARY-price-text' } }, { status: 500 });
      const price = world.prices.get(decodeURIComponent(path.slice('/prices/'.length)));
      return price ? Response.json(price) : Response.json({ error: { message: 'No such price' } }, { status: 404 });
    }
    // What Stripe answers a call naming a customer it does not know (deleted, or of the other mode).
    const customer = method === 'POST' ? new URLSearchParams(body).get('customer') : null;
    const noSuchCustomer = () =>
      Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', param: 'customer', message: `CANARY-No such customer: '${customer}'` } }, { status: 400 });
    if (method === 'POST' && path === '/checkout/sessions') {
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      const key = headers.get('idempotency-key') ?? '';
      assert.match(key, /^kit-checkout-[A-Za-z0-9_-]{43}$/);
      if (world.checkout === 'drop-once') {
        // Lost on the way: Stripe never saw it, and keeps nothing under its key.
        world.checkout = 'ok';
        throw new TypeError('connection reset');
      }
      const kept = world.idempotency.get(key);
      if (kept) {
        if (kept.form !== body) return Response.json({ error: { type: 'idempotency_error', message: 'CANARY-another request under this key' } }, { status: 400 });
        if (!kept.answer) return Response.json({ error: { type: 'idempotency_error', code: 'idempotency_key_in_use', message: 'CANARY-in use' } }, { status: 409 });
        world.replays += 1;
        return Response.json(kept.answer.body, { status: kept.answer.status });
      }
      /** @type {{ form: string, answer: { status: number, body: Record<string, unknown> } | null }} */
      const entry = { form: body, answer: null };
      world.idempotency.set(key, entry);
      if (world.making) await world.making();
      entry.answer = makeCheckout(customer, body);
      return Response.json(entry.answer.body, { status: entry.answer.status });
    }
    if (method === 'GET' && path.startsWith('/checkout/sessions/')) {
      if (world.sessionLookup !== 'ok') return Response.json({ error: { message: 'CANARY-lookup-text' } }, { status: world.sessionLookup });
      const id = decodeURIComponent(path.slice('/checkout/sessions/'.length));
      const session = world.checkouts.get(id);
      if (!session) return Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', param: 'id', message: 'No such checkout.session' } }, { status: 404 });
      const status = session.status === 'open' && world.clock >= session.expires ? 'expired' : session.status;
      return Response.json({
        id,
        object: 'checkout.session',
        mode: session.mode,
        status,
        payment_status: status === 'complete' ? 'paid' : 'unpaid',
        url: status === 'open' ? session.url : null,
        payment_intent: session.paymentIntent,
        subscription: session.subscription,
      });
    }
    if (method === 'POST' && path === '/billing_portal/sessions') {
      if (customer && world.deletedCustomers.has(customer)) return noSuchCustomer();
      world.portals.push(new URLSearchParams(body));
      return Response.json({ id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.com/p/session/test_1' });
    }
    world.unexpected.push(`${method} stripe ${path}`);
    return Response.json({ error: { message: 'unknown endpoint' } }, { status: 404 });
  }

  return world;
}

/** @typedef {ReturnType<typeof createWorld>} World */

/**
 * An app over a memory store and the fakes, with every log line kept.
 * @param {World} world
 * @param {{ env?: Record<string, string>, catalogue?: unknown, timeoutMs?: number, store?: import('./store.js').Store | null }} [options]
 */
function makeApp(world, options = {}) {
  /** @type {{ level: string, message: string }[]} */
  const logs = [];
  const store = options.store === undefined ? createMemoryStore({ now: world.now }) : options.store;
  const app = createApp({
    catalogue: 'catalogue' in options ? options.catalogue : CATALOGUE,
    env: options.env ?? ENV,
    store,
    fetch: world.fetch,
    now: world.now,
    log: (level, message) => logs.push({ level, message }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { app, logs, store: /** @type {ReturnType<typeof createMemoryStore>} */ (store) };
}

/**
 * A browser for one app: a cookie jar, and Origin on every non-GET unless told otherwise.
 * @param {{ handle: (request: Request) => Promise<Response> }} app
 * @param {string} [base]
 */
function browser(app, base = APP_URL) {
  /** @type {Map<string, string>} */
  const jar = new Map();
  /** @type {string[][]} */
  const setCookies = [];
  return {
    jar,
    setCookies,
    /**
     * @param {string} method
     * @param {string} path relative to the site, or absolute
     * @param {{ headers?: Record<string, string>, body?: RequestInit['body'], origin?: string | null }} [options]
     */
    async send(method, path, options = {}) {
      const headers = new Headers(options.headers);
      if (jar.size > 0 && !headers.has('cookie')) headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
      const origin = options.origin === undefined ? new URL(base).origin : options.origin;
      if (method !== 'GET' && origin !== null && !headers.has('origin')) headers.set('origin', origin);
      const response = await app.handle(new Request(new URL(path, base), { method, headers, body: options.body ?? null }));
      const cookies = response.headers.getSetCookie();
      setCookies.push(cookies);
      for (const cookie of cookies) {
        const [pair = ''] = cookie.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        if (/;\s*Max-Age=0(?:;|$)/.test(cookie)) jar.delete(name);
        else jar.set(name, pair.slice(eq + 1));
      }
      return response;
    },
    /**
     * @param {string} path
     * @param {unknown} value
     * @param {Record<string, string>} [headers]
     */
    postJson(path, value, headers = {}) {
      return this.send('POST', path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
    },
  };
}

/** @typedef {ReturnType<typeof browser>} Browser */

/**
 * Google's half of a sign-in: read the authorize URL, issue a code, send the browser back.
 * @param {World} world
 * @param {string} location
 * @param {Profile} [profile]
 * @returns {URL}
 */
function consent(world, location, profile = {}) {
  const url = new URL(location);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = url.searchParams;
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('scope'), 'openid email');
  assert.equal(params.get('code_challenge_method'), 'S256');
  world.codeSeq += 1;
  const code = `code${world.codeSeq}`;
  world.codes.set(code, {
    challenge: params.get('code_challenge') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    nonce: params.get('nonce') ?? '',
    profile,
  });
  const back = new URL(params.get('redirect_uri') ?? '');
  back.searchParams.set('code', code);
  back.searchParams.set('state', params.get('state') ?? '');
  return back;
}

/**
 * The whole sign-in, start to callback. Returns the callback's response.
 * @param {World} world
 * @param {Browser} client
 * @param {Profile & { returnTo?: string }} [profile]
 */
async function signIn(world, client, profile = {}) {
  const start = await client.send('GET', `api/auth/google/start?return=${encodeURIComponent(profile.returnTo ?? '/play')}`);
  assert.equal(start.status, 302);
  const back = consent(world, start.headers.get('location') ?? '', profile);
  return client.send('GET', back.href);
}

/**
 * A RequestInit whose body is a stream, which Node's fetch needs marked half-duplex.
 * @param {RequestInit} init
 * @returns {RequestInit}
 */
function streaming(init) {
  return /** @type {RequestInit} */ ({ ...init, duplex: 'half' });
}

/** @param {Response} response */
async function bodyOf(response) {
  return /** @type {any} */ (await response.json());
}

/**
 * @param {Browser} client
 * @returns {Promise<string[]>}
 */
async function entitlementsOf(client) {
  const response = await client.send('GET', 'api/me');
  return (await bodyOf(response)).entitlements;
}

/**
 * A cookie's attributes as a map (lowercased names), with its name and value.
 * @param {string} cookie
 */
function cookieParts(cookie) {
  const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  /** @type {Map<string, string>} */
  const attrs = new Map();
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    attrs.set((at < 0 ? attribute : attribute.slice(0, at)).toLowerCase(), at < 0 ? '' : attribute.slice(at + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/** The API headers as the charter states them, written out rather than read from the kit. */
const EXPECTED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** @param {Response} response */
function assertApiHeaders(response) {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) assert.equal(response.headers.get(name), value, `${response.status} carries ${name}`);
  assert.ok(response.headers.get('cache-control'), `${response.status} carries Cache-Control`);
  assert.equal(Object.keys(API_HEADERS).length, 5, 'the kit sends the five API headers');
  if (response.status === 204 || response.status === 302) assert.equal(response.headers.get('content-type'), null);
  else assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
}

// -- webhooks

let eventSeq = 0;
/**
 * @param {World} world
 * @param {string} type
 * @param {Record<string, unknown>} object
 * @param {{ livemode?: boolean, created?: number, id?: string }} [options]
 */
function stripeEvent(world, type, object, options = {}) {
  eventSeq += 1;
  return {
    id: options.id ?? `evt_selftest${eventSeq}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    type,
    livemode: options.livemode ?? false,
    created: options.created ?? Math.floor(world.clock / 1000),
    data: { object },
  };
}

/**
 * @param {string | Uint8Array} payload
 * @param {number} t seconds
 * @param {string} [secret]
 */
function v1(payload, t, secret = WEBHOOK_SECRET) {
  return createHmac('sha256', secret).update(`${t}.`).update(payload).digest('hex');
}

/**
 * @param {Browser} client
 * @param {World} world
 * @param {unknown} event an object, or the raw body as a string
 * @param {{ header?: string | null, t?: number, secret?: string }} [options]
 */
function postWebhook(client, world, event, options = {}) {
  const payload = typeof event === 'string' || event instanceof Uint8Array ? event : JSON.stringify(event);
  const t = options.t ?? Math.floor(world.clock / 1000);
  const header = options.header === undefined ? `t=${t},v1=${v1(payload, t, options.secret)}` : options.header;
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (header !== null) headers['stripe-signature'] = header;
  return client.send('POST', 'api/webhooks/stripe', { headers, body: typeof payload === 'string' ? payload : new Uint8Array(payload), origin: null });
}

/**
 * A completed Checkout Session as Stripe sends it back.
 * @param {{ user?: string, product?: string, mode?: 'payment' | 'subscription', pi?: string | null, sub?: string, customer?: string, status?: string, app?: string, reference?: string | null }} [options]
 */
function paidSession(options = {}) {
  const mode = options.mode ?? 'payment';
  const user = options.user ?? USER;
  return {
    id: 'cs_test_paid',
    object: 'checkout.session',
    mode,
    payment_status: options.status ?? 'paid',
    client_reference_id: options.reference === undefined ? user : options.reference,
    metadata: { app: options.app ?? 'demo', user, product: options.product ?? (mode === 'payment' ? 'pro' : 'monthly') },
    customer: options.customer ?? 'cus_test1',
    payment_intent: mode === 'payment' ? (options.pi === undefined ? 'pi_test1' : options.pi) : null,
    subscription: mode === 'subscription' ? (options.sub ?? 'sub_test1') : null,
    livemode: false,
  };
}

/**
 * @param {{ id?: string, status: string, user?: string, product?: string, app?: string, customer?: string }} options
 */
function subscriptionObject(options) {
  return {
    id: options.id ?? 'sub_test1',
    object: 'subscription',
    status: options.status,
    customer: options.customer ?? 'cus_test1',
    metadata: { app: options.app ?? 'demo', user: options.user ?? USER, product: options.product ?? 'monthly' },
  };
}

/**
 * What the kit logs when an event says a deleted account's subscription may charge again and
 * it is not taken as the visitor's renewal.
 * @param {string} id
 */
const MAY_CHARGE = (id) =>
  `kit (demo): subscription ${id} of a deleted account may charge again, and no event says it was renewed after the deletion: check it in the Stripe dashboard, and cancel or refund it if it will`;

/**
 * A signed-in browser that has bought `pro` (granted by a webhook).
 * @param {World} world
 * @param {{ handle: (request: Request) => Promise<Response> }} app
 */
async function owner(world, app) {
  const client = browser(app);
  await signIn(world, client);
  const granted = await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession()));
  assert.equal(granted.status, 200);
  assert.deepEqual(await entitlementsOf(client), ['pro']);
  return client;
}

/**
 * A store whose every call waits a turn of the event loop, as KV and the file system do, so
 * that requests made at once interleave their reads and writes.
 * @param {import('./store.js').Store} inner
 * @returns {import('./store.js').Store}
 */
function slowStore(inner) {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    get: async (key) => {
      await tick();
      return inner.get(key);
    },
    put: async (key, value, options) => {
      await tick();
      return inner.put(key, value, options);
    },
    delete: async (key) => {
      await tick();
      return inner.delete(key);
    },
  };
}

/**
 * A store that holds one call (`op` on `key`, once armed) until `until` resolves, so that a
 * deletion and a webhook can be interleaved exactly. `seen(op, key)` resolves when that call
 * has been made and has returned.
 * @param {import('./store.js').Store} inner
 */
function gatedStore(inner) {
  /** @type {{ op: string, key: string, until: Promise<unknown> } | null} */
  let gate = null;
  /** @type {{ op: string, key: string, done: () => void }[]} */
  const watches = [];
  /**
   * @param {string} op
   * @param {string} key
   */
  const passed = (op, key) => {
    for (const watch of watches.filter((w) => w.op === op && w.key === key)) {
      watches.splice(watches.indexOf(watch), 1);
      watch.done();
    }
  };
  /**
   * @param {string} op
   * @param {string} key
   */
  const wait = async (op, key) => {
    if (gate && gate.op === op && gate.key === key) {
      const until = gate.until;
      gate = null;
      await until;
    }
  };
  return {
    /** @type {import('./store.js').Store} */
    store: {
      get: async (key) => {
        await wait('get', key);
        const value = await inner.get(key);
        passed('get', key);
        return value;
      },
      put: async (key, value, options) => {
        await wait('put', key);
        await inner.put(key, value, options);
        passed('put', key);
      },
      delete: async (key) => {
        await wait('delete', key);
        await inner.delete(key);
        passed('delete', key);
      },
    },
    /**
     * @param {string} op
     * @param {string} key
     * @param {Promise<unknown>} until
     */
    hold: (op, key, until) => {
      gate = { op, key, until };
    },
    /**
     * @param {string} op
     * @param {string} key
     * @returns {Promise<void>}
     */
    seen: (op, key) => new Promise((done) => watches.push({ op, key, done })),
  };
}

/**
 * `work`, or a failure after five seconds: a test that waits on the kit fails rather than hangs.
 * @template T
 * @param {Promise<T>} work
 * @param {string} [stuckBecause]
 * @returns {Promise<T>}
 */
const within = (work, stuckBecause = 'the deletion and the webhook wait on each other') => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const stuck = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(stuckBecause)), 5000);
  });
  return /** @type {Promise<T>} */ (Promise.race([work, stuck]).finally(() => clearTimeout(timer)));
};

/**
 * Workers KV across locations, as Cloudflare documents it: a write is seen at once where it was
 * made; a location that read a key keeps serving that read for a minute whatever is written
 * elsewhere; the last write wins. Each `location()` is a KV binding for kvStore().
 * @param {() => number} now
 */
function geoKv(now) {
  /** @type {Map<string, string>} */
  const central = new Map();
  return {
    location() {
      /** @type {Map<string, { text: string | undefined, until: number }>} */
      const cache = new Map();
      return {
        /** @param {string} key */
        get: async (key) => {
          let hit = cache.get(key);
          if (!hit || hit.until <= now()) {
            hit = { text: central.get(key), until: now() + 60_000 };
            cache.set(key, hit);
          }
          return hit.text === undefined ? null : JSON.parse(hit.text);
        },
        /** @param {string} key @param {string} text */
        put: async (key, text) => {
          central.set(key, text);
          cache.set(key, { text, until: now() + 60_000 });
        },
        /** @param {string} key */
        delete: async (key) => {
          central.delete(key);
          cache.set(key, { text: undefined, until: now() + 60_000 });
        },
      };
    },
  };
}

/**
 * A KV namespace that, as KV does, refuses a second write (or delete) to one key within a
 * second, by the given clock.
 * @param {() => number} now
 */
function strictKv(now) {
  /** @type {Map<string, string>} */
  const data = new Map();
  /** @type {Map<string, number>} */
  const written = new Map();
  /** @param {string} key */
  const write = (key) => {
    const last = written.get(key);
    if (last !== undefined && now() - last < 1000) throw new Error('KV PUT failed: 429 Too Many Requests');
    written.set(key, now());
  };
  return {
    /** @param {string} key */
    get: async (key) => (data.has(key) ? JSON.parse(data.get(key) ?? 'null') : null),
    /** @param {string} key @param {string} value */
    put: async (key, value) => {
      write(key);
      data.set(key, value);
    },
    /** @param {string} key */
    delete: async (key) => {
      write(key);
      data.delete(key);
    },
  };
}

/**
 * A store that counts its reads.
 * @param {import('./store.js').Store} inner
 */
function countingStore(inner) {
  const counted = {
    gets: 0,
    /** @param {string} key */
    get: (key) => {
      counted.gets += 1;
      return inner.get(key);
    },
    /** @type {import('./store.js').Store['put']} */
    put: (key, value, options) => inner.put(key, value, options),
    /** @param {string} key */
    delete: (key) => inner.delete(key),
  };
  return counted;
}

/**
 * A full refund of `pi`, as Stripe sends it.
 * @param {string} pi
 */
function refund(pi) {
  return { object: 'charge', id: `ch_${pi}`, payment_intent: pi, refunded: true, amount: 499, amount_refunded: 499 };
}

// ===========================================================================================

describe('crypto', () => {
  test('base64url round-trips and refuses a second spelling', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      assert.deepEqual(fromBase64url(base64url(bytes)), bytes);
      assert.equal(base64url(bytes), Buffer.from(bytes).toString('base64url'));
    }
    assert.equal(fromBase64url('A'), null, 'impossible length');
    assert.equal(fromBase64url('AB=='), null, 'padding');
    assert.equal(fromBase64url('AB+/'), null, 'standard alphabet');
    assert.equal(fromBase64url('AB'), null, 'non-zero trailing bits');
    assert.deepEqual(fromBase64url('AA'), new Uint8Array([0]));
  });

  test('hex and constant-time comparison', async () => {
    assert.equal(hex(new Uint8Array([0, 15, 255])), '000fff');
    assert.deepEqual(fromHex('000fFF'), new Uint8Array([0, 15, 255]));
    assert.equal(fromHex('0'), null);
    assert.equal(fromHex('zz'), null);
    assert.equal(digestsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(digestsEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
    assert.equal(digestsEqual(new Uint8Array([1, 2]), new Uint8Array([1])), false);
    assert.equal(await safeEqual('state', 'state'), true);
    assert.equal(await safeEqual('state', 'statE'), false);
    assert.equal(await safeEqual('state', 'state-longer'), false);
  });
});

describe('http', () => {
  test('cookies: first of a name wins, values untouched', () => {
    const cookies = parseCookies('a=1; b=two=2; a=3; empty=; =x; junk');
    assert.equal(cookies.get('a'), '1');
    assert.equal(cookies.get('b'), 'two=2');
    assert.equal(cookies.get('empty'), '');
    assert.equal(cookies.size, 3);
    assert.equal(parseCookies('\t c =3').get('c'), '3', 'spaces and tabs around a name are trimmed');
  });

  test('cookies: a name is trimmed of spaces and tabs only, so no other space can make one look like __Host-', () => {
    // A browser keeps these characters as part of the name: "\u00a0__Host-demo-session" has no
    // __Host- prefix for it, so another subdomain may set it with any Path and have it sent first.
    for (const space of ['\u00a0', '\u2000', '\ufeff', '\u3000', '\u000b', '\u000c']) {
      const cookies = parseCookies(`${space}__Host-demo-session=ATTACKER; __Host-demo-session=VICTIM`);
      assert.equal(cookies.get('__Host-demo-session'), 'VICTIM', `U+${space.codePointAt(0)?.toString(16)}`);
      assert.equal(parseCookies(`__Host-demo-session${space}=X`).get('__Host-demo-session'), undefined);
    }
  });

  test('cookies: parsing is linear in the header, whatever its spaces, up to 256 KiB and through me', async () => {
    // The header is the client's. A regular expression with an alternation over it (the trim
    // was once /^[ \t]+|[ \t]+$/g) retried a branch at every space of a run it could not end:
    // 16 KiB took a quarter of a second, 64 KiB seconds, 256 KiB most of a minute. Each size is
    // held to a budget a linear parse meets a hundred times over, smallest first, so a
    // quadratic parse fails here in about a second instead of running for minutes.
    const BUDGET_MS = 50;
    /** @param {string} header */
    const fastest = (header) => {
      let best = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        parseCookies(header);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    for (const size of [16 * 1024, 64 * 1024, 256 * 1024]) {
      const run = ' '.repeat(size);
      const half = ' '.repeat(size / 2);
      /** @type {[string, string, string, string][]} shape, header, a name in it, its value */
      const shapes = [
        ['spaces inside a name', `x${run}y=1`, `x${run}y`, '1'],
        ['spaces and tabs inside a name', `x${' \t'.repeat(size / 2)}y=1`, `x${' \t'.repeat(size / 2)}y`, '1'],
        ['spaces around a name', `${half}x${half}=1`, 'x', '1'],
        ['spaces inside a value', `x=1${run}2`, 'x', `1${run}2`],
        ['a name of spaces only', `${run}=1; x=2`, 'x', '2'],
        ['many short pairs', 'a=1; '.repeat(size / 5), 'a', '1'],
      ];
      for (const [shape, header, name, value] of shapes) {
        assert.equal(parseCookies(header).get(name), value, shape);
        const ms = fastest(header);
        assert.ok(ms < BUDGET_MS, `${shape}, ${size / 1024} KiB: ${ms.toFixed(1)} ms`);
      }
    }
    // And the route that reads it, signed out and signed in, with a 256 KiB header.
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const mine = client.jar.get('__Host-demo-session') ?? '';
    const big = `x${' '.repeat(256 * 1024)}y=1`;
    /** @type {[string, { email: string } | null][]} */
    const cases = [[big, null], [`${big}; __Host-demo-session=${mine}`, { email: 'ada@example.com' }]];
    for (const [cookie, user] of cases) {
      const start = performance.now();
      const answer = await bodyOf(await client.send('GET', 'api/me', { headers: { cookie } }));
      const ms = performance.now() - start;
      assert.deepEqual(answer, { user, entitlements: [] });
      assert.ok(ms < 4 * BUDGET_MS, `me with a 256 KiB Cookie header: ${ms.toFixed(1)} ms`);
    }
  });

  test('a body whose stream fails is a 400, quietly: the client hung up', async () => {
    const failing = () =>
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('CANARY-hung-up'));
        },
      });
    await assert.rejects(readBytes(new Request('https://shop.example/x', streaming({ method: 'POST', body: failing() })), 1024), { status: 400 });
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const response = await app.handle(new Request('https://shop.example/api/webhooks/stripe', streaming({ method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: failing() })));
    assert.equal(response.status, 400);
    assertApiHeaders(response);
    assert.deepEqual(logs.filter((line) => line.level === 'error'), [], 'nothing in the error log');
  });

  test('the body cap holds without Content-Length and stops reading', async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024));
        if (pulled >= 1024 * 1024) controller.close();
      },
    });
    const request = new Request('https://shop.example/x', streaming({ method: 'POST', body: stream }));
    await assert.rejects(readBytes(request, 10_000), { status: 413 });
    assert.ok(pulled <= 12 * 1024, `stopped near the cap (pulled ${pulled})`);
  });

  test('the signature header and its check, directly', async () => {
    const payload = new TextEncoder().encode('{"id":"evt_1"}');
    const t = 1_700_000_000;
    const good = v1(payload, t);
    assert.deepEqual(parseSignatureHeader(`t=${t},v1=${good},v0=abc,v1=${'0'.repeat(64)}`)?.v1.length, 2);
    assert.equal(parseSignatureHeader(`t=${t}`), null);
    assert.equal(parseSignatureHeader(`t=1.5,v1=${good}`), null);
    assert.equal(parseSignatureHeader(null), null);
    const check = (/** @type {string} */ header, /** @type {number} */ at) => verifySignature({ secret: WEBHOOK_SECRET, header, payload, now: at * 1000 });
    assert.equal(await check(`t=${t},v1=${good}`, t), true);
    assert.equal(await check(`t=${t},v1=${good}`, t + 300), true);
    assert.equal(await check(`t=${t},v1=${good}`, t + 301), false);
    assert.equal(await check(`t=${t},v1=${good}`, t - 301), false);
    assert.equal(await check(`t=${t},v1=${good.replace(/^./, (c) => (c === '0' ? '1' : '0'))}`, t), false);
  });

  test('a webhook signature is one HMAC over the body, however many v1 values the header carries', async () => {
    // Nothing about a webhook is authenticated when its signature is checked, and the body may
    // be 512 KiB: eight v1 values (the most read) must not cost eight HMACs over it. Every call
    // Web Crypto gets to sign or verify bytes of the signed length is counted.
    const payload = new Uint8Array(512 * 1024).fill(0x61);
    const t = 1_700_000_000;
    const signedLength = `${t}.`.length + payload.length;
    const right = v1(payload, t);
    const wrong = Array.from({ length: 8 }, (_, index) => v1(payload, t, `${WEBHOOK_SECRET}${index}`));
    const subtle = crypto.subtle;
    let hmacs = 0;
    /**
     * @param {'sign' | 'verify'} method
     * @param {number} at the argument that holds the bytes
     */
    const count = (method, at) => {
      const original = Reflect.get(subtle, method);
      /** @param {unknown[]} args */
      const counted = (...args) => {
        const data = args[at];
        if (data instanceof Uint8Array && data.length === signedLength) hmacs += 1;
        return Reflect.apply(original, subtle, args);
      };
      Object.defineProperty(subtle, method, { configurable: true, writable: true, value: counted });
    };
    count('sign', 2);
    count('verify', 3);
    try {
      /** @param {string[]} values */
      const check = async (values) => {
        hmacs = 0;
        const valid = await verifySignature({ secret: WEBHOOK_SECRET, header: `t=${t},${values.map((value) => `v1=${value}`).join(',')}`, payload, now: t * 1000 });
        return { valid, hmacs };
      };
      assert.deepEqual(await check(wrong), { valid: false, hmacs: 1 }, 'eight wrong');
      assert.deepEqual(await check([...wrong.slice(0, 7), right]), { valid: true, hmacs: 1 }, 'the right one last');
      assert.deepEqual(await check([right, ...wrong.slice(0, 7)]), { valid: true, hmacs: 1 }, 'the right one first');
      assert.deepEqual(await check(wrong.slice(0, 1)), { valid: false, hmacs: 1 }, 'one wrong');
    } finally {
      Reflect.deleteProperty(subtle, 'sign');
      Reflect.deleteProperty(subtle, 'verify');
    }
    assert.equal(typeof crypto.subtle.sign, 'function', 'Web Crypto is itself again');
    assert.ok(!Object.prototype.hasOwnProperty.call(crypto.subtle, 'sign') && !Object.prototype.hasOwnProperty.call(crypto.subtle, 'verify'));
  });

  test('flattenParams writes Stripe bracket keys', () => {
    assert.deepEqual(flattenParams({ a: 'x', b: { c: 1, d: undefined }, e: [{ f: 'g' }], h: null }), [
      ['a', 'x'],
      ['b[c]', '1'],
      ['e[0][f]', 'g'],
    ]);
  });
});

describe('the catalogue', () => {
  test('a well-formed catalogue is accepted and frozen', () => {
    const checked = validateCatalogue(CATALOGUE);
    assert.equal(checked.products.length, 3);
    assert.ok(Object.isFrozen(checked) && Object.isFrozen(checked.products[0]));
    assert.equal(priceVariable('pack-furniture'), 'STRIPE_PRICE_PACK_FURNITURE');
  });

  test('a malformed catalogue throws at createApp', () => {
    const product = CATALOGUE.products[0];
    const bad = [
      null,
      { ...CATALOGUE, app: 'Demo' },
      { ...CATALOGUE, app: 'a'.repeat(33) },
      { ...CATALOGUE, app: '../x' },
      { ...CATALOGUE, name: '' },
      { ...CATALOGUE, products: 'pro' },
      { ...CATALOGUE, extra: true },
      { ...CATALOGUE, products: [{ ...product, id: 'Pro' }] },
      { ...CATALOGUE, products: [{ ...product, id: 'pro_x' }] },
      { ...CATALOGUE, products: [product, product] },
      { ...CATALOGUE, products: [{ ...product, mode: 'setup' }] },
      { ...CATALOGUE, products: [{ ...product, grants: '__proto__' }] },
      { ...CATALOGUE, products: [{ ...product, grant: 'pro' }] },
      { ...CATALOGUE, products: [{ ...product, name: 'a\u0000b' }] },
    ];
    const world = createWorld();
    for (const catalogue of bad) {
      assert.throws(() => makeApp(world, { catalogue }), TypeError, JSON.stringify(catalogue));
    }
  });

  test('createApp needs a fetch: there is no default way out', () => {
    assert.throws(() => createApp(/** @type {any} */ ({ catalogue: CATALOGUE, env: ENV, store: createMemoryStore() })), TypeError);
  });
});

describe('configuration', () => {
  test('nothing configured: config reports nothing, every other route is a 404, nothing is logged', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world, { env: {} });
    const client = browser(app);
    const config = await client.send('GET', 'api/config');
    assert.equal(config.status, 200);
    assert.deepEqual(await bodyOf(config), { auth: { google: false }, shop: { products: [] } });
    assert.equal(config.headers.get('cache-control'), 'public, max-age=60');
    for (const [method, path] of /** @type {const} */ ([['GET', 'api/me'], ['GET', 'api/auth/google/start'], ['POST', 'api/checkout'], ['POST', 'api/webhooks/stripe']])) {
      const response = await client.send(method, path);
      assert.equal(response.status, 404, `${method} ${path}`);
      assertApiHeaders(response);
    }
    assert.deepEqual(logs, []);
    assert.deepEqual(app.features, { signIn: false, shop: false });
    assert.equal(world.calls.length, 0);
  });

  test('fully configured: config lists the priced products with their prices', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const config = await bodyOf(await browser(app).send('GET', 'api/config'));
    assert.deepEqual(config, {
      auth: { google: true },
      shop: {
        products: [
          { id: 'pro', name: 'Pro', description: 'Everything unlocked', mode: 'payment', price: { unit_amount: 499, currency: 'eur' } },
          { id: 'monthly', name: 'Monthly', description: 'Support every month', mode: 'subscription', price: { unit_amount: 199, currency: 'eur', interval: 'month', interval_count: 1 } },
        ],
      },
    });
    // The one unpriced product is named, never sold.
    assert.equal(logs.length, 1);
    assert.match(logs[0]?.message ?? '', /not sold, no usable price: later/);
    assert.deepEqual(app.features, { signIn: true, shop: true });
  });

  test('each missing variable turns its feature off with one warning that names it and no value', async () => {
    const signInVariables = ['APP_URL', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
    const shopVariables = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
    const catalogue = { ...CATALOGUE, products: CATALOGUE.products.slice(0, 2) };
    for (const name of [...signInVariables, ...shopVariables]) {
      const world = createWorld();
      const env = { ...ENV };
      delete env[name];
      const { app, logs } = makeApp(world, { env, catalogue });
      const response = await browser(app).send('GET', 'api/config');
      assert.equal(response.status, 200, name);
      const config = await bodyOf(response);
      assert.equal(config.auth.google, !signInVariables.includes(name), `${name}: sign-in`);
      assert.deepEqual(config.shop.products, [], `${name}: shop off`);
      assert.equal(logs.length, 1, `${name}: one warning`);
      const message = logs[0]?.message ?? '';
      assert.match(message, new RegExp(`missing ${name}`), name);
      for (const value of Object.values(ENV)) assert.ok(!message.includes(value), `${name}: the warning holds no value`);
    }
    // No price for any product: the shop is off (never sell what cannot be granted).
    const world = createWorld();
    const env = { ...ENV };
    delete env.STRIPE_PRICE_PRO;
    delete env.STRIPE_PRICE_MONTHLY;
    const { app, logs } = makeApp(world, { env, catalogue });
    assert.deepEqual((await bodyOf(await browser(app).send('GET', 'api/config'))).shop.products, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0]?.message ?? '', /no product has a price/);
    assert.equal(app.features.shop, false);
  });

  test('malformed values count as missing', async () => {
    const cases = {
      APP_URL: ['https://shop.example', 'http://shop.example/', 'https://shop.example/?x=1', 'https://user:pw@shop.example/', 'https://SHOP.example/'],
      SESSION_SECRET: [base64url(new Uint8Array(31)), 'not base64url!'],
      GOOGLE_CLIENT_ID: ['client', '123.apps.googleusercontent.com.evil.example'],
      GOOGLE_CLIENT_SECRET: ['short', 'has space in it'],
      STRIPE_SECRET_KEY: ['sk_prod_0000000000000000', 'pk_test_0000000000000000'],
      STRIPE_WEBHOOK_SECRET: ['secret_0000000000'],
      STRIPE_PRICE_PRO: ['prod_123'],
    };
    for (const [name, values] of Object.entries(cases)) {
      for (const value of values) {
        const world = createWorld();
        const { app, logs } = makeApp(world, { env: { ...ENV, [name]: value } });
        const config = await bodyOf(await browser(app).send('GET', 'api/config'));
        const off = name === 'STRIPE_PRICE_PRO' ? !config.shop.products.some((/** @type {any} */ p) => p.id === 'pro') : config.shop.products.length === 0;
        assert.ok(off, `${name}=${value} turns its feature off`);
        assert.equal(logs.length, 1);
        assert.match(logs[0]?.message ?? '', new RegExp(`malformed ${name}`));
        assert.ok(!(logs[0]?.message ?? '').includes(value), 'the warning holds no value');
      }
    }
    // http is allowed for localhost only, where browsers keep Secure cookies.
    const local = makeApp(createWorld(), { env: { ...ENV, APP_URL: 'http://localhost:8788/' } });
    assert.equal(local.app.features.signIn, true);
  });

  test('without a store everything is off, and the warning says so', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world, { store: null });
    assert.deepEqual(app.features, { signIn: false, shop: false });
    assert.deepEqual(await bodyOf(await browser(app).send('GET', 'api/config')), { auth: { google: false }, shop: { products: [] } });
    // A host that mounts createApp itself runs under Node, where the store is a directory.
    assert.equal(logs[0]?.message, 'kit (demo): sign-in is off (no store (KIT_STORE on Cloudflare, KIT_DATA_DIR under Node)); the shop is off (sign-in is off)');
  });

  test('a price is cached for an hour; a failed lookup lists the product without one', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const client = browser(app);
    await client.send('GET', 'api/config');
    await client.send('GET', 'api/config');
    assert.equal(world.callsTo('https://api.stripe.com/v1/prices/').length, 2, 'one lookup per product');
    world.clock += 59 * 60_000;
    await client.send('GET', 'api/config');
    assert.equal(world.callsTo('https://api.stripe.com/v1/prices/').length, 2, 'still cached');
    world.clock += 2 * 60_000;
    world.pricesFail = true;
    const failed = await bodyOf(await client.send('GET', 'api/config'));
    assert.deepEqual(failed.shop.products.map((/** @type {any} */ p) => [p.id, 'price' in p]), [['pro', false], ['monthly', false]]);
    assert.ok(logs.some((line) => /price lookup for pro failed \(Stripe 500\)/.test(line.message)));
    assert.ok(!logs.some((line) => line.message.includes('CANARY')), 'no upstream text is logged');
    world.pricesFail = false;
    world.clock += 61_000;
    const back = await bodyOf(await client.send('GET', 'api/config'));
    assert.ok(back.shop.products.every((/** @type {any} */ p) => 'price' in p), 'retried after a minute');
  });

  test('config does not wait on a slow price: it answers within priceWaitMs without it, uncached, and the price follows', async () => {
    // DD-INT-4: a cold process whose price lookup took 7 s answered config after 7 s, past the
    // pages' 5 s first-frame limit, so the page drew the free build for the whole visit.
    const world = createWorld();
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    /** @type {Promise<unknown>[]} */
    const waited = [];
    const app = createApp({
      catalogue: CATALOGUE,
      env: ENV,
      store: createMemoryStore({ now: world.now }),
      fetch: async (url, init) => {
        if (url.endsWith('/prices/price_pro123')) await held;
        return world.fetch(url, init);
      },
      now: world.now,
      log: () => {},
      priceWaitMs: 50,
    });
    const request = () => new Request(`${APP_URL}api/config`);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 2000);
    });
    const first = /** @type {Response | null} */ (await Promise.race([app.handle(request(), { waitUntil: (promise) => waited.push(promise) }), late]));
    clearTimeout(timer);
    try {
      assert.ok(first, 'answered while the price lookup was still under way');
      assert.deepEqual((await bodyOf(first)).shop.products.map((/** @type {any} */ p) => [p.id, p.price?.unit_amount ?? null]), [['pro', null], ['monthly', 199]]);
      assert.equal(first.headers.get('cache-control'), 'no-store', 'an answer without a price is not kept');
      assert.equal(waited.length, 1, "the lookup is handed to the host's waitUntil");
    } finally {
      release();
    }
    await Promise.all(waited);
    const second = await app.handle(request());
    assert.deepEqual((await bodyOf(second)).shop.products.map((/** @type {any} */ p) => [p.id, p.price?.unit_amount ?? null]), [['pro', 499], ['monthly', 199]]);
    assert.equal(second.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(world.callsTo('https://api.stripe.com/v1/prices/price_pro123').length, 1, 'the one lookup filled it in');
  });

  test('a price lookup that never settles does not hold the next one: past its time limit a new one starts', async () => {
    // A Function's work can be cut off once its answer has gone; a lookup it held then never
    // settles, and every later config would have waited on it and gone without the price.
    const world = createWorld();
    let hang = true;
    const app = createApp({
      catalogue: CATALOGUE,
      env: ENV,
      store: createMemoryStore({ now: world.now }),
      fetch: async (url, init) => {
        if (hang && url.endsWith('/prices/price_pro123')) return new Promise(() => {});
        return world.fetch(url, init);
      },
      now: world.now,
      log: () => {},
      priceWaitMs: 20,
    });
    const priced = async () => (await bodyOf(await within(app.handle(new Request(`${APP_URL}api/config`)), 'config waits on the lookup'))).shop.products.find((/** @type {any} */ p) => p.id === 'pro')?.price ?? null;
    // The kit's wait is an AbortSignal's timer, which does not hold the event loop open; a
    // server's socket does, and so does this, here.
    const open = setInterval(() => {}, 1000);
    try {
      assert.equal(await priced(), null);
      hang = false;
      world.clock += 5_000;
      assert.equal(await priced(), null, 'within its time limit the lookup under way is still the one');
      world.clock += 5_001;
      assert.deepEqual(await priced(), { unit_amount: 499, currency: 'eur' });
    } finally {
      clearInterval(open);
    }
  });

  test('a price Stripe answers with that is not usable is neither listed nor sold', async () => {
    const world = createWorld();
    world.prices.set('price_pro123', { active: true, currency: 'eur', unit_amount: 499, recurring: { interval: 'month', interval_count: 1 } });
    world.prices.set('price_monthly123', { active: false, currency: 'eur', unit_amount: 199, recurring: { interval: 'month', interval_count: 1 } });
    const { app, logs } = makeApp(world);
    const client = browser(app);
    const config = await bodyOf(await client.send('GET', 'api/config'));
    assert.deepEqual(config.shop.products, []);
    assert.ok(logs.some((line) => /pro is not sold: its price is not usable/.test(line.message)));
    // Pay what you want: Stripe would let the visitor choose the amount.
    world.prices.set('price_pro123', { active: true, currency: 'eur', unit_amount: null, custom_unit_amount: { minimum: 50 }, recurring: null });
    const fresh = makeApp(world);
    const buyer = browser(fresh.app);
    await signIn(world, buyer);
    assert.equal((await buyer.postJson('api/checkout', { product: 'pro' })).status, 404);
    assert.equal((await buyer.postJson('api/checkout', { product: 'monthly' })).status, 404);
    assert.equal(world.sessions.length, 0, 'no Checkout Session for a price the kit judged unusable');
    // A lookup that fails says nothing about the price: the product is listed without one and sold.
    const down = createWorld();
    down.pricesFail = true;
    const shaky = makeApp(down);
    const visitor = browser(shaky.app);
    assert.deepEqual((await bodyOf(await visitor.send('GET', 'api/config'))).shop.products.map((/** @type {any} */ p) => [p.id, 'price' in p]), [['pro', false], ['monthly', false]]);
    await signIn(down, visitor);
    assert.equal((await visitor.postJson('api/checkout', { product: 'pro' })).status, 200);
  });
});

describe('routes and headers', () => {
  test('unknown paths are JSON 404s, other methods 405 with Allow, and every response carries the API headers', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    const unknown = await client.send('GET', 'api/nothing');
    assert.equal(unknown.status, 404);
    assert.deepEqual(await bodyOf(unknown), { error: 'not_found' });
    assertApiHeaders(unknown);
    const outside = await client.send('GET', 'index.html');
    assert.equal(outside.status, 404);
    const wrong = await client.send('GET', 'api/checkout');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    assertApiHeaders(wrong);
    const put = await client.send('PUT', 'api/me');
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, DELETE');
    const head = await client.send('HEAD', 'api/config');
    assert.equal(head.status, 405);
    const me = await client.send('GET', 'api/me');
    assert.equal(me.headers.get('cache-control'), 'no-store');
    assertApiHeaders(me);
    assertApiHeaders(await client.send('GET', 'api/config'));
    assertApiHeaders(await client.send('GET', 'api/auth/google/start'));
    assertApiHeaders(await client.send('POST', 'api/auth/logout'));
    assertApiHeaders(await client.postJson('api/checkout', { product: 'pro' }));
  });

  test('a store that fails is a 500 with the API headers and no detail', async () => {
    const world = createWorld();
    const broken = createMemoryStore({ now: world.now });
    const { app, logs } = makeApp(world, { store: { ...broken, get: async () => { throw new Error('CANARY-store-text'); } } });
    const client = browser(app);
    client.jar.set('__Host-demo-session', base64url(new Uint8Array(32)));
    const response = await client.send('GET', 'api/me');
    assert.equal(response.status, 500);
    assert.deepEqual(await bodyOf(response), { error: 'internal' });
    assertApiHeaders(response);
    assert.ok(!logs.some((line) => line.message.includes('CANARY')));
  });
});

describe('sign-in', () => {
  test('the whole flow: authorize URL, cookies, callback, a session, me', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    const start = await client.send('GET', 'api/auth/google/start?return=%2Fplay%3Flevel%3D2');
    assert.equal(start.status, 302);
    assertApiHeaders(start);
    const location = new URL(start.headers.get('location') ?? '');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://shop.example/api/auth/google/callback');
    assert.match(location.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(location.searchParams.get('nonce') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.match(location.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([...location.searchParams.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'nonce', 'redirect_uri', 'response_type', 'scope', 'state']);
    const [oauth] = start.headers.getSetCookie();
    const parts = cookieParts(oauth ?? '');
    assert.equal(parts.name, '__Host-demo-oauth');
    assert.equal(parts.attrs.get('max-age'), '600');
    assert.equal(parts.attrs.get('path'), '/');
    assert.equal(parts.attrs.get('samesite'), 'Lax');
    assert.ok(parts.attrs.has('httponly') && parts.attrs.has('secure'));
    assert.ok(!parts.attrs.has('domain'));
    assert.ok(!(oauth ?? '').includes(location.searchParams.get('code_challenge') ?? '-'), 'the cookie holds the verifier, not the challenge');

    const back = consent(world, location.href);
    const done = await client.send('GET', back.href);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), 'https://shop.example/play?level=2');
    const cookies = done.headers.getSetCookie().map(cookieParts);
    const session = cookies.find((c) => c.name === '__Host-demo-session');
    assert.ok(session);
    assert.match(session.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.attrs.get('max-age'), String(30 * 86_400));
    assert.equal(session.attrs.get('path'), '/');
    assert.equal(session.attrs.get('samesite'), 'Lax');
    assert.ok(session.attrs.has('httponly') && session.attrs.has('secure') && !session.attrs.has('domain'));
    assert.equal(cookies.find((c) => c.name === '__Host-demo-oauth')?.attrs.get('max-age'), '0', 'the oauth cookie is cleared');

    const me = await client.send('GET', 'api/me');
    assert.deepEqual(await bodyOf(me), { user: { email: 'ada@example.com' }, entitlements: [] });
    // The store holds the SHA-256 of the session's bytes, never the cookie.
    const hash = createHash('sha256').update(Buffer.from(session.value, 'base64url')).digest('hex');
    assert.deepEqual(await store.get(`demo:session:${hash}`), { user: USER, email: 'ada@example.com', expires: T0 + 30 * 86_400_000 });
    // Signing in writes the session and the user's session index, and nothing a purchase lives in.
    assert.deepEqual(store.keys().sort(), [`demo:session:${hash}`, `demo:sessions:${USER}`]);
    assert.deepEqual(await store.get(`demo:sessions:${USER}`), { [hash]: T0 + 30 * 86_400_000 });
    for (const key of store.keys()) {
      assert.ok(!key.includes(session.value));
      assert.ok(!JSON.stringify(await store.get(key)).includes(session.value));
      if (key !== `demo:session:${hash}`) assert.ok(!JSON.stringify(await store.get(key)).includes('ada@example.com'), 'the email lives in the session record only');
    }
    assert.deepEqual(world.unexpected, []);
  });

  test('absolute URLs come from APP_URL, never Host or X-Forwarded-*', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const response = await app.handle(
      new Request('http://10.0.0.5:8788/api/auth/google/start?return=/x', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } }),
    );
    const location = new URL(response.headers.get('location') ?? '');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://shop.example/api/auth/google/callback');
    const client = browser(app, 'http://10.0.0.5:8788/');
    client.jar.set('__Host-demo-oauth', cookieParts(response.headers.getSetCookie()[0] ?? '').value);
    const back = consent(world, location.href);
    const done = await client.send('GET', `/api/auth/google/callback${back.search}`, { headers: { host: 'evil.example' } });
    assert.equal(done.headers.get('location'), 'https://shop.example/x');
  });

  test('a new session at every sign-in; the old one ends', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const first = client.jar.get('__Host-demo-session');
    await signIn(world, client);
    const second = client.jar.get('__Host-demo-session');
    assert.ok(first && second && first !== second);
    const stale = browser(app);
    stale.jar.set('__Host-demo-session', first);
    assert.deepEqual(await bodyOf(await stale.send('GET', 'api/me')), { user: null, entitlements: [] });
    // A session id planted before sign-in is never adopted.
    const planted = browser(app);
    const fixed = base64url(new Uint8Array(32).fill(1));
    planted.jar.set('__Host-demo-session', fixed);
    await signIn(world, planted);
    assert.notEqual(planted.jar.get('__Host-demo-session'), fixed);
  });

  test('the email is kept only when Google says it is verified; the user is the sub', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client, { sub: '2002', email: 'bob@example.com', verified: false });
    assert.deepEqual(await bodyOf(await client.send('GET', 'api/me')), { user: {}, entitlements: [] });
    assert.ok(store.keys().includes('demo:sessions:google:2002'));
    for (const key of store.keys()) assert.ok(!JSON.stringify(await store.get(key)).includes('bob@example.com'));
  });

  test('state mismatch, a missing or altered cookie, an error from Google and an expired cookie all fail closed', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);

    /**
     * @param {(client: Browser, back: URL) => Promise<Response>} finish
     * @returns {Promise<Response>}
     */
    const attempt = async (finish) => {
      const client = browser(app);
      const start = await client.send('GET', 'api/auth/google/start?return=/play');
      const back = consent(world, start.headers.get('location') ?? '');
      const response = await finish(client, back);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://shop.example/?signin=failed');
      assert.ok(response.headers.getSetCookie().some((c) => /^__Host-demo-oauth=; Max-Age=0/.test(c)), 'the oauth cookie is cleared');
      assert.ok(!client.jar.has('__Host-demo-session'), 'no session');
      return response;
    };

    await attempt((client, back) => {
      back.searchParams.set('state', 'x'.repeat(43));
      return client.send('GET', back.href);
    });
    await attempt((client, back) => {
      back.searchParams.delete('state');
      return client.send('GET', back.href);
    });
    await attempt((client, back) => {
      client.jar.delete('__Host-demo-oauth');
      return client.send('GET', back.href);
    });
    await attempt((client, back) => {
      // Re-sign nothing: change the return path inside the cookie.
      const value = client.jar.get('__Host-demo-oauth') ?? '';
      const [payload = '', mac = ''] = value.split('.');
      const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      flow.r = '/elsewhere';
      client.jar.set('__Host-demo-oauth', `${Buffer.from(JSON.stringify(flow)).toString('base64url')}.${mac}`);
      return client.send('GET', back.href);
    });
    await attempt((client, back) => {
      back.searchParams.set('error', 'access_denied');
      return client.send('GET', back.href);
    });
    await attempt((client, back) => {
      world.clock += 601_000;
      return client.send('GET', back.href);
    });
    assert.ok(!world.calls.some((call) => call.url === 'https://oauth2.googleapis.com/token'), 'no code was exchanged');
    assert.ok(logs.some((line) => line.message.includes('sign-in failed (state)')));
  });

  test('a token endpoint that fails, throws or hangs: signin=failed, and no upstream text is logged', async () => {
    for (const behaviour of /** @type {const} */ (['error', 'throw', 'hang'])) {
      const world = createWorld();
      world.token = behaviour;
      const { app, logs } = makeApp(world, { timeoutMs: 50 });
      const client = browser(app);
      const done = await signIn(world, client);
      assert.equal(done.headers.get('location'), 'https://shop.example/?signin=failed', behaviour);
      assert.ok(logs.some((line) => line.message.includes('sign-in failed (token)')), behaviour);
      assert.ok(!logs.some((line) => line.message.includes('CANARY')), `${behaviour}: nothing from upstream is logged`);
    }
  });

  test('a token Google signed with the wrong nonce, audience or issuer is refused', async () => {
    for (const [claims, reason] of /** @type {const} */ ([
      [{ nonce: 'someone-elses-nonce' }, 'nonce'],
      [{ aud: 'other.apps.googleusercontent.com' }, 'aud'],
      [{ iss: 'https://evil.example' }, 'iss'],
    ])) {
      const world = createWorld();
      const { app, logs } = makeApp(world);
      const client = browser(app);
      const done = await signIn(world, client, { claims });
      assert.equal(done.headers.get('location'), 'https://shop.example/?signin=failed');
      assert.ok(logs.some((line) => line.message.includes(`sign-in failed (${reason})`)), reason);
    }
  });

  test('return paths that leave the site become the root', () => {
    const site = new URL(APP_URL);
    const hostile = [
      '//evil.example',
      '//evil.example/path',
      '/\\evil.example',
      '\\\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '%2F%2Fevil.example',
      '/%2F%2Fevil.example',
      '/%5Cevil.example',
      '/%5cevil',
      '/\tevil',
      '/\t/evil.example',
      '/\n/evil.example',
      '/x\u0000y',
      '/x\u007fy',
      '/%0a/evil',
      '/%E0%A4%A',
      '/api/auth/logout',
      '/api/me',
      '',
      'play',
      `/${'a'.repeat(1100)}`,
      // Short enough as given, over the limit once the URL parser has percent-encoded it.
      `/${'\u00e9'.repeat(1000)}`,
      `/${'\u{1F600}'.repeat(500)}`,
      `/a?${'\u00e9'.repeat(400)}`,
      // Plain paths whose resolved form is another host (notenote's three), or decodes to one.
      '/.//evil.example',
      '/x/..//evil.example',
      '/%2e//evil.example',
      '/./%2Fevil.example',
      '/./%5Cevil.example',
      '/%252F/evil.example',
      '/%252e%252e//evil.example',
      '/a/%2e%2e/%2Fevil.example',
      // Still decoding to something new after three decodings (a fourth makes '/aA').
      '/a%25252541',
      // The charter's rule on the input itself: not a plain path once decoded is the root,
      // even where a dot segment would take the offending part away ('/play' otherwise).
      '/%2F/../play',
      '/x%5C/../play',
      '/x%09/../play',
    ];
    for (const value of hostile) assert.equal(safeReturnPath(value, site), '/', JSON.stringify(value));
    assert.equal(safeReturnPath(null, site), '/');
    assert.equal(safeReturnPath('/play?x=1#top', site), '/play?x=1#top');
    assert.equal(safeReturnPath('/a/../b', site), '/b');
    assert.equal(safeReturnPath(`/${'a'.repeat(1023)}`, site), `/${'a'.repeat(1023)}`, 'the longest path kept');
    assert.equal(safeReturnPath(`/${'\u00e9'.repeat(170)}`, site), `/${'%C3%A9'.repeat(170)}`);
    const sub = new URL('https://example.com/chess/');
    assert.equal(safeReturnPath('/chess/game', sub), '/chess/game');
    assert.equal(safeReturnPath('/other', sub), '/chess/');
    assert.equal(safeReturnPath('/chess/../admin', sub), '/chess/');
    assert.equal(safeReturnPath('/chess/api/me', sub), '/chess/');
    // What stays: a literal percent, an encoded character, a double slash further on.
    assert.equal(safeReturnPath('/x?q=100%25', site), '/x?q=100%25');
    assert.equal(safeReturnPath('/%C3%A9t%C3%A9', site), '/%C3%A9t%C3%A9');
    assert.equal(safeReturnPath('/a//b', site), '/a//b');
    assert.equal(safeReturnPath('/a%252541', site), '/a%252541', 'three decodings to a fixed point');
  });

  test('no return path is read as another host, by a browser or a server, at any percent-decoding (generated inputs)', () => {
    // Property: whatever the input, the result is the site's root or a path under it outside
    // api/, and the result and every string percent-decoding it again and again makes (as the
    // most forgiving decoder reads it, byte by byte) starts with exactly one '/' and no '\',
    // holds no control character, is a path on the page's own host when a browser resolves it
    // against any page, and does not resolve to a path that starts with '//'. Written apart
    // from the kit's own check, and run over inputs built from the pieces that make hosts:
    // slashes, backslashes, dot segments and their encodings, nested encodings, tabs.
    const pieces = ['/', '//', '\\', '.', '..', '/./', '/../', '%2e', '%2E', '%2f', '%2F', '%5c', '%5C', '%25', '%252f', '%252F', '%255c', '%252e', '%25252f', '%09', '%0a', '\t', '\n', '?', '#', '@', ':', 'https:', 'evil.example', 'a', 'api', 'chess', '%', '%E0', '%C3%A9', '\u00e9', ' ', '%20'];
    let seed = 0x5eed;
    const next = () => {
      // mulberry32: a fixed sequence, so a failure names an input that fails again.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** @param {string} text */
    const decodeOnce = (text) => text.replace(/%([0-9A-Fa-f]{2})/g, (_m, byte) => String.fromCharCode(parseInt(byte, 16)));
    /** @param {string} text */
    const stages = (text) => {
      const out = [text];
      for (let at = text, again = decodeOnce(at); again !== at; at = again, again = decodeOnce(at)) out.push(again);
      return out;
    };
    for (const base of ['https://shop.example/', 'https://example.com/chess/']) {
      const site = new URL(base);
      let kept = 0;
      for (let i = 0; i < 20_000; i += 1) {
        const count = 1 + Math.floor(next() * 8);
        let input = next() < 0.8 ? '/' : '';
        if (next() < 0.5 && base.endsWith('/chess/')) input += 'chess/';
        for (let j = 0; j < count; j += 1) input += pieces[Math.floor(next() * pieces.length)];
        const result = safeReturnPath(input, site);
        const where = `${JSON.stringify(input)} -> ${JSON.stringify(result)}`;
        if (result !== site.pathname) {
          kept += 1;
          assert.ok(result.startsWith(site.pathname) && !result.startsWith(`${site.pathname}api/`), where);
        }
        assert.equal(new URL(`${site.origin}${result}`).origin, site.origin, where);
        for (const stage of stages(result)) {
          assert.ok(stage.startsWith('/') && stage[1] !== '/' && stage[1] !== '\\', `${where}: ${JSON.stringify(stage)} starts with one /`);
          assert.ok(![...stage].some((c) => c < ' ' || c === '\u007f' || c === '\\'), `${where}: ${JSON.stringify(stage)} holds no control character or backslash`);
          for (const page of ['https://page.invalid/', 'https://page.invalid/deep/er/path?q#f']) {
            const read = new URL(stage, page);
            assert.equal(read.host, 'page.invalid', `${where}: ${JSON.stringify(stage)} read on ${page}`);
            assert.ok(!read.pathname.startsWith('//'), `${where}: ${JSON.stringify(stage)} resolves to ${read.pathname}`);
          }
        }
      }
      assert.ok(kept > 2_000, `${base}: the generator reaches paths that are kept (${kept})`);
    }
  });

  test('a hostile return path through the flow lands on the root', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    for (const returnTo of ['//evil.example', '/\\evil.example', 'https://evil.example', '/%5Cevil']) {
      const done = await signIn(world, browser(app), { returnTo });
      assert.equal(done.headers.get('location'), 'https://shop.example/', returnTo);
    }
  });

  test('a site under a sub-path routes and returns under it', async () => {
    const world = createWorld();
    const { app } = makeApp(world, { env: { ...ENV, APP_URL: 'https://example.com/chess/' } });
    const client = browser(app, 'https://example.com/chess/');
    assert.equal((await client.send('GET', '/api/config')).status, 404, 'not at the root');
    assert.equal((await client.send('GET', 'api/config')).status, 200);
    const start = await client.send('GET', 'api/auth/google/start?return=/elsewhere');
    const location = new URL(start.headers.get('location') ?? '');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://example.com/chess/api/auth/google/callback');
    const back = consent(world, location.href);
    const done = await client.send('GET', back.href);
    assert.equal(done.headers.get('location'), 'https://example.com/chess/');
  });

  test('the oauth cookie stays under the 4096 bytes a browser keeps, whatever the return path', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    /** @type {[string, string][]} */
    const cases = [
      [`/${'a'.repeat(1023)}`, `https://shop.example/${'a'.repeat(1023)}`],
      [`/${'\u00e9'.repeat(1000)}`, 'https://shop.example/'],
      [`/${'\u{1F600}'.repeat(500)}`, 'https://shop.example/'],
    ];
    for (const [returnTo, lands] of cases) {
      const client = browser(app);
      const start = await client.send('GET', `api/auth/google/start?return=${encodeURIComponent(returnTo)}`);
      const [cookie = ''] = start.headers.getSetCookie();
      assert.ok((cookie.split(';')[0] ?? '').length < 4096, `${returnTo.slice(0, 8)}…: ${cookie.length} bytes`);
      const back = consent(world, start.headers.get('location') ?? '');
      assert.equal((await client.send('GET', back.href)).headers.get('location'), lands);
    }
  });

  test('a cookie that only trims to the session or oauth cookie\'s name is neither', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const victim = browser(app);
    await signIn(world, victim);
    const attacker = browser(app);
    await signIn(world, attacker, { sub: '6666', email: 'mallory@example.com' });
    const mine = victim.jar.get('__Host-demo-session') ?? '';
    const theirs = attacker.jar.get('__Host-demo-session') ?? '';
    for (const space of ['\u00a0', '\u000b']) {
      const tossed = `${space}__Host-demo-session=${theirs}; __Host-demo-session=${mine}`;
      assert.deepEqual(await bodyOf(await victim.send('GET', 'api/me', { headers: { cookie: tossed } })), { user: { email: 'ada@example.com' }, entitlements: [] });
      assert.equal((await victim.postJson('api/checkout', { product: 'pro' }, { cookie: tossed })).status, 200);
      assert.equal(world.sessions.at(-1)?.get('metadata[user]'), USER, 'the purchase is the victim\'s own');
    }
    // A sign-in the attacker started, carried in under a look-alike name, is not completed.
    const start = await attacker.send('GET', 'api/auth/google/start?return=/');
    const sealed = attacker.jar.get('__Host-demo-oauth') ?? '';
    const back = consent(world, start.headers.get('location') ?? '', { sub: '6666' });
    const done = await victim.send('GET', back.href, { headers: { cookie: `\u00a0__Host-demo-oauth=${sealed}; __Host-demo-session=${mine}` } });
    assert.equal(done.headers.get('location'), 'https://shop.example/?signin=failed');
    assert.ok(!done.headers.getSetCookie().some((c) => c.startsWith('__Host-demo-session=')), 'no session minted');
    assert.deepEqual((await bodyOf(await victim.send('GET', 'api/me'))).user, { email: 'ada@example.com' }, 'the victim is still themselves');
  });

  test('a purchase record counts only for the user it names', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    // An index that lists records it should not (a restored backup, a hand edit): another user's
    // purchase, a record with no owner, and one granting something that is not an id.
    await store.put(`demo:test:user:${USER}`, { refs: ['payment:pi_other', 'payment:pi_orphan', 'payment:pi_odd', 'subscription:sub_odd', 'nonsense:x'] });
    await store.put('demo:test:payment:pi_other', { user: 'google:2002', product: 'pro', grants: 'pro' });
    await store.put('demo:test:payment:pi_orphan', { product: 'pro', grants: 'pro' });
    await store.put('demo:test:payment:pi_odd', { user: USER, product: 'pro', grants: '__proto__' });
    await store.put('demo:test:subscription:sub_odd', { user: USER, product: 'monthly', grants: 'supporter', status: 'Active' });
    assert.deepEqual(await entitlementsOf(client), []);
  });

  test('a stored session that is not of the kit\'s shape signs no one in; a cookie that cannot be a token costs no read', async () => {
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    const store = countingStore(inner);
    const { app } = makeApp(world, { store });
    const token = new Uint8Array(32).fill(3);
    const hash = createHash('sha256').update(token).digest('hex');
    for (const user of ['github:1001', 'google:../1001', 'google:', 7]) {
      await inner.put(`demo:session:${hash}`, { user, expires: T0 + 86_400_000 });
      const client = browser(app);
      client.jar.set('__Host-demo-session', base64url(token));
      assert.deepEqual(await bodyOf(await client.send('GET', 'api/me')), { user: null, entitlements: [] }, String(user));
    }
    for (const value of [base64url(new Uint8Array(31)), base64url(new Uint8Array(33)), 'not-base64url!', '']) {
      const client = browser(app);
      client.jar.set('__Host-demo-session', value);
      store.gets = 0;
      const me = await client.send('GET', 'api/me');
      assert.deepEqual(await bodyOf(me), { user: null, entitlements: [] });
      assert.equal(store.gets, 0, `${value.length} characters: no store read`);
      // A cookie that names no session is cleared, so the page stops sending it.
      assert.ok(me.headers.getSetCookie().some((c) => /^__Host-demo-session=; Max-Age=0/.test(c)), 'the dead cookie is cleared');
    }
    const anonymous = await browser(app).send('GET', 'api/me');
    assert.deepEqual(anonymous.headers.getSetCookie(), [], 'no cookie, nothing to clear');
  });

  test('at most twenty sessions per user: the oldest ends', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    /** @type {Browser[]} */
    const devices = [];
    for (let i = 0; i < 21; i += 1) {
      const device = browser(app);
      await signIn(world, device);
      devices.push(device);
      world.clock += 1000;
    }
    assert.equal(Object.keys(/** @type {any} */ (await store.get(`demo:sessions:${USER}`))).length, 20);
    assert.equal((await bodyOf(await devices[0]?.send('GET', 'api/me') ?? Response.json({}))).user, null, 'the first device was signed out');
    assert.equal(store.keys().filter((key) => key.startsWith('demo:session:')).length, 20, 'its session record is gone');
    for (const device of devices.slice(1)) assert.deepEqual((await bodyOf(await device.send('GET', 'api/me'))).user, { email: 'ada@example.com' });
  });

  test('a code over 4096 characters is refused before Google is asked', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const client = browser(app);
    const start = await client.send('GET', 'api/auth/google/start?return=/');
    const back = consent(world, start.headers.get('location') ?? '');
    back.searchParams.set('code', 'c'.repeat(4097));
    assert.equal((await client.send('GET', back.href)).headers.get('location'), 'https://shop.example/?signin=failed');
    assert.ok(logs.some((line) => line.message.includes('sign-in failed (code)')));
    assert.equal(world.callsTo('https://oauth2.googleapis.com/token').length, 0);
  });

  test('a token response that is not a success, or whose ID token is over 16 KiB, signs no one in', async () => {
    const world = createWorld();
    world.token = 'error-with-token';
    const { app, logs } = makeApp(world);
    assert.equal((await signIn(world, browser(app))).headers.get('location'), 'https://shop.example/?signin=failed');
    assert.ok(logs.some((line) => line.message.includes('sign-in failed (token)')));
    world.token = 'ok';
    logs.length = 0;
    // Signed by Google's key and right in every claim, but far longer than any token Google issues.
    const done = await signIn(world, browser(app), { claims: { padding: 'x'.repeat(16_384) } });
    assert.equal(done.headers.get('location'), 'https://shop.example/?signin=failed');
    assert.ok(logs.some((line) => line.message.includes('sign-in failed (token)')));
  });

  test('logout ends the session', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const token = client.jar.get('__Host-demo-session') ?? '';
    const out = await client.send('POST', 'api/auth/logout');
    assert.equal(out.status, 204);
    assert.equal(await out.text(), '');
    assert.ok(!client.jar.has('__Host-demo-session'));
    const hash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
    assert.equal(await store.get(`demo:session:${hash}`), null);
    assert.equal(await store.get(`demo:sessions:${USER}`), null, 'the index of the only session is gone with it');
    const replay = browser(app);
    replay.jar.set('__Host-demo-session', token);
    assert.deepEqual(await bodyOf(await replay.send('GET', 'api/me')), { user: null, entitlements: [] });
  });

  test('a session expires after thirty days', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    world.clock += 30 * 86_400_000 + 1000;
    assert.deepEqual(await bodyOf(await client.send('GET', 'api/me')), { user: null, entitlements: [] });
  });
});

describe('ID-token verification', () => {
  /** @param {World} world */
  const keysFor = (world) => createKeyCache({ fetch: world.fetch, now: world.now });

  /**
   * @param {World} world
   * @param {{ header?: Record<string, unknown>, claims?: Record<string, unknown>, key?: typeof KEY_A }} [options]
   */
  const token = (world, options = {}) => {
    const key = options.key ?? KEY_A;
    return signJwt({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...options.header }, claimsFor('the-nonce', world.clock, options.claims), key.privateKey);
  };

  /**
   * @param {World} world
   * @param {string} idToken
   * @param {ReturnType<typeof createKeyCache>} [keys]
   */
  const verify = (world, idToken, keys = keysFor(world)) => verifyIdToken(idToken, { clientId: CLIENT_ID, nonce: 'the-nonce', now: world.clock, keys });

  /**
   * @param {Promise<unknown>} promise
   * @param {string} reason
   */
  const refused = (promise, reason) => assert.rejects(promise, (error) => error instanceof AuthError && error.reason === reason);

  test('a good token gives the sub and the verified email', async () => {
    const world = createWorld();
    assert.deepEqual(await verify(world, await token(world)), { sub: '1001', email: 'ada@example.com' });
    assert.deepEqual(await verify(world, await token(world, { claims: { email_verified: false } })), { sub: '1001' });
    assert.deepEqual(await verify(world, await token(world, { claims: { email_verified: 'true' } })), { sub: '1001' });
    assert.deepEqual(await verify(world, await token(world, { claims: { iss: 'accounts.google.com', azp: undefined } })), { sub: '1001', email: 'ada@example.com' });
  });

  test('aud, iss and azp must be the client and Google', async () => {
    const world = createWorld();
    await refused(verify(world, await token(world, { claims: { aud: 'other.apps.googleusercontent.com' } })), 'aud');
    await refused(verify(world, await token(world, { claims: { aud: [CLIENT_ID] } })), 'aud');
    await refused(verify(world, await token(world, { claims: { aud: undefined } })), 'aud');
    await refused(verify(world, await token(world, { claims: { iss: 'https://accounts.google.com.evil.example' } })), 'iss');
    await refused(verify(world, await token(world, { claims: { iss: 'http://accounts.google.com' } })), 'iss');
    await refused(verify(world, await token(world, { claims: { azp: 'other.apps.googleusercontent.com' } })), 'azp');
  });

  test('expired and future tokens, with sixty seconds of skew', async () => {
    const world = createWorld();
    const at = Math.floor(world.clock / 1000);
    await refused(verify(world, await token(world, { claims: { exp: at - 61 } })), 'exp');
    await refused(verify(world, await token(world, { claims: { exp: at - 60 } })), 'exp');
    assert.ok(await verify(world, await token(world, { claims: { exp: at - 30 } })), 'inside the skew');
    await refused(verify(world, await token(world, { claims: { exp: String(at + 100) } })), 'exp');
    await refused(verify(world, await token(world, { claims: { iat: at + 61 } })), 'iat');
    assert.ok(await verify(world, await token(world, { claims: { iat: at + 30 } })), 'inside the skew');
    await refused(verify(world, await token(world, { claims: { iat: undefined } })), 'iat');
  });

  test('nonce and sub', async () => {
    const world = createWorld();
    await refused(verify(world, await token(world, { claims: { nonce: 'another-nonce' } })), 'nonce');
    await refused(verify(world, await token(world, { claims: { nonce: undefined } })), 'nonce');
    await refused(verify(world, await token(world, { claims: { sub: '../1001' } })), 'sub');
    await refused(verify(world, await token(world, { claims: { sub: 1001 } })), 'sub');
  });

  test('alg none, HS256 keyed with the public key, and other algorithms are refused', async () => {
    const world = createWorld();
    const claims = b64(JSON.stringify(claimsFor('the-nonce', world.clock)));
    const none = `${b64(JSON.stringify({ alg: 'none', kid: KEY_A.kid }))}.${claims}.`;
    await refused(verify(world, none), 'alg');
    const noneSigned = `${b64(JSON.stringify({ alg: 'none', kid: KEY_A.kid }))}.${claims}.${b64('x')}`;
    await refused(verify(world, noneSigned), 'alg');
    // The classic confusion: HMAC with the RSA public key as the secret.
    for (const secret of [JSON.stringify(KEY_A.jwk), String(KEY_A.jwk.n)]) {
      const head = b64(JSON.stringify({ alg: 'HS256', kid: KEY_A.kid, typ: 'JWT' }));
      const mac = createHmac('sha256', secret).update(`${head}.${claims}`).digest();
      await refused(verify(world, `${head}.${claims}.${b64(mac)}`), 'alg');
    }
    await refused(verify(world, await token(world, { header: { alg: 'RS512' } })), 'alg');
    await refused(verify(world, await token(world, { header: { alg: 'rs256' } })), 'alg');
    await refused(verify(world, await token(world, { header: { crit: ['exp'] } })), 'crit');
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 0, 'refused before any key was fetched');
  });

  test('a tampered payload or a signature from another key is refused', async () => {
    const world = createWorld();
    const good = await token(world);
    const [head, , signature] = good.split('.');
    const forged = b64(JSON.stringify(claimsFor('the-nonce', world.clock, { sub: '6666' })));
    await refused(verify(world, `${head}.${forged}.${signature}`), 'signature');
    const other = await token(world, { key: KEY_B, header: { kid: KEY_A.kid } });
    await refused(verify(world, other), 'signature');
    await refused(verify(world, good.split('.').slice(0, 2).join('.')), 'format');
    await refused(verify(world, `${good}.extra`), 'format');
  });

  test('an unknown kid is fetched once more, then refused; a rotated key is found', async () => {
    const world = createWorld();
    const keys = keysFor(world);
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 1);
    const rotated = await token(world, { key: KEY_B });
    await refused(verify(world, rotated, keys), 'kid');
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 2, 'exactly one refetch');
    world.jwks = [KEY_A.jwk, KEY_B.jwk];
    assert.ok(await verify(world, rotated, keys));
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 3);
    assert.ok(await verify(world, rotated, keys));
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 3, 'now cached');
  });

  test('only an RS256 signing key in the key set is used; a key set that is not a success is not used', async () => {
    const world = createWorld();
    const rotated = await token(world, { key: KEY_B });
    for (const published of [{ ...KEY_B.jwk, alg: 'RS512' }, { ...KEY_B.jwk, use: 'enc' }]) {
      world.jwks = [KEY_A.jwk, published];
      await refused(verify(world, rotated), 'kid');
    }
    world.jwks = [KEY_A.jwk, { ...KEY_B.jwk, alg: undefined, use: undefined }];
    assert.ok(await verify(world, rotated), 'alg and use may be left out');
    world.jwksStatus = 500;
    await refused(verify(world, rotated), 'jwks');
  });

  test('the key set is kept a day at most, whatever Cache-Control says', async () => {
    const world = createWorld();
    world.jwksCacheControl = 'public, max-age=999999999';
    const keys = keysFor(world);
    await verify(world, await token(world), keys);
    world.clock += 86_400_000 - 1000;
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 1);
    world.clock += 2000;
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 2);
  });

  test('an address with a space or a control character in it is not kept', async () => {
    const world = createWorld();
    for (const email of ['ada lovelace@example.com', 'ada@exa\u0007mple.com', 'ada@example.com\n', 'no-at-sign', '@example.com']) {
      assert.deepEqual(await verify(world, await token(world, { claims: { email } })), { sub: '1001' }, JSON.stringify(email));
    }
  });

  test('an empty signature or an absurd kid is refused before the key set is fetched', async () => {
    const world = createWorld();
    const [head, body] = (await token(world)).split('.');
    await refused(verify(world, `${head}.${body}.`), 'format');
    await refused(verify(world, await token(world, { header: { kid: 'k'.repeat(257) } })), 'kid');
    await refused(verify(world, await token(world, { header: { kid: '' } })), 'kid');
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 0);
  });

  test('the key set is cached for as long as Cache-Control says', async () => {
    const world = createWorld();
    world.jwksCacheControl = 'public, max-age=100';
    const keys = keysFor(world);
    await verify(world, await token(world), keys);
    world.clock += 99_000;
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 1);
    world.clock += 2_000;
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 2);
    world.jwksCacheControl = 'no-store';
    world.clock += 200_000;
    await verify(world, await token(world), keys);
    await verify(world, await token(world), keys);
    assert.equal(world.callsTo('https://www.googleapis.com/').length, 4, 'no-store is not cached');
  });
});

describe('CSRF', () => {
  test('POST and DELETE need the site Origin and, with a body, application/json', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const json = JSON.stringify({ product: 'pro' });
    const cases = [
      { what: 'no Origin', method: 'POST', path: 'api/checkout', origin: null, type: 'application/json', body: json, status: 403 },
      { what: 'a foreign Origin', method: 'POST', path: 'api/checkout', origin: 'https://evil.example', type: 'application/json', body: json, status: 403 },
      { what: 'Origin null', method: 'POST', path: 'api/checkout', origin: 'null', type: 'application/json', body: json, status: 403 },
      { what: 'a look-alike Origin', method: 'POST', path: 'api/checkout', origin: 'https://shop.example.evil.example', type: 'application/json', body: json, status: 403 },
      { what: 'text/plain', method: 'POST', path: 'api/checkout', origin: ORIGIN, type: 'text/plain', body: json, status: 415 },
      { what: 'a form', method: 'POST', path: 'api/checkout', origin: ORIGIN, type: 'application/x-www-form-urlencoded', body: 'product=pro', status: 415 },
      { what: 'multipart', method: 'POST', path: 'api/checkout', origin: ORIGIN, type: 'multipart/form-data; boundary=x', body: '--x--', status: 415 },
      { what: 'no type', method: 'POST', path: 'api/checkout', origin: ORIGIN, type: null, body: new TextEncoder().encode(json), status: 415 },
      { what: 'logout without Origin', method: 'POST', path: 'api/auth/logout', origin: null, type: null, body: null, status: 403 },
      { what: 'logout as a form', method: 'POST', path: 'api/auth/logout', origin: ORIGIN, type: 'application/x-www-form-urlencoded', body: 'a=1', status: 415 },
      { what: 'portal from elsewhere', method: 'POST', path: 'api/portal', origin: 'https://evil.example', type: null, body: null, status: 403 },
      { what: 'delete without Origin', method: 'DELETE', path: 'api/me', origin: null, type: null, body: null, status: 403 },
      { what: 'delete as text', method: 'DELETE', path: 'api/me', origin: ORIGIN, type: 'text/plain', body: 'x', status: 415 },
    ];
    for (const item of cases) {
      /** @type {Record<string, string>} */
      const headers = {};
      if (item.type) headers['content-type'] = item.type;
      const response = await client.send(item.method, item.path, { headers, body: item.body, origin: item.origin });
      assert.equal(response.status, item.status, item.what);
      assertApiHeaders(response);
    }
    assert.equal(world.sessions.length, 0, 'no checkout session was created');
    assert.ok(client.jar.has('__Host-demo-session'), 'still signed in');
    assert.equal((await client.postJson('api/checkout', { product: 'pro' }, { 'content-type': 'Application/JSON; charset=utf-8' })).status, 200);
    assert.equal((await client.send('POST', 'api/auth/logout', { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 204);
  });
});

describe('checkout and the portal', () => {
  test('a checkout session carries the user, product, app and URLs from APP_URL', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const response = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(response.status, 200);
    assertApiHeaders(response);
    assert.deepEqual(await bodyOf(response), { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const form = world.sessions[0];
    assert.ok(form);
    assert.deepEqual(Object.fromEntries(form), {
      mode: 'payment',
      'line_items[0][price]': 'price_pro123',
      'line_items[0][quantity]': '1',
      client_reference_id: USER,
      'metadata[app]': 'demo',
      'metadata[user]': USER,
      'metadata[product]': 'pro',
      success_url: 'https://shop.example/?purchase=success',
      cancel_url: 'https://shop.example/?purchase=cancelled',
      expires_at: String(T0 / 1000 + 3600),
      customer_creation: 'always',
      'payment_intent_data[metadata][app]': 'demo',
      'payment_intent_data[metadata][user]': USER,
      'payment_intent_data[metadata][product]': 'pro',
    });
    const call = world.callsTo('https://api.stripe.com/v1/checkout/sessions')[0];
    assert.equal(call?.headers.get('authorization'), `Bearer ${STRIPE_KEY}`);
  });

  test('a subscription carries its metadata on the subscription; a known customer is reused', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = await owner(world, app);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
    assert.deepEqual(Object.fromEntries(world.sessions[0] ?? []), {
      mode: 'subscription',
      'line_items[0][price]': 'price_monthly123',
      'line_items[0][quantity]': '1',
      client_reference_id: USER,
      'metadata[app]': 'demo',
      'metadata[user]': USER,
      'metadata[product]': 'monthly',
      success_url: 'https://shop.example/?purchase=success',
      cancel_url: 'https://shop.example/?purchase=cancelled',
      expires_at: String(T0 / 1000 + 3600),
      customer: 'cus_test1',
      'subscription_data[metadata][app]': 'demo',
      'subscription_data[metadata][user]': USER,
      'subscription_data[metadata][product]': 'monthly',
    });
  });

  test('401 without a session; 404 for an unknown or unpriced product; 400 for a bad body', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const anonymous = browser(app);
    assert.equal((await anonymous.postJson('api/checkout', { product: 'pro' })).status, 401);
    // Signed out, nothing else is read: not the body, and not Stripe's price.
    assert.equal((await anonymous.postJson('api/checkout', { product: 'nope' })).status, 401);
    assert.equal((await anonymous.send('POST', 'api/checkout', { headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 401);
    assert.equal(world.callsTo('https://api.stripe.com/').length, 0, 'no Stripe call for a visitor not signed in');
    const forged = browser(app);
    forged.jar.set('__Host-demo-session', base64url(new Uint8Array(32).fill(9)));
    assert.equal((await forged.postJson('api/checkout', { product: 'pro' })).status, 401);
    const client = browser(app);
    await signIn(world, client);
    for (const product of ['nope', 'later', '__proto__', 'constructor', 7, null]) {
      assert.equal((await client.postJson('api/checkout', { product })).status, 404, String(product));
    }
    assert.equal((await client.send('POST', 'api/checkout', { headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await client.send('POST', 'api/checkout', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'pro', pad: 'x'.repeat(5000) }) })).status, 413);
    assert.equal(world.sessions.length, 0);
  });

  test('409 when the product is owned or the subscription active', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = await owner(world, app);
    const owned = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(owned.status, 409);
    assert.deepEqual(await bodyOf(owned), { error: 'already_owned' });
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    assert.deepEqual(await entitlementsOf(client), ['pro', 'supporter']);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 409);
    assert.equal(world.sessions.length, 0);
  });

  test('ten checkouts per user per hour, then 429 until the next hour', async () => {
    // Every press that reaches Stripe counts: the first makes a Checkout Session, each later one
    // asks Stripe about it and is given it again (see the next describe).
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    for (let i = 0; i < 10; i += 1) assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 200, `checkout ${i + 1}`);
    assert.equal(world.sessions.length, 1);
    assert.equal(world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length, 9, 'nine lookups of the session');
    const limited = await client.postJson('api/checkout', { product: 'monthly' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assertApiHeaders(limited);
    const other = browser(app);
    await signIn(world, other, { sub: '3003' });
    assert.equal((await other.postJson('api/checkout', { product: 'pro' })).status, 200, 'per user');
    world.clock += 3_600_000;
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 200);
    assert.equal(world.sessions.length, 3, 'the first expired unpaid within the hour, so a new one');
    assert.equal(world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length, 10);
  });

  test('the limit holds for checkouts sent at once, on a store that answers a turn later', async () => {
    // Two products at once, so two checkouts are always under way together and count against
    // the one limit (each product's presses wait for each other: see the next describe).
    const world = createWorld();
    const { app } = makeApp(world, { store: slowStore(createMemoryStore({ now: world.now })) });
    const client = browser(app);
    await signIn(world, client);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => client.postJson('api/checkout', { product: i % 2 ? 'monthly' : 'pro' })));
    assert.deepEqual(answers.map((r) => r.status).sort(), [...Array(10).fill(200), ...Array(10).fill(429)]);
    assert.equal(world.sessions.length, 2, 'one Checkout Session per product');
    assert.equal(world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length, 8, 'and a lookup of it for each other press let through');
    const urls = new Set(await Promise.all(answers.filter((r) => r.status === 200).map(async (r) => (await bodyOf(r)).url)));
    assert.deepEqual([...urls].sort(), ['https://checkout.stripe.com/c/pay/cs_test_1', 'https://checkout.stripe.com/c/pay/cs_test_2']);
  });

  test('a Stripe failure is a 502 with nothing from Stripe in it, given again to a press that read the same within its five minutes; a dropped connection is retried under the same key', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    world.checkout = 'error';
    const failed = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes('CANARY'));
    assert.ok(logs.some((line) => line.message.includes('checkout failed (Stripe 500)')));
    assert.ok(!logs.some((line) => line.message.includes('CANARY')));
    // Stripe keeps the answer to a key, an error included (VERIFY-20: the key is what the press
    // read), so the next press in the same five minutes is given that 500 again and nothing is
    // made; the next five minutes ask afresh.
    world.checkout = 'ok';
    const again = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(again.status, 502);
    assert.deepEqual([world.replays, world.sessions.length], [1, 0]);
    world.clock += 300_000;
    world.checkout = 'drop-once';
    world.calls.length = 0;
    const retried = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(retried.status, 200);
    const attempts = world.callsTo('https://api.stripe.com/v1/checkout/sessions');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.headers.get('idempotency-key'), attempts[1]?.headers.get('idempotency-key'));
  });

  test('two subscriptions bought before the first webhook belong to two customers: Manage subscription reaches each that still charges, so the account can go', async () => {
    // Two Buy tabs, both paid before either webhook arrived: the kit knew no customer, so it
    // sent none, and Stripe made one for each. The second subscription becomes known from its
    // checkout's completion, or from its own update when that arrives first.
    // (One process makes one Checkout Session for both presses, as the first assertions show;
    // two locations of KV within its minute, or a subscription made in the dashboard, still give
    // a visitor two.)
    for (const known of ['checkout', 'update']) {
      const world = createWorld();
      const { app, store } = makeApp(world);
      const client = browser(app);
      await signIn(world, client);
      const both = await Promise.all([0, 1].map(() => client.postJson('api/checkout', { product: 'monthly' })));
      assert.deepEqual(both.map((r) => r.status), [200, 200], known);
      assert.deepEqual(new Set(await Promise.all(both.map(async (r) => (await bodyOf(r)).url))).size, 1, `${known}: one session for both presses`);
      assert.deepEqual(world.sessions.map((form) => form.get('customer')), [null], `${known}: no customer known yet`);
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription', sub: 'sub_a', customer: 'cus_test1' })));
      if (known === 'checkout') await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription', sub: 'sub_b', customer: 'cus_test2' })));
      else await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_b', status: 'active', customer: 'cus_test2' })));
      assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['subscription:sub_a', 'subscription:sub_b'], customer: 'cus_test1' }, known);
      /** @returns {Promise<string | null | undefined>} */
      const portalFor = async () => {
        const response = await client.send('POST', 'api/portal');
        assert.equal(response.status, 200, known);
        return world.portals.at(-1)?.get('customer');
      };
      assert.equal(await portalFor(), 'cus_test1', `${known}: the first that still charges`);
      // Set to end there; the account still cannot go, and Manage subscription now reaches the other.
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ id: 'sub_a', status: 'active', customer: 'cus_test1' }), cancel_at_period_end: true }));
      assert.equal((await client.send('DELETE', 'api/me')).status, 409, known);
      assert.equal(await portalFor(), 'cus_test2', `${known}: the second, which still charges`);
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ id: 'sub_b', status: 'active', customer: 'cus_test2' }), cancel_at_period_end: true }));
      assert.equal(await portalFor(), 'cus_test1', `${known}: with nothing still charging, the user record's customer`);
      assert.equal((await client.send('DELETE', 'api/me')).status, 204, known);
      // Neither customer outlives the account (the rate-limit counters expire on their own).
      for (const key of store.keys()) {
        if (/^demo:test:ratelimit:/.test(key)) continue;
        assert.ok(!/1001|cus_test/.test(`${key} ${JSON.stringify(await store.get(key))}`), `${known}: ${key} outlives the account`);
      }
    }
  });

  test('a customer Stripe no longer knows is forgotten: Buy makes its session without it, Manage subscription answers 404', async () => {
    // VERIFY-14: kept, the customer was sent with every Checkout and portal session, and each
    // was a 502 for good once the owner deleted it in the dashboard.
    const world = createWorld();
    const { app, store, logs } = makeApp(world);
    const client = await owner(world, app);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.deletedCustomers.add('cus_test1');
    // Manage subscription first: the subscription's customer, refused by Stripe.
    const portal = await client.send('POST', 'api/portal');
    assert.equal(portal.status, 404);
    assert.deepEqual(await bodyOf(portal), { error: 'not_found' });
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['payment:pi_test1', 'subscription:sub_test1'] });
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { user: USER, product: 'monthly', grants: 'supporter' });
    const asked = world.callsTo('https://api.stripe.com/v1/billing_portal/sessions').length;
    assert.equal((await client.send('POST', 'api/portal')).status, 404, 'nothing left to manage');
    assert.equal(world.callsTo('https://api.stripe.com/v1/billing_portal/sessions').length, asked, 'and Stripe is not asked again');
    const warned = logs.filter((line) => line.level === 'warn' && line.message.includes('no longer knows'));
    assert.deepEqual(warned.map((line) => line.message), ['kit (demo): Stripe no longer knows the customer kept for an account (customer): it is forgotten, and the next checkout lets Stripe make a new one']);
    assert.ok(!logs.some((line) => /cus_test1|CANARY/.test(line.message)), 'the customer and Stripe\'s message are never logged');

    // Buy, with a user record that still names it (a fresh store, the same user and customer).
    const second = makeApp(world);
    const buyer = await owner(world, second.app);
    const response = await buyer.postJson('api/checkout', { product: 'monthly' });
    assert.equal(response.status, 200);
    const posts = world.calls.filter((call) => call.method === 'POST' && call.url === 'https://api.stripe.com/v1/checkout/sessions').slice(-2);
    assert.deepEqual(posts.map((call) => new URLSearchParams(call.body).get('customer')), ['cus_test1', null], 'refused with it, made without it');
    assert.notEqual(posts[0]?.headers.get('idempotency-key'), posts[1]?.headers.get('idempotency-key'), 'a new key for the new request');
    assert.deepEqual(await second.store.get(`demo:test:user:${USER}`), { refs: ['payment:pi_test1'] });
    assert.ok(!second.logs.some((line) => line.level === 'error'), 'no failure to report');
    // A customer Stripe knows is kept, and a 400 about anything else is a 502 that forgets nothing.
    world.deletedCustomers.clear();
    const third = makeApp(world);
    const keeper = await owner(world, third.app);
    world.checkout = 'error';
    assert.equal((await keeper.postJson('api/checkout', { product: 'monthly' })).status, 502);
    world.checkout = 'ok';
    // Each in five minutes of its own: within them, Stripe gives a press that read the same the
    // answer it kept for the first.
    for (const error of [
      { code: 'parameter_invalid_empty', param: 'customer' },
      { code: 'resource_missing', param: 'line_items[0][price]' },
      { code: 'resource_missing' },
    ]) {
      world.clock += 300_000;
      world.checkoutRefusal = { status: 400, error };
      assert.equal((await keeper.postJson('api/checkout', { product: 'monthly' })).status, 502, JSON.stringify(error));
    }
    world.clock += 300_000;
    world.checkoutRefusal = { status: 404, error: { code: 'resource_missing', param: 'customer' } };
    assert.equal((await keeper.postJson('api/checkout', { product: 'monthly' })).status, 502, 'a 404');
    world.checkoutRefusal = null;
    assert.deepEqual(await third.store.get(`demo:test:user:${USER}`), { refs: ['payment:pi_test1'], customer: 'cus_test1' }, 'nothing forgotten');
    assert.ok(third.logs.some((line) => line.message === 'kit (demo): checkout failed (Stripe 400 resource_missing on line_items[0][price])'), "Stripe's code and param are logged");
    assert.ok(!third.logs.some((line) => line.message.includes('no longer knows')));
  });

  test('a customer Stripe no longer knows is forgotten alone: the user record and every other subscription keep theirs, and a cancelled subscription stays bounded', async () => {
    // VERIFY-19. Two subscriptions under two customers (see above). Manage subscription opens the
    // second's, which Stripe no longer knows: forgetting it must not forget the first customer,
    // which Stripe still knows and which Manage subscription needs while the first still charges.
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription', sub: 'sub_a', customer: 'cus_test1' })));
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription', sub: 'sub_b', customer: 'cus_test2' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ id: 'sub_a', status: 'active', customer: 'cus_test1' }), cancel_at_period_end: true }));
    world.deletedCustomers.add('cus_test2');
    assert.equal((await client.send('POST', 'api/portal')).status, 404, "the second's customer, refused");
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['subscription:sub_a', 'subscription:sub_b'], customer: 'cus_test1' });
    assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_a')).customer, 'cus_test1');
    assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_b')).customer, undefined);
    // Renewed, the first still charges, and Manage subscription reaches it.
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_a', status: 'active', customer: 'cus_test1' })));
    assert.equal((await client.send('POST', 'api/portal')).status, 200);
    assert.equal(world.portals.at(-1)?.get('customer'), 'cus_test1');

    // Cancelled, the first's record goes 30 days on; forgetting its customer then keeps that bound.
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ id: 'sub_a', status: 'canceled', customer: 'cus_test1' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ id: 'sub_b', status: 'canceled', customer: 'cus_test2' })));
    world.deletedCustomers.add('cus_test1');
    assert.equal((await client.send('POST', 'api/portal')).status, 404, "the user record's customer, refused");
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['subscription:sub_a', 'subscription:sub_b'] });
    const forgotten = /** @type {any} */ (await store.get('demo:test:subscription:sub_a'));
    assert.deepEqual([forgotten.status, forgotten.customer], ['canceled', undefined]);
    world.clock += 31 * 86_400_000;
    assert.equal(await store.get('demo:test:subscription:sub_a'), null, 'gone 30 days after it ended, its customer forgotten or not');
  });

  test("Stripe's error code and the parameter it names are kept when they are identifiers, and nothing else of its answer", async () => {
    /** @param {unknown} error */
    const answering = (error) => async () => Response.json({ error }, { status: 400 });
    const cases = [
      [{ code: 'resource_missing', param: 'customer', message: 'CANARY' }, 'resource_missing', 'customer'],
      [{ code: 'parameter_invalid_integer', param: 'line_items[0][quantity]' }, 'parameter_invalid_integer', 'line_items[0][quantity]'],
      [{ code: 'Resource Missing', param: 'customer; drop' }, null, null],
      [{ code: 'x'.repeat(65), param: 7 }, null, null],
      ['CANARY', null, null],
    ];
    for (const [error, code, param] of cases) {
      const failed = await getPrice({ fetch: answering(error), key: STRIPE_KEY, price: 'price_x1', mode: 'payment' }).then(
        () => null,
        (thrown) => thrown,
      );
      assert.ok(failed instanceof StripeError, JSON.stringify(error));
      assert.deepEqual([failed.status, failed.code, failed.param], [400, code, param], JSON.stringify(error));
      assert.ok(!failed.message.includes('CANARY'));
    }
    const notJson = await getPrice({ fetch: async () => new Response('CANARY <html>', { status: 503 }), key: STRIPE_KEY, price: 'price_x1', mode: 'payment' }).catch((thrown) => thrown);
    assert.deepEqual([notJson.status, notJson.code, notJson.param], [503, null, null]);
  });

  test('the portal: 404 without a Stripe customer, a session returning to APP_URL with one', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const fresh = browser(app);
    await signIn(world, fresh, { sub: '4004' });
    assert.equal((await fresh.send('POST', 'api/portal')).status, 404);
    assert.equal((await browser(app).send('POST', 'api/portal')).status, 401);
    const client = await owner(world, app);
    const portal = await client.send('POST', 'api/portal');
    assert.equal(portal.status, 200);
    assert.deepEqual(await bodyOf(portal), { url: 'https://billing.stripe.com/p/session/test_1' });
    assert.deepEqual(Object.fromEntries(world.portals[0] ?? []), { customer: 'cus_test1', return_url: APP_URL });
  });
});

describe('one Checkout Session per visitor and product', () => {
  const MARKER = `demo:test:checkout:${USER}:pro`;

  test('a second Buy before the webhook reaches the same session; once it is paid, 409 payment_pending; once recorded, already_owned; once refunded, a new one', async () => {
    // PG-INT-1: the page back from Checkout at ?purchase=success before the webhook, another
    // tab, a reload. Before, each press made its own session, both could be paid, and both
    // webhooks recorded a payment.
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const first = await bodyOf(await client.postJson('api/checkout', { product: 'pro' }));
    const again = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(again.status, 200);
    assert.deepEqual(await bodyOf(again), first, 'the same session, still open');
    assert.equal(world.sessions.length, 1);
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_1', url: first.url });
    world.pay();
    const pending = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(pending.status, 409);
    assert.deepEqual(await bodyOf(pending), { error: 'payment_pending' });
    assertApiHeaders(pending);
    assert.equal(world.sessions.length, 1, 'no second session to pay');
    // The webhook records the purchase; the session stays remembered (VERIFY-16: a second Buy
    // reads the purchase through it wherever the user record has not caught up).
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession(), id: 'cs_test_1' }));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_1', url: first.url });
    assert.deepEqual(await bodyOf(await client.postJson('api/checkout', { product: 'pro' })), { error: 'already_owned' });
    // Refunded in full, it can be bought again: Stripe still reports that session paid, and its
    // purchase record says refunded, so a new session.
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', refund('pi_test1')));
    const rebuy = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(rebuy.status, 200);
    assert.equal((await bodyOf(rebuy)).url, 'https://checkout.stripe.com/c/pay/cs_test_2');
  });

  test('a session that expired unpaid, or that Stripe no longer has, gives way to a new one; a lookup that fails in any other way makes none', async () => {
    const world = createWorld();
    const { app, logs } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 200);
    world.clock += 3_600_000;
    assert.equal((await bodyOf(await client.postJson('api/checkout', { product: 'pro' }))).url, 'https://checkout.stripe.com/c/pay/cs_test_2', 'expired unpaid');
    world.checkouts.delete('cs_test_2');
    assert.equal((await bodyOf(await client.postJson('api/checkout', { product: 'pro' }))).url, 'https://checkout.stripe.com/c/pay/cs_test_3', 'not found');
    // Only a 404 says Stripe has no such session. A 5xx, its rate or lock limit (429), or a
    // refused key (401, 403) says nothing of whether it was paid (VERIFY-19).
    for (const status of [500, 429, 401, 403]) {
      world.sessionLookup = status;
      const failed = await client.postJson('api/checkout', { product: 'pro' });
      assert.equal(failed.status, 502, String(status));
      assert.deepEqual(await bodyOf(failed), { error: 'upstream_unavailable' });
      assert.ok(logs.some((line) => line.message === `kit (demo): checkout failed (Stripe ${status})`), String(status));
    }
    assert.equal(world.sessions.length, 3, 'whether the last one was paid is not known: no new one');
    assert.ok(!logs.some((line) => line.message.includes('CANARY')));
    // Paid, and its webhook never arrives (the endpoint removed, say): refused for 30 days, as
    // long as Stripe keeps the event, then the session is forgotten.
    world.sessionLookup = 'ok';
    world.pay('cs_test_3');
    world.clock += 29 * 86_400_000;
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 409);
    world.clock += 2 * 86_400_000;
    await signIn(world, client);
    assert.equal((await bodyOf(await client.postJson('api/checkout', { product: 'pro' }))).url, 'https://checkout.stripe.com/c/pay/cs_test_4');
  });

  test('a delayed payment holds the session until its webhook says how it ended; only that session is let go', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await client.postJson('api/checkout', { product: 'pro' });
    world.pay();
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession({ status: 'unpaid' }), id: 'cs_test_1' }));
    assert.deepEqual(await entitlementsOf(client), []);
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 409, 'a payment is on its way');
    // A failure about another session (an older one) lets nothing go.
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', { ...paidSession({ status: 'unpaid' }), id: 'cs_test_0' }));
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', { ...paidSession({ status: 'unpaid' }), id: 'cs_test_1' }));
    // Kept as failed (VERIFY-20): with no marker, the next press, in the five minutes the first
    // was made in, would read what the first read and share its Idempotency-Key, and Stripe would
    // give that session back, paid with a payment that failed: payment_pending for 30 days.
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_1', failed: true });
    const next = await client.postJson('api/checkout', { product: 'pro' });
    assert.equal(next.status, 200, 'the visitor may pay another way');
    assert.equal((await bodyOf(next)).url, 'https://checkout.stripe.com/c/pay/cs_test_2');
    assert.equal(world.replays, 0);
    assert.equal(world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length, 1, 'a failed session is not asked about');
    // Another app's failure, or a session naming another visitor, is not ours to let go.
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', { ...paidSession({ status: 'unpaid', app: 'other' }), id: 'cs_test_2' }));
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', { ...paidSession({ status: 'unpaid', user: 'google:2002' }), id: 'cs_test_2' }));
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
    // A failed session is remembered for an hour, past the five minutes a key is shared in.
    world.pay('cs_test_2');
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', { ...paidSession({ status: 'unpaid' }), id: 'cs_test_2' }));
    world.clock += 3_599_000;
    assert.deepEqual(await store.get(MARKER), { id: 'cs_test_2', failed: true });
    world.clock += 1000;
    assert.equal(await store.get(MARKER), null);
  });

  test('a Buy pressed while the webhook is recording the payment is refused: the session is let go only once it is recorded', async () => {
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    const gated = gatedStore(inner);
    const { app } = makeApp(world, { store: gated.store });
    const client = browser(app);
    await signIn(world, client);
    await client.postJson('api/checkout', { product: 'pro' });
    world.pay();
    /** @type {() => void} */
    let answered = () => {};
    const done = new Promise((resolve) => {
      answered = () => resolve(undefined);
    });
    gated.hold('put', 'demo:test:payment:pi_test1', Promise.race([done, new Promise((resolve) => setTimeout(resolve, 100))]));
    const reading = gated.seen('get', 'demo:test:payment:pi_test1');
    const hook = postWebhook(browser(app), world, stripeEvent(world, 'checkout.session.completed', { ...paidSession(), id: 'cs_test_1' }));
    await reading;
    const press = await client.postJson('api/checkout', { product: 'pro' });
    answered();
    assert.equal((await hook).status, 200);
    assert.deepEqual([press.status, await bodyOf(press)], [409, { error: 'payment_pending' }]);
    assert.equal(world.sessions.length, 1);
    assert.deepEqual(await entitlementsOf(client), ['pro']);
  });

  test('presses sent at once make one session for each product, a subscription as a payment', async () => {
    const world = createWorld();
    const { app } = makeApp(world, { store: slowStore(createMemoryStore({ now: world.now })) });
    const client = browser(app);
    await signIn(world, client);
    for (const product of ['pro', 'monthly']) {
      const answers = await Promise.all(Array.from({ length: 4 }, () => client.postJson('api/checkout', { product })));
      assert.deepEqual(answers.map((r) => r.status), [200, 200, 200, 200], product);
      assert.equal(new Set(await Promise.all(answers.map(async (r) => (await bodyOf(r)).url))).size, 1, `${product}: one session`);
    }
    assert.deepEqual(world.sessions.map((form) => form.get('metadata[product]')), ['pro', 'monthly']);
  });

  test('deleting the account lets go of the sessions remembered for it', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await client.postJson('api/checkout', { product: 'pro' });
    await client.postJson('api/checkout', { product: 'monthly' });
    await store.put(`demo:live:checkout:${USER}:pro`, { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/pay/cs_live_1' });
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    for (const key of store.keys()) {
      if (/^demo:test:ratelimit:/.test(key)) continue;
      assert.ok(!key.includes('1001'), `${key} outlives the account`);
    }
  });

  test('on KV, a Buy handled away from where the webhook lands is still refused once the session is paid, however long the visitor took to pay', async () => {
    // VERIFY-16. The visitor's requests land in one location, Stripe's webhooks in another.
    // When the webhook let go of the session once it had recorded the payment, the visitor's
    // location could still serve the user record its page had read before the webhook (the poll
    // after ?purchase=success) while its read of the session had expired (a minute or more spent
    // paying): it found neither, and made a second, payable Checkout Session. The session is now
    // kept, and a paid one is answered from the purchase record its webhook writes.
    /**
     * @param {{ product: string, tookS: number, pressS: number[], free?: boolean, early?: boolean, lapsed?: boolean }} plan
     *   presses `pressS` seconds after paying (`early`: one before the webhook too), the webhook
     *   landing 5 s after paying (`lapsed`: the subscription past due a second later)
     */
    const play = async (plan) => {
      const world = createWorld();
      const kv = geoKv(world.now);
      const visitorAt = kv.location();
      const webhooksAt = kv.location();
      const client = browser(makeApp(world, { store: kvStore(() => /** @type {any} */ (visitorAt)) }).app);
      const webhooks = browser(makeApp(world, { store: kvStore(() => /** @type {any} */ (webhooksAt)) }).app);
      await signIn(world, client);
      assert.equal((await client.postJson('api/checkout', { product: plan.product })).status, 200);
      const t0 = world.clock;
      world.clock += plan.tookS * 1000;
      world.pay('cs_test_1', plan.free ? { paymentIntent: null } : {});
      const paid = world.clock;
      world.clock += 2000;
      assert.deepEqual(await entitlementsOf(client), [], 'the page polls before the webhook');
      /** @type {unknown[]} */
      const answers = [];
      const press = async () => {
        const response = await client.postJson('api/checkout', { product: plan.product });
        answers.push(response.status === 409 ? (await bodyOf(response)).error : response.status);
      };
      if (plan.early) await press();
      world.clock = paid + 5000;
      const subscription = plan.product === 'monthly';
      const completed = { ...paidSession(subscription ? { mode: 'subscription' } : plan.free ? { pi: null, status: 'no_payment_required' } : {}), id: 'cs_test_1' };
      assert.equal((await postWebhook(webhooks, world, stripeEvent(world, 'checkout.session.completed', completed))).status, 200);
      if (plan.lapsed) {
        world.clock += 1000;
        assert.equal((await postWebhook(webhooks, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'past_due' })))).status, 200);
      }
      for (const after of plan.pressS) {
        world.clock = paid + after * 1000;
        await press();
      }
      assert.ok(t0 < paid);
      return { answers, sessions: world.sessions.length };
    };
    for (const product of ['pro', 'monthly']) {
      for (const tookS of [30, 100, 300]) {
        const { answers, sessions } = await play({ product, tookS, pressS: [20, 40, 64] });
        assert.deepEqual(answers, ['already_owned', 'already_owned', 'already_owned'], `${product}, paid ${tookS} s after Buy`);
        assert.equal(sessions, 1, `${product}, paid ${tookS} s after Buy: one Checkout Session`);
      }
      // Pressed before the webhook too: that press reads the purchase record before it exists,
      // and the visitor's location serves that read for a minute; each answer is a 409.
      const early = await play({ product, tookS: 100, early: true, pressS: [20, 70] });
      assert.deepEqual(early, { answers: ['payment_pending', 'payment_pending', 'already_owned'], sessions: 1 }, `${product}, pressed early`);
    }
    // A free checkout (a 100% coupon) is recorded under the session's own id.
    assert.deepEqual(await play({ product: 'pro', free: true, tookS: 100, pressS: [20] }), { answers: ['already_owned'], sessions: 1 }, 'free');
    // A subscription past due by then charges again once paid: Manage subscription, not a second.
    assert.deepEqual(await play({ product: 'monthly', lapsed: true, tookS: 100, pressS: [20] }), { answers: ['subscription_active'], sessions: 1 }, 'lapsed');
  });

  test('Buy is refused while a subscription to it will still charge without granting (past due, unpaid, paused, incomplete); once it has ended, a new one is sold', async () => {
    // VERIFY-17. Past due, it granted nothing, so Buy sold a second subscription, under the same
    // customer; Stripe's retry of the first then succeeded and both charged every period. Delete
    // account already counted it as one that will charge.
    /** @param {number} days how long after the purchase its renewal lapses */
    const lapsed = async (days, status = 'past_due') => {
      const world = createWorld();
      const { app } = makeApp(world);
      const client = browser(app);
      await signIn(world, client);
      assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
      world.pay();
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession({ mode: 'subscription' }), id: 'cs_test_1' }));
      assert.deepEqual(await entitlementsOf(client), ['supporter'], status);
      world.clock += days * 86_400_000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status })));
      await signIn(world, client);
      assert.deepEqual(await entitlementsOf(client), [], status);
      const refused = await client.postJson('api/checkout', { product: 'monthly' });
      assert.deepEqual([refused.status, await bodyOf(refused)], [409, { error: 'subscription_active' }], status);
      assertApiHeaders(refused);
      assert.equal(world.sessions.length, 1, `${status}: no second subscription`);
      assert.deepEqual(await bodyOf(await client.send('DELETE', 'api/me')), { error: 'subscription_active' }, `${status}: as Delete account says`);
      const manage = await client.send('POST', 'api/portal');
      assert.equal(manage.status, 200, `${status}: Manage subscription reaches it`);
      assert.equal(world.portals.at(-1)?.get('customer'), 'cus_test1');
      // Cancelled there, it can be bought again.
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
      const lookups = world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length;
      const again = await client.postJson('api/checkout', { product: 'monthly' });
      assert.equal(again.status, 200, `${status}, then cancelled`);
      assert.equal((await bodyOf(again)).url, 'https://checkout.stripe.com/c/pay/cs_test_2', `${status}, then cancelled: a new session`);
      return world.callsTo('https://api.stripe.com/v1/checkout/sessions/').length - lookups;
    };
    // Weeks on, its Checkout Session is no longer remembered: the user's purchase records decide.
    for (const status of ['past_due', 'unpaid', 'paused', 'incomplete']) assert.equal(await lapsed(40, status), 0, `${status}: Stripe is not asked`);
    // Within the 30 days, the session the visitor was given is asked about once it has ended:
    // Stripe reports it paid, and the subscription it made has ended.
    assert.equal(await lapsed(10), 1);
  });

  test('a Buy whose sign-in was read before Delete account, and that reaches its marker after the deletion, is 401 and makes nothing', async () => {
    // VERIFY-18. Held at the first price lookup of a cold process (a body slow to arrive opens
    // the same window), the Buy ran on after the deletion with the sign-in it had read, made a
    // payable Checkout Session and wrote a marker naming the deleted account for 30 days.
    const world = createWorld();
    /** @type {() => void} */
    let reached = () => {};
    const atPrice = new Promise((resolve) => {
      reached = () => resolve(undefined);
    });
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const outbound = world.fetch;
    world.fetch = async (url, init) => {
      if (url.startsWith('https://api.stripe.com/v1/prices/')) {
        reached();
        await held;
      }
      return outbound(url, init);
    };
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const buy = client.postJson('api/checkout', { product: 'pro' });
    await atPrice;
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    release();
    const bought = await within(buy, 'the Buy never answered');
    assert.deepEqual([bought.status, await bodyOf(bought)], [401, { error: 'unauthorized' }]);
    assertApiHeaders(bought);
    assert.equal(world.sessions.length, 0, 'no Checkout Session for a deleted account');
    for (const key of store.keys()) assert.ok(!key.includes('1001'), `${key} names the deleted account`);
  });

  test('deleting the account lets go of the sessions remembered for every product the catalogue lists, with the shop off too; one for a product no longer listed goes within 30 days', async () => {
    // VERIFY-18. With the Stripe variables removed (sign-in still on), the deletion looked for no
    // marker at all, and a marker written while the shop was on outlived the account.
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const client = browser(makeApp(world, { store }).app);
    await signIn(world, client);
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 200);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
    /** @type {string[]} */
    const deleted = [];
    /** @type {import('./store.js').Store} */
    const recording = { get: (key) => store.get(key), put: (key, value, options) => store.put(key, value, options), delete: (key) => (deleted.push(key), store.delete(key)) };
    const off = browser(makeApp(world, { store: recording, env: Object.fromEntries(Object.entries(ENV).filter(([name]) => !name.startsWith('STRIPE_'))) }).app);
    for (const [name, value] of client.jar) off.jar.set(name, value);
    assert.equal((await off.send('DELETE', 'api/me')).status, 204);
    for (const key of store.keys()) if (!/^demo:test:ratelimit:/.test(key)) assert.ok(!key.includes('1001'), `${key} outlives the account`);
    // Only the markers there are deleted: each delete counts against KV's daily allowance.
    assert.deepEqual(deleted.filter((key) => key.includes(':checkout:')).sort(), [`demo:test:checkout:${USER}:monthly`, `demo:test:checkout:${USER}:pro`]);
    // A product taken out of the catalogue is not looked for: its marker names the account until
    // it expires, 30 days after the Buy that wrote it, as the README says.
    const visitor = browser(makeApp(world, { store }).app);
    await signIn(world, visitor);
    assert.equal((await visitor.postJson('api/checkout', { product: 'monthly' })).status, 200);
    const written = world.clock;
    const retired = { ...CATALOGUE, products: CATALOGUE.products.filter((product) => product.id !== 'monthly') };
    const later = browser(makeApp(world, { store, catalogue: retired }).app);
    for (const [name, value] of visitor.jar) later.jar.set(name, value);
    assert.equal((await later.send('DELETE', 'api/me')).status, 204);
    const left = store.keys().filter((key) => key.includes('1001') && !/^demo:test:ratelimit:/.test(key));
    assert.deepEqual(left, [`demo:test:checkout:${USER}:monthly`]);
    world.clock = written + 30 * 86_400_000;
    assert.deepEqual(store.keys().filter((key) => key.includes('1001') && !/^demo:test:ratelimit:/.test(key)), []);
  });

  test("a Buy that reaches its product's turn while Delete account holds it waits, then finds the sign-in ended: 401, and nothing made or left", async () => {
    // VERIFY-21. The sign-in is read again once the Buy holds the marker's lock. Read before the
    // lock, while the deletion held it (here, at its read of the other Stripe mode's user record,
    // which only a deletion reads), the sign-in was still there, and once the deletion let go the
    // Buy made a session and a marker naming the deleted account.
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    /** @type {() => void} */
    let reached = () => {};
    const atDeletion = new Promise((resolve) => {
      reached = () => resolve(undefined);
    });
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    /** @type {import('./store.js').Store} */
    const store = {
      get: async (key) => {
        if (key === `demo:live:user:${USER}`) {
          reached();
          await held;
        }
        return inner.get(key);
      },
      put: (key, value, options) => inner.put(key, value, options),
      delete: (key) => inner.delete(key),
    };
    const { app } = makeApp(world, { store });
    const client = browser(app);
    await signIn(world, client);
    assert.equal((await client.send('GET', 'api/config')).status, 200, 'the price is known: the Buy goes straight to its turn');
    const deletion = client.send('DELETE', 'api/me');
    await atDeletion;
    const buy = client.postJson('api/checkout', { product: 'pro' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [deleted, bought] = await within(Promise.all([deletion, buy]), 'the deletion and the Buy wait on each other');
    assert.equal(deleted.status, 204);
    assert.deepEqual([bought.status, await bodyOf(bought)], [401, { error: 'unauthorized' }]);
    assert.equal(world.sessions.length, 0, 'no Checkout Session for a deleted account');
    assert.deepEqual(inner.keys().filter((key) => key.includes('1001')), [], 'nothing names the deleted account');
  });

  test('a subscription that will still charge refuses Buy for its own entitlement, and no other', async () => {
    // VERIFY-21: refusing every product while any subscription of the visitor's would still
    // charge passed every test, and a visitor whose subscription lapsed could buy nothing else.
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
    world.pay();
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession({ mode: 'subscription' }), id: 'cs_test_1' }));
    world.clock += 40 * 86_400_000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'past_due' })));
    await signIn(world, client);
    const monthly = await client.postJson('api/checkout', { product: 'monthly' });
    assert.deepEqual([monthly.status, await bodyOf(monthly)], [409, { error: 'subscription_active' }]);
    const pro = await client.postJson('api/checkout', { product: 'pro' });
    assert.deepEqual([pro.status, await bodyOf(pro)], [200, { url: 'https://checkout.stripe.com/c/pay/cs_test_2' }], 'pro grants another entitlement');
  });

  test('a paid subscription session whose lookup names no subscription is a payment on its way: 409 payment_pending, and no second session', async () => {
    // VERIFY-21, as the README's Testing section tells a site's own fake Stripe: without the id
    // its webhook records the purchase under, a paid session is a payment still on its way. (The
    // payment-mode half: a free checkout's record is its session's own id, pinned above.)
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
    world.pay('cs_test_1', { subscription: null });
    for (const seconds of [20, 40, 70]) {
      world.clock += seconds * 1000;
      const press = await client.postJson('api/checkout', { product: 'monthly' });
      assert.deepEqual([press.status, await bodyOf(press)], [409, { error: 'payment_pending' }], `${seconds} s on`);
    }
    assert.equal(world.sessions.length, 1);
  });
});

describe('one Checkout Session across isolates and locations', () => {
  const MARKER = `demo:test:checkout:${USER}:pro`;
  const SESSION_1 = { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };

  /**
   * The world's way out, with the first Checkout Session request held at the door until
   * `release()`, as a slow call to Stripe holds it; `reached` resolves once it is there.
   * Installed before the apps are made, which take the world's fetch as they are made.
   * @param {World} world
   */
  const holdFirstCheckout = (world) => {
    const outbound = world.fetch;
    /** @type {() => void} */
    let arrived = () => {};
    const reached = new Promise((resolve) => {
      arrived = () => resolve(undefined);
    });
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    let waiting = true;
    world.fetch = async (url, init) => {
      if (waiting && url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
        waiting = false;
        arrived();
        await held;
      }
      return outbound(url, init);
    };
    return { reached, release };
  };

  test('a double click handled by two isolates makes one session: Stripe refuses the press that comes while the first is being made, and it is given that session when pressed again', async () => {
    // VERIFY-20. Each isolate has locks of its own, so both presses read no session and each
    // made one under a random key: the page followed the first, the marker kept the second, and
    // a Buy pressed back from Checkout before the webhook was given the second, still payable.
    // Both presses now send Stripe the same request under the same key (Stripe's idempotency:
    // the one that comes while the first is running is refused, 409 idempotency_key_in_use).
    const world = createWorld();
    world.making = () => new Promise((resolve) => setTimeout(resolve, 30));
    const kv = geoKv(world.now);
    const here = kv.location();
    const isolate = () => makeApp(world, { store: kvStore(() => /** @type {any} */ (here)) });
    const [first, second] = [isolate(), isolate()];
    const a = browser(first.app);
    await signIn(world, a);
    const b = browser(second.app);
    for (const [name, value] of a.jar) b.jar.set(name, value);
    await a.send('GET', 'api/config');
    await b.send('GET', 'api/config');
    const presses = await Promise.all([a, b].map((client) => client.postJson('api/checkout', { product: 'pro' })));
    const answers = await Promise.all(presses.map(async (response) => [response.status, await bodyOf(response)]));
    assert.deepEqual(answers.sort((x, y) => x[0] - y[0]), [[200, SESSION_1], [502, { error: 'upstream_unavailable' }]]);
    assert.equal(world.sessions.length, 1);
    assert.ok([...first.logs, ...second.logs].some((line) => line.message === 'kit (demo): checkout failed (Stripe 409 idempotency_key_in_use)'));
    assert.deepEqual(await bodyOf(await b.postJson('api/checkout', { product: 'pro' })), SESSION_1, 'pressed again: the first one made');
    // Paid, and back from Checkout before the webhook: refused in either isolate.
    world.clock += 90_000;
    world.pay('cs_test_1');
    world.clock += 3000;
    for (const client of [a, b]) assert.deepEqual(await bodyOf(await client.postJson('api/checkout', { product: 'pro' })), { error: 'payment_pending' });
    world.clock += 5000;
    const webhooks = browser(makeApp(world, { store: kvStore(() => /** @type {any} */ (kv.location())) }).app);
    assert.equal((await postWebhook(webhooks, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession(), id: 'cs_test_1' }))).status, 200);
    world.clock += 120_000;
    for (const client of [a, b]) assert.deepEqual(await bodyOf(await client.postJson('api/checkout', { product: 'pro' })), { error: 'already_owned' });
    assert.equal(world.sessions.length, 1, 'one Checkout Session, one payment');
  });

  test("a press that read no session before another isolate remembered one, and reaches Stripe after it was made, is given it; KV's one write a second to the marker refuses nothing then, and anything else is a 500", async () => {
    // Same sign-in: the same key, so Stripe gives the second press the first one's session, and
    // KV refuses its write of the marker (the first wrote it within the second), which already
    // names that session. Two sign-ins (another browser) read different states: their keys
    // differ, Stripe makes a second session, and the press whose marker write KV refuses, which
    // names the other session, is a 500 that hands its session to no one.
    for (const twoSignIns of [false, true]) {
      const world = createWorld();
      const door = holdFirstCheckout(world);
      const namespace = strictKv(world.now);
      const isolate = () => makeApp(world, { store: kvStore(() => /** @type {any} */ (namespace)) });
      const [first, second] = [isolate(), isolate()];
      const a = browser(first.app);
      await signIn(world, a);
      const b = browser(second.app);
      if (twoSignIns) {
        world.clock += 1000;
        await signIn(world, b);
      } else for (const [name, value] of a.jar) b.jar.set(name, value);
      await a.send('GET', 'api/config');
      await b.send('GET', 'api/config');
      const late = b.postJson('api/checkout', { product: 'pro' });
      await door.reached;
      world.clock += 2000;
      assert.deepEqual(await bodyOf(await a.postJson('api/checkout', { product: 'pro' })), SESSION_1);
      door.release();
      const answer = await within(late, 'the held press never answered');
      if (twoSignIns) {
        assert.deepEqual([answer.status, await bodyOf(answer)], [500, { error: 'internal' }], 'two sign-ins');
        assert.equal(world.sessions.length, 2, 'two sign-ins: a second session, handed to no one');
        assert.ok(second.logs.some((line) => line.message === 'kit (demo): POST failed (Error)'));
      } else {
        assert.deepEqual([answer.status, await bodyOf(answer)], [200, SESSION_1], 'one sign-in');
        assert.deepEqual([world.sessions.length, world.replays], [1, 1], 'one sign-in: one session, given back by Stripe');
      }
      assert.deepEqual(await kvStore(() => /** @type {any} */ (namespace)).get(MARKER), { id: 'cs_test_1', url: SESSION_1.url });
    }
  });

  test('on KV, presses in two locations that read the same within five minutes are given one session; either side of five minutes, each makes its own', async () => {
    // The press in V read no session and its call to Stripe was slow; the press in W, ten seconds
    // later, read none either (it had not been made) and made one. The five minutes the press is
    // handled in, not its moment, fix the request (expires_at included), so V's is W's request.
    const world = createWorld();
    const door = holdFirstCheckout(world);
    const kv = geoKv(world.now);
    const [v, w] = [kv.location(), kv.location()];
    /** @param {any} binding */
    const at = (binding) => browser(makeApp(world, { store: kvStore(() => binding) }).app);
    const [atV, atW] = [at(v), at(w)];
    await signIn(world, atV);
    for (const [name, value] of atV.jar) atW.jar.set(name, value);
    await atV.send('GET', 'api/config');
    await atW.send('GET', 'api/config');
    world.clock = T0 + 55_000;
    const late = atV.postJson('api/checkout', { product: 'pro' });
    await door.reached;
    world.clock = T0 + 65_000;
    assert.deepEqual(await bodyOf(await atW.postJson('api/checkout', { product: 'pro' })), SESSION_1);
    world.clock = T0 + 100_000;
    door.release();
    assert.deepEqual(await bodyOf(await within(late)), SESSION_1, 'within the five minutes: the same session');
    assert.deepEqual([world.sessions.length, world.replays], [1, 1]);
    assert.equal(world.sessions[0]?.get('expires_at'), String(T0 / 1000 + 3600), 'the window fixes expires_at');
    // Handled either side of the end of those five minutes, two presses send two requests.
    const next = holdFirstCheckout(world);
    const [atV2, atW2] = [at(v), at(w)];
    for (const [name, value] of atV.jar) {
      atV2.jar.set(name, value);
      atW2.jar.set(name, value);
    }
    await atV2.send('GET', 'api/config');
    await atW2.send('GET', 'api/config');
    world.clock = T0 + 299_000;
    const straddling = atV2.postJson('api/checkout', { product: 'monthly' });
    await next.reached;
    world.clock = T0 + 301_000;
    assert.deepEqual(await bodyOf(await atW2.postJson('api/checkout', { product: 'monthly' })), { url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
    next.release();
    assert.deepEqual(await bodyOf(await within(straddling)), { url: 'https://checkout.stripe.com/c/pay/cs_test_3' }, 'across five minutes: a session of its own');
    assert.deepEqual(world.sessions.map((form) => form.get('expires_at')), [T0 / 1000 + 3600, T0 / 1000 + 300 + 3600, T0 / 1000 + 3600].map(String));
  });

  test("a deleted account's next sign-in makes a new session: its first Buy does not share the key of a Buy made before the deletion", async () => {
    // Deletion lets go of the marker and the user record, so the first Buy after it reads what
    // the account's first Buy read; its sign-in is new, and the key names the sign-in. Shared,
    // Stripe gave back the session paid before the deletion, whose purchase record the deletion
    // removed: payment_pending for the 30 days its marker is kept.
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    assert.deepEqual(await bodyOf(await client.postJson('api/checkout', { product: 'pro' })), SESSION_1);
    world.pay();
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession(), id: 'cs_test_1' }));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    await signIn(world, client);
    const again = await client.postJson('api/checkout', { product: 'pro' });
    assert.deepEqual([again.status, await bodyOf(again)], [200, { url: 'https://checkout.stripe.com/c/pay/cs_test_2' }]);
    assert.deepEqual([world.sessions.length, world.replays], [2, 0]);
    assert.deepEqual(await bodyOf(await client.postJson('api/checkout', { product: 'pro' })), { url: 'https://checkout.stripe.com/c/pay/cs_test_2' }, 'and it is remembered');
  });
});

describe('the webhook', () => {
  test('grants on a paid checkout; me reports it', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = await owner(world, app);
    // The purchase record says who bought what it grants; the user record indexes it, with the
    // customer, under the key's mode.
    assert.deepEqual(await store.get('demo:test:payment:pi_test1'), { user: USER, product: 'pro', grants: 'pro' });
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['payment:pi_test1'], customer: 'cus_test1' });
    assert.deepEqual(world.unexpected, []);
    void client;
  });

  test('no header, a bad signature, an old or a future timestamp: 400 and nothing granted', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const event = stripeEvent(world, 'checkout.session.completed', paidSession());
    const payload = JSON.stringify(event);
    const now = Math.floor(world.clock / 1000);
    const bad = [
      { what: 'no header', header: null },
      { what: 'empty header', header: '' },
      { what: 'no t', header: `v1=${v1(payload, now)}` },
      { what: 'non-numeric t', header: `t=abc,v1=${v1(payload, now)}` },
      { what: 'two t', header: `t=${now},t=${now},v1=${v1(payload, now)}` },
      { what: 'no v1', header: `t=${now},v0=${v1(payload, now)}` },
      { what: 'wrong secret', header: `t=${now},v1=${v1(payload, now, `${WEBHOOK_SECRET}x`)}` },
      { what: 'signature over another t', header: `t=${now},v1=${v1(payload, now - 1)}` },
      { what: 'short v1', header: `t=${now},v1=${v1(payload, now).slice(0, 62)}` },
      { what: 'an old timestamp', header: `t=${now - 301},v1=${v1(payload, now - 301)}` },
      { what: 'a future timestamp', header: `t=${now + 301},v1=${v1(payload, now + 301)}` },
    ];
    for (const item of bad) {
      const response = await postWebhook(client, world, payload, { header: item.header });
      assert.equal(response.status, 400, item.what);
      assert.deepEqual(await bodyOf(response), { error: 'bad_request' });
      assertApiHeaders(response);
    }
    assert.deepEqual(await entitlementsOf(client), []);
    const edge = await postWebhook(client, world, payload, { t: now - 299 });
    assert.equal(edge.status, 200, 'inside the tolerance');
    assert.deepEqual(await entitlementsOf(client), ['pro']);
  });

  test('two v1 signatures, one of them right, in either order', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const now = Math.floor(world.clock / 1000);
    for (const order of [0, 1]) {
      const payload = JSON.stringify(stripeEvent(world, 'checkout.session.async_payment_failed', paidSession()));
      const right = v1(payload, now);
      const wrong = v1(payload, now, 'whsec_other');
      const pair = order === 0 ? `v1=${wrong},v1=${right}` : `v1=${right},v1=${wrong}`;
      assert.equal((await postWebhook(client, world, payload, { header: `t=${now},${pair},v0=${wrong}` })).status, 200, `order ${order}`);
    }
  });

  test('a valid signature over invalid JSON, or over something that is not an event, is a 400', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    for (const payload of ['{not json', '[]', '{"id":"evt_1","type":"x","livemode":false,"created":1}', JSON.stringify({ ...stripeEvent(world, 'x', {}), id: '../evil' })]) {
      assert.equal((await postWebhook(client, world, payload)).status, 400, payload);
    }
    assert.equal((await postWebhook(client, world, new Uint8Array([0x7b, 0xff, 0x7d]))).status, 400, 'malformed UTF-8');
  });

  test('a livemode that does not match the key is a 400', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const live = stripeEvent(world, 'checkout.session.completed', paidSession(), { livemode: true });
    assert.equal((await postWebhook(client, world, live)).status, 400);
    assert.deepEqual(await entitlementsOf(client), []);
    const liveWorld = createWorld();
    const liveApp = makeApp(liveWorld, { env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } }).app;
    const liveClient = browser(liveApp);
    await signIn(liveWorld, liveClient);
    assert.equal((await postWebhook(liveClient, liveWorld, stripeEvent(liveWorld, 'checkout.session.completed', paidSession()))).status, 400, 'a test event at a live key');
    assert.equal((await postWebhook(liveClient, liveWorld, stripeEvent(liveWorld, 'checkout.session.completed', paidSession(), { livemode: true }))).status, 200);
    assert.deepEqual(await entitlementsOf(liveClient), ['pro']);
  });

  test('a replayed event is acknowledged and not applied again', async () => {
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    let writes = 0;
    /** @type {import('./store.js').Store} */
    const counting = {
      get: (key) => inner.get(key),
      delete: async (key) => {
        writes += 1;
        return inner.delete(key);
      },
      put: async (key, value, options) => {
        writes += 1;
        return inner.put(key, value, options);
      },
    };
    const { app } = makeApp(world, { store: counting });
    const client = browser(app);
    await signIn(world, client);
    const completed = stripeEvent(world, 'checkout.session.completed', paidSession());
    assert.equal((await postWebhook(client, world, completed)).status, 200);
    assert.equal((await postWebhook(client, world, stripeEvent(world, 'charge.refunded', { object: 'charge', payment_intent: 'pi_test1', refunded: true, amount: 499, amount_refunded: 499 }))).status, 200);
    assert.deepEqual(await entitlementsOf(client), []);
    world.clock += 60_000;
    const before = writes;
    const replay = await postWebhook(client, world, completed);
    assert.equal(replay.status, 200);
    assert.equal(writes, before, 'the replay wrote nothing');
    assert.deepEqual(await entitlementsOf(client), [], 'the replay granted nothing');
  });

  test('the body cap holds with and without Content-Length', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    let pulled = 0;
    const declared = new ReadableStream(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const withLength = await app.handle(
      new Request(
        'https://shop.example/api/webhooks/stripe',
        streaming({ method: 'POST', headers: { 'content-length': String(512 * 1024 + 1), 'stripe-signature': 't=1,v1=00' }, body: declared }),
      ),
    );
    assert.equal(withLength.status, 413);
    assertApiHeaders(withLength);
    assert.equal(pulled, 0, 'refused before a byte was read');
    let sent = 0;
    const endless = new ReadableStream({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (sent >= 4 * 1024 * 1024) controller.close();
      },
    });
    const withoutLength = await app.handle(
      new Request('https://shop.example/api/webhooks/stripe', streaming({ method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: endless })),
    );
    assert.equal(withoutLength.status, 413);
    assert.ok(sent <= 512 * 1024 + 3 * 64 * 1024, `stopped reading near the cap (${sent} bytes)`);
    // Exactly at the cap is read, signature checked, and refused for not being an event.
    const atCap = 'x'.repeat(512 * 1024);
    assert.equal((await postWebhook(browser(app), world, atCap)).status, 400);
  });

  test('an unpaid checkout waits for the async payment; a failed one grants nothing', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ status: 'unpaid' })));
    assert.deepEqual(await entitlementsOf(client), []);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_failed', paidSession({ status: 'unpaid' })));
    assert.deepEqual(await entitlementsOf(client), []);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.async_payment_succeeded', paidSession({ status: 'paid' })));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
    // A free checkout (a 100% coupon) has no payment intent; it is recorded under the session.
    const free = browser(app);
    await signIn(world, free, { sub: '5005' });
    await postWebhook(free, world, stripeEvent(world, 'checkout.session.completed', paidSession({ user: 'google:5005', status: 'no_payment_required', pi: null })));
    assert.deepEqual(await entitlementsOf(free), ['pro']);
  });

  test('a full refund and a dispute revoke; a partial refund does not', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = await owner(world, app);
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', { object: 'charge', payment_intent: 'pi_test1', refunded: false, amount: 499, amount_refunded: 100 }));
    assert.deepEqual(await entitlementsOf(client), ['pro'], 'partial refund');
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', { object: 'charge', payment_intent: 'pi_test1', refunded: true, amount: 499, amount_refunded: 499 }));
    assert.deepEqual(await entitlementsOf(client), [], 'full refund');
    assert.deepEqual(await store.get('demo:test:payment:pi_test1'), { user: USER, product: 'pro', grants: 'pro', revoked: true });

    const disputed = browser(app);
    await signIn(world, disputed, { sub: '6006' });
    await postWebhook(disputed, world, stripeEvent(world, 'checkout.session.completed', paidSession({ user: 'google:6006', pi: 'pi_test6' })));
    assert.deepEqual(await entitlementsOf(disputed), ['pro']);
    await postWebhook(disputed, world, stripeEvent(world, 'charge.dispute.created', { object: 'dispute', payment_intent: 'pi_test6', charge: 'ch_test6' }));
    assert.deepEqual(await entitlementsOf(disputed), []);
  });

  test('a refund that arrives before the purchase means the purchase never grants', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', { object: 'charge', payment_intent: 'pi_test1', refunded: true, amount: 499, amount_refunded: 499 }));
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession()));
    assert.deepEqual(await entitlementsOf(client), []);
  });

  test('a refund of an older payment does not take back a newer one', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = await owner(world, app);
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', { object: 'charge', payment_intent: 'pi_test1', refunded: true, amount: 499, amount_refunded: 499 }));
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ pi: 'pi_test2' })));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
    await postWebhook(client, world, stripeEvent(world, 'charge.dispute.created', { object: 'dispute', payment_intent: 'pi_test1', charge: 'ch_1' }));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
  });

  test('a subscription grants while active or trialing, and a cancelled one revokes', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    assert.deepEqual(await entitlementsOf(client), ['supporter']);
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'past_due' })));
    assert.deepEqual(await entitlementsOf(client), []);
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'trialing' })));
    assert.deepEqual(await entitlementsOf(client), ['supporter']);
    world.clock += 1000;
    const cancelled = stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' }));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    assert.deepEqual(await entitlementsOf(client), ['supporter']);
    // An event older than the last one applied is acknowledged and ignored.
    assert.equal((await postWebhook(client, world, cancelled)).status, 200);
    assert.deepEqual(await entitlementsOf(client), ['supporter'], 'stale event ignored');
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    assert.deepEqual(await entitlementsOf(client), []);
    // A completion that arrives after the cancellation does not bring it back.
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    assert.deepEqual(await entitlementsOf(client), []);
  });

  test('events for another app, a foreign product, a malformed user or a mismatched reference grant nothing', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    const ignored = [
      paidSession({ app: 'other-app' }),
      paidSession({ product: 'unknown' }),
      paidSession({ product: '__proto__' }),
      paidSession({ user: 'google:../1001' }),
      paidSession({ user: 'github:1001' }),
      paidSession({ reference: 'google:9999' }),
      { ...paidSession(), mode: 'subscription' },
      { ...paidSession(), mode: 'setup', payment_status: 'no_payment_required' },
      { ...paidSession(), metadata: null },
    ];
    for (const session of ignored) {
      assert.equal((await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', session))).status, 200);
    }
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active', app: 'other-app' })));
    await postWebhook(client, world, stripeEvent(world, 'payment_intent.succeeded', { object: 'payment_intent', metadata: { app: 'demo', user: USER, product: 'pro' } }));
    assert.deepEqual(await entitlementsOf(client), []);
  });

  test('an entitlement two payments paid for survives the refund of one; a recovered subscription does not take over a purchase', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = await owner(world, app);
    // A second tab's Checkout Session, paid an hour later.
    world.clock += 3_600_000;
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ pi: 'pi_test2' })));
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', refund('pi_test2')));
    assert.deepEqual(await entitlementsOf(client), ['pro'], 'the first payment still pays for it');
    await postWebhook(client, world, stripeEvent(world, 'charge.dispute.created', { object: 'dispute', payment_intent: 'pi_test1', charge: 'ch_1' }));
    assert.deepEqual(await entitlementsOf(client), []);

    // Two products grant one entitlement: a subscription that lapses, a one-time purchase
    // meanwhile (its Checkout made before the lapse and paid after: Buy itself refuses it while
    // the lapsed subscription will still charge, VERIFY-17), then the subscription recovers and
    // is cancelled.
    const both = { ...CATALOGUE, products: [...CATALOGUE.products, { id: 'once', name: 'Once', description: 'Support once', mode: 'payment', grants: 'supporter' }] };
    const world2 = createWorld();
    const shop = makeApp(world2, { catalogue: both, env: { ...ENV, STRIPE_PRICE_ONCE: 'price_pro123' } });
    const visitor = browser(shop.app);
    await signIn(world2, visitor);
    await postWebhook(visitor, world2, stripeEvent(world2, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world2.clock += 1000;
    await postWebhook(visitor, world2, stripeEvent(world2, 'customer.subscription.updated', subscriptionObject({ status: 'past_due' })));
    assert.deepEqual(await entitlementsOf(visitor), []);
    const refused = await visitor.postJson('api/checkout', { product: 'once' });
    assert.deepEqual([refused.status, await bodyOf(refused)], [409, { error: 'subscription_active' }], 'a lapsed subscription that will still charge blocks buying what it grants');
    assert.equal(world2.sessions.length, 0);
    await postWebhook(visitor, world2, stripeEvent(world2, 'checkout.session.completed', paidSession({ product: 'once', pi: 'pi_once' })));
    world2.clock += 1000;
    await postWebhook(visitor, world2, stripeEvent(world2, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    world2.clock += 1000;
    await postWebhook(visitor, world2, stripeEvent(world2, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    assert.deepEqual(await entitlementsOf(visitor), ['supporter'], 'the one-time purchase was never refunded');
  });

  test('a cancelled subscription stays cancelled: an active update from the same second or later does not bring it back', async () => {
    const world = createWorld();
    const { app } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 5000;
    const second = Math.floor(world.clock / 1000);
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' }), { created: second }));
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' }), { created: second }));
    assert.deepEqual(await entitlementsOf(client), [], 'a tie goes to the revoke');
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' }), { created: second + 5 }));
    assert.deepEqual(await entitlementsOf(client), [], 'cancelled is final');
    // Not final: a lapse from the same second as a renewal wins whichever arrives second, and a
    // later renewal grants again.
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_test2', status: 'active' }), { created: second }));
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_test2', status: 'past_due' }), { created: second }));
    assert.deepEqual(await entitlementsOf(client), []);
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_test2', status: 'active' }), { created: second }));
    assert.deepEqual(await entitlementsOf(client), [], 'a renewal from the same second does not undo the lapse');
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ id: 'sub_test2', status: 'active' }), { created: second + 1 }));
    assert.deepEqual(await entitlementsOf(client), ['supporter']);
  });

  test('a reversal revokes what the payment granted, even once the product is no longer sold', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    await owner(world, app);
    const withoutPro = { ...CATALOGUE, products: CATALOGUE.products.filter((product) => product.id !== 'pro') };
    const env = { ...ENV };
    delete env.STRIPE_PRICE_PRO;
    const next = makeApp(world, { store, catalogue: withoutPro, env });
    const client = browser(next.app);
    await signIn(world, client);
    assert.deepEqual(await entitlementsOf(client), ['pro'], 'a purchase outlives its listing');
    await postWebhook(client, world, stripeEvent(world, 'charge.refunded', refund('pi_test1')));
    assert.deepEqual(await entitlementsOf(client), []);
    assert.deepEqual(await store.get('demo:test:payment:pi_test1'), { user: USER, product: 'pro', grants: 'pro', revoked: true }, 'still names its buyer');
  });

  test('test-mode purchases are not read under a live key, and a test customer is never sent to it', async () => {
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const testShop = makeApp(world, { store });
    await owner(world, testShop.app);
    const liveShop = makeApp(world, { store, env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } });
    const client = browser(liveShop.app);
    await signIn(world, client);
    assert.deepEqual(await entitlementsOf(client), [], 'a 4242 purchase is not a live one');
    assert.equal((await client.send('POST', 'api/portal')).status, 404, 'no live customer yet');
    assert.equal((await client.postJson('api/checkout', { product: 'pro' })).status, 200);
    const form = world.sessions.at(-1);
    assert.equal(form?.get('customer'), null);
    assert.equal(form?.get('customer_creation'), 'always');
  });

  test('two apps on one store keep apart: a purchase in one is not in the other, and each applies its own events', async () => {
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const demo = makeApp(world, { store });
    const other = makeApp(world, { store, catalogue: { ...CATALOGUE, app: 'other' } });
    const inDemo = browser(demo.app);
    const inOther = browser(other.app);
    await signIn(world, inDemo);
    await signIn(world, inOther);
    await postWebhook(inDemo, world, stripeEvent(world, 'checkout.session.completed', paidSession()));
    assert.deepEqual(await entitlementsOf(inDemo), ['pro']);
    assert.deepEqual(await entitlementsOf(inOther), []);
    // Stripe sends every event to every endpoint; the other app's reaches this one first.
    const theirs = stripeEvent(world, 'checkout.session.completed', paidSession({ app: 'other', pi: 'pi_other' }));
    assert.equal((await postWebhook(inDemo, world, theirs)).status, 200);
    assert.equal((await postWebhook(inOther, world, theirs)).status, 200);
    assert.deepEqual(await entitlementsOf(inOther), ['pro']);
    assert.deepEqual(await entitlementsOf(inDemo), ['pro']);
    assert.ok(store.keys().every((key) => /^(?:demo|other):/.test(key)), 'every key names its app');
  });

  test('on KV, a sign-in or sign-out within the minute neither undoes a revoke nor erases a grant', async () => {
    const world = createWorld();
    const kv = geoKv(world.now);
    const us = kv.location(); // where Stripe's webhooks land
    const eu = kv.location(); // where the visitor's requests land
    const webhooks = browser(makeApp(world, { store: kvStore(() => /** @type {any} */ (us)) }).app);
    const app = makeApp(world, { store: kvStore(() => /** @type {any} */ (eu)) }).app;

    // Cancel in the portal, come back, sign out, all within the minute.
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(webhooks, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 61_000;
    assert.deepEqual(await entitlementsOf(client), ['supporter']);
    assert.equal((await client.send('POST', 'api/portal')).status, 200);
    world.clock += 20_000;
    await postWebhook(webhooks, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    world.clock += 15_000;
    assert.equal((await client.send('POST', 'api/auth/logout')).status, 204);
    world.clock += 120_000;
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await entitlementsOf(again), [], 'the cancellation holds');

    // Pay, then sign in on a second device within the minute.
    const buyer = browser(app);
    await signIn(world, buyer, { sub: '7007' });
    assert.deepEqual(await entitlementsOf(buyer), []);
    await postWebhook(webhooks, world, stripeEvent(world, 'checkout.session.completed', paidSession({ user: 'google:7007', pi: 'pi_test7' })));
    world.clock += 5_000;
    await signIn(world, browser(app), { sub: '7007' });
    world.clock += 120_000;
    assert.deepEqual(await entitlementsOf(buyer), ['pro'], 'the grant holds');
  });

  test('on KV, signing in while the browser holds a session is one write to each key', async () => {
    const world = createWorld();
    const kv = strictKv(world.now);
    const { app } = makeApp(world, { store: kvStore(() => /** @type {any} */ (kv)) });
    const client = browser(app);
    await signIn(world, client);
    world.clock += 1000;
    const done = await signIn(world, client);
    assert.equal(done.headers.get('location'), 'https://shop.example/play');
    assert.deepEqual((await bodyOf(await client.send('GET', 'api/me'))).user, { email: 'ada@example.com' });
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession()));
    assert.deepEqual(await entitlementsOf(client), ['pro']);
    world.clock += 1000;
    assert.equal((await client.send('POST', 'api/auth/logout')).status, 204);
  });

  test('on KV, a webhook that adds nothing to the user record does not write it: webhooks for two purchases within a second all apply', async () => {
    // VERIFY-19. KV refuses a second write to a key within a second. A subscription's update adds
    // nothing to the user record its completion wrote; written anyway, it was refused (a 500, and
    // Stripe's retry later) whenever another purchase's webhook had just written that record.
    const world = createWorld();
    const kv = strictKv(world.now);
    const { app } = makeApp(world, { store: kvStore(() => /** @type {any} */ (kv)) });
    const client = browser(app);
    await signIn(world, client);
    world.clock += 1000;
    assert.equal((await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })))).status, 200);
    world.clock += 2000;
    assert.equal((await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession()))).status, 200);
    world.clock += 500;
    assert.equal((await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })))).status, 200, "the subscription's update, half a second after the payment's completion");
    assert.deepEqual(await entitlementsOf(client), ['pro', 'supporter']);
  });

  test('a store failure is a 500, so Stripe retries, and the retry applies', async () => {
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    let failing = false;
    /** @type {import('./store.js').Store} */
    const flaky = {
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
      put: async (key, value, options) => {
        if (failing && key.startsWith('demo:test:user:')) throw new Error('CANARY-store-down');
        return inner.put(key, value, options);
      },
    };
    const { app } = makeApp(world, { store: flaky });
    const client = browser(app);
    await signIn(world, client);
    const event = stripeEvent(world, 'checkout.session.completed', paidSession());
    failing = true;
    const failed = await postWebhook(client, world, event);
    assert.equal(failed.status, 500);
    assert.equal(await inner.get(`demo:test:event:${event.id}`), null, 'not marked processed');
    failing = false;
    assert.equal((await postWebhook(client, world, event)).status, 200);
    assert.deepEqual(await entitlementsOf(client), ['pro']);
  });
});

describe('deleting the account', () => {
  test('removes sessions, the user record and the purchase records; the next sign-in starts empty', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = await owner(world, app);
    const second = browser(app);
    await signIn(world, second);
    assert.equal((await client.postJson('api/checkout', { product: 'monthly' })).status, 200);
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    assert.ok(!client.jar.has('__Host-demo-session'));
    assert.deepEqual(await bodyOf(await second.send('GET', 'api/me')), { user: null, entitlements: [] }, 'every session ended');
    const left = store.keys();
    for (const key of left) {
      const text = `${key} ${JSON.stringify(await store.get(key))}`;
      if (text.includes('1001') || text.includes('ada@example.com')) assert.match(key, /^demo:test:ratelimit:/, `${key} is left behind`);
    }
    assert.ok(left.every((/** @type {string} */ key) => !/^demo:(?:session|sessions|(?:live|test):(?:user|payment)):/.test(key)), left.join(' '));
    assert.equal((await browser(app).send('DELETE', 'api/me')).status, 401);
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await bodyOf(await again.send('GET', 'api/me')), { user: { email: 'ada@example.com' }, entitlements: [] });
  });
});

describe('deleting the account, with a subscription', () => {
  for (const flight of ['set to end, the event that allows the deletion', 'a later update, still set to end', "its checkout's delayed payment, reported after the set to end"]) {
    test(`a webhook about the subscription handled while Delete account runs does not write the account back (${flight})`, async () => {
      // VERIFY-13, one process. Delete account is held at its first read (the live-mode user
      // record, which a test-mode webhook never reads) until the webhook has written the
      // subscription's record. Before, the webhook then waited, inside that record's lock, for
      // the user record's, and wrote the user record back (Google id, Stripe customer) after the
      // deletion had removed it, for good.
      const world = createWorld();
      const inner = createMemoryStore({ now: world.now });
      const gated = gatedStore(inner);
      const { app } = makeApp(world, { store: gated.store });
      const client = browser(app);
      await signIn(world, client);
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
      world.clock += 1000;
      if (flight.startsWith('a later')) {
        await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
        world.clock += 1000;
      }
      if (flight.startsWith('its checkout')) {
        await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
        world.clock += 1000;
      }
      const event = flight.startsWith('its checkout')
        ? stripeEvent(world, 'checkout.session.async_payment_succeeded', paidSession({ mode: 'subscription' }))
        : stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true });
      gated.hold('get', `demo:live:user:${USER}`, gated.seen('put', 'demo:test:subscription:sub_test1'));
      const [deleted, hook] = await within(Promise.all([client.send('DELETE', 'api/me'), postWebhook(browser(app), world, event)]));
      assert.deepEqual([deleted.status, hook.status], [204, 200]);
      assert.equal(await inner.get(`demo:test:user:${USER}`), null, 'the user record stays deleted');
      const at = Math.floor(world.clock / 1000);
      const eventAt = flight.startsWith('its checkout') ? at - 1 : at;
      assert.deepEqual(await inner.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt, ending: true, deletedAt: at });
      world.clock += 400 * 86_400_000;
      for (const key of inner.keys()) assert.ok(!/1001|cus_test1/.test(`${key} ${JSON.stringify(await inner.get(key))}`), `${key} names the account`);
    });
  }

  test('a webhook that read the subscription before Delete account rewrote it is applied wholly first: the deletion takes the record\'s lock', async () => {
    // The webhook has read the subscription and its write is held until Delete account has
    // rewritten that record (or 100 ms, which is how long Delete account then waits for the
    // record's lock). Without the lock the deletion rewrote it naming no one between the
    // webhook's read and its write, the webhook's write named the account again, and its addRef,
    // finding the record naming the account, wrote the user record back.
    const world = createWorld();
    const inner = createMemoryStore({ now: world.now });
    const gated = gatedStore(inner);
    const { app } = makeApp(world, { store: gated.store });
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    world.clock += 1000;
    const event = stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true });
    const rewritten = gated.seen('put', 'demo:test:subscription:sub_test1');
    const orLater = new Promise((resolve) => setTimeout(resolve, 100));
    gated.hold('put', 'demo:test:subscription:sub_test1', Promise.race([rewritten, orLater]));
    const reading = gated.seen('get', 'demo:test:subscription:sub_test1');
    const hook = postWebhook(browser(app), world, event);
    await reading;
    const [deleted, hooked] = await within(Promise.all([client.send('DELETE', 'api/me'), hook]));
    assert.deepEqual([deleted.status, hooked.status], [204, 200]);
    assert.equal(await inner.get(`demo:test:user:${USER}`), null);
    const at = Math.floor(world.clock / 1000);
    assert.deepEqual(await inner.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: at, ending: true, deletedAt: at });
  });

  test('a Buy under way while the account is deleted leaves no session remembered for it', async () => {
    // Delete account takes the markers' locks first, so it waits for a Checkout being made and
    // then lets it go; without them the marker was written after the deletion, naming the account.
    const world = createWorld();
    /** @type {() => void} */
    let reached = () => {};
    const atStripe = new Promise((resolve) => {
      reached = () => resolve(undefined);
    });
    /** @type {Promise<unknown>} */
    let gate = Promise.resolve();
    const outbound = world.fetch;
    world.fetch = async (url, init) => {
      if (url === 'https://api.stripe.com/v1/checkout/sessions' && init?.method === 'POST') {
        reached();
        await gate;
      }
      return outbound(url, init);
    };
    const inner = createMemoryStore({ now: world.now });
    const gated = gatedStore(inner);
    const { app } = makeApp(world, { store: gated.store });
    const client = browser(app);
    await signIn(world, client);
    /** @type {() => void} */
    let answered = () => {};
    gate = Promise.race([new Promise((resolve) => (answered = () => resolve(undefined))), new Promise((resolve) => setTimeout(resolve, 100))]);
    const buy = client.postJson('api/checkout', { product: 'pro' });
    await atStripe;
    // Stripe answers once the deletion has (or after 100 ms, which is how long the deletion
    // waits for the marker's lock): without that lock the marker was written after it.
    const deletion = client.send('DELETE', 'api/me').finally(() => answered());
    const [bought, deleted] = await within(Promise.all([buy, deletion]));
    assert.deepEqual([bought.status, deleted.status], [200, 204]);
    for (const key of inner.keys()) {
      if (/^demo:test:ratelimit:/.test(key)) continue;
      assert.ok(!key.includes('1001'), `${key} outlives the account`);
    }
  });

  test("a subscription's record that names its account goes 30 days after the subscription ends, as one naming no one does", async () => {
    // So a record written back after a deletion (KV, two locations: see the README's Limits)
    // does not keep the account's Google id and Stripe customer for good.
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_test1')).user, USER);
    world.clock += 29 * 86_400_000;
    assert.notEqual(await store.get('demo:test:subscription:sub_test1'), null, 'kept while Stripe may resend an older event');
    world.clock += 2 * 86_400_000;
    assert.equal(await store.get('demo:test:subscription:sub_test1'), null);
    // The user record still lists it, which costs nothing: it reads as nothing held, and the
    // account can still go.
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await entitlementsOf(again), []);
    assert.equal((await again.send('DELETE', 'api/me')).status, 204);
    // A completion that arrives after the cancellation keeps it over, and bounded too.
    const late = makeApp(world);
    const visitor = browser(late.app);
    await signIn(world, visitor);
    await postWebhook(visitor, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled', id: 'sub_test2' })));
    await postWebhook(visitor, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription', sub: 'sub_test2' })));
    assert.equal(/** @type {any} */ (await late.store.get('demo:test:subscription:sub_test2')).status, 'canceled');
    world.clock += 31 * 86_400_000;
    assert.equal(await late.store.get('demo:test:subscription:sub_test2'), null);
  });

  test('on a namespace Preview and Production share, Preview refuses Delete account for a live subscription and has no portal for it; Production reaches it', async () => {
    // VERIFY-15 pins what the README says of this case: the subscription is cancelled from the
    // deployment whose key is of its mode.
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const production = makeApp(world, { store, env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } });
    const preview = makeApp(world, { store });
    const live = browser(production.app);
    await signIn(world, live);
    await postWebhook(live, world, stripeEvent(world, 'checkout.session.completed', { ...paidSession({ mode: 'subscription', customer: 'cus_live1' }), livemode: true }, { livemode: true }));
    const onPreview = browser(preview.app);
    await signIn(world, onPreview);
    assert.deepEqual(await bodyOf(await onPreview.send('DELETE', 'api/me')), { error: 'subscription_active' });
    assert.equal((await onPreview.send('POST', 'api/portal')).status, 404);
    assert.equal((await live.send('POST', 'api/portal')).status, 200);
    assert.equal(world.portals.at(-1)?.get('customer'), 'cus_live1');
  });

  test('a subscription that will charge again must be cancelled first: 409, and nothing is deleted', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    for (const status of [null, 'active', 'past_due']) {
      if (status) {
        world.clock += 1000;
        await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status })));
      }
      const refused = await client.send('DELETE', 'api/me');
      assert.equal(refused.status, 409, String(status));
      assert.deepEqual(await bodyOf(refused), { error: 'subscription_active' });
    }
    assert.ok(client.jar.has('__Host-demo-session'), 'still signed in');
    assert.equal((await client.send('POST', 'api/portal')).status, 200, 'and Manage subscription still works');
    // Cancelled at the end of the period: no further charge, so the account may go.
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    assert.deepEqual(await entitlementsOf(client), ['supporter'], 'paid to the end of the period');
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    assert.equal(await store.get(`demo:test:user:${USER}`), null);
    const kept = /** @type {any} */ (await store.get('demo:test:subscription:sub_test1'));
    assert.deepEqual(kept, { status: 'active', eventAt: Math.floor(world.clock / 1000), ending: true, deletedAt: Math.floor(world.clock / 1000) }, 'its state, naming no one');
    // The period ends; nothing comes back to the deleted account.
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_test1')).user, undefined);
    assert.equal(await store.get(`demo:test:user:${USER}`), null);
  });

  test('a cancelled subscription is remembered past deletion: Stripe\'s retry of an older update grants nothing', async () => {
    const world = createWorld();
    const { app, store } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    const update = stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })); // its delivery fails; Stripe retries later
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    assert.equal((await postWebhook(client, world, update)).status, 200);
    assert.equal(await store.get(`demo:test:user:${USER}`), null, 'no record is made again');
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await entitlementsOf(again), []);
  });

  test('deletion is refused while a subscription charges in either Stripe mode, since it deletes both', async () => {
    // Preview (a test key) and Production (a live key) on one namespace: deleting the account
    // on Preview deletes the live records too, so a live subscription still charging refuses it.
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const live = makeApp(world, { store, env: { ...ENV, STRIPE_SECRET_KEY: LIVE_KEY } }).app;
    const preview = makeApp(world, { store }).app;
    const liveClient = browser(live);
    await signIn(world, liveClient);
    await postWebhook(liveClient, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' }), { livemode: true }));
    world.clock += 1000;
    await postWebhook(liveClient, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' }), { livemode: true }));
    const previewClient = browser(preview);
    await signIn(world, previewClient);
    await postWebhook(previewClient, world, stripeEvent(world, 'checkout.session.completed', paidSession()));
    const refused = await previewClient.send('DELETE', 'api/me');
    assert.equal(refused.status, 409);
    assert.deepEqual(await bodyOf(refused), { error: 'subscription_active' });
    assert.deepEqual(await entitlementsOf(liveClient), ['supporter'], 'nothing deleted in the live mode');
    assert.equal((await liveClient.send('POST', 'api/portal')).status, 200, 'and Manage subscription still works there');
    assert.deepEqual(await entitlementsOf(previewClient), ['pro'], 'nothing deleted in the test mode');
    // Cancelled at the end of the period on Production: the account may go, from either.
    world.clock += 1000;
    await postWebhook(liveClient, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }, { livemode: true }));
    assert.equal((await previewClient.send('DELETE', 'api/me')).status, 204);
    for (const mode of ['live', 'test']) assert.equal(await store.get(`demo:${mode}:user:${USER}`), null, mode);
    assert.equal(await store.get('demo:test:payment:pi_test1'), null);
    assert.deepEqual(await store.get('demo:live:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), ending: true, deletedAt: Math.floor(world.clock / 1000) });
  });

  test('a subscription set to end with its period is remembered until it ends, however long that is, and 30 days after', async () => {
    // A yearly plan cancelled at the period's end can run on for most of a year after the
    // account is deleted. Its last event must still find its state naming no one, not a gap
    // that lets the event's metadata write the deleted account back.
    for (const midway of [false, true]) {
      const world = createWorld();
      const { app, store } = makeApp(world);
      const client = browser(app);
      await signIn(world, client);
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
      const deletedAt = Math.floor(world.clock / 1000);
      assert.equal((await client.send('DELETE', 'api/me')).status, 204);
      if (midway) {
        // An update while it runs (a changed card, say) keeps it so as well.
        world.clock += 200 * 86_400_000;
        await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
        assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), ending: true, deletedAt }, 'midway');
      }
      world.clock = T0 + 366 * 86_400_000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', subscriptionObject({ status: 'canceled' })));
      assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'canceled', eventAt: Math.floor(world.clock / 1000), deletedAt }, `its end, naming no one (midway: ${midway})`);
      for (const key of store.keys()) assert.ok(!`${key} ${JSON.stringify(await store.get(key))}`.includes('1001'), `${key} names the deleted account (midway: ${midway})`);
      // Over now: Stripe resends events for 30 days at most, and the state goes after that.
      world.clock += 31 * 86_400_000;
      assert.equal(await store.get('demo:test:subscription:sub_test1'), null);
    }
  });

  test('a subscription renewed after its account was deleted is the visitor\'s again: it grants, Manage subscription reaches it, a second is not sold', async () => {
    // Deletion is allowed once a subscription is set to end with its period, and the portal tab
    // the visitor cancelled in offers Renew until then (so can the owner, at their request).
    // Renewed, it charges again: it must not charge someone the site no longer knows.
    const world = createWorld();
    const { app, store, logs } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    const deletedAt = Math.floor(world.clock / 1000);
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    // An update from the same second as the one that set it to end: their order is not known.
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), deletedAt }, 'the same second names no one');
    assert.equal(await store.get(`demo:test:user:${USER}`), null);
    // Set to end again after the deletion, and an update from that same second that says it
    // will charge: their order is not known either.
    world.clock += 30_000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), deletedAt }, 'the same second as the last state names no one');
    assert.equal(await store.get(`demo:test:user:${USER}`), null);
    // Renewed a minute later.
    world.clock += 60_000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { user: USER, product: 'monthly', grants: 'supporter', customer: 'cus_test1', status: 'active', eventAt: Math.floor(world.clock / 1000) });
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['subscription:sub_test1'], customer: 'cus_test1' });
    // A month on it charges again; the same Google account signs in.
    world.clock += 30 * 86_400_000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await entitlementsOf(again), ['supporter']);
    assert.equal((await again.send('POST', 'api/portal')).status, 200, 'Manage subscription reaches it');
    assert.equal((await again.postJson('api/checkout', { product: 'monthly' })).status, 409, 'a second one is not sold');
    assert.equal((await again.send('DELETE', 'api/me')).status, 409, 'and it is cancelled before the account goes again');
    // The two same-second updates said it would charge and were not taken as renewals: the owner
    // was told of each. The renewal and its next period say nothing.
    assert.deepEqual(logs.filter((line) => line.message.includes('sub_test1')), [
      { level: 'warn', message: MAY_CHARGE('sub_test1') },
      { level: 'warn', message: MAY_CHARGE('sub_test1') },
    ]);
  });

  test('events from before the deletion, delivered after it in any order, never write the account back; the owner is told', async () => {
    // Set to end, then (with the webhook endpoint down) renewed in the portal, set to end again,
    // and the account deleted: the kit held the first "set to end", so deletion was allowed.
    // Stripe retries the two late events afterwards, oldest first or not.
    for (const order of ['oldest first', 'newest first']) {
      const world = createWorld();
      const { app, store, logs } = makeApp(world);
      const client = browser(app);
      await signIn(world, client);
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
      world.clock += 60_000;
      const renewed = stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: false });
      world.clock += 60_000;
      const ending = stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true });
      world.clock += 60_000;
      const deletedAt = Math.floor(world.clock / 1000);
      assert.equal((await client.send('DELETE', 'api/me')).status, 204, order);
      world.clock += 3_600_000;
      const late = order === 'oldest first' ? [renewed, ending] : [ending, renewed];
      for (const event of late) {
        assert.equal((await postWebhook(client, world, event)).status, 200, order);
        assert.equal(await store.get(`demo:test:user:${USER}`), null, `${order}: no user record`);
        assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_test1')).user, undefined, `${order}: names no one`);
      }
      assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: ending.created, ending: true, deletedAt }, order);
      assert.deepEqual(
        logs.filter((line) => line.message.includes('sub_test1')),
        order === 'oldest first' ? [{ level: 'warn', message: MAY_CHARGE('sub_test1') }] : [],
        `${order}: the renewal is logged when it is applied, and an older one is not applied`,
      );
      // The same Google account signs in again: nothing is theirs.
      const again = browser(app);
      await signIn(world, again);
      assert.deepEqual(await entitlementsOf(again), [], order);
      assert.equal((await again.send('POST', 'api/portal')).status, 404, order);
      // The period ends; a year on, nothing names the account.
      world.clock += 30 * 86_400_000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.deleted', { ...subscriptionObject({ status: 'canceled' }), cancel_at_period_end: true }));
      assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'canceled', eventAt: Math.floor(world.clock / 1000), ending: true, deletedAt }, order);
      world.clock += 365 * 86_400_000;
      assert.equal(await store.get('demo:test:subscription:sub_test1'), null, order);
      for (const key of store.keys()) assert.ok(!`${key} ${JSON.stringify(await store.get(key))}`.includes('1001'), `${order}: ${key} names the deleted account`);
    }
  });

  test('a renewal from before the deletion that nothing set to end again is logged, and its next period, after the deletion, makes it the visitor\'s again', async () => {
    const world = createWorld();
    const { app, store, logs } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    world.clock += 60_000;
    const early = stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' }));
    world.clock += 60_000;
    const deletedAt = Math.floor(world.clock / 1000);
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    // Renewed in the very second of the deletion: which came first is not known.
    const sameSecond = stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' }));
    world.clock += 3_600_000;
    for (const event of [early, sameSecond]) {
      assert.equal((await postWebhook(client, world, event)).status, 200);
      assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: event.created, deletedAt });
      assert.equal(await store.get(`demo:test:user:${USER}`), null);
    }
    assert.deepEqual(logs.filter((line) => line.message.includes('sub_test1')), [
      { level: 'warn', message: MAY_CHARGE('sub_test1') },
      { level: 'warn', message: MAY_CHARGE('sub_test1') },
    ]);
    // It does charge again: the next period's update is from after the deletion.
    world.clock += 30 * 86_400_000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', subscriptionObject({ status: 'active' })));
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { user: USER, product: 'monthly', grants: 'supporter', customer: 'cus_test1', status: 'active', eventAt: Math.floor(world.clock / 1000) });
    assert.deepEqual(await store.get(`demo:test:user:${USER}`), { refs: ['subscription:sub_test1'], customer: 'cus_test1' });
    const again = browser(app);
    await signIn(world, again);
    assert.deepEqual(await entitlementsOf(again), ['supporter']);
    assert.equal((await again.send('POST', 'api/portal')).status, 200, 'Manage subscription reaches it');
    assert.equal(world.portals.at(-1)?.get('customer'), 'cus_test1');
    assert.equal(logs.filter((line) => line.message.includes('sub_test1')).length, 2, 'the renewal itself says nothing');
  });

  test('a deleted account\'s subscription given an end date in the dashboard is not renewed by it', async () => {
    // Cancelling "on a custom date" clears cancel_at_period_end and sets cancel_at: an owner
    // acting on a deletion request must not write the account back by doing so.
    const world = createWorld();
    const { app, store, logs } = makeApp(world);
    const client = browser(app);
    await signIn(world, client);
    await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
    const deletedAt = Math.floor(world.clock / 1000);
    assert.equal((await client.send('DELETE', 'api/me')).status, 204);
    world.clock += 86_400_000;
    const cancelAt = Math.floor(world.clock / 1000) + 10 * 86_400;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: false, cancel_at: cancelAt }));
    assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), deletedAt });
    assert.equal(await store.get(`demo:test:user:${USER}`), null);
    assert.deepEqual(logs.filter((line) => line.message.includes('sub_test1')), [{ level: 'warn', message: MAY_CHARGE('sub_test1') }]);
    // Renewed after that (the date taken off again): the visitor's.
    world.clock += 1000;
    await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: false, cancel_at: null }));
    assert.equal(/** @type {any} */ (await store.get('demo:test:subscription:sub_test1')).user, USER);
  });

  test('a renewal of a deleted account\'s subscription that names nothing the app sells stays nameless, and is logged', async () => {
    // Its metadata edited in the dashboard, or its product taken out of the catalogue: it charges
    // and nothing can be granted, so the owner is told which subscription to cancel or refund.
    const without = { ...CATALOGUE, products: CATALOGUE.products.filter((product) => product.id !== 'monthly') };
    for (const variant of ['metadata', 'catalogue']) {
      const world = createWorld();
      const { app, store } = makeApp(world);
      const client = browser(app);
      await signIn(world, client);
      await postWebhook(client, world, stripeEvent(world, 'checkout.session.completed', paidSession({ mode: 'subscription' })));
      world.clock += 1000;
      await postWebhook(client, world, stripeEvent(world, 'customer.subscription.updated', { ...subscriptionObject({ status: 'active' }), cancel_at_period_end: true }));
      const deletedAt = Math.floor(world.clock / 1000);
      assert.equal((await client.send('DELETE', 'api/me')).status, 204);
      world.clock += 60_000;
      const after = makeApp(world, { store, ...(variant === 'catalogue' ? { catalogue: without } : {}) });
      const renewal = { ...subscriptionObject({ status: 'active' }), ...(variant === 'metadata' ? { metadata: {} } : {}) };
      assert.equal((await postWebhook(browser(after.app), world, stripeEvent(world, 'customer.subscription.updated', renewal))).status, 200, variant);
      assert.deepEqual(await store.get('demo:test:subscription:sub_test1'), { status: 'active', eventAt: Math.floor(world.clock / 1000), deletedAt }, variant);
      assert.equal(await store.get(`demo:test:user:${USER}`), null, variant);
      assert.deepEqual(
        after.logs.filter((line) => line.message.includes('sub_test1')),
        [{ level: 'warn', message: 'kit (demo): subscription sub_test1 of a deleted account will charge again, and its metadata names nothing this app sells: cancel or refund it in the Stripe dashboard' }],
        variant,
      );
      // Set to end again: nothing to tell.
      world.clock += 1000;
      await postWebhook(browser(after.app), world, stripeEvent(world, 'customer.subscription.updated', { ...renewal, cancel_at_period_end: true }));
      assert.equal(after.logs.filter((line) => line.message.includes('sub_test1')).length, 1, variant);
    }
  });
});

describe('stores', () => {
  test('the memory store copies values, expires them and refuses keys KV would refuse', async () => {
    const world = createWorld();
    const store = createMemoryStore({ now: world.now });
    const value = { a: [1, 2] };
    await store.put('k', value);
    value.a.push(3);
    assert.deepEqual(await store.get('k'), { a: [1, 2] });
    await store.put('t', 1, { ttl: 10 });
    world.clock += 59_000;
    assert.equal(await store.get('t'), 1, 'a ttl under 60 s is raised to 60');
    world.clock += 2_000;
    assert.equal(await store.get('t'), null);
    await assert.rejects(store.put('x'.repeat(513), 1), TypeError);
    await assert.rejects(store.put('', 1), TypeError);
    await assert.rejects(store.put('u', undefined), TypeError);
  });

  test('file store: keys never become paths, writes are atomic, expired files are swept', async () => {
    const world = createWorld();
    const parent = await mkdtemp(join(tmpdir(), 'kit-selftest-'));
    try {
      const dir = join(parent, 'store');
      const store = createFileStore(dir, { now: world.now });
      const keys = ['../escape', '../../etc/passwd', '..\\..\\windows', 'a/b/c', '/absolute/path', 'session:../../x', '.', '..', 'user:google:1001'];
      for (const key of keys) await store.put(key, { key });
      assert.deepEqual(await readdir(parent), ['store'], 'nothing written beside the store');
      const names = await readdir(dir);
      assert.equal(names.length, keys.length);
      for (const name of names) assert.match(name, /^[0-9a-f]{64}\.json$/);
      for (const key of keys) {
        assert.deepEqual(await store.get(key), { key });
        assert.equal(store.fileOf(key), join(dir, `${createHash('sha256').update(key).digest('hex')}.json`));
      }
      await store.put('../escape', { key: 'second' });
      assert.deepEqual(await store.get('../escape'), { key: 'second' });
      assert.ok((await readdir(dir)).every((name) => !name.endsWith('.tmp')), 'no temporary file left');
      await store.delete('../escape');
      await store.delete('../escape');
      assert.equal(await store.get('../escape'), null);
      await store.put('brief', 1, { ttl: 60 });
      world.clock += 61_000;
      assert.equal(await store.get('brief'), null);
      assert.equal(await store.sweep(), 1);
      assert.equal((await readdir(dir)).length, keys.length - 1);
      await assert.rejects(store.put('x'.repeat(513), 1), TypeError);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('file store: a reader never sees half a write', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-atomic-'));
    try {
      const store = createFileStore(parent);
      const a = { fill: 'a'.repeat(512 * 1024) };
      const b = { fill: 'b'.repeat(512 * 1024) };
      await store.put('k', a);
      /** @type {Promise<unknown>[]} */
      const reads = [];
      /** @type {Promise<void>[]} */
      const writes = [];
      for (let i = 0; i < 40; i += 1) {
        writes.push(store.put('k', i % 2 ? a : b));
        for (let j = 0; j < 3; j += 1) reads.push(store.get('k'));
      }
      await Promise.all(writes);
      for (const value of await Promise.all(reads)) {
        assert.ok(value !== null && (/** @type {any} */ (value).fill === a.fill || /** @type {any} */ (value).fill === b.fill), 'a whole value, old or new');
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('file store: a write replaces the file, so a reader holding the old one still reads it whole', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-replace-'));
    try {
      const store = createFileStore(parent);
      const a = { fill: 'a'.repeat(256 * 1024) };
      await store.put('k', a);
      const file = store.fileOf('k');
      const before = await stat(file);
      const reader = await open(file, 'r');
      try {
        await store.put('k', { fill: 'b' });
        const after = await stat(file);
        assert.notEqual(after.ino, before.ino, 'a new file was renamed into place');
        assert.equal(JSON.parse(await reader.readFile('utf8')).value.fill, a.fill, 'the old file was never written to');
      } finally {
        await reader.close();
      }
      assert.deepEqual(await store.get('k'), { fill: 'b' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('file store: each write is flushed to the disk, the file and then its directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-sync-'));
    const probe = await open(join(parent, 'probe'), 'w');
    const proto = /** @type {any} */ (Object.getPrototypeOf(probe));
    await probe.close();
    const original = proto.sync;
    let syncs = 0;
    proto.sync = function sync(/** @type {unknown[]} */ ...args) {
      syncs += 1;
      return original.apply(this, args);
    };
    try {
      const store = createFileStore(join(parent, 'data'));
      await store.put('k', { v: 1 });
      assert.equal(syncs, process.platform === 'win32' ? 1 : 2);
    } finally {
      proto.sync = original;
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('file store: the directory is 0700 and its files 0600; a sweep leaves a write in progress alone', { skip: process.platform === 'win32' }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-modes-'));
    try {
      const dir = join(parent, 'data');
      const store = createFileStore(dir);
      await store.put('k', 1);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(store.fileOf('k'))).mode & 0o777, 0o600);
      // A temporary file is a write in progress until it is an hour old.
      const fresh = `${store.fileOf('k')}.0000000000000000.tmp`;
      const stale = `${store.fileOf('k')}.1111111111111111.tmp`;
      await writeFile(fresh, '{');
      await writeFile(stale, '{');
      const hoursAgo = new Date(Date.now() - 2 * 3_600_000);
      await utimes(stale, hoursAgo, hoursAgo);
      assert.equal(await store.sweep(), 1);
      const names = await readdir(dir);
      assert.ok(names.some((name) => fresh.endsWith(name)) && !names.some((name) => stale.endsWith(name)));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('file store: two keys that share a file name are still two keys', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-alias-'));
    try {
      const store = createFileStore(parent);
      // A lone surrogate is written to UTF-8 as U+FFFD, so both keys hash to one file.
      assert.equal(store.fileOf('\ud800'), store.fileOf('\ufffd'));
      await store.put('\ud800', 1);
      assert.equal(await store.get('\ufffd'), null);
      assert.equal(await store.get('\ud800'), 1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('the KV store writes JSON with an expirationTtl of at least 60 seconds', async () => {
    /** @type {Map<string, string>} */
    const data = new Map();
    /** @type {unknown[]} */
    const puts = [];
    const kv = {
      /** @param {string} key @param {'json'} type */
      get: async (key, type) => {
        assert.equal(type, 'json');
        const text = data.get(key);
        return text === undefined ? null : JSON.parse(text);
      },
      /** @param {string} key @param {string} value @param {{ expirationTtl?: number }} [options] */
      put: async (key, value, options) => {
        assert.equal(typeof value, 'string');
        if (options?.expirationTtl !== undefined) assert.ok(options.expirationTtl >= 60);
        puts.push(options);
        data.set(key, value);
      },
      /** @param {string} key */
      delete: async (key) => {
        data.delete(key);
      },
    };
    const store = kvStore(() => kv);
    await store.put('a', { b: 1 }, { ttl: 5 });
    await store.put('c', 2);
    assert.deepEqual(puts, [{ expirationTtl: 60 }, undefined]);
    assert.deepEqual(await store.get('a'), { b: 1 });
    assert.equal(await store.get('missing'), null);
    await store.delete('a');
    assert.equal(await store.get('a'), null);
  });
});

describe('adapters', () => {
  test('Cloudflare Pages: env and the KIT_STORE binding; off without the binding', async () => {
    const world = createWorld();
    world.clock = Date.now(); // pagesHandler keeps real time, so the fake Google must too
    /** @type {Map<string, string>} */
    const data = new Map();
    const kv = {
      /** @param {string} key */
      get: async (key) => (data.has(key) ? JSON.parse(data.get(key) ?? 'null') : null),
      /** @param {string} key @param {string} value @param {{ expirationTtl?: number }} [options] */
      put: async (key, value, options) => {
        if (options?.expirationTtl !== undefined) assert.ok(options.expirationTtl >= 60);
        data.set(key, value);
      },
      /** @param {string} key */
      delete: async (key) => {
        data.delete(key);
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (world.fetch));
    const originalWarn = console.warn;
    /** @type {string[]} */
    const warned = [];
    console.warn = (message) => warned.push(String(message));
    try {
      const onRequest = pagesHandler(CATALOGUE);
      const off = await onRequest({ request: new Request(`${APP_URL}api/config`), env: { ...ENV } });
      assert.deepEqual(await bodyOf(off), { auth: { google: false }, shop: { products: [] } });
      assert.ok(warned.some((line) => line.includes('KIT_STORE')));
      const on = await onRequest({ request: new Request(`${APP_URL}api/config`), env: { ...ENV, KIT_STORE: kv } });
      assert.equal((await bodyOf(on)).auth.google, true);
      const client = browser({ handle: (request) => onRequest({ request, env: { ...ENV, KIT_STORE: kv } }) });
      await signIn(world, client);
      assert.equal((await bodyOf(await client.send('GET', 'api/me'))).user.email, 'ada@example.com');
      assert.ok([...data.keys()].some((key) => key.startsWith('demo:session:')));
      // A changed price variable is a new configuration: the app is rebuilt and reads it.
      world.prices.set('price_pro456', { id: 'price_pro456', object: 'price', active: true, currency: 'eur', unit_amount: 999, recurring: null });
      const repriced = await onRequest({ request: new Request(`${APP_URL}api/config`), env: { ...ENV, STRIPE_PRICE_PRO: 'price_pro456', KIT_STORE: kv } });
      assert.equal((await bodyOf(repriced)).shop.products.find((/** @type {any} */ p) => p.id === 'pro')?.price.unit_amount, 999);
      assert.throws(() => pagesHandler({ app: 'Bad' }), TypeError);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  test("Cloudflare Pages: config hands a price lookup it did not wait for to the context's waitUntil", async () => {
    const world = createWorld();
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (
      /** @type {unknown} */ (
        /** @param {string} url @param {RequestInit} [init] */
        async (url, init) => {
          if (url.endsWith('/prices/price_pro123')) await held;
          return world.fetch(url, init);
        }
      )
    );
    const originalWarn = console.warn;
    console.warn = () => {};
    /** @type {Promise<unknown>[]} */
    const waited = [];
    try {
      const onRequest = pagesHandler(CATALOGUE);
      const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
      const context = { request: new Request(`${APP_URL}api/config`), env: { ...ENV, KIT_STORE: kv }, waitUntil: (/** @type {Promise<unknown>} */ promise) => waited.push(promise) };
      // The 2.5 s wait is an AbortSignal's timer, which does not hold the event loop open.
      const open = setInterval(() => {}, 1000);
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 6000);
      });
      const answer = /** @type {Response | null} */ (await Promise.race([onRequest(context), late]).finally(() => {
        clearInterval(open);
        clearTimeout(timer);
      }));
      assert.ok(answer, 'answered while the price lookup was still under way');
      assert.equal(answer.headers.get('cache-control'), 'no-store');
      assert.equal(waited.length, 1);
    } finally {
      release();
      await Promise.all(waited);
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  describe('Node over a loopback socket, with the file store', () => {
    /** @type {string} */
    let dataDir;
    /** @type {World} */
    let world;
    /** @type {Awaited<ReturnType<typeof serve>>} */
    let server;

    before(async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'kit-node-'));
      world = createWorld();
      server = await serve({ catalogue: CATALOGUE, env: { ...ENV }, dataDir: join(dataDir, 'data'), port: 0, fetch: world.fetch, now: world.now, log: () => {} });
    });

    after(async () => {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    /**
     * @param {string} method
     * @param {string} path
     * @param {{ headers?: Record<string, string>, body?: string | Uint8Array }} [options]
     * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
     */
    const call = (method, path, options = {}) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(new URL(path, server.url), { method, headers: options.headers, agent: false }, (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (options.body !== undefined) req.write(options.body);
        req.end();
      });

    test('binds loopback by default, and says where it is bound', () => {
      // The URL is read back from the socket, so it names the address actually bound.
      const address = /** @type {import('node:net').AddressInfo} */ (server.server.address());
      assert.equal(address.address, '127.0.0.1');
      assert.equal(server.url, `http://127.0.0.1:${address.port}/`);
      assert.deepEqual(server.features, { signIn: true, shop: true });
      // A request that has not arrived in 30 s (Node's own default is 300) is given up on.
      assert.equal(server.server.requestTimeout, 30_000);
      assert.equal(server.server.headersTimeout, 10_000);
    });

    test('sign in, buy, the signed webhook, the entitlement, sign out', async () => {
      const config = await call('GET', '/api/config');
      assert.equal(config.status, 200);
      assert.equal(config.headers['x-content-type-options'], 'nosniff');
      assert.equal(JSON.parse(config.body).shop.products.length, 2);

      const start = await call('GET', '/api/auth/google/start?return=/play', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
      assert.equal(start.status, 302);
      const location = new URL(String(start.headers.location));
      assert.equal(location.searchParams.get('redirect_uri'), 'https://shop.example/api/auth/google/callback');
      const oauth = cookieParts(start.headers['set-cookie']?.[0] ?? '');
      const back = consent(world, location.href);
      const done = await call('GET', `${back.pathname}${back.search}`, { headers: { cookie: `${oauth.name}=${oauth.value}` } });
      assert.equal(done.status, 302);
      assert.equal(done.headers.location, 'https://shop.example/play');
      const session = (done.headers['set-cookie'] ?? []).map(cookieParts).find((c) => c.name === '__Host-demo-session');
      assert.ok(session);
      const cookie = `${session.name}=${session.value}`;

      const me = await call('GET', '/api/me', { headers: { cookie } });
      assert.deepEqual(JSON.parse(me.body), { user: { email: 'ada@example.com' }, entitlements: [] });

      const checkout = await call('POST', '/api/checkout', { headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ product: 'pro' }) });
      assert.equal(checkout.status, 200);
      assert.match(JSON.parse(checkout.body).url, /^https:\/\/checkout\.stripe\.com\//);

      const payload = JSON.stringify(stripeEvent(world, 'checkout.session.completed', paidSession()));
      const t = Math.floor(world.clock / 1000);
      const hook = await call('POST', '/api/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1(payload, t)}` }, body: payload });
      assert.equal(hook.status, 200);
      assert.deepEqual(JSON.parse((await call('GET', '/api/me', { headers: { cookie } })).body).entitlements, ['pro']);

      const out = await call('POST', '/api/auth/logout', { headers: { cookie, origin: ORIGIN } });
      assert.equal(out.status, 204);
      assert.equal(out.headers['content-type'], undefined);
      assert.deepEqual(JSON.parse((await call('GET', '/api/me', { headers: { cookie } })).body), { user: null, entitlements: [] });

      for (const name of await readdir(join(dataDir, 'data'))) assert.match(name, /^[0-9a-f]{64}\.json$/);
      assert.deepEqual(world.unexpected, []);
    });

    /**
     * Writes `head`, `length` bytes of body and then `tail` to a raw connection, and collects
     * what comes back until the server closes it or `waitMs` passes.
     * @param {string} head
     * @param {number} length
     * @param {number} waitMs
     * @param {string} [tail]
     * @returns {Promise<{ text: string, closed: boolean, written: number }>}
     */
    const rawExchange = (head, length, waitMs, tail = '') =>
      new Promise((resolve) => {
        const target = new URL(server.url);
        const socket = connect(Number(target.port), target.hostname);
        let text = '';
        let closed = false;
        let written = 0;
        socket.on('data', (chunk) => {
          text += chunk.toString('latin1');
        });
        socket.on('error', () => {});
        const timer = setTimeout(() => {
          socket.destroy();
          resolve({ text, closed, written });
        }, waitMs);
        socket.on('close', () => {
          closed = true;
          clearTimeout(timer);
          resolve({ text, closed, written });
        });
        socket.write(head);
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const pump = () => {
          while (written < length && !socket.destroyed) {
            const size = Math.min(chunk.length, length - written);
            written += size;
            if (!socket.write(chunk.subarray(0, size))) {
              socket.once('drain', pump);
              return;
            }
          }
          if (tail && !socket.destroyed) socket.write(tail);
        };
        pump();
      });

    test('the rest of a body the kit did not read is drained, so the connection carries the next request', async () => {
      const body = 300 * 1024;
      const head =
        `POST /api/auth/logout HTTP/1.1\r\nHost: shop.example\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${body}\r\n\r\n`;
      const { text } = await rawExchange(head, body, 3000, 'GET /api/config HTTP/1.1\r\nHost: shop.example\r\nConnection: close\r\n\r\n');
      assert.deepEqual([...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => m[1]), ['204', '200']);
    });

    test('past 1 MiB of a body the kit did not read, the connection is cut', async () => {
      const length = 4 * 1024 * 1024;
      const head =
        `POST /api/auth/logout HTTP/1.1\r\nHost: shop.example\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;
      const { text, closed, written } = await rawExchange(head, length, 3000);
      assert.match(text, /^HTTP\/1\.1 204 /);
      assert.ok(closed, 'the server closed the connection');
      assert.ok(written < length, `it did so before the whole body was sent (${written} of ${length})`);
    });

    test('a body over the cap is refused through the adapter, with and without Content-Length', async () => {
      const big = new Uint8Array(512 * 1024 + 1);
      const declared = await call('POST', '/api/webhooks/stripe', { headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: big });
      assert.equal(declared.status, 413);
      const chunked = await new Promise((resolve, reject) => {
        const req = httpRequest(new URL('/api/webhooks/stripe', server.url), { method: 'POST', headers: { 'transfer-encoding': 'chunked', 'stripe-signature': 't=1,v1=00' }, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write(big.subarray(0, 300 * 1024));
        req.write(big.subarray(300 * 1024));
        req.end();
      });
      assert.equal(chunked, 413);
      const target = new URL(server.url);
      const notPath = await new Promise((resolve, reject) => {
        const req = httpRequest({ host: target.hostname, port: target.port, path: '//evil.example/api/config', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(notPath, 400, 'a target that is not a path is refused');
      // The URL parser reads a backslash as a slash: `/\host` leaves the base as `//host` does.
      for (const path of ['/\\evil.example/api/config', '/\\/evil.example/api/config', 'http://evil.example/api/config']) {
        const { text } = await rawExchange(`GET ${path} HTTP/1.1\r\nHost: shop.example\r\nConnection: close\r\n\r\n`, 0, 3000);
        assert.match(text, /^HTTP\/1\.1 400 /, path);
      }
      // Only a path from a single `/` is served, even when what else is sent names the base
      // itself: the absolute form, the asterisk form, and `//` or `/\` before the base's name.
      // Each is the kit's own refusal, a JSON 400, not Node's.
      for (const path of ['http://localhost/api/config', 'http://localhost:80/api/config', 'HTTP://LOCALHOST/api/config', '*', '//localhost/api/config', '/\\localhost/api/config', '//localhost:80/api/config']) {
        const { text } = await rawExchange(`GET ${path} HTTP/1.1\r\nHost: shop.example\r\nConnection: close\r\n\r\n`, 0, 3000);
        assert.match(text, /^HTTP\/1\.1 400 /, path);
        assert.match(text, /\r\n\r\n\{"error":"bad_request"\}$/, `${path}: the kit's refusal`);
      }
      const { text: served } = await rawExchange('GET /api/config?x=1 HTTP/1.1\r\nHost: shop.example\r\nConnection: close\r\n\r\n', 0, 3000);
      assert.match(served, /^HTTP\/1\.1 200 /, 'a path from a single / is served');
    });
  });
});

describe('the kit itself', () => {
  test('outside node.js and this file, only the globals the charter lists, each through globalThis', () => {
    const allowed = new Set(['fetch', 'Request', 'Response', 'URL', 'crypto', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'AbortSignal', 'console']);
    const here = fileURLToPath(new URL('.', import.meta.url));
    for (const file of ['crypto.js', 'http.js', 'google.js', 'stripe.js', 'store.js', 'config.js', 'app.js', 'cloudflare.js']) {
      const source = readFileSync(join(here, file), 'utf8');
      assert.doesNotMatch(source, /\bprocess\.|\bBuffer\.|\brequire\(|from ['"]node:|import\(['"]node:/, `${file} uses nothing Node-only`);
      for (const [, name] of source.matchAll(/globalThis\.([A-Za-z]+)/g)) assert.ok(allowed.has(name ?? ''), `${file}: globalThis.${name}`);
      if (file !== 'cloudflare.js') assert.doesNotMatch(source, /globalThis\.console/, `${file} logs only through the injected log`);
    }
  });

  test('config.js is what a server that keeps its own accounts imports: no app.js, no store, no state; app.js gives the same functions', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    /** @param {string} file @returns {string[]} the kit modules it imports, and theirs */
    const reach = (file, seen = new Set()) => {
      for (const [, name] of readFileSync(join(here, file), 'utf8').matchAll(/^import [^;]*? from '\.\/([a-z]+\.js)';$/gm)) {
        if (name && !seen.has(name)) {
          seen.add(name);
          reach(name, seen);
        }
      }
      return [...seen].sort();
    };
    assert.deepEqual(reach('config.js'), ['crypto.js', 'http.js', 'stripe.js']);
    const config = await import('./config.js');
    const app = await import('./app.js');
    for (const name of ['ID', 'validateCatalogue', 'priceVariable', 'readConfig', 'safeReturnPath']) {
      assert.ok(name in config, name);
      assert.equal(/** @type {Record<string, unknown>} */ (app)[name], /** @type {Record<string, unknown>} */ (config)[name], `app.js re-exports ${name}`);
    }
  });

  test("the README's nginx block sends the sites' own Strict-Transport-Security line and no other header", () => {
    // Its one add_header stops the server block's headers being inherited, so it must repeat
    // the server block's HSTS line as every site's deploy/nginx.conf writes it: a different
    // value on api/ responses would replace the site's (includeSubDomains dropped) on each call.
    const readme = readFileSync(fileURLToPath(new URL('README.md', import.meta.url)), 'utf8');
    const block = [...readme.matchAll(/```nginx\n([\s\S]*?)```/g)].map((m) => m[1] ?? '').find((text) => text.includes('location ^~ /api/'));
    assert.ok(block, 'the README has the nginx location for api/');
    const lines = block.split('\n').filter((line) => line.trim().startsWith('add_header'));
    assert.deepEqual(lines.map((line) => line.trim()), ['add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;']);
  });

  /** The README's paragraphs, each on one line. */
  const paragraphs = () =>
    readFileSync(fileURLToPath(new URL('README.md', import.meta.url)), 'utf8')
      .split(/\n\s*\n/)
      .map((text) => text.replace(/\s+/g, ' ').trim());

  test('the README says what sharing an origin costs: at Hosting, beside each sub-path recipe and at the CSRF gate', () => {
    // The CSRF gate and the __Host- cookie keep other sites out, not other pages of the origin:
    // any of them can act as the signed-in visitor, the Customer Portal link and deletion included.
    const all = paragraphs();
    const boundary = all.find((text) => text.startsWith('**One origin per app is a security boundary.**'));
    assert.ok(boundary, 'Hosting opens with the boundary');
    for (const part of ['every page on the origin can act as the signed-in visitor through `api/`', 'read their email', 'start a checkout', 'open the Customer Portal', 'manages their billing', 'delete the account', "Deploy under a sub-path only when every page on the origin is this app's own", 'plugins']) {
      assert.ok(boundary.includes(part), part);
    }
    const hosting = all.slice(all.findIndex((text) => text === '## Hosting'), all.findIndex((text) => text.startsWith('## Routes')));
    assert.ok(hosting.includes(boundary), 'under Hosting');
    const recipes = hosting.filter((text) => /\bunder a sub-path\b/.test(text) && text !== boundary);
    assert.ok(recipes.length >= 2, 'the Cloudflare and nginx sub-path recipes');
    for (const text of recipes) assert.ok(text.includes("every page is this app's own"), text.slice(0, 60));
    const csrf = all.find((text) => text.startsWith('**CSRF.**'));
    assert.ok(csrf?.includes('"One origin per app is a security boundary"'), 'the CSRF paragraph points at it');
  });

  test("the README tells a site whose tests refuse an add_header in a location to take the api/ location as the one stated exception", () => {
    const note = paragraphs().find((text) => text.includes('takes this location as the one stated exception'));
    assert.ok(note, 'the note beside the nginx block');
    for (const part of ['rather than dropping the rule', 'allows exactly `location ^~ /api/`', "its one `add_header` is the server block's Strict-Transport-Security line", 'still refuses an `add_header` in every other location', 'learns `^~`', 'expects what is under `api/` to be proxied']) {
      assert.ok(note.includes(part), part);
    }
  });

  /** The README's fenced blocks of one language. @param {string} language */
  const blocks = (language) => [...readFileSync(fileURLToPath(new URL('README.md', import.meta.url)), 'utf8').matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1] ?? '');

  test("the README's proxies answer a stopped API with the site's not-found page, and let the kit's own answers through", () => {
    // Without these, nginx sent its own 502 page with HSTS alone and Apache its 503 page with
    // none of the site's headers (measured by the lanes on nginx 1.24.0 and Apache 2.4.58).
    const nginx = blocks('nginx').find((text) => text.includes('location ^~ /api/'));
    assert.ok(nginx);
    const directives = nginx.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert.ok(directives.includes('error_page 502 504 /404.html;'), 'nginx: error_page');
    assert.ok(!directives.some((line) => line.startsWith('proxy_intercept_errors')), 'nginx: the kit\'s own errors pass through');
    const apache = blocks('apache').map((text) => text.trim().split('\n').map((line) => line.trim()));
    assert.deepEqual(apache, [['ProxyPass "/api/" "http://127.0.0.1:8788/api/"', 'ErrorDocument 502 /404.html', 'ErrorDocument 503 /404.html', 'ErrorDocument 504 /404.html']]);
    const said = paragraphs().join('\n');
    assert.ok(said.includes('`ProxyPass` is server configuration, so the API goes in the virtual host'), 'Apache: what is server configuration');
    assert.ok(said.includes('An `.htaccess` can proxy as well, through `RewriteRule'), 'Apache: what .htaccess can do');
    assert.ok(said.includes('A site that does not run the API deletes the block'), 'nginx: a site with no API');
  });

  test('the README says when a second Buy is refused, what holds across isolates and locations, and what a deletion leaves of a remembered Checkout Session', () => {
    // VERIFY-16 to VERIFY-18: "a page that reads every 409 as owned still never sells twice" was
    // contradicted on KV, and deletion was said to remove every remembered session.
    const said = paragraphs().join('\n');
    for (const part of [
      "409 `subscription_active` when it is not held but a subscription of the visitor's to it will still charge",
      'A 409 `subscription_active` means a subscription to it is past due or paused and will charge again once paid or resumed: offer Manage subscription rather than Buy',
      'A 409 never comes with a Checkout address, so a page that reads every 409 as owned offers no second payment',
      // VERIFY-20: two isolates of one location took two presses at once, which the README said
      // only two KV locations could.
      'Send one Buy at a time: keep the control disabled while a press is out',
      'is answered 502 (pressed again, it is given that session), so read a 502 as "try again"',
      'send Delete account only while no Buy is out',
      'presses that read the same within the same five minutes, wherever they are handled, are given one session',
      'two sign-ins to the account at once (two browsers or devices), presses on either side of a five-minute boundary',
      'a press so failed is answered the same 502 when pressed again within those five minutes',
      'Delete account waits only for a Buy handled by its own isolate (or Node process)',
      'its marker then names the account until it expires, 30 days after that Buy',
      'else a new one, which expires 55 to 60 minutes after it is made',
      '`{ id, failed: true }` for an hour',
      'A fake that makes a new session for every `POST /v1/checkout/sessions` passes tests Stripe would answer otherwise',
      'The session the visitor was given for the product stays remembered',
      'only a 404 says Stripe has no such session',
      'finds the sign-in ended, is answered 401 and makes nothing',
      'one remembered for a product since taken out of the catalogue is not found',
      "A site's own fake Stripe whose tests press Buy for a product a second time",
      'once it is complete the `payment_intent` (payment mode, `null` for a free checkout) or the `subscription` (subscription mode) it made',
    ]) {
      assert.ok(said.includes(part), part);
    }
    assert.ok(!said.includes('never sells twice'));
    assert.ok(!said.includes('the one way to two payments'), 'two KV locations are not the one way to two payments');
  });

  test("the README's static api/config is what the kit answers when nothing is set, byte for byte", async () => {
    const [published] = blocks('json').filter((text) => text.includes('"auth"'));
    assert.ok(published, 'the README gives the file');
    const { app } = makeApp(createWorld(), { env: {} });
    const answer = await app.handle(new Request(`${APP_URL}api/config`));
    assert.equal(published.trim(), await answer.text());
  });

  test('the README says what a start script, a server of your own and the privacy sentence need', () => {
    const said = paragraphs().join('\n');
    for (const part of [
      'Beside it, `server/package.json` holding `{"type":"module"}`',
      '`MODULE_TYPELESS_PACKAGE_JSON`',
      'Stripe handles the payment, and is told the account id (`google:<sub>`) with it',
      'the email in the session record while the visitor is signed in',
      'the payment itself stays with Stripe, with the account id it was made under',
      'route `**/api/auth/google/start*`, take the kit\'s answer with `route.fetch({ maxRedirects: 0 })`',
      'Mount it after any gate that refuses a foreign `Origin`',
      'before any gate that wants a bearer token',
      'Pass `createFileStore(KIT_DATA_DIR)` from `node.js` as `store`',
    ]) {
      assert.ok(said.includes(part), part);
    }
    const proxy = blocks('nginx').find((text) => text.includes('x5c'));
    assert.deepEqual(proxy?.trim().split('\n').map((line) => line.trim()), ['if ($request_uri ~ "^[^?]*\\x5c") { return 400; }', 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;']);
  });
});
