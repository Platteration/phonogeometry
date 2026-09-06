// Intrinsic parameter estimation for phone cameras.
// Browsers do not expose focal lengths, so we infer the lens type from the device label
// and use typical horizontal fields of view. Users can override the lens per camera.

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

const STORAGE_KEY = 'phonogeometry.lensOverrides';

export function loadLensOverrides() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}

export function saveLensOverride(cameraKey, lens, hfov) {
  const all = loadLensOverrides();
  all[cameraKey] = { lens, hfov };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
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
