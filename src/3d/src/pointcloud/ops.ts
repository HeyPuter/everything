// Point cloud operators: Add ▸ Point Cloud, conversions to and from point clouds, and attribute
// add / remove of the Object Data tab.
import { app, onAppReady, operators, registerOperators, type PropDef } from '../app/app';
import { newObject, uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import { addObjectToScene, purgeOrphans } from '../ops/object';
import { cloneShared } from '../data/cow';
import { allocData, dataComps, type DataType } from '../geonodes/types';
import { newMeshData } from '../data/defaults';
import { evalMeshToGeometry } from '../geonodes/convert';
import { isInternal } from '../geonodes/geometry';
import { newPointCloud, pointCloudOf, pointCount, randomPoints, removeAttr, setAttr, uniquePointCloudName } from './data';
import type { PointCloudAttribute, PointCloudData } from './types';

const transformProps: PropDef[] = [
  { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
  { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
  { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
  { id: 'scale', label: 'Scale', type: 'vec3', default: null, subtype: 'none' },
];

/** Create a Point Cloud object (with data) at the 3D cursor. */
export function addPointCloudObject(doc: DocumentData, name: string, pc: PointCloudData, props: Record<string, unknown> = {}): ObjectData {
  doc.pointclouds ??= {};
  pc.name = uniquePointCloudName(doc, pc.name || name);
  doc.pointclouds[pc.id] = pc;
  const ob = newObject(name, 'POINTCLOUD', pc.id);
  const p = { ...props };
  if (p.location === null || p.location === undefined) p.location = [...doc.scene.cursor.location];
  if (p.rotation === null) delete p.rotation;
  addObjectToScene(doc, ob, p);
  if (Array.isArray(props.scale)) ob.scale = [...(props.scale as [number, number, number])];
  return ob;
}

/** Point cloud data holding a copy of a geometry's points (mesh vertices, curve points, points). */
export function pointCloudFromEvaluated(ob: ObjectData): PointCloudData | null {
  const m = app.graph.get(ob.id)?.mesh;
  if (!m || !m.positions.length) return null;
  const g = evalMeshToGeometry(m, ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : null);
  const pc = newPointCloud(ob.name);
  const comp = g.points ?? null;
  pc.positions = (comp?.positions ?? g.mesh?.positions ?? g.curves?.positions ?? m.positions).slice();
  const n = pc.positions.length / 3;
  const attrs: PointCloudAttribute[] = [];
  for (const [name, a] of (comp ?? g.mesh ?? g.curves)?.attrs ?? []) {
    if (isInternal(name) || a.domain !== 'POINT' || a.data.length !== n * dataComps(a.type)) continue;
    attrs.push({ name, data_type: a.type, data: a.data.slice() });
  }
  pc.attributes = attrs;
  if (!attrs.some((a) => a.name === 'radius')) setAttr(pc, 'radius', 'FLOAT', m.pointRadius && m.pointRadius.length === n ? m.pointRadius.slice() : new Float32Array(n).fill(0.01));
  return pc;
}

const objectMode = () => app.doc.mode === 'OBJECT';

const TYPES: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['FLOAT_VECTOR', 'Vector'],
  ['FLOAT_COLOR', 'Color'],
  ['BOOLEAN', 'Boolean'],
  ['FLOAT2', '2D Vector'],
  ['INT8', '8-Bit Integer'],
  ['QUATERNION', 'Quaternion'],
];

registerOperators([
  {
    idname: 'object.pointcloud_random_add',
    label: 'Add Point Cloud',
    description: 'Add a point cloud object filled with randomly placed points',
    props: transformProps,
    poll: objectMode,
    exec: (ctx, p) => {
      const pc = newPointCloud('PointCloud');
      const { positions, radius } = randomPoints(400, 1, 0.05, 1);
      pc.positions = positions;
      setAttr(pc, 'radius', 'FLOAT', radius);
      addPointCloudObject(ctx.doc, 'PointCloud', pc, p);
    },
  },
  {
    idname: 'geometry.attribute_add_pointcloud',
    label: 'Add Attribute',
    description: 'Add an attribute to the points',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: 'Attribute' },
      { id: 'data_type', label: 'Data Type', type: 'enum', default: 'FLOAT', items: TYPES },
    ],
    poll: () => !!pointCloudOf(app.doc, app.activeObject),
    exec: (ctx, p) => {
      const pc = pointCloudOf(ctx.doc, app.activeObject)!;
      let name = String(p.name || 'Attribute');
      const names = new Set(pc.attributes.map((a) => a.name));
      if (names.has(name)) for (let i = 1; ; i++) if (!names.has(`${name}.${String(i).padStart(3, '0')}`)) {
        name = `${name}.${String(i).padStart(3, '0')}`;
        break;
      }
      const t = p.data_type as DataType;
      setAttr(pc, name, t, allocData(t, pointCount(pc)));
      pc.active_attribute = pc.attributes.findIndex((a) => a.name === name);
    },
  },
  {
    idname: 'geometry.attribute_remove_pointcloud',
    label: 'Remove Attribute',
    description: 'Remove the active attribute of the points',
    poll: () => {
      const pc = pointCloudOf(app.doc, app.activeObject);
      const a = pc?.attributes[pc.active_attribute ?? -1];
      return !!a && a.name !== 'position';
    },
    exec: (ctx) => {
      const pc = pointCloudOf(ctx.doc, app.activeObject)!;
      const a = pc.attributes[pc.active_attribute ?? -1];
      if (!a) return 'CANCELLED';
      removeAttr(pc, a.name);
    },
  },
]);

// ---------------------------------------------------------------------------
// Convert To ▸ Point Cloud makes real point cloud objects; point clouds convert to meshes

onAppReady(() => {
  const op = operators.get('object.convert');
  if (!op?.exec) return;
  const orig = op.exec;
  op.exec = (ctx, p) => {
    const doc = ctx.doc;
    const sel = app.selectedObjects();
    if (p.target === 'POINTCLOUD') {
      let n = 0;
      for (const ob of sel) {
        if (ob.type === 'POINTCLOUD' || !['MESH', 'CURVE', 'FONT', 'CURVES'].includes(ob.type)) continue;
        const pc = pointCloudFromEvaluated(ob);
        if (!pc) continue;
        const data = ob.data ? ((doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.hair_curves?.[ob.data]) as { materials?: (string | null)[] } | undefined) : undefined;
        pc.materials = [...(data?.materials ?? [])];
        pc.name = uniquePointCloudName(doc, ob.name);
        doc.pointclouds ??= {};
        doc.pointclouds[pc.id] = pc;
        const target = p.keep_original ? cloneObjectShallow(doc, ob) : ob;
        target.type = 'POINTCLOUD';
        target.data = pc.id;
        target.modifiers = [];
        n++;
      }
      purgeOrphans(doc);
      return n ? undefined : 'CANCELLED';
    }
    if (p.target === 'MESH' && sel.some((o) => o.type === 'POINTCLOUD')) {
      for (const ob of sel) {
        if (ob.type !== 'POINTCLOUD') continue;
        const m = app.graph.get(ob.id)?.mesh;
        const pc = pointCloudOf(doc, ob);
        if (!m || !pc) continue;
        const me = newMeshData(ob.name, { positions: new Float32Array(m.positions), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
        me.materials = [...pc.materials];
        doc.meshes[me.id] = me;
        const target = p.keep_original ? cloneObjectShallow(doc, ob) : ob;
        target.type = 'MESH';
        target.data = me.id;
        target.modifiers = [];
      }
      purgeOrphans(doc);
      // other selected objects convert as usual
      if (sel.every((o) => o.type === 'POINTCLOUD' || o.type === 'MESH')) return;
    }
    return orig(ctx, p);
  };
});

/** A copy of an object sharing its data (the copy keeps the original type when converting). */
function cloneObjectShallow(doc: DocumentData, ob: ObjectData): ObjectData {
  const copy = cloneShared(ob);
  copy.id = uid('ob');
  copy.select = false;
  doc.objects[copy.id] = copy;
  doc.object_order.push(copy.id);
  for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(copy.id);
  // the copy stays what it was; the original becomes the converted object
  return ob;
}
