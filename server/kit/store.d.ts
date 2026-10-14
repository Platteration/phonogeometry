// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * Refuses (TypeError) a key KV would refuse: these are the kit's own keys, so a bad one is a
 * programming error.
 * @param {string} key
 * @returns {string}
 */
export function checkKey(key: string): string;
/**
 * The expiry in seconds to give a store, or undefined for none.
 * @param {{ ttl?: number } | undefined} options
 * @returns {number | undefined}
 */
export function ttlSeconds(options: {
    ttl?: number;
} | undefined): number | undefined;
/**
 * JSON text for a value, refusing what JSON cannot hold.
 * @param {unknown} value
 * @returns {string}
 */
export function serialize(value: unknown): string;
/**
 * A Store in a Map. Values are kept as JSON text, so what comes back is a copy, as it is from
 * KV or a file. Expiry follows the injected clock.
 * @param {{ now?: () => number }} [options]
 * @returns {Store & { keys(): string[] }}
 */
export function createMemoryStore({ now }?: {
    now?: () => number;
}): Store & {
    keys(): string[];
};
/**
 * @typedef {object} Store
 * @property {(key: string) => Promise<unknown>} get the value, or null when absent or expired
 * @property {(key: string, value: unknown, options?: { ttl?: number }) => Promise<void>} put
 *   writes the whole value; `ttl` in seconds, at least 60 (KV's minimum; less is raised to it)
 * @property {(key: string) => Promise<void>} delete absent keys are not an error
 */
/** KV refuses an expiry less than 60 seconds away. */
export const MIN_TTL: 60;
export const MAX_KEY_BYTES: 512;
export type Store = {
    /**
     * the value, or null when absent or expired
     */
    get: (key: string) => Promise<unknown>;
    /**
     *   writes the whole value; `ttl` in seconds, at least 60 (KV's minimum; less is raised to it)
     */
    put: (key: string, value: unknown, options?: {
        ttl?: number;
    }) => Promise<void>;
    /**
     * absent keys are not an error
     */
    delete: (key: string) => Promise<void>;
};
