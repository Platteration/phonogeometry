#!/usr/bin/env node
// Tiny static server for development. Cameras need a secure context, so use
// `node server.js --https` to serve over TLS with a self-signed certificate for your LAN.
//
// It binds to loopback unless asked otherwise: `--https` (the documented LAN mode) and an
// explicit `--host=` open it to the network, nothing else does.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/**
 * Turn a request URL into the file to serve, or the status to refuse it with.
 * Everything a request can influence is decided here, so it can be tested without a socket.
 */
export function resolveRequest(url) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    // A malformed escape such as `/%` throws URIError. Uncaught inside a request listener
    // that ends the process, so anyone who can reach the port could stop the dev server.
    return { status: 400 };
  }
  // `%00` is the escape that does not throw: decodeURIComponent hands back a real NUL, and
  // fs.stat then rejects it by throwing *synchronously* inside the request listener — the
  // same process-ending shape one step later. Refuse every control character while here, so
  // a raw CR or LF cannot reach a header either.
  if (/[\u0000-\u001f]/.test(urlPath)) return { status: 400 };
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(root, urlPath));
  // path.relative, not a startsWith prefix test: `/..%2fphonogeometry-old/.env` keeps its
  // escape through the URL parser, becomes a `..` segment here, and resolves to a sibling
  // directory whose name merely starts with this one's.
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 };
  // Nothing the app serves is hidden, so refusing every dotted segment keeps .git, .certs,
  // .env and any local scratch out of reach rather than listing them one by one.
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return { status: 403 };
  return { status: 200, file };
}

export function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  const resolved = resolveRequest(req.url);
  if (resolved.status !== 200) {
    res.writeHead(resolved.status);
    return res.end(resolved.status === 400 ? 'Bad request' : 'Forbidden');
  }
  const file = resolved.file;
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(st.size),
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    // stat and open are two calls: a file removed or made unreadable between them raises an
    // 'error' event on the stream, and an unhandled one ends the process as surely as the
    // throw above. The headers are already out, so the honest answer is a dropped response.
    //
    // pipeline, not pipe, and not a bare 'error' listener: pipe handles a failure of the
    // *source* only. When the destination goes away instead — a client that asks for a file
    // and walks away mid-transfer, which costs it nothing — pipe unpipes and leaves the
    // fs.ReadStream paused with its descriptor held, and autoClose never fires. That is one
    // descriptor per abandoned request, never released, from anything that can reach the
    // port; `npm run start:https` binds the LAN. pipeline destroys both ends whichever one
    // fails.
    pipeline(fs.createReadStream(file), res, () => { /* either end failing costs this one response */ });
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function ensureCert() {
  const dir = path.join(root, '.certs');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    const ips = lanAddresses();
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
    console.log('Generating a self-signed certificate in .certs/ …');
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 365 -subj "/CN=phonogeometry.local" -addext "subjectAltName=${san}"`, { stdio: 'inherit' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** Start a server. `host` defaults to loopback, so nothing is exposed to the network by accident. */
export function startServer({ port = 0, host = '127.0.0.1', useHttps = false } = {}) {
  const server = useHttps ? https.createServer(ensureCert(), handler) : http.createServer(handler);
  // A half-open or malformed connection must not hold the dev server open.
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* already gone */ } });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function parseArgs(argv) {
  const useHttps = argv.includes('--https');
  const value = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a === undefined ? null : a.slice(name.length + 3); };
  const portArg = value('port');
  const port = portArg === null ? (useHttps ? 8443 : 8080) : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number between 0 and 65535, not "${portArg}"`);
  // HTTPS is the documented way to reach the app from a phone, so it implies the LAN bind.
  const host = value('host') || (useHttps ? '0.0.0.0' : '127.0.0.1');
  return { useHttps, port, host };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  const server = await startServer(opts);
  const proto = opts.useHttps ? 'https' : 'http';
  const port = server.address().port;
  console.log(`Phonogeometry dev server`);
  console.log(`  ${proto}://localhost:${port}/`);
  if (opts.host === '127.0.0.1' || opts.host === 'localhost') {
    console.log('\nServing to this machine only. Pass --host=0.0.0.0 (or use `npm run start:https`) to reach it from a phone on the same Wi-Fi.');
  } else {
    for (const ip of lanAddresses()) console.log(`  ${proto}://${ip}:${port}/   <- open this on your phone (same Wi-Fi)`);
  }
  if (!opts.useHttps) console.log('\nNote: phones only allow camera access over HTTPS. Run `npm run start:https` for LAN testing.');
  else console.log('\nThe certificate is self-signed: accept the browser warning once on the phone.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Could not start the dev server: ${err.message}`); process.exit(1); });
}
