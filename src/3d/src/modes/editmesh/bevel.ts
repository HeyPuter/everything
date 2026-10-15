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

/**
 * Rounded corner where three beveled edges meet: quads around a centre vertex (2 segments), a ring
 * of quads around a centre triangle (3 segments), or a triangle fan for more segments.
 */
function cornerPatch(m: MeshEdit, v: number, ringIn: number[], corners: Set<number>, rows: number[][], segs: number): EFace[] {
  // start the ring at a face corner
  const k0 = ringIn.findIndex((x) => corners.has(x));
  const ring = [...ringIn.slice(k0), ...ringIn.slice(0, k0)];
  const P = (i: number) => V(m.p(i));
  const cen = ring.reduce((a, i) => a.add(P(i)), new Vector3()).multiplyScalar(1 / ring.length);
  // how far the profile bulges towards the old vertex (from the middle of the first row)
  const row = rows[0];
  const chordMid = P(row[0]).lerp(P(row[row.length - 1]), 0.5);
  const mid = P(row[Math.floor(row.length / 2)]);
  const toV = P(v).sub(chordMid);
  const bulge = toV.lengthSq() > 1e-20 ? Math.max(0, Math.min(1, mid.clone().sub(chordMid).dot(toV) / toV.lengthSq())) : 0;
  const inner = (p: Vector3) => p.clone().lerp(P(v), bulge * 0.5);
  const out: EFace[] = [];
  const face = (vs: number[]) => {
    const f = m.makeFace(vs, m.faces[0]);
    orientAway(m, f, v);
    out.push(f);
  };
  const n = ring.length;
  const at = (i: number) => ring[((i % n) + n) % n];
  if (segs === 2) {
    const c = inner(cen);
    const ci = m.addVert([c.x, c.y, c.z], [[v, 1]], 1);
    for (let i = 0; i < 3; i++) face([at(2 * i), at(2 * i + 1), ci, at(2 * i - 1)]);
    return out;
  }
  if (segs === 3) {
    // one inner vertex per corner, a third of the way to the centre
    const p = [0, 1, 2].map((i) => {
      const q = inner(P(at(3 * i)).lerp(cen, 2 / 3));
      return m.addVert([q.x, q.y, q.z], [[v, 1]], 1);
    });
    for (let i = 0; i < 3; i++) {
      face([at(3 * i), at(3 * i + 1), p[i], at(3 * i - 1)]);
      face([at(3 * i + 1), at(3 * i + 2), p[(i + 1) % 3], p[i]]);
    }
    face([p[0], p[1], p[2]]);
    return out;
  }
  const c = inner(cen);
  const ci = m.addVert([c.x, c.y, c.z], [[v, 1]], 1);
  for (let i = 0; i < n; i++) face([at(i), at(i + 1), ci]);
  return out;
}

/** Chamfer selected vertices: each is replaced by a polygon through points on its edges. */
export function bevelVertices(m: MeshEdit, offset: number, segments = 1, profile = 0.5): boolean {
  const verts = m.selectedVerts();
  if (!verts.length || offset <= 0) return false;
  const vf = m.vertexFaces();
  const nb = m.neighbors();
  const segs = Math.max(1, Math.round(segments));
  // cut vertex → the beveled vertex it was cut for (a neighbour beveled earlier shows up as its cut vertex)
  const owner = new Map<number, number>();
  for (const v of verts) {
    const cut = new Map<number, number>();
    for (const w of nb[v]) {
      const len = V(m.p(v)).distanceTo(V(m.p(w)));
      const t = Math.min(0.49, offset / Math.max(len, 1e-9));
      const p = V(m.p(v)).lerp(V(m.p(w)), t);
      const id = m.addVert([p.x, p.y, p.z], [[v, 1 - t], [w, t]], 1);
      cut.set(w, id);
      owner.set(id, v);
    }
    const rows: number[][] = [];
    for (const fi of vf[v]) {
      const f = m.faces[fi];
      const n = f.verts.length,
        i = f.verts.indexOf(v);
      if (i < 0) continue;
      const prev = f.verts[(i - 1 + n) % n],
        next = f.verts[(i + 1) % n];
      // the cut across this face's corner: straight, or curved with intermediate points
      const a = cut.get(prev) ?? cut.get(owner.get(prev)!)!,
        b = cut.get(next) ?? cut.get(owner.get(next)!)!;
      const row = [a];
      if (segs > 1) {
        const pa = V(m.p(a)),
          pb = V(m.p(b));
        const ctrl = pa.clone().lerp(pb, 0.5).lerp(V(m.p(v)), Math.min(1, profile * 2));
        for (let k = 1; k < segs; k++) {
          const t = k / segs;
          const q = pa.clone().multiplyScalar((1 - t) * (1 - t)).add(ctrl.clone().multiplyScalar(2 * (1 - t) * t)).add(pb.clone().multiplyScalar(t * t));
          row.push(m.addVert([q.x, q.y, q.z], [[v, 1]], 1));
        }
      }
      row.push(b);
      rows.push(row);
      const uv = [f.uvs[i * 2], f.uvs[i * 2 + 1]];
      const k = row.length;
      f.verts.splice(i, 1, ...row);
      f.uvs.splice(i * 2, 2, ...row.flatMap(() => uv));
      f.seams.splice(i, 1, ...new Array(k - 1).fill(0), f.seams[i]);
      f.sharp.splice(i, 1, ...new Array(k - 1).fill(0), f.sharp[i]);
      f.creases.splice(i, 1, ...new Array(k - 1).fill(0), f.creases[i]);
      if (f.colors) f.colors.splice(i * 4, 4, ...row.flatMap(() => f.colors!.slice(i * 4, i * 4 + 4)));
    }
    const ids = new Set<number>(cut.values());
    for (const r of rows) r.forEach((x) => ids.add(x));
    const ring = orderAround(m, v, [...ids]);
    const corners = new Set(cut.values());
    if (segs >= 2 && corners.size === 3 && ring.length === 3 * segs && rows.length === 3) m.faces.push(...cornerPatch(m, v, ring, corners, rows, segs));
    else if (ring.length >= 3) {
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
  /** what the amount measures (default: offset of the new edges from the old one, along the faces) */
  offsetType?: 'OFFSET' | 'WIDTH' | 'DEPTH' | 'PERCENT' | 'ABSOLUTE';
  /** keep the faces next to the bevel flat-shaded with custom normals and shade the bevel smoothly */
  harden?: boolean;
}

/** Convert a width / depth / percentage amount to the offset along the faces (averaged over the selection). */
export function bevelOffsetFrom(m: MeshEdit, amount: number, type: BevelOptions['offsetType']): number {
  if (!type || type === 'OFFSET' || type === 'ABSOLUTE') return amount;
  const sel = m.selectedEdges();
  const ef = m.edgeFaces();
  if (type === 'PERCENT') {
    // percentage of the unselected edges leaving the beveled vertices
    const selKeys = new Set(sel.map(([a, b]) => edgeKey(a, b)));
    const verts = new Set(sel.flat());
    let sum = 0,
      n = 0;
    for (const [a, b] of m.edges())
      if (!selKeys.has(edgeKey(a, b)) && (verts.has(a) || verts.has(b))) {
        sum += V(m.p(a)).distanceTo(V(m.p(b)));
        n++;
      }
    return n ? (amount / 100) * (sum / n) : 0;
  }
  // interior angle between the faces of each beveled edge
  let sum = 0,
    n = 0;
  for (const [a, b] of sel) {
    const l = ef.get(edgeKey(a, b));
    if (!l || l.length !== 2) continue;
    sum += Math.PI - V(m.faceNormal(m.faces[l[0][0]])).angleTo(V(m.faceNormal(m.faces[l[1][0]])));
    n++;
  }
  const phi = n ? sum / n : Math.PI / 2;
  return type === 'WIDTH' ? amount / Math.max(1e-6, 2 * Math.sin(phi / 2)) : amount / Math.max(1e-6, Math.cos(phi / 2));
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
  offset = bevelOffsetFrom(m, offset, opts.offsetType);
  if (opts.clamp) offset = Math.min(offset, bevelClampLimit(m));
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!sel.size || offset <= 0) return false;
  const ef = m.edgeFaces();
  const faces0 = m.faces.map((f) => [...f.verts]);
  const corner = new Map<string, number>(); // `${face}:${vertex}` -> new vertex id
  // a corner that slides along an unbeveled edge is shared by the faces on both sides of that edge
  const along = new Map<string, number>(); // `${vertex}>${neighbour}` -> new vertex id
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
        const dir = bPrev ? dNext : dPrev;
        const other = bPrev ? dPrev : dNext;
        const sinA = Math.max(0.05, Math.abs(Math.sin(dir.angleTo(other))));
        // absolute: the amount is measured along the adjacent edge itself
        target = p.clone().addScaledVector(dir.clone().normalize(), Math.min(dir.length() * 0.95, opts.offsetType === 'ABSOLUTE' ? offset : offset / sinA));
        const key = `${v}>${bPrev ? next : prev}`;
        const shared = along.get(key);
        if (shared !== undefined) {
          corner.set(`${fi}:${v}`, shared);
          continue;
        }
        const id = m.addVert([target.x, target.y, target.z], [[v, 1]], 1);
        along.set(key, id);
        corner.set(`${fi}:${v}`, id);
        continue;
      }
      corner.set(`${fi}:${v}`, m.addVert([target.x, target.y, target.z], [[v, 1]], 1));
    }
  });
  const added: EFace[] = [];
  const segs = Math.max(1, segments);
  // strips meeting at a corner with the same two ends share their profile
  const profiles = new Map<string, number[]>();
  const rowVerts = (x: number, y: number, orig: number): number[] => {
    const known = profiles.get(`${x}:${y}:${orig}`) ?? profiles.get(`${y}:${x}:${orig}`)?.slice().reverse();
    if (known) return known;
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
    profiles.set(`${x}:${y}:${orig}`, rows);
    return rows;
  };
  // strips
  const junction = new Map<number, number[][]>(); // vertex -> rows meeting there
  const strips: { face: EFace; A: EFace; B: EFace }[] = [];
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
      if (opts.harden) strips.push({ face: strip, A, B: m.faces[fb] });
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
        else if (rep.length === 2) {
          // the bevel profile between the two corners runs through this face's corner too
          const row = (junction.get(v) ?? []).find((r) => (r[0] === rep[0] && r[r.length - 1] === rep[1]) || (r[0] === rep[1] && r[r.length - 1] === rep[0]));
          if (row) rep = row[0] === rep[0] ? [...row] : [...row].reverse();
        }
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
    const rows = junction.get(v) ?? [];
    // rows that are one shared profile leave no gap to close
    const distinct = new Set(rows.map((r) => [...r].sort((a, b) => a - b).join(','))).size;
    if (ids.size >= 3 && rows.length >= 2 && distinct >= 2) {
      const ring = orderAround(m, v, [...ids]);
      const corners = new Set<number>();
      faces0.forEach((verts, fi) => {
        const c = verts.includes(v) ? corner.get(`${fi}:${v}`) : undefined;
        if (c !== undefined) corners.add(c);
      });
      if (segs >= 2 && rows.length === 3 && ring.length === 3 * segs && corners.size === 3) added.push(...cornerPatch(m, v, ring, corners, rows, segs));
      else {
        const cap = m.makeFace(ring, m.faces[0]);
        orientAway(m, cap, v);
        added.push(cap);
      }
    }
  }
  m.faces.push(...added);
  for (const v of touched) m.sel[v] = 0;
  m.compact();
  const saved = m.sel.slice();
  m.sel = m.sel.map(() => 1);
  makeNormalsConsistent(m, false, false);
  m.sel = saved;
  if (opts.harden && strips.length) hardenNormals(m, strips);
  return true;
}

/** Flat custom normals on the faces beside the bevel; the bevel blends between them. */
function hardenNormals(m: MeshEdit, strips: { face: EFace; A: EFace; B: EFace }[]) {
  const stripSet = new Set(strips.map((s) => s.face));
  const avg = new Map<number, Vector3>();
  for (const f of stripSet) {
    const n = V(m.faceNormal(f));
    for (const v of f.verts) (avg.get(v) ?? avg.set(v, new Vector3()).get(v)!).add(n);
  }
  const flat = (f: EFace) => {
    const n = m.faceNormal(f);
    f.cnormals = f.verts.flatMap(() => n);
  };
  for (const s of strips) {
    flat(s.A);
    flat(s.B);
  }
  for (const s of strips) {
    const f = s.face;
    f.smooth = true;
    f.cnormals = f.verts.flatMap((v) => {
      if (s.A.verts.includes(v)) return m.faceNormal(s.A);
      if (s.B.verts.includes(v)) return m.faceNormal(s.B);
      const n = (avg.get(v) ?? new Vector3(0, 0, 1)).clone().normalize();
      return [n.x, n.y, n.z];
    });
  }
}
