/**
 * The outlines a SmartArt diagram's shapes are drawn with: each kind of shape as a path in its own box
 * (0,0)–(w,h), made of moves, lines and cubic curves only, so the same path draws the shape on screen
 * (SVG), in print and in a saved file (a DrawingML custom geometry) without any reader's own idea of
 * the shape coming between. Angles are in degrees, clockwise from three o'clock, as on screen.
 */

const KAPPA = 0.5522847498;
const rad = (deg) => (deg * Math.PI) / 180;
const round = (n) => Math.round(n * 1000) / 1000;

/** Cubic curves for an elliptical arc about (cx, cy) from angle a0 sweeping `sweep` degrees (either way), each piece at most 90°. */
export function arcCurves(cx, cy, rx, ry, a0, sweep) {
  const out = [];
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / 90 - 1e-9));
  const step = sweep / pieces;
  for (let i = 0; i < pieces; i++) {
    const s = rad(a0 + step * i), e = rad(a0 + step * (i + 1));
    const k = (4 / 3) * Math.tan((e - s) / 4);
    const [x0, y0] = [Math.cos(s), Math.sin(s)], [x1, y1] = [Math.cos(e), Math.sin(e)];
    out.push(['C', cx + rx * (x0 - k * y0), cy + ry * (y0 + k * x0), cx + rx * (x1 + k * y1), cy + ry * (y1 - k * x1), cx + rx * x1, cy + ry * y1]);
  }
  return out;
}

const polygon = (pts) => [['M', ...pts[0]], ...pts.slice(1).map((p) => ['L', ...p]), ['Z']];

function ellipse(w, h) {
  const rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA;
  return [['M', w, ry], ['C', w, ry + ky, rx + kx, h, rx, h], ['C', rx - kx, h, 0, ry + ky, 0, ry],
    ['C', 0, ry - ky, rx - kx, 0, rx, 0], ['C', rx + kx, 0, w, ry - ky, w, ry], ['Z']];
}

function roundRect(w, h, ratio = 0.12) {
  const r = Math.max(0, Math.min(ratio * Math.min(w, h), w / 2, h / 2));
  if (!r) return polygon([[0, 0], [w, 0], [w, h], [0, h]]);
  const k = r * (1 - KAPPA);
  return [['M', r, 0], ['L', w - r, 0], ['C', w - k, 0, w, k, w, r], ['L', w, h - r], ['C', w, h - k, w - k, h, w - r, h],
    ['L', r, h], ['C', k, h, 0, h - k, 0, h - r], ['L', 0, r], ['C', 0, k, k, 0, r, 0], ['Z']];
}

/** A ring's piece (inner radius `inner` × the outer one) between two angles, about the box's centre. */
function sector(w, h, a0, a1, inner = 0) {
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2, sweep = a1 - a0;
  const start = [cx + rx * Math.cos(rad(a0)), cy + ry * Math.sin(rad(a0))];
  if (!inner) return [['M', cx, cy], ['L', ...start], ...arcCurves(cx, cy, rx, ry, a0, sweep), ['Z']];
  const ix = rx * inner, iy = ry * inner;
  return [['M', ...start], ...arcCurves(cx, cy, rx, ry, a0, sweep),
    ['L', cx + ix * Math.cos(rad(a1)), cy + iy * Math.sin(rad(a1))], ...arcCurves(cx, cy, ix, iy, a1, -sweep), ['Z']];
}

/** A curved arrow along a ring: the band between `inner` and the outer radius from a0 to a1, its head at a1 (the sweep's way). */
function arcArrow(w, h, a0, a1, inner = 0.75) {
  const cx = w / 2, cy = h / 2, R = w / 2, r = R * inner, mid = (R + r) / 2, band = R - r;
  const dir = Math.sign(a1 - a0) || 1;
  // The head takes an arc as long as the band is wide, never more than half the sweep.
  const headDeg = Math.min(Math.abs(a1 - a0) / 2, ((band * 1.25) / mid) * (180 / Math.PI)) * dir;
  const body = a1 - headDeg, spread = band * 0.45;
  const at = (radius, a) => [cx + radius * Math.cos(rad(a)), cy + radius * Math.sin(rad(a))];
  return [['M', ...at(R, a0)], ...arcCurves(cx, cy, R, R, a0, body - a0), ['L', ...at(R + spread, body)], ['L', ...at(mid, a1)],
    ['L', ...at(r - spread, body)], ['L', ...at(r, body)], ...arcCurves(cx, cy, r, r, body, a0 - body), ['Z']];
}

/** The path of a shape `kind` in a w × h box, `adj` its proportions where it has any. */
export function shapePath(kind, w, h, adj = {}) {
  switch (kind) {
    case 'rect': return polygon([[0, 0], [w, 0], [w, h], [0, h]]);
    case 'roundRect': return roundRect(w, h, adj.r ?? 0.12);
    case 'ellipse': return ellipse(w, h);
    case 'diamond': return polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'hexagon': { const a = Math.min(w * 0.25, h * 0.5); return polygon([[a, 0], [w - a, 0], [w, h / 2], [w - a, h], [a, h], [0, h / 2]]); }
    case 'octagon': { const a = Math.min(w, h) * 0.29; return polygon([[a, 0], [w - a, 0], [w, a], [w, h - a], [w - a, h], [a, h], [0, h - a], [0, a]]); }
    case 'triangle': return polygon([[w / 2, 0], [w, h], [0, h]]);
    case 'invTriangle': return polygon([[0, 0], [w, 0], [w / 2, h]]);
    // Narrower at the top (`inset` is how far each top corner sits in from the box's side).
    case 'trapezoid': { const a = Math.min(w / 2, adj.inset ?? w * 0.2); return polygon([[a, 0], [w - a, 0], [w, h], [0, h]]); }
    case 'invTrapezoid': { const a = Math.min(w / 2, adj.inset ?? w * 0.2); return polygon([[0, 0], [w, 0], [w - a, h], [a, h]]); }
    case 'chevron': { const d = Math.min(adj.depth ?? h * 0.5, w * 0.45); return polygon([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]); }
    case 'homePlate': { const d = Math.min(adj.depth ?? h * 0.5, w * 0.45); return polygon([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h]]); }
    case 'downChevron': { const d = Math.min(adj.depth ?? w * 0.3, h * 0.45); return polygon([[0, 0], [w / 2, d], [w, 0], [w, h - d], [w / 2, h], [0, h - d]]); }
    case 'rightArrow': { const hl = Math.min(w * 0.45, h * 0.6), s = (h * (1 - (adj.shaft ?? 0.5))) / 2; return polygon([[0, s], [w - hl, s], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h - s], [0, h - s]]); }
    case 'leftArrow': { const hl = Math.min(w * 0.45, h * 0.6), s = (h * (1 - (adj.shaft ?? 0.5))) / 2; return polygon([[w, s], [hl, s], [hl, 0], [0, h / 2], [hl, h], [hl, h - s], [w, h - s]]); }
    case 'downArrow': { const hl = Math.min(h * 0.45, w * 0.6), s = (w * (1 - (adj.shaft ?? 0.5))) / 2; return polygon([[s, 0], [w - s, 0], [w - s, h - hl], [w, h - hl], [w / 2, h], [0, h - hl], [s, h - hl]]); }
    case 'upArrow': { const hl = Math.min(h * 0.45, w * 0.6), s = (w * (1 - (adj.shaft ?? 0.5))) / 2; return polygon([[s, h], [w - s, h], [w - s, hl], [w, hl], [w / 2, 0], [0, hl], [s, hl]]); }
    case 'leftRightArrow': {
      const hl = Math.min(w * 0.3, h * 0.6), s = (h * (1 - (adj.shaft ?? 0.5))) / 2;
      return polygon([[0, h / 2], [hl, 0], [hl, s], [w - hl, s], [w - hl, 0], [w, h / 2], [w - hl, h], [w - hl, h - s], [hl, h - s], [hl, h]]);
    }
    case 'upDownArrow': {
      const hl = Math.min(h * 0.3, w * 0.6), s = (w * (1 - (adj.shaft ?? 0.5))) / 2;
      return polygon([[w / 2, 0], [w, hl], [w - s, hl], [w - s, h - hl], [w, h - hl], [w / 2, h], [0, h - hl], [s, h - hl], [s, hl], [0, hl]]);
    }
    case 'plus': {
      const t = Math.min(w, h) * 0.3, x0 = (w - t) / 2, y0 = (h - t) / 2;
      return polygon([[x0, 0], [x0 + t, 0], [x0 + t, y0], [w, y0], [w, y0 + t], [x0 + t, y0 + t], [x0 + t, h], [x0, h], [x0, y0 + t], [0, y0 + t], [0, y0], [x0, y0]]);
    }
    case 'equal': {
      const t = h * 0.3, g = h * 0.16, y0 = (h - 2 * t - g) / 2;
      return [...polygon([[0, y0], [w, y0], [w, y0 + t], [0, y0 + t]]), ...polygon([[0, y0 + t + g], [w, y0 + t + g], [w, h - y0], [0, h - y0]])];
    }
    case 'sector': return sector(w, h, adj.a0 ?? 0, adj.a1 ?? 90, adj.inner ?? 0);
    case 'arcArrow': return arcArrow(w, h, adj.a0 ?? 0, adj.a1 ?? 90, adj.inner ?? 0.75);
    default: return polygon([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}

/** The kinds that point one way along the row, which Right to Left turns about. */
export const DIRECTED = new Set(['chevron', 'homePlate', 'rightArrow', 'leftArrow']);
/** Shapes a diagram's shape can be changed to (Format ▸ Change Shape), in the menu's order. */
export const CHANGEABLE_SHAPES = [
  ['rect', 'Rectangle'], ['roundRect', 'Rounded Rectangle'], ['ellipse', 'Oval'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'],
  ['octagon', 'Octagon'], ['triangle', 'Triangle'], ['trapezoid', 'Trapezoid'], ['chevron', 'Chevron'], ['homePlate', 'Pentagon Arrow'],
  ['rightArrow', 'Right Arrow'], ['downArrow', 'Down Arrow'],
];

/** The path as SVG path data, offset to (x, y). */
export function pathData(commands, x = 0, y = 0) {
  return commands.map(([op, ...n]) => op + n.map((v, i) => round(v + (i % 2 ? y : x))).join(' ')).join('');
}

/** The polyline of a connector, with the points of an arrowhead at its end when it has one. */
export function connectorHead(points, size) {
  if (points.length < 2) return null;
  const [x1, y1] = points.at(-2), [x2, y2] = points.at(-1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!len) return null;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len, back = Math.min(size, len * 0.6), half = back * 0.55;
  const bx = x2 - ux * back, by = y2 - uy * back;
  return [[x2, y2], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
}
