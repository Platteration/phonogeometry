// Everything this app keeps in localStorage, and the shape each record has to hold on its
// way back in.
//
// The keys are named here and nowhere else, so a rename is one edit and the settings-contract
// test sees it. Every read site goes through a `cleanX(raw, fallback)` below: localStorage is
// keyed by origin, and the documented deploy target (a GitHub Pages project site) shares that
// origin with every other app the account publishes, so "only this app writes that key" is
// not true. What comes back is checked field by field against a type-of-default fallback and
// enum tables looked up by own property only — `constructor`, `__proto__` and `toString` are
// all truthy on a plain object table and used to pass as members.
//
// DOM-free on purpose: the tests drive it against a tiny Storage fake. The shots themselves
// live in IndexedDB (`storage.js`), which is a different store and untouched here.

export const KEYS = Object.freeze({
  lensOverrides: 'phonogeometry.lensOverrides.v1',
  prefs: 'phonogeometry.prefs.v1',
});

/** Keys earlier builds wrote. Each is migrated to its `KEYS` entry the first time that is read. */
export const LEGACY_KEYS = Object.freeze({
  lensOverrides: 'phonogeometry.lensOverrides',
});

/** The long side of a captured frame, in pixels; the values `#capture-res` offers. */
export const CAPTURE_RES = Object.freeze({ 960: true, 1280: true, 1920: true });

/** The four controls of the settings dialog, with the values the markup starts them at. */
export const DEFAULT_PREFS = Object.freeze({
  captureRes: '1280',   // #capture-res
  sequential: true,     // #chk-sequential
  gpu: true,            // #chk-gpu
  rig: true,            // #chk-rig
});

/** The own fields of a stored object, or nothing for anything that is not one. */
export function fields(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** True when `value` is one of `table`'s own keys — never an inherited one like `constructor`. */
export function has(table, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return Object.prototype.hasOwnProperty.call(table, value);
}

/** `value` when it is one of `table`'s own keys, else `fallback`. */
export function pick(value, table, fallback) {
  return has(table, value) ? value : fallback;
}

export function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** A finite number within `[min, max]`, or undefined. */
export function num(value, min = -Infinity, max = Infinity) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/**
 * The settings record. `captureRes` is kept as the string the <select> holds — the markup is
 * the table's source of truth, and `String(1280) === '1280'` is how a number stored by hand
 * still matches it.
 */
export function cleanPrefs(raw, fallback = DEFAULT_PREFS) {
  const f = fields(raw);
  const res = typeof f.captureRes === 'number' ? String(f.captureRes) : f.captureRes;
  return {
    captureRes: pick(res, CAPTURE_RES, fallback.captureRes),
    sequential: bool(f.sequential, fallback.sequential),
    gpu: bool(f.gpu, fallback.gpu),
    rig: bool(f.rig, fallback.rig),
  };
}

/** localStorage where there is one. Reaching for it can itself throw (cookies blocked). */
export function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/**
 * Move a record from the key an earlier build wrote to the one this build reads.
 *
 *   read NEW: present → delete OLD if present; stop
 *             absent  → read OLD: absent  → stop
 *                                 present → write NEW verbatim; delete OLD only if that succeeded
 *
 * Both present means NEW wins: the only way that happens is a migrated build wrote NEW and
 * then could not delete OLD, and NEW is what it has read and written since. The copy is
 * bytes, not judgement — a record the app cannot parse is still the visitor's only copy, and
 * it meets exactly the same read-side guard under the new key as it did under the old. A
 * failed write leaves OLD in place, so the next launch tries again. Returns whether it copied.
 */
export function migrateKey(storage, oldKey, newKey) {
  if (!storage) return false;
  try {
    if (storage.getItem(newKey) !== null) {
      try { storage.removeItem(oldKey); } catch { /* it will be removed on a later launch */ }
      return false;
    }
    const old = storage.getItem(oldKey);
    if (old === null) return false;
    storage.setItem(newKey, old);
  } catch {
    return false;   // OLD stays, untouched
  }
  try { storage.removeItem(oldKey); } catch { /* NEW is written; OLD lingers and loses to it */ }
  return true;
}

/** The parsed JSON under `key`, or undefined for nothing stored, a storage that will not answer, or bytes that do not parse. */
export function readRecord(storage, key) {
  if (!storage) return undefined;
  try {
    const text = storage.getItem(key);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Write `value` as JSON under `key`; false when the storage would not take it. */
export function writeRecord(storage, key, value) {
  if (!storage) return false;
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadPrefs(storage = defaultStorage()) {
  return cleanPrefs(readRecord(storage, KEYS.prefs));
}

export function savePrefs(prefs, storage = defaultStorage()) {
  return writeRecord(storage, KEYS.prefs, cleanPrefs(prefs));
}
