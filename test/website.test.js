// The website layer: one policy, written in five places, and a site that is exactly the files
// the page loads. Netlify and Cloudflare Pages read _headers, Apache .htaccess, nginx
// deploy/nginx.conf, and a host that sends no headers (GitHub Pages) gets the policy from the
// <meta> of index.html and 404.html. A header changed in one of them and not the others is a
// site protected on one host and not on the next, so they are read out of every file here and
// held equal. What the policy allows is measured, not assumed: the browser suite
// (test/browser/run.mjs) serves the built site under these headers at a sub-path and drives
// the app through them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as site from '../tools/site.js';
import { POLICY_NAME } from '../src/trust.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** A page without its comments, which may name the elements they describe. */
const page = (p) => read(p).replace(/<!--[\s\S]*?-->/g, '');
const PAGES = ['index.html', '404.html'];

/** `_headers` as { path: { Header: value } }. */
function netlifyHeaders() {
  const rules = {};
  let current = null;
  for (const line of read('_headers').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    assert.ok(m && current, `_headers: a header line under a path: ${line}`);
    assert.ok(!Object.hasOwn(current, m[1]), `_headers: ${m[1]} is set once per path`);
    current[m[1]] = m[2].trim();
  }
  return rules;
}

/** Every `Header always set` in .htaccess, as { Header: value }. Each is unconditional: a
 *  condition after the value (`env=HTTPS`, `expr=…`) sends the header on some responses only,
 *  and `env=HTTPS` is set by mod_ssl alone, so behind a proxy that ends TLS the header it
 *  carried, HSTS, went out on none. */
function apacheHeaders() {
  const conf = read('.htaccess');
  const out = {};
  for (const m of conf.matchAll(/^\s*Header\s+always\s+set\s+([A-Za-z-]+)\s+"([^"]*)"\s*$/gm)) {
    assert.ok(!Object.hasOwn(out, m[1]), `.htaccess: ${m[1]} is set once`);
    out[m[1]] = m[2];
  }
  assert.doesNotMatch(conf, /^\s*Header\s+(?!always\s+set\s)/m, '.htaccess sets every header with `Header always set`');
  const lines = conf.split('\n').filter((l) => /^\s*Header\b/.test(l));
  assert.deepEqual(lines.filter((l) => !/^\s*Header\s+always\s+set\s+[A-Za-z-]+\s+"[^"]*"\s*$/.test(l)), [], '.htaccess: every header is set on every response, with nothing after its value');
  return out;
}

/** The API's location in deploy/nginx.conf: `location ^~ /api/ { … }`, the one location allowed
 *  an add_header of its own (see nginxApiLocation's test). */
const API_LOCATION = /^\s*location \^~ \/api\/ \{([^}]*)\}/m;

/** Every `add_header` in deploy/nginx.conf's server blocks, as { Header: value }. Each must carry
 *  `always`, or nginx leaves it off the 404 page and every other error response. The API's
 *  location is read apart: it is the one place a location adds a header (its own HSTS line). */
function nginxHeaders() {
  const conf = read('deploy/nginx.conf');
  const api = conf.match(API_LOCATION);
  const site = api ? conf.replace(api[0], '') : conf;
  const out = {};
  for (const m of site.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;\s*$/gm)) {
    assert.ok(!Object.hasOwn(out, m[1]), `nginx.conf: ${m[1]} is set once`);
    out[m[1]] = m[2];
  }
  assert.equal([...site.matchAll(/^\s*add_header\b/gm)].length, Object.keys(out).length, 'nginx.conf: every add_header is quoted and `always`');
  // nginx drops the server's add_header lines from a location that sets one of its own.
  assert.doesNotMatch(site.slice(site.indexOf('location')), /location[^{]*\{[^}]*add_header/, 'nginx.conf: no location but the API\'s sets headers of its own');
  return out;
}

/** A page's <meta> policy and referrer policy. */
function metaOf(file) {
  const html = page(file);
  const csp = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/g)].map((m) => m[1]);
  const referrer = [...html.matchAll(/<meta name="referrer" content="([^"]+)" \/>/g)].map((m) => m[1]);
  assert.equal(csp.length, 1, `${file} carries one Content-Security-Policy <meta>`);
  assert.equal(referrer.length, 1, `${file} carries one referrer <meta>`);
  // a <meta> policy governs only what comes after it
  assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.search(/<(script|link|style)\b/), `${file}: the policy comes before anything it governs`);
  return { csp: csp[0], referrer: referrer[0] };
}

/** A policy as an ordered list of [directive, ...sources]. */
const directives = (policy) => policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/));
/** What a <meta> can carry of a header policy: frame-ancestors is ignored there, and
 *  upgrade-insecure-requests is left to the header so the dev server still serves a phone on
 *  the local network over plain http. */
const META_LEAVES_OUT = ['frame-ancestors', 'upgrade-insecure-requests'];
const sha256 = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;

const HEADERS = netlifyHeaders()['/*'];
const POLICY = Object.fromEntries(directives(HEADERS['Content-Security-Policy']).map(([name, ...sources]) => [name, sources]));

test('one policy: _headers, .htaccess and nginx.conf send the same headers with the same values', () => {
  assert.ok(HEADERS, '_headers has a /* rule');
  assert.deepEqual(apacheHeaders(), HEADERS, '.htaccess sends exactly what _headers does');
  assert.deepEqual(nginxHeaders(), HEADERS, 'deploy/nginx.conf sends exactly what _headers does');
});

test('one policy: both pages carry the header policy in their <meta>, less what a <meta> cannot say', () => {
  const header = directives(HEADERS['Content-Security-Policy']);
  const want = header.filter(([name]) => !META_LEAVES_OUT.includes(name)).map((d) => d.join(' ')).join('; ');
  for (const name of META_LEAVES_OUT) assert.ok(header.some(([d]) => d === name), `the header policy sets ${name}`);
  for (const file of PAGES) {
    const meta = metaOf(file);
    assert.equal(meta.csp, want, `${file}'s <meta> policy is the header's, directive for directive`);
    assert.equal(meta.referrer, HEADERS['Referrer-Policy'], `${file}'s referrer <meta> is the header's`);
  }
});

test('the policy starts from nothing and allows only what the app loads', () => {
  assert.equal(directives(HEADERS['Content-Security-Policy']).length, Object.keys(POLICY).length, 'each directive once');
  assert.deepEqual(POLICY['default-src'], ["'none'"]);
  assert.deepEqual(POLICY['script-src'][0], "'self'", 'scripts are the site\'s own files, and the import map by its hash');
  assert.deepEqual(POLICY['object-src'], ["'none'"]);
  assert.deepEqual(POLICY['base-uri'], ["'none'"]);
  // The two dialogs are <form method="dialog">, which closes the dialog and submits nowhere;
  // measured in Chromium, form-action 'none' leaves them working.
  assert.deepEqual(POLICY['form-action'], ["'none'"]);
  assert.deepEqual(POLICY['frame-ancestors'], ["'none'"], 'no other site may frame the app (clickjacking)');
  assert.deepEqual(POLICY['upgrade-insecure-requests'], []);
  // The service worker's own fetches (its install, its refresh) are connect-src: with 'none'
  // it installs and caches nothing. The only other requests are the account's, to the site's own
  // api/ (src/account.js), on a host that runs it; Google and Stripe are top-level navigations,
  // which the policy does not govern, and nothing of theirs is loaded into the page.
  assert.deepEqual(POLICY['connect-src'], ["'self'"]);
  assert.deepEqual(POLICY['worker-src'], ["'self'"], 'the reconstruction worker and the service worker, both the site\'s own files');
  // The icons, and the shot thumbnails, which are JPEG data: URLs kept with each shot.
  assert.deepEqual(POLICY['img-src'], ["'self'", 'data:']);
  assert.deepEqual(POLICY['manifest-src'], ["'self'"]);
  assert.deepEqual(POLICY['require-trusted-types-for'], ["'script'"]);
  assert.deepEqual(POLICY['trusted-types'], [POLICY_NAME], 'the one policy src/trust.js creates, and no other');
  const ALLOWED = new Set(['default-src', 'script-src', 'style-src', 'img-src', 'worker-src', 'connect-src', 'manifest-src', 'base-uri', 'form-action', 'object-src', 'require-trusted-types-for', 'trusted-types', 'frame-ancestors', 'upgrade-insecure-requests']);
  for (const name of Object.keys(POLICY)) assert.ok(ALLOWED.has(name), `${name} is a directive the app was measured to need`);
  for (const [name, sources] of Object.entries(POLICY)) {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", '*', 'http:', 'https:', 'blob:', "'strict-dynamic'", "'allow-duplicates'"]) {
      assert.ok(!sources.includes(bad), `${name} allows ${bad}`);
    }
    if (name !== 'img-src') assert.ok(!sources.includes('data:'), `${name} allows data:`);
  }
});

test('the hashes are the import map and the 404 page\'s <style> as they are now, and nothing else is inline', () => {
  const scripts = [];
  const styles = [];
  for (const file of PAGES) {
    const html = page(file);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\ssrc="[^"]+"/.test(m[1])) { assert.equal(m[2], '', `${file}: a script with a src has no body`); continue; }
      assert.equal(m[1], ' type="importmap"', `${file}: the only inline script is the import map`);
      scripts.push(sha256(m[2]));
    }
    for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) styles.push(sha256(m[1]));
    assert.equal([...html.matchAll(/<style\b/g)].length, [...html.matchAll(/<style>/g)].length, `${file}: every <style> is a plain one`);
    assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, `${file} has no inline event handler`);
    assert.doesNotMatch(html, /<[^>]*\sstyle\s*=/i, `${file} has no style attribute`);
    assert.doesNotMatch(html, /\b(href|src)\s*=\s*"\s*(javascript|data):/i, `${file} links to no javascript: or data: address`);
  }
  assert.equal(scripts.length, 1, 'one import map, in index.html');
  assert.deepEqual(POLICY['script-src'], ["'self'", ...scripts], `script-src is 'self' and the import map's hash as it is now: ${scripts.join(' ')}`);
  assert.deepEqual(POLICY['style-src'], ["'self'", ...styles], `style-src is 'self' and the hash of each inline <style> as it is now: ${styles.join(' ')}`);
});

test('Trusted Types: one policy, vouching for the two scripts the app starts, and no script writes HTML', () => {
  const firstParty = site.siteFiles().filter((f) => f.endsWith('.js') && !f.startsWith('vendor/'));
  const sources = firstParty.map((f) => [f, read(f)]);
  const creators = sources.filter(([, src]) => /\bcreatePolicy\b/.test(src)).map(([f]) => f);
  assert.deepEqual(creators, ['src/trust.js'], 'src/trust.js is the one place a policy is created');
  // Under require-trusted-types-for these throw; this names the line before a browser does. The
  // vendored three.js is upstream's bytes: its one sink (DOMParser, in a FileLoader mode for
  // documents) is on a network path the app never takes.
  const SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\.srcdoc\s*=|\beval\(|new Function\(|createContextualFragment|DOMParser|setHTMLUnsafe/;
  for (const [file, src] of sources) {
    const lines = src.split('\n').flatMap((line, i) => (SINKS.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
    assert.deepEqual(lines, [], 'text reaches the page through textContent and createElement, never as HTML');
  }
  // The two sinks the app does feed take their URL through the policy.
  const app = read('src/app.js');
  assert.match(app, /new Worker\(scriptURL\(/, 'the reconstruction worker is started through the policy');
  assert.match(app, /serviceWorker\.register\(scriptURL\(/, 'the service worker is registered through the policy');
  assert.equal([...app.matchAll(/new Worker\(|serviceWorker\.register\(/g)].length, 2, 'and nothing else is started as a script');
});

test('the other headers: no sniffing, no framing, no referrer, only the features the app uses, HTTPS remembered', () => {
  assert.equal(HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(HEADERS['X-Frame-Options'], 'DENY', 'the old browsers\' half of frame-ancestors \'none\'');
  assert.equal(HEADERS['Referrer-Policy'], 'no-referrer', 'the one link out (the source) tells GitHub nothing about where the app is hosted');
  assert.equal(HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(HEADERS['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  // No file name carries a version or a hash, so nothing may be cached without asking.
  assert.equal(HEADERS['Cache-Control'], 'no-cache');
  const features = HEADERS['Permissions-Policy'].split(',').map((f) => f.trim().split('='));
  // The cameras, and the screen kept on through a build. Measured: with camera=() the browser
  // refuses getUserMedia, and with screen-wake-lock=() the lock the app takes for a build. The
  // previews are muted, which plays under autoplay=() as well, so autoplay is denied.
  const USED = { camera: '(self)', 'screen-wake-lock': '(self)' };
  for (const [name, allow] of features) assert.equal(allow, USED[name] || '()', `${name} is ${USED[name] ? 'this site\'s alone' : 'denied'}`);
  for (const name of [...Object.keys(USED), 'microphone', 'geolocation', 'display-capture', 'payment', 'usb', 'autoplay', 'fullscreen', 'accelerometer', 'gyroscope']) {
    assert.ok(features.some(([f]) => f === name), `Permissions-Policy names ${name}`);
  }
  assert.equal(new Set(features.map(([f]) => f)).size, features.length, 'each feature once');
  assert.deepEqual(netlifyHeaders()['/vendor/three/LICENSE'], { 'Content-Type': 'text/plain; charset=utf-8' }, 'the licence is served as text');
  assert.deepEqual(Object.keys(netlifyHeaders()).sort(), ['/*', '/vendor/three/LICENSE']);
});

/** The repository's files: tracked, plus new ones not yet added (so a file is checked before
 *  its first commit); every file on disk outside node_modules and .git where there is no
 *  work tree. */
function repositoryFiles() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top === '') {
      return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
    }
  } catch {
    // Not a work tree, or no git: read the disk.
  }
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk('');
  return out;
}

test('the site is the shell, the worker and the files every site has, and nothing else', () => {
  const files = site.siteFiles();
  assert.deepEqual(files, [...new Set([...site.shell(), ...site.EXTRA])].sort());
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
  for (const f of ['index.html', '404.html', 'sw.js', 'manifest.webmanifest', 'robots.txt', '.well-known/security.txt', 'src/guard.js', 'src/trust.js']) {
    assert.ok(files.includes(f), `the site has ${f}`);
  }
  const NOT_SITE = /(^|\/)(README|CLAUDE|AGENTS|CONVENTIONS|REVIEW|SECURITY|SECURITY-AUDIT)\.md$|^(test|tools|deploy|docs|node_modules|server|functions|\.github|\.claude|\.certs)\/|^(_headers|_redirects|_routes\.json|\.htaccess|package(-lock)?\.json|server\.js|LICENSE)$/;
  assert.deepEqual(files.filter((f) => NOT_SITE.test(f)), [], 'no notes, tests, tools, dev server, API code or hosting settings');
  assert.deepEqual(files.filter((f) => f.split('/').some((part) => part.startsWith('.')) && f !== '.well-known/security.txt'), [], 'no dotfile but the security contact');
});

test('tools/site.js copies the site, and the settings file each host reads, into an empty folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-site-'));
  try {
    const list = (dir) => {
      const out = [];
      const walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p); else out.push(p); } };
      walk('');
      return out.sort();
    };
    assert.deepEqual(Object.keys(site.HOST_FILES).sort(), ['apache', 'cloudflare', 'netlify', 'nginx', 'pages']);
    for (const [host, extra] of Object.entries(site.HOST_FILES)) {
      const out = path.join(tmp, host);
      site.build(out, { host });
      assert.deepEqual(list(out), [...site.siteFiles(), ...extra].sort(), `--host=${host}`);
      for (const f of site.siteFiles()) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(root, f))), `${f} is copied as it is`);
      assert.throws(() => site.build(out, { host }), /not empty/, 'a folder already holding files is refused, not published along with the site');
    }
    assert.throws(() => site.build(path.join(tmp, 'x'), { host: 'constructor' }), /unknown host/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** What nginx does with a path, read the way nginx picks a location: an exact match, else the
 *  longest prefix if it carries `^~`, else the first regex, else the longest prefix. 'proxied'
 *  (to the API), 'served' (from the folder) or 'refused' (404). */
function nginxAnswers(urlPath) {
  const conf = read('deploy/nginx.conf');
  const server = conf.slice(conf.indexOf('listen 443'));
  const blocks = [...server.matchAll(/location\s+(=|~|\^~)?\s*(\S+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)?)\}/g)].map((m) => ({ kind: m[1] || 'prefix', match: m[2], body: m[3] }));
  const exact = blocks.find((b) => b.kind === '=' && b.match === urlPath);
  const longest = blocks.filter((b) => (b.kind === 'prefix' || b.kind === '^~') && urlPath.startsWith(b.match)).sort((a, b) => b.match.length - a.match.length)[0];
  const regex = blocks.find((b) => b.kind === '~' && new RegExp(b.match).test(urlPath));
  const block = exact || (longest?.kind === '^~' ? longest : null) || regex || longest;
  assert.ok(block, `nginx.conf has a location for ${urlPath}`);
  if (/\bproxy_pass\b/.test(block.body)) return 'proxied';
  return /\breturn\s+404\b/.test(block.body) ? 'refused' : 'served';
}
/** Whether nginx answers a path with something other than its 404: a file, or the API. */
const nginxServes = (urlPath) => nginxAnswers(urlPath) !== 'refused';
function apacheServes(relPath) {
  const rule = read('.htaccess').match(/^\s*RewriteRule\s+!(\S+)\s+-\s+\[R=404,L\]\s*$/m);
  assert.ok(rule, '.htaccess refuses everything outside an allowlist');
  return new RegExp(rule[1]).test(relPath);
}
function netlifyDenies(urlPath) {
  return read('_redirects').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).some((line) => {
    const [from, to, status] = line.trim().split(/\s+/);
    assert.equal(`${to} ${status}`, '/404.html 404!', `_redirects: every rule is a forced 404: ${line}`);
    return from.endsWith('/*') ? urlPath.startsWith(from.slice(0, -1)) : urlPath === from;
  });
}

test('pointed at a checkout, every host config serves the site and answers 404 for everything else', () => {
  const files = new Set(site.siteFiles());
  // Netlify deploys from the repository, so its rules list the repository's own files; nginx
  // and Apache refuse anything outside the site, files that are not in the repository too.
  // .certs/ holds the dev server's private key, which is never tracked but is on the disk of
  // every checkout that ran `npm run start:https`.
  const others = [...repositoryFiles().filter((f) => !files.has(f)), '.git/config', '.git/HEAD', 'node_modules/playwright/package.json', '.certs/key.pem', 'scratch/notes.txt', '.env'];
  for (const f of ['README.md', 'deploy/nginx.conf', '_headers', '_redirects', '.htaccess', 'test/website.test.js', 'tools/site.js', 'server.js', 'package.json', 'LICENSE']) {
    assert.ok(others.includes(f), `${f} is one of the repository's files outside the site`);
  }
  for (const f of others) {
    assert.equal(nginxServes(`/${f}`), false, `nginx answers 404 for /${f}`);
    assert.equal(apacheServes(f), false, `Apache answers 404 for /${f}`);
    assert.equal(netlifyDenies(`/${f}`), true, `Netlify answers 404 for /${f}`);
  }
  for (const f of ['dist/index.html', 'index.html.bak', 'src/app.js.map', 'backup.zip', 'test/browser/index.html']) {
    assert.equal(nginxServes(`/${f}`), false, `nginx answers 404 for /${f}`);
    assert.equal(apacheServes(f), false, `Apache answers 404 for /${f}`);
  }
  for (const f of files) {
    assert.equal(nginxServes(`/${f}`), true, `nginx serves /${f}`);
    assert.equal(apacheServes(f), true, `Apache serves /${f}`);
    assert.equal(netlifyDenies(`/${f}`), false, `Netlify serves /${f}`);
  }
  assert.equal(nginxServes('/'), true, 'nginx serves the page at /');
  assert.equal(apacheServes(''), true, 'Apache serves the page at /');
  for (const dir of ['src/', 'src/vision/', 'icons/', 'vendor/', 'vendor/three/', '.well-known/']) {
    assert.equal(nginxServes(`/${dir}`), false, `nginx answers 404 for the folder /${dir}`);
    assert.equal(apacheServes(dir), false, `Apache answers 404 for the folder /${dir}`);
  }
});

// The site's API (server/start.mjs, the kit's Node adapter) listens on loopback, and nginx hands
// it everything under /api/ on the site's own origin. `^~` is what makes that location win over
// the regular expression that serves the site's files (and over the dotfile refusals), and its
// proxy_pass names no URI, so the path reaches the API as the browser wrote it. A location with
// an add_header of its own inherits none of the server block's, which is the point here: the API
// sends its own headers (its own policy, no-store, no-referrer), and the site's would contradict
// them, a browser reading the last of two Referrer-Policy values. So it repeats exactly one, the
// server's Strict-Transport-Security, and no other location may add a header (nginxHeaders).
test('nginx hands /api/ to the API on loopback, with the server\'s HSTS line and none of the site\'s other headers', () => {
  const conf = read('deploy/nginx.conf');
  const [plain, tls] = nginxServers();
  const api = conf.match(API_LOCATION);
  assert.ok(api, 'nginx.conf has `location ^~ /api/`');
  assert.equal(conf.match(new RegExp(API_LOCATION.source, 'gm')).length, 1, 'once');
  assert.ok(tls.includes('location ^~ /api/ {') && !plain.includes('/api/'), 'inside the https server; plain http only redirects');
  const lines = api[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  assert.ok(lines.every((l) => l.endsWith(';')), 'one directive a line');
  const directives = lines.map((l) => l.slice(0, -1).replace(/\s+/g, ' '));
  assert.deepEqual(directives, [
    'proxy_pass http://127.0.0.1:8788',
    'proxy_http_version 1.1',
    'proxy_set_header Connection ""',
    'client_max_body_size 1m',
    'proxy_read_timeout 30s',
    `add_header Strict-Transport-Security "${HEADERS['Strict-Transport-Security']}" always`,
  ], 'the proxy to 127.0.0.1:8788 with no URI, and the server block\'s HSTS line as it is written there');
  for (const p of ['/api/config', '/api/me', '/api/auth/google/start', '/api/auth/google/callback', '/api/webhooks/stripe', '/api/no/such/route', '/api/.git/config', '/api/index.html']) {
    assert.equal(nginxAnswers(p), 'proxied', `${p} goes to the API, neither served from the folder nor refused`);
  }
  for (const p of ['/api', '/apix', '/src/api/x.js', '/index.html']) assert.notEqual(nginxAnswers(p), 'proxied', `${p} is not the API's`);
});

test('the API is run by a host, never published by one, and Cloudflare Pages runs it for /api/* alone', () => {
  assert.deepEqual(Object.entries(site.HOST_FILES).filter(([, files]) => files.includes('_routes.json')).map(([host]) => host), ['cloudflare']);
  assert.deepEqual(JSON.parse(read('_routes.json')), { version: 1, include: ['/api/*'], exclude: [] });
  assert.deepEqual(site.siteFiles().filter((f) => /^(server|functions)\//.test(f) || f === '_routes.json'), []);
  assert.deepEqual(site.siteFiles().filter((f) => f.startsWith('api/')), ['api/config'], 'the one answer a host without the API gives');
  const htaccess = read('.htaccess');
  assert.match(htaccess, /^# mod_proxy_http: ProxyPass "\/api\/" "http:\/\/127\.0\.0\.1:8788\/api\/", and the Strict-Transport-Security$/m, '.htaccess says how Apache proxies the API, which it cannot do itself');
  assert.equal(apacheServes('api/config'), true, 'without that, Apache serves the static api/config');
});

// The rules above are only Apache's when it runs them. A stock Debian or Ubuntu Apache loads
// neither mod_rewrite nor mod_headers, and every block of .htaccess used to sit in an
// <IfModule>, so there it skipped them without a word: measured on Ubuntu's Apache 2.4.58 with
// its default modules, a checkout served by mistake answered 200 for /.git/config and
// /.certs/key.pem, with none of the headers and nothing in the error log. Unwrapped, the same
// server answers 500 with "Invalid command 'RewriteEngine'" in the log until the modules are on.
test('Apache: the settings never make a module optional, and the README says which they need', () => {
  const directives = read('.htaccess').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(directives, /<\s*IfModule\b/i, '.htaccess wraps nothing in <IfModule>');
  for (const directive of ['RewriteEngine On', 'RewriteRule !^(', 'Header always set Content-Security-Policy']) {
    assert.ok(directives.split('\n').some((l) => l.startsWith(directive)), `.htaccess runs ${directive} unconditionally`);
  }
  const readme = read('README.md').replace(/\s+/g, ' ');
  assert.match(readme, /`AllowOverride All`/, 'README says Apache reads .htaccess only under AllowOverride All');
  assert.match(readme, /`a2enmod rewrite headers`/, 'README names the modules a stock Apache lacks');
});

/** deploy/nginx.conf's top-level server blocks, each as its text between the braces. */
function nginxServers() {
  const conf = read('deploy/nginx.conf').replace(/#[^\n]*/g, '');
  const out = [];
  for (const m of conf.matchAll(/^server\s*\{/gm)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < conf.length; i++) {
      if (conf[i] === '{') depth++;
      else if (conf[i] === '}' && --depth === 0) { out.push(conf.slice(m.index + m[0].length, i)); break; }
    }
  }
  return out;
}
/** A block's own directives, its nested blocks left out, one per entry and spaced singly. */
const ownDirectives = (block) => {
  let flat = block;
  while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/[^;{}]*\{[^{}]*\}/g, ';');
  return flat.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean);
};

// The README says the Apache and nginx settings redirect plain http and answer a missing
// address with 404.html. The browser suite serves the site through its own stand-in for a
// Netlify-style host, so neither shows there: these hold the lines that do it, and
// test/hosts.mjs (in `npm run test:e2e`) runs both files in a real nginx and a real Apache.
test('Apache and nginx send plain http to https and a missing address to the site\'s not-found page', () => {
  const htaccess = read('.htaccess').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const engine = htaccess.indexOf('RewriteEngine On');
  const allowlist = htaccess.findIndex((l) => l.startsWith('RewriteRule !^('));
  assert.ok(engine !== -1 && allowlist > engine, '.htaccess turns the rewrite engine on before its allowlist');
  assert.deepEqual(htaccess.slice(engine + 1, allowlist), [
    'RewriteCond %{HTTPS} !=on',
    'RewriteCond %{HTTP:X-Forwarded-Proto} !=https',
    'RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]',
  ], '.htaccess redirects a request that came over plain http, and only that, to https, ahead of every other rule');
  assert.deepEqual(htaccess.filter((l) => l.startsWith('ErrorDocument')).sort(), ['ErrorDocument 403 /404.html', 'ErrorDocument 404 /404.html'], '.htaccess answers a missing address and a refused one with the not-found page');

  const servers = nginxServers();
  assert.equal(servers.length, 2, 'nginx.conf has two servers: plain http, and https');
  const [plain, tls] = servers.map(ownDirectives);
  assert.deepEqual(plain, ['listen 80', 'listen [::]:80', 'server_name example.com', 'server_tokens off', 'return 301 https://$host$request_uri'], 'the plain http server only redirects, every address, to the same one over https');
  assert.ok(!/\blocation\b/.test(servers[0]), 'the plain http server has no location of its own');
  assert.ok(tls.includes('error_page 403 404 =404 /404.html'), 'the https server answers a missing address, a folder and a refused file with the not-found page');
});

// `http2 on;` is a directive from nginx 1.25.1. Before that (Ubuntu 24.04 ships 1.24, Debian 12
// 1.22) it is unknown, and nginx refuses to load the whole file: measured with 1.24.0, `nginx
// -t` fails with `unknown directive "http2"`. Asked for on the listen lines, as here, HTTP/2 is
// on in every nginx since 1.9.5; from 1.25.1 that form is deprecated with a warning, not refused.
test('nginx asks for HTTP/2 on the https listen lines, the form the nginx current distributions ship loads', () => {
  const [, tls] = nginxServers().map(ownDirectives);
  assert.deepEqual(tls.filter((d) => d.startsWith('listen ')), ['listen 443 ssl http2', 'listen [::]:443 ssl http2']);
  assert.deepEqual(tls.filter((d) => /^http2\b/.test(d)), [], 'no `http2` directive, which nginx before 1.25.1 does not know');
});

test('security.txt names a contact, the policy and an expiry no more than a year away', () => {
  const fields = {};
  for (const line of read('.well-known/security.txt').split('\n')) {
    const m = line.match(/^([A-Za-z-]+): (.+)$/);
    if (m) (fields[m[1]] = fields[m[1]] || []).push(m[2]);
  }
  // SECURITY.md asks for a private report, so the first contact is the repository's private
  // form. That form is off until the owner switches it on (measured: the repository's
  // private-vulnerability-reporting setting answers enabled: false), and with it off it is no
  // way in at all, so the second is the issues page, where SECURITY.md asks for a private
  // channel without the details.
  assert.deepEqual(fields.Contact, ['https://github.com/Platteration/phonogeometry/security/advisories/new', 'https://github.com/Platteration/phonogeometry/issues']);
  const policy = read('SECURITY.md').replace(/\s+/g, ' ');
  assert.match(policy, /Report a vulnerability/);
  assert.match(policy, /If that button is not there .*open an issue that says you have a security report and asks for a private channel, and leave the details out of it\./, 'SECURITY.md says what to do while the private form is off');
  // The policy as it is on the branch the Pages deploy publishes, the one the published
  // security.txt comes from; HEAD is the default branch, which may not carry SECURITY.md at all.
  const [deployed] = read('.github/workflows/pages.yml').match(/^ {4}branches: \[(\w[\w./-]*)\]$/m)?.slice(1) ?? [];
  assert.ok(deployed, 'pages.yml deploys from one branch');
  assert.deepEqual(fields.Policy, [`https://github.com/Platteration/phonogeometry/blob/${deployed}/SECURITY.md`]);
  assert.deepEqual(fields['Preferred-Languages'], ['en']);
  assert.equal(fields.Expires.length, 1);
  const expires = Date.parse(fields.Expires[0]);
  // RFC 9116: an expired file is to be treated as stale. Renew it with a date a year out.
  assert.ok(expires > Date.now(), `security.txt expired on ${fields.Expires[0]}: renew it`);
  assert.ok(expires - Date.now() <= 366 * 24 * 3600 * 1000, 'Expires is no more than a year away');
});
