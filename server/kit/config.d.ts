// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * Checks the app's catalogue and returns a frozen copy. A malformed catalogue is a
 * programming error, so it throws (TypeError) rather than turning a feature off.
 * @param {unknown} input
 * @returns {Catalogue}
 */
export function validateCatalogue(input: unknown): Catalogue;
/**
 * The environment variable that holds a product's Stripe Price id: `pro` → STRIPE_PRICE_PRO,
 * `pack-a` → STRIPE_PRICE_PACK_A. Product ids have no underscore, so no two collide.
 * @param {string} productId
 * @returns {string}
 */
export function priceVariable(productId: string): string;
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
export function readConfig(env: Record<string, unknown>, catalogue: Catalogue, has: {
    store: boolean;
}): Config;
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
export function safeReturnPath(value: unknown, appUrl: URL): string;
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
export const ID: RegExp;
export type Product = {
    /**
     * matches ^[a-z][a-z0-9-]{0,31}$; its price is STRIPE_PRICE_<ID>
     */
    id: string;
    name: string;
    description: string;
    mode: "payment" | "subscription";
    /**
     * the entitlement id a purchase unlocks
     */
    grants: string;
};
export type Catalogue = {
    /**
     * matches ^[a-z][a-z0-9-]{0,31}$; names the cookies and tags the payments
     */
    app: string;
    name: string;
    products: readonly Product[];
};
export type SignIn = {
    appUrl: URL;
    /**
     * SESSION_SECRET's bytes
     */
    secret: Uint8Array;
    clientId: string;
    clientSecret: string;
};
export type Shop = {
    /**
     * STRIPE_SECRET_KEY
     */
    key: string;
    /**
     * told by the key's prefix
     */
    mode: "live" | "test";
    webhookSecret: string;
    /**
     * product id → Stripe Price id
     */
    prices: Map<string, string>;
};
export type Config = {
    appUrl: URL | null;
    signIn: SignIn | null;
    shop: Shop | null;
    /**
     * the Stripe mode whose purchase records the kit reads and
     * writes: the key's, or live when no well-formed key is set. A test-mode purchase is never
     * read under a live key, and a test-mode customer id never sent to one.
     */
    records: "live" | "test";
    /**
     * one line naming what is missing or malformed, never a value
     */
    warning: string | null;
};
