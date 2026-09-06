// Minimal EXIF reader: extracts the 35mm-equivalent focal length from a JPEG so that
// imported photos get a sensible field of view.

export async function readExifFov(blob) {
  try {
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < dv.byteLength) {
      const marker = dv.getUint16(off);
      const len = dv.getUint16(off + 2);
      if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) { // "Exif"
        return parseTiff(dv, off + 10);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch { /* not a JPEG or malformed EXIF */ }
  return null;
}

function parseTiff(dv, base) {
  const little = dv.getUint16(base) === 0x4949;
  const u16 = (o) => dv.getUint16(base + o, little), u32 = (o) => dv.getUint32(base + o, little);
  if (u16(2) !== 42) return null;
  const readIfd = (offset, wanted) => {
    const out = {};
    const n = u16(offset);
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (!wanted.has(tag)) continue;
      const bytes = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1;
      const valOff = count * bytes > 4 ? u32(e + 8) : e + 8;
      if (type === 3) out[tag] = u16(valOff);
      else if (type === 4) out[tag] = u32(valOff);
      else if (type === 5) { const num = u32(valOff), den = u32(valOff + 4); out[tag] = den ? num / den : 0; }
    }
    return out;
  };
  const ifd0 = readIfd(u32(4), new Set([0x8769, 0x0112]));
  if (!ifd0[0x8769]) return null;
  const exif = readIfd(ifd0[0x8769], new Set([0xa405, 0x920a]));
  const f35 = exif[0xa405];
  if (f35 && f35 > 0) {
    // 35mm frame is 36mm wide: horizontal FOV of the long image side
    return { hfov: (2 * Math.atan(18 / f35) * 180) / Math.PI, focal35: f35, orientation: ifd0[0x0112] || 1 };
  }
  return null;
}
