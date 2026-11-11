// Convex hull (incremental, with coplanar faces merged into polygons) and bounding boxes.
import { MeshComponent } from '../geometry';
import { MeshBuild } from './primitives';

type V3 = [number, number, number];

export function convexHull(points: Float32Array): MeshComponent {
  const n = points.length / 3;
  const p = (i: number): V3 => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  const empty = () => new MeshComponent(new Float32Array(0), new Uint32Array([0]), new Uint32Array(0));
  if (n === 0) return empty();
  // dedupe
  const uniq: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const k = `${points[i * 3].toFixed(6)},${points[i * 3 + 1].toFixed(6)},${points[i * 3 + 2].toFixed(6)}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(i);
    }
  }
  let bmin = Infinity,
    bmax = -Infinity;
  for (const i of uniq)
    for (let k = 0; k < 3; k++) {
      bmin = Math.min(bmin, points[i * 3 + k]);
      bmax = Math.max(bmax, points[i * 3 + k]);
    }
  const eps = Math.max(1e-9, (bmax - bmin) * 1e-7);
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // initial simplex
  let i0 = uniq[0],
    i1 = -1,
    i2 = -1,
    i3 = -1;
  for (const i of uniq) if (points[i * 3] < points[i0 * 3]) i0 = i;
  let best = 0;
  for (const i of uniq) {
    const d = dot(sub(p(i), p(i0)), sub(p(i), p(i0)));
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  if (i1 < 0) {
    const b = new MeshBuild();
    b.vert(...p(i0));
    return b.build();
  }
  best = 0;
  for (const i of uniq) {
    const c = cross(sub(p(i1), p(i0)), sub(p(i), p(i0)));
    const d = dot(c, c);
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0 || best < eps * eps) {
    const b = new MeshBuild();
    b.vert(...p(i0));
    b.vert(...p(i1));
    b.edge(0, 1);
    return b.build();
  }
  const nrm0 = cross(sub(p(i1), p(i0)), sub(p(i2), p(i0)));
  best = 0;
  for (const i of uniq) {
    const d = Math.abs(dot(nrm0, sub(p(i), p(i0))));
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0 || best / Math.sqrt(dot(nrm0, nrm0)) < eps) {
    // planar: 2D hull as a single polygon
    return planarHull(points, uniq, nrm0);
  }
  interface Face {
    v: [number, number, number];
    n: V3;
    d: number;
    alive: boolean;
    /** points outside this face that are not yet on the hull */
    outside: number[];
  }
  const faces: Face[] = [];
  // directed edge (a → b) → face owning it, for walking from a face to its neighbors
  const N = n + 1;
  const edgeFace = new Map<number, number>();
  const mk = (a: number, b: number, c: number): Face => {
    const nn = cross(sub(p(b), p(a)), sub(p(c), p(a)));
    const l = Math.hypot(...nn) || 1;
    const nu: V3 = [nn[0] / l, nn[1] / l, nn[2] / l];
    return { v: [a, b, c], n: nu, d: dot(nu, p(a)), alive: true, outside: [] };
  };
  const add = (f: Face) => {
    const id = faces.length;
    faces.push(f);
    for (let k = 0; k < 3; k++) edgeFace.set(f.v[k] * N + f.v[(k + 1) % 3], id);
    return id;
  };
  const dist = (f: Face, i: number) => f.n[0] * points[i * 3] + f.n[1] * points[i * 3 + 1] + f.n[2] * points[i * 3 + 2] - f.d;
  const centroid: V3 = [0, 0, 0];
  for (const i of [i0, i1, i2, i3]) for (let k = 0; k < 3; k++) centroid[k] += points[i * 3 + k] / 4;
  const addOriented = (a: number, b: number, c: number) => {
    let f = mk(a, b, c);
    if (dot(f.n, centroid) - f.d > 0) f = mk(a, c, b);
    add(f);
  };
  addOriented(i0, i1, i2);
  addOriented(i0, i1, i3);
  addOriented(i0, i2, i3);
  addOriented(i1, i2, i3);
  /** give each point to the first of `ids` it is outside of (points inside all of them are dropped) */
  const assign = (pts: Iterable<number>, ids: number[]) => {
    for (const i of pts)
      for (const id of ids)
        if (dist(faces[id], i) > eps) {
          faces[id].outside.push(i);
          break;
        }
  };
  const done = new Set([i0, i1, i2, i3]);
  assign(
    uniq.filter((i) => !done.has(i)),
    [0, 1, 2, 3],
  );
  // quickhull: repeatedly add the point farthest outside a face; only the points of the removed
  // faces need a new face (a point outside the grown hull sees one of the faces just made)
  const pending = [0, 1, 2, 3];
  while (pending.length) {
    const fid = pending.pop()!;
    const f0 = faces[fid];
    if (!f0.alive || !f0.outside.length) continue;
    let i = f0.outside[0],
      best = -Infinity;
    for (const j of f0.outside) {
      const d = dist(f0, j);
      if (d > best) {
        best = d;
        i = j;
      }
    }
    const q = p(i);
    // visible faces: connected region around the face the point belongs to
    const visible: number[] = [fid];
    const seen = new Set<number>([fid]);
    for (let s = 0; s < visible.length; s++) {
      const f = faces[visible[s]];
      for (let k = 0; k < 3; k++) {
        const nb = edgeFace.get(f.v[(k + 1) % 3] * N + f.v[k]);
        if (nb === undefined || seen.has(nb)) continue;
        seen.add(nb);
        if (dot(faces[nb].n, q) - faces[nb].d > eps) visible.push(nb);
      }
    }
    // horizon: directed edges of visible faces whose reverse is not visible
    const horizon: [number, number][] = [];
    const orphans: number[] = [];
    for (const id of visible) {
      const f = faces[id];
      f.alive = false;
      for (const j of f.outside) if (j !== i) orphans.push(j);
      f.outside = [];
    }
    const isVisible = new Set(visible);
    for (const id of visible) {
      const f = faces[id];
      for (let k = 0; k < 3; k++) {
        const a = f.v[k],
          b = f.v[(k + 1) % 3];
        const nb = edgeFace.get(b * N + a);
        if (nb === undefined || !isVisible.has(nb)) horizon.push([a, b]);
      }
    }
    for (const id of visible) {
      const f = faces[id];
      for (let k = 0; k < 3; k++) {
        const key = f.v[k] * N + f.v[(k + 1) % 3];
        if (edgeFace.get(key) === id) edgeFace.delete(key);
      }
    }
    const made = horizon.map(([a, b]) => add(mk(a, b, i)));
    assign(orphans, made);
    for (const id of made) if (faces[id].outside.length) pending.push(id);
  }
  const tris = faces.filter((f) => f.alive);
  return mergeCoplanar(
    points,
    tris.map((f) => ({ v: f.v, n: f.n })),
    eps,
  );
}

function planarHull(points: Float32Array, ids: number[], normal: V3): MeshComponent {
  const l = Math.hypot(...normal) || 1;
  const n: V3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u: V3 = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  const ul = Math.hypot(...u);
  u[0] /= ul;
  u[1] /= ul;
  u[2] /= ul;
  const w: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const pts = ids.map((i) => ({
    i,
    x: points[i * 3] * u[0] + points[i * 3 + 1] * u[1] + points[i * 3 + 2] * u[2],
    y: points[i * 3] * w[0] + points[i * 3 + 1] * w[1] + points[i * 3 + 2] * w[2],
  }));
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const crossZ = (o: (typeof pts)[0], a: (typeof pts)[0], b: (typeof pts)[0]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof pts = [],
    upper: typeof pts = [];
  for (const q of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let k = pts.length - 1; k >= 0; k--) {
    const q = pts[k];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const b = new MeshBuild();
  for (const q of hull) b.vert(points[q.i * 3], points[q.i * 3 + 1], points[q.i * 3 + 2]);
  if (hull.length >= 3) b.face(hull.map((_, k) => k));
  return b.build({ flat: true });
}

/** Merge adjacent coplanar triangles into polygons and compact the vertex list. */
function mergeCoplanar(points: Float32Array, tris: { v: [number, number, number]; n: V3 }[], _eps: number): MeshComponent {
  // union-find over triangles sharing an edge with (nearly) the same plane
  const parent = tris.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const edgeOwner = new Map<string, number>();
  // single precision normals: triangles are merged only when their normals are identical, so
  // exactly coplanar faces (boxes) become polygons while curved hulls stay triangulated
  const f = Math.fround;
  const n32 = tris.map((t) => {
    const [a, b, c] = t.v;
    const ux = f(points[b * 3] - points[a * 3]),
      uy = f(points[b * 3 + 1] - points[a * 3 + 1]),
      uz = f(points[b * 3 + 2] - points[a * 3 + 2]);
    const vx = f(points[c * 3] - points[a * 3]),
      vy = f(points[c * 3 + 1] - points[a * 3 + 1]),
      vz = f(points[c * 3 + 2] - points[a * 3 + 2]);
    const nx = f(f(uy * vz) - f(uz * vy)),
      ny = f(f(uz * vx) - f(ux * vz)),
      nz = f(f(ux * vy) - f(uy * vx));
    const l = f(Math.sqrt(f(f(nx * nx) + f(f(ny * ny) + f(nz * nz))))) || 1;
    return [f(nx / l), f(ny / l), f(nz / l)];
  });
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t.v[k],
        b = t.v[(k + 1) % 3];
      const j = edgeOwner.get(`${b},${a}`);
      if (j !== undefined) {
        const p = n32[i],
          q = n32[j];
        if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) parent[find(i)] = find(j);
      }
      edgeOwner.set(`${a},${b}`, i);
    }
  });
  const groups = new Map<number, number[]>();
  tris.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  const b = new MeshBuild();
  const vmap = new Map<number, number>();
  const vid = (i: number) => {
    let v = vmap.get(i);
    if (v === undefined) {
      v = b.vert(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      vmap.set(i, v);
    }
    return v;
  };
  const polys: number[][] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      polys.push([...tris[g[0]].v]);
      continue;
    }
    // boundary edges of the group form one loop
    const count = new Map<string, number>();
    for (const t of g)
      for (let k = 0; k < 3; k++) {
        const a = tris[t].v[k],
          c = tris[t].v[(k + 1) % 3];
        count.set(`${a},${c}`, 1);
      }
    const next = new Map<number, number>();
    for (const key of count.keys()) {
      const [a, c] = key.split(',').map(Number);
      if (!count.has(`${c},${a}`)) next.set(a, c);
    }
    const start = next.keys().next().value as number;
    const loop: number[] = [];
    let cur = start;
    for (let guard = 0; guard <= next.size; guard++) {
      loop.push(cur);
      cur = next.get(cur)!;
      if (cur === start || cur === undefined) break;
    }
    if (loop.length >= 3 && loop.length === next.size) polys.push(loop);
    else for (const t of g) polys.push([...tris[t].v]);
  }
  // points in the middle of a straight hull edge: in the two faces on either side of the edge and
  // collinear with their neighbors in both; dropping them leaves the corners only
  const uses = new Map<number, number>();
  for (const p of polys) for (const v of p) uses.set(v, (uses.get(v) ?? 0) + 1);
  const straight = (a: number, p: number, c: number) => {
    const ux = points[a * 3] - points[p * 3],
      uy = points[a * 3 + 1] - points[p * 3 + 1],
      uz = points[a * 3 + 2] - points[p * 3 + 2];
    const wx = points[c * 3] - points[p * 3],
      wy = points[c * 3 + 1] - points[p * 3 + 1],
      wz = points[c * 3 + 2] - points[p * 3 + 2];
    const cr = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    return ux * wx + uy * wy + uz * wz < 0 && cr <= 1e-5 * Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz);
  };
  const keep = new Set<number>();
  for (const p of polys)
    p.forEach((v, k) => {
      if (uses.get(v) !== 2 || p.length <= 3 || !straight(p[(k + p.length - 1) % p.length], v, p[(k + 1) % p.length])) keep.add(v);
    });
  for (const p of polys) {
    const loop = p.filter((v) => keep.has(v));
    b.face((loop.length >= 3 ? loop : p).map(vid));
  }
  return b.build({ flat: true });
}

/** Axis-aligned box mesh between min and max (cube primitive ordering). */
export function boxMesh(min: number[], max: number[]): MeshComponent {
  const b = new MeshBuild();
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) b.vert(x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]);
  b.face([0, 2, 3, 1]);
  b.face([0, 1, 5, 4]);
  b.face([4, 5, 7, 6]);
  b.face([2, 6, 7, 3]);
  b.face([0, 4, 6, 2]);
  b.face([1, 3, 7, 5]);
  return b.build({ flat: true });
}
