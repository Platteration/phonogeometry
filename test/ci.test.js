// CI installs Playwright by a version pinned in .github/workflows/ci.yml (the app keeps no
// dependencies), and then the Chromium build that version names for the runner's system. A
// Playwright with no build for that system cannot install a browser there: 1.56.1 stopped with
// "Playwright does not support chromium on ubuntu26.04-x64" before the browser suite ran
// (measured with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu26.04-x64), which is what the check job
// would have met on ubuntu-latest, a label GitHub moves to Ubuntu 26.04 from 2026-10-19. So every
// job that installs the browser runs on a named release (ubuntu-24.04, CONVENTIONS.md "CI"), and
// the pinned Playwright is one with a Chromium build for the release that job names. The unit
// suite runs on the bare checkout before CI installs Playwright, so the question cannot be put to
// Playwright's own CLI here; it is answered from FIRST_WITH_BUILD, read off each release's
// playwright-core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// The first Playwright release whose registry lists a Chromium download for each Ubuntu release
// (`ubuntu<release>-x64` in playwright-core's browser registry, read off the published packages:
// 1.44.1 lists neither, 1.45.0 lists 24.04, 1.60.0 lists no 26.04 and 1.61.0 does). Playwright
// 1.64.0, asked with `install --dry-run chromium` and PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, names a
// build for both. A runner on a release missing here fails until its first release is measured
// the same way and added.
const FIRST_WITH_BUILD = { '24.04': [1, 45, 0], '26.04': [1, 61, 0] };

/** A workflow's jobs, read from its block YAML (the conventions test holds every workflow to
 *  that shape): each job's name, its runs-on, whether a step installs Playwright's browser, and
 *  the Playwright versions its steps install. */
function jobs(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0, 'the workflow has jobs');
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) { out.push({ name: job[1], runsOn: null, installsBrowser: false, pins: [] }); continue; }
    if (!out.length || line.trimStart().startsWith('#')) continue;
    const current = out[out.length - 1];
    const runsOn = line.match(/^ {4}runs-on:\s*(\S+)\s*$/);
    if (runsOn) current.runsOn = runsOn[1];
    if (/\bplaywright install\b/.test(line)) current.installsBrowser = true;
    const pin = line.match(/^\s*- run: npm install --no-save --no-package-lock --ignore-scripts playwright@(\S+)\s*$/);
    if (pin) current.pins.push(pin[1]);
  }
  return out;
}

const compare = (a, b) => a.map((n, i) => n - b[i]).find((d) => d !== 0) ?? 0;

/** What is wrong with the browser installs of these workflows ({ file, text } each), as
 *  messages, and the jobs that install the browser, as `<file> <job>`. */
function browserInstalls(workflows) {
  const problems = [];
  const installing = [];
  for (const { file, text } of workflows) {
    for (const job of jobs(text).filter((j) => j.installsBrowser)) {
      installing.push(`${file} ${job.name}`);
      if (job.pins.length !== 1) { problems.push(`${file}: the ${job.name} job installs Playwright ${job.pins.length} times before its browser; once, by an exact version`); continue; }
      const [pin] = job.pins;
      if (!/^\d+\.\d+\.\d+$/.test(pin)) { problems.push(`${file}: playwright@${pin} is not an exact version, so CI would not run the browser this suite was measured with`); continue; }
      const release = String(job.runsOn).match(/^ubuntu-(\d{2}\.\d{2})$/);
      if (!release) { problems.push(`${file}: the ${job.name} job runs on ${job.runsOn}; a job that installs the browser runs on a named Ubuntu release (ubuntu-24.04), never a label that moves`); continue; }
      const first = FIRST_WITH_BUILD[release[1]];
      if (!first) { problems.push(`${file}: the ${job.name} job runs on ${job.runsOn}, for which this test does not know the first Playwright with a Chromium build: measure it and add it to FIRST_WITH_BUILD`); continue; }
      if (compare(pin.split('.').map(Number), first) < 0) {
        problems.push(`${file}: the ${job.name} job runs on ${job.runsOn}, and playwright@${pin} has no Chromium build for Ubuntu ${release[1]}: ${first.join('.')} is the first that does`);
      }
    }
  }
  return { problems, installing };
}

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/pages.yml'];

test('CI pins a Playwright that can install Chromium on the Ubuntu release its job names', () => {
  const { problems, installing } = browserInstalls(WORKFLOWS.map((file) => ({ file, text: read(file) })));
  assert.deepEqual(problems, []);
  assert.deepEqual(installing, ['.github/workflows/ci.yml check'], 'CI\'s check job installs the browser, and this test read it');
});

// The reading above against the edits it exists to refuse, so that it goes on refusing them.
const workflow = (runsOn, pin, ...more) => [
  'name: t', 'on: push', 'jobs:', '  check:', `    runs-on: ${runsOn}`, '    timeout-minutes: 20', '    steps:',
  `      - run: npm install --no-save --no-package-lock --ignore-scripts playwright@${pin}`,
  '      - run: npx playwright install --with-deps chromium', ...more, '',
].join('\n');
const problemsOf = (text) => browserInstalls([{ file: 't.yml', text }]).problems;

test('the reading refuses a moving label, an unmeasured release and a Playwright too old for the named one', () => {
  for (const [runsOn, pin] of [
    ['ubuntu-latest', '1.64.0'], ['ubuntu-26.04', '1.56.1'], ['ubuntu-26.04', '1.60.9'], ['ubuntu-24.04', '1.44.1'],
    ['ubuntu-22.04', '1.64.0'], ['ubuntu-28.04', '1.64.0'], ['${{ matrix.os }}', '1.64.0'], ['[ubuntu-24.04]', '1.64.0'],
    ['ubuntu-24.04', '^1.64.0'], ['ubuntu-24.04', 'latest'],
  ]) {
    assert.notDeepEqual(problemsOf(workflow(runsOn, pin)), [], `accepted: runs-on ${runsOn}, playwright@${pin}`);
  }
  assert.notDeepEqual(problemsOf(workflow('ubuntu-24.04', '1.64.0', '      - run: npm install --no-save --no-package-lock --ignore-scripts playwright@1.56.1')), [], 'accepted: a second install');
  for (const [runsOn, pin] of [['ubuntu-24.04', '1.45.0'], ['ubuntu-24.04', '1.64.0'], ['ubuntu-26.04', '1.61.0'], ['ubuntu-26.04', '1.64.0']]) {
    assert.deepEqual(problemsOf(workflow(runsOn, pin)), [], `refused: runs-on ${runsOn}, playwright@${pin}`);
  }
  // A job that installs no browser is not held to anything, and is not counted.
  assert.deepEqual(browserInstalls([{ file: 't.yml', text: 'jobs:\n  vendor:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n' }]), { problems: [], installing: [] });
});
