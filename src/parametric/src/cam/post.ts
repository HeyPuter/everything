// Post processing: toolpaths to G-code for a controller. Straight feeds that
// follow circles are written as arcs (G2/G3, helical when the height changes
// steadily), drilling as canned cycles where the controller has them.

import type { CamController, CamPost, CamTool } from '../model/cam';
import { CYCLE, PLUNGE, RAPID, type CycleInfo, type Toolpath, expandMoves } from './toolpath';

export interface PostOperation {
  name: string;
  tool: CamTool;
  rpm: number;
  feed: number;
  plunge: number;
  toolpath: Toolpath;
}

export interface PostSetup {
  name: string;
  workOffset: number;
  ops: PostOperation[];
}

export interface PostJob {
  /** Program name (the part's). */
  name: string;
  post: CamPost;
  units: 'mm' | 'in';
  setups: PostSetup[];
  /** Comment lines for the header (date, generator...). */
  notes?: string[];
}

interface Dialect {
  percent: boolean;
  oNumber: boolean;
  toolChange: 'm6' | 'pause';
  lengthComp: boolean;
  home: boolean;
  canned: boolean;
  /** G82 dwell word: milliseconds (Fanuc, Haas) or seconds. */
  dwellMs: boolean;
  end: string;
}

const DIALECTS: Record<CamController, Dialect> = {
  fanuc: { percent: true, oNumber: true, toolChange: 'm6', lengthComp: true, home: true, canned: true, dwellMs: true, end: 'M30' },
  haas: { percent: true, oNumber: true, toolChange: 'm6', lengthComp: true, home: true, canned: true, dwellMs: true, end: 'M30' },
  mach3: { percent: false, oNumber: false, toolChange: 'm6', lengthComp: true, home: false, canned: true, dwellMs: false, end: 'M30' },
  linuxcnc: { percent: true, oNumber: false, toolChange: 'm6', lengthComp: true, home: false, canned: true, dwellMs: false, end: 'M2' },
  // Grbl has no tool changer, no tool length offsets and no canned cycles.
  grbl: { percent: false, oNumber: false, toolChange: 'pause', lengthComp: false, home: false, canned: false, dwellMs: false, end: 'M30' },
};

/** Comment text safe inside parentheses. */
const comment = (s: string) => `(${s.replace(/[()]/g, '').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 120)})`;

export function postProcess(job: PostJob): string {
  const d = DIALECTS[job.post.controller];
  const inch = job.units === 'in';
  const k = inch ? 1 / 25.4 : 1;
  const dec = inch ? 4 : 3;
  const num = (v: number) => {
    let s = (v * k).toFixed(dec);
    if (s.includes('.')) s = s.replace(/0+$/, '');
    if (s === '-0.' || s === '-0') s = '0.';
    return s;
  };
  const feedNum = (v: number) => {
    const f = v * k;
    let s = f.toFixed(inch ? 2 : 1);
    s = s.replace(/0+$/, '');
    return s;
  };
  const lines: string[] = [];
  let n = 0;
  const out = (s: string) => {
    // Sequence numbers start again after N99999 (five digits on most controllers).
    if (job.post.lineNumbers && s && !s.startsWith('%') && !s.startsWith('O')) { n = n >= 99990 ? 10 : n + 10; lines.push(`N${n} ${s}`); }
    else lines.push(s);
  };
  if (d.percent) lines.push('%');
  if (d.oNumber) lines.push(`O${String(job.post.program).padStart(4, '0')} ${comment(job.name)}`);
  else out(comment(job.name));
  for (const note of job.notes ?? []) out(comment(note));
  // Tool list.
  const tools = new Map<number, CamTool>();
  for (const s of job.setups) for (const o of s.ops) tools.set(o.tool.number, o.tool);
  for (const t of [...tools.values()].sort((a, b) => a.number - b.number)) out(comment(`T${t.number} D=${num(t.diameter)} ${t.name}`));
  out(job.post.controller === 'grbl' ? 'G90 G94 G17' : 'G90 G94 G17 G40 G49 G80');
  out(inch ? 'G20' : 'G21');
  if (d.home) { out('G28 G91 Z0.'); out('G90'); }

  // Modal state.
  let x = NaN, y = NaN, z = NaN, f = NaN, motion = '';
  let tool: number | null = null;
  let lengthDone = false;
  const words = (nx: number, ny: number, nz: number) => {
    let s = '';
    if (num(nx) !== num(x)) s += ` X${num(nx)}`;
    if (num(ny) !== num(y)) s += ` Y${num(ny)}`;
    if (num(nz) !== num(z)) s += ` Z${num(nz)}`;
    return s;
  };
  const rapid = (nx: number, ny: number, nz: number) => {
    const w = words(nx, ny, nz);
    if (!w) return;
    out(`${motion === 'G0' ? '' : 'G0'}${w}`.trim());
    motion = 'G0';
    x = nx; y = ny; z = nz;
  };
  const linear = (nx: number, ny: number, nz: number, feed: number) => {
    const w = words(nx, ny, nz);
    if (!w) return;
    const fw = feedNum(feed) !== feedNum(f) ? ` F${feedNum(feed)}` : '';
    out(`${motion === 'G1' ? '' : 'G1'}${w}${fw}`.trim());
    motion = 'G1';
    x = nx; y = ny; z = nz; f = feed;
  };
  const arc = (cw: boolean, nx: number, ny: number, nz: number, cx: number, cy: number, feed: number) => {
    const g = cw ? 'G2' : 'G3';
    let w = ` X${num(nx)} Y${num(ny)}`;
    if (num(nz) !== num(z)) w += ` Z${num(nz)}`;
    w += ` I${num(cx - x)} J${num(cy - y)}`;
    const fw = feedNum(feed) !== feedNum(f) ? ` F${feedNum(feed)}` : '';
    out(`${g}${w}${fw}`);
    motion = g;
    x = nx; y = ny; z = nz; f = feed;
  };
  const dwell = (sec: number) => {
    if (sec <= 0) return;
    out(job.post.controller === 'fanuc' || job.post.controller === 'haas' ? `G4 X${sec.toFixed(2)}` : `G4 P${sec.toFixed(2)}`);
  };

  let offset: number | null = null;
  for (const setup of job.setups) {
    out(comment(setup.name));
    // A later setup: the tool is positioned again in its work offset, and the program stops for
    // the part to be turned when the setup uses the same offset as the one before.
    let newSetup = tool !== null;
    const refixture = newSetup && setup.workOffset === offset;
    offset = setup.workOffset;
    for (const op of setup.ops) {
      out(comment(op.name));
      const t = op.tool;
      if (tool !== t.number || newSetup) {
        let stopped = false;
        if (tool !== null) {
          out('M9');
          out('M5');
          if (d.home) { out('G28 G91 Z0.'); out('G90'); }
        }
        if (newSetup && refixture) { out(comment(`Set up the part for ${setup.name}`)); out('M0'); stopped = true; }
        if (tool !== t.number) {
          if (d.toolChange === 'm6') out(`T${t.number} M6`);
          else { out(comment(`Change to T${t.number} ${t.name}`)); if (tool !== null && !stopped) out('M0'); }
        }
        newSetup = false;
        tool = t.number;
        lengthDone = false;
        x = y = z = f = NaN;
        motion = '';
      }
      out(`S${Math.round(op.rpm)} M3`);
      out(`G${setup.workOffset}`);
      if (t.coolant) out('M8');
      const moves = op.toolpath.moves;
      // The first move: across at the clearance height, then down with the length offset.
      const clear = op.toolpath.clearance;
      if (!lengthDone) {
        if (moves.length >= 4) {
          // Up first, where the tool is, then across.
          if (!d.lengthComp && num(z) !== num(clear)) { out(`G0 Z${num(clear)}`); z = clear; motion = 'G0'; }
          const fx = moves[1], fy = moves[2];
          if (d.lengthComp) {
            out(`G0 X${num(fx)} Y${num(fy)}`);
            out(`G43 Z${num(clear)} H${t.number}`);
            x = fx; y = fy; z = clear; motion = 'G0';
          } else rapid(fx, fy, clear);
        }
        lengthDone = true;
      }
      // Moves, with arcs fitted over runs of feeds.
      const feedOf = (kind: number) => (kind === PLUNGE ? op.plunge : op.feed);
      const flushRun = (run: number[], kind: number) => {
        if (!run.length) return;
        const pts = [x, y, z, ...run];
        if (job.post.arcs) {
          writeArcs(pts, 0.005, (px, py, pz) => linear(px, py, pz, feedOf(kind)), (cw, px, py, pz, cx, cy) => arc(cw, px, py, pz, cx, cy, feedOf(kind)));
        } else for (let i = 3; i < pts.length; i += 3) linear(pts[i], pts[i + 1], pts[i + 2], feedOf(kind));
      };
      let run: number[] = [];
      let runKind = -1;
      const cycles: CycleInfo[] = op.toolpath.cycles;
      const canned = d.canned && job.post.cannedCycles;
      let inCycle = '';
      const endCycle = () => { if (inCycle) { out('G80'); inCycle = ''; motion = ''; } };
      for (let i = 0; i < moves.length; i += 4) {
        const kind = moves[i], mx = moves[i + 1], my = moves[i + 2], mz = moves[i + 3];
        if (kind !== runKind || kind === RAPID || kind === CYCLE) { flushRun(run, runKind); run = []; runKind = kind; }
        if (kind === RAPID) { endCycle(); rapid(mx, my, mz); continue; }
        if (kind === CYCLE) {
          const c = cycles[mz];
          const peck = c.cycle !== 'drill' && c.peck > 0;
          const dwellCanned = c.dwell > 0 && !peck && (job.post.controller === 'fanuc' || job.post.controller === 'haas' || job.post.controller === 'linuxcnc');
          if (canned && (c.dwell <= 0 || dwellCanned)) {
            if (num(z) !== num(c.r) && !inCycle) rapid(x, y, c.r);
            const code = peck ? (c.cycle === 'peck' ? 'G83' : 'G73') : c.dwell > 0 ? 'G82' : 'G81';
            if (inCycle !== code) {
              const extra = peck ? ` Q${num(c.peck)}` : c.dwell > 0 ? ` P${d.dwellMs ? Math.round(c.dwell * 1000) : c.dwell.toFixed(2)}` : '';
              out(`G98 ${code} X${num(mx)} Y${num(my)} Z${num(c.z)} R${num(c.r)}${extra} F${feedNum(op.plunge)}`);
              inCycle = code;
              f = op.plunge;
            } else out(`X${num(mx)} Y${num(my)}`);
            x = mx; y = my; z = c.r;
          } else {
            endCycle();
            expandMoves({ moves: Float64Array.of(CYCLE, mx, my, mz), cycles, clearance: clear, warnings: [] }, (kk, ex, ey, ez, dw) => {
              if (kk === RAPID) rapid(ex, ey, ez);
              else { linear(ex, ey, ez, op.plunge); dwell(dw); }
            });
          }
          continue;
        }
        endCycle();
        run.push(mx, my, mz);
      }
      flushRun(run, runKind);
      endCycle();
    }
  }
  out('M9');
  out('M5');
  if (d.home) { out('G28 G91 Z0.'); out('G90'); }
  out(d.end);
  if (d.percent) lines.push('%');
  return lines.join('\n') + '\n';
}

/**
 * Writes a polyline (x, y, z triples; the first point is where the tool is)
 * as lines and arcs: runs of at least four short segments whose points stay
 * within `tol` of a circle in XY (their chords' middles within 4 × tol), that
 * turn one way less than half a turn and descend evenly become one arc.
 */
export function writeArcs(pts: number[], tol: number, line: (x: number, y: number, z: number) => void, arc: (cw: boolean, x: number, y: number, z: number, cx: number, cy: number) => void) {
  const n = pts.length / 3;
  let i = 0;
  const P = (k: number) => [pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]];
  while (i < n - 1) {
    let best = -1;
    let bestFit: { cx: number; cy: number; cw: boolean } | null = null;
    for (let j = i + 4; j < n && j - i <= 400; j++) {
      const fit = fitArc(pts, i, j, tol);
      if (!fit) break;
      best = j;
      bestFit = fit;
    }
    if (best > 0 && bestFit) {
      const [ex, ey, ez] = P(best);
      arc(bestFit.cw, ex, ey, ez, bestFit.cx, bestFit.cy);
      i = best;
    } else {
      const [ex, ey, ez] = P(i + 1);
      line(ex, ey, ez);
      i++;
    }
  }
}

function fitArc(pts: number[], i: number, j: number, tol: number): { cx: number; cy: number; cw: boolean } | null {
  const m = (i + j) >> 1;
  const ax = pts[i * 3], ay = pts[i * 3 + 1], bx = pts[m * 3], by = pts[m * 3 + 1], cx = pts[j * 3], cy = pts[j * 3 + 1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ox, ay - oy);
  if (r < 0.05 || r > 5000) return null;
  // One direction, under half a turn, every point and chord middle on the circle.
  let sweep = 0, dir = 0;
  const z0 = pts[i * 3 + 2], z1 = pts[j * 3 + 2];
  for (let k = i; k < j; k++) {
    const px = pts[k * 3], py = pts[k * 3 + 1], qx = pts[(k + 1) * 3], qy = pts[(k + 1) * 3 + 1];
    const a0 = Math.atan2(py - oy, px - ox), a1 = Math.atan2(qy - oy, qx - ox);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    // Short steps only: a polygon's corners also lie on a circle.
    if (Math.abs(da) < 1e-12 || Math.abs(da) > Math.PI / 12) return null;
    const s = Math.sign(da);
    if (dir === 0) dir = s; else if (s !== dir) return null;
    sweep += da;
    if (Math.abs(Math.hypot(qx - ox, qy - oy) - r) > tol) return null;
    const mx = (px + qx) / 2, my = (py + qy) / 2;
    // The arc bulges from the chords the points were sampled on; a little more is allowed there.
    if (Math.abs(Math.hypot(mx - ox, my - oy) - r) > tol * 4) return null;
  }
  if (Math.abs(sweep) >= Math.PI * 0.999) return null;
  // Height changes evenly with the angle (a helix) or not at all.
  let acc = 0;
  for (let k = i + 1; k <= j; k++) {
    const px = pts[(k - 1) * 3], py = pts[(k - 1) * 3 + 1], qx = pts[k * 3], qy = pts[k * 3 + 1];
    let da = Math.atan2(qy - oy, qx - ox) - Math.atan2(py - oy, px - ox);
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    acc += da;
    const zk = z0 + ((z1 - z0) * acc) / sweep;
    if (Math.abs(zk - pts[k * 3 + 2]) > tol) return null;
  }
  return { cx: ox, cy: oy, cw: dir < 0 };
}

