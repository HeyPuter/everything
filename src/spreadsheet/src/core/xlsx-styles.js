import { TABLE_STYLE_REGIONS } from './tables.js';
import { readNativeNormalStyle } from './native-normal-style.js';
import { readNativeDefaultCellFormat } from './native-default-cell-format.js';
import { decodeXlsxString } from './xlsx-string.js';
import { normalizeFontColor, tintRgb, INDEXED_COLORS } from './font-color.js';
import { normalizeFillColor } from './fill-color.js';
import { readNativeFillResources } from './native-fill.js';
/** Formatting the XLSX reader leaves in styles.xml: fills, borders and differential styles. */
import { fontKeyFor, numFmtToStyle } from './format.js';
import { normalizeCellStyles, edgesOfStyle, presetByLabel } from './custom-cell-styles.js';
import { readFontTheme, resolveThemeFont } from './font-theme.js';
import { normalizeNormalFont } from './normal-font.js';
import { readThemeInfo } from './workbook-theme.js';

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const xlsxText = xml => xml?.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
  if (entity[0] !== '#') return entities[entity.toLowerCase()];
  const hex = /^#x/i.test(entity), code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
});
const attr = (xml, name) => xlsxText(xml?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]);
const elements = (xml, tag) => [...(xml || '').matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>)`, 'g'))].map(m => m[0]);
const element = (xml, tag) => elements(xml, tag)[0];
export { attr as xlsxAttr, elements as xlsxElements };

export function xlsxColor(tag, themes) {
  if (!tag || ['1', 'true'].includes(attr(tag, 'auto'))) return null;
  let rgb = attr(tag, 'rgb');
  const theme = attr(tag, 'theme');
  if (theme != null && /^\d+$/.test(theme)) rgb = themes?.themeElements?.clrScheme?.[Number(theme)]?.rgb;
  const indexed = attr(tag, 'indexed');
  if (!rgb && indexed != null && /^\d+$/.test(indexed)) rgb = (themes?.indexedColors || INDEXED_COLORS)[Number(indexed)];
  if (!/^(?:[0-9a-f]{2})?[0-9a-f]{6}$/i.test(rgb || '')) return null;
  rgb = rgb.slice(-6).toLowerCase();
  const tint = Number(attr(tag, 'tint') || 0);
  return `#${Number.isFinite(tint) && tint >= -1 && tint <= 1 && tint !== 0 ? tintRgb(rgb, tint) : rgb}`;
}

/** Retain native references and their resolved paint together. Color identity
 * also controls cell overrides of table/PivotTable styling. */
export function fontColor(tag, themes, complete = false) {
  if (!tag) return complete ? 'windowtext' : null;
  if (['1', 'true'].includes(attr(tag, 'auto'))) return 'windowtext';
  const rgb = xlsxColor(tag, themes);
  if (!rgb) return null;
  for (const key of ['theme', 'indexed']) {
    const raw = attr(tag, key), index = Number(raw);
    if (raw == null || !/^\d+$/.test(raw)) continue;
    const base = xlsxColor(`<color ${key}="${index}"/>`, themes);
    const ref = normalizeFontColor({ [key]: index, base, rgb, tint: Number(attr(tag, 'tint') || 0) });
    if (ref) return ref;
  }
  return rgb;
}

function borders(xml, themes) {
  const out = {}, edges = {};
  for (const [side, key] of [['left', 'bl'], ['right', 'br'], ['top', 'bt'], ['bottom', 'bb'], ['horizontal', 'bh'], ['vertical', 'bv']]) {
    const tag = element(xml, side), style = attr(tag, 'style');
    if (!style || style === 'none') continue;
    out[key] = true;
    out.bs = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'].includes(style) ? style : 'thin';
    const color = xlsxColor(element(tag, 'color'), themes);
    if (color) out.bc = color;
    edges[key] = { bs: out.bs, bc: color };
  }
  // Keep uniform borders compact, but don't turn every edge medium just
  // because the header's bottom edge is medium (or recolor unlike edges).
  for (const [key, edge] of Object.entries(edges)) if (edge.bs !== out.bs || edge.bc !== (out.bc || null)) out[`${key}Border`] = edge;
  return out;
}

/** SpreadsheetML angles 91..180 represent -1..-90 degrees. Stacked text
 * (255) is a distinct layout mode and must not be converted to an angle. */
export function xlsxTextRotation(value) {
  if (value == null || !['string', 'number'].includes(typeof value)) return null;
  const raw = String(value).trim(), angle = Number(raw);
  if (!/^\+?\d+$/.test(raw) || !Number.isInteger(angle) || angle > 180) return null;
  return angle <= 90 ? angle : 90 - angle;
}

export function xlsxAlignment(alignment) {
  if (!alignment) return null;
  const out = {};
  if (['left', 'center', 'right'].includes(alignment.horizontal)) out.align = alignment.horizontal;
  if (['top', 'center', 'bottom'].includes(alignment.vertical)) out.valign = alignment.vertical === 'center' ? 'middle' : alignment.vertical;
  else out.valign = 'bottom';
  if (alignment.wrapText) out.wrap = true;
  if ([true, 1, '1', 'true'].includes(alignment.shrinkToFit)) out.shrink = true;
  const rotation = xlsxTextRotation(alignment.textRotation);
  if (rotation != null) out.rot = rotation;
  const indent = Number(alignment.indent);
  if (Number.isInteger(indent) && indent > 0 && indent <= 250) out.indent = indent;
  return out;
}

/** Shared differential paint for styles.xml records and inline x14 rules. */
export function readXlsxDifferentialStyle(dxf, themes) {
  const out = borders(element(dxf, 'border'), themes);
  const pattern = element(dxf, 'patternFill');
  if (pattern && [undefined, 'solid'].includes(attr(pattern, 'patternType'))) {
    // Excel's differential shading uses bgColor even for a solid pattern;
    // fgColor alone leaves the underlying fill intact. Ordinary XF fills
    // use fgColor. Reserved indexed colors are system ink/paper,
    // whereas the differential background's automatic color is paper.
    const color = element(pattern, 'bgColor'), indexed = attr(color, 'indexed');
    const index = /^\d+$/.test(indexed || '') ? Number(indexed) : null;
    const bg = ['1', 'true'].includes(attr(color, 'auto')) || index === 65 ? '#ffffff'
      : index === 64 ? '#000000' : normalizeFillColor(fontColor(color, themes));
    if (bg) out.bg = bg;
  }
  if (attr(pattern, 'patternType') === 'none') out.bg = 'transparent';
  const font = element(dxf, 'font'), color = fontColor(element(font, 'color'), themes);
  if (color) out.color = color;
  for (const [tag, key] of [['b', 'bold'], ['i', 'italic'], ['strike', 'strike']]) {
    const item = element(font, tag);
    if (!item) continue;
    const value = (attr(item, 'val') ?? '1').trim();
    if (!['0', '1', 'false', 'true'].includes(value)) throw new Error('Invalid differential font flag');
    out[key] = value === '1' || value === 'true';
  }
  const underline = element(font, 'u'), underlineType = attr(underline, 'val')?.trim() || 'single';
  if (underline && ['single', 'none'].includes(underlineType)) out.underline = underlineType !== 'none';
  const scheme = attr(element(font, 'scheme'), 'val');
  const family = fontKeyFor(resolveThemeFont(attr(element(font, 'name'), 'val'), scheme, themes?.fontTheme), { literal: true });
  if (family) out.font = family;
  if (['major', 'minor', 'none'].includes(scheme)) out.scheme = scheme;
  // An explicitly empty side clears it; an omitted side keeps its prior paint.
  for (const [side, key] of [['left', 'bl'], ['right', 'br'], ['top', 'bt'], ['bottom', 'bb']]) {
    const tag = element(element(dxf, 'border'), side);
    if (!tag) continue;
    const st = borders(tag, themes);
    out[key] = !!st[key];
    out[`${key}Border`] = st[key] ? { bs: st.bs, bc: st.bc } : null;
  }
  return out;
}

export function readXlsxStyles(book, fillBaseline = null, fillDefinitions = null) {
  const path = book.Directory?.style?.replace(/^\//, '') || 'xl/styles.xml';
  const content = book.files?.[path]?.content;
  if (!content) return { borders: [], fills: [], dxfs: [], tables: new Map() };
  // Comments must not become phantom style records.
  const xml = new TextDecoder().decode(content).replace(/<!--[\s\S]*?-->/g, '');
  const palette = elements(element(xml, 'indexedColors'), 'rgbColor').map(tag => attr(tag, 'rgb'));
  const themePart = book.files?.[(book.Directory?.themes?.[0] || 'xl/theme/theme1.xml').replace(/^\//, '')]?.content;
  const fontTheme = themePart ? readFontTheme(new TextDecoder().decode(themePart)) : null;
  const themeInfo = themePart ? readThemeInfo(new TextDecoder().decode(themePart)) : null;
  const themes = { ...book.Themes, fontTheme, ...(palette.length ? { indexedColors: palette } : {}) };
  // The reader resolves font indexes against the default palette, losing custom
  // entries and leading zeroes. Resolve the original font colors alongside fills.
  const fontRecords = elements(element(xml, 'fonts'), 'font');
  // An absent/automatic font color is system text, not an RGB black override.
  // Excel distinguishes them when applying table-style differential formats.
  // WindowText is also its HTML clipboard representation and a CSS system color.
  const fontColors = fontRecords.map(font => fontColor(element(font, 'color'), themes, true));
  // The vendor leaves XML entities in family names. Read their decoded value
  // once alongside colors, so exporting an apostrophe does not double-escape it.
  const fontSchemes = fontRecords.map(font => {
    const scheme = attr(element(font, 'scheme'), 'val');
    return ['major', 'minor'].includes(scheme) ? scheme : 'none';
  });
  const fontNames = fontRecords.map((font, i) => resolveThemeFont(attr(element(font, 'name'), 'val'), fontSchemes[i], fontTheme));
  // Normal is identified by its built-in ID, including localized names. Its
  // style XF and font need not occupy index zero.
  // Follow cellStyle -> cellStyleXfs -> fonts (ISO 29500-1 §18.8.7), even
  // though desktop Excel can size columns from font zero in noncanonical
  // files. Export puts the resolved Normal font first for interoperability.
  const normalStyle = elements(element(xml, 'cellStyles'), 'cellStyle').find(s => attr(s, 'builtinId') === '0');
  const normalXf = elements(element(xml, 'cellStyleXfs'), 'xf')[Number(attr(normalStyle, 'xfId') || 0)];
  const requestedFontId = Number(attr(normalXf, 'fontId') || 0);
  const normalFontId = Number.isInteger(requestedFontId) && fontRecords[requestedFontId] ? requestedFontId : 0;
  const normalRecord = fontRecords[normalFontId];
  const normal = { name: fontNames[normalFontId], scheme: fontSchemes[normalFontId], sz: Number(attr(element(normalRecord, 'sz'), 'val')) };
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike'], ['outline', 'outline'], ['shadow', 'shadow'], ['condense', 'condense'], ['extend', 'extend']]) {
    const item = element(normalRecord, tag);
    if (item && !['0', 'false'].includes(attr(item, 'val'))) normal[key] = true;
  }
  if (element(normalRecord, 'u')) normal.underline = attr(element(normalRecord, 'u'), 'val') || 'single';
  normal.vertAlign = attr(element(normalRecord, 'vertAlign'), 'val');
  for (const key of ['family', 'charset']) {
    const val = attr(element(normalRecord, key), 'val');
    if (val != null) normal[key] = Number(val);
  }
  normal.color = fontColors[normalFontId];
  const normalFont = normalizeNormalFont(normal);
  const fillRecords = elements(element(xml, 'fills'), 'fill');
  const borderRecords = elements(element(xml, 'borders'), 'border');
  const normalFormatId = Number(attr(normalXf, 'numFmtId') || 0);
  const normalFormat = elements(element(xml, 'numFmts'), 'numFmt').find(format => Number(attr(format, 'numFmtId')) === normalFormatId);
  const namespaces = (xml.match(/<(?:\w+:)?styleSheet\b[^>]*>/)?.[0].match(/xmlns(?::[\w.-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/g) || []).join(' ');
  const nativeNormalStyle = normalStyle ? readNativeNormalStyle({ xf: normalXf,
    fill: fillRecords[Number(attr(normalXf, 'fillId') || 0)], border: borderRecords[Number(attr(normalXf, 'borderId') || 0)],
    numberFormat: normalFormat ? decodeXlsxString(attr(normalFormat, 'formatCode')) : normalFormatId < 164 ? normalFormatId : book.SSF?.[normalFormatId],
  }, namespaces) : null;
  const defaultXf = elements(element(xml, 'cellXfs'), 'xf')[0];
  const defaultFormatId = Number(attr(defaultXf, 'numFmtId') || 0);
  const defaultFormat = elements(element(xml, 'numFmts'), 'numFmt').find(format => Number(attr(format, 'numFmtId')) === defaultFormatId);
  const nativeDefaultCellFormat = readNativeDefaultCellFormat({ xf: defaultXf,
    font: fontRecords[Number(attr(defaultXf, 'fontId') || 0)], fill: fillRecords[Number(attr(defaultXf, 'fillId') || 0)],
    border: borderRecords[Number(attr(defaultXf, 'borderId') || 0)],
    numberFormat: defaultFormat ? decodeXlsxString(attr(defaultFormat, 'formatCode')) : defaultFormatId < 164 ? defaultFormatId : book.SSF?.[defaultFormatId],
  }, namespaces, normalRecord, Number(attr(normalXf, 'fillId') || 0));
  const fills = fillRecords.map(fill => {
    const pattern = element(fill, 'patternFill');
    const bg = attr(pattern, 'patternType') === 'solid' ? normalizeFillColor(fontColor(element(pattern, 'fgColor'), themes)) : null;
    return bg ? { bg } : null;
  });
  const colorPalette = { theme: (themes.themeElements?.clrScheme || []).map(c => c?.rgb ? `#${c.rgb.slice(-6)}` : null),
    indexed: (themes.indexedColors || INDEXED_COLORS).map(c => typeof c === 'string' ? `#${c.slice(-6)}` : null) };
  const fillResources = readNativeFillResources(fillRecords, namespaces, colorPalette, fills.map(fill => fill?.bg),
    Number(attr(normalXf, 'fillId') || 0), fillBaseline, fillDefinitions);
  fillResources.fills.forEach((nativeFill, index) => { if (nativeFill) fills[index] = {
    ...fills[index], ...(nativeFill.paint ? { bg: nativeFill.paint } : {}), nativeFill,
  }; });
  const borderStyles = borderRecords.map(b => borders(b, themes));
  const differential = elements(element(xml, 'dxfs'), 'dxf');
  const dxfs = differential.map(dxf => readXlsxDifferentialStyle(dxf, themes));
  const tables = new Map();
  for (const table of elements(element(xml, 'tableStyles'), 'tableStyle')) {
    const name = attr(table, 'name');
    if (!name) continue;
    const parts = {};
    for (const part of elements(table, 'tableStyleElement')) {
      const type = attr(part, 'type'), index = Number(attr(part, 'dxfId')), dxf = dxfs[index];
      if (!dxf || !TABLE_STYLE_REGIONS.includes(type)) continue;
      const size = Number(attr(part, 'size') || 1);
      parts[type] = { ...dxf, stripeSize: Number.isInteger(size) && size > 0 && size <= 1000 ? size : 1 };
      // Internal edges belong to the table rectangle, rather than a single
      // conditionally formatted cell. Keep their explicit clears here too.
      for (const [side, key] of [['horizontal', 'bh'], ['vertical', 'bv']]) {
        const tag = element(element(differential[index], 'border'), side);
        if (!tag) continue;
        const st = borders(tag, themes);
        parts[type][key] = !!st[key];
        parts[type][`${key}Border`] = st[key] ? { bs: st.bs, bc: st.bc } : null;
      }
    }
    tables.set(name, parts);
  }
  const shrink = elements(element(xml, 'cellXfs'), 'xf').map(xf => ['1', 'true'].includes(attr(element(xf, 'alignment'), 'shrinkToFit')));
  // Cell protection: cells are locked unless their format says locked="0"; hidden="1" hides the formula on a protected sheet.
  const protection = elements(element(xml, 'cellXfs'), 'xf').map(xf => {
    const tag = element(xf, 'protection');
    return { unlocked: ['0', 'false'].includes(attr(tag, 'locked')), hidden: ['1', 'true'].includes(attr(tag, 'hidden')) };
  });
  const { namedStyles, cellXfStyleNames } = readNamedStyles({ xml, fontRecords, fontNames, fontSchemes, fontColors, fills, borderStyles, formatCodes: book.SSF });
  return { borders: borderStyles, fills, dxfs, tables, shrink, protection, fontColors, fontNames, fontSchemes, fontTheme, normalFont, normalFontId, namedStyles, cellXfStyleNames,
    nativeNormalStyle, nativeNormalFill: fillResources.normal, nativeDefaultCellFormat, formatCodes: book.SSF, colorPalette, themeInfo, colors: themes };
}

/**
 * The named cell styles a file defines beyond Normal (cellStyles → cellStyleXfs), as the workbook's definitions
 * (see custom-cell-styles.js), and for each cell format the name of the style it is linked to (null for Normal or
 * a built-in style this app has no definition of). A style XF's apply flags say which parts the style holds; one
 * left unsaid is held.
 */
function readNamedStyles({ xml, fontRecords, fontNames, fontSchemes, fontColors, fills, borderStyles, formatCodes }) {
  const styleXfs = elements(element(xml, 'cellStyleXfs'), 'xf');
  const numFmts = new Map(elements(element(xml, 'numFmts'), 'numFmt').map((n) => [Number(attr(n, 'numFmtId')), decodeXlsxString(attr(n, 'formatCode'))]));
  const held = (xf, name) => !['0', 'false'].includes(attr(xf, name));
  const byXf = new Map();
  const defs = [];
  for (const entry of elements(element(xml, 'cellStyles'), 'cellStyle')) {
    const name = attr(entry, 'name')?.trim();
    const xfId = Number(attr(entry, 'xfId'));
    // Normal and the other built-in styles are the app's own; a file's custom styles carry no built-in id.
    if (!name || attr(entry, 'builtinId') != null || !Number.isInteger(xfId) || !styleXfs[xfId]) continue;
    const xf = styleXfs[xfId];
    const style = {};
    const fontId = Number(attr(xf, 'fontId') || 0), font = fontRecords[fontId];
    if (font) {
      const family = fontKeyFor(fontNames[fontId], { literal: true });
      if (family) style.font = family;
      if (fontSchemes[fontId] && fontSchemes[fontId] !== 'none') style.scheme = fontSchemes[fontId];
      const size = Number(attr(element(font, 'sz'), 'val'));
      if (Number.isFinite(size) && size > 0) style.size = size * 4 / 3;
      for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike']]) {
        const item = element(font, tag);
        if (item && !['0', 'false'].includes(attr(item, 'val'))) style[key] = true;
      }
      const u = element(font, 'u');
      if (u && attr(u, 'val') !== 'none') style.underline = true;
      const color = fontColors[fontId];
      if (color && color !== 'windowtext') style.color = color;
    }
    Object.assign(style, fills[Number(attr(xf, 'fillId') || 0)] || {});
    const border = borderStyles[Number(attr(xf, 'borderId') || 0)] || {};
    const alignTag = element(xf, 'alignment');
    if (alignTag) {
      const read = Object.fromEntries(['horizontal', 'vertical', 'wrapText', 'shrinkToFit', 'textRotation', 'indent'].map((k) => [k, attr(alignTag, k)]).filter(([, v]) => v != null));
      if (read.wrapText) read.wrapText = ['1', 'true'].includes(read.wrapText);
      Object.assign(style, xlsxAlignment(read));
      if (!attr(alignTag, 'vertical')) delete style.valign;
    }
    const protect = element(xf, 'protection');
    if (['0', 'false'].includes(attr(protect, 'locked'))) style.locked = false;
    if (['1', 'true'].includes(attr(protect, 'hidden'))) style.formulaHidden = true;
    const numFmtId = Number(attr(xf, 'numFmtId') || 0);
    const code = numFmts.get(numFmtId) ?? formatCodes?.[numFmtId];
    if (numFmtId && code) Object.assign(style, numFmtToStyle(code) || {});
    for (const key of Object.keys(style)) if (style[key] == null) delete style[key];
    const parts = { number: held(xf, 'applyNumberFormat'), alignment: held(xf, 'applyAlignment'), font: held(xf, 'applyFont'),
      border: held(xf, 'applyBorder'), fill: held(xf, 'applyFill'), protection: held(xf, 'applyProtection') };
    // A style named as one of the app's presets is that preset, modified for the workbook it was saved from.
    const builtin = presetByLabel(name)?.key;
    defs.push({ name, parts, style, borders: edgesOfStyle(border), ...(builtin ? { builtin } : {}) });
    byXf.set(xfId, name);
  }
  const namedStyles = normalizeCellStyles(defs);
  const cellXfStyleNames = elements(element(xml, 'cellXfs'), 'xf').map((xf) => byXf.get(Number(attr(xf, 'xfId') || 0)) ?? null);
  return { namedStyles, cellXfStyleNames };
}


/** Character widths use the workbook's Normal font, not the reader's guessed six-pixel digit. */
export function xlsxMaximumDigitWidth(font) {
  const name = font?.name?.toLowerCase();
  // Open Sans 1.10 hmtx advances in 2048 units/em. Italic and bold have
  // distinct digit metrics, including when used as the workbook Normal font.
  if (name === 'open sans' || name === 'open sans regular') {
    if (!Number.isFinite(font.sz) || font.sz <= 0) return null;
    const advance = font.italic ? 1128 : font.bold ? 1169 : 1171;
    return Math.max(1, Math.round(font.sz * 4 / 3 * advance / 2048));
  }
  // Constantia's widest default digit is 0.546em in Microsoft's ClearType
  // specimen (nowreadthis.pdf), giving an 8px digit at 11pt/96dpi.
  // Calibri Light retains Calibri's 0.507em tabular digit advance. Its
  // lighter strokes do not change the character units used by column widths.
  // Aptos metrics are the maximum digit advances in the fonts’ hmtx tables,
  // expressed in their 2048 units/em. Aptos Narrow has distinct metrics.
  // Geneva's tabular digits advance 1365/2048 em (its hmtx table). This
  // Normal font is wider than Calibri even when the cells use Calibri.
  const em = { aptos: 1094 / 2048, 'aptos narrow': 1038 / 2048, arial: 0.556, helvetica: 0.556, calibri: 0.507, 'calibri light': 0.507, 'century gothic': 0.554, constantia: 0.546, tahoma: 0.546, 'trebuchet ms': 0.524, 'source sans pro': 0.497, 'source sans 3': 0.497, garamond: 0.5, geneva: 1365 / 2048, georgia: 1257 / 2048, 'times new roman': 0.5, 'courier new': 0.6 }[name];
  // Known 96dpi digit widths for these common Normal styles. Do not infer an
  // unknown font/size from the first column's fractional character width:
  // the same Lucida Sans font otherwise becomes 6px in one file and 11px in another.
  const measured = font?.sz === 11 ? { 'lucida sans': 9, corbel: 8 }[name] : null;
  if ((!em && !measured) || !Number.isFinite(font.sz) || font.sz <= 0) return null;
  return measured || Math.max(1, Math.round(font.sz * 4 / 3 * em));
}

export function xlsxColumnPixels(col, font) {
  const mdw = xlsxMaximumDigitWidth(font);
  if (!mdw || !Number.isFinite(col.width)) return null;
  return Math.floor((col.width + Math.floor(128 / mdw) / 256) * mdw);
}

/** A stable Arial measurement when the native font's metrics are unavailable.
 * This is a layout fallback, never a replacement of its stored family or of
 * unchanged native width units. Rendering may select another installed face.
 */
export function xlsxLayoutDigitWidth(font) {
  return xlsxMaximumDigitWidth(font) ?? xlsxMaximumDigitWidth({ name: 'Arial', sz: font?.sz || 12 });
}

export function xlsxWidthFromPixels(pixels, font) {
  const mdw = xlsxLayoutDigitWidth(font);
  return Math.floor(Math.round(pixels) * 256 / mdw) / 256;
}
