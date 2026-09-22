// Intrinsic parameter estimation for phone cameras.
// Browsers do not expose focal lengths, so we infer the lens type from the device label
// and use typical horizontal fields of view. Users can override the lens per camera.

import { KEYS, LEGACY_KEYS, fields, has, num, migrateKey, readRecord, writeRecord, defaultStorage } from '../prefs.js';

export const LENS_TYPES = {
  ultrawide: { label: 'Ultra-wide', hfov: 104 },
  wide: { label: 'Wide (main)', hfov: 69 },
  telephoto: { label: 'Telephoto', hfov: 35 },
  front: { label: 'Front (selfie)', hfov: 76 },
  unknown: { label: 'Unknown (assume wide)', hfov: 69 },
};

export function guessFacing(label = '') {
  const l = label.toLowerCase();
  if (/front|user|selfie|facetime/.test(l)) return 'user';
  if (/back|rear|environment/.test(l)) return 'environment';
  return 'unknown';
}

export function guessLens(label = '', facing = 'unknown') {
  const l = label.toLowerCase();
  if (/ultra|0\.5x|wide angle|uw/.test(l) && !/dual|triple/.test(l)) return 'ultrawide';
  if (/tele|zoom|3x|5x|periscope/.test(l)) return 'telephoto';
  if (facing === 'user' || /front|user|selfie|facetime/.test(l)) return 'front';
  if (/back|rear|environment|camera/.test(l)) return 'wide';
  return 'unknown';
}

/** Focal length in pixels from the horizontal field of view of the long image side. */
export function focalFromFov(width, height, hfovDeg) {
  return (Math.max(width, height) / 2) / Math.tan((hfovDeg * Math.PI) / 360);
}

/**
 * The field of view an override may carry, in degrees. The only writer is the number input in
 * the settings dialog (app.js, `min: '20', max: '140'`, and its change handler checks the same
 * bounds), so anything outside them was never written by this app. focalFromFov itself is
 * finite and positive for the wider (0, 180), but at either end of that the focal length is
 * absurd rather than merely wrong, and the input would refuse the value on its next edit.
 */
export const HFOV_RANGE = Object.freeze({ min: 20, max: 140 });

/**
 * The stored overrides, one record per camera key, checked field by field. The lens has to be
 * one of LENS_TYPES' own names: every other lookup guards with `?.`, but renderLensSettings
 * reads `LENS_TYPES[cam.lens].hfov` bare, so a name it does not know throws after the streams
 * are open and disables capture on every launch until site data is cleared (REVIEW.md BUG-1).
 * Each field that fails falls back on its own — a bad lens keeps a good field of view — and a
 * record with nothing usable left is dropped, since it would set nothing anyway.
 *
 * The result has no prototype, because the camera key it is looked up by is the label the
 * operating system gave the lens: on a plain object a label of `constructor` finds a function.
 */
export function cleanLensOverrides(raw) {
  const out = Object.create(null);
  const all = fields(raw);
  for (const key of Object.keys(all)) {
    const ov = fields(all[key]);
    const lens = has(LENS_TYPES, ov.lens) ? ov.lens : null;
    const hfov = num(ov.hfov, HFOV_RANGE.min, HFOV_RANGE.max) ?? null;
    if (lens === null && hfov === null) continue;
    out[key] = { lens, hfov };
  }
  return out;
}

/**
 * Read the overrides, moving them from the key earlier builds wrote first. The migration is
 * here, at the one read site, because localStorage is synchronous: nothing can read the new
 * key before this has run.
 */
export function loadLensOverrides(storage = defaultStorage()) {
  migrateKey(storage, LEGACY_KEYS.lensOverrides, KEYS.lensOverrides);
  return cleanLensOverrides(readRecord(storage, KEYS.lensOverrides));
}

export function saveLensOverride(cameraKey, lens, hfov, storage = defaultStorage()) {
  const all = loadLensOverrides(storage);
  all[cameraKey] = { lens, hfov };
  return writeRecord(storage, KEYS.lensOverrides, all);
}

/**
 * Compute intrinsics for a captured frame.
 * @param cam {label, facing, lens, hfovOverride?} camera record
 * @param width,height frame size
 * @param zoom current digital zoom factor (1 = none)
 */
export function intrinsicsFor(cam, width, height, zoom = 1) {
  const hfov = cam.hfovOverride || LENS_TYPES[cam.lens]?.hfov || LENS_TYPES.unknown.hfov;
  const f = focalFromFov(width, height, hfov) * (zoom || 1);
  return { f, cx: (width - 1) / 2, cy: (height - 1) / 2, hfov };
}
