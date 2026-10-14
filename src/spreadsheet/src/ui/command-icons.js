/**
 * The app's command icons: neutral outlines in the current text colour with soft blue, green, red,
 * amber and purple accents, drawn on a 20-unit grid; strokes do
 * not scale, so a 32px ribbon command keeps 1px lines as a 16px one does. Colours come from the
 * --ico-* tokens (icons.css), so every theme can tune them.
 *
 * Classes: o outline, of outline on paper, s solid ink, and per accent x ∈ {b, g, r, y, n, p}:
 * x stroke only, xf soft fill with stroke, xs solid fill, xw soft fill without stroke.
 */

import { ICON_GLYPHS } from './icon-glyphs.js';

const p = (d, c = 'o') => `<path class="${c}" d="${d}"/>`;
/** Outlined rectangles (frames, sheets, tiles) get softly rounded corners unless `rx` says otherwise; fills laid inside a frame stay square. */
const ROUND = 1.6;
const rounds = (c) => /(^| )(o|of|[bgrynp]f)( |$)/.test(c) && !c.includes('dash');
const r = (x, y, w, h, c = 'o', rx = rounds(c) ? +Math.min(ROUND, w / 4, h / 4).toFixed(2) : 0) => `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''}/>`;
const ci = (cx, cy, rad, c = 'o') => `<circle class="${c}" cx="${cx}" cy="${cy}" r="${rad}"/>`;
/**
 * Lettering as outlines from the bundled fonts (icon-glyphs.js), never SVG text: text would be read
 * out as part of a button's or menu item's text, and would depend on the fonts installed.
 */
const t = (x, y, text, size, { weight = 400, italic = false, serif = false, anchor = 'middle', c = 'tx' } = {}) => {
  const font = ICON_GLYPHS[serif ? (italic ? 'serifItalic' : 'serif') : weight >= 600 ? 'sansBold' : 'sans'];
  const scale = size / 1000;
  const chars = [...text].map((ch) => font[ch]);
  if (chars.some((g) => !g)) throw new Error(`command-icons: no outline for "${text}"; run dev/generate-icon-glyphs.py`);
  const width = chars.reduce((sum, [adv]) => sum + adv, 0) * scale;
  const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  let at = 0;
  const parts = chars.map(([adv, d]) => { const part = `<path d="${d}" transform="translate(${at} 0)"/>`; at += adv; return part; });
  return `<g class="${c}" transform="translate(${+x0.toFixed(2)} ${y}) scale(${+scale.toFixed(5)})">${parts.join('')}</g>`;
};

/* ---- Shared pieces ---- */
/** A sheet of cells: a frame with `cols` × `rows` cells, optionally a soft header row. */
function cells(x, y, w, h, cols, rows, { head = null, frame = 'of' } = {}) {
  let out = r(x, y, w, h, frame);
  // The header row follows the frame's rounded top corners.
  const k = +Math.min(ROUND, w / 4, h / 4).toFixed(2);
  if (head) out += p(`M${x} ${y + h / rows}V${y + k}a${k} ${k} 0 0 1 ${k}-${k}H${x + w - k}a${k} ${k} 0 0 1 ${k} ${k}V${y + h / rows}z`, head);
  let d = '';
  for (let i = 1; i < cols; i++) d += `M${x + (w * i) / cols} ${y}v${h}`;
  for (let j = 1; j < rows; j++) d += `M${x} ${y + (h * j) / rows}h${w}`;
  return out + p(d, 'o ln');
}
const page = (x = 4.5, y = 2.5, w = 11, h = 15, fold = 3, k = 1.2) => p(`M${x + k} ${y}h${w - fold - k}l${fold} ${fold}v${h - fold - k}a${k} ${k} 0 0 1-${k} ${k}h-${w - 2 * k}a${k} ${k} 0 0 1-${k}-${k}v-${h - 2 * k}a${k} ${k} 0 0 1 ${k}-${k}z`, 'of') + (fold ? p(`M${x + w - fold} ${y}v${fold}h${fold}z`, 'bf') : '');
const lines = (x, y, w, n, gap = 2.5, c = 'o ln') => p(Array.from({ length: n }, (_, i) => `M${x} ${y + i * gap}h${w}`).join(''), c);
const arrowDown = (x, y, len, c = 'b') => p(`M${x} ${y}v${len}M${x - 2.5} ${y + len - 2.5}l2.5 2.5 2.5-2.5`, c);
const arrowRight = (x, y, len, c = 'b') => p(`M${x} ${y}h${len}M${x + len - 2.5} ${y - 2.5}l2.5 2.5-2.5 2.5`, c);
const brush = (dx = 0, dy = 0) => `<g transform="translate(${dx} ${dy})">${p('M17.5 8.5 13 13', 'o')}${p('M11.6 12.4l1.9 1.9-1.4 1.4-1.9-1.9z', 'bs')}${p('M10.2 13.8l1.9 1.9c-.8 1.8-2.6 2.6-4.6 2.3.6-1.7 1.4-3.2 2.7-4.2z', 'ys')}</g>`;
const lock = (x, y) => r(x - 1, y - 4.5, 10, 11.5, 'knock', 2.5) + p(`M${x + 1.5} ${y}v-2a2.5 2.5 0 0 1 5 0v2`, 'o thick') + r(x, y, 8, 6, 'ns', 1.4) + ci(x + 4, y + 3, 0.9, 'glint');
const magnifier = (cx, cy, rad, fill = 'bw') => ci(cx, cy, rad, fill) + ci(cx, cy, rad, 'o') + p(`M${cx + rad * 0.78} ${cy + rad * 0.78}l${rad * 0.85} ${rad * 0.85}`, 'o grip');
const funnel = (x, y, s = 1) => p(`M${x} ${y}h${10 * s}l-${3.8 * s} ${4.6 * s}v${4 * s}l-${2.4 * s} ${1.4 * s}v-${5.4 * s}z`, 'bf');
const az = (x, y, first = 'A', second = 'Z') => t(x, y, first, 6.5, { weight: 600, c: 'txb' }) + t(x, y + 7, second, 6.5, { weight: 600 });
/** Signs drawn in white on a badge: each a path about (x, y) with half-size `k`. */
const SIGNS = {
  plus: (x, y, k) => `M${x - k} ${y}h${2 * k}M${x} ${y - k}v${2 * k}`,
  minus: (x, y, k) => `M${x - k} ${y}h${2 * k}`,
  x: (x, y, k) => `M${x - k * 0.8} ${y - k * 0.8}l${k * 1.6} ${k * 1.6}M${x + k * 0.8} ${y - k * 0.8}l-${k * 1.6} ${k * 1.6}`,
  check: (x, y, k) => `M${x - k} ${y + 0.1}l${k * 0.7} ${k * 0.7} ${k * 1.3}-${k * 1.5}`,
};
/** A round solid badge carrying a white sign, cut out of the drawing under it by a ring of the surface colour. */
const badge = (cx, cy, sign, hue = 'g', rad = 3.4) => ci(cx, cy, rad + 0.9, 'knock') + ci(cx, cy, rad, `${hue}s`) + p(SIGNS[sign](cx, cy, rad * 0.48), 'wh thick');
const sheetPlus = badge(15, 15, 'plus');
const chartAxes = p('M3.5 3v13.5H17', 'o ln');
const borderIcon = (solid) => {
  const edges = { top: 'M3.5 3.5h13', bottom: 'M3.5 16.5h13', left: 'M3.5 3.5v13', right: 'M16.5 3.5v13', h: 'M3.5 10h13', v: 'M10 3.5v13' };
  const dashed = Object.keys(edges).filter((k) => !solid.includes(k)).map((k) => edges[k]).join('');
  return (dashed ? p(dashed, 'o dash ln') : '') + (solid.length ? p(solid.map((k) => edges[k]).join(''), 'b thick') : '');
};
/** A small printer, its top-left corner at (x, y): paper in, the body, paper out. */
const printerBadge = (x, y) => r(x + 2, y, 5, 2.5, 'of') + r(x, y + 2.5, 9, 4.5, 'of', 1) + r(x + 2, y + 5, 5, 3.5, 'of') + p(`M${x + 3.2} ${y + 6.8}h2.6`, 'o ln');
/** A table of three columns and four rows with `fills` laid under its lines. */
const tableShaded = (fills) => cells(2.5, 3.5, 15, 13, 3, 4) + fills + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' });
/** Chart marks are solid glass: a soft class (bf) is drawn as its solid (bs), with rounded ends. */
const solid = (c) => c.replace(/^([bgrynp])f$/, '$1s');
const columns = (bars, x0 = 5, w = 2.6, gap = 1.4, base = 16.5) => bars.map(([h, c], i) => r(x0 + i * (w + gap), base - h, w, h, solid(c), 0.7)).join('');

/* ---- The icons, keyed by the glyph names the ribbon, menus and toolbar use ---- */
export const COMMAND_ICONS = {
  /* Clipboard */
  paste: r(3, 3.5, 11, 14, 'nf', 2) + r(5.5, 2, 6, 3.2, 'of', 1.2) + page(8.5, 7, 9, 11, 2.5) + lines(10.3, 11.5, 5, 3, 2),
  cut: p('M7.4 11.8 14 2.5M12.6 11.8 6 2.5', 'o') + ci(10, 8.6, 0.7, 's') + ci(6.2, 14.6, 2.7, 'bs') + ci(6.2, 14.6, 1.2, 'knock') + ci(13.8, 14.6, 2.7, 'bs') + ci(13.8, 14.6, 1.2, 'knock'),
  copy: r(2.5, 2.5, 10, 12, 'bf glassy', 2) + r(7.5, 5.5, 10, 12, 'of', 2) + lines(9.7, 9.5, 5.6, 4, 2),
  // Format Painter: a whole brush across the square, bristles down to the left, as one picks it up to paint a format.
  paint: `<g transform="rotate(45 10 10)">${p('M9 9.5V2.5a1 1 0 0 1 2 0v7', 'of') + p('M7.6 9.5h4.8V12H7.6z', 'bs') + p('M7.6 12h4.8v1.5c0 2.2-1 3.8-2.4 5-1.4-1.2-2.4-2.8-2.4-5z', 'ys')}</g>`,

  /* Font */
  fontGrow: t(7.5, 17.5, 'A', 21) + p('M14.5 6l2.5-3 2.5 3', 'o thick'),
  fontShrink: t(7.5, 17.5, 'A', 16) + p('M14.5 3l2.5 3 2.5-3', 'o thick'),
  bold: t(10, 16.2, 'B', 17, { weight: 700 }),
  italic: t(10, 16.2, 'I', 18, { italic: true, serif: true }),
  underline: t(10, 14, 'U', 15) + p('M4.5 17.2h11', 'o thick'),
  strike: t(10, 15.5, 'S', 16) + p('M4 10.5h12', 'o'),
  textColor: t(10, 14.5, 'A', 16),
  fill: p('M3.5 9.5 9 4l6.5 6.5L10 16z', 'bf') + p('M3.5 9.5h12', 'b') + p('M9 4 6.5 1.5', 'o') + p('M16.5 11.5c1 1.6 1.6 2.6 1.6 3.3a1.6 1.6 0 0 1-3.2 0c0-.7.6-1.7 1.6-3.3z', 'ys'),
  borders: borderIcon(['bottom']),
  borderAll: borderIcon(['top', 'bottom', 'left', 'right', 'h', 'v']),
  borderOuter: borderIcon(['top', 'bottom', 'left', 'right']),
  borderInner: borderIcon(['h', 'v']),
  borderNone: borderIcon([]),
  borderTop: borderIcon(['top']),
  borderBottom: borderIcon(['bottom']),
  borderLeft: borderIcon(['left']),
  borderRight: borderIcon(['right']),
  borderH: borderIcon(['h']),
  borderV: borderIcon(['v']),
  eraser: p('M7 16.5 2.8 12.3a1 1 0 0 1 0-1.4l7.4-7.4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-7.1 7.1z', 'pf') + p('M2.8 12.3a1 1 0 0 1 0-1.4l3-3 6.4 6.4-2.5 2.5H7z', 'of') + p('M11 18.5h6.5', 'o'),
  clearFormat: t(7.5, 16, 'A', 19) + `<g transform="rotate(-40 15 15.5)">${r(10.6, 12.1, 8.8, 6.8, 'knock', 2.4) + r(11.5, 13, 7, 5, 'ps', 1.4) + r(11.5, 13, 2.8, 5, 'of', 1.2)}</g>`,
  fontSize: t(6.2, 17.5, 'A', 18) + t(15.8, 17.5, 'a', 13),

  /* Alignment */
  valignTop: p('M3 3.5h14', 'o thick') + lines(6, 7, 8, 2, 3),
  valignMiddle: lines(6, 8.5, 8, 2, 3) + p('M3 3.5h14M3 16.5h14', 'o dash'),
  valignBottom: lines(6, 10, 8, 2, 3) + p('M3 16.5h14', 'o thick'),
  alignLeft: p('M3 4.5h14M3 8.5h9M3 12.5h14M3 16.5h9', 'o'),
  alignCenter: p('M3 4.5h14M5.5 8.5h9M3 12.5h14M5.5 16.5h9', 'o'),
  alignRight: p('M3 4.5h14M8 8.5h9M3 12.5h14M8 16.5h9', 'o'),
  justify: p('M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h9', 'o'),
  indentLess: p('M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14', 'o') + p('M7.5 9.5h-5M4.5 7.5l-2 2 2 2', 'b'),
  indentMore: p('M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14', 'o') + p('M2.5 9.5h5M5.5 7.5l2 2-2 2', 'b'),
  orientation: `<g transform="rotate(-40 7 11)">${t(7, 13, 'ab', 8.5)}</g>` + p('M11 16.5 16.5 5M16.5 5l-3.2 1.2M16.5 5l.5 3.3', 'b'),
  wrap: t(5.5, 8, 'ab', 7.5) + t(5, 16.5, 'c', 7.5) + p('M11.5 5.5h2.5a3 3 0 0 1 0 6H8.5M10.5 9.5l-2 2 2 2', 'b'),
  merge: r(2.5, 4.5, 15, 11, 'bs', 2.4) + p('M5.5 10h9M7.5 8l-2 2 2 2M12.5 8l2 2-2 2', 'wh thick'),
  unmerge: r(2.5, 4.5, 7, 11, 'bf', 2) + r(10.5, 4.5, 7, 11, 'bf', 2) + p('M8 10H4.5M6 8.5 4.5 10 6 11.5M12 10h3.5M14 8.5l1.5 1.5-1.5 1.5', 'b'),

  /* Number */
  currency: t(10, 16, '$', 17),
  // Accounting: a banknote with a stack of coins at its corner.
  accounting: r(1.5, 3.5, 14, 8.5, 'gs', 1.6) + ci(8.5, 7.75, 2.2, 'glint') + p('M3.5 5.5v4.5M13.5 5.5v4.5', 'wh ln')
    + p('M11.5 14.5a3 1.3 0 0 0 6 0v2a3 1.3 0 0 1-6 0z', 'ys') + p('M11.5 12.5a3 1.3 0 0 0 6 0v2a3 1.3 0 0 1-6 0z', 'ys') + p('M11.5 12.5a3 1.3 0 0 1 6 0a3 1.3 0 0 1-6 0z', 'yf'),
  percent: t(10, 16, '%', 16.5),
  comma: ci(10, 8.5, 2.2, 's') + p('M12.1 9c0 3-1.4 5.2-4.1 6.3', 'o thick'),
  number: t(10, 14.5, '123', 7.5, { weight: 600 }),
  decimalMore: p('M7.5 6h-5M4.5 4l-2 2 2 2', 'b') + t(13, 8.5, '.0', 7) + t(11.5, 17, '.00', 7),
  decimalLess: t(10, 8.5, '.00', 7) + p('M2.5 14h5M5.5 12l2 2-2 2', 'b') + t(13, 17, '.0', 7),
  calendar: r(3, 3.5, 14, 14, 'of', 2.4) + p('M3 7.5V5.9a2.4 2.4 0 0 1 2.4-2.4h9.2A2.4 2.4 0 0 1 17 5.9v1.6z', 'rs') + t(10, 15.4, '31', 7, { weight: 600 }),
  text: t(10, 15, 'Abc', 8.5),

  /* Styles */
  condFormat: r(2.5, 3, 15, 14, 'of', 2) + p('M2.5 7.67h15M2.5 12.33h15', 'o ln') + r(4.2, 4.3, 11.3, 2.1, 'gs', 1) + r(4.2, 8.95, 7.5, 2.1, 'ns', 1) + r(4.2, 13.6, 3.8, 2.1, 'rs', 1),
  highlighter: r(2.5, 3, 15, 14, 'of', 2) + p('M2.5 7.67h15M2.5 12.33h15', 'o ln') + r(4.2, 4.3, 11.3, 2.1, 'gs', 1) + r(4.2, 8.95, 7.5, 2.1, 'ns', 1) + r(4.2, 13.6, 3.8, 2.1, 'rs', 1),
  formatTable: cells(1.5, 2.5, 14, 12, 3, 4, { head: 'bs' }) + r(1.5, 8.5, 14, 3, 'bw') + cells(1.5, 2.5, 14, 12, 3, 4, { frame: 'o' }) + brush(1.5, 1.5),
  cellStyles: r(2.5, 2.5, 15, 4.2, 'bs', 1.4) + p('M4.7 4.6h5', 'wh') + r(2.5, 7.9, 15, 4.2, 'gf', 1.4) + p('M4.7 10h5', 'g') + r(2.5, 13.3, 15, 4.2, 'of', 1.4) + p('M4.7 15.4h5', 'o ln'),

  /* Cells */
  insertCells: cells(6.5, 4.5, 11, 11, 2, 2) + r(6.5, 4.5, 5.5, 5.5, 'bw') + cells(6.5, 4.5, 11, 11, 2, 2, { frame: 'o' }) + badge(5, 7.5, 'plus'),
  deleteCells: cells(6.5, 4.5, 11, 11, 2, 2) + r(6.5, 4.5, 5.5, 5.5, 'rw') + cells(6.5, 4.5, 11, 11, 2, 2, { frame: 'o' }) + badge(5, 7.5, 'minus', 'r'),
  formatCells: cells(2.5, 5.5, 15, 10, 3, 2) + r(2.5, 5.5, 15, 5, 'bw') + cells(2.5, 5.5, 15, 10, 3, 2, { frame: 'o' }) + p('M5 3.5h10M5 2v3M15 2v3', 'o'),
  insertRows: cells(2.5, 3.5, 15, 13, 2, 3) + r(2.5, 7.83, 15, 4.33, 'bw') + cells(2.5, 3.5, 15, 13, 2, 3, { frame: 'o' }) + badge(15.5, 15.5, 'plus'),
  insertCols: cells(2.5, 3.5, 15, 13, 3, 2) + r(7.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 2, { frame: 'o' }) + badge(15.5, 15.5, 'plus'),
  deleteRows: cells(2.5, 3.5, 15, 13, 2, 3) + r(2.5, 7.83, 15, 4.33, 'rw') + cells(2.5, 3.5, 15, 13, 2, 3, { frame: 'o' }) + badge(15.5, 15.5, 'minus', 'r'),
  deleteCols: cells(2.5, 3.5, 15, 13, 3, 2) + r(7.5, 3.5, 5, 13, 'rw') + cells(2.5, 3.5, 15, 13, 3, 2, { frame: 'o' }) + badge(15.5, 15.5, 'minus', 'r'),
  insertSheet: page(3.5, 2.5, 11, 15) + cells(5.5, 8, 7, 6, 2, 3, { frame: 'o' }) + sheetPlus,
  deleteSheet: page(3.5, 2.5, 11, 15) + cells(5.5, 8, 7, 6, 2, 3, { frame: 'o' }) + badge(15, 15, 'minus', 'r'),
  rows: cells(2.5, 3.5, 15, 13, 2, 3) + r(2.5, 7.83, 15, 4.33, 'bw') + cells(2.5, 3.5, 15, 13, 2, 3, { frame: 'o' }),
  cols: cells(2.5, 3.5, 15, 13, 3, 2) + r(7.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 2, { frame: 'o' }),
  rowHeight: cells(5.5, 3.5, 12, 13, 2, 3, { frame: 'o' }) + p('M2.5 4.5v11M1 6l1.5-1.5L4 6M1 14l1.5 1.5L4 14', 'b'),
  colWidth: cells(2.5, 6.5, 15, 11, 3, 2, { frame: 'o' }) + p('M3.5 3.5h13M5 2l-1.5 1.5L5 5M15 2l1.5 1.5L15 5', 'b'),

  /* Editing */
  sigma: p('M14.5 4.5h-9l5 5.5-5 5.5h9', 'b thick'),
  autosum: p('M14.5 4.5h-9l5 5.5-5 5.5h9', 'b thick'),
  fillDown: r(4.5, 2.5, 11, 15, 'bf', 2) + arrowDown(10, 5, 9, 'b thick'),
  fillRight: r(2.5, 4.5, 15, 11, 'bf', 2) + arrowRight(5, 10, 9, 'b thick'),
  fillUp: r(4.5, 2.5, 11, 15, 'bf', 2) + p('M10 15V6M7.5 8.5 10 6l2.5 2.5', 'b thick'),
  fillLeft: r(2.5, 4.5, 15, 11, 'bf', 2) + p('M15 10H6M8.5 7.5 6 10l2.5 2.5', 'b thick'),
  series: r(4.5, 2.5, 11, 15, 'of') + t(10, 8.5, '1', 6) + t(10, 15.5, '2', 6) + p('M14 9v4', 'b'),
  sortFilter: az(5, 9) + arrowDown(10.5, 3.5, 12) + funnel(11.5, 4.5, 0.75),
  sortAsc: az(6, 9) + arrowDown(13.5, 3.5, 13),
  sortDesc: az(6, 9, 'Z', 'A') + arrowDown(13.5, 3.5, 13),
  sortCustom: az(5, 9) + p('M10.5 4.5v12M8.5 14.5l2 2 2-2M10.5 4.5l-2 2M10.5 4.5l2 2', 'b') + lines(13.5, 6.5, 4, 3, 3),
  filter: funnel(3.5, 3.5, 1.3),
  find: magnifier(8.5, 8.5, 5.5),
  replace: t(5.5, 8, 'a', 8, { c: 'txb' }) + p('M9.5 5h4.5a2 2 0 0 1 2 2v1.5M14.5 7.5l1.5 1.5 1.5-1.5', 'b') + t(13, 17, 'b', 8) + p('M10 14H6a2 2 0 0 1-2-2v-1', 'o'),
  goTo: p('M3.5 10h11M11 6.5l3.5 3.5-3.5 3.5', 'b thick') + p('M17 3.5v13', 'o'),

  /* Insert */
  // The pivot table with a check beside it: summaries already worked out.
  pivotRecommend: cells(6.5, 6.5, 11, 11, 2, 3) + r(6.5, 6.5, 11, 3.7, 'bw') + cells(6.5, 6.5, 11, 11, 2, 3, { frame: 'o' }) + badge(5, 5, 'check', 'g', 3.2),
  pivot: cells(5.5, 5.5, 12, 12, 2, 3) + r(5.5, 5.5, 12, 4, 'bw') + r(2.5, 9.5, 3, 8, 'bw') + cells(5.5, 5.5, 12, 12, 2, 3, { frame: 'o' }) + p('M2.5 9.5v8h3', 'o') + p('M3.5 6.5V2.5h4M5.5 1l2 1.5-2 1.5', 'b'),
  table: cells(2.5, 3.5, 15, 13, 3, 4, { head: 'bf' }) + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' }),
  pictures: r(2.5, 3.5, 15, 13, 'bf', 2) + p('M2.5 14l4.5-5 3.5 3.5 2.5-2.5 4.5 4.5v.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z', 'gs') + ci(13, 7.5, 1.7, 'ys'),
  image: r(2.5, 3.5, 15, 13, 'bf', 2) + p('M2.5 14l4.5-5 3.5 3.5 2.5-2.5 4.5 4.5v.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z', 'gs') + ci(13, 7.5, 1.7, 'ys'),
  shapes: ci(7.5, 7.5, 5, 'bs') + r(8.5, 8.5, 9, 9, 'nf glassy', 2),
  icons: ci(10, 6.8, 3.6, 'bs') + p('M3.5 17.5a6.5 6.5 0 0 1 13 0z', 'bs') + ci(9, 5.8, 1, 'glint'),
  chartColumn: chartAxes + columns([[6, 'bf'], [11, 'bf'], [8, 'nf']]),
  chartBar: chartAxes + r(3.5, 4.5, 7, 2.6, 'bs', 0.7) + r(3.5, 8.5, 12, 2.6, 'bs', 0.7) + r(3.5, 12.5, 9, 2.6, 'ns', 0.7),
  chartLine: chartAxes + p('M4 13l3.5-4.5 3 2.5L16.5 5', 'b thick') + p('M4 15.5l3.5-2 3 1 6-4', 'n'),
  chartArea: chartAxes + p('M3.5 16.5V12l3.5-4 3.5 3 3-4 3.5 2.5v7z', 'bf') + p('M3.5 12l3.5-4 3.5 3 3-4 3.5 2.5', 'b thick'),
  chartPie: p('M10 3.5a7 7 0 1 0 7 7h-7z', 'bs') + p('M11.5 2a7 7 0 0 1 7 7h-7z', 'ns'),
  chartScatter: chartAxes + ci(7, 12, 1.4, 'bs') + ci(9.5, 8.5, 1.4, 'bs') + ci(12, 10.5, 1.4, 'ns') + ci(14.5, 5.5, 1.4, 'bs') + ci(6.5, 7, 1.4, 'ns'),
  chartCombo: chartAxes + columns([[5, 'bf'], [9, 'bf'], [7, 'bf']]) + p('M5.5 9.5l4-4 4 3 3.5-4', 'n thick'),
  chartHistogram: chartAxes + columns([[4, 'bf'], [9, 'bf'], [11, 'bf'], [6, 'bf']], 4.5, 3, 0),
  chartWaterfall: chartAxes + r(5, 7.5, 2.5, 9, 'bs', 0.7) + r(8.5, 5, 2.5, 2.5, 'gs', 0.7) + r(12, 5, 2.5, 4.5, 'rs', 0.7) + r(15, 9.5, 1.8, 7, 'bs', 0.7),
  chartRadar: p('M10 2.5l7 5-2.7 8.5H5.7L3 7.5z', 'o ln') + p('M10 5.5l4.5 3.2-1.8 5.3H7.3L5.5 8.7z', 'bs glassy'),
  chartBubble: chartAxes + ci(7.5, 11.5, 2.6, 'bs glassy') + ci(12.5, 7, 3.3, 'ns glassy') + ci(14.5, 13, 1.6, 'bs'),
  recommendedCharts: chartAxes + columns([[6, 'bf'], [11, 'bf'], [8, 'nf']]) + p('M15.5 1.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z', 'ys'),
  sparkLine: r(2.5, 5.5, 15, 9, 'of') + p('M4 12l3-3 2.5 2 3-4 3.5 2', 'b thick'),
  sparkColumn: r(2.5, 5.5, 15, 9, 'of') + r(4.5, 10, 2, 3, 'bs') + r(7.5, 8, 2, 5, 'bs') + r(10.5, 9, 2, 4, 'bs') + r(13.5, 7, 2, 6, 'bs'),
  sparkWinLoss: r(2.5, 5.5, 15, 9, 'of') + p('M3.5 10h13', 'o ln') + r(4.5, 7, 2, 3, 'bs') + r(7.5, 10, 2, 3, 'rs') + r(10.5, 7, 2, 3, 'bs') + r(13.5, 7, 2, 3, 'bs'),
  slicer: r(3.5, 2.5, 13, 15, 'of', 1) + p('M3.5 6h13', 'o') + r(5.5, 7.5, 9, 2.5, 'bf', 0.5) + r(5.5, 11, 9, 2.5, 'of', 0.5) + r(5.5, 14.5, 9, 1.5, 'of', 0.5) + funnel(11, 3.3, 0.35),
  // A table with a dashed outer edge pulled out from its corner.
  resizeTable: cells(2.5, 2.5, 10, 10, 2, 3, { head: 'bf' }) + cells(2.5, 2.5, 10, 10, 2, 3, { frame: 'o' }) + p('M2.5 15.5v2h15v-15h-2', 'o dash') + p('M12.5 12.5l4 4M13.5 16.5h3v-3', 'b thick'),
  headerRow: cells(2.5, 3.5, 15, 13, 3, 4, { head: 'bs' }) + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' }),
  // Table Style Options: the same table, shaded where each option applies.
  bandedRows: tableShaded(r(2.5, 6.75, 15, 3.25, 'bw') + r(2.5, 13.25, 15, 3.25, 'bw')),
  firstColumn: tableShaded(r(2.5, 3.5, 5, 13, 'bw')),
  lastColumn: tableShaded(r(12.5, 3.5, 5, 13, 'bw')),
  bandedColumns: tableShaded(r(2.5, 3.5, 5, 13, 'bw') + r(12.5, 3.5, 5, 13, 'bw')),
  // A table, its header shaded, turning into a plain range of cells.
  convertToRange: cells(2.5, 2.5, 9, 8, 2, 3, { head: 'bw' }) + cells(2.5, 2.5, 9, 8, 2, 3, { frame: 'o' }) + cells(8.5, 9.5, 9, 8, 2, 3) + p('M13 3.5c2.5 0 4 1.5 4 4M15.3 6l1.7 1.8 1.7-1.8', 'b'),
  filterButton: cells(2.5, 3.5, 15, 13, 2, 3, { head: 'bw' }) + cells(2.5, 3.5, 15, 13, 2, 3, { frame: 'o' }) + r(11, 4.5, 5, 2.5, 'of', 0.5) + p('M12.3 5.3l1.2 1 1.2-1', 'o'),
  timeline: r(2.5, 5.5, 15, 9, 'of', 1) + p('M4.5 12.5h11', 'o') + r(6.5, 11, 5, 3, 'bf', 0.5) + p('M5 8h2M9 8h2M13 8h2', 'o thick'),
  link: p('M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1', 'b thick') + p('M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1', 'o thick'),
  unlink: p('M12 6.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8 13.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1', 'o thick') + p('M4 4l2 2M16 16l-2-2M7.5 2.5v2M12.5 17.5v-2', 'r'),
  note: p('M3.5 3.5h13v9l-4 4h-9z', 'yf') + p('M16.5 12.5h-4v4', 'o') + lines(6, 7, 7, 2, 2.5),
  comment: p('M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5l-4 3v-3H5a2 2 0 0 1-2-2z', 'bs') + p('M10 6v5.5M7.25 8.75h5.5', 'wh thick'),
  users: p('M3 5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 14 5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5v-2.5h-.5A1.5 1.5 0 0 1 3 10z', 'of') + p('M15.5 7.5h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v2.5l-3-2.5h-3.5a1 1 0 0 1-1-1v-1.5h4a2 2 0 0 0 2-2z', 'bs'),
  /* Threaded comments: a small bubble with what the command does to it, in the comments' purple. */
  deleteComment: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + badge(15, 15, 'x', 'r'),
  prevComment: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + p('M17.5 15h-7M13.5 12l-3 3 3 3', 'p thick'),
  nextComment: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + p('M10.5 15h7M14.5 12l3 3-3 3', 'p thick'),
  showComments: r(11.5, 2.5, 6, 15, 'of', 1) + p('M13 6h3M13 9h3M13 12h3', 'p') + p('M2.5 5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6l-2 1.5v-1.5h-.5a1 1 0 0 1-1-1z', 'pf'),
  send: p('M3 9.5l14-6-5 14-2.5-5.5z', 'pf') + p('M9.5 12l7.5-8.5', 'p'),
  /* Email: an envelope, with what goes out in it (a sheet for a copy, a link for a link). */
  sendCopy: r(2.5, 6.5, 15, 10.5, 'of', 1.4) + p('M2.8 7l7.2 5.5L17.2 7', 'o') + r(10.5, 2.5, 7, 7.5, 'gf', 0.8) + p('M10.5 5h7M10.5 7.5h7M13.5 2.5v7.5', 'g'),
  sendLink: r(2.5, 6.5, 15, 10.5, 'of', 1.4) + p('M2.8 7l7.2 5.5L17.2 7', 'o') + p('M11 4.2l1-1a1.8 1.8 0 0 1 2.5 2.5l-1 1M13.5 3.5l-2.2 2.2M12.2 7.3l-1 1a1.8 1.8 0 0 1-2.5-2.5l1-1', 'b thick'),
  textBox: r(3.5, 4.5, 13, 11, 'of', 1.6) + ci(3.5, 4.5, 1.2, 'bs') + ci(16.5, 4.5, 1.2, 'bs') + ci(3.5, 15.5, 1.2, 'bs') + ci(16.5, 15.5, 1.2, 'bs') + t(10, 14, 'A', 9),
  headerFooter: page(4.5, 2.5, 11, 15) + r(6, 4.5, 8, 2.5, 'bw') + r(6, 13.5, 8, 2, 'bw') + lines(6.5, 9, 7, 2, 2),
  pageLayout: page(4.5, 2.5, 11, 15) + r(6, 4.5, 8, 2.5, 'bw') + r(6, 13.5, 8, 2, 'bw') + lines(6.5, 9, 7, 2, 2),
  wordArt: t(10, 16, 'A', 16, { italic: true, serif: true, c: 'txb' }),
  math: t(10, 15.5, 'π', 15),
  symbol: t(10, 15.5, 'Ω', 14),
  checkbox: r(3.5, 3.5, 13, 13, 'gs', 3) + p('M6.8 10.3l2.3 2.3 4.2-5', 'wh thick'),
  dropdown: r(2.5, 6.5, 15, 7, 'of', 1) + p('M13.5 6.5v7', 'o') + p('M14.5 9.5l1 1 1-1', 'o'),
  newSheet: page(3.5, 2.5, 11, 15) + cells(5.5, 8, 7, 6, 2, 3, { frame: 'o' }) + sheetPlus,

  /* Page Layout */
  palette: t(7.5, 9.5, 'Aa', 8.5, { serif: true }) + r(3, 12, 3.2, 4, 'bs') + r(7, 12, 3.2, 4, 'gs') + r(11, 12, 3.2, 4, 'ns') + r(15, 12, 2.5, 4, 'rs'),
  themeColors: ci(7.2, 7.2, 4.2, 'bs glassy') + ci(12.8, 7.2, 4.2, 'rs glassy') + ci(7.2, 12.8, 4.2, 'gs glassy') + ci(12.8, 12.8, 4.2, 'ys glassy'),
  themeFonts: t(7, 15.5, 'A', 13, { serif: true }) + t(14.5, 15.5, 'a', 10, { c: 'txb' }),
  themeEffects: ci(11.5, 11.5, 5, 'ns glassy') + ci(8.5, 8.5, 5, 'bf glassy'),
  margins: page(4.5, 2.5, 11, 15, 0) + r(6.5, 4.5, 7, 11, 'bw', 1) + r(6.5, 4.5, 7, 11, 'b dash'),
  swap: r(2.5, 6.5, 8, 11, 'of', 1.6) + r(8.5, 9.5, 9, 8, 'bf glassy', 1.6) + p('M12 2.5a4 4 0 0 1 4 4M14.5 5.5l1.5 1.5 1.5-1.5', 'b'),
  orientation2: r(2.5, 6.5, 8, 11, 'of', 1.6) + r(8.5, 9.5, 9, 8, 'bf glassy', 1.6),
  fileText: page(4.5, 2.5, 11, 15) + p('M7 8v7M5.5 9.5 7 8l1.5 1.5M5.5 13.5 7 15l1.5-1.5', 'b') + p('M9.5 16h4', 'o'),
  printArea: page(4.5, 2.5, 11, 15) + r(6.5, 6.5, 6, 7, 'b dash') + r(6.5, 6.5, 6, 7, 'bw'),
  printer: r(5.5, 2.5, 9, 5, 'of') + r(2.5, 7, 15, 7.5, 'bs', 2) + r(5.5, 11.5, 9, 6, 'of', 0.8) + lines(7, 14, 6, 2, 2) + ci(15, 9.3, 0.7, 'glint'),
  printTitles: page(4.5, 2.5, 11, 15) + r(4.5, 5.5, 8, 3, 'bw') + lines(6.5, 11, 7, 3, 2),
  // Breaks: the foot of one page and the head of the next, a solid line drawn between them.
  breaks: p('M4.5 8.5V3.7a1.2 1.2 0 0 1 1.2-1.2h8.6a1.2 1.2 0 0 1 1.2 1.2v4.8', 'of') + p('M4.5 11.5v4.8a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2v-4.8', 'of')
    + lines(6.5, 5, 7, 2, 2) + lines(6.5, 13.5, 7, 2, 2) + p('M1.5 10h17', 'b thick'),
  // Background: a picture tiled under the sheet's cells.
  background: r(2.5, 3.5, 15, 13, 'bw') + p('M2.5 16.5l4.5-6 3.5 4 2.5-2.5 4.5 4.5z', 'gf') + ci(13.5, 7, 1.6, 'ys') + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }),
  sliders: r(2.5, 3.5, 15, 13, 'of', 2) + p('M5 7.5h10M5 12.5h10', 'o ln') + ci(8, 7.5, 1.7, 'bs') + ci(12.5, 12.5, 1.7, 'bs'),
  pageSetup: page(4.5, 2.5, 11, 15) + lines(6.5, 6.5, 5, 3, 2) + ci(14, 14, 3.9, 'knock') + ci(14, 14, 3, 'ns') + ci(14, 14, 1, 'knock'),
  fileDown: page(4.5, 2.5, 11, 15) + r(2.5, 10.5, 10, 5, 'rs', 1) + t(7.5, 14.5, 'PDF', 4.6, { weight: 700, c: 'txw' }),
  fitWidth: page(5.5, 4.5, 9, 11, 2) + p('M1.5 10h17M3.5 8l-2 2 2 2M16.5 8l2 2-2 2', 'b'),
  fitHeight: page(5.5, 4.5, 9, 11, 2) + p('M10 1.5v17M8 3.5l2-2 2 2M8 16.5l2 2 2-2', 'b'),
  scaling: page(4.5, 2.5, 11, 15) + t(10, 14, '%', 8, { c: 'txb' }),
  // The sheet's lines themselves, drawn in blue over the paper; Normal view keeps the plain sheet.
  gridlines: r(2.5, 3.5, 15, 13, 'of') + p('M2.5 7.83h15M2.5 12.17h15M7.5 3.5v13M12.5 3.5v13', 'b'),
  headings: cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'of' }) + r(2.5, 3.5, 15, 4.33, 'bw') + r(2.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }),
  // Print gridlines and Print headings: each sheet option's picture, smaller, with a printer at its corner.
  printGridlines: r(1.5, 2.5, 13, 11, 'of') + p('M1.5 6.17h13M1.5 9.83h13M5.83 2.5v11M10.17 2.5v11', 'b') + printerBadge(10, 10.5),
  printHeadings: cells(1.5, 2.5, 13, 11, 3, 3) + r(1.5, 2.5, 13, 3.67, 'bw') + r(1.5, 2.5, 4.33, 11, 'bw') + cells(1.5, 2.5, 13, 11, 3, 3, { frame: 'o' }) + printerBadge(10, 10.5),

  /* Formulas */
  fx: t(10, 14.5, 'fx', 12, { italic: true, serif: true }),
  insertFunction: t(10, 14.5, 'fx', 12, { italic: true, serif: true }) + p('M2.5 17.5h15', 'b'),
  history: p('M10 3a7 7 0 1 1-7 7', 'o') + p('M3 6v4h4', 'o') + p('M10 6.5V10l2.5 1.5', 'b thick') + p('M15.5 1.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z', 'ys'),
  financial: `<ellipse class="ys" cx="9" cy="14.5" rx="6" ry="2.5"/>` + `<ellipse class="yf" cx="9" cy="11.5" rx="6" ry="2.5"/>` + `<ellipse class="ys" cx="11" cy="7" rx="6" ry="2.5"/>` + t(11, 8.8, '$', 4.6, { weight: 700, c: 'txw' }),
  logical: r(2.5, 4.5, 7, 11, 'gf', 1) + p('M4 10l1.5 1.5L8 8.5', 'o thick') + r(10.5, 4.5, 7, 11, 'rf', 1) + p('M12.5 8l3 3.5M15.5 8l-3 3.5', 'o thick'),
  dateTime: r(2.5, 4.5, 12, 11.5, 'of', 1) + r(2.5, 4.5, 12, 3, 'bf', 1) + p('M5.5 3v3M11.5 3v3', 'o') + ci(14, 14, 4, 'of') + p('M14 11.5V14l1.6 1', 'b'),
  lookup: cells(2.5, 3.5, 12, 11, 2, 3, { frame: 'of' }) + ci(13.5, 12.5, 4.3, 'knock') + magnifier(13.5, 12.5, 3.2),
  mathTrig: p('M2.5 10.5h2l2.5 5.5 4-13h6.5', 'o thick') + t(14, 15.5, 'x', 7, { italic: true, serif: true, c: 'txb' }),
  moreFunctions: page(4.5, 2.5, 11, 15) + ci(7.5, 12, 1, 's') + ci(10, 12, 1, 's') + ci(12.5, 12, 1, 's'),
  tag: p('M2.5 8.5V3.5a1 1 0 0 1 1-1h5l9 9-6 6-9-9z', 'yf') + ci(6, 6, 1.2, 'of'),
  nameManager: p('M2.5 8.5V3.5a1 1 0 0 1 1-1h5l9 9-6 6-9-9z', 'yf') + ci(6, 6, 1.2, 'of') + lines(9.5, 10.5, 4, 2, 2.5, 'o'),
  defineName: p('M2.5 8.5V3.5a1 1 0 0 1 1-1h5l6 6-7.5 7.5-4.5-4.5z', 'yf') + ci(6, 6, 1.2, 'of') + badge(15, 15, 'plus'),
  useName: p('M2.5 8.5V3.5a1 1 0 0 1 1-1h5l6 6-7.5 7.5-4.5-4.5z', 'yf') + ci(6, 6, 1.2, 'of') + t(15, 18, 'fx', 6.5, { italic: true, serif: true }),
  createNames: cells(2.5, 6.5, 12, 11, 2, 3, { head: 'bw', frame: 'of' }) + cells(2.5, 6.5, 12, 11, 2, 3, { frame: 'o' }) + p('M11 6.5V2.5h4l3.5 3.5-3 3', 'yf'),
  precedents: cells(1.5, 7.5, 6, 5, 1, 1) + ci(4.5, 10, 1.1, 'bs') + p('M5.5 10h9.5M13 8l2 2-2 2', 'b') + r(15.5, 7.5, 3, 5, 'of'),
  dependents: r(1.5, 7.5, 3, 5, 'of') + ci(3, 10, 1.1, 'bs') + p('M4 10h9.5M11.5 8l2 2-2 2', 'b') + cells(13.5, 7.5, 5, 5, 1, 1),
  clearTrace: p('M2.5 6.5h10M10.5 4.5l2 2-2 2', 'b') + p('M7.5 18.5 3.3 14.3a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4.7 4.7z', 'pf') + p('M11 18.5h6', 'o'),
  showFormulas: cells(2.5, 7.5, 15, 10, 2, 2, { frame: 'of' }) + t(10, 6.5, 'fx', 7.5, { italic: true, serif: true, c: 'txb' }),
  errorCheck: cells(2.5, 3.5, 13, 12, 2, 2, { frame: 'of' }) + p('M9 9.5h3.5L9 13z', 'gs') + p('M2.5 9.5H6L2.5 13z', 'gs') + badge(15, 15, 'check'),
  evaluate: t(7, 11, 'fx', 9, { italic: true, serif: true }) + magnifier(13, 12.5, 3.2),
  watch: r(2.5, 4.5, 15, 11, 'of', 2) + `<ellipse class="of" cx="10" cy="10" rx="5.5" ry="3"/>` + ci(10, 10, 2, 'bs') + ci(10.7, 9.3, 0.6, 'glint'),
  calculator: r(4.5, 2.5, 11, 15, 'of', 2.4) + r(6.3, 4.3, 7.4, 3, 'gs', 1) + p('M7 10.5h1M9.5 10.5h1M12 10.5h1M7 13h1M9.5 13h1M12 13h1M7 15.5h1M9.5 15.5h1', 'o thick') + r(11.5, 12.3, 2, 4, 'ns', 1),
  calcNow: r(3.5, 2.5, 9, 13, 'of', 1) + r(5, 4, 6, 2.5, 'gw') + p('M5.5 9h1M8 9h1M10.5 9h0M5.5 11.5h1M8 11.5h1', 'o thick') + p('M17.5 12a3.5 3.5 0 1 1-1-2.5M17.5 8.5v2h-2', 'b'),
  calcSheet: r(3.5, 2.5, 9, 13, 'of', 1) + r(5, 4, 6, 2.5, 'gw') + p('M5.5 9h1M8 9h1M5.5 11.5h1M8 11.5h1', 'o thick') + cells(11, 11, 7, 6.5, 2, 2),
  toValues: t(5.5, 9, 'fx', 7.5, { italic: true, serif: true }) + p('M9.5 6.5h5M12.5 4.5l2 2-2 2', 'b') + t(12, 16.5, '123', 6.5, { weight: 600 }),
  number2: t(10, 14.5, '123', 7.5, { weight: 600 }),

  /* Data */
  database: `<ellipse class="bf" cx="8" cy="5" rx="5.5" ry="2.2"/>` + p('M2.5 5v9.5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V5c0 1.2-2.5 2.2-5.5 2.2S2.5 6.2 2.5 5z', 'bs') + p('M2.5 9.8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2', 'wh ln') + cells(11.5, 10.5, 7, 7, 2, 2, { head: 'gs', frame: 'of' }),
  upload: `<ellipse class="bf" cx="8" cy="5" rx="5.5" ry="2.2"/>` + p('M2.5 5v9.5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V5c0 1.2-2.5 2.2-5.5 2.2S2.5 6.2 2.5 5z', 'bs') + p('M2.5 9.8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2', 'wh ln') + cells(11.5, 10.5, 7, 7, 2, 2, { head: 'gs', frame: 'of' }),
  fromFile: page(4.5, 2.5, 11, 15) + cells(6.5, 8.5, 7, 6, 2, 3, { head: 'gw', frame: 'o' }),
  fromWeb: ci(10, 10, 7, 'bf') + p('M3 10h14M10 3c-2.5 2-3.5 4.5-3.5 7s1 5 3.5 7c2.5-2 3.5-4.5 3.5-7s-1-5-3.5-7z', 'o'),
  refresh: page(5.5, 4.5, 9, 11, 2) + p('M16.5 7.5a7 7 0 0 0-12.5-1.5M4 3v3h3', 'g thick') + p('M3.5 12.5a7 7 0 0 0 12.5 1.5M16 17v-3h-3', 'g thick'),
  reset: p('M16.5 7.5a7 7 0 0 0-12.5-1.5M4 3v3h3', 'g thick') + p('M3.5 12.5a7 7 0 0 0 12.5 1.5M16 17v-3h-3', 'g thick'),
  textToColumns: r(2.5, 5.5, 15, 9, 'of', 1.6) + t(5, 12, 'a', 6) + t(10, 12, 'b', 6) + t(15, 12, 'c', 6) + p('M7.5 2.5v15M12.5 2.5v15', 'b thick'),
  flashFill: cells(2.5, 3.5, 12, 14, 2, 4, { frame: 'of' }) + r(8.5, 7, 6, 10.5, 'bw') + cells(2.5, 3.5, 12, 14, 2, 4, { frame: 'o' }) + p('M16.5 1.5l-3.5 6h3l-2.5 6.5 5.5-8h-3.2l2-4.5z', 'ys'),
  dedupe: cells(2.5, 3.5, 12, 13, 1, 4, { frame: 'of' }) + r(2.5, 6.75, 12, 3.25, 'rw') + r(2.5, 13.25, 12, 3.25, 'rw') + cells(2.5, 3.5, 12, 13, 1, 4, { frame: 'o' }) + p('M15 7l3.5 3.5M18.5 7 15 10.5', 'r thick'),
  validation: cells(2.5, 3.5, 12, 13, 2, 3, { frame: 'of' }) + badge(14.5, 14, 'check', 'g', 3.7),
  consolidate: cells(1.5, 2.5, 7, 6, 2, 2, { frame: 'of' }) + cells(1.5, 11.5, 7, 6, 2, 2, { frame: 'of' }) + p('M9 5.5h2.5v9H9M11.5 10h3M13 8.5l1.5 1.5-1.5 1.5', 'b') + cells(15, 7.5, 3.5, 5, 1, 2),
  whatIf: cells(2.5, 5.5, 12, 12, 2, 3, { frame: 'of' }) + ci(14.5, 6, 4, 'bf') + t(14.5, 8.5, '?', 7, { weight: 700, c: 'txb2' }),
  goalSeek: ci(10, 10, 7.5, 'rs') + ci(10, 10, 5.3, 'knock') + ci(10, 10, 3.6, 'rs') + ci(10, 10, 1.6, 'knock'),
  forecast: chartAxes + p('M4 14l3-4 3 2 3-5', 'b thick') + p('M13 7l3.5-3', 'b thick dash'),
  scenarioManager: r(5.5, 2.5, 12, 9, 'bf glassy', 1.6) + r(2.5, 6.5, 12, 9, 'of', 1.6) + lines(4.5, 9.5, 8, 3, 2) + ci(15, 15, 3.9, 'knock') + ci(15, 15, 3, 'bs') + p('M15 13.5V15l1 .8', 'wh'),
  filterClear: funnel(2.5, 3, 1.2) + badge(15, 15, 'x', 'r'),
  filterReapply: funnel(2.5, 3, 1.2) + p('M17.5 13.5a3.5 3.5 0 1 1-1-2.5M17.5 9.5v2h-2', 'g thick'),
  filterAdvanced: funnel(2.5, 3, 1.2) + cells(11.5, 11.5, 7, 6, 2, 2, { head: 'bw', frame: 'of' }),
  showDetail: cells(7.5, 3.5, 10, 13, 1, 4, { frame: 'of' }) + ci(4, 10, 3, 'bs') + p('M2.6 10h2.8M4 8.6v2.8', 'wh'),
  hideDetail: cells(7.5, 3.5, 10, 13, 1, 4, { frame: 'of' }) + ci(4, 10, 3, 'bs') + p('M2.6 10h2.8', 'wh'),
  group: cells(6.5, 3.5, 11, 13, 1, 4, { frame: 'of' }) + p('M3.5 5v10h2', 'b') + ci(3.5, 10, 2.4, 'bs') + p('M2.4 10h2.2M3.5 8.9v2.2', 'wh'),
  ungroup: cells(6.5, 3.5, 11, 13, 1, 4, { frame: 'of' }) + p('M3.5 5v10h2', 'b') + ci(3.5, 10, 2.4, 'bs') + p('M2.4 10h2.2', 'wh'),
  // Auto Outline: a column of cells with nested bracket levels drawn beside it, and a spark for "worked out".
  autoOutline: cells(7.5, 3.5, 10, 13, 1, 4, { frame: 'of' }) + p('M3 4.5v11h2.5M5.2 8.5v3.8h1.3', 'b') + p('M3.5 1.2l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z', 'ys'),
  // Clear Outline: the bracket struck out.
  clearOutline: cells(7.5, 3.5, 10, 13, 1, 4, { frame: 'of' }) + p('M3.5 4.5v11h2', 'o ln') + p('M1.5 8l4 4M5.5 8l-4 4', 'r thick'),
  // Outline settings: the bracket over a pair of sliders.
  outlineSettings: cells(7.5, 3.5, 10, 8, 1, 2, { frame: 'of' }) + p('M3.5 4.5v6.5h2', 'b') + p('M3 15h14M3 18h14', 'o ln') + ci(7, 15, 1.4, 'bs') + ci(13, 18, 1.4, 'bs'),
  subtotal: cells(2.5, 3.5, 11, 13, 1, 4, { frame: 'of' }) + p('M18 4.5h-5l3 3.2-3 3.3h5', 'b thick') + r(2.5, 13.25, 11, 3.25, 'bw'),
  columnStats: chartAxes + columns([[6, 'bf'], [11, 'bf'], [8, 'bf']]) + p('M4 6.5h13', 'r dash'),
  // Solver: a curve over the axes with its peak found (the dot) and the search's steps toward it.
  solver: chartAxes + p('M4.5 15.5C6.5 6 13.5 6 16.5 15.5', 'b thick') + p('M6 12.8l2-3.6 2.1-1.5', 'g dash') + ci(10.5, 8.4, 1.9, 'rs'),
  // Data Analysis: a histogram with a bell curve over it.
  dataAnalysis: chartAxes + columns([[3.5, 'bf'], [8, 'bf'], [10.5, 'bf'], [6, 'bf']], 4.6, 2.6, 0.9) + p('M3.8 15.6C7 15.6 7.6 4.6 10.4 4.6S14 15.6 17 15.6', 'r thick'),
  powerQuery: cells(2.5, 3.5, 12, 13, 2, 3, { frame: 'of' }) + p('M13 9.5l2.5-5 2 1-2.5 5z', 'nf'),
  /* Get & Transform: Get Data sources, the Queries & Connections pane, and the query editor's commands. */
  fromText: page(4.5, 2.5, 11, 15) + lines(6.5, 8, 7, 4) + p('M9 7v8.5M11.5 7v8.5', 'g dash'),
  fromTable: cells(2.5, 4.5, 10, 11, 2, 3, { head: 'bw', frame: 'of' }) + arrowRight(12.5, 10, 5.5, 'g'),
  blankQuery: page(4.5, 2.5, 11, 15) + p('M7 9h6M7 11.5h6M7 14h4', 'o dash'),
  // Data Form: a card of labelled fields with the record's arrows; Edit Links: a workbook joined to another by a chain link.
  dataForm: r(2.5, 2.5, 15, 15, 'of', 1.6) + p('M4.5 6h3M4.5 10h3M4.5 14h3', 'o ln') + r(9, 4.75, 6.5, 2.5, 'bw', 0.6) + r(9, 8.75, 6.5, 2.5, 'bw', 0.6) + r(9, 12.75, 6.5, 2.5, 'gw', 0.6) + p('M9 4.75h6.5v2.5H9zM9 8.75h6.5v2.5H9zM9 12.75h6.5v2.5H9z', 'o ln'),
  editLinks: cells(2.5, 2.5, 9, 10, 2, 3, { head: 'bw', frame: 'of' }) + r(10, 10, 8.5, 8, 'knock', 2) + p('M12 15.5l-.6.6a1.8 1.8 0 0 1-2.5-2.5l1.6-1.6a1.8 1.8 0 0 1 2.5 0', 'o thick') + p('M14.5 12.5l.6-.6a1.8 1.8 0 0 1 2.5 2.5L16 16a1.8 1.8 0 0 1-2.5 0', 'b thick'),
  queriesPane: r(2.5, 3.5, 15, 13, 'of', 1) + r(11.5, 3.5, 6, 13, 'bw') + p('M11.5 3.5v13', 'o') + p('M13 7h3M13 10h3M13 13h3', 'b thick') + p('M4.5 7h5M4.5 10h5M4.5 13h5', 'o ln'),
  closeLoad: cells(7.5, 7.5, 10, 10, 2, 3, { head: 'gw', frame: 'of' }) + r(2.5, 2.5, 7, 5, 'nf', 1) + p('M6 7.5v4.5h4M8.5 10l1.5 2-1.5 2', 'g'),
  chooseColumns: cells(2.5, 3.5, 15, 13, 3, 2) + r(2.5, 3.5, 5, 13, 'bw') + r(12.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 2, { frame: 'o' }) + p('M8.5 9.5l1.5 1.5 2.5-3', 'g thick'),
  keepRows: cells(2.5, 3.5, 15, 13, 2, 4) + r(2.5, 3.5, 15, 6.5, 'gw') + cells(2.5, 3.5, 15, 13, 2, 4, { frame: 'o' }) + p('M18.5 3.5v6.5', 'g thick'),
  groupBy: cells(2.5, 3.5, 7, 13, 1, 4, { frame: 'of' }) + p('M10.5 5l2 0v4.5h2M12.5 9.5v4.5h-2', 'b') + cells(14.5, 7.5, 3.5, 4, 1, 1),
  promoteHeaders: cells(2.5, 5.5, 15, 12, 2, 3, { frame: 'of' }) + r(2.5, 5.5, 15, 4, 'gw') + cells(2.5, 5.5, 15, 12, 2, 3, { frame: 'o' }) + p('M10 1.5v6M7.5 4l2.5-2.5 2.5 2.5', 'g'),
  mergeQueries: cells(1.5, 2.5, 7, 6, 2, 2, { head: 'bw', frame: 'of' }) + cells(1.5, 11.5, 7, 6, 2, 2, { head: 'gw', frame: 'of' }) + p('M8.5 5.5h2.5v9H8.5M11 10h2.5', 'o') + cells(13.5, 6.5, 5, 7, 2, 2, { frame: 'of' }),
  indexColumn: cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'of' }) + r(12.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }) + t(15, 9.3, '1', 4.2, { c: 'txb' }) + t(15, 13.6, '2', 4.2, { c: 'txb' }),

  /* Review */
  spell: t(8.5, 10, 'abc', 8.5) + p('M7 14l2.5 2.5 6-6', 'g thick'),
  autoCorrect: t(7, 15.5, 'ab', 8.5) + p('M14.5 2.5 11 9.5h3l-1.5 6 5-8h-3l1.5-5z', 'ys'),
  spellCheck: t(10, 9.5, 'abc', 9) + p('M5.5 13.5l3 3 6-6', 'g thick'),
  thesaurus: p('M10 5.2C8 3.8 5.5 3.6 3 4.4v11.4c2.5-.8 5-.6 7 .8z', 'bf') + p('M10 5.2c2-1.4 4.5-1.6 7-.8v11.4c-2.5-.8-5-.6-7 .8z', 'of') + p('M12 8h3M12 10.5h3M12 13h2', 'o ln') + t(6.6, 12.2, 'A', 5.5, { serif: true, c: 'txb2' }),
  translate: r(2.5, 2.5, 10, 9, 'bf', 1.6) + t(7.5, 9.5, 'A', 6.5, { weight: 600, c: 'txb2' }) + p('M5 11.5v3l2.5-3', 'bf') + r(8.5, 8.5, 9, 8, 'of', 1.6) + t(13, 14.8, 'a', 6.5, { serif: true }),
  stats: page(4.5, 2.5, 11, 15) + r(6.8, 10.5, 1.6, 4.5, 'bs', 0.5) + r(9.2, 7.5, 1.6, 7.5, 'bs', 0.5) + r(11.6, 9, 1.6, 6, 'ns', 0.5),
  deleteNote: p('M3.5 3.5h11v7l-4 4h-7z', 'yf') + badge(15, 15, 'x', 'r'),
  notes: p('M5.5 5.5h11v7l-4 4h-7z', 'yf') + p('M3.5 13V3.5h10', 'o'),
  lockSheet: page(2.5, 2.5, 10, 14) + lock(9.5, 11.5),
  protectSheet: page(2.5, 2.5, 10, 14) + cells(4, 7, 7, 6, 2, 3, { frame: 'o' }) + lock(9.5, 12),
  protectBook: r(3.5, 3, 10, 14.5, 'gs', 1.4) + p('M5.8 3v14.5', 'wh ln') + lock(10, 12),
  protectRanges: cells(2.5, 3.5, 13, 11, 2, 3, { frame: 'of' }) + r(2.5, 7.17, 13, 3.67, 'bw') + lock(10, 12.5),
  share: p('M3.5 9.5v7h13v-7', 'o') + p('M10 12.5v-10M7 5.5l3-3 3 3', 'b thick'),
  versions: p('M3.5 10a6.5 6.5 0 1 0 2-4.7', 'o') + p('M3 3v3h3', 'o') + p('M10 6v4l3 2', 'b'),
  // A sheet with one changed cell picked out, and a clock over its corner: the edits made over time.
  showChanges: cells(2.5, 2.5, 13, 12, 2, 3, { frame: 'of' }) + r(9, 6.5, 6.5, 4, 'yf', 0.6) + ci(14.5, 14.5, 4.9, 'knock') + ci(14.5, 14.5, 4, 'bw') + ci(14.5, 14.5, 4, 'o') + p('M14.5 12.3v2.4l1.6 1', 'b thick'),
  unprotect: page(2.5, 2.5, 10, 14) + p('M11 11.5v-2a2.5 2.5 0 0 1 5 0', 'o') + r(9.5, 11.5, 8, 6, 'nf', 1),

  /* View */
  normalView: cells(2.5, 3.5, 15, 13, 3, 3, { head: 'bw', frame: 'of' }) + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }),
  pageBreak: page(4.5, 2.5, 11, 15, 0) + p('M4.5 10h11', 'b dash') + t(10, 8, '1', 4.5, { c: 'txb' }) + t(10, 15, '2', 4.5, { c: 'txb' }),
  zoomIn: magnifier(8.5, 8.5, 5.5) + p('M6 8.5h5M8.5 6v5', 'o'),
  zoomOut: magnifier(8.5, 8.5, 5.5) + p('M6 8.5h5', 'o'),
  zoom100: magnifier(8.5, 8.5, 5.5, 'bw') + t(8.5, 10.4, '100', 4.6, { weight: 700, c: 'txb' }),
  zoomSelection: magnifier(8.5, 8.5, 5.5, 'of') + r(5.5, 6, 6, 5, 'bf'),
  pin: cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'of' }) + r(2.5, 3.5, 15, 4.33, 'bw') + r(2.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }) + p('M2.5 7.83h15M7.5 3.5v13', 'b thick'),
  freeze: cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'of' }) + r(2.5, 3.5, 15, 4.33, 'bw') + r(2.5, 3.5, 5, 13, 'bw') + cells(2.5, 3.5, 15, 13, 3, 3, { frame: 'o' }) + p('M2.5 7.83h15M7.5 3.5v13', 'b thick'),
  split: r(2.5, 3.5, 15, 13, 'of', 2) + r(2.5, 3.5, 7.5, 6.5, 'bw') + p('M10 3.5v13M2.5 10h15', 'b thick'),
  showHide: p('M1.5 10s3-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3 5.5-8.5 5.5S1.5 10 1.5 10z', 'of') + ci(10, 10, 3, 'bs') + ci(11, 9, 0.9, 'glint'),
  // Custom Views: a saved arrangement of the window, two views stacked with an eye on the front one.
  customViews: r(2.5, 3, 11, 9, 'of', 1.6) + r(6.5, 7.5, 11, 9.5, 'bf', 1.6) + p('M8.5 12.25s1.6-2.6 3.5-2.6 3.5 2.6 3.5 2.6-1.6 2.6-3.5 2.6-3.5-2.6-3.5-2.6z', 'of') + ci(12, 12.25, 1.2, 'bs'),
  // Sheet View: a sheet seen through one person's own eye.
  sheetView: cells(2.5, 2.5, 13, 11, 3, 3, { frame: 'of' }) + ci(14, 14.5, 4.3, 'knock') + p('M9.5 14.5s2-3 4.5-3 4.5 3 4.5 3-2 3-4.5 3-4.5-3-4.5-3z', 'pf') + ci(14, 14.5, 1.3, 'ps'),
  // Selection Pane: the objects on the sheet, listed in a panel beside them.
  selectionPane: r(2.5, 4.5, 6, 5, 'bf', 1) + ci(6.5, 13, 2.5, 'gf') + r(10.5, 2.5, 7, 15, 'of', 1.4) + p('M12 6h4M12 9.5h4M12 13h4', 'o') + ci(12, 6, .6, 'bs') + ci(12, 9.5, .6, 'bs'),
  // Arrange: objects lined up along a common edge.
  alignObjects: p('M3.5 2.5v15', 'b thick') + r(5, 4.5, 11, 4, 'bf', 1) + r(5, 11.5, 7, 4, 'gf', 1),
  // Group: two shapes inside one dashed frame with handles at its corners.
  groupObjects: r(2.5, 2.5, 15, 15, 'o dash ln', 0) + r(4.5, 4.5, 6.5, 5.5, 'bf', 1) + ci(12.5, 12.5, 3.3, 'gf') + r(1.5, 1.5, 2, 2, 'bs', 0) + r(16.5, 1.5, 2, 2, 'bs', 0) + r(1.5, 16.5, 2, 2, 'bs', 0) + r(16.5, 16.5, 2, 2, 'bs', 0),
  // Bring Forward and Send Backward: two overlapping sheets, the one moving drawn solid on top or tucked beneath.
  bringForward: r(2.5, 2.5, 9, 9, 'of', 1.4) + r(8.5, 8.5, 9, 9, 'of', 1.4) + r(5.5, 5.5, 9, 9, 'bs', 1.4),
  sendBackward: r(5.5, 5.5, 9, 9, 'bf', 1.4) + r(2.5, 2.5, 9, 9, 'of', 1.4) + r(8.5, 8.5, 9, 9, 'of', 1.4),
  // Exit a view: an arrow leaving a sheet.
  exitView: cells(6.5, 3.5, 11, 13, 2, 3, { frame: 'of' }) + p('M10 10H2.5M5.5 7 2.5 10l3 3', 'b thick'),
  // Rotate: a shape and the turning arrow around it (Rotate Left turns the other way).
  rotateObjects: p('M7 6.5 13.5 13l-6.5 3.5z', 'bf') + p('M4 10a6 6 0 0 1 10.5-4M14.5 3v3h-3', 'b thick'),
  rotateLeft: p('M13 6.5 6.5 13l6.5 3.5z', 'bf') + p('M16 10a6 6 0 0 0-10.5-4M5.5 3v3h3', 'b thick'),
  // Flips: a shape and its mirror image across a dashed axis.
  flipH: p('M10 2.5v15', 'o dash') + p('M8.5 5 2.5 15h6z', 'bf') + p('M11.5 5l6 10h-6z', 'o'),
  flipV: p('M2.5 10h15', 'o dash') + p('M5 8.5 15 2.5v6z', 'bf') + p('M5 11.5l10 6v-6z', 'o'),
  // Distribute: three objects with equal gaps along the axis.
  distributeH: p('M2.5 3v14M17.5 3v14', 'o ln') + r(4, 6, 3, 8, 'bf', 0.8) + r(8.5, 4, 3, 12, 'bf', 0.8) + r(13, 7, 3, 6, 'bf', 0.8),
  distributeV: p('M3 2.5h14M3 17.5h14', 'o ln') + r(6, 4, 8, 3, 'bf', 0.8) + r(4, 8.5, 12, 3, 'bf', 0.8) + r(7, 13, 6, 3, 'bf', 0.8),
  hideEye: p('M1.5 10s3-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3 5.5-8.5 5.5S1.5 10 1.5 10z', 'of') + ci(10, 10, 3, 'bs') + p('M3 17 17 3', 'r thick'),
  focus: p('M2.5 7V3.5a1 1 0 0 1 1-1H7M13 2.5h3.5a1 1 0 0 1 1 1V7M17.5 13v3.5a1 1 0 0 1-1 1H13M7 17.5H3.5a1 1 0 0 1-1-1V13', 'o') + r(6.5, 6.5, 7, 7, 'bf'),
  fullscreen: r(2.5, 3.5, 15, 10, 'of', 1.6) + r(3.8, 4.8, 12.4, 7.4, 'bs', 0.8) + p('M7 17.5h6M10 13.5v4', 'o'),
  windows: r(2.5, 3.5, 11, 9, 'of', 1.6) + r(6.5, 7.5, 11, 9, 'bf glassy', 1.6) + p('M6.5 10.5h11', 'b'),

  /* Quick access and file */
  // Options: a panel of three sliders. Customize the Ribbon: a tab strip over its commands. Quick Access: a short
  // bar of buttons with the arrow that customizes it. Keyboard: keys with one picked out.
  options: r(2.5, 3, 15, 14, 'of', 1.6) + p('M5 7h10M5 10h10M5 13h10', 'o ln') + ci(8, 7, 1.6, 'bs') + ci(12.5, 10, 1.6, 'bs') + ci(7, 13, 1.6, 'bs'),
  customizeRibbon: r(2.5, 6, 15, 10.5, 'of', 1.6) + r(2.5, 3.5, 5, 2.5, 'bs', 0.8) + r(8, 3.5, 4, 2.5, 'of', 0.8) + r(5, 9, 4, 4.5, 'bf', 0.8) + r(10.5, 9, 4, 4.5, 'of', 0.8),
  customizeQuickAccess: r(2.5, 6.5, 15, 7, 'of', 1.6) + r(4.3, 8.5, 3, 3, 'bs', 0.6) + r(8.3, 8.5, 3, 3, 'of', 0.6) + p('M13.3 9.3l1.5 1.5 1.5-1.5', 'o thick'),
  customizeKeyboard: r(2, 5, 16, 10, 'of', 1.6) + p('M5 8h1M8 8h1M11 8h1M14 8h1M5 11h1M14 11h1', 'o thick') + r(7.5, 10, 5, 2, 'bs', 0.6),
  save: p('M5 3.5h9l2.5 2.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5z', 'bs') + r(6, 3.5, 7, 4.5, 'of', 0.6) + r(6, 11, 8, 5.5, 'of', 0.6),
  undo: p('M7 4.5 3.5 8 7 11.5', 'o thick') + p('M3.5 8h8.5a4.5 4.5 0 0 1 0 9H8', 'o thick'),
  redo: p('M13 4.5 16.5 8 13 11.5', 'o thick') + p('M16.5 8H8a4.5 4.5 0 0 0 0 9h4', 'o thick'),
  folderOpen: p('M2.5 15.5v-10a1 1 0 0 1 1-1h4l1.5 1.5h7a1 1 0 0 1 1 1v2', 'bf') + p('M2.5 15.5l2.3-6.2a1 1 0 0 1 .9-.6h12l-2.3 6.2a1 1 0 0 1-.9.6z', 'bs'),
  filePlus: page(4.5, 2.5, 11, 15) + badge(14.5, 14.5, 'plus'),
  download: p('M3.5 13.5v3h13v-3', 'o') + arrowDown(10, 3, 10),
  external: p('M15.5 11.5v5h-12v-12h5', 'o') + p('M11.5 3.5h5v5M16.5 3.5l-7 7', 'b thick'),
  deleteItem: p('M3.5 5.5h13M8 5.5V3.5h4v2', 'o') + p('M5 5.5l1 11a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-11', 'of') + p('M8.5 8.5v6M11.5 8.5v6', 'r'),
  scaleDown: page(4.5, 2.5, 11, 15),
  // Totals under a block (its last row shaded) and beside it (its last column shaded).
  totalRow: cells(3.5, 3.5, 13, 13, 3, 4, { frame: 'o' }) + r(3.5, 13.25, 13, 3.25, 'bf'),
  totalCol: cells(3.5, 3.5, 13, 13, 4, 3, { frame: 'o' }) + r(13.25, 3.5, 3.25, 13, 'yf'),
  // A block of cells with a lightning bolt over its corner: one-click analysis of a selection.
  quickAnalysis: cells(2.5, 2.5, 11, 11, 2, 3, { frame: 'o' }) + p('M14.5 9.5l-3 5h3l-1.5 4 4-6h-3l1.5-3z', 'yf'),
  // A figure with open arms beside a check: an inspection for people who use assistive technology.
  accessibility: ci(8, 4, 1.8, 'bs') + p('M3 7.5h10M8 7.5v5M8 12.5l-3 5M8 12.5l3 5', 'o thick') + badge(15, 15, 'check'),
  // A picture with lines of description beside it.
  altText: r(2.5, 4.5, 9, 8, 'bw') + r(2.5, 4.5, 9, 8, 'o') + p('M3.5 11.5l2.6-3 2 2 1.4-1.4 1.5 2.4', 'g') + ci(8.6, 7, 0.9, 'yf') + lines(13.5, 6, 4, 3, 2.5),
};
Object.assign(COMMAND_ICONS, { decLess: COMMAND_ICONS.decimalLess, decMore: COMMAND_ICONS.decimalMore, errorCheck2: COMMAND_ICONS.errorCheck, pageBreak2: COMMAND_ICONS.pageBreak });

/* Draw tab. A pen's tip, band or body takes its ink colour from --pen-color (class ink: solid, inkf: with an outline). */
const squiggle = (c = 'b') => p('M2.5 17c1.5-1.6 3-1.6 4 0s2.6 1.6 4 0', c);
Object.assign(COMMAND_ICONS, {
  inkSelect: p('M5.5 2.5v13.2l3.3-3.2 2.3 5 2.3-1.1-2.3-4.9h4.6z', 'of'),
  lasso: p('M10 3c4.1 0 7 1.8 7 4.2s-2.9 4.3-7 4.3-7-1.9-7-4.3S5.9 3 10 3z', 'o dash') + p('M6.4 10.9c-1 1.2-.8 2.6.5 3.1s1.6 1.6.8 2.7-2.3 1.2-3.2.6', 'b') + ci(6.6, 10.6, 1, 'bs'),
  inkEraser: p('M11.8 3.2l4.9 4.9-6.6 6.6H6.3l-2.4-2.4v-2.5z', 'rf') + p('M8.4 6.6l4.9 4.9', 'o') + p('M3.9 12.3v-2.5l4.5-3.2 4.9 4.9-3.2 3.2H6.3z', 'of') + p('M12 17.5h5.5', 'o ln'),
  inkPen: p('M14.6 2.4a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L9.2 13.8l-3-3z', 'inkf') + p('M13.4 3.6l3 3', 'o ln') + p('M6.2 10.8l3 3-4.6 1.7-.2-.2z', 'of') + p('M3.4 15.6l1 1-2 .8z', 'ink'),
  inkPencil: p('M14.6 2.2l3.2 3.2-9.7 9.7-3.2-3.2z', 'inkf') + p('M14.6 2.2l1-1 3.2 3.2-1 1', 'rf') + p('M4.9 11.9l3.2 3.2-5.3 2.1z', 'nf') + p('M3.6 15.7l.7.7-1.5.8z', 'ink'),
  inkHighlighter: p('M12.7 2.5l4.8 4.8-6 6-4.8-4.8z', 'of') + p('M6.7 8.5l4.8 4.8-1.8 1.8-4.8-4.8z', 'inkf') + p('M4.9 10.3l4.8 4.8-1.6 1.6-3.8-1z', 'inkf') + r(2, 17, 9, 1.8, 'ink'),
  addPen: p('M14.2 2.4l2.4 2.4-8 8-2.4-2.4z', 'of') + p('M6.2 10.4l2.4 2.4-4.2 1.8z', 'bf') + p('M15 12.5v6M12 15.5h6', 'g thick'),
  inkToShape: p('M2.5 8.5c.4-3 2.6-5 5-4.3s1.8 3.3-.4 4.4-3.8 1.2-4.6-.1', 'o') + arrowRight(7.8, 10.2, 3.6, 'o') + r(12.5, 7.5, 5.5, 5.5, 'bf') + ci(8.5, 15.8, 2.2, 'gf'),
  drawTouch: p('M9.6 18.5v-3.4l-2.4-2.7a1.1 1.1 0 0 1 1.6-1.5l1.4 1.3V5a1.1 1.1 0 0 1 2.2 0v5l3.3.7a1.4 1.4 0 0 1 1.1 1.6l-.6 3.6-.9 2.6', 'of') + p('M1.8 7.5c1.3-2.4 2.7-2.4 3.4-.6s1.8 1.9 3-.2', 'b thick'),
});

/* Chart subtypes (Insert ▸ Charts galleries) and the Chart Design and Format tabs. */
const hbar = (y, w, c, x = 3.5, h = 2.4) => r(x, y, w, h, solid(c), 0.7);
const vstack = (x, parts, w = 2.6, base = 16.5) => { let y = base; return parts.map(([h, c]) => { y -= h; return r(x, y, w, h, solid(c)); }).join(''); };
const hstack = (y, parts, h = 2.4, x0 = 3.5) => { let x = x0; return parts.map(([w, c]) => { const out = r(x, y, w, h, solid(c)); x += w; return out; }).join(''); };
const dots = (pts, c = 'bs') => pts.map(([x, y]) => ci(x, y, 1.1, c)).join('');
const barAxes = p('M3.5 3v13.5H17', 'o');
Object.assign(COMMAND_ICONS, {
  chartColumnClustered: chartAxes + r(5, 9.5, 2.2, 7, 'bf') + r(7.2, 6.5, 2.2, 10, 'nf') + r(11, 7.5, 2.2, 9, 'bf') + r(13.2, 4.5, 2.2, 12, 'nf'),
  chartColumnStacked: chartAxes + vstack(5.5, [[4, 'bf'], [3, 'nf']]) + vstack(9.5, [[6, 'bf'], [4, 'nf']]) + vstack(13.5, [[5, 'bf'], [6, 'nf']]),
  chartColumnStacked100: chartAxes + vstack(5.5, [[5, 'bf'], [8, 'nf']]) + vstack(9.5, [[8, 'bf'], [5, 'nf']]) + vstack(13.5, [[6, 'bf'], [7, 'nf']]),
  chartBarClustered: barAxes + hbar(4, 7, 'bf') + hbar(6.4, 10, 'nf') + hbar(10, 9, 'bf') + hbar(12.4, 12, 'nf'),
  chartBarStacked: barAxes + hstack(4.5, [[5, 'bf'], [3, 'nf']]) + hstack(8.5, [[7, 'bf'], [4, 'nf']]) + hstack(12.5, [[4, 'bf'], [6, 'nf']]),
  chartBarStacked100: barAxes + hstack(4.5, [[6, 'bf'], [7, 'nf']]) + hstack(8.5, [[9, 'bf'], [4, 'nf']]) + hstack(12.5, [[5, 'bf'], [8, 'nf']]),
  chartLinePlain: chartAxes + p('M4.5 12.5l3.5-4 3 2.5 5-6', 'b thick') + p('M4.5 15l3.5-2 3 1 5-3.5', 'n thick'),
  chartLineStacked: chartAxes + p('M4.5 13.5l4-2 3.5 1 4.5-2.5', 'b thick') + p('M4.5 9.5l4-3 3.5 1.5 4.5-4', 'n thick'),
  chartLineStacked100: chartAxes + p('M4.5 4.5h12', 'n thick') + p('M4.5 11l4-3 3.5 2 4.5-3', 'b thick'),
  chartLineMarkers: chartAxes + p('M4.5 12.5l3.5-4 3 2.5 5-6', 'b') + dots([[4.5, 12.5], [8, 8.5], [11, 11], [16, 5]]) + p('M4.5 15l3.5-2 3 1 5-3.5', 'n') + dots([[8, 13], [11, 14], [16, 10.5]], 'ns'),
  chartLineStackedMarkers: chartAxes + p('M4.5 13.5l4-2 3.5 1 4.5-2.5', 'b') + dots([[4.5, 13.5], [8.5, 11.5], [12, 12.5], [16.5, 10]]) + p('M4.5 9.5l4-3 3.5 1.5 4.5-4', 'n') + dots([[4.5, 9.5], [8.5, 6.5], [12, 8], [16.5, 4]], 'ns'),
  chartLineStacked100Markers: chartAxes + p('M4.5 4.5h12', 'n') + dots([[4.5, 4.5], [10.5, 4.5], [16.5, 4.5]], 'ns') + p('M4.5 11l4-3 3.5 2 4.5-3', 'b') + dots([[4.5, 11], [8.5, 8], [12, 10], [16.5, 7]]),
  chartDoughnut: p('M10 2.5a7.5 7.5 0 1 1-7.5 7.5H6a4 4 0 1 0 4-4z', 'bs') + p('M10 2.5V6a4 4 0 0 0-4 4H2.5A7.5 7.5 0 0 1 10 2.5z', 'ns'),
  chartAreaStacked: chartAxes + p('M3.5 16.5v-6l4-2.5 4 2 5-3v9.5z', 'nf') + p('M3.5 16.5v-3l4-1.5 4 1 5-2v5.5z', 'bf'),
  chartAreaStacked100: chartAxes + r(3.5, 3.5, 13, 13, 'nf') + p('M3.5 16.5V9l4-2 4 3 5-4v10.5z', 'bf'),
  chartScatterSmoothMarkers: chartAxes + p('M4.5 14c3-6 5-7 7-5s3 1 5-5', 'b') + dots([[4.5, 14], [8.5, 8.6], [12.5, 9.8], [16.5, 4]]),
  chartScatterSmooth: chartAxes + p('M4.5 14c3-6 5-7 7-5s3 1 5-5', 'b thick') + p('M4.5 16c3-3 6-4 12-4', 'n thick'),
  chartScatterLinesMarkers: chartAxes + p('M4.5 14l4-5.5 4 1.5 4-6', 'b') + dots([[4.5, 14], [8.5, 8.5], [12.5, 10], [16.5, 4]]),
  chartScatterLines: chartAxes + p('M4.5 14l4-5.5 4 1.5 4-6', 'b thick') + p('M4.5 16l5-2.5 7-1', 'n thick'),
  chartRadarMarkers: p('M10 2.5l7 5-2.7 8.5H5.7L3 7.5z', 'o') + p('M10 5.5l4.5 3.2-1.8 5.3H7.3L5.5 8.7z', 'b') + dots([[10, 5.5], [14.5, 8.7], [12.7, 14], [7.3, 14], [5.5, 8.7]]),
  chartRadarFilled: p('M10 2.5l7 5-2.7 8.5H5.7L3 7.5z', 'o') + p('M10 4.5l5.5 4-2.2 6.5H6.7L4.5 8.5z', 'bf'),
  chartComboSecondary: chartAxes + p('M17 3v13.5', 'o') + columns([[5, 'bf'], [9, 'bf'], [7, 'bf']]) + p('M5.5 7.5l4-3 4 4 3.5-3', 'n thick'),
  // Chart Design: a plot with a plus; layouts as tiles; colour chips; a swap of rows and columns.
  addChartElement: chartAxes + columns([[5, 'bf'], [8, 'bf']], 5) + badge(14.5, 6.5, 'plus'),
  quickLayout: r(2.5, 3.5, 15, 13, 'of', 1) + r(4.5, 5, 11, 2, 'bw') + r(4.5, 8.5, 7, 6, 'bf') + lines(13, 9.5, 2.5, 3, 2),
  changeColors: r(2.5, 4.5, 4, 11, 'bs') + r(8, 4.5, 4, 11, 'ns') + r(13.5, 4.5, 4, 11, 'gs'),
  chartStyles: r(2.5, 3.5, 15, 13, 'of', 1) + columns([[4, 'bs'], [7, 'ns'], [5, 'bs']], 5, 2.6, 1.4, 14.5) + p('M4.5 6h11', 'o ln'),
  switchRowCol: cells(2.5, 2.5, 9, 9, 3, 3, { head: 'bw' }) + arrowRight(11, 6, 5.5, 'b') + arrowDown(6, 11, 5.5, 'n') + r(14, 13, 3.5, 3.5, 'nf'),
  selectData: cells(2.5, 3.5, 11, 11, 2, 4, { head: 'bw' }) + r(10.5, 10.5, 7, 7, 'of') + columns([[2.5, 'bs'], [4.5, 'ns']], 12, 1.6, 1, 16.5),
  changeChartType: chartAxes + columns([[5, 'bf'], [9, 'bf']], 5) + p('M11.5 12l2.5-4 3 2', 'n thick') + p('M13 2.5a3 3 0 0 1 4 1.5', 'o') + p('M17.3 2.2l-.3 1.9-1.8-.6', 'o'),
  moveChart: r(2.5, 5.5, 10, 9, 'of') + columns([[3, 'bf'], [5, 'bf']], 4.5, 2, 1.2, 13) + p('M11 3.5h6.5V10', 'b') + p('M17.5 3.5l-6 6', 'b thick'),
  shapeFill: p('M4 9l5-5 6 6-5 5z', 'of') + p('M4 9h11', 'o ln') + p('M16.5 11.5c.9 1.4 1.4 2.2 1.4 2.9a1.4 1.4 0 0 1-2.8 0c0-.7.5-1.5 1.4-2.9z', 'bs') + r(2.5, 16.5, 15, 2, 'ys'),
  shapeOutline: r(4.5, 3.5, 11, 10, 'o thick', 1) + p('M3 17.5h14', 'b thick'),
  shapeEffects: r(5.5, 5.5, 10, 10, 'nw') + r(3.5, 3.5, 10, 10, 'bf', 1),
  formatSelection: r(2.5, 3.5, 11, 11, 'o dash') + r(1.5, 2.5, 2, 2, 'bs') + r(12.5, 13.5, 2, 2, 'bs') + p('M10 10l7 7M17 13v4h-4', 'b'),
  resetStyle: r(3.5, 3.5, 11, 11, 'of', 1) + p('M7 7a4 4 0 1 1-1 4', 'b') + p('M5 6.5l1.5 1.5L8 6.5', 'b'),
});

/* The pie variants and the newer chart types: hierarchies, statistics, funnels, prices and surfaces. */
/** A ring sector about (cx, cy) from radius r0 to r1, between angles a0 and a1 (degrees clockwise from the top). */
const sector = (cx, cy, r0, r1, a0, a1, c) => {
  const pt = (rad, a) => { const t = (a * Math.PI) / 180; return `${+(cx + rad * Math.sin(t)).toFixed(2)} ${+(cy - rad * Math.cos(t)).toFixed(2)}`; };
  const large = a1 - a0 > 180 ? 1 : 0;
  return p(`M${pt(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)}${r0 ? `L${pt(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)}` : `L${cx} ${cy}`}z`, c);
};
/** A price period: its high-low line, and an open-close bar (`bar` solid when the price fell) or a close tick. */
const candle = (x, hi, lo, open, close, c = 'bs') => p(`M${x} ${hi}V${lo}`, 'o') + (open == null ? p(`M${x} ${close}h1.8`, 'o thick') : r(x - 1, Math.min(open, close), 2, Math.abs(close - open), close < open ? 'of' : c, 0.3));
/** The floor of a surface seen from above and to the side, as a mesh of `n` × `n` cells. */
const meshFloor = (n, c) => {
  const at = (u, v) => `${+(2.5 + u * 8 + v * 7).toFixed(2)} ${+(12 + u * 4.5 - v * 5).toFixed(2)}`;
  let d = '';
  for (let i = 0; i <= n; i++) d += `M${at(i / n, 0)}L${at(i / n, 1)}M${at(0, i / n)}L${at(1, i / n)}`;
  return p(d, c);
};
Object.assign(COMMAND_ICONS, {
  chartPieExploded: p('M9 4a6.5 6.5 0 1 0 6.5 6.5H9z', 'bs') + p('M11 2.5a6.5 6.5 0 0 1 6.5 6.5H11z', 'ns'),
  chartDoughnutExploded: sector(9.5, 10.5, 3.6, 7, 90, 360, 'bs') + sector(10.5, 9.5, 3.6, 7, 0, 90, 'ns'),
  chartPieOfPie: sector(6.5, 10, 0, 5, 50, 410, 'bs') + sector(6.5, 10, 0, 5, 50, 130, 'ns') + p('M10.4 6.8l4.6-1.6M10.4 13.2l4.6 1.6', 'o ln') + sector(15.5, 10, 0, 3, 0, 200, 'ns') + sector(15.5, 10, 0, 3, 200, 360, 'ys'),
  chartBarOfPie: sector(6.5, 10, 0, 5, 50, 410, 'bs') + sector(6.5, 10, 0, 5, 50, 130, 'ns') + p('M10.4 6.8l4.1-2.8M10.4 13.2l4.1 2.8', 'o ln') + r(14.5, 4, 3, 7, 'ns', 0.3) + r(14.5, 11, 3, 5, 'ys', 0.3),
  chartTreemap: r(2.5, 3.5, 7.5, 13, 'bs', 0.6) + r(10.75, 3.5, 6.75, 6.5, 'ns', 0.6) + r(10.75, 10.75, 3, 5.75, 'gs', 0.6) + r(14.5, 10.75, 3, 5.75, 'ys', 0.6),
  chartSunburst: sector(10, 10, 2.6, 5, 0, 220, 'bs') + sector(10, 10, 2.6, 5, 220, 360, 'ns') + sector(10, 10, 5.6, 8, 0, 130, 'bf') + sector(10, 10, 5.6, 8, 130, 220, 'bf')
    + sector(10, 10, 5.6, 8, 220, 300, 'nf'),
  chartBoxWhisker: chartAxes + p('M7 4.5v3M7 13v2.5M6 4.5h2M6 15.5h2M13.5 6v2M13.5 12v2.5M12.5 6h2M12.5 14.5h2', 'o') + r(5.5, 7.5, 3, 5.5, 'bf', 0.5) + p('M5.5 10.5h3', 'b thick')
    + r(12, 8, 3, 4, 'nf', 0.5) + p('M12 10h3', 'n thick') + ci(13.5, 3.8, 0.8, 'o'),
  chartFunnel: r(2.5, 3, 15, 2.8, 'bs', 0.6) + r(4.5, 6.7, 11, 2.8, 'bs', 0.6) + r(6.5, 10.4, 7, 2.8, 'ns', 0.6) + r(8, 14.1, 4, 2.8, 'ns', 0.6),
  chartStockHlc: chartAxes + candle(6.5, 6, 13, null, 10) + candle(10.5, 4, 11, null, 7) + candle(14.5, 7, 14.5, null, 12),
  chartStockOhlc: chartAxes + candle(6.5, 5, 14, 12, 7) + candle(10.5, 3.5, 12, 6, 10) + candle(14.5, 6, 14.5, 13, 8),
  chartStockVhlc: chartAxes + columns([[3, 'nf'], [4.5, 'nf'], [2.5, 'nf']], 5.2, 2.6, 1.4) + candle(6.5, 4, 10, null, 7) + candle(10.5, 3, 9, null, 5) + candle(14.5, 5, 11, null, 9),
  chartStockVohlc: chartAxes + columns([[3, 'nf'], [4.5, 'nf'], [2.5, 'nf']], 5.2, 2.6, 1.4) + candle(6.5, 3.5, 11, 9.5, 5) + candle(10.5, 3, 10, 4.5, 8.5) + candle(14.5, 4.5, 11.5, 10, 6),
  chartSurface: p('M2.5 12c2-3 4-1 6-3s3-4 5-3l4 1.5L11 10c-2 1-3 3.5-5 4z', 'ns') + p('M2.5 12l3.5 2c2-.5 3-3 5-4l6.5-2.5L10.5 16.5z', 'bs') + meshFloor(3, 'o ln'),
  chartSurfaceWireframe: meshFloor(3, 'o ln') + p('M2.5 11c2-2 4-3 6-2.5s4-3 6-3.5l3 1.5M4.5 12.8c2-2 4-2 6-1.5s4-2.5 6-2.5M7 14.2c2-1.5 4-2 6-1s3-2 4.5-2', 'b')
    + p('M2.5 11l8 4.5M6 9.4l7.5 4.6M10 8.5l6.5 3.5M14 6.6l3.5 1.9', 'n'),
  chartContour: r(2.5, 3.5, 15, 13, 'bs', 1) + p('M5 15.5c-1-4 2-8 6-9s6 2 5 6-3 3-6 3.5S5.5 17 5 15.5z', 'ns') + p('M8.5 12c0-2 1.5-3.5 3.5-3.5s2.5 2 1.5 3.5-2 1.5-3.5 1.5-1.5-.5-1.5-1.5z', 'ys'),
  chartContourWireframe: r(2.5, 3.5, 15, 13, 'o', 1) + p('M5 15.5c-1-4 2-8 6-9s6 2 5 6-3 3-6 3.5S5.5 17 5 15.5z', 'b') + p('M8.5 12c0-2 1.5-3.5 3.5-3.5s2.5 2 1.5 3.5-2 1.5-3.5 1.5-1.5-.5-1.5-1.5z', 'n'),
});

/* ---- Automate: scripts, drawn as pages and windows of code in braces ---- */
/** A pair of curly braces about (cx, cy), `h` tall and `w` apart. */
const braces = (cx, cy, h = 6, w = 5, c = 'b') => {
  const t = cy - h / 2, b = cy + h / 2, l = cx - w / 2, r = cx + w / 2;
  return p(`M${l + 1} ${t}c-.8 0-1 .4-1 1v${h / 2 - 1.6}c0 .4-.3.6-.8.6.5 0 .8.2.8.6v${h / 2 - 1.6}c0 .6.2 1 1 1`
    + `M${r - 1} ${t}c.8 0 1 .4 1 1v${h / 2 - 1.6}c0 .4.3.6.8.6-.5 0-.8.2-.8.6v${h / 2 - 1.6}c0 .6-.2 1-1 1`, `${c} thick`);
};
const scriptPage = (c = 'b') => page(3.5, 2.5, 13, 15, 3.5) + braces(10, 11.5, 7, 6, c);
Object.assign(COMMAND_ICONS, {
  recordActions: ci(10, 10, 7.5, 'of') + ci(10, 10, 4.2, 'rs') + ci(8.6, 8.6, 1.1, 'glint'),
  stopScript: r(4.5, 4.5, 11, 11, 'rs', 2.2),
  runScript: ci(10, 10, 7.5, 'gs') + p('M8.3 6.6v6.8l5.4-3.4z', 'wh thick') + p('M8.9 7.7v4.6l3.6-2.3z', 'glint'),
  newScript: page(2.5, 2.5, 12.5, 15, 3.5) + braces(8.5, 11.5, 7, 5.5) + badge(15, 15, 'plus'),
  scriptFile: scriptPage(),
  scriptSample: scriptPage('n') + ci(14.5, 4.5, 2.6, 'knock') + p('M14.5 2.3l.6 1.5 1.6.1-1.2 1 .4 1.6-1.4-.9-1.4.9.4-1.6-1.2-1 1.6-.1z', 'ys'),
  scriptLibrary: p('M2.5 5a1 1 0 0 1 1-1h4l1.6 1.8h7.4a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z', 'yf') + braces(10, 11.6, 6, 6),
  codeEditor: r(2.5, 3, 15, 14, 'of', 1.6) + p('M2.5 6.2h15', 'o') + ci(4.6, 4.6, 0.55, 's') + ci(6.4, 4.6, 0.55, 's')
    + p('M7.6 9.6 5.4 11.8l2.2 2.2M12.4 9.6l2.2 2.2-2.2 2.2', 'b thick') + p('M10.9 9.2 9.1 14.4', 'o'),
  allScripts: r(2.5, 2.5, 6.5, 6.5, 'bf', 1.2) + r(11, 2.5, 6.5, 6.5, 'of', 1.2) + r(2.5, 11, 6.5, 6.5, 'of', 1.2) + r(11, 11, 6.5, 6.5, 'of', 1.2)
    + braces(5.75, 5.75, 3.6, 3.4) + lines(12.6, 5, 3.4, 2, 1.8) + lines(4.1, 13.5, 3.4, 2, 1.8) + lines(12.6, 13.5, 3.4, 2, 1.8),
  scriptReference: p('M10 5.2C8.4 4 6.2 3.5 3 3.8v11.6c3.2-.3 5.4.2 7 1.4 1.6-1.2 3.8-1.7 7-1.4V3.8c-3.2-.3-5.4.2-7 1.4z', 'of') + p('M10 5.2v11.6', 'o')
    + p('M6.8 7.6c-.6 0-.8.3-.8.7v.9c0 .3-.2.5-.6.5.4 0 .6.2.6.5v.9c0 .4.2.7.8.7M13.2 7.6c.6 0 .8.3.8.7v.9c0 .3.2.5.6.5-.4 0-.6.2-.6.5v.9c0 .4-.2.7-.8.7', 'b'),
  highlightDuplicates: cells(2.5, 3.5, 15, 13, 3, 4) + r(7.5, 6.75, 5, 3.25, 'ys') + r(2.5, 13.25, 5, 3.25, 'ys') + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' }),
  unhideAll: p('M1.8 10S4.8 4.6 10 4.6 18.2 10 18.2 10 15.2 15.4 10 15.4 1.8 10 1.8 10z', 'of') + ci(10, 10, 3, 'bs') + ci(9, 9, 0.9, 'glint'),
  sumColumns: cells(2.5, 2.5, 15, 10, 3, 3) + r(2.5, 13.5, 15, 4, 'gf', 1) + p('M5 14.6h3.4L6.6 15.5l1.8.9H5', 'g'),
  tableOfContents: page(3.5, 2.5, 13, 15, 3.5) + ci(6.6, 7.6, 0.9, 'bs') + ci(6.6, 10.6, 0.9, 'bs') + ci(6.6, 13.6, 0.9, 'bs') + lines(8.6, 7.6, 5, 3, 3, 'b'),
  styleHeaderRow: cells(2.5, 3.5, 15, 13, 3, 4, { head: 'bs' }) + p('M2.5 6.75h15', 'b thick') + p('M14.5 1.8v4.4M12.6 2.9l3.8 2.2M12.6 5.1l3.8-2.2', 'b'),
  removeBlankRows: cells(2.5, 3.5, 13, 13, 2, 4) + r(2.5, 9.9, 13, 3.2, 'rw') + badge(15.5, 15, 'minus', 'r'),
  // A button drawn on the sheet, with the pointer that presses it.
  scriptButton: r(2, 4.5, 15, 9, 'gs', 2.4) + p('M7.4 6.9v4.2l3.6-2.1z', 'glint') + p('M12.5 10.5l5 5-2 .3 1.2 2.4-1.2.6-1.2-2.4-1.6 1.4z', 'of'),
});

/* ---- Pictures: in cells, linked, and the Picture Format tab ---- */
/** A small landscape picture in the box (x, y, w, h): sky, a hill and the sun. */
const photo = (x, y, w, h, frame = 'bf') => r(x, y, w, h, frame, 1.2)
  + p(`M${x} ${y + h * 0.78}l${w * 0.3}-${h * 0.38} ${w * 0.24} ${h * 0.26} ${w * 0.16}-${h * 0.16} ${w * 0.3} ${h * 0.28}v${h * 0.22}h-${w}z`, 'gs')
  + ci(x + w * 0.7, y + h * 0.3, Math.min(w, h) * 0.12, 'ys');
Object.assign(COMMAND_ICONS, {
  // Crop: the two corner brackets of a crop frame over the picture.
  crop: photo(6, 6, 8, 8, 'bw') + p('M6 2.5v11.5h11.5', 'o thick') + p('M2.5 6h11.5v11.5', 'b thick'),
  // Corrections: a sun half in light, half in shade.
  corrections: ci(10, 10, 4.2, 'of') + p('M10 5.8a4.2 4.2 0 0 1 0 8.4z', 'ys')
    + p('M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4', 'o'),
  pictureColor: ci(7.6, 7.8, 4.3, 'rf') + ci(12.4, 7.8, 4.3, 'gf') + ci(10, 12.2, 4.3, 'bf'),
  // Transparency: a picture fading into a checked ground.
  transparency: r(2.5, 3.5, 15, 13, 'of', 1.6) + r(2.5, 3.5, 3.75, 3.25, 'nw') + r(10, 3.5, 3.75, 3.25, 'nw') + r(6.25, 6.75, 3.75, 3.25, 'nw')
    + r(13.75, 6.75, 3.75, 3.25, 'nw') + r(2.5, 10, 3.75, 3.25, 'nw') + r(10, 10, 3.75, 3.25, 'nw') + r(6.25, 13.25, 3.75, 3.25, 'nw') + r(13.75, 13.25, 3.75, 3.25, 'nw')
    + p('M2.5 16.5 17.5 3.5v13z', 'bw') + r(2.5, 3.5, 15, 13, 'o', 1.6),
  resetPicture: photo(2.5, 2.5, 11, 10) + ci(14.5, 14.5, 4.4, 'knock') + p('M11.4 14.2a3.1 3.1 0 1 0 1-2.4', 'b thick') + p('M11 10.6v2.2h2.2', 'b thick'),
  // Picture Styles: a framed picture lifted off the page by its shadow.
  pictureStyles: r(4.5, 5, 13, 12, 'nw', 1.4) + r(2.5, 3, 13, 12, 'of', 1.4) + photo(4.5, 5, 9, 8),
  // Place in Cell: a picture settled into one cell of the grid.
  placeInCell: cells(2.5, 3.5, 15, 13, 2, 2) + photo(3.4, 4.4, 5.7, 4.7, 'bw') + cells(2.5, 3.5, 15, 13, 2, 2, { frame: 'o' }),
  // Place over Cells: the picture lifted out of its cell to float above the grid.
  placeOverCells: cells(2.5, 6.5, 15, 11, 3, 3) + r(6.5, 2, 10, 8.5, 'nw', 1.2) + photo(5.5, 1.5, 10, 8),
  // Linked Picture: a picture of cells, with a link.
  linkedPicture: r(2.5, 2.5, 13, 11, 'of', 1.4) + cells(4, 4, 10, 8, 2, 3, { head: 'bf', frame: 'o' })
    + ci(14.5, 14.5, 4.2, 'knock') + p('M12.6 15.6l-.6.6a1.6 1.6 0 0 1-2.3-2.3l1.2-1.2a1.6 1.6 0 0 1 2.3 0M16.4 13.4l.6-.6a1.6 1.6 0 0 0-2.3-2.3l-1.2 1.2a1.6 1.6 0 0 0 0 2.3', 'b thick'),
  // Paste as Picture: the clipboard holding a picture.
  pastePicture: r(3, 3.5, 11, 14, 'nf', 2) + r(5.5, 2, 6, 3.2, 'of', 1.2) + photo(8, 8, 9.5, 9),
});

/** The icons drawn here with a larger canvas in mind are the same drawings; the ribbon shows them at 32px. */
/* SmartArt: the gallery, the Text Pane and the commands of its Design and Format tabs. */
Object.assign(COMMAND_ICONS, {
  smartArt: r(7, 2.5, 6, 4.5, 'bf', 1) + p('M10 7v3M5 10h10M5 10v2.5M15 10v2.5', 'o') + r(2, 12.5, 6, 4.5, 'gf', 1) + r(12, 12.5, 6, 4.5, 'nf', 1),
  textPane: r(2.5, 3.5, 15, 13, 'of') + ci(5.5, 7, 0.9, 'bs') + ci(8.5, 10, 0.9, 'bs') + ci(5.5, 13, 0.9, 'bs') + p('M7.5 7h7M10.5 10h4.5M7.5 13h7', 'o ln'),
  addShape: r(2.5, 5.5, 10, 8, 'bf', 1.5) + badge(15, 14, 'plus'),
  rightToLeft: p('M3 5.5h9M3 9.5h9M3 13.5h9', 'o ln') + p('M17 15.5H6.5M9 13l-2.5 2.5L9 18', 'b'),
  convertShapes: r(2.5, 2.5, 7, 6, 'bf', 1) + ci(14, 5.5, 3.2, 'gf') + p('M6 11.5l3.5 6h-7z', 'pf') + r(11, 11.5, 6.5, 6, 'nf', 1),
  changeShape: r(2.5, 2.5, 8, 8, 'bf', 1.5) + ci(13.5, 13.5, 4, 'nf') + p('M12.5 3.5a4 4 0 0 1 4 4M15.5 6l1 1.5 1.5-1', 'b'),
  shapeLarger: r(5.5, 5.5, 9, 9, 'bf', 1.5) + p('M2.5 6V2.5H6M14 2.5h3.5V6M17.5 14v3.5H14M6 17.5H2.5V14', 'b'),
  shapeSmaller: r(6.5, 6.5, 7, 7, 'bf', 1.5) + p('M2.5 2.5l3 3M17.5 2.5l-3 3M17.5 17.5l-3-3M2.5 17.5l3-3', 'b'),
});

export function commandIcon(name, size) {
  const body = COMMAND_ICONS[name];
  if (!body) return null;
  return `<svg class="ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;
}
