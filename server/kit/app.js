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
// their Stripe customer, written by the webhook, by account deletion, and by Buy or Manage
// subscription only to forget a customer Stripe says it no longer has.

import { base64url, fromBase64url, fromUtf8, hex, hmacSha256, hmacVerify, randomBytes, randomId, safeEqual, sha256, utf8 } from './crypto.js';
import { HttpError, clearCookie, createRouter, csrfRefusal, failure, isRecord, json, noContent, parseCookies, readBytes, readJson, redirect, serializeCookie, timeoutSignal } from './http.js';
import { AuthError, authorizeUrl, createKeyCache, exchangeCode, pkcePair, verifyIdToken } from './google.js';
import { StripeError, createCheckoutSession, createPortalSession, getCheckoutSession, getPrice, parseEvent, verifySignature } from './stripe.js';
import { ID, readConfig, safeReturnPath, validateCatalogue } from './config.js';

// What is configured (the catalogue, the environment, the return path) lives in config.js, which
// a server that keeps its own accounts imports without this file; every name there is here too.
export { ID, priceVariable, readConfig, safeReturnPath, validateCatalogue } from './config.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('./google.js').Fetch} Fetch */
/** @typedef {import('./google.js').KeySource} KeySource */
/** @typedef {import('./stripe.js').PriceInfo} PriceInfo */
/** @typedef {import('./stripe.js').StripeEvent} StripeEvent */
/** @typedef {import('./config.js').Product} Product */
/** @typedef {import('./config.js').Catalogue} Catalogue */
/** @typedef {import('./config.js').SignIn} SignIn */
/** @typedef {import('./config.js').Shop} Shop */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {(level: 'warn' | 'error', message: string) => void} Log */

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
/**
 * Presses that read the same state within one of these windows of the clock send Stripe the
 * same request under the same Idempotency-Key, and are given one Checkout Session wherever they
 * are handled (see POST checkout). A session expires CHECKOUT_TTL after its window began, so 55
 * to 60 minutes after it is made.
 */
const CHECKOUT_WINDOW_MS = 5 * 60_000;
/**
 * How long a session whose delayed payment failed is remembered as failed: past a window (and KV's
 * minute), after which no press can share the key of the press that made it.
 */
const FAILED_TTL = 3_600;
/**
 * How long the Checkout Session a visitor was last given for a product is remembered, so that a
 * second Buy reaches it, or the purchase made with it, rather than a second session: as long as
 * Stripe keeps an event, which outlasts its retries and a delayed payment (sooner only when that
 * payment fails, or the account is deleted).
 */
const PENDING_TTL = 30 * 86_400;
const TOMBSTONE_TTL = 90 * 86_400;
const RATE_TTL = 2 * 3_600;
const HOUR_MS = 3_600_000;
const CHECKOUTS_PER_HOUR = 10;
const PORTALS_PER_HOUR = 10;
const MAX_SESSIONS = 20;
const WEBHOOK_CAP = 512 * 1024;
const REQUEST_CAP = 4 * 1024;
const PRICE_TTL_MS = HOUR_MS;
const PRICE_RETRY_MS = 60_000;
/** How long `GET config` waits for a price Stripe has not given yet before answering without it. */
const PRICE_WAIT_MS = 2_500;
const ACTIVE = new Set(['active', 'trialing']);
/** A subscription in one of these is over: Stripe changes nothing about it afterwards. */
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
/** @type {readonly ('live' | 'test')[]} */
const MODES = Object.freeze(['live', 'test']);

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
 * The entitlement of a subscription of `user` that will still charge them, or null. Buy asks this
 * of a subscription that grants nothing now (past due, unpaid, paused or incomplete: once its
 * invoice is paid, or it is resumed, it is active again and charges every period), and refuses
 * that entitlement while there is one (409 `subscription_active`): a second purchase sold beside
 * it would charge too once it recovers.
 * @param {string} name the record's name
 * @param {unknown} raw the record
 * @param {string} user
 * @returns {string | null}
 */
function charging(name, raw, user) {
  return name.startsWith('subscription:') && stillCharging(raw, user) ? matching(recordOf(raw).grants, ID) : null;
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
 * How long a subscription's record is kept, whether it names its account or (once that was
 * deleted) no one: with no expiry while the subscription can still change (one set to end with
 * its period may run on for a year, and its last event must still find it), and for as long as
 * Stripe may resend an older event once it is over. So a record that names no one does not
 * outlive the subscription by more than that, and neither does one that names an account, a
 * record written back after the account's deletion included (see Limits in the README).
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
 * @property {number} [priceWaitMs] how long `GET config` waits for a price lookup before it
 *   answers without that price (the lookup goes on, and fills the price in); 2.5 s
 */

/**
 * @typedef {object} HostContext what the host offers the request beyond the request itself
 * @property {(promise: Promise<unknown>) => void} [waitUntil] keeps work the answer does not wait
 *   for alive after the answer has gone (Cloudflare's `context.waitUntil`); a long-lived process
 *   needs none
 */

/**
 * @typedef {object} App
 * @property {(request: Request, context?: HostContext) => Promise<Response>} handle never throws
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
  const priceWaitMs = options.priceWaitMs ?? PRICE_WAIT_MS;
  const store = options.store ?? null;
  const config = readConfig(options.env ?? {}, catalogue, { store: store !== null });
  if (config.warning) log('warn', config.warning);
  const products = new Map(catalogue.products.map((product) => [product.id, product]));
  const base = config.appUrl ? config.appUrl.pathname : null;
  const router = createRouter();

  /** The host's `waitUntil` for each request handle() was given one with. */
  /** @type {WeakMap<Request, (promise: Promise<unknown>) => void>} */
  const waitUntils = new WeakMap();
  router.on('GET', 'config', (request) => getConfig(waitUntils.get(request)));

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

  /**
   * Runs `task` holding every lock in `keys`, taken one after another in sorted order. Locks are
   * taken in one order everywhere: a pending checkout's marker, then a user record, then purchase
   * records, and no task holding a purchase record's lock waits for another lock. So no two tasks
   * can each hold what the other waits for.
   * @template T
   * @param {string[]} keys
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const lockAll = (keys, task) => {
    const sorted = [...new Set(keys)].sort();
    /**
     * @param {number} index
     * @returns {Promise<T>}
     */
    const from = (index) => {
      const key = sorted[index];
      return key === undefined ? task() : lock(key, () => from(index + 1));
    };
    return from(0);
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
  /**
   * The Checkout Session a visitor was given for a product, while its webhook has not said how
   * it ended (see POST checkout).
   * @param {string} user
   * @param {string} product
   * @param {'live' | 'test'} [mode]
   */
  const pendingKey = (user, product, mode) => shopKey(`checkout:${user}:${product}`, mode);

  /** @type {Map<string, { value: PriceInfo | null, known: boolean, until: number }>} */
  const priceCache = new Map();
  /** @type {Map<string, { lookup: Promise<{ value: PriceInfo | null, known: boolean }>, since: number }>} */
  const pricePending = new Map();

  const shop = config.shop;
  /**
   * A product's price, from Stripe, cached in memory for an hour (a failed lookup for a minute).
   * `known` says whether Stripe answered: a price it answered with that is not usable (no fixed
   * amount, inactive, or not of the product's kind) means the product is not sold, while a
   * lookup that failed lists the product without a price and leaves the judgement to Checkout.
   * Requests made while a lookup is under way share it. One that has run past its own time
   * limit is not waited on again: a new one starts, so a lookup the host stopped short (a
   * Function's work cut off once its answer went out) cannot hold every later one.
   * @param {Product} product
   * @returns {Promise<{ value: PriceInfo | null, known: boolean }>}
   */
  const priceOf = async (product) => {
    const price = shop?.prices.get(product.id);
    if (!shop || !price) return { value: null, known: false };
    const cached = priceCache.get(product.id);
    if (cached && cached.until > now()) return cached;
    let pending = pricePending.get(product.id);
    if (!pending || pending.since + timeoutMs < now()) {
      const since = now();
      const lookup = (async () => {
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
      pending = { lookup, since };
      pricePending.set(product.id, pending);
    }
    return pending.lookup;
  };

  /**
   * The products on sale, each with its price when Stripe has given it. The page asks this
   * once, before it draws, so it does not wait on Stripe for longer than priceWaitMs: a price
   * not known by then is left out of this answer, which is then not to be cached, and its lookup
   * goes on (under the host's `waitUntil`, where it has one) and fills the price in for the next.
   * @param {(promise: Promise<unknown>) => void} [waitUntil]
   */
  async function getConfig(waitUntil) {
    /** @type {Record<string, unknown>[]} */
    const listed = [];
    let late = false;
    if (shop) {
      const sold = catalogue.products.filter((product) => shop.prices.has(product.id));
      const lookups = sold.map(priceOf);
      /** @type {({ value: PriceInfo | null, known: boolean } | null)[]} */
      let found;
      if (sold.every((product) => (priceCache.get(product.id)?.until ?? 0) > now())) found = await Promise.all(lookups);
      else {
        const signal = timeoutSignal(priceWaitMs);
        /** @type {Promise<null>} */
        const timer = new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
        found = await Promise.all(lookups.map((lookup) => Promise.race([lookup, timer])));
        late = found.includes(null);
        if (late && waitUntil) waitUntil(Promise.allSettled(lookups));
      }
      sold.forEach((product, index) => {
        const price = found[index];
        if (price?.known && !price.value) return;
        listed.push({ id: product.id, name: product.name, description: product.description, mode: product.mode, ...(price?.value ? { price: price.value } : {}) });
      });
    }
    return json(200, { auth: { google: config.signIn !== null }, shop: { products: listed } }, { cache: late ? 'no-store' : 'public, max-age=60' });
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
     * The user's record in the configured mode, the entitlements its purchase records give, and
     * those of its subscriptions that will still charge (see charging).
     * @param {string} user
     * @returns {Promise<{ record: UserRecord, held: Set<string>, charged: Set<string> }>}
     */
    const holdings = async (user) => {
      const record = readUserRecord(await store.get(userKey(user)));
      const names = [...record.refs];
      const found = await Promise.all(names.map((name) => store.get(shopKey(name))));
      /** @type {Set<string>} */
      const held = new Set();
      /** @type {Set<string>} */
      const charged = new Set();
      names.forEach((name, index) => {
        const grants = liveGrant(name, found[index], user);
        if (grants) held.add(grants);
        const charges = charging(name, found[index], user);
        if (charges) charged.add(charges);
      });
      return { record, held, charged };
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
      // Every record this deletes or rewrites is read and written under its own lock, as the
      // webhook writes it, in the one order locks are taken: the pending checkouts' markers, the
      // user record, then its purchase records. Within one process (the Node adapter, one
      // isolate) an event about one of them handled meanwhile is applied wholly before the
      // deletion reads that record or wholly after it was rewritten naming no one, and the
      // webhook adds a purchase to the user record only while the purchase still names the user
      // (addRef), so it cannot write the account back. No lock spans two isolates or two KV
      // locations: a Buy handled elsewhere at the same moment is not waited for (see Deleting an
      // account and Limits in the README). The markers are those of every product the catalogue
      // lists, sold or not, and with the shop off too: one written while the shop was on names
      // the account.
      const markers = MODES.flatMap((mode) => catalogue.products.map((product) => pendingKey(user, product.id, mode)));
      return lockAll(markers, () =>
        lock(userKey(user), async () => {
          /** @type {Map<'live' | 'test', UserRecord>} */
          const records = new Map();
          for (const mode of MODES) records.set(mode, readUserRecord(await store.get(userKey(user, mode))));
          const purchases = [...records].flatMap(([mode, record]) => [...record.refs].map((name) => shopKey(name, mode)));
          return lockAll(purchases, async () => {
            // A subscription that will charge again keeps the only copy of the Stripe customer,
            // which is what Manage subscription needs: the visitor cancels first (at the period's
            // end is enough), then deletes. Both Stripe modes are checked, as both are deleted: a
            // namespace shared by Preview (a test key) and Production (a live key) holds both.
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
                // A subscription keeps its own state and the time of the deletion, with no one
                // named (its Stripe customer neither), until it is over and then for as long as
                // Stripe may resend an older event about it. Only an event created after the
                // deletion that says it will charge again, with no end date, makes it theirs again
                // (onSubscription): no event about it from before the deletion, retried by Stripe
                // in whatever order, and not its last one, can grant it again or write the account
                // back.
                if (name.startsWith('subscription:')) {
                  const state = { ...subscriptionState(held), deletedAt: Math.floor(now() / 1000) };
                  await store.put(key, state, keptFor(state));
                } else await store.delete(key);
              }
              await store.delete(userKey(user, mode));
            }
            // The Checkout Sessions remembered for a second Buy name the account in their keys.
            for (const key of markers) if ((await store.get(key)) !== null) await store.delete(key);
            return noContent({ cookies: [clearCookie(sessionCookie)] });
          });
        }),
      );
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

      /**
       * Whether Stripe refused a call because it no longer knows the customer sent with it (one
       * deleted in the dashboard, or with all of test mode's data).
       * @param {unknown} error
       * @returns {boolean}
       */
      const missingCustomer = (error) => error instanceof StripeError && error.status === 400 && error.code === 'resource_missing' && error.param === 'customer';

      /**
       * What the owner's log says of a failed Stripe call: its status, and Stripe's error code
       * and the parameter it names when it gave them (identifiers, never its message).
       * @param {StripeError} error
       * @returns {string}
       */
      const stripeFailure = (error) => `Stripe ${error.status}${error.code ? ` ${error.code}` : ''}${error.param ? ` on ${error.param}` : ''}`;

      /**
       * Forgets a Stripe customer Stripe no longer knows: from the user record, and from every
       * subscription record of the user that names it, each under its own lock (the user
       * record's first, as everywhere). Kept, it was sent with every later Checkout and portal
       * session, and each failed. The log names the field, never the customer.
       * @param {string} user
       * @param {string} customer
       */
      const forgetCustomer = (user, customer) =>
        lock(userKey(user), async () => {
          log('warn', `kit (${catalogue.app}): Stripe no longer knows the customer kept for an account (customer): it is forgotten, and the next checkout lets Stripe make a new one`);
          const record = readUserRecord(await store.get(userKey(user)));
          if (record.customer === customer) {
            record.customer = null;
            await store.put(userKey(user), writeUserRecord(record));
          }
          for (const name of [...record.refs].filter((ref) => ref.startsWith('subscription:')).sort()) {
            const key = shopKey(name);
            await lock(key, async () => {
              const held = { ...recordOf(await store.get(key)) };
              if (held.customer !== customer) return;
              delete held.customer;
              await store.put(key, held, keptFor(held));
            });
          }
        });

      /**
       * The Checkout Session a visitor was last given for a product, as its marker holds it: its
       * id, and its address, which is null once its delayed payment failed (see settlePending).
       * @param {unknown} raw
       * @returns {{ id: string, url: string | null } | null}
       */
      const readPending = (raw) => {
        const held = recordOf(raw);
        const id = matching(held.id, CHECKOUT_SESSION);
        if (!id) return null;
        if (held.failed === true) return { id, url: null };
        return typeof held.url === 'string' && held.url.startsWith('https://') ? { id, url: held.url } : null;
      };

      /**
       * What Stripe says of a Checkout Session the kit made: null when it has no such session
       * (nothing can be paid on it).
       * @param {string} id
       */
      const checkoutState = async (id) => {
        try {
          return await getCheckoutSession({ fetch, key: shop.key, id, timeoutMs });
        } catch (error) {
          if (error instanceof StripeError && error.status === 404) return null;
          throw error;
        }
      };

      /**
       * Why a Buy is refused once the Checkout Session the visitor was given for `product` has
       * been paid (Stripe reports it complete), decided from the purchase record its webhook
       * writes, under the name the webhook gives it: `payment_pending` while there is none (the
       * webhook has not arrived, or not where this request is handled), `already_owned` while it
       * grants, `subscription_active` while its subscription grants nothing and will still
       * charge; null once it was refunded, disputed or has ended, when a new session may be made.
       * The marker is kept after the webhook for this reason: on KV the location handling the
       * visitor's requests can serve, for a minute, a user record its page read before the
       * webhook, which does not list the purchase; this record does, from the first time that
       * location reads it after the webhook (a read made earlier, by a Buy pressed before the
       * webhook, is served for a minute too, and answers payment_pending meanwhile). No answer
       * here is a sale.
       * @param {string} user
       * @param {Product} product
       * @param {string} id the session's id
       * @param {{ paymentIntent: string | null, subscription: string | null }} state what Stripe says of it
       * @returns {Promise<'payment_pending' | 'already_owned' | 'subscription_active' | null>}
       */
      const afterPayment = async (user, product, id, state) => {
        const ref = product.mode === 'subscription' ? matching(state.subscription, SUBSCRIPTION) : (matching(state.paymentIntent, PAYMENT_INTENT) ?? id);
        if (!ref) return 'payment_pending';
        const name = `${product.mode === 'subscription' ? 'subscription' : 'payment'}:${ref}`;
        const raw = await store.get(shopKey(name));
        if (raw === null) return 'payment_pending';
        if (liveGrant(name, raw, user)) return 'already_owned';
        if (charging(name, raw, user)) return 'subscription_active';
        return null;
      };

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
        const user = session.user;
        const marker = pendingKey(user, product.id);
        // One Checkout Session per visitor and product: a second Buy (another tab, the page back
        // from Checkout before the webhook, a reload) reaches the same session while it is open,
        // and once it is paid is refused for as long as the purchase made with it is still
        // pending, granting or charging (afterPayment), so the two cannot both be paid. A new
        // session is made only once the last one expired unpaid, its delayed payment failed, or
        // what it bought was refunded or has ended. Under the marker's lock, so two presses at
        // once in one process make one session; presses this lock does not reach (another
        // isolate, another location) share the session through the Idempotency-Key below.
        return lock(marker, async () => {
          // The sign-in was read before the body and the price; a deletion that ran meanwhile
          // ended it, and has let go of every marker, so nothing is made for that account.
          if ((await currentSession(request))?.user !== user) return failure(401, 'unauthorized');
          const { record, held, charged } = await holdings(user);
          if (held.has(product.grants)) return failure(409, 'already_owned');
          // Not held, yet a subscription to it will still charge (past due, unpaid, paused):
          // once paid or resumed it is active again, so Manage subscription, not a second sale.
          if (charged.has(product.grants)) return failure(409, 'subscription_active');
          const pending = readPending(await store.get(marker));
          const hour = Math.floor(now() / HOUR_MS);
          const limited = await rateLimited(shopKey(`ratelimit:${user}:${hour}`), CHECKOUTS_PER_HOUR);
          if (limited) return limited;
          try {
            if (pending?.url) {
              const state = await checkoutState(pending.id);
              if (state?.status === 'open') return json(200, { url: state.url ?? pending.url });
              if (state?.status === 'complete') {
                const refused = await afterPayment(user, product, pending.id, state);
                if (refused) return failure(409, refused);
              }
            }
            // The request and its Idempotency-Key are a function of what this press read: the
            // sign-in, the session remembered (or none), the customer, and the window of the
            // clock it falls in (whose start fixes expires_at, so the request is the same). Every
            // press that read the same within one window, wherever it is handled, sends Stripe
            // the same, and Stripe gives each the session the first one made (or, while that one
            // is still being made, refuses it: a 502, and no session). Stripe keeps a key's answer
            // for a day at least, an error included, so a press that read the same is answered the
            // same until the window ends. A deleted account's next sign-in, or a session whose
            // delayed payment failed (kept as failed), is a state no earlier press read.
            const opened = Math.floor(now() / CHECKOUT_WINDOW_MS) * CHECKOUT_WINDOW_MS;
            /** @param {string | null} customer */
            const create = async (customer) => {
              const sale = {
                app: catalogue.app,
                mode: product.mode,
                price,
                user,
                product: product.id,
                ...(customer ? { customer } : {}),
                successUrl: `${signIn.appUrl.href}?purchase=success`,
                cancelUrl: `${signIn.appUrl.href}?purchase=cancelled`,
                expiresAt: opened / 1000 + CHECKOUT_TTL,
              };
              const read = JSON.stringify([shop.mode, session.hash, pending?.id ?? null, sale]);
              return createCheckoutSession({ fetch, key: shop.key, ...sale, idempotencyKey: `kit-checkout-${base64url(await sha256(read))}`, timeoutMs });
            };
            let created;
            try {
              created = await create(record.customer);
            } catch (error) {
              // A customer Stripe no longer knows is forgotten, and the session made without it.
              if (!record.customer || !missingCustomer(error)) throw error;
              await forgetCustomer(user, record.customer);
              created = await create(null);
            }
            try {
              await store.put(marker, { id: created.id, url: created.url }, { ttl: PENDING_TTL });
            } catch (error) {
              // KV takes one write a second to a key: a press handled at once by another isolate,
              // and given this same session, may have written it first. Anything else is a 500.
              if (readPending(await store.get(marker))?.id !== created.id) throw error;
            }
            return json(200, { url: created.url });
          } catch (error) {
            if (!(error instanceof StripeError)) throw error;
            log('error', `kit (${catalogue.app}): checkout failed (${stripeFailure(error)})`);
            return failure(502, 'upstream_unavailable');
          }
        });
      });

      /**
       * The Stripe customer whose portal Manage subscription opens: that of the first of the
       * user's subscriptions that will still charge them, else the one the user record keeps.
       * Checkout makes a new customer when it is given none, and the user record learns the
       * customer only from a webhook, so two subscriptions bought before the first one's webhook
       * arrived belong to two customers (two Buy presses in two locations within KV's minute, or
       * one bought from the dashboard), and a portal shows one customer's. Each still charging in
       * the configured Stripe mode is reached in turn, as the one before it is set to end, so a
       * 409 from Delete account for a subscription of that mode has a Manage subscription that
       * reaches it. One of the other mode, on a namespace Preview and Production share, is
       * reached from the deployment whose key is of its mode (README, Deleting an account).
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
          // A customer Stripe no longer knows has no portal: it is forgotten, and the visitor
          // told there is nothing to manage (the next press reaches any other there is).
          if (missingCustomer(error)) {
            await forgetCustomer(session.user, customer);
            return failure(404, 'not_found');
          }
          log('error', `kit (${catalogue.app}): portal failed (${stripeFailure(error)})`);
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
          // Taken once the purchase record's own lock is released, never inside it (see lockAll),
          // so it reads the record again: a deletion that ran in between rewrote it naming no one,
          // and the account is not written back.
          if (recordOf(await store.get(shopKey(name))).user !== user) return;
          const record = readUserRecord(await store.get(userKey(user)));
          if (record.refs.has(name) && (customer === null || record.customer !== null)) return;
          record.refs.add(name);
          if (customer && !record.customer) record.customer = customer;
          await store.put(userKey(user), writeUserRecord(record));
        });

      /**
       * Lets go of the Checkout Session remembered for a visitor's product (POST checkout) once
       * its delayed payment failed: nothing was paid, and the visitor may pay another way. Its id
       * is kept, marked failed, for FAILED_TTL: the next Buy then reads a state no earlier press
       * read, and makes a new session under a key of its own, where reading none would share the
       * key of the press that made this one, and Stripe would give this one back. Only the
       * session the marker names: a newer one is still the visitor's to pay. A session that was
       * paid stays remembered (see afterPayment).
       * @param {string} user
       * @param {string} product
       * @param {unknown} id the session's id
       */
      const settlePending = async (user, product, id) => {
        const failed = matching(id, CHECKOUT_SESSION);
        if (failed === null) return;
        const marker = pendingKey(user, product);
        await lock(marker, async () => {
          const held = readPending(await store.get(marker));
          if (held?.id === failed) await store.put(marker, { id: failed, failed: true }, { ttl: FAILED_TTL });
        });
      };

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
        const recorded = await lock(key, async () => {
          const raw = await store.get(key);
          const held = recordOf(raw);
          // A record that names someone else, or a subscription kept after its account was
          // deleted, is left as it is.
          if (raw !== null && held.user !== user && (held.user !== undefined || product.mode === 'subscription')) return false;
          // A subscription keeps its own customer, which the user record may not hold (see
          // portalCustomer).
          const kept = product.mode === 'subscription' ? { ...(customer ? { customer } : {}), ...subscriptionState(held) } : held.revoked === true ? { revoked: true } : {};
          await store.put(key, { user, product: product.id, grants: product.grants, ...kept }, product.mode === 'subscription' ? keptFor(kept) : undefined);
          return true;
        });
        if (recorded) await addRef(user, name, customer);
        // The session the visitor was given stays remembered: a second Buy reads this record
        // through it (afterPayment), wherever the user record has not caught up yet.
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
        const owned = await lock(key, async () => {
          const raw = await store.get(key);
          const held = recordOf(raw);
          const heldStatus = typeof held.status === 'string' ? held.status : null;
          const heldAt = typeof held.eventAt === 'number' ? held.eventAt : null;
          // Once cancelled or expired, nothing about a subscription changes again.
          if (heldStatus !== null && TERMINAL.has(heldStatus)) return null;
          // An older event is stale; one from the same second does not undo a revoke.
          if (heldAt !== null && (created < heldAt || (created === heldAt && ACTIVE.has(status) && heldStatus !== null && !ACTIVE.has(heldStatus)))) return null;
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
              return null;
            }
          }
          const heldUser = matching(held.user, USER);
          const heldGrants = matching(held.grants, ID);
          const owner = heldUser && heldGrants ? { user: heldUser, product: held.product, grants: heldGrants } : named;
          if (!owner) return null;
          // The subscription's own customer: two bought before the first one's webhook arrived
          // belong to two (see portalCustomer). Once it is over, the record goes when a nameless
          // one would (keptFor).
          await store.put(key, { ...owner, ...(customer ? { customer } : {}), ...state }, keptFor(state));
          return { user: owner.user, customer };
        });
        // The user record's lock is taken once this record's is released (see addRef).
        if (owned) await addRef(owned.user, name, owned.customer);
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
          case 'checkout.session.async_payment_failed': {
            // Nothing was paid: the session remembered for a second Buy is let go (kept as failed),
            // so the visitor can pay another way.
            const target = purchaseOf(object.metadata);
            if (target) await settlePending(target.user, target.product.id, object.id);
            return true;
          }
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
    async handle(request, context) {
      try {
        if (context && typeof context.waitUntil === 'function') waitUntils.set(request, context.waitUntil);
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
