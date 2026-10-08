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

/** Every `Header always set` in .htaccess, as { Header: value }. */
function apacheHeaders() {
  const out = {};
  for (const m of read('.htaccess').matchAll(/^\s*Header\s+always\s+set\s+([A-Za-z-]+)\s+"([^"]*)"(?:\s+env=HTTPS)?\s*$/gm)) {
    assert.ok(!Object.hasOwn(out, m[1]), `.htaccess: ${m[1]} is set once`);
    out[m[1]] = m[2];
  }
  assert.doesNotMatch(read('.htaccess'), /^\s*Header\s+(?!always\s+set\s)/m, '.htaccess sets every header with `Header always set`');
  return out;
}

/** Every `add_header` in deploy/nginx.conf, as { Header: value }. Each must carry `always`, or
 *  nginx leaves it off the 404 page and every other error response. */
function nginxHeaders() {
  const conf = read('deploy/nginx.conf');
  const out = {};
  for (const m of conf.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;\s*$/gm)) {
    assert.ok(!Object.hasOwn(out, m[1]), `nginx.conf: ${m[1]} is set once`);
    out[m[1]] = m[2];
  }
  assert.equal([...conf.matchAll(/^\s*add_header\b/gm)].length, Object.keys(out).length, 'nginx.conf: every add_header is quoted and `always`');
  // nginx drops the server's add_header lines from a location that sets one of its own.
  assert.doesNotMatch(conf.slice(conf.indexOf('location')), /location[^{]*\{[^}]*add_header/, 'nginx.conf: no location sets headers of its own');
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
  // it installs and caches nothing. Nothing else in the app talks to the network.
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
  const NOT_SITE = /(^|\/)(README|CLAUDE|AGENTS|CONVENTIONS|REVIEW|SECURITY|SECURITY-AUDIT)\.md$|^(test|tools|deploy|docs|node_modules|\.github|\.claude|\.certs)\/|^(_headers|_redirects|\.htaccess|package(-lock)?\.json|server\.js|LICENSE)$/;
  assert.deepEqual(files.filter((f) => NOT_SITE.test(f)), [], 'no notes, tests, tools, dev server or hosting settings');
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

/** Whether nginx serves a path, read the way nginx picks a location: exact, then regex, then
 *  the longest prefix. */
function nginxServes(urlPath) {
  const conf = read('deploy/nginx.conf');
  const server = conf.slice(conf.indexOf('listen 443'));
  const blocks = [...server.matchAll(/location\s+(=|~)?\s*(\S+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)?)\}/g)].map((m) => ({ kind: m[1] || 'prefix', match: m[2], body: m[3] }));
  const exact = blocks.find((b) => b.kind === '=' && b.match === urlPath);
  const regex = blocks.find((b) => b.kind === '~' && new RegExp(b.match).test(urlPath));
  const prefix = blocks.filter((b) => b.kind === 'prefix' && urlPath.startsWith(b.match)).sort((a, b) => b.match.length - a.match.length)[0];
  const block = exact || regex || prefix;
  assert.ok(block, `nginx.conf has a location for ${urlPath}`);
  return !/\breturn\s+404\b/.test(block.body);
}
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

test('security.txt names a contact, the policy and an expiry no more than a year away', () => {
  const fields = {};
  for (const line of read('.well-known/security.txt').split('\n')) {
    const m = line.match(/^([A-Za-z-]+): (.+)$/);
    if (m) (fields[m[1]] = fields[m[1]] || []).push(m[2]);
  }
  // SECURITY.md asks for a private report, so the contact is the repository's private form.
  assert.deepEqual(fields.Contact, ['https://github.com/Platteration/phonogeometry/security/advisories/new']);
  assert.match(read('SECURITY.md'), /Report a vulnerability/);
  assert.deepEqual(fields.Policy, ['https://github.com/Platteration/phonogeometry/blob/HEAD/SECURITY.md']);
  assert.deepEqual(fields['Preferred-Languages'], ['en']);
  assert.equal(fields.Expires.length, 1);
  const expires = Date.parse(fields.Expires[0]);
  // RFC 9116: an expired file is to be treated as stale. Renew it with a date a year out.
  assert.ok(expires > Date.now(), `security.txt expired on ${fields.Expires[0]}: renew it`);
  assert.ok(expires - Date.now() <= 366 * 24 * 3600 * 1000, 'Expires is no more than a year away');
});
