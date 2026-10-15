// Circle and lasso selection in the 3D viewport: the Select Circle / Select Lasso tools, the
// C (circle select) modal, and Ctrl+right-drag lasso (Ctrl+right-click stays "extrude to cursor").
import { app, registerOperators } from '../../app/app';
import { uiState, activeTools } from '../../app/prefs';
import { addKeys } from '../../app/keymap';
import { editModeHooks, type SelectRegion } from './hooks';
import type { View3D } from './view3d';
import { activeView3D } from './view3d';

export type SelectMode = 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR';

export function inSelectRegion(r: SelectRegion, x: number, y: number) {
  if (r.kind === 'box') return x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1);
  if (r.kind === 'circle') return Math.hypot(x - r.x, y - r.y) <= r.r;
  let c = false;
  const p = r.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) c = !c;
  return c;
}

function bounds(r: SelectRegion): [number, number, number, number] {
  if (r.kind === 'box') return [r.x0, r.y0, r.x1, r.y1];
  if (r.kind === 'circle') return [r.x - r.r, r.y - r.r, r.x + r.r, r.y + r.r];
  const xs = r.pts.map((p) => p.x),
    ys = r.pts.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Select with an arbitrary region: edit modes handle it through hooks, object mode via the ID buffer. */
export function selectInRegion(v: View3D, r: SelectRegion, mode: SelectMode, label: string) {
  for (const hk of editModeHooks.region) if (hk(v, r, mode)) return;
  const [x0, y0, x1, y1] = bounds(r);
  if (app.doc.mode !== 'OBJECT') {
    // modes without shaped selection fall back to the region's bounding box
    for (const hk of editModeHooks.box) if (hk(v, x0, y0, x1, y1, mode)) return;
    return;
  }
  const inside = new Set(v.idsInRect(x0, y0, x1, y1, (x, y) => inSelectRegion(r, x, y)).keys());
  const doc = app.doc;
  for (const ob of Object.values(doc.objects)) {
    if (!app.isSelectable(ob.id)) continue;
    const isIn = inside.has(ob.id);
    if (mode === 'SET') ob.select = isIn;
    else if (mode === 'ADD') ob.select = ob.select || isIn;
    else if (mode === 'SUB') ob.select = ob.select && !isIn;
    else if (mode === 'AND') ob.select = ob.select && isIn;
    else ob.select = ob.select !== isIn;
  }
  const act = doc.scene.active_object ? doc.objects[doc.scene.active_object] : null;
  if ((!act || !act.select) && mode !== 'SUB') {
    const first = [...inside][0];
    if (first) doc.scene.active_object = first;
  }
  app.pushUndo(label);
  app.changed('select', 'doc');
}

/** Mode from modifier keys (Shift extend, Ctrl subtract) on top of the tool-header mode. */
export function modeFromEvent(e: { shiftKey: boolean; ctrlKey: boolean }, base: SelectMode = uiState.selectMode): SelectMode {
  return e.shiftKey && e.ctrlKey ? 'AND' : e.shiftKey ? 'ADD' : e.ctrlKey ? 'SUB' : base;
}

// ---------------------------------------------------------------------------
// overlay (lasso path / circle cursor)

function overlay(v: View3D) {
  let el = v.el.querySelector<SVGSVGElement>(':scope > svg.select-shape');
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.classList.add('select-shape');
    el.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:5');
    v.el.append(el);
  }
  return el;
}

function drawLasso(v: View3D, pts: { x: number; y: number }[] | null) {
  const el = overlay(v);
  el.innerHTML = pts && pts.length > 1 ? `<polygon points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="rgba(255, 255, 255,0.06)" stroke="#ffffff" stroke-width="1" stroke-dasharray="4 3"/>` : '';
}

function drawCircle(v: View3D, c: { x: number; y: number } | null, r: number) {
  const el = overlay(v);
  el.innerHTML = c ? `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="none" stroke="#ffffff" stroke-width="1" stroke-dasharray="4 3"/>` : '';
}

const local = (v: View3D, e: { clientX: number; clientY: number }) => {
  const r = v.el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

/** Lasso drag starting at a pointer event; selects on release. */
export function lassoDrag(v: View3D, e: PointerEvent, mode: SelectMode) {
  const pts = [local(v, e)];
  const move = (ev: PointerEvent) => {
    const p = local(v, ev);
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 2) pts.push(p);
    drawLasso(v, pts);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    drawLasso(v, null);
    if (pts.length >= 3) selectInRegion(v, { kind: 'lasso', pts }, mode, 'Lasso Select');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** Circle painting: every step selects (or deselects) what is under the brush. */
export function circlePaint(v: View3D, e: PointerEvent, mode: SelectMode) {
  const r = uiState.circleRadius ?? 25;
  let first = true;
  const step = (ev: { clientX: number; clientY: number }) => {
    const p = local(v, ev);
    drawCircle(v, p, r);
    selectInRegion(v, { kind: 'circle', x: p.x, y: p.y, r }, first ? mode : mode === 'SUB' ? 'SUB' : 'ADD', 'Circle Select');
    first = false;
  };
  step(e);
  const move = (ev: PointerEvent) => step(ev);
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    drawCircle(v, local(v, ev), r);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/** Circle cursor while hovering with the circle tool. */
export function hoverCircle(v: View3D, e: PointerEvent | null) {
  drawCircle(v, e ? local(v, e) : null, uiState.circleRadius ?? 25);
}

registerOperators([
  {
    idname: 'view3d.select_circle',
    label: 'Circle Select',
    description: 'Select items using circle selection (LMB select, MMB or Shift deselect, wheel resizes, Esc/RMB/Enter finishes)',
    poll: () => !!activeView3D(),
    invoke: () => {
      const v = activeView3D()!;
      let pos = local(v, { clientX: app.pointer.x, clientY: app.pointer.y });
      let painting: SelectMode | null = null;
      const radius = () => uiState.circleRadius ?? 25;
      const apply = () => {
        if (painting) selectInRegion(v, { kind: 'circle', x: pos.x, y: pos.y, r: radius() }, painting, 'Circle Select');
      };
      drawCircle(v, pos, radius());
      app.startModal({
        label: 'Circle Select',
        header: () => 'Circle Select: LMB select · Shift/MMB deselect · Wheel / +- resize · RMB/Esc/Enter finish',
        onPointerMove(e) {
          pos = local(v, e);
          drawCircle(v, pos, radius());
          apply();
        },
        onPointerDown(e) {
          if (e.button === 2) return 'FINISHED';
          painting = e.button === 1 || e.shiftKey || e.ctrlKey ? 'SUB' : 'ADD';
          apply();
        },
        onPointerUp() {
          painting = null;
        },
        onWheel(e) {
          uiState.circleRadius = Math.max(2, Math.min(500, radius() * (e.deltaY > 0 ? 1 / 1.15 : 1.15)));
          drawCircle(v, pos, radius());
        },
        onKey(e) {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape' || e.key === 'Enter') return 'FINISHED';
          if (e.key === '+' || e.key === '=') uiState.circleRadius = Math.min(500, radius() * 1.15);
          if (e.key === '-') uiState.circleRadius = Math.max(2, radius() / 1.15);
          drawCircle(v, pos, radius());
          return true;
        },
        cancel() {
          drawCircle(v, null, 0);
        },
        finish() {
          drawCircle(v, null, 0);
        },
      });
      return 'RUNNING_MODAL';
    },
    undo: false,
  },
]);

addKeys('3D View', [{ key: 'C', op: 'view3d.select_circle', when: () => app.doc.mode === 'OBJECT' || app.doc.mode === 'EDIT' || app.doc.mode === 'POSE' }]);

// show the brush circle while hovering with the Select Circle tool
editModeHooks.hover.push((v, e) => {
  if (app.modal) return;
  hoverCircle(v, activeTools[app.doc.mode] === 'builtin.select_circle' ? e : null);
});
