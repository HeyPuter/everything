// Element-level mesh / point operations: split edges, scale elements, duplicate elements, sort
// elements and merging points by id.
import { EdgeHash, MeshComponent, PointsComponent, CurvesComponent, InstancesComponent, allocData, dataComps, type AttrMap, type Component } from '../geometry';
import type { Domain } from '../types';
import { Rebuild, type Src } from './rebuild';
import { directedCorners, nextCorner } from './dual';

// ---------------------------------------------------------------------------
// Split edges

/**
 * Split the mesh along selected edges: faces on either side of a split edge get their own
 * vertices. For every vertex, the fans of corners separated by split edges each get a vertex;
 * the last fan keeps the original index, the others get new vertices appended.
 */
export function splitEdges(m: MeshComponent, edgeSel: Uint8Array | null): MeshComponent {
  const topo = m.topology();
  const nv = m.vertCount,
    nc = m.cornerCount;
  const split = (e: number) => !edgeSel || !!edgeSel[e];
  // union corners of a vertex across unsplit edges shared by two faces
  const parent = new Int32Array(nc);
  for (let c = 0; c < nc; c++) parent[c] = c;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const dir = directedCorners(m);
  for (let f = 0; f < m.faceCount; f++)
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      const e = topo.cornerEdge[c];
      if (split(e)) continue;
      // edge c→next: the corner of the other face at the next vertex, and at this vertex
      const a = m.corners[c],
        b = m.corners[nextCorner(m, f, c)];
      const o = dir.get(b * nv + a);
      if (o === undefined) continue;
      const of = topo.cornerFace[o];
      // other face: o is at b, its next corner is at a
      union(nextCorner(m, f, c), o);
      union(c, nextCorner(m, of, o));
    }
  const newVert = new Int32Array(nc);
  const sources: number[] = [];
  for (let v = 0; v < nv; v++) {
    const a = topo.vertFaceOffsets[v],
      b = topo.vertFaceOffsets[v + 1];
    const roots: number[] = [];
    for (let k = a; k < b; k++) {
      const r = find(topo.vertCorners[k]);
      if (!roots.includes(r)) roots.push(r);
    }
    roots.sort((x, y) => x - y);
    const ids = new Map<number, number>();
    roots.forEach((r, i) => {
      if (i === roots.length - 1) ids.set(r, v);
      else {
        ids.set(r, nv + sources.length);
        sources.push(v);
      }
    });
    for (let k = a; k < b; k++) {
      const c = topo.vertCorners[k];
      newVert[c] = ids.get(find(c))!;
    }
  }
  if (!sources.length) return m;
  const r = new Rebuild(m);
  for (let v = 0; v < nv; v++) r.copyVert(v);
  for (const s of sources) r.copyVert(s);
  for (let f = 0; f < m.faceCount; f++) {
    const vs: number[] = [],
      cs: Src[] = [];
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      vs.push(newVert[c]);
      cs.push(c);
    }
    r.face(vs, cs, f);
  }
  for (let i = 0; i < m.looseEdges.length; i += 2) r.edge(m.looseEdges[i], m.looseEdges[i + 1]);
  return r.build();
}

// ---------------------------------------------------------------------------
// Scale elements

export interface ScaleInput {
  sel: Uint8Array | null;
  scale: ArrayLike<number>;
  center: ArrayLike<number>;
  axis: ArrayLike<number> | null;
}

/** Scale vertex-connected groups of selected faces or edges around their mean centre. */
export function scaleElements(m: MeshComponent, domain: 'FACE' | 'EDGE', inp: ScaleInput): MeshComponent {
  const topo = m.topology();
  const n = domain === 'FACE' ? m.faceCount : topo.edgeCount;
  const vertsOf = (i: number): ArrayLike<number> => (domain === 'FACE' ? m.corners.subarray(m.faceOffsets[i], m.faceOffsets[i + 1]) : topo.edges.subarray(i * 2, i * 2 + 2));
  // union elements sharing a vertex
  const owner = new Int32Array(m.vertCount).fill(-1);
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let i = 0; i < n; i++) {
    if (inp.sel && !inp.sel[i]) continue;
    for (const v of Array.from(vertsOf(i))) {
      if (owner[v] < 0) owner[v] = i;
      else {
        const a = find(owner[v]),
          b = find(i);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, { c: number[]; s: number; a: number[]; n: number }>();
  for (let i = 0; i < n; i++) {
    if (inp.sel && !inp.sel[i]) continue;
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { c: [0, 0, 0], s: 0, a: [0, 0, 0], n: 0 }));
    for (let k = 0; k < 3; k++) g.c[k] += inp.center[i * 3 + k];
    g.s += inp.scale[i];
    if (inp.axis) for (let k = 0; k < 3; k++) g.a[k] += inp.axis[i * 3 + k];
    g.n++;
  }
  const P = new Float32Array(m.positions);
  const done = new Uint8Array(m.vertCount);
  for (let i = 0; i < n; i++) {
    if (inp.sel && !inp.sel[i]) continue;
    const g = groups.get(find(i))!;
    const c = g.c.map((x) => x / g.n);
    const s = g.s / g.n;
    let ax: number[] | null = null;
    if (inp.axis) {
      const l = Math.hypot(g.a[0], g.a[1], g.a[2]);
      ax = l > 0 ? g.a.map((x) => x / l) : [0, 0, 0];
    }
    for (const v of Array.from(vertsOf(i))) {
      if (done[v]) continue;
      done[v] = 1;
      const d = [P[v * 3] - c[0], P[v * 3 + 1] - c[1], P[v * 3 + 2] - c[2]];
      if (ax) {
        const t = (d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) * (s - 1);
        for (let k = 0; k < 3; k++) P[v * 3 + k] += ax[k] * t;
      } else for (let k = 0; k < 3; k++) P[v * 3 + k] = c[k] + d[k] * s;
    }
  }
  return m.withPositions(P);
}

// ---------------------------------------------------------------------------
// Duplicate elements

/** Gather attributes of one domain through a source map. */
function gatherAttrs(src: AttrMap, domain: Domain, map: ArrayLike<number>, dst: AttrMap) {
  for (const [name, a] of src) {
    if (a.domain !== domain) continue;
    const comps = dataComps(a.type);
    const d = allocData(a.type, map.length);
    for (let i = 0; i < map.length; i++) for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[map[i] * comps + k];
    dst.set(name, { domain, type: a.type, data: d });
  }
}

export interface DuplicateResult {
  geometry: Component;
  /** duplicate index per output element of the domain */
  index: Int32Array;
  domain: Domain;
}

/**
 * Copy every selected element `counts[i]` times. Mesh points become loose vertices, mesh edges
 * separate edges and mesh faces separate faces; curves, point clouds and instances copy whole
 * elements.
 */
export function duplicateElements(c: Component, domain: Domain, sel: Uint8Array | null, counts: ArrayLike<number>): DuplicateResult | null {
  const n = c.domainSize(domain);
  const src: number[] = [];
  const dup: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    const k = Math.max(0, Math.round(counts[i]));
    for (let j = 0; j < k; j++) {
      src.push(i);
      dup.push(j);
    }
  }
  const index = Int32Array.from(dup);
  if (c.kind === 'MESH') {
    const m = c;
    if (domain === 'POINT') {
      const pos = new Float32Array(src.length * 3);
      src.forEach((s, i) => pos.set(m.positions.subarray(s * 3, s * 3 + 3), i * 3));
      const out = new MeshComponent(pos, new Uint32Array([0]), new Uint32Array(0), new Uint32Array(0), new Map(), [...m.materials]);
      gatherAttrs(m.attrs, 'POINT', src, out.attrs);
      return { geometry: out, index, domain: 'POINT' };
    }
    if (domain === 'EDGE') {
      const topo = m.topology();
      const pos = new Float32Array(src.length * 6);
      const vsrc: number[] = [];
      const loose = new Uint32Array(src.length * 2);
      src.forEach((e, i) => {
        const a = topo.edges[e * 2],
          b = topo.edges[e * 2 + 1];
        pos.set(m.positions.subarray(a * 3, a * 3 + 3), i * 6);
        pos.set(m.positions.subarray(b * 3, b * 3 + 3), i * 6 + 3);
        vsrc.push(a, b);
        loose[i * 2] = i * 2;
        loose[i * 2 + 1] = i * 2 + 1;
      });
      const out = new MeshComponent(pos, new Uint32Array([0]), new Uint32Array(0), loose, new Map(), [...m.materials]);
      gatherAttrs(m.attrs, 'POINT', vsrc, out.attrs);
      gatherAttrs(m.attrs, 'EDGE', src, out.attrs);
      return { geometry: out, index, domain: 'EDGE' };
    }
    if (domain === 'FACE') {
      const r = new Rebuild(m);
      for (const f of src) {
        const vs: number[] = [],
          cs: number[] = [];
        for (let k = m.faceOffsets[f]; k < m.faceOffsets[f + 1]; k++) {
          vs.push(r.copyVert(m.corners[k]));
          cs.push(k);
        }
        r.face(vs, cs, f);
      }
      return { geometry: r.build(), index, domain: 'FACE' };
    }
    return null;
  }
  if (c.kind === 'POINTS' && domain === 'POINT') {
    const pos = new Float32Array(src.length * 3);
    src.forEach((s, i) => pos.set(c.positions.subarray(s * 3, s * 3 + 3), i * 3));
    const out = new PointsComponent(pos, new Map(), [...c.materials]);
    gatherAttrs(c.attrs, 'POINT', src, out.attrs);
    return { geometry: out, index, domain: 'POINT' };
  }
  if (c.kind === 'CURVES' && (domain === 'CURVE' || domain === 'POINT')) {
    if (domain === 'POINT') {
      // points of curves become a point cloud
      const pos = new Float32Array(src.length * 3);
      src.forEach((s, i) => pos.set(c.positions.subarray(s * 3, s * 3 + 3), i * 3));
      const out = new PointsComponent(pos, new Map(), [...c.materials]);
      gatherAttrs(c.attrs, 'POINT', src, out.attrs);
      return { geometry: out, index, domain: 'POINT' };
    }
    const pts: number[] = [];
    const offs: number[] = [0];
    for (const k of src) {
      for (let p = c.curveOffsets[k]; p < c.curveOffsets[k + 1]; p++) pts.push(p);
      offs.push(pts.length);
    }
    const pos = new Float32Array(pts.length * 3);
    pts.forEach((s, i) => pos.set(c.positions.subarray(s * 3, s * 3 + 3), i * 3));
    const out = new CurvesComponent(
      pos,
      Uint32Array.from(offs),
      Uint8Array.from(src, (k) => c.cyclic[k]),
      new Map(),
      [...c.materials],
    );
    gatherAttrs(c.attrs, 'POINT', pts, out.attrs);
    gatherAttrs(c.attrs, 'CURVE', src, out.attrs);
    return { geometry: out, index, domain: 'CURVE' };
  }
  if (c.kind === 'INSTANCES' && domain === 'INSTANCE') {
    const T = new Float32Array(src.length * 16);
    src.forEach((s, i) => T.set(c.transforms.subarray(s * 16, s * 16 + 16), i * 16));
    const out = new InstancesComponent(
      T,
      Int32Array.from(src, (s) => c.refIndex[s]),
      c.references,
      new Map(),
    );
    gatherAttrs(c.attrs, 'INSTANCE', src, out.attrs);
    return { geometry: out, index, domain: 'INSTANCE' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sort elements

/** New order of the elements: selected ones are sorted (by group, then weight) within their slots. */
export function sortOrder(n: number, sel: Uint8Array | null, group: ArrayLike<number>, weight: ArrayLike<number>): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const slots: number[] = [];
  for (let i = 0; i < n; i++) if (!sel || sel[i]) slots.push(i);
  const sorted = slots.slice().sort((a, b) => group[a] - group[b] || weight[a] - weight[b] || a - b);
  slots.forEach((s, k) => (order[s] = sorted[k]));
  return order;
}

/** Reorder the elements of a domain: `order[newIndex] = oldIndex`. */
export function reorder(c: Component, domain: Domain, order: Int32Array): Component {
  const n = order.length;
  const inv = new Int32Array(n);
  for (let i = 0; i < n; i++) inv[order[i]] = i;
  const permute = (attrs: AttrMap, dom: Domain, out: AttrMap) => {
    for (const [name, a] of attrs) {
      if (a.domain !== dom) {
        out.set(name, a);
        continue;
      }
      const comps = dataComps(a.type);
      const d = allocData(a.type, n);
      for (let i = 0; i < n; i++) for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[order[i] * comps + k];
      out.set(name, { ...a, data: d });
    }
  };
  const perm3 = (p: Float32Array) => {
    const o = new Float32Array(p.length);
    for (let i = 0; i < n; i++) o.set(p.subarray(order[i] * 3, order[i] * 3 + 3), i * 3);
    return o;
  };
  if (c.kind === 'MESH') {
    if (domain === 'POINT') {
      const out = new MeshComponent(
        perm3(c.positions),
        c.faceOffsets,
        Uint32Array.from(c.corners, (v) => inv[v]),
        Uint32Array.from(c.looseEdges, (v) => inv[v]),
        new Map(),
        [...c.materials],
      );
      permute(c.attrs, 'POINT', out.attrs);
      return out;
    }
    if (domain === 'FACE') {
      const offs: number[] = [0];
      const corners: number[] = [];
      const cmap: number[] = [];
      for (let i = 0; i < n; i++) {
        const f = order[i];
        for (let k = c.faceOffsets[f]; k < c.faceOffsets[f + 1]; k++) {
          corners.push(c.corners[k]);
          cmap.push(k);
        }
        offs.push(corners.length);
      }
      const out = new MeshComponent(c.positions, Uint32Array.from(offs), Uint32Array.from(corners), c.looseEdges, new Map(), [...c.materials]);
      const tmp: AttrMap = new Map();
      permute(c.attrs, 'FACE', tmp);
      for (const [name, a] of tmp) {
        if (a.domain !== 'CORNER') {
          out.attrs.set(name, a);
          continue;
        }
        const comps = dataComps(a.type);
        const d = allocData(a.type, cmap.length);
        cmap.forEach((s, i) => {
          for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
        });
        out.attrs.set(name, { ...a, data: d });
      }
      // edge attributes follow their vertex pairs
      return remapEdgeAttrs(c, out);
    }
    if (domain === 'EDGE') {
      // edge order follows the faces; only meshes made of loose edges can be reordered
      if (c.faceCount) return c;
      const loose = new Uint32Array(n * 2);
      for (let i = 0; i < n; i++) {
        loose[i * 2] = c.looseEdges[order[i] * 2];
        loose[i * 2 + 1] = c.looseEdges[order[i] * 2 + 1];
      }
      const out = new MeshComponent(c.positions, c.faceOffsets, c.corners, loose, new Map(), [...c.materials]);
      permute(c.attrs, 'EDGE', out.attrs);
      return out;
    }
    return c;
  }
  if (c.kind === 'POINTS' && domain === 'POINT') {
    const out = new PointsComponent(perm3(c.positions), new Map(), [...c.materials]);
    permute(c.attrs, 'POINT', out.attrs);
    return out;
  }
  if (c.kind === 'CURVES' && domain === 'CURVE') {
    const pts: number[] = [];
    const offs: number[] = [0];
    for (let i = 0; i < n; i++) {
      const k = order[i];
      for (let p = c.curveOffsets[k]; p < c.curveOffsets[k + 1]; p++) pts.push(p);
      offs.push(pts.length);
    }
    const pos = new Float32Array(pts.length * 3);
    pts.forEach((s, i) => pos.set(c.positions.subarray(s * 3, s * 3 + 3), i * 3));
    const out = new CurvesComponent(
      pos,
      Uint32Array.from(offs),
      Uint8Array.from(order, (k) => c.cyclic[k]),
      new Map(),
      [...c.materials],
    );
    const tmp: AttrMap = new Map();
    permute(c.attrs, 'CURVE', tmp);
    for (const [name, a] of tmp) {
      if (a.domain !== 'POINT') {
        out.attrs.set(name, a);
        continue;
      }
      const comps = dataComps(a.type);
      const d = allocData(a.type, pts.length);
      pts.forEach((s, i) => {
        for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
      });
      out.attrs.set(name, { ...a, data: d });
    }
    return out;
  }
  if (c.kind === 'INSTANCES' && domain === 'INSTANCE') {
    const T = new Float32Array(c.transforms.length);
    for (let i = 0; i < n; i++) T.set(c.transforms.subarray(order[i] * 16, order[i] * 16 + 16), i * 16);
    const out = new InstancesComponent(
      T,
      Int32Array.from(order, (k) => c.refIndex[k]),
      c.references,
      new Map(),
    );
    permute(c.attrs, 'INSTANCE', out.attrs);
    return out;
  }
  return c;
}

/** Carry edge attributes over to a mesh with the same vertices but rebuilt topology. */
function remapEdgeAttrs(old: MeshComponent, out: MeshComponent): MeshComponent {
  const edgeAttrs = [...old.attrs].filter(([, a]) => a.domain === 'EDGE');
  if (!edgeAttrs.length) return out;
  const ot = old.topology(),
    nt = out.topology();
  const h = new EdgeHash(ot.edgeCount);
  for (let e = 0; e < ot.edgeCount; e++) h.getOrAdd(ot.edges[e * 2], ot.edges[e * 2 + 1], e);
  const map = new Int32Array(nt.edgeCount);
  for (let e = 0; e < nt.edgeCount; e++) map[e] = h.get(nt.edges[e * 2], nt.edges[e * 2 + 1]);
  for (const [name, a] of edgeAttrs) {
    const comps = dataComps(a.type);
    const d = allocData(a.type, nt.edgeCount);
    for (let e = 0; e < nt.edgeCount; e++) if (map[e] >= 0) for (let k = 0; k < comps; k++) d[e * comps + k] = a.data[map[e] * comps + k];
    out.attrs.set(name, { ...a, data: d });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge points by id

/** Merge selected points sharing an id into one point at their mean position. */
export function mergeMeshById(m: MeshComponent, sel: Uint8Array | null, ids: ArrayLike<number>): MeshComponent {
  const nv = m.vertCount;
  const first = new Map<number, number>();
  const target = new Int32Array(nv);
  let changed = false;
  for (let v = 0; v < nv; v++) {
    target[v] = v;
    if (sel && !sel[v]) continue;
    const id = ids[v];
    const f = first.get(id);
    if (f === undefined) first.set(id, v);
    else {
      target[v] = f;
      changed = true;
    }
  }
  if (!changed) return m;
  return weldMesh(m, target);
}

/** Weld vertices onto targets (target[v] ≤ v); faces that collapse or repeat are removed. */
export function weldMesh(m: MeshComponent, target: Int32Array): MeshComponent {
  const nv = m.vertCount;
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
  const faceSeen = new Set<string>();
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
    if (vs.length < 3 || new Set(vs).size !== vs.length) continue;
    const key = vs
      .slice()
      .sort((a, b) => a - b)
      .join(',');
    if (faceSeen.has(key)) continue;
    faceSeen.add(key);
    r.face(vs, cs, f);
    for (let k = 0; k < vs.length; k++) edgeSeen.getOrAdd(vs[k], vs[(k + 1) % vs.length], edgeCount++);
  }
  for (let e = 0; e < topo.edgeCount; e++) {
    const a = vmap[topo.edges[e * 2]],
      b = vmap[topo.edges[e * 2 + 1]];
    if (a === b || edgeSeen.get(a, b) >= 0) continue;
    edgeSeen.getOrAdd(a, b, edgeCount++);
    r.edge(a, b);
  }
  return r.build();
}

/** Point clouds: unmerged points first (in order), then one point per merged id. */
export function mergePointsById(p: PointsComponent, sel: Uint8Array | null, ids: ArrayLike<number>): PointsComponent {
  const n = p.count;
  const keep: number[] = [];
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) {
      keep.push(i);
      continue;
    }
    const l = groups.get(ids[i]);
    if (l) l.push(i);
    else groups.set(ids[i], [i]);
  }
  const lists: number[][] = [...keep.map((i) => [i]), ...[...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l)];
  if (lists.length === n) return p;
  const pos = new Float32Array(lists.length * 3);
  const out = new PointsComponent(pos, new Map(), [...p.materials]);
  lists.forEach((l, i) => {
    for (const s of l) for (let k = 0; k < 3; k++) pos[i * 3 + k] += p.positions[s * 3 + k] / l.length;
  });
  for (const [name, a] of p.attrs) {
    const comps = dataComps(a.type);
    const d = allocData(a.type, lists.length);
    lists.forEach((l, i) => {
      for (let k = 0; k < comps; k++) {
        let s = 0;
        for (const j of l) s += a.data[j * comps + k];
        s /= l.length;
        d[i * comps + k] = a.type === 'BOOLEAN' ? (s >= 0.5 ? 1 : 0) : a.type === 'INT' || a.type === 'INT8' ? Math.round(s) : s;
      }
    });
    out.attrs.set(name, { ...a, data: d });
  }
  return out;
}
