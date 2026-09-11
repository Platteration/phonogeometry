// The CI workflow is the only place this repository installs anything from the registry, and
// how it installs it is a decision rather than a detail: an install script runs arbitrary code
// from a package's whole dependency tree, on a runner holding this repository's token. The
// audit records that finding as fixed "with a regression test"; this is that test. Without it
// the flag is one careless edit away from coming back off, with nothing to notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');

test('nothing is installed in CI with its install scripts allowed to run', () => {
  const installs = workflow.split('\n').filter((line) => /\bnpm (install|ci)\b/.test(line));
  assert.ok(installs.length > 0, 'the premise is that CI installs something at all');
  for (const line of installs) assert.match(line, /--ignore-scripts\b/, line.trim());
});

test('what CI installs is pinned to an exact version', () => {
  // A range would let a later publish decide what runs here, which is the same exposure by a
  // slower route. The repository keeps no lockfile, so the version in the line is the pin.
  const installs = workflow.split('\n').filter((line) => /\bnpm install\b/.test(line));
  for (const line of installs) {
    const packages = line.trim().split(/\s+/).filter((word) => !word.startsWith('-') && /@/.test(word));
    assert.ok(packages.length > 0, `no package named in: ${line.trim()}`);
    for (const pkg of packages) assert.match(pkg, /@\d+\.\d+\.\d+$/, `${pkg} is not an exact version`);
  }
});
