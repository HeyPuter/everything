/**
 * Plot (print) layout math shared by the SVG, PDF and raster exporters.
 *
 * Paper coordinates are millimetres. `transform` maps world coordinates to
 * paper millimetres with the origin at the bottom-left corner and y up (the
 * PDF convention); `transformDown` maps to paper millimetres with the origin
 * at the top-left corner and y down (SVG and canvas). Both are affine
 * matrices [a, b, c, d, e, f]: X = a*x + c*y + e, Y = b*x + d*y + f.
 */
import { UNIT_MM, DEFAULT_LINEWEIGHT } from '../../core/schema.js';

/** Standard paper sizes in millimetres, portrait (w <= h). */
export const PAPER_SIZES = [
  { id: 'A0', label: 'ISO A0', w: 841, h: 1189 },
  { id: 'A1', label: 'ISO A1', w: 594, h: 841 },
  { id: 'A2', label: 'ISO A2', w: 420, h: 594 },
  { id: 'A3', label: 'ISO A3', w: 297, h: 420 },
  { id: 'A4', label: 'ISO A4', w: 210, h: 297 },
  { id: 'ANSI-A', label: 'ANSI A (Letter)', w: 215.9, h: 279.4 },
  { id: 'ANSI-B', label: 'ANSI B', w: 279.4, h: 431.8 },
  { id: 'ANSI-C', label: 'ANSI C', w: 431.8, h: 558.8 },
  { id: 'ANSI-D', label: 'ANSI D', w: 558.8, h: 863.6 },
  { id: 'ANSI-E', label: 'ANSI E', w: 863.6, h: 1117.6 },
  { id: 'ARCH-A', label: 'Arch A', w: 228.6, h: 304.8 },
  { id: 'ARCH-B', label: 'Arch B', w: 304.8, h: 457.2 },
  { id: 'ARCH-C', label: 'Arch C', w: 457.2, h: 609.6 },
  { id: 'ARCH-D', label: 'Arch D', w: 609.6, h: 914.4 },
  { id: 'ARCH-E', label: 'Arch E', w: 914.4, h: 1219.2 },
  { id: 'LEGAL', label: 'Legal', w: 215.9, h: 355.6 },
  { id: 'TABLOID', label: 'Tabloid', w: 279.4, h: 431.8 },
];

const PAPER_ALIASES = { LETTER: 'ANSI-A', LEDGER: 'TABLOID' };

/** Thinnest printable line in millimetres (used for lineweight 0). */
export const THIN_MM = 0.05;

/** Uniform width in millimetres used when lineweights are turned off. */
export const UNIFORM_MM = 0.1;

/** Millimetres per PDF point. */
export const MM_PER_PT = 25.4 / 72;

/** Find a paper size by id (case-insensitive, 'Letter' and 'Ledger' accepted). */
export function findPaper(id) {
  if (!id) return null;
  let key = String(id).toUpperCase().replace(/[\s_]+/g, '-');
  key = PAPER_ALIASES[key] ?? key;
  return PAPER_SIZES.find((p) => p.id === key) ?? null;
}

/**
 * Lineweight in hundredths of a millimetre to millimetres.
 * Negative or missing values use the default lineweight (0.25 mm); 0 is the
 * thinnest printable line (never scaled). Options: ignore (uniform thin
 * lines of `uniform` mm), scale (multiplier for nonzero lineweights).
 */
export function lineweightMm(lw, opts = {}) {
  if (opts.ignore) return opts.uniform ?? UNIFORM_MM;
  if (lw === 0) return THIN_MM;
  const mm = lw == null || !(lw > 0) ? DEFAULT_LINEWEIGHT / 100 : lw / 100;
  return Math.max(mm * (opts.scale ?? 1), THIN_MM);
}

/** Lineweight options for lineweightMm taken from exporter settings. */
export function lineweightOptions(settings = {}) {
  return {
    ignore: settings.lineweights === false,
    scale: settings.lineweightScale ?? 1,
    uniform: settings.uniformWidth,
  };
}

/** Normalize margins (number or {top, right, bottom, left}) in millimetres. */
function marginsOf(m) {
  if (m == null) m = 10;
  if (typeof m === 'number') return { top: m, right: m, bottom: m, left: m };
  return { top: m.top ?? 10, right: m.right ?? 10, bottom: m.bottom ?? 10, left: m.left ?? 10 };
}

/** Number with up to 4 significant digits, no exponent for normal plot scales. */
function sig(v) {
  return String(Number(v.toPrecision(4)));
}

/** Scale text 'p:d' (paper mm : drawing units) for a scale of s mm per unit. */
export function scaleText(s) {
  if (!(s > 0) || !Number.isFinite(s)) return '';
  return s <= 1 ? `1:${sig(1 / s)}` : `${sig(s)}:1`;
}

/**
 * The largest standard scale (1, 2 or 5 times a power of ten) at which a plot
 * of `s` paper mm per drawing unit (for example the fit scale) still fits.
 * Returns { paper, drawing }: `paper` mm on paper = `drawing` drawing units.
 */
export function standardScale(s, units) {
  const unitMm = UNIT_MM[units] ?? 1;
  if (!(s > 0) || !Number.isFinite(s)) return { paper: 1, drawing: 1 };
  const r = unitMm / s; // drawing size : paper size, both in mm
  let ratio = 1;
  for (let k = Math.floor(Math.log10(r)) - 1; ; k++) {
    const m = [1, 2, 5].find((n) => (k < 0 ? n / 10 ** -k : n * 10 ** k) >= r * (1 - 1e-9));
    if (m) {
      ratio = k < 0 ? m / 10 ** -k : m * 10 ** k;
      break;
    }
  }
  let paper = unitMm;
  let drawing = ratio;
  // Reduce to small whole numbers where possible: 1 mm = 100 units, 10 mm = 1 unit (m).
  const g = Math.min(paper, drawing);
  const whole = (v) => Math.abs(v - Math.round(v)) < 1e-9;
  if (drawing < 1 || (whole(paper / g) && whole(drawing / g))) {
    paper /= g;
    drawing /= g;
  }
  return { paper: +paper.toPrecision(6), drawing: +drawing.toPrecision(6) };
}

/** Page size in millimetres for the settings, orientation applied. */
export function pageSize(settings = {}) {
  let w, h;
  const p = settings.custom ?? (typeof settings.paper === 'object' ? settings.paper : null);
  if (p && p.w > 0 && p.h > 0) {
    w = p.w;
    h = p.h;
  } else {
    const ps = findPaper(settings.paper) ?? findPaper('A4');
    w = ps.w;
    h = ps.h;
  }
  const o = settings.orientation;
  if ((o === 'landscape' && w < h) || (o === 'portrait' && w > h)) [w, h] = [h, w];
  return { w, h };
}

/**
 * Resolve the plot scale in paper millimetres per drawing unit.
 *   'fit'                  fit the area into the printable rectangle
 *   { paper, drawing }     `paper` mm on paper = `drawing` drawing units
 *   { ratio } or a number  true scale 1:ratio; drawing units are converted
 *                          to millimetres with UNIT_MM[units]
 */
function resolveScale(scale, units, aw, ah, pw, ph) {
  if (scale && typeof scale === 'object' && scale.paper > 0 && scale.drawing > 0) {
    return scale.paper / scale.drawing;
  }
  const ratio = typeof scale === 'number' ? scale : scale?.ratio;
  if (ratio > 0) return (UNIT_MM[units] ?? 1) / ratio;
  const sx = aw > 0 ? pw / aw : Infinity;
  const sy = ah > 0 ? ph / ah : Infinity;
  const s = Math.min(sx, sy);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function intersect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Flip a y-up rectangle on a page of height pageH into y-down coordinates. */
export function rectDown(r, pageH) {
  return { x: r.x, y: pageH - r.y - r.h, w: r.w, h: r.h };
}

/**
 * Compute the plot layout.
 * settings: { paper | custom {w, h}, orientation, area [x0, y0, x1, y1],
 *   scale, units, margins, center (default true), offset {x, y} mm }
 * drawingBounds is used when settings.area is missing.
 */
export function computePlot(settings = {}, drawingBounds = null) {
  const { w: pageW, h: pageH } = pageSize(settings);
  const m = marginsOf(settings.margins);
  const printable = {
    x: m.left,
    y: m.bottom,
    w: Math.max(0, pageW - m.left - m.right),
    h: Math.max(0, pageH - m.top - m.bottom),
  };
  const src = settings.area ?? drawingBounds ?? [0, 0, 1, 1];
  const area = [
    Math.min(src[0], src[2]),
    Math.min(src[1], src[3]),
    Math.max(src[0], src[2]),
    Math.max(src[1], src[3]),
  ];
  const aw = area[2] - area[0];
  const ah = area[3] - area[1];
  const s = resolveScale(settings.scale ?? 'fit', settings.units, aw, ah, printable.w, printable.h);
  const center = settings.center !== false;
  const off = settings.offset ?? { x: 0, y: 0 };
  let e, f;
  if (center) {
    e = printable.x + printable.w / 2 - s * (area[0] + aw / 2);
    f = printable.y + printable.h / 2 - s * (area[1] + ah / 2);
  } else {
    e = printable.x - s * area[0];
    f = printable.y - s * area[1];
  }
  e += off.x ?? 0;
  f += off.y ?? 0;
  const mapped = { x: s * area[0] + e, y: s * area[1] + f, w: s * aw, h: s * ah };
  // A degenerate area (a single point or line) must not clip everything away.
  const clip = aw > 0 && ah > 0 ? intersect(printable, mapped) : { ...printable };
  return {
    pageW,
    pageH,
    printable,
    area,
    scale: s,
    // The true scale: paper mm to real mm (s is paper mm per drawing unit).
    scaleText: scaleText(s / (UNIT_MM[settings.units] ?? 1)),
    transform: [s, 0, 0, s, e, f],
    transformDown: [s, 0, 0, -s, e, pageH - f],
    clip,
    clipDown: rectDown(clip, pageH),
  };
}

/**
 * Fit a world rectangle into a width x height viewport (any units) with a
 * margin, centered, y down. Returns { transform, scale }.
 */
export function fitToSize(bounds, width, height, margin = 0) {
  const b = bounds ?? [0, 0, 1, 1];
  const aw = b[2] - b[0];
  const ah = b[3] - b[1];
  const pw = Math.max(1e-9, width - 2 * margin);
  const ph = Math.max(1e-9, height - 2 * margin);
  let s = Math.min(aw > 0 ? pw / aw : Infinity, ah > 0 ? ph / ah : Infinity);
  if (!Number.isFinite(s) || s <= 0) s = 1;
  const e = width / 2 - s * (b[0] + aw / 2);
  const f = height / 2 + s * (b[1] + ah / 2);
  return { transform: [s, 0, 0, -s, e, f], scale: s };
}

/**
 * Convert a linetype pattern (drawing units: positive dash, negative gap,
 * 0 dot) into an on/off dash array in output units (k output units per
 * drawing unit). Returns { array, offset, hasDot } or null for a solid line.
 * The array always starts with a dash and has an even length; `offset` is
 * the dash phase that makes the pattern start where the original starts.
 */
export function dashArray(pattern, k = 1, minTotal = 0) {
  if (!pattern || !pattern.length) return null;
  const runs = [];
  for (const v of pattern) {
    const on = v >= 0;
    const len = Math.abs(v) * k;
    const last = runs[runs.length - 1];
    if (last && last.on === on) last.len += len;
    else runs.push({ on, len });
  }
  let offset = 0;
  if (runs.length > 1 && runs[0].on === runs[runs.length - 1].on) {
    const last = runs.pop();
    runs[0].len += last.len;
    offset = last.len;
  }
  if (runs.length < 2) return null;
  let total = 0;
  for (const r of runs) total += r.len;
  if (!(total > 0) || total < minTotal) return null;
  if (!runs[0].on) {
    const first = runs.shift();
    runs.push(first);
    offset = (offset - first.len + total) % total;
  }
  let hasDot = false;
  const array = new Array(runs.length);
  for (let i = 0; i < runs.length; i++) {
    array[i] = runs[i].len;
    if (runs[i].on && runs[i].len === 0) hasDot = true;
  }
  return { array, offset, hasDot };
}

/** Parse a background option ('#rrggbb', [r, g, b] or null) to RGB or null. */
export function parseBackground(bg) {
  if (bg == null || bg === false || bg === 'none' || bg === 'transparent') return null;
  if (Array.isArray(bg)) return bg;
  if (typeof bg === 'string' && /^#[0-9a-f]{6}$/i.test(bg)) {
    const n = parseInt(bg.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (bg === 'white') return [255, 255, 255];
  if (bg === 'black') return [0, 0, 0];
  return null;
}

/** True when an RGB color is dark (luma below the midpoint). */
export function isDark(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128;
}

/**
 * Output color for a display-list style. Monochrome prints everything in
 * the ink color: black on white (or no) paper, white on a dark background.
 * Index 7 prints in the ink color too.
 */
export function plotColor(style, settings = {}, bgRgb = parseBackground(settings.background)) {
  const ink = bgRgb && isDark(bgRgb) ? [255, 255, 255] : [0, 0, 0];
  if (settings.monochrome || style?.aci7) return ink;
  return style?.rgb ?? [0, 0, 0];
}
