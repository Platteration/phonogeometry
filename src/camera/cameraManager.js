// Discovers every camera on the device, opens as many as the hardware allows at the
// same time, and captures synchronised frames from all of them.
import { guessFacing, guessLens, loadLensOverrides, intrinsicsFor } from './intrinsics.js';
import { rgbaToGray } from '../vision/image.js';

function waitForVideo(video, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) return resolve(true);
      if (performance.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(check);
    };
    check();
  });
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

  async openCamera(cam, { width = 1280, height = 720 } = {}) {
    if (this.open.has(cam.deviceId)) return this.open.get(cam.deviceId);
    const constraints = {
      audio: false,
      video: { deviceId: { exact: cam.deviceId }, width: { ideal: width }, height: { ideal: height } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
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
    try { await video.play(); } catch { /* autoplay policies: the frame check below still works */ }
    const ready = await waitForVideo(video);
    if (!ready) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Camera did not deliver frames');
    }
    const entry = { cam, stream, track, video, settings };
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
        results.push({ cam, ok: false, error: err.message || String(err) });
      }
    }
    this.dispatchEvent(new CustomEvent('opened', { detail: results }));
    return results;
  }

  closeCamera(deviceId) {
    const entry = this.open.get(deviceId);
    if (!entry) return;
    entry.stream.getTracks().forEach((t) => t.stop());
    entry.video.srcObject = null;
    this.open.delete(deviceId);
    // The element itself is kept in this.videos so the tile showing it keeps working
  }

  closeAll() {
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
   * A small greyscale grab for the movement guide, which runs several times a second while
   * the user lines up a shot. It reuses one canvas across calls: allocating a fresh one at
   * this rate is avoidable rubbish for the collector to deal with on a phone.
   * @returns {{gray: Float32Array, w, h, f, cx, cy}|null} null when the camera has no frame yet
   */
  grabPreviewGray(entry, targetWidth = 160) {
    const { video, cam, track } = entry;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(1, targetWidth / Math.max(vw, vh));
    const w = Math.max(16, Math.round(vw * s)), h = Math.max(16, Math.round(vh * s));
    if (!this._previewCanvas) {
      this._previewCanvas = document.createElement('canvas');
      this._previewCtx = this._previewCanvas.getContext('2d', { willReadFrequently: true });
    }
    const canvas = this._previewCanvas;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    this._previewCtx.drawImage(video, 0, 0, w, h);
    const { data } = this._previewCtx.getImageData(0, 0, w, h);
    const settings = track.getSettings ? track.getSettings() : {};
    const zoom = settings.zoom && settings.zoom > 0 ? settings.zoom : 1;
    const intr = intrinsicsFor(cam, w, h, zoom);
    return { gray: rgbaToGray(data, w, h), w, h, f: intr.f, cx: intr.cx, cy: intr.cy };
  }

  /**
   * Capture from every enabled camera "at once": all open cameras are grabbed in the same
   * animation frame, then cameras that could not be opened concurrently are opened one by
   * one, captured and released again.
   */
  async captureAll({ maxDim = 1280, sequentialFallback = true, onStatus = () => {} } = {}) {
    const frames = [];
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
          entry = await this.openCamera(cam, { width: maxDim, height: Math.round(maxDim * 0.75) });
        } catch {
          this.closeAll();
          try { entry = await this.openCamera(cam, { width: maxDim, height: Math.round(maxDim * 0.75) }); } catch (err) { onStatus(`${cam.shortLabel || cam.label} unavailable: ${err.message}`); }
        }
        if (entry) {
          await new Promise((r) => setTimeout(r, 350)); // let exposure settle
          frames.push(this.grabFrame(entry, maxDim));
          this.closeCamera(cam.deviceId);
        }
        for (const c of released) if (!this.open.has(c.deviceId)) { try { await this.openCamera(c); } catch { /* ignore */ } }
      }
    }
    return frames;
  }
}
