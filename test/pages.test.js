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
  const tracked = (spec) => execFileSync('git', ['ls-files', '-z', '--', ...spec], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
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

test('the deploy uploads the directory it assembled', () => {
  const { dir } = assembly();
  const m = workflow.match(/uses: actions\/upload-pages-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+path: (\S+)\n/);
  assert.ok(m, 'pages.yml uploads with actions/upload-pages-artifact, pinned to a commit, and names the path');
  assert.equal(m[1], dir);
});
