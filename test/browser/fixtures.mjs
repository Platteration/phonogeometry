// Renders synthetic photographs to PNG files for the browser tests, so they exercise the
// real import path (decode, EXIF, resize) rather than injecting pixels directly.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { renderObject, renderFurnishedRoom } from '../synthScene.js';
import { lookAt } from '../helpers.js';
import { rgbaToGray, gaussianBlur } from '../../src/vision/image.js';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function blur(rgba, w, h, sigma) {
  const out = Uint8ClampedArray.from(rgba);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = out[i * 4 + c];
    const b = gaussianBlur(ch, w, h, sigma);
    for (let i = 0; i < w * h; i++) out[i * 4 + c] = b[i];
  }
  return out;
}

/** Views around a textured object. Pass blurFrame to soften one of them. */
export function writeObjectScan(dir, { count = 8, blurFrame = -1 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const w = 640, h = 480, f = (w / 2) / Math.tan((69 * Math.PI) / 360), cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let i = 0; i < count; i++) {
    const ang = -0.55 + i * (1.1 / (count - 1));
    const dist = 2.8 + 0.25 * Math.sin(i * 1.3);
    const cam = lookAt([Math.sin(ang) * dist, 0.3 * Math.sin(i), -Math.cos(ang) * dist], [0, 0, 0]);
    const r = renderObject(cam, w, h, f, cx, cy, 1, 3);
    const rgba = i === blurFrame ? blur(r.rgba, w, h, 3) : r.rgba;
    fs.writeFileSync(`${dir}/photo-${i}.png`, png(w, h, rgba));
  }
  return { count, blurFrame };
}

/** A scan that cannot work: photographs taken without moving, so there is no parallax. */
export function writeStandingStillScan(dir, { count = 5 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const w = 320, h = 240, f = 300, cx = (w - 1) / 2, cy = (h - 1) / 2;
  for (let i = 0; i < count; i++) {
    const cam = lookAt([0.0015 * i, 0.001 * Math.sin(i), -3], [0, 0, 0]);
    const r = renderObject(cam, w, h, f, cx, cy, 1, 3);
    fs.writeFileSync(`${dir}/still-${i}.png`, png(w, h, r.rgba));
  }
  return { count };
}

export { renderFurnishedRoom, rgbaToGray };
