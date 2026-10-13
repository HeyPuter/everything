/**
 * Polygon triangulation for exporting 3D faces: ear clipping after joining
 * holes to the outer ring with bridge edges.
 *
 *   triangulate(outer, holes) -> [[i, j, k], ...]
 *
 * `outer` and each hole are lists of [x, y]; indices count the outer
 * ring's points first, then each hole's in order. Triangles are wound like
 * the outer ring.
 */

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function area(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return s / 2;
}

function inTriangle(p, a, b, c) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

/** Join a hole (indices, clockwise) into the ring (indices, counterclockwise) through a visible vertex. */
function bridge(ring, hole, P) {
  // The hole's rightmost vertex.
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (P[hole[i]][0] > P[hole[hi]][0]) hi = i;
  const M = P[hole[hi]];
  // The nearest ring edge hit by a ray from M toward +x.
  let best = -1;
  let bestX = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = P[ring[i]];
    const b = P[ring[(i + 1) % ring.length]];
    if ((a[1] > M[1]) === (b[1] > M[1]) && !(a[1] === M[1] && b[1] === M[1])) continue;
    if (a[1] === b[1]) continue;
    const x = a[0] + ((M[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (x >= M[0] - 1e-12 && x < bestX) {
      bestX = x;
      best = a[0] > b[0] ? i : (i + 1) % ring.length;
    }
  }
  if (best < 0) {
    // No hit (degenerate input): connect to the nearest ring vertex.
    let d = Infinity;
    ring.forEach((v, i) => {
      const q = P[v];
      const dd = (q[0] - M[0]) ** 2 + (q[1] - M[1]) ** 2;
      if (dd < d) {
        d = dd;
        best = i;
      }
    });
  } else {
    // A reflex vertex inside the triangle (M, hit, candidate) blocks the view: take the one closest in angle.
    const I = [bestX, M[1]];
    const Pc = P[ring[best]];
    let angle = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const q = P[ring[i]];
      if (i === best || q[0] < M[0]) continue;
      const prev = P[ring[(i - 1 + ring.length) % ring.length]];
      const next = P[ring[(i + 1) % ring.length]];
      if (cross(prev, q, next) >= 0) continue;
      const inside = inTriangle(q, M, I, Pc) || inTriangle(q, M, Pc, I);
      if (!inside) continue;
      const a = Math.abs(Math.atan2(q[1] - M[1], q[0] - M[0]));
      if (a < angle) {
        angle = a;
        best = i;
      }
    }
  }
  const rotated = [...hole.slice(hi), ...hole.slice(0, hi + 1)];
  return [...ring.slice(0, best + 1), ...rotated, ...ring.slice(best)];
}

export function triangulate(outer, holes = []) {
  const P = [...outer, ...holes.flat()];
  if (outer.length < 3) return [];
  const flip = area(outer) < 0;
  let ring = outer.map((_, i) => i);
  // Work counterclockwise (in the math sense); triangles are reversed back at the end.
  if (flip) ring.reverse();
  let off = outer.length;
  const holeRings = holes
    .map((h) => {
      const idx = h.map((_, i) => off + i);
      off += h.length;
      return idx;
    })
    .filter((h) => h.length >= 3)
    .map((h) => (area(h.map((i) => P[i])) > 0 ? h.slice().reverse() : h))
    .sort((a, b) => Math.max(...b.map((i) => P[i][0])) - Math.max(...a.map((i) => P[i][0])));
  for (const h of holeRings) ring = bridge(ring, h, P);
  const tris = [];
  const V = ring.slice();
  let guard = V.length * V.length + 10;
  while (V.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const ia = V[(i - 1 + V.length) % V.length];
      const ib = V[i];
      const ic = V[(i + 1) % V.length];
      const a = P[ia];
      const b = P[ib];
      const c = P[ic];
      if (cross(a, b, c) <= 1e-14) continue;
      let ear = true;
      for (const j of V) {
        if (j === ia || j === ib || j === ic) continue;
        const q = P[j];
        // Bridge duplicates share coordinates with ear corners: they do not block.
        if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1]) || (q[0] === c[0] && q[1] === c[1])) continue;
        if (inTriangle(q, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push([ia, ib, ic]);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate leftovers (collinear or self-touching): cut the flattest corner.
      let k = 0;
      let bestC = -Infinity;
      for (let i = 0; i < V.length; i++) {
        const c = cross(P[V[(i - 1 + V.length) % V.length]], P[V[i]], P[V[(i + 1) % V.length]]);
        if (c > bestC) {
          bestC = c;
          k = i;
        }
      }
      if (bestC > 1e-14) tris.push([V[(k - 1 + V.length) % V.length], V[k], V[(k + 1) % V.length]]);
      V.splice(k, 1);
    }
  }
  if (V.length === 3 && cross(P[V[0]], P[V[1]], P[V[2]]) > 1e-14) tris.push([V[0], V[1], V[2]]);
  return flip ? tris.map(([a, b, c]) => [a, c, b]) : tris;
}
