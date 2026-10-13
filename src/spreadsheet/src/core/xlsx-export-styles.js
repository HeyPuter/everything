import { exportFontScheme } from './font-theme.js';
import { TABLE_STYLE_REGIONS } from './tables.js';
import { decodeXlsxString, encodeXlsxAttribute } from './xlsx-string.js';
import { fontColorInPalette } from './font-color.js';
import { fillColorInPalette } from './fill-color.js';
import { normalizeNativeFill, nativeFillXml, nativeFillMatchesPaint, nativeFillRecordXml, nativeFillPalette, nativeFillIsNone, nativeFillXmlIdentity } from './native-fill.js';
/** Native SpreadsheetML styles, shared by cells and whole-row/column defaults. */
import { styleToNumFmt } from './format.js';
import { xlsxAttr, xlsxElements } from './xlsx-styles.js';
import { normalFontStyle } from './normal-font.js';
import { writeNativeNormalStyle } from './native-normal-style.js';
import { writeNativeDefaultCellFormat } from './native-default-cell-format.js';
import { xlsxFontName, xlsxFontSize, xlsxSolidColor } from './xlsx-style-projection.js';
import { styleAsCell, normalizeCellStyles } from './custom-cell-styles.js';

export const xmlText = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const xmlTag = (name, attrs = {}, body = null) => {
  // XML normalizes literal attribute whitespace; character references keep
  // newlines and tabs in table headers, formats and other attribute values.
  const head = `<${name}${Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${xmlText(v).replace(/[\t\n\r]/g, ch => `&#${ch.charCodeAt(0)};`)}"`).join('')}`;
  return body == null ? `${head}/>` : `${head}>${body}</${name}>`;
};
const rgb = value => xlsxSolidColor(value) ? `FF${value.slice(1).toUpperCase()}` : null;
const color = value => rgb(value) ? xmlTag('color', { rgb: rgb(value) }) : '';
const table = (name, entries) => xmlTag(name, { count: entries.length }, entries.join(''));

export function fontColorXml(value, palette) {
  const c = fontColorInPalette(value, palette);
  if (c === 'windowtext') return xmlTag('color', { auto: 1 });
  if (c && typeof c === 'object') {
    const key = 'theme' in c ? 'theme' : 'indexed';
    return xmlTag('color', { [key]: c[key], tint: c.tint });
  }
  return color(c);
}

export function fillColorXml(value, palette, name = 'fgColor') {
  const c = fillColorInPalette(value, palette);
  if (c && typeof c === 'object') {
    const key = 'theme' in c ? 'theme' : 'indexed';
    return xmlTag(name, { [key]: c[key], tint: c.tint });
  }
  return rgb(c) ? xmlTag(name, { rgb: rgb(c) }) : '';
}

function fontXml(s, differential = false, defaultColor = '', palette = null, fontTheme = null) {
  let body = '';
  // Excel requires ordered font children, although the base OOXML schema
  // permits a choice. This applies to ordinary and differential fonts alike.
  // https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/5b4f9876-7379-4354-819c-8c169e5d37ae
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike'], ['underline', 'u']]) {
    if (s[key]) body += xmlTag(tag);
    else if (differential && s[key] === false) body += xmlTag(tag, { val: tag === 'u' ? 'none' : 0 });
  }
  if (!differential || s.size) body += xmlTag('sz', { val: xlsxFontSize(s.size) });
  body += s.color === null ? xmlTag('color', { auto: 1 }) : fontColorXml(s.color, palette) || defaultColor;
  if (!differential || s.font) body += xmlTag('name', { val: xlsxFontName(s.font) });
  const scheme = exportFontScheme(xlsxFontName(s.font), s.scheme, fontTheme);
  if (scheme) body += xmlTag('scheme', { val: scheme });
  return xmlTag('font', {}, body);
}

function normalFontXml(font, palette, fontTheme) {
  let body = '';
  for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strike', 'strike'], ['condense', 'condense'], ['extend', 'extend'], ['outline', 'outline'], ['shadow', 'shadow']]) {
    if (font[key]) body += xmlTag(tag);
  }
  if (font.underline) body += xmlTag('u', { val: font.underline });
  if (font.vertAlign) body += xmlTag('vertAlign', { val: font.vertAlign });
  body += xmlTag('sz', { val: font.sz }) + fontColorXml(font.color, palette) + xmlTag('name', { val: font.name });
  for (const key of ['family', 'charset']) if (font[key] != null) body += xmlTag(key, { val: font[key] });
  const scheme = exportFontScheme(font.name, font.scheme, fontTheme);
  if (scheme) body += xmlTag('scheme', { val: scheme });
  return xmlTag('font', {}, body);
}

function fillXml(s, differential = false, palette = null) {
  // Excel differential fills use bgColor for the solid cell shading.
  // A normal XF fill uses fgColor with an automatic background instead.
  const paint = fillColorXml(s.bg, palette, differential ? 'bgColor' : 'fgColor');
  if (differential && paint) return xmlTag('fill', {}, xmlTag('patternFill', {}, paint));
  return xmlTag('fill', {}, paint
    ? xmlTag('patternFill', { patternType: 'solid' }, paint + xmlTag('bgColor', { indexed: 64 }))
    : xmlTag('patternFill', { patternType: 'none' }));
}

function borderXml(s, differential = false) {
  let body = '';
  // CT_Border is a sequence: vertical must precede horizontal, even when
  // both are explicit clears. Excel otherwise discards the entire styles part.
  for (const [key, side] of [['bl', 'left'], ['br', 'right'], ['bt', 'top'], ['bb', 'bottom'], ['bv', 'vertical'], ['bh', 'horizontal']]) {
    if (differential && !Object.hasOwn(s, key)) continue;
    if (!differential && ['bh', 'bv'].includes(key) && !s[key]) continue;
    const edge = s[`${key}Border`] || s;
    const style = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'].includes(edge.bs) ? edge.bs : 'thin';
    body += s[key] ? xmlTag(side, { style }, color(edge.bc) || xmlTag('color', { auto: 1 })) : xmlTag(side);
  }
  return xmlTag('border', {}, body);
}

function alignmentXml(s) {
  const attrs = {};
  if (['left', 'center', 'right'].includes(s.align)) attrs.horizontal = s.align;
  // The grid centers unformatted content vertically; Excel's default is bottom.
  attrs.vertical = { top: 'top', middle: 'center', bottom: 'bottom' }[s.valign] || 'center';
  if (s.wrap) attrs.wrapText = 1;
  if (s.shrink) attrs.shrinkToFit = 1;
  if (Number.isFinite(s.indent) && s.indent > 0) attrs.indent = Math.min(250, Math.floor(s.indent));
  if (Number.isFinite(s.rot) && s.rot >= -90 && s.rot <= 90 && s.rot !== 0) attrs.textRotation = s.rot < 0 ? 90 - Math.round(s.rot) : Math.round(s.rot);
  return xmlTag('alignment', attrs);
}

export function exportStyles(source, normalFont = null, palette = null, defaultVAlign = null, fontTheme = null, nativeNormalStyle = null, nativeNormalFill = null, nativeDefaultCellFormat = null, namedStyles = []) {
  const normalStyle = normalFontStyle(normalFont);
  const records = (tag, item) => xlsxElements(xlsxElements(source, tag)[0], item);
  const fonts = records('fonts', 'font'), fills = records('fills', 'fill'), borders = records('borders', 'border');
  if (normalFont) fonts[0] = normalFontXml(normalFont, palette, fontTheme);
  else if (fonts[0]) fonts[0] = fonts[0].replace(/<scheme\b[^>]*\/>/g, '');
  // An unspecified font color inherits Normal. Omitting its XML color would
  // instead mean automatic, which Excel treats as a direct table-style override
  // when Normal uses a theme, indexed or RGB color. Retain its native identity.
  const defaultColor = xlsxElements(fonts[0], 'color')[0] || '';
  const xfs = records('cellXfs', 'xf'), numFmts = records('numFmts', 'numFmt'), dxfs = [], tableStyles = [];
  const initialXfs = [...xfs];
  // Unallocated cells use XF zero, independently of the named Normal style.
  if (defaultVAlign && xfs[0]) {
    const base = xfs[0].replace(/<alignment\b[^>]*?(?:\/>|>[\s\S]*?<\/alignment>)/g, '')
      .replace(/\sapplyAlignment="[^"]*"/g, '').replace('<xf', '<xf applyAlignment="1"');
    xfs[0] = base.replace(/\/>$|<\/xf>$/, match => `${match === '/>' ? '>' : ''}${alignmentXml({ valign: defaultVAlign })}</xf>`);
  }
  const indexes = new Map();
  const intern = (entries, xml) => {
    let map = indexes.get(entries);
    if (!map) { map = new Map(entries.map((value, i) => [value, i])); indexes.set(entries, map); }
    if (!map.has(xml)) { map.set(xml, entries.length); entries.push(xml); }
    return map.get(xml);
  };
  const boundFills = new Map();
  // The mutable named-style definition remains authoritative for edits to
  // Normal. Rebind its shared resource as a group without altering immutable
  // source atoms, including cells/lines still using the original binding.
  const normalFill = nativeNormalFill ? normalizeNativeFill(nativeNormalFill) : null;
  const editedNormalFill = normalFill && nativeNormalStyle
    && nativeFillXmlIdentity(nativeNormalStyle.fill) !== nativeFillXmlIdentity(normalFill.xml)
    ? normalizeNativeFill({ key: `${crypto.randomUUID()}:normal`, xml: nativeNormalStyle.fill, palette }) : null;
  const resourceFill = value => {
    const sourceFill = normalizeNativeFill(value);
    const fill = editedNormalFill && sourceFill.key === normalFill.key ? editedNormalFill : sourceFill;
    const previous = boundFills.get(fill.key);
    if (previous) {
      if (previous.fill !== fill && JSON.stringify(previous.fill) !== JSON.stringify(fill)) throw new Error('Conflicting native fill resources');
      return previous.index;
    }
    // Deliberately allocate by resource identity, not XML/color equality.
    const index = fills.length;
    fills.push(nativeFillXml(fill, palette));
    boundFills.set(fill.key, { fill, index });
    return index;
  };
  const normalFillId = nativeNormalFill ? resourceFill(nativeNormalFill) : null;
  let normalIndex = 0;
  // The workbook's named cell styles follow Normal among the style XFs, each linked by name from cellStyles; a
  // cell formatted with one points its xfId at it. The apply flags of a style XF say which parts the style holds.
  // A modified Normal stays in the app's own record: the file's Normal is the built-in style every format rests on.
  const named = normalizeCellStyles(namedStyles).filter((def) => def.builtin !== 'normal');
  const styleBase = nativeNormalStyle || normalFillId != null ? 1 : Math.max(1, records('cellStyleXfs', 'xf').length);
  const namedIndex = new Map(named.map((def, i) => [def.name.toLowerCase(), styleBase + i]));
  // Format codes are ST_Xstring: compare decoded identities and encode only at
  // the XML boundary, so a literal _x0041_ cannot become A on the next read.
  const formats = new Map(numFmts.map(n => [decodeXlsxString(xlsxAttr(n, 'formatCode')), Number(xlsxAttr(n, 'numFmtId'))]));
  let nextFormat = Math.max(163, ...formats.values()) + 1;
  const numberFormat = s => {
    const code = styleToNumFmt(s);
    return numberFormatCode(code);
  };
  const numberFormatCode = (code, forceCustom = false) => {
    if (!forceCustom && (!code || code === 'General')) return 0;
    if (!formats.has(code)) {
      formats.set(code, nextFormat++);
      numFmts.push(xmlTag('numFmt', { numFmtId: formats.get(code), formatCode: encodeXlsxAttribute(code) }));
    }
    return formats.get(code);
  };
  const differential = (s = {}) => intern(dxfs, xmlTag('dxf', {},
    fontXml(s, true, '', palette, fontTheme) + (Object.hasOwn(s, 'bg') ? fillXml(s, true, palette) : '') + borderXml(s, true)));
  // Whole-column defaults often repeat one XF across thousands of columns.
  // Avoid rebuilding identical font/fill/border XML before interning it.
  const cellFormats = new Map();
  return {
    differential,
    numberFormatCode,
    differentialXml: xml => intern(dxfs, xml),
    pivotStyle(xml) {
      const name = `PuterPivotStyle${tableStyles.length + 1}`;
      tableStyles.push(xml.replace(/\sname="[^"]*"/, ` name="${name}"`));
      return name;
    },
    cell(s = {}, original = null) {
      if (nativeDefaultCellFormat) s = { ...nativeDefaultCellFormat.style, ...s };
      const fill = s.nativeFill && nativeFillMatchesPaint(s.nativeFill, s.bg) ? normalizeNativeFill(s.nativeFill) : null;
      const key = JSON.stringify([{ ...s, nativeFill: fill?.key || null }, original]);
      if (cellFormats.has(key)) return cellFormats.get(key);
      const numFmtId = original == null ? numberFormat(s) : Number(xlsxAttr(initialXfs[original], 'numFmtId') || 0);
      const index = intern(xfs, xmlTag('xf', {
        numFmtId, fontId: intern(fonts, fontXml({ ...normalStyle, ...s }, false, defaultColor, palette, fontTheme)), fillId: fill ? resourceFill(fill) : intern(fills, fillXml(s, false, palette)), borderId: intern(borders, borderXml(s)),
        xfId: (typeof s.cellStyle === 'string' && namedIndex.get(s.cellStyle.toLowerCase())) || 0, applyFont: 1, applyFill: 1, applyBorder: 1, applyAlignment: 1, applyNumberFormat: 1,
        applyProtection: s.locked === false || s.formulaHidden ? 1 : null,
      }, alignmentXml(s) + (s.locked === false || s.formulaHidden
        ? xmlTag('protection', { locked: s.locked === false ? 0 : null, hidden: s.formulaHidden ? 1 : null }) : '')));
      cellFormats.set(key, index);
      return index;
    },
    tableStyle(name, parts) {
      let body = '', count = 0;
      for (const type of TABLE_STYLE_REGIONS) {
        const s = parts[type];
        if (!s) continue;
        body += xmlTag('tableStyleElement', { type, dxfId: differential(s), size: /Stripe$/.test(type) ? s.stripeSize || 1 : null });
        count++;
      }
      tableStyles.push(xmlTag('tableStyle', { name, pivot: 0, table: 1, count }, body));
    },
    xml() {
      let result = source;
      if (nativeDefaultCellFormat) {
        const value = nativeDefaultCellFormat, fill = value.style.nativeFill;
        xfs[0] = writeNativeDefaultCellFormat(value, {
          fontId: intern(fonts, value.font),
          fillId: fill ? resourceFill(fill) : nativeFillIsNone(value.fill) ? 0 : intern(fills, value.fill),
          borderId: intern(borders, value.border),
          numFmtId: typeof value.numberFormat === 'number' ? value.numberFormat : numberFormatCode(value.numberFormat, true),
        }, defaultVAlign);
      }
      if (nativeNormalStyle) {
        normalIndex = normalFillId ?? (nativeFillIsNone(nativeNormalStyle.fill) ? 0 : intern(fills, nativeNormalStyle.fill));
        const xf = writeNativeNormalStyle(nativeNormalStyle, {
          fillId: normalIndex, borderId: intern(borders, nativeNormalStyle.border),
          numFmtId: typeof nativeNormalStyle.numberFormat === 'number' ? nativeNormalStyle.numberFormat : numberFormatCode(nativeNormalStyle.numberFormat, true),
        });
        result = result.replace(/<cellStyleXfs\b[^>]*(?:\/>|>[\s\S]*?<\/cellStyleXfs>)/, () => table('cellStyleXfs', [xf]));
      } else if (normalFillId != null) {
        normalIndex = normalFillId;
        const xf = xmlTag('xf', { numFmtId: 0, fontId: 0, fillId: normalFillId, borderId: 0 });
        result = result.replace(/<cellStyleXfs\b[^>]*(?:\/>|>[\s\S]*?<\/cellStyleXfs>)/, () => table('cellStyleXfs', [xf]));
      }
      if (named.length) {
        const styleXfs = named.map((def) => {
          const s = styleAsCell(def), p = def.parts, flag = (on) => (on ? 1 : 0);
          return xmlTag('xf', {
            numFmtId: numberFormat(s), fontId: intern(fonts, fontXml({ ...normalStyle, ...s }, false, defaultColor, palette, fontTheme)),
            fillId: intern(fills, fillXml(s, false, palette)), borderId: intern(borders, borderXml(s)),
            applyNumberFormat: flag(p.number), applyFont: flag(p.font), applyFill: flag(p.fill), applyBorder: flag(p.border),
            applyAlignment: flag(p.alignment), applyProtection: flag(p.protection),
          }, (p.alignment ? alignmentXml(s) : '') + (p.protection ? xmlTag('protection', { locked: s.locked === false ? 0 : 1, hidden: s.formulaHidden ? 1 : 0 }) : ''));
        });
        result = result.replace(/<cellStyleXfs\b[^>]*(?:\/>|>[\s\S]*?<\/cellStyleXfs>)/, (all) => {
          const kept = xlsxElements(all, 'xf').slice(0, styleBase);
          return table('cellStyleXfs', [...kept, ...styleXfs]);
        });
        const entries = named.map((def, i) => xmlTag('cellStyle', { name: def.name, xfId: styleBase + i }));
        result = result.replace(/<cellStyles\b[^>]*(?:\/>|>[\s\S]*?<\/cellStyles>)/, (all) => {
          const kept = xlsxElements(all, 'cellStyle').filter((c) => !named.some((def) => xlsxAttr(c, 'name')?.toLowerCase() === def.name.toLowerCase()));
          return table('cellStyles', [...kept, ...entries]);
        });
      }
      for (const [name, entries] of [['fonts', fonts], ['fills', fills], ['borders', borders], ['cellXfs', xfs], ['dxfs', dxfs], ['tableStyles', tableStyles]]) {
        result = result.replace(new RegExp(`<${name}\\b[^>]*(?:/>|>[\\s\\S]*?</${name}>)`), () => table(name, entries));
      }
      const numbers = table('numFmts', numFmts);
      result = /<numFmts\b/.test(result) ? result.replace(/<numFmts\b[^>]*(?:\/>|>[\s\S]*?<\/numFmts>)/, () => numbers) : result.replace('<fonts', () => `${numbers}<fonts`);
      return result;
    },
    fillBaseline() {
      const keys = new Map([...boundFills].map(([key, value]) => [value.index, key]));
      return { normalIndex, records: fills.map((xml, index) => {
        xml = nativeFillRecordXml(xml);
        return { xml, key: keys.get(index) || null, palette: nativeFillPalette(xml, palette) };
      }) };
    },
  };
}
