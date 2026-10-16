// Inset / outset of selected faces: a ring of new faces between the outline of each region (or of
// each face) and a copy of that outline offset across the surface.
import { Vector3 } from 'three';
import { MeshEdit, edgeKey } from './meshedit';
import { V } from './geom';

export interface InsetOptions {
  /** keep the offset distance constant at corners (miter) */
  even?: boolean;
  /** scale the offset by the length of the edges around each vertex */
  relative?: boolean;
  /** also inset along open mesh boundaries (otherwise boundary edges stay where they are) */
  boundary?: boolean;
  /** slide new vertices along existing edges inside the region */
  edgeRail?: boolean;
}

interface RingEdge {
  a: number;
  b: number;
  face: number;
  corner: number;
}

/**
 * Inset the selected faces by `thickness`, raising the inner faces by `depth`. With `outset`
 * the ring grows outwards over the neighbouring faces instead and the selected faces keep their
 * outline. Returns false when no face is selected.
 */
export function insetFaces(m: MeshEdit, thickness: number, depth: number, individual: boolean, outset = false, opts: InsetOptions = {}): boolean {
  const fsel = m.selectedFaces();
  if (!fsel.length) return false;
  const even = opts.even !== false;
  const useBoundary = opts.boundary !== false;
  const groups = individual ? fsel.map((f) => [f]) : [fsel];
  const meshUse = m.edgeFaces();
  const selected = new Set(fsel);
  const keepSel: number[] = [];
  for (const group of groups) {
    const inGroup = new Set(group);
    const count = new Map<string, number>();
    for (const fi of group) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    // outline edges of the region; open mesh boundaries are skipped unless asked for
    const ring: RingEdge[] = [];
    const held = new Set<string>();
    for (const fi of group) {
      const f = m.faces[fi];
      const n = f.verts.length;
      for (let i = 0; i < n; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % n];
        const k = edgeKey(a, b);
        if (count.get(k) !== 1) continue;
        if (!individual && (!useBoundary || outset) && (meshUse.get(k)?.length ?? 0) === 1) {
          held.add(k);
          continue;
        }
        ring.push({ a, b, face: fi, corner: i });
      }
    }
    if (!ring.length) continue;
    // direction (unit, across the surface) each outline edge moves in
    const dirs = new Map<number, Vector3[]>();
    const push = (v: number, d: Vector3) => (dirs.get(v) ?? dirs.set(v, []).get(v)!).push(d);
    for (const r of ring) {
      const along = V(m.p(r.b)).sub(V(m.p(r.a))).normalize();
      let into: Vector3;
      if (!outset) into = V(m.faceNormal(m.faces[r.face])).cross(along).normalize();
      else {
        // grow into the face on the other side of the edge (or outwards in the face plane at an open edge)
        const other = (meshUse.get(edgeKey(r.a, r.b)) ?? []).find(([g]) => !inGroup.has(g));
        if (other) {
          const g = m.faces[other[0]];
          const ga = g.verts[other[1]],
            gb = g.verts[(other[1] + 1) % g.verts.length];
          const gd = V(m.p(gb)).sub(V(m.p(ga))).normalize();
          into = V(m.faceNormal(g)).cross(gd).normalize();
        } else into = V(m.faceNormal(m.faces[r.face])).cross(along).normalize().negate();
      }
      push(r.a, into);
      push(r.b, into);
    }
    /** average length of the region edges around a vertex (relative offsets) */
    const relScale = (v: number) => {
      let sum = 0,
        cnt = 0;
      for (const fi of group) {
        const f = m.faces[fi];
        const i = f.verts.indexOf(v);
        if (i < 0) continue;
        const n = f.verts.length;
        sum += V(m.p(v)).distanceTo(V(m.p(f.verts[(i + 1) % n]))) + V(m.p(v)).distanceTo(V(m.p(f.verts[(i + n - 1) % n])));
        cnt += 2;
      }
      return cnt ? sum / cnt : 1;
    };
    const depthScale = new Map<number, number>();
    if (depth && opts.relative) for (const fi of group) for (const v of m.faces[fi].verts) depthScale.set(v, relScale(v));
    // per-vertex offset
    const offset = new Map<number, Vector3>();
    for (const [v, ds] of dirs) {
      const t = thickness * (opts.relative ? relScale(v) : 1);
      let o: Vector3;
      if (ds.length === 1) {
        // the outline ends here (next to an untouched boundary edge): slide along that edge
        const d = ds[0];
        const slide = slideEdge(m, v, held, d);
        o = slide ? slide.multiplyScalar(even ? t / Math.max(0.05, slide.dot(d)) : t) : d.clone().multiplyScalar(t);
      } else {
        const sum = ds.reduce((acc, d) => acc.add(d), new Vector3());
        const dir = sum.clone().normalize();
        // miter: every adjacent outline edge ends up `t` away
        const cosHalf = ds.length === 2 ? Math.max(0.05, sum.length() / 2) : 1;
        o = dir.multiplyScalar(even ? t / cosHalf : t);
      }
      if (opts.edgeRail) {
        const rail = railEdge(m, v, group, inGroup, count, o, outset, meshUse);
        if (rail) o = rail;
      }
      offset.set(v, o);
    }
    // new outline vertices
    const map = new Map<number, number>();
    const origin = new Map<number, number>();
    for (const [v, o] of offset) {
      const p = V(m.p(v)).add(o);
      const nv = m.addVert([p.x, p.y, p.z], [[v, 1]], outset ? 0 : 1);
      map.set(v, nv);
      origin.set(nv, v);
    }
    if (!outset) {
      for (const r of ring) {
        const f = m.faces[r.face];
        const n = f.verts.length;
        const uvA = [f.uvs[r.corner * 2], f.uvs[r.corner * 2 + 1]],
          uvB = [f.uvs[((r.corner + 1) % n) * 2], f.uvs[((r.corner + 1) % n) * 2 + 1]];
        const nf = m.makeFace([r.a, r.b, map.get(r.b)!, map.get(r.a)!], f, [...uvA, ...uvB, ...uvB, ...uvA]);
        nf.seams[0] = f.seams[r.corner];
        nf.sharp[0] = f.sharp[r.corner];
        nf.creases[0] = f.creases[r.corner];
        m.faces.push(nf);
      }
      for (const fi of group) m.faces[fi].verts = m.faces[fi].verts.map((v) => map.get(v) ?? v);
    } else {
      // neighbours move onto the new outline, the selected faces keep theirs
      const ringFaces = ring.map((r) => {
        const f = m.faces[r.face];
        const n = f.verts.length;
        const uvA = [f.uvs[r.corner * 2], f.uvs[r.corner * 2 + 1]],
          uvB = [f.uvs[((r.corner + 1) % n) * 2], f.uvs[((r.corner + 1) % n) * 2 + 1]];
        return m.makeFace([r.b, r.a, map.get(r.a)!, map.get(r.b)!], f, [...uvB, ...uvA, ...uvA, ...uvB]);
      });
      m.faces.forEach((f, fi) => {
        if (!inGroup.has(fi) && !(individual && selected.has(fi))) f.verts = f.verts.map((v) => map.get(v) ?? v);
      });
      m.faces.push(...ringFaces);
    }
    // raise the inner faces
    if (depth) raise(m, group, depth, individual, even, (v) => depthScale.get(v) ?? depthScale.get(origin.get(v) ?? -1) ?? 1);
    for (const v of map.keys()) if (!outset) m.sel[v] = 0;
    for (const fi of group) keepSel.push(fi);
  }
  for (const fi of keepSel) for (const v of m.faces[fi].verts) m.sel[v] = 1;
  return true;
}

/** Direction (unit) along an untouched boundary edge at `v` that leads into the region side of `d`. */
function slideEdge(m: MeshEdit, v: number, held: Set<string>, d: Vector3): Vector3 | null {
  let best: Vector3 | null = null;
  for (const k of held) {
    const [a, b] = k.split(':').map(Number);
    if (a !== v && b !== v) continue;
    const o = a === v ? b : a;
    const s = V(m.p(o)).sub(V(m.p(v))).normalize();
    if (s.dot(d) > 1e-6 && (!best || s.dot(d) > best.dot(d))) best = s;
  }
  return best;
}

/** Offset `o` moved onto the edge inside the region that best matches it, keeping the same spread. */
function railEdge(m: MeshEdit, v: number, group: number[], inGroup: Set<number>, count: Map<string, number>, o: Vector3, outset: boolean, meshUse: Map<string, [number, number][]>): Vector3 | null {
  const len = o.length();
  if (len < 1e-12) return null;
  const dir = o.clone().normalize();
  let best: Vector3 | null = null;
  const consider = (k: string) => {
    const [a, b] = k.split(':').map(Number);
    if (a !== v && b !== v) return;
    const s = V(m.p(a === v ? b : a)).sub(V(m.p(v))).normalize();
    if (s.dot(dir) > 0.05 && (!best || s.dot(dir) > best.dot(dir))) best = s;
  };
  if (!outset) {
    for (const [k, c] of count) if (c === 2) consider(k);
  } else {
    for (const [k, l] of meshUse) if (l.every(([fi]) => !inGroup.has(fi))) consider(k);
  }
  void group;
  if (!best) return null;
  const r = best as Vector3;
  return r.multiplyScalar(len / r.dot(dir));
}

/** Move the region faces along their normals; `even` keeps the shell thickness constant at creases. */
function raise(m: MeshEdit, group: number[], depth: number, individual: boolean, even: boolean, scale: (v: number) => number) {
  if (individual) {
    for (const fi of group) {
      const f = m.faces[fi];
      const n = V(m.faceNormal(f));
      for (const v of f.verts) m.setP(v, V(m.p(v)).addScaledVector(n, depth * scale(v)).toArray());
    }
    return;
  }
  const normals = new Map<number, Vector3>();
  const faceNs = new Map<number, Vector3[]>();
  for (const fi of group) {
    const f = m.faces[fi];
    const n = V(m.faceNormal(f));
    for (const v of f.verts) {
      (normals.get(v) ?? normals.set(v, new Vector3()).get(v)!).add(n);
      (faceNs.get(v) ?? faceNs.set(v, []).get(v)!).push(n);
    }
  }
  for (const [v, n] of normals) {
    n.normalize();
    let s = 1;
    if (even) {
      const fs = faceNs.get(v)!;
      const c = fs.reduce((acc, f) => acc + f.dot(n), 0) / fs.length;
      s = 1 / Math.max(0.1, c);
    }
    m.setP(v, V(m.p(v)).addScaledVector(n, depth * s * scale(v)).toArray());
  }
}
