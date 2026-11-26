// Drawing sheets: sizes, scales, standard view directions, automatic layout
// and a display list (lines, paths, text) that renders identically to SVG
// (on screen and export) and PDF.

import type { EdgeInfo, ProjectionResult } from '../kernel/protocol';
import { type Vec3, cross, normalize } from '../math/vec';
import { bendNote } from '../model/flat-pattern';
import type { DrawingBom, DrawingCutList, DrawingDoc, DrawingView, DrawingViewKind, SheetSize } from '../model/types';
import {
  type AnnoFormat, type Geo, type HoleSpec, type Placement, DANGER, DIM_TEXT_SIZE, NOTE_SIZE, drawCenterMark, drawCenterline, drawCuttingLine,
  drawDetailCircle, drawDimension, drawNote, drawViewArrow, holeCalloutText, measure, resolveRef,
} from './annotate';
import type { FlatProjection } from './flat';
import { PdfPage, textWidth } from './pdf';
import { type TableSpec, balloonTip, drawBalloon, drawTable } from './tables';
import { type Prim, type ResolvedView, centerMarks, clipToCircle, flattenPath, hatch, holeAxes, polyPath, resolveViews, standardKindOf, viewPrims } from './views';

/** Portrait sizes in millimetres. */
export const SHEETS: Record<SheetSize, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  Letter: [215.9, 279.4],
  Tabloid: [279.4, 431.8],
  'ANSI C': [431.8, 558.8],
  'ANSI D': [558.8, 863.6],
};

export const SHEET_LABELS: Record<SheetSize, string> = {
  A4: 'A4 (297 x 210 mm)', A3: 'A3 (420 x 297 mm)', A2: 'A2 (594 x 420 mm)', A1: 'A1 (841 x 594 mm)',
  Letter: 'Letter (11 x 8.5 in)', Tabloid: 'Tabloid (17 x 11 in)',
  'ANSI C': 'ANSI C (22 x 17 in)', 'ANSI D': 'ANSI D (34 x 22 in)',
};

export function sheetDims(d: Pick<DrawingDoc, 'sheet' | 'landscape'>): { w: number; h: number } {
  const [a, b] = SHEETS[d.sheet];
  return d.landscape ? { w: b, h: a } : { w: a, h: b };
}

export const STANDARD_SCALES = [20, 10, 5, 4, 2, 1, 1 / 2, 1 / 4, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 1 / 200];

export function scaleLabel(s: number): string {
  if (s >= 1) return `${Number(s.toFixed(3))}:1`;
  return `1:${Number((1 / s).toFixed(3))}`;
}

const isoDir = normalize([1, 1, 1]);

/** Direction toward the viewer and paper x axis of each standard view. */
export const VIEW_DIRS: Record<DrawingViewKind, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, 0, 1], x: [1, 0, 0] },
  back: { dir: [0, 0, -1], x: [-1, 0, 0] },
  top: { dir: [0, 1, 0], x: [1, 0, 0] },
  bottom: { dir: [0, -1, 0], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 0, -1] },
  left: { dir: [-1, 0, 0], x: [0, 0, 1] },
  isometric: { dir: isoDir, x: normalize(cross([0, 1, 0], isoDir)) },
};

export const VIEW_LABELS: Record<DrawingViewKind, string> = {
  front: 'Front', back: 'Back', top: 'Top', bottom: 'Bottom', right: 'Right', left: 'Left', isometric: 'Isometric',
};

/** Size of a view of a box, in model units (paper width, height). */
export function projectedSize(kind: DrawingViewKind, min: Vec3, max: Vec3): [number, number] {
  const { dir, x } = VIEW_DIRS[kind];
  const y = cross(dir, x);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const u = p[0] * x[0] + p[1] * x[1] + p[2] * x[2];
    const v = p[0] * y[0] + p[1] * y[1] + p[2] * y[2];
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  return [x1 - x0, y1 - y0];
}

export const MARGIN = 10;
export const TITLE_W = 170;
export const TITLE_H = 32;

/**
 * Standard three views (third-angle: top above front, right to the right)
 * plus an isometric view, at the largest standard scale that fits.
 */
/**
 * `bottom` is the height kept free along the bottom of the sheet (the title block's, and with
 * a bill of materials on it, the table's too).
 */
export function standardLayout(sheet: { w: number; h: number }, min: Vec3, max: Vec3, bottom = TITLE_H): { scale: number; views: Omit<DrawingView, 'id'>[] } {
  const f = projectedSize('front', min, max), t = projectedSize('top', min, max), r = projectedSize('right', min, max), i = projectedSize('isometric', min, max);
  const c1 = Math.max(f[0], t[0]), c2 = Math.max(r[0], i[0]);
  const r1 = Math.max(t[1], i[1]), r2 = Math.max(f[1], r[1]);
  // Room around each view for its dimensions and label: left of a view for
  // its height dimension, below it for its width dimension and label (the
  // top row needs that room as much as the bottom one).
  const gap = 15;
  const top = 5, below = (3 * gap - top) / 2;
  const availW = sheet.w - 2 * MARGIN - 3 * gap;
  const availH = sheet.h - 2 * MARGIN - bottom - 3 * gap;
  const fit = Math.min(availW / Math.max(c1 + c2, 1e-6), availH / Math.max(r1 + r2, 1e-6));
  const scale = STANDARD_SCALES.find((s) => s <= fit) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1];
  const x1 = MARGIN + gap + (c1 * scale) / 2;
  const x2 = MARGIN + 2 * gap + c1 * scale + (c2 * scale) / 2;
  const y1 = MARGIN + top + (r1 * scale) / 2;
  const y2 = MARGIN + top + below + r1 * scale + (r2 * scale) / 2;
  return {
    scale,
    views: [
      { kind: 'front', x: x1, y: y2, hidden: true, dims: true },
      { kind: 'top', x: x1, y: y1, hidden: true, dims: true },
      { kind: 'right', x: x2, y: y2, hidden: true, dims: true },
      { kind: 'isometric', x: x2, y: y1, hidden: false, dims: false },
    ],
  };
}

/**
 * Where a new view of paper size (vw, vh) goes: the first spot, scanning the
 * sheet row by row from the top left, where it, its dimensions and its label
 * stay inside the border and clear of the title block and of the other views
 * with their dimensions and labels. The middle of the sheet when there is
 * no such spot.
 */
export function placeView(
  sheet: { w: number; h: number },
  vw: number,
  vh: number,
  dims: boolean,
  others: { frame: ViewFrame; dims: boolean }[],
): [number, number] {
  return freeSpot(sheet, vw, vh, dims, others) ?? [sheet.w / 2, sheet.h / 2];
}

/** The spot placeView finds, null when there is none. */
export function freeSpot(
  sheet: { w: number; h: number },
  vw: number,
  vh: number,
  dims: boolean,
  others: { frame: ViewFrame; dims: boolean }[],
): [number, number] | null {
  const room = (x0: number, y0: number, x1: number, y1: number, d: boolean): Box =>
    [x0 - (d ? DIM_LEFT : 2), y0 - 2, x1 + 2, y1 + (d ? 18 : 9)];
  const taken = others.map(({ frame: f, dims: d }) => room(f.x0, f.y0, f.x1, f.y1, d));
  const { w, h } = sheet;
  taken.push([w - MARGIN - TITLE_W, h - MARGIN - TITLE_H, w - MARGIN, h - MARGIN]);
  const overlaps = (b: Box) => taken.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const step = 5;
  for (let y = MARGIN + vh / 2 + 2; y + vh / 2 <= h - MARGIN; y += step) {
    for (let x = MARGIN + vw / 2 + (dims ? DIM_LEFT : 2); x + vw / 2 <= w - MARGIN; x += step) {
      const b = room(x - vw / 2, y - vh / 2, x + vw / 2, y + vh / 2, dims);
      if (b[2] <= w - MARGIN && b[3] <= h - MARGIN && !overlaps(b)) return [x, y];
    }
  }
  return null;
}

/**
 * Changes the projection angle of a drawing so every view still shows what it showed: the
 * standard views beside a front view (top and bottom above or below it, left and right beside
 * it, and an isometric view in the row of a top or bottom view) and projected views move to
 * the other side of their parent at the same distance; section and auxiliary views keep their
 * place and look the same way (their line turns round, which first angle reads the other way).
 * The views that moved, with the views aligned to them, then slide together to stay on the
 * sheet and clear of the title block. `frameOf` gives a view's frame where it is now.
 */
export function switchProjection(d: DrawingDoc, to: 'first' | 'third', frameOf: (v: DrawingView) => ViewFrame | undefined) {
  if ((d.projection ?? 'third') === to) return;
  const frames = new Map(d.views.map((v) => [v.id, frameOf(v)]));
  const old = new Map(d.views.map((v) => [v.id, [v.x, v.y] as [number, number]]));
  d.projection = to;
  const byId = new Map(d.views.map((v) => [v.id, v]));
  const moved = new Set<string>();
  const isModel = (v: DrawingView) => (v.type ?? 'model') === 'model';
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  for (const f of d.views.filter((v) => isModel(v) && v.kind === 'front')) {
    const rows = new Set<number>();
    for (const v of d.views) {
      if (!isModel(v) || moved.has(v.id) || v === f) continue;
      if ((v.kind === 'top' || v.kind === 'bottom') && near(v.x, f.x)) { rows.add(v.y); v.y = 2 * f.y - v.y; moved.add(v.id); moved.add(f.id); }
      else if ((v.kind === 'left' || v.kind === 'right') && near(v.y, f.y)) { v.x = 2 * f.x - v.x; moved.add(v.id); moved.add(f.id); }
    }
    for (const v of d.views) if (isModel(v) && v.kind === 'isometric' && !moved.has(v.id) && [...rows].some((y) => near(v.y, y))) { v.y = 2 * f.y - v.y; moved.add(v.id); }
  }
  // Projected views, each after its parent: the other side, at the same distance.
  const flip: Record<string, 'left' | 'right' | 'above' | 'below'> = { left: 'right', right: 'left', above: 'below', below: 'above' };
  const done = new Set<string>();
  const visit = (v: DrawingView, depth: number) => {
    if (done.has(v.id) || depth > 32) return;
    done.add(v.id);
    const p = v.parent ? byId.get(v.parent) : undefined;
    if (p) visit(p, depth + 1);
    if (v.type === 'section' || v.type === 'auxiliary') {
      if (v.line) v.line = [v.line[2], v.line[3], v.line[0], v.line[1]];
      return;
    }
    if (v.type !== 'projected' || !p) return;
    const [px, py] = old.get(p.id)!;
    const side = v.side ?? 'right';
    v.side = flip[side];
    if (side === 'left' || side === 'right') { v.x = 2 * p.x - (v.x - px + p.x); v.y += p.y - py; }
    else { v.y = 2 * p.y - (v.y - py + p.y); v.x += p.x - px; }
    moved.add(v.id);
  };
  for (const v of d.views) visit(v, 0);
  if (!moved.size) return;
  // With the views aligned to those that moved (they move together when dragged too).
  const group = new Set(moved);
  for (let grew = true; grew;) {
    grew = false;
    for (const v of d.views) {
      if (group.has(v.id) || !v.parent || !group.has(v.parent)) continue;
      const aligned = v.type === 'projected' || ((v.type === 'section' || v.type === 'auxiliary') && !!v.line && (v.line[0] === v.line[2] || v.line[1] === v.line[3]));
      if (aligned) { group.add(v.id); grew = true; }
    }
  }
  const { w, h } = sheetDims(d);
  const boxes: Box[] = [];
  for (const id of group) {
    const v = byId.get(id)!, f = frames.get(id), o = old.get(id)!;
    if (!f) continue;
    const dx = v.x - o[0], dy = v.y - o[1];
    const dims = hasDims(v);
    boxes.push([f.x0 + dx - (dims ? DIM_LEFT : 0), f.y0 + dy, f.x1 + dx, f.y1 + dy + (dims ? DIM_BELOW + 8 : 9)]);
  }
  if (!boxes.length) return;
  const U: Box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  const fit = (lo: number, hi: number, min: number, max: number) => (lo < min ? min - lo : hi > max ? Math.max(max - hi, min - lo) : 0);
  const sx = fit(U[0], U[2], MARGIN, w - MARGIN);
  let sy = fit(U[1], U[3], MARGIN, h - MARGIN);
  // Up, clear of the title block, as far as the top border allows.
  const tb = titleBlockSize(d);
  const T: Box = [w - MARGIN - tb.w, h - MARGIN - tb.h, w - MARGIN, h - MARGIN];
  const over = Math.max(0, ...boxes.filter((b) => b[0] + sx < T[2] && b[2] + sx > T[0] && b[1] + sy < T[3] && b[3] + sy > T[1]).map((b) => b[3] + sy - T[1]));
  sy -= Math.min(over, Math.max(0, U[1] + sy - MARGIN));
  if (!sx && !sy) return;
  for (const id of group) { const v = byId.get(id)!; v.x += sx; v.y += sy; }
}

// ---------- display list ----------

export type Item =
  | { t: 'path'; d: string; tx: number; ty: number; s: number; w: number; dash?: number[]; view?: string; color?: string }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; dash?: number[]; color?: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; sw: number }
  | { t: 'tri'; a: [number, number]; b: [number, number]; c: [number, number]; color?: string }
  | { t: 'circle'; cx: number; cy: number; r: number; w: number; dash?: number[]; color?: string }
  | { t: 'text'; s: string; x: number; y: number; size: number; bold?: boolean; anchor?: 'start' | 'middle' | 'end'; rotate?: number; color?: string };

export interface SheetInfo {
  partName: string;
  material: string;
  units: string;
  date: string;
  formatLength: (mm: number) => string;
  /** Model edges of a view's source, for dimensions and centre marks (absent: none drawn). */
  edges?: (source: string) => EdgeInfo[];
  /** Lengths with a dimension's own decimals, and angles (absent: formatLength and 2 decimals). */
  format?: AnnoFormat;
  /** The hole a circular edge belongs to, for hole callouts. */
  holeOf?: (edge: string) => HoleSpec | null;
  /** What a bill of materials or cut list table lists (null: there is nothing it could list). */
  table?: (a: DrawingBom | DrawingCutList) => TableSpec | null;
  /** The item number of the component or member an edge of a source belongs to (balloons). */
  itemOf?: (source: string, edge: string) => number | null;
}

export interface ViewFrame {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where a view is drawn: sheet = view coordinates * s + (tx, ty). */
export interface ViewPlacement {
  r: ResolvedView;
  tx: number;
  ty: number;
  s: number;
  frame: ViewFrame;
  /** The model edges it shows (when the sheet was given them). */
  prims: Prim[];
}

const MIN_TEXT = 1.8;
const VISIBLE_W = 0.35;
const HIDDEN_W = 0.18;
const THIN = 0.18;
export const HATCH_SPACING = 3;

/** The label under a view. */
export function viewCaption(d: DrawingDoc, r: ResolvedView): string {
  const v = r.v;
  const scale = Math.abs(r.scale - d.scale) > 1e-12 ? `  SCALE ${scaleLabel(r.scale)}` : '';
  const letter = (v.label ?? '').toUpperCase();
  switch (r.type) {
    case 'section': return `SECTION ${letter || 'A'}-${letter || 'A'}${scale}`;
    case 'detail': return `DETAIL ${letter || 'A'}${scale}`;
    case 'auxiliary': return `${letter ? `VIEW ${letter}` : 'AUXILIARY VIEW'}${scale}`;
    case 'flat': return `${letter || 'FLAT PATTERN'}${scale}`;
    case 'projected': {
      if (letter) return letter + scale;
      const k = standardKindOf(r.o);
      return `${k ? VIEW_LABELS[k as DrawingViewKind].toUpperCase() : 'PROJECTED VIEW'}${scale}`;
    }
    default: return `${letter || VIEW_LABELS[v.kind].toUpperCase()}${scale}`;
  }
}

/** Builds the sheet's display list. Also returns each view's frame on the sheet. */
export function buildSheet(d: DrawingDoc, projections: Map<string, ProjectionResult>, info: SheetInfo): {
  items: Item[]; frames: ViewFrame[]; w: number; h: number;
  /** Where each projected view is drawn. */
  placements: Map<string, ViewPlacement>;
  /** Boxes of the annotations, for picking. */
  annos: { id: string; box: Box }[];
  /** What does not fit on the sheet (said in red on it too). */
  warnings: string[];
} {
  const { w, h } = sheetDims(d);
  const items: Item[] = [];
  const frames: ViewFrame[] = [];
  items.push({ t: 'rect', x: MARGIN, y: MARGIN, w: w - 2 * MARGIN, h: h - 2 * MARGIN, sw: 0.5 });
  const resolved = resolveViews(d);
  const placed: { v: DrawingView; r: ResolvedView; pr: ProjectionResult; tx: number; ty: number; s: number; f: ViewFrame }[] = [];
  const placements = new Map<string, ViewPlacement>();
  const place = (v: DrawingView, depth = 0): ViewPlacement | undefined => {
    const done = placements.get(v.id);
    if (done || depth > 32) return done;
    const r = resolved.get(v.id);
    const pr = projections.get(v.id);
    if (!r || !pr || !pr.bounds) return undefined;
    const s = r.scale;
    const [bx0, by0, bx1, by1] = pr.bounds;
    let tx: number, ty: number, f: ViewFrame;
    if (r.type === 'detail' && r.clip) {
      tx = v.x - s * r.clip.c[0];
      ty = v.y - s * r.clip.c[1];
      const R = r.clip.r * s;
      f = { id: v.id, x0: v.x - R, y0: v.y - R, x1: v.x + R, y1: v.y + R };
    } else {
      tx = v.x - (s * (bx0 + bx1)) / 2;
      ty = v.y - (s * (by0 + by1)) / 2;
      // Aligned with its parent: the axis they share lines up (the same scale, so the same offset).
      const pv = r.align && r.parent ? d.views.find((q) => q.id === r.parent!.v.id) : undefined;
      const pp = pv ? place(pv, depth + 1) : undefined;
      if (pp && r.align === 'y') ty = pp.ty;
      if (pp && r.align === 'x') tx = pp.tx;
      f = { id: v.id, x0: tx + bx0 * s, y0: ty + by0 * s, x1: tx + bx1 * s, y1: ty + by1 * s };
    }
    const edges = info.edges?.(r.source);
    const p: ViewPlacement = { r, tx, ty, s, frame: f, prims: edges ? viewPrims(r, edges) : [] };
    placements.set(v.id, p);
    return p;
  };
  for (const v of d.views) {
    const p = place(v);
    if (!p) continue;
    frames.push(p.frame);
    placed.push({ v, r: p.r, pr: projections.get(v.id)!, tx: p.tx, ty: p.ty, s: p.s, f: p.frame });
  }
  // What a view label must stay clear of: every view with its dimensions,
  // the labels already placed and the title block.
  const taken: Box[] = placed.map(({ v, f }) => (hasDims(v) ? [f.x0 - DIM_LEFT, f.y0, f.x1, f.y1 + DIM_BELOW] : [f.x0, f.y0, f.x1, f.y1]));
  const tb = titleBlockSize(d);
  taken.push([w - MARGIN - tb.w, h - MARGIN - tb.h, w - MARGIN, h - MARGIN]);
  // Dimensions first: a value moved outside its lines is something labels must avoid too.
  const dims = placed.map(({ v, pr, f }) => {
    const out: Item[] = [];
    if (!hasDims(v)) return out;
    const [bx0, by0, bx1, by1] = pr.bounds!;
    taken.push(dimension(out, [f.x0, f.y1], [f.x1, f.y1], 'below', info.formatLength(bx1 - bx0)));
    taken.push(dimension(out, [f.x0, f.y0], [f.x0, f.y1], 'left', info.formatLength(by1 - by0)));
    return out;
  });
  for (const [i, { v, r, pr, tx, ty, s, f }] of placed.entries()) {
    if (r.type === 'detail' && r.clip) {
      // The parent's lines, magnified and cut off at the circle.
      const c: [number, number] = [v.x, v.y], R = r.clip.r * s;
      const clipped = (paths: string[]) => paths.flatMap((p) => flattenPath(p, tx, ty, s, 0.02)).flatMap((pl) => clipToCircle(pl, c, R)).map(polyPath);
      if (v.hidden) for (const p of clipped(pr.hidden)) items.push({ t: 'path', d: p, tx: 0, ty: 0, s: 1, w: HIDDEN_W, dash: [1.6, 0.8], view: v.id });
      for (const p of clipped(pr.visible)) items.push({ t: 'path', d: p, tx: 0, ty: 0, s: 1, w: VISIBLE_W, view: v.id });
      if (pr.cut?.length) {
        const segs = hatchGroups(pr).flatMap(([cut, angle]) => hatch(cut.map((pl) => pl.map((q, k) => (k % 2 ? q * s + ty : q * s + tx))), angle, HATCH_SPACING))
          .flatMap(([x1, y1, x2, y2]) => clipToCircle([[x1, y1], [x2, y2]], c, R)).map(polyPath);
        if (segs.length) items.push({ t: 'path', d: segs.join(''), tx: 0, ty: 0, s: 1, w: THIN, view: v.id });
      }
      // A detail of a flat pattern shows its bend lines too.
      if (r.parent?.type === 'flat') {
        for (const b of (pr as FlatProjection).bends ?? []) {
          for (const seg of clipToCircle([[tx + b.a[0] * s, ty + b.a[1] * s], [tx + b.b[0] * s, ty + b.b[1] * s]], c, R)) {
            items.push({ t: 'line', x1: seg[0][0], y1: seg[0][1], x2: seg[seg.length - 1][0], y2: seg[seg.length - 1][1], w: THIN, dash: b.up ? [4, 1.5] : [4, 1.2, 1, 1.2] });
          }
        }
      }
      items.push({ t: 'circle', cx: c[0], cy: c[1], r: R, w: THIN });
    } else {
      if (v.hidden) for (const p of pr.hidden) items.push({ t: 'path', d: p, tx, ty, s, w: HIDDEN_W, dash: [1.6, 0.8], view: v.id });
      for (const p of pr.visible) items.push({ t: 'path', d: p, tx, ty, s, w: VISIBLE_W, view: v.id });
      if (pr.cut?.length) {
        for (const [cut, angle] of hatchGroups(pr)) {
          const segs = hatch(cut.map((pl) => pl.map((q, k) => (k % 2 ? q * s + ty : q * s + tx))), angle, HATCH_SPACING);
          if (segs.length) items.push({ t: 'path', d: segs.map(([x1, y1, x2, y2]) => `M${+x1.toFixed(4)} ${+y1.toFixed(4)}L${+x2.toFixed(4)} ${+y2.toFixed(4)}`).join(''), tx: 0, ty: 0, s: 1, w: THIN, view: v.id });
        }
      }
      if (r.type === 'flat') drawBendLines(items, (pr as FlatProjection).bends ?? [], tx, ty, s, info.formatLength);
    }
    const label = viewLabel(viewCaption(d, r), f, hasDims(v), taken.filter((_, j) => j !== i), w, h);
    items.push(label.item);
    taken.push(label.box);
    const notes = r.type === 'flat' ? (pr as FlatProjection).notes : undefined;
    if (notes?.length) taken.push(drawFlatNotes(items, notes, f, hasDims(v), label.box, w));
    items.push(...dims[i]);
  }
  // A flat pattern view of a part that cannot be flattened says why where it would be.
  for (const v of d.views) {
    const pr = projections.get(v.id) as FlatProjection | undefined;
    if (v.type === 'flat' && pr?.error && !placements.has(v.id)) drawNote(items, `FLAT PATTERN: ${pr.error}`, [v.x - 30, v.y], 2.5, undefined, DANGER);
  }
  // A view with nothing to show (a section whose cutting line misses the part) says so where it
  // is, and can still be selected, moved and deleted there.
  for (const v of d.views) {
    const r = resolved.get(v.id), pr = projections.get(v.id);
    if (!r || !pr || pr.bounds || placements.has(v.id) || (pr as FlatProjection).error) continue;
    const text = `${viewCaption(d, r).replace(/\s+SCALE .*$/, '')}: ${r.type === 'section' ? 'THE CUTTING LINE MISSES THE PART' : 'NOTHING TO SHOW'}`;
    const box = drawNote(items, text, [v.x - textWidth(text, 2.5) / 2, v.y], 2.5, undefined, DANGER);
    frames.push({ id: v.id, x0: box[0], y0: box[1], x1: box[2], y1: box[3] });
  }
  const fmt: AnnoFormat = info.format ?? { length: (mm) => info.formatLength(mm), angle: (deg, dec) => `${deg.toFixed(dec ?? 2)}°` };
  // What sections and details leave on their parents (also while the view itself is empty or still projecting).
  for (const v of d.views) {
    const r = resolved.get(v.id);
    const pp = r?.parent && placements.get(r.parent.v.id);
    if (!r || !pp) continue;
    const T = (q: [number, number]): [number, number] => [pp.tx + q[0] * pp.s, pp.ty + q[1] * pp.s];
    const letter = (v.label || 'A').toUpperCase();
    if (r.type === 'section' && v.line && r.toward) {
      const first = d.projection === 'first';
      const sight: [number, number] = first ? r.toward : [-r.toward[0], -r.toward[1]];
      drawCuttingLine(items, T([v.line[0], v.line[1]]), T([v.line[2], v.line[3]]), sight, letter);
    } else if (r.type === 'auxiliary' && v.line && r.toward) {
      const first = d.projection === 'first';
      const sight: [number, number] = first ? r.toward : [-r.toward[0], -r.toward[1]];
      drawViewArrow(items, T([(v.line[0] + v.line[2]) / 2, (v.line[1] + v.line[3]) / 2]), sight, letter);
    } else if (r.type === 'detail' && r.clip) drawDetailCircle(items, T(r.clip.c), r.clip.r * pp.s, letter);
  }
  // Centre marks and hole axes of the views that show them.
  for (const { v, r } of placed) {
    if (!v.centerMarks) continue;
    const p = placements.get(v.id)!;
    const T = (q: [number, number]): [number, number] => [p.tx + q[0] * p.s, p.ty + q[1] * p.s];
    const inside = (q: [number, number]) => !r.clip || Math.hypot(q[0] - v.x, q[1] - v.y) <= r.clip.r * p.s;
    for (const m of centerMarks(p.prims)) if (inside(T(m.c))) drawCenterMark(items, T(m.c), m.r * p.s);
    const edges = info.edges?.(r.source);
    if (edges && !r.clip) for (const a of holeAxes(r, edges)) drawCenterline(items, T(a.a), T(a.b));
  }
  const warnings: string[] = [];
  const annos = drawAnnotations(items, d, placements, info, fmt, warnings);
  if (d.titleBlock === 'full') titleBlockFull(items, w, h, d, info);
  else titleBlock(items, w, h, d, info);
  return { items, frames, w, h, placements, annos, warnings };
}

/** Draws the annotations; returns their boxes. */
function drawAnnotations(items: Item[], d: DrawingDoc, placements: Map<string, ViewPlacement>, info: SheetInfo, fmt: AnnoFormat, warnings: string[]): { id: string; box: Box }[] {
  const out: { id: string; box: Box }[] = [];
  for (const a of d.annotations ?? []) {
    const p = a.view ? placements.get(a.view) : undefined;
    // An annotation of a view not drawn (still being projected, or its part has no solid) waits for it.
    if (a.view && !p) continue;
    const pl: Placement = p ? { T: (q) => [p.tx + q[0] * p.s, p.ty + q[1] * p.s], s: p.s } : { T: (q) => q, s: 1 };
    const prims = p?.prims ?? [];
    switch (a.type) {
      case 'dimension': {
        const gs = a.refs.map((ref) => resolveRef(prims, ref));
        const m = gs.every((g) => !!g) && gs.length ? measure(a.kind, gs as Geo[]) : null;
        out.push({ id: a.id, box: drawDimension(items, a, m, pl, fmt) });
        break;
      }
      case 'note': {
        const at = pl.T(a.at);
        out.push({ id: a.id, box: drawNote(items, a.text, at, a.size ?? NOTE_SIZE, a.leader ? pl.T(a.leader) : undefined) });
        break;
      }
      case 'centerMark': {
        const g = resolveRef(prims, { edge: a.ref.edge, at: 'edge' });
        if (g?.kind === 'circle') {
          const c = pl.T(g.c);
          drawCenterMark(items, c, g.r * pl.s);
          out.push({ id: a.id, box: [c[0] - 2, c[1] - 2, c[0] + 2, c[1] + 2] });
        } else {
          const at = p ? [p.frame.x0, p.frame.y0 - 2] as [number, number] : [0, 0] as [number, number];
          out.push({ id: a.id, box: drawNote(items, 'CENTER MARK? (missing)', at, 2.5, undefined, DANGER) });
        }
        break;
      }
      case 'centerline': {
        const g1 = resolveRef(prims, a.refs[0]), g2 = resolveRef(prims, a.refs[1]);
        if (g1?.kind === 'line' && g2?.kind === 'line') {
          // Midway between the two edges, over the length they share.
          const u = (([dx, dy]) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] as [number, number]; })([g1.b[0] - g1.a[0], g1.b[1] - g1.a[1]]);
          const t = (q: [number, number]) => q[0] * u[0] + q[1] * u[1];
          const n: [number, number] = [-u[1], u[0]];
          const o1 = g1.a[0] * n[0] + g1.a[1] * n[1], o2 = g2.a[0] * n[0] + g2.a[1] * n[1], om = (o1 + o2) / 2;
          const ts = [t(g1.a), t(g1.b), t(g2.a), t(g2.b)];
          const lo = Math.max(Math.min(ts[0], ts[1]), Math.min(ts[2], ts[3])), hi = Math.min(Math.max(ts[0], ts[1]), Math.max(ts[2], ts[3]));
          const [t0, t1] = hi > lo ? [lo, hi] : [Math.min(...ts), Math.max(...ts)];
          const at = (tt: number): [number, number] => [u[0] * tt + n[0] * om, u[1] * tt + n[1] * om];
          const A = pl.T(at(t0)), B = pl.T(at(t1));
          drawCenterline(items, A, B);
          out.push({ id: a.id, box: [Math.min(A[0], B[0]) - 1, Math.min(A[1], B[1]) - 1, Math.max(A[0], B[0]) + 1, Math.max(A[1], B[1]) + 1] });
        } else {
          const at = p ? [p.frame.x0, p.frame.y0 - 2] as [number, number] : [0, 0] as [number, number];
          out.push({ id: a.id, box: drawNote(items, 'CENTERLINE? (missing)', at, 2.5, undefined, DANGER) });
        }
        break;
      }
      case 'holeCallout': {
        const g = resolveRef(prims, { edge: a.ref.edge, at: 'edge' });
        const spec = info.holeOf?.(a.ref.edge) ?? null;
        const at = pl.T(a.at);
        if (g?.kind === 'circle') {
          const c = pl.T(g.c), r = g.r * pl.s;
          const text = spec ? holeCalloutText(spec, fmt) : `Ø${fmt.length(2 * g.r)}`;
          const dx = at[0] - c[0], dy = at[1] - c[1], l = Math.hypot(dx, dy) || 1;
          const tip: [number, number] = [c[0] + (dx / l) * r, c[1] + (dy / l) * r];
          out.push({ id: a.id, box: drawNote(items, text, at, DIM_TEXT_SIZE, tip) });
        } else out.push({ id: a.id, box: drawNote(items, 'HOLE? (missing)', at, DIM_TEXT_SIZE, undefined, DANGER) });
        break;
      }
      case 'balloon': {
        const g = resolveRef(prims, a.ref);
        const at = pl.T(a.at);
        const n = a.item ?? (p ? info.itemOf?.(p.r.source, a.ref.edge) : null) ?? null;
        const ok = !!g && n !== null;
        out.push({ id: a.id, box: drawBalloon(items, n === null ? '?' : String(n), at, g ? pl.T(balloonTip(g, a.at, a.t)) : null, ok ? undefined : DANGER) });
        break;
      }
      case 'bom':
      case 'cutList': {
        const t = info.table?.(a);
        if (t) {
          // Split into columns to stay on the sheet; one that still does not fit says so.
          const { w, h } = sheetDims(d);
          const drawn = drawTable(items, t, a.at, a.anchor, { top: MARGIN, bottom: h - MARGIN, left: MARGIN, right: w - MARGIN });
          if (!drawn.fits) {
            const what = a.type === 'bom' ? 'The bill of materials' : 'The cut list';
            warnings.push(`${what} does not fit on this sheet: use a larger sheet.`);
            const text = `${what.slice(4).toUpperCase()} DOES NOT FIT ON THIS SHEET: USE A LARGER SHEET`;
            const tw = textWidth(text, 2.5);
            drawNote(items, text, [Math.max(MARGIN + 1, Math.min(drawn.box[2] - tw, w - MARGIN - 1 - tw)), Math.max(MARGIN + 4, Math.min(drawn.box[1] - 1.5, h - MARGIN - 1))], 2.5, undefined, DANGER);
          }
          out.push({ id: a.id, box: drawn.box });
        } else {
          const text = a.type === 'bom' ? 'BILL OF MATERIALS? (no assembly)' : 'CUT LIST? (no structural members)';
          const at: [number, number] = a.anchor === 'bottomRight' ? [a.at[0] - textWidth(text, 2.5), a.at[1] - 1] : [a.at[0], a.at[1] + 3];
          out.push({ id: a.id, box: drawNote(items, text, at, 2.5, undefined, DANGER) });
        }
        break;
      }
    }
  }
  return out;
}

type Box = [x0: number, y0: number, x1: number, y1: number];

/** Hatch angles of an assembly section's components in turn (a part's cut is hatched at 45°). */
const HATCH_ANGLES = [45, 135, 60, 120, 30, 150];

/** A section's cut outlines by component, each with its hatch angle. */
function hatchGroups(pr: ProjectionResult): [number[][], number][] {
  const cut = pr.cut ?? [];
  const g = pr.cutGroups;
  if (!g || g.length !== cut.length) return [[cut, 45]];
  const order = [...new Set(g)];
  return order.map((k, i) => [cut.filter((_, j) => g[j] === k), HATCH_ANGLES[i % HATCH_ANGLES.length]]);
}

/**
 * Bend centre lines of a flat pattern view (view coordinates placed by tx, ty, s): dashed for
 * bends up, chain lines for bends down, each with its note ("UP 90° R 1") along its middle.
 */
function drawBendLines(items: Item[], bends: { a: [number, number]; b: [number, number]; up: boolean; angle: number; radius: number }[], tx: number, ty: number, s: number, fmt: (mm: number) => string) {
  for (const b of bends) {
    const A: [number, number] = [tx + b.a[0] * s, ty + b.a[1] * s], B: [number, number] = [tx + b.b[0] * s, ty + b.b[1] * s];
    items.push({ t: 'line', x1: A[0], y1: A[1], x2: B[0], y2: B[1], w: THIN, dash: b.up ? [4, 1.5] : [4, 1.2, 1, 1.2] });
    let ang = (Math.atan2(B[1] - A[1], B[0] - A[0]) * 180) / Math.PI;
    // Never upside down; along a vertical line it reads upward.
    if (ang >= 90 - 1e-9) ang -= 180;
    if (ang < -90 - 1e-9) ang += 180;
    const t = (ang * Math.PI) / 180;
    // Above the line as it reads.
    const m: [number, number] = [(A[0] + B[0]) / 2 + Math.sin(t) * 1.2, (A[1] + B[1]) / 2 - Math.cos(t) * 1.2];
    items.push({ t: 'text', s: bendNote({ up: b.up, angle: b.angle, radius: b.radius } as Parameters<typeof bendNote>[0], fmt), x: m[0], y: m[1], size: 2.5, anchor: 'middle', rotate: ang || undefined });
  }
}

/**
 * What a flat pattern leaves out, in red above its view (below it, past its dimensions, when
 * the view is at the top of the sheet), wrapped to the view's width (at least 90 mm) and kept
 * on the sheet, so the drawing does not pass for the whole part. Returns its box.
 */
function drawFlatNotes(items: Item[], notes: string[], f: ViewFrame, dims: boolean, label: Box, sheetW: number): Box {
  const size = 2;
  const room = Math.min(Math.max(f.x1 - f.x0, 90), sheetW - 2 * MARGIN);
  const lines: string[] = [];
  for (const n of notes) {
    let cur = '';
    for (const word of `NOTE: ${n}`.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && textWidth(next, size) > room) { lines.push(cur); cur = word; } else cur = next;
    }
    if (cur) lines.push(cur);
  }
  const width = Math.max(...lines.map((s) => textWidth(s, size)));
  const x = Math.max(MARGIN + 1, Math.min(f.x0, sheetW - MARGIN - 1 - width));
  const above = f.y0 - 2 - (lines.length - 1) * size * 1.4;
  // Above, clear of the label if it went there; else below the dimensions and the label.
  const top = label[3] <= f.y0 ? Math.min(above, label[1] - 1 - (lines.length - 1) * size * 1.4) : above;
  const y = top - size * 0.8 >= MARGIN + 1 ? top : Math.max(f.y1 + (dims ? DIM_BELOW : 0), label[1] >= f.y1 ? label[3] : -Infinity) + 1 + size;
  return drawNote(items, lines.join('\n'), [x, y], size, undefined, DANGER);
}

const LABEL_SIZE = 2.6;
/** How far a view's dimensions reach left of and below its outline. */
export const DIM_LEFT = 12;
export const DIM_BELOW = 10.5;

const hasDims = (v: DrawingView) => v.dims && v.kind !== 'isometric' && v.type !== 'detail';

/**
 * A view's label: centred below the view (past its width dimension) unless
 * something else is there, then above it, then to its right; below when
 * nothing is free, as before.
 */
function viewLabel(s: string, f: ViewFrame, dims: boolean, taken: Box[], w: number, h: number): { item: Item; box: Box } {
  const half = textWidth(s, LABEL_SIZE) / 2;
  const cx = (f.x0 + f.x1) / 2;
  // Each candidate's text box allows 1 mm of air around the capitals.
  const at = (x: number, y: number, anchor: 'start' | 'middle') => {
    const x0 = anchor === 'start' ? x : x - half;
    const box: Box = [x0 - 1, y - LABEL_SIZE * 0.75 - 1, x0 + 2 * half + 1, y + 1];
    return { item: { t: 'text', s, x, y, size: LABEL_SIZE, anchor } as Item, box };
  };
  const below = at(cx, f.y1 + (dims ? 16 : 7), 'middle');
  const candidates = [below, at(cx, f.y0 - 3, 'middle'), at(f.x1 + 4, (f.y0 + f.y1) / 2 + LABEL_SIZE * 0.375, 'start')];
  const free = (b: Box) =>
    b[0] >= MARGIN && b[1] >= MARGIN && b[2] <= w - MARGIN && b[3] <= h - MARGIN &&
    !taken.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  return candidates.find((c) => free(c.box)) ?? below;
}

const DIM_TEXT = 3;

/**
 * Overall dimension between two points (horizontal below, vertical left).
 * Where the extension lines are too close together, the arrows point in
 * from outside them and the value sits beyond the end of the dimension line
 * (right of a horizontal one, below a vertical one), instead of arrows and
 * text piling up on top of the lines. Returns the box the value takes.
 */
function dimension(
  items: Item[],
  a: [number, number],
  b: [number, number],
  side: 'below' | 'left',
  label: string,
): Box {
  const off = 8, ext = 2, arrow = 2.4, aw = 0.8, gap = 1.2;
  const len = side === 'below' ? b[0] - a[0] : b[1] - a[1];
  const tw = textWidth(label, DIM_TEXT);
  const arrowsOut = len < 2 * arrow + 1;
  const textOut = tw + 2 > len;
  // Arrowhead length along the line from a's tip (b's points the other way).
  const tip = arrowsOut ? -arrow : arrow;
  // How far the dimension line runs past each end: to the outside arrows, then along the value.
  const before = arrowsOut ? arrow + 1 : 0;
  const after = (arrowsOut ? arrow + 1 : 0) + (textOut ? tw + 1 : 0);
  const text = (x: number, y: number, anchor: 'start' | 'middle' | 'end', rotate?: number) =>
    items.push({ t: 'text', s: label, x, y, size: DIM_TEXT, anchor, rotate });
  if (side === 'below') {
    const y = a[1] + off;
    items.push({ t: 'line', x1: a[0], y1: a[1] + 1, x2: a[0], y2: y + ext, w: THIN });
    items.push({ t: 'line', x1: b[0], y1: b[1] + 1, x2: b[0], y2: y + ext, w: THIN });
    items.push({ t: 'line', x1: a[0] - before, y1: y, x2: b[0] + after, y2: y, w: THIN });
    items.push({ t: 'tri', a: [a[0], y], b: [a[0] + tip, y - aw], c: [a[0] + tip, y + aw] });
    items.push({ t: 'tri', a: [b[0], y], b: [b[0] - tip, y - aw], c: [b[0] - tip, y + aw] });
    const x0 = textOut ? b[0] + after - tw : (a[0] + b[0] - tw) / 2;
    if (textOut) text(x0, y - gap, 'start');
    else text(x0 + tw / 2, y - gap, 'middle');
    return [x0, y - gap - DIM_TEXT * 0.75, x0 + tw, y - gap];
  }
  const x = a[0] - off;
  items.push({ t: 'line', x1: a[0] - 1, y1: a[1], x2: x - ext, y2: a[1], w: THIN });
  items.push({ t: 'line', x1: b[0] - 1, y1: b[1], x2: x - ext, y2: b[1], w: THIN });
  // The value goes below the lower end, into the room kept for the width dimension and label.
  items.push({ t: 'line', x1: x, y1: a[1] - before, x2: x, y2: b[1] + after, w: THIN });
  items.push({ t: 'tri', a: [x, a[1]], b: [x - aw, a[1] + tip], c: [x + aw, a[1] + tip] });
  items.push({ t: 'tri', a: [x, b[1]], b: [x - aw, b[1] - tip], c: [x + aw, b[1] - tip] });
  // Turned a quarter to read upward: 'end' puts the top of the value at its point.
  const y0 = textOut ? b[1] + after - tw : (a[1] + b[1] - tw) / 2;
  if (textOut) text(x - gap, y0, 'end', -90);
  else text(x - gap, y0 + tw / 2, 'middle', -90);
  return [x - gap - DIM_TEXT * 0.75, y0, x - gap, y0 + tw];
}

function titleBlock(items: Item[], w: number, h: number, d: DrawingDoc, info: SheetInfo) {
  const x = w - MARGIN - TITLE_W, y = h - MARGIN - TITLE_H;
  const row = TITLE_H / 3;
  items.push({ t: 'rect', x, y, w: TITLE_W, h: TITLE_H, sw: 0.5 });
  items.push({ t: 'line', x1: x, y1: y + row, x2: x + TITLE_W, y2: y + row, w: 0.25 });
  items.push({ t: 'line', x1: x, y1: y + 2 * row, x2: x + TITLE_W, y2: y + 2 * row, w: 0.25 });
  const c1 = x + 110, c2 = x + 56;
  items.push({ t: 'line', x1: c1, y1: y, x2: c1, y2: y + TITLE_H, w: 0.25 });
  items.push({ t: 'line', x1: c2, y1: y + row, x2: c2, y2: y + TITLE_H, w: 0.25 });
  const label = (s: string, lx: number, ly: number) => items.push({ t: 'text', s, x: lx + 1.5, y: ly + 3, size: 1.8 });
  // Long values shrink to fit their cell, down to a legible minimum, then are cut short.
  const value = (s: string, lx: number, ly: number, cellW: number, size = 3.2, bold = false) => {
    const room = cellW - 3;
    let fitted = s;
    const w = textWidth(s, size, bold);
    if (w > room) {
      size = Math.max(MIN_TEXT, (size * room) / w);
      if (textWidth(s, size, bold) > room + 1e-9) {
        let n = s.length;
        while (n > 0 && textWidth(`${s.slice(0, n).trimEnd()}\u2026`, size, bold) > room) n--;
        fitted = `${s.slice(0, n).trimEnd()}\u2026`;
      }
    }
    items.push({ t: 'text', s: fitted, x: lx + 1.5, y: ly + row - 2, size, bold });
  };
  const right = x + TITLE_W;
  label('TITLE', x, y); value(d.title || info.partName, x, y, c1 - x, 4, true);
  label('SCALE', c1, y); value(scaleLabel(d.scale), c1, y, right - c1);
  label('MATERIAL', x, y + row); value(info.material, x, y + row, c2 - x, 2.8);
  label('UNITS', c2, y + row); value(info.units, c2, y + row, c1 - c2, 2.8);
  label('DATE', c1, y + row); value(info.date, c1, y + row, right - c1, 2.8);
  label('DRAWN BY', x, y + 2 * row); value(d.drawnBy || '', x, y + 2 * row, c2 - x, 2.8);
  label('SHEET', c2, y + 2 * row); value(`${d.sheet}${d.landscape ? '' : ' portrait'}`, c2, y + 2 * row, c1 - c2, 2.8);
  label('NOTES', c1, y + 2 * row); value(d.notes || '', c1, y + 2 * row, right - c1, 2.4);
}

/** The title block's size on the sheet (the full one is as large as the basic one). */
export function titleBlockSize(_d: DrawingDoc): { w: number; h: number } {
  return { w: TITLE_W, h: TITLE_H };
}

/** Fits a value into a cell: long values shrink, down to a legible minimum, then are cut short. */
function fitText(s: string, room: number, size: number, bold = false): { s: string; size: number } {
  let fitted = s;
  const w = textWidth(s, size, bold);
  if (w > room) {
    size = Math.max(MIN_TEXT, (size * room) / w);
    if (textWidth(s, size, bold) > room + 1e-9) {
      let n = s.length;
      while (n > 0 && textWidth(`${s.slice(0, n).trimEnd()}…`, size, bold) > room) n--;
      fitted = `${s.slice(0, n).trimEnd()}…`;
    }
  }
  return { s: fitted, size };
}

/**
 * The full title block: title, scale and sheet number; material, units, the projection
 * symbol, date and revision; drawn by, sheet size and notes.
 */
function titleBlockFull(items: Item[], w: number, h: number, d: DrawingDoc, info: SheetInfo) {
  const x = w - MARGIN - TITLE_W, y = h - MARGIN - TITLE_H;
  const row = TITLE_H / 3;
  const right = x + TITLE_W;
  items.push({ t: 'rect', x, y, w: TITLE_W, h: TITLE_H, sw: 0.5 });
  const hl = (yy: number) => items.push({ t: 'line', x1: x, y1: yy, x2: right, y2: yy, w: 0.25 });
  const vl = (xx: number, y0: number, y1: number) => items.push({ t: 'line', x1: xx, y1: y0, x2: xx, y2: y1, w: 0.25 });
  hl(y + row); hl(y + 2 * row);
  const c1 = x + 110, c2 = x + 56, c3 = x + 83, c4 = x + 140;
  vl(c1, y, y + TITLE_H);
  vl(c4, y, y + 2 * row);
  vl(c2, y + row, y + TITLE_H);
  vl(c3, y + row, y + 2 * row);
  const label = (s: string, lx: number, ly: number) => items.push({ t: 'text', s, x: lx + 1.5, y: ly + 3, size: 1.8 });
  const value = (s: string, lx: number, ly: number, cellW: number, size = 3.2, bold = false) => {
    const f = fitText(s, cellW - 3, size, bold);
    items.push({ t: 'text', s: f.s, x: lx + 1.5, y: ly + row - 2, size: f.size, bold });
  };
  label('TITLE', x, y); value(d.title || info.partName, x, y, c1 - x, 4, true);
  label('SCALE', c1, y); value(scaleLabel(d.scale), c1, y, c4 - c1);
  label('SHEET', c4, y); value('1 OF 1', c4, y, right - c4, 2.8);
  label('MATERIAL', x, y + row); value(info.material, x, y + row, c2 - x, 2.8);
  label('UNITS', c2, y + row); value(info.units, c2, y + row, c3 - c2, 2.8);
  label(d.projection === 'first' ? 'FIRST ANGLE' : 'THIRD ANGLE', c3, y + row);
  projectionSymbol(items, (c3 + c1) / 2, y + row + row * 0.62, d.projection === 'first');
  label('DATE', c1, y + row); value(info.date, c1, y + row, c4 - c1, 2.8);
  label('REV', c4, y + row); value(d.revision || '', c4, y + row, right - c4, 2.8);
  label('DRAWN BY', x, y + 2 * row); value(d.drawnBy || '', x, y + 2 * row, c2 - x, 2.8);
  label('SIZE', c2, y + 2 * row); value(`${d.sheet}${d.landscape ? '' : ' portrait'}`, c2, y + 2 * row, c1 - c2, 2.8);
  label('NOTES', c1, y + 2 * row); value(d.notes || '', c1, y + 2 * row, right - c1, 2.4);
}

/**
 * The projection symbol, centred at (cx, cy): a truncated cone seen from the side and from
 * its small end. Third angle: the side view left, its small end toward the end view on the
 * right; first angle: the end view left, the side view right with its large end toward it.
 */
export function projectionSymbol(items: Item[], cx: number, cy: number, first: boolean) {
  const D = 5, dd = 2.6, L = 5, gap = 3;
  const total = L + gap + D;
  const left = cx - total / 2;
  const [tx, ex] = first ? [left + D + gap, left + D / 2] : [left, left + L + gap + D / 2];
  const w = 0.25;
  // Side view: large end on the left, small end on the right.
  const pts: [number, number][] = [[tx, cy - D / 2], [tx + L, cy - dd / 2], [tx + L, cy + dd / 2], [tx, cy + D / 2]];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    items.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w });
  }
  items.push({ t: 'circle', cx: ex, cy, r: D / 2, w });
  items.push({ t: 'circle', cx: ex, cy, r: dd / 2, w });
  // Centrelines.
  items.push({ t: 'line', x1: tx - 1, y1: cy, x2: tx + L + 1, y2: cy, w: 0.13, dash: [2, 0.5, 0.5, 0.5] });
  items.push({ t: 'line', x1: ex - D / 2 - 1, y1: cy, x2: ex + D / 2 + 1, y2: cy, w: 0.13, dash: [2, 0.5, 0.5, 0.5] });
  items.push({ t: 'line', x1: ex, y1: cy - D / 2 - 1, x2: ex, y2: cy + D / 2 + 1, w: 0.13, dash: [2, 0.5, 0.5, 0.5] });
}

// ---------- renderers ----------

/**
 * Text for XML: markup characters escaped, and characters XML 1.0 forbids
 * (control characters, lone surrogates, U+FFFE/U+FFFF) dropped, since one of
 * them in a title or note makes the whole SVG fail to open.
 */
const esc = (s: string) =>
  s
    .replace(/[\ud800-\udbff][\udc00-\udfff]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\ud800-\udfff]/g, (c) => (c.length === 2 ? c : ''))
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** SVG document (millimetre units). */
export function toSvg(items: Item[], w: number, h: number, opts: { background?: string; ink?: string; title?: string } = {}): string {
  const ink = opts.ink ?? '#000';
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">`);
  if (opts.title) parts.push(`<title>${esc(opts.title)}</title>`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${opts.background ?? '#fff'}"/>`);
  let view: string | undefined;
  for (const it of items) {
    const v = it.t === 'path' ? it.view : undefined;
    if (v !== view) {
      if (view) parts.push('</g>');
      if (v) parts.push(`<g data-view="${esc(v)}">`);
      view = v;
    }
    const col = (it as { color?: string }).color ?? ink;
    switch (it.t) {
      case 'path':
        parts.push(`<path d="${it.d}" transform="translate(${it.tx.toFixed(4)} ${it.ty.toFixed(4)}) scale(${it.s})" fill="none" stroke="${col}" stroke-width="${(it.w / it.s).toFixed(5)}" stroke-linecap="round" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${it.dash.map((x) => (x / it.s).toFixed(4)).join(' ')}"` : ''}/>`);
        break;
      case 'line':
        parts.push(`<line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${col}" stroke-width="${it.w}"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''}/>`);
        break;
      case 'rect':
        parts.push(`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="none" stroke="${ink}" stroke-width="${it.sw}"/>`);
        break;
      case 'circle':
        parts.push(`<circle cx="${it.cx}" cy="${it.cy}" r="${it.r}" fill="none" stroke="${col}" stroke-width="${it.w}"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''}/>`);
        break;
      case 'tri':
        parts.push(`<path d="M${it.a[0]} ${it.a[1]}L${it.b[0]} ${it.b[1]}L${it.c[0]} ${it.c[1]}Z" fill="${col}"/>`);
        break;
      case 'text': {
        const anchor = it.anchor === 'middle' ? 'middle' : it.anchor === 'end' ? 'end' : 'start';
        const rot = it.rotate ? ` transform="rotate(${it.rotate} ${it.x} ${it.y})"` : '';
        parts.push(`<text x="${it.x}" y="${it.y}" font-size="${it.size}" text-anchor="${anchor}"${it.bold ? ' font-weight="bold"' : ''} fill="${col}"${rot}>${esc(it.s)}</text>`);
        break;
      }
    }
  }
  if (view) parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

export function toPdf(items: Item[], w: number, h: number, title: string): Uint8Array {
  const pdf = new PdfPage(w, h);
  for (const it of items) {
    const rgb = rgbOf((it as { color?: string }).color);
    switch (it.t) {
      case 'path': pdf.path(it.d, it.tx, it.ty, it.s, { width: it.w, dash: it.dash, rgb }); break;
      case 'line': pdf.line(it.x1, it.y1, it.x2, it.y2, { width: it.w, dash: it.dash, rgb }); break;
      case 'rect': pdf.rect(it.x, it.y, it.w, it.h, { width: it.sw }); break;
      case 'circle': pdf.path(circlePath(it.cx, it.cy, it.r), 0, 0, 1, { width: it.w, dash: it.dash, rgb }); break;
      case 'tri': pdf.triangle(it.a, it.b, it.c, rgb); break;
      case 'text': pdf.text(it.s, it.x, it.y, it.size, { bold: it.bold, anchor: it.anchor, rotate: it.rotate ? -it.rotate : undefined, rgb }); break;
    }
  }
  return pdf.build(title);
}

/** SVG path data of a whole circle (two half arcs). */
export const circlePath = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}`;

/** A #rrggbb colour as PDF components. */
function rgbOf(c: string | undefined): [number, number, number] | undefined {
  const m = c ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c) : null;
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : undefined;
}
