import { conditionalFontStyle } from '../core/style-values.js';
import { nativeSparklineAt, nativeSparklineData } from '../core/native-sparkline-data.js';
import { nativeSparklineNode } from './native-sparkline.js';
import { createSlicerControl } from './slicer.js';
import { createTimelineControl } from './timeline.js';
import { timelineState } from '../core/timeline.js';
import { slicerItems } from '../core/slicer.js';
import { createScrollControl } from './scroll-control.js';
import { scrollControlValue } from '../core/scroll-control.js';
import { conditionalIconNode } from './conditional-icon.js';
import { hasHeaderFormatting } from '../core/print-header.js';
import { richHeaderSections } from './print-header.js';
import { paintDataBar } from './data-bar.js';
import { createBorderResolver } from '../core/shared-borders.js';
import { clearRangeRecordsAtCells, intersection, forEachRangeRecordIn } from '../core/range-records.js';
import { GRID_RANGE } from '../core/style-resets.js';
import { normalIndentUnit, normalFontCss } from '../core/normal-font.js';
import { numberFormatParts, layoutFormatParts, rotatedFormatWidth } from '../core/format-layout.js';
import { formatLayoutNode } from './format-layout.js';
import { richTextMeasure, largestRichTextSize } from '../core/rich-text-font.js';
import { paginatePrintColumns, fitPrintTableScale, setPrintTitleAxes, setPrintBreakAxes, quantizePrintScale } from './print-pagination.js';
import { fontColorCss } from '../core/font-color.js';
import { normalizePrintSettings } from '../core/print-settings.js';
import { paintPrintBorders, setMergedPrintBorders } from './print-borders.js';
import { mergeBorderSegments } from '../core/merge-borders.js';
import { codeColor } from '../core/numfmt.js';
/**
 * Print the active sheet. The grid is virtualized and scroll-bound, so it
 * cannot be printed as is; instead the used range is rendered as a plain
 * table (values as displayed, with the text styles and borders the cell
 * carries), shown only under @media print, and handed to window.print().
 */
import { measureRows } from '../core/row-height.js';
import { pictureNode } from './picture.js';
import { pictureFrameCss, pictureStyled } from '../core/picture-format.js';
import { linkedPictureTarget, rangePicture, svgDataUrl } from '../core/range-picture.js';
import { cellPictureObjectPosition } from '../core/cell-picture.js';
import { chartSheetBounds } from '../core/chartsheet.js';

import { shrinkCellText } from '../core/shrink-text.js';
import { cellLayoutText, cellHorizontalPadding, CELL_TEXT_INSET } from '../core/textfit.js';
import { el } from './dom.js';
import { cellKey, parseKey, colName, normalizeRange } from '../core/cell.js';
import { formatValue, defaultAlign, fontStack, borderCss, getLocale } from '../core/format.js';
import { readsRightToLeft } from '../core/bidi.js';
import { isError } from '../core/formula/functions.js';
import { chartData, isImage, isTextBox, textBoxStyle, textBoxText } from '../core/charts.js';
import { smartArtSvg, smartArtAltText } from '../core/smartart.js';
import { smartArtLook, fallbackPicture } from './smartart.js';
import { equationBody } from './equation-view.js';
import { textBoxEffectCss } from '../core/theme-effects.js';
import { renderChartSvg, renderSparklineSvg, chartCornerRadius } from './chartsvg.js';
import { paintCellFill } from './cell-fill.js';
import { nativeFillOverridesNormal } from '../core/native-fill.js';

const printFormatLayouts = new WeakMap();

export const PRINT_DEFAULTS = {
  area: 'sheet', orientation: 'portrait', fit: 'width', scale: 100, paper: 'letter', margins: 'normal',
  gridlines: true, headers: false, repeatFrozen: true, title: true, header: '', footer: '',
};
// Each paper's CSS `size` value is a page-size keyword: the grammar lets a keyword take `landscape` after
// it, where two lengths cannot, so `11in 17in landscape` was an invalid declaration the browser dropped
// whole. CSS calls the 11 × 17 inch sheet `ledger`.
export const PAPER_SIZES = [['letter', 'Letter', 'letter'], ['a4', 'A4', 'A4'], ['legal', 'Legal', 'legal'], ['a3', 'A3', 'A3'], ['tabloid', 'Tabloid', 'ledger']];
export const MARGINS = [['narrow', 'Narrow', '6mm'], ['normal', 'Normal', '12mm'], ['wide', 'Wide', '20mm']];
const printLayouts = new WeakMap();
const HEADER_VARIANTS = ['evenHeader', 'evenFooter', 'firstHeader', 'firstFooter', 'differentFirst', 'differentOddEven', 'scaleWithDoc'];

// The papers and margins in CSS pixels (96 to the inch), so a table can be fitted to the page it prints on.
const IN = 96;
const MM = 96 / 25.4;
const PAPER_PX = { letter: [8.5 * IN, 11 * IN], a4: [210 * MM, 297 * MM], legal: [8.5 * IN, 14 * IN], a3: [297 * MM, 420 * MM], tabloid: [11 * IN, 17 * IN] };
const MARGIN_PX = { narrow: 6 * MM, normal: 12 * MM, wide: 20 * MM };

/** Imported settings take precedence over preferences saved for another workbook. */
export function sheetPrintPrefs(sheet) {
  const p = sheet?.printSettings;
  // A chart sheet is one page, with no cell scale, titles or headings.
  const chart = sheet?.kind === 'chart' ? { area: 'sheet', fit: 'pages', fitWidth: 1, fitHeight: 1,
    title: false, gridlines: false, headers: false, repeatFrozen: false, horizontalCentered: false, verticalCentered: false, titleRows: null, titleCols: null, native: true } : {};
  // Breaks belong to a sheet: preferences saved from another one never bring theirs along.
  if (!p) return { rowBreaks: [], colBreaks: [], alignWithMargins: true, firstPageNumber: 1, useFirstPageNumber: false, differentFirst: false, differentOddEven: false, firstHeader: '', firstFooter: '', evenHeader: '', evenFooter: '',
    ...(sheet?.kind === 'chart' ? { orientation: 'landscape', ...chart } : { titleRows: null, titleCols: null }) };
  return { area: p.areas.length ? 'printArea' : 'sheet', orientation: p.orientation,
    paper: ({ 1: 'letter', 2: 'letter', 3: 'tabloid', 5: 'legal', 8: 'a3', 9: 'a4', 10: 'a4' })[p.paperSize] || 'letter',
    pageOrder: p.pageOrder, fit: p.fitToPage ? 'pages' : p.scale === 100 ? 'actual' : 'scale', scale: p.scale, fitWidth: p.fitWidth, fitHeight: p.fitHeight,
    margins: 'custom', customMargins: { ...p.margins }, horizontalCentered: p.horizontalCentered, verticalCentered: p.verticalCentered,
    titleRows: p.titleRows || null, titleCols: p.titleCols || null,
    firstPageNumber: p.firstPageNumber, useFirstPageNumber: p.useFirstPageNumber, alignWithMargins: p.alignWithMargins !== false,
    gridlines: p.gridlines, headers: p.headings, title: p.title ?? false, repeatFrozen: p.repeatFrozen ?? false, header: p.header || '', footer: p.footer || '',
    rowBreaks: p.rowBreaks || [], colBreaks: p.colBreaks || [],
    ...Object.fromEntries(HEADER_VARIANTS.map(key => [key, p[key]])), native: true, ...chart };
}

export function printSettingsFromPrefs(sheet, prefs) {
  const original = sheet.printSettings || {};
  return { ...original, titleRows: prefs.titleRows, titleCols: prefs.titleCols, orientation: prefs.orientation,
    paperSize: sheet.printSettings && prefs.paper === sheetPrintPrefs(sheet).paper ? original.paperSize : ({ letter: 1, tabloid: 3, legal: 5, a3: 8, a4: 9 })[prefs.paper] || original.paperSize,
    scale: prefs.fit === 'actual' ? 100 : prefs.scale, fitToPage: ['width', 'pages'].includes(prefs.fit),
    fitWidth: prefs.fit === 'width' ? 1 : prefs.fitWidth, fitHeight: prefs.fit === 'width' ? 0 : prefs.fitHeight,
    margins: { ...original.margins, ...Object.fromEntries(Object.entries(pageMargins(prefs)).map(([k, v]) => [k, prefs.margins === 'custom' && Number.isFinite(prefs.customMargins?.[k]) ? prefs.customMargins[k] : +(v / IN).toFixed(8)])) },
    gridlines: prefs.gridlines, headings: prefs.headers,
    horizontalCentered: prefs.horizontalCentered, verticalCentered: prefs.verticalCentered,
    ...(prefs.title !== (original.title ?? false) ? { title: prefs.title } : {}),
    ...(prefs.repeatFrozen !== (original.repeatFrozen ?? false) ? { repeatFrozen: prefs.repeatFrozen } : {}),
    ...(prefs.header !== (original.header || '') ? { header: prefs.header } : {}),
    ...(prefs.footer !== (original.footer || '') ? { footer: prefs.footer } : {}),
    ...Object.fromEntries(HEADER_VARIANTS.filter(key => prefs[key] !== undefined).map(key => [key, prefs[key]])) };
}

/** Page variants follow physical page order across the whole print job.
 * FIRST/EVEN/ODD order holds even when printed page numbers start at 4.
 * Missing first/even text is deliberately blank, never inherited from odd. */
export function printPageText(settings, pageIndex) {
  const prefix = settings.differentFirst && pageIndex === 0 ? 'first'
    : settings.differentOddEven && pageIndex % 2 === 1 ? 'even' : '';
  return prefix ? { header: settings[`${prefix}Header`] || '', footer: settings[`${prefix}Footer`] || '' }
    : { header: settings.header || '', footer: settings.footer || '' };
}

function pageMargins(opts) {
  const fallback = MARGIN_PX[opts.margins] ?? MARGIN_PX[PRINT_DEFAULTS.margins];
  return Object.fromEntries(['top', 'right', 'bottom', 'left'].map(k => {
    const v = opts.customMargins?.[k];
    return [k, opts.margins === 'custom' && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v * IN : fallback];
  }));
}

/** The paper as oriented and its margins, in CSS pixels: { width, height, margins: { top, right, bottom, left } }. */
export function printPaperBox(opts = {}) {
  const paper = PAPER_PX[opts.paper] || PAPER_PX[PRINT_DEFAULTS.paper];
  const [width, height] = opts.orientation === 'landscape' ? [paper[1], paper[0]] : paper;
  return { width, height, margins: pageMargins(opts) };
}

export function printableHeight(opts = {}) {
  const paper = PAPER_PX[opts.paper] || PAPER_PX[PRINT_DEFAULTS.paper], margin = pageMargins(opts);
  return Math.max(1, (opts.orientation === 'landscape' ? paper[0] : paper[1]) - margin.top - margin.bottom);
}

/** The width in CSS pixels the page's content box offers: the paper's width across, less both margins (Letter, portrait, normal margins: about 725). */
export function printableWidth(opts = {}) {
  const paper = PAPER_PX[opts.paper] || PAPER_PX[PRINT_DEFAULTS.paper];
  const margin = pageMargins(opts);
  return Math.max(1, (opts.orientation === 'landscape' ? paper[1] : paper[0]) - margin.left - margin.right);
}

const HEADER_W = 34;
const HEADER_H = 20; // the column-letters row, set explicitly so objects can be placed below it

/**
 * Header and footer text uses the tokens Excel writes: &[Page], &[Pages],
 * &[Date], &[Time], &[Tab] (the sheet name), and &[File] (the document
 * name), or their short forms &P &N &D &T &A &F. &L, &C, and &R start the
 * left, center, and right sections; text before any section code is
 * centered. && is a literal ampersand.
 */
const TOKEN_RE = /&&|&\[([Pp]age|[Pp]ages|PAGE|PAGES|[Dd]ate|DATE|[Tt]ime|TIME|[Tt]ab|TAB|[Ff]ile|FILE)\]|&([PNDTAF])(?![a-z])/g;
const SHORT_TOKENS = { P: 'Page', N: 'Pages', D: 'Date', T: 'Time', A: 'Tab', F: 'File' };
const SECTION_RE = /&&|&([LCR])/g;

/** The text as a list of { text } and { token } parts, in order. */
export function printTextParts(text) {
  const parts = [];
  const src = String(text || '');
  const pushText = (t) => {
    if (!t) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.text != null) prev.text += t; else parts.push({ text: t });
  };
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    pushText(src.slice(last, m.index));
    if (m[0] === '&&') pushText('&');
    else parts.push({ token: m[1] ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : SHORT_TOKENS[m[2]] });
    last = m.index + m[0].length;
  }
  pushText(src.slice(last));
  return parts;
}

/** { left, center, right } from &L &C &R section codes (no code: everything is centered). */
export function splitPrintSections(text) {
  const out = { left: '', center: '', right: '' };
  const src = String(text || '');
  let side = 'center';
  let last = 0;
  for (const m of src.matchAll(SECTION_RE)) {
    if (!m[1]) continue; // && stays in the text for the token pass to read as one ampersand
    out[side] += src.slice(last, m.index);
    side = { L: 'left', C: 'center', R: 'right' }[m[1]];
    last = m.index + m[0].length;
  }
  out[side] += src.slice(last);
  return out;
}

function tokenText(token, info) {
  const now = info.now || new Date();
  switch (token) {
    // In the app's regional format, as the cells are, not the browser's.
    case 'Date': return now.toLocaleDateString(getLocale());
    case 'Time': return now.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
    case 'Tab': return info.tab || '';
    case 'File': return info.file || '';
    case 'Page': return info.page != null ? String(info.page) : '';
    case 'Pages': return info.pages != null ? String(info.pages) : '';
    default: return '';
  }
}

const NO_PAGE = '\0';
// "Page", "p." or a joining "of" / "/" / dash around a page number that cannot be shown.
const PAGE_PHRASE_RE = /(?:\s*(?:of|\/|[-–—]))?\s*(?:\bpage|\bp\.|\bpg\.?)?\s*\0(?:\s*(?:of|\/|[-–—])\s*\0)*/gi;

/**
 * The text with every token filled in from `info` ({ file, tab, now, page,
 * pages }). Page tokens with no number to show disappear along with the
 * words that framed them, so "Page &P of &N" does not print as "Page of".
 */
export function expandPrintText(text, info = {}) {
  const missing = (p) => (p.token === 'Page' && info.page == null) || (p.token === 'Pages' && info.pages == null);
  let out = printTextParts(text).map((p) => (p.token ? (missing(p) ? NO_PAGE : tokenText(p.token, info)) : p.text)).join('');
  if (out.includes(NO_PAGE)) out = out.replace(PAGE_PHRASE_RE, '').replace(/\s*[,;:]\s*$/, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

const cssString = (t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;

/**
 * A CSS `content` value for a page margin box: the text as strings, with
 * page numbers as counter(page) and counter(pages) so every page shows its
 * own. Empty text gives null.
 */
export function marginBoxContent(text, info = {}) {
  const parts = printTextParts(text).map((p) => {
    if (!p.token) return p.text ? cssString(p.text) : '';
    if (p.token === 'Page') return info.page != null ? cssString(String(info.page)) : 'counter(page)';
    if (p.token === 'Pages') return 'counter(pages)';
    const t = tokenText(p.token, info);
    return t ? cssString(t) : '';
  }).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

const MARGIN_BOX_STYLE = 'font: 9pt -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #555; white-space: nowrap;';

/**
 * A named @page rule whose margin boxes carry the header and footer
 * sections (top-left/center/right, bottom-left/center/right). Sections
 * apply to every page a `.print-section` with `page: <name>` produces.
 */
export function pageMarginCss(name, header, footer, info = {}, opts = {}) {
  if (opts.richHeaderText) return `@page ${name} { }`;
  const margins = opts.alignWithMargins === false ? pageMargins(opts) : null;
  const boxes = [];
  const h = splitPrintSections(header);
  const f = splitPrintSections(footer);
  for (const [pos, text] of [['top-left', h.left], ['top-center', h.center], ['top-right', h.right], ['bottom-left', f.left], ['bottom-center', f.center], ['bottom-right', f.right]]) {
    const content = marginBoxContent(text, info);
    // Negative horizontal margins extend the margin boxes to the paper edges.
    // Applying both to the center box keeps it centered with asymmetric margins.
    // Keep its intrinsic width: auto sizing can collapse under negative margins.
    const align = margins ? `${pos.endsWith('center') ? 'width: max-content;' : ''} ${!pos.endsWith('right') ? `margin-left: ${-margins.left}px;` : ''} ${!pos.endsWith('left') ? `margin-right: ${-margins.right}px;` : ''}` : '';
    if (content) boxes.push(`@${pos} { content: ${content}; ${MARGIN_BOX_STYLE} ${align} }`);
  }
  return `@page ${name} { ${boxes.join(' ')} }`;
}

/**
 * An in-flow header or footer as spans: one holding the text (or `fallback`)
 * when it has no section code, else its &L, &C and &R parts laid out left,
 * center and right across the line.
 */
function sectionSpans(text, info, tag, fallback = '') {
  const s = splitPrintSections(text);
  const [left, center, right] = [s.left, s.center, s.right].map((t) => expandPrintText(t, info));
  if (!left && !right) return [el(tag, {}, center || fallback)];
  const part = (t, textAlign) => el(tag, { style: { flex: '1 1 0', textAlign } }, t);
  return [part(left, 'left'), part(center, 'center'), part(right, 'right')];
}

function flowTextAlignment(opts) {
  if (opts.alignWithMargins !== false) return {};
  const margins = pageMargins(opts);
  return { marginLeft: `${-margins.left}px`, marginRight: `${-margins.right}px`,
    width: `calc(100% + ${margins.left + margins.right}px)` };
}

/** Rich runs occupy the physical margins of each explicit page fragment. */
function richPageFurniture(section, text, info, opts, scale = 1, framed = false) {
  const margins = pageMargins(opts), edge = opts.alignWithMargins === false;
  section.style.position = 'relative';
  if (framed) Object.assign(section.style, { boxSizing: 'border-box', paddingTop: `${margins.top}px`,
    height: `${printableHeight(opts) + margins.top + margins.bottom}px` });
  for (const kind of ['header', 'footer']) {
    if (!text[kind]) continue;
    const distance = opts.customMargins?.[kind] ?? .3;
    const top = (framed ? margins.top : 0) + (kind === 'header' ? -margins.top + distance * IN
      : printableHeight(opts) + margins.bottom - distance * IN);
    const node = el('div.print-margin-text', { style: { position: 'absolute', top: `${top}px`,
      left: `${edge ? -margins.left : 0}px`, width: `${printableWidth(opts) + (edge ? margins.left + margins.right : 0)}px`, height: '0' } },
      ...richHeaderSections(text[kind], info, opts.scaleWithDoc === false ? 1 : scale));
    if (kind === 'footer') for (const child of node.children) child.style.transform = 'translateY(-100%)';
    section.append(node);
  }
}

function flowPageText(kind, text, info, opts = {}) {
  return text ? el(kind === 'header' ? 'div.print-page-header' : 'div.print-foot',
    { style: { display: 'flex', justifyContent: 'center', ...flowTextAlignment(opts) } }, ...sectionSpans(text, info, 'span')) : null;
}

function outerHeight(node) {
  const css = getComputedStyle(node);
  return node.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
}

/** Browsers without margin boxes put headers in the content flow. Reserve a
 * common body frame large enough for every active variant: a blank first-page
 * footer must not let later, taller text overflow its already-paginated body. */
function flowVariantSpace(root, layout) {
  if (layout.marginBoxes || layout.opts.richHeaderText || !(layout.opts.differentFirst || layout.opts.differentOddEven)) return 0;
  const settings = { ...layout.opts, ...layout.regularText };
  const texts = [0, 1, 2].map(i => printPageText(settings, i));
  const probe = el('div', { style: { position: 'absolute', width: `${printableWidth(layout.opts)}px` } });
  root.append(probe);
  try {
    return ['header', 'footer'].reduce((extra, kind) => {
      const heights = texts.map(text => {
        const node = flowPageText(kind, text[kind], layout.info, layout.opts);
        probe.replaceChildren(...(node ? [node] : []));
        return node ? outerHeight(node) : 0;
      });
      return extra + Math.max(...heights) - heights[0];
    }, 0);
  } finally { probe.remove(); }
}

let marginBoxSupport = null;
/**
 * Whether this browser lays out @page margin boxes (Chrome 131+). Without
 * them the header and footer print once per sheet, in the flow, and page
 * numbers are left out.
 */
export function supportsPageMarginBoxes() {
  if (marginBoxSupport != null) return marginBoxSupport;
  try {
    const style = document.createElement('style');
    style.textContent = '@page { @top-center { content: "x"; } }';
    document.head.append(style);
    const rule = style.sheet?.cssRules?.[0];
    marginBoxSupport = !!(rule && rule.cssRules && rule.cssRules.length > 0);
    style.remove();
  } catch { marginBoxSupport = false; }
  return marginBoxSupport;
}

/**
 * The tick box a cell under a checkbox rule prints, as the grid draws it: a rounded square, filled and
 * ticked when the cell is TRUE. Drawn in the SVG itself rather than from a class, so it needs nothing of
 * the print stylesheet, and in the theme's own colours, which print white-paper light.
 */
function checkboxSvg(on, excel = false) {
  if (excel) return '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" role="img"'
    + ` aria-label="${on ? 'Checked' : 'Unchecked'}" style="vertical-align: middle; forced-color-adjust: none">`
    + '<rect x="0.5" y="0.5" width="12" height="12" fill="#fff" stroke="#000"/>'
    + (on ? '<path d="M2 6 5 9 11 3" fill="none" stroke="#000" stroke-width="1.5"/>' : '') + '</svg>';
  const box = on
    ? '<rect x="1" y="1" width="13" height="13" rx="3.5" fill="var(--accent)" stroke="var(--accent)" stroke-width="1.5"/>'
      + '<path d="M4 7.6 6.7 10.3 11.3 4.9" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<rect x="1" y="1" width="13" height="13" rx="3.5" fill="var(--surface)" stroke="var(--ink-3)" stroke-width="1.5"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" role="img" aria-label="${on ? 'Checked' : 'Unchecked'}" style="vertical-align: middle; forced-color-adjust: none">${box}</svg>`;
}

/** Whether a style paints on paper with no value in the cell: a fill or a border edge. Bold or a number format on a blank cell shows nothing. */
const paints = (s) => !!s && !!(s.bg || s.bt || s.bb || s.bl || s.br);
/** Finite cells may override whole-line paint. Repeated copies of that line's
 * paint add no printable extent; a different fill or border does. */
function addsPrintPaint(style, line) {
  if (style?.bg && JSON.stringify(style.bg) !== JSON.stringify(line?.bg)) return true;
  return ['bt', 'bb', 'bl', 'br'].some(side => style?.[side] && (!line?.[side]
    || JSON.stringify(borderCss(style[`${side}Border`] || style)) !== JSON.stringify(borderCss(line[`${side}Border`] || line))));
}

// A cell bordered on a horizontal and a vertical side at once: a corner of a drawn box, as Borders → All
// and an outline give every cell they touch. A lone rule (an underline under a header, one side down a
// column) is not, so it cannot stretch the block by itself.
const boxed = (s) => !!s && !!((s.bt || s.bb) && (s.bl || s.br));

/** Paint regions that can contribute to the finite printed block. Border
 * snapshots combine overlapping properties before testing for boxed corners. */
function sparsePrintPaint(wb, sheetId, sheet) {
  const area = { r1: 0, c1: 0, r2: sheet.rows - 1, c2: sheet.cols - 1 };
  const finite = (sheet.styleResets || []).filter(({ range: g, values }) => paints(values)
    && !(g.r1 === GRID_RANGE.r1 && g.r2 === GRID_RANGE.r2)
    && !(g.c1 === GRID_RANGE.c1 && g.c2 === GRID_RANGE.c2));
  const regions = [];
  for (const record of wb.inheritedBorderRegions(sheetId, area)) {
    if (boxed(record.values)) regions.push(record);
    else forEachRangeRecordIn(finite, record.range, source => {
      const range = intersection(record.range, source.range);
      if (range) regions.push({ ...record, range });
    });
  }
  for (const record of finite) if (record.values.bg) {
    const range = intersection(record.range, area);
    if (range) regions.push({ ...record, range });
  }
  return regions;
}

/**
 * The block the whole sheet prints: from the first to the last cell holding a value, a formula or a
 * paint (a fill or border, as a blank form or an invoice template is drawn), spilled results included,
 * formatted cells counting as used. A paint that runs to the sheet's last row or column is a
 * whole-column or whole-row format, as the file stores one, and does not stretch the block: a column
 * filled yellow, or a header row underlined edge to edge, prints as far as the data does. A format the
 * workbook keeps on the line itself (colStyles/rowStyles, where a whole-column or whole-row selection
 * puts it) says the same thing outright, for the cells it materialised beside the data as much as for
 * the lines it never reached. A boxed cell counts wherever it is, since a box is drawn to be printed: a
 * form made by bordering the whole sheet prints whole. Tables also define a finite printable area:
 * their blank body and total rows can carry table paint without any stored cell styles.
 * Null for a sheet with nothing to print.
 */
function printBounds(wb, sheetId, sheet) {
  const used = wb.usedRange(sheetId); // values, formulas and the spills of their arrays
  const box = { r1: Infinity, c1: Infinity, r2: used?.r2 ?? -1, c2: used?.c2 ?? -1 };
  const grow = (r, c) => { if (r < box.r1) box.r1 = r; if (c < box.c1) box.c1 = c; if (r > box.r2) box.r2 = r; if (c > box.c2) box.c2 = c; };
  const painted = [], ownPaint = [];
  const inherited = !!(wb.defaultStyle(sheet) || sheet.colStyles.size || sheet.rowStyles.size || sheet.styleResets.length);
  const columnFormats = new Map();
  const rowFormats = new Map();
  for (const [key, cell] of sheet.cells) {
    const content = cell.v != null || cell.f != null;
    const { r, c } = parseKey(key);
    if (content) { grow(r, c); ownPaint.push({ r, c }); continue; }
    const own = cell.s && ['bg', 'bt', 'bb', 'bl', 'br', 'bc', 'bs', 'btBorder', 'bbBorder', 'blBorder', 'brBorder'].some(k => Object.hasOwn(cell.s, k));
    if (own) ownPaint.push({ r, c });
    const style = inherited && own ? wb.styleAt(sheetId, r, c) : cell.s;
    if (boxed(style)) { grow(r, c); continue; }
    if (!paints(style)) continue;
    // A line format must not suppress unrelated finite paint on that line.
    // Native files can also materialize the inherited paint on blank cells.
    if ((sheet.colStyles.has(c) || sheet.rowStyles.has(r)) && !addsPrintPaint(style,
      { ...wb.defaultStyle(sheet), ...sheet.colStyles.get(c), ...sheet.rowStyles.get(r) })) continue;
    if (r === sheet.rows - 1) columnFormats.set(c, style);
    if (c === sheet.cols - 1) rowFormats.set(r, style);
    painted.push({ r, c, style });
  }
  // Apply the same bounds rules to sparse regions and stored blank cells.
  // Boxed line formats reach the allocated grid; simple full-line rules do
  // not stretch the printed block. Own masks remove their inherited paint.
  const regions = inherited ? clearRangeRecordsAtCells(sparsePrintPaint(wb, sheetId, sheet), ownPaint) : [];
  for (const { range: g, values } of regions) {
    if (boxed(values)) { grow(g.r1, g.c1); grow(g.r2, g.c2); continue; }
    if (g.r2 === sheet.rows - 1) for (let c = g.c1; c <= g.c2; c++) columnFormats.set(c, wb.styleAt(sheetId, g.r2, c));
    if (g.c2 === sheet.cols - 1) for (let r = g.r1; r <= g.r2; r++) rowFormats.set(r, wb.styleAt(sheetId, r, g.c2));
  }
  for (const { r, c, style } of painted) if ((!columnFormats.has(c) || addsPrintPaint(style, columnFormats.get(c)))
    && (!rowFormats.has(r) || addsPrintPaint(style, rowFormats.get(r)))) grow(r, c);
  for (const { range: g, values } of regions) {
    if (boxed(values)) continue;
    let { r1, r2, c1, c2 } = g;
    while (r1 <= r2 && rowFormats.has(r1) && !addsPrintPaint(values, rowFormats.get(r1))) r1++;
    while (r2 >= r1 && rowFormats.has(r2) && !addsPrintPaint(values, rowFormats.get(r2))) r2--;
    while (c1 <= c2 && columnFormats.has(c1) && !addsPrintPaint(values, columnFormats.get(c1))) c1++;
    while (c2 >= c1 && columnFormats.has(c2) && !addsPrintPaint(values, columnFormats.get(c2))) c2--;
    if (r1 <= r2 && c1 <= c2) { grow(r1, c1); grow(r2, c2); }
  }
  for (const table of sheet.tables || []) {
    grow(table.range.r1, table.range.c1);
    grow(table.range.r2, table.range.c2);
  }
  return box.r1 === Infinity ? null : box;
}

/** Whole-sheet print bounds include visible text beyond the stored-cell area.
 * Explicit print areas/selections remain hard boundaries. Measure the same
 * formatted runs and padding as the cell renderer, without changing the model. */
function printTextBounds(wb, sheetId, sheet, bounds) {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return bounds;
  const box = { ...bounds }, spills = wb._ensureSpills(sheet);
  const keys = new Set(sheet.cells.keys());
  for (const key of spills.cover.keys()) keys.add(key);
  for (const key of spills.fixed.cells(bounds)) keys.add(key);
  const widths = new Map();
  const textWidth = (text, font) => {
    const key = `${font}\0${text}`;
    if (!widths.has(key)) { ctx.font = font; widths.set(key, ctx.measureText(text).width); }
    return widths.get(key);
  };
  let indentUnit;
  const empty = (r, c) => {
    const cell = sheet.cells.get(cellKey(r, c));
    return (cell?.v == null && cell?.f == null) && !wb.spillAt(sheetId, r, c)
      && !wb.mergeAt(sheetId, r, c) && wb.validationAt(sheetId, r, c)?.type !== 'checkbox';
  };
  for (const key of keys) {
    const { r, c } = parseKey(key);
    if (r < bounds.r1 || r > bounds.r2 || c < bounds.c1 || c > bounds.c2
      || wb.isRowHidden(sheetId, r) || sheet.hiddenCols.has(c) || wb.mergeAt(sheetId, r, c)) continue;
    const cell = sheet.cells.get(key), spill = wb.spillAt(sheetId, r, c);
    const value = spill ? spill.value : wb.getValue(sheetId, r, c);
    if (typeof value !== 'string' || !value || wb.validationAt(sheetId, r, c)?.type === 'checkbox') continue;
    let st = spill ? wb._pivotDisplayStyle(sheetId, r, c, { ...wb._lineStyle(sheet, r, c), ...spill.style, ...cell?.s }) : wb.displayStyleAt(sheetId, r, c) || {};
    if (st.wrap || st.clip || st.rot || st.shrink) continue;
    const cf = wb.conditionalStyle(sheetId, r, c, value);
    st = conditionalFontStyle(st, cf);
    if (cf?.barOnly || cf?.iconOnly) continue;
    const text = cellLayoutText(formatValue(value, st), false);
    const align = st.align || (readsRightToLeft(text) ? 'right' : defaultAlign(value));
    const font = `${st.italic ? 'italic ' : ''}${st.bold ? '600 ' : ''}${st.size || 9.5 * 4 / 3}px ${fontStack(st.font) || 'system-ui, sans-serif'}`;
    const measure = richTextMeasure(font, textWidth);
    const indent = st.indent && align !== 'center' ? st.indent * (indentUnit ??= normalIndentUnit(wb.normalFont, textWidth)) : 0;
    const padding = cellHorizontalPadding(indent) + 1;
    const iconWidth = cf?.iconImage ? 20 : cf?.icon ? measure(cf.icon + ' ') : 0;
    const own = wb.colWidth(sheetId, c), parts = numberFormatParts(value, st, cell?.richText);
    const layout = parts && layoutFormatParts(parts, own - padding - iconWidth, measure);
    if (layout?.requiresFit) continue;
    const excess = (layout ? layout.width : measure(text)) + padding + iconWidth - own;
    if (!(excess > 0) || !Number.isFinite(excess)) continue;
    const reach = (dir, want) => {
      let width = 0;
      for (let col = c + dir; col >= 0 && col < sheet.cols && width < want; col += dir) {
        if (sheet.hiddenCols.has(col)) continue;
        if (!empty(r, col)) break;
        width += wb.colWidth(sheetId, col);
        box.c1 = Math.min(box.c1, col); box.c2 = Math.max(box.c2, col);
      }
    };
    if (align !== 'left') reach(-1, align === 'center' ? excess / 2 : excess);
    if (align !== 'right') reach(1, align === 'center' ? excess / 2 : excess);
  }
  return box;
}

/** The cells a floating object's box covers, from its anchor cell to the row and column its far edges land in. */
function objectExtent(wb, sheetId, sheet, obj) {
  const r1 = Math.min(sheet.rows - 1, Math.max(0, obj.anchor.r | 0));
  const c1 = Math.min(sheet.cols - 1, Math.max(0, obj.anchor.c | 0));
  let r2 = r1;
  let c2 = c1;
  for (let y = wb.rowHeight(sheetId, r2) - (obj.dy || 0); y < (obj.h || 1) && r2 < sheet.rows - 1;) y += wb.rowHeight(sheetId, ++r2);
  for (let x = wb.colWidth(sheetId, c2) - (obj.dx || 0); x < (obj.w || 1) && c2 < sheet.cols - 1;) x += wb.colWidth(sheetId, ++c2);
  return { r1, c1, r2, c2 };
}

/**
 * The cells to print: the given range as it is; for the whole sheet, from
 * the first used or painted cell to the last, widened
 * over merged titles and over every chart, image and text box so an object
 * beside or below the data prints where it sits. Kept inside the sheet.
 */
function printRange(wb, sheetId, opts) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return null;
  let range = null;
  if (opts.range) range = normalizeRange(opts.range);
  else {
    range = printBounds(wb, sheetId, sheet);
    for (const obj of sheet.charts || []) {
      if (!obj.anchor || obj.print === false || obj.hidden) continue;
      const box = objectExtent(wb, sheetId, sheet, obj);
      range = range ? { r1: Math.min(range.r1, box.r1), c1: Math.min(range.c1, box.c1), r2: Math.max(range.r2, box.r2), c2: Math.max(range.c2, box.c2) } : box;
    }
    if (!range) return null;
    range = printTextBounds(wb, sheetId, sheet, wb.expandToMerges(sheetId, range));
  }
  return { r1: Math.max(0, range.r1), c1: Math.max(0, range.c1), r2: Math.min(sheet.rows - 1, range.r2), c2: Math.min(sheet.cols - 1, range.c2) };
}

/** The members of an ascending list within [lo, hi], found by bisection. */
function between(sorted, lo, hi) {
  let a = 0;
  let b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] < lo) a = m + 1; else b = m; }
  let c = a;
  let d = sorted.length;
  while (c < d) { const m = (c + d) >> 1; if (sorted[m] <= hi) c = m + 1; else d = m; }
  return sorted.slice(a, c);
}

/**
 * The cells of the printed rows and columns (both ascending) that merges cover, keyed by cell: null for a
 * cell a span covers, { rowSpan, colSpan, from } for the cell that carries the span. `from` is the merge
 * whose top-left cell the span shows, or null for a span that shows nothing. A span that would cross from
 * the repeating head (the first `repeat` rows) into the body is cut in two, since an HTML row span
 * cannot; only the upper part shows the value. A merge whose own top-left cell lies before `bounds`, the
 * printed block, shows nothing either: a print selection that starts inside a merge leaves its title out,
 * while a merge the block holds shows that cell wherever it is, since the first row or column of the
 * merge may be hidden or filtered out with the grid still showing the block. A merge overlapping one
 * already placed is left out. Bisection keeps a sheet of thousands of merges from walking every printed
 * row for each of them. Exported for tests.
 */
const printMergeSources = new WeakMap();
export function printMergeSpans(rows, cols, merges, repeat, bounds = null) {
  const inHead = (r) => r < repeat;
  const held = (merge) => !bounds || (merge.r1 >= bounds.r1 && merge.c1 >= bounds.c1 &&
    (!bounds.rowGap || merge.r1 < bounds.rowGap[0] || merge.r1 > bounds.rowGap[1]) &&
    (!bounds.colGap || merge.c1 < bounds.colGap[0] || merge.c1 > bounds.colGap[1]));
  const splitGap = (lines, gap) => gap ? [lines.filter(n => n < gap[0]), lines.filter(n => n > gap[1])].filter(a => a.length) : [lines];
  const merged = new Map();
  for (const merge of merges) {
    const mr = between(rows, merge.r1, merge.r2);
    const mc = between(cols, merge.c1, merge.c2);
    if (!mr.length || !mc.length || mr.some((r) => mc.some((c) => merged.has(cellKey(r, c))))) continue;
    let first = true;
    for (const rows of [mr.filter(inHead), mr.filter((r) => !inHead(r))]) for (const group of splitGap(rows, bounds?.rowGap)) {
      if (!group.length) continue;
      for (const columns of splitGap(mc, bounds?.colGap)) {
        for (const r of group) for (const c of columns) merged.set(cellKey(r, c), null);
        const span = { rowSpan: group.length, colSpan: columns.length, from: first && held(merge) ? merge : null };
        // Continuations omit the value but retain their own perimeter styles.
        printMergeSources.set(span, merge);
        merged.set(cellKey(group[0], columns[0]), span);
        first = false;
      }
    }
  }
  return merged;
}

/**
 * How the table sits on the page: its visible columns and their total width, whether it keeps pixel
 * widths (else it stretches to the page, its columns percentages of it) and the zoom on the whole.
 * Fit to page width stretches a table narrower than the page and zooms a wider one down to it, so its
 * text shrinks with its columns as a scaled page does, rather than every column drawn at a
 * fraction of its width at full size and each value cut with an ellipsis where it no longer fits.
 */
// Include title lines preceding the print area without materializing the gap.
// Titles after the area do not enlarge it. All indices remain in sheet order.
function printLines(first, last, title, hidden) {
  const lines = [];
  if (title && title[0] < first) for (let i = title[0]; i <= Math.min(title[1], first - 1); i++) if (!hidden(i)) lines.push(i);
  for (let i = first; i <= last; i++) if (!hidden(i)) lines.push(i);
  return lines;
}
function titleAxis(lines, first, title, heading = 0) {
  const start = lines.findIndex(i => i >= first);
  const selected = title ? lines.map((n, i) => n >= title[0] && n <= title[1] ? i : -1).filter(i => i >= 0) : [];
  return { bodyStart: (start < 0 ? lines.length : start) + heading, heading,
    repeat: selected.length ? [selected[0] + heading, selected.at(-1) + 1 + heading] : null };
}

function printLayout(wb, sheetId, sheet, used, opts) {
  const cols = printLines(used.c1 ?? 0, used.c2, opts.titleCols, c => sheet.hiddenCols.has(c));
  const totalW = cols.reduce((a, c) => a + wb.colWidth(sheetId, c), 0) + (opts.headers ? HEADER_W : 0) || 1;
  if (opts.fit === 'actual') return { cols, totalW, pixel: true, zoom: null };
  // A percentage of actual size: pixel widths, then the whole table zoomed.
  if (opts.fit === 'scale') return { cols, totalW, pixel: true, zoom: Math.min(4, Math.max(0.1, (Number(opts.scale) || 100) / 100)) };
  if (opts.fit === 'pages') {
    let height = opts.headers ? HEADER_H : 0;
    for (const r of printLines(used.r1, used.r2, opts.titleRows, r => wb.isRowHidden(sheetId, r))) height += wb.rowHeight(sheetId, r);
    const widthPages = Math.max(0, opts.fitWidth ?? 1), heightPages = Math.max(0, opts.fitHeight ?? 1);
    // Fit mode only shrinks; it never stretches narrow columns independently of text.
    const zoom = Math.min(1, widthPages ? printableWidth(opts) * widthPages / totalW : 1, heightPages ? printableHeight(opts) * heightPages / Math.max(1, height) : 1);
    return { cols, totalW, pixel: true, zoom: quantizePrintScale(zoom) };
  }
  const page = printableWidth(opts);
  if (totalW <= page) return { cols, totalW, pixel: false, zoom: null };
  // Use a whole-percentage fitting scale for text, cells and objects.
  return { cols, totalW, pixel: true, zoom: quantizePrintScale(page / totalW) };
}

/**
 * Which manual page breaks a print honours on each axis: all of them, except on an axis the page setup
 * fits to a number of pages, where the fit decides the pages (and Fit to page width fits the columns).
 */
export function manualBreaksApply(opts) {
  const fitted = opts.fit === 'pages';
  return { rows: !(fitted && Number(opts.fitHeight) > 0), cols: opts.fit !== 'width' && !(fitted && Number(opts.fitWidth) > 0) };
}

/**
 * The manual breaks as the print table's own line indices: a break before a hidden line starts its page
 * at the next line printed, one before the printed block (or at its first line) starts nothing, and
 * `heading` counts the row-number column or column-letter row the table puts first.
 */
export function printBreakAxes(rows, cols, used, opts, heading) {
  const apply = manualBreaksApply(opts);
  const axis = (lines, breaks, first) => {
    const set = new Set();
    if (!breaks?.length) return set;
    const body = lines.findIndex(n => n >= first);
    for (const at of breaks) {
      const i = lines.findIndex(n => n >= at);
      if (i > body && body >= 0) set.add(i + heading);
    }
    return set;
  };
  const r = apply.rows ? axis(rows, opts.rowBreaks, used.r1) : new Set(), c = apply.cols ? axis(cols, opts.colBreaks, used.c1 ?? 0) : new Set();
  return r.size || c.size ? { rows: r, cols: c } : null;
}

function constrainPrintCell(cell) {
  cell.classList.add('constrained');
  if (!cell.firstChild) return cell;
  // Table row heights are minima: text, wrapping and pictures otherwise expand
  // them, separating objects from their sheet anchors. The cell's content is
  // laid out inside its final box without contributing an intrinsic row height.
  // Keep the table cell itself unpositioned: Chromium's paged renderer drops
  // collapsed borders on cells that establish a positioning context. An inner
  // percentage-height box supplies that context without changing row geometry.
  // Overflow labels already have a width-limited span; reuse it as the box.
  const spill = cell.classList.contains('spill');
  const content = spill ? cell.firstElementChild : el('div');
  content.classList.add('print-cell');
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const key = `padding${side}`;
    if (cell.style[key]) content.style[key] = cell.style[key];
  }
  if (cell.style.padding) cell.style.padding = '0';
  else for (const side of ['Top', 'Right', 'Bottom', 'Left']) cell.style.removeProperty(`padding-${side.toLowerCase()}`);
  const vertical = cell.style.verticalAlign;
  if (vertical === 'top' || vertical === 'bottom') content.style.alignContent = vertical === 'top' ? 'start' : 'unsafe end';
  if (!spill) {
    content.append(...cell.childNodes);
  }
  cell.append(el('div.print-cell-box', {}, content));
  return cell;
}

/**
 * Build the printable table for one sheet. Exported for tests.
 * opts: { range, gridlines, headers, repeatRows, fit, scale, paper, orientation, margins }
 *   range        cells to print (default: from the first used cell to the last, over merges and objects)
 *   gridlines    light borders between cells (default true)
 *   headers      row numbers and column letters (default false)
 *   repeatRows   how many of the sheet's first rows (its frozen rows) go in <thead>, repeating on every page
 *   fit          'width' stretches to the page, or zooms a wider table down to it; 'actual' keeps pixel
 *                widths; 'scale' keeps pixel widths zoomed to `scale` percent
 *   paper, orientation, margins   the page fit to (PRINT_DEFAULTS when left out)
 */
export function buildPrintTable(wb, sheetId, opts = {}) {
  const sheet = wb.sheet(sheetId);
  const used = printRange(wb, sheetId, opts);
  const table = el('table.print-table');
  if (!sheet || !used) return table;
  // Printing can include sheets never opened in the grid. Refresh their
  // automatic caches from the same layout measurements before pagination.
  const automaticRows = new Set([...sheet.rowHeightModes].filter(([r, mode]) => mode === 'auto' && r < sheet.rows).map(([r]) => r));
  if (automaticRows.size) {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) wb.cacheAutoRowHeights(sheetId, measureRows(wb, sheetId, 0, sheet.rows - 1, {
      force: true, automatic: true, onlyRows: automaticRows,
      textWidth(text, font) { ctx.font = font; return ctx.measureText(text).width; },
    }));
  }
  if (opts.gridlines === false) table.classList.add('no-grid');
  const headers = !!opts.headers;
  const { cols, totalW, pixel, zoom } = printLayout(wb, sheetId, sheet, used, opts);
  const widthOf = (px) => (opts.fit === 'actual' ? `${px}px` : `${((px / totalW) * 100).toFixed(2)}%`);
  if (pixel) { table.style.width = `${totalW}px`; table.classList.add('actual'); }
  if (zoom != null) table.style.zoom = String(zoom);
  const colgroup = el('colgroup', {},
    headers && el('col', { style: { width: widthOf(HEADER_W) } }),
    cols.map((c) => el('col', { style: { width: widthOf(wb.colWidth(sheetId, c)) } })));
  table.append(colgroup);
  const head = el('thead');
  const body = el('tbody');
  if (headers) {
    head.append(el('tr.print-hdr-row', { style: { height: `${HEADER_H}px` } }, el('th.print-hdr'), cols.map((c) => constrainPrintCell(el('th.print-hdr', {}, colName(c))))));
  }
  // A format applied to a whole column or row is kept on the line, not copied into every cell, so the
  // cell's own style is read over its column's and row's. A sheet with no line formats — almost every
  // sheet — takes the cell's style as it stands and pays nothing for the lookup.
  const lineFormats = !!(wb.defaultStyle(sheet) || sheet.colStyles?.size || sheet.rowStyles?.size || sheet.styleResets?.length);
  paintCellFill(table, wb.nativeDefaultCellFormat?.style.bg);
  const customTables = sheet.tables.some(t => t.customStyle);
  const nativePivots = wb.hasNativePivotDisplay(sheetId);
  // A synthetic blank cell below can carry display paint. Always read the
  // source format here so its PivotTable borders are not reapplied as direct.
  const styleOf = nativePivots ? (_cell, r, c) => wb.displayStyleAt(sheetId, r, c)
    : lineFormats ? (cell, r, c) => wb.styleAt(sheetId, r, c) : (cell) => cell?.s;
  const repeat = opts.titleRows ? 0 : Math.max(0, opts.repeatRows | 0);
  const rows = printLines(used.r1, used.r2, opts.titleRows, r => wb.isRowHidden(sheetId, r));
  if (opts.titleRows || opts.titleCols) setPrintTitleAxes(table, {
    rows: opts.titleRows ? titleAxis(rows, used.r1, opts.titleRows, headers ? 1 : 0) : null,
    cols: opts.titleCols ? titleAxis(cols, used.c1, opts.titleCols, headers ? 1 : 0) : null,
  });
  const breakAxes = printBreakAxes(rows, cols, used, opts, headers ? 1 : 0);
  if (breakAxes) setPrintBreakAxes(table, breakAxes);
  const inHead = (r) => r < repeat;
  // Disjoint titles and the print area are separate printed blocks. A merge
  // must not acquire an anchor from the omitted gap or collapse across it.
  const gap = (title, first) => title && title[1] + 1 < first ? [title[1] + 1, first - 1] : null;
  const merged = printMergeSpans(rows, cols, sheet.merges, repeat, { ...used,
    r1: Math.min(used.r1, opts.titleRows?.[0] ?? used.r1), c1: Math.min(used.c1, opts.titleCols?.[0] ?? used.c1),
    rowGap: gap(opts.titleRows, used.r1), colGap: gap(opts.titleCols, used.c1) });
  const rowIndex = new Map(rows.map((r, i) => [r, i])), colIndex = new Map(cols.map((c, i) => [c, i]));
  const borderStyleAt = (r, c) => styleOf(sheet.cells.get(cellKey(r, c)), r, c);
  const borderTableAt = (r, c) => customTables ? wb._tableStyleAt(sheet, r, c) : null;
  const borderMerges = new Map();
  const resolveBorders = createBorderResolver({
    read: (r, c) => ({ style: borderStyleAt(r, c), table: borderTableAt(r, c), conditional: sheet.rules.length ? wb.conditionalStyle(sheetId, r, c, wb.getValue(sheetId, r, c), { banding: false }) : null }),
    mergeAt: sheet.merges.length ? (r, c) => {
      const key = cellKey(r, c);
      if (!borderMerges.has(key)) borderMerges.set(key, wb.mergeAt(sheetId, r, c));
      return borderMerges.get(key);
    } : undefined,
    neighbor: (r, c, side) => {
      const rr = side === 'bt' ? rows[rowIndex.get(r) - 1] : side === 'bb' ? rows[rowIndex.get(r) + 1] : r;
      const cc = side === 'bl' ? cols[colIndex.get(c) - 1] : side === 'br' ? cols[colIndex.get(c) + 1] : c;
      return rr !== undefined && cc !== undefined ? [rr, cc] : null;
    },
  });
  // A cell a checkbox rule covers draws a box whatever it holds, as the grid does, so it is never blank.
  const checkboxAt = sheet.validations?.length ? (r, c) => wb.validationAt(sheetId, r, c)?.type === 'checkbox' : () => false;
  // A blank cell text can run into: no value, no spilled array, no tick box, not part of a merge.
  const emptyAt = (r, c) => {
    if (merged.has(cellKey(r, c)) || checkboxAt(r, c) || nativeSparklineAt(wb, sheetId, r, c)) return false;
    const other = sheet.cells.get(cellKey(r, c));
    return (!other || (other.v == null && other.f == null)) && !wb.spillAt(sheetId, r, c);
  };
  // Ordinary aligned labels need no overflow box. Cache measurements only
  // for this print operation, and stay conservative when fonts are not ready
  // or the host cannot measure them. Numeric text may use tabular glyphs in
  // CSS that canvas does not expose, so leave those labels on the full path.
  let measureContext, measuredIndentUnit;
  const indentUnit = () => measuredIndentUnit ??= normalIndentUnit(wb.normalFont, (text, font) => {
    measureContext ||= document.createElement('canvas').getContext('2d');
    if (!measureContext) return NaN;
    measureContext.font = font;
    return measureContext.measureText(text).width;
  });
  const measuredWidths = new Map();
  const fitsAlignedText = (text, style, bold, width) => {
    if (text.length > 256 || !document.defaultView?.CanvasRenderingContext2D || /[\d\r\n\t]/.test(text)) return false;
    const font = `${style.italic ? 'italic ' : ''}${bold ? '600 ' : ''}${style.size || 9.5 * 4 / 3}px ${fontStack(style.font) || 'system-ui, sans-serif'}`;
    const key = `${font}\0${text}`;
    let measured = measuredWidths.get(key);
    if (measured == null) {
      if (!document.fonts?.check(font)) return false;
      measureContext ||= document.createElement('canvas').getContext('2d');
      if (!measureContext) return false;
      measureContext.font = font;
      measured = measureContext.measureText(text).width;
      if (measuredWidths.size >= 4000) measuredWidths.clear();
      measuredWidths.set(key, measured);
    }
    const padding = cellHorizontalPadding(style.indent && style.align !== 'center' ? style.indent * indentUnit() : 0);
    return measured + padding + 1 <= width;
  };
  for (const [ri, r] of rows.entries()) {
    // Fixed heights retain the imported physical dimensions (XLSX points
    // converted to CSS pixels). Normal-font/printer ratios vary between
    // native export engines and must not rescale these stored dimensions.
    const rowHeight = wb.rowHeight(sheetId, r);
    const tr = el('tr', { style: { height: `${rowHeight}px` } });
    if (headers) tr.append(constrainPrintCell(el('th.print-hdr', {}, String(r + 1))));
    for (const [ci, c] of cols.entries()) {
      const key = cellKey(r, c);
      const span = merged.get(key);
      if (span === null) continue;
      // A merge prints the cell it is drawn from, wherever that cell lies: its first row or column may be
      // hidden or filtered out while the grid still shows the block. A span showing nothing (the lower
      // half of a merge the repeating head cut, a merge a selection starts inside) has no `from`.
      const sr = span?.from ? span.from.r1 : r;
      const sc = span?.from ? span.from.c1 : c;
      let cell = span && !span.from ? null : sheet.cells.get(cellKey(sr, sc));
      const td = el('td');
      let borderStyle;
      // Ordinary single-line text fits the default row without another node.
      // Use a bounded content box only where it could enlarge the table row.
      let constrained = rowHeight < 23;
      if (span) { td.rowSpan = span.rowSpan; td.colSpan = span.colSpan; }
      const spill = !span && (!cell || (cell.v == null && cell.f == null)) ? wb.spillAt(sheetId, r, c) : null;
      const conditional = sheet.rules.length || sheet.tables?.length ? wb.conditionalStyle(sheetId, sr, sc, wb.getValue(sheetId, sr, sc)) : null;
      // A cell the sheet never stored still shows the fill or border its column or row was formatted
      // with, as the grid draws it: the format is on the line, not in a cell of its own.
      if (!cell && !spill && (lineFormats || customTables || nativePivots)) {
        const line = { ...(customTables ? wb._tableStyleAt(sheet, sr, sc) : null), ...styleOf(null, sr, sc) };
        if (paints(line)) cell = { v: null, f: null, s: line };
      }
      // A checkbox rule draws a tick box in place of the cell's text, blank cell or not, as the grid does.
      const checkbox = checkboxAt(sr, sc);
      const drawCheckbox = on => {
        constrained = true;
        const rule = wb.validationAt(sheetId, sr, sc), excel = rule?.checkboxStyle === 'excel';
        td.style.textAlign = 'center';
        if (excel && Number.isFinite(rule.checkboxOffset)) {
          td.style.textAlign = 'left';
          td.style.paddingLeft = `${Math.max(0, Math.min(rule.checkboxOffset, wb.colWidth(sheetId, sc) - 13))}px`;
          td.style.paddingRight = '0';
        }
        td.innerHTML = checkboxSvg(on, excel);
      };
      if (!cell && !spill) {
        // Blank cells can still have a rule fill or a table's band, as on screen.
        if (conditional?.bg) paintCellFill(td, conditional.bg);
        if (checkbox) drawCheckbox(false);
      } else {
        const value = spill ? spill.value : cell.v != null || cell.f != null ? wb.getValue(sheetId, sr, sc) : null;
        // Match the grid: line defaults, then the spill's number format, then cell overrides.
        const st = conditionalFontStyle(spill ? wb._pivotDisplayStyle(sheetId, sr, sc, { ...(lineFormats ? wb._lineStyle(sheet, sr, sc) : null), ...spill.style, ...cell?.s }) : styleOf(cell, sr, sc) || {}, conditional);
        borderStyle = customTables ? borderStyleAt(sr, sc) : st;
        let text = cellLayoutText(formatValue(value, st), st.wrap);
        if (value === 0 && sheet.zeros === false) text = '';
        // Text that reads right to left is laid out that way (its numbers, punctuation and a trailing
        // Latin word where they belong) and, given no alignment, sits at the right, as the grid shows it.
        const rtl = typeof value === 'string' && readsRightToLeft(text);
        const align = st.align || (rtl ? 'right' : defaultAlign(value));
        td.style.textAlign = align;
        if (rtl) td.dir = 'rtl';
        // Conditional formatting and table styling print as they show on screen.
        const cf = conditional;
        if (st.bold) td.style.fontWeight = '600';
        else if (cf?.bold === false) td.style.fontWeight = '400';
        if (st.italic) td.style.fontStyle = 'italic';
        const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
        if (deco) td.style.textDecoration = deco;
        const formatColor = st.fmt === 'custom' ? codeColor(value, st.code, wb.colorPalette) : null;
        const ink = cf?.color || formatColor || st.color;
        if (ink) td.style.color = fontColorCss(ink);
        // A cell's own fill paints over its table's coat, as on screen; a rule's fill paints over both.
        const bg = cf?.bg && !(nativeFillOverridesNormal(st, wb.nativeNormalFill) && cf.coat) ? cf.bg : st.bg;
        if (bg || wb.nativeDefaultCellFormat?.style.bg || cf?.bg && cf.coat) paintCellFill(td, bg, wb.nativeDefaultCellFormat?.style.bg ? '#ffffff' : null);
        if (cf?.bar != null) {
          paintDataBar(td, cf);
        }
        const barText = cf?.barOnly ? '' : text;
        const shown = cf?.iconImage ? (cf.iconOnly ? '' : barText) : cf?.icon ? (cf.iconOnly ? cf.icon : `${cf.icon} ${barText}`) : cf?.iconOnly ? '' : barText;
        let formatParts = !cf?.barOnly && !cf?.iconOnly && !(value === 0 && sheet.zeros === false) ? numberFormatParts(value, st, cell?.richText) : null;
        if (!formatParts && st.shrink && !st.wrap && barText && !cf?.barOnly && !cf?.iconOnly) formatParts = [{ type: 'text', text: barText }];
        const richOptions = { style: st, color: cf?.color || formatColor };
        if (formatParts?.some(part => part.rich)) td.style.textDecoration = 'none';
        if (st.size) td.style.fontSize = `${st.size}px`;
        let printFont = `${st.italic ? 'italic ' : ''}${st.bold ? '600 ' : ''}${st.size || 9.5 * 4 / 3}px ${fontStack(st.font) || 'system-ui, sans-serif'}`;
        if (st.shrink && !st.wrap && barText && !checkbox && !(value && typeof value === 'object' && (value.image || value.sparkline))) {
          measureContext ||= document.createElement('canvas').getContext('2d');
          if (measureContext) {
            const measure = (text, font) => { measureContext.font = font; return measureContext.measureText(text).width; };
            const width = cols.slice(ci, ci + (span?.colSpan || 1)).reduce((sum, col) => sum + wb.colWidth(sheetId, col), 0);
            const padding = cellHorizontalPadding(st.indent && align !== 'center' ? st.indent * indentUnit() : 0) + 1;
            const iconWidth = cf?.iconImage ? 20 : cf?.icon ? measure(cf.icon + ' ', printFont) : 0;
            const fit = shrinkCellText({ text: barText, parts: formatParts, font: printFont, width: width - padding - iconWidth, angle: st.rot || 0, measure });
            printFont = fit.font; richOptions.zoom = fit.zoom;
            td.style.fontSize = `${Number(/([\d.]+)px/.exec(printFont)?.[1])}px`;
          }
        }
        // Match the print CSS's 9.5pt default, 1.2 line height and padding.
        // Reserve the widest supported border (3px), including a neighbour's
        // collapsed edge, without adding a content box to every bordered cell.
        const textHeight = largestRichTextSize(formatParts, st.size || 9.5 * 4 / 3) * 1.2 + (st.font === 'calibri' ? 0 : 4) + 3;
        if (st.wrap || st.rot || textHeight > rowHeight) constrained = true;
        if (fontStack(st.font)) td.style.fontFamily = fontStack(st.font);
        if (st.font === 'calibri') { td.style.padding = '0 2px'; td.style.lineHeight = '1.2'; }
        if (st.indent && align !== 'center' && wb.normalFont) table.dataset.indentFont = normalFontCss(wb.normalFont);
        if (st.indent) { if (align === 'right') td.style.paddingRight = `${st.indent * indentUnit() + CELL_TEXT_INSET}px`; else if (align !== 'center') td.style.paddingLeft = `${st.indent * indentUnit() + CELL_TEXT_INSET}px`; }
        if (st.wrap) td.classList.add('wrap');
        if (st.valign) td.style.verticalAlign = st.valign;
        let formatted = null, formattedWidth = null, formatRequiresFit = false;
        if (formatParts) {
          const parts = formatParts;
          const font = printFont;
          measureContext ||= document.createElement('canvas').getContext('2d');
          if (measureContext) {
            const measure = richTextMeasure(font, (text, font) => { measureContext.font = font; return measureContext.measureText(text).width; }, richOptions.zoom || 1);
            const width = cols.slice(ci, ci + (span?.colSpan || 1)).reduce((sum, col) => sum + wb.colWidth(sheetId, col), 0);
            const padding = cellHorizontalPadding(st.indent && align !== 'center' ? st.indent * indentUnit() : 0) + 1;
            const iconWidth = cf?.iconImage ? 20 : cf?.icon ? measure(cf.icon + ' ') : 0;
            const room = st.rot ? rotatedFormatWidth(rowHeight - 1, largestRichTextSize(parts, st.size || 9.5 * 4 / 3) * 1.2, st.rot) : width - padding - iconWidth;
            const layout = layoutFormatParts(parts, room, measure);
            formattedWidth = layout.width + padding + iconWidth;
            formatRequiresFit = layout.requiresFit;
            if (!st.rot && (typeof value === 'number' || layout.requiresFit) && layout.naturalWidth > room) formatted = el('span.number-format-layout', { 'aria-label': barText, style: { display: 'inline-block', whiteSpace: 'pre' } }, '###');
            else {
              formatted = formatLayoutNode(layout, barText, align, st.wrap && !st.rot && typeof value !== 'number', !st.align, richOptions);
              if (cf?.icon && !cf.iconImage) formatted.prepend(document.createTextNode(cf.icon + ' '));
            }
            if (!st.rot) printFormatLayouts.set(formatted, { parts, font, text: barText, align, richOptions,
              wrap: st.wrap && typeof value !== 'number', general: !st.align,
              shrink: st.shrink && !st.wrap, numeric: typeof value === 'number', icon: cf?.iconImage ? null : cf?.icon, iconWidth: cf?.iconImage ? 20 : 0 });
          }
        }
        if (checkbox) {
          // A checklist prints its boxes, ticked or not, rather than the words TRUE and FALSE.
          drawCheckbox(value === true);
        } else if (value && typeof value === 'object' && value.sparkline) {
          constrained = true;
          td.classList.add('sparkline');
          td.innerHTML = renderSparklineSvg(value, Math.max(8, wb.colWidth(sheetId, c) - 2), Math.max(6, wb.rowHeight(sheetId, r) - 2));
        } else if (value && typeof value === 'object' && value.image) {
          constrained = true;
          // An IMAGE() cell prints its picture as the grid shows it: fitted inside the cell, stretched to
          // fill it, or at its own size and cut at the cell's edges. The row's height bounds it in pixels,
          // since a percentage of a table cell's height is nothing to a browser.
          const fit = value.fit || 'contain';
          const room = Math.max(4, wb.rowHeight(sheetId, r) - 2);
          td.classList.add('image', `fit-${fit}`);
          td.append(el('img', { src: value.image, alt: value.alt || '', style: fit === 'stretch' ? { width: '100%', height: `${room}px` } : fit === 'original' ? null
            : { width: '100%', height: `${room}px`, objectFit: 'contain', objectPosition: cellPictureObjectPosition(st) } }));
        } else if (st.rot) {
          const rotated = el('span', {}, formatted || shown);
          rotated.style.display = 'inline-block';
          if (Math.abs(st.rot) >= 90) { rotated.style.writingMode = 'vertical-rl'; if (st.rot > 0) rotated.style.transform = 'rotate(180deg)'; } else rotated.style.transform = `rotate(${-st.rot}deg)`;
          td.replaceChildren(rotated);
        } else if (typeof value === 'string' && shown && !span && !st.wrap && !st.clip && !st.shrink && !formatRequiresFit) {
          // Text runs into empty visible neighbours in its alignment direction.
          // Keep the cell's own borders/fill and the original text alignment.
          const own = wb.colWidth(sheetId, c);
          const fits = align !== 'left' && (formattedWidth == null ? fitsAlignedText(shown, st, st.bold, own) : formattedWidth <= own);
          const reach = dir => {
            let width = 0;
            for (let k = ci + dir; k >= 0 && k < cols.length && emptyAt(r, cols[k]); k += dir) width += wb.colWidth(sheetId, cols[k]);
            return width;
          };
          const left = !fits && (align === 'right' || align === 'center') ? reach(-1) : 0;
          const right = !fits && (align === 'left' || align === 'center') ? reach(1) : 0;
          const total = own + left + right;
          if (total > own) {
            constrained = true;
            td.classList.add('spill');
            const content = el('span', { style: {
              width: `${+((total / own) * 100).toFixed(1)}%`,
              ...(left ? { left: `${-(left / own) * 100}%` } : null),
            } }, formatted || shown);
            if (align === 'center' && left !== right) {
              // An obstacle clips just its side of centred text; it must not
              // move the text's centre toward the larger empty region.
              const excess = Math.max(left, right), width = own + 2 * excess;
              content.style.width = `${(width / own) * 100}%`;
              content.style.left = `${-(excess / own) * 100}%`;
              content.style.clipPath = `inset(0 ${((excess - right) / width) * 100}% 0 ${((excess - left) / width) * 100}%)`;
            }
            td.append(content);
          } else if (formatted) td.append(formatted);
          else td.textContent = shown;
        } else if (formatted) td.append(formatted);
        else td.textContent = shown;
        if (cf?.iconImage) {
          // Icon-only content follows cell alignment; icons accompanying values
          // retain a separate leading slot so numeric alignment stays intact.
          if (!cf.iconOnly) { td.style.position = 'relative'; td.style.paddingLeft = '22px'; }
          else { constrained = true; td.style.lineHeight = '0'; }
          td.prepend(conditionalIconNode(cf, true));
        }
        if (isError(value)) td.classList.add('err');
      }
      // The same shared-edge decision as the grid, including conditional
      // clears. Leaving a losing side unset preserves implicit gridlines.
      if (!span) {
        const borderRules = customTables ? (sheet.rules.length ? wb.conditionalStyle(sheetId, r, c, wb.getValue(sheetId, r, c), { banding: false }) : null) : conditional;
        const borders = resolveBorders(r, c, borderStyle, borderRules, borderTableAt(r, c));
        for (const [key, side] of [['bt', 'Top'], ['bb', 'Bottom'], ['bl', 'Left'], ['br', 'Right']]) {
          if (!borders[key]) continue;
          const b = borderCss(borders[`${key}Border`]);
          table.classList.add('has-print-borders');
          td.style[`border${side}`] = `${b.width} ${b.style} ${b.color || '#000'}`;
        }
      }
      if (span) {
        const merge = printMergeSources.get(span);
        const segments = mergeBorderSegments(merge, rows.slice(ri, ri + span.rowSpan), cols.slice(ci, ci + span.colSpan),
          r => wb.rowHeight(sheetId, r), c => wb.colWidth(sheetId, c), (r, c) => {
            const cf = sheet.rules.length ? wb.conditionalStyle(sheetId, r, c, wb.getValue(sheetId, r, c), { banding: false }) : null;
            return resolveBorders(r, c, borderStyleAt(r, c), cf, borderTableAt(r, c));
          });
        setMergedPrintBorders(td, segments);
        if (segments.length) table.classList.add('has-print-borders');
        for (const [key, side] of [['bt', 'Top'], ['bb', 'Bottom'], ['bl', 'Left'], ['br', 'Right']]) {
          td.style[`border${side}`] = '';
          const edge = segments.find(s => s.side === key && s.start === 0 && s.end === 1);
          if (edge) td.style[`border${side}`] = `${edge.width} ${edge.style} ${edge.color || '#000'}`;
        }
      }
      const nativeSpark = nativeSparklineData(wb, sheetId, sr, sc);
      if (nativeSpark) {
        const width = cols.slice(ci, ci + (span?.colSpan || 1)).reduce((sum, c) => sum + wb.colWidth(sheetId, c), 0);
        const height = rows.slice(ri, ri + (span?.rowSpan || 1)).reduce((sum, r) => sum + wb.rowHeight(sheetId, r), 0);
        td.classList.add('has-native-sparkline');
        td.append(nativeSparklineNode(nativeSpark, Math.max(0, width - 2), Math.max(0, height - 2)));
        constrained = true;
      }
      tr.append(constrained ? constrainPrintCell(td) : td);
    }
    (inHead(r) ? head : body).append(tr);
  }
  if (head.childElementCount) table.append(head);
  table.append(body);
  return table;
}

/**
 * The table plus the sheet's charts and images floating where they sit on
 * screen, in one positioned wrapper. Horizontal positions are percentages of
 * the table width so they follow a table stretched to the page; vertical
 * positions are the row heights in pixels.
 */
function printObjectContent(node, wb, sheetId, obj, w, h) {
  // A hidden object (the Selection Pane's eye) prints no more than it shows.
  if (obj.print === false || obj.hidden) return false;
  if (obj.type === 'slicer') {
    const control = createSlicerControl(document);
    control.update(obj, slicerItems(wb, obj), obj.paint);
    node.append(control.node);
    return true;
  }
  if (obj.type === 'timeline') {
    const control = createTimelineControl(document);
    let state = null;
    try { state = timelineState(wb, obj); } catch { state = null; }
    control.update(obj, state, { disabled: true });
    node.append(control.node);
    return true;
  }
  if (obj.type === 'scroll') {
    const control = createScrollControl(document);
    control.update(obj, scrollControlValue(wb, sheetId, obj));
    node.append(control.node);
    return true;
  }
  if (obj.decorative) node.setAttribute('aria-hidden', 'true');
  if (obj.type === 'smartart') {
    // A SmartArt graphic prints as it shows, its empty items left blank.
    node.style.backgroundColor = 'transparent';
    node.classList.add('borderless');
    if (obj.fallback) { node.style.overflow = 'visible'; node.innerHTML = fallbackPicture(obj.fallback); } else node.innerHTML = smartArtSvg(obj, obj.w, obj.h, { ...smartArtLook(wb), idPrefix: `psa-${String(obj.id).replace(/[^\w-]/g, '')}`,
      label: obj.decorative ? '' : obj.description || smartArtAltText(obj) }).replace('<svg ', '<svg style="width:100%;height:100%" ');
    return true;
  }
  if (isImage(obj) || obj.appearance?.background === 'none') node.style.backgroundColor = 'transparent';
  if (isImage(obj)) {
    node.style.overflow = 'visible';
    // A linked picture prints the cells it shows now; a styled picture prints its frame and shadow.
    const target = obj.pictureRef && linkedPictureTarget(wb, sheetId, obj.pictureRef);
    const live = target && rangePicture(wb, target.sheetId, target.range);
    const shown = live ? { ...obj, src: svgDataUrl(live.svg), srcRect: null, fillRect: null } : obj;
    if (pictureStyled(obj)) {
      const frame = el('div', { style: { position: 'absolute', inset: '0', boxSizing: 'border-box', ...pictureFrameCss(obj) } });
      if (obj.shape) frame.style.overflow = 'hidden';
      if (shown.src) frame.append(pictureNode(shown));
      node.style.border = 'none';
      node.append(frame);
    } else if (shown.src) node.append(pictureNode(shown));
  } else if (isTextBox(obj)) {
    node.classList.add('print-text');
    if (obj.style?.border === false) node.classList.add('borderless');
    const effect = textBoxEffectCss(wb, obj);
    if (effect.filter) node.style.overflow = 'visible';
    node.append(obj.equation ? equationBody(obj, 1, effect) : el('div.text-body', { style: { ...textBoxStyle(obj), ...effect } }, el('span', {}, textBoxText(wb, sheetId, obj))));
    // A turned or flipped text box (Arrange ▸ Rotate) prints as it shows.
    if (obj.rotation || obj.flipH || obj.flipV) node.style.transform = `rotate(${obj.rotation || 0}deg) scale(${obj.flipH ? -1 : 1}, ${obj.flipV ? -1 : 1})`;
  } else {
    if (chartCornerRadius(obj)) node.style.backgroundColor = 'transparent';
    try { node.innerHTML = renderChartSvg(chartData(wb, sheetId, obj), obj, w, h); } catch { return false; }
  }
  return true;
}

export function buildPrintSheet(wb, sheetId, opts = {}) {
  const chartSheet = wb.sheet(sheetId);
  if (chartSheet?.kind === 'chart') {
    const bounds = chartSheetBounds(chartSheet);
    const scale = Math.min(printableWidth(opts) / bounds.width, printableHeight(opts) / bounds.height);
    const wrapper = el('div.print-sheet.print-chart-sheet', { style: { width: `${bounds.width}px`, height: `${bounds.height}px`, zoom: String(scale) } });
    for (const obj of chartSheet.charts) {
      const node = el('div.print-object', { style: { left: `${obj.dx}px`, top: `${obj.dy}px`, width: `${obj.w}px`, height: `${obj.h}px` } });
      if (!printObjectContent(node, wb, sheetId, obj, obj.w, obj.h)) continue;
      wrapper.append(node);
    }
    return wrapper;
  }
  const table = buildPrintTable(wb, sheetId, opts);
  const wrapper = el('div.print-sheet', {}, table);
  if (table.style.zoom) { wrapper.style.zoom = table.style.zoom; table.style.zoom = ''; }
  const sheet = wb.sheet(sheetId);
  const used = printRange(wb, sheetId, opts);
  if (!sheet || !used || !sheet.charts?.length) return wrapper;
  const headers = !!opts.headers;
  const { cols: visibleCols, totalW, pixel } = printLayout(wb, sheetId, sheet, used, opts);
  const percent = !pixel;
  const xOf = (col) => { let x = headers ? HEADER_W : 0; for (const c of visibleCols) { if (c >= col) break; x += wb.colWidth(sheetId, c); } return x; };
  const visibleRows = printLines(used.r1, used.r2, opts.titleRows, r => wb.isRowHidden(sheetId, r));
  const yOf = (row) => { let y = headers ? HEADER_H : 0; for (const r of visibleRows) { if (r >= row) break; y += wb.rowHeight(sheetId, r); } return y; };
  for (const obj of sheet.charts) {
    const { r, c } = obj.anchor || {};
    // An object whose anchor row or column is hidden (by a filter, say) stays on screen, drawn where the
    // hidden line would begin, at the next visible one: xOf and yOf place it there on paper too.
    const held = (n, first, last, title) => n >= first && n <= last || title && n >= title[0] && n <= Math.min(title[1], last);
    if (r == null || c == null || !held(r, used.r1, used.r2, opts.titleRows) || !held(c, used.c1, used.c2, opts.titleCols)) continue;
    const x = xOf(c) + (obj.dx || 0);
    const y = yOf(r) + (obj.dy || 0);
    const w = Math.max(obj.drawingShape ? 1 / 9525 : 1, obj.w || 1);
    const h = Math.max(obj.drawingShape ? 1 / 9525 : 1, obj.h || 1);
    // The height stays in pixels, as the rows it covers do. A table narrower than the page is stretched
    // across it, but its rows keep their heights, so an object given the shape it has on screen would
    // grow taller with the columns and hide the rows under it: a 160 × 120 chart beside a two-column
    // table came out 1.8 times too tall. The drawing inside keeps its own shape, centred in the box.
    const node = el('div.print-object', { style: { top: `${y}px`, left: percent ? `${((x / totalW) * 100).toFixed(3)}%` : `${x}px`, width: percent ? `${((w / totalW) * 100).toFixed(3)}%` : `${w}px`, height: `${h}px` } });
    if (!printObjectContent(node, wb, sheetId, obj, w, h)) continue;
    wrapper.append(node);
  }
  return wrapper;
}

/**
 * The print-only container: one section per sheet (every visible sheet for
 * area 'workbook'), the @page rule for paper and margins, and the header
 * and footer. With margin boxes available the header and footer sit in the
 * page margins of every page (page numbers included, and each sheet on its
 * own named page so &[Tab] is right); otherwise they print once per sheet,
 * above and below the cells.
 * opts: PRINT_DEFAULTS plus `range` for area 'selection' and `marginBoxes`
 * to force either layout (default: what the browser supports).
 */
export function buildPrintRoot(wb, sheetId, docName, opts = {}) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return null;
  const o = { ...PRINT_DEFAULTS, ...sheetPrintPrefs(sheet), ...opts };
  const marginBoxes = o.marginBoxes ?? supportsPageMarginBoxes();
  const now = new Date();
  // "All sheets" prints every visible sheet, each starting on a new page.
  const sheets = o.area === 'workbook' ? wb.sheets.filter((sh) => !sh.hidden) : [sheet];
  const pageRules = [];
  const layouts = [];
  const pageStyle = p => {
    const paper = PAPER_SIZES.find(([k]) => k === p.paper)?.[2] || 'letter';
    const m = pageMargins(p);
    // Flow content is clipped to the page area. Open the horizontal page margins
    // and give the sheet its original inset so headers can reach the paper edges.
    const paperAlignedFlow = (!marginBoxes || p.richHeaderText) && p.alignWithMargins === false;
    if (paperAlignedFlow) m.left = m.right = 0;
    // Chromium clips ordinary DOM paint outside the page content box. Rich
    // headers therefore use a full-height frame with the sheet's insets inside.
    if (p.richHeaderText) m.top = m.bottom = 0;
    const margin = p.margins === 'custom' || paperAlignedFlow || p.richHeaderText ? [m.top, m.right, m.bottom, m.left].map(v => `${+(v / IN).toFixed(8)}in`).join(' ') : MARGINS.find(([k]) => k === p.margins)?.[2] || '12mm';
    return `size: ${paper} ${p.orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: ${margin};`;
  };
  const sections = sheets.flatMap(sh => {
    const p = sh === sheet ? o : { ...o, ...sheetPrintPrefs(sh) };
    p.richHeaderText = !!p.native && ['header', 'footer', 'firstHeader', 'firstFooter', 'evenHeader', 'evenFooter'].some(k => hasHeaderFormatting(p[k]));
    const areas = o.area === 'selection' && o.range ? [o.range]
      : (o.area === 'printArea' || o.area === 'workbook') && sh.printSettings?.areas.length ? sh.printSettings.areas : [null];
    return areas.map(range => {
      const tableOpts = { ...p, range,
        // A printed selection repeats the frozen rows it holds too, as print titles repeat inside a print area; the
        // head is cut by the sheet's row index, so a selection starting below them has no head to repeat.
        repeatRows: p.repeatFrozen ? sh.frozenRows : 0,
      };
      const bounds = printRange(wb, sh.id, tableOpts);
      const table = buildPrintSheet(wb, sh.id, { ...tableOpts, range: bounds });
      let content = table;
      if (bounds && (p.horizontalCentered || p.verticalCentered)) {
        const { totalW, pixel, zoom } = printLayout(wb, sh.id, sh, bounds, tableOpts);
        let height = p.headers ? HEADER_H : 0;
        for (const r of printLines(bounds.r1, bounds.r2, tableOpts.titleRows, r => wb.isRowHidden(sh.id, r))) height += wb.rowHeight(sh.id, r);
        content = el('div.print-position', { style: {
          paddingLeft: p.horizontalCentered && pixel ? `${Math.max(0, (printableWidth(p) - totalW * (zoom ?? 1)) / 2)}px` : '0',
          paddingTop: p.verticalCentered ? `${Math.max(0, (printableHeight(p) - height * (zoom ?? 1)) / 2)}px` : '0',
        } }, table);
      }
      const regularText = { header: String(p.header || '').trim(),
        footer: String(p.footer || '').trim() || (p.native ? '' : marginBoxes ? 'Page &[Page] of &[Pages]' : '&[Date]') };
      const { header, footer } = printPageText({ ...p, ...regularText }, 0);
      const info = { file: docName || 'Spreadsheet', tab: sh.name, now, palette: wb.colorPalette, normalFont: wb.normalFont };
      const showSheetName = wb.sheets.length > 1 || sheets.length > 1;
      const i = pageRules.length;
      const section = el('section.print-section', { className: i > 0 ? 'print-section page-break' : 'print-section' });
      if ((!marginBoxes || p.richHeaderText) && p.alignWithMargins === false) {
        const margins = pageMargins(p);
        Object.assign(section.style, { width: `${printableWidth(p)}px`, marginLeft: `${margins.left}px`, marginRight: `${margins.right}px` });
      }
      const pageName = `sheet-${i + 1}`;
      pageRules.push(`@page ${pageName} { ${pageStyle(p)} }` + (marginBoxes ? pageMarginCss(pageName, header, footer, info, p) : ''));
      section.style.page = pageName;
      if (marginBoxes || p.richHeaderText) {
        if (p.title !== false) {
          section.append(el('div.print-head', {},
            el('span.print-title', {}, docName || 'Spreadsheet'),
            showSheetName && el('span.print-sub', {}, sh.name)));
        }
        section.append(content);
      } else {
        // Section codes lay the parts out here as the margin boxes would.
        const variants = p.differentFirst || p.differentOddEven;
        section.append(...[
          p.title !== false && el('div.print-head', { style: !variants && header ? flowTextAlignment(p) : null },
            ...sectionSpans(variants ? '' : header, info, 'span.print-title', docName || 'Spreadsheet'),
            showSheetName && el('span.print-sub', {}, sh.name)),
          (variants || p.title === false) && flowPageText('header', header, info, p),
          content,
          flowPageText('footer', footer, info, p)].filter(Boolean));
      }
      layouts.push({ section, sheet: table, position: content === table ? null : content, opts: p,
        pageStyle: pageStyle(p), info, marginBoxes, regularText });
      if (p.richHeaderText) {
        richPageFurniture(section, { header, footer }, info, p, Number(table.style.zoom) || 1);
        // Request faces used only by later-page variants before pagination.
        const fonts = el('div.print-header-fonts', { style: { position: 'absolute', visibility: 'hidden' } });
        for (const key of ['header', 'footer', 'firstHeader', 'firstFooter', 'evenHeader', 'evenFooter']) {
          if (p[key]) fonts.append(...richHeaderSections(p[key], info));
        }
        section.append(fonts);
      }
      return section;
    });
  });
  // The document must end on its final section's page type. Chromium can
  // otherwise create an empty trailing fragment when returning from a named
  // page to the document's implicit unnamed page. This follows the end-page
  // propagation in CSS Paged Media §8.1, including multiple print areas and
  // mixed sheet orientations. Viewport heights have no role in pagination.
  const endPage = sections.at(-1)?.style.page;
  const documentPage = endPage ? `@media print { html, body { height: auto; page: ${endPage}; } }` : '';
  const root = el('div.print-root', { 'aria-hidden': 'true' },
    el('style', {}, [`@page { ${pageStyle(o)} }`, ...pageRules, documentPage].filter(Boolean).join('\n')),
    ...sections);
  printLayouts.set(root, layouts);
  return root;
}

/** Resolve number-format spacing against the rendered content box. Collapsed
 * borders snap at the selected print scale, so model widths alone cannot
 * determine the room available for fill characters or numeric text. */
function refinePrintFormats(sheet) {
  const scale = Number(sheet.style.zoom) || 1;
  const cells = [...sheet.querySelectorAll('.number-format-layout')].flatMap(node => {
    const info = printFormatLayouts.get(node);
    if (!info || node.closest('td')?.classList.contains('spill')) return [];
    const inlineSize = node.style.inlineSize;
    // A percentage resolves against the true content box, including winning
    // collapsed neighbour borders and padding, without guessing their shares.
    node.style.inlineSize = '100%';
    return [{ node, info, inlineSize }];
  });
  if (!cells.length) return;
  const ctx = document.createElement('canvas').getContext('2d');
  const updates = cells.map(({ node, info, inlineSize }) => {
    const width = node.getBoundingClientRect().width / scale;
    if (!(width > 0) || !ctx) return { node, inlineSize };
    const font = info.font.replace(/([\d.]+)px/, (_, size) => `${Number(size) * scale}px`);
    const measure = richTextMeasure(font, (text, font) => { ctx.font = font; return ctx.measureText(text).width / scale; }, scale * (info.richOptions.zoom || 1));
    const iconWidth = info.icon ? measure(info.icon + ' ') : 0;
    let effectiveMeasure = measure, richOptions = info.richOptions;
    if (info.shrink) {
      const fit = shrinkCellText({ text: info.text, parts: info.parts, font: info.font, zoom: info.richOptions.zoom || 1, width: Math.max(0, width - iconWidth),
        measure: (text, font) => { ctx.font = font.replace(/([\d.]+)px/, (_, size) => `${Number(size) * scale}px`); return ctx.measureText(text).width / scale; } });
      effectiveMeasure = fit.measure; richOptions = { ...info.richOptions, zoom: fit.zoom };
      node.closest('td').style.fontSize = `${Number(/([\d.]+)px/.exec(fit.font)?.[1])}px`;
    }
    const layout = layoutFormatParts(info.parts, Math.max(0, width - iconWidth), effectiveMeasure);
    const next = (info.numeric || layout.requiresFit) && layout.naturalWidth > width - iconWidth
      ? el('span.number-format-layout', { 'aria-label': info.text, style: { display: 'inline-block', whiteSpace: 'pre' } }, '###')
      : formatLayoutNode(layout, info.text, info.align, info.wrap, info.general, richOptions);
    if (info.icon) next.prepend(document.createTextNode(info.icon + ' '));
    printFormatLayouts.set(next, info);
    return { node, next };
  });
  for (const { node, next, inlineSize } of updates) {
    if (next) node.replaceWith(next); else node.style.inlineSize = inlineSize;
  }
}

/** Fit the actual table frame, including collapsed borders and unscaled titles
 * and footers. Model dimensions provide an initial scale; CSS layout can add
 * space and quantize borders at that scale. Measure before either print entry
 * point opens the dialog, using the same styles that will appear on paper. */
export function preparePrintRoot(root) {
  root.classList.add('print-measuring');
  try {
    for (const layout of printLayouts.get(root) || []) {
      if (layout.paginated) continue;
      const { section, sheet, position, opts } = layout;
      layout.variantSpace = flowVariantSpace(root, layout);
      refinePrintFormats(sheet);
      if (!['pages', 'width'].includes(opts.fit)) continue;
      const width = printableWidth(opts), height = printableHeight(opts);
      const widthPages = opts.fit === 'width' ? 1 : Math.max(0, opts.fitWidth ?? 1);
      const heightPages = opts.fit === 'width' ? 0 : Math.max(0, opts.fitHeight ?? 1);
      const oldWidth = section.style.width;
      section.style.width = `${width}px`;
      const oldPadding = position && [position.style.paddingLeft, position.style.paddingTop];
      if (position) { position.style.paddingLeft = '0'; position.style.paddingTop = '0'; }
      try {
        const frame = sheet.querySelector('.print-table') || sheet;
        let rect, extraHeight;
        for (;;) {
          rect = frame.getBoundingClientRect();
          // A non-layout environment cannot improve the model's estimate.
          if (!rect.width || !rect.height) break;
          extraHeight = Math.max(0, section.getBoundingClientRect().height - sheet.getBoundingClientRect().height) + layout.variantSpace;
          const scale = Number(sheet.style.zoom) || 1;
          const ratio = Math.min(1, widthPages ? width * widthPages / rect.width : 1,
            heightPages ? Math.max(0, height * heightPages - extraHeight) / rect.height : 1);
          let next = quantizePrintScale(scale * ratio);
          if ((widthPages > 1 || heightPages > 1 || frame.classList.contains('has-print-borders')) && frame.matches('.print-table')) {
            next = Math.min(next, fitPrintTableScale(frame, { width, height: Math.max(0, height - extraHeight),
              widthPages, heightPages, headers: opts.headers, scale }));
          }
          if (next >= scale) break;
          sheet.style.zoom = String(next);
          refinePrintFormats(sheet);
          // Re-measure: pixel-snapped borders need not scale proportionally.
          // Every iteration strictly reduces scale toward the 10% limit.
        }
        if (position && rect?.width && rect?.height) {
          position.style.paddingLeft = opts.horizontalCentered ? `${Math.max(0, (width - rect.width) / 2)}px` : '0';
          position.style.paddingTop = opts.verticalCentered ? `${Math.max(0, (height - extraHeight - rect.height) / 2)}px` : '0';
        } else if (position) {
          [position.style.paddingLeft, position.style.paddingTop] = oldPadding;
        }
      } finally { section.style.width = oldWidth; }
    }
    const layouts = printLayouts.get(root) || [];
    // The first included sheet's starting number is used for the print job.
    // Later sheets do not restart it. Explicit fragments avoid page-counter
    // reset scoping in browsers and retain the full SpreadsheetML uint range.
    const numbering = normalizePrintSettings(layouts[0]?.opts);
    const explicitNumbers = layouts[0]?.marginBoxes && numbering?.useFirstPageNumber;
    const numberPages = explicitNumbers || layouts.some(({ opts }) => opts.differentFirst || opts.differentOddEven || opts.richHeaderText);
    const richPages = [];
    let pageIndex = 0;
    let changedPageName = false;
    for (const layout of printLayouts.get(root) || []) {
      if (layout.paginated) continue;
      const { section, sheet, position, opts } = layout;
      const chart = sheet.classList.contains('print-chart-sheet');
      if (chart && !numberPages) continue;
      const content = position || sheet;
      const furniture = [...section.children].filter(n => n !== content && !n.matches('.print-margin-text, .print-header-fonts')).reduce((height, n) => height + outerHeight(n), layout.variantSpace || 0);
      const width = printableWidth(opts), height = Math.max(1, printableHeight(opts) - furniture);
      const margins = pageMargins(opts);
      const variants = opts.differentFirst || opts.differentOddEven;
      // Header variants continue across sheets and print areas,
      // independently of an explicit starting value for the printed number.
      // Count every preceding page, including sheets without variant text.
      const pages = chart ? [sheet] : paginatePrintColumns(sheet, { width, height, overflowRight: margins.right,
        overflowBottom: margins.bottom, headers: opts.headers, pageOrder: opts.pageOrder,
        force: numberPages || !!sheet.querySelector('.has-print-borders') });
      if (!pages) continue;
      // These fragments already own their page breaks. Let oversized paint
      // reach the physical edge: Chromium otherwise clips it at the CSS page
      // area and can carry vertical overflow into later sheets. Keep header
      // and footer boxes anchored to the original content area.
      const rightOverflow = pages.some(page => page.classList.contains('print-page-overflow-right'));
      const bottomOverflow = pages.some(page => page.classList.contains('print-page-overflow-bottom'));
      let overflowStyle = '';
      if (rightOverflow || bottomOverflow) {
        const boxes = ['top', 'bottom'].flatMap(edge => ['left', 'center', 'right'].map(side => {
          const footer = edge === 'bottom' && bottomOverflow
            ? `height: ${margins.bottom}px; margin-top: ${-margins.bottom}px;` : '';
          const inset = rightOverflow && side !== 'left' ? `margin-right: ${opts.alignWithMargins === false ? 0 : margins.right}px;` : '';
          return `@${edge}-${side} { ${footer} ${inset} }`;
        })).join(' ');
        overflowStyle = `${rightOverflow ? 'margin-right: 0;' : ''} ${bottomOverflow ? 'margin-bottom: 0;' : ''} ${boxes}`;
        root.querySelector('style').textContent += `\n@page ${section.style.page} { ${overflowStyle} }`;
      }
      const firstPage = pageIndex;
      pageIndex += pages.length;
      const sections = pages.map((page, i) => {
        const next = section.cloneNode(false);
        const text = printPageText({ ...opts, ...layout.regularText }, firstPage + i);
        if (variants || explicitNumbers) {
          changedPageName = true;
          next.style.page = `${section.style.page}-page-${i + 1}`;
          root.querySelector('style').textContent += `\n@page ${next.style.page} { ${layout.pageStyle} }`
            + (layout.marginBoxes ? pageMarginCss(next.style.page, text.header, text.footer,
              explicitNumbers ? { ...layout.info, page: numbering.firstPageNumber + firstPage + i } : layout.info, opts) : '')
            + (overflowStyle ? `\n@page ${next.style.page} { ${overflowStyle} }` : '');
        }
        if (rightOverflow) next.style.width = `${width}px`;
        next.classList.toggle('page-break', i > 0 || section.classList.contains('page-break'));
        for (const node of [...section.children]) {
          if (node.matches('.print-margin-text, .print-header-fonts')) continue;
          if (variants && !layout.marginBoxes && node.matches('.print-page-header, .print-foot')) continue;
          if (node === content && variants && !layout.marginBoxes && !opts.richHeaderText && text.header) next.append(
            flowPageText('header', text.header, layout.info, opts));
          if (node !== content) next.append(node.cloneNode(true));
          else if (position) {
            const centered = position.cloneNode(false);
            centered.style.paddingLeft = opts.horizontalCentered ? `${Math.max(0, (width - parseFloat(page.style.width)) / 2)}px` : '0';
            centered.style.paddingTop = opts.verticalCentered ? `${Math.max(0, (height - parseFloat(page.style.height)) / 2)}px` : '0';
            centered.append(page); next.append(centered);
          } else next.append(page);
        }
        if (variants && !layout.marginBoxes && !opts.richHeaderText && text.footer) next.append(
          flowPageText('footer', text.footer, layout.info, opts));
        if (opts.richHeaderText) richPages.push({ section: next, text, info: { ...layout.info,
          page: (numbering?.useFirstPageNumber ? numbering.firstPageNumber : 1) + firstPage + i }, opts, scale: Number(page.style.zoom) || Number(sheet.style.zoom) || 1 });
        return next;
      });
      section.replaceWith(...sections);
      // beforeprint can run more than once. Release the unfragmented tree and
      // retain the prepared pages without fitting or fragmenting them again.
      Object.assign(layout, { paginated: true, section: sections[0], sheet: pages[0], position: null });
    }
    for (const page of richPages) richPageFurniture(page.section, page.text, { ...page.info, pages: pageIndex }, page.opts, page.scale, true);
    const lastPage = root.querySelector('.print-section:last-child')?.style.page;
    if (changedPageName && lastPage) root.querySelector('style').textContent += `\n@media print { html, body { height: auto; page: ${lastPage}; } }`;
    for (const sheet of root.querySelectorAll('.print-sheet')) paintPrintBorders(sheet);
  } finally { root.classList.remove('print-measuring'); }
}

/** Request the faces used by the staged print document, including inactive sheets
 * and rich/SVG text. FontFaceSet.ready alone can already be fulfilled before
 * those faces have been requested. Keep text for unicode-range matching. */
function loadPrintFonts(root) {
  const fonts = document.fonts;
  if (!fonts?.load || !fonts.check) return null;
  const used = new Map();
  root.classList.add('print-measuring');
  root.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!parent || parent.closest('style, script') || !text.data) continue;
    const css = getComputedStyle(parent);
    if (!css.fontFamily || !css.fontSize) continue;
    const font = `${css.fontStyle || 'normal'} ${css.fontWeight || '400'} ${css.fontSize} ${css.fontFamily}`;
    if (!used.has(font)) used.set(font, new Set());
    for (const char of text.data) used.get(font).add(char);
  }
  for (const table of root.querySelectorAll('[data-indent-font]')) {
    const font = table.dataset.indentFont;
    if (!used.has(font)) used.set(font, new Set());
    used.get(font).add(' ');
  }
  const pending = [];
  for (const [font, chars] of used) {
    const text = [...chars].join('');
    if (!fonts.check(font, text)) pending.push(fonts.load(font, text));
  }
  // Failed downloads retain the browser fallback, including offline printing.
  return pending.length ? Promise.allSettled(pending) : null;
}

/**
 * Render the sheet (or every sheet, for area 'workbook') into a print-only
 * container and open the print dialog.
 * Resolves to whether printing opened; opts.signal cancels font preparation.
 * opts: PRINT_DEFAULTS plus `range` for area 'selection'.
 */
export async function printSheet(wb, sheetId, docName, opts = {}) {
  const { signal } = opts;
  if (signal?.aborted) return false;
  for (const old of document.querySelectorAll('.print-root')) old.remove();
  let root = null, printing = false, timer;
  const cleanup = () => {
    if (printing && root?.isConnected) document.body.classList.remove('printing');
    printing = false;
    root?.remove();
    clearTimeout(timer);
    window.removeEventListener('afterprint', cleanup);
  };
  let abort;
  const cancelled = new Promise(resolve => { abort = () => { cleanup(); resolve(false); }; });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    root = buildPrintRoot(wb, sheetId, docName, opts);
    if (!root) return false;
    document.body.append(root);
    const pending = loadPrintFonts(root);
    if (pending) {
      if (await Promise.race([pending.then(() => true), cancelled]) === false || !root.isConnected) return false;
      // Canvas widths, automatic row heights and model pagination were computed
      // while building the first tree. Rebuild them with the loaded faces.
      const ready = buildPrintRoot(wb, sheetId, docName, opts);
      root.replaceWith(ready);
      root = ready;
    }
    root.classList.remove('print-measuring');
    printing = true;
    document.body.classList.add('printing');
    window.addEventListener('afterprint', cleanup);
    preparePrintRoot(root);
    window.print();
    // Browsers without afterprint (or a blocked dialog) still get cleaned up.
    if (root.isConnected) timer = setTimeout(cleanup, 60000);
    return true;
  } catch {
    cleanup();
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Printing from the browser's own menu (File > Print) never runs the app's
 * command, so nothing laid the sheet out and the toolbar, grid and status bar
 * came out on paper. This listens for beforeprint and builds the layout with
 * the default settings for the sheet `getContext()` describes as
 * { wb, sheetId, docName, opts } (or nothing, when there is nothing to print),
 * clearing it after printing. The app's own command marks the body before
 * print() fires beforeprint, so its layout is left alone. Returns the
 * function that removes the listeners (and any layout still up).
 */
export function installPrintFallback(getContext) {
  let root = null;
  const clear = () => {
    if (!root) return;
    root.remove();
    root = null;
    document.body.classList.remove('printing');
  };
  const onBeforePrint = () => {
    if (document.body.classList.contains('printing')) return;
    const ctx = getContext?.();
    if (!ctx?.wb) return;
    for (const old of document.querySelectorAll('.print-root')) old.remove();
    root = buildPrintRoot(ctx.wb, ctx.sheetId, ctx.docName, ctx.opts || {});
    if (!root) return;
    document.body.append(root);
    document.body.classList.add('printing');
    preparePrintRoot(root);
  };
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', clear);
  return () => {
    clear();
    window.removeEventListener('beforeprint', onBeforePrint);
    window.removeEventListener('afterprint', clear);
  };
}
