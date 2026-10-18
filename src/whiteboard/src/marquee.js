import { bounds } from "./model.js";
import { connectorSegments, connectorLabel } from "./connectors.js";
import { protectedIds } from "./locking.js";
import { rotationOf, worldPoint, boxCorners } from "./geometry.js";

export const PRECISE_SELECTION_KEY = "whiteboard-precise-selection";
export const readPreciseSelection = (value) => value === "true";

function overlap(a, b) {
  return (
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  );
}
// Whether a lies inside b without touching its edges.
function within(a, b) {
  return (
    a.x > b.x && a.y > b.y && a.x + a.w < b.x + b.w && a.y + a.h < b.y + b.h
  );
}
function coverage(a, b) {
  if (!overlap(a, b)) return 0;
  const width = Math.max(
      0,
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    ),
    height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (b.w ? width / b.w : 1) * (b.h ? height / b.h : 1);
}
// Clip a segment to the selection rectangle, retaining the fraction of its
// length inside. This also handles horizontal, vertical, and reversed strokes.
function segmentCoverage(a, b, rect) {
  let low = 0,
    high = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, rect.x, rect.x + rect.w],
    [a.y, b.y - a.y, rect.y, rect.y + rect.h],
  ]) {
    if (!delta) {
      if (start < min || start > max) return 0;
      continue;
    }
    const p = (min - start) / delta,
      q = (max - start) / delta;
    low = Math.max(low, Math.min(p, q));
    high = Math.min(high, Math.max(p, q));
    if (low > high) return 0;
  }
  return high - low;
}
function pathCoverage(path, rect) {
  let total = 0,
    inside = 0;
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1],
      b = path[n],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    total += length;
    inside += length * segmentCoverage(a, b, rect);
  }
  return total
    ? inside / total
    : Number(path.length > 0 && overlap(rect, { ...path[0], w: 0, h: 0 }));
}
function polygonCoverage(polygon, rect) {
  const area = (points) =>
    Math.abs(
      points.reduce((sum, a, n) => {
        const b = points[(n + 1) % points.length];
        return sum + a.x * b.y - b.x * a.y;
      }, 0),
    ) / 2;
  const total = area(polygon);
  for (const [axis, edge, sign] of [
    ["x", rect.x, 1],
    ["x", rect.x + rect.w, -1],
    ["y", rect.y, 1],
    ["y", rect.y + rect.h, -1],
  ]) {
    const clipped = [];
    for (let n = 0; n < polygon.length; n++) {
      const a = polygon[n],
        b = polygon[(n + 1) % polygon.length],
        insideA = (a[axis] - edge) * sign >= 0,
        insideB = (b[axis] - edge) * sign >= 0;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    polygon = clipped;
    if (!polygon.length) return 0;
  }
  return total ? area(polygon) / total : 0;
}

// Prepare geometry and protection once per gesture (and after remote changes).
// Detailed paths are cached only when a stroke is partly inside the rectangle.
export function createMarqueeIndex(items, visible = items) {
  const blocked = protectedIds(items);
  return visible
    .filter((i) => !blocked.has(i.id))
    .map((i) => ({
      id: i.id,
      box: bounds([i]),
      precise: i.type === "table" || !!i.mindMap,
      frame: i.type === "frame",
      polygon: rotationOf(i) && i.type !== "pen" ? boxCorners(i) : null,
      path:
        i.type === "arrow"
          ? () => connectorSegments(i)
          : i.type === "pen"
            ? () =>
                (i.points || []).map(([x, y]) =>
                  worldPoint(i, { x: i.x + x, y: i.y + y }),
                )
            : null,
      label: i.type === "arrow" && i.text ? connectorLabel(i) : null,
    }));
}
export function marqueeSelection(index, rect, precise = false) {
  const ids = new Set();
  if (!(rect.w > 0 && rect.h > 0)) return ids;
  for (const entry of index) {
    if (!overlap(rect, entry.box)) continue;
    let ratio = coverage(rect, entry.box);
    if (ratio >= 1) {
      ids.add(entry.id);
      continue;
    }
    const strict = precise || entry.precise;
    const points = entry.path && (entry.points ||= entry.path());
    let hit;
    if (points?.length) {
      const path = pathCoverage(points, rect),
        label = entry.label && coverage(rect, entry.label);
      hit = strict
        ? path >= 0.9 - 1e-9 && (!entry.label || label >= 0.9 - 1e-9)
        : path > 0 || label > 0;
    } else if (entry.frame && !strict && within(rect, entry.box)) {
      // A box drawn inside a frame picks the content there, not the frame
      // around it (which would bring all its content along).
      hit = false;
    } else {
      if (entry.polygon) ratio = polygonCoverage(entry.polygon, rect);
      hit = strict ? ratio >= 0.9 - 1e-9 : ratio > 0;
    }
    if (hit) ids.add(entry.id);
  }
  return ids;
}
