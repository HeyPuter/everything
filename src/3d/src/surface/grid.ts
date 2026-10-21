// Control point grid editing for NURBS surfaces (pure, unit tested): rows, selection growth, delete,
// extrude, subdivide, duplicate, direction switching and spinning a row into a surface of revolution.
import type { Spline, SplinePoint } from '../data/types';
import { gridSize } from './nurbs';

type P4 = [number, number, number, number];
const copyPt = (p: SplinePoint, select = p.select): SplinePoint => ({ ...p, co: [...p.co] as P4, select });

/** Index of grid point (u, v). */
export const gid = (sp: Spline, u: number, v: number) => v * gridSize(sp).u + u;

/** Grid coordinates of a point index. */
export function guv(sp: Spline, i: number): [number, number] {
  const { u } = gridSize(sp);
  return [i % u, Math.floor(i / u)];
}

/** Make the spline's grid size explicit (1-row splines stay 1 row high). */
export function normalize(sp: Spline): Spline {
  const { u, v } = gridSize(sp);
  sp.point_count_u = u;
  sp.point_count_v = v;
  return sp;
}

/** Point indices of the U-row at v (all u) or the V-column at u (all v). */
export function rowIndices(sp: Spline, dir: 'U' | 'V', k: number): number[] {
  const { u, v } = gridSize(sp);
  return dir === 'U' ? Array.from({ length: u }, (_, i) => k * u + i) : Array.from({ length: v }, (_, j) => j * u + k);
}

const visibleSel = (p: SplinePoint | undefined) => !!p?.select && !p.hide;

/** Rows (along U, one per v) / columns (along V, one per u) whose points are all selected. */
export function fullRows(sp: Spline): { rowsV: number[]; colsU: number[] } {
  const { u, v } = gridSize(sp);
  const rowsV: number[] = [],
    colsU: number[] = [];
  for (let j = 0; j < v; j++) if (rowIndices(sp, 'U', j).every((i) => visibleSel(sp.points[i]))) rowsV.push(j);
  for (let i = 0; i < u; i++) if (rowIndices(sp, 'V', i).every((k) => visibleSel(sp.points[k]))) colsU.push(i);
  return { rowsV, colsU };
}

/** Select the row through point `i` along U (`dir` U) or along V. */
export function selectRow(sp: Spline, i: number, dir: 'U' | 'V', extend = false) {
  const [u, v] = guv(sp, i);
  if (!extend) for (const p of sp.points) p.select = false;
  for (const k of rowIndices(sp, dir, dir === 'U' ? v : u)) if (!sp.points[k].hide) sp.points[k].select = true;
}

/** Grid neighbours (4-connected, wrapping across closed directions). */
export function neighbours(sp: Spline, i: number): number[] {
  const { u: nu, v: nv } = gridSize(sp);
  const [u, v] = guv(sp, i);
  const out: number[] = [];
  const add = (a: number, b: number) => {
    if (sp.use_cyclic_u) a = (a + nu) % nu;
    if (sp.use_cyclic_v) b = (b + nv) % nv;
    if (a >= 0 && a < nu && b >= 0 && b < nv && !(a === u && b === v)) out.push(b * nu + a);
  };
  add(u - 1, v);
  add(u + 1, v);
  add(u, v - 1);
  add(u, v + 1);
  return out;
}

/** Grow (more) or shrink (less) the selection by one grid step. */
export function growSelection(sp: Spline, more: boolean) {
  const sel = sp.points.map(visibleSel);
  sp.points.forEach((p, i) => {
    if (p.hide || sel[i] === more) return;
    const nb = neighbours(sp, i);
    if (more ? nb.some((k) => sel[k]) : nb.some((k) => !sel[k] && !sp.points[k].hide) || nb.length < 4) p.select = more;
  });
}

/**
 * Delete fully selected rows and columns. Returns false when the spline would vanish (caller removes it)
 * or null when nothing was deleted.
 */
export function deleteRows(sp: Spline): boolean | null {
  const { u, v } = gridSize(sp);
  const { rowsV, colsU } = fullRows(sp);
  if (rowsV.length === v || colsU.length === u) return false;
  // a 1-row spline: delete points
  if (v === 1) {
    const keep = sp.points.filter((p) => !visibleSel(p));
    if (keep.length === sp.points.length) return null;
    if (keep.length < 1) return false;
    sp.points = keep;
    sp.point_count_u = keep.length;
    return true;
  }
  if (!rowsV.length && !colsU.length) return null;
  // remove the direction with more selected rows first (a full selection of one row deletes only that row)
  const dropV = new Set(rowsV.length >= colsU.length ? rowsV : []),
    dropU = new Set(rowsV.length >= colsU.length ? [] : colsU);
  const pts: SplinePoint[] = [];
  for (let j = 0; j < v; j++) {
    if (dropV.has(j)) continue;
    for (let i = 0; i < u; i++) if (!dropU.has(i)) pts.push(sp.points[j * u + i]);
  }
  sp.points = pts;
  sp.point_count_u = u - dropU.size;
  sp.point_count_v = v - dropV.size;
  if (sp.point_count_v <= 1) sp.order_v = 0;
  for (const k of ['u', 'v'] as const) {
    const n = k === 'u' ? sp.point_count_u : sp.point_count_v;
    const ok = k === 'u' ? 'order_u' : 'order_v';
    if ((sp[ok] ?? 0) > n) sp[ok] = n;
  }
  return true;
}

/**
 * Extrude a selected boundary: a whole spline that is one row high grows a second row; otherwise a fully
 * selected first / last row (or column) gets a copy outside it. The copies become the selection.
 */
export function extrudeEdge(sp: Spline): boolean {
  normalize(sp);
  const { u, v } = gridSize(sp);
  const { rowsV, colsU } = fullRows(sp);
  const desel = () => sp.points.forEach((p) => (p.select = false));
  if (!sp.use_cyclic_v && (rowsV.includes(0) || rowsV.includes(v - 1)) && !(v === 1 && sp.use_cyclic_v)) {
    const at = rowsV.includes(v - 1) ? v - 1 : 0;
    const row = rowIndices(sp, 'U', at).map((i) => copyPt(sp.points[i], true));
    desel();
    if (at === v - 1) sp.points.push(...row);
    else sp.points.unshift(...row);
    sp.point_count_v = v + 1;
    if (v === 1) sp.order_v = Math.max(2, sp.order_v || 0);
    return true;
  }
  if (!sp.use_cyclic_u && v > 1 && (colsU.includes(0) || colsU.includes(u - 1))) {
    const at = colsU.includes(u - 1) ? u - 1 : 0;
    const pts: SplinePoint[] = [];
    for (let j = 0; j < v; j++) {
      const row = sp.points.slice(j * u, j * u + u).map((p) => copyPt(p, false));
      const extra = copyPt(sp.points[j * u + at], true);
      if (at === 0) row.unshift(extra);
      else row.push(extra);
      pts.push(...row);
    }
    sp.points = pts;
    sp.point_count_u = u + 1;
    return true;
  }
  return false;
}

const lerpPt = (a: SplinePoint, b: SplinePoint, t: number): SplinePoint => ({
  co: [0, 1, 2, 3].map((k) => a.co[k] + (b.co[k] - a.co[k]) * t) as P4,
  radius: a.radius + (b.radius - a.radius) * t,
  tilt: a.tilt + (b.tilt - a.tilt) * t,
  select: true,
});

/** Insert `cuts` rows between neighbouring fully selected rows (and columns). */
export function subdivideGrid(sp: Spline, cuts: number): boolean {
  normalize(sp);
  let changed = false;
  for (const dir of ['V', 'U'] as const) {
    const { u, v } = gridSize(sp);
    const { rowsV, colsU } = fullRows(sp);
    const sel = new Set(dir === 'V' ? rowsV : colsU);
    const n = dir === 'V' ? v : u;
    const cyclic = dir === 'V' ? sp.use_cyclic_v : sp.use_cyclic_u;
    if (n < 2 || (dir === 'V' && v === 1)) continue;
    const pairs: number[] = [];
    for (let k = 0; k < (cyclic ? n : n - 1); k++) if (sel.has(k) && sel.has((k + 1) % n)) pairs.push(k);
    if (!pairs.length) continue;
    const at = (a: number, b: number) => (dir === 'V' ? sp.points[b * u + a] : sp.points[a * u + b]); // (along, across)
    const along = dir === 'V' ? u : v;
    const lines: SplinePoint[][] = [];
    for (let k = 0; k < n; k++) {
      lines.push(Array.from({ length: along }, (_, a) => at(a, k)));
      if (pairs.includes(k)) for (let c = 1; c <= cuts; c++) lines.push(Array.from({ length: along }, (_, a) => lerpPt(at(a, k), at(a, (k + 1) % n), c / (cuts + 1))));
    }
    if (dir === 'V') {
      sp.points = lines.flat();
      sp.point_count_v = lines.length;
    } else {
      // lines are columns: rebuild row-major
      const pts: SplinePoint[] = [];
      for (let j = 0; j < v; j++) for (const col of lines) pts.push(col[j]);
      sp.points = pts;
      sp.point_count_u = lines.length;
    }
    changed = true;
  }
  return changed;
}

/** For a 1-row spline: insert `cuts` points between neighbouring selected points. */
export function subdivideRow(sp: Spline, cuts: number): boolean {
  const n = sp.points.length;
  const out: SplinePoint[] = [];
  let changed = false;
  for (let i = 0; i < n; i++) {
    out.push(sp.points[i]);
    const j = (i + 1) % n;
    if ((j > i || sp.use_cyclic_u) && visibleSel(sp.points[i]) && visibleSel(sp.points[j]) && n > 1) {
      for (let c = 1; c <= cuts; c++) out.push(lerpPt(sp.points[i], sp.points[j], c / (cuts + 1)));
      changed = true;
    }
  }
  sp.points = out;
  sp.point_count_u = out.length;
  return changed;
}

/** The selected rectangle of the grid as a new spline (null when the selection is not a full rectangle). */
export function duplicateRect(sp: Spline): Spline | null {
  const { u, v } = gridSize(sp);
  let u0 = u,
    u1 = -1,
    v0 = v,
    v1 = -1;
  sp.points.forEach((p, i) => {
    if (!visibleSel(p)) return;
    const [a, b] = guv(sp, i);
    u0 = Math.min(u0, a);
    u1 = Math.max(u1, a);
    v0 = Math.min(v0, b);
    v1 = Math.max(v1, b);
  });
  if (u1 < 0) return null;
  const pts: SplinePoint[] = [];
  for (let b = v0; b <= v1; b++)
    for (let a = u0; a <= u1; a++) {
      const p = sp.points[b * u + a];
      if (!visibleSel(p)) return null;
      pts.push(copyPt(p, true));
    }
  const nu = u1 - u0 + 1,
    nv = v1 - v0 + 1;
  return {
    ...structuredClone(sp),
    points: pts,
    point_count_u: nu,
    point_count_v: nv,
    use_cyclic_u: nu === u && sp.use_cyclic_u,
    use_cyclic_v: nv === v && sp.use_cyclic_v,
    order_u: Math.min(sp.order_u, nu),
    order_v: nv > 1 ? Math.min(sp.order_v || 2, nv) : 0,
  };
}

/** Reverse the U direction of the grid. */
export function switchDirection(sp: Spline) {
  const { u, v } = gridSize(sp);
  const pts: SplinePoint[] = [];
  for (let j = 0; j < v; j++) for (let i = u - 1; i >= 0; i--) pts.push(sp.points[j * u + i]);
  sp.points = pts;
}

/**
 * Spin a profile (the selected row, or a whole 1-row spline) around an axis through `center` (object
 * space): the result is a closed surface of revolution of 8 rational rows (an exact circle around the axis).
 */
export function spinRow(profile: SplinePoint[], center: [number, number, number], axis: [number, number, number]): SplinePoint[][] {
  const len = Math.hypot(...axis) || 1;
  const n = axis.map((x) => x / len) as [number, number, number];
  const rows: SplinePoint[][] = [];
  for (let k = 0; k < 8; k++) {
    const ang = (k * Math.PI) / 4;
    const corner = k % 2 === 1;
    const c = Math.cos(ang),
      s = Math.sin(ang);
    rows.push(
      profile.map((p) => {
        const d = [p.co[0] - center[0], p.co[1] - center[1], p.co[2] - center[2]];
        const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
        const r = [d[0] - n[0] * along, d[1] - n[1] * along, d[2] - n[2] * along];
        const b = [n[1] * r[2] - n[2] * r[1], n[2] * r[0] - n[0] * r[2], n[0] * r[1] - n[1] * r[0]];
        // corners of the circle's control square sit √2 further out with weight √½
        const scale = corner ? Math.SQRT2 : 1;
        const q = [0, 1, 2].map((k2) => center[k2] + n[k2] * along + (r[k2] * c + b[k2] * s) * scale);
        return { ...p, co: [q[0], q[1], q[2], (p.co[3] || 1) * (corner ? Math.SQRT1_2 : 1)] as P4, select: true };
      }),
    );
  }
  return rows;
}
