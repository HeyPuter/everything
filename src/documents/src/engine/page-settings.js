import { normalizeColor } from './colors.js';
import { sectionColumnIntervals } from './section-columns.js';
import { checkedPageBorders } from './page-borders.js';
import { checkedLineNumbers } from './line-number-settings.js';
import { HYPHENATION_DEFAULTS, checkedHyphenationSetting, hyphenationGeometry } from './hyphenation-settings.js';
/** Page settings use integer twips; the document-wide background is resolved sRGB. */
export const DEFAULT_PAGE_SETTINGS = Object.freeze({
  width: 12240, height: 15840, orientation: 'portrait',
  background: 'auto',
  backgroundPicture: null,
  pageBorders: null,
  bordersDoNotSurroundHeader: false, bordersDoNotSurroundFooter: false,
  columns: null, sectionType: 'nextPage', verticalAlignment: 'top',
  top: 1440, right: 1440, bottom: 1440, left: 1440,
  header: 720, footer: 720, gutter: 0, gutterAtTop: false,
  bookFoldPrinting: false, bookFoldRevPrinting: false,
  // Document settings (§17.15.1.57, §17.15.1.65): inside/outside margins on facing pages, two pages per sheet.
  mirrorMargins: false, printTwoOnOne: false,
  compatibilityMode: 12,
  splitPgBreakAndParaMark: false, suppressSpBfAfterPgBrk: false,
  // Section line numbering (w:lnNumType): null or { countBy, start, distance, restart }.
  lineNumbers: null,
  defaultTabStop: 720, noTabHangInd: false, forgetLastTabAlignment: false, allowSpaceOfSameStyleInTable: false, wrapTrailSpaces: false, ulTrailSpace: false, doNotExpandShiftReturn: false, doNotUseHTMLParagraphAutoSpacing: false,
  // Document-wide hyphenation settings (§17.15.1): see hyphenation-settings.js.
  ...HYPHENATION_DEFAULTS,
});
export const PAPER_SIZES = Object.freeze({ Letter: [12240, 15840], A4: [11906, 16838], Legal: [12240, 20160] });
/** How a section starts (ST_SectionMark, §17.18.77); next-column starts are not supported. */
export const SECTION_TYPES = Object.freeze(['nextPage', 'continuous', 'evenPage', 'oddPage']);
/**
 * Settings that belong to the document rather than a section: every section's settings carry the
 * same values, so changing one changes them all.
 */
export const DOCUMENT_PAGE_KEYS = Object.freeze(['background', 'backgroundPicture', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'bookFoldPrinting', 'bookFoldRevPrinting', 'mirrorMargins', 'printTwoOnOne', 'compatibilityMode',
  'splitPgBreakAndParaMark', 'suppressSpBfAfterPgBrk', 'defaultTabStop', 'noTabHangInd', 'forgetLastTabAlignment', 'allowSpaceOfSameStyleInTable', 'wrapTrailSpaces', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing', 'gutterAtTop', ...Object.keys(HYPHENATION_DEFAULTS)]);
export function validatePageSettings(input = {}) {
  const result = { ...DEFAULT_PAGE_SETTINGS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(DEFAULT_PAGE_SETTINGS, key)) throw new Error('Unknown page setting.');
    if (Object.hasOwn(HYPHENATION_DEFAULTS, key)) {
      checkedHyphenationSetting(key, value);
    } else if (key === 'backgroundPicture') {
      if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['assetId','width','height'].includes(k)) || typeof value.assetId !== 'string' || !value.assetId || ![value.width,value.height].every(n => Number.isFinite(n) && n > 0 && n <= 1e9))) throw new Error('Invalid page picture background.');
      result.backgroundPicture = value;
    } else if (key === 'lineNumbers') {
      try { result.lineNumbers = checkedLineNumbers(value); } catch (e) { throw new Error(`Invalid line numbering: ${e.message}`); }
    } else if (key === 'pageBorders') {
      result.pageBorders = checkedPageBorders(value);
    } else if (key === 'verticalAlignment') {
      if (!['top', 'center', 'bottom', 'both'].includes(value)) throw new Error('Unsupported vertical page alignment.');
    } else if (key === 'sectionType') {
      if (!SECTION_TYPES.includes(value)) throw new Error('Unsupported section type.');
    } else if (key === 'columns') {
      if (value !== null && (!value || typeof value !== 'object' || typeof value.equalWidth !== 'boolean' || typeof value.separator !== 'boolean' || !Number.isSafeInteger(value.count) || !Number.isSafeInteger(value.space) || value.space < 0
        || !value.equalWidth && (!Array.isArray(value.entries) || value.entries.length !== value.count || value.entries.some(e => !e || !Number.isSafeInteger(e.width) || e.width <= 0 || !Number.isSafeInteger(e.space) || e.space < 0)))) throw new Error('Invalid section columns.');
    } else if (key === 'background') {
      result.background = normalizeColor(value);
    } else if (['bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error('Invalid page border story setting.');
    } else if (key === 'compatibilityMode') {
      if (![11, 12, 14, 15].includes(value)) throw new Error('Unsupported document compatibility mode.');
    } else if (key === 'orientation') {
      if (!['portrait', 'landscape'].includes(value)) throw new Error('Choose portrait or landscape orientation.');
    } else if (['bookFoldPrinting', 'bookFoldRevPrinting', 'mirrorMargins', 'printTwoOnOne', 'gutterAtTop', 'splitPgBreakAndParaMark', 'suppressSpBfAfterPgBrk', 'noTabHangInd', 'forgetLastTabAlignment', 'allowSpaceOfSameStyleInTable', 'wrapTrailSpaces', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error('Invalid page compatibility flag.');
    } else if (!Number.isInteger(value) || Math.abs(value) > 31680 || (!['top', 'bottom'].includes(key) && value < 0)) {
      throw new Error('Page settings must use valid measurements up to 22 inches.');
    }
  }
  if (result.defaultTabStop < 1) throw new Error('Default tab spacing must be greater than zero.');
  if (result.width < 1440 || result.height < 1440) throw new Error('Pages must be at least one inch wide and high.');
  const horizontal = result.left + result.right + (result.gutterAtTop ? 0 : result.gutter);
  const vertical = Math.abs(result.top) + Math.abs(result.bottom) + (result.gutterAtTop ? result.gutter : 0);
  const [sheetWidth, sheetHeight] = readingPageSize(result);
  if (sheetWidth - horizontal < 360 || sheetHeight - vertical < 360) throw new Error('Margins must leave at least a quarter inch of writing space.');
  if (result.columns) sectionColumnIntervals(result.columns, result.left, sheetWidth - horizontal);
  return result;
}
/**
 * The size of one reading page in twips. Two pages per sheet (printTwoOnOne) halves the sheet across
 * its longer side; otherwise a page is the sheet that pgSz describes.
 */
export function readingPageSize(p) {
  if (!p.printTwoOnOne || p.bookFoldPrinting || p.bookFoldRevPrinting) return [p.width, p.height];
  return p.height >= p.width ? [p.width, Math.round(p.height / 2)] : [Math.round(p.width / 2), p.height];
}
export function pageGeometry(settings = DEFAULT_PAGE_SETTINGS) {
  const p = validatePageSettings(settings);
  const bookFold = p.orientation === 'landscape' && !p.gutterAtTop && (p.bookFoldPrinting || p.bookFoldRevPrinting);
  const [width, height] = readingPageSize(p);
  return {
    width: width / 15, height: height / 15, gap: 24,
    ...(p.mirrorMargins && !bookFold ? { mirror: true } : {}),
    background: p.background === 'auto' ? '#FFFFFF' : `#${p.background}`,
    backgroundPicture: p.backgroundPicture,
    pageBorders: p.pageBorders,
    bordersDoNotSurroundHeader: p.bordersDoNotSurroundHeader, bordersDoNotSurroundFooter: p.bordersDoNotSurroundFooter,
    header: p.header / 15, footer: p.footer / 15,
    fixedTop: p.top < 0, fixedBottom: p.bottom < 0,
    compatibilityMode: p.compatibilityMode,
    columns: p.columns, sectionType: p.sectionType, verticalAlignment: p.verticalAlignment,
    lineNumbers: p.lineNumbers,
    allowSpaceOfSameStyleInTable: p.allowSpaceOfSameStyleInTable, wrapTrailSpaces: p.wrapTrailSpaces, ulTrailSpace: p.ulTrailSpace, doNotExpandShiftReturn: p.doNotExpandShiftReturn, doNotUseHTMLParagraphAutoSpacing: p.doNotUseHTMLParagraphAutoSpacing,
    defaultTabStop: p.defaultTabStop, noTabHangInd: p.noTabHangInd, forgetLastTabAlignment: p.forgetLastTabAlignment,
    splitPgBreakAndParaMark: p.splitPgBreakAndParaMark, suppressSpBfAfterPgBrk: p.suppressSpBfAfterPgBrk,
    ...hyphenationGeometry(p),
    ...(bookFold ? { bookFold: p.bookFoldRevPrinting ? 'reverse' : 'forward', bookFoldReferenceMargins: { left: (p.left + p.gutter) / 15, right: p.right / 15 } } : {}),
    left: (p.left + (p.gutterAtTop || bookFold ? 0 : p.gutter)) / 15, right: (p.right + (bookFold ? p.gutter : 0)) / 15,
    top: (Math.abs(p.top) + (p.gutterAtTop ? p.gutter : 0)) / 15, bottom: Math.abs(p.bottom) / 15,
  };
}

/** Resolve reading-page margins; pgSz already describes the logical page. */
export function readingPageGeometry(page, index) {
  if (!page.bookFold && !page.mirror || page.storyKind || page.tableDepth) return page;
  // Mirrored margins put the inside margin (left, with the gutter) on the right of even pages.
  const swap = page.mirror ? index % 2 === 1 : index % 2 === (page.bookFold === 'reverse' ? 1 : 0);
  const { bookFold, mirror, ...resolved } = page;
  return { ...resolved, bookFoldSwapped: swap, ...(swap ? { left: page.right, right: page.left } : {}) };
}

/** Booklet body mirroring does not move saved margin anchors or page stories. */
export function referencePageGeometry(page) {
  return page.bookFoldReferenceMargins ? { ...page, ...page.bookFoldReferenceMargins, bookFold: undefined } : page;
}
