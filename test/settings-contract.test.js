// The settings contract, pinned as literals. A renamed storage key silently orphans every
// visitor's saved preferences, so the strings are spelled out here rather than derived: the
// test has to fail when the module changes, which a test that reads the module back cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, LEGACY_KEYS, DEFAULT_PREFS, CAPTURE_RES } from '../src/prefs.js';
import { APP_VERSION } from '../src/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the storage keys are exactly these, and the migrated key is not one of them', () => {
  assert.deepEqual(KEYS, {
    lensOverrides: 'phonogeometry.lensOverrides.v1',
    prefs: 'phonogeometry.prefs.v1',
  });
  assert.deepEqual(LEGACY_KEYS, { lensOverrides: 'phonogeometry.lensOverrides' });
  for (const key of Object.values(KEYS)) assert.match(key, /^phonogeometry\.[a-zA-Z]+\.v\d+$/, key);
  assert.equal(new Set(Object.values(KEYS)).size, Object.values(KEYS).length, 'no two records share a key');
});

test('the preferences record holds the four settings controls and nothing else', () => {
  assert.deepEqual(Object.keys(DEFAULT_PREFS), ['captureRes', 'sequential', 'gpu', 'rig']);
  assert.deepEqual(DEFAULT_PREFS, { captureRes: '1280', sequential: true, gpu: true, rig: true });
});

test('the capture resolutions are the ones the markup offers', () => {
  assert.deepEqual(Object.keys(CAPTURE_RES), ['960', '1280', '1920']);
  // The table and the <select> are two spellings of one list; the markup is read here so a
  // new <option> without a table entry (or the reverse) is caught.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const select = html.match(/<select id="capture-res">([\s\S]*?)<\/select>/)[1];
  const offered = [...select.matchAll(/<option value="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, Object.keys(CAPTURE_RES));
  assert.match(select, new RegExp(`value="${DEFAULT_PREFS.captureRes}" selected`), 'the default is the option the markup selects');
});

test('the About block shows the version package.json declares', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});
