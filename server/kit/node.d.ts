// Generated from the JSDoc in the .js file beside this one: do not edit; regenerate.
/// <reference types="node" preserve="true" />
/**
 * A Store in a directory: one file per key, named by the SHA-256 of the key, so no part of a
 * key ever reaches the file system as a path. Writes go to a temporary file that is flushed to
 * the disk and renamed over the old one, and the directory is flushed after the rename, so a
 * reader sees the old value or the new one, never half of either, and a write that returned
 * survives a power cut (the webhook answers Stripe only after it has). Expired files read as
 * absent and are removed by `sweep()`. One process per directory: the kit's per-key lock holds
 * within a process, and two processes on one directory can lose each other's updates.
 * @param {string} dir
 * @param {{ now?: () => number }} [options]
 * @returns {Store & { sweep(): Promise<number>, fileOf(key: string): string }}
 */
export function createFileStore(dir: string, { now }?: {
    now?: () => number;
}): Store & {
    sweep(): Promise<number>;
    fileOf(key: string): string;
};
/**
 * A web Request for a node:http request. Its URL is the fixed base followed by the request
 * target, never the Host or X-Forwarded-* headers: the kit reads only the path and the query,
 * and takes every absolute URL it writes from APP_URL. Only a target that starts with a single
 * `/` is served. An absolute-form target (`http://…`, even one naming this base), `*`,
 * anything else that does not start with `/`, and a path that starts `//` or `/\` (which the
 * URL parser reads as a host) are refused. The target is appended to the base, not resolved
 * against it, so the base's host ends at the target's first `/` and nothing after it, not
 * even a tab the parser drops, can name another.
 * @param {IncomingMessage} req
 * @returns {{ request: Request, complete: () => boolean } | null} null when the target is not a path from a single `/`
 */
export function toRequest(req: IncomingMessage): {
    request: Request;
    complete: () => boolean;
} | null;
/**
 * A node:http request listener for the app.
 * @param {AppOptions} options
 * @returns {((req: IncomingMessage, res: ServerResponse) => void) & { features: { signIn: boolean, shop: boolean } }}
 */
export function createNodeHandler(options: AppOptions): ((req: IncomingMessage, res: ServerResponse) => void) & {
    features: {
        signIn: boolean;
        shop: boolean;
    };
};
/**
 * Starts the API on loopback. The data directory, port and host come from the options or
 * from KIT_DATA_DIR, KIT_PORT and KIT_HOST; the rest of the environment is read by the kit.
 * @param {{ catalogue: unknown, env?: Record<string, unknown>, dataDir?: string, host?: string, port?: number, fetch?: AppOptions['fetch'], now?: () => number, log?: import('./app.js').Log }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, store: ReturnType<typeof createFileStore>, server: import('node:http').Server, features: { signIn: boolean, shop: boolean } }>}
 */
export function serve(options: {
    catalogue: unknown;
    env?: Record<string, unknown>;
    dataDir?: string;
    host?: string;
    port?: number;
    fetch?: AppOptions["fetch"];
    now?: () => number;
    log?: import("./app.js").Log;
}): Promise<{
    url: string;
    close: () => Promise<void>;
    store: ReturnType<typeof createFileStore>;
    server: import("node:http").Server;
    features: {
        signIn: boolean;
        shop: boolean;
    };
}>;
export type Store = import("./store.js").Store;
export type AppOptions = import("./app.js").AppOptions;
export type IncomingMessage = import("node:http").IncomingMessage;
export type ServerResponse = import("node:http").ServerResponse;
