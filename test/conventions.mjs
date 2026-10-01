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
// any other spelling is refused rather than guessed at (readWorkflow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const has = (p) => existsSync(join(root, p));
const sha = (data) => createHash('sha256').update(data).digest('hex');

// Update these when a shared text changes — in every repository, in one pass.
const EDITORCONFIG_SHA = '85bccbd23a9070becfe1dc0dbb9ad7305fb2bb98f92f54cb9856d7d6eca4ebfe';
const CONVENTIONS_SHA = '6afaa593e5df37dfdfa0b4a53dcc52d8aa59cf9636297ab457551cc7677968fe';
const REVIEW_STATUS_SHA = '5a22e3f5833fa7576edd0ca0b11c8da94e5bcae33a5d13bad6b845c8edb78989';
// CI's weekly run (CONVENTIONS.md, "CI"). Not at the top of the hour, which GitHub's
// documentation names as a high-load time, when a scheduled run can be delayed or dropped.
const SCHEDULE = '17 6 * * 1';

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

test('.editorconfig, CONVENTIONS.md and the shared block of REVIEW.md are the shared copies', () => {
  assert.equal(sha(readFileSync(join(root, '.editorconfig'))), EDITORCONFIG_SHA, '.editorconfig differs from the shared copy');
  assert.equal(sha(readFileSync(join(root, 'CONVENTIONS.md'))), CONVENTIONS_SHA, 'CONVENTIONS.md differs from the shared copy');
  assert.equal(sha(reviewStatus(read('REVIEW.md'))), REVIEW_STATUS_SHA, 'the "Status of the shared items" block of REVIEW.md differs from the shared copy');
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
/** Whether `step` uses actions/<name>, wherever in the step its `uses:` is. */
const action = (step, name) => typeof step?.uses === 'string' && step.uses.startsWith(`actions/${name}@`);
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
const PINNED_LINE = /^\s*(- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/;

// Every workflow, every job and every step, whatever its spelling: a key the reader does not
// know, a job or step key outside these lists, or an environment variable a tool reads, is a
// way for a step to pass red that no check below would see.
test('the workflows: ci.yml and pages.yml, in block YAML, pinned, and nothing that lets a step pass red', () => {
  const files = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.deepEqual(files.filter((f) => !WORKFLOWS.includes(f)), [], 'the workflows are ci.yml and, for a Pages deploy, pages.yml: no other');
  for (const f of files) {
    const file = `.github/workflows/${f}`;
    const { tree, lines, keys } = readWorkflow(file);
    assert.deepEqual(Object.keys(tree).filter((k) => !TOP_KEYS.includes(k)), [], `${file}: no top-level key but ${TOP_KEYS.join(', ')}: an env: or a defaults: there reaches every step`);
    for (const { line } of keys.filter((k) => k.key === 'uses')) {
      assert.match(lines[line], PINNED_LINE, `${file}:${line + 1}: every action is pinned to a commit SHA with its tag in a comment`);
    }
    for (const [name, job] of Object.entries(jobsOf(tree))) {
      const allowed = JOB_KEYS[f](name);
      assert.ok(isMapping(job), `${file}: ${name} is a job`);
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
// commented-out audit is a job this is not.
test('ci.yml: the audit job exactly where there is a lockfile', () => {
  const { tree } = readWorkflow(CI);
  const job = jobsOf(tree).audit;
  const runs = scalars(tree).filter((s) => /\bnpm audit\b/.test(s));
  if (!lockfile) {
    assert.equal(job, undefined, 'no audit job without a lockfile: there is nothing for it to read');
    assert.deepEqual(runs, [], 'no npm audit without a lockfile');
    return;
  }
  assert.ok(isMapping(job), 'the audit is a job of its own');
  assert.deepEqual(Object.keys(job).sort(), ['runs-on', 'steps', 'timeout-minutes'], 'the audit job has runs-on, timeout-minutes and steps, nothing else');
  assert.match(String(job['runs-on']), /^[\w.-]+$/, 'the audit job runs on one runner');
  const [checkout, setup] = stepsOf(job);
  assert.deepEqual(
    job.steps,
    [
      { uses: action(checkout, 'checkout') ? checkout.uses : 'actions/checkout@<sha>' },
      { uses: action(setup, 'setup-node') ? setup.uses : 'actions/setup-node@<sha>', with: { 'node-version-file': '.nvmrc' } },
      { run: 'npm audit --omit=dev --audit-level=high' },
    ],
    'the audit job is checkout, setup-node from .nvmrc and `npm audit --omit=dev --audit-level=high`, and nothing else',
  );
  assert.equal(runs.length, 1, 'npm audit runs in the audit job and nowhere else, so check means what it always meant');
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
const TYPESCRIPT_SOURCE = /\.(ts|tsx|mts|cts)$/;

/** The repository's files as sorted paths relative to `dir`: the ones git tracks where a
 *  work tree is rooted at `dir`; otherwise every file on disk outside node_modules and
 *  dot-directories. A `git archive` extract or a downloaded ZIP has no work tree at all, and
 *  a copy unpacked inside some other work tree would get that tree's answer, which lists
 *  nothing here and would pass every test below without reading a thing. */
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
      if (entry.name === 'node_modules' || (entry.isDirectory() && entry.name.startsWith('.'))) continue;
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
    const planted = ['package.json', '.npmrc', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.test.json', 'web/tsconfig.build.json', 'app/tsconfig.json', 'app/main.ts', 'node_modules/pkg/tsconfig.json', '.git/tsconfig.json', '.cache/tsconfig.json', 'tsconfig.json.bak', 'mytsconfig.json'];
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
    if (p.extendsExpo) continue;
    assert.equal(o.target, ts.ScriptTarget.ES2022, `${p.name} targets ES2022`);
    assert.equal(o.skipLibCheck, true, `${p.name} sets skipLibCheck`);
    assert.equal(o.esModuleInterop, true, `${p.name} sets esModuleInterop`);
    if (emitting.has(p.file)) assert.notEqual(o.noEmit, true, `${p.name} is what a build script compiles with, so it emits`);
    else assert.equal(o.noEmit, true, `${p.name} sets noEmit`);
  }
});

// A flag reaches only the files its project includes. Every TypeScript file the repository
// holds is a root file of a project that `npm run typecheck` runs tsc over: a test file the
// build config leaves out, run by tsx with its types stripped, is otherwise type-checked by
// nothing, whatever the tsconfig beside it says; and so is a project only a solution-style
// config references, since plain tsc does not build references.
test('every TypeScript file is type-checked by npm run typecheck', () => {
  const files = repositoryFiles(root);
  const sources = files.filter((f) => TYPESCRIPT_SOURCE.test(f));
  if (sources.length === 0 && !files.some((f) => TSCONFIG.test(f))) return;
  const ts = typescriptIn(root);
  const checked = new Set(typecheckProjects(root, files).flatMap((file) => parseConfig(ts, root, file).fileNames));
  assert.deepEqual(sources.filter((f) => !checked.has(f)), [], 'TypeScript files that npm run typecheck does not reach');
});

test('the documents', () => {
  for (const f of ['README.md', 'LICENSE', 'SECURITY.md', 'REVIEW.md', 'CLAUDE.md', 'CONVENTIONS.md', '.gitignore', '.github/dependabot.yml']) {
    assert.ok(has(f), `${f} exists`);
  }
  assert.equal(read('LICENSE').split('\n')[0].trim(), 'MIT License');
  assert.equal(pkg.license, 'MIT');
  assert.match(read('CLAUDE.md'), /^## Conventions$/m, 'CLAUDE.md has a Conventions section');
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem: (npm|pip)/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(dependabot, /^\s+groups:/m);
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
