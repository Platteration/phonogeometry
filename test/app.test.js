// The decisions app.js makes on the way in and out of the capture screen: what the user is
// told about photographs that were deleted while they were away, what a dark camera tile is
// allowed to claim, and what happens to a lens that comes up after the screen it belongs to
// has gone. Each of these was a bug that a browser test did not catch, because each is about
// a case the happy path never reaches.
//
// app.js runs its own init() on import, so every test imports it under a fresh query string
// to get a fresh instance against freshly installed globals.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, uninstallFakeDom } from './fakeDom.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The database ShotStore expects, seeded with records written the way saveShot writes them. */
function installFakeIndexedDb(records) {
  const written = new Map(records.map((r) => [r.id, r]));
  const db = {
    written,
    objectStoreNames: { contains: () => true },
    transaction() {
      const t = {
        objectStore: () => ({
          put: (record) => { written.set(record.id, record); return { result: record.id }; },
          getAll: () => ({ result: Array.from(written.values()) }),
          delete: (id) => { written.delete(id); return { result: undefined }; },
          clear: () => { written.clear(); return { result: undefined }; },
        }),
      };
      queueMicrotask(() => t.oncomplete());
      return t;
    },
  };
  globalThis.indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess(); }); return req; } };
  return db;
}

/** A phone whose lenses can be told to misbehave, one at a time. See test/camera.test.js. */
function installFakePhone(lenses) {
  const ids = Object.keys(lenses);
  const streams = [];
  const makeStream = (deviceId) => {
    const track = {
      stopped: false,
      stop() { this.stopped = true; },
      addEventListener() {},
      getSettings: () => ({ width: 640, height: 480, facingMode: deviceId.startsWith('front') ? 'user' : 'environment' }),
    };
    const stream = { deviceId, track, getTracks: () => [track], getVideoTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async enumerateDevices() {
          return ids.map((deviceId) => ({ kind: 'videoinput', deviceId, groupId: 'g', label: lenses[deviceId].label || deviceId }));
        },
        async getUserMedia(constraints) {
          const deviceId = constraints?.video?.deviceId?.exact;
          if (!deviceId) return makeStream(ids[0]);   // the permission probe in discover()
          const lens = lenses[deviceId];
          lens.onOpen?.();
          if (lens.grantDelayMs) await sleep(lens.grantDelayMs);
          if (lens.deny) throw new DOMException('Permission denied', 'NotAllowedError');
          if (lens.busy) throw new DOMException('Could not start video source', 'NotReadableError');
          return makeStream(deviceId);
        },
      },
    },
  });
  return { streams, lenses, streamFor: (id) => streams.find((s) => s.deviceId === id) };
}

let instance = 0;
/** Start the app against a fresh document, database and phone. */
async function launchApp({ lenses = {}, records = [], stored = {}, framed = false } = {}) {
  const dom = installFakeDom({ stored });
  // Inside another page's frame `top` is that page's window, not this one.
  if (framed) Object.assign(dom.window, { self: dom.window, top: { another: 'page' } });
  const database = installFakeIndexedDb(records);
  const phone = installFakePhone(lenses);
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag) => {
    const node = createElement(tag);
    // A <video> handed a stream starts delivering frames, which is what openCamera waits for.
    if (tag === 'video') node.play = function play() { this.readyState = 4; this.videoWidth = 640; return Promise.resolve(); };
    return node;
  };
  dom.$('#chk-sequential').checked = true;
  dom.$('#capture-res').value = '1280';
  dom.$('#quality').value = 'fast';
  await import(`../src/app.js?instance=${++instance}`);
  await sleep(20);   // restoreShots is asynchronous and runs from init()
  return { ...dom, phone, database };
}

afterEach(() => {
  uninstallFakeDom();
  delete globalThis.indexedDB;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
});

const hour = 60 * 60 * 1000;
const shotRecord = (id, ageMs) => ({ id, createdAt: Date.now() - ageMs, frames: [{ thumbUrl: 'data:,', width: 4, height: 4, label: id }] });

test('a restore that deleted everything still says so', async () => {
  // The person whose photographs were deleted is the one person who cannot tell that from a
  // bug: they get an empty capture screen and a shot count of zero. The sentence explaining
  // the rule used to sit after an early return taken when nothing survived — so it reached
  // only the users who had lost nothing.
  const { $, database } = await launchApp({ records: [shotRecord('old-1', 25 * hour), shotRecord('old-2', 30 * hour)] });
  assert.equal($('#shot-count').textContent, '0');
  const said = $('#toast').textContent;
  assert.match(said, /2 shots from more than a day ago were deleted/);
  assert.equal($('#toast').hidden, false);
  assert.equal(database.written.size, 0, 'and they really are off the disk, not merely hidden');
});

test('a restore says what came back and what went', async () => {
  const { $ } = await launchApp({ records: [shotRecord('old', 26 * hour), shotRecord('fresh', 2 * hour)] });
  assert.equal($('#shot-count').textContent, '1');
  const said = $('#toast').textContent;
  assert.match(said, /Restored 1 shot from your previous session/);
  assert.match(said, /1 shot from more than a day ago was deleted/);
  assert.match(said, /until they are a day old/);
});

// One record the app cannot show (a page elsewhere on a shared origin can write this database)
// used to stop the restore at the shot list: a count of 0, Build off, and every capture after
// it failing while still saving the shot it took.
test('a record the app cannot show is left out, said, and the rest of the restore goes on', async () => {
  const { $, database } = await launchApp({
    records: [
      shotRecord('fresh', 2 * hour),
      { id: 'no-list', createdAt: Date.now() - hour, frames: null },
      { id: 'no-frames', createdAt: Date.now() - hour, frames: [null, 5] },
    ],
  });
  assert.equal($('#shot-count').textContent, '1');
  assert.equal($('#frame-count').textContent, '1 frames · at least 3 needed');
  const said = $('#toast').textContent;
  assert.match(said, /Restored 1 shot from your previous session/);
  assert.match(said, /2 saved shots could not be read and were left out/);
  assert.equal(database.written.size, 3, 'left out of the list, not deleted from the disk');
});

// GitHub Pages cannot send frame-ancestors, so there any site can frame the page; in a browser
// that does not partition a frame's storage the frame opens the visitor's own shots, and a
// click steered onto a shot's x deletes it. The app does not start in a frame at all.
test('inside another page\'s frame the app restores nothing and wires nothing', async () => {
  const { $, document } = await launchApp({ framed: true, records: [shotRecord('fresh', hour)] });
  assert.equal($('#shot-count').textContent, '', 'no shots restored into the frame');
  assert.equal($('#thumbs').childNodes.length, 0, 'no shot, so no x to steer a click onto');
  assert.equal(document.documentElement.classList.contains('started'), false, 'and the safety net is left to say why');

  // The same launch outside a frame restores the shot, so the check above is the frame's doing.
  const top = await launchApp({ records: [shotRecord('fresh', hour)] });
  assert.equal(top.$('#shot-count').textContent, '1');
});

// The same, by a field rather than the list: one frame whose label cannot be set as text (an
// object whose toString is not a function survives the database's structured clone) threw out
// of the shot list on every launch, and one record whose date is not a number threw out of the
// restore itself, which then restored nothing at all and said nothing.
test('a stored label or date that is not what the app writes costs no other shot', async () => {
  const hostile = { toString: 0 };
  const { $, database } = await launchApp({
    records: [
      shotRecord('fresh', 2 * hour),
      { id: 'odd-label', createdAt: Date.now() - hour, frames: [{ thumbUrl: hostile, width: 4, height: 4, label: hostile }] },
      { id: 'odd-date', createdAt: hostile, frames: [{ thumbUrl: 'data:,', width: 4, height: 4, label: 'odd-date' }] },
    ],
  });
  assert.equal($('#shot-count').textContent, '2', 'the shot with the odd label is listed, without it');
  assert.deepEqual($('#thumbs').querySelectorAll('.thumb-label').map((n) => n.textContent), ['fresh', '']);
  const said = $('#toast').textContent;
  assert.match(said, /Restored 2 shots from your previous session/);
  assert.match(said, /1 shot from more than a day ago was deleted/, 'a record with no date to judge goes as an old one does');
  assert.deepEqual(Array.from(database.written.keys()).sort(), ['fresh', 'odd-label']);
});

test('a restore with nothing to say says nothing', async () => {
  const { $ } = await launchApp({ records: [] });
  assert.equal($('#toast').textContent, '');
});

test('a camera that is not open for its own reason does not promise a sequential capture', async () => {
  // "Cannot stream simultaneously. Will capture sequentially" is a promise about what will
  // happen at the shutter. For a permission that was revoked it is false, and the user finds
  // out only when the capture comes back with a camera missing.
  const { $, document } = await launchApp({
    lenses: {
      'back-1': { label: 'camera2 0, facing back' },
      'back-2': { label: 'camera2 2, facing back ultra wide', deny: true },
    },
  });
  $('#btn-start-cameras').dispatch('click');
  await sleep(60);

  const tiles = $('#camera-grid').querySelectorAll('.cam-tile');
  assert.equal(tiles.length, 2);
  const failed = tiles.find((t) => t.classList.contains('failed'));
  assert.ok(failed, 'the refused camera is flagged');
  assert.match(failed.textContent, /Permission denied/, 'the reason the platform gave is what it says');
  assert.doesNotMatch(failed.textContent, /sequentially/);
  assert.match($('#camera-status').textContent, /1 unavailable: Permission denied/);
  assert.equal($('#btn-capture').disabled, false, 'the other camera can still shoot');
  assert.equal(document.visibilityState, 'visible');
});

test('a camera the phone will not run alongside the others still promises a sequential capture', async () => {
  // The case the sentence was written for has to keep it.
  const { $ } = await launchApp({
    lenses: { 'back-1': { label: 'camera2 0, facing back' }, 'back-2': { label: 'camera2 2, facing back ultra wide', busy: true } },
  });
  $('#btn-start-cameras').dispatch('click');
  await sleep(60);
  const failed = $('#camera-grid').querySelectorAll('.cam-tile').find((t) => t.classList.contains('failed'));
  assert.match(failed.textContent, /Will capture sequentially/);
  assert.match($('#camera-status').textContent, /1 will be captured sequentially/);
});

test('a lens that comes up after the capture screen has gone is closed, not left streaming', async () => {
  // Pressing Build 300 ms after returning to the capture screen used to land inside the
  // reopen loop: closeAll had already run and could only close what was open by then, and the
  // lens that arrived afterwards streamed for the whole of the reconstruction.
  const app = await launchApp({
    lenses: {
      'back-1': { label: 'camera2 0, facing back' },
      // Refused at first, so a reopen has something to do; slow to come up the second time,
      // and the screen goes away while it is coming.
      'back-2': { label: 'camera2 2, facing back ultra wide', busy: true },
    },
  });
  const { $, document, phone } = app;
  $('#btn-start-cameras').dispatch('click');
  await sleep(60);
  assert.equal(phone.streams.filter((s) => !s.track.stopped).length, 1, 'one lens live, one refused');

  const lens = phone.streams.length;
  Object.assign(phone.lenses['back-2'], {   // the lens table, so a lens can change mid-run
    busy: false,
    grantDelayMs: 40,
    onOpen: () => { $('#screen-capture').hidden = true; },   // Build was pressed
  });
  document.dispatch('visibilitychange');                     // the tab came back: reopen
  await sleep(200);

  const late = phone.streams[lens];
  assert.ok(late, 'the lens did come up, after the screen had gone');
  assert.equal(late.deviceId, 'back-2');
  assert.equal(late.track.stopped, true, 'and it must be closed rather than left streaming');
});

// The settings dialog's four controls are the whole of `phonogeometry.prefs.v1`: read once at
// start-up and written whenever one of them changes. Only #capture-res was driven end to end,
// so unwiring the three checkboxes — the exact defect 02f4374 fixed — left every suite green.
test('every settings control is applied at start-up and written back when it changes', async () => {
  const PREFS = 'phonogeometry.prefs.v1';
  const { $, localStorage } = await launchApp({
    stored: { [PREFS]: JSON.stringify({ captureRes: '1920', sequential: false, gpu: false, rig: true }) },
  });
  const stored = () => JSON.parse(localStorage.getItem(PREFS));

  // What was stored reaches the controls, rather than the markup's own defaults standing.
  assert.equal($('#capture-res').value, '1920');
  assert.equal($('#chk-sequential').checked, false);
  assert.equal($('#chk-gpu').checked, false);
  assert.equal($('#chk-rig').checked, true);

  // And each control, changed, is what the record then holds. One at a time, so an unwired
  // control cannot be carried by another control's write.
  for (const [selector, field] of [['#chk-sequential', 'sequential'], ['#chk-gpu', 'gpu'], ['#chk-rig', 'rig']]) {
    const node = $(selector);
    node.checked = !node.checked;
    node.dispatch('change');
    assert.equal(stored()[field], node.checked, `${selector} is written back`);
  }
  $('#capture-res').value = '960';
  $('#capture-res').dispatch('change');
  assert.equal(stored().captureRes, '960');
  assert.deepEqual(stored(), { captureRes: '960', sequential: true, gpu: true, rig: false }, 'every field, from the controls');
});
