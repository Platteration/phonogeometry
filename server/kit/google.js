// @ts-check
// OpenID Connect with Google: the authorize URL, the code exchange and ID-token verification.
// Pure functions; `fetch` is injected, and the three Google addresses are constants, so no
// configuration can point the kit at another host.

import { base64url, fromBase64url, fromUtf8, randomId, safeEqual, sha256, utf8 } from './crypto.js';
import { formEncode, isRecord, readBytes, timeoutSignal } from './http.js';

export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

/** Clock skew allowed on `exp` and `iat`, in milliseconds. */
export const SKEW_MS = 60_000;
const RESPONSE_CAP = 64 * 1024;
const MAX_JWKS_AGE = 86_400;
/** Google's `sub`: up to 255 ASCII characters; in practice digits. */
const SUBJECT = /^[A-Za-z0-9_-]{1,255}$/;
/** An address with no space or control character in it; it is only ever shown as text. */
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,255}$/u;

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */

/**
 * Why a sign-in was refused. `reason` is one of the kit's own words (`token`, `alg`, `kid`,
 * `signature`, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `sub`, `format`, `jwks`, `key`,
 * `crit`), never text from upstream, so it can be logged.
 */
export class AuthError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`sign-in refused: ${reason}`);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

/**
 * A PKCE verifier and its S256 challenge.
 * @returns {Promise<{ verifier: string, challenge: string }>}
 */
export async function pkcePair() {
  const verifier = randomId(32);
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

/**
 * @param {{ clientId: string, redirectUri: string, state: string, nonce: string, challenge: string }} options
 * @returns {string}
 */
export function authorizeUrl({ clientId, redirectUri, state, nonce, challenge }) {
  const url = new globalThis.URL(AUTHORIZE_URL);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', redirectUri);
  params.set('scope', 'openid email');
  params.set('state', state);
  params.set('nonce', nonce);
  params.set('code_challenge', challenge);
  params.set('code_challenge_method', 'S256');
  return url.href;
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>} the JSON body, or undefined when it is not JSON
 */
async function readJsonResponse(response) {
  const text = fromUtf8(await readBytes(response, RESPONSE_CAP));
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Exchanges an authorization code for an ID token (POST form, with the PKCE verifier and the
 * client secret). Any failure, timeout included, is `AuthError('token')`.
 * @param {{ fetch: Fetch, clientId: string, clientSecret: string, redirectUri: string, code: string, verifier: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function exchangeCode({ fetch, clientId, clientSecret, redirectUri, code, verifier, timeoutMs = 10_000 }) {
  let data;
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: formEncode([
        ['code', code],
        ['client_id', clientId],
        ['client_secret', clientSecret],
        ['redirect_uri', redirectUri],
        ['grant_type', 'authorization_code'],
        ['code_verifier', verifier],
      ]),
      redirect: 'manual',
      signal: timeoutSignal(timeoutMs),
    });
    if (response.status !== 200) throw new AuthError('token');
    data = await readJsonResponse(response);
  } catch {
    throw new AuthError('token');
  }
  if (!isRecord(data) || typeof data.id_token !== 'string' || data.id_token.length > 16_384) throw new AuthError('token');
  return data.id_token;
}

/**
 * @param {string | null} header
 * @returns {number} seconds
 */
function maxAge(header) {
  if (!header || /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(header)) return 0;
  const match = /(?:^|,)\s*max-age=(\d{1,9})\s*(?:,|$)/i.exec(header);
  return match ? Math.min(Number(match[1]), MAX_JWKS_AGE) : 0;
}

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
export function createKeyCache({ fetch, now, timeoutMs = 10_000 }) {
  /** @type {Map<string, RsaJwk>} */
  let keys = new Map();
  let until = 0;
  /** @type {Promise<void> | null} */
  let pending = null;

  async function load() {
    let body;
    let header;
    try {
      const response = await fetch(JWKS_URL, { headers: { accept: 'application/json' }, redirect: 'manual', signal: timeoutSignal(timeoutMs) });
      if (response.status !== 200) throw new AuthError('jwks');
      header = response.headers.get('cache-control');
      body = await readJsonResponse(response);
    } catch {
      throw new AuthError('jwks');
    }
    if (!isRecord(body) || !Array.isArray(body.keys)) throw new AuthError('jwks');
    /** @type {Map<string, RsaJwk>} */
    const next = new Map();
    for (const key of body.keys) {
      if (!isRecord(key) || typeof key.kid !== 'string' || key.kty !== 'RSA') continue;
      if (key.alg !== undefined && key.alg !== 'RS256') continue;
      if (key.use !== undefined && key.use !== 'sig') continue;
      if (typeof key.n !== 'string' || typeof key.e !== 'string') continue;
      next.set(key.kid, { kty: 'RSA', n: key.n, e: key.e });
    }
    keys = next;
    until = now() + maxAge(header) * 1000;
  }

  return {
    async find(kid, fresh) {
      if (fresh || now() >= until) {
        pending ??= load().finally(() => {
          pending = null;
        });
        await pending;
      }
      return keys.get(kid) ?? null;
    },
  };
}

/**
 * @param {string | undefined} segment
 * @returns {unknown}
 */
function decodeSegment(segment) {
  const bytes = fromBase64url(segment);
  const text = bytes && fromUtf8(bytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {boolean}
 */
const has = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

/**
 * Verifies a Google ID token and returns who it names. RS256 only; signature against
 * Google's keys; `iss` Google's; `aud` the client id (a string, nothing else); `azp`, when
 * present, the client id; `exp` in the future and `iat` not, with 60 s of skew; `nonce` the
 * one this sign-in sent. The email is returned only when Google says it is verified.
 * @param {string} token
 * @param {{ clientId: string, nonce: string, now: number, keys: KeySource }} expected
 * @returns {Promise<{ sub: string, email?: string }>}
 */
export async function verifyIdToken(token, { clientId, nonce, now, keys }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('format');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeSegment(headerPart);
  if (!isRecord(header)) throw new AuthError('format');
  if (header.alg !== 'RS256') throw new AuthError('alg');
  if (has(header, 'crit')) throw new AuthError('crit');
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256) throw new AuthError('kid');
  const signature = fromBase64url(signaturePart);
  if (!signature || signature.length === 0) throw new AuthError('format');

  const jwk = (await keys.find(kid, false)) ?? (await keys.find(kid, true));
  if (!jwk) throw new AuthError('kid');
  let key;
  try {
    key = await globalThis.crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    throw new AuthError('key');
  }
  const signed = utf8(`${headerPart}.${payloadPart}`);
  if (!(await globalThis.crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signed))) {
    throw new AuthError('signature');
  }

  const claims = decodeSegment(payloadPart);
  if (!isRecord(claims)) throw new AuthError('format');
  if (typeof claims.iss !== 'string' || !ISSUERS.includes(claims.iss)) throw new AuthError('iss');
  if (claims.aud !== clientId) throw new AuthError('aud');
  if (has(claims, 'azp') && claims.azp !== clientId) throw new AuthError('azp');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || now >= claims.exp * 1000 + SKEW_MS) throw new AuthError('exp');
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat * 1000 > now + SKEW_MS) throw new AuthError('iat');
  if (typeof claims.nonce !== 'string' || !(await safeEqual(claims.nonce, nonce))) throw new AuthError('nonce');
  if (typeof claims.sub !== 'string' || !SUBJECT.test(claims.sub)) throw new AuthError('sub');

  /** @type {{ sub: string, email?: string }} */
  const identity = { sub: claims.sub };
  if (claims.email_verified === true && typeof claims.email === 'string' && EMAIL.test(claims.email)) {
    identity.email = claims.email;
  }
  return identity;
}
