// Lattice Edit Mode: point selection (mirror, random, more / less, circle / lasso) and transforms,
// resolution changes, Make Regular, Flip.
import { Matrix3, Matrix4, Vector3, Box3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { h } from '../../ui/h';
import type { LatticeData, ObjectData } from '../../data/types';
import { transformProviders, type TElement } from '../../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks } from '../../ops/view3d';
import { modeMenus } from '../../editors/view3d/modemenus';
import { addKeys } from '../../app/keymap';
import type { MenuItem } from '../../ui/menu';
import { inSelectRegion } from '../../editors/view3d/selectshapes';
import type { SelectRegion } from '../../editors/view3d/hooks';
import { transformSubmenu, mirrorSubmenu, snapSubmenu } from '../common-menus';
import * as L from './latticeops';
import { proportionalWeights } from '../proportional';
import { activeElementHooks } from '../editxform';

type LatticeSel = LatticeData & { select?: Uint8Array };

function activeLattice(): { ob: ObjectData; lt: LatticeSel } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'LATTICE' || !ob.data) return null;
  const lt = app.doc.lattices[ob.data] as LatticeSel | undefined;
  return lt ? { ob, lt } : null;
}
const inLatticeEdit = () => app.doc.mode === 'EDIT' && !!activeLattice();

/** Last clicked point (session state), the active element for Selection to Active. */
let activePoint = -1;
activeElementHooks.push(() => {
  const a = inLatticeEdit() ? activeLattice() : null;
  if (!a || activePoint < 0 || activePoint * 3 >= a.lt.points.length || !a.lt.select?.[activePoint]) return null;
  return pointWorld(a.lt, activePoint, world(a.ob));
});

/** Selection flags; `write` gives a fresh copy (arrays are shared with undo snapshots). */
function ensureSel(lt: LatticeSel, write = false) {
  const n = lt.points.length / 3;
  if (!lt.select || lt.select.length !== n) lt.select = new Uint8Array(n);
  else if (write) lt.select = lt.select.slice();
  return lt.select;
}

const world = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();
const pointWorld = (lt: LatticeData, i: number, w: Matrix4) => new Vector3(lt.points[i * 3], lt.points[i * 3 + 1], lt.points[i * 3 + 2]).applyMatrix4(w);

/** Regular grid coordinate along one axis (a single point sits at the centre). */
const gridCoord = (i: number, n: number) => (n > 1 ? i / (n - 1) - 0.5 : 0);

/** Sample the current point offsets (from the regular grid) trilinearly at normalised coords. */
function sampleOffset(lt: LatticeData, u: number, v: number, w: number): [number, number, number] {
  const U = lt.points_u,
    V = lt.points_v,
    W = lt.points_w;
  const idx = (i: number, j: number, k: number) => (k * V + j) * U + i;
  const cell = (t: number, n: number) => {
    if (n <= 1) return [0, 0, 0] as const;
    const x = Math.max(0, Math.min(n - 1, (t + 0.5) * (n - 1)));
    const i0 = Math.min(n - 2, Math.floor(x));
    return [i0, i0 + 1, x - i0] as const;
  };
  const [i0, i1, fu] = cell(u, U),
    [j0, j1, fv] = cell(v, V),
    [k0, k1, fw] = cell(w, W);
  const out: [number, number, number] = [0, 0, 0];
  for (const [k, wk] of [[k0, 1 - fw], [k1, fw]] as const)
    for (const [j, wj] of [[j0, 1 - fv], [j1, fv]] as const)
      for (const [i, wi] of [[i0, 1 - fu], [i1, fu]] as const) {
        const wgt = wi * wj * wk;
        if (!wgt) continue;
        const p = idx(i, j, k);
        out[0] += (lt.points[p * 3] - gridCoord(i, U)) * wgt;
        out[1] += (lt.points[p * 3 + 1] - gridCoord(j, V)) * wgt;
        out[2] += (lt.points[p * 3 + 2] - gridCoord(k, W)) * wgt;
      }
  return out;
}

/** Change the lattice resolution keeping the current deformation (resampled). */
export function resizeLattice(lt: LatticeSel, U: number, V: number, W: number) {
  const pts = new Float32Array(U * V * W * 3);
  for (let k = 0; k < W; k++)
    for (let j = 0; j < V; j++)
      for (let i = 0; i < U; i++) {
        const u = gridCoord(i, U),
          v = gridCoord(j, V),
          w = gridCoord(k, W);
        const o = sampleOffset(lt, u, v, w);
        const p = ((k * V + j) * U + i) * 3;
        pts[p] = u + o[0];
        pts[p + 1] = v + o[1];
        pts[p + 2] = w + o[2];
      }
  lt.points_u = U;
  lt.points_v = V;
  lt.points_w = W;
  lt.points = pts;
  lt.select = new Uint8Array(U * V * W);
}

registerOperators([
  {
    idname: 'lattice.resize',
    label: 'Lattice Resolution',
    description: 'Apply the lattice resolution (points_u/v/w), resampling the current deformation',
    poll: () => !!activeLattice(),
    exec: () => {
      const { lt } = activeLattice()!;
      const n = lt.points.length / 3;
      const U = Math.max(1, Math.round(lt.points_u)),
        V = Math.max(1, Math.round(lt.points_v)),
        W = Math.max(1, Math.round(lt.points_w));
      if (U * V * W === n) return 'CANCELLED';
      // points_* were already changed by the UI; reconstruct the previous resolution from the point count
      const prev = guessPrevResolution(lt, n, U, V, W);
      Object.assign(lt, { points_u: prev[0], points_v: prev[1], points_w: prev[2] });
      resizeLattice(lt, U, V, W);
    },
  },
  {
    idname: 'lattice.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: inLatticeEdit,
    exec: (_ctx, p) => {
      const sel = ensureSel(activeLattice()!.lt, true);
      let a = p.action as string;
      if (a === 'TOGGLE') a = sel.some((x) => x) ? 'DESELECT' : 'SELECT';
      for (let i = 0; i < sel.length; i++) sel[i] = a === 'SELECT' ? 1 : a === 'DESELECT' ? 0 : sel[i] ^ 1;
    },
    redo: false,
  },
  {
    idname: 'lattice.select_mirror',
    label: 'Select Mirror',
    description: 'Select the points mirrored across the lattice grid',
    props: [
      { id: 'axis', label: 'Axis', type: 'enum', default: 'X', items: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: inLatticeEdit,
    exec: (_ctx, p) => {
      const { lt } = activeLattice()!;
      L.selectMirror(lt, ensureSel(lt, true), p.axis === 'X' ? 0 : p.axis === 'Y' ? 1 : 2, !!p.extend);
    },
  },
  {
    idname: 'lattice.select_random',
    label: 'Select Random',
    description: 'Randomly select or deselect lattice points',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
      { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] },
    ],
    poll: inLatticeEdit,
    exec: (_ctx, p) => {
      const { lt } = activeLattice()!;
      L.selectRandom(ensureSel(lt, true), p.ratio as number, p.seed as number, p.action === 'SELECT');
    },
  },
  {
    idname: 'lattice.select_more',
    label: 'Select More',
    description: 'Grow the selection to neighbouring grid points',
    poll: inLatticeEdit,
    exec: () => {
      const { lt } = activeLattice()!;
      lt.select = L.grow(lt, ensureSel(lt), true);
    },
  },
  {
    idname: 'lattice.select_less',
    label: 'Select Less',
    description: 'Shrink the selection away from unselected grid points',
    poll: inLatticeEdit,
    exec: () => {
      const { lt } = activeLattice()!;
      lt.select = L.grow(lt, ensureSel(lt), false);
    },
  },
  {
    idname: 'lattice.make_regular',
    label: 'Make Regular',
    description: 'Set UVW control points a uniform distance apart',
    poll: () => !!activeLattice(),
    exec: () => {
      const { lt } = activeLattice()!;
      const { points_u: U, points_v: V, points_w: W } = lt;
      lt.points = new Float32Array(lt.points);
      for (let k = 0; k < W; k++)
        for (let j = 0; j < V; j++)
          for (let i = 0; i < U; i++) {
            const p = ((k * V + j) * U + i) * 3;
            lt.points[p] = gridCoord(i, U);
            lt.points[p + 1] = gridCoord(j, V);
            lt.points[p + 2] = gridCoord(k, W);
          }
    },
  },
  {
    idname: 'lattice.flip',
    label: 'Flip (Distortion)',
    description: 'Mirror all control points without inverting the lattice deform',
    props: [{ id: 'axis', label: 'Flip Axis', type: 'enum', default: 'U', items: [['U', 'U (X) Axis'], ['V', 'V (Y) Axis'], ['W', 'W (Z) Axis']] }],
    poll: inLatticeEdit,
    exec: (_ctx, p) => {
      const { lt } = activeLattice()!;
      const { points_u: U, points_v: V, points_w: W } = lt;
      const ax = p.axis === 'U' ? 0 : p.axis === 'V' ? 1 : 2;
      const src = lt.points.slice();
      lt.points = new Float32Array(src.length);
      for (let k = 0; k < W; k++)
        for (let j = 0; j < V; j++)
          for (let i = 0; i < U; i++) {
            const [mi, mj, mk] = ax === 0 ? [U - 1 - i, j, k] : ax === 1 ? [i, V - 1 - j, k] : [i, j, W - 1 - k];
            const d = ((k * V + j) * U + i) * 3,
              s = ((mk * V + mj) * U + mi) * 3;
            for (let c = 0; c < 3; c++) lt.points[d + c] = c === ax ? -src[s + c] : src[s + c];
          }
    },
  },
]);

function guessPrevResolution(lt: LatticeData, n: number, U: number, V: number, W: number): [number, number, number] {
  // exactly one axis changes per edit; find which one keeps the product equal to the point count
  if ((n / (V * W)) % 1 === 0 && n / (V * W) !== U) return [n / (V * W), V, W];
  if ((n / (U * W)) % 1 === 0 && n / (U * W) !== V) return [U, n / (U * W), W];
  if ((n / (U * V)) % 1 === 0 && n / (U * V) !== W) return [U, V, n / (U * V)];
  const c = Math.round(Math.cbrt(n));
  return [c, c, c];
  void lt;
}

// ---------------------------------------------------------------------------
// selection, overlay, transforms

editModeHooks.pick.push((v, x, y, o) => {
  const a = inLatticeEdit() ? activeLattice() : null;
  if (!a) return false;
  const sel = ensureSel(a.lt, true);
  const w = world(a.ob);
  let best = -1,
    bd = 12;
  for (let i = 0; i < sel.length; i++) {
    const p = v.project(pointWorld(a.lt, i, w));
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (!o.extend) sel.fill(0);
  if (best >= 0) sel[best] = o.toggle && sel[best] ? 0 : 1;
  activePoint = best >= 0 && sel[best] ? best : -1;
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: import('../../editors/view3d/view3d').View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const a = inLatticeEdit() ? activeLattice() : null;
  if (!a) return false;
  const sel = ensureSel(a.lt, true);
  const w = world(a.ob);
  for (let i = 0; i < sel.length; i++) {
    const p = v.project(pointWorld(a.lt, i, w));
    const hit = p.z <= 1 && inSelectRegion(r, p.x, p.y) ? 1 : 0;
    const cur = sel[i];
    sel[i] = mode === 'SET' ? hit : mode === 'ADD' ? cur | hit : mode === 'SUB' ? cur & (hit ^ 1) : mode === 'AND' ? cur & hit : cur ^ hit;
  }
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select'));
editModeHooks.region.push((v, r, mode) => regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select'));

editModeHooks.svg.push((v) => {
  const a = inLatticeEdit() ? activeLattice() : null;
  if (!a) return null;
  const sel = ensureSel(a.lt);
  const w = world(a.ob);
  const dots = [];
  for (let i = 0; i < sel.length; i++) {
    const p = v.project(pointWorld(a.lt, i, w));
    if (p.z > 1) continue;
    dots.push(h('circle', { cx: p.x, cy: p.y, r: 3.5, fill: sel[i] ? '#ff8500' : '#000', stroke: sel[i] ? '#ffb15e' : '#666', 'stroke-width': 0.8 }));
  }
  return h('g', { class: 'lattice-edit' }, dots);
});

function selectedPoints() {
  const a = activeLattice();
  if (!a) return [];
  const sel = ensureSel(a.lt);
  const w = world(a.ob);
  const out: Vector3[] = [];
  for (let i = 0; i < sel.length; i++) if (sel[i]) out.push(pointWorld(a.lt, i, w));
  return out;
}

transformProviders.push({
  collect({ proportional, connected }) {
    const a = inLatticeEdit() ? activeLattice() : null;
    if (!a) return null;
    const sel = ensureSel(a.lt);
    if (!sel.some((x) => x)) return null;
    const w = world(a.ob),
      inv = w.clone().invert();
    // typed arrays are shared with undo snapshots: edit a fresh copy
    a.lt.points = new Float32Array(a.lt.points);
    const before = a.lt.points.slice();
    const lt = a.lt;
    const n = sel.length;
    const pts = Array.from({ length: n }, (_, i) => pointWorld(lt, i, w));
    let weight: Float32Array = new Float32Array(n).map((_, i) => (sel[i] ? 1 : 0));
    let dist: Float32Array = new Float32Array(n);
    if (proportional) {
      const U = lt.points_u,
        V = lt.points_v,
        W = lt.points_w;
      const neighbours = (p: number) => {
        const i = p % U,
          j = Math.floor(p / U) % V,
          k = Math.floor(p / (U * V));
        const out: number[] = [];
        if (i > 0) out.push(p - 1);
        if (i < U - 1) out.push(p + 1);
        if (j > 0) out.push(p - U);
        if (j < V - 1) out.push(p + U);
        if (k > 0) out.push(p - U * V);
        if (k < W - 1) out.push(p + U * V);
        return out;
      };
      ({ weight, dist } = proportionalWeights(pts, [...sel].map(Boolean), connected, neighbours));
    }
    const els: TElement[] = [];
    for (let i = 0; i < n; i++) {
      if (!weight[i]) continue;
      const p0 = pts[i];
      els.push({
        center: p0,
        basis: new Matrix3().setFromMatrix4(w),
        weight: weight[i],
        distance: dist[i],
        apply(m: Matrix4) {
          const p = p0.clone().applyMatrix4(m).applyMatrix4(inv);
          lt.points[i * 3] = p.x;
          lt.points[i * 3 + 1] = p.y;
          lt.points[i * 3 + 2] = p.z;
        },
        restore() {
          lt.points.set(before);
        },
      });
    }
    if (!els.length) return null;
    return { elements: els, active: activePoint >= 0 && activePoint < n && sel[activePoint] ? pts[activePoint] : undefined, label: 'Lattice', finish() {}, cancel() {}, onUpdate: () => app.changed('doc') };
  },
});

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inLatticeEdit()) {
    const pts = selectedPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inLatticeEdit()) return null;
  const pts = selectedPoints();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});

// ---------------------------------------------------------------------------
// menus & keys

function flipMenu(): MenuItem[] {
  return (['U', 'V', 'W'] as const).map((a) => ({ label: `${a} (${{ U: 'X', V: 'Y', W: 'Z' }[a]}) Axis`, op: 'lattice.flip', props: { axis: a } }));
}

function latticeMenu(): MenuItem[] {
  return [
    transformSubmenu(),
    mirrorSubmenu(),
    snapSubmenu(),
    { label: 'Flip (Distortion)', submenu: flipMenu, shortcut: 'Alt F' },
    { separator: true },
    { label: 'Make Regular', op: 'lattice.make_regular' },
  ];
}

function latticeContextMenu(): MenuItem[] {
  return [{ heading: 'Lattice' }, mirrorSubmenu(), { label: 'Flip', submenu: flipMenu }, snapSubmenu(), { separator: true }, { label: 'Make Regular', op: 'lattice.make_regular' }];
}

function latticeSelectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'lattice.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'lattice.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'lattice.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Select Mirror', op: 'lattice.select_mirror' },
    { label: 'Select Random', op: 'lattice.select_random' },
    { separator: true },
    { label: 'More', op: 'lattice.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'lattice.select_less', shortcut: 'Ctrl Numpad -' },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inLatticeEdit() ? [['Lattice', latticeMenu]] : prevEdit?.header?.() ?? []),
  select: () => (inLatticeEdit() ? latticeSelectMenu() : prevEdit?.select?.() ?? []),
  add: () => (inLatticeEdit() ? [] : prevEdit?.add?.() ?? []),
  context: () => (inLatticeEdit() ? latticeContextMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inLatticeEdit() ? null : prevEdit?.headerExtra?.() ?? null),
};

addKeys('Lattice', [
  { key: 'A', op: 'lattice.select_all', props: { action: 'SELECT' }, when: inLatticeEdit },
  { key: 'A', alt: true, op: 'lattice.select_all', props: { action: 'DESELECT' }, when: inLatticeEdit },
  { key: 'I', ctrl: true, op: 'lattice.select_all', props: { action: 'INVERT' }, when: inLatticeEdit },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'lattice.select_more', when: inLatticeEdit },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'lattice.select_less', when: inLatticeEdit },
  { key: 'F', alt: true, menu: flipMenu, menuTitle: 'Flip', when: inLatticeEdit },
]);
