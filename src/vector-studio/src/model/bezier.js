/**
 * Cubic Bezier helpers for path geometry.
 *
 * A path is a list of anchors, each { x, y, ix, iy, ox, oy } in absolute
 * document coordinates: (ix, iy) is the handle pointing into the anchor from
 * the previous segment, (ox, oy) the handle leaving it toward the next one.
 * A handle equal to its anchor is retracted. A segment between anchors p and
 * q is the cubic (p.x,p.y) (p.ox,p.oy) (q.ix,q.iy) (q.x,q.y).
 */

const EPS = 1e-9;

export function anchor(x, y, ix = x, iy = y, ox = x, oy = y) {
  return { x, y, ix, iy, ox, oy };
}

export function hasIn(a) {
  return Math.abs(a.ix - a.x) > EPS || Math.abs(a.iy - a.y) > EPS;
}

export function hasOut(a) {
  return Math.abs(a.ox - a.x) > EPS || Math.abs(a.oy - a.y) > EPS;
}

/** The four control points of segment i (from anchor i to i+1, wrapping when closed). */
export function segmentPoints(anchors, i) {
  const p = anchors[i];
  const q = anchors[(i + 1) % anchors.length];
  return [p.x, p.y, p.ox, p.oy, q.ix, q.iy, q.x, q.y];
}

export function segmentCount(anchors, closed) {
  if (anchors.length < 2) return 0;
  return closed ? anchors.length : anchors.length - 1;
}

/**
 * Whether a subpath has no length (every anchor and handle on its first point). Stroked with round
 * or square caps it shows as a dot or a square, as in SVG; canvas and PDF viewers skip such a
 * subpath, so renderers trace it as a tiny segment along the x axis, the direction SVG gives the caps.
 */
export function zeroLength(anchors) {
  const { x, y } = anchors[0];
  for (const a of anchors) {
    if (a.x !== x || a.y !== y || a.ix !== x || a.iy !== y || a.ox !== x || a.oy !== y) return false;
  }
  return true;
}

/** Whether a node's stroke caps show on a zero-length subpath. */
export function capsShowDots(node) {
  return node.strokeCap === 'round' || node.strokeCap === 'square';
}

export function isLine(c) {
  return (
    Math.abs(c[2] - c[0]) < EPS && Math.abs(c[3] - c[1]) < EPS && Math.abs(c[4] - c[6]) < EPS && Math.abs(c[5] - c[7]) < EPS
  );
}

export function pointAt(c, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return { x: a * c[0] + b * c[2] + d * c[4] + e * c[6], y: a * c[1] + b * c[3] + d * c[5] + e * c[7] };
}

export function derivativeAt(c, t) {
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const d = 3 * t * t;
  return {
    x: a * (c[2] - c[0]) + b * (c[4] - c[2]) + d * (c[6] - c[4]),
    y: a * (c[3] - c[1]) + b * (c[5] - c[3]) + d * (c[7] - c[5]),
  };
}

/** De Casteljau split at t. Returns [left, right] control point arrays. */
export function split(c, t) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
  const x01 = x0 + (x1 - x0) * t;
  const y01 = y0 + (y1 - y0) * t;
  const x12 = x1 + (x2 - x1) * t;
  const y12 = y1 + (y2 - y1) * t;
  const x23 = x2 + (x3 - x2) * t;
  const y23 = y2 + (y3 - y2) * t;
  const xa = x01 + (x12 - x01) * t;
  const ya = y01 + (y12 - y01) * t;
  const xb = x12 + (x23 - x12) * t;
  const yb = y12 + (y23 - y12) * t;
  const xm = xa + (xb - xa) * t;
  const ym = ya + (yb - ya) * t;
  return [
    [x0, y0, x01, y01, xa, ya, xm, ym],
    [xm, ym, xb, yb, x23, y23, x3, y3],
  ];
}

/** Roots in [0, 1] of the derivative of one coordinate (for extrema). */
function extremaT(p0, p1, p2, p3, out) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS) {
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
    }
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const s = Math.sqrt(disc);
  const t1 = (-b + s) / (2 * a);
  const t2 = (-b - s) / (2 * a);
  if (t1 > 0 && t1 < 1) out.push(t1);
  if (t2 > 0 && t2 < 1) out.push(t2);
}

/** Tight bounding box of one cubic: { x, y, w, h }. */
export function cubicBounds(c) {
  let minX = Math.min(c[0], c[6]);
  let maxX = Math.max(c[0], c[6]);
  let minY = Math.min(c[1], c[7]);
  let maxY = Math.max(c[1], c[7]);
  if (!isLine(c)) {
    const ts = [];
    extremaT(c[0], c[2], c[4], c[6], ts);
    extremaT(c[1], c[3], c[5], c[7], ts);
    for (const t of ts) {
      const p = pointAt(c, t);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Tight bounds of an anchor list, or null when empty. */
export function pathBounds(anchors, closed) {
  if (!anchors.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (anchors.length === 1) {
    const a = anchors[0];
    return { x: a.x, y: a.y, w: 0, h: 0 };
  }
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) {
    const b = cubicBounds(segmentPoints(anchors, i));
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Approximate arc length of a cubic by adaptive flattening. */
export function cubicLength(c, tolerance = 0.05) {
  let len = 0;
  flattenCubic(c, tolerance, (x0, y0, x1, y1) => {
    len += Math.hypot(x1 - x0, y1 - y0);
  });
  return len;
}

/**
 * Flatten a cubic into line segments within `tolerance` (in the same units
 * as the coordinates), calling emit(x0, y0, x1, y1) for each piece. Uses the
 * Wang formula for the subdivision count so the cost is predictable.
 */
export function flattenCubic(c, tolerance, emit) {
  if (isLine(c)) {
    emit(c[0], c[1], c[6], c[7]);
    return;
  }
  const ddx = Math.max(Math.abs(c[0] - 2 * c[2] + c[4]), Math.abs(c[2] - 2 * c[4] + c[6]));
  const ddy = Math.max(Math.abs(c[1] - 2 * c[3] + c[5]), Math.abs(c[3] - 2 * c[5] + c[7]));
  const dd = Math.hypot(ddx, ddy);
  const n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt((3 * dd) / (4 * Math.max(tolerance, 1e-4))))));
  let px = c[0];
  let py = c[1];
  for (let i = 1; i <= n; i++) {
    const p = pointAt(c, i / n);
    emit(px, py, p.x, p.y);
    px = p.x;
    py = p.y;
  }
}

/** Flatten a whole anchor list to a polyline [{x, y}, ...]. */
export function flattenPath(anchors, closed, tolerance = 0.25) {
  const pts = [];
  if (!anchors.length) return pts;
  pts.push({ x: anchors[0].x, y: anchors[0].y });
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) {
    flattenCubic(segmentPoints(anchors, i), tolerance, (x0, y0, x1, y1) => pts.push({ x: x1, y: y1 }));
  }
  return pts;
}

/**
 * Nearest point on a cubic to (px, py): { t, x, y, d }. Coarse sampling
 * followed by a few Newton refinement steps.
 */
export function nearestOnCubic(c, px, py) {
  let best = 0;
  let bestD = Infinity;
  const N = isLine(c) ? 8 : 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = pointAt(c, t);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  let t = best;
  for (let k = 0; k < 6; k++) {
    const p = pointAt(c, t);
    const d1 = derivativeAt(c, t);
    // Second derivative.
    const mt = 1 - t;
    const d2x = 6 * mt * (c[4] - 2 * c[2] + c[0]) + 6 * t * (c[6] - 2 * c[4] + c[2]);
    const d2y = 6 * mt * (c[5] - 2 * c[3] + c[1]) + 6 * t * (c[7] - 2 * c[5] + c[3]);
    const fx = p.x - px;
    const fy = p.y - py;
    const num = fx * d1.x + fy * d1.y;
    const den = d1.x * d1.x + d1.y * d1.y + fx * d2x + fy * d2y;
    if (Math.abs(den) < EPS) break;
    const nt = Math.min(1, Math.max(0, t - num / den));
    if (Math.abs(nt - t) < 1e-7) {
      t = nt;
      break;
    }
    t = nt;
  }
  const p = pointAt(c, t);
  return { t, x: p.x, y: p.y, d: Math.hypot(p.x - px, p.y - py) };
}

/** Nearest segment of a path: { index, t, x, y, d } or null. */
export function nearestOnPath(anchors, closed, px, py) {
  let best = null;
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) {
    const r = nearestOnCubic(segmentPoints(anchors, i), px, py);
    if (!best || r.d < best.d) best = { index: i, ...r };
  }
  return best;
}

/**
 * Insert an anchor into segment `index` at parameter t, keeping the curve
 * shape exactly. Returns a new anchor list.
 */
export function insertAnchor(anchors, closed, index, t) {
  const c = segmentPoints(anchors, index);
  const [l, r] = split(c, t);
  const out = anchors.map((a) => ({ ...a }));
  const i0 = index;
  const i1 = (index + 1) % anchors.length;
  out[i0].ox = l[2];
  out[i0].oy = l[3];
  out[i1].ix = r[4];
  out[i1].iy = r[5];
  const mid = { x: l[6], y: l[7], ix: l[4], iy: l[5], ox: r[2], oy: r[3] };
  if (isLine(c)) {
    mid.ix = mid.ox = mid.x;
    mid.iy = mid.oy = mid.y;
  }
  out.splice(index + 1, 0, mid);
  return out;
}

/** Apply an affine matrix to an anchor list (returns new anchors). */
export function transformAnchors(anchors, m) {
  const [a, b, c, d, e, f] = m;
  return anchors.map((p) => ({
    ...p,
    x: a * p.x + c * p.y + e,
    y: b * p.x + d * p.y + f,
    ix: a * p.ix + c * p.iy + e,
    iy: b * p.ix + d * p.iy + f,
    ox: a * p.ox + c * p.oy + e,
    oy: b * p.ox + d * p.oy + f,
  }));
}

/** Reverse path direction. */
export function reverseAnchors(anchors) {
  return anchors
    .slice()
    .reverse()
    .map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
}

/** Signed area of the flattened path (positive = clockwise on a y-down screen). */
export function signedArea(anchors, closed = true) {
  const pts = flattenPath(anchors, closed, 0.5);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

/** Total path length. */
export function pathLength(anchors, closed) {
  let len = 0;
  const n = segmentCount(anchors, closed);
  for (let i = 0; i < n; i++) len += cubicLength(segmentPoints(anchors, i));
  return len;
}

/**
 * Smooth-point handles for the anchor at index i, from the Catmull-Rom style
 * direction between its neighbors (used by the Curvature tool and "Convert
 * to smooth"). Handle length is a third of the distance to each neighbor.
 */
export function autoSmooth(anchors, i, closed) {
  const n = anchors.length;
  const p = anchors[i];
  const prev = anchors[i - 1] ?? (closed ? anchors[n - 1] : null);
  const next = anchors[i + 1] ?? (closed ? anchors[0] : null);
  if (!prev && !next) return { ...p };
  const a = prev ?? p;
  const b = next ?? p;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const dPrev = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
  const dNext = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
  return { ...p, ix: p.x - dx * dPrev, iy: p.y - dy * dPrev, ox: p.x + dx * dNext, oy: p.y + dy * dNext };
}

/**
 * Fit cubic Beziers to a polyline (Philip J. Schneider, "An Algorithm for
 * Automatically Fitting Digitized Curves", Graphics Gems 1990). Used by the
 * Pencil and Paintbrush tools. `error` is the maximum squared-distance
 * tolerance in document units. Returns an anchor list.
 */
export function fitCurve(points, error = 4) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 2) return pts.map((p) => anchor(p.x, p.y));
  const beziers = [];
  const tHat1 = unit(sub(pts[1], pts[0]));
  const tHat2 = unit(sub(pts[pts.length - 2], pts[pts.length - 1]));
  fitCubic(pts, 0, pts.length - 1, tHat1, tHat2, error, beziers);
  const out = [anchor(beziers[0][0].x, beziers[0][0].y)];
  for (const bz of beziers) {
    const last = out[out.length - 1];
    last.ox = bz[1].x;
    last.oy = bz[1].y;
    out.push({ x: bz[3].x, y: bz[3].y, ix: bz[2].x, iy: bz[2].y, ox: bz[3].x, oy: bz[3].y });
  }
  return out;
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function mul(a, s) {
  return { x: a.x * s, y: a.y * s };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}
function unit(a) {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
}

function fitCubic(d, first, last, tHat1, tHat2, error, out) {
  const nPts = last - first + 1;
  if (nPts === 2) {
    const dist = Math.hypot(d[last].x - d[first].x, d[last].y - d[first].y) / 3;
    out.push([d[first], add(d[first], mul(tHat1, dist)), add(d[last], mul(tHat2, dist)), d[last]]);
    return;
  }
  let u = chordLengthParameterize(d, first, last);
  let bez = generateBezier(d, first, last, u, tHat1, tHat2);
  let [maxError, splitPoint] = computeMaxError(d, first, last, bez, u);
  if (maxError < error) {
    out.push(bez);
    return;
  }
  if (maxError < error * 4) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(d, first, last, u, bez);
      bez = generateBezier(d, first, last, uPrime, tHat1, tHat2);
      [maxError, splitPoint] = computeMaxError(d, first, last, bez, uPrime);
      if (maxError < error) {
        out.push(bez);
        return;
      }
      u = uPrime;
    }
  }
  const tHatCenter = unit(sub(d[splitPoint - 1], d[splitPoint + 1]));
  fitCubic(d, first, splitPoint, tHat1, tHatCenter, error, out);
  fitCubic(d, splitPoint, last, mul(tHatCenter, -1), tHat2, error, out);
}

function generateBezier(d, first, last, uPrime, tHat1, tHat2) {
  const nPts = last - first + 1;
  const C = [
    [0, 0],
    [0, 0],
  ];
  const X = [0, 0];
  for (let i = 0; i < nPts; i++) {
    const u = uPrime[i];
    const mt = 1 - u;
    const a1 = mul(tHat1, 3 * u * mt * mt);
    const a2 = mul(tHat2, 3 * u * u * mt);
    C[0][0] += dot(a1, a1);
    C[0][1] += dot(a1, a2);
    C[1][0] = C[0][1];
    C[1][1] += dot(a2, a2);
    const b0 = mt * mt * mt + 3 * u * mt * mt;
    const b3 = 3 * u * u * mt + u * u * u;
    const tmp = sub(d[first + i], add(mul(d[first], b0), mul(d[last], b3)));
    X[0] += dot(a1, tmp);
    X[1] += dot(a2, tmp);
  }
  const detC0C1 = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  const detC0X = C[0][0] * X[1] - C[1][0] * X[0];
  const detXC1 = X[0] * C[1][1] - X[1] * C[0][1];
  const alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1;
  const alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1;
  const segLength = Math.hypot(d[last].x - d[first].x, d[last].y - d[first].y);
  const epsilon = 1e-6 * segLength;
  // Degenerate or wild solutions (handles crossing over each other along the
  // chord, or far longer than it) fall back to the Wu/Barsky heuristic; noisy
  // input would otherwise produce spikes.
  const line = sub(d[last], d[first]);
  const crossed = dot(mul(tHat1, alphaL), line) - dot(mul(tHat2, alphaR), line) > segLength * segLength;
  if (alphaL < epsilon || alphaR < epsilon || crossed || alphaL > segLength * 2 || alphaR > segLength * 2) {
    const dist = segLength / 3;
    return [d[first], add(d[first], mul(tHat1, dist)), add(d[last], mul(tHat2, dist)), d[last]];
  }
  return [d[first], add(d[first], mul(tHat1, alphaL)), add(d[last], mul(tHat2, alphaR)), d[last]];
}

function bezPoint(bez, t) {
  const c = [bez[0].x, bez[0].y, bez[1].x, bez[1].y, bez[2].x, bez[2].y, bez[3].x, bez[3].y];
  return pointAt(c, t);
}

function reparameterize(d, first, last, u, bez) {
  const out = [];
  const c = [bez[0].x, bez[0].y, bez[1].x, bez[1].y, bez[2].x, bez[2].y, bez[3].x, bez[3].y];
  for (let i = first; i <= last; i++) {
    const t = u[i - first];
    const p = pointAt(c, t);
    const d1 = derivativeAt(c, t);
    const mt = 1 - t;
    const d2x = 6 * mt * (c[4] - 2 * c[2] + c[0]) + 6 * t * (c[6] - 2 * c[4] + c[2]);
    const d2y = 6 * mt * (c[5] - 2 * c[3] + c[1]) + 6 * t * (c[7] - 2 * c[5] + c[3]);
    const num = (p.x - d[i].x) * d1.x + (p.y - d[i].y) * d1.y;
    const den = d1.x * d1.x + d1.y * d1.y + (p.x - d[i].x) * d2x + (p.y - d[i].y) * d2y;
    out.push(den === 0 ? t : t - num / den);
  }
  return out;
}

function chordLengthParameterize(d, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + Math.hypot(d[i].x - d[i - 1].x, d[i].y - d[i - 1].y));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function computeMaxError(d, first, last, bez, u) {
  let maxDist = 0;
  let splitPoint = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const p = bezPoint(bez, u[i - first]);
    const dist = (p.x - d[i].x) ** 2 + (p.y - d[i].y) ** 2;
    if (dist >= maxDist) {
      maxDist = dist;
      splitPoint = i;
    }
  }
  return [maxDist, splitPoint];
}

/**
 * Simplify a polyline with the Ramer-Douglas-Peucker algorithm before fitting.
 */
export function simplifyPolyline(points, tolerance) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = points[s];
    const b = points[e];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = points[i];
      let d2;
      if (len2 === 0) d2 = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        d2 = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
