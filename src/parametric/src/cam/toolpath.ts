// Toolpaths: the moves of an operation in work coordinates, packed in a
// typed array (kind, x, y, z per move) so large finishing paths stay cheap to
// keep, transfer from the worker and draw. Drilling cycles are kept as cycles
// so the post processor can write them as canned cycles.

import type { DrillCycle } from '../model/cam';

export const RAPID = 0;
export const FEED = 1;
/** Plunges, ramps and helical entries (at the plunge feed). */
export const PLUNGE = 2;
/** A drilling cycle at (x, y) down to z; its details are in `cycles`. */
export const CYCLE = 3;

export interface CycleInfo {
  cycle: DrillCycle;
  /** Height the cycle starts and retracts to (R plane). */
  r: number;
  /** Bottom of the hole. */
  z: number;
  peck: number;
  dwell: number;
}

export interface Toolpath {
  /** kind, x, y, z per move. */
  moves: Float64Array;
  cycles: CycleInfo[];
  /** Height rapids between features use (work coordinates). */
  clearance: number;
  /** Notes about the operation (what was left uncut...). */
  warnings: string[];
}

export class PathBuilder {
  private data: number[] = [];
  readonly cycles: CycleInfo[] = [];
  warnings: string[] = [];
  x = NaN;
  y = NaN;
  z = NaN;

  constructor(readonly clearance: number, readonly retract: number) {}

  get length() { return this.data.length / 4; }

  private push(kind: number, x: number, y: number, z: number) {
    // Repeats add nothing.
    if (x === this.x && y === this.y && z === this.z && kind !== CYCLE) return;
    this.data.push(kind, x, y, z);
    this.x = x; this.y = y; this.z = z;
  }

  rapid(x: number, y: number, z: number) { this.push(RAPID, x, y, z); }
  feed(x: number, y: number, z: number) { this.push(FEED, x, y, z); }
  plunge(x: number, y: number, z: number) { this.push(PLUNGE, x, y, z); }

  /** Up to the clearance height (if not there), across, and down to `z` at rapid. */
  rapidTo(x: number, y: number, z: number) {
    if (Number.isNaN(this.z)) {
      this.push(RAPID, x, y, this.clearance);
    } else {
      if (this.z < this.clearance) this.push(RAPID, this.x, this.y, this.clearance);
      this.push(RAPID, x, y, this.clearance);
    }
    if (z < this.clearance) this.push(RAPID, x, y, z);
  }

  /** Lifts to `z` at rapid, moves across and goes down to `down` at rapid (within the operation). */
  hop(z: number, x: number, y: number, down: number) {
    if (this.z < z) this.push(RAPID, this.x, this.y, z);
    this.push(RAPID, x, y, Math.max(z, this.z));
    if (down < this.z) this.push(RAPID, x, y, down);
  }

  cycle(x: number, y: number, info: CycleInfo) {
    this.rapidTo(x, y, info.r);
    this.data.push(CYCLE, x, y, this.cycles.length);
    this.cycles.push(info);
    this.x = x; this.y = y; this.z = info.r;
  }

  /** Back up to the clearance height. */
  finish() {
    if (!Number.isNaN(this.z) && this.z < this.clearance) this.push(RAPID, this.x, this.y, this.clearance);
  }

  build(): Toolpath {
    this.finish();
    return { moves: Float64Array.from(this.data), cycles: this.cycles, clearance: this.clearance, warnings: this.warnings };
  }
}

export interface ExpandedMove { kind: number; x: number; y: number; z: number; dwell?: number }

/**
 * The moves of a toolpath with drilling cycles written out as the moves the
 * machine makes (for drawing, simulating and machines without canned cycles).
 */
export function expandMoves(tp: Toolpath, visit: (kind: number, x: number, y: number, z: number, dwell: number) => void) {
  const m = tp.moves;
  let cx = NaN, cy = NaN;
  for (let i = 0; i < m.length; i += 4) {
    const k = m[i];
    if (k !== CYCLE) { visit(k, m[i + 1], m[i + 2], m[i + 3], 0); cx = m[i + 1]; cy = m[i + 2]; continue; }
    const c = tp.cycles[m[i + 3]];
    const x = m[i + 1], y = m[i + 2];
    if (x !== cx || y !== cy) visit(RAPID, x, y, c.r, 0);
    cx = x; cy = y;
    if (c.cycle === 'drill' || c.peck <= 0) {
      visit(PLUNGE, x, y, c.z, c.dwell);
    } else {
      // Pecks: down a peck at a time; a full retract (peck) or a short one (chip break) between.
      let depth = c.r;
      const clear = Math.min(0.5, c.peck / 4);
      while (depth > c.z + 1e-9) {
        const next = Math.max(c.z, depth - c.peck);
        visit(PLUNGE, x, y, next, next <= c.z + 1e-9 ? c.dwell : 0);
        depth = next;
        if (depth > c.z + 1e-9) {
          if (c.cycle === 'peck') { visit(RAPID, x, y, c.r, 0); visit(RAPID, x, y, depth + clear, 0); }
          else visit(RAPID, x, y, depth + clear, 0);
        }
      }
    }
    visit(RAPID, x, y, c.r, 0);
  }
}

export interface PathStats {
  cutLength: number;
  rapidLength: number;
  /** Seconds. */
  time: number;
  zMin: number;
  zMax: number;
  moves: number;
}

export function pathStats(tp: Toolpath, feed: number, plunge: number, rapidFeed: number): PathStats {
  let cut = 0, rapid = 0, time = 0, zMin = Infinity, zMax = -Infinity, n = 0;
  let px = NaN, py = NaN, pz = NaN;
  expandMoves(tp, (k, x, y, z, dwell) => {
    n++;
    if (!Number.isNaN(px)) {
      const l = Math.hypot(x - px, y - py, z - pz);
      if (k === RAPID) { rapid += l; time += (l / rapidFeed) * 60; }
      else { cut += l; time += (l / Math.max(1e-6, k === PLUNGE ? plunge : feed)) * 60; }
    }
    time += dwell;
    if (k !== RAPID) { zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
    px = x; py = y; pz = z;
  });
  return { cutLength: cut, rapidLength: rapid, time, zMin, zMax, moves: n };
}
