// Metaball Edit Mode: element rings overlay, picking / box / circle / lasso selection,
// G/R/S transforms (scale changes the radius, or the stiffness after clicking the inner ring),
// header menus, context menu, keymap and toolbar.
import { transformSubmenu, mirrorSubmenu, snapSubmenu } from '../modes/common-menus';
import { activeElementHooks } from '../modes/editxform';
import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { editModeHooks, type SelectRegion } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { modeMenus } from '../editors/view3d/modemenus';
import { toolsByMode, COMMON_TOOLS } from '../editors/view3d/toolbar';
import { MODE_ITEMS } from '../editors/view3d/header';
import { setGizmoCenterHook, gizmoCenterHook } from '../editors/view3d/gizmo';
import { frameHooks } from '../ops/view3d';
import { modeHandlers } from '../ops/modes';
import { transformProviders, type TElement } from '../ops/transform';
import { h, type VNode } from '../ui/h';
import type { MenuItem } from '../ui/menu';
import type { ObjectData } from '../data/types';
import { ELEMENT_TYPES } from './data';
import { mballLive } from './eval';
import { activeMetaball, inMetaEdit } from './ops';
import type { MetaballData, MetaElement } from './types';

const world = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();
const V3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

/** Inner ring radius as a fraction of the influence radius. */
export const stiffnessRingFactor = (stiffness: number) => Math.atan(Math.max(0, stiffness)) / (Math.PI / 2);

/** When set, scaling changes the stiffness of the selected elements instead of their radius. */
let scaleStiffness = false;

interface Ring {
  index: number;
  cx: number;
  cy: number;
  r: number;
  s: number;
}

/** Screen-space rings of the visible elements. */
export function rings(v: View3D, ob: ObjectData, mb: MetaballData): Ring[] {
  const w = world(ob);
  const scale = new Vector3().setFromMatrixScale(w);
  const objScale = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
  const right = new Vector3().setFromMatrixColumn(v.camera.matrixWorld, 0).normalize();
  const out: Ring[] = [];
  mb.elements.forEach((e, index) => {
    if (e.hide) return;
    const c = V3(e.co).applyMatrix4(w);
    const p = v.project(c);
    if (p.z > 1) return;
    const q = v.project(c.clone().addScaledVector(right, e.radius * objScale));
    const r = Math.hypot(q.x - p.x, q.y - p.y);
    out.push({ index, cx: p.x, cy: p.y, r, s: r * stiffnessRingFactor(e.stiffness) });
  });
  return out;
}

const RING_TOL = 6;

/** The element under the cursor and whether its stiffness ring was hit. */
function pickElement(v: View3D, x: number, y: number): { index: number; stiffness: boolean } | null {
  const a = activeMetaball();
  if (!a) return null;
  let best: { index: number; stiffness: boolean; d: number } | null = null;
  for (const g of rings(v, a.ob, a.mb)) {
    const d = Math.hypot(x - g.cx, y - g.cy);
    const dr = Math.abs(d - g.r),
      ds = Math.abs(d - g.s);
    if (ds < RING_TOL && (!best || ds < best.d)) best = { index: g.index, stiffness: true, d: ds };
    if (dr < RING_TOL && (!best || dr < best.d)) best = { index: g.index, stiffness: false, d: dr };
    if (d < RING_TOL && (!best || d < best.d)) best = { index: g.index, stiffness: false, d };
  }
  if (best) return best;
  // fall back to the smallest ring containing the cursor
  let inside: Ring | null = null;
  for (const g of rings(v, a.ob, a.mb)) if (Math.hypot(x - g.cx, y - g.cy) < g.r && (!inside || g.r < inside.r)) inside = g;
  return inside ? { index: inside.index, stiffness: false } : null;
}

editModeHooks.pick.push((v, x, y, o) => {
  if (!inMetaEdit()) return false;
  const { mb } = activeMetaball()!;
  const hit = pickElement(v, x, y);
  if (!hit) {
    if (o.deselectAll !== false && !o.extend) for (const e of mb.elements) e.select = false;
    mb.active_element = -1;
  } else {
    const e = mb.elements[hit.index];
    if (!o.extend && !o.toggle) for (const x of mb.elements) x.select = false;
    const on = o.toggle ? !(e.select && mb.active_element === hit.index) : true;
    e.select = on;
    mb.active_element = on ? hit.index : -1;
    scaleStiffness = hit.stiffness;
  }
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function combine(cur: boolean, hit: boolean, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') {
  return mode === 'SET' ? hit : mode === 'ADD' ? cur || hit : mode === 'SUB' ? cur && !hit : mode === 'AND' ? cur && hit : cur !== hit;
}

function inLasso(x: number, y: number, pts: { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i],
      b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function regionSelect(v: View3D, test: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const { ob, mb } = activeMetaball()!;
  const hits = new Map(rings(v, ob, mb).map((g) => [g.index, test(g.cx, g.cy)]));
  mb.elements.forEach((e, i) => {
    if (e.hide) return;
    e.select = combine(!!e.select, !!hits.get(i), mode);
  });
  if (mb.active_element !== undefined && mb.active_element >= 0 && !mb.elements[mb.active_element]?.select) mb.active_element = -1;
  scaleStiffness = false;
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => {
  if (!inMetaEdit()) return false;
  const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  return regionSelect(v, (x, y) => x >= lx && x <= hx && y >= ly && y <= hy, mode, 'Box Select');
});

editModeHooks.region.push((v, r: SelectRegion, mode) => {
  if (!inMetaEdit()) return false;
  if (r.kind === 'circle') return regionSelect(v, (x, y) => Math.hypot(x - r.x, y - r.y) <= r.r, mode, 'Circle Select');
  if (r.kind === 'lasso') return regionSelect(v, (x, y) => inLasso(x, y, r.pts), mode, 'Lasso Select');
  return regionSelect(v, (x, y) => x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1), mode, 'Box Select');
});

editModeHooks.svg.push((v) => {
  if (!inMetaEdit()) return null;
  const { ob, mb } = activeMetaball()!;
  const parts: VNode[] = [];
  for (const g of rings(v, ob, mb)) {
    const e = mb.elements[g.index];
    const active = mb.active_element === g.index && e.select;
    const radCol = e.select ? (active ? '#ffffff' : '#f58e04') : '#d9dadc';
    const stiffCol = e.select ? (active ? '#e6fed9' : '#93e16c') : '#579949';
    const dash = e.use_negative ? '5 3' : undefined;
    parts.push(
      h(
        'g',
        { key: `mb${g.index}`, 'data-element': g.index },
        h('circle', { cx: g.cx, cy: g.cy, r: g.r, fill: 'none', stroke: '#000000', 'stroke-width': 3, opacity: 0.35 }),
        h('circle', { cx: g.cx, cy: g.cy, r: g.r, fill: 'none', stroke: radCol, 'stroke-width': 1.5, 'stroke-dasharray': dash }),
        h('circle', { cx: g.cx, cy: g.cy, r: g.s, fill: 'none', stroke: stiffCol, 'stroke-width': 1.5, 'stroke-dasharray': dash }),
        h('circle', { cx: g.cx, cy: g.cy, r: 2.5, fill: e.select ? radCol : '#0d0e10', stroke: '#000000', 'stroke-width': 0.8 }),
      ),
    );
  }
  return h('g', { class: 'mball-edit' }, parts);
});

// ---------------------------------------------------------------------------
// transforms

transformProviders.push({
  collect() {
    if (!inMetaEdit()) return null;
    const { ob, mb } = activeMetaball()!;
    const sel = mb.elements.filter((e) => e.select && !e.hide);
    if (!sel.length) return null;
    const w = world(ob),
      inv = w.clone().invert();
    const before = structuredClone(mb.elements);
    const stiff = scaleStiffness;
    const els: TElement[] = sel.map((e) => {
      const i = mb.elements.indexOf(e);
      const e0 = before[i];
      const q0 = new Quaternion(e0.rotation[1], e0.rotation[2], e0.rotation[3], e0.rotation[0]).normalize();
      const center = V3(e0.co).applyMatrix4(w);
      const basis = new Matrix3().setFromMatrix4(w.clone().multiply(new Matrix4().makeRotationFromQuaternion(q0)));
      return {
        center,
        basis,
        weight: 1,
        apply(m: Matrix4, ctx) {
          const el = mb.elements[i];
          const local = inv.clone().multiply(m).multiply(w);
          const co = V3(e0.co).applyMatrix4(local);
          el.co = [co.x, co.y, co.z];
          if (ctx.mode === 'RESIZE') {
            const f = Math.cbrt(Math.abs(new Matrix3().setFromMatrix4(local).determinant()));
            if (stiff) el.stiffness = Math.max(0, Math.min(10, e0.stiffness * f));
            else el.radius = Math.max(0, e0.radius * f);
          } else if (ctx.mode === 'ROTATION' || ctx.mode === 'TRACKBALL') {
            const t = new Vector3(),
              q = new Quaternion(),
              s = new Vector3();
            local.decompose(t, q, s);
            const r = q.multiply(q0).normalize();
            el.rotation = [r.w, r.x, r.y, r.z];
          }
        },
        restore() {
          mb.elements[i] = structuredClone(e0);
        },
      } as TElement;
    });
    const act = mb.active_element !== undefined && mb.active_element >= 0 ? mb.elements[mb.active_element] : undefined;
    mballLive.transforming = true;
    return {
      elements: els,
      active: act && act.select ? V3(act.co).applyMatrix4(w) : undefined,
      label: 'Metaball',
      finish() {
        mballLive.transforming = false;
        app.changed('doc', 'geometry');
      },
      cancel() {
        mballLive.transforming = false;
        app.changed('doc', 'geometry');
      },
      onUpdate: () => app.changed('doc', 'geometry'),
    };
  },
});

function selectedWorldPoints(): Vector3[] {
  const a = inMetaEdit() ? activeMetaball() : null;
  if (!a) return [];
  const w = world(a.ob);
  return a.mb.elements.filter((e) => e.select && !e.hide).map((e) => V3(e.co).applyMatrix4(w));
}

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inMetaEdit()) {
    const pts = selectedWorldPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inMetaEdit()) return null;
  const { ob, mb } = activeMetaball()!;
  const w = world(ob);
  const box = new Box3();
  for (const e of mb.elements)
    if (e.select && !e.hide) {
      const c = V3(e.co).applyMatrix4(w);
      const r = e.radius * new Vector3().setFromMatrixScale(w).length() / Math.sqrt(3);
      box.expandByPoint(c.clone().addScalar(r)).expandByPoint(c.clone().addScalar(-r));
    }
  return box.isEmpty() ? null : box;
});

// ---------------------------------------------------------------------------
// mode switching, toolbar

const prevEditHandler = modeHandlers.EDIT;
modeHandlers.EDIT = {
  ...prevEditHandler,
  enter(ob) {
    if (ob.type !== 'META') return prevEditHandler?.enter ? prevEditHandler.enter(ob) : false;
    if (!ob.data || !app.doc.metaballs?.[ob.data]) return false;
    const cur = activeTools.EDIT;
    const ids = new Set(toolsByMode.EDIT_META.filter(Boolean).map((t) => t!.id));
    if (cur && !cur.startsWith('builtin.select') && !ids.has(cur)) activeTools.EDIT = 'builtin.select_box';
    scaleStiffness = false;
    return true;
  },
};

toolsByMode.EDIT_META = [...COMMON_TOOLS];

const editItem = MODE_ITEMS.find((m) => m.mode === 'EDIT');
if (editItem && !editItem.types.includes('META')) editItem.types.push('META');

// ---------------------------------------------------------------------------
// menus & keys

const showHideMenu = (): MenuItem[] => [
  { label: 'Reveal Hidden', op: 'mball.reveal_metaelems', shortcut: 'Alt H' },
  { label: 'Hide Selected', op: 'mball.hide_metaelems', props: { unselected: false }, shortcut: 'H' },
  { label: 'Hide Unselected', op: 'mball.hide_metaelems', props: { unselected: true }, shortcut: 'Shift H' },
];

const similarMenu = (): MenuItem[] =>
  [
    ['TYPE', 'Type'],
    ['RADIUS', 'Radius'],
    ['STIFFNESS', 'Stiffness'],
    ['ROTATION', 'Rotation'],
  ].map(([t, l]) => ({ label: l, op: 'mball.select_similar', props: { type: t } }));

function metaballMenu(): MenuItem[] {
  return [
    transformSubmenu(),
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Duplicate Metaball Elements', op: 'mball.duplicate_metaelems' },
    { separator: true },
    { label: 'Show/Hide', submenu: showHideMenu },
    { separator: true },
    { label: 'Delete', op: 'mball.delete_metaelems', shortcut: 'X' },
  ];
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'mball.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'mball.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'mball.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Select Random', op: 'mball.select_random_metaelems' },
    { separator: true },
    { label: 'Select Similar', submenu: similarMenu, shortcut: 'Shift G' },
  ];
}

function addElementMenu(): MenuItem[] {
  return ELEMENT_TYPES.map(([type, label, icon]) => ({ label, icon, op: 'object.metaball_add', props: { type } }));
}

function contextMenu(): MenuItem[] {
  return [
    { label: 'Duplicate', op: 'mball.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    mirrorSubmenu(),
    snapSubmenu(),
    { separator: true },
    { label: 'Delete', op: 'mball.delete_metaelems', shortcut: 'X' },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inMetaEdit() ? [['Metaball', metaballMenu]] : (prevEdit?.header?.() ?? [])),
  select: () => (inMetaEdit() ? selectMenu() : (prevEdit?.select?.() ?? [])),
  add: () => (inMetaEdit() ? addElementMenu() : (prevEdit?.add?.() ?? [])),
  context: () => (inMetaEdit() ? contextMenu() : (prevEdit?.context?.() ?? [])),
  headerExtra: () => (inMetaEdit() ? null : (prevEdit?.headerExtra?.() ?? null)),
};

addKeys('Metaball', [
  { key: 'A', op: 'mball.select_all', props: { action: 'SELECT' }, when: inMetaEdit },
  { key: 'A', alt: true, op: 'mball.select_all', props: { action: 'DESELECT' }, when: inMetaEdit },
  { key: 'I', ctrl: true, op: 'mball.select_all', props: { action: 'INVERT' }, when: inMetaEdit },
  { key: 'A', shift: true, menu: addElementMenu, menuTitle: 'Add', when: inMetaEdit },
  { key: 'G', shift: true, menu: similarMenu, menuTitle: 'Select Similar', when: inMetaEdit },
  { key: 'X', op: 'mball.delete_metaelems', when: inMetaEdit },
  { key: 'DEL', op: 'mball.delete_metaelems', when: inMetaEdit },
  { key: 'D', shift: true, op: 'mball.duplicate_move', when: inMetaEdit },
  { key: 'H', op: 'mball.hide_metaelems', props: { unselected: false }, when: inMetaEdit },
  { key: 'H', shift: true, op: 'mball.hide_metaelems', props: { unselected: true }, when: inMetaEdit },
  { key: 'H', alt: true, op: 'mball.reveal_metaelems', when: inMetaEdit },
]);

export type { MetaElement };

activeElementHooks.push(() => {
  if (!inMetaEdit()) return null;
  const { ob, mb } = activeMetaball()!;
  const e = mb.elements[mb.active_element ?? -1];
  return e && !e.hide ? V3(e.co).applyMatrix4(world(ob)) : null;
});
