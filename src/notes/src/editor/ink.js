import { getStroke } from 'perfect-freehand';

/*
 * Ink items on a page, in page coordinates:
 *   { id, type: 'stroke', color, width, highlighter, points: [[x, y, pressure], ...] }
 *   { id, type: 'shape', kind, color, width, x1, y1, x2, y2 }
 * kinds: line, arrow, doubleArrow, rect, ellipse, triangle, diamond
 */

export const PENS = [
  { id: 'pen-black', label: 'Pen: Black, 0.5 mm', color: '#1f1f1f', width: 2.5, highlighter: false },
  { id: 'pen-blue', label: 'Pen: Blue, 0.5 mm', color: '#1c5fd4', width: 2.5, highlighter: false },
  { id: 'pen-red', label: 'Pen: Red, 0.5 mm', color: '#c42b1c', width: 2.5, highlighter: false },
  { id: 'pen-green', label: 'Pen: Green, 0.5 mm', color: '#2b8a3e', width: 2.5, highlighter: false },
  { id: 'pen-purple', label: 'Pen: Purple, 1 mm', color: '#7e2fa8', width: 4, highlighter: false },
  { id: 'hl-yellow', label: 'Highlighter: Yellow, 6 mm', color: '#ffe500', width: 16, highlighter: true },
  { id: 'hl-green', label: 'Highlighter: Green, 6 mm', color: '#5dff5d', width: 16, highlighter: true },
  { id: 'hl-pink', label: 'Highlighter: Pink, 6 mm', color: '#ff7ce0', width: 16, highlighter: true },
];

export const INK_COLORS = ['#1f1f1f', '#6b6b6b', '#ffffff', '#c42b1c', '#e8590c', '#f2c200', '#2b8a3e', '#0b7285', '#1c5fd4', '#7e2fa8', '#c2255c', '#8b5a2b', '#ffe500', '#5dff5d', '#4fd8ff', '#ff7ce0'];
export const INK_WIDTHS = [1, 1.5, 2.5, 4, 6, 9, 12, 16, 24];

export const SHAPES = [
  { kind: 'line', label: 'Line', icon: 'line' },
  { kind: 'arrow', label: 'Arrow', icon: 'arrow' },
  { kind: 'doubleArrow', label: 'Double Arrow', icon: 'doubleArrow' },
  { kind: 'rect', label: 'Rectangle', icon: 'rect' },
  { kind: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
  { kind: 'triangle', label: 'Triangle', icon: 'triangle' },
  { kind: 'diamond', label: 'Diamond', icon: 'diamond' },
];

function polygonToPath(poly) {
  if (!poly.length) return '';
  const f = (n) => Math.round(n * 100) / 100;
  let d = `M${f(poly[0][0])} ${f(poly[0][1])}`;
  for (let i = 1; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    d += ` Q${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)}`;
  }
  return d + 'Z';
}

/** Filled outline path for a freehand stroke. */
export function strokePath(item) {
  const hasPressure = item.points.some((p) => p[2] !== undefined && p[2] !== 0.5);
  const poly = getStroke(item.points, {
    size: item.width * (item.highlighter ? 1 : 1.6),
    thinning: item.highlighter ? 0 : 0.55,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: !hasPressure && !item.highlighter,
    start: { cap: !item.highlighter },
    end: { cap: !item.highlighter },
    last: true,
  });
  return polygonToPath(poly);
}

/** Stroke-only path for a shape. */
export function shapePath(s) {
  const { x1, y1, x2, y2 } = s;
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const hgt = Math.abs(y2 - y1);
  switch (s.kind) {
    case 'rect':
      return `M${minX} ${minY}h${w}v${hgt}h${-w}Z`;
    case 'ellipse': {
      const rx = w / 2;
      const ry = hgt / 2;
      const cx = minX + rx;
      const cy = minY + ry;
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case 'triangle':
      return `M${minX + w / 2} ${minY}L${minX + w} ${minY + hgt}L${minX} ${minY + hgt}Z`;
    case 'diamond':
      return `M${minX + w / 2} ${minY}L${minX + w} ${minY + hgt / 2}L${minX + w / 2} ${minY + hgt}L${minX} ${minY + hgt / 2}Z`;
    case 'arrow':
    case 'doubleArrow': {
      let d = `M${x1} ${y1}L${x2} ${y2}`;
      d += arrowHead(x1, y1, x2, y2, s.width);
      if (s.kind === 'doubleArrow') d += arrowHead(x2, y2, x1, y1, s.width);
      return d;
    }
    default:
      return `M${x1} ${y1}L${x2} ${y2}`;
  }
}

function arrowHead(x1, y1, x2, y2, width) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = 10 + width * 2;
  const a1 = angle + Math.PI - 0.45;
  const a2 = angle + Math.PI + 0.45;
  return `M${x2 + len * Math.cos(a1)} ${y2 + len * Math.sin(a1)}L${x2} ${y2}L${x2 + len * Math.cos(a2)} ${y2 + len * Math.sin(a2)}`;
}

/** Constrains a shape drag: square/circle, or 45-degree lines. */
export function constrainShape(kind, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (['line', 'arrow', 'doubleArrow'].includes(kind)) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [x1 + len * Math.cos(angle), y1 + len * Math.sin(angle)];
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  return [x1 + Math.sign(dx || 1) * size, y1 + Math.sign(dy || 1) * size];
}

export function bounds(item) {
  if (item.type === 'shape') {
    const pad = item.width / 2;
    return { x: Math.min(item.x1, item.x2) - pad, y: Math.min(item.y1, item.y2) - pad, w: Math.abs(item.x2 - item.x1) + 2 * pad, h: Math.abs(item.y2 - item.y1) + 2 * pad };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of item.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = item.width;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function unionBounds(list) {
  if (!list.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of list) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function shapeSegments(s) {
  const { x1, y1, x2, y2 } = s;
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const maxX = Math.max(x1, x2);
  const maxY = Math.max(y1, y2);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const poly = (pts) => pts.map((p, i) => [...p, ...pts[(i + 1) % pts.length]]);
  switch (s.kind) {
    case 'rect':
      return poly([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]);
    case 'triangle':
      return poly([[cx, minY], [maxX, maxY], [minX, maxY]]);
    case 'diamond':
      return poly([[cx, minY], [maxX, cy], [cx, maxY], [minX, cy]]);
    case 'ellipse': {
      const pts = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        pts.push([cx + ((maxX - minX) / 2) * Math.cos(a), cy + ((maxY - minY) / 2) * Math.sin(a)]);
      }
      return poly(pts);
    }
    default:
      return [[x1, y1, x2, y2]];
  }
}

function cross(ox, oy, ax, ay, bx, by) {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Shortest distance between segments AB and CD (0 when they cross). */
function segmentDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(ax, ay, cx, cy, dx, dy), distToSegment(bx, by, cx, cy, dx, dy), distToSegment(cx, cy, ax, ay, bx, by), distToSegment(dx, dy, ax, ay, bx, by));
}

/**
 * Whether point (x, y) is within r of the item's ink. With `from`, tests
 * the whole segment from that point to (x, y), so a fast eraser swipe
 * also hits ink it passed over between two pointer events.
 */
export function hitTest(item, x, y, r, from = null) {
  const [fx, fy] = from || [x, y];
  const b = bounds(item);
  if (Math.max(x, fx) < b.x - r || Math.min(x, fx) > b.x + b.w + r || Math.max(y, fy) < b.y - r || Math.min(y, fy) > b.y + b.h + r) return false;
  const reach = r + item.width / 2;
  const near = (ax, ay, bx, by) => segmentDist(fx, fy, x, y, ax, ay, bx, by) <= reach;
  if (item.type === 'shape') return shapeSegments(item).some(([ax, ay, bx, by]) => near(ax, ay, bx, by));
  const pts = item.points;
  if (pts.length === 1) return near(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) if (near(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])) return true;
  return false;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether most of an item lies inside a lasso polygon. */
export function insideLasso(item, poly) {
  const pts = item.type === 'shape' ? [[item.x1, item.y1], [item.x2, item.y2], [(item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2]] : item.points;
  if (!pts.length) return false;
  let n = 0;
  for (const [x, y] of pts) if (pointInPolygon(x, y, poly)) n++;
  return n / pts.length >= 0.6;
}

export function translate(item, dx, dy) {
  if (item.type === 'shape') {
    item.x1 += dx;
    item.x2 += dx;
    item.y1 += dy;
    item.y2 += dy;
  } else {
    for (const p of item.points) {
      p[0] += dx;
      p[1] += dy;
    }
  }
}

/** Drops points closer than minDist to the previous one (keeps the last). */
export function simplify(points, minDist = 0.75) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = out[out.length - 1];
    if (Math.hypot(points[i][0] - px, points[i][1] - py) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out.map(([x, y, p]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10, p === undefined ? 0.5 : Math.round(p * 100) / 100]);
}

/**
 * Ink to Shape: recognizes a freehand stroke as a line, ellipse,
 * rectangle or triangle. Returns shape coordinates or null.
 */
export function recognizeShape(points) {
  if (points.length < 4) return null;
  const pts = points.map(([x, y]) => [x, y]);
  const [x0, y0] = pts[0];
  const [xn, yn] = pts[pts.length - 1];
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (length < 24) return null;
  const b = bounds({ type: 'stroke', points: pts, width: 0 });
  const size = Math.max(b.w, b.h);
  const gap = Math.hypot(xn - x0, yn - y0);

  // Open and nearly straight: a line.
  if (gap > length * 0.9) {
    const maxDev = Math.max(...pts.map(([x, y]) => distToSegment(x, y, x0, y0, xn, yn)));
    if (maxDev < Math.max(4, gap * 0.06)) return { kind: 'line', x1: x0, y1: y0, x2: xn, y2: yn };
    return null;
  }
  // Closed shapes must end near where they started.
  if (gap > size * 0.3 || b.w < 12 || b.h < 12) return null;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  // Ellipse: points stay close to the ellipse through the bounding box.
  const ellipseErr = pts.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1), 0) / pts.length;
  // Corners: sharp turns along the stroke.
  const corners = cornerCount(pts, size);
  const box = { x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h };
  if (corners === 3) return { kind: 'triangle', ...box };
  if (corners === 4 || (corners >= 3 && ellipseErr > 0.12)) {
    // Points hugging the box edges make a rectangle.
    const edgeErr = pts.reduce((s, [x, y]) => s + Math.min(Math.abs(x - box.x1), Math.abs(x - box.x2), Math.abs(y - box.y1), Math.abs(y - box.y2)), 0) / pts.length;
    if (edgeErr < size * 0.06) return { kind: 'rect', ...box };
  }
  if (ellipseErr < 0.12) return { kind: 'ellipse', ...box };
  return null;
}

function cornerCount(pts, size) {
  // Resample to even spacing, then count direction changes above ~50 degrees.
  const step = Math.max(3, size / 20);
  const even = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc >= step) {
      even.push(pts[i]);
      acc = 0;
    }
  }
  let corners = 0;
  let cooldown = 0;
  for (let i = 2; i < even.length - 2; i++) {
    if (cooldown > 0) {
      cooldown--;
      continue;
    }
    const a = Math.atan2(even[i][1] - even[i - 2][1], even[i][0] - even[i - 2][0]);
    const c = Math.atan2(even[i + 2][1] - even[i][1], even[i + 2][0] - even[i][0]);
    let d = Math.abs(a - c);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 0.9) {
      corners++;
      cooldown = 2;
    }
  }
  // The start/end join usually reads as one more corner of a closed shape.
  return corners + 1;
}
