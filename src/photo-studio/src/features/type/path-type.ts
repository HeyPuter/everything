// Type on a path and area type: finding the path under the Type tool,
// start/end markers (dragged with the path selection tools, across the path
// to flip), the overlay for path text, Convert to Arc Text and the path type
// options dialog.

import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { registerCommand, registerOverlay, renamedCommands } from '../../app/registry';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { fitTextFrame, syncLegacyFields } from '../../model/text-layer';
import { applyParagraphStyle, textLength, type ArcPreset, type FitShape, type TextLayerData, type TypePath } from '../../imaging/text/model';
import { fitFrom, fixedFitBox, releaseFit } from '../../imaging/text/fit';
import { layoutText } from '../../imaging/text/layout';
import { canvasMeasure } from '../../imaging/text/render';
import type { TextLayout } from '../../imaging/text/layout';
import { arcPresetPath, nearestOnPath, pathGeometry, pointAt, type PathGeometry } from '../../imaging/text/path-text';
import { blockFor } from '../../imaging/text/block-text';
import { prepareFonts } from '../../imaging/text/fonts';
import { targetPath, textPathHooks } from '../vector/state';
import { selectHooks } from '../vector/select-hooks';
import { modal, fieldChecked, fieldValue } from '../files/ui';
import { editLayers, editMark, revertToMark, session, updateData } from './session';
import { editable, layerMatrix, layoutOf, localBounds, localScale, ppiOf, replaceLayer, selectedTextLayersOf, toDoc, toLocal } from './text-utils';

// ------------------------------------------------------------ cursors

// Original cursors: an I-beam over a curve (type on a path) and an I-beam
// inside a dotted ring (area type).
const cursor = (body: string, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke-linecap='round'>${body}</g></svg>`)}") 9 9, ${fallback}`;
const BEAM = (s: string, w: number) => `<path d='M6 3h6M6 15h6M9 3v12' stroke='${s}' stroke-width='${w}'/>`;
export const PATH_TYPE_CURSOR = cursor(`${BEAM('#fff', 3)}${BEAM('#000', 1.2)}<path d='M3 21c4-5 8-5 9-2s5 3 9-2' stroke='#fff' stroke-width='3'/><path d='M3 21c4-5 8-5 9-2s5 3 9-2' stroke='#000' stroke-width='1.2'/>`, 'text');
export const AREA_TYPE_CURSOR = cursor(`<circle cx='12' cy='12' r='10' stroke='#fff' stroke-width='3'/><circle cx='12' cy='12' r='10' stroke='#000' stroke-width='1.2' stroke-dasharray='2 2.2'/>${BEAM('#fff', 3).replace(/M6 3h6M6 15h6M9 3v12/, 'M9 6h6M9 18h6M12 6v12')}${BEAM('#000', 1.2).replace(/M6 3h6M6 15h6M9 3v12/, 'M9 6h6M9 18h6M12 6v12')}`, 'text');

// ------------------------------------------------------------ paths under the Type tool

export type PathHit = { kind: 'path' | 'area'; knots: number[][]; closed: boolean; fraction: number };

// Even-odd containment in a flattened closed outline.
function inside(g: PathGeometry, x: number, y: number): boolean {
  let c = false;
  const n = g.xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = g.ys[i], yj = g.ys[j];
    if (yi > y !== yj > y && x < ((g.xs[j] - g.xs[i]) * (y - yi)) / (yj - yi) + g.xs[i]) c = !c;
  }
  return c;
}

// The visible path (the one the Paths panel targets) under a document point:
// near its outline starts text on the path, inside a closed subpath starts
// area text. Paths of other text layers are not offered.
let flattened: { doc: PhotoDocument; key: string; paths: { knots: number[][]; closed: boolean; g: PathGeometry }[] } | undefined;
export function typePathAt(e: Editor, x: number, y: number): PathHit | undefined {
  const t = targetPath(e);
  if (!t || t.kind === 'text' || e.settings.hideTargetPath) return;
  const tol = 6 / e.zoom;
  let area: PathHit | undefined;
  // Hovering asks on every move: flatten each document state's path once.
  const key = `${t.kind}:${t.id}`;
  if (!flattened || flattened.doc !== e.doc || flattened.key !== key)
    flattened = {
      doc: e.doc,
      key,
      paths: t.mask.paths
        .filter((sp) => sp.knots.length >= 2)
        .map((sp) => {
          const knots = sp.knots.map((k) => [...k.points]);
          return { knots, closed: !sp.open, g: pathGeometry(knots, !sp.open) };
        }),
    };
  for (const { knots, closed, g } of flattened.paths) {
    if (g.length < 1) continue;
    const n = nearestOnPath(g, x, y);
    // Past an open end the nearest point extends along the end tangent.
    const onSegment = closed || (n.s >= 0 && n.s <= g.length);
    if (onSegment && Math.abs(n.distance) <= tol) return { kind: 'path', knots, closed, fraction: Math.max(0, Math.min(1, n.s / g.length)) };
    if (closed && !area && inside(g, x, y)) area = { kind: 'area', knots, closed, fraction: 0 };
  }
  return area;
}

// Text data for new path or area text from a hit (document == local space).
export function newTypePath(hit: PathHit): TypePath {
  if (hit.kind === 'area') return { kind: 'area', knots: hit.knots, closed: true, start: 0, end: 1, flip: false, inset: 0 };
  // Text starts where the path was clicked and runs to its end (or all the
  // way around a closed path).
  return { kind: 'path', knots: hit.knots, closed: hit.closed, start: hit.fraction, end: hit.closed ? hit.fraction : 1, flip: false };
}

// ------------------------------------------------------------ overlay

const n2 = (v: number) => Math.round(v * 100) / 100;

// Path and start/end markers of path text in local space; `k` is local units
// per screen pixel.
export function pathTextMarkup(data: TextLayerData, layout: TextLayout, k: number, active = false): string {
  const p = data.path;
  if (!p) return '';
  let out = '';
  const g = pathGeometry(p.knots, p.closed);
  let d = '';
  for (let i = 0; i < g.xs.length; i++) d += `${i ? 'L' : 'M'}${n2(g.xs[i])} ${n2(g.ys[i])}`;
  if (p.closed) d += 'Z';
  out += `<path class="type-path${active ? ' active' : ''}" d="${d}" stroke-width="${k}"/>`;
  if (p.kind === 'path' && layout.path) {
    const { geometry, a, span } = layout.path;
    const marker = (s: number, end: boolean) => {
      const q = pointAt(geometry, s);
      const nx = -Math.sin(q.angle), ny = Math.cos(q.angle);
      const tx = Math.cos(q.angle), ty = Math.sin(q.angle);
      const h = 9 * k;
      // A bar across the path; the start marker has a tick pointing along
      // the text, the end marker a small ring.
      let m = `<path class="type-path-marker" d="M${n2(q.x - nx * h)} ${n2(q.y - ny * h)}L${n2(q.x + nx * h * 0.5)} ${n2(q.y + ny * h * 0.5)}" stroke-width="${1.5 * k}"/>`;
      if (!end) m += `<path class="type-path-marker" d="M${n2(q.x - nx * h)} ${n2(q.y - ny * h)}l${n2(tx * 5 * k)} ${n2(ty * 5 * k)}" stroke-width="${1.5 * k}"/>`;
      else m += `<circle class="type-path-end" cx="${n2(q.x - nx * h)}" cy="${n2(q.y - ny * h)}" r="${2.5 * k}" stroke-width="${k}"/>`;
      return m;
    };
    out += marker(a, false);
    if (!(p.closed && Math.abs(span - geometry.length) < 1e-6)) out += marker(a + span, true);
  }
  return out;
}

// Markers of the selected path text while a path selection tool is active.
function markersOverlay(e: Editor): string {
  if (!['path-select', 'direct-select'].includes(e.tool) || session) return '';
  const l = pathTextLayer(e);
  if (!l) return '';
  const view = drag ? layerWith(l, drag.data) : l;
  const t = editable(view, ppiOf(e));
  const layout = layoutOf(t.textData, ppiOf(e));
  const k = 1 / (e.zoom * localScale(t));
  return `<g class="type-overlay" transform="matrix(${layerMatrix(t).join(' ')})">${pathTextMarkup(t.textData, layout, k)}</g>`;
}

// ------------------------------------------------------------ markers

function pathTextLayer(e: Editor): (Layer & { textData: TextLayerData }) | undefined {
  if (e.selectedIds.size !== 1) return;
  const l = e.layer;
  return l?.kind === 'text' && l.textData?.path?.kind === 'path' ? (l as Layer & { textData: TextLayerData }) : undefined;
}
function layerWith(l: Layer, data: TextLayerData): Layer {
  return { ...l, textData: data };
}

type MarkerDrag = { id: string; which: 'start' | 'end'; data: TextLayerData; base: TextLayerData; moved: boolean };
let drag: MarkerDrag | undefined;

// Marker under a pointer: which one, in the layer's original path coordinates.
function markerAt(e: Editor, l: Layer & { textData: TextLayerData }, p: CanvasPointer): 'start' | 'end' | undefined {
  const path = l.textData.path!;
  const g = pathGeometry(path.knots, path.closed);
  const tol = 8;
  const near = (f: number) => {
    const q = pointAt(g, f * g.length);
    const [dx, dy] = toDoc(l, q.x, q.y);
    const [cx, cy] = e.clientPoint(dx, dy);
    return Math.hypot(cx - p.clientX, cy - p.clientY);
  };
  const ds = near(path.start), de = near(path.end);
  if (Math.min(ds, de) > tol) return;
  return ds <= de ? 'start' : 'end';
}

// Moves a marker to the nearest point on the path; dragging well across the
// path flips the text to that side.
function dragMarker(e: Editor, l: Layer, d: MarkerDrag, p: CanvasPointer): TextLayerData {
  const path = d.base.path!;
  const g = pathGeometry(path.knots, path.closed);
  const [lx, ly] = toLocal(l, p.x, p.y);
  const near = nearestOnPath(g, lx, ly);
  const f = g.length > 0 ? Math.max(0, Math.min(1, near.s / g.length)) : 0;
  const across = 12 / (e.zoom * localScale(l));
  const flip = Math.abs(near.distance) > across ? near.distance > 0 : d.data.path!.flip;
  return { ...d.base, path: { ...path, [d.which]: f, flip } };
}

async function commitMarker(e: Editor, d: MarkerDrag) {
  if (!d.moved) return;
  const changed = JSON.stringify(d.data.path) !== JSON.stringify(d.base.path);
  e.preview(e.doc);
  if (changed) await editLayers(e, d.data.path!.flip !== d.base.path!.flip ? 'Flip Type on Path' : 'Move Type on Path', () => d.data, [d.id]);
}

// Refits the frame of a text layer whose path changed (no fonts to load:
// the layer was already shown with them).
export function refitText(l: Layer, ppi: number) {
  if (!l.textData) return;
  const layout = layoutOf(l.textData, ppi);
  delete l.asset;
  fitTextFrame(l, localBounds(l.textData, layout));
  syncLegacyFields(l);
}
function previewData(e: Editor, id: string, data: TextLayerData): PhotoDocument {
  const ppi = ppiOf(e);
  return replaceLayer(e.doc, id, (l) => {
    const n: Layer = { ...editable(l, ppi), textData: data };
    refitText(n, ppi);
    return n;
  });
}

// ------------------------------------------------------------ arc text

export const ARC_PRESETS: [ArcPreset, string][] = [['arch', 'Arch'], ['circle', 'Circle'], ['bow', 'Bow'], ['wave', 'Wave']];

// Path text from point text along a preset shape, centered on the text's
// first line; the text is centered between the markers.
export function arcTextData(d: TextLayerData, layout: TextLayout, preset: ArcPreset, bend = 50): TextLayerData {
  const first = layout.lines.find((l) => l.visible) ?? layout.lines[0];
  const width = Math.max(first?.width ?? 0, 8);
  const cx = (first?.x ?? d.origin.x) + width / 2,
    cy = first?.y ?? d.origin.y;
  const shape = arcPresetPath(preset, width * 1.04, cx, cy, bend);
  const content = applyParagraphStyle(d.content, 0, textLength(d.content), { align: 'center' });
  return {
    ...d,
    content,
    mode: 'point',
    box: undefined,
    orientation: 'horizontal',
    warp: undefined,
    block: undefined,
    path: { kind: 'path', knots: shape.knots, closed: shape.closed, start: 0, end: 1, flip: false, arc: { preset, bend, x: cx, y: cy, width: width * 1.04 } },
  };
}

// ------------------------------------------------------------ block text

/** Point text whose lines are all scaled to the width of the widest line and
 * stacked (imaging/text/block-text.ts). */
export function blockTextData(d: TextLayerData, layout: TextLayout): TextLayerData {
  const visible = layout.lines.filter((l) => l.visible);
  const first = visible[0] ?? layout.lines[0];
  const widest = visible.reduce((a, l) => (l.width > a.width ? l : a), first);
  const width = Math.max(8, widest?.width ?? 0);
  const align = d.content.paragraphs[0]?.style.align ?? 'left';
  // The block starts where the widest line started.
  const left = widest ? widest.x : d.origin.x;
  const x = left + (align === 'center' || align === 'justify-center' ? width / 2 : align === 'right' || align === 'justify-right' ? width : 0);
  return { ...d, mode: 'point', box: undefined, orientation: 'horizontal', warp: undefined, path: undefined, origin: { x, y: first?.y ?? d.origin.y }, block: blockFor(width) };
}
// Rebuilds an arc text path with a new preset or bend (same center and width).
export function reshapeArc(d: TextLayerData, preset: ArcPreset, bend: number): TextLayerData {
  const arc = d.path?.arc;
  if (!d.path || !arc) return d;
  const shape = arcPresetPath(preset, arc.width, arc.x, arc.y, bend);
  return { ...d, path: { ...d.path, knots: shape.knots, closed: shape.closed, arc: { ...arc, preset, bend } } };
}

// ------------------------------------------------------------ conversion

// Path text -> point text at the start of the path; area text -> paragraph
// text in the shape's bounding box.
export function dropTypePath(d: TextLayerData, layout: TextLayout): TextLayerData {
  const p = d.path;
  if (!p) return d;
  if (p.kind === 'area') {
    const b = layout.box ?? { x: d.origin.x, y: d.origin.y, width: 100, height: 100 };
    return { ...d, path: undefined, mode: 'paragraph', origin: { x: b.x, y: b.y }, box: { width: Math.max(8, b.width), height: Math.max(8, b.height) } };
  }
  const line = layout.lines[0];
  const [x, y] = layout.map ? layout.map(line?.x ?? 0, 0) : [d.origin.x, d.origin.y];
  const content = applyParagraphStyle(d.content, 0, textLength(d.content), { align: 'left' });
  return { ...d, content, path: undefined, mode: 'point', box: undefined, origin: { x, y } };
}

// ------------------------------------------------------------ dynamic text

export const FIT_LABELS: [FitShape, string][] = [['block', 'Block'], ['circle', 'Circle'], ['arch', 'Arch'], ['bow', 'Bow'], ['wave', 'Wave']];
const FIT_HELP: Record<FitShape, string> = {
  block: 'Scale each line to the width of its box and stack the lines; resizing the box or editing the text refits it.',
  circle: 'Size the text to run around a circle that fits its box.',
  arch: 'Size the text to run along an upward curve that fits its box.',
  bow: 'Size the text to run along a sagging curve that fits its box.',
  wave: 'Size the text to run along an S-shaped wave that fits its box.',
};
const fitOpts = (ppi: number) => ({ measure: canvasMeasure(), resolution: ppi });
function selectedFitLayers(e: Editor) {
  return selectedTextLayersOf(e).filter((l) => !!l.textData?.fit);
}
/** The text as dynamic text in `shape` (one undo step for every selected layer). */
export async function convertToFit(e: Editor, shape: FitShape) {
  const ppi = ppiOf(e);
  const make = (d: TextLayerData) => (d.orientation !== 'horizontal' ? d : fitFrom(d, shape, localBounds(d, layoutOf(d, ppi)), fitOpts(ppi), layoutText));
  if (session && !session.mask) {
    await prepareFonts(session.data);
    return updateData(e, make, 'fit');
  }
  const ids = selectedTextLayersOf(e).map((l) => l.id);
  if (!ids.length) return;
  for (const l of selectedTextLayersOf(e)) await prepareFonts(editable(l, ppi).textData);
  await editLayers(e, 'Convert to Dynamic Text', make, ids);
}
export async function releaseFitText(e: Editor) {
  const ppi = ppiOf(e);
  const make = (d: TextLayerData) => releaseFit(d, fitOpts(ppi), layoutText);
  if (session && !session.mask) return updateData(e, make, 'release-fit');
  const ids = selectedFitLayers(e).map((l) => l.id);
  if (ids.length) await editLayers(e, 'Release Fit', make, ids);
}

// Shape, bend, box and block line settings of dynamic text, previewed live.
async function fitOptions(e: Editor) {
  const cur = currentPathData(e, 'fit');
  if (!cur) return;
  const { data, id } = cur;
  if (!session && layerLock(e.doc.layers, id, 'all')) return e.message('Unlock this layer to change its dynamic text.');
  const ppi = ppiOf(e);
  const f = data.fit!;
  const box = fixedFitBox(data) ?? layoutOf(data, ppi).fitBox!;
  const body = `<label class="dialog-field">Shape<select name="shape">${FIT_LABELS.map(([v, l]) => `<option value="${v}" ${v === f.shape ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
       <div class="type-path-range"><label class="dialog-field">Box width (px)<input name="width" type="number" min="8" max="100000" step="1" value="${Math.round(box.width)}"></label>
       <label class="dialog-field">Box height (px)<input name="height" type="number" min="8" max="100000" step="1" value="${Math.round(box.height)}"></label></div>
       <label class="dialog-field" data-for="curve">Bend<span class="export-range"><input name="bend" type="range" min="-100" max="100" step="1" value="${f.bend}"><output>${f.bend}%</output></span></label>
       <label class="dialog-field" data-for="block">Space between lines (px)<input name="gap" type="number" min="-1000" max="10000" step="1" value="${Math.round(f.gap)}"></label>
       <label class="dialog-field checkbox-field" data-for="block">Break lines to fill the box<input name="autoLines" type="checkbox" ${f.autoLines ? 'checked' : ''}></label>
       <p class="muted">Type sizes in dynamic text are relative: the text grows or shrinks to fill its shape.</p>`;
  const read = (form: HTMLFormElement): TextLayerData => {
    const num = (k: string, lo: number, hi: number, dflt: number) => {
      const v = Number(fieldValue(form, k));
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
    };
    const shape = fieldValue(form, 'shape') as FitShape;
    const width = num('width', 8, 100000, box.width), height = num('height', 8, 100000, box.height);
    // The box stays centered where it was.
    const x = box.x + (box.width - width) / 2, y = box.y + (box.height - height) / 2;
    return { ...data, origin: { x, y }, fit: { shape, width, height, bend: num('bend', -100, 100, f.bend), gap: num('gap', -1000, 10000, f.gap), autoLines: fieldChecked(form, 'autoLines') } };
  };
  const apply = (d: TextLayerData) => {
    if (session) updateData(e, () => d, 'fit-options');
    else e.preview(previewData(e, id, d));
  };
  const mark = session ? editMark() : undefined;
  const sync = (form: HTMLFormElement) => {
    const block = fieldValue(form, 'shape') === 'block';
    for (const el of form.querySelectorAll<HTMLElement>('[data-for]')) el.hidden = (el.dataset.for === 'block') !== block;
    const o = form.querySelector<HTMLOutputElement>('output');
    const b = form.querySelector<HTMLInputElement>('[name=bend]');
    if (o && b) o.value = `${b.value}%`;
  };
  const result = await modal({
    title: 'Dynamic Text Options',
    submit: 'OK',
    className: 'type-path-options',
    body,
    bind: (dialog) => {
      const form = dialog.querySelector('form')!;
      sync(form);
      form.addEventListener('input', () => {
        sync(form);
        apply(read(form));
      });
    },
  });
  if (!result) {
    if (mark) revertToMark(e, mark);
    if (!session) e.preview(e.doc);
    return;
  }
  const next = read(result.form);
  result.close();
  if (session) return;
  e.preview(e.doc);
  await editLayers(e, 'Dynamic Text Options', () => next, [id]);
}

// ------------------------------------------------------------ options dialog

function currentPathData(e: Editor, which: 'path' | 'block' | 'fit' = 'path'): { data: TextLayerData; id: string } | undefined {
  const has = (d: TextLayerData) => (which === 'path' ? !!d.path : which === 'fit' ? !!d.fit : !!d.block && !d.path);
  if (session && !session.mask) return has(session.data) ? { data: session.data, id: session.layerId } : undefined;
  const l = e.layer;
  if (l?.kind !== 'text' || e.selectedIds.size !== 1) return;
  const t = editable(l, ppiOf(e));
  return has(t.textData) ? { data: t.textData, id: l.id } : undefined;
}

// Width of the block and the space between its lines, previewed live.
async function blockOptions(e: Editor) {
  const cur = currentPathData(e, 'block');
  if (!cur) return;
  const { data, id } = cur;
  if (!session && layerLock(e.doc.layers, id, 'all')) return e.message('Unlock this layer to change its block.');
  const b = data.block!;
  const body = `<label class="dialog-field">Width (px)<input name="width" type="number" min="8" max="100000" step="1" value="${Math.round(b.width)}"></label>
       <label class="dialog-field">Space between lines (px)<input name="gap" type="number" min="-1000" max="10000" step="1" value="${Math.round(b.gap)}"></label>
       <p class="muted">Every line is scaled to this width.</p>`;
  const read = (form: HTMLFormElement): TextLayerData => {
    const num = (k: string, lo: number, hi: number, dflt: number) => {
      const v = Number(fieldValue(form, k));
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
    };
    return { ...data, block: { width: num('width', 8, 100000, b.width), gap: num('gap', -1000, 10000, b.gap) } };
  };
  const apply = (d: TextLayerData) => {
    if (session) updateData(e, () => d, 'block-options');
    else e.preview(previewData(e, id, d));
  };
  const mark = session ? editMark() : undefined;
  const result = await modal({
    title: 'Block Text Options',
    submit: 'OK',
    className: 'type-path-options',
    body,
    bind: (dialog) => {
      const form = dialog.querySelector('form')!;
      form.addEventListener('input', () => apply(read(form)));
    },
  });
  if (!result) {
    // Cancelled while editing: the preview goes, and leaves no undo step.
    if (mark) revertToMark(e, mark);
    if (!session) e.preview(e.doc);
    return;
  }
  const next = read(result.form);
  result.close();
  if (session) return;
  e.preview(e.doc);
  await editLayers(e, 'Block Text Options', () => next, [id]);
}

async function pathOptions(e: Editor) {
  if (!currentPathData(e) && currentPathData(e, 'block')) return blockOptions(e);
  const cur = currentPathData(e);
  if (!cur) return;
  const { data, id } = cur;
  if (!session && layerLock(e.doc.layers, id, 'all')) return e.message('Unlock this layer to change its type path.');
  const p = data.path!;
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const area = p.kind === 'area';
  const arc = p.arc;
  const body = area
    ? `<label class="dialog-field">Inset (px)<input name="inset" type="number" min="0" max="1000" step="1" value="${Math.round(p.inset ?? 0)}"></label>
       <p class="muted">Lines keep this distance from the outline of the shape.</p>`
    : `${arc ? `<label class="dialog-field">Shape<select name="preset">${ARC_PRESETS.map(([v, l]) => `<option value="${v}" ${v === arc.preset ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
       <label class="dialog-field">Bend<span class="export-range"><input name="bend" type="range" min="-100" max="100" step="1" value="${arc.bend}"><output>${arc.bend}%</output></span></label>` : ''}
       <div class="type-path-range"><label class="dialog-field">Start (% of the path)<input name="start" type="number" min="0" max="100" step="0.1" value="${pct(p.start)}"></label>
       <label class="dialog-field">End (% of the path)<input name="end" type="number" min="0" max="100" step="0.1" value="${pct(p.end)}"></label></div>
       <label class="dialog-field checkbox-field">Flip to the other side<input name="flip" type="checkbox" ${p.flip ? 'checked' : ''}></label>`;
  const read = (form: HTMLFormElement): TextLayerData => {
    const num = (k: string, lo: number, hi: number, dflt: number) => {
      const v = Number(fieldValue(form, k));
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
    };
    if (area) return { ...data, path: { ...p, inset: num('inset', 0, 1000, 0) } };
    let next: TextLayerData = { ...data, path: { ...p, start: num('start', 0, 100, 0) / 100, end: num('end', 0, 100, 100) / 100, flip: fieldChecked(form, 'flip') } };
    if (arc) next = reshapeArc(next, fieldValue(form, 'preset') as ArcPreset, num('bend', -100, 100, arc.bend));
    return next;
  };
  const apply = (d: TextLayerData) => {
    if (session) updateData(e, () => d, 'path-options');
    else e.preview(previewData(e, id, d));
  };
  const mark = session ? editMark() : undefined;
  const result = await modal({
    title: area ? 'Area Type Options' : 'Path Type Options',
    submit: 'OK',
    className: 'type-path-options',
    body,
    bind: (dialog) => {
      const form = dialog.querySelector('form')!;
      form.addEventListener('input', () => {
        const o = form.querySelector<HTMLOutputElement>('output');
        const b = form.querySelector<HTMLInputElement>('[name=bend]');
        if (o && b) o.value = `${b.value}%`;
        apply(read(form));
      });
    },
  });
  if (!result) {
    // Cancelled while editing: the preview goes, and leaves no undo step.
    if (mark) revertToMark(e, mark);
    if (!session) e.preview(e.doc);
    return;
  }
  const next = read(result.form);
  result.close();
  if (session) return;
  e.preview(e.doc);
  await editLayers(e, area ? 'Area Type Options' : 'Path Type Options', () => next, [id]);
}

// ------------------------------------------------------------ registration

export function installPathType(e: Editor) {
  textPathHooks.refit = (l) => refitText(l, ppiOf(e));
  selectHooks.push({
    down: (e, p) => {
      const l = pathTextLayer(e);
      if (!l || layerLock(e.doc.layers, l.id, 'all')) return false;
      const t = editable(l, ppiOf(e));
      const which = markerAt(e, t, p);
      if (!which) return false;
      drag = { id: l.id, which, data: t.textData, base: t.textData, moved: false };
      return true;
    },
    move: (e, p) => {
      const d = drag;
      if (!d) return;
      const l = findLayer(e.doc.layers, d.id);
      if (!l) return;
      d.moved = true;
      d.data = dragMarker(e, editable(l, ppiOf(e)), d, p);
      e.preview(previewData(e, d.id, d.data));
      e.overlay();
    },
    up: async (e) => {
      const d = drag;
      drag = undefined;
      if (d) await commitMarker(e, d);
      e.overlay();
    },
    hover: (e, p) => {
      const l = pathTextLayer(e);
      return l && markerAt(e, editable(l, ppiOf(e)), p) ? 'ew-resize' : undefined;
    },
  });

  const textTarget = () => {
    const l = e.layer;
    if (session && !session.mask) return session.data;
    return l?.kind === 'text' && e.selectedIds.size === 1 ? editable(l, ppiOf(e)).textData : undefined;
  };
  // Dynamic text: Type → Convert to Dynamic Text (earlier Convert to Arc Text).
  const fitTarget = () => {
    const d = textTarget();
    return d && d.orientation === 'horizontal' ? d : undefined;
  };
  for (const [shape, label] of FIT_LABELS) {
    renamedCommands.set(`type.arc-${shape}`, `type.fit-${shape}`);
    registerCommand({
      id: `type.fit-${shape}`,
      label,
      menu: 'type.fit',
      order: FIT_LABELS.findIndex(([s]) => s === shape),
      description: FIT_HELP[shape],
      enabled: () => !!fitTarget() || (!session && selectedTextLayersOf(e).some((l) => editable(l, ppiOf(e)).textData.orientation === 'horizontal')),
      checked: () => fitTarget()?.fit?.shape === shape,
      run: (e) => convertToFit(e, shape),
    });
  }
  registerCommand({
    id: 'type.release-fit',
    label: 'Release Fit',
    description: 'Turn dynamic text back into ordinary text that looks the same: block lines keep their sizes, curved text stays on its curve.',
    enabled: () => !!textTarget()?.fit || (!session && selectedFitLayers(e).length > 0),
    run: (e) => releaseFitText(e),
  });
  registerCommand({
    id: 'type.path-options',
    get label() {
      const d = textTarget();
      return d?.fit ? 'Dynamic Text Options…' : d?.path?.kind === 'area' ? 'Area Type Options…' : d?.block ? 'Block Text Options…' : 'Path Type Options…';
    },
    description: 'Start and end, flip, arc shape and bend of text on a path, the inset of area text, or the shape, box and line spacing of dynamic text.',
    enabled: (e) => !!currentPathData(e) || !!currentPathData(e, 'block') || !!currentPathData(e, 'fit'),
    run: (e) => (currentPathData(e, 'fit') ? fitOptions(e) : pathOptions(e)),
  });
  registerOverlay('type-path-markers', markersOverlay);
}
