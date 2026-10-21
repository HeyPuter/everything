// object.quadriflow_remesh: rebuild the active mesh as quads (modeling/quadremesh.ts), with optional
// symmetry (the mesh's mirror axes), sharp feature and boundary preservation, smooth shading and
// transfer of vertex groups / vertex attributes from the nearest original vertex.
import { Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { buildMesh, type PolyFace } from '../mesh/mesh';
import { MeshEdit } from '../modes/editmesh/meshedit';
import { bisectMesh } from '../modes/editmesh/ops-uv';
import { quadRemesh } from './quadremesh';
import { operatorDialog } from '../ui/opdialog';
import { validAttributes, attrWidth, makeAttrArray } from '../mesh/attributes';

const meshOf = (ob: ObjectData | null | undefined): MeshData | undefined => (ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined);

function surfaceArea(me: MeshData): number {
  let a = 0;
  const P = me.positions;
  for (let f = 0; f + 1 < me.offsets.length; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    const v0 = me.indices[s];
    for (let c = s + 1; c + 1 < e; c++) {
      const v1 = me.indices[c],
        v2 = me.indices[c + 1];
      const ux = P[v1 * 3] - P[v0 * 3],
        uy = P[v1 * 3 + 1] - P[v0 * 3 + 1],
        uz = P[v1 * 3 + 2] - P[v0 * 3 + 2];
      const wx = P[v2 * 3] - P[v0 * 3],
        wy = P[v2 * 3 + 1] - P[v0 * 3 + 1],
        wz = P[v2 * 3 + 2] - P[v0 * 3 + 2];
      a += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    }
  }
  return a;
}

/** Nearest original vertex of each new vertex (uniform grid). */
function nearestVertices(src: ArrayLike<number>, dst: ArrayLike<number>): Int32Array {
  const n = src.length / 3;
  let lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], src[i * 3 + k]);
      hi[k] = Math.max(hi[k], src[i * 3 + k]);
    }
  const size = Math.max(...hi.map((h, k) => h - lo[k]), 1e-6);
  const cell = size / Math.max(1, Math.cbrt(n));
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const ci = (p: number, k: number) => Math.floor((p - lo[k]) / cell);
  for (let i = 0; i < n; i++) {
    const k = key(ci(src[i * 3], 0), ci(src[i * 3 + 1], 1), ci(src[i * 3 + 2], 2));
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
  }
  const out = new Int32Array(dst.length / 3);
  for (let j = 0; j < out.length; j++) {
    const p = [dst[j * 3], dst[j * 3 + 1], dst[j * 3 + 2]];
    const c = p.map((x, k) => ci(x, k));
    let best = 0,
      bd = Infinity;
    for (let r = 0; r < 64 && (bd === Infinity || r <= 1 + Math.sqrt(bd) / cell); r++)
      for (let x = c[0] - r; x <= c[0] + r; x++)
        for (let y = c[1] - r; y <= c[1] + r; y++)
          for (let z = c[2] - r; z <= c[2] + r; z++) {
            if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== r) continue;
            for (const i of cells.get(key(x, y, z)) ?? []) {
              const d = (src[i * 3] - p[0]) ** 2 + (src[i * 3 + 1] - p[1]) ** 2 + (src[i * 3 + 2] - p[2]) ** 2;
              if (d < bd) {
                bd = d;
                best = i;
              }
            }
          }
    out[j] = best;
  }
  return out;
}

registerOperators([
  {
    idname: 'object.quadriflow_remesh',
    label: 'QuadriFlow Remesh',
    description: 'Rebuild the mesh as evenly sized quads following its surface (the mesh data layers are replaced)',
    props: [
      { id: 'use_mesh_symmetry', label: 'Use Mesh Symmetry', type: 'bool', default: true },
      { id: 'use_preserve_sharp', label: 'Preserve Sharp', type: 'bool', default: false },
      { id: 'use_preserve_boundary', label: 'Preserve Mesh Boundary', type: 'bool', default: false },
      { id: 'preserve_attributes', label: 'Preserve Attributes', type: 'bool', default: false },
      { id: 'smooth_normals', label: 'Smooth Normals', type: 'bool', default: false },
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'FACES',
        items: [
          ['RATIO', 'Ratio', 'A number of faces relative to the current mesh'],
          ['EDGE', 'Edge Length', 'Quads of about this edge length'],
          ['FACES', 'Faces', 'About this many quads'],
        ],
      },
      { id: 'target_ratio', label: 'Ratio', type: 'float', default: 1, min: 0, softMax: 10, showIf: (p) => p.mode === 'RATIO' },
      { id: 'target_edge_length', label: 'Edge Length', type: 'float', default: 0.1, min: 1e-7, subtype: 'distance', showIf: (p) => p.mode === 'EDGE' },
      { id: 'target_faces', label: 'Number of Faces', type: 'int', default: 4000, min: 1, showIf: (p) => p.mode === 'FACES' },
      { id: 'seed', label: 'Seed', type: 'int', default: 0, min: 0 },
    ],
    poll: (ctx: OpContext) => ctx.doc.mode === 'OBJECT' && !!meshOf(app.activeObject),
    invoke: (_ctx, p) => {
      operatorDialog('object.quadriflow_remesh', p, { title: 'QuadriFlow Remesh', width: 320 });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const me = meshOf(ob)!;
      if (me.offsets.length < 2) {
        app.report('ERROR', 'The mesh has no faces to remesh');
        return 'CANCELLED';
      }
      const t0 = performance.now();
      const area = surfaceArea(me);
      const faces0 = me.offsets.length - 1;
      let target = p.mode === 'RATIO' ? Math.round(faces0 * (p.target_ratio as number)) : p.mode === 'EDGE' ? Math.round(area / Math.max(1e-12, (p.target_edge_length as number) ** 2)) : (p.target_faces as number);
      target = Math.max(4, Math.min(2_000_000, target));
      // symmetry: remesh the positive half of each mirror axis, then mirror the result back
      const ts = ctx.doc.scene.tool_settings;
      const axes = p.use_mesh_symmetry ? [ts.use_mesh_mirror_x, ts.use_mesh_mirror_y, ts.use_mesh_mirror_z].map((b, k) => (b ? k : -1)).filter((k) => k >= 0) : [];
      const src = MeshEdit.from(me);
      for (const k of axes) {
        const n = new Vector3().setComponent(k, 1);
        bisectMesh(src, new Vector3(), n, true, false);
        src.compact();
        target = Math.max(4, Math.round(target / 2));
      }
      const sharpEdges: [number, number][] = [];
      if (p.use_preserve_sharp)
        src.faces.forEach((f) => f.sharp.forEach((s, i) => s && sharpEdges.push([f.verts[i], f.verts[(i + 1) % f.verts.length]])));
      const r = quadRemesh(src.pos, src.faces.map((f) => f.verts), {
        targetFaces: target,
        sharpAngle: p.use_preserve_sharp ? (35 * Math.PI) / 180 : 0,
        sharpEdges,
        seed: p.seed as number,
      });
      if (!r.quads.length) {
        app.report('ERROR', 'Remeshing failed');
        return 'CANCELLED';
      }
      let pos = Array.from(r.positions);
      let quads: number[][] = [];
      for (let i = 0; i < r.quads.length; i += 4) quads.push(Array.from(r.quads.subarray(i, i + 4)));
      for (const k of [...axes].reverse()) {
        // mirror copy, welding the vertices on the plane
        const nv = pos.length / 3;
        const eps = 1e-5 * Math.sqrt(area);
        const map: number[] = [];
        for (let v = 0; v < nv; v++) {
          if (Math.abs(pos[v * 3 + k]) <= eps) {
            pos[v * 3 + k] = 0;
            map.push(v);
          } else {
            map.push(pos.length / 3);
            const q = pos.slice(v * 3, v * 3 + 3);
            q[k] = -q[k];
            pos.push(...q);
          }
        }
        quads = [...quads, ...quads.map((f) => f.map((v) => map[v]).reverse())];
      }
      // carry vertex groups / vertex attributes from the nearest original vertex
      const near = p.preserve_attributes ? nearestVertices(me.positions, pos) : null;
      const arrays = buildMesh(pos, quads.map((verts) => ({ verts, smooth: !!p.smooth_normals }) as PolyFace));
      const groups = me.vertex_groups;
      const weights = near ? me.weights.map((w) => Float32Array.from(near, (i) => w[i] ?? 0)) : me.weights.map(() => new Float32Array(pos.length / 3));
      const pointAttrs = near
        ? validAttributes(me)
            .filter((a) => a.domain === 'POINT')
            .map((a) => {
              const w = attrWidth(a.data_type);
              const data = makeAttrArray(a.data_type, near.length * w);
              near.forEach((i, j) => data.set(a.data.subarray(i * w, (i + 1) * w), j * w));
              return { ...a, data };
            })
        : [];
      Object.assign(me, arrays);
      me.uvs = new Float32Array(me.indices.length * 2);
      me.vertex_groups = groups;
      me.weights = weights;
      me.shape_keys = [];
      me.active_shape_key_index = 0;
      me.color_attributes = [];
      me.attributes = pointAttrs.length ? pointAttrs : undefined;
      for (const k of ['seams', 'sharp', 'creases', 'custom_normals', 'quad_flip', 'face_strength', 'select_vert', 'hide_vert', 'sculpt_mask', 'sculpt_face_set', 'hide_poly', 'loose_edges', 'skin_vertices', 'uv_select', 'uv_pin', 'uv_hide', 'bevel_weight_edge', 'bevel_weight_vert', 'crease_vert', 'uv_layers_extra'] as const) delete (me as unknown as Record<string, unknown>)[k];
      me.material_index = new Uint16Array(me.offsets.length - 1);
      app.changed('doc', 'geometry');
      app.report('INFO', `Quad remesh: ${(me.offsets.length - 1).toLocaleString()} faces (${Math.round(performance.now() - t0)} ms)`);
    },
  },
]);
