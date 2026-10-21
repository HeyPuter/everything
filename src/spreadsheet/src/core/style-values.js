import { normalizeFontColor } from './font-color.js';
import { normalizeFillColor } from './fill-color.js';
import { normalizeNativeFill } from './native-fill.js';
import { NUMBER_FORMAT_KEYS } from './format.js';

export const BORDER_STYLE_KEYS = ['bt', 'bb', 'bl', 'br', 'bc', 'bs', 'btBorder', 'bbBorder', 'blBorder', 'brBorder'];

/** Color references are shared as immutable values in cells and rule snapshots. */
export function cloneStyle(style) {
  const out = { ...style };
  if (out.shrink != null && typeof out.shrink !== 'boolean') delete out.shrink;
  if (out.locked !== undefined && out.locked !== false) delete out.locked;
  if (out.formulaHidden !== undefined && out.formulaHidden !== true) delete out.formulaHidden;
  if (out.nativeFill != null) out.nativeFill = normalizeNativeFill(out.nativeFill);
  if (out.scheme != null && !['major', 'minor', 'none'].includes(out.scheme)) delete out.scheme;
  if (out.color && typeof out.color === 'object') {
    const color = normalizeFontColor(out.color);
    if (color) out.color = color; else delete out.color;
  }
  if (out.bg && typeof out.bg === 'object') {
    const color = normalizeFillColor(out.bg);
    if (color) out.bg = color; else delete out.bg;
  }
  for (const key of ['bs', 'bc']) if (out[key] != null && typeof out[key] !== 'string') delete out[key];
  // Side descriptors are nested style values. Copies, line defaults and
  // history snapshots must not share mutable edge objects with their input.
  for (const key of ['btBorder', 'bbBorder', 'blBorder', 'brBorder']) {
    const edge = out[key];
    if (edge == null) continue;
    if (typeof edge !== 'object' || Array.isArray(edge)) { delete out[key]; continue; }
    out[key] = Object.fromEntries(['bs', 'bc'].filter(k => Object.hasOwn(edge, k)
      && (edge[k] == null || typeof edge[k] === 'string')).map(k => [k, edge[k]]));
  }
  return out;
}

/** Convert a complete source format to a patch over destination defaults. */
export function replaceInheritedStyle(style, inherited) {
  const out = { ...style };
  for (const key of Object.keys(inherited || {})) {
    if (!Object.hasOwn(out, key)) out[key] = key === 'code' ? '' : null;
  }
  return out;
}

/** Conditional font properties replace cell font properties, including explicit
 * false flags. Fills, borders and number formats have separate precedence. */
export function conditionalFontStyle(style, conditional) {
  let out = style;
  for (const key of ['bold', 'italic', 'underline', 'strike']) {
    if (conditional?.[key] == null) continue;
    if (out === style) out = { ...style };
    out[key] = conditional[key];
  }
  return out;
}

/** A rule's number format replaces the cell's whole format while the rule matches, as Excel shows it. */
export function conditionalNumberFormat(style, conditional) {
  if (conditional?.fmt == null) return style;
  const out = { ...style };
  for (const key of NUMBER_FORMAT_KEYS) {
    if (conditional[key] !== undefined) out[key] = conditional[key];
    else delete out[key];
  }
  return out;
}

/** An inside border belongs between cells of a style rectangle; an outside
 * border belongs only on its perimeter unless outline=false repeats cell sides.
 * Explicit false edges clear lower layers. */
export function layerDifferentialStyle(out, style, range, r, c, onBorder = null) {
  if (!style) return out;
  if (style.bg !== undefined) delete out.nativeFill;
  for (const key of ['bg', 'color', 'bold', 'italic', 'underline', 'strike', 'font', 'scheme', 'size', 'align', 'valign', 'wrap', 'shrink', 'indent', 'rot', 'fmt', 'code', 'bc', 'bs']) if (style[key] !== undefined) out[key] = style[key];
  const edge = (side, source) => {
    if (style[source] === undefined) return;
    out[side] = style[source];
    out[`${side}Border`] = style[source] ? { ...(style[`${source}Border`] || { bs: style.bs || 'thin', bc: style.bc || null }) } : null;
    onBorder?.(side);
  };
  if (style.borderOutline === false) {
    for (const side of ['bt', 'bb', 'bl', 'br']) edge(side, side);
    return out;
  }
  edge('bt', r === range.r1 ? 'bt' : 'bh');
  edge('bb', r === range.r2 ? 'bb' : 'bh');
  edge('bl', c === range.c1 ? 'bl' : 'bv');
  edge('br', c === range.c2 ? 'br' : 'bv');
  return out;
}
