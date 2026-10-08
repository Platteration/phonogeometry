#!/usr/bin/env node
// The website: the files a visitor's browser loads, and nothing else from the repository.
//
//   node tools/site.js <folder>                 copy the site into <folder>
//   node tools/site.js <folder> --host=<name>   and the settings file that host reads from it
//   node tools/site.js --list                   print the site's files, one per line
//
// Nothing is built: the site is the committed files as they are, and this only copies them.
// The list is the service worker's SHELL (read out of sw.js rather than restated) plus what a
// site has beside the shell. The Pages deploy (.github/workflows/pages.yml) archives the same
// files out of the commit, and test/pages.test.js holds its list equal to this one. Not
// published: the notes, the tests, the tools, the dev server and the hosting settings, which
// a host reads but would otherwise serve as files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Beside the shell: the service worker itself, three.js's licence (whose permission notice has
 * to travel with the copy), the page every host answers a missing address with, robots.txt and
 * the security contact (RFC 9116). The worker caches none of them.
 */
export const EXTRA = ['sw.js', 'vendor/three/LICENSE', '404.html', 'robots.txt', '.well-known/security.txt'];

/**
 * The settings file each header-capable host reads from the folder it publishes. GitHub Pages
 * reads none and would serve them as files, and nginx's lives in the server's own
 * configuration, so those two get the site alone. Netlify reads _headers and _redirects;
 * Cloudflare Pages reads _headers but takes no 404 rule from _redirects, so there the folder
 * holding nothing else is the protection; Apache never serves .htaccess in its default
 * configuration.
 */
export const HOST_FILES = {
  pages: [],
  nginx: [],
  netlify: ['_headers', '_redirects'],
  cloudflare: ['_headers'],
  apache: ['.htaccess'],
};

/** sw.js's SHELL as paths from the site's root, the page's own './' left out (index.html is listed). */
export function shell() {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('sw.js declares no SHELL');
  return [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1].replace(/^\.\//, '')).filter(Boolean);
}

/** Every file of the site, sorted. */
export function siteFiles() {
  return [...new Set([...shell(), ...EXTRA])].sort();
}

/**
 * Copy the site, and the settings file `host` reads, into `out`, which must not exist yet or be
 * empty: a folder already holding something would be published along with the site.
 */
export function build(out, { host = 'pages' } = {}) {
  if (!Object.hasOwn(HOST_FILES, host)) throw new Error(`unknown host '${host}': one of ${Object.keys(HOST_FILES).join(', ')}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty`);
  const files = [...siteFiles(), ...HOST_FILES[host]];
  for (const f of files) {
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f), to);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    process.stdout.write(`${siteFiles().join('\n')}\n`);
  } else if (args.length >= 1 && args.length <= 2 && !args[0].startsWith('-') && args.slice(1).every((a) => a.startsWith('--host='))) {
    const host = args[1] ? args[1].slice('--host='.length) : 'pages';
    try {
      const files = build(path.resolve(args[0]), { host });
      console.log(`Phonogeometry: ${files.length} files copied to ${args[0]}`);
    } catch (err) {
      console.error(`Phonogeometry: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error('usage: node tools/site.js <folder> [--host=pages|nginx|netlify|cloudflare|apache] | --list');
    process.exit(2);
  }
}
