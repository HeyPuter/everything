import { xlsxAttr, xlsxText } from './xlsx-styles.js';
import { tokenize } from './formula/tokenizer.js';
import { parseRefText, sameSheetName } from './refs.js';
import { normalizePrintSettings } from './print-settings.js';

// Built-in print names accept reference unions, including parenthesized unions,
// but never formulas, intersections, spill operators, or unbalanced syntax.
function printReferences(text) {
  const tokens = tokenize(text.replace(/^=/, ''));
  let depth = 0, operand = true;
  const refs = [];
  for (const t of tokens) {
    if (t.type === 'ref' && !t.spill && operand) { refs.push(t); operand = false; }
    else if (t.type === 'lparen' && operand) depth++;
    else if (t.type === 'rparen' && !operand && depth > 0) depth--;
    else if (t.type === 'comma' && !operand) operand = true;
    else return [];
  }
  return !operand && !depth ? refs : [];
}

/** Read only the worksheet's own page setup, excluding cell text and custom views. */
export function readXlsxPrint(xml, names, sheetName, sheetIndex) {
  if (!xml) return null;
  const settingsXml = xml.replace(/<!--[^]*?-->|<(?:\w+:)?sheetData\b[^]*?<\/(?:\w+:)?sheetData\s*>|<(?:\w+:)?customSheetViews\b[^]*?<\/(?:\w+:)?customSheetViews\s*>/g, '');
  const tag = name => settingsXml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>`))?.[0];
  const setup = tag('pageSetup'), margins = tag('pageMargins'), options = tag('printOptions'), page = tag('pageSetUpPr'), headerFooter = tag('headerFooter');
  const printArea = names?.find(n => /^_xlnm\.Print_Area$/i.test(n.Name) && n.Sheet === sheetIndex)?.Ref;
  const printTitles = names?.find(n => /^_xlnm\.Print_Titles$/i.test(n.Name) && n.Sheet === sheetIndex)?.Ref;
  const breaks = name => {
    const body = settingsXml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^]*?)<\\/(?:\\w+:)?${name}>`))?.[1] || '';
    // Only manual breaks belong to the sheet; automatic ones are where the writer's paper ran out.
    return [...body.matchAll(/<(?:\w+:)?brk\b[^>]*>/g)].map(m => m[0]).filter(brk => ['1', 'true'].includes(xlsxAttr(brk, 'man')?.trim()))
      .map(brk => Number(xlsxAttr(brk, 'id') ?? 0));
  };
  const rowBreaks = breaks('rowBreaks'), colBreaks = breaks('colBreaks');
  if (!setup && !margins && !options && !page && !headerFooter && !printArea && !printTitles && !rowBreaks.length && !colBreaks.length) return null;
  const numeric = (node, attr) => { const value = xlsxAttr(node, attr); return value == null || value === '' ? undefined : Number(value); };
  const bool = (node, attr) => ['1', 'true'].includes(xlsxAttr(node, attr));
  const areas = [];
  const text = name => {
    if (new RegExp(`<(?:\\w+:)?${name}\\b[^>]*?/>`).test(settingsXml)) return '';
    const body = settingsXml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^]*?)<\\/(?:\\w+:)?${name}>`))?.[1];
    return body == null ? undefined : xlsxText(body);
  };
  if (typeof printArea === 'string' && printArea.length <= 8192) {
    try {
      for (const t of printReferences(printArea)) {
        const ref = parseRefText(t.text, t.sheet, t.sheetEnd);
        if (ref && !ref.sheetEnd && (!ref.sheet || sameSheetName(ref.sheet, sheetName))) areas.push(ref);
      }
    } catch { /* A broken print area must not prevent cell data from opening. */ }
  }
  const titles = {};
  if (typeof printTitles === 'string' && printTitles.length <= 8192) {
    try {
      const seen = new Set();
      for (const t of printReferences(printTitles)) {
        const ref = parseRefText(t.text, t.sheet, t.sheetEnd);
        if (!ref || ref.sheetEnd || ref.sheet && !sameSheetName(ref.sheet, sheetName)) continue;
        const key = ref.kind === 'rows' ? 'titleRows' : ref.kind === 'cols' ? 'titleCols' : null;
        if (!key) continue;
        // Excel defines one contiguous range on each axis. Do not arbitrarily
        // choose one of several disjoint ranges in a malformed definition.
        if (seen.has(key)) delete titles[key];
        else titles[key] = key === 'titleRows' ? [ref.r1, ref.r2] : [ref.c1, ref.c2];
        seen.add(key);
      }
    } catch { /* Invalid print titles must not prevent the workbook opening. */ }
  }
  // Excel defaults chart sheets to landscape; worksheets default to portrait.
  // Applying the worksheet default here changes a chart sheet's aspect on export.
  const chart = /<(?:\w+:)?chartsheet\b/.test(settingsXml);
  const orientation = xlsxAttr(setup, 'orientation');
  return normalizePrintSettings({ areas, ...(!chart ? titles : {}), orientation: chart && !['portrait', 'landscape'].includes(orientation) ? 'landscape' : orientation, paperSize: numeric(setup, 'paperSize'),
    pageOrder: xlsxAttr(setup, 'pageOrder')?.trim(), scale: numeric(setup, 'scale'), fitToPage: bool(page, 'fitToPage'), fitWidth: numeric(setup, 'fitToWidth'), fitHeight: numeric(setup, 'fitToHeight'),
    firstPageNumber: numeric(setup, 'firstPageNumber'), useFirstPageNumber: bool(setup, 'useFirstPageNumber'),
    margins: Object.fromEntries(['left', 'right', 'top', 'bottom', 'header', 'footer'].map(k => [k, numeric(margins, k)])),
    horizontalCentered: bool(options, 'horizontalCentered'), verticalCentered: bool(options, 'verticalCentered'),
    gridlines: bool(options, 'gridLines'), headings: bool(options, 'headings'),
    differentFirst: bool(headerFooter, 'differentFirst'), differentOddEven: bool(headerFooter, 'differentOddEven'),
    // CT_HeaderFooter defaults to true; only an explicit false disables it.
    alignWithMargins: !['0', 'false'].includes(xlsxAttr(headerFooter, 'alignWithMargins')?.trim()),
    scaleWithDoc: !['0', 'false'].includes(xlsxAttr(headerFooter, 'scaleWithDoc')?.trim()),
    ...(!chart ? { rowBreaks, colBreaks } : {}),
    header: text('oddHeader'), footer: text('oddFooter'), evenHeader: text('evenHeader'), evenFooter: text('evenFooter'),
    firstHeader: text('firstHeader'), firstFooter: text('firstFooter') });
}
