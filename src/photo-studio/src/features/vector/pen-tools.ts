import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import type { VectorMask } from '../../model/vector';
import { vectorBounds } from '../../model/vector';
import { insertAboveSelection } from '../layers/insert';
import {
  anchor, autoSmooth, cloneMask, corner, deleteKnots, dist, fitPath, hitAnchor, hitHandle, insertKnot, maskToSvg,
  nearestSegment, reverseSubPath, smoothKnot, snap45, type KnotRef, type PathOp, type Pt,
} from './geometry';
import {
  activeKey, drawingTarget, nextName, selectKnots, shapeLayer, singleSelected, targetByKey, targetLocked, targetPath, vstate,
  type PathTarget,
} from './state';
import { commitPathEdit } from './masks';
import { anchorMarkup, setDraft } from './overlay';
import { previewEdit, endPreview } from './preview';
import { directDown, directMove, selectUp } from './select-tools';
export { previewEdit, endPreview };
import { buildPaint } from './paint';
import { shapeOpts } from './shape-options';
import { bindShapePaint, shapePaintControls } from './shape-tools';

export const penOpts = {
  mode: 'path' as 'path' | 'shape',
  op: 'combine' as 'new' | PathOp,
  autoAddDelete: true,
  rubberBand: true,
  curveFit: 2,
};

const tolerance = (e: Editor) => 6 / e.zoom;

// The open subpath the pen extends, by target key; `reverse` continues from its first anchor.
let drawing: { key: string; path: number; reverse?: boolean } | undefined;
type Drag = {
  target?: PathTarget; // undefined: a new shape layer is created on release
  mask: VectorMask;
  ref: KnotRef;
  start: Pt;
  moved: boolean;
  label: string;
  mode: 'place' | 'close' | 'outOnly' | 'move' | 'convert' | 'handle' | 'none';
  side?: 'in' | 'out';
  endDrawing?: boolean;
};
let drag: Drag | undefined;
let hover: Pt | undefined;
let freeform: { points: Pt[]; target?: PathTarget } | undefined;

function drawingRef(e: Editor) {
  if (!drawing) return;
  const t = targetByKey(e, drawing.key);
  if (!t || !t.mask.paths[drawing.path]?.open) {
    drawing = undefined;
    return;
  }
  return t;
}
/** Target that receives a new subpath (or undefined to create a shape layer). */
function newSubpathTarget(e: Editor): PathTarget | undefined {
  if (penOpts.mode === 'shape') {
    const l = singleSelected(e);
    if (l?.kind === 'vector' && penOpts.op !== 'new') return targetByKey(e, `layer:${l.id}`);
    return undefined;
  }
  return drawingTarget(e);
}
function startSubpath(e: Editor, pt: Pt, label?: string): Drag {
  const t = newSubpathTarget(e);
  const mask = t ? cloneMask(t.mask) : { paths: [] };
  const op: PathOp = penOpts.op === 'new' ? 'combine' : penOpts.op;
  mask.paths.push({ open: true, fillRule: 'non-zero', operation: op, knots: [corner(pt[0], pt[1])] });
  if (mask.paths.length === 1) mask.paths[0].operation = op === 'combine' ? 'combine' : op;
  return {
    target: t,
    mask,
    ref: { path: mask.paths.length - 1, knot: 0 },
    start: pt,
    moved: false,
    mode: 'place',
    label: label ?? (t ? (t.kind === 'work' && !t.mask.paths.length ? 'New Work Path' : 'Add Anchor Point') : 'Shape Layer'),
  };
}
async function commit(e: Editor, d: Drag) {
  setDraft(undefined, undefined);
  if (!d.target) {
    const b = vectorBounds(d.mask);
    const paint = buildPaint(e, shapeOpts.fill, shapeOpts.stroke, b, d.mask.paths.some((p) => p.open));
    const l = shapeLayer(e.doc, nextName(e.doc, 'Shape'), d.mask, paint.fill, paint.stroke, undefined, paint.color);
    insertAboveSelection(e, l, 'Pen Tool');
    drawing = d.endDrawing ? undefined : { key: `layer:${l.id}`, path: d.ref.path };
    const t = targetByKey(e, `layer:${l.id}`);
    if (t) selectKnots(e, t, [d.ref]);
    return;
  }
  if (targetLocked(e, d.target)) {
    endPreview(e);
    return;
  }
  await commitPathEdit(e, d.target, d.mask, d.label);
  const key = activeKey(d.target);
  const t = targetByKey(e, key);
  if (t) selectKnots(e, t, d.mask.paths[d.ref.path] ? [d.ref] : []);
  e.update();
}

// ----- Pen -----
// Mod temporarily switches the pen to direct selection; Alt over an existing
// anchor or handle converts it, as with the Convert Point tool.
let borrowed: 'direct' | undefined;
function penDown(e: Editor, p: CanvasPointer) {
  const tol = tolerance(e);
  borrowed = undefined;
  if (p.mod) {
    borrowed = 'direct';
    directDown(e, p);
    return;
  }
  if (p.alt && !drawingRef(e)) {
    convertPointTool.pointerDown!(e, p);
    if (drag) return;
  }
  // Tools → Snap vector tools to pixel grid places anchors on whole pixels.
  let pt: Pt = e.preferences.snapPixelGrid ? [Math.round(p.x), Math.round(p.y)] : [p.x, p.y];
  const ref = drawingRef(e);
  if (drawing && ref) {
    const mask = cloneMask(ref.mask);
    const sp = mask.paths[drawing.path];
    // Continuing from a first anchor reverses the subpath in this edit; the
    // flag clears once the edit commits (Escape keeps the original order).
    if (drawing.reverse) reverseSubPath(sp);
    const first = sp.knots[0], last = sp.knots[sp.knots.length - 1];
    if (sp.knots.length >= 2 && dist(anchor(first), pt) <= tol) {
      sp.open = false;
      drag = { target: ref, mask, ref: { path: drawing.path, knot: 0 }, start: anchor(first), moved: false, mode: 'close', label: 'Close Path', endDrawing: true };
      previewEdit(e, ref, mask);
      return;
    }
    if (dist(anchor(last), pt) <= tol) {
      // Clicking the last anchor removes its outgoing handle; dragging pulls a new one.
      last.points[4] = last.points[2];
      last.points[5] = last.points[3];
      last.linked = false;
      drag = { target: ref, mask, ref: { path: drawing.path, knot: sp.knots.length - 1 }, start: anchor(last), moved: false, mode: 'outOnly', label: 'Convert Point' };
      previewEdit(e, ref, mask);
      return;
    }
    if (p.shift) pt = snap45(anchor(last), pt);
    sp.knots.push(corner(pt[0], pt[1]));
    drag = { target: ref, mask, ref: { path: drawing.path, knot: sp.knots.length - 1 }, start: pt, moved: false, mode: 'place', label: 'Add Anchor Point' };
    previewEdit(e, ref, mask);
    return;
  }
  drawing = undefined;
  const t = targetPath(e);
  if (t) {
    const a = hitAnchor(t.mask, pt[0], pt[1], tol);
    if (a) {
      const sp = t.mask.paths[a.path];
      if (sp.open && (a.knot === sp.knots.length - 1 || a.knot === 0)) {
        drawing = { key: activeKey(t), path: a.path, reverse: a.knot === 0 && sp.knots.length > 1 };
        selectKnots(e, t, [a]);
        e.overlay();
        return;
      }
      if (penOpts.autoAddDelete) {
        const mask = deleteKnots(cloneMask(t.mask), [a]);
        drag = { target: t, mask, ref: a, start: pt, moved: false, mode: 'none', label: 'Delete Anchor Point' };
        return;
      }
    }
    const s = nearestSegment(t.mask, pt[0], pt[1]);
    if (penOpts.autoAddDelete && s && s.distance <= tol) {
      const mask = cloneMask(t.mask);
      const k = insertKnot(mask.paths[s.path], s.segment, s.t);
      drag = { target: t, mask, ref: { path: s.path, knot: k }, start: s.point, moved: false, mode: 'move', label: 'Add Anchor Point' };
      previewEdit(e, t, mask);
      return;
    }
  }
  drag = startSubpath(e, pt);
  previewEdit(e, drag.target, drag.mask);
}
function placeHandles(d: Drag, p: CanvasPointer) {
  const k = d.mask.paths[d.ref.path].knots[d.ref.knot];
  const a = anchor(k);
  let h: Pt = [p.x, p.y];
  if (p.shift) h = snap45(a, h);
  const mirror: Pt = [2 * a[0] - h[0], 2 * a[1] - h[1]];
  if (d.mode === 'close') {
    k.points[0] = mirror[0];
    k.points[1] = mirror[1];
    if (!p.alt) {
      k.points[4] = h[0];
      k.points[5] = h[1];
    }
  } else if (d.mode === 'outOnly' || p.alt) {
    k.points[4] = h[0];
    k.points[5] = h[1];
  } else {
    k.points[4] = h[0];
    k.points[5] = h[1];
    k.points[0] = mirror[0];
    k.points[1] = mirror[1];
  }
  k.linked = smoothKnot(k);
}
function moveKnot(d: Drag, p: CanvasPointer) {
  const k = d.mask.paths[d.ref.path].knots[d.ref.knot];
  const dx = p.x - k.points[2], dy = p.y - k.points[3];
  for (let i = 0; i < 6; i += 2) (k.points[i] += dx), (k.points[i + 1] += dy);
}
function dragMove(e: Editor, p: CanvasPointer) {
  const d = drag;
  if (!d) return;
  const [sx, sy] = e.clientPoint(d.start[0], d.start[1]);
  if (!d.moved && Math.hypot(p.clientX - sx, p.clientY - sy) < 3) return;
  d.moved = true;
  if (d.mode === 'place' || d.mode === 'close' || d.mode === 'outOnly') placeHandles(d, p);
  else if (d.mode === 'move') moveKnot(d, p);
  else if (d.mode === 'convert') {
    const k = d.mask.paths[d.ref.path].knots[d.ref.knot];
    const a = anchor(k);
    k.points[4] = p.x;
    k.points[5] = p.y;
    k.points[0] = 2 * a[0] - p.x;
    k.points[1] = 2 * a[1] - p.y;
    k.linked = true;
  } else if (d.mode === 'handle') {
    const k = d.mask.paths[d.ref.path].knots[d.ref.knot];
    const o = d.side === 'in' ? 0 : 4;
    k.points[o] = p.x;
    k.points[o + 1] = p.y;
    k.linked = false;
  } else return;
  previewEdit(e, d.target, d.mask);
}
async function dragUp(e: Editor) {
  const d = drag;
  drag = undefined;
  if (!d) return;
  if (d.mode === 'convert' && !d.moved) {
    const k = d.mask.paths[d.ref.path].knots[d.ref.knot];
    k.points[0] = k.points[4] = k.points[2];
    k.points[1] = k.points[5] = k.points[3];
    k.linked = false;
  }
  await commit(e, d);
  if (drawing) drawing.reverse = false;
  if (d.mode === 'place' && !d.endDrawing) {
    const key = d.target ? activeKey(d.target) : drawing?.key;
    if (key) drawing = { key, path: d.ref.path };
  }
  if (d.mode === 'close') drawing = undefined;
  e.overlay();
}
function penOptions(_e: Editor, extra = '') {
  const o = penOpts;
  const shape = o.mode === 'shape';
  // Shape mode sets the new layer's paint here; Path mode turns the drawn
  // path into a selection, a vector mask or a shape layer.
  const make = `<span class="vec-make" role="group" aria-label="Make from path">Make: <button type="button" data-command="path.make-selection-dialog" title="Make a selection from the path">Selection…</button><button type="button" data-command="layer.vmask-current-path" title="Add a vector mask to the layer from the path">Mask</button><button type="button" data-command="path.make-shape" title="Make a shape layer from the path">Shape</button></span>`;
  return `<label>Mode <select id="pen-mode" aria-label="Pen mode"><option value="path" ${!shape ? 'selected' : ''}>Path</option><option value="shape" ${shape ? 'selected' : ''}>Shape</option></select></label>${shape ? shapePaintControls(_e) : make}<label>Path <select id="pen-op" aria-label="Path operation">${([['new', shape ? 'New Layer' : 'New Path Area'], ['combine', 'Combine Shapes'], ['subtract', 'Subtract Front Shape'], ['intersect', 'Intersect Shape Areas'], ['exclude', 'Exclude Overlapping']] as const).map(([v, l]) => `<option value="${v}" ${o.op === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${extra}`;
}
function bindPenOptions(e: Editor, el: HTMLElement) {
  if (penOpts.mode === 'shape') bindShapePaint(e, el);
  el.querySelector<HTMLSelectElement>('#pen-mode')?.addEventListener('change', (ev) => {
    penOpts.mode = (ev.target as HTMLSelectElement).value as 'path' | 'shape';
    if (penOpts.mode === 'shape' && penOpts.op === 'combine') penOpts.op = 'new';
    drawing = undefined;
    e.options();
  });
  el.querySelector<HTMLSelectElement>('#pen-op')?.addEventListener('change', (ev) => (penOpts.op = (ev.target as HTMLSelectElement).value as typeof penOpts.op));
  el.querySelector<HTMLInputElement>('#pen-auto')?.addEventListener('change', (ev) => (penOpts.autoAddDelete = (ev.target as HTMLInputElement).checked));
  el.querySelector<HTMLInputElement>('#pen-rubber')?.addEventListener('change', (ev) => (penOpts.rubberBand = (ev.target as HTMLInputElement).checked));
  el.querySelector<HTMLInputElement>('#pen-fit')?.addEventListener('change', (ev) => (penOpts.curveFit = Math.max(0.5, Math.min(10, Number((ev.target as HTMLInputElement).value) || 2))));
}
function endDrawing(e: Editor) {
  drawing = undefined;
  hover = undefined;
  endPreview(e);
}
function drawingKeys(e: Editor, ev: KeyboardEvent) {
  if (drag) {
    if (ev.key === 'Escape') {
      drag = undefined;
      endPreview(e);
      return true;
    }
    return false;
  }
  if (!drawing) {
    // Never let Delete fall through to pixel clearing (which would rasterize a shape).
    if (ev.key !== 'Backspace' && ev.key !== 'Delete') return false;
    const t = targetPath(e);
    if (!t) return false;
    const st = vstate(e);
    if (st.knots.length && st.selectionKey === activeKey(t)) {
      const mask = deleteKnots(cloneMask(t.mask), st.knots);
      selectKnots(e, t, []);
      void commitPathEdit(e, t, mask, 'Delete Anchor Point').then(() => e.update());
    }
    return true;
  }
  if ((ev.key === 'Escape' || ev.key === 'Enter') && !ev.metaKey && !ev.ctrlKey) {
    endDrawing(e);
    return true;
  }
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    const t = drawingRef(e);
    if (!t) return false;
    const sp = t.mask.paths[drawing.path];
    const mask = deleteKnots(cloneMask(t.mask), [{ path: drawing.path, knot: drawing.reverse ? 0 : sp.knots.length - 1 }]);
    if (!mask.paths[drawing.path] || mask.paths.length < t.mask.paths.length) drawing = undefined;
    void commitPathEdit(e, t, mask, 'Delete Anchor Point').then(() => e.overlay());
    return true;
  }
  return false;
}
/** Rubber band: the next segment as it would be placed. */
function rubberBand(e: Editor) {
  if (!penOpts.rubberBand || drag || !hover) return '';
  const t = drawingRef(e);
  if (!t || !drawing) return '';
  const sp = t.mask.paths[drawing.path];
  const k = drawing.reverse ? sp.knots[0] : sp.knots[sp.knots.length - 1];
  const out = drawing.reverse ? [k.points[0], k.points[1]] : [k.points[4], k.points[5]];
  return `<path d="M${k.points[2]} ${k.points[3]}C${out[0]} ${out[1]} ${hover[0]} ${hover[1]} ${hover[0]} ${hover[1]}" class="vec-rubber" fill="none" stroke-width="${1 / e.zoom}"/>`;
}
function newLayerOverlay(e: Editor) {
  if (!drag || drag.target) return '';
  return `<path d="${maskToSvg(drag.mask)}" class="vec-path" fill="none" stroke-width="${1 / e.zoom}"/>${anchorMarkup(e, drag.mask, [drag.ref])}`;
}
export const penTool: Tool = {
  id: 'pen',
  label: 'Pen Tool',
  key: 'P',
  icon: 'pen-tool',
  group: 'pen',
  cursor: () => 'crosshair',
  options: (e) => penOptions(e, `<label class="transform-setting"><input id="pen-auto" type="checkbox" ${penOpts.autoAddDelete ? 'checked' : ''}>Auto Add/Delete</label><label class="transform-setting"><input id="pen-rubber" type="checkbox" ${penOpts.rubberBand ? 'checked' : ''}>Rubber Band</label>`),
  bindOptions: ({ e, el }) => bindPenOptions(e, el),
  deactivate: (e) => endDrawing(e),
  pointerDown: (e, p) => penDown(e, p),
  pointerMove: (e, p) => (borrowed === 'direct' ? directMove(e, p) : dragMove(e, p)),
  pointerUp: async (e, p) => {
    if (borrowed === 'direct') {
      borrowed = undefined;
      await selectUp(e, p);
      return;
    }
    await dragUp(e);
  },
  hover: (e, p) => {
    const t = drawingRef(e);
    let h: Pt = [p.x, p.y];
    if (t && drawing && p.shift) {
      const sp = t.mask.paths[drawing.path];
      h = snap45(anchor(drawing.reverse ? sp.knots[0] : sp.knots[sp.knots.length - 1]), h);
    }
    hover = h;
    if (t && penOpts.rubberBand) e.overlay();
  },
  keyDown: drawingKeys,
  overlay: (e) => rubberBand(e) + newLayerOverlay(e),
};

// ----- Freeform pen -----
export const freeformPenTool: Tool = {
  id: 'freeform-pen',
  label: 'Freeform Pen Tool',
  key: 'P',
  icon: 'pen-freeform',
  group: 'pen',
  cursor: () => 'crosshair',
  options: (e) => penOptions(e, `<label class="vec-num">Curve Fit <input id="pen-fit" type="number" min="0.5" max="10" step="0.5" value="${penOpts.curveFit}"> px</label>`),
  bindOptions: ({ e, el }) => bindPenOptions(e, el),
  pointerDown: (_e, p) => {
    freeform = { points: [[p.x, p.y]] };
  },
  pointerMove: (e, p) => {
    if (!freeform) return;
    for (const q of p.coalesced ?? [p]) freeform.points.push([q.x, q.y]);
    e.overlay();
  },
  pointerUp: async (e) => {
    const f = freeform;
    freeform = undefined;
    if (!f || f.points.length < 3) {
      e.overlay();
      return;
    }
    const first = f.points[0], last = f.points[f.points.length - 1];
    const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) * e.zoom < 10 && f.points.length > 8;
    const fitted = fitPath(f.points, penOpts.curveFit, closed, { spacing: Math.max(0.5, Math.min(2, 1.5 / e.zoom)) });
    if (!fitted) {
      e.overlay();
      return;
    }
    const d = startSubpath(e, first, 'Freeform Pen');
    const sp = d.mask.paths[d.ref.path];
    sp.knots = fitted.knots;
    sp.open = !closed;
    d.endDrawing = true;
    d.mode = 'none';
    await commit(e, d);
    e.overlay();
  },
  overlay: (e) => {
    if (!freeform) return '';
    const d = freeform.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join('');
    return `<path d="${d}" class="vec-rubber" fill="none" stroke-width="${1 / e.zoom}"/>`;
  },
};

// ----- Curvature pen -----
function curvatureDown(e: Editor, p: CanvasPointer) {
  const tol = tolerance(e);
  const pt: Pt = [p.x, p.y];
  const ref = drawingRef(e);
  if (drawing && ref) {
    const mask = cloneMask(ref.mask);
    const sp = mask.paths[drawing.path];
    // Continuing from a first anchor reverses the subpath in this edit; the
    // flag clears once the edit commits (Escape keeps the original order).
    if (drawing.reverse) reverseSubPath(sp);
    const hit = hitAnchor(mask, pt[0], pt[1], tol, new Set([drawing.path]));
    if (hit && hit.knot === 0 && sp.knots.length >= 2) {
      sp.open = false;
      autoSmooth(sp);
      drag = { target: ref, mask, ref: hit, start: pt, moved: false, mode: 'none', label: 'Close Path', endDrawing: true };
      previewEdit(e, ref, mask);
      return;
    }
    if (hit) {
      drag = { target: ref, mask, ref: hit, start: pt, moved: false, mode: 'move', label: 'Move Anchor Point' };
      return;
    }
    const k = corner(pt[0], pt[1]);
    k.linked = !p.alt;
    sp.knots.push(k);
    autoSmooth(sp);
    drag = { target: ref, mask, ref: { path: drawing.path, knot: sp.knots.length - 1 }, start: pt, moved: false, mode: 'move', label: 'Add Anchor Point' };
    previewEdit(e, ref, mask);
    return;
  }
  const t = targetPath(e);
  if (t) {
    const a = hitAnchor(t.mask, pt[0], pt[1], tol);
    if (a) {
      const sp = t.mask.paths[a.path];
      if (sp.open && (a.knot === 0 || a.knot === sp.knots.length - 1)) {
        drawing = { key: activeKey(t), path: a.path, reverse: a.knot === 0 && sp.knots.length > 1 };
        selectKnots(e, t, [a]);
        e.overlay();
        return;
      }
      drag = { target: t, mask: cloneMask(t.mask), ref: a, start: pt, moved: false, mode: 'move', label: 'Move Anchor Point' };
      return;
    }
  }
  drag = startSubpath(e, pt);
  drag.mask.paths[drag.ref.path].knots[0].linked = !p.alt;
  drag.mode = 'move';
  previewEdit(e, drag.target, drag.mask);
}
export const curvaturePenTool: Tool = {
  id: 'curvature-pen',
  label: 'Curvature Pen Tool',
  key: 'P',
  icon: 'pen-curvature',
  group: 'pen',
  cursor: () => 'crosshair',
  options: (e) => penOptions(e, `<span class="muted vec-hint">Click to add smooth points; Alt-click for a corner; double-click a point to toggle it.</span>`),
  bindOptions: ({ e, el }) => bindPenOptions(e, el),
  deactivate: (e) => endDrawing(e),
  pointerDown: (e, p) => curvatureDown(e, p),
  pointerMove: (e, p) => {
    const d = drag;
    if (!d || d.mode !== 'move') return;
    const [sx, sy] = e.clientPoint(d.start[0], d.start[1]);
    if (!d.moved && Math.hypot(p.clientX - sx, p.clientY - sy) < 3) return;
    d.moved = true;
    const sp = d.mask.paths[d.ref.path];
    const k = sp.knots[d.ref.knot];
    const dx = p.x - k.points[2], dy = p.y - k.points[3];
    for (let i = 0; i < 6; i += 2) (k.points[i] += dx), (k.points[i + 1] += dy);
    autoSmooth(sp);
    previewEdit(e, d.target, d.mask);
  },
  pointerUp: async (e) => {
    const d = drag;
    drag = undefined;
    if (!d) return;
    await commit(e, d);
    if (drawing) drawing.reverse = false;
    if (!d.endDrawing && d.label !== 'Move Anchor Point') {
      const key = d.target ? activeKey(d.target) : drawing?.key;
      if (key) drawing = { key, path: d.ref.path };
    }
    if (d.endDrawing) drawing = undefined;
    e.overlay();
  },
  doubleClick: async (e, p) => {
    const t = targetPath(e);
    if (!t) return;
    const a = hitAnchor(t.mask, p.x, p.y, tolerance(e));
    if (!a) return;
    const mask = cloneMask(t.mask);
    const sp = mask.paths[a.path], k = sp.knots[a.knot];
    if (k.linked) {
      k.linked = false;
      k.points[0] = k.points[4] = k.points[2];
      k.points[1] = k.points[5] = k.points[3];
    } else k.linked = true;
    autoSmooth(sp);
    await commitPathEdit(e, t, mask, 'Convert Point');
    e.overlay();
  },
  hover: (e, p) => {
    hover = [p.x, p.y];
    if (drawingRef(e)) e.overlay();
  },
  keyDown: drawingKeys,
  overlay: (e) => {
    // Preview the curve through the next point.
    if (drag || !hover || !drawing) return newLayerOverlay(e);
    const t = drawingRef(e);
    if (!t) return '';
    const mask = cloneMask(t.mask);
    const sp = mask.paths[drawing.path];
    if (drawing.reverse) reverseSubPath(sp);
    const k = corner(hover[0], hover[1]);
    k.linked = true;
    sp.knots.push(k);
    autoSmooth(sp);
    const last = sp.knots.length - 1, a = sp.knots[last - 1].points, b = sp.knots[last].points;
    return `<path d="M${a[2]} ${a[3]}C${a[4]} ${a[5]} ${b[0]} ${b[1]} ${b[2]} ${b[3]}" class="vec-rubber" fill="none" stroke-width="${1 / e.zoom}"/>`;
  },
};

// ----- Add, delete and convert anchor points -----
export const addAnchorTool: Tool = {
  id: 'add-anchor',
  label: 'Add Anchor Point Tool',
  icon: 'anchor-add',
  group: 'pen',
  cursor: () => 'crosshair',
  pointerDown: (e, p) => {
    const t = targetPath(e);
    if (!t) return;
    const s = nearestSegment(t.mask, p.x, p.y);
    if (!s || s.distance > tolerance(e)) return;
    const mask = cloneMask(t.mask);
    const k = insertKnot(mask.paths[s.path], s.segment, s.t);
    drag = { target: t, mask, ref: { path: s.path, knot: k }, start: s.point, moved: false, mode: 'move', label: 'Add Anchor Point' };
    previewEdit(e, t, mask);
  },
  pointerMove: dragMove,
  pointerUp: dragUp,
};
export const deleteAnchorTool: Tool = {
  id: 'delete-anchor',
  label: 'Delete Anchor Point Tool',
  icon: 'anchor-delete',
  group: 'pen',
  cursor: () => 'crosshair',
  pointerDown: async (e, p) => {
    const t = targetPath(e);
    if (!t) return;
    const a = hitAnchor(t.mask, p.x, p.y, tolerance(e));
    if (!a) return;
    const mask = deleteKnots(cloneMask(t.mask), [a]);
    await commitPathEdit(e, t, mask, 'Delete Anchor Point');
    e.overlay();
  },
};
export const convertPointTool: Tool = {
  id: 'convert-point',
  label: 'Convert Point Tool',
  icon: 'anchor-convert',
  group: 'pen',
  cursor: () => 'default',
  pointerDown: (e, p) => {
    const t = targetPath(e);
    if (!t) return;
    const tol = tolerance(e);
    const all: KnotRef[] = t.mask.paths.flatMap((sp, pi) => sp.knots.map((_, ki) => ({ path: pi, knot: ki })));
    const h = hitHandle(t.mask, p.x, p.y, tol, all);
    const mask = cloneMask(t.mask);
    if (h) {
      drag = { target: t, mask, ref: h, side: h.side, start: [p.x, p.y], moved: false, mode: 'handle', label: 'Convert Point' };
      return;
    }
    const a = hitAnchor(t.mask, p.x, p.y, tol);
    if (!a) return;
    drag = { target: t, mask, ref: a, start: [p.x, p.y], moved: false, mode: 'convert', label: 'Convert Point' };
  },
  pointerMove: dragMove,
  pointerUp: dragUp,
};
/** Exposed for tests and commands. */
export const penState = {
  get drawing() {
    return drawing;
  },
  reset() {
    drawing = undefined;
    drag = undefined;
  },
};
