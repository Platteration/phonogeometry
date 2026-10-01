// The workflows are the only place this repository installs anything from the registry, and
// how they install it is a decision rather than a detail: an install script runs arbitrary code
// from a package's whole dependency tree, on a runner holding this repository's token. The
// audit records that finding as fixed "with a regression test"; this is that test. Without it
// the flag is one careless edit away from coming back off, with nothing to notice. It reads
// every workflow, not only ci.yml: the Pages build installs nothing today, but a script run
// there could rewrite the site before the deploy job publishes it.
//
// It reads the commands, not the spelling of one of them. npm installs through aliases and
// any unambiguous abbreviation (`npm i`, `npm add`, `npm isntall`, `npm install-cl`, `npm it`,
// `npm cit`, camelCase `npm installTest`), and through commands that are not called install at
// all (`update`, `rebuild`, `link`, `exec`, `audit fix`), so a list of the ones to refuse is
// never finished. Instead an npm command passes only in a spelling this test knows: `install`
// and `ci`, which it checks, and `test`, `run` and a read-only `audit`, which install nothing.
// Anything else fails, as does any other package manager, until someone teaches it here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.github', 'workflows');
const workflows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));

/**
 * Every shell command a workflow runs, as { job, line }: the value of each `run:` key, a
 * block scalar (`run: |`) line by line, split at `&&`, `||`, `;` and `|`. A YAML comment after
 * a one-line value is dropped, as YAML drops it; a shell comment inside a block is left in,
 * since telling one from a `#` inside quotes takes a shell, and a comment that names an
 * installer failing the test is the safe way to be wrong. The job is the key under `jobs:`
 * the step sits in, because what one job installs is not installed in the next.
 */
function commands(text) {
  const out = [];
  const lines = text.split('\n');
  let inJobs = false;
  let job = null;
  const push = (value) => {
    for (const part of value.split(/&&|\|\||;|\|/)) if (part.trim()) out.push({ job, line: part.trim() });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) { inJobs = /^jobs:/.test(line); job = null; continue; }
    const key = inJobs && line.match(/^ {2}([\w-]+):\s*(#.*)?$/);
    if (key) { job = key[1]; continue; }
    const m = line.match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!m) continue;
    const column = m[1].length + (m[2] ? 2 : 0);
    const value = m[3].trim();
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(value)) {
      while (i + 1 < lines.length && (/^\s*$/.test(lines[i + 1]) || lines[i + 1].search(/\S/) > column)) push(lines[++i]);
    } else {
      const quoted = value.match(/^(['"])(.*)\1(\s+#.*)?$/);
      push(quoted ? quoted[2] : value.replace(/\s+#.*$/, ''));
    }
  }
  return out;
}

const OTHER_TOOLS = new Set(['yarn', 'pnpm', 'pnpx', 'bun', 'bunx', 'corepack']);
const NPX_FLAGS_THAT_DO_NOT_INSTALL = new Set(['--no', '--no-install']);
const EXACT = /^(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+$/;

/**
 * What is wrong with how these workflows install, as { kind, where, message }: `scripts` for
 * an install that lets install scripts run, `pin` for a package not pinned to an exact
 * version, `tool` for anything this test cannot read. `installs` counts the npm installs it
 * checked.
 */
function audit(files) {
  const problems = [];
  let installs = 0;
  for (const { file, text } of files) {
    const installed = new Map();   // job -> names of the packages it installed, in order
    for (const { job, line } of commands(text)) {
      const where = `${file}${job ? ` (${job})` : ''}: ${line}`;
      const words = line.split(/\s+/).map((w) => w.replace(/^[$(`]+/, ''));
      words.forEach((word, at) => {
        const rest = words.slice(at + 1);
        if (OTHER_TOOLS.has(word)) {
          problems.push({ kind: 'tool', where, message: `${word} is not npm; this repository installs with npm, and this test reads only npm's spellings` });
        } else if (word === 'npx' || (word === 'npm' && rest[0] === 'exec')) {
          const args = word === 'npx' ? rest : rest.slice(1);
          const flags = args.slice(0, Math.max(0, args.findIndex((a) => !a.startsWith('-'))));
          const name = args.find((a) => !a.startsWith('-'));
          const bad = flags.find((f) => !NPX_FLAGS_THAT_DO_NOT_INSTALL.has(f));
          if (bad) problems.push({ kind: 'tool', where, message: `${word} ${bad} can install a package; run only what an earlier step installed` });
          else if (!name || !(installed.get(job) ?? []).includes(name)) {
            problems.push({ kind: 'tool', where, message: `${name ?? 'nothing'} was not installed earlier in this job, so ${word} would fetch it from the registry, unpinned and with its install scripts` });
          }
        } else if (word === 'npm') {
          const sub = rest[0];
          if (sub === 'install' || sub === 'ci') {
            installs++;
            const scripts = rest.filter((a) => /^--(no-)?ignore-scripts(=|$)/.test(a)).at(-1);
            if (scripts !== '--ignore-scripts' && scripts !== '--ignore-scripts=true') {
              problems.push({ kind: 'scripts', where, message: 'install scripts are allowed to run: add --ignore-scripts' });
            }
            if (sub === 'install') {
              const packages = rest.slice(1).filter((a) => !a.startsWith('-'));
              // A range would let a later publish decide what runs here, which is the same
              // exposure by a slower route. The repository keeps no lockfile, so the version in
              // the line is the pin, and a bare `npm install` would resolve package.json's ranges.
              if (packages.length === 0) problems.push({ kind: 'pin', where, message: 'no package named, so nothing pins what is installed' });
              for (const pkg of packages) if (!EXACT.test(pkg)) problems.push({ kind: 'pin', where, message: `${pkg} is not an exact version` });
              installed.set(job, [...(installed.get(job) ?? []), ...packages.map((p) => p.replace(/@[^@/]*$/, ''))]);
            }
          } else if (!(sub === 'test' || sub === 'run' || (sub === 'audit' && !rest.includes('fix')))) {
            problems.push({ kind: 'tool', where, message: `npm ${sub ?? ''} is not a spelling this test knows, and npm installs through aliases and abbreviations; spell an install \`npm install\` or \`npm ci\`, or teach this test the command` });
          }
        }
      });
    }
  }
  return { problems, installs };
}

const report = (problems) => problems.map((p) => `${p.where}\n  ${p.message}`).join('\n');
const found = audit(workflows);

test('nothing is installed in CI with its install scripts allowed to run', () => {
  assert.ok(found.installs > 0, 'the premise is that CI installs something at all');
  const wrong = found.problems.filter((p) => p.kind === 'scripts' || p.kind === 'tool');
  assert.deepEqual(wrong, [], report(wrong));
});

test('what CI installs is pinned to an exact version', () => {
  const wrong = found.problems.filter((p) => p.kind === 'pin');
  assert.deepEqual(wrong, [], report(wrong));
});

// The reading above against the edits it exists to refuse, so that it goes on refusing them.
const job = (...steps) => `name: t\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps.map((s) => `      - ${s}`).join('\n')}\n`;
const PIN = 'npm install --no-save --no-package-lock --ignore-scripts playwright@1.56.1';

test('the reading refuses every other way of installing, and accepts the ones CI uses', () => {
  const refused = [
    'run: npm i playwright', 'run: npm i --ignore-scripts playwright@1.56.1', 'run: npm add left-pad',
    'run: npm in left-pad', 'run: npm isntall left-pad', 'run: npm instal left-pad', 'run: npm install-cl',
    'run: npm install-clean', 'run: npm clean-install', 'run: npm it', 'run: npm install-test', 'run: npm cit',
    'run: npm install-ci-test', 'run: npm installTest', 'run: npm update', 'run: npm up', 'run: npm rebuild',
    'run: npm link left-pad', 'run: npm audit fix', 'run: npm exec left-pad', 'run: npm x left-pad',
    'run: npm --prefix x install left-pad@1.3.0 --ignore-scripts', 'run: npm',
    'run: npm install left-pad@1.3.0', 'run: npm ci', 'run: npm install --ignore-scripts left-pad',
    'run: npm install --ignore-scripts left-pad@^1.3.0', 'run: npm install --ignore-scripts left-pad@latest',
    'run: npm install --ignore-scripts=false left-pad@1.3.0', 'run: npm install --ignore-scripts --no-ignore-scripts left-pad@1.3.0',
    'run: npx left-pad', 'run: npx --yes left-pad', `run: ${PIN} && npx -p left-pad@1.3.0 playwright`,
    `run: ${PIN} && npx --package=left-pad playwright`, 'run: yarn', 'run: yarn add left-pad', 'run: pnpm i',
    'run: pnpm add left-pad', 'run: pnpx left-pad', 'run: bun add left-pad', 'run: bunx left-pad', 'run: corepack enable',
    'run: |\n          echo one\n          npm i left-pad', 'run: | # a comment\n          npm i left-pad',
    'run: >-\n          npm i\n          left-pad', 'run: "echo a # && npm i left-pad"',
    'run: echo one && npm i left-pad', 'run: echo one; npm i left-pad', 'run: sudo npm i -g left-pad',
    'run: "npm i left-pad"', "run: 'npm i left-pad'", 'run: echo $(npm i left-pad)',
    'name: Install\n        run: npm i left-pad',
  ];
  for (const step of refused) {
    assert.notDeepEqual(audit([{ file: 't.yml', text: job(step) }]).problems, [], `accepted: ${step}`);
  }
  // A package one job installed is not there for the next job's npx.
  const twoJobs = `${job(`run: ${PIN}`)}  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx playwright install chromium\n`;
  assert.notDeepEqual(audit([{ file: 't.yml', text: twoJobs }]).problems, [], 'npx in a job that installed nothing');

  const accepted = [
    ['run: npm test', 'run: npm run test:conventions', `run: ${PIN}`, 'run: npx playwright install --with-deps chromium', 'run: npm run test:e2e'],
    [`run: ${PIN} # pinned`, 'run: npx --no playwright install chromium'],
    ['run: npm ci --ignore-scripts', 'run: npm audit --omit=dev --audit-level=high'],
    ['run: |\n          npm ci --ignore-scripts\n          npm test'],
  ];
  for (const steps of accepted) {
    const { problems } = audit([{ file: 't.yml', text: job(...steps) }]);
    assert.deepEqual(problems, [], report(problems));
  }
});
