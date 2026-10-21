/**
 * Cell formatting in an OpenDocument spreadsheet: the font, fill, borders and alignment a table-cell style
 * carries, written from this app's cell style and read back into one. LibreOffice and other readers see
 * them; this app's own .ods files also keep the exact style in their settings, which wins on reading.
 */
import { fontName, fontKeyFor, layoutAlign } from './format.js';

const HEX = /^#[\da-f]{6}$/i;
/** A color as #rrggbb: a hex, or a palette reference by its resolved RGB. Automatic ink and No fill are none. */
const hexOf = (color) => (typeof color === 'string' ? (HEX.test(color) ? color.toLowerCase() : null)
  : color && typeof color === 'object' && typeof color.rgb === 'string' && HEX.test(color.rgb) ? color.rgb.toLowerCase() : null);
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attrs = (map) => Object.entries(map).map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
const pt = (px) => `${Math.round(px * 0.75 * 100) / 100}pt`;

// Line widths as LibreOffice writes Excel's border weights.
const BORDER_WIDTH = { thin: '0.74pt', medium: '1.76pt', thick: '2.49pt', dashed: '0.74pt', dotted: '0.74pt', double: '2.01pt' };
const SIDES = [['bt', 'top'], ['bb', 'bottom'], ['bl', 'left'], ['br', 'right']];

function borderValue(style, side) {
  if (!style[side]) return null;
  const edge = style[`${side}Border`] && typeof style[`${side}Border`] === 'object' ? style[`${side}Border`] : style;
  const bs = BORDER_WIDTH[edge.bs] ? edge.bs : 'thin';
  const line = bs === 'dashed' || bs === 'dotted' || bs === 'double' ? bs : 'solid';
  return `${BORDER_WIDTH[bs]} ${line} ${hexOf(edge.bc) || '#000000'}`;
}

/** Whether a style paints a cell with nothing in it: a fill or a border, which an .ods keeps for a blank cell. */
export function odsCellPaints(style) {
  return !!style && typeof style === 'object' && (!!hexOf(style.bg) || SIDES.some(([side]) => !!style[side]));
}

/**
 * The property elements of a table-cell style for an app style, in the order ODF has them
 * (table-cell, paragraph, text), or '' when the style shows nothing a table-cell style can say.
 */
export function odsCellStyleProperties(style) {
  if (!style || typeof style !== 'object') return '';
  const cell = {}, paragraph = {}, text = {};
  const bg = hexOf(style.bg);
  if (bg) cell['fo:background-color'] = bg;
  for (const [side, name] of SIDES) {
    const value = borderValue(style, side);
    if (value) cell[`fo:border-${name}`] = value;
  }
  if (style.wrap) cell['fo:wrap-option'] = 'wrap';
  if (style.shrink) cell['style:shrink-to-fit'] = 'true';
  if (['top', 'middle', 'bottom'].includes(style.valign)) cell['style:vertical-align'] = style.valign;
  if (Number.isFinite(style.rot) && style.rot !== 0 && Math.abs(style.rot) <= 90) cell['style:rotation-angle'] = String(style.rot < 0 ? 360 + style.rot : style.rot);
  // Justify is the paragraph's own; Excel's Center Across Selection, Distributed and Fill go as the side they are laid out against.
  const align = style.align === 'justify' ? 'justify' : layoutAlign(style.align);
  if (['left', 'center', 'right', 'justify'].includes(align)) {
    // Without a fixed source LibreOffice aligns by the value's type and ignores fo:text-align.
    cell['style:text-align-source'] = 'fix';
    paragraph['fo:text-align'] = { left: 'start', center: 'center', right: 'end', justify: 'justify' }[align];
  }
  Object.assign(text, textAttributes(style));
  return element('table-cell-properties', cell) + element('paragraph-properties', paragraph) + element('text-properties', text);
}

const element = (name, map) => (Object.keys(map).length ? `<style:${name}${attrs(map)}/>` : '');

/** The text-properties attributes for a style's font: family, size, colour, weight, slant, lines and position. */
function textAttributes(style) {
  const text = {};
  const family = fontName(style.font);
  if (family) text['fo:font-family'] = /[\s,'"]/.test(family) ? `'${family.replace(/'/g, "\\'")}'` : family;
  if (Number.isFinite(style.size) && style.size > 0) for (const key of ['fo:font-size', 'style:font-size-asian', 'style:font-size-complex']) text[key] = pt(style.size);
  const color = hexOf(style.color);
  if (color) text['fo:color'] = color;
  if (style.bold) for (const key of ['fo:font-weight', 'style:font-weight-asian', 'style:font-weight-complex']) text[key] = 'bold';
  if (style.italic) for (const key of ['fo:font-style', 'style:font-style-asian', 'style:font-style-complex']) text[key] = 'italic';
  if (style.underline && style.underline !== 'none') {
    Object.assign(text, { 'style:text-underline-style': 'solid', 'style:text-underline-width': 'auto', 'style:text-underline-color': 'font-color' });
    if (/^double/.test(style.underline)) text['style:text-underline-type'] = 'double';
  }
  if (style.strike) text['style:text-line-through-style'] = 'solid';
  if (style.vertAlign === 'superscript') text['style:text-position'] = 'super 58%';
  else if (style.vertAlign === 'subscript') text['style:text-position'] = 'sub 58%';
  return text;
}

/** The text-properties element of a text style for a rich-text run's character format, or ''. */
export function odsTextStyleProperties(style) {
  return style && typeof style === 'object' ? element('text-properties', textAttributes(style)) : '';
}

/** A rich-text run's character format from a text style's text-properties attributes (as odsCellStyle reads them). */
export function odsRunStyle(props) {
  const s = odsCellStyle(props) || {};
  const out = {};
  for (const key of ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'color']) if (s[key] != null) out[key] = s[key];
  const position = String(props?.['text-position'] ?? '').trim().toLowerCase();
  const shift = /^(super|sub|-?[\d.]+%)/.exec(position)?.[1];
  if (shift === 'super' || (shift && !/^(sub|0)/.test(shift) && parseFloat(shift) > 0)) out.vertAlign = 'superscript';
  else if (shift === 'sub' || (shift && parseFloat(shift) < 0)) out.vertAlign = 'subscript';
  return out;
}

/** An ODF length in points ("10pt", "0.35cm", "2px"), or NaN. */
function points(length) {
  const m = /^\s*(-?[\d.]+)\s*(pt|in|cm|mm|pc|px)\s*$/i.exec(String(length ?? ''));
  if (!m) return NaN;
  const value = Number(m[1]);
  return value * { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, px: 0.75 }[m[2].toLowerCase()];
}

const hex = (value) => {
  const v = String(value ?? '').trim().toLowerCase();
  return HEX.test(v) ? v : null;
};

/** "0.74pt solid #000000" as a border edge { bs, bc }, or null for none. */
function readBorder(value) {
  const parts = String(value ?? '').trim().toLowerCase().split(/\s+/);
  if (!parts[0] || parts.includes('none') || parts.includes('hidden')) return null;
  const width = parts.map(points).find(Number.isFinite) ?? (parts.includes('thick') ? 2.5 : parts.includes('medium') ? 1.75 : 0.75);
  if (width <= 0) return null;
  const line = parts.find((p) => ['solid', 'dashed', 'dotted', 'double', 'dot-dash', 'dot-dot-dash', 'groove', 'ridge', 'inset', 'outset'].includes(p)) || 'solid';
  const bs = line === 'double' ? 'double' : line === 'dashed' || line === 'dot-dash' || line === 'dot-dot-dash' ? 'dashed' : line === 'dotted' ? 'dotted'
    : width >= 2.25 ? 'thick' : width >= 1.25 ? 'medium' : 'thin';
  return { bs, bc: parts.map(hex).find(Boolean) || null };
}

/**
 * The app style for a table-cell style's properties, as the reader gathers them: the attributes of its
 * table-cell, paragraph and text properties without their prefixes (font-weight, background-color, ...),
 * its parent styles' under its own. Null when they name nothing this app shows.
 */
export function odsCellStyle(props) {
  if (!props || typeof props !== 'object') return null;
  const s = {};
  const weight = String(props['font-weight'] ?? '').toLowerCase();
  if (weight === 'bold' || Number(weight) >= 600) s.bold = true;
  if (['italic', 'oblique'].includes(String(props['font-style'] ?? '').toLowerCase())) s.italic = true;
  const underline = String(props['text-underline-style'] ?? 'none').toLowerCase();
  if (underline !== 'none' && underline !== '') s.underline = String(props['text-underline-type'] ?? '').toLowerCase() === 'double' ? 'double' : true;
  const through = String(props['text-line-through-style'] ?? 'none').toLowerCase();
  if (through !== 'none' && through !== '') s.strike = true;
  const size = points(props['font-size']);
  if (Number.isFinite(size) && size > 0 && size <= 409) s.size = size * 4 / 3;
  const family = props['font-family'] ?? props['font-name'];
  if (family != null) {
    const key = fontKeyFor(String(family).replace(/^\s*(['"])(.*)\1\s*$/, '$2'), { literal: true });
    if (key) s.font = key;
  }
  const color = hex(props.color);
  if (color) s.color = color;
  const bg = hex(props['background-color']);
  if (bg) s.bg = bg;
  const all = props.border != null ? readBorder(props.border) : null;
  const edges = {};
  for (const [side, name] of SIDES) {
    const edge = props[`border-${name}`] != null ? readBorder(props[`border-${name}`]) : all;
    if (edge) edges[side] = edge;
  }
  const first = Object.values(edges)[0];
  if (first) {
    s.bs = first.bs;
    if (first.bc) s.bc = first.bc;
    for (const [side, edge] of Object.entries(edges)) {
      s[side] = true;
      if (edge.bs !== first.bs || edge.bc !== first.bc) s[`${side}Border`] = edge;
    }
  }
  if (String(props['wrap-option'] ?? '').toLowerCase() === 'wrap') s.wrap = true;
  if (String(props['shrink-to-fit'] ?? '').toLowerCase() === 'true') s.shrink = true;
  const valign = String(props['vertical-align'] ?? '').toLowerCase();
  if (['top', 'middle', 'bottom'].includes(valign)) s.valign = valign;
  const angle = Number(props['rotation-angle']);
  if (Number.isFinite(angle) && angle % 360 !== 0) {
    const turned = ((angle % 360) + 360) % 360;
    const rot = turned <= 90 ? turned : turned >= 270 ? turned - 360 : null;
    if (rot != null) s.rot = Math.round(rot);
  }
  if (String(props['text-align-source'] ?? 'fix').toLowerCase() !== 'value-type') {
    const align = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' }[String(props['text-align'] ?? '').toLowerCase()];
    if (align) s.align = align;
  }
  return Object.keys(s).length ? s : null;
}
