// An animated GIF encoder: median-cut palettes per frame, LZW compression,
// a looping application extension, and frame differencing so a slide that
// holds still costs one frame however long it shows.
//
//   const gif = new GifEncoder(width, height, { loop: 0 });
//   gif.addFrame(rgba, delayMs);   // RGBA bytes, as canvas ImageData holds
//   const bytes = gif.finish();

class ByteSink {
  constructor() {
    this.buffer = new Uint8Array(1 << 16);
    this.length = 0;
  }
  ensure(n) {
    if (this.length + n <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }
  byte(b) {
    this.ensure(1);
    this.buffer[this.length++] = b & 0xff;
  }
  word(w) {
    this.byte(w & 0xff);
    this.byte((w >> 8) & 0xff);
  }
  bytes(list) {
    this.ensure(list.length);
    this.buffer.set(list, this.length);
    this.length += list.length;
  }
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result() {
    return this.buffer.slice(0, this.length);
  }
}

// Median cut over a 5-bit-per-channel histogram. Returns up to `max`
// colors as [r, g, b] and a function mapping a pixel to its palette index.
export function quantize(rgba, max = 256) {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < rgba.length; i += 4) {
    const key =
      ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    hist[key]++;
  }
  const colors = [];
  for (let key = 0; key < 32768; key++) if (hist[key]) colors.push(key);
  let boxes = [colors];
  const channel = (key, c) => (key >> (10 - c * 5)) & 31;
  const range = (box) => {
    let best = 0,
      span = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 31,
        hi = 0;
      for (const key of box) {
        const v = channel(key, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > span) {
        span = hi - lo;
        best = c;
      }
    }
    return { c: best, span };
  };
  while (boxes.length < max) {
    // Split the box with the most pixels that still spans more than one bin.
    let pick = -1,
      weight = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      let w = 0;
      for (const key of box) w += hist[key];
      if (w > weight) {
        weight = w;
        pick = i;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const { c } = range(box);
    box.sort((a, b) => channel(a, c) - channel(b, c));
    let half = weight / 2,
      cut = 0;
    for (; cut < box.length - 1; cut++) {
      half -= hist[box[cut]];
      if (half <= 0) break;
    }
    cut = Math.max(1, Math.min(box.length - 1, cut + 1));
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = [];
  const lookup = new Int16Array(32768).fill(-1);
  for (const box of boxes) {
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (const key of box) {
      const w = hist[key];
      r += (channel(key, 0) * 8 + 4) * w;
      g += (channel(key, 1) * 8 + 4) * w;
      b += (channel(key, 2) * 8 + 4) * w;
      n += w;
    }
    const index = palette.length;
    palette.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    for (const key of box) lookup[key] = index;
  }
  if (!palette.length) palette.push([0, 0, 0]);
  const map = (r, g, b) => {
    const index = lookup[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    return index < 0 ? 0 : index;
  };
  return { palette, map };
}

// GIF's variable-length LZW, packed into sub-blocks of at most 255 bytes.
export function lzwEncode(indices, minCodeSize, sink) {
  sink.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map();
  let block = [];
  let acc = 0,
    bits = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) {
        sink.byte(255);
        sink.bytes(block);
        block = [];
      }
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
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
      next = end + 1;
    }
    prefix = k;
  }
  if (indices.length) emit(prefix);
  emit(end);
  if (bits > 0) block.push(acc & 0xff);
  if (block.length) {
    sink.byte(block.length);
    sink.bytes(block);
  }
  sink.byte(0);
}

export class GifEncoder {
  constructor(width, height, { loop = 0 } = {}) {
    this.width = width;
    this.height = height;
    this.sink = new ByteSink();
    this.pending = null;
    this.previous = null;
    const s = this.sink;
    s.ascii("GIF89a");
    s.word(width);
    s.word(height);
    s.byte(0x00); // no global color table; each frame has its own
    s.byte(0);
    s.byte(0);
    if (loop !== null) {
      s.byte(0x21);
      s.byte(0xff);
      s.byte(11);
      s.ascii("NETSCAPE2.0");
      s.byte(3);
      s.byte(1);
      s.word(loop);
      s.byte(0);
    }
  }
  addFrame(rgba, delayMs) {
    const frame = { rgba: new Uint8Array(rgba), delay: delayMs };
    if (this.pending && sameImage(this.pending.rgba, frame.rgba)) {
      this.pending.delay += delayMs;
      return;
    }
    if (this.pending) this.#write(this.pending);
    this.pending = frame;
  }
  #write(frame) {
    const { width, height } = this;
    // Only the rectangle that changed since the last frame written is drawn;
    // the rest of the previous frame stays on screen.
    let x0 = 0,
      y0 = 0,
      x1 = width - 1,
      y1 = height - 1;
    if (this.previous) {
      const box = changedBox(this.previous, frame.rgba, width, height);
      if (box) [x0, y0, x1, y1] = box;
      else [x0, y0, x1, y1] = [0, 0, 0, 0];
    }
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1;
    const region = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      region.set(
        frame.rgba.subarray(
          ((y0 + y) * width + x0) * 4,
          ((y0 + y) * width + x1 + 1) * 4,
        ),
        y * w * 4,
      );
    const { palette, map } = quantize(region, 256);
    let bitsPer = 1;
    while (1 << bitsPer < palette.length) bitsPer++;
    const indices = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++)
      indices[i] = map(region[i * 4], region[i * 4 + 1], region[i * 4 + 2]);
    const s = this.sink;
    // Graphic control: delay in hundredths of a second; leave in place.
    s.byte(0x21);
    s.byte(0xf9);
    s.byte(4);
    s.byte(0x04);
    s.word(Math.max(2, Math.min(65535, Math.round(frame.delay / 10))));
    s.byte(0);
    s.byte(0);
    // Image descriptor with a local color table.
    s.byte(0x2c);
    s.word(x0);
    s.word(y0);
    s.word(w);
    s.word(h);
    s.byte(0x80 | (bitsPer - 1));
    for (let i = 0; i < 1 << bitsPer; i++) {
      const c = palette[i] || [0, 0, 0];
      s.byte(c[0]);
      s.byte(c[1]);
      s.byte(c[2]);
    }
    lzwEncode(indices, Math.max(2, bitsPer), s);
    this.previous = frame.rgba;
  }
  finish() {
    if (this.pending) this.#write(this.pending);
    this.pending = null;
    this.sink.byte(0x3b);
    return this.sink.result();
  }
}

function sameImage(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function changedBox(a, b, width, height) {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
