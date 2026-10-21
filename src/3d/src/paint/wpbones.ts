// Weight Paint with an armature: Ctrl+click on a bone of the armature deforming the mesh selects
// it and makes its vertex group the one being painted (Ctrl+click elsewhere still paints, inverted).
import { Vector3 } from 'three';
import { app } from '../app/app';
import type { View3D } from '../editors/view3d/view3d';
import { invalidatePaintAttributes } from './display';
import { paintHooks } from './painthooks';
import { armatureOf } from './wpaint';

/** Distance from point p to the segment ab (2D). Pure. */
export function segmentDistance2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** The deforming bone drawn closest to (x, y) within `reach` pixels. */
function boneAt(v: View3D, x: number, y: number, reach = 10): { arm: string; name: string } | null {
  const ob = app.activeObject;
  const armOb = ob ? armatureOf(ob) : null;
  const ad = armOb?.data ? app.doc.armatures[armOb.data] : undefined;
  if (!armOb || !ad || !app.isVisible(armOb.id)) return null;
  const ev = app.graph.get(armOb.id);
  const w = ev?.world;
  if (!w) return null;
  let best: { arm: string; name: string } | null = null;
  let bd = reach;
  for (const b of ad.bones) {
    const pb = ev.pose?.bones.get(b.name);
    const head = pb ? new Vector3().setFromMatrixPosition(pb.pose).applyMatrix4(w) : new Vector3(...b.head).applyMatrix4(w);
    const tail = pb ? new Vector3(0, pb.length, 0).applyMatrix4(pb.pose).applyMatrix4(w) : new Vector3(...b.tail).applyMatrix4(w);
    const h = v.project(head),
      t = v.project(tail);
    if (h.z < -1 || h.z > 1 || t.z < -1 || t.z > 1) continue;
    const d = segmentDistance2D(x, y, h.x, h.y, t.x, t.y);
    if (d < bd) {
      bd = d;
      best = { arm: ad.id, name: b.name };
    }
  }
  return best;
}

paintHooks.brushPointer.push((v, e) => {
  if (app.doc.mode !== 'WEIGHT_PAINT' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const q = v.local(e);
  const hit = boneAt(v, q.x, q.y);
  if (!hit) return false;
  const ad = app.doc.armatures[hit.arm];
  for (const b of ad.bones) b.select = b.select_head = b.select_tail = b.name === hit.name;
  ad.active_bone = hit.name;
  // paint the bone's group (made on demand, like the brush does for a mesh without groups)
  const ob = app.activeObject!;
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  if (me) {
    let gi = me.vertex_groups.findIndex((g) => g.name === hit.name);
    if (gi < 0) {
      app.run('object.vertex_group_add', {}, { invoke: false });
      gi = me.vertex_groups.length - 1;
      if (gi >= 0) me.vertex_groups[gi].name = hit.name;
    }
    if (gi >= 0) ob.vertex_group_active_index = gi;
  }
  invalidatePaintAttributes();
  app.pushUndo('Select Bone');
  app.changed('doc', 'select');
  app.report('INFO', `Painting the group "${hit.name}"`);
  return true;
});
