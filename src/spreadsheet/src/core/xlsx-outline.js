/**
 * A worksheet's outline settings in SpreadsheetML (sheetPr/outlinePr): where summary rows and columns sit beside
 * their detail, and whether outline styles are applied automatically.
 */
import { xmlTag } from './xlsx-export-styles.js';
import { xlsxAttr } from './xlsx-styles.js';
import { normalizeOutlineSettings } from './workbook.js';

const off = (v) => ['0', 'false'].includes(String(v ?? '').trim());
const on = (v) => ['1', 'true'].includes(String(v ?? '').trim());

/** The outline settings a worksheet part records, or null for the defaults. */
export function readXlsxOutlineSettings(xml) {
  const sheetPr = xml?.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?sheetPr\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetPr>)/)?.[0];
  const tag = sheetPr?.match(/<(?:\w+:)?outlinePr\b[^>]*>/)?.[0];
  if (!tag) return null;
  return normalizeOutlineSettings({
    summaryBelow: !off(xlsxAttr(tag, 'summaryBelow')),
    summaryRight: !off(xlsxAttr(tag, 'summaryRight')),
    autoStyles: on(xlsxAttr(tag, 'applyStyles')),
  });
}

/** Write a sheet's outline settings into its worksheet part, in the place CT_SheetPr gives outlinePr. */
export function writeXlsxOutlineSettings(xml, settings) {
  xml = xml.replace(/<outlinePr\b[^>]*\/>/g, '');
  const s = normalizeOutlineSettings(settings);
  if (!s) return xml;
  const tag = xmlTag('outlinePr', { applyStyles: s.autoStyles ? 1 : null, summaryBelow: s.summaryBelow === false ? 0 : null, summaryRight: s.summaryRight === false ? 0 : null });
  if (/<sheetPr\b[^>]*\/>/.test(xml)) return xml.replace(/<sheetPr\b([^>]*?)\/>/, `<sheetPr$1>${tag}</sheetPr>`);
  if (/<sheetPr\b/.test(xml)) {
    const head = xml.match(/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>/)[0];
    const next = /<pageSetUpPr\b/.test(head) ? head.replace(/<pageSetUpPr\b/, `${tag}<pageSetUpPr`) : head.replace('</sheetPr>', `${tag}</sheetPr>`);
    return xml.replace(head, () => next);
  }
  return xml.replace(/(<worksheet\b[^>]*>)/, `$1<sheetPr>${tag}</sheetPr>`);
}

/**
 * The outline level of each line an axis's groups hold ({ from, to } each; nested groups add up, at most the
 * seven a file can hold), as SpreadsheetML gives them on <row outlineLevel> and <col outlineLevel>. A group
 * running on past the sheet's last line (`last`, rows 2 to 1,048,576 grouped whole) stops there: each line
 * with a level is a record of its own, and a million of them for empty rows made a save take tens of seconds.
 */
export function outlineLineLevels(groups, last = Infinity) {
  const levels = new Map();
  for (const g of groups || []) {
    const end = g.to <= last ? g.to : Math.max(last, g.from);
    for (let i = g.from; i <= end; i++) levels.set(i, Math.min(7, (levels.get(i) || 0) + 1));
  }
  return levels;
}

/**
 * The lines Excel marks collapsed="1" for the collapsed groups: each one's summary line, after the group
 * (before it where summaries sit above or to the left), within the grid.
 */
export function outlineCollapsedLines(groups, summaryAfter, max) {
  const lines = new Set();
  for (const g of groups || []) {
    if (!g.collapsed) continue;
    const at = summaryAfter ? g.to + 1 : g.from - 1;
    if (at >= 0 && at <= max) lines.add(at);
  }
  return lines;
}
