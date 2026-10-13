import { conditionalFontStyle } from '../core/style-values.js';
import { nativeSparklineAt, nativeSparklineData } from '../core/native-sparkline-data.js';
import { nativeSparklineNode } from './native-sparkline.js';
import { createSlicerControl } from './slicer.js';
import { createTimelineControl } from './timeline.js';
import { timelineState, setTimelineSelection } from '../core/timeline.js';
import { slicerItems, slicerTarget, setSlicerSelection } from '../core/slicer.js';
import { createScrollControl } from './scroll-control.js';
import { scrollControlValue, setScrollControlValue } from '../core/scroll-control.js';
import { conditionalIconNode } from './conditional-icon.js';
import { icon } from './icons.js';
import { confirmValidation, validationAlertStyle } from './validation-alert.js';
import { paintDataBar } from './data-bar.js';
import { createBorderResolver } from '../core/shared-borders.js';
import { mergeBorderSegments } from '../core/merge-borders.js';
import { normalIndentUnit, normalFontCss } from '../core/normal-font.js';
import { errorCheckAt } from '../core/error-checking.js';
import { numberFormatParts, measureFormatParts, layoutFormatParts, rotatedFormatWidth } from '../core/format-layout.js';
import { formatLayoutNode } from './format-layout.js';
import { richTextMeasure, largestRichTextSize } from '../core/rich-text-font.js';
import { fontColorCss } from '../core/font-color.js';
/**
 * The grid: a virtualized, keyboard-first spreadsheet surface.
 *
 * Only the cells in (and just around) the viewport exist in the DOM. Column
 * and row headers live in their own clipped tracks and follow the scroll
 * position with a transform, so nothing has to be position: sticky across
 * two axes. Selection, the fill handle, formula-reference highlights, and
 * the in-cell editor are overlays inside the same scrolling canvas, so they
 * move with the cells for free.
 *
 * Accessibility: the viewport is the focusable role="grid"; the active cell
 * is exposed through aria-activedescendant (it is always rendered, even when
 * scrolled out of view), and every selection change is spoken through the
 * caller's announce() callback.
 */
import { measureRows } from '../core/row-height.js';
import { MIN_COL_WIDTH, MAX_COL_WIDTH, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, MAX_ROWS, MAX_COLS, safeLinkUrl } from '../core/workbook.js';
import { pictureNode } from './picture.js';
import { AxisOffsets, MAX_CANVAS_EXTENT } from './axis-offsets.js';
import { chartSheetLayout } from '../core/chartsheet.js';

import { isComposing, el, clamp, isMod, IS_MAC } from './dom.js';
import { cellName, cellKey, rangeName, normalizeRange, parseRange, parseCellRef, colIndex } from '../core/cell.js';
import { splitAtCell, dropSplit } from '../core/split-panes.js';
import { RTL_LEAD } from '../core/bidi.js';
import { formatValue, formatGeneral, localeInfo, defaultAlign, editText, fontStack, borderCss, errorHelp, indentWidth, dateTimeKind } from '../core/format.js';
import { extractRefs, refToText, quoteSheet, MAX_ROW, MAX_COL } from '../core/refs.js';
import { tokenize } from '../core/formula/tokenizer.js';
import { inString, signatureFor } from '../core/formula/hints.js';
import { isError, FUNCTIONS } from '../core/formula/functions.js';
import { codeColor } from '../core/numfmt.js';
import * as S from '../core/selection.js';
import { createFormulaHints } from './autocomplete.js';
import { shrinkCellText } from '../core/shrink-text.js';
import { maxLineWidth, cellLayoutText, CELL_TEXT_INSET, cellHorizontalPadding } from '../core/textfit.js';
import { chartData, chartTitles, CHART_MIN_W, CHART_MIN_H, IMAGE_MIN, TEXT_MIN, textBoxStyle, textBoxText, imageTransform } from '../core/charts.js';
import { renderChartSvg, renderSparklineSvg, chartCornerRadius, themeSeriesKey } from './chartsvg.js';
import { equationBody } from './equation-view.js';
import { textBoxEffectCss } from '../core/theme-effects.js';
import { paintCellFill } from './cell-fill.js';
import { fillColorCss } from '../core/fill-color.js';
import { nativeFillOverridesNormal } from '../core/native-fill.js';

export const COL_HEADER_H = 26;
const ROW_HEADER_W_DESKTOP = 48;
const ROW_HEADER_W_MOBILE = 36;
const BUFFER = 2;
const PAGE_RULER = 18; // Page Layout view's rulers, above and beside the headings
const SPILL_REACH = 32; // how many shown columns a label's text may run over, and so how far one is looked for beyond the view
const RESIZE_EDGE = 5;
const REF_COLORS = 6;
const LONG_PRESS_MS = 480;
const TAP_SLOP = 8;
const GROW_ROWS = 100;
const GROW_COLS = 10;
const SPOKEN_MAX = 200; // characters of a cell's text read out when it is selected; the rest is summed up
const CHART_READ_DELAY = 150; // how long a chart over a computed range may keep its picture while typing goes on (see readRangeLater)
// Room grid.css keeps beside a cell's text for its decorations, beyond the cell's own text inset.
const FILTER_BUTTON_W = 18; // .filter-head: 18px plus the text inset
const LIST_CHEVRON_W = 16; // Inline chip controls; plain lists use an outside button.
const LIST_BUTTON_W = 24; // .cell-list-button; fixed screen-space hit target at every zoom.
const CHIP_PAD = 18; // .chip: 9px each side of its label
const ICON_GAP = 4; // .cf-icon: a 5px margin after the glyph, which is drawn 1px tighter
// A text's first letter gives its reading direction (digits and marks before it are weak); these scripts read right to left.
// The rule for text that reads right to left lives in core/bidi.js, shared with the toolbar and print.

/** Shared canvas for measuring text without touching layout; widths are remembered per font and text. */
let measureCtx = null;
const widthCache = new Map();
function textWidth(text, font) {
  const key = `${font}\u0000${text}`;
  let width = widthCache.get(key);
  if (width === undefined) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    width = measureCtx.measureText(text).width;
    // Every render of a viewport re-measures the same texts; scrolling a long sheet must not keep them all.
    if (widthCache.size >= 20000) widthCache.clear();
    widthCache.set(key, width);
  }
  return width;
}

/**
 * Excel's General format in a narrow column: fewer decimals until the number fits, then a
 * scientific form with fewer digits (an integer of any size too, so 123456789 reads 1E+08
 * rather than ###), or null when nothing fits and ### is all that is left.
 */
function generalToFit(value, text, avail, measure) {
  const abs = Math.abs(value);
  // The text carries the regional decimal mark (1234,5678), and so must the scientific form.
  const { decimal } = localeInfo();
  if (!Number.isInteger(value) && abs < 1e15) {
    const mark = text.lastIndexOf(decimal);
    const decimals = mark >= 0 && /^\d+$/.test(text.slice(mark + decimal.length)) ? text.length - mark - decimal.length : 0;
    for (let d = decimals - 1; d >= 0; d--) {
      const rounded = Number(value.toFixed(d));
      if (rounded === 0) break; // a small number is not 0; it goes scientific below
      const t = formatGeneral(rounded);
      if (measure(t) <= avail) return t;
    }
  }
  for (let d = 5; d >= 0; d--) {
    const t = value.toExponential(d).replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2').replace('e', 'E').replace('.', decimal);
    if (measure(t) <= avail) return t;
  }
  return null;
}

/** The characters a reader sees (an emoji, or a letter with its accents, is one), so a caret never splits one. */
let segmenter = null;
function graphemes(text) {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  segmenter ||= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * createGrid({ wb, sheetId, onSelection, onEdit, onContextMenu, onCommand, announce, rememberSelection })
 */
export function createGrid(opts) {
  const { wb } = opts;
  let requestedIndentFont, measuredIndentFont, measuredIndentUnit;
  function indentUnit() {
    const css = normalFontCss(wb.normalFont);
    if (css && css !== requestedIndentFont) {
      requestedIndentFont = css;
      // A Normal face can be absent from visible cells yet needed for indent
      // measurement. loadingdone invalidates the grid's fallback metrics.
      document.fonts?.load?.(css, ' ')?.catch(() => {});
    }
    if (css !== measuredIndentFont) {
      measuredIndentFont = css;
      measuredIndentUnit = normalIndentUnit(wb.normalFont, textWidth);
    }
    return measuredIndentUnit;
  }
  const cellIndent = (value, style) => style?.indent && (style.align || defaultAlign(value)) !== 'center' ? indentWidth(value, style, indentUnit()) : 0;

  let sheetId = opts.sheetId;
  const perSheet = new Map(); // sheetId → { sel, extras, scrollLeft, scrollTop }
  let pendingOrigin = wb.sheet(sheetId)?.viewOrigin || null;
  let laidOutOrigin = null;

  let sel = S.single(0, 0);
  let extras = []; // ranges added with Ctrl/Cmd+click, before the current one
  let knownSize = null; // the sheet's rows and cols as last laid out, to notice growth
  let knownWidths = null; // { sheetId, widths }: the column widths as last laid out, to notice a resize
  let offsetsStale = false; // a layout change is not laid out yet: the offsets are rebuilt on the first read, or in the next frame
  let growingByScroll = false; // scrolling near the edge is adding rows or columns right now
  const colOffsets = new AxisOffsets();
  const rowOffsets = new AxisOffsets();
  // The line each axis's canvas window begins at, when the sheet is too long for one canvas (see AxisOffsets).
  let windowAt = { r: 0, c: 0 };
  // Page Layout view (see setPageLayout): the pages laid out across and down.
  let pageLayout = null; // { metrics(sheet), render(layer, pages, info), ruler(axis, segments, info) }
  let pageGeo = null; // { cols: [{ start, end, origin, size }], rows: [...], colStarts, rowStarts, metrics, unit }
  let rowHeaderW = ROW_HEADER_W_DESKTOP;
  let rowDigitsW = 0; // room the longest row number in view needs beyond the stylesheet's width, as Excel widens its row headings
  let colHeaderH = COL_HEADER_H;
  let baseRowHeaderW = ROW_HEADER_W_DESKTOP;
  let baseColHeaderH = COL_HEADER_H;
  const OUTLINE_STEP = 12; // px per outline level in the group gutter
  let rendered = { r0: -1, r1: -1, c0: -1, c1: -1, version: -1, sheet: null };
  let mergeMap = new Map(); // cellKey → merge, only for coordinates actually queried
  let mergeMapVersion = -1;
  let mergeMapSheet = null;

  function refreshMergeMap() {
    const s = sheet();
    if (!s) return;
    if (mergeMapVersion === wb.version && mergeMapSheet === s.id) return;
    mergeMap = new Map();
    mergeMapVersion = wb.version;
    mergeMapSheet = s.id;
  }

  function mergeAt(r, c) {
    refreshMergeMap();
    const key = cellKey(r, c);
    if (mergeMap.has(key)) return mergeMap.get(key);
    const merges = sheet().merges;
    let found = null;
    for (let i = merges.length - 1; i >= 0; i--) {
      const m = merges[i];
      if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) { found = m; break; }
    }
    // Scrolling a large sheet must not eventually retain every coordinate either.
    if (mergeMap.size >= 10000) mergeMap.clear();
    mergeMap.set(key, found);
    return found;
  }
  let rafId = 0;
  let formulaInput = null;
  const editInput = () => formulaInput && document.activeElement === formulaInput ? formulaInput : editor;
  let edit = null; // { r, c, text, mode: 'type' | 'inplace', refInsert: {start,end} | null }
  let fillPreview = null;
  let movePreview = null; // range the selection would move to while dragging its border
  let cellFont = '13px system-ui';
  let plainPaste = false; // set by Ctrl/Cmd+Shift+V, read by the paste handler
  let baseFontSize = 13;
  let zoom = 1; // the scale cells are drawn at: the chosen zoom, times the print scale in Page Layout view
  let userZoom = 1; // the zoom the sheet is viewed at, as the status bar shows it
  let showFormulas = false;
  let showHeaders = wb.sheet(sheetId)?.headers !== false;
  let spellcheck = true; // red underlines while typing text (never inside formulas)
  let destroyed = false;

  /* ---------- DOM ---------- */

  const corner = el('button.grid-corner', { type: 'button', 'aria-label': 'Select all', title: 'Select all' });
  const colHead = el('div.grid-colhead');
  const rowHead = el('div.grid-rowhead');
  const colHeadFrozen = el('div.grid-colhead-frozen', { 'aria-hidden': 'true', hidden: true });
  const rowHeadFrozen = el('div.grid-rowhead-frozen', { 'aria-hidden': 'true', hidden: true });
  // Page Layout view's rulers, above the column letters and beside the row numbers, scrolling with them.
  const colRuler = el('div.grid-ruler.across', { 'aria-hidden': 'true' });
  const rowRuler = el('div.grid-ruler.down', { 'aria-hidden': 'true' });
  const colClip = el('div.grid-colhead-clip', {}, colRuler, colHead, colHeadFrozen);
  const rowClip = el('div.grid-rowhead-clip', {}, rowRuler, rowHead, rowHeadFrozen);
  /* Frozen panes: clipped layers over the viewport whose tracks share the
     canvas coordinate system, so the same cell and overlay geometry works
     inside them; pointer events pass through to the viewport beneath. */
  const mkLayer = (cls) => {
    const cells = el('div.frz-cells');
    const overlays = el('div.frz-overlays');
    const track = el('div.frz-track', {}, cells, overlays);
    return { el: el(`div.frz-layer.${cls}`, { 'aria-hidden': 'true', hidden: true }, track), track, cells, overlays };
  };
  const frzRows = mkLayer('frz-rows');
  const frzCols = mkLayer('frz-cols');
  const frzCorner = mkLayer('frz-corner');
  /* The panes beside the scrolling one: a frozen band (which does not scroll) or, in a split window,
     the top and left panes, which scroll on their own (sl, st). In a split window rows and cols are 0,
     so no line belongs to a band: a line can show in every pane. */
  const noPanes = () => ({ rows: 0, cols: 0, r0: 0, c0: 0, w: 0, h: 0, sl: 0, st: 0, split: false, top: false, left: false });
  let frozen = noPanes();
  // A split window: the canvas sits this far into the scrolling viewport, so its pane can scroll back to the
  // sheet's first row and column while the other panes cover the viewport's top and left edges.
  let shift = { x: 0, y: 0 };
  let paneScroll = { sheet: null, split: null, zoom: 0, sl: 0, st: 0 }; // the top/left panes' scroll in a split window
  let splitPane = { left: false, top: false }; // the pane of a split window last used: the active pane
  let paneRows = [0, -1], paneCols = [0, -1]; // the lines drawn in the top and left panes
  let splitDrag = null; // { axis, pos }: a split bar being dragged
  let scrollByCode = null; // { left, top }: see scrollViewportTo
  const cellsLayer = el('div.grid-cells');
  const objectsLayer = el('div.grid-objects');
  objectsLayer.addEventListener('focusin', schedule);
  objectsLayer.addEventListener('focusout', schedule);
  const chartBoxes = new Map(); // chart id → { el, sig }
  let selectedChart = null;
  let chartView = null;
  const selRange = el('div.sel-range', { 'aria-hidden': 'true' });
  const extraLayer = el('div.sel-extras', { 'aria-hidden': 'true' });
  const selActive = el('div.sel-active', { 'aria-hidden': 'true' });
  const fillHandle = el('div.fill-handle', { 'aria-hidden': 'true', title: 'Drag to fill' });
  const fillPreviewEl = el('div.fill-preview', { 'aria-hidden': 'true', hidden: true });
  const movePreviewEl = el('div.move-preview', { 'aria-hidden': 'true', hidden: true });
  const cutRangeEl = el('div.cut-range', { 'aria-hidden': 'true', hidden: true });
  let cutRange = null; // { sheetId, range }: the cells cut and awaiting the paste that moves them
  const notePop = el('div.note-pop', { hidden: true });
  const promptPop = el('div.prompt-pop', { hidden: true, role: 'note' });
  // A plain validation list is a cell value, not an in-cell widget. Keep its
  // control outside the active cell so validation cannot change text wrapping,
  // numeric precision or auto-fit. Chips retain their explicit inline UI.
  const listButton = el('button.cell-list-button', {
    hidden: true, type: 'button', tabindex: -1, 'aria-label': 'Open cell dropdown',
    title: 'Open cell dropdown (Alt+Down)', 'aria-haspopup': 'menu',
    onclick: () => {
      const { r, c } = sel.active, rule = wb.validationAt(sheetId, r, c);
      if (!edit && rule?.type === 'list') opts.onListOpen?.({ r, c, rule });
    },
  }, el('span', { 'aria-hidden': 'true', html: icon('chevD', 14) }));
  listButton.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  listButton.addEventListener('dblclick', e => e.stopPropagation());
  const linkAnchor = el('a.link-pop-url', {
    target: '_blank', rel: 'noopener noreferrer',
    // Links into the workbook are followed here, not opened as pages.
    onclick: (e) => { if (linkAnchor.getAttribute('href')?.startsWith('#')) { e.preventDefault(); opts.onCommand?.('openLink'); } },
  });
  const linkPop = el('div.link-pop', { hidden: true, role: 'group', 'aria-label': 'Link' },
    el('span.link-pop-icon', { html: '', 'aria-hidden': 'true' }),
    linkAnchor,
    el('button.link-pop-btn', { type: 'button', title: 'Edit link', 'aria-label': 'Edit link', onclick: () => opts.onCommand?.('link') }, 'Edit'),
    el('button.link-pop-btn', { type: 'button', title: 'Remove link', 'aria-label': 'Remove link', onclick: () => opts.onCommand?.('unlink') }, 'Remove'));
  // Presses and double-clicks on the popover are its own: they must not select or edit the cell beneath it.
  linkPop.addEventListener('pointerdown', (e) => e.stopPropagation());
  linkPop.addEventListener('dblclick', (e) => e.stopPropagation());
  const refLayer = el('div.ref-layer', { 'aria-hidden': 'true' });
  const hlLayer = el('div.hl-layer', { 'aria-hidden': 'true' });
  let highlights = { cells: [], current: -1 };
  const editor = el('textarea.grid-editor', {
    rows: 1, spellcheck: false, autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Cell editor', hidden: true, tabindex: -1,
  });
  // Tables: a drag corner at each table's bottom-right, and the dashed preview while it is dragged.
  const tableLayer = el('div.grid-tables', { 'aria-hidden': 'true' });
  // Page Break Preview: each printed page outlined in blue with its number, the rest of the sheet greyed.
  const pageLayer = el('div.grid-pages', { 'aria-hidden': 'true', hidden: true });
  // { pages: [{ r1, c1, r2, c2, n }], area, rowBreaks: [{ at, manual }], colBreaks } in Page Break Preview, or
  // { lines: true, area, rowBreaks, colBreaks } for the dashed page-break lines Normal view can show.
  let pageView = null;
  const tablePreviewEl = el('div.sel-range.table-preview', { hidden: true, 'aria-hidden': 'true' });
  // Page Layout view: the sheets of paper beneath the cells, with their headers and footers.
  const paperLayer = el('div.grid-paper');
  const canvas = el('div.grid-canvas', {}, paperLayer, cellsLayer, pageLayer, hlLayer, refLayer, extraLayer, cutRangeEl, selRange, selActive, tableLayer, tablePreviewEl, fillHandle, fillPreviewEl, movePreviewEl, objectsLayer, notePop, promptPop, linkPop, listButton, editor);
  const viewport = el('div.grid-viewport', {
    role: 'grid', tabindex: 0, 'aria-label': 'Spreadsheet grid', 'aria-multiselectable': 'true',
  }, canvas);
  const resizeGuide = el('div.resize-guide', { hidden: true, 'aria-hidden': 'true' });
  const resizeFeedback = el('div.resize-feedback', { hidden: true, 'aria-hidden': 'true' });
  // Freeze bars: the thick marks at the frozen boundary in the headers (at the corner when nothing is
  // frozen); dragging one freezes the rows above or the columns left of where it lands.
  const freezeV = el('div.freeze-bar.v', { title: 'Drag to freeze columns', 'aria-hidden': 'true' });
  const freezeH = el('div.freeze-bar.h', { title: 'Drag to freeze rows', 'aria-hidden': 'true' });
  // Split bars (View ▸ Split): dragged to move a split, to the window's edge or double-clicked to remove it.
  const splitV = el('div.split-bar.v', { title: 'Drag to move the split; double-click to remove it', 'aria-hidden': 'true', hidden: true });
  const splitH = el('div.split-bar.h', { title: 'Drag to move the split; double-click to remove it', 'aria-hidden': 'true', hidden: true });
  // Where the window's scrollbars are drawn, the top and left panes of a split window get their own, over the
  // first stretch of the scrolling pane's, as Excel divides its scrollbars at the bars.
  const splitScrollV = el('div.split-scroll.v', { 'aria-hidden': 'true', hidden: true }, el('div.split-scroll-size'));
  const splitScrollH = el('div.split-scroll.h', { 'aria-hidden': 'true', hidden: true }, el('div.split-scroll-size'));
  const root = el('div.grid', {}, corner, colClip, rowClip, viewport, frzRows.el, frzCols.el, frzCorner.el, resizeGuide, resizeFeedback, freezeV, freezeH, splitV, splitH, splitScrollV, splitScrollH);
  const hints = createFormulaHints({
    host: root,
    extraNames: (name) => {
      const target = name == null ? edit?.sheetId || sheetId : wb.sheetByName(name)?.id;
      return target ? wb.namesForSheet(target).filter(n => !n.hidden).map((n) => n.name) : [];
    },
    extraTables: () => wb.tableNames?.() || [],
    extraSheets: () => wb.sheets.filter((sh) => sh.id !== (edit?.sheetId || sheetId) && !sh.hidden).map((sh) => sh.name),
    columnsFor: (name) => {
      const owner = edit?.sheetId || sheetId;
      const table = !name && edit ? wb.tableAt(owner, edit.r, edit.c) : null;
      const found = name ? wb.tableByName(name) : table ? { sheet: wb.sheet(owner), table } : null;
      return found ? wb.tableColumns(found.sheet.id, found.table) : [];
    },
    onAccept: ({ start, end, text }) => {
      if (!edit) return;
      const input = editInput();
      const next = edit.text.slice(0, start) + text + edit.text.slice(end);
      input.value = next;
      input.setSelectionRange(start + text.length, start + text.length);
      setEditText(next, { fromEditor: input === editor });
      input.focus({ preventScroll: true });
    },
  });

  function updateHints() {
    if (!edit) { hints.close(); return; }
    const input = editInput();
    hints.update(edit.text, input.selectionStart, input.getBoundingClientRect(), input);
  }

  /* ---------- Geometry ---------- */

  const sheet = () => wb.sheet(sheetId);

  function rebuildOffsets() {
    offsetsStale = false;
    const s = sheet();
    if (!s) return;
    refreshAutomaticRowHeights();
    if (pageLayout && s.kind !== 'chart' && layoutPages(s)) return;
    pageGeo = null;
    if (zoom !== userZoom) { zoom = userZoom; applyZoomFont(); rendered.key = null; }
    // Only the lines that differ from the default are listed: a million rows cost what their resized and hidden ones do.
    const colSizes = [];
    for (const [c, w] of s.colWidths) colSizes.push([c, Math.round(w * zoom)]);
    for (const c of s.hiddenCols) colSizes.push([c, 0]);
    colOffsets.build(s.cols, Math.round(s.defaultColWidth * zoom), colSizes);
    const rowSizes = [];
    for (const [r, h] of s.rowHeights) rowSizes.push([r, Math.round(h * zoom)]);
    for (const r of s.hiddenRows) rowSizes.push([r, 0]);
    for (const r of s.filterHidden) rowSizes.push([r, 0]);
    rowOffsets.build(s.rows, Math.round(s.defaultRowHeight * zoom), rowSizes);
    // Frozen panes can begin at a saved row/column other than the first.
    // Keep absolute cell indexes, translating their coordinates so the first
    // frozen cell starts at zero; earlier cells remain present in the model.
    const r0 = s.frozenRows ? Math.min(s.frozenOrigin?.r || 0, s.rows - 1) : 0;
    const c0 = s.frozenCols ? Math.min(s.frozenOrigin?.c || 0, s.cols - 1) : 0;
    colOffsets.setOrigin(c0);
    rowOffsets.setOrigin(r0);
    placeWindows(s, r0, c0);
    if (laidOutOrigin?.sheetId === sheetId && (laidOutOrigin.r !== r0 || laidOutOrigin.c !== c0)) pendingOrigin = s.viewOrigin || null;
    laidOutOrigin = { sheetId, r: r0, c: c0 };
    knownSize = { sheetId, rows: s.rows, cols: s.cols };
    knownWidths = { sheetId, widths: new Map(s.colWidths) };
    canvas.style.width = `${colOffsets.total()}px`;
    canvas.style.height = `${rowOffsets.total()}px`;
    colHead.style.width = `${colOffsets.total()}px`;
    rowHead.style.height = `${rowOffsets.total()}px`;
    viewport.setAttribute('aria-rowcount', String(s.rows));
    viewport.setAttribute('aria-colcount', String(s.cols));
    computeFrozen();
  }

  /**
   * Page Layout view: the sheet laid out as printed pages, each paper-sized with its margins, a gap
   * between pages. Lines keep their order; a page begins where the print would break, so the offsets
   * jump across the margins and the gap there, and each line's end is given with its start. Cells are
   * drawn at the print scale times the zoom; the paper itself follows the zoom alone. False when the
   * provider has no layout for the sheet (the normal layout is used then).
   */
  function layoutPages(s) {
    const m = pageLayout.metrics(s);
    if (!m) return false;
    const unit = userZoom;
    const k = userZoom * m.scale;
    if (zoom !== k) { zoom = k; applyZoomFont(); rendered.key = null; }
    const gap = Math.max(4, Math.round(m.gap * unit));
    const axis = (count, sizeOf, starts, paper, before, after, center) => {
      const offsets = new Array(count + 1), ends = new Array(count), sizes = new Array(count), pages = [];
      const paperPx = Math.round(paper * unit), beforePx = Math.round(before * unit), afterPx = Math.round(after * unit);
      // The pages' lines first, then each page's place: its lines start inside its margin (centered on
      // the page when the page setup centers them), and a page too small for one wide line grows to hold it.
      for (let i = 0, page = null; i < count; i++) {
        if (!page || starts.has(i)) { page = { start: i, end: i, content: 0 }; pages.push(page); }
        sizes[i] = sizeOf(i);
        page.end = i;
        page.content += sizes[i];
      }
      let origin = gap, x = gap + beforePx;
      for (const page of pages) {
        const lead = beforePx + (center ? Math.max(0, Math.floor((paperPx - beforePx - afterPx - page.content) / 2)) : 0);
        page.origin = origin;
        x = origin + lead;
        for (let i = page.start; i <= page.end; i++) { offsets[i] = x; x += sizes[i]; ends[i] = x; }
        page.size = Math.max(paperPx, lead + page.content + afterPx);
        origin += page.size + gap;
      }
      offsets[count] = x;
      if (!pages.length) pages.push({ start: 0, end: -1, content: 0, origin: gap, size: paperPx });
      return { offsets, ends, pages, extent: origin };
    };
    const cols = axis(s.cols, (c) => (s.hiddenCols.has(c) ? 0 : Math.round((s.colWidths.get(c) ?? s.defaultColWidth) * zoom)), m.colStarts, m.paperWidth, m.margins.left, m.margins.right, m.centerAcross);
    const rows = axis(s.rows, (r) => (rowHidden(s, r) ? 0 : Math.round((s.rowHeights.get(r) ?? s.defaultRowHeight) * zoom)), m.rowStarts, m.paperHeight, m.margins.top, m.margins.bottom, m.centerDown);
    colOffsets.setExplicit(cols.offsets, cols.ends);
    rowOffsets.setExplicit(rows.offsets, rows.ends);
    pageGeo = { cols: cols.pages, rows: rows.pages, colStarts: m.colStarts, rowStarts: m.rowStarts, metrics: m, unit, width: cols.extent, height: rows.extent };
    laidOutOrigin = { sheetId, r: 0, c: 0 };
    knownSize = { sheetId, rows: s.rows, cols: s.cols };
    knownWidths = { sheetId, widths: new Map(s.colWidths) };
    canvas.style.width = `${cols.extent}px`;
    canvas.style.height = `${rows.extent}px`;
    colHead.style.width = `${cols.extent}px`;
    rowHead.style.height = `${rows.extent}px`;
    viewport.setAttribute('aria-rowcount', String(s.rows));
    viewport.setAttribute('aria-colcount', String(s.cols));
    computeFrozen();
    return true;
  }

  /** A range cut at the page breaks, keeping the pieces on pages in view (the whole range outside Page Layout view). */
  function pagePieces(range, view) {
    if (!pageGeo) return [range];
    const n = normalizeRange(range);
    const shown = new Set(visiblePages(view).map((p) => `${p.across}.${p.down}`));
    const out = [];
    pageGeo.cols.forEach((cp, a) => {
      if (cp.end < n.c1 || cp.start > n.c2) return;
      pageGeo.rows.forEach((rp, d) => {
        if (rp.end < n.r1 || rp.start > n.r2 || !shown.has(`${a}.${d}`)) return;
        out.push({ r1: Math.max(n.r1, rp.start), r2: Math.min(n.r2, rp.end), c1: Math.max(n.c1, cp.start), c2: Math.min(n.c2, cp.end) });
      });
    });
    // The piece holding the range's far corner comes first, so the fill handle and the outline agree.
    return out.length ? out.sort((p, q) => (q.r2 === n.r2 && q.c2 === n.c2) - (p.r2 === n.r2 && p.c2 === n.c2)) : [range];
  }

  /** The pages (across × down) that meet the part of the canvas in view, with their place on it. */
  function visiblePages(view) {
    if (!pageGeo) return [];
    const meet = (pages, from, size) => pages.filter((p) => p.origin < from + size && p.origin + p.size > from);
    const out = [];
    for (const row of meet(pageGeo.rows, view.st, view.vh)) {
      for (const col of meet(pageGeo.cols, view.sl, view.vw)) {
        out.push({ across: pageGeo.cols.indexOf(col), down: pageGeo.rows.indexOf(row), x: col.origin, y: row.origin, width: col.size, height: row.size,
          c1: col.start, c2: col.end, r1: row.start, r2: row.end });
      }
    }
    return out;
  }

  function renderPaper(view) {
    if (!pageGeo) { if (paperLayer.childElementCount) paperLayer.replaceChildren(); return; }
    pageLayout.render(paperLayer, visiblePages(view), { unit: pageGeo.unit, metrics: pageGeo.metrics, sheetId, across: pageGeo.cols.length, down: pageGeo.rows.length });
  }

  /** The ruler pieces over the pages in view: one per page along the axis, in canvas coordinates. */
  function rulerNodes(axis, view) {
    if (!pageGeo || !pageLayout.ruler) return [];
    const pages = axis === 'col' ? pageGeo.cols : pageGeo.rows;
    const from = axis === 'col' ? view.sl : view.st, size = axis === 'col' ? view.vw : view.vh;
    return pageLayout.ruler(axis, pages.filter((p) => p.origin < from + size && p.origin + p.size > from), { unit: pageGeo.unit, metrics: pageGeo.metrics });
  }

  /**
   * A layout change (a row or column resized, hidden, frozen) makes the offsets stale rather than
   * rebuilding them at once: a transaction that resizes two thousand rows announces each one, and
   * laying the whole sheet out two thousand times before anything is drawn would be the cost. The
   * frame that follows rebuilds them once; a read that comes sooner (the fill handle's place, a
   * cell's rectangle for a menu, the effective frozen pane) rebuilds them first, so it is right.
   */
  function invalidateOffsets() {
    offsetsStale = true;
    schedule();
  }

  function ensureOffsets() {
    if (refreshAutomaticRowHeights()) offsetsStale = true;
    if (offsetsStale) rebuildOffsets();
  }

  /* ---------- Canvas windows ---------- */

  const canvasExtent = opts.maxCanvasExtent || MAX_CANVAS_EXTENT;

  /**
   * The length a frozen band keeps at the start of an axis, as computeFrozen will find it: the frozen lines,
   * unless they would swallow the view.
   */
  function bandLength(offsets, origin, lines, viewSize) {
    if (!lines) return 0;
    const length = offsets.content(Math.min(origin + lines, offsets.n - 1)) - offsets.origin;
    return length > (viewSize || 400) * 0.7 ? 0 : length;
  }

  /**
   * A sheet longer (or wider) than one canvas can be is shown through a window of it (see AxisOffsets),
   * starting at the line `windowAt` names, after the frozen band, and never running past the sheet's end.
   */
  function placeWindows(s, r0, c0) {
    const place = (offsets, at, keep) => {
      const span = offsets.span();
      if (span - keep <= canvasExtent) { offsets.setWindow(null); return; }
      const base = clamp(offsets.content(at) - offsets.origin, keep, span - canvasExtent);
      offsets.setWindow({ keep, base, size: canvasExtent });
    };
    place(rowOffsets, windowAt.r, bandLength(rowOffsets, r0, s.frozenRows, viewport.clientHeight));
    place(colOffsets, windowAt.c, bandLength(colOffsets, c0, s.frozenCols, viewport.clientWidth));
  }

  /** Does the canvas reach the sheet's last line along an axis (its window, if any, runs to the end)? Only there can the sheet grow. */
  const reachesEnd = (offsets) => !offsets.win || offsets.win.base + offsets.win.size >= offsets.span();

  /** Where each axis's window begins, for a frame's render key: moving one moves every node. */
  const windowKey = () => `${rowOffsets.win?.base ?? ''}:${colOffsets.win?.base ?? ''}`;

  /**
   * Move the windows so content at `want` ({ x, y }: positions after the origin; either may be left out)
   * lies well inside them, a quarter window clear of either end, keeping what the viewport shows where it is
   * when it is still inside. True when a window moved.
   */
  function moveWindows(want) {
    ensureOffsets();
    if (!rowOffsets.win && !colOffsets.win) return false;
    const view = viewMetrics();
    const margin = canvasExtent / 4;
    const plan = (offsets, key, p, scroll, size) => {
      const w = offsets.win;
      if (!w || p == null || p < w.keep) return null;
      const lo = p - w.base, hi = w.base + w.size - p;
      if ((lo >= margin || w.base <= w.keep) && (hi >= margin || w.base + w.size >= offsets.span())) return null;
      // Keep the content now at the top-left of the scrolling pane where it is, if the moved window holds it.
      return { offsets, key, line: offsets.contentIndexAt(Math.max(0, p - w.size / 2) + offsets.origin), anchor: offsets.fromCanvas(scroll + w.keep), scroll, size };
    };
    const moves = [plan(rowOffsets, 'r', want.y, view.st, view.vh), plan(colOffsets, 'c', want.x, view.sl, view.vw)].filter((m) => m && m.line !== windowAt[m.key]);
    if (!moves.length) return false;
    for (const m of moves) windowAt[m.key] = m.line;
    rebuildOffsets();
    let { sl, st } = view;
    for (const m of moves) {
      const next = Math.max(0, m.offsets.toCanvas(m.anchor) - (m.offsets.win?.keep || 0));
      if (m.key === 'r') st = next; else sl = next;
    }
    rendered.key = null;
    scrollViewportTo(sl, st);
    return true;
  }

  /** Move the windows, if need be, so lines r and c (either may be null) can be scrolled to. */
  function windowsFor(r, c) {
    if (!rowOffsets.win && !colOffsets.win) return false;
    return moveWindows({
      y: r == null ? null : rowOffsets.content(r) - rowOffsets.origin,
      x: c == null ? null : colOffsets.content(c) - colOffsets.origin,
    });
  }

  /** After the user's scroll: a view nearing the end of a window takes the window along with it. */
  function followWindows() {
    if (!rowOffsets.win && !colOffsets.win) return false;
    const view = viewMetrics();
    const at = (offsets, scroll, size) => (offsets.win ? offsets.fromCanvas(Math.min(scroll + offsets.win.keep + size / 2, offsets.total() - 1)) : null);
    return moveWindows({ y: at(rowOffsets, view.st, view.vh), x: at(colOffsets, view.sl, view.vw) });
  }

  /** Effective frozen area: what the sheet asks for, unless it would swallow the view. */
  function computeFrozen(view = viewMetrics()) {
    ensureOffsets();
    const s = sheet();
    if (!s) return false;
    if (s.split && s.kind !== 'chart' && !s.frozenRows && !s.frozenCols) return computeSplit(s, view);
    const r0 = laidOutOrigin?.r || 0, c0 = laidOutOrigin?.c || 0;
    // Page Layout view shows no frozen panes, as Excel's does not; the sheet keeps them for Normal view.
    let fr = s.frozenRows && !pageGeo ? Math.min(r0 + s.frozenRows, s.rows - 1) : 0;
    let fc = s.frozenCols && !pageGeo ? Math.min(c0 + s.frozenCols, s.cols - 1) : 0;
    let h = rowOffsets.at(fr) || 0;
    let w = colOffsets.at(fc) || 0;
    const vh = view.vh || 400;
    const vw = view.vw || 800;
    if (h > vh * 0.7) { fr = 0; h = 0; }
    if (w > vw * 0.7) { fc = 0; w = 0; }
    const was = frozen;
    frozen = { ...noPanes(), rows: fr, cols: fc, r0, c0, w, h, top: fr > 0, left: fc > 0 };
    return applyShift(was);
  }

  /**
   * A split window's panes: the bars where the sheet puts them (pixels at 100%, so they scale with the zoom,
   * kept inside the window), the top and left panes scrolled where they were, or where the sheet says.
   */
  function computeSplit(s, view) {
    const sp = s.split;
    if (paneScroll.sheet !== s.id || paneScroll.split !== sp || paneScroll.zoom !== zoom) {
      const r = Math.min(sp.r || 0, s.rows - 1), c = Math.min(sp.c || 0, s.cols - 1);
      paneScroll = { sheet: s.id, split: sp, zoom, sl: colOffsets.at(c) || 0, st: rowOffsets.at(r) || 0 };
    }
    const fit = (v, extent) => (extent > 0 ? Math.min(v, Math.max(0, extent - 12)) : v);
    const w = sp.x ? fit(Math.round(sp.x * zoom), view.vw) : 0;
    const h = sp.y ? fit(Math.round(sp.y * zoom), view.vh) : 0;
    const was = frozen;
    frozen = { ...noPanes(), w, h, split: true, left: w > 0, top: h > 0, sl: w ? paneScroll.sl : 0, st: h ? paneScroll.st : 0 };
    if (!frozen.left) splitPane.left = false;
    if (!frozen.top) splitPane.top = false;
    return applyShift(was);
  }

  /**
   * Move the canvas into the viewport by the split (or back), keeping what the scrolling pane shows where it
   * was. When the split goes the window shows what its top-left pane showed, as before the split was made.
   * True when the scroll changed.
   */
  function applyShift(was) {
    const x = frozen.split ? frozen.w : 0, y = frozen.split ? frozen.h : 0;
    if (x === shift.x && y === shift.y) return false;
    let sl = viewport.scrollLeft - shift.x, st = viewport.scrollTop - shift.y;
    if (was.split && !frozen.split) { if (was.left) sl = was.sl; if (was.top) st = was.st; }
    shift = { x, y };
    canvas.style.marginLeft = x ? `${x}px` : '';
    canvas.style.marginTop = y ? `${y}px` : '';
    scrollViewportTo(Math.max(-x, sl), Math.max(-y, st));
    return true;
  }

  function layoutFrozenLayers(view = viewMetrics()) {
    const cw = view.vw;
    const ch = view.vh;
    frzRows.el.hidden = !frozen.top;
    frzCols.el.hidden = !frozen.left;
    frzCorner.el.hidden = !(frozen.top && frozen.left);
    colHeadFrozen.hidden = !frozen.left;
    rowHeadFrozen.hidden = !frozen.top;
    root.classList.toggle('has-frozen-rows', frozen.rows > 0);
    root.classList.toggle('has-frozen-cols', frozen.cols > 0);
    root.classList.toggle('split-panes', frozen.split);
    splitV.hidden = !(frozen.split && frozen.left);
    splitH.hidden = !(frozen.split && frozen.top);
    if (!splitDrag) {
      splitV.style.transform = `translateX(${rowHeaderW + frozen.w}px)`;
      splitH.style.transform = `translateY(${colHeaderH + frozen.h}px)`;
    }
    layoutSplitScrollbars();
    if (frozen.top) { frzRows.el.style.width = `${cw}px`; frzRows.el.style.height = `${frozen.h}px`; }
    if (frozen.left) { frzCols.el.style.width = `${frozen.w}px`; frzCols.el.style.height = `${ch}px`; }
    if (frozen.top && frozen.left) { frzCorner.el.style.width = `${frozen.w}px`; frzCorner.el.style.height = `${frozen.h}px`; }
    colHeadFrozen.style.width = `${frozen.w}px`;
    rowHeadFrozen.style.height = `${frozen.h}px`;
    freezeV.style.left = `${rowHeaderW + frozen.w - 3}px`;
    freezeV.style.height = `${colHeaderH}px`;
    freezeH.style.top = `${colHeaderH + frozen.h - 3}px`;
    freezeH.style.width = `${rowHeaderW}px`;
    syncFrozenScroll(view);
  }

  /* ---------- Freeze bars ---------- */
  let freezeDrag = null; // { axis: 'col' | 'row', target }
  function freezeTarget(e, axis) {
    ensureOffsets();
    const vp = viewport.getBoundingClientRect();
    // Inside the frozen pane the content has not scrolled, as in cellAtPoint.
    if (axis === 'col') {
      const vx = e.clientX - vp.left;
      if (vx <= 6) return 0;
      return clamp(colOffsets.indexAt(contentX(vx)) + 1, 0, Math.max(0, sheet().cols - 1));
    }
    const vy = e.clientY - vp.top;
    if (vy <= 6) return 0;
    return clamp(rowOffsets.indexAt(contentY(vy)) + 1, 0, Math.max(0, sheet().rows - 1));
  }
  /** Screen position of the line before column or row `i`: lines up to the frozen edge do not scroll. */
  const lineX = (i) => colX(i) - (frozen.split ? bandSL(i) : i <= frozen.cols ? 0 : viewport.scrollLeft) + rowHeaderW;
  const lineY = (i) => rowY(i) - (frozen.split ? bandST(i) : i <= frozen.rows ? 0 : viewport.scrollTop) + colHeaderH;
  function freezeGuide(axis, target) {
    resizeGuide.hidden = false;
    resizeGuide.className = `resize-guide ${axis} move-ok`;
    if (axis === 'col') resizeGuide.style.transform = `translateX(${target ? lineX(target) : rowHeaderW}px)`;
    else resizeGuide.style.transform = `translateY(${target ? lineY(target) : colHeaderH}px)`;
  }
  for (const [bar, axis] of [[freezeV, 'col'], [freezeH, 'row']]) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (edit && !commitEdit()) return;
      freezeDrag = { axis, target: axis === 'col' ? frozen.cols : frozen.rows };
      bar.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
      viewport.focus({ preventScroll: true }); // so Escape, handled by the viewport, can give the drag up
      freezeGuide(axis, freezeDrag.target);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!freezeDrag) return;
      freezeDrag.target = freezeTarget(e, axis);
      freezeGuide(axis, freezeDrag.target);
    });
    const finish = (e) => {
      if (!freezeDrag) return;
      const { target } = freezeDrag;
      freezeDrag = null;
      bar.classList.remove('dragging');
      resizeGuide.hidden = true;
      if (e.type === 'pointerup') opts.onCommand?.('freeze', axis === 'col'
        ? { cols: Math.max(0, target - (frozen.c0 || 0)) } : { rows: Math.max(0, target - (frozen.r0 || 0)) });
      viewport.focus({ preventScroll: true });
    };
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);
  }

  function syncFrozenScroll(view = viewMetrics()) {
    frzRows.track.style.transform = `translate(${-view.sl}px, ${-frozen.st}px)`;
    frzCols.track.style.transform = `translate(${-frozen.sl}px, ${-view.st}px)`;
    frzCorner.track.style.transform = frozen.split ? `translate(${-frozen.sl}px, ${-frozen.st}px)` : '';
    // A split window's left and top panes scroll their own headings.
    root.style.setProperty('--pane-sl', `${-frozen.sl}px`);
    root.style.setProperty('--pane-st', `${-frozen.st}px`);
    if (!splitScrollV.hidden && Math.abs(splitScrollV.scrollTop - frozen.st) >= 1) splitScrollV.scrollTop = frozen.st;
    if (!splitScrollH.hidden && Math.abs(splitScrollH.scrollLeft - frozen.sl) >= 1) splitScrollH.scrollLeft = frozen.sl;
  }

  /* ---------- Split window ---------- */

  /** Content coordinates of a point in the viewport: a frozen band has not scrolled, a split window's panes each have their own scroll. */
  const contentX = (vx) => (vx < frozen.w ? vx + frozen.sl : vx + viewport.scrollLeft - shift.x);
  const contentY = (vy) => (vy < frozen.h ? vy + frozen.st : vy + viewport.scrollTop - shift.y);
  /** Is a cell drawn in the left (top) band: a frozen column (row), or in a split window, the active pane's side. */
  const leftBand = (c) => (frozen.split ? frozen.left && splitPane.left : c < frozen.cols);
  const topBand = (r) => (frozen.split ? frozen.top && splitPane.top : r < frozen.rows);
  /** How far the pane a cell is drawn in has scrolled. */
  const bandSL = (c, view = viewMetrics()) => (leftBand(c) ? frozen.sl : view.sl);
  const bandST = (r, view = viewMetrics()) => (topBand(r) ? frozen.st : view.st);

  /** Note the pane of a split window a press is in: it becomes the active pane. */
  function notePane(clientX, clientY) {
    if (!frozen.split) return;
    const vp = viewport.getBoundingClientRect();
    splitPane = { left: frozen.left && clientX - vp.left < frozen.w, top: frozen.top && clientY - vp.top < frozen.h };
  }

  /** Scroll the top and left panes of a split window (pixels of content at the panes' top-left). */
  function scrollSplitPanes(sl, st) {
    if (!frozen.split) return;
    ensureOffsets();
    const s = sheet();
    const nextL = frozen.left ? clamp(Math.round(sl), 0, Math.max(0, colOffsets.total() - frozen.w)) : 0;
    const nextT = frozen.top ? clamp(Math.round(st), 0, Math.max(0, rowOffsets.total() - frozen.h)) : 0;
    if (nextL === frozen.sl && nextT === frozen.st) return;
    paneScroll.sl = frozen.sl = nextL;
    paneScroll.st = frozen.st = nextT;
    wb.setSplitOrigin(sheetId, { r: rowOffsets.indexAt(nextT), c: colOffsets.indexAt(nextL) });
    syncHeaders();
    schedule();
  }

  /** Place the top and left panes' scrollbars over the window's own, where it draws them (not with overlay scrollbars). */
  function layoutSplitScrollbars() {
    const s = sheet();
    const sbw = viewport.offsetWidth - viewport.clientWidth, sbh = viewport.offsetHeight - viewport.clientHeight;
    splitScrollV.hidden = !(frozen.split && frozen.top && sbw > 0);
    splitScrollH.hidden = !(frozen.split && frozen.left && sbh > 0);
    if (!splitScrollV.hidden) {
      Object.assign(splitScrollV.style, { left: `${rowHeaderW + viewport.clientWidth}px`, top: `${colHeaderH}px`, width: `${sbw}px`, height: `${frozen.h}px` });
      splitScrollV.firstChild.style.height = `${rowOffsets.total()}px`;
      if (Math.abs(splitScrollV.scrollTop - frozen.st) >= 1) splitScrollV.scrollTop = frozen.st;
    }
    if (!splitScrollH.hidden) {
      Object.assign(splitScrollH.style, { left: `${rowHeaderW}px`, top: `${colHeaderH + viewport.clientHeight}px`, width: `${frozen.w}px`, height: `${sbh}px` });
      splitScrollH.firstChild.style.width = `${colOffsets.total()}px`;
      if (Math.abs(splitScrollH.scrollLeft - frozen.sl) >= 1) splitScrollH.scrollLeft = frozen.sl;
    }
  }
  splitScrollV.addEventListener('scroll', () => { if (Math.abs(splitScrollV.scrollTop - frozen.st) >= 1) scrollSplitPanes(frozen.sl, splitScrollV.scrollTop); }, { passive: true });
  splitScrollH.addEventListener('scroll', () => { if (Math.abs(splitScrollH.scrollLeft - frozen.sl) >= 1) scrollSplitPanes(splitScrollH.scrollLeft, frozen.st); }, { passive: true });

  /** The lines a pane of `size` pixels scrolled to `start` shows, with a few more either side. */
  function paneLines(offsets, start, size, count) {
    return [Math.max(0, offsets.indexAt(start) - BUFFER), Math.min(count - 1, offsets.indexAt(start + size) + BUFFER)];
  }

  /**
   * View ▸ Split: split the window above and left of the active cell as Excel does (in the middle when the
   * cell is the window's top-left one), or remove the split when there is one. Splitting unfreezes panes.
   */
  function toggleSplit() {
    const s = sheet();
    if (!s || s.kind === 'chart') return;
    if (edit && !commitEdit()) return;
    if (s.split && !s.frozenRows && !s.frozenCols) { wb.setSplit(sheetId, null); return; }
    ensureOffsets();
    const view = viewMetrics();
    const { r, c } = sel.active;
    const snap = (axis, v) => {
      const offsets = axis === 'x' ? colOffsets : rowOffsets, scroll = axis === 'x' ? view.sl : view.st;
      const i = offsets.indexAt(v + scroll);
      const a = offsets.at(i) - scroll, b = offsets.at(i + 1) - scroll;
      return v - a <= b - v && a > 0 ? a : b;
    };
    // Where the active cell is in the window, frozen panes included; setSplit unfreezes them.
    const at = splitAtCell({ cellX: colX(c) - bandSL(c, view), cellY: rowY(r) - bandST(r, view), width: view.vw, height: view.vh, snap });
    const origin = {
      r: frozen.rows ? frozen.r0 || 0 : frozen.split ? rowOffsets.indexAt(frozen.st) : rowOffsets.indexAt(Math.max(0, view.st)),
      c: frozen.cols ? frozen.c0 || 0 : frozen.split ? colOffsets.indexAt(frozen.sl) : colOffsets.indexAt(Math.max(0, view.sl)),
    };
    splitPane = { left: false, top: false };
    wb.setSplit(sheetId, { x: at.x / zoom, y: at.y / zoom, r: origin.r, c: origin.c });
  }

  for (const [bar, axis] of [[splitV, 'x'], [splitH, 'y']]) {
    const posOf = (e) => {
      const rect = root.getBoundingClientRect();
      return axis === 'x' ? e.clientX - rect.left - rowHeaderW : e.clientY - rect.top - colHeaderH;
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (edit && !commitEdit()) return;
      splitDrag = { axis, pos: axis === 'x' ? frozen.w : frozen.h };
      bar.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!splitDrag) return;
      const extent = axis === 'x' ? viewport.clientWidth : viewport.clientHeight;
      splitDrag.pos = clamp(posOf(e), 0, extent);
      bar.style.transform = axis === 'x' ? `translateX(${rowHeaderW + splitDrag.pos}px)` : `translateY(${colHeaderH + splitDrag.pos}px)`;
    });
    const finish = (e) => {
      if (!splitDrag) return;
      const { pos } = splitDrag;
      splitDrag = null;
      bar.classList.remove('dragging');
      const s = sheet();
      if (e.type === 'pointerup' && s?.split) {
        const extent = axis === 'x' ? viewport.clientWidth : viewport.clientHeight;
        let at = dropSplit(pos, extent);
        // A bar comes to rest on the line between two cells of the pane before it, as in Excel.
        if (at) {
          const offsets = axis === 'x' ? colOffsets : rowOffsets, scroll = axis === 'x' ? frozen.sl : frozen.st;
          const i = offsets.indexAt(at + scroll);
          const a = offsets.at(i) - scroll, b = offsets.at(i + 1) - scroll;
          at = at - a <= b - at && a > 0 ? a : b;
        }
        const next = { ...s.split, [axis]: at / zoom };
        // The panes the bar opens start where the pane beside them is, so the window shows what it did.
        if (!s.split[axis] && at) {
          const view = viewMetrics();
          if (axis === 'x') { paneScroll.sl = Math.max(0, view.sl); next.c = colOffsets.indexAt(paneScroll.sl); }
          else { paneScroll.st = Math.max(0, view.st); next.r = rowOffsets.indexAt(paneScroll.st); }
        }
        wb.setSplit(sheetId, next.x || next.y ? next : null);
      }
      schedule();
      viewport.focus({ preventScroll: true });
    };
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);
    bar.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const s = sheet();
      if (!s?.split) return;
      const next = { ...s.split, [axis]: 0 };
      wb.setSplit(sheetId, next.x || next.y ? next : null);
      viewport.focus({ preventScroll: true });
    });
  }

  /**
   * Where a cell's editor lives: in the canvas, scrolling with the cell, unless the cell is
   * frozen. The frozen panes are drawn over the canvas and each clips its own layer, so an entry
   * typed into a frozen cell would be cut at the pane's edge as it grew; the grid itself hosts
   * that editor, outside any clip, at the cell's place on the screen (as it hosts the popovers).
   */
  const editorHost = (r, c) => (topBand(r) || leftBand(c) ? root : canvas);

  /** Put the editor at its cell: canvas coordinates in the canvas, screen coordinates (headers and scroll counted) when the grid hosts it. */
  function placeEditor(view = viewMetrics()) {
    if (!edit || edit.sheetId !== sheetId) return;
    const { r, c } = edit;
    if (editor.parentNode !== root) {
      editor.style.left = `${colX(c)}px`;
      editor.style.top = `${rowY(r)}px`;
      editor.style.clipPath = '';
      return;
    }
    const left = rowHeaderW + colX(c) - bandSL(c, view);
    const top = colHeaderH + rowY(r) - bandST(r, view);
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
    // Scrolled partly under the headers along its free axis, the editor is cut there, as the pane's
    // edge cut it before; hiding it instead would take the focus from it and commit the entry.
    const cutL = Math.max(0, rowHeaderW - left);
    const cutT = Math.max(0, colHeaderH - top);
    editor.style.clipPath = cutL || cutT ? `inset(${cutT}px 0 0 ${cutL}px)` : '';
  }

  const rowHidden = (s, r) => s.hiddenRows.has(r) || s.filterHidden.has(r);
  // Every reader of the offsets comes through here or through ensureOffsets, so a pending layout change is laid out first.
  const colX = (c) => { ensureOffsets(); return colOffsets.at(c); };
  const colW = (c) => { ensureOffsets(); return colOffsets.size(c); };
  const rowY = (r) => { ensureOffsets(); return rowOffsets.at(r); };
  const rowH = (r) => { ensureOffsets(); return rowOffsets.size(r); };
  // Where a line ends: the next one's start, except in Page Layout view, where a page's margins and the gap
  // between pages lie between the last line of one page and the first of the next.
  const colEnd = (c) => { ensureOffsets(); return colOffsets.end(c); };
  const rowEnd = (r) => { ensureOffsets(); return rowOffsets.end(r); };
  // Commands and keys treat every sheet as Excel's whole grid (A1:XFD1048576); the canvas holds the part reached so far.
  const bounds = () => { const s = sheet(); return { rows: Math.max(s.rows, MAX_ROWS), cols: Math.max(s.cols, MAX_COLS) }; };

  function cellAtPoint(clientX, clientY) {
    ensureOffsets();
    const vp = viewport.getBoundingClientRect();
    const vx = clientX - vp.left;
    const vy = clientY - vp.top;
    // Inside a frozen pane the content has not scrolled; a split window's panes each have their own scroll.
    const x = contentX(vx);
    const y = contentY(vy);
    const s = sheet();
    return {
      r: clamp(rowOffsets.indexAt(y), 0, s.rows - 1),
      c: clamp(colOffsets.indexAt(x), 0, s.cols - 1),
    };
  }

  function rangeBox(range) {
    ensureOffsets();
    const n = normalizeRange(range);
    const s = sheet();
    const r2 = Math.min(n.r2, s.rows - 1);
    const c2 = Math.min(n.c2, s.cols - 1);
    return { left: colX(n.c1), top: rowY(n.r1), width: colEnd(c2) - colX(n.c1), height: rowEnd(r2) - rowY(n.r1) };
  }

  /** Where the selection's fill handle is on the screen, and whether a frozen pane has scrolled over it. */
  function handlePlace(view = viewMetrics()) {
    const range = S.selRange(sel);
    const box = rangeBox(range);
    const vx = box.left + box.width - bandSL(range.c2, view);
    const vy = box.top + box.height - bandST(range.r2, view);
    // A selection lying wholly in hidden lines has no extent, and so no handle to draw or press.
    const gone = !box.width || !box.height;
    // Out of its pane: under the band beside it, or in a split window's left or top pane, past the bar.
    const outX = leftBand(range.c2) ? frozen.split && vx > frozen.w : vx < frozen.w;
    const outY = topBand(range.r2) ? frozen.split && vy > frozen.h : vy < frozen.h;
    const hidden = gone || outX || outY;
    return { range, vx, vy, gone, hidden };
  }

  /**
   * Is the pointer on the selection's fill handle, wherever it is drawn? A protected sheet has
   * none, and one scrolled under a frozen pane is out of sight: the pane lets the press through,
   * but it is meant for the frozen cell drawn over the handle.
   */
  function onFillHandle(clientX, clientY, target = null) {
    if (edit || wb.isProtected(sheetId)) return false;
    const { range, vx, vy, hidden } = handlePlace();
    if (hidden) return false;
    // A press the browser reports on the handle itself has its whole hit area, but only where the
    // canvas's own handle is the one drawn: inside a frozen band a clone stands for it.
    if (target === fillHandle && !leftBand(range.c2) && !topBand(range.r2)) return true;
    const vp = viewport.getBoundingClientRect();
    const reach = coarsePointer ? 12 : 7; // a finger gets the handle's larger drawn target
    return Math.abs(clientX - vp.left - vx) <= reach && Math.abs(clientY - vp.top - vy) <= reach;
  }

  /**
   * Does a press on an overlay that scrolls with the cells land where a frozen pane covers it? The
   * pane is opaque but lets pointer events through, so the hidden chart or handle would take the
   * press meant for the frozen cell drawn over it.
   */
  function underFrozenPane(node, clientX, clientY) {
    if (!frozen.top && !frozen.left) return false;
    if (node.closest('.frz-layer')) return false; // drawn in the pane itself
    const vp = viewport.getBoundingClientRect();
    return clientX - vp.left < frozen.w || clientY - vp.top < frozen.h;
  }

  /** Is the pointer on the selection's border (but not its fill handle)? Nothing moves on a protected sheet. */
  function onSelectionBorder(clientX, clientY) {
    if (edit || wb.isProtected(sheetId) || onFillHandle(clientX, clientY)) return false;
    const range = S.selRange(sel);
    const box = rangeBox(range);
    if (!box.width || !box.height) return false; // wholly in hidden lines: nothing to take hold of
    const vp = viewport.getBoundingClientRect();
    // Inside a frozen pane the content has not scrolled, as in cellAtPoint.
    const vx = clientX - vp.left;
    const vy = clientY - vp.top;
    const x = contentX(vx);
    const y = contentY(vy);
    // A frozen pane draws the selection's outline clipped to its own band, so a box that begins
    // outside the band has no outline there, and the canvas's own has scrolled under the pane: the
    // press is for the frozen cell drawn in its place, as handlePlace already decides for the fill
    // handle. Without this a 4px strip at the pane's inner edge would take hold of — and on release
    // move — a selection scrolled out of sight.
    if (!frozen.split && vx < frozen.w && box.left >= frozen.w && box.left - viewport.scrollLeft < frozen.w) return false;
    if (!frozen.split && vy < frozen.h && box.top >= frozen.h && box.top - viewport.scrollTop < frozen.h) return false;
    const edge = 4;
    const inside = x >= box.left - edge && x <= box.left + box.width + edge && y >= box.top - edge && y <= box.top + box.height + edge;
    if (!inside) return false;
    const nearX = Math.abs(x - box.left) <= edge || Math.abs(x - (box.left + box.width)) <= edge;
    const nearY = Math.abs(y - box.top) <= edge || Math.abs(y - (box.top + box.height)) <= edge;
    if (!nearX && !nearY) return false;
    // Which edge: the one nearest the pointer (a double-click on it jumps that way, as in Excel).
    const gaps = [['top', Math.abs(y - box.top)], ['bottom', Math.abs(y - (box.top + box.height))], ['left', Math.abs(x - box.left)], ['right', Math.abs(x - (box.left + box.width))]];
    return gaps.sort((a, b) => a[1] - b[1])[0][0];
  }

  /**
   * Why the workbook would not move the dragged block to dst, protection aside
   * (it reports that itself): the rules of Workbook.moveRange, in its order.
   */
  function moveProblem(src, dst) {
    if ((src.r2 - src.r1 + 1) * (src.c2 - src.c1 + 1) > 200000) return 'Select at most 200,000 cells to move at once';
    const s = sheet();
    const overlaps = (a, b) => !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
    const inside = (a, b) => a.r1 >= b.r1 && a.r2 <= b.r2 && a.c1 >= b.c1 && a.c2 <= b.c2;
    for (let r = src.r1; r <= src.r2; r++) for (let c = src.c1; c <= src.c2; c++) {
      const a = wb.spillAt(sheetId, r, c)?.anchor;
      if (a && !(a.r >= src.r1 && a.r <= src.r2 && a.c >= src.c1 && a.c <= src.c2)) return `Part of an array cannot be moved without its formula in ${cellName(a.r, a.c)}`;
    }
    const torn = s.tables.find((t) => overlaps(t.range, src) && !inside(t.range, src) && !inside(src, t.range));
    if (torn) return `Table ${torn.name} cannot be split: move the whole table, or cells outside it`;
    const dr = dst.r1 - src.r1;
    const dc = dst.c1 - src.c1;
    const shifted = (m) => ({ r1: m.r1 + dr, c1: m.c1 + dc, r2: m.r2 + dr, c2: m.c2 + dc });
    const landing = s.tables.find((t) => inside(t.range, src) && s.tables.some((o) => !inside(o.range, src) && overlaps(shifted(t.range), o.range)));
    if (landing) return `Table ${landing.name} cannot be dropped on another table`;
    return 'Those cells cannot be moved there';
  }

  function place(node, box) {
    node.style.transform = `translate(${box.left}px, ${box.top}px)`;
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
  }

  /* ---------- Rendering ---------- */

  function schedule() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  /**
   * The viewport's scroll offsets and size, read together. A frame reads them once, before it
   * writes any node: a read after the writes would make the browser lay the new nodes out there
   * and then, so every function that needs them takes the frame's reading, or reads its own.
   */
  function viewMetrics() {
    return { sl: viewport.scrollLeft - shift.x, st: viewport.scrollTop - shift.y, vw: viewport.clientWidth, vh: viewport.clientHeight };
  }

  function visibleRange(view = viewMetrics()) {
    ensureOffsets();
    const s = sheet();
    const { st, sl, vh, vw } = view;
    const r0 = Math.max(0, rowOffsets.indexAt(st) - BUFFER);
    const r1 = Math.min(s.rows - 1, rowOffsets.indexAt(st + vh) + BUFFER);
    const c0 = Math.max(0, colOffsets.indexAt(sl) - BUFFER);
    const c1 = Math.min(s.cols - 1, colOffsets.indexAt(sl + vw) + BUFFER);
    return { r0, r1, c0, c1 };
  }

  function isEmptyAt(s, r, c) {
    if (mergeAt(r, c) || nativeSparklineAt(wb, s.id, r, c)) return false;
    const cell = s.cells.get(cellKey(r, c));
    return (!cell || (cell.v == null && cell.f == null)) && !wb.spillAt(s.id, r, c);
  }

  /**
   * The format a cell is drawn in: its own style over the one its column or row carries, as
   * `Workbook.styleAt` reads them, so a format given to a whole column reaches every row of it and
   * not only the rows the sheet had already stored. A sheet with no whole-line format — nearly every
   * sheet — makes the one map lookup it always made, so drawing a screenful costs what it did.
   */
  function baseStyleAt(s, r, c) {
    const base = wb.defaultStyle(s) || s.colStyles?.size || s.rowStyles?.size || s.styleResets?.length ? wb.styleAt(s.id, r, c) : s.cells.get(cellKey(r, c))?.s;
    return wb._pivotDisplayStyle(s.id, r, c, base);
  }

  function styleAt(s, r, c) {
    const own = baseStyleAt(s, r, c);
    return s.tables.some(t => t.customStyle) ? { ...wb._tableStyleAt(s, r, c), ...own } : own;
  }

  /** The column's and row's own share of that format, which a cell's style and a spill's format stand over; null for none. */
  function lineStyleAt(s, r, c) {
    return wb._lineStyle(s, r, c);
  }

  /**
   * Does a blank cell show ink of its own (as buildCell draws it): a fill — its own, or one a rule
   * or a table paints — or a border? A label whose text runs over such a cell keeps its opaque
   * backing clear of it, so the box around it, the rule line or the totals underline still shows.
   * Only the cell's own border sides are asked for: a shared edge is drawn by whichever of the two
   * cells owns it, and a cell under a merge is never reached, the run stopping at the merge itself.
   */
  function paintedAt(s, r, c) {
    const st = styleAt(s, r, c);
    if (st?.bg || st?.bt || st?.bl || st?.bb || st?.br) return true;
    return s.rules.length || s.tables.length ? !!wb.conditionalStyle(s.id, r, c, null)?.bg : false;
  }

  /** True for cells hidden under a merge anchor (not the anchor itself). */
  function coveredByMerge(r, c) {
    const m = mergeAt(r, c);
    return !!m && (m.r1 !== r || m.c1 !== c);
  }

  /**
   * The nearest shown row above r, or column left of c: the one holding the pixel before the
   * cell's edge, so hidden lines (which have no width) are passed over. -1 at the sheet's edge.
   * A border yields only to a neighbour that is drawn; one hidden with its line takes nothing away.
   */
  // Page Layout view: cells on different pages are not neighbours, so each draws its own edge.
  const shownAbove = (r) => (pageGeo ? pageNeighbor(rowOffsets, r, -1, pageGeo.rowStarts) : rowY(r) > 0 ? rowOffsets.indexAt(rowY(r) - 1) : -1);
  const shownLeft = (c) => (pageGeo ? pageNeighbor(colOffsets, c, -1, pageGeo.colStarts) : colX(c) > 0 ? colOffsets.indexAt(colX(c) - 1) : -1);

  const shownBelow = r => pageGeo ? pageNeighbor(rowOffsets, r, 1, pageGeo.rowStarts) : rowY(r) + rowH(r) < rowOffsets.total() ? rowOffsets.indexAt(rowY(r) + rowH(r)) : -1;
  const shownRight = c => pageGeo ? pageNeighbor(colOffsets, c, 1, pageGeo.colStarts) : colX(c) + colW(c) < colOffsets.total() ? colOffsets.indexAt(colX(c) + colW(c)) : -1;
  /** The nearest shown line before (dir -1) or after (dir 1) line i on the same page, or -1. */
  function pageNeighbor(offsets, i, dir, starts) {
    ensureOffsets();
    for (let j = i; ; j += dir) {
      if (dir < 0 ? starts.has(j) || j <= 0 : starts.has(j + 1) || j + 1 >= offsets.n) return -1;
      const k = j + dir;
      if (offsets.end(k) > offsets.at(k)) return k;
    }
  }
  let resolveBorders;

  // Header lookup is reused by painting, hit testing and auto-fit. Index by row
  // so a workbook with many tables does not scan every filter for every cell.
  let filterIndex = null;
  function filterHeadAt(s, r, c) {
    if (!filterIndex || filterIndex.sheet !== s || filterIndex.current !== s.filter || filterIndex.other !== s.otherFilters) {
      const rows = new Map();
      for (const f of wb.filtersForSheet(s.id)) {
        if (!rows.has(f.range.r1)) rows.set(f.range.r1, []);
        rows.get(f.range.r1).push(f);
      }
      filterIndex = { sheet: s, current: s.filter, other: s.otherFilters, rows };
    }
    return filterIndex.rows.get(r)?.find(f => f.showButtons !== false && c >= f.range.c1 && c <= f.range.c2 && !f.hiddenButtons?.includes(c)) || null;
  }

  /**
   * The room a cell's decorations take from its text, as grid.css draws them: the padding kept on
   * the right for a filter button or a dropdown chevron beyond the cell's own, a chip's padding
   * around its label, and an icon set's glyph with the gap after it. Auto-fit asks for it so the
   * fitted column shows the whole text, and a number that does not fit beside them is shortened.
   * (A chip's label is drawn a little smaller; measured at the cell's size it stays on the safe side.)
   */
  function decorationWidth(filterHead, rule, cf, font) {
    let width = filterHead ? FILTER_BUTTON_W : rule?.type === 'list' && rule.chips ? LIST_CHEVRON_W : 0;
    if (rule?.type === 'list' && rule.chips) width += CHIP_PAD;
    if (cf?.icon) width += (cf.iconImage ? 16 : textWidth(cf.icon, font.replace(/[\d.]+px/, (px) => `${(parseFloat(px) * 0.8).toFixed(2)}px`))) + ICON_GAP;
    return width;
  }

  // Partial merged sides belong to a separate paint layer: the cell's text
  // remains clipped, while its independently styled perimeter stays complete.
  const mergedBorderPaint = new WeakMap();
  let borderView;
  function mergePaintLines(first, last, intervals, hidden) {
    const lines = new Set();
    for (const [start, end] of intervals) for (let n = Math.max(first, start); n <= Math.min(last, end); n++) {
      if (!hidden(n)) lines.add(n);
    }
    return [...lines].sort((a, b) => a - b);
  }
  function appendCell(row, cell) {
    row.append(cell);
    const paint = mergedBorderPaint.get(cell);
    if (paint) row.append(paint);
  }

  function buildCell(s, r, c) {
    const cell = s.cells.get(cellKey(r, c));
    const node = document.createElement('div');
    node.className = 'cell';
    node.id = `gc-${r}-${c}`;
    node.setAttribute('role', 'gridcell');
    node.setAttribute('aria-colindex', String(c + 1));
    node.dataset.r = r;
    node.dataset.c = c;
    const merge = mergeAt(r, c);
    let w = colW(c);
    let h = rowH(r);
    if (merge) {
      // Only the anchor is built; it spans the whole merged block.
      w = colEnd(Math.min(merge.c2, s.cols - 1)) - colX(c);
      h = rowEnd(Math.min(merge.r2, s.rows - 1)) - rowY(r);
      node.classList.add('merged');
      node.setAttribute('aria-colspan', String(merge.c2 - merge.c1 + 1));
      node.setAttribute('aria-rowspan', String(merge.r2 - merge.r1 + 1));
    }
    const paintSparkline = () => {
      const data = nativeSparklineData(wb, s.id, r, c);
      if (!data) return;
      node.classList.add('has-native-sparkline');
      const decoration = nativeSparklineNode(data, Math.max(0, w / zoom - 2), Math.max(0, h / zoom - 2));
      decoration.style.width = `${Math.max(0, w - 2)}px`;
      decoration.style.left = 'calc(var(--spill-own-x, 0px) + 1px)';
      node.append(decoration);
    };
    node.style.left = `${colX(c)}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    const note = s.notes.get(cellKey(r, c));
    if (note) { node.classList.add('has-note'); node.title = note; }
    const thread = s.comments?.get(cellKey(r, c));
    if (thread) node.classList.add('has-comment', ...(thread.done ? ['comment-done'] : []));
    const filterHead = filterHeadAt(s, r, c);
    if (filterHead) {
      node.classList.add('filter-head');
      if (filterHead.criteria[c]) node.classList.add('filter-on');
    }
    const rule = s.validations.length ? wb.validationAt(s.id, r, c) : null;
    // A checkbox is the cell's content, drawn in place of its text: the cell keeps its fill, borders,
    // rule and table coat like any other. It stays a gridcell of its row, which may own nothing else;
    // the box drawn inside it carries the checkbox role and state.
    const checkbox = rule?.type === 'checkbox';
    const drawCheckbox = () => {
      const on = cell?.f == null ? cell?.v === true : wb.getValue(s.id, r, c) === true;
      node.classList.add('checkbox', on ? 'checked' : 'unchecked');
      const box = el('span.checkbox-box', { role: 'checkbox', 'aria-checked': String(on) });
      if (rule.checkboxStyle === 'excel') {
        node.classList.add('excel-checkbox');
        box.style.width = box.style.height = `${13 * zoom}px`;
        if (Number.isFinite(rule.checkboxOffset)) {
          box.style.position = 'absolute';
          box.style.left = `${Math.max(0, Math.min(rule.checkboxOffset * zoom, w - 13 * zoom))}px`;
          box.style.top = '50%';
          box.style.transform = 'translateY(-50%)';
        }
      }
      node.append(box);
    };
    if (rule?.type === 'list') {
      node.classList.add('has-list');
      if (rule.chips) node.classList.add('list-inline');
    }
    if (rule && !checkbox && cell && (cell.v != null || cell.f != null) && !wb.validateCell(s.id, r, c).ok) {
      node.classList.add('invalid');
      node.title = wb.validateCell(s.id, r, c).message || 'Invalid value';
    } else if (cell && (cell.v != null || cell.f != null) && errorCheckAt(wb, s.id, r, c)) {
      // Excel's background error checking: the green triangle in the cell's corner.
      node.classList.add('err-flag');
    }
    // Resolve shared edges before painting either cell. Merged perimeters
    // use the same comparison independently for each visible segment.
    const borders = (st, cf = null) => {
      const table = s.tables.some(t => t.customStyle) ? wb._tableStyleAt(s, r, c) : null;
      const conditional = table ? (s.rules.length ? wb.conditionalStyle(s.id, r, c, wb.getValue(s.id, r, c), { banding: false }) : null) : cf;
      const resolved = merge ? null : resolveBorders(r, c, table ? baseStyleAt(s, r, c) : st, conditional, table);
      const sideStyle = key => resolved?.[key] ? resolved[`${key}Border`] : null;
      const edge = (side, cls, style, css = null) => {
        if (!style) return;
        node.classList.add(cls);
        if (style.bc || style.bs || css) {
          const b = css || borderCss(style);
          node.style[`border${side}Width`] = b.width;
          node.style[`border${side}Style`] = b.style;
          if (b.color) node.style[`border${side}Color`] = b.color;
        }
      };
      if (merge) {
        // A merge can span the entire sheet. Visit only the viewport and
        // frozen bands, retaining positions within the full merged box.
        const rows = mergePaintLines(merge.r1, Math.min(merge.r2, s.rows - 1),
          [[borderView.r0, borderView.r1], [frozen.r0, frozen.rows - 1]], r => rowHidden(s, r));
        const cols = mergePaintLines(merge.c1, Math.min(merge.c2, s.cols - 1),
          [[borderView.c0, borderView.c1], [frozen.c0, frozen.cols - 1]], c => s.hiddenCols.has(c));
        const segments = mergeBorderSegments(merge, rows, cols, rowH, colW, (r, c) => {
          const rule = s.rules.length ? wb.conditionalStyle(s.id, r, c, wb.getValue(s.id, r, c), { banding: false }) : null;
          return resolveBorders(r, c, baseStyleAt(s, r, c), rule, s.tables.some(t => t.customStyle) ? wb._tableStyleAt(s, r, c) : null);
        }, { width:w, height:h, rowPosition:r => rowY(r) - rowY(merge.r1), colPosition:c => colX(c) - colX(merge.c1) });
        let paint;
        for (const part of segments) {
          const side = { bt:'Top', bb:'Bottom', bl:'Left', br:'Right' }[part.side];
          if (part.start === 0 && part.end === 1) {
            edge(side, part.side, {}, part);
            continue;
          }
          if (!paint) paint = el('div.merged-border-paint', { 'aria-hidden':'true', style: {
            position:'absolute', left:`${colX(c)}px`, top:'0', width:`${w}px`, height:`${h}px`, pointerEvents:'none', zIndex:'2',
          } });
          const horizontal = part.side === 'bt' || part.side === 'bb';
          const segment = el('span', { style: { position:'absolute', boxSizing:'border-box',
            left:`${horizontal ? part.start * w : 0}px`, top:`${horizontal ? 0 : part.start * h}px`,
            width:`${horizontal ? (part.end - part.start) * w : w}px`, height:`${horizontal ? h : (part.end - part.start) * h}px`,
            [`border${side}`]:`${part.width} ${part.style} ${part.color || 'var(--ink)'}`,
          } });
          paint.append(segment);
        }
        if (paint) mergedBorderPaint.set(node, paint);
        return;
      }
      edge('Top', 'bt', sideStyle('bt'));
      edge('Left', 'bl', sideStyle('bl'));
      edge('Bottom', 'bb', sideStyle('bb'));
      edge('Right', 'br', sideStyle('br'));
    };
    // A blank cell may show part of an array formula that spilled over it.
    const spill = !cell || (cell.v == null && cell.f == null) ? wb.spillAt(s.id, r, c) : null;
    // The format its column or row carries, which the cell stores nothing for: a blank cell in such a
    // line is drawn with its fill and borders like any other, so a format given to a whole column
    // paints every row of it rather than stopping where the stored cells do.
    const lines = lineStyleAt(s, r, c);
    if (!cell && !spill && !lines && !wb.hasNativePivotDisplay(s.id)) {
      // Blank cells can still be painted by a rule (empty, formula, color), or wear a table's band or header coat.
      if (s.rules.length || s.tables.length) {
        const cf = wb.conditionalStyle(s.id, r, c, null);
        if (cf?.bg) { paintCellFill(node, cf.bg); node.classList.add('cf'); }
        borders(null, cf);
      }
      else if (merge) borders(null);
      if (checkbox) drawCheckbox();
      paintSparkline();
      return node;
    }

    // The spill's number format comes from its anchor and stands over the line's, so a spilled value reads as the anchor does.
    let st = spill ? { ...lines, ...(spill.style || {}), ...(cell?.s || {}) } : lines ? { ...lines, ...cell?.s } : cell?.s;
    st = wb._pivotDisplayStyle(s.id, r, c, st);
    let value = null;
    let text = '';
    if (spill) {
      value = spill.value;
      text = cellLayoutText(formatValue(value, st), st?.wrap);
      node.classList.add('arr');
    } else if (cell && (cell.v != null || cell.f != null)) {
      value = wb.getValue(s.id, r, c);
      text = cellLayoutText(formatValue(value, st), st?.wrap);
    }
    if (value === 0 && s.zeros === false && !showFormulas) text = '';
    // Formula view draws the formula in place of the result (below, once the picture and checkbox
    // cases have had their say). It is laid out from its own cell, reading left to right, whatever
    // the result's alignment and direction are: taken from the result instead, a centred or
    // right-aligned formula was drawn a column or two left of the cell it belongs to.
    const asFormula = showFormulas && cell?.f != null && !checkbox && !(s.protected && wb.formulaHiddenAt(s.id, r, c));
    // Text whose first letter reads right to left is laid out that way (the box's direction, which
    // its text takes) and, given no alignment, sits at its end, the right, as Sheets and Excel's
    // Context order have it. The alignment classes name the box's start and end, so an alignment
    // that is set is mapped to the side it names.
    const rtl = !asFormula && typeof value === 'string' && RTL_LEAD.test(text);
    const align = asFormula ? 'left' : st?.align || (rtl ? 'right' : defaultAlign(value));
    if (rtl) node.setAttribute('dir', 'rtl');
    node.classList.add((rtl ? align === 'left' : align === 'right') ? 'ar' : align === 'center' ? 'ac' : 'al');
    const cf = s.rules.length || s.tables.length ? wb.conditionalStyle(s.id, r, c, value) : null;
    st = conditionalFontStyle(st, cf);
    // A cell's own fill shows through the table's coat (its bands and header colours); a rule's fill paints over both.
    const coated = !!cf?.bg && nativeFillOverridesNormal(st, wb.nativeNormalFill) && cf.coat;
    if (cf) {
      if (cf.bg && !coated) paintCellFill(node, cf.bg, wb.nativeDefaultCellFormat?.style.bg ? 'var(--surface, #ffffff)' : null);
      if (cf.color) node.style.color = fontColorCss(cf.color);
      if (cf.bar != null) {
        paintDataBar(node, cf);
      }
      node.classList.add('cf');
    }
    if (typeof value === 'number') node.classList.add('num');
    if (isError(value)) { node.classList.add('err'); node.title = wb.errorHelpAt(s.id, r, c) || errorHelp(value.error); }
    // A picture or a sparkline is the cell's content in place of its text; the cell's fill and borders are drawn as for any other.
    let picture = false;
    if (value && typeof value === 'object' && value.image && !showFormulas) {
      node.classList.add('img-cell', `fit-${value.fit || 'contain'}`);
      node.append(el('img', { src: value.image, alt: '', draggable: false, loading: 'lazy' }));
      node.title = value.image.startsWith('data:') ? 'Image' : value.image;
      picture = true;
    } else if (value && typeof value === 'object' && value.sparkline && !showFormulas) {
      node.classList.add('sparkline');
      node.innerHTML = renderSparklineSvg(value, w - 2, h - 2);
      node.title = `Sparkline of ${value.values.filter((v) => v !== null).length} values`;
      picture = true;
    }
    if (picture || checkbox) text = '';
    if (!spill && (cell?.f != null || typeof value === 'string')) {
      const link = wb.linkAt(s.id, r, c);
      if (link) { node.classList.add('link'); node.title = link.url; }
    }
    const size = st?.size || null;
    if (size) node.style.fontSize = `${(size * zoom).toFixed(2)}px`;
    const family = fontStack(st?.font);
    if (st?.font === 'calibri') node.classList.add('calibri');
    if (family) node.style.fontFamily = family;
    if (st?.indent) {
      // Keep the ordinary text margin when moving the aligned origin.
      const indent = (cellIndent(value, { ...st, align }) + CELL_TEXT_INSET) * zoom;
      // Inline indentation must retain the space reserved by grid.css for
      // controls. Their hit areas stay fixed in pixels when the grid zooms.
      const control = filterHead ? FILTER_BUTTON_W : rule?.type === 'list' && rule.chips ? LIST_CHEVRON_W : 0;
      if (align === 'right') node.style.paddingRight = `${Math.max(indent, control ? control + CELL_TEXT_INSET * zoom : 0)}px`;
      else if (align !== 'center') node.style.paddingLeft = `${indent}px`;
    }
    if (st?.valign === 'top') node.classList.add('vt');
    else if (st?.valign === 'middle') node.classList.add('vm');
    else if (st?.valign === 'bottom') node.classList.add('vb');
    borders(st, cf);
    if (st) {
      if (st.bold) node.classList.add('b');
      else if (cf?.bold === false) node.style.fontWeight = '400';
      if (st.italic) node.classList.add('i');
      if (st.underline) node.classList.add('u');
      if (st.underline === false || st.strike === false) node.style.textDecoration = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
      if (st.strike) node.classList.add('s');
      if (st.wrap && !picture && !checkbox) node.classList.add('wrap'); // wrapping lays text out; a picture or box stays centred
      // A format code's numeric or text section color wins over the font color.
      const sectionColor = !cf?.color && st.fmt === 'custom' && st.code ? codeColor(value, st.code, wb.colorPalette) : null;
      if (sectionColor) node.style.color = sectionColor;
      else if (st.color && !cf?.color) node.style.color = fontColorCss(st.color);
      if ((st.bg || coated || wb.nativeDefaultCellFormat?.style.bg && !cf?.bg) && (!cf?.bg || coated)) {
        paintCellFill(node, st.bg, wb.nativeDefaultCellFormat?.style.bg ? 'var(--surface, #ffffff)' : null);
      }
    }
    if (asFormula) {
      // Formula view: the formula itself instead of its result; `align` and `dir` were settled for it above.
      text = `=${cell.f}`;
      node.classList.add('formula-text');
    }
    if ((cf?.barOnly || cf?.iconOnly) && !showFormulas) text = '';
    if (cf?.icon && !showFormulas) {
      // Icon sets: a colored glyph before the value (or instead of it).
      node.classList.add('has-icon');
    }
    // The editor owns the live text. Keep the cell's fill and borders, but do not
    // paint its saved label underneath: shrinking the editor would expose the old overflow.
    if (edit?.sheetId === s.id && edit.r === r && edit.c === c) {
      paintSparkline();
      return node;
    }
    const formatParts = !showFormulas && !picture && !checkbox && !cf?.barOnly && !cf?.iconOnly && !(value === 0 && s.zeros === false) ? numberFormatParts(value, st, cell?.richText) : null;
    let formatFont = `${st?.italic ? 'italic ' : ''}${st?.bold ? '600 ' : ''}${size ? cellFont.replace(/^[\d.]+px/, `${(size * zoom).toFixed(2)}px`) : cellFont}`;
    if (family) formatFont = formatFont.replace(/px\s.*$/, `px ${family}`);
    let measurePart = richTextMeasure(formatFont, textWidth, zoom);
    const richOptions = { style: st, zoom,
      color: cf?.color || (st?.fmt === 'custom' ? codeColor(value, st.code, wb.colorPalette) : null) };
    if (st?.shrink && !st.wrap && !showFormulas && !picture && !checkbox && text) {
      const padding = cellHorizontalPadding(cellIndent(value, st), zoom) + 1 + decorationWidth(filterHead, rule, cf, formatFont);
      const fit = shrinkCellText({ text, parts: formatParts, font: formatFont, zoom, width: w - padding, angle: st.rot || 0, measure: textWidth });
      formatFont = fit.font; measurePart = fit.measure; richOptions.zoom = fit.zoom;
      node.style.fontSize = `${Number(/([\d.]+)px/.exec(formatFont)?.[1])}px`;
    }
    if (formatParts?.some(part => part.rich)) {
      // Text decorations propagate through descendants, so put them on each
      // character run instead of an ancestor that a regular run cannot reset.
      node.classList.remove('u', 's');
      node.style.textDecoration = 'none';
    }
    if (checkbox) drawCheckbox();
    const chip = text && !showFormulas && rule?.type === 'list' && rule.chips ? wb.chipAt(s.id, r, c, rule) : null;
    if (chip) {
      // A dropdown value drawn as a colored pill.
      node.classList.add('chip-cell');
      node.append(el('span.chip', { style: { backgroundColor: chip.bg, color: chip.color } }, text));
    } else if ((text || formatParts) && st?.rot && !showFormulas) {
      // Rotated text: an inner span turned by the angle. At ±90° the glyphs
      // are laid out vertically so they stack cleanly instead of overflowing.
      const rot = st.rot;
      const span = el('span.rot-text', {}, text);
      if (formatParts) {
        const fontSize = Number(/([\d.]+)px/.exec(formatFont)?.[1] || 13 * zoom);
        const layout = layoutFormatParts(formatParts, rotatedFormatWidth(h - 1, largestRichTextSize(formatParts, fontSize / zoom) * zoom * 1.2, rot), measurePart);
        span.replaceChildren(formatLayoutNode(layout, text, align, false, !st?.align, richOptions));
      }
      node.classList.add('rot');
      if (Math.abs(rot) >= 90) node.classList.add('vert', rot > 0 ? 'up' : 'down');
      else span.style.transform = `rotate(${-rot}deg)`;
      node.append(span);
    } else if (text || formatParts) {
      node.textContent = text;
      // Text that does not fit spills over empty neighbours to the right,
      // the way people expect a label to. Numbers and text constrained by a
      // non-leading format fill show ### when their intrinsic content cannot fit.
      const font = formatFont;
      const indent = cellIndent(value, st);
      // The room the text does not have: the cell's padding, its indent, and the decorations drawn in it.
      const inset = CELL_TEXT_INSET * zoom;
      const padding = cellHorizontalPadding(indent, zoom) + 1 + decorationWidth(filterHead, rule, cf, font);
      const formatLayout = formatParts ? layoutFormatParts(formatParts, w - padding, measurePart) : null;
      if (formatLayout) node.replaceChildren(formatLayoutNode(formatLayout, text, align, st?.wrap && typeof value !== 'number', !st?.align, richOptions));
      if ((typeof value === 'number' || formatLayout?.requiresFit) && !(showFormulas && cell?.f != null)) {
        // Numbers are drawn with tabular figures, every digit as wide as a 0; the canvas measures proportional ones.
        const numberWidth = (t) => textWidth(typeof value === 'number' ? t.replace(/[0-9]/g, '0') : t, font);
        if ((formatLayout?.naturalWidth ?? maxLineWidth(text, numberWidth)) > w - padding) {
          // General numbers give up decimals to fit, then go scientific, as Excel's General does; a
          // number with a chosen format cannot be shortened honestly and shows ### instead.
          const shorter = !st?.fmt || st.fmt === 'general' ? generalToFit(value, text, w - padding, numberWidth) : null;
          if (shorter) { node.textContent = shorter; node.title = text; }
          else { node.textContent = '###'; node.title = text; node.classList.add('overflow'); }
        }
      } else if (!st?.wrap && !st?.clip && !st?.shrink && typeof value === 'string' && !merge) {
        const needed = (formatLayout?.width ?? maxLineWidth(text, (line) => textWidth(line, font))) + padding;
        if (needed > w) {
          // The text runs over empty neighbours the way it faces: left-aligned text to the right,
          // right-aligned text to the left, centred text both ways by equal amounts, each side
          // stopping at the first filled cell (where the text is clipped) or the sheet's edge.
          const reach = (dir, want) => {
            let extent = 0;
            let run = -1; // the width before the first neighbour painted by a fill of its own or a rule
            // As far as SPILL_REACH shown columns, the same distance cellsReachingInto looks for a label beyond the view.
            for (let cc = c + dir, seen = 0; cc >= 0 && cc < s.cols && seen < SPILL_REACH && extent < want; cc += dir) {
              if (s.hiddenCols.has(cc)) continue; // a hidden column has no width, and what it holds is not seen: the text runs on, as labelFrom looks back
              if (!isEmptyAt(s, r, cc)) break;
              seen++;
              if (run < 0 && paintedAt(s, r, cc)) run = extent;
              extent += colW(cc);
            }
            return { extent, run: run < 0 ? extent : run, painted: run >= 0 };
          };
          const none = { extent: 0, run: 0, painted: false };
          const excess = needed - w;
          const L = align === 'right' ? reach(-1, excess) : align === 'center' ? reach(-1, excess / 2) : none;
          const R = align === 'left' ? reach(1, excess) : align === 'center' ? reach(1, excess / 2) : none;
          if (L.extent || R.extent) {
            node.style.left = `${colX(c) - L.extent}px`;
            node.style.width = `${w + L.extent + R.extent}px`;
            node.classList.add('spill');
            // Centred text keeps its own cell's centre: blocked on one side, it is clipped there rather than shifted the other way.
            if (align === 'center' && L.extent !== R.extent) {
              if (R.extent > L.extent) node.style.paddingLeft = `${inset + R.extent - L.extent}px`;
              else node.style.paddingRight = `${inset + L.extent - R.extent}px`;
            }
            // Only the text runs over the neighbours, as in Excel: the label's own fill (or the one a
            // rule paints it) is drawn as a layer the size of its cell, and the backing that hides
            // the grid lines under the text stops at a painted neighbour so that fill still shows.
            if ((L.painted || R.painted || node.style.backgroundColor) && !node.style.backgroundImage) {
              node.classList.add('spill-over-fill');
              node.style.setProperty('--spill-back-x', `${L.extent - L.run}px`);
              node.style.setProperty('--spill-opaque', `${L.run + w + R.run}px`);
              if (node.style.backgroundColor) {
                node.style.setProperty('--spill-bg', node.style.backgroundColor);
                node.style.setProperty('--spill-own-x', `${L.extent}px`);
                node.style.setProperty('--spill-own', `${w}px`);
                node.style.backgroundColor = '';
              }
            }
            // The label's borders stay on its own cell too, as in Excel: a box the size of the cell inside
            // the wide node carries them, and the node, left borderless, paints the grid lines under the
            // overflow itself (grid.css). Borders on the node would have boxed the whole overflow.
            const sides = ['bt', 'bl', 'bb', 'br'].filter((side) => node.classList.contains(side));
            if (sides.length) {
              const box = el('span.cell-border', { 'aria-hidden': 'true' });
              node.classList.remove(...sides);
              box.classList.add(...sides);
              for (const edge of ['Top', 'Left', 'Bottom', 'Right']) {
                for (const prop of ['Width', 'Style', 'Color']) {
                  const key = `border${edge}${prop}`;
                  if (node.style[key]) { box.style[key] = node.style[key]; node.style[key] = ''; }
                }
              }
              node.classList.add('spill-bordered');
              node.style.setProperty('--spill-own-x', `${L.extent}px`);
              node.style.setProperty('--spill-own', `${w}px`);
              node.append(box);
            }
          }
        }
      }
    }
    if (cf?.icon && !showFormulas) node.prepend(conditionalIconNode(cf));
    paintSparkline();
    return node;
  }

  /**
   * Cells outside a window of rows and columns that must still be drawn in it: merge anchors
   * whose block reaches into the window (from outside it, or from a hidden row or column the
   * row loops pass over, since the block still stands on its visible lines), and labels left of
   * it whose text spills over empty cells into it, or their visible part would vanish the moment
   * their own cell scrolls off.
   */
  function cellsReachingInto(s, r0, r1, c0, c1) {
    const out = [];
    for (const m of s.merges) {
      const inView = !(m.r2 < r0 || m.r1 > r1 || m.c2 < c0 || m.c1 > c1);
      if (!inView) continue;
      const anchorOut = m.r1 < r0 || m.c1 < c0;
      const anchorHidden = rowHidden(s, m.r1) || s.hiddenCols.has(m.c1);
      if (!anchorOut && !anchorHidden) continue;
      // A block lying wholly in hidden lines has no extent to draw.
      const shown = rowEnd(Math.min(m.r2, s.rows - 1)) > rowY(m.r1) && colEnd(Math.min(m.c2, s.cols - 1)) > colX(m.c1);
      if (shown) out.push({ r: m.r1, c: m.c1 });
    }
    // The nearest filled cell of row r from `from` on in direction `dir`, within SPILL_REACH shown
    // columns, when it is a label whose text can run into the window: left of the window any
    // label may run right into it, right of the window only right-aligned or centred text runs
    // left. The nearest filled cell stops any label beyond it.
    const labelFrom = (r, from, dir) => {
      for (let c = from, seen = 0; c >= 0 && c < s.cols && seen < SPILL_REACH; c += dir) {
        if (s.hiddenCols.has(c)) continue;
        seen++;
        if (isEmptyAt(s, r, c)) continue;
        if (mergeAt(r, c)) return null;
        const cell = s.cells.get(cellKey(r, c));
        const st = styleAt(s, r, c);
        if (st?.wrap || st?.clip || st?.shrink) return null;
        const value = cell?.f != null ? wb.getValue(s.id, r, c) : cell?.v ?? wb.spillAt(s.id, r, c)?.value;
        if (typeof value !== 'string') return null;
        // Right of the window only text facing left runs into it: right-aligned or centred, or right-to-left text given no alignment.
        if (dir > 0 && st?.align !== 'right' && st?.align !== 'center' && (st?.align || !RTL_LEAD.test(value))) return null;
        return { r, c };
      }
      return null;
    };
    for (let r = r0; r <= r1; r++) {
      if (rowHidden(s, r)) continue;
      if (c0 > 0) { const p = labelFrom(r, c0 - 1, -1); if (p) out.push(p); }
      if (c1 < s.cols - 1) { const p = labelFrom(r, c1 + 1, 1); if (p) out.push(p); }
    }
    return out;
  }

  function buildLayerCells(layer, s, r0, r1, c0, c1) {
    const frag = document.createDocumentFragment();
    const rowEls = new Map();
    const rowEl = (r) => {
      let row = rowEls.get(r);
      if (row) return row;
      row = document.createElement('div');
      row.className = 'grid-row';
      row.style.transform = `translateY(${rowY(r)}px)`;
      row.style.height = `${rowH(r)}px`;
      rowEls.set(r, row);
      frag.append(row);
      return row;
    };
    // The main canvas owns the ids and roles; these are visual copies.
    const copy = (r, c) => {
      const cell = buildCell(s, r, c);
      cell.removeAttribute('id');
      cell.removeAttribute('role');
      return cell;
    };
    for (let r = r0; r <= r1; r++) {
      if (rowHidden(s, r)) continue;
      const row = rowEl(r);
      for (let c = c0; c <= c1; c++) {
        if (s.hiddenCols.has(c) || coveredByMerge(r, c)) continue;
        appendCell(row, copy(r, c));
      }
    }
    // A merge anchor or spilling label outside the layer's window still reaches into it; the
    // canvas draws it too, but underneath this opaque layer.
    for (const p of cellsReachingInto(s, r0, r1, c0, c1)) appendCell(rowEl(p.r), copy(p.r, p.c));
    layer.cells.replaceChildren(frag);
  }

  function syncOverlayClones() {
    for (const layer of [frzRows, frzCols, frzCorner]) {
      if (layer.el.hidden) { if (layer.overlays.childElementCount) layer.overlays.replaceChildren(); continue; }
      layer.overlays.replaceChildren(...[hlLayer, refLayer, extraLayer, cutRangeEl, selRange, selActive, fillPreviewEl, movePreviewEl, fillHandle].map((n) => n.cloneNode(true)));
    }
  }

  /**
   * A split window shows the sheet's charts, pictures and shapes in every pane: the top and left panes draw
   * still copies of them (the scrolling pane's own take the presses), made again only when one changes.
   */
  let splitObjectsKey = null;
  function syncSplitObjects() {
    const want = frozen.split && objectsLayer.childElementCount > 0;
    const key = want ? `${wb.version}|${sheetId}|${selectedChart}|${frozen.top}${frozen.left}|${[...objectsLayer.children].map((n) => `${n.style.transform}${n.style.width}${n.style.height}${n.style.display}`).join(';')}` : null;
    if (key === splitObjectsKey) return;
    splitObjectsKey = key;
    for (const layer of [frzRows, frzCols, frzCorner]) {
      layer.track.querySelector(':scope > .split-objects')?.remove();
      if (!want || layer.el.hidden) continue;
      const copy = objectsLayer.cloneNode(true);
      copy.className = 'grid-objects split-objects';
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      for (const n of copy.querySelectorAll('[id]')) n.removeAttribute('id');
      layer.track.append(copy);
    }
  }

  /**
   * Zoomed out, or in a window larger than the sheet, the grid still reaches the edges of the view, as Excel's does:
   * the sheet grows the empty rows and columns that fill it, the same growth scrolling toward an edge makes.
   */
  function fillViewport(s) {
    if (s.kind === 'chart' || growingByScroll) return;
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    ensureOffsets();
    const shortW = reachesEnd(colOffsets) ? viewport.scrollLeft - shift.x + w - colOffsets.total() : 0;
    const shortH = reachesEnd(rowOffsets) ? viewport.scrollTop - shift.y + h - rowOffsets.total() : 0;
    if (shortW <= 0 && shortH <= 0) return;
    const cols = shortW > 0 ? s.cols + Math.ceil(shortW / Math.max(4, s.defaultColWidth * zoom)) + 1 : 0;
    const rows = shortH > 0 ? s.rows + Math.ceil(shortH / Math.max(4, s.defaultRowHeight * zoom)) + 1 : 0;
    growingByScroll = true;
    try { if (wb.ensureSize(sheetId, rows, cols)) rebuildOffsets(); } finally { growingByScroll = false; }
  }

  /**
   * The sheet's background picture (Page Layout ▸ Background), tiled from A1 behind the cells at its own
   * size times the zoom; a cell's fill covers it. The frozen panes' tracks share the canvas coordinates,
   * so they tile it the same way. The picture's size is read once it has loaded.
   */
  const backgroundSizes = new Map();
  let backgroundShown = null;
  function paintBackground(s) {
    const bg = s.kind === 'chart' ? null : s.background || null;
    let size = bg && backgroundSizes.get(bg.src);
    if (bg && !size) {
      if (backgroundSizes.size > 8) backgroundSizes.clear();
      backgroundSizes.set(bg.src, size = { w: 0, h: 0 });
      const img = new Image();
      img.onload = () => { size.w = img.naturalWidth; size.h = img.naturalHeight; backgroundShown = null; schedule(); };
      img.src = bg.src;
    }
    const on = !!bg && size.w > 0 && size.h > 0;
    const tracks = [frzRows.track, frzCols.track, frzCorner.track];
    if (on) for (const track of tracks) { track.style.width = canvas.style.width; track.style.height = canvas.style.height; }
    if (backgroundShown && backgroundShown.bg === bg && backgroundShown.zoom === zoom && on) return;
    if (!on && !backgroundShown) return;
    backgroundShown = on ? { bg, zoom } : null;
    for (const node of [canvas, ...tracks]) {
      node.style.backgroundImage = on ? `url("${bg.src}")` : '';
      node.style.backgroundSize = on ? `${size.w * zoom}px ${size.h * zoom}px` : '';
      node.style.backgroundRepeat = on ? 'repeat' : '';
      if (!on && node !== canvas) { node.style.width = ''; node.style.height = ''; }
    }
    root.classList.toggle('has-background', on);
  }

  let shownChart = null;
  function render() {
    if (destroyed) return;
    const s = sheet();
    if (!s) return;
    if (selectedChart !== shownChart) { shownChart = selectedChart; opts.onChartSelection?.(selectedChart); }
    fillViewport(s);
    const chartSheet = s.kind === 'chart';
    const defaultBg = wb.nativeDefaultCellFormat?.style.bg;
    root.style.setProperty('--cell-default-bg', fillColorCss(defaultBg) || 'var(--surface)');
    for (const layer of [viewport, frzRows.el, frzCols.el, frzCorner.el]) layer.style.backgroundColor = chartSheet ? '' : fillColorCss(defaultBg);
    paintBackground(s);
    root.classList.toggle('chart-sheet', chartSheet);
    if (chartSheet) {
      chartView = chartSheetLayout(s, viewport.clientWidth, viewport.clientHeight, zoom);
      canvas.style.width = `${chartView.width}px`;
      canvas.style.height = `${chartView.height}px`;
      cellsLayer.replaceChildren();
      viewport.setAttribute('role', 'region');
      viewport.setAttribute('aria-label', `${s.name} chart sheet`);
      for (const name of ['aria-rowcount', 'aria-colcount', 'aria-activedescendant', 'aria-multiselectable']) viewport.removeAttribute(name);
      const was = frozen;
      frozen = noPanes();
      applyShift(was);
      renderObjects();
      return;
    }
    if (chartView || viewport.getAttribute('role') !== 'grid') {
      chartView = null;
      rebuildOffsets();
      viewport.setAttribute('role', 'grid');
      viewport.setAttribute('aria-label', 'Spreadsheet grid');
      viewport.setAttribute('aria-multiselectable', 'true');
      rendered.key = null;
    }
    // A pending layout change is laid out first (it sizes the canvas, which the scroll offsets depend on);
    // then the viewport is read once, before any node is written, and everything below takes this reading.
    ensureOffsets();
    // The mounted window can fit a frozen band that construction's temporary
    // dimensions could not. Resolve it before subtracting it from the origin.
    if (pendingOrigin) computeFrozen();
    restoreViewOrigin();
    let view = viewMetrics();
    if (computeFrozen(view)) view = viewMetrics(); // a split made or removed moved the canvas
    rememberViewOrigin(view);
    layoutFrozenLayers(view);
    refreshMergeMap();
    const vr = visibleRange(view);
    borderView = vr;
    resolveBorders = createBorderResolver({
      read: (r, c) => ({ style: baseStyleAt(s, r, c), table: s.tables.some(t => t.customStyle) ? wb._tableStyleAt(s, r, c) : null, conditional: s.rules.length ? wb.conditionalStyle(s.id, r, c, wb.getValue(s.id, r, c), { banding: false }) : null }),
      mergeAt: s.merges.length ? mergeAt : undefined,
      neighbor: (r, c, side) => {
        const rr = side === 'bt' ? shownAbove(r) : side === 'bb' ? shownBelow(r) : r;
        const cc = side === 'bl' ? shownLeft(c) : side === 'br' ? shownRight(c) : c;
        return rr >= 0 && cc >= 0 ? [rr, cc] : null;
      },
    });
    const active = sel.active;
    const editingCell = edit?.sheetId === s.id ? `${edit.r},${edit.c}` : '';
    paneRows = frozen.split ? paneLines(rowOffsets, frozen.st, frozen.h, s.rows) : [frozen.r0 || 0, frozen.rows - 1];
    paneCols = frozen.split ? paneLines(colOffsets, frozen.sl, frozen.w, s.cols) : [frozen.c0 || 0, frozen.cols - 1];
    const panes = frozen.split ? `${frozen.top ? paneRows : ''}/${frozen.left ? paneCols : ''}` : `${frozen.rows},${frozen.cols}`;
    const key = `${vr.r0},${vr.r1},${vr.c0},${vr.c1}|${panes}|${editingCell}|${windowKey()}${pageGeo ? `|${visiblePages(view).map((p) => `${p.across}.${p.down}`).join()}` : ''}`;
    if (rendered.sheet !== s.id || rendered.version !== wb.version || rendered.key !== key) {
      const frag = document.createDocumentFragment();
      const rowEls = new Map();
      const rowEl = (r) => {
        let row = rowEls.get(r);
        if (row) return row;
        row = document.createElement('div');
        row.className = 'grid-row';
        row.setAttribute('role', 'row');
        row.setAttribute('aria-rowindex', String(r + 1));
        row.style.transform = `translateY(${rowY(r)}px)`;
        row.style.height = `${rowH(r)}px`;
        rowEls.set(r, row);
        frag.append(row);
        return row;
      };
      for (let r = vr.r0; r <= vr.r1; r++) {
        if (rowHidden(s, r)) continue;
        const row = rowEl(r);
        for (let c = vr.c0; c <= vr.c1; c++) if (!s.hiddenCols.has(c) && !coveredByMerge(r, c)) appendCell(row, buildCell(s, r, c));
      }
      // Cells outside the view that must still exist: merge anchors and spilling labels that
      // reach into it, and the active cell (for aria-activedescendant). Cells sit in their own
      // row's element and appear once, so no id or row index is duplicated.
      const extraCells = new Set();
      const addOutside = (r, c) => {
        const key = `${r},${c}`;
        if (extraCells.has(key)) return;
        extraCells.add(key);
        const node = buildCell(s, r, c);
        // A cell a hidden line has left with no extent draws nothing at all, not even the 1px its
        // own borders would keep under box-sizing: border-box. A merge reaching into shown lines
        // still has a size and keeps them.
        if (node.style.width === '0px' || node.style.height === '0px') node.classList.add('sizeless');
        appendCell(rowEl(r), node);
      };
      for (const p of cellsReachingInto(s, vr.r0, vr.r1, vr.c0, vr.c1)) addOutside(p.r, p.c);
      // The active cell is always in the DOM, so aria-activedescendant names a node that exists and
      // a screen reader following the grid's cursor does not lose it: outside the rendered window,
      // and inside it on a hidden row or column, which the loop above passes over. A range made of
      // hidden lines alone keeps its active cell (so Unhide still knows which lines are meant).
      const activeHidden = rowHidden(s, active.r) || s.hiddenCols.has(active.c);
      if (activeHidden || active.r < vr.r0 || active.r > vr.r1 || active.c < vr.c0 || active.c > vr.c1) addOutside(active.r, active.c);
      cellsLayer.replaceChildren(frag);
      if (frozen.top) buildLayerCells(frzRows, s, paneRows[0], paneRows[1], vr.c0, vr.c1);
      if (frozen.left) buildLayerCells(frzCols, s, vr.r0, vr.r1, paneCols[0], paneCols[1]);
      if (frozen.top && frozen.left) buildLayerCells(frzCorner, s, paneRows[0], paneRows[1], paneCols[0], paneCols[1]);
      renderHeaders(vr, view);
      renderPaper(view);
      rendered = { ...vr, key, version: wb.version, sheet: s.id, frozen: `${frozen.rows},${frozen.cols}` };
    }
    renderSelection(view);
    positionEditor(view);
    renderRefHighlights(view);
    renderHighlights(vr);
    renderObjects();
    syncOverlayClones();
    syncSplitObjects();
    scrollByCode = null; // the scroll event of the grid's own scroll, if any, has come before this frame
  }

  /* ---------- Charts: floating boxes that scroll with the cells ---------- */

  function chartBoxRect(ch) {
    const s = sheet();
    if (s.kind === 'chart') {
      const scale = chartView?.scale ?? zoom;
      return { left: ch.dx * scale, top: ch.dy * scale, width: ch.w * scale, height: ch.h * scale };
    }
    const r = Math.min(ch.anchor.r, s.rows - 1);
    const c = Math.min(ch.anchor.c, s.cols - 1);
    return { left: colX(c) + ch.dx * zoom, top: rowY(r) + ch.dy * zoom, width: ch.w * zoom, height: ch.h * zoom };
  }

  /** A chart's own definition, its place on the sheet left out: what it draws, not where it sits. */
  const chartDefinition = (ch) => JSON.stringify({ ...ch, anchor: 0, dx: 0, dy: 0 });

  function renderObjects() {
    const s = sheet();
    const objectScale = chartView?.scale ?? zoom;
    const seen = new Set();
    for (const ch of s.charts) {
      seen.add(ch.id);
      let box = chartBoxes.get(ch.id);
      if (!box) {
        const body = el('div.chart-body');
        const image = ch.type === 'image';
        // The picture clips its own crop before rotation. A second, unrotated
        // clip here would cut off corners extending beyond the original frame.
        if (image) body.style.overflow = 'visible';
        const textBox = ch.type === 'text';
        const noun = ch.type === 'slicer' ? 'slicer' : ch.type === 'timeline' ? 'timeline' : ch.type === 'scroll' ? 'scroll bar' : image ? 'image' : textBox ? ch.equation ? 'equation' : 'text box' : 'chart';
        const tools = el('div.chart-tools', {},
          el('button.chart-tool.chart-open-link', { type: 'button', title: 'Open link', 'aria-label': 'Open link', onclick: e => { e.stopPropagation(); if (safeLinkUrl(wb.chartById(sheetId, ch.id)?.hyperlink)) opts.onCommand?.('openDrawingLink', ch.id); } }, 'Open link'),
          !image && el('button.chart-tool', { type: 'button', title: `Edit ${noun}`, 'aria-label': `Edit ${noun}`, onclick: (e) => { e.stopPropagation(); opts.onCommand?.('editChart', ch.id); } }, 'Edit'),
          el('button.chart-tool', { type: 'button', title: `Delete ${noun}`, 'aria-label': `Delete ${noun}`, onclick: (e) => { e.stopPropagation(); opts.onCommand?.('deleteChart', ch.id); } }, 'Delete'));
        const handle = el('div.chart-resize', { title: 'Resize' });
        const node = el('div.chart-box', { dataset: { chart: ch.id }, className: `chart-box${image ? ' image-box' : ''}${textBox ? ' text-box' : ''}`, role: textBox ? 'note' : 'figure', tabindex: -1 }, body, tools, handle);
        // Where a frozen pane has scrolled over the box, the presses are for the frozen cells drawn over it.
        node.addEventListener('pointerdown', (e) => chartPointerDown(e, ch.id, e.target === handle));
        // A double-click opens what the object has to edit: the chart or text dialog, or the picker for a
        // picture to put in the image's place; it never reaches the cell under the object.
        node.addEventListener('dblclick', (e) => { if (underFrozenPane(node, e.clientX, e.clientY)) return; e.stopPropagation(); opts.onCommand?.(image ? 'replaceImage' : 'editChart', ch.id); });
        node.addEventListener('contextmenu', (e) => { if (underFrozenPane(node, e.clientX, e.clientY)) return; e.preventDefault(); e.stopPropagation(); selectChart(ch.id); opts.onContextMenu?.({ x: e.clientX, y: e.clientY, kind: 'chart', chartId: ch.id }); });
        box = { el: node, body, sig: null };
        chartBoxes.set(ch.id, box);
        objectsLayer.append(node);
      }
      box.el.querySelector('.chart-open-link').hidden = !safeLinkUrl(ch.hyperlink);
      box.el.style.cursor = safeLinkUrl(ch.hyperlink) ? 'pointer' : '';
      box.el.title = safeLinkUrl(ch.hyperlink) ? `${ch.hyperlinkTooltip || ch.hyperlink} (Shift-click to select)` : '';
      // Decorative content stays visible and editable without being read as document content.
      if (box.decorative !== !!ch.decorative) {
        box.decorative = !!ch.decorative;
        if (ch.decorative) box.body.setAttribute('aria-hidden', 'true');
        else box.body.removeAttribute('aria-hidden');
      }
      box.el.classList.toggle('chart-sheet-primary', s.kind === 'chart' && !['image', 'text'].includes(ch.type));
      const rect = chartBoxRect(ch);
      // A box lying wholly inside a frozen band is drawn in that band's layer (the tracks share the
      // canvas coordinates), so it stays put with its anchor while the sheet scrolls; one reaching
      // past the band scrolls with the cells. The stored place decides, not a drag in progress, so
      // the pressed node is never moved under the pointer.
      const inRows = frozen.rows > 0 && rect.top + rect.height <= frozen.h;
      const inCols = frozen.cols > 0 && rect.left + rect.width <= frozen.w;
      const layer = inRows && inCols ? frzCorner.track : inRows ? frzRows.track : inCols ? frzCols.track : objectsLayer;
      if (box.el.parentNode !== layer) layer.append(box.el);
      const live = drag?.kind === 'chartmove' && drag.id === ch.id ? drag.rect : drag?.kind === 'chartresize' && drag.id === ch.id ? drag.rect : rect;
      box.el.style.transform = `translate(${live.left}px, ${live.top}px)`;
      box.el.style.width = `${live.width}px`;
      box.el.style.height = `${live.height}px`;
      box.el.classList.toggle('selected', selectedChart === ch.id);
      box.el.style.zIndex = selectedChart === ch.id ? '1' : ''; // the selected one lies over any it overlaps
      // A chart in Excel's style draws its own outline (or none); the frame's border would double it.
      if (ch.type !== 'text') box.el.classList.toggle('borderless', ch.border === false || ch.appearance?.border === false || !!ch.appearance?.borderColor);
      box.el.classList.toggle('chart-shadow', !!ch.appearance?.effects?.chartArea?.shadow);
      box.el.classList.toggle('transparent', ch.appearance?.background === 'none');
      const cornerRadius = chartCornerRadius(ch);
      box.el.style.borderRadius = box.body.style.borderRadius = cornerRadius == null ? '' : `${cornerRadius * objectScale}px`;
      if (ch.type === 'slicer') {
        box.el.style.display = ch.hidden ? 'none' : '';
        box.el.classList.add('borderless');
        if (!box.slicer) {
          box.slicer = createSlicerControl(document, values => setSlicerSelection(wb, sheetId, ch.id, values));
          box.body.replaceChildren(box.slicer.node);
        }
        const target = slicerTarget(wb, ch);
        box.slicer.node.style.width = `${ch.w}px`;
        box.slicer.node.style.height = `${ch.h}px`;
        box.slicer.node.style.transformOrigin = 'top left';
        box.slicer.node.style.transform = `scale(${objectScale})`;
        const disabled = wb._locked(s) || !!target && wb._gridLocked(wb.sheet(target.sheetId));
        if (box.slicerVersion !== wb.version || box.slicerModel !== ch || box.slicerDisabled !== disabled) {
          box.slicer.update(ch, slicerItems(wb, ch), ch.paint, { disabled });
          box.slicerVersion = wb.version; box.slicerModel = ch; box.slicerDisabled = disabled;
        }
        box.el.setAttribute('aria-label', ch.title || 'Slicer');
        box.el.querySelector('.chart-resize').style.display = ch.lockedPosition ? 'none' : '';
        continue;
      }
      if (ch.type === 'timeline') {
        box.el.classList.add('borderless');
        if (!box.timeline) {
          box.timeline = createTimelineControl(document, (start, end, level, levelOnly) => levelOnly
            ? (wb.updateChart(sheetId, ch.id, { level }, 'Timeline'), true) : setTimelineSelection(wb, sheetId, ch.id, start, end));
          box.body.replaceChildren(box.timeline.node);
        }
        Object.assign(box.timeline.node.style, { width: `${ch.w}px`, height: `${ch.h}px`, transformOrigin: 'top left', transform: `scale(${objectScale})` });
        if (box.timelineVersion !== wb.version || box.timelineModel !== ch) {
          let state = null;
          try { state = timelineState(wb, ch); } catch { state = null; }
          box.timeline.update(ch, state, { disabled: wb._locked(s) });
          box.timelineVersion = wb.version; box.timelineModel = ch;
        }
        box.el.setAttribute('aria-label', ch.title || 'Timeline');
        box.el.querySelector('.chart-resize').style.display = ch.lockedPosition ? 'none' : '';
        continue;
      }
      if (ch.type === 'scroll') {
        if (!box.control) {
          if (!viewport.id) viewport.id = `grid-${crypto.randomUUID()}`;
          box.control = createScrollControl(document, value => setScrollControlValue(wb, sheetId, ch.id, value));
          box.control.node.querySelector('[role=scrollbar]').setAttribute('aria-controls', viewport.id);
          box.body.replaceChildren(box.control.node);
        }
        box.control.update(ch, scrollControlValue(wb, sheetId, ch));
        box.el.setAttribute('aria-label', ch.title || 'Scroll bar');
        continue;
      }
      if (ch.type === 'text') {
        const text = textBoxText(wb, sheetId, ch);
        // A theme effect (Page Layout ▸ Effects) follows the workbook's effect scheme.
        const effect = textBoxEffectCss(wb, ch, objectScale);
        const sig = JSON.stringify([text, ch.style, objectScale, ch.decorative, ch.equation, effect]);
        if (box.sig !== sig) {
          box.sig = sig;
          const inner = ch.equation ? equationBody(ch, objectScale, effect) : el('div.text-body', { style: { ...textBoxStyle(ch, objectScale), ...effect } }, el('span', {}, text));
          box.body.replaceChildren(inner);
          box.body.style.overflow = effect.filter ? 'visible' : '';
          box.el.classList.toggle('borderless', ch.style?.border === false);
          box.el.setAttribute('aria-label', ch.decorative ? `Decorative ${ch.equation ? 'equation' : 'text box'}` : ch.equation ? `Equation: ${text.slice(0, 80)}` : `Text box: ${text.slice(0, 80) || 'empty'}`);
        }
        continue;
      }
      if (ch.type === 'image') {
        // Different pictures can have the same encoded length and file name.
        // Keep the source itself so replacements and undo always refresh it.
        const transform = JSON.stringify([imageTransform(ch), ch.srcRect, ch.fillRect, ch.decorative]);
        if (box.imageSrc !== ch.src || box.imageTitle !== ch.title || box.imageTransform !== transform) {
          box.imageSrc = ch.src;
          box.imageTitle = ch.title;
          box.imageTransform = transform;
          box.body.replaceChildren(pictureNode(ch));
          box.el.setAttribute('aria-label', ch.decorative ? 'Decorative image' : ch.title ? `Image: ${ch.title}` : 'Image');
        }
        continue;
      }
      // The chart is drawn again only when its definition or the cells it reads change. The workbook is asked first
      // what has changed since the box last looked: cells written away from the range, on this sheet or another,
      // are passed over without the range being read, so a keystroke beside forty charts costs nothing per chart.
      // The range is read again when a change of any other kind came (rows moved, a filter set, the chart's own
      // definition), when a formula was written anywhere on the sheet (its result may spill into the range), when
      // the rows or columns hidden may have changed, and always for a range holding a formula or a spilled value,
      // whose inputs lie anywhere in the book — that last reading waits for an idle moment (see readRangeLater).
      const overdue = staleCharts.delete(ch.id); // this chart's deferred reading of its range has come round
      if (ch.sourceRefs?.length || ch.titleRef || ch.xTitleRef || ch.yTitleRef || ch.y2TitleRef) {
        // A native chart can read formulas on several other sheets. Its local placeholder
        // range cannot tell us whether an edit changed the plotted values.
        if (box.version !== wb.version || overdue) {
          box.version = wb.version;
          const data = chartData(wb, sheetId, ch), sig = `${chartDefinition(ch)}|${themeSeriesKey()}|${JSON.stringify(data)}`;
          if (box.sig !== sig) {
            box.sig = sig;
            box.body.innerHTML = renderChartSvg(data, ch, ch.w, ch.h);
            const title = data.titles?.title ?? ch.title;
            box.el.setAttribute('aria-label', ch.decorative ? 'Decorative chart' : ch.description || (title ? `Chart: ${title}` : `${ch.type} chart`));
          }
        }
        continue;
      }
      if (box.version !== wb.version || overdue) {
        const changes = box.sig == null ? null : wb.changesSince(box.version);
        box.version = wb.version;
        const range = normalizeRange(ch.range);
        const reaches = (e) => (e.type === 'cells'
          ? e.sheetId === sheetId && (e.formula || !e.box || (e.box.r1 <= range.r2 && e.box.r2 >= range.r1 && e.box.c1 <= range.c2 && e.box.c2 >= range.c1))
          : e.type !== 'layout' || e.sheetId == null || e.sheetId === sheetId);
        const hidden = [s.hiddenRows, s.hiddenCols, s.filterHidden];
        // Are the sheet's hidden lines as they were when this chart last read its range? Every
        // command that hides or shows lines either changes their count or hands the sheet a new set
        // (a filter builds one afresh), and a hide and a show are separate steps, so neither can
        // slip past by cancelling the other out inside one announcement.
        const lines = !!box.read && !!box.hidden && !box.hidden.some((h, i) => h !== hidden[i])
          && s.hiddenRows.size === box.read.hr && s.hiddenCols.size === box.read.hc && s.filterHidden.size === box.read.hf;
        // Growing the sheet — what a scroll to its foot does — is announced as a layout change, and
        // a layout change on the sheet otherwise reaches every chart on it. But growth only ever
        // adds lines past the sheet's old extent and hides none, and a column width, a row height, a
        // freeze and a protected range change nothing a chart reads either. So a chart that ends
        // inside the extent its last reading was taken at, its own definition and its sheet's hidden
        // lines unchanged, keeps its picture with its range left untouched: scrolling down a sheet
        // of forty charts no longer reads every one of their ranges again.
        const untouched = lines && changes?.length > 0
          && changes.every((e) => e.type === 'layout' && e.sheetId === sheetId)
          && s.rows >= box.read.rows && s.cols >= box.read.cols
          && range.r2 < box.read.rows && range.c2 < box.read.cols
          && chartDefinition(ch) === box.read.def;
        const reached = !untouched && (!changes || !lines || changes.some(reaches));
        if (reached || overdue) {
          const read = rangeFingerprint(ch.range);
          box.formulas = read.formulas > 0;
          box.hidden = hidden;
          const def = chartDefinition(ch);
          // What the reading was taken at, for the test above: the sheet's extent, how many lines
          // were hidden, and the chart's own definition.
          box.read = { rows: s.rows, cols: s.cols, hr: s.hiddenRows.size, hc: s.hiddenCols.size, hf: s.filterHidden.size, def };
          const sig = `${def}|${themeSeriesKey()}|${read.sig}`;
          if (box.sig !== sig) {
            box.sig = sig;
            box.body.innerHTML = renderChartSvg(chartData(wb, sheetId, ch), ch, ch.w, ch.h);
            box.el.setAttribute('aria-label', ch.decorative ? 'Decorative chart' : ch.description || (ch.title ? `Chart: ${ch.title}` : `${ch.type} chart`));
          }
        } else if (box.formulas && !untouched) readRangeLater(ch.id);
      }
    }
    for (const [id, box] of chartBoxes) {
      if (!seen.has(id)) { box.el.remove(); chartBoxes.delete(id); staleCharts.delete(id); if (selectedChart === id) selectedChart = null; }
    }
  }

  /**
   * Charts whose range holds a formula or a spilled value, waiting to read it again. Their inputs
   * lie anywhere in the book, so no record of what changed can say the picture is safe — but
   * reading forty such ranges on the keystroke itself is what makes typing beside a dashboard slow
   * (a five-thousand-row computed range is five thousand values per chart per key). The reading
   * waits for the browser to fall idle instead, at most about a sixth of a second into continuous
   * typing, and each chart keeps its picture until then. A change that does reach a range, and a
   * recalculation, still draw on the spot.
   */
  const staleCharts = new Set();
  let staleChartsIdle = null;
  function readRangeLater(id) {
    staleCharts.add(id);
    if (staleChartsIdle) return;
    const run = () => { staleChartsIdle = null; if (!destroyed && staleCharts.size) renderObjects(); };
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(run, { timeout: CHART_READ_DELAY });
      staleChartsIdle = () => cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(run, CHART_READ_DELAY);
      staleChartsIdle = () => clearTimeout(handle);
    }
  }

  /**
   * What a chart reads from its range, folded into one number: the values, the number formats
   * that shape their labels, and which of its rows and columns are hidden (the chart leaves those
   * out). A change that may reach the range asks the chart whether its picture is stale (see
   * renderObjects), so the range is walked as cheaply as it can be: a constant is read straight
   * from the cell store and only a formula is computed, nothing is built up as text, and a range
   * holding most of the sheet is read off the store's own entries rather than looked up cell by
   * cell. Each cell's hash is added in, so the order the cells are met in makes no difference.
   * With the hash comes the count of formulas and spilled values in the range: what they show
   * depends on cells the range's box says nothing about, so such a range is read after any change.
   */
  const hashBits = new Float64Array(1);
  const hashWords = new Uint32Array(hashBits.buffer);
  function rangeFingerprint(range) {
    const s = sheet();
    const n = normalizeRange(range);
    const r2 = Math.min(n.r2, s.rows - 1);
    const c2 = Math.min(n.c2, s.cols - 1);
    // Two FNV-1a hashes with different primes give 64 bits, so no real change hides behind a collision.
    let h1 = 0;
    let h2 = 0;
    let sum1 = 0;
    let sum2 = 0;
    let formulas = 0;
    const word = (x) => { h1 = Math.imul(h1 ^ x, 0x01000193); h2 = Math.imul(h2 ^ x, 0x27d4eb2f); };
    const chars = (t) => { word(t.length); for (let i = 0; i < t.length; i++) word(t.charCodeAt(i)); };
    const open = (tag, i) => { h1 = 0x811c9dc5; h2 = 0x9e3779b9; word(tag); word(i); };
    const seal = () => { sum1 = (sum1 + h1) | 0; sum2 = (sum2 + (h2 ^ h1)) | 0; };
    const hashCell = (r, c, v, st) => {
      open(r, c);
      if (v === null) word(4);
      else if (typeof v === 'number') { hashBits[0] = v; word(hashWords[0]); word(hashWords[1]); }
      else if (typeof v === 'string') { word(5); chars(v); }
      else if (typeof v === 'boolean') word(v ? 6 : 7);
      else { word(8); chars(JSON.stringify(v)); }
      if (st) {
        chars(st.fmt || '');
        word(st.dec ?? -1);
        chars(st.cur || '');
        chars(st.code || '');
        chars(st.dateStyle || '');
        word((st.sec ? 1 : 0) | (st.group ? 2 : 0));
      } else word(9);
      seal();
    };
    for (let r = n.r1; r <= r2; r++) if (rowHidden(s, r)) { open(-1, r); seal(); }
    for (let c = n.c1; c <= c2; c++) if (s.hiddenCols.has(c)) { open(-2, c); seal(); }
    // A number format given to a whole column or row shapes the labels of the cells in it that carry
    // none of their own (see Workbook.styleAt), so changing one makes the picture stale as a cell's
    // own format does. A sheet with no such format walks nothing for it.
    for (const [c, st] of s.colStyles) if (c >= n.c1 && c <= c2) { open(-3, c); chars(JSON.stringify(st)); seal(); }
    for (const [r, st] of s.rowStyles) if (r >= n.r1 && r <= r2) { open(-4, r); chars(JSON.stringify(st)); seal(); }
    for (const reset of s.styleResets) {
      const g = reset.range;
      if (g.r1 <= r2 && g.r2 >= n.r1 && g.c1 <= c2 && g.c2 >= n.c1) { open(-5, 0); chars(JSON.stringify(reset)); seal(); }
    }
    const inRange = (r, c) => r >= n.r1 && r <= r2 && c >= n.c1 && c <= c2;
    if (s.cells.size <= (r2 - n.r1 + 1) * (c2 - n.c1 + 1) * 2) {
      for (const [key, cell] of s.cells) {
        if (cell.v == null && cell.f == null) continue; // a blank cell shows nothing; a spill into it is read below
        // The key is "r,c": its numbers are read off in place rather than cut out of it.
        let i = 0;
        let r = 0;
        let c = 0;
        let d;
        while ((d = key.charCodeAt(i) - 48) >= 0 && d <= 9) { r = r * 10 + d; i++; }
        for (i++; i < key.length; i++) c = c * 10 + key.charCodeAt(i) - 48;
        if (!inRange(r, c)) continue;
        if (cell.f != null) formulas++;
        hashCell(r, c, cell.f != null ? wb.getValue(sheetId, r, c) : cell.v, cell.s);
      }
      for (const sp of wb.spillEntries(sheetId)) if (inRange(sp.r, sp.c)) { formulas++; hashCell(sp.r, sp.c, sp.value, s.cells.get(cellKey(sp.r, sp.c))?.s); }
    } else {
      for (let r = n.r1; r <= r2; r++) {
        for (let c = n.c1; c <= c2; c++) {
          const cell = s.cells.get(cellKey(r, c));
          if (!cell || (cell.v == null && cell.f == null)) {
            const sp = wb.spillAt(sheetId, r, c);
            if (sp) { formulas++; hashCell(r, c, sp.value, cell?.s); }
          } else {
            if (cell.f != null) formulas++;
            hashCell(r, c, cell.f != null ? wb.getValue(sheetId, r, c) : cell.v, cell.s);
          }
        }
      }
    }
    return { sig: `${sum1 >>> 0}:${sum2 >>> 0}`, formulas };
  }

  function selectChart(id) {
    if (edit && !commitEdit()) return;
    selectedChart = id;
    viewport.focus({ preventScroll: true });
    schedule();
    if (id) {
      const ch = wb.chartById(sheetId, id);
      if (ch) opts.announce?.(safeLinkUrl(ch.hyperlink) ? `${ch.hyperlinkTooltip || ch.title || 'Linked drawing'} selected. Press Enter to open link, Delete to remove` : ch.type === 'image' ? `${ch.title || 'Image'} selected. Press Delete to remove` : ch.type === 'text' ? 'Text box selected. Press Enter to edit, Delete to remove' : `${chartTitles(wb, sheetId, ch).title ?? (ch.title || `${ch.type} chart`)} selected. Press Enter to edit, Delete to remove`);
    }
  }

  function chartPointerDown(e, id, onHandle) {
    if (e.button !== 0 || e.target.closest('.chart-tool')) return;
    if (underFrozenPane(e.currentTarget, e.clientX, e.clientY)) return; // the press goes on to the cells
    e.preventDefault();
    e.stopPropagation();
    const ch = wb.chartById(sheetId, id);
    if (!ch) return;
    selectChart(id);
    if ((ch.type === 'slicer' || ch.type === 'timeline') && ch.lockedPosition) return;
    if (sheet().kind === 'chart' && !['image', 'text'].includes(ch.type)) return;
    const objectScale = chartView?.scale ?? zoom;
    const node = e.currentTarget;
    const rect = chartBoxRect(ch);
    drag = { kind: onHandle ? 'chartresize' : 'chartmove', id, startX: e.clientX, startY: e.clientY, from: rect, rect, moved: false };
    try { node.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const move = (ev) => {
      if (!drag || drag.id !== id) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.kind === 'chartmove') {
        // The box stays within the sheet, so it cannot be dragged out of reach past its edge.
        ensureOffsets();
        const s = sheet();
        drag.rect = { ...drag.from, left: clamp(drag.from.left + dx, 0, Math.max(0, (chartView?.width ?? colOffsets.total()) - drag.from.width)), top: clamp(drag.from.top + dy, 0, Math.max(0, (chartView?.height ?? rowOffsets.total()) - drag.from.height)) };
      } else {
        const minW = (ch.type === 'scroll' ? 12 : ch.type === 'image' ? IMAGE_MIN : ch.type === 'text' ? TEXT_MIN : CHART_MIN_W) * objectScale;
        const minH = (ch.type === 'scroll' ? 12 : ch.type === 'image' ? IMAGE_MIN : ch.type === 'text' ? TEXT_MIN : CHART_MIN_H) * objectScale;
        let width = Math.max(minW, drag.from.width + dx);
        let height = Math.max(minH, drag.from.height + dy);
        // Images keep their proportions unless Shift is held.
        if (ch.type === 'image' && !ev.shiftKey) {
          const ratio = drag.from.width / drag.from.height;
          if (Math.abs(dx) >= Math.abs(dy)) height = Math.max(minH, width / ratio); else width = Math.max(minW, height * ratio);
        }
        drag.rect = { ...drag.from, width, height };
      }
      schedule();
    };
    const end = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      const d = drag;
      drag = null;
      return d;
    };
    const up = () => {
      const d = end();
      if (!d || !d.moved) {
        if (d && !onHandle && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && safeLinkUrl(ch.hyperlink)) opts.onCommand?.('openDrawingLink', id);
        schedule(); return;
      }
      if (d.kind === 'chartmove') placeChart(id, d.rect.left, d.rect.top);
      else wb.updateChart(sheetId, id, { w: Math.round(d.rect.width / objectScale), h: Math.round(d.rect.height / objectScale) }, 'Resize chart');
    };
    // A drag the browser gives up (a touch it decided to scroll with, a lost capture) acts on
    // nothing, as the grid's own drags rule: the box goes back to its stored place.
    const cancel = () => { end(); schedule(); };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
  }

  /** Anchor a chart at a canvas position: the cell under its top-left corner, plus the offset into it. */
  function placeChart(id, left, top) {
    if (sheet()?.kind === 'chart') {
      const scale = chartView?.scale ?? zoom;
      wb.updateChart(sheetId, id, { anchor: { r: 0, c: 0 }, dx: left / scale, dy: top / scale }, 'Move chart');
      return;
    }
    ensureOffsets();
    const c = clamp(colOffsets.indexAt(left), 0, sheet().cols - 1);
    const r = clamp(rowOffsets.indexAt(top), 0, sheet().rows - 1);
    wb.updateChart(sheetId, id, { anchor: { r, c }, dx: Math.round((left - colX(c)) / zoom), dy: Math.round((top - rowY(r)) / zoom) }, 'Move chart');
  }

  /** Arrow keys on a selected chart: a nudge of a few pixels, or with Shift a whole cell of the anchor's size, kept inside the sheet. */
  function nudgeChart(id, dr, dc, wholeCell) {
    const ch = wb.chartById(sheetId, id);
    if (!ch) return;
    ensureOffsets();
    const s = sheet();
    const rect = chartBoxRect(ch);
    const c = Math.min(ch.anchor.c, s.cols - 1);
    const r = Math.min(ch.anchor.r, s.rows - 1);
    const stepX = wholeCell ? colW(dc < 0 ? Math.max(0, c - 1) : c) : 8 * zoom;
    const stepY = wholeCell ? rowH(dr < 0 ? Math.max(0, r - 1) : r) : 8 * zoom;
    const left = clamp(rect.left + dc * stepX, 0, Math.max(0, colOffsets.total() - rect.width));
    const top = clamp(rect.top + dr * stepY, 0, Math.max(0, rowOffsets.total() - rect.height));
    placeChart(id, left, top);
  }

  /** Ctrl+Alt+O: select the next floating object (Shift: the previous) in the sheet's order, bringing its anchor into view. */
  function selectNextChart(step) {
    const s = sheet();
    const charts = s.charts;
    if (!charts.length) { opts.announce?.('No charts, images or text boxes on this sheet'); return; }
    const at = charts.findIndex((ch) => ch.id === selectedChart);
    const next = charts[at < 0 ? (step > 0 ? 0 : charts.length - 1) : (at + step + charts.length) % charts.length];
    if (s.kind !== 'chart') scrollIntoView({ r: Math.min(next.anchor.r, s.rows - 1), c: Math.min(next.anchor.c, s.cols - 1) });
    selectChart(next.id);
  }

  /** Find-and-replace matches: outline every visible one, fill the current. */
  function renderHighlights(vr) {
    hlLayer.replaceChildren();
    if (!highlights.cells.length) return;
    const frag = document.createDocumentFragment();
    highlights.cells.forEach((m, i) => {
      if (m.r < vr.r0 || m.r > vr.r1 || m.c < vr.c0 || m.c > vr.c1) return;
      const node = el('div.find-hl', { className: `find-hl${i === highlights.current ? ' current' : ''}${m.kind === 'invalid' ? ' invalid-circle' : ''}` });
      place(node, rangeBox({ r1: m.r, c1: m.c, r2: m.r, c2: m.c }));
      frag.append(node);
    });
    hlLayer.append(frag);
  }

  /** Row numbers longer than the heading's width widen it, as Excel's do past row 999 (at the grid's zoom). */
  function fitRowDigits(lastRow) {
    const digits = String(Math.max(1, lastRow + 1)).length;
    const need = digits > 3 ? Math.ceil((digits * 7.4 + 12) * zoom) : 0;
    if (need === rowDigitsW) return;
    rowDigitsW = need;
    const before = rowHeaderW;
    applyOutlineGutter();
    if (rowHeaderW !== before) invalidateOffsets();
  }

  function renderHeaders(vr, view = viewMetrics()) {
    fitRowDigits(vr.r1);
    const range = S.selRange(sel);
    const s = sheet();
    const wholeCols = range.r1 === 0 && range.r2 >= s.rows - 1;
    const wholeRows = range.c1 === 0 && range.c2 >= s.cols - 1;
    const colHeader = (c) => {
      const h = el('div.hcell', { 'aria-hidden': 'true', dataset: { c } }, cellName(0, c).replace(/\d+$/, ''));
      h.style.left = `${colX(c)}px`;
      h.style.width = `${colW(c)}px`;
      if (c >= range.c1 && c <= range.c2) h.classList.add(wholeCols ? 'sel' : 'hl');
      else if (extras.some((x) => c >= x.c1 && c <= x.c2)) h.classList.add('hl');
      if (c > 0 && s.hiddenCols.has(c - 1)) h.classList.add('after-hidden');
      if (s.hiddenCols.has(c + 1)) h.classList.add('before-hidden');
      h.append(el('div.col-resizer', { dataset: { c } }));
      return h;
    };
    const rowHeader = (r) => {
      const h = el('div.hcell', { 'aria-hidden': 'true', dataset: { r } }, String(r + 1));
      h.style.top = `${rowY(r)}px`;
      h.style.height = `${rowH(r)}px`;
      if (r >= range.r1 && r <= range.r2) h.classList.add(wholeRows ? 'sel' : 'hl');
      else if (extras.some((x) => r >= x.r1 && r <= x.r2)) h.classList.add('hl');
      if (r > 0 && s.hiddenRows.has(r - 1)) h.classList.add('after-hidden');
      if (s.hiddenRows.has(r + 1)) h.classList.add('before-hidden');
      if (wb.filtersForSheet(s.id).some(f => r > f.range.r1 && r <= f.range.r2 && Object.keys(f.criteria).length)) h.classList.add('filtered');
      h.append(el('div.row-resizer', { dataset: { r } }));
      return h;
    };
    const cf = document.createDocumentFragment();
    for (let c = vr.c0; c <= vr.c1; c++) if (!s.hiddenCols.has(c)) cf.append(colHeader(c));
    cf.append(...outlineNodes('col', vr));
    colHead.replaceChildren(cf);
    const cff = document.createDocumentFragment();
    if (frozen.left) for (let c = paneCols[0]; c <= paneCols[1]; c++) if (!s.hiddenCols.has(c)) cff.append(colHeader(c));
    colHeadFrozen.replaceChildren(cff);
    const rf = document.createDocumentFragment();
    for (let r = vr.r0; r <= vr.r1; r++) if (!rowHidden(s, r)) rf.append(rowHeader(r));
    rf.append(...outlineNodes('row', vr));
    rowHead.replaceChildren(rf);
    const rff = document.createDocumentFragment();
    if (frozen.top) for (let r = paneRows[0]; r <= paneRows[1]; r++) if (!rowHidden(s, r)) rff.append(rowHeader(r));
    rowHeadFrozen.replaceChildren(rff);
    if (pageGeo || colRuler.childElementCount) { colRuler.replaceChildren(...rulerNodes('col', view)); rowRuler.replaceChildren(...rulerNodes('row', view)); }
  }

  // Half the thickness a page-break line or print-area edge can be pressed across.
  const BREAK_GRIP = 4;
  /** Where a page break before line `at` is drawn across the print area: a strip centred on the line between pages. */
  function breakBox(axis, at, area) {
    const box = rangeBox(area), s = sheet();
    if (axis === 'row') { const y = at > s.rows - 1 ? rowEnd(s.rows - 1) : rowY(at); return { left: box.left, top: y - BREAK_GRIP, width: box.width, height: BREAK_GRIP * 2 }; }
    const x = at > s.cols - 1 ? colEnd(s.cols - 1) : colX(at);
    return { left: x - BREAK_GRIP, top: box.top, width: BREAK_GRIP * 2, height: box.height };
  }

  /**
   * Page Break Preview: the print area outlined and the sheet outside it greyed, each page's number, and
   * the lines between pages (solid where the sheet keeps a manual break, dashed where the paper ran out),
   * which a press drags; the print area's edges drag too. Normal view's page-break lines are the same
   * lines, dashed and out of the way of the pointer.
   */
  function renderPages() {
    // A line being dragged keeps its node (and its place under the pointer) until it is dropped.
    if (drag?.kind === 'pageBreak' && drag.node.isConnected) return;
    pageLayer.hidden = !pageView;
    const preview = !!pageView && !pageView.lines;
    root.classList.toggle('page-break-preview', preview);
    pageLayer.classList.toggle('lines-only', !!pageView?.lines);
    if (!pageView) { if (pageLayer.childElementCount) pageLayer.replaceChildren(); return; }
    const lines = (axis, list) => (list || []).map(({ at, manual }) => {
      const line = el(`div.page-break-line.${axis}${manual ? '.manual' : ''}`, {
        dataset: { axis, at: String(at), manual: manual ? '1' : '' },
        title: preview ? `${manual ? 'Manual' : 'Automatic'} page break: drag to move it${manual ? ', or off the print area to remove it' : ''}` : null,
      });
      place(line, breakBox(axis, at, pageView.area));
      return line;
    });
    if (!preview) {
      pageLayer.replaceChildren(...lines('row', pageView.rowBreaks), ...lines('col', pageView.colBreaks));
      return;
    }
    const area = el('div.page-area');
    const box = rangeBox(pageView.area);
    place(area, box);
    // The print area's own edges, pressed to make the area larger or smaller.
    const edges = [['top', 'row', pageView.area.r1], ['bottom', 'row', pageView.area.r2 + 1], ['left', 'col', pageView.area.c1], ['right', 'col', pageView.area.c2 + 1]].map(([edge, axis, at]) => {
      const node = el(`div.page-area-edge.${axis}`, { dataset: { edge, axis, at: String(at) }, title: 'Drag to change the print area' });
      place(node, breakBox(axis, at, pageView.area));
      return node;
    });
    pageLayer.replaceChildren(area, ...pageView.pages.map((p) => {
      const page = el('div.page-box', {}, el('span.page-label', {}, `Page ${p.n}`));
      place(page, rangeBox(p));
      return page;
    }), ...lines('row', pageView.rowBreaks), ...lines('col', pageView.colBreaks), ...edges);
  }

  /** The line boundary nearest the pointer along an axis: the index of the line that would follow a break there. */
  function boundaryAt(axis, clientX, clientY) {
    ensureOffsets();
    const vp = viewport.getBoundingClientRect(), s = sheet();
    if (axis === 'row') {
      const y = contentY(clientY - vp.top), r = clamp(rowOffsets.indexAt(y), 0, s.rows - 1);
      return y > rowY(r) + rowH(r) / 2 ? r + 1 : r;
    }
    const x = contentX(clientX - vp.left), c = clamp(colOffsets.indexAt(x), 0, s.cols - 1);
    return x > colX(c) + colW(c) / 2 ? c + 1 : c;
  }

  /** One drag corner per table (tables with a totals row are resized from their dialog). */
  function renderTables() {
    renderPages();
    const s = sheet();
    const tables = (s.tables || []).filter((t) => !t.totalsRow);
    if (!tables.length && !tableLayer.childElementCount) return;
    tableLayer.replaceChildren(...tables.map((t) => {
      const box = rangeBox(t.range);
      const h = el('div.table-handle', { dataset: { id: t.id }, title: `Drag to resize table ${t.name}` });
      h.style.transform = `translate(${box.left + box.width - 9}px, ${box.top + box.height - 9}px)`;
      return h;
    }));
  }

  /** The selection's marks on the row and column headers, set on the existing header cells. */
  function highlightHeaders() {
    const s = sheet();
    const range = S.selRange(sel);
    const wholeCols = range.r1 === 0 && range.r2 >= s.rows - 1;
    const wholeRows = range.c1 === 0 && range.c2 >= s.cols - 1;
    for (const head of [colHead, colHeadFrozen]) {
      for (const h of head.children) {
        if (!h.classList.contains('hcell')) continue;
        const c = Number(h.dataset.c);
        const inSel = c >= range.c1 && c <= range.c2;
        h.classList.toggle('sel', inSel && wholeCols);
        h.classList.toggle('hl', (inSel && !wholeCols) || (!inSel && extras.some((x) => c >= x.c1 && c <= x.c2)));
      }
    }
    for (const head of [rowHead, rowHeadFrozen]) {
      for (const h of head.children) {
        if (!h.classList.contains('hcell')) continue;
        const r = Number(h.dataset.r);
        const inSel = r >= range.r1 && r <= range.r2;
        h.classList.toggle('sel', inSel && wholeRows);
        h.classList.toggle('hl', (inSel && !wholeRows) || (!inSel && extras.some((x) => r >= x.r1 && r <= x.r2)));
      }
    }
  }

  /** The cut cells keep a dashed box, on their own sheet, until the paste moves them or anything else ends the cut. */
  function renderCutRange() {
    if (cutRange && cutRange.sheetId === sheetId) { cutRangeEl.hidden = false; place(cutRangeEl, rangeBox(cutRange.range)); }
    else cutRangeEl.hidden = true;
  }

  function renderSelection(view = viewMetrics()) {
    renderTables();
    root.classList.toggle('protected', wb.isProtected(sheetId));
    root.classList.toggle('no-gridlines', sheet().gridlines === false);
    highlightHeaders();
    const range = S.selRange(sel);
    // In Page Layout view a range across pages is outlined on each page, not across the margins between them.
    const pieces = pagePieces(range, view);
    place(selRange, rangeBox(pieces[0]));
    selRange.classList.toggle('multi', !S.isSingle(sel) || extras.length > 0);
    extraLayer.replaceChildren(...extras.flatMap((x) => pagePieces(x, view).map((p) => { const n = el('div.sel-range.extra'); place(n, rangeBox(p)); return n; })),
      ...pieces.slice(1).map((p) => { const n = el('div.sel-range.multi.page-piece'); place(n, rangeBox(p)); return n; }));
    const am = mergeAt(sel.active.r, sel.active.c);
    place(selActive, rangeBox(am || { r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c }));
    const box = rangeBox(range);
    fillHandle.style.transform = `translate(${box.left + box.width - 4}px, ${box.top + box.height - 4}px)`;
    const handle = handlePlace(view);
    fillHandle.hidden = !!edit || handle.gone;
    // Scrolled under a frozen pane the handle is out of sight: it takes no press and shows no cursor through the pane.
    fillHandle.classList.toggle('under-pane', handle.hidden);
    if (fillPreview) { fillPreviewEl.hidden = false; place(fillPreviewEl, rangeBox(fillPreview)); }
    else fillPreviewEl.hidden = true;
    if (movePreview) { movePreviewEl.hidden = false; place(movePreviewEl, rangeBox(movePreview)); }
    else movePreviewEl.hidden = true;
    renderCutRange();
    popovers.length = 0;
    const activeBox = rangeBox(am || { r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c });
    const showPop = (pop, dx, dy) => { pop.hidden = false; popovers.push({ el: pop, r: sel.active.r, c: sel.active.c, box: activeBox, dx, dy }); };
    // Cell popovers must not obscure a focused control or selected drawing.
    const hideCellPopovers = edit || selectedChart || objectsLayer.contains(document.activeElement);
    const activeRule = hideCellPopovers ? null : wb.validationAt(sheetId, sel.active.r, sel.active.c);
    if (activeRule?.type === 'list' && !activeRule.chips && !filterHeadAt(sheet(), sel.active.r, sel.active.c)) {
      listButton.style.height = `${Math.min(28, activeBox.height)}px`;
      showPop(listButton, activeBox.width, 0);
    } else listButton.hidden = true;
    const note = hideCellPopovers ? null : sheet().notes.get(cellKey(sel.active.r, sel.active.c));
    if (note) { notePop.textContent = note; showPop(notePop, activeBox.width + (listButton.hidden ? 6 : 30), 0); } else notePop.hidden = true;
    // A validation rule's input message sits under the cell while it is selected.
    const promptRule = hideCellPopovers ? null : (sheet().validations.length ? wb.validationAt(sheetId, sel.active.r, sel.active.c) : null);
    if (promptRule?.showInputMessage !== false && (promptRule?.prompt || promptRule?.promptTitle)) {
      promptPop.replaceChildren();
      if (promptRule.promptTitle) promptPop.append(el('strong.prompt-title', {}, promptRule.promptTitle));
      if (promptRule.prompt) promptPop.append(el('span', {}, promptRule.prompt));
      showPop(promptPop, 0, activeBox.height + 4);
    } else promptPop.hidden = true;
    // A link cell shows where it goes, with a way to follow or change it.
    const link = hideCellPopovers || !S.isSingle(sel) ? null : wb.linkAt(sheetId, sel.active.r, sel.active.c);
    if (link) {
      linkAnchor.href = link.url;
      linkAnchor.textContent = link.url.replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/^#/, '');
      linkAnchor.title = link.url.startsWith('#') ? 'Go to this place in the spreadsheet' : link.url;
      showPop(linkPop, 0, activeBox.height + 4);
    } else linkPop.hidden = true;
    syncPopovers(view);
    viewport.setAttribute('aria-activedescendant', `gc-${sel.active.r}-${sel.active.c}`);
    for (const n of cellsLayer.querySelectorAll('.cell[aria-selected]')) n.removeAttribute('aria-selected');
    // Every rendered cell of the selection is marked, not just the active one, so assistive tech can tell the range.
    const ranges = [...extras, S.selRange(sel)];
    for (const n of cellsLayer.querySelectorAll('.cell')) {
      const m = /^gc-(\d+)-(\d+)$/.exec(n.id);
      if (!m) continue;
      const r = Number(m[1]);
      const c = Number(m[2]);
      if (ranges.some((rg) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2)) n.setAttribute('aria-selected', 'true');
    }
    const activeNode = document.getElementById(`gc-${sel.active.r}-${sel.active.c}`);
    if (activeNode) activeNode.setAttribute('aria-selected', 'true');
  }

  function syncHeaders() {
    const view = viewMetrics();
    colHead.style.transform = colRuler.style.transform = `translateX(${-view.sl}px)`;
    rowHead.style.transform = rowRuler.style.transform = `translateY(${-view.st}px)`;
    syncFrozenScroll(view);
    syncPopovers(view);
    placeEditor(view);
  }

  /**
   * The popovers beside the active cell (its note, a rule's input message, a link's address) live
   * in the canvas and scroll with it. A frozen cell's cannot: the frozen pane is drawn over the
   * canvas, and the pane's own clipped layer would cut off a popover wider than the pane. Those are
   * hosted by the grid itself, placed where the cell is on the screen, and moved along with every
   * scroll of the cell's free axis, as the headers are; scrolled out of the viewport along it, the
   * popover goes out of sight rather than standing over the headers.
   */
  const popovers = []; // { el, r, c, box, dx, dy }: the popovers shown, placed again on scroll
  function syncPopovers(view = viewMetrics()) {
    for (const p of popovers) {
      const frozenCell = topBand(p.r) || leftBand(p.c);
      const host = frozenCell ? root : canvas;
      if (p.el.parentNode !== host) host.append(p.el);
      let x = p.box.left + p.dx;
      let y = p.box.top + p.dy;
      let off = false;
      if (frozenCell) {
        const vx = p.box.left - bandSL(p.c, view);
        const vy = p.box.top - bandST(p.r, view);
        x = rowHeaderW + vx + p.dx;
        y = colHeaderH + vy + p.dy;
        // A split window's left or top pane ends at the bar.
        const right = leftBand(p.c) && frozen.split ? frozen.w : view.vw, bottom = topBand(p.r) && frozen.split ? frozen.h : view.vh;
        off = ((!leftBand(p.c) || frozen.split) && (vx + p.box.width <= 0 || vx >= right)) || ((!topBand(p.r) || frozen.split) && (vy + p.box.height <= 0 || vy >= bottom));
      }
      if (p.el === listButton) {
        const vx = p.box.left - bandSL(p.c, view);
        const vy = p.box.top - bandST(p.r, view);
        const leftEdge = leftBand(p.c) ? 0 : frozen.w, topEdge = topBand(p.r) ? 0 : frozen.h;
        off = vx + p.box.width <= leftEdge || vx >= view.vw || vy + p.box.height <= topEdge || vy >= view.vh;
        // At the viewport edge the button may overlay the active cell, but it
        // never consumes text width or remains over a cell scrolled out of view.
        x = Math.max(leftEdge, Math.min(vx + p.dx, view.vw - LIST_BUTTON_W)) + (frozenCell ? rowHeaderW : view.sl);
        // Frozen-cell controls live outside the pane's clip. Clip the button
        // itself when only part of its row is visible, so it cannot cover or
        // intercept presses on the headers or the frozen rows above it.
        const height = parseFloat(listButton.style.height);
        listButton.style.clipPath = `inset(${Math.max(0, topEdge - vy)}px 0 ${Math.max(0, vy + height - view.vh)}px 0)`;
      }
      p.el.classList.toggle('offscreen', off);
      p.el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  /* ---------- Selection API ---------- */

  function setSelection(next, { scroll = true, announce = true, add = false, scrollActive = false, grow = true } = {}) {
    if (sheet()?.kind === 'chart') { extras = []; schedule(); opts.onSelection?.(sel); return; }
    tabOrigin = null; // any move but a Tab ends a run of Tabs; tabStep puts the origin back
    const b = bounds();
    if (!add) extras = [];
    const fix = (p) => ({ r: clamp(p.r, 0, b.rows - 1), c: clamp(p.c, 0, b.cols - 1) });
    sel = { active: fix(next.active), anchor: fix(next.anchor), focus: fix(next.focus), ...(next.scope ? { scope: next.scope } : {}) };
    // The active cell of a range never sits in a hidden row or column (a header click or
    // Ctrl+A puts it at the first line): typing would open an editor nobody can see. It
    // moves to the range's nearest visible cell, as in Excel; a range of hidden lines alone
    // keeps it, so Unhide still knows which lines are meant.
    if (!S.isSingle(sel)) {
      const s = sheet();
      if (rowHidden(s, sel.active.r) || s.hiddenCols.has(sel.active.c)) {
        const range = S.selRange(sel);
        const t = visibleTarget(sel.active, 1, 1);
        if (t.r >= range.r1 && t.r <= range.r2 && t.c >= range.c1 && t.c <= range.c2) sel.active = t;
      }
    }
    // A selection never cuts through a merged block; the active cell is its anchor. The
    // anchor and focus keep the cells the user meant, so extending again starts from them
    // rather than from a corner of the grown box; the grown box travels as `range`.
    if (sheet().merges.length) {
      const range = S.selRange(sel);
      const grown = wb.expandToMerges(sheetId, range);
      const m = wb.mergeAt(sheetId, sel.active.r, sel.active.c);
      if (m) sel.active = { r: m.r1, c: m.c1 };
      if (grown.r1 !== range.r1 || grown.c1 !== range.c1 || grown.r2 !== range.r2 || grown.c2 !== range.c2) sel.range = grown;
    }
    // Selecting the last row or column grows the sheet so there is always somewhere to go, like an
    // endless page. A Ctrl+Arrow jump that lands on the last line, nothing lying beyond it, stops
    // there as in Excel (grow: false), rather than pushing the edge out with every press.
    // The sheet is Excel's whole grid, but the canvas holds only the rows and columns reached so far: a cell
    // selected or brought into view beyond them (Ctrl+Down to row 1,048,576, the Name Box) reaches them now.
    // A whole-line endpoint sits on the far edge of the other axis. Extending
    // columns/rows reveals only their own axis; Enter and Tab still reveal the active cell.
    const target = scrollActive ? sel.active : sel.focus;
    const reveal = {
      rows: scrollActive || !['columns', 'sheet'].includes(sel.scope),
      cols: scrollActive || !['rows', 'sheet'].includes(sel.scope),
    };
    const s = sheet();
    const needR = Math.max(sel.active.r, scroll && reveal.rows ? target.r : 0);
    const needC = Math.max(sel.active.c, scroll && reveal.cols ? target.c : 0);
    let rows = needR >= s.rows ? needR + 1 + GROW_ROWS : 0;
    let cols = needC >= s.cols ? needC + 1 + GROW_COLS : 0;
    if (grow && sel.active.r >= s.rows - 1) rows = Math.max(rows, s.rows + GROW_ROWS);
    if (grow && sel.active.c >= s.cols - 1) cols = Math.max(cols, s.cols + GROW_COLS);
    if ((rows || cols) && wb.ensureSize(sheetId, rows, cols)) rebuildOffsets();
    if (scroll) scrollIntoView(target, reveal);
    // The cell nodes stay as they are: rebuilding them on a click would
    // detach the pressed node before the release, and the browser then drops
    // the click and any double-click. Headers re-highlight in place. Only an
    // active cell outside the rendered rows and columns needs a rebuild, which
    // keeps it in the DOM for aria-activedescendant.
    const a = sel.active;
    if (a.r < rendered.r0 || a.r > rendered.r1 || a.c < rendered.c0 || a.c > rendered.c1) rendered.key = null;
    schedule();
    rememberSheetSelection();
    opts.onSelection?.(sel);
    if (announce) speak();
  }

  /**
   * Ctrl+A (and Ctrl+Shift+Space): the block of data around the active cell first, keeping the
   * active cell, as in Excel; the whole sheet when pressed again, or when the active cell has no
   * block around it. The select-all corner takes the whole sheet at once.
   */
  function selectAllStep() {
    const { r, c } = sel.active;
    const b = bounds();
    const range = S.selRange(sel);
    // Once the whole sheet is selected, further presses keep it, as in Excel, rather than going back to the block.
    if (range.r1 === 0 && range.c1 === 0 && range.r2 >= b.rows - 1 && range.c2 >= b.cols - 1) { setSelection(S.selectAll(b), { scroll: false }); return; }
    const region = wb.dataRegion(sheetId, r, c);
    const block = region && (region.r1 !== region.r2 || region.c1 !== region.c2)
      && !(range.r1 === region.r1 && range.c1 === region.c1 && range.r2 === region.r2 && range.c2 === region.c2);
    setSelection(block ? S.fromRange(region, { r, c }) : S.selectAll(b), { scroll: false });
  }

  /**
   * Excel's keyboard modes, shown in the status bar: End Mode (the next arrow jumps to the edge of the data),
   * Extend Selection (F8: arrows and clicks extend) and Add to Selection (Shift+F8: arrows and clicks add ranges).
   */
  let keyMode = null;
  function setKeyMode(mode) {
    if (keyMode === mode) return;
    keyMode = mode;
    opts.onSelection?.(sel);
  }

  /** Remember a range as part of a multi-range selection (once). */
  function addRange(range) {
    if (extras.some((x) => x.r1 === range.r1 && x.c1 === range.c1 && x.r2 === range.r2 && x.c2 === range.c2)) return;
    if (extras.length >= 500) return;
    extras.push({ ...range });
  }

  function speak() {
    if (!opts.announce) return;
    const range = S.selRange(sel);
    const { r, c } = sel.active;
    let text = wb.getDisplay(sheetId, r, c);
    // A very long text is read out in part, with its length: the whole of it would take minutes, or
    // choke the reader. The cut falls between characters as a reader sees them.
    if (text.length > SPOKEN_MAX) {
      const units = graphemes(text);
      text = `${typeof units === 'string' ? units.slice(0, SPOKEN_MAX) : units.slice(0, SPOKEN_MAX).join('')}… ${text.length.toLocaleString()} characters`;
    }
    const cell = wb.getCell(sheetId, r, c);
    let msg = `${cellName(r, c)}${text ? `, ${text}` : ', empty'}`;
    if (cell?.f != null) msg += `, formula`;
    if (!S.isSingle(sel)) msg = `${rangeName(range)} selected. ${msg}`;
    if (extras.length) msg = `${extras.length + 1} ranges selected. ${msg}`;
    opts.announce(msg);
  }

  /**
   * The grid's own scrolling (a cell brought into view, a sheet's position restored, a zoom keeping
   * its corner) remembers where it went, so the scroll event it raises is not taken for the user
   * reaching the sheet's edge: only their wheel, drag or scrollbar grows the endless page. An event
   * that finds the viewport elsewhere is the user's; a scroll that changes nothing raises no event,
   * and the frame forgets a place nothing consumed.
   */
  function scrollViewportTo(left, top) {
    // Callers speak of the scrolling pane's own scroll; a split window's canvas sits `shift` into the viewport.
    left += shift.x;
    top += shift.y;
    scrollByCode = { left, top };
    viewport.scrollTo({ left, top });
    rememberViewOrigin();
  }

  function rememberViewOrigin(view = viewMetrics()) {
    if (pendingOrigin || !root.isConnected || sheet()?.kind === 'chart') return;
    ensureOffsets();
    const origin = { r: rowOffsets.indexAt(view.st + frozen.h), c: colOffsets.indexAt(view.sl + frozen.w) };
    if (sheet().viewOrigin || origin.r || origin.c) wb.setSheetOrigin(sheetId, origin);
  }

  function restoreViewOrigin() {
    // Construction precedes mounting. A detached viewport clamps scrollTo
    // to zero, so restore only once it has a real layout.
    if (!pendingOrigin || !root.isConnected || !viewport.clientWidth || !viewport.clientHeight) return;
    const origin = pendingOrigin, s = sheet();
    windowsFor(Math.min(origin.r, s.rows - 1), Math.min(origin.c, s.cols - 1));
    const left = Math.max(-shift.x, (colOffsets.at(Math.min(origin.c, s.cols - 1)) || 0) - frozen.w);
    const top = Math.max(-shift.y, (rowOffsets.at(Math.min(origin.r, s.rows - 1)) || 0) - frozen.h);
    // A saved origin beyond the used range still needs a viewport's worth
    // of blank grid. Growing that display extent is ordinary navigation.
    const moreRows = Math.ceil(Math.max(0, top + viewport.clientHeight - rowOffsets.total()) / Math.max(1, Math.round(s.defaultRowHeight * zoom)));
    const moreCols = Math.ceil(Math.max(0, left + viewport.clientWidth - colOffsets.total()) / Math.max(1, Math.round(s.defaultColWidth * zoom)));
    if ((moreRows || moreCols) && wb.ensureSize(sheetId, s.rows + moreRows, s.cols + moreCols, { restoreView: true })) rebuildOffsets();
    pendingOrigin = null;
    scrollViewportTo(left, top);
  }

  /** Scroll a cell into view; `cols` or `rows` false leaves that axis where it is. */
  function scrollIntoView({ r, c }, { cols = true, rows = true } = {}) {
    pendingOrigin = null; // explicit navigation supersedes an unopened saved view
    ensureOffsets();
    windowsFor(rows ? r : null, cols ? c : null);
    // A jump far down widens the row headings for the longer numbers it shows: done first, so the
    // narrower view it leaves is the one the cell is brought into.
    if (rows) fitRowDigits(Math.min(sheet().rows - 1, r + Math.ceil(viewport.clientHeight / Math.max(1, rowH(r) || 1))));
    const left = colX(c);
    const right = colEnd(c);
    const top = rowY(r);
    const bottom = rowEnd(r);
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    // A split window's left or top pane, when it is the active one, scrolls itself.
    if (frozen.split && ((cols && leftBand(c)) || (rows && topBand(r)))) {
      let psl = frozen.sl, pst = frozen.st;
      if (cols && leftBand(c)) { if (left < psl) psl = left; else if (right > psl + frozen.w) psl = right - frozen.w; }
      if (rows && topBand(r)) { if (top < pst) pst = top; else if (bottom > pst + frozen.h) pst = bottom - frozen.h; }
      scrollSplitPanes(psl, pst);
    }
    const sl0 = viewport.scrollLeft - shift.x;
    const st0 = viewport.scrollTop - shift.y;
    let sl = sl0;
    let st = st0;
    // Frozen cells are always in view; others must clear the frozen band.
    if (cols && c >= frozen.cols && !leftBand(c)) {
      if (left - frozen.w < sl) sl = Math.max(-shift.x, left - frozen.w);
      else if (right > sl + vw) sl = right - vw;
    }
    if (rows && r >= frozen.rows && !topBand(r)) {
      if (top - frozen.h < st) st = Math.max(-shift.y, top - frozen.h);
      else if (bottom > st + vh) st = bottom - vh;
    }
    if (sl !== sl0 || st !== st0) scrollViewportTo(sl, st);
  }

  /** Reveal the active cell beside a floating panel, using the smallest possible scroll.
   * Frozen cells cannot move on their frozen axis; false lets the panel find another home. */
  function revealBeside(avoid) {
    const { r, c } = sel.active;
    const cell = cellRect(r, c), vp = viewport.getBoundingClientRect();
    const merged = mergeAt(r, c);
    if (merged) {
      const end = cellRect(merged.r2, merged.c2);
      cell.right = end.right; cell.bottom = end.bottom;
      cell.width = cell.right - cell.left; cell.height = cell.bottom - cell.top;
    }
    const gap = 6;
    const obstacle = { left: avoid.left - gap, right: avoid.right + gap, top: avoid.top - gap, bottom: avoid.bottom + gap };
    if (cell.right <= obstacle.left || cell.left >= obstacle.right || cell.bottom <= obstacle.top || cell.top >= obstacle.bottom) return true;
    const fixedX = leftBand(c), fixedY = topBand(r);
    const bounds = {
      left: vp.left + (fixedX ? 0 : frozen.w), right: vp.left + (fixedX ? frozen.w : viewport.clientWidth),
      top: vp.top + (fixedY ? 0 : frozen.h), bottom: vp.top + (fixedY ? frozen.h : viewport.clientHeight),
    };
    const spaces = [
      { ...bounds, right: Math.min(bounds.right, obstacle.left) },
      { ...bounds, left: Math.max(bounds.left, obstacle.right) },
      { ...bounds, bottom: Math.min(bounds.bottom, obstacle.top) },
      { ...bounds, top: Math.max(bounds.top, obstacle.bottom) },
    ];
    let best = null;
    for (const space of spaces) {
      if (space.right - space.left < cell.width || space.bottom - space.top < cell.height) continue;
      const dx = Math.max(space.left - cell.left, Math.min(0, space.right - cell.right));
      const dy = Math.max(space.top - cell.top, Math.min(0, space.bottom - cell.bottom));
      if ((fixedX && dx) || (fixedY && dy)) continue;
      const left = viewport.scrollLeft - dx, top = viewport.scrollTop - dy;
      if (left < 0 || top < 0 || left > viewport.scrollWidth - viewport.clientWidth || top > viewport.scrollHeight - viewport.clientHeight) continue;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (!best || distance < best.distance) best = { left, top, distance };
    }
    if (!best) return false;
    scrollViewportTo(best.left - shift.x, best.top - shift.y);
    return true;
  }

  /* ---------- Editing ---------- */

  function positionEditor(view = viewMetrics()) {
    if (!edit) return;
    // On another sheet (picking a reference) the box stays out of sight but keeps the keyboard.
    const away = edit.sheetId !== sheetId;
    editor.classList.toggle('offsheet', away);
    if (away) return;
    const { r, c } = edit;
    ensureOffsets();
    const host = editorHost(r, c);
    if (editor.parentNode !== host) host.append(editor);
    const m = mergeAt(r, c);
    const w = m ? colEnd(m.c2) - colX(c) : colW(c);
    const h = m ? rowEnd(m.r2) - rowY(r) : rowH(r);
    placeEditor(view);
    const cell = wb.getCell(sheetId, r, c);
    const st = wb.styleAt(sheetId, r, c);
    const formula = edit.text.startsWith('=');
    // On touch screens the editor never drops below 16px, or iOS zooms the page into it.
    const size = Math.max(coarsePointer ? 16 : 0, (st?.size || baseFontSize) * zoom);
    const family = (!formula && fontStack(st?.font)) || '';
    editor.classList.toggle('calibri', !formula && st?.font === 'calibri');
    editor.style.fontSize = `${size.toFixed(2)}px`;
    editor.style.fontFamily = family;
    // The cell's weight and slant too, so the text does not change as editing begins, and the caret is placed with the font it is drawn in.
    editor.style.fontWeight = st?.bold ? '600' : '';
    editor.style.fontStyle = st?.italic ? 'italic' : '';
    // Text is typed in the direction its first letter gives (dir=auto), aligned to its end unless the cell says otherwise; a formula reads left to right.
    editor.setAttribute('dir', formula ? 'ltr' : 'auto');
    const align = st?.align || (typeof cell?.v === 'number' && cell.f == null ? 'right' : 'start');
    editor.style.textAlign = formula ? 'left' : align;
    const indent = !formula ? cellIndent(cell?.v, st) * zoom : 0;
    const inset = indent + CELL_TEXT_INSET * zoom;
    const indentRight = align === 'right' || align === 'start' && RTL_LEAD.test(edit.text);
    editor.style.paddingLeft = indent && !indentRight ? `${inset}px` : '';
    editor.style.paddingRight = indent && indentRight ? `${inset}px` : '';
    // A wrapped cell's text wraps in the editor too, at the cell's width; any
    // other text runs on to the right, as far as the viewport allows.
    const wrap = !!st?.wrap && !formula;
    editor.classList.toggle('wrap', wrap);
    const text = editor.value || '';
    const lines = text.split('\n');
    editor.style.minWidth = `${w}px`;
    edit.font = `${st?.italic ? 'italic ' : ''}${st?.bold ? '600 ' : ''}${size.toFixed(2)}px ${family || cellFont.replace(/^[\d.]+px\s*/, '')}`;
    if (wrap) editor.style.width = `${w}px`;
    else {
      // Imported cell text can contain more lines than a function call can
      // accept as arguments. Scan widths without allocating an argument list.
      const needed = lines.reduce((width, line) => Math.max(width, textWidth(line, edit.font)), 0) + 16 + indent;
      // As far as the viewport's right edge from where the cell is on the screen; a frozen column has not scrolled.
      const screenLeft = colX(c) - bandSL(c, view);
      const maxW = Math.max(w, view.vw - screenLeft - 2);
      editor.style.width = `${clamp(needed, w, Math.max(w, maxW))}px`;
    }
    // One line sits where the cell draws its text (centered, or at the top or
    // bottom when the cell says so); several lines start at the top and the
    // box grows downward to show them all, as far as the viewport goes.
    const lineH = size * (wrap && st?.font !== 'calibri' ? 1.3 : 1.2);
    const single = !wrap && lines.length === 1;
    let padTop;
    if (!single) padTop = 2;
    else if (st?.valign === 'top') padTop = 1;
    else if (st?.valign === 'bottom') padTop = h - lineH - 5;
    else padTop = (h - lineH) / 2 - 2;
    editor.style.paddingTop = `${Math.max(0, padTop).toFixed(2)}px`;
    editor.style.height = `${h}px`;
    if (!single) {
      const screenTop = rowY(r) - bandST(r, view);
      const avail = Math.max(h, view.vh - screenTop - 2);
      let needH = lines.length * lineH + padTop + 6;
      if (wrap) needH = Math.max(needH, editor.scrollHeight + 4); // the browser's own wrapping decides
      editor.style.height = `${Math.round(clamp(needH, h, avail))}px`;
    }
  }

  function beginEdit({ text = null, mode = 'inplace', focusEditor = true, preserveRichText = text == null } = {}) {
    if (sheet()?.kind === 'chart') return null;
    if (edit) return edit;
    let { r, c } = sel.active;
    const array = wb.fixedArrayAt(sheetId, r, c);
    if (array) {
      const range = S.selRange(sel);
      if (extras.length || range.r1 > array.r1 || range.c1 > array.c1 || range.r2 < array.r2 || range.c2 < array.c2) {
        wb.arrayEditBlocked(sheetId, { r1: r, c1: c, r2: r, c2: c });
        return null;
      }
      r = array.r;
      c = array.c;
    }
    if (wb.lockedAt(sheetId, r, c)) return null;
    const cell = wb.getCell(sheetId, r, c);
    const initial = text ?? editText(cell);
    // Typing into a cell that was scrolled away brings it back first.
    if (focusEditor) scrollIntoView({ r, c });
    edit = { r, c, sheetId, text: initial, mode, refInsert: null, point: null, pasted: false, preserveRichText,
      arrayRange: array ? { r1: array.r1, c1: array.c1, r2: array.r2, c2: array.c2 } : null };
    editor.value = initial;
    editor.spellcheck = spellcheck && !initial.startsWith('=');
    editor.hidden = false;
    positionEditor();
    if (focusEditor) {
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(initial.length, initial.length);
    }
    root.classList.add('editing');
    renderSelection();
    renderRefHighlights();
    opts.onEdit?.({ editing: true, text: initial, r, c });
    updateHints();
    schedule();
    return edit;
  }

  function setEditText(text, { fromEditor = false } = {}) {
    if (!edit) return;
    edit.text = text;
    edit.refInsert = null;
    edit.point = null;
    if (!fromEditor && editor.value !== text) editor.value = text;
    const spell = spellcheck && !text.startsWith('=');
    if (editor.spellcheck !== spell) editor.spellcheck = spell;
    positionEditor();
    renderRefHighlights();
    opts.onEdit?.({ editing: true, text, r: edit.r, c: edit.c });
    updateHints();
  }

  /** While a formula is being typed on another sheet, come back to the cell being edited. */
  let returning = false; // setSheet is re-entered by the active-sheet event while coming home
  function returnHome() {
    if (!edit || edit.sheetId === sheetId || !wb.sheet(edit.sheetId)) return;
    showSheet(edit.sheetId);
    returning = true;
    try { if (wb.activeSheetId !== sheetId) wb.setActiveSheet(sheetId); } finally { returning = false; }
  }

  let validationPending = null;
  function askValidation(verdict, options = {}) {
    const attempt = edit, text = edit.text, version = wb.version;
    const pending = {};
    validationPending = pending;
    confirmValidation(verdict).then(choice => {
      if (validationPending !== pending) return;
      validationPending = null;
      if (edit !== attempt || edit.text !== text || wb.version !== version) return;
      if (choice === 'accept' && validationAlertStyle(verdict.rule) !== 'stop') commitEdit({ ...options, acceptedWarnings: true });
      else if (choice === 'cancel') cancelEdit();
      else editor.focus({ preventScroll: true });
    });
  }
  function refuseValidation(verdict) {
    opts.announce?.(verdict.message || 'Invalid value');
    const dialog = validationAlertStyle(verdict.rule) === 'stop';
    opts.onInvalid?.(verdict, { dialog });
    if (dialog) askValidation(verdict);
    else editor.focus({ preventScroll: true });
    return false;
  }
  function commitEdit({ move = null, fillSelection = false, arrayEntry = false, acceptedWarnings = false } = {}) {
    if (!edit) return false;
    if (validationPending) return false;
    returnHome();
    const { r, c, text, preserveRichText } = edit;
    // The cell was protected while its entry was being typed: the workbook would refuse the write in
    // silence, so the entry stays open (the workbook's notice says why) rather than being dropped.
    if (wb.lockedAt(sheetId, r, c)) { editor.focus({ preventScroll: true }); return false; }
    const verdict = opts.validate?.(r, c, text);
    let warning = verdict?.ok === false && validationAlertStyle(verdict.rule) ? verdict : null;
    if (verdict && verdict.ok === false && verdict.strict) {
      // A Stop alert can return to this draft or discard it, never accept it.
      return refuseValidation(verdict);
    }
    const targets = [...extras, S.selRange(sel)];
    const arrayRange = edit.arrayRange || (arrayEntry ? S.selRange(sel) : null);
    if (arrayEntry && extras.length) {
      opts.announce?.('Select one continuous range for an array formula. Your entry is still being edited.');
      editor.focus({ preventScroll: true });
      return false;
    }
    if (arrayRange) {
      const previous = wb.getCell(sheetId, arrayRange.r1, arrayRange.c1);
      const unchanged = text === editText(previous) && previous?.array?.rows === arrayRange.r2 - arrayRange.r1 + 1
        && previous.array.cols === arrayRange.c2 - arrayRange.c1 + 1;
      if (!unchanged && !wb.setArrayFormula(sheetId, arrayRange, text)) {
        editor.focus({ preventScroll: true });
        return false;
      }
    } else if (wb.arrayEditBlocked(sheetId, { r1: r, c1: c, r2: r, c2: c })) {
      editor.focus({ preventScroll: true });
      return false;
    }
    const filling = !arrayRange && fillSelection && (targets.length > 1 || !S.isSingle(sel));
    if (filling) {
      const count = targets.reduce((total, rg) => total + (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1), 0);
      if (count > 50000) {
        opts.announce?.('Select at most 50,000 cells to fill at once. Your entry is still being edited.');
        editor.focus({ preventScroll: true });
        return false;
      }
      // Preflight every destination before any range is written. A strict
      // rule or protected range must not leave a partially applied fill.
      for (const rg of targets) if (wb.arrayEditBlocked(sheetId, rg, { whole: true })) {
        editor.focus({ preventScroll: true });
        return false;
      }
      for (const rg of targets) for (let rr = rg.r1; rr <= rg.r2; rr++) for (let cc = rg.c1; cc <= rg.c2; cc++) {
        if (wb.lockedAt(sheetId, rr, cc)) { editor.focus({ preventScroll: true }); return false; }
        const check = opts.validate?.(rr, cc, text);
        if (!warning && check?.ok === false && validationAlertStyle(check.rule)) warning = check;
        if (check && check.ok === false && check.strict) {
          return refuseValidation(check);
        }
      }
    }
    if (warning && !acceptedWarnings) {
      askValidation(warning, { move, fillSelection, arrayEntry });
      return false;
    }
    endEdit();
    const cell = wb.getCell(sheetId, r, c);
    if (arrayRange) {
      // The fixed array was written atomically before closing the editor.
    } else if (filling) {
      // Ctrl+Enter: every selected range takes the entry, formulas shifting from the typed cell.
      wb.transaction('Fill', () => { for (const rg of targets) wb.fillInput(sheetId, rg, text, { r, c }); });
    } else if (text !== editText(cell)) {
      const wraps = !!wb.styleAt(sheetId, r, c)?.wrap;
      // Lines added with Alt+Enter turn wrapping on, so the row can show them all.
      const multiline = text.includes('\n') && !text.startsWith('=');
      if (wraps || multiline) {
        // A row the grid sized itself is fitted to its text again; one someone sized keeps its height,
        // growing only when the text no longer fits, as in Excel. Which it is, is judged before the
        // entry changes what the row's text needs.
        const sized = rowSizedByHand(r);
        wb.transaction('Edit cell', () => {
          wb.setInput(sheetId, r, c, text, { preserveRichText });
          if (multiline && !wraps) wb.applyStyle(sheetId, { r1: r, c1: c, r2: r, c2: c }, { wrap: true });
          autoFitRows(r, r, { grow: sized });
        });
      } else {
        wb.transaction('Edit cell', () => {
          wb.setInput(sheetId, r, c, text, { preserveRichText });
          // A column widened for the entry has its rows of wrapped text fitted within the same step, as
          // a dragged column does, so Ctrl+Z takes the entry back rather than a row height first.
          const was = wb.colWidth(sheetId, c);
          if (widenForEntry(r, c)) { invalidateOffsets(); refitWrappedRows([c], new Map([[c, was]])); }
        });
      }
    }
    if (move === 'down') enterDown(false);
    else if (move === 'up') enterDown(true);
    else if (move === 'right') tabRight();
    else if (move === 'left') tabStep(true);
    else schedule();
    return true;
  }

  /**
   * One step from a single cell: hidden rows and columns are skipped and a
   * merged block counts as one cell, stopping at the sheet edge.
   */
  function stepFrom(from, dr, dc) {
    const b = bounds();
    const s = sheet();
    const m = wb.mergeAt(sheetId, from.active.r, from.active.c);
    // Leaving a merge steps off its far edge; the other axis stays where the step began, so a
    // selection's focus inside a merge comes back to its own row or column.
    const start = m ? { ...from, active: { r: dr > 0 ? m.r2 : dr < 0 ? m.r1 : from.active.r, c: dc > 0 ? m.c2 : dc < 0 ? m.c1 : from.active.c } } : from;
    let next = S.move(start, dr, dc, b);
    while ((dr && rowHidden(s, next.active.r)) || (dc && s.hiddenCols.has(next.active.c))) {
      const further = S.move(next, dr, dc, b);
      if (further.active.r === next.active.r && further.active.c === next.active.c) return from;
      next = further;
    }
    return next;
  }

  /** Resolve a keyboard destination to visible lines, falling back at an edge. */
  function visibleTarget(target, dr, dc) {
    const s = sheet();
    const line = (at, delta, total, hidden) => {
      if (!delta || !hidden(at)) return at;
      let i = at;
      while (i >= 0 && i < total && hidden(i)) i += delta;
      if (i >= 0 && i < total) return i;
      i = at;
      while (i >= 0 && i < total && hidden(i)) i -= delta;
      return i >= 0 && i < total ? i : at;
    };
    return {
      r: line(target.r, dr, bounds().rows, (r) => rowHidden(s, r)),
      c: line(target.c, dc, bounds().cols, (c) => s.hiddenCols.has(c)),
    };
  }

  /**
   * Enter and Tab (Shift reverses): the next cell down or to the right. A
   * single cell steps like the arrows; inside a range the active cell walks
   * the range, passing over hidden lines and the covered cells of merges.
   */
  function stepSelection(dir, back) {
    const range = S.selRange(sel);
    const own = wb.mergeAt(sheetId, sel.active.r, sel.active.c);
    const oneCell = S.isSingle(sel) || (!!own && own.r1 === range.r1 && own.c1 === range.c1 && own.r2 === range.r2 && own.c2 === range.c2);
    if (oneCell) return stepFrom(sel, dir === 'down' ? (back ? -1 : 1) : 0, dir === 'right' ? (back ? -1 : 1) : 0);
    const b = bounds();
    const s = sheet();
    ensureOffsets();
    if (rowOffsets.at(range.r2 + 1) === rowOffsets.at(range.r1) || colOffsets.at(range.c2 + 1) === colOffsets.at(range.c1)) return sel;
    const covered = (p) => { const m = wb.mergeAt(sheetId, p.r, p.c); return !!m && (m.r1 !== p.r || m.c1 !== p.c); };
    const skip = (p) => rowHidden(s, p.r) || s.hiddenCols.has(p.c) || covered(p);
    let next = back ? S.retreat(sel, dir, b) : S.advance(sel, dir, b);
    let guard = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    while (skip(next.active)) {
      const p = next.active;
      const edge = { ...p };
      // Skip a whole hidden scan line, or the covered part of a merge,
      // instead of visiting every cell in its area.
      if (dir === 'down' && s.hiddenCols.has(p.c)) edge.r = back ? range.r1 : range.r2;
      else if (dir === 'right' && rowHidden(s, p.r)) edge.c = back ? range.c1 : range.c2;
      else {
        const m = wb.mergeAt(sheetId, p.r, p.c);
        if (m && (m.r1 !== p.r || m.c1 !== p.c)) {
          if (dir === 'down') edge.r = back ? m.r1 + (p.c === m.c1 ? 1 : 0) : m.r2;
          else edge.c = back ? m.c1 + (p.r === m.r1 ? 1 : 0) : m.c2;
        }
      }
      guard -= Math.abs(edge.r - p.r) + Math.abs(edge.c - p.c) + 1;
      if (guard <= 0) return sel; // nothing visible to land on
      next = { ...next, active: edge };
      next = back ? S.retreat(next, dir, b) : S.advance(next, dir, b);
    }
    return next;
  }

  /**
   * With ranges added by Ctrl/Cmd+click, Tab and Enter walk the active cell through the current
   * range and then on into the next one (Shift: back into the one before, at its last cell),
   * round and round, as in Excel; every range stays selected. Null when there is one range only.
   */
  function stepAreas(dir, back) {
    if (!extras.length) return null;
    const s = sheet();
    const range = S.selRange(sel, true);
    const own = wb.mergeAt(sheetId, sel.active.r, sel.active.c);
    const oneCell = S.isSingle(sel) || (!!own && own.r1 === range.r1 && own.c1 === range.c1 && own.r2 === range.r2 && own.c2 === range.c2);
    if (!oneCell) {
      const next = stepSelection(dir, back);
      // Enter walks the range down its columns, Tab along its rows; a step that lands at or behind
      // its start has run off the end and wrapped, which is when the walk moves on.
      const order = (p) => (dir === 'down' ? (p.c - range.c1) * (range.r2 - range.r1 + 1) + (p.r - range.r1) : (p.r - range.r1) * (range.c2 - range.c1 + 1) + (p.c - range.c1));
      const wrapped = back ? order(next.active) >= order(sel.active) : order(next.active) <= order(sel.active);
      if (!wrapped) return next;
    }
    const areas = [...extras, range];
    const target = back ? areas[areas.length - 2] : areas[0];
    extras = back ? [range, ...areas.slice(0, -2)] : areas.slice(1);
    // The first (or last) cell of the range in the walk's order that is shown and not covered by a
    // merge: Enter walks a column at a time, Tab a row at a time.
    const covered = (r, c) => { const m = s.merges.length ? mergeAt(r, c) : null; return !!m && (m.r1 !== r || m.c1 !== c); };
    const down = dir === 'down';
    const [aLo, aHi, bLo, bHi] = down ? [target.c1, target.c2, target.r1, target.r2] : [target.r1, target.r2, target.c1, target.c2];
    const hiddenA = (a) => (down ? s.hiddenCols.has(a) : rowHidden(s, a));
    const hiddenB = (b) => (down ? rowHidden(s, b) : s.hiddenCols.has(b));
    const step = back ? -1 : 1;
    let landing = back ? { r: target.r2, c: target.c2 } : { r: target.r1, c: target.c1 };
    search: for (let a = back ? aHi : aLo; a >= aLo && a <= aHi; a += step) {
      if (hiddenA(a)) continue;
      for (let b = back ? bHi : bLo; b >= bLo && b <= bHi; b += step) {
        if (hiddenB(b)) continue;
        const [r, c] = down ? [b, a] : [a, b];
        if (!covered(r, c)) { landing = { r, c }; break search; }
      }
    }
    return S.fromRange(target, landing);
  }

  // Where a run of Tabs began: Enter then returns to that column on the next row, as in Excel and
  // Sheets. A click or an arrow key ends the run (setSelection clears the origin).
  let tabOrigin = null;

  /** Tab or Shift+Tab: one cell along. Only a run from a single cell has an origin; inside a range Enter walks the range. */
  function tabStep(back) {
    const { r, c } = sel.active;
    const origin = S.isSingle(sel) && !extras.length ? (tabOrigin?.r === r ? tabOrigin : { r, c }) : null;
    const walked = stepAreas('right', back);
    if (walked) setSelection(walked, { scrollActive: true, add: true });
    else setSelection(stepSelection('right', back), { scrollActive: true });
    tabOrigin = origin;
  }

  /** Tab: the next cell — or, from the last cell of a table's last row, a fresh row at the bottom of the table. */
  function tabRight() {
    const { r, c } = sel.active;
    const t = S.isSingle(sel) && !extras.length && wb.tableAt ? wb.tableAt(sheetId, r, c) : null;
    if (t && c === t.range.c2 && r === (t.totalsRow ? t.range.r2 - 1 : t.range.r2) && r > t.range.r1) {
      const nr = wb.addTableRow(sheetId, t.id);
      if (nr >= 0) { setSelection(S.single(nr, t.range.c1)); opts.announce?.(`New row ${nr + 1} in table ${t.name}`); return; }
    }
    tabStep(false);
  }

  function enterDown(shift) {
    const walked = stepAreas('down', shift);
    if (walked) { tabOrigin = null; setSelection(walked, { scrollActive: true, add: true }); return; }
    const next = stepSelection('down', shift);
    if (!shift && tabOrigin && S.isSingle(sel) && tabOrigin.r === sel.active.r && next.active.r !== sel.active.r) {
      const target = S.single(next.active.r, Math.min(tabOrigin.c, bounds().cols - 1));
      tabOrigin = null;
      setSelection(target, { scrollActive: true });
      return;
    }
    tabOrigin = null;
    setSelection(next, { scrollActive: true });
  }

  function cancelEdit() {
    if (!edit) return;
    returnHome();
    endEdit();
    schedule();
  }

  function endEdit() {
    edit = null;
    if (linkPop.parentNode !== canvas) canvas.append(linkPop);
    hints.close();
    editor.hidden = true;
    if (editor.parentNode !== canvas) canvas.append(editor);
    editor.style.clipPath = '';
    editor.value = '';
    root.classList.remove('editing');
    refLayer.replaceChildren();
    viewport.focus({ preventScroll: true });
    opts.onEdit?.({ editing: false });
  }

  /** While typing a formula, can a click insert a reference here? */
  function acceptsRef() {
    if (!edit || !edit.text.startsWith('=')) return false;
    if (edit.refInsert) return true;
    const caret = editInput().selectionStart;
    // A comma or parenthesis inside quoted text is part of the text, not a place for a reference.
    if (inString(edit.text, caret)) return false;
    const before = edit.text.slice(0, caret);
    return /[=+\-*/^&(,<>:;]\s*$/.test(before);
  }

  /** Is anything at (r, c) for Ctrl+Arrow to stop at: a value, a formula, or a spilled result? */
  function hasValue(r, c) {
    const s = sheet();
    // A cell covered by a merge holds what the merge's anchor holds.
    const m = s.merges.length ? mergeAt(r, c) : null;
    if (m) ({ r, c } = { r: m.r1, c: m.c1 });
    const cell = wb.getCell(sheetId, r, c);
    return (!!cell && (cell.v != null || cell.f != null)) || wb.spillAt(sheetId, r, c) !== null;
  }

  /**
   * Ctrl+Arrow from a cell: the edge of its block of data, passing over hidden lines. A merged
   * block is one cell, so the jump leaves it from its far edge as a plain arrow does; started
   * from its anchor it would find the block's own covered cells "filled" and run to its last one.
   */
  function jumpFrom(from, dr, dc) {
    const s = sheet();
    const m = s.merges.length ? wb.mergeAt(sheetId, from.active.r, from.active.c) : null;
    const start = m ? { ...from, active: { r: dr > 0 ? m.r2 : dr < 0 ? m.r1 : from.active.r, c: dc > 0 ? m.c2 : dc < 0 ? m.c1 : from.active.c } } : from;
    return S.jump(start, dr, dc, bounds(), hasValue, (r, c) => !rowHidden(s, r) && !s.hiddenCols.has(c), nextFilled);
  }

  /**
   * Where along one column (or row) anything may stop a Ctrl+Arrow: the stored values and formulas, the
   * spilled arrays and the merged blocks crossing it, as sorted, disjoint [from, to] runs. Built from the
   * stored cells, not by visiting a million empty ones, and kept while nothing changes.
   */
  let filledRuns = null; // { key, runs }
  function runsAlong(vertical, line) {
    const s = sheet();
    const key = `${wb.version}|${s.id}|${vertical ? 'c' : 'r'}${line}`;
    if (filledRuns?.key === key) return filledRuns.runs;
    const raw = [];
    for (const [k, cell] of s.cells) {
      if (cell.v == null && cell.f == null) continue;
      const comma = k.indexOf(',');
      const r = Number(k.slice(0, comma)), c = Number(k.slice(comma + 1));
      if (vertical ? c === line : r === line) raw.push(vertical ? r : c, vertical ? r : c);
    }
    const span = (a1, a2, b1, b2) => { if (line >= b1 && line <= b2) raw.push(a1, a2); };
    for (const a of wb._ensureSpills?.(s)?.anchors?.values() || []) {
      if (vertical) span(a.r, a.r + a.rows - 1, a.c, a.c + a.cols - 1);
      else span(a.c, a.c + a.cols - 1, a.r, a.r + a.rows - 1);
    }
    for (const m of s.merges) vertical ? span(m.r1, m.r2, m.c1, m.c2) : span(m.c1, m.c2, m.r1, m.r2);
    const pairs = [];
    for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
    pairs.sort((x, y) => x[0] - y[0]);
    const runs = [];
    for (const [a, b] of pairs) {
      const last = runs[runs.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else runs.push([a, b]);
    }
    filledRuns = { key, runs };
    return runs;
  }

  /** The next cell past (r, c) going (dr, dc) that may hold anything, or null: see S.jump. */
  function nextFilled(r, c, dr, dc) {
    const vertical = dr !== 0;
    const runs = runsAlong(vertical, vertical ? c : r);
    const at = vertical ? r : c;
    const forward = (vertical ? dr : dc) > 0;
    let lo = 0, hi = runs.length;
    if (forward) {
      // The first run ending after `at`.
      while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid][1] <= at) lo = mid + 1; else hi = mid; }
      if (lo >= runs.length) return null;
      const p = Math.max(runs[lo][0], at + 1);
      return vertical ? { r: p, c } : { r, c: p };
    }
    // The last run starting before `at`.
    while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid][0] < at) lo = mid + 1; else hi = mid; }
    if (lo === 0) return null;
    const p = Math.min(runs[lo - 1][1], at - 1);
    return vertical ? { r: p, c } : { r, c: p };
  }

  /**
   * Arrow keys while a formula wants a reference: move (or, with Shift, stretch) the pointed range;
   * with Ctrl or ⌘ the move runs to the edge of the data, as it does for the selection.
   */
  function pointRef(dir, extend, jump = false) {
    const [dr, dc] = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[dir];
    const step = (p) => (jump ? jumpFrom(S.single(p.r, p.c), dr, dc) : stepFrom(S.single(p.r, p.c), dr, dc)).active;
    const home = edit.sheetId === sheetId ? { r: edit.r, c: edit.c } : sel.active;
    let anchor = edit.point?.anchor || home;
    let focus = edit.point?.focus || home;
    if (extend && edit.point) focus = step(focus);
    else { focus = step(focus); anchor = focus; }
    edit.point = { anchor, focus };
    insertRef(normalizeRange({ r1: anchor.r, c1: anchor.c, r2: focus.r, c2: focus.c }));
    scrollIntoView(focus);
  }

  /** Insert a whole-column (B:D) or whole-row (2:3) reference, from a header press or drag. */
  function insertLineRef(axis, from, to) {
    const b = bounds();
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    insertRef(axis === 'col' ? { r1: 0, c1: lo, r2: b.rows - 1, c2: hi } : { r1: lo, c1: 0, r2: hi, c2: b.cols - 1 }, axis === 'col' ? 'cols' : 'rows');
  }

  function insertRef(range, kind = null) {
    if (!edit) return;
    // A reference picked on another sheet carries that sheet's name; whole lines read B:B or 2:2.
    const refText = `${edit.sheetId !== sheetId ? `${quoteSheet(sheet().name)}!` : ''}${kind ? refToText({ kind, ...normalizeRange(range) }) : rangeName(range)}`;
    const input = editInput();
    const caret = edit.refInsert ? edit.refInsert.start : input.selectionStart;
    const end = edit.refInsert ? edit.refInsert.end : caret;
    const next = edit.text.slice(0, caret) + refText + edit.text.slice(end);
    edit.text = next;
    editor.value = next;
    edit.refInsert = { start: caret, end: caret + refText.length };
    edit.point = { anchor: { r: range.r1, c: range.c1 }, focus: { r: range.r2, c: range.c2 } };
    input.value = next;
    input.focus({ preventScroll: true });
    input.setSelectionRange(edit.refInsert.end, edit.refInsert.end);
    positionEditor();
    renderRefHighlights();
    opts.onEdit?.({ editing: true, text: next, r: edit.r, c: edit.c });
  }

  // The references of the formula being edited, kept from one paint to the next: the layer is painted on
  // every keystroke and every scroll frame, and only the text (or the sheet it is read against) changes them.
  let editRefs = { key: null, refs: [] };

  /** The references in the edited formula, structured ones resolved, parsed again only when the text changes. */
  function refsOfEdit() {
    const key = `${sheetId} ${wb.version} ${edit.text}`;
    if (editRefs.key === key) return editRefs.refs;
    const refs = extractRefs(edit.text.slice(1));
    // Structured references (Sales[Amount], [@Qty]) light up the cells they name, in the colors that follow the plain ones.
    if (edit.text.includes('[') && wb.resolveTableRef) {
      let tokens = [];
      try { tokens = tokenize(edit.text.slice(1)); } catch { tokens = []; }
      for (const t of tokens) {
        if (t.type !== 'tref') continue;
        const ref = wb.resolveTableRef(sheetId, edit.r, edit.c, t.table, t.spec);
        if (!ref || ref.error) continue;
        refs.push({ ref, start: t.start, end: t.end });
      }
    }
    editRefs = { key, refs };
    return refs;
  }

  function renderRefHighlights(view = viewMetrics()) {
    refLayer.replaceChildren();
    if (!edit || !edit.text.startsWith('=')) return;
    const s = sheet();
    const refs = refsOfEdit();
    const away = edit.sheetId !== sheetId;
    // Only a reference in view gets a box: one crossing the scrolled window, or one in a frozen pane,
    // which shows wherever the sheet is scrolled. A range named more than once gets one box, in the
    // color of its first mention, as in Excel; each keeps its color as others scroll in and out.
    const vr = visibleRange(view);
    const drawn = new Set();
    refs.forEach(({ ref }, i) => {
      if (ref.sheet ? ref.sheet.toLowerCase() !== s.name.toLowerCase() : away) return;
      if (!(ref.r1 < frozen.rows || frozen.top && frozen.split && ref.r2 >= paneRows[0] && ref.r1 <= paneRows[1] || (ref.r2 >= vr.r0 && ref.r1 <= vr.r1))) return;
      if (!(ref.c1 < frozen.cols || frozen.left && frozen.split && ref.c2 >= paneCols[0] && ref.c1 <= paneCols[1] || (ref.c2 >= vr.c0 && ref.c1 <= vr.c1))) return;
      const at = `${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
      if (drawn.has(at)) return;
      drawn.add(at);
      const box = rangeBox({ r1: ref.r1, c1: ref.c1, r2: Math.min(ref.r2, s.rows - 1), c2: Math.min(ref.c2, s.cols - 1) });
      const node = el('div.ref-hl', { dataset: { color: (i % REF_COLORS) + 1 } });
      place(node, box);
      refLayer.append(node);
    });
  }

  /* ---------- Pointer interaction ---------- */

  let drag = null; // { kind: 'select'|'fill'|'colsel'|'rowsel'|'colresize'|'rowresize', ... }
  const coarsePointer = typeof matchMedia === 'function' && !!matchMedia('(pointer: coarse)')?.matches;
  let handlePresses = 0; // presses in a row that landed on the fill handle (a double-click on it needs two)
  let tap = null;  // touch: { r, c, x, y, t, timer }
  let longPressAt = 0; // when a long press last opened the cell menu
  let autoScroll = 0;

  function stopAutoScroll() {
    if (autoScroll) { clearInterval(autoScroll); autoScroll = 0; }
  }

  let captured = null; // { el, id }: the pointer a drag holds, let go when the drag is cancelled
  function grab(el, e) {
    try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    captured = { el, id: e.pointerId };
    // Which side of each frozen edge the press itself was on: a drag begun in the scrolling pane
    // must not reach into a frozen band, where the cells drawn are not the ones it is sweeping.
    if (drag) {
      const vp = viewport.getBoundingClientRect();
      drag.fromFree = { x: e.clientX - vp.left >= frozen.w, y: e.clientY - vp.top >= frozen.h };
    }
  }

  /**
   * The cell a drag has reached. A frozen pane is drawn over the scrolling cells, so inside it the
   * pointer is on a frozen cell far from the one the drag left behind: following it would sweep —
   * and fill over, or move onto — a stretch of the sheet nobody could see. A drag that began in the
   * scrolling pane therefore stops at the pane's inner edge, and `edgeAutoScroll` scrolls that pane
   * back instead. Once the pane is home (scroll 0) the band's cells are the ones that belong there,
   * so the drag may enter it.
   */
  function dragCellAt(clientX, clientY) {
    ensureOffsets();
    const vp = viewport.getBoundingClientRect();
    const stopX = drag?.fromFree?.x && frozen.w > 0 && Math.abs(viewport.scrollLeft - shift.x - frozen.sl) >= 1;
    const stopY = drag?.fromFree?.y && frozen.h > 0 && Math.abs(viewport.scrollTop - shift.y - frozen.st) >= 1;
    // A drag begun in a split window's left or top pane stays in it: past the bar are other cells.
    const keepX = frozen.split && drag?.fromFree && !drag.fromFree.x && frozen.w > 0;
    const keepY = frozen.split && drag?.fromFree && !drag.fromFree.y && frozen.h > 0;
    const x = stopX ? Math.max(clientX, vp.left + frozen.w) : keepX ? Math.min(clientX, vp.left + frozen.w - 1) : clientX;
    const y = stopY ? Math.max(clientY, vp.top + frozen.h) : keepY ? Math.min(clientY, vp.top + frozen.h - 1) : clientY;
    return cellAtPoint(x, y);
  }

  /**
   * A drag given up before its release (Escape, a touch the browser decided to scroll with, a
   * lost capture) ends without acting: nothing fills, moves, resizes or reorders, and no
   * preview or guide stays.
   */
  function cancelDrag() {
    if (tap) { clearTimeout(tap.timer); tap = null; }
    drag = null;
    if (captured) {
      const { el, id } = captured;
      captured = null;
      try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id); } catch { /* already let go */ }
    }
    if (freezeDrag) { freezeDrag = null; freezeV.classList.remove('dragging'); freezeH.classList.remove('dragging'); }
    fillPreview = null;
    movePreview = null;
    tablePreviewEl.hidden = true;
    resizeGuide.hidden = true;
    resizeFeedback.hidden = true;
    root.classList.remove('reordering', 'resizing-col', 'resizing-row');
    stopAutoScroll();
    schedule();
  }

  // A press on the viewport's own scrollbars lands outside its client box (clientLeft takes in a
  // scrollbar drawn on the left, as a right-to-left page draws it); it scrolls, and selects nothing.
  function onScrollbar(e) {
    if (e.target !== viewport) return false;
    const rect = viewport.getBoundingClientRect();
    const x = e.clientX - rect.left - viewport.clientLeft;
    const y = e.clientY - rect.top - viewport.clientTop;
    return x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight;
  }

  function cellsPointerDown(e) {
    if (sheet()?.kind === 'chart') return;
    if (onScrollbar(e)) return;
    // Only the primary button selects: the secondary one opens the menu through its own event, and the
    // middle one is the browser's (autoscroll, or a paste), as Excel leaves it.
    if (e.button !== 0) return;
    if (e.target === editor || editor.contains(e.target)) return;
    ensureOffsets(); // the frozen pane's extent, read below, comes from the layout
    notePane(e.clientX, e.clientY);
    // Page Break Preview: a page break or an edge of the print area, dragged to a new line.
    const pageGrip = pageView && !pageView.lines ? e.target.closest?.('.page-break-line, .page-area-edge') : null;
    if (pageGrip && e.button === 0) {
      e.preventDefault();
      if (edit && !commitEdit()) return;
      const at = Number(pageGrip.dataset.at);
      drag = { kind: 'pageBreak', axis: pageGrip.dataset.axis, from: at, to: at, manual: pageGrip.dataset.manual === '1', edge: pageGrip.dataset.edge || null, node: pageGrip };
      pageGrip.classList.add('dragging');
      grab(viewport, e);
      return;
    }
    const tableHandle = e.target.closest?.('.table-handle');
    if (tableHandle && !underFrozenPane(tableHandle, e.clientX, e.clientY)) {
      e.preventDefault();
      if (edit && !commitEdit()) return;
      const t = wb.tableById(sheetId, tableHandle.dataset.id);
      if (!t) return;
      drag = { kind: 'tableResize', id: t.id, target: null };
      grab(viewport, e);
      return;
    }
    const object = e.target.closest?.('.chart-box');
    if (object && !underFrozenPane(object, e.clientX, e.clientY)) return; // charts handle their own pointer
    if (selectedChart) { selectedChart = null; schedule(); }
    const { r, c } = cellAtPoint(e.clientX, e.clientY);
    // Filter funnels and dropdown chevrons live on the right edge of a cell,
    // where the active cell's fill handle also sits; the affordance wins in
    // the cell's middle band, the handle only near its corner.
    const affordance = e.pointerType !== 'touch' && !e.shiftKey && !edit ? affordanceAt(r, c, e.clientX, e.clientY) : null;
    if (affordance) {
      e.preventDefault();
      setSelection(S.single(r, c));
      if (affordance === 'filter') opts.onFilterOpen?.({ r, c });
      else opts.onListOpen?.({ r, c, rule: wb.validationAt(sheetId, r, c) });
      return;
    }
    if (onFillHandle(e.clientX, e.clientY, e.target)) {
      // On touch the handle is how a range is dragged out (scrolling owns the
      // plain drag); filling from it would write over the cells swept.
      if (e.pointerType === 'touch') {
        e.preventDefault();
        if (edit && !commitEdit()) return;
        drag = { kind: 'select' };
        grab(viewport, e);
        return;
      }
      handlePresses++; startFill(e); return;
    }
    handlePresses = 0;
    // Dragging the selection by its border moves it (Alt/Ctrl copies).
    if (e.pointerType !== 'touch' && !e.shiftKey && onSelectionBorder(e.clientX, e.clientY)) {
      e.preventDefault();
      if (edit && !commitEdit()) return;
      const source = S.selRange(sel);
      drag = { kind: 'move', source, grab: { dr: r - source.r1, dc: c - source.c1 }, copy: e.altKey || e.ctrlKey };
      movePreview = source;
      grab(viewport, e);
      viewport.focus({ preventScroll: true });
      schedule();
      return;
    }
    // Ctrl/Cmd+click follows a link, as in every spreadsheet.
    if (isMod(e) && !edit && e.pointerType !== 'touch') {
      const link = wb.linkAt(sheetId, r, c);
      if (link) {
        e.preventDefault();
        setSelection(S.single(r, c));
        if (link.url.startsWith('#')) opts.onCommand?.('openLink'); else window.open(link.url, '_blank', 'noopener');
        return;
      }
    }

    // Ctrl/Cmd+click adds another cell or range to the selection.
    if (isMod(e) && !edit && !e.shiftKey && e.pointerType !== 'touch') {
      e.preventDefault();
      addRange(S.selRange(sel, true));
      setSelection(S.single(r, c), { add: true });
      drag = { kind: 'select' };
      grab(viewport, e);
      viewport.focus({ preventScroll: true });
      return;
    }

    if (e.pointerType === 'touch') {
      // Touch scrolls; a tap selects, a second tap edits, a long press opens
      // the context menu. Dragging to select is done from the fill handle.
      tap = { r, c, x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      tap.timer = setTimeout(() => {
        if (tap && !tap.moved) {
          tap = null;
          if (edit && !commitEdit()) return;
          // Inside the selection the menu is for the whole of it, as for a right-click: there is no other way to reach it with a finger.
          if (!selectedAt(r, c)) setSelection(S.single(r, c));
          if (navigator.vibrate) navigator.vibrate(10);
          longPressAt = Date.now();
          opts.onContextMenu?.({ x: e.clientX, y: e.clientY, kind: 'cell' });
        }
      }, LONG_PRESS_MS);
      return;
    }

    e.preventDefault();
    if (edit && acceptsRef()) {
      // Shift+click stretches the reference just picked into a range.
      const anchor = e.shiftKey && edit.point ? edit.point.anchor : { r, c };
      // The formula may be typed in the formula bar: the release gives the focus back to that box.
      drag = { kind: 'ref', start: anchor, input: editInput() };
      insertRef(normalizeRange({ r1: anchor.r, c1: anchor.c, r2: r, c2: c }));
      grab(viewport, e);
      return;
    }
    if (edit && !commitEdit()) return;
    if (keyMode === 'add') { addRange(S.selRange(sel, true)); setSelection(S.single(r, c), { add: true }); drag = { kind: 'select' }; grab(viewport, e); viewport.focus({ preventScroll: true }); return; }
    if (e.shiftKey || keyMode === 'extend') setSelection(S.extendTo(sel, r, c));
    else setSelection(S.single(r, c));
    // A checkbox cell toggles on click.
    if (!e.shiftKey && wb.validationAt(sheetId, r, c)?.type === 'checkbox') { toggleCheckbox(r, c); viewport.focus({ preventScroll: true }); return; }
    drag = { kind: 'select' };
    grab(viewport, e);
    viewport.focus({ preventScroll: true });
  }

  /** 'filter' | 'list' when the pointer is on a cell's right-edge button, else null. */
  function affordanceAt(r, c, clientX, clientY) {
    const s = sheet();
    const isFilterHead = filterHeadAt(s, r, c);
    const rule = !isFilterHead && s.validations.length ? wb.validationAt(sheetId, r, c) : null;
    const isList = rule?.type === 'list' && rule.chips;
    if (!isFilterHead && !isList) return null;
    const rect = cellRect(r, c);
    if (clientX < rect.right - 22 || clientX > rect.right) return null;
    if (clientY < rect.top + 2 || clientY > rect.bottom - 8) return null;
    return isFilterHead ? 'filter' : 'list';
  }

  /** Screen-space rectangle of a cell, honouring frozen panes. */
  function cellRect(r, c) {
    const box = rangeBox({ r1: r, c1: c, r2: r, c2: c });
    const vp = viewport.getBoundingClientRect();
    const left = vp.left + box.left - bandSL(c);
    const top = vp.top + box.top - bandST(r);
    return { left, top, right: left + box.width, bottom: top + box.height, width: box.width, height: box.height };
  }

  function toggleCheckbox(r, c) {
    const cell = wb.getCell(sheetId, r, c);
    if (cell?.f != null) return; // a formula decides the value
    wb.setInput(sheetId, r, c, cell?.v === true ? 'FALSE' : 'TRUE');
  }

  function startFill(e) {
    e.preventDefault();
    e.stopPropagation();
    if (edit && !commitEdit()) return;
    drag = { kind: 'fill', source: S.selRange(sel) };
    fillPreview = drag.source;
    grab(viewport, e);
    viewport.focus({ preventScroll: true });
    schedule();
  }

  function fillTarget(source, r, c) {
    const dr = r < source.r1 ? r - source.r1 : r > source.r2 ? r - source.r2 : 0;
    const dc = c < source.c1 ? c - source.c1 : c > source.c2 ? c - source.c2 : 0;
    if (dr === 0 && dc === 0) {
      // Inside the selection the handle pulls its far edge back: on release the rows or columns
      // left outside are cleared, as in Excel.
      const up = source.r2 - r;
      const left = source.c2 - c;
      if (!up && !left) return source;
      return up >= left ? { ...source, r2: r } : { ...source, c2: c };
    }
    if (Math.abs(dr) >= Math.abs(dc)) {
      return dr > 0 ? { ...source, r2: r } : { ...source, r1: r };
    }
    return dc > 0 ? { ...source, c2: c } : { ...source, c1: c };
  }

  function pointerMove(e) {
    if (tap) {
      if (Math.abs(e.clientX - tap.x) > TAP_SLOP || Math.abs(e.clientY - tap.y) > TAP_SLOP) { tap.moved = true; clearTimeout(tap.timer); }
      return;
    }
    if (!drag) {
      // Show the move cursor while hovering the selection's border.
      if (e.pointerType !== 'touch') viewport.classList.toggle('can-move', onSelectionBorder(e.clientX, e.clientY));
      return;
    }
    if (drag.kind === 'colresize' || drag.kind === 'rowresize') { resizeMove(e); return; }
    if (drag.kind === 'colmove' || drag.kind === 'rowmove') { reorderMove(e); return; }
    const { r, c } = dragCellAt(e.clientX, e.clientY);
    dragTo(r, c, e);
    edgeAutoScroll(e);
  }

  /** Bring the drag in progress to the cell under the pointer: the selection, a preview, or a reference. */
  function dragTo(r, c, e) {
    if (drag.kind === 'move') {
      const s = sheet();
      const src = drag.source;
      const h = src.r2 - src.r1 + 1;
      const w = src.c2 - src.c1 + 1;
      const r1 = clamp(r - drag.grab.dr, 0, Math.max(0, s.rows - h));
      const c1 = clamp(c - drag.grab.dc, 0, Math.max(0, s.cols - w));
      const next = { r1, c1, r2: r1 + h - 1, c2: c1 + w - 1 };
      drag.copy = e.altKey || e.ctrlKey;
      if (rangeName(next) !== rangeName(movePreview || src)) { movePreview = next; schedule(); }
      return;
    }
    if (drag.kind === 'pageBreak') {
      const to = boundaryAt(drag.axis, e.clientX, e.clientY);
      if (to !== drag.to) { drag.to = to; place(drag.node, breakBox(drag.axis, to, pageView?.area || { r1: 0, c1: 0, r2: 0, c2: 0 })); }
      return;
    }
    if (drag.kind === 'tableResize') {
      const t = wb.tableById(sheetId, drag.id);
      if (!t) return;
      const next = { r1: t.range.r1, c1: t.range.c1, r2: Math.max(t.range.r1 + 1, r), c2: Math.max(t.range.c1, c) };
      drag.target = next;
      tablePreviewEl.hidden = false;
      place(tablePreviewEl, rangeBox(next));
      return;
    }
    if (drag.kind === 'select') {
      if (r !== sel.focus.r || c !== sel.focus.c) setSelection(S.extendTo(sel, r, c), { scroll: false, announce: false, add: extras.length > 0 });
    } else if (drag.kind === 'fill') {
      const next = fillTarget(drag.source, r, c);
      if (rangeName(next) !== rangeName(fillPreview || drag.source)) { fillPreview = next; schedule(); }
    } else if (drag.kind === 'ref') {
      if (drag.lines === 'col') insertLineRef('col', drag.start.c, c);
      else if (drag.lines === 'row') insertLineRef('row', drag.start.r, r);
      else insertRef({ r1: drag.start.r, c1: drag.start.c, r2: r, c2: c });
    } else if (drag.kind === 'colsel') {
      setSelection(S.selectCols(drag.start, c, bounds()), { scroll: false, announce: false, add: extras.length > 0 });
    } else if (drag.kind === 'rowsel') {
      setSelection(S.selectRows(drag.start, r, bounds()), { scroll: false, announce: false, add: extras.length > 0 });
    }
  }

  function edgeAutoScroll(e) {
    const rect = viewport.getBoundingClientRect();
    // For a drag begun in the scrolling pane the frozen band's inner edge is the edge that scrolls:
    // pulled back onto the band the drag cannot go further, so the pane comes back to meet it.
    const left = drag?.fromFree?.x ? rect.left + frozen.w : rect.left;
    const top = drag?.fromFree?.y ? rect.top + frozen.h : rect.top;
    // A drag along the column headers runs above the viewport, and one along the row
    // headers to its left: only the axis being selected scrolls.
    let dx = e.clientX < left ? -1 : e.clientX > rect.right ? 1 : 0;
    let dy = e.clientY < top ? -1 : e.clientY > rect.bottom ? 1 : 0;
    if (drag?.kind === 'colsel' || drag?.lines === 'col') dy = 0;
    if (drag?.kind === 'rowsel' || drag?.lines === 'row') dx = 0;
    stopAutoScroll();
    if (dx || dy) {
      autoScroll = setInterval(() => {
        viewport.scrollBy(dx * 24, dy * 24);
        if (!drag) return;
        // The selection, and a move, fill or table preview, follow the cell now under the pointer.
        const { r, c } = dragCellAt(clamp(e.clientX, left + 1, rect.right - 1), clamp(e.clientY, top + 1, rect.bottom - 1));
        dragTo(r, c, e);
      }, 50);
    }
  }

  function pointerUp(e) {
    stopAutoScroll();
    if (tap) {
      clearTimeout(tap.timer);
      const t = tap;
      tap = null;
      if (!t.moved && Date.now() - t.t < LONG_PRESS_MS) {
        // A tap anywhere on a merged block is a tap on its anchor, the cell the selection holds; most of a merged title is not its anchor.
        const m = sheet().merges.length ? mergeAt(t.r, t.c) : null;
        const hit = m ? { r: m.r1, c: m.c1 } : t;
        const wasActive = sel.active.r === hit.r && sel.active.c === hit.c && S.isSingle(sel) && !edit;
        if (edit && acceptsRef()) { insertRef({ r1: t.r, c1: t.c, r2: t.r, c2: t.c }); return; }
        if (edit && !commitEdit()) return;
        // A tap on a cell's filter button or dropdown chevron opens it, as a click does.
        const affordance = affordanceAt(t.r, t.c, t.x, t.y);
        if (affordance) {
          setSelection(S.single(t.r, t.c));
          if (affordance === 'filter') opts.onFilterOpen?.({ r: t.r, c: t.c });
          else opts.onListOpen?.({ r: t.r, c: t.c, rule: wb.validationAt(sheetId, t.r, t.c) });
          return;
        }
        // A tap on a checkbox cell ticks it, as a click does; a second tap must not open its TRUE/FALSE for editing.
        if (wb.validationAt(sheetId, t.r, t.c)?.type === 'checkbox') { setSelection(S.single(t.r, t.c)); toggleCheckbox(t.r, t.c); return; }
        if (wasActive) beginEdit({ mode: 'inplace' });
        else setSelection(S.single(t.r, t.c));
      }
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    captured = null;
    if (viewport.hasPointerCapture?.(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    if (d.kind === 'move') {
      const target = movePreview;
      movePreview = null;
      if (target && rangeName(target) !== rangeName(d.source)) {
        // The workbook reports a protected cell in the way itself and writes nothing, for a copy as
        // for a move; any other refusal of a move is explained here.
        let locked = false;
        const onProtected = (ev) => { if (ev.detail?.type === 'protected') locked = true; };
        wb.addEventListener('change', onProtected);
        let done;
        if (d.copy) {
          const rows = Array.from({ length: d.source.r2 - d.source.r1 + 1 }, (_, i) => d.source.r1 + i);
          const cols = Array.from({ length: d.source.c2 - d.source.c1 + 1 }, (_, i) => d.source.c1 + i);
          wb.pasteCells(sheetId, wb.copyRange(sheetId, d.source), target.r1, target.c1, { r: d.source.r1, c: d.source.c1 }, null,
            { nativeSparklines: wb.copyNativeSparklines(sheetId, rows, cols) });
          done = !locked;
        }
        else done = wb.moveRange(sheetId, d.source, target.r1, target.c1);
        wb.removeEventListener('change', onProtected);
        if (!done) {
          if (!locked) { const message = moveProblem(d.source, target); opts.onInvalid?.({ message }); opts.announce?.(message); }
          schedule();
          return;
        }
        setSelection(S.fromRange(target, { r: target.r1 + (sel.active.r - d.source.r1), c: target.c1 + (sel.active.c - d.source.c1) }));
        opts.announce?.(`${d.copy ? 'Copied' : 'Moved'} to ${rangeName(target)}`);
      } else schedule();
      return;
    }
    if (d.kind === 'pageBreak') {
      d.node.classList.remove('dragging');
      if (d.to === d.from) { renderPages(); return; }
      // An edge's line is the last one inside the area at its bottom and right.
      if (d.edge) opts.onPrintAreaEdge?.({ edge: d.edge, to: d.edge === 'bottom' || d.edge === 'right' ? d.to - 1 : d.to });
      else opts.onPageBreakMove?.({ axis: d.axis, from: d.from, to: d.to, manual: d.manual });
      renderPages();
      return;
    }
    if (d.kind === 'tableResize') {
      tablePreviewEl.hidden = true;
      const t = wb.tableById(sheetId, d.id);
      if (d.target && t && rangeName(d.target) !== rangeName(t.range)) {
        const resized = wb.resizeTable(sheetId, d.id, d.target, {
          onInvalid: (message) => {
            opts.onInvalid?.({ message });
            opts.announce?.(message);
          },
        });
        if (resized) opts.announce?.(`Table ${t.name} now covers ${rangeName(d.target)}`);
        else schedule();
      } else schedule();
      return;
    }
    if (d.kind === 'fill') {
      const target = fillPreview;
      fillPreview = null;
      if (target && (target.r2 < d.source.r2 || target.c2 < d.source.c2)) {
        // Pulled back into the selection: the cells outside the smaller range are cleared and the selection shrinks to it.
        const src = d.source;
        wb.clearRange(sheetId, target.r2 < src.r2 ? { r1: target.r2 + 1, c1: src.c1, r2: src.r2, c2: src.c2 } : { r1: src.r1, c1: target.c2 + 1, r2: src.r2, c2: src.c2 });
        const a = sel.active;
        setSelection(S.fromRange(target, a.r <= target.r2 && a.c <= target.c2 ? a : { r: target.r1, c: target.c1 }));
      } else if (target && rangeName(target) !== rangeName(d.source)) {
        // Ctrl/Cmd while releasing flips the fill: a lone number counts up, a series just repeats.
        wb.transaction('Fill', () => {
          wb.fill(sheetId, d.source, target, { invert: e.ctrlKey || e.metaKey });
          // Filling down past a table's last row pulls those rows into the table. The whole block
          // filled is offered, not the part below the cells dragged from: a drag that starts above
          // the table's last row still reaches past it, and the workbook decides which table, if
          // any, the block belongs under.
          if (target.r2 > d.source.r2 && wb.extendTableToCover) wb.extendTableToCover(sheetId, target);
        });
        setSelection(S.fromRange(target, sel.active));
        opts.onFilled?.({ source: d.source, target, inverted: e.ctrlKey || e.metaKey });
      } else schedule();
    } else if (d.kind === 'colresize' || d.kind === 'rowresize') {
      resizeEnd(d);
    } else if (d.kind === 'colmove' || d.kind === 'rowmove') {
      reorderEnd(d);
    } else if (d.kind === 'select' || d.kind === 'colsel' || d.kind === 'rowsel') {
      speak();
    } else if (d.kind === 'ref') {
      (d.input || editor).focus({ preventScroll: true });
    }
  }

  function onDoubleClick(e) {
    if (sheet()?.kind === 'chart') return;
    if (onScrollbar(e)) return;
    if (e.target === editor) return;
    // Double-clicking the fill handle fills down alongside the neighbours —
    // but only when both clicks landed on it. Double-clicking a cell near its
    // bottom-right corner selects it with the first click, which moves the
    // handle under the pointer; that double-click must still edit the cell.
    if (onFillHandle(e.clientX, e.clientY, e.target) && handlePresses >= 2) {
      const source = S.selRange(sel);
      const target = wb.autoFillTarget(sheetId, source);
      if (target) { wb.fill(sheetId, source, target); setSelection(S.fromRange(target, sel.active)); opts.onFilled?.({ source, target, inverted: false }); }
      return;
    }
    // Double-clicking an edge of the selection moves the active cell to the edge of the data that way, as Ctrl+arrow does.
    const side = e.pointerType !== 'touch' && !edit ? onSelectionBorder(e.clientX, e.clientY) : false;
    if (side) {
      const [dr, dc] = { top: [-1, 0], bottom: [1, 0], left: [0, -1], right: [0, 1] }[side];
      const target = jumpFrom(S.single(sel.active.r, sel.active.c), dr, dc).active;
      setSelection(S.single(target.r, target.c), { grow: false });
      return;
    }
    if (e.pointerType === 'touch') return;
    // While a formula expects a reference, the presses already picked one; the second click must not commit and edit another cell.
    if (edit && acceptsRef()) return;
    const at = cellAtPoint(e.clientX, e.clientY);
    if (edit && !commitEdit()) return;
    setSelection(S.single(at.r, at.c));
    // A double-click anywhere on a merged block is one on its anchor, the cell that holds the value
    // and the style, as a tap on it is: most of a merged date field is not its anchor, and asking
    // the covered cell (which has neither) opened the text editor where the calendar belongs.
    const m = sheet().merges.length ? mergeAt(at.r, at.c) : null;
    const { r, c } = m ? { r: m.r1, c: m.c1 } : at;
    // Two clicks on a checkbox have already ticked it twice, which is the no-op Excel and Sheets
    // give; opening its TRUE/FALSE for editing over the drawn box would be a third step.
    if (wb.validationAt(sheetId, r, c)?.type === 'checkbox') return;
    // A date cell opens the calendar instead (F2 or typing still edits it).
    if (isDateCell(r, c) && wb.getCell(sheetId, r, c)?.f == null && opts.onDateOpen) { opts.onDateOpen({ r, c }); return; }
    if (beginEdit({ mode: 'inplace' })) placeCaretAt(e.clientX);
  }

  /**
   * After a double-click the caret lands on the character under the pointer,
   * as in Excel, so a word in the middle can be fixed without arrowing over.
   * Wrapped or multi-line text keeps the caret at the end.
   */
  function placeCaretAt(clientX) {
    if (!edit || document.activeElement !== editor) return;
    const text = editor.value;
    if (!text || text.length > 400 || text.includes('\n') || editor.classList.contains('wrap')) return;
    const rect = editor.getBoundingClientRect();
    const total = textWidth(text, edit.font);
    const leftInset = 2 + (parseFloat(editor.style.paddingLeft) || CELL_TEXT_INSET * zoom);
    const rightInset = 2 + (parseFloat(editor.style.paddingRight) || CELL_TEXT_INSET * zoom);
    const inner = rect.width - leftInset - rightInset;
    const align = editor.style.textAlign;
    const start = rect.left + leftInset + (align === 'right' ? Math.max(0, inner - total) : align === 'center' ? Math.max(0, (inner - total) / 2) : 0);
    const x = clientX - start;
    let end = 0;
    let before = 0;
    for (const unit of graphemes(text)) {
      const after = textWidth(text.slice(0, end + unit.length), edit.font);
      if (x < (before + after) / 2) break;
      before = after;
      end += unit.length;
    }
    editor.setSelectionRange(end, end);
    updateHints();
  }

  /** Formatted as a date, or validated to hold one. */
  function isDateCell(r, c) {
    const style = wb.styleAt(sheetId, r, c);
    const fmt = dateTimeKind(style, style?.fmt === 'custom' ? wb.getValue(sheetId, r, c) : 0);
    if (fmt === 'date' || fmt === 'datetime') return true;
    return wb.validationAt(sheetId, r, c)?.type === 'date';
  }

  function onContextMenu(e) {
    if (sheet()?.kind === 'chart') { e.preventDefault(); return; }
    // Inside the editor the browser's own menu (cut, copy, paste, spelling) applies.
    if (e.target === editor) return;
    e.preventDefault();
    // A long press on a touch screen arrives twice: from the press timer above and as the browser's
    // own contextmenu for the same press. Whichever comes first opens the menu; the other is dropped.
    if (tap) { clearTimeout(tap.timer); tap = null; longPressAt = Date.now(); }
    else if (Date.now() - longPressAt < LONG_PRESS_MS * 2) return;
    // Right-clicking a cell mid-edit commits the entry and opens that cell's menu, as Excel and Sheets do.
    if (edit && !commitEdit()) return;
    const { r, c } = cellAtPoint(e.clientX, e.clientY);
    // Inside any selected range (one added with Ctrl/Cmd+click too) the menu is for the whole selection.
    if (!selectedAt(r, c)) setSelection(S.single(r, c));
    opts.onContextMenu?.({ x: e.clientX, y: e.clientY, kind: 'cell' });
  }

  /** Is (r, c) inside the selection: the current range or one added with Ctrl/Cmd+click? */
  function selectedAt(r, c) {
    return [...extras, S.selRange(sel)].some((rg) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2);
  }

  /* ---------- Headers: select and resize ---------- */

  function headerPointerDown(e, axis) {
    if (e.button !== 0) return; // as for the cells: the primary button alone selects
    ensureOffsets();
    const outline = e.target.closest?.('.outline-btn');
    if (outline) { e.preventDefault(); return; } // Its click also supports assistive activation.
    const resizer = e.target.closest(axis === 'col' ? '.col-resizer' : '.row-resizer');
    const hcell = e.target.closest('.hcell');
    if (!hcell) return;
    e.preventDefault();
    // A split window's left (top) pane has its own headings: pressing one makes that pane the active one.
    if (frozen.split) splitPane[axis === 'col' ? 'left' : 'top'] = !!hcell.closest(axis === 'col' ? '.grid-colhead-frozen' : '.grid-rowhead-frozen');
    const idx = Number(axis === 'col' ? hcell.dataset.c : hcell.dataset.r);
    if (edit && !resizer && acceptsRef()) {
      // While a formula wants a reference, a header gives it the whole column or row (B:B, 2:2),
      // stretched over the headers dragged across; Shift stretches the reference just picked.
      const start = e.shiftKey && edit.point ? (axis === 'col' ? edit.point.anchor.c : edit.point.anchor.r) : idx;
      drag = { kind: 'ref', lines: axis, start: axis === 'col' ? { r: 0, c: start } : { r: start, c: 0 }, input: editInput() };
      insertLineRef(axis, start, idx);
      grab(axis === 'col' ? colClip : rowClip, e);
      return;
    }
    if (edit && !commitEdit()) return;
    if (resizer) {
      drag = { kind: axis === 'col' ? 'colresize' : 'rowresize', index: idx, startPos: axis === 'col' ? e.clientX : e.clientY, startSize: axis === 'col' ? colW(idx) : rowH(idx), size: null };
      drag.count = selectedLines(axis, idx)?.reduce((count, [from, to]) => count + to - from + 1, 0) || 1;
      root.classList.add(`resizing-${axis}`);
      resizeGuide.hidden = false;
      resizeGuide.className = `resize-guide ${axis}`;
      resizeMove(e);
      grab(axis === 'col' ? colClip : rowClip, e);
      viewport.focus({ preventScroll: true }); // so Escape, handled by the viewport, can give the drag up
      return;
    }
    const b = bounds();
    // Pressing on a header inside a whole-row or whole-column selection
    // starts a reorder drag; a plain click on it still selects that line.
    // With Ctrl/Cmd held it is an addition to the selection, as below.
    const range = S.selRange(sel);
    const s = sheet();
    const wholeCols = range.r1 === 0 && range.r2 >= s.rows - 1;
    const wholeRows = range.c1 === 0 && range.c2 >= s.cols - 1;
    const insideSel = axis === 'col' ? wholeCols && idx >= range.c1 && idx <= range.c2 : wholeRows && idx >= range.r1 && idx <= range.r2;
    if (insideSel && !e.shiftKey && !isMod(e) && e.pointerType !== 'touch') {
      drag = { kind: axis === 'col' ? 'colmove' : 'rowmove', idx, from: axis === 'col' ? range.c1 : range.r1, count: axis === 'col' ? range.c2 - range.c1 + 1 : range.r2 - range.r1 + 1, startPos: axis === 'col' ? e.clientX : e.clientY, to: null };
      grab(axis === 'col' ? colClip : rowClip, e);
      viewport.focus({ preventScroll: true });
      return;
    }
    // Ctrl/Cmd+click on a header adds that row or column to the selection.
    const add = isMod(e) && !e.shiftKey && e.pointerType !== 'touch';
    if (add) addRange(S.selRange(sel, true));
    if (axis === 'col') setSelection(e.shiftKey ? S.selectCols(sel.anchor.c, idx, b) : S.selectCols(idx, idx, b), { scroll: false, add });
    else setSelection(e.shiftKey ? S.selectRows(sel.anchor.r, idx, b) : S.selectRows(idx, idx, b), { scroll: false, add });
    drag = { kind: axis === 'col' ? 'colsel' : 'rowsel', start: e.shiftKey ? (axis === 'col' ? sel.anchor.c : sel.anchor.r) : idx };
    grab(axis === 'col' ? colClip : rowClip, e);
    viewport.focus({ preventScroll: true });
  }

  /** While dragging headers: where the block would land, shown as a line. */
  function reorderMove(e) {
    const axis = drag.kind === 'colmove' ? 'col' : 'row';
    const pos = axis === 'col' ? e.clientX : e.clientY;
    if (drag.to === null && Math.abs(pos - drag.startPos) < 4) return;
    const { r, c } = cellAtPoint(e.clientX, e.clientY);
    const s = sheet();
    const vp = viewport.getBoundingClientRect();
    let to;
    // Inside a frozen pane the content has not scrolled, as in cellAtPoint.
    if (axis === 'col') {
      const vx = e.clientX - vp.left;
      const x = contentX(vx);
      to = x - colX(c) > colW(c) / 2 ? c + 1 : c;
      to = clamp(to, 0, s.cols);
    } else {
      const vy = e.clientY - vp.top;
      const y = contentY(vy);
      to = y - rowY(r) > rowH(r) / 2 ? r + 1 : r;
      to = clamp(to, 0, s.rows);
    }
    drag.to = to;
    const allowed = !(to >= drag.from && to <= drag.from + drag.count);
    resizeGuide.hidden = false;
    resizeGuide.className = `resize-guide ${axis} ${allowed ? 'move-ok' : 'move-no'}`;
    // A line scrolled under the frozen pane is shown at the pane's edge, where the drop would land.
    if (axis === 'col') resizeGuide.style.transform = `translateX(${to > frozen.cols ? Math.max(lineX(to), rowHeaderW + frozen.w) : lineX(to)}px)`;
    else resizeGuide.style.transform = `translateY(${to > frozen.rows ? Math.max(lineY(to), colHeaderH + frozen.h) : lineY(to)}px)`;
    root.classList.add('reordering');
  }

  function reorderEnd(d) {
    resizeGuide.hidden = true;
    root.classList.remove('reordering');
    const axis = d.kind === 'colmove' ? 'col' : 'row';
    const b = bounds();
    if (d.to === null) {
      // No drag: behave like a click on that header.
      setSelection(axis === 'col' ? S.selectCols(d.idx, d.idx, b) : S.selectRows(d.idx, d.idx, b), { scroll: false });
      return;
    }
    // What was selected before the move, kept for the undo of the step it is about to push: undoing put the
    // lines back but left the selection on where the move had landed. Read here, while it is still the
    // user's; handed over below once the move has gone through, so a refused move records nothing.
    const was = { sel, extras: [...extras] };
    const landing = axis === 'col' ? wb.moveCols(sheetId, d.from, d.count, d.to) : wb.moveRows(sheetId, d.from, d.count, d.to);
    if (landing === null) {
      if (!wb.isProtected(sheetId) && !(d.to >= d.from && d.to <= d.from + d.count)) {
        const message = 'That move would split a table or displace its header or totals row';
        opts.onInvalid?.({ message });
        opts.announce?.(message);
      }
      schedule();
      return;
    }
    const nb = bounds();
    setSelection(axis === 'col' ? S.selectCols(landing, landing + d.count - 1, nb) : S.selectRows(landing, landing + d.count - 1, nb), { scroll: false });
    // After the step is pushed and the moved lines are selected, so the note carries both where the
    // selection was and where the move left it, for undo and redo in turn.
    opts.rememberSelection?.(was);
    opts.announce?.(`Moved ${d.count} ${axis === 'col' ? 'column' : 'row'}${d.count === 1 ? '' : 's'}`);
  }

  function resizeMove(e) {
    if (!drag) return;
    const rootRect = root.getBoundingClientRect();
    const column = drag.kind === 'colresize';
    const delta = (column ? e.clientX : e.clientY) - drag.startPos;
    // Clamp in workbook pixels, then project to the screen. The guide and readout must agree
    // with the saved size at every zoom, including at the minimum and maximum dimensions.
    // A press without movement must leave imported sizes outside the interactive limits alone.
    const size = delta === 0 ? drag.startSize / zoom : clamp(Math.round((drag.startSize + delta) / zoom), column ? MIN_COL_WIDTH : MIN_ROW_HEIGHT, column ? MAX_COL_WIDTH : MAX_ROW_HEIGHT);
    drag.size = delta === 0 ? drag.startSize : size * zoom;
    let feedbackX, feedbackY;
    // A frozen line's edge has not scrolled.
    if (column) {
      const x = colX(drag.index) + drag.size - (frozen.split ? bandSL(drag.index) : drag.index < frozen.cols ? 0 : viewport.scrollLeft) + rowHeaderW;
      resizeGuide.style.transform = `translateX(${clamp(x, rowHeaderW, rootRect.width)}px)`;
      feedbackX = x + 8; feedbackY = colHeaderH + 8;
    } else {
      const y = rowY(drag.index) + drag.size - (frozen.split ? bandST(drag.index) : drag.index < frozen.rows ? 0 : viewport.scrollTop) + colHeaderH;
      resizeGuide.style.transform = `translateY(${clamp(y, colHeaderH, rootRect.height)}px)`;
      feedbackX = rowHeaderW + 8; feedbackY = y + 8;
    }
    const label = drag.count > 1 ? `${drag.count} ${column ? 'columns' : 'rows'}` : column ? 'Width' : 'Height';
    resizeFeedback.textContent = `${label}: ${Math.round(size)} px`;
    resizeFeedback.hidden = false;
    resizeFeedback.style.left = `${clamp(feedbackX, 4, Math.max(4, rootRect.width - resizeFeedback.offsetWidth - 4))}px`;
    resizeFeedback.style.top = `${clamp(feedbackY, 4, Math.max(4, rootRect.height - resizeFeedback.offsetHeight - 4))}px`;
  }

  /**
   * The whole columns (or rows) selected together with line `idx`, when several are, as runs of
   * neighbouring lines, so an action on the edge of one applies to them all: those of the current
   * range and of any range added with Ctrl/Cmd+click. Null when the line is not one of several.
   */
  function selectedLines(axis, idx) {
    const s = sheet();
    const whole = (rg) => (axis === 'col' ? rg.r1 === 0 && rg.r2 >= s.rows - 1 : rg.c1 === 0 && rg.c2 >= s.cols - 1);
    const runs = [...extras, S.selRange(sel)].filter(whole).map((rg) => (axis === 'col' ? [rg.c1, rg.c2] : [rg.r1, rg.r2])).sort((a, b) => a[0] - b[0]);
    if (!runs.some(([from, to]) => idx >= from && idx <= to)) return null;
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && run[0] <= last[1] + 1) last[1] = Math.max(last[1], run[1]); else merged.push([...run]);
    }
    return merged.length === 1 && merged[0][0] === merged[0][1] ? null : merged;
  }

  function resizeEnd(d) {
    root.classList.remove('resizing-col', 'resizing-row');
    resizeGuide.hidden = true;
    resizeFeedback.hidden = true;
    if (d.size == null || d.size === d.startSize) return;
    const size = Math.round(d.size / zoom);
    if (d.kind === 'colresize') {
      // Resizing one of several selected columns resizes them all, as one undo step.
      const lines = selectedLines('col', d.index);
      // The rows of wrapped text fitted to the new width join the step. The workbook announces the
      // change only when the step ends, so the layout is marked stale here for anything read within it.
      if (lines) wb.transaction('Resize columns', () => { const cols = []; const before = new Map(); for (const [from, to] of lines) for (let c = from; c <= to; c++) { before.set(c, wb.colWidth(sheetId, c)); wb.setColWidth(sheetId, c, size); cols.push(c); } invalidateOffsets(); refitWrappedRows(cols, before); });
      else wb.transaction('Resize column', () => { const before = new Map([[d.index, wb.colWidth(sheetId, d.index)]]); wb.setColWidth(sheetId, d.index, size); invalidateOffsets(); refitWrappedRows([d.index], before); });
    } else {
      const lines = selectedLines('row', d.index);
      if (lines) wb.transaction('Resize rows', () => { for (const [from, to] of lines) for (let r = from; r <= to; r++) wb.setRowHeight(sheetId, r, size); });
      else wb.setRowHeight(sheetId, d.index, size);
    }
  }

  /**
   * Excel widens a column nobody has sized when a typed date or formatted number would
   * otherwise show ###. Text spills over its neighbours and General numbers shorten, so
   * neither asks for width. True when the column was widened.
   */
  function widenForEntry(r, c) {
    const s = sheet();
    if (s.colWidths.has(c) || s.hiddenCols.has(c) || mergeAt(r, c)) return false;
    const cell = wb.getCell(sheetId, r, c);
    const st = styleAt(s, r, c);
    if (!cell || (cell.v == null && cell.f == null) || st?.wrap || st?.shrink) return false;
    const fmt = st?.fmt;
    if (!fmt || fmt === 'general' || fmt === 'text') return false;
    const value = wb.getValue(sheetId, r, c);
    if (typeof value !== 'number') return false;
    const text = cellLayoutText(formatValue(value, st), st?.wrap);
    const size = st?.size || baseFontSize;
    const family = fontStack(st?.font) || cellFont.replace(/^[\d.]+px\s*/, '');
    const font = `${st?.italic ? 'italic ' : ''}${st?.bold ? '600 ' : ''}${size}px ${family}`;
    const indent = cellIndent(value, st);
    const parts = numberFormatParts(value, st);
    const width = parts ? measureFormatParts(parts, line => textWidth(line, font)) : maxLineWidth(text, (line) => textWidth(line, font));
    if (width + cellHorizontalPadding(indent) + 1 <= s.defaultColWidth) return false;
    wb.setColWidth(sheetId, c, Math.min(500, Math.ceil(width + (14 + indent))));
    return true;
  }

  function autofitColumn(c) {
    const s = sheet();
    let best = 40;
    const fit = (r, value, style, text) => {
      const cf = wb.conditionalStyle(sheetId, r, c, value);
      style = conditionalFontStyle(style, cf);
      const size = style?.size || baseFontSize;
      const family = fontStack(style?.font) || cellFont.replace(/^[\d.]+px\s*/, '');
      const bold = style?.bold;
      const font = `${style?.italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px ${family}`;
      // The filter button, dropdown chevron, chip or icon drawn in the cell asks for its room too.
      const rule = s.validations.length ? wb.validationAt(sheetId, r, c) : null;
      const parts = numberFormatParts(value, style, wb.getCell(sheetId, r, c)?.richText);
      let width = parts ? measureFormatParts(parts, richTextMeasure(font, textWidth)) : maxLineWidth(cellLayoutText(text, style?.wrap), (line) => textWidth(line, font));
      if (style?.rot) {
        // Rotated text needs the width of its turned bounding box, as fitting the row needs its height.
        const rad = (Math.abs(style.rot) * Math.PI) / 180;
        width = width * Math.cos(rad) + largestRichTextSize(parts, size) * 1.3 * Math.sin(rad);
      }
      const indent = cellIndent(value, style);
      return width + (14 + indent) + decorationWidth(filterHeadAt(s, r, c), rule, cf, font);
    };
    // The value an array formula spills into this column shows here too, so it asks for width.
    const fitSpill = (r) => {
      const sp = wb.spillAt(sheetId, r, c);
      if (!sp || sp.value == null) return;
      const style = wb._pivotDisplayStyle(sheetId, r, c, { ...lineStyleAt(s, r, c), ...(sp.style || {}), ...(s.cells.get(cellKey(r, c))?.s || {}) });
      best = Math.max(best, fit(r, sp.value, style, formatValue(sp.value, style)));
    };
    const fitCell = (r) => {
      // A title merged across several columns does not size the first of them, and a cell hidden
      // under a merge shows nothing to size for.
      const m = mergeAt(r, c);
      if (m && (m.c2 > m.c1 || m.r1 !== r)) return;
      const value = wb.getValue(sheetId, r, c);
      const st = styleAt(s, r, c);
      const text = cellLayoutText(formatValue(value, st), st?.wrap);
      // Text wrapped to its column does not ask for width either; line breaks typed into it still
      // describe the lines the author meant, so the longest of those counts.
      if (st?.wrap && !/[\r\n]/.test(text)) return;
      best = Math.max(best, fit(r, value, st, text));
    };
    // Rows out of sight do not ask for width, as in Excel's AutoFit. On a full sheet the column
    // is walked row by row; on a sparse one its cells are picked out of the sheet's.
    if (s.rows < s.cells.size) {
      for (let r = 0; r < s.rows && best < 500; r++) {
        if (rowHidden(s, r)) continue;
        const cell = s.cells.get(cellKey(r, c));
        if (cell && (cell.v != null || cell.f != null)) fitCell(r); else fitSpill(r);
      }
    } else {
      for (const [key, cell] of s.cells) {
        if (cell.v == null && cell.f == null) continue;
        const comma = key.indexOf(',');
        const r = Number(key.slice(0, comma));
        const cc = Number(key.slice(comma + 1));
        if (cell.f != null) {
          const spill = wb.spillRangeAt(sheetId, r, cc);
          if (spill && c >= spill.c1 && c <= spill.c2) {
            for (let rr = spill.r1; rr <= spill.r2 && best < 500; rr++) if (!rowHidden(s, rr) && !(rr === r && cc === c)) fitSpill(rr);
          }
        }
        if (cc !== c || rowHidden(s, r)) continue;
        fitCell(r);
        if (best >= 500) break;
      }
    }
    wb.setColWidth(sheetId, c, Math.min(500, Math.ceil(best)));
  }

  function headerDoubleClick(e) {
    // Header drags capture on the stable clip. Browsers consequently target
    // click/dblclick at that clip even when the pointer never moved. Resolve
    // the actual handle under the pointer after capture has ended.
    const target = e.target === e.currentTarget ? document.elementFromPoint?.(e.clientX, e.clientY) : e.target;
    if (!target || !e.currentTarget.contains(target)) return;
    const resizer = target.closest('.col-resizer');
    if (resizer) {
      // Double-clicking the edge of one of several selected columns fits them all, as in Excel and Sheets.
      const c = Number(resizer.dataset.c);
      const lines = selectedLines('col', c);
      // The rows of wrapped text fitted to the new width join the step (the layout marked stale first, as in resizeEnd).
      if (lines) wb.transaction('Fit columns', () => { const cols = []; const before = new Map(); for (const [from, to] of lines) for (let cc = from; cc <= to; cc++) if (!sheet().hiddenCols.has(cc)) { before.set(cc, wb.colWidth(sheetId, cc)); autofitColumn(cc); cols.push(cc); } invalidateOffsets(); refitWrappedRows(cols, before); });
      else wb.transaction('Fit column', () => { const before = new Map([[c, wb.colWidth(sheetId, c)]]); autofitColumn(c); invalidateOffsets(); refitWrappedRows([c], before); });
      return;
    }
    const rowResizer = target.closest('.row-resizer');
    if (rowResizer) {
      const r = Number(rowResizer.dataset.r);
      const lines = selectedLines('row', r) || [[r, r]];
      wb.transaction('Fit row height', () => { for (const [from, to] of lines) autoFitRows(from, to, { force: true }); });
    }
  }

  function headerContextMenu(e, kind) {
    e.preventDefault();
    // A header menu offers structural edits; the open entry lands first, where it was typed.
    if (edit && !commitEdit()) return;
    const hcell = e.target.closest('.hcell');
    if (!hcell) return;
    const idx = Number(kind === 'col' ? hcell.dataset.c : hcell.dataset.r);
    const inside = [...extras, S.selRange(sel)].some((rg) => (kind === 'col' ? idx >= rg.c1 && idx <= rg.c2 : idx >= rg.r1 && idx <= rg.r2));
    if (!inside) setSelection(kind === 'col' ? S.selectCols(idx, idx, bounds()) : S.selectRows(idx, idx, bounds()), { scroll: false });
    opts.onContextMenu?.({ x: e.clientX, y: e.clientY, kind });
  }

  /* ---------- Keyboard ---------- */

  function onKeyDown(e) {
    // The editor handles its own keys; its keydown also bubbles here after
    // a commit has already cleared `edit`, so check the target too.
    if (edit || e.target === editor) return;
    // Links and object controls inside the canvas keep native activation
    // and text editing; their keys must not mutate the selected cells.
    if (e.defaultPrevented || e.target.closest?.('button, a, input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape' && (drag || freezeDrag || tap)) {
      // Escape gives up a gesture in progress, so nothing fills, moves, reorders or freezes on
      // release: a freeze-bar drag keeps its own handle, not `drag`, and went through regardless.
      e.preventDefault();
      cancelDrag();
      return;
    }
    if (sheet()?.kind === 'chart') {
      const mod = isMod(e), key = e.key;
      if (key === 'Tab' && !mod && !e.altKey) return; // native focus navigation
      if ((mod && e.altKey && e.code === 'KeyO') || (!mod && !e.altKey && key.startsWith('Arrow'))) {
        e.preventDefault(); selectNextChart(e.shiftKey || ['ArrowLeft', 'ArrowUp'].includes(key) ? -1 : 1); return;
      }
      if (selectedChart && opts.onChartKey?.(e, selectedChart)) return;
      if (mod && key.toLowerCase() === 'c' && selectedChart) { e.preventDefault(); opts.onCommand?.('copyChart', { id: selectedChart }); return; }
      if (key === 'Enter' && selectedChart) { e.preventDefault(); opts.onCommand?.(safeLinkUrl(wb.chartById(sheetId, selectedChart)?.hyperlink) ? 'openDrawingLink' : 'editChart', selectedChart); return; }
      if ((key === 'Delete' || key === 'Backspace') && selectedChart) { e.preventDefault(); opts.onCommand?.('deleteChart', selectedChart); return; }
      if (key === 'Escape') { selectedChart = null; schedule(); return; }
      if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(key)) { e.preventDefault(); opts.onCommand?.('sheet', key === 'ArrowDown' ? 'next' : 'prev'); return; }
      // Document shortcuts continue to the editor; text cannot start a cell.
      return;
    }
    if (isComposing(e) || e.key === 'Dead') {
      beginEdit({ text: '', mode: 'type' });
      return;
    }
    if (e.getModifierState?.('AltGraph') && e.key.length === 1) {
      e.preventDefault();
      if (wb.validationAt(sheetId, sel.active.r, sel.active.c)?.type !== 'checkbox') { beginEdit({ text: e.key, mode: 'type' }); completeFromColumn(); }
      return;
    }
    const b = bounds();
    const mod = isMod(e);
    const key = e.key;
    const dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];

    // Ctrl+Alt+O selects the next chart, image or text box (Shift: the previous one), so they can be reached without a mouse.
    if (mod && e.altKey && e.code === 'KeyO') { e.preventDefault(); selectNextChart(e.shiftKey ? -1 : 1); return; }
    if (selectedChart && opts.onChartKey?.(e, selectedChart)) return; // a chart element takes typing (its title, for one)
    if (selectedChart && mod) {
      // Ctrl+C copies the chart itself, as a picture, rather than the cells behind it.
      if (key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) { e.preventDefault(); opts.onCommand?.('copyChart', { id: selectedChart }); return; }
    } else if (selectedChart) {
      // A selected chart takes the editing keys; the arrows nudge it (a whole cell with Shift).
      if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); const id = selectedChart; selectedChart = null; opts.onCommand?.('deleteChart', id); return; }
      // Enter follows a drawing's link; otherwise it opens the object's editor.
      if (key === 'Enter') { e.preventDefault(); opts.onCommand?.(safeLinkUrl(wb.chartById(sheetId, selectedChart)?.hyperlink) ? 'openDrawingLink' : wb.chartById(sheetId, selectedChart)?.type === 'image' ? 'replaceImage' : 'editChart', selectedChart); return; }
      if (key === 'Escape') { e.preventDefault(); selectedChart = null; schedule(); return; }
      if (dir && !e.altKey) { e.preventDefault(); nudgeChart(selectedChart, dir[0], dir[1], e.shiftKey); return; }
      // Moving on or starting to type leaves the chart; Delete afterwards then clears cells, not the chart.
      if (key === 'Tab' || key === 'F2' || (key.length === 1 && !e.altKey)) { selectedChart = null; schedule(); }
    }

    if (dir && e.altKey && e.shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft')) {
      // Alt+Shift+Right groups the selected rows (or columns), Alt+Shift+Left ungroups, as in Excel.
      e.preventDefault();
      opts.onCommand?.(key === 'ArrowRight' ? 'group' : 'ungroup');
      return;
    }
    // F8 extends the selection with the arrows and clicks; Shift+F8 adds ranges to it. Either again, or Escape, ends it.
    if (key === 'F8' && !mod && !e.altKey) { e.preventDefault(); setKeyMode(e.shiftKey ? (keyMode === 'add' ? null : 'add') : (keyMode === 'extend' ? null : 'extend')); return; }
    if (key === 'Escape' && keyMode) setKeyMode(null);
    if (dir && keyMode && !e.altKey && !mod) {
      e.preventDefault();
      const [dr, dc] = dir;
      if (keyMode === 'end') {
        // End, then an arrow: the jump Ctrl+arrow makes (Shift extends), and End Mode ends.
        const from = e.shiftKey ? { ...sel, active: sel.focus } : sel;
        const target = jumpFrom(from, dr, dc).active;
        setKeyMode(null);
        setSelection(e.shiftKey ? S.extendTo(sel, target.r, target.c) : S.single(target.r, target.c), { grow: false });
      } else if (keyMode === 'extend') {
        const target = stepFrom(S.single(sel.focus.r, sel.focus.c), dr, dc).active;
        setSelection(S.extendTo(sel, target.r, target.c));
      } else {
        // Add to Selection: the range so far stays selected and the cursor moves on alone.
        addRange(S.selRange(sel, true));
        setSelection(stepFrom(S.single(sel.active.r, sel.active.c), dr, dc), { add: true });
      }
      return;
    }
    if (dir) {
      e.preventDefault();
      if (e.altKey && key === 'ArrowDown') {
        const rule = wb.validationAt(sheetId, sel.active.r, sel.active.c);
        if (rule?.type === 'list') { opts.onListOpen?.({ r: sel.active.r, c: sel.active.c, rule }); return; }
        if (isDateCell(sel.active.r, sel.active.c)) { opts.onDateOpen?.({ r: sel.active.r, c: sel.active.c }); return; }
        if (filterHeadAt(sheet(), sel.active.r, sel.active.c)) { opts.onFilterOpen?.({ r: sel.active.r, c: sel.active.c }); return; }
        // On any other cell Alt+Down offers the column's entries, as Excel's pick list does.
        if (!e.shiftKey && !mod) { opts.onCommand?.('pickFromList'); return; }
      }
      // Alt+Right and Alt+Left (Option on a Mac) switch sheets, as Excel for Mac has them: Ctrl/Cmd+PgUp/PgDn do
      // too, but Chrome and Firefox keep Ctrl+PgUp/PgDn for their own tabs.
      if (e.altKey && !e.shiftKey && !mod && !e.ctrlKey && (key === 'ArrowRight' || key === 'ArrowLeft')) { opts.onCommand?.('sheet', key === 'ArrowRight' ? 'next' : 'prev'); return; }
      if (e.altKey && !e.shiftKey && !mod && !e.ctrlKey && key === 'ArrowUp') return;
      const [dr, dc] = dir;
      if (mod) {
        const target = jumpFrom(e.shiftKey ? { ...sel, active: sel.focus } : sel, dr, dc).active;
        setSelection(e.shiftKey ? S.extendTo(sel, target.r, target.c) : S.single(target.r, target.c), { grow: false });
      } else if (e.shiftKey) {
        const target = stepFrom(S.single(sel.focus.r, sel.focus.c), dr, dc).active;
        setSelection(S.extendTo(sel, target.r, target.c));
      }
      else setSelection(stepFrom(sel, dr, dc));
      return;
    }

    switch (key) {
      case 'ContextMenu':
      case 'F10': {
        if (key === 'F10' && !e.shiftKey) return;
        e.preventDefault();
        const rect = cellRect(sel.active.r, sel.active.c);
        opts.onContextMenu?.({ x: rect.left, y: rect.bottom, kind: 'cell' });
        return;
      }
      case 'Enter':
        e.preventDefault();
        if (e.altKey) { beginEdit({ mode: 'inplace' }); return; }
        enterDown(e.shiftKey);
        return;
      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) tabStep(true); else tabRight();
        return;
      case 'Home': {
        e.preventDefault();
        if (keyMode === 'end' && !mod) {
          // End, then Home: the last cell of the data, as Ctrl+End.
          setKeyMode(null);
          const used = wb.usedRange(sheetId) || { r2: 0, c2: 0 };
          const last = visibleTarget({ r: used.r2, c: used.c2 }, -1, -1);
          setSelection(e.shiftKey ? S.extendTo(sel, last.r, last.c) : S.single(last.r, last.c));
          return;
        }
        // Ctrl+Home goes to the first cell below and right of frozen panes, Home to the row's first unfrozen column, as in Excel.
        const fr = sheet().frozenRows || 0, fc = sheet().frozenCols || 0;
        const target = visibleTarget(mod ? { r: fr, c: fc } : { r: sel.active.r, c: fc }, mod ? 1 : 0, 1);
        setSelection(e.shiftKey ? S.extendTo(sel, target.r, target.c) : S.single(target.r, target.c));
        return;
      }
      case 'End': {
        e.preventDefault();
        // End alone turns on End Mode: the next arrow jumps to the edge of the data. Ctrl+End goes to the last cell.
        if (!mod) { setKeyMode(keyMode === 'end' ? null : 'end'); return; }
        const used = wb.usedRange(sheetId) || { r2: 0, c2: 0 };
        const target = visibleTarget(mod ? { r: used.r2, c: used.c2 } : { r: sel.active.r, c: used.c2 }, mod ? -1 : 0, -1);
        setSelection(e.shiftKey ? S.extendTo(sel, target.r, target.c) : S.single(target.r, target.c));
        return;
      }
      case 'PageDown':
      case 'PageUp': {
        e.preventDefault();
        if (mod) { opts.onCommand?.('sheet', key === 'PageDown' ? 'next' : 'prev'); return; }
        // A page is the rows the scrolling part of the viewport shows, wherever it is scrolled to.
        ensureOffsets();
        const st = viewport.scrollTop - shift.y;
        const page = rowOffsets.indexAt(st + viewport.clientHeight) - rowOffsets.indexAt(st + frozen.h) - 1;
        const n = Math.max(1, page) * (key === 'PageDown' ? 1 : -1);
        const origin = e.shiftKey ? sel.focus : sel.active;
        const target = visibleTarget({ r: clamp(origin.r + n, 0, b.rows - 1), c: origin.c }, Math.sign(n), 0);
        setSelection(e.shiftKey ? S.extendTo(sel, target.r, target.c) : S.single(target.r, target.c));
        return;
      }
      case 'Delete':
      case 'Backspace':
        if (mod && key === 'Backspace') break; // Ctrl/Cmd+Backspace scrolls back to the active cell (handled above the grid)
        // Shift+Backspace keeps only the active cell selected, as in Excel.
        if (key === 'Backspace' && e.shiftKey) { e.preventDefault(); setSelection(S.single(sel.active.r, sel.active.c), { scroll: false }); return; }
        e.preventDefault();
        opts.onCommand?.('clear');
        return;
      case 'F2':
        e.preventDefault();
        if (mod && !e.shiftKey && !e.altKey) { opts.onCommand?.('print'); return; } // Ctrl+F2: print preview
        if (e.shiftKey) { opts.onCommand?.('note'); return; }
        beginEdit({ mode: 'inplace' });
        return;
      case 'F3':
        // Shift+F3 opens Insert function, as in Excel; F3 pastes a name, Ctrl+F3 opens the Name Manager and
        // Ctrl+Shift+F3 creates names from the selection.
        e.preventDefault();
        if (mod) opts.onCommand?.(e.shiftKey ? 'createNames' : 'names');
        else opts.onCommand?.(e.shiftKey ? 'functionMenu' : 'pasteNameMenu');
        return;
      case 'F5':
        // F5 is Go To in Excel, Shift+F5 Find; the browser's reload is Ctrl/Cmd+R here anyway.
        e.preventDefault();
        opts.onCommand?.(e.shiftKey ? 'find' : 'goTo');
        return;
      case 'F4':
        // F4 repeats the last action; Shift+F4 finds the next match of the last search.
        if (mod || e.altKey) break;
        e.preventDefault();
        opts.onCommand?.(e.shiftKey ? 'findNext' : 'repeat');
        return;
      case 'F1':
        // Alt+F1 puts a chart of the selection on the sheet; Alt+Shift+F1 inserts a sheet.
        if (!e.altKey || mod) break;
        e.preventDefault();
        opts.onCommand?.(e.shiftKey ? 'newSheet' : 'quickChart');
        return;
      case 'F12':
        if (mod || e.altKey) break;
        e.preventDefault();
        opts.onCommand?.('saveAs');
        return;
      case 'F9':
        e.preventDefault();
        opts.onCommand?.('recalc');
        return;
      case 'F11':
        // Shift+F11 inserts a sheet; F11 alone charts the selection on a chart sheet of its own.
        e.preventDefault();
        opts.onCommand?.(e.shiftKey ? 'newSheet' : 'insertChartSheet');
        return;
      case 'Escape':
        // Escape drops the ranges added with Ctrl/Cmd+click and leaves the current one where it is.
        // In Excel and Sheets it clears the marching ants, the format painter and a trace (the
        // 'escape' command below) and is not a selection command: collapsing a block to its active
        // cell meant reselecting it before it could be copied or formatted again.
        if (extras.length) { e.preventDefault(); setSelection(sel, { scroll: false }); }
        opts.onCommand?.('escape');
        return;
      case ' ': {
        // On a Mac ⌘+Space is Spotlight, so Control stands in for the command key here, as it does for the format chords.
        const modSpace = mod || (IS_MAC && e.ctrlKey && !e.metaKey);
        if (modSpace && e.shiftKey) { e.preventDefault(); selectAllStep(); return; }
        // The active cell stays put, so typing afterwards still lands where the user was.
        if (e.shiftKey) { e.preventDefault(); setSelection({ ...S.selectRows(S.selRange(sel).r1, S.selRange(sel).r2, b), active: sel.active }, { scroll: false }); return; }
        if (modSpace) { e.preventDefault(); setSelection({ ...S.selectCols(S.selRange(sel).c1, S.selRange(sel).c2, b), active: sel.active }, { scroll: false }); return; }
        if (wb.validationAt(sheetId, sel.active.r, sel.active.c)?.type === 'checkbox') { e.preventDefault(); toggleCheckbox(sel.active.r, sel.active.c); return; }
        break;
      }
      default:
        break;
    }

    // Excel's format shortcuts: Ctrl+Shift+! number, @ time, # date, $ currency, % percent, ^ scientific,
    // ~ general; Ctrl+Shift+& draws an outline border, Ctrl+Shift+_ removes borders. On a Mac ⌘+Shift+3, 4
    // and 5 are the system's own screenshot chords and never reach the page, so there Control serves as
    // well, as in Excel for Mac (⌃+Shift+$). Shift changes the key reported, so the physical key counts too.
    if (e.shiftKey && (mod || (IS_MAC && e.ctrlKey && !e.metaKey))) {
      const fmtKey = { '!': 'number', '1': 'number', '@': 'time', '2': 'time', '#': 'date', '3': 'date', '$': 'currency', '4': 'currency', '%': 'percent', '5': 'percent', '^': 'scientific', '6': 'scientific', '~': 'general', '`': 'general' }[key]
        || { Digit1: 'number', Digit2: 'time', Digit3: 'date', Digit4: 'currency', Digit5: 'percent', Digit6: 'scientific', Backquote: 'general' }[e.code];
      if (fmtKey) { e.preventDefault(); opts.onCommand?.('fmt', fmtKey); return; }
      if (key === '&' || key === '7' || e.code === 'Digit7') { e.preventDefault(); opts.onCommand?.('borders', 'outer'); return; }
      if (key === '_' || key === '-' || e.code === 'Minus') { e.preventDefault(); opts.onCommand?.('borders', 'none'); return; }
    }
    // ⌘+` switches windows on a Mac, so Control+` shows formulas there too.
    if (IS_MAC && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (key === '`' || e.code === 'Backquote')) { e.preventDefault(); opts.onCommand?.('showFormulas'); return; }

    if (mod) {
      const k = key.toLowerCase();
      // Ctrl+F1 (⌘+Option+R on a Mac) shows or hides the ribbon's commands.
      if ((key === 'F1' && !e.shiftKey) || (e.altKey && e.code === 'KeyR')) { e.preventDefault(); opts.onCommand?.('toggleRibbon'); return; }
      // Ctrl+Shift+U expands or collapses the formula bar (Ctrl+U alone stays Underline).
      if (e.shiftKey && !e.altKey && k === 'u') { e.preventDefault(); opts.onCommand?.('toggleFormulaBar'); return; }
      // Ctrl+L and Ctrl+T create a table from the data around the active cell (the browser keeps Ctrl+T in some).
      if (!e.shiftKey && !e.altKey && (k === 'l' || k === 't')) { e.preventDefault(); opts.onCommand?.('insertTable'); return; }
      // Ctrl+* (Ctrl+Shift+8) selects the current region: the block of data around the active cell.
      if (key === '*' || (e.shiftKey && e.code === 'Digit8') || e.code === 'NumpadMultiply') {
        e.preventDefault();
        const region = wb.dataRegion(sheetId, sel.active.r, sel.active.c);
        if (region) setSelection({ ...S.fromRange(region, sel.active) }, { scroll: false });
        return;
      }
      const map = { a: 'selectAll', z: e.shiftKey ? 'redo' : 'undo', y: 'redo', b: 'bold', i: 'italic', u: 'underline', s: 'save', f: 'find', h: 'replace', d: 'fillDown', r: 'fillRight', p: 'print', k: 'link', e: 'flashFill' };
      // Ctrl+O opens a file only where a file picker exists; elsewhere the browser keeps the key.
      if (opts.canOpen !== false) map.o = 'open';
      // Ctrl+Shift+F opens Format cells (Excel's font-tab shortcut); plain Ctrl+F finds.
      if (e.shiftKey && k === 'f') { e.preventDefault(); opts.onCommand?.('formatCells', 'font'); return; }
      // Ctrl+Shift+P searches the menus; plain Ctrl+P prints.
      if (e.shiftKey && k === 'p') { e.preventDefault(); opts.onCommand?.('palette'); return; }
      if (map[k]) {
        e.preventDefault();
        if (map[k] === 'selectAll') selectAllStep();
        else opts.onCommand?.(map[k]);
        return;
      }
      if (!e.shiftKey && e.code === 'Digit1') { e.preventDefault(); opts.onCommand?.('formatCells'); return; }
      // Ctrl+9 / Ctrl+0 hide rows / columns; with Shift they come back.
      if (e.code === 'Digit9' || e.code === 'Digit0') {
        e.preventDefault();
        opts.onCommand?.(e.shiftKey ? 'unhide' : 'hide', e.code === 'Digit9' ? 'row' : 'col');
        return;
      }
      // Ctrl+Shift+= inserts, as does Ctrl with a + that needs no Shift (the keypad's, or a layout's own
      // key), and Ctrl+- deletes: columns when whole columns are selected, else rows.
      const range = S.selRange(sel);
      const wholeCols = range.r1 === 0 && range.r2 >= b.rows - 1;
      // Whole rows or columns go straight in or out; part of a sheet asks how the cells should move, as Excel does.
      const wholeRows = range.c1 === 0 && range.c2 >= b.cols - 1;
      if (key === '+' || e.code === 'NumpadAdd' || (e.shiftKey && key === '=')) { e.preventDefault(); opts.onCommand?.(...(wholeCols ? ['insertCols', 'left'] : wholeRows ? ['insertRows', 'above'] : ['insertDialog'])); return; }
      if (!e.shiftKey && key === '-') { e.preventDefault(); opts.onCommand?.(...(wholeCols ? ['deleteCols'] : wholeRows ? ['deleteRows'] : ['deleteDialog'])); return; }
      if (key === '`' && !e.shiftKey) { e.preventDefault(); opts.onCommand?.('showFormulas'); return; }
      // Ctrl+[ highlights the cells a formula reads; Ctrl+] the formulas that read this cell.
      if (key === '[' || key === ']') { e.preventDefault(); opts.onCommand?.('trace', key === '[' ? 'precedents' : 'dependents'); return; }
      if (e.shiftKey) {
        if (key === ';' || key === ':') { e.preventDefault(); opts.onCommand?.('insertTime'); return; }
        if (k === 'l') { e.preventDefault(); opts.onCommand?.('filter'); return; }
        // Ctrl+Shift+> and < step the font size.
        if (key === '>' || key === '.') { e.preventDefault(); opts.onCommand?.('fontStep', 1); return; }
        if (key === '<' || key === ',') { e.preventDefault(); opts.onCommand?.('fontStep', -1); return; }
      }
      // Ctrl+2, 3, 4 and 5: bold, italic, underline and strikethrough, as Excel's older chords.
      if (!e.shiftKey && !e.altKey && ['2', '3', '4'].includes(key)) { e.preventDefault(); opts.onCommand?.({ 2: 'bold', 3: 'italic', 4: 'underline' }[key]); return; }
      if (key === '5') { e.preventDefault(); opts.onCommand?.('strike'); return; }
      // Ctrl+\ selects the row differences, Ctrl+Shift+| the column differences.
      if (key === '\\' || key === '|' || e.code === 'Backslash') { e.preventDefault(); opts.onCommand?.('selectSpecial', e.shiftKey ? 'colDiff' : 'rowDiff'); return; }
      // Ctrl+Shift+{ and } select the precedents and dependents of the active cell.
      if (key === '{' || key === '}') { e.preventDefault(); opts.onCommand?.('selectSpecial', key === '{' ? 'precedents' : 'dependents'); return; }
      // Ctrl+. moves the active cell to the next corner of the selection, clockwise.
      if (key === '.' && !e.shiftKey) {
        e.preventDefault();
        const rg = S.selRange(sel);
        const corners = [{ r: rg.r1, c: rg.c1 }, { r: rg.r1, c: rg.c2 }, { r: rg.r2, c: rg.c2 }, { r: rg.r2, c: rg.c1 }];
        const at = corners.findIndex((p) => p.r === sel.active.r && p.c === sel.active.c);
        const next = corners[(at + 1) % 4];
        const focus = corners[(corners.indexOf(next) + 2) % 4];
        setSelection({ ...S.fromRange(rg, next), anchor: next, focus }, { scroll: true });
        return;
      }
      // Ctrl+Alt+V opens Paste special beside the active cell. With Option held a Mac reports the
      // character the key types (√ on a US keyboard), so the key itself counts too.
      if ((k === 'v' || e.code === 'KeyV') && !e.shiftKey && (e.altKey || (e.metaKey && e.ctrlKey))) { e.preventDefault(); const rect = cellRect(sel.active.r, sel.active.c); opts.onCommand?.('pasteSpecialMenu', { x: rect.left, y: rect.bottom }); return; }
      // Let the native paste event fire, but remember it should drop formulas and styles.
      if (k === 'v' && e.shiftKey) { plainPaste = true; setTimeout(() => { plainPaste = false; }, 500); return; }
      if (key === ';') { e.preventDefault(); opts.onCommand?.('insertDate'); return; }
      // Ctrl+' copies the formula from the cell above; Ctrl+Shift+" copies its value.
      if (key === "'" && !e.shiftKey) { e.preventDefault(); opts.onCommand?.('copyAbove', 'formula'); return; }
      if (key === '"' || (e.shiftKey && key === "'")) { e.preventDefault(); opts.onCommand?.('copyAbove', 'value'); return; }
      return; // copy/cut/paste arrive as clipboard events
    }

    // Alt+= puts a SUM of the numbers above or to the left into the cell. Option+= on a Mac reports
    // the character it types (≠ on a US keyboard), so the physical key counts too.
    if (e.altKey && (key === '=' || key === '+' || e.code === 'Equal')) { e.preventDefault(); opts.onCommand?.('autosum'); return; }
    // Alt+; selects the visible cells only (Option+; reports another character on a Mac, so the key counts too).
    if (e.altKey && !mod && (key === ';' || e.code === 'Semicolon')) { e.preventDefault(); opts.onCommand?.('selectSpecial', 'visible'); return; }
    // Alt+/ searches the menus, as in Google Sheets.
    if (e.altKey && (key === '/' || e.code === 'Slash')) { e.preventDefault(); opts.onCommand?.('palette'); return; }
    // Any other printable key starts typing into the cell (checkboxes toggle instead). A chord
    // with Ctrl, Alt or the command key is not typing, unless it is AltGr producing a character.
    const chord = (e.ctrlKey || e.metaKey || e.altKey) && !e.getModifierState?.('AltGraph');
    if (key.length === 1 && !chord) {
      e.preventDefault();
      if (wb.validationAt(sheetId, sel.active.r, sel.active.c)?.type === 'checkbox') return;
      // The key went into the editor here rather than through an input event, so the type-ahead is asked now.
      beginEdit({ text: key, mode: 'type' });
      completeFromColumn();
      return;
    }
  }

  function editorKeyDown(e) {
    if (!edit || isComposing(e)) return;
    if (hints.handleKey(e)) return;
    const input = editInput();
    const key = e.key;
    // The ready-mode chords a browser also owns (Ctrl+R reloads, Ctrl+D bookmarks, Ctrl+9, 0, [, ], \ and `
    // switch or zoom its tabs) do nothing while an entry is typed, as in Excel, rather than reaching the browser.
    if (isMod(e) && !e.altKey && (/^[rd[\]\\`90]$/i.test(key) || e.code === 'Digit9' || e.code === 'Digit0')) { e.preventDefault(); return; }
    if (isMod(e) && (key === 'PageDown' || key === 'PageUp')) {
      e.preventDefault();
      opts.onCommand?.('sheet', key === 'PageDown' ? 'next' : 'prev');
      return;
    }
    // Alt+Up and Alt+Down (Option on a Mac) switch sheets while an entry is typed too, as the chord does in ready
    // mode and as Google Sheets has it, rather than picking a reference or committing the entry and moving down.
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      opts.onCommand?.('sheet', key === 'ArrowDown' ? 'next' : 'prev');
      return;
    }
    if (isMod(e) && e.shiftKey && !e.altKey && key.toLowerCase() === 'u') { e.preventDefault(); opts.onCommand?.('toggleFormulaBar'); return; }
    if (key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); commitEdit({ arrayEntry: true }); return; }
    if (key === 'Enter' && isMod(e)) { e.preventDefault(); commitEdit({ fillSelection: true }); return; }
    if (isMod(e) && key.toLowerCase() === 'k') { e.preventDefault(); if (commitEdit()) opts.onCommand?.('link'); return; }
    if (key === 'Enter' && !e.altKey) { e.preventDefault(); commitEdit({ move: e.shiftKey ? 'up' : 'down' }); return; }
    if (key === 'Enter' && e.altKey) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = input;
      const next = `${input.value.slice(0, a)}\n${input.value.slice(b)}`;
      input.value = next;
      input.setSelectionRange(a + 1, a + 1);
      setEditText(next, { fromEditor: input === editor });
      return;
    }
    if (key === 'Tab') { e.preventDefault(); commitEdit({ move: e.shiftKey ? 'left' : 'right' }); return; }
    if (key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
    // F9 on the selected part of a formula replaces it with its value, as Excel does (Escape then leaves the cell as it was).
    if (key === 'F9' && !e.shiftKey && !e.altKey && !isMod(e) && String(input.value).startsWith('=')) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b } = input;
      const whole = a === b;
      const part = whole ? input.value.slice(1) : input.value.slice(a, b);
      if (!part.trim()) return;
      const raw = wb.evaluateText(sheetId, edit.r, edit.c, part);
      const value = raw && typeof raw === 'object' && raw.range ? raw.values?.[0]?.[0] ?? null : raw;
      const text = value && typeof value === 'object' && value.error ? value.error
        : typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value == null ? '0' : formatGeneral(value);
      const next = whole ? `=${text}` : `${input.value.slice(0, a)}${text}${input.value.slice(b)}`;
      input.value = next;
      const caret = whole ? next.length : a + text.length;
      input.setSelectionRange(whole ? 1 : a, caret);
      setEditText(next, { fromEditor: input === editor });
      return;
    }
    // Ctrl+A after a function's name opens Function Arguments for it; Ctrl+Shift+A writes its argument names in.
    if (isMod(e) && !e.altKey && key.toLowerCase() === 'a' && String(input.value).startsWith('=')) {
      const before = input.value.slice(0, input.selectionStart);
      const name = /([A-Za-z][A-Za-z0-9._]*)\(?$/.exec(before)?.[1]?.toUpperCase();
      if (name && FUNCTIONS[name]) {
        e.preventDefault();
        if (e.shiftKey) {
          const params = signatureFor(name)?.params;
          const args = params && params !== '...' ? params : '';
          const open = before.endsWith('(') ? '' : '(';
          const insertText = `${open}${args})`;
          const a = input.selectionStart;
          const next = `${input.value.slice(0, a)}${insertText}${input.value.slice(input.selectionEnd)}`;
          input.value = next;
          input.setSelectionRange(a + open.length, a + open.length + args.length);
          setEditText(next, { fromEditor: input === editor });
        } else { cancelEdit(); opts.onCommand?.('functionArgs', name); }
        return;
      }
    }
    // F2 switches between Enter mode (the arrows leave the cell) and Edit mode (they move the caret), as in Excel.
    if (key === 'F2' && !e.shiftKey && !e.altKey && !isMod(e)) {
      e.preventDefault();
      edit.mode = edit.mode === 'type' ? 'inplace' : 'type';
      opts.onEdit?.({ editing: true, text: edit.text, r: edit.r, c: edit.c });
      return;
    }
    if (key === 'F4' && edit.text.startsWith('=')) { e.preventDefault(); cycleRefAnchors(); return; }
    // F3 offers the workbook's names to paste at the caret, as Paste Name does.
    if (key === 'F3' && !e.shiftKey && !isMod(e) && !e.altKey) { e.preventDefault(); opts.onCommand?.('pasteNameMenu'); return; }
    // The insertion chords work mid-edit too: the date, time, the cell above, or a SUM go in at the caret.
    if (isMod(e) && (key === ';' || key === ':')) { e.preventDefault(); opts.onCommand?.(e.shiftKey || key === ':' ? 'insertTime' : 'insertDate'); return; }
    if (isMod(e) && (key === "'" || key === '"')) { e.preventDefault(); opts.onCommand?.('copyAbove', key === '"' || e.shiftKey ? 'value' : 'formula'); return; }
    if (e.altKey && !isMod(e) && (key === '=' || key === '+' || e.code === 'Equal')) { e.preventDefault(); opts.onCommand?.('autosum'); return; }
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[key];
    // Point mode: where a formula expects a reference, the arrows pick one (Shift extends it to a
    // range, Ctrl or ⌘ runs to the edge of the data), the way Excel and Sheets do.
    if (dir && edit.text.startsWith('=') && (edit.refInsert || acceptsRef())) { e.preventDefault(); pointRef(dir, e.shiftKey, isMod(e)); return; }
    // In "type" mode the arrows leave the cell, as in every spreadsheet's
    // enter mode; after F2 or a double-click they move the caret.
    if (dir && input === editor && edit.mode === 'type' && !edit.text.startsWith('=')) { e.preventDefault(); commitEdit({ move: dir }); return; }
    if ((key === 'ArrowUp' || key === 'ArrowDown') && input === editor && edit.mode === 'type') { e.preventDefault(); commitEdit({ move: dir }); return; }
    if (isMod(e) && key.toLowerCase() === 's') { e.preventDefault(); if (commitEdit()) opts.onCommand?.('save'); }
  }

  /**
   * Type-ahead: while typing plain text at the end of the editor, a single
   * matching value from the same column is filled in, spelled as it is in
   * that cell, with the added part selected, so Enter keeps it and typing
   * on replaces it.
   */
  function completeFromColumn() {
    if (!edit) return;
    const text = editor.value;
    if (!text || text.startsWith('=') || text.startsWith("'") || /\n/.test(text)) return;
    if (editor.selectionStart !== text.length || editor.selectionEnd !== text.length) return;
    const options = wb.suggestValues(sheetId, edit.r, edit.c, text);
    if (options.length !== 1) return;
    const full = options[0];
    if (full.toLowerCase() === text.toLowerCase()) return;
    editor.value = full;
    editor.setSelectionRange(text.length, full.length);
    edit.text = full;
    positionEditor();
    opts.onEdit?.({ editing: true, text: full, r: edit.r, c: edit.c });
  }

  /**
   * F4 while editing a formula: the reference at the caret cycles through
   * $A$1 → A$1 → $A1 → A1, the way every spreadsheet does it.
   */
  function cycleRefAnchors() {
    const input = editInput();
    const text = edit.text;
    const caret = input.selectionStart;
    const refs = extractRefs(text.slice(1)).map((x) => ({ ...x, start: x.start + 1, end: x.end + 1 }));
    const hit = refs.find((x) => caret >= x.start && caret <= x.end) || refs.filter((x) => x.end <= caret).pop();
    if (!hit) return;
    const { ref } = hit;
    const out = { ...ref };
    if (ref.kind === 'rows' || ref.kind === 'cols') {
      // A whole line has one anchor to toggle: 2:3 ↔ $2:$3, B:D ↔ $B:$D.
      if (ref.kind === 'rows') { out.absR1 = !ref.absR1; out.absR2 = !ref.absR1; }
      else { out.absC1 = !ref.absC1; out.absC2 = !ref.absC1; }
    } else {
      const state = ref.absC1 && ref.absR1 ? 1 : !ref.absC1 && ref.absR1 ? 2 : ref.absC1 && !ref.absR1 ? 3 : 0;
      const next = [[true, true], [false, true], [true, false], [false, false]][state];
      out.absC1 = next[0]; out.absC2 = next[0];
      out.absR1 = next[1]; out.absR2 = next[1];
    }
    const replacement = refToText(out);
    const value = text.slice(0, hit.start) + replacement + text.slice(hit.end);
    input.value = value;
    input.setSelectionRange(hit.start + replacement.length, hit.start + replacement.length);
    setEditText(value, { fromEditor: input === editor });
  }

  /* ---------- Wiring ---------- */

  viewport.addEventListener('scroll', () => {
    if (destroyed) return; // a viewport left in the page must not keep growing the workbook
    syncHeaders();
    schedule();
    if (sheet()?.kind === 'chart') return;
    followWindows();
    rememberViewOrigin();
    // The grid's own scroll is not the user reaching for the edge: only their scrolling grows the sheet.
    if (scrollByCode) {
      const own = Math.abs(viewport.scrollLeft - scrollByCode.left) < 1 && Math.abs(viewport.scrollTop - scrollByCode.top) < 1;
      scrollByCode = null;
      if (own) return;
    }
    // Approaching the bottom or right edge grows the sheet.
    ensureOffsets();
    const s = sheet();
    const nearBottom = reachesEnd(rowOffsets) && viewport.scrollTop - shift.y + viewport.clientHeight > rowOffsets.total() - 120;
    const nearRight = reachesEnd(colOffsets) && viewport.scrollLeft - shift.x + viewport.clientWidth > colOffsets.total() - 120;
    if (!nearBottom && !nearRight) return;
    growingByScroll = true;
    try {
      if (wb.ensureSize(sheetId, nearBottom ? s.rows + GROW_ROWS : 0, nearRight ? s.cols + GROW_COLS : 0)) rebuildOffsets();
    } finally { growingByScroll = false; }
  }, { passive: true });

  // Ctrl+wheel zooms in 10% steps; a trackpad pinch arrives the same way but as dozens of tiny
  // events, so those add up and step once every 40px, while a mouse notch is one step.
  let wheelAcc = 0;
  let wheelAt = 0;
  viewport.addEventListener('wheel', (e) => {
    if (destroyed || (!isMod(e) && !e.ctrlKey)) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const now = Date.now();
    if (Math.sign(px) !== Math.sign(wheelAcc) || now - wheelAt > 300) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += px;
    if (Math.abs(wheelAcc) < 40) return;
    setZoom(userZoom + (wheelAcc < 0 ? 0.1 : -0.1));
    wheelAcc = 0;
  }, { passive: false });
  // A split window's left and top panes scroll on their own: the wheel over one scrolls it along its own
  // axis, and along the other with the pane it shares that axis with.
  viewport.addEventListener('wheel', (e) => {
    if (destroyed || !frozen.split || isMod(e) || e.ctrlKey) return;
    const vp = viewport.getBoundingClientRect();
    const inLeft = frozen.left && e.clientX - vp.left < frozen.w;
    const inTop = frozen.top && e.clientY - vp.top < frozen.h;
    if (!inLeft && !inTop) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? viewport.clientHeight : 1;
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    scrollSplitPanes(frozen.sl + (inLeft ? dx : 0), frozen.st + (inTop ? dy : 0));
    if ((!inLeft && dx) || (!inTop && dy)) viewport.scrollBy(inLeft ? 0 : dx, inTop ? 0 : dy);
  }, { passive: false });
  viewport.addEventListener('pointerdown', cellsPointerDown);
  viewport.addEventListener('pointermove', pointerMove);
  viewport.addEventListener('pointerup', pointerUp);
  viewport.addEventListener('pointercancel', cancelDrag);
  viewport.addEventListener('pointerleave', () => viewport.classList.remove('can-move'));
  viewport.addEventListener('dblclick', onDoubleClick);
  viewport.addEventListener('contextmenu', onContextMenu);
  viewport.addEventListener('keydown', onKeyDown);
  editor.addEventListener('keydown', editorKeyDown);
  // Text pasted into the cell's editor is outside content like a paste into the cells: the entry is marked (readable
  // as editState.pasted until it is committed) so the editor's commit hook can put it through the same gate.
  editor.addEventListener('paste', () => { if (edit) edit.pasted = true; });
  // Text dropped into the editor is outside content too: the browser inserts it without a paste
  // event, so a formula reaching out would otherwise be let out on a drag nobody consented to.
  editor.addEventListener('drop', () => { if (edit) edit.pasted = true; });
  editor.addEventListener('input', (e) => {
    setEditText(editor.value, { fromEditor: true });
    if (!isComposing(e) && e.inputType === 'insertText') completeFromColumn();
  });
  /**
   * The caret moved without the text changing (Home, End, a click, or an arrow outside point
   * mode): the argument shown may have changed, and a picked reference the caret has left is no
   * longer the one the next pick replaces, so that pick goes in at the caret.
   */
  function caretMoved() {
    if (edit?.refInsert) {
      // A pick or an arrow leaves the caret at the reference's end; anywhere up to its start is a move away.
      const at = editInput().selectionStart;
      if (at <= edit.refInsert.start || at > edit.refInsert.end) { edit.refInsert = null; edit.point = null; }
    }
    updateHints();
  }
  editor.addEventListener('keyup', (e) => { if (!isComposing(e) && /^Arrow|^Home$|^End$/.test(e.key)) caretMoved(); });
  editor.addEventListener('click', caretMoved);
  editor.addEventListener('blur', () => {
    // Clicking a toolbar button while editing should keep the edit alive;
    // clicking anywhere in the grid commits via the pointer handlers.
    // Focus moving out of the app entirely commits too.
    setTimeout(() => {
      if (!edit || destroyed) return;
      const a = document.activeElement;
      if (a === editor || a === viewport || root.contains(a)) return;
      if (a?.closest?.('.formula-bar, .toolbar, .menubar, .menu, .modal-root, .topbar')) return;
      // Browsing an overflowing tab strip changes neither the active sheet nor the pending entry.
      if (a?.closest?.('.sheet-tabs .tab-scroll-btn')) return;
      // A tab pressed while a formula wants a reference shows that sheet with the edit alive; any
      // other press on the tab strip (its menu, a rename, a new sheet) commits first, as in Excel.
      if (a?.closest?.('.sheet-tabs .tab') && acceptsRef()) return;
      commitEdit();
    }, 0);
  });

  colClip.addEventListener('pointerdown', (e) => headerPointerDown(e, 'col'));
  rowClip.addEventListener('pointerdown', (e) => headerPointerDown(e, 'row'));
  for (const clip of [colClip, rowClip]) {
    clip.addEventListener('click', e => {
      const outline = e.target.closest?.('.outline-btn');
      if (!outline || edit && !commitEdit()) return;
      opts.onCommand?.('toggleGroup', { axis: outline.dataset.axis, from: Number(outline.dataset.from), to: Number(outline.dataset.to) });
    });
    clip.addEventListener('pointermove', pointerMove);
    clip.addEventListener('pointerup', pointerUp);
    // The header tracks hold the capture during their drags, so the cancel arrives here, not at the viewport.
    clip.addEventListener('pointercancel', cancelDrag);
    clip.addEventListener('lostpointercapture', cancelDrag);
    clip.addEventListener('dblclick', headerDoubleClick);
  }
  colClip.addEventListener('contextmenu', (e) => headerContextMenu(e, 'col'));
  rowClip.addEventListener('contextmenu', (e) => headerContextMenu(e, 'row'));
  corner.addEventListener('click', () => { if (edit && !commitEdit()) return; setSelection(S.selectAll(bounds()), { scroll: false }); viewport.focus({ preventScroll: true }); });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { measureChrome(); rendered.key = null; schedule(); }) : null;
  ro?.observe(viewport);

  // A workbook can introduce a bundled font after the first render. Discard
  // measurements made with its fallback, then redraw spills and numeric fit.
  const fontsLoaded = () => { widthCache.clear(); measuredIndentFont = undefined; automaticHeightState = new WeakMap(); rendered.key = null; invalidateOffsets(); };
  document.fonts?.addEventListener('loadingdone', fontsLoaded);

  function measureChrome() {
    showHeaders = sheet()?.headers !== false;
    root.classList.toggle('no-headers', !showHeaders);
    // The stylesheet's header sizes are the base; the outline gutter adds to them.
    root.style.removeProperty('--row-header-w');
    root.style.removeProperty('--col-header-h');
    const cs = getComputedStyle(root);
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;
    baseRowHeaderW = parseInt(cs.getPropertyValue('--row-header-w'), 10) || (narrow ? ROW_HEADER_W_MOBILE : ROW_HEADER_W_DESKTOP);
    baseColHeaderH = parseInt(cs.getPropertyValue('--col-header-h'), 10) || COL_HEADER_H;
    // With headers hidden the header tracks collapse; an outline gutter still gets its room.
    if (!showHeaders) { baseRowHeaderW = 0; baseColHeaderH = 0; }
    baseFontSize = parseFloat(cs.getPropertyValue('--grid-font-size')) || 13;
    applyOutlineGutter();
    applyZoomFont(cs.fontFamily || 'system-ui');
  }

  /** Room for the group brackets beside the row numbers and above the column letters. */
  function applyOutlineGutter() {
    const rowDepth = wb.outlineDepth(sheetId, 'row');
    const colDepth = wb.outlineDepth(sheetId, 'col');
    const gw = rowDepth ? rowDepth * OUTLINE_STEP + 8 : 0;
    const gh = colDepth ? colDepth * OUTLINE_STEP + 8 : 0;
    const ruler = pageLayout ? PAGE_RULER : 0;
    rowHeaderW = (baseRowHeaderW && Math.max(baseRowHeaderW, rowDigitsW)) + gw + ruler;
    colHeaderH = baseColHeaderH + gh + ruler;
    root.style.setProperty('--ruler-size', `${ruler}px`);
    root.style.setProperty('--row-header-w', `${rowHeaderW}px`);
    root.style.setProperty('--col-header-h', `${colHeaderH}px`);
    root.style.setProperty('--outline-w', `${gw}px`);
    root.style.setProperty('--outline-h', `${gh}px`);
  }

  /**
   * Group brackets for the header tracks: a line along the grouped lines
   * and a button at the line after the group that collapses or expands it.
   */
  function outlineNodes(axis, vr) {
    const groups = wb.outlineGroups(sheetId, axis);
    if (!groups.length) return [];
    const s = sheet();
    const out = [];
    const total = axis === 'row' ? s.rows : s.cols;
    const pos = axis === 'row' ? rowY : colX;
    const size = axis === 'row' ? rowH : colW;
    const lo = axis === 'row' ? vr.r0 : vr.c0;
    const hi = axis === 'row' ? vr.r1 : vr.c1;
    for (const g of groups) {
      const after = Math.min(g.to + 1, total - 1);
      if (g.to < lo - 1 || g.from > hi + 1) continue;
      const offset = (g.level - 1) * OUTLINE_STEP + 4;
      const start = pos(g.from);
      const end = pos(g.to + 1);
      if (!g.collapsed && end > start) {
        const line = el('div.outline-line', { dataset: { level: g.level } });
        if (axis === 'row') { line.style.top = `${start}px`; line.style.height = `${end - start}px`; line.style.left = `${offset + 5}px`; }
        else { line.style.left = `${start}px`; line.style.width = `${end - start}px`; line.style.top = `${offset + 5}px`; }
        out.push(line);
      }
      const btn = el('button.outline-btn', {
        type: 'button', tabindex: -1,
        'aria-label': `${g.collapsed ? 'Expand' : 'Collapse'} ${axis === 'row' ? 'rows' : 'columns'} ${axis === 'row' ? `${g.from + 1} to ${g.to + 1}` : `${cellName(0, g.from).replace(/\d+$/, '')} to ${cellName(0, g.to).replace(/\d+$/, '')}`}`,
        title: g.collapsed ? 'Expand group' : 'Collapse group',
        dataset: { axis, from: g.from, to: g.to },
      }, g.collapsed ? '+' : '−');
      const center = pos(after) + Math.min(size(after), 26) / 2;
      if (axis === 'row') { btn.style.top = `${center - 7}px`; btn.style.left = `${offset}px`; }
      else { btn.style.left = `${center - 7}px`; btn.style.top = `${offset}px`; }
      out.push(btn);
    }
    return out;
  }

  function applyZoomFont(family = null) {
    const fam = family || cellFont.replace(/^[\d.]+px\s*/, '') || 'system-ui';
    cellFont = `${(baseFontSize * zoom).toFixed(2)}px ${fam}`;
    root.style.setProperty('--zoom', String(zoom));
    root.style.setProperty('--cell-text-inset', `${CELL_TEXT_INSET * zoom}px`);
  }

  /** Zoom the sheet over Excel's 10–400% range. Sizes stay stored unzoomed. */
  function setZoom(z, initializing = false) {
    if (!Number.isFinite(z)) return;
    const chartSheet = sheet()?.kind === 'chart';
    // Custom percentages and imported views use the same precision. Stepping or pinching from
    // 133% should reach 143%, not silently round the user's view to a multiple of five.
    const next = Math.max(.1, Math.min(4, Math.round(z * 100) / 100));
    if (!initializing) { wb.setSheetView(sheetId, { ...(chartSheet ? { zoomToFit: false } : {}), viewZoom: next }); schedule(); }
    if (next === userZoom) return;
    // Keep the top-left cell in place while the scale changes.
    ensureOffsets();
    const s = sheet();
    const topRow = rowOffsets.indexAt(viewport.scrollTop - shift.y + frozen.h);
    const leftCol = colOffsets.indexAt(viewport.scrollLeft - shift.x + frozen.w);
    zoom = next * (zoom / userZoom || 1);
    userZoom = next;
    applyZoomFont();
    rebuildOffsets();
    windowsFor(topRow, leftCol);
    if (s) scrollViewportTo(Math.max(-shift.x, colOffsets.at(leftCol) - frozen.w), Math.max(-shift.y, rowOffsets.at(topRow) - frozen.h));
    rendered.key = null;
    schedule();
    opts.onZoom?.(userZoom);
  }

  /**
   * Scrolling near the sheet's edge added rows or columns. A selection that
   * covered whole columns or rows keeps covering them; otherwise "delete the
   * column" would quietly become "delete the first hundred rows". Growth from
   * moving the active cell to the last row is different: that selection was
   * just set, and walking it with Enter should wrap rather than chase the edge.
   */
  function growWholeSelections(prev, b) {
    const grow = (range) => {
      const wholeCols = ['columns', 'sheet'].includes(range.scope) && b.rows > prev.rows;
      const wholeRows = ['rows', 'sheet'].includes(range.scope) && b.cols > prev.cols;
      return wholeCols || wholeRows ? { ...range, r2: wholeCols ? b.rows - 1 : range.r2, c2: wholeRows ? b.cols - 1 : range.c2 } : range;
    };
    const range = S.selRange(sel, true);
    const grown = grow(range);
    if (grown !== range) {
      const at = (p) => ({ r: p.r === range.r2 && grown.r2 !== range.r2 ? grown.r2 : p.r, c: p.c === range.c2 && grown.c2 !== range.c2 ? grown.c2 : p.c });
      sel = { ...sel, anchor: at(sel.anchor), focus: at(sel.focus), ...(sel.range ? { range: grown } : {}) };
    }
    extras = extras.map(grow);
    rememberSheetSelection();
  }

  function onWorkbookChange(e) {
    const prev = knownSize;
    if (e.detail?.type === 'structure' || e.detail?.type === 'history') { const before = `${rowHeaderW}|${colHeaderH}`; applyOutlineGutter(); if (`${rowHeaderW}|${colHeaderH}` !== before) invalidateOffsets(); }
    if (destroyed) return;
    const type = e.detail?.type;
    // A structural edit moves rows out from under the grid's memory of which ones it fitted: the memory is dropped for the sheet (a row's own height tells from then on).
    if (type === 'structure') { if (e.detail?.sheetId) fitted.delete(e.detail.sheetId); else fitted.clear(); }
    // Columns resized on this sheet, found before the offsets (and the widths remembered with them) are rebuilt.
    const resized = type === 'layout' && (e.detail?.sheetId ?? sheetId) === sheetId ? changedColumns() : null;
    // The offsets are laid out again in the next frame, or on the first read before it, not for every event of a burst.
    if (type === 'structure' || type === 'layout' || type === 'history') invalidateOffsets();
    // A recalculation computes every formula afresh without editing anything, so wb.version stands
    // still: the cells and every chart's picture would otherwise keep results that are no longer
    // what their formulas give. Both are marked stale by hand. A chart's signature goes with its
    // version, so the picture is drawn again whatever the reading of its range says: the regional
    // format is a recalculation too, and it changes only how values are shown — the signature reads
    // the values and their format keys, never the text drawn from them, so a range of plain numbers
    // and dates fingerprints the same before and after and the picture would keep the old locale's
    // axis labels, value labels, tooltips and date categories while the cells around it changed.
    if (type === 'recalc') { automaticHeightState = new WeakMap(); rendered.version = -1; for (const box of chartBoxes.values()) { box.version = -1; box.sig = null; } }
    // The sheet holding the entry being typed is gone, so the entry has nowhere to land: it is
    // dropped rather than committed into whichever sheet is shown next.
    if (edit && !wb.sheet(edit.sheetId)) cancelEdit();
    if (!wb.sheet(sheetId)) { setSheet(wb.activeSheetId); return; }
    if (showHeaders !== (sheet().headers !== false)) measureChrome();
    const b = bounds();
    if (growingByScroll && prev && prev.sheetId === sheetId && (b.rows > prev.rows || b.cols > prev.cols)) growWholeSelections(prev, b);
    knownSize = { sheetId, rows: b.rows, cols: b.cols }; // kept current here, since the layout itself may wait for the frame
    if (sel.active.r >= b.rows || sel.active.c >= b.cols || sel.focus.r >= b.rows || sel.focus.c >= b.cols) {
      setSelection(sel, { scroll: false, announce: false });
    }
    // The active cell never sits in a hidden row or column: typing there would open an editor
    // nobody can see. It moves to the nearest visible line, as in Excel.
    if (!edit && (type === 'layout' || type === 'structure' || type === 'history' || type === 'cells')) {
      const s = sheet();
      if (rowHidden(s, sel.active.r) || s.hiddenCols.has(sel.active.c)) {
        if (S.isSingle(sel)) {
          const t = visibleTarget(sel.active, 1, 1);
          if (t.r !== sel.active.r || t.c !== sel.active.c) setSelection(S.single(t.r, t.c), { scroll: false, announce: false, add: true });
        } else {
          // A range keeps its lines, as in Excel (and so Unhide still knows which are meant); only its
          // active cell moves, to a visible cell of the range if it has one, as when it was selected.
          setSelection({ active: sel.active, anchor: sel.anchor, focus: sel.focus }, { scroll: false, announce: false, add: true });
        }
      }
    }
    if (resized?.length) refitResized(resized);
    // The frame scheduled here paints the selection too (a note or link may have come or gone); painting it now as well would do the work twice.
    rendered.key = null;
    schedule();
  }
  wb.addEventListener('change', onWorkbookChange);

  /** The columns whose stored width differs from the one last laid out for this sheet. */
  function changedColumns() {
    const s = sheet();
    if (!s || !knownWidths || knownWidths.sheetId !== sheetId) return [];
    const out = [];
    for (const [c, w] of s.colWidths) if (knownWidths.widths.get(c) !== w) out.push(c);
    for (const c of knownWidths.widths.keys()) if (!s.colWidths.has(c)) out.push(c);
    return out;
  }

  /**
   * Columns resized from outside the grid (Format → Column width, Fit columns to content, pasted
   * widths, a pivot table built) announce themselves through the change event. Their wrapped rows
   * are fitted there and then, while the resize's own transaction is still open, so the fit joins
   * its undo step: an edit a listener makes in answer to a change belongs to the batch that
   * announced it. One Ctrl/Cmd+Z then puts the width and the heights back together, as in Excel;
   * fitted a moment later instead, the heights were a step of their own and the first undo left a
   * wide column showing one line of text in a tall row. The grid's own resizes fit the rows inside
   * their transaction before the event and record the widths they fitted for, so a column both saw
   * is not fitted twice.
   */
  function refitResized(cols) {
    // The widths the rows were fitted for are the ones laid out last; they are read before the frame lays the new ones out.
    const known = knownWidths?.sheetId === sheetId ? knownWidths.widths : null;
    const before = new Map();
    for (const c of cols) before.set(c, known?.get(c) ?? sheet().defaultColWidth);
    refitWrappedRows(cols, before);
  }

  /**
   * Columns were resized: the rows whose wrapped text they hold are fitted to the new width
   * again, as Excel and Sheets do, unless someone set the row's height by hand (a height the grid
   * fitted itself is not that; `before`, the columns' widths before the resize, is what the rows
   * were fitted for). Called inside a resize's transaction, the fit joins it as one undo step.
   * The wrapped cells are looked up by coordinate when that beats walking every cell.
   */
  function refitWrappedRows(cols, before = null) {
    const s = sheet();
    // These columns' rows are fitted for their present widths: the layout event a transaction
    // announces at its end must not have them fitted a second time.
    if (knownWidths?.sheetId === sheetId) for (const c of cols) { const w = s.colWidths.get(c); if (w == null) knownWidths.widths.delete(c); else knownWidths.widths.set(c, w); }
    const set = new Set(cols);
    const spans = (m) => cols.some((cc) => cc >= m.c1 && cc <= m.c2);
    const widthBefore = (c) => (before?.has(c) ? before.get(c) : wb.colWidth(sheetId, c));
    const judged = new Map(); // row → sized by hand, asked once per row
    const sizedByHand = (r) => { if (!judged.has(r)) judged.set(r, rowSizedByHand(r, widthBefore)); return judged.get(r); };
    const rows = new Set();
    const consider = (r, c, cell) => {
      if ((cell.v == null && cell.f == null) || !styleAt(s, r, c)?.wrap || rowHidden(s, r)) return;
      // A wrapped merge is measured across all its columns, so a resized one among them counts.
      if (!set.has(c)) { const m = s.merges.length ? mergeAt(r, c) : null; if (!m || !spans(m)) return; }
      if (sizedByHand(r)) return;
      rows.add(r);
    };
    if (cols.length * s.rows < s.cells.size) {
      for (const c of cols) for (let r = 0; r < s.rows; r++) { const cell = s.cells.get(cellKey(r, c)); if (cell) consider(r, c, cell); }
      for (const m of s.merges) if (!set.has(m.c1) && spans(m)) { const cell = s.cells.get(cellKey(m.r1, m.c1)); if (cell) consider(m.r1, m.c1, cell); }
    } else {
      for (const [key, cell] of s.cells) {
        const comma = key.indexOf(',');
        consider(Number(key.slice(0, comma)), Number(key.slice(comma + 1)), cell);
      }
    }
    if (!rows.size) return;
    // Measured first, written once: every write inside the step drops the workbook's caches (its
    // spill index, range and rule statistics), so measuring each row after the last one's write
    // would rebuild them for every row, and a colour scale on the sheet made the refit quadratic.
    const heights = new Map();
    for (const r of rows) for (const [rr, h] of measureRowHeights(r, r)) heights.set(rr, h);
    applyRowHeights(heights);
  }

  /**
   * The rows the grid sized, by sheet: row → { height, floor }, the height it gave the row (as
   * stored; the workbook caps a height) and, for a row someone had sized that the grid only grew
   * for its text, the height they set, its floor: such a row stays someone's size. A structural
   * edit moves rows out from under the memory, so it is dropped for the sheet then; from there,
   * and once an undo has put a height back, a row's own height tells (rowSizedByHand). Every
   * recorded step announces `history`, so that event cannot be the cue to forget.
   */
  // Heights are derived caches. Opening a workbook or loading a font must not
  // create an undo step, mark it dirty, or invalidate volatile formula values.
  let automaticHeightState = new WeakMap();
  function refreshAutomaticRowHeights() {
    const s = sheet();
    if (!s?.rowHeightModes.size || s.kind === 'chart') return false;
    const previous = automaticHeightState.get(s);
    if (previous?.version === wb.version) return false;
    const changes = previous ? wb.changesSince(previous.version) : null;
    if (changes?.every(ch => ch.type === 'view')) { previous.version = wb.version; return false; }
    const rows = new Set([...s.rowHeightModes].filter(([r, mode]) => mode === 'auto' && r < s.rows).map(([r]) => r));
    if (!rows.size) { automaticHeightState.set(s, { version: wb.version, formulas: new Set() }); return false; }
    const all = !changes || changes.some(ch => ch.type !== 'view' && (ch.type !== 'cells' || !ch.box || ch.formula));
    let formulas = previous?.formulas || new Set();
    if (all) {
      formulas = new Set();
      for (const [key, cell] of s.cells) if (cell.f != null) {
        const r = Number(key.slice(0, key.indexOf(',')));
        if (rows.has(r)) formulas.add(r);
      }
    }
    const affected = all ? rows : new Set(changes.some(ch => ch.type === 'cells') ? formulas : []);
    if (!all) for (const ch of changes) if (ch.type === 'cells' && ch.sheetId === sheetId) {
      for (const r of rows) if (r >= ch.box.r1 && r <= ch.box.r2) affected.add(r);
    }
    // Measurements are batched before changing any cache. Sparse distant rows
    // use a single scan, never one whole-sheet scan per automatic row.
    let first = Infinity, last = -1;
    for (const r of affected) { first = Math.min(first, r); last = Math.max(last, r); }
    const heights = last >= first ? measureRowHeights(first, last, { force: true, onlyRows: affected, automatic: true }) : new Map();
    automaticHeightState.set(s, { version: wb.version, formulas });
    return wb.cacheAutoRowHeights(sheetId, heights);
  }

  const fitted = new Map(); // sheetId → Map(row → { height, floor })
  const fitMemory = (r) => fitted.get(sheetId)?.get(r);
  function rememberFit(r, height, floor = null) {
    let rows = fitted.get(sheetId);
    if (!rows) fitted.set(sheetId, (rows = new Map()));
    rows.set(r, { height, floor });
  }
  /** A height as the workbook stores it: rounded and kept within the bounds setRowHeight applies. */
  const asStored = (h) => Math.max(18, Math.min(400, Math.round(h)));

  /**
   * Was row r sized by someone, rather than fitted by the grid? A stored height the grid did not
   * give it, or gave it only by growing a height they had set (the memory keeps that floor), unless
   * that is what its wrapped text needed anyway at the column widths `widthOf` gives (those before
   * a resize, when judging for the refit that follows one): a row fitted before an undo or a
   * structural edit still holds the height its text asked for.
   */
  function rowSizedByHand(r, widthOf = null) {
    const mode = sheet().rowHeightModes.get(r);
    if (mode) return mode === 'fixed';
    const stored = sheet().rowHeights.get(r);
    if (stored == null) return false;
    const known = fitMemory(r);
    if (known && known.height === stored) return known.floor != null;
    const need = measureRowHeights(r, r, widthOf ? { widthOf } : {}).get(r);
    return need == null || asStored(need) !== stored;
  }

  function measureRowHeights(r1, r2, options = {}) {
    return measureRows(wb, sheetId, r1, r2, { baseFontSize, cellFont, textWidth, styleAt, mergeAt, ...options });
  }

  /** Write measured heights, as one step; with `grow` a row is only ever made taller, and stays someone's size. */
  function applyRowHeights(heights, { grow = false } = {}) {
    const s = sheet();
    if (!s || !heights.size) return;
    const hidden = (r) => s.hiddenRows.has(r) || s.filterHidden.has(r);
    wb.transaction('Fit row height', () => {
      for (const [r, h] of heights) {
        if (hidden(r)) continue;
        const current = wb.rowHeight(sheetId, r);
        if (grow && h <= current) continue;
        // A row someone sized that is grown for its text keeps the height they set as its floor, so
        // it still reads as theirs (a fitted row holds exactly what its text needs, as this one now does).
        const known = fitMemory(r);
        const floor = grow ? (known && known.height === current && known.floor != null ? known.floor : current) : null;
        // Explicitly fitting merged text is an existing app feature. Excel's
        // automatic sizing excludes merges, so keep the legacy fit policy
        // (and export a fixed height) instead of immediately undoing this fit.
        const auto = grow ? false : s.merges.some(m => r >= m.r1 && r <= m.r2) ? null : true;
        const mode = auto == null ? undefined : auto ? 'auto' : 'fixed';
        if (current !== h || !grow && s.rowHeightModes.get(r) !== mode) wb.setRowHeight(sheetId, r, h, { auto });
        rememberFit(r, wb.rowHeight(sheetId, r), floor); // as stored (the workbook caps a height)
      }
    });
  }

  /**
   * Size rows to their wrapped text: every wrapped cell in the row is measured at the row's column
   * widths and the tallest wins. Rows without wrapped text are left alone unless `force` (row menu)
   * asks for a fit; with `grow` a row is only ever made taller.
   */
  function autoFitRows(r1, r2, { force = false, grow = false } = {}) {
    if (!sheet()) return;
    applyRowHeights(measureRowHeights(r1, r2, { force }), { grow });
  }

  /* ---------- Public API ---------- */

  function setSheet(id) {
    if (returning || (edit && id === sheetId && id === edit.sheetId)) return;
    if (edit && id !== sheetId && (id === edit.sheetId || acceptsRef())) {
      // A formula wants a reference: the edit stays alive while another sheet
      // is shown, and clicks there insert Sheet!A1 references. Going back to
      // the cell's own sheet keeps the edit too.
      showSheet(id);
      edit.point = null;
      edit.refInsert = null;
      positionEditor();
      renderRefHighlights();
      if (document.activeElement !== editor && !document.activeElement?.closest?.('.formula-bar')) editor.focus({ preventScroll: true });
      opts.announce?.(id === edit.sheetId ? 'Back to the cell being edited' : `Pick a reference on ${sheet().name}`);
      return;
    }
    if (edit && !commitEdit()) {
      if (wb.activeSheetId !== sheetId) wb.setActiveSheet(sheetId);
      return;
    }
    showSheet(id);
  }

  /** Show a sheet, remembering this one's selection and scroll position; the edit state is left alone. */
  function showSheet(id) {
    // A drag begun on this sheet (a move, a fill, a chart, a header, a long press) ends without
    // acting: switched away from under it by a key, its release would otherwise move or fill cells
    // on the sheet shown next, which never showed a preview of it.
    if (drag || tap || freezeDrag) cancelDrag();
    if (sheetId && wb.sheet(sheetId) && !pendingOrigin) {
      rememberViewOrigin();
      perSheet.set(sheetId, { sel, extras, scrollLeft: viewport.scrollLeft - shift.x, scrollTop: viewport.scrollTop - shift.y, windowAt });
    }
    sheetId = id;
    measureChrome();
    selectedChart = null;
    chartView = null;
    windowAt = perSheet.get(id)?.windowAt || { r: 0, c: 0 };
    rebuildOffsets();
    const saved = perSheet.get(id) || savedSheetSelection();
    pendingOrigin = perSheet.has(id) ? null : sheet()?.viewOrigin || null;
    rendered.key = null;
    scrollViewportTo(saved?.scrollLeft || 0, saved?.scrollTop || 0);
    syncHeaders();
    // The ranges added with Ctrl/Cmd+click come back with the selection, cut to the sheet's present size.
    const b = bounds();
    extras = (saved?.extras || []).filter((x) => x.r1 < b.rows && x.c1 < b.cols).map((x) => ({ ...x, r2: Math.min(x.r2, b.rows - 1), c2: Math.min(x.c2, b.cols - 1) }));
    setSelection(saved?.sel || S.single(0, 0), { scroll: false, announce: false, add: true, grow: false });
  }

  function selectByName(text) {
    if (sheet()?.kind === 'chart') return false;
    const t = text.trim();
    // Whole columns (A:C) and whole rows (3:5), as the name box accepts in Excel and Sheets.
    const cols = /^\$?([A-Za-z]{1,3})\$?:\$?([A-Za-z]{1,3})$/.exec(t);
    const lines = /^(\d+):(\d+)$/.exec(t);
    if (cols || lines) {
      const s = sheet();
      const [a, b] = cols ? [colIndex(cols[1].toUpperCase()), colIndex(cols[2].toUpperCase())] : [Number(lines[1]) - 1, Number(lines[2]) - 1];
      if (!(a >= 0 && b >= 0)) return false;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (cols ? hi >= s.cols : hi >= s.rows) {
        if (!wb.canEnsureSize(sheetId, cols ? s.rows : hi + 1, cols ? hi + 1 : s.cols) || !wb.ensureSize(sheetId, cols ? s.rows : hi + 1, cols ? hi + 1 : s.cols)) return false;
        rebuildOffsets();
      }
      // Whole lines come into view along their own axis only; the other axis stays put, so A:C
      // does not jump to the last row nor 2:3 to the last column.
      setSelection(cols ? S.selectCols(lo, hi, bounds()) : S.selectRows(lo, hi, bounds()), { scroll: false });
      scrollIntoView(sel.active, cols ? { rows: false } : { cols: false });
      return true;
    }
    const range = parseRange(t) || (parseCellRef(t) && parseRange(t));
    if (!range) return false;
    if (!wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) return false;
    // A range running the grid's whole height (A1:C1048576) or width (A2:XFD3) is those columns or rows.
    const fullCols = range.r1 === 0 && range.r2 >= MAX_ROWS - 1, fullRows = range.c1 === 0 && range.c2 >= MAX_COLS - 1;
    if (fullCols || fullRows) {
      setSelection(fullCols && fullRows ? S.selectAll(bounds()) : fullCols ? S.selectCols(range.c1, range.c2, bounds()) : S.selectRows(range.r1, range.r2, bounds()), { scroll: false });
      if (!(fullCols && fullRows)) scrollIntoView(sel.active, fullCols ? { rows: false } : { cols: false });
      return true;
    }
    const s = sheet();
    if (range.r2 >= s.rows || range.c2 >= s.cols) {
      if (!wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1)) return false;
      rebuildOffsets();
    }
    // The top-left of a range comes into view, as Go To does in Excel, not its far corner. One cell
    // named in a hidden row or column lands on the nearest shown cell instead: the grid never draws
    // a hidden cell, so typing there would open an editor nobody can see. (A range keeps its hidden
    // lines, and setSelection moves only its active cell onto a shown one.)
    const single = range.r1 === range.r2 && range.c1 === range.c2;
    const shown = single && (rowHidden(s, range.r1) || s.hiddenCols.has(range.c1)) ? visibleTarget({ r: range.r1, c: range.c1 }, 1, 1) : null;
    setSelection(shown ? S.single(shown.r, shown.c) : S.fromRange(range, { r: range.r1, c: range.c1 }), { scrollActive: true });
    return true;
  }

  function rememberSheetSelection() {
    const ranges = [...extras, S.selRange(sel, true)].map(r => ({ ...r,
      r2: ['columns', 'sheet'].includes(r.scope) ? MAX_ROW : r.r2,
      c2: ['rows', 'sheet'].includes(r.scope) ? MAX_COL : r.c2,
    }));
    wb.setSheetSelection(sheetId, { active: sel.active, ranges, activeRange: extras.length });
  }

  function savedSheetSelection() {
    const saved = sheet()?.viewSelection;
    if (!saved) return null;
    // Whole-row/column selections cover the current grid without allocating
    // a million empty rows just because Excel saved A1:A1048576.
    const ranges = saved.ranges.map(r => ({ ...r,
      ...(r.r1 === 0 && r.r2 === MAX_ROW ? { scope: r.c1 === 0 && r.c2 === MAX_COL ? 'sheet' : 'columns' }
        : r.c1 === 0 && r.c2 === MAX_COL ? { scope: 'rows' } : {}),
      r2: r.r1 === 0 && r.r2 === MAX_ROW ? sheet().rows - 1 : r.r2,
      c2: r.c1 === 0 && r.c2 === MAX_COL ? sheet().cols - 1 : r.c2,
    }));
    return { sel: S.fromRange(ranges[saved.activeRange], saved.active),
      extras: ranges.filter((_, i) => i !== saved.activeRange) };
  }

  measureChrome();
  rebuildOffsets();
  const initialSelection = savedSheetSelection();
  extras = initialSelection?.extras || [];
  setSelection(initialSelection?.sel || S.single(0, 0), { scroll: false, announce: false, add: true, grow: false });

  return {
    el: root,
    viewport,
    get sheetId() { return sheetId; },
    get selection() { return sel; },
    get range() { return S.selRange(sel); },
    /** Every selected range: those added with Ctrl/Cmd+click, then the current one. */
    get ranges() { return [...extras.map(({ scope, ...range }) => range), S.selRange(sel)]; },
    /** Formatting needs the header intent as well as its current visible box. */
    get formatRanges() { return [...extras, S.selRange(sel, true)]; },
    /** Select several ranges at once; the last one holds the active cell. */
    setRanges(ranges, active = null) {
      if (!ranges.length) return;
      extras = [];
      for (const rg of ranges.slice(0, -1)) addRange(rg);
      const last = ranges[ranges.length - 1];
      setSelection(S.fromRange(last, active || { r: last.r1, c: last.c1 }), { add: true });
    },
    get active() { return sel.active; },
    get editing() { return !!edit; },
    get editState() { return edit ? { ...edit } : null; },
    get keyMode() { return keyMode; },
    /** Show the printed pages over the sheet (Page Break Preview), or null for the normal view. */
    setPageView(view) { pageView = view; renderPages(); },
    /**
     * Show the sheet as printed pages (Page Layout view), or null for the normal layout. The provider
     * gives each sheet's page metrics ({ paperWidth, paperHeight, margins, gap, scale, colStarts,
     * rowStarts }, in unzoomed pixels) and draws the paper, its header and footer, and the rulers.
     */
    setPageLayout(provider) {
      if (provider === pageLayout) return;
      ensureOffsets();
      const topRow = rowOffsets.indexAt(viewport.scrollTop - shift.y + frozen.h), leftCol = colOffsets.indexAt(viewport.scrollLeft - shift.x + frozen.w);
      pageLayout = provider || null;
      root.classList.toggle('page-layout', !!pageLayout);
      applyOutlineGutter();
      rebuildOffsets();
      if (!pageGeo && paperLayer.childElementCount) paperLayer.replaceChildren();
      rendered.key = null;
      // The cell that was at the top left stays in view: in Page Layout view, with its page's top and left edges.
      const pageOf = (pages, i) => pages.find((p) => i >= p.start && i <= p.end);
      scrollViewportTo(pageGeo ? Math.max(0, (pageOf(pageGeo.cols, leftCol)?.origin ?? 0) - 4) : Math.max(0, colOffsets.at(leftCol) - frozen.w),
        pageGeo ? Math.max(0, (pageOf(pageGeo.rows, topRow)?.origin ?? 0) - 4) : Math.max(0, rowOffsets.at(topRow) - frozen.h));
      schedule();
    },
    get pageLayout() { return !!pageGeo; },
    setSheet,
    setSelection: (next, o) => setSelection(next, o),
    /** Select all as Ctrl+A does: the block of data around the active cell, then the whole sheet. */
    selectAll: selectAllStep,
    selectByName,
    beginEdit,
    setEditText,
    setFormulaInput(input) { formulaInput = input; },
    handleEditKey: editorKeyDown,
    /** The formula bar's caret moved: the same bookkeeping as for the cell editor's own caret. */
    updateEditHints: caretMoved,
    commitEdit,
    cancelEdit,
    insertRef,
    acceptsRef,
    insertText(text) {
      // Insert at the caret of the current edit (in the cell or the formula bar, whichever is
      // being typed in), or start one with the text.
      if (!edit) { beginEdit({ text, mode: 'inplace' }); return; }
      const input = editInput();
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      const next = `${input.value.slice(0, a)}${text}${input.value.slice(b)}`;
      input.value = next;
      input.setSelectionRange(a + text.length, a + text.length);
      setEditText(next, { fromEditor: input === editor });
      input.focus({ preventScroll: true });
    },
    /** Focus the grid: the cell being edited while an edit is open, otherwise the cells. */
    focus() { if (!validationPending) (edit ? editor : viewport).focus({ preventScroll: true }); },
    focusEditor() { if (edit && !validationPending) editor.focus({ preventScroll: true }); },
    refresh() { rebuildOffsets(); rendered.key = null; schedule(); },
    setHighlights(cells, current = -1) { highlights = { cells, current }; renderHighlights(visibleRange()); schedule(); },
    /** Outline the cells cut on the sheet shown (null ends it): the box shows while that sheet is on screen. */
    setCutRange(range) { cutRange = range ? { sheetId, range: normalizeRange(range) } : null; renderCutRange(); schedule(); },
    get indentUnit() { return indentUnit(); },
    get frozen() { ensureOffsets(); return { rows: frozen.rows ? frozen.rows - frozen.r0 : 0, cols: frozen.cols ? frozen.cols - frozen.c0 : 0 }; },
    /** View ▸ Split: split the window at the active cell, or remove the split. */
    toggleSplit,
    /** The split window as drawn: the bars' places in pixels and the panes' scroll, or null. */
    get split() { ensureOffsets(); return frozen.split ? { x: frozen.w, y: frozen.h, sl: frozen.sl, st: frozen.st, pane: { ...splitPane } } : null; },
    /** Scroll a split window's top and left panes (testing and automation). */
    scrollSplitPanes,
    get zoom() { return userZoom; },
    setZoom,
    get selectedChart() { return selectedChart; },
    selectChart,
    /** Ink: the canvas point (zoomed pixels, as objects are laid out) under a client point; a frozen pane has not scrolled. */
    canvasPoint(clientX, clientY) {
      const vp = viewport.getBoundingClientRect(), vx = clientX - vp.left, vy = clientY - vp.top;
      return { x: vx < frozen.w ? vx : vx + viewport.scrollLeft, y: vy < frozen.h ? vy : vy + viewport.scrollTop };
    },
    /** Ink: the cell an object with its top-left corner at canvas point (x, y) is anchored to, and its offset there at 100%. */
    placeAt(x, y) {
      ensureOffsets();
      const s = sheet(), r = clamp(rowOffsets.indexAt(Math.max(0, y)), 0, s.rows - 1), c = clamp(colOffsets.indexAt(Math.max(0, x)), 0, s.cols - 1);
      return { anchor: { r, c }, dx: (x - colX(c)) / zoom, dy: (y - rowY(r)) / zoom };
    },
    /** Ink: an object's box in canvas pixels. */
    chartRect(id) { const ch = sheet()?.charts.find(o => o.id === id); return ch ? chartBoxRect(ch) : null; },
    get showFormulas() { return showFormulas; },
    setShowFormulas(on) { showFormulas = !!on; root.classList.toggle('show-formulas', showFormulas); rendered.key = null; schedule(); },
    get showHeaders() { return showHeaders; },
    get spellcheck() { return spellcheck; },
    /** Draw every visible cell again (after a display setting such as the regional format changes). */
    redraw() { rendered.key = null; schedule(); },
    /** Check spelling while typing text (formulas are never checked). */
    setSpellcheck(on) { spellcheck = !!on; if (edit) editor.spellcheck = spellcheck && !edit.text.startsWith('='); },
    /** Show or hide the row numbers and column letters. */
    setShowHeaders(on) { wb.setHeaders(sheetId, on); },
    autoFitRows,
    /**
     * Fit the rows of wrapped text in `cols` to their new widths; `before` (column → width) is what
     * each row was fitted for. Called from inside the transaction that wrote the widths, the heights
     * join its undo step, as the grid's own resizes already do. The columns are recorded as fitted
     * for the widths they now hold, so the layout event that transaction ends with finds nothing
     * changed and does not fit them a second time.
     */
    refitWrappedRows: (cols, before = null) => {
      if (!sheet() || !cols?.length) return;
      invalidateOffsets(); // the widths just written are not laid out yet; the fit reads the workbook's
      refitWrappedRows([...cols], before);
    },
    consumePlainPaste() { const v = plainPaste; plainPaste = false; return v; },
    cellRect,
    cellAtPoint,
    isHidden(axis, i) { const s = sheet(); return axis === 'row' ? s.hiddenRows.has(i) : s.hiddenCols.has(i); },
    scrollToActive({ avoid } = {}) { scrollIntoView(sel.active); return avoid ? revealBeside(avoid) : true; },
    refToText,
    destroy() {
      validationPending = null;
      destroyed = true;
      cancelAnimationFrame(rafId);
      staleChartsIdle?.();
      ro?.disconnect();
      document.fonts?.removeEventListener('loadingdone', fontsLoaded);
      wb.removeEventListener('change', onWorkbookChange);
      // A drag, a long press or an edit in flight must not act on a grid that is gone: its release still reaches the viewport.
      cancelDrag();
      edit = null;
    },
  };
}
