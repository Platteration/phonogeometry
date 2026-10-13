// CI installs Playwright by a version pinned in .github/workflows/ci.yml (the app keeps no
// dependencies), and then the Chromium build that version names for the runner's system. The
// check job runs on ubuntu-latest, which GitHub moves to Ubuntu 26.04 from 2026-10-19, and a
// Playwright with no build for that system cannot install a browser there: 1.56.1 stopped with
// "Playwright does not support chromium on ubuntu26.04-x64" before the browser suite ran
// (measured with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu26.04-x64). The first release whose
// registry lists ubuntu26.04 builds is 1.61.0, read off each release's playwright-core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const FIRST_WITH_UBUNTU_26 = [1, 61, 0];

test('CI pins a Playwright that can install Chromium on the Ubuntu ubuntu-latest becomes', () => {
  const pins = [...ci.matchAll(/^\s*- run: npm install --no-save --no-package-lock --ignore-scripts playwright@(\S+)\s*$/gm)].map((m) => m[1]);
  assert.equal(pins.length, 1, 'ci.yml installs Playwright once, by an exact version');
  assert.match(pins[0], /^\d+\.\d+\.\d+$/, `playwright@${pins[0]} is an exact version, so CI runs the browser this suite was measured with`);
  const version = pins[0].split('.').map(Number);
  const cmp = version.map((n, i) => n - FIRST_WITH_UBUNTU_26[i]).find((d) => d !== 0) ?? 0;
  assert.ok(cmp >= 0, `playwright@${pins[0]} has no Chromium build for Ubuntu 26.04: ${FIRST_WITH_UBUNTU_26.join('.')} is the first that does`);
});
