import { IGNORED_ERROR_KEYS, normalizeIgnoredErrors } from './ignored-errors.js';
import { parseRefText } from './refs.js';
import { rangeName } from './cell.js';
import { xlsxText } from './xlsx-styles.js';
import { xmlTag, WORKSHEET_EXTLST } from './xlsx-export-styles.js';

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? xlsxText(m[1] ?? m[2]) : null;
};

export function readXlsxIgnoredErrors(xml) {
  // Cell text/custom views are not worksheet error-check settings. Also accept
  // the x14 extension's child sqref, emitting equivalent ordinary records.
  const source = (xml || '').replace(/<!--[\s\S]*?-->|<(?:\w+:)?(?:sheetData|customSheetViews)\b[\s\S]*?<\/(?:\w+:)?(?:sheetData|customSheetViews)\s*>/g, '');
  const records = [];
  for (const block of source.matchAll(/<(?:\w+:)?ignoredErrors\b[^>]*>([\s\S]*?)<\/(?:\w+:)?ignoredErrors\s*>/g)) {
    for (const [, head, body = ''] of block[1].matchAll(/<(?:\w+:)?ignoredError\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?ignoredError\s*>)/g)) {
      const keys = IGNORED_ERROR_KEYS.filter(key => ['1', 'true'].includes(attr(` ${head}`, key)?.trim()));
      if (!keys.length) continue;
      const sqref = attr(` ${head}`, 'sqref') ?? xlsxText(body.match(/<(?:\w+:)?sqref\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sqref\s*>/)?.[1]) ?? '';
      for (const token of sqref.trim().split(/\s+/)) {
        const ref = parseRefText(token);
        if (!ref || ref.sheet || ref.sheetEnd || ref.spill || !['cell', 'range', 'rows', 'cols'].includes(ref.kind)) continue;
        records.push({ range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 }, keys });
      }
    }
  }
  return normalizeIgnoredErrors(records);
}

export function writeXlsxIgnoredErrors(xml, records) {
  // Remove the vendor's blanket numberStoredAsText suppression. Only explicit
  // workbook acknowledgements belong in this element.
  xml = xml.replace(/<ignoredErrors\b[^>]*(?:\/>|>[\s\S]*?<\/ignoredErrors>)/g, '');
  const body = normalizeIgnoredErrors(records).map(record => xmlTag('ignoredError', {
    sqref: rangeName(record.range), ...Object.fromEntries(record.keys.map(key => [key, 1])),
  })).join('');
  return body ? xml.replace(new RegExp(`<(?:smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts)\\b|${WORKSHEET_EXTLST}|<\\/worksheet>`),
    match => xmlTag('ignoredErrors', {}, body) + match) : xml;
}
