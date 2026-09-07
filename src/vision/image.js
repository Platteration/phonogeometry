// Basic image utilities operating on single-channel Float32 images.

/** RGBA Uint8 -> grayscale Float32 (0..255). */
export function rgbaToGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return g;
}

/** Area-averaging downscale of a single channel image to (nw, nh). */
export function resizeGray(src, w, h, nw, nh) {
  if (nw === w && nh === h) return Float32Array.from(src);
  const out = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = Math.min(h, (y + 1) * sy);
    const iy0 = Math.floor(y0), iy1 = Math.ceil(y1);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = Math.min(w, (x + 1) * sx);
      const ix0 = Math.floor(x0), ix1 = Math.ceil(x1);
      let sum = 0, wsum = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          sum += src[yy * w + xx] * wgt;
          wsum += wgt;
        }
      }
      out[y * nw + x] = wsum > 0 ? sum / wsum : 0;
    }
  }
  return out;
}

/** Area-averaging downscale of an RGBA image. Returns Uint8ClampedArray RGBA. */
export function resizeRGBA(src, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = Math.min(h, (y + 1) * sy);
    const iy0 = Math.floor(y0), iy1 = Math.ceil(y1);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = Math.min(w, (x + 1) * sx);
      const ix0 = Math.floor(x0), ix1 = Math.ceil(x1);
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy, p = (yy * w + xx) * 4;
          r += src[p] * wgt; g += src[p + 1] * wgt; b += src[p + 2] * wgt;
          wsum += wgt;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = 255;
    }
  }
  return out;
}

/** Separable Gaussian blur with the given sigma. */
export function gaussianBlur(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0) xx = -xx;
        if (xx >= w) xx = 2 * w - xx - 2;
        s += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0) yy = -yy;
        if (yy >= h) yy = 2 * h - yy - 2;
        s += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * Box-filter sum over a (2r+1)^2 window using two sliding passes.
 * Pixels outside the image contribute zero (result is a plain sum, not a mean).
 */
export function boxSum(src, w, h, r, out) {
  const tmp = new Float32Array(w * h);
  out = out || new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      const add = x + r + 1, rem = x - r;
      if (add < w) s += src[row + add];
      if (rem >= 0) s -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      const add = y + r + 1, rem = y - r;
      if (add < h) s += tmp[add * w + x];
      if (rem >= 0) s -= tmp[rem * w + x];
    }
  }
  return out;
}

/** Bilinear sample; returns NaN outside the image. */
export function sampleBilinear(img, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const a = img[y0 * w + x0], b = img[y0 * w + x1];
  const c = img[y1 * w + x0], d = img[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** 3x3 median filter of a depth map, treating 0 as missing. */
export function medianFilterDepth(depth, w, h) {
  const out = new Float32Array(w * h);
  const buf = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = depth[yy * w + xx];
          if (v > 0) buf[n++] = v;
        }
      }
      if (n < 4 || depth[y * w + x] === 0) { out[y * w + x] = 0; continue; }
      const arr = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      out[y * w + x] = arr[Math.floor(n / 2)];
    }
  }
  return out;
}

/**
 * Resample a radially distorted image onto the ideal pinhole grid with the same
 * intrinsics (inverse mapping, bilinear). Pixels without a source are set to 0.
 */
export function undistortGray(gray, w, h, f, cx, cy, k1) {
  if (!k1) return gray;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ny = (y - cy) / f;
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / f;
      const D = 1 + k1 * (nx * nx + ny * ny);
      const v = sampleBilinear(gray, w, h, cx + f * nx * D, cy + f * ny * D);
      out[y * w + x] = Number.isNaN(v) ? 0 : v;
    }
  }
  return out;
}

export function undistortRGBA(rgba, w, h, f, cx, cy, k1) {
  if (!k1) return rgba;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ny = (y - cy) / f;
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / f;
      const D = 1 + k1 * (nx * nx + ny * ny);
      const sx = Math.round(cx + f * nx * D), sy = Math.round(cy + f * ny * D);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const si = (sy * w + sx) * 4, di = (y * w + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}
