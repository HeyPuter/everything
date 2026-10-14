// Polygon boolean operations through a planar arrangement.
//
// Every operand is a set of rings filled with the even-odd rule over its own
// rings (a ring inside another ring of the same operand is a hole; rings may
// overlap themselves). Coordinates are snapped to integers (EMU), all edges
// are split at their mutual intersections, and each resulting edge learns
// which operands cover the region on either side of it. A boolean predicate
// over that membership then selects the boundary edges of the result, which
// are linked back into rings and grouped into polygons with holes.
//
// Output rings have positive signed area (counter-clockwise in y-up terms,
// clockwise on screen) for outer boundaries and negative area for holes.
//
// Exactness: orientation tests use plain doubles, exact while coordinate
// spans stay below ~9e7 (slides are ~1.2e7 EMU wide).

/** Signed shoelace area of a ring of `{x, y}` points. */
export function area(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i],
      b = ring[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Total filled area of `[{ outer, holes }]` polygons. */
export function polygonsArea(polys) {
  let s = 0;
  for (const p of polys) {
    s += Math.abs(area(p.outer));
    for (const h of p.holes ?? []) s -= Math.abs(area(h));
  }
  return s;
}

const orient = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const same = (a, b) => a.x === b.x && a.y === b.y;
const ptKey = (p) => p.x + "," + p.y;

/** Accepts rings as point arrays or `{ points }`, and `{ outer, holes }`
 * polygons, so results can feed straight back in as operands. */
function operandRings(operand) {
  const rings = [];
  for (const item of operand ?? []) {
    if (item?.outer) rings.push(item.outer, ...(item.holes ?? []));
    else rings.push(Array.isArray(item) ? item : (item?.points ?? []));
  }
  return rings;
}

function collectEdges(operands) {
  const n = operands.length,
    edges = [];
  operands.forEach((operand, k) => {
    for (const ring of operandRings(operand)) {
      const pts = ring.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i],
          b = pts[(i + 1) % pts.length];
        if (same(a, b)) continue;
        const par = new Uint8Array(n);
        par[k] = 1;
        edges.push({ a, b, par });
      }
    }
  });
  return edges;
}

// Records where segments e and f cut each other (including T-junctions and
// collinear overlaps); split points land in `se` / `sf`.
function intersectPair(e, f, se, sf) {
  const { a, b } = e,
    { a: c, b: d } = f;
  const o1 = orient(a, b, c),
    o2 = orient(a, b, d);
  if ((o1 > 0 && o2 > 0) || (o1 < 0 && o2 < 0)) return;
  const o3 = orient(c, d, a),
    o4 = orient(c, d, b);
  if ((o3 > 0 && o4 > 0) || (o3 < 0 && o4 < 0)) return;
  const inside = (p, q, r) =>
    !same(r, p) &&
    !same(r, q) &&
    (r.x - p.x) * (r.x - q.x) + (r.y - p.y) * (r.y - q.y) < 0;
  if (o1 === 0 && o2 === 0) {
    for (const p of [c, d]) if (inside(a, b, p)) se.push(p);
    for (const p of [a, b]) if (inside(c, d, p)) sf.push(p);
    return;
  }
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) {
    if (o1 === 0 && inside(a, b, c)) se.push(c);
    if (o2 === 0 && inside(a, b, d)) se.push(d);
    if (o3 === 0 && inside(c, d, a)) sf.push(a);
    if (o4 === 0 && inside(c, d, b)) sf.push(b);
    return;
  }
  const t = o3 / (o3 - o4),
    p = {
      x: Math.round(a.x + (b.x - a.x) * t),
      y: Math.round(a.y + (b.y - a.y) * t),
    };
  se.push(p);
  sf.push(p);
}

// One pass of pairwise intersection over an x-sorted sweep; returns null
// when nothing needed splitting.
function splitPass(edges) {
  const n = edges.length,
    box = edges.map(({ a, b }) => [
      Math.min(a.x, b.x),
      Math.max(a.x, b.x),
      Math.min(a.y, b.y),
      Math.max(a.y, b.y),
    ]),
    order = edges.map((_, i) => i).sort((i, j) => box[i][0] - box[j][0]),
    splits = edges.map(() => []);
  for (let ii = 0; ii < n; ii++) {
    const i = order[ii],
      bi = box[i];
    for (let jj = ii + 1; jj < n; jj++) {
      const j = order[jj],
        bj = box[j];
      if (bj[0] > bi[1]) break;
      if (bj[3] < bi[2] || bj[2] > bi[3]) continue;
      intersectPair(edges[i], edges[j], splits[i], splits[j]);
    }
  }
  if (!splits.some((s) => s.length)) return null;
  const out = [];
  edges.forEach((e, i) => {
    if (!splits[i].length) return void out.push(e);
    const dx = e.b.x - e.a.x,
      dy = e.b.y - e.a.y,
      proj = (p) => (p.x - e.a.x) * dx + (p.y - e.a.y) * dy;
    const chain = [e.a, ...splits[i].sort((p, q) => proj(p) - proj(q)), e.b];
    for (let k = 0; k + 1 < chain.length; k++)
      if (!same(chain[k], chain[k + 1]))
        out.push({ a: chain[k], b: chain[k + 1], par: e.par });
  });
  return out;
}

// Merges coincident edges (parity per operand is XOR-ed) and drops edges
// that bound nothing.
function mergeEdges(edges) {
  const map = new Map();
  for (const e of edges) {
    const flip = e.a.x > e.b.x || (e.a.x === e.b.x && e.a.y > e.b.y),
      a = flip ? e.b : e.a,
      b = flip ? e.a : e.b,
      key = ptKey(a) + ";" + ptKey(b),
      hit = map.get(key);
    if (!hit) map.set(key, { a, b, par: Uint8Array.from(e.par) });
    else for (let k = 0; k < e.par.length; k++) hit.par[k] ^= e.par[k];
  }
  return [...map.values()].filter((e) => e.par.some(Boolean));
}

// Buckets edges into strips along one axis so ray casts touch few edges.
function stripIndex(edges, U) {
  let lo = Infinity,
    hi = -Infinity;
  for (const e of edges) {
    lo = Math.min(lo, e.a[U], e.b[U]);
    hi = Math.max(hi, e.a[U], e.b[U]);
  }
  const count = Math.max(1, Math.ceil(Math.sqrt(edges.length))),
    width = Math.max(1, (hi - lo) / count),
    strips = Array.from({ length: count }, () => []),
    at = (u) => Math.min(count - 1, Math.max(0, Math.floor((u - lo) / width)));
  edges.forEach((e, i) => {
    const s0 = at(Math.min(e.a[U], e.b[U])),
      s1 = at(Math.max(e.a[U], e.b[U]));
    for (let s = s0; s <= s1; s++) strips[s].push(i);
  });
  return (u) => strips[at(u)];
}

// For each edge, operand membership of the regions on its low side (smaller
// y, or smaller x for vertical edges) and high side. A ray from the edge
// midpoint toward the low side counts crossings per operand; the half-open
// rule makes vertices and edges parallel to the ray count consistently.
function classify(edges) {
  const index = { x: stripIndex(edges, "x"), y: stripIndex(edges, "y") };
  edges.forEach((e, ei) => {
    const vertical = e.a.x === e.b.x,
      U = vertical ? "y" : "x",
      V = vertical ? "x" : "y",
      mu = (e.a[U] + e.b[U]) / 2,
      mv = (e.a[V] + e.b[V]) / 2,
      low = new Uint8Array(e.par.length);
    for (const fi of index[U](mu)) {
      if (fi === ei) continue;
      const f = edges[fi],
        [f0, f1] = f.a[U] <= f.b[U] ? [f.a, f.b] : [f.b, f.a];
      if (!(f0[U] <= mu && mu < f1[U])) continue;
      if ((f0[V] - mv) * (f1[U] - f0[U]) + (f1[V] - f0[V]) * (mu - f0[U]) < 0)
        for (let k = 0; k < low.length; k++) low[k] ^= f.par[k];
    }
    e.vertical = vertical;
    e.low = low;
    e.high = low.map((m, k) => m ^ e.par[k]);
  });
  return edges;
}

/** Builds the classified planar arrangement of the operands. */
function arrange(operands) {
  let edges = collectEdges(operands);
  for (let pass = 0; pass < 8; pass++) {
    const next = splitPass(edges);
    if (!next) break;
    edges = next;
  }
  return classify(mergeEdges(edges));
}

// Removes collinear vertices; returns null for degenerate rings.
function cleanRing(ring) {
  let pts = ring;
  for (let changed = true; changed && pts.length >= 3;) {
    changed = false;
    const kept = pts.filter((p, i) => {
      const prev = pts[(i + pts.length - 1) % pts.length],
        next = pts[(i + 1) % pts.length];
      return orient(prev, p, next) !== 0;
    });
    changed = kept.length !== pts.length;
    pts = kept;
  }
  return pts.length >= 3 && Math.abs(area(pts)) >= 1 ? pts : null;
}

// Links boundary edges into rings. At every vertex the walk takes the
// sharpest left turn, so rings touching at a vertex come out separate.
function linkRings(directed) {
  const out = new Map();
  directed.forEach((e, i) => {
    const k = ptKey(e.from);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(i);
  });
  const next = directed.map((e) => {
    const dx = e.to.x - e.from.x,
      dy = e.to.y - e.from.y;
    let best = -1,
      bestTurn = -Infinity;
    for (const j of out.get(ptKey(e.to)) ?? []) {
      const f = directed[j],
        ex = f.to.x - f.from.x,
        ey = f.to.y - f.from.y,
        turn = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
      if (turn > bestTurn) ((bestTurn = turn), (best = j));
    }
    return best;
  });
  const used = new Uint8Array(directed.length),
    rings = [];
  for (let s = 0; s < directed.length; s++) {
    if (used[s]) continue;
    const ring = [];
    for (let i = s; i >= 0 && !used[i]; i = next[i]) {
      used[i] = 1;
      ring.push(directed[i].from);
    }
    const clean = cleanRing(ring);
    // The first raw edge's midpoint lies on no other result ring.
    if (clean)
      rings.push({
        ring: clean,
        probe: {
          x: (ring[0].x + ring[1].x) / 2,
          y: (ring[0].y + ring[1].y) / 2,
        },
      });
  }
  return rings;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

// Assigns each hole to the smallest outer ring containing its probe point.
function groupRings(rings) {
  const outers = rings
    .filter((r) => area(r.ring) > 0)
    .map(({ ring }) => ({ outer: ring, holes: [], size: area(ring) }))
    .sort((p, q) => p.size - q.size);
  for (const { ring, probe } of rings.filter((r) => area(r.ring) < 0))
    outers.find((p) => pointInRing(probe, p.outer))?.holes.push(ring);
  return outers.map(({ outer, holes }) => ({ outer, holes }));
}

function extract(edges, predicate) {
  const cache = new Map(),
    test = (m) => {
      const key = m.join("");
      if (!cache.has(key)) cache.set(key, !!predicate([...m].map(Boolean)));
      return cache.get(key);
    };
  const directed = [];
  for (const e of edges) {
    const inLow = test(e.low);
    if (inLow === test(e.high)) continue;
    // Edges run low-to-high along x (y when vertical) after merging. Orient
    // them with the inside on the left (y-up sense): outer rings positive.
    const forward = e.vertical ? inLow : !inLow;
    directed.push(forward ? { from: e.a, to: e.b } : { from: e.b, to: e.a });
  }
  return groupRings(linkRings(directed));
}

/** Polygons of the region where `predicate(membership)` holds; membership
 * is one boolean per operand. Returns `[{ outer, holes }]`. */
export function booleanOp(operands, predicate) {
  return extract(arrange(operands), predicate);
}

/** Inside any operand. */
export const union = (operands) => booleanOp(operands, (m) => m.some(Boolean));
/** Inside every operand. */
export const intersect = (operands) =>
  booleanOp(operands, (m) => m.length > 0 && m.every(Boolean));
/** Inside the first operand and none of the rest. */
export const subtract = (operands) =>
  booleanOp(operands, (m) => m[0] && !m.slice(1).some(Boolean));
/** Inside an odd number of operands ("Combine"). */
export const xor = (operands) =>
  booleanOp(operands, (m) => m.filter(Boolean).length % 2 === 1);
export const combine = xor;

/** Every distinct face set: one piece per polygon of each non-empty
 * membership region. Returns `[{ membership: boolean[], polygon }]`. */
export function fragment(operands) {
  const edges = arrange(operands),
    keys = new Set();
  for (const e of edges)
    for (const m of [e.low, e.high]) if (m.some(Boolean)) keys.add(m.join(""));
  const pieces = [];
  for (const key of [...keys].sort().reverse()) {
    const membership = [...key].map((c) => c === "1");
    for (const polygon of extract(edges, (m) =>
      m.every((v, k) => v === membership[k]),
    ))
      pieces.push({ membership, polygon });
  }
  return pieces;
}
