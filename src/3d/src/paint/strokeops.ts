// Brush stroke operators (sculpt.brush_stroke, paint.vertex_paint, paint.weight_paint,
// paint.image_paint) and the mode toggle operators. A stroke can be given as a list of points so
// scripts can paint; without points the operator starts a live stroke at the pointer.
import { Vector3 } from 'three';
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import type { Mode } from '../data/types';
import { playStroke } from './stroke';
import { strokePoints, type StrokeItem } from './strokemath';
import { brushStroke, lastStrokeStarted } from './ui';

function parseItems(raw: unknown): StrokeItem[] {
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      return parseItems(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => x && typeof x === 'object') as StrokeItem[];
}

const MODES: [string, string, string][] = [
  ['NORMAL', 'Regular', 'Use the brush as it is set'],
  ['INVERT', 'Invert', 'Invert the brush direction (as holding Ctrl)'],
  ['SMOOTH', 'Smooth', 'Smooth or blur instead (as holding Shift)'],
];
const TOGGLES: [string, string, string][] = [
  ['None', 'None', 'Use the active brush'],
  ['SMOOTH', 'Smooth', 'Use the smooth / blur brush for this stroke'],
  ['MASK', 'Mask', 'Use the mask brush for this stroke (Sculpt Mode)'],
];

const strokeProps = (sculpt: boolean): PropDef[] => [
  { id: 'stroke', label: 'Stroke', type: 'string', default: '', hidden: true },
  { id: 'mode', label: 'Stroke Mode', type: 'enum', default: 'NORMAL', items: MODES },
  { id: 'brush_toggle', label: 'Temporary Brush Toggle', type: 'enum', default: 'None', items: sculpt ? TOGGLES : TOGGLES.slice(0, 2) },
  { id: 'pen_flip', label: 'Pen Flip', type: 'bool', default: false, hidden: true },
  ...(sculpt
    ? ([
        { id: 'override_location', label: 'Override Location', type: 'bool', default: false, hidden: true },
        { id: 'ignore_background_click', label: 'Ignore Background Click', type: 'bool', default: false, hidden: true },
      ] as PropDef[])
    : []),
];

function viewFor(ctx: OpContext): View3D | null {
  const ed = ctx.area?.editor as View3D | undefined;
  if (ed && typeof (ed as { local?: unknown }).local === 'function' && ed.camera) return ed;
  return activeView3D();
}

function mods(p: Record<string, unknown>) {
  const invert = p.mode === 'INVERT' || !!p.pen_flip;
  const smooth = p.mode === 'SMOOTH' || p.brush_toggle === 'SMOOTH';
  const mask = p.brush_toggle === 'MASK';
  return { ctrl: invert, shift: smooth, alt: mask };
}

function runStrokeOp(mode: Mode, ctx: OpContext, p: Record<string, unknown>, live: boolean): 'FINISHED' | 'CANCELLED' {
  if (app.doc.mode !== mode) return 'CANCELLED';
  const v = viewFor(ctx);
  if (!v) {
    app.report('ERROR', 'Painting needs a 3D Viewport');
    return 'CANCELLED';
  }
  const m = mods(p);
  const items = parseItems(p.stroke);
  if (!items.length) {
    if (!live || !ctx.event) return 'CANCELLED';
    // live stroke from the pointer (keymap / button invocation): the stroke follows the mouse until release
    const q = v.local({ clientX: ctx.event.x, clientY: ctx.event.y });
    const ok = playStroke(v, [{ x: q.x, y: q.y }], (e) => brushStroke(v, e) && lastStrokeStarted, m);
    return ok ? 'FINISHED' : 'CANCELLED';
  }
  v.camera.updateMatrixWorld();
  const pts = strokePoints(items, v.height, (loc) => {
    const q = v.project(new Vector3(loc[0], loc[1], loc[2]));
    return { x: q.x, y: q.y, z: q.z };
  });
  if (!pts.length) return 'CANCELLED';
  const ok = playStroke(v, pts, (e) => brushStroke(v, e) && lastStrokeStarted, m);
  if (!ok) {
    app.report('WARNING', 'The stroke does not touch the mesh');
    return 'CANCELLED';
  }
  return 'FINISHED';
}

const strokeOp = (idname: string, label: string, mode: Mode, description: string) => ({
  idname,
  label,
  description,
  props: strokeProps(mode === 'SCULPT'),
  // the stroke pushes its own undo step when it ends
  undo: false,
  poll: (ctx: OpContext) => ctx.doc.mode === mode && !!app.activeObject && app.activeObject.type === 'MESH',
  invoke: (ctx: OpContext, p: Record<string, unknown>) => runStrokeOp(mode, ctx, p, true),
  exec: (ctx: OpContext, p: Record<string, unknown>) => runStrokeOp(mode, ctx, p, false),
});

registerOperators([
  strokeOp('sculpt.brush_stroke', 'Sculpt', 'SCULPT', 'Sculpt the mesh with the active brush along a stroke'),
  strokeOp('paint.vertex_paint', 'Vertex Paint', 'VERTEX_PAINT', 'Paint the active color attribute with the active brush along a stroke'),
  strokeOp('paint.weight_paint', 'Weight Paint', 'WEIGHT_PAINT', 'Paint weights into the active vertex group along a stroke'),
  strokeOp('paint.image_paint', 'Image Paint', 'TEXTURE_PAINT', 'Paint into the active paint image along a stroke'),
]);

// ---------------------------------------------------------------------------
// mode toggles

const toggle = (idname: string, label: string, mode: Mode, description: string) => ({
  idname,
  label,
  description,
  poll: () => {
    const ob = app.activeObject;
    return !!ob && ob.type === 'MESH' && !!ob.data && (app.doc.mode === 'OBJECT' || app.doc.mode === mode);
  },
  exec: () => {
    const r = app.run('object.mode_set', { mode: app.doc.mode === mode ? 'OBJECT' : mode, toggle: false }, { invoke: false });
    return r === 'FINISHED' ? undefined : 'CANCELLED';
  },
  undo: false,
});

registerOperators([
  toggle('sculpt.sculptmode_toggle', 'Sculpt Mode', 'SCULPT', 'Switch the active mesh into or out of Sculpt Mode'),
  toggle('paint.vertex_paint_toggle', 'Vertex Paint Mode', 'VERTEX_PAINT', 'Switch the active mesh into or out of Vertex Paint mode'),
  toggle('paint.weight_paint_toggle', 'Weight Paint Mode', 'WEIGHT_PAINT', 'Switch the active mesh into or out of Weight Paint mode'),
  toggle('paint.texture_paint_toggle', 'Texture Paint Toggle', 'TEXTURE_PAINT', 'Switch the active mesh into or out of Texture Paint mode'),
]);
