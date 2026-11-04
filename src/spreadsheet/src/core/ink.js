/**
 * Ink: strokes drawn with the Draw tab's pens, pencil and highlighter. Each stroke becomes a sheet picture that
 * carries a DrawingML freeform (`a:custGeom` with an `a:ln` in the pen's colour and width, the highlighter's with
 * alpha), so it moves, resizes and undoes as pictures do and opens in Excel as a freeform shape.
 * Everything here is pure geometry: points are sheet pixels at 100% zoom.
 */

import { t } from '../i18n/index.js';

export const EMU = 9525; // per pixel
export const MM_PX = 96 / 25.4;
export const MM_EMU = 36000;
export const PEN_KINDS = ['pen', 'pencil', 'highlighter'];
export const PEN_WIDTHS = [0.25, 0.5, 1, 2, 3.5];
export const HIGHLIGHTER_WIDTHS = [2, 4, 6, 8, 10];
/** The colours offered, each with its name (a catalog key; colorName gives it in the interface language). */
export const PEN_COLORS = [
  ['#000000', 'coreInk.color.black'], ['#ffffff', 'coreInk.color.white'], ['#e71224', 'coreInk.color.red'], ['#ffc114', 'coreInk.color.yellow'], ['#16a34a', 'coreInk.color.green'], ['#0063b1', 'coreInk.color.blue'],
  ['#8b2fc9', 'coreInk.color.purple'], ['#ff6600', 'coreInk.color.orange'], ['#6b7280', 'coreInk.color.gray'], ['#7f1d1d', 'coreInk.color.darkRed'], ['#004e8c', 'coreInk.color.darkBlue'], ['#00a0a0', 'coreInk.color.teal'],
  ['#e3008c', 'coreInk.color.pink'], ['#8b5a2b', 'coreInk.color.brown'], ['#9acd32', 'coreInk.color.lime'], ['#5b3a8c', 'coreInk.color.darkPurple'], ['#c0c0c0', 'coreInk.color.silver'], ['#1f2937', 'coreInk.color.charcoal'],
];
export const HIGHLIGHTER_COLORS = [
  ['#ffff00', 'coreInk.color.yellow'], ['#00ff00', 'coreInk.color.brightGreen'], ['#00ffff', 'coreInk.color.turquoise'], ['#ff00ff', 'coreInk.color.pink'], ['#0000ff', 'coreInk.color.blue'], ['#ff0000', 'coreInk.color.red'],
  ['#000080', 'coreInk.color.darkBlue'], ['#008080', 'coreInk.color.teal'], ['#008000', 'coreInk.color.green'], ['#800080', 'coreInk.color.violet'], ['#800000', 'coreInk.color.darkRed'], ['#808000', 'coreInk.color.darkYellow'],
  ['#ff8000', 'coreInk.color.orange'], ['#80c0ff', 'coreInk.color.lightBlue'], ['#c0c0c0', 'coreInk.color.lightGray'], ['#808080', 'coreInk.color.gray'], ['#ffc0cb', 'coreInk.color.lightPink'], ['#000000', 'coreInk.color.black'],
];
export const DEFAULT_PENS = [
  { id: 'pen-1', kind: 'pen', color: '#000000', width: 0.5 },
  { id: 'pen-2', kind: 'pen', color: '#e71224', width: 0.5 },
  { id: 'pen-3', kind: 'pencil', color: '#6b7280', width: 1 },
  { id: 'pen-4', kind: 'highlighter', color: '#ffff00', width: 6 },
];
export const MAX_PENS = 12;
const HEX = /^#[0-9a-f]{6}$/i;

/** A pen colour's name in the interface language, or its hex code when it has none. */
export const colorName = (hex, kind = 'pen') => {
  const named = (kind === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS).find(([h]) => h === hex)?.[1]
    || PEN_COLORS.concat(HIGHLIGHTER_COLORS).find(([h]) => h === hex)?.[1];
  return named ? t(named) : hex.toUpperCase();
};
export const widthLabel = (mm) => t('coreInk.width', { mm });
/** "Pen: Red, 0.5 mm", as the pen is announced and its tooltip reads. */
export const penLabel = (pen) => t('coreInk.penLabel', { kind: pen.kind, color: colorName(pen.color, pen.kind), width: widthLabel(pen.width) });

/** A pen read back from storage, or null. */
export function normalizePen(raw) {
  if (!raw || typeof raw !== 'object' || !PEN_KINDS.includes(raw.kind) || !HEX.test(raw.color || '')) return null;
  const widths = raw.kind === 'highlighter' ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
  const width = Number(raw.width);
  return { id: typeof raw.id === 'string' && /^pen-\d{1,4}$/.test(raw.id) ? raw.id : null, kind: raw.kind, color: raw.color.toLowerCase(),
    width: widths.includes(width) ? width : widths[raw.kind === 'highlighter' ? 2 : 1] };
}

/** How a pen paints: its width in pixels, its opacity, and its line ends. */
export function penStyle(pen) {
  const highlighter = pen.kind === 'highlighter';
  return { widthPx: pen.width * MM_PX, opacity: highlighter ? 0.5 : pen.kind === 'pencil' ? 0.85 : 1, cap: highlighter ? 'sq' : 'rnd' };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Douglas–Peucker: the fewest points within `tol` of the drawn line, first and last kept. */
export function simplify(points, tol = 0.4) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = points[a], B = points[b], len = dist(A, B);
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const P = points[i];
      const d = len ? Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / len : dist(A, P);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Points closer than `min` to the last one kept are dropped (a resting pen reports the same place many times). */
export function dedupe(points, min = 0.6) {
  const out = [];
  for (const p of points) if (!out.length || dist(out.at(-1), p) >= min) out.push(p);
  if (points.length > 1 && out.length === 1) out.push(points.at(-1));
  return out;
}

/** A smooth path through the points: Catmull–Rom spans as cubic Béziers. Commands are ['M', x, y], ['C', ...6], ['L', x, y]. */
export function smoothCommands(pts) {
  if (!pts.length) return [];
  const cmds = [['M', pts[0].x, pts[0].y]];
  if (pts.length === 1) { cmds.push(['L', pts[0].x + 0.5, pts[0].y]); return cmds; }
  if (pts.length === 2) { cmds.push(['L', pts[1].x, pts[1].y]); return cmds; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    cmds.push(['C', p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y]);
  }
  return cmds;
}

/** The outline of a stroke whose width follows the pen's pressure: a closed polygon around the centre line. */
export function pressureOutline(pts, widthAt) {
  if (pts.length < 2) {
    const p = pts[0], r = widthAt(0) / 2;
    return Array.from({ length: 12 }, (_, i) => ({ x: p.x + r * Math.cos(i * Math.PI / 6), y: p.y + r * Math.sin(i * Math.PI / 6) }));
  }
  const left = [], right = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const r = widthAt(i) / 2;
    left.push({ x: pts[i].x - ty * r, y: pts[i].y + tx * r });
    right.push({ x: pts[i].x + ty * r, y: pts[i].y - tx * r });
  }
  // Round ends: half circles from one side to the other.
  const cap = (p, from, r, steps = 6) => {
    const start = Math.atan2(from.y - p.y, from.x - p.x);
    return Array.from({ length: steps - 1 }, (_, k) => {
      const angle = start - (Math.PI * (k + 1)) / steps;
      return { x: p.x + r * Math.cos(angle), y: p.y + r * Math.sin(angle) };
    });
  };
  return [...left, ...cap(pts[n - 1], left[n - 1], widthAt(n - 1) / 2), ...right.reverse(), ...cap(pts[0], right.at(-1), widthAt(0) / 2)];
}

const node = (name, attrs = {}, children = []) => ({ name, attrs, children });
const emu = (n) => Math.round(n * EMU);
const colorNode = (hex, opacity) => node('srgbClr', { val: hex.slice(1).toUpperCase() }, opacity < 1 ? [node('alpha', { val: Math.round(opacity * 100000) })] : []);
const custGeom = (paths) => node('custGeom', {}, [node('avLst'), node('gdLst'), node('ahLst'), node('cxnLst'), node('rect', { l: 'l', t: 't', r: 'r', b: 'b' }), node('pathLst', {}, paths)]);
const pathNode = (cmds, w, h, attrs = {}) => node('path', { w: emu(w), h: emu(h), ...attrs }, cmds.map(([k, ...a]) => {
  const pts = [];
  for (let i = 0; i < a.length; i += 2) pts.push(node('pt', { x: emu(a[i]), y: emu(a[i + 1]) }));
  return k === 'M' ? node('moveTo', {}, pts) : k === 'L' ? node('lnTo', {}, pts) : k === 'C' ? node('cubicBezTo', {}, pts) : node('close');
}));
const svgPath = (cmds) => cmds.map(([k, ...a]) => k + a.map(n => round(n)).join(' ')).join('');

function finish({ svgBody, w, h, spPr }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(w)} ${round(h)}" width="${round(w)}" height="${round(h)}" preserveAspectRatio="none">${svgBody}</svg>`;
  const shape = node('sp', {}, [node('spPr', {}, [node('xfrm', {}, [node('off', { x: 0, y: 0 }), node('ext', { cx: emu(w), cy: emu(h) })]), ...spPr])]);
  return { svg, nativeDrawing: { node: shape, viewport: [0, 0, emu(w), emu(h)] } };
}

const PENCIL_FILTER = '<defs><filter id="grain" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="3" result="n"/>'
  + '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1.45" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter></defs>';

/**
 * A finished stroke as a sheet object: `points` are [{ x, y, pressure? }] in sheet pixels. Returns the box it
 * occupies ({ x, y, w, h } in sheet pixels), the picture's SVG and the native freeform.
 */
export function buildStroke(points, pen, { pressure = false } = {}) {
  const style = penStyle(pen);
  const raw = dedupe(points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  if (!raw.length) return null;
  const varying = pressure && pen.kind !== 'highlighter' && raw.some(p => Math.abs((p.pressure ?? 0.5) - (raw[0].pressure ?? 0.5)) > 0.05);
  const pts = varying ? raw : simplify(raw, 0.35);
  const widthAt = i => style.widthPx * Math.min(1.6, Math.max(0.35, (pts[i].pressure ?? 0.5) * 1.6));
  const maxW = varying ? Math.max(...pts.map((_, i) => widthAt(i))) : style.widthPx;
  const pad = maxW / 2 + 1;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0, h = Math.max(...ys) + pad - y0;
  const local = pts.map(p => ({ ...p, x: p.x - x0, y: p.y - y0 }));
  const color = colorNode(pen.color, style.opacity);
  const opacity = style.opacity < 1 ? ` fill-opacity="${style.opacity}" stroke-opacity="${style.opacity}"` : '';
  const filter = pen.kind === 'pencil' ? ' filter="url(#grain)"' : '';
  let built;
  if (varying) {
    const outline = pressureOutline(local, widthAt);
    const cmds = [['M', outline[0].x, outline[0].y], ...outline.slice(1).map(p => ['L', p.x, p.y]), ['Z']];
    built = finish({ w, h,
      svgBody: `${filter ? PENCIL_FILTER : ''}<path d="${svgPath(cmds)}" fill="${pen.color}"${opacity}${filter}/>`,
      spPr: [custGeom([pathNode(cmds, w, h, { stroke: 0 })]), node('solidFill', {}, [color]), node('ln', {}, [node('noFill')])] });
  } else {
    const cmds = smoothCommands(local);
    const cap = style.cap === 'sq' ? 'square' : 'round';
    built = finish({ w, h,
      svgBody: `${filter ? PENCIL_FILTER : ''}<path d="${svgPath(cmds)}" fill="none" stroke="${pen.color}" stroke-width="${round(style.widthPx)}" stroke-linecap="${cap}" stroke-linejoin="round"${opacity}${filter}/>`,
      spPr: [custGeom([pathNode(cmds, w, h, { fill: 'none' })]), node('noFill'),
        node('ln', { w: Math.round(pen.width * MM_EMU), cap: style.cap }, [node('solidFill', {}, [color]), node('round')])] });
  }
  return { box: { x: x0, y: y0, w, h }, ...built };
}

/* ---------- Ink to Shape ---------- */

const area = (poly) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
const perimeter = (poly, closed = true) => poly.reduce((s, p, i) => (i + 1 < poly.length ? s + dist(p, poly[i + 1]) : closed ? s + dist(p, poly[0]) : s), 0);

export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function largestTriangle(hull) {
  const step = Math.max(1, Math.ceil(hull.length / 40));
  const h = hull.filter((_, i) => i % step === 0);
  let best = null, most = -1;
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) for (let k = j + 1; k < h.length; k++) {
    const a = area([h[i], h[j], h[k]]);
    if (a > most) { most = a; best = [h[i], h[j], h[k]]; }
  }
  return { points: best, area: most };
}

/**
 * Ink to Shape: what a roughly drawn stroke was meant to be. A nearly straight open stroke is a line; a closed one is a
 * triangle, rectangle or ellipse by how much of its bounding box and of its largest inscribed triangle it fills.
 * Returns null for anything else (writing, scribbles), which stays ink.
 */
export function recognizeShape(points) {
  const pts = dedupe(points, 1);
  if (pts.length < 4) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const diag = Math.hypot(box.w, box.h);
  if (diag < 16) return null;
  const length = perimeter(pts, false), first = pts[0], last = pts.at(-1), chord = dist(first, last);
  if (chord > 0.8 * length) {
    const worst = Math.max(...pts.map(p => Math.abs((last.x - first.x) * (first.y - p.y) - (first.x - p.x) * (last.y - first.y)) / chord));
    return worst <= Math.max(3, 0.07 * chord) ? { kind: 'line', points: [first, last] } : null;
  }
  if (chord > Math.max(14, 0.3 * diag)) return null;
  const hull = convexHull(pts), hullArea = area(hull);
  if (!(hullArea > 0) || length > 1.5 * perimeter(hull) || Math.min(box.w, box.h) < 8) return null;
  const tri = largestTriangle(hull);
  if (tri.area / hullArea > 0.84) return { kind: 'triangle', points: tri.points };
  const fill = hullArea / (box.w * box.h);
  if (fill > 0.86) return { kind: 'rect', box };
  if (fill > 0.66 && fill <= 0.86) return { kind: 'ellipse', box };
  return null;
}

/** The names a recognised shape is given on the sheet (stored in the file, as Excel names them). */
export const SHAPE_NAMES = { line: 'Straight Connector', rect: 'Rectangle', ellipse: 'Oval', triangle: 'Freeform: Shape' };

/** A recognised shape drawn cleanly in the pen's colour and width, as a native shape (no fill, the pen's outline). */
export function buildShape(shape, pen) {
  const style = penStyle(pen), lw = style.widthPx, pad = lw / 2 + 1;
  const pts = shape.points || [{ x: shape.box.x, y: shape.box.y }, { x: shape.box.x + shape.box.w, y: shape.box.y + shape.box.h }];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0, h = Math.max(...ys) + pad - y0;
  const local = pts.map(p => ({ x: p.x - x0, y: p.y - y0 }));
  const color = colorNode(pen.color, style.opacity);
  const ln = node('ln', { w: Math.round(pen.width * MM_EMU), cap: shape.kind === 'line' ? 'rnd' : 'flat' }, [node('solidFill', {}, [color]), node('round')]);
  const stroke = `fill="none" stroke="${pen.color}" stroke-width="${round(lw)}" stroke-linejoin="round" stroke-linecap="round"${style.opacity < 1 ? ` stroke-opacity="${style.opacity}"` : ''}`;
  let geometry, svgBody;
  if (shape.kind === 'rect' || shape.kind === 'ellipse') {
    // The native frame is the whole box (the outline is centred on its edge); the picture insets it to stay inside.
    geometry = node('prstGeom', { prst: shape.kind }, [node('avLst')]);
    svgBody = shape.kind === 'rect'
      ? `<rect x="${round(pad)}" y="${round(pad)}" width="${round(w - 2 * pad)}" height="${round(h - 2 * pad)}" ${stroke}/>`
      : `<ellipse cx="${round(w / 2)}" cy="${round(h / 2)}" rx="${round(w / 2 - pad)}" ry="${round(h / 2 - pad)}" ${stroke}/>`;
  } else {
    const cmds = [['M', local[0].x, local[0].y], ...local.slice(1).map(p => ['L', p.x, p.y]), ...(shape.kind === 'triangle' ? [['Z']] : [])];
    geometry = custGeom([pathNode(cmds, w, h, shape.kind === 'line' ? { fill: 'none' } : {})]);
    svgBody = `<path d="${svgPath(cmds)}" ${stroke}/>`;
  }
  return { box: { x: x0, y: y0, w, h }, ...finish({ w, h, svgBody, spPr: [geometry, node('noFill'), ln] }) };
}

/* ---------- Reading ink back: the drawn lines of an ink object, for the eraser and lasso ---------- */

const child = (n, name) => n?.children?.find(c => c.name === name);
const num = (n, k, d = 0) => (Number.isFinite(Number(n?.attrs?.[k])) ? Number(n.attrs[k]) : d);

/** Is this sheet object ink (a stroke drawn with a pen) rather than a shape or picture? */
export function isInk(obj) {
  if (obj?.type !== 'image' || !obj.drawingShape || !/^Ink(\s|$)/.test(obj.title || '')) return false;
  let n = obj.nativeDrawing?.node;
  while (n?.name === 'grpSp' && n.children.filter(c => ['sp', 'grpSp'].includes(c.name)).length === 1) n = n.children.find(c => ['sp', 'grpSp'].includes(c.name));
  return n?.name === 'sp' && !!child(child(n, 'spPr'), 'custGeom');
}

/**
 * The lines of an ink object in its own box, in sheet pixels from its top-left corner at its current size:
 * [{ points: [{x, y}], closed, half }] where `half` is half the line's width.
 */
export function inkLines(obj) {
  const drawing = obj?.nativeDrawing;
  if (!drawing?.node || !Array.isArray(drawing.viewport)) return [];
  const [vx, vy, vw, vh] = drawing.viewport;
  if (!(vw > 0 && vh > 0)) return [];
  const sx = obj.w / vw, sy = obj.h / vh;
  const out = [];
  const walk = (n, map, depth = 0) => {
    if (depth > 8) return;
    if (n.name === 'grpSp') {
      const xfrm = child(child(n, 'grpSpPr'), 'xfrm');
      const off = child(xfrm, 'off'), ext = child(xfrm, 'ext'), co = child(xfrm, 'chOff'), ce = child(xfrm, 'chExt');
      const kx = num(ce, 'cx') ? num(ext, 'cx') / num(ce, 'cx') : 1, ky = num(ce, 'cy') ? num(ext, 'cy') / num(ce, 'cy') : 1;
      const inner = (x, y) => map(num(off, 'x') + (x - num(co, 'x')) * kx, num(off, 'y') + (y - num(co, 'y')) * ky);
      for (const c of n.children) if (['sp', 'grpSp'].includes(c.name)) walk(c, inner, depth + 1);
      return;
    }
    if (n.name !== 'sp') return;
    const props = child(n, 'spPr'), xfrm = child(props, 'xfrm');
    const off = child(xfrm, 'off'), ext = child(xfrm, 'ext');
    const line = child(props, 'ln'), stroked = line && !child(line, 'noFill');
    const half = stroked ? num(line, 'w', 9525) / EMU / 2 : 0.5;
    for (const path of child(child(props, 'custGeom'), 'pathLst')?.children || []) {
      const pw = num(path, 'w', num(ext, 'cx')) || 1, ph = num(path, 'h', num(ext, 'cy')) || 1;
      const at = pt => map(num(off, 'x') + num(pt, 'x') * num(ext, 'cx') / pw, num(off, 'y') + num(pt, 'y') * num(ext, 'cy') / ph);
      let points = [];
      const flush = (closed) => { if (points.length) out.push({ points, closed, half }); points = []; };
      for (const seg of path.children) {
        if (seg.name === 'moveTo') { flush(false); points.push(at(seg.children[0])); }
        else if (seg.name === 'lnTo' || seg.name === 'cubicBezTo' || seg.name === 'quadBezTo') points.push(at(seg.children.at(-1)));
        else if (seg.name === 'close') flush(true);
      }
      flush(false);
    }
  };
  walk(drawing.node, (x, y) => [x, y]);
  const rot = ((obj.rotation || 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot), cx = obj.w / 2, cy = obj.h / 2;
  return out.map(line => ({ ...line, points: line.points.map(([x, y]) => {
    let px = (x - vx) * sx, py = (y - vy) * sy;
    if (obj.flipH) px = obj.w - px;
    if (obj.flipV) py = obj.h - py;
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }) }));
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const along = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - along * dx, p.y - a.y - along * dy);
}
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Does the eraser, at `p` with radius `radius`, touch any of these lines (all in the same coordinates)? */
export function touchesLines(lines, p, radius) {
  for (const { points, closed, half } of lines) {
    if (closed && points.length > 2 && pointInPolygon(p, points)) return true;
    if (points.length === 1 && dist(points[0], p) <= radius + half) return true;
    for (let i = 0; i + 1 < points.length; i++) if (segmentDistance(p, points[i], points[i + 1]) <= radius + half) return true;
  }
  return false;
}

/** Points spaced at most `step` apart along a drag, so a fast eraser sweep misses nothing between two pointer events. */
export function sweep(a, b, step = 3) {
  const n = Math.max(1, Math.ceil(dist(a, b) / step));
  return Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));
}

/** Lasso: is most of this object's ink inside the drawn loop? */
export function insideLasso(lines, lasso, share = 0.6) {
  const pts = lines.flatMap(l => l.points);
  if (!pts.length || lasso.length < 3) return false;
  return pts.filter(p => pointInPolygon(p, lasso)).length / pts.length >= share;
}

/** The next free number for a name ("Ink 3"), counting the sheet's objects already so named. */
export function nextName(objects, base) {
  let n = 0;
  for (const o of objects || []) {
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`).exec(o.title || '');
    if (m) n = Math.max(n, +m[1]);
  }
  return `${base} ${n + 1}`;
}
