// Phonogeometry app controller: capture from all cameras -> reconstruct in a worker -> view/export.
import { CameraManager } from './camera/cameraManager.js';
import { LENS_TYPES, saveLensOverride, intrinsicsFor } from './camera/intrinsics.js';
import { readExifFov } from './camera/exif.js';
import { rgbaToGray, sharpness } from './vision/image.js';
import { QUALITY, markSoftFrames } from './pipeline/reconstruct.js';
import { toGLB, toPLY, toOBJ, toPointCloudPLY } from './mesh/exporters.js';
import { ShotStore } from './storage.js';

const $ = (sel) => document.querySelector(sel);
/** Build an element with a class and text. Text is set as text, never parsed as markup. */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
const state = {
  preset: 'object',
  metresPerUnit: null, // set once the user tells us the real size of something they measured
  shots: [], // {id, frames: [{blob, thumbUrl, width, height, f, cx, cy, label, lens, key}]}
  worker: null,
  result: null,
  viewer: null,
  cameraTiles: new Map(),
};
const cams = new CameraManager();
const store = new ShotStore();

const PRESET_TIPS = {
  object: 'Circle the object in small steps, about a hand-width of sideways movement between shots, and keep more than half of each view shared with the last one. Aim for 20–40 shots.',
  person: 'Ask them to stand still. Circle them in small steps at chest height, then add a higher and a lower pass for the head and the legs. Aim for 25–50 shots.',
  room: 'Stand near the middle, shoot, step half a metre sideways, shoot again; go round twice at two heights. Front and back cameras fire together, so each shot covers two walls. Keep furniture or a corner in view, not just a bare wall.',
};

// ---------- UI helpers ----------
let toastTimer = null;
function toast(msg, ms = 3000) {
  const box = $('#toast');
  box.textContent = msg; box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}
function showScreen(name) {
  for (const s of ['capture', 'process', 'view']) $(`#screen-${s}`).hidden = s !== name;
  $('#capture-bar').hidden = name !== 'capture';
  if (name === 'view' && state.viewer) state.viewer.resize();
}
function frameCount() { return state.shots.reduce((n, s) => n + s.frames.length, 0); }
function updateCounts() {
  $('#shot-count').textContent = state.shots.length;
  const n = frameCount();
  $('#frame-count').textContent = n ? `· ${n} frames${n > 60 ? ' · many frames: Fast quality recommended' : ''}` : '';
  $('#btn-reconstruct').disabled = n < 2;
  // Rough on-phone processing time per frame at each quality level
  // Rough seconds per frame on a phone, from timings on a laptop scaled for slower hardware
  const perFrame = { fast: 4, balanced: 8, high: 20 }[$('#quality').value] || 8;
  const secs = n * perFrame;
  $('#btn-reconstruct').textContent = n >= 2 ? `Build 3D mesh (~${secs < 90 ? Math.round(secs) + 's' : Math.round(secs / 60) + ' min'})` : 'Build 3D mesh';
}

// ---------- Cameras ----------
function renderCameraTiles(results) {
  const grid = $('#camera-grid');
  grid.innerHTML = '';
  state.cameraTiles.clear();
  for (const cam of cams.cameras) {
    const tile = document.createElement('div');
    tile.className = 'cam-tile' + (cam.enabled ? '' : ' disabled') + (cam.facing === 'user' ? ' mirror' : '');
    const res = results?.find((r) => r.cam === cam);
    const entry = cams.open.get(cam.deviceId);
    if (entry) {
      tile.appendChild(entry.video);
      tile.insertAdjacentHTML('beforeend', '<span class="cam-dot" title="Live"></span>');
    } else {
      const msg = res && !res.ok ? `Cannot stream simultaneously.<br>Will capture sequentially.` : 'Not open';
      tile.insertAdjacentHTML('beforeend', `<div class="cam-error">${msg}</div>`);
      if (res && !res.ok) tile.classList.add('failed');
    }
    // Labels come from the operating system, so they are set as text rather than pasted
    // into markup
    tile.append(
      el('span', 'cam-label', cam.shortLabel || cam.label),
      el('span', 'cam-lens', LENS_TYPES[cam.lens]?.label || cam.lens),
    );
    tile.title = `${cam.label}\nTap to include/exclude`;
    tile.addEventListener('click', () => {
      cam.enabled = !cam.enabled;
      tile.classList.toggle('disabled', !cam.enabled);
    });
    grid.appendChild(tile);
    state.cameraTiles.set(cam.deviceId, tile);
  }
  $('#camera-count').textContent = cams.cameras.length;
  renderLensSettings();
}

async function startCameras() {
  const btn = $('#btn-start-cameras');
  btn.disabled = true;
  $('#camera-status').textContent = 'Requesting camera permission…';
  try {
    await cams.discover();
    if (cams.cameras.length === 0) throw new Error('No cameras found.');
    $('#camera-status').textContent = `Found ${cams.cameras.length} camera${cams.cameras.length > 1 ? 's' : ''}. Opening all of them…`;
    const results = await cams.openAll({ width: 1280, height: 720 });
    const live = results.filter((r) => r.ok).length;
    renderCameraTiles(results);
    const seq = results.length - live;
    $('#camera-status').textContent = `${live} camera${live === 1 ? '' : 's'} streaming live` + (seq ? `, ${seq} will be captured sequentially (the phone limits concurrent streams).` : '.');
    $('#btn-capture').disabled = live + seq === 0;
    btn.textContent = 'Re-scan cameras';
  } catch (err) {
    $('#camera-status').textContent = `Camera access failed: ${err.message}. You can still import photos below.`;
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
  }
}

let reopening = false;
async function reopenCameras() {
  if (reopening || !cams.cameras.length || $('#screen-capture').hidden) return;
  const missing = cams.cameras.filter((c) => c.enabled && !cams.open.has(c.deviceId));
  if (!missing.length) return;
  reopening = true;
  try {
    const results = [];
    for (const cam of missing) {
      try { results.push({ cam, ok: true, entry: await cams.openCamera(cam, { width: 1280, height: 720 }) }); }
      catch (err) { results.push({ cam, ok: false, error: err.message }); }
    }
    renderCameraTiles(results);
  } finally { reopening = false; }
}

function renderLensSettings() {
  const box = $('#lens-settings');
  if (!cams.cameras.length) { box.innerHTML = '<p class="muted">Enable cameras first.</p>'; return; }
  box.innerHTML = '';
  for (const cam of cams.cameras) {
    const row = document.createElement('div');
    row.className = 'lens-row';
    const name = el('span', '', cam.shortLabel || cam.label);
    name.title = cam.label;
    name.append(document.createElement('br'), el('span', 'muted', cam.label));
    const sel = document.createElement('select');
    for (const [k, v] of Object.entries(LENS_TYPES)) {
      const opt = new Option(v.label, k);
      opt.selected = cam.lens === k;
      sel.append(opt);
    }
    const num = document.createElement('input');
    Object.assign(num, { type: 'number', min: '20', max: '140', step: '1', value: String(Math.round(cam.hfovOverride || LENS_TYPES[cam.lens].hfov)) });
    const fov = el('label', 'muted', 'FOV° ');
    fov.append(num);
    row.append(name, sel, fov);
    sel.addEventListener('change', () => {
      cam.lens = sel.value; cam.hfovOverride = null; num.value = LENS_TYPES[cam.lens].hfov;
      saveLensOverride(cam.key, cam.lens, null);
      const tile = state.cameraTiles.get(cam.deviceId);
      if (tile) tile.querySelector('.cam-lens').textContent = LENS_TYPES[cam.lens].label;
    });
    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (v >= 20 && v <= 140) { cam.hfovOverride = v; saveLensOverride(cam.key, cam.lens, v); }
    });
    box.appendChild(row);
  }
}

// ---------- Shots ----------
/** Sharpness of a captured frame, measured on a small copy so it costs nothing. */
function measureSharpness(canvas) {
  const t = document.createElement('canvas');
  const s = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
  t.width = Math.max(16, Math.round(canvas.width * s));
  t.height = Math.max(16, Math.round(canvas.height * s));
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  const data = ctx.getImageData(0, 0, t.width, t.height).data;
  return sharpness(rgbaToGray(data, t.width, t.height), t.width, t.height);
}

function makeThumb(canvas) {
  const t = document.createElement('canvas');
  const s = 168 / Math.max(canvas.width, canvas.height);
  t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}
function canvasToBlob(canvas, q = 0.92) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', q));
}

async function captureShot() {
  const btn = $('#btn-capture');
  if (btn.disabled) return;
  btn.disabled = true; btn.classList.add('busy');
  const flash = $('#flash'); flash.hidden = false; setTimeout(() => { flash.hidden = true; }, 260);
  try {
    const maxDim = parseInt($('#capture-res').value, 10);
    const grabbed = await cams.captureAll({ maxDim, sequentialFallback: $('#chk-sequential').checked, onStatus: (m) => { $('#camera-status').textContent = m; } });
    if (!grabbed.length) { toast('No camera frames captured'); return; }
    const frames = [];
    for (const g of grabbed) {
      const blob = await canvasToBlob(g.canvas);
      frames.push({ blob, thumbUrl: makeThumb(g.canvas), width: g.width, height: g.height, f: g.f, cx: g.cx, cy: g.cy, label: g.cameraLabel, lens: g.lens, key: g.cameraKey, hfov: g.hfov, sharpness: measureSharpness(g.canvas) });
    }
    const shot = { id: `shot-${Date.now()}`, createdAt: Date.now(), frames };
    state.shots.push(shot);
    store.saveShot(shot);
    flagSoftFrames();
    renderShots(); updateCounts();
    const blurry = frames.filter((f) => f.soft).length;
    if (blurry) toast(`${blurry === frames.length ? 'That shot looks' : `${blurry} of those frames look`} blurry. Hold still and shoot again.`, 4000);
    if (navigator.vibrate) navigator.vibrate(15);
    $('#camera-status').textContent = `Shot ${state.shots.length}: ${frames.length} frame${frames.length === 1 ? '' : 's'} from ${frames.map((f) => f.label).join(', ')}.`;
  } catch (err) {
    toast(`Capture failed: ${err.message}`, 5000);
  } finally {
    btn.disabled = false; btn.classList.remove('busy');
  }
}

async function importFiles(files) {
  if (!files.length) return;
  const frames = [];
  for (const file of files) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
      const maxDim = Math.max(parseInt($('#capture-res').value, 10), 1280);
      const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * s); canvas.height = Math.round(bmp.height * s);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      const exif = await readExifFov(file);
      const lens = 'unknown';
      const intr = intrinsicsFor({ lens, hfovOverride: exif?.hfov || null }, canvas.width, canvas.height, 1);
      frames.push({ blob: await canvasToBlob(canvas), thumbUrl: makeThumb(canvas), width: canvas.width, height: canvas.height, ...intr, label: file.name.replace(/\.[^.]+$/, '').slice(0, 14), lens: exif ? `${exif.focal35}mm eq.` : lens, key: 'import', sharpness: measureSharpness(canvas) });
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`);
    }
  }
  // Each imported photo is its own shot (taken at a different time/position)
  for (const fr of frames) {
    const shot = { id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), frames: [fr] };
    state.shots.push(shot);
    store.saveShot(shot);
  }
  flagSoftFrames();
  renderShots(); updateCounts();
  const blurry = state.shots.flatMap((sh) => sh.frames).filter((f) => f.soft).length;
  toast(`Imported ${frames.length} photo${frames.length === 1 ? '' : 's'}` + (blurry ? ` · ${blurry === 1 ? 'one looks' : `${blurry} look`} blurry` : ''));
}

function renderShots() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.shots.forEach((shot, i) => {
    const row = document.createElement('div');
    row.className = 'shot';
    const del = el('button', 'shot-delete', '×');
    del.title = 'Delete shot'; del.setAttribute('aria-label', 'Delete shot');
    row.append(el('span', 'shot-index', String(i + 1)), el('div', 'shot-frames'), del);
    const fr = row.querySelector('.shot-frames');
    for (const f of shot.frames) {
      // Labels come from file names, so nothing here is built by pasting into markup
      const thumb = el('div', 'thumb' + (f.used === false ? ' unused' : ''));
      const img = document.createElement('img');
      img.src = f.thumbUrl; img.alt = f.label;
      thumb.append(img, el('span', 'thumb-label', f.label));
      if (f.soft) {
        const flag = el('span', 'thumb-flag warn', 'blurry');
        flag.title = 'This frame is much blurrier than the others. Retaking it will help.';
        thumb.append(flag);
      }
      if (f.used === false) {
        const flag = el('span', 'thumb-flag bad', 'unused');
        flag.title = 'This frame could not be placed in the model.';
        thumb.append(flag);
      }
      fr.append(thumb);
    }
    row.querySelector('.shot-delete').addEventListener('click', () => { store.deleteShot(shot.id); state.shots.splice(i, 1); renderShots(); updateCounts(); });
    box.appendChild(row);
  });
}

/** Mark frames that are much softer than the others taken with the same camera. */
function flagSoftFrames() {
  const all = state.shots.flatMap((sh) => sh.frames).filter((f) => typeof f.sharpness === 'number');
  if (all.length < 3) return;
  markSoftFrames(all);
}

async function restoreShots() {
  const saved = await store.loadAll();
  if (!saved.length) return;
  state.shots = saved.map((r) => ({ id: r.id, createdAt: r.createdAt, frames: r.frames }));
  renderShots(); updateCounts();
  toast(`Restored ${saved.length} shot${saved.length === 1 ? '' : 's'} from your previous session`, 4000);
}

// ---------- Reconstruction ----------
async function decodeForWorker(frame, targetWidth, id, shotIndex) {
  const bmp = await createImageBitmap(frame.blob);
  const s = Math.min(1, targetWidth / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, w, h).data;
  const sx = w / frame.width, sy = h / frame.height;
  return { id, label: frame.label, width: w, height: h, rgba: data, f: frame.f * sx, cx: (frame.cx + 0.5) * sx - 0.5, cy: (frame.cy + 0.5) * sy - 0.5, shotIndex, focalGroup: `${frame.key}|${Math.round(frame.hfov || 0)}`, rigKey: frame.key };
}

let wakeLock = null;
async function holdWakeLock() {
  try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed or unsupported */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

async function reconstruct() {
  if (frameCount() < 2) return;
  showScreen('process');
  holdWakeLock();
  const log = $('#progress-log'); log.textContent = '';
  const setBuilding = (stage, pct, msg) => {
    if ($('#screen-view').hidden) return;
    $('#building').hidden = false;
    $('#building-stage').textContent = stage;
    $('#building-detail').textContent = msg || '';
    $('#building-bar').style.width = pct + '%';
  };
  const setProgress = (stage, frac, msg) => {
    const names = { features: 'Finding features', matching: 'Matching images', sfm: 'Solving camera positions', depth: 'Computing depth maps', fusion: 'Fusing into a volume', mesh: 'Extracting the mesh', done: 'Done' };
    const order = ['features', 'matching', 'sfm', 'depth', 'fusion', 'mesh', 'done'];
    const weights = [0.15, 0.2, 0.1, 0.4, 0.1, 0.05, 0];
    if (stage === 'log') { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; return; }
    const idx = order.indexOf(stage);
    let base = 0; for (let i = 0; i < idx; i++) base += weights[i];
    const pct = Math.min(100, Math.round(100 * (base + (frac || 0) * (weights[idx] || 0))));
    $('#progress-bar').style.width = pct + '%';
    $('#progress-stage').textContent = names[stage] || stage;
    if (msg) { $('#progress-message').textContent = msg; log.textContent += `[${stage}] ${msg}\n`; log.scrollTop = log.scrollHeight; }
    setBuilding(names[stage] || stage, pct, msg);
  };
  state.failed = false;
  state.result = null;
  setResultControlsEnabled(false);
  const quality = $('#quality').value;
  const targetWidth = QUALITY[quality].featureWidth;
  setProgress('features', 0, 'Decoding photos…');
  const images = [];
  let k = 0;
  for (let s = 0; s < state.shots.length; s++) {
    for (const fr of state.shots[s].frames) {
      images.push(await decodeForWorker(fr, targetWidth, `img-${k++}`, s));
    }
  }
  if (state.worker) state.worker.terminate();
  const worker = new Worker(new URL('./pipeline/worker.js', import.meta.url), { type: 'module' });
  state.worker = worker;
  const t0 = performance.now();
  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === 'progress') setProgress(m.stage, m.fraction, m.message);
    else if (m.type === 'preview') await showPreview(m);
    else if (m.type === 'error') { reportFailure(m.message); } else if (m.type === 'done') {
      if (state.failed) return;
      releaseWakeLock();
      $('#building').hidden = true;
      state.result = m.result;
      await showResult(m.result, (performance.now() - t0) / 1000);
    }
  };
  worker.onerror = (e) => reportFailure(e.message || 'The reconstruction stopped unexpectedly');
  worker.postMessage({ type: 'run', images, options: { quality, preset: state.preset, gpu: $('#chk-gpu').checked, useRig: $('#chk-rig').checked } }, images.map((im) => im.rgba.buffer));
}

/**
 * Show a failure wherever the user is looking. Once the preview is up they are on the viewer
 * screen, so writing only to the processing screen would leave a build bar running forever.
 */
function reportFailure(message) {
  state.failed = true;
  releaseWakeLock();
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  setProgressLog('ERROR: ' + message);
  $('#progress-stage').textContent = 'Reconstruction failed';
  $('#progress-message').textContent = message;
  $('#btn-cancel').textContent = 'Back';
  if ($('#screen-view').hidden) {
    showScreen('process');
  } else {
    // The preview is on screen: say so there, and leave it up so the camera path stays visible
    $('#building').hidden = false;
    $('#building-stage').textContent = 'Could not build the surface';
    $('#building-detail').textContent = message;
    $('#building-bar').style.width = '100%';
    $('#btn-cancel-build').textContent = 'Back';
  }
  toast(message, 6000);
}

/** Controls that need a finished surface are off while only a preview is on screen. */
function setResultControlsEnabled(on) {
  for (const sel of ['#btn-export-glb', '#btn-export-ply', '#btn-export-obj', '#btn-export-points', '#btn-share', '#btn-measure']) {
    const button = $(sel);
    if (button) button.disabled = !on;
  }
  if (!on) {
    state.metresPerUnit = null;
    state.measuredUnits = 0;
    $('#measure').hidden = true;
    $('#measure-entry').hidden = true;
    $('#btn-measure').classList.remove('active');
    state.viewer?.setMeasuring(false);
  }
  for (const b of $('#view-mode').querySelectorAll('button')) b.disabled = !on;
}

/** Show the camera path and sparse points while the surface is still being built. */
async function showPreview(m) {
  // Loading the viewer is asynchronous, so a failure can arrive while this is still waiting.
  // Whoever loses that race must not paint over the other's screen.
  if (state.failed) return;
  if (!(await ensureViewer()) || state.failed) return;
  showScreen('view');
  $('#building').hidden = false;
  $('#building-stage').textContent = 'Building the surface…';
  $('#building-detail').textContent = m.message || '';
  setResultControlsEnabled(false);
  state.viewer.setPreview({ sparse: m.sparse, cameras: m.cameras });
  state.viewer.setLayer('cameras', $('#chk-cameras').checked);
  state.viewer.setLayer('grid', $('#chk-grid').checked);
  $('#chk-points').checked = true;
  setProgressLog(`Preview: ${m.message}`);
}

let viewerPromise = null;
async function ensureViewer() {
  if (state.viewer) return true;
  // Guard against two callers racing: the preview and the finished result can arrive close
  // together, and building two viewers would leak a WebGL context and stack two canvases.
  if (!viewerPromise) {
    viewerPromise = (async () => {
      try {
        const { Viewer } = await import('./viewer/viewer.js');
        state.viewer = new Viewer($('#viewer'));
        state.viewer.onMeasure = (distance, count) => {
          state.measuredUnits = distance || 0;
          $('#measure-entry').hidden = !distance;
          if (distance) {
            const known = state.metresPerUnit ? ` — currently ${formatLength(distance * state.metresPerUnit)}` : '';
            $('#measure-hint').textContent = `Two points picked${known}. Enter how far apart they really are.`;
          } else if (count === 1) {
            $('#measure-hint').textContent = 'One point picked. Tap the second.';
          } else {
            updateScaleReadout();
          }
        };
        return true;
      } catch {
        toast('3D viewer could not load. You can still download the mesh.', 6000);
        return false;
      }
    })();
  }
  return viewerPromise;
}

async function showResult(result, seconds) {
  await ensureViewer();
  showScreen('view');
  $('#building').hidden = true;
  setResultControlsEnabled(true);
  if (state.viewer) {
    state.viewer.setResult(result);
    state.viewer.setLayer('points', $('#chk-points').checked);
    state.viewer.setLayer('cameras', $('#chk-cameras').checked);
    state.viewer.setLayer('grid', $('#chk-grid').checked);
  }
  const s = result.stats;
  if (s.frames) {
    const byId = new Map(s.frames.map((f) => [f.id, f]));
    let k2 = 0;
    for (const shot of state.shots) for (const f of shot.frames) {
      const info = byId.get(`img-${k2++}`);
      if (info) { f.used = info.used; f.soft = info.soft; }
    }
    renderShots();
    const unused = s.frames.filter((f) => !f.used);
    if (unused.length) setProgressLog(`Not placed in the model: ${unused.map((f) => f.label || f.id).join(', ')}`);
  }
  state.stats = { ...s, seconds };
  updateStatsLine();
  if (s.rig?.length) {
    setProgressLog(`Camera rig: ` + s.rig.map((r2) => `${r2.camera} tied to the reference camera from ${r2.shots} shots (${r2.spreadDeg.toFixed(1)}° spread)`).join('; '));
  }
  if (s.intrinsics?.length) {
    const byLabel = new Map();
    for (const it of s.intrinsics) if (!byLabel.has(it.label)) byLabel.set(it.label, it);
    setProgressLog(`Calibrated intrinsics: ` + Array.from(byLabel.values()).map((it) => `${it.label}: f=${it.focalPx.toFixed(0)}px, k1=${it.k1.toFixed(3)}`).join('; '));
  }
  $('#btn-share').hidden = !(navigator.canShare);
}

function setProgressLog(line) {
  const log = $('#progress-log');
  log.textContent += line + '\n';
}

/**
 * A copy of the mesh scaled into metres, when the user has given a real distance. glTF is
 * defined in metres, so a scan with a known scale opens at its true size everywhere.
 */
function scaledGeometry(geometry) {
  const k = state.metresPerUnit;
  if (!k || !Number.isFinite(k) || k <= 0) return geometry;
  const positions = Float32Array.from(geometry.positions);
  for (let i = 0; i < positions.length; i++) positions[i] *= k;
  return { ...geometry, positions };
}

function formatLength(metres) {
  if (metres >= 1) return `${metres.toFixed(2)} m`;
  if (metres >= 0.01) return `${(metres * 100).toFixed(1)} cm`;
  return `${(metres * 1000).toFixed(0)} mm`;
}

/** Size of the model along each axis, in metres if the scale is known. */
function modelDimensions() {
  const p = state.result?.mesh.positions;
  if (!p || !p.length) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return [0, 1, 2].map((k) => (max[k] - min[k]) * (state.metresPerUnit || 1));
}

function updateStatsLine() {
  const s = state.stats;
  if (!s) return;
  const dims = modelDimensions();
  const size = dims
    ? `<span>${state.metresPerUnit ? dims.map(formatLength).join(' × ') : 'scale not set'}</span>`
    : '';
  $('#stats').innerHTML = `<span><b>${s.registered}</b>/${s.images} images used</span>`
    + `<span><b>${s.triangles.toLocaleString()}</b> triangles</span>`
    + `<span><b>${s.vertices.toLocaleString()}</b> vertices</span>`
    + `<span><b>${s.sparsePoints}</b> sparse · <b>${(s.densePoints || 0).toLocaleString()}</b> dense points</span>`
    + `<span><b>${s.seconds.toFixed(0)}s</b></span>` + size;
}

function updateScaleReadout() {
  const dims = modelDimensions();
  const hint = $('#measure-hint');
  hint.textContent = '';
  if (state.metresPerUnit && dims) {
    hint.append(
      el('span', 'scale-set', 'Scale set.'),
      ` The model is ${dims.map(formatLength).join(' × ')} (width × height × depth). `
      + 'Downloads are now in metres. Tap two points to measure again.',
    );
  } else {
    hint.textContent = 'Tap two points on the model that span something you know the size of, such as a door or a table edge.';
  }
}

function download(name, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportName(ext) { return `phonogeometry-${state.preset}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`; }

// ---------- Wiring ----------
function init() {
  $('#preset').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (!b) return;
    state.preset = b.dataset.preset;
    $('#preset').querySelectorAll('button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', x === b); });
    $('#preset-tip').textContent = PRESET_TIPS[state.preset];
  });
  $('#btn-start-cameras').addEventListener('click', startCameras);
  $('#quality').addEventListener('change', updateCounts);
  $('#btn-capture').addEventListener('click', captureShot);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (e) => { importFiles(Array.from(e.target.files)); e.target.value = ''; });
  $('#btn-clear').addEventListener('click', () => { if (!state.shots.length || confirm('Delete all shots?')) { state.shots = []; store.clear(); renderShots(); updateCounts(); } });
  $('#btn-reconstruct').addEventListener('click', reconstruct);
  const stopBuild = () => {
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    releaseWakeLock();
    $('#building').hidden = true;
    $('#btn-cancel').textContent = 'Cancel';
    $('#btn-cancel-build').textContent = 'Stop';
    showScreen('capture');
  };
  $('#btn-cancel').addEventListener('click', stopBuild);
  $('#btn-cancel-build').addEventListener('click', stopBuild);
  $('#btn-settings').addEventListener('click', () => $('#settings').showModal());
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  $('#view-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    $('#view-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    state.viewer?.setMode(b.dataset.mode);
  });
  $('#chk-points').addEventListener('change', (e) => state.viewer?.setLayer('points', e.target.checked));
  $('#chk-cameras').addEventListener('change', (e) => state.viewer?.setLayer('cameras', e.target.checked));
  $('#chk-grid').addEventListener('change', (e) => state.viewer?.setLayer('grid', e.target.checked));
  $('#btn-fit').addEventListener('click', () => state.viewer?.fit());
  $('#btn-measure').addEventListener('click', () => {
    const on = !$('#btn-measure').classList.contains('active');
    $('#btn-measure').classList.toggle('active', on);
    $('#measure').hidden = !on;
    state.viewer?.setMeasuring(on);
    if (on) updateScaleReadout();
  });
  $('#btn-measure-apply').addEventListener('click', () => {
    const real = parseFloat($('#measure-value').value) * parseFloat($('#measure-unit').value);
    if (!(real > 0) || !(state.measuredUnits > 0)) { toast('Tap two points first, then enter how far apart they really are.'); return; }
    state.metresPerUnit = real / state.measuredUnits;
    updateScaleReadout();
    updateStatsLine();
    toast('Scale set. Downloads are now in metres.', 4000);
  });
  $('#btn-measure-clear').addEventListener('click', () => {
    state.metresPerUnit = null;
    state.viewer?.clearMeasurement();
    $('#measure-value').value = '';
    updateScaleReadout();
    updateStatsLine();
  });
  $('#btn-export-glb').addEventListener('click', () => state.result && download(exportName('glb'), toGLB(scaledGeometry(state.result.mesh)), 'model/gltf-binary'));
  $('#btn-export-ply').addEventListener('click', () => state.result && download(exportName('ply'), toPLY(scaledGeometry(state.result.mesh)), 'application/octet-stream'));
  $('#btn-export-obj').addEventListener('click', () => state.result && download(exportName('obj'), toOBJ(scaledGeometry(state.result.mesh)), 'text/plain'));
  $('#btn-export-points').addEventListener('click', () => state.result?.dense && download(exportName('points.ply'), toPointCloudPLY(scaledGeometry(state.result.dense)), 'application/octet-stream'));
  $('#btn-share').addEventListener('click', async () => {
    if (!state.result) return;
    const file = new File([toGLB(scaledGeometry(state.result.mesh))], exportName('glb'), { type: 'model/gltf-binary' });
    try { if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Phonogeometry scan' }); else toast('Sharing files is not supported here'); } catch { /* cancelled */ }
  });
  $('#btn-back-capture').addEventListener('click', () => showScreen('capture'));
  $('#btn-new-scan').addEventListener('click', () => { if (confirm('Start a new scan? Current shots and mesh will be discarded.')) { state.shots = []; state.result = null; store.clear(); renderShots(); updateCounts(); showScreen('capture'); } });
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !$('#screen-capture').hidden && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); captureShot(); } });
  window.addEventListener('pagehide', () => cams.closeAll());
  // Phones stop camera streams when the tab is hidden; reopen them when it comes back.
  cams.addEventListener('ended', () => { if (document.visibilityState === 'visible') reopenCameras(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reopenCameras(); });
  updateCounts();
  restoreShots();

  if (!cams.supported) $('#camera-status').textContent = 'Camera access is not available in this browser or over an insecure (http) connection. You can still import photos.';
  // A secure context, not specifically https: browsers count http://localhost as secure, which
  // is how the app is developed and tested.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable:', err.message));
  }
}

init();
