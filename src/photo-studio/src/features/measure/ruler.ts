// Ruler tool: drag to measure a distance and angle; drag an end to adjust,
// drag the line to move it, Alt-drag from an end to add a second line and
// read the angle between them (protractor). Shift snaps to 45°. The line
// stays until cleared and can level the image (Straighten).
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import { registerOverlay, registerTool } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { distance, levelingRotation, round, rulerMetrics, scaledLength, snapAngle, type Point, type RulerLine } from '../../imaging/measure/geometry';
import { about, compose, inscribedSize, rotateM, translate } from '../transform/math';
import { applyMat3, type Mat3 } from '../../imaging/filters/warp';
import { annotationsOf, lengthText, px, rulerLine, setRulerLine } from './state';

type Drag = { mode: 'new' | 'a' | 'b' | 'c' | 'move' | 'protractor'; start: Point; line: RulerLine };
let drag: Drag | undefined;
// The ruler line before and after each straighten, so undo and redo put the
// line back over the content it measured.
const linesByState = new WeakMap<PhotoDocument, RulerLine>();

/** Measured values as display strings, in ruler units or the measurement scale. */
export function rulerReadout(e: Editor, r: RulerLine | undefined = rulerLine(e)) {
  if (!r) return undefined;
  const m = rulerMetrics(r);
  const useScale = !!e.settings.rulerUseScale && !!annotationsOf(e.doc).scale;
  const scale = annotationsOf(e.doc).scale;
  const len = (v: number, axis: 'x' | 'y' = 'x') => (useScale ? round(scaledLength(v, scale), 2) : lengthText(e, v, axis));
  return {
    metrics: m,
    x: lengthText(e, m.x, 'x'),
    y: lengthText(e, m.y, 'y'),
    w: len(Math.abs(m.dx), 'x'),
    h: len(Math.abs(m.dy), 'y'),
    angle: `${round(m.angle, 1)}°`,
    l1: len(m.l1),
    l2: m.l2 === undefined ? '' : len(m.l2),
    unit: useScale ? scale!.units : undefined,
  };
}

function readoutHtml(e: Editor) {
  const r = rulerReadout(e, drag?.line ?? rulerLine(e));
  const cell = (label: string, v: string | undefined, title: string) => `<span class="ruler-value" title="${title}"><b>${label}</b><output>${escapeXML(v || '–')}</output></span>`;
  return `${cell('X', r?.x, 'Start point X')}${cell('Y', r?.y, 'Start point Y')}${cell('W', r?.w, 'Horizontal distance')}${cell('H', r?.h, 'Vertical distance')}${cell('A', r?.angle, r?.metrics.l2 !== undefined ? 'Angle between the lines' : 'Angle from horizontal')}${cell('L1', r?.l1, 'Length of the first line')}${cell('L2', r?.l2, 'Length of the second line')}`;
}
function refreshReadout(e: Editor) {
  const el = e.root.querySelector('#ruler-readout');
  if (el) el.innerHTML = readoutHtml(e);
  e.dock.update();
}

function hitEnd(e: Editor, r: RulerLine, p: Point): 'a' | 'b' | 'c' | undefined {
  const tol = px(e, 7);
  const ends = (['a', 'b', 'c'] as const).filter((k) => r[k] && distance(r[k]!, p) <= tol);
  return ends.sort((k1, k2) => distance(r[k1]!, p) - distance(r[k2]!, p))[0];
}
function nearSegment(a: Point, b: Point, p: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** Level the measured line: rotate the selected layers about its middle,
 * or (with crop) the whole image, cropped to the largest upright rectangle. */
export async function straighten(e: Editor, crop: boolean) {
  const r = rulerLine(e);
  if (!r) {
    e.message('Drag with the Ruler tool along a line that should be level or upright.');
    return;
  }
  const deg = levelingRotation(r.a, r.b);
  if (Math.abs(deg) < 1e-6) {
    e.message('The measured line is already level.');
    return;
  }
  // Canvas and layer rotation load with the first straighten.
  const { rotateLayers, transformCanvasBy } = await import('../transform/layer-ops');
  const before = e.doc;
  let m: Mat3;
  if (crop) {
    const W = e.doc.width,
      H = e.doc.height;
    const fit = inscribedSize(W, H, deg);
    const nw = Math.max(1, Math.floor(fit.width + 1e-6)),
      nh = Math.max(1, Math.floor(fit.height + 1e-6));
    m = compose(translate(nw / 2, nh / 2), rotateM(deg), translate(-W / 2, -H / 2));
    await transformCanvasBy(e, 'Straighten', m, nw, nh, { trim: true });
  } else {
    const cx = (r.a.x + r.b.x) / 2,
      cy = (r.a.y + r.b.y) / 2;
    m = about(rotateM(deg), cx, cy);
    if (!(await rotateLayers(e, 'Straighten Layer', deg, cx, cy))) return;
  }
  // The line now lies level over the straightened content.
  const map = (q: Point) => applyMat3(m, q.x, q.y);
  const level = { a: map(r.a), b: map(r.b), ...(r.c ? { c: map(r.c) } : {}) };
  if (e.doc !== before) {
    linesByState.set(before, r);
    linesByState.set(e.doc, level);
  }
  setRulerLine(e, level);
  e.update();
}

export function clearRuler(e: Editor) {
  setRulerLine(e, undefined);
  e.overlay();
  refreshReadout(e);
}

function lineMarkup(e: Editor, r: RulerLine) {
  const w = px(e, 1);
  const tick = (q: Point) => `M${q.x - px(e, 4)} ${q.y}H${q.x + px(e, 4)}M${q.x} ${q.y - px(e, 4)}V${q.y + px(e, 4)}`;
  let d = `M${r.a.x} ${r.a.y}L${r.b.x} ${r.b.y}${tick(r.a)}${tick(r.b)}`;
  if (r.c) d += `M${r.a.x} ${r.a.y}L${r.c.x} ${r.c.y}${tick(r.c)}`;
  let arc = '';
  if (r.c) {
    // Arc between the two lines at the vertex.
    const rad = Math.min(px(e, 26), distance(r.a, r.b) / 2, distance(r.a, r.c) / 2);
    const a1 = Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x),
      a2 = Math.atan2(r.c.y - r.a.y, r.c.x - r.a.x);
    let delta = a2 - a1;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const p1 = { x: r.a.x + Math.cos(a1) * rad, y: r.a.y + Math.sin(a1) * rad },
      p2 = { x: r.a.x + Math.cos(a1 + delta) * rad, y: r.a.y + Math.sin(a1 + delta) * rad };
    arc = `M${p1.x} ${p1.y}A${rad} ${rad} 0 0 ${delta > 0 ? 1 : 0} ${p2.x} ${p2.y}`;
  }
  return `<g class="ruler-line"><path d="${d}${arc}" class="halo" stroke-width="${w * 3}"/><path d="${d}${arc}" stroke-width="${w}"/></g>`;
}

export function installRuler(e: Editor) {
  let shown: PhotoDocument | undefined;
  e.onUpdate((e) => {
    if (e.doc === shown) return;
    shown = e.doc;
    const line = linesByState.get(e.doc);
    if (line && line !== rulerLine(e)) {
      setRulerLine(e, line);
      e.overlay();
      if (e.tool === 'ruler') refreshReadout(e);
    }
  });
  registerOverlay('ruler-line', (e) => {
    const r = drag?.line ?? rulerLine(e);
    // The measurement stays visible with every tool, like other extras.
    if (!r || !e.hasDocument || e.settings.extrasHidden) return '';
    return lineMarkup(e, r);
  });
  registerTool({
    id: 'ruler',
    label: 'Ruler Tool',
    key: 'I',
    icon: 'ruler',
    group: 'eyedropper',
    cursor: () => 'crosshair',
    options: (e) => {
      const has = !!rulerLine(e);
      const scale = annotationsOf(e.doc).scale;
      return `<span id="ruler-readout" class="ruler-readout">${readoutHtml(e)}</span><span class="divider"></span><label title="${scale ? `Report lengths in ${escapeXML(scale.units)}` : 'Set a measurement scale under Image › Analysis first'}"><input type="checkbox" id="ruler-use-scale" ${e.settings.rulerUseScale && scale ? 'checked' : ''} ${scale ? '' : 'disabled'}>Use Measurement Scale</label><button data-ruler-action="straighten" ${has ? '' : 'disabled'} title="Rotate so the measured line becomes level (or upright)">${svg('rotate-cw', 14)} Straighten Layer</button><label title="Rotate the whole image and crop away the empty corners"><input type="checkbox" id="ruler-crop" ${e.settings.rulerCrop !== false ? 'checked' : ''}>Crop</label><button data-ruler-action="clear" ${has ? '' : 'disabled'}>Clear</button>`;
    },
    bindOptions: ({ e, el }) => {
      el.querySelector<HTMLInputElement>('#ruler-use-scale')?.addEventListener('change', (ev) => {
        e.settings.rulerUseScale = (ev.target as HTMLInputElement).checked;
        refreshReadout(e);
      });
      el.querySelector<HTMLInputElement>('#ruler-crop')?.addEventListener('change', (ev) => (e.settings.rulerCrop = (ev.target as HTMLInputElement).checked));
      el.querySelectorAll<HTMLButtonElement>('[data-ruler-action]').forEach((b) =>
        b.addEventListener('click', () => {
          if (b.dataset.rulerAction === 'clear') {
            clearRuler(e);
            e.options();
          } else void e.run(() => straighten(e, e.settings.rulerCrop !== false));
        }),
      );
    },
    pointerDown: (e, p) => {
      const at = { x: p.x, y: p.y };
      const r = rulerLine(e);
      const end = r && hitEnd(e, r, at);
      if (r && end && p.alt && !r.c && end !== 'c') {
        // Second line from this end: the end becomes the shared vertex.
        const vertex = r[end],
          other = end === 'a' ? r.b : r.a;
        drag = { mode: 'protractor', start: at, line: { a: vertex, b: other, c: at } };
      } else if (r && end) drag = { mode: end, start: at, line: { ...r } };
      else if (r && (nearSegment(r.a, r.b, at) <= px(e, 4) || (r.c && nearSegment(r.a, r.c, at) <= px(e, 4)))) drag = { mode: 'move', start: at, line: { ...r } };
      else drag = { mode: 'new', start: at, line: { a: at, b: at } };
      e.overlay();
    },
    pointerMove: (e, p) => {
      if (!drag) return;
      let at = { x: p.x, y: p.y };
      const l = drag.line;
      const base = rulerLine(e);
      if (drag.mode === 'move' && base) {
        const dx = at.x - drag.start.x,
          dy = at.y - drag.start.y;
        const shift = (q: Point) => ({ x: q.x + dx, y: q.y + dy });
        drag.line = { a: shift(base.a), b: shift(base.b), ...(base.c ? { c: shift(base.c) } : {}) };
      } else {
        const key = drag.mode === 'new' ? 'b' : drag.mode === 'protractor' ? 'c' : drag.mode;
        // Shift snaps the moving end around the opposite (or shared) point.
        const anchor = key === 'a' ? l.b : l.a;
        if (p.shift) at = snapAngle(anchor, at);
        drag.line = { ...l, [key]: at };
      }
      e.overlay();
      refreshReadout(e);
    },
    pointerUp: (e) => {
      const d = drag;
      drag = undefined;
      if (!d) return;
      if (d.mode === 'new' && distance(d.line.a, d.line.b) < px(e, 2)) setRulerLine(e, undefined);
      else if (d.mode === 'protractor' && distance(d.line.a, d.line.c!) < px(e, 2)) setRulerLine(e, { a: d.line.a, b: d.line.b });
      else setRulerLine(e, d.line);
      e.options();
      e.overlay();
      e.dock.update();
    },
    keyDown: (e, ev) => {
      // Escape during a drag keeps the line from before it.
      if (ev.key === 'Escape' && drag) {
        drag = undefined;
        e.overlay();
        refreshReadout(e);
        return true;
      }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && rulerLine(e)) {
        clearRuler(e);
        e.options();
        return true;
      }
      return false;
    },
  });
}
