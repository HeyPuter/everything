// Small shared geometry helpers for Edit Mode mesh tools working on MeshEdit.
import { Vector3 } from 'three';
import { MeshEdit, edgeKey, type EFace } from './meshedit';

export const V = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

/** Edge keys of a face, in corner order. */
export function faceEdgeKeys(f: EFace): string[] {
  const n = f.verts.length;
  return f.verts.map((v, i) => edgeKey(v, f.verts[(i + 1) % n]));
}

/** How many faces of `faces` use each edge (boundary edges of the region have count 1). */
export function edgeUseCount(m: MeshEdit, faces: Iterable<number>): Map<string, number> {
  const count = new Map<string, number>();
  for (const fi of faces) for (const k of faceEdgeKeys(m.faces[fi])) count.set(k, (count.get(k) ?? 0) + 1);
  return count;
}

/** Per-vertex normal from the given faces only (normalized; vertices not on them are absent). */
export function vertexNormalsFromFaces(m: MeshEdit, faces: Iterable<number>): Map<number, Vector3> {
  const out = new Map<number, Vector3>();
  for (const fi of faces) {
    const f = m.faces[fi];
    const n = V(m.faceNormal(f));
    for (const v of f.verts) {
      const cur = out.get(v);
      if (cur) cur.add(n);
      else out.set(v, n.clone());
    }
  }
  for (const n of out.values()) if (n.lengthSq() > 1e-20) n.normalize();
  return out;
}

/** Vertex normals over all faces (area weighted by the unnormalized Newell normal). */
export function vertexNormals(m: MeshEdit): Vector3[] {
  const out = Array.from({ length: m.vcount }, () => new Vector3());
  for (const f of m.faces) {
    const n = V(m.faceNormal(f));
    for (const v of f.verts) out[v].add(n);
  }
  for (const n of out) if (n.lengthSq() > 1e-20) n.normalize();
  return out;
}

/** The part of a face from corner `from` to corner `to` (inclusive, wrapping), as a new face. */
function slice(f: EFace, from: number, to: number) {
  const n = f.verts.length;
  const verts: number[] = [],
    uvs: number[] = [],
    seams: number[] = [],
    sharp: number[] = [],
    creases: number[] = [],
    colors: number[] = [],
    cn: number[] = [];
  for (let k = from; ; k = (k + 1) % n) {
    verts.push(f.verts[k]);
    uvs.push(f.uvs[k * 2], f.uvs[k * 2 + 1]);
    // the closing edge (to → from) is new and carries no flags
    const last = k === to;
    seams.push(last ? 0 : f.seams[k]);
    sharp.push(last ? 0 : f.sharp[k]);
    creases.push(last ? 0 : f.creases[k]);
    if (f.colors) colors.push(...f.colors.slice(k * 4, k * 4 + 4));
    if (f.cnormals) cn.push(...f.cnormals.slice(k * 3, k * 3 + 3));
    if (last) break;
  }
  return { ...f, verts, uvs, seams, sharp, creases, colors: f.colors ? colors : undefined, cnormals: f.cnormals ? cn : undefined };
}

/** Split face `fi` by connecting its corners `i` and `j` (not adjacent). Returns the index of the new face. */
export function splitFace(m: MeshEdit, fi: number, i: number, j: number): number {
  const f = m.faces[fi];
  const a = slice(f, i, j),
    b = slice(f, j, i);
  m.faces[fi] = a;
  m.faces.push(b);
  return m.faces.length - 1;
}

/** Remove corner `i` from a face. */
export function removeCorner(f: EFace, i: number) {
  f.verts.splice(i, 1);
  f.uvs.splice(i * 2, 2);
  f.seams.splice(i, 1);
  f.sharp.splice(i, 1);
  f.creases.splice(i, 1);
  if (f.colors) f.colors.splice(i * 4, 4);
  if (f.cnormals) f.cnormals.splice(i * 3, 3);
}

/** Insert a vertex into every face edge (a,b) at parameter t from a. */
export function insertVertexOnEdge(m: MeshEdit, a: number, b: number, v: number, t: number) {
  for (const f of m.faces) {
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const x = f.verts[i],
        y = f.verts[(i + 1) % n];
      if (!((x === a && y === b) || (x === b && y === a))) continue;
      const tt = x === a ? t : 1 - t;
      const j = (i + 1) % n;
      const uv = [f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * tt, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * tt];
      f.verts.splice(i + 1, 0, v);
      f.uvs.splice((i + 1) * 2, 0, uv[0], uv[1]);
      f.seams.splice(i + 1, 0, f.seams[i]);
      f.sharp.splice(i + 1, 0, f.sharp[i]);
      f.creases.splice(i + 1, 0, f.creases[i]);
      if (f.colors) {
        const c = [0, 1, 2, 3].map((k) => f.colors![i * 4 + k] + (f.colors![j * 4 + k] - f.colors![i * 4 + k]) * tt);
        f.colors.splice((i + 1) * 4, 0, ...c);
      }
      if (f.cnormals) {
        const c = [0, 1, 2].map((k) => f.cnormals![i * 3 + k] + (f.cnormals![j * 3 + k] - f.cnormals![i * 3 + k]) * tt);
        const l = Math.hypot(c[0], c[1], c[2]) || 1;
        f.cnormals.splice((i + 1) * 3, 0, c[0] / l, c[1] / l, c[2] / l);
      }
      break;
    }
  }
  m.looseEdges = m.looseEdges.flatMap(([x, y]) => ((x === a && y === b) || (x === b && y === a) ? [[x, v] as [number, number], [v, y] as [number, number]] : [[x, y] as [number, number]]));
}

/** Add a vertex splitting edge (a,b) at parameter t. */
export function splitEdge(m: MeshEdit, a: number, b: number, t: number, select = 1): number {
  const p = V(m.p(a)).lerp(V(m.p(b)), t);
  const v = m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], select);
  insertVertexOnEdge(m, a, b, v, t);
  return v;
}

/**
 * Dissolve the given edges: the faces they connect are merged into single polygons. Regions whose
 * outline would not be one simple loop are merged edge by edge instead, skipping edges that would
 * produce invalid polygons. Returns the number of dissolved edges.
 */
export function dissolveEdgeSet(m: MeshEdit, keys: Iterable<string>): number {
  const ef = m.edgeFaces();
  const parent = m.faces.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const edges: string[] = [];
  for (const k of keys) {
    const l = ef.get(k);
    if (!l || l.length !== 2 || l[0][0] === l[1][0]) continue;
    const [fa, ca] = l[0],
      [fb, cb] = l[1];
    // opposite winding only (a→b in one face, b→a in the other)
    if (m.faces[fa].verts[ca] === m.faces[fb].verts[cb]) continue;
    edges.push(k);
    parent[find(fa)] = find(fb);
  }
  if (!edges.length) return 0;
  const regions = new Map<number, number[]>();
  m.faces.forEach((_, i) => {
    const r = find(i);
    (regions.get(r) ?? regions.set(r, []).get(r)!).push(i);
  });
  const removed = new Set<number>();
  const added: EFace[] = [];
  const fallback: string[] = [];
  let count = 0;
  const edgeRegion = new Map<string, number>();
  for (const k of edges) edgeRegion.set(k, find(ef.get(k)![0][0]));
  for (const [r, fs] of regions) {
    if (fs.length < 2) continue;
    const own = edges.filter((k) => edgeRegion.get(k) === r);
    // directed outline edges: those not shared inside the region
    const inner = new Set(own);
    const next = new Map<number, [number, number]>(); // vertex → [face, corner] starting the outline edge
    let ok = true;
    for (const fi of fs) {
      const f = m.faces[fi];
      const n = f.verts.length;
      for (let c = 0; c < n; c++) {
        if (inner.has(edgeKey(f.verts[c], f.verts[(c + 1) % n]))) continue;
        if (next.has(f.verts[c])) ok = false;
        next.set(f.verts[c], [fi, c]);
      }
    }
    const loop: [number, number][] = [];
    if (ok && next.size) {
      const start = next.keys().next().value as number;
      let v = start;
      do {
        const fc = next.get(v);
        if (!fc) {
          ok = false;
          break;
        }
        loop.push(fc);
        const f = m.faces[fc[0]];
        v = f.verts[(fc[1] + 1) % f.verts.length];
      } while (v !== start && loop.length <= next.size);
      if (v !== start || loop.length !== next.size) ok = false;
    }
    if (!ok || loop.length < 3) {
      fallback.push(...own);
      continue;
    }
    const tmpl = m.faces[fs[0]];
    const withN = fs.every((fi) => m.faces[fi].cnormals?.length === m.faces[fi].verts.length * 3);
    const nf: EFace = { ...tmpl, verts: [], uvs: [], seams: [], sharp: [], creases: [], colors: tmpl.colors ? [] : undefined, cnormals: withN ? [] : undefined };
    for (const [fi, c] of loop) {
      const f = m.faces[fi];
      nf.verts.push(f.verts[c]);
      nf.uvs.push(f.uvs[c * 2], f.uvs[c * 2 + 1]);
      nf.seams.push(f.seams[c]);
      nf.sharp.push(f.sharp[c]);
      nf.creases.push(f.creases[c]);
      if (nf.colors) nf.colors.push(...(f.colors?.slice(c * 4, c * 4 + 4) ?? [1, 1, 1, 1]));
      if (nf.cnormals) nf.cnormals.push(...f.cnormals!.slice(c * 3, c * 3 + 3));
    }
    for (const fi of fs) removed.add(fi);
    added.push(nf);
    count += own.length;
  }
  if (removed.size) m.faces = m.faces.filter((_, i) => !removed.has(i)).concat(added);
  if (fallback.length) count += dissolveSequential(m, fallback);
  return count;
}

/** Merge faces across the given edges one at a time (fallback for regions with holes). */
function dissolveSequential(m: MeshEdit, keys: Iterable<string>): number {
  const faces: (EFace | null)[] = m.faces.slice();
  const ef = new Map<string, Set<number>>();
  const link = (fi: number) => {
    for (const k of faceEdgeKeys(faces[fi]!)) (ef.get(k) ?? ef.set(k, new Set()).get(k)!).add(fi);
  };
  const unlink = (fi: number) => {
    for (const k of faceEdgeKeys(faces[fi]!)) ef.get(k)?.delete(fi);
  };
  faces.forEach((_, i) => link(i));
  let count = 0;
  for (const k of keys) {
    const l = ef.get(k);
    if (!l || l.size !== 2) continue;
    const [fa, fb] = [...l];
    const A = faces[fa]!,
      B = faces[fb]!;
    const [x, y] = k.split(':').map(Number);
    const na = A.verts.length,
      nb = B.verts.length;
    // A runs a→b, B runs b→a
    let ia = A.verts.indexOf(x);
    let a = x,
      b = y;
    if (A.verts[(ia + 1) % na] !== y) {
      ia = A.verts.indexOf(y);
      a = y;
      b = x;
      if (A.verts[(ia + 1) % na] !== x) continue;
    }
    const jb = B.verts.indexOf(b);
    if (B.verts[(jb + 1) % nb] !== a) continue;
    const verts: number[] = [],
      uvs: number[] = [],
      seams: number[] = [],
      sharp: number[] = [],
      creases: number[] = [],
      colors: number[] = [];
    const take = (F: EFace, j: number) => {
      verts.push(F.verts[j]);
      uvs.push(F.uvs[j * 2], F.uvs[j * 2 + 1]);
      seams.push(F.seams[j]);
      sharp.push(F.sharp[j]);
      creases.push(F.creases[j]);
      if (A.colors) colors.push(...(F.colors?.slice(j * 4, j * 4 + 4) ?? [1, 1, 1, 1]));
    };
    for (let s = 0; s < na - 1; s++) take(A, (ia + 1 + s) % na); // b … (corner before a)
    for (let s = 0; s < nb - 1; s++) take(B, (jb + 1 + s) % nb); // a … (corner before b)
    if (new Set(verts).size !== verts.length || verts.length < 3) continue;
    unlink(fa);
    unlink(fb);
    faces[fa] = faces[fb] = null;
    faces.push({ ...A, verts, uvs, seams, sharp, creases, colors: A.colors ? colors : undefined });
    link(faces.length - 1);
    count++;
  }
  if (count) m.faces = faces.filter((f): f is EFace => !!f);
  return count;
}

/** Dissolve 2-valence vertices (in `candidates`, or all) whose two edges are nearly collinear. */
export function dissolveCollinearVerts(m: MeshEdit, candidates: Set<number> | null, angle = 1e-3): number {
  const nb = m.neighbors();
  let removed = 0;
  const looseVerts = new Set(m.looseEdges.flat());
  for (let v = 0; v < m.vcount; v++) {
    if (candidates && !candidates.has(v)) continue;
    if (nb[v].length !== 2 || looseVerts.has(v)) continue;
    const [a, b] = nb[v];
    const d1 = V(m.p(v)).sub(V(m.p(a))),
      d2 = V(m.p(b)).sub(V(m.p(v)));
    if (d1.lengthSq() < 1e-20 || d2.lengthSq() < 1e-20 || d1.angleTo(d2) > angle) continue;
    let ok = true;
    for (const f of m.faces) if (f.verts.includes(v) && f.verts.length <= 3) ok = false;
    if (!ok) continue;
    for (const f of m.faces) {
      const i = f.verts.indexOf(v);
      if (i >= 0) removeCorner(f, i);
    }
    removed++;
  }
  if (removed) m.compact();
  return removed;
}

/** Fan/ear triangulation of a face's corners, returned as corner index triples. */
export function triangulateCorners(m: MeshEdit, f: EFace): [number, number, number][] {
  const n = f.verts.length;
  if (n === 3) return [[0, 1, 2]];
  const normal = V(m.faceNormal(f));
  const pts = f.verts.map((v) => V(m.p(v)));
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = pts[i0],
        b = pts[i1],
        c = pts[i2];
      const cross = b.clone().sub(a).cross(c.clone().sub(b));
      if (cross.dot(normal) <= 1e-12) continue; // reflex
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(pts[j], a, b, c, normal)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate: fall back to a fan
      out.push([idx[0], idx[1], idx[2]]);
      idx.splice(1, 1);
    }
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

function pointInTri(p: Vector3, a: Vector3, b: Vector3, c: Vector3, n: Vector3) {
  const s = (x: Vector3, y: Vector3) => y.clone().sub(x).cross(p.clone().sub(x)).dot(n);
  return s(a, b) >= 0 && s(b, c) >= 0 && s(c, a) >= 0;
}

/** Build a sub-face from corner indices of a face, copying corner attributes. */
export function subFace(m: MeshEdit, f: EFace, corners: number[]): EFace {
  const nf = m.makeFace(
    corners.map((i) => f.verts[i]),
    f,
    corners.flatMap((i) => [f.uvs[i * 2], f.uvs[i * 2 + 1]]),
  );
  const n = f.verts.length;
  corners.forEach((i, k) => {
    const j = corners[(k + 1) % corners.length];
    if (j === (i + 1) % n) {
      nf.seams[k] = f.seams[i];
      nf.sharp[k] = f.sharp[i];
      nf.creases[k] = f.creases[i];
    }
  });
  if (f.colors) nf.colors = corners.flatMap((i) => f.colors!.slice(i * 4, i * 4 + 4));
  if (f.cnormals) nf.cnormals = corners.flatMap((i) => f.cnormals!.slice(i * 3, i * 3 + 3));
  return nf;
}

/** Connected components of the given faces (sharing an edge). */
export function faceRegions(m: MeshEdit, faces: number[]): number[][] {
  const set = new Set(faces);
  const ef = m.edgeFaces();
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const s of faces) {
    if (seen.has(s)) continue;
    const comp: number[] = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const fi = st.pop()!;
      comp.push(fi);
      for (const k of faceEdgeKeys(m.faces[fi]))
        for (const [g] of ef.get(k) ?? [])
          if (set.has(g) && !seen.has(g)) {
            seen.add(g);
            st.push(g);
          }
    }
    out.push(comp);
  }
  return out;
}

/** Selected edges grouped into connected chains (ordered vertex lists). */
export function edgeChains(edges: [number, number][]): { verts: number[]; closed: boolean }[] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const out: { verts: number[]; closed: boolean }[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const st = [start];
    seen.add(start);
    while (st.length) {
      const u = st.pop()!;
      comp.push(u);
      for (const w of adj.get(u)!)
        if (!seen.has(w)) {
          seen.add(w);
          st.push(w);
        }
    }
    const ends = comp.filter((v) => adj.get(v)!.length === 1);
    const first = ends[0] ?? comp[0];
    const order = [first];
    const inOrder = new Set(order);
    let prev = -1;
    while (order.length < comp.length) {
      const cur = order[order.length - 1];
      const nx = adj.get(cur)!.find((x) => x !== prev && !inOrder.has(x));
      if (nx === undefined) break;
      prev = cur;
      order.push(nx);
      inOrder.add(nx);
    }
    out.push({ verts: order, closed: !ends.length && comp.every((v) => adj.get(v)!.length === 2) });
  }
  return out;
}

/** Join pairs of adjacent triangles (in `faces`) into quads when their normals differ by less than `maxAngle`. */
export function trisToQuads(m: MeshEdit, faces: Set<number>, maxAngle: number): number {
  const fsel = new Set([...faces].filter((fi) => m.faces[fi].verts.length === 3));
  const ef = m.edgeFaces();
  // candidate pairs sorted by planarity
  const pairs: { a: number; b: number; score: number; key: string }[] = [];
  for (const [k, l] of ef) {
    if (l.length !== 2) continue;
    const [fa] = l[0],
      [fb] = l[1];
    if (!fsel.has(fa) || !fsel.has(fb)) continue;
    const na = V(m.faceNormal(m.faces[fa])),
      nb = V(m.faceNormal(m.faces[fb]));
    const ang = na.angleTo(nb);
    if (ang > maxAngle) continue;
    pairs.push({ a: fa, b: fb, score: ang, key: k });
  }
  pairs.sort((x, y) => x.score - y.score);
  const used = new Set<number>();
  const remove = new Set<number>();
  const add: EFace[] = [];
  for (const pr of pairs) {
    if (used.has(pr.a) || used.has(pr.b)) continue;
    const A = m.faces[pr.a],
      B = m.faces[pr.b];
    const [x, y] = pr.key.split(':').map(Number);
    const oa = A.verts.find((v) => v !== x && v !== y)!,
      ob = B.verts.find((v) => v !== x && v !== y)!;
    const ia = A.verts.indexOf(oa);
    const quad = [oa, A.verts[(ia + 1) % 3], ob, A.verts[(ia + 2) % 3]];
    const uvOf = (v: number) => {
      const i = A.verts.indexOf(v);
      if (i >= 0) return [A.uvs[i * 2], A.uvs[i * 2 + 1]];
      const j = B.verts.indexOf(v);
      return [B.uvs[j * 2], B.uvs[j * 2 + 1]];
    };
    add.push(m.makeFace(quad, A, quad.flatMap(uvOf)));
    used.add(pr.a);
    used.add(pr.b);
    remove.add(pr.a);
    remove.add(pr.b);
  }
  m.faces = m.faces.filter((_, i) => !remove.has(i)).concat(add);
  return add.length;
}

/**
 * Dissolve one vertex: merge the faces around it into a single polygon without it (works for a
 * closed fan and for a fan open at a boundary). Returns false when the result would be invalid.
 */
export function dissolveVertex(m: MeshEdit, v: number): boolean {
  const around: number[] = [];
  m.faces.forEach((f, i) => {
    if (f.verts.includes(v)) around.push(i);
  });
  if (around.length < 2) return false;
  type Path = { fi: number; corners: number[] };
  const paths: Path[] = around.map((fi) => {
    const f = m.faces[fi];
    const n = f.verts.length,
      i = f.verts.indexOf(v);
    const corners: number[] = [];
    for (let k = 1; k < n; k++) corners.push((i + k) % n);
    return { fi, corners };
  });
  const first = (p: Path) => m.faces[p.fi].verts[p.corners[0]];
  const last = (p: Path) => m.faces[p.fi].verts[p.corners[p.corners.length - 1]];
  // order the fan; an open fan starts at the path whose first vertex ends no other path
  const ends = new Set(paths.map(last));
  let start = paths.find((p) => !ends.has(first(p))) ?? paths[0];
  const closed = !paths.some((p) => !ends.has(first(p)));
  const order: Path[] = [start];
  const used = new Set([start]);
  while (order.length < paths.length) {
    const e = last(order[order.length - 1]);
    const nx = paths.find((p) => !used.has(p) && first(p) === e);
    if (!nx) return false;
    order.push(nx);
    used.add(nx);
  }
  if (closed && first(order[0]) !== last(order[order.length - 1])) return false;
  const tmpl = m.faces[start.fi];
  const merged = m.makeFace([], tmpl);
  const push = (f: EFace, c: number, edgeFlags: boolean) => {
    merged.verts.push(f.verts[c]);
    merged.uvs.push(f.uvs[c * 2], f.uvs[c * 2 + 1]);
    merged.seams.push(edgeFlags ? f.seams[c] : 0);
    merged.sharp.push(edgeFlags ? f.sharp[c] : 0);
    merged.creases.push(edgeFlags ? f.creases[c] : 0);
    if (merged.colors) merged.colors.push(...(f.colors?.slice(c * 4, c * 4 + 4) ?? [1, 1, 1, 1]));
  };
  order.forEach((p, k) => {
    const f = m.faces[p.fi];
    const isLast = k === order.length - 1;
    const cs = closed || !isLast ? p.corners.slice(0, -1) : p.corners;
    cs.forEach((c, j) => push(f, c, !(isLast && !closed && j === cs.length - 1)));
  });
  if (merged.verts.length < 3 || new Set(merged.verts).size !== merged.verts.length) return false;
  start = order[0];
  const rm = new Set(around);
  m.faces = m.faces.filter((_, i) => !rm.has(i));
  m.faces.push(merged);
  return true;
}
