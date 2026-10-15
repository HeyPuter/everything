// Gesture operators of Sculpt Mode: mask, hide/show, face set and line project.
import { Vector3 } from 'three';
import { app } from '../app/app';
import { cow, own } from '../data/cow';
import type { MeshData } from '../data/types';
import type { View3D } from '../editors/view3d/view3d';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate } from './session';
import { maskChanged, invalidatePaintAttributes } from './display';
import { faceCount, faceSetsOf, hiddenFacesOf, maxFaceSet } from './fsdata';
import { commitFaceSets, commitHidden, newFaceSets } from './facesetops';
import { facesInside, gestureHits, registerGestureTarget, vertsInside, type Gesture } from './gesture';

/** Writable mask of the active mesh (created on demand). */
export function editableMask(me: MeshData): Float32Array {
  const nv = me.positions.length / 3;
  if (!me.sculpt_mask || me.sculpt_mask.length !== nv) me.sculpt_mask = own(new Float32Array(nv));
  else cow(me, 'sculpt_mask');
  return me.sculpt_mask;
}

export function commitMask(me: MeshData) {
  maskChanged(me.sculpt_mask!);
  invalidatePaintAttributes();
}

const FRONT: import('../app/app').PropDef = { id: 'use_front_faces_only', label: 'Front Faces Only', type: 'bool', default: false };

registerGestureTarget({
  ops: { BOX: 'paint.mask_box_gesture', LASSO: 'paint.mask_lasso_gesture', LINE: 'paint.mask_line_gesture', POLYLINE: 'paint.mask_polyline_gesture' },
  label: { BOX: 'Mask Box Gesture', LASSO: 'Mask Lasso Gesture', LINE: 'Mask Line Gesture', POLYLINE: 'Mask Polyline Gesture' },
  description: 'Set the mask of the vertices inside the drawn shape',
  props: [
    FRONT,
    {
      id: 'mode',
      label: 'Mode',
      type: 'enum',
      default: 'VALUE',
      items: [
        ['VALUE', 'Value', 'Set the mask to the value'],
        ['VALUE_INVERSE', 'Value Inverted', 'Set the mask to one minus the value'],
        ['INVERT', 'Invert', 'Invert the mask'],
      ],
    },
    { id: 'value', label: 'Value', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
  ],
  ctrlProps: { value: 0 },
  apply: (v, g, p) => {
    const gh = gestureHits(v, g);
    if (!gh) return 'CANCELLED';
    const inside = vertsInside(gh, !!p.use_front_faces_only);
    const { me } = activeMeshData()!;
    const mask = editableMask(me);
    const val = p.mode === 'VALUE_INVERSE' ? 1 - (p.value as number) : (p.value as number);
    for (let i = 0; i < inside.length; i++) if (inside[i]) mask[i] = p.mode === 'INVERT' ? 1 - mask[i] : val;
    commitMask(me);
  },
});

registerGestureTarget({
  ops: { BOX: 'paint.hide_show', LASSO: 'paint.hide_show_lasso_gesture', LINE: 'paint.hide_show_line_gesture', POLYLINE: 'paint.hide_show_polyline_gesture' },
  label: { BOX: 'Hide/Show', LASSO: 'Hide/Show Lasso', LINE: 'Hide/Show Line', POLYLINE: 'Hide/Show Polyline' },
  description: 'Hide or show the faces inside (or outside) the drawn shape',
  props: [
    {
      id: 'action',
      label: 'Action',
      type: 'enum',
      default: 'HIDE',
      items: [
        ['HIDE', 'Hide', 'Hide faces'],
        ['SHOW', 'Show', 'Show faces'],
      ],
    },
    {
      id: 'area',
      label: 'Visibility Area',
      type: 'enum',
      default: 'INSIDE',
      items: [
        ['OUTSIDE', 'Outside', 'Affect the faces outside the shape'],
        ['INSIDE', 'Inside', 'Affect the faces inside the shape'],
      ],
    },
    FRONT,
  ],
  ctrlProps: { action: 'SHOW' },
  apply: (v, g, p) => {
    const s = meshSession();
    if (!s) return 'CANCELLED';
    const { me } = activeMeshData()!;
    const showing = p.action === 'SHOW';
    // shown faces are hidden at the moment, so test them without the hidden-face filter
    const savedF = s.hiddenF,
      savedV = s.hiddenV;
    if (showing) {
      s.hiddenF = null;
      s.hiddenV = null;
    }
    const gh = gestureHits(v, g);
    const inside = gh ? facesInside(gh, !!p.use_front_faces_only) : null;
    s.hiddenF = savedF;
    s.hiddenV = savedV;
    if (!inside) return 'CANCELLED';
    const nf = faceCount(me);
    const cur = hiddenFacesOf(me);
    const hide = cur ? cur.slice() : new Uint8Array(nf);
    const outside = p.area === 'OUTSIDE';
    for (let f = 0; f < nf; f++) if (!!inside[f] !== outside) hide[f] = showing ? 0 : 1;
    commitHidden(me, hide);
  },
});

registerGestureTarget({
  ops: { BOX: 'sculpt.face_set_box_gesture', LASSO: 'sculpt.face_set_lasso_gesture', LINE: 'sculpt.face_set_line_gesture', POLYLINE: 'sculpt.face_set_polyline_gesture' },
  label: { BOX: 'Face Set Box Gesture', LASSO: 'Face Set Lasso Gesture', LINE: 'Face Set Line Gesture', POLYLINE: 'Face Set Polyline Gesture' },
  description: 'Put the faces inside the drawn shape into a new face set',
  props: [FRONT],
  apply: (v, g, p) => {
    const gh = gestureHits(v, g);
    if (!gh) return 'CANCELLED';
    const inside = facesInside(gh, !!p.use_front_faces_only);
    const { me } = activeMeshData()!;
    const fs = newFaceSets(me);
    const id = maxFaceSet(faceSetsOf(me)) + 1;
    let n = 0;
    for (let f = 0; f < inside.length; f++)
      if (inside[f]) {
        fs[f] = id;
        n++;
      }
    if (!n) return 'CANCELLED';
    commitFaceSets(me, fs);
  },
});

registerGestureTarget({
  ops: { LINE: 'sculpt.project_line_gesture' },
  label: { LINE: 'Project Line Gesture' },
  description: 'Flatten the part of the mesh on one side of the line onto the plane through the line',
  props: [FRONT],
  apply: (v, g, p) => projectLine(v, g, !!p.use_front_faces_only),
});

/** Move the vertices on the active side of the line onto the plane through the line and the view direction. */
function projectLine(v: View3D, g: Gesture, frontOnly: boolean): 'CANCELLED' | void {
  if (g.kind !== 'LINE') return 'CANCELLED';
  const gh = gestureHits(v, g);
  if (!gh) return 'CANCELLED';
  const { s } = gh;
  const { me } = activeMeshData()!;
  const inside = vertsInside(gh, frontOnly);
  // plane in object space: contains both line ends (at the depth of the mesh center) and the view direction
  const world = s.world();
  const inv = world.clone().invert();
  const center = new Vector3();
  for (let i = 0; i < s.nv; i++) center.x += s.positions[i * 3] / s.nv, center.y += s.positions[i * 3 + 1] / s.nv, center.z += s.positions[i * 3 + 2] / s.nv;
  const cw = center.clone().applyMatrix4(world);
  const a = v.unproject(g.a.x, g.a.y, cw).applyMatrix4(inv);
  const b = v.unproject(g.b.x, g.b.y, cw).applyMatrix4(inv);
  const ray = s.localRay(v, (g.a.x + g.b.x) / 2, (g.a.y + g.b.y) / 2).direction;
  const n = b.clone().sub(a).cross(ray).normalize();
  if (n.lengthSq() < 1e-12) return 'CANCELLED';
  const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  let moved = 0;
  beginGeometryStroke(s, me, () => cow(me, 'positions'));
  const P = s.positions;
  const touched: number[] = [];
  for (let i = 0; i < s.nv; i++) {
    if (!inside[i]) continue;
    const k = 1 - (mask ? mask[i] : 0);
    if (k <= 0) continue;
    const d = (P[i * 3] - a.x) * n.x + (P[i * 3 + 1] - a.y) * n.y + (P[i * 3 + 2] - a.z) * n.z;
    // only the side behind the plane (the side the gesture points to) is pushed onto it
    P[i * 3] -= n.x * d * k;
    P[i * 3 + 1] -= n.y * d * k;
    P[i * 3 + 2] -= n.z * d * k;
    touched.push(i);
    moved++;
  }
  if (!moved) return 'CANCELLED';
  finishDeform(s, me, touched);
}

/** After a whole-mesh deformation: normals, GPU buffers and the depsgraph. */
export function finishDeform(s: ReturnType<typeof meshSession> & object, me: MeshData, touched: number[] | null) {
  if (touched && touched.length < s.nv / 2) {
    const faces = s.updateNormals(touched, touched.length);
    s.writeFaces(faces, me.smooth);
  } else {
    s.recomputeNormals();
    const all: number[] = [];
    for (let f = 0; f < s.nf; f++) all.push(f);
    s.writeFaces(all, me.smooth);
  }
  if (s.direct) s.flush();
  s.finishGeometry();
  if (!s.direct) reevaluate(s);
  // flat corner normals for the polygon tools
  if (me.normals.length === s.nc * 3) {
    const N = cow(me, 'normals');
    for (let f = 0; f < s.nf; f++) {
      const l = Math.hypot(s.fn[f * 3], s.fn[f * 3 + 1], s.fn[f * 3 + 2]) || 1;
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        N[c * 3] = s.fn[f * 3] / l;
        N[c * 3 + 1] = s.fn[f * 3 + 1] / l;
        N[c * 3 + 2] = s.fn[f * 3 + 2] / l;
      }
    }
  }
  app.changed('geometry');
}
