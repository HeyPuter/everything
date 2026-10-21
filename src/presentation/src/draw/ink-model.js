// Ink on a slide: each stroke is a freeform shape with a smooth outline-only
// path and round ends, named "Ink …", so it moves, recolours, copies and is
// saved in the .pptx like any other drawing. When it was drawn travels with
// it (P.setShapeInkTiming) for replay. Shapes recognised from ink become
// ordinary preset shapes and lines.
import {
  simplifyIndices,
  smoothCommands,
  sampleCommands,
  bounds,
} from "./ink-geometry.js";

export const INK_NAME = "Ink";
const PT = 12700;
// A millimetre of pen is drawn this many points wide; pen sizes are named
// in millimetres.
export const MM = 2.835;
export const penWidthEmu = (pen) => Math.round(pen.width * MM * PT);

/** Whether the object is a stroke of ink. */
export function isInk(P, shape) {
  return (
    P.getShapeKind(shape) === "shape" &&
    String(P.getShapeName?.(shape) || "").startsWith(`${INK_NAME} `)
  );
}
export const inkShapes = (P, slide) =>
  P.getSlideShapes(slide).filter((s) => isInk(P, s));

// The stroke colour a pen writes, with its see-through amount.
export function penStrokeColor(pen) {
  const hex = String(pen.color || "#000000").toUpperCase();
  if (pen.type === "highlighter") return `${hex}/alpha=50000`;
  if (pen.texture === "graphite") return `${hex}/alpha=62000`;
  return hex;
}

// Graphite is drawn twice, a hair apart, so the pencil's grain shows where
// the passes overlap: this far apart for a stroke `width` EMUs wide.
const graphiteGrain = (width) => Math.max(1, width * 0.35);

// The box and smooth paths of a stroke through `kept` (slide EMUs), with
// the second, offset pass of graphite when `grain` is given.
function strokeGeometry(kept, grain = 0) {
  const b = bounds(kept);
  const minX = b.x - grain,
    minY = b.y - grain;
  const w = Math.round(Math.max(1, b.w + grain * 2)),
    h = Math.round(Math.max(1, b.h + grain * 2));
  const local = kept.map((q) => ({ x: q.x - minX, y: q.y - minY }));
  const paths = [{ w, h, fill: false, commands: smoothCommands(local) }];
  if (grain)
    paths.push({
      w,
      h,
      fill: false,
      commands: smoothCommands(
        local.map((q, i) => ({
          x: q.x + (i % 2 ? grain : -grain) * 0.6,
          y: q.y + (i % 3 ? grain : -grain) * 0.6,
        })),
      ),
    });
  return {
    box: { x: Math.round(minX), y: Math.round(minY), w, h },
    paths,
  };
}

/**
 * Adds a stroke drawn through `points` (slide EMUs) with `pen`, thinned to
 * `tolerance`. `times` (ms since `start`, one per point) records the pace it
 * was drawn at. Returns the new shape.
 */
export function addInkStroke(
  P,
  slide,
  points,
  pen,
  { tolerance = 1, times = null, start = null, name = null } = {},
) {
  const keep = simplifyIndices(points, tolerance);
  const kept = keep.map((i) => points[i]);
  const keptTimes = times ? keep.map((i) => times[i] ?? 0) : null;
  if (kept.length === 1) {
    kept.push({ x: kept[0].x + tolerance, y: kept[0].y });
    keptTimes?.push(keptTimes[0]);
  }
  const width = penWidthEmu(pen);
  const { box, paths } = strokeGeometry(
    kept,
    pen.texture === "graphite" ? graphiteGrain(width) : 0,
  );
  const shape = P.addSlideShape(slide, {
    preset: "rect",
    ...box,
    name: name || `${INK_NAME} ${Date.now() % 100000}`,
  });
  P.setShapeFreeformPaths(shape, paths);
  P.setShapeNoFill(shape);
  P.setShapeStroke(shape, { color: penStrokeColor(pen), widthEmu: width });
  P.setShapeStrokeCap(shape, "rnd");
  P.setShapeStrokeJoin(shape, "round");
  if (pen.texture === "dotted") P.setShapeStrokeDash(shape, "sysDot");
  if (keptTimes && P.setShapeInkTiming)
    P.setShapeInkTiming(shape, {
      start: start ?? Date.now(),
      times: keptTimes,
    });
  return shape;
}

/** Redraws a stroke through new points (slide EMUs): one smooth path (two
 * for graphite, which keeps its grain), its box fitted to them, neither
 * turned nor flipped. */
export function setStrokeGeometry(P, shape, points, tolerance = 1) {
  if (P.getShapeRotation?.(shape)) P.setShapeRotation(shape, 0);
  const flip = P.getShapeFlip?.(shape);
  if (flip?.horizontal || flip?.vertical)
    P.setShapeFlip(shape, { horizontal: false, vertical: false });
  const kept = simplifyIndices(points, tolerance).map((i) => points[i]);
  if (kept.length === 1) kept.push({ x: kept[0].x + tolerance, y: kept[0].y });
  let passes = 1;
  try {
    passes = P.getShapeCustomGeometry(shape)?.paths?.length || 1;
  } catch {}
  const { box, paths } = strokeGeometry(
    kept,
    passes > 1 ? graphiteGrain(P.getShapeStrokeWidth?.(shape) || PT) : 0,
  );
  P.setShapeBounds(shape, box);
  P.setShapeFreeformPaths(shape, paths);
}

// The first path of a stroke and the scale from its grid to the slide.
function strokePath(P, shape) {
  const b = P.getShapeBounds(shape);
  if (!b) return null;
  let path = null;
  try {
    path = P.getShapeCustomGeometry(shape)?.paths?.[0];
  } catch {}
  return { b, path };
}

// Where a point within the stroke's box lands on the slide: a stroke turned
// or flipped since it was drawn is drawn so about its box's centre (flipped
// first, then turned clockwise).
function placement(P, shape, b) {
  const turn = P.getShapeRotation?.(shape) || 0;
  let flip = null;
  try {
    flip = P.getShapeFlip?.(shape);
  } catch {}
  const fx = !!flip?.horizontal,
    fy = !!flip?.vertical;
  if (!turn && !fx && !fy) return (p) => p;
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  const a = (turn * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  return (p) => {
    const dx = fx ? cx - p.x : p.x - cx,
      dy = fy ? cy - p.y : p.y - cy;
    return { ...p, x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
}

/** A stroke's on-curve points on the slide, in drawing order. */
export function strokePoints(P, shape) {
  const found = strokePath(P, shape);
  if (!found) return [];
  const { b, path } = found;
  const place = placement(P, shape, b);
  if (!path)
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
    ].map(place);
  const sx = b.w / (path.w || b.w || 1),
    sy = b.h / (path.h || b.h || 1);
  const out = [];
  for (const c of path.commands) {
    const pt = c.pt || c.pts?.at(-1);
    if (pt) out.push(place({ x: b.x + pt.x * sx, y: b.y + pt.y * sy }));
  }
  return out;
}

/** A stroke's line on the slide as drawn, `steps` points to each curve, each
 * marked with the on-curve point it follows (`at`) and how far on (`f`). */
export function strokeSamples(P, shape, steps = 8) {
  const found = strokePath(P, shape);
  if (!found?.path)
    return strokePoints(P, shape).map((p, i) => ({ ...p, at: i, f: 0 }));
  const { b, path } = found;
  const place = placement(P, shape, b);
  const sx = b.w / (path.w || b.w || 1),
    sy = b.h / (path.h || b.h || 1);
  return sampleCommands(path.commands, steps).map((p) =>
    place({
      ...p,
      x: b.x + p.x * sx,
      y: b.y + p.y * sy,
    }),
  );
}

/** How a stroke is drawn: colour (#RRGGBB), opacity, and width in EMUs. */
export function strokeStyle(P, shape) {
  let stroke = null;
  try {
    stroke = P.getShapeStroke(shape);
  } catch {}
  const solid = stroke?.kind === "solid";
  const color =
    solid && /^#[0-9A-F]{6}$/i.test(stroke.color) ? stroke.color : "#000000";
  return {
    color,
    opacity: solid ? (stroke.opacity ?? 1) : 1,
    width: (solid && stroke.widthEmu) || 12700,
  };
}

/**
 * Puts a recognised shape on the slide in the pen's colour, outline only, in
 * place of the ink. `found` is recognizeStroke's answer.
 */
export function addRecognizedShape(P, slide, found, pen, labels = {}) {
  const color = String(pen.color || "#000000").toUpperCase();
  const widthEmu = Math.max(PT, penWidthEmu(pen));
  if (found.kind === "line") {
    const s = P.addSlideLine(slide, {
      from: { x: Math.round(found.from.x), y: Math.round(found.from.y) },
      to: { x: Math.round(found.to.x), y: Math.round(found.to.y) },
      color,
      widthEmu,
    });
    if (found.arrow === "end" || found.arrow === "both")
      P.setShapeStrokeArrow(s, "tail", { type: "triangle" });
    if (found.arrow === "start" || found.arrow === "both")
      P.setShapeStrokeArrow(s, "head", { type: "triangle" });
    P.setShapeStrokeCap(s, "rnd");
    P.renameShape(s, `${found.arrow ? "Arrow" : "Line"} ${P.getShapeId(s)}`);
    return s;
  }
  const s = P.addSlideShape(slide, {
    preset: found.preset,
    x: Math.round(found.x),
    y: Math.round(found.y),
    w: Math.max(1, Math.round(found.w)),
    h: Math.max(1, Math.round(found.h)),
  });
  P.setShapeNoFill(s);
  P.setShapeStroke(s, { color, widthEmu });
  P.setShapeStrokeJoin(s, "round");
  if (found.rot) P.setShapeRotation(s, found.rot);
  if (found.flipH || found.flipV)
    P.setShapeFlip(s, {
      horizontal: !!found.flipH,
      vertical: !!found.flipV,
    });
  if (found.adj != null) P.setShapeAdjustValues(s, { adj: found.adj });
  P.renameShape(s, `${labels[found.preset] || "Shape"} ${P.getShapeId(s)}`);
  return s;
}

/** Adds an arrowhead to one end ("start" or "end") of a line. */
export function addArrowhead(P, line, end) {
  P.setShapeStrokeArrow(line, end === "start" ? "head" : "tail", {
    type: "triangle",
  });
  if (!/^Arrow /.test(P.getShapeName(line)))
    P.renameShape(line, `Arrow ${P.getShapeId(line)}`);
}
