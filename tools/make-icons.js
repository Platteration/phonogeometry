// Generates the PWA icons (PNG) without any image dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Icon: dark rounded square, an amber wireframe diamond (◈) with a lighter inner facet.
function pixel(size) {
  const c = size / 2, R = size * 0.42, inner = size * 0.2, stroke = Math.max(2, size * 0.035);
  const corner = size * 0.18;
  return (x, y) => {
    const dx = Math.abs(x - c), dy = Math.abs(y - c);
    // rounded-square background
    const qx = Math.max(0, dx - (c - corner)), qy = Math.max(0, dy - (c - corner));
    if (Math.hypot(qx, qy) > corner) return [0, 0, 0, 0];
    const d = dx + dy; // L1 diamond
    let col = [15, 17, 21, 255];
    if (Math.abs(d - R) < stroke) col = [255, 180, 84, 255];
    else if (d < R && Math.abs(d - inner) < stroke * 0.8) col = [158, 203, 255, 255];
    else if (d < inner) col = [255, 180, 84, 90];
    else if (d < R) {
      const shade = 0.5 + 0.5 * ((y - x) / size);
      col = [Math.round(30 + 40 * shade), Math.round(34 + 40 * shade), Math.round(44 + 40 * shade), 255];
    }
    return col;
  };
}

fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(root, 'icons', `icon-${size}.png`), png(size, pixel(size)));
  console.log(`icons/icon-${size}.png`);
}
