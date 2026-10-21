// Mesh operations: flip, triangulate, delete/separate, merge by distance, mesh ↔ points/curves.
import { CurvesComponent, MeshComponent, PointsComponent, EdgeHash, allocData, dataComps, adaptDomain, type AttrMap } from '../geometry';
import type { Domain } from '../types';
import { Rebuild, type Src } from './rebuild';
import { faceCenters } from '../meshutil';
import { triangulatePoly, polyNormal } from '../../mesh/mesh';

export function flipFaces(m: MeshComponent, sel: Uint8Array | null): MeshComponent {
  const corners = new Uint32Array(m.corners);
  const nc = m.cornerCount;
  const cmap = new Int32Array(nc);
  for (let c = 0; c < nc; c++) cmap[c] = c;
  for (let f = 0; f < m.faceCount; f++) {
    if (sel && !sel[f]) continue;
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1],
      n = e - s;
    // keep the first corner, reverse the rest
    for (let k = 1; k < n; k++) {
      corners[s + k] = m.corners[s + n - k];
      cmap[s + k] = s + n - k;
    }
  }
  const out = new MeshComponent(m.positions, m.faceOffsets, corners, m.looseEdges, new Map(), m.materials);
  for (const [name, a] of m.attrs) {
    if (a.domain === 'CORNER') {
      const comps = dataComps(a.type);
      const d = allocData(a.type, nc);
      for (let c = 0; c < nc; c++) for (let k = 0; k < comps; k++) d[c * comps + k] = a.data[cmap[c] * comps + k];
      out.attrs.set(name, { ...a, data: d });
    } else if (a.domain === 'EDGE') {
      // edges are the same vertex pairs; topology order may change
      const ot = m.topology(),
        nt = out.topology();
      const h = new EdgeHash(nt.edgeCount);
      for (let e = 0; e < nt.edgeCount; e++) h.getOrAdd(nt.edges[e * 2], nt.edges[e * 2 + 1], e);
      const comps = dataComps(a.type);
      const d = allocData(a.type, nt.edgeCount);
      for (let e = 0; e < ot.edgeCount; e++) {
        const j = h.get(ot.edges[e * 2], ot.edges[e * 2 + 1]);
        if (j >= 0) for (let k = 0; k < comps; k++) d[j * comps + k] = a.data[e * comps + k];
      }
      out.attrs.set(name, { ...a, data: d });
    } else out.attrs.set(name, a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Triangulate

function d2(P: Float32Array, a: number, b: number) {
  return (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
}

/** Smallest angle of a triangle (radians). */
function minAngle(P: Float32Array, a: number, b: number, c: number) {
  const ang = (o: number, p: number, q: number) => {
    const ux = P[p * 3] - P[o * 3],
      uy = P[p * 3 + 1] - P[o * 3 + 1],
      uz = P[p * 3 + 2] - P[o * 3 + 2];
    const vx = P[q * 3] - P[o * 3],
      vy = P[q * 3 + 1] - P[o * 3 + 1],
      vz = P[q * 3 + 2] - P[o * 3 + 2];
    const l = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
    return l ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / l))) : 0;
  };
  return Math.min(ang(a, b, c), ang(b, c, a), ang(c, a, b));
}

/** Local triangle corner indices (into the face) for a quad by method. */
function quadSplit(P: Float32Array, v: ArrayLike<number>, method: string): number[] {
  const first = [0, 1, 2, 0, 2, 3],
    second = [0, 1, 3, 1, 2, 3];
  switch (method) {
    case 'Fixed':
      return first;
    case 'Fixed Alternate':
      return second;
    case 'Longest Diagonal':
      return d2(P, v[0], v[2]) >= d2(P, v[1], v[3]) ? first : second;
    case 'Beauty': {
      const a = Math.min(minAngle(P, v[0], v[1], v[2]), minAngle(P, v[0], v[2], v[3]));
      const b = Math.min(minAngle(P, v[0], v[1], v[3]), minAngle(P, v[1], v[2], v[3]));
      return a >= b ? first : second;
    }
    default:
      return d2(P, v[0], v[2]) <= d2(P, v[1], v[3]) ? first : second;
  }
}

/** Improve an n-gon triangulation by flipping interior diagonals (maximizes minimum angles). */
function beautify(P: Float32Array, verts: ArrayLike<number>, tris: number[]) {
  for (let iter = 0; iter < 32; iter++) {
    let flipped = false;
    for (let i = 0; i < tris.length; i += 3)
      for (let j = i + 3; j < tris.length; j += 3) {
        const A = tris.slice(i, i + 3),
          B = tris.slice(j, j + 3);
        const shared = A.filter((x) => B.includes(x));
        if (shared.length !== 2) continue;
        const [s0, s1] = shared;
        // interior diagonals only (not polygon boundary edges)
        const n = verts.length;
        if (Math.abs(s0 - s1) === 1 || Math.abs(s0 - s1) === n - 1) continue;
        const a = A.find((x) => !shared.includes(x))!,
          b = B.find((x) => !shared.includes(x))!;
        const g = (x: number) => verts[x];
        const before = Math.min(minAngle(P, g(A[0]), g(A[1]), g(A[2])), minAngle(P, g(B[0]), g(B[1]), g(B[2])));
        // keep winding: A = (s0 → s1 → a) order as in A
        const ia = A.indexOf(a);
        const nA = [a, A[(ia + 1) % 3], b],
          nB = [b, B[(B.indexOf(b) + 1) % 3], a];
        const after = Math.min(minAngle(P, g(nA[0]), g(nA[1]), g(nA[2])), minAngle(P, g(nB[0]), g(nB[1]), g(nB[2])));
        // only flip when the quad (a, s, b, s') is convex: both new triangles keep orientation
        const nrm = polyNormal(P, verts);
        const ok = (t: number[]) => {
          const tn = polyNormal(P, [g(t[0]), g(t[1]), g(t[2])]);
          return tn[0] * nrm[0] + tn[1] * nrm[1] + tn[2] * nrm[2] > 0.1;
        };
        if (after > before + 1e-6 && ok(nA) && ok(nB)) {
          tris.splice(i, 3, ...nA);
          tris.splice(j, 3, ...nB);
          flipped = true;
        }
      }
    if (!flipped) break;
  }
}

export function triangulate(m: MeshComponent, sel: Uint8Array | null, quadMethod: string, ngonMethod: string): MeshComponent {
  const r = new Rebuild(m);
  for (let v = 0; v < m.vertCount; v++) r.copyVert(v);
  const P = m.positions;
  const tmp: number[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1],
      n = e - s;
    const verts = m.corners.subarray(s, e);
    if (n <= 3 || (sel && !sel[f])) {
      r.face(
        Array.from(verts),
        Array.from({ length: n }, (_, k) => s + k),
        f,
      );
      continue;
    }
    let local: number[];
    if (n === 4) local = quadSplit(P, verts, quadMethod);
    else {
      tmp.length = 0;
      triangulatePoly(P, verts, tmp, 0);
      local = [...tmp];
      if (ngonMethod === 'Beauty') beautify(P, verts, local);
    }
    for (let i = 0; i < local.length; i += 3) r.face([verts[local[i]], verts[local[i + 1]], verts[local[i + 2]]], [s + local[i], s + local[i + 1], s + local[i + 2]], f);
  }
  for (let i = 0; i < m.looseEdges.length; i += 2) r.edge(m.looseEdges[i], m.looseEdges[i + 1]);
  return r.build();
}

// ---------------------------------------------------------------------------
// Delete / separate

export type DeleteMode = 'ALL' | 'EDGE_FACE' | 'ONLY_FACE';

/** Keep the elements whose `del` flag is 0 on the given domain. */
export function deleteMesh(m: MeshComponent, domain: Domain, del: Uint8Array, mode: DeleteMode): MeshComponent | null {
  const topo = m.topology();
  const nv = m.vertCount,
    nf = m.faceCount,
    ne = topo.edgeCount;
  const keepV = new Uint8Array(nv).fill(1),
    keepE = new Uint8Array(ne).fill(1),
    keepF = new Uint8Array(nf).fill(1);
  if (domain === 'POINT') {
    // ALL removes the points; EDGE_FACE keeps them but removes their edges and faces;
    // ONLY_FACE removes just the faces using them
    if (mode === 'ALL') for (let v = 0; v < nv; v++) if (del[v]) keepV[v] = 0;
    if (mode !== 'ONLY_FACE') for (let e = 0; e < ne; e++) if (del[topo.edges[e * 2]] || del[topo.edges[e * 2 + 1]]) keepE[e] = 0;
    for (let f = 0; f < nf; f++) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) if (del[m.corners[c]]) keepF[f] = 0;
  } else if (domain === 'EDGE') {
    if (mode === 'ONLY_FACE') {
      for (let f = 0; f < nf; f++) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) if (del[topo.cornerEdge[c]]) keepF[f] = 0;
    } else {
      for (let e = 0; e < ne; e++) if (del[e]) keepE[e] = 0;
      for (let f = 0; f < nf; f++) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) if (!keepE[topo.cornerEdge[c]]) keepF[f] = 0;
      if (mode === 'ALL') {
        // vertices only used by deleted edges disappear
        const usedV = new Uint8Array(nv);
        for (let e = 0; e < ne; e++) if (keepE[e]) usedV[topo.edges[e * 2]] = usedV[topo.edges[e * 2 + 1]] = 1;
        for (let v = 0; v < nv; v++) {
          const hasEdges = topo.vertEdgeOffsets[v + 1] > topo.vertEdgeOffsets[v];
          if (hasEdges && !usedV[v]) keepV[v] = 0;
        }
      }
    }
  } else if (domain === 'FACE') {
    for (let f = 0; f < nf; f++) if (del[f]) keepF[f] = 0;
    if (mode !== 'ONLY_FACE') {
      // edges only used by deleted faces
      for (let e = 0; e < ne; e++) {
        const a = topo.edgeFaceOffsets[e],
          b = topo.edgeFaceOffsets[e + 1];
        if (b === a) continue;
        let any = false;
        for (let j = a; j < b; j++) if (keepF[topo.edgeFaces[j]]) any = true;
        if (!any) keepE[e] = 0;
      }
      if (mode === 'ALL') {
        const usedV = new Uint8Array(nv);
        for (let e = 0; e < ne; e++) if (keepE[e]) usedV[topo.edges[e * 2]] = usedV[topo.edges[e * 2 + 1]] = 1;
        for (let v = 0; v < nv; v++) {
          const hasEdges = topo.vertEdgeOffsets[v + 1] > topo.vertEdgeOffsets[v];
          if (hasEdges && !usedV[v]) keepV[v] = 0;
        }
      }
    }
  } else return m;
  const r = new Rebuild(m);
  const vmap = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (keepV[v]) vmap[v] = r.copyVert(v);
  for (let f = 0; f < nf; f++) {
    if (!keepF[f]) continue;
    const vs: number[] = [],
      cs: Src[] = [];
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      vs.push(vmap[m.corners[c]]);
      cs.push(c);
    }
    r.face(vs, cs, f);
  }
  // remaining edges that are not part of kept faces become loose edges
  const inFace = new Uint8Array(ne);
  for (let f = 0; f < nf; f++) if (keepF[f]) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) inFace[topo.cornerEdge[c]] = 1;
  for (let e = 0; e < ne; e++) {
    if (!keepE[e] || inFace[e]) continue;
    const a = vmap[topo.edges[e * 2]],
      b = vmap[topo.edges[e * 2 + 1]];
    if (a >= 0 && b >= 0) r.edge(a, b);
  }
  return r.build();
}

function gatherAttrs(src: AttrMap, keep: ArrayLike<number>, domainOf: (d: Domain) => boolean, n: number): AttrMap {
  const out: AttrMap = new Map();
  for (const [name, a] of src) {
    if (!domainOf(a.domain)) continue;
    const comps = dataComps(a.type);
    const d = allocData(a.type, n);
    for (let i = 0; i < n; i++) for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[keep[i] * comps + k];
    out.set(name, { ...a, data: d });
  }
  return out;
}

export function deletePoints(p: PointsComponent, del: Uint8Array): PointsComponent {
  const keep: number[] = [];
  for (let i = 0; i < p.count; i++) if (!del[i]) keep.push(i);
  const pos = new Float32Array(keep.length * 3);
  keep.forEach((s, i) => pos.set(p.positions.subarray(s * 3, s * 3 + 3), i * 3));
  return new PointsComponent(
    pos,
    gatherAttrs(p.attrs, keep, (d) => d === 'POINT', keep.length),
    p.materials,
  );
}

export function deleteCurves(c: CurvesComponent, domain: Domain, del: Uint8Array): CurvesComponent {
  const keepP: number[] = [],
    keepC: number[] = [],
    offs: number[] = [0];
  for (let k = 0; k < c.curveCount; k++) {
    if (domain === 'CURVE' && del[k]) continue;
    let n = 0;
    for (let i = c.curveOffsets[k]; i < c.curveOffsets[k + 1]; i++) {
      if (domain === 'POINT' && del[i]) continue;
      keepP.push(i);
      n++;
    }
    if (!n) continue;
    keepC.push(k);
    offs.push(keepP.length);
  }
  const pos = new Float32Array(keepP.length * 3);
  keepP.forEach((s, i) => pos.set(c.positions.subarray(s * 3, s * 3 + 3), i * 3));
  const attrs = gatherAttrs(c.attrs, keepP, (d) => d === 'POINT', keepP.length);
  for (const [k, v] of gatherAttrs(c.attrs, keepC, (d) => d === 'CURVE', keepC.length)) attrs.set(k, v);
  return new CurvesComponent(
    pos,
    Uint32Array.from(offs),
    Uint8Array.from(keepC, (k) => c.cyclic[k]),
    attrs,
    c.materials,
  );
}

// ---------------------------------------------------------------------------
// Merge by distance

/** Cluster positions within `dist` (only selected ones); returns representative index per point. */
export function weldTargets(P: Float32Array, sel: Uint8Array | null, dist: number, connected?: { edges: Uint32Array }): Int32Array {
  const n = P.length / 3;
  const target = new Int32Array(n);
  for (let i = 0; i < n; i++) target[i] = i;
  const d2 = dist * dist;
  if (connected) {
    // only merge along existing edges (union-find)
    const parent = Int32Array.from(target);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    const E = connected.edges;
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e],
        b = E[e + 1];
      if (sel && (!sel[a] || !sel[b])) continue;
      if ((P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2 <= d2) {
        const ra = find(a),
          rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
    for (let i = 0; i < n; i++) target[i] = find(i);
    return target;
  }
  const cell = Math.max(dist, 1e-7);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    const x = P[i * 3],
      y = P[i * 3 + 1],
      z = P[i * 3 + 2];
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell),
      gz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!list) continue;
          for (const u of list)
            if ((P[u * 3] - x) ** 2 + (P[u * 3 + 1] - y) ** 2 + (P[u * 3 + 2] - z) ** 2 <= d2) {
              found = u;
              break;
            }
        }
    if (found >= 0) target[i] = found;
    else {
      const k = `${gx},${gy},${gz}`;
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  }
  return target;
}

export function mergeMesh(m: MeshComponent, sel: Uint8Array | null, dist: number, connected: boolean): MeshComponent {
  const target = weldTargets(m.positions, sel, dist, connected ? { edges: m.topology().edges } : undefined);
  let changed = false;
  for (let i = 0; i < target.length; i++) if (target[i] !== i) changed = true;
  if (!changed) return m;
  const nv = m.vertCount;
  // members per representative (positions/attributes are averaged)
  const members = new Map<number, number[]>();
  for (let v = 0; v < nv; v++) {
    const t = target[v];
    const l = members.get(t);
    if (l) l.push(v);
    else members.set(t, [v]);
  }
  const r = new Rebuild(m);
  const vmap = new Int32Array(nv).fill(-1);
  const P = m.positions;
  for (let v = 0; v < nv; v++) {
    if (target[v] !== v) continue;
    const ms = members.get(v)!;
    if (ms.length === 1) vmap[v] = r.copyVert(v);
    else {
      let x = 0,
        y = 0,
        z = 0;
      const src: number[] = [];
      for (const u of ms) {
        x += P[u * 3] / ms.length;
        y += P[u * 3 + 1] / ms.length;
        z += P[u * 3 + 2] / ms.length;
        src.push(u, 1 / ms.length);
      }
      vmap[v] = r.vert(x, y, z, src);
    }
  }
  for (let v = 0; v < nv; v++) if (target[v] !== v) vmap[v] = vmap[target[v]];
  const topo = m.topology();
  const edgeSeen = new EdgeHash(topo.edgeCount);
  let edgeCount = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const vs: number[] = [],
      cs: Src[] = [];
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      const v = vmap[m.corners[c]];
      if (vs.length && vs[vs.length - 1] === v) continue;
      vs.push(v);
      cs.push(c);
    }
    while (vs.length > 1 && vs[0] === vs[vs.length - 1]) {
      vs.pop();
      cs.pop();
    }
    if (new Set(vs).size >= 3 && new Set(vs).size === vs.length) {
      r.face(vs, cs, f);
      for (let k = 0; k < vs.length; k++) edgeSeen.getOrAdd(vs[k], vs[(k + 1) % vs.length], edgeCount++);
    }
  }
  // keep edges (loose, or of collapsed faces) that still connect two distinct vertices
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = vmap[topo.edges[e * 2]],
      b = vmap[topo.edges[e * 2 + 1]];
    if (a === b) continue;
    if (edgeSeen.get(a, b) >= 0) continue;
    edgeSeen.getOrAdd(a, b, edgeCount++);
    r.edge(a, b);
  }
  return r.build();
}

export function mergePoints(p: PointsComponent, sel: Uint8Array | null, dist: number): PointsComponent {
  const target = weldTargets(p.positions, sel, dist);
  const keep: number[] = [];
  for (let i = 0; i < target.length; i++) if (target[i] === i) keep.push(i);
  if (keep.length === p.count) return p;
  const pos = new Float32Array(keep.length * 3);
  keep.forEach((s, i) => pos.set(p.positions.subarray(s * 3, s * 3 + 3), i * 3));
  return new PointsComponent(
    pos,
    gatherAttrs(p.attrs, keep, (d) => d === 'POINT', keep.length),
    p.materials,
  );
}

// ---------------------------------------------------------------------------
// Conversions

export function meshToPoints(m: MeshComponent, mode: 'VERTICES' | 'EDGES' | 'FACES' | 'CORNERS', sel: Uint8Array | null, pos: Float32Array, radius: Float32Array): PointsComponent {
  const domain: Domain = mode === 'VERTICES' ? 'POINT' : mode === 'EDGES' ? 'EDGE' : mode === 'FACES' ? 'FACE' : 'CORNER';
  const n = m.domainSize(domain);
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!sel || sel[i]) keep.push(i);
  const P = new Float32Array(keep.length * 3),
    R = new Float32Array(keep.length);
  keep.forEach((s, i) => {
    P.set(pos.subarray(s * 3, s * 3 + 3), i * 3);
    R[i] = radius[s];
  });
  const attrs: AttrMap = new Map();
  for (const [name, a] of m.attrs) {
    if (name === 'sharp_face' || name === 'sharp_edge') continue;
    const data = a.domain === domain ? a.data : adaptDomain(m, a.data, a.type, a.domain, domain);
    const comps = dataComps(a.type);
    const d = allocData(a.type, keep.length);
    keep.forEach((s, i) => {
      for (let k = 0; k < comps; k++) d[i * comps + k] = data[s * comps + k];
    });
    attrs.set(name, { domain: 'POINT', type: a.type, data: d });
  }
  attrs.set('radius', { domain: 'POINT', type: 'FLOAT', data: R });
  return new PointsComponent(P, attrs, m.materials);
}

export function pointsToVertices(p: PointsComponent, sel: Uint8Array | null): MeshComponent {
  const keep: number[] = [];
  for (let i = 0; i < p.count; i++) if (!sel || sel[i]) keep.push(i);
  const pos = new Float32Array(keep.length * 3);
  keep.forEach((s, i) => pos.set(p.positions.subarray(s * 3, s * 3 + 3), i * 3));
  const attrs = gatherAttrs(p.attrs, keep, (d) => d === 'POINT', keep.length);
  attrs.delete('radius');
  return new MeshComponent(pos, new Uint32Array([0]), new Uint32Array(0), new Uint32Array(0), attrs, p.materials);
}

/** Chains of selected edges as poly curves (closed loops become cyclic). */
export function meshEdgesToCurves(m: MeshComponent, sel: Uint8Array | null): CurvesComponent {
  const topo = m.topology();
  const ne = topo.edgeCount,
    nv = m.vertCount;
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (let e = 0; e < ne; e++) {
    if (sel && !sel[e]) continue;
    adj[topo.edges[e * 2]].push(e);
    adj[topo.edges[e * 2 + 1]].push(e);
  }
  const used = new Uint8Array(ne);
  const curves: number[][] = [],
    cyclic: boolean[] = [];
  const other = (e: number, v: number) => (topo.edges[e * 2] === v ? topo.edges[e * 2 + 1] : topo.edges[e * 2]);
  const walk = (start: number, e0: number) => {
    const pts = [start];
    let v = start,
      e = e0;
    for (;;) {
      used[e] = 1;
      v = other(e, v);
      if (v === start) return { pts, cyc: true };
      pts.push(v);
      if (adj[v].length !== 2) return { pts, cyc: false };
      const next = adj[v].find((x) => !used[x]);
      if (next === undefined) return { pts, cyc: false };
      e = next;
    }
  };
  // start at chain ends (valence != 2) first
  for (let v = 0; v < nv; v++) {
    if (adj[v].length === 2 || !adj[v].length) continue;
    for (const e of adj[v]) {
      if (used[e]) continue;
      const r = walk(v, e);
      curves.push(r.pts);
      cyclic.push(r.cyc);
    }
  }
  for (let e = 0; e < ne; e++) {
    if (used[e] || (sel && !sel[e])) continue;
    const r = walk(topo.edges[e * 2], e);
    curves.push(r.pts);
    cyclic.push(r.cyc);
  }
  return curvesFromIndexLists(m, curves, cyclic);
}

export function meshFacesToCurves(m: MeshComponent, sel: Uint8Array | null): CurvesComponent {
  const curves: number[][] = [],
    cyclic: boolean[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    if (sel && !sel[f]) continue;
    curves.push(Array.from(m.corners.subarray(m.faceOffsets[f], m.faceOffsets[f + 1])));
    cyclic.push(true);
  }
  return curvesFromIndexLists(m, curves, cyclic);
}

function curvesFromIndexLists(m: MeshComponent, curves: number[][], cyclic: boolean[]): CurvesComponent {
  const flat = curves.flat();
  const pos = new Float32Array(flat.length * 3);
  flat.forEach((v, i) => pos.set(m.positions.subarray(v * 3, v * 3 + 3), i * 3));
  const offs = new Uint32Array(curves.length + 1);
  let o = 0;
  curves.forEach((c, i) => {
    offs[i] = o;
    o += c.length;
  });
  offs[curves.length] = o;
  const attrs = gatherAttrs(m.attrs, flat, (d) => d === 'POINT', flat.length);
  return new CurvesComponent(
    pos,
    offs,
    Uint8Array.from(cyclic, (x) => (x ? 1 : 0)),
    attrs,
    m.materials,
  );
}

export { faceCenters };
