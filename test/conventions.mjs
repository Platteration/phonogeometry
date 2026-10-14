// The conventions shared by every platteration repository (see CONVENTIONS.md), pinned so
// that a session cannot quietly re-decide them. This file is the same, byte for byte, in
// every npm repository (tests/test_conventions.py is the Python repository's counterpart,
// with the same hashes and the same reading of the workflows): a check that only one
// repository needs goes in that repository's own tests. It uses node:test and Node's
// built-in modules only, and is deliberately named so no other runner's glob picks it up.
// The TypeScript tests read each config through the typescript package the repository
// installed (and expo, for a config that extends expo/tsconfig.base): where the repository
// has a TypeScript config and they are missing, those tests fail and say what to do, rather
// than skip, since a skipped check reads as a passed one. A repository with no TypeScript
// config needs neither. Files are listed through git where a work tree is rooted at the
// repository, and read off the disk otherwise (a `git archive` extract, a downloaded ZIP), so
// git is not needed either. The workflows are read as the block YAML they are written in, and
// any other spelling is refused rather than guessed at (readWorkflow); nginx.conf is read the same
// way, as the blocks and directives nginx reads (readNginx). The audit gate,
// .github/audit/npm-audit.mjs, is pinned here by hash, imported to run its own rules over
// made-up reports, and run itself against a stand-in npm, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const has = (p) => existsSync(join(root, p));
const sha = (data) => createHash('sha256').update(data).digest('hex');

// Update these when a shared text changes — in every repository, in one pass.
const EDITORCONFIG_SHA = '85bccbd23a9070becfe1dc0dbb9ad7305fb2bb98f92f54cb9856d7d6eca4ebfe';
const CONVENTIONS_SHA = '8b8f103281feba2c529f3fd53916aa3496b32440d7799c4e10ba2b74139bf85a';
const REVIEW_STATUS_SHA = '76028e2322f083eadee6727db50a9f4de1cb9cf3f4c23e12ea8945d0b97071d8';
const AGENTS_RULES_SHA = 'dae420f0895e527ee6159b16618ca077e515f5af1a2d302b2cdf3f9fdec0cb8b';
const AUDIT_GATE_SHA = '0c646af40521d5c043029e101ea26eaa1914149c51715f1b87ed9c1fdee8280c';
// The shared sign-in, shop and webhook kit (CONVENTIONS.md, "Integrations"): kitHash() over the
// canonical copy's files. When the canonical kit changes, compute it again with kitHash() and
// write it here, in every repository, in the same pass that copies the kit.
const KIT_SHA = '35177df33665e91af1b7c9ec7b464ade32bf848a466b55739d793699bd9861e5';
// The one runner image every job of every workflow names (CONVENTIONS.md, "CI"), never
// ubuntu-latest, which GitHub moves to a new release on a date of its own (Ubuntu 26.04 from
// 2026-10-19, where Playwright 1.56 has no Chromium). Moving it is one change, made here and in
// every workflow of every repository in one pass, with each repository's Playwright checked
// against the new image first.
const RUNNER = 'ubuntu-24.04';
// CI's weekly run (CONVENTIONS.md, "CI"). Not at the top of the hour, which GitHub's
// documentation names as a high-load time, when a scheduled run can be delayed or dropped.
const SCHEDULE = '17 6 * * 1';
// The first major of each official action whose runtime is Node 24 (`runs.using` in its
// action.yml at the tag, or for a composite action the actions it runs: upload-pages-artifact v5
// uploads with upload-artifact v7, and is also the first that can keep .well-known/). An official
// action not listed here fails until it is added, in every repository. The floor is read from the
// tag comment, which Dependabot writes with the SHA; an offline test cannot ask GitHub which tag a
// SHA is, so NODE20_SHAS lists the commits every tag of each Node 20 major points at (the first
// twelve hex digits, read with git ls-remote), and a pin to one fails whatever its comment says.
const ACTION_FLOORS = { checkout: 5, 'setup-node': 5, 'setup-python': 6, 'upload-artifact': 6, 'upload-pages-artifact': 5, 'deploy-pages': 5 };
const NODE20_SHAS = {
  checkout: '08eba0b27e82 0ad4b8fadaa2 11bd71901bbe 11d5960a3267 1d96c772d194 1e31de5234b9 34e114876b0b 44c2b7a8a4ea 692973e3d937 8ade135a41bc 9bb56186c3b0 a5ac7e51b410 b4ffde65f463 d632683dd7b4 eef61447b9ff',
  'setup-node': '0a44ba784172 1d0ff469b7ec 1e60f620b954 39370e3970a6 49933ea5288c 60edb5dd545a 8f152de45cc3 b39b52d1213e cdca7365b2da',
  'setup-python': '0a5c61591373 0b93645e9fea 39cd14951b08 42375524e23c 82c7e631bb3c 8d9ed9ac5c53 a26af69be951 f677139bbe7f',
  'upload-artifact': '0b2256b8c012 1746f4ab65b1 1eb3cb2b3e0f 26f96dfa697d 330a01c490ac 4cec3d8aa04e 50769540e7f4 5d5d22a31266 604373da6381 65462800fd76 65c4c4a1ddee 694cdabd8bdb 6f51ac03b935 834a144ee995 84480863f228 89ef406dd8d7 b4b15b8c7c6a c7d193f32edc ea165f8d65b6',
  'upload-pages-artifact': '0252fc4ba762 56afc609e742 7b1f4a764d45',
  'deploy-pages': '7a9bd943aa5e 87c3283f01cd d6db90164ac5 d8af841ac341 decdde0ac072 f33f41b675f0',
};
const AUDIT_GATE = '.github/audit/npm-audit.mjs';
const AUDIT_ACCEPTED = '.github/audit/accepted.json';
// Where a repository keeps the kit: server/kit, or the place its stack needs (CLAUDE.md says why).
const KIT_DIRS = ['server/kit', 'apps/server/kit', 'packages/core/src/kit'];
// The kit's own modules, by file name: a folder elsewhere holding three of them is a second copy.
const KIT_MODULES = ['app.js', 'cloudflare.js', 'config.js', 'crypto.js', 'google.js', 'http.js', 'node.js', 'store.js', 'stripe.js'];

const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts ?? {};
const lockfile = has('package-lock.json');
const CI = '.github/workflows/ci.yml';
const PAGES = '.github/workflows/pages.yml';

/** REVIEW.md's shared block: from the line `### Status of the shared items` up to, not
 *  including, the line `### A hardened workflow to copy`, each of which it has once. */
function reviewStatus(review) {
  const lines = review.split('\n');
  const starts = lines.flatMap((line, i) => (line.startsWith('### Status of the shared items') ? [i] : []));
  const ends = lines.flatMap((line, i) => (line === '### A hardened workflow to copy' ? [i] : []));
  assert.ok(starts.length === 1 && ends.length === 1 && starts[0] < ends[0], 'REVIEW.md has the shared status block once, before "### A hardened workflow to copy"');
  return `${lines.slice(starts[0], ends[0]).join('\n')}\n`;
}

/** AGENTS.md's working rules: from the line `# Working rules for coding agents` to the end of its
 *  section `## 10. Never`, which ends at the next heading of level one or two, at the next line
 *  that opens an HTML comment (a tool's own block, such as Next.js's) or at the end of the file,
 *  trailing blank lines aside. */
function agentsRules(agents) {
  const lines = agents.split('\n');
  const starts = lines.flatMap((line, i) => (line === '# Working rules for coding agents' ? [i] : []));
  assert.equal(starts.length, 1, 'AGENTS.md has the working rules once, under "# Working rules for coding agents"');
  const never = lines.findIndex((line, i) => i > starts[0] && line === '## 10. Never');
  assert.ok(never !== -1, 'the working rules end with the section "## 10. Never"');
  let end = lines.findIndex((line, i) => i > never && (/^#{1,2} /.test(line) || line.startsWith('<!--')));
  if (end === -1) end = lines.length;
  const block = lines.slice(starts[0], end);
  while (block.length > 0 && block[block.length - 1] === '') block.pop();
  return `${block.join('\n')}\n`;
}

test('.editorconfig, CONVENTIONS.md, the shared block of REVIEW.md and the working rules in AGENTS.md are the shared copies', () => {
  assert.equal(sha(readFileSync(join(root, '.editorconfig'))), EDITORCONFIG_SHA, '.editorconfig differs from the shared copy');
  assert.equal(sha(readFileSync(join(root, 'CONVENTIONS.md'))), CONVENTIONS_SHA, 'CONVENTIONS.md differs from the shared copy');
  assert.equal(sha(reviewStatus(read('REVIEW.md'))), REVIEW_STATUS_SHA, 'the "Status of the shared items" block of REVIEW.md differs from the shared copy');
  assert.equal(sha(agentsRules(read('AGENTS.md'))), AGENTS_RULES_SHA, 'the working rules in AGENTS.md differ from the shared copy');
});

test('Node is pinned once, in .nvmrc, and engines agrees', () => {
  assert.equal(read('.nvmrc').trim(), '22');
  assert.match(pkg.engines?.node ?? '', /^>=22(\.|$)/, 'engines.node should be ">=22" or tighter');
  assert.equal(pkg.packageManager, undefined, 'no packageManager field');
});

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
/** A command that ends a failure as a success. */
const SWALLOW = /\|\|\s*(?:true\b|:(?=\s|;|$)|exit\s+0\b|echo\b)|;\s*(?:true|:|exit\s+0)\s*$/;

test('the script set', () => {
  const files = repositoryFiles(root);
  for (const s of ['test', 'check', 'test:conventions']) assert.ok(scripts[s], `missing script ${s}`);
  if (files.some((f) => TSCONFIG.test(f))) assert.ok(scripts.typecheck, 'a TypeScript repository has typecheck');
  assert.equal(Boolean(scripts['test:e2e']), Boolean(scripts['test:all']), 'test:e2e and test:all come together');
  assert.equal(scripts['test:conventions'], 'node --test test/conventions.mjs');
  // The gate before a push runs every one of these the repository has, and the first failure
  // stops it: `npm run test:conventions` alone contains `npm run test`, and `;` goes on.
  const gate = ['lint', 'typecheck', 'test', 'test:conventions'].filter((s) => scripts[s]).map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`));
  assert.equal(scripts.check, gate.join(' && '), `check is exactly \`${gate.join(' && ')}\``);
  const members = workspaces(root, files);
  for (const dir of ['', ...members]) {
    const where = dir ? `${dir}/package.json` : 'package.json';
    const mine = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts ?? {};
    if (ESLINT_CONFIGS.some((c) => existsSync(join(root, dir, c)))) assert.equal(mine.lint, 'eslint .', `${where}: an ESLint config means lint is \`eslint .\``);
    else if (!dir && members.length > 0 && mine.lint) assert.equal(mine.lint, 'npm run lint --workspaces', 'a workspace root without an ESLint config of its own lints its workspaces');
    for (const s of ['test', 'lint', 'test:e2e', 'test:all']) {
      if (mine[s]) assert.doesNotMatch(mine[s], SWALLOW, `${where}: ${s} does not end a failure as a success`);
    }
  }
  // A tracked .npmrc is read by every npm command, and `script-shell` or `offline` there makes
  // every script, or the audit, pass.
  assert.ok(!files.includes('.npmrc'), 'no .npmrc: npm runs with its own defaults');
  // An Expo app's website is built by one script under one name (CONVENTIONS.md, "Website").
  for (const { dir } of apps(files).filter((a) => a.kind === 'expo')) {
    const where = dir ? `${dir}/package.json` : 'package.json';
    assert.equal(JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts?.['build:web'], 'node scripts/build-web.mjs', `${where}: the website is \`build:web\`, \`node scripts/build-web.mjs\``);
  }
});

/** A plain mapping key: what every key in these workflows is. */
const KEY = /^[A-Za-z_][\w.-]*$/;

/** A workflow file read as the block YAML these files are written in, and nothing else:
 *  block mappings with plain keys, block lists indented under their key, scalars (plain,
 *  quoted, or a `|`/`>` block) and one-line flow lists of scalars. Every other spelling YAML
 *  allows (a flow mapping `{ ... }`, a quoted or complex key, an anchor, alias, tag or merge
 *  key, a list at its key's own indent, a plain value carried onto another line, a tab, a
 *  second document) throws with its line: each check reads the tree, and a spelling it does
 *  not read is one it cannot check. Scalars stay strings, and an empty value is null. It
 *  returns the tree, the lines, and every key with the index of its line. The same reader as
 *  tests/test_conventions.py's parse_workflow. */
function parseWorkflow(text, file) {
  const lines = text.split('\n');
  const keys = [];
  const fail = (n, why) => {
    throw new Error(`${file}:${n + 1}: ${why}, which the conventions test does not read: ${JSON.stringify(lines[n] ?? '')}`);
  };
  const blank = (line) => /^\s*(#.*)?$/.test(line);
  const indent = (line) => line.length - line.trimStart().length;
  lines.forEach((line, n) => {
    if (line.includes('\t')) fail(n, 'a tab');
    if (/^(---|\.\.\.)(\s|$)|^%/.test(line)) fail(n, 'a document marker or directive');
  });
  let at = 0;
  const skip = () => {
    while (at < lines.length && blank(lines[at])) at += 1;
  };
  const isItem = (text) => text === '-' || text.startsWith('- ');
  const unescape = (body, n) =>
    body.replace(/\\(.)/g, (_, c) => {
      const out = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[c];
      if (out === undefined) fail(n, `the escape \\${c}`);
      return out;
    });
  const trailing = (rest, n, what) => {
    if (!/^(\s+#.*)?$/.test(rest)) fail(n, `text after ${what}`);
  };

  /** One scalar or flow list: the whole of `text`, a comment after it apart. */
  function scalar(text, n) {
    let m;
    if ((m = text.match(/^"((?:[^"\\]|\\.)*)"(.*)$/))) {
      trailing(m[2], n, 'a quoted value');
      return unescape(m[1], n);
    }
    if ((m = text.match(/^'((?:[^']|'')*)'(.*)$/))) {
      trailing(m[2], n, 'a quoted value');
      return m[1].replaceAll("''", "'");
    }
    if (/^["']/.test(text)) fail(n, 'a quoted value that does not close on its line');
    if (text.startsWith('[')) return flow(text, n);
    if (/^[{&*!|>%@`,\]}]|^[-?:](\s|$)/.test(text)) fail(n, 'a flow mapping, anchor, alias, tag or indicator');
    const value = text.replace(/\s+#.*$/, '').trimEnd();
    if (/:(\s|$)/.test(value)) fail(n, 'a colon and a space inside a plain value');
    return value;
  }

  /** A flow list of scalars on one line: `[a, "b", 'c']`. */
  function flow(text, n) {
    const out = [];
    let rest = text.slice(1).trimStart();
    if (rest.startsWith(']')) {
      trailing(rest.slice(1), n, 'a list');
      return out;
    }
    for (;;) {
      const m =
        rest.match(/^"((?:[^"\\]|\\.)*)"/) ?? rest.match(/^'((?:[^']|'')*)'/) ?? rest.match(/^([^\s,[\]{}#'"&*!|>%@`?:-][^,[\]{}#]*?)(?=\s*[,\]])/);
      if (!m || /:(\s|$)/.test(m[1])) fail(n, 'a list item that is not a plain or quoted value');
      out.push(m[0].startsWith('"') ? unescape(m[1], n) : m[0].startsWith("'") ? m[1].replaceAll("''", "'") : m[1]);
      rest = rest.slice(m[0].length).trimStart();
      if (rest.startsWith(',')) {
        rest = rest.slice(1).trimStart();
        continue;
      }
      if (!rest.startsWith(']')) fail(n, 'a list that does not close on its line');
      trailing(rest.slice(1), n, 'a list');
      return out;
    }
  }

  /** A `|` or `>` block: the lines indented past `ind`, as they are. */
  function block(ind) {
    const body = [];
    let content = -1;
    while (at < lines.length) {
      const line = lines[at];
      if (line.trim() === '') {
        body.push('');
        at += 1;
        continue;
      }
      const i = indent(line);
      if (content === -1) {
        if (i <= ind) break;
        content = i;
      }
      if (i < content) break;
      body.push(line.slice(content));
      at += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    return body.length > 0 ? `${body.join('\n')}\n` : '';
  }

  /** The value after `key:` on line `n`, whose key sits at `ind`. */
  function value(rest, ind, n) {
    at = n + 1;
    if (rest === '' || rest.startsWith('#')) {
      skip();
      if (at < lines.length && indent(lines[at]) === ind && isItem(lines[at].slice(ind))) fail(at, "a list at its key's own indent");
      if (at < lines.length && indent(lines[at]) > ind) return node(indent(lines[at]));
      return null;
    }
    if (/^[|>]/.test(rest)) {
      if (!/^[|>][+-]?(\s+#.*)?$/.test(rest)) fail(n, 'a block value header');
      return block(ind);
    }
    const out = scalar(rest, n);
    skip();
    if (at < lines.length && indent(lines[at]) > ind) fail(at, 'a value carried onto the next line');
    return out;
  }

  /** `key: value` at `ind` on line `n`, into `out`. */
  function entry(out, text, ind, n) {
    const m = text.match(/^(\S+?):(?:\s+(.*))?$/) ?? text.match(/^(\S+?):$/);
    if (!m || !KEY.test(m[1])) fail(n, 'a key that is not a plain name');
    if (m[1] === '__proto__' || Object.hasOwn(out, m[1])) fail(n, `the key ${m[1]} twice`);
    keys.push({ key: m[1], line: n });
    out[m[1]] = value((m[2] ?? '').trim(), ind, n);
  }

  function mapping(ind, out = {}) {
    for (;;) {
      skip();
      if (at >= lines.length || indent(lines[at]) < ind) return out;
      if (indent(lines[at]) > ind) fail(at, 'a line indented under nothing');
      if (isItem(lines[at].slice(ind))) fail(at, 'a list item among keys');
      entry(out, lines[at].slice(ind), ind, at);
    }
  }

  function sequence(ind) {
    const out = [];
    for (;;) {
      skip();
      if (at >= lines.length || indent(lines[at]) < ind) return out;
      if (indent(lines[at]) > ind) fail(at, 'a line indented under nothing');
      const text = lines[at].slice(ind);
      if (!isItem(text)) fail(at, 'a key among list items');
      const item = text.slice(2).trim();
      const n = at;
      if (item === '' || item.startsWith('#')) fail(n, 'a list item on the lines below its dash');
      if (/^[^\s"'[{]\S*?:(\s|$)/.test(item)) {
        const first = {};
        entry(first, item, ind + 2, n);
        out.push(mapping(ind + 2, first));
      } else {
        out.push(value(item, ind, n));
      }
    }
  }

  function node(ind) {
    return isItem(lines[at].slice(ind)) ? sequence(ind) : mapping(ind);
  }

  skip();
  if (at < lines.length && indent(lines[at]) !== 0) fail(at, 'a document that does not start at the margin');
  const tree = mapping(0);
  skip();
  if (at < lines.length) fail(at, 'a line after the document');
  return { tree, lines, keys };
}

const workflows = new Map();
/** A workflow of this repository, read once. */
function readWorkflow(file) {
  if (!workflows.has(file)) workflows.set(file, parseWorkflow(read(file), file));
  return workflows.get(file);
}

const isMapping = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (x, key) => isMapping(x) && Object.hasOwn(x, key);
const jobsOf = (tree) => (isMapping(tree.jobs) ? tree.jobs : {});
const stepsOf = (job) => (isMapping(job) && Array.isArray(job.steps) ? job.steps : []);
/** Whether `step` uses actions/<name>, wherever in the step its `uses:` is (GitHub reads the owner
 *  and the name in any case). */
const action = (step, name) => typeof step?.uses === 'string' && step.uses.toLowerCase().startsWith(`actions/${name}@`);
/** Every scalar in a tree: where a command in any job or step would be. */
const scalars = (x) => (x === null ? [] : typeof x === 'string' ? [x] : Object.values(x).flatMap(scalars));
/** The index of the step that is exactly `- run: <command>` and nothing more, or -1. */
const bareRun = (steps, command) => steps.findIndex((s) => isMapping(s) && Object.keys(s).length === 1 && s.run === command);

const WORKFLOWS = ['ci.yml', 'pages.yml'];
const TOP_KEYS = ['name', 'on', 'concurrency', 'permissions', 'jobs'];
const JOB_KEYS = {
  'ci.yml': () => ['runs-on', 'timeout-minutes', 'steps', 'name', 'strategy'],
  'pages.yml': (job) => ({ build: ['runs-on', 'timeout-minutes', 'steps'], deploy: ['needs', 'runs-on', 'timeout-minutes', 'permissions', 'environment', 'steps'] })[job] ?? [],
};
const STEP_KEYS = ['name', 'id', 'run', 'uses', 'with', 'env', 'working-directory', 'if'];
/** Variables that change how npm, Node, Python or the shell runs a step. */
const TOOLCHAIN_ENV = /^(npm_config_\w*|NODE_OPTIONS|NODE_PATH|PYTHON\w*|PYTEST_\w*|BASH_ENV|ENV|SHELL|SHELLOPTS|BASHOPTS|PATH|LD_\w+)$/i;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const PINNED_LINE = /^\s*(- )?uses: ([\w.-]+)\/([\w./-]+)@([0-9a-f]{40}) # v(\d+)(\.\d+)*$/;
/** The browser install, in the one form a workflow writes it. */
const BROWSER_INSTALL = 'npx playwright install --with-deps chromium';
/** Any Playwright browser install, however it is spelt (a version, extra spaces, other flags). */
const ANY_BROWSER_INSTALL = /\bplaywright(@\S+)?\s+install\b/;

// Every workflow, every job and every step, whatever its spelling: a key the reader does not
// know, a job or step key outside these lists, or an environment variable a tool reads, is a
// way for a step to pass red that no check below would see. Every job names the one runner
// image as a plain value (not a list, a matrix or an expression), and every official action is
// at a major that runs on Node 24.
test('the workflows: ci.yml and pages.yml, in block YAML, pinned, on one runner, and nothing that lets a step pass red', () => {
  const files = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.deepEqual(files.filter((f) => !WORKFLOWS.includes(f)), [], 'the workflows are ci.yml and, for a Pages deploy, pages.yml: no other');
  for (const f of files) {
    const file = `.github/workflows/${f}`;
    const { tree, lines, keys } = readWorkflow(file);
    assert.deepEqual(Object.keys(tree).filter((k) => !TOP_KEYS.includes(k)), [], `${file}: no top-level key but ${TOP_KEYS.join(', ')}: an env: or a defaults: there reaches every step`);
    for (const { line } of keys.filter((k) => k.key === 'uses')) {
      const pinned = PINNED_LINE.exec(lines[line]);
      assert.ok(pinned, `${file}:${line + 1}: every action is pinned to a commit SHA with its tag in a comment`);
      if (pinned[2].toLowerCase() !== 'actions') continue;
      const name = pinned[3].toLowerCase();
      const floor = Object.hasOwn(ACTION_FLOORS, name) ? ACTION_FLOORS[name] : undefined;
      assert.ok(floor !== undefined, `${file}:${line + 1}: actions/${name} is not an action this test knows: add its Node 24 floor to ACTION_FLOORS, in every repository`);
      assert.ok(Number(pinned[5]) >= floor, `${file}:${line + 1}: actions/${name} v${pinned[5]} runs on Node 20, which GitHub is retiring: v${floor} or later`);
      assert.ok(!NODE20_SHAS[name].split(' ').includes(pinned[4].slice(0, 12)), `${file}:${line + 1}: actions/${name}@${pinned[4]} is a commit of a Node 20 major, whatever its comment says: pin the SHA of the v${floor} (or later) tag`);
    }
    assert.deepEqual(scalars(tree).filter((s) => ANY_BROWSER_INSTALL.test(s) && s !== BROWSER_INSTALL), [], `${file}: the browser is installed as \`${BROWSER_INSTALL}\`, in no other form`);
    for (const [name, job] of Object.entries(jobsOf(tree))) {
      const allowed = JOB_KEYS[f](name);
      assert.ok(isMapping(job), `${file}: ${name} is a job`);
      assert.equal(job['runs-on'], RUNNER, `${file}: the ${name} job runs on ${RUNNER}, the one image every job names`);
      assert.deepEqual(Object.keys(job).filter((k) => !allowed.includes(k)), [], `${file}: the ${name} job has no key but ${allowed.join(', ')}: no if:, continue-on-error, env: or permission of its own`);
      assert.ok(stepsOf(job).length > 0, `${file}: the ${name} job has steps`);
      for (const [i, step] of stepsOf(job).entries()) {
        const where = `${file}: ${name}, step ${i + 1}`;
        assert.ok(isMapping(step), `${where} is a mapping`);
        assert.deepEqual(Object.keys(step).filter((k) => !STEP_KEYS.includes(k)), [], `${where} has no key but ${STEP_KEYS.join(', ')}: no continue-on-error, no shell:`);
        assert.equal(Number(own(step, 'run')) + Number(own(step, 'uses')), 1, `${where} runs a command or uses an action`);
        if (own(step, 'uses')) assert.match(String(step.uses), PINNED, `${where} uses an action pinned to a commit SHA`);
        if (own(step, 'if')) assert.ok(step.if === 'failure()' && action(step, 'upload-artifact'), `${where}: the only if: is if: failure() on a step that uploads what a failed run left behind`);
        if (own(step, 'env')) {
          assert.ok(isMapping(step.env), `${where}: env is a mapping`);
          assert.deepEqual(Object.keys(step.env).filter((k) => TOOLCHAIN_ENV.test(k)), [], `${where}: an env: sets the step's own variables, none that npm, Node, Python or the shell reads`);
        }
        if (action(step, 'setup-node')) {
          assert.equal(step.with?.['node-version-file'], '.nvmrc', `${where} sets up Node from .nvmrc`);
          assert.ok(!own(step.with, 'node-version'), `${where} names no Node version of its own`);
        }
        // From v4 the action leaves out every path that starts with a dot unless told to keep
        // them (v5), and the site's .well-known/security.txt with them.
        if (action(step, 'upload-pages-artifact')) assert.equal(step.with?.['include-hidden-files'], 'true', `${where} keeps .well-known/ in the site (include-hidden-files: true)`);
      }
    }
  }
});

test('ci.yml: name, triggers, concurrency, permissions and timeouts', () => {
  assert.ok(has(CI), `${CI} exists`);
  const { tree } = readWorkflow(CI);
  assert.equal(tree.name, 'CI', 'the workflow is named CI');
  // Every branch, pull requests, by hand, and once a week: GitHub runs the schedule from the
  // default branch only, so an advisory or a rotting build shows there without a push.
  assert.deepEqual(tree.on, { push: { branches: ['**'] }, pull_request: null, workflow_dispatch: null, schedule: [{ cron: SCHEDULE }] }, 'on: push on every branch, pull_request, workflow_dispatch and the weekly schedule, nothing else');
  assert.deepEqual(tree.concurrency, { group: 'ci-${{ github.ref }}', 'cancel-in-progress': 'true' }, 'a concurrency group per ref cancels superseded runs');
  // No job may name permissions of its own (the job keys above), so this is all there is.
  assert.deepEqual(tree.permissions, { contents: 'read' }, 'permissions: contents: read at the top, and nothing else anywhere');
  // A job without one runs for GitHub's default of six hours.
  for (const [name, job] of Object.entries(jobsOf(tree))) assert.match(String(job['timeout-minutes']), /^[1-9]\d*$/, `the ${name} job states its timeout-minutes`);
  const setups = Object.values(jobsOf(tree)).flatMap(stepsOf).filter((s) => action(s, 'setup-node'));
  assert.equal(setups.some((s) => s.with?.cache === 'npm'), lockfile, 'cache: npm exactly when there is a lockfile');
  if (!lockfile) assert.ok(!setups.some((s) => own(s.with, 'cache')), 'no cache without a lockfile');
  assert.equal(scalars(tree).some((s) => /\bnpm ci\b/.test(s)), lockfile, 'npm ci exactly when there is a lockfile');
});

/** The Expo or Next.js app among the repository's packages, as [{ dir, kind }]. */
function apps(files) {
  return ['', ...workspaces(root, files)].flatMap((dir) => {
    const deps = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).dependencies ?? {};
    return ['expo', 'next'].filter((kind) => Object.hasOwn(deps, kind)).map((kind) => ({ dir, kind }));
  });
}

// CONVENTIONS.md lists the check job's first steps, in order, each a bare `run:` after the two
// actions, with nothing between them: the command with `|| true` after it, an `if:` beside it,
// a step before it that rewrites what it runs, or a checkout of another ref, is a step the
// check job does not have. Then the app's bundle, then whatever else the repository runs.
test('ci.yml: the check job', () => {
  const { tree } = readWorkflow(CI);
  const job = jobsOf(tree).check;
  assert.ok(isMapping(job), 'ci.yml has a check job');
  assert.equal(job['timeout-minutes'], '20', 'check has timeout-minutes: 20');
  const steps = stepsOf(job);
  assert.ok(action(steps[0], 'checkout') && Object.keys(steps[0]).length === 1, 'check starts with a checkout of the commit, nothing beside it');
  assert.ok(action(steps[1], 'setup-node'), 'then sets up Node');
  assert.deepEqual(Object.keys(steps[1]).sort(), ['uses', 'with'], 'setup-node carries its with: and nothing else');
  assert.deepEqual(steps[1].with, { 'node-version-file': '.nvmrc', ...(lockfile ? { cache: 'npm' } : {}) }, 'check sets up Node from .nvmrc, caching npm exactly when there is a lockfile');
  assert.equal(steps.filter((s) => action(s, 'setup-node')).length, 1, 'check sets up Node once');
  const commands = [
    ...(lockfile ? ['npm ci'] : []),
    ...['lint', 'typecheck'].filter((s) => scripts[s]).map((s) => `npm run ${s}`),
    'npm test',
    'npm run test:conventions',
  ];
  assert.deepEqual(steps.slice(2, 2 + commands.length), commands.map((run) => ({ run })), `after them, check runs ${commands.join(', ')}, each a bare step, in that order, with nothing between`);
  let next = 2 + commands.length;
  const app = apps(repositoryFiles(root));
  assert.ok(app.length <= 1, 'one Expo or Next.js app in a repository');
  if (app.length === 1) {
    const [{ dir, kind }] = app;
    const step = steps[next] ?? {};
    if (kind === 'expo') {
      assert.match(String(step.run), /^npx expo export( --platform [a-z]+)+ --output-dir \S+$/, 'then check bundles the Expo app with `npx expo export`');
      assert.equal(step['working-directory'], dir || undefined, `the bundle runs in the app's own directory${dir ? `, ${dir}` : ''}`);
      assert.deepEqual(Object.keys(step).filter((k) => !['name', 'run', 'working-directory'].includes(k)), [], 'the bundle step has a name, its run and its working-directory, nothing else');
    } else {
      assert.equal(step.run, 'npm run build', 'then check builds the Next.js app with `npm run build`');
      assert.deepEqual(Object.keys(step).filter((k) => !['name', 'run', 'env'].includes(k)), [], 'the build step has a name, its run and its env, nothing else');
    }
    next += 1;
  }
  // The end-to-end suite is a step of check, not a job of its own: it needs no other
  // toolchain. It may carry a name and an environment, nothing that lets it pass red.
  if (scripts['test:e2e']) {
    assert.equal(scalars(tree).filter((s) => /\bnpm run test:e2e\b/.test(s)).length, 1, 'npm run test:e2e runs once in ci.yml');
    const e2e = steps.findIndex((s) => s?.run === 'npm run test:e2e');
    assert.ok(e2e !== -1, 'the end-to-end suite is a step of the check job that runs exactly `npm run test:e2e`');
    assert.deepEqual(Object.keys(steps[e2e]).filter((k) => !['name', 'run', 'env'].includes(k)), [], 'the end-to-end step has a name, its run and its env, nothing else');
    assert.ok(e2e >= next, 'the end-to-end step comes after the build');
  }
});

// The job exactly, so that it can fail: a line anywhere else in the file cannot stand in for
// one missing here, and `|| true`, `continue-on-error`, `if:`, an install step, a cache or a
// commented-out audit is a job this is not. The audit itself, `npm audit --omit=dev`, runs inside
// the shared gate, whose bytes the next test pins; no workflow runs npm audit of its own.
test('ci.yml: the audit job exactly where there is a lockfile', () => {
  const { tree } = readWorkflow(CI);
  const job = jobsOf(tree).audit;
  const everywhere = WORKFLOWS.filter((f) => has(`.github/workflows/${f}`)).flatMap((f) => scalars(readWorkflow(`.github/workflows/${f}`).tree));
  assert.deepEqual(everywhere.filter((s) => /\bnpm\s+audit\b/.test(s)), [], `no workflow runs npm audit of its own: the audit job runs it through ${AUDIT_GATE}`);
  const gates = everywhere.filter((s) => s.includes(AUDIT_GATE));
  if (!lockfile) {
    assert.equal(job, undefined, 'no audit job without a lockfile: there is nothing for it to read');
    assert.deepEqual(gates, [], 'no audit gate without a lockfile');
    return;
  }
  assert.ok(isMapping(job), 'the audit is a job of its own');
  assert.deepEqual(Object.keys(job).sort(), ['runs-on', 'steps', 'timeout-minutes'], 'the audit job has runs-on, timeout-minutes and steps, nothing else');
  assert.equal(job['runs-on'], RUNNER, `the audit job runs on ${RUNNER}`);
  const [checkout, setup] = stepsOf(job);
  assert.deepEqual(
    job.steps,
    [
      { uses: action(checkout, 'checkout') ? checkout.uses : 'actions/checkout@<sha>' },
      { uses: action(setup, 'setup-node') ? setup.uses : 'actions/setup-node@<sha>', with: { 'node-version-file': '.nvmrc' } },
      { run: `node ${AUDIT_GATE}` },
    ],
    `the audit job is checkout, setup-node from .nvmrc and \`node ${AUDIT_GATE}\`, and nothing else`,
  );
  assert.equal(gates.length, 1, 'the gate runs in the audit job and nowhere else, so check means what it always meant');
});

// The gate is shared code: its bytes are pinned, the list it reads is the only part a repository
// writes, and nothing else lives beside them.
test('the audit gate: the shared script, and an accepted list it reads, exactly where there is a lockfile', async () => {
  const files = repositoryFiles(root).filter((f) => f.startsWith('.github/audit/'));
  if (!lockfile) {
    assert.deepEqual(files.filter((f) => f === AUDIT_GATE || f === AUDIT_ACCEPTED), [], 'no audit gate and no accepted list without a lockfile: there is no audit job');
    return;
  }
  assert.ok(files.includes(AUDIT_GATE), `${AUDIT_GATE} exists`);
  assert.deepEqual(files.filter((f) => f !== AUDIT_GATE && f !== AUDIT_ACCEPTED), [], '.github/audit/ holds the gate and its accepted list, nothing else');
  assert.equal(sha(readFileSync(join(root, AUDIT_GATE))), AUDIT_GATE_SHA, `${AUDIT_GATE} differs from the shared copy`);
  const gate = await import(pathToFileURL(join(root, AUDIT_GATE)).href);
  if (has(AUDIT_ACCEPTED)) gate.readAccepted(read(AUDIT_ACCEPTED));
});

// Each rule the gate states, run over made-up reports and lockfiles, so that a change to the shared
// script that drops one fails here, offline, in every repository that runs it; then run() with a
// stand-in npm, for every way a run ends; then the file itself, as the audit job runs it, against a
// stand-in npm on PATH and the real clock, for its exit status.
test('the audit gate holds each of its rules', { skip: !lockfile && 'no lockfile, so no audit gate' }, async () => {
  const gate = await import(pathToFileURL(join(root, AUDIT_GATE)).href);
  const ID = 'GHSA-2345-6789-cfgh';
  const report = (severity = 'high', nodes = ['node_modules/bad'], range = '<=2.0.0') => ({
    auditReportVersion: 2,
    vulnerabilities: {
      bad: { name: 'bad', severity, isDirect: false, via: [{ source: 1, name: 'bad', dependency: 'bad', title: 'a flaw', url: `https://github.com/advisories/${ID}`, severity, range }], effects: ['mid'], nodes },
      mid: { name: 'mid', severity, isDirect: false, via: ['bad'], effects: ['app'], nodes: ['node_modules/mid'] },
      app: { name: 'app', severity, isDirect: true, via: ['mid'], effects: [], nodes: ['node_modules/app'] },
    },
    metadata: {},
  });
  const lock = {
    packages: {
      '': { dependencies: { app: '1.0.0', other: '1.0.0', 'old-bad': 'npm:bad@2.0.0' }, devDependencies: { tool: '1.0.0' }, workspaces: ['web'] },
      web: { dependencies: { wapp: '1.0.0' } },
      'node_modules/web': { resolved: 'web', link: true },
      'web/node_modules/wapp': { version: '1.0.0', dependencies: { bad: '^2.0.0' } },
      'node_modules/app': { version: '1.0.0', dependencies: { mid: '^1.0.0', web: '*' } },
      'node_modules/mid': { version: '1.0.0', dependencies: { bad: '^2.0.0' } },
      'node_modules/bad': { version: '2.0.0' },
      'node_modules/old-bad': { name: 'bad', version: '2.0.0' },
      'node_modules/other': { version: '1.0.0', dependencies: { bad: '^1.0.0' } },
      'node_modules/other/node_modules/bad': { version: '1.0.0' },
      'node_modules/tool': { version: '1.0.0', dev: true, dependencies: { bad: '^2.0.0' } },
    },
  };
  const entry = (more = {}) => ({ advisory: ID, package: 'bad', severity: 'high', paths: ['app > mid > bad', 'wapp > bad'], reason: 'no release fixes it, and it runs at build time only', expires: '2026-12-01', ...more });
  const today = '2026-10-14';
  const run = (over = {}) => gate.check({ report: report(), accepted: [entry()], today, lock, published: { bad: ['1.0.0', '2.0.0'] }, ...over });
  const fails = (over, pattern, what) => {
    const { problems } = run(over);
    assert.ok(problems.some((p) => pattern.test(p)), `the gate fails ${what}: ${JSON.stringify(problems)}`);
  };
  const passes = (over, what) => assert.deepEqual(run(over).problems, [], what);

  const ok = run();
  assert.deepEqual(ok.problems, [], 'an accepted advisory with no fix, a route from every direct dependency that reaches it and a near expiry passes');
  assert.equal(ok.notes.length, 1, 'and is named in the log');
  fails({ accepted: [] }, /not accepted.*It arrives by wapp > bad$/, 'on a high advisory nothing accepts, naming its shortest route');
  fails({ report: report('critical'), accepted: [] }, /not accepted/, 'on a critical one');
  fails({ report: report('severe'), accepted: [] }, /not accepted/, 'on a severity it does not know');
  passes({ report: report('moderate'), accepted: [] }, 'a moderate advisory passes, as --audit-level=high let it');
  fails({ accepted: [entry({ expires: today })] }, /expired on/, 'on the day its acceptance expires');
  fails({ accepted: [entry({ expires: '2026-10-01' })] }, /expired on/, 'after it');
  fails({ accepted: [entry({ expires: '2027-01-13' })] }, /more than 90 days/, 'on an acceptance more than 90 days out');
  passes({ accepted: [entry({ expires: '2027-01-12' })] }, 'and passes one 90 days out');
  // The severity it was accepted at: a re-scoring upwards, or one the gate does not know, is news.
  fails({ report: report('critical') }, /npm now rates it critical, above the high it was accepted at/, 'once npm rates it above the severity accepted');
  fails({ report: report('severe') }, /npm now rates it severe/, 'on a severity it does not know, accepted or not');
  passes({ report: report('critical'), accepted: [entry({ severity: 'critical' })] }, 'a critical accepted as critical holds');
  passes({ accepted: [entry({ severity: 'critical' })] }, 'and so does one rated lower since');
  // A fix is a release outside the range that a dependent of an installed copy can take: newer,
  // in that copy's major. One on a newer major only is named in the log and holds the entry.
  fails({ published: { bad: ['1.0.0', '2.0.0', '2.0.1'] } }, /2\.0\.1 lies outside the advisory's range: take the fix/, 'once a release outside the range exists in the major installed');
  const later = run({ published: { bad: ['1.0.0', '2.0.0', '3.0.0'] } });
  assert.deepEqual(later.problems, [], 'but not on a release on a newer major only');
  assert.ok(later.notes.some((n) => /bad 3\.0\.0 lies outside the range, on a major/.test(n)), `which the log names: ${JSON.stringify(later.notes)}`);
  const pre = run({ published: { bad: ['1.0.0', '2.0.0', '2.0.1-rc.1', '3.0.0-rc.1'] } });
  assert.deepEqual(pre.problems, [], 'nor on a prerelease');
  assert.equal(pre.notes.length, 1, 'which the log does not name either');
  assert.deepEqual(
    [[[1, 9, 0, []], [1, 0, 0, []]], [[2, 0, 0, []], [1, 9, 9, []]], [[0, 2, 9, []], [0, 2, 3, []]], [[0, 3, 0, []], [0, 2, 3, []]], [[0, 0, 4, []], [0, 0, 3, []]]].map(([v, c]) => gate.sameMajor(v, c)),
    [true, false, true, false, false],
    "a major is read as a caret range reads it: the minor below 1.0.0, the patch below 0.1.0",
  );
  fails({ published: {} }, /could not be read/, 'when the releases cannot be read');
  fails({ published: { bad: [{ version: '9.0.0' }] } }, /could not be read/, 'when they are not a list of versions');
  fails({ report: report('high', ['node_modules/bad'], '~2.0.0') }, /does not read/, 'on a range it cannot read');
  // The routes: real chains of production dependencies, ending at a reported copy, from every
  // direct dependency that reaches one.
  fails({ accepted: [entry({ paths: ['tool > bad', 'app > mid > bad', 'wapp > bad'] })] }, /"tool > bad" is not a chain of production dependencies/, 'on a route through a development dependency');
  fails({ accepted: [entry({ paths: ['mid > bad', 'app > mid > bad', 'wapp > bad'] })] }, /"mid > bad" is not a chain of production dependencies/, 'on a route that does not start at a direct dependency');
  fails({ accepted: [entry({ paths: ['other > bad', 'app > mid > bad', 'wapp > bad'] })] }, /"other > bad" is not a chain of production dependencies/, 'on a route to a copy npm does not report');
  fails({ accepted: [entry({ paths: ['app > mid', 'wapp > bad'] })] }, /"app > mid" is not a chain of production dependencies/, 'on a route that ends at another package');
  fails({ accepted: [entry({ paths: ['app > mid > bad'] })] }, /wapp also reaches it, by wapp > bad, and no route the entry names starts there/, 'on a direct dependency that reaches a copy by a route the entry does not name');
  passes({ accepted: [entry({ paths: ['app > web > wapp > bad', 'wapp > bad'] })] }, 'a route through a workspace link holds');
  const two = report('high', ['node_modules/bad', 'node_modules/other/node_modules/bad']);
  fails({ report: two, accepted: [entry({ paths: ['app > mid > bad', 'wapp > bad'] })] }, /no route the entry names reaches the copy at node_modules\/other\/node_modules\/bad \(it arrives by other > bad\)/, 'on a copy no route reaches');
  passes({ report: two, accepted: [entry({ paths: ['app > mid > bad', 'wapp > bad', 'other > bad'] })] }, 'and passes once a route reaches each copy');
  // A copy installed under an alias is reached by the name its dependent declares.
  passes({ report: report('high', ['node_modules/old-bad']), accepted: [entry({ paths: ['old-bad'] })] }, 'a copy installed under an alias is accepted along the alias');
  fails({ report: { auditReportVersion: 2, vulnerabilities: {}, metadata: {} } }, /does not report at high or above: remove the entry/, 'on an acceptance of something npm no longer reports');
  assert.throws(() => run({ report: { error: { code: 'ENOAUDIT' } } }), /auditReportVersion 2/, 'and on a report it cannot read');
  assert.throws(() => run({ report: { ...report(), auditReportVersion: 1 } }), /auditReportVersion 2/, 'and on a report of another version');
  assert.throws(() => run({ lock: {} }), /packages map/, 'and on a lockfile it cannot read');

  const list = (entries) => JSON.stringify(entries);
  assert.equal(gate.readAccepted(list([entry()])).length, 1, 'the list reads');
  assert.equal(gate.readAccepted(list([entry({ paths: ['old-bad'] })])).length, 1, 'and takes a route that ends at an alias');
  for (const [bad, what] of [
    [{ notes: 'x' }, 'a key of its own'],
    [{ advisory: 'CVE-2026-0001' }, 'an id that is not a GitHub advisory'],
    [{ severity: 'moderate' }, 'a severity that does not fail the job'],
    [{ severity: 'Critical' }, 'a severity npm does not write'],
    [{ paths: [] }, 'no route'],
    [{ paths: ['app>mid>bad'] }, 'a route spelled another way'],
    [{ paths: ['app > bad > bad'] }, 'a route that names a package twice'],
    [{ reason: ' ' }, 'no reason'],
    [{ expires: '2026-02-30' }, 'a date that does not exist'],
  ]) {
    assert.throws(() => gate.readAccepted(list([entry(bad)])), /accepted\.json, entry 1/, `the list refuses ${what}`);
  }
  const { severity, ...unrated } = entry();
  assert.equal(severity, 'high');
  assert.throws(() => gate.readAccepted(list([unrated])), /exactly advisory, package, severity, paths, reason, expires/, 'the list refuses an entry with no severity');
  assert.throws(() => gate.readAccepted(list([entry(), entry()])), /accepted once/, 'the list refuses an advisory accepted twice');
  assert.throws(() => gate.readAccepted('{"__proto__": []}'), /a list of entries/, 'the list is a list');

  // run(): every way a run ends, with a stand-in npm and clock.
  const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  try {
    const answers = { audit: { status: 1, stdout: JSON.stringify(report()), stderr: '' }, view: { status: 0, stdout: JSON.stringify(['1.0.0', '2.0.0']), stderr: '' } };
    const npm = (args) => (args[0] === 'audit' && args.join(' ') === 'audit --omit=dev --json' ? answers.audit : args.join(' ') === 'view bad versions --json' ? answers.view : { status: 1, stdout: '', stderr: `unexpected npm ${args.join(' ')}` });
    const lines = [];
    const once = (day = today) => {
      lines.length = 0;
      return gate.run({ root: dir, npm, today: day, log: (l) => lines.push(l), error: (l) => lines.push(l) });
    };
    const ends = (code, pattern, what) => {
      assert.equal(once(), code, `run() exits ${code} ${what}: ${lines.join(' | ')}`);
      assert.ok(lines.some((l) => pattern.test(l)), `run() says why ${what}: ${lines.join(' | ')}`);
    };
    ends(1, /no package-lock\.json here/, 'with no lockfile');
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    ends(1, /not accepted/, 'on an advisory nothing accepts');
    mkdirSync(join(dir, '.github/audit'), { recursive: true });
    writeFileSync(join(dir, AUDIT_ACCEPTED), 'not json');
    ends(1, /is not JSON/, 'on a list it cannot read');
    writeFileSync(join(dir, AUDIT_ACCEPTED), list([entry()]));
    ends(0, /nothing at high or above that is not accepted/, 'when every acceptance holds');
    assert.equal(once('2026-12-01'), 1, 'and goes red on the day the entry expires, by the clock it is given');
    answers.view = { status: 1, stdout: '', stderr: 'network' };
    ends(1, /releases of bad could not be read/, 'when the releases cannot be read');
    answers.view = { status: 0, stdout: JSON.stringify(['1.0.0', '2.0.0']), stderr: '' };
    answers.audit = { status: 1, stdout: 'npm error', stderr: 'boom' };
    ends(1, /did not answer with JSON/, 'when npm audit answers with something else');
    answers.audit = { status: 1, stdout: JSON.stringify({ error: { code: 'ENOLOCK' } }), stderr: '' };
    ends(1, /npm audit failed/, 'when npm audit reports an error');

    // The file itself, as the audit job runs it: a stand-in npm first on PATH, the real clock.
    answers.audit = { status: 1, stdout: JSON.stringify(report()), stderr: '' };
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
    writeFileSync(
      join(bin, 'npm'),
      `#!/usr/bin/env node\nconst a = require(${JSON.stringify(join(dir, 'answers.json'))});\nconst args = process.argv.slice(2).join(' ');\nconst out = args === 'audit --omit=dev --json' ? a.audit : args === 'view bad versions --json' ? a.view : { status: 1, stdout: '', stderr: 'unexpected ' + args };\nprocess.stdout.write(out.stdout);\nprocess.stderr.write(out.stderr);\nprocess.exitCode = out.status;\n`,
      { mode: 0o755 },
    );
    const real = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const exits = (expires) => {
      writeFileSync(join(dir, AUDIT_ACCEPTED), list([entry({ expires })]));
      const { execPath, env } = globalThis.process;
      const r = spawnSync(execPath, [join(root, AUDIT_GATE)], { cwd: dir, encoding: 'utf8', env: { ...env, PATH: `${bin}${delimiter}${env.PATH}` } });
      return { status: r.status, output: `${r.stdout}${r.stderr}` };
    };
    const held = exits(real(1));
    assert.equal(held.status, 0, `the gate exits 0 when every acceptance holds: ${held.output}`);
    const expired = exits(real(0));
    assert.equal(expired.status, 1, `and 1 on the day an acceptance expires, by today's date: ${expired.output}`);
    assert.match(expired.output, /expired on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The deploy's shape carries its security reasoning: the build job runs the install and the
// suite, so it holds a read-only token that is not left behind in .git/config; only the job
// that publishes can publish, and it runs nothing from the repository; and the suite gates
// the upload. Nothing but the two jobs' keys above can hold a permission.
test('pages.yml: the Pages deploy', { skip: !has(PAGES) && 'no pages.yml' }, () => {
  const { tree } = readWorkflow(PAGES);
  assert.deepEqual(tree.on, { push: { branches: ['main'] }, workflow_dispatch: null }, 'pages.yml runs on a push to main and by hand, nothing else');
  assert.deepEqual(tree.permissions, { contents: 'read' }, 'workflow-level permissions are contents: read and nothing else');
  assert.deepEqual(Object.keys(jobsOf(tree)), ['build', 'deploy'], 'two jobs, build and deploy');
  const { build, deploy } = jobsOf(tree);
  assert.ok(!own(build, 'permissions'), 'the build job holds no permission of its own');
  assert.deepEqual(deploy.permissions, { pages: 'write', 'id-token': 'write' }, 'the deploy job holds pages: write and id-token: write, nothing else');
  assert.equal(deploy.needs, 'build', 'deploy needs build');
  const deploySteps = stepsOf(deploy);
  assert.equal(deploySteps.length, 1, 'the deploy job has one step');
  assert.ok(action(deploySteps[0], 'deploy-pages'), 'that step is actions/deploy-pages');
  assert.deepEqual(Object.keys(deploySteps[0]).filter((k) => !['id', 'name', 'uses', 'with'].includes(k)), [], 'the deploy step runs nothing of its own');
  const steps = stepsOf(build);
  const checkouts = steps.filter((s) => action(s, 'checkout'));
  assert.ok(checkouts.length > 0, 'the build job checks out the commit');
  for (const s of checkouts) assert.deepEqual(s.with, { 'persist-credentials': 'false' }, "the build job's checkout does not leave its token in .git/config");
  const install = bareRun(steps, 'npm ci');
  assert.equal(install !== -1, lockfile, 'the build job runs npm ci exactly when there is a lockfile');
  const suite = Math.max(bareRun(steps, 'npm test'), bareRun(steps, 'npm run test:all'));
  const upload = steps.findIndex((s) => action(s, 'upload-pages-artifact'));
  assert.ok(suite !== -1, 'the build job runs `npm test` (or `npm run test:all`) as a bare step');
  assert.ok(upload !== -1, 'the build job uploads the site');
  assert.ok(install < suite && suite < upload, 'the install, then the suite, then the upload');
});

/** tsconfig.json and its named variants (tsconfig.app.json, tsconfig.node.test.json). */
const TSCONFIG = /(^|\/)tsconfig(\.[^/]+)?\.json$/;
/** A TypeScript source. A declaration file (.d.ts) is not one: under skipLibCheck, which every
 *  project sets (the tsconfig options test), tsc checks nothing in it, so holding it to be a root
 *  file of a checked project held nothing; and a repository with no TypeScript of its own can then
 *  carry the kit whole, declarations and all. */
const TYPESCRIPT_SOURCE = /(?<!\.d)\.(ts|tsx|mts|cts)$/;

/** The dot-directories that hold the repository's own files: GitHub's (the workflows, the audit
 *  gate) and a site's .well-known/. Every other one on disk (.git, .cache, .expo, .next) is a
 *  tool's, and so is node_modules. */
const OWN_DOT_DIRS = new Set(['.github', '.well-known']);

/** The repository's files as sorted paths relative to `dir`: the ones git tracks where a
 *  work tree is rooted at `dir`; otherwise every file on disk outside node_modules and the
 *  dot-directories but OWN_DOT_DIRS. A `git archive` extract or a downloaded ZIP has no work
 *  tree at all, and a copy unpacked inside some other work tree would get that tree's answer,
 *  which lists nothing here and would pass every test below without reading a thing. */
function repositoryFiles(dir) {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (realpathSync(git('rev-parse', '--show-toplevel').trim()) === realpathSync(dir)) {
      return git('ls-files', '-z').split('\0').filter(Boolean).sort();
    }
  } catch {
    // Not a work tree, or no git: read the disk.
  }
  const files = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (entry.isDirectory() && entry.name.startsWith('.') && !OWN_DOT_DIRS.has(entry.name))) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk('');
  return files.sort();
}

/** The directories of the workspaces the package.json in `dir` declares, among `files`. */
function workspaces(dir, files) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  const matchers = patterns.map((p) => {
    assert.match(p, /^[\w.-]+(\/([\w.-]+|\*))*$/, `a workspaces pattern this test reads (a path whose segments may be *): ${p}`);
    return new RegExp(`^${p.split('/').map((s) => (s === '*' ? '[^/]+' : s.replaceAll('.', '\\.'))).join('/')}$`);
  });
  const dirs = files.filter((f) => f.endsWith('/package.json')).map((f) => f.slice(0, -'/package.json'.length));
  return dirs.filter((d) => matchers.some((m) => m.test(d))).sort();
}

/** The typescript package the repository at `dir` installed; a copy nothing was installed
 *  into fails saying what to do, not only that a module is missing. */
function typescriptIn(dir) {
  try {
    return createRequire(join(dir, 'package.json'))('typescript');
  } catch (error) {
    const what = existsSync(join(dir, 'package-lock.json'))
      ? 'run `npm ci` first'
      : 'this repository has no lockfile, so nothing installs it: add typescript as a devDependency, with a lockfile, a tsconfig and a typecheck script';
    throw new Error(`TypeScript is not installed here: ${what} (${error.message.split('\n')[0]})`);
  }
}

const posix = (dir, file) => relative(dir, file).split(sep).join('/');

/** One config parsed the way tsc parses it (extends, comments and all): its options, its
 *  root files, the configs it references, and its errors. A config with no inputs yet still
 *  has options (TS18003 is not a broken config). */
function parseConfig(ts, dir, file) {
  const unrecoverable = [];
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => unrecoverable.push(d) };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, undefined, host);
  const errors = [...unrecoverable, ...(parsed?.errors ?? [])]
    .filter((d) => d.code !== 18003)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  const references = (parsed?.projectReferences ?? []).map((r) => ts.resolveProjectReferencePath(r));
  const raw = parsed?.raw ?? {};
  return {
    name: posix(dir, file),
    file,
    options: parsed?.options ?? {},
    fileNames: (parsed?.fileNames ?? []).map((f) => posix(dir, f)),
    references,
    errors,
    // A solution-style config (`files: []` plus `references`) compiles nothing itself.
    solution: references.length > 0 && (parsed?.fileNames ?? []).length === 0,
    extendsExpo: [raw.extends].flat().some((e) => /^expo\/tsconfig\.base(\.json)?$/.test(e ?? '')),
  };
}

/** The configs a script called `name` names, in every package.json among `files`: each
 *  `-p`/`--project` it gives tsc, or the package's tsconfig.json when it names none. Read
 *  loosely, so that a config is held to the conventions whatever else the script does. */
function scriptProjects(dir, files, name) {
  return files
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .flatMap((manifest) => {
      const script = JSON.parse(readFileSync(join(dir, manifest), 'utf8')).scripts?.[name] ?? '';
      if (!/\btsc\b/.test(script)) return [];
      const named = [...script.matchAll(/(?:^|\s)(?:-p|--project)[\s=]+(\S+)/g)].map((m) => m[1]);
      return (named.length > 0 ? named : ['tsconfig.json']).map((project) => {
        const path = join(dir, dirname(manifest), project);
        return path.endsWith('.json') ? path : join(path, 'tsconfig.json');
      });
    });
}

/** Every TypeScript project in the repository at `dir`: each config among `files`, each
 *  config a typecheck script names, and each config those reference, parsed. [] when there
 *  is no config, before typescript is needed. */
function typescriptProjects(dir, files) {
  const queue = [...files.filter((f) => TSCONFIG.test(f)).map((f) => join(dir, f)), ...scriptProjects(dir, files, 'typecheck')];
  if (queue.length === 0) return [];
  const ts = typescriptIn(dir);
  const seen = new Set();
  const projects = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const project = parseConfig(ts, dir, file);
    projects.push(project);
    queue.push(...project.references);
  }
  return projects;
}

/** The configs `npm run typecheck` runs tsc over, followed from the root package's script
 *  into the workspaces it names. Each command in a typecheck script, joined by `&&`, is one
 *  this reads: `tsc --noEmit` with at most one `-p` or `--project` and nothing else, since an
 *  option on the command line overrides the config the tests here read; `next typegen`; or,
 *  at a workspace root, `npm run typecheck` over `--workspaces` or named `--workspace`s. Any
 *  other command, `||` or `;` could let the script pass having checked nothing. Plain tsc
 *  does not build a solution-style config's references, so none are followed. */
function typecheckProjects(dir, files) {
  const out = [];
  const visit = (pkgDir) => {
    const where = pkgDir ? `${pkgDir}/package.json` : 'package.json';
    const script = JSON.parse(readFileSync(join(dir, pkgDir, 'package.json'), 'utf8')).scripts?.typecheck;
    if (script === undefined) return false;
    for (const segment of script.split('&&').map((s) => s.trim())) {
      assert.doesNotMatch(segment, /[|;&<>`$(){}\\'"\n]|^$/, `${where}: typecheck joins its commands with && alone: \`${script}\``);
      const words = segment.split(/\s+/);
      if (words[0] === 'tsc') {
        let project;
        let noEmit = false;
        for (let i = 1; i < words.length; i += 1) {
          if (words[i] === '--noEmit') noEmit = true;
          else if ((words[i] === '-p' || words[i] === '--project') && project === undefined && i + 1 < words.length) project = words[(i += 1)];
          else assert.fail(`${where}: typecheck gives tsc --noEmit and at most one -p, nothing else (an option on the command line overrides the config): \`${segment}\``);
        }
        assert.ok(noEmit, `${where}: typecheck runs tsc --noEmit: \`${segment}\``);
        const path = join(dir, pkgDir, project ?? '.');
        out.push(path.endsWith('.json') ? path : join(path, 'tsconfig.json'));
      } else if (segment === 'next typegen') {
        // Writes the route types tsc then checks.
      } else if (!pkgDir && words.slice(0, 3).join(' ') === 'npm run typecheck') {
        const declared = workspaces(dir, files);
        const named = [];
        let all = false;
        let ifPresent = false;
        for (let i = 3; i < words.length; i += 1) {
          if (words[i] === '--workspaces') all = true;
          else if (words[i] === '--if-present') ifPresent = true;
          else if ((words[i] === '--workspace' || words[i] === '-w') && i + 1 < words.length) named.push(words[(i += 1)]);
          else if (words[i].startsWith('--workspace=')) named.push(words[i].slice('--workspace='.length));
          else assert.fail(`${where}: typecheck runs npm run typecheck over --workspaces or named --workspace directories, nothing else: \`${segment}\``);
        }
        const targets = all ? declared : named.map((w) => w.replace(/^\.\//, '').replace(/\/$/, ''));
        assert.ok(targets.length > 0, `${where}: npm run typecheck names its workspaces`);
        for (const w of targets) {
          assert.ok(declared.includes(w), `${where}: ${w} is a workspace directory the root declares`);
          assert.ok(visit(w) || ifPresent, `${w}/package.json has a typecheck script`);
        }
      } else {
        assert.fail(`${where}: typecheck runs tsc, next typegen or, at a workspace root, the workspaces' typecheck, not \`${segment}\``);
      }
    }
    return true;
  };
  visit('');
  return out;
}

let projectsHere;
const projects = () => (projectsHere ??= typescriptProjects(root, repositoryFiles(root)));

// The helpers above on copies that are not a checkout: a directory no work tree is rooted
// in, once on its own and once inside another work tree, with nothing installed; and a
// checkout, where git's list and not the disk's is the answer. Without git there is no other
// work tree to sit in, so only the first copy exists.
test('the repository is read from git where it is a checkout, and off the disk where it is not', () => {
  const outer = mkdtempSync(join(tmpdir(), 'conventions-'));
  try {
    const copies = [join(outer, 'archive')];
    let git = true;
    try {
      execFileSync('git', ['init', '-q', join(outer, 'repo')], { stdio: 'ignore' });
      copies.push(join(outer, 'repo', 'unpacked'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      git = false;
    }
    const planted = ['package.json', '.npmrc', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.test.json', 'web/tsconfig.build.json', 'app/tsconfig.json', 'app/main.ts', 'node_modules/pkg/tsconfig.json', '.git/tsconfig.json', '.cache/tsconfig.json', 'tsconfig.json.bak', 'mytsconfig.json', '.github/audit/npm-audit.mjs', 'public/.well-known/security.txt', '.git/config', '.cache/security.txt', 'node_modules/pkg/.well-known/security.txt'];
    for (const copy of copies) {
      for (const f of planted) {
        mkdirSync(dirname(join(copy, f)), { recursive: true });
        writeFileSync(join(copy, f), '{}\n');
      }
    }
    for (const copy of copies) {
      const files = repositoryFiles(copy);
      assert.deepEqual(files.filter((f) => TSCONFIG.test(f)), ['app/tsconfig.json', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.test.json', 'web/tsconfig.build.json'], copy);
      assert.ok(files.includes('app/main.ts') && files.includes('.npmrc'), copy);
      // The dot-directories the tests read (the audit gate, security.txt) are listed; a tool's are not.
      assert.ok(files.includes('.github/audit/npm-audit.mjs') && files.includes('public/.well-known/security.txt'), copy);
      assert.deepEqual(files.filter((f) => /(^|\/)(\.git|\.cache|node_modules)\//.test(f)), [], copy);
      assert.throws(() => typescriptProjects(copy, files), /^Error: TypeScript is not installed here: this repository has no lockfile/);
    }
    writeFileSync(join(copies[0], 'package-lock.json'), '{}\n');
    assert.throws(() => typescriptProjects(copies[0], repositoryFiles(copies[0])), /^Error: TypeScript is not installed here: run `npm ci` first/);
    // No TypeScript config: nothing to read, and no TypeScript needed to read it.
    const plain = join(outer, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'index.js'), '\n');
    assert.deepEqual(typescriptProjects(plain, repositoryFiles(plain)), []);
    if (git) {
      const checkout = join(outer, 'checkout');
      execFileSync('git', ['init', '-q', checkout], { stdio: 'ignore' });
      for (const f of ['tsconfig.json', 'tsconfig.app.json']) writeFileSync(join(checkout, f), '{}\n');
      execFileSync('git', ['add', 'tsconfig.json'], { cwd: checkout, stdio: 'ignore' });
      assert.deepEqual(repositoryFiles(checkout), ['tsconfig.json'], 'a checkout lists what git tracks');
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

// Every TypeScript config the repository holds or a typecheck script names, resolved the way
// tsc resolves it, so a flag set in a base file counts and one set nowhere does not.
test('noUncheckedIndexedAccess in every TypeScript project', () => {
  for (const p of projects()) {
    assert.deepEqual(p.errors, [], `${p.name} is a config tsc can read (a config it extends that is missing: install the dependencies)`);
    if (p.solution) continue;
    assert.equal(p.options.noUncheckedIndexedAccess, true, `${p.name} sets noUncheckedIndexedAccess`);
  }
});

// CONVENTIONS.md's tsconfig sentence: an Expo config extends expo/tsconfig.base with
// `strict`; a hand-written one states `strict`, `target: ES2022`, `skipLibCheck`,
// `esModuleInterop` and `noEmit`, except that the config a `build` script compiles with
// has to emit (a server that builds dist), and so leaves `noEmit` off.
test('the tsconfig options', () => {
  const all = projects();
  if (all.length === 0) return;
  const ts = typescriptIn(root);
  const emitting = new Set(scriptProjects(root, repositoryFiles(root), 'build'));
  for (const p of all.filter((p) => !p.solution)) {
    const o = p.options;
    assert.equal(o.strict, true, `${p.name} sets strict`);
    // An Expo config has it from expo/tsconfig.base. TYPESCRIPT_SOURCE leaves declaration files
    // out because of it, so it holds in every project.
    assert.equal(o.skipLibCheck, true, `${p.name} sets skipLibCheck`);
    if (p.extendsExpo) continue;
    assert.equal(o.target, ts.ScriptTarget.ES2022, `${p.name} targets ES2022`);
    assert.equal(o.esModuleInterop, true, `${p.name} sets esModuleInterop`);
    if (emitting.has(p.file)) assert.notEqual(o.noEmit, true, `${p.name} is what a build script compiles with, so it emits`);
    else assert.equal(o.noEmit, true, `${p.name} sets noEmit`);
  }
});

// A flag reaches only the files its project includes. Every TypeScript source the repository
// holds is a root file of a project that `npm run typecheck` runs tsc over: a test file the
// build config leaves out, run by tsx with its types stripped, is otherwise type-checked by
// nothing, whatever the tsconfig beside it says; and so is a project only a solution-style
// config references, since plain tsc does not build references.
test('every TypeScript source is type-checked by npm run typecheck', () => {
  const files = repositoryFiles(root);
  const sources = files.filter((f) => TYPESCRIPT_SOURCE.test(f));
  if (sources.length === 0 && !files.some((f) => TSCONFIG.test(f))) return;
  const ts = typescriptIn(root);
  const checked = new Set(typecheckProjects(root, files).flatMap((file) => parseConfig(ts, root, file).fileNames));
  assert.deepEqual(sources.filter((f) => !checked.has(f)), [], 'TypeScript sources that npm run typecheck does not reach');
});

test('the documents', () => {
  for (const f of ['README.md', 'LICENSE', 'SECURITY.md', 'REVIEW.md', 'CLAUDE.md', 'AGENTS.md', 'CONVENTIONS.md', '.gitignore', '.github/dependabot.yml']) {
    assert.ok(has(f), `${f} exists`);
  }
  assert.equal(read('LICENSE').split('\n')[0].trim(), 'MIT License');
  assert.equal(pkg.license, 'MIT');
  const claude = read('CLAUDE.md').split('\n');
  assert.ok(claude[0] === '@AGENTS.md' || claude.slice(0, 5).some((line) => line.startsWith('Read AGENTS.md first.')), 'CLAUDE.md starts with @AGENTS.md, or says "Read AGENTS.md first." in its first lines');
  assert.match(read('CLAUDE.md'), /^## Conventions$/m, 'CLAUDE.md has a Conventions section');
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem: (npm|pip)/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(dependabot, /^\s+groups:/m);
});

/** The repository's tracked files whose name is `name`, wherever they are. */
const named = (name) => repositoryFiles(root).filter((f) => f === name || f.endsWith(`/${name}`));

/** The fields of a security.txt (RFC 9116), as [lower-case name, value] in order. */
function securityFields(text, file) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const m = /^([A-Za-z][\w-]*):[ \t]*(\S.*?)\s*$/.exec(line);
      assert.ok(m, `${file}: a field is "Name: value": ${JSON.stringify(line)}`);
      return [m[1].toLowerCase(), m[2]];
    });
}

// CONVENTIONS.md, "Website": every site says where to report a security problem, in the place a
// reporter looks, and stops saying it once its Expires has passed, so a stale one turns this red.
// Which repository it names is read from the file (no file states the repository's name: three
// package names differ from it), so each repository's own website test pins its own addresses.
test('the website: security.txt', () => {
  const files = named('security.txt');
  assert.ok(files.length > 0, 'the site publishes a security.txt, served at /.well-known/security.txt');
  for (const file of files) {
    assert.ok(file === '.well-known/security.txt' || file.endsWith('/.well-known/security.txt'), `${file}: a security.txt sits in a .well-known/ folder, where the site serves it`);
    const fields = securityFields(read(file), file);
    const values = (name) => fields.filter(([k]) => k === name).map(([, v]) => v);
    const contacts = values('contact');
    const policy = values('policy');
    const expires = values('expires');
    assert.ok(contacts.length > 0, `${file}: at least one Contact`);
    assert.equal(expires.length, 1, `${file}: one Expires`);
    assert.equal(policy.length, 1, `${file}: one Policy`);
    const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\//.exec(policy[0])?.[1];
    assert.ok(repo, `${file}: the Policy is the repository's SECURITY.md on GitHub`);
    assert.equal(policy[0], `https://github.com/${repo}/blob/main/SECURITY.md`, `${file}: the Policy is SECURITY.md on main, the branch the site is published from (blob/HEAD follows the default branch, which may not carry it)`);
    // The issues page in every file, last, since it is the way in while private vulnerability
    // reporting is switched off (a repository setting); before it, the private form where the
    // repository lists one.
    const form = `https://github.com/${repo}/security/advisories/new`;
    const issues = `https://github.com/${repo}/issues`;
    assert.ok(contacts.every((c) => c === form || c === issues) && new Set(contacts).size === contacts.length, `${file}: each Contact is the private advisory form or the issues page of the repository the Policy names, once: ${contacts.join(', ')}`);
    assert.equal(contacts.at(-1), issues, `${file}: the issues page is a Contact, after the form where there is one`);
    assert.match(expires[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, `${file}: Expires is an RFC 3339 time`);
    const left = (Date.parse(expires[0]) - Date.now()) / 86_400_000;
    assert.ok(left > 0, `${file}: Expires (${expires[0]}) has passed: renew it, a year ahead at most`);
    assert.ok(left <= 366, `${file}: Expires (${expires[0]}) is more than a year away`);
  }
});

/** nginx.conf as nginx reads it: directives `name args;` and blocks `name args { ... }`, comments
 *  and quotes understood. Anything else throws, as the workflow reader does: a spelling this does
 *  not read is one it cannot check. */
function readNginx(text, file) {
  const tokens = [];
  const pattern = /\s+|#[^\n]*|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([{};])|([^\s{};"'#][^\s{};]*)/y;
  while (pattern.lastIndex < text.length) {
    const at = pattern.lastIndex;
    const m = pattern.exec(text);
    if (!m) throw new Error(`${file}: offset ${at}: text the conventions test does not read as nginx.conf`);
    if (m[1] !== undefined || m[2] !== undefined || m[4] !== undefined) tokens.push({ word: m[1] ?? m[2] ?? m[4] });
    else if (m[3] !== undefined) tokens.push({ punct: m[3] });
  }
  let i = 0;
  const block = (top) => {
    const out = [];
    for (;;) {
      if (i >= tokens.length) {
        if (top) return out;
        throw new Error(`${file}: a block that does not close`);
      }
      if (tokens[i].punct === '}') {
        if (top) throw new Error(`${file}: a } that closes nothing`);
        i += 1;
        return out;
      }
      if (tokens[i].punct !== undefined) throw new Error(`${file}: a ${tokens[i].punct} where a directive belongs`);
      const name = tokens[i].word;
      const args = [];
      for (i += 1; i < tokens.length && tokens[i].word !== undefined; i += 1) args.push(tokens[i].word);
      const end = tokens[i]?.punct;
      i += 1;
      if (end === ';') out.push({ name, args });
      else if (end === '{') out.push({ name, args, block: block(false) });
      else throw new Error(`${file}: the directive ${name} does not end`);
    }
  };
  return block(true);
}

/** Every directive in a tree, each with the blocks it sits in. */
const directives = (tree, within = []) => tree.flatMap((d) => [{ ...d, within }, ...(d.block ? directives(d.block, [...within, d]) : [])]);
const listens443 = (d) => d.name === 'listen' && d.args.some((a) => /(^|:)443$/.test(a));

/** Sources and documents, which may quote a configuration but are not one a server loads. */
const NOT_CONFIG = /\.(md|[cm]?[jt]sx?|py)$/;

// CONVENTIONS.md, "Website": what every deploy/nginx.conf in the fleet was found to need by
// loading it into a real nginx (1.24, Ubuntu 24.04's and the runner's). Only what the file itself
// says can be read: an nginx configuration is named nginx.conf, and includes nothing.
test('the website: nginx.conf', () => {
  const nginxLike = (f) => {
    let text;
    try {
      text = readFileSync(join(root, f), 'latin1');
    } catch (error) {
      if (error.code === 'EISDIR' || error.code === 'ENOENT') return false;
      throw error;
    }
    return /^\s*server\s*\{/m.test(text) && /^\s*listen\s/m.test(text);
  };
  const configs = repositoryFiles(root).filter((f) => !NOT_CONFIG.test(f) && !f.endsWith('nginx.conf') && nginxLike(f));
  assert.deepEqual(configs, [], 'an nginx configuration is named nginx.conf, so that this test reads it');
  for (const file of named('nginx.conf')) {
    const all = directives(readNginx(read(file), file));
    const servers = all.filter((d) => d.name === 'server' && d.block);
    assert.ok(servers.length > 0, `${file}: has server blocks`);
    assert.deepEqual(all.filter((d) => d.name === 'include').map((d) => d.args.join(' ')), [], `${file}: includes nothing, so that what it sends is what it says (a header an included file adds to a location drops every header of the server block there)`);
    assert.deepEqual(all.filter((d) => d.name === 'http2').map((d) => d.args.join(' ')), [], `${file}: no \`http2 on;\`, which nginx before 1.25.1 refuses with the whole file: HTTP/2 goes on the listen line`);
    for (const d of all.filter(listens443)) assert.ok(d.args.includes('ssl') && d.args.includes('http2'), `${file}: \`listen ${d.args.join(' ')}\` is \`listen … 443 ssl http2\``);
    for (const s of servers) {
      const where = `${file}: the server block for ${s.block.find((d) => d.name === 'listen')?.args.join(' ') ?? '?'}`;
      assert.ok(s.block.some((d) => d.name === 'server_tokens' && d.args.join(' ') === 'off'), `${where} sets server_tokens off, so no answer names the version`);
      if (!s.block.some(listens443)) continue;
      const hsts = s.block.filter((d) => d.name === 'add_header' && d.args[0] === 'Strict-Transport-Security');
      assert.ok(hsts.length === 1 && hsts[0].args.at(-1) === 'always', `${where} sends Strict-Transport-Security once, \`always\`, so error answers carry it too`);
      // A location with an add_header of its own inherits none of the server block's. The one
      // exception is the API's location, which sends the server's HSTS line and leaves every
      // other header to the API.
      const inLocations = all.filter((d) => d.name === 'add_header' && d.within.some((w) => w.block === s.block) && d.within.some((w) => w.name === 'location'));
      for (const h of inLocations) {
        const location = h.within.filter((w) => w.name === 'location');
        assert.ok(location.length === 1 && location[0].args.join(' ') === '^~ /api/' && h.args.join(' ') === hsts[0].args.join(' '), `${where}: add_header ${h.args[0]} in \`location ${location.map((l) => l.args.join(' ')).join(' > ')}\`: headers are set at server level, but in \`location ^~ /api/\`, which repeats the server's HSTS line and nothing else`);
      }
      assert.ok(inLocations.length <= 1, `${where}: \`location ^~ /api/\` has one add_header, the server's HSTS line`);
    }
  }
});

/** Apache's sections that skip what they hold on a condition of the server's configuration (a
 *  module, a directive, a define, a file, a version): on a server without it, silently. */
const CONFIG_CONDITIONAL = /^(IfModule|IfDefine|IfDirective|IfSection|IfFile|IfVersion)$/i;

// CONVENTIONS.md, "Website": what every .htaccess was found to need on a real Apache (2.4.58). The
// file is read as Apache reads it, sections and continued lines included, so a condition cannot
// hide in the section around a line.
test('the website: .htaccess', () => {
  for (const file of named('.htaccess')) {
    const lines = read(file).replace(/\\\n/g, ' ').split('\n').filter((line) => !/^\s*(#|$)/.test(line));
    const open = [];
    const hsts = [];
    for (const line of lines) {
      const close = /^\s*<\/(\w+)\s*>\s*$/.exec(line);
      const section = /^\s*<(\w+)(\s.*)?>\s*$/.exec(line);
      if (close) {
        assert.equal(close[1].toLowerCase(), open.pop()?.toLowerCase(), `${file}: </${close[1]}> closes the section it opens`);
      } else if (section) {
        assert.doesNotMatch(section[1], CONFIG_CONDITIONAL, `${file}: nothing is wrapped in <${section[1]}>: on an Apache without what it asks for, a wrapped rule is skipped without a word, and the site is served without its headers and allow-list; unwrapped, it is a 500 and a log line`);
        open.push(section[1]);
      } else if (/\bStrict-Transport-Security\b/.test(line)) {
        hsts.push({ line, within: [...open] });
      }
    }
    assert.deepEqual(open, [], `${file}: every section it opens, it closes`);
    assert.ok(hsts.length > 0, `${file}: sends Strict-Transport-Security`);
    for (const { line, within } of hsts) {
      assert.match(line, /^\s*Header always set Strict-Transport-Security "[^"]+"\s*$/, `${file}: Strict-Transport-Security is sent unconditionally (env=HTTPS is mod_ssl's alone, so behind a proxy that ends TLS it was never sent): ${line.trim()}`);
      assert.deepEqual(within, [], `${file}: Strict-Transport-Security is sent outside every section (inside <If "%{HTTPS} == 'on'"> it is never sent behind a proxy that ends TLS): ${line.trim()}`);
    }
  }
});

/** One sha256 over a kit's files: of the `sha256sum` line (`<hash>  <path>\n`) of each file, by
 *  path, the way `cd <kit> && find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs sha256sum |
 *  sha256sum` computes it. */
function kitHash(dir, names) {
  return sha([...names].sort().map((name) => `${sha(readFileSync(join(dir, name)))}  ${name}\n`).join(''));
}

// CONVENTIONS.md, "Integrations": a repository that carries the kit carries the canonical copy,
// whole and unedited, in one of the places named, and runs its self-test with its own tests. A
// second copy under another name, edited, is what the hash would never see, so none is allowed.
test('the kit: the canonical copy, byte for byte, its self-test run by npm test', () => {
  const files = repositoryFiles(root);
  const strays = files.filter((f) => /(^|\/)selftest\.mjs$/.test(f) && !KIT_DIRS.some((d) => f === `${d}/selftest.mjs`));
  assert.deepEqual(strays, [], `a copy of the kit lives at ${KIT_DIRS.join(', or ')}, and nothing else is called selftest.mjs`);
  const folders = new Map();
  for (const f of files.filter((f) => KIT_MODULES.includes(f.split('/').at(-1)) && !KIT_DIRS.some((d) => f.startsWith(`${d}/`)))) {
    const folder = dirname(f);
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  assert.deepEqual([...folders].filter(([, n]) => n >= 3).map(([folder]) => folder), [], `no folder outside ${KIT_DIRS.join(', ')} holds the kit's modules`);
  const here = KIT_DIRS.filter((d) => files.some((f) => f.startsWith(`${d}/`)));
  assert.ok(here.length <= 1, `one copy of the kit, not ${here.join(' and ')}`);
  if (here.length === 0) return;
  const [dir] = here;
  const names = files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1));
  assert.equal(kitHash(join(root, dir), names), KIT_SHA, `${dir} differs from the canonical kit: copy it whole, its .d.ts files included, and never edit it here`);
  const owner = workspaces(root, files).filter((w) => dir.startsWith(`${w}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
  const selftest = `${owner ? dir.slice(owner.length + 1) : dir}/selftest.mjs`;
  const ownTest = JSON.parse(readFileSync(join(root, owner, 'package.json'), 'utf8')).scripts?.test ?? '';
  // `node --test` and the files it runs, nothing else: an option (--test-skip-pattern,
  // --test-name-pattern, --test-only) can run none of the self-test's cases and still exit 0.
  const runs = ownTest.split('&&').some((command) => {
    const words = command.trim().split(/\s+/).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
    return words[0] === 'node' && words[1] === '--test' && words.slice(2).every((w) => !w.startsWith('-')) && words.includes(selftest);
  });
  assert.ok(runs, `${owner ? `${owner}/package.json` : 'package.json'}: npm test runs \`node --test ${selftest}\`, with no option beside the files it names`);
  if (owner) {
    const words = (scripts.test ?? '').split('&&').map((c) => c.trim().split(/\s+/));
    const reaches = words.some((w) => w[0] === 'npm' && (w[1] === 'test' || (w[1] === 'run' && w[2] === 'test')) && (w.includes('--workspaces') || w.some((x, i) => (x === '--workspace' || x === '-w') && w[i + 1] === owner) || w.includes(`--workspace=${owner}`)));
    assert.ok(reaches, `the root's npm test runs ${owner}'s`);
  }
});


test('.gitignore ends with the secrets block', () => {
  const tail = read('.gitignore').trimEnd().split('\n').slice(-3).join('\n');
  assert.equal(tail, '# Secrets: ignore every .env variant, but keep the documented template.\n.env*\n!.env.example');
  assert.match(read('.gitignore'), /^\.claude\/settings\.local\.json$/m);
});

test('.claude session hook where there is a lockfile', { skip: !lockfile }, () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  assert.ok(settings.hooks?.SessionStart, 'SessionStart hook declared');
  assert.ok(has('.claude/hooks/session-start.sh'));
  const hook = read('.claude/hooks/session-start.sh');
  assert.match(hook, /^if \[ "\$\{CLAUDE_CODE_REMOTE:-\}" != "true" \]; then$/m, 'the hook installs in Claude Code on the web only');
  execFileSync('bash', ['-n', join(root, '.claude/hooks/session-start.sh')], { stdio: 'ignore' });
});
