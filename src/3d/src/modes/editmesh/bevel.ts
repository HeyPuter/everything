// Edge and vertex bevel for polygon meshes (independent implementation).
import { Vector3 } from 'three';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { flipFace, makeNormalsConsistent } from './ops-basic';

const V = (a: number[]) => new Vector3(a[0], a[1], a[2]);

function orderAround(m: MeshEdit, v: number, ids: number[]): number[] {
  const cen = ids.reduce((a, id) => a.add(V(m.p(id))), new Vector3()).multiplyScalar(1 / ids.length);
  const n = V(m.p(v)).sub(cen);
  if (n.lengthSq() < 1e-16) n.set(0, 0, 1);
  n.normalize();
  const u = (Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).cross(n).normalize();
  const w = n.clone().cross(u);
  return [...ids].sort((a, b) => {
    const pa = V(m.p(a)).sub(cen),
      pb = V(m.p(b)).sub(cen);
    return Math.atan2(pa.dot(w), pa.dot(u)) - Math.atan2(pb.dot(w), pb.dot(u));
  });
}

function orientAway(m: MeshEdit, f: EFace, from: number) {
  const n = V(m.faceNormal(f));
  const cen = V(m.faceCenter(f));
  if (n.dot(V(m.p(from)).sub(cen)) < 0) flipFace(f);
}

/** Chamfer selected vertices: each is replaced by a polygon through points on its edges. */
export function bevelVertices(m: MeshEdit, offset: number): boolean {
  const verts = m.selectedVerts();
  if (!verts.length || offset <= 0) return false;
  const vf = m.vertexFaces();
  const nb = m.neighbors();
  for (const v of verts) {
    const cut = new Map<number, number>();
    for (const w of nb[v]) {
      const len = V(m.p(v)).distanceTo(V(m.p(w)));
      const t = Math.min(0.49, offset / Math.max(len, 1e-9));
      const p = V(m.p(v)).lerp(V(m.p(w)), t);
      cut.set(w, m.addVert([p.x, p.y, p.z], [[v, 1 - t], [w, t]], 1));
    }
    for (const fi of vf[v]) {
      const f = m.faces[fi];
      const n = f.verts.length,
        i = f.verts.indexOf(v);
      if (i < 0) continue;
      const prev = f.verts[(i - 1 + n) % n],
        next = f.verts[(i + 1) % n];
      const uv = [f.uvs[i * 2], f.uvs[i * 2 + 1]];
      f.verts.splice(i, 1, cut.get(prev)!, cut.get(next)!);
      f.uvs.splice(i * 2, 2, ...uv, ...uv);
      f.seams.splice(i, 1, 0, f.seams[i]);
      f.sharp.splice(i, 1, 0, f.sharp[i]);
      f.creases.splice(i, 1, 0, f.creases[i]);
      if (f.colors) f.colors.splice(i * 4, 4, ...f.colors.slice(i * 4, i * 4 + 4), ...f.colors.slice(i * 4, i * 4 + 4));
    }
    const ring = orderAround(m, v, [...cut.values()]);
    if (ring.length >= 3) {
      const cap = m.makeFace(ring, vf[v].length ? m.faces[vf[v][0]] : undefined);
      orientAway(m, cap, v);
      m.faces.push(cap);
    }
    m.sel[v] = 0;
  }
  m.compact();
  return true;
}

/**
 * Edge bevel: faces adjacent to beveled edges are pulled back by `offset`, a strip of
 * `segments` rows (profile-curved) replaces each edge, and vertex junctions are closed.
 */
export interface BevelOptions {
  /** mark the bevel's outer edges as seams / sharp */
  markSeam?: boolean;
  markSharp?: boolean;
  /** limit the width so neighbouring bevels don't overlap */
  clamp?: boolean;
}

/** Largest width that keeps the corners of neighbouring bevels from crossing. */
export function bevelClampLimit(m: MeshEdit): number {
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  const verts = new Set<number>();
  for (const k of sel) k.split(':').forEach((x) => verts.add(Number(x)));
  let limit = Infinity;
  for (const [a, b] of m.edges()) {
    if (sel.has(edgeKey(a, b)) || (!verts.has(a) && !verts.has(b))) continue;
    const len = V(m.p(a)).distanceTo(V(m.p(b)));
    limit = Math.min(limit, verts.has(a) && verts.has(b) ? len / 2 : len);
  }
  return limit;
}

export function bevelEdges(m: MeshEdit, offset: number, segments: number, profile = 0.5, opts: BevelOptions = {}): boolean {
  if (opts.clamp) offset = Math.min(offset, bevelClampLimit(m));
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!sel.size || offset <= 0) return false;
  const ef = m.edgeFaces();
  const faces0 = m.faces.map((f) => [...f.verts]);
  const corner = new Map<string, number>(); // `${face}:${vertex}` -> new vertex id
  faces0.forEach((verts, fi) => {
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const v = verts[i],
        prev = verts[(i - 1 + n) % n],
        next = verts[(i + 1) % n];
      const bPrev = sel.has(edgeKey(prev, v)),
        bNext = sel.has(edgeKey(v, next));
      if (!bPrev && !bNext) continue;
      const p = V(m.p(v));
      const dPrev = V(m.p(prev)).sub(p),
        dNext = V(m.p(next)).sub(p);
      let target: Vector3;
      if (bPrev && bNext) {
        const a = dPrev.clone().normalize(),
          b = dNext.clone().normalize();
        const bis = a.clone().add(b);
        if (bis.lengthSq() < 1e-12) bis.copy(V(m.faceNormal(m.faces[fi])).cross(a));
        bis.normalize();
        const sinHalf = Math.max(0.05, Math.sin(a.angleTo(b) / 2));
        target = p.clone().addScaledVector(bis, offset / sinHalf);
      } else {
        const along = bPrev ? dNext : dPrev;
        const other = bPrev ? dPrev : dNext;
        const sinA = Math.max(0.05, Math.abs(Math.sin(along.angleTo(other))));
        target = p.clone().addScaledVector(along.clone().normalize(), Math.min(along.length() * 0.95, offset / sinA));
      }
      corner.set(`${fi}:${v}`, m.addVert([target.x, target.y, target.z], [[v, 1]], 1));
    }
  });
  const added: EFace[] = [];
  const segs = Math.max(1, segments);
  const rowVerts = (x: number, y: number, orig: number): number[] => {
    const rows = [x];
    const p0 = V(m.p(x)),
      p1 = V(m.p(y)),
      o = V(m.p(orig));
    const ctrl = p0.clone().lerp(p1, 0.5).lerp(o, Math.min(1, profile * 2));
    for (let s = 1; s < segs; s++) {
      const t = s / segs;
      const q = p0
        .clone()
        .multiplyScalar((1 - t) * (1 - t))
        .add(ctrl.clone().multiplyScalar(2 * (1 - t) * t))
        .add(p1.clone().multiplyScalar(t * t));
      rows.push(m.addVert([q.x, q.y, q.z], [[orig, 1]], 1));
    }
    rows.push(y);
    return rows;
  };
  // strips
  const junction = new Map<number, number[][]>(); // vertex -> rows meeting there
  for (const k of sel) {
    const l = ef.get(k);
    if (!l || l.length !== 2) continue;
    const [fa, ia] = l[0],
      [fb] = l[1];
    const A = m.faces[fa];
    const a = faces0[fa][ia],
      b = faces0[fa][(ia + 1) % faces0[fa].length];
    const a1 = corner.get(`${fa}:${a}`),
      b1 = corner.get(`${fa}:${b}`),
      a2 = corner.get(`${fb}:${a}`),
      b2 = corner.get(`${fb}:${b}`);
    if (a1 === undefined || b1 === undefined || a2 === undefined || b2 === undefined) continue;
    const ra = rowVerts(a1, a2, a),
      rb = rowVerts(b1, b2, b);
    for (let s = 0; s < segs; s++) {
      const strip = m.makeFace([rb[s], ra[s], ra[s + 1], rb[s + 1]], A);
      // the strip's outer edges border the original faces
      for (const [flag, on] of [['seams', opts.markSeam], ['sharp', opts.markSharp]] as const)
        if (on) {
          if (s === 0) strip[flag][0] = 1;
          if (s === segs - 1) strip[flag][2] = 1;
        }
      added.push(strip);
    }
    (junction.get(a) ?? junction.set(a, []).get(a)!).push(ra);
    (junction.get(b) ?? junction.set(b, []).get(b)!).push(rb);
  }
  // rewrite faces: adjacent faces use their new corners; other faces around a beveled vertex
  // replace it with the new corners of the faces across their two edges at that vertex
  const touched = new Set<number>();
  for (const k of sel) k.split(':').forEach((x) => touched.add(Number(x)));
  const otherFace = (fi: number, a: number, b: number) => (ef.get(edgeKey(a, b)) ?? []).map(([g]) => g).find((g) => g !== fi);
  m.faces.forEach((f, fi) => {
    const src = faces0[fi];
    const n = src.length;
    const verts: number[] = [],
      uvs: number[] = [],
      seams: number[] = [],
      sharp: number[] = [],
      creases: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = src[i];
      const own = corner.get(`${fi}:${v}`);
      let rep: number[];
      if (own !== undefined) rep = [own];
      else if (touched.has(v)) {
        const prev = src[(i - 1 + n) % n],
          next = src[(i + 1) % n];
        const g1 = otherFace(fi, prev, v),
          g2 = otherFace(fi, v, next);
        const c1 = g1 !== undefined ? corner.get(`${g1}:${v}`) : undefined,
          c2 = g2 !== undefined ? corner.get(`${g2}:${v}`) : undefined;
        rep = [c1, c2].filter((x): x is number => x !== undefined);
        if (rep.length === 2 && rep[0] === rep[1]) rep = [rep[0]];
        if (!rep.length) rep = [v];
      } else rep = [v];
      for (const r of rep) {
        verts.push(r);
        uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
        seams.push(r === rep[rep.length - 1] ? f.seams[i] : 0);
        sharp.push(r === rep[rep.length - 1] ? f.sharp[i] : 0);
        creases.push(r === rep[rep.length - 1] ? f.creases[i] : 0);
      }
    }
    f.verts = verts;
    f.uvs = uvs;
    f.seams = seams;
    f.sharp = sharp;
    f.creases = creases;
    f.colors = undefined;
  });
  // close junctions where the original vertex vanished: polygon through all new corners/rows there
  for (const v of touched) {
    const stillUsed = m.faces.some((f) => f.verts.includes(v)) || added.some((f) => f.verts.includes(v));
    if (stillUsed) continue;
    const ids = new Set<number>();
    faces0.forEach((verts, fi) => {
      if (!verts.includes(v)) return;
      const c = corner.get(`${fi}:${v}`);
      if (c !== undefined) ids.add(c);
    });
    for (const rows of junction.get(v) ?? []) rows.forEach((r) => ids.add(r));
    if (ids.size >= 3 && (junction.get(v)?.length ?? 0) >= 2) {
      const cap = m.makeFace(orderAround(m, v, [...ids]), m.faces[0]);
      orientAway(m, cap, v);
      added.push(cap);
    }
  }
  m.faces.push(...added);
  for (const v of touched) m.sel[v] = 0;
  m.compact();
  const saved = m.sel.slice();
  m.sel = m.sel.map(() => 1);
  makeNormalsConsistent(m, false, false);
  m.sel = saved;
  return true;
}
