// @ts-check
// What is configured, and nothing else: the app's catalogue, the environment read into what is
// on and what is off, and where a sign-in may send the browser back to. Pure functions with no
// store, no fetch and no state, so a server that keeps its own accounts and sessions (and so
// does not run app.js) can check a catalogue, name a product's price variable, read the same
// configuration and keep a return path on the site exactly as the kit does. app.js re-exports
// every name here.

import { fromBase64url } from './crypto.js';
import { isRecord } from './http.js';
import { keyMode } from './stripe.js';

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
/** The longest return path kept, once the URL parser has percent-encoded it. */
const MAX_RETURN = 1024;
/** Percent-decodings of a return path checked before one that still changes is refused. */
const DECODE_ROUNDS = 3;

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
  if (!has.store) signInProblems.push('no store (KIT_STORE on Cloudflare, KIT_DATA_DIR under Node)');
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
 * Where to send the browser after signing in: a path on the site, or the site's root.
 *
 * The input must start with exactly one `/`, hold no backslash and no control character, both
 * as given and once percent-decoded, resolve (dot segments and all) under APP_URL's path, and
 * not lie under `api/`. Anything else becomes the root. The URL parser drops tabs and newlines,
 * which is why control characters are refused before it runs.
 *
 * Then the result itself is held to what the input was: it is read as a path on this site, never
 * as another host, by whatever reads it, which need not be the kit's own callback (that writes
 * APP_URL's origin in front). A browser reads `//evil.example`, or `/\evil.example`, in a
 * Location header or a link as another host; resolving dot segments can make one
 * (`/.//evil.example` and `/x/..//evil.example` are `//evil.example` once resolved); and a server
 * or a client-side router that percent-decodes the path before using it reads `/%2Fevil.example`
 * as `//evil.example`. So the result, and every string percent-decoding it again makes, must
 * start with exactly one `/`, hold no backslash and no control character, and not resolve to a
 * path that starts with `//`. A result that still decodes to something new after DECODE_ROUNDS
 * rounds is refused rather than followed further: no path the site writes is encoded that deep.
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
  return path.length > MAX_RETURN || !staysOnSite(path) ? root : path;
}

/** Any base will do: only whether a resolved path starts with `//` is read off it. */
const SOMEWHERE = 'https://somewhere.invalid/';

/**
 * Whether `path`, and every string that percent-decoding it again and again makes, is a plain
 * path (one leading `/`, no backslash, no control character) that does not resolve, dot
 * segments and all, to one starting with `//`. Decoding is byte by byte and lenient, as the
 * most forgiving decoder reads it: a `%` not followed by two hex digits stays as it is, and a
 * byte above 0x7f stays a byte, which a decoder that follows UTF-8 never turns into a slash or
 * a dot.
 * @param {string} path
 * @returns {boolean}
 */
function staysOnSite(path) {
  let text = path;
  for (let round = 0; ; round += 1) {
    if (!isPlainPath(text) || new globalThis.URL(text, SOMEWHERE).pathname.startsWith('//')) return false;
    const next = text.replace(/%([0-9A-Fa-f]{2})/g, (_sequence, byte) => String.fromCharCode(Number.parseInt(byte, 16)));
    if (next === text) return true;
    if (round === DECODE_ROUNDS) return false;
    text = next;
  }
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
