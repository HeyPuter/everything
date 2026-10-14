/**
 * The editor's own command icons, drawn for this project in a glass idiom: rounded neutral outlines
 * in the current text colour, vivid solid shapes and see-through layers in the system blue, green,
 * red, yellow, amber and purple, and round badges for what a command adds, removes, accepts or
 * rejects. They are original drawings (no third-party artwork is copied or traced) on a 20-unit
 * grid; strokes do not scale, so a 32px ribbon command keeps 1px lines as a 16px one does. Colours
 * come from the --ico-* tokens (command-icons.css), so every theme can tune them. Commands the editor
 * shares with the spreadsheet draw exactly as they do there, with the same helpers and lettering.
 *
 * Classes: o outline, of outline on paper, s solid ink, and per accent x ∈ {b, g, r, y, n, p}:
 * x stroke only, xf soft fill with stroke, xs solid fill, xw soft fill without stroke. knock cuts a
 * shape out in the surface colour, wh is a white stroke, glint a white highlight, and glassy lets
 * what lies under a layer show through.
 */

import { ICON_GLYPHS } from './icon-glyphs.js';
import { designIcons } from './icons/design-icons.js';
import { layoutIcons } from './icons/layout-icons.js';
import { textFlowIcons } from './icons/text-flow-icons.js';

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
const chartAxes = p('M3.5 3v13.5H17', 'o ln');
const borderIcon = (solid) => {
  const edges = { top: 'M3.5 3.5h13', bottom: 'M3.5 16.5h13', left: 'M3.5 3.5v13', right: 'M16.5 3.5v13', h: 'M3.5 10h13', v: 'M10 3.5v13' };
  const dashed = Object.keys(edges).filter((k) => !solid.includes(k)).map((k) => edges[k]).join('');
  return (dashed ? p(dashed, 'o dash ln') : '') + (solid.length ? p(solid.map((k) => edges[k]).join(''), 'b thick') : '');
};
/** Chart marks are solid glass: a soft class (bf) is drawn as its solid (bs), with rounded ends. */
const solid = (c) => c.replace(/^([bgrynp])f$/, '$1s');
const columns = (bars, x0 = 5, w = 2.6, gap = 1.4, base = 16.5) => bars.map(([h, c], i) => r(x0 + i * (w + gap), base - h, w, h, solid(c), 0.7)).join('');


/* ---- Pieces only the editor's own commands use ---- */
const n = (v) => +v.toFixed(2);
/** A plain rectangular page. */
const sheet = (x, y, w, h, c = 'of') => r(x, y, w, h, c);
/** page() in another material: a coloured or solid sheet with the same rounded outline and blue glass fold. */
const tintedPage = (c, x = 4.5, y = 2.5, w = 11, h = 15, fold = 3, k = 1.2) => p(`M${x + k} ${y}h${w - fold - k}l${fold} ${fold}v${h - fold - k}a${k} ${k} 0 0 1-${k} ${k}h-${w - 2 * k}a${k} ${k} 0 0 1-${k}-${k}v-${h - 2 * k}a${k} ${k} 0 0 1 ${k}-${k}z`, c) + p(`M${x + w - fold} ${y}v${fold}h${fold}z`, 'bf');
/** A band across the top or bottom of a page `w` wide, following its rounded corners. */
const headBand = (x, y, w, bh, c = 'bs', k = ROUND) => p(`M${x} ${n(y + bh)}V${n(y + k)}a${k} ${k} 0 0 1 ${k}-${k}h${n(w - 2 * k)}a${k} ${k} 0 0 1 ${k} ${k}V${n(y + bh)}z`, c);
const footBand = (x, y, w, bh, c = 'bs', k = ROUND) => p(`M${x} ${n(y - bh)}V${n(y - k)}a${k} ${k} 0 0 0 ${k} ${k}h${n(w - 2 * k)}a${k} ${k} 0 0 0 ${k}-${k}V${n(y - bh)}z`, c);
/** A side pane inside a frame, following the frame's rounded corners on its outer side. */
const paneLeft = (x, y, pw, h, c = 'bw', k = ROUND) => p(`M${n(x + pw)} ${y}H${n(x + k)}a${k} ${k} 0 0 0-${k} ${k}v${n(h - 2 * k)}a${k} ${k} 0 0 0 ${k} ${k}H${n(x + pw)}z`, c);
const paneRight = (x, y, pw, h, c = 'bw', k = ROUND) => p(`M${n(x - pw)} ${y}H${n(x - k)}a${k} ${k} 0 0 1 ${k} ${k}v${n(h - 2 * k)}a${k} ${k} 0 0 1-${k} ${k}H${n(x - pw)}z`, c);
/** Lines of varied lengths for paragraph alignment: [x, width] pairs on a 3-unit pitch. */
const rows = (spec, y0 = 4.5, gap = 3, c = 'o') => p(spec.map(([x, w], i) => `M${x} ${y0 + i * gap}h${w}`).join(''), c);
/** Arrows up and to the left, with the same heads as arrowDown and arrowRight. */
const arrowUp = (x, y, len, c = 'b') => p(`M${x} ${y + len}v-${len}M${x - 2.5} ${y + 2.5}l2.5-2.5 2.5 2.5`, c);
const arrowLeft = (x, y, len, c = 'b') => p(`M${x + len} ${y}h-${len}M${x + 2.5} ${y - 2.5}l-2.5 2.5 2.5 2.5`, c);
/** A pencil, its point at the lower left: a solid body, a red eraser cap and a paper-coloured point. */
const pencil = (dx = 0, dy = 0, c = 'ns') => `<g transform="translate(${dx} ${dy})">${p('M6 11.5l8-8 2.5 2.5-8 8z', c)}${p('M14 3.5l1-1a1 1 0 0 1 1.4 0l1.1 1.1a1 1 0 0 1 0 1.4l-1 1z', 'rs')}${p('M6 11.5l2.5 2.5L5 15z', 'of')}${p('M5.4 13.9l.7.7-1.1.4z', 's')}</g>`;
/** The small purple eraser of Clear All Formatting, at the lower right. */
const eraserMark = p('M11.5 17.5l3.6-3.6a.8.8 0 0 1 1.1 0l1.4 1.4a.8.8 0 0 1 0 1.1l-1.8 1.8h-2.4z', 'pf');
const plusMark = (x, y, s = 2.5, c = 'g thick') => p(`M${x - s} ${y}h${2 * s}M${x} ${y - s}v${2 * s}`, c);
/** A speech bubble, its tail at the lower left. */
const bubble = (x = 3, y = 3, w = 14, h = 11.5, c = 'of', k = 2) => {
  const tail = w >= 13 ? 4 : 3;
  return p(`M${x} ${y + k}a${k} ${k} 0 0 1 ${k}-${k}h${n(w - 2 * k)}a${k} ${k} 0 0 1 ${k} ${k}v${n(h - 2 * k)}a${k} ${k} 0 0 1-${k} ${k}H${n(x + 2.5 + tail)}l-${tail} 3v-3H${x + k}a${k} ${k} 0 0 1-${k}-${k}z`, c);
};
/** A table with `fills` laid under its lines (a highlighted row or column). */
const tableWith = (x, y, w, h, cols, rowsN, fills) => cells(x, y, w, h, cols, rowsN) + fills + cells(x, y, w, h, cols, rowsN, { frame: 'o' });
/** A settings badge: an amber ring cut out of the drawing, as Page Setup has. */
const settingsBadge = (cx, cy) => ci(cx, cy, 3.9, 'knock') + ci(cx, cy, 3, 'ns') + ci(cx, cy, 1, 'knock');
/** The page corner marks drawn at the text boundary. */
const corners = (x, y, w, h, l = 2) => p(`M${x} ${y + l}v-${l}h${l}M${x + w - l} ${y}h${l}v${l}M${x} ${y + h - l}v${l}h${l}M${x + w - l} ${y + h}h${l}v-${l}`, 'b');
const numberedLines = (x, y, labels, gap = 4.5) => labels.map((label, i) => t(x, y + i * gap + 1.6, label, 4.6, { weight: 700, c: 'txb' })).join('');
/** A picture as Insert ▸ Pictures draws it (blue glass sky, green hills, a yellow sun), at any size. */
const picture = (x, y, w, h) => r(x, y, w, h, 'bf', 2) + p(`M${x} ${n(y + h - 2.5)}l${n(w * 0.3)}-${n(h * 0.38)} ${n(w * 0.23)} ${n(h * 0.27)} ${n(w * 0.17)}-${n(h * 0.19)} ${n(w * 0.3)} ${n(h * 0.3)}v.5a2 2 0 0 1-2 2h-${n(w - 4)}a2 2 0 0 1-2-2z`, 'gs') + ci(n(x + w * 0.7), n(y + h * 0.31), n(Math.min(w, h) * 0.13), 'ys');
const book = p('M9.5 5c-1.7-1.2-3.9-1.6-6-1.3v10.5c2.1-.3 4.3.1 6 1.3 1.7-1.2 3.9-1.6 6-1.3V3.7c-2.1-.3-4.3.1-6 1.3zM9.5 5v10.5', 'of');
/** A green circular arrow at the lower right: refresh, update. */
const refresh = p('M17 13a3.5 3.5 0 1 1-1-2.5', 'g thick') + p('M16.5 8.5v2.3h-2.3', 'g thick');

/* ---- The icons, keyed by the names the ribbon, menus and toolbar use. Commands the editor shares with
   the spreadsheet use the spreadsheet's drawings unchanged, so the apps' icons match. ---- */
export const COMMAND_ICONS = {
  /* Quick access and file */
  save: p('M5 3.5h9l2.5 2.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5z', 'bs') + r(6, 3.5, 7, 4.5, 'of', 0.6) + r(6, 11, 8, 5.5, 'of', 0.6),
  undo: p('M7 4.5 3.5 8 7 11.5', 'o thick') + p('M3.5 8h8.5a4.5 4.5 0 0 1 0 9H8', 'o thick'),
  redo: p('M13 4.5 16.5 8 13 11.5', 'o thick') + p('M16.5 8H8a4.5 4.5 0 0 0 0 9h4', 'o thick'),
  print: r(5.5, 2.5, 9, 5, 'of') + r(2.5, 7, 15, 7.5, 'bs', 2) + r(5.5, 11.5, 9, 6, 'of', 0.8) + lines(7, 14, 6, 2, 2) + ci(15, 9.3, 0.7, 'glint'),
  home: p('M4.5 8.4 10 3.5l5.5 4.9V16a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 16z', 'of') + p('M2.5 10 10 3.2l7.5 6.8', 'b thick') + p('M8.5 17.5v-4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v4z', 'ns'),
  back: arrowLeft(4, 10, 12, 'o thick'),
  filePlus: page(4.5, 2.5, 11, 15) + badge(14.5, 14.5, 'plus'),
  folderOpen: p('M2.5 15.5v-10a1 1 0 0 1 1-1h4l1.5 1.5h7a1 1 0 0 1 1 1v2', 'bf') + p('M2.5 15.5l2.3-6.2a1 1 0 0 1 .9-.6h12l-2.3 6.2a1 1 0 0 1-.9.6z', 'bs'),
  download: p('M3.5 13.5v3h13v-3', 'o') + arrowDown(10, 3, 10),
  share: p('M3.5 9.5v7h13v-7', 'o') + p('M10 12.5v-10M7 5.5l3-3 3 3', 'b thick'),
  more: ci(4.5, 10, 1.1, 's') + ci(10, 10, 1.1, 's') + ci(15.5, 10, 1.1, 's'),
  rename: r(2.5, 6.5, 15, 7, 'of') + t(7.5, 12.3, 'ab', 6.5) + p('M13.5 8.3v3.4M12.6 8.3h1.8M12.6 11.7h1.8', 'b'),
  template: page(4.5, 2.5, 11, 15) + r(6.5, 6, 6, 3.5, 'bs', 0.8) + lines(6.5, 12, 7, 3, 2),
  info: ci(10, 10, 7.5, 'bs') + p('M10 9v5', 'wh thick') + ci(10, 6.4, 1, 'txw'),
  // Three bars: the menus, folded into one button.
  menus: p('M3.5 5.5h13M3.5 10h13M3.5 14.5h13', 'o thick'),
  // A clock face with an arrow turning back around it: earlier versions of the file.
  history: ci(10.5, 10.5, 6.5, 'bf') + p('M10.5 6.8v4l2.6 1.6', 'o thick') + p('M3.2 7.5A7.4 7.4 0 0 1 10.5 3M3.2 4.2v3.3h3.3', 'b thick'),
  // Three sliders, each with its knob: settings that apply everywhere.
  preferences: p('M3 5.5h14M3 10h14M3 14.5h14', 'o') + ci(7, 5.5, 1.9, 'bs') + ci(13, 10, 1.9, 'bs') + ci(9, 14.5, 1.9, 'bs'),
  keyboard: r(2.5, 5.5, 15, 9, 'of', 2) + p('M5 8.5h1M8 8.5h1M11 8.5h1M14 8.5h1M5 11.5h1M14 11.5h1', 'o thick') + r(7.5, 10.7, 5, 1.6, 'bs', 0.8),
  pdf: page(4.5, 2.5, 11, 15) + r(2.5, 10.5, 10, 5, 'rs', 1) + t(7.5, 14.5, 'PDF', 4.6, { weight: 700, c: 'txw' }),

  /* Clipboard */
  paste: r(3, 3.5, 11, 14, 'nf', 2) + r(5.5, 2, 6, 3.2, 'of', 1.2) + page(8.5, 7, 9, 11, 2.5) + lines(10.3, 11.5, 5, 3, 2),
  pasteText: r(3, 3.5, 11, 14, 'nf', 2) + r(5.5, 2, 6, 3.2, 'of', 1.2) + r(8.5, 7.5, 9, 10.5, 'of') + t(13, 16, 'A', 7, { weight: 700, c: 'txb' }),
  cut: p('M7.4 11.8 14 2.5M12.6 11.8 6 2.5', 'o') + ci(10, 8.6, 0.7, 's') + ci(6.2, 14.6, 2.7, 'bs') + ci(6.2, 14.6, 1.2, 'knock') + ci(13.8, 14.6, 2.7, 'bs') + ci(13.8, 14.6, 1.2, 'knock'),
  copy: r(2.5, 2.5, 10, 12, 'bf glassy', 2) + r(7.5, 5.5, 10, 12, 'of', 2) + lines(9.7, 9.5, 5.6, 4, 2),
  // Format Painter: a whole brush across the square, bristles down to the left, as one picks it up to paint a format.
  formatPainter: `<g transform="rotate(45 10 10)">${p('M9 9.5V2.5a1 1 0 0 1 2 0v7', 'of') + p('M7.6 9.5h4.8V12H7.6z', 'bs') + p('M7.6 12h4.8v1.5c0 2.2-1 3.8-2.4 5-1.4-1.2-2.4-2.8-2.4-5z', 'ys')}</g>`,

  /* Font */
  fontGrow: t(7.5, 17.5, 'A', 21) + p('M14.5 6l2.5-3 2.5 3', 'o thick'),
  fontShrink: t(7.5, 17.5, 'A', 16) + p('M14.5 3l2.5 3 2.5-3', 'o thick'),
  changeCase: t(6.2, 17.5, 'A', 18) + t(15.8, 17.5, 'a', 13, { c: 'txb' }),
  clearFormat: t(7.5, 16, 'A', 19) + `<g transform="rotate(-40 15 15.5)">${r(10.6, 12.1, 8.8, 6.8, 'knock', 2.4) + r(11.5, 13, 7, 5, 'ps', 1.4) + r(11.5, 13, 2.8, 5, 'of', 1.2)}</g>`,
  bold: t(10, 16.2, 'B', 17, { weight: 700 }),
  italic: t(10, 16.2, 'I', 18, { italic: true, serif: true }),
  underline: t(10, 14, 'U', 15) + p('M4.5 17.2h11', 'o thick'),
  strike: t(10, 15.5, 'S', 16) + p('M4 10.5h12', 'o'),
  strikeDouble: t(10, 15.5, 'S', 16) + p('M4 9.3h12M4 11.7h12', 'o'),
  // The index digit is bold and as large as the letter allows, so it still reads at 16px.
  sub: t(7.5, 13.5, 'x', 15) + t(15, 18.5, '2', 10, { weight: 700, c: 'txb' }),
  sup: t(7.5, 17, 'x', 15) + t(15, 9, '2', 10, { weight: 700, c: 'txb' }),
  textEffects: t(10, 16.5, 'A', 20, { c: 'txfx' }),
  textColor: t(10, 14.5, 'A', 16),
  // Text Highlight: a marker with a yellow tip; the control draws the colour bar under it.
  highlight: `<g transform="rotate(40 10 9)">${r(7.8, 0.5, 4.4, 8.5, 'of', 1.2)}${r(7.8, 7.5, 4.4, 2.6, 'bs')}${p('M8.3 10.1h3.4l-.7 3.4a1 1 0 0 1-1 .8 1 1 0 0 1-1-.8z', 'ys')}</g>`,
  caps: t(10, 15, 'AB', 13),
  smallCaps: t(7, 15, 'A', 14) + t(14, 15, 'B', 10, { c: 'txb' }),
  // Font Settings: the letter with the dialog launcher mark (a box with an arrow out of its corner).
  fontDialog: t(6.5, 13.5, 'A', 13) + r(10.5, 10.5, 7, 7, 'bf') + p('M12.8 12.8l2.8 2.8M15.6 13.2v2.4h-2.4', 'b'),
  characterSpacing: t(10, 12, 'AB', 9) + p('M3 15.5h14M5 13.5l-2 2 2 2M15 13.5l2 2-2 2', 'b thick'),
  textWidth: t(10, 12, 'A', 10) + p('M3 15.5h14M5 13.5l-2 2 2 2M15 13.5l2 2-2 2', 'b thick'),
  kerning: t(10, 13, 'AV', 11) + p('M5 16.5h10', 'b thick'),
  baselineShift: t(8, 14.5, 'A', 12) + arrowUp(15.5, 3, 6.5, 'b thick') + arrowDown(15.5, 10.5, 6.5, 'b thick'),
  underlineOptions: t(10, 14, 'U', 15) + p('M4.5 17.2h11', 'b thick dash'),

  /* Paragraph */
  bullets: ci(4.5, 5.5, 1.5, 'bs') + ci(4.5, 10, 1.5, 'bs') + ci(4.5, 14.5, 1.5, 'bs') + p('M8 5.5h9M8 10h9M8 14.5h9', 'o'),
  numbers: numberedLines(4.5, 5.5, ['1', '2', '3']) + p('M8 5.5h9M8 10h9M8 14.5h9', 'o'),
  // Wrap Text options: a picture block placed among text lines in each arrangement.
  wrapInline: p('M3 5h14M3 15h14', 'o ln') + r(6, 8, 5, 4, 'bs', 1) + p('M12.5 10.5h4.5M3 10.5h1.5', 'o ln'),
  wrapSquare: r(7, 6.5, 6, 6, 'bs', 1.2) + p('M3 4h14M3 7h2.5M3 10h2.5M3 13h2.5M14.5 7H17M14.5 10H17M14.5 13H17M3 16h14', 'o ln'),
  wrapTopBottom: p('M3 4h14M3 16h14', 'o ln') + r(6, 6.5, 8, 7, 'bs', 1.4),
  // Multilevel List: each level's marker set further in.
  multilevel: numberedLines(3.5, 4.5, ['1']) + t(7.5, 11.1, 'a', 4.8, { weight: 700, c: 'txb' }) + ci(11.5, 15, 1.1, 'bs') + p('M6.5 4.5h11M10 9.5h7.5M13.5 15h4', 'o'),
  outdent: p('M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14', 'o') + p('M7.5 9.5h-5M4.5 7.5l-2 2 2 2', 'b'),
  indent: p('M3 3.5h14M9.5 7.5h7.5M9.5 11.5h7.5M3 16.5h14', 'o') + p('M2.5 9.5h5M5.5 7.5l2 2-2 2', 'b'),
  sort: az(6, 9) + arrowDown(13.5, 3.5, 13),
  pilcrow: p('M11.5 3.5v13M14.5 3.5v13M16.5 3.5H9.5', 'b thick') + p('M9.5 3.5a3.3 3.3 0 0 0 0 6.6h2V3.5z', 'bs'),
  alignLeft: p('M3 4.5h14M3 8.5h9M3 12.5h14M3 16.5h9', 'o'),
  alignCenter: p('M3 4.5h14M5.5 8.5h9M3 12.5h14M5.5 16.5h9', 'o'),
  alignRight: p('M3 4.5h14M8 8.5h9M3 12.5h14M8 16.5h9', 'o'),
  alignJustify: p('M3 4.5h14M3 8.5h14M3 12.5h14M3 16.5h9', 'o'),
  lineSpacing: p('M9.5 4.5h8M9.5 8.5h8M9.5 12.5h8M9.5 16.5h8', 'o') + p('M5 4.5v12M2.5 7 5 4.5 7.5 7M2.5 14 5 16.5 7.5 14', 'b thick'),
  shading: p('M3.5 9.5 9 4l6.5 6.5L10 16z', 'bf') + p('M3.5 9.5h12', 'b') + p('M9 4 6.5 1.5', 'o') + p('M16.5 11.5c1 1.6 1.6 2.6 1.6 3.3a1.6 1.6 0 0 1-3.2 0c0-.7.6-1.7 1.6-3.3z', 'ys'),
  borders: borderIcon(['bottom']),
  borderAll: borderIcon(['top', 'bottom', 'left', 'right', 'h', 'v']),
  borderOuter: borderIcon(['top', 'bottom', 'left', 'right']),
  borderNone: borderIcon([]),
  borderTop: borderIcon(['top']),
  borderBottom: borderIcon(['bottom']),
  borderLeft: borderIcon(['left']),
  borderRight: borderIcon(['right']),
  borderInside: borderIcon(['h', 'v']),
  paragraphDialog: p('M9 4.5h8M9 8h8M3 11.5h14M3 15h9', 'o') + r(3, 3, 4.2, 5.5, 'bs', 1),
  restartNumbering: numberedLines(4.5, 6, ['1']) + p('M8.5 6h8.5', 'o') + p('M15.5 10.5a5 5 0 1 1-1.4-3.6', 'g thick') + p('M14.5 4.5v2.8h-2.8', 'g thick'),
  clearParagraph: p('M3.5 4.5h13M3.5 8h13M3.5 11.5h7', 'o') + eraserMark,
  tabStop: p('M3.5 15.5h13', 'o') + p('M6.5 6.5v6h4', 'b thick') + p('M14 9.5l2.5 2.5-2.5 2.5', 'o'),
  keepNext: p('M3.5 4.5h13M3.5 7.5h10', 'o') + p('M3.5 12.5h13M3.5 15.5h8', 'o') + p('M17.5 7.5v5', 'b thick'),
  keepLines: p('M5.5 4.5h11M5.5 8h11M5.5 11.5h11M5.5 15h7', 'o') + p('M3 4v11.5', 'b thick'),
  widowControl: p('M3.5 4.5h13M3.5 8h13', 'o') + p('M3.5 11.5h13', 'o dash') + p('M3.5 15h9', 'o') + ci(15.5, 15, 1.6, 'bs'),
  pageBreakBefore: sheet(4.5, 9.5, 11, 8) + p('M2.5 6.5h15', 'b dash') + p('M6.5 12.5h7M6.5 15h5', 'o ln') + arrowUp(10, 0.5, 4.5),
  contextualSpacing: p('M3.5 4.5h13M3.5 7.5h13M3.5 12.5h13M3.5 15.5h13', 'o') + p('M3.5 10h13', 'b dash'),
  outlineLevel: numberedLines(3.5, 5, ['1']) + p('M7 5h10', 'o') + numberedLines(6.5, 10, ['2']) + p('M10 10h7', 'o') + p('M9.5 15h7.5', 'o ln'),

  /* Styles and editing */
  stylesPane: r(3, 3, 12, 14, 'of') + lines(5, 6, 7, 2, 2.5) + brush(1, 0),
  styleGallery: r(2.5, 2.5, 15, 4.2, 'bs', 1.4) + p('M4.7 4.6h5', 'wh') + r(2.5, 7.9, 15, 4.2, 'gf', 1.4) + p('M4.7 10h5', 'g') + r(2.5, 13.3, 15, 4.2, 'of', 1.4) + p('M4.7 15.4h5', 'o ln'),
  newStyle: t(7, 14, 'A', 12) + badge(14.5, 14.5, 'plus'),
  editStyle: t(7, 14, 'A', 12) + pencil(2, 2),
  find: magnifier(8.5, 8.5, 5.5),
  replace: t(5.5, 8, 'a', 8, { c: 'txb' }) + p('M9.5 5h4.5a2 2 0 0 1 2 2v1.5M14.5 7.5l1.5 1.5 1.5-1.5', 'b') + t(13, 17, 'b', 8) + p('M10 14H6a2 2 0 0 1-2-2v-1', 'o'),
  select: p('M5.5 3l9.5 8.5-4.2.4 2.6 5-1.8.9-2.6-5-3.5 3z', 'of'),
  selectAll: r(2.5, 3.5, 15, 13, 'bw', 1.6) + r(2.5, 3.5, 15, 13, 'b dash') + lines(5, 7, 10, 3, 3, 'o'),
  goTo: p('M3.5 10h11M11 6.5l3.5 3.5-3.5 3.5', 'b thick') + p('M17 3.5v13', 'o'),

  /* Insert: pages */
  coverPage: sheet(4.5, 2.5, 11, 15) + headBand(4.5, 2.5, 11, 6.5) + p('M6.5 6h5', 'wh thick') + lines(6.5, 12, 7, 3, 2),
  blankPage: page(4.5, 2.5, 11, 15) + badge(14.5, 14.5, 'plus'),
  pageBreak: sheet(4.5, 1.5, 11, 6.5) + lines(6.5, 4, 7, 2, 2) + sheet(4.5, 12, 11, 6.5) + lines(6.5, 14.5, 7, 2, 2) + p('M2 10h16', 'b thick dash'),
  table: cells(2.5, 3.5, 15, 13, 3, 4, { head: 'bf' }) + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' }),
  pictures: r(2.5, 3.5, 15, 13, 'bf', 2) + p('M2.5 14l4.5-5 3.5 3.5 2.5-2.5 4.5 4.5v.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z', 'gs') + ci(13, 7.5, 1.7, 'ys'),
  shapes: ci(7.5, 7.5, 5, 'bs') + r(8.5, 8.5, 9, 9, 'nf glassy', 2),
  // Shape Format: a paint bucket over a fill bar; a frame over an outline bar; stacked line weights; height and width arrows.
  shapeFill: p('M4 9l5-5 6 6-5 5z', 'of') + p('M4 9h11', 'o ln') + p('M16.5 11.5c.9 1.4 1.4 2.2 1.4 2.9a1.4 1.4 0 0 1-2.8 0c0-.7.5-1.5 1.4-2.9z', 'bs') + r(2.5, 16.5, 15, 2, 'ys'),
  shapeOutline: r(4.5, 3.5, 11, 10, 'o thick', 1) + p('M3 17.5h14', 'b thick'),
  lineWeight: p('M3 5h14', 'o') + r(3, 8.5, 14, 1.6, 's', 0.8) + r(3, 13, 14, 3, 's', 1.5),
  shapeHeight: r(8.5, 5.5, 8, 9, 'bf') + arrowUp(4, 3, 7, 'b thick') + arrowDown(4, 10, 7, 'b thick'),
  shapeWidth: r(5.5, 8.5, 9, 8, 'bf') + arrowLeft(3, 4, 7, 'b thick') + arrowRight(10, 4, 7, 'b thick'),
  icons: ci(10, 6.8, 3.6, 'bs') + p('M3.5 17.5a6.5 6.5 0 0 1 13 0z', 'bs') + ci(9, 5.8, 1, 'glint'),
  chart: chartAxes + columns([[6, 'bf'], [11, 'bf'], [8, 'nf']]),
  smartArt: r(7, 2.5, 6, 4, 'bs', 1.2) + r(2.5, 12.5, 6, 4, 'gs', 1.2) + r(11.5, 12.5, 6, 4, 'ns', 1.2) + p('M10 6.5v3M5.5 12.5v-3h9v3', 'o'),
  link: p('M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1', 'b thick') + p('M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1', 'o thick'),
  unlink: p('M12 6.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8 13.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1', 'o thick') + p('M4 4l2 2M16 16l-2-2M7.5 2.5v2M12.5 17.5v-2', 'r'),
  bookmark: p('M5.5 4a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14.5 4v13.5l-4.5-3.5-4.5 3.5z', 'bs') + p('M7.5 4.5v6', 'wh ln'),
  crossReference: page(3.5, 2.5, 9, 12, 2.5) + lines(5.5, 7.5, 5, 3, 2) + arrowRight(11, 14, 6.5, 'b thick'),
  comment: p('M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5l-4 3v-3H5a2 2 0 0 1-2-2z', 'bs') + p('M10 6v5.5M7.25 8.75h5.5', 'wh thick'),
  newComment: p('M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H9.5l-4 3v-3H5a2 2 0 0 1-2-2z', 'bs') + p('M10 6v5.5M7.25 8.75h5.5', 'wh thick'),
  header: sheet(3.5, 2.5, 13, 15) + headBand(3.5, 2.5, 13, 4.5) + p('M5.5 4.75h5', 'wh') + lines(5.5, 10, 9, 3, 2.5),
  footer: sheet(3.5, 2.5, 13, 15) + footBand(3.5, 17.5, 13, 4.5) + p('M5.5 15.25h5', 'wh') + lines(5.5, 5, 9, 3, 2.5),
  // Go to Header and Go to Footer: the page's header or footer with an arrow moving to it.
  goToHeader: sheet(2.5, 2.5, 10, 15) + headBand(2.5, 2.5, 10, 4.5, 'bw') + p('M2.5 7h10', 'b') + lines(4.5, 10, 6, 3, 2.5) + arrowUp(16, 3, 12, 'b thick'),
  goToFooter: sheet(2.5, 2.5, 10, 15) + footBand(2.5, 17.5, 10, 4.5, 'bw') + p('M2.5 13h10', 'b') + lines(4.5, 5, 6, 3, 2.5) + arrowDown(16, 5, 12, 'b thick'),
  pageNumber: page(4.5, 2.5, 11, 15) + t(10, 15, '#', 8, { weight: 700, c: 'txb' }),
  textBox: r(3.5, 4.5, 13, 11, 'of', 1.6) + ci(3.5, 4.5, 1.2, 'bs') + ci(16.5, 4.5, 1.2, 'bs') + ci(3.5, 15.5, 1.2, 'bs') + ci(16.5, 15.5, 1.2, 'bs') + t(10, 14, 'A', 9),
  wordArt: t(10, 16, 'A', 16, { italic: true, serif: true, c: 'txb' }),
  dropCap: r(2.5, 3, 8, 8, 'bs', 1.6) + t(6.5, 9.6, 'A', 7, { c: 'txw' }) + p('M12.5 4.5h5M12.5 8h5M2.5 13.5h15M2.5 17h15', 'o'),
  dateTime: r(2.5, 4.5, 12, 11.5, 'of', 1) + r(2.5, 4.5, 12, 3, 'bf', 1) + p('M5.5 3v3M11.5 3v3', 'o') + ci(14, 14, 4, 'of') + p('M14 11.5V14l1.6 1', 'b'),
  field: r(2.5, 6.5, 15, 7, 'of') + t(10, 12.2, '{ }', 6.5, { c: 'txb' }),
  symbol: t(10, 15.5, 'Ω', 14),
  equation: t(10, 15.5, 'π', 15),
  object: r(2.5, 2.5, 13, 13, 'of', 2) + r(7, 7, 10.5, 10.5, 'bs glassy', 2) + ci(10, 10, 1.1, 'glint'),
  // Screenshot: a screen with a captured region marked by blue corner brackets.
  screenshot: r(2.5, 3.5, 15, 10.5, 'of', 1.4) + p('M7.5 17h5M10 14v3', 'o') + p('M5.5 8.5v-2h2.5M14.5 8.5v-2H12M5.5 9.5v2h2.5M14.5 9.5v2H12', 'b thick'),
  // Quick Parts: reusable building blocks stacked over a page.
  quickParts: page(3.5, 2.5, 10, 13, 2.5) + r(8.5, 9, 8.5, 4, 'bs', 1) + r(6.5, 13.5, 8.5, 4, 'gs', 1) + ci(10, 10.6, 0.8, 'glint'),
  // Signature line: an X and a pen stroke on a rule.
  signatureLine: p('M2.5 15.5h15', 'o') + p('M3.5 10.5l3 3M6.5 10.5l-3 3', 'o') + p('M9 13c1.2-3.5 2.4-4.6 3-3.4s-.8 3.2.4 3.1 2.1-2.2 3.1-1.9', 'b thick'),

  /* Design */
  themes: t(7.5, 9.5, 'Aa', 8.5, { serif: true }) + r(3, 12, 3.2, 4, 'bs') + r(7, 12, 3.2, 4, 'gs') + r(11, 12, 3.2, 4, 'ns') + r(15, 12, 2.5, 4, 'rs'),
  colors: ci(7.2, 7.2, 4.2, 'bs glassy') + ci(12.8, 7.2, 4.2, 'rs glassy') + ci(7.2, 12.8, 4.2, 'gs glassy') + ci(12.8, 12.8, 4.2, 'ys glassy'),
  fonts: t(7, 15.5, 'A', 13, { serif: true }) + t(14.5, 15.5, 'a', 10, { c: 'txb' }),
  // Paragraph Spacing: two paragraphs with the gap between them marked.
  paragraphSpacing: lines(3, 4, 9, 2, 2.5, 'o') + lines(3, 14, 9, 2, 2.5, 'o') + arrowUp(15.5, 2, 6.5, 'b thick') + arrowDown(15.5, 10.5, 6.5, 'b thick'),
  pageColor: tintedPage('bf') + lines(6.5, 8, 6, 2, 2.2, 'b ln') + p('M15 9.5c1.5 2.2 2.6 3.7 2.6 5a2.6 2.6 0 0 1-5.2 0c0-1.3 1.1-2.8 2.6-5z', 'knock') + p('M15 11c1.1 1.6 1.8 2.6 1.8 3.5a1.8 1.8 0 0 1-3.6 0c0-.9.7-1.9 1.8-3.5z', 'ns'),
  watermark: page(4.5, 2.5, 11, 15) + `<g transform="rotate(-50 10 11)">${t(10, 13.3, 'AB', 7, { weight: 700, c: 'txb ln' })}</g>`,
  pageBorders: sheet(3.5, 2.5, 13, 15) + r(5.5, 4.5, 9, 11, 'b thick', 1) + lines(7.5, 8, 5, 3, 2),

  /* Layout */
  margins: page(4.5, 2.5, 11, 15, 0) + r(6.5, 4.5, 7, 11, 'bw', 1) + r(6.5, 4.5, 7, 11, 'b dash'),
  orientation: r(2.5, 6.5, 8, 11, 'of', 1.6) + r(8.5, 9.5, 9, 8, 'bf glassy', 1.6) + p('M12 2.5a4 4 0 0 1 4 4M14.5 5.5l1.5 1.5 1.5-1.5', 'b'),
  size: page(4.5, 2.5, 11, 15) + p('M7 8v7M5.5 9.5 7 8l1.5 1.5M5.5 13.5 7 15l1.5-1.5', 'b') + p('M9.5 16h4', 'o'),
  columns: r(2.5, 2.5, 15, 15, 'of') + r(4.5, 4.5, 4.8, 11, 'bw', 0.6) + r(10.7, 4.5, 4.8, 11, 'bw', 0.6) + lines(5.3, 6.5, 3.2, 4, 2.4, 'b') + lines(11.5, 6.5, 3.2, 4, 2.4, 'b'),
  breaks: page(4.5, 2.5, 11, 15, 0) + p('M4.5 10h11', 'b dash') + t(10, 8, '1', 4.5, { c: 'txb' }) + t(10, 15, '2', 4.5, { c: 'txb' }),
  lineNumbers: numberedLines(4, 5.5, ['1', '2', '3']) + p('M8 5.5h9M8 10h9M8 14.5h6', 'o'),
  hyphenation: t(7, 12.5, 'a', 10) + p('M10.5 9.5h3', 'b thick') + p('M3.5 16h13', 'o ln'),
  indentLeft: p('M8.5 4.5h9M8.5 8h9M8.5 11.5h9M8.5 15h6', 'o') + arrowRight(2, 9.8, 5, 'b thick'),
  indentRight: p('M2.5 4.5h9M2.5 8h9M2.5 11.5h9M2.5 15h6', 'o') + arrowLeft(13, 9.8, 5, 'b thick'),
  spaceBefore: p('M3.5 10.5h13M3.5 13.5h13M3.5 16.5h9', 'o') + arrowDown(10, 1.5, 6.5, 'b thick'),
  spaceAfter: p('M3.5 3.5h13M3.5 6.5h13M3.5 9.5h9', 'o') + arrowUp(10, 12, 6.5, 'b thick'),
  position: sheet(3.5, 2.5, 13, 15) + r(9, 5, 5.5, 4.5, 'bs', 1) + lines(5.5, 6, 2, 2, 2.5) + lines(5.5, 12.5, 9, 2, 2.5),
  wrapText: r(7, 6.5, 6, 6, 'bs', 1.2) + p('M3 4h14M3 6.5h2.5M14.5 6.5H17M3 9.5h2.5M14.5 9.5H17M3 12.5h2.5M14.5 12.5H17M3 15.5h14', 'o'),
  bringForward: r(2.5, 2.5, 9, 9, 'of') + r(8.5, 8.5, 9, 9, 'bs glassy', 1.6),
  sendBackward: r(8.5, 8.5, 9, 9, 'bs', 1.6) + r(2.5, 2.5, 9, 9, 'of glassy'),
  inFront: lines(3.5, 5, 13, 5, 2.5, 'o') + r(6.5, 6.5, 7, 7, 'bs glassy', 1.4),
  behindText: r(6.5, 6.5, 7, 7, 'bs', 1.4) + lines(3.5, 5, 13, 5, 2.5, 'o'),
  pageSetup: page(4.5, 2.5, 11, 15) + lines(6.5, 6.5, 5, 3, 2) + ci(14, 14, 3.9, 'knock') + ci(14, 14, 3, 'ns') + ci(14, 14, 1, 'knock'),
  rotate: p('M15.5 10a5.5 5.5 0 1 1-1.6-3.9', 'o thick') + p('M14.5 3.5v3h-3', 'b thick'),
  crop: p('M6 2.5v11.5h11.5', 'o thick') + p('M2.5 6H14v11.5', 'b thick'),
  // Delete a selected picture or shape: the object with a red badge.
  deletePicture: picture(2.5, 3.5, 12, 10) + badge(15, 15, 'x', 'r'),
  deleteShape: ci(6.5, 6.5, 4, 'bs') + r(6.5, 6.5, 7, 7, 'nf glassy', 1.4) + badge(15, 15, 'x', 'r'),
  altText: r(2.5, 4.5, 9, 8, 'bw') + r(2.5, 4.5, 9, 8, 'o') + p('M3.5 11.5l2.6-3 2 2 1.4-1.4 1.5 2.4', 'g') + ci(8.6, 7, 0.9, 'yf') + lines(13.5, 6, 4, 3, 2.5),
  drawingText: r(2.5, 3.5, 15, 13, 'ns', 2.4) + t(10, 13.4, 'T', 9, { c: 'txw' }),

  /* References */
  toc: sheet(3.5, 2.5, 13, 15) + p('M5.5 6h5', 'b thick') + p('M5.5 9.5h6M7 13h5', 'o') + p('M12.5 9.5h1M13 13h.5', 'o dash') + p('M14.5 6h0M14.5 9.5h0M14.5 13h0', 'o thick'),
  updateFields: r(2.5, 3, 10.5, 6.5, 'of') + t(7.75, 8.3, '{ }', 6, { c: 'txb' }) + refresh,
  updateTable: page(3.5, 2.5, 10, 13, 2.5) + p('M5.5 6.5h4', 'b thick') + lines(5.5, 9, 6, 2, 2.5) + refresh,
  addText: p('M3.5 5h7M3.5 9h11M3.5 13h7', 'o') + badge(15, 14.5, 'plus'),
  footnote: sheet(3.5, 2.5, 13, 15) + lines(5.5, 5, 9, 2, 2.5) + p('M5.5 12.5h4', 'b') + t(13, 16, '1', 5, { weight: 700, c: 'txb' }) + t(11.2, 8.6, '1', 4, { weight: 700, c: 'txb' }),
  endnote: sheet(3.5, 2.5, 13, 15) + lines(5.5, 5, 9, 3, 2.5) + p('M5.5 14h9', 'b') + t(15, 17, 'i', 4, { weight: 700, c: 'txb' }),
  nextFootnote: t(6, 9, '1', 6, { weight: 700, c: 'txb' }) + arrowDown(13, 3, 13, 'b thick'),
  showNotes: sheet(3.5, 2.5, 13, 15) + footBand(3.5, 17.5, 13, 5.5, 'bw') + p('M3.5 12h13', 'b') + lines(5.5, 5, 9, 2, 2.5) + lines(5.5, 14.5, 7, 1, 2, 'b'),
  citation: r(2.5, 3.5, 15, 13, 'bs', 3) + t(10, 18.2, '“”', 13.5, { c: 'txw' }),
  bibliography: r(4.5, 2.5, 11, 15, 'ns', 1.6) + p('M6.8 2.5v15', 'wh ln') + lines(8.8, 6.5, 4.5, 2, 2.5, 'wh'),
  caption: picture(2.5, 2.5, 15, 9.5) + p('M2.5 14.5h12M2.5 17h8', 'o'),
  tableOfFigures: picture(2.5, 2.5, 7, 5.5) + p('M11.5 4.5h6M11.5 7h4M2.5 10.5h15M2.5 13.5h15M2.5 16.5h9', 'o'),
  markEntry: p('M3.5 5.5h13M3.5 9.5h13', 'o') + r(3.5, 12, 8, 5, 'ys', 1.2) + p('M5.5 14.5h4', 'o'),
  index: r(4.5, 2.5, 11, 15, 'of') + t(10, 9.5, 'A', 5, { weight: 700, c: 'txb' }) + lines(7, 12, 6, 3, 2),
  // A note page with the corner arrow the dialog launchers draw.
  noteSettings: r(2.5, 2.5, 11, 13, 'of') + lines(4.5, 6, 7, 2, 2.5) + p('M4.5 12h4', 'b') + r(10.5, 10.5, 7, 7, 'bf') + p('M12.8 12.8l2.8 2.8M15.6 13.2v2.4h-2.4', 'b'),
  // A magnifier with a small spark: look something up.
  smartLookup: magnifier(8.5, 9, 5) + p('M15 2.5l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z', 'ys'),
  // Two source cards, the front one ruled.
  manageSources: r(2.5, 2.5, 10, 12, 'of') + r(6.5, 5.5, 11, 12, 'bf') + lines(8.5, 9.5, 7, 3, 2.5),
  // Marked text with a quotation tag.
  markCitation: p('M3.5 4.5h13M3.5 8.5h13', 'o') + r(3.5, 11, 10, 6.5, 'gs', 1.4) + t(8.5, 18.3, '“”', 9, { c: 'txw' }),
  // A page of entries grouped under a green category line.
  tableOfAuthorities: sheet(3.5, 2.5, 13, 15) + p('M5.5 6h6', 'g thick') + p('M5.5 9.5h7M5.5 13h5', 'o') + p('M13.5 9.5h1M11.5 13h3', 'o dash'),
  updateIndex: r(3.5, 2.5, 10, 13, 'of') + t(8.5, 8.6, 'A', 4.5, { weight: 700, c: 'txb' }) + lines(5.5, 11, 5, 2, 2) + refresh,
  updateAuthorities: sheet(3.5, 2.5, 10, 13) + p('M5.5 6h4', 'g thick') + lines(5.5, 9, 6, 2, 2.5) + refresh,

  /* Review */
  spelling: t(8.5, 10, 'abc', 8.5) + p('M7 14l2.5 2.5 6-6', 'g thick'),
  // The status bar's proofing state: an open book with a check (no errors) or a cross (errors found).
  proofingClean: book + badge(15, 15, 'check', 'g', 3.6),
  proofingErrors: book + badge(15, 15, 'x', 'r', 3.6),
  wordCount: t(10, 8.5, 'ABC', 6.5, { weight: 700 }) + t(10, 16, '123', 6.5, { weight: 700, c: 'txb' }),
  thesaurus: r(4.5, 2.5, 11, 15, 'gs', 1.6) + p('M6.8 2.5v15', 'wh ln') + lines(8.8, 7, 4.5, 3, 2.5, 'wh'),
  // A header band on a page, closed with a red badge.
  close: sheet(3.5, 2.5, 13, 15) + headBand(3.5, 2.5, 13, 4, 'bw') + p('M3.5 6.5h13', 'b') + badge(10, 12, 'x', 'r', 3.6),
  // A page of text with a speaker and sound arcs.
  readAloud: page(2.5, 2.5, 9, 12, 2.5) + lines(4.5, 7.5, 4.5, 3, 2.5) + r(9.5, 9, 9.5, 9, 'knock', 2) + p('M11 12h1.8l3.2-2.7v8.4L12.8 15H11a.8.8 0 0 1-.8-.8v-1.4A.8.8 0 0 1 11 12z', 'bs') + p('M17.6 11.3c.9 1 .9 2.9 0 3.9', 'b thick'),
  language: ci(10, 10, 7, 'bf') + p('M3 10h14M10 3c-2.5 2-3.5 4.5-3.5 7s1 5 3.5 7c2.5-2 3.5-4.5 3.5-7s-1-5-3.5-7z', 'o'),
  accessibility: ci(8, 4, 1.8, 'bs') + p('M3 7.5h10M8 7.5v5M8 12.5l-3 5M8 12.5l3 5', 'o thick') + badge(15, 15, 'check'),
  deleteComment: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + badge(15, 15, 'x', 'r'),
  // Previous and Next Comment: a comment with an arrow pointing back or on.
  previous: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + p('M17.5 15h-7M13.5 12l-3 3 3 3', 'p thick'),
  next: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + p('M10.5 15h7M14.5 12l3 3-3 3', 'p thick'),
  resolveComment: p('M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5l-2.5 2v-2H3.5a1 1 0 0 1-1-1z', 'of') + badge(15, 15, 'check'),
  previousArrow: p('M12.5 4.5 7 10l5.5 5.5', 'b thick'),
  nextArrow: p('M7.5 4.5 13 10l-5.5 5.5', 'b thick'),
  showComments: r(11.5, 2.5, 6, 15, 'of', 1) + p('M13 6h3M13 9h3M13 12h3', 'p') + p('M2.5 5.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6l-2 1.5v-1.5h-.5a1 1 0 0 1-1-1z', 'pf'),
  trackChanges: page(3, 2.5, 11, 15) + p('M5 7h4.5', 'o') + p('M5 10h7', 'r') + p('M5 13h5', 'b') + pencil(1.5, 2.5),
  accept: page(3, 2.5, 11, 15) + p('M5 7h6M5 9.5h4', 'o ln') + p('M5 12h4', 'b') + badge(14.5, 14.5, 'check'),
  reject: page(3, 2.5, 11, 15) + p('M5 7h6M5 9.5h4', 'o ln') + p('M5 12h4', 'r') + badge(14.5, 14.5, 'x', 'r'),
  reviewingPane: r(2.5, 2.5, 15, 15, 'of') + paneLeft(2.5, 2.5, 5, 15) + p('M7.5 2.5v15', 'o ln') + p('M3.8 6h2.4M3.8 9h2.4M3.8 12h2.4', 'b') + lines(9.5, 6, 6, 3, 2.5),
  markup: page(3.5, 2.5, 11, 15) + p('M5.5 7h7', 'r') + p('M5.5 10h7', 'b') + p('M5.5 13h5', 'o ln') + p('M16.5 4v12', 'r thick'),
  compare: r(2.5, 3.5, 7.5, 11, 'of') + lines(4, 6.5, 4.5, 3, 2) + r(10, 5.5, 7.5, 11, 'bf glassy') + lines(11.5, 8.5, 4.5, 3, 2, 'b'),
  protect: page(2.5, 2.5, 10, 14) + lines(4.5, 7, 6, 2, 2) + lock(9.5, 11.5),
  readOnly: page(2.5, 2.5, 10, 14) + lock(9.5, 11.5),
  // Translate: a sheet with a capital A, and a glass card in front with a lowercase a.
  translate: r(2.5, 2.5, 10, 10, 'of') + t(7.5, 10.4, 'A', 7.5, { weight: 700 }) + r(8.5, 8.5, 9, 9, 'bf glassy') + t(13, 15.6, 'a', 8, { serif: true, c: 'txb' }),
  // Combine: two pages meeting in one.
  combine: r(2.5, 2.5, 5.5, 7.5, 'of') + r(12, 2.5, 5.5, 7.5, 'of') + p('M5.25 10v2.3h3.2M14.75 10v2.3h-3.2', 'b') + r(6.5, 11, 7, 6.5, 'bf') + p('M8.3 14.2h3.4', 'b'),
  // Show Markup: a marked-up page with a filter.
  showMarkup: page(2.5, 2.5, 10.5, 15) + p('M4.5 7h6', 'r') + p('M4.5 10h6', 'b') + p('M4.5 13h3.5', 'o ln') + p('M10.5 11.5h7l-2.7 3.2v2.6l-1.6.9v-3.5z', 'pf'),
  // Tracking Options: a marked-up page with a dial.
  trackingOptions: page(2.5, 2.5, 10.5, 15) + p('M4.5 7h6', 'r') + p('M4.5 10h5', 'b') + ci(14.5, 14.5, 4.2, 'knock') + ci(14.5, 14.5, 3.2, 'nf') + ci(14.5, 14.5, 1.1, 'o') + p('M14.5 10.6v1.2M14.5 17.2v1.2M10.6 14.5h1.2M17.2 14.5h1.2', 'o'),
  // Lock Tracking: the tracked page, locked.
  lockTracking: page(2.5, 2.5, 10.5, 15) + p('M4.5 7h4.5', 'o') + p('M4.5 10h6', 'r') + p('M4.5 13h4', 'b') + lock(10, 12),
  // Hide Ink: a pen stroke, struck through.
  hideInk: p('M2.5 13.5c1.6-3.4 3.4-3.4 4.4 0s2.8 3.4 4.4 0 2.8-3.4 4.2-1.2', 'b thick') + p('M3.5 3.5l13 13', 'o thick'),

  /* View */
  readMode: p('M2.5 4.5c3-1 5.5-1 7.5.5v12c-2-1.5-4.5-1.5-7.5-.5zM17.5 4.5c-3-1-5.5-1-7.5.5v12c2-1.5 4.5-1.5 7.5-.5z', 'of') + lines(4.5, 7.5, 3.5, 2, 2.5, 'b') + lines(12, 7.5, 3.5, 2, 2.5, 'b'),
  printLayout: page(4.5, 2.5, 11, 15) + lines(6.5, 8, 7, 4, 2.2),
  printLayoutSolid: tintedPage('s') + p('M6.5 8h7M6.5 10.2h7M6.5 12.4h7M6.5 14.6h5', 'w'),
  webLayout: r(2.5, 3.5, 15, 13, 'of', 2) + headBand(2.5, 3.5, 15, 3, 'bs', 2) + ci(4.4, 5, 0.5, 'glint') + ci(6, 5, 0.5, 'glint') + lines(4.5, 9.5, 11, 3, 2.2),
  outlineView: p('M3.5 5h13M6.5 8.5h10M6.5 12h10M3.5 15.5h13', 'o') + ci(3.8, 8.5, 1, 'bs') + ci(3.8, 12, 1, 'bs'),
  draft: p('M3.5 5h13M3.5 8.5h13M3.5 12h8', 'o') + pencil(2, 2),
  focus: p('M2.5 7V3.5a1 1 0 0 1 1-1H7M13 2.5h3.5a1 1 0 0 1 1 1V7M17.5 13v3.5a1 1 0 0 1-1 1H13M7 17.5H3.5a1 1 0 0 1-1-1V13', 'o') + r(6.5, 6.5, 7, 7, 'bf'),
  focusArrow: p('M4 16 16 4M10.5 4H16v5.5M4 10.5V16h5.5', 'o'),
  ruler: r(2.5, 6.5, 15, 7, 'ns', 1.6) + p('M5 6.5v3M7.5 6.5v2M10 6.5v3M12.5 6.5v2M15 6.5v3', 'wh'),
  gridlines: r(2.5, 3.5, 15, 13, 'of') + p('M2.5 7.83h15M2.5 12.17h15M7.5 3.5v13M12.5 3.5v13', 'b'),
  navigationPane: r(2.5, 3.5, 15, 13, 'of') + paneLeft(2.5, 3.5, 5, 13) + p('M7.5 3.5v13', 'o ln') + lines(3.8, 6.5, 2.4, 3, 2.5, 'b') + lines(9.5, 6.5, 6, 3, 2.5),
  zoom: magnifier(8.5, 8.5, 5.5) + p('M6 8.5h5M8.5 6v5', 'o'),
  // The status bar's zoom steppers, drawn at 12px: a bare plus and minus.
  zoomIn: plusMark(10, 10, 5, 'o'),
  zoomOut: p('M5 10h10', 'o'),
  zoom100: magnifier(8.5, 8.5, 5.5, 'bw') + t(8.5, 10.4, '100', 4.6, { weight: 700, c: 'txb' }),
  onePage: sheet(5.5, 2.5, 9, 15) + corners(7, 4.5, 6, 11, 1.5),
  multiplePages: sheet(2.5, 3.5, 7, 13) + sheet(10.5, 3.5, 7, 13, 'bf glassy') + lines(4, 7, 4, 3, 2) + lines(12, 7, 4, 3, 2, 'b'),
  pageWidth: sheet(4.5, 2.5, 11, 15) + p('M1.5 10h17M4 7.5 1.5 10 4 12.5M16 7.5l2.5 2.5-2.5 2.5', 'b thick'),
  textMode: r(2.5, 4.5, 15, 11, 'of') + p('M5 8.5h10M5 11.5h7', 'o') + p('M13.5 10.5v3', 'b thick'),
  documentFonts: t(8, 13.5, 'A', 12) + p('M13.5 8h4M13.5 11h4M13.5 14h4', 'b'),
  // Measurement units: a rule over a measured span (lettering this small would not read).
  units: r(2.5, 3.5, 15, 7, 'nf') + p('M5 3.5v2M7.5 3.5v3M10 3.5v2M12.5 3.5v3M15 3.5v2', 'n') + p('M3 14.5h14M5 12.5l-2 2 2 2M15 12.5l2 2-2 2', 'b thick'),
  formattingPane: r(2.5, 3.5, 15, 13, 'of') + paneRight(17.5, 3.5, 6, 13) + p('M11.5 3.5v13', 'o ln') + lines(4.5, 7, 5, 3, 2.5) + r(13, 6, 3, 2, 'bs', 0.5) + r(13, 9.5, 3, 2, 'gs', 0.5) + r(13, 13, 3, 2, 'ns', 0.5),
  darkPage: tintedPage('s') + p('M6.5 8h7M6.5 10.5h7M6.5 13h5', 'w'),

  /* Tables */
  tableProperties: cells(2.5, 3.5, 11, 10, 2, 3) + settingsBadge(14.5, 14.5),
  insertAbove: tableWith(2.5, 4.5, 13.5, 12, 3, 3, r(2.5, 4.5, 13.5, 4, 'bw')) + badge(15.5, 4.5, 'plus'),
  insertBelow: tableWith(2.5, 3.5, 13.5, 12, 3, 3, r(2.5, 11.5, 13.5, 4, 'bw')) + badge(15.5, 15.5, 'plus'),
  insertLeft: tableWith(4, 3.5, 13.5, 12, 3, 3, r(4, 3.5, 4.5, 12, 'bw')) + badge(4.5, 15.5, 'plus'),
  insertRight: tableWith(2.5, 3.5, 13.5, 12, 3, 3, r(11.5, 3.5, 4.5, 12, 'bw')) + badge(15.5, 4.5, 'plus'),
  deleteTable: cells(2.5, 3.5, 13, 12, 3, 3, { head: 'bw' }) + cells(2.5, 3.5, 13, 12, 3, 3, { frame: 'o' }) + badge(15, 15, 'x', 'r'),
  deleteRow: cells(2.5, 3.5, 15, 13, 2, 3) + r(2.5, 7.83, 15, 4.33, 'rw') + cells(2.5, 3.5, 15, 13, 2, 3, { frame: 'o' }) + badge(15.5, 15.5, 'minus', 'r'),
  deleteColumn: cells(2.5, 3.5, 15, 13, 3, 2) + r(7.5, 3.5, 5, 13, 'rw') + cells(2.5, 3.5, 15, 13, 3, 2, { frame: 'o' }) + badge(15.5, 15.5, 'minus', 'r'),
  mergeCells: r(2.5, 4.5, 15, 11, 'bs', 2.4) + p('M5.5 10h9M7.5 8l-2 2 2 2M12.5 8l2 2-2 2', 'wh thick'),
  mergeBelow: r(4.5, 2.5, 11, 15, 'bs', 2.4) + p('M10 5.5v9M8 7.5l2-2 2 2M8 12.5l2 2 2-2', 'wh thick'),
  splitCells: r(2.5, 4.5, 7, 11, 'bf', 2) + r(10.5, 4.5, 7, 11, 'bf', 2) + p('M8 10H4.5M6 8.5 4.5 10 6 11.5M12 10h3.5M14 8.5l1.5 1.5-1.5 1.5', 'b'),
  rowHeight: cells(5.5, 3.5, 12, 13, 2, 3, { frame: 'o' }) + p('M2.5 4.5v11M1 6l1.5-1.5L4 6M1 14l1.5 1.5L4 14', 'b'),
  columnWidth: cells(2.5, 6.5, 15, 11, 3, 2, { frame: 'o' }) + p('M3.5 3.5h13M5 2l-1.5 1.5L5 5M15 2l1.5 1.5L15 5', 'b'),
  autofit: cells(4.5, 5.5, 11, 9, 3, 2) + p('M1.5 10h3M15.5 10h3M3 8.5 4.5 10 3 11.5M17 8.5 15.5 10l1.5 1.5', 'b thick'),
  cellAlignment: r(2.5, 2.5, 15, 15, 'of') + p('M6 10h8M6 12.5h5', 'b thick'),
  alignTopLeft: r(2.5, 2.5, 15, 15, 'of') + p('M5 6h7M5 8.5h5', 'b thick'),
  alignMiddleCenter: r(2.5, 2.5, 15, 15, 'of') + p('M6.5 9h7M7.5 11.5h5', 'b thick'),
  alignBottomRight: r(2.5, 2.5, 15, 15, 'of') + p('M8 12h7M10 14.5h5', 'b thick'),
  cellMargins: r(2.5, 2.5, 15, 15, 'of') + r(5.5, 5.5, 9, 9, 'b dash') + lines(7, 8.5, 6, 2, 3),
  repeatHeader: cells(2.5, 2.5, 13, 15, 3, 4, { head: 'bs' }) + cells(2.5, 2.5, 13, 15, 3, 4, { frame: 'o' }) + p('M17.5 7v6M15.8 11.3l1.7 1.7 1.7-1.7', 'b thick'),
  keepRow: cells(2.5, 3.5, 15, 13, 3, 3) + r(2.5, 7.8, 15, 4.4, 'b thick'),
  cellShading: tableWith(2.5, 3.5, 15, 13, 3, 3, r(7.5, 7.83, 5, 4.33, 'bs')),
  cellBorders: borderIcon(['top', 'bottom', 'left', 'right', 'h', 'v']),
  headerRow: cells(2.5, 3.5, 15, 13, 3, 4, { head: 'bs' }) + cells(2.5, 3.5, 15, 13, 3, 4, { frame: 'o' }),
  tableActions: cells(2.5, 3.5, 11, 11, 2, 3) + badge(15, 15, 'plus', 'b'),
  // Paragraph Before/After: a line of text added above or below a table.
  paragraphBefore: p('M3.5 3.5h8M3.5 6h5', 'o') + cells(3.5, 9, 13, 8.5, 3, 2) + badge(15.5, 4.5, 'plus', 'g', 3),
  paragraphAfter: cells(3.5, 2.5, 13, 8.5, 3, 2) + p('M3.5 14h8M3.5 16.5h5', 'o') + badge(15.5, 15.5, 'plus', 'g', 3),
  insertTab: p('M3.5 10h11M11.5 7l3 3-3 3', 'b thick') + p('M16.5 5v10', 'o'),
};

/* ---- Mailings: envelopes, labels and mail merge ---- */
const envelopeShape = (x, y, w, h, c = 'of') => r(x, y, w, h, c, 1.4) + p(`M${x + 0.4} ${y + 0.6}l${n(w / 2 - 0.4)} ${n(h * 0.5)} ${n(w / 2 - 0.4)}-${n(h * 0.5)}`, 'o');
const person = (cx, cy, c = 'bf') => ci(cx, cy - 3.2, 2.3, c) + p(`M${cx - 4.2} ${cy + 4.5}c0-2.6 1.9-4.4 4.2-4.4s4.2 1.8 4.2 4.4z`, c);
const chevrons = (x, y, c = 'b thick') => p(`M${x + 2} ${y - 2}l-2 2 2 2M${x + 4.5} ${y - 2}l-2 2 2 2M${x + 8} ${y - 2}l2 2-2 2M${x + 10.5} ${y - 2}l2 2-2 2`, c);
const recordArrow = (dir, bar) => (dir < 0 ? p('M14.5 5 7.5 10l7 5z', 'bs') : p('M5.5 5l7 5-7 5z', 'bs')) + (bar ? p(dir < 0 ? 'M5 5v10' : 'M15 5v10', 'o thick') : '');
Object.assign(COMMAND_ICONS, {
  envelope: envelopeShape(2.5, 4.5, 15, 11) + r(13, 6, 3, 3.6, 'rs', 0.5),
  labels: r(3.5, 2.5, 13, 15, 'of') + [0, 1, 2].map(i => r(5, 4 + i * 4.5, 4.4, 3.4, 'bf', 1) + r(10.6, 4 + i * 4.5, 4.4, 3.4, 'bf', 1)).join(''),
  startMerge: page(2.5, 2.5, 10, 13) + lines(4.5, 8, 6, 2, 2.5) + envelopeShape(9, 10.5, 8.5, 6.5, 'bf'),
  selectRecipients: person(13, 9.5, 'o') + person(8, 10.5, 'bf'),
  editRecipients: cells(2.5, 3.5, 12, 13, 2, 4) + pencil(3, 2),
  highlightFields: r(2.5, 6, 15, 8, 'yf', 2) + chevrons(3.7, 10, 'o thick'),
  addressBlock: r(2.5, 4, 15, 12, 'of', 1.6) + p('M5 7.5h7', 'b thick') + lines(5, 10.5, 9, 2, 2.5),
  greetingLine: bubble(2.5, 3, 15, 11) + p('M5.5 7.5h6', 'b thick') + p('M5.5 10.3h9', 'o'),
  mergeField: r(2.5, 6, 15, 8, 'bf', 2) + chevrons(3.7, 10),
  rules: p('M3 10h4.5l4-5h3M7.5 10l4 5h3', 'o') + p('M13.5 3l2.5 2-2.5 2M13.5 13l2.5 2-2.5 2', 'b thick') + ci(4, 10, 1.4, 'bs'),
  matchFields: r(2.5, 3.5, 5, 13, 'of', 1) + r(12.5, 3.5, 5, 13, 'of', 1) + p('M7.5 6.5l5 7M7.5 10h5M7.5 13.5l5-7', 'b'),
  updateLabels: r(2.5, 2.5, 11, 13, 'of') + r(4, 4, 3.5, 2.8, 'bf', 0.8) + r(8.5, 4, 3.5, 2.8, 'bf', 0.8) + r(4, 8, 3.5, 2.8, 'bf', 0.8) + refresh,
  previewResults: page(2.5, 2.5, 11, 15) + chevrons(3.6, 8, 'b') + magnifier(13, 13, 3),
  firstRecord: recordArrow(-1, true),
  previousRecord: recordArrow(-1, false),
  nextRecord: recordArrow(1, false),
  lastRecord: recordArrow(1, true),
  findRecipient: person(8, 10.5, 'bf') + magnifier(13.5, 12.5, 2.8),
  checkErrors: page(3.5, 2.5, 11, 15) + lines(5.5, 7.5, 7, 3, 2.5) + badge(14.5, 14.5, 'check', 'g'),
  finishMerge: page(6.5, 2.5, 10, 12, 2.5) + page(3.5, 5.5, 10, 12, 2.5) + arrowRight(9, 12, 9, 'g thick'),
  mergeWizard: page(3.5, 2.5, 13, 15) + numberedLines(6.3, 6, ['1', '2', '3'], 4) + lines(8.5, 6, 5, 3, 4),
});
/* Feature areas draw their own icons in src/ui/icons/, with the same helpers and classes. */
const HELPERS = { p, r, ci, t, cells, page, lines, arrowDown, arrowRight, arrowUp, arrowLeft, badge, n, sheet, tintedPage, headBand, footBand, rows, pencil, settingsBadge, corners, picture, ROUND };
for (const icons of [designIcons, layoutIcons, textFlowIcons]) Object.assign(COMMAND_ICONS, icons(HELPERS));

/** Aliases: the editor's existing control icon names that map onto a drawing above. */
const ALIASES = {
  outline: 'navigationPane', search: 'find', image: 'pictures', clearFormat: 'clearFormat', paint: 'shading',
  insertPageBreak: 'pageBreak', pageSettings: 'pageSetup', header: 'pageBreakBefore', history: 'restartNumbering',
  eraser: 'clearParagraph', fitWidth: 'characterSpacing', expand: 'textWidth', settings: 'tableProperties',
  tab: 'insertTab', merge: 'keepNext', rows: 'keepLines', rowsSplit: 'widowControl', listView: 'contextualSpacing',
  pencil: 'editStyle', plus: 'newStyle', gridView: 'template', fileDown: 'download', cutIcon: 'cut',
};

export function commandIconBody(name) {
  return COMMAND_ICONS[name] ?? COMMAND_ICONS[ALIASES[name]] ?? null;
}

/** The icon as an SVG string, or null when this set has no drawing for the name. */
export function commandIcon(name, size) {
  const body = commandIconBody(name);
  if (!body) return null;
  return `<svg class="ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const COMMAND_ICON_NAMES = Object.keys(COMMAND_ICONS);
