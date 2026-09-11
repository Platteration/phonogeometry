// Discovers every camera on the device, opens as many as the hardware allows at the
// same time, and captures synchronised frames from all of them.
import { guessFacing, guessLens, loadLensOverrides, intrinsicsFor } from './intrinsics.js';

/**
 * Wait for the first frame of a stream, or give up.
 *
 * The deadline is armed with setTimeout and only the polling uses animation frames. It used
 * to be evaluated inside the rAF callback itself, which means it was never evaluated at all
 * in a tab the browser had stopped painting — and a hidden tab is exactly when this app is
 * running, since a reconstruction takes minutes and people switch away from it.
 */
function waitForVideo(video, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const check = () => {
      if (settled) return;
      if (video.readyState >= 2 && video.videoWidth > 0) return finish(true);
      requestAnimationFrame(check);
    };
    check();
  });
}

/**
 * Reject with `message` if `promise` has not settled within `ms`.
 *
 * A promise that never settles is a different failure from one that rejects, and the camera
 * path is full of the first kind: `video.play()` for a track that grants but delivers no
 * frames simply never settles, and `getUserMedia` on a lens the system is still tearing down
 * can sit there too. Anything awaited with no deadline turns one stuck lens into an app that
 * is waiting forever with nothing on screen to say so.
 */
function withDeadline(promise, ms, message) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(message)), ms); }),
  ]);
}

function timeoutError(message) {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

function stopStream(stream) {
  try { stream.getTracks().forEach((t) => t.stop()); } catch { /* already gone */ }
}

export class CameraManager extends EventTarget {
  constructor() {
    super();
    this.cameras = []; // {deviceId, key, label, facing, lens, index, enabled}
    this.open = new Map(); // deviceId -> {stream, track, video, settings}
    // One <video> per camera, kept across open and close. A phone that can only run one
    // camera at a time is closed and reopened during a capture, and the preview tile holds
    // whichever element it was given: handing it a new one each time would leave it blank.
    this.videos = new Map(); // deviceId -> HTMLVideoElement
    // Opens that have started and not yet finished. A stream lives here from the moment
    // getUserMedia hands it over until it is either registered in `open` or stopped, so there
    // is no window in which the app holds a live lens it cannot close.
    this.attempts = new Set(); // {cam, stream, cancelled, gen}
    // Bumped by every close. An open that started before the current value has been overtaken
    // by a close and must not register the stream it is about to receive.
    this.closeGen = 0;
    // While an open sequence is running, the time it is allowed to run until. See openSequence.
    this.sequenceUntil = 0;
    // How long each step may take, in milliseconds. Fields rather than constants so a test
    // can make them short: `open` covers the whole of openCamera, including getUserMedia, so
    // no step inside it can outlast it.
    this.timeouts = { open: 10000, play: 4000, frames: 4000 };
    this.supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** Ask for permission once (unlocks device labels) and list every camera. */
  async discover() {
    if (!this.supported) throw new Error('This browser does not support camera access (getUserMedia).');
    let probe = null;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    probe.getTracks().forEach((t) => t.stop());
    const overrides = loadLensOverrides();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    this.cameras = videoInputs.map((d, i) => {
      const label = d.label || `Camera ${i + 1}`;
      const facing = guessFacing(label);
      const key = d.label || `index-${i}`;
      const ov = overrides[key];
      return {
        deviceId: d.deviceId, key, label, facing, index: i,
        lens: ov?.lens || guessLens(label, facing), hfovOverride: ov?.hfov || null,
        enabled: true,
      };
    });
    // Nicer labels for Android's generic "camera2 N, facing back"
    const backs = this.cameras.filter((c) => c.facing === 'environment');
    const fronts = this.cameras.filter((c) => c.facing === 'user');
    backs.forEach((c, i) => { c.shortLabel = backs.length > 1 ? `Back ${i + 1}` : 'Back'; });
    fronts.forEach((c, i) => { c.shortLabel = fronts.length > 1 ? `Front ${i + 1}` : 'Front'; });
    this.cameras.forEach((c, i) => { if (!c.shortLabel) c.shortLabel = `Camera ${i + 1}`; });
    this.dispatchEvent(new CustomEvent('cameras', { detail: this.cameras }));
    return this.cameras;
  }

  /**
   * Open one camera, with a deadline on the whole attempt.
   *
   * Every failure path — a rejection, the deadline, a close that overtook this open — stops
   * the stream if one was acquired. A MediaStream that reaches nobody is a lens that keeps
   * streaming with the app unable to release it: neither closeAll nor the pagehide handler
   * can reach what is not in `open`.
   */
  async openCamera(cam, opts = {}) {
    if (this.open.has(cam.deviceId)) return this.open.get(cam.deviceId);
    const attempt = { cam, stream: null, cancelled: false, gen: this.closeGen };
    this.attempts.add(attempt);
    try {
      return await withDeadline(
        this.openStream(cam, attempt, opts),
        this.timeouts.open,
        `${cam.shortLabel || cam.label} did not open in time`,
      );
    } catch (err) {
      this.cancelAttempt(attempt);
      throw err;
    } finally {
      this.attempts.delete(attempt);
    }
  }

  /** True once a close has overtaken this open, or the attempt was abandoned. */
  stale(attempt) { return attempt.cancelled || attempt.gen !== this.closeGen; }

  /** Abandon an open: stop the stream it holds, and the one it has not received yet. */
  cancelAttempt(attempt) {
    attempt.cancelled = true;
    if (attempt.stream) { stopStream(attempt.stream); attempt.stream = null; }
  }

  async openStream(cam, attempt, { width = 1280, height = 720 } = {}) {
    const constraints = {
      audio: false,
      video: { deviceId: { exact: cam.deviceId }, width: { ideal: width }, height: { ideal: height } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Registered before anything else can be awaited, and checked immediately: a close that
    // happened while getUserMedia was in flight has to reach this stream too.
    attempt.stream = stream;
    if (this.stale(attempt)) { this.cancelAttempt(attempt); throw new Error('Camera closed while it was opening'); }
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.facingMode && caps.facingMode.length) {
        cam.facing = caps.facingMode.includes('user') ? 'user' : 'environment';
        if (cam.lens === 'unknown') cam.lens = cam.facing === 'user' ? 'front' : 'wide';
      }
    } catch { /* capabilities not supported */ }
    if (settings.facingMode) cam.facing = settings.facingMode;
    let video = this.videos.get(cam.deviceId);
    if (!video) {
      video = document.createElement('video');
      video.playsInline = true; video.muted = true; video.autoplay = true;
      video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
      this.videos.set(cam.deviceId, video);
    }
    video.srcObject = stream;
    // Two different failures, one line apart. A play() the browser refuses (an autoplay
    // policy) rejects, and the frame check below still works — that is the old comment and it
    // is true. A play() for a track that grants but delivers no frames never settles at all,
    // and no catch handles a promise that never rejects: this await had no deadline, and it
    // is the one that actually hangs. The frame wait one line down has had a deadline all
    // along; what it lacked was a way to evaluate it without animation frames.
    try { await withDeadline(video.play(), this.timeouts.play, 'play() did not settle'); } catch { /* fall through to the frame check */ }
    const ready = await waitForVideo(video, this.timeouts.frames);
    if (!ready || this.stale(attempt)) {
      this.cancelAttempt(attempt);
      throw new Error(ready ? 'Camera closed while it was opening' : 'Camera did not deliver frames');
    }
    const entry = { cam, stream, track, video, settings };
    attempt.stream = null;   // handed over: `open` owns it from here
    this.open.set(cam.deviceId, entry);
    track.addEventListener('ended', () => { this.open.delete(cam.deviceId); this.dispatchEvent(new CustomEvent('ended', { detail: cam })); });
    return entry;
  }

  /**
   * Try to open every enabled camera simultaneously. Phones often refuse to stream several
   * physical cameras at once; those that fail are reported and captured sequentially later.
   */
  async openAll(opts) {
    const results = [];
    for (const cam of this.cameras) {
      if (!cam.enabled) continue;
      try {
        const entry = await this.openCamera(cam, opts);
        results.push({ cam, ok: true, entry });
      } catch (err) {
        // The name as well as the message: what the interface may promise about a camera that
        // is not open depends on which failure it was, and the message alone cannot say.
        results.push({ cam, ok: false, error: err.message || String(err), name: err.name });
      }
    }
    this.dispatchEvent(new CustomEvent('opened', { detail: results }));
    return results;
  }

  /**
   * Open a list of cameras one after another for as long as the reason for opening them
   * holds. Resolves `{results, cancelled}`, or `null` when a sequence is already running.
   *
   * `shouldContinue` is asked again after every open, not once at entry. One getUserMedia per
   * lens is 200-800 ms on a phone and there can be four of them, so the screen these cameras
   * belong to can be gone long before the loop ends — and `closeAll` can only close what is
   * already in `open`. A camera that came up after that point is closed here instead of
   * streaming on, with the OS indicator lit, for the whole of a reconstruction.
   */
  async openSequence(list, opts = {}, shouldContinue = () => true) {
    // The latch is a deadline rather than a flag. A flag cleared only in a `finally` stays set
    // for the life of the page if an awaited open never settles, and every later attempt to
    // open a camera then returns at the top having done nothing: the app silently stops being
    // a scanner until it is reloaded. Each open below carries its own deadline; this one only
    // has to outlast all of them.
    if (Date.now() < this.sequenceUntil) return null;
    this.sequenceUntil = Date.now() + (list.length + 1) * (this.timeouts.open + 500);
    const results = [];
    let cancelled = false;
    try {
      for (const cam of list) {
        if (!shouldContinue()) { cancelled = true; break; }
        const gen = this.closeGen;
        try {
          const entry = await this.openCamera(cam, opts);
          // A close during the open (a screen change, a capture taking the cameras) counts
          // even when the predicate cannot see it.
          if (!shouldContinue() || this.closeGen !== gen) {
            this.closeCamera(cam.deviceId);
            cancelled = true;
            break;
          }
          results.push({ cam, ok: true, entry });
        } catch (err) {
          results.push({ cam, ok: false, error: err.message || String(err), name: err.name });
          if (!shouldContinue() || this.closeGen !== gen) { cancelled = true; break; }
        }
      }
      return { results, cancelled };
    } finally { this.sequenceUntil = 0; }
  }

  closeCamera(deviceId) {
    // Bumped whether or not this camera is open: an open that is in flight for it has to be
    // overtaken too, or it registers a stream nobody asked for any more.
    this.closeGen++;
    for (const attempt of this.attempts) if (attempt.cam.deviceId === deviceId) this.cancelAttempt(attempt);
    const entry = this.open.get(deviceId);
    if (!entry) return;
    entry.stream.getTracks().forEach((t) => t.stop());
    entry.video.srcObject = null;
    this.open.delete(deviceId);
    // The element itself is kept in this.videos so the tile showing it keeps working
  }

  closeAll() {
    this.closeGen++;
    // Cameras still opening are not in `open`, so closing that map alone would leave them
    // streaming the moment they arrive. This is what makes a close able to cancel a reopen.
    for (const attempt of this.attempts) this.cancelAttempt(attempt);
    for (const id of Array.from(this.open.keys())) this.closeCamera(id);
  }

  /** Grab the current frame of an open camera as RGBA. */
  grabFrame(entry, maxDim = 1280) {
    const { video, cam, track } = entry;
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const settings = track.getSettings ? track.getSettings() : {};
    const zoom = settings.zoom && settings.zoom > 0 ? settings.zoom : 1;
    const intr = intrinsicsFor(cam, w, h, zoom);
    return { canvas, width: w, height: h, cameraKey: cam.key, cameraLabel: cam.shortLabel || cam.label, lens: cam.lens, facing: cam.facing, ...intr, zoom, timestamp: performance.now() };
  }

  /**
   * Capture from every enabled camera "at once": all open cameras are grabbed in the same
   * animation frame, then cameras that could not be opened concurrently are opened one by
   * one, captured and released again.
   */
  async captureAll({ maxDim = 1280, sequentialFallback = true, onStatus = () => {} } = {}) {
    const frames = [];
    // Every camera opened during this capture asks for the same resolution, so a lens
    // captured sequentially does not come back larger than the ones streaming live.
    const size = { width: maxDim, height: Math.round(maxDim * 0.75) };
    await new Promise((r) => requestAnimationFrame(r));
    for (const entry of this.open.values()) {
      if (!entry.cam.enabled) continue;
      frames.push(this.grabFrame(entry, maxDim));
    }
    if (sequentialFallback) {
      const pending = this.cameras.filter((c) => c.enabled && !this.open.has(c.deviceId));
      for (const cam of pending) {
        onStatus(`Switching to ${cam.shortLabel || cam.label}…`);
        // Free a slot: release open cameras temporarily if the device limits concurrent streams
        const released = Array.from(this.open.values()).map((e) => e.cam);
        let entry = null;
        try {
          entry = await this.openCamera(cam, size);
        } catch {
          this.closeAll();
          try { entry = await this.openCamera(cam, size); } catch (err) { onStatus(`${cam.shortLabel || cam.label} unavailable: ${err.message}`); }
        }
        if (entry) {
          await new Promise((r) => setTimeout(r, 350)); // let exposure settle
          frames.push(this.grabFrame(entry, maxDim));
          this.closeCamera(cam.deviceId);
        }
        for (const c of released) if (!this.open.has(c.deviceId)) { try { await this.openCamera(c, size); } catch { /* ignore */ } }
      }
    }
    return frames;
  }
}
