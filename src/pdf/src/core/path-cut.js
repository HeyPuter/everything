/**
 * Cutting areas out of a painted path, for redaction: what lies under a mark leaves the file,
 * and the rest is painted as before. Curves are flattened to short segments (within a twentieth
 * of a point on the page), fills are clipped to the parts of the page outside the areas, and
 * strokes are cut where they come within half a line width of an area.
 */

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** How far a flattened curve may stray from the true one, in page points. */
const TOLERANCE = 0.05;

function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!m.every(Number.isFinite) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** The largest stretch a matrix gives any direction. */
const stretch = (m) =>
  (Math.hypot(m[0] + m[3], m[1] - m[2]) + Math.hypot(m[0] - m[3], m[1] + m[2])) / 2;

/** A cubic as line segments, the points after its start (Wang's bound on the segment count). */
function flatten(p0, p1, p2, p3, tolerance) {
  const d = Math.max(
    Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]),
  );
  const n = Math.min(1000, Math.max(1, Math.ceil(Math.sqrt((0.75 * d) / tolerance))));
  const points = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n,
      u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

/**
 * The subpaths of path commands ({ op, a } in user space) as polylines in page space:
 * `{ points, closed }`. `closeLast` closes the last one, as s, b and b* do.
 */
function polylines(commands, ctm, closeLast) {
  const tolerance = TOLERANCE / (stretch(ctm) || 1);
  const subpaths = [];
  let current = null,
    at = [0, 0];
  const start = (p) => {
    current = { points: [p], closed: false };
    subpaths.push(current);
  };
  for (const { op, a } of commands) {
    if (op === 'm') {
      at = [a[0], a[1]];
      start(at);
    } else if (op === 're') {
      const [x, y, w, h] = a;
      start([x, y]);
      current.points.push([x + w, y], [x + w, y + h], [x, y + h]);
      current.closed = true;
      at = [x, y];
      current = null;
    } else if (op === 'h') {
      if (current) {
        current.closed = true;
        at = current.points[0];
        current = null;
      }
    } else {
      if (!current) start(at);
      if (op === 'l') at = [a[0], a[1]];
      if (op === 'l') current.points.push(at);
      else {
        const [c1, c2, end] =
          op === 'c'
            ? [
                [a[0], a[1]],
                [a[2], a[3]],
                [a[4], a[5]],
              ]
            : op === 'v'
              ? [at, [a[0], a[1]], [a[2], a[3]]]
              : [
                  [a[0], a[1]],
                  [a[2], a[3]],
                  [a[2], a[3]],
                ];
        current.points.push(...flatten(at, c1, c2, end, tolerance));
        at = end;
      }
    }
  }
  if (closeLast && subpaths.length) subpaths.at(-1).closed = true;
  return subpaths.map(({ points, closed }) => ({
    points: points.map(([x, y]) => apply(ctm, x, y)),
    closed,
  }));
}

/** A polygon clipped to an axis-aligned window [x0, y0, x1, y1] (Sutherland–Hodgman). */
function clipPolygon(points, [x0, y0, x1, y1]) {
  let out = points;
  for (const [inside, cross] of [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ]) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i],
        b = input[(i + 1) % input.length];
      if (inside(a)) {
        out.push(a);
        if (!inside(b)) out.push(cross(a, b));
      } else if (inside(b)) out.push(cross(a, b));
    }
    if (out.length < 3) return [];
  }
  return out;
}

/**
 * The parts of `bounds` outside every one of `rects`, as rectangles that only touch: the band
 * between each pair of neighbouring edges, split where an area covers it.
 */
function keptWindows(bounds, rects) {
  const xs = new Set([bounds[0], bounds[2]]),
    ys = new Set([bounds[1], bounds[3]]);
  for (const r of rects) {
    for (const x of [r[0], r[2]]) if (x > bounds[0] && x < bounds[2]) xs.add(x);
    for (const y of [r[1], r[3]]) if (y > bounds[1] && y < bounds[3]) ys.add(y);
  }
  const sx = [...xs].sort((a, b) => a - b),
    sy = [...ys].sort((a, b) => a - b);
  const windows = [];
  for (let j = 0; j + 1 < sy.length; j++) {
    const cy = (sy[j] + sy[j + 1]) / 2;
    let open = null;
    for (let i = 0; i + 1 < sx.length; i++) {
      const cx = (sx[i] + sx[i + 1]) / 2;
      const covered = rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3]);
      if (!covered) {
        if (open) open[2] = sx[i + 1];
        else open = [sx[i], sy[j], sx[i + 1], sy[j + 1]];
      } else if (open) {
        windows.push(open);
        open = null;
      }
    }
    if (open) windows.push(open);
  }
  return windows;
}

/** The parameter ranges (0 to 1) of segment a→b inside an axis-aligned rect (Liang–Barsky). */
function segmentInside(a, b, [x0, y0, x1, y1]) {
  let t0 = 0,
    t1 = 1;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * A polyline's pieces outside every rect, each `{ points, closed, from }`: `from` is how far
 * along the original subpath (in page units) the piece starts, so a dash pattern can go on.
 */
function cutPolyline({ points, closed }, rects) {
  const ring = closed ? [...points, points[0]] : points;
  const pieces = [];
  let piece = null,
    travelled = 0,
    cut = false;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i],
      b = ring[i + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // The covered stretches of this segment, merged.
    const covered = rects
      .map((r) => segmentInside(a, b, r))
      .filter(Boolean)
      .sort((p, q) => p[0] - q[0]);
    const kept = [];
    let from = 0;
    for (const [t0, t1] of covered) {
      if (t0 > from) kept.push([from, t0]);
      from = Math.max(from, t1);
    }
    if (from < 1) kept.push([from, 1]);
    if (covered.length) cut = true;
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (const [t0, t1] of kept) {
      if (piece && t0 === 0) piece.points.push(at(t1));
      else {
        piece = { points: [at(t0), at(t1)], from: travelled + length * t0 };
        pieces.push(piece);
      }
      if (t1 < 1) piece = null;
    }
    if (!kept.length) piece = null;
    travelled += length;
  }
  if (!cut) return [{ points, closed, from: 0 }];
  // A closed outline cut open at one place starts again where its last piece ended.
  if (closed && pieces.length > 1) {
    const first = pieces[0],
      last = pieces.at(-1);
    const end = last.points.at(-1);
    if (first.from === 0 && end[0] === ring[0][0] && end[1] === ring[0][1]) {
      pieces.pop();
      first.points = [...last.points, ...first.points.slice(1)];
      first.from = last.from;
    }
  }
  return pieces.map((p) => ({ ...p, closed: false }));
}

/**
 * Cut `rects` (page space) out of a painted path. `commands` are its construction commands
 * ({ op, a } in user space under `ctm`), `fill` 'nonzero', 'evenodd' or null, `stroke` whether
 * it is stroked with `lineWidth` (user space) and `dash` ({ array, phase } or null), `close`
 * whether the painting closes the last subpath. Resolves to the content that paints what is
 * left, in the same user space (possibly empty), or null when the path cannot be cut, as under
 * a matrix that squashes it flat.
 */
export function cutPath({ commands, ctm, fill, stroke, lineWidth, dash, close, rects, format }) {
  const back = inverse(ctm);
  if (!back) return null;
  const lines = polylines(commands, ctm, close);
  const points = lines.flatMap((line) => line.points);
  if (!points.length) return '';
  const user = ([x, y]) => apply(back, x, y).map(format).join(' ');
  const out = [];
  if (fill) {
    const bounds = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
    ];
    const shapes = [];
    for (const window of keptWindows(bounds, rects))
      for (const line of lines) {
        const polygon = clipPolygon(line.points, window);
        if (polygon.length >= 3)
          shapes.push(
            `${user(polygon[0])} m ${polygon
              .slice(1)
              .map((p) => `${user(p)} l`)
              .join(' ')} h`,
          );
      }
    if (shapes.length) out.push(`${shapes.join('\n')}\n${fill === 'evenodd' ? 'f*' : 'f'}`);
  }
  if (stroke) {
    // Ink reaches half a line width past the centre line, more where the matrix stretches it.
    const half = Math.max((lineWidth || 0) * stretch(ctm), 0.5) / 2;
    const widened = rects.map((r) => [r[0] - half, r[1] - half, r[2] + half, r[3] + half]);
    const pieces = lines
      .filter((line) => line.points.length > 1)
      .flatMap((line) => cutPolyline(line, widened));
    const text = (piece) =>
      `${user(piece.points[0])} m ${piece.points
        .slice(1)
        .map((p) => `${user(p)} l`)
        .join(' ')}${piece.closed ? ' h' : ''}`;
    const scale = stretch(ctm) || 1;
    if (dash?.array.length && dash.array.some((n) => n > 0))
      // Each piece goes on with the dash pattern where the stroke was when it was cut.
      for (const piece of pieces)
        out.push(
          `q [${dash.array.map(format).join(' ')}] ${format(dash.phase + piece.from / scale)} d ${text(piece)} S Q`,
        );
    else if (pieces.length) out.push(`${pieces.map(text).join('\n')}\nS`);
  }
  return out.join('\n');
}
