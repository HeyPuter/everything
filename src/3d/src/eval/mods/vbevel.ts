// Vertex bevel for the Bevel modifier: every chosen vertex is cut off by a polygon through points
// on its edges (adjacent chosen vertices share the edge between them).
import { Vector3 } from 'three';
import type { EvalMesh } from '../types';
import { MeshBuilder, weightsOf } from '../meshbuild';

export function bevelMeshVertices(m: EvalMesh, chosen: (v: number) => boolean, offset: number, segments: number, profile: number, material = -1): EvalMesh {
  const P = m.positions,
    nv = P.length / 3,
    nf = m.offsets.length - 1;
  const b = new MeshBuilder(m.weights?.length ?? 0, !!m.colors);
  const keep = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (!chosen(v)) keep[v] = b.addVert(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], m.origIndex?.[v] ?? v, weightsOf(m, v));
  const pv = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  // cut point on edge (v, w) near v
  const cuts = new Map<string, number>();
  const cut = (v: number, w: number) => {
    const key = `${v}:${w}`;
    let id = cuts.get(key);
    if (id === undefined) {
      const len = pv(v).distanceTo(pv(w));
      const t = Math.min(chosen(w) ? 0.5 : 0.95, offset / Math.max(len, 1e-12));
      const p = pv(v).lerp(pv(w), t);
      const wv = weightsOf(m, v),
        ww = weightsOf(m, w);
      id = b.addVert(p.x, p.y, p.z, -1, wv && ww ? wv.map((x, g) => x + (ww[g] - x) * t) : undefined);
      cuts.set(key, id);
    }
    return id;
  };
  const segs = Math.max(1, Math.round(segments));
  // per chosen vertex: rows of the corners around it, keyed by the corner's next neighbour
  const rowsAt = new Map<number, { prev: number; next: number; row: number[]; f: number; uv: number[] }[]>();
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    const verts: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < k; i++) {
      const c = s + i;
      const v = m.indices[c];
      const uv = [m.uvs[c * 2], m.uvs[c * 2 + 1]];
      if (!chosen(v)) {
        verts.push(keep[v]);
        uvs.push(...uv);
        continue;
      }
      const prev = m.indices[s + ((i + k - 1) % k)],
        next = m.indices[s + ((i + 1) % k)];
      const a = cut(v, prev),
        c2 = cut(v, next);
      const row = [a];
      if (segs > 1) {
        const pa = new Vector3().fromArray(b.pos, a * 3),
          pb = new Vector3().fromArray(b.pos, c2 * 3);
        const ctrl = pa.clone().lerp(pb, 0.5).lerp(pv(v), Math.min(1, profile * 2));
        for (let q = 1; q < segs; q++) {
          const t = q / segs;
          const pt = pa.clone().multiplyScalar((1 - t) * (1 - t)).add(ctrl.clone().multiplyScalar(2 * (1 - t) * t)).add(pb.clone().multiplyScalar(t * t));
          row.push(b.addVert(pt.x, pt.y, pt.z, -1, weightsOf(m, v)));
        }
      }
      row.push(c2);
      for (const r of row) {
        verts.push(r);
        uvs.push(...uv);
      }
      const list = rowsAt.get(v) ?? rowsAt.set(v, []).get(v)!;
      list.push({ prev, next, row, f, uv });
    }
    // drop repeated vertices (a face corner between two chosen neighbours can collapse)
    const vv: number[] = [],
      uu: number[] = [];
    verts.forEach((x, i) => {
      if (vv.length && vv[vv.length - 1] === x) return;
      vv.push(x);
      uu.push(uvs[i * 2], uvs[i * 2 + 1]);
    });
    if (vv.length > 1 && vv[0] === vv[vv.length - 1]) vv.pop();
    if (new Set(vv).size >= 3) b.addFace(vv, uu, m.smooth?.[f] ?? 0, m.material_index?.[f] ?? 0);
  }
  // caps: walk the corners around each vertex; the cap runs against the faces' direction
  for (const [, list] of rowsAt) {
    const byNext = new Map(list.map((x) => [x.next, x]));
    const prevs = new Set(list.map((x) => x.prev));
    // open fans start at the corner whose next edge has no face on the other side
    let start = list.find((x) => !prevs.has(x.next)) ?? list[0];
    const ring: number[] = [];
    const seen = new Set<typeof start>();
    let cur: typeof start | undefined = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      for (let i = cur.row.length - 1; i >= 0; i--) if (ring[ring.length - 1] !== cur.row[i]) ring.push(cur.row[i]);
      cur = byNext.get(cur.prev);
    }
    if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
    start = list[0];
    if (new Set(ring).size >= 3) b.addFace(ring, ring.flatMap(() => start.uv), m.smooth?.[start.f] ?? 0, material >= 0 ? material : m.material_index?.[start.f] ?? 0);
  }
  return b.build({ vertex_groups: m.vertex_groups, auto_smooth_angle: m.auto_smooth_angle });
}
