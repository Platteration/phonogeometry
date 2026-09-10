// three.js is vendored rather than installed, so what is in the tree is the only record of
// what it is. docs/vendored-three.md names the version and the checksums; this keeps the two
// from drifting apart, whether by an edit to a vendored file or an update that forgets the note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the vendored three.js files are the ones the provenance note describes', () => {
  const note = fs.readFileSync(path.join(root, 'docs', 'vendored-three.md'), 'utf8');
  const files = ['three.module.min.js', 'OrbitControls.js', 'LICENSE'];
  for (const name of files) {
    const digest = sha256(path.join(root, 'vendor', 'three', name));
    assert.ok(
      note.includes(digest),
      `vendor/three/${name} hashes to ${digest}, which docs/vendored-three.md does not mention.\n`
      + 'Update the note (version, paths and checksums) when a vendored file changes.',
    );
  }
});
