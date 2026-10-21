// Mesh data-layer operators of the Geometry Data panel and the skin data helpers: clear face sets,
// add / clear skin data, mark / clear loose skin vertices and the spatial reordering of a mesh.
import { app, registerOperators, type OpContext } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { defaultSkinData, SKIN_STRIDE } from '../eval/mods/skin';

type Arr = Float32Array | Uint32Array | Uint8Array | Uint16Array | Int32Array;

const meshOf = (ob: ObjectData | null | undefined): MeshData | undefined => (ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined);
const activeMesh = () => meshOf(app.activeObject);
const meshPoll = (ctx: OpContext) => !!activeMesh() && (ctx.doc.mode === 'OBJECT' || ctx.doc.mode === 'EDIT' || ctx.doc.mode === 'SCULPT');

/** Spread a 3D position over a 30-bit Morton (Z-order) code inside the given bounds. */
export function mortonKey(x: number, y: number, z: number, min: number[], size: number[]): number {
  const q = (v: number, i: number) => Math.max(0, Math.min(1023, Math.floor(((v - min[i]) / (size[i] || 1)) * 1023.999)));
  const spread = (v: number) => {
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    v = (v | (v << 2)) & 0x09249249;
    return v;
  };
  return (spread(q(x, 0)) | (spread(q(y, 1)) << 1) | (spread(q(z, 2)) << 2)) >>> 0;
}

/**
 * Orders that put vertices and faces close in space close in memory: elements are sorted along a
 * Z-order curve over the mesh bounds (stable for equal keys).
 */
export function spatialOrders(positions: ArrayLike<number>, offsets: ArrayLike<number>, indices: ArrayLike<number>): { verts: number[]; faces: number[] } {
  const nv = positions.length / 3,
    nf = offsets.length - 1;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i * 3 + k]);
      max[k] = Math.max(max[k], positions[i * 3 + k]);
    }
  const size = max.map((m, k) => m - min[k]);
  const vkey = Array.from({ length: nv }, (_, i) => mortonKey(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], min, size));
  const fkey = Array.from({ length: Math.max(0, nf) }, (_, f) => {
    const c = [0, 0, 0];
    const a = offsets[f],
      b = offsets[f + 1];
    for (let j = a; j < b; j++) for (let k = 0; k < 3; k++) c[k] += positions[indices[j] * 3 + k];
    const n = Math.max(1, b - a);
    return mortonKey(c[0] / n, c[1] / n, c[2] / n, min, size);
  });
  const verts = Array.from({ length: nv }, (_, i) => i).sort((a, b) => vkey[a] - vkey[b] || a - b);
  const faces = Array.from({ length: Math.max(0, nf) }, (_, i) => i).sort((a, b) => fkey[a] - fkey[b] || a - b);
  return { verts, faces };
}

/** Permute `arr` (stride values per element) into `order` (new position → old index). */
function permute<T extends Arr>(arr: T, order: number[], stride: number): T {
  const out = new (arr.constructor as new (n: number) => T)(arr.length);
  for (let i = 0; i < order.length; i++) for (let k = 0; k < stride; k++) out[i * stride + k] = arr[order[i] * stride + k];
  return out;
}

/**
 * Reorder a mesh's vertices and faces (orders list old indices in their new positions), carrying every
 * per-vertex, per-face and per-corner layer along. The geometry itself is unchanged.
 */
export function reorderMesh(me: MeshData, vorder: number[], forder: number[]) {
  const nv = me.positions.length / 3,
    nf = me.offsets.length - 1,
    nc = me.indices.length;
  const vmap = new Uint32Array(nv);
  vorder.forEach((old, i) => (vmap[old] = i));
  const rec = me as unknown as Record<string, unknown>;
  const per = (key: string, count: number, order: number[]) => {
    const a = rec[key] as Arr | undefined;
    if (!a || !ArrayBuffer.isView(a) || a.length % Math.max(1, count) || !count) return;
    rec[key] = permute(a, order, a.length / count);
  };
  // vertex layers
  for (const k of ['positions', 'select_vert', 'hide_vert', 'sculpt_mask', 'skin_vertices']) per(k, nv, vorder);
  me.weights = me.weights.map((w) => (w.length === nv ? permute(w, vorder, 1) : w));
  me.shape_keys = me.shape_keys.map((s) => (s.data.length === nv * 3 ? { ...s, data: permute(s.data, vorder, 3) } : s));
  // corner order follows the new face order
  const cornerOrder: number[] = [];
  const offsets = new Uint32Array(nf + 1);
  for (let i = 0; i < nf; i++) {
    const f = forder[i];
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) cornerOrder.push(c);
    offsets[i + 1] = cornerOrder.length;
  }
  for (const k of ['smooth', 'material_index', 'quad_flip', 'face_strength', 'sculpt_face_set', 'hide_poly', 'uv_hide', 'freestyle_face']) per(k, nf, forder);
  for (const k of ['uvs', 'normals', 'seams', 'sharp', 'creases', 'custom_normals', 'uv_select', 'uv_pin', 'freestyle_edge', 'bevel_weight_edge']) per(k, nc, cornerOrder);
  me.color_attributes = me.color_attributes.map((c) => ({ ...c, data: c.domain === 'POINT' ? permute(c.data, vorder, 4) : permute(c.data, cornerOrder, 4) }));
  const idx = permute(me.indices, cornerOrder, 1);
  for (let i = 0; i < idx.length; i++) idx[i] = vmap[idx[i]];
  me.indices = idx;
  me.offsets = offsets;
  if (me.loose_edges) me.loose_edges = Uint32Array.from(me.loose_edges, (v) => vmap[v]);
  void nc;
}

const changed = () => app.changed('doc', 'geometry');

registerOperators([
  {
    idname: 'mesh.customdata_face_sets_clear',
    label: 'Clear Sculpt Face Sets',
    description: 'Remove the face set data of the mesh (every face goes back to a single set)',
    poll: (ctx) => meshPoll(ctx) && !!activeMesh()!.sculpt_face_set,
    exec: () => {
      const me = activeMesh()!;
      me.sculpt_face_set = undefined;
      changed();
    },
  },
  {
    idname: 'mesh.customdata_skin_add',
    label: 'Add Skin Data',
    description: 'Give every vertex skin radii (one root per connected part), as the Skin modifier uses',
    poll: (ctx) => meshPoll(ctx) && !(activeMesh()!.skin_vertices?.length === activeMesh()!.positions.length / 3 * SKIN_STRIDE),
    exec: () => {
      const me = activeMesh()!;
      me.skin_vertices = defaultSkinData({ ...me, looseEdges: me.loose_edges });
      changed();
    },
  },
  {
    idname: 'mesh.customdata_skin_clear',
    label: 'Clear Skin Data',
    description: 'Remove the skin radii, roots and loose flags of the mesh',
    poll: (ctx) => meshPoll(ctx) && !!activeMesh()!.skin_vertices,
    exec: () => {
      activeMesh()!.skin_vertices = undefined;
      changed();
    },
  },
  {
    idname: 'mesh.reorder_vertices_spatial',
    label: 'Reorder Mesh Spatially',
    description: 'Renumber vertices and faces so that elements close in space are close in order (faster sculpting and ray casting)',
    poll: (ctx) => meshPoll(ctx) && ctx.doc.mode !== 'EDIT',
    exec: () => {
      const me = activeMesh()!;
      if (!me.positions.length) return 'CANCELLED';
      const o = spatialOrders(me.positions, me.offsets, me.indices);
      reorderMesh(me, o.verts, o.faces);
      changed();
    },
  },
  {
    idname: 'object.skin_loose_mark_clear',
    label: 'Skin Mark/Clear Loose',
    description: 'Mark the selected vertices loose (their skin hull is not forced round) or clear the mark',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'MARK', items: [['MARK', 'Mark', 'Mark the selection as loose'], ['CLEAR', 'Clear', 'Clear the loose mark of the selection']] }],
    poll: (ctx) => ctx.doc.mode === 'EDIT' && !!activeMesh() && !!app.activeObject!.modifiers.some((m) => m.type === 'SKIN'),
    exec: (_ctx, p) => {
      const me = activeMesh()!;
      const nv = me.positions.length / 3;
      const data = Float32Array.from(me.skin_vertices?.length === nv * SKIN_STRIDE ? me.skin_vertices : defaultSkinData({ ...me, looseEdges: me.loose_edges }));
      let n = 0;
      for (let v = 0; v < nv; v++)
        if (me.select_vert?.[v] && !me.hide_vert?.[v]) {
          data[v * SKIN_STRIDE + 3] = p.action === 'MARK' ? 1 : 0;
          n++;
        }
      if (!n) return 'CANCELLED';
      me.skin_vertices = data;
      changed();
    },
  },
]);

registerOperators([
  {
    idname: 'object.shape_key_retime',
    label: 'Re-Time Shape Keys',
    description: 'Space the evaluation times of absolute shape keys evenly in list order (10 apart)',
    poll: () => (activeMesh()?.shape_keys.length ?? 0) > 1,
    exec: () => {
      const me = activeMesh()!;
      me.shape_keys = me.shape_keys.map((k, i) => ({ ...k, frame: i * 10 }));
      changed();
    },
  },
]);
