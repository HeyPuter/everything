// Drag and drop into the 3D viewport: object data becomes a new object that uses it, an existing
// object is placed under the mouse, a world becomes the scene world.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, operators, type OpContext } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { surfaceHit } from '../ops/view3d';
import { newObject } from '../data/defaults';
import { addObjectToScene } from '../ops/object';
import type { DocumentData, ObjectType } from '../data/types';

/** Object data tables that can be dropped, with the object type they make. */
export const DATA_TYPES: [string, string, ObjectType][] = [
  ['MESH', 'meshes', 'MESH'],
  ['CURVE', 'curves', 'CURVE'],
  ['FONT', 'curves', 'FONT'],
  ['ARMATURE', 'armatures', 'ARMATURE'],
  ['LATTICE', 'lattices', 'LATTICE'],
  ['CAMERA', 'cameras', 'CAMERA'],
  ['LIGHT', 'lights', 'LIGHT'],
  ['META', 'metaballs', 'META' as ObjectType],
  ['GREASEPENCIL', 'grease_pencils', 'GREASEPENCIL' as ObjectType],
  ['CURVES', 'hair_curves', 'CURVES' as ObjectType],
];

/** The drop type for a document table (curves with text become text objects). */
export function dropTypeFor(table: string, id: string): string | null {
  if (table === 'curves') return (app.doc.curves[id] as { body?: string } | undefined)?.body !== undefined ? 'FONT' : 'CURVE';
  return DATA_TYPES.find(([, t]) => t === table)?.[0] ?? null;
}

const tableOf = (doc: DocumentData, name: string) => (doc as unknown as Record<string, Record<string, { name: string }> | undefined>)[name] ?? {};

function byName(doc: DocumentData, table: string, name: string): string | null {
  const t = tableOf(doc, table);
  return Object.keys(t).find((id) => t[id].name === name) ?? (t[name] ? name : null);
}

/** Point under a viewport pixel: the surface there, else the ground plane, else the 3D cursor's depth. */
export function dropPoint(v: View3D | null, x: number, y: number, exclude?: string): Vector3 {
  const cursor = new Vector3(...app.doc.scene.cursor.location);
  if (!v) return cursor;
  const s = exclude && v.pick(x, y, 1)?.id === exclude ? null : surfaceHit(v, x, y);
  if (s) return s;
  const { origin, dir } = v.ray(x, y);
  if (Math.abs(dir.z) > 1e-4) {
    const t = -origin.z / dir.z;
    if (t > 0 && t < 1e4) return origin.clone().addScaledVector(dir, t).setZ(0);
  }
  return v.unproject(x, y, cursor);
}

const hasDrop = (p: Record<string, unknown>) => (p.drop_x as number) !== 0 || (p.drop_y as number) !== 0;
const dropProps = [
  { id: 'drop_x', label: 'Drop X', type: 'int' as const, default: 0, hidden: true },
  { id: 'drop_y', label: 'Drop Y', type: 'int' as const, default: 0, hidden: true },
];

registerOperators([
  {
    idname: 'object.data_instance_add',
    label: 'Add Object Data Instance',
    description: 'Add a new object that uses existing object data (mesh, curve, light…)',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '', hidden: true },
      { id: 'type', label: 'Type', type: 'enum', default: 'MESH', items: DATA_TYPES.map(([k]) => [k, k[0] + k.slice(1).toLowerCase()] as [string, string]) },
      { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
      { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
      ...dropProps,
    ],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT',
    exec: (ctx, p) => {
      const info = DATA_TYPES.find(([k]) => k === p.type);
      if (!info) return 'CANCELLED';
      const id = byName(ctx.doc, info[1], p.name as string);
      if (!id) {
        app.report('ERROR', `No ${info[0].toLowerCase()} data named “${p.name}”`);
        return 'CANCELLED';
      }
      const data = tableOf(ctx.doc, info[1])[id];
      if (p.location === null) {
        const v = activeView3D();
        const at = hasDrop(p) && v ? dropPoint(v, p.drop_x as number, p.drop_y as number) : new Vector3(...ctx.doc.scene.cursor.location);
        p.location = [at.x, at.y, at.z];
      }
      if (p.rotation === null) delete p.rotation;
      const ob = newObject(data.name, info[2], id);
      addObjectToScene(ctx.doc, ob, p);
      if (!p.rotation) p.rotation = [...ob.rotation_euler];
      return 'FINISHED';
    },
  },
  {
    idname: 'object.transform_to_mouse',
    label: 'Place Object Under Mouse',
    description: 'Move an object onto the surface (or ground) under the mouse',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '', hidden: true },
      { id: 'matrix', label: 'Matrix', type: 'string', default: '', hidden: true },
      ...dropProps,
    ],
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    invoke: (ctx, p) => {
      // invoked from a key or menu: place at the mouse position
      const v = activeView3D();
      if (v && ctx.event && !hasDrop(p)) {
        const r = v.el.getBoundingClientRect();
        p.drop_x = Math.round(ctx.event.x - r.left);
        p.drop_y = Math.round(ctx.event.y - r.top);
      }
      return operatorsExec('object.transform_to_mouse', ctx, p);
    },
    exec: (ctx, p) => {
      const ob = p.name ? Object.values(ctx.doc.objects).find((o) => o.name === p.name) : app.activeObject;
      if (!ob) return 'CANCELLED';
      let target: Vector3;
      if (p.matrix) {
        const m = (p.matrix as string).split(/[ ,]+/).map(Number);
        if (m.length !== 16 || m.some((x) => !Number.isFinite(x))) return 'CANCELLED';
        target = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(m));
      } else {
        // the object itself doesn't catch the ray
        target = dropPoint(activeView3D(), p.drop_x as number, p.drop_y as number, ob.id);
      }
      // keep the parent relation: move in the parent's space
      if (ob.parent) {
        const pw = app.graph.get(ob.parent)?.world ?? new Matrix4();
        const pinv = new Matrix4().fromArray(ob.matrix_parent_inverse ?? new Matrix4().toArray());
        target.applyMatrix4(pw.clone().multiply(pinv).invert());
      }
      ob.location = [target.x, target.y, target.z];
      for (const o of Object.values(ctx.doc.objects)) o.select = o === ob;
      ctx.doc.scene.active_object = ob.id;
      app.changed('doc', 'select');
      return 'FINISHED';
    },
  },
  {
    idname: 'view3d.drop_world',
    label: 'Drop World',
    description: 'Use a world as the scene world',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '', hidden: true }],
    exec: (ctx, p) => {
      const id = byName(ctx.doc, 'worlds', p.name as string);
      if (!id) return 'CANCELLED';
      ctx.doc.scene.world = id;
      app.changed('doc');
      return 'FINISHED';
    },
  },
]);

function operatorsExec(id: string, ctx: OpContext, p: Record<string, unknown>) {
  return operators.get(id)?.exec?.(ctx, p) ?? 'CANCELLED';
}
