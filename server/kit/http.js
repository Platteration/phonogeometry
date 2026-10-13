// @ts-check
// HTTP plumbing: JSON responses carrying the API headers, a router, a body reader whose cap
// holds whether or not the request declares a length, cookies, the CSRF gate and form
// encoding for the upstream APIs.

import { concatBytes, fromUtf8 } from './crypto.js';

/**
 * Sent on every response the kit makes. A host's static `_headers` file does not reach a
 * function's response, so the kit sets its own.
 */
export const API_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const JSON_TYPE = 'application/json; charset=utf-8';

/** An error that becomes a JSON response with this status and code. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   */
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {object} ReplyOptions
 * @property {string} [cache] Cache-Control in place of `no-store`.
 * @property {string[]} [cookies] Set-Cookie values, one header each.
 * @property {Record<string, string>} [headers] Further headers.
 */

/**
 * @param {number} status
 * @param {string | null} body
 * @param {ReplyOptions & { type?: string }} options
 * @returns {Response}
 */
function reply(status, body, options) {
  /** @type {[string, string][]} */
  const headers = [];
  for (const [name, value] of Object.entries(API_HEADERS)) {
    headers.push([name, name === 'Cache-Control' && options.cache ? options.cache : value]);
  }
  if (options.type) headers.push(['Content-Type', options.type]);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.push([name, value]);
  for (const cookie of options.cookies ?? []) headers.push(['Set-Cookie', cookie]);
  return new globalThis.Response(body, { status, headers });
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function json(status, body, options = {}) {
  return reply(status, JSON.stringify(body), { ...options, type: JSON_TYPE });
}

/**
 * `{ error: code }` with this status.
 * @param {number} status
 * @param {string} code
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function failure(status, code, options = {}) {
  return json(status, { error: code }, options);
}

/**
 * 204 No Content: no body and no Content-Type.
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function noContent(options = {}) {
  return reply(204, null, options);
}

/**
 * 302 to an absolute URL: no body and no Content-Type.
 * @param {string} location
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function redirect(location, options = {}) {
  return reply(302, null, { ...options, headers: { ...options.headers, Location: location } });
}

/** @typedef {(request: Request, url: URL) => Promise<Response> | Response} Handler */

/**
 * Exact-path routing: an unknown path is a JSON 404, a known path with another method a 405
 * naming the methods it has.
 */
export function createRouter() {
  /** @type {Map<string, Map<string, Handler>>} */
  const routes = new Map();
  return {
    /**
     * @param {string} method
     * @param {string} path
     * @param {Handler} handler
     */
    on(method, path, handler) {
      const methods = routes.get(path) ?? new Map();
      methods.set(method, handler);
      routes.set(path, methods);
    },
    /**
     * @param {Request} request
     * @param {string} path the request's path below `api/`
     * @param {URL} url the request's URL
     * @returns {Promise<Response>}
     */
    async dispatch(request, path, url) {
      const methods = routes.get(path);
      if (!methods) return failure(404, 'not_found');
      const handler = methods.get(request.method);
      if (!handler) return failure(405, 'method_not_allowed', { headers: { Allow: [...methods.keys()].join(', ') } });
      return handler(request, url);
    },
  };
}

/**
 * Reads a whole body into memory, refusing (413) past `limit` bytes. A declared
 * Content-Length over the cap is refused before a byte is read; the stream is counted as it
 * arrives as well, so a body sent without a length, or with a false one, is held to the same
 * cap and the read stops there. (A Content-Length that is not a number reaches that count
 * too: Node and workerd refuse one before the kit sees the request.) A body whose stream
 * fails, a client hanging up mid-upload, is a 400: the client's doing, not the kit's, so it
 * is answered without an error in the log.
 * @param {{ body: ReadableStream<Uint8Array> | null, headers: Headers }} message
 * @param {number} limit
 * @returns {Promise<Uint8Array>}
 */
export async function readBytes(message, limit) {
  const declared = message.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new HttpError(413, 'payload_too_large');
  if (!message.body) return new Uint8Array(0);
  const reader = message.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  return concatBytes(chunks);
}

/**
 * A capped body parsed as JSON; malformed UTF-8 or JSON is a 400.
 * @param {{ body: ReadableStream<Uint8Array> | null, headers: Headers }} message
 * @param {number} limit
 * @returns {Promise<unknown>}
 */
export async function readJson(message, limit) {
  const text = fromUtf8(await readBytes(message, limit));
  if (text === null) throw new HttpError(400, 'bad_request');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

/**
 * Optional whitespace around a cookie pair (RFC 6265): space and tab, nothing else.
 * @param {number} code a UTF-16 code unit
 */
const isOws = (code) => code === 0x20 || code === 0x09;

/**
 * The request's cookies by name; the first of two with one name wins. A name is trimmed of
 * spaces and tabs only, never with String.prototype.trim: that strips U+00A0, U+FEFF, U+3000
 * and the rest of Unicode's spaces, which a browser keeps as part of the name. A cookie named
 * "\u00a0__Host-app-session" does not start with `__Host-` for the browser, so a sibling
 * subdomain may set it with any Domain and Path; trimmed, it would be read as the app's own.
 * The trim is two index loops, not a regular expression: the header is the client's, and
 * /^[ \t]+|[ \t]+$/ retries its second branch at every space of a run it cannot end, which
 * made a name of 64,000 spaces between two letters cost seconds. Every step here is linear.
 * @param {string | null} header
 * @returns {Map<string, string>}
 */
export function parseCookies(header) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    let start = 0;
    let end = eq;
    while (start < end && isOws(part.charCodeAt(start))) start += 1;
    while (end > start && isOws(part.charCodeAt(end - 1))) end -= 1;
    const name = part.slice(start, end);
    if (name && !out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

const COOKIE_NAME = /^__Host-[a-z][a-z0-9-]{0,31}-[a-z]+$/;
const COOKIE_VALUE = /^[A-Za-z0-9._-]*$/;

/**
 * A `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain, which is what the
 * prefix requires. `maxAge` 0 clears it.
 * @param {string} name
 * @param {string} value
 * @param {number} maxAge seconds
 * @returns {string}
 */
export function serializeCookie(name, value, maxAge) {
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value) || !Number.isInteger(maxAge) || maxAge < 0) {
    throw new TypeError('serializeCookie: a __Host- name, a base64url value and a whole Max-Age');
  }
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function clearCookie(name) {
  return serializeCookie(name, '', 0);
}

/**
 * @param {string | null} value
 * @returns {boolean}
 */
function isJsonType(value) {
  if (value === null) return false;
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase() === 'application/json';
}

/**
 * The CSRF gate for every POST and DELETE but the webhook: `Origin` must be the site's own
 * (a missing one is refused), and a request that carries a body, or says what it carries,
 * must say `application/json`, which an HTML form cannot send.
 * @param {Request} request
 * @param {string} origin the site's origin, from APP_URL
 * @param {{ body: boolean }} expects whether the route reads a body
 * @returns {Response | null} the refusal, or null when the request may go on
 */
export function csrfRefusal(request, origin, expects) {
  if (request.headers.get('origin') !== origin) return failure(403, 'forbidden');
  const type = request.headers.get('content-type');
  if ((expects.body || type !== null) && !isJsonType(type)) return failure(415, 'unsupported_media_type');
  return null;
}

/**
 * `application/x-www-form-urlencoded` from flat pairs.
 * @param {[string, string][]} pairs
 * @returns {string}
 */
export function formEncode(pairs) {
  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

/**
 * An AbortSignal that fires after `ms`, for an upstream call that must not hang.
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function timeoutSignal(ms) {
  return globalThis.AbortSignal.timeout(ms);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
