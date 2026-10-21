/**
 * Animated GIF encoder: median-cut palette per frame (from a 15-bit color
 * histogram), optional ordered dithering, and GIF LZW compression. Frames
 * are added one at a time so memory stays flat.
 */

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5));

/** Byte buffer that grows as needed. */
class Bytes {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }
  _grow(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b) {
    this._grow(1);
    this.buf[this.len++] = b & 0xff;
  }
  word(w) {
    this.byte(w);
    this.byte(w >> 8);
  }
  bytes(arr) {
    this._grow(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  text(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Median-cut palette (up to maxColors) for RGBA pixels. Returns
 * { palette: Uint8Array (rgb triplets), lookup: Int16Array(32768) } where
 * lookup maps a 15-bit color to its palette index (filled lazily, -1 = unset).
 */
export function quantize(rgba, maxColors = 256) {
  const hist = new Uint32Array(32768);
  // Sample at most ~250k pixels; that is plenty for a palette.
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / 250000));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    hist[((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)]++;
  }
  const colors = [];
  for (let c = 0; c < 32768; c++) if (hist[c]) colors.push(c);
  let boxes = [colors];
  const ch = (c, k) => (k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31);
  while (boxes.length < maxColors) {
    // Split the box with the most pixels that still has more than one color.
    let bi = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      let weight = 0;
      for (const c of boxes[i]) weight += hist[c];
      if (weight > best) {
        best = weight;
        bi = i;
      }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const c of box) for (let k = 0; k < 3; k++) {
      const v = ch(c, k);
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
    const axis = [0, 1, 2].reduce((a, k) => (hi[k] - lo[k] > hi[a] - lo[a] ? k : a), 0);
    box.sort((a, b) => ch(a, axis) - ch(b, axis));
    // Split at the weighted median.
    let total = 0;
    for (const c of box) total += hist[c];
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += hist[box[i]];
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    boxes = boxes.filter((b) => b.length);
  }
  const palette = new Uint8Array(Math.max(2, boxes.length) * 3);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const c of box) {
      const k = hist[c];
      r += ((c >> 10) * 8 + 4) * k;
      g += (((c >> 5) & 31) * 8 + 4) * k;
      b += ((c & 31) * 8 + 4) * k;
      w += k;
    }
    palette[i * 3] = Math.round(r / w);
    palette[i * 3 + 1] = Math.round(g / w);
    palette[i * 3 + 2] = Math.round(b / w);
  });
  return { palette, lookup: new Int16Array(32768).fill(-1) };
}

function nearest(palette, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 3) {
    const dr = palette[i] - r;
    const dg = palette[i + 1] - g;
    const db = palette[i + 2] - b;
    const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
    if (d < bestD) {
      bestD = d;
      best = i / 3;
    }
  }
  return best;
}

/** Palette indices for every pixel. dither adds a light ordered pattern. */
export function indexPixels(rgba, width, height, { palette, lookup }, dither = true) {
  const out = new Uint8Array(width * height);
  const amp = dither ? 12 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const d = amp * BAYER4[((y & 3) << 2) | (x & 3)];
      const r = Math.min(255, Math.max(0, rgba[o] + d));
      const g = Math.min(255, Math.max(0, rgba[o + 1] + d));
      const b = Math.min(255, Math.max(0, rgba[o + 2] + d));
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = lookup[key];
      if (idx < 0) {
        idx = nearest(palette, (r & 0xf8) + 4, (g & 0xf8) + 4, (b & 0xf8) + 4);
        lookup[key] = idx;
      }
      out[i] = idx;
    }
  }
  return out;
}

/** GIF LZW compression of palette indices into data sub-blocks. */
export function lzw(indices, minCodeSize, w) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const block = [];
  let cur = 0;
  let bits = 0;
  const flushBlock = () => {
    if (!block.length) return;
    w.byte(block.length);
    w.bytes(block);
    block.length = 0;
  };
  const emit = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block.push(cur & 0xff);
      if (block.length === 255) flushBlock();
      cur >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(cur & 0xff);
  flushBlock();
  w.byte(0);
}

export class GifWriter {
  constructor(width, height, { loop = 0, dither = true } = {}) {
    this.width = width;
    this.height = height;
    this.dither = dither;
    this.shownMs = 0; // time of the frames added so far
    this.shownCs = 0; // the same in the whole hundredths written
    this.w = new Bytes();
    const w = this.w;
    w.text('GIF89a');
    w.word(width);
    w.word(height);
    w.byte(0x00); // no global color table
    w.byte(0);
    w.byte(0);
    if (loop !== null) {
      // Netscape loop extension (0 = forever).
      w.bytes([0x21, 0xff, 0x0b]);
      w.text('NETSCAPE2.0');
      w.bytes([0x03, 0x01]);
      w.word(loop);
      w.byte(0);
    }
  }

  /** Add an RGBA frame shown for delayMs. */
  addFrame(rgba, delayMs) {
    const { width, height, w } = this;
    const q = quantize(rgba, 256);
    const indices = indexPixels(rgba, width, height, q, this.dither);
    const colors = q.palette.length / 3;
    let bitsNeeded = 1;
    while (1 << bitsNeeded < colors) bitsNeeded++;
    // Graphic control: delay in hundredths of a second, rounding the running
    // total so 12 or 15 fps (8.33 or 6.67 each) keep their length.
    this.shownMs += delayMs;
    const delay = Math.max(2, Math.round(this.shownMs / 10) - this.shownCs);
    this.shownCs += delay;
    w.bytes([0x21, 0xf9, 0x04, 0x04]);
    w.word(delay);
    w.byte(0);
    w.byte(0);
    // Image descriptor with a local color table.
    w.byte(0x2c);
    w.word(0);
    w.word(0);
    w.word(width);
    w.word(height);
    w.byte(0x80 | (bitsNeeded - 1));
    const table = new Uint8Array((1 << bitsNeeded) * 3);
    table.set(q.palette);
    w.bytes(table);
    const minCode = Math.max(2, bitsNeeded);
    w.byte(minCode);
    lzw(indices, minCode, w);
  }

  finish() {
    this.w.byte(0x3b);
    return this.w.result();
  }
}
