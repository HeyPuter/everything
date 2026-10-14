/**
 * SmartArt diagrams (Insert ▸ Illustrations ▸ SmartArt): a drawing object on the sheet (sheet.charts, type
 * 'smartart') whose content is an outline — a flat list of items, each with its text and its level — drawn
 * by one of the layouts in smartart-layouts.js. The object keeps only what someone chose (the outline, the
 * layout, a colour scheme, a style, Right to Left and any shape's own formatting); every shape, text size
 * and colour is worked out again from that whenever it is drawn, so a diagram follows its own resizing,
 * the workbook's theme and later edits of its text.
 *
 * The model: { type: 'smartart', layout, items: [{ text, level, fmt? }], colors, style, rtl?, ... } plus the
 * anchor, size, name, group and alt text every drawing object has. `fmt` is a shape's own formatting
 * (Format tab): { fill, line, color, scale, shape }.
 */
import { SMARTART_LAYOUTS, layoutById, DEFAULT_LAYOUT } from './smartart-layouts.js';
import { shapePath, pathData, connectorHead, DIRECTED, CHANGEABLE_SHAPES } from './smartart-geometry.js';
import { DEFAULT_COLOR_PALETTE } from './font-color.js';
import { normalizeNativeDrawing } from './drawingml-native.js';

export { SMARTART_LAYOUTS, layoutById, DEFAULT_LAYOUT, CHANGEABLE_SHAPES };
export { SMARTART_CATEGORIES } from './smartart-layouts.js';

export const SMARTART_MIN = 60;
export const SMARTART_MAX_ITEMS = 300;
export const SMARTART_TEXT_MAX = 1000;
export const SMARTART_MAX_LEVEL = 6;
const HEX = /^#[0-9a-f]{6}$/i;

/* ---------- The model ---------- */

/** Levels made consistent: the first item is at the top, and no item is more than one level below the one before. */
function fixLevels(items) {
  let prev = -1;
  return items.map((it) => {
    const level = Math.max(0, Math.min(SMARTART_MAX_LEVEL, prev + 1, it.level | 0));
    prev = level;
    return level === it.level ? it : { ...it, level };
  });
}

function normalizeFmt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['fill', 'line', 'color']) if (typeof raw[k] === 'string' && (HEX.test(raw[k]) || raw[k] === 'none')) out[k] = raw[k].toLowerCase();
  const scale = Number(raw.scale);
  if (Number.isFinite(scale) && Math.abs(scale - 1) > 1e-6) out.scale = Math.max(0.4, Math.min(2.5, Math.round(scale * 100) / 100));
  if (CHANGEABLE_SHAPES.some(([k]) => k === raw.shape)) out.shape = raw.shape;
  return Object.keys(out).length ? out : null;
}

export function normalizeSmartArtItems(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, SMARTART_MAX_ITEMS) : [];
  return fixLevels(list.filter((it) => it && typeof it === 'object').map((it) => {
    const fmt = normalizeFmt(it.fmt);
    return { text: String(it.text ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, SMARTART_TEXT_MAX), level: Number.isInteger(it.level) ? it.level : 0, ...(fmt ? { fmt } : {}) };
  }));
}

/** The diagram's own fields from a stored object (the drawing-object fields are charts.js's). */
export function normalizeSmartArt(raw) {
  const layout = layoutById(raw?.layout) ? raw.layout : DEFAULT_LAYOUT;
  const out = {
    layout,
    items: normalizeSmartArtItems(raw?.items),
    colors: colorSchemeById(raw?.colors) ? raw.colors : DEFAULT_COLORS,
    style: SMARTART_STYLES.some((s) => s.id === raw?.style) ? raw.style : 'flat',
  };
  if (raw?.rtl === true) out.rtl = true;
  // A diagram another program made, drawn as that program left it until someone changes it here.
  const fb = raw?.fallback;
  if (fb && typeof fb === 'object' && typeof fb.src === 'string' && fb.src.startsWith('data:image/svg+xml;base64,') && fb.src.length <= 8_000_000) {
    const native = normalizeNativeDrawing(fb.nativeDrawing);
    const pad = Array.isArray(fb.pad) && fb.pad.length === 2 && fb.pad.every((n) => Number.isFinite(n) && n >= 0 && n < 1) ? { pad: [...fb.pad] } : {};
    out.fallback = { src: fb.src, ...pad, ...(native ? { nativeDrawing: native } : {}) };
  }
  if (typeof raw?.sourceLayout === 'string' && raw.sourceLayout.length <= 300) out.sourceLayout = raw.sourceLayout;
  return out;
}

/** A new diagram's fields: the layout's sample outline unless `items` are given. */
export function newSmartArt(layoutId, items = null) {
  const layout = layoutById(layoutId) || layoutById(DEFAULT_LAYOUT);
  return { type: 'smartart', layout: layout.id, items: normalizeSmartArtItems(items?.length ? items : layout.sample()), colors: DEFAULT_COLORS, style: 'flat' };
}

/** The outline as a tree: [{ i, text, level, children }] for the top-level items. */
export function smartArtTree(items) {
  const roots = [], stack = [];
  items.forEach((it, i) => {
    const n = { i, text: it.text, level: it.level, children: [] };
    while (stack.length && stack.at(-1).level >= it.level) stack.pop();
    (stack.length ? stack.at(-1).children : roots).push(n);
    stack.push(n);
  });
  return roots;
}

/* ---------- Editing the outline (each returns the new items and the item to select, or null when it cannot) ---------- */

/** The index just past an item's sub-items. */
export function subtreeEnd(items, at) {
  let end = at + 1;
  while (end < items.length && items[end].level > items[at].level) end++;
  return end;
}

const shiftLevels = (items, from, to, by) => items.map((it, i) => (i >= from && i < to ? { ...it, level: it.level + by } : it));

/**
 * Add Shape: 'after' or 'before' the item (a sibling), 'above' it (a new parent the item and its
 * sub-items move under) or 'below' it (a new last sub-item). With no items, the first one.
 */
export function addSmartArtItem(items, at, where = 'after', text = '') {
  if (items.length >= SMARTART_MAX_ITEMS) return null;
  if (!items.length || at == null || at < 0 || at >= items.length) {
    const next = [...items, { text, level: 0 }];
    return { items: next, at: next.length - 1 };
  }
  const level = items[at].level, end = subtreeEnd(items, at);
  if (where === 'before') return { items: fixLevels([...items.slice(0, at), { text, level }, ...items.slice(at)]), at };
  if (where === 'below') {
    if (level >= SMARTART_MAX_LEVEL) return null;
    return { items: fixLevels([...items.slice(0, end), { text, level: level + 1 }, ...items.slice(end)]), at: end };
  }
  if (where === 'above') {
    if (items.slice(at, end).some((it) => it.level >= SMARTART_MAX_LEVEL)) return null;
    const moved = shiftLevels(items, at, end, 1);
    return { items: fixLevels([...moved.slice(0, at), { text, level }, ...moved.slice(at)]), at };
  }
  return { items: fixLevels([...items.slice(0, end), { text, level }, ...items.slice(end)]), at: end };
}

/** Promote: the item and its sub-items one level up. */
export function promoteSmartArtItem(items, at) {
  if (!items[at] || items[at].level === 0) return null;
  return { items: fixLevels(shiftLevels(items, at, subtreeEnd(items, at), -1)), at };
}

/** Demote: the item and its sub-items one level down, under the item before it. */
export function demoteSmartArtItem(items, at) {
  if (!items[at] || at === 0 || items[at].level > items[at - 1].level) return null;
  const end = subtreeEnd(items, at);
  if (items.slice(at, end).some((it) => it.level >= SMARTART_MAX_LEVEL)) return null;
  return { items: shiftLevels(items, at, end, 1), at };
}

/** Move Up / Move Down: the item with its sub-items past its neighbouring sibling (and that one's sub-items). */
export function moveSmartArtItem(items, at, dir) {
  if (!items[at]) return null;
  const level = items[at].level, end = subtreeEnd(items, at), block = items.slice(at, end);
  if (dir < 0) {
    let prev = at - 1;
    while (prev >= 0 && items[prev].level > level) prev--;
    if (prev < 0 || items[prev].level !== level) return null;
    return { items: [...items.slice(0, prev), ...block, ...items.slice(prev, at), ...items.slice(end)], at: prev };
  }
  if (end >= items.length || items[end].level !== level) return null;
  const nextEnd = subtreeEnd(items, end);
  return { items: [...items.slice(0, at), ...items.slice(end, nextEnd), ...block, ...items.slice(nextEnd)], at: at + (nextEnd - end) };
}

/** Delete an item; its sub-items move up a level into its place. */
export function removeSmartArtItem(items, at) {
  if (!items[at]) return null;
  const end = subtreeEnd(items, at);
  const next = fixLevels([...items.slice(0, at), ...shiftLevels(items, at + 1, end, -1).slice(at + 1)]);
  return { items: next, at: Math.min(at, next.length - 1) };
}

export function setSmartArtItemText(items, at, text) {
  if (!items[at]) return null;
  const clean = String(text ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, SMARTART_TEXT_MAX);
  if (clean === items[at].text) return null;
  return { items: items.map((it, i) => (i === at ? { ...it, text: clean } : it)), at };
}

/** Enter in the Text Pane: the text after `offset` becomes a new item at the same level after this one. */
export function splitSmartArtItem(items, at, offset) {
  if (!items[at] || items.length >= SMARTART_MAX_ITEMS) return null;
  const text = items[at].text, cut = Math.max(0, Math.min(text.length, offset ?? text.length));
  const hasKids = subtreeEnd(items, at) > at + 1;
  // A split at the end of an item with sub-items starts its first sub-item, as an outline would.
  const level = cut === text.length && hasKids ? items[at].level + 1 : items[at].level;
  const head = { ...items[at], text: text.slice(0, cut) }, tail = { text: text.slice(cut), level };
  return { items: [...items.slice(0, at), head, tail, ...items.slice(at + 1)], at: at + 1 };
}

/** Backspace at the start of an item: its text joins the item before it (whose sub-items it had been after). */
export function mergeSmartArtItem(items, at) {
  if (!items[at] || at === 0) return null;
  const prev = items[at - 1], joined = { ...prev, text: (prev.text + items[at].text).slice(0, SMARTART_TEXT_MAX) };
  return { items: fixLevels([...items.slice(0, at - 1), joined, ...items.slice(at + 1)]), at: at - 1, offset: prev.text.length };
}

/** An outline from plain text: one item per line, tabs or pairs of spaces at its start its level. */
export function smartArtItemsFromText(text) {
  return normalizeSmartArtItems(String(text ?? '').split(/\r\n?|\n/).filter((l) => l.trim()).map((l) => {
    const lead = /^[\t ]*/.exec(l)[0];
    return { text: l.trim().replace(/^[•\-*]\s+/, ''), level: (lead.match(/\t/g) || []).length + Math.floor(lead.replace(/\t/g, '').length / 2) };
  }));
}

/** The outline as plain text, a tab per level. */
export const smartArtOutlineText = (items) => items.map((it) => `${'\t'.repeat(it.level)}${it.text}`).join('\n');

/** The alt text a diagram reads as when it has none of its own: its layout and its outline. */
export function smartArtAltText(model) {
  const layout = layoutById(model.layout);
  const say = (n) => (n.children.length ? `${n.text || 'empty'} (${n.children.map(say).join(', ')})` : n.text || 'empty');
  const roots = smartArtTree(model.items || []);
  return `${layout?.name || 'SmartArt'} diagram${roots.length ? `: ${roots.map(say).join('; ')}` : ' with no items'}`;
}

/* ---------- Colours (SmartArt Design ▸ Change Colors) ---------- */

/** The theme's twelve colours by name. */
export function themePalette(colors = DEFAULT_COLOR_PALETTE.theme) {
  const c = (i) => (HEX.test(colors?.[i] || '') ? colors[i].toLowerCase() : DEFAULT_COLOR_PALETTE.theme[i]);
  return { lt1: c(0), dk1: c(1), lt2: c(2), dk2: c(3), accents: [4, 5, 6, 7, 8, 9].map(c) };
}

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` moved the fraction `t` of the way to `b`. */
export const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));
const lighten = (c, t) => mix(c, '#ffffff', t);
const darken = (c, t) => mix(c, '#000000', t);
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Text on a fill: the theme's light colour on dark fills, its dark colour on light ones. */
const textOn = (fill, P) => (luminance(fill) > 0.42 ? P.dk1 : P.lt1);

const scheme = (id, name, group, mode, base) => ({ id, name, group, mode, base });
const ACCENT_NAMES = ['Accent 1', 'Accent 2', 'Accent 3', 'Accent 4', 'Accent 5', 'Accent 6'];
/**
 * The colour schemes, each from the workbook's theme: a mode (filled, light fill, outline) and the base
 * colour of the shape whose colour place is `ci` among `n` places.
 */
export const SMARTART_COLOR_SCHEMES = [
  scheme('dark', 'Dark', 'Primary', 'fill', (ci, n, P) => P.dk2),
  scheme('darkLight', 'Dark, light fill', 'Primary', 'light', (ci, n, P) => P.dk2),
  scheme('darkOutline', 'Dark outline', 'Primary', 'outline', (ci, n, P) => P.dk1),
  scheme('colorful1', 'Colorful', 'Colorful', 'fill', (ci, n, P) => P.accents[ci % 6]),
  scheme('colorful2', 'Colorful from Accent 2', 'Colorful', 'fill', (ci, n, P) => P.accents[(ci + 1) % 6]),
  scheme('colorfulOdd', 'Colorful, Accents 1, 3, 5', 'Colorful', 'fill', (ci, n, P) => P.accents[[0, 2, 4][ci % 3]]),
  scheme('colorfulEven', 'Colorful, Accents 2, 4, 6', 'Colorful', 'fill', (ci, n, P) => P.accents[[1, 3, 5][ci % 3]]),
  ...ACCENT_NAMES.flatMap((name, k) => [
    scheme(`accent${k + 1}`, name, name, 'fill', (ci, n, P) => P.accents[k]),
    scheme(`accent${k + 1}Range`, `${name}, shaded range`, name, 'fill', (ci, n, P) => {
      const t = n > 1 ? ci / (n - 1) : 0;
      return t < 0.35 ? mix(darken(P.accents[k], 0.28), P.accents[k], t / 0.35) : mix(P.accents[k], lighten(P.accents[k], 0.5), (t - 0.35) / 0.65);
    }),
    scheme(`accent${k + 1}Light`, `${name}, light fill`, name, 'light', (ci, n, P) => P.accents[k]),
    scheme(`accent${k + 1}Outline`, `${name}, outline`, name, 'outline', (ci, n, P) => P.accents[k]),
  ]),
];
export const DEFAULT_COLORS = 'accent1';
export const colorSchemeById = (id) => SMARTART_COLOR_SCHEMES.find((s) => s.id === id) || null;

/* ---------- Styles (SmartArt Design ▸ Styles) ---------- */

export const SMARTART_STYLES = [
  { id: 'flat', name: 'Flat', description: 'Solid colour with a thin light edge' },
  { id: 'subtle', name: 'Soft Shadow', description: 'Solid colour lifted by a soft shadow', shadow: { dy: 1.5, blur: 1.4, alpha: 0.32 }, noLine: true },
  { id: 'moderate', name: 'Gentle Gradient', description: 'A light-to-full gradient with a soft shadow', gradient: [0.32, 0], shadow: { dy: 1.5, blur: 1.6, alpha: 0.28 } },
  { id: 'intense', name: 'Deep Gradient', description: 'A strong gradient, a darker edge and a deeper shadow', gradient: [0.4, -0.22], shadow: { dy: 3, blur: 2.6, alpha: 0.4 }, lineShade: 0.32 },
  { id: 'polished', name: 'Glossy', description: 'A bright sheen over the top half', gloss: true, noLine: true, shadow: { dy: 1, blur: 1.2, alpha: 0.25 } },
  { id: 'outlined', name: 'Bold Outline', description: 'A heavy darker outline round every shape', lineWidth: 3, lineShade: 0.38 },
];

/**
 * How a shape is painted: { fill, fillOpacity, line, lineWidth, text, gradient: [top, bottom] | gloss, shadow }.
 * `fill` and `line` may be null (none).
 */
export function smartArtPaint(shape, model, P, n) {
  const sc = colorSchemeById(model.colors) || colorSchemeById(DEFAULT_COLORS);
  const base = sc.base(shape.ci ?? 0, Math.max(1, n), P), mode = sc.mode;
  let p;
  switch (shape.role) {
    case 'node':
      p = mode === 'fill' ? { fill: base, line: P.lt1, lineWidth: 1.5, text: textOn(base, P) }
        : mode === 'light' ? { fill: lighten(base, 0.74), line: lighten(base, 0.3), lineWidth: 1.25, text: P.dk1 }
          : { fill: P.lt1, line: base, lineWidth: 2, text: P.dk1 };
      break;
    case 'sub': p = { fill: lighten(base, 0.86), fillOpacity: 0.94, line: lighten(base, 0.25), lineWidth: 1.25, text: P.dk1 }; break;
    case 'conn': p = { fill: lighten(base, mode === 'fill' ? 0.4 : 0.55), line: null, text: P.dk1 }; break;
    case 'deco': p = { fill: lighten(base, 0.7), line: null, text: P.dk1 }; break;
    case 'line': p = { fill: null, line: mode === 'outline' ? base : darken(base, 0.08), lineWidth: shape.weight ?? 1.5 }; break;
    case 'ring': p = { fill: null, line: lighten(base, 0.45), lineWidth: 1.5 }; break;
    default: p = { fill: null, line: null, text: P.dk1 };
  }
  if (shape.opacity != null && p.fill) p.fillOpacity = shape.opacity;
  // The shape's own formatting (Format tab) wins over the scheme.
  const fmt = shape.item != null && ['node', 'sub', 'text'].includes(shape.role) ? model.items?.[shape.item]?.fmt : null;
  if (fmt?.fill) p.fill = fmt.fill === 'none' ? null : fmt.fill;
  if (fmt?.line) { p.line = fmt.line === 'none' ? null : fmt.line; p.lineWidth ||= 1.5; }
  if (fmt?.color && fmt.color !== 'none') p.text = fmt.color;
  // The style: shading, sheen, edges and shadows on the filled shapes.
  const st = SMARTART_STYLES.find((s) => s.id === model.style) || SMARTART_STYLES[0];
  if (p.fill && ['node', 'sub', 'conn', 'deco'].includes(shape.role)) {
    if (st.gradient && shape.role !== 'sub') p.gradient = st.gradient.map((t) => (t >= 0 ? lighten(p.fill, t) : darken(p.fill, -t)));
    if (st.gloss && shape.role !== 'sub') p.gloss = [lighten(p.fill, 0.55), p.fill, darken(p.fill, 0.1)];
    if (st.shadow && shape.role !== 'deco') p.shadow = st.shadow;
    if (st.noLine && shape.role === 'node' && mode === 'fill' && !fmt?.line) p.line = null;
    if (st.lineShade && p.line !== null && !fmt?.line) p.line = darken(mode === 'outline' ? base : p.fill, st.lineShade);
    if (st.lineWidth && p.line) p.lineWidth = mode === 'outline' ? st.lineWidth + 0.5 : st.lineWidth;
  }
  return p;
}

/* ---------- Text: measuring, wrapping and fitting ---------- */

/**
 * Character widths in thousandths of an em of a common sans-serif face (printable ASCII from the space), a
 * little wider than most body faces, so text measured with them fits whatever face draws it, and layouts
 * come out the same on every machine.
 */
const WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
  944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c < 127) return WIDTHS[c - 32] / 1000;
  return c >= 0x2e80 ? 1 : 0.6;
}
export const textWidth = (text, size) => [...String(text)].reduce((s, ch) => s + charWidth(ch), 0) * size;

/** Lines of `text` within `width` at `size`; `broke` when a word had to be split. */
function wrap(text, width, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [''], broke: false };
  const lines = [];
  let cur = '', broke = false;
  for (let word of words) {
    const tryLine = cur ? `${cur} ${word}` : word;
    if (textWidth(tryLine, size) <= width) { cur = tryLine; continue; }
    if (cur) { lines.push(cur); cur = ''; }
    while (textWidth(word, size) > width && word.length > 1) {
      broke = true;
      let k = word.length - 1;
      while (k > 1 && textWidth(word.slice(0, k), size) > width) k--;
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    cur = word;
  }
  if (cur) lines.push(cur);
  return { lines, broke };
}

const LINE_HEIGHT = 1.2;
const PARA_GAP = 0.2;
/**
 * A paragraph's text size and indents: sub-items under an item's own text a little smaller, and a bullet's
 * text indented past its bullet, a level deeper further in. { size, indent, bulletX } (offsets from the box).
 */
export function smartArtParaMetrics(paras, p, size) {
  const s = p.level > 0 && paras.some((q) => q.level === 0) ? size * 0.82 : size;
  return { size: s, indent: p.bullet ? s * (0.9 + Math.max(0, p.level - 1) * 0.9) : 0, bulletX: p.bullet ? s * (0.15 + Math.max(0, p.level - 1) * 0.9) : null };
}

/** The text's lines at `size` in `box`: [{ text, x, y (baseline), size, bulletX }], its height, and whether it fits. */
export function setText(paras, box, size, align = 'center', valign = 'middle') {
  const lines = [];
  let y = 0, broke = false;
  paras.forEach((p, k) => {
    const { size: s, indent, bulletX } = smartArtParaMetrics(paras, p, size);
    if (k) y += s * PARA_GAP;
    const w = wrap(p.text, Math.max(1, box.w - indent), s);
    broke ||= w.broke;
    w.lines.forEach((t, j) => {
      lines.push({ text: t, size: s, y: y + s * 0.92, indent, ...(j === 0 && bulletX != null ? { bulletX } : {}), item: p.item, para: k });
      y += s * LINE_HEIGHT;
    });
  });
  const height = y;
  const top = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - height : box.y + (box.h - height) / 2;
  for (const l of lines) {
    l.y += top;
    const a = l.bulletX != null || l.indent ? 'left' : align;
    l.anchor = a === 'left' ? 'start' : a === 'right' ? 'end' : 'middle';
    l.x = a === 'left' ? box.x + l.indent : a === 'right' ? box.x + box.w : box.x + box.w / 2;
    if (l.bulletX != null) l.bulletX += box.x;
  }
  return { lines, height, fits: height <= box.h + 0.5 && !broke };
}

/** Where a shape's text goes when its layout does not say: inside the shape, clear of its edges. */
function textBox(s) {
  if (s.text) return s.text;
  const pad = Math.max(3, Math.min(s.w, s.h) * 0.1);
  if (s.kind === 'ellipse') return { x: s.x + s.w * 0.15, y: s.y + s.h * 0.15, w: s.w * 0.7, h: s.h * 0.7 };
  if (s.kind === 'diamond') return { x: s.x + s.w * 0.25, y: s.y + s.h * 0.25, w: s.w * 0.5, h: s.h * 0.5 };
  if (s.kind === 'triangle') return { x: s.x + s.w * 0.25, y: s.y + s.h * 0.45, w: s.w * 0.5, h: s.h * 0.5 };
  if (s.kind === 'hexagon' || s.kind === 'octagon') return { x: s.x + s.w * 0.18, y: s.y + pad, w: s.w * 0.64, h: s.h - 2 * pad };
  if (s.kind === 'chevron' || s.kind === 'homePlate') { const d = Math.min(s.h * 0.5, s.w * 0.45); return { x: s.x + d * 0.9, y: s.y + pad, w: Math.max(4, s.w - d * 1.8), h: s.h - 2 * pad }; }
  return { x: s.x + pad, y: s.y + pad, w: Math.max(1, s.w - 2 * pad), h: Math.max(1, s.h - 2 * pad) };
}

const MIN_SIZE = 6;
/** The largest size (to half a pixel) at which the text fits its box, at least MIN_SIZE. */
function bestSize(s, max) {
  const box = textBox(s);
  if (!(box.w > 2 && box.h > 2)) return MIN_SIZE;
  if (setText(s.paras, box, max, s.align, s.valign).fits) return max;
  let lo = MIN_SIZE, hi = max;
  if (!setText(s.paras, box, lo, s.align, s.valign).fits) return lo;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    if (setText(s.paras, box, mid, s.align, s.valign).fits) lo = mid; else hi = mid;
  }
  return Math.floor(lo * 2) / 2;
}

/* ---------- The engine ---------- */

/**
 * Every shape of the diagram drawn in a w × h frame, in drawing order, each with its text set: the layout's
 * shapes, then the shapes' own sizes and kinds (Format tab), Right to Left, and one text size for each group
 * of like shapes, as large as lets all of them fit. Returns { shapes, shown, hidden } (top-level items drawn
 * and left out by a layout that shows only some).
 */
export function smartArtShapes(model, w, h) {
  const layout = layoutById(model.layout) || layoutById(DEFAULT_LAYOUT);
  const items = model.items || [];
  const roots = smartArtTree(items);
  const shownRoots = layout.maxRoots ? roots.slice(0, layout.maxRoots) : roots;
  const pad = Math.max(2, Math.min(w, h) * 0.03);
  const area = { x: pad, y: pad, w: w - 2 * pad, h: h - 2 * pad };
  let shapes = shownRoots.length && area.w > 6 && area.h > 6 ? layout.build(shownRoots, area) : [];
  shapes = shapes.filter((s) => [s.x, s.y, s.w, s.h].every(Number.isFinite) && s.w >= 0 && s.h >= 0);
  // A shape's own size and kind (Format ▸ Larger, Smaller, Change Shape) on the item's own shapes.
  shapes = shapes.map((s) => {
    const fmt = s.item != null && s.role === 'node' ? items[s.item]?.fmt : null;
    if (!fmt) return s;
    let out = s;
    if (fmt.shape && s.kind !== 'line') out = { ...out, kind: fmt.shape, adj: {}, ...(['sector', 'arcArrow'].includes(s.kind) ? { text: null } : {}) };
    if (fmt.scale) {
      const k = fmt.scale, cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const sc = (r) => r && { x: cx + (r.x - cx) * k, y: cy + (r.y - cy) * k, w: r.w * k, h: r.h * k };
      out = { ...out, ...sc(out), ...(out.text ? { text: sc(out.text) } : {}), ...(out.adj?.depth ? { adj: { ...out.adj, depth: out.adj.depth * k } } : {}) };
    }
    return out;
  });
  if (model.rtl) shapes = shapes.map((s) => mirror(s, w));
  // One size for each group of like shapes: the largest at which all of them fit.
  const groups = new Map();
  for (const s of shapes) {
    if (!s.paras?.length) continue;
    s.align ||= 'center'; s.valign ||= 'middle';
    if (model.rtl && s.align === 'left') s.align = 'right';
    const bulletsOnly = s.paras.every((p) => p.bullet);
    const key = s.fit || (bulletsOnly ? 'bullets' : s.role);
    const max = s.maxSize ?? Math.max(10, Math.min(bulletsOnly || s.role === 'sub' ? 24 : 32, h * (bulletsOnly || s.role === 'sub' ? 0.075 : 0.1)));
    const size = bestSize(s, max);
    groups.set(key, Math.min(groups.get(key) ?? Infinity, size));
    s.fitKey = key;
  }
  for (const s of shapes) {
    if (!s.paras?.length) continue;
    s.fontSize = groups.get(s.fitKey);
    s.textBox = textBox(s);
    s.lines = setText(s.paras, s.textBox, s.fontSize, s.align, s.valign).lines;
    if (model.rtl) for (const l of s.lines) if (l.bulletX != null) { l.anchor = 'end'; l.x = s.textBox.x + s.textBox.w - l.indent; l.bulletX = s.textBox.x + s.textBox.w - (l.bulletX - s.textBox.x); }
  }
  return { shapes, shown: shownRoots.length, hidden: roots.length - shownRoots.length, colorPlaces: 1 + Math.max(0, ...shapes.map((s) => s.ci ?? 0)) };
}

/** A shape turned about the frame's vertical centre line (Right to Left). */
function mirror(s, W) {
  const m = { ...s, x: W - s.x - s.w };
  if (s.text) m.text = { ...s.text, x: W - s.text.x - s.text.w };
  if (s.points) m.points = s.points.map(([x, y]) => [W - x, y]);
  if (s.rot) m.rot = -s.rot;
  if (s.kind === 'rightArrow') m.kind = 'leftArrow';
  else if (s.kind === 'leftArrow') m.kind = 'rightArrow';
  else if (DIRECTED.has(s.kind)) m.flipH = !s.flipH;
  if (s.kind === 'sector' || s.kind === 'arcArrow') m.adj = { ...s.adj, a0: 180 - s.adj.a0, a1: 180 - s.adj.a1 };
  return m;
}

/** A shape's outline as path commands in its own box, its line points made local. */
export function smartArtShapeCommands(s) {
  if (s.kind === 'line') return s.points.map((p, i) => [i ? 'L' : 'M', p[0] - s.x, p[1] - s.y]);
  return shapePath(s.kind, s.w, s.h, s.adj || {});
}

/* ---------- Drawing: SVG for the sheet, gallery pictures, print and copies ---------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Math.round(n * 100) / 100;

/**
 * The diagram as SVG markup. Options: colors (the theme's twelve), fontFamily (CSS), idPrefix (unique per
 * picture on a page), placeholders (empty items show “[Text]”, on screen only), selected (a Set of item
 * indexes drawn with a dashed frame), thumbnail (text drawn as bars, for gallery pictures), label, and for one
 * shape's picture alone (Convert to Shapes) only (its index) and viewBox ([x, y, w, h] of the frame).
 */
export function smartArtSvg(model, w, h, opts = {}) {
  const P = themePalette(opts.colors);
  const { shapes, colorPlaces } = smartArtShapes(model, w, h);
  const id = opts.idPrefix || 'sa';
  const defs = [], body = [], gradients = new Map(), shadows = new Map();
  const fontFamily = esc(opts.fontFamily || 'Calibri, Carlito, "Segoe UI", Arial, sans-serif');
  const gradientId = (stops) => {
    const key = stops.join();
    if (!gradients.has(key)) {
      const gid = `${id}-g${gradients.size}`;
      gradients.set(key, gid);
      const offsets = stops.length === 3 ? [0, 0.5, 1] : [0, 1];
      defs.push(`<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">${stops.map((c, i) => `<stop offset="${offsets[i]}" stop-color="${c}"/>`).join('')}</linearGradient>`);
    }
    return gradients.get(key);
  };
  const shadowId = (sh) => {
    const key = `${sh.dy}|${sh.blur}|${sh.alpha}`;
    if (!shadows.has(key)) {
      const sid = `${id}-s${shadows.size}`;
      shadows.set(key, sid);
      defs.push(`<filter id="${sid}" x="-25%" y="-25%" width="150%" height="160%"><feDropShadow dx="0" dy="${sh.dy}" stdDeviation="${sh.blur}" flood-color="#000" flood-opacity="${sh.alpha}"/></filter>`);
    }
    return shadows.get(key);
  };
  for (const [index, s] of shapes.entries()) {
    if (opts.only != null && index !== opts.only) continue;
    const p = smartArtPaint(s, model, P, colorPlaces);
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const transform = [s.rot ? `rotate(${num(s.rot)} ${num(cx)} ${num(cy)})` : '', s.flipH ? `translate(${num(2 * cx)} 0) scale(-1 1)` : ''].filter(Boolean).join(' ');
    const parts = [];
    const d = pathData(smartArtShapeCommands(s), s.x, s.y);
    const fill = !p.fill ? 'none' : p.gloss ? `url(#${gradientId(p.gloss)})` : p.gradient ? `url(#${gradientId(p.gradient)})` : p.fill;
    const stroke = p.line ? ` stroke="${p.line}" stroke-width="${num(p.lineWidth || 1.5)}" stroke-linejoin="round"` : '';
    const filter = p.shadow ? ` filter="url(#${shadowId(p.shadow)})"` : '';
    const opacity = p.fill && p.fillOpacity != null && p.fillOpacity < 1 ? ` fill-opacity="${p.fillOpacity}"` : '';
    if (s.kind === 'line') {
      parts.push(`<path d="${d}" fill="none"${stroke} stroke-linecap="round"/>`);
      const head = s.arrow && connectorHead(s.points, Math.max(6, (p.lineWidth || 1.5) * 4));
      if (head) parts.push(`<path d="M${head.map((q) => q.map(num).join(' ')).join('L')}Z" fill="${p.line}"/>`);
    } else if (fill !== 'none' || stroke) {
      parts.push(`<path d="${d}" fill="${fill}"${opacity}${stroke}${filter}${transform ? ` transform="${transform}"` : ''}/>`);
    }
    if (s.lines?.length) {
      const tr = s.rot ? ` transform="rotate(${num(s.rot)} ${num(cx)} ${num(cy)})"` : '';
      const texts = [];
      for (const l of s.lines) {
        const empty = !l.text;
        if (opts.thumbnail) {
          const tw = Math.min(s.textBox.w - l.indent, textWidth(l.text || 'Text', l.size)) * 0.9, th = Math.max(1, l.size * 0.42);
          const x0 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - tw : l.x - tw / 2;
          if (tw > 0) texts.push(`<rect x="${num(x0)}" y="${num(l.y - l.size * 0.55)}" width="${num(tw)}" height="${num(th)}" rx="${num(th / 2)}" fill="${p.text}" fill-opacity="0.55"/>`);
          continue;
        }
        if (empty && !opts.placeholders) continue;
        const color = empty ? `${p.text}" fill-opacity="0.45` : p.text;
        if (l.bulletX != null) texts.push(`<text x="${num(l.bulletX)}" y="${num(l.y)}" font-size="${num(l.size)}" fill="${color}" text-anchor="${l.anchor === 'end' ? 'end' : 'start'}">•</text>`);
        texts.push(`<text x="${num(l.x)}" y="${num(l.y)}" font-size="${num(l.size)}" fill="${color}" text-anchor="${l.anchor}">${esc(empty ? '[Text]' : l.text)}</text>`);
      }
      if (texts.length) parts.push(`<g font-family="${fontFamily}"${tr}>${texts.join('')}</g>`);
    }
    if (opts.selected?.has?.(s.item) && s.item != null && s.role !== 'line') {
      parts.push(`<rect class="sa-sel" x="${num(s.x - 2)}" y="${num(s.y - 2)}" width="${num(s.w + 4)}" height="${num(s.h + 4)}" fill="none" stroke="#1a73e8" stroke-width="1.25" stroke-dasharray="4 3"${s.rot ? ` transform="rotate(${num(s.rot)} ${num(cx)} ${num(cy)})"` : ''}/>`);
    }
    if (parts.length) body.push(`<g class="sa-shape"${s.item != null ? ` data-item="${s.item}"` : ''} data-role="${s.role}">${parts.join('')}</g>`);
  }
  const label = opts.label ? ` role="img" aria-label="${esc(opts.label)}"` : ' aria-hidden="true"';
  const vb = opts.viewBox || [0, 0, w, h];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(num).join(' ')}" width="${num(vb[2])}" height="${num(vb[3])}"${label}>${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body.join('')}</svg>`;
}
