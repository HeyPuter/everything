// Drawing sheets: sizes, scales, standard view directions, automatic layout
// and a display list (lines, paths, text) that renders identically to SVG
// (on screen and export) and PDF.

import type { ProjectionResult } from '../kernel/protocol';
import { type Vec3, cross, normalize } from '../math/vec';
import type { DrawingDoc, DrawingView, DrawingViewKind, SheetSize } from '../model/types';
import { PdfPage, textWidth } from './pdf';

/** Portrait sizes in millimetres. */
export const SHEETS: Record<SheetSize, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  Letter: [215.9, 279.4],
  Tabloid: [279.4, 431.8],
};

export const SHEET_LABELS: Record<SheetSize, string> = {
  A4: 'A4 (297 x 210 mm)', A3: 'A3 (420 x 297 mm)', A2: 'A2 (594 x 420 mm)', A1: 'A1 (841 x 594 mm)',
  Letter: 'Letter (11 x 8.5 in)', Tabloid: 'Tabloid (17 x 11 in)',
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
export function standardLayout(sheet: { w: number; h: number }, min: Vec3, max: Vec3): { scale: number; views: Omit<DrawingView, 'id'>[] } {
  const f = projectedSize('front', min, max), t = projectedSize('top', min, max), r = projectedSize('right', min, max), i = projectedSize('isometric', min, max);
  const c1 = Math.max(f[0], t[0]), c2 = Math.max(r[0], i[0]);
  const r1 = Math.max(t[1], i[1]), r2 = Math.max(f[1], r[1]);
  // Room around each view for its dimensions and label: left of a view for
  // its height dimension, below it for its width dimension and label (the
  // top row needs that room as much as the bottom one).
  const gap = 15;
  const top = 5, below = (3 * gap - top) / 2;
  const availW = sheet.w - 2 * MARGIN - 3 * gap;
  const availH = sheet.h - 2 * MARGIN - TITLE_H - 3 * gap;
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

// ---------- display list ----------

export type Item =
  | { t: 'path'; d: string; tx: number; ty: number; s: number; w: number; dash?: number[]; view?: string }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; dash?: number[] }
  | { t: 'rect'; x: number; y: number; w: number; h: number; sw: number }
  | { t: 'tri'; a: [number, number]; b: [number, number]; c: [number, number] }
  | { t: 'text'; s: string; x: number; y: number; size: number; bold?: boolean; anchor?: 'start' | 'middle' | 'end'; rotate?: number };

export interface SheetInfo {
  partName: string;
  material: string;
  units: string;
  date: string;
  formatLength: (mm: number) => string;
}

export interface ViewFrame {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MIN_TEXT = 1.8;
const VISIBLE_W = 0.35;
const HIDDEN_W = 0.18;
const THIN = 0.18;

/** Builds the sheet's display list. Also returns each view's frame on the sheet. */
export function buildSheet(d: DrawingDoc, projections: Map<string, ProjectionResult>, info: SheetInfo): { items: Item[]; frames: ViewFrame[]; w: number; h: number } {
  const { w, h } = sheetDims(d);
  const items: Item[] = [];
  const frames: ViewFrame[] = [];
  items.push({ t: 'rect', x: MARGIN, y: MARGIN, w: w - 2 * MARGIN, h: h - 2 * MARGIN, sw: 0.5 });
  const s = d.scale;
  const placed: { v: DrawingView; pr: ProjectionResult; tx: number; ty: number; f: ViewFrame }[] = [];
  for (const v of d.views) {
    const pr = projections.get(v.id);
    if (!pr || !pr.bounds) continue;
    const [bx0, by0, bx1, by1] = pr.bounds;
    const tx = v.x - (s * (bx0 + bx1)) / 2;
    const ty = v.y - (s * (by0 + by1)) / 2;
    const f = { id: v.id, x0: tx + bx0 * s, y0: ty + by0 * s, x1: tx + bx1 * s, y1: ty + by1 * s };
    frames.push(f);
    placed.push({ v, pr, tx, ty, f });
  }
  // What a view label must stay clear of: every view with its dimensions,
  // the labels already placed and the title block.
  const taken: Box[] = placed.map(({ v, f }) => (hasDims(v) ? [f.x0 - DIM_LEFT, f.y0, f.x1, f.y1 + DIM_BELOW] : [f.x0, f.y0, f.x1, f.y1]));
  taken.push([w - MARGIN - TITLE_W, h - MARGIN - TITLE_H, w - MARGIN, h - MARGIN]);
  for (const [i, { v, pr, tx, ty, f }] of placed.entries()) {
    const [bx0, by0, bx1, by1] = pr.bounds!;
    if (v.hidden) for (const p of pr.hidden) items.push({ t: 'path', d: p, tx, ty, s, w: HIDDEN_W, dash: [1.6, 0.8], view: v.id });
    for (const p of pr.visible) items.push({ t: 'path', d: p, tx, ty, s, w: VISIBLE_W, view: v.id });
    const { x0: fx0, x1: fx1, y0: fy0, y1: fy1 } = f;
    const label = viewLabel(VIEW_LABELS[v.kind].toUpperCase(), f, hasDims(v), taken.filter((_, j) => j !== i), w, h);
    items.push(label.item);
    taken.push(label.box);
    if (hasDims(v)) {
      dimension(items, [fx0, fy1], [fx1, fy1], 'below', info.formatLength(bx1 - bx0));
      dimension(items, [fx0, fy0], [fx0, fy1], 'left', info.formatLength(by1 - by0));
    }
  }
  titleBlock(items, w, h, d, info);
  return { items, frames, w, h };
}

type Box = [x0: number, y0: number, x1: number, y1: number];

const LABEL_SIZE = 2.6;
/** How far a view's dimensions reach left of and below its outline. */
const DIM_LEFT = 12;
const DIM_BELOW = 10.5;

const hasDims = (v: DrawingView) => v.dims && v.kind !== 'isometric';

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

/** Overall dimension between two points (horizontal below, vertical left). */
function dimension(items: Item[], a: [number, number], b: [number, number], side: 'below' | 'left', label: string) {
  const off = 8, ext = 2, arrow = 2.4, aw = 0.8;
  if (side === 'below') {
    const y = a[1] + off;
    items.push({ t: 'line', x1: a[0], y1: a[1] + 1, x2: a[0], y2: y + ext, w: THIN });
    items.push({ t: 'line', x1: b[0], y1: b[1] + 1, x2: b[0], y2: y + ext, w: THIN });
    items.push({ t: 'line', x1: a[0], y1: y, x2: b[0], y2: y, w: THIN });
    items.push({ t: 'tri', a: [a[0], y], b: [a[0] + arrow, y - aw], c: [a[0] + arrow, y + aw] });
    items.push({ t: 'tri', a: [b[0], y], b: [b[0] - arrow, y - aw], c: [b[0] - arrow, y + aw] });
    items.push({ t: 'text', s: label, x: (a[0] + b[0]) / 2, y: y - 1.2, size: 3, anchor: 'middle' });
  } else {
    const x = a[0] - off;
    items.push({ t: 'line', x1: a[0] - 1, y1: a[1], x2: x - ext, y2: a[1], w: THIN });
    items.push({ t: 'line', x1: b[0] - 1, y1: b[1], x2: x - ext, y2: b[1], w: THIN });
    items.push({ t: 'line', x1: x, y1: a[1], x2: x, y2: b[1], w: THIN });
    items.push({ t: 'tri', a: [x, a[1]], b: [x - aw, a[1] + arrow], c: [x + aw, a[1] + arrow] });
    items.push({ t: 'tri', a: [x, b[1]], b: [x - aw, b[1] - arrow], c: [x + aw, b[1] - arrow] });
    items.push({ t: 'text', s: label, x: x - 1.2, y: (a[1] + b[1]) / 2, size: 3, anchor: 'middle', rotate: -90 });
  }
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
export function toSvg(items: Item[], w: number, h: number, opts: { background?: string; ink?: string } = {}): string {
  const ink = opts.ink ?? '#000';
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${opts.background ?? '#fff'}"/>`);
  let view: string | undefined;
  for (const it of items) {
    const v = it.t === 'path' ? it.view : undefined;
    if (v !== view) {
      if (view) parts.push('</g>');
      if (v) parts.push(`<g data-view="${esc(v)}">`);
      view = v;
    }
    switch (it.t) {
      case 'path':
        parts.push(`<path d="${it.d}" transform="translate(${it.tx.toFixed(4)} ${it.ty.toFixed(4)}) scale(${it.s})" fill="none" stroke="${ink}" stroke-width="${(it.w / it.s).toFixed(5)}" stroke-linecap="round" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${it.dash.map((x) => (x / it.s).toFixed(4)).join(' ')}"` : ''}/>`);
        break;
      case 'line':
        parts.push(`<line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${ink}" stroke-width="${it.w}"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''}/>`);
        break;
      case 'rect':
        parts.push(`<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="none" stroke="${ink}" stroke-width="${it.sw}"/>`);
        break;
      case 'tri':
        parts.push(`<path d="M${it.a[0]} ${it.a[1]}L${it.b[0]} ${it.b[1]}L${it.c[0]} ${it.c[1]}Z" fill="${ink}"/>`);
        break;
      case 'text': {
        const anchor = it.anchor === 'middle' ? 'middle' : it.anchor === 'end' ? 'end' : 'start';
        const rot = it.rotate ? ` transform="rotate(${it.rotate} ${it.x} ${it.y})"` : '';
        parts.push(`<text x="${it.x}" y="${it.y}" font-size="${it.size}" text-anchor="${anchor}"${it.bold ? ' font-weight="bold"' : ''} fill="${ink}"${rot}>${esc(it.s)}</text>`);
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
    switch (it.t) {
      case 'path': pdf.path(it.d, it.tx, it.ty, it.s, { width: it.w, dash: it.dash }); break;
      case 'line': pdf.line(it.x1, it.y1, it.x2, it.y2, { width: it.w, dash: it.dash }); break;
      case 'rect': pdf.rect(it.x, it.y, it.w, it.h, { width: it.sw }); break;
      case 'tri': pdf.triangle(it.a, it.b, it.c); break;
      case 'text': pdf.text(it.s, it.x, it.y, it.size, { bold: it.bold, anchor: it.anchor, rotate: it.rotate ? -it.rotate : undefined }); break;
    }
  }
  return pdf.build(title);
}
