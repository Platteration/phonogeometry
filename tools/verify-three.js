// Checks the vendored three.js against the package npm published, not against the note that
// sits beside it: docs/vendored-three.md lives in this tree, so an edited blob plus an edited
// row agrees with itself and `npm test` stays green. This needs the network, which is why it
// is a CI job of its own (`npm run verify:vendor`) rather than part of the test suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read the provenance note: the version it claims, and one row per vendored file. Exported so
 * test/vendor.test.js checks each hash against its own row rather than against the whole page.
 */
export function parseProvenance(note) {
  const version = note.match(/\*\*Version:\*\*\s*`three@([\w.-]+)`/)?.[1] || null;
  const files = [];
  for (const m of note.matchAll(/^\|\s*`vendor\/three\/([^`|]+)`\s*\|\s*`([^`|]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/gm)) {
    files.push({ name: m[1], upstream: m[2], sha256: m[3] });
  }
  return { version, files };
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function main() {
  const note = fs.readFileSync(path.join(root, 'docs', 'vendored-three.md'), 'utf8');
  const { version, files } = parseProvenance(note);
  if (!version || files.length === 0) throw new Error('docs/vendored-three.md: could not read the version and the file table');

  const meta = await json(`https://registry.npmjs.org/three/${version}`);
  const tgz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  if (integrity !== meta.dist.integrity) throw new Error(`the tarball for three@${version} does not match its own dist.integrity`);

  // The registry signs `name@version:integrity` with a key it publishes, so a substituted
  // tarball is caught even if the metadata was substituted with it.
  const sig = meta.dist.signatures?.[0];
  const key = (await json('https://registry.npmjs.org/-/npm/v1/keys')).keys.find((k) => k.keyid === sig?.keyid);
  if (!sig || !key) throw new Error(`three@${version} carries no registry signature this key set can check`);
  const pem = `-----BEGIN PUBLIC KEY-----\n${key.key.replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----\n`;
  if (!createVerify('SHA256').update(`three@${version}:${meta.dist.integrity}`).verify(pem, Buffer.from(sig.sig, 'base64'))) {
    throw new Error(`the registry signature for three@${version} does not verify`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-three-'));
  try {
    fs.writeFileSync(path.join(dir, 'three.tgz'), tgz);
    execFileSync('tar', ['xzf', 'three.tgz', ...files.map((f) => `package/${f.upstream}`)], { cwd: dir });
    for (const f of files) {
      const published = fs.readFileSync(path.join(dir, 'package', f.upstream));
      const vendored = fs.readFileSync(path.join(root, 'vendor', 'three', f.name));
      if (!published.equals(vendored)) throw new Error(`vendor/three/${f.name} is not the ${f.upstream} published in three@${version}`);
      // The note's own row must record the published bytes too, so updating the hash to match
      // a modified file is no longer enough to make the tree agree with itself.
      const digest = createHash('sha256').update(published).digest('hex');
      if (digest !== f.sha256) throw new Error(`docs/vendored-three.md records ${f.sha256} for ${f.name}; the published file hashes to ${digest}`);
      console.log(`  ${f.name}: identical to package/${f.upstream}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`vendor/three is three@${version} from the registry, signature verified.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Vendored three.js check failed: ${err.message}`); process.exit(1); });
}
