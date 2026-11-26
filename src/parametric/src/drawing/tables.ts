// Tables and balloons on drawing sheets: an assembly's bill of materials and a weldment's
// cut list as tables of fixed column widths (so a table keeps its place and size as its rows
// change), item balloons with their leaders, and where automatic balloons go around a view.

import type { DrawingRef } from '../model/types';
import type { Geo } from './annotate';
import { textWidth } from './pdf';
import type { Item } from './sheet';
import type { BomRow } from './source';
import type { P2, Prim } from './views';

type Box = [number, number, number, number];
type Align = 'start' | 'middle' | 'end';

export interface TableSpec {
  header: string[];
  /** Column widths in sheet millimetres. */
  widths: number[];
  rows: string[][];
  /** Alignment of each column's values (absent: start). */
  align?: Align[];
}

export const TABLE_ROW_H = 6;
export const TABLE_TEXT = 2.5;
const PAD = 1.2;
const MIN_TEXT = 1.6;

export function tableSize(t: TableSpec): { w: number; h: number } {
  return { w: t.widths.reduce((a, b) => a + b, 0), h: (t.rows.length + 1) * TABLE_ROW_H };
}

/** The top left corner of a table placed at `at` (its top left, or with 'bottomRight' its bottom right corner). */
export function tableOrigin(t: TableSpec, at: P2, anchor?: 'bottomRight'): P2 {
  if (anchor !== 'bottomRight') return at;
  const { w, h } = tableSize(t);
  return [at[0] - w, at[1] - h];
}

/** A value fitted to a cell: shrunk down to a legible size, then cut short. */
export function fitCell(s: string, room: number, size: number, bold = false): { s: string; size: number } {
  const w = textWidth(s, size, bold);
  if (w <= room) return { s, size };
  size = Math.max(MIN_TEXT, (size * room) / w);
  if (textWidth(s, size, bold) <= room + 1e-9) return { s, size };
  let n = s.length;
  while (n > 0 && textWidth(`${s.slice(0, n).trimEnd()}…`, size, bold) > room) n--;
  return { s: `${s.slice(0, n).trimEnd()}…`, size };
}

/**
 * Where every cell of a table is: the column edges, the row edges (the header first) and each
 * value's text position. Pure, for drawing and for tests.
 */
export function layoutTable(t: TableSpec, at: P2, anchor?: 'bottomRight') {
  const [x0, y0] = tableOrigin(t, at, anchor);
  const { w, h } = tableSize(t);
  const cols = [x0];
  for (const cw of t.widths) cols.push(cols[cols.length - 1] + cw);
  const rows: number[] = [];
  for (let i = 0; i <= t.rows.length + 1; i++) rows.push(y0 + i * TABLE_ROW_H);
  const cell = (r: number, c: number, s: string, bold: boolean, align: Align) => {
    const room = t.widths[c] - 2 * PAD;
    const f = fitCell(s, room, TABLE_TEXT, bold);
    const x = align === 'middle' ? (cols[c] + cols[c + 1]) / 2 : align === 'end' ? cols[c + 1] - PAD : cols[c] + PAD;
    return { s: f.s, size: f.size, x, y: rows[r] + TABLE_ROW_H / 2 + f.size * 0.36, bold, anchor: align };
  };
  const texts = [
    ...t.header.map((s, c) => cell(0, c, s, true, 'middle')),
    ...t.rows.flatMap((row, r) => row.map((s, c) => cell(r + 1, c, s, false, t.align?.[c] ?? 'start'))),
  ];
  return { box: [x0, y0, x0 + w, y0 + h] as Box, cols, rows, texts };
}

/** The gap between the columns of a table split to fit the sheet. */
export const TABLE_SPLIT_GAP = 4;

/**
 * A table cut into columns that fit between `top` and `bottom` (the sheet's border): each with
 * the header again, the first where the table is placed and the next ones beside it, to the
 * left of a table placed by its bottom right corner (each standing on the same line), else to
 * its right. `fits` is false when even so they reach past `left` or `right`, or a single row
 * does not fit.
 */
export function splitTable(t: TableSpec, at: P2, anchor: 'bottomRight' | undefined, room: { top: number; bottom: number; left: number; right: number }):
  { parts: { t: TableSpec; at: P2 }[]; box: Box; fits: boolean } {
  const avail = anchor === 'bottomRight' ? at[1] - room.top : room.bottom - at[1];
  const per = Math.floor(avail / TABLE_ROW_H + 1e-9) - 1;
  const whole = tableSize(t);
  if (whole.h <= avail + 1e-9 || per < 1) {
    const L = layoutTable(t, at, anchor);
    const b = L.box;
    return { parts: [{ t, at }], box: b, fits: whole.h <= avail + 1e-9 && b[0] >= room.left - 1e-9 && b[2] <= room.right + 1e-9 };
  }
  const parts: { t: TableSpec; at: P2 }[] = [];
  const step = whole.w + TABLE_SPLIT_GAP;
  for (let i = 0, k = 0; i < t.rows.length; i += per, k++) {
    const dx = anchor === 'bottomRight' ? -k * step : k * step;
    parts.push({ t: { ...t, rows: t.rows.slice(i, i + per) }, at: [at[0] + dx, at[1]] });
  }
  const boxes = parts.map((p) => layoutTable(p.t, p.at, anchor).box);
  const box: Box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  return { parts, box, fits: box[0] >= room.left - 1e-9 && box[2] <= room.right + 1e-9 };
}

/** Draws a table (split into columns to stay inside `room`, the sheet's border, when given); returns its box and whether it fits. */
export function drawTable(items: Item[], t: TableSpec, at: P2, anchor?: 'bottomRight', room?: { top: number; bottom: number; left: number; right: number }): { box: Box; fits: boolean } {
  const split = room ? splitTable(t, at, anchor, room) : { parts: [{ t, at }], box: layoutTable(t, at, anchor).box, fits: true };
  for (const part of split.parts) {
    const L = layoutTable(part.t, part.at, anchor);
    const [x0, y0, x1, y1] = L.box;
    items.push({ t: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, sw: 0.35 });
    L.rows.slice(1, -1).forEach((y, i) => items.push({ t: 'line', x1: x0, y1: y, x2: x1, y2: y, w: i === 0 ? 0.35 : 0.18 }));
    for (const x of L.cols.slice(1, -1)) items.push({ t: 'line', x1: x, y1: y0, x2: x, y2: y1, w: 0.18 });
    for (const c of L.texts) if (c.s) items.push({ t: 'text', s: c.s, x: c.x, y: c.y, size: c.size, bold: c.bold || undefined, anchor: c.anchor });
  }
  return { box: split.box, fits: split.fits };
}

/** The bill of materials table: item number, part, material and quantity. */
export function bomTable(rows: BomRow[]): TableSpec {
  return {
    header: ['ITEM NO.', 'PART NUMBER', 'MATERIAL', 'QTY.'],
    widths: [16, 52, 44, 14],
    rows: rows.map((r) => [String(r.item), r.name, r.description || r.material || '', String(r.qty)]),
    align: ['middle', 'start', 'start', 'middle'],
  };
}

/**
 * The cut list table from the cut list's rows as text (cutListRows in src/model/weldments.ts:
 * item, quantity, description, length, angle 1, angle 2, ...).
 */
export function cutListTable(rows: string[][], lengthUnit: string): TableSpec {
  return {
    header: ['ITEM NO.', 'QTY.', 'DESCRIPTION', `LENGTH (${lengthUnit})`, 'ANGLE1', 'ANGLE2'],
    widths: [14, 10, 50, 22, 15, 15],
    rows: rows.map((r) => [r[0], r[1], r[2], r[3], `${r[4]}°`, `${r[5]}°`]),
    align: ['middle', 'middle', 'start', 'end', 'end', 'end'],
  };
}

// ---------- balloons ----------

export const BALLOON_R = 3.5;
const BALLOON_TEXT = 3.5;

/** The bill of materials row (item number) an edge of a view belongs to. */
export function itemOfEdge(edge: string, rows: BomRow[]): number | null {
  return rows.find((r) => r.prefixes.some((p) => edge.startsWith(p)))?.item ?? null;
}

/**
 * Where a balloon's leader meets its edge: on a line where it was attached (`t`, a fraction of
 * it from its start; absent: its middle), the point of a circle nearest the balloon, an arc's middle.
 */
export function balloonTip(g: Geo, at: P2, t?: number): P2 {
  if (g.kind === 'point') return g.p;
  if (g.kind === 'line') {
    const k = t ?? 0.5;
    return [g.a[0] + (g.b[0] - g.a[0]) * k, g.a[1] + (g.b[1] - g.a[1]) * k];
  }
  if (!g.full) return g.m;
  const dx = at[0] - g.c[0], dy = at[1] - g.c[1], l = Math.hypot(dx, dy) || 1;
  return [g.c[0] + (dx / l) * g.r, g.c[1] + (dy / l) * g.r];
}

/** A balloon: the item number in a circle, with a leader ending in a dot on its edge. Returns its box. */
export function drawBalloon(items: Item[], text: string, at: P2, tip: P2 | null, color?: string): Box {
  const R = BALLOON_R;
  items.push({ t: 'circle', cx: at[0], cy: at[1], r: R, w: 0.25, color });
  const w = textWidth(text, BALLOON_TEXT);
  const size = w > 2 * R - 1.4 ? (BALLOON_TEXT * (2 * R - 1.4)) / w : BALLOON_TEXT;
  items.push({ t: 'text', s: text, x: at[0], y: at[1] + size * 0.36, size, anchor: 'middle', color });
  if (tip) {
    const dx = tip[0] - at[0], dy = tip[1] - at[1], l = Math.hypot(dx, dy);
    if (l > R + 0.5) {
      items.push({ t: 'line', x1: at[0] + (dx / l) * R, y1: at[1] + (dy / l) * R, x2: tip[0], y2: tip[1], w: 0.18, color });
      items.push({ t: 'circle', cx: tip[0], cy: tip[1], r: 0.3, w: 0.6, color });
    }
  }
  return [at[0] - R, at[1] - R, at[0] + R, at[1] + R];
}

/**
 * Automatic balloons for a view: one per bill of materials row seen in it (and not in
 * `skip`), on an edge of one of the row's components toward the outside of the view, placed
 * on a ring around the view (`bounds`, view coordinates) and spread so they do not touch.
 * `s` is the view's scale (sheet millimetres per view unit); `clear` how far the ring stays
 * from the view on the sheet, left, top, right and bottom (past its dimensions and label).
 * Positions are view coordinates.
 */
export function autoBalloons(
  prims: Prim[], rows: BomRow[], bounds: [number, number, number, number], s: number, skip: Set<number> = new Set(), clear: [number, number, number, number] = [10, 10, 10, 10],
): { item: number; ref: DrawingRef; at: P2 }[] {
  const [bx0, by0, bx1, by1] = bounds;
  const c: P2 = [(bx0 + bx1) / 2, (by0 + by1) / 2];
  const span = Math.max(bx1 - bx0, by1 - by0, 1e-9);
  const picks: { item: number; edge: string; tip: P2 }[] = [];
  for (const r of rows) {
    if (skip.has(r.item)) continue;
    const mine = prims.filter((p) => p.kind !== 'points' && r.prefixes.some((x) => p.edge.startsWith(x)));
    if (!mine.length) continue;
    // An edge toward the outside of the view (more likely seen than one in the middle), not a tiny one.
    const size = (p: Prim) => (p.kind === 'line' ? Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) : p.kind === 'arc' ? p.r : 0);
    const longest = Math.max(...mine.map(size));
    let best: { edge: string; tip: P2 } | null = null, bestScore = -Infinity;
    for (const p of mine) {
      if (size(p) < longest * 0.2) continue;
      const tip: P2 = p.kind === 'line' ? [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2] : p.kind === 'arc' ? (p.full ? [p.c[0] + p.r, p.c[1]] : p.m) : p.a;
      const score = Math.hypot(tip[0] - c[0], tip[1] - c[1]) / span + (0.25 * size(p)) / span;
      if (score > bestScore) { bestScore = score; best = { edge: p.edge, tip }; }
    }
    if (best) picks.push({ item: r.item, ...best });
  }
  if (!picks.length) return [];
  // A ring around the view, clear of it on the sheet.
  const m = clear.map((c) => (c + BALLOON_R) / s);
  const X0 = bx0 - m[0], Y0 = by0 - m[1], X1 = bx1 + m[2], Y1 = by1 + m[3];
  const W = X1 - X0, H = Y1 - Y0, L = 2 * (W + H);
  const at = (t: number): P2 => {
    t = ((t % L) + L) % L;
    if (t < W) return [X0 + t, Y0];
    if (t < W + H) return [X1, Y0 + (t - W)];
    if (t < 2 * W + H) return [X1 - (t - W - H), Y1];
    return [X0, Y1 - (t - 2 * W - H)];
  };
  // Where the ray from the view's centre through the tip leaves the ring, as a distance along it.
  const param = (tip: P2): number => {
    let dx = tip[0] - c[0], dy = tip[1] - c[1];
    if (Math.hypot(dx, dy) < 1e-9) { dx = 1; dy = -1; }
    const k = Math.min(dx > 0 ? (X1 - c[0]) / dx : dx < 0 ? (X0 - c[0]) / dx : Infinity, dy > 0 ? (Y1 - c[1]) / dy : dy < 0 ? (Y0 - c[1]) / dy : Infinity);
    const px = c[0] + dx * k, py = c[1] + dy * k;
    const e = 1e-9 * (1 + W + H);
    if (Math.abs(py - Y0) < e) return px - X0;
    if (Math.abs(px - X1) < e) return W + (py - Y0);
    if (Math.abs(py - Y1) < e) return W + H + (X1 - px);
    return 2 * W + H + (Y1 - py);
  };
  const order = picks.map((p) => ({ ...p, t: param(p.tip) })).sort((a, b) => a.t - b.t);
  // Spread along the ring: at least two balloons and a gap apart (less when they do not fit).
  const gap = Math.min((2 * BALLOON_R + 3) / s, L / order.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < order.length; i++) if (order[i].t - order[i - 1].t < gap) order[i].t = order[i - 1].t + gap;
    const n = order.length;
    if (n > 1 && order[0].t + L - order[n - 1].t < gap) {
      const over = gap - (order[0].t + L - order[n - 1].t);
      for (const o of order) o.t -= over / 2;
    }
  }
  return order.map((o) => ({ item: o.item, ref: { edge: o.edge, at: 'edge' as const }, at: at(o.t).map((v) => +v.toFixed(4)) as P2 }));
}
