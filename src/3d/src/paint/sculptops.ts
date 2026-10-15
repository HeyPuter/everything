// Sculpt Mode operators: mask fill/invert/filters, voxel remesh.
import { Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { BufferAttribute, BufferGeometry } from 'three';
import { app, registerOperators } from '../app/app';
import { cow, own } from '../data/cow';
import type { MeshData } from '../data/types';
import { activeMeshData, dropSession, meshSession } from './session';
import { invalidatePaintAttributes, maskChanged } from './display';
import { voxelRemesh } from './remesh';

const sculptPoll = () => app.doc.mode === 'SCULPT' && !!activeMeshData();

function editMask(fn: (mask: Float32Array, me: MeshData) => void) {
  const { me } = activeMeshData()!;
  const nv = me.positions.length / 3;
  if (!me.sculpt_mask || me.sculpt_mask.length !== nv) me.sculpt_mask = own(new Float32Array(nv));
  else cow(me, 'sculpt_mask');
  fn(me.sculpt_mask, me);
  maskChanged(me.sculpt_mask);
  invalidatePaintAttributes();
}

// ---------------------------------------------------------------------------
// mask filters

function neighborsFilter(type: string, mask: Float32Array) {
  const s = meshSession();
  if (!s) return;
  const nb = s.neighbors;
  const src = mask.slice();
  for (let v = 0; v < s.nv; v++) {
    const a = nb.offsets[v],
      e = nb.offsets[v + 1];
    if (e === a) continue;
    let sum = 0,
      mx = src[v],
      mn = src[v];
    for (let j = a; j < e; j++) {
      const m = src[nb.neighbors[j]];
      sum += m;
      if (m > mx) mx = m;
      if (m < mn) mn = m;
    }
    const avg = sum / (e - a);
    if (type === 'SMOOTH') mask[v] = (src[v] + avg) / 2;
    else if (type === 'SHARPEN') mask[v] = Math.max(0, Math.min(1, src[v] + (src[v] - avg) * 0.5 + (src[v] > 0.5 ? 0.05 : -0.05)));
    else if (type === 'GROW') mask[v] = mx;
    else if (type === 'SHRINK') mask[v] = mn;
  }
}

// ---------------------------------------------------------------------------
// voxel remesh

function remeshActive(voxel: number): string | null {
  const am = activeMeshData();
  if (!am) return 'No active mesh';
  const { ob, me } = am;
  const s = meshSession();
  if (!s) return 'Mesh has no faces';
  const res = voxelRemesh(me.positions, s.tris, voxel);
  const nv = res.positions.length / 3,
    nf = res.quads.length / 4;
  if (!nf) return 'Voxel remesh produced no faces (voxel size too large?)';
  // transfer per-vertex data (mask, weights, point colors) from the closest point on the old surface
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(me.positions, 3));
  geo.setIndex(new BufferAttribute(s.tris, 1));
  const bvh = new MeshBVH(geo, { indirect: true });
  const src = new Int32Array(nv * 3),
    bw = new Float32Array(nv * 3);
  const p = new Vector3();
  const tgt = { point: new Vector3(), distance: 0, faceIndex: 0 };
  for (let v = 0; v < nv; v++) {
    p.set(res.positions[v * 3], res.positions[v * 3 + 1], res.positions[v * 3 + 2]);
    const hit = bvh.closestPointToPoint(p, tgt as never) as {
      point: Vector3;
      faceIndex: number;
    } | null;
    const t = hit ? hit.faceIndex : 0;
    const ia = s.tris[t * 3],
      ib = s.tris[t * 3 + 1],
      ic = s.tris[t * 3 + 2];
    src[v * 3] = ia;
    src[v * 3 + 1] = ib;
    src[v * 3 + 2] = ic;
    const q = hit ? hit.point : p;
    const A = new Vector3().fromArray(me.positions, ia * 3),
      B = new Vector3().fromArray(me.positions, ib * 3),
      C = new Vector3().fromArray(me.positions, ic * 3);
    const v0 = B.clone().sub(A),
      v1 = C.clone().sub(A),
      v2 = q.clone().sub(A);
    const d00 = v0.dot(v0),
      d01 = v0.dot(v1),
      d11 = v1.dot(v1),
      d20 = v2.dot(v0),
      d21 = v2.dot(v1);
    const den = d00 * d11 - d01 * d01 || 1;
    const w1 = (d11 * d20 - d01 * d21) / den,
      w2 = (d00 * d21 - d01 * d20) / den;
    bw[v * 3] = 1 - w1 - w2;
    bw[v * 3 + 1] = w1;
    bw[v * 3 + 2] = w2;
  }
  const transfer = (arr: Float32Array, comps: number) => {
    const out = new Float32Array(nv * comps);
    for (let v = 0; v < nv; v++)
      for (let c = 0; c < comps; c++) out[v * comps + c] = arr[src[v * 3] * comps + c] * bw[v * 3] + arr[src[v * 3 + 1] * comps + c] * bw[v * 3 + 1] + arr[src[v * 3 + 2] * comps + c] * bw[v * 3 + 2];
    return own(out);
  };
  const smooth = me.smooth?.length ? me.smooth[0] : 0;
  const offsets = new Uint32Array(nf + 1);
  for (let f = 0; f <= nf; f++) offsets[f] = f * 4;
  const indices = res.quads;
  // flat corner normals for the polygon tools
  const normals = new Float32Array(indices.length * 3);
  const P = res.positions;
  for (let f = 0; f < nf; f++) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = 0; k < 4; k++) {
      const a = indices[f * 4 + k] * 3,
        b = indices[f * 4 + ((k + 1) & 3)] * 3;
      x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(x, y, z) || 1;
    for (let k = 0; k < 4; k++) normals.set([x / l, y / l, z / l], (f * 4 + k) * 3);
  }
  const weights = me.weights.map((w) => (w && w.length === me.positions.length / 3 ? transfer(w, 1) : own(new Float32Array(nv))));
  const mask = me.sculpt_mask && me.sculpt_mask.length === me.positions.length / 3 ? transfer(me.sculpt_mask, 1) : undefined;
  const colors = me.color_attributes.map((c) => {
    if (c.domain === 'POINT') return { ...c, data: transfer(c.data, 4) };
    // corner colors: average per old vertex, then transfer and expand to the new corners
    const per = new Float32Array((me.positions.length / 3) * 4),
      cnt = new Uint32Array(me.positions.length / 3);
    for (let k = 0; k < me.indices.length; k++) {
      const vi = me.indices[k];
      for (let j = 0; j < 4; j++) per[vi * 4 + j] += c.data[k * 4 + j];
      cnt[vi]++;
    }
    for (let vi = 0; vi < cnt.length; vi++) if (cnt[vi]) for (let j = 0; j < 4; j++) per[vi * 4 + j] /= cnt[vi];
    const pv = transfer(per, 4);
    const out = new Float32Array(indices.length * 4);
    for (let k = 0; k < indices.length; k++) out.set(pv.subarray(indices[k] * 4, indices[k] * 4 + 4), k * 4);
    return { ...c, data: own(out) };
  });
  me.positions = own(res.positions);
  me.offsets = offsets;
  me.indices = indices;
  me.uvs = new Float32Array(indices.length * 2);
  me.normals = normals;
  me.smooth = new Uint8Array(nf).fill(smooth);
  me.material_index = new Uint16Array(nf);
  me.seams = undefined;
  me.sharp = undefined;
  me.creases = undefined;
  me.select_vert = undefined;
  me.hide_vert = undefined;
  me.loose_edges = undefined;
  me.weights = weights;
  me.sculpt_mask = mask;
  me.color_attributes = colors;
  me.shape_keys = [];
  me.active_shape_key_index = 0;
  void ob;
  dropSession();
  invalidatePaintAttributes();
  return null;
}

registerOperators([
  {
    idname: 'paint.mask_flood_fill',
    label: 'Mask Flood Fill',
    description: 'Fill the whole mask with a given value, or invert its values',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'VALUE',
        items: [
          ['VALUE', 'Value'],
          ['VALUE_INVERSE', 'Value Inverted'],
          ['INVERT', 'Invert'],
        ],
      },
      {
        id: 'value',
        label: 'Value',
        type: 'float',
        default: 0,
        min: 0,
        max: 1,
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) =>
      editMask((mask) => {
        const val = p.value as number;
        if (p.mode === 'INVERT') for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
        else mask.fill(p.mode === 'VALUE_INVERSE' ? 1 - val : val);
      }),
  },
  {
    idname: 'sculpt.mask_filter',
    label: 'Mask Filter',
    description: 'Apply a filter to the mask',
    props: [
      {
        id: 'filter_type',
        label: 'Type',
        type: 'enum',
        default: 'SMOOTH',
        items: [
          ['SMOOTH', 'Smooth Mask'],
          ['SHARPEN', 'Sharpen Mask'],
          ['GROW', 'Grow Mask'],
          ['SHRINK', 'Shrink Mask'],
          ['CONTRAST_INCREASE', 'Increase Contrast'],
          ['CONTRAST_DECREASE', 'Decrease Contrast'],
        ],
      },
      {
        id: 'iterations',
        label: 'Iterations',
        type: 'int',
        default: 1,
        min: 1,
        max: 100,
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) =>
      editMask((mask) => {
        const t = p.filter_type as string;
        for (let it = 0; it < (p.iterations as number); it++) {
          if (t === 'CONTRAST_INCREASE' || t === 'CONTRAST_DECREASE') {
            const k = t === 'CONTRAST_INCREASE' ? 1.25 : 0.8;
            for (let i = 0; i < mask.length; i++) mask[i] = Math.max(0, Math.min(1, (mask[i] - 0.5) * k + 0.5));
          } else neighborsFilter(t, mask);
        }
      }),
  },
  {
    idname: 'object.voxel_remesh',
    label: 'Voxel Remesh',
    description: 'Rebuild the mesh as an even quad grid from its volume (voxel size from the mesh settings)',
    poll: () => !!activeMeshData() && (app.doc.mode === 'OBJECT' || (app.doc.mode === 'SCULPT' && !app.doc.scene.tool_settings.sculpt.use_dyntopo)),
    exec: () => {
      const { me } = activeMeshData()!;
      const t0 = performance.now();
      let err: string | null;
      try {
        err = remeshActive(me.remesh_voxel_size ?? 0.1);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      if (err) {
        app.report('ERROR', err);
        return 'CANCELLED';
      }
      app.report('INFO', `Voxel remesh: ${(me.positions.length / 3).toLocaleString()} vertices (${Math.round(performance.now() - t0)} ms)`);
    },
  },
  {
    idname: 'sculpt.optimize',
    label: 'Rebuild BVH',
    description: 'Rebuild the acceleration structure used for sculpting',
    undo: false,
    poll: sculptPoll,
    exec: () => {
      dropSession();
      meshSession();
    },
  },
]);
