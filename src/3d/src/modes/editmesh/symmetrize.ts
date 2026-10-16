// Symmetrize: cut the selected faces along an axis plane, drop the part on the target side and
// replace it with a mirrored copy of the source side, welded along the plane.
import { MeshEdit, type EFace } from './meshedit';
import { flipFace } from './ops-basic';

/**
 * `axis` 0/1/2, `keepNegative`: the negative side is the source (copied onto the positive side).
 * Vertices within `threshold` of the plane are snapped onto it and shared by both halves.
 */
export function symmetrizeMesh(m: MeshEdit, axis: number, keepNegative: boolean, threshold: number): boolean {
  const sign = keepNegative ? -1 : 1;
  const side = (v: number) => m.pos[v * 3 + axis] * sign; // > 0: source side
  const selFaces = new Set(m.selectedFaces());
  if (!selFaces.size) return false;
  const selVerts = new Set<number>();
  for (const fi of selFaces) for (const v of m.faces[fi].verts) selVerts.add(v);
  for (const v of selVerts) if (Math.abs(m.pos[v * 3 + axis]) <= threshold) m.pos[v * 3 + axis] = 0;

  // 1. cut faces crossing the plane, keep the source part
  const cuts = new Map<string, number>();
  const cutVert = (a: number, b: number) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    let id = cuts.get(k);
    if (id === undefined) {
      const sa = side(a),
        sb = side(b);
      const t = sa / (sa - sb);
      const pa = m.p(a),
        pb = m.p(b);
      const p = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * t);
      p[axis] = 0;
      id = m.addVert(p, [[a, 1 - t], [b, t]], 1);
      cuts.set(k, id);
    }
    return id;
  };
  const kept: EFace[] = [];
  const out: EFace[] = [];
  m.faces.forEach((f, fi) => {
    if (!selFaces.has(fi)) return out.push(f);
    const s = f.verts.map(side);
    if (s.every((x) => x <= 0)) {
      // entirely on the target side (or flat on the plane): replaced by the mirror
      if (s.every((x) => x === 0)) out.push(f);
      return;
    }
    if (s.every((x) => x >= 0)) {
      kept.push(f);
      return out.push(f);
    }
    const n = f.verts.length;
    const verts: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (s[i] >= 0) {
        verts.push(f.verts[i]);
        uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
      }
      if ((s[i] > 0 && s[j] < 0) || (s[i] < 0 && s[j] > 0)) {
        const t = s[i] / (s[i] - s[j]);
        verts.push(cutVert(f.verts[i], f.verts[j]));
        uvs.push(f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t);
      }
    }
    if (verts.length < 3) return;
    const half = m.makeFace(verts, f, uvs);
    kept.push(half);
    out.push(half);
  });

  // 2. mirror the source part; vertices on the plane are shared
  const mirror = new Map<number, number>();
  const mv = (v: number) => {
    if (m.pos[v * 3 + axis] === 0) return v;
    let id = mirror.get(v);
    if (id === undefined) {
      const p = m.p(v);
      p[axis] = -p[axis];
      mirror.set(v, (id = m.addVert(p, [[v, 1]], m.sel[v])));
    }
    return id;
  };
  for (const f of kept) {
    const copy: EFace = { ...f, verts: f.verts.map(mv), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined, cnormals: undefined };
    flipFace(copy);
    out.push(copy);
  }
  m.faces = out;
  for (const v of cuts.values()) m.sel[v] = 1;
  m.compact();
  return true;
}
