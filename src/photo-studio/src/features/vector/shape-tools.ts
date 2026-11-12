import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import type { LiveShape } from '../../model/live-shape';
import { findLayer, type Layer } from '../../model/document';
import { vectorBounds, type VectorMask } from '../../model/vector';
import { layerLock } from '../../model/locks';
import { escapeXML } from '../../model/assets';
import { formDialog } from '../../ui/dialog';
import { svg } from '../../app/icons';
import { insertAboveSelection } from '../layers/insert';
import { commitTarget, hexRgb, pixelTarget } from '../pixels';
import { closedPath, liveKnots, maskToSvg, snap45, type PathOp, type Pt, type SubPath } from './geometry';
import { allShapes, customShapePaths, shapeAspect } from './custom-shapes';
import { applyFill, applyStroke, buildPaint, openPaintPopover, swatchButton, type FillSpec, type StrokeSpec } from './paint';
import { drawingTarget, nextName, setActive, setShapeMask, shapeDocMask, shapeLayer, singleSelected, vstate } from './state';
import { commitPathEdit, commitsSettled } from './masks';
import { maskCoverage } from './raster';
import { reshape, shapeBounds } from './edit';
import { spaceHeld } from './keys';

import { shapeOpts, type ShapeKind, type ShapeMode } from './shape-options';
export { shapeOpts, type ShapeKind, type ShapeMode } from './shape-options';

const names: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line', custom: 'Shape' };

type Drag = { kind: ShapeKind; start: Pt; end: Pt; last: Pt; shift: boolean; alt: boolean; moved: boolean; spaceLast?: Pt };
let drag: Drag | undefined;
let previewPaths: SubPath[] | undefined;

function box(d: Drag): { x: number; y: number; width: number; height: number } {
  let [x0, y0] = d.start;
  let w = d.end[0] - x0, h = d.end[1] - y0;
  if (d.shift) {
    const aspect = d.kind === 'custom' ? customAspect() : 1;
    const s = Math.max(Math.abs(w), Math.abs(h) * aspect);
    w = Math.sign(w || 1) * s;
    h = (Math.sign(h || 1) * s) / aspect;
  }
  if (d.alt) {
    x0 -= w;
    y0 -= h;
    w *= 2;
    h *= 2;
  }
  let r = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), width: Math.abs(w), height: Math.abs(h) };
  if (shapeOpts.alignEdges) {
    const x = Math.round(r.x), y = Math.round(r.y);
    r = { x, y, width: Math.round(r.x + r.width) - x, height: Math.round(r.y + r.height) - y };
  }
  return r;
}
function customAspect() {
  const s = allShapes().find((c) => c.id === shapeOpts.custom);
  return s ? shapeAspect(s) : 1;
}
function linePoints(d: Drag): [Pt, Pt] {
  let b = d.shift ? snap45(d.start, d.end) : d.end;
  let a = d.start;
  if (d.alt) a = [2 * d.start[0] - b[0], 2 * d.start[1] - b[1]];
  if (shapeOpts.alignEdges) {
    a = [Math.round(a[0]), Math.round(a[1])];
    b = [Math.round(b[0]), Math.round(b[1])];
  }
  return [a, b];
}
/** Live parameters for the dragged geometry (custom shapes have none). */
export function liveFor(kind: ShapeKind, r: { x: number; y: number; width: number; height: number }, line?: [Pt, Pt]): LiveShape | undefined {
  const o = shapeOpts;
  switch (kind) {
    case 'rect':
      return { kind: 'rect', ...r, radii: o.perCorner ? [...o.radii] : [o.radius, o.radius, o.radius, o.radius] };
    case 'ellipse':
      return { kind: 'ellipse', ...r };
    case 'triangle':
      return { kind: 'triangle', ...r, radius: o.triRadius };
    case 'polygon':
      return { kind: 'polygon', ...r, sides: Math.max(3, Math.min(100, Math.round(o.sides))), star: Math.max(0, Math.min(0.99, o.star / 100)), radius: o.polyRadius, smoothIndents: o.smoothIndents };
    case 'line': {
      const [a, b] = line!;
      return { kind: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], weight: Math.max(0.1, o.weight), arrowStart: o.arrowStart, arrowEnd: o.arrowEnd, arrowWidth: Math.max(1, o.arrowWidth), arrowLength: Math.max(0.1, o.arrowLength), concavity: Math.max(-50, Math.min(50, o.concavity)) / 100 };
    }
    default:
      return;
  }
}
function shapePaths(r: { x: number; y: number; width: number; height: number }, live: LiveShape | undefined, op: PathOp): SubPath[] {
  if (live) return [closedPath(liveKnots(live), op)];
  const s = allShapes().find((c) => c.id === shapeOpts.custom) ?? allShapes()[0];
  return customShapePaths(s, r.x, r.y, r.width, r.height, op);
}
function dragGeometry(d: Drag) {
  const line = d.kind === 'line' ? linePoints(d) : undefined;
  const r = line ? { x: Math.min(line[0][0], line[1][0]), y: Math.min(line[0][1], line[1][1]), width: Math.abs(line[1][0] - line[0][0]), height: Math.abs(line[1][1] - line[0][1]) } : box(d);
  const live = liveFor(d.kind, r, line);
  const op: PathOp = shapeOpts.op === 'new' ? 'combine' : shapeOpts.op;
  return { r, live, paths: shapePaths(r, live, op), degenerate: line ? Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 0.5 : r.width < 0.5 || r.height < 0.5 };
}
/** True when drawing combines into the selected shape layer instead of creating one. */
function combining(e: Editor) {
  const l = singleSelected(e);
  return shapeOpts.op !== 'new' && l?.kind === 'vector';
}

function showPreview(e: Editor, d: Drag) {
  const g = dragGeometry(d);
  previewPaths = g.paths;
  if (shapeOpts.mode !== 'shape' || g.degenerate) {
    e.preview(e.doc);
    e.overlay();
    return;
  }
  try {
    if (combining(e)) {
      const l = singleSelected(e)!;
      const copy = { ...l, vector: { ...l.vector!, fill: structuredClone(l.vector!.fill), stroke: l.vector!.stroke && { ...l.vector!.stroke } } };
      setShapeMask(copy, { paths: [...shapeDocMask(l).paths, ...g.paths] });
      e.preview({ ...e.doc, layers: replaceLayer(e.doc.layers, copy) });
    } else {
      const temp = makeLayer(e, d.kind, g.paths, g.live, g.r);
      const anchor = e.selected;
      const insert = (layers: Layer[]): Layer[] => {
        const i = layers.findIndex((x) => x.id === anchor);
        if (i >= 0) return [...layers.slice(0, i + 1), temp, ...layers.slice(i + 1)];
        return layers.map((x) => (x.children.length ? { ...x, children: insert(x.children) } : x));
      };
      const layers = anchor && findLayer(e.doc.layers, anchor) ? insert(e.doc.layers) : [...e.doc.layers, temp];
      e.preview({ ...e.doc, layers });
    }
  } catch (error) {
    e.message(String((error as Error).message ?? error));
  }
  e.overlay();
}
function replaceLayer(layers: Layer[], l: Layer): Layer[] {
  return layers.map((x) => (x.id === l.id ? l : x.children.length ? { ...x, children: replaceLayer(x.children, l) } : x));
}
/** Add a custom shape as a new shape layer filling `r` (Shapes panel). */
export function addCustomShapeLayer(e: Editor, shapeId: string, r: { x: number; y: number; width: number; height: number }) {
  const shape = allShapes().find((c) => c.id === shapeId);
  if (!shape) return;
  const layer = makeLayer(e, 'custom', customShapePaths(shape, r.x, r.y, r.width, r.height), undefined, r);
  layer.name = nextName(e.doc, shape.name);
  insertAboveSelection(e, layer, 'Add Shape');
  setActive(e, undefined);
}
function makeLayer(e: Editor, kind: ShapeKind, paths: SubPath[], live: LiveShape | undefined, r: { x: number; y: number; width: number; height: number }) {
  const open = paths.some((p) => p.open);
  const paint = buildPaint(e, shapeOpts.fill, shapeOpts.stroke, r, open);
  return shapeLayer(e.doc, nextName(e.doc, names[kind]), { paths: structuredClone(paths) }, paint.fill, paint.stroke, live, paint.color);
}
/** Create the shape in the current mode: a shape layer, a path, or pixels. */
export async function commitShape(e: Editor, kind: ShapeKind, paths: SubPath[], live: LiveShape | undefined, r: { x: number; y: number; width: number; height: number }) {
  const mode = shapeOpts.mode;
  if (mode === 'pixels') {
    const target = await pixelTarget(e);
    if (!target) return;
    const cov = await maskCoverage(e, { paths: paths.map((p, i) => (i === 0 ? { ...p, operation: 'combine' as const } : p)) });
    const { paintCoverage } = await import('./raster');
    const grid = paintCoverage(e, target, cov, hexRgb(e.color), 1);
    commitTarget(e, target, grid, `${names[kind]} Tool`);
    return;
  }
  if (mode === 'path') {
    await commitsSettled();
    const t = drawingTarget(e);
    const mask: VectorMask = { ...t.mask, paths: [...structuredClone(t.mask.paths), ...structuredClone(paths)] };
    if (t.kind === 'work' && !e.doc.workPath?.paths.length) mask.paths[0].operation = 'combine';
    if (!(await commitPathEdit(e, t, mask, t.kind === 'work' && t.mask.paths.length === 0 ? 'Work Path' : `${names[kind]} Tool`))) return;
    const st = vstate(e);
    st.paths = new Set(mask.paths.map((_, i) => i).slice(t.mask.paths.length));
    return;
  }
  if (combining(e)) {
    const l = singleSelected(e)!;
    if (layerLock(e.doc.layers, l.id, 'all')) {
      e.message('Unlock this layer to edit its shape.');
      return;
    }
    e.command(`${names[kind]} Tool`, (d) => {
      const x = findLayer(d.layers, l.id)!;
      setShapeMask(x, { paths: [...shapeDocMask(x).paths, ...structuredClone(paths)] });
    });
    return;
  }
  const layer = makeLayer(e, kind, paths, live, r);
  insertAboveSelection(e, layer, `${names[kind]} Tool`);
  setActive(e, undefined);
}

// ----- Options bar -----
const num = (id: string, label: string, value: number, attrs = '', unit = '') =>
  `<label class="vec-num">${label} <input id="${id}" type="number" value="${Math.round(value * 100) / 100}" ${attrs}>${unit}</label>`;
function shapeOptions(e: Editor, kind: ShapeKind) {
  const o = shapeOpts;
  const l = singleSelected(e);
  const b = l?.kind === 'vector' ? shapeBounds(l) : null;
  const modeSel = `<label>Mode <select id="vec-mode" aria-label="Tool mode">${(['shape', 'path', 'pixels'] as const).map((m) => `<option value="${m}" ${o.mode === m ? 'selected' : ''}>${m === 'shape' ? 'Shape' : m === 'path' ? 'Path' : 'Pixels'}</option>`).join('')}</select></label>`;
  const paint = o.mode === 'shape'
    ? `<span class="vec-paint-row">Fill ${swatchButton('vec-fill', 'Shape fill', o.fill, e.color)} Stroke ${swatchButton('vec-stroke', 'Shape stroke', o.stroke, e.color, true)}${num('vec-stroke-width', '', o.stroke.width, 'min="0" max="1000" step="0.5" aria-label="Stroke width (px)" title="Stroke width"', 'px')}<select id="vec-stroke-dash" aria-label="Stroke style" title="Stroke style">${(['solid', 'dashed', 'dotted'] as const).map((s) => `<option value="${s}" ${o.stroke.dash === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select><select id="vec-stroke-align" aria-label="Stroke alignment" title="Stroke alignment">${(['inside', 'center', 'outside'] as const).map((s) => `<option value="${s}" ${o.stroke.align === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></span>`
    : '';
  const wh = o.mode === 'shape' ? `${num('vec-w', 'W', b?.width ?? 0, `min="0" max="16384" ${b ? '' : 'disabled'} aria-label="Width of selected shape"`)}${num('vec-h', 'H', b?.height ?? 0, `min="0" max="16384" ${b ? '' : 'disabled'} aria-label="Height of selected shape"`)}` : '';
  const ops = o.mode === 'pixels' ? '' : `<label>Path <select id="vec-op" aria-label="Path operation">${([['new', o.mode === 'shape' ? 'New Layer' : 'New Path Area'], ['combine', 'Combine Shapes'], ['subtract', 'Subtract Front Shape'], ['intersect', 'Intersect Shape Areas'], ['exclude', 'Exclude Overlapping']] as const).map(([v, label]) => `<option value="${v}" ${o.op === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
  let extra = '';
  if (kind === 'rect')
    extra = o.perCorner
      ? `<span class="vec-radii">${['TL', 'TR', 'BR', 'BL'].map((c, i) => num(`vec-r${i}`, c, o.radii[i], `min="0" max="8192" aria-label="${c} corner radius"`)).join('')}</span><button class="icon-button toggle" id="vec-per-corner" aria-pressed="true" title="Link corner radii">${svg('link-2', 15)}</button>`
      : `${num('vec-radius', 'Radius', o.radius, 'min="0" max="8192"', 'px')}<button class="icon-button toggle" id="vec-per-corner" aria-pressed="false" title="Set each corner radius separately">${svg('link-2', 15)}</button>`;
  if (kind === 'triangle') extra = num('vec-tri-radius', 'Radius', o.triRadius, 'min="0" max="8192"', 'px');
  if (kind === 'polygon')
    extra = `${num('vec-sides', 'Sides', o.sides, 'min="3" max="100" step="1"')}${num('vec-star', 'Star', o.star, 'min="0" max="99" title="Indent sides by (%)"', '%')}${num('vec-poly-radius', 'Radius', o.polyRadius, 'min="0" max="8192"', 'px')}<label class="transform-setting"><input id="vec-smooth-indents" type="checkbox" ${o.smoothIndents ? 'checked' : ''}>Smooth indents</label>`;
  if (kind === 'line')
    extra = `${num('vec-weight', 'Weight', o.weight, 'min="0.1" max="1000" step="0.5"', 'px')}<label class="transform-setting"><input id="vec-arrow-start" type="checkbox" ${o.arrowStart ? 'checked' : ''}>Start</label><label class="transform-setting"><input id="vec-arrow-end" type="checkbox" ${o.arrowEnd ? 'checked' : ''}>End arrow</label>${o.arrowStart || o.arrowEnd ? `${num('vec-arrow-width', 'Width', o.arrowWidth * 100, 'min="100" max="5000" step="10" title="Arrowhead width (% of weight)"', '%')}${num('vec-arrow-length', 'Length', o.arrowLength * 100, 'min="10" max="5000" step="10" title="Arrowhead length (% of weight)"', '%')}${num('vec-concavity', 'Concavity', o.concavity, 'min="-50" max="50"', '%')}` : ''}`;
  if (kind === 'custom') {
    const s = allShapes().find((c) => c.id === o.custom) ?? allShapes()[0];
    extra = `<button id="vec-custom" class="vec-custom-button" aria-haspopup="dialog" title="Choose a custom shape"><svg viewBox="-4 -4 108 108" width="20" height="20" aria-hidden="true"><path d="${s.d}" fill="currentColor" fill-rule="evenodd"/></svg><span>${escapeXML(s.name)}</span></button>`;
  }
  return `${modeSel}${paint}${wh}${ops}${extra}<label class="transform-setting" title="Snap shape edges to the pixel grid"><input id="vec-align-edges" type="checkbox" ${o.alignEdges ? 'checked' : ''}>Align Edges</label>`;
}
function bindShapeOptions(e: Editor, el: HTMLElement) {
  const o = shapeOpts;
  const on = (id: string, f: (t: HTMLInputElement) => void, ev = 'change') => el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener(ev, (event) => f(event.target as HTMLInputElement));
  const n = (t: HTMLInputElement, min = 0) => Math.max(min, Number.isFinite(t.valueAsNumber) ? t.valueAsNumber : min);
  const rerender = () => e.options();
  on('vec-mode', (t) => {
    o.mode = t.value as ShapeMode;
    rerender();
  });
  on('vec-op', (t) => (o.op = t.value as typeof o.op));
  on('vec-align-edges', (t) => (o.alignEdges = t.checked));
  const applyStrokeToLayer = () => {
    const l = singleSelected(e);
    if (l?.kind !== 'vector') return;
    e.editLayer('Change Shape Stroke', (x) => applyStroke(x.vector!, o.stroke));
  };
  on('vec-stroke-width', (t) => {
    o.stroke.width = n(t);
    if (o.stroke.width > 0 && o.stroke.type === 'none') o.stroke.type = 'color';
    applyStrokeToLayer();
    rerender();
  });
  on('vec-stroke-dash', (t) => {
    o.stroke.dash = t.value as StrokeSpec['dash'];
    applyStrokeToLayer();
  });
  on('vec-stroke-align', (t) => {
    o.stroke.align = t.value as StrokeSpec['align'];
    applyStrokeToLayer();
  });
  const popover = (id: string, stroke: boolean) =>
    el.querySelector<HTMLElement>(`#${id}`)?.addEventListener('click', (ev) => {
      const anchor = ev.currentTarget as HTMLElement;
      openPaintPopover(e, anchor, stroke ? o.stroke : o.fill, (spec) => {
        if (stroke) o.stroke = spec as StrokeSpec;
        else o.fill = spec as FillSpec;
        const span = anchor.querySelector('span');
        if (span) span.setAttribute('style', (stroke ? 'background:' + (o.stroke.type === 'none' ? 'repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px' : o.stroke.color) : swatchFill()) as string);
        const l = singleSelected(e);
        if (l?.kind !== 'vector') return;
        if (stroke) e.editLayer('Change Shape Stroke', (x) => applyStroke(x.vector!, o.stroke));
        else e.editLayer('Change Shape Fill', (x) => {
          applyFill(e, x.vector!, o.fill, vectorBounds(shapeDocMask(x)));
          if (o.fill.type === 'color') x.color = o.fill.color || e.color;
        });
      });
    });
  const swatchFill = () => {
    const f = o.fill;
    return f.type === 'none' ? 'background:repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px' : f.type === 'color' ? `background:${f.color || e.color}` : f.type === 'gradient' ? `background:linear-gradient(90deg,${f.from},${f.to})` : 'background:repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px';
  };
  popover('vec-fill', false);
  popover('vec-stroke', true);
  const resize = (key: 'width' | 'height') => (t: HTMLInputElement) => {
    const l = singleSelected(e);
    if (l?.kind !== 'vector' || !Number.isFinite(t.valueAsNumber)) return;
    e.editLayer('Resize Shape', (x) => reshape(x, { [key]: Math.max(0, t.valueAsNumber) }));
  };
  on('vec-w', resize('width'));
  on('vec-h', resize('height'));
  on('vec-radius', (t) => (o.radius = n(t)));
  for (let i = 0; i < 4; i++) on(`vec-r${i}`, (t) => (o.radii[i] = n(t)));
  el.querySelector('#vec-per-corner')?.addEventListener('click', () => {
    o.perCorner = !o.perCorner;
    if (o.perCorner) o.radii = [o.radius, o.radius, o.radius, o.radius];
    else o.radius = o.radii[0];
    rerender();
  });
  on('vec-tri-radius', (t) => (o.triRadius = n(t)));
  on('vec-sides', (t) => (o.sides = Math.round(Math.max(3, Math.min(100, n(t, 3))))));
  on('vec-star', (t) => (o.star = Math.min(99, n(t))));
  on('vec-poly-radius', (t) => (o.polyRadius = n(t)));
  on('vec-smooth-indents', (t) => (o.smoothIndents = t.checked));
  on('vec-weight', (t) => (o.weight = n(t, 0.1)));
  on('vec-arrow-start', (t) => {
    o.arrowStart = t.checked;
    rerender();
  });
  on('vec-arrow-end', (t) => {
    o.arrowEnd = t.checked;
    rerender();
  });
  on('vec-arrow-width', (t) => (o.arrowWidth = n(t, 100) / 100));
  on('vec-arrow-length', (t) => (o.arrowLength = n(t, 10) / 100));
  on('vec-concavity', (t) => (o.concavity = Math.max(-50, Math.min(50, Number(t.value) || 0))));
  el.querySelector<HTMLElement>('#vec-custom')?.addEventListener('click', (ev) => openShapePicker(e, ev.currentTarget as HTMLElement));
}
export function openShapePicker(e: Editor, anchor: HTMLElement) {
  document.querySelector('.vec-shape-picker')?.remove();
  const pop = document.createElement('div');
  pop.className = 'vec-shape-picker popover';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', 'Custom shapes');
  pop.innerHTML = allShapes()
    .map((s) => `<button role="option" aria-selected="${s.id === shapeOpts.custom}" data-shape="${escapeXML(s.id)}" title="${escapeXML(s.name)}" aria-label="${escapeXML(s.name)}"><svg viewBox="-4 -4 108 108" aria-hidden="true"><path d="${escapeXML(s.d)}" fill="currentColor" fill-rule="evenodd"/></svg></button>`)
    .join('');
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 4, r.left))}px`;
  pop.style.top = `${r.bottom + 4}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close();
  };
  pop.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-shape]');
    if (!b) return;
    shapeOpts.custom = b.dataset.shape!;
    close();
    e.options();
  });
  pop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      close();
      anchor.focus();
    }
  });
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  pop.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

// ----- Click-to-create dialog -----
async function createDialog(e: Editor, kind: ShapeKind, at: Pt) {
  const o = shapeOpts;
  const fields: Parameters<typeof formDialog>[1] = kind === 'line'
    ? [{ name: 'length', label: 'Length (px)', value: 200, type: 'number', min: 1, max: 16384 }, { name: 'angle', label: 'Angle (°)', value: 0, type: 'number', min: -360, max: 360 }, { name: 'weight', label: 'Weight (px)', value: o.weight, type: 'number', min: 0.1, max: 1000 }]
    : [{ name: 'width', label: 'Width (px)', value: 200, type: 'number', min: 1, max: 16384 }, { name: 'height', label: 'Height (px)', value: 200, type: 'number', min: 1, max: 16384 }];
  if (kind === 'rect') fields.push({ name: 'radius', label: 'Corner radius (px)', value: o.perCorner ? o.radii[0] : o.radius, type: 'number', min: 0, max: 8192 });
  if (kind === 'polygon') fields.push({ name: 'sides', label: 'Sides', value: o.sides, type: 'number', min: 3, max: 100, step: 1 }, { name: 'star', label: 'Star inset (%)', value: o.star, type: 'number', min: 0, max: 99 });
  fields.push({ name: 'center', label: 'From center', value: 'no', type: 'checkbox' });
  const v = await formDialog(`Create ${names[kind]}`, fields, 'OK');
  if (!v) return;
  const center = v.center === 'yes';
  if (kind === 'rect') {
    o.perCorner = false;
    o.radius = Number(v.radius) || 0;
  }
  if (kind === 'polygon') {
    o.sides = Math.round(Number(v.sides) || 5);
    o.star = Number(v.star) || 0;
  }
  let d: Drag;
  if (kind === 'line') {
    o.weight = Number(v.weight) || o.weight;
    const a = (Number(v.angle) * Math.PI) / 180, len = Number(v.length);
    const end: Pt = [at[0] + Math.cos(a) * len, at[1] - Math.sin(a) * len];
    d = { kind, start: at, end, last: end, shift: false, alt: center, moved: true };
    if (center) d.end = [at[0] + (end[0] - at[0]) / 2, at[1] + (end[1] - at[1]) / 2];
  } else {
    const w = Number(v.width), h = Number(v.height);
    d = { kind, start: at, end: center ? [at[0] + w / 2, at[1] + h / 2] : [at[0] + w, at[1] + h], last: at, shift: false, alt: center, moved: true };
  }
  const g = dragGeometry(d);
  await commitShape(e, kind, g.paths, g.live, g.r);
}

export function shapeTool(id: string, label: string, icon: string, kind: ShapeKind): Tool {
  return {
    id,
    label,
    key: 'U',
    icon,
    group: 'shape',
    cursor: () => 'crosshair',
    options: (e) => shapeOptions(e, kind),
    bindOptions: ({ e, el }) => bindShapeOptions(e, el),
    deactivate: (e) => {
      drag = undefined;
      previewPaths = undefined;
      e.preview(e.doc);
    },
    pointerDown: (_e, p) => {
      drag = { kind, start: [p.x, p.y], end: [p.x, p.y], last: [p.x, p.y], shift: p.shift, alt: p.alt, moved: false };
    },
    pointerMove: (e, p) => {
      const d = drag;
      if (!d) return;
      if (spaceHeld()) {
        // Space repositions the shape while drawing.
        const last = d.spaceLast ?? [p.x, p.y];
        const dx = p.x - last[0], dy = p.y - last[1];
        d.start = [d.start[0] + dx, d.start[1] + dy];
        d.end = [d.end[0] + dx, d.end[1] + dy];
        d.spaceLast = [p.x, p.y];
      } else {
        d.spaceLast = undefined;
        d.end = [p.x, p.y];
      }
      d.shift = p.shift;
      d.alt = p.alt;
      if (Math.hypot(p.clientX - e.clientPoint(d.start[0], d.start[1])[0], p.clientY - e.clientPoint(d.start[0], d.start[1])[1]) > 3) d.moved = true;
      if (d.moved) showPreview(e, d);
    },
    pointerUp: async (e) => {
      const d = drag;
      drag = undefined;
      previewPaths = undefined;
      if (!d) return;
      if (!d.moved) {
        e.preview(e.doc);
        e.overlay();
        await createDialog(e, kind, d.start);
        return;
      }
      const g = dragGeometry(d);
      if (g.degenerate) {
        e.preview(e.doc);
        e.overlay();
        return;
      }
      await commitShape(e, kind, g.paths, g.live, g.r);
      e.overlay();
    },
    keyDown: (e, ev) => {
      if (ev.key === 'Escape' && drag) {
        drag = undefined;
        previewPaths = undefined;
        e.preview(e.doc);
        e.overlay();
        return true;
      }
      return false;
    },
    overlay: (e) => {
      if (!drag || !previewPaths || !drag.moved) return '';
      const z = e.zoom;
      const d = maskToSvg({ paths: previewPaths });
      return `<path d="${d}" class="vec-preview" fill="none" stroke-width="${1 / z}"/>`;
    },
  };
}
