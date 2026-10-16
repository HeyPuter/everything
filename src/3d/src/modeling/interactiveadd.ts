// Interactive Add tools (Add Cube / Cone / Cylinder / UV Sphere / Ico Sphere): drag the base on a
// surface or on a plane through the 3D cursor, then move the mouse to set the height and click.
// A placement grid follows the mouse while one of these tools is active. The result is the regular
// primitive operator with location, rotation and scale, adjustable afterwards.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, operators, defaultProps } from '../app/app';
import { activeTools } from '../app/prefs';
import { h, type VNode } from '../ui/h';
import { enumMenu, enumRow } from '../ui/widgets';
import { openPopover } from '../ui/menu';
import { icon } from '../ui/icons';
import { toolsByMode, toolSettingsRenderers, type ToolDef } from '../editors/view3d/toolbar';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { selectPick } from '../editors/view3d/select';
import { surfaceHitWithNormal } from '../ops/view3d';
import * as prim from '../mesh/primitives';
import type { ToolSettings } from '../data/types';

export type PrimitiveType = 'CUBE' | 'CYLINDER' | 'CONE' | 'SPHERE_UV' | 'SPHERE_ICO';

export const ADD_TOOLS: { id: string; prim: PrimitiveType; label: string; icon: string; op: string }[] = [
  { id: 'builtin.primitive_cube_add', prim: 'CUBE', label: 'Add Cube', icon: 'add_cube', op: 'mesh.primitive_cube_add' },
  { id: 'builtin.primitive_cone_add', prim: 'CONE', label: 'Add Cone', icon: 'add_cone', op: 'mesh.primitive_cone_add' },
  { id: 'builtin.primitive_cylinder_add', prim: 'CYLINDER', label: 'Add Cylinder', icon: 'add_cylinder', op: 'mesh.primitive_cylinder_add' },
  { id: 'builtin.primitive_uv_sphere_add', prim: 'SPHERE_UV', label: 'Add UV Sphere', icon: 'add_uv_sphere', op: 'mesh.primitive_uv_sphere_add' },
  { id: 'builtin.primitive_ico_sphere_add', prim: 'SPHERE_ICO', label: 'Add Ico Sphere', icon: 'add_ico_sphere', op: 'mesh.primitive_ico_sphere_add' },
];
const PRIM_OP: Record<PrimitiveType, string> = Object.fromEntries(ADD_TOOLS.map((t) => [t.prim, t.op])) as Record<PrimitiveType, string>;

/** Last used origin / aspect options of the add tools (shown in the tool header). */
export const addToolProps = {
  plane_origin_base: 'EDGE' as 'EDGE' | 'CENTER',
  plane_origin_depth: 'EDGE' as 'EDGE' | 'CENTER',
  plane_aspect_base: 'FREE' as 'FREE' | 'FIXED',
  plane_aspect_depth: 'FREE' as 'FREE' | 'FIXED',
};

const ts = (): ToolSettings => app.doc.scene.tool_settings;
const toolPrim = (id: string) => ADD_TOOLS.find((t) => t.id === id || (id === 'builtin.add_cube' && t.prim === 'CUBE'));
const addMode = () => app.doc.mode === 'OBJECT' || (app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH');
const isAddTool = () => addMode() && !!toolPrim(activeTools[app.doc.mode] ?? '');

// ---------------------------------------------------------------------------
// placement plane

export interface PlacementFrame {
  origin: Vector3;
  u: Vector3;
  v: Vector3;
  n: Vector3;
}

const AXES = { X: new Vector3(1, 0, 0), Y: new Vector3(0, 1, 0), Z: new Vector3(0, 0, 1) };

/** The default plane normal: the chosen axis, or with Auto Axis the one the view looks along most. */
function defaultNormal(v: View3D): Vector3 {
  const s = ts();
  if (s.plane_axis_auto === false) return AXES[s.plane_axis ?? 'Z'].clone();
  const f = v.nav.forward;
  if (Math.abs(f.z) > 0.3) return AXES.Z.clone();
  return Math.abs(f.x) > Math.abs(f.y) ? AXES.X.clone() : AXES.Y.clone();
}

/** In-plane axes for a normal: world X (or Y) projected onto the plane, then the cross product. */
export function planeAxes(n: Vector3): { u: Vector3; v: Vector3 } {
  const ref = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = ref.addScaledVector(n, -ref.dot(n)).normalize();
  return { u, v: n.clone().cross(u).normalize() };
}

function rayPlane(v: View3D, x: number, y: number, origin: Vector3, n: Vector3): Vector3 | null {
  const r = v.ray(x, y);
  const den = r.dir.dot(n);
  if (Math.abs(den) < 1e-9) return null;
  const t = origin.clone().sub(r.origin).dot(n) / den;
  return t > 0 || v.nav.ortho ? r.origin.clone().addScaledVector(r.dir, t) : null;
}

/** Where a new base starts under the viewport pixel (x, y), following the tool settings. */
export function placementFrame(v: View3D, x: number, y: number): PlacementFrame {
  const s = ts();
  const depth = s.plane_depth ?? 'SURFACE',
    orient = s.plane_orientation ?? 'SURFACE';
  const hit = depth === 'SURFACE' || orient === 'SURFACE' ? surfaceHitWithNormal(v, x, y) : null;
  const n = orient === 'SURFACE' && hit ? hit.normal.clone().normalize() : defaultNormal(v);
  const cur = new Vector3(...app.doc.scene.cursor.location);
  let origin: Vector3;
  if (depth === 'SURFACE' && hit) origin = hit.point.clone();
  else if (depth === 'CURSOR_VIEW') origin = v.unproject(x, y, cur);
  else origin = rayPlane(v, x, y, cur, n) ?? v.unproject(x, y, cur);
  return { origin, n, ...planeAxes(n) };
}

// ---------------------------------------------------------------------------
// snapping (Ctrl)

/** Nearest vertex of the visible meshes within `radius` pixels, in world space. */
function snapVertex(v: View3D, x: number, y: number, radius = 14): Vector3 | null {
  let best: Vector3 | null = null,
    bd = radius;
  const p = new Vector3();
  let budget = 400000;
  for (const ob of Object.values(app.doc.objects)) {
    if (ob.type !== 'MESH' || !app.isVisible(ob.id)) continue;
    const ev = app.graph.get(ob.id);
    const P = ev?.mesh?.positions;
    if (!P || !ev) continue;
    for (let i = 0; i < P.length && budget > 0; i += 3, budget--) {
      p.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(ev.world);
      const s = v.project(p);
      if (s.z > 1) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = p.clone();
      }
    }
  }
  return best;
}

/** A grid step that suits the zoom level (a power of ten). */
function gridStep(v: View3D, p: Vector3) {
  return Math.pow(10, Math.round(Math.log10(Math.max(1e-4, v.nav.pixelSize(p) * 40))));
}

/** A point on the frame's plane with snapping applied: to geometry (vertices) or to the grid, per Snap To. */
export function snapOnPlane(v: View3D, x: number, y: number, frame: PlacementFrame, p: Vector3): Vector3 {
  if ((ts().snap_elements_tool ?? 'GEOMETRY') === 'GEOMETRY') {
    const hit = snapVertex(v, x, y);
    if (hit) return hit.addScaledVector(frame.n, -hit.clone().sub(frame.origin).dot(frame.n));
  }
  const step = gridStep(v, p);
  const d = p.clone().sub(frame.origin);
  return frame.origin
    .clone()
    .addScaledVector(frame.u, Math.round(d.dot(frame.u) / step) * step)
    .addScaledVector(frame.v, Math.round(d.dot(frame.v) / step) * step);
}

// ---------------------------------------------------------------------------
// shape from the drag

export interface AddShape {
  frame: PlacementFrame;
  /** rectangle in plane coordinates and the height range along the normal */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  h0: number;
  h1: number;
}

/** Location, rotation (XYZ Euler) and scale of a primitive (spanning -1..1) that fills a shape. */
export function shapeTransform(s: AddShape) {
  const { frame } = s;
  const loc = frame.origin
    .clone()
    .addScaledVector(frame.u, (s.u0 + s.u1) / 2)
    .addScaledVector(frame.v, (s.v0 + s.v1) / 2)
    .addScaledVector(frame.n, (s.h0 + s.h1) / 2);
  const e = new Euler().setFromRotationMatrix(new Matrix4().makeBasis(frame.u, frame.v, frame.n), 'ZYX');
  const scale = [Math.abs(s.u1 - s.u0) / 2, Math.abs(s.v1 - s.v0) / 2, Math.max(1e-4, Math.abs(s.h1 - s.h0)) / 2];
  return { location: [loc.x, loc.y, loc.z], rotation: [e.x, e.y, e.z], scale };
}

/**
 * Base rectangle from the start point to the mouse point (plane offsets du, dv): a square with a
 * fixed aspect, centred on the start with a centre origin.
 */
export function baseRect(du: number, dv: number, center: boolean, fixed: boolean) {
  if (fixed) {
    const s = Math.max(Math.abs(du), Math.abs(dv));
    du = Math.sign(du || 1) * s;
    dv = Math.sign(dv || 1) * s;
  }
  return center ? { u0: -du, u1: du, v0: -dv, v1: dv } : { u0: Math.min(0, du), u1: Math.max(0, du), v0: Math.min(0, dv), v1: Math.max(0, dv) };
}

/** Height range for a height `h` above the base; a centre origin grows both ways, a fixed aspect matches the base. */
export function heightRange(h: number, base: { u0: number; u1: number; v0: number; v1: number }, center: boolean, fixed: boolean) {
  if (fixed) h = Math.sign(h || 1) * Math.max(base.u1 - base.u0, base.v1 - base.v0) / (center ? 2 : 1);
  return center ? { h0: -Math.abs(h), h1: Math.abs(h) } : { h0: Math.min(0, h), h1: Math.max(0, h) };
}

// ---------------------------------------------------------------------------
// drawing: the shape being added, or the placement grid under the mouse

const previews = new Map<PrimitiveType, { pos: ArrayLike<number>; edges: [number, number][] }>();

function previewOf(p: PrimitiveType) {
  let e = previews.get(p);
  if (e) return e;
  const arr = p === 'CUBE' ? prim.cube(2) : p === 'CYLINDER' ? prim.cylinder(16, 1, 2, 'NGON') : p === 'CONE' ? prim.cone(16, 1, 0, 2, 'NGON') : p === 'SPHERE_UV' ? prim.uvSphere(16, 8, 1) : prim.icoSphere(1, 1);
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (let f = 0; f < arr.offsets.length - 1; f++) {
    const s = arr.offsets[f],
      t = arr.offsets[f + 1];
    for (let k = s; k < t; k++) {
      const a = arr.indices[k],
        b = arr.indices[k + 1 < t ? k + 1 : s];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([a, b]);
      }
    }
  }
  e = { pos: arr.positions, edges };
  previews.set(p, e);
  return e;
}

let hoverFrame: { v: View3D; frame: PlacementFrame } | null = null;
let preview: { v: View3D; shape: AddShape; prim: PrimitiveType } | null = null;

function shapeMatrix(s: AddShape) {
  const t = shapeTransform(s);
  const q = new Quaternion().setFromEuler(new Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'ZYX'));
  return new Matrix4().compose(new Vector3(...t.location), q, new Vector3(...t.scale));
}

function drawPreview(v: View3D): VNode[] {
  if (!preview || preview.v !== v) return [];
  const { pos, edges } = previewOf(preview.prim);
  const m = shapeMatrix(preview.shape);
  const q = new Vector3();
  const scr: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < pos.length; i += 3) scr.push(v.project(q.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m)));
  const d = edges
    .filter(([a, b]) => scr[a].z <= 1 && scr[b].z <= 1)
    .map(([a, b]) => `M${scr[a].x.toFixed(1)} ${scr[a].y.toFixed(1)}L${scr[b].x.toFixed(1)} ${scr[b].y.toFixed(1)}`)
    .join('');
  return [h('path', { d, fill: 'none', stroke: '#000000', 'stroke-width': 3, opacity: 0.35 }), h('path', { d, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.2 })];
}

function drawGrid(v: View3D): VNode[] {
  if (!hoverFrame || hoverFrame.v !== v || !isAddTool() || app.modal) return [];
  const { frame } = hoverFrame;
  const size = v.nav.pixelSize(frame.origin) * 60;
  const P = (a: number, b: number) => v.project(frame.origin.clone().addScaledVector(frame.u, a * size).addScaledVector(frame.v, b * size));
  const lines: string[] = [];
  for (let i = -2; i <= 2; i++) {
    const a = P(i / 2, -1),
      b = P(i / 2, 1),
      c = P(-1, i / 2),
      d = P(1, i / 2);
    lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}M${c.x.toFixed(1)} ${c.y.toFixed(1)}L${d.x.toFixed(1)} ${d.y.toFixed(1)}`);
  }
  const o = P(0, 0),
    tip = v.project(frame.origin.clone().addScaledVector(frame.n, size * 0.7));
  return [
    h('path', { d: lines.join(''), fill: 'none', stroke: '#ffffff', 'stroke-width': 1, opacity: 0.5 }),
    h('line', { x1: o.x, y1: o.y, x2: tip.x, y2: tip.y, stroke: '#5f9cff', 'stroke-width': 1.5 }),
    h('circle', { cx: o.x, cy: o.y, r: 2.5, fill: '#ffffff' }),
  ];
}

editModeHooks.svg.push((v) => {
  const parts = [...drawPreview(v), ...drawGrid(v)];
  return parts.length ? h('g', { class: 'interactive-add' }, parts) : null;
});

editModeHooks.hover.push((v, e) => {
  if (!isAddTool()) {
    if (hoverFrame) {
      hoverFrame = null;
      v.drawSvg();
    }
    return;
  }
  const p = v.local(e);
  hoverFrame = { v, frame: placementFrame(v, p.x, p.y) };
  v.drawSvg();
});

// ---------------------------------------------------------------------------
// the operator

/** Height along the frame normal (through `at`) closest to the mouse ray. */
function heightAt(v: View3D, x: number, y: number, at: Vector3, n: Vector3): number {
  const r = v.ray(x, y);
  // closest points between the ray and the line at + n·t
  const w = r.origin.clone().sub(at);
  const b = r.dir.dot(n),
    d = r.dir.dot(w),
    e = n.dot(w);
  const den = 1 - b * b;
  return den < 1e-9 ? e : (e - b * d) / den;
}

function startInteractiveAdd(v: View3D, primType: PrimitiveType, p: Record<string, unknown>, startAt: { x: number; y: number } | null) {
  const rect = v.el.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  let phase: 'WAIT' | 'BASE' | 'HEIGHT' = startAt ? 'BASE' : 'WAIT';
  let frame: PlacementFrame | null = null;
  let base = { u0: 0, u1: 0, v0: 0, v1: 0 };
  let height = { h0: 0, h1: 0 };
  let center = p.plane_origin_base === 'CENTER',
    fixed = p.plane_aspect_base === 'FIXED';
  const centerH = p.plane_origin_depth === 'CENTER',
    fixedH = p.plane_aspect_depth === 'FIXED';
  let last = { x: 0, y: 0, ctrl: false, shift: false, alt: false };
  let result: Record<string, unknown> | null = null;
  const begin = (x: number, y: number, ctrl: boolean) => {
    frame = placementFrame(v, x, y);
    if (ctrl) frame.origin = snapOnPlane(v, x, y, frame, frame.origin);
    phase = 'BASE';
  };
  const update = () => {
    if (!frame) return;
    if (phase === 'BASE') {
      let q = rayPlane(v, last.x, last.y, frame.origin, frame.n);
      if (!q) return;
      if (last.ctrl) q = snapOnPlane(v, last.x, last.y, frame, q);
      const d = q.sub(frame.origin);
      base = baseRect(d.dot(frame.u), d.dot(frame.v), center !== last.alt, fixed !== last.shift);
    } else if (phase === 'HEIGHT') {
      const mid = frame.origin.clone().addScaledVector(frame.u, (base.u0 + base.u1) / 2).addScaledVector(frame.v, (base.v0 + base.v1) / 2);
      let hgt = heightAt(v, last.x, last.y, mid, frame.n);
      if (last.ctrl) {
        const step = gridStep(v, mid);
        hgt = Math.round(hgt / step) * step;
      }
      height = heightRange(hgt, base, centerH, fixedH !== last.shift);
    }
    preview = { v, prim: primType, shape: { frame, ...base, ...height } };
    v.drawSvg();
  };
  const toHeight = () => {
    if (Math.max(base.u1 - base.u0, base.v1 - base.v0) < 1e-6) return false;
    phase = 'HEIGHT';
    // a fixed height aspect shows the final shape right away
    update();
    app.changed('ui');
    return true;
  };
  const finishShape = () => {
    if (!frame) return;
    const t = shapeTransform({ frame, ...base, ...height });
    const op = operators.get(PRIM_OP[primType])!;
    result = { ...defaultProps(op), location: t.location, rotation: t.rotation, scale: t.scale, align: 'WORLD' };
    op.exec?.(app.context(), result);
  };
  if (startAt) begin(startAt.x - rect.left, startAt.y - rect.top, false);
  app.startModal({
    label: ADD_TOOLS.find((t) => t.prim === primType)!.label,
    header: () =>
      phase === 'WAIT'
        ? 'Click and drag to place the base'
        : phase === 'BASE'
          ? `Base: drag the size  [Shift] ${fixed ? 'Free' : 'Fixed'} Aspect  [Alt] ${center ? 'Edge' : 'Center'} Origin  [Ctrl] Snap`
          : `Height: ${(height.h1 - height.h0).toFixed(3)}  (click to confirm)  [Shift] Fixed Aspect  [Ctrl] Snap`,
    status: () => [
      ['LMB', phase === 'HEIGHT' ? 'Confirm' : 'Place'],
      ['RMB / Esc', 'Cancel'],
      ['Shift', 'Aspect'],
      ['Alt', 'Origin'],
      ['Ctrl', 'Snap'],
    ],
    onPointerMove(e) {
      const q = local(e);
      last = { x: q.x, y: q.y, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
      if (phase === 'WAIT') {
        hoverFrame = { v, frame: placementFrame(v, q.x, q.y) };
        v.drawSvg();
        return;
      }
      update();
    },
    onPointerDown(e) {
      if (e.button === 2) return 'CANCELLED';
      if (e.button !== 0) return undefined;
      const q = local(e);
      if (phase === 'WAIT') {
        begin(q.x, q.y, e.ctrlKey || e.metaKey);
        last = { x: q.x, y: q.y, ctrl: false, shift: false, alt: false };
        return undefined;
      }
      if (phase === 'HEIGHT') return 'FINISHED';
      return undefined;
    },
    onPointerUp(e) {
      if (phase !== 'BASE' || e.button !== 0) return undefined;
      // a release ends the base; a click without any size gives up
      return toHeight() ? undefined : 'CANCELLED';
    },
    onKey(e) {
      if (e.type === 'keydown') {
        if (e.key === 'Escape') return 'CANCELLED';
        if (e.key === 'Enter') {
          if (phase === 'BASE') return toHeight() ? undefined : 'CANCELLED';
          if (phase === 'HEIGHT') return 'FINISHED';
        }
      }
      if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) {
        last = { ...last, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
        update();
      }
      return true;
    },
    cancel() {
      preview = null;
      v.drawSvg();
    },
    finish() {
      preview = null;
      finishShape();
      v.drawSvg();
      if (result) this.redoOp = { idname: PRIM_OP[primType], props: result };
    },
  });
  return 'RUNNING_MODAL' as const;
}

registerOperators([
  {
    idname: 'view3d.interactive_add',
    label: 'Add Primitive Object',
    description: 'Add a primitive by dragging out its base and then its height',
    props: [
      { id: 'primitive_type', label: 'Primitive', type: 'enum', default: 'CUBE', items: [['CUBE', 'Cube'], ['CYLINDER', 'Cylinder'], ['CONE', 'Cone'], ['SPHERE_UV', 'UV Sphere'], ['SPHERE_ICO', 'Ico Sphere']] },
      { id: 'plane_origin_base', label: 'Base Origin', type: 'enum', default: 'EDGE', items: [['EDGE', 'Edge', 'Start from a corner of the base'], ['CENTER', 'Center', 'Start from the centre of the base']] },
      { id: 'plane_origin_depth', label: 'Height Origin', type: 'enum', default: 'EDGE', items: [['EDGE', 'Edge', 'The base is the bottom'], ['CENTER', 'Center', 'The base is the middle']] },
      { id: 'plane_aspect_base', label: 'Base Aspect', type: 'enum', default: 'FREE', items: [['FREE', 'Free'], ['FIXED', 'Fixed', 'Square base']] },
      { id: 'plane_aspect_depth', label: 'Height Aspect', type: 'enum', default: 'FREE', items: [['FREE', 'Free'], ['FIXED', 'Fixed', 'Height equals the base size']] },
      { id: 'wait_for_input', label: 'Wait for Input', type: 'bool', default: true, hidden: true },
    ],
    poll: () => addMode(),
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const ev = ctx.event;
      return startInteractiveAdd(v, p.primitive_type as PrimitiveType, p, p.wait_for_input === false && ev ? { x: ev.x, y: ev.y } : null);
    },
    undo: true,
  },
]);

// ---------------------------------------------------------------------------
// toolbar: the add tools share one slot after the common tools

function addToolDefs(): ToolDef[] {
  return ADD_TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, group: 'add', description: `Drag out the base, then the height, to add a ${t.label.slice(4).toLowerCase()}` }));
}
for (const mode of ['OBJECT', 'EDIT']) {
  const list = toolsByMode[mode];
  const i = list.findIndex((t) => t?.id === 'builtin.add_cube');
  if (i >= 0) list.splice(i, 1, ...addToolDefs());
}

// viewport behaviour of the tools: drag places a primitive, a click selects
editModeHooks.pointer.unshift((v, e) => {
  if (!isAddTool() || e.altKey || e.button !== 0) return false;
  const t = toolPrim(activeTools[app.doc.mode])!;
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    cleanup();
    hoverFrame = null;
    app.run('view3d.interactive_add', { primitive_type: t.prim, ...addToolProps, wait_for_input: false }, { event: { x: sx, y: sy } });
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    const o = { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey };
    if (app.doc.mode === 'EDIT') {
      for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, o)) break;
    } else selectPick(v, sx - r.left, sy - r.top, o);
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

// tool settings: placement (scene tool settings) and the origin / aspect of base and height
const settingEnum = (id: string, label: string, items: [string, string, string][], get: () => string, set: (v: string) => void) =>
  h(
    'span',
    { class: 'th-settings' },
    h('span', { class: 'th-label' }, label),
    enumMenu(
      id,
      items.map(([value, l, description]) => ({ value, label: l, description })),
      get(),
      (x) => {
        set(x);
        app.changed('ui');
      },
    ),
  );

function shapePopover() {
  const row = (id: string, title: string, items: [string, string, string][], key: keyof typeof addToolProps) => [
    h('div', { class: 'pop-title' }, title),
    enumRow(
      id,
      items.map(([value, label, description]) => ({ value, label, description })),
      addToolProps[key],
      (x) => {
        (addToolProps as Record<string, string>)[key] = x;
        pop?.redraw();
        app.changed('ui');
      },
    ),
  ];
  let pop: { redraw: () => void } | null = null;
  return (el: HTMLElement) => {
    pop = openPopover(
      el,
      () =>
        h(
          'div',
          { class: 'pop-panel add-shape-pop' },
          ...row('add-base-origin', 'Base Origin', [['EDGE', 'Edge', 'Drag from a corner of the base'], ['CENTER', 'Center', 'Drag from the centre of the base']], 'plane_origin_base'),
          ...row('add-base-aspect', 'Base Aspect', [['FREE', 'Free', 'Any rectangle'], ['FIXED', 'Fixed', 'A square base']], 'plane_aspect_base'),
          ...row('add-height-origin', 'Height Origin', [['EDGE', 'Edge', 'The base is the bottom'], ['CENTER', 'Center', 'The base is the middle']], 'plane_origin_depth'),
          ...row('add-height-aspect', 'Height Aspect', [['FREE', 'Free', 'Any height'], ['FIXED', 'Fixed', 'As tall as the base is wide']], 'plane_aspect_depth'),
          h('div', { class: 'pop-hint' }, 'While dragging: Shift toggles the aspect, Alt the origin, Ctrl snaps'),
        ),
      { width: 240 },
    );
  };
}
const openShape = shapePopover();

function addToolSettings() {
  const s = ts();
  const summary = `${addToolProps.plane_origin_base === 'CENTER' ? 'Center' : 'Edge'}${addToolProps.plane_aspect_base === 'FIXED' ? ', Square' : ''}`;
  return [
    settingEnum('add-depth', 'Depth', [['SURFACE', 'Surface', 'Start on the surface under the mouse'], ['CURSOR_PLANE', 'Cursor Plane', 'Start on the plane through the 3D cursor'], ['CURSOR_VIEW', 'Cursor View', 'Start on the view plane at the 3D cursor']], () => s.plane_depth ?? 'SURFACE', (x) => (s.plane_depth = x as ToolSettings['plane_depth'])),
    settingEnum('add-orient', 'Orientation', [['SURFACE', 'Surface', 'Align the base to the surface under the mouse'], ['DEFAULT', 'Default', 'Align the base to the world axis facing the view']], () => s.plane_orientation ?? 'SURFACE', (x) => (s.plane_orientation = x as ToolSettings['plane_orientation'])),
    settingEnum('add-snap', 'Snap to', [['GEOMETRY', 'Geometry', 'Ctrl snaps to vertices (else the grid)'], ['DEFAULT', 'Default', 'Ctrl snaps to the grid']], () => s.snap_elements_tool ?? 'GEOMETRY', (x) => (s.snap_elements_tool = x as ToolSettings['snap_elements_tool'])),
    h(
      'button',
      { key: 'add-shape', class: 'hdr-menu add-shape-btn', 'data-tip': 'Where the base starts and how base and height are proportioned', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openShape(e.currentTarget as HTMLElement)) },
      h('span', { class: 'th-label' }, 'Base'),
      h('span', null, summary),
      icon('down_arrow_hlt'),
    ),
  ];
}
for (const t of ADD_TOOLS) toolSettingsRenderers[t.id] = addToolSettings;
