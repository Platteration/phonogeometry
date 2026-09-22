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

// Which Host names this server answers to.
//
// Binding to loopback stops a network peer; it does not stop a browser that has been told an
// attacker's own name resolves to 127.0.0.1 (DNS rebinding). The rebound request still carries
// that name in Host, so the gate below is what keeps a visited web page out of the checkout.
// The operating-system reads are injectable because the one rule a test cannot stage against a
// real server — an interface that comes up after the server did — is the one a phone will hit.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
/** The entry that stands for every name under `.local`; see allowedHosts. */
export const ANY_LOCAL = '*.local';
/** Refusals are logged once per name, and no more names than this are remembered: a client can
 *  mint a new name per request, and the log is a hint, not a record. */
export const MAX_LOGGED = 100;
/** Longer than any name a developer types, so a name past it is a probe: it is printed cut,
 *  and without the "set ALLOWED_HOST=" hint, which would be a cut name that would not work if
 *  it were pasted. */
export const MAX_NAME = 100;
/** A miss re-reads the interfaces at most this often, so a client cannot make the server scan
 *  them per request. */
export const RESCAN_MS = 1000;

/**
 * The name in a Host header, without its port. A bare IPv6 literal carries no port — RFC 7230
 * requires brackets for that — so stripping `:\d+$` from one turned `::1` into `:` and made
 * that entry unmatchable. Only a string is a name: node hands over `req.headers.host` as a
 * string or nothing (its parser drops a second Host header, so this is never a list), and
 * `String(x)` throws outright on an object whose `toString` is not callable — a coercion is
 * not worth a dead dev server.
 */
export function hostName(raw) {
  if (typeof raw !== 'string') return '';
  const h = raw.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || h; // bracketed IPv6: the port is outside
  return h.indexOf(':') === h.lastIndexOf(':') ? h.replace(/:\d+$/, '') : h;
}

/**
 * The Host names a server bound to `host` answers to. Loopback names always, and ALLOWED_HOST,
 * a comma-separated list for anyone who fronts this with something else — a port forwarded by
 * Docker, WSL2, a VM or a tunnel, which is not an address this process can see. Each entry goes
 * through the same normalisation, so `dev.example.com:8080` is the name it looks like and not a
 * value nothing can ever match.
 *
 * Bound off loopback — `--host=`, or `--https`, whose certificate carries a SAN of the same
 * addresses — the server exists to be reached from a phone, and what the phone types is one of
 * this machine's own names, so those are answered too: the bound address, every interface
 * address in both spellings (hostName keeps the brackets of a bracketed IPv6 literal and drops
 * a port either way), and the hostname. Every name under `.local` is answered too — that is
 * mDNS (RFC 6762), which is what a phone offers for this machine (`laptop.local`) and which no
 * internet DNS can point at 127.0.0.1 — carried as the ANY_LOCAL entry rather than spelled
 * out, which is why `<hostname>.local` needs no entry of its own. A loopback-only set on a LAN bind would refuse every phone, which is the case
 * the LAN modes are for, and a name is what a phone has: an address is only one of the ways to
 * reach this machine, and none of a `.local` name, the hostname or a forwarder's address is in
 * os.networkInterfaces().
 *
 * `interfaces` and `hostname` are parameters so a test can supply a machine. This is the rule
 * abientnoiser's `scripts/hosts.js` applies, form for form, so the two dev servers agree.
 */
export function allowedHosts(host = '127.0.0.1', interfaces = os.networkInterfaces(), hostname = os.hostname()) {
  const names = new Set(LOOPBACK_HOSTS);
  for (const entry of (typeof process.env.ALLOWED_HOST === 'string' ? process.env.ALLOWED_HOST : '').split(',')) {
    const name = hostName(entry);
    if (name) names.add(name);
  }
  if (LOOPBACK_HOSTS.includes(hostName(host))) return names;
  // Both spellings of an address, so `[fe80::1a2b]:8443` and `fe80::1a2b` are one name here.
  const address = (a) => { const name = hostName(a); if (name) names.add(name).add(hostName(`[${a}]`)); };
  address(host);
  for (const list of Object.values(interfaces || {})) for (const i of list || []) if (i?.address) address(i.address);
  const own = hostName(hostname);
  if (own) names.add(own);   // `<hostname>.local` needs no entry of its own: ANY_LOCAL answers it
  names.add(ANY_LOCAL);
  return names;
}

/**
 * Whether `hosts` answers to the name in `raw`. A request that claims no name at all is
 * answered: a browser always sends Host and a page cannot set it, so the only clients that
 * arrive without one are `curl --http1.0` and raw-socket probes on loopback.
 */
export function hostAllowed(raw, hosts) {
  const name = hostName(raw);
  if (!name || hosts.has(name)) return true;
  return name.endsWith('.local') && hosts.has(ANY_LOCAL);
}

/**
 * A gate over the Host header for a server bound to `host`: the names above, plus the two rules
 * that need state. An interface that came up after the start — the Wi-Fi the phone is on, a
 * hotspot switched on so the phone can reach the laptop — is read again on a miss before the
 * miss is refused, and a refused name is logged once, so the developer typing `laptop.local` on
 * a phone finds out on the console rather than from a bare Forbidden on the phone.
 * @returns {(raw: unknown) => boolean} true when the request may be served
 */
export function hostGate({ host = '127.0.0.1', interfaces = os.networkInterfaces, hostname = os.hostname, log = console.error, now = Date.now } = {}) {
  const lan = !LOOPBACK_HOSTS.includes(hostName(host));
  // On loopback the interfaces are not read at all: there a LAN address in Host is as foreign
  // as any other name, so there is nothing for a re-read to find.
  const read = () => allowedHosts(host, lan ? interfaces() : {}, lan ? hostname() : '');
  let names = read();
  let scanned = now();
  const refused = new Set();
  return function allowed(raw) {
    if (hostAllowed(raw, names)) return true;
    // os.networkInterfaces() costs microseconds and a miss is rare; the throttle is so that a
    // client minting one name per request cannot make the server scan them per request.
    if (lan && now() - scanned >= RESCAN_MS) {
      scanned = now();
      names = read();
      if (hostAllowed(raw, names)) return true;
    }
    const name = hostName(raw);
    if (refused.size < MAX_LOGGED && !refused.has(name)) {
      refused.add(name);
      const long = name.length > MAX_NAME;
      const shown = JSON.stringify(long ? `${name.slice(0, MAX_NAME)}…` : name);
      const how = lan ? '' : ' (or --host=0.0.0.0 to answer to this machine\'s own names)';
      log(`Phonogeometry: refused Host ${shown} — not one of this server's names.${long ? '' : ` If it should be, set ALLOWED_HOST=${name}${how}.`}`);
    }
    return false;
  };
}

const DEFAULT_HOSTS = allowedHosts('127.0.0.1');

/**
 * Turn a request URL into the file to serve, or the status to refuse it with.
 * Everything a request can influence is decided here, so it can be tested without a socket.
 * `host` is the request's Host header; `hosts` the names this server answers to, as a Set or
 * as a gate from hostGate (which is the Set plus the re-read and the refusal log).
 */
export function resolveRequest(url, host, hosts = DEFAULT_HOSTS) {
  // The Host check is the first answer, before the path is even looked at: a rebound page gets
  // nothing, not even a 400 to probe with. Why it is the check that matters is in hostGate.
  if (!(typeof hosts === 'function' ? hosts(host) : hostAllowed(host, hosts))) return { status: 403 };
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

export function handler(req, res, hosts = DEFAULT_HOSTS) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  const resolved = resolveRequest(req.url, req.headers.host, hosts);
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
  // The names this server answers to follow from where it is bound. The gate re-reads them on
  // a miss, so an interface that appears after this point is answered as well.
  const hosts = hostGate({ host });
  const serve = (req, res) => handler(req, res, hosts);
  const server = useHttps ? https.createServer(ensureCert(), serve) : http.createServer(serve);
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
    // The phone may offer this machine by name before it offers an address, and the server
    // answers to it, so it is worth printing rather than leaving to be discovered by 403.
    console.log(`  ${proto}://${os.hostname()}.local:${port}/   <- or this name, where the phone resolves it (mDNS)`);
  }
  if (!opts.useHttps) console.log('\nNote: phones only allow camera access over HTTPS. Run `npm run start:https` for LAN testing.');
  else console.log('\nThe certificate is self-signed: accept the browser warning once on the phone.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Could not start the dev server: ${err.message}`); process.exit(1); });
}
