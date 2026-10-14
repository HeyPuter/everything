// Meter ballistics for the mixer: instant attack, smooth fall, peak hold and
// a latched clip indicator per meter channel (two per mixer track). Input is
// engine.meters ([peakL, peakR] linear per track). Typed arrays only; update()
// allocates nothing, so it runs every frame.

import { gainToPos } from './db.js';

export const FALL_DB_PER_S = 24;
export const HOLD_S = 1.5;
export const PEAK_FALL_DB_PER_S = 36;
export const CLIP_LEVEL = 1; // 0 dBFS
const SILENT_DB = -120;

const toDb = (g) => (g > 1e-6 ? 20 * Math.log10(g) : SILENT_DB);
const toGain = (db) => (db <= SILENT_DB ? 0 : 10 ** (db / 20));

export class MeterState {
  constructor(tracks = 0) {
    this.resize(tracks);
  }

  resize(tracks) {
    const n = tracks * 2;
    if (this.level && this.level.length === n) return;
    // Keeps existing values; new entries start silent.
    const grow = (Arr, prev, fill) => {
      const a = new Arr(n);
      if (fill) a.fill(fill);
      if (prev) a.set(prev.subarray(0, Math.min(n, prev.length)));
      return a;
    };
    this.level = grow(Float32Array, this.level, SILENT_DB); // displayed level, dB
    this.peak = grow(Float32Array, this.peak, SILENT_DB); // held peak, dB
    this.hold = grow(Float32Array, this.hold, 0); // seconds the peak is still held
    this.clip = grow(Uint8Array, this.clip, 0);
  }

  get tracks() {
    return this.level.length / 2;
  }

  /**
   * Advances by `dt` seconds with new input peaks. `reduced` (reduced motion)
   * makes the held peak drop at once after the hold time instead of falling.
   * Returns whether anything visible changed.
   */
  update(input, dt, reduced = false) {
    const n = this.level.length;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const g = input && i < input.length ? input[i] : 0;
      const db = toDb(g);
      const prev = this.level[i];
      const lv = db >= prev ? db : Math.max(db, prev - FALL_DB_PER_S * dt);
      if (lv !== prev) {
        changed = true;
        this.level[i] = lv;
      }
      let pk = this.peak[i];
      if (db >= pk) {
        if (db !== pk) changed = true;
        pk = db;
        this.hold[i] = HOLD_S;
      } else if (this.hold[i] > 0) {
        this.hold[i] -= dt;
      } else if (pk > SILENT_DB) {
        pk = reduced ? Math.max(lv, SILENT_DB) : Math.max(lv, pk - PEAK_FALL_DB_PER_S * dt);
        changed = true;
      }
      this.peak[i] = pk;
      if (g >= CLIP_LEVEL && !this.clip[i]) {
        this.clip[i] = 1;
        changed = true;
      }
    }
    return changed;
  }

  /** Clears the clip indicators of one track (or all when omitted). */
  resetClip(track) {
    if (track === undefined) this.clip.fill(0);
    else if (track * 2 + 1 < this.clip.length) {
      this.clip[track * 2] = 0;
      this.clip[track * 2 + 1] = 0;
    }
  }

  /** Displayed level of meter channel `i` as a 0..1 position (fader law). */
  levelPos(i) {
    return gainToPos(toGain(this.level[i]));
  }

  peakPos(i) {
    return gainToPos(toGain(this.peak[i]));
  }

  /** Whether everything rests at silence (nothing to draw but empty meters). */
  idle() {
    for (let i = 0; i < this.level.length; i++) if (this.level[i] > SILENT_DB || this.peak[i] > SILENT_DB || this.clip[i]) return false;
    return true;
  }
}
