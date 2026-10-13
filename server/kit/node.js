// @ts-check
/// <reference types="node" preserve="true" />
// Self-hosting: a node:http adapter in front of createApp (bound to loopback unless told
// otherwise, behind a reverse proxy that sends it `/api/`), and a Store kept as one file per
// key in a data directory outside the web root. It names Node's types itself (the reference
// above, kept in node.d.ts too): TypeScript 6 loads no @types package a tsconfig does not
// list, and an Expo app's may list none. An app's start script is a few lines:
//
//   import { serve } from './kit/node.js';
//   import catalogue from './catalogue.js';
//   const { url } = await serve({ catalogue });   // KIT_DATA_DIR, KIT_PORT, KIT_HOST from the environment
//   console.log(`api on ${url}`);

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { createApp } from './app.js';
import { failure, isRecord } from './http.js';
import { checkKey, serialize, ttlSeconds } from './store.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('./app.js').AppOptions} AppOptions */
/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

const HOUR_MS = 3_600_000;
const FILE = /^[0-9a-f]{64}\.json$/;
/** What is read and thrown away of a body the kit did not read, before the socket is cut. */
const DRAIN_LIMIT = 1024 * 1024;

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function codeOf(error) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

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
export function createFileStore(dir, { now = () => Date.now() } = {}) {
  const root = resolve(dir);
  /** @type {Promise<void> | null} */
  let ready = null;
  const ensure = () => (ready ??= mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined));
  /** @param {string} key */
  const fileOf = (key) => join(root, `${createHash('sha256').update(checkKey(key), 'utf8').digest('hex')}.json`);

  /**
   * @param {string} file
   * @returns {Promise<{ key: string, value: unknown, expires: number | null } | null>}
   */
  const readEntry = async (file) => {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null;
      throw error;
    }
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(entry) || typeof entry.key !== 'string') return null;
    return { key: entry.key, value: entry.value ?? null, expires: typeof entry.expires === 'number' ? entry.expires : null };
  };

  return {
    fileOf,
    async get(key) {
      const entry = await readEntry(fileOf(key));
      if (!entry || entry.key !== key || (entry.expires !== null && entry.expires <= now())) return null;
      return entry.value;
    },
    async put(key, value, options) {
      const file = fileOf(key);
      const ttl = ttlSeconds(options);
      const text = `{"key":${JSON.stringify(key)},"expires":${ttl === undefined ? 'null' : now() + ttl * 1000},"value":${serialize(value)}}`;
      await ensure();
      const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temp, file);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      await syncDirectory(root);
    },
    async delete(key) {
      try {
        await unlink(fileOf(key));
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
    },
    async sweep() {
      await ensure();
      let removed = 0;
      for (const name of await readdir(root)) {
        const file = join(root, name);
        let stale = false;
        if (name.endsWith('.tmp')) {
          const info = await stat(file).catch(() => null);
          stale = info !== null && info.mtimeMs < now() - HOUR_MS;
        } else if (FILE.test(name)) {
          const entry = await readEntry(file).catch(() => null);
          stale = entry !== null && entry.expires !== null && entry.expires <= now();
        }
        if (stale) {
          await unlink(file).catch(() => {});
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/**
 * Flushes a directory's entries (the rename that just landed in it) to the disk. Windows cannot
 * open a directory, and its renames need no such flush, so a refusal there is not an error.
 * @param {string} dir
 */
async function syncDirectory(dir) {
  let handle;
  try {
    handle = await open(dir, 'r');
  } catch (error) {
    if (process.platform === 'win32') return;
    throw error;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The request body as a web stream that pulls from the socket only as fast as it is read,
 * so the kit's byte cap stops the read rather than buffering past it.
 * @param {IncomingMessage} req
 * @param {() => void} ended
 * @returns {ReadableStream<Uint8Array>}
 */
function bodyStream(req, ended) {
  let closed = false;
  return new globalThis.ReadableStream({
    start(controller) {
      req.on('data', (/** @type {Uint8Array} */ chunk) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      });
      req.on('end', () => {
        if (closed) return;
        closed = true;
        ended();
        controller.close();
      });
      req.on('error', (error) => {
        if (closed) return;
        closed = true;
        controller.error(error);
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      closed = true;
      req.pause();
    },
  });
}

/** The fixed base every request target is resolved against. */
const BASE = 'http://localhost';

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
export function toRequest(req) {
  const target = req.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return null;
  const url = new globalThis.URL(`${BASE}${target}`);
  const method = req.method ?? 'GET';
  const headers = new globalThis.Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const length = req.headers['content-length'];
  const hasBody = method !== 'GET' && method !== 'HEAD' && (length !== undefined ? length !== '0' : req.headers['transfer-encoding'] !== undefined);
  let complete = !hasBody;
  const body = hasBody
    ? bodyStream(req, () => {
        complete = true;
      })
    : null;
  /** @type {RequestInit} */
  const init = /** @type {RequestInit} */ ({ method, headers, body, duplex: 'half' });
  return { request: new globalThis.Request(url, init), complete: () => complete };
}

/**
 * @param {ServerResponse} res
 * @param {Response} response
 */
async function send(res, response) {
  const bytes = response.body ? new Uint8Array(await response.arrayBuffer()) : null;
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  if (bytes) res.setHeader('Content-Length', String(bytes.length));
  res.end(bytes ?? undefined);
}

/**
 * Reads and throws away what is left of a body the kit refused or did not need, so the
 * connection can carry the next request, up to DRAIN_LIMIT; past that the socket is cut.
 * @param {IncomingMessage} req
 */
function discard(req) {
  if (req.complete) return;
  let drained = 0;
  req.removeAllListeners('data');
  req.on('data', (/** @type {Uint8Array} */ chunk) => {
    drained += chunk.length;
    if (drained > DRAIN_LIMIT) req.socket.destroy();
  });
  req.resume();
}

/**
 * A node:http request listener for the app.
 * @param {AppOptions} options
 * @returns {((req: IncomingMessage, res: ServerResponse) => void) & { features: { signIn: boolean, shop: boolean } }}
 */
export function createNodeHandler(options) {
  const app = createApp(options);
  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const listener = (req, res) => {
    let converted;
    try {
      converted = toRequest(req);
    } catch {
      converted = null;
    }
    const answer = converted ? app.handle(converted.request) : Promise.resolve(failure(400, 'bad_request'));
    answer
      .then((response) => send(res, response))
      .catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      })
      .finally(() => {
        if (!converted || !converted.complete()) discard(req);
      });
  };
  return Object.assign(listener, { features: app.features });
}

const output = globalThis.console;
/** @type {import('./app.js').Log} */
const consoleLog = (level, message) => (level === 'error' ? output.error(message) : output.warn(message));

/**
 * Starts the API on loopback. The data directory, port and host come from the options or
 * from KIT_DATA_DIR, KIT_PORT and KIT_HOST; the rest of the environment is read by the kit.
 * @param {{ catalogue: unknown, env?: Record<string, unknown>, dataDir?: string, host?: string, port?: number, fetch?: AppOptions['fetch'], now?: () => number, log?: import('./app.js').Log }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, store: ReturnType<typeof createFileStore>, server: import('node:http').Server, features: { signIn: boolean, shop: boolean } }>}
 */
export async function serve(options) {
  const env = options.env ?? process.env;
  /** @param {string} name */
  const setting = (name) => (typeof env[name] === 'string' && env[name] !== '' ? String(env[name]) : undefined);
  const dataDir = options.dataDir ?? setting('KIT_DATA_DIR');
  if (!dataDir) throw new Error('serve: set KIT_DATA_DIR (or pass dataDir): a directory outside the web root');
  const host = options.host ?? setting('KIT_HOST') ?? '127.0.0.1';
  const port = options.port ?? Number(setting('KIT_PORT') ?? 8788);
  const now = options.now ?? (() => Date.now());
  const store = createFileStore(dataDir, { now });
  await store.sweep();
  const listener = createNodeHandler({
    catalogue: options.catalogue,
    env,
    store,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now,
    log: options.log ?? consoleLog,
  });
  const server = createServer(listener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done(undefined);
    });
  });
  const timer = setInterval(() => {
    store.sweep().catch(() => {});
  }, HOUR_MS);
  timer.unref();
  // The address actually bound, not the one asked for, so the URL says where the API listens.
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('serve: the server has no address');
  return {
    url: `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}/`,
    store,
    server,
    features: listener.features,
    close: () =>
      new Promise((done) => {
        clearInterval(timer);
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
