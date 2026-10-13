// @ts-check
// Stripe: price lookup, Checkout Session and Customer Portal creation, webhook signature
// verification and event parsing. Pure functions; `fetch` is injected, and the API address is
// a constant, so no configuration can point the kit at another host. The page never loads
// Stripe.js: it navigates to the Checkout URL this returns, and only a signed webhook grants.

import { concatBytes, digestsEqual, fromHex, fromUtf8, hmacSha256, utf8 } from './crypto.js';
import { formEncode, isRecord, readBytes, timeoutSignal } from './http.js';

export const API_BASE = 'https://api.stripe.com/v1';
/** Seconds a webhook's timestamp may be from now, either way. */
export const TOLERANCE_SECONDS = 300;
const RESPONSE_CAP = 1024 * 1024;
const MAX_SIGNATURES = 8;

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */

/** A failed Stripe call. `status` is Stripe's HTTP status, or 0 when none arrived. */
export class StripeError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`stripe call failed (${status})`);
    this.name = 'StripeError';
    this.status = status;
  }
}

/**
 * `live` or `test` from a secret or restricted key's prefix; null for anything else.
 * @param {string} key
 * @returns {'live' | 'test' | null}
 */
export function keyMode(key) {
  const match = /^(?:sk|rk)_(live|test)_[0-9A-Za-z]{10,250}$/.exec(key);
  if (!match) return null;
  return match[1] === 'live' ? 'live' : 'test';
}

/**
 * Stripe's bracket form encoding: `{ a: { b: 1 }, c: [{ d: 2 }] }` → `a[b]=1&c[0][d]=2`.
 * Undefined and null are left out.
 * @param {Record<string, unknown>} params
 * @returns {[string, string][]}
 */
export function flattenParams(params) {
  /** @type {[string, string][]} */
  const out = [];
  /**
   * @param {string} prefix
   * @param {unknown} value
   */
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(prefix ? `${prefix}[${key}]` : key, item);
    else out.push([prefix, String(value)]);
  };
  walk('', params);
  return out;
}

/**
 * @param {{ fetch: Fetch, key: string, method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idempotencyKey?: string, timeoutMs: number }} call
 * @returns {Promise<Record<string, unknown>>}
 */
async function request({ fetch, key, method, path, params, idempotencyKey, timeoutMs }) {
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
  if (params) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const body = params ? formEncode(flattenParams(params)) : undefined;
  const send = () => fetch(`${API_BASE}${path}`, { method, headers, body, redirect: 'manual', signal: timeoutSignal(timeoutMs) });
  let response;
  try {
    response = await send();
  } catch {
    // The request may have reached Stripe before the connection failed. Under the same
    // Idempotency-Key a second try gets back what the first one created, never a second
    // object, which is what the key is for.
    if (!idempotencyKey) throw new StripeError(0);
    try {
      response = await send();
    } catch {
      throw new StripeError(0);
    }
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new StripeError(response.status);
  }
  let data;
  try {
    const text = fromUtf8(await readBytes(response, RESPONSE_CAP));
    data = text === null ? undefined : JSON.parse(text);
  } catch {
    throw new StripeError(response.status);
  }
  if (!isRecord(data)) throw new StripeError(response.status);
  return data;
}

/**
 * @typedef {object} PriceInfo
 * @property {number} unit_amount in the currency's smallest unit
 * @property {string} currency lowercase ISO 4217
 * @property {string} [interval] day, week, month or year, for a recurring price
 * @property {number} [interval_count] intervals between charges, for a recurring price
 */

/**
 * What the page shows for a Price: amount, currency and, when it recurs, how often. Null
 * when the Price is inactive, has no fixed amount, or does not fit the product's mode (a
 * subscription needs a recurring price, a one-time payment a one-time one).
 * @param {{ fetch: Fetch, key: string, price: string, mode: 'payment' | 'subscription', timeoutMs?: number }} options
 * @returns {Promise<PriceInfo | null>}
 */
export async function getPrice({ fetch, key, price, mode, timeoutMs = 10_000 }) {
  const data = await request({ fetch, key, method: 'GET', path: `/prices/${encodeURIComponent(price)}`, timeoutMs });
  if (data.active !== true || typeof data.currency !== 'string' || !/^[a-z]{3}$/.test(data.currency)) return null;
  if (typeof data.unit_amount !== 'number' || !Number.isSafeInteger(data.unit_amount) || data.unit_amount < 0) return null;
  const recurring = data.recurring;
  if (mode === 'payment') {
    if (recurring !== null && recurring !== undefined) return null;
    return { unit_amount: data.unit_amount, currency: data.currency };
  }
  if (!isRecord(recurring) || typeof recurring.interval !== 'string' || !['day', 'week', 'month', 'year'].includes(recurring.interval)) return null;
  const count = recurring.interval_count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
  return { unit_amount: data.unit_amount, currency: data.currency, interval: recurring.interval, interval_count: count };
}

/**
 * Creates a Checkout Session. `client_reference_id` and `metadata.user` carry the user key,
 * `metadata.product` the product and `metadata.app` the app, and the same metadata is copied
 * onto the PaymentIntent (payment mode) or the Subscription (subscription mode), so every
 * event about the purchase can be traced back. A known customer is reused; otherwise payment
 * mode asks Stripe to create one (subscription mode always does). `expiresAt` (Unix seconds,
 * 30 minutes to 24 hours ahead) ends the session sooner than Stripe's default day, so a second
 * tab left open cannot pay for a product the first one already bought much later. Returns the
 * session's id and its URL, which must be an https address.
 * @param {{ fetch: Fetch, key: string, app: string, mode: 'payment' | 'subscription', price: string, user: string, product: string, customer?: string, successUrl: string, cancelUrl: string, expiresAt?: number, idempotencyKey: string, timeoutMs?: number }} options
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function createCheckoutSession(options) {
  const { fetch, key, app, mode, price, user, product, customer, successUrl, cancelUrl, expiresAt, idempotencyKey, timeoutMs = 10_000 } = options;
  const metadata = { app, user, product };
  /** @type {Record<string, unknown>} */
  const params = {
    mode,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user,
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: expiresAt,
  };
  if (customer) params.customer = customer;
  else if (mode === 'payment') params.customer_creation = 'always';
  if (mode === 'payment') params.payment_intent_data = { metadata };
  else params.subscription_data = { metadata };
  const data = await request({ fetch, key, method: 'POST', path: '/checkout/sessions', params, idempotencyKey, timeoutMs });
  if (typeof data.id !== 'string' || typeof data.url !== 'string' || !data.url.startsWith('https://')) throw new StripeError(200);
  return { id: data.id, url: data.url };
}

/**
 * Creates a Customer Portal session for `customer`, returning to `returnUrl`.
 * @param {{ fetch: Fetch, key: string, customer: string, returnUrl: string, idempotencyKey: string, timeoutMs?: number }} options
 * @returns {Promise<{ url: string }>}
 */
export async function createPortalSession({ fetch, key, customer, returnUrl, idempotencyKey, timeoutMs = 10_000 }) {
  const data = await request({
    fetch,
    key,
    method: 'POST',
    path: '/billing_portal/sessions',
    params: { customer, return_url: returnUrl },
    idempotencyKey,
    timeoutMs,
  });
  if (typeof data.url !== 'string' || !data.url.startsWith('https://')) throw new StripeError(200);
  return { url: data.url };
}

/**
 * `Stripe-Signature: t=<unix>,v1=<hex>,v1=<hex>,v0=…` read into its timestamp and every v1
 * signature. Null when there is no `t`, more than one, a `t` that is not digits, or no v1.
 * @param {string | null} header
 * @returns {{ t: number, v1: Uint8Array[] } | null}
 */
export function parseSignatureHeader(header) {
  if (header === null || header.length > 4096) return null;
  /** @type {number | null} */
  let t = null;
  /** @type {Uint8Array[]} */
  const v1 = [];
  for (const item of header.split(',')) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (name === 't') {
      if (t !== null || !/^\d{1,12}$/.test(value)) return null;
      t = Number(value);
    } else if (name === 'v1') {
      const bytes = value.length === 64 ? fromHex(value) : null;
      if (bytes && v1.length < MAX_SIGNATURES) v1.push(bytes);
    }
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Whether `payload` (the raw body, as received) carries a valid Stripe signature: a
 * timestamp within the tolerance of `now`, either way, and at least one v1 equal to
 * HMAC-SHA256(secret, t + "." + payload). Nothing about the request is authenticated yet and
 * the body may be 512 KiB, so the HMAC is computed once, however many v1 values the header
 * carries, and each v1 is compared with it by digestsEqual, which visits every byte: every v1
 * is compared, and none ends the loop early.
 * @param {{ secret: string, header: string | null, payload: Uint8Array, now: number, tolerance?: number }} options
 * @returns {Promise<boolean>}
 */
export async function verifySignature({ secret, header, payload, now, tolerance = TOLERANCE_SECONDS }) {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(now / 1000 - parsed.t) > tolerance) return false;
  const expected = await hmacSha256(secret, concatBytes([utf8(`${parsed.t}.`), payload]));
  let valid = false;
  for (const signature of parsed.v1) valid = digestsEqual(expected, signature) || valid;
  return valid;
}

/**
 * @typedef {object} StripeEvent
 * @property {string} id
 * @property {string} type
 * @property {boolean} livemode
 * @property {number} created
 * @property {Record<string, unknown>} object the event's `data.object`
 */

/**
 * The parts of a verified event the kit reads; null when the body is not an event.
 * @param {Uint8Array} payload
 * @returns {StripeEvent | null}
 */
export function parseEvent(payload) {
  const text = fromUtf8(payload);
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.data) || !isRecord(data.data.object)) return null;
  const { id, type, livemode, created } = data;
  if (typeof id !== 'string' || !/^evt_[0-9A-Za-z]{1,250}$/.test(id)) return null;
  if (typeof type !== 'string' || type.length > 100) return null;
  if (typeof livemode !== 'boolean') return null;
  if (typeof created !== 'number' || !Number.isSafeInteger(created)) return null;
  return { id, type, livemode, created, object: data.data.object };
}
