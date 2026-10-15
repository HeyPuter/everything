// Sculpt ▸ Symmetrize and face set fairing (Fair Positions / Fair Tangency).
import { app, operators, registerOperators } from '../app/app';
import { cow, own } from '../data/cow';
import { buildMesh, type PolyFace } from '../mesh/mesh';
import { activeMeshData, beginGeometryStroke, dropSession, meshSession } from './session';
import { invalidatePaintAttributes } from './display';
import { faceSetsOf, hiddenFacesOf } from './fsdata';
import { faceSetUnderCursor, sculptPoll } from './facesetops';
import { finishDeform } from './gestureops';
import { fairVertices, symmetrizeMesh } from './symmetrize';

registerOperators([
  {
    idname: 'sculpt.symmetrize',
    label: 'Symmetrize',
    description: 'Make the mesh symmetric by mirroring one half over the other',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'NEGATIVE_X',
        items: [
          ['NEGATIVE_X', '-X to +X', 'Copy the -X half to +X'],
          ['POSITIVE_X', '+X to -X', 'Copy the +X half to -X'],
          ['NEGATIVE_Y', '-Y to +Y', 'Copy the -Y half to +Y'],
          ['POSITIVE_Y', '+Y to -Y', 'Copy the +Y half to -Y'],
          ['NEGATIVE_Z', '-Z to +Z', 'Copy the -Z half to +Z'],
          ['POSITIVE_Z', '+Z to -Z', 'Copy the +Z half to -Z'],
        ],
      },
      { id: 'merge_tolerance', label: 'Merge Distance', type: 'float', default: 0.0005, min: 0, max: 1, subtype: 'distance', precision: 5 },
    ],
    poll: sculptPoll,
    exec: (_c, p) => {
      const { me } = activeMeshData()!;
      const dir = p.direction as string;
      const axis = (dir.endsWith('X') ? 0 : dir.endsWith('Y') ? 1 : 2) as 0 | 1 | 2;
      const sign = dir.startsWith('NEGATIVE') ? -1 : 1;
      const r = symmetrizeMesh(me, axis, sign, Math.max(1e-7, p.merge_tolerance as number));
      const nf = r.offsets.length - 1;
      if (!nf) {
        app.report('WARNING', 'Nothing to mirror on that side');
        return 'CANCELLED';
      }
      const polys: PolyFace[] = [];
      for (let f = 0; f < nf; f++) {
        const sf = r.srcFace[f];
        polys.push({ verts: Array.from(r.indices.subarray(r.offsets[f], r.offsets[f + 1])), uvs: Array.from(r.uvs.subarray(r.offsets[f] * 2, r.offsets[f + 1] * 2)), smooth: !!me.smooth?.[sf], material: me.material_index?.[sf] ?? 0 });
      }
      const arrays = buildMesh(r.positions, polys);
      const nv = arrays.positions.length / 3;
      const oldNv = me.positions.length / 3;
      const lerp = (src: Float32Array, comps: number) => {
        const out = new Float32Array(nv * comps);
        for (let v = 0; v < nv; v++)
          for (let k = 0; k < comps; k++) out[v * comps + k] = src[r.srcA[v] * comps + k] * (1 - r.srcT[v]) + src[r.srcB[v] * comps + k] * r.srcT[v];
        return own(out);
      };
      const fsOld = faceSetsOf(me);
      Object.assign(me, arrays);
      me.seams = undefined;
      me.sharp = undefined;
      me.creases = undefined;
      me.weights = me.weights.map((w) => (w && w.length === oldNv ? lerp(w, 1) : own(new Float32Array(nv))));
      me.sculpt_mask = me.sculpt_mask && me.sculpt_mask.length === oldNv ? lerp(me.sculpt_mask, 1) : undefined;
      me.sculpt_face_set = fsOld ? Int32Array.from(r.srcFace, (sf) => fsOld[sf]) : undefined;
      me.color_attributes = me.color_attributes.filter((c) => c.domain === 'POINT').map((c) => ({ ...c, data: lerp(c.data, 4) }));
      me.active_color_index = Math.min(me.active_color_index, Math.max(0, me.color_attributes.length - 1));
      me.shape_keys = [];
      me.active_shape_key_index = 0;
      me.select_vert = undefined;
      me.hide_vert = undefined;
      me.hide_poly = undefined;
      me.loose_edges = undefined;
      me.uv_select = undefined;
      dropSession();
      invalidatePaintAttributes();
      app.changed('geometry');
    },
  },
]);

// fairing as extra modes of Edit Face Set
{
  const op = operators.get('sculpt.face_set_edit');
  if (op) {
    const modeProp = op.props!.find((p) => p.id === 'mode')!;
    modeProp.items = [...modeProp.items!, ['FAIR_POSITIONS', 'Fair Positions', 'Smooth the face set like a membrane between its fixed borders'], ['FAIR_TANGENCY', 'Fair Tangency', 'Smooth the face set so it meets its borders smoothly']];
    const base = op.exec!;
    op.exec = (ctx, p) => {
      if (p.mode !== 'FAIR_POSITIONS' && p.mode !== 'FAIR_TANGENCY') return base(ctx, p);
      const am = activeMeshData();
      const s = meshSession();
      const id = p.active_face_set as number;
      if (!am || !s || !id) return 'CANCELLED';
      const { me } = am;
      const fs = faceSetsOf(me);
      const hf = hiddenFacesOf(me);
      const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
      // free vertices: only faces of the set around them (the borders stay fixed)
      const free = new Uint8Array(s.nv);
      for (let v = 0; v < s.nv; v++) {
        let ok = s.vf.offsets[v + 1] > s.vf.offsets[v];
        for (let k = s.vf.offsets[v]; k < s.vf.offsets[v + 1] && ok; k++) {
          const f = s.vf.faces[k];
          if ((fs ? fs[f] : 1) !== id || hf?.[f]) ok = false;
        }
        if (ok && mask && mask[v] >= 0.5) ok = false;
        free[v] = ok ? 1 : 0;
      }
      if (!free.some((x) => x)) return 'CANCELLED';
      beginGeometryStroke(s, me, () => cow(me, 'positions'));
      const nb = s.neighbors;
      fairVertices(s.positions, nb.offsets, nb.neighbors, free, p.mode === 'FAIR_TANGENCY' ? 'TANGENCY' : 'POSITION', 300 * (p.repeat as number));
      finishDeform(s, me, null);
    };
    void faceSetUnderCursor;
  }
}
