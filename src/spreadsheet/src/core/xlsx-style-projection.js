import { normalizeFontColor, DEFAULT_FONT_COLOR } from './font-color.js';
import { fontName, fontKeyFor, styleToNumFmt, numFmtToStyle, NUMBER_FORMAT_KEYS, XLSX_BORDER_STYLES } from './format.js';
import { BORDER_STYLE_KEYS } from './style-values.js';
import { normalizeFillColor } from './fill-color.js';
import { nativeFillProjection } from './native-fill.js';

// The native writer's font defaults and limits. Reconciliation compares this
// projection, rather than comparing private inheritance patches with full XFs.
export const xlsxFontName = font => fontName(font) || 'Calibri';
export const xlsxFontSize = size => Number.isFinite(size) && size > 0 ? Math.min(409, size * 3 / 4) : 12;
export const FONT_KEYS = ['scheme', 'font', 'size', 'color', 'bold', 'italic', 'underline', 'strike'];
export const RECONCILED_STYLE_KEYS = [...FONT_KEYS, 'bg', 'nativeFill', ...BORDER_STYLE_KEYS, ...NUMBER_FORMAT_KEYS, 'shrink'];
export const xlsxSolidColor = value => /^#[\da-f]{6}$/i.test(value || '') ? value.toLowerCase() : null;
export function xlsxFontProjection(style = {}) {
  return {
    scheme: ['major', 'minor'].includes(style.scheme) ? style.scheme : 'none',
    font: fontKeyFor(xlsxFontName(style.font), { literal: true }),
    size: xlsxFontSize(style.size) * 4 / 3,
    color: style.color === null ? 'windowtext' : normalizeFontColor(style.color) || DEFAULT_FONT_COLOR,
    bold: !!style.bold, italic: !!style.italic, underline: !!style.underline, strike: !!style.strike,
  };
}

/** Shared and per-side descriptors can encode the same native border. Compare
 * visible edges, including absent ones, rather than their private storage form. */
export function xlsxBorderProjection(style = {}) {
  const out = { bs: null, bc: null };
  for (const side of ['bt', 'bb', 'bl', 'br']) {
    out[side] = !!style[side];
    const edge = style[`${side}Border`] || style;
    out[`${side}Border`] = style[side] ? {
      bs: XLSX_BORDER_STYLES.includes(edge.bs) ? edge.bs : 'thin',
      bc: xlsxSolidColor(edge.bc) || '#000000',
    } : null;
  }
  return out;
}

/** Compare the format that the native writer actually emits. Inactive detail
 * fields, default decimal counts and equivalent named/custom codes must not
 * turn an unchanged native XF into an own-cell override. */
export function xlsxNumberFormatProjection(style = {}) {
  const native = numFmtToStyle(styleToNumFmt(style));
  return Object.fromEntries(NUMBER_FORMAT_KEYS.map(k => [k, native?.[k] ?? (k === 'code' ? '' : null)]));
}

export const xlsxStyleProjection = (style = {}) => ({ ...xlsxFontProjection(style), bg: typeof style.bg === 'object' ? normalizeFillColor(style.bg) : xlsxSolidColor(style.bg),
  nativeFill: nativeFillProjection(style.nativeFill),
  ...xlsxBorderProjection(style), ...xlsxNumberFormatProjection(style), shrink: !!style.shrink });
