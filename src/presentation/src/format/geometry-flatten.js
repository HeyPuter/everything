// Converts resolved shape geometry to polylines (and back to freeform paths)
// for polygon boolean operations.

import { resolveGeometryArc } from "../../lib/pptx/src/internal/drawingml/geometry-arc.ts";

// Recursively subdivides a Bezier until its control points lie within `tol`
// of the chord; appends the points after the first.
function flattenBezier(pts, tol, out, depth = 0) {
  const a = pts[0],
    b = pts[pts.length - 1],
    dx = b.x - a.x,
    dy = b.y - a.y,
    len = Math.hypot(dx, dy);
  const dev = (p) =>
    len
      ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
      : Math.hypot(p.x - a.x, p.y - a.y);
  if (depth >= 16 || pts.slice(1, -1).every((p) => dev(p) <= tol)) {
    out.push(b);
    return;
  }
  // de Casteljau split at t = 0.5.
  const levels = [pts];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1);
    levels.push(
      l
        .slice(1)
        .map((p, i) => ({ x: (l[i].x + p.x) / 2, y: (l[i].y + p.y) / 2 })),
    );
  }
  flattenBezier(
    levels.map((l) => l[0]),
    tol,
    out,
    depth + 1,
  );
  flattenBezier(levels.map((l) => l.at(-1)).reverse(), tol, out, depth + 1);
}

// Flattens one axis-aligned elliptical arc of at most a half turn from p0 to
// p1. `clockwise` means increasing angle in y-down coordinates.
function flattenArc(p0, p1, rx, ry, clockwise, tol, out) {
  if (!(rx > 0 && ry > 0)) return void out.push(p1);
  const u0 = p0.x / rx,
    v0 = p0.y / ry,
    u1 = p1.x / rx,
    v1 = p1.y / ry,
    half = Math.min(1, Math.hypot(u1 - u0, v1 - v0) / 2);
  if (half < 1e-12) return void out.push(p1);
  const h = Math.sqrt(1 - half * half),
    nx = -(v1 - v0) / (2 * half),
    ny = (u1 - u0) / (2 * half),
    mu = (u0 + u1) / 2,
    mv = (v0 + v1) / 2;
  let best = null;
  for (const s of [1, -1]) {
    const cu = mu + s * h * nx,
      cv = mv + s * h * ny,
      t0 = Math.atan2(v0 - cv, u0 - cu);
    let span = Math.atan2(v1 - cv, u1 - cu) - t0;
    if (clockwise && span <= 0) span += 2 * Math.PI;
    if (!clockwise && span >= 0) span -= 2 * Math.PI;
    if (!best || Math.abs(span) < Math.abs(best.span))
      best = { cu, cv, t0, span };
  }
  const r = Math.max(rx, ry),
    step = 2 * Math.acos(Math.max(-1, 1 - tol / r)),
    n = Math.max(1, Math.ceil(Math.abs(best.span) / step));
  for (let i = 1; i < n; i++) {
    const t = best.t0 + (best.span * i) / n;
    out.push({
      x: (best.cu + Math.cos(t)) * rx,
      y: (best.cv + Math.sin(t)) * ry,
    });
  }
  out.push(p1);
}

/**
 * Flattens a resolved custom geometry (`getShapeGeometryResolved(...).geometry`)
 * into polyline rings in shape-local EMU, with chords deviating at most
 * `tolerance` EMU from curves. Paths with their own `w`/`h` grid are scaled
 * to the shape extents `w`/`h` like the renderer does (omitted grids are
 * already in shape EMU). Returns `[{ points, closed, fill }]`; `fill` is
 * false for stroke-only paths.
 */
export function flattenGeometry(geometry, { tolerance = 2000, w, h } = {}) {
  const rings = [];
  for (const path of geometry?.paths ?? []) {
    if (path.w === 0 || path.h === 0) continue;
    const sx = path.w == null || w == null ? 1 : w / path.w,
      sy = path.h == null || h == null ? 1 : h / path.h,
      S = (p) => ({ x: p.x * sx, y: p.y * sy }),
      fill = path.fill !== "none";
    let cur = { x: 0, y: 0 },
      start = cur,
      ring = null;
    const finish = (closed) => {
      if (ring) {
        const pts = ring.points;
        if (
          pts.length > 1 &&
          Math.hypot(pts[0].x - pts.at(-1).x, pts[0].y - pts.at(-1).y) < 1e-6
        )
          pts.pop();
        ring.closed = closed;
        if (pts.length > 1) rings.push(ring);
      }
      ring = null;
    };
    const pen = () =>
      (ring ??= { points: [S(cur)], closed: false, fill }).points;
    for (const cmd of path.commands) {
      switch (cmd.kind) {
        case "moveTo":
          finish(false);
          start = cur = cmd.pt;
          pen();
          break;
        case "lnTo":
          pen().push(S(cmd.pt));
          cur = cmd.pt;
          break;
        case "quadBezTo":
        case "cubicBezTo":
          flattenBezier([cur, ...cmd.pts].map(S), tolerance, pen());
          cur = cmd.pts.at(-1);
          break;
        case "arcTo": {
          const out = pen();
          let from = cur;
          for (const s of resolveGeometryArc(
            cur.x,
            cur.y,
            cmd.wR,
            cmd.hR,
            cmd.stAng,
            cmd.swAng,
          )) {
            if (s.kind === "line") out.push(S(s.end));
            else
              flattenArc(
                S(from),
                S(s.end),
                s.rx * Math.abs(sx),
                s.ry * Math.abs(sy),
                s.clockwise === (Math.sign(sx) === Math.sign(sy)),
                tolerance,
                out,
              );
            from = s.end;
          }
          cur = from;
          break;
        }
        case "close":
          finish(true);
          cur = start;
          break;
      }
    }
    finish(false);
  }
  return rings;
}

/**
 * Maps shape-local rings to slide coordinates as OOXML does: flip within
 * the `w`×`h` box, rotate `rot` degrees clockwise about its centre, then
 * offset by `x`,`y`.
 */
export function transformRings(
  rings,
  { x, y, w, h, rot = 0, flipH = false, flipV = false },
) {
  const t = (rot * Math.PI) / 180,
    cos = Math.cos(t),
    sin = Math.sin(t),
    cx = w / 2,
    cy = h / 2;
  const map = (p) => {
    const dx = (flipH ? w - p.x : p.x) - cx,
      dy = (flipV ? h - p.y : p.y) - cy;
    return { x: x + cx + dx * cos - dy * sin, y: y + cy + dx * sin + dy * cos };
  };
  return rings.map((r) => ({ ...r, points: r.points.map(map) }));
}

/**
 * Converts boolean-result polygons (`[{ outer, holes }]`, or bare rings) in
 * slide coordinates into a freeform for `setShapeFreeformPaths`: one path
 * holding every ring (rendered even-odd, so holes stay open), integer
 * coordinates relative to `bounds` (defaults to the integer bounding box).
 */
export function ringsToFreeformPaths(polygons, bounds) {
  const rings = polygons.flatMap((p) =>
    p.outer ? [p.outer, ...(p.holes ?? [])] : [p],
  );
  if (!bounds) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const r of rings)
      for (const p of r) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    const x = Math.floor(x0),
      y = Math.floor(y0);
    bounds = {
      x,
      y,
      w: Math.max(1, Math.ceil(x1) - x),
      h: Math.max(1, Math.ceil(y1) - y),
    };
  }
  const commands = [];
  for (const ring of rings) {
    ring.forEach((p, i) =>
      commands.push({
        type: i ? "lineTo" : "moveTo",
        x: Math.round(p.x - bounds.x),
        y: Math.round(p.y - bounds.y),
      }),
    );
    if (ring.length) commands.push({ type: "close" });
  }
  return { bounds, paths: [{ w: bounds.w, h: bounds.h, commands }] };
}
