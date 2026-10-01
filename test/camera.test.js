// Opening a camera is the one step in this app that can fail by not finishing. A phone lens
// grants a track and then delivers nothing; the tab is hidden so animation frames stop; the
// user leaves the screen while getUserMedia is still in flight. Each of those used to end
// with a promise that never settles or a MediaStream nobody holds — a lens streaming with
// the app unable to release it, and the camera path disabled until the page is reloaded.
// None of it needs a browser to check: the manager only ever touches getUserMedia, a <video>
// and the frame clock, and all three are stubbed here.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CameraManager } from '../src/camera/cameraManager.js';

/** What a promise that never settles looks like: play() on a track that delivers no frames. */
const never = () => new Promise(() => {});

/**
 * The smallest phone that behaves the way cameraManager.js drives one. Each lens is described
 * by how it misbehaves: `grantDelayMs` before getUserMedia resolves, `deny` to refuse,
 * `playHangs` for a play() that never settles, `noFrames` for a track that starts and stays
 * blank.
 */
function fakePhone(lenses) {
  const streams = [];
  const opened = [];
  const played = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          const deviceId = constraints.video.deviceId.exact;
          const lens = lenses[deviceId] || {};
          opened.push(deviceId);
          lens.onOpen?.();
          if (lens.grantHangs) await never();
          if (lens.grantDelayMs) await new Promise((r) => setTimeout(r, lens.grantDelayMs));
          if (lens.deny) throw new DOMException('Permission denied', 'NotAllowedError');
          if (lens.busy) throw new DOMException('Could not start video source', 'NotReadableError');
          const track = {
            stopped: false,
            stop() { this.stopped = true; },
            addEventListener() {},
            getSettings: () => ({ width: 640, height: 480, facingMode: 'environment' }),
          };
          const stream = { deviceId, track, getTracks: () => [track], getVideoTracks: () => [track] };
          streams.push(stream);
          return stream;
        },
      },
    },
  });
  globalThis.document = {
    createElement() {
      return {
        readyState: 0, videoWidth: 0, srcObject: null,
        setAttribute() {},
        play() {
          played.push(this.srcObject?.deviceId);
          const lens = lenses[this.srcObject?.deviceId] || {};
          if (lens.playHangs) return never();
          if (!lens.noFrames) { this.readyState = 4; this.videoWidth = 640; }
          return Promise.resolve();
        },
      };
    },
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 2);

  const cams = new CameraManager();
  cams.cameras = Object.keys(lenses).map((deviceId, i) => ({
    deviceId, key: deviceId, label: deviceId, shortLabel: deviceId, lens: 'wide', facing: 'environment', index: i, enabled: true,
  }));
  // Short enough to test in a second, long enough that a healthy lens still gets through.
  cams.timeouts = { open: 400, play: 60, frames: 60 };
  return { cams, streams, opened, played, live: () => streams.filter((s) => !s.track.stopped).length };
}

/**
 * Settle `promise`, or report that it is still pending. Written this way rather than leaning
 * on the runner's own timeout: a pending promise inside a test stalls the whole file, and a
 * test that hangs says much less than one that fails.
 */
function within(promise, ms = 3000) {
  return Promise.race([
    promise.then((v) => ({ state: 'resolved', value: v }), (e) => ({ state: 'rejected', error: e })),
    new Promise((r) => setTimeout(() => r({ state: 'pending' }), ms)),
  ]);
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
});

test('a play() that never settles gives up on a deadline, and the lens is released', async () => {
  // The failure that is actually reached on a phone: the track is granted, play() is called,
  // and the promise simply never settles — not a rejection any catch can see.
  const { cams, streams, live } = fakePhone({ dead: { playHangs: true, noFrames: true } });
  cams.timeouts = { open: 2000, play: 60, frames: 60 };
  const started = Date.now();
  const outcome = await within(cams.openCamera(cams.cameras[0]), 5000);
  const took = Date.now() - started;
  assert.equal(outcome.state, 'rejected', 'openCamera must not sit on a play() that never settles');
  // It was play()'s own deadline that ended it, not the backstop on the whole attempt: the
  // open got as far as the frame check, and got there well inside the outer budget.
  assert.match(outcome.error.message, /did not deliver frames/);
  assert.ok(took < cams.timeouts.open, `${took} ms, against a ${cams.timeouts.open} ms backstop on the whole open`);
  assert.equal(cams.open.size, 0);
  assert.equal(streams.length, 1);
  assert.equal(live(), 0, 'the stream it was granted has to be stopped, or the lens keeps running');
  assert.equal(cams.attempts.size, 0);
});

test('a getUserMedia that never settles is bounded by the deadline on the whole open', async () => {
  // The backstop, for the steps that have no deadline of their own: no single await inside
  // openCamera may outlast it.
  const { cams } = fakePhone({ stuck: { grantHangs: true } });
  const outcome = await within(cams.openCamera(cams.cameras[0]), 5000);
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.error.name, 'TimeoutError');
  assert.equal(cams.attempts.size, 0);
});

test('the frame deadline does not depend on animation frames', async () => {
  // A hidden tab stops requestAnimationFrame, and a build is exactly when people switch away.
  // The deadline used to be evaluated only inside the frame callback, so it was never
  // evaluated at all in the case it was written for.
  const { cams, live } = fakePhone({ blank: { noFrames: true } });
  globalThis.requestAnimationFrame = () => {};   // the tab is hidden: no frames, ever
  const started = Date.now();
  const outcome = await within(cams.openCamera(cams.cameras[0]));
  const took = Date.now() - started;
  assert.equal(outcome.state, 'rejected', 'the frame wait must time out without animation frames');
  // Its own deadline ended it, not the backstop on the whole open — which would mean the
  // frame wait had no working deadline at all, only a longer one somewhere above it.
  assert.match(outcome.error.message, /did not deliver frames/);
  assert.ok(took < cams.timeouts.open, `${took} ms, against a ${cams.timeouts.open} ms backstop on the whole open`);
  assert.equal(live(), 0);
});

test('a close while a camera is opening stops the stream it was about to receive', async () => {
  // showScreen closes the cameras on the way out, and closeAll can only close what is already
  // open. A lens whose getUserMedia resolves after that is never seen again by closeAll, the
  // pagehide handler or anything else: it streams for the life of the page.
  const { cams, streams, played, live } = fakePhone({ slow: { grantDelayMs: 60 } });
  const opening = cams.openCamera(cams.cameras[0]);
  await new Promise((r) => setTimeout(r, 10));
  cams.closeAll();                                  // the screen went away mid-open
  const outcome = await within(opening);
  assert.equal(outcome.state, 'rejected');
  assert.equal(cams.open.size, 0, 'a camera opened after the close must not register');
  assert.equal(streams.length, 1, 'getUserMedia had already granted the stream');
  assert.equal(live(), 0, 'and it has to be stopped, since nothing else can reach it');
  // Noticed where the stream arrives, not eight seconds later at the end of the frame wait:
  // a stream whose close has already happened is never handed to a preview or played.
  assert.deepEqual(played, [], 'a cancelled open must stop, not carry on driving a dead stream');
});

test('an open sequence stops when the screen its cameras belong to goes away', async () => {
  // Reopening is one getUserMedia per lens, 200-800 ms each on a phone. Pressing Build inside
  // that window used to leave a lens streaming for the whole reconstruction, because the
  // screen was checked once at entry and closeAll had already run by the time it came up.
  let onScreen = true;
  const phone = fakePhone({
    first: {},
    second: { grantDelayMs: 40, onOpen: () => { onScreen = false; } },   // the screen goes away mid-open
    third: {},
  });
  const { cams, streams, opened, live } = phone;
  const outcome = await cams.openSequence(cams.cameras, {}, () => onScreen);
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(opened, ['first', 'second'], 'the third was never asked for');
  assert.equal(cams.open.has('second'), false, 'the one that came up late must not be left open');
  assert.equal(streams.length, 2);
  assert.equal(live(), 1, 'only the camera opened while the screen was still there is streaming');
  assert.equal(streams[1].track.stopped, true);
});

test('one stuck open does not disable the camera path for the life of the page', async () => {
  // The latch that keeps two reopens apart used to be a flag cleared in a `finally`, which
  // never ran if the open never settled. Every later reopen — the ended listener,
  // visibilitychange, the next screen change — then returned at the top having done nothing,
  // with no error anywhere and the shutter still enabled.
  const { cams } = fakePhone({ dead: { playHangs: true, noFrames: true }, good: {} });
  const stuck = await within(cams.openSequence([cams.cameras[0]], {}, () => true));
  assert.equal(stuck.state, 'resolved', 'the sequence has to end even when the lens does not');
  const second = await within(cams.openSequence([cams.cameras[1]], {}, () => true));
  assert.equal(second.state, 'resolved');
  assert.notEqual(second.value, null, 'a later reopen must not be refused by a latch left set');
  assert.equal(cams.open.has('good'), true);
});

test('the latch cannot outlive one attempt even if an open never returns at all', async () => {
  // Belt and braces for the same property: with openCamera itself replaced by something that
  // never settles, the latch still lets go, because it is a deadline rather than a flag.
  const { cams } = fakePhone({ good: {} });
  cams.timeouts.open = 20;   // the budget is derived from this
  const real = cams.openCamera.bind(cams);
  cams.openCamera = () => new Promise(() => {});
  cams.openSequence([cams.cameras[0]], {}, () => true);
  assert.equal(await cams.openSequence([cams.cameras[0]], {}, () => true), null, 'one sequence at a time');
  await new Promise((r) => setTimeout(r, (1 + 1) * (cams.timeouts.open + 500) + 100));
  cams.openCamera = real;
  const later = await cams.openSequence([cams.cameras[0]], {}, () => true);
  assert.notEqual(later, null, 'the latch has to let go on its own');
  assert.equal(later.results[0].ok, true);
});

test('a camera that fails says which failure it was', async () => {
  // "Cannot stream simultaneously" is true of a NotReadableError and false of everything
  // else, so the name has to survive as far as the interface.
  const { cams } = fakePhone({ denied: { deny: true }, busy: { busy: true } });
  const { results } = await cams.openSequence(cams.cameras, {}, () => true);
  assert.deepEqual(results.map((r) => r.name), ['NotAllowedError', 'NotReadableError']);
  assert.match(results[0].error, /Permission denied/);
});
