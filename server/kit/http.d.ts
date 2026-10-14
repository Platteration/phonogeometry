// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * @param {number} status
 * @param {unknown} body
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function json(status: number, body: unknown, options?: ReplyOptions): Response;
/**
 * `{ error: code }` with this status.
 * @param {number} status
 * @param {string} code
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function failure(status: number, code: string, options?: ReplyOptions): Response;
/**
 * 204 No Content: no body and no Content-Type.
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function noContent(options?: ReplyOptions): Response;
/**
 * 302 to an absolute URL: no body and no Content-Type.
 * @param {string} location
 * @param {ReplyOptions} [options]
 * @returns {Response}
 */
export function redirect(location: string, options?: ReplyOptions): Response;
/** @typedef {(request: Request, url: URL) => Promise<Response> | Response} Handler */
/**
 * Exact-path routing: an unknown path is a JSON 404, a known path with another method a 405
 * naming the methods it has.
 */
export function createRouter(): {
    /**
     * @param {string} method
     * @param {string} path
     * @param {Handler} handler
     */
    on(method: string, path: string, handler: Handler): void;
    /**
     * @param {Request} request
     * @param {string} path the request's path below `api/`
     * @param {URL} url the request's URL
     * @returns {Promise<Response>}
     */
    dispatch(request: Request, path: string, url: URL): Promise<Response>;
};
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
export function readBytes(message: {
    body: ReadableStream<Uint8Array> | null;
    headers: Headers;
}, limit: number): Promise<Uint8Array>;
/**
 * A capped body parsed as JSON; malformed UTF-8 or JSON is a 400.
 * @param {{ body: ReadableStream<Uint8Array> | null, headers: Headers }} message
 * @param {number} limit
 * @returns {Promise<unknown>}
 */
export function readJson(message: {
    body: ReadableStream<Uint8Array> | null;
    headers: Headers;
}, limit: number): Promise<unknown>;
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
export function parseCookies(header: string | null): Map<string, string>;
/**
 * A `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain, which is what the
 * prefix requires. `maxAge` 0 clears it.
 * @param {string} name
 * @param {string} value
 * @param {number} maxAge seconds
 * @returns {string}
 */
export function serializeCookie(name: string, value: string, maxAge: number): string;
/**
 * @param {string} name
 * @returns {string}
 */
export function clearCookie(name: string): string;
/**
 * The CSRF gate for every POST and DELETE but the webhook: `Origin` must be the site's own
 * (a missing one is refused), and a request that carries a body, or says what it carries,
 * must say `application/json`, which an HTML form cannot send.
 * @param {Request} request
 * @param {string} origin the site's origin, from APP_URL
 * @param {{ body: boolean }} expects whether the route reads a body
 * @returns {Response | null} the refusal, or null when the request may go on
 */
export function csrfRefusal(request: Request, origin: string, expects: {
    body: boolean;
}): Response | null;
/**
 * `application/x-www-form-urlencoded` from flat pairs.
 * @param {[string, string][]} pairs
 * @returns {string}
 */
export function formEncode(pairs: [string, string][]): string;
/**
 * An AbortSignal that fires after `ms`, for an upstream call that must not hang.
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function timeoutSignal(ms: number): AbortSignal;
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Sent on every response the kit makes. A host's static `_headers` file does not reach a
 * function's response, so the kit sets its own.
 */
export const API_HEADERS: Readonly<{
    'Cache-Control': "no-store";
    'X-Content-Type-Options': "nosniff";
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    'Referrer-Policy': "no-referrer";
    'Cross-Origin-Resource-Policy': "same-origin";
}>;
/** An error that becomes a JSON response with this status and code. */
export class HttpError extends Error {
    /**
     * @param {number} status
     * @param {string} code
     */
    constructor(status: number, code: string);
    status: number;
    code: string;
}
export type ReplyOptions = {
    /**
     * Cache-Control in place of `no-store`.
     */
    cache?: string | undefined;
    /**
     * Set-Cookie values, one header each.
     */
    cookies?: string[] | undefined;
    /**
     * Further headers.
     */
    headers?: Record<string, string> | undefined;
};
export type Handler = (request: Request, url: URL) => Promise<Response> | Response;
