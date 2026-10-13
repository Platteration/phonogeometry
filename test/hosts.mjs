#!/usr/bin/env node
// The site on real web servers. test/website.test.js reads deploy/nginx.conf and .htaccess and
// holds the headers they write equal to _headers, but only a server shows what a file does:
// nginx before 1.25.1 (Ubuntu 24.04 ships 1.24) refused the whole of deploy/nginx.conf over an
// `http2 on;` line, and Apache sent no Strict-Transport-Security behind a proxy that ended TLS,
// because `env=HTTPS` is set by mod_ssl alone, while the redirect lets such a request through.
// Neither showed anywhere else: the browser suite serves the site through its own stand-in for
// a Netlify-style host.
//
// So this loads deploy/nginx.conf into the nginx installed here, and the site's .htaccess into
// the Apache installed here, each serving the folder `node tools/site.js` writes with a
// checkout's files planted in it (a server pointed at the wrong folder), and checks that every
// file of the site answers 200, typed, with every header _headers gives it; that every other
// address answers the site's own not-found page with the same headers; and that plain http is
// redirected to https. Apache is run over TLS, and behind a TLS-terminating proxy as well, which
// is what the redirect's X-Forwarded-Proto condition is for.
//
// The site's API (server/start.mjs, sign in with Google and "Support this app") runs here too,
// with a fake Google and a fake Stripe (test/apiFakes.js): nginx reaches it through
// deploy/nginx.conf's `location ^~ /api/`, and Apache through the ProxyPass the README and
// .htaccess give for the virtual host. Through each, everything under /api/ is the API's answer,
// with the API's own headers and the site's Strict-Transport-Security, and none of the site's
// other headers; and an Apache with no ProxyPass serves the folder's api/config, which says
// nothing is on.
//
// Needs nginx, Apache as Debian and Ubuntu lay it out (/usr/sbin/apache2, its modules in
// /usr/lib/apache2/modules), openssl and /etc/mime.types; GitHub's Ubuntu runner has them all.
// Where one is missing this says so and passes, unless CI is set (GitHub sets it on every
// runner): skipped there, it would read as passed.
//
// Run: npm run test:e2e (after the browser suite), or node test/hosts.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildSite, siteFiles } from '../tools/site.js';
import { start as startApi } from '../server/start.mjs';
import { createFakes, envFor } from './apiFakes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = '/usr/lib/apache2/modules';
const NOT_FOUND = '<title>Page not found · Phonogeometry</title>';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
}

const which = (name, fallback) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim() || (fs.existsSync(fallback) ? fallback : null);
const NGINX = which('nginx', '/usr/sbin/nginx');
const APACHE_MODULES = ['mpm_event', 'authz_core', 'mime', 'dir', 'rewrite', 'headers', 'ssl', 'socache_shmcb', 'proxy', 'proxy_http'];
const APACHE = APACHE_MODULES.every((m) => fs.existsSync(path.join(MODULES, `mod_${m}.so`))) ? which('apache2', '/usr/sbin/apache2') : null;
const OPENSSL = which('openssl', '/usr/bin/openssl');
const missing = [
  ...(NGINX && fs.existsSync('/etc/nginx/mime.types') ? [] : ['nginx (with /etc/nginx/mime.types)']),
  ...(APACHE ? [] : [`Apache (apache2, and ${APACHE_MODULES.map((m) => `mod_${m}`).join(', ')} in ${MODULES})`]),
  ...(OPENSSL ? [] : ['openssl']),
  ...(fs.existsSync('/etc/mime.types') ? [] : ['/etc/mime.types']),
];
if (missing.length) {
  const note = `hosts: not installed here: ${missing.join(', ')}`;
  if (process.env.CI) {
    console.error(`${note}. CI runs this on a runner that has them, so here that is a failure.`);
    process.exit(1);
  }
  console.log(`${note}. SKIPPED: the real nginx and Apache were not run; CI runs them.`);
  process.exit(0);
}

/** _headers as [{ pattern, headers }], and what Netlify sends for a path: every matching rule's
 *  headers, the values of a header two rules set joined. */
const RULES = [];
for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) { RULES.push({ pattern: line.trim(), headers: {} }); continue; }
  const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
  RULES[RULES.length - 1].headers[m[1].toLowerCase()] = m[2].trim();
}
function want(sitePath) {
  const out = {};
  for (const { pattern, headers } of RULES) {
    if (!(pattern.endsWith('/*') ? sitePath.startsWith(pattern.slice(0, -1)) : sitePath === pattern)) continue;
    for (const [name, value] of Object.entries(headers)) out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value;
  }
  return out;
}
/** The headers `response` does not send as _headers gives them for `sitePath`. */
const wrongHeaders = (response, sitePath) => Object.entries(want(sitePath)).filter(([name, value]) => response.headers[name] !== value).map(([name]) => `${name}: ${response.headers[name]}`);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
/** One request: status, headers and body. The certificate is this run's own, self-signed. */
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const req = (url.startsWith('https:') ? https : http).get(url, { headers, rejectUnauthorized: false, agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error(`${url}: no answer in 10 s`)));
});
async function waitFor(url, log) {
  for (let i = 0; i < 100; i++) {
    try { return await get(url); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${url} never answered:\n${log()}`);
}

// The site as it would be copied to a server, with the files of a checkout planted beside it,
// none of which may be served: the notes, the hosting settings, the dev server, the tests, the
// git history and the dev server's private key. Readable by everyone, since a server started as
// root reads it as an unprivileged user.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phonogeometry-hosts-'));
fs.chmodSync(work, 0o755);
const dir = path.join(work, 'site');
buildSite(dir, { host: 'apache' });
const PLANTED = {
  'README.md': '# the README\n', 'SECURITY.md': '# policy\n', '.git/config': '[core]\n', '.git/HEAD': 'ref: refs/heads/main\n',
  '.certs/key.pem': '-----BEGIN PRIVATE KEY-----\n', 'deploy/nginx.conf': 'server {}\n', '_headers': '/*\n', '_redirects': '/x /404.html 404!\n',
  'package.json': '{}\n', 'server.js': '//\n', 'test/website.test.js': '//\n', 'tools/site.js': '//\n',
  'node_modules/playwright/package.json': '{}\n', 'src/app.js.map': '{}\n', 'index.html.bak': '<!doctype html>\n', '.env': 'SECRET=1\n',
};
for (const [file, text] of Object.entries(PLANTED)) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
spawnSync('chmod', ['-R', 'a+rX', work]);
const asRoot = process.getuid?.() === 0;
const cert = path.join(work, 'cert.pem');
const key = path.join(work, 'key.pem');
spawnSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
fs.chmodSync(key, 0o644);

/** Every file of the site, and the page at its root. */
const SERVED = ['/', ...siteFiles().map((f) => `/${f}`)];
/** What a host that proxies the API answers from the folder: everything but api/. */
const STATIC = SERVED.filter((p) => !p.startsWith('/api/'));
/** The planted files, the hosting configuration, the folders and addresses the site does not
 *  have: the not-found page, every one. */
const REFUSED = [...Object.keys(PLANTED).map((f) => `/${f}`), '/.htaccess', '/src/', '/src/vision/', '/icons/', '/vendor/', '/vendor/three/', '/.well-known/', '/index.html/x', '/no/such/page'];
const TYPES = {
  '/': /^text\/html/, '/index.html': /^text\/html/, '/404.html': /^text\/html/, '/styles.css': /^text\/css/, '/src/app.js': /javascript/, '/sw.js': /javascript/,
  '/manifest.webmanifest': /^application\/manifest\+json/, '/vendor/three/LICENSE': /^text\/plain; charset=utf-8$/, '/icons/icon-192.png': /^image\/png$/,
};

/** Every path of the site answers 200 with its headers, and everything else the not-found page
 *  with the same headers. `forbidden` may answer 403 (with that page) rather than 404. `paths`
 *  are the site's files this host serves from the folder (all of them, unless it proxies api/). */
async function serves(label, origin, headers = {}, { forbidden = [], paths = SERVED } = {}) {
  const wrong = [];
  for (const p of paths) {
    const r = await get(`${origin}${p}`, headers);
    const bad = wrongHeaders(r, p === '/' ? '/index.html' : p);
    if (r.status !== 200 || bad.length || (TYPES[p] && !TYPES[p].test(r.headers['content-type'] || ''))) wrong.push(`${p} ${r.status} ${r.headers['content-type']}${bad.length ? ` (${bad.join('; ')})` : ''}`);
  }
  check(`${label}: every file of the site answers 200, typed, with every header _headers gives it`, wrong.length === 0, `${paths.length} paths${wrong.length ? `; wrong: ${wrong.join(' | ')}` : ''}`);
  const leaked = [];
  for (const p of REFUSED) {
    const r = await get(`${origin}${p}`, headers);
    const bad = wrongHeaders(r, '/404.html');
    const status = forbidden.includes(p) ? [403, 404] : [404];
    if (!status.includes(r.status) || !r.body.includes(NOT_FOUND) || bad.length) leaked.push(`${p} ${r.status}${bad.length ? ` (${bad.join('; ')})` : ''}`);
  }
  check(`${label}: a checkout's files, the host's settings, the folders and a missing page answer the site's not-found page, with the same headers`, leaked.length === 0, `${REFUSED.length} paths${leaked.length ? `; wrong: ${leaked.join(' | ')}` : ''}`);
}

/** One request with a method and a body, for the API's POST. */
const send = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = (url.startsWith('https:') ? https : http).request(url, { method, headers, rejectUnauthorized: false, agent: false }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error(`${url}: no answer in 10 s`)));
  req.end(body);
});

// The API, as server/start.mjs runs it on a host of its own: on loopback, its records in a data
// directory of its own, configured as a deployment would be (its public address the proxy's),
// and Google and Stripe faked through its `fetch`.
const API_URL = 'https://phonogeometry.example/';
const apiData = path.join(work, 'api-data');
const fakes = await createFakes();
const api = await startApi({ env: envFor(API_URL), dataDir: apiData, port: 0, fetch: fakes.fetch, log: () => {} });
const apiPort = new URL(api.url).port;
/** What the API says itself, every response: the site's headers are not its to send. */
const KIT_HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};
const SITE_ONLY = ['x-frame-options', 'permissions-policy', 'cross-origin-opener-policy'];

/** Through a proxy at `origin`, every address under /api/ is the API's answer, with its own
 *  headers and the site's Strict-Transport-Security, and nothing else of the site's. */
async function proxies(label, origin) {
  const wrong = [];
  const look = (what, r, status) => {
    const bad = Object.entries(KIT_HEADERS).filter(([name, value]) => r.headers[name] !== value).map(([name]) => `${name}: ${r.headers[name]}`);
    bad.push(...SITE_ONLY.filter((name) => r.headers[name] !== undefined).map((name) => `${name} sent`));
    if (r.headers['strict-transport-security'] !== want('/index.html')['strict-transport-security']) bad.push(`strict-transport-security: ${r.headers['strict-transport-security']}`);
    if (r.status !== status) bad.push(`status ${r.status}`);
    if (bad.length) wrong.push(`${what}: ${bad.join('; ')}`);
  };
  const config = await get(`${origin}/api/config`);
  look('GET /api/config', config, 200);
  let products = [];
  try { products = JSON.parse(config.body).shop.products.map((p) => `${p.id} ${p.price?.unit_amount} ${p.price?.currency}`); } catch { wrong.push(`config body ${config.body.slice(0, 60)}`); }
  if (products.join() !== 'supporter 400 eur') wrong.push(`products: ${products.join()}`);
  const started = await get(`${origin}/api/auth/google/start?return=%2F`);
  look('GET /api/auth/google/start', started, 302);
  if (!String(started.headers.location).startsWith('https://accounts.google.com/o/oauth2/v2/auth?')) wrong.push(`start went to ${started.headers.location}`);
  if (!/^__Host-phonogeometry-oauth=[^;]+;.*Secure/.test(String(started.headers['set-cookie']?.[0]))) wrong.push(`start set ${started.headers['set-cookie']}`);
  const buy = await send(`${origin}/api/checkout`, { method: 'POST', headers: { origin: 'https://phonogeometry.example', 'content-type': 'application/json' }, body: '{"product":"supporter"}' });
  look('POST /api/checkout signed out', buy, 401);
  for (const p of ['/api/.git/config', '/api/index.html', '/api/no/such/route']) {
    const r = await get(`${origin}${p}`);
    look(`GET ${p}`, r, 404);
    if (r.body.includes(NOT_FOUND) || !/^application\/json/.test(r.headers['content-type'] || '')) wrong.push(`${p}: not the API's own 404`);
  }
  check(`${label}: everything under /api/ is the API's answer, with its own headers and the site's HSTS alone`, wrong.length === 0, wrong.length ? wrong.join(' | ') : 'config, the sign-in start, a checkout, three addresses it does not have');
}

const children = [];
function start(cmd, args, log) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  children.push(child);
  return () => output + (log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
}

async function nginx() {
  const ndir = path.join(work, 'nginx');
  fs.mkdirSync(path.join(ndir, 'logs'), { recursive: true });
  const [plain, tls] = [await freePort(), await freePort()];
  // deploy/nginx.conf as its header says to install it: server_name, root and the certificate
  // paths set, and here the ports, on loopback alone. Each edit must find its line exactly once,
  // so a file that has moved on fails here rather than being tested as something it no longer
  // is. The listen lines keep whatever else they ask for (ssl, http2), and every other line is
  // loaded as written.
  let conf = fs.readFileSync(path.join(root, 'deploy', 'nginx.conf'), 'utf8');
  const edits = [];
  const edit = (from, to) => {
    const found = typeof from === 'string' ? conf.split(from).length - 1 : [...conf.matchAll(new RegExp(from.source, 'gm'))].length;
    edits.push(found === 1 ? null : `${from} found ${found} times`);
    conf = conf.replace(from, to);
  };
  edit('  listen 80;\n', `  listen 127.0.0.1:${plain};\n`);
  edit('  listen [::]:80;\n', '');
  edit(/^ {2}listen 443 ([^;\n]*);$/m, `  listen 127.0.0.1:${tls} $1;`);
  edit(/^ {2}listen \[::\]:443 [^;\n]*;\n/m, '');
  edit('  root /var/www/phonogeometry;\n', `  root ${dir};\n`);
  edit('/etc/letsencrypt/live/example.com/fullchain.pem', cert);
  edit('/etc/letsencrypt/live/example.com/privkey.pem', key);
  edit('    proxy_pass http://127.0.0.1:8788;\n', `    proxy_pass http://127.0.0.1:${apiPort};\n`);
  const bad = edits.filter(Boolean);
  check('deploy/nginx.conf has the lines an install sets, once each', bad.length === 0, bad.join(', '));
  fs.writeFileSync(path.join(ndir, 'site.conf'), conf);
  // the http {} block a stock Debian or Ubuntu nginx.conf includes it from, less the logging
  fs.writeFileSync(path.join(ndir, 'nginx.conf'), [
    ...(asRoot ? ['user www-data;'] : []),
    'worker_processes 1;',
    `pid ${path.join(ndir, 'nginx.pid')};`,
    'events {}',
    'http {',
    '  include /etc/nginx/mime.types;',
    '  default_type application/octet-stream;',
    '  access_log off;',
    ...['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((t) => `  ${t}_temp_path ${path.join(ndir, `${t}_temp`)};`),
    `  include ${path.join(ndir, 'site.conf')};`,
    '}',
    '',
  ].join('\n'));
  const args = ['-p', ndir, '-e', path.join(ndir, 'logs', 'error.log'), '-c', path.join(ndir, 'nginx.conf')];
  const version = spawnSync(NGINX, ['-v'], { encoding: 'utf8' }).stderr.trim().replace(/^nginx version: /, '');
  const test = spawnSync(NGINX, ['-t', ...args], { encoding: 'utf8' });
  check(`${version} loads deploy/nginx.conf`, test.status === 0 && !/\[emerg\]/.test(test.stderr), test.status === 0 ? '' : test.stderr.trim());
  if (test.status !== 0) return;

  const log = start(NGINX, [...args, '-g', 'daemon off;'], path.join(ndir, 'logs', 'error.log'));
  const origin = `https://127.0.0.1:${tls}`;
  await waitFor(`${origin}/`, log);
  await serves('nginx', origin, {}, { paths: STATIC });
  await proxies('nginx', origin);
  const redirect = await get(`http://127.0.0.1:${plain}/a/b?x=1`);
  check('nginx: plain http answers a 301 to the same address over https', redirect.status === 301 && redirect.headers.location === 'https://127.0.0.1/a/b?x=1', `${redirect.status} ${redirect.headers.location}`);
}

async function apache() {
  const adir = path.join(work, 'apache');
  fs.mkdirSync(adir, { recursive: true });
  const [plain, tls, proxied] = [await freePort(), await freePort(), await freePort()];
  // Apache with the modules .htaccess needs and AllowOverride All, as the README asks, and the
  // site at the document root, as `node tools/site.js <folder> --host=apache` writes it. A third
  // virtual host carries the README's ProxyPass for the API, and its HSTS line (the README and
  // .htaccess give both, with the API's port), which only the virtual host can: mod_proxy is
  // server configuration, and a proxied answer never reads .htaccess.
  fs.writeFileSync(path.join(adir, 'httpd.conf'), [
    `ServerRoot ${adir}`,
    `DefaultRuntimeDir ${adir}`,
    `PidFile ${path.join(adir, 'httpd.pid')}`,
    `ErrorLog ${path.join(adir, 'error.log')}`,
    'LogLevel warn',
    'ServerName localhost',
    ...(asRoot ? ['User www-data', 'Group www-data'] : []),
    ...APACHE_MODULES.map((m) => `LoadModule ${m}_module ${path.join(MODULES, `mod_${m}.so`)}`),
    'TypesConfig /etc/mime.types',
    `SSLSessionCache shmcb:${path.join(adir, 'ssl_scache')}(512000)`,
    `DocumentRoot ${dir}`,
    '<Directory />',
    '  AllowOverride None',
    '  Require all denied',
    '</Directory>',
    `<Directory ${dir}>`,
    '  AllowOverride All',
    '  Require all granted',
    '</Directory>',
    // a stock install refuses .ht* itself
    '<FilesMatch "^\\.ht">',
    '  Require all denied',
    '</FilesMatch>',
    `Listen 127.0.0.1:${plain}`,
    `Listen 127.0.0.1:${tls}`,
    `<VirtualHost 127.0.0.1:${tls}>`,
    '  SSLEngine on',
    `  SSLCertificateFile ${cert}`,
    `  SSLCertificateKeyFile ${key}`,
    '</VirtualHost>',
    `Listen 127.0.0.1:${proxied}`,
    `<VirtualHost 127.0.0.1:${proxied}>`,
    '  SSLEngine on',
    `  SSLCertificateFile ${cert}`,
    `  SSLCertificateKeyFile ${key}`,
    `  ProxyPass "/api/" "http://127.0.0.1:${apiPort}/api/"`,
    `  Header always set Strict-Transport-Security "${want('/index.html')['strict-transport-security']}"`,
    '</VirtualHost>',
    '',
  ].join('\n'));
  const version = spawnSync(APACHE, ['-v'], { encoding: 'utf8' }).stdout.split('\n')[0].replace(/^Server version: /, '');
  const test = spawnSync(APACHE, ['-t', '-f', path.join(adir, 'httpd.conf')], { encoding: 'utf8' });
  check(`${version} loads its configuration`, test.status === 0, test.status === 0 ? '' : test.stderr.trim());
  if (test.status !== 0) return;
  const log = start(APACHE, ['-f', path.join(adir, 'httpd.conf'), '-DFOREGROUND'], path.join(adir, 'error.log'));
  await waitFor(`https://127.0.0.1:${tls}/`, log);

  await serves('Apache over https', `https://127.0.0.1:${tls}`, {}, { forbidden: ['/.htaccess'] });
  // Behind a proxy that ended TLS: this Apache speaks plain http, and the proxy says the visitor
  // used https, so the redirect lets the request through and the site is served from here.
  await serves('Apache behind a TLS-terminating proxy', `http://127.0.0.1:${plain}`, { 'X-Forwarded-Proto': 'https' }, { forbidden: ['/.htaccess'] });
  const redirect = await get(`http://127.0.0.1:${plain}/a/b?x=1`);
  check('Apache: plain http answers a 301 to the same address over https', redirect.status === 301 && redirect.headers.location === `https://127.0.0.1:${plain}/a/b?x=1`, `${redirect.status} ${redirect.headers.location}`);
  // Without the ProxyPass (above), the folder's api/config was served as a file of the site and
  // says nothing is on; with it, the API answers, and the rest of the site is as it was.
  const off = await get(`https://127.0.0.1:${tls}/api/config`);
  check('Apache without a ProxyPass: api/config is the folder\'s, saying nothing is on', off.status === 200 && off.body.trim() === '{"auth":{"google":false},"shop":{"products":[]}}', `${off.status} ${off.body.trim()}`);
  await proxies('Apache with the README\'s ProxyPass', `https://127.0.0.1:${proxied}`);
  await serves('Apache with the README\'s ProxyPass', `https://127.0.0.1:${proxied}`, {}, { forbidden: ['/.htaccess'], paths: STATIC });
  // the stock refusal of .htaccess (AH01630) is logged as an error and is not one
  const errors = log().split('\n').filter((l) => /:(error|crit|alert|emerg)\]/.test(l) && !/AH01630: client denied by server configuration: \S+\/\.htaccess$/.test(l));
  check('Apache logged no error while serving', errors.length === 0, errors.join(' | '));
}

try {
  await nginx();
  await apache();
} catch (e) {
  console.error(e);
  check('the host checks ran to the end', false, String(e?.message ?? e));
} finally {
  await api.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map((c) => (c.exitCode === null && c.signalCode === null ? new Promise((r) => c.once('exit', r)) : null)));
  fs.rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} host checks passed`);
process.exit(failed.length ? 1 : 0);
