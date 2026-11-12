// Immutable channel storage: a list of pieces that reference ranges of shared,
// never-mutated Float32Array blocks. Cut, copy, paste, insert and delete only
// rearrange piece references, so undo snapshots cost almost nothing and a
// multi-hour file can be edited without copying its samples. Processing a range
// writes new blocks for that range only.

export const BLOCK = 1 << 16; // frames per newly written block

let nextBlockId = 1;

/** A sample block. `data` must never be written after construction. */
export class Block {
  constructor(data) {
    this.id = nextBlockId++;
    this.data = data;
    /** Lazily built min/max levels for waveform drawing, see peaks.js. */
    this.peaks = null;
  }
}

/** One reference into a block: frames [offset, offset + length) of block.data. */
function piece(block, offset, length) {
  return { block, offset, length };
}

export class Channel {
  /** @param {{block: Block, offset: number, length: number}[]} pieces */
  constructor(pieces = []) {
    this.pieces = pieces.filter((p) => p.length > 0);
    this.starts = new Float64Array(this.pieces.length + 1);
    let at = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      this.starts[i] = at;
      at += this.pieces[i].length;
    }
    this.starts[this.pieces.length] = at;
    this.length = at;
  }

  static empty() {
    return new Channel([]);
  }

  /** Wraps samples into blocks of at most BLOCK frames. The array is adopted, not copied. */
  static fromSamples(samples) {
    const pieces = [];
    for (let at = 0; at < samples.length; at += BLOCK) {
      const len = Math.min(BLOCK, samples.length - at);
      const data = at === 0 && len === samples.length ? samples : samples.subarray(at, at + len);
      pieces.push(piece(new Block(data), 0, len));
    }
    return new Channel(pieces);
  }

  static silence(frames) {
    if (frames <= 0) return Channel.empty();
    // One shared zero block serves every silent range.
    const zero = silentBlock();
    const pieces = [];
    for (let at = 0; at < frames; at += BLOCK) pieces.push(piece(zero, 0, Math.min(BLOCK, frames - at)));
    return new Channel(pieces);
  }

  /** Index of the piece containing frame `at` (at < length). */
  pieceIndex(at) {
    const s = this.starts;
    let lo = 0;
    let hi = this.pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Frames [start, end) as a new channel sharing the same blocks. */
  slice(start, end = this.length) {
    start = Math.max(0, Math.min(this.length, Math.floor(start)));
    end = Math.max(start, Math.min(this.length, Math.floor(end)));
    if (start === 0 && end === this.length) return this;
    if (start === end) return Channel.empty();
    const out = [];
    let i = this.pieceIndex(start);
    let at = start;
    while (at < end) {
      const p = this.pieces[i];
      const inPiece = at - this.starts[i];
      const take = Math.min(p.length - inPiece, end - at);
      out.push(piece(p.block, p.offset + inPiece, take));
      at += take;
      i++;
    }
    return new Channel(out);
  }

  concat(...others) {
    const pieces = this.pieces.slice();
    for (const o of others) pieces.push(...o.pieces);
    return new Channel(pieces);
  }

  /** Removes [start, end) and inserts `insert` (a Channel) at start. */
  splice(start, end, insert = Channel.empty()) {
    return this.slice(0, start).concat(insert, this.slice(end));
  }

  /** Copies frames [start, start + out.length) into `out`; frames past the end read as 0. */
  read(start, out, outOffset = 0, count = out.length - outOffset) {
    let written = 0;
    if (start < 0) {
      const pad = Math.min(count, -start);
      out.fill(0, outOffset, outOffset + pad);
      written = pad;
      start = 0;
    }
    if (start < this.length && written < count) {
      let i = this.pieceIndex(start);
      let at = start;
      while (written < count && i < this.pieces.length) {
        const p = this.pieces[i];
        const inPiece = at - this.starts[i];
        const take = Math.min(p.length - inPiece, count - written);
        const src = p.block.data;
        const from = p.offset + inPiece;
        out.set(src.subarray(from, from + take), outOffset + written);
        written += take;
        at += take;
        i++;
      }
    }
    if (written < count) out.fill(0, outOffset + written, outOffset + count);
    return out;
  }

  /** Frames [start, end) as one Float32Array (a copy). */
  toArray(start = 0, end = this.length) {
    const out = new Float32Array(Math.max(0, end - start));
    return this.read(start, out);
  }

  /** Replaces [start, start + samples.length) with `samples` (adopted). */
  write(start, samples) {
    return this.splice(start, start + samples.length, Channel.fromSamples(samples));
  }

  /** Visits contiguous runs of [start, end): fn(subarray, frameIndex). No copies. */
  forEachRun(start, end, fn) {
    start = Math.max(0, start);
    end = Math.min(this.length, end);
    if (start >= end) return;
    let i = this.pieceIndex(start);
    let at = start;
    while (at < end) {
      const p = this.pieces[i];
      const inPiece = at - this.starts[i];
      const take = Math.min(p.length - inPiece, end - at);
      fn(p.block.data.subarray(p.offset + inPiece, p.offset + inPiece + take), at);
      at += take;
      i++;
    }
  }

  /**
   * This channel, with pieces of large sample buffers it uses only a small part of copied
   * into buffers of their own. Processing writes a range as blocks that share one buffer, so a
   * second kept from a processed hour would otherwise hold the whole hour in memory after
   * undo history lets go of it. Buffers under `minBytes`, or a quarter used, are kept.
   */
  compact(minBytes = 1 << 20) {
    const used = new Map();
    for (const p of this.pieces) {
      const buf = p.block.data.buffer;
      used.set(buf, (used.get(buf) || 0) + p.length * p.block.data.BYTES_PER_ELEMENT);
    }
    let copied = false;
    const pieces = this.pieces.map((p) => {
      const buf = p.block.data.buffer;
      if (buf.byteLength < minBytes || used.get(buf) * 4 > buf.byteLength) return p;
      copied = true;
      return piece(new Block(p.block.data.slice(p.offset, p.offset + p.length)), 0, p.length);
    });
    return copied ? new Channel(pieces) : this;
  }

  /** Bytes held by distinct blocks referenced here (for memory display). */
  bytes(seen = new Set()) {
    let total = 0;
    for (const p of this.pieces) {
      if (seen.has(p.block)) continue;
      seen.add(p.block);
      total += p.block.data.byteLength;
    }
    return total;
  }
}

let zeroBlock = null;
function silentBlock() {
  if (!zeroBlock) zeroBlock = new Block(new Float32Array(BLOCK));
  return zeroBlock;
}
