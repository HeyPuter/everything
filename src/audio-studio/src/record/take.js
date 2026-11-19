// A growing recording ("take"): captured blocks are appended into
// fixed-size buffers that become immutable Blocks once full, so the live view
// and the final document share the same sample memory without copies. Only
// the part of the open tail buffer that is already written is ever exposed,
// and it is never written again, which keeps Blocks immutable.

import { Block, BLOCK, Channel } from '../audio/channel.js';
import * as E from '../model/edits.js';

export class Take {
  /**
   * @param {number} channels output channel count
   * @param {{ skip?: number, limit?: number, blockSize?: number }} [o]
   *   skip:  frames to drop from the start (latency compensation)
   *   limit: stop accepting frames after this many (punch-out)
   */
  constructor(channels, { skip = 0, limit = Infinity, blockSize = BLOCK } = {}) {
    this.channels = channels;
    this.skip = Math.max(0, Math.round(skip));
    this.limit = limit;
    this.size = blockSize;
    this.done = Array.from({ length: channels }, () => []); // completed pieces per channel
    this.tail = Array.from({ length: channels }, () => new Float32Array(blockSize));
    this.fill = 0;
    this.length = 0;
    this.peak = 0;
  }

  get full() {
    return this.length >= this.limit;
  }

  /**
   * Appends planar input (any channel count): mono input fills every
   * channel, extra input channels are averaged into a mono take.
   * Returns the number of frames kept.
   */
  append(input) {
    if (!input?.length) return 0;
    let n = input[0].length;
    let from = 0;
    if (this.skip > 0) {
      const drop = Math.min(this.skip, n);
      this.skip -= drop;
      from = drop;
    }
    n = Math.min(n - from, this.limit - this.length);
    if (n <= 0) return 0;
    const src = mapInput(input, this.channels, from, n);
    let at = 0;
    while (at < n) {
      const take = Math.min(n - at, this.size - this.fill);
      for (let c = 0; c < this.channels; c++) {
        const s = src[c];
        const t = this.tail[c];
        for (let i = 0; i < take; i++) {
          const v = s[at + i];
          t[this.fill + i] = v;
          const a = v < 0 ? -v : v;
          if (a > this.peak) this.peak = a;
        }
      }
      this.fill += take;
      at += take;
      if (this.fill === this.size) this.#seal();
    }
    this.length += n;
    return n;
  }

  #seal() {
    for (let c = 0; c < this.channels; c++) {
      this.done[c].push({ block: new Block(this.tail[c]), offset: 0, length: this.fill });
      this.tail[c] = new Float32Array(this.size);
    }
    this.fill = 0;
  }

  /** The take so far as Channels (shares memory; cheap to call repeatedly). */
  toChannels() {
    return Array.from({ length: this.channels }, (_, c) => {
      const pieces = this.done[c].slice();
      if (this.fill) pieces.push({ block: new Block(this.tail[c].subarray(0, this.fill)), offset: 0, length: this.fill });
      return new Channel(pieces);
    });
  }
}

/** Maps captured channels onto `count` take channels for frames [from, from + n). */
export function mapInput(input, count, from = 0, n = input[0].length - from) {
  const slice = (a) => (from === 0 && n === a.length ? a : a.subarray(from, from + n));
  if (input.length === count) return input.map(slice);
  if (count === 1) {
    const out = new Float32Array(n);
    const k = 1 / input.length;
    for (const ch of input) {
      const s = slice(ch);
      for (let i = 0; i < n; i++) out[i] += s[i] * k;
    }
    return [out];
  }
  return Array.from({ length: count }, (_, c) => slice(input[Math.min(c, input.length - 1)]));
}

/**
 * The document state with a take placed at `at`:
 *   insert (replace null): the take is inserted and later audio moves right
 *   punch (replace = [start, end]): the take overwrites audio from `start`,
 *   never past `end` (the punch-out point); length and markers are kept
 *   overwrite: the take replaces audio from `at`, and the file grows when it
 *   runs past the end
 * Punch and overwrite record only into the channels `mask` leaves enabled (null: all);
 * the others keep their audio (and get silence where the file grows).
 */
export function placeTake(base, recorded, { at = 0, replace = null, overwrite = false, mask = null } = {}) {
  const n = recorded[0]?.length ?? 0;
  if (!n) return base;
  const on = (i) => !mask || mask[i] !== false;
  if (overwrite && !replace) {
    const len = base.channels[0]?.length ?? 0;
    const start = Math.min(at, len);
    const grow = Math.max(0, start + n - len);
    return {
      ...base,
      channels: base.channels.map((c, i) => (on(i) ? c.splice(start, Math.min(len, start + n), recorded[Math.min(i, recorded.length - 1)]) : grow ? c.concat(Channel.silence(grow)) : c)),
    };
  }
  if (replace) {
    const start = replace[0];
    const len = Math.min(n, replace[1] - start);
    return {
      ...base,
      channels: base.channels.map((c, i) => (on(i) ? c.splice(start, start + len, recorded[Math.min(i, recorded.length - 1)].slice(0, len)) : c)),
    };
  }
  return E.insertClip(base, at, { channels: recorded });
}

/** Default name for a new recording: "Recording 2026-10-10 14.05.09". */
export function recordingName(date = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `Recording ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
}
