/**
 * Time stretching that keeps pitch (WSOLA: waveform-similarity overlap-add).
 *
 * Output is built from Hann-windowed grains at a fixed hop. Each grain is
 * read from the source near the position the speed asks for, shifted within
 * a small search range to the offset that best continues the previous
 * grain's waveform, so overlaps add up without phasing or clicks.
 *
 * The stretcher is streaming and random access on the source side: the
 * caller says where every output sample "should" read (posAt) and supplies
 * a reader, so the offline mix can feed it straight from its decode window
 * in chunks of any size.
 */

/** Linear-interpolated read of count samples from src at fractional pos by step (zero outside). */
export function readLinear(src, len, pos, step, count, out = new Float32Array(count)) {
  let p = pos;
  for (let i = 0; i < count; i++, p += step) {
    const k = Math.floor(p);
    if (k < 0 || k >= len) {
      out[i] = k === -1 && len > 0 ? src[0] * (p - k) : 0;
      continue;
    }
    const a = src[k];
    out[i] = k + 1 < len ? a + (src[k + 1] - a) * (p - k) : a;
  }
  return out;
}

export class WsolaStretcher {
  /**
   * sampleRate: output rate. grainMs: grain length; searchMs: how far a
   * grain may move from its ideal position to match the waveform.
   */
  constructor(sampleRate, { grainMs = 40, searchMs = 12 } = {}) {
    this.N = Math.max(64, Math.round((grainMs * sampleRate) / 1000 / 2) * 2);
    this.hs = this.N / 2;
    this.D = Math.max(8, Math.round((searchMs * sampleRate) / 1000));
    this.win = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N);
    this.acc = [new Float64Array(this.N * 4), new Float64Array(this.N * 4)];
    this.accStart = 0;
    this.nextG = null;
    this.prevA = null;
    this.expectG = null;
    this.ref = new Float32Array(this.hs);
    this.cand = new Float32Array(this.hs + 2 * this.D);
    this.tmp = new Float32Array(Math.max(this.N, this.hs + 2 * this.D));
  }

  /** Source samples a caller must keep before the ideal position of the next output (window margin). */
  get lookBehind() {
    return this.N + 2 * this.D + 4;
  }

  get lookAhead() {
    return 2 * this.N + 2 * this.D + 4;
  }

  /**
   * Output samples for global output indices [g, g + n) as [L, R].
   *  posAt(g) -> ideal source position (fractional source samples)
   *  step     -> source samples per output sample at normal pitch
   *  read(ch, pos, step, count, out) -> fills out from source channel ch
   *  nch      -> source channel count (1 feeds both outputs)
   * Calls must continue where the last one ended; anything else restarts.
   */
  generate(g, n, posAt, step, read, nch) {
    if (this.expectG !== g) this._restart(g);
    const end = g + n;
    while (this.nextG < end) {
      this._grain(this.nextG, posAt, step, read, nch);
      this.nextG += this.hs;
    }
    const off = g - this.accStart;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = this.acc[0][off + i];
      R[i] = this.acc[1][off + i];
    }
    // Drop what has been handed out; keep partial sums of later grains.
    const keep = end - this.accStart;
    for (const a of this.acc) {
      a.copyWithin(0, keep);
      a.fill(0, a.length - keep);
    }
    this.accStart = end;
    this.expectG = end;
    return [L, R];
  }

  _restart(g) {
    this.nextG = g - this.hs;
    this.accStart = this.nextG;
    this.prevA = null;
    for (const a of this.acc) a.fill(0);
  }

  _ensure(len) {
    if (this.acc[0].length >= len) return;
    let size = this.acc[0].length;
    while (size < len) size *= 2;
    this.acc = this.acc.map((a) => {
      const b = new Float64Array(size);
      b.set(a);
      return b;
    });
  }

  /** Mono (summed) read for the similarity search. */
  _mono(read, nch, pos, step, count, out) {
    read(0, pos, step, count, out);
    if (nch > 1) {
      const t = this.tmp;
      read(1, pos, step, count, t);
      for (let i = 0; i < count; i++) out[i] += t[i];
    }
    return out;
  }

  _grain(G, posAt, step, read, nch) {
    const { N, hs, D } = this;
    // A grain is heard mostly around its middle (the window's peak): line that up with
    // where the speed puts it. Anchoring its start instead put sped-up sound late and
    // slowed-down sound early, by up to half a grain.
    const ideal = posAt(G + hs) - hs * step;
    let a = ideal;
    if (this.prevA !== null) {
      const natural = this.prevA + hs * step;
      // Natural continuation already sits on the ideal grid (speed 1): nothing to search.
      if (Math.abs(natural - ideal) > 0.5 * step) {
        const ref = this._mono(read, nch, natural, step, hs, this.ref);
        const lo = ideal - D * step;
        const cand = this._mono(read, nch, lo, step, hs + 2 * D, this.cand);
        const score = (l, stride) => {
          let c = 0;
          let e = 0;
          for (let j = 0; j < hs; j += stride) {
            const v = cand[l + j];
            c += ref[j] * v;
            e += v * v;
          }
          return e > 1e-12 ? c / Math.sqrt(e) : 0;
        };
        let best = D;
        let bestS = score(D, 4);
        for (let l = 0; l <= 2 * D; l += 4) {
          const s = score(l, 4);
          if (s > bestS + 1e-9) {
            bestS = s;
            best = l;
          }
        }
        const c0 = best;
        bestS = score(c0, 1);
        for (let l = Math.max(0, c0 - 3); l <= Math.min(2 * D, c0 + 3); l++) {
          if (l === c0) continue;
          const s = score(l, 1);
          if (s > bestS + 1e-9) {
            bestS = s;
            best = l;
          }
        }
        a = lo + best * step;
      } else a = natural;
    }
    this.prevA = a;
    const off = G - this.accStart;
    this._ensure(off + N);
    const buf = this.tmp;
    for (let c = 0; c < 2; c++) {
      read(Math.min(c, nch - 1), a, step, N, buf);
      const acc = this.acc[c];
      for (let i = 0; i < N; i++) acc[off + i] += buf[i] * this.win[i];
    }
  }
}

/**
 * Whole-buffer convenience: play channels (Float32Array[]) at speed while
 * keeping pitch. Returns new channels of length round(len / speed).
 */
export function stretchBuffer(channels, sampleRate, speed) {
  const len = channels[0]?.length || 0;
  const outLen = Math.round(len / speed);
  const st = new WsolaStretcher(sampleRate);
  const read = (ch, pos, step, count, out) => readLinear(channels[ch], len, pos, step, count, out);
  const [L, R] = st.generate(0, outLen, (g) => g * speed, 1, read, channels.length);
  return channels.length > 1 ? [L, R] : [L];
}
