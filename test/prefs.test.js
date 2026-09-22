// What comes back out of localStorage is untrusted input: the origin is shared with every other
// app the account publishes, and a value put there by hand or by an old build reaches the
// camera code by the same road as one this app wrote. Each stored record is checked here on
// the way in, field by field, and the one key that changed name is moved forward without
// losing what was under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYS, LEGACY_KEYS, CAPTURE_RES, DEFAULT_PREFS, cleanPrefs, loadPrefs, savePrefs, migrateKey, has,
} from '../src/prefs.js';
import { LENS_TYPES, HFOV_RANGE, cleanLensOverrides, loadLensOverrides, saveLensOverride } from '../src/camera/intrinsics.js';

/** The Storage interface, on a Map. `failWrites` makes setItem throw the way a full quota does. */
function fakeStorage(entries = {}, { failWrites = false } = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) { if (failWrites) throw new DOMException('QuotaExceededError', 'QuotaExceededError'); map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// Built with JSON.parse, not a literal: `{__proto__: x}` as a literal sets the prototype,
// while JSON.parse makes an own `__proto__` key — the case that matters.
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype);

// ---------- cleanLensOverrides ----------

test('a lens override is checked field by field, and a prototype name is not a lens', () => {
  for (const name of PROTO_NAMES) {
    const cleaned = cleanLensOverrides(JSON.parse(`{"Back":{"lens":${JSON.stringify(name)},"hfov":90}}`));
    assert.deepEqual(cleaned.Back, { lens: null, hfov: 90 }, `${name} must not pass as a lens`);
    // And a camera whose label is a prototype name is looked up without finding a function.
    const keyed = cleanLensOverrides(JSON.parse(`{${JSON.stringify(name)}:{"lens":"telephoto","hfov":null}}`));
    assert.deepEqual(keyed[name], { lens: 'telephoto', hfov: null }, `a camera labelled ${name} keeps its override`);
    assert.equal(Object.getPrototypeOf(keyed), null, 'no prototype, so a label can never find an inherited member');
  }
  // What the app used to do with a name it does not know: renderLensSettings reads
  // LENS_TYPES[cam.lens].hfov bare, so this threw after the streams were open.
  const bogus = cleanLensOverrides({ Back: { lens: 'bogus', hfov: null } });
  assert.equal(bogus.Back, undefined, 'nothing usable is left, so the record goes');
  assert.doesNotThrow(() => LENS_TYPES[bogus.Back?.lens ?? 'wide'].hfov);
});

test('every lens name round-trips, and a stored field of view is bounded by what the input can write', () => {
  for (const lens of Object.keys(LENS_TYPES)) {
    assert.deepEqual(cleanLensOverrides({ cam: { lens, hfov: null } }).cam, { lens, hfov: null });
    assert.deepEqual(cleanLensOverrides({ cam: { lens, hfov: 77.5 } }).cam, { lens, hfov: 77.5 });
  }
  assert.deepEqual(cleanLensOverrides({ cam: { lens: 'wide', hfov: HFOV_RANGE.min } }).cam, { lens: 'wide', hfov: HFOV_RANGE.min });
  assert.deepEqual(cleanLensOverrides({ cam: { lens: 'wide', hfov: HFOV_RANGE.max } }).cam, { lens: 'wide', hfov: HFOV_RANGE.max });
  for (const hfov of [HFOV_RANGE.min - 1, HFOV_RANGE.max + 1, 0, -70, 1e9, Infinity, NaN, '90', 'abc', true, {}]) {
    assert.deepEqual(cleanLensOverrides({ cam: { lens: 'wide', hfov } }).cam, { lens: 'wide', hfov: null }, `hfov ${String(hfov)}`);
  }
  // The bound is the number input's own, which is the only thing that ever writes one.
  assert.deepEqual(HFOV_RANGE, { min: 20, max: 140 });
});

test('a record that is not an object, or entries that are not, are dropped without a throw', () => {
  for (const raw of [null, undefined, 'x', 7, true, [], [{ lens: 'wide' }]]) {
    const cleaned = cleanLensOverrides(raw);
    assert.equal(Object.keys(cleaned).length, 0, `raw ${JSON.stringify(raw)}`);
  }
  const mixed = cleanLensOverrides({ a: null, b: 'wide', c: 3, d: ['wide'], e: { lens: 'front' } });
  assert.deepEqual(Object.keys(mixed), ['e']);
  assert.deepEqual(mixed.e, { lens: 'front', hfov: null });
});

test('cleaning is idempotent, so a save that rewrites the record loses nothing more', () => {
  const once = cleanLensOverrides({ a: { lens: 'ultrawide', hfov: 100 }, b: { lens: 'nope', hfov: 30 }, c: { lens: 'nope', hfov: 900 } });
  assert.deepEqual(cleanLensOverrides(once), once);
  assert.deepEqual(Object.keys(once), ['a', 'b']);
});

// ---------- the migration, driven from the read site ----------

const OLD = LEGACY_KEYS.lensOverrides;
const NEW = KEYS.lensOverrides;
const record = JSON.stringify({ 'camera2 0, facing back': { lens: 'telephoto', hfov: 40 } });

test('old key only: the bytes move to the new key and the old one is deleted', () => {
  const s = fakeStorage({ [OLD]: record });
  const loaded = loadLensOverrides(s);
  assert.deepEqual(loaded['camera2 0, facing back'], { lens: 'telephoto', hfov: 40 });
  assert.equal(s.map.get(NEW), record, 'verbatim bytes');
  assert.equal(s.map.has(OLD), false);
});

test('new key only: read as it is, nothing else touched', () => {
  const s = fakeStorage({ [NEW]: record });
  const loaded = loadLensOverrides(s);
  assert.deepEqual(loaded['camera2 0, facing back'], { lens: 'telephoto', hfov: 40 });
  assert.deepEqual([...s.map.keys()], [NEW]);
});

test('both present: the new record wins and the old one goes', () => {
  const older = JSON.stringify({ 'camera2 0, facing back': { lens: 'ultrawide', hfov: 120 } });
  const s = fakeStorage({ [OLD]: older, [NEW]: record });
  const loaded = loadLensOverrides(s);
  assert.equal(loaded['camera2 0, facing back'].lens, 'telephoto', 'NEW is what the migrated build has read and written since');
  assert.equal(s.map.get(NEW), record);
  assert.equal(s.map.has(OLD), false);
});

test('a write that fails leaves the old record where it was, for the next launch', () => {
  const s = fakeStorage({ [OLD]: record }, { failWrites: true });
  const loaded = loadLensOverrides(s);
  assert.equal(s.map.get(OLD), record, 'OLD must survive a failed copy');
  assert.equal(s.map.has(NEW), false);
  // The read still fell through to nothing rather than throwing, and the copy is reported as not done.
  assert.equal(Object.keys(loaded).length, 0);
  assert.equal(migrateKey(s, OLD, NEW), false);
});

test('running the migration twice is the same as once, and it copies bytes it cannot parse', () => {
  const s = fakeStorage({ [OLD]: record });
  assert.equal(migrateKey(s, OLD, NEW), true);
  assert.equal(migrateKey(s, OLD, NEW), false, 'nothing left to move');
  assert.deepEqual([...s.map.entries()], [[NEW, record]]);
  const junk = fakeStorage({ [OLD]: '{not json' });
  assert.deepEqual(loadLensOverrides(junk), Object.create(null));
  assert.equal(junk.map.get(NEW), '{not json', 'unreadable or not, it is the visitor\'s only copy');
  assert.equal(junk.map.has(OLD), false);
});

test('a storage that is missing or refuses to answer reads as empty and never throws', () => {
  assert.deepEqual(loadLensOverrides(undefined), Object.create(null));
  assert.deepEqual(loadPrefs(undefined), DEFAULT_PREFS);
  const hostile = { getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
  assert.deepEqual(loadLensOverrides(hostile), Object.create(null));
  assert.deepEqual(loadPrefs(hostile), DEFAULT_PREFS);
  assert.equal(savePrefs(DEFAULT_PREFS, hostile), false);
  assert.equal(saveLensOverride('cam', 'wide', 90, undefined), false);
});

test('saving one override keeps the others and writes under the new key', () => {
  const s = fakeStorage({ [OLD]: record });
  assert.equal(saveLensOverride('front', 'front', 70, s), true);
  const stored = JSON.parse(s.map.get(NEW));
  assert.deepEqual(stored, { 'camera2 0, facing back': { lens: 'telephoto', hfov: 40 }, front: { lens: 'front', hfov: 70 } });
  assert.equal(s.map.has(OLD), false);
});

// ---------- cleanPrefs ----------

test('a prototype name is not a capture resolution, and the default fills every field it cannot read', () => {
  for (const name of PROTO_NAMES) {
    const cleaned = cleanPrefs(JSON.parse(`{"captureRes":${JSON.stringify(name)},"sequential":${JSON.stringify(name)},"gpu":1,"rig":"true"}`));
    assert.deepEqual(cleaned, DEFAULT_PREFS, name);
    assert.equal(has(CAPTURE_RES, name), false, `has() must not see ${name} as a member`);
  }
  assert.equal(has(CAPTURE_RES, '1280'), true);
  assert.equal(has(CAPTURE_RES, 1280), true);
});

test('the defaults and every capture resolution round-trip; a number stored by hand still matches', () => {
  assert.deepEqual(cleanPrefs(DEFAULT_PREFS), DEFAULT_PREFS);
  assert.deepEqual(cleanPrefs(cleanPrefs(DEFAULT_PREFS)), DEFAULT_PREFS);
  for (const res of Object.keys(CAPTURE_RES)) {
    assert.equal(cleanPrefs({ captureRes: res }).captureRes, res);
    assert.equal(cleanPrefs({ captureRes: Number(res) }).captureRes, res);
  }
  const off = { captureRes: '1920', sequential: false, gpu: false, rig: false };
  assert.deepEqual(cleanPrefs(off), off);
  assert.deepEqual(cleanPrefs(JSON.parse(JSON.stringify(off))), off);
  for (const raw of [null, undefined, 'x', 7, [], [DEFAULT_PREFS], { captureRes: '1281', sequential: 'no', gpu: null, rig: 0 }]) {
    assert.deepEqual(cleanPrefs(raw), DEFAULT_PREFS, JSON.stringify(raw));
  }
});

test('preferences are written cleaned and read back through the same check', () => {
  const s = fakeStorage();
  assert.equal(savePrefs({ captureRes: '960', sequential: false, gpu: true, rig: 'yes' }, s), true);
  assert.deepEqual(JSON.parse(s.map.get(KEYS.prefs)), { captureRes: '960', sequential: false, gpu: true, rig: true });
  assert.deepEqual(loadPrefs(s), { captureRes: '960', sequential: false, gpu: true, rig: true });
  s.map.set(KEYS.prefs, '{"captureRes":"__proto__"}');
  assert.deepEqual(loadPrefs(s), DEFAULT_PREFS);
});
