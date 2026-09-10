import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MovementGuide } from '../src/camera/moveGuide.js';
import { renderObject, renderFurnishedRoom } from './synthScene.js';
import { rgbaToGray } from '../src/vision/image.js';
import { lookAt, rng, gauss } from './helpers.js';

const W = 160, H = 120, F = 130, CX = (W - 1) / 2, CY = (H - 1) / 2;
const INTR = { f: F, cx: CX, cy: CY };

function frame(cam, { kind = 'object', seed = 2, noise = 8 } = {}) {
  const r = kind === 'room'
    ? renderFurnishedRoom(cam, W, H, 55, CX, CY, 3)
    : renderObject(cam, W, H, F, CX, CY, 1, 3);
  const rgba = Uint8ClampedArray.from(r.rgba);
  const rr = rng(seed);
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) rgba[p * 4 + c] += gauss(rr) * noise;
  return rgbaToGray(rgba, W, H);
}

/** Camera orbiting a subject at the origin, keeping it framed. */
const orbit = (deg, radius = 2.8) => {
  const a = (deg * Math.PI) / 180;
  return lookAt([Math.sin(a) * radius, 0, -Math.cos(a) * radius], [0, 0, 0]);
};

/** Camera pivoting about its own centre: the motion that gains no depth. */
const pivot = (deg, C = [0, 0, -2.8]) => {
  const a = (deg * Math.PI) / 180;
  return lookAt(C, [C[0] + Math.sin(a) * 5, 0, C[2] + Math.cos(a) * 5]);
};

test('the progress signal rises with movement and never loses tracking', () => {
  const guide = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  guide.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  let previous = -1;
  for (const deg of [0, 2, 4, 6, 8, 10, 14, 18]) {
    const s = guide.update(frame(orbit(deg)), W, H, INTR);
    assert.notEqual(s.state, 'lost', `lost tracking at ${deg} degrees`);
    assert.ok(s.percent > previous, `not monotonic at ${deg} degrees: ${s.percent} after ${previous}`);
    previous = s.percent;
  }
});

test('the states line up with the band that was asked for', () => {
  const guide = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  guide.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  const at = (deg) => guide.update(frame(orbit(deg)), W, H, INTR).state;
  assert.equal(at(0), 'still');
  assert.equal(at(4), 'approaching');
  assert.equal(at(8), 'ready');       // measured near 5.5% for this scene
  assert.equal(at(18), 'far');        // measured near 12.5%
});

test('turning on the spot is not mistaken for progress', () => {
  // This is the case that sank the first design. Measured, a 10 degree pivot moves features
  // 14.8% of image width while a 10 degree orbit moves them 6.9%: judged on displacement
  // alone, standing still and panning looks like twice the progress of walking around the
  // subject. The rotation residual is what tells them apart.
  const guide = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  guide.setReference(frame(pivot(0), { seed: 1 }), W, H, INTR);
  let pivotSeen = false;
  for (const deg of [2, 4, 6, 8, 10]) {
    const s = guide.update(frame(pivot(deg)), W, H, INTR);
    assert.ok(s.rotationDeg > deg * 0.7, `rotation under-read at ${deg}: ${s.rotationDeg.toFixed(1)}`);
    if (s.pivoting) pivotSeen = true;
    assert.equal(MovementGuide.shouldFire(s), false, `fired on a pivot at ${deg} degrees`);
  }
  assert.ok(pivotSeen, 'a sustained pivot should be reported as pivoting');

  // Orbiting must not be flagged as a pivot, or the warning would cry wolf on correct use
  const walking = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  walking.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  for (const deg of [2, 4, 6, 8, 10, 14]) {
    const s = walking.update(frame(orbit(deg)), W, H, INTR);
    assert.equal(s.pivoting, false, `orbiting was called a pivot at ${deg} degrees`);
  }
});

test('a blank view is reported as lost, not as standing still', () => {
  const guide = new MovementGuide();
  guide.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  const blank = new Float32Array(W * H).fill(128);
  const s = guide.update(blank, W, H, INTR);
  assert.equal(s.state, 'lost');
  assert.equal(MovementGuide.shouldFire(s), false);
});

test('the shutter waits for the phone to settle', () => {
  const guide = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  guide.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  // A large jump between consecutive previews means the phone is mid-swing
  guide.update(frame(orbit(0)), W, H, INTR);
  const swinging = guide.update(frame(orbit(14)), W, H, INTR);
  assert.equal(swinging.steady, false);
  assert.equal(MovementGuide.shouldFire(swinging), false, 'fired while still moving');
  // Holding position at the same viewpoint settles it, and then it may fire
  guide.update(frame(orbit(14), { seed: 5 }), W, H, INTR);
  const settled = guide.update(frame(orbit(14), { seed: 6 }), W, H, INTR);
  assert.equal(settled.steady, true);
});

test('the same movement reads smaller in a room, which is why the band is per subject', () => {
  // Displacement is not an angle. The walls of a room are further away and the lens is wider,
  // so ten degrees of movement shifts features about 3% of image width there against about
  // 7% for an object at arm's length. A single fixed band would be wrong for one of them,
  // which is why the caller passes one in.
  const roomIntr = { f: 55, cx: CX, cy: CY };
  const roomAt = (deg) => {
    const a = (deg * Math.PI) / 180;
    const C = [Math.sin(a) * 1.5, 0, Math.cos(a) * 1.5 - 1.25];
    return lookAt(C, [C[0], 0, C[2] + 3], [0, -1, 0]);
  };

  const room = new MovementGuide({ targetPercent: 2.5, warnPercent: 4.5 });
  room.setReference(frame(roomAt(0), { kind: 'room', seed: 1 }), W, H, roomIntr);
  const roomTen = room.update(frame(roomAt(10), { kind: 'room' }), W, H, roomIntr).percent;

  const object = new MovementGuide({ targetPercent: 5, warnPercent: 9 });
  object.setReference(frame(orbit(0), { seed: 1 }), W, H, INTR);
  const objectTen = object.update(frame(orbit(10)), W, H, INTR).percent;

  assert.ok(roomTen < objectTen * 0.75,
    `ten degrees read ${roomTen.toFixed(1)}% in a room against ${objectTen.toFixed(1)}% for an object`);

  // The band the caller supplied still orders the states correctly within the room
  assert.equal(room.update(frame(roomAt(2), { kind: 'room' }), W, H, roomIntr).state, 'approaching');
  assert.equal(room.update(frame(roomAt(10), { kind: 'room' }), W, H, roomIntr).state, 'ready');
  assert.equal(room.update(frame(roomAt(20), { kind: 'room' }), W, H, roomIntr).state, 'far');
});

test('fillFraction stays inside the ring', () => {
  assert.equal(MovementGuide.fillFraction(0, 5), 0);
  assert.equal(MovementGuide.fillFraction(2.5, 5), 0.5);
  assert.equal(MovementGuide.fillFraction(50, 5), 1);
  assert.equal(MovementGuide.fillFraction(NaN, 5), 0);
});
