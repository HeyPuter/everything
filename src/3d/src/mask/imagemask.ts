// Mask editing in the Image Editor (Mask mode): the tools of its toolbar, their pointer handling,
// the tool header and the 2D cursor. Drawing and point interaction are shared with the clip
// editor's mask mode (clipmask.ts); the mask.* operators find the editor through maskEditor().
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { app } from '../app/app';
import { openMenu, type MenuItem } from '../ui/menu';
import { numberField } from '../ui/widgets';
import { hostMask, maskPointerDown, lassoSelect, circleSelectDrag, hitMask, deselectAll, s2m, type MaskHost } from './clipmask';
import { startTransform } from './maskops';
import { activeLayer } from './types';

registerIcons({
  mask_square: '<rect class="s" x="3" y="3" width="10" height="10" fill="none" stroke-width="1.2"/><circle class="f" cx="3" cy="3" r="1.6"/><circle class="f" cx="13" cy="3" r="1.6"/><circle class="f" cx="13" cy="13" r="1.6"/><circle class="f" cx="3" cy="13" r="1.6"/>',
  mask_circle: '<circle class="s" cx="8" cy="8" r="5.2" fill="none" stroke-width="1.2"/><circle class="f" cx="8" cy="2.8" r="1.6"/><circle class="f" cx="13.2" cy="8" r="1.6"/><circle class="f" cx="8" cy="13.2" r="1.6"/><circle class="f" cx="2.8" cy="8" r="1.6"/>',
});

export type ImageMaskTool = 'select_box' | 'select_circle' | 'select_lasso' | 'cursor' | 'move' | 'rotate' | 'scale' | 'add_square' | 'add_circle';
export const IMAGE_MASK_TOOLS: ImageMaskTool[] = ['select_box', 'select_circle', 'select_lasso', 'cursor', 'move', 'rotate', 'scale', 'add_square', 'add_circle'];

/** What the image editor offers for mask editing. */
export interface ImageMaskHost extends MaskHost {
  maskTool: ImageMaskTool;
  cursor: [number, number];
  /** radius (screen px) of the Select Circle tool, size of new primitives (frame units) */
  maskCircleRadius: number;
  maskPrimitiveSize: number;
  redrawHeader(): void;
}

const SELECT = [
  { id: 'select_box', label: 'Select Box', icon: 'select_box', tip: 'Select points by clicking or dragging a box; drag points and handles to move them' },
  { id: 'select_circle', label: 'Select Circle', icon: 'select_circle', tip: 'Select points by painting over them with a circle (Ctrl deselects)' },
  { id: 'select_lasso', label: 'Select Lasso', icon: 'select_lasso', tip: 'Select points inside a drawn shape (Ctrl deselects)' },
] as const;

const TOOLS: { id: ImageMaskTool; label: string; icon: string; tip: string }[] = [
  { id: 'cursor', label: 'Cursor', icon: 'cursor', tip: 'Place the 2D cursor: new shapes go there and it can be the pivot point' },
  { id: 'move', label: 'Move', icon: 'transform_move', tip: 'Drag to move the selected points' },
  { id: 'rotate', label: 'Rotate', icon: 'transform_rotate', tip: 'Drag to rotate the selected points around the pivot' },
  { id: 'scale', label: 'Scale', icon: 'transform_scale', tip: 'Drag to scale the selected points around the pivot' },
  { id: 'add_square', label: 'Box', icon: 'mask_square', tip: 'Click to add a square spline' },
  { id: 'add_circle', label: 'Circle', icon: 'mask_circle', tip: 'Click to add a circular spline' },
];

export function maskToolLabel(t: ImageMaskTool) {
  return (SELECT.find((x) => x.id === t) ?? TOOLS.find((x) => x.id === t))!.label;
}

let lastSelect: ImageMaskTool = 'select_box';

/** Toolbar of the Mask mode (select variants share one slot; right click or a long press picks one). */
export function imageMaskToolbar(ed: ImageMaskHost): Child {
  const set = (t: ImageMaskTool) => {
    ed.maskTool = t;
    if (t.startsWith('select_')) lastSelect = t;
    ed.drawUI();
    ed.redrawHeader();
  };
  const isSel = ed.maskTool.startsWith('select_');
  const shown = SELECT.find((x) => x.id === (isSel ? ed.maskTool : lastSelect)) ?? SELECT[0];
  const pick = (el: HTMLElement) => openMenu(SELECT.map((x): MenuItem => ({ label: x.label, icon: x.icon, active: x.id === ed.maskTool, action: () => set(x.id) })), el);
  const btn = (t: (typeof TOOLS)[number]) =>
    h(
      'button',
      {
        key: t.id,
        class: { 'tb-tool': true, on: ed.maskTool === t.id },
        'data-tool': `mask-${t.id}`,
        'data-tip': `${t.label}\n${t.tip}`,
        onpointerdown: (e: PointerEvent) => (e.preventDefault(), set(t.id)),
      },
      icon(t.icon),
    );
  return h(
    'div',
    { key: 'ie-mask-toolbar', class: 'v3d-toolbar ie-toolbar' },
    h(
      'button',
      {
        key: 'select',
        class: { 'tb-tool': true, on: isSel, 'has-alt': true },
        'data-tool': `mask-${shown.id}`,
        'data-tip': `${shown.label}\n${shown.tip}`,
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          const el = e.currentTarget as HTMLElement;
          if (e.button === 2 || e.detail > 1) return pick(el);
          set(shown.id);
          const timer = setTimeout(() => pick(el), 350);
          const up = () => (clearTimeout(timer), removeEventListener('pointerup', up));
          addEventListener('pointerup', up);
        },
      },
      icon(shown.icon),
    ),
    btn(TOOLS[0]),
    h('div', { key: 'sep1', class: 'tb-sep' }),
    TOOLS.slice(1, 4).map(btn),
    h('div', { key: 'sep2', class: 'tb-sep' }),
    TOOLS.slice(4).map(btn),
  );
}

/** Settings of the active tool (tool header row and the sidebar's Tool tab). */
export function imageMaskToolSettings(ed: ImageMaskHost): Child[] {
  const t = ed.maskTool;
  const out: Child[] = [h('span', { key: 'name', class: 'ie-tool-name' }, icon(t.startsWith('select_') ? SELECT.find((x) => x.id === t)!.icon : TOOLS.find((x) => x.id === t)!.icon), maskToolLabel(t))];
  if (t === 'select_circle')
    out.push(h('span', { key: 'lbl', class: 'ie-tool-lbl' }, 'Radius'), h('div', { key: 'rad', class: 'ie-tool-field' }, numberField({ id: 'ie-mask-radius', value: ed.maskCircleRadius, int: true, min: 2, max: 400, unit: 'pixel', set: (v) => ((ed.maskCircleRadius = v), ed.drawUI()) })));
  if (t === 'add_square' || t === 'add_circle')
    out.push(h('span', { key: 'lbl', class: 'ie-tool-lbl' }, 'Size'), h('div', { key: 'size', class: 'ie-tool-field' }, numberField({ id: 'ie-mask-size', value: ed.maskPrimitiveSize, min: 0.001, max: 4, precision: 3, set: (v) => ((ed.maskPrimitiveSize = v), ed.drawUI()) })));
  return out;
}

/** Wait for a drag past a few pixels; `drag` gets the press position, `click` runs otherwise. */
function dragOrClick(e: PointerEvent, drag: (from: PointerEvent) => void, click?: () => void) {
  const x0 = e.clientX,
    y0 = e.clientY;
  const mv = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    end();
    drag(e);
  };
  const up = () => {
    end();
    click?.();
  };
  const end = () => {
    removeEventListener('pointermove', mv, true);
    removeEventListener('pointerup', up, true);
  };
  addEventListener('pointermove', mv, true);
  addEventListener('pointerup', up, true);
}

/** Set the 2D cursor under a screen point (editor-local pixels). */
export function placeCursor(ed: ImageMaskHost, x: number, y: number) {
  ed.cursor = s2m(ed, x, y);
  ed.draw();
  app.changed('ui');
}

/** Left button press in Mask mode, by tool. */
export function imageMaskPointerDown(ed: ImageMaskHost, e: PointerEvent) {
  const t = ed.maskTool;
  const p = ed.local(e);
  const ctrl = e.ctrlKey || e.metaKey;
  if (t === 'cursor') {
    placeCursor(ed, p.x, p.y);
    const mv = (ev: PointerEvent) => {
      const q = ed.local(ev);
      placeCursor(ed, q.x, q.y);
    };
    const up = () => (removeEventListener('pointermove', mv, true), removeEventListener('pointerup', up, true));
    addEventListener('pointermove', mv, true);
    addEventListener('pointerup', up, true);
    return;
  }
  if (t === 'add_square' || t === 'add_circle') {
    if (!hostMask(ed)) app.run('mask.new');
    const m = hostMask(ed);
    if (!m) return;
    if (!activeLayer(m)) app.run('mask.layer_new');
    const loc = s2m(ed, p.x, p.y);
    app.run(t === 'add_square' ? 'mask.primitive_square_add' : 'mask.primitive_circle_add', { size: ed.maskPrimitiveSize, location: loc }, { invoke: false });
    return;
  }
  const m = hostMask(ed);
  if (!m) {
    app.report('INFO', 'No mask to edit: add one with New in the header (Alt N)');
    return;
  }
  if (t === 'move' || t === 'rotate' || t === 'scale') {
    const hit = hitMask(ed, p.x, p.y);
    if (hit && hit.kind === 'point' && !hit.point.select) {
      if (!e.shiftKey) deselectAll(m);
      hit.point.select = true;
      ed.draw();
      ed.drawUI();
    }
    dragOrClick(
      e,
      (from) => {
        const mode = t === 'move' ? 'TRANSLATE' : t === 'rotate' ? 'ROTATE' : 'RESIZE';
        if (!startTransform(mode, true, from)) app.report('INFO', 'Select mask points to transform');
      },
      () => {
        if (!hit && !e.shiftKey) {
          deselectAll(m);
          ed.draw();
          ed.drawUI();
        }
        app.pushUndo('Select');
      },
    );
    return;
  }
  if (t === 'select_circle' || t === 'select_lasso') {
    const hit = hitMask(ed, p.x, p.y);
    // a press on a point or handle still grabs it; Ctrl click adds points as with the box tool
    if (hit && !ctrl && !e.shiftKey) return void maskPointerDown(ed, e);
    const mode = ctrl ? 'SUB' : e.shiftKey ? 'ADD' : 'SET';
    if (t === 'select_circle') circleSelectDrag(ed, m, e, mode, ed.maskCircleRadius);
    else lassoSelect(ed, m, e, mode);
    return;
  }
  // Select Box: click selects / slides, Ctrl click adds points, dragging empty space draws a box
  maskPointerDown(ed, e);
}

/** The 2D cursor: a red / white dashed ring with ticks. */
export function draw2DCursor(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineDashOffset = 3;
  ctx.strokeStyle = '#dc433b';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.beginPath();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.moveTo(x + dx * 11, y + dy * 11);
    ctx.lineTo(x + dx * 16, y + dy * 16);
  }
  ctx.stroke();
  ctx.restore();
}
