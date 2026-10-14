// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/**
 * A Store over a KV namespace. KV is eventually consistent (up to a minute between
 * locations) and has no transactions, which is why every write the kit makes is idempotent.
 * @param {() => KvNamespace} namespace the binding, read at each call
 * @returns {Store}
 */
export function kvStore(namespace: () => KvNamespace): Store;
/**
 * The Pages Functions handler for an app's catalogue.
 * @param {unknown} catalogueInput
 * @returns {(context: { request: Request, env: Record<string, unknown>, waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>}
 */
export function pagesHandler(catalogueInput: unknown): (context: {
    request: Request;
    env: Record<string, unknown>;
    waitUntil?: (promise: Promise<unknown>) => void;
}) => Promise<Response>;
export type Store = import("./store.js").Store;
/**
 * the part of a Workers KV binding the kit uses
 */
export type KvNamespace = {
    get: (key: string, type: "json") => Promise<unknown>;
    put: (key: string, value: string, options?: {
        expirationTtl?: number;
    }) => Promise<void>;
    delete: (key: string) => Promise<void>;
};
