import { xmlTag, fontColorXml, fillColorXml } from './xlsx-export-styles.js';
import { fontName, HORIZONTAL_ALIGNS, XLSX_BORDER_STYLES } from './format.js';
import { normalizeFontColor } from './font-color.js';
import { encodeXlsxAttribute } from './xlsx-string.js';
import { MAX_FORMAT_CODE_LENGTH } from './numfmt.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const edges = [['bl', 'left'], ['br', 'right'], ['bt', 'top'], ['bb', 'bottom'], ['bv', 'vertical'], ['bh', 'horizontal']];
const keys = new Set(['bold', 'italic', 'strike', 'underline', 'font', 'scheme', 'size', 'color', 'bg', 'fmt', 'code',
  'align', 'valign', 'wrap', 'shrink', 'indent', 'rot', 'borderOutline', 'bs', 'bc', ...edges.flatMap(([key]) => [key, `${key}Border`])]);
const fail = reason => { throw new Error(`Cannot write native pivot paint: ${reason}`); };
const rgb = value => {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) fail('RGB color');
  return `FF${value.slice(1).toUpperCase()}`;
};

/** Encode an explicit formatting delta, not a flattened source XF. Callers must
 * resolve UI inheritance operations before passing paint (e.g. false emphasis,
 * transparent fill, General number format). Omitted properties stay omitted.
 * Workbook-local number-format allocation and atomic rule/cell edits belong to
 * the caller. The source palette keeps copied color references faithful.
 */
export function writeNativePivotPaint(style, { numberFormatId = null, palette = null } = {}) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) fail('style');
  for (const key of Object.keys(style)) if (!keys.has(key)) fail(`unsupported ${key}`); else if (style[key] === undefined) fail(`undefined ${key}`);
  const has = key => Object.hasOwn(style, key);
  let font = '', number = '', fill = '', border = '';
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike'], ['underline', 'u']]) if (has(key)) {
    if (typeof style[key] !== 'boolean') fail(key);
    font += style[key] ? xmlTag(tag) : xmlTag(tag, { val: tag === 'u' ? 'none' : 0 });
  }
  if (has('size')) {
    if (!Number.isFinite(style.size) || style.size <= 0 || style.size > 409 * 4 / 3) fail('font size');
    font += xmlTag('sz', { val: style.size * 3 / 4 });
  }
  if (has('color')) {
    if (style.color != null && !normalizeFontColor(style.color)) fail('font color');
    font += style.color === null ? xmlTag('color', { auto: 1 }) : fontColorXml(style.color, palette);
  }
  if (has('font')) {
    const name = typeof style.font === 'string' && fontName(style.font);
    if (!name) fail('font name');
    font += xmlTag('name', { val: encodeXlsxAttribute(name) });
  }
  if (has('scheme')) {
    if (!['major', 'minor', 'none'].includes(style.scheme)) fail('font scheme');
    font += xmlTag('scheme', { val: style.scheme });
  }
  if (has('fmt') || has('code')) {
    if (style.fmt !== 'custom' || typeof style.code !== 'string' || style.code.length > MAX_FORMAT_CODE_LENGTH) fail('resolved number format');
    if (!Number.isSafeInteger(numberFormatId) || numberFormatId < 0 || numberFormatId > 4294967295) fail('number format id');
    number = xmlTag('numFmt', { numFmtId: numberFormatId, formatCode: encodeXlsxAttribute(style.code) });
  }
  if (has('bg')) {
    const paint = fillColorXml(style.bg, palette, 'bgColor');
    if (style.bg !== 'transparent' && !paint) fail('RGB color');
    fill = xmlTag('fill', {}, style.bg === 'transparent'
      ? xmlTag('patternFill', { patternType: 'none' })
      : xmlTag('patternFill', { patternType: 'solid' }, paint));
  }
  const alignment = {};
  if (has('align')) {
    if (style.align !== null && !HORIZONTAL_ALIGNS.includes(style.align)) fail('horizontal alignment');
    alignment.horizontal = style.align === null ? 'general' : style.align;
  }
  if (has('valign')) {
    if (!['top', 'middle', 'bottom'].includes(style.valign)) fail('vertical alignment');
    alignment.vertical = style.valign === 'middle' ? 'center' : style.valign;
  }
  if (has('wrap')) { if (typeof style.wrap !== 'boolean') fail('wrapping'); alignment.wrapText = style.wrap ? 1 : 0; }
  if (has('shrink')) { if (typeof style.shrink !== 'boolean') fail('shrink to fit'); alignment.shrinkToFit = style.shrink ? 1 : 0; }
  if (has('rot')) {
    if (!Number.isInteger(style.rot) || style.rot < -90 || style.rot > 90) fail('text rotation');
    alignment.textRotation = style.rot < 0 ? 90 - style.rot : style.rot;
  }
  if (has('indent')) {
    if (!Number.isSafeInteger(style.indent) || style.indent < 0 || style.indent > 250) fail('indentation');
    alignment.indent = style.indent;
  }
  if (has('borderOutline') && typeof style.borderOutline !== 'boolean') fail('border outline');
  if (style.borderOutline === false && ['bh', 'bv', 'bhBorder', 'bvBorder'].some(has)) fail('repeated and inner borders');
  if ((has('bs') || has('bc')) && !edges.some(([key]) => style[key] === true)) fail('border pen without an edge');
  for (const [key, side] of edges) {
    const penKey = `${key}Border`;
    if (!has(key)) { if (has(penKey)) fail('border pen without an edge'); continue; }
    if (typeof style[key] !== 'boolean') fail('border flag');
    const pen = style[penKey];
    if (pen != null && (typeof pen !== 'object' || Array.isArray(pen) || Object.keys(pen).some(k => !['bs', 'bc'].includes(k)))) fail('border pen');
    if (!style[key]) { if (pen != null) fail('pen on cleared edge'); border += xmlTag(side); continue; }
    const stroke = pen?.bs ?? style.bs ?? 'thin', color = pen && Object.hasOwn(pen, 'bc') ? pen.bc : style.bc;
    if (!XLSX_BORDER_STYLES.includes(stroke)) fail('border stroke');
    border += xmlTag(side, { style: stroke }, color == null ? xmlTag('color', { auto: 1 }) : xmlTag('color', { rgb: rgb(color) }));
  }
  // CT_Dxf and Excel's border/font child ordering must remain stable.
  return xmlTag('dxf', { xmlns: MAIN }, (font ? xmlTag('font', {}, font) : '') + number + fill
    + (Object.keys(alignment).length ? xmlTag('alignment', alignment) : '') + (border || has('borderOutline') ? xmlTag('border', has('borderOutline') ? { outline: style.borderOutline ? 1 : 0 } : {}, border) : ''));
}
