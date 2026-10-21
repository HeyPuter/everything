// Object-mode operators.
import { Matrix4, Vector3, Quaternion, Euler } from 'three';
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import type { DocumentData, ObjectData, MeshData, Mode, ObjectType, ID, Spline } from '../data/types';
import { newObject, newMeshData, newLight, newCamera, newCurve, newArmature, newLattice, newCollection, uid, IDENTITY, newMaterial } from '../data/defaults';
import * as prim from '../mesh/primitives';
import { monkey } from '../mesh/monkey';
import { applyMatrixToObject, localMatrix, toMatrix4, fromMatrix4, setRotationFromQuaternion } from '../eval/transform';
import { cloneShared } from '../data/cow';
import { bounds, buildMesh, toPolys } from '../mesh/mesh';
import { startTransform } from './transform';
import { uiState, prefs } from '../app/prefs';
import { activeView3D } from '../editors/view3d/view3d';
import { openMenu, promptText } from '../ui/menu';
import { newConstraint } from '../eval/constraints';
import { modeHandlers } from './modes';
import { curvePoints, edgeChains, surfaceCenter, translateCurve, volumeCenter } from '../object/core';
import { defaultPoseBone } from '../eval/armature';
import { newModifier } from '../eval/modifiers';
import { textToCurves } from '../eval/text';

// ---------------------------------------------------------------------------
// helpers

export function activeCollection(doc: DocumentData): ID {
  const id = (uiState as unknown as { activeCollection?: string }).activeCollection;
  if (id && doc.collections[id]) return id;
  // default: the (first) collection holding the active object, else the first child collection
  const act = doc.scene.active_object;
  const holder = act ? Object.values(doc.collections).find((c) => c.id !== doc.scene.collection && c.objects.includes(act)) : undefined;
  if (holder) return holder.id;
  return doc.collections[doc.scene.collection].children[0] ?? doc.scene.collection;
}

export function setActiveCollection(id: string) {
  (uiState as unknown as { activeCollection?: string }).activeCollection = id;
}

function uniqueName(doc: DocumentData, base: string, kind: 'objects' | 'meshes' | 'materials' | 'collections' | 'curves' | 'lights' | 'cameras' | 'armatures' | 'lattices' | 'actions' | 'images' | 'node_groups' | 'texts' = 'objects') {
  const names = new Set(Object.values(doc[kind] as Record<string, { name: string }>).map((o) => o.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}
export { uniqueName };

/** Set by the curve edit mode module: append a spline (object-space at location) to the edited curve. */
export const curveEditHooks: { addSpline?: (sp: Spline, location: number[], rotation?: number[]) => boolean } = {};

/** Let feature modules adjust the objects object.convert processes (e.g. a metaball family converts as one). */
export const convertHooks: ((doc: DocumentData, objects: ObjectData[], keepOriginal: boolean) => ObjectData[])[] = [];

/** Link a new object into the scene at the 3D cursor and make it active. */
export function addObjectToScene(doc: DocumentData, ob: ObjectData, props: Record<string, unknown> = {}) {
  ob.name = uniqueName(doc, ob.name);
  const loc = (props.location as number[]) ?? doc.scene.cursor.location;
  ob.location = [...loc] as [number, number, number];
  const align = props.align as string | undefined;
  if (props.rotation) ob.rotation_euler = [...(props.rotation as number[])] as [number, number, number];
  else if (align === 'VIEW') {
    const v = activeView3D();
    if (v) {
      const e = new Euler().setFromQuaternion(v.camera.quaternion, 'ZYX');
      ob.rotation_euler = [e.x, e.y, e.z];
    }
  } else if (align === 'CURSOR') ob.rotation_euler = [...doc.scene.cursor.rotation_euler] as [number, number, number];
  for (const o of Object.values(doc.objects)) o.select = false;
  ob.select = true;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[activeCollection(doc)].objects.push(ob.id);
  doc.scene.active_object = ob.id;
  return ob;
}

const transformProps: PropDef[] = [
  { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
  { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance', hidden: false },
  { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
];

function primitiveOp(idname: string, label: string, name: string, props: PropDef[], build: (p: Record<string, unknown>) => ReturnType<typeof prim.cube>, smooth = false) {
  return {
    idname,
    label,
    description: `Construct a ${label.replace('Add ', '').toLowerCase()} mesh`,
    props: [...props, { id: 'generate_uvs', label: 'Generate UVs', type: 'bool' as const, default: true }, ...transformProps, { id: 'scale', label: 'Scale', type: 'vec3' as const, default: null, hidden: true }],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' || ctx.doc.mode === 'EDIT',
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const doc = ctx.doc;
      // in edit mode the primitive is added to the edited mesh
      if (doc.mode === 'EDIT') {
        const add = modeHandlers.EDIT?.addPrimitive;
        if (add) return add(build(p), p);
        return 'CANCELLED';
      }
      const me = newMeshData(uniqueName(doc, name, 'meshes'), build(p));
      if (smooth && me.smooth) me.smooth.fill(1);
      doc.meshes[me.id] = me;
      const ob = newObject(name, 'MESH', me.id);
      if (p.location === null) p.location = [...doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(doc, ob, p);
      if (Array.isArray(p.scale)) ob.scale = [...(p.scale as number[])] as [number, number, number];
      if (!p.rotation) p.rotation = [...ob.rotation_euler];
      return 'FINISHED';
    },
  };
}

const sizeProp = (d = 2): PropDef => ({ id: 'size', label: 'Size', type: 'float', default: d, min: 0, subtype: 'distance' });
const radiusProp = (id = 'radius', d = 1, label = 'Radius'): PropDef => ({ id, label, type: 'float', default: d, min: 0, subtype: 'distance' });
const fillProp: PropDef = { id: 'fill_type', label: 'Fill Type', type: 'enum', default: 'NOTHING', items: [['NOTHING', 'Nothing'], ['NGON', 'N-Gon'], ['TRIFAN', 'Triangle Fan']] };
const capProp: PropDef = { id: 'end_fill_type', label: 'Cap Fill Type', type: 'enum', default: 'NGON', items: [['NOTHING', 'Nothing'], ['NGON', 'N-Gon'], ['TRIFAN', 'Triangle Fan']] };

// ---------------------------------------------------------------------------

export function deleteObjects(doc: DocumentData, ids: Set<string>) {
  for (const id of ids) {
    const ob = doc.objects[id];
    if (!ob) continue;
    // children keep world transform
    for (const child of Object.values(doc.objects))
      if (child.parent === id) {
        const w = app.graph.get(child.id)?.world;
        child.parent = null;
        child.matrix_parent_inverse = [...IDENTITY];
        if (w) applyMatrixToObject(child, w);
      }
    delete doc.objects[id];
    for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((x) => x !== id);
    if (doc.scene.camera === id) doc.scene.camera = null;
    if (doc.scene.active_object === id) doc.scene.active_object = null;
  }
  doc.object_order = doc.object_order.filter((x) => !ids.has(x));
  // drop modifier/constraint references to deleted objects
  for (const ob of Object.values(doc.objects)) {
    for (const m of ob.modifiers) for (const k of Object.keys(m)) if (typeof m[k] === 'string' && ids.has(m[k] as string)) m[k] = null;
    for (const c of ob.constraints) if (c.target && ids.has(c.target as string)) c.target = null;
  }
  purgeOrphans(doc);
}

export const DATA_TABLES: Record<string, keyof DocumentData> = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', LIGHT: 'lights', CAMERA: 'cameras', ARMATURE: 'armatures', LATTICE: 'lattices', META: 'metaballs', CURVES: 'hair_curves', VOLUME: 'volumes', POINTCLOUD: 'pointclouds' };

/** Remove data-blocks without users (meshes, materials stay if fake user). */
export function purgeOrphans(doc: DocumentData) {
  const used = new Set<string>();
  for (const ob of Object.values(doc.objects)) if (ob.data) used.add(ob.data);
  for (const t of ['meshes', 'curves', 'lights', 'cameras', 'armatures', 'lattices', 'metaballs', 'hair_curves', 'volumes', 'pointclouds'] as const) for (const id of Object.keys(doc[t] ?? {})) if (!used.has(id)) delete (doc[t] as Record<string, unknown>)[id];
}

/** Copy a material for a duplicate; returns the new id. */
function copyMaterial(doc: DocumentData, id: string, done: Map<string, string>): string {
  const prev = done.get(id);
  if (prev) return prev;
  const src = doc.materials[id];
  if (!src) return id;
  const m = cloneShared(src);
  m.id = uid('ma');
  m.name = uniqueName(doc, src.name, 'materials');
  doc.materials[m.id] = m;
  done.set(id, m.id);
  return m.id;
}

function duplicateObject(doc: DocumentData, ob: ObjectData, linked: boolean, mats = new Map<string, string>()): ObjectData {
  const copy = cloneShared(ob);
  copy.id = uid('ob');
  copy.name = uniqueName(doc, ob.name);
  copy.animation_data = ob.animation_data ? cloneShared(ob.animation_data) : null;
  // Preferences ▸ Editing ▸ Copy on Duplicate decides which data a plain duplicate copies
  const dup = prefs.duplicate;
  if (!linked && ob.data && dup[ob.type] !== false) {
    const tables: Record<string, keyof DocumentData> = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', LIGHT: 'lights', CAMERA: 'cameras', ARMATURE: 'armatures', LATTICE: 'lattices', META: 'metaballs', GREASEPENCIL: 'grease_pencils', CURVES: 'hair_curves', VOLUME: 'volumes', POINTCLOUD: 'pointclouds' };
    const t = tables[ob.type];
    if (t && doc[t]) {
      const src = (doc[t] as Record<string, { id: string; name: string }>)[ob.data];
      if (src) {
        const d = cloneShared(src);
        d.id = uid(String(t).slice(0, 2));
        d.name = uniqueName(doc, src.name, t as 'meshes');
        (doc[t] as Record<string, unknown>)[d.id] = d;
        copy.data = d.id;
        if (dup.MATERIAL) {
          const slots = (d as unknown as { materials?: (string | null)[] }).materials;
          if (Array.isArray(slots)) (d as unknown as { materials: (string | null)[] }).materials = slots.map((m) => (m ? copyMaterial(doc, m, mats) : m));
        }
      }
    }
  }
  if (!linked && dup.MATERIAL && copy.object_materials) copy.object_materials = copy.object_materials.map((m) => (m ? copyMaterial(doc, m, mats) : m));
  if (copy.animation_data?.action && !linked && dup.ACTION !== false) {
    const act = doc.actions[copy.animation_data.action];
    if (act) {
      const a = cloneShared(act);
      a.id = uid('ac');
      a.name = uniqueName(doc, act.name, 'actions');
      doc.actions[a.id] = a;
      copy.animation_data.action = a.id;
    }
  }
  copy.modifiers = copy.modifiers.map((m) => ({ ...m, id: uid('md') }));
  copy.constraints = copy.constraints.map((c) => ({ ...c, id: uid('cn') }));
  doc.objects[copy.id] = copy;
  doc.object_order.push(copy.id);
  for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(copy.id);
  return copy;
}

export function duplicateSelected(doc: DocumentData, linked: boolean) {
  const sel = app.selectedObjects();
  if (!sel.length) return [];
  const map = new Map<string, string>();
  const mats = new Map<string, string>();
  const copies = sel.map((ob) => {
    const c = duplicateObject(doc, ob, linked, mats);
    map.set(ob.id, c.id);
    return c;
  });
  // remap parents and references between duplicated objects
  for (const c of copies) {
    if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!;
    for (const m of c.modifiers) for (const k of Object.keys(m)) if (typeof m[k] === 'string' && map.has(m[k] as string)) m[k] = map.get(m[k] as string);
    for (const k of c.constraints) if (k.target && map.has(k.target as string)) k.target = map.get(k.target as string)!;
  }
  for (const ob of sel) ob.select = false;
  for (const c of copies) c.select = true;
  const act = doc.scene.active_object;
  if (act && map.has(act)) doc.scene.active_object = map.get(act)!;
  return copies;
}

export function setMode(doc: DocumentData, mode: Mode): boolean {
  const ob = app.activeObject;
  if (mode !== 'OBJECT' && !ob) return false;
  if (doc.mode === mode) return true;
  // leave current mode
  const leave = modeHandlers[doc.mode]?.exit;
  if (leave) leave();
  if (mode !== 'OBJECT' && ob) {
    const enter = modeHandlers[mode]?.enter;
    if (enter && !enter(ob)) {
      doc.mode = 'OBJECT';
      return false;
    }
    if (!enter && mode !== 'EDIT' && mode !== 'POSE') {
      app.report('WARNING', `${mode} is not available for this object`);
      doc.mode = 'OBJECT';
      return false;
    }
    ob.select = true;
  }
  doc.mode = mode;
  if (ob) ob.mode = mode;
  return true;
}

function centerOfSelection(): Vector3 {
  const sel = app.selectedObjects();
  const c = new Vector3();
  for (const ob of sel) c.add(new Vector3().setFromMatrixPosition(app.graph.get(ob.id)!.world));
  return sel.length ? c.multiplyScalar(1 / sel.length) : c;
}

function objectData(doc: DocumentData, ob: ObjectData): MeshData | null {
  return ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] ?? null : null;
}

function transformMeshData(me: MeshData, m: Matrix4) {
  const P = new Float32Array(me.positions);
  const v = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m);
    P[i] = v.x;
    P[i + 1] = v.y;
    P[i + 2] = v.z;
  }
  me.positions = P;
  me.shape_keys = me.shape_keys.map((k) => {
    const d = new Float32Array(k.data);
    for (let i = 0; i < d.length; i += 3) {
      v.set(d[i], d[i + 1], d[i + 2]).applyMatrix4(m);
      d[i] = v.x;
      d[i + 1] = v.y;
      d[i + 2] = v.z;
    }
    return { ...k, data: d };
  });
  if (m.determinant() < 0) {
    // flip winding to keep normals outward
    const polys = toPolys(me).map((f) => {
      const n = f.verts.length;
      const order = Array.from({ length: n }, (_, i) => (n - i) % n);
      return { ...f, verts: order.map((i) => f.verts[i]), uvs: f.uvs ? order.flatMap((i) => [f.uvs![i * 2], f.uvs![i * 2 + 1]]) : undefined };
    });
    Object.assign(me, buildMesh(me.positions, polys));
  }
}

// ---------------------------------------------------------------------------

registerOperators([
  primitiveOp('mesh.primitive_cube_add', 'Add Cube', 'Cube', [sizeProp()], (p) => prim.cube(p.size as number)),
  primitiveOp('mesh.primitive_plane_add', 'Add Plane', 'Plane', [sizeProp()], (p) => prim.plane(p.size as number)),
  primitiveOp('mesh.primitive_circle_add', 'Add Circle', 'Circle', [{ id: 'vertices', label: 'Vertices', type: 'int', default: 32, min: 3, max: 10000000 }, radiusProp(), fillProp], (p) => prim.circle(p.vertices as number, p.radius as number, p.fill_type as 'NGON')),
  primitiveOp(
    'mesh.primitive_uv_sphere_add',
    'Add UV Sphere',
    'Sphere',
    [
      { id: 'segments', label: 'Segments', type: 'int', default: 32, min: 3, max: 100000 },
      { id: 'ring_count', label: 'Rings', type: 'int', default: 16, min: 3, max: 100000 },
      radiusProp(),
    ],
    (p) => prim.uvSphere(p.segments as number, p.ring_count as number, p.radius as number),
  ),
  primitiveOp('mesh.primitive_ico_sphere_add', 'Add Ico Sphere', 'Icosphere', [{ id: 'subdivisions', label: 'Subdivisions', type: 'int', default: 2, min: 1, max: 10 }, radiusProp()], (p) => prim.icoSphere(p.subdivisions as number, p.radius as number)),
  primitiveOp('mesh.primitive_cylinder_add', 'Add Cylinder', 'Cylinder', [{ id: 'vertices', label: 'Vertices', type: 'int', default: 32, min: 3, max: 10000000 }, radiusProp(), { id: 'depth', label: 'Depth', type: 'float', default: 2, min: 0, subtype: 'distance' }, capProp], (p) => prim.cylinder(p.vertices as number, p.radius as number, p.depth as number, p.end_fill_type as 'NGON')),
  primitiveOp(
    'mesh.primitive_cone_add',
    'Add Cone',
    'Cone',
    [{ id: 'vertices', label: 'Vertices', type: 'int', default: 32, min: 3, max: 10000000 }, radiusProp('radius1', 1, 'Radius 1'), radiusProp('radius2', 0, 'Radius 2'), { id: 'depth', label: 'Depth', type: 'float', default: 2, min: 0, subtype: 'distance' }, capProp],
    (p) => prim.cone(p.vertices as number, p.radius1 as number, p.radius2 as number, p.depth as number, p.end_fill_type as 'NGON'),
  ),
  primitiveOp(
    'mesh.primitive_torus_add',
    'Add Torus',
    'Torus',
    [
      { id: 'major_segments', label: 'Major Segments', type: 'int', default: 48, min: 3, max: 256 },
      { id: 'minor_segments', label: 'Minor Segments', type: 'int', default: 12, min: 3, max: 256 },
      radiusProp('major_radius', 1, 'Major Radius'),
      radiusProp('minor_radius', 0.25, 'Minor Radius'),
    ],
    (p) => prim.torus(p.major_segments as number, p.minor_segments as number, p.major_radius as number, p.minor_radius as number),
  ),
  primitiveOp('mesh.primitive_grid_add', 'Add Grid', 'Grid', [{ id: 'x_subdivisions', label: 'X Subdivisions', type: 'int', default: 10, min: 1, max: 10000 }, { id: 'y_subdivisions', label: 'Y Subdivisions', type: 'int', default: 10, min: 1, max: 10000 }, sizeProp()], (p) => prim.grid(p.x_subdivisions as number, p.y_subdivisions as number, p.size as number)),
  primitiveOp('mesh.primitive_monkey_add', 'Add Monkey', 'Monkey', [sizeProp()], (p) => monkey(p.size as number)),
  primitiveOp('mesh.primitive_mascot_add', 'Add Robot Head', 'Robot', [], () => prim.mascot(), true),
  {
    idname: 'object.empty_add',
    label: 'Add Empty',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'PLAIN_AXES', items: [['PLAIN_AXES', 'Plain Axes'], ['ARROWS', 'Arrows'], ['SINGLE_ARROW', 'Single Arrow'], ['CIRCLE', 'Circle'], ['CUBE', 'Cube'], ['SPHERE', 'Sphere'], ['CONE', 'Cone'], ['IMAGE', 'Image']] }, { id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance' }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const ob = newObject('Empty', 'EMPTY', null);
      ob.empty_display_type = p.type as ObjectData['empty_display_type'];
      ob.empty_display_size = p.radius as number;
      // an image empty starts without an image (chosen in its Object Data properties), centred on its origin
      if (p.type === 'IMAGE') ob.empty_image_offset = [-0.5, -0.5];
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'object.light_add',
    label: 'Add Light',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'POINT', items: [['POINT', 'Point'], ['SUN', 'Sun'], ['SPOT', 'Spot'], ['AREA', 'Area']] }, { id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance' }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const la = newLight(p.type as 'POINT');
      la.name = uniqueName(ctx.doc, la.name, 'lights');
      ctx.doc.lights[la.id] = la;
      const ob = newObject(la.name, 'LIGHT', la.id);
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'object.camera_add',
    label: 'Add Camera',
    props: transformProps,
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const ca = newCamera(uniqueName(ctx.doc, 'Camera', 'cameras'));
      ctx.doc.cameras[ca.id] = ca;
      const ob = newObject('Camera', 'CAMERA', ca.id);
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) {
        // new cameras face the current view direction by default
        const v = activeView3D();
        if (v && p.align === 'WORLD') {
          const e = new Euler().setFromQuaternion(v.camera.quaternion, 'ZYX');
          p.rotation = [e.x, e.y, e.z];
        } else delete p.rotation;
      }
      addObjectToScene(ctx.doc, ob, p);
      if (!ctx.doc.scene.camera) ctx.doc.scene.camera = ob.id;
    },
  },
  {
    idname: 'object.armature_add',
    label: 'Add Armature',
    props: [{ id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance' }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const arm = newArmature(uniqueName(ctx.doc, 'Armature', 'armatures'));
      const r = p.radius as number;
      arm.bones.push({ name: 'Bone', parent: null, head: [0, 0, 0], tail: [0, 0, r], roll: 0, use_connect: false, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1, collections: ['Bones'] });
      arm.collections = [{ name: 'Bones', is_visible: true }];
      arm.active_bone = 'Bone';
      ctx.doc.armatures[arm.id] = arm;
      const ob = newObject('Armature', 'ARMATURE', arm.id);
      ob.pose = { Bone: defaultPoseBone() };
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'object.add',
    label: 'Add Object',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'EMPTY', items: [['EMPTY', 'Empty'], ['LATTICE', 'Lattice']] }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      if (p.type === 'LATTICE') {
        const lt = newLattice(uniqueName(ctx.doc, 'Lattice'));
        ctx.doc.lattices[lt.id] = lt;
        const ob = newObject('Lattice', 'LATTICE', lt.id);
        if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
        if (p.rotation === null) delete p.rotation;
        addObjectToScene(ctx.doc, ob, p);
      } else {
        const ob = newObject('Empty', 'EMPTY', null);
        if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
        if (p.rotation === null) delete p.rotation;
        addObjectToScene(ctx.doc, ob, p);
      }
    },
  },
  ...curveAddOps(),
  {
    idname: 'object.collection_instance_add',
    label: 'Add Collection Instance',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const col = ctx.doc.collections[p.collection as string];
      if (!col) return 'CANCELLED';
      const ob = newObject(col.name, 'EMPTY', null);
      ob.instance_type = 'COLLECTION';
      ob.instance_collection = col.id;
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'object.effector_add',
    label: 'Add Effector',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'FORCE', items: [['FORCE', 'Force'], ['WIND', 'Wind'], ['VORTEX', 'Vortex'], ['TURBULENCE', 'Turbulence'], ['DRAG', 'Drag']] }, ...transformProps],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const t = p.type as 'FORCE' | 'WIND' | 'VORTEX' | 'TURBULENCE' | 'DRAG';
      const ob = newObject(t[0] + t.slice(1).toLowerCase(), 'EMPTY', null);
      ob.empty_display_type = t === 'WIND' ? 'SINGLE_ARROW' : 'SPHERE';
      ob.field = { type: t, strength: 1, flow: 0, falloff_type: 'SPHERE', noise: 0, seed: 1 };
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'object.pointcloud_add',
    label: 'Add Point Cloud',
    props: transformProps,
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      // a point cloud is represented as a mesh without faces
      const pts: number[] = [];
      let seed = 1;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      for (let i = 0; i < 400; i++) pts.push(rnd(), rnd(), rnd());
      const me = newMeshData(uniqueName(ctx.doc, 'PointCloud', 'meshes'), { positions: new Float32Array(pts), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
      ctx.doc.meshes[me.id] = me;
      const ob = newObject('PointCloud', 'MESH', me.id);
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  // -------------------------------------------------------------------
  {
    idname: 'object.select_all',
    label: '(De)select All',
    description: 'Change selection of all visible objects in scene',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const obs = Object.values(ctx.doc.objects).filter((o) => app.isSelectable(o.id));
      let action = p.action as string;
      if (action === 'TOGGLE') action = obs.some((o) => o.select) ? 'DESELECT' : 'SELECT';
      for (const o of obs) o.select = action === 'SELECT' ? true : action === 'DESELECT' ? false : !o.select;
    },
    redo: false,
  },
  {
    idname: 'object.select_by_type',
    label: 'Select All by Type',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'MESH', items: [['MESH', 'Mesh'], ['CURVE', 'Curve'], ['META', 'Metaball'], ['FONT', 'Text'], ['CURVES', 'Curves'], ['ARMATURE', 'Armature'], ['LATTICE', 'Lattice'], ['EMPTY', 'Empty'], ['CAMERA', 'Camera'], ['LIGHT', 'Light']] }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      for (const o of Object.values(ctx.doc.objects)) {
        if (!app.isSelectable(o.id)) continue;
        if (o.type === p.type) o.select = true;
        else if (!p.extend) o.select = false;
      }
    },
  },
  {
    idname: 'object.select_camera',
    label: 'Select Camera',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!ctx.doc.scene.camera,
    exec: (ctx) => {
      for (const o of Object.values(ctx.doc.objects)) o.select = false;
      const cam = ctx.doc.objects[ctx.doc.scene.camera!];
      cam.select = true;
      ctx.doc.scene.active_object = cam.id;
    },
  },
  {
    idname: 'object.select_random',
    label: 'Select Random',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' }, { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 }, { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      let s = (p.seed as number) + 1;
      for (const o of Object.values(ctx.doc.objects)) {
        if (!app.isSelectable(o.id)) continue;
        s = (s * 16807) % 2147483647;
        if (s / 2147483647 < (p.ratio as number)) o.select = p.action === 'SELECT';
      }
    },
  },
  {
    idname: 'object.select_mirror',
    label: 'Select Mirror',
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx) => {
      const swap = (n: string) => n.replace(/([._-])([LlRr])$/, (_, s, c) => s + ({ L: 'R', R: 'L', l: 'r', r: 'l' } as Record<string, string>)[c]);
      const byName = new Map(Object.values(ctx.doc.objects).map((o) => [o.name, o]));
      for (const o of app.selectedObjects()) {
        const m = byName.get(swap(o.name));
        if (m && m !== o) {
          o.select = false;
          m.select = true;
        }
      }
    },
  },
  {
    idname: 'object.select_hierarchy',
    label: 'Select Hierarchy',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'PARENT', items: [['PARENT', 'Parent'], ['CHILD', 'Child']] }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject,
    exec: (ctx, p) => {
      const sel = app.selectedObjects();
      const next = new Set<string>();
      for (const o of sel) {
        if (p.direction === 'PARENT' && o.parent) next.add(o.parent);
        if (p.direction === 'CHILD') for (const c of Object.values(ctx.doc.objects)) if (c.parent === o.id) next.add(c.id);
      }
      if (!next.size) return 'CANCELLED';
      if (!p.extend) for (const o of sel) o.select = false;
      for (const id of next) ctx.doc.objects[id].select = true;
      ctx.doc.scene.active_object = [...next][0];
    },
  },
  {
    idname: 'object.select_grouped',
    label: 'Select Grouped',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CHILDREN_RECURSIVE', items: [['CHILDREN_RECURSIVE', 'Children'], ['CHILDREN', 'Immediate Children'], ['PARENT', 'Parent'], ['SIBLINGS', 'Siblings'], ['TYPE', 'Type'], ['COLLECTION', 'Collection'], ['HOOK', 'Hook'], ['PASS', 'Pass'], ['COLOR', 'Color'], ['LIGHT_TYPE', 'Light Type']] }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject,
    exec: (ctx, p) => {
      const act = app.activeObject!;
      const doc = ctx.doc;
      const all = Object.values(doc.objects).filter((o) => app.isSelectable(o.id));
      const pick = (o: ObjectData): boolean => {
        switch (p.type) {
          case 'CHILDREN_RECURSIVE': {
            let q = o.parent;
            while (q) {
              if (q === act.id) return true;
              q = doc.objects[q]?.parent ?? null;
            }
            return false;
          }
          case 'CHILDREN':
            return o.parent === act.id;
          case 'PARENT':
            return o.id === act.parent;
          case 'SIBLINGS':
            return o.parent === act.parent && o.id !== act.id;
          case 'TYPE':
            return o.type === act.type;
          case 'COLLECTION':
            return Object.values(doc.collections).some((c) => c.objects.includes(o.id) && c.objects.includes(act.id));
          case 'HOOK':
            return act.modifiers.some((m) => m.type === 'HOOK' && m.object === o.id);
          case 'PASS':
            return (o.pass_index ?? 0) === (act.pass_index ?? 0);
          case 'COLOR':
            return o.color.every((c, i) => Math.abs(c - act.color[i]) < 1e-4);
          case 'LIGHT_TYPE':
            return o.type === 'LIGHT' && act.type === 'LIGHT' && doc.lights[o.data!]?.type === doc.lights[act.data!]?.type;
        }
        return false;
      };
      if (!p.extend) for (const o of all) o.select = false;
      for (const o of all) if (pick(o)) o.select = true;
    },
  },
  {
    idname: 'object.select_linked',
    label: 'Select Linked',
    description: 'Select objects that share data with the active object',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'OBDATA',
        items: [
          ['OBDATA', 'Object Data'],
          ['MATERIAL', 'Material'],
          ['DUPGROUP', 'Instanced Collection'],
          ['PARTICLE', 'Particle System'],
        ],
      },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject,
    exec: (ctx, p) => {
      const act = app.activeObject!;
      const mats = (o: ObjectData) => (o.data ? ((ctx.doc.meshes[o.data] ?? ctx.doc.curves[o.data]) as { materials?: (string | null)[] } | undefined)?.materials ?? [] : []);
      const parts = (o: ObjectData) => (o.particle_systems ?? []).map((ps) => ps.settings);
      const am = new Set(mats(act).filter(Boolean));
      const ap = new Set(parts(act));
      const match = (o: ObjectData) => {
        switch (p.type) {
          case 'OBDATA':
            return !!o.data && o.data === act.data;
          case 'MATERIAL':
            return mats(o).some((m) => m && am.has(m));
          case 'DUPGROUP':
            return act.instance_type === 'COLLECTION' && !!act.instance_collection && o.instance_type === 'COLLECTION' && o.instance_collection === act.instance_collection;
          case 'PARTICLE':
            return parts(o).some((x) => ap.has(x));
        }
        return false;
      };
      for (const o of Object.values(ctx.doc.objects)) {
        if (!app.isSelectable(o.id)) continue;
        if (match(o)) o.select = true;
        else if (!p.extend) o.select = false;
      }
      act.select = true;
    },
  },
  {
    idname: 'object.select_pattern',
    label: 'Select Pattern',
    props: [{ id: 'pattern', label: 'Pattern', type: 'string', default: '*' }, { id: 'case_sensitive', label: 'Case Sensitive', type: 'bool', default: false }, { id: 'extend', label: 'Extend', type: 'bool', default: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const src = String(p.pattern).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp(`^${src}$`, p.case_sensitive ? '' : 'i');
      for (const o of Object.values(ctx.doc.objects)) {
        if (!app.isSelectable(o.id)) continue;
        if (re.test(o.name)) o.select = true;
        else if (!p.extend) o.select = false;
      }
    },
  },
  {
    idname: 'object.delete',
    label: 'Delete',
    description: 'Delete selected objects',
    props: [{ id: 'use_global', label: 'Delete Globally', type: 'bool', default: false }, { id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    invoke: (ctx, p) => {
      if (p.confirm && ctx.area?.type === 'VIEW_3D') {
        openMenu([{ heading: 'Delete selected objects?' }, { label: 'Delete', action: () => app.run('object.delete', { ...p, confirm: false }, { invoke: false }) }], { x: app.pointer.x, y: app.pointer.y });
        return 'CANCELLED';
      }
      return operatorsExec('object.delete', ctx, p);
    },
    exec: (ctx) => {
      const ids = new Set(app.selectedObjects().map((o) => o.id));
      deleteObjects(ctx.doc, ids);
      app.report('INFO', `Deleted ${ids.size} object(s)`);
    },
  },
  {
    idname: 'object.duplicate_move',
    label: 'Duplicate Objects',
    description: 'Duplicate selected objects and move them',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    invoke: (ctx) => {
      duplicateSelected(ctx.doc, false);
      app.pushUndo('Duplicate Objects');
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event });
      return 'RUNNING_MODAL';
    },
    exec: (ctx) => {
      duplicateSelected(ctx.doc, false);
    },
  },
  {
    idname: 'object.duplicate_move_linked',
    label: 'Duplicate Linked',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    invoke: (ctx) => {
      duplicateSelected(ctx.doc, true);
      app.pushUndo('Duplicate Linked');
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event });
      return 'RUNNING_MODAL';
    },
    exec: (ctx) => {
      duplicateSelected(ctx.doc, true);
    },
  },
  {
    idname: 'object.mode_set',
    label: 'Set Object Mode',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'OBJECT', items: [['OBJECT', 'Object Mode'], ['EDIT', 'Edit Mode'], ['SCULPT', 'Sculpt Mode'], ['VERTEX_PAINT', 'Vertex Paint'], ['WEIGHT_PAINT', 'Weight Paint'], ['TEXTURE_PAINT', 'Texture Paint'], ['POSE', 'Pose Mode']] }, { id: 'toggle', label: 'Toggle', type: 'bool', default: false }],
    poll: (ctx) => !!app.activeObject || ctx.doc.mode !== 'OBJECT',
    exec: (ctx, p) => {
      let mode = p.mode as Mode;
      if (p.toggle && ctx.doc.mode === mode) mode = 'OBJECT';
      if (!setMode(ctx.doc, mode)) return 'CANCELLED';
      app.changed('mode');
    },
    redo: false,
  },
  {
    idname: 'object.editmode_toggle',
    label: 'Toggle Edit Mode',
    poll: () => !!app.activeObject && ['MESH', 'CURVE', 'FONT', 'ARMATURE', 'LATTICE', 'META'].includes(app.activeObject.type),
    exec: (ctx) => {
      if (!setMode(ctx.doc, ctx.doc.mode === 'EDIT' ? 'OBJECT' : 'EDIT')) return 'CANCELLED';
      app.changed('mode');
    },
  },
  {
    idname: 'object.posemode_toggle',
    label: 'Toggle Pose Mode',
    poll: () => app.activeObject?.type === 'ARMATURE',
    exec: (ctx) => {
      setMode(ctx.doc, ctx.doc.mode === 'POSE' ? 'OBJECT' : 'POSE');
      app.changed('mode');
    },
  },
  {
    idname: 'object.hide_view_set',
    label: 'Hide Selected',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      for (const o of Object.values(ctx.doc.objects)) {
        if (!app.isVisible(o.id)) continue;
        if (p.unselected ? !o.select : o.select) {
          o.hide = true;
          o.select = false;
        }
      }
    },
  },
  {
    idname: 'object.hide_view_clear',
    label: 'Show Hidden Objects',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      for (const o of Object.values(ctx.doc.objects))
        if (o.hide) {
          o.hide = false;
          if (p.select) o.select = true;
        }
    },
  },
  {
    idname: 'object.shade_smooth',
    label: 'Shade Smooth',
    description: 'Render and display faces smooth, using interpolated vertex normals',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => o.type === 'MESH'),
    exec: (ctx) => setShading(ctx.doc, true, undefined),
  },
  {
    idname: 'object.shade_flat',
    label: 'Shade Flat',
    description: 'Render and display faces uniform, using face normals',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => o.type === 'MESH'),
    exec: (ctx) => setShading(ctx.doc, false, undefined),
  },
  {
    idname: 'object.shade_auto_smooth',
    label: 'Shade Auto Smooth',
    description: 'Add a Smooth by Angle modifier (or set angle-based smoothing) to the selected meshes',
    props: [{ id: 'angle', label: 'Angle', type: 'float', default: (30 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => o.type === 'MESH'),
    exec: (ctx, p) => {
      for (const ob of app.selectedObjects()) {
        if (ob.type !== 'MESH') continue;
        let m = ob.modifiers.find((x) => x.type === 'SMOOTH_BY_ANGLE');
        if (!m) {
          m = newModifier('SMOOTH_BY_ANGLE', uid('md'), ob.modifiers);
          ob.modifiers.push(m);
        }
        m.angle = p.angle;
      }
      setShading(ctx.doc, true, undefined);
    },
  },
  {
    idname: 'object.location_clear',
    label: 'Clear Location',
    props: [{ id: 'clear_delta', label: 'Clear Delta', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      for (const o of app.selectedObjects()) {
        o.location = o.location.map((v, i) => (o.lock_location[i] ? v : 0)) as [number, number, number];
        if (p.clear_delta) o.delta_location = o.delta_location.map((v, i) => (o.lock_location[i] ? v : 0)) as [number, number, number];
      }
    },
  },
  {
    idname: 'object.rotation_clear',
    label: 'Clear Rotation',
    props: [{ id: 'clear_delta', label: 'Clear Delta', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      for (const o of app.selectedObjects()) {
        if (p.clear_delta) o.delta_rotation_euler = o.delta_rotation_euler.map((v, i) => (o.lock_rotation[i] ? v : 0)) as [number, number, number];
        o.rotation_euler = o.rotation_euler.map((v, i) => (o.lock_rotation[i] ? v : 0)) as [number, number, number];
        o.rotation_quaternion = [1, 0, 0, 0];
        o.rotation_axis_angle = [0, 0, 1, 0];
      }
    },
  },
  {
    idname: 'object.scale_clear',
    label: 'Clear Scale',
    props: [{ id: 'clear_delta', label: 'Clear Delta', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      for (const o of app.selectedObjects()) {
        o.scale = o.scale.map((v, i) => (o.lock_scale[i] ? v : 1)) as [number, number, number];
        if (p.clear_delta) o.delta_scale = o.delta_scale.map((v, i) => (o.lock_scale[i] ? v : 1)) as [number, number, number];
      }
    },
  },
  {
    idname: 'object.origin_clear',
    label: 'Clear Origin',
    description: 'Clear the object’s origin offset relative to its parent',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => !!o.parent),
    exec: () => {
      for (const o of app.selectedObjects()) if (o.parent) o.location = [0, 0, 0];
    },
  },
  {
    idname: 'object.transform_apply',
    label: 'Apply Object Transform',
    description: 'Apply the object’s transformation to its data',
    props: [{ id: 'location', label: 'Location', type: 'bool', default: true }, { id: 'rotation', label: 'Rotation', type: 'bool', default: true }, { id: 'scale', label: 'Scale', type: 'bool', default: true }, { id: 'properties', label: 'Apply Properties', type: 'bool', default: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const users = new Map<string, number>();
      for (const o of Object.values(doc.objects)) if (o.data) users.set(o.data, (users.get(o.data) ?? 0) + 1);
      for (const ob of app.selectedObjects()) {
        if (ob.data && (users.get(ob.data) ?? 0) > 1) {
          app.report('WARNING', `Cannot apply to a multi user: Object "${ob.name}", ${ob.type === 'MESH' ? 'Mesh' : 'Data'} "${(doc.meshes[ob.data] ?? doc.curves[ob.data])?.name ?? ob.data}", aborting`);
          return 'CANCELLED';
        }
        const T = new Matrix4().makeTranslation(ob.location[0], ob.location[1], ob.location[2]);
        const R = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromRotationMatrix(localMatrix(ob)));
        const S = new Matrix4().makeScale(ob.scale[0], ob.scale[1], ob.scale[2]);
        const m = new Matrix4();
        if (p.location) m.premultiply(new Matrix4());
        let apply = new Matrix4();
        if (p.scale) apply = S.clone().multiply(apply);
        if (p.rotation) apply = R.clone().multiply(apply);
        if (p.location) apply = T.clone().multiply(apply);
        void m;
        const me = objectData(doc, ob);
        if (me) transformMeshData(me, apply);
        else if ((ob.type === 'CURVE' || ob.type === 'FONT') && ob.data) transformCurve(doc.curves[ob.data].splines, apply);
        else if (ob.type === 'LIGHT' || ob.type === 'CAMERA' || ob.type === 'EMPTY') {
          if (p.scale && ob.type === 'EMPTY') ob.empty_display_size *= Math.max(...ob.scale.map(Math.abs));
        }
        // children keep their world placement
        const children = Object.values(doc.objects).filter((c) => c.parent === ob.id);
        const childWorld = children.map((c) => app.graph.get(c.id)!.world.clone());
        if (p.location) ob.location = [0, 0, 0];
        if (p.rotation) {
          ob.rotation_euler = [0, 0, 0];
          ob.rotation_quaternion = [1, 0, 0, 0];
          ob.rotation_axis_angle = [0, 0, 1, 0];
        }
        if (p.scale) ob.scale = [1, 1, 1];
        const newWorld = (() => {
          const parent = ob.parent ? app.graph.get(ob.parent)?.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)) : new Matrix4();
          return (parent ?? new Matrix4()).multiply(localMatrix(ob));
        })();
        children.forEach((c, i) => {
          c.matrix_parent_inverse = fromMatrix4(newWorld.clone().invert().multiply(childWorld[i]).multiply(localMatrix(c).invert()));
        });
      }
    },
  },
  {
    idname: 'object.origin_set',
    label: 'Set Origin',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'ORIGIN_GEOMETRY', items: [['GEOMETRY_ORIGIN', 'Geometry to Origin'], ['ORIGIN_GEOMETRY', 'Origin to Geometry'], ['ORIGIN_CURSOR', 'Origin to 3D Cursor'], ['ORIGIN_CENTER_OF_MASS', 'Origin to Center of Mass (Surface)'], ['ORIGIN_CENTER_OF_VOLUME', 'Origin to Center of Mass (Volume)']] }, { id: 'center', label: 'Center', type: 'enum', default: 'MEDIAN', items: [['MEDIAN', 'Median Center'], ['BOUNDS', 'Bounds Center']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      for (const ob of app.selectedObjects()) {
        const me = objectData(doc, ob);
        const cu = !me && ob.type === 'CURVE' && ob.data ? doc.curves[ob.data] : undefined;
        if (!me && !cu) continue;
        // control points stand in for vertices on curves
        const positions = me ? me.positions : curvePoints(cu!);
        if (!positions.length) continue;
        const shiftGeometry = (c: Vector3) => (me ? transformMeshData(me, new Matrix4().makeTranslation(-c.x, -c.y, -c.z)) : translateCurve(cu!, [-c.x, -c.y, -c.z]));
        const ev = app.graph.get(ob.id)!;
        const median = () => {
          const c = new Vector3();
          for (let i = 0; i < positions.length; i += 3) c.add(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
          return c.multiplyScalar(1 / Math.max(1, positions.length / 3));
        };
        let center = new Vector3();
        if (p.type === 'ORIGIN_CURSOR') center = new Vector3(...doc.scene.cursor.location).applyMatrix4(ev.world.clone().invert());
        else if ((p.type === 'ORIGIN_CENTER_OF_MASS' || p.type === 'ORIGIN_CENTER_OF_VOLUME') && me && me.offsets.length > 1) {
          center.fromArray(p.type === 'ORIGIN_CENTER_OF_MASS' ? surfaceCenter(me) : volumeCenter(me));
        } else if (p.center === 'BOUNDS') {
          const b = bounds(positions);
          center.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
        } else center = median();
        if (p.type === 'GEOMETRY_ORIGIN') {
          shiftGeometry(p.center === 'BOUNDS' ? center : median());
          continue;
        }
        shiftGeometry(center);
        // move the object so the geometry stays in place
        const parentInv = ob.parent ? app.graph.get(ob.parent)!.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert() : new Matrix4();
        applyMatrixToObject(ob, parentInv.multiply(ev.world.clone().multiply(new Matrix4().makeTranslation(center.x, center.y, center.z))));
        // children keep their place
        const back = new Matrix4().makeTranslation(-center.x, -center.y, -center.z);
        for (const child of Object.values(doc.objects)) if (child.parent === ob.id && child.parent_type === 'OBJECT') child.matrix_parent_inverse = fromMatrix4(back.clone().multiply(toMatrix4(child.matrix_parent_inverse)));
      }
    },
  },
  {
    idname: 'object.parent_set',
    label: 'Make Parent',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'OBJECT',
        items: [
          ['OBJECT', 'Object'],
          ['ARMATURE', 'Armature Deform'],
          ['ARMATURE_NAME', 'With Empty Groups'],
          ['ARMATURE_AUTO', 'With Automatic Weights'],
          ['BONE', 'Bone'],
          ['CURVE', 'Curve Deform'],
          ['LATTICE', 'Lattice Deform'],
        ],
      },
      { id: 'keep_transform', label: 'Keep Transform', type: 'bool', default: false },
    ],
    // in Pose Mode the active armature parents the other selected objects (e.g. to its active bone)
    poll: (ctx) => (ctx.doc.mode === 'OBJECT' || (ctx.doc.mode === 'POSE' && app.activeObject?.type === 'ARMATURE')) && !!app.activeObject && app.selectedObjects().length > 1,
    exec: (ctx, p) => {
      const parent = app.activeObject!;
      const pw = app.graph.get(parent.id)!.world.clone();
      for (const ob of app.selectedObjects()) {
        if (ob.id === parent.id) continue;
        // prevent cycles
        let q: string | null = parent.id;
        let cyc = false;
        while (q) {
          if (q === ob.id) cyc = true;
          q = ctx.doc.objects[q]?.parent ?? null;
        }
        if (cyc) {
          app.report('WARNING', 'Loop in parents');
          continue;
        }
        const w = app.graph.get(ob.id)!.world.clone();
        ob.parent = parent.id;
        ob.parent_type = 'OBJECT';
        ob.parent_bone = '';
        if (p.type === 'BONE' && parent.type === 'ARMATURE') {
          const arm = parent.data ? ctx.doc.armatures[parent.data] : undefined;
          const pose = app.graph.get(parent.id)?.pose;
          const bname = arm?.active_bone;
          const b = bname ? pose?.bones.get(bname) : undefined;
          if (b && bname) {
            ob.parent_type = 'BONE';
            ob.parent_bone = bname;
            const bw = pw.clone().multiply(b.pose).multiply(new Matrix4().makeTranslation(0, b.length, 0));
            ob.matrix_parent_inverse = fromMatrix4(bw.invert());
            applyMatrixToObject(ob, w.clone().premultiply(new Matrix4()));
            continue;
          }
        }
        if (p.keep_transform) {
          ob.matrix_parent_inverse = [...IDENTITY];
          applyMatrixToObject(ob, pw.clone().invert().multiply(w));
        } else ob.matrix_parent_inverse = fromMatrix4(pw.clone().invert().multiply(w).multiply(localMatrix(ob).invert()));
        const deformer = (type: string) => {
          if (ob.modifiers.some((m) => m.type === type && m.object === parent.id)) return;
          const m = newModifier(type, uid('md'), ob.modifiers);
          m.object = parent.id;
          ob.modifiers.push(m);
        };
        const deformable = ob.type === 'MESH' || ob.type === 'CURVE' || ob.type === 'FONT';
        if (p.type === 'LATTICE' && parent.type === 'LATTICE' && deformable) deformer('LATTICE');
        if (p.type === 'CURVE' && parent.type === 'CURVE' && deformable) deformer('CURVE');
        if (p.type === 'ARMATURE' && parent.type === 'ARMATURE' && ob.type === 'MESH') deformer('ARMATURE');
        if ((p.type === 'ARMATURE_AUTO' || p.type === 'ARMATURE_NAME') && parent.type === 'ARMATURE' && ob.type === 'MESH') {
          const auto = modeHandlers.WEIGHT_PAINT?.armatureWeights;
          if (auto) auto(ob, parent, p.type === 'ARMATURE_AUTO');
          if (!ob.modifiers.some((m) => m.type === 'ARMATURE')) {
            const m = newModifier('ARMATURE', uid('md'), ob.modifiers);
            m.object = parent.id;
            ob.modifiers.push(m);
          }
        }
      }
    },
  },
  {
    idname: 'object.parent_no_inverse_set',
    label: 'Make Parent without Inverse',
    props: [{ id: 'keep_transform', label: 'Keep Transform', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject && app.selectedObjects().length > 1,
    exec: (_ctx, p) => {
      const parent = app.activeObject!;
      const pw = app.graph.get(parent.id)!.world.clone();
      for (const ob of app.selectedObjects()) {
        if (ob.id === parent.id) continue;
        const w = app.graph.get(ob.id)!.world.clone();
        ob.parent = parent.id;
        ob.parent_type = 'OBJECT';
        ob.matrix_parent_inverse = [...IDENTITY];
        // keep the world transform by expressing it in the parent's space, else snap to the parent
        if (p.keep_transform) applyMatrixToObject(ob, pw.clone().invert().multiply(w));
        else ob.location = [0, 0, 0];
      }
    },
  },
  {
    idname: 'object.parent_clear',
    label: 'Clear Parent',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Parent'], ['CLEAR_KEEP_TRANSFORM', 'Clear and Keep Transformation'], ['CLEAR_INVERSE', 'Clear Parent Inverse']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => !!o.parent),
    exec: (_ctx, p) => {
      for (const ob of app.selectedObjects()) {
        if (!ob.parent) continue;
        if (p.type === 'CLEAR_INVERSE') {
          ob.matrix_parent_inverse = [...IDENTITY];
          continue;
        }
        const w = app.graph.get(ob.id)!.world.clone();
        ob.parent = null;
        ob.parent_type = 'OBJECT';
        ob.matrix_parent_inverse = [...IDENTITY];
        if (p.type === 'CLEAR_KEEP_TRANSFORM') applyMatrixToObject(ob, w);
      }
    },
  },
  {
    idname: 'object.parent_inverse_apply',
    label: 'Apply Parent Inverse',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().some((o) => !!o.parent),
    exec: () => {
      for (const ob of app.selectedObjects()) {
        if (!ob.parent) continue;
        const local = toMatrix4(ob.matrix_parent_inverse).multiply(localMatrix(ob));
        ob.matrix_parent_inverse = [...IDENTITY];
        applyMatrixToObject(ob, local);
      }
    },
  },
  {
    idname: 'object.join',
    label: 'Join',
    description: 'Join selected objects into active object',
    poll: (ctx) => {
      if (ctx.doc.mode !== 'OBJECT') return false;
      const act = app.activeObject;
      if (act?.type !== 'MESH' && act?.type !== 'CURVE') return false;
      return app.selectedObjects().filter((o) => o.type === act.type).length > 1;
    },
    exec: (ctx) => {
      const doc = ctx.doc;
      const target = app.activeObject!;
      if (target.type === 'CURVE') return joinCurves(doc, target);
      const tme = doc.meshes[target.data!];
      const inv = app.graph.get(target.id)!.world.clone().invert();
      const positions: number[] = Array.from(tme.positions);
      const polys = toPolys(tme);
      const mats = [...tme.materials];
      const groups = tme.vertex_groups.map((g) => g.name);
      const weights: number[][] = tme.weights.map((w) => Array.from(w));
      // shape keys of the active mesh continue over the joined vertices (matching names, else the rest shape)
      const keys = tme.shape_keys.map((k) => ({ ...k, out: Array.from(k.data) }));
      const remove = new Set<string>();
      for (const ob of app.selectedObjects()) {
        if (ob.id === target.id || ob.type !== 'MESH') continue;
        const me = doc.meshes[ob.data!];
        const m = inv.clone().multiply(app.graph.get(ob.id)!.world);
        const base = positions.length / 3;
        const v = new Vector3();
        const transformed = (src: ArrayLike<number>) => {
          const out: number[] = [];
          for (let i = 0; i < src.length; i += 3) {
            v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
            out.push(v.x, v.y, v.z);
          }
          return out;
        };
        const own = transformed(me.positions);
        positions.push(...own);
        for (const k of keys) {
          const match = me.shape_keys.find((x, i) => i > 0 && x.name === k.name);
          k.out.push(...(match && match.data.length === me.positions.length ? transformed(match.data) : own));
        }
        const matMap = me.materials.map((mid) => {
          let i = mats.indexOf(mid);
          if (i < 0) {
            mats.push(mid);
            i = mats.length - 1;
          }
          return i;
        });
        for (const f of toPolys(me)) polys.push({ ...f, verts: f.verts.map((x) => x + base), material: matMap[f.material ?? 0] ?? 0 });
        // vertex groups merge by name
        for (let g = 0; g < me.vertex_groups.length; g++) {
          let gi = groups.indexOf(me.vertex_groups[g].name);
          if (gi < 0) {
            groups.push(me.vertex_groups[g].name);
            weights.push(new Array(base).fill(0));
            gi = groups.length - 1;
          }
        }
        for (let g = 0; g < groups.length; g++) {
          const src = me.vertex_groups.findIndex((x) => x.name === groups[g]);
          while (weights[g].length < base) weights[g].push(0);
          for (let i = 0; i < me.positions.length / 3; i++) weights[g].push(src >= 0 ? me.weights[src][i] : 0);
        }
        remove.add(ob.id);
      }
      const built = buildMesh(positions, polys);
      Object.assign(tme, built);
      tme.materials = mats;
      tme.vertex_groups = groups.map((name) => ({ name }));
      tme.weights = weights.map((w) => Float32Array.from(w));
      tme.shape_keys = keys.length === 0 || keys[0].out.length !== tme.positions.length ? [] : keys.map(({ out, ...k }) => ({ ...k, data: Float32Array.from(out) }));
      tme.select_vert = undefined;
      deleteObjects(doc, remove);
      target.select = true;
    },
  },
  {
    idname: 'object.make_single_user',
    label: 'Make Single User',
    description: 'Give objects their own copies of shared data, materials or actions',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'SELECTED_OBJECTS', items: [['SELECTED_OBJECTS', 'Selected Objects'], ['ALL', 'All']] },
      { id: 'obdata', label: 'Object Data', type: 'bool', default: true },
      { id: 'material', label: 'Materials', type: 'bool', default: false },
      { id: 'animation', label: 'Object Animation', type: 'bool', default: false },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && (app.selectedObjects().length > 0 || Object.keys(ctx.doc.objects).length > 0),
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const obs = p.type === 'ALL' ? Object.values(doc.objects) : app.selectedObjects();
      if (p.obdata) {
        const counts = new Map<string, number>();
        for (const o of Object.values(doc.objects)) if (o.data) counts.set(o.data, (counts.get(o.data) ?? 0) + 1);
        for (const ob of obs) {
          if (!ob.data || (counts.get(ob.data) ?? 0) < 2) continue;
          const t = DATA_TABLES[ob.type];
          const src = t && (doc[t] as Record<string, { id: string; name: string }>)[ob.data];
          if (!src) continue;
          const d = cloneShared(src);
          d.id = uid('da');
          d.name = uniqueName(doc, src.name, t as 'meshes');
          (doc[t] as Record<string, unknown>)[d.id] = d;
          counts.set(ob.data, counts.get(ob.data)! - 1);
          ob.data = d.id;
        }
      }
      if (p.material) {
        // a material is shared when more than one slot anywhere points at it
        const uses = new Map<string, number>();
        for (const owner of [...Object.values(doc.meshes), ...Object.values(doc.curves)]) for (const m of owner.materials) if (m) uses.set(m, (uses.get(m) ?? 0) + 1);
        const seen = new Set<object>();
        for (const ob of obs) {
          const owner = ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data]) : undefined;
          if (!owner || seen.has(owner)) continue;
          seen.add(owner);
          owner.materials = owner.materials.map((mid) => {
            if (!mid || (uses.get(mid) ?? 0) < 2 || !doc.materials[mid]) return mid;
            const src = doc.materials[mid];
            const copy = cloneShared(src);
            copy.id = uid('ma');
            copy.name = uniqueName(doc, src.name, 'materials');
            doc.materials[copy.id] = copy;
            uses.set(mid, uses.get(mid)! - 1);
            return copy.id;
          });
        }
      }
      if (p.animation) {
        const uses = new Map<string, number>();
        for (const o of Object.values(doc.objects)) if (o.animation_data?.action) uses.set(o.animation_data.action, (uses.get(o.animation_data.action) ?? 0) + 1);
        for (const ob of obs) {
          const aid = ob.animation_data?.action;
          if (!aid || (uses.get(aid) ?? 0) < 2 || !doc.actions[aid]) continue;
          const a = cloneShared(doc.actions[aid]);
          a.id = uid('ac');
          a.name = uniqueName(doc, doc.actions[aid].name, 'actions');
          doc.actions[a.id] = a;
          uses.set(aid, uses.get(aid)! - 1);
          ob.animation_data!.action = a.id;
        }
      }
    },
  },
  {
    idname: 'object.make_links_data',
    label: 'Link/Transfer Data',
    description: 'Share or copy data of the active object with the other selected objects',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'OBDATA',
        items: [
          ['OBDATA', 'Link Object Data'],
          ['MATERIAL', 'Link Materials'],
          ['ANIMATION', 'Link Animation Data'],
          ['GROUPS', 'Link Collections'],
          ['DUPLICOLLECTION', 'Link Instance Collection'],
          ['FONTS', 'Link Fonts to Text'],
          ['MODIFIERS', 'Copy Modifiers'],
        ],
      },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject && app.selectedObjects().length > 1,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const act = app.activeObject!;
      const actCols = Object.values(doc.collections).filter((c) => c.objects.includes(act.id));
      for (const ob of app.selectedObjects()) {
        if (ob.id === act.id) continue;
        switch (p.type) {
          case 'OBDATA':
            if (ob.type === act.type) ob.data = act.data;
            break;
          case 'MATERIAL': {
            const src = act.data ? (doc.meshes[act.data] ?? doc.curves[act.data]) : undefined;
            const dst = ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data]) : undefined;
            if (src && dst && src !== dst) dst.materials = [...src.materials];
            break;
          }
          case 'ANIMATION':
            if (act.animation_data) {
              ob.animation_data = { ...(ob.animation_data ?? { nla_tracks: [], drivers: [] }), action: act.animation_data.action } as ObjectData['animation_data'];
            }
            break;
          case 'GROUPS':
            for (const c of actCols) if (!c.objects.includes(ob.id)) c.objects.push(ob.id);
            break;
          case 'DUPLICOLLECTION':
            ob.instance_type = act.instance_type;
            ob.instance_collection = act.instance_collection;
            break;
          case 'FONTS':
            if (ob.type === 'FONT' && act.type === 'FONT' && ob.data && act.data && doc.curves[ob.data] && doc.curves[act.data]) doc.curves[ob.data].font_family = doc.curves[act.data].font_family;
            break;
          case 'MODIFIERS':
            ob.modifiers = act.modifiers.map((m) => ({ ...cloneShared(m), id: uid('md') }));
            break;
        }
      }
      purgeOrphans(doc);
    },
  },
  {
    idname: 'object.rotation_mode_set',
    label: 'Set Rotation Mode',
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'XYZ', items: [['XYZ', 'XYZ Euler'], ['QUATERNION', 'Quaternion'], ['AXIS_ANGLE', 'Axis Angle'], ['XZY', 'XZY'], ['YXZ', 'YXZ'], ['YZX', 'YZX'], ['ZXY', 'ZXY'], ['ZYX', 'ZYX']] }],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      for (const ob of app.selectedObjects().length ? app.selectedObjects() : [app.activeObject!]) {
        const q = new Quaternion();
        localMatrix(ob).decompose(new Vector3(), q, new Vector3());
        ob.rotation_mode = p.mode as ObjectData['rotation_mode'];
        setRotationFromQuaternion(ob, q);
      }
    },
  },
  {
    idname: 'object.transforms_to_deltas',
    label: 'Transforms to Deltas',
    description: 'Move transforms into the delta transforms, so animation can be layered on top',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'ALL', items: [['ALL', 'All Transforms'], ['LOC', 'Location'], ['ROT', 'Rotation'], ['SCALE', 'Scale']] },
      { id: 'reset_values', label: 'Reset Values', type: 'bool', default: true },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      const reset = p.reset_values !== false;
      for (const ob of app.selectedObjects()) {
        if (p.mode === 'ALL' || p.mode === 'LOC') {
          ob.delta_location = ob.delta_location.map((d, i) => d + ob.location[i]) as [number, number, number];
          if (reset) ob.location = [0, 0, 0];
        }
        if (p.mode === 'ALL' || p.mode === 'ROT') {
          ob.delta_rotation_euler = ob.delta_rotation_euler.map((d, i) => d + ob.rotation_euler[i]) as [number, number, number];
          if (reset) ob.rotation_euler = [0, 0, 0];
        }
        if (p.mode === 'ALL' || p.mode === 'SCALE') {
          ob.delta_scale = ob.delta_scale.map((d, i) => d * ob.scale[i]) as [number, number, number];
          if (reset) ob.scale = [1, 1, 1];
        }
      }
    },
  },
  {
    idname: 'object.visual_transform_apply',
    label: 'Apply Visual Transform',
    description: 'Apply the object’s visual transformation (constraints) to its transform channels',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: () => {
      for (const ob of app.selectedObjects()) {
        const w = app.graph.get(ob.id)!.world.clone();
        const parentInv = ob.parent ? app.graph.get(ob.parent)!.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert() : new Matrix4();
        applyMatrixToObject(ob, parentInv.multiply(w));
      }
    },
  },
  {
    idname: 'object.randomize_transform',
    label: 'Randomize Transform',
    props: [
      { id: 'random_seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
      { id: 'use_loc', label: 'Randomize Location', type: 'bool', default: true },
      { id: 'loc', label: 'Location', type: 'vec3', default: [0, 0, 0], subtype: 'distance' },
      { id: 'use_rot', label: 'Randomize Rotation', type: 'bool', default: true },
      { id: 'rot', label: 'Rotation', type: 'vec3', default: [0, 0, 0], subtype: 'angle' },
      { id: 'use_scale', label: 'Randomize Scale', type: 'bool', default: true },
      { id: 'scale_even', label: 'Scale Even', type: 'bool', default: false },
      { id: 'scale', label: 'Scale', type: 'vec3', default: [1, 1, 1] },
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      let s = (p.random_seed as number) * 9973 + 1;
      const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
      for (const ob of app.selectedObjects()) {
        const L = p.loc as number[],
          R = p.rot as number[],
          S = p.scale as number[];
        if (p.use_loc) ob.location = ob.location.map((v, i) => v + r() * L[i]) as [number, number, number];
        if (p.use_rot) ob.rotation_euler = ob.rotation_euler.map((v, i) => v + r() * R[i]) as [number, number, number];
        if (p.use_scale) {
          const e = r();
          ob.scale = ob.scale.map((v, i) => v * (1 + (p.scale_even ? e : r()) * (S[i] - 1))) as [number, number, number];
        }
      }
    },
  },
  {
    idname: 'object.convert',
    label: 'Convert To',
    description: 'Convert selected objects to another type, applying modifiers',
    props: [{ id: 'target', label: 'Target', type: 'enum', default: 'MESH', items: [['MESH', 'Mesh'], ['CURVE', 'Curve'], ['POINTCLOUD', 'Point Cloud']] }, { id: 'keep_original', label: 'Keep Original', type: 'bool', default: false }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      if (p.target === 'POINTCLOUD') {
        let n = 0;
        for (const ob of app.selectedObjects()) {
          const m = app.graph.get(ob.id)?.mesh;
          if (!m || (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'FONT')) continue;
          const target = p.keep_original ? duplicateObject(doc, ob, true) : ob;
          // point clouds are meshes made of vertices only
          const me = newMeshData(uniqueName(doc, ob.name, 'meshes'), { positions: new Float32Array(m.positions), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
          me.materials = [...(ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data])?.materials ?? [] : [])];
          doc.meshes[me.id] = me;
          target.type = 'MESH';
          target.data = me.id;
          target.modifiers = [];
          n++;
        }
        purgeOrphans(doc);
        return n ? undefined : 'CANCELLED';
      }
      if (p.target === 'CURVE') {
        let n = 0;
        for (const ob of app.selectedObjects()) {
          if (ob.type === 'FONT' && ob.data && doc.curves[ob.data]) {
            // text becomes a plain 2D curve made of its glyph outlines
            const src = doc.curves[ob.data];
            const target = p.keep_original ? duplicateObject(doc, ob, true) : ob;
            const cu = newCurve(uniqueName(doc, ob.name, 'curves'));
            cu.splines = textToCurves(src).map((sp) => cloneShared(sp));
            cu.dimensions = '2D';
            cu.fill_mode = src.fill_mode === 'NONE' ? 'NONE' : 'BOTH';
            cu.extrude = src.extrude;
            cu.offset = src.offset;
            cu.bevel_depth = src.bevel_depth;
            cu.bevel_resolution = src.bevel_resolution;
            cu.resolution_u = src.resolution_u;
            cu.materials = [...src.materials];
            doc.curves[cu.id] = cu;
            target.type = 'CURVE';
            target.data = cu.id;
            n++;
            continue;
          }
          if (ob.type !== 'MESH') continue;
          const m = app.graph.get(ob.id)?.mesh;
          if (!m) continue;
          const target = p.keep_original ? duplicateObject(doc, ob, true) : ob;
          const cu = newCurve(uniqueName(doc, ob.name, 'curves'));
          cu.splines = edgeChains(m.offsets, m.indices, m.positions.length / 3, m.looseEdges).map((ch) => ({
            type: 'POLY',
            bezier_points: [],
            points: ch.verts.map((v) => ({ co: [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2], 1], radius: 1, tilt: 0 })),
            use_cyclic_u: ch.cyclic,
            resolution_u: 12,
            order_u: 4,
            use_smooth: false,
            material_index: 0,
          }));
          cu.materials = [...(ob.data ? doc.meshes[ob.data]?.materials ?? [] : [])];
          doc.curves[cu.id] = cu;
          target.type = 'CURVE';
          target.data = cu.id;
          target.modifiers = [];
          n++;
        }
        purgeOrphans(doc);
        if (!n) {
          app.report('WARNING', 'Only meshes and texts can be converted to curves');
          return 'CANCELLED';
        }
        return;
      }
      let targets = app.selectedObjects();
      for (const hk of convertHooks) targets = hk(doc, targets, !!p.keep_original);
      for (const ob of targets) {
        const ev = app.graph.get(ob.id);
        if (!ev?.mesh || (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'FONT' && ob.type !== 'META')) continue;
        const m = ev.mesh;
        let target = ob;
        if (p.keep_original) target = duplicateObject(doc, ob, true);
        const me = newMeshData(uniqueName(doc, ob.name, 'meshes'), {
          positions: new Float32Array(m.positions),
          offsets: new Uint32Array(m.offsets),
          indices: new Uint32Array(m.indices),
          uvs: new Float32Array(m.uvs),
          normals: new Float32Array(m.normals),
          smooth: m.smooth ? new Uint8Array(m.smooth) : undefined,
          material_index: m.material_index ? new Uint16Array(m.material_index) : undefined,
        });
        me.materials = [...(ob.data ? (doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data])?.materials ?? [] : [])];
        if (m.vertex_groups && m.weights) {
          me.vertex_groups = m.vertex_groups.map((g) => ({ name: g.name }));
          me.weights = m.weights.map((w) => new Float32Array(w));
        }
        doc.meshes[me.id] = me;
        target.type = 'MESH';
        target.data = me.id;
        target.modifiers = [];
      }
      purgeOrphans(doc);
    },
  },
  {
    idname: 'object.move_to_collection',
    label: 'Move to Collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }, { id: 'is_new', label: 'New', type: 'bool', default: false, hidden: true }, { id: 'new_name', label: 'Name', type: 'string', default: 'Collection', hidden: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    invoke: (ctx, p) => {
      if (p.collection) return operatorsExec('object.move_to_collection', ctx, p);
      const doc = ctx.doc;
      const items = (cid: string): import('../ui/menu').MenuItem[] => {
        const c = doc.collections[cid];
        return [
          { label: c.name, icon: cid === doc.scene.collection ? 'scene' : 'collection', action: () => app.run('object.move_to_collection', { collection: cid }, { invoke: false }) },
          ...c.children.map((ch) => (doc.collections[ch].children.length ? { label: doc.collections[ch].name, icon: 'collection', submenu: () => items(ch) } : { label: doc.collections[ch].name, icon: 'collection', action: () => app.run('object.move_to_collection', { collection: ch }, { invoke: false }) })),
          { separator: true },
          { label: '+ New Collection', action: () => app.run('object.move_to_collection', { collection: cid, is_new: true }, { invoke: false }) },
        ];
      };
      openMenu(items(doc.scene.collection), { x: app.pointer.x, y: app.pointer.y }, { title: 'Move to Collection' });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const doc = ctx.doc;
      let target = p.collection as string;
      if (p.is_new) {
        const c = newCollection(uniqueName(doc, p.new_name as string, 'collections'));
        doc.collections[c.id] = c;
        doc.collections[target].children.push(c.id);
        target = c.id;
      }
      if (!doc.collections[target]) return 'CANCELLED';
      for (const ob of app.selectedObjects()) {
        for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((x) => x !== ob.id);
        doc.collections[target].objects.push(ob.id);
      }
    },
  },
  {
    idname: 'object.link_to_collection',
    label: 'Link to Collection',
    props: [{ id: 'collection', label: 'Collection', type: 'string', default: '', hidden: true }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    invoke: (ctx, p) => {
      if (p.collection) return operatorsExec('object.link_to_collection', ctx, p);
      openMenu(
        Object.values(ctx.doc.collections).map((c) => ({ label: c.name, icon: 'collection', action: () => app.run('object.link_to_collection', { collection: c.id }, { invoke: false }) })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: 'Link to Collection' },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const c = ctx.doc.collections[p.collection as string];
      if (!c) return 'CANCELLED';
      for (const ob of app.selectedObjects()) if (!c.objects.includes(ob.id)) c.objects.push(ob.id);
    },
  },
  {
    idname: 'collection.create',
    label: 'Create New Collection',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Collection' }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const c = newCollection(uniqueName(ctx.doc, p.name as string, 'collections'));
      ctx.doc.collections[c.id] = c;
      ctx.doc.collections[ctx.doc.scene.collection].children.push(c.id);
      for (const ob of app.selectedObjects()) c.objects.push(ob.id);
    },
  },
  {
    idname: 'collection.objects_remove_all',
    label: 'Remove from All Collections',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx) => {
      // objects must stay linked somewhere: keep them in the scene collection
      for (const ob of app.selectedObjects()) {
        for (const c of Object.values(ctx.doc.collections)) c.objects = c.objects.filter((x) => x !== ob.id);
        ctx.doc.collections[ctx.doc.scene.collection].objects.push(ob.id);
      }
    },
  },
  {
    idname: 'object.rename',
    label: 'Rename Active Object',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => !!app.activeObject,
    invoke: () => {
      const ob = app.activeObject!;
      promptText('Rename Active Object', ob.name, (name) => {
        if (name && name !== ob.name) app.run('object.rename', { name }, { invoke: false });
      });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      if (p.name) ob.name = uniqueName(app.doc, p.name as string);
    },
  },
  {
    idname: 'object.track_set',
    label: 'Make Track',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'DAMPTRACK', items: [['DAMPTRACK', 'Damped Track'], ['TRACKTO', 'Track To'], ['LOCKTRACK', 'Lock Track']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject && app.selectedObjects().length > 1,
    exec: (_ctx, p) => {
      const target = app.activeObject!;
      const type = { DAMPTRACK: 'DAMPED_TRACK', TRACKTO: 'TRACK_TO', LOCKTRACK: 'LOCKED_TRACK' }[p.type as string]!;
      for (const ob of app.selectedObjects()) {
        if (ob.id === target.id) continue;
        const c = newConstraint(type, uid('cn'));
        c.target = target.id;
        ob.constraints.push(c);
      }
    },
  },
  {
    idname: 'object.track_clear',
    label: 'Clear Track',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CLEAR', items: [['CLEAR', 'Clear Track'], ['CLEAR_KEEP_TRANSFORM', 'Clear and Keep Transformation (Clear Track)']] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (_ctx, p) => {
      for (const ob of app.selectedObjects()) {
        const w = app.graph.get(ob.id)?.world.clone();
        const before = ob.constraints.length;
        ob.constraints = ob.constraints.filter((c) => !['TRACK_TO', 'DAMPED_TRACK', 'LOCKED_TRACK'].includes(c.type));
        if (p.type === 'CLEAR_KEEP_TRANSFORM' && w && ob.constraints.length !== before) {
          const parentInv = ob.parent ? app.graph.get(ob.parent)!.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert() : new Matrix4();
          applyMatrixToObject(ob, parentInv.multiply(w));
        }
      }
    },
  },
  {
    idname: 'object.constraints_clear',
    label: 'Clear Object Constraints',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: () => {
      for (const ob of app.selectedObjects()) ob.constraints = [];
    },
  },
  {
    idname: 'object.constraints_copy',
    label: 'Copy Constraints to Selected Objects',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && !!app.activeObject && app.selectedObjects().length > 1,
    exec: () => {
      const act = app.activeObject!;
      for (const ob of app.selectedObjects()) if (ob.id !== act.id) ob.constraints = act.constraints.map((c) => ({ ...cloneShared(c), id: uid('cn') }));
    },
  },
  {
    idname: 'object.align',
    label: 'Align Objects',
    props: [{ id: 'align_mode', label: 'Align Mode', type: 'enum', default: 'OPT_2', items: [['OPT_1', 'Negative Sides'], ['OPT_2', 'Centers'], ['OPT_3', 'Positive Sides']] }, { id: 'relative_to', label: 'Relative To', type: 'enum', default: 'OPT_4', items: [['OPT_1', 'Scene Origin'], ['OPT_2', '3D Cursor'], ['OPT_3', 'Selection'], ['OPT_4', 'Active']] }, { id: 'align_axis', label: 'Align', type: 'bools', default: [false, false, false] }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const axes = p.align_axis as boolean[];
      let ref = new Vector3();
      if (p.relative_to === 'OPT_2') ref.fromArray(ctx.doc.scene.cursor.location);
      else if (p.relative_to === 'OPT_3') ref = centerOfSelection();
      else if (p.relative_to === 'OPT_4' && app.activeObject) ref.setFromMatrixPosition(app.graph.get(app.activeObject.id)!.world);
      for (const ob of app.selectedObjects()) for (let i = 0; i < 3; i++) if (axes[i]) ob.location[i] = ref.getComponent(i);
    },
  },
]);

function operatorsExec(idname: string, ctx: OpContext, p: Record<string, unknown>) {
  void ctx;
  return app.run(idname, p, { invoke: false });
}

function setShading(doc: DocumentData, smooth: boolean, _angle: number | undefined) {
  for (const ob of app.selectedObjects()) {
    const me = objectData(doc, ob);
    if (!me) continue;
    me.smooth = new Uint8Array(me.offsets.length - 1).fill(smooth ? 1 : 0);
    if (!smooth) ob.modifiers = ob.modifiers.filter((m) => m.type !== 'SMOOTH_BY_ANGLE');
  }
}

/** Join the selected curves into the active one (splines move into its space, materials merge). */
function joinCurves(doc: DocumentData, target: ObjectData) {
  const tcu = doc.curves[target.data!];
  const inv = app.graph.get(target.id)!.world.clone().invert();
  const mats = [...tcu.materials];
  const splines = tcu.splines.map((sp) => cloneShared(sp));
  const remove = new Set<string>();
  for (const ob of app.selectedObjects()) {
    if (ob.id === target.id || ob.type !== 'CURVE' || !ob.data || ob.data === target.data) continue;
    const cu = doc.curves[ob.data];
    const add = cu.splines.map((sp) => cloneShared(sp));
    transformCurve(add, inv.clone().multiply(app.graph.get(ob.id)!.world));
    const matMap = cu.materials.map((mid) => {
      let i = mats.indexOf(mid);
      if (i < 0) {
        mats.push(mid);
        i = mats.length - 1;
      }
      return i;
    });
    for (const sp of add) splines.push({ ...sp, material_index: matMap[sp.material_index ?? 0] ?? 0 });
    remove.add(ob.id);
  }
  if (!remove.size) return 'CANCELLED' as const;
  tcu.splines = splines;
  tcu.materials = mats;
  deleteObjects(doc, remove);
  target.select = true;
}

function transformCurve(splines: Spline[], m: Matrix4) {
  const v = new Vector3();
  const tr = (p: number[]) => {
    v.set(p[0], p[1], p[2]).applyMatrix4(m);
    p[0] = v.x;
    p[1] = v.y;
    p[2] = v.z;
  };
  for (const s of splines) {
    for (const b of s.bezier_points) {
      tr(b.co);
      tr(b.handle_left);
      tr(b.handle_right);
    }
    for (const pt of s.points) tr(pt.co);
  }
}

// ---------------------------------------------------------------------------
// Curves

function curveAddOps() {
  const mkBezier = (cyclic: boolean, radius: number): Spline => {
    if (cyclic) {
      const k = 0.5523 * radius;
      const pts = [
        [radius, 0],
        [0, radius],
        [-radius, 0],
        [0, -radius],
      ];
      const tang = [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ];
      return {
        type: 'BEZIER',
        bezier_points: pts.map(([x, y], i) => ({
          co: [x, y, 0],
          handle_left: [x - tang[i][0] * k, y - tang[i][1] * k, 0],
          handle_right: [x + tang[i][0] * k, y + tang[i][1] * k, 0],
          handle_left_type: 'ALIGNED' as const,
          handle_right_type: 'ALIGNED' as const,
          radius: 1,
          tilt: 0,
        })),
        points: [],
        use_cyclic_u: true,
        resolution_u: 12,
        order_u: 4,
        use_smooth: true,
        material_index: 0,
      };
    }
    return {
      type: 'BEZIER',
      bezier_points: [
        { co: [-1 * radius, 0, 0], handle_left: [-1.5 * radius, -0.5 * radius, 0], handle_right: [-0.5 * radius, 0.5 * radius, 0], handle_left_type: 'ALIGNED', handle_right_type: 'ALIGNED', radius: 1, tilt: 0 },
        { co: [1 * radius, 0, 0], handle_left: [0, 0, 0], handle_right: [2 * radius, 0, 0], handle_left_type: 'ALIGNED', handle_right_type: 'ALIGNED', radius: 1, tilt: 0 },
      ],
      points: [],
      use_cyclic_u: false,
      resolution_u: 12,
      order_u: 4,
      use_smooth: true,
      material_index: 0,
    };
  };
  const nurbs = (cyclic: boolean, path: boolean, radius: number): Spline => {
    const pts = cyclic
      ? Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          const w = i % 2 ? Math.SQRT1_2 : 1;
          const r = i % 2 ? radius * Math.SQRT2 : radius;
          return { co: [Math.cos(a) * r, Math.sin(a) * r, 0, w] as [number, number, number, number], radius: 1, tilt: 0 };
        })
      : path
        ? Array.from({ length: 5 }, (_, i) => ({ co: [(i - 2) * radius, 0, 0, 1] as [number, number, number, number], radius: 1, tilt: 0 }))
        : [
            [-1.5, -0.5],
            [-0.5, 0.5],
            [0.5, 0.5],
            [1.5, -0.5],
          ].map(([x, y]) => ({ co: [x * radius, y * radius, 0, 1] as [number, number, number, number], radius: 1, tilt: 0 }));
    return { type: 'NURBS', bezier_points: [], points: pts, use_cyclic_u: cyclic, resolution_u: 12, order_u: path ? 5 : 4, use_endpoint_u: path, use_smooth: true, material_index: 0 };
  };
  const make = (idname: string, label: string, name: string, spline: (r: number) => Spline, dims: '2D' | '3D' = '3D') => ({
    idname,
    label,
    props: [{ id: 'radius', label: 'Radius', type: 'float' as const, default: 1, min: 0, subtype: 'distance' as const }, ...transformProps],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' || (ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'CURVE'),
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      if (ctx.doc.mode === 'EDIT') {
        // in Curve Edit Mode the new spline is added to the edited curve
        const add = curveEditHooks.addSpline;
        if (!add) return 'CANCELLED';
        if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
        return add(spline(p.radius as number), p.location as number[], (p.rotation as number[] | null) ?? undefined) ? 'FINISHED' : 'CANCELLED';
      }
      const cu = newCurve(uniqueName(ctx.doc, name, 'curves'));
      cu.dimensions = dims;
      cu.splines = [spline(p.radius as number)];
      ctx.doc.curves[cu.id] = cu;
      const ob = newObject(name, 'CURVE', cu.id);
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  });
  return [
    make('curve.primitive_bezier_curve_add', 'Add Bézier', 'BezierCurve', (r) => mkBezier(false, r)),
    make('curve.primitive_bezier_circle_add', 'Add Bézier Circle', 'BezierCircle', (r) => mkBezier(true, r)),
    make('curve.primitive_nurbs_curve_add', 'Add NURBS Curve', 'NurbsCurve', (r) => nurbs(false, false, r)),
    make('curve.primitive_nurbs_circle_add', 'Add NURBS Circle', 'NurbsCircle', (r) => nurbs(true, false, r)),
    make('curve.primitive_nurbs_path_add', 'Add Path', 'NurbsPath', (r) => nurbs(false, true, r)),
    {
      idname: 'object.text_add',
      label: 'Add Text',
      props: [{ id: 'radius', label: 'Radius', type: 'float' as const, default: 1, min: 0, subtype: 'distance' as const }, ...transformProps],
      poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT',
      exec: (ctx: OpContext, p: Record<string, unknown>) => {
        const cu = newCurve(uniqueName(ctx.doc, 'Text', 'curves'));
        cu.dimensions = '2D';
        cu.body = 'Text';
        cu.size = p.radius as number;
        cu.fill_mode = 'BOTH';
        cu.align_x = 'LEFT';
        cu.align_y = 'TOP_BASELINE' as never;
        cu.space_line = 1;
        cu.space_character = 1;
        ctx.doc.curves[cu.id] = cu;
        const ob = newObject('Text', 'FONT', cu.id);
        if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
        if (p.rotation === null) delete p.rotation;
        addObjectToScene(ctx.doc, ob, p);
      },
    },
  ];
}

export { newMaterial, objectData, transformMeshData, duplicateObject };
export type { ObjectType };
