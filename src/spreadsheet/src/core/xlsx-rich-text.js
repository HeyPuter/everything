import { xlsxAttr, xlsxElements, xlsxText, fontColor } from './xlsx-styles.js';
import { xmlTag, xmlText, fontColorXml } from './xlsx-export-styles.js';
import { fontKeyFor } from './format.js';
import { xlsxFontName } from './xlsx-style-projection.js';
import { normalizeRichText, richFontStyle } from './rich-text.js';
import { resolveThemeFont, exportFontScheme } from './font-theme.js';
import { normalFontStyle } from './normal-font.js';

const first = (xml, tag) => xlsxElements(xml, tag)[0];
const flags = [['bold', 'b'], ['italic', 'i'], ['strike', 'strike'], ['condense', 'condense'],
  ['extend', 'extend'], ['outline', 'outline'], ['shadow', 'shadow']];
// Every t element is its own ST_Xstring: decoding after joining can invent an
// escape across a run boundary. XML line-ending normalization happens first.
const decodeText = text => xlsxText(text.replace(/\r\n?/g, '\n')).replace(/_x([\da-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const encodeText = text => xmlText(text.replace(/_x[\da-f]{4}_/gi, value => '_x005F_' + value.slice(1))
  .replace(/[\u0000-\u0008\u000b-\u001f\ud800-\udfff\ufffe\uffff]/gu, ch => `_x${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`));

/** The vendor retains each shared/inline string's original rich XML in r. */
export function readXlsxRichText(xml, value, colors, normalFont = null) {
  if (typeof xml !== 'string' || typeof value !== 'string') return null;
  const runs = xlsxElements(xml.replace(/<!--[^]*?-->/g, ''), 'r').map(run => {
    const rawProperties = first(run, 'rPr');
    // Excel treats an empty rPr like an absent one. A property record with
    // actual children starts a separately specified run font.
    const properties = /<(?:\w+:)?(?:rFont|b|i|strike|outline|shadow|condense|extend|sz|color|u|vertAlign|scheme|family|charset)\b/.test(rawProperties || '') ? rawProperties : null;
    const s = {};
    for (const [key, tag] of flags) {
      const node = first(properties, tag);
      if (properties) s[key] = !!node && !['0', 'false'].includes(xlsxAttr(node, 'val'));
    }
    // Native Excel saves omitted run names/sizes using the workbook's Normal
    // face and size. Other omitted properties reset (including automatic ink),
    // rather than inheriting a bold/colored cell or Normal font. Verified with
    // distinct cell and Normal fonts and sizes in native open/save controls.
    const name = resolveThemeFont(xlsxAttr(first(properties, 'rFont'), 'val') ?? (properties ? normalFont?.name : null), xlsxAttr(first(properties, 'scheme'), 'val'), colors?.fontTheme);
    if (name) s.font = fontKeyFor(name, { literal: true });
    const size = xlsxAttr(first(properties, 'sz'), 'val') ?? (properties ? normalFont?.sz : null);
    if (size != null) s.size = Number(size) * 4 / 3;
    const underline = first(properties, 'u');
    if (properties) s.underline = underline ? xlsxAttr(underline, 'val') || 'single' : false;
    const color = first(properties, 'color');
    if (properties) s.color = fontColor(color, colors, true);
    for (const key of ['vertAlign', 'scheme']) {
      const v = xlsxAttr(first(properties, key), 'val');
      if (properties) s[key] = key === 'scheme' ? (['major', 'minor'].includes(v) ? v : 'none') : v ?? 'baseline';
    }
    for (const key of ['family', 'charset']) {
      const v = xlsxAttr(first(properties, key), 'val');
      if (v != null) s[key] = Number(v);
    }
    const t = first(run, 't');
    return { text: t && !/\/>$/.test(t) ? decodeText(t.slice(t.indexOf('>') + 1).replace(/<\/(?:\w+:)?t\s*>$/, '')) : '', s };
  });
  return normalizeRichText(runs, value);
}

export function richTextXml(runs, palette, base = null, fontTheme = null) {
  return runs.map(({ text, s: own = {} }) => {
    // A nonempty rPr is a whole run font in Excel. Materialize inherited
    // character properties so changing just the color cannot reset its size,
    // family or weight during a native round trip.
    const s = base && Object.keys(own).length ? { ...richFontStyle(base), ...own } : own;
    let properties = '';
    // MS-OI29500 §2.1.674: Excel requires this child order even though the
    // standard's CT_RPrElt schema permits a choice.
    for (const [key, tag] of flags) if (typeof s[key] === 'boolean') properties += xmlTag(tag, { val: Number(s[key]) });
    if (s.underline != null) properties += xmlTag('u', { val: s.underline === true ? 'single' : s.underline === false ? 'none' : s.underline });
    if (s.vertAlign) properties += xmlTag('vertAlign', { val: s.vertAlign });
    if (s.size) properties += xmlTag('sz', { val: s.size * 3 / 4 });
    if (s.color) properties += fontColorXml(s.color, palette);
    if (s.font) properties += xmlTag('rFont', { val: xlsxFontName(s.font) });
    for (const key of ['family', 'charset']) if (s[key] != null) properties += xmlTag(key, { val: s[key] });
    const scheme = exportFontScheme(xlsxFontName(s.font), s.scheme, fontTheme);
    if (scheme) properties += xmlTag('scheme', { val: scheme });
    return xmlTag('r', {}, (properties ? xmlTag('rPr', {}, properties) : '')
      + xmlTag('t', { 'xml:space': 'preserve' }, encodeText(text)));
  }).join('');
}

/** Emit native inline strings without changing the global shared-string policy. */
export function writeXlsxRichText(xml, ws, palette, normalFont, fontTheme = null) {
  return xml.replace(/<c\b([^>]*)>([^]*?)<\/c>/g, (cell, attrs, body) => {
    const source = ws[xlsxAttr(`<c${attrs}>`, 'r')];
    const runs = source?.t === 's' && !source.f && normalizeRichText(source.richText, source.v);
    if (!runs) return cell;
    const tag = attrs.replace(/\s+t="[^"]*"/, '') + ' t="inlineStr"';
    const base = { ...normalFontStyle(normalFont), ...source.s };
    return `<c${tag}>${body.replace(/<v\b[^>]*>[^]*?<\/v>|<is\b[^>]*>[^]*?<\/is>/g, '')}<is>${richTextXml(runs, palette, base, fontTheme)}</is></c>`;
  });
}
