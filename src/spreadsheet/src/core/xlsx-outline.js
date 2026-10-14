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
