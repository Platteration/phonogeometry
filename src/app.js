// Phonogeometry app controller: capture from all cameras -> reconstruct in a worker -> view/export.
import { CameraManager } from './camera/cameraManager.js';
import { LENS_TYPES, saveLensOverride, intrinsicsFor } from './camera/intrinsics.js';
import { readExifFov } from './camera/exif.js';
import { QUALITY } from './pipeline/reconstruct.js';
import { toGLB, toPLY, toOBJ } from './mesh/exporters.js';
import { ShotStore } from './storage.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  preset: 'object',
  shots: [], // {id, frames: [{blob, thumbUrl, width, height, f, cx, cy, label, lens, key}]}
  worker: null,
  result: null,
  viewer: null,
  cameraTiles: new Map(),
};
const cams = new CameraManager();
const store = new ShotStore();

const PRESET_TIPS = {
  object: 'Walk slowly around the object and capture every 20–30° with plenty of overlap. Aim for 12–30 shots.',
  person: 'Ask the person to stand still. Circle them at chest height and capture every 20–30°; add a higher and a lower pass for the head and legs.',
  room: 'Stand near the middle of the room. Capture, step sideways about a metre, capture again; go around the room twice at two heights. Front and back cameras fire together, so each shot covers both walls.',
};

// ---------- UI helpers ----------
let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
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
  $('#frame-count').textContent = n ? `· ${n} frames` : '';
  $('#btn-reconstruct').disabled = n < 2;
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
    tile.insertAdjacentHTML('beforeend', `<span class="cam-label">${cam.shortLabel || cam.label}</span><span class="cam-lens">${LENS_TYPES[cam.lens]?.label || cam.lens}</span>`);
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

function renderLensSettings() {
  const box = $('#lens-settings');
  if (!cams.cameras.length) { box.innerHTML = '<p class="muted">Enable cameras first.</p>'; return; }
  box.innerHTML = '';
  for (const cam of cams.cameras) {
    const row = document.createElement('div');
    row.className = 'lens-row';
    const opts = Object.entries(LENS_TYPES).map(([k, v]) => `<option value="${k}" ${cam.lens === k ? 'selected' : ''}>${v.label}</option>`).join('');
    row.innerHTML = `<span title="${cam.label}">${cam.shortLabel || cam.label}<br><span class="muted">${cam.label}</span></span><select>${opts}</select><label class="muted">FOV° <input type="number" min="20" max="140" step="1" value="${Math.round(cam.hfovOverride || LENS_TYPES[cam.lens].hfov)}"></label>`;
    const sel = row.querySelector('select'), num = row.querySelector('input');
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
      frames.push({ blob, thumbUrl: makeThumb(g.canvas), width: g.width, height: g.height, f: g.f, cx: g.cx, cy: g.cy, label: g.cameraLabel, lens: g.lens, key: g.cameraKey, hfov: g.hfov });
    }
    const shot = { id: `shot-${Date.now()}`, createdAt: Date.now(), frames };
    state.shots.push(shot);
    store.saveShot(shot);
    renderShots(); updateCounts();
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
      frames.push({ blob: await canvasToBlob(canvas), thumbUrl: makeThumb(canvas), width: canvas.width, height: canvas.height, ...intr, label: file.name.replace(/\.[^.]+$/, '').slice(0, 14), lens: exif ? `${exif.focal35}mm eq.` : lens, key: 'import' });
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
  renderShots(); updateCounts();
  toast(`Imported ${frames.length} photo${frames.length === 1 ? '' : 's'}`);
}

function renderShots() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.shots.forEach((shot, i) => {
    const row = document.createElement('div');
    row.className = 'shot';
    row.innerHTML = `<span class="shot-index">${i + 1}</span><div class="shot-frames"></div><button class="shot-delete" title="Delete shot" aria-label="Delete shot">×</button>`;
    const fr = row.querySelector('.shot-frames');
    for (const f of shot.frames) {
      fr.insertAdjacentHTML('beforeend', `<div class="thumb"><img src="${f.thumbUrl}" alt="${f.label}"><span class="thumb-label">${f.label}</span></div>`);
    }
    row.querySelector('.shot-delete').addEventListener('click', () => { store.deleteShot(shot.id); state.shots.splice(i, 1); renderShots(); updateCounts(); });
    box.appendChild(row);
  });
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
  return { id, label: frame.label, width: w, height: h, rgba: data, f: frame.f * sx, cx: (frame.cx + 0.5) * sx - 0.5, cy: (frame.cy + 0.5) * sy - 0.5, shotIndex, focalGroup: `${frame.key}|${Math.round(frame.hfov || 0)}` };
}

async function reconstruct() {
  if (frameCount() < 2) return;
  showScreen('process');
  const log = $('#progress-log'); log.textContent = '';
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
  };
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
    else if (m.type === 'error') {
      setProgress('log', null, 'ERROR: ' + m.message);
      $('#progress-stage').textContent = 'Reconstruction failed';
      $('#progress-message').textContent = m.message;
      toast(m.message, 6000);
      $('#btn-cancel').textContent = 'Back';
    } else if (m.type === 'done') {
      state.result = m.result;
      await showResult(m.result, (performance.now() - t0) / 1000);
    }
  };
  worker.onerror = (e) => { toast('Worker error: ' + e.message, 6000); $('#progress-stage').textContent = 'Reconstruction failed'; $('#btn-cancel').textContent = 'Back'; };
  worker.postMessage({ type: 'run', images, options: { quality, preset: state.preset } }, images.map((im) => im.rgba.buffer));
}

async function showResult(result, seconds) {
  if (!state.viewer) {
    try {
      const { Viewer } = await import('./viewer/viewer.js');
      state.viewer = new Viewer($('#viewer'));
    } catch (err) {
      toast('3D viewer could not load (offline?). You can still download the mesh.', 6000);
    }
  }
  showScreen('view');
  if (state.viewer) {
    state.viewer.setResult(result);
    state.viewer.setLayer('points', $('#chk-points').checked);
    state.viewer.setLayer('cameras', $('#chk-cameras').checked);
    state.viewer.setLayer('grid', $('#chk-grid').checked);
  }
  const s = result.stats;
  $('#stats').innerHTML = `<span><b>${s.registered}</b>/${s.images} images used</span><span><b>${s.triangles.toLocaleString()}</b> triangles</span><span><b>${s.vertices.toLocaleString()}</b> vertices</span><span><b>${s.sparsePoints}</b> sparse points</span><span><b>${seconds.toFixed(0)}s</b></span>`;
  $('#btn-share').hidden = !(navigator.canShare);
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
  $('#btn-capture').addEventListener('click', captureShot);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (e) => { importFiles(Array.from(e.target.files)); e.target.value = ''; });
  $('#btn-clear').addEventListener('click', () => { if (!state.shots.length || confirm('Delete all shots?')) { state.shots = []; store.clear(); renderShots(); updateCounts(); } });
  $('#btn-reconstruct').addEventListener('click', reconstruct);
  $('#btn-cancel').addEventListener('click', () => { if (state.worker) { state.worker.terminate(); state.worker = null; } $('#btn-cancel').textContent = 'Cancel'; showScreen('capture'); });
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
  $('#btn-export-glb').addEventListener('click', () => state.result && download(exportName('glb'), toGLB(state.result.mesh), 'model/gltf-binary'));
  $('#btn-export-ply').addEventListener('click', () => state.result && download(exportName('ply'), toPLY(state.result.mesh), 'application/octet-stream'));
  $('#btn-export-obj').addEventListener('click', () => state.result && download(exportName('obj'), toOBJ(state.result.mesh), 'text/plain'));
  $('#btn-share').addEventListener('click', async () => {
    if (!state.result) return;
    const file = new File([toGLB(state.result.mesh)], exportName('glb'), { type: 'model/gltf-binary' });
    try { if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Phonogeometry scan' }); else toast('Sharing files is not supported here'); } catch { /* cancelled */ }
  });
  $('#btn-back-capture').addEventListener('click', () => showScreen('capture'));
  $('#btn-new-scan').addEventListener('click', () => { if (confirm('Start a new scan? Current shots and mesh will be discarded.')) { state.shots = []; state.result = null; store.clear(); renderShots(); updateCounts(); showScreen('capture'); } });
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !$('#screen-capture').hidden && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); captureShot(); } });
  window.addEventListener('pagehide', () => cams.closeAll());
  updateCounts();
  restoreShots();

  if (!cams.supported) $('#camera-status').textContent = 'Camera access is not available in this browser or over an insecure (http) connection. You can still import photos.';
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
