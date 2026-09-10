// Tells the user how far the phone has moved since the last shot, so they can be stopped
// before they walk past the point where reconstruction fails — and caught when they are
// turning on the spot instead of walking, which earns no depth at all.
//
// Three candidate signals were built and measured on synthetic scenes at known viewpoint
// separations before settling on the pair used here. The rejected ones are recorded because
// each looks obviously right until measured.
//
// 1. Essential matrix, then read off the rotation. Rejected. At the feature counts a live
//    preview can afford only a few dozen matches survive, so the fit is unreliable: a true
//    18 degree move read as 8.7 degrees at 160x120, and at higher resolutions the pose failed
//    to solve at all — exactly when a warning matters most. An estimate that under-reads
//    would urge the user onward past the point of failure.
//
// 2. Median displacement of matched keypoints, used alone. Rejected as a sole signal, and it
//    is worth being precise about why, because it is monotonic, repeatable to within 2%, never
//    loses tracking, and costs almost nothing. Measured against the two motions the user can
//    make: orbiting the subject by 10 degrees moves features by 6.9% of image width, while
//    turning on the spot by 10 degrees moves them by 14.8%. Turning scores *higher* than
//    walking. A guide built on displacement alone would tell someone standing still and
//    panning that they were making excellent progress, and they would fill a scan with photos
//    taken from one point, which cannot be reconstructed.
//
// 3. Fitting out the rotation and treating the leftover as parallax. Rejected as a progress
//    bar. The residual barely grows with baseline on ordinary scenes: orbiting from 2 to 18
//    degrees moved it only from 0.3 to 0.7 degrees, because a subject at roughly constant
//    depth is explained almost perfectly by a rotation. It is not a distance measure.
//
// So the two are used for the two different jobs each is good at:
//
//   * Displacement drives the progress ring, because what it measures is how much the view
//     has changed, and that is what decides whether the next photograph will still match the
//     last one. Matchability is the thing that actually fails.
//
//   * The rotation residual is a diagnostic, not a distance. Orbiting held it near 0.5
//     degrees while turning on the spot pinned it at 0.2, a consistent separation across every
//     sample, so a low residual beside a large rotation is a reliable sign that the phone is
//     pivoting rather than travelling. That earns a warning, not a number.
//
// Displacement is not an angle and this code does not pretend it is. How much displacement a
// degree produces depends on subject distance and field of view: 0.69% of image width per
// degree for an object at arm's length, 0.31% for a room. The caller supplies the band, taken
// from the kind of subject the user said they were scanning.
import { extractORB } from '../vision/orb.js';
import { matchDescriptors } from '../vision/match.js';
import { closestRotation, matToRotvec, matVec } from '../vision/linalg.js';

const DEG = 180 / Math.PI;

/** Unit bearing vector for keypoint `i`, given the frame's intrinsics. */
function bearing(keypoints, i, f, cx, cy, out) {
  const x = (keypoints[i * 2] - cx) / f;
  const y = (keypoints[i * 2 + 1] - cy) / f;
  const n = Math.hypot(x, y, 1);
  out[0] = x / n; out[1] = y / n; out[2] = 1 / n;
  return out;
}

/**
 * Best pure rotation between two sets of bearings, and how much each pair disagrees with it.
 * Trimmed Kabsch: three passes, discarding the worst 30% each time so a handful of wrong
 * matches cannot drag the fit. Uses `closestRotation`, which is the same SVD projection the
 * reconstruction uses.
 */
function fitRotation(pairs, count) {
  let keep = new Int32Array(count);
  for (let i = 0; i < count; i++) keep[i] = i;
  let R = null, residuals = new Float64Array(count);
  for (let pass = 0; pass < 3; pass++) {
    const M = new Float64Array(9);
    for (let k = 0; k < keep.length; k++) {
      const p = pairs[keep[k]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] += p.b[r] * p.a[c];
    }
    R = closestRotation(M);
    const rv = new Float64Array(3);
    for (let i = 0; i < count; i++) {
      const p = pairs[i];
      matVec(R, p.a, 3, 3).forEach((v, k) => { rv[k] = v; });
      const d = rv[0] * p.b[0] + rv[1] * p.b[1] + rv[2] * p.b[2];
      residuals[i] = Math.acos(Math.max(-1, Math.min(1, d)));
    }
    if (pass < 2) {
      const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => residuals[x] - residuals[y]);
      keep = Int32Array.from(order.slice(0, Math.max(8, Math.floor(count * 0.7))));
    }
  }
  const kept = Array.from(keep, (i) => residuals[i]).sort((x, y) => x - y);
  const rv = matToRotvec(R);
  return {
    rotationDeg: Math.hypot(rv[0], rv[1], rv[2]) * DEG,
    residualDeg: kept.length ? kept[kept.length >> 1] * DEG : NaN,
  };
}

export class MovementGuide {
  /**
   * @param opts.targetPercent displacement at which the next shot should be taken
   * @param opts.warnPercent displacement beyond which the shot is likely to be too far
   * @param opts.minMatches below this the view is treated as lost rather than unmoved, so a
   *   blank wall never reads as "you have not moved"
   * @param opts.steadyPercent movement between consecutive previews below which the phone is
   *   still enough to take a sharp photograph
   * @param opts.pivotResidualDeg rotation residual below which, when the phone has clearly
   *   turned, the motion is a pivot rather than a walk. Measured separation was 0.2 degrees
   *   for turning against about 0.5 for orbiting, so this sits between them.
   * @param opts.pivotRotationDeg rotation required before the pivot test is meaningful at all
   */
  constructor({
    targetPercent = 5, warnPercent = 9, minMatches = 8, steadyPercent = 1.2,
    pivotResidualDeg = 0.35, pivotRotationDeg = 2.5, features = {},
  } = {}) {
    this.targetPercent = targetPercent;
    this.warnPercent = warnPercent;
    this.minMatches = minMatches;
    this.steadyPercent = steadyPercent;
    this.pivotResidualDeg = pivotResidualDeg;
    this.pivotRotationDeg = pivotRotationDeg;
    // Measured operating point: 300 features at corner threshold 14 over two pyramid levels
    // costs about 7 ms a tick including the rotation fit. 600 features at threshold 12 was no
    // more accurate and cost half as much again.
    this.features = { maxFeatures: 300, threshold: 14, levels: 2, ...features };
    this.reference = null;
    this.previous = null;
    this.pivotStreak = 0;
  }

  /** Describe a frame the way this guide compares them. */
  describe(gray, w, h, intrinsics) {
    const f = extractORB(gray, w, h, this.features);
    return {
      keypoints: f.keypoints,
      descriptors: f.descriptors,
      count: f.count,
      width: w,
      height: h,
      f: intrinsics?.f ?? w,
      cx: intrinsics?.cx ?? (w - 1) / 2,
      cy: intrinsics?.cy ?? (h - 1) / 2,
    };
  }

  /** Take this frame as the one to measure from. Called after every capture. */
  setReference(gray, w, h, intrinsics) {
    this.reference = this.describe(gray, w, h, intrinsics);
    this.previous = null;
    this.pivotStreak = 0;
    return this.reference;
  }

  /** Adopt an already-described frame, so a frame is never described twice. */
  setReferenceDescribed(described) {
    this.reference = described;
    this.previous = null;
    this.pivotStreak = 0;
  }

  reset() {
    this.reference = null;
    this.previous = null;
    this.pivotStreak = 0;
  }

  /** Median displacement between two described frames, as a percentage of image width. */
  static displacement(a, b) {
    if (!a || !b || a.count < 4 || b.count < 4) return { percent: NaN, matches: 0, pairs: null };
    const m = matchDescriptors(a.descriptors, a.count, b.descriptors, b.count);
    const n = m.length / 2;
    if (n === 0) return { percent: NaN, matches: 0, pairs: null };
    const d = new Float64Array(n);
    const pairs = new Array(n);
    for (let i = 0; i < n; i++) {
      const ai = m[i * 2], bi = m[i * 2 + 1];
      d[i] = Math.hypot(
        b.keypoints[bi * 2] - a.keypoints[ai * 2],
        b.keypoints[bi * 2 + 1] - a.keypoints[ai * 2 + 1],
      );
      pairs[i] = {
        a: bearing(a.keypoints, ai, a.f, a.cx, a.cy, new Float64Array(3)),
        b: bearing(b.keypoints, bi, b.f, b.cx, b.cy, new Float64Array(3)),
      };
    }
    const sorted = Float64Array.from(d).sort();
    return { percent: (100 * sorted[n >> 1]) / a.width, matches: n, pairs };
  }

  /**
   * @returns {{percent, state, matches, steady, pivoting, rotationDeg, residualDeg, described}}
   *   state is one of 'lost', 'still', 'approaching', 'ready', 'far'.
   *   `pivoting` means the phone has turned without travelling, which gains no depth.
   */
  update(gray, w, h, intrinsics) {
    const described = this.describe(gray, w, h, intrinsics);

    // Steadiness comes free from the same measurement against the previous preview: a large
    // jump between consecutive frames means the phone is mid-swing, and a photograph taken
    // then is the blurred one that later gets flagged and breaks the scan.
    let steady = true;
    if (this.previous) {
      const move = MovementGuide.displacement(this.previous, described);
      steady = Number.isNaN(move.percent) ? false : move.percent <= this.steadyPercent;
    }
    this.previous = described;

    const idle = {
      percent: 0, state: 'still', matches: 0, steady, pivoting: false,
      rotationDeg: 0, residualDeg: NaN, described,
    };
    if (!this.reference) return idle;

    const { percent, matches, pairs } = MovementGuide.displacement(this.reference, described);
    if (matches < this.minMatches || Number.isNaN(percent)) {
      this.pivotStreak = 0;
      return { ...idle, percent: NaN, state: 'lost', matches };
    }

    const { rotationDeg, residualDeg } = fitRotation(pairs, matches);
    // Turning on the spot moves features a long way while leaving almost nothing the rotation
    // cannot explain. Require several consecutive ticks before saying so, since the margin
    // between pivoting and orbiting is real but narrow.
    const looksPivoting = rotationDeg >= this.pivotRotationDeg && residualDeg < this.pivotResidualDeg;
    this.pivotStreak = looksPivoting ? this.pivotStreak + 1 : 0;
    const pivoting = this.pivotStreak >= 3;

    let state;
    if (percent >= this.warnPercent) state = 'far';
    else if (percent >= this.targetPercent) state = 'ready';
    else if (percent >= this.targetPercent * 0.25) state = 'approaching';
    else state = 'still';

    return { percent, state, matches, steady, pivoting, rotationDeg, residualDeg, described };
  }

  /** Fraction of the way to the next shot, for a progress ring. */
  static fillFraction(percent, targetPercent) {
    if (!Number.isFinite(percent) || targetPercent <= 0) return 0;
    return Math.max(0, Math.min(1, percent / targetPercent));
  }

  /**
   * Should the shutter fire by itself? A pivot never counts as progress, and firing mid-swing
   * produces the blurred frame that breaks scans.
   */
  static shouldFire(sample) {
    return !!sample && sample.state === 'ready' && sample.steady && !sample.pivoting;
  }
}
