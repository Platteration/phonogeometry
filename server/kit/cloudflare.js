// @ts-check
// Cloudflare Pages Functions entry. The app's `functions/api/[[path]].js` is three lines:
//
//   import { pagesHandler } from '../../server/kit/cloudflare.js';
//   import catalogue from '../../server/catalogue.js';
//   export const onRequest = pagesHandler(catalogue);
//
// The variables come from the project's encrypted environment variables (`context.env`), the
// store is the KV namespace bound as KIT_STORE, and logs go to the Functions log.

import { createApp, validateCatalogue } from './app.js';
import { checkKey, serialize, ttlSeconds } from './store.js';

/** @typedef {import('./store.js').Store} Store */

/**
 * @typedef {object} KvNamespace the part of a Workers KV binding the kit uses
 * @property {(key: string, type: 'json') => Promise<unknown>} get
 * @property {(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 */

/**
 * @param {unknown} value
 * @returns {value is KvNamespace}
 */
function isKv(value) {
  if (typeof value !== 'object' || value === null) return false;
  const kv = /** @type {Record<string, unknown>} */ (value);
  return typeof kv.get === 'function' && typeof kv.put === 'function' && typeof kv.delete === 'function';
}

/**
 * A Store over a KV namespace. KV is eventually consistent (up to a minute between
 * locations) and has no transactions, which is why every write the kit makes is idempotent.
 * @param {() => KvNamespace} namespace the binding, read at each call
 * @returns {Store}
 */
export function kvStore(namespace) {
  return {
    async get(key) {
      const value = await namespace().get(checkKey(key), 'json');
      return value ?? null;
    },
    async put(key, value, options) {
      const ttl = ttlSeconds(options);
      await namespace().put(checkKey(key), serialize(value), ttl === undefined ? undefined : { expirationTtl: ttl });
    },
    async delete(key) {
      await namespace().delete(checkKey(key));
    },
  };
}

/**
 * @param {[string, unknown]} entry
 * @returns {entry is [string, string]}
 */
function isStringEntry(entry) {
  return typeof entry[1] === 'string';
}

/** The variables the kit reads; the app is rebuilt only when one of them changes. */
const FIXED = ['APP_URL', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

/**
 * The Pages Functions handler for an app's catalogue.
 * @param {unknown} catalogueInput
 * @returns {(context: { request: Request, env: Record<string, unknown> }) => Promise<Response>}
 */
export function pagesHandler(catalogueInput) {
  const catalogue = validateCatalogue(catalogueInput);
  /** @type {KvNamespace | null} */
  let binding = null;
  /** @type {{ fingerprint: string, handle: (request: Request) => Promise<Response> } | null} */
  let current = null;
  const output = globalThis.console;
  return async (context) => {
    const env = context.env ?? {};
    binding = isKv(env.KIT_STORE) ? env.KIT_STORE : null;
    const strings = Object.fromEntries(Object.entries(env).filter(isStringEntry));
    const names = [...FIXED, ...Object.keys(strings).filter((name) => name.startsWith('STRIPE_PRICE_'))].sort();
    const fingerprint = JSON.stringify([binding !== null, ...names.map((name) => [name, strings[name] ?? null])]);
    if (!current || current.fingerprint !== fingerprint) {
      const app = createApp({
        catalogue,
        env: strings,
        store: binding ? kvStore(() => /** @type {KvNamespace} */ (binding)) : null,
        fetch: (input, init) => globalThis.fetch(input, init),
        log: (level, message) => (level === 'error' ? output.error(message) : output.warn(message)),
      });
      current = { fingerprint, handle: app.handle };
    }
    return current.handle(context.request);
  };
}
