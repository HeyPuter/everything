// bmesh.ops, part 2: subdivide, inset, bevel / wireframe (driving the Edit Mode kernels),
// bisect, edge split / rotate, beautify, UV / color rotation.
import { pyError } from './rna';
import { MeshEdit, edgeKey, type EFace } from '../modes/editmesh/meshedit';
import { bevelEdges, bevelVertices } from '../modes/editmesh/bevel';
import { wireframe as wireframeKernel, gridFill } from '../modes/editmesh/ops-faces';
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
  ensureEdge,
  killVert,
  killEdge,
  killFace,
  faceLoops,
  vertLoops,
  edgeBetween,
  faceNormal,
  vertNormal,
  splitEdge,
  splitFace,
  mixCd,
  cloneValue,
  faceSpec,
  buildFace,
  layerValue,
  polyWeights,
  triQuality,
  sub,
  add,
  scale,
  dot,
  cross,
  dist,
  normalize,
  lerp,
} from './bmesh_core';
import { defOp, geomSplit, argVerts, argEdges, argFaces, argVec, argNum, argInt, argEnum } from './bmesh_opdefs';
import { mergeRegion } from './bmesh_ops';

// ---------------------------------------------------------------------------
// subdivide

function seeded(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

defOp(
  'subdivide_edges',
  {
    edges: [],
    smooth: 0,
    smooth_falloff: 'SMOOTH',
    fractal: 0,
    along_normal: 0,
    cuts: 0,
    seed: 0,
    custom_patterns: null,
    edge_percents: null,
    quad_corner_type: 'STRAIGHT_CUT',
    use_grid_fill: false,
    use_single_edge: false,
    use_only_quads: false,
    use_sphere: false,
    use_smooth_even: false,
  },
  (bm, a) => {
    const edges = argEdges(a.edges, 'subdivide_edges(edges)');
    const cuts = argInt(a.cuts, 'cuts');
    const empty = { geom_inner: [] as BMElem[], geom_split: [] as BMElem[], geom: [] as BMElem[] };
    if (cuts < 1 || !edges.length) return empty;
    const smooth = argNum(a.smooth, 'smooth');
    const fractal = argNum(a.fractal, 'fractal'),
      alongNormal = argNum(a.along_normal, 'along_normal');
    const rnd = seeded(argInt(a.seed, 'seed'));
    const percents = a.edge_percents instanceof Map ? (a.edge_percents as Map<unknown, unknown>) : null;
    const eset = new Set(edges);
    // faces to fill, with their original corners
    const faces = new Set<BMFace>();
    for (const e of edges) for (const l of e._l) faces.add(l.face);
    const corners = new Map<BMFace, BMVert[]>();
    for (const f of faces) corners.set(f, faceLoops(f).map((l) => l.vert));
    const vno = new Map<BMVert, Num3>();
    for (const e of edges) for (const v of [e.v1, e.v2]) if (!vno.has(v)) vno.set(v, vertNormal(v));
    const center: Num3 = [0, 0, 0];
    if (a.use_sphere) {
      let n = 0;
      for (const v of bm._v) (center[0] += v._co[0]), (center[1] += v._co[1]), (center[2] += v._co[2]), n++;
      for (let k = 0; k < 3; k++) center[k] /= Math.max(1, n);
    }
    const splitVerts: BMVert[] = [],
      splitEdges = new Set<BMEdge>();
    /** cut vertices along each original edge, ordered from v1 to v2 */
    const cutsOf = new Map<BMEdge, { a: BMVert; b: BMVert; verts: BMVert[] }>();
    for (const e of edges) {
      const A = e.v1,
        B = e.v2;
      const pa = A._co.slice(),
        pb = B._co.slice();
      const na = vno.get(A)!,
        nb = vno.get(B)!;
      const verts: BMVert[] = [];
      let cur = e,
        from = A;
      splitEdges.add(e);
      const pct = cuts === 1 && percents?.has(e) ? Number(percents.get(e)) : null;
      for (let k = 1; k <= cuts; k++) {
        const t = pct ?? k / (cuts + 1);
        // fraction of the remaining segment
        const remainingStart = k === 1 ? 0 : (pct ?? (k - 1) / (cuts + 1));
        const local = (t - remainingStart) / (1 - remainingStart);
        const [nv, ne] = splitEdge(bm, cur, from, local);
        // smooth: follow a curve through the end points along their normals
        if (smooth || fractal || alongNormal) {
          const d = sub(pb, pa);
          const ta = sub(d, scale(na, dot(d, na))),
            tb = sub(d, scale(nb, dot(d, nb)));
          const h00 = 2 * t ** 3 - 3 * t ** 2 + 1,
            h10 = t ** 3 - 2 * t ** 2 + t,
            h01 = -2 * t ** 3 + 3 * t ** 2,
            h11 = t ** 3 - t ** 2;
          const curve = add(add(scale(pa, h00), scale(ta, h10)), add(scale(pb, h01), scale(tb, h11)));
          let p: Num3 = lerp(lerp(pa, pb, t), curve, smooth) as Num3;
          const nrm = normalize(lerp(na, nb, t));
          if (fractal) p = add(p, scale(nrm, rnd() * fractal * dist(pa, pb) * 0.5));
          if (alongNormal) p = add(p, scale(nrm, alongNormal * dist(pa, pb) * t * (1 - t)));
          nv._co = [...p];
        }
        verts.push(nv);
        splitVerts.push(nv);
        splitEdges.add(ne);
        cur = ne;
        from = nv;
      }
      cutsOf.set(e, { a: A, b: B, verts });
    }
    if (a.use_sphere) {
      const r = edges.reduce((s, e) => s + dist(e.v1._co, center), 0) / edges.length;
      for (const v of splitVerts) v._co = [...add(center, scale(normalize(sub(v._co, center)), r))];
    }
    const cutIndex = new Map<string, BMVert[]>();
    for (const c of cutsOf.values()) {
      cutIndex.set(`${c.a.__key}>${c.b.__key}`, c.verts);
      cutIndex.set(`${c.b.__key}>${c.a.__key}`, [...c.verts].reverse());
    }
    const side = (p: BMVert, q: BMVert) => cutIndex.get(`${p.__key}>${q.__key}`) ?? null;
    const innerVerts: BMVert[] = [],
      innerEdges = new Set<BMEdge>(),
      innerFaces = new Set<BMFace>();
    const loopAt = (f: BMFace, v: BMVert) => faceLoops(f).find((l) => l.vert === v) ?? null;
    const connect = (f: BMFace, pairs: [BMVert, BMVert][]) => {
      // f keeps the part from the first vertex to the second: process outermost pairs first
      for (const [x, y] of pairs) {
        const la = loopAt(f, x),
          lb = loopAt(f, y);
        if (!la || !lb) continue;
        const r = splitFace(bm, f, la, lb);
        if (!r) continue;
        r[1]._sel = x._sel && y._sel;
        innerEdges.add(r[1]);
        innerFaces.add(r[0]);
        innerFaces.add(f);
      }
    };
    for (const [f, cs] of corners) {
      if (!f._bm) continue;
      const n = cs.length;
      const sides = cs.map((p, i) => side(p, cs[(i + 1) % n]));
      const nsplit = sides.filter(Boolean).length;
      if (n === 4 && nsplit === 4 && a.use_grid_fill) {
        gridFillQuad(bm, f, cs, sides as BMVert[][], cuts, innerVerts, innerEdges, innerFaces);
      } else if (n === 3 && nsplit === 3 && a.use_grid_fill) {
        gridFillTri(bm, f, cs, sides as BMVert[][], cuts, innerVerts, innerEdges, innerFaces);
      } else if (n === 4 && nsplit === 2 && ((sides[0] && sides[2]) || (sides[1] && sides[3]))) {
        const s = sides[0] ? 0 : 1;
        const A = sides[s]!,
          B = sides[s + 2]!;
        const pairs: [BMVert, BMVert][] = [];
        for (let k = 0; k < cuts; k++) pairs.push([A[k], B[cuts - 1 - k]]);
        // keep the remainder in f: split from the far end
        connect(f, pairs.reverse().map(([x, y]) => [y, x]));
      } else if (n === 4 && nsplit === 2) {
        // two adjacent sides: straight cuts around the shared corner
        const s = sides[0] && sides[1] ? 0 : sides[1] && sides[2] ? 1 : sides[2] && sides[3] ? 2 : 3;
        const A = sides[s]!,
          B = sides[(s + 1) % 4]!;
        const pairs: [BMVert, BMVert][] = [];
        for (let k = 0; k < cuts; k++) pairs.push([A[k], B[cuts - 1 - k]]);
        connect(f, pairs);
      } else if (n === 3 && nsplit === 1 && a.use_single_edge) {
        const s = sides.findIndex(Boolean);
        const opp = cs[(s + 2) % 3];
        const A = sides[s]!;
        connect(
          f,
          A.map((v) => [v, opp] as [BMVert, BMVert]),
        );
      }
    }
    for (const f of [...innerFaces]) if (f._bm) f._no = faceNormal(f);
    const geom_split = [...splitVerts, ...splitEdges].filter((x) => !!x._bm);
    const geom_inner = [...innerVerts, ...innerEdges, ...innerFaces].filter((x) => !!x._bm);
    return { geom_inner, geom_split, geom: [...new Set([...geom_split, ...geom_inner])] };
  },
);

/** Replace a quad (whose 4 sides carry `cuts` vertices each) with a (cuts+1)² grid. */
function gridFillQuad(bm: BMesh, f: BMFace, cs: BMVert[], sides: BMVert[][], cuts: number, innerVerts: BMVert[], innerEdges: Set<BMEdge>, innerFaces: Set<BMFace>) {
  const N = cuts + 1;
  const L: BMVert[][] = Array.from({ length: N + 1 }, () => new Array(N + 1));
  // L[i][j]: i along side 0 (c0→c1), j along side 3 reversed (c0→c3)
  L[0][0] = cs[0];
  L[N][0] = cs[1];
  L[N][N] = cs[2];
  L[0][N] = cs[3];
  for (let k = 0; k < cuts; k++) {
    L[k + 1][0] = sides[0][k];
    L[N][k + 1] = sides[1][k];
    L[N - 1 - k][N] = sides[2][k];
    L[0][N - 1 - k] = sides[3][k];
  }
  const ls = new Map(faceLoops(f).map((l) => [l.vert, l]));
  const cl = cs.map((v) => ls.get(v)!);
  for (let i = 1; i < N; i++)
    for (let j = 1; j < N; j++) {
      const u = i / N,
        v = j / N;
      // Coons patch through the four sides
      const B = L[i][0]._co,
        T = L[i][N]._co,
        Lf = L[0][j]._co,
        R = L[N][j]._co;
      const c00 = cs[0]._co,
        c10 = cs[1]._co,
        c11 = cs[2]._co,
        c01 = cs[3]._co;
      const p: Num3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) p[k] = (1 - v) * B[k] + v * T[k] + (1 - u) * Lf[k] + u * R[k] - ((1 - u) * (1 - v) * c00[k] + u * (1 - v) * c10[k] + u * v * c11[k] + (1 - u) * v * c01[k]);
      const w: [number, number][] = [
        [0, (1 - u) * (1 - v)],
        [1, u * (1 - v)],
        [2, u * v],
        [3, (1 - u) * v],
      ];
      const nv = makeVert(bm, p);
      nv._cd = mixCd(
        bm,
        'verts',
        w.map(([c, x]) => [cs[c]._cd, x]),
      );
      nv._sel = cs.every((x) => x._sel);
      L[i][j] = nv;
      innerVerts.push(nv);
    }
  // corner data: boundary verts use the face's loop there, inner ones blend the corners
  const loopData = (i: number, j: number): unknown[] => {
    const v = L[i][j];
    const l = ls.get(v);
    if (l) return l._cd.map(cloneValue);
    const u = i / N,
      t = j / N;
    return mixCd(bm, 'loops', [
      [cl[0]._cd, (1 - u) * (1 - t)],
      [cl[1]._cd, u * (1 - t)],
      [cl[2]._cd, u * t],
      [cl[3]._cd, (1 - u) * t],
    ]);
  };
  const before = new Set<BMEdge>(faceLoops(f).map((l) => l.edge));
  const data = new Map<string, unknown[]>();
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) data.set(`${i},${j}`, loopData(i, j));
  const sel = f._sel;
  killFace(f);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const idx = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const nf = makeFace(
        bm,
        idx.map(([x, y]) => L[x][y]),
        { example: f, loopData: idx.map(([x, y]) => data.get(`${x},${y}`)!) },
      );
      nf._sel = sel;
      innerFaces.add(nf);
      for (const l of faceLoops(nf)) if (!before.has(l.edge)) innerEdges.add(l.edge), (l.edge._sel = l.edge.v1._sel && l.edge.v2._sel);
    }
}

/** Replace a triangle (sides carry `cuts` vertices each) with a triangular grid. */
function gridFillTri(bm: BMesh, f: BMFace, cs: BMVert[], sides: BMVert[][], cuts: number, innerVerts: BMVert[], innerEdges: Set<BMEdge>, innerFaces: Set<BMFace>) {
  const N = cuts + 1;
  // P(i, j): i steps along A→B, j along A→C
  const P = new Map<string, BMVert>();
  const key = (i: number, j: number) => `${i},${j}`;
  P.set(key(0, 0), cs[0]);
  P.set(key(N, 0), cs[1]);
  P.set(key(0, N), cs[2]);
  for (let k = 0; k < cuts; k++) {
    P.set(key(k + 1, 0), sides[0][k]); // A→B
    P.set(key(N - 1 - k, k + 1), sides[1][k]); // B→C
    P.set(key(0, N - 1 - k), sides[2][k]); // C→A
  }
  const ls = new Map(faceLoops(f).map((l) => [l.vert, l]));
  const cl = cs.map((v) => ls.get(v)!);
  for (let i = 1; i < N; i++)
    for (let j = 1; i + j < N; j++) {
      const wb = i / N,
        wc = j / N,
        wa = 1 - wb - wc;
      // blend of the three straight interpolations through the side cuts (keeps smoothed sides)
      const ab = P.get(key(i + j, 0))!._co,
        ac = P.get(key(0, i + j))!._co;
      const p1 = lerp(ab, ac, j / (i + j));
      const bc = P.get(key(i, N - i))!._co,
        ba = P.get(key(i, 0))!._co;
      const p2 = lerp(ba, bc, j / (N - i));
      const ca = P.get(key(0, j))!._co,
        cb = P.get(key(N - j, j))!._co;
      const p3 = lerp(ca, cb, i / (N - j));
      const p = scale(add(add(p1, p2), p3), 1 / 3);
      const nv = makeVert(bm, p);
      nv._cd = mixCd(bm, 'verts', [
        [cs[0]._cd, wa],
        [cs[1]._cd, wb],
        [cs[2]._cd, wc],
      ]);
      nv._sel = cs.every((x) => x._sel);
      P.set(key(i, j), nv);
      innerVerts.push(nv);
    }
  const loopData = (i: number, j: number) => {
    const v = P.get(key(i, j))!;
    const l = ls.get(v);
    if (l) return l._cd.map(cloneValue);
    const wb = i / N,
      wc = j / N;
    return mixCd(bm, 'loops', [
      [cl[0]._cd, 1 - wb - wc],
      [cl[1]._cd, wb],
      [cl[2]._cd, wc],
    ]);
  };
  const before = new Set<BMEdge>(faceLoops(f).map((l) => l.edge));
  const tris: [number, number][][] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; i + j < N; j++) {
      tris.push([
        [i, j],
        [i + 1, j],
        [i, j + 1],
      ]);
      if (i + j < N - 1)
        tris.push([
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1],
        ]);
    }
  const data = tris.map((t) => t.map(([i, j]) => loopData(i, j)));
  const sel = f._sel;
  killFace(f);
  tris.forEach((t, k) => {
    const nf = makeFace(
      bm,
      t.map(([i, j]) => P.get(key(i, j))!),
      { example: f, loopData: data[k] },
    );
    nf._sel = sel;
    innerFaces.add(nf);
    for (const l of faceLoops(nf)) if (!before.has(l.edge)) innerEdges.add(l.edge), (l.edge._sel = l.edge.v1._sel && l.edge.v2._sel);
  });
}

// ---------------------------------------------------------------------------
// inset

/** Move a face onto new corner vertices in place (the face keeps its identity). */
function relinkFace(bm: BMesh, f: BMFace, map: Map<BMVert, BMVert>) {
  const ls = faceLoops(f);
  const olds = ls.map((l) => l.edge);
  for (const l of ls) {
    const r = l.edge._l;
    r.splice(r.indexOf(l), 1);
  }
  ls.forEach((l, i) => {
    l.vert = map.get(l.vert) ?? l.vert;
    void i;
  });
  ls.forEach((l, i) => {
    const b = l._next.vert;
    const e = ensureEdge(bm, l.vert, b, olds[i]);
    l.edge = e;
    e._l.push(l);
  });
}

function insetOffset(dirs: Num3[], thickness: number, even: boolean): Num3 {
  if (!dirs.length) return [0, 0, 0];
  const m = normalize(dirs.reduce((s, d) => add(s, d), [0, 0, 0] as Num3));
  if (!even) return scale(m, thickness);
  const c = Math.max(0.1, dot(m, dirs[0]));
  return scale(m, thickness / c);
}

defOp('inset_individual', { faces: [], thickness: 0, depth: 0, use_even_offset: false, use_interpolate: true, use_relative_offset: false }, (bm, a) => {
  const t = argNum(a.thickness, 'thickness'),
    depth = argNum(a.depth, 'depth');
  const rims: BMFace[] = [];
  for (const f of argFaces(a.faces, 'inset_individual(faces)')) {
    const ls = faceLoops(f);
    const no = faceNormal(f);
    const pts = ls.map((l) => l.vert._co.slice());
    const n = ls.length;
    const scaleRel = a.use_relative_offset ? f.calc_perimeter() / n : 1;
    const origData = ls.map((l) => l._cd.map(cloneValue));
    const map = new Map<BMVert, BMVert>();
    const newPos: Num3[] = [];
    ls.forEach((l, i) => {
      const p = pts[i],
        prev = pts[(i - 1 + n) % n],
        next = pts[(i + 1) % n];
      const in0 = normalize(cross(no, sub(p, prev))),
        in1 = normalize(cross(no, sub(next, p)));
      const off = insetOffset([in0, in1], t * scaleRel, !!a.use_even_offset);
      const q = add(add(p, off), scale(no, depth * scaleRel));
      newPos.push(q);
      map.set(l.vert, makeVert(bm, q, l.vert));
    });
    // inner corner data interpolated at the new positions
    const innerData = newPos.map((q) => {
      if (!a.use_interpolate) return null;
      const w = polyWeights(pts, q, no);
      return mixCd(
        bm,
        'loops',
        origData.map((d, k) => [d, w[k]]),
      );
    });
    const olds = ls.map((l) => l.vert);
    relinkFace(bm, f, map);
    ls.forEach((l, i) => {
      if (innerData[i]) l._cd = innerData[i]!;
    });
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p0 = olds[i],
        p1 = olds[j];
      rims.push(makeFace(bm, [p0, p1, map.get(p1)!, map.get(p0)!], { example: f, loopData: [origData[i], origData[j], ls[j]._cd, ls[i]._cd] }));
    }
    f._no = faceNormal(f);
  }
  return { faces: rims };
});

defOp(
  'inset_region',
  { faces: [], faces_exclude: [], use_boundary: true, use_even_offset: true, use_interpolate: true, use_relative_offset: false, use_edge_rail: false, thickness: 0, depth: 0, use_outset: false },
  (bm, a) => {
    const R = new Set(argFaces(a.faces, 'inset_region(faces)'));
    const excl = new Set(argFaces(a.faces_exclude, 'faces_exclude'));
    const t = argNum(a.thickness, 'thickness') * (a.use_outset ? -1 : 1),
      depth = argNum(a.depth, 'depth');
    const boundary: BMLoop[] = [];
    for (const f of R)
      for (const l of faceLoops(f)) {
        const e = l.edge;
        const inR = e._l.filter((o) => R.has(o.face)).length;
        if (inR !== 1) continue;
        const outside = e._l.some((o) => !R.has(o.face) && !excl.has(o.face));
        if (!outside && !a.use_boundary) continue;
        boundary.push(l);
      }
    if (!boundary.length) return { faces: [] };
    // offsets per boundary vertex
    const dirs = new Map<BMVert, Num3[]>();
    for (const l of boundary) {
      const d = sub(l._next.vert._co, l.vert._co);
      const inward = normalize(cross(faceNormal(l.face), d));
      for (const v of [l.vert, l._next.vert]) {
        let arr = dirs.get(v);
        if (!arr) dirs.set(v, (arr = []));
        arr.push(inward);
      }
    }
    const regionVerts = new Set<BMVert>();
    for (const f of R) for (const l of faceLoops(f)) regionVerts.add(l.vert);
    // vertex normals over the region (for depth)
    const rno = new Map<BMVert, Num3>();
    for (const v of regionVerts) {
      const n = vertLoops(v)
        .filter((l) => R.has(l.face))
        .reduce((s, l) => add(s, faceNormal(l.face)), [0, 0, 0] as Num3);
      rno.set(v, normalize(n));
    }
    const map = new Map<BMVert, BMVert>();
    for (const [v, ds] of dirs) {
      const off = insetOffset(ds, t, !!a.use_even_offset);
      map.set(v, makeVert(bm, add(v._co, off), v));
    }
    // interpolated corner data for moved corners
    const oldData = new Map<BMLoop, unknown[]>();
    const oldEdges = new Set<BMEdge>();
    for (const f of R) for (const l of faceLoops(f)) oldData.set(l, l._cd.map(cloneValue)), oldEdges.add(l.edge);
    for (const f of R) {
      const ls = faceLoops(f);
      const pts = ls.map((l) => l.vert._co.slice());
      const no = faceNormal(f);
      const data = ls.map((l) => {
        const nv = map.get(l.vert);
        if (!nv || !a.use_interpolate) return null;
        const w = polyWeights(pts, nv._co, no);
        return mixCd(
          bm,
          'loops',
          ls.map((x, k) => [oldData.get(x)!, w[k]]),
        );
      });
      relinkFace(bm, f, map);
      ls.forEach((l, i) => data[i] && (l._cd = data[i]!));
    }
    // region edges between two moved vertices were replaced
    for (const e of oldEdges) if (e._bm && !e._l.length) killEdge(e);
    const rims: BMFace[] = [];
    // the boundary loops were relinked: rebuild rims from the recorded old vertices
    const inv = new Map<BMVert, BMVert>();
    map.forEach((n, o) => inv.set(n, o));
    for (const l of boundary) {
      const q0 = l.vert,
        q1 = l._next.vert;
      const p0 = inv.get(q0) ?? q0,
        p1 = inv.get(q1) ?? q1;
      if (p0 === q0 && p1 === q1) continue;
      const d0 = oldData.get(l)!,
        d1 = oldData.get(l._next) ?? l._next._cd;
      const verts = [p0, p1, q1, q0].filter((v, i, arr) => arr.indexOf(v) === i);
      if (verts.length < 3) continue;
      rims.push(makeFace(bm, verts, { example: l.face, loopData: verts.map((v) => (v === p0 ? d0 : v === p1 ? d1 : v === q1 ? l._next._cd : l._cd)) }));
    }
    if (depth) {
      for (const v of regionVerts) {
        const target = map.get(v) ?? v;
        target._co = [...add(target._co, scale(rno.get(v)!, depth))];
      }
    }
    for (const f of [...R, ...rims]) if (f._bm) f._no = faceNormal(f);
    return { faces: rims };
  },
);

// ---------------------------------------------------------------------------
// Edit Mode kernels on a BMesh (bevel, wireframe)

/**
 * Run an Edit Mode kernel on this BMesh: the mesh goes through the kernel's editable form and
 * comes back. Vertices the kernel leaves in place keep their identity; edges and faces are rebuilt.
 */
function runKernel(bm: BMesh, selVerts: Set<BMVert>, selEdges: Set<BMEdge> | null, kernel: (m: MeshEdit) => boolean, selFaces?: Set<BMFace>) {
  const verts = [...bm._v];
  const index = new Map<BMVert, number>();
  verts.forEach((v, i) => index.set(v, i));
  const m = new MeshEdit();
  m.pos = verts.flatMap((v) => v._co);
  m.sel = verts.map((v) => (selVerts.has(v) ? 1 : 0));
  m.hide = verts.map(() => 0);
  const deform = bm._layers('verts', 'deform')[0];
  let ngroups = 0;
  if (deform) for (const v of verts) (v._cd[deform._slot] as Map<number, number> | undefined)?.forEach((_, g) => (ngroups = Math.max(ngroups, g + 1)));
  m.weights = Array.from({ length: ngroups }, (_, g) => verts.map((v) => (v._cd[deform!._slot] as Map<number, number> | undefined)?.get(g) ?? 0));
  const shapes = bm._layers('verts', 'shape');
  m.keys = shapes.map((s) => verts.flatMap((v) => (layerValue(v, s) as number[]).slice(0, 3)));
  const pcol = bm._layers('verts', 'color');
  m.pcolors = pcol.map((c) => verts.flatMap((v) => layerValue(v, c) as number[]));
  const uv = bm._activeOf('loops', 'uv');
  const ccol = bm._layers('loops', 'color')[0];
  const tag = new WeakMap<EFace, BMFace>();
  for (const f of bm._f) {
    const ls = faceLoops(f);
    const ef: EFace = {
      verts: ls.map((l) => index.get(l.vert)!),
      uvs: ls.flatMap((l) => (uv ? (layerValue(l, uv) as number[]).slice(0, 2) : [0, 0])),
      smooth: f.smooth,
      material: f.material_index,
      seams: ls.map((l) => (l.edge.seam ? 1 : 0)),
      sharp: ls.map((l) => (l.edge.smooth ? 0 : 1)),
      creases: ls.map((l) => l.edge._crease),
      colors: ccol ? ls.flatMap((l) => layerValue(l, ccol) as number[]) : undefined,
    };
    if (selFaces && !selFaces.has(f)) ef.selX = true;
    tag.set(ef, f);
    m.faces.push(ef);
  }
  for (const e of bm._e) if (!e._l.length) m.looseEdges.push([index.get(e.v1)!, index.get(e.v2)!]);
  if (selEdges)
    for (const e of bm._e) {
      const a = index.get(e.v1)!,
        b = index.get(e.v2)!;
      if (m.sel[a] && m.sel[b] && !selEdges.has(e)) m.edgeExcl.add(edgeKey(a, b));
    }
  const oldFaces = new Set(bm._f);
  if (!kernel(m)) return null;
  // --- rebuild
  const byPos = new Map<string, BMVert[]>();
  const pk = (p: ArrayLike<number>) => `${p[0]},${p[1]},${p[2]}`;
  for (const v of verts) {
    const k = pk(v._co);
    const l = byPos.get(k);
    if (l) l.push(v);
    else byPos.set(k, [v]);
  }
  const edgeAttrs = new Map<string, BMEdge>();
  const pairKey = (a: BMVert, b: BMVert) => (a.__key < b.__key ? `${a.__key}|${b.__key}` : `${b.__key}|${a.__key}`);
  for (const e of bm._e) edgeAttrs.set(pairKey(e.v1, e.v2), e);
  const oldLoops = new Map<BMFace, Map<BMVert, unknown[]>>();
  for (const f of oldFaces) oldLoops.set(f, new Map(faceLoops(f).map((l) => [l.vert, l._cd.map(cloneValue)])));
  for (const f of oldFaces) killFace(f);
  for (const e of [...bm._e]) killEdge(e);
  const nv = m.vcount;
  const result: BMVert[] = new Array(nv);
  const reused = new Set<BMVert>();
  for (let i = 0; i < nv; i++) {
    const cand = byPos.get(pk(m.p(i)))?.find((v) => !reused.has(v));
    if (cand) {
      reused.add(cand);
      result[i] = cand;
      continue;
    }
    const v = makeVert(bm, m.p(i));
    if (deform) v._cd[deform._slot] = new Map(m.weights.map((w, g) => [g, w[i]] as [number, number]).filter(([, w]) => w > 0));
    shapes.forEach((s, k) => (v._cd[s._slot] = m.keys[k].slice(i * 3, i * 3 + 3)));
    pcol.forEach((c, k) => (v._cd[c._slot] = m.pcolors[k].slice(i * 4, i * 4 + 4)));
    v._sel = !!m.sel[i];
    result[i] = v;
  }
  for (const v of verts) if (!reused.has(v)) killVert(v);
  const newFaces: BMFace[] = [];
  const allFaces: BMFace[] = [];
  for (const ef of m.faces) {
    const vs = ef.verts.map((i) => result[i]);
    if (new Set(vs).size < 3) continue;
    const src = tag.get(ef) ?? null;
    const srcLoops = src ? oldLoops.get(src)! : null;
    const fallback = srcLoops ? [...srcLoops.values()][0] : null;
    const data = vs.map((v, k) => {
      const d = (srcLoops?.get(v) ?? fallback ?? []).map(cloneValue);
      if (uv) d[uv._slot] = [ef.uvs[k * 2] ?? 0, ef.uvs[k * 2 + 1] ?? 0, 0, 0, 0];
      if (ccol && ef.colors) d[ccol._slot] = ef.colors.slice(k * 4, k * 4 + 4);
      return d;
    });
    const f = makeFace(bm, vs, { example: src, loopData: data });
    f.smooth = ef.smooth;
    f.material_index = ef.material;
    f._sel = vs.every((v) => v._sel);
    faceLoops(f).forEach((l, k) => {
      const old = edgeAttrs.get(pairKey(l.vert, l._next.vert));
      if (old) {
        l.edge.seam = old.seam;
        l.edge.smooth = old.smooth;
        l.edge._crease = old._crease;
      } else {
        l.edge.seam ||= !!ef.seams[k];
        if (ef.sharp[k]) l.edge.smooth = false;
        l.edge._crease = Math.max(l.edge._crease, ef.creases[k] ?? 0);
      }
      l.edge._sel = l.vert._sel && l._next.vert._sel;
    });
    allFaces.push(f);
    if (!src) newFaces.push(f);
  }
  for (const [i, j] of m.looseEdges) {
    const a2 = result[i],
      b2 = result[j];
    if (a2 && b2 && a2 !== b2 && !edgeBetween(a2, b2)) makeEdge(bm, a2, b2, edgeAttrs.get(pairKey(a2, b2)) ?? null);
  }
  for (const v of result) if (v._bm) v._no = vertNormal(v);
  const newVerts = result.filter((v) => v._bm && !verts.includes(v));
  return { newFaces, newVerts, allFaces };
}

/** One-segment vertex bevel: each vertex is cut off by a face through points on its edges. */
function chamferVerts(bm: BMesh, verts: BMVert[], offset: number, type: string) {
  const targets = new Set(verts.filter((v) => v._bm && v._e.length));
  const limit = new Map<string, number>();
  for (const v of targets)
    for (const e of v._e) {
      const o = e.other(v);
      const L = e.calc_length();
      limit.set(`${v.__key}>${o.__key}`, targets.has(o) ? L * 0.5 : L * 0.999);
    }
  const cuts = new Map<BMVert, BMVert[]>();
  for (const v of targets) {
    const list: BMVert[] = [];
    for (const e of v._e.slice()) {
      // the original neighbour (past the cut vertex it may already have made)
      let orig = e.other(v);
      while (!limit.has(`${v.__key}>${orig.__key}`) && orig._e.length === 2) {
        const nxt = orig._e.find((x) => x !== e)?.other(orig);
        if (!nxt || nxt === v) break;
        orig = nxt;
      }
      const L = e.calc_length();
      const want = type === 'PERCENT' ? (offset / 100) * dist(v._co, orig._co) : offset;
      const d = Math.min(want, limit.get(`${v.__key}>${orig.__key}`) ?? L * 0.999, L * 0.999);
      if (d <= 0) continue;
      const [nv] = splitEdge(bm, e, v, d / L);
      nv._sel = v._sel;
      list.push(nv);
    }
    cuts.set(v, list);
  }
  const caps: BMFace[] = [];
  const newEdges = new Set<BMEdge>();
  for (const [v, list] of cuts) {
    const cs = new Set(list);
    for (const l of vertLoops(v)) {
      const f = l.face;
      if (f._len <= 3 || !cs.has(l._prev.vert) || !cs.has(l._next.vert)) continue;
      const r = splitFace(bm, f, l._prev, l._next);
      if (r) {
        newEdges.add(r[1]);
        r[1]._sel = v._sel;
      }
    }
    const ring = [...cs];
    const example = vertLoops(v)[0]?.face ?? null;
    killVert(v);
    // close the hole when the cut vertices form a ring
    const ringEdges = [...newEdges].filter((e) => e._bm && cs.has(e.v1) && cs.has(e.v2));
    if (ring.length >= 3 && ringEdges.length === ring.length) {
      const order: BMVert[] = [ring[0]];
      while (order.length < ring.length) {
        const last = order[order.length - 1];
        const nxt = ringEdges.find((e) => (e.v1 === last || e.v2 === last) && !order.includes(e.other(last)));
        if (!nxt) break;
        order.push(nxt.other(last));
      }
      if (order.length === ring.length) {
        let vote = 0;
        for (let i = 0; i < order.length; i++) {
          const e = edgeBetween(order[i], order[(i + 1) % order.length]);
          if (e) for (const x of e._l) vote += x.vert === order[i] ? -1 : 1;
        }
        const vs = vote < 0 ? order.reverse() : order;
        const data = vs.map((x) => vertLoops(x)[0]?._cd.map(cloneValue) ?? null);
        const cap = makeFace(bm, vs, { example, loopData: data });
        cap._sel = vs.every((x) => x._sel);
        caps.push(cap);
      }
    }
  }
  for (const f of bm._f) f._no = faceNormal(f);
  const edges = new Set<BMEdge>();
  for (const f of caps) for (const l of faceLoops(f)) edges.add(l.edge);
  return { faces: caps, edges: [...edges], verts: [...cuts.values()].flat().filter((v) => !!v._bm) };
}

defOp(
  'bevel',
  {
    geom: [],
    offset: 0,
    offset_type: 'OFFSET',
    profile_type: 'SUPERELLIPSE',
    segments: 1,
    profile: 0.5,
    affect: 'VERTICES',
    clamp_overlap: false,
    material: -1,
    loop_slide: true,
    mark_seam: false,
    mark_sharp: false,
    harden_normals: false,
    face_strength_mode: 'NONE',
    miter_outer: 'SHARP',
    miter_inner: 'SHARP',
    spread: 0.1,
    custom_profile: null,
    vmesh_method: 'ADJ',
  },
  (bm, a) => {
    const g = geomSplit(a.geom, 'bevel(geom)');
    const affect = argEnum(a.affect, ['VERTICES', 'EDGES'], 'affect');
    const offType = argEnum(a.offset_type, ['OFFSET', 'WIDTH', 'DEPTH', 'PERCENT', 'ABSOLUTE'], 'offset_type') as 'OFFSET';
    const offset = argNum(a.offset, 'offset'),
      segs = Math.max(1, argInt(a.segments, 'segments')),
      profile = argNum(a.profile, 'profile');
    const empty = { faces: [] as BMFace[], edges: [] as BMEdge[], verts: [] as BMVert[] };
    let r;
    if (affect === 'EDGES') {
      const edges = new Set(g.edges.filter((e) => e._l.length === 2));
      for (const f of g.faces) for (const l of faceLoops(f)) if (l.edge._l.length === 2) edges.add(l.edge);
      if (!edges.size) return empty;
      const sv = new Set<BMVert>();
      for (const e of edges) sv.add(e.v1), sv.add(e.v2);
      r = runKernel(bm, sv, edges, (m) => bevelEdges(m, offset, segs, profile, { offsetType: offType, clamp: !!a.clamp_overlap, markSeam: !!a.mark_seam, markSharp: !!a.mark_sharp, harden: !!a.harden_normals }));
    } else {
      const sv = new Set<BMVert>(g.verts);
      for (const e of g.edges) sv.add(e.v1), sv.add(e.v2);
      if (!sv.size) return empty;
      if (segs === 1) return chamferVerts(bm, [...sv], offset, offType);
      r = runKernel(bm, sv, null, (m) => bevelVertices(m, offset, segs, profile));
    }
    if (!r) return empty;
    const mat = argInt(a.material, 'material');
    if (mat >= 0) for (const f of r.newFaces) f.material_index = mat;
    const edges = new Set<BMEdge>();
    for (const f of r.newFaces) for (const l of faceLoops(f)) edges.add(l.edge);
    return { faces: r.newFaces, edges: [...edges], verts: r.newVerts };
  },
);

defOp(
  'wireframe',
  { faces: [], thickness: 0.01, offset: 0, use_replace: true, use_boundary: true, use_even_offset: true, use_crease: false, crease_weight: 1, use_relative_offset: false, material_offset: 0 },
  (bm, a) => {
    const faces = argFaces(a.faces, 'wireframe(faces)');
    const sv = new Set<BMVert>();
    for (const f of faces) for (const l of faceLoops(f)) sv.add(l.vert);
    // only the given faces count as selected
    const r = runKernel(
      bm,
      sv,
      null,
      (m) => wireframeKernel(m, { thickness: argNum(a.thickness, 'thickness'), offset: argNum(a.offset, 'offset'), boundary: !!a.use_boundary, even: !!a.use_even_offset, relative: !!a.use_relative_offset, replace: !!a.use_replace }),
      new Set(faces),
    );
    if (!r) return { faces: [] };
    const mo = argInt(a.material_offset, 'material_offset');
    if (mo) for (const f of r.newFaces) f.material_index += mo;
    return { faces: r.newFaces };
  },
);

defOp('grid_fill', { edges: [], mat_nr: 0, use_smooth: false, use_interp_simple: false }, (bm, a) => {
  const edges = new Set(argEdges(a.edges, 'grid_fill(edges)'));
  const sv = new Set<BMVert>();
  for (const e of edges) sv.add(e.v1), sv.add(e.v2);
  const n = sv.size;
  if (n < 4 || n % 2) throw pyError('RuntimeError', 'grid_fill(): expected one closed loop with an even number of edges (>= 4)');
  const r = runKernel(bm, sv, edges, (m) => gridFill(m, Math.max(1, Math.round(n / 4)), 0, !!a.use_interp_simple), new Set());
  if (!r) throw pyError('RuntimeError', 'grid_fill(): the edges must form one closed loop');
  const mat = argInt(a.mat_nr, 'mat_nr');
  for (const f of r.newFaces) {
    if (mat) f.material_index = mat;
    if (a.use_smooth) f.smooth = true;
  }
  return { faces: r.newFaces };
});

// ---------------------------------------------------------------------------
// bisect

defOp('bisect_plane', { geom: [], dist: 0, plane_co: [0, 0, 0], plane_no: [0, 0, 1], use_snap_center: false, clear_outer: false, clear_inner: false }, (bm, a) => {
  const g = geomSplit(a.geom, 'bisect_plane(geom)');
  const co = argVec(a.plane_co, 'plane_co'),
    no = normalize(argVec(a.plane_no, 'plane_no'));
  if (!no.some((x) => x !== 0)) throw pyError('ValueError', 'bisect_plane(): plane_no must not be zero');
  const eps = Math.max(argNum(a.dist, 'dist'), 1e-9);
  const side = (p: ArrayLike<number>) => dot(sub(p, co), no);
  const edges = new Set(g.edges);
  const faces = new Set(g.faces);
  for (const f of g.faces) for (const l of faceLoops(f)) edges.add(l.edge);
  const verts = new Set(g.verts);
  for (const e of edges) verts.add(e.v1), verts.add(e.v2);
  const onPlane = new Set<BMVert>();
  for (const v of verts)
    if (Math.abs(side(v._co)) <= eps) {
      onPlane.add(v);
      if (a.use_snap_center) v._co = [...sub(v._co, scale(no, side(v._co)))];
    }
  const newVerts: BMVert[] = [];
  const touchedFaces = new Set<BMFace>();
  for (const e of [...edges]) {
    const da = side(e.v1._co),
      db = side(e.v2._co);
    if (Math.abs(da) <= eps || Math.abs(db) <= eps || da * db > 0) continue;
    const t = da / (da - db);
    for (const l of e._l) touchedFaces.add(l.face);
    const [nv, ne] = splitEdge(bm, e, e.v1, t);
    nv._co = [...sub(nv._co, scale(no, side(nv._co)))];
    onPlane.add(nv);
    newVerts.push(nv);
    edges.add(ne);
    verts.add(nv);
  }
  for (const v of onPlane) for (const l of vertLoops(v)) touchedFaces.add(l.face);
  const cutEdges = new Set<BMEdge>();
  for (const f of touchedFaces) {
    if (!f._bm || (faces.size && !faces.has(f))) continue;
    // connect on-plane corners pairwise along the cut line
    const ls = faceLoops(f).filter((l) => onPlane.has(l.vert));
    if (ls.length < 2) continue;
    const dir = cross(no, faceNormal(f));
    ls.sort((x, y) => dot(x.vert._co, dir) - dot(y.vert._co, dir));
    for (let i = 0; i + 1 < ls.length; i += 2) {
      const [x, y] = [ls[i], ls[i + 1]];
      const cur = x.face;
      if (y.face !== cur) continue;
      if (x._next === y || y._next === x) {
        cutEdges.add(x._next === y ? x.edge : y.edge);
        continue;
      }
      const r = splitFace(bm, cur, x, y);
      if (r) {
        cutEdges.add(r[1]);
        r[0]._no = faceNormal(r[0]);
        faces.add(r[0]);
      }
    }
  }
  for (const v of onPlane) for (const e of v._e) if (onPlane.has(e.other(v))) cutEdges.add(e);
  if (a.clear_inner || a.clear_outer) {
    for (const v of [...verts]) {
      if (!v._bm || onPlane.has(v)) continue;
      const d = side(v._co);
      if ((a.clear_inner && d < -eps) || (a.clear_outer && d > eps)) killVert(v);
    }
  }
  const geom: BMElem[] = [...verts, ...edges, ...faces].filter((x) => !!x._bm);
  return { geom_cut: [...onPlane, ...cutEdges].filter((x) => !!x._bm), geom };
});

// ---------------------------------------------------------------------------
// split edges / rotate edges

/** Give separate vertices to corner groups that the given edges cut apart. */
export function splitEdgesAt(bm: BMesh, edges: Set<BMEdge>, onlyVerts: Set<BMVert> | null): Map<BMVert, BMVert[]> {
  const verts = new Set<BMVert>();
  for (const e of edges) for (const v of [e.v1, e.v2]) if (!onlyVerts || onlyVerts.has(v)) verts.add(v);
  const assign = new Map<BMLoop, BMVert>();
  const made = new Map<BMVert, BMVert[]>();
  for (const v of verts) {
    const ls = vertLoops(v);
    if (ls.length < 2) continue;
    const parent = new Map<BMLoop, BMLoop>(ls.map((l) => [l, l]));
    const find = (l: BMLoop): BMLoop => {
      while (parent.get(l) !== l) l = parent.get(l)!;
      return l;
    };
    for (const e of v._e) {
      if (edges.has(e)) continue;
      const cs = e._l.map((l) => (l.vert === v ? l : l._next));
      for (let i = 1; i < cs.length; i++) parent.set(find(cs[i]), find(cs[0]));
    }
    const groups = new Map<BMLoop, BMLoop[]>();
    for (const l of ls) {
      const r = find(l);
      let gl = groups.get(r);
      if (!gl) groups.set(r, (gl = []));
      gl.push(l);
    }
    if (groups.size < 2) continue;
    const list = [...groups.values()];
    const copies: BMVert[] = [];
    for (const gl of list.slice(1)) {
      const nv = makeVert(bm, v._co, v);
      copies.push(nv);
      for (const l of gl) assign.set(l, nv);
    }
    made.set(v, copies);
  }
  if (!assign.size) return made;
  const faces = new Set<BMFace>();
  for (const l of assign.keys()) faces.add(l.face);
  const oldEdges = new Set<BMEdge>();
  for (const f of faces) {
    const ls = faceLoops(f);
    const s = faceSpec(f);
    s.verts = ls.map((l) => assign.get(l) ?? l.vert);
    for (const l of ls) oldEdges.add(l.edge);
    const active = bm._active === f;
    killFace(f);
    const nf = buildFace(bm, s);
    if (nf && active) bm._active = nf;
    if (nf) nf.index = f.index;
  }
  for (const e of oldEdges) if (e._bm && !e._l.length) killEdge(e);
  return made;
}

defOp('split_edges', { edges: [], verts: [], use_verts: false }, (bm, a) => {
  const edges = new Set(argEdges(a.edges, 'split_edges(edges)'));
  const only = a.use_verts ? new Set(argVerts(a.verts, 'split_edges(verts)')) : null;
  const ends = [...edges].map((e) => [e.v1, e.v2] as [BMVert, BMVert]);
  const made = splitEdgesAt(bm, edges, only);
  // the split edges and their copies (edges between the end vertices or their copies)
  const out = new Set<BMEdge>();
  for (const [v1, v2] of ends)
    for (const x of [v1, ...(made.get(v1) ?? [])])
      for (const y of [v2, ...(made.get(v2) ?? [])]) {
        const e = x._bm && y._bm ? edgeBetween(x, y) : null;
        if (e) out.add(e);
      }
  return { edges: [...out] };
});

/** Turn a manifold edge inside the two faces it separates. */
export function rotateEdge(bm: BMesh, e: BMEdge, ccw: boolean): BMEdge | null {
  if (e._l.length !== 2) return null;
  const [l1, l2] = e._l;
  if (l1.face === l2.face || l1.vert === l2.vert) return null;
  const c = ccw ? l1._prev.vert : l1._next._next.vert;
  const d = ccw ? l2._prev.vert : l2._next._next.vert;
  if (c === d || edgeBetween(c, d) || c === e.v1 || c === e.v2 || d === e.v1 || d === e.v2) return null;
  const sel = e._sel;
  const f = mergeRegion(bm, [l1.face, l2.face]);
  if (!f) return null;
  const lc = faceLoops(f).find((l) => l.vert === c),
    ld = faceLoops(f).find((l) => l.vert === d);
  if (!lc || !ld) return null;
  const r = splitFace(bm, f, lc, ld, e._bm ? e : null);
  if (!r) return null;
  r[1]._sel = sel;
  f._no = faceNormal(f);
  r[0]._no = faceNormal(r[0]);
  return r[1];
}

defOp('rotate_edges', { edges: [], use_ccw: false }, (bm, a) => {
  const out: BMEdge[] = [];
  for (const e of argEdges(a.edges, 'rotate_edges(edges)')) {
    if (!e._bm) continue;
    const n = rotateEdge(bm, e, !!a.use_ccw);
    if (n) out.push(n);
  }
  return { edges: out };
});

defOp('beautify_fill', { faces: [], edges: [], use_restrict_tag: false, method: 'AREA' }, (bm, a) => {
  const faces = new Set(argFaces(a.faces, 'beautify_fill(faces)').filter((f) => f._len === 3));
  let edges = new Set(argEdges(a.edges, 'beautify_fill(edges)'));
  if (!edges.size) for (const f of faces) for (const l of faceLoops(f)) edges.add(l.edge);
  const out = new Set<BMElem>();
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const e of [...edges]) {
      if (!e._bm || e._l.length !== 2) continue;
      const [l1, l2] = e._l;
      if (!faces.has(l1.face) || !faces.has(l2.face) || l1.vert === l2.vert) continue;
      const a1 = e.v1._co,
        b1 = e.v2._co;
      const c = l1._prev.vert._co,
        d = l2._prev.vert._co;
      const before = Math.min(triQuality(a1, b1, c), triQuality(a1, b1, d));
      const after = Math.min(triQuality(c, d, a1), triQuality(c, d, b1));
      if (after <= before + 1e-6) continue;
      // the flipped quad must stay convex
      const n1 = cross(sub(d, c), sub(a1, c)),
        n2 = cross(sub(b1, c), sub(d, c));
      if (dot(n1, n2) <= 0) continue;
      const f1 = l1.face,
        f2 = l2.face;
      const ne = rotateEdge(bm, e, false);
      if (!ne) continue;
      faces.delete(f1);
      faces.delete(f2);
      for (const l of ne._l) faces.add(l.face), out.add(l.face);
      edges.delete(e);
      edges.add(ne);
      out.add(ne);
      changed = true;
    }
    if (!changed) break;
    edges = new Set([...edges].filter((x) => !!x._bm));
  }
  return { geom: [...out].filter((x) => !!x._bm) };
});

// ---------------------------------------------------------------------------
// UV / color rotation

function rotateLayer(bm: BMesh, faces: BMFace[], kind: 'uv' | 'color', index: number, op: 'rotate' | 'reverse', ccw: boolean) {
  const layer = kind === 'uv' ? bm._activeOf('loops', 'uv') : bm._layers('loops', 'color')[index] ?? null;
  if (!layer) return;
  for (const f of faces) {
    const ls = faceLoops(f);
    const vals = ls.map((l) => cloneValue(layerValue(l, layer)) as number[]);
    const n = ls.length;
    ls.forEach((l, i) => {
      const src = op === 'reverse' ? (n - i) % n : ccw ? (i + 1) % n : (i - 1 + n) % n;
      const v = vals[src];
      if (kind === 'uv') {
        const d = layerValue(l, layer) as number[];
        d[0] = v[0];
        d[1] = v[1];
      } else l._cd[layer._slot] = v.slice();
    });
  }
}

defOp('rotate_uvs', { faces: [], use_ccw: false }, (bm, a) => rotateLayer(bm, argFaces(a.faces, 'rotate_uvs(faces)'), 'uv', 0, 'rotate', !!a.use_ccw));
defOp('reverse_uvs', { faces: [] }, (bm, a) => rotateLayer(bm, argFaces(a.faces, 'reverse_uvs(faces)'), 'uv', 0, 'reverse', false));
defOp('rotate_colors', { faces: [], use_ccw: false, color_index: 0 }, (bm, a) => rotateLayer(bm, argFaces(a.faces, 'rotate_colors(faces)'), 'color', argInt(a.color_index, 'color_index'), 'rotate', !!a.use_ccw));
defOp('reverse_colors', { faces: [], color_index: 0 }, (bm, a) => rotateLayer(bm, argFaces(a.faces, 'reverse_colors(faces)'), 'color', argInt(a.color_index, 'color_index'), 'reverse', false));
