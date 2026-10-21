import { decodeXlsxString } from './xlsx-string.js';
import { HORIZONTAL_ALIGNS, XLSX_BORDER_STYLES } from './format.js';
import { parseModelXml, modelChildren, standaloneModelXml } from './data-model-metadata.js';
import { readXlsxDifferentialStyle, xlsxColor, xlsxTextRotation } from './xlsx-styles.js';
import { forEachRangeRecordAt } from './range-records.js';
import { layerDifferentialStyle, cloneStyle } from './style-values.js';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const sides = { left: 'bl', right: 'br', top: 'bt', bottom: 'bb', horizontal: 'bh', vertical: 'bv' };
const fail = message => { throw new Error(`Invalid pivot paint: ${message}`); };
const one = (node, name) => { const nodes = modelChildren(node, name, MAIN); if (nodes.length > 1) fail(`duplicate ${name}`); return nodes[0]; };
function allowed(node, names) {
  for (const child of Array.from(node?.childNodes || [])) if (child.nodeType === 1 && (child.namespaceURI !== MAIN || !names.includes(child.localName))) {
    throw new Error(`Pivot differential ${child.localName} paint is not implemented`);
  }
}

/** Decode paint only when all present DXF content can be represented. Raw native
 * DXFs remain authoritative for serialization; unknown effects are never reduced
 * to a superficially similar font, solid fill or thin border. */
export function readNativePivotPaint(xml, themes, { numberFormats = {} } = {}) {
  const root = parseModelXml(xml);
  if (root.localName !== 'dxf' || root.namespaceURI !== MAIN) fail('dxf root');
  allowed(root, ['font', 'fill', 'border', 'numFmt', 'alignment']);
  const font = one(root, 'font');
  allowed(font, ['b', 'i', 'strike', 'u', 'name', 'color', 'sz', 'scheme']);
  for (const name of ['b', 'i', 'strike', 'u', 'name', 'color', 'sz', 'scheme']) allowed(one(font, name), []);
  const scheme = one(font, 'scheme');
  if (scheme && !['major', 'minor', 'none'].includes(scheme.getAttribute('val'))) fail('font scheme');
  const underline = one(font, 'u');
  if (underline && !['single', 'none'].includes(underline.getAttribute('val')?.trim() || 'single')) throw new Error('Pivot extended underline paint is not implemented');
  const fill = one(root, 'fill'); allowed(fill, ['patternFill']);
  const pattern = one(fill, 'patternFill'); allowed(pattern, ['fgColor', 'bgColor']);
  if (pattern && !['', 'none', 'solid'].includes(pattern.getAttribute('patternType') || '')) throw new Error('Pivot pattern-fill paint is not implemented');
  for (const name of ['fgColor', 'bgColor']) allowed(one(pattern, name), []);
  const border = one(root, 'border'); allowed(border, [...Object.keys(sides), 'diagonal']);
  if (border?.hasAttribute('outline')) {
    const value = border.getAttribute('outline').trim();
    if (!['0', '1', 'false', 'true'].includes(value)) fail('border outline');
    if (['0', 'false'].includes(value) && (one(border, 'horizontal') || one(border, 'vertical'))) {
      throw new Error('Pivot repeated borders combined with inner borders are not implemented');
    }
  }
  for (const direction of ['diagonalUp', 'diagonalDown']) if (border?.hasAttribute(direction)) {
    const value = border.getAttribute(direction).trim();
    if (!['0', '1', 'false', 'true'].includes(value)) fail(direction);
    if (['1', 'true'].includes(value)) throw new Error('Pivot diagonal border paint is not implemented');
  }
  const diagonal = one(border, 'diagonal');
  if (diagonal?.getAttribute('style') && diagonal.getAttribute('style') !== 'none') throw new Error('Pivot diagonal border paint is not implemented');
  const clean = root.cloneNode(true);
  const pruneComments = node => { for (const child of Array.from(node.childNodes || [])) { if (child.nodeType === 8) node.removeChild(child); else pruneComments(child); } };
  pruneComments(clean);
  const name = one(one(clean, 'font'), 'name');
  if (name) name.setAttribute('val', decodeXlsxString(name.getAttribute('val') || ''));
  const out = readXlsxDifferentialStyle(standaloneModelXml(clean), themes);
  if (border?.hasAttribute('outline')) out.borderOutline = ['1', 'true'].includes(border.getAttribute('outline').trim());
  const size = one(font, 'sz');
  if (size) {
    const raw = size.getAttribute('val')?.trim() || '', points = Number(raw);
    // SpreadsheetML stores points; cells use CSS pixels. Reject sizes the XLSX
    // writer would clamp rather than claiming a faithful refresh/export.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
      || !Number.isFinite(points) || points <= 0 || points > 409) fail('font size');
    out.size = points * 4 / 3;
  }
  const alignment = one(root, 'alignment'); allowed(alignment, []);
  for (const attribute of Array.from(alignment?.attributes || [])) {
    if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
    if (attribute.namespaceURI || !['horizontal', 'vertical', 'wrapText', 'shrinkToFit', 'indent', 'textRotation'].includes(attribute.name)) {
      throw new Error(`Pivot alignment ${attribute.name} paint is not implemented`);
    }
  }
  // A DXF is incremental. Omitted properties inherit; explicit General, false
  // wrapping and zero indentation must reset an earlier layer's value.
  if (alignment?.hasAttribute('horizontal')) {
    const value = alignment.getAttribute('horizontal').trim();
    if (value !== 'general' && !HORIZONTAL_ALIGNS.includes(value)) throw new Error('Pivot extended horizontal alignment paint is not implemented');
    out.align = value === 'general' ? null : value;
  }
  if (alignment?.hasAttribute('vertical')) {
    const value = alignment.getAttribute('vertical').trim();
    if (!['top', 'center', 'bottom'].includes(value)) throw new Error('Pivot extended vertical alignment paint is not implemented');
    out.valign = value === 'center' ? 'middle' : value;
  }
  if (alignment?.hasAttribute('wrapText')) {
    const value = alignment.getAttribute('wrapText').trim();
    if (!['0', '1', 'false', 'true'].includes(value)) fail('alignment wrapping');
    out.wrap = value === '1' || value === 'true';
  }
  if (alignment?.hasAttribute('shrinkToFit')) {
    const value = alignment.getAttribute('shrinkToFit').trim();
    if (!['0', '1', 'false', 'true'].includes(value)) fail('alignment shrink to fit');
    out.shrink = value === '1' || value === 'true';
  }
  if (alignment?.hasAttribute('textRotation')) {
    const value = alignment.getAttribute('textRotation').trim();
    if (/^\+?0*255$/.test(value)) throw new Error('Pivot stacked-text paint is not implemented');
    const rotation = xlsxTextRotation(value);
    if (rotation == null) fail('alignment rotation');
    out.rot = rotation;
  }
  if (alignment?.hasAttribute('indent')) {
    const value = alignment.getAttribute('indent').trim();
    if (!/^\+?\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 250) fail('alignment indentation');
    out.indent = Number(value);
  }

  if (one(pattern, 'bgColor') && pattern.getAttribute('patternType') !== 'none' && !out.bg) fail('unresolved fill color');
  if (one(font, 'name') && !out.font) fail('font name');
  if (one(font, 'color') && !out.color) fail('unresolved font color');
  for (const [side, key] of Object.entries(sides)) {
    const edge = one(border, side); if (!edge) continue;
    allowed(edge, ['color']);
    const style = edge.getAttribute('style') || 'none';
    if (style !== 'none' && !XLSX_BORDER_STYLES.includes(style)) throw new Error(`Pivot border ${style} paint is not implemented`);
    const color = one(edge, 'color'); allowed(color, []);
    const bc = color ? xlsxColor(standaloneModelXml(color), themes) : null;
    if (style !== 'none' && color && !bc && !['1', 'true'].includes(color.getAttribute('auto'))) fail('unresolved border color');
    out[key] = style !== 'none'; out[`${key}Border`] = out[key] ? { bs: style, bc } : null;
  }
  const format = one(root, 'numFmt');
  if (format) {
    const rawId = format.getAttribute('numFmtId')?.trim() || '';
    if (!/^\+?\d+$/.test(rawId) || Number(rawId) > 4294967295) fail('number format id');
    const code = format.hasAttribute('formatCode') ? decodeXlsxString(format.getAttribute('formatCode')) : numberFormats[Number(rawId)];
    if (typeof code !== 'string') fail('unresolved number format');
    out.fmt = 'custom'; out.code = code;
  }
  return out;
}

/** Compile each distinct DXF once and index only rectangles, never value cells.
 * Input order is the pivot-specific style precedence already resolved upstream. */
export function nativePivotPaintLayers(layers, themes, options = {}) {
  const paints = new Map();
  return Object.freeze(layers.map(layer => {
    const g = layer.range;
    if (!g || !['r1', 'c1', 'r2', 'c2'].every(key => Number.isSafeInteger(g[key])) || g.r1 < 0 || g.c1 < 0 || g.r2 < g.r1 || g.c2 < g.c1 || g.r2 >= 1048576 || g.c2 >= 16384) fail('layer bounds');
    if (!paints.has(layer.dxf)) {
      const paint = readNativePivotPaint(layer.dxf, themes, options);
      for (const value of Object.values(paint)) if (value && typeof value === 'object') Object.freeze(value);
      paints.set(layer.dxf, Object.freeze(paint));
    }
    return Object.freeze({ range: Object.freeze({ ...g }), style: paints.get(layer.dxf), type: layer.type });
  }));
}

/** Resolve report formats by semantic identity, never the previous coordinate.
 * The lookup belongs to this workbook and contains decoded built-in/custom codes.
 * An absent format inherits; explicit General must reset an existing format.
 */
export function nativePivotCellNumberFormat(layout, cell, numberFormats = {}) {
  const owner = cell.role === 'value' ? layout.measures[cell.measure]
    : cell.role === 'member' ? layout.fields[cell.field] : null;
  if (['value', 'member'].includes(cell.role) && !owner) fail('missing format owner');
  const id = owner?.numFmtId;
  if (id == null) return null;
  if (!Number.isSafeInteger(id) || id < 0 || id > 4294967295) fail('number format id');
  const code = Object.hasOwn(numberFormats, id) ? numberFormats[id] : id === 0 ? 'General' : null;
  if (typeof code !== 'string') fail('unresolved number format');
  return { fmt: 'custom', code };
}

/** Base formatting and direct overrides are separate: a Normal-font default is
 * not an explicit cell override. Callers must supply that provenance rather than
 * treating every property of a flattened cell XF as direct formatting. */
export function nativePivotPaintAt(layers, r, c, { base = null, direct = null, numberFormat = null, borderPriorities = null } = {}) {
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= 1048576 || c >= 16384) fail('cell coordinates');
  const matches = [];
  forEachRangeRecordAt(layers, r, c, (layer, index) => matches.push({ layer, index }));
  matches.sort((a, b) => a.index - b.index);
  const out = cloneStyle(base);
  for (const side of ['bt', 'bb', 'bl', 'br']) if (out[side] && !out[`${side}Border`]) out[`${side}Border`] = { bs: base.bs || 'thin', bc: base.bc || null };
  for (const { layer } of matches) layerDifferentialStyle(out, layer.style, layer.range, r, c,
    borderPriorities ? side => { borderPriorities[side] = layer.type === 'format' ? 1 : 0; } : null);
  Object.assign(out, direct);
  for (const side of ['bt', 'bb', 'bl', 'br']) if (direct && Object.hasOwn(direct, side)) {
    out[`${side}Border`] = direct[side] ? direct[`${side}Border`] || { bs: direct.bs || 'thin', bc: direct.bc || null } : null;
    if (borderPriorities) borderPriorities[side] = 1;
  }
  // ISO 29500 pivotField numFmtId: existing cell formatting wins for the saved
  // report, but pivot formatting wins when its layout changes. This option is
  // the refresh format, not a replacement for ordinary direct-format editing.
  if (numberFormat != null) { out.fmt = numberFormat.fmt; out.code = numberFormat.code; }
  return cloneStyle(out);
}
