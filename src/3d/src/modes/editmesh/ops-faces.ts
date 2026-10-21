// Face tools: solidify, wireframe, grid fill, beautify, weld edges into faces, convex hull,
// intersect (knife / boolean), and face data (rotate / reverse UVs and colors).
import { BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { app, registerOperators } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit } from './context';
import { editPoll, flipFace } from './ops-basic';
import { V, edgeUseCount, vertexNormalsFromFaces, edgeChains, faceRegions, dissolveEdgeSet, triangulateCorners, dissolveCollinearVerts, subFace } from './geom';

// ---------------------------------------------------------------------------
// solidify

/** Give the selected faces thickness: an offset copy (facing the other way) joined by side walls. */
export function solidify(m: MeshEdit, thickness: number): boolean {
  const fsel = m.selectedFaces();
  if (!fsel.length) return false;
  const normals = vertexNormalsFromFaces(m, fsel);
  const map = new Map<number, number>();
  for (const [v, n] of normals) {
    const p = V(m.p(v)).addScaledVector(n, -thickness);
    map.set(v, m.addVert([p.x, p.y, p.z], [[v, 1]], 1));
  }
  const count = edgeUseCount(m, fsel);
  for (const fi of fsel) {
    const f = m.faces[fi];
    const copy: EFace = { ...f, verts: f.verts.map((v) => map.get(v)!), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined };
    flipFace(copy);
    m.faces.push(copy);
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % n];
      if (count.get(edgeKey(a, b)) !== 1) continue;
      m.faces.push(m.makeFace([b, a, map.get(a)!, map.get(b)!], f));
    }
  }
  for (const v of normals.keys()) m.sel[v] = 0;
  return true;
}

// ---------------------------------------------------------------------------
// wireframe

export interface WireframeOptions {
  thickness: number;
  offset: number;
  boundary: boolean;
  even: boolean;
  relative: boolean;
  replace: boolean;
  /** crease weight for the edges running along the original edges (0: none) */
  crease?: number;
}

/** Turn the edges of the selected faces into closed four-sided tubes. */
export function wireframe(m: MeshEdit, o: WireframeOptions): boolean {
  const fsel = m.selectedFaces();
  if (!fsel.length) return false;
  const t = o.thickness;
  const vnorm = vertexNormalsFromFaces(m, fsel);
  const count = edgeUseCount(m, fsel);
  // average edge length around each vertex (relative offset)
  const scale = new Map<number, number>();
  if (o.relative) {
    const acc = new Map<number, [number, number]>();
    for (const fi of fsel) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % f.verts.length];
        const l = V(m.p(a)).distanceTo(V(m.p(b)));
        for (const v of [a, b]) {
          const s = acc.get(v) ?? [0, 0];
          acc.set(v, [s[0] + l, s[1] + 1]);
        }
      }
    }
    for (const [v, [s, n]] of acc) scale.set(v, s / n);
  }
  const sc = (v: number) => (o.relative ? scale.get(v) ?? 1 : 1);
  const outer = new Map<number, number>(),
    inner = new Map<number, number>();
  for (const [v, n] of vnorm) {
    const p = V(m.p(v));
    const po = p.clone().addScaledVector(n, (t * sc(v) * (1 + o.offset)) / 2),
      pi = p.clone().addScaledVector(n, (-t * sc(v) * (1 - o.offset)) / 2);
    outer.set(v, m.addVert([po.x, po.y, po.z], [[v, 1]], 1));
    inner.set(v, m.addVert([pi.x, pi.y, pi.z], [[v, 1]], 1));
  }
  // per face corner: a point inset into the face
  const corner = new Map<string, number>();
  const insetPoint = (p: Vector3, prev: Vector3, next: Vector3, normal: Vector3, dist: number) => {
    const d1 = p.clone().sub(prev).normalize(),
      d2 = next.clone().sub(p).normalize();
    const in1 = normal.clone().cross(d1).normalize(),
      in2 = normal.clone().cross(d2).normalize();
    const bis = in1.clone().add(in2);
    if (bis.lengthSq() < 1e-12) return p.clone().addScaledVector(in1, dist);
    bis.normalize();
    const cos = Math.max(0.1, bis.dot(in1));
    return p.clone().addScaledVector(bis, o.even ? dist / cos : dist);
  };
  for (const fi of fsel) {
    const f = m.faces[fi];
    const n = f.verts.length;
    const normal = V(m.faceNormal(f));
    for (let i = 0; i < n; i++) {
      const v = f.verts[i];
      const q = insetPoint(V(m.p(v)), V(m.p(f.verts[(i + n - 1) % n])), V(m.p(f.verts[(i + 1) % n])), normal, (t * sc(v)) / 2);
      // the offset shifts the whole frame along the vertex normal, face corners included
      if (o.offset) q.addScaledVector(vnorm.get(v) ?? normal, (t * sc(v) * o.offset) / 2);
      corner.set(`${fi}:${v}`, m.addVert([q.x, q.y, q.z], [[v, 1]], 1));
    }
  }
  // boundary vertices get an outward point (mirror of the inset across the boundary edges)
  const boundaryPt = new Map<number, number>();
  if (o.boundary) {
    const bdirs = new Map<number, Vector3[]>();
    for (const fi of fsel) {
      const f = m.faces[fi];
      const n = f.verts.length;
      const normal = V(m.faceNormal(f));
      for (let i = 0; i < n; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % n];
        if (count.get(edgeKey(a, b)) !== 1) continue;
        const out = V(m.p(b)).sub(V(m.p(a))).cross(normal).normalize();
        for (const v of [a, b]) (bdirs.get(v) ?? bdirs.set(v, []).get(v)!).push(out);
      }
    }
    for (const [v, dirs] of bdirs) {
      const bis = new Vector3();
      for (const d of dirs) bis.add(d);
      bis.normalize();
      const cos = Math.max(0.1, bis.dot(dirs[0]));
      const p = V(m.p(v)).addScaledVector(bis, o.even ? (t * sc(v)) / 2 / cos : (t * sc(v)) / 2);
      boundaryPt.set(v, m.addVert([p.x, p.y, p.z], [[v, 1]], 1));
    }
  }
  const tubes: EFace[] = [];
  for (const fi of fsel) {
    const f = m.faces[fi];
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % n];
      const aF = corner.get(`${fi}:${a}`)!,
        bF = corner.get(`${fi}:${b}`)!;
      const t1 = m.makeFace([outer.get(a)!, outer.get(b)!, bF, aF], f),
        t2 = m.makeFace([aF, bF, inner.get(b)!, inner.get(a)!], f);
      if (o.crease) for (const t of [t1, t2]) t.creases[0] = t.creases[2] = o.crease;
      tubes.push(t1, t2);
      if (count.get(edgeKey(a, b)) === 1 && o.boundary) {
        // the open side of a boundary edge
        const aX = boundaryPt.get(a)!,
          bX = boundaryPt.get(b)!;
        tubes.push(m.makeFace([outer.get(b)!, outer.get(a)!, aX, bX], f), m.makeFace([bX, aX, inner.get(a)!, inner.get(b)!], f));
      }
    }
  }
  const all = new Set(fsel);
  // only the new frame stays selected
  for (const v of vnorm.keys()) m.sel[v] = 0;
  if (o.replace) m.faces = m.faces.filter((_, i) => !all.has(i));
  m.faces.push(...tubes);
  if (o.replace) m.compact();
  return true;
}

// ---------------------------------------------------------------------------
// grid fill

/** Fill one selected closed edge loop with a grid of quads. `span` = vertices along one side. */
export function gridFill(m: MeshEdit, span: number, offset: number, simple = false): boolean {
  const chains = edgeChains(m.selectedEdges());
  if (chains.length !== 1 || !chains[0].closed) return false;
  let loop = chains[0].verts;
  const N = loop.length;
  // canonical walk: from the lowest vertex index towards its higher-numbered neighbour
  const s0 = loop.indexOf(Math.min(...loop));
  loop = [...loop.slice(s0), ...loop.slice(0, s0)];
  if (N > 2 && loop[N - 1] > loop[1]) loop = [loop[0], ...loop.slice(1).reverse()];
  if (N < 4 || N % 2) return false;
  span = Math.max(1, Math.min(N / 2 - 1, span));
  const a = span,
    b = N / 2 - span;
  const off = ((offset % N) + N) % N;
  loop = [...loop.slice(off), ...loop.slice(0, off)];
  // sides: bottom (0..a), right (a..a+b), top (a+b..2a+b), left (2a+b..N)
  const at = (k: number) => loop[((k % N) + N) % N];
  const W = a,
    H = b;
  const grid: number[][] = [];
  const P = (v: number) => V(m.p(v));
  const bottom = (i: number) => P(at(i)),
    right = (j: number) => P(at(W + j)),
    top = (i: number) => P(at(2 * W + H - i)),
    left = (j: number) => P(at(N - j));
  const c00 = bottom(0),
    c10 = bottom(W),
    c11 = top(W),
    c01 = top(0);
  for (let j = 0; j <= H; j++) {
    grid.push([]);
    for (let i = 0; i <= W; i++) {
      let id: number;
      if (j === 0) id = at(i);
      else if (j === H) id = at(2 * W + H - i);
      else if (i === 0) id = at(N - j);
      else if (i === W) id = at(W + j);
      else {
        const u = i / W,
          v = j / H;
        let p: Vector3;
        if (simple) {
          p = c00.clone().multiplyScalar((1 - u) * (1 - v)).add(c10.clone().multiplyScalar(u * (1 - v))).add(c11.clone().multiplyScalar(u * v)).add(c01.clone().multiplyScalar((1 - u) * v));
        } else {
          // Coons patch over the four sides
          const lerpU = bottom(i).multiplyScalar(1 - v).add(top(i).multiplyScalar(v));
          const lerpV = left(j).multiplyScalar(1 - u).add(right(j).multiplyScalar(u));
          const bil = c00.clone().multiplyScalar((1 - u) * (1 - v)).add(c10.clone().multiplyScalar(u * (1 - v))).add(c11.clone().multiplyScalar(u * v)).add(c01.clone().multiplyScalar((1 - u) * v));
          p = lerpU.add(lerpV).sub(bil);
        }
        id = m.addVert([p.x, p.y, p.z], [], 1);
      }
      grid[j].push(id);
    }
  }
  const first = m.faces.length;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) m.faces.push(m.makeFace([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], undefined, [i / W, j / H, (i + 1) / W, j / H, (i + 1) / W, (j + 1) / H, i / W, (j + 1) / H]));
  orientNewFaces(m, first);
  return true;
}

/** Wind faces from index `first` on so they agree with the existing neighbours (or face the viewer). */
function orientNewFaces(m: MeshEdit, first: number) {
  const ef = m.edgeFaces();
  let flip: boolean | null = null;
  for (let fi = first; fi < m.faces.length && flip === null; fi++) {
    const f = m.faces[fi];
    for (let i = 0; i < f.verts.length && flip === null; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % f.verts.length];
      for (const [g, c] of ef.get(edgeKey(a, b)) ?? []) {
        if (g >= first) continue;
        // a neighbour should run the shared edge in the opposite direction
        flip = m.faces[g].verts[c] === a;
        break;
      }
    }
  }
  if (flip === null) {
    let v: ReturnType<typeof activeView3D> = null;
    try {
      v = activeView3D();
    } catch {
      v = null;
    }
    if (v) {
      const toViewer = new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion);
      const n = new Vector3();
      for (let fi = first; fi < m.faces.length; fi++) n.add(V(m.faceNormal(m.faces[fi])));
      flip = n.dot(toViewer) < 0;
    }
  }
  if (flip) for (let fi = first; fi < m.faces.length; fi++) flipFace(m.faces[fi]);
  // keep the new block consistent internally
  const saved = m.sel.slice();
  m.sel = m.sel.map(() => 0);
  for (let fi = first; fi < m.faces.length; fi++) for (const v of m.faces[fi].verts) m.sel[v] = 1;
  void saved;
}

// ---------------------------------------------------------------------------
// beautify

/** Flip shared edges of selected triangle pairs where that gives better shaped triangles. */
export function beautifyFill(m: MeshEdit, angleLimit: number, only?: Set<number>): number {
  const isTri = (fi: number) => m.faces[fi].verts.length === 3;
  const fsel = new Set((only ? [...only] : m.selectedFaces()).filter(isTri));
  let flips = 0;
  const minAngle = (p: Vector3[]) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) best = Math.min(best, p[(i + 1) % 3].clone().sub(p[i]).angleTo(p[(i + 2) % 3].clone().sub(p[i])));
    return best;
  };
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    const ef = m.edgeFaces();
    for (const [k, l] of ef) {
      if (l.length !== 2) continue;
      const [fa, ia] = l[0],
        [fb] = l[1];
      if (!fsel.has(fa) || !fsel.has(fb)) continue;
      const A = m.faces[fa],
        B = m.faces[fb];
      if (A.verts.length !== 3 || B.verts.length !== 3) continue;
      const a = A.verts[ia],
        b = A.verts[(ia + 1) % 3],
        c = A.verts[(ia + 2) % 3];
      const d = B.verts.find((v) => v !== a && v !== b)!;
      if (edgeKey(c, d) !== k && m.edgeFaces().has(edgeKey(c, d))) continue;
      const nA = V(m.faceNormal(A)),
        nB = V(m.faceNormal(B));
      if (nA.angleTo(nB) > angleLimit) continue;
      const pa = P3(m, a),
        pb = P3(m, b),
        pc = P3(m, c),
        pd = P3(m, d);
      const before = Math.min(minAngle([pa, pb, pc]), minAngle([pb, pa, pd]));
      const after = Math.min(minAngle([pc, pa, pd]), minAngle([pd, pb, pc]));
      if (after <= before + 1e-6) continue;
      // the new triangles must keep the same facing
      const t1 = [c, a, d],
        t2 = [d, b, c];
      const n1 = pa.clone().sub(pc).cross(pd.clone().sub(pc)),
        n2 = pb.clone().sub(pd).cross(pc.clone().sub(pd));
      if (n1.dot(nA) <= 0 || n2.dot(nA) <= 0) continue;
      const uv = (F: EFace, v: number) => {
        const i = F.verts.indexOf(v);
        return i >= 0 ? [F.uvs[i * 2], F.uvs[i * 2 + 1]] : null;
      };
      const uvOf = (v: number) => uv(A, v) ?? uv(B, v) ?? [0, 0];
      m.faces[fa] = m.makeFace(t1, A, t1.flatMap(uvOf));
      m.faces[fb] = m.makeFace(t2, B, t2.flatMap(uvOf));
      flips++;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return flips;
}

const P3 = (m: MeshEdit, v: number) => V(m.p(v));

// ---------------------------------------------------------------------------
// triangulate

export function triangulate(m: MeshEdit, faces: Set<number>, quadMethod: string, ngonMethod: string) {
  const out: EFace[] = [];
  const fromNgons = new Set<number>();
  const d2 = (a: number, b: number) => V(m.p(a)).distanceToSquared(V(m.p(b)));
  const minAngle = (tri: number[]) => {
    const p = tri.map((v) => V(m.p(v)));
    let best = Infinity;
    for (let i = 0; i < 3; i++) best = Math.min(best, p[(i + 1) % 3].clone().sub(p[i]).angleTo(p[(i + 2) % 3].clone().sub(p[i])));
    return best;
  };
  m.faces.forEach((f, fi) => {
    const n = f.verts.length;
    if (!faces.has(fi) || n === 3) return out.push(f);
    let tris: number[][];
    if (n === 4) {
      const a = [[0, 1, 2], [0, 2, 3]],
        b = [[1, 2, 3], [1, 3, 0]];
      const v = f.verts;
      const shortA = d2(v[0], v[2]) <= d2(v[1], v[3]);
      if (quadMethod === 'FIXED') tris = a;
      else if (quadMethod === 'FIXED_ALTERNATE') tris = b;
      else if (quadMethod === 'SHORTEST_DIAGONAL') tris = shortA ? a : b;
      else if (quadMethod === 'LONGEST_DIAGONAL') tris = shortA ? b : a;
      else {
        // beauty: the split whose worst triangle angle is largest
        const q = (t: number[][]) => Math.min(...t.map((x) => minAngle(x.map((i) => v[i]))));
        tris = q(a) >= q(b) - 1e-9 ? a : b;
      }
    } else tris = triangulateCorners(m, f);
    for (const t of tris) {
      if (n > 4) fromNgons.add(out.length);
      out.push(subFace(m, f, t));
    }
  });
  m.faces = out;
  if (ngonMethod === 'BEAUTY' && fromNgons.size) beautifyFill(m, Math.PI, fromNgons);
  return true;
}

// ---------------------------------------------------------------------------
// fill: triangulate closed loops of selected edges

export function fillLoops(m: MeshEdit, beauty: boolean): number {
  // edges between two selected faces are interior, not outlines to fill
  const fsel = new Set(m.selectedFaces());
  const ef = m.edgeFaces();
  const edges = m.selectedEdges().filter(([a, b]) => (ef.get(edgeKey(a, b)) ?? []).filter(([f]) => fsel.has(f)).length < 2 && (ef.get(edgeKey(a, b))?.length ?? 0) < 2);
  let made = 0;
  const newTris = new Set<number>();
  for (const chain of edgeChains(edges)) {
    if (!chain.closed || chain.verts.length < 3) continue;
    const first = m.faces.length;
    const poly = m.makeFace(chain.verts, m.faces[0]);
    m.faces.push(poly);
    orientNewFaces(m, first);
    const f = m.faces.pop()!;
    for (const t of triangulateCorners(m, f)) {
      newTris.add(m.faces.length);
      m.faces.push(subFace(m, f, t));
    }
    made++;
  }
  if (beauty && newTris.size) beautifyFill(m, Math.PI, newTris);
  return made;
}

// ---------------------------------------------------------------------------
// weld edges into faces

/** Split faces along chains of loose edges that run between two of their vertices. */
export function splitFacesByEdges(m: MeshEdit): number {
  if (!m.looseEdges.length) return 0;
  const adj = new Map<number, number[]>();
  for (const [a, b] of m.looseEdges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const vf = m.vertexFaces();
  const onFace = (v: number) => vf[v].length > 0;
  let splits = 0;
  const usedEdges = new Set<string>();
  for (const [start] of adj) {
    if (!onFace(start)) continue;
    for (const first of adj.get(start)!) {
      if (usedEdges.has(edgeKey(start, first))) continue;
      // walk through vertices that only have loose edges until reaching a face vertex
      const path = [start, first];
      let prev = start,
        cur = first;
      while (!onFace(cur)) {
        const nx = (adj.get(cur) ?? []).filter((x) => x !== prev);
        if (nx.length !== 1) break;
        prev = cur;
        cur = nx[0];
        path.push(cur);
      }
      if (!onFace(cur) || cur === start) continue;
      // a face containing both ends, with the inner path inside it
      const end = cur;
      const fi = m.faces.findIndex((f) => f.verts.includes(start) && f.verts.includes(end) && !adjacentIn(f.verts, start, end));
      if (fi < 0) continue;
      const f = m.faces[fi];
      const i = f.verts.indexOf(start),
        j = f.verts.indexOf(end);
      const inner = path.slice(1, -1);
      const n = f.verts.length;
      const partA: number[] = [],
        partB: number[] = [];
      for (let k = i; ; k = (k + 1) % n) {
        partA.push(f.verts[k]);
        if (k === j) break;
      }
      for (let k = j; ; k = (k + 1) % n) {
        partB.push(f.verts[k]);
        if (k === i) break;
      }
      const A = [...partA, ...[...inner].reverse()],
        B = [...partB, ...inner];
      const uvOf = (v: number) => {
        const k = f.verts.indexOf(v);
        return k >= 0 ? [f.uvs[k * 2], f.uvs[k * 2 + 1]] : [0, 0];
      };
      m.faces[fi] = m.makeFace(A, f, A.flatMap(uvOf));
      m.faces.push(m.makeFace(B, f, B.flatMap(uvOf)));
      for (let k = 0; k < path.length - 1; k++) usedEdges.add(edgeKey(path[k], path[k + 1]));
      splits++;
    }
  }
  m.looseEdges = m.looseEdges.filter(([a, b]) => !usedEdges.has(edgeKey(a, b)));
  return splits;
}

function adjacentIn(verts: number[], a: number, b: number) {
  const n = verts.length,
    i = verts.indexOf(a);
  return verts[(i + 1) % n] === b || verts[(i + n - 1) % n] === b;
}

// ---------------------------------------------------------------------------
// convex hull

export function convexHull(m: MeshEdit, o: { deleteUnused: boolean; joinTriangles: boolean; faceThreshold: number }): boolean {
  const verts = m.selectedVerts();
  if (verts.length < 4) return false;
  const pts = verts.map((v) => V(m.p(v)));
  const index = new Map<Vector3, number>();
  pts.forEach((p, i) => index.set(p, verts[i]));
  let hull: ConvexHull;
  try {
    hull = new ConvexHull().setFromPoints(pts);
  } catch {
    return false;
  }
  if (!hull.faces.length) return false;
  const keyOf = (vs: number[]) => [...vs].sort((x, y) => x - y).join(',');
  const hullFaces: number[][] = [];
  for (const face of hull.faces) {
    const ids: number[] = [];
    let e = face.edge;
    do {
      ids.push(index.get(e.head().point)!);
      e = e.next;
    } while (e !== face.edge);
    if (!ids.some((x) => x === undefined)) hullFaces.push(ids);
  }
  const hullKeys = new Set(hullFaces.map(keyOf));
  const selSet = new Set(verts);
  if (o.deleteUnused) {
    // selected faces that are not part of the hull go away
    m.faces = m.faces.filter((f) => !f.verts.every((v) => selSet.has(v)) || hullKeys.has(keyOf(f.verts)));
    m.looseEdges = m.looseEdges.filter(([a, b]) => !selSet.has(a) || !selSet.has(b));
  }
  const existing = new Set(m.faces.map((f) => keyOf(f.verts)));
  const first = m.faces.length;
  for (const ids of hullFaces) if (!existing.has(keyOf(ids))) m.faces.push(m.makeFace(ids, m.faces[0]));
  if (o.joinTriangles) {
    const newFaces = new Set<number>();
    for (let i = first; i < m.faces.length; i++) newFaces.add(i);
    mergeCoplanar(m, newFaces);
    // points left in the middle of hull edges
    dissolveCollinearVerts(m, selSet, 1e-4);
  }
  if (o.deleteUnused) {
    const used = new Uint8Array(m.vcount);
    for (const f of m.faces) for (const v of f.verts) used[v] = 1;
    for (const [a, b] of m.looseEdges) used[a] = used[b] = 1;
    m.keepVerts(Array.from(used, (u, i) => (u || !m.sel[i] ? 1 : 0)));
  }
  void o.faceThreshold;
  return true;
}

function mergeCoplanar(m: MeshEdit, faces: Set<number>) {
  const ef = m.edgeFaces();
  const keys: string[] = [];
  for (const [k, l] of ef) {
    if (l.length !== 2 || !faces.has(l[0][0]) || !faces.has(l[1][0])) continue;
    if (V(m.faceNormal(m.faces[l[0][0]])).angleTo(V(m.faceNormal(m.faces[l[1][0]]))) < 1e-4) keys.push(k);
  }
  dissolveEdgeSet(m, keys);
}

// ---------------------------------------------------------------------------
// intersect (knife) and intersect (boolean) using CSG on the selected / unselected parts

const csg = new Evaluator();
csg.attributes = ['position', 'uv', 'normal', 'fid'];
csg.useGroups = false;

function brushOf(m: MeshEdit, faces: number[]): Brush {
  const pos: number[] = [],
    uv: number[] = [],
    fid: number[] = [];
  for (const fi of faces) {
    const f = m.faces[fi];
    for (const t of triangulateCorners(m, f))
      for (const c of t) {
        const v = f.verts[c];
        pos.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
        uv.push(f.uvs[c * 2], f.uvs[c * 2 + 1]);
        fid.push(fi);
      }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('fid', new Float32BufferAttribute(fid, 1));
  g.computeVertexNormals();
  const b = new Brush(g, new MeshBasicMaterial());
  b.updateMatrixWorld(true);
  return b;
}

type Piece = { tag: string; geom: BufferGeometry; flip?: boolean };

/** Rebuild faces from CSG triangle pieces: triangles from the same source face and piece merge back into polygons. */
function rebuildFromPieces(m: MeshEdit, keepFaces: number[], pieces: Piece[], domain: (tag: string, fid: number) => string, operandOf: (fid: number) => string = () => ''): void {
  const out = new MeshEdit();
  out.weights = m.weights.map(() => []);
  out.keys = m.keys.map(() => []);
  out.pcolors = m.pcolors.map(() => []);
  out.vfloat = Object.fromEntries(Object.keys(m.vfloat).map((k) => [k, []]));
  if (m.skin) out.skin = [];
  // unchanged faces/vertices are copied as they are
  const vmap = new Map<number, number>();
  const copyVert = (v: number) => {
    let n = vmap.get(v);
    if (n === undefined) {
      n = out.vcount;
      out.pos.push(...m.p(v));
      out.sel.push(0);
      out.hide.push(m.hide[v]);
      m.weights.forEach((w, i) => out.weights[i].push(w[v] ?? 0));
      m.keys.forEach((k, i) => out.keys[i].push(k[v * 3], k[v * 3 + 1], k[v * 3 + 2]));
      m.pcolors.forEach((c, i) => out.pcolors[i].push(...c.slice(v * 4, v * 4 + 4)));
      for (const k in m.vfloat) out.vfloat[k].push(m.vfloat[k][v] ?? 0);
      if (m.skin && out.skin) out.skin.push(...m.skin.slice(v * 4, v * 4 + 4));
      vmap.set(v, n);
    }
    return n;
  };
  for (const fi of keepFaces) {
    const f = m.faces[fi];
    out.faces.push({ ...f, verts: f.verts.map(copyVert), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined });
  }
  for (const [a, b] of m.looseEdges) out.looseEdges.push([copyVert(a), copyVert(b)]);
  // positions → new vertex ids; vertices only weld within the same domain
  const q = (x: number) => Math.round(x * 1e5);
  const ids = new Map<string, number>();
  const tagsAt = new Map<string, Set<string>>(); // position → piece tags meeting there
  const newVert = (x: number, y: number, z: number, domain: string, tag: string) => {
    const k = `${q(x)},${q(y)},${q(z)}`;
    const key = `${domain}|${k}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = out.addVert([x, y, z], [], 0);
      ids.set(key, id);
    }
    (tagsAt.get(k) ?? tagsAt.set(k, new Set()).get(k)!).add(tag);
    return id;
  };
  const groups = new Map<string, number[]>();
  for (const pc of pieces) {
    const P = pc.geom.getAttribute('position'),
      UV = pc.geom.getAttribute('uv'),
      F = pc.geom.getAttribute('fid');
    const count = pc.geom.index ? pc.geom.index.count : P.count;
    const at = (c: number) => (pc.geom.index ? pc.geom.index.getX(c) : c);
    for (let t = 0; t < count / 3; t++) {
      const cs = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)];
      const src0 = Math.round(F.getX(cs[0]));
      const vids = cs.map((c) => newVert(P.getX(c), P.getY(c), P.getZ(c), domain(pc.tag, src0), `${pc.tag}${operandOf(src0)}`));
      if (new Set(vids).size < 3) continue;
      const src = m.faces[src0] ?? m.faces[0];
      const face = out.makeFace(vids, src, cs.flatMap((c) => [UV.getX(c), UV.getY(c)]));
      if (pc.flip) flipFace(face);
      const key = `${pc.tag}:${Math.round(F.getX(cs[0]))}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(out.faces.length);
      out.faces.push(face);
    }
  }
  // vertices where different pieces meet lie on the intersection
  for (const [key, id] of ids) if ((tagsAt.get(key.split('|')[1])?.size ?? 0) > 1 && id < out.vcount) out.sel[id] = 1;
  // merge the triangles of each source face (within a piece) back into polygons
  const drop = new Set<number>();
  const merged: EFace[] = [];
  for (const fs of groups.values()) {
    if (fs.length < 2) continue;
    const poly = mergeTriangles(out, fs);
    if (!poly) continue;
    for (const fi of fs) drop.add(fi);
    merged.push(poly);
  }
  out.faces = out.faces.filter((_, i) => !drop.has(i)).concat(merged);
  // split points the boolean left on straight runs
  const fresh = new Set<number>();
  for (let v = vmap.size; v < out.vcount; v++) fresh.add(v);
  dissolveCollinearVerts(out, fresh, 1e-4);
  // replace the mesh content
  const ebw = new Map<string, number>();
  for (const [k, w] of m.ebw) {
    const [a, b] = k.split(':').map((x) => vmap.get(+x));
    if (a !== undefined && b !== undefined) ebw.set(edgeKey(a, b), w);
  }
  Object.assign(m, { pos: out.pos, sel: out.sel, hide: out.hide, weights: out.weights, keys: out.keys, pcolors: out.pcolors, vfloat: out.vfloat, skin: out.skin, ebw, ebwMid: new Map(), faces: out.faces, looseEdges: out.looseEdges });
  m.compact();
}

/** Split the faces into operands: selected vs unselected, or (selfOnly) loose parts of the selection. */
function operands(m: MeshEdit, mode: 'SELECT' | 'SELECT_UNSELECT') {
  const fsel = m.selectedFaces();
  const s = new Set(fsel);
  if (mode === 'SELECT') {
    const parts = faceRegions(m, fsel);
    if (parts.length < 2) return null;
    return { a: parts[0], b: parts.slice(1).flat(), rest: m.faces.map((_, i) => i).filter((i) => !s.has(i)) };
  }
  const b = m.faces.map((_, i) => i).filter((i) => !s.has(i));
  if (!fsel.length || !b.length) return null;
  return { a: fsel, b, rest: [] as number[] };
}

export function intersectKnife(m: MeshEdit, mode: 'SELECT' | 'SELECT_UNSELECT', separate: 'ALL' | 'CUT' | 'NONE'): boolean {
  const ops = operands(m, mode);
  if (!ops) return false;
  const A = brushOf(m, ops.a),
    B = brushOf(m, ops.b);
  const union = csg.evaluate(A, B, ADDITION) as Brush,
    inter = csg.evaluate(A, B, INTERSECTION) as Brush;
  if (!inter.geometry.getAttribute('position')?.count) return false;
  const inA = new Set(ops.a);
  const operand = (fid: number) => (inA.has(fid) ? 'A' : 'B');
  const domain = (tag: string, fid: number) => (separate === 'NONE' ? '' : separate === 'CUT' ? operand(fid) : operand(fid) + tag);
  rebuildFromPieces(m, ops.rest, [{ tag: 'out', geom: union.geometry }, { tag: 'in', geom: inter.geometry }], domain, operand);
  return true;
}

export function intersectBoolean(m: MeshEdit, operation: 'INTERSECT' | 'UNION' | 'DIFFERENCE', swap: boolean): boolean {
  const ops = operands(m, 'SELECT_UNSELECT');
  if (!ops) return false;
  // the unselected part is the cutter by default
  let A = brushOf(m, ops.b),
    B = brushOf(m, ops.a);
  if (swap) [A, B] = [B, A];
  const res = csg.evaluate(A, B, operation === 'UNION' ? ADDITION : operation === 'INTERSECT' ? INTERSECTION : SUBTRACTION) as Brush;
  const inA = new Set(ops.a);
  rebuildFromPieces(m, ops.rest, [{ tag: 'r', geom: res.geometry }], () => '', (fid) => (inA.has(fid) ? 'A' : 'B'));
  return true;
}

/**
 * Outline of a set of triangles (which may have T-junctions: vertices lying on another triangle's
 * edge) as one polygon, or null when the outline isn't a single loop.
 */
function mergeTriangles(m: MeshEdit, faces: number[]): EFace | null {
  const verts = new Set<number>();
  for (const fi of faces) for (const v of m.faces[fi].verts) verts.add(v);
  const vlist = [...verts];
  const uvAt = new Map<number, number[]>();
  const directed = new Map<string, number>();
  const add = (a: number, b: number) => {
    const rev = `${b}>${a}`;
    if (directed.get(rev)) directed.set(rev, directed.get(rev)! - 1);
    else directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
  };
  for (const fi of faces) {
    const f = m.faces[fi];
    for (let i = 0; i < 3; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % 3];
      uvAt.set(a, [f.uvs[i * 2], f.uvs[i * 2 + 1]]);
      // vertices of the group strictly inside this edge split it
      const pa = V(m.p(a)),
        pb = V(m.p(b));
      const d = pb.clone().sub(pa);
      const len2 = d.lengthSq();
      const inner: [number, number][] = [];
      for (const v of vlist) {
        if (v === a || v === b) continue;
        const pv = V(m.p(v));
        const t = pv.clone().sub(pa).dot(d) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        if (pa.clone().addScaledVector(d, t).distanceToSquared(pv) > 1e-10) continue;
        inner.push([t, v]);
      }
      inner.sort((x, y) => x[0] - y[0]);
      const chain = [a, ...inner.map((x) => x[1]), b];
      for (let k = 0; k < chain.length - 1; k++) add(chain[k], chain[k + 1]);
    }
  }
  const next = new Map<number, number>();
  for (const [k, c] of directed) {
    if (c <= 0) continue;
    if (c > 1) return null;
    const [a, b] = k.split('>').map(Number);
    if (next.has(a)) return null;
    next.set(a, b);
  }
  if (next.size < 3) return null;
  const start = next.keys().next().value as number;
  const loop = [start];
  let v = next.get(start)!;
  while (v !== start) {
    if (loop.length > next.size) return null;
    loop.push(v);
    const nv = next.get(v);
    if (nv === undefined) return null;
    v = nv;
  }
  if (loop.length !== next.size) return null;
  const src = m.faces[faces[0]];
  return m.makeFace(loop, src, loop.flatMap((x) => uvAt.get(x) ?? [0, 0]));
}

// ---------------------------------------------------------------------------
// face data

function rotateCorners(f: EFace, ccw: boolean, key: 'uvs' | 'colors') {
  const arr = f[key];
  if (!arr) return;
  const k = key === 'uvs' ? 2 : 4;
  const n = f.verts.length;
  const out = new Array(arr.length);
  for (let i = 0; i < n; i++) {
    const j = ccw ? (i + 1) % n : (i + n - 1) % n;
    for (let c = 0; c < k; c++) out[i * k + c] = arr[j * k + c];
  }
  f[key] = out;
}

function reverseCorners(f: EFace, key: 'uvs' | 'colors') {
  const arr = f[key];
  if (!arr) return;
  const k = key === 'uvs' ? 2 : 4;
  const n = f.verts.length;
  const out = new Array(arr.length);
  // keep the first corner, reverse the order of the rest
  for (let i = 0; i < n; i++) {
    const j = (n - i) % n;
    for (let c = 0; c < k; c++) out[i * k + c] = arr[j * k + c];
  }
  f[key] = out;
}

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'mesh.solidify',
    label: 'Solidify',
    description: 'Give the selected faces thickness',
    props: [{ id: 'thickness', label: 'Thickness', type: 'float', default: 0.01, min: -10000, max: 10000, softMin: -10, softMax: 10, subtype: 'distance' }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => solidify(m, p.thickness as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.wireframe',
    label: 'Wireframe',
    description: 'Turn the edges of the selected faces into a solid wire frame',
    props: [
      { id: 'use_boundary', label: 'Boundary', type: 'bool', default: true },
      { id: 'use_even_offset', label: 'Offset Even', type: 'bool', default: true },
      { id: 'use_relative_offset', label: 'Offset Relative', type: 'bool', default: false },
      { id: 'use_replace', label: 'Replace', type: 'bool', default: true },
      { id: 'thickness', label: 'Thickness', type: 'float', default: 0.01, min: 0, max: 10000, softMax: 1, subtype: 'distance' },
      { id: 'offset', label: 'Offset', type: 'float', default: 0.01, min: -10000, max: 10000, softMin: -1, softMax: 1, subtype: 'distance' },
      { id: 'use_crease', label: 'Crease', type: 'bool', default: false },
      { id: 'crease_weight', label: 'Crease Weight', type: 'float', default: 0.01, min: 0, max: 1000, softMax: 1, subtype: 'factor', showIf: (p) => !!p.use_crease },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      withEdit((m) => wireframe(m, { thickness: p.thickness as number, offset: p.offset as number, boundary: !!p.use_boundary, even: !!p.use_even_offset, relative: !!p.use_relative_offset, replace: !!p.use_replace, crease: p.use_crease ? Math.min(1, p.crease_weight as number) : 0 })) ? 'FINISHED' : 'CANCELLED',
  },
  {
    idname: 'mesh.fill_grid',
    label: 'Grid Fill',
    description: 'Fill a selected closed edge loop with a grid of quads',
    props: [
      { id: 'span', label: 'Span', type: 'int', default: 0, min: 0, max: 1000 },
      { id: 'offset', label: 'Offset', type: 'int', default: 0, min: -1000, max: 1000 },
      { id: 'use_interp_simple', label: 'Simple Blending', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let failed = false;
      withEdit((m) => {
        const chains = edgeChains(m.selectedEdges());
        if (chains.length === 1 && !(p.span as number)) p.span = Math.max(1, Math.floor(chains[0].verts.length / 4));
        const ok = gridFill(m, p.span as number, p.offset as number, !!p.use_interp_simple);
        if (!ok) failed = true;
        return ok;
      });
      if (failed) {
        app.report('ERROR', 'Select one closed edge loop with an even number of vertices');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.fill',
    label: 'Fill',
    description: 'Fill closed loops of selected edges with triangles',
    props: [{ id: 'use_beauty', label: 'Beauty', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => fillLoops(m, !!p.use_beauty) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.quads_convert_to_tris',
    label: 'Triangulate Faces',
    description: 'Split the selected faces into triangles',
    props: [
      {
        id: 'quad_method',
        label: 'Quad Method',
        type: 'enum',
        default: 'BEAUTY',
        items: [['BEAUTY', 'Beauty', 'Split along the diagonal giving the best shaped triangles'], ['FIXED', 'Fixed', 'Split between the first and third corner'], ['FIXED_ALTERNATE', 'Fixed Alternate', 'Split between the second and fourth corner'], ['SHORTEST_DIAGONAL', 'Shortest Diagonal'], ['LONGEST_DIAGONAL', 'Longest Diagonal']],
      },
      { id: 'ngon_method', label: 'N-gon Method', type: 'enum', default: 'BEAUTY', items: [['BEAUTY', 'Beauty', 'Clip ears, then rearrange for better shaped triangles'], ['CLIP', 'Clip', 'Clip ears only']] },
    ],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => triangulate(m, new Set(m.selectedFaces()), p.quad_method as string, p.ngon_method as string)),
  },
  {
    idname: 'mesh.beautify_fill',
    label: 'Beautify Faces',
    description: 'Rearrange the edges of selected triangles into better shaped triangles',
    props: [{ id: 'angle_limit', label: 'Max Angle', type: 'float', default: Math.PI, min: 0, max: Math.PI, subtype: 'angle' }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => beautifyFill(m, p.angle_limit as number) > 0),
  },
  {
    idname: 'mesh.face_split_by_edges',
    label: 'Weld Edges into Faces',
    description: 'Split faces along loose edges that run across them',
    poll: editPoll,
    exec: () => (withEdit((m) => splitFacesByEdges(m) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.convex_hull',
    label: 'Convex Hull',
    description: 'Wrap the selected vertices in a convex hull',
    props: [
      { id: 'delete_unused', label: 'Delete Unused', type: 'bool', default: true },
      { id: 'join_triangles', label: 'Join Triangles', type: 'bool', default: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => convexHull(m, { deleteUnused: !!p.delete_unused, joinTriangles: !!p.join_triangles, faceThreshold: 0 })) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.intersect',
    label: 'Intersect (Knife)',
    description: 'Cut the faces where the selected and unselected geometry intersect',
    props: [
      { id: 'mode', label: 'Source', type: 'enum', default: 'SELECT_UNSELECT', items: [['SELECT', 'Self Intersect'], ['SELECT_UNSELECT', 'Selected/Unselected']] },
      { id: 'separate_mode', label: 'Separate Mode', type: 'enum', default: 'CUT', items: [['ALL', 'All'], ['CUT', 'Cut'], ['NONE', 'Merge']] },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      if (!withEdit((m) => intersectKnife(m, p.mode as 'SELECT', p.separate_mode as 'CUT'))) {
        app.report('WARNING', 'No intersections found');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.intersect_boolean',
    label: 'Intersect (Boolean)',
    description: 'Combine the selected and unselected geometry with a boolean operation',
    props: [
      { id: 'operation', label: 'Boolean Operation', type: 'enum', default: 'DIFFERENCE', items: [['INTERSECT', 'Intersect'], ['UNION', 'Union'], ['DIFFERENCE', 'Difference']] },
      { id: 'use_swap', label: 'Swap', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      if (!withEdit((m) => intersectBoolean(m, p.operation as 'UNION', !!p.use_swap))) {
        app.report('WARNING', 'Select part of the mesh to use as the boolean operand');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.flip_quad_tessellation',
    label: 'Flip Quad Tessellation',
    description: 'Split the selected quads along their other diagonal when shading',
    poll: editPoll,
    exec: () =>
      withEdit((m) => {
        const quads = m.selectedFaces().filter((fi) => m.faces[fi].verts.length === 4);
        for (const fi of quads) m.faces[fi].flip = !m.faces[fi].flip;
        return quads.length > 0;
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'mesh.uvs_rotate',
    label: 'Rotate UVs',
    description: 'Rotate the UV corners of the selected faces',
    props: [{ id: 'use_ccw', label: 'Counter Clockwise', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => m.selectedFaces().forEach((fi) => rotateCorners(m.faces[fi], !!p.use_ccw, 'uvs'))),
  },
  {
    idname: 'mesh.uvs_reverse',
    label: 'Reverse UVs',
    description: 'Reverse the UV corner order of the selected faces',
    poll: editPoll,
    exec: () => void withEdit((m) => m.selectedFaces().forEach((fi) => reverseCorners(m.faces[fi], 'uvs'))),
  },
  {
    idname: 'mesh.colors_rotate',
    label: 'Rotate Colors',
    description: 'Rotate the face-corner colors of the selected faces',
    props: [{ id: 'use_ccw', label: 'Counter Clockwise', type: 'bool', default: false }],
    poll: (ctx) => editPoll(ctx) && !!app.activeObject?.data && app.doc.meshes[app.activeObject.data]?.color_attributes.some((c) => c.domain === 'CORNER'),
    exec: (_ctx, p) => void withEdit((m) => m.selectedFaces().forEach((fi) => rotateCorners(m.faces[fi], !!p.use_ccw, 'colors'))),
  },
  {
    idname: 'mesh.colors_reverse',
    label: 'Reverse Colors',
    description: 'Reverse the face-corner color order of the selected faces',
    poll: (ctx) => editPoll(ctx) && !!app.activeObject?.data && app.doc.meshes[app.activeObject.data]?.color_attributes.some((c) => c.domain === 'CORNER'),
    exec: () => void withEdit((m) => m.selectedFaces().forEach((fi) => reverseCorners(m.faces[fi], 'colors'))),
  },
]);

