import type { Editor } from '../editor';
import { registerTool, registerCommand, registerOverlay, type Tool } from '../app/registry';
import type { CanvasPointer } from '../app/pointer';
import {
  applySelection,
  canvasRect,
  combineSelection,
  invertSelection,
  maskGrid,
  selectAllGrid,
  selectionGrid,
  selectionOutline,
  type SelectionOp,
} from '../model/selection';
import { readMask, type TileGrid } from '../model/tiles';
import type { Mask8 } from '../imaging/types';
import { compositeRGBA, layerRGBA } from './pixels';
import { formDialog } from '../ui/dialog';
import { border, contract, expand, feather, grow, similar, smooth } from '../imaging/segment/mask-ops';
import { svg } from '../app/icons';

// ----- Rasterizing selection shapes -----
/** Anti-aliased polygon coverage via 4x vertical supersampling of scanlines. */
export function rasterizePolygon(points: [number, number][], width: number, height: number, antiAlias = true): Mask8 {
  const data = new Uint8Array(width * height);
  if (points.length < 3) return { width, height, data };
  const samples = antiAlias ? 4 : 1;
  const acc = new Float32Array(width);
  let minY = Infinity,
    maxY = -Infinity;
  for (const [, y] of points) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y0 = Math.max(0, Math.floor(minY)),
    y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    acc.fill(0);
    for (let s = 0; s < samples; s++) {
      const sy = y + (s + 0.5) / samples;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i],
          [bx, by] = points[(i + 1) % points.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k]),
          b = Math.min(width, xs[k + 1]);
        if (b <= a) continue;
        const ia = Math.floor(a),
          ib = Math.floor(b);
        if (ia === ib) {
          if (ia < width) acc[ia] += (b - a) / samples;
          continue;
        }
        acc[ia] += (ia + 1 - a) / samples;
        for (let x = ia + 1; x < ib; x++) acc[x] += 1 / samples;
        if (ib < width) acc[ib] += (b - ib) / samples;
      }
    }
    for (let x = 0; x < width; x++) {
      const v = antiAlias ? acc[x] : acc[x] >= 0.5 ? 1 : 0;
      data[y * width + x] = Math.round(Math.min(1, v) * 255);
    }
  }
  return { width, height, data };
}
export function ellipsePoints(x: number, y: number, w: number, h: number): [number, number][] {
  const n = Math.max(32, Math.min(720, Math.round((w + h) / 2)));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2]);
  }
  return pts;
}
/** Gaussian-like feather of a canvas mask: three box blurs (Wells 1986). */
export function featherMask(m: Mask8, radius: number): Mask8 {
  if (radius <= 0) return m;
  const { width: w, height: h } = m;
  let a = Float32Array.from(m.data);
  let b = new Float32Array(a.length);
  const r = Math.max(1, Math.round(radius / Math.sqrt(3)));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = sum / (2 * r + 1);
        sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1);
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
    [a, b] = [a, b];
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i]);
  return { width: w, height: h, data: out };
}

// ----- Selection state helpers -----
export function selectionOp(e: Editor, p: Pick<CanvasPointer, 'shift' | 'alt'>): SelectionOp {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return (e.settings.selectionOp as SelectionOp) ?? 'replace';
}
/** Commit a new selection shape (canvas-sized mask) combined with the current one. */
/** Combine a mask with the selection as one undo step, in the active document
 * or in `session` (a selection computed while the user switched documents). */
export function commitSelectionMask(e: Editor, mask: Mask8 | TileGrid | null, op: SelectionOp, label: string, session = e.session) {
  const store = session.assets.tiles;
  const doc = session.doc;
  const shape = mask && 'data' in mask ? maskGrid(store, mask) : mask;
  const current = selectionGrid(doc, store);
  const next = shape ? combineSelection(store, doc, current, shape, op) : op === 'replace' ? null : current;
  session.lastSelection = current;
  e.command(label, (d) => applySelection(d, next), { session });
}
export function optionsFor(e: Editor, extra = '') {
  const op = (e.settings.selectionOp as SelectionOp) ?? 'replace';
  const ops: [SelectionOp, string, string][] = [
    ['replace', 'New selection', 'square'],
    ['add', 'Add to selection (Shift)', 'plus'],
    ['subtract', 'Subtract from selection (Alt)', 'minus'],
    ['intersect', 'Intersect with selection (Shift+Alt)', 'x'],
  ];
  return `<div class="segmented" role="group" aria-label="Selection mode">${ops.map(([id, label, icon]) => `<button data-selection-op="${id}" aria-pressed="${op === id}" title="${label}" aria-label="${label}">${svg(icon, 14)}</button>`).join('')}</div><label>Feather <input id="sel-feather" type="number" min="0" max="1000" value="${Number(e.settings.selectionFeather ?? 0)}"> px</label><label class="transform-setting"><input id="sel-aa" type="checkbox" ${e.settings.antiAlias !== false ? 'checked' : ''}>Anti-alias</label>${extra}<button data-command="select.mask-refine" ${e.doc.selection ? '' : 'disabled'}>Select and Mask…</button>`;
}
export function bindSelectionOptions(e: Editor, el: HTMLElement) {
  el.querySelectorAll<HTMLButtonElement>('[data-selection-op]').forEach((b) =>
    b.addEventListener('click', () => {
      e.settings.selectionOp = b.dataset.selectionOp;
      e.options();
    }),
  );
  el.querySelector<HTMLInputElement>('#sel-feather')?.addEventListener('change', (ev) => (e.settings.selectionFeather = Math.max(0, Number((ev.target as HTMLInputElement).value) || 0)));
  el.querySelector<HTMLInputElement>('#sel-aa')?.addEventListener('change', (ev) => (e.settings.antiAlias = (ev.target as HTMLInputElement).checked));
}

// ----- Marquee and lasso tools -----
type Drag = { start: [number, number]; current: [number, number]; op: SelectionOp; points: [number, number][]; moving?: boolean; startPointer?: CanvasPointer };
let drag: Drag | undefined;
let polygon: { points: [number, number][]; op: SelectionOp } | undefined;
let hoverPoint: [number, number] | undefined;

export type MarqueeStyle = { style?: unknown; width?: unknown; height?: unknown };
/** The rectangle a marquee drag from `start` to the pointer selects; the
 * preview and the committed selection both use it. Fixed Ratio keeps the
 * corner at `start` and grows with the longer side of the drag; Fixed Size
 * places the rectangle at the pointer. */
export function marqueeRect(start: [number, number], p: Pick<CanvasPointer, 'x' | 'y' | 'shift' | 'alt'>, op: SelectionOp, fixed: MarqueeStyle = {}) {
  const fw = Math.max(1, Number(fixed.width) || 1),
    fh = Math.max(1, Number(fixed.height) || 1);
  // Alt draws from the center (it means subtract when the drag started with it).
  const center = p.alt && op !== 'subtract';
  if (fixed.style === 'size') return center ? { x: p.x - fw / 2, y: p.y - fh / 2, width: fw, height: fh } : { x: p.x, y: p.y, width: fw, height: fh };
  let [x0, y0] = start;
  let w = p.x - x0,
    h = p.y - y0;
  if (fixed.style === 'ratio') {
    const s = Math.max(Math.abs(w) / fw, Math.abs(h) / fh);
    w = Math.sign(w || 1) * s * fw;
    h = Math.sign(h || 1) * s * fh;
  } else if (p.shift && op !== 'add') {
    // Shift after starting constrains to a square/circle.
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  if (center) {
    x0 -= w;
    y0 -= h;
    w *= 2;
    h *= 2;
  }
  return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), width: Math.abs(w), height: Math.abs(h) };
}
/** The whole pixels a rectangular marquee selects: each edge snaps to the
 * nearest pixel boundary, as the preview shows it. */
export function marqueePixels(r: { x: number; y: number; width: number; height: number }) {
  const x = Math.round(r.x),
    y = Math.round(r.y);
  return { x, y, width: Math.round(r.x + r.width) - x, height: Math.round(r.y + r.height) - y };
}
const marqueeStyle = (e: Editor): MarqueeStyle => ({ style: e.settings.marqueeStyle, width: e.settings.marqueeW, height: e.settings.marqueeH });
export function finishShape(e: Editor, op: SelectionOp, mask: Mask8 | null, label: string) {
  const feather = Number(e.settings.selectionFeather ?? 0);
  commitSelectionMask(e, mask && feather ? featherMask(mask, feather) : mask, op, label);
}
function marqueeTool(id: string, label: string, icon: string, shape: 'rect' | 'ellipse' | 'row' | 'column', key?: string): Tool {
  return {
    id,
    label,
    key,
    icon,
    group: 'marquee',
    cursor: () => 'crosshair',
    options: (e) => optionsFor(e, shape === 'rect' || shape === 'ellipse' ? `<label>Style <select id="marquee-style"><option value="normal">Normal</option><option value="ratio" ${e.settings.marqueeStyle === 'ratio' ? 'selected' : ''}>Fixed Ratio</option><option value="size" ${e.settings.marqueeStyle === 'size' ? 'selected' : ''}>Fixed Size</option></select></label><label>W <input id="marquee-w" type="number" min="1" value="${Number(e.settings.marqueeW ?? 1)}"></label><label>H <input id="marquee-h" type="number" min="1" value="${Number(e.settings.marqueeH ?? 1)}"></label>` : ''),
    bindOptions: ({ e, el }) => {
      bindSelectionOptions(e, el);
      el.querySelector<HTMLSelectElement>('#marquee-style')?.addEventListener('change', (ev) => (e.settings.marqueeStyle = (ev.target as HTMLSelectElement).value));
      el.querySelector<HTMLInputElement>('#marquee-w')?.addEventListener('change', (ev) => (e.settings.marqueeW = Number((ev.target as HTMLInputElement).value) || 1));
      el.querySelector<HTMLInputElement>('#marquee-h')?.addEventListener('change', (ev) => (e.settings.marqueeH = Number((ev.target as HTMLInputElement).value) || 1));
    },
    pointerDown: (e, p) => {
      const op = selectionOp(e, p);
      if (shape === 'row' || shape === 'column') {
        const r = shape === 'row' ? { x: 0, y: Math.floor(p.y), width: e.doc.width, height: 1 } : { x: Math.floor(p.x), y: 0, width: 1, height: e.doc.height };
        finishShape(e, op, rectMask(e, r), shape === 'row' ? 'Single Row Marquee' : 'Single Column Marquee');
        return;
      }
      drag = { start: [p.x, p.y], current: [p.x, p.y], op, points: [], startPointer: p };
    },
    pointerMove: (e, p) => {
      if (!drag) return;
      drag.current = [p.x, p.y];
      e.overlay();
      (drag as Drag & { last?: CanvasPointer }).last = p;
    },
    pointerUp: (e, p) => {
      const d = drag;
      drag = undefined;
      if (!d) return;
      // A click places a fixed-size rectangle; otherwise it deselects.
      const r = marqueeRect(d.start, p, d.op, marqueeStyle(e));
      if (r.width < 1 && r.height < 1) {
        // A click without dragging deselects (except when adding).
        if (d.op === 'replace') commitSelectionMask(e, null, 'replace', 'Deselect');
        e.overlay();
        return;
      }
      const W = e.doc.width,
        H = e.doc.height;
      const aa = e.settings.antiAlias !== false;
      const mask = shape === 'ellipse' ? rasterizePolygon(ellipsePoints(r.x, r.y, r.width, r.height), W, H, aa) : rectMask(e, marqueePixels(r));
      finishShape(e, d.op, mask, shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    overlay: (e) => {
      if (!drag) return '';
      const last = (drag as Drag & { last?: CanvasPointer }).last;
      const r = marqueeRect(drag.start, last ?? { x: drag.start[0], y: drag.start[1], shift: false, alt: false }, drag.op, marqueeStyle(e));
      const z = e.zoom;
      const shapeSvg = shape === 'ellipse' ? `<ellipse cx="${r.x + r.width / 2}" cy="${r.y + r.height / 2}" rx="${r.width / 2}" ry="${r.height / 2}"` : `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"`;
      return `<g class="marching" stroke-width="${1 / z}">${shapeSvg} class="ants-white"/>${shapeSvg} class="ants-black" stroke-dasharray="${4 / z} ${4 / z}"/></g>`;
    },
  };
}
function rectMask(e: Editor, r: { x: number; y: number; width: number; height: number }): Mask8 {
  const W = e.doc.width,
    H = e.doc.height;
  const data = new Uint8Array(W * H);
  const x0 = Math.max(0, r.x),
    y0 = Math.max(0, r.y),
    x1 = Math.min(W, r.x + r.width),
    y1 = Math.min(H, r.y + r.height);
  for (let y = y0; y < y1; y++) data.fill(255, y * W + x0, y * W + x1);
  return { width: W, height: H, data };
}
const lassoTool: Tool = {
  id: 'lasso',
  label: 'Lasso Tool',
  key: 'L',
  icon: 'lasso',
  group: 'lasso',
  cursor: () => 'crosshair',
  options: (e) => optionsFor(e),
  bindOptions: ({ e, el }) => bindSelectionOptions(e, el),
  pointerDown: (e, p) => {
    drag = { start: [p.x, p.y], current: [p.x, p.y], op: selectionOp(e, p), points: [[p.x, p.y]] };
  },
  pointerMove: (e, p) => {
    if (!drag) return;
    for (const q of p.coalesced ?? [p]) drag.points.push([q.x, q.y]);
    e.overlay();
  },
  pointerUp: (e) => {
    const d = drag;
    drag = undefined;
    if (!d || d.points.length < 3) {
      if (d?.op === 'replace') commitSelectionMask(e, null, 'replace', 'Deselect');
      return;
    }
    finishShape(e, d.op, rasterizePolygon(d.points, e.doc.width, e.doc.height, e.settings.antiAlias !== false), 'Lasso');
  },
  overlay: (e) => {
    if (!drag) return '';
    const z = e.zoom;
    const d = drag.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
    return `<g class="marching" stroke-width="${1 / z}" fill="none"><path d="${d}" class="ants-white"/><path d="${d}" class="ants-black" stroke-dasharray="${4 / z} ${4 / z}"/></g>`;
  },
};
const polygonTool: Tool = {
  id: 'polygonal-lasso',
  label: 'Polygonal Lasso Tool',
  key: 'L',
  icon: 'lasso-polygon',
  group: 'lasso',
  cursor: () => 'crosshair',
  options: (e) => optionsFor(e),
  bindOptions: ({ e, el }) => bindSelectionOptions(e, el),
  deactivate: () => {
    polygon = undefined;
  },
  pointerDown: (e, p) => {
    if (!polygon) {
      polygon = { points: [[p.x, p.y]], op: selectionOp(e, p) };
      return;
    }
    const [fx, fy] = polygon.points[0];
    // Clicking the starting point closes the shape.
    if (polygon.points.length > 2 && Math.hypot(p.x - fx, p.y - fy) * e.zoom < 8) {
      closePolygon(e);
      return;
    }
    let q: [number, number] = [p.x, p.y];
    if (p.shift) q = snap45(polygon.points.at(-1)!, q);
    polygon.points.push(q);
    e.overlay();
  },
  hover: (e, p) => {
    if (!polygon) return;
    hoverPoint = p.shift ? snap45(polygon.points.at(-1)!, [p.x, p.y]) : [p.x, p.y];
    e.overlay();
  },
  doubleClick: (e) => closePolygon(e),
  keyDown: (e, ev) => {
    if (!polygon) return false;
    if (ev.key === 'Enter') closePolygon(e);
    else if (ev.key === 'Escape') {
      polygon = undefined;
      e.overlay();
    } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      polygon.points.pop();
      if (!polygon.points.length) polygon = undefined;
      e.overlay();
    } else return false;
    return true;
  },
  overlay: (e) => {
    if (!polygon) return '';
    const z = e.zoom;
    const pts = [...polygon.points, ...(hoverPoint ? [hoverPoint] : [])];
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('');
    return `<g class="marching" stroke-width="${1 / z}" fill="none"><path d="${d}" class="ants-white"/><path d="${d}" class="ants-black" stroke-dasharray="${4 / z} ${4 / z}"/><circle cx="${polygon.points[0][0]}" cy="${polygon.points[0][1]}" r="${4 / z}" class="ants-white"/></g>`;
  },
};
function snap45(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(angle) * len, a[1] + Math.sin(angle) * len];
}
function closePolygon(e: Editor) {
  const poly = polygon;
  polygon = undefined;
  hoverPoint = undefined;
  if (!poly || poly.points.length < 3) {
    e.overlay();
    return;
  }
  finishShape(e, poly.op, rasterizePolygon(poly.points, e.doc.width, e.doc.height, e.settings.antiAlias !== false), 'Polygonal Lasso');
}
const wandTool: Tool = {
  id: 'magic-wand',
  label: 'Magic Wand Tool',
  key: 'W',
  icon: 'wand-sparkles',
  group: 'select',
  cursor: () => 'crosshair',
  options: (e) =>
    optionsFor(e, `<label>Tolerance <input id="tolerance" type="number" value="${e.tolerance}" min="0" max="255"></label><label class="transform-setting"><input id="wand-contiguous" type="checkbox" ${e.settings.contiguous !== false ? 'checked' : ''}>Contiguous</label><label class="transform-setting"><input id="wand-all" type="checkbox" ${e.settings.sampleAllLayers ? 'checked' : ''}>Sample All Layers</label>`),
  bindOptions: ({ e, el }) => {
    bindSelectionOptions(e, el);
    el.querySelector<HTMLInputElement>('#tolerance')?.addEventListener('change', (ev) => (e.tolerance = Math.max(0, Math.min(255, Number((ev.target as HTMLInputElement).value) || 0))));
    el.querySelector<HTMLInputElement>('#wand-contiguous')?.addEventListener('change', (ev) => (e.settings.contiguous = (ev.target as HTMLInputElement).checked));
    el.querySelector<HTMLInputElement>('#wand-all')?.addEventListener('change', (ev) => (e.settings.sampleAllLayers = (ev.target as HTMLInputElement).checked));
  },
  pointerDown: async (e, p) => {
    const x = Math.floor(p.x),
      y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;
    const op = selectionOp(e, p);
    e.message('Selecting similar pixels…');
    const mask = await wandMask(e, x, y);
    finishShape(e, op, mask, 'Magic Wand');
    e.message('Ready');
  },
};
/** The image the Magic Wand family samples: the current layer or all layers. */
async function wandRGBA(e: Editor) {
  const l = e.layer;
  return e.settings.sampleAllLayers || !l ? compositeRGBA(e) : layerRGBA(e, l);
}
// High-depth documents compare their native (possibly HDR) samples, so values
// that clip to the same display color stay distinguishable.
async function wandImage(e: Editor): Promise<{ width: number; height: number; data: ArrayLike<number>; unit: number }> {
  const l = e.layer;
  const doc = e.doc;
  if ((doc.bitsPerChannel ?? 8) > 8 && !(l?.kind === 'pixel' && !e.settings.sampleAllLayers)) {
    const raw = e.settings.sampleAllLayers || !l ? await e.renderer.documentPixels(doc, e.assets) : await e.renderer.layerPixels(l, doc, e.assets);
    if (raw instanceof Float32Array) return { width: doc.width, height: doc.height, data: raw, unit: 1 / 255 };
  }
  const img = e.settings.sampleAllLayers || !l ? await compositeRGBA(e) : await layerRGBA(e, l);
  return { ...img, unit: 1 };
}
/** Pixels within tolerance of the clicked color, contiguous or global. */
export async function wandMask(e: Editor, x: number, y: number): Promise<Mask8> {
  const img = await wandImage(e);
  const W = img.width,
    H = img.height,
    d = img.data;
  const t = e.tolerance * img.unit;
  const i0 = (y * W + x) * 4;
  const ref = [d[i0], d[i0 + 1], d[i0 + 2], d[i0 + 3]];
  const within = (i: number) =>
    Math.abs(d[i] - ref[0]) <= t && Math.abs(d[i + 1] - ref[1]) <= t && Math.abs(d[i + 2] - ref[2]) <= t && Math.abs(d[i + 3] - ref[3]) <= t;
  const out = new Uint8Array(W * H);
  if (e.settings.contiguous === false) {
    for (let p = 0; p < W * H; p++) if (within(p * 4)) out[p] = 255;
  } else {
    // Scanline flood fill.
    const stack = [x, y];
    while (stack.length) {
      const sy = stack.pop()!,
        sx = stack.pop()!;
      let lx = sx;
      while (lx >= 0 && !out[sy * W + lx] && within((sy * W + lx) * 4)) lx--;
      lx++;
      let rx = sx;
      while (rx < W && !out[sy * W + rx] && within((sy * W + rx) * 4)) rx++;
      for (let k = lx; k < rx; k++) out[sy * W + k] = 255;
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= H) continue;
        let k = lx;
        while (k < rx) {
          while (k < rx && (out[ny * W + k] || !within((ny * W + k) * 4))) k++;
          if (k >= rx) break;
          stack.push(k, ny);
          while (k < rx && !out[ny * W + k] && within((ny * W + k) * 4)) k++;
        }
      }
    }
  }
  if (e.settings.antiAlias !== false) {
    // Soften the boundary by one pixel like an anti-aliased selection edge.
    const soft = new Uint8Array(out);
    for (let yy = 1; yy < H - 1; yy++)
      for (let xx = 1; xx < W - 1; xx++) {
        const i = yy * W + xx;
        if (out[i]) continue;
        const n = (out[i - 1] + out[i + 1] + out[i - W] + out[i + W]) / 4;
        if (n) soft[i] = Math.round(n / 2);
      }
    return { width: W, height: H, data: soft };
  }
  return { width: W, height: H, data: out };
}

// ----- Commands -----
async function modifyDialog(e: Editor, title: string, label: string, max: number, fn: (m: Mask8, v: number) => Mask8) {
  const v = await formDialog(title, [{ name: 'value', label, value: 5, type: 'number', min: 0, max }], 'OK');
  if (!v) return;
  const sel = selectionGrid(e.doc, e.assets.tiles);
  if (!sel) return;
  const m = readMask(e.assets.tiles, sel, canvasRect(e.doc));
  commitSelectionMask(e, fn(m, Number(v.value)), 'replace', title.replace('…', ''));
}
export function installSelection(_e: Editor) {
  registerTool(
    marqueeTool('rect-marquee', 'Rectangular Marquee Tool', 'square-dashed', 'rect', 'M'),
    marqueeTool('ellipse-marquee', 'Elliptical Marquee Tool', 'marquee-ellipse', 'ellipse', 'M'),
    marqueeTool('row-marquee', 'Single Row Marquee Tool', 'marquee-row', 'row'),
    marqueeTool('column-marquee', 'Single Column Marquee Tool', 'marquee-column', 'column'),
    lassoTool,
    polygonTool,
    wandTool,
  );
  const has = (e: Editor) => !!e.doc.selection;
  registerCommand(
    { id: 'select.all', label: 'All', shortcut: 'Mod+A', enabled: (e) => e.hasDocument, run: (e) => commitSelectionMask(e, selectAllGrid(), 'replace', 'Select All') },
    { id: 'select.deselect', label: 'Deselect', shortcut: 'Mod+D', enabled: has, run: (e) => commitSelectionMask(e, null, 'replace', 'Deselect') },
    {
      id: 'select.reselect',
      label: 'Reselect',
      shortcut: 'Mod+Shift+D',
      enabled: (e) => !!e.session.lastSelection,
      run: (e) => {
        const last = e.session.lastSelection;
        if (last) commitSelectionMask(e, last, 'replace', 'Reselect');
      },
    },
    {
      id: 'select.inverse',
      label: 'Inverse',
      shortcut: ['Mod+Shift+I', 'Shift+F7'],
      enabled: (e) => e.hasDocument,
      run: (e) => commitSelectionMask(e, invertSelection(e.assets.tiles, e.doc, selectionGrid(e.doc, e.assets.tiles)), 'replace', 'Inverse'),
    },
    // Distance-transform morphology keeps expanded and contracted edges round
    // and exact at any radius.
    { id: 'select.modify-feather', label: 'Feather…', shortcut: 'Shift+F6', enabled: has, run: (e) => modifyDialog(e, 'Feather Selection', 'Feather Radius (px)', 1000, feather) },
    { id: 'select.modify-expand', label: 'Expand…', enabled: has, run: (e) => modifyDialog(e, 'Expand Selection', 'Expand By (px)', 500, (m, v) => expand(m, v)) },
    { id: 'select.modify-contract', label: 'Contract…', enabled: has, run: (e) => modifyDialog(e, 'Contract Selection', 'Contract By (px)', 500, (m, v) => contract(m, v)) },
    { id: 'select.modify-border', label: 'Border…', enabled: has, run: (e) => modifyDialog(e, 'Border Selection', 'Width (px)', 200, border) },
    { id: 'select.modify-smooth', label: 'Smooth…', enabled: has, run: (e) => modifyDialog(e, 'Smooth Selection', 'Sample Radius (px)', 500, smooth) },
    {
      id: 'select.grow',
      label: 'Grow',
      description: 'Add adjacent pixels within the Magic Wand tolerance of the selected colors.',
      enabled: has,
      run: async (e) => {
        const m = readMask(e.assets.tiles, selectionGrid(e.doc, e.assets.tiles)!, canvasRect(e.doc));
        commitSelectionMask(e, grow(await wandRGBA(e), m, e.tolerance), 'replace', 'Grow');
      },
    },
    {
      id: 'select.similar',
      label: 'Similar',
      description: 'Add pixels anywhere in the image within the Magic Wand tolerance of the selected colors.',
      enabled: has,
      run: async (e) => {
        const m = readMask(e.assets.tiles, selectionGrid(e.doc, e.assets.tiles)!, canvasRect(e.doc));
        commitSelectionMask(e, similar(await wandRGBA(e), m, e.tolerance), 'replace', 'Similar');
      },
    },
    {
      id: 'select.all-layers',
      label: 'All Layers',
      shortcut: 'Mod+Alt+A',
      enabled: (e) => e.doc.layers.length > 0,
      run: (e) => {
        e.selectLayers(e.doc.layers.map((l) => l.id));
        e.update();
      },
    },
    {
      id: 'select.deselect-layers',
      label: 'Deselect Layers',
      enabled: (e) => e.selectedIds.size > 0,
      run: (e) => {
        e.selectLayers([]);
        e.update();
      },
    },
  );
  // Marching ants for the committed selection.
  let cache: { grid: TileGrid; zoom: number; d: string } | undefined;
  registerOverlay('selection', (e) => {
    const grid = e.doc.selectionMask ?? (e.doc.selection ? selectionGrid(e.doc, e.assets.tiles) : null);
    if (!grid || e.settings.hideSelectionEdges) return '';
    if (!cache || cache.grid !== grid) cache = { grid, zoom: e.zoom, d: selectionOutline(e.doc, e.assets.tiles, grid) };
    const z = e.zoom;
    return `<g class="marching committed" stroke-width="${1 / z}" fill="none" style="--dash:${8 / z}px"><path d="${cache.d}" class="ants-white"/><path d="${cache.d}" class="ants-black" stroke-dasharray="${4 / z} ${4 / z}"/></g>`;
  });
}
