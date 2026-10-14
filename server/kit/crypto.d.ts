// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * A fresh copy of `bytes` backed by its own ArrayBuffer, which is what Web Crypto accepts.
 * @param {Uint8Array} bytes
 * @returns {Bytes}
 */
export function copyBytes(bytes: Uint8Array): Bytes;
/**
 * @param {string} text
 * @returns {Bytes}
 */
export function utf8(text: string): Bytes;
/**
 * Strict UTF-8 decoding: malformed input is null, never U+FFFD.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function fromUtf8(bytes: Uint8Array): string | null;
/**
 * @param {Uint8Array[]} parts
 * @returns {Bytes}
 */
export function concatBytes(parts: Uint8Array[]): Bytes;
/**
 * Unpadded base64url (RFC 4648 section 5).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64url(bytes: Uint8Array): string;
/**
 * Strict unpadded base64url: any other character, an impossible length or non-zero
 * trailing bits make it null, so one byte string has exactly one spelling.
 * @param {unknown} text
 * @returns {Bytes | null}
 */
export function fromBase64url(text: unknown): Bytes | null;
/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex
 */
export function hex(bytes: Uint8Array): string;
/**
 * @param {unknown} text
 * @returns {Bytes | null}
 */
export function fromHex(text: unknown): Bytes | null;
/**
 * @param {number} length
 * @returns {Bytes}
 */
export function randomBytes(length: number): Bytes;
/**
 * A random identifier: `length` random bytes as base64url (32 bytes, 43 characters, by default).
 * @param {number} [length]
 * @returns {string}
 */
export function randomId(length?: number): string;
/**
 * @param {string | Uint8Array} data
 * @returns {Promise<Bytes>}
 */
export function sha256(data: string | Uint8Array): Promise<Bytes>;
/**
 * HMAC-SHA256 of `data` under `secret`.
 * @param {string | Uint8Array} secret
 * @param {string | Uint8Array} data
 * @returns {Promise<Bytes>}
 */
export function hmacSha256(secret: string | Uint8Array, data: string | Uint8Array): Promise<Bytes>;
/**
 * Whether `mac` is the HMAC-SHA256 of `data` under `secret`. `crypto.subtle.verify` does the
 * comparison, in constant time.
 * @param {string | Uint8Array} secret
 * @param {string | Uint8Array} data
 * @param {Uint8Array} mac
 * @returns {Promise<boolean>}
 */
export function hmacVerify(secret: string | Uint8Array, data: string | Uint8Array, mac: Uint8Array): Promise<boolean>;
/**
 * Equal-length digests compared with no data-dependent exit: every byte is visited.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean;
/**
 * Constant-time comparison of two strings of any length: their SHA-256 digests, which have
 * the same length whatever the inputs, are compared byte for byte.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
export function safeEqual(a: string, b: string): Promise<boolean>;
export type Bytes = Uint8Array<ArrayBuffer>;
