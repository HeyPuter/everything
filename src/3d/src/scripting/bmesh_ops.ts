// bmesh.ops, part 1: primitives, transforms, delete, extrude, merging, normals, duplicate /
// split, triangulate, poke, connect, fills, bridge, spin, mirror, smoothing, hull, solidify,
// dissolve, join triangles.
import { pyError } from './rna';
import {
  BMesh,
  BMVert,
  BMEdge,
  BMFace,
  BMLoop,
  BMElem,
  type Num3,
  makeVert,
  makeEdge,
  makeFace,
  killVert,
  killEdge,
  killFace,
  flipFace,
  faceLoops,
  faceVerts,
  vertLoops,
  edgeBetween,
  findFace,
  faceNormal,
  faceCenter,
  vertNormal,
  splitFace,
  weldVerts,
  triangulateFace,
  mixCd,
  cloneValue,
  copyGeometry,
  copyLayers,
  dissolveVertInFaces,
  layerValue,
  sub,
  add,
  scale,
  dot,
  cross,
  len,
  dist,
  normalize,
  newell,
  angleBetween,
  mulPoint,
  mulMat,
  invertMat,
  IDENTITY4,
  type Domain,
} from './bmesh_core';
import { defOp, geomSplit, argVerts, argEdges, argFaces, argVec, argMat, argNum, argInt, argEnum, type OpArgs } from './bmesh_opdefs';

// ---------------------------------------------------------------------------
// shared helpers

const geomOut = (verts: Iterable<BMVert>, edges: Iterable<BMEdge>, faces: Iterable<BMFace>): BMElem[] => [...verts, ...edges, ...faces].filter((x) => !!x._bm);

function uvLayer(bm: BMesh) {
  return bm._activeOf('loops', 'uv');
}

function setUV(l: BMLoop, layer: ReturnType<typeof uvLayer>, u: number, v: number) {
  if (!layer) return;
  const d = layerValue(l, layer) as number[];
  d[0] = u;
  d[1] = v;
}

/** Make a face whose winding points away from `center` (primitive building). */
function outwardFace(bm: BMesh, verts: BMVert[], center: ArrayLike<number> = [0, 0, 0]): BMFace {
  const n = newell(verts.map((v) => v._co));
  const c = scale(
    verts.reduce((a, v) => add(a, v._co), [0, 0, 0] as Num3),
    1 / verts.length,
  );
  if (dot(n, sub(c, center)) < 0) verts = [...verts].reverse();
  return makeFace(bm, verts);
}

/** Apply a matrix to the given vertices (primitive `matrix` argument). */
function applyMatrix(verts: BMVert[], m: number[][]) {
  for (const v of verts) {
    const p = mulPoint(m, v._co);
    v._co[0] = p[0];
    v._co[1] = p[1];
    v._co[2] = p[2];
  }
}

function finishPrimitive(bm: BMesh, verts: BMVert[], faces: BMFace[], m: number[][]) {
  applyMatrix(verts, m);
  for (const f of faces) f._no = faceNormal(f);
  for (const v of verts) v._no = vertNormal(v);
  // primitives leave the element indices up to date
  for (const set of [bm._v, bm._e, bm._f] as Set<BMElem>[]) {
    let i = 0;
    for (const e of set) e.index = i++;
  }
  return { verts };
}

/** Space conversion: inv(space) · M · space. */
function inSpace(M: number[][], space: unknown) {
  if (space === null || space === undefined) return M;
  const S = argMat(space, 'space');
  return mulMat(invertMat(S), mulMat(M, S));
}

function transformVerts(verts: BMVert[], M: number[][], shapes: boolean, bm: BMesh) {
  const layers = shapes ? bm._layers('verts', 'shape') : [];
  for (const v of verts) {
    const p = mulPoint(M, v._co);
    v._co[0] = p[0];
    v._co[1] = p[1];
    v._co[2] = p[2];
    for (const l of layers) {
      const d = layerValue(v, l) as number[];
      const q = mulPoint(M, d);
      d[0] = q[0];
      d[1] = q[1];
      d[2] = q[2];
    }
  }
}

const translation = (v: Num3) => [
  [1, 0, 0, v[0]],
  [0, 1, 0, v[1]],
  [0, 0, 1, v[2]],
  [0, 0, 0, 1],
];

/** Rotation matrix about an axis (radians). */
export function axisRotation(axis: Num3, angle: number): number[][] {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
    [0, 0, 0, 1],
  ];
}

/** Ordered chains of edges: {verts, edges, closed}. Branches end chains. */
export function edgeChains(edges: BMEdge[]): { verts: BMVert[]; edges: BMEdge[]; closed: boolean }[] {
  const set = new Set(edges);
  const adj = new Map<BMVert, BMEdge[]>();
  for (const e of set)
    for (const v of [e.v1, e.v2]) {
      let l = adj.get(v);
      if (!l) adj.set(v, (l = []));
      l.push(e);
    }
  const used = new Set<BMEdge>();
  const out: { verts: BMVert[]; edges: BMEdge[]; closed: boolean }[] = [];
  const walk = (start: BMVert, first: BMEdge) => {
    const verts = [start],
      es: BMEdge[] = [];
    let v = start,
      e: BMEdge | undefined = first;
    while (e && !used.has(e)) {
      used.add(e);
      es.push(e);
      v = e.other(v);
      if (v === start) return { verts, edges: es, closed: true };
      verts.push(v);
      const next: BMEdge[] = (adj.get(v) ?? []).filter((x) => !used.has(x));
      e = adj.get(v)!.length === 2 ? next[0] : undefined;
    }
    return { verts, edges: es, closed: false };
  };
  // open chains start at ends / branch points
  for (const [v, l] of adj) if (l.length !== 2) for (const e of l) if (!used.has(e)) out.push(walk(v, e));
  for (const e of set) if (!used.has(e)) out.push(walk(e.v1, e));
  return out;
}

/** Orient a vertex loop so its edges run opposite to the faces already using them. */
function orientAgainstNeighbors(verts: BMVert[], closed = true): BMVert[] {
  let vote = 0;
  const n = verts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = verts[i],
      b = verts[(i + 1) % n];
    const e = edgeBetween(a, b);
    if (!e) continue;
    for (const l of e._l) vote += l.vert === a ? -1 : 1;
  }
  return vote < 0 ? [...verts].reverse() : verts;
}

/** Corner data for a new face from the neighbouring faces' corners at the same vertices. */
function neighborLoopData(verts: BMVert[]): (unknown[] | null)[] {
  return verts.map((v) => {
    const ls = vertLoops(v);
    return ls.length ? ls[0]._cd.map(cloneValue) : null;
  });
}

/**
 * Merge faces into one face along the outline of their union. Returns null (and changes
 * nothing) when the union is not a single disc.
 */
export function mergeRegion(bm: BMesh, faces: BMFace[]): BMFace | null {
  const S = new Set(faces.filter((f) => !!f._bm));
  if (S.size < 2) return S.size ? [...S][0] : null;
  const boundary: BMLoop[] = [];
  const interior = new Set<BMEdge>();
  for (const f of S)
    for (const l of faceLoops(f)) {
      const inS = l.edge._l.filter((o) => S.has(o.face)).length;
      if (inS === 1) boundary.push(l);
      else interior.add(l.edge);
    }
  const startAt = new Map<BMVert, BMLoop>();
  for (const l of boundary) {
    if (startAt.has(l.vert)) return null; // pinched outline
    startAt.set(l.vert, l);
  }
  if (!boundary.length) return null;
  const ring: BMLoop[] = [];
  let l: BMLoop | undefined = boundary[0];
  while (l && ring.length <= boundary.length) {
    ring.push(l);
    l = startAt.get(l._next.vert);
    if (l === boundary[0]) break;
  }
  if (l !== boundary[0] || ring.length !== boundary.length || ring.length < 3) return null;
  const example = [...S].sort((a, b) => b.calc_area() - a.calc_area())[0];
  const verts = ring.map((x) => x.vert);
  const data = ring.map((x) => x._cd.map(cloneValue));
  const edges = ring.map((x) => x.edge);
  const sel = [...S].some((f) => f._sel);
  const wasActive = [...S].includes(bm._active!);
  for (const f of S) killFace(f);
  for (const e of interior) if (e._bm && !e._l.length) killEdge(e);
  for (const f of S) for (const x of faceLoops(f)) if (x.vert._bm && !x.vert._e.length) killVert(x.vert);
  const nf = makeFace(bm, verts, { example, loopData: data, edges });
  nf._sel = sel;
  if (wasActive) bm._active = nf;
  return nf;
}

/** Groups of faces connected through the given edges (union-find). */
function faceGroups(faces: Iterable<BMFace>, through: (e: BMEdge) => boolean): BMFace[][] {
  const parent = new Map<BMFace, BMFace>();
  const find = (f: BMFace): BMFace => {
    let r = f;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let x = f;
    while (parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  for (const f of faces) parent.set(f, f);
  for (const f of parent.keys())
    for (const l of faceLoops(f)) {
      if (!through(l.edge)) continue;
      for (const o of l.edge._l) if (o.face !== f && parent.has(o.face)) parent.set(find(o.face), find(f));
    }
  const groups = new Map<BMFace, BMFace[]>();
  for (const f of parent.keys()) {
    const r = find(f);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(f);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// primitives

defOp('create_vert', { co: [0, 0, 0] }, (bm, a) => ({ vert: [makeVert(bm, argVec(a.co, 'create_vert(co)'))] }));

defOp('create_grid', { x_segments: 1, y_segments: 1, size: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const nx = Math.max(1, argInt(a.x_segments, 'x_segments')),
    ny = Math.max(1, argInt(a.y_segments, 'y_segments'));
  const s = argNum(a.size, 'size');
  const verts: BMVert[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) verts.push(makeVert(bm, [-s + (2 * s * i) / nx, -s + (2 * s * j) / ny, 0]));
  const uv = a.calc_uvs ? uvLayer(bm) : null;
  const faces: BMFace[] = [];
  const at = (i: number, j: number) => verts[j * (nx + 1) + i];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const f = makeFace(bm, [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
      const ls = faceLoops(f);
      const uvs = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      ls.forEach((l, k) => setUV(l, uv, uvs[k][0] / nx, uvs[k][1] / ny));
      faces.push(f);
    }
  return finishPrimitive(bm, verts, faces, argMat(a.matrix, 'matrix'));
});

const CUBE_UV = [
  [0.375, 0, 0.625, 0.25],
  [0.375, 0.25, 0.625, 0.5],
  [0.375, 0.5, 0.625, 0.75],
  [0.375, 0.75, 0.625, 1],
  [0.125, 0.5, 0.375, 0.75],
  [0.625, 0.5, 0.875, 0.75],
];

defOp('create_cube', { size: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const h = argNum(a.size, 'size') / 2;
  const verts: BMVert[] = [];
  for (let i = 0; i < 8; i++) verts.push(makeVert(bm, [i & 4 ? h : -h, i & 2 ? h : -h, i & 1 ? h : -h]));
  const uv = a.calc_uvs ? uvLayer(bm) : null;
  const idx = [
    [0, 1, 3, 2],
    [2, 3, 7, 6],
    [6, 7, 5, 4],
    [4, 5, 1, 0],
    [2, 6, 4, 0],
    [7, 3, 1, 5],
  ];
  const faces = idx.map((q, fi) => {
    const f = makeFace(
      bm,
      q.map((i) => verts[i]),
    );
    const [u0, v0, u1, v1] = CUBE_UV[fi];
    const uvs = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    faceLoops(f).forEach((l, k) => setUV(l, uv, uvs[k][0], uvs[k][1]));
    return f;
  });
  return finishPrimitive(bm, verts, faces, argMat(a.matrix, 'matrix'));
});

function circleFill(bm: BMesh, ring: BMVert[], tris: boolean, z: number, up: boolean, uv: ReturnType<typeof uvLayer>, r: number) {
  const faces: BMFace[] = [];
  const extra: BMVert[] = [];
  const uvOf = (v: BMVert) => [r ? v._co[0] / r / 2 + 0.5 : 0.5, r ? v._co[1] / r / 2 + 0.5 : 0.5];
  if (tris) {
    const c = makeVert(bm, [0, 0, z]);
    extra.push(c);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const vs = up ? [c, a, b] : [c, b, a];
      const f = makeFace(bm, vs);
      faceLoops(f).forEach((l) => setUV(l, uv, uvOf(l.vert)[0], uvOf(l.vert)[1]));
      faces.push(f);
    }
  } else {
    const f = makeFace(bm, up ? ring : [...ring].reverse());
    faceLoops(f).forEach((l) => setUV(l, uv, uvOf(l.vert)[0], uvOf(l.vert)[1]));
    faces.push(f);
  }
  return { faces, extra };
}

defOp('create_circle', { cap_ends: false, cap_tris: false, segments: 32, radius: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const n = argInt(a.segments, 'segments'),
    r = argNum(a.radius, 'radius');
  if (n < 3) return { verts: [] };
  const verts: BMVert[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.PI / 2 + (2 * Math.PI * i) / n;
    verts.push(makeVert(bm, [r * Math.cos(t), r * Math.sin(t), 0]));
  }
  for (let i = 0; i < n; i++) makeEdge(bm, verts[i], verts[(i + 1) % n]);
  let faces: BMFace[] = [];
  const all = [...verts];
  if (a.cap_ends) {
    const fill = circleFill(bm, verts, !!a.cap_tris, 0, true, a.calc_uvs ? uvLayer(bm) : null, r);
    faces = fill.faces;
    all.push(...fill.extra);
  }
  return finishPrimitive(bm, all, faces, argMat(a.matrix, 'matrix'));
});

defOp('create_cone', { cap_ends: false, cap_tris: false, segments: 32, radius1: 1, radius2: 0, depth: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const n = argInt(a.segments, 'segments');
  const r1 = argNum(a.radius1, 'radius1'),
    r2 = argNum(a.radius2, 'radius2'),
    d = argNum(a.depth, 'depth') / 2;
  if (n < 3) return { verts: [] };
  const uv = a.calc_uvs ? uvLayer(bm) : null;
  const all: BMVert[] = [];
  const bottom: BMVert[] = [],
    top: BMVert[] = [];
  let apexB: BMVert | null = null,
    apexT: BMVert | null = null;
  for (let i = 0; i < n; i++) {
    const t = Math.PI / 2 - (2 * Math.PI * i) / n;
    const c = Math.cos(t),
      s = Math.sin(t);
    if (r1 > 0) bottom.push(makeVert(bm, [r1 * c, r1 * s, -d]));
    else bottom.push((apexB ??= makeVert(bm, [0, 0, -d])));
    if (r2 > 0) top.push(makeVert(bm, [r2 * c, r2 * s, d]));
    else top.push((apexT ??= makeVert(bm, [0, 0, d])));
  }
  all.push(...new Set([...bottom, ...top]));
  const faces: BMFace[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vs = [bottom[i], top[i], top[j], bottom[j]].filter((v, k, arr) => arr.indexOf(v) === k);
    if (vs.length < 3) continue;
    const f = makeFace(bm, vs);
    faceLoops(f).forEach((l) => setUV(l, uv, (l.vert === bottom[j] || l.vert === top[j] ? j || n : i) / n, l.vert._co[2] > 0 ? 1 : 0));
    faces.push(f);
  }
  if (a.cap_ends) {
    // the bottom ring runs clockwise seen from above: its fill faces down; the top fill faces up
    if (r1 > 0) {
      const fill = circleFill(bm, [...bottom].reverse(), !!a.cap_tris, -d, false, uv, r1);
      faces.push(...fill.faces);
      all.push(...fill.extra);
    }
    if (r2 > 0) {
      const fill = circleFill(bm, [...top].reverse(), !!a.cap_tris, d, true, uv, r2);
      faces.push(...fill.faces);
      all.push(...fill.extra);
    }
  }
  return finishPrimitive(bm, all, faces, argMat(a.matrix, 'matrix'));
});

defOp('create_uvsphere', { u_segments: 32, v_segments: 16, radius: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const nu = argInt(a.u_segments, 'u_segments'),
    nv = argInt(a.v_segments, 'v_segments'),
    r = argNum(a.radius, 'radius');
  if (nu < 3 || nv < 3) {
    const v = makeVert(bm, [0, 0, 0]);
    return finishPrimitive(bm, [v], [], argMat(a.matrix, 'matrix'));
  }
  const uv = a.calc_uvs ? uvLayer(bm) : null;
  const south = makeVert(bm, [0, 0, -r]);
  const rings: BMVert[][] = [];
  for (let k = 1; k < nv; k++) {
    const th = Math.PI - (Math.PI * k) / nv;
    const ring: BMVert[] = [];
    for (let i = 0; i < nu; i++) {
      const ph = (2 * Math.PI * i) / nu;
      ring.push(makeVert(bm, [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]));
    }
    rings.push(ring);
  }
  const north = makeVert(bm, [0, 0, r]);
  const faces: BMFace[] = [];
  const uvAt = (i: number, k: number) => [i / nu, k / nv];
  const face = (vs: BMVert[], uvs: number[][]) => {
    const f = makeFace(bm, vs);
    faceLoops(f).forEach((l, q) => setUV(l, uv, uvs[q][0], uvs[q][1]));
    faces.push(f);
  };
  for (let i = 0; i < nu; i++) {
    const j = (i + 1) % nu;
    face([south, rings[0][j], rings[0][i]], [uvAt(i + 0.5, 0), uvAt(i + 1, 1), uvAt(i, 1)]);
    for (let k = 0; k + 1 < rings.length; k++) face([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], [uvAt(i, k + 1), uvAt(i + 1, k + 1), uvAt(i + 1, k + 2), uvAt(i, k + 2)]);
    const last = rings[rings.length - 1];
    face([last[i], last[j], north], [uvAt(i, nv - 1), uvAt(i + 1, nv - 1), uvAt(i + 0.5, nv)]);
  }
  return finishPrimitive(bm, [south, ...rings.flat(), north], faces, argMat(a.matrix, 'matrix'));
});

defOp('create_icosphere', { subdivisions: 2, radius: 1, matrix: null, calc_uvs: false }, (bm, a) => {
  const subs = Math.max(1, argInt(a.subdivisions, 'subdivisions'));
  const r = argNum(a.radius, 'radius');
  const t = (1 + Math.sqrt(5)) / 2;
  let pts: Num3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => normalize(p as Num3));
  let tris = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 1; s < subs; s++) {
    const mid = new Map<string, number>();
    const m = (i: number, j: number) => {
      const k = i < j ? `${i}_${j}` : `${j}_${i}`;
      let x = mid.get(k);
      if (x === undefined) {
        x = pts.length;
        pts = [...pts, normalize(add(pts[i], pts[j]))];
        mid.set(k, x);
      }
      return x;
    };
    const next: number[][] = [];
    for (const [i, j, k] of tris) {
      const a2 = m(i, j),
        b2 = m(j, k),
        c2 = m(k, i);
      next.push([i, a2, c2], [j, b2, a2], [k, c2, b2], [a2, b2, c2]);
    }
    tris = next;
  }
  const verts = pts.map((p) => makeVert(bm, scale(p, r)));
  const uv = a.calc_uvs ? uvLayer(bm) : null;
  const faces = tris.map((tri) => {
    const f = outwardFace(
      bm,
      tri.map((i) => verts[i]),
    );
    faceLoops(f).forEach((l) => {
      const p = normalize(l.vert._co);
      setUV(l, uv, 0.5 + Math.atan2(p[1], p[0]) / (2 * Math.PI), 0.5 + Math.asin(Math.max(-1, Math.min(1, p[2]))) / Math.PI);
    });
    return f;
  });
  return finishPrimitive(bm, verts, faces, argMat(a.matrix, 'matrix'));
});

// ---------------------------------------------------------------------------
// transforms

defOp('translate', { vec: [0, 0, 0], space: null, verts: [], use_shape: false }, (bm, a) => {
  transformVerts(argVerts(a.verts, 'translate(verts)'), inSpace(translation(argVec(a.vec, 'translate(vec)')), a.space), !!a.use_shape, bm);
});

defOp('scale', { vec: [1, 1, 1], space: null, verts: [], use_shape: false }, (bm, a) => {
  const s = argVec(a.vec, 'scale(vec)');
  const M = [
    [s[0], 0, 0, 0],
    [0, s[1], 0, 0],
    [0, 0, s[2], 0],
    [0, 0, 0, 1],
  ];
  transformVerts(argVerts(a.verts, 'scale(verts)'), inSpace(M, a.space), !!a.use_shape, bm);
});

defOp('rotate', { cent: [0, 0, 0], matrix: null, verts: [], space: null, use_shape: false }, (bm, a) => {
  const c = argVec(a.cent, 'rotate(cent)');
  const R = argMat(a.matrix, 'rotate(matrix)');
  const M = mulMat(translation(c), mulMat(R, translation(scale(c, -1))));
  transformVerts(argVerts(a.verts, 'rotate(verts)'), inSpace(M, a.space), !!a.use_shape, bm);
});

defOp('transform', { matrix: null, space: null, verts: [], use_shape: false }, (bm, a) => {
  transformVerts(argVerts(a.verts, 'transform(verts)'), inSpace(argMat(a.matrix, 'transform(matrix)'), a.space), !!a.use_shape, bm);
});

// ---------------------------------------------------------------------------
// delete

const DELETE_CONTEXTS = ['VERTS', 'EDGES', 'FACES_ONLY', 'EDGES_FACES', 'FACES', 'FACES_KEEP_BOUNDARY', 'TAGGED_ONLY'];

export function deleteGeom(bm: BMesh, geom: { verts: BMVert[]; edges: BMEdge[]; faces: BMFace[] }, context: string) {
  void bm;
  const { verts, edges, faces } = geom;
  const looseVerts = (vs: Iterable<BMVert>) => {
    for (const v of vs) if (v._bm && !v._e.length) killVert(v);
  };
  switch (context) {
    case 'VERTS':
      verts.forEach(killVert);
      break;
    case 'EDGES': {
      const vs = new Set(edges.flatMap((e) => [e.v1, e.v2]));
      edges.forEach(killEdge);
      looseVerts(vs);
      break;
    }
    case 'FACES_ONLY':
      faces.forEach(killFace);
      break;
    case 'EDGES_FACES':
      edges.forEach(killEdge);
      faces.forEach(killFace);
      break;
    case 'FACES':
    case 'FACES_KEEP_BOUNDARY': {
      const es = new Map<BMEdge, number>();
      for (const f of faces) for (const l of faceLoops(f)) es.set(l.edge, (es.get(l.edge) ?? 0) + 1);
      faces.forEach(killFace);
      const vs = new Set<BMVert>();
      for (const [e, n] of es) {
        if (!e._bm || e._l.length) continue;
        if (context === 'FACES_KEEP_BOUNDARY' && n < 2) continue;
        vs.add(e.v1);
        vs.add(e.v2);
        killEdge(e);
      }
      if (context === 'FACES') for (const e of edges) if (e._bm && !e._l.length) killEdge(e);
      looseVerts(vs);
      break;
    }
    case 'TAGGED_ONLY':
      faces.forEach(killFace);
      edges.forEach(killEdge);
      verts.forEach(killVert);
      break;
  }
}

defOp('delete', { geom: [], context: 'VERTS' }, (bm, a) => {
  deleteGeom(bm, geomSplit(a.geom, 'delete(geom)'), argEnum(a.context, DELETE_CONTEXTS, 'delete(context)'));
});

// ---------------------------------------------------------------------------
// extrude

function extrudeEdges(bm: BMesh, edges: BMEdge[], flip: boolean) {
  const nv = new Map<BMVert, BMVert>();
  const dup = (v: BMVert) => {
    let n = nv.get(v);
    if (!n) {
      nv.set(v, (n = makeVert(bm, v._co, v)));
      makeEdge(bm, v, n);
    }
    return n;
  };
  const newEdges: BMEdge[] = [],
    walls: BMFace[] = [];
  for (const e of edges) {
    // a face using the edge as a→b makes the wall run b→a along it
    const l = e._l[0] ?? null;
    const a = l ? l.vert : e.v1,
      b = l ? l._next.vert : e.v2;
    const na = dup(a),
      nb = dup(b);
    newEdges.push(makeEdge(bm, na, nb, e));
    let vs = l ? [b, a, na, nb] : [a, b, nb, na];
    let src: (BMLoop | null)[] = l ? [l._next, l, l, l._next] : [null, null, null, null];
    if (flip) (vs = [...vs].reverse()), (src = [...src].reverse());
    walls.push(makeFace(bm, vs, { example: l?.face ?? null, loops: src }));
  }
  return { verts: [...nv.values()], edges: newEdges, faces: walls };
}

function extrudeVerts(bm: BMesh, verts: BMVert[]) {
  const nvs: BMVert[] = [],
    nes: BMEdge[] = [];
  for (const v of verts) {
    const n = makeVert(bm, v._co, v);
    nvs.push(n);
    nes.push(makeEdge(bm, v, n));
  }
  return { verts: nvs, edges: nes };
}

defOp('extrude_vert_indiv', { verts: [], use_select_history: false }, (bm, a) => extrudeVerts(bm, argVerts(a.verts, 'extrude_vert_indiv(verts)')));

defOp('extrude_edge_only', { edges: [], use_normal_flip: false, use_select_history: false }, (bm, a) => {
  const r = extrudeEdges(bm, argEdges(a.edges, 'extrude_edge_only(edges)'), !!a.use_normal_flip);
  return { geom: geomOut(r.verts, r.edges, r.faces) };
});

/** Extrude a face region; returns the new top geometry (verts, edges, faces) and the side walls. */
export function extrudeRegion(bm: BMesh, faces: BMFace[], inputEdges: Set<BMEdge>, keepOrig: boolean, flip: boolean) {
  const F = new Set(faces);
  const nv = new Map<BMVert, BMVert>();
  for (const f of F) for (const l of faceLoops(f)) if (!nv.has(l.vert)) nv.set(l.vert, makeVert(bm, l.vert._co, l.vert));
  const tops: BMFace[] = [],
    walls: BMFace[] = [];
  for (const f of F) {
    const ls = faceLoops(f);
    tops.push(makeFace(bm, ls.map((l) => nv.get(l.vert)!), { example: f, loops: ls, edges: ls.map((l) => l.edge) }));
  }
  for (const f of F)
    for (const l of faceLoops(f)) {
      const e = l.edge;
      const nF = e._l.filter((o) => F.has(o.face)).length;
      if (!(nF === 1 || nF < e._l.length)) continue;
      const a = l.vert,
        b = l._next.vert;
      const na = nv.get(a)!,
        nb = nv.get(b)!;
      const vs = [a, b, nb, na];
      const w = makeFace(bm, vs, { example: f, loops: [l, l._next, l._next, l], edges: [e, null, e, null] });
      walls.push(w);
    }
  for (const f of F) {
    const del = !keepOrig && faceLoops(f).every((l) => inputEdges.has(l.edge));
    if (del) killFace(f);
    else flipFace(f);
  }
  if ([...F].some((f) => !f._bm)) for (const e of inputEdges) if (e._bm && !e._l.length) killEdge(e);
  if (flip) for (const f of [...tops, ...walls]) flipFace(f);
  const topEdges = new Set<BMEdge>();
  for (const f of tops) for (const l of faceLoops(f)) topEdges.add(l.edge);
  return { verts: [...nv.values()], edges: [...topEdges], faces: tops, walls };
}

defOp(
  'extrude_face_region',
  { geom: [], edges_exclude: [], use_keep_orig: false, use_normal_flip: false, use_normal_from_adjacent: false, use_dissolve_ortho_edges: false, use_select_history: false },
  (bm, a) => {
    const g = geomSplit(a.geom, 'extrude_face_region(geom)');
    const inE = new Set(g.edges);
    const out: BMElem[] = [];
    const faceEdges = new Set<BMEdge>(),
      faceVertsSet = new Set<BMVert>();
    for (const f of g.faces) for (const l of faceLoops(f)) faceEdges.add(l.edge), faceVertsSet.add(l.vert);
    // wire / boundary edges and loose verts that are not part of the faces
    const looseEdges = g.edges.filter((e) => !faceEdges.has(e));
    const edgeVerts = new Set(looseEdges.flatMap((e) => [e.v1, e.v2]));
    const looseVerts = g.verts.filter((v) => !faceVertsSet.has(v) && !edgeVerts.has(v));
    if (g.faces.length) {
      const r = extrudeRegion(bm, g.faces, inE, !!a.use_keep_orig, !!a.use_normal_flip);
      out.push(...r.verts, ...r.edges, ...r.faces);
    }
    if (looseEdges.length) {
      const r = extrudeEdges(bm, looseEdges, !!a.use_normal_flip);
      out.push(...r.verts, ...r.edges);
    }
    if (looseVerts.length) out.push(...extrudeVerts(bm, looseVerts).verts);
    const verts = out.filter((x) => x instanceof BMVert),
      edges = out.filter((x) => x instanceof BMEdge),
      faces = out.filter((x) => x instanceof BMFace);
    return { geom: [...verts, ...edges, ...faces].filter((x) => !!x._bm) };
  },
);

defOp('extrude_discrete_faces', { faces: [], use_normal_flip: false, use_select_history: false }, (bm, a) => {
  const tops: BMFace[] = [];
  for (const f of argFaces(a.faces, 'extrude_discrete_faces(faces)')) {
    const ls = faceLoops(f);
    const nv = ls.map((l) => makeVert(bm, l.vert._co, l.vert));
    const top = makeFace(bm, nv, { example: f, loops: ls, edges: ls.map((l) => l.edge) });
    ls.forEach((l, i) => {
      const j = (i + 1) % ls.length;
      makeFace(bm, [l.vert, l._next.vert, nv[j], nv[i]], { example: f, loops: [l, l._next, l._next, l], edges: [l.edge, null, l.edge, null] });
    });
    killFace(f);
    if (a.use_normal_flip) flipFace(top);
    tops.push(top);
  }
  return { faces: tops };
});

// ---------------------------------------------------------------------------
// merging

/** Spatial-hash grouping of close vertices: returns vertex → target. */
function findDoubles(cands: BMVert[], keep: BMVert[], distance: number): Map<BMVert, BMVert> {
  const d = Math.max(distance, 1e-12);
  const cell = (p: ArrayLike<number>) => [Math.floor(p[0] / d), Math.floor(p[1] / d), Math.floor(p[2] / d)];
  const grid = new Map<string, BMVert[]>();
  const insert = (v: BMVert) => {
    const k = cell(v._co).join(',');
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(v);
  };
  const near = (v: BMVert): BMVert | null => {
    const [x, y, z] = cell(v._co);
    let best: BMVert | null = null,
      bd = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++)
          for (const o of grid.get(`${x + i},${y + j},${z + k}`) ?? []) {
            const dd = dist(o._co, v._co);
            if (dd <= distance && dd < bd && o !== v) (bd = dd), (best = o);
          }
    return best;
  };
  const map = new Map<BMVert, BMVert>();
  const keepSet = new Set(keep);
  for (const v of keep) insert(v);
  for (const v of cands) {
    if (keepSet.has(v)) continue;
    const t = near(v);
    if (t) map.set(v, t);
    else insert(v);
  }
  return map;
}

defOp('remove_doubles', { verts: [], dist: 0 }, (bm, a) => {
  const map = findDoubles(argVerts(a.verts, 'remove_doubles(verts)'), [], argNum(a.dist, 'dist'));
  if (map.size) weldVerts(bm, map);
});

defOp('find_doubles', { verts: [], keep_verts: [], dist: 0 }, (_bm, a) => ({ targetmap: findDoubles(argVerts(a.verts, 'find_doubles(verts)'), argVerts(a.keep_verts, 'find_doubles(keep_verts)'), argNum(a.dist, 'dist')) }));

defOp('automerge', { verts: [], dist: 0 }, (bm, a) => {
  const verts = argVerts(a.verts, 'automerge(verts)');
  const inp = new Set(verts);
  const others = [...bm._v].filter((v) => !inp.has(v));
  const map = findDoubles(verts, others, argNum(a.dist, 'dist'));
  if (map.size) weldVerts(bm, map);
});

defOp('weld_verts', { targetmap: null }, (bm, a) => {
  const m = a.targetmap;
  const map = new Map<BMVert, BMVert>();
  if (m instanceof Map) m.forEach((t, v) => v instanceof BMVert && t instanceof BMVert && v._bm && t._bm && map.set(v, t));
  else if (m && typeof m === 'object') throw pyError('TypeError', 'weld_verts(targetmap): expected a dict of BMVert → BMVert');
  if (map.size) weldVerts(bm, map);
});

defOp('pointmerge', { verts: [], merge_co: [0, 0, 0] }, (bm, a) => {
  const verts = argVerts(a.verts, 'pointmerge(verts)');
  if (!verts.length) return;
  const t = verts[0];
  const co = argVec(a.merge_co, 'merge_co');
  t._co = [...co];
  const map = new Map<BMVert, BMVert>();
  for (const v of verts.slice(1)) map.set(v, t);
  weldVerts(bm, map);
});

/** Merge each connected group of edges into one vertex at its center. */
function collapseEdges(bm: BMesh, edges: BMEdge[]) {
  const parent = new Map<BMVert, BMVert>();
  const find = (v: BMVert): BMVert => {
    while (parent.get(v) !== v) v = parent.get(v)!;
    return v;
  };
  for (const e of edges) for (const v of [e.v1, e.v2]) if (!parent.has(v)) parent.set(v, v);
  for (const e of edges) parent.set(find(e.v1), find(e.v2));
  const groups = new Map<BMVert, BMVert[]>();
  for (const v of parent.keys()) {
    const r = find(v);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(v);
  }
  const map = new Map<BMVert, BMVert>();
  for (const g of groups.values()) {
    const t = g[0];
    const c = scale(
      g.reduce((s, v) => add(s, v._co), [0, 0, 0] as Num3),
      1 / g.length,
    );
    t._cd = mixCd(
      bm,
      'verts',
      g.map((v) => [v._cd, 1 / g.length]),
    );
    t._co = [...c];
    for (const v of g.slice(1)) map.set(v, t);
  }
  if (map.size) weldVerts(bm, map);
}

defOp('collapse', { edges: [], uvs: false }, (bm, a) => collapseEdges(bm, argEdges(a.edges, 'collapse(edges)')));

defOp('dissolve_degenerate', { dist: 0, edges: [] }, (bm, a) => {
  const d = argNum(a.dist, 'dist');
  collapseEdges(
    bm,
    argEdges(a.edges, 'dissolve_degenerate(edges)').filter((e) => e.calc_length() <= d),
  );
});

// ---------------------------------------------------------------------------
// normals

export function recalcNormals(faces: BMFace[]) {
  const set = new Set(faces);
  const seen = new Set<BMFace>();
  for (const start of faces) {
    if (seen.has(start)) continue;
    const comp: BMFace[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      comp.push(f);
      for (const l of faceLoops(f)) {
        if (l.edge._l.length !== 2) continue;
        const o = l.edge._l[0] === l ? l.edge._l[1] : l.edge._l[0];
        const g = o.face;
        if (!set.has(g) || seen.has(g)) continue;
        if (o.vert === l.vert) flipFace(g); // same direction: inconsistent
        seen.add(g);
        stack.push(g);
      }
    }
    // outward: signed volume relative to the component center
    const c = scale(
      comp.reduce((s, f) => add(s, faceCenter(f)), [0, 0, 0] as Num3),
      1 / comp.length,
    );
    let vol = 0;
    for (const f of comp) {
      const ls = faceLoops(f);
      for (let i = 1; i + 1 < ls.length; i++) vol += dot(sub(ls[0].vert._co, c), cross(sub(ls[i].vert._co, c), sub(ls[i + 1].vert._co, c)));
    }
    if (vol < 0) comp.forEach(flipFace);
    for (const f of comp) f._no = faceNormal(f);
  }
}

defOp('recalc_face_normals', { faces: [] }, (_bm, a) => recalcNormals(argFaces(a.faces, 'recalc_face_normals(faces)')));
defOp('reverse_faces', { faces: [], flip_multires: false }, (_bm, a) => argFaces(a.faces, 'reverse_faces(faces)').forEach(flipFace));

// ---------------------------------------------------------------------------
// duplicate / split

/** Copy custom data between BMeshes with different layer layouts (matched by domain, kind, name). */
function remapLayers(src: BMesh, dst: BMesh, elems: { v: BMVert[]; e: BMEdge[]; f: BMFace[] }) {
  for (const d of ['verts', 'edges', 'faces', 'loops'] as Domain[]) {
    const map: [number, number][] = [];
    for (const l of src._layerSlots[d]) {
      if (!l) continue;
      const m = dst._layers(d, l._kind).find((x) => x._name === l._name || l._kind === 'deform') ?? dst._addLayer(d, l._kind, l._name);
      map.push([l._slot, m._slot]);
    }
    const fix = (el: BMElem) => {
      const old = el._cd;
      el._cd = [];
      for (const [s, t] of map) el._cd[t] = old[s];
    };
    if (d === 'verts') elems.v.forEach(fix);
    else if (d === 'edges') elems.e.forEach(fix);
    else if (d === 'faces') elems.f.forEach(fix);
    else elems.f.forEach((f) => faceLoops(f).forEach(fix));
  }
}

export function duplicateGeom(bm: BMesh, g: { verts: BMVert[]; edges: BMEdge[]; faces: BMFace[] }, dest: BMesh = bm) {
  const verts = new Set(g.verts),
    edges = new Set(g.edges);
  for (const e of g.edges) verts.add(e.v1), verts.add(e.v2);
  for (const f of g.faces) for (const l of faceLoops(f)) verts.add(l.vert), edges.add(l.edge);
  if (dest !== bm && !dest._layerSlots.verts.length && !dest._layerSlots.loops.length && !dest._layerSlots.edges.length && !dest._layerSlots.faces.length) copyLayers(bm, dest);
  const sameLayout = dest === bm || JSON.stringify(dest._layerSlots.loops.map((l) => l && l._kind + l._name)) === JSON.stringify(bm._layerSlots.loops.map((l) => l && l._kind + l._name));
  const r = copyGeometry(bm, dest, [...verts], [...edges], g.faces);
  if (dest !== bm && !sameLayout) remapLayers(bm, dest, { v: [...r.vmap.values()], e: [...r.emap.values()], f: [...r.fmap.values()] });
  return r;
}

function both<K, V>(m: Map<K, V>): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>(m);
  m.forEach((v, k) => out.set(v, k));
  return out;
}

defOp('duplicate', { geom: [], dest: null, use_select_history: false, use_edge_flip_from_face: false }, (bm, a) => {
  const g = geomSplit(a.geom, 'duplicate(geom)');
  const dest = a.dest instanceof BMesh ? a.dest._chk() : bm;
  const r = duplicateGeom(bm, g, dest);
  const fset = new Set(g.faces);
  const boundary = new Map<BMEdge, BMEdge>();
  for (const [e, n] of r.emap) if (e._l.some((l) => fset.has(l.face)) && e._l.some((l) => !fset.has(l.face))) boundary.set(e, n);
  const iso = new Map<BMVert, BMVert>();
  for (const [v, n] of r.vmap) if (!v._e.some((e) => r.emap.has(e))) iso.set(v, n);
  return {
    geom_orig: geomOut(r.vmap.keys(), r.emap.keys(), r.fmap.keys()),
    geom: geomOut(r.vmap.values(), r.emap.values(), r.fmap.values()),
    vert_map: both(r.vmap),
    edge_map: both(r.emap),
    face_map: both(r.fmap),
    boundary_map: both(boundary),
    isovert_map: both(iso),
  };
});

defOp('split', { geom: [], dest: null, use_only_faces: false }, (bm, a) => {
  const g = geomSplit(a.geom, 'split(geom)');
  const dest = a.dest instanceof BMesh ? a.dest._chk() : bm;
  const fset = new Set(g.faces);
  const boundary = new Map<BMEdge, BMEdge>();
  const r = duplicateGeom(bm, a.use_only_faces ? { verts: [], edges: [], faces: g.faces } : g, dest);
  for (const [e, n] of r.emap) if (e._l.some((l) => fset.has(l.face)) && e._l.some((l) => !fset.has(l.face))) boundary.set(e, n);
  const iso = new Map<BMVert, BMVert>();
  for (const [v, n] of r.vmap) if (!v._e.some((e) => r.emap.has(e))) iso.set(v, n);
  // remove the originals that nothing else uses
  const es = new Set(g.edges),
    vs = new Set(g.verts);
  for (const f of g.faces) for (const l of faceLoops(f)) es.add(l.edge), vs.add(l.vert);
  g.faces.forEach(killFace);
  for (const e of es) if (e._bm && !e._l.length) killEdge(e);
  for (const v of vs) if (v._bm && !v._e.length) killVert(v);
  return { geom: geomOut(r.vmap.values(), r.emap.values(), r.fmap.values()), boundary_map: both(boundary), isovert_map: both(iso) };
});

// ---------------------------------------------------------------------------
// triangulate / poke

export function triangulateFaces(bm: BMesh, faces: BMFace[], quad: string, ngon: string) {
  const outFaces: BMFace[] = [],
    newEdges: BMEdge[] = [];
  const faceMap = new Map<BMFace, BMFace>();
  for (const f of faces) {
    if (f._len <= 3) {
      outFaces.push(f);
      continue;
    }
    const tris = triangulateFace(f, quad, ngon).map((t) => ({ verts: t.map((l) => l.vert), data: t.map((l) => l._cd.map(cloneValue)) }));
    const active = bm._active === f;
    const before = new Set<BMEdge>();
    for (const l of faceLoops(f)) before.add(l.edge);
    killFace(f);
    for (const t of tris) {
      const nf = makeFace(bm, t.verts, { example: f, loopData: t.data });
      for (const l of faceLoops(nf))
        if (!before.has(l.edge)) {
          before.add(l.edge);
          l.edge._sel = f._sel;
          l.edge._hide = f._hide;
          newEdges.push(l.edge);
        }
      if (active && !bm._active) bm._active = nf;
      faceMap.set(nf, f);
      outFaces.push(nf);
    }
  }
  return { faces: outFaces, edges: newEdges, face_map: faceMap };
}

defOp('triangulate', { faces: [], quad_method: 'BEAUTY', ngon_method: 'BEAUTY' }, (bm, a) => {
  const r = triangulateFaces(
    bm,
    argFaces(a.faces, 'triangulate(faces)'),
    argEnum(a.quad_method, ['BEAUTY', 'FIXED', 'ALTERNATE', 'SHORT_EDGE', 'LONG_EDGE'], 'quad_method'),
    argEnum(a.ngon_method, ['BEAUTY', 'EAR_CLIP'], 'ngon_method'),
  );
  return { edges: r.edges, faces: r.faces, face_map: r.face_map, face_map_double: new Map() };
});

defOp('poke', { faces: [], offset: 0, center_mode: 'MEAN_WEIGHTED', use_relative_offset: false }, (bm, a) => {
  const mode = argEnum(a.center_mode, ['MEAN_WEIGHTED', 'MEAN', 'BOUNDS'], 'center_mode');
  const off = argNum(a.offset, 'offset');
  const verts: BMVert[] = [],
    faces: BMFace[] = [];
  for (const f of argFaces(a.faces, 'poke(faces)')) {
    const ls = faceLoops(f);
    const c = mode === 'MEAN' ? faceCenter(f) : mode === 'BOUNDS' ? f.calc_center_bounds().toArray() : f.calc_center_median_weighted().toArray();
    const no = faceNormal(f);
    const avgLen = f.calc_perimeter() / ls.length;
    const p = add(c, scale(no, off * (a.use_relative_offset ? avgLen : 1)));
    const w = 1 / ls.length;
    const cv = makeVert(bm, p);
    cv._cd = mixCd(
      bm,
      'verts',
      ls.map((l) => [l.vert._cd, w]),
    );
    cv._sel = f._sel;
    const cdata = mixCd(
      bm,
      'loops',
      ls.map((l) => [l._cd, w]),
    );
    const specs = ls.map((l) => ({ verts: [l.vert, l._next.vert, cv], data: [l._cd.map(cloneValue), l._next._cd.map(cloneValue), cdata] }));
    const edges = ls.map((l) => l.edge);
    killFace(f);
    specs.forEach((s, i) => faces.push(makeFace(bm, s.verts, { example: f, loopData: s.data, edges: [edges[i], null, null] })));
    cv._no = vertNormal(cv);
    verts.push(cv);
  }
  return { verts, faces };
});

// ---------------------------------------------------------------------------
// connect

/** Split faces between pairs of the given vertices that share a face. */
export function connectVerts(bm: BMesh, verts: Set<BMVert>, excluded = new Set<BMFace>()): BMEdge[] {
  const out: BMEdge[] = [];
  const queue = new Set<BMFace>();
  for (const v of verts) for (const l of vertLoops(v)) if (!excluded.has(l.face)) queue.add(l.face);
  let guard = 0;
  while (queue.size && guard++ < 100000) {
    const f = queue.values().next().value as BMFace;
    queue.delete(f);
    if (!f._bm) continue;
    const ls = faceLoops(f).filter((l) => verts.has(l.vert));
    if (ls.length < 2) continue;
    let done = false;
    for (let i = 0; i < ls.length && !done; i++) {
      const la = ls[i],
        lb = ls[(i + 1) % ls.length];
      if (la === lb || la._next === lb || lb._next === la) continue;
      if (edgeBetween(la.vert, lb.vert)?._l.some((l) => l.face === f)) continue;
      const r = splitFace(bm, f, la, lb);
      if (r) {
        out.push(r[1]);
        r[1]._sel = la.vert._sel && lb.vert._sel;
        queue.add(f);
        queue.add(r[0]);
        done = true;
      }
    }
  }
  for (const e of out) for (const l of e._l) l.face._no = faceNormal(l.face);
  return out;
}

defOp('connect_verts', { verts: [], faces_exclude: [], check_degenerate: false }, (bm, a) => ({
  edges: connectVerts(bm, new Set(argVerts(a.verts, 'connect_verts(verts)')), new Set(argFaces(a.faces_exclude, 'faces_exclude'))),
}));

defOp('connect_vert_pair', { verts: [], verts_exclude: [], faces_exclude: [] }, (bm, a) => {
  const vs = argVerts(a.verts, 'connect_vert_pair(verts)');
  if (vs.length !== 2) throw pyError('ValueError', 'connect_vert_pair(): expected exactly 2 vertices');
  return { edges: connectVerts(bm, new Set(vs), new Set(argFaces(a.faces_exclude, 'faces_exclude'))) };
});

// ---------------------------------------------------------------------------
// fills

function fillLoop(bm: BMesh, verts: BMVert[], example?: BMFace | null, mat = 0, smooth = false): BMFace | null {
  if (verts.length < 3 || findFace(verts)) return null;
  const vs = orientAgainstNeighbors(verts);
  const f = makeFace(bm, vs, { loopData: neighborLoopData(vs), example: example ?? null });
  if (!example) {
    // material / smooth from a neighbouring face, else the given ones
    const nb = vs.flatMap((v) => vertLoops(v)).find((l) => l.face !== f)?.face;
    f.material_index = nb && !mat ? nb.material_index : mat;
    f.smooth = nb && !smooth ? nb.smooth : smooth;
  }
  return f;
}

defOp('edgeloop_fill', { edges: [], mat_nr: 0, use_smooth: false }, (bm, a) => {
  const faces: BMFace[] = [];
  for (const c of edgeChains(argEdges(a.edges, 'edgeloop_fill(edges)'))) {
    if (!c.closed) continue;
    const f = fillLoop(bm, c.verts, null, argInt(a.mat_nr, 'mat_nr'), !!a.use_smooth);
    if (f) faces.push(f);
  }
  return { faces };
});

defOp('holes_fill', { edges: [], sides: 0 }, (bm, a) => {
  const sides = argInt(a.sides, 'sides');
  const faces: BMFace[] = [];
  const boundary = argEdges(a.edges, 'holes_fill(edges)').filter((e) => e._l.length === 1);
  for (const c of edgeChains(boundary)) {
    if (!c.closed || (sides > 0 && c.verts.length > sides)) continue;
    const f = fillLoop(bm, c.verts);
    if (f) faces.push(f);
  }
  return { faces };
});

/** Order loose vertices around their center (in their best-fit plane). */
function orderAround(verts: BMVert[]): BMVert[] {
  const c = scale(
    verts.reduce((s, v) => add(s, v._co), [0, 0, 0] as Num3),
    1 / verts.length,
  );
  let n = newell(verts.map((v) => v._co));
  if (len(n) < 0.5) {
    // fit a normal from cross products around the center
    const acc: Num3 = [0, 0, 0];
    for (let i = 0; i < verts.length; i++)
      for (let j = i + 1; j < verts.length; j++) {
        const x = cross(sub(verts[i]._co, c), sub(verts[j]._co, c));
        const s = dot(x, acc) < 0 ? -1 : 1;
        acc[0] += x[0] * s;
        acc[1] += x[1] * s;
        acc[2] += x[2] * s;
      }
    n = normalize(acc);
  }
  if (len(n) < 0.5) n = [0, 0, 1];
  const u = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n));
  const w = cross(n, u);
  return [...verts].sort((a, b) => {
    const pa = sub(a._co, c),
      pb = sub(b._co, c);
    return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
  });
}

defOp('contextual_create', { geom: [], mat_nr: 0, use_smooth: false }, (bm, a) => {
  const g = geomSplit(a.geom, 'contextual_create(geom)');
  const mat = argInt(a.mat_nr, 'mat_nr'),
    smooth = !!a.use_smooth;
  const vs = new Set<BMVert>(g.verts);
  for (const e of g.edges) vs.add(e.v1), vs.add(e.v2);
  const verts = [...vs];
  if (verts.length === 2 && !g.edges.length) {
    if (edgeBetween(verts[0], verts[1])) return { faces: [], edges: [] };
    return { faces: [], edges: [makeEdge(bm, verts[0], verts[1])] };
  }
  if (verts.length < 3) return { faces: [], edges: [] };
  // edges: the given ones, else the existing edges among the vertices
  let edges = g.edges;
  if (!edges.length) {
    const es = new Set<BMEdge>();
    for (const v of verts) for (const e of v._e) if (vs.has(e.other(v))) es.add(e);
    edges = [...es];
  }
  const chains = edgeChains(edges);
  const newEdges: BMEdge[] = [];
  let ring: BMVert[] | null = null;
  if (chains.length === 1 && chains[0].verts.length === verts.length) {
    const c = chains[0];
    if (!c.closed) {
      newEdges.push(makeEdge(bm, c.verts[c.verts.length - 1], c.verts[0]));
    }
    ring = c.verts;
  } else ring = orderAround(verts);
  const f = fillLoop(bm, ring, null, mat, smooth);
  if (f) for (const l of faceLoops(f)) if (!newEdges.includes(l.edge) && l.edge._l.length === 1 && !edges.includes(l.edge)) newEdges.push(l.edge);
  return { faces: f ? [f] : [], edges: newEdges };
});

// ---------------------------------------------------------------------------
// bridge

function bridgePair(bm: BMesh, A: { verts: BMVert[]; closed: boolean }, B: { verts: BMVert[]; closed: boolean }, twist: number, merge: boolean, mergeFactor: number) {
  const n = A.verts.length,
    m = B.verts.length;
  const closed = A.closed && B.closed;
  let b = B.verts;
  // align direction and start
  if (closed) {
    let best = Infinity,
      bestB = b;
    for (const cand of [b, [...b].reverse()])
      for (let k = 0; k < m; k++) {
        const rot = [...cand.slice(k), ...cand.slice(0, k)];
        let s = 0;
        for (let i = 0; i < n; i++) s += dist(A.verts[i]._co, rot[Math.floor((i * m) / n)]._co);
        if (s < best) (best = s), (bestB = rot);
      }
    b = bestB;
    const t = ((twist % m) + m) % m;
    if (t) b = [...b.slice(t), ...b.slice(0, t)];
  } else {
    const fwd = dist(A.verts[0]._co, b[0]._co) + dist(A.verts[n - 1]._co, b[m - 1]._co);
    const rev = dist(A.verts[0]._co, b[m - 1]._co) + dist(A.verts[n - 1]._co, b[0]._co);
    if (rev < fwd) b = [...b].reverse();
  }
  if (merge) {
    const map = new Map<BMVert, BMVert>();
    if (n === m)
      for (let i = 0; i < n; i++) {
        const va = A.verts[i],
          vb = b[i];
        va._co = [...add(scale(va._co, 1 - mergeFactor), scale(vb._co, mergeFactor))];
        map.set(vb, va);
      }
    weldVerts(bm, map);
    return { faces: [] as BMFace[], edges: [] as BMEdge[] };
  }
  const faces: BMFace[] = [];
  const quads: BMVert[][] = [];
  const segA = closed ? n : n - 1,
    segB = closed ? m : m - 1;
  if (n === m) {
    for (let i = 0; i < segA; i++) quads.push([A.verts[i], A.verts[(i + 1) % n], b[(i + 1) % m], b[i]]);
  } else {
    // zip by parameter: triangles where the counts differ
    let i = 0,
      j = 0;
    while (i < segA || j < segB) {
      const ta = (i + 1) / segA,
        tb = (j + 1) / segB;
      if (j >= segB || (i < segA && ta <= tb)) {
        quads.push([A.verts[i], A.verts[(i + 1) % n], b[j % m]]);
        i++;
      } else {
        quads.push([A.verts[i % n], b[(j + 1) % m], b[j]]);
        j++;
      }
    }
  }
  // orientation from the faces already using loop A
  let vote = 0;
  for (let i = 0; i < segA; i++) {
    const e = edgeBetween(A.verts[i], A.verts[(i + 1) % n]);
    if (e) for (const l of e._l) vote += l.vert === A.verts[i] ? -1 : 1;
  }
  if (!vote)
    for (let j = 0; j < segB; j++) {
      const e = edgeBetween(b[j], b[(j + 1) % m]);
      if (e) for (const l of e._l) vote += l.vert === b[(j + 1) % m] ? -1 : 1;
    }
  const before = new Set<BMEdge>();
  for (const q of quads) for (let k = 0; k < q.length; k++) {
    const e = edgeBetween(q[k], q[(k + 1) % q.length]);
    if (e) before.add(e);
  }
  for (const q0 of quads) {
    const q = vote < 0 ? [...q0].reverse() : q0;
    if (new Set(q).size < 3 || findFace(q)) continue;
    const f = makeFace(bm, q, { loopData: neighborLoopData(q) });
    const nb = vertLoops(q[0]).find((l) => l.face !== f)?.face;
    if (nb) (f.material_index = nb.material_index), (f.smooth = nb.smooth);
    faces.push(f);
  }
  const edges = new Set<BMEdge>();
  for (const f of faces) for (const l of faceLoops(f)) if (!before.has(l.edge)) edges.add(l.edge);
  return { faces, edges: [...edges] };
}

defOp('bridge_loops', { edges: [], use_pairs: false, use_cyclic: false, use_merge: false, merge_factor: 0.5, twist_offset: 0 }, (bm, a) => {
  const chains = edgeChains(argEdges(a.edges, 'bridge_loops(edges)')).filter((c) => c.verts.length >= 2);
  if (chains.length < 2) throw pyError('RuntimeError', 'bridge_loops(): select at least two edge loops');
  const pairs: [number, number][] = [];
  if (a.use_pairs) for (let i = 0; i + 1 < chains.length; i += 2) pairs.push([i, i + 1]);
  else {
    // chain order: nearest neighbours starting from the first
    for (let i = 0; i + 1 < chains.length; i++) pairs.push([i, i + 1]);
    if (a.use_cyclic && chains.length > 2) pairs.push([chains.length - 1, 0]);
  }
  const faces: BMFace[] = [],
    edges: BMEdge[] = [];
  for (const [i, j] of pairs) {
    const r = bridgePair(bm, chains[i], chains[j], argInt(a.twist_offset, 'twist_offset'), !!a.use_merge, argNum(a.merge_factor, 'merge_factor'));
    faces.push(...r.faces);
    edges.push(...r.edges);
  }
  return { faces, edges };
});

// ---------------------------------------------------------------------------
// spin / mirror

defOp(
  'spin',
  { geom: [], cent: [0, 0, 0], axis: [0, 0, 1], dvec: [0, 0, 0], angle: 0, space: null, steps: 0, use_merge: false, use_normal_flip: false, use_duplicate: false },
  (bm, a) => {
    let g = geomSplit(a.geom, 'spin(geom)');
    const steps = Math.max(0, argInt(a.steps, 'steps'));
    const angle = argNum(a.angle, 'angle');
    const cent = argVec(a.cent, 'cent'),
      axis = argVec(a.axis, 'axis'),
      dvec = argVec(a.dvec, 'dvec');
    const R = mulMat(translation(add(cent, dvec)), mulMat(axisRotation(axis, steps ? angle / steps : 0), translation(scale(cent, -1))));
    const M = inSpace(R, a.space);
    const first = { verts: [...g.verts], edges: [...g.edges], faces: [...g.faces] };
    const firstVerts = new Set<BMVert>(g.verts);
    for (const e of g.edges) firstVerts.add(e.v1), firstVerts.add(e.v2);
    for (const f of g.faces) for (const v of faceVerts(f)) firstVerts.add(v);
    const firstList = [...firstVerts];
    let lastMap = new Map<BMVert, BMVert>(firstList.map((v) => [v, v]));
    for (let s = 0; s < steps; s++) {
      let out: { verts: BMVert[]; edges: BMEdge[]; faces: BMFace[] };
      const prevVerts = new Set<BMVert>(g.verts);
      for (const e of g.edges) prevVerts.add(e.v1), prevVerts.add(e.v2);
      for (const f of g.faces) for (const v of faceVerts(f)) prevVerts.add(v);
      const vmap = new Map<BMVert, BMVert>();
      if (a.use_duplicate) {
        const r = duplicateGeom(bm, g);
        r.vmap.forEach((n, o) => vmap.set(o, n));
        out = { verts: [...r.vmap.values()], edges: [...r.emap.values()], faces: [...r.fmap.values()] };
      } else if (g.faces.length) {
        const inE = new Set<BMEdge>(s > 0 ? g.faces.flatMap((f) => faceLoops(f).map((l) => l.edge)) : g.edges);
        const before = new Map(g.faces.flatMap((f) => faceLoops(f).map((l) => [l.vert, l.vert] as [BMVert, BMVert])));
        const r = extrudeRegion(bm, g.faces, inE, false, !!a.use_normal_flip);
        // the new verts were made in the order of first appearance in the region
        const olds = [...before.keys()];
        r.verts.forEach((n, i) => vmap.set(olds[i], n));
        const fe = new Set(r.faces.flatMap((f) => faceLoops(f).map((l) => l.edge)));
        out = { verts: r.verts, edges: [...fe], faces: r.faces };
      } else {
        const loose = g.verts.filter((v) => !g.edges.some((e) => e.v1 === v || e.v2 === v));
        const r = extrudeEdges(bm, g.edges, !!a.use_normal_flip);
        // map old verts to new through the connecting edges
        for (const n of r.verts) {
          const e = n._e.find((x) => x.other(n)._bm && prevVerts.has(x.other(n)) && !r.edges.includes(x));
          if (e) vmap.set(e.other(n), n);
        }
        const rv = extrudeVerts(bm, loose);
        loose.forEach((v, i) => vmap.set(v, rv.verts[i]));
        out = { verts: [...r.verts, ...rv.verts], edges: r.edges, faces: [] };
      }
      const moved = new Set(out.verts);
      transformVerts([...moved], M, false, bm);
      const nextMap = new Map<BMVert, BMVert>();
      lastMap.forEach((cur, orig) => nextMap.set(orig, vmap.get(cur) ?? cur));
      lastMap = nextMap;
      g = out;
    }
    if (a.use_merge && !a.use_duplicate && steps && Math.abs(Math.abs(angle) - 2 * Math.PI) < 1e-4) {
      // a closed sweep has no caps
      for (const f of [...first.faces, ...g.faces]) killFace(f);
      const weld = new Map<BMVert, BMVert>();
      lastMap.forEach((last, orig) => {
        if (last !== orig && last._bm && orig._bm) weld.set(last, orig);
      });
      weldVerts(bm, weld);
      g = { verts: first.verts.filter((v) => v._bm), edges: first.edges.filter((e) => e._bm), faces: first.faces.filter((f) => f._bm) };
    }
    const verts = new Set<BMVert>(g.verts);
    for (const e of g.edges) verts.add(e.v1), verts.add(e.v2);
    for (const f of g.faces) for (const v of faceVerts(f)) verts.add(v);
    return { geom_last: geomOut(verts, g.edges, g.faces) };
  },
);

defOp('mirror', { geom: [], matrix: null, merge_dist: 0, axis: 'X', mirror_u: false, mirror_v: false, mirror_udim: false, use_shapekey: false }, (bm, a) => {
  const g = geomSplit(a.geom, 'mirror(geom)');
  const ax = argEnum(a.axis, ['X', 'Y', 'Z'], 'axis');
  const S = IDENTITY4();
  S['XYZ'.indexOf(ax)]['XYZ'.indexOf(ax)] = -1;
  const M = inSpace(S, a.matrix);
  const r = duplicateGeom(bm, g);
  const newVerts = [...r.vmap.values()];
  transformVerts(newVerts, M, !!a.use_shapekey, bm);
  for (const f of r.fmap.values()) flipFace(f);
  const uv = uvLayer(bm);
  if (uv && (a.mirror_u || a.mirror_v))
    for (const f of r.fmap.values())
      for (const l of faceLoops(f)) {
        const d = layerValue(l, uv) as number[];
        if (a.mirror_u) d[0] = 1 - d[0];
        if (a.mirror_v) d[1] = 1 - d[1];
      }
  const md = argNum(a.merge_dist, 'merge_dist');
  if (md > 0) {
    const weld = new Map<BMVert, BMVert>();
    r.vmap.forEach((n, o) => {
      if (dist(n._co, o._co) <= md) weld.set(n, o);
    });
    if (weld.size) weldVerts(bm, weld);
  }
  return { geom: geomOut(r.vmap.values(), r.emap.values(), r.fmap.values()) };
});

// ---------------------------------------------------------------------------
// smoothing

defOp(
  'smooth_vert',
  { verts: [], factor: 0, mirror_clip_x: false, mirror_clip_y: false, mirror_clip_z: false, clip_dist: 0, use_axis_x: false, use_axis_y: false, use_axis_z: false },
  (_bm, a) => {
    const verts = argVerts(a.verts, 'smooth_vert(verts)');
    const f = argNum(a.factor, 'factor');
    const axes = [!!a.use_axis_x, !!a.use_axis_y, !!a.use_axis_z];
    const clip = [!!a.mirror_clip_x, !!a.mirror_clip_y, !!a.mirror_clip_z];
    const cd = argNum(a.clip_dist, 'clip_dist');
    const target = verts.map((v) => {
      if (!v._e.length) return v._co.slice();
      const s = v._e.reduce((acc, e) => add(acc, e.other(v)._co), [0, 0, 0] as Num3);
      return scale(s, 1 / v._e.length);
    });
    verts.forEach((v, i) => {
      for (let k = 0; k < 3; k++) {
        if (!axes[k]) continue;
        if (clip[k] && Math.abs(v._co[k]) <= cd) {
          v._co[k] = 0;
          continue;
        }
        v._co[k] += (target[i][k] - v._co[k]) * f;
      }
    });
  },
);

// ---------------------------------------------------------------------------
// convex hull

function hull3(points: Num3[]): number[][] | null {
  const n = points.length;
  if (n < 4) return null;
  const P = points;
  const eps = 1e-9 * Math.max(1, ...P.map((p) => len(p)));
  // initial tetrahedron
  let i0 = 0,
    i1 = -1,
    i2 = -1,
    i3 = -1;
  for (let i = 1; i < n; i++) if (dist(P[i], P[i0]) > eps) (i1 = i), (i = n);
  if (i1 < 0) return null;
  let best = eps;
  for (let i = 0; i < n; i++) {
    const a = len(cross(sub(P[i1], P[i0]), sub(P[i], P[i0])));
    if (a > best) (best = a), (i2 = i);
  }
  if (i2 < 0) return null;
  const nrm = normalize(cross(sub(P[i1], P[i0]), sub(P[i2], P[i0])));
  best = eps;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(dot(sub(P[i], P[i0]), nrm));
    if (d > best) (best = d), (i3 = i);
  }
  if (i3 < 0) return null;
  let faces: number[][] = [
    [i0, i1, i2],
    [i0, i2, i3],
    [i0, i3, i1],
    [i1, i3, i2],
  ];
  const cen = scale(add(add(P[i0], P[i1]), add(P[i2], P[i3])), 0.25);
  const orient = (f: number[]) => {
    const no = cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]]));
    return dot(no, sub(P[f[0]], cen)) < 0 ? [f[0], f[2], f[1]] : f;
  };
  faces = faces.map(orient);
  const above = (f: number[], p: Num3) => dot(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])), sub(p, P[f[0]])) > eps * len(cross(sub(P[f[1]], P[f[0]]), sub(P[f[2]], P[f[0]])));
  for (let i = 0; i < n; i++) {
    if (i === i0 || i === i1 || i === i2 || i === i3) continue;
    const visible = faces.filter((f) => above(f, P[i]));
    if (!visible.length) continue;
    const edgeCount = new Map<string, [number, number]>();
    for (const f of visible)
      for (let k = 0; k < 3; k++) {
        const a = f[k],
          b = f[(k + 1) % 3];
        const key = `${b}_${a}`;
        if (edgeCount.has(key)) edgeCount.delete(key);
        else edgeCount.set(`${a}_${b}`, [a, b]);
      }
    const vis = new Set(visible);
    faces = faces.filter((f) => !vis.has(f));
    for (const [a, b] of edgeCount.values()) faces.push([a, b, i]);
  }
  return faces;
}

defOp('convex_hull', { input: [], use_existing_faces: true }, (bm, a) => {
  const g = geomSplit(a.input, 'convex_hull(input)');
  const vs = new Set<BMVert>(g.verts);
  for (const e of g.edges) vs.add(e.v1), vs.add(e.v2);
  for (const f of g.faces) for (const v of faceVerts(f)) vs.add(v);
  const verts = [...vs];
  const tris = hull3(verts.map((v) => [...v._co] as Num3));
  if (!tris) return { geom: [], geom_interior: [], geom_unused: verts, geom_holes: [] };
  const faces: BMFace[] = [];
  const used = new Set<BMVert>();
  for (const t of tris) {
    const tv = t.map((i) => verts[i]);
    tv.forEach((v) => used.add(v));
    const ex = findFace(tv);
    if (ex) {
      if (a.use_existing_faces) faces.push(ex);
      continue;
    }
    faces.push(makeFace(bm, tv, { loopData: neighborLoopData(tv) }));
  }
  const edges = new Set<BMEdge>();
  for (const f of faces) for (const l of faceLoops(f)) edges.add(l.edge);
  const interior = verts.filter((v) => !used.has(v));
  return { geom: geomOut(used, edges, faces), geom_interior: interior, geom_unused: interior, geom_holes: [] };
});

// ---------------------------------------------------------------------------
// solidify

defOp('solidify', { geom: [], thickness: 0 }, (bm, a) => {
  const g = geomSplit(a.geom, 'solidify(geom)');
  const t = argNum(a.thickness, 'thickness');
  const F = new Set(g.faces);
  const nv = new Map<BMVert, BMVert>();
  for (const f of F)
    for (const l of faceLoops(f))
      if (!nv.has(l.vert)) {
        const v = l.vert;
        // average normal of the region's faces at this vertex, scaled for an even thickness
        const fs = vertLoops(v).filter((x) => F.has(x.face));
        const n = normalize(fs.reduce((s, x) => add(s, scale(faceNormal(x.face), loopAngleSafe(x))), [0, 0, 0] as Num3));
        let k = 0,
          tot = 0;
        for (const x of fs) {
          const c = Math.abs(dot(n, faceNormal(x.face)));
          k += (c > 1e-3 ? 1 / c : 1) * loopAngleSafe(x);
          tot += loopAngleSafe(x);
        }
        const fac = tot > 0 ? Math.min(k / tot, 4) : 1;
        nv.set(v, makeVert(bm, sub(v._co, scale(n, t * fac)), v));
      }
  const copies: BMFace[] = [];
  for (const f of F) {
    const ls = faceLoops(f);
    const c = makeFace(
      bm,
      ls.map((l) => nv.get(l.vert)!),
      { example: f, loops: ls, edges: ls.map((l) => l.edge) },
    );
    flipFace(c);
    copies.push(c);
  }
  for (const f of F)
    for (const l of faceLoops(f)) {
      const e = l.edge;
      if (e._l.filter((o) => F.has(o.face)).length !== 1) continue;
      const a2 = l.vert,
        b = l._next.vert;
      makeFace(bm, [b, a2, nv.get(a2)!, nv.get(b)!], { example: f, loops: [l._next, l, l, l._next], edges: [e, null, e, null] });
    }
  const edges = new Set<BMEdge>();
  for (const f of copies) for (const l of faceLoops(f)) edges.add(l.edge);
  return { geom: geomOut(nv.values(), edges, copies) };
});

function loopAngleSafe(l: BMLoop) {
  return Math.max(1e-6, angleBetween(sub(l._prev.vert._co, l.vert._co), sub(l._next.vert._co, l.vert._co)));
}

// ---------------------------------------------------------------------------
// dissolve

export function dissolveVerts(bm: BMesh, verts: BMVert[]) {
  for (const v of verts) {
    if (!v._bm) continue;
    const faces = [...new Set(vertLoops(v).map((l) => l.face))];
    if (!faces.length) {
      if (!dissolveVertInFaces(bm, v) && v._e.length !== 2) killVert(v);
      continue;
    }
    if (faces.length > 1) {
      const merged = mergeRegion(bm, faces);
      if (!merged && v._bm && v._e.length !== 2) continue;
    }
    if (v._bm && v._e.length === 2) dissolveVertInFaces(bm, v);
  }
}

defOp('dissolve_verts', { verts: [], use_face_split: false, use_boundary_tear: false }, (bm, a) => dissolveVerts(bm, argVerts(a.verts, 'dissolve_verts(verts)')));

function mergeGroups(bm: BMesh, groups: BMFace[][]): BMFace[] {
  const out: BMFace[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const f = mergeRegion(bm, g);
    if (f) out.push(f);
  }
  return out;
}

defOp('dissolve_edges', { edges: [], use_verts: false, use_face_split: false }, (bm, a) => {
  const edges = argEdges(a.edges, 'dissolve_edges(edges)');
  const eset = new Set(edges.filter((e) => e._l.length >= 2));
  const faces = new Set<BMFace>();
  for (const e of eset) for (const l of e._l) faces.add(l.face);
  const region = mergeGroups(
    bm,
    faceGroups(faces, (e) => eset.has(e)),
  );
  for (const e of edges) if (e._bm && !e._l.length) killEdge(e);
  if (a.use_verts) {
    const vs = new Set(edges.flatMap((e) => [e.v1, e.v2]));
    for (const v of vs) if (v._bm && v._e.length === 2) dissolveVertInFaces(bm, v);
    for (const v of vs) if (v._bm && !v._e.length) killVert(v);
  }
  return { region: region.filter((f) => !!f._bm) };
});

defOp('dissolve_faces', { faces: [], use_verts: false }, (bm, a) => {
  const faces = argFaces(a.faces, 'dissolve_faces(faces)');
  const fset = new Set(faces);
  // vertices that lose edges in the merge (and end up between just two) can go too
  const degree = new Map(faces.flatMap((f) => faceVerts(f)).map((v) => [v, v._e.length]));
  const region = mergeGroups(
    bm,
    faceGroups(fset, () => true),
  );
  if (a.use_verts) for (const [v, d] of degree) if (v._bm && v._e.length === 2 && d > 2) dissolveVertInFaces(bm, v);
  const single = faces.filter((f) => f._bm && !region.includes(f));
  return { region: [...region, ...single].filter((f) => !!f._bm) };
});

defOp('dissolve_limit', { angle_limit: 0.0872665, use_dissolve_boundaries: false, verts: [], edges: [], delimit: [] }, (bm, a) => {
  const lim = argNum(a.angle_limit, 'angle_limit');
  const delimit = new Set(
    (a.delimit instanceof Set ? [...a.delimit] : Array.isArray(a.delimit) ? a.delimit : typeof a.delimit === 'string' ? [a.delimit] : []).map(String),
  );
  const uv = uvLayer(bm);
  const ok = (e: BMEdge) => {
    if (e._l.length !== 2) return false;
    const [l1, l2] = e._l;
    if (delimit.has('SEAM') && e.seam) return false;
    if (delimit.has('SHARP') && !e.smooth) return false;
    if (delimit.has('MATERIAL') && l1.face.material_index !== l2.face.material_index) return false;
    if (delimit.has('UV') && uv) {
      const same = (x: BMLoop, y: BMLoop) => {
        const p = layerValue(x, uv) as number[],
          q = layerValue(y, uv) as number[];
        return Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
      };
      const o1 = l1._next,
        o2 = l2._next;
      if (!(same(l1, o2) && same(o1, l2))) return false;
    }
    return angleBetween(faceNormal(l1.face), faceNormal(l2.face)) <= lim + 1e-9;
  };
  const edges = argEdges(a.edges, 'dissolve_limit(edges)').filter(ok);
  const eset = new Set(edges);
  const faces = new Set<BMFace>();
  for (const e of eset) for (const l of e._l) faces.add(l.face);
  const region = mergeGroups(
    bm,
    faceGroups(faces, (e) => eset.has(e)),
  );
  // straight-through vertices
  for (const v of argVerts(a.verts, 'dissolve_limit(verts)')) {
    if (!v._bm || v._e.length !== 2) continue;
    if (!a.use_dissolve_boundaries && v._e.some((e) => e._l.length < 2) && !v._e.every((e) => e._l.length === 1)) continue;
    if (v.calc_edge_angle(Math.PI) <= lim + 1e-9) dissolveVertInFaces(bm, v);
  }
  return { region: region.filter((f) => !!f._bm) };
});

// ---------------------------------------------------------------------------
// join triangles

defOp(
  'join_triangles',
  { faces: [], cmp_seam: false, cmp_sharp: false, cmp_uvs: false, cmp_vcols: false, cmp_materials: false, angle_face_threshold: 0.698132, angle_shape_threshold: 0.698132 },
  (bm, a) => {
    const faces = argFaces(a.faces, 'join_triangles(faces)');
    const tris = new Set(faces.filter((f) => f._len === 3));
    const fth = argNum(a.angle_face_threshold, 'angle_face_threshold'),
      sth = argNum(a.angle_shape_threshold, 'angle_shape_threshold');
    const cands: { e: BMEdge; cost: number }[] = [];
    const seen = new Set<BMEdge>();
    for (const f of tris)
      for (const l of faceLoops(f)) {
        const e = l.edge;
        if (seen.has(e) || e._l.length !== 2) continue;
        seen.add(e);
        const [l1, l2] = e._l;
        if (!tris.has(l1.face) || !tris.has(l2.face) || l1.face === l2.face) continue;
        if (a.cmp_seam && e.seam) continue;
        if (a.cmp_sharp && !e.smooth) continue;
        if (a.cmp_materials && l1.face.material_index !== l2.face.material_index) continue;
        const fa = angleBetween(faceNormal(l1.face), faceNormal(l2.face));
        if (fa > fth) continue;
        // the quad: l1.vert, (l1's opposite), l2.vert…
        const q = [l1._next.vert, l1._prev.vert, l1.vert, l2._prev.vert];
        const angles = q.map((v, i) => angleBetween(sub(q[(i + 3) % 4]._co, v._co), sub(q[(i + 1) % 4]._co, v._co)));
        if (angles.some((x) => x >= Math.PI - 1e-3)) continue;
        // convex: corner normals agree
        const n = newell(q.map((v) => v._co));
        let convex = true;
        for (let i = 0; i < 4; i++) if (dot(cross(sub(q[i]._co, q[(i + 3) % 4]._co), sub(q[(i + 1) % 4]._co, q[i]._co)), n) <= 0) convex = false;
        if (!convex) continue;
        const shape = Math.max(...angles.map((x) => Math.abs(x - Math.PI / 2)));
        if (shape > sth) continue;
        cands.push({ e, cost: fa + shape });
      }
    cands.sort((x, y) => x.cost - y.cost);
    const used = new Set<BMFace>();
    const out = new Set<BMFace>(faces);
    for (const { e } of cands) {
      if (!e._bm || e._l.length !== 2) continue;
      const [f1, f2] = [e._l[0].face, e._l[1].face];
      if (used.has(f1) || used.has(f2)) continue;
      used.add(f1);
      used.add(f2);
      const q = mergeRegion(bm, [f1, f2]);
      out.delete(f1);
      out.delete(f2);
      if (q) out.add(q);
    }
    return { faces: [...out].filter((f) => !!f._bm) };
  },
);
