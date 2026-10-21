// Object-mode selection: click (with cycling), box/circle selection.
import { app } from '../../app/app';
import type { View3D } from './view3d';
import { editModeHooks, type PickOptions } from './hooks';
import { openSelectMenu } from './selectops';

let cycleState: { x: number; y: number; order: string[]; index: number } | null = null;

export function selectPick(v: View3D, x: number, y: number, o: PickOptions) {
  // Alt+click in Object / Pose Mode lists everything under the pointer to choose from
  if (o.cycle && (app.doc.mode === 'OBJECT' || app.doc.mode === 'POSE') && openSelectMenu(v, x, y, { extend: o.extend && !o.toggle, toggle: o.toggle, deselect: o.deselect })) {
    cycleState = null;
    return;
  }
  for (const hk of editModeHooks.pick) if (hk(v, x, y, o)) return;
  const doc = app.doc;
  const hit = v.pick(x, y, 8);
  let id = hit?.id ?? null;
  // clicking again at the same spot cycles through the overlapping objects there
  const again = !!cycleState && Math.hypot(cycleState.x - x, cycleState.y - y) < 4;
  if (hit && hit.order.length > 1 && again && !o.deselect && !o.toggle && !o.extend) {
    cycleState!.index = (cycleState!.index + 1) % cycleState!.order.length;
    id = cycleState!.order[cycleState!.index];
  } else cycleState = hit ? { x, y, order: hit.order, index: 0 } : null;
  if (doc.mode !== 'OBJECT' && doc.mode !== 'POSE' && id && id !== doc.scene.active_object) {
    // clicking another object outside object mode is ignored (no mode switching via click)
    return;
  }
  if (!id) {
    if (o.deselectAll && !o.extend) {
      let changed = false;
      for (const ob of Object.values(doc.objects))
        if (ob.select) {
          ob.select = false;
          changed = true;
        }
      if (changed) commit('Select');
    }
    return;
  }
  const ob = doc.objects[id];
  if (!ob) return;
  if (o.deselect) {
    ob.select = false;
  } else if (o.toggle) {
    // shift-click: select & make active; if already active & selected, deselect
    if (ob.select && doc.scene.active_object === id) ob.select = false;
    else {
      ob.select = true;
      doc.scene.active_object = id;
    }
  } else {
    for (const other of Object.values(doc.objects)) other.select = false;
    ob.select = true;
    doc.scene.active_object = id;
  }
  commit('Select');
}

function commit(label: string) {
  app.pushUndo(label);
  app.changed('select', 'doc');
}

export function selectObjects(v: View3D, x0: number, y0: number, x1: number, y1: number, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') {
  for (const hk of editModeHooks.box) if (hk(v, x0, y0, x1, y1, mode)) return;
  const doc = app.doc;
  if (doc.mode !== 'OBJECT') return;
  const ids = v.idsInRect(x0, y0, x1, y1);
  const inside = new Set(ids.keys());
  for (const ob of Object.values(doc.objects)) {
    if (!app.isSelectable(ob.id)) continue;
    const isIn = inside.has(ob.id);
    if (mode === 'SET') ob.select = isIn;
    else if (mode === 'ADD') ob.select = ob.select || isIn;
    else if (mode === 'SUB') ob.select = ob.select && !isIn;
    else if (mode === 'AND') ob.select = ob.select && isIn;
    else if (mode === 'XOR') ob.select = ob.select !== isIn;
  }
  const act = doc.scene.active_object ? doc.objects[doc.scene.active_object] : null;
  if ((!act || !act.select) && mode !== 'SUB') {
    const first = [...inside][0];
    if (first) doc.scene.active_object = first;
  }
  commit('Box Select');
}
