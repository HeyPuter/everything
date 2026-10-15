// The `bmesh` script module: bmesh.new(), from_edit_mesh / update_edit_mesh, bmesh.types,
// bmesh.ops, bmesh.utils and bmesh.geometry. JavaScript scripts get it as the global
// `bmesh`; Python's `import bmesh` forwards to the same object (py/bmesh.py).
import { app } from '../app/app';
import type { MeshData } from '../data/types';
import { pyError, isIdWrapper, touched, ensureEvaluated, kwMethod } from './rna';
import { registerScriptModule } from './jsmodules';
import { editMeshObjects, active as editActive, selectModes } from '../modes/editmesh/context';
import { exclusionsOf } from '../modes/editmesh/selset';
import {
  BMesh,
  BMVert,
  BMEdge,
  BMFace,
  BMLoop,
  BMElem,
  BMVertSeq,
  BMEdgeSeq,
  BMFaceSeq,
  BMLoopSeq,
  BMEditSelSeq,
  BMLayerItem,
  BMLayerCollection,
  BMLayerAccess,
  BMLoopUV,
  BMDeformVert,
  describe,
} from './bmesh_core';
import { fromMeshData, toMeshData, type MeshSource } from './bmesh_mesh';
import { ops } from './bmesh_opdefs';
import { utils, geometry } from './bmesh_utils';
import './bmesh_ops';
import './bmesh_ops2';
import bmeshPy from './py/bmesh.py?raw';

// ---------------------------------------------------------------------------
// mesh data-blocks from script values

function meshArg(v: unknown, what: string): { id: string; me: MeshData } {
  if (isIdWrapper(v) && v.__table === 'meshes') {
    const me = app.doc.meshes[v.__id];
    if (!me) throw pyError('ReferenceError', `${what}: the mesh has been removed`);
    return { id: v.__id, me };
  }
  throw pyError('TypeError', `${what}: expected a Mesh (e.g. obj.data), got ${describe(v)}`);
}

declare module './bmesh_core' {
  interface BMesh {
    from_mesh(mesh: unknown, face_normals?: boolean, vertex_normals?: boolean, use_shape_key?: boolean, shape_key_index?: number): void;
    to_mesh(mesh: unknown): void;
    from_object(object: unknown, depsgraph?: unknown, cage?: boolean, face_normals?: boolean, vertex_normals?: boolean): void;
  }
}

BMesh.prototype.from_mesh = function (this: BMesh, mesh: unknown, _face_normals = true, _vertex_normals = true, use_shape_key = false, shape_key_index = 0) {
  this._chk();
  const { me } = meshArg(mesh, 'BMesh.from_mesh()');
  fromMeshData(this, me, { exclusions: exclusionsOf(me), shapeKey: use_shape_key ? shape_key_index : null });
};
kwMethod(BMesh.prototype, 'from_mesh', ['mesh', 'face_normals', 'vertex_normals', 'use_shape_key', 'shape_key_index']);

BMesh.prototype.to_mesh = function (this: BMesh, mesh: unknown) {
  this._chk();
  const { me } = meshArg(mesh, 'BMesh.to_mesh()');
  toMeshData(this, me, { selection: true });
  touched('geometry');
};
kwMethod(BMesh.prototype, 'to_mesh', ['mesh']);

BMesh.prototype.from_object = function (this: BMesh, object: unknown, _depsgraph: unknown = null, _cage = false) {
  this._chk();
  if (!(isIdWrapper(object) && object.__table === 'objects')) throw pyError('TypeError', `BMesh.from_object(): expected an Object, got ${describe(object)}`);
  const ob = app.doc.objects[object.__id];
  if (!ob) throw pyError('ReferenceError', 'BMesh.from_object(): the object has been removed');
  ensureEvaluated();
  const ev = app.graph.get(ob.id)?.mesh;
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  if (!ev && !me) throw pyError('ValueError', `BMesh.from_object(): object "${ob.name}" has no mesh data`);
  const src: MeshSource = ev ? { ...ev, uv_map_name: me?.uv_map_name, vertex_groups: ev.vertex_groups ?? (ev.weights ? me?.vertex_groups : undefined) } : me!;
  fromMeshData(this, src);
};
kwMethod(BMesh.prototype, 'from_object', ['object', 'depsgraph', 'cage', 'face_normals', 'vertex_normals']);

// ---------------------------------------------------------------------------
// Edit Mode

interface EditLink {
  doc: unknown;
  bm: BMesh;
  positions: unknown;
  indices: unknown;
  select: unknown;
}
const editLinks = new Map<string, EditLink>();

function editedMesh(id: string) {
  return editMeshObjects().find((x) => x.ob.data === id) ?? null;
}

function from_edit_mesh(mesh: unknown): BMesh {
  const { id, me } = meshArg(mesh, 'bmesh.from_edit_mesh()');
  const ed = editedMesh(id);
  if (!ed) throw pyError('ValueError', `bmesh.from_edit_mesh(): mesh "${me.name}" is not in Edit Mode (use bpy.ops.object.mode_set(mode='EDIT') first)`);
  const link = editLinks.get(id);
  if (link && link.doc === app.doc && link.bm._alive && link.positions === me.positions && link.indices === me.indices && link.select === me.select_vert) return link.bm;
  const bm = new BMesh();
  fromMeshData(bm, me, { exclusions: exclusionsOf(me) });
  bm._editMesh = id;
  const m = selectModes();
  bm._selectMode = new Set([m[0] ? 'VERT' : '', m[1] ? 'EDGE' : '', m[2] ? 'FACE' : ''].filter(Boolean));
  if (!bm._selectMode.size) bm._selectMode.add('VERT');
  // active element of the edited object
  if (editActive.objectId === ed.ob.id && editActive.index >= 0) {
    if (editActive.kind === 'FACE') {
      const f = [...bm._f].find((x) => x.index === editActive.index);
      if (f) {
        bm._active = f;
        if (f._sel) bm._hist.push(f);
      }
    } else if (editActive.kind === 'VERT') {
      const v = [...bm._v][editActive.index];
      if (v?._sel) bm._hist.push(v);
    }
  }
  editLinks.set(id, { doc: app.doc, bm, positions: me.positions, indices: me.indices, select: me.select_vert });
  return bm;
}

function update_edit_mesh(mesh: unknown, _loop_triangles = true, _destructive = true) {
  const { id, me } = meshArg(mesh, 'bmesh.update_edit_mesh()');
  const link = editLinks.get(id);
  if (!link || link.doc !== app.doc || !link.bm._alive) throw pyError('ValueError', `bmesh.update_edit_mesh(): no BMesh is editing mesh "${me.name}" (get one with bmesh.from_edit_mesh(mesh))`);
  toMeshData(link.bm, me, { selection: true });
  link.positions = me.positions;
  link.indices = me.indices;
  link.select = me.select_vert;
  const ed = editedMesh(id);
  const af = link.bm._active;
  if (ed && af && af._bm) {
    editActive.objectId = ed.ob.id;
    editActive.kind = 'FACE';
    editActive.index = af.index;
  }
  touched('geometry');
  touched('select');
}

// ---------------------------------------------------------------------------
// module object

const types = { BMesh, BMVert, BMEdge, BMFace, BMLoop, BMElem, BMVertSeq, BMEdgeSeq, BMFaceSeq, BMLoopSeq, BMEditSelSeq, BMLayerItem, BMLayerCollection, BMLayerAccess, BMLoopUV, BMDeformVert };

function resultItems(r: unknown): unknown[] {
  if (!r || typeof r !== 'object') return [];
  return Object.entries(r as Record<string, unknown>).map(([k, v]) => (v instanceof Map ? [k, [...v.entries()], true] : [k, v, false]));
}

export const bmesh = {
  __type: 'module',
  /** A new, empty BMesh. */
  new: (_use_operators = true) => new BMesh(),
  from_edit_mesh,
  update_edit_mesh,
  types,
  ops,
  utils,
  geometry,
  /** (internal) operator results as [key, value, isMap] for the Python layer */
  _result_items: resultItems,
  _op_names: () => (ops as { _names: () => string[] })._names(),
  toString: () => '<module bmesh>',
};
kwMethod(bmesh, 'new', ['use_operators']);
kwMethod(bmesh, 'from_edit_mesh', ['mesh']);
kwMethod(bmesh, 'update_edit_mesh', ['mesh', 'loop_triangles', 'destructive']);

registerScriptModule('bmesh', bmesh, bmeshPy);
