import { sheetFilters } from '../core/sheet-filters.js';
/**
 * Bottom strip: a summary of the selection (sum, average, count) when more
 * than one cell is selected, otherwise the sheet's size. Also the live
 * region every selection change is announced through.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { cellName, cellKey } from '../core/cell.js';
import { isSingle } from '../core/selection.js';
import { selectionName } from '../core/refs.js';
import { formatGeneral, formatValue, errorHelp } from '../core/format.js';
import { isError } from '../core/formula/functions.js';
import { meanFromSum, sumFromTotal } from '../core/numeric.js';
import { checkAccessibility } from '../core/accessibility-check.js';
import { pageLayoutMetrics, pageNumber } from './page-layout.js';
import { t, tRich } from '../i18n/index.js';

// The most cells one summary reads: the stored cells (and spilled values) inside the selection, never
// its area, so a whole column or the whole sheet costs what the sheet holds. Two hundred thousand
// plain values read in a few tens of milliseconds, about what a selection change can spend.
const MAX_SUMMARY_CELLS = 200000;
// Totals read in the selection's own number format; dates,
// times, and text formats would only mislead for a sum.
const NUMERIC_FORMATS = new Set(['number', 'currency', 'percent', 'scientific']);
const numericStyle = (style) => (style && NUMERIC_FORMATS.has(style.fmt) ? style : null);

/** Match the grid's number format, including a spilled result's anchor and destination overrides. */
function numericStyleAt(wb, sheet, r, c) {
  const cell = sheet.cells.get(cellKey(r, c));
  const spill = !cell || (cell.v == null && cell.f == null) ? wb.spillAt(sheet.id, r, c) : null;
  const line = wb._lineStyle(sheet, r, c);
  return numericStyle(line || spill ? { ...line, ...spill?.style, ...cell?.s } : cell?.s);
}

// A stored value with no formula is the cell's own; only formulas (and fixed arrays) need the workbook.
const valueOf = (wb, sheetId, r, c, cell) => (cell.f == null && !cell.array ? cell.v : wb.getValue(sheetId, r, c));

/** Visit the stored cells inside a range: cell by cell when the range is smaller than the sheet's cell map, else one pass over the map. */
function eachStored(sheet, { r1, c1, r2, c2 }, visit) {
  if ((r2 - r1 + 1) * (c2 - c1 + 1) < sheet.cells.size) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const cell = sheet.cells.get(cellKey(r, c)); if (cell) visit(r, c, cell); }
    return;
  }
  for (const [key, cell] of sheet.cells) {
    const i = key.indexOf(',');
    const r = Number(key.slice(0, i));
    if (r < r1 || r > r2) continue;
    const c = Number(key.slice(i + 1));
    if (c < c1 || c > c2) continue;
    visit(r, c, cell);
  }
}

// Only traversed when a summary sum overflowed. Range sizes were already
// checked by summarize; overlapping selections retain their usual counts.
// Rows a filter hides are out of the picture. Like the summary, it reads the
// stored cells and spilled values, not every position of a whole-column range.
function* selectedNumbers(wb, sheetId, ranges) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return;
  const hidden = sheet.filterHidden || null;
  for (const range of ranges) {
    const values = [];
    eachStored(sheet, range, (r, c, cell) => {
      if (cell.v == null && cell.f == null) return;
      if (hidden?.has(r)) return;
      const v = valueOf(wb, sheetId, r, c, cell);
      if (typeof v === 'number') values.push(v);
    });
    yield* values;
    for (const { r, c, value: v } of wb.spillEntries(sheetId, range)) {
      if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2 || hidden?.has(r)) continue;
      if (typeof v === 'number') yield v;
    }
  }
}

function rawSummary(wb, sheetId, range) {
  const { r1, c1, r2, c2 } = range;
  const total = (r2 - r1 + 1) * (c2 - c1 + 1);
  const sheet = wb.sheet(sheetId);
  if (!sheet) return null;
  // The scan walks the selection cell by cell, or the sheet's cells (and spilled
  // values) when there are fewer of those: selecting the whole sheet costs what
  // the sheet holds, not its area, so Ctrl+A still gets its Sum and Count. Only the
  // values spilled into the selection are listed, once they are known to be few: an
  // array over the whole sheet spills more than any list holds.
  if (Math.min(total, sheet.cells.size + wb.spillCount(sheetId, range)) > MAX_SUMMARY_CELLS) return null;
  const spills = wb.spillEntries(sheetId, range);
  let sum = 0;
  let nums = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let style = null; // the top-left formatted number's style
  let styleAt = null;
  const hidden = sheet.filterHidden;
  // A format set on a whole column or row lives on the line, not on its cells, so the format a cell
  // shows is its column's, then its row's, then its own (Workbook.styleAt): a total over a currency
  // column read 1234.5 where every cell of it read $1,234.50. Asked only where the sheet has such a
  // format — two sizes read once per range — so summarising an ordinary selection, which happens on
  // every selection change, looks nothing up beyond the cells it already walks.
  const lines = wb.normalStyle || sheet.colStyles.size > 0 || sheet.rowStyles.size > 0 || sheet.styleResets.length > 0;
  const tally = (r, c, cell) => {
    if (cell.v == null && cell.f == null) return;
    if (hidden?.has(r)) return;
    const v = valueOf(wb, sheetId, r, c, cell);
    if (v == null || v === '') return;
    count++;
    if (typeof v === 'number' && !isError(v)) {
      sum += v; nums++; if (v < min) min = v; if (v > max) max = v;
      // Formats are read only where a number could still be the top-left one.
      if (!styleAt || r < styleAt.r || (r === styleAt.r && c < styleAt.c)) {
        const st = numericStyle(lines ? wb.styleAt(sheetId, r, c) : cell.s);
        if (st) { style = st; styleAt = { r, c }; }
      }
    }
  };
  // Look the selection up cell by cell when it is smaller than the sheet's
  // cell map, so arrowing around a large sheet does not rescan every cell.
  eachStored(sheet, range, tally);
  for (const { r, c, value: v } of spills) {
    if (r < r1 || r > r2 || c < c1 || c > c2 || v == null || v === '' || hidden?.has(r)) continue;
    count++;
    if (typeof v === 'number' && !isError(v)) {
      sum += v; nums++; if (v < min) min = v; if (v > max) max = v;
      // Stored cells and spill results are visited separately. Choose by position, and stop reading
      // formats once a later spill cannot replace the first formatted number already found.
      if (!styleAt || r < styleAt.r || (r === styleAt.r && c < styleAt.c)) {
        const st = numericStyleAt(wb, sheet, r, c);
        if (st) { style = st; styleAt = { r, c }; }
      }
    }
  }
  return { sum, count, nums, avg: nums ? meanFromSum(sum, nums, selectedNumbers(wb, sheetId, [range])) : null, min: nums ? min : null, max: nums ? max : null, ...(style ? { style } : {}) };
}

export function summarize(wb, sheetId, range) {
  const summary = rawSummary(wb, sheetId, range);
  return summary ? { ...summary, sum: sumFromTotal(summary.sum, selectedNumbers(wb, sheetId, [range])) } : null;
}

/** The summary of several ranges together (cells in more than one range count once per range). */
export function summarizeAll(wb, sheetId, ranges) {
  const out = { sum: 0, count: 0, nums: 0, min: Infinity, max: -Infinity };
  for (const range of ranges) {
    const s = rawSummary(wb, sheetId, range);
    if (!s) return null;
    out.sum += s.sum; out.count += s.count; out.nums += s.nums;
    if (s.nums) { out.min = Math.min(out.min, s.min); out.max = Math.max(out.max, s.max); }
    if (s.style && !out.style) out.style = s.style;
  }
  return { ...out, sum: sumFromTotal(out.sum, selectedNumbers(wb, sheetId, ranges)), avg: out.nums ? meanFromSum(out.sum, out.nums, selectedNumbers(wb, sheetId, ranges)) : null, min: out.nums ? out.min : null, max: out.nums ? out.max : null };
}

/** What the status bar shows, as chosen from its right-click menu (Customize Status Bar). */
const PREFS_KEY = 'spreadsheet:status-bar';
// Each item: its id (the key it is remembered by), the catalog key of its label, and whether it is on by default.
export const STATUS_OPTIONS = [
  ['mode', 'statusbar.option.cellMode', true], ['a11y', 'statusbar.option.accessibilityChecker', true], ['address', 'statusbar.option.selectionAddress', false], ['size', 'statusbar.option.sheetSize', false], ['avg', 'statusbar.option.average', true], ['count', 'statusbar.option.count', true], ['numCount', 'statusbar.option.numericalCount', false],
  ['min', 'statusbar.option.minimum', false], ['max', 'statusbar.option.maximum', false], ['sum', 'statusbar.option.sum', true], ['views', 'statusbar.option.viewShortcuts', true], ['zoomSlider', 'statusbar.option.zoomSlider', true], ['zoom', 'statusbar.option.zoom', true],
];
function loadStatusPrefs() {
  const prefs = Object.fromEntries(STATUS_OPTIONS.map(([key, , on]) => [key, on]));
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (saved && typeof saved === 'object') for (const [key] of STATUS_OPTIONS) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
  } catch { /* optional storage */ }
  return prefs;
}

/** The cell mode: Ready, Enter (typing over a cell), Edit (F2 or double-click) or Point (picking a reference). An id; cellModeLabel names it. */
export function cellMode(editState) {
  if (!editState) return 'Ready';
  if (editState.refInsert && String(editState.text || '').startsWith('=')) return 'Point';
  return editState.mode === 'type' ? 'Enter' : 'Edit';
}

const CELL_MODE_LABELS = { Ready: 'statusbar.mode.ready', Point: 'statusbar.mode.point', Enter: 'statusbar.mode.enter', Edit: 'statusbar.mode.edit' };
/** The cell mode as the bar shows it, in the interface language. */
export const cellModeLabel = (mode) => t(CELL_MODE_LABELS[mode] || CELL_MODE_LABELS.Ready);

const KEY_MODE_LABELS = { end: 'statusbar.keyMode.end', extend: 'statusbar.keyMode.extend', add: 'statusbar.keyMode.add' };

export function createStatusBar(ctx) {
  const prefs = loadStatusPrefs();
  const modeEl = el('span.status-item.status-mode', { title: t('statusbar.cellModeTitle') }, cellModeLabel('Ready'));
  // End Mode, Extend Selection (F8) and Add to Selection (Shift+F8), shown while they are on.
  const keyModeEl = el('span.status-item.status-key-mode', { hidden: true });
  // Under manual calculation, "Calculate" says results are waiting for F9.
  const calcEl = el('button.status-item.status-calc', { type: 'button', hidden: true, title: t('statusbar.calculateNowTitle'), onclick: () => ctx.run?.('recalc') }, t('statusbar.calculate'));
  // In Page Layout view, "Page: 2 of 5": the printed page the active cell is on.
  const pageEl = el('span.status-item.status-page', { hidden: true });
  let pageCache = null; // { key, metrics }: the page layout is measured once per workbook version and sheet
  const refreshPage = () => {
    const sid = ctx.sheetId();
    if ((ctx.viewMode?.() || 'normal') !== 'pageLayout' || !ctx.grid?.active) { pageEl.hidden = true; return; }
    const key = `${sid}|${ctx.wb.version}`;
    if (pageCache?.key !== key) pageCache = { key, metrics: pageLayoutMetrics(ctx.wb, sid) };
    const m = pageCache.metrics;
    if (!m) { pageEl.hidden = true; return; }
    const band = (list, i) => { let k = 0; while (k + 1 < list.length && list[k + 1] <= i) k++; return k; };
    const { r, c } = ctx.grid.active;
    const across = band(m.cols, c), down = band(m.rows, r);
    // A cell on a page above or left of the print area is on none of the printed pages: counted from the area's first,
    // it read "Page: 0" or less, or the number of another page. The bar names no page for it.
    if (across < m.printed.a0 || down < m.printed.d0) { pageEl.hidden = true; return; }
    const { number, pages } = pageNumber(m, across, down);
    pageEl.textContent = t('statusbar.page', { number, pages });
    pageEl.hidden = false;
  };
  // The accessibility checker, kept running while the workbook changes: "No issues" or "Review suggested".
  const a11yEl = el('button.status-item.status-a11y', { type: 'button', title: t('statusbar.checkAccessibility'), onclick: () => ctx.run?.('accessibility') },
    el('span.status-a11y-icon', { html: icon('accessibility', 15) }), el('span.status-a11y-text', {}, t('statusbar.a11y.noIssuesStatus')));
  let a11yVersion = -1, a11yTimer = null;
  let a11yInvestigate = false; // the checker found something to review (not only tips)
  const refreshAccessibility = () => {
    if (!prefs.a11y || ctx.wb.version === a11yVersion) return;
    clearTimeout(a11yTimer);
    // Inspecting reads every styled cell, so it waits for a pause in editing.
    a11yTimer = setTimeout(() => {
      a11yVersion = ctx.wb.version;
      // "Review suggested" when anything beyond a tip is found (accessibilityStatus), decided here from the
      // findings rather than from that status's words, so the label can be drawn in the interface language.
      const investigate = checkAccessibility(ctx.wb).some((f) => f.severity !== 'tip');
      a11yInvestigate = investigate;
      a11yEl.querySelector('.status-a11y-text').textContent = t(investigate ? 'statusbar.a11y.reviewStatus' : 'statusbar.a11y.noIssuesStatus');
      if (investigate !== a11yEl.classList.contains('investigate')) a11yEl.querySelector('.status-a11y-icon').innerHTML = icon(investigate ? 'accessibilityReview' : 'accessibility', 15);
      a11yEl.classList.toggle('investigate', investigate);
    }, a11yVersion < 0 ? 0 : 400);
  };
  const left = el('div.status-left');
  const right = el('div.status-right');
  const ZOOMS = [0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
  const zoomLabel = el('button.zoom-label', {
    type: 'button', title: t('statusbar.zoom'), 'aria-label': t('statusbar.zoomLevel'), 'aria-haspopup': 'menu',
    onclick: (e) => {
      const sheet = ctx.wb.sheet(ctx.sheetId());
      const current = Math.round(ctx.grid.zoom * 100) / 100;
      const levels = ZOOMS.includes(current) ? ZOOMS : [...ZOOMS, current].sort((a, b) => a - b);
      openMenu({
        anchor: e.currentTarget, align: 'end', label: t('statusbar.zoom'), minWidth: 120, focusChecked: true,
        items: [
          ...(sheet?.kind === 'chart' ? [
            { label: t('statusbar.fitChartToWindow'), checked: !!sheet.zoomToFit, radio: true, onSelect: () => ctx.run('zoomFit') },
            { separator: true },
          ] : []),
          // One zoom level of several is a radio item, not a checkbox.
          ...levels.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: !sheet?.zoomToFit && current === z, radio: true, onSelect: () => ctx.run('zoomTo', z) })),
          { separator: true },
          { label: t('statusbar.customZoom'), icon: 'zoomIn', onSelect: () => ctx.run('zoomCustom') },
          { label: t('statusbar.resetZoom'), icon: 'reset', onSelect: () => ctx.run('zoom', 'reset') },
        ],
        // After a choice the sheet takes focus back; after Escape or Tab the menu has put it on this button, and it stays there.
        onClose: (reason) => { if (reason === 'select') ctx.grid.focus(); },
      });
    },
  }, '100%');
  const zoomOut = el('button.zoom-btn', { type: 'button', 'aria-label': t('statusbar.zoomOut'), title: t('statusbar.zoomOut'), html: icon('minus', 14, 1.6), onclick: () => { if (zoomOut.getAttribute('aria-disabled') !== 'true') ctx.run('zoom', -0.1); } });
  const zoomIn = el('button.zoom-btn', { type: 'button', 'aria-label': t('statusbar.zoomIn'), title: t('statusbar.zoomIn'), html: icon('plus', 14, 1.6), onclick: () => { if (zoomIn.getAttribute('aria-disabled') !== 'true') ctx.run('zoom', 0.1); } });
  const zoomSlider = el('input.zoom-slider', {
    type: 'range', min: 10, max: 400, step: 1, value: 100,
    'aria-label': t('statusbar.worksheetZoom'), title: t('statusbar.zoomRange'),
    oninput: () => {
      const focused = document.activeElement === zoomSlider;
      ctx.run('zoomTo', Number(zoomSlider.value) / 100);
      // Editor commands return focus to the grid. A slider gesture needs to keep its
      // focus for subsequent arrow keys and native dragging.
      if (focused) zoomSlider.focus({ preventScroll: true });
    },
  });
  const zoomBox = el('div.zoom-box', { role: 'group', 'aria-label': t('statusbar.zoom') }, zoomOut, zoomSlider, zoomIn, zoomLabel);
  // Normal, Page Layout and Page Break Preview switch the sheet's view, in that order.
  const viewButton = (label, glyph, mode) => el('button.zoom-btn.status-view', {
    type: 'button', 'aria-label': label, title: label, html: icon(glyph, 15, 1.8),
    'aria-pressed': 'false', dataset: { mode }, onclick: () => ctx.run?.('viewMode', mode),
  });
  const views = el('div.status-views', { role: 'group', 'aria-label': t('statusbar.workbookViews') },
    viewButton(t('statusbar.view.normal'), 'normalView', 'normal'), viewButton(t('statusbar.view.pageLayout'), 'pageLayout', 'pageLayout'), viewButton(t('statusbar.view.pageBreakPreview'), 'pageBreak', 'pageBreak'));
  const live = el('div.visually-hidden', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  const root = el('div.status-bar', {}, el('div.status-left-wrap', {}, modeEl, pageEl, keyModeEl, calcEl, a11yEl, left), el('div.status-right-wrap', {}, right, views, zoomBox), live);
  function applyVisibility() {
    modeEl.hidden = !prefs.mode;
    a11yEl.hidden = !prefs.a11y;
    root.classList.toggle('show-address', !!prefs.address);
    root.classList.toggle('show-size', !!prefs.size);
    views.hidden = !prefs.views;
    zoomSlider.hidden = !prefs.zoomSlider; zoomOut.hidden = !prefs.zoomSlider; zoomIn.hidden = !prefs.zoomSlider;
    zoomLabel.hidden = !prefs.zoom;
    zoomBox.hidden = !prefs.zoomSlider && !prefs.zoom;
  }
  // Right-click chooses what the bar shows; each choice is remembered on this device. Every item reads its
  // current value beside it, shown or not, and the menu stays open so several can be switched in one go.
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const values = currentValues();
    openMenu({
      x: e.clientX, y: e.clientY, label: t('statusbar.customize'), minWidth: 260,
      items: [{ header: t('statusbar.customize') }, ...STATUS_OPTIONS.map(([key, label]) => ({
        label: t(label), checked: !!prefs[key], keepOpen: true, detail: values[key] ?? '', onSelect: () => {
          prefs[key] = !prefs[key];
          try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* optional storage */ }
          applyVisibility(); refresh();
        },
      }))],
    });
  });

  // The last summary, kept until the workbook changes or another range is selected: the bar refreshes on every
  // keystroke typed into a cell and every Tab or Enter that moves the active cell within the selection, and each
  // summing a large selection again held typing up (100 ms a key over 150,000 cells). Any change the workbook
  // announces, a recalculation included, counts.
  let stamp = 0, statsMemo = null;
  const onWorkbookChange = () => { stamp++; };
  ctx.wb.addEventListener?.('change', onWorkbookChange);

  /** The selection's statistics, formatted as the bar shows them (null for a single cell or a chart sheet). */
  function selectionStats() {
    const sheet = ctx.wb.sheet(ctx.sheetId());
    const sel = ctx.grid.selection;
    const ranges = ctx.grid.ranges || [ctx.grid.range];
    if (!sheet || sheet.kind === 'chart' || (isSingle(sel) && ranges.length === 1)) return null;
    const key = `${ctx.sheetId()}|${ctx.wb.version}|${stamp}|${(ranges.length === 1 ? [ctx.grid.range] : ranges).map(({ r1, c1, r2, c2 }) => `${r1},${c1},${r2},${c2}`).join(';')}`;
    if (statsMemo?.key !== key) statsMemo = { key, s: ranges.length === 1 ? summarize(ctx.wb, ctx.sheetId(), ctx.grid.range) : summarizeAll(ctx.wb, ctx.sheetId(), ranges) };
    const { s } = statsMemo;
    if (!s) return null;
    const style = s.nums ? numericStyleAt(ctx.wb, sheet, sel.active.r, sel.active.c) || s.style || null : null;
    return { s, fmt: style ? (n) => formatValue(n, style) : formatGeneral };
  }

  /** What each status bar item would show now, for the customize menu. */
  function currentValues() {
    const sheet = ctx.wb.sheet(ctx.sheetId());
    const ranges = ctx.grid.ranges || [ctx.grid.range];
    const out = {
      mode: cellModeLabel(cellMode(ctx.grid.editState)),
      a11y: t(a11yInvestigate ? 'statusbar.a11y.review' : 'statusbar.a11y.noIssues'),
      address: ranges.length === 1 ? (isSingle(ctx.grid.selection) ? cellName(ctx.grid.selection.active.r, ctx.grid.selection.active.c) : selectionName(ctx.grid.range)) : t('statusbar.ranges', { count: ranges.length }),
      size: sheet && sheet.kind !== 'chart' ? t('statusbar.sheetSizeValue', { rows: sheet.rows, cols: sheet.cols }) : '',
      zoom: `${Math.round(ctx.grid.zoom * 100)}%`,
    };
    const stats = selectionStats();
    if (stats) {
      const { s, fmt } = stats;
      out.count = String(s.count);
      out.numCount = String(s.nums);
      if (s.nums) { out.avg = fmt(s.avg); out.sum = fmt(s.sum); out.min = fmt(s.min); out.max = fmt(s.max); }
    }
    return out;
  }
  applyVisibility();

  let liveTimer = null;
  function announce(text) {
    // Debounce so arrowing quickly does not queue a dozen announcements.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = ''; live.textContent = text; }, 120);
  }

  function refresh() {
    modeEl.textContent = cellModeLabel(cellMode(ctx.grid.editState));
    refreshAccessibility();
    refreshPage();
    const keyMode = KEY_MODE_LABELS[ctx.grid.keyMode] ? t(KEY_MODE_LABELS[ctx.grid.keyMode]) : '';
    keyModeEl.textContent = keyMode;
    keyModeEl.hidden = !keyMode;
    calcEl.hidden = !(ctx.wb.calcMode === 'manual' && ctx.wb.calcPending);
    const view = ctx.viewMode?.() || 'normal';
    for (const b of views.querySelectorAll('[data-mode]')) if (b.dataset.mode) b.setAttribute('aria-pressed', String(b.dataset.mode === view));
    zoomSlider.value = Math.round(ctx.grid.zoom * 100);
    zoomSlider.setAttribute('aria-valuetext', `${Math.round(ctx.grid.zoom * 100)}%`);
    zoomLabel.textContent = `${Math.round(ctx.grid.zoom * 100)}%`;
    zoomLabel.setAttribute('aria-label', t('statusbar.zoomLevelValue', { value: zoomLabel.textContent })); // the spoken name carries the shown value
    // Keep focus on the last-used control at a limit, while clearly exposing that it cannot step
    // farther. Fit mode may still be left by either control even when the stored scale is a limit.
    const fit = !!ctx.wb.sheet(ctx.sheetId())?.zoomToFit;
    zoomOut.setAttribute('aria-disabled', String(!fit && ctx.grid.zoom <= 0.1));
    zoomIn.setAttribute('aria-disabled', String(!fit && ctx.grid.zoom >= 4));
    zoomOut.title = !fit && ctx.grid.zoom <= 0.1 ? t('statusbar.minimumZoom') : t('statusbar.zoomOut');
    zoomIn.title = !fit && ctx.grid.zoom >= 4 ? t('statusbar.maximumZoom') : t('statusbar.zoomIn');
    const range = ctx.grid.range;
    const ranges = ctx.grid.ranges || [range];
    const sel = ctx.grid.selection;
    const sheet = ctx.wb.sheet(ctx.sheetId());
    if (!sheet) return;
    if (sheet.kind === 'chart') {
      left.replaceChildren(el('span.status-item', {}, sheet.name));
      right.replaceChildren(el('span.status-item.muted', {}, t('statusbar.chartSheet')));
      if (sheet.zoomToFit) { zoomLabel.textContent = t('statusbar.fit'); zoomLabel.setAttribute('aria-label', t('statusbar.zoomFitLabel')); }
      return;
    }
    const filtered = sheet.filterHidden?.size || 0;
    // Several table filters can cover the same physical rows; count their union once.
    let filterRows = 0, end = -1;
    for (const { range } of sheetFilters(sheet).filter(f => Object.keys(f.criteria).length).sort((a, b) => a.range.r1 - b.range.r1)) {
      const last = Math.min(range.r2, sheet.rows - 1);
      filterRows += Math.max(0, last - Math.max(end, range.r1));
      end = Math.max(end, last);
    }
    const filterNote = filtered ? el('span.status-item.muted', {}, t('statusbar.rowsShown', { shown: filterRows - filtered, total: filterRows })) : null;
    if (isSingle(sel) && ranges.length === 1) {
      const cell = ctx.activeCell();
      const value = ctx.wb.getValue(ctx.sheetId(), sel.active.r, sel.active.c);
      const error = value && typeof value === 'object' && value.error ? value.error : null;
      // An error that came with its own reason (an import that failed) shows that; the rest are explained from the formula.
      const help = error ? (typeof value.message === 'string' && value.message) || ctx.wb.errorHelpAt(ctx.sheetId(), sel.active.r, sel.active.c) || errorHelp(error) : null;
      left.replaceChildren(...[
        el('span.status-item.status-address', {}, cellName(sel.active.r, sel.active.c)),
        cell?.f != null && !error && el('span.status-item.muted', {}, t('statusbar.formula')),
        ctx.wb.tableAt(ctx.sheetId(), sel.active.r, sel.active.c) && el('span.status-item.muted', { title: t('statusbar.partOfTable') }, ctx.wb.tableAt(ctx.sheetId(), sel.active.r, sel.active.c).name),
        ctx.wb.protectedRangeAt(ctx.sheetId(), sel.active.r, sel.active.c) && el('span.status-item.muted', { title: ctx.wb.protectedRangeAt(ctx.sheetId(), sel.active.r, sel.active.c).description || t('statusbar.protectedRange') }, t('statusbar.protected')),
        error && el('span.status-item.status-error', { title: help }, help),
        filterNote,
      ].filter(Boolean));
      right.replaceChildren(el('span.status-item.muted.status-size', {}, t('statusbar.sheetSize', { rows: sheet.rows, cols: sheet.cols })));
      return;
    }
    // Whole columns read C:C and whole rows 3:5, as the Name Box reads them, rather than C1:C1048576.
    const items = [el('span.status-item.status-address', {}, ranges.length === 1 ? selectionName(range) : ranges.length <= 3 ? ranges.map(selectionName).join(', ') : t('statusbar.ranges', { count: ranges.length }))];
    // The statistics stand at the right, in this order: Average, Count, Numerical Count, Minimum, Maximum, Sum.
    const stats = [];
    // Each statistic is one message, "<label>Average: </label>{value}", its label part muted.
    const label = (text) => el('span.muted', {}, text);
    const stat = (parts, extra = '') => el(`span.status-item.status-stat${extra}`, {}, ...parts);
    const summary = selectionStats();
    // A selection of empty cells shows no statistics at all, as in Excel, rather than "Count: 0".
    if (summary?.s.count) {
      const { s, fmt } = summary;
      if (s.nums && prefs.avg) stats.push(stat(tRich('statusbar.stat.average', { label, value: fmt(s.avg) })));
      if (prefs.count) stats.push(stat(tRich('statusbar.stat.count', { label, value: String(s.count) })));
      if (prefs.numCount) stats.push(stat(tRich('statusbar.stat.numericalCount', { label, value: String(s.nums) })));
      if (s.nums > 1 && prefs.min) stats.push(stat(tRich('statusbar.stat.minimum', { label, value: fmt(s.min) }), '.status-extra'));
      if (s.nums > 1 && prefs.max) stats.push(stat(tRich('statusbar.stat.maximum', { label, value: fmt(s.max) }), '.status-extra'));
      if (s.nums && prefs.sum) stats.push(stat(tRich('statusbar.stat.sum', { label, value: fmt(s.sum) })));
    }
    if (filterNote) items.push(filterNote);
    // Laid out from the Sum leftward (editor.css), so a narrow bar leaves out the first ones rather than cutting one off.
    stats.forEach((item, i) => { item.style.order = String(stats.length - i); });
    left.replaceChildren(...items);
    right.replaceChildren(...stats);
  }

  const unsubscribe = ctx.subscribe(refresh);
  refresh();
  return { el: root, refresh, announce, destroy: () => { clearTimeout(a11yTimer); unsubscribe(); ctx.wb.removeEventListener?.('change', onWorkbookChange); } };
}
