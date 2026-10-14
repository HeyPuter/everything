// The geometry behind inking: thinning a stroke to the points that matter,
// drawing a smooth curve through them, measuring how far a stroke lies from
// the eraser or the lasso, and recognising the shape a stroke was meant to
// be. Points are { x, y } in any one unit (the slide's EMUs in the editor);
// nothing here touches the page or the file.

const { hypot, atan2, abs, min, max, PI } = Math;
const dist = (a, b) => hypot(a.x - b.x, a.y - b.y);

/** The indices of the fewest points that stay within `tolerance` of the
 * stroke (Ramer–Douglas–Peucker). The first and last are always kept. */
export function simplifyIndices(points, tolerance) {
  const n = points.length;
  if (n < 3) return points.map((_, i) => i);
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1,
      far = sq;
    const ax = points[a].x,
      ay = points[a].y,
      dx = points[b].x - ax,
      dy = points[b].y - ay;
    const len = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = max(
        0,
        min(1, ((points[i].x - ax) * dx + (points[i].y - ay) * dy) / len),
      );
      const ex = ax + t * dx - points[i].x,
        ey = ay + t * dy - points[i].y;
      const d = ex * ex + ey * ey;
      if (d > far) {
        far = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
export function simplify(points, tolerance) {
  return simplifyIndices(points, tolerance).map((i) => points[i]);
}

/** Freeform commands for a smooth curve through the points: Catmull-Rom
 * segments written as cubic Béziers. */
export function smoothCommands(points) {
  const commands = [{ type: "moveTo", x: points[0].x, y: points[0].y }];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i],
      p1 = points[i],
      p2 = points[i + 1],
      p3 = points[i + 2] || p2;
    commands.push({
      type: "cubicTo",
      x1: p1.x + (p2.x - p0.x) / 6,
      y1: p1.y + (p2.y - p0.y) / 6,
      x2: p2.x - (p3.x - p1.x) / 6,
      y2: p2.y - (p3.y - p1.y) / 6,
      x: p2.x,
      y: p2.y,
    });
  }
  return commands;
}

/** Points along a path's commands, `steps` to each curve, as drawn. Each
 * point says which on-curve point it follows (`at`) and how far toward the
 * next it is (`f`), so timing recorded per on-curve point carries over. */
export function sampleCommands(commands, steps = 8) {
  const out = [];
  let cur = null,
    start = null,
    at = -1;
  for (const c of commands) {
    const type = c.type || c.kind;
    const to = c.pt || (c.x != null ? { x: c.x, y: c.y } : null);
    if (type === "moveTo") {
      cur = start = to;
      at++;
      out.push({ ...to, at, f: 0 });
    } else if (type === "lineTo" || type === "lnTo") {
      if (!cur) cur = to;
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        out.push({
          x: cur.x + (to.x - cur.x) * f,
          y: cur.y + (to.y - cur.y) * f,
          at,
          f,
        });
      }
      cur = to;
      at++;
      out.at(-1).at = at;
      out.at(-1).f = 0;
    } else if (type === "cubicTo" || type === "cubicBezTo") {
      const [c1, c2, end] = c.pts || [
        { x: c.x1, y: c.y1 },
        { x: c.x2, y: c.y2 },
        to,
      ];
      if (!cur) cur = c1;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps,
          u = 1 - t;
        out.push({
          x:
            u * u * u * cur.x +
            3 * u * u * t * c1.x +
            3 * u * t * t * c2.x +
            t * t * t * end.x,
          y:
            u * u * u * cur.y +
            3 * u * u * t * c1.y +
            3 * u * t * t * c2.y +
            t * t * t * end.y,
          at,
          f: t,
        });
      }
      cur = end;
      at++;
      out.at(-1).at = at;
      out.at(-1).f = 0;
    } else if (type === "close" && start && cur) {
      out.push({ ...start, at, f: 1 });
      cur = start;
    }
  }
  return out;
}

export function polylineLength(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += dist(points[i - 1], points[i]);
  return n;
}
export function bounds(points) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = min(x0, p.x);
    y0 = min(y0, p.y);
    x1 = max(x1, p.x);
    y1 = max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The shortest distance from p to the segment ab. */
export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len
    ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len))
    : 0;
  return hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
/** The shortest distance between segments ab and cd. */
export function segmentDistance(a, b, c, d) {
  const cross = (p, q, r) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c),
    d2 = cross(a, b, d),
    d3 = cross(c, d, a),
    d4 = cross(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}
/** Whether the point lies inside the polygon (even-odd). */
export function pointInPolygon(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** The corners of a box turned `rotation` degrees about its center. */
export function boxCorners({ x, y, w, h }, rotation = 0) {
  const cx = x + w / 2,
    cy = y + h / 2;
  const r = (rotation * PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([dx, dy]) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }));
}

/** Points no further apart than `step`, the line between them kept. */
export function densify(points, step) {
  if (points.length < 2 || !(step > 0)) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const n = Math.ceil(dist(a, b) / step);
    for (let s = 1; s <= n; s++)
      out.push({
        x: a.x + ((b.x - a.x) * s) / n,
        y: a.y + ((b.y - a.y) * s) / n,
      });
  }
  return out;
}

/**
 * What is left of a stroke after the eraser's path went over it: the runs
 * of its points further than `reach` from every segment of `path`, each at
 * least two points long. Null when the eraser missed it.
 */
export function eraseFromStroke(points, path, reach) {
  const segs = path.length > 1 ? path : [path[0], path[0]];
  const gone = points.map((p) => {
    for (let i = 1; i < segs.length; i++)
      if (pointSegmentDistance(p, segs[i - 1], segs[i]) <= reach) return true;
    return false;
  });
  if (!gone.some(Boolean)) return null;
  const runs = [];
  let run = [];
  points.forEach((p, i) => {
    if (gone[i]) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else run.push(p);
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * A ruler's edges as lines: the ruler is a band `thickness` wide and
 * `length` long, centered on (cx, cy) and turned `angle` degrees. A stroke
 * begun within `snap` of an edge, along its length, is laid straight along
 * that edge; otherwise null.
 */
export function followRuler(points, ruler, snap) {
  if (!ruler || points.length < 1) return null;
  const r = (ruler.angle * PI) / 180;
  const ux = Math.cos(r),
    uy = Math.sin(r);
  const nx = -uy,
    ny = ux;
  const first = points[0];
  const along = (p) => (p.x - ruler.cx) * ux + (p.y - ruler.cy) * uy;
  const across = (p) => (p.x - ruler.cx) * nx + (p.y - ruler.cy) * ny;
  if (abs(along(first)) > ruler.length / 2 + snap) return null;
  const a = across(first);
  const half = ruler.thickness / 2;
  let edge = null;
  if (abs(a + half) <= snap) edge = -half;
  else if (abs(a - half) <= snap) edge = half;
  if (edge == null) return null;
  const limit = ruler.length / 2;
  return points.map((p) => {
    const t = max(-limit, min(limit, along(p)));
    return {
      x: ruler.cx + ux * t + nx * edge,
      y: ruler.cy + uy * t + ny * edge,
    };
  });
}

/* ---------- Shape recognition ---------- */

// Points spaced evenly along the stroke, `n` of them.
function resample(points, n) {
  const total = polylineLength(points);
  if (!total) return points.slice(0, 1);
  const step = total / (n - 1);
  const out = [points[0]];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length && out.length < n; i++) {
    let cur = points[i];
    let d = dist(prev, cur);
    while (acc + d >= step && out.length < n) {
      const f = (step - acc) / d;
      const q = {
        x: prev.x + (cur.x - prev.x) * f,
        y: prev.y + (cur.y - prev.y) * f,
      };
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(points.at(-1));
  return out;
}
const angleOf = (a, b) => atan2(b.y - a.y, b.x - a.x);
function turn(a, b, c) {
  let t = angleOf(b, c) - angleOf(a, b);
  while (t > PI) t -= 2 * PI;
  while (t < -PI) t += 2 * PI;
  return t;
}
// How much of a closed stroke's turning happens at a few sharp places (a
// polygon's corners) rather than evenly all the way round (an ellipse).
function cornerness(loop) {
  const n = loop.length;
  const turns = loop.map((p, i) =>
    abs(turn(loop[(i - 2 + n) % n], p, loop[(i + 2) % n])),
  );
  const total = turns.reduce((s, t) => s + t, 0) || 1;
  const top = turns
    .slice()
    .sort((a, b) => b - a)
    .slice(0, Math.round(n / 5))
    .reduce((s, t) => s + t, 0);
  return top / total;
}
// The corners of a closed stroke: its points thinned, with any that do not
// turn the line much, or crowd another, taken out.
function corners(points, diag) {
  const loop = [...points, points[0]];
  let vs = simplify(loop, diag * 0.06).slice(0, -1);
  for (let pass = 0; pass < 6 && vs.length > 2; pass++) {
    const n = vs.length;
    let drop = -1;
    let weakest = Infinity;
    for (let i = 0; i < n; i++) {
      const a = vs[(i - 1 + n) % n],
        b = vs[i],
        c = vs[(i + 1) % n];
      const t = abs(turn(a, b, c));
      const crowded = dist(a, b) < diag * 0.08;
      const score = crowded ? -1 : t;
      if ((crowded || t < (28 * PI) / 180) && score < weakest) {
        weakest = score;
        drop = i;
      }
    }
    if (drop < 0) break;
    vs = vs.filter((_, i) => i !== drop);
  }
  return vs;
}
function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = poly[i],
        b = poly[(i + 1) % n],
        c = poly[j],
        d = poly[(j + 1) % n];
      const cross = (p, q, r) =>
        (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      if (
        cross(a, b, c) * cross(a, b, d) < 0 &&
        cross(c, d, a) * cross(c, d, b) < 0
      )
        return true;
    }
  return false;
}
function ellipseError(points, box) {
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2;
  const rx = box.w / 2 || 1,
    ry = box.h / 2 || 1;
  let sum = 0,
    worst = 0;
  for (const p of points) {
    const e = abs(
      Math.sqrt(((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2) - 1,
    );
    sum += e;
    worst = max(worst, e);
  }
  return { mean: sum / points.length, max: worst };
}
// A box drawn nearly square, made square about the same center.
function evenUp(box, tolerance = 0.12) {
  const ratio = box.w / (box.h || 1);
  if (abs(ratio - 1) > tolerance) return box;
  const s = (box.w + box.h) / 2;
  return {
    x: box.x + box.w / 2 - s / 2,
    y: box.y + box.h / 2 - s / 2,
    w: s,
    h: s,
  };
}
// A box of size w × h turned `rot` degrees, as the file stores it: the
// unturned box about the same center.
const turned = (cx, cy, w, h, rot) => ({
  x: cx - w / 2,
  y: cy - h / 2,
  w,
  h,
  rot,
});

function snapAngle(from, to) {
  const len = dist(from, to);
  const a = (angleOf(from, to) * 180) / PI;
  const nearest = Math.round(a / 45) * 45;
  if (abs(a - nearest) > 4) return to;
  const r = (nearest * PI) / 180;
  return { x: from.x + Math.cos(r) * len, y: from.y + Math.sin(r) * len };
}

function recognizeTriangle(vs, box) {
  const near = box.w + box.h;
  const sides = [
    ["bottom", (p) => abs(p.y - (box.y + box.h))],
    ["top", (p) => abs(p.y - box.y)],
    ["left", (p) => abs(p.x - box.x)],
    ["right", (p) => abs(p.x - (box.x + box.w))],
  ];
  let best = null;
  for (const [side, d] of sides) {
    const order = vs.map((p, i) => [d(p), i]).sort((a, b) => a[0] - b[0]);
    const score = order[0][0] + order[1][0];
    if (!best || score < best.score)
      best = { side, score, apex: vs[order[2][1]] };
  }
  if (best.score > near * 0.15) return null;
  const cx = box.x + box.w / 2,
    cy = box.y + box.h / 2;
  const { side, apex } = best;
  if (side === "bottom" || side === "top") {
    const f = (apex.x - box.x) / (box.w || 1);
    const flipV = side === "top";
    if (f < 0.12 || f > 0.88)
      return { preset: "rtTriangle", ...box, flipH: f > 0.5, flipV };
    return {
      preset: "triangle",
      ...box,
      flipV,
      adj: Math.round(max(0, min(1, f)) * 100000),
    };
  }
  // A base on the left or right: the triangle lies on its side, turned
  // about its center.
  const f = (apex.y - box.y) / (box.h || 1);
  return {
    preset: "triangle",
    ...turned(cx, cy, box.h, box.w, side === "left" ? 90 : 270),
    adj: Math.round(max(0, min(1, side === "left" ? f : 1 - f)) * 100000),
  };
}

function recognizeQuad(vs, box, diag) {
  const tol = diag * 0.2;
  const matches = (targets) =>
    targets.every((t) => vs.some((v) => dist(v, t) < tol)) &&
    vs.every((v) => targets.some((t) => dist(v, t) < tol));
  const { x, y, w, h } = box;
  if (
    matches([
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ])
  )
    return { preset: "rect", ...evenUp(box, 0.08) };
  if (
    matches([
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ])
  )
    return { preset: "diamond", ...evenUp(box, 0.08) };
  // A rectangle drawn at an angle.
  const right = vs.every((v, i) => {
    const t = abs(turn(vs[(i + 3) % 4], v, vs[(i + 1) % 4]));
    return abs(t - PI / 2) < (22 * PI) / 180;
  });
  if (!right) return null;
  const e = (i) => dist(vs[i], vs[(i + 1) % 4]);
  let rot = (angleOf(vs[0], vs[1]) * 180) / PI;
  let rw = (e(0) + e(2)) / 2,
    rh = (e(1) + e(3)) / 2;
  rot = ((rot % 180) + 180) % 180;
  if (rot > 135) rot -= 180;
  else if (rot > 45) {
    rot -= 90;
    [rw, rh] = [rh, rw];
  }
  const cx = vs.reduce((s, v) => s + v.x, 0) / 4,
    cy = vs.reduce((s, v) => s + v.y, 0) / 4;
  return { preset: "rect", ...turned(cx, cy, rw, rh, (rot + 360) % 360) };
}

// A closed stroke usually runs on past where it began, or stops short of
// it: it is cut at the point of its second half nearest its start.
function closeLoop(points) {
  const half = Math.floor(points.length / 2);
  let best = points.length - 1,
    nearest = Infinity;
  for (let i = half; i < points.length; i++) {
    const d = dist(points[i], points[0]);
    if (d < nearest) {
      nearest = d;
      best = i;
    }
  }
  return points.slice(0, best + 1);
}
function recognizeClosed(points, box, diag) {
  const loop = resample(closeLoop(points), 64);
  const sharp = cornerness(loop);
  const vs = corners(loop, diag);
  const fit = ellipseError(loop, box);
  // Turning gathered at a few corners is a polygon, turning spread evenly
  // an ellipse; between the two, how well an ellipse fits decides.
  const polygon = sharp > 0.55 || (sharp > 0.47 && fit.mean > 0.06);
  if (polygon && vs.length >= 3) {
    const n = vs.length;
    if (n === 3) return recognizeTriangle(vs, box);
    if (n === 4) return recognizeQuad(vs, box, diag);
    if (n === 5)
      return {
        preset: selfIntersects(vs) ? "star5" : "pentagon",
        ...evenUp(box),
      };
    if (n === 6) {
      const cx = box.x + box.w / 2;
      const pointUp = vs.some(
        (v) => abs(v.x - cx) < box.w * 0.15 && abs(v.y - box.y) < box.h * 0.12,
      );
      return pointUp
        ? {
            preset: "hexagon",
            ...turned(cx, box.y + box.h / 2, box.h, box.w, 90),
          }
        : { preset: "hexagon", ...box };
    }
    if (n === 8 && !selfIntersects(vs))
      return { preset: "octagon", ...evenUp(box) };
    if (n === 10) return { preset: "star5", ...evenUp(box) };
    return null;
  }
  if (fit.mean < 0.14 && fit.max < 0.45)
    return { preset: "ellipse", ...evenUp(box) };
  return null;
}

// One stroke drawn as an arrow: a long shaft, then a head at its end that
// turns back along it.
function recognizeOneStrokeArrow(points, diag) {
  const vs = simplify(points, diag * 0.07);
  if (vs.length < 4) return null;
  const total = polylineLength(vs);
  const shaft = dist(vs[0], vs[1]);
  if (shaft < total * 0.5) return null;
  const tip = vs[1];
  const dir = { x: (tip.x - vs[0].x) / shaft, y: (tip.y - vs[0].y) / shaft };
  let backward = 0;
  const sides = new Set();
  for (const v of vs.slice(2)) {
    const dx = v.x - tip.x,
      dy = v.y - tip.y;
    const far = hypot(dx, dy);
    if (far > shaft * 0.45) return null;
    if (far < shaft * 0.04) continue;
    const along = (dx * dir.x + dy * dir.y) / far;
    // A barb runs back toward the tail, within 70° of it.
    if (along < -Math.cos((70 * PI) / 180)) backward++;
    sides.add(Math.sign(dx * dir.y - dy * dir.x));
  }
  if (!backward) return null;
  return { kind: "line", from: vs[0], to: tip, arrow: "end" };
}

/**
 * The shape a stroke was meant to be, or null when it reads as handwriting
 * or a free curve. Straight strokes are lines ({ kind: "line", from, to,
 * arrow? }); closed ones are preset shapes ({ kind: "shape", preset, x, y,
 * w, h, rot?, flipH?, flipV?, adj? }) in the stroke's own units. `minSize`
 * leaves small marks (dots, letters) alone.
 */
export function recognizeStroke(points, { minSize = 0 } = {}) {
  if (!points || points.length < 3) return null;
  const box = bounds(points);
  const diag = hypot(box.w, box.h);
  if (!diag || diag < minSize) return null;
  const length = polylineLength(points);
  const first = points[0],
    last = points.at(-1);
  const chord = dist(first, last);
  if (chord / length > 0.95)
    return { kind: "line", from: first, to: snapAngle(first, last) };
  const arrow = recognizeOneStrokeArrow(points, diag);
  if (arrow) return arrow;
  if (chord > diag * 0.25) return null;
  const shape = recognizeClosed(points, box, diag);
  return shape && { kind: "shape", ...shape };
}

/**
 * Whether a short "V" stroke is an arrowhead drawn on one end of a line:
 * "end" or "start", or null. The V's point must sit near that end and open
 * back along the line.
 */
export function matchArrowHead(points, line) {
  if (!points || points.length < 3 || !line) return null;
  const length = dist(line.from, line.to);
  if (!length) return null;
  const box = bounds(points);
  const diag = hypot(box.w, box.h);
  if (diag > length * 0.6) return null;
  const vs = simplify(points, diag * 0.12);
  if (vs.length !== 3) return null;
  const [a, apex, c] = vs;
  const armA = dist(a, apex),
    armC = dist(c, apex);
  if (min(armA, armC) < max(armA, armC) * 0.35) return null;
  const opening = abs(turn(a, apex, c));
  // The turn at a V's point is 180° less its opening angle.
  const angle = PI - opening;
  if (angle < (15 * PI) / 180 || angle > (130 * PI) / 180) return null;
  const bis = {
    x: (a.x - apex.x) / armA + (c.x - apex.x) / armC,
    y: (a.y - apex.y) / armA + (c.y - apex.y) / armC,
  };
  for (const [end, other, name] of [
    [line.to, line.from, "end"],
    [line.from, line.to, "start"],
  ]) {
    if (dist(apex, end) > max(length * 0.2, diag * 0.6)) continue;
    const back = { x: other.x - end.x, y: other.y - end.y };
    if (bis.x * back.x + bis.y * back.y > 0) return name;
  }
  return null;
}
