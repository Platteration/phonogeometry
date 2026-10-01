// three.js is vendored rather than installed, so what is in the tree is the only record of
// what it is. docs/vendored-three.md names the version and the checksums; this keeps the two
// from drifting apart, whether by an edit to a vendored file or an update that forgets the note.
// It cannot prove the files are three.js — the note is in the same tree, so a changed blob with
// a changed row agrees with itself. `npm run verify:vendor` is what compares them to the signed
// package on the registry; this is the offline half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseProvenance } from '../tools/verify-three.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the vendored three.js files are the ones the provenance note describes', () => {
  const note = fs.readFileSync(path.join(root, 'docs', 'vendored-three.md'), 'utf8');
  const { version, files } = parseProvenance(note);
  assert.ok(version, 'docs/vendored-three.md must name the version it vendors, as `three@x.y.z`');

  // Every vendored file has a row and every row names a vendored file: a hash that is merely
  // present somewhere on the page says nothing about the file it was written for.
  const onDisk = fs.readdirSync(path.join(root, 'vendor', 'three')).sort();
  assert.deepEqual(files.map((f) => f.name).sort(), onDisk, 'docs/vendored-three.md must have one row per file in vendor/three');

  for (const f of files) {
    const digest = sha256(path.join(root, 'vendor', 'three', f.name));
    assert.equal(
      digest, f.sha256,
      `vendor/three/${f.name} hashes to ${digest}, not the ${f.sha256} its own row in docs/vendored-three.md records.\n`
      + 'Update the note (version, paths and checksums) when a vendored file changes, and run `npm run verify:vendor`.',
    );
  }
});
