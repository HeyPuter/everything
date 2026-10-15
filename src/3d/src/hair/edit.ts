// Curves Edit Mode: point / curve selection (click, box, circle, lasso, more / less, linked,
// ends, random), transforms of control points (handles follow), delete, duplicate, extrude,
// separate, split, subdivide, cyclic, direction, curve type, attribute values, primitives.
import { Box3, Matrix3, Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import { editModeHooks, type SelectRegion } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { inSelectRegion } from '../editors/view3d/selectshapes';
import { transformProviders, startTransform, type TElement } from '../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../editors/view3d/gizmo';
import { frameHooks } from '../ops/view3d';
import { proportionalWeights } from '../modes/proportional';
import { activeElementHooks } from '../modes/editxform';
import { newObject, uid } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import { CT, HT, recalcHandles } from '../geonodes/curves/curvedata';
import { allocData, dataComps } from '../geonodes/types';
import { activeHair, inCurvesEdit, worldOf } from './common';
import {
  SELECTION,
  appendCurves,
  cloneHair,
  copyRanges,
  curveCount,
  curveSelection,
  getAttr,
  keepCurves,
  keepPoints,
  pointCount,
  pointSelection,
  remap,
  removeAttr,
  reverseCurves,
  selectedRanges,
  setAttr,
  setSelection,
  setSelectionDomain,
  subdivideSelected,
  uniqueHairName,
} from './data';
import { applyAction, combine, growPoints, linkedPoints, randomSelect, selectEnds } from './select';
import type { HairCurvesData, HairDomain } from './types';

const editPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && !!activeHair();

/** Selected-point mask (curve selection spread over its points). */
export function selectedPointMask(hc: HairCurvesData): Uint8Array {
  const n = pointCount(hc);
  const out = new Uint8Array(n);
  if (hc.selection_domain === 'CURVE') {
    const cs = curveSelection(hc);
    const o = hc.curve_offsets;
    for (let c = 0; c + 1 < o.length; c++) if (cs[c] > 0) out.fill(1, o[c], o[c + 1]);
  } else {
    const ps = pointSelection(hc);
    for (let i = 0; i < n; i++) out[i] = ps[i] > 0 ? 1 : 0;
  }
  return out;
}

function selectedCurveMask(hc: HairCurvesData): Uint8Array {
  const pm = selectedPointMask(hc);
  const o = hc.curve_offsets;
  const out = new Uint8Array(curveCount(hc));
  for (let c = 0; c < out.length; c++) for (let i = o[c]; i < o[c + 1]; i++) if (pm[i]) out[c] = 1;
  return out;
}

/** Set the selection of the current domain from a 0/1 mask over points (curves take any). */
function selectPoints(hc: HairCurvesData, pointMask: ArrayLike<number>) {
  if (hc.selection_domain === 'POINT') {
    setSelection(hc, Float32Array.from(pointMask, (x) => (x ? 1 : 0)), 'POINT');
    return;
  }
  const o = hc.curve_offsets;
  const cs = new Float32Array(curveCount(hc));
  for (let c = 0; c < cs.length; c++) for (let i = o[c]; i < o[c + 1]; i++) if (pointMask[i]) cs[c] = 1;
  setSelection(hc, cs, 'CURVE');
}

const domainSel = (hc: HairCurvesData) => (hc.selection_domain === 'CURVE' ? curveSelection(hc) : pointSelection(hc));

/** Last clicked point (Selection to Active). */
let activePoint = -1;
activeElementHooks.push(() => {
  const a = inCurvesEdit() ? activeHair() : null;
  if (!a || activePoint < 0 || activePoint >= pointCount(a.hc) || !selectedPointMask(a.hc)[activePoint]) return null;
  return new Vector3().fromArray(a.hc.positions, activePoint * 3).applyMatrix4(worldOf(a.ob));
});

// ---------------------------------------------------------------------------
// topology helpers

/** Extrude: selected end points grow the curve by a copy; selected inner points start new two-point curves. */
export function extrudePoints(hc: HairCurvesData, sel: ArrayLike<number>): boolean {
  const o = hc.curve_offsets;
  const pointMap: number[] = [];
  const curveMap: number[] = [];
  const offs: number[] = [0];
  const fresh: number[] = [];
  const branches: [number, number][] = [];
  let any = false;
  for (let c = 0; c < curveCount(hc); c++) {
    const a = o[c],
      e = o[c + 1];
    const startSel = sel[a] > 0 && e - a > 0,
      endSel = sel[e - 1] > 0 && e - a > 1;
    if (startSel && !endSel && e - a > 1) {
      fresh.push(pointMap.length);
      pointMap.push(a);
      any = true;
    }
    for (let i = a; i < e; i++) pointMap.push(i);
    if (endSel || (startSel && e - a === 1)) {
      fresh.push(pointMap.length);
      pointMap.push(e - 1);
      any = true;
    }
    curveMap.push(c);
    offs.push(pointMap.length);
    for (let i = a + 1; i < e - 1; i++) if (sel[i] > 0) branches.push([c, i]);
  }
  for (const [c, i] of branches) {
    pointMap.push(i);
    fresh.push(pointMap.length);
    pointMap.push(i);
    curveMap.push(c);
    offs.push(pointMap.length);
    any = true;
  }
  if (!any) return false;
  const domain = hc.selection_domain;
  remap(hc, pointMap, curveMap, Uint32Array.from(offs));
  // only the new points are selected
  const mask = new Uint8Array(pointCount(hc));
  for (const i of fresh) mask[i] = 1;
  hc.selection_domain = 'POINT';
  selectPoints(hc, mask);
  if (domain === 'CURVE') setSelectionDomain(hc, 'CURVE');
  return true;
}

/** Duplicate the selected points (as new curves) or curves; the copies become the selection. */
export function duplicateSelected(hc: HairCurvesData): number {
  const pm = selectedPointMask(hc);
  const ranges = hc.selection_domain === 'CURVE' ? Array.from(selectedCurveMask(hc)).flatMap((on, c) => (on ? [[c, hc.curve_offsets[c], hc.curve_offsets[c + 1] - 1] as [number, number, number]] : [])) : selectedRanges(hc, pm);
  const nc0 = curveCount(hc),
    np0 = pointCount(hc);
  const n = copyRanges(hc, ranges);
  if (!n) return 0;
  if (hc.selection_domain === 'CURVE') {
    const cs = new Float32Array(curveCount(hc));
    cs.fill(1, nc0);
    setSelection(hc, cs, 'CURVE');
  } else {
    const ps = new Float32Array(pointCount(hc));
    ps.fill(1, np0);
    setSelection(hc, ps, 'POINT');
  }
  return n;
}

/** Split: selected runs become separate curves; inner selected points leave the original curves. */
export function splitSelected(hc: HairCurvesData): boolean {
  const pm = selectedPointMask(hc);
  const ranges = selectedRanges(hc, pm);
  if (!ranges.length) return false;
  const o = hc.curve_offsets;
  const keep = new Uint8Array(pointCount(hc)).fill(1);
  const pc = new Uint32Array(pointCount(hc));
  for (let c = 0; c + 1 < o.length; c++) pc.fill(c, o[c], o[c + 1]);
  for (let i = 0; i < pm.length; i++) {
    if (!pm[i]) continue;
    const c = pc[i];
    const prevSel = i > o[c] ? !!pm[i - 1] : true;
    const nextSel = i + 1 < o[c + 1] ? !!pm[i + 1] : true;
    // points joining the selection to unselected points stay in the original curve too
    if (prevSel && nextSel) keep[i] = 0;
  }
  const np0 = pointCount(hc);
  copyRanges(hc, ranges);
  const k = new Uint8Array(pointCount(hc)).fill(1);
  k.set(keep);
  const sel = new Float32Array(pointCount(hc));
  sel.fill(1, np0);
  setSelection(hc, sel, 'POINT');
  keepPoints(hc, k);
  if (hc.selection_domain === 'CURVE') {
    hc.selection_domain = 'POINT';
    setSelectionDomain(hc, 'CURVE');
  }
  return true;
}

/** Curve-domain integer attribute, created with `def` when missing. */
function curveInt(hc: HairCurvesData, name: string, def: number, type: 'INT' | 'INT8' = 'INT8'): Int32Array {
  const a = getAttr(hc, name);
  if (a && a.domain === 'CURVE') return Int32Array.from(a.data);
  const out = new Int32Array(curveCount(hc)).fill(def);
  setAttr(hc, name, 'CURVE', type, out);
  return out;
}

function pointVec(hc: HairCurvesData, name: string): Float32Array {
  const a = getAttr(hc, name);
  if (a && a.domain === 'POINT' && a.data_type === 'FLOAT_VECTOR') return Float32Array.from(a.data);
  return hc.positions.slice();
}

function pointInt(hc: HairCurvesData, name: string, def: number): Int32Array {
  const a = getAttr(hc, name);
  if (a && a.domain === 'POINT') return Int32Array.from(a.data);
  return new Int32Array(pointCount(hc)).fill(def);
}

/** Recompute auto / vector / aligned handles of Bézier curves after point edits. */
export function updateHandles(hc: HairCurvesData) {
  const t = getAttr(hc, 'curve_type');
  if (!t || !Array.from(t.data).some((x) => x === CT.BEZIER)) return;
  const left = pointVec(hc, 'handle_left'),
    right = pointVec(hc, 'handle_right');
  const tl = pointInt(hc, 'handle_type_left', HT.AUTO),
    tr = pointInt(hc, 'handle_type_right', HT.AUTO);
  const cyc = getAttr(hc, 'cyclic');
  recalcHandles(hc.positions, hc.curve_offsets, cyc ? Uint8Array.from(cyc.data) : new Uint8Array(curveCount(hc)), Int32Array.from(t.data), left, right, tl, tr);
  setAttr(hc, 'handle_left', 'POINT', 'FLOAT_VECTOR', left);
  setAttr(hc, 'handle_right', 'POINT', 'FLOAT_VECTOR', right);
  setAttr(hc, 'handle_type_left', 'POINT', 'INT8', tl);
  setAttr(hc, 'handle_type_right', 'POINT', 'INT8', tr);
}

/** Set the type of some curves (handles of new Bézier curves become automatic). */
export function setCurveType(hc: HairCurvesData, which: ArrayLike<number>, type: number) {
  const types = curveInt(hc, 'curve_type', CT.POLY);
  for (let c = 0; c < types.length; c++) if (which[c]) types[c] = type;
  setAttr(hc, 'curve_type', 'CURVE', 'INT8', types);
  if (type === CT.BEZIER) {
    const o = hc.curve_offsets;
    const tl = pointInt(hc, 'handle_type_left', HT.AUTO),
      tr = pointInt(hc, 'handle_type_right', HT.AUTO);
    for (let c = 0; c < types.length; c++) if (which[c]) for (let i = o[c]; i < o[c + 1]; i++) tl[i] = tr[i] = HT.AUTO;
    setAttr(hc, 'handle_type_left', 'POINT', 'INT8', tl);
    setAttr(hc, 'handle_type_right', 'POINT', 'INT8', tr);
    setAttr(hc, 'handle_left', 'POINT', 'FLOAT_VECTOR', pointVec(hc, 'handle_left'));
    setAttr(hc, 'handle_right', 'POINT', 'FLOAT_VECTOR', pointVec(hc, 'handle_right'));
    updateHandles(hc);
  }
  if (!types.some((t) => t !== CT.POLY)) {
    for (const n of ['curve_type', 'handle_left', 'handle_right', 'handle_type_left', 'handle_type_right']) removeAttr(hc, n);
  }
}

// ---------------------------------------------------------------------------
// operators

const ACTIONS: [string, string][] = [
  ['TOGGLE', 'Toggle'],
  ['SELECT', 'Select'],
  ['DESELECT', 'Deselect'],
  ['INVERT', 'Invert'],
];

const CURVE_TYPES: [string, string][] = [
  ['CATMULL_ROM', 'Catmull Rom'],
  ['POLY', 'Poly'],
  ['BEZIER', 'Bézier'],
  ['NURBS', 'NURBS'],
];

/** Objects whose curves an operator acts on: the active one in Edit / Sculpt mode, else the selected Curves objects. */
export function targetHairs(): { ob: import('../data/types').ObjectData; hc: HairCurvesData }[] {
  if (app.doc.mode !== 'OBJECT') {
    const a = activeHair();
    return a ? [a] : [];
  }
  return app
    .selectedObjects()
    .filter((o) => o.type === 'CURVES' && o.data && app.doc.hair_curves?.[o.data])
    .map((o) => ({ ob: o, hc: app.doc.hair_curves![o.data!] }));
}

const selectionPoll = (ctx: OpContext) => (ctx.doc.mode === 'EDIT' || ctx.doc.mode === 'SCULPT_CURVES') && !!activeHair();

registerOperators([
  {
    idname: 'curves.select_all',
    label: '(De)select All',
    description: 'Change the selection of all points or curves',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: ACTIONS }],
    poll: selectionPoll,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      setSelection(hc, applyAction(domainSel(hc), p.action as string));
    },
  },
  {
    idname: 'curves.select_random',
    label: 'Select Random',
    description: 'Randomly select or deselect points or curves',
    props: [
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0 },
      { id: 'probability', label: 'Probability', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] },
    ],
    poll: editPoll,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      setSelection(hc, randomSelect(domainSel(hc), p.probability as number, p.seed as number, p.action === 'SELECT'));
    },
  },
  {
    idname: 'curves.select_more',
    label: 'Select More',
    description: 'Grow the selection by one point along the curves',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      if (hc.selection_domain !== 'POINT') return 'CANCELLED';
      setSelection(hc, growPoints(pointSelection(hc), hc.curve_offsets, true), 'POINT');
    },
  },
  {
    idname: 'curves.select_less',
    label: 'Select Less',
    description: 'Shrink the selection by one point along the curves',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      if (hc.selection_domain !== 'POINT') return 'CANCELLED';
      setSelection(hc, growPoints(pointSelection(hc), hc.curve_offsets, false), 'POINT');
    },
  },
  {
    idname: 'curves.select_linked',
    label: 'Select Linked',
    description: 'Select all points of curves with a selected point',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      if (hc.selection_domain === 'POINT') setSelection(hc, linkedPoints(pointSelection(hc), hc.curve_offsets), 'POINT');
    },
  },
  {
    idname: 'curves.select_linked_pick',
    label: 'Select Linked Pick',
    description: 'Select (or deselect) the curve under the pointer',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    poll: editPoll,
    invoke: (ctx, p) => {
      const v = viewUnder(ctx);
      const a = activeHair();
      if (!v || !a) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const c = nearestCurve(v, a.ob, a.hc, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top, 20);
      if (c < 0) return 'CANCELLED';
      const o = a.hc.curve_offsets;
      const sel = domainSel(a.hc);
      if (a.hc.selection_domain === 'CURVE') sel[c] = p.deselect ? 0 : 1;
      else sel.fill(p.deselect ? 0 : 1, o[c], o[c + 1]);
      setSelection(a.hc, sel);
    },
  },
  {
    idname: 'curves.select_ends',
    label: 'Select Ends',
    description: 'Select end points of curves',
    props: [
      { id: 'amount_start', label: 'Amount Front', type: 'int', default: 0, min: 0 },
      { id: 'amount_end', label: 'Amount Back', type: 'int', default: 1, min: 0 },
    ],
    poll: selectionPoll,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      const pts = selectEnds(hc.curve_offsets, pointCount(hc), p.amount_start as number, p.amount_end as number);
      setSelectionDomain(hc, 'POINT');
      setSelection(hc, pts, 'POINT');
    },
  },
  {
    idname: 'curves.set_selection_domain',
    label: 'Set Select Mode',
    description: 'Select points or whole curves',
    props: [{ id: 'domain', label: 'Domain', type: 'enum', default: 'POINT', items: [['POINT', 'Point'], ['CURVE', 'Curve']] }],
    poll: selectionPoll,
    exec: (_c, p) => {
      for (const { hc } of targetHairs()) setSelectionDomain(hc, p.domain as HairDomain);
    },
  },
  {
    idname: 'curves.delete',
    label: 'Delete',
    description: 'Remove the selected control points or curves',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      const ok = hc.selection_domain === 'CURVE' ? keepCurves(hc, Array.from(curveSelection(hc), (x) => (x > 0 ? 0 : 1))) : keepPoints(hc, Array.from(selectedPointMask(hc), (x) => x ^ 1));
      if (!ok) return 'CANCELLED';
      updateHandles(hc);
    },
  },
  {
    idname: 'curves.duplicate',
    label: 'Duplicate',
    description: 'Copy the selected points or curves',
    poll: editPoll,
    exec: () => (duplicateSelected(activeHair()!.hc) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'curves.duplicate_move',
    label: 'Duplicate',
    description: 'Copy the selected points or curves and move them',
    poll: editPoll,
    invoke: (ctx) => {
      if (!duplicateSelected(activeHair()!.hc)) return 'CANCELLED';
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event });
      return 'RUNNING_MODAL';
    },
    exec: () => (duplicateSelected(activeHair()!.hc) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'curves.extrude',
    label: 'Extrude',
    description: 'Extrude the selected control points',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      return extrudePoints(hc, selectedPointMask(hc)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'curves.extrude_move',
    label: 'Extrude Curve and Move',
    description: 'Extrude the selected control points and move the new ones',
    poll: editPoll,
    invoke: (ctx) => {
      const { hc } = activeHair()!;
      if (!extrudePoints(hc, selectedPointMask(hc))) return 'CANCELLED';
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event });
      return 'RUNNING_MODAL';
    },
    exec: () => {
      const { hc } = activeHair()!;
      return extrudePoints(hc, selectedPointMask(hc)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'curves.separate',
    label: 'Separate',
    description: 'Move the selected points or curves into a new object',
    poll: editPoll,
    exec: (ctx) => {
      const { ob, hc } = activeHair()!;
      const pm = selectedPointMask(hc);
      if (!pm.some((x) => x) || pm.every((x) => x)) return 'CANCELLED';
      const copy = cloneHair(hc);
      copy.id = uid('hc');
      copy.name = uniqueHairName(ctx.doc, hc.name);
      keepPoints(copy, pm);
      removeAttr(copy, SELECTION);
      keepPoints(hc, Array.from(pm, (x) => x ^ 1));
      ctx.doc.hair_curves![copy.id] = copy;
      const nob = newObject(ob.name, 'CURVES', copy.id);
      const sel = app.selectedObjects();
      addObjectToScene(ctx.doc, nob, { location: [...ob.location], rotation: [...ob.rotation_euler] });
      Object.assign(nob, { scale: [...ob.scale], parent: ob.parent, parent_type: ob.parent_type, matrix_parent_inverse: [...ob.matrix_parent_inverse], rotation_mode: ob.rotation_mode, rotation_quaternion: [...ob.rotation_quaternion] });
      // the edited object stays active and selected
      nob.select = true;
      for (const o of sel) o.select = true;
      ob.select = true;
      ctx.doc.scene.active_object = ob.id;
    },
  },
  {
    idname: 'curves.split',
    label: 'Split',
    description: 'Split the selected points off their curves into new curves',
    poll: editPoll,
    exec: () => (splitSelected(activeHair()!.hc) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'curves.cyclic_toggle',
    label: 'Toggle Cyclic',
    description: 'Make the selected curves closed or open',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      const which = selectedCurveMask(hc);
      if (!which.some((x) => x)) return 'CANCELLED';
      const a = getAttr(hc, 'cyclic');
      const cyc = a ? Uint8Array.from(a.data) : new Uint8Array(curveCount(hc));
      for (let c = 0; c < cyc.length; c++) if (which[c]) cyc[c] ^= 1;
      if (cyc.some((x) => x)) setAttr(hc, 'cyclic', 'CURVE', 'BOOLEAN', cyc);
      else removeAttr(hc, 'cyclic');
      updateHandles(hc);
    },
  },
  {
    idname: 'curves.subdivide',
    label: 'Subdivide',
    description: 'Add points between selected neighbouring points',
    props: [{ id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 1000 }],
    poll: editPoll,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      if (!subdivideSelected(hc, selectedPointMask(hc), p.number_cuts as number)) return 'CANCELLED';
      updateHandles(hc);
    },
  },
  {
    idname: 'curves.switch_direction',
    label: 'Switch Direction',
    description: 'Reverse the point order of the selected curves',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      const which = selectedCurveMask(hc);
      if (!which.some((x) => x)) return 'CANCELLED';
      reverseCurves(hc, which);
    },
  },
  {
    idname: 'curves.curve_type_set',
    label: 'Set Curve Type',
    description: 'Change the type of the selected curves',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'POLY', items: CURVE_TYPES },
      { id: 'use_handles', label: 'Handles', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      const which = selectedCurveMask(hc);
      if (!which.some((x) => x)) return 'CANCELLED';
      setCurveType(hc, which, CT[p.type as keyof typeof CT] ?? CT.POLY);
    },
  },
  {
    idname: 'curves.handle_type_set',
    label: 'Set Handle Type',
    description: 'Set the handle type of the selected Bézier points',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'AUTO', items: [['AUTO', 'Auto'], ['VECTOR', 'Vector'], ['ALIGN', 'Align'], ['FREE_ALIGN', 'Free']] }],
    poll: (ctx) => editPoll(ctx) && !!getAttr(activeHair()!.hc, 'handle_type_left'),
    exec: (_c, p) => {
      const { hc } = activeHair()!;
      const pm = selectedPointMask(hc);
      const t = { AUTO: HT.AUTO, VECTOR: HT.VECTOR, ALIGN: HT.ALIGN, FREE_ALIGN: HT.FREE }[p.type as string] ?? HT.AUTO;
      const tl = pointInt(hc, 'handle_type_left', HT.AUTO),
        tr = pointInt(hc, 'handle_type_right', HT.AUTO);
      for (let i = 0; i < pm.length; i++) if (pm[i]) tl[i] = tr[i] = t;
      setAttr(hc, 'handle_type_left', 'POINT', 'INT8', tl);
      setAttr(hc, 'handle_type_right', 'POINT', 'INT8', tr);
      updateHandles(hc);
    },
  },
  {
    idname: 'curves.tilt_clear',
    label: 'Clear Tilt',
    description: 'Reset the tilt of the selected points',
    poll: editPoll,
    exec: () => {
      const { hc } = activeHair()!;
      const a = getAttr(hc, 'tilt');
      if (!a) return 'CANCELLED';
      const pm = selectedPointMask(hc);
      const t = Float32Array.from(a.data);
      for (let i = 0; i < pm.length; i++) if (pm[i]) t[i] = 0;
      setAttr(hc, 'tilt', 'POINT', 'FLOAT', t);
    },
  },
  {
    idname: 'curves.attribute_set',
    label: 'Set Attribute',
    description: 'Set the value of the active attribute on the selected elements',
    props: attributeValueProps(),
    poll: (ctx) => editPoll(ctx) && !!activeAttr(activeHair()!.hc),
    invoke: (ctx, p) => {
      // start from the value of the first selected element
      const { hc } = activeHair()!;
      const a = activeAttr(hc)!;
      const pm = selectedPointMask(hc);
      const cm = selectedCurveMask(hc);
      const mask = a.domain === 'POINT' ? pm : cm;
      const i = mask.indexOf(1);
      if (i >= 0) {
        const comps = dataComps(a.data_type);
        const v = Array.from(a.data.subarray(i * comps, i * comps + comps));
        if (comps === 1) p.value = v[0];
        else p.value_vector = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
        if (comps === 4) p.value_color = v;
      }
      return operatorsExec(ctx, p);
    },
    exec: (ctx, p) => operatorsExec(ctx, p),
  },
  {
    idname: 'curves.add_bezier',
    label: 'Add Bézier',
    description: 'Add a Bézier curve at the 3D cursor',
    poll: editPoll,
    exec: () => addPrimitive('BEZIER'),
  },
  {
    idname: 'curves.add_circle',
    label: 'Add Circle',
    description: 'Add a closed circle curve at the 3D cursor',
    poll: editPoll,
    exec: () => addPrimitive('CIRCLE'),
  },
]);

function attributeValueProps(): PropDef[] {
  return [
    { id: 'value', label: 'Value', type: 'float', default: 0, showIf: () => attrComps() === 1 },
    { id: 'value_vector', label: 'Value', type: 'vec3', default: [0, 0, 0], showIf: () => attrComps() === 2 || attrComps() === 3 },
    { id: 'value_color', label: 'Color', type: 'color', default: [1, 1, 1, 1], showIf: () => attrComps() === 4 },
  ];
}

function attrComps() {
  const a = activeHair();
  const at = a ? activeAttr(a.hc) : null;
  return at ? dataComps(at.data_type) : 0;
}

export function activeAttr(hc: HairCurvesData) {
  const i = hc.active_attribute ?? -1;
  const a = hc.attributes[i];
  return a && !a.name.startsWith('.') ? a : null;
}

function operatorsExec(_ctx: OpContext, p: Record<string, unknown>) {
  const { hc } = activeHair()!;
  const a = activeAttr(hc);
  if (!a) return 'CANCELLED';
  const comps = dataComps(a.data_type);
  const mask = a.domain === 'POINT' ? selectedPointMask(hc) : selectedCurveMask(hc);
  const out = allocData(a.data_type, mask.length);
  (out as Float32Array).set(a.data as Float32Array);
  const val: number[] = comps === 1 ? [p.value as number] : comps === 4 ? (p.value_color as number[]) : (p.value_vector as number[]);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let k = 0; k < comps; k++) {
      let x = val[k] ?? 0;
      if (a.data_type === 'INT' || a.data_type === 'INT8') x = Math.round(x);
      if (a.data_type === 'BOOLEAN') x = x ? 1 : 0;
      out[i * comps + k] = x;
    }
  }
  setAttr(hc, a.name, a.domain, a.data_type, out);
  hc.active_attribute = hc.attributes.findIndex((x) => x.name === a.name);
  return 'FINISHED' as const;
}

function addPrimitive(kind: 'BEZIER' | 'CIRCLE') {
  const { ob, hc } = activeHair()!;
  const inv = worldOf(ob).invert();
  const c = new Vector3(...app.doc.scene.cursor.location).applyMatrix4(inv);
  const s = 0.5;
  const pts =
    kind === 'BEZIER'
      ? [
          [-1, 0, 0],
          [1, 0, 0],
        ]
      : [
          [1, 0, 0],
          [0, 1, 0],
          [-1, 0, 0],
          [0, -1, 0],
        ];
  const flat = pts.flatMap((p) => [c.x + p[0] * s, c.y + p[1] * s, c.z + p[2] * s]);
  // deselect everything, the new curve becomes the selection
  setSelection(hc, new Float32Array(hc.selection_domain === 'CURVE' ? curveCount(hc) : pointCount(hc)));
  const np0 = pointCount(hc),
    nc0 = curveCount(hc);
  appendCurves(hc, [{ points: flat }], true);
  const which = new Uint8Array(curveCount(hc));
  which[nc0] = 1;
  if (kind === 'CIRCLE') {
    const a = getAttr(hc, 'cyclic');
    const cyc = new Uint8Array(curveCount(hc));
    if (a) cyc.set(a.data.subarray(0, nc0) as Uint8Array);
    cyc[nc0] = 1;
    setAttr(hc, 'cyclic', 'CURVE', 'BOOLEAN', cyc);
  }
  setCurveType(hc, which, CT.BEZIER);
  if (kind === 'BEZIER') {
    // an S shape: free handles pulled up and down
    const L = pointVec(hc, 'handle_left'),
      R = pointVec(hc, 'handle_right');
    const tl = pointInt(hc, 'handle_type_left', HT.AUTO),
      tr = pointInt(hc, 'handle_type_right', HT.AUTO);
    const set = (arr: Float32Array, i: number, x: number, y: number) => arr.set([c.x + x * s, c.y + y * s, c.z], i * 3);
    set(L, np0, -1.5, -0.5);
    set(R, np0, -0.5, 0.5);
    set(L, np0 + 1, 0.5, -0.5);
    set(R, np0 + 1, 1.5, 0.5);
    tl[np0] = tr[np0] = tl[np0 + 1] = tr[np0 + 1] = HT.ALIGN;
    setAttr(hc, 'handle_left', 'POINT', 'FLOAT_VECTOR', L);
    setAttr(hc, 'handle_right', 'POINT', 'FLOAT_VECTOR', R);
    setAttr(hc, 'handle_type_left', 'POINT', 'INT8', tl);
    setAttr(hc, 'handle_type_right', 'POINT', 'INT8', tr);
  }
  return 'FINISHED' as const;
}

// ---------------------------------------------------------------------------
// picking & region selection

function viewUnder(ctx: OpContext): View3D | null {
  const ed = ctx.area?.editor as View3D | undefined;
  if (ed && 'project' in ed) return ed;
  return null;
}

function projectAll(v: View3D, ob: import('../data/types').ObjectData, hc: HairCurvesData) {
  const w = worldOf(ob);
  const n = pointCount(hc);
  const out = new Float32Array(n * 3);
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    p.fromArray(hc.positions, i * 3).applyMatrix4(w);
    const s = v.project(p);
    out[i * 3] = s.x;
    out[i * 3 + 1] = s.y;
    out[i * 3 + 2] = s.z;
  }
  return out;
}

function nearestCurve(v: View3D, ob: import('../data/types').ObjectData, hc: HairCurvesData, x: number, y: number, maxPx: number): number {
  const S = projectAll(v, ob, hc);
  const o = hc.curve_offsets;
  let best = -1,
    bd = maxPx * maxPx;
  for (let c = 0; c + 1 < o.length; c++)
    for (let i = o[c]; i < o[c + 1]; i++) {
      if (S[i * 3 + 2] > 1) continue;
      let d = (S[i * 3] - x) ** 2 + (S[i * 3 + 1] - y) ** 2;
      if (i + 1 < o[c + 1]) d = Math.min(d, segD2(x, y, S[i * 3], S[i * 3 + 1], S[i * 3 + 3], S[i * 3 + 4]));
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
  return best;
}

function segD2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax,
    vy = by - ay;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l)) : 0;
  return (ax + vx * t - px) ** 2 + (ay + vy * t - py) ** 2;
}

editModeHooks.pick.push((v, x, y, o) => {
  const a = inCurvesEdit() ? activeHair() : null;
  if (!a) return false;
  const { hc } = a;
  const sel = domainSel(hc);
  let hit = -1;
  if (hc.selection_domain === 'CURVE') hit = nearestCurve(v, a.ob, hc, x, y, 10);
  else {
    const S = projectAll(v, a.ob, hc);
    let bd = 12 * 12;
    for (let i = 0; i < pointCount(hc); i++) {
      if (S[i * 3 + 2] > 1) continue;
      const d = (S[i * 3] - x) ** 2 + (S[i * 3 + 1] - y) ** 2;
      if (d < bd) {
        bd = d;
        hit = i;
      }
    }
  }
  if (hit < 0 && !o.deselectAll && (o.extend || o.toggle || o.deselect)) return true;
  if (!o.extend && !o.toggle && !o.deselect) sel.fill(0);
  if (hit >= 0) {
    if (o.deselect) sel[hit] = 0;
    else if (o.toggle) sel[hit] = sel[hit] > 0 ? 0 : 1;
    else sel[hit] = 1;
  }
  activePoint = hc.selection_domain === 'POINT' && hit >= 0 && sel[hit] > 0 ? hit : -1;
  setSelection(hc, sel);
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const a = inCurvesEdit() ? activeHair() : null;
  if (!a) return false;
  const { hc } = a;
  const S = projectAll(v, a.ob, hc);
  const n = pointCount(hc);
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = S[i * 3 + 2] <= 1 && inSelectRegion(r, S[i * 3], S[i * 3 + 1]) ? 1 : 0;
  const sel = domainSel(hc);
  if (hc.selection_domain === 'CURVE') {
    const o = hc.curve_offsets;
    for (let c = 0; c < sel.length; c++) {
      let hit = 0;
      for (let i = o[c]; i < o[c + 1]; i++) if (inside[i]) hit = 1;
      sel[c] = combine(sel[c], hit, mode);
    }
  } else for (let i = 0; i < n; i++) sel[i] = combine(sel[i], inside[i], mode);
  setSelection(hc, sel);
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select'));
editModeHooks.region.push((v, r, mode) => regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select'));

// ---------------------------------------------------------------------------
// transforms (control points; Bézier handles move with their points)

function selectedWorldPoints() {
  const a = activeHair();
  if (!a) return [];
  const pm = selectedPointMask(a.hc);
  const w = worldOf(a.ob);
  const out: Vector3[] = [];
  for (let i = 0; i < pm.length; i++) if (pm[i]) out.push(new Vector3().fromArray(a.hc.positions, i * 3).applyMatrix4(w));
  return out;
}

transformProviders.push({
  collect({ proportional, connected }) {
    const a = inCurvesEdit() ? activeHair() : null;
    if (!a) return null;
    const hc = a.hc;
    const pm = selectedPointMask(hc);
    if (!pm.some((x) => x)) return null;
    const w = worldOf(a.ob),
      inv = w.clone().invert();
    hc.positions = hc.positions.slice();
    const before = hc.positions.slice();
    const hl = getAttr(hc, 'handle_left'),
      hr = getAttr(hc, 'handle_right');
    const L = hl ? Float32Array.from(hl.data) : null,
      R = hr ? Float32Array.from(hr.data) : null;
    if (L && R) {
      setAttr(hc, 'handle_left', 'POINT', 'FLOAT_VECTOR', L);
      setAttr(hc, 'handle_right', 'POINT', 'FLOAT_VECTOR', R);
    }
    const L0 = L?.slice(),
      R0 = R?.slice();
    const n = pm.length;
    const pts = Array.from({ length: n }, (_, i) => new Vector3().fromArray(before, i * 3).applyMatrix4(w));
    let weight: Float32Array = Float32Array.from(pm);
    let dist: Float32Array = new Float32Array(n);
    if (proportional) {
      const pc = new Uint32Array(n);
      const o = hc.curve_offsets;
      for (let c = 0; c + 1 < o.length; c++) pc.fill(c, o[c], o[c + 1]);
      const neighbours = (i: number) => {
        const c = pc[i];
        const out: number[] = [];
        if (i > o[c]) out.push(i - 1);
        if (i + 1 < o[c + 1]) out.push(i + 1);
        return out;
      };
      ({ weight, dist } = proportionalWeights(pts, Array.from(pm, Boolean), connected, neighbours));
    }
    const basis = new Matrix3().setFromMatrix4(w);
    const els: TElement[] = [];
    const tmp = new Vector3();
    for (let i = 0; i < n; i++) {
      if (!weight[i]) continue;
      const p0 = pts[i];
      const hl0 = L0 ? new Vector3().fromArray(L0, i * 3).applyMatrix4(w) : null;
      const hr0 = R0 ? new Vector3().fromArray(R0, i * 3).applyMatrix4(w) : null;
      els.push({
        center: p0,
        basis,
        weight: weight[i],
        distance: dist[i],
        apply(m: Matrix4) {
          tmp.copy(p0).applyMatrix4(m).applyMatrix4(inv).toArray(hc.positions, i * 3);
          if (hl0 && L) tmp.copy(hl0).applyMatrix4(m).applyMatrix4(inv).toArray(L, i * 3);
          if (hr0 && R) tmp.copy(hr0).applyMatrix4(m).applyMatrix4(inv).toArray(R, i * 3);
        },
        restore() {
          hc.positions.set(before);
          if (L && L0) L.set(L0);
          if (R && R0) R.set(R0);
        },
      });
    }
    if (!els.length) return null;
    return {
      elements: els,
      active: activePoint >= 0 && activePoint < n && pm[activePoint] ? pts[activePoint] : undefined,
      label: 'Curves',
      finish() {
        updateHandles(hc);
      },
      cancel() {},
      onUpdate: () => {
        // new array identities so the depsgraph and the GPU see the change
        hc.positions = hc.positions.slice();
        if (L && R) {
          const l = hc.attributes.find((x) => x.name === 'handle_left'),
            r = hc.attributes.find((x) => x.name === 'handle_right');
          if (l) l.data = L.slice();
          if (r) r.data = R.slice();
        }
        app.changed('doc');
      },
    };
  },
});

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inCurvesEdit()) {
    const pts = selectedWorldPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inCurvesEdit()) return null;
  const pts = selectedWorldPoints();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});
