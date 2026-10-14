// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * `live` or `test` from a secret or restricted key's prefix; null for anything else.
 * @param {string} key
 * @returns {'live' | 'test' | null}
 */
export function keyMode(key: string): "live" | "test" | null;
/**
 * Stripe's bracket form encoding: `{ a: { b: 1 }, c: [{ d: 2 }] }` → `a[b]=1&c[0][d]=2`.
 * Undefined and null are left out.
 * @param {Record<string, unknown>} params
 * @returns {[string, string][]}
 */
export function flattenParams(params: Record<string, unknown>): [string, string][];
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
export function getPrice({ fetch, key, price, mode, timeoutMs }: {
    fetch: Fetch;
    key: string;
    price: string;
    mode: "payment" | "subscription";
    timeoutMs?: number;
}): Promise<PriceInfo | null>;
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
export function createCheckoutSession(options: {
    fetch: Fetch;
    key: string;
    app: string;
    mode: "payment" | "subscription";
    price: string;
    user: string;
    product: string;
    customer?: string;
    successUrl: string;
    cancelUrl: string;
    expiresAt?: number;
    idempotencyKey: string;
    timeoutMs?: number;
}): Promise<{
    id: string;
    url: string;
}>;
/**
 * A Checkout Session's state: `open` (it can still be paid), `complete` (it was paid, or a
 * delayed payment is on its way) or `expired` (it can no longer be paid), its URL while it is
 * open, and the ids of the PaymentIntent (payment mode) and the Subscription (subscription
 * mode) it made, when Stripe names them: what the webhook records the purchase under.
 * @param {{ fetch: Fetch, key: string, id: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: 'open' | 'complete' | 'expired', url: string | null, paymentIntent: string | null, subscription: string | null }>}
 */
export function getCheckoutSession({ fetch, key, id, timeoutMs }: {
    fetch: Fetch;
    key: string;
    id: string;
    timeoutMs?: number;
}): Promise<{
    status: "open" | "complete" | "expired";
    url: string | null;
    paymentIntent: string | null;
    subscription: string | null;
}>;
/**
 * Creates a Customer Portal session for `customer`, returning to `returnUrl`.
 * @param {{ fetch: Fetch, key: string, customer: string, returnUrl: string, idempotencyKey: string, timeoutMs?: number }} options
 * @returns {Promise<{ url: string }>}
 */
export function createPortalSession({ fetch, key, customer, returnUrl, idempotencyKey, timeoutMs }: {
    fetch: Fetch;
    key: string;
    customer: string;
    returnUrl: string;
    idempotencyKey: string;
    timeoutMs?: number;
}): Promise<{
    url: string;
}>;
/**
 * `Stripe-Signature: t=<unix>,v1=<hex>,v1=<hex>,v0=…` read into its timestamp and every v1
 * signature. Null when there is no `t`, more than one, a `t` that is not digits, or no v1.
 * @param {string | null} header
 * @returns {{ t: number, v1: Uint8Array[] } | null}
 */
export function parseSignatureHeader(header: string | null): {
    t: number;
    v1: Uint8Array[];
} | null;
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
export function verifySignature({ secret, header, payload, now, tolerance }: {
    secret: string;
    header: string | null;
    payload: Uint8Array;
    now: number;
    tolerance?: number;
}): Promise<boolean>;
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
export function parseEvent(payload: Uint8Array): StripeEvent | null;
export const API_BASE: "https://api.stripe.com/v1";
/** Seconds a webhook's timestamp may be from now, either way. */
export const TOLERANCE_SECONDS: 300;
/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */
/**
 * A failed Stripe call. `status` is Stripe's HTTP status, or 0 when none arrived. `code` and
 * `param` are Stripe's error code (`resource_missing`) and the parameter it names (`customer`),
 * when its answer carried them as identifiers, else null: they say what failed and may be
 * logged, unlike Stripe's message, which is never read.
 */
export class StripeError extends Error {
    /**
     * @param {number} status
     * @param {{ code?: string | null, param?: string | null }} [detail]
     */
    constructor(status: number, detail?: {
        code?: string | null;
        param?: string | null;
    });
    status: number;
    /** @type {string | null} */
    code: string | null;
    /** @type {string | null} */
    param: string | null;
}
export type PriceInfo = {
    /**
     * in the currency's smallest unit
     */
    unit_amount: number;
    /**
     * lowercase ISO 4217
     */
    currency: string;
    /**
     * day, week, month or year, for a recurring price
     */
    interval?: string | undefined;
    /**
     * intervals between charges, for a recurring price
     */
    interval_count?: number | undefined;
};
export type StripeEvent = {
    id: string;
    type: string;
    livemode: boolean;
    created: number;
    /**
     * the event's `data.object`
     */
    object: Record<string, unknown>;
};
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
