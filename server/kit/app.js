// @ts-check
// The backend for an app that has none: sign in with Google, sessions, entitlements, Stripe
// Checkout and its webhook, behind `createApp(...).handle(request) → Response`. Everything is
// off until the environment supplies what a feature needs; with nothing set, `GET api/config`
// reports nothing configured and every other route is a 404.
//
// What a visitor owns is read from the purchase records the webhook writes (one per payment and
// one per subscription), never from a copy that a sign-in or sign-out writes back: on Workers KV
// a location keeps serving what it read for up to a minute, so any record that two kinds of
// request rewrite whole can have a stale copy written over a revoke. Sign-in and sign-out touch
// only the session records; the user record is the index of the visitor's purchase records and
// their Stripe customer, written by the webhook and by account deletion alone.

import { base64url, fromBase64url, fromUtf8, hex, hmacSha256, hmacVerify, randomBytes, randomId, safeEqual, sha256, utf8 } from './crypto.js';
import { HttpError, clearCookie, createRouter, csrfRefusal, failure, isRecord, json, noContent, parseCookies, readBytes, readJson, redirect, serializeCookie } from './http.js';
import { AuthError, authorizeUrl, createKeyCache, exchangeCode, pkcePair, verifyIdToken } from './google.js';
import { StripeError, createCheckoutSession, createPortalSession, getPrice, keyMode, parseEvent, verifySignature } from './stripe.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('./google.js').Fetch} Fetch */
/** @typedef {import('./google.js').KeySource} KeySource */
/** @typedef {import('./stripe.js').PriceInfo} PriceInfo */
/** @typedef {import('./stripe.js').StripeEvent} StripeEvent */
/** @typedef {(level: 'warn' | 'error', message: string) => void} Log */

/**
 * @typedef {object} Product
 * @property {string} id matches ^[a-z][a-z0-9-]{0,31}$; its price is STRIPE_PRICE_<ID>
 * @property {string} name
 * @property {string} description
 * @property {'payment' | 'subscription'} mode
 * @property {string} grants the entitlement id a purchase unlocks
 */

/**
 * @typedef {object} Catalogue
 * @property {string} app matches ^[a-z][a-z0-9-]{0,31}$; names the cookies and tags the payments
 * @property {string} name
 * @property {readonly Product[]} products
 */

/**
 * @typedef {object} SignIn
 * @property {URL} appUrl
 * @property {Uint8Array} secret SESSION_SECRET's bytes
 * @property {string} clientId
 * @property {string} clientSecret
 */

/**
 * @typedef {object} Shop
 * @property {string} key STRIPE_SECRET_KEY
 * @property {'live' | 'test'} mode told by the key's prefix
 * @property {string} webhookSecret
 * @property {Map<string, string>} prices product id → Stripe Price id
 */

/**
 * @typedef {object} Config
 * @property {URL | null} appUrl
 * @property {SignIn | null} signIn
 * @property {Shop | null} shop
 * @property {'live' | 'test'} records the Stripe mode whose purchase records the kit reads and
 *   writes: the key's, or live when no well-formed key is set. A test-mode purchase is never
 *   read under a live key, and a test-mode customer id never sent to one.
 * @property {string | null} warning one line naming what is missing or malformed, never a value
 */

export const ID = /^[a-z][a-z0-9-]{0,31}$/;
const USER = /^google:[A-Za-z0-9_-]{1,255}$/;
const CUSTOMER = /^cus_[0-9A-Za-z_]{1,250}$/;
const PAYMENT_INTENT = /^pi_[0-9A-Za-z_]{1,250}$/;
const CHECKOUT_SESSION = /^cs_[0-9A-Za-z_]{1,250}$/;
const SUBSCRIPTION = /^sub_[0-9A-Za-z_]{1,250}$/;
const STATUS = /^[a-z_]{1,32}$/;
/** The name of a purchase record: a payment (or a free checkout's session) or a subscription. */
const RECORD = /^(?:payment:(?:pi|cs)|subscription:sub)_[0-9A-Za-z_]{1,250}$/;
const SESSION_HASH = /^[0-9a-f]{64}$/;

const SESSION_TTL = 30 * 86_400;
const OAUTH_TTL = 600;
const EVENT_TTL = 30 * 86_400;
/** How long a Checkout Session stays payable: Stripe's floor is 30 minutes, its default 24 hours. */
const CHECKOUT_TTL = 3_600;
const TOMBSTONE_TTL = 90 * 86_400;
const RATE_TTL = 2 * 3_600;
const HOUR_MS = 3_600_000;
const CHECKOUTS_PER_HOUR = 10;
const PORTALS_PER_HOUR = 10;
const MAX_SESSIONS = 20;
const WEBHOOK_CAP = 512 * 1024;
const REQUEST_CAP = 4 * 1024;
const MAX_RETURN = 1024;
const PRICE_TTL_MS = HOUR_MS;
const PRICE_RETRY_MS = 60_000;
const ACTIVE = new Set(['active', 'trialing']);
/** A subscription in one of these is over: Stripe changes nothing about it afterwards. */
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
/** @type {readonly ('live' | 'test')[]} */
const MODES = Object.freeze(['live', 'test']);

// ---------------------------------------------------------------------------------------------
// The catalogue and the environment

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {value is string}
 */
function isText(value, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} allowed
 * @param {string} where
 */
function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`catalogue: ${where} has an unknown field "${key}"`);
  }
}

/**
 * Checks the app's catalogue and returns a frozen copy. A malformed catalogue is a
 * programming error, so it throws (TypeError) rather than turning a feature off.
 * @param {unknown} input
 * @returns {Catalogue}
 */
export function validateCatalogue(input) {
  if (!isRecord(input)) throw new TypeError('catalogue: an object { app, name, products }');
  onlyKeys(input, ['app', 'name', 'products'], 'the catalogue');
  if (typeof input.app !== 'string' || !ID.test(input.app)) throw new TypeError('catalogue: app must match ^[a-z][a-z0-9-]{0,31}$');
  if (!isText(input.name, 1, 100)) throw new TypeError('catalogue: name is 1-100 characters of text');
  if (!Array.isArray(input.products) || input.products.length > 50) throw new TypeError('catalogue: products is an array of at most 50');
  const seen = new Set();
  /** @type {Product[]} */
  const products = input.products.map((raw, index) => {
    const where = `products[${index}]`;
    if (!isRecord(raw)) throw new TypeError(`catalogue: ${where} is an object`);
    onlyKeys(raw, ['id', 'name', 'description', 'mode', 'grants'], where);
    const { id, name, description, mode, grants } = raw;
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError(`catalogue: ${where}.id must match ^[a-z][a-z0-9-]{0,31}$`);
    if (seen.has(id)) throw new TypeError(`catalogue: ${where}.id "${id}" appears twice`);
    seen.add(id);
    if (!isText(name, 1, 100)) throw new TypeError(`catalogue: ${where}.name is 1-100 characters of text`);
    if (!isText(description, 0, 500)) throw new TypeError(`catalogue: ${where}.description is at most 500 characters of text`);
    if (mode !== 'payment' && mode !== 'subscription') throw new TypeError(`catalogue: ${where}.mode is "payment" or "subscription"`);
    if (typeof grants !== 'string' || !ID.test(grants)) throw new TypeError(`catalogue: ${where}.grants must match ^[a-z][a-z0-9-]{0,31}$`);
    return Object.freeze({ id, name, description, mode, grants });
  });
  return Object.freeze({ app: input.app, name: input.name, products: Object.freeze(products) });
}

/**
 * The environment variable that holds a product's Stripe Price id: `pro` → STRIPE_PRICE_PRO,
 * `pack-a` → STRIPE_PRICE_PACK_A. Product ids have no underscore, so no two collide.
 * @param {string} productId
 * @returns {string}
 */
export function priceVariable(productId) {
  return `STRIPE_PRICE_${productId.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * APP_URL as a URL when it is canonical, ends in `/`, carries no query, fragment or
 * credentials, and is https (http only for localhost, where browsers still keep Secure cookies).
 * @param {string} text
 * @returns {URL | null}
 */
function parseAppUrl(text) {
  let url;
  try {
    url = new globalThis.URL(text);
  } catch {
    return null;
  }
  if (url.href !== text || !url.pathname.endsWith('/') || url.search || url.hash || url.username || url.password) return null;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url;
}

const SIGN_IN_VARIABLES = ['APP_URL', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const SHOP_VARIABLES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

/**
 * Reads the environment into what is on and what is off. A feature is on only when
 * everything it needs is present and well formed: sign-in needs APP_URL, SESSION_SECRET and
 * both Google values (and a store); the shop needs sign-in, the Stripe key, the webhook
 * secret and a price for at least one product. A partial configuration produces one warning
 * naming what is missing or malformed, never a value; no configuration at all produces none.
 * @param {Record<string, unknown>} env
 * @param {Catalogue} catalogue
 * @param {{ store: boolean }} has
 * @returns {Config}
 */
export function readConfig(env, catalogue, has) {
  /** @param {string} name */
  const raw = (name) => {
    const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const malformed = [];
  /**
   * @template T
   * @param {string} name
   * @param {(value: string) => T | null} parse
   * @returns {T | null}
   */
  const read = (name, parse) => {
    const value = raw(name);
    if (value === undefined) {
      missing.push(name);
      return null;
    }
    const parsed = parse(value);
    if (parsed === null) malformed.push(name);
    return parsed;
  };
  const appUrl = read('APP_URL', parseAppUrl);
  const secret = read('SESSION_SECRET', (value) => {
    const bytes = fromBase64url(value);
    return bytes && bytes.length >= 32 ? bytes : null;
  });
  const clientId = read('GOOGLE_CLIENT_ID', (value) => (/^[0-9A-Za-z_.-]{1,200}\.apps\.googleusercontent\.com$/.test(value) ? value : null));
  const clientSecret = read('GOOGLE_CLIENT_SECRET', (value) => (/^[\x21-\x7e]{10,200}$/.test(value) ? value : null));
  const signInProblems = [...missing.map((n) => `missing ${n}`), ...malformed.map((n) => `malformed ${n}`)];
  if (!has.store) signInProblems.push('no store (KIT_STORE)');
  const signInTouched = SIGN_IN_VARIABLES.some((name) => raw(name) !== undefined);
  /** @type {SignIn | null} */
  const signIn = appUrl && secret && clientId && clientSecret && has.store ? { appUrl, secret, clientId, clientSecret } : null;

  missing.length = 0;
  malformed.length = 0;
  const key = read('STRIPE_SECRET_KEY', (value) => (keyMode(value) ? value : null));
  const webhookSecret = read('STRIPE_WEBHOOK_SECRET', (value) => (/^whsec_[0-9A-Za-z+/=_-]{10,200}$/.test(value) ? value : null));
  /** @type {Map<string, string>} */
  const prices = new Map();
  /** @type {string[]} */
  const unpriced = [];
  for (const product of catalogue.products) {
    const name = priceVariable(product.id);
    const value = raw(name);
    if (value !== undefined && /^price_[0-9A-Za-z_]{1,200}$/.test(value)) prices.set(product.id, value);
    else {
      if (value !== undefined) malformed.push(name);
      unpriced.push(product.id);
    }
  }
  const shopTouched =
    SHOP_VARIABLES.some((name) => raw(name) !== undefined) || catalogue.products.some((product) => raw(priceVariable(product.id)) !== undefined);
  const mode = key ? keyMode(key) : null;
  /** @type {Shop | null} */
  const shop = signIn && key && mode && webhookSecret && prices.size > 0 ? { key, mode, webhookSecret, prices } : null;
  const records = mode ?? 'live';

  /** @type {string[]} */
  const notes = [];
  if (signInTouched && !signIn) notes.push(`sign-in is off (${signInProblems.join(', ')})`);
  if (shopTouched && !shop) {
    const why = [...missing.map((n) => `missing ${n}`), ...malformed.map((n) => `malformed ${n}`)];
    if (!signIn) why.unshift('sign-in is off');
    if (prices.size === 0) why.push(catalogue.products.length ? 'no product has a price' : 'the catalogue sells nothing');
    notes.push(`the shop is off (${[...new Set(why)].join(', ')})`);
  } else if (shop && unpriced.length > 0) {
    const bad = malformed.filter((name) => name.startsWith('STRIPE_PRICE_'));
    notes.push(`not sold, no usable price: ${unpriced.join(', ')}${bad.length ? ` (malformed ${bad.join(', ')})` : ''}`);
  }
  return { appUrl, signIn, shop, records, warning: notes.length ? `kit (${catalogue.app}): ${notes.join('; ')}` : null };
}

/**
 * Where to send the browser after signing in: a path under the site, or the site's root.
 * The path must start with exactly one `/`, hold no backslash and no control character, both
 * as given and once percent-decoded, resolve (dot segments and all) under APP_URL's path, and
 * not lie under `api/`. Anything else becomes the root. A string that passes the first checks
 * is a path-absolute reference, which the URL parser resolves against the base's host whatever
 * follows (the URL parser drops tabs and newlines, which is why control characters are refused
 * first), and the caller writes APP_URL's origin in front of what this returns: so there is no
 * separate origin check to make.
 *
 * The result travels in the sealed oauth cookie, and a browser drops a cookie over 4096 bytes,
 * which fails the sign-in. The URL parser percent-encodes what it serialises, so one character
 * of the input can become up to twelve bytes of the result (`é` is `%C3%A9`): it is the result,
 * not the input, whose length is held to MAX_RETURN. At that length the cookie stays near 1,700
 * bytes.
 * @param {unknown} value
 * @param {URL} appUrl
 * @returns {string}
 */
export function safeReturnPath(value, appUrl) {
  const root = appUrl.pathname;
  if (typeof value !== 'string' || !isPlainPath(value)) return root;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return root;
  }
  if (!isPlainPath(decoded)) return root;
  let target;
  try {
    target = new globalThis.URL(value, appUrl.origin);
  } catch {
    return root;
  }
  if (!target.pathname.startsWith(root) || target.pathname.startsWith(`${root}api/`)) return root;
  const path = `${target.pathname}${target.search}${target.hash}`;
  return path.length > MAX_RETURN ? root : path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isPlainPath(path) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Records

/**
 * @typedef {{ refs: Set<string>, customer: string | null }} UserRecord the purchase records of
 *   one user in one Stripe mode, and their Stripe customer there
 * @typedef {{ hash: string, user: string, email?: string }} Session
 */

/**
 * A user record as stored, read defensively: anything not of the expected shape is left out.
 * @param {unknown} raw
 * @returns {UserRecord}
 */
function readUserRecord(raw) {
  /** @type {UserRecord} */
  const record = { refs: new Set(), customer: null };
  if (!isRecord(raw)) return record;
  if (typeof raw.customer === 'string' && CUSTOMER.test(raw.customer)) record.customer = raw.customer;
  if (Array.isArray(raw.refs)) for (const ref of raw.refs) if (typeof ref === 'string' && RECORD.test(ref)) record.refs.add(ref);
  return record;
}

/**
 * @param {UserRecord} record
 * @returns {Record<string, unknown>}
 */
function writeUserRecord(record) {
  return { refs: [...record.refs], ...(record.customer ? { customer: record.customer } : {}) };
}

/**
 * A user's session index as stored: session hash → expiry (ms).
 * @param {unknown} raw
 * @returns {Map<string, number>}
 */
function readSessionIndex(raw) {
  /** @type {Map<string, number>} */
  const sessions = new Map();
  if (isRecord(raw)) {
    for (const [hash, expires] of Object.entries(raw)) if (SESSION_HASH.test(hash) && typeof expires === 'number') sessions.set(hash, expires);
  }
  return sessions;
}

/**
 * The entitlement a purchase record gives `user` now, or null: a payment that has not been
 * refunded or disputed, or a subscription whose last known status is active or trialing (a
 * subscription known only from its paid checkout counts as active).
 * @param {string} name the record's name, `payment:…` or `subscription:…`
 * @param {unknown} raw the record
 * @param {string} user
 * @returns {string | null}
 */
function liveGrant(name, raw, user) {
  if (!isRecord(raw) || raw.user !== user) return null;
  const grants = matching(raw.grants, ID);
  if (!grants) return null;
  if (name.startsWith('payment:')) return raw.revoked === true ? null : grants;
  if (raw.status === undefined) return grants;
  return typeof raw.status === 'string' && ACTIVE.has(raw.status) ? grants : null;
}

/**
 * Whether a subscription record of `user` may still charge them: not cancelled or expired,
 * and not set to end with the current period.
 * @param {unknown} raw
 * @param {string} user
 * @returns {boolean}
 */
function stillCharging(raw, user) {
  if (!isRecord(raw) || raw.user !== user) return false;
  if (typeof raw.status === 'string' && TERMINAL.has(raw.status)) return false;
  return raw.ending !== true;
}

/**
 * What a subscription record remembers of the subscription's own state: its status, the time
 * of the event that set it, and whether it ends with the current period.
 * @param {Record<string, unknown>} held
 * @returns {Record<string, unknown>}
 */
function subscriptionState(held) {
  return {
    ...(typeof held.status === 'string' && STATUS.test(held.status) ? { status: held.status } : {}),
    ...(typeof held.eventAt === 'number' ? { eventAt: held.eventAt } : {}),
    ...(held.ending === true ? { ending: true } : {}),
  };
}

/**
 * How long the state of a subscription whose account was deleted is kept: with no expiry
 * while the subscription can still change (one set to end with its period may run on for a
 * year, and its last event must still find it), and for as long as Stripe may resend an older
 * event once it is over.
 * @param {Record<string, unknown>} state
 * @returns {{ ttl?: number }}
 */
function keptFor(state) {
  return typeof state.status === 'string' && TERMINAL.has(state.status) ? { ttl: EVENT_TTL } : {};
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return isRecord(value) ? value : {};
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {string | null}
 */
function matching(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorName(error) {
  return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------------------------------------
// The app

/**
 * @typedef {object} AppOptions
 * @property {unknown} catalogue the app's catalogue (validated here; a malformed one throws)
 * @property {Record<string, unknown>} env the variables: Node's environment, or Cloudflare's context.env
 * @property {Store | null} store where sessions, users and markers live; null turns everything off
 * @property {Fetch} fetch the only way out to Google and Stripe; tests inject fakes here
 * @property {() => number} [now] milliseconds since the epoch
 * @property {Log} [log]
 * @property {number} [timeoutMs] per upstream call; 10 s
 */

/**
 * @typedef {object} App
 * @property {(request: Request) => Promise<Response>} handle never throws
 * @property {{ signIn: boolean, shop: boolean }} features
 */

/**
 * @param {AppOptions} options
 * @returns {App}
 */
export function createApp(options) {
  const catalogue = validateCatalogue(options.catalogue);
  if (typeof options.fetch !== 'function') throw new TypeError('createApp: fetch is required');
  const outbound = options.fetch;
  /** @type {Fetch} */
  const fetch = (input, init) => outbound(input, init);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 10_000;
  const store = options.store ?? null;
  const config = readConfig(options.env ?? {}, catalogue, { store: store !== null });
  if (config.warning) log('warn', config.warning);
  const products = new Map(catalogue.products.map((product) => [product.id, product]));
  const base = config.appUrl ? config.appUrl.pathname : null;
  const router = createRouter();

  router.on('GET', 'config', () => getConfig());

  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map();
  /**
   * Runs `task` after every earlier task with the same key has finished. Within one process
   * (the Node adapter, one Workers isolate) this makes each record's read-modify-write whole.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const lock = async (key, task) => {
    const previous = locks.get(key) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const turn = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const tail = previous.then(() => turn);
    locks.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  };

  // Every key the kit writes starts with the app's id, so two apps given one KV namespace (or
  // one data directory) keep apart; a purchase record also carries the Stripe mode it was
  // written under, so a test-mode purchase is not read under a live key.
  /** @param {string} name */
  const appKey = (name) => `${catalogue.app}:${name}`;
  /**
   * @param {string} name
   * @param {'live' | 'test'} [mode]
   */
  const shopKey = (name, mode = config.records) => `${catalogue.app}:${mode}:${name}`;
  /** @param {string} hash */
  const sessionKey = (hash) => appKey(`session:${hash}`);
  /** @param {string} user */
  const indexKey = (user) => appKey(`sessions:${user}`);
  /**
   * @param {string} user
   * @param {'live' | 'test'} [mode]
   */
  const userKey = (user, mode) => shopKey(`user:${user}`, mode);

  /** @type {Map<string, { value: PriceInfo | null, known: boolean, until: number }>} */
  const priceCache = new Map();
  /** @type {Map<string, Promise<{ value: PriceInfo | null, known: boolean }>>} */
  const pricePending = new Map();

  const shop = config.shop;
  /**
   * A product's price, from Stripe, cached in memory for an hour (a failed lookup for a minute).
   * `known` says whether Stripe answered: a price it answered with that is not usable (no fixed
   * amount, inactive, or not of the product's kind) means the product is not sold, while a
   * lookup that failed lists the product without a price and leaves the judgement to Checkout.
   * @param {Product} product
   * @returns {Promise<{ value: PriceInfo | null, known: boolean }>}
   */
  const priceOf = async (product) => {
    const price = shop?.prices.get(product.id);
    if (!shop || !price) return { value: null, known: false };
    const cached = priceCache.get(product.id);
    if (cached && cached.until > now()) return cached;
    let pending = pricePending.get(product.id);
    if (!pending) {
      pending = (async () => {
        try {
          const value = await getPrice({ fetch, key: shop.key, price, mode: product.mode, timeoutMs });
          if (!value) log('warn', `kit (${catalogue.app}): ${product.id} is not sold: its price is not usable (inactive, no fixed amount, or not ${product.mode === 'payment' ? 'one-time' : 'recurring'})`);
          priceCache.set(product.id, { value, known: true, until: now() + PRICE_TTL_MS });
          return { value, known: true };
        } catch (error) {
          const status = error instanceof StripeError ? `Stripe ${error.status}` : errorName(error);
          log('warn', `kit (${catalogue.app}): price lookup for ${product.id} failed (${status})`);
          priceCache.set(product.id, { value: null, known: false, until: now() + PRICE_RETRY_MS });
          return { value: null, known: false };
        } finally {
          pricePending.delete(product.id);
        }
      })();
      pricePending.set(product.id, pending);
    }
    return pending;
  };

  async function getConfig() {
    /** @type {Record<string, unknown>[]} */
    const listed = [];
    if (shop) {
      const sold = catalogue.products.filter((product) => shop.prices.has(product.id));
      const found = await Promise.all(sold.map(priceOf));
      sold.forEach((product, index) => {
        const price = found[index];
        if (price?.known && !price.value) return;
        listed.push({ id: product.id, name: product.name, description: product.description, mode: product.mode, ...(price?.value ? { price: price.value } : {}) });
      });
    }
    return json(200, { auth: { google: config.signIn !== null }, shop: { products: listed } }, { cache: 'public, max-age=60' });
  }

  if (config.signIn && store) {
    const signIn = config.signIn;
    const origin = signIn.appUrl.origin;
    const keys = createKeyCache({ fetch, now, timeoutMs });
    const sessionCookie = `__Host-${catalogue.app}-session`;
    const oauthCookie = `__Host-${catalogue.app}-oauth`;
    const redirectUri = `${signIn.appUrl.href}api/auth/google/callback`;

    // -- the oauth cookie: state, nonce, verifier and return path, signed and bound to its expiry

    /** @typedef {{ s: string, n: string, v: string, r: string, e: number }} Flow */

    /**
     * @param {Flow} flow
     * @returns {Promise<string>}
     */
    const sealFlow = async (flow) => {
      const payload = base64url(utf8(JSON.stringify(flow)));
      return `${payload}.${base64url(await hmacSha256(signIn.secret, `${catalogue.app}.oauth.${payload}`))}`;
    };

    /**
     * The flow a cookie carries, when its MAC is ours and its expiry has not passed. Only this
     * server can seal a flow, so what it holds is what `auth/google/start` put there: `r` was
     * made by safeReturnPath and `e` is ten minutes after it was sealed.
     * @param {string} value
     * @returns {Promise<Flow | null>}
     */
    const openFlow = async (value) => {
      const dot = value.indexOf('.');
      if (dot < 0) return null;
      const payload = value.slice(0, dot);
      const mac = fromBase64url(value.slice(dot + 1));
      if (!mac || mac.length !== 32 || !(await hmacVerify(signIn.secret, `${catalogue.app}.oauth.${payload}`, mac))) return null;
      const bytes = fromBase64url(payload);
      const text = bytes && fromUtf8(bytes);
      if (!text) return null;
      let flow;
      try {
        flow = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isRecord(flow)) return null;
      const { s, n, v, r, e } = flow;
      if (typeof s !== 'string' || typeof n !== 'string' || typeof v !== 'string' || typeof r !== 'string' || typeof e !== 'number') return null;
      if (e <= now()) return null;
      return { s, n, v, r, e };
    };

    // -- sessions: the cookie holds 32 random bytes, the store only their SHA-256

    /**
     * The store key's hash for a cookie value; null, before any store read, for a value that
     * cannot be one of the kit's tokens.
     * @param {string} token
     * @returns {Promise<string | null>}
     */
    const hashOf = async (token) => {
      const bytes = fromBase64url(token);
      return bytes && bytes.length === 32 ? hex(await sha256(bytes)) : null;
    };

    /**
     * @param {string | undefined} token
     * @returns {Promise<Session | null>}
     */
    const readSession = async (token) => {
      const hash = token ? await hashOf(token) : null;
      if (!hash) return null;
      const raw = await store.get(sessionKey(hash));
      if (!isRecord(raw) || typeof raw.user !== 'string' || !USER.test(raw.user) || typeof raw.expires !== 'number') return null;
      if (raw.expires <= now()) {
        await store.delete(sessionKey(hash));
        return null;
      }
      return typeof raw.email === 'string' ? { hash, user: raw.user, email: raw.email } : { hash, user: raw.user };
    };

    /**
     * @param {Request} request
     * @returns {Promise<Session | null>}
     */
    const currentSession = (request) => readSession(parseCookies(request.headers.get('cookie')).get(sessionCookie));

    /**
     * One read-modify-write of a user's session index, under its lock, and one write at most:
     * KV refuses a second write to one key within a second.
     * @param {string} user
     * @param {(sessions: Map<string, number>) => string[]} change returns the hashes it evicted
     * @returns {Promise<string[]>}
     */
    const changeSessions = (user, change) =>
      lock(indexKey(user), async () => {
        const raw = await store.get(indexKey(user));
        const sessions = readSessionIndex(raw);
        const before = JSON.stringify([...sessions]);
        const evicted = change(sessions);
        if (JSON.stringify([...sessions]) === before && raw !== null) return evicted;
        if (sessions.size === 0) {
          if (raw !== null) await store.delete(indexKey(user));
        } else {
          await store.put(indexKey(user), Object.fromEntries(sessions), { ttl: SESSION_TTL });
        }
        return evicted;
      });

    /** @param {Session} session */
    const endSession = async (session) => {
      await store.delete(sessionKey(session.hash));
      await changeSessions(session.user, (sessions) => {
        sessions.delete(session.hash);
        return [];
      });
    };

    /**
     * Mints a new session (a new id at every sign-in, so none can be fixed in advance) and
     * ends the one the browser held, if any. A user keeps at most MAX_SESSIONS; past that the
     * oldest ends.
     * @param {string} user
     * @param {string | undefined} email
     * @param {string | undefined} previous the session cookie the browser sent
     * @returns {Promise<string>} the new cookie value
     */
    const startSession = async (user, email, previous) => {
      const old = await readSession(previous);
      const bytes = randomBytes(32);
      const hash = hex(await sha256(bytes));
      const expires = now() + SESSION_TTL * 1000;
      await store.put(sessionKey(hash), email ? { user, email, expires } : { user, expires }, { ttl: SESSION_TTL });
      if (old) {
        await store.delete(sessionKey(old.hash));
        if (old.user !== user) {
          await changeSessions(old.user, (sessions) => {
            sessions.delete(old.hash);
            return [];
          });
        }
      }
      const evicted = await changeSessions(user, (sessions) => {
        if (old) sessions.delete(old.hash);
        for (const [known, until] of sessions) if (until <= now()) sessions.delete(known);
        sessions.set(hash, expires);
        const extra = [...sessions].sort((a, b) => a[1] - b[1]).slice(0, Math.max(0, sessions.size - MAX_SESSIONS));
        for (const [known] of extra) sessions.delete(known);
        return extra.map(([known]) => known);
      });
      for (const known of evicted) await store.delete(sessionKey(known));
      return base64url(bytes);
    };

    // -- what a user holds, read from the purchase records

    /**
     * The user's record in the configured mode and the entitlements its purchase records give.
     * @param {string} user
     * @returns {Promise<{ record: UserRecord, held: Set<string> }>}
     */
    const holdings = async (user) => {
      const record = readUserRecord(await store.get(userKey(user)));
      const names = [...record.refs];
      const found = await Promise.all(names.map((name) => store.get(shopKey(name))));
      /** @type {Set<string>} */
      const held = new Set();
      names.forEach((name, index) => {
        const grants = liveGrant(name, found[index], user);
        if (grants) held.add(grants);
      });
      return { record, held };
    };

    // -- sign-in

    router.on('GET', 'auth/google/start', async (_request, url) => {
      const state = randomId();
      const nonce = randomId();
      const { verifier, challenge } = await pkcePair();
      const flow = { s: state, n: nonce, v: verifier, r: safeReturnPath(url.searchParams.get('return'), signIn.appUrl), e: now() + OAUTH_TTL * 1000 };
      return redirect(authorizeUrl({ clientId: signIn.clientId, redirectUri, state, nonce, challenge }), {
        cookies: [serializeCookie(oauthCookie, await sealFlow(flow), OAUTH_TTL)],
      });
    });

    router.on('GET', 'auth/google/callback', async (request, url) => {
      /** @param {string | null} reason */
      const failed = (reason) => {
        if (reason) log('warn', `kit (${catalogue.app}): sign-in failed (${reason})`);
        return redirect(`${signIn.appUrl.href}?signin=failed`, { cookies: [clearCookie(oauthCookie)] });
      };
      try {
        const cookies = parseCookies(request.headers.get('cookie'));
        const sealed = cookies.get(oauthCookie);
        const flow = sealed ? await openFlow(sealed) : null;
        if (!flow) return failed('no valid sign-in cookie');
        const params = url.searchParams;
        if (params.has('error')) return failed(null);
        const state = params.get('state');
        if (state === null || !(await safeEqual(state, flow.s))) return failed('state');
        const code = params.get('code');
        if (!code || code.length > 4096) return failed('code');
        const idToken = await exchangeCode({ fetch, clientId: signIn.clientId, clientSecret: signIn.clientSecret, redirectUri, code, verifier: flow.v, timeoutMs });
        const identity = await verifyIdToken(idToken, { clientId: signIn.clientId, nonce: flow.n, now: now(), keys });
        const token = await startSession(`google:${identity.sub}`, identity.email, cookies.get(sessionCookie));
        return redirect(`${origin}${flow.r}`, {
          cookies: [serializeCookie(sessionCookie, token, SESSION_TTL), clearCookie(oauthCookie)],
        });
      } catch (error) {
        return failed(error instanceof AuthError ? error.reason : errorName(error));
      }
    });

    router.on('POST', 'auth/logout', async (request) => {
      const refused = csrfRefusal(request, origin, { body: false });
      if (refused) return refused;
      const session = await currentSession(request);
      if (session) await endSession(session);
      return noContent({ cookies: [clearCookie(sessionCookie)] });
    });

    // -- the account

    router.on('GET', 'me', async (request) => {
      const sent = parseCookies(request.headers.get('cookie')).has(sessionCookie);
      const session = await currentSession(request);
      if (!session) return json(200, { user: null, entitlements: [] }, { cookies: sent ? [clearCookie(sessionCookie)] : [] });
      const { held } = await holdings(session.user);
      return json(200, { user: session.email ? { email: session.email } : {}, entitlements: [...held].sort() });
    });

    router.on('DELETE', 'me', async (request) => {
      const refused = csrfRefusal(request, origin, { body: false });
      if (refused) return refused;
      const session = await currentSession(request);
      if (!session) return failure(401, 'unauthorized');
      const user = session.user;
      return lock(userKey(user), async () => {
        // A subscription that will charge again keeps the only copy of the Stripe customer,
        // which is what Manage subscription needs: the visitor cancels first (at the period's
        // end is enough), then deletes. Both Stripe modes are checked, as both are deleted: a
        // namespace shared by Preview (a test key) and Production (a live key) holds both.
        /** @type {Map<'live' | 'test', UserRecord>} */
        const records = new Map();
        for (const mode of MODES) records.set(mode, readUserRecord(await store.get(userKey(user, mode))));
        for (const [mode, record] of records) {
          for (const name of record.refs) {
            if (name.startsWith('subscription:') && stillCharging(await store.get(shopKey(name, mode)), user)) return failure(409, 'subscription_active');
          }
        }
        const index = readSessionIndex(await store.get(indexKey(user)));
        for (const hash of new Set([...index.keys(), session.hash])) await store.delete(sessionKey(hash));
        await store.delete(indexKey(user));
        for (const [mode, record] of records) {
          for (const name of record.refs) {
            const key = shopKey(name, mode);
            const held = recordOf(await store.get(key));
            if (held.user !== user) continue;
            // A subscription keeps its own state and the time of the deletion, with no one named
            // (its Stripe customer neither), until it is over and then for as long as Stripe may
            // resend an older event about it. Only an event created after the deletion that says
            // it will charge again, with no end date, makes it theirs again (onSubscription): no
            // event about it from before the deletion, retried by Stripe in whatever order, and
            // not its last one, can grant it again or write the account back.
            if (name.startsWith('subscription:')) {
              const state = { ...subscriptionState(held), deletedAt: Math.floor(now() / 1000) };
              await store.put(key, state, keptFor(state));
            } else await store.delete(key);
          }
          await store.delete(userKey(user, mode));
        }
        return noContent({ cookies: [clearCookie(sessionCookie)] });
      });
    });

    if (shop) {
      // -- buying

      /**
       * Counts one use of `key` in this hour; past `limit`, or when the count cannot be
       * written (KV allows one write a second to a key), the answer is 429. The count is read
       * and written under the key's lock, so it is exact within one Node adapter or isolate.
       * @param {string} key
       * @param {number} limit
       * @returns {Promise<Response | null>}
       */
      const rateLimited = (key, limit) =>
        lock(key, async () => {
          const at = now();
          const retryAfter = { headers: { 'Retry-After': String(Math.ceil((HOUR_MS - (at % HOUR_MS)) / 1000)) } };
          const count = await store.get(key);
          const used = typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
          if (used >= limit) return failure(429, 'rate_limited', retryAfter);
          try {
            await store.put(key, used + 1, { ttl: RATE_TTL });
          } catch {
            return failure(429, 'rate_limited', retryAfter);
          }
          return null;
        });

      router.on('POST', 'checkout', async (request) => {
        const refused = csrfRefusal(request, origin, { body: true });
        if (refused) return refused;
        const session = await currentSession(request);
        if (!session) return failure(401, 'unauthorized');
        const body = await readJson(request, REQUEST_CAP);
        const id = isRecord(body) ? body.product : undefined;
        const product = typeof id === 'string' ? products.get(id) : undefined;
        const price = product ? shop.prices.get(product.id) : undefined;
        if (!product || !price) return failure(404, 'not_found');
        const priced = await priceOf(product);
        if (priced.known && !priced.value) return failure(404, 'not_found');
        const { record, held } = await holdings(session.user);
        if (held.has(product.grants)) return failure(409, 'already_owned');
        const hour = Math.floor(now() / HOUR_MS);
        const limited = await rateLimited(shopKey(`ratelimit:${session.user}:${hour}`), CHECKOUTS_PER_HOUR);
        if (limited) return limited;
        try {
          const created = await createCheckoutSession({
            fetch,
            key: shop.key,
            app: catalogue.app,
            mode: product.mode,
            price,
            user: session.user,
            product: product.id,
            ...(record.customer ? { customer: record.customer } : {}),
            successUrl: `${signIn.appUrl.href}?purchase=success`,
            cancelUrl: `${signIn.appUrl.href}?purchase=cancelled`,
            expiresAt: Math.floor(now() / 1000) + CHECKOUT_TTL,
            idempotencyKey: `kit-checkout-${randomId(24)}`,
            timeoutMs,
          });
          return json(200, { url: created.url });
        } catch (error) {
          if (!(error instanceof StripeError)) throw error;
          log('error', `kit (${catalogue.app}): checkout failed (Stripe ${error.status})`);
          return failure(502, 'upstream_unavailable');
        }
      });

      /**
       * The Stripe customer whose portal Manage subscription opens: that of the first of the
       * user's subscriptions that will still charge them, else the one the user record keeps.
       * Checkout makes a new customer when it is given none, and the user record learns the
       * customer only from a webhook, so two subscriptions bought before the first one's webhook
       * arrived (two Buy tabs) belong to two customers, and a portal shows one customer's. Each
       * still charging is reached in turn, as the one before it is set to end, so the 409 from
       * Delete account always has a Manage subscription that reaches a subscription it counted.
       * @param {string} user
       * @returns {Promise<string | null>}
       */
      const portalCustomer = async (user) => {
        const record = readUserRecord(await store.get(userKey(user)));
        const names = [...record.refs].filter((name) => name.startsWith('subscription:'));
        const found = await Promise.all(names.map((name) => store.get(shopKey(name))));
        for (const raw of found) {
          const customer = matching(recordOf(raw).customer, CUSTOMER);
          if (customer && stillCharging(raw, user)) return customer;
        }
        return record.customer;
      };

      router.on('POST', 'portal', async (request) => {
        const refused = csrfRefusal(request, origin, { body: false });
        if (refused) return refused;
        const session = await currentSession(request);
        if (!session) return failure(401, 'unauthorized');
        const customer = await portalCustomer(session.user);
        if (!customer) return failure(404, 'not_found');
        const limited = await rateLimited(shopKey(`ratelimit:${session.user}:${Math.floor(now() / HOUR_MS)}:portal`), PORTALS_PER_HOUR);
        if (limited) return limited;
        try {
          const created = await createPortalSession({
            fetch,
            key: shop.key,
            customer,
            returnUrl: signIn.appUrl.href,
            idempotencyKey: `kit-portal-${randomId(24)}`,
            timeoutMs,
          });
          return json(200, { url: created.url });
        } catch (error) {
          if (!(error instanceof StripeError)) throw error;
          log('error', `kit (${catalogue.app}): portal failed (Stripe ${error.status})`);
          return failure(502, 'upstream_unavailable');
        }
      });

      // -- the webhook: the only thing that grants or revokes

      /**
       * The purchase a Stripe object's metadata names, when it is this app's, the user key
       * has the right shape and the product is in the catalogue.
       * @param {unknown} metadata
       * @returns {{ user: string, product: Product } | null}
       */
      const purchaseOf = (metadata) => {
        const meta = recordOf(metadata);
        const user = matching(meta.user, USER);
        const product = typeof meta.product === 'string' ? products.get(meta.product) : undefined;
        return meta.app === catalogue.app && user && product ? { user, product } : null;
      };

      /**
       * Adds a purchase record to the user's index, and the Stripe customer when the index has
       * none, writing only when something is new.
       * @param {string} user
       * @param {string} name
       * @param {string | null} customer
       */
      const addRef = (user, name, customer) =>
        lock(userKey(user), async () => {
          const record = readUserRecord(await store.get(userKey(user)));
          if (record.refs.has(name) && (customer === null || record.customer !== null)) return;
          record.refs.add(name);
          if (customer && !record.customer) record.customer = customer;
          await store.put(userKey(user), writeUserRecord(record));
        });

      /** @param {Record<string, unknown>} session a checkout.session */
      const onCheckoutPaid = async (session) => {
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return;
        const target = purchaseOf(session.metadata);
        if (!target) return;
        if (session.client_reference_id !== undefined && session.client_reference_id !== null && session.client_reference_id !== target.user) return;
        if (session.mode !== target.product.mode) return;
        const { user, product } = target;
        const customer = matching(session.customer, CUSTOMER);
        const id = product.mode === 'subscription' ? matching(session.subscription, SUBSCRIPTION) : (matching(session.payment_intent, PAYMENT_INTENT) ?? matching(session.id, CHECKOUT_SESSION));
        if (!id) return;
        const name = `${product.mode === 'subscription' ? 'subscription' : 'payment'}:${id}`;
        const key = shopKey(name);
        await lock(key, async () => {
          const raw = await store.get(key);
          const held = recordOf(raw);
          // A record that names someone else, or a subscription kept after its account was
          // deleted, is left as it is.
          if (raw !== null && held.user !== user && (held.user !== undefined || product.mode === 'subscription')) return;
          // A subscription keeps its own customer, which the user record may not hold (see
          // portalCustomer).
          const kept = product.mode === 'subscription' ? { ...(customer ? { customer } : {}), ...subscriptionState(held) } : held.revoked === true ? { revoked: true } : {};
          await store.put(key, { user, product: product.id, grants: product.grants, ...kept });
          await addRef(user, name, customer);
        });
      };

      /**
       * A refund or dispute: the payment's record is marked revoked, whatever the catalogue
       * now sells. A reversal of a payment not seen yet (or another app's) leaves a marker, so
       * a completion that arrives later does not grant.
       * @param {unknown} paymentIntent
       */
      const onPaymentReversed = async (paymentIntent) => {
        const pi = matching(paymentIntent, PAYMENT_INTENT);
        if (!pi) return;
        const key = shopKey(`payment:${pi}`);
        await lock(key, async () => {
          const held = recordOf(await store.get(key));
          if (held.revoked === true) return;
          const user = matching(held.user, USER);
          const grants = matching(held.grants, ID);
          if (user && grants) await store.put(key, { user, product: held.product, grants, revoked: true });
          else await store.put(key, { revoked: true }, { ttl: TOMBSTONE_TTL });
        });
      };

      /**
       * @param {Record<string, unknown>} subscription
       * @param {number} created the event's own timestamp, which orders subscription events
       */
      const onSubscription = async (subscription, created) => {
        const id = matching(subscription.id, SUBSCRIPTION);
        const status = matching(subscription.status, STATUS);
        if (!id || !status) return;
        const meta = recordOf(subscription.metadata);
        if (meta.app !== undefined && meta.app !== catalogue.app) return;
        const name = `subscription:${id}`;
        const key = shopKey(name);
        await lock(key, async () => {
          const raw = await store.get(key);
          const held = recordOf(raw);
          const heldStatus = typeof held.status === 'string' ? held.status : null;
          const heldAt = typeof held.eventAt === 'number' ? held.eventAt : null;
          // Once cancelled or expired, nothing about a subscription changes again.
          if (heldStatus !== null && TERMINAL.has(heldStatus)) return;
          // An older event is stale; one from the same second does not undo a revoke.
          if (heldAt !== null && (created < heldAt || (created === heldAt && ACTIVE.has(status) && heldStatus !== null && !ACTIVE.has(heldStatus)))) return;
          const state = { status, eventAt: created, ...(subscription.cancel_at_period_end === true ? { ending: true } : {}) };
          const target = purchaseOf(meta);
          const named = target && target.product.mode === 'subscription' ? { user: target.user, product: target.product.id, grants: target.product.grants } : null;
          const customer = matching(subscription.customer, CUSTOMER);
          if (raw !== null && held.user === undefined) {
            // Its account was deleted, at `deletedAt`. While the subscription is set to end, and
            // once it is over, keep its state and name no one. An event created after the
            // deletion, and after the state it would overturn, that says it will charge again
            // with no end date set is the visitor choosing to keep paying (Renew in the portal
            // tab still open, the owner at their request, or the next period of a renewal made
            // before the deletion that reached the kit late): the subscription is theirs again,
            // as the metadata written at checkout says, so it grants, Manage subscription reaches
            // it and a second one is not sold. Any other event that says it may charge again is
            // not taken as theirs: one from before the deletion (Stripe resends for days, in no
            // order, so a renewal and a later "set to end" can both arrive after it), one from
            // the same second as the state it would overturn, or one that sets an end date
            // (cancelling on a date in the dashboard is not renewing). The state stays naming no
            // one, and the owner is told which subscription to check.
            const deletedAt = typeof held.deletedAt === 'number' ? held.deletedAt : null;
            const charges = !TERMINAL.has(status) && state.ending !== true;
            const dated = subscription.cancel_at !== undefined && subscription.cancel_at !== null;
            const renewed = charges && !dated && (heldAt === null || created > heldAt) && (deletedAt === null || created > deletedAt);
            if (!renewed || !named) {
              if (renewed) log('warn', `kit (${catalogue.app}): subscription ${id} of a deleted account will charge again, and its metadata names nothing this app sells: cancel or refund it in the Stripe dashboard`);
              else if (charges) log('warn', `kit (${catalogue.app}): subscription ${id} of a deleted account may charge again, and no event says it was renewed after the deletion: check it in the Stripe dashboard, and cancel or refund it if it will`);
              // Its account was deleted: keep the state, name no one.
              await store.put(key, deletedAt === null ? state : { ...state, deletedAt }, keptFor(state));
              return;
            }
          }
          const heldUser = matching(held.user, USER);
          const heldGrants = matching(held.grants, ID);
          const owner = heldUser && heldGrants ? { user: heldUser, product: held.product, grants: heldGrants } : named;
          if (!owner) return;
          // The subscription's own customer: two bought before the first one's webhook arrived
          // belong to two (see portalCustomer).
          await store.put(key, { ...owner, ...(customer ? { customer } : {}), ...state });
          await addRef(owner.user, name, customer);
        });
      };

      /**
       * @param {Record<string, unknown>} charge
       * @returns {boolean}
       */
      const fullyRefunded = (charge) => {
        if (charge.refunded === true) return true;
        const { amount, amount_refunded: refunded } = charge;
        return typeof amount === 'number' && typeof refunded === 'number' && amount > 0 && refunded >= amount;
      };

      /**
       * @param {StripeEvent} event
       * @returns {Promise<boolean>} whether the event is a type the kit acts on
       */
      const applyEvent = async (event) => {
        const object = event.object;
        switch (event.type) {
          case 'checkout.session.completed':
          case 'checkout.session.async_payment_succeeded':
            await onCheckoutPaid(object);
            return true;
          case 'checkout.session.async_payment_failed':
            return true;
          case 'charge.refunded':
            if (fullyRefunded(object)) await onPaymentReversed(object.payment_intent);
            return true;
          case 'charge.dispute.created':
            await onPaymentReversed(object.payment_intent);
            return true;
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
            await onSubscription(object, event.created);
            return true;
          default:
            return false;
        }
      };

      router.on('POST', 'webhooks/stripe', async (request) => {
        const payload = await readBytes(request, WEBHOOK_CAP);
        const signed = await verifySignature({ secret: shop.webhookSecret, header: request.headers.get('stripe-signature'), payload, now: now() });
        if (!signed) return failure(400, 'bad_request');
        const event = parseEvent(payload);
        if (!event || event.livemode !== (shop.mode === 'live')) return failure(400, 'bad_request');
        const marker = shopKey(`event:${event.id}`);
        if ((await store.get(marker)) !== null) return json(200, { received: true });
        if (await applyEvent(event)) await store.put(marker, { at: now() }, { ttl: EVENT_TTL });
        return json(200, { received: true });
      });
    }
  }

  /**
   * The route below `api/`: under APP_URL's path when APP_URL is set, else after the first
   * `/api/` (only `config` answers then).
   * @param {string} pathname
   * @returns {string | null}
   */
  const routeOf = (pathname) => {
    if (base !== null) return pathname.startsWith(`${base}api/`) ? pathname.slice(base.length + 4) : null;
    const at = pathname.indexOf('/api/');
    return at < 0 ? null : pathname.slice(at + 5);
  };

  return {
    features: { signIn: config.signIn !== null && store !== null, shop: config.shop !== null && store !== null },
    async handle(request) {
      try {
        const url = new globalThis.URL(request.url);
        const route = routeOf(url.pathname);
        if (route === null) return failure(404, 'not_found');
        return await router.dispatch(request, route, url);
      } catch (error) {
        if (error instanceof HttpError) return failure(error.status, error.code);
        log('error', `kit (${catalogue.app}): ${request.method} failed (${errorName(error)})`);
        return failure(500, 'internal');
      }
    },
  };
}
