// Small incremental 3D convex hull (for a few dozen points, e.g. the branch hubs of the Skin
// modifier). Returns outward-facing triangles as point index triples.

export function convexHull(P: ArrayLike<number>, eps = 1e-9): number[] {
  const n = P.length / 3;
  if (n < 4) return [];
  const x = (i: number) => P[i * 3],
    y = (i: number) => P[i * 3 + 1],
    z = (i: number) => P[i * 3 + 2];
  const sub = (a: number, b: number): [number, number, number] => [x(a) - x(b), y(a) - y(b), z(a) - z(b)];
  const cross = (u: number[], v: number[]): [number, number, number] => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  // scale-aware tolerance
  let ext = 0;
  for (let i = 1; i < n; i++) ext = Math.max(ext, Math.abs(x(i) - x(0)), Math.abs(y(i) - y(0)), Math.abs(z(i) - z(0)));
  const tol = Math.max(eps, ext * 1e-7);
  // initial tetrahedron: two far points, a point far from their line, a point far from the plane
  let a = 0,
    b = -1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = dot(sub(i, a), sub(i, a));
    if (d > best) {
      best = d;
      b = i;
    }
  }
  if (best <= tol * tol) return [];
  let c = -1;
  best = -1;
  const ab = sub(b, a);
  for (let i = 0; i < n; i++) {
    const cr = cross(ab, sub(i, a));
    const d = dot(cr, cr);
    if (d > best) {
      best = d;
      c = i;
    }
  }
  if (best <= tol * tol * dot(ab, ab)) return [];
  let d = -1;
  best = -1;
  const nrm = cross(ab, sub(c, a));
  const nl = Math.sqrt(dot(nrm, nrm));
  for (let i = 0; i < n; i++) {
    const h = Math.abs(dot(nrm, sub(i, a))) / nl;
    if (h > best) {
      best = h;
      d = i;
    }
  }
  if (best <= tol) return [];
  type Face = { v: [number, number, number]; n: [number, number, number]; off: number; alive: boolean };
  const faces: Face[] = [];
  const make = (p: number, q: number, r: number): Face => {
    const fn = cross(sub(q, p), sub(r, p));
    const l = Math.sqrt(dot(fn, fn)) || 1;
    const nn: [number, number, number] = [fn[0] / l, fn[1] / l, fn[2] / l];
    return { v: [p, q, r], n: nn, off: dot(nn, [x(p), y(p), z(p)]), alive: true };
  };
  const centroid = [(x(a) + x(b) + x(c) + x(d)) / 4, (y(a) + y(b) + y(c) + y(d)) / 4, (z(a) + z(b) + z(c) + z(d)) / 4];
  const addOriented = (p: number, q: number, r: number) => {
    let f = make(p, q, r);
    if (dot(f.n, centroid) - f.off > 0) f = make(p, r, q);
    faces.push(f);
  };
  addOriented(a, b, c);
  addOriented(a, b, d);
  addOriented(a, c, d);
  addOriented(b, c, d);
  const used = new Set([a, b, c, d]);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const p = [x(i), y(i), z(i)];
    const visible = faces.filter((f) => f.alive && dot(f.n, p) - f.off > tol);
    if (!visible.length) continue;
    // horizon: edges of visible faces not shared with another visible face
    const edges = new Map<string, [number, number]>();
    for (const f of visible) {
      f.alive = false;
      for (let k = 0; k < 3; k++) {
        const u = f.v[k],
          w = f.v[(k + 1) % 3];
        const rev = `${w}:${u}`;
        if (edges.has(rev)) edges.delete(rev);
        else edges.set(`${u}:${w}`, [u, w]);
      }
    }
    for (const [u, w] of edges.values()) faces.push(make(u, w, i));
  }
  // points lying on the hull surface but not hull vertices (coplanar or collinear with a face):
  // insert them by splitting the faces they lie on, so every boundary point becomes a vertex
  let tris = faces.filter((f) => f.alive).map((f) => f.v.slice() as [number, number, number]);
  const isVert = new Set(tris.flat());
  for (let i = 0; i < n; i++) {
    if (isVert.has(i)) continue;
    const p = [x(i), y(i), z(i)];
    for (let t = 0; t < tris.length; t++) {
      const [u, v, w] = tris[t];
      const f = make(u, v, w);
      if (Math.abs(dot(f.n, p) - f.off) > tol * 10) continue;
      // barycentric coordinates in the face
      const e0 = sub(v, u),
        e1 = sub(w, u),
        ep = [p[0] - x(u), p[1] - y(u), p[2] - z(u)];
      const d00 = dot(e0, e0),
        d01 = dot(e0, e1),
        d11 = dot(e1, e1),
        d20 = dot(ep, e0),
        d21 = dot(ep, e1);
      const den = d00 * d11 - d01 * d01;
      if (Math.abs(den) < 1e-30) continue;
      const bv = (d11 * d20 - d01 * d21) / den,
        bw = (d00 * d21 - d01 * d20) / den,
        bu = 1 - bv - bw;
      const e = 1e-7;
      if (bu < -e || bv < -e || bw < -e) continue;
      const split = (a0: number, a1: number, opp: number) => {
        // point on edge a0-a1: split this face and the neighbour across that edge
        tris.splice(t, 1, [a0, i, opp], [i, a1, opp]);
        const nb = tris.findIndex((q) => (q[0] === a1 && q[1] === a0) || (q[1] === a1 && q[2] === a0) || (q[2] === a1 && q[0] === a0));
        if (nb >= 0) {
          const q = tris[nb];
          const k = q.indexOf(a1);
          const o = q[(k + 2) % 3];
          tris.splice(nb, 1, [a1, i, o], [i, a0, o]);
        }
      };
      if (bu <= e) split(v, w, u);
      else if (bv <= e) split(w, u, v);
      else if (bw <= e) split(u, v, w);
      else tris.splice(t, 1, [u, v, i], [v, w, i], [w, u, i]);
      isVert.add(i);
      break;
    }
  }
  tris = tris.filter(([u, v, w]) => u !== v && v !== w && u !== w);
  return tris.flat();
}
