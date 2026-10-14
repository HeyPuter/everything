// Tempo map: converts between song ticks and seconds when tempo automation
// clips change the tempo over time. Pure math with no project lookups, so the
// AudioWorklet, the offline render worker and the UI (transport clock, M:S
// display, durations) share one implementation and agree to the sample.
//
//   const data = tempoPieces(bpm, clips)    // plain data (postable to the audio thread)
//   const map = new TempoMap(data)          // or new TempoMap(bpm) for a constant tempo
//   map.seconds(tick) / map.ticks(seconds) / map.bpmAt(tick) / map.constant
//
// The map is a list of pieces covering [0, infinity): piece i starts at tick
// T[i] with tempo B0[i] and reaches B1[i] at T[i + 1], linearly in ticks (the
// last piece holds its tempo forever). With bpm(t) = B0 + k (t - T0), the time
// spent in a piece is the exact integral
//   sec(t) = 60 / (PPQ k) * ln(bpm(t) / B0)      (dt * 60 / (PPQ B0) when k is 0)
// and its inverse
//   t = T0 + B0 (e^(k PPQ s / 60) - 1) / k.
// Linear tempo ramps are therefore exact; curved automation segments
// (automation/evaluate.js curveShape) are split into short linear pieces (at
// most CURVE_STEP ticks, at least 8 per segment): the realized tempo stays
// within 0.01 BPM of the drawn curve, about a sample of drift over a
// four-bar sweep. Playback, renders and the UI all use the same pieces, so
// they agree exactly. Ticks before 0 extrapolate the first piece's tempo.
//
// tempoPieces(bpm, clips) builds the pieces from tempo automation clips:
// [{ start, end, offset, points }] (song ticks; points as in evaluate.js, v
// normalized and mapped linearly to TEMPO_MIN..TEMPO_MAX). Where clips
// overlap, the one that starts first wins (as for every automation lane in
// the sequencer); outside clips the tempo is `bpm`.

import { curveShape } from '../automation/evaluate.js';

const PPQ = 96;
/** Tempo automation range in BPM (automation/targets.js TEMPO_PARAM). */
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;
/** Longest linear piece used to follow a curved tempo segment, in ticks. */
export const CURVE_STEP = 2;
const MAX_CURVE_PIECES = 2048;

/** BPM for a normalized tempo automation value. */
export function tempoFromNorm(v) {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  return TEMPO_MIN + (TEMPO_MAX - TEMPO_MIN) * x;
}

/** Normalized automation value for a BPM (clamped to the range). */
export function tempoToNorm(bpm) {
  const x = (bpm - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pieces { bpm, tick, b0, b1 } (typed arrays) for the project tempo `bpm`
 * and the tempo automation clips.
 */
export function tempoPieces(bpm, clips = []) {
  const T = [];
  const B0 = [];
  const B1 = [];
  const push = (t, b0, b1) => {
    const n = T.length;
    // Drop empty pieces and merge equal constant runs.
    if (n && T[n - 1] === t) {
      T.pop();
      B0.pop();
      B1.pop();
    }
    const m = T.length;
    if (m && B0[m - 1] === B1[m - 1] && B1[m - 1] === b0 && b0 === b1) return;
    T.push(t);
    B0.push(b0);
    B1.push(b1);
  };
  const sorted = clips.filter((c) => c && c.end > c.start && c.points?.length).sort((a, b) => a.start - b.start);
  let cursor = 0;
  let covered = -Infinity;
  for (const c of sorted) {
    const a = Math.max(c.start, covered, 0);
    const b = c.end;
    covered = Math.max(covered, c.end);
    if (b <= a) continue;
    if (a > cursor) push(cursor, bpm, bpm);
    clipPieces(c, a, b, push);
    cursor = b;
  }
  push(cursor, bpm, bpm);
  return { bpm, tick: Float64Array.from(T), b0: Float64Array.from(B0), b1: Float64Array.from(B1) };
}

/** Pushes the pieces of one clip inside its active range [a, b). */
function clipPieces(c, a, b, push) {
  const P = c.points;
  const base = c.start - (c.offset || 0); // song tick of local time 0
  const n = P.length;
  const at = (i) => base + P[i].t;
  // Before the first point: hold its value.
  if (a < at(0)) push(a, tempoFromNorm(P[0].v), tempoFromNorm(P[0].v));
  for (let i = 0; i + 1 < n; i++) {
    const s0 = at(i);
    const s1 = at(i + 1);
    if (s1 <= s0) continue;
    const x0 = Math.max(a, s0);
    const x1 = Math.min(b, s1);
    if (x1 <= x0) continue;
    const v0 = P[i].v;
    const v1 = P[i + 1].v;
    const c0 = P[i].c || 0;
    const value = (x) => tempoFromNorm(v0 + (v1 - v0) * curveShape((x - s0) / (s1 - s0), c0));
    if (!c0 || v0 === v1) {
      push(x0, value(x0), value(x1));
      continue;
    }
    const pieces = Math.min(MAX_CURVE_PIECES, Math.max(8, Math.ceil((x1 - x0) / CURVE_STEP)));
    let prev = value(x0);
    for (let k = 0; k < pieces; k++) {
      const t0 = x0 + ((x1 - x0) * k) / pieces;
      const t1 = k + 1 === pieces ? x1 : x0 + ((x1 - x0) * (k + 1)) / pieces;
      const next = value(t1);
      push(t0, prev, next);
      prev = next;
    }
  }
  // After the last point: hold its value.
  const last = at(n - 1);
  if (b > last) push(Math.max(a, last), tempoFromNorm(P[n - 1].v), tempoFromNorm(P[n - 1].v));
}

/** Tick <-> second conversion over tempo pieces (see the header). */
export class TempoMap {
  /** `data`: tempoPieces() output or a constant BPM. */
  constructor(data = 120) {
    if (typeof data === 'number') data = { bpm: data, tick: Float64Array.of(0), b0: Float64Array.of(data), b1: Float64Array.of(data) };
    const n = data.tick.length;
    this.bpm = data.bpm;
    this.n = n;
    this.T = Float64Array.from(data.tick);
    this.B0 = Float64Array.from(data.b0);
    this.B1 = Float64Array.from(data.b1);
    this.K = new Float64Array(n); // tempo slope, BPM per tick
    this.S = new Float64Array(n); // seconds at T[i]
    for (let i = 0; i < n; i++) {
      if (i + 1 < n) {
        const dt = this.T[i + 1] - this.T[i];
        this.K[i] = dt > 0 ? (this.B1[i] - this.B0[i]) / dt : 0;
        if (Math.abs(this.K[i]) < 1e-12) this.K[i] = 0;
        this.S[i + 1] = this.S[i] + this.#span(i, dt);
      } else this.B1[i] = this.B0[i];
    }
    this.constant = n === 1;
    this.h = 0; // last piece used (playback walks forward, so this is usually a hit)
  }

  /** Seconds spent in piece i over its first dt ticks. */
  #span(i, dt) {
    const k = this.K[i];
    const b0 = this.B0[i];
    if (!k) return (dt * 60) / (PPQ * b0);
    return (60 / (PPQ * k)) * Math.log1p((k * dt) / b0);
  }

  #pieceAtTick(t) {
    const T = this.T;
    const n = this.n;
    let h = this.h;
    if (T[h] <= t && (h + 1 >= n || t < T[h + 1])) return h;
    if (h + 1 < n && T[h + 1] <= t && (h + 2 >= n || t < T[h + 2])) return (this.h = h + 1);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (T[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return (this.h = lo);
  }

  #pieceAtSecond(s) {
    const S = this.S;
    const n = this.n;
    let h = this.h;
    if (S[h] <= s && (h + 1 >= n || s < S[h + 1])) return h;
    if (h + 1 < n && S[h + 1] <= s && (h + 2 >= n || s < S[h + 2])) return (this.h = h + 1);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return (this.h = lo);
  }

  /** Seconds from tick 0 to `tick`. */
  seconds(tick) {
    if (this.constant || tick <= 0) return (tick * 60) / (PPQ * this.B0[0]);
    const i = this.#pieceAtTick(tick);
    return this.S[i] + this.#span(i, tick - this.T[i]);
  }

  /** Tick reached `sec` seconds after tick 0. */
  ticks(sec) {
    if (this.constant || sec <= 0) return (sec * PPQ * this.B0[0]) / 60;
    const i = this.#pieceAtSecond(sec);
    const ds = sec - this.S[i];
    const k = this.K[i];
    const b0 = this.B0[i];
    if (!k) return this.T[i] + (ds * PPQ * b0) / 60;
    return this.T[i] + (b0 * Math.expm1((k * PPQ * ds) / 60)) / k;
  }

  /** Tempo in BPM at `tick`. */
  bpmAt(tick) {
    if (this.constant || tick <= 0) return this.B0[0];
    const i = this.#pieceAtTick(tick);
    return this.B0[i] + this.K[i] * (tick - this.T[i]);
  }

  /** Seconds between two ticks. */
  duration(from, to) {
    return this.seconds(to) - this.seconds(from);
  }
}
