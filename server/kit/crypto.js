// @ts-check
// Bytes, encodings and Web Crypto: base64url, hex, random ids, SHA-256, HMAC-SHA256 and
// constant-time comparison. Every host global is reached through `globalThis` so that a lint
// configuration with no environment globals at all (the strictest one in the fleet) still
// passes, and so that the globals this file uses can be read off it by eye.

/** @typedef {Uint8Array<ArrayBuffer>} Bytes */

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const HEX = /^[0-9a-fA-F]*$/;

/**
 * A fresh copy of `bytes` backed by its own ArrayBuffer, which is what Web Crypto accepts.
 * @param {Uint8Array} bytes
 * @returns {Bytes}
 */
export function copyBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/**
 * @param {string} text
 * @returns {Bytes}
 */
export function utf8(text) {
  return copyBytes(encoder.encode(text));
}

/**
 * Strict UTF-8 decoding: malformed input is null, never U+FFFD.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function fromUtf8(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * @param {Uint8Array[]} parts
 * @returns {Bytes}
 */
export function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Unpadded base64url (RFC 4648 section 5).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64url(bytes) {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET.charAt((value >> bits) & 63);
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET.charAt((value << (6 - bits)) & 63);
  return out;
}

/**
 * Strict unpadded base64url: any other character, an impossible length or non-zero
 * trailing bits make it null, so one byte string has exactly one spelling.
 * @param {unknown} text
 * @returns {Bytes | null}
 */
export function fromBase64url(text) {
  if (typeof text !== 'string' || !BASE64URL.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let value = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i += 1) {
    value = (value << 6) | ALPHABET.indexOf(text.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (value >> bits) & 255;
      index += 1;
      value &= (1 << bits) - 1;
    }
  }
  return value === 0 ? out : null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex
 */
export function hex(bytes) {
  let out = '';
  for (const byte of bytes) out += (byte < 16 ? '0' : '') + byte.toString(16);
  return out;
}

/**
 * @param {unknown} text
 * @returns {Bytes | null}
 */
export function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !HEX.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * @param {number} length
 * @returns {Bytes}
 */
export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * A random identifier: `length` random bytes as base64url (32 bytes, 43 characters, by default).
 * @param {number} [length]
 * @returns {string}
 */
export function randomId(length = 32) {
  return base64url(randomBytes(length));
}

/**
 * @param {string | Uint8Array} data
 * @returns {Bytes}
 */
function bytesOf(data) {
  return typeof data === 'string' ? utf8(data) : copyBytes(data);
}

/**
 * @param {string | Uint8Array} data
 * @returns {Promise<Bytes>}
 */
export async function sha256(data) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytesOf(data)));
}

/**
 * @param {string | Uint8Array} secret
 * @param {'sign' | 'verify'} usage
 */
function hmacKey(secret, usage) {
  return globalThis.crypto.subtle.importKey('raw', bytesOf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/**
 * HMAC-SHA256 of `data` under `secret`.
 * @param {string | Uint8Array} secret
 * @param {string | Uint8Array} data
 * @returns {Promise<Bytes>}
 */
export async function hmacSha256(secret, data) {
  const key = await hmacKey(secret, 'sign');
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, bytesOf(data)));
}

/**
 * Whether `mac` is the HMAC-SHA256 of `data` under `secret`. `crypto.subtle.verify` does the
 * comparison, in constant time.
 * @param {string | Uint8Array} secret
 * @param {string | Uint8Array} data
 * @param {Uint8Array} mac
 * @returns {Promise<boolean>}
 */
export async function hmacVerify(secret, data, mac) {
  const key = await hmacKey(secret, 'verify');
  return globalThis.crypto.subtle.verify('HMAC', key, copyBytes(mac), bytesOf(data));
}

/**
 * Equal-length digests compared with no data-dependent exit: every byte is visited.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Constant-time comparison of two strings of any length: their SHA-256 digests, which have
 * the same length whatever the inputs, are compared byte for byte.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return digestsEqual(x, y);
}
