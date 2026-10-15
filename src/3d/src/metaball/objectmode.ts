// Object Mode drawing and picking of metaball elements: every metaball object shows its element
// rings, so members of a family (which have no surface of their own) can be clicked.
import { h, type VNode } from '../ui/h';
import { app } from '../app/app';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import type { ObjectData } from '../data/types';
import { metaballOf } from './data';
import { rings } from './edit';

const RING_TOL = 6;

function metaObjects(v: View3D): ObjectData[] {
  return Object.values(app.doc.objects).filter((o) => o.type === 'META' && app.isVisible(o.id) && (!v.localView || v.localView.has(o.id)));
}

editModeHooks.svg.push((v) => {
  if (app.doc.mode !== 'OBJECT' || !v.overlay.show_overlays) return null;
  const parts: VNode[] = [];
  const active = app.doc.scene.active_object;
  for (const ob of metaObjects(v)) {
    const mb = metaballOf(app.doc, ob);
    if (!mb) continue;
    const col = ob.select ? (ob.id === active ? '#ffaa40' : '#f15800') : '#000000';
    for (const g of rings(v, ob, mb)) parts.push(h('circle', { key: `${ob.id}.${g.index}`, cx: g.cx, cy: g.cy, r: g.r, fill: 'none', stroke: col, 'stroke-width': 1.2, opacity: ob.select ? 1 : 0.55 }));
  }
  return parts.length ? h('g', { class: 'mball-object' }, parts) : null;
});

editModeHooks.pick.push((v, x, y, o) => {
  if (app.doc.mode !== 'OBJECT') return false;
  let best: ObjectData | null = null,
    bd = RING_TOL;
  for (const ob of metaObjects(v)) {
    if (!app.isSelectable(ob.id)) continue;
    const mb = metaballOf(app.doc, ob);
    if (!mb) continue;
    for (const g of rings(v, ob, mb)) {
      const d = Math.abs(Math.hypot(x - g.cx, y - g.cy) - g.r);
      if (d < bd) {
        bd = d;
        best = ob;
      }
    }
  }
  if (!best) return false;
  const doc = app.doc;
  if (o.deselect) best.select = false;
  else if (o.toggle) {
    if (best.select && doc.scene.active_object === best.id) best.select = false;
    else {
      best.select = true;
      doc.scene.active_object = best.id;
    }
  } else {
    for (const other of Object.values(doc.objects)) other.select = false;
    best.select = true;
    doc.scene.active_object = best.id;
  }
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});
