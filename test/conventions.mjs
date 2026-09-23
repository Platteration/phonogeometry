// The conventions shared by every platteration repository (see CONVENTIONS.md), pinned
// so that a session cannot quietly re-decide them. Zero dependencies, node:test only,
// and deliberately named so no other runner's glob picks it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  if (lockfile) assert.match(ci, /^ {2}audit:$/m, 'the audit is a job of its own');
});

// Every tsconfig.json the repository tracks, resolved the way tsc resolves it (extends,
// comments and all), so a flag set in a base file counts and one set nowhere does not.
test('noUncheckedIndexedAccess in every TypeScript project', () => {
  const configs = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f === 'tsconfig.json' || f.endsWith('/tsconfig.json'));
  if (configs.length === 0) return;
  const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
  for (const f of configs) {
    const shown = JSON.parse(execFileSync(process.execPath, [tsc, '--showConfig', '-p', f], { cwd: root, encoding: 'utf8' }));
    assert.equal(shown.compilerOptions?.noUncheckedIndexedAccess, true, `${f} sets noUncheckedIndexedAccess`);
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
