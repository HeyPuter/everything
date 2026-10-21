// Custom bone shapes: a pose bone can be drawn as the wireframe of another object (a mesh's edges,
// a curve's evaluated outline or an empty's display shape) placed by the bone, offset by the
// custom shape translation / rotation / scale, optionally scaled by the bone length. The shape
// replaces the bone in the viewport and is picked like it.
import { BufferGeometry, Euler, Float32BufferAttribute, LineBasicMaterial, LineSegments, Matrix4, Quaternion, Vector3, type Group } from 'three';
import { app } from '../../app/app';
import type { DocumentData, ObjectData, PoseBone } from '../../data/types';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import type { EvalObject } from '../../eval/depsgraph';
import { edgeTopology } from '../../mesh/mesh';
import { emptyWire } from '../../render/helpers';

/** Line segments (xyz pairs, object space of the shape) of a custom shape object. */
export function shapeSegments(doc: DocumentData, shape: ObjectData): number[] {
  const out: number[] = [];
  if (shape.type === 'MESH') {
    const ev = app.graph.get(shape.id)?.mesh;
    const me = shape.data ? doc.meshes[shape.data] : undefined;
    const src = ev ?? me;
    if (!src) return out;
    const pos = src.positions;
    const push = (a: number, b: number) => out.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
    if (src.indices.length) {
      const e = edgeTopology(src).verts;
      for (let i = 0; i < e.length; i += 2) push(e[i], e[i + 1]);
    }
    // wire-only shapes are made of loose edges
    const loose = ev ? ev.looseEdges : me?.loose_edges;
    if (loose) for (let i = 0; i + 1 < loose.length; i += 2) push(loose[i], loose[i + 1]);
    return out;
  }
  if (shape.type === 'EMPTY') return emptyWire(shape);
  if (shape.type === 'CURVE') {
    const ev = app.graph.get(shape.id)?.mesh;
    const pos = ev?.positions as ArrayLike<number> | undefined;
    if (!pos) return out;
    // curves without faces evaluate to a polyline per spline: connect consecutive points
    for (let i = 0; i + 5 < pos.length; i += 3) out.push(pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5]);
  }
  return out;
}

/** Bone-space placement of a pose bone's custom shape. */
export function customShapeMatrix(pb: PoseBone, boneLength: number): Matrix4 {
  const t = pb.custom_shape_translation ?? [0, 0, 0];
  const r = pb.custom_shape_rotation_euler ?? [0, 0, 0];
  const sc = pb.custom_shape_scale_xyz ?? [1, 1, 1];
  const k = pb.use_custom_shape_bone_size === false ? 1 : boneLength;
  const q = new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));
  return new Matrix4().compose(new Vector3(t[0], t[1], t[2]), q, new Vector3(sc[0] * k, sc[1] * k, sc[2] * k));
}

/** The pose bone's custom shape object, when it has one that is drawn. */
export function customShapeOf(doc: DocumentData, ob: ObjectData, name: string): ObjectData | null {
  const arm = ob.data ? doc.armatures[ob.data] : undefined;
  if (!arm || arm.show_bone_custom_shapes === false) return null;
  const id = ob.pose?.[name]?.custom_shape;
  const shape = id ? doc.objects[id] : undefined;
  return shape && shape.id !== ob.id ? shape : null;
}

/** Armature-space segments of a custom-shaped bone (for picking), or null. */
export function customShapeWorldSegments(ob: ObjectData, name: string): Vector3[] | null {
  const doc = app.doc;
  const shape = customShapeOf(doc, ob, name);
  const ev = app.graph.get(ob.id);
  const be = ev?.pose?.bones.get(name);
  if (!shape || !ev || !be) return null;
  const m = ev.world.clone().multiply(be.pose).multiply(customShapeMatrix(ob.pose![name], be.length));
  const seg = shapeSegments(doc, shape);
  const out: Vector3[] = [];
  for (let i = 0; i < seg.length; i += 3) out.push(new Vector3(seg[i], seg[i + 1], seg[i + 2]).applyMatrix4(m));
  return out;
}

// ---------------------------------------------------------------------------
// scene sync: custom-shaped bones are drawn as their shape's wires

const signatures = new WeakMap<Group, string>();

function syncCustomShapes(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
  const ob = ev.ob;
  if (ob.type !== 'ARMATURE' || !so.bones || !ev.pose) return;
  const g = so.bones;
  const names = ev.pose.order.filter((n) => customShapeOf(doc, ob, n));
  // rebuilt when the bones were rebuilt (new group) or the shapes / their settings changed
  const sig = names
    .map((n) => {
      const pb = ob.pose![n];
      const shape = doc.objects[pb.custom_shape!];
      return `${n}:${shape.id}:${app.graph.get(shape.id)?.geomVersion ?? 0}:${shape.empty_display_type}:${shape.empty_display_size}:${JSON.stringify([pb.custom_shape_translation, pb.custom_shape_rotation_euler, pb.custom_shape_scale_xyz, pb.use_custom_shape_bone_size, pb.custom_shape_wire_width])}`;
    })
    .join('|');
  if (signatures.get(g) === sig) return;
  signatures.set(g, sig);
  for (const c of [...g.children]) if (c.userData.customShape) g.remove(c);
  if (!names.length) return;
  const shaped = new Set(names);
  for (const c of g.children) if (shaped.has(c.userData.bone as string)) c.visible = false;
  for (const n of names) {
    const be = ev.pose.bones.get(n)!;
    const pb = ob.pose![n];
    const seg = shapeSegments(doc, doc.objects[pb.custom_shape!]);
    if (!seg.length) continue;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(seg, 3));
    const l = new LineSegments(geo, new LineBasicMaterial({ color: 0x000000, linewidth: pb.custom_shape_wire_width ?? 1 }));
    l.matrixAutoUpdate = false;
    l.matrix.copy(be.pose).multiply(customShapeMatrix(pb, be.length));
    l.userData.bone = n;
    l.userData.id = ev.id;
    l.userData.customShape = true;
    g.add(l);
  }
}

sceneSyncHooks.push(syncCustomShapes);
