// Click selection as operators: view3d.select (the keymap / scripting entry for picking under a
// screen location), the Alt+click "which one?" menus for overlapping objects (view3d.select_menu)
// and bones (view3d.bone_select_menu).
import { Box3, Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { openMenu, type MenuItem } from '../../ui/menu';
import { activeView3D, type View3D } from './view3d';
import { selectPick } from './select';
import { lassoDrag, selectInRegion, type SelectMode } from './selectshapes';
import { boneVisible } from '../../modes/armature/armkernels';
import { defaultPoseBone } from '../../eval/armature';
import { iconNames } from '../../ui/icons';
import type { ObjectData } from '../../data/types';

const TYPE_ICON: Record<string, string> = {
  MESH: 'outliner_ob_mesh',
  CURVE: 'outliner_ob_curve',
  SURFACE: 'outliner_ob_surface',
  META: 'outliner_ob_meta',
  FONT: 'outliner_ob_font',
  CURVES: 'outliner_ob_curves',
  POINTCLOUD: 'outliner_ob_pointcloud',
  VOLUME: 'outliner_ob_volume',
  GREASEPENCIL: 'outliner_ob_greasepencil',
  ARMATURE: 'outliner_ob_armature',
  LATTICE: 'outliner_ob_lattice',
  EMPTY: 'outliner_ob_empty',
  LIGHT: 'outliner_ob_light',
  LIGHT_PROBE: 'outliner_ob_lightprobe',
  CAMERA: 'outliner_ob_camera',
  SPEAKER: 'outliner_ob_speaker',
};

export function objectTypeIcon(ob: ObjectData): string {
  const n = TYPE_ICON[ob.type];
  return n && iconNames.includes(n) ? n : 'outliner_ob_empty';
}

/** Möller–Trumbore: distance along the ray to triangle abc, or -1. */
export function rayTriangle(o: Vector3, d: Vector3, a: Vector3, b: Vector3, c: Vector3): number {
  const e1 = b.clone().sub(a),
    e2 = c.clone().sub(a);
  const p = new Vector3().crossVectors(d, e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const t0 = o.clone().sub(a);
  const u = t0.dot(p) * inv;
  if (u < 0 || u > 1) return -1;
  const q = new Vector3().crossVectors(t0, e1);
  const v = d.dot(q) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = e2.dot(q) * inv;
  return t > 0 ? t : -1;
}

/** Every visible mesh object a world ray passes through, nearest first (occluded ones included). */
function rayHits(origin: Vector3, dir: Vector3): string[] {
  const hits: [string, number][] = [];
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  for (const ev of app.graph.objects.values()) {
    const m = ev.mesh;
    if (!ev.visible || !m || m.offsets.length < 2) continue;
    const inv = new Matrix4().copy(ev.world).invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    const box = new Box3().setFromArray(m.positions as ArrayLike<number> as number[]);
    if (!box.isEmpty() && !rayBox(o, d, box)) continue;
    let best = Infinity;
    const P = m.positions;
    for (let f = 0; f < m.offsets.length - 1; f++) {
      const s = m.offsets[f],
        e = m.offsets[f + 1];
      for (let k = s + 1; k < e - 1; k++) {
        a.fromArray(P, m.indices[s] * 3);
        b.fromArray(P, m.indices[k] * 3);
        c.fromArray(P, m.indices[k + 1] * 3);
        const t = rayTriangle(o, d, a, b, c);
        if (t > 0 && t < best) best = t;
      }
    }
    if (best < Infinity) {
      const wp = o.clone().addScaledVector(d, best).applyMatrix4(ev.world);
      hits.push([ev.id, wp.distanceTo(origin)]);
    }
  }
  return hits.sort((x, y) => x[1] - y[1]).map((h) => h[0]);
}

function rayBox(o: Vector3, d: Vector3, box: Box3): boolean {
  let t0 = -Infinity,
    t1 = Infinity;
  for (const k of ['x', 'y', 'z'] as const) {
    const lo = box.min[k] - 1e-6,
      hi = box.max[k] + 1e-6;
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < lo || o[k] > hi) return false;
      continue;
    }
    let a = (lo - o[k]) / d[k],
      b = (hi - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return t1 > 0;
}

/**
 * Objects under a viewport location, front-most first: what the selection buffer sees within
 * `radius` pixels, then meshes hidden behind them along the ray, then objects whose origin is
 * close (lights, empties, cameras without drawn pixels nearby).
 */
export function objectsUnderCursor(v: View3D, x: number, y: number, radius = 10): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (out.includes(id)) return;
    const ob = app.doc.objects[id];
    if (!ob || !app.isSelectable(id) || v.unselectableTypes.has(ob.type) || v.hiddenTypes.has(ob.type)) return;
    if (v.localView && !v.localView.has(id)) return;
    out.push(id);
  };
  const hit = v.pick(x, y, radius);
  hit?.order.forEach(add);
  const { origin, dir } = v.ray(x, y);
  rayHits(origin, dir).forEach(add);
  const near: [string, number][] = [];
  for (const ev of app.graph.objects.values()) {
    if (!ev.visible) continue;
    const p = v.project(new Vector3().setFromMatrixPosition(ev.world));
    if (p.z > 1) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius * 1.5) near.push([ev.id, d]);
  }
  near.sort((a, b) => a[1] - b[1]).forEach((n) => add(n[0]));
  return out;
}

/** Bones of the active armature (pose mode) close to a viewport location, nearest first. */
export function bonesUnderCursor(v: View3D, x: number, y: number, radius = 10): string[] {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'ARMATURE' || !ob.data) return [];
  const arm = app.doc.armatures[ob.data];
  const ev = app.graph.get(ob.id);
  if (!arm || !ev?.pose) return [];
  const found: [string, number][] = [];
  for (const b of arm.bones) {
    if (!boneVisible(arm, b)) continue;
    const pb = ev.pose.bones.get(b.name);
    if (!pb) continue;
    const head = new Vector3().setFromMatrixPosition(pb.pose).applyMatrix4(ev.world);
    const tail = new Vector3(0, pb.length, 0).applyMatrix4(pb.pose).applyMatrix4(ev.world);
    const hs = v.project(head),
      ts = v.project(tail);
    const dx = ts.x - hs.x,
      dy = ts.y - hs.y,
      l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - hs.x) * dx + (y - hs.y) * dy) / l2));
    const d = Math.hypot(hs.x + dx * t - x, hs.y + dy * t - y);
    if (d <= Math.max(radius, Math.sqrt(l2) * 0.12)) found.push([b.name, d]);
  }
  return found.sort((a, b) => a[1] - b[1]).map((f) => f[0]);
}

interface PickMods {
  extend?: boolean;
  deselect?: boolean;
  toggle?: boolean;
}

/** Select one object by id the way a click would (with Shift toggling, Ctrl deselecting). */
export function selectObjectById(id: string, o: PickMods) {
  const doc = app.doc;
  const ob = doc.objects[id];
  if (!ob) return false;
  if (o.deselect) ob.select = false;
  else if (o.toggle) {
    if (ob.select && doc.scene.active_object === id) ob.select = false;
    else {
      ob.select = true;
      doc.scene.active_object = id;
    }
  } else {
    if (!o.extend) for (const other of Object.values(doc.objects)) other.select = false;
    ob.select = true;
    doc.scene.active_object = id;
  }
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
}

export function selectBoneByName(name: string, o: PickMods) {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'ARMATURE' || !ob.data) return false;
  const arm = app.doc.armatures[ob.data];
  if (!arm?.bones.some((b) => b.name === name)) return false;
  ob.pose ??= {};
  const pb = (ob.pose[name] ??= defaultPoseBone());
  if (o.deselect) pb.select = false;
  else if (o.toggle) pb.select = !(pb.select && arm.active_bone === name);
  else {
    if (!o.extend) for (const other of Object.values(ob.pose)) other.select = false;
    pb.select = true;
  }
  if (pb.select) arm.active_bone = name;
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
}

/**
 * Alt+click: list what is under the pointer so the user can choose. Returns false when there is
 * nothing to choose between (a single candidate is selected right away).
 */
export function openSelectMenu(v: View3D, x: number, y: number, o: PickMods, at?: { x: number; y: number }): boolean {
  const pose = app.doc.mode === 'POSE';
  if (!pose && app.doc.mode !== 'OBJECT') return false;
  const ids = pose ? bonesUnderCursor(v, x, y) : objectsUnderCursor(v, x, y);
  if (!ids.length) return false;
  if (ids.length === 1) {
    if (pose) selectBoneByName(ids[0], o);
    else selectObjectById(ids[0], o);
    return true;
  }
  const r = v.el.getBoundingClientRect();
  const pos = at ?? { x: r.left + x, y: r.top + y };
  const mods = { extend: !!o.extend, deselect: !!o.deselect, toggle: !!o.toggle };
  const items: MenuItem[] = ids.slice(0, 24).map((id) =>
    pose
      ? { label: id, icon: 'bone_data', active: app.activeObject?.pose?.[id]?.select, op: 'view3d.bone_select_menu', props: { name: id, ...mods } }
      : { label: app.doc.objects[id].name, icon: objectTypeIcon(app.doc.objects[id]), active: app.doc.objects[id].select, op: 'view3d.select_menu', props: { name: app.doc.objects[id].name, ...mods } },
  );
  openMenu(items, pos, { title: 'Select', under: true });
  return true;
}

function viewportLocation(ctx: OpContext, v: View3D, loc: unknown): { x: number; y: number } {
  if (Array.isArray(loc) && (loc[0] || loc[1])) return { x: Number(loc[0]), y: Number(loc[1]) };
  const r = v.el.getBoundingClientRect();
  const e = ctx.event ?? app.pointer;
  return { x: e.x - r.left, y: e.y - r.top };
}

const modsProps = [
  { id: 'extend', label: 'Extend', type: 'bool' as const, default: false },
  { id: 'deselect', label: 'Deselect', type: 'bool' as const, default: false },
  { id: 'toggle', label: 'Toggle', type: 'bool' as const, default: false },
];

registerOperators([
  {
    idname: 'view3d.select',
    label: 'Select',
    description: 'Select or activate what is under a location in the viewport',
    undo: false,
    poll: () => !!activeView3D(),
    props: [
      ...modsProps,
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: false },
      { id: 'select_passthrough', label: 'Only Select Unselected', type: 'bool', default: false, hidden: true },
      { id: 'center', label: 'Center', type: 'bool', default: false },
      { id: 'enumerate', label: 'Enumerate', type: 'bool', default: false },
      { id: 'object', label: 'Object', type: 'bool', default: false },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
    ],
    exec: (ctx, p) => {
      const v = activeView3D()!;
      const { x, y } = viewportLocation(ctx, v, p.location);
      const mods = { extend: !!p.extend, deselect: !!p.deselect, toggle: !!p.toggle };
      if (p.enumerate && openSelectMenu(v, x, y, mods, ctx.event ? { x: ctx.event.x, y: ctx.event.y } : undefined)) return 'FINISHED';
      // select passthrough: clicking an already selected object keeps the selection (so a drag can move it all)
      if (p.select_passthrough && app.doc.mode === 'OBJECT') {
        const top = v.pick(x, y, 8)?.id;
        if (top && app.doc.objects[top]?.select) {
          app.doc.scene.active_object = top;
          app.changed('select');
          return 'FINISHED';
        }
      }
      selectPick(v, x, y, { extend: !!p.extend, toggle: !!p.toggle, deselect: !!p.deselect, deselectAll: !!p.deselect_all && !p.extend && !p.toggle });
      return 'FINISHED';
    },
  },
  {
    idname: 'view3d.select_menu',
    label: 'Select Menu',
    description: 'Choose which of the objects under the pointer to select',
    undo: false,
    poll: () => !!activeView3D() && app.doc.mode === 'OBJECT',
    props: [{ id: 'name', label: 'Object Name', type: 'string', default: '' }, ...modsProps],
    invoke: (ctx, p) => {
      if (p.name) return runByName(p);
      const v = activeView3D()!;
      const { x, y } = viewportLocation(ctx, v, null);
      openSelectMenu(v, x, y, { extend: !!p.extend, deselect: !!p.deselect, toggle: !!p.toggle }, ctx.event ? { x: ctx.event.x, y: ctx.event.y } : undefined);
      return 'CANCELLED';
    },
    exec: (_ctx, p) => runByName(p),
  },
  {
    idname: 'view3d.bone_select_menu',
    label: 'Bone Select Menu',
    description: 'Choose which of the bones under the pointer to select',
    undo: false,
    poll: () => !!activeView3D() && app.doc.mode === 'POSE',
    props: [{ id: 'name', label: 'Bone Name', type: 'string', default: '' }, ...modsProps],
    invoke: (ctx, p) => {
      if (p.name) return selectBoneByName(String(p.name), p) ? 'FINISHED' : 'CANCELLED';
      const v = activeView3D()!;
      const { x, y } = viewportLocation(ctx, v, null);
      openSelectMenu(v, x, y, { extend: !!p.extend, deselect: !!p.deselect, toggle: !!p.toggle }, ctx.event ? { x: ctx.event.x, y: ctx.event.y } : undefined);
      return 'CANCELLED';
    },
    exec: (_ctx, p) => (selectBoneByName(String(p.name), p) ? 'FINISHED' : 'CANCELLED'),
  },
]);

const SELECT_MODES: [string, string][] = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
  ['XOR', 'Difference'],
  ['AND', 'Intersect'],
];

registerOperators([
  {
    idname: 'view3d.select_lasso',
    label: 'Lasso Select',
    description: 'Select items inside a lasso drawn with the left mouse button',
    undo: false,
    poll: () => !!activeView3D(),
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'SET', items: SELECT_MODES },
      { id: 'path', label: 'Path', type: 'string', default: '', hidden: true },
    ],
    invoke: (_ctx, p) => {
      if (p.path) return lassoFromPath(p);
      const v = activeView3D()!;
      app.startModal({
        label: 'Lasso Select',
        header: () => 'Lasso Select: drag with the left mouse button · RMB / Esc to cancel',
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          lassoDrag(v, e, p.mode as SelectMode);
          return 'CANCELLED';
        },
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
        cancel() {},
      });
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) => lassoFromPath(p),
  },
]);

/** Lasso selection from a path of viewport points ("x,y x,y …", for scripts). */
function lassoFromPath(p: Record<string, unknown>) {
  const v = activeView3D()!;
  const pts = String(p.path)
    .trim()
    .split(/\s+/)
    .map((q) => q.split(',').map(Number))
    .filter((q) => q.length === 2 && q.every(Number.isFinite))
    .map(([x, y]) => ({ x, y }));
  if (pts.length < 3) return 'CANCELLED' as const;
  selectInRegion(v, { kind: 'lasso', pts }, p.mode as SelectMode, 'Lasso Select');
  return 'FINISHED' as const;
}

function runByName(p: Record<string, unknown>) {
  const ob = Object.values(app.doc.objects).find((o) => o.name === p.name);
  if (!ob) {
    app.report('ERROR', `No object named "${p.name}"`);
    return 'CANCELLED' as const;
  }
  return selectObjectById(ob.id, p) ? ('FINISHED' as const) : ('CANCELLED' as const);
}
