// .github/workflows/pages.yml publishes a list of paths, not the repository, and that list
// and the service worker's SHELL are two spellings of one fact: the files the app serves. A
// module added to SHELL and not to the list is a 404 on the live site, and the worker's
// install (`cache.addAll`, all or nothing) fails with it, so the site stops working offline
// as well; a file published and not in SHELL works until the network goes. Neither shows up
// anywhere else before a visitor finds it: every other suite serves the whole checkout.
//
// The site is served from a sub-path (<user>.github.io/<repository>/), so the SHELL entries
// are also resolved from one here: an entry written from the root would fetch outside the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

// Published beside the shell though the worker does not cache them: the worker itself, which
// the page registers, and the licence the vendored three.js is distributed under.
const NOT_CACHED = ['sw.js', 'vendor/three/LICENSE'];

const SITE = 'https://example.test/phonogeometry/';

/** The paths the workflow hands `git archive`, and the directory it unpacks them into. */
function assembly() {
  const lines = workflow.split('\n').filter((line) => /^\s*(- )?run: .*\bgit archive\b/.test(line));
  assert.equal(lines.length, 1, 'pages.yml assembles the site with exactly one `git archive` step');
  const m = lines[0].match(/git archive HEAD ((?:[\w./-]+ )*[\w./-]+) \| tar -x -C (\S+)$/);
  assert.ok(m, `not the expected form \`git archive HEAD <paths> | tar -x -C <dir>\`: ${lines[0].trim()}`);
  return { paths: m[1].split(' '), dir: m[2] };
}

/**
 * The files `git archive HEAD` reads: git's tracked list where a work tree is rooted at `dir`.
 * Otherwise every file on disk but node_modules and .git, since a `git archive` extract or a
 * downloaded ZIP has no work tree and is that same list, and a copy unpacked inside some other
 * work tree would get that tree's answer, which names nothing here. (test/conventions.mjs
 * reads the repository the same way.)
 */
function repositoryFiles(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (git('rev-parse', '--show-prefix').trim() === '') return git('ls-files', '-z').split('\0').filter(Boolean);
  } catch {
    // Not a work tree, or no git: read the disk.
  }
  const walk = (prefix) =>
    fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
      const file = prefix + entry.name;
      if (!entry.isDirectory()) return [file];
      return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(`${file}/`);
    });
  return walk('');
}

/** What the worker caches on install, as paths under the site, taken from the worker itself. */
async function shell() {
  const listeners = {};
  let cached = null;
  globalThis.self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: { href: `${SITE}sw.js` },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  globalThis.location = { origin: new URL(SITE).origin, href: `${SITE}sw.js` };
  globalThis.caches = { open: async () => ({ addAll: async (list) => { cached = list; } }) };
  await import('../sw.js');
  const waits = [];
  listeners.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(Array.isArray(cached) && cached.length > 0, 'the worker caches its shell on install');
  const base = new URL(SITE).pathname;
  return cached.map((entry) => {
    const { pathname } = new URL(entry, `${SITE}sw.js`);
    assert.ok(pathname.startsWith(base), `SHELL entry ${entry} resolves to ${pathname}, outside the site at ${base}`);
    return pathname.slice(base.length) || 'index.html';
  });
}

test('the site the deploy publishes is the service worker\'s shell, the worker and the three.js licence', async () => {
  const { paths } = assembly();
  const files = repositoryFiles(root);
  const tracked = (spec) => files.filter((f) => spec.some((p) => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`)));
  // `git archive` refuses a path that matches nothing, which would fail the deploy outright.
  for (const p of paths) assert.ok(tracked([p]).length > 0, `pages.yml publishes ${p}, which is not in the repository`);

  const published = [...new Set(tracked(paths))].sort();
  const expected = [...new Set([...(await shell()), ...NOT_CACHED])].sort();
  assert.deepEqual(
    published, expected,
    'The files pages.yml publishes and the files sw.js caches (plus sw.js and vendor/three/LICENSE) must be the same set.\n'
    + 'A file the app loads belongs in both: in SHELL so it works offline, in the `git archive` line so it is on the site.',
  );
});

// A copy that is not a checkout: a directory no work tree is rooted in, once on its own and once
// inside another work tree. Without git there is no other work tree to sit in, so only the
// first copy exists.
test('the published files are read off the disk where no work tree is rooted here', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  try {
    const copies = [path.join(outer, 'archive')];
    try {
      execFileSync('git', ['init', '-q', path.join(outer, 'repo')], { stdio: 'ignore' });
      copies.push(path.join(outer, 'repo', 'unpacked'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const copy of copies) {
      for (const f of ['index.html', 'src/app.js', 'node_modules/pkg/index.js', '.git/HEAD']) {
        fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
        fs.writeFileSync(path.join(copy, f), '\n');
      }
      assert.deepEqual(repositoryFiles(copy).sort(), ['index.html', 'src/app.js'], copy);
    }
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

// pages.yml line for line, comments and blank lines aside. The build job runs the test suite,
// so everything it may do is spelled out: check out without leaving the token in .git/config,
// set up Node, test, assemble, upload. Nothing else touches the directory between the
// assembly and the upload, which is what makes the test above a check of what is published.
// Only the deploy job holds pages: write and id-token: write, the scopes that publish the
// public site and mint an OIDC identity for the repository, and it runs nothing but the
// deploy action. A step, a scope or a trigger added anywhere fails here until this list is
// changed with it.
const SHAPE = [
  /^name: Deploy to GitHub Pages$/,
  /^on:$/,
  /^ {2}push:$/,
  /^ {4}branches: \[main\]$/,
  /^ {2}workflow_dispatch:$/,
  /^permissions:$/,
  /^ {2}contents: read$/,
  /^concurrency:$/,
  /^ {2}group: pages$/,
  /^ {2}cancel-in-progress: true$/,
  /^jobs:$/,
  /^ {2}build:$/,
  /^ {4}runs-on: ubuntu-latest$/,
  /^ {4}timeout-minutes: [1-9]\d*$/,
  /^ {4}steps:$/,
  /^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v\d+$/,
  /^ {8}with:$/,
  /^ {10}persist-credentials: false$/,
  /^ {6}- uses: actions\/setup-node@[0-9a-f]{40} # v\d+$/,
  /^ {8}with:$/,
  /^ {10}node-version-file: \.nvmrc$/,
  /^ {6}- run: npm test$/,
  /^ {6}- name: Assemble the site$/,
  /^ {8}run: mkdir dist && git archive HEAD [\w./ -]+ \| tar -x -C dist$/,
  /^ {6}- uses: actions\/upload-pages-artifact@[0-9a-f]{40} # v\d+$/,
  /^ {8}with:$/,
  /^ {10}path: dist$/,
  /^ {2}deploy:$/,
  /^ {4}needs: build$/,
  /^ {4}runs-on: ubuntu-latest$/,
  /^ {4}timeout-minutes: [1-9]\d*$/,
  /^ {4}permissions:$/,
  /^ {6}pages: write$/,
  /^ {6}id-token: write$/,
  /^ {4}environment:$/,
  /^ {6}name: github-pages$/,
  /^ {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/,
  /^ {4}steps:$/,
  /^ {6}- id: deployment$/,
  /^ {8}uses: actions\/deploy-pages@[0-9a-f]{40} # v\d+$/,
];

test('the deploy is checkout, Node, the tests, the assembly and the upload, and only its last job can publish', () => {
  const lines = workflow.split('\n').filter((line) => !/^\s*(#|$)/.test(line));
  const wrong = lines.findIndex((line, i) => !SHAPE[i]?.test(line));
  assert.ok(wrong < 0 && lines.length === SHAPE.length,
    wrong < 0
      ? `pages.yml has ${lines.length} lines where ${SHAPE.length} are expected`
      : `pages.yml line ${wrong + 1} (comments and blank lines aside) is ${JSON.stringify(lines[wrong])}, expected ${SHAPE[wrong] ?? 'no more lines'}`);
});

test('the deploy uploads the directory it assembled', () => {
  const { dir } = assembly();
  const m = workflow.match(/uses: actions\/upload-pages-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+path: (\S+)\n/);
  assert.ok(m, 'pages.yml uploads with actions/upload-pages-artifact, pinned to a commit, and names the path');
  assert.equal(m[1], dir);
});
