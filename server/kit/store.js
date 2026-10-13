// @ts-check
// The Store the kit keeps its records in, and an in-memory implementation of it for tests and
// single-process use. Cloudflare KV (cloudflare.js) and a directory of files (node.js) are the
// others. Values are JSON; a key is a string of at most 512 bytes (KV's limit, held
// everywhere so a key that works in a test works in production).

import { utf8 } from './crypto.js';

/**
 * @typedef {object} Store
 * @property {(key: string) => Promise<unknown>} get the value, or null when absent or expired
 * @property {(key: string, value: unknown, options?: { ttl?: number }) => Promise<void>} put
 *   writes the whole value; `ttl` in seconds, at least 60 (KV's minimum; less is raised to it)
 * @property {(key: string) => Promise<void>} delete absent keys are not an error
 */

/** KV refuses an expiry less than 60 seconds away. */
export const MIN_TTL = 60;
export const MAX_KEY_BYTES = 512;

/**
 * Refuses (TypeError) a key KV would refuse: these are the kit's own keys, so a bad one is a
 * programming error.
 * @param {string} key
 * @returns {string}
 */
export function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || utf8(key).length > MAX_KEY_BYTES) {
    throw new TypeError('store key: a non-empty string of at most 512 bytes');
  }
  return key;
}

/**
 * The expiry in seconds to give a store, or undefined for none.
 * @param {{ ttl?: number } | undefined} options
 * @returns {number | undefined}
 */
export function ttlSeconds(options) {
  const ttl = options?.ttl;
  if (ttl === undefined) return undefined;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new TypeError('store ttl: a positive number of seconds');
  return Math.max(MIN_TTL, Math.ceil(ttl));
}

/**
 * JSON text for a value, refusing what JSON cannot hold.
 * @param {unknown} value
 * @returns {string}
 */
export function serialize(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new TypeError('store value: something JSON can hold');
  return text;
}

/**
 * A Store in a Map. Values are kept as JSON text, so what comes back is a copy, as it is from
 * KV or a file. Expiry follows the injected clock.
 * @param {{ now?: () => number }} [options]
 * @returns {Store & { keys(): string[] }}
 */
export function createMemoryStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { text: string, expires: number | null }>} */
  const entries = new Map();
  /** @param {string} key */
  const live = (key) => {
    const entry = entries.get(key);
    if (entry && entry.expires !== null && entry.expires <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async get(key) {
      const entry = live(checkKey(key));
      return entry ? JSON.parse(entry.text) : null;
    },
    async put(key, value, options) {
      const ttl = ttlSeconds(options);
      entries.set(checkKey(key), { text: serialize(value), expires: ttl === undefined ? null : now() + ttl * 1000 });
    },
    async delete(key) {
      entries.delete(checkKey(key));
    },
    keys() {
      return [...entries.keys()].filter((key) => live(key) !== undefined);
    },
  };
}
