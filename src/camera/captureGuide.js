// Drives the movement guide from the live preview and decides when the shutter may fire.
//
// The measurement runs on the main thread rather than in a worker. It costs about 7 ms a tick
// on a laptop and perhaps 30 on a phone, and at four ticks a second that is a small enough
// slice to leave the previews smooth, while a worker would need every frame copied across a
// thread boundary to save it. If it ever does become a problem the fix is to move
// `MovementGuide` behind a worker, which is why it has no DOM or camera dependency.
import { MovementGuide } from './moveGuide.js';

export class CaptureGuide extends EventTarget {
  /**
   * @param cams a CameraManager
   * @param opts.getBand () => {targetPercent, warnPercent} for the subject being scanned
   * @param opts.intervalMs how often to measure
   * @param opts.minShotGapMs how long after a shot before the shutter may fire itself
   */
  constructor(cams, { getBand, intervalMs = 250, minShotGapMs = 900 } = {}) {
    super();
    this.cams = cams;
    this.getBand = getBand || (() => ({ targetPercent: 5, warnPercent: 9 }));
    this.intervalMs = intervalMs;
    this.minShotGapMs = minShotGapMs;
    this.guide = new MovementGuide(this.getBand());
    this.autoShutter = false;
    this.running = false;
    this.paused = false;
    this.lastShotAt = 0;
    this.lastSample = null;
    this._timer = null;
    this._busy = false;
  }

  /** The camera to measure from: the rig moves as one body, so one camera is enough. */
  referenceEntry() {
    const open = Array.from(this.cams.open.values()).filter((e) => e.cam.enabled);
    if (!open.length) return null;
    return open.find((e) => e.cam.facing === 'environment') || open[0];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.guide.reset();
    this.lastSample = null;
    this._emit(null);
  }

  /** Held while a capture is in progress: the sequential fallback closes and reopens cameras. */
  pause() { this.paused = true; }
  resume() { this.paused = false; }

  setAutoShutter(on) { this.autoShutter = !!on; }

  /** Re-read the band, in case the user changed what they are scanning. */
  refreshBand() {
    const band = this.getBand();
    this.guide.targetPercent = band.targetPercent;
    this.guide.warnPercent = band.warnPercent;
  }

  /**
   * Measure the next shot from this frame. Called with the frame just captured, so the target
   * is judged from the real photograph rather than from a preview tick.
   */
  setReferenceFromCanvas(canvas, intrinsics) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    const scale = Math.min(1, 160 / Math.max(w, h));
    const tw = Math.max(16, Math.round(w * scale)), th = Math.max(16, Math.round(h * scale));
    const small = document.createElement('canvas');
    small.width = tw; small.height = th;
    small.getContext('2d').drawImage(canvas, 0, 0, tw, th);
    const { data } = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, tw, th);
    const gray = new Float32Array(tw * th);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    const k = tw / w;
    this.guide.setReference(gray, tw, th, {
      f: (intrinsics?.f ?? w) * k,
      cx: ((intrinsics?.cx ?? (w - 1) / 2) + 0.5) * k - 0.5,
      cy: ((intrinsics?.cy ?? (h - 1) / 2) + 0.5) * k - 0.5,
    });
    this.lastShotAt = performance.now();
    void ctx;
  }

  clearReference() {
    this.guide.reset();
    this.lastSample = null;
    this._emit(null);
  }

  _emit(sample) {
    this.lastSample = sample;
    this.dispatchEvent(new CustomEvent('sample', { detail: sample }));
  }

  _tick() {
    if (!this.running || this.paused || this._busy) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const entry = this.referenceEntry();
    if (!entry) { this._emit(null); return; }
    this._busy = true;
    try {
      const preview = this.cams.grabPreviewGray(entry, 160);
      if (!preview) { this._emit(null); return; }
      const sample = this.guide.update(preview.gray, preview.w, preview.h, preview);
      this._emit(sample);
      if (this.autoShutter
        && MovementGuide.shouldFire(sample)
        && performance.now() - this.lastShotAt >= this.minShotGapMs) {
        this.dispatchEvent(new CustomEvent('fire', { detail: sample }));
      }
    } catch (err) {
      // A camera can be closed underneath us mid-tick; never let that kill the loop
      this._emit(null);
      if (typeof console !== 'undefined') console.warn('capture guide tick failed:', err.message);
    } finally {
      this._busy = false;
    }
  }
}
