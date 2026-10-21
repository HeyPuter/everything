/**
 * Appearance streams for comment annotations: text boxes and callouts, rectangles, ellipses,
 * lines and arrows, polygons and clouds, polylines, pencil drawings, carets, squiggly
 * underlines and stamps. Every drawing is generated from the annotation dictionary alone, so
 * the same code serves new comments, edits, comments imported from XFDF, and comments from
 * other writers whose appearance has to be redrawn after a change.
 *
 * Drawings use the page's own coordinates: the form's BBox is the annotation's Rect and its
 * Matrix is the identity, as for the text markups in highlight.js. Flattening and every reader
 * then place it exactly over the rectangle.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { embedFont } from './document.js';
import { ensureMarkupAppearance } from './highlight.js';
import { ensureNoteAppearance } from './notes.js';
import { smoothStroke } from './signature.js';
import { parseContent } from './text-edit.js';
import { pageUserUnit } from './structure.js';

export const name = PDFName.of;
/** Content-stream numbers: three decimals, never exponents, never -0. */
export const fmt = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};
const round = (value) => Math.round(value * 1e4) / 1e4;
export const numbers = (array) =>
  array instanceof PDFArray ? array.asArray().map((_, i) => array.lookup(i)?.asNumber?.()) : null;
export const text = (dict, key) => {
  const value = dict.lookup(name(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
};

/** Annotation flags (ISO 32000-1, Table 165). */
export const FLAGS = {
  invisible: 1,
  hidden: 2,
  print: 4,
  nozoom: 8,
  norotate: 16,
  noview: 32,
  readonly: 64,
  locked: 128,
  togglenoview: 256,
  lockedcontents: 512,
};

export function hexToRgb(hex, what = 'color') {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex))) throw new Error(`Choose a valid ${what}.`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
/** A color option that may be switched off: null, '' and 'none' mean no color. */
export const optionalRgb = (hex, what) =>
  hex === null || hex === undefined || hex === '' || hex === 'none' || hex === 'transparent'
    ? null
    : hexToRgb(hex, what);
export function rgbToHex(rgb) {
  if (!rgb) return null;
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(Math.max(0, Math.min(1, c)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
/** Gray, RGB and CMYK color arrays as RGB; an empty array is "no color". */
export function colorOf(dict, key) {
  const c = numbers(dict.lookup(name(key)));
  if (!c || !c.every(Number.isFinite)) return null;
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return c;
  if (c.length === 4) return c.slice(0, 3).map((v) => 1 - Math.min(1, v + c[3]));
  return null;
}
/** PDF dates look like D:20260914120000Z. */
export function pdfDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
/** randomUUID exists only in secure contexts; plain-http deployments still need unique names. */
export function annotationName() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** [x0 y0 x1 y1] with the corners in order, or null. */
export function rectOf(dict, key = 'Rect') {
  const r = numbers(dict.lookup(name(key)));
  if (r?.length !== 4 || !r.every(Number.isFinite)) return null;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}
/** The drawn box inside Rect: Rect less its RD margins (left, bottom, right, top). */
export function innerBox(dict) {
  const rect = rectOf(dict);
  if (!rect) return null;
  const rd = numbers(dict.lookup(name('RD')));
  const [l, b, r, t] =
    rd?.length === 4 && rd.every((v) => Number.isFinite(v) && v >= 0) ? rd : [0, 0, 0, 0];
  const box = [rect[0] + l, rect[1] + b, rect[2] - r, rect[3] - t];
  return box[2] > box[0] && box[3] > box[1] ? box : rect;
}
/** Flat number arrays as point lists. */
export const pointsOf = (flat) => {
  const points = [];
  for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) points.push({ x: flat[i], y: flat[i + 1] });
  return points;
};
export const flatPoints = (points) => points.flatMap((p) => [round(p.x), round(p.y)]);
export function inkStrokes(dict) {
  const list = dict.lookup(name('InkList'));
  if (!(list instanceof PDFArray)) return [];
  return list
    .asArray()
    .map((_, i) => pointsOf(numbers(list.lookup(i)) || []))
    .filter((stroke) => stroke.length && stroke.every((p) => Number.isFinite(p.x + p.y)));
}

/** Border width and dash pattern from BS, or from the older Border array. */
export function borderOf(dict) {
  const bs = dict.lookup(name('BS'));
  if (bs instanceof PDFDict) {
    const w = bs.lookup(name('W'))?.asNumber?.();
    const dashed = bs.lookup(name('S')) === name('D');
    const pattern = numbers(bs.lookup(name('D')));
    return {
      width: Number.isFinite(w) && w >= 0 ? w : 1,
      dash: dashed ? (pattern?.length && pattern.every((v) => v >= 0) ? pattern : [3]) : null,
    };
  }
  const border = numbers(dict.lookup(name('Border')));
  if (border?.length >= 3 && Number.isFinite(border[2]) && border[2] >= 0) {
    const pattern = border.length > 3 ? numbers(dict.lookup(name('Border')).lookup(3)) : null;
    return { width: border[2], dash: pattern?.length ? pattern : null };
  }
  return { width: 1, dash: null };
}
export function setBorder(doc, dict, width, dash) {
  dict.set(
    name('BS'),
    doc.context.obj({
      Type: 'Border',
      W: round(width),
      S: dash?.length ? 'D' : 'S',
      ...(dash?.length && { D: dash }),
    }),
  );
  dict.delete(name('Border'));
}
export function opacityOf(dict) {
  const ca = dict.lookup(name('CA'))?.asNumber?.();
  return Number.isFinite(ca) && ca >= 0 && ca <= 1 ? ca : 1;
}
/** The cloudy border intensity, or null for a plain border. */
export function cloudOf(dict) {
  const be = dict.lookup(name('BE'));
  if (!(be instanceof PDFDict) || be.lookup(name('S')) !== name('C')) return null;
  const i = be.lookup(name('I'))?.asNumber?.();
  return Number.isFinite(i) ? Math.max(0, Math.min(2, i)) : 0;
}
/** Line ending names, start and end; FreeText keeps a single name for the callout's start. */
export function endingsOf(dict) {
  const le = dict.lookup(name('LE'));
  if (le instanceof PDFName) return [le.decodeText(), 'None'];
  if (!(le instanceof PDFArray)) return ['None', 'None'];
  return [0, 1].map((i) => {
    const value = le.lookup(i);
    return value instanceof PDFName ? value.decodeText() : 'None';
  });
}

/** Font size, text color and border color from a default appearance string. */
export function parseDA(da) {
  const result = { font: null, fontSize: null, color: null, borderColor: null };
  try {
    for (const { op, args } of parseContent(String(da || ''))) {
      if (op === 'Tf' && args[0]?.type === 'name' && args[1]?.type === 'number') {
        result.font = args[0].value;
        if (Number.isFinite(args[1].value) && args[1].value > 0) result.fontSize = args[1].value;
      }
      const fill = { g: 1, rg: 3, k: 4 }[op],
        stroke = { G: 1, RG: 3, K: 4 }[op];
      const count = fill || stroke;
      if (!count || args.length !== count || !args.every((a) => a.type === 'number')) continue;
      const v = args.map((a) => Math.max(0, Math.min(1, a.value)));
      const rgb =
        count === 1
          ? [v[0], v[0], v[0]]
          : count === 4
            ? v.slice(0, 3).map((c) => 1 - Math.min(1, c + v[3]))
            : v;
      if (fill) result.color = rgb;
      else result.borderColor = rgb;
    }
  } catch {
    // A malformed default appearance still yields black 12 point text.
  }
  return result;
}
const colorOps = (rgb, stroke) => `${rgb.map(fmt).join(' ')} ${stroke ? 'RG' : 'rg'}`;

/** The style of a text box as its dictionary records it. */
export function freeTextStyle(dict) {
  const da = parseDA(text(dict, 'DA'));
  const ds = text(dict, 'DS');
  const dsColor = /color\s*:\s*(#[0-9a-f]{6})/i.exec(ds)?.[1];
  const dsSize = /(\d+(?:\.\d+)?)\s*pt/i.exec(ds)?.[1];
  const q = dict.lookup(name('Q'))?.asNumber?.();
  const { width, dash } = borderOf(dict);
  return {
    fontSize: da.fontSize ?? (dsSize ? Number(dsSize) : 12),
    color: da.color ?? (dsColor ? hexToRgb(dsColor) : [0, 0, 0]),
    borderColor: da.borderColor,
    fill: colorOf(dict, 'C'),
    width: da.borderColor ? width : 0,
    dash,
    align: q === 1 || q === 2 ? q : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Path geometry

const KAPPA = 0.5522847498;
function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA,
    ky = ry * KAPPA;
  return [
    `${fmt(cx + rx)} ${fmt(cy)} m`,
    `${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    `${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)} c`,
    'h',
  ].join('\n');
}
function polyPath(points, closed) {
  return (
    points.map((p, i) => `${fmt(p.x)} ${fmt(p.y)} ${i ? 'l' : 'm'}`).join('\n') +
    (closed ? '\nh' : '')
  );
}
/** Cubic segments of a circular arc, each at most a quarter turn, continuing the current point. */
function arcCurves(cx, cy, r, from, sweep) {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const delta = sweep / steps,
    k = (4 / 3) * Math.tan(delta / 4);
  const ops = [];
  for (let i = 0; i < steps; i++) {
    const a = from + i * delta,
      b = a + delta;
    const [ax, ay, bx, by] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    ops.push(
      [
        cx + r * (ax - k * ay),
        cy + r * (ay + k * ax),
        cx + r * (bx + k * by),
        cy + r * (by - k * bx),
        cx + r * bx,
        cy + r * by,
      ]
        .map(fmt)
        .join(' ') + ' c',
    );
  }
  return ops;
}
/** Scallop chord length for a cloud intensity (BE /I 0–2), in points as page units. */
const cloudChord = (intensity, unit = 1) => (6 + 6 * intensity) / unit;
const SCALLOP = (100 * Math.PI) / 180; // half the arc of each scallop: overlapping bulges
/**
 * A cloudy border around a closed polygon: each edge is split into chords of about the same
 * length, and each chord becomes an arc a little larger than a half circle bulging outwards,
 * which is how Acrobat draws BE /S /C borders. Returns the path and the points that bound it.
 */
function cloudPath(vertices, intensity, unit = 1) {
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  const points = area < 0 ? [...vertices].reverse() : vertices;
  const chord = cloudChord(intensity, unit);
  const ops = [],
    reach = [...vertices];
  const turns = (angle) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length < 1e-6) continue;
    const pieces = Math.max(1, Math.round(length / chord));
    // Counterclockwise outline: the outside lies to the right of each edge.
    const nx = (q.y - p.y) / length,
      ny = -(q.x - p.x) / length;
    const half = length / pieces / 2,
      r = half / Math.sin(SCALLOP);
    // The center sits just outside the edge, so the larger arc is the one outside.
    const offset = -r * Math.cos(SCALLOP);
    for (let j = 0; j < pieces; j++) {
      const a = {
        x: p.x + ((q.x - p.x) * j) / pieces,
        y: p.y + ((q.y - p.y) * j) / pieces,
      };
      const b = {
        x: p.x + ((q.x - p.x) * (j + 1)) / pieces,
        y: p.y + ((q.y - p.y) * (j + 1)) / pieces,
      };
      const cx = (a.x + b.x) / 2 + nx * offset,
        cy = (a.y + b.y) / 2 + ny * offset;
      const start = Math.atan2(a.y - cy, a.x - cx),
        end = Math.atan2(b.y - cy, b.x - cx);
      // Of the two arcs from a to b, take the one of 2 * SCALLOP.
      const gap = turns(start + 2 * SCALLOP - end);
      const sweep = gap < 1e-6 || 2 * Math.PI - gap < 1e-6 ? 2 * SCALLOP : -2 * SCALLOP;
      if (!ops.length) ops.push(`${fmt(a.x)} ${fmt(a.y)} m`);
      ops.push(...arcCurves(cx, cy, r, start, sweep));
      reach.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
    }
  }
  return ops.length
    ? { path: ops.join('\n') + '\nh', reach }
    : { path: polyPath(vertices, true), reach };
}
function ellipseVertices([x0, y0, x1, y1], count = 24) {
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    rx = (x1 - x0) / 2,
    ry = (y1 - y0) / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: cx + rx * Math.cos((2 * Math.PI * i) / count),
    y: cy + ry * Math.sin((2 * Math.PI * i) / count),
  }));
}

/**
 * The size of a line ending drawn with a stroke `width`, at least six points however large the
 * page's units (`unit` points each).
 */
export const endingSize = (width, unit = 1) => Math.max(6 / unit, width * 3 + 4 / unit);
/**
 * One line ending (ISO 32000-1, Table 176) at `tip`, for a line arriving from `from`: its path,
 * whether it is a closed shape that takes the interior color, and the points it reaches.
 */
function lineEnding(style, tip, from, width, unit = 1) {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y) || 1;
  const ux = (tip.x - from.x) / length,
    uy = (tip.y - from.y) / length;
  const nx = -uy,
    ny = ux;
  const size = endingSize(width, unit),
    half = size / 2;
  const at = (along, across) => ({
    x: tip.x + ux * along + nx * across,
    y: tip.y + uy * along + ny * across,
  });
  switch (style) {
    case 'OpenArrow':
    case 'ClosedArrow': {
      const points = [at(-size, half), tip, at(-size, -half)];
      return {
        path: polyPath(points, style === 'ClosedArrow'),
        closed: style === 'ClosedArrow',
        points,
      };
    }
    case 'ROpenArrow':
    case 'RClosedArrow': {
      const points = [at(0, half), at(-size, 0), at(0, -half)];
      return {
        path: polyPath(points, style === 'RClosedArrow'),
        closed: style === 'RClosedArrow',
        points,
      };
    }
    case 'Butt': {
      const points = [at(0, half), at(0, -half)];
      return { path: polyPath(points, false), closed: false, points };
    }
    case 'Slash': {
      // A stroke across the line, turned 30 degrees from the perpendicular.
      const c = Math.cos(Math.PI / 6) * half,
        s = Math.sin(Math.PI / 6) * half;
      const points = [at(s, c), at(-s, -c)];
      return { path: polyPath(points, false), closed: false, points };
    }
    case 'Square': {
      const q = size * 0.3;
      const points = [at(-q, -q), at(q, -q), at(q, q), at(-q, q)];
      return { path: polyPath(points, true), closed: true, points };
    }
    case 'Diamond': {
      const q = size * 0.4;
      const points = [at(-q, 0), at(0, -q), at(q, 0), at(0, q)];
      return { path: polyPath(points, true), closed: true, points };
    }
    case 'Circle': {
      const r = size * 0.3;
      return {
        path: ellipsePath(tip.x, tip.y, r, r),
        closed: true,
        points: [at(-r, -r), at(r, r), at(-r, r), at(r, -r)],
      };
    }
    default:
      return null;
  }
}
/** A stroked open path with optional endings at both ends; returns operators and points. */
function openPathWithEndings(points, [startStyle, endStyle], width, interior, unit = 1) {
  const ops = [polyPath(points, false), 'S'];
  const reach = [...points];
  const ends = [
    [startStyle, points[0], points[1]],
    [endStyle, points.at(-1), points.at(-2)],
  ];
  for (const [style, tip, from] of ends) {
    const ending = from && lineEnding(style, tip, from, width, unit);
    if (!ending) continue;
    reach.push(...ending.points);
    ops.push(ending.path, ending.closed ? (interior ? 'B' : 's') : 'S');
  }
  return { ops, reach };
}

export function boundsOf(points, pad = 0) {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ].map(round);
}

// ---------------------------------------------------------------------------------------------
// Appearance streams

/** Install a normal appearance whose BBox is `rect`, and make `rect` the annotation's Rect. */
function install(doc, dict, rect, ops, { opacity = opacityOf(dict), fonts, blend } = {}) {
  const resources = {};
  if (opacity < 1 || blend)
    resources.ExtGState = {
      GS: {
        Type: 'ExtGState',
        ca: opacity,
        CA: opacity,
        ...(blend && { BM: blend }),
      },
    };
  if (fonts) resources.Font = fonts;
  const content = ['q', ...(resources.ExtGState ? ['/GS gs'] : []), ...ops, 'Q'].join('\n');
  const stream = doc.context.flateStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: rect,
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: resources,
  });
  dict.set(name('Rect'), doc.context.obj(rect));
  dict.set(name('AP'), doc.context.obj({ N: doc.context.register(stream) }));
}
/** An empty appearance, for hidden replies and review states. */
export function installEmpty(doc, dict) {
  const rect = rectOf(dict) || [0, 0, 20, 20];
  install(doc, dict, rect, [], { opacity: 1 });
}
const strokeSetup = (color, width, dash) => [
  colorOps(color, true),
  `${fmt(width)} w`,
  ...(dash?.length ? [`[${dash.map(fmt).join(' ')}] 0 d`] : []),
];
/** The painting operator for a closed path with an optional fill and stroke. */
const paint = (fill, stroke) => (fill && stroke ? 'B' : fill ? 'f' : stroke ? 's' : 'n');

/** Square and Circle: the shape inside `box`, plain or cloudy. RD keeps the box inside Rect. */
function drawBoxShape(doc, dict, box, unit = 1) {
  const subtype = dict.lookup(name('Subtype')).decodeText();
  const color = colorOf(dict, 'C'),
    fill = colorOf(dict, 'IC');
  const { width, dash } = borderOf(dict);
  const cloud = cloudOf(dict);
  const stroke = color && width > 0;
  const ops = [
    ...(stroke ? strokeSetup(color, width, cloud === null ? dash : null) : []),
    ...(fill ? [colorOps(fill, false)] : []),
  ];
  let rect;
  if (cloud !== null) {
    const vertices =
      subtype === 'Circle'
        ? ellipseVertices(box)
        : [
            { x: box[0], y: box[1] },
            { x: box[2], y: box[1] },
            { x: box[2], y: box[3] },
            { x: box[0], y: box[3] },
          ];
    const { path, reach } = cloudPath(vertices, cloud, unit);
    rect = boundsOf(reach, width / 2 + 1 / unit);
    ops.push('1 j', path, paint(fill, stroke));
  } else {
    rect = box.map(round);
    const inset = stroke ? width / 2 : 0;
    const [x0, y0, x1, y1] = [box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset];
    if (x1 <= x0 || y1 <= y0) throw new Error('The shape is too small for its border.');
    ops.push(
      subtype === 'Circle'
        ? ellipsePath((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2)
        : `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re`,
      paint(fill, stroke),
    );
  }
  const margin = [box[0] - rect[0], box[1] - rect[1], rect[2] - box[2], rect[3] - box[3]];
  if (margin.some((v) => v > 1e-6)) dict.set(name('RD'), doc.context.obj(margin.map(round)));
  else dict.delete(name('RD'));
  install(doc, dict, rect, ops);
}

/** Line, Polygon and PolyLine from their own points. */
function drawPolyShape(doc, dict, unit = 1) {
  const subtype = dict.lookup(name('Subtype')).decodeText();
  const color = colorOf(dict, 'C') ?? [0, 0, 0],
    fill = colorOf(dict, 'IC');
  const { width, dash } = borderOf(dict);
  const points =
    subtype === 'Line'
      ? pointsOf(numbers(dict.lookup(name('L'))))
      : pointsOf(numbers(dict.lookup(name('Vertices'))));
  if (!points.length || !points.every((p) => Number.isFinite(p.x + p.y)))
    throw new Error('This shape has no points to draw.');
  if (subtype === 'Line' && points.length !== 2) throw new Error('A line needs two points.');
  const stroke = width > 0;
  const ops = ['1 j', ...(stroke ? strokeSetup(color, width, null) : [])];
  if (subtype === 'Polygon') {
    const cloud = cloudOf(dict);
    if (fill) ops.push(colorOps(fill, false));
    if (dash?.length && cloud === null) ops.push(`[${dash.map(fmt).join(' ')}] 0 d`);
    const cloudy = cloud === null ? null : cloudPath(points, cloud, unit);
    ops.push(cloudy ? cloudy.path : polyPath(points, true), paint(fill, stroke));
    install(doc, dict, boundsOf(cloudy ? cloudy.reach : points, width / 2 + 1 / unit), ops);
    return;
  }
  // Lines and polylines: the dash applies to the line itself, not to its endings.
  if (fill) ops.push(colorOps(fill, false));
  const endings = endingsOf(dict);
  const drawn = openPathWithEndings(points, endings, width, fill, unit);
  if (dash?.length)
    ops.push(`[${dash.map(fmt).join(' ')}] 0 d`, drawn.ops[0], drawn.ops[1], '[] 0 d');
  else ops.push(drawn.ops[0], drawn.ops[1]);
  ops.push(...drawn.ops.slice(2));
  install(doc, dict, boundsOf(drawn.reach, width + 1 / unit), ops);
}

/** Pencil strokes, smoothed through their sampled points with round caps and joins. */
function drawInk(doc, dict) {
  const strokes = inkStrokes(dict);
  if (!strokes.length) throw new Error('This drawing has no strokes.');
  const color = colorOf(dict, 'C') ?? [0, 0, 0];
  const { width } = borderOf(dict);
  const ops = ['1 J', '1 j', ...strokeSetup(color, Math.max(width, 0.1), null)];
  const reach = [];
  for (const stroke of strokes) {
    const { start, curves } = smoothStroke(stroke.map((p) => [p.x, p.y]));
    ops.push(`${fmt(start[0])} ${fmt(start[1])} m`);
    reach.push({ x: start[0], y: start[1] });
    // A single tap is a dot: a zero-length segment, which round caps draw as a disc.
    if (!curves.length) ops.push(`${fmt(start[0])} ${fmt(start[1])} l`);
    for (const c of curves) {
      ops.push(`${c.map(fmt).join(' ')} c`);
      // A cubic stays inside the hull of its control points.
      reach.push({ x: c[0], y: c[1] }, { x: c[2], y: c[3] }, { x: c[4], y: c[5] });
    }
    ops.push('S');
  }
  install(doc, dict, boundsOf(reach, width / 2 + 1), ops);
}

/** A caret: a filled wedge pointing up into the text where something is to be inserted. */
function drawCaret(doc, dict) {
  const box = innerBox(dict);
  if (!box) throw new Error('This insertion mark has no position.');
  const color = colorOf(dict, 'C') ?? [0, 0, 1];
  const [x0, y0, x1, y1] = box,
    mx = (x0 + x1) / 2;
  const w = x1 - x0,
    h = y1 - y0;
  install(doc, dict, rectOf(dict), [
    colorOps(color, false),
    `${fmt(x0)} ${fmt(y0)} m`,
    `${fmt(mx - w * 0.1)} ${fmt(y0 + h * 0.15)} ${fmt(mx)} ${fmt(y1 - h * 0.3)} ${fmt(mx)} ${fmt(y1)} c`,
    `${fmt(mx)} ${fmt(y1 - h * 0.3)} ${fmt(mx + w * 0.1)} ${fmt(y0 + h * 0.15)} ${fmt(x1)} ${fmt(y0)} c`,
    'h f',
  ]);
}

/** A squiggly underline: a zigzag along the foot of each quad. */
function drawSquiggly(doc, dict) {
  const flat = numbers(dict.lookup(name('QuadPoints')));
  if (!flat?.length || flat.length % 8 || !flat.every(Number.isFinite))
    throw new Error('Select text or an area to mark.');
  const color = colorOf(dict, 'C') ?? [1, 0, 0];
  const ops = ['1 j', ...strokeSetup(color, 1, null)];
  const reach = [];
  for (let i = 0; i < flat.length; i += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = flat.slice(i, i + 8);
    // Quads list the top edge first; the foot is the other pair, in either order.
    const foot = [
      { x: x3, y: y3 },
      { x: x4, y: y4 },
    ].sort((a, b) => a.x - b.x);
    const height = Math.hypot(x1 - x3, y1 - y3) || 10;
    const amplitude = Math.max(1, height * 0.08),
      step = amplitude * 2;
    const length = Math.hypot(foot[1].x - foot[0].x, foot[1].y - foot[0].y);
    if (!length) continue;
    const ux = (foot[1].x - foot[0].x) / length,
      uy = (foot[1].y - foot[0].y) / length;
    const zig = [];
    for (let d = 0, k = 0; d <= length; d += step, k++) {
      const up = k % 2 ? amplitude : 0;
      zig.push({
        x: foot[0].x + ux * d - uy * up,
        y: foot[0].y + uy * d + ux * up,
      });
    }
    reach.push(...zig, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }, { x: x4, y: y4 });
    ops.push(polyPath(zig, false), 'S');
  }
  if (!reach.length) throw new Error('The selection has no area.');
  install(doc, dict, boundsOf(reach, 1), ops);
}

const helveticaFonts = new WeakMap();
const helvetica = (doc, bold = false) => {
  let fonts = helveticaFonts.get(doc);
  if (!fonts) helveticaFonts.set(doc, (fonts = {}));
  const key = bold ? 'bold' : 'regular';
  return (fonts[key] ??= doc.embedStandardFont(
    bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica,
  ));
};
/** Helvetica when every character has a WinAnsi code, else the bundled Noto Sans face. */
export async function textFont(doc, value) {
  const font = helvetica(doc);
  try {
    font.encodeText(value.replace(/\r\n?|\n/g, ''));
    return { font, key: 'Helv', family: 'Helvetica,sans-serif' };
  } catch {
    return {
      font: await embedFont(doc, 'regular', value),
      key: 'NotoSans',
      family: "'Noto Sans',sans-serif",
    };
  }
}
/** Break text into lines no wider than `width`, keeping its own line breaks. */
export function wrapText(font, size, value, width) {
  const measure = (s) => font.widthOfTextAtSize(s, size);
  const lines = [];
  for (const paragraph of value.split(/\r\n?|\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      if (measure(word) <= width) {
        line = word;
        continue;
      }
      // A word longer than the box breaks between characters.
      for (const char of word) {
        if (line && measure(line + char) > width) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}
/** The matrix that turns a box's upright frame onto a page the reader turns by `rotation`. */
function uprightFrame([x0, y0, x1, y1], rotation) {
  const w = x1 - x0,
    h = y1 - y0;
  switch (rotation) {
    case 90:
      return { matrix: [0, 1, -1, 0, x1, y0], width: h, height: w };
    case 180:
      return { matrix: [-1, 0, 0, -1, x1, y1], width: w, height: h };
    case 270:
      return { matrix: [0, -1, 1, 0, x0, y1], width: h, height: w };
    default:
      return { matrix: [1, 0, 0, 1, x0, y0], width: w, height: h };
  }
}
const ALIGN = ['left', 'center', 'right'];
const escapeXml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c],
  );
/** Acrobat's rich-text body for plain text in one style (ISO 32000-1, 12.7.3.4). */
export function richText(value, { fontSize, color, align, family }) {
  const style = `font-size:${fmt(fontSize)}pt;text-align:${ALIGN[align]};color:${rgbToHex(color).toUpperCase()};font-weight:normal;font-style:normal;font-family:${family.replace(/'/g, '')};font-stretch:normal`;
  const paragraphs = value
    .split(/\r\n?|\n/)
    .map((line) => `<p dir="ltr">${line ? `<span>${escapeXml(line)}</span>` : ''}</p>`)
    .join('');
  return `<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="${style}">${paragraphs}</body>`;
}

/**
 * A text box or callout. The box is `box` (Rect less RD); a callout's leader line runs through
 * its CL points from the anchor to the box, with the LE ending at the anchor. The text wraps
 * inside the box and reads upright on a page turned by the annotation's Rotate.
 */
async function drawFreeText(doc, dict, box, style = freeTextStyle(dict), unit = 1) {
  const value = text(dict, 'Contents').replace(/\t/g, '    ');
  const rotation = [90, 180, 270].includes(dict.lookup(name('Rotate'))?.asNumber?.())
    ? dict.lookup(name('Rotate')).asNumber()
    : 0;
  const { font, key, family } = await textFont(doc, value);
  const { fontSize, color, borderColor, fill, width, dash, align } = style;
  const border = borderColor && width > 0;
  const lineColor = borderColor ?? color;
  const ops = [];
  // Leader line first, so the box covers its end.
  const callout = pointsOf(numbers(dict.lookup(name('CL'))));
  let reach = [
    { x: box[0], y: box[1] },
    { x: box[2], y: box[3] },
  ];
  if (callout.length >= 2 && callout.every((p) => Number.isFinite(p.x + p.y))) {
    const lineWidth = Math.max(width, 1 / unit);
    const [startStyle] = endingsOf(dict);
    const drawn = openPathWithEndings(callout, [startStyle, 'None'], lineWidth, fill, unit);
    ops.push('q', '1 j', ...strokeSetup(lineColor, lineWidth, null));
    if (fill) ops.push(colorOps(fill, false));
    ops.push(...drawn.ops, 'Q');
    reach = reach.concat(drawn.reach);
  }
  const [x0, y0, x1, y1] = box;
  if (fill)
    ops.push(
      colorOps(fill, false),
      `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re`,
      'f',
    );
  if (border) {
    const inset = width / 2;
    ops.push(
      'q',
      ...strokeSetup(borderColor, width, dash),
      `${fmt(x0 + inset)} ${fmt(y0 + inset)} ${fmt(x1 - x0 - width)} ${fmt(y1 - y0 - width)} re`,
      'S',
      'Q',
    );
  }
  const frame = uprightFrame(box, rotation);
  // Two points of space inside the frame, however large the page's units.
  const pad = (border ? width : 0) + 2 / unit;
  const inner = frame.width - 2 * pad;
  const lines = inner > 0 ? wrapText(font, fontSize, value, inner) : [];
  const leading = fontSize * 1.2,
    ascent = font.heightAtSize(fontSize, { descender: false });
  ops.push(
    'q',
    `${frame.matrix.map(fmt).join(' ')} cm`,
    `${fmt(pad)} ${fmt(pad)} ${fmt(Math.max(0, inner))} ${fmt(Math.max(0, frame.height - 2 * pad))} re`,
    'W n',
    'BT',
    `/${key} ${fmt(fontSize)} Tf`,
    colorOps(color, false),
  );
  lines.forEach((line, i) => {
    const lineWidth = font.widthOfTextAtSize(line, fontSize);
    const x =
      align === 1
        ? (frame.width - lineWidth) / 2
        : align === 2
          ? frame.width - pad - lineWidth
          : pad;
    const y = frame.height - pad - ascent - i * leading;
    if (line) ops.push(`1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`, `${font.encodeText(line).toString()} Tj`);
  });
  ops.push('ET', 'Q');
  const rect = boundsOf(reach, callout.length >= 2 ? Math.max(width, 1 / unit) + 1 / unit : 0);
  const margin = [box[0] - rect[0], box[1] - rect[1], rect[2] - box[2], rect[3] - box[3]];
  if (margin.some((v) => v > 1e-6)) dict.set(name('RD'), doc.context.obj(margin.map(round)));
  else dict.delete(name('RD'));
  // Keep the text's description in step with its drawing, for readers that rebuild it.
  const hex = rgbToHex(color).toUpperCase();
  dict.set(
    name('DA'),
    PDFString.of(
      `${borderColor ? colorOps(borderColor, true) + ' ' : ''}/${key} ${fmt(fontSize)} Tf ${colorOps(color, false)}`,
    ),
  );
  dict.set(
    name('DS'),
    PDFString.of(
      `font: ${family.replace(/'/g, '')} ${fmt(fontSize)}pt; text-align:${ALIGN[align]}; color:${hex}`,
    ),
  );
  dict.set(name('RC'), PDFHexString.fromText(richText(value, { fontSize, color, align, family })));
  if (align) dict.set(name('Q'), PDFNumber.of(align));
  else dict.delete(name('Q'));
  if (fill) dict.set(name('C'), doc.context.obj(fill.map(round)));
  else dict.delete(name('C'));
  setBorder(doc, dict, border ? width : 0, border ? dash : null);
  install(doc, dict, rect, ops, {
    fonts: doc.context.obj({ [key]: font.ref }),
  });
}

/** Stamp names such as SBApproved or NotForPublicRelease as the words they stand for. */
export function stampLabel(icon) {
  return (
    String(icon || 'Draft')
      .replace(/^#?(?:SB|SH|D)(?=[A-Z])/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toUpperCase() || 'DRAFT'
  );
}
/** A standard stamp drawn as its word in a rounded frame, for stamps that arrive without art. */
function drawStamp(doc, dict) {
  const rect = rectOf(dict);
  if (!rect) throw new Error('This stamp has no position.');
  const color = colorOf(dict, 'C') ?? [0.8, 0.1, 0.1];
  const font = helvetica(doc, true);
  const label = stampLabel(dict.lookup(name('Name'))?.decodeText?.());
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0,
    h = y1 - y0;
  const line = Math.max(1, Math.min(w, h) * 0.06);
  const size = Math.max(
    1,
    Math.min((h - 4 * line) * 0.7, (w - 6 * line) / Math.max(1, font.widthOfTextAtSize(label, 1))),
  );
  const textWidth = font.widthOfTextAtSize(label, size);
  install(
    doc,
    dict,
    rect,
    [
      colorOps(color, true),
      colorOps(color, false),
      `${fmt(line)} w`,
      `${fmt(x0 + line)} ${fmt(y0 + line)} ${fmt(w - 2 * line)} ${fmt(h - 2 * line)} re`,
      'S',
      'BT',
      `/Stamp ${fmt(size)} Tf`,
      `1 0 0 1 ${fmt(x0 + (w - textWidth) / 2)} ${fmt(y0 + (h - size * 0.7) / 2)} Tm`,
      `${font.encodeText(label).toString()} Tj`,
      'ET',
    ],
    { fonts: doc.context.obj({ Stamp: font.ref }) },
  );
}

/** A sticky note icon in the editor's style, whatever icon name or opacity the note carries. */
function drawNoteIcon(doc, page, dict) {
  const drawing = dict.clone(doc.context);
  for (const key of ['AP', 'Name', 'CA']) drawing.delete(name(key));
  if (!ensureNoteAppearance(doc, page, drawing)) throw new Error('This note cannot be drawn.');
  dict.set(name('AP'), drawing.get(name('AP')));
  dict.set(name('Rect'), drawing.get(name('Rect')));
}

/** Subtypes whose appearance this module can draw from the dictionary alone. */
export const DRAWABLE = new Set([
  'FreeText',
  'Square',
  'Circle',
  'Line',
  'Polygon',
  'PolyLine',
  'Ink',
  'FreeText',
  'Caret',
  'Squiggly',
  'Stamp',
  'Text',
  'Highlight',
  'Underline',
  'StrikeOut',
]);
/**
 * Redraw an annotation's normal appearance from its dictionary. `box` overrides the inner box
 * of rectangles, ellipses and text boxes (whose Rect also covers borders and leader lines);
 * `style` overrides a text box's style. Updates Rect (and RD) to cover the drawing. Everything
 * but text boxes, which may need a font loaded, is drawn synchronously by drawAppearance.
 */
export async function refreshAppearance(doc, page, dict, { box, style } = {}) {
  if (dict.lookup(name('Subtype')) === name('FreeText'))
    return drawFreeText(
      doc,
      dict,
      box ?? innerBox(dict),
      style ?? freeTextStyle(dict),
      page ? pageUserUnit(page) : 1,
    );
  return drawAppearance(doc, page, dict, { box });
}
export function drawAppearance(doc, page, dict, { box } = {}) {
  const subtype = dict.lookup(name('Subtype'))?.decodeText?.();
  // Sizes in points (arrowheads, scallops) stay so on pages whose units are larger.
  const unit = page ? pageUserUnit(page) : 1;
  switch (subtype) {
    case 'Square':
    case 'Circle':
      return drawBoxShape(doc, dict, box ?? innerBox(dict), unit);
    case 'Line':
    case 'Polygon':
    case 'PolyLine':
      return drawPolyShape(doc, dict, unit);
    case 'Ink':
      return drawInk(doc, dict);
    case 'Caret':
      return drawCaret(doc, dict);
    case 'Squiggly':
      return drawSquiggly(doc, dict);
    case 'Stamp':
      return drawStamp(doc, dict);
    case 'Text':
      if (dict.has(name('IRT'))) return installEmpty(doc, dict);
      return drawNoteIcon(doc, page, dict);
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
      dict.delete(name('AP'));
      if (!ensureMarkupAppearance(doc, dict)) throw new Error('Select text or an area to mark.');
      return;
    case 'FreeText':
      throw new Error('Text boxes are drawn with refreshAppearance.');
    default:
      throw new Error('This kind of comment cannot be redrawn.');
  }
}
