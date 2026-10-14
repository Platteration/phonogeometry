// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
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
export function createApp(options: AppOptions): App;
/**
 * the purchase records of
 *   one user in one Stripe mode, and their Stripe customer there
 */
export type UserRecord = {
    refs: Set<string>;
    customer: string | null;
};
export type Session = {
    hash: string;
    user: string;
    email?: string;
};
export type AppOptions = {
    /**
     * the app's catalogue (validated here; a malformed one throws)
     */
    catalogue: unknown;
    /**
     * the variables: Node's environment, or Cloudflare's context.env
     */
    env: Record<string, unknown>;
    /**
     * where sessions, users and markers live; null turns everything off
     */
    store: Store | null;
    /**
     * the only way out to Google and Stripe; tests inject fakes here
     */
    fetch: Fetch;
    /**
     * milliseconds since the epoch
     */
    now?: (() => number) | undefined;
    log?: Log | undefined;
    /**
     * per upstream call; 10 s
     */
    timeoutMs?: number | undefined;
    /**
     * how long `GET config` waits for a price lookup before it
     * answers without that price (the lookup goes on, and fills the price in); 2.5 s
     */
    priceWaitMs?: number | undefined;
};
/**
 * what the host offers the request beyond the request itself
 */
export type HostContext = {
    /**
     * keeps work the answer does not wait
     * for alive after the answer has gone (Cloudflare's `context.waitUntil`); a long-lived process
     * needs none
     */
    waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
};
export type App = {
    /**
     * never throws
     */
    handle: (request: Request, context?: HostContext) => Promise<Response>;
    features: {
        signIn: boolean;
        shop: boolean;
    };
};
export type Store = import("./store.js").Store;
export type Fetch = import("./google.js").Fetch;
export type KeySource = import("./google.js").KeySource;
export type PriceInfo = import("./stripe.js").PriceInfo;
export type StripeEvent = import("./stripe.js").StripeEvent;
export type Product = import("./config.js").Product;
export type Catalogue = import("./config.js").Catalogue;
export type SignIn = import("./config.js").SignIn;
export type Shop = import("./config.js").Shop;
export type Config = import("./config.js").Config;
export type Log = (level: "warn" | "error", message: string) => void;
export { ID, priceVariable, readConfig, safeReturnPath, validateCatalogue } from "./config.js";
