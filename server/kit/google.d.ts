// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * A PKCE verifier and its S256 challenge.
 * @returns {Promise<{ verifier: string, challenge: string }>}
 */
export function pkcePair(): Promise<{
    verifier: string;
    challenge: string;
}>;
/**
 * @param {{ clientId: string, redirectUri: string, state: string, nonce: string, challenge: string }} options
 * @returns {string}
 */
export function authorizeUrl({ clientId, redirectUri, state, nonce, challenge }: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    challenge: string;
}): string;
/**
 * Exchanges an authorization code for an ID token (POST form, with the PKCE verifier and the
 * client secret). Any failure, timeout included, is `AuthError('token')`.
 * @param {{ fetch: Fetch, clientId: string, clientSecret: string, redirectUri: string, code: string, verifier: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export function exchangeCode({ fetch, clientId, clientSecret, redirectUri, code, verifier, timeoutMs }: {
    fetch: Fetch;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    verifier: string;
    timeoutMs?: number;
}): Promise<string>;
/**
 * @typedef {{ kty: 'RSA', n: string, e: string }} RsaJwk
 * @typedef {{ find(kid: string, fresh: boolean): Promise<RsaJwk | null> }} KeySource
 */
/**
 * Google's signing keys, cached for as long as the JWKS response's Cache-Control allows (at
 * most a day). `find(kid, true)` fetches again whatever the cache says: the caller does that
 * once for a `kid` the cache does not know, in case Google has rotated its keys.
 * @param {{ fetch: Fetch, now: () => number, timeoutMs?: number }} options
 * @returns {KeySource}
 */
export function createKeyCache({ fetch, now, timeoutMs }: {
    fetch: Fetch;
    now: () => number;
    timeoutMs?: number;
}): KeySource;
/**
 * Verifies a Google ID token and returns who it names. RS256 only; signature against
 * Google's keys; `iss` Google's; `aud` the client id (a string, nothing else); `azp`, when
 * present, the client id; `exp` in the future and `iat` not, with 60 s of skew; `nonce` the
 * one this sign-in sent. The email is returned only when Google says it is verified.
 * @param {string} token
 * @param {{ clientId: string, nonce: string, now: number, keys: KeySource }} expected
 * @returns {Promise<{ sub: string, email?: string }>}
 */
export function verifyIdToken(token: string, { clientId, nonce, now, keys }: {
    clientId: string;
    nonce: string;
    now: number;
    keys: KeySource;
}): Promise<{
    sub: string;
    email?: string;
}>;
export const AUTHORIZE_URL: "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL: "https://oauth2.googleapis.com/token";
export const JWKS_URL: "https://www.googleapis.com/oauth2/v3/certs";
export const ISSUERS: readonly string[];
/** Clock skew allowed on `exp` and `iat`, in milliseconds. */
export const SKEW_MS: 60000;
/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */
/**
 * Why a sign-in was refused. `reason` is one of the kit's own words (`token`, `alg`, `kid`,
 * `signature`, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `sub`, `format`, `jwks`, `key`,
 * `crit`), never text from upstream, so it can be logged.
 */
export class AuthError extends Error {
    /** @param {string} reason */
    constructor(reason: string);
    reason: string;
}
export type RsaJwk = {
    kty: "RSA";
    n: string;
    e: string;
};
export type KeySource = {
    find(kid: string, fresh: boolean): Promise<RsaJwk | null>;
};
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
