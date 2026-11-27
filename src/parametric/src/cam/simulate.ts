// Material removal simulation on a height map of the stock (a z-map): each
// move of each toolpath lowers the stock under the tool to the tool's
// surface. Records snapshots for playback, rapid moves that cut, material
// reaching above the flutes, and compares the result with the part (gouges
// and what is left to cut).

import type { CamTool } from '../model/cam';
import { cutterOf, DropCutter, NO_CONTACT, makeCutter, type TriIndex } from './dropcutter';
import type { Box3 } from './frame';
import { type GridSpec, gridOver } from './grid';
import { PLUNGE, RAPID, type Toolpath, expandMoves } from './toolpath';

export interface SimStep {
  toolpath: Toolpath;
  tool: CamTool;
  feed: number;
  plunge: number;
}

export interface SimInput {
  stock: Box3;
  part: TriIndex;
  steps: SimStep[];
  rapidFeed: number;
  /** Stock cell size (absent: chosen from the stock's size). */
  cell?: number;
  /** Number of playback snapshots. */
  snapshots?: number;
  /** Largest display grid side. */
  displaySide?: number;
  cancelled?: () => boolean;
  progress?: (f: number) => void;
}

export interface SimSnapshot {
  /** Seconds into the program. */
  time: number;
  /** Stock heights on the display grid. */
  z: Float32Array;
}

export interface SimResult {
  /** Display grid (stock heights of snapshots and the part's top use it). */
  grid: GridSpec;
  bottom: number;
  top: number;
  snapshots: SimSnapshot[];
  /** Height of the part's top surface on the display grid (NO_CONTACT where there is none). */
  partTop: Float32Array;
  /**
   * Tool positions for playback: x, y, z, seconds, step index, move kind per
   * point (6 numbers each).
   */
  timeline: Float32Array;
  /** Total program time (seconds). */
  time: number;
  /** Cells cut deeper than the part, and the deepest gouge. */
  gouges: number;
  maxGouge: number;
  /** Rapid moves that cut stock, per step. */
  rapidCuts: number[];
  /** Feed moves where the stock reached above the flutes, per step. */
  shankHits: number[];
  /** Thickest material left over the part, and the area left thicker than 0.1 mm (mm²). */
  maxRemaining: number;
  remainingArea: number;
  /** Removed volume (mm³). */
  removed: number;
}

/** Simulates the steps in order on fresh stock. */
export function simulate(input: SimInput): SimResult {
  const st = input.stock;
  const w = st.max[0] - st.min[0], d = st.max[1] - st.min[1];
  const cell = input.cell ?? Math.max(0.05, Math.sqrt((w * d) / 250_000));
  // Nodes at cell centres.
  const g = gridOver(st.min[0] + cell / 2, st.min[1] + cell / 2, st.max[0] - cell / 2, st.max[1] - cell / 2, cell, 600_000);
  const top = st.max[2], bottom = st.min[2];
  const z = new Float32Array(g.nx * g.ny).fill(top);
  const startVolume = z.length * g.c * g.c * (top - bottom);

  // Display grid.
  const side = input.displaySide ?? 220;
  const fx = Math.max(1, Math.ceil(g.nx / side)), fy = Math.max(1, Math.ceil(g.ny / side));
  const dg: GridSpec = { x0: g.x0 + ((fx - 1) * g.c) / 2, y0: g.y0 + ((fy - 1) * g.c) / 2, c: g.c * fx, nx: Math.ceil(g.nx / fx), ny: Math.ceil(g.ny / fy) };
  // A display cell shows the lowest stock under it (cuts stay visible).
  const down = (src: Float32Array): Float32Array => {
    const out = new Float32Array(dg.nx * dg.ny).fill(Infinity);
    for (let j = 0; j < g.ny; j++) {
      const dj = Math.min(dg.ny - 1, Math.floor(j / fy));
      for (let i = 0; i < g.nx; i++) {
        const k = dj * dg.nx + Math.min(dg.nx - 1, Math.floor(i / fx));
        const v = src[j * g.nx + i];
        if (v < out[k]) out[k] = v;
      }
    }
    return out;
  };

  // Total time, for evenly spaced snapshots.
  const times: number[] = [];
  let total = 0;
  for (const s of input.steps) {
    let t = 0, px = NaN, py = NaN, pz = NaN;
    expandMoves(s.toolpath, (k, x, y, zz, dwell) => {
      if (!Number.isNaN(px)) {
        const l = Math.hypot(x - px, y - py, zz - pz);
        t += (l / Math.max(1e-6, k === RAPID ? input.rapidFeed : k === PLUNGE ? s.plunge : s.feed)) * 60;
      }
      t += dwell;
      px = x; py = y; pz = zz;
    });
    times.push(t);
    total += t;
  }
  const nSnap = Math.max(2, input.snapshots ?? 90);
  const snapshots: SimSnapshot[] = [{ time: 0, z: down(z) }];
  let nextSnap = total / nSnap;
  const timeline: number[] = [];
  const rapidCuts: number[] = [], shankHits: number[] = [];
  let now = 0;

  input.steps.forEach((s, si) => {
    const cutter = cutterOf(s.tool);
    const R = cutter.r;
    const flute = Math.max(s.tool.fluteLength, 0.1);
    let rapid = 0, shank = 0;
    let px = NaN, py = NaN, pz = NaN;
    // Whether the move being stamped cut stock, and met stock above the flutes.
    let cut = false, hit = false;
    const stampAt = (x: number, y: number, tz: number) => {
      const i0 = Math.max(0, Math.ceil((x - R - g.x0) / g.c)), i1 = Math.min(g.nx - 1, Math.floor((x + R - g.x0) / g.c));
      const j0 = Math.max(0, Math.ceil((y - R - g.y0) / g.c)), j1 = Math.min(g.ny - 1, Math.floor((y + R - g.y0) / g.c));
      let c = false, over = false;
      for (let j = j0; j <= j1; j++) {
        const cy = g.y0 + j * g.c - y;
        for (let i = i0; i <= i1; i++) {
          const cx = g.x0 + i * g.c - x;
          const dd = cx * cx + cy * cy;
          if (dd > R * R) continue;
          const k = j * g.nx + i;
          const zc = tz + cutter.h(Math.sqrt(dd));
          if (zc < z[k] - 1e-4) {
            if (z[k] > tz + flute + 0.01) over = true;
            z[k] = zc;
            c = true;
          }
        }
      }
      if (c) cut = true;
      if (over) hit = true;
    };
    // Problems are counted per move, however many samples of it cut.
    const count = (kind: number) => {
      if (cut && kind === RAPID) rapid++;
      if (hit && kind !== RAPID) shank++;
    };
    const move = (kind: number, x: number, y: number, zz: number, dwell: number) => {
      cut = hit = false;
      if (Number.isNaN(px)) { px = x; py = y; pz = zz; stampAt(x, y, zz); count(kind); return; }
      const lxy = Math.hypot(x - px, y - py);
      const l = Math.hypot(lxy, zz - pz);
      const dt = (l / Math.max(1e-6, kind === RAPID ? input.rapidFeed : kind === PLUNGE ? s.plunge : s.feed)) * 60 + dwell;
      // Only moves that may reach the stock need stamping.
      if (Math.min(pz, zz) < top + 1e-6) {
        const n = Math.max(1, Math.ceil(lxy / (g.c * 0.5)));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          stampAt(px + (x - px) * t, py + (y - py) * t, pz + (zz - pz) * t);
        }
        count(kind);
      }
      now += dt;
      timeline.push(x, y, zz, now, si, kind);
      while (now >= nextSnap && snapshots.length < nSnap) {
        snapshots.push({ time: now, z: down(z) });
        nextSnap += total / nSnap;
      }
      px = x; py = y; pz = zz;
      if ((timeline.length / 6) % 2048 === 0) {
        if (input.cancelled?.()) throw new Error('cancelled');
        input.progress?.(total ? now / total : 0);
      }
    };
    expandMoves(s.toolpath, move);
    rapidCuts.push(rapid);
    shankHits.push(shank);
  });
  snapshots.push({ time: total, z: down(z) });

  // Compare with the part: its top surface under each display cell, and on the stock grid
  // (eroded by a cell so cells on a wall's edge do not read as gouges).
  const pin = new DropCutter(input.part, makeCutter('flat', 1e-4, 0, 0));
  const fine = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) fine[j * g.nx + i] = pin.drop(g.x0 + i * g.c, g.y0 + j * g.c);
  const eroded = new Float32Array(fine.length);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      let m = Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = Math.min(g.nx - 1, Math.max(0, i + di)), jj = Math.min(g.ny - 1, Math.max(0, j + dj));
        m = Math.min(m, fine[jj * g.nx + ii]);
      }
      eroded[j * g.nx + i] = m;
    }
  }
  let gouges = 0, maxGouge = 0, maxRemaining = 0, remainingCells = 0, volume = 0;
  for (let k = 0; k < z.length; k++) {
    volume += (z[k] - bottom) * g.c * g.c;
    const p = eroded[k];
    if (p <= NO_CONTACT / 2) continue;
    const diff = z[k] - p;
    if (diff < -0.02) { gouges++; maxGouge = Math.max(maxGouge, -diff); }
    if (fine[k] > NO_CONTACT / 2 && z[k] - fine[k] > 0.1) { remainingCells++; maxRemaining = Math.max(maxRemaining, z[k] - fine[k]); }
  }
  // The part under a display cell, the lowest of its cells as its stock is (a cell on a wall's
  // edge then reads as finished, not as cut into the wall).
  const partTop = down(fine);
  return {
    grid: dg, bottom, top, snapshots, partTop, timeline: Float32Array.from(timeline), time: total,
    gouges, maxGouge, rapidCuts, shankHits, maxRemaining, remainingArea: remainingCells * g.c * g.c, removed: Math.max(0, startVolume - volume),
  };
}
