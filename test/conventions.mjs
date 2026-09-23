// The conventions shared by every platteration repository (see CONVENTIONS.md), pinned
// so that a session cannot quietly re-decide them. node:test only, and deliberately named
// so no other runner's glob picks it up. It imports nothing outside Node, but the
// TypeScript test needs the installed tree: typescript from node_modules, and expo for a
// config that extends expo/tsconfig.base. Without them that test fails rather than skips,
// since a skipped check reads as a passed one: run `npm ci` first. It lists the files git
// tracks, and reads them off the disk where no work tree is rooted here (an archive or a
// downloaded ZIP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const has = (p) => existsSync(join(root, p));
const sha = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');

// Update these when the shared file changes — in every repository, in one pass.
const EDITORCONFIG_SHA = '85bccbd23a9070becfe1dc0dbb9ad7305fb2bb98f92f54cb9856d7d6eca4ebfe';
const CONVENTIONS_SHA = '71699d9ea9d3aa3fa81b91906cd439cb74f1355aba79b33e9652f2906b1a3023';

const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts ?? {};
const lockfile = has('package-lock.json');

test('.editorconfig and CONVENTIONS.md are the shared copies', () => {
  assert.equal(sha('.editorconfig'), EDITORCONFIG_SHA, '.editorconfig differs from the shared copy');
  assert.equal(sha('CONVENTIONS.md'), CONVENTIONS_SHA, 'CONVENTIONS.md differs from the shared copy');
});

test('Node is pinned once, in .nvmrc, and engines agrees', () => {
  assert.equal(read('.nvmrc').trim(), '22');
  assert.match(pkg.engines?.node ?? '', /^>=22(\.|$)/, 'engines.node should be ">=22" or tighter');
  assert.equal(pkg.packageManager, undefined, 'no packageManager field');
});

test('the script set', () => {
  for (const s of ['test', 'check', 'test:conventions']) assert.ok(scripts[s], `missing script ${s}`);
  if (has('tsconfig.json')) assert.ok(scripts.typecheck, 'a TypeScript repository has typecheck');
  const eslintConfig = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'].some(has);
  if (eslintConfig) assert.ok(scripts.lint, 'an ESLint config means a lint script');
  assert.equal(Boolean(scripts['test:e2e']), Boolean(scripts['test:all']), 'test:e2e and test:all come together');
  assert.equal(scripts['test:conventions'], 'node --test test/conventions.mjs');
  for (const s of ['lint', 'typecheck', 'test', 'test:conventions']) {
    if (scripts[s]) assert.ok(scripts.check.includes(`npm run ${s}`) || (s === 'test' && scripts.check.includes('npm test')), `check runs ${s}`);
  }
});

test('the CI workflow shape', () => {
  assert.ok(has('.github/workflows/ci.yml'), '.github/workflows/ci.yml exists');
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /^name: CI$/m);
  assert.match(ci, /workflow_dispatch/);
  assert.match(ci, /^concurrency:/m);
  assert.match(ci, /timeout-minutes:/);
  assert.match(ci, /node-version-file: \.nvmrc/);
  assert.match(ci, /^permissions:\n\s+contents: read/m);
  assert.equal(/cache: npm/.test(ci), lockfile, 'cache: npm exactly when there is a lockfile');
  assert.equal(/\bnpm ci\b/.test(ci), lockfile, 'npm ci exactly when there is a lockfile');
  assert.ok(!/uses: [^@\n]+@v\d/.test(ci), 'actions are pinned to a commit SHA, not a tag');
  assert.match(ci, /npm run test:conventions/);
  for (const s of ['lint', 'typecheck']) if (scripts[s]) assert.match(ci, new RegExp(`npm run ${s}\\b`), `CI runs ${s}`);
  assert.equal(/npm audit --omit=dev --audit-level=high/.test(ci), lockfile, 'the audit runs exactly when there is a lockfile');
  if (lockfile) {
    assert.match(ci, /^ {2}audit:$/m, 'the audit is a job of its own');
    // The job line for line, so that it can fail: a line anywhere else in the file cannot
    // stand in for one missing here, and `|| true`, `continue-on-error`, `if:`, an install
    // step or a commented-out audit is a line the job does not have.
    const job = jobLines(ci, 'audit');
    const shape = [
      /^ {4}runs-on: \S+$/,
      /^ {4}timeout-minutes: [1-9]\d*$/,
      /^ {4}steps:$/,
      /^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v\d+$/,
      /^ {6}- uses: actions\/setup-node@[0-9a-f]{40} # v\d+$/,
      /^ {8}with:$/,
      /^ {10}node-version-file: \.nvmrc$/,
      /^ {6}- run: npm audit --omit=dev --audit-level=high$/,
    ];
    const wrong = job.findIndex((line, i) => !shape[i]?.test(line));
    assert.ok(wrong < 0 && job.length === shape.length, `the audit job is runs-on, a timeout, checkout, setup-node from .nvmrc and the audit, and nothing else; ${wrong < 0 ? `it has ${job.length} lines of ${shape.length}` : `line ${wrong + 1} is ${JSON.stringify(job[wrong])}`}`);
    const runs = ci.split('\n').filter((line) => /\bnpm audit\b/.test(line) && !/^\s*#/.test(line));
    assert.equal(runs.length, 1, 'npm audit runs in the audit job and nowhere else, so check means what it always meant');
  }
});

// The lines of one job under `jobs:`, without blank lines and comments: from its `  name:`
// line to the next key at two spaces or less. A comment at any indent does not end it,
// since YAML reads the keys after one as the same job's.
function jobLines(ci, name) {
  const lines = ci.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^ {0,2}\S/.test(line)) break;
    out.push(line);
  }
  return out;
}

// Every tsconfig.json in the repository (`repositoryFiles`), resolved the way tsc resolves
// it (extends, comments and all), so a flag set in a base file counts and one set nowhere
// does not.
test('noUncheckedIndexedAccess in every TypeScript project', () => {
  const configs = repositoryFiles(root).filter((f) => f === 'tsconfig.json' || f.endsWith('/tsconfig.json'));
  if (configs.length === 0) return;
  const tsc = typescriptCompiler(root);
  for (const f of configs) {
    const shown = JSON.parse(execFileSync(process.execPath, [tsc, '--showConfig', '-p', f], { cwd: root, encoding: 'utf8' }));
    assert.equal(shown.compilerOptions?.noUncheckedIndexedAccess, true, `${f} sets noUncheckedIndexedAccess`);
  }
});

// The files git tracks when a work tree is rooted at `dir`. Otherwise every file on disk
// but node_modules and .git: a `git archive` or a downloaded ZIP has no work tree at all,
// and a copy unpacked inside some other work tree would get that tree's answer, which
// lists nothing here and would pass the test above without reading a tsconfig.
function repositoryFiles(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (git('rev-parse', '--show-prefix').trim() === '') return git('ls-files', '-z').split('\0').filter(Boolean);
  } catch {
    // Not a work tree, or no git: read the disk.
  }
  const walk = (prefix) =>
    readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
      const path = prefix + entry.name;
      if (!entry.isDirectory()) return [path];
      return entry.name === 'node_modules' || entry.name === '.git' ? [] : walk(`${path}/`);
    });
  return walk('');
}

// The TypeScript compiler the repository installed; a copy nothing was installed into
// fails saying what to run, not only that a module is missing.
function typescriptCompiler(dir) {
  try {
    return createRequire(join(dir, 'package.json')).resolve('typescript/bin/tsc');
  } catch (error) {
    throw new Error(`TypeScript is not installed here: run \`npm ci\` first (${error.message.split('\n')[0]})`);
  }
}

// The two helpers on a copy that is not a checkout: a directory no work tree is rooted in,
// once on its own and once inside another work tree, with nothing installed. Without git
// there is no other work tree to sit in, so only the first copy exists.
test('the TypeScript test reads a copy that is not a checkout', () => {
  const outer = mkdtempSync(join(tmpdir(), 'conventions-'));
  try {
    const copies = [join(outer, 'archive')];
    try {
      execFileSync('git', ['init', '-q', join(outer, 'repo')], { stdio: 'ignore' });
      copies.push(join(outer, 'repo', 'unpacked'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const copy of copies) {
      for (const f of ['tsconfig.json', 'app/tsconfig.json', 'node_modules/pkg/tsconfig.json', '.git/tsconfig.json']) {
        mkdirSync(dirname(join(copy, f)), { recursive: true });
        writeFileSync(join(copy, f), '{}\n');
      }
    }
    for (const copy of copies) {
      assert.deepEqual(repositoryFiles(copy).sort(), ['app/tsconfig.json', 'tsconfig.json'], copy);
      assert.throws(() => typescriptCompiler(copy), /^Error: TypeScript is not installed here: run `npm ci` first/);
    }
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('the documents', () => {
  for (const f of ['README.md', 'LICENSE', 'SECURITY.md', 'CLAUDE.md', 'CONVENTIONS.md', '.gitignore', '.github/dependabot.yml']) {
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
});
