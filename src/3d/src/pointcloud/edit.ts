// Point Cloud Edit Mode: select (click, box, circle, lasso, all, random), transform, delete,
// duplicate, separate and set attribute values of points; the Select / Point Cloud menus, the
// context menu and the "Point Cloud" keymap.
import { Box3, Matrix3, Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, registerOperators, type OpContext } from '../app/app';
import { modeHandlers } from '../ops/modes';
import { MODE_ITEMS } from '../editors/view3d/header';
import { editModeHooks, viewportExtensions, type SelectRegion } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { inSelectRegion } from '../editors/view3d/selectshapes';
import { transformProviders, startTransform, type TElement } from '../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../editors/view3d/gizmo';
import { frameHooks } from '../ops/view3d';
import { proportionalWeights } from '../modes/proportional';
import { modeMenus } from '../editors/view3d/modemenus';
import { addKeys } from '../app/keymap';
import { transformSubmenu, mirrorSubmenu, snapSubmenu, mirrorMenuItems } from '../modes/common-menus';
import { toolsByMode, COMMON_TOOLS } from '../editors/view3d/toolbar';
import type { MenuItem } from '../ui/menu';
import { dataComps } from '../geonodes/types';
import { newObject } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import { transformModes } from '../modes/transformmodes';
import { startValueModal } from '../modes/valuemodal';
import { applySelectAction, randomSelection, duplicatePoints, radii, newPointCloud, pointCloudOf, pointCount, selection, setAttr, setSelection, subsetPoints, uniquePointCloudName, SELECTION } from './data';
import type { PointCloudData } from './types';
import type { ObjectData } from '../data/types';

export function activePointCloud(): { ob: ObjectData; pc: PointCloudData } | null {
  const ob = app.activeObject;
  const pc = pointCloudOf(app.doc, ob);
  return ob && pc ? { ob, pc } : null;
}
export const inPointCloudEdit = () => app.doc.mode === 'EDIT' && !!activePointCloud();
const worldOf = (ob: ObjectData) => app.graph.get(ob.id)?.world.clone() ?? new Matrix4();
const editPoll = () => inPointCloudEdit();

// ---------------------------------------------------------------------------
// mode

const prevEdit = modeHandlers.EDIT;
modeHandlers.EDIT = {
  ...prevEdit,
  enter(ob) {
    if (ob.type === 'POINTCLOUD') return !!pointCloudOf(app.doc, ob);
    return prevEdit?.enter ? prevEdit.enter(ob) : true;
  },
  exit() {
    prevEdit?.exit?.();
  },
};
const editItem = MODE_ITEMS.find((m) => m.mode === 'EDIT');
if (editItem && !editItem.types.includes('POINTCLOUD')) editItem.types.push('POINTCLOUD');

onAppReady(() => {
  const prev = operators.get('object.editmode_toggle');
  if (!prev) return;
  registerOperator({ ...prev, poll: (ctx) => app.activeObject?.type === 'POINTCLOUD' || !prev.poll || prev.poll(ctx) });
});

toolsByMode.EDIT_POINTCLOUD = [...COMMON_TOOLS];

// ---------------------------------------------------------------------------
// selection helpers (pure)

const combine = (cur: number, hit: number, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') => (mode === 'SET' ? hit : mode === 'ADD' ? cur | hit : mode === 'SUB' ? cur & (hit ^ 1) : mode === 'AND' ? cur & hit : cur ^ hit);

// ---------------------------------------------------------------------------
// operators

function duplicateSelected(pc: PointCloudData): boolean {
  const sel = selection(pc);
  const idx: number[] = [];
  for (let i = 0; i < sel.length; i++) if (sel[i]) idx.push(i);
  if (!idx.length) return false;
  const n = pointCount(pc);
  const d = duplicatePoints(pc, idx);
  pc.positions = d.positions;
  pc.attributes = d.attributes;
  // the copies become the selection
  const ns = new Uint8Array(n + idx.length);
  ns.fill(1, n);
  setSelection(pc, ns);
  return true;
}

registerOperators([
  {
    idname: 'pointcloud.select_all',
    label: '(De)select All',
    description: 'Change the selection of all points',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { pc } = activePointCloud()!;
      setSelection(pc, applySelectAction(selection(pc), String(p.action)));
    },
  },
  {
    idname: 'pointcloud.select_random',
    label: 'Select Random',
    description: 'Randomly select or deselect points',
    props: [
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0 },
      { id: 'probability', label: 'Probability', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { pc } = activePointCloud()!;
      // starting from nothing: the result is a random subset
      setSelection(pc, randomSelection(new Uint8Array(pointCount(pc)), Number(p.probability), Number(p.seed), true));
    },
  },
  {
    idname: 'pointcloud.delete',
    label: 'Delete',
    description: 'Remove the selected points',
    poll: editPoll,
    exec: () => {
      const { pc } = activePointCloud()!;
      const sel = selection(pc);
      if (!sel.some((x) => x)) return 'CANCELLED';
      const r = subsetPoints(pc, Uint8Array.from(sel, (x) => (x ? 0 : 1)));
      pc.positions = r.positions;
      pc.attributes = r.attributes;
    },
  },
  {
    idname: 'pointcloud.duplicate',
    label: 'Duplicate',
    description: 'Copy the selected points',
    poll: editPoll,
    exec: () => (duplicateSelected(activePointCloud()!.pc) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'pointcloud.duplicate_move',
    label: 'Duplicate',
    description: 'Copy the selected points and move them',
    poll: editPoll,
    invoke: (ctx) => {
      if (!duplicateSelected(activePointCloud()!.pc)) return 'CANCELLED';
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate' });
      return 'RUNNING_MODAL';
    },
    exec: () => (duplicateSelected(activePointCloud()!.pc) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'pointcloud.separate',
    label: 'Separate',
    description: 'Move the selected points into a new point cloud object',
    poll: editPoll,
    exec: (ctx) => {
      const { ob, pc } = activePointCloud()!;
      const sel = selection(pc);
      if (!sel.some((x) => x)) return 'CANCELLED';
      const moved = subsetPoints(pc, sel);
      const kept = subsetPoints(pc, Uint8Array.from(sel, (x) => (x ? 0 : 1)));
      pc.positions = kept.positions;
      pc.attributes = kept.attributes;
      const npc = newPointCloud(uniquePointCloudName(ctx.doc, pc.name));
      npc.positions = moved.positions;
      npc.attributes = moved.attributes;
      npc.materials = [...pc.materials];
      ctx.doc.pointclouds![npc.id] = npc;
      const nob = newObject(ob.name, 'POINTCLOUD', npc.id);
      nob.parent = ob.parent;
      nob.matrix_parent_inverse = ob.matrix_parent_inverse ? [...ob.matrix_parent_inverse] : ob.matrix_parent_inverse;
      const active = ob.id;
      addObjectToScene(ctx.doc, nob, { location: [...ob.location], rotation: [...ob.rotation_euler] });
      nob.scale = [...ob.scale];
      nob.rotation_mode = ob.rotation_mode;
      // stay in Edit Mode on the original object
      nob.select = false;
      ctx.doc.objects[active].select = true;
      ctx.doc.scene.active_object = active;
    },
  },
  {
    idname: 'pointcloud.attribute_set',
    label: 'Set Attribute',
    description: 'Set the value of the active attribute on the selected points',
    props: [
      { id: 'value_float', label: 'Value', type: 'float', default: 0 },
      { id: 'value_vector', label: 'Value', type: 'vec3', default: [0, 0, 0] },
      { id: 'value_color', label: 'Value', type: 'color', default: [1, 1, 1, 1] },
    ],
    poll: () => {
      const a = activePointCloud();
      return inPointCloudEdit() && !!a && !!a.pc.attributes[a.pc.active_attribute ?? -1];
    },
    exec: (_ctx, p) => {
      const { pc } = activePointCloud()!;
      const a = pc.attributes[pc.active_attribute ?? -1];
      if (!a || a.name === SELECTION) return 'CANCELLED';
      const sel = selection(pc);
      const comps = dataComps(a.data_type);
      const out = a.data.slice();
      const val: number[] = comps === 1 ? [Number(p.value_float)] : comps === 4 ? (p.value_color as number[]) : (p.value_vector as number[]);
      for (let i = 0; i < sel.length; i++) {
        if (!sel[i]) continue;
        for (let k = 0; k < comps; k++) {
          let x = val[k] ?? 0;
          if (a.data_type === 'INT' || a.data_type === 'INT8') x = Math.round(x);
          if (a.data_type === 'BOOLEAN') x = x ? 1 : 0;
          out[i * comps + k] = x;
        }
      }
      setAttr(pc, a.name, a.data_type, out);
    },
  },
]);

// ---------------------------------------------------------------------------
// picking & region selection

function projectAll(v: View3D, ob: ObjectData, pc: PointCloudData) {
  const w = worldOf(ob);
  const n = pointCount(pc);
  const out = new Float32Array(n * 3);
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    p.fromArray(pc.positions, i * 3).applyMatrix4(w);
    const s = v.project(p);
    out[i * 3] = s.x;
    out[i * 3 + 1] = s.y;
    out[i * 3 + 2] = s.z;
  }
  return out;
}

let activePoint = -1;

editModeHooks.pick.push((v, x, y, o) => {
  const a = inPointCloudEdit() ? activePointCloud() : null;
  if (!a) return false;
  const { pc } = a;
  const S = projectAll(v, a.ob, pc);
  let hit = -1,
    bd = 12 * 12;
  for (let i = 0; i < pointCount(pc); i++) {
    if (S[i * 3 + 2] > 1) continue;
    const d = (S[i * 3] - x) ** 2 + (S[i * 3 + 1] - y) ** 2;
    if (d < bd) {
      bd = d;
      hit = i;
    }
  }
  if (hit < 0 && !o.deselectAll && (o.extend || o.toggle || o.deselect)) return true;
  const sel = selection(pc);
  if (!o.extend && !o.toggle && !o.deselect) sel.fill(0);
  if (hit >= 0) sel[hit] = o.deselect ? 0 : o.toggle ? (sel[hit] ? 0 : 1) : 1;
  activePoint = hit >= 0 && sel[hit] ? hit : -1;
  setSelection(pc, sel);
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const a = inPointCloudEdit() ? activePointCloud() : null;
  if (!a) return false;
  const S = projectAll(v, a.ob, a.pc);
  const sel = selection(a.pc);
  for (let i = 0; i < sel.length; i++) sel[i] = combine(sel[i], S[i * 3 + 2] <= 1 && inSelectRegion(r, S[i * 3], S[i * 3 + 1]) ? 1 : 0, mode);
  setSelection(a.pc, sel);
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}
editModeHooks.box.push((v, x0, y0, x1, y1, mode) => regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select'));
editModeHooks.region.push((v, r, mode) => regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select'));

// ---------------------------------------------------------------------------
// transforms

function selectedWorldPoints() {
  const a = activePointCloud();
  if (!a) return [];
  const sel = selection(a.pc);
  const w = worldOf(a.ob);
  const out: Vector3[] = [];
  for (let i = 0; i < sel.length; i++) if (sel[i]) out.push(new Vector3().fromArray(a.pc.positions, i * 3).applyMatrix4(w));
  return out;
}

transformProviders.push({
  collect({ proportional, connected }) {
    const a = inPointCloudEdit() ? activePointCloud() : null;
    if (!a) return null;
    const pc = a.pc;
    const sel = selection(pc);
    if (!sel.some((x) => x)) return null;
    const w = worldOf(a.ob),
      inv = w.clone().invert();
    pc.positions = pc.positions.slice();
    const before = pc.positions.slice();
    const n = sel.length;
    const pts = Array.from({ length: n }, (_, i) => new Vector3().fromArray(before, i * 3).applyMatrix4(w));
    let weight: Float32Array = Float32Array.from(sel);
    let dist: Float32Array = new Float32Array(n);
    // points are unconnected: proportional editing uses plain distances
    if (proportional) ({ weight, dist } = proportionalWeights(pts, Array.from(sel, Boolean), connected, () => []));
    const basis = new Matrix3().setFromMatrix4(w);
    const els: TElement[] = [];
    const tmp = new Vector3();
    for (let i = 0; i < n; i++) {
      if (!weight[i]) continue;
      const p0 = pts[i];
      els.push({
        center: p0,
        basis,
        weight: weight[i],
        distance: dist[i],
        apply(m: Matrix4) {
          tmp.copy(p0).applyMatrix4(m).applyMatrix4(inv).toArray(pc.positions, i * 3);
        },
        restore() {
          pc.positions.set(before);
        },
      });
    }
    if (!els.length) return null;
    return {
      elements: els,
      active: activePoint >= 0 && activePoint < n && sel[activePoint] ? pts[activePoint] : undefined,
      label: 'Points',
      finish() {},
      cancel() {},
      onUpdate: () => {
        pc.positions = pc.positions.slice();
        app.changed('doc');
      },
    };
  },
});

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inPointCloudEdit()) {
    const pts = selectedWorldPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inPointCloudEdit()) return null;
  const pts = selectedWorldPoints();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});

// ---------------------------------------------------------------------------
// menus & keymap

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'pointcloud.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'pointcloud.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'pointcloud.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Random', op: 'pointcloud.select_random' },
  ];
}

function pointCloudMenu(): MenuItem[] {
  return [
    transformSubmenu([{ label: 'Radius', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' }]),
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Duplicate', op: 'pointcloud.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Set Attribute', op: 'pointcloud.attribute_set' },
    { label: 'Delete', op: 'pointcloud.delete', shortcut: 'X' },
    { label: 'Separate', op: 'pointcloud.separate', shortcut: 'P' },
  ];
}

function contextMenu(): MenuItem[] {
  return [
    { heading: 'Point Cloud' },
    { label: 'Duplicate', op: 'pointcloud.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Separate', op: 'pointcloud.separate', shortcut: 'P' },
    { label: 'Delete', op: 'pointcloud.delete', shortcut: 'X' },
  ];
}

const prevMenus = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevMenus,
  header: () => (inPointCloudEdit() ? [['Point Cloud', pointCloudMenu]] : (prevMenus?.header?.() ?? [])),
  select: () => (inPointCloudEdit() ? selectMenu() : (prevMenus?.select?.() ?? [])),
  add: () => (inPointCloudEdit() ? [] : (prevMenus?.add?.() ?? [])),
  context: () => (inPointCloudEdit() ? contextMenu() : (prevMenus?.context?.() ?? [])),
  headerLead: () => (inPointCloudEdit() ? null : (prevMenus?.headerLead?.() ?? null)),
  headerExtra: () => (inPointCloudEdit() ? null : (prevMenus?.headerExtra?.() ?? null)),
};

const e = inPointCloudEdit;
addKeys('Point Cloud', [
  { key: 'D', shift: true, op: 'pointcloud.duplicate_move', when: e },
  { key: 'A', op: 'pointcloud.select_all', props: { action: 'SELECT' }, when: e },
  { key: 'A', alt: true, op: 'pointcloud.select_all', props: { action: 'DESELECT' }, when: e },
  { key: 'I', ctrl: true, op: 'pointcloud.select_all', props: { action: 'INVERT' }, when: e },
  { key: 'A', value: 'DOUBLE_CLICK', op: 'pointcloud.select_all', props: { action: 'DESELECT' }, when: e },
  { key: 'X', op: 'pointcloud.delete', when: e },
  { key: 'DEL', op: 'pointcloud.delete', when: e },
  { key: 'P', op: 'pointcloud.separate', when: e },
  { key: 'M', ctrl: true, menu: mirrorMenuItems, menuTitle: 'Mirror', when: e },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, when: e },
  { key: 'W', menu: contextMenu, when: e },
]);

viewportExtensions.push((v) => {
  if (!v.keymaps.includes('Point Cloud')) v.keymaps.unshift('Point Cloud');
});

// ---------------------------------------------------------------------------
// Alt S scales the radius of the selected points

function radiusSnapshot() {
  const a = activePointCloud();
  if (!a) return null;
  const sel = selection(a.pc);
  if (!sel.some((x) => x)) return null;
  const orig = radii(a.pc).slice();
  const w = worldOf(a.ob);
  const pivot = new Vector3();
  let n = 0;
  for (let i = 0; i < sel.length; i++)
    if (sel[i]) {
      pivot.add(new Vector3().fromArray(a.pc.positions, i * 3).applyMatrix4(w));
      n++;
    }
  pivot.multiplyScalar(1 / n);
  const set = (f: (v: number) => number) => {
    const out = orig.slice();
    for (let i = 0; i < sel.length; i++) if (sel[i]) out[i] = f(orig[i]);
    setAttr(a.pc, 'radius', 'FLOAT', out);
  };
  return { pivot, set, restore: () => setAttr(a.pc, 'radius', 'FLOAT', orig) };
}

const prevRadius = transformModes.CURVE_SHRINKFATTEN;
transformModes.CURVE_SHRINKFATTEN = {
  label: prevRadius?.label ?? 'Radius',
  poll: (ctx: OpContext) => (inPointCloudEdit() ? !!radiusSnapshot() : (prevRadius?.poll(ctx) ?? false)),
  invoke: (ctx, p) => {
    if (!inPointCloudEdit()) return prevRadius ? prevRadius.invoke(ctx, p) : 'CANCELLED';
    const s = radiusSnapshot();
    if (!s) return 'CANCELLED';
    const ok = startValueModal({
      label: 'Radius',
      kind: 'SCALE',
      pivot: s.pivot,
      event: ctx.event,
      apply: (v) => s.set((r) => Math.max(0, r * v)),
      restore: s.restore,
      redo: (v) => ({ idname: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN', value: v } }),
      text: (v, t) => `Radius: ${t ? t + '|' : v.toFixed(3)}`,
      releaseConfirm: !!p.release_confirm,
    });
    return ok ? 'RUNNING_MODAL' : 'CANCELLED';
  },
  exec: (ctx, p) => {
    if (!inPointCloudEdit()) return prevRadius ? prevRadius.exec(ctx, p) : 'CANCELLED';
    const s = radiusSnapshot();
    if (!s) return 'CANCELLED';
    s.set((r) => Math.max(0, r * ((p.value as number) || 1)));
  },
};

