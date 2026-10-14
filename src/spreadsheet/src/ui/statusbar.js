import { sheetFilters } from '../core/sheet-filters.js';
/**
 * Bottom strip: a summary of the selection (sum, average, count) when more
 * than one cell is selected, otherwise the sheet's size. Also the live
 * region every selection change is announced through.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { rangeName, cellName, cellKey } from '../core/cell.js';
import { isSingle } from '../core/selection.js';
import { formatGeneral, formatValue, errorHelp } from '../core/format.js';
import { isError } from '../core/formula/functions.js';
import { meanFromSum, sumFromTotal } from '../core/numeric.js';
import { checkAccessibility, accessibilityStatus } from '../core/accessibility-check.js';
import { pageLayoutMetrics, pageNumber } from './page-layout.js';

const MAX_SUMMARY_CELLS = 20000;
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

// Only traversed when a summary sum overflowed. Range sizes were already
// checked by summarize; overlapping selections retain their usual counts.
// Rows a filter hides are out of the picture.
const filteredOut = (wb, sheetId) => wb.sheet(sheetId)?.filterHidden || null;

function* selectedNumbers(wb, sheetId, ranges) {
  const hidden = filteredOut(wb, sheetId);
  for (const { r1, c1, r2, c2 } of ranges) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      if (hidden?.has(r)) continue;
      const v = wb.getValue(sheetId, r, c);
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
  // the sheet holds, not its area, so Ctrl+A still gets its Sum and Count.
  const spills = wb.spillEntries(sheetId);
  if (Math.min(total, sheet.cells.size + spills.length) > MAX_SUMMARY_CELLS) return null;
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
    const v = wb.getValue(sheetId, r, c);
    if (v == null || v === '') return;
    count++;
    if (typeof v === 'number' && !isError(v)) {
      sum += v; nums++; if (v < min) min = v; if (v > max) max = v;
      const st = numericStyle(lines ? wb.styleAt(sheetId, r, c) : cell.s);
      if (st && (!styleAt || r < styleAt.r || (r === styleAt.r && c < styleAt.c))) { style = st; styleAt = { r, c }; }
    }
  };
  // Look the selection up cell by cell when it is smaller than the sheet's
  // cell map, so arrowing around a large sheet does not rescan every cell.
  if (total < sheet.cells.size) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const cell = sheet.cells.get(cellKey(r, c)); if (cell) tally(r, c, cell); }
  } else {
    for (const [key, cell] of sheet.cells) {
      const i = key.indexOf(',');
      const r = Number(key.slice(0, i));
      const c = Number(key.slice(i + 1));
      if (r < r1 || r > r2 || c < c1 || c > c2) continue;
      tally(r, c, cell);
    }
  }
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
export const STATUS_OPTIONS = [
  ['mode', 'Cell Mode', true], ['a11y', 'Accessibility Checker', true], ['address', 'Selection Address', false], ['size', 'Sheet Size', false], ['avg', 'Average', true], ['count', 'Count', true], ['numCount', 'Numerical Count', false],
  ['min', 'Minimum', false], ['max', 'Maximum', false], ['sum', 'Sum', true], ['views', 'View Shortcuts', true], ['zoomSlider', 'Zoom Slider', true], ['zoom', 'Zoom', true],
];
function loadStatusPrefs() {
  const prefs = Object.fromEntries(STATUS_OPTIONS.map(([key, , on]) => [key, on]));
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (saved && typeof saved === 'object') for (const [key] of STATUS_OPTIONS) if (typeof saved[key] === 'boolean') prefs[key] = saved[key];
  } catch { /* optional storage */ }
  return prefs;
}

/** The cell mode: Ready, Enter (typing over a cell), Edit (F2 or double-click) or Point (picking a reference). */
export function cellMode(editState) {
  if (!editState) return 'Ready';
  if (editState.refInsert && String(editState.text || '').startsWith('=')) return 'Point';
  return editState.mode === 'type' ? 'Enter' : 'Edit';
}

export function createStatusBar(ctx) {
  const prefs = loadStatusPrefs();
  const modeEl = el('span.status-item.status-mode', { title: 'Cell mode' }, 'Ready');
  // End Mode, Extend Selection (F8) and Add to Selection (Shift+F8), shown while they are on.
  const keyModeEl = el('span.status-item.status-key-mode', { hidden: true });
  // Under manual calculation, "Calculate" says results are waiting for F9.
  const calcEl = el('button.status-item.status-calc', { type: 'button', hidden: true, title: 'Calculate now (F9)', onclick: () => ctx.run?.('recalc') }, 'Calculate');
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
    const { number, pages } = pageNumber(m, band(m.cols, c), band(m.rows, r));
    pageEl.textContent = `Page: ${number} of ${pages}`;
    pageEl.hidden = false;
  };
  // The accessibility checker, kept running while the workbook changes: "No issues" or "Review suggested".
  const a11yEl = el('button.status-item.status-a11y', { type: 'button', title: 'Check Accessibility', onclick: () => ctx.run?.('accessibility') },
    el('span.status-a11y-icon', { html: icon('accessibility', 15) }), el('span.status-a11y-text', {}, 'Accessibility: No issues'));
  let a11yVersion = -1, a11yTimer = null;
  const refreshAccessibility = () => {
    if (!prefs.a11y || ctx.wb.version === a11yVersion) return;
    clearTimeout(a11yTimer);
    // Inspecting reads every styled cell, so it waits for a pause in editing.
    a11yTimer = setTimeout(() => {
      a11yVersion = ctx.wb.version;
      const status = accessibilityStatus(checkAccessibility(ctx.wb));
      a11yEl.querySelector('.status-a11y-text').textContent = `Accessibility: ${status}`;
      a11yEl.classList.toggle('investigate', status !== 'No issues');
    }, a11yVersion < 0 ? 0 : 400);
  };
  const left = el('div.status-left');
  const right = el('div.status-right');
  const ZOOMS = [0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
  const zoomLabel = el('button.zoom-label', {
    type: 'button', title: 'Zoom', 'aria-label': 'Zoom level', 'aria-haspopup': 'menu',
    onclick: (e) => {
      const sheet = ctx.wb.sheet(ctx.sheetId());
      const current = Math.round(ctx.grid.zoom * 100) / 100;
      const levels = ZOOMS.includes(current) ? ZOOMS : [...ZOOMS, current].sort((a, b) => a - b);
      openMenu({
        anchor: e.currentTarget, align: 'end', label: 'Zoom', minWidth: 120, focusChecked: true,
        items: [
          ...(sheet?.kind === 'chart' ? [
            { label: 'Fit chart to window', checked: !!sheet.zoomToFit, radio: true, onSelect: () => ctx.run('zoomFit') },
            { separator: true },
          ] : []),
          // One zoom level of several is a radio item, not a checkbox.
          ...levels.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: !sheet?.zoomToFit && current === z, radio: true, onSelect: () => ctx.run('zoomTo', z) })),
          { separator: true },
          { label: 'Custom zoom…', icon: 'zoomIn', onSelect: () => ctx.run('zoomCustom') },
          { label: 'Reset to 100%', icon: 'reset', onSelect: () => ctx.run('zoom', 'reset') },
        ],
        // After a choice the sheet takes focus back; after Escape or Tab the menu has put it on this button, and it stays there.
        onClose: (reason) => { if (reason === 'select') ctx.grid.focus(); },
      });
    },
  }, '100%');
  const zoomOut = el('button.zoom-btn', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', html: icon('minus', 14, 1.6), onclick: () => { if (zoomOut.getAttribute('aria-disabled') !== 'true') ctx.run('zoom', -0.1); } });
  const zoomIn = el('button.zoom-btn', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', html: icon('plus', 14, 1.6), onclick: () => { if (zoomIn.getAttribute('aria-disabled') !== 'true') ctx.run('zoom', 0.1); } });
  const zoomSlider = el('input.zoom-slider', {
    type: 'range', min: 10, max: 400, step: 1, value: 100,
    'aria-label': 'Worksheet zoom', title: 'Zoom: 10% to 400%',
    oninput: () => {
      const focused = document.activeElement === zoomSlider;
      ctx.run('zoomTo', Number(zoomSlider.value) / 100);
      // Editor commands return focus to the grid. A slider gesture needs to keep its
      // focus for subsequent arrow keys and native dragging.
      if (focused) zoomSlider.focus({ preventScroll: true });
    },
  });
  const zoomBox = el('div.zoom-box', { role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomSlider, zoomIn, zoomLabel);
  // Normal, Page Layout and Page Break Preview switch the sheet's view, in that order.
  const viewButton = (label, glyph, mode) => el('button.zoom-btn.status-view', {
    type: 'button', 'aria-label': label, title: label, html: icon(glyph, 15, 1.8),
    'aria-pressed': 'false', dataset: { mode }, onclick: () => ctx.run?.('viewMode', mode),
  });
  const views = el('div.status-views', { role: 'group', 'aria-label': 'Workbook views' },
    viewButton('Normal', 'normalView', 'normal'), viewButton('Page Layout', 'pageLayout', 'pageLayout'), viewButton('Page Break Preview', 'pageBreak', 'pageBreak'));
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
      x: e.clientX, y: e.clientY, label: 'Customize Status Bar', minWidth: 260,
      items: [{ header: 'Customize Status Bar' }, ...STATUS_OPTIONS.map(([key, label]) => ({
        label, checked: !!prefs[key], keepOpen: true, detail: values[key] ?? '', onSelect: () => {
          prefs[key] = !prefs[key];
          try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* optional storage */ }
          applyVisibility(); refresh();
        },
      }))],
    });
  });

  /** The selection's statistics, formatted as the bar shows them (null for a single cell or a chart sheet). */
  function selectionStats() {
    const sheet = ctx.wb.sheet(ctx.sheetId());
    const sel = ctx.grid.selection;
    const ranges = ctx.grid.ranges || [ctx.grid.range];
    if (!sheet || sheet.kind === 'chart' || (isSingle(sel) && ranges.length === 1)) return null;
    const s = ranges.length === 1 ? summarize(ctx.wb, ctx.sheetId(), ctx.grid.range) : summarizeAll(ctx.wb, ctx.sheetId(), ranges);
    if (!s) return null;
    const style = s.nums ? numericStyleAt(ctx.wb, sheet, sel.active.r, sel.active.c) || s.style || null : null;
    return { s, fmt: style ? (n) => formatValue(n, style) : formatGeneral };
  }

  /** What each status bar item would show now, for the customize menu. */
  function currentValues() {
    const sheet = ctx.wb.sheet(ctx.sheetId());
    const ranges = ctx.grid.ranges || [ctx.grid.range];
    const out = {
      mode: cellMode(ctx.grid.editState),
      a11y: a11yEl.querySelector('.status-a11y-text').textContent.replace(/^Accessibility: /, ''),
      address: ranges.length === 1 ? (isSingle(ctx.grid.selection) ? cellName(ctx.grid.selection.active.r, ctx.grid.selection.active.c) : rangeName(ctx.grid.range)) : `${ranges.length} ranges`,
      size: sheet && sheet.kind !== 'chart' ? `${sheet.rows.toLocaleString()} × ${sheet.cols}` : '',
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
    modeEl.textContent = cellMode(ctx.grid.editState);
    refreshAccessibility();
    refreshPage();
    const keyMode = { end: 'End Mode', extend: 'Extend Selection', add: 'Add to Selection' }[ctx.grid.keyMode] || '';
    keyModeEl.textContent = keyMode;
    keyModeEl.hidden = !keyMode;
    calcEl.hidden = !(ctx.wb.calcMode === 'manual' && ctx.wb.calcPending);
    const view = ctx.viewMode?.() || 'normal';
    for (const b of views.querySelectorAll('[data-mode]')) if (b.dataset.mode) b.setAttribute('aria-pressed', String(b.dataset.mode === view));
    zoomSlider.value = Math.round(ctx.grid.zoom * 100);
    zoomSlider.setAttribute('aria-valuetext', `${Math.round(ctx.grid.zoom * 100)}%`);
    zoomLabel.textContent = `${Math.round(ctx.grid.zoom * 100)}%`;
    zoomLabel.setAttribute('aria-label', `Zoom level: ${zoomLabel.textContent}`); // the spoken name carries the shown value
    // Keep focus on the last-used control at a limit, while clearly exposing that it cannot step
    // farther. Fit mode may still be left by either control even when the stored scale is a limit.
    const fit = !!ctx.wb.sheet(ctx.sheetId())?.zoomToFit;
    zoomOut.setAttribute('aria-disabled', String(!fit && ctx.grid.zoom <= 0.1));
    zoomIn.setAttribute('aria-disabled', String(!fit && ctx.grid.zoom >= 4));
    zoomOut.title = !fit && ctx.grid.zoom <= 0.1 ? 'Minimum zoom: 10%' : 'Zoom out';
    zoomIn.title = !fit && ctx.grid.zoom >= 4 ? 'Maximum zoom: 400%' : 'Zoom in';
    const range = ctx.grid.range;
    const ranges = ctx.grid.ranges || [range];
    const sel = ctx.grid.selection;
    const sheet = ctx.wb.sheet(ctx.sheetId());
    if (!sheet) return;
    if (sheet.kind === 'chart') {
      left.replaceChildren(el('span.status-item', {}, sheet.name));
      right.replaceChildren(el('span.status-item.muted', {}, 'Chart sheet'));
      if (sheet.zoomToFit) { zoomLabel.textContent = 'Fit'; zoomLabel.setAttribute('aria-label', 'Zoom: fit chart to window'); }
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
    const filterNote = filtered ? el('span.status-item.muted', {}, `${(filterRows - filtered).toLocaleString()} of ${filterRows.toLocaleString()} rows shown`) : null;
    if (isSingle(sel) && ranges.length === 1) {
      const cell = ctx.activeCell();
      const value = ctx.wb.getValue(ctx.sheetId(), sel.active.r, sel.active.c);
      const error = value && typeof value === 'object' && value.error ? value.error : null;
      // An error that came with its own reason (an import that failed) shows that; the rest are explained from the formula.
      const help = error ? (typeof value.message === 'string' && value.message) || ctx.wb.errorHelpAt(ctx.sheetId(), sel.active.r, sel.active.c) || errorHelp(error) : null;
      left.replaceChildren(...[
        el('span.status-item.status-address', {}, cellName(sel.active.r, sel.active.c)),
        cell?.f != null && !error && el('span.status-item.muted', {}, 'Formula'),
        ctx.wb.tableAt(ctx.sheetId(), sel.active.r, sel.active.c) && el('span.status-item.muted', { title: 'This cell is part of a table' }, ctx.wb.tableAt(ctx.sheetId(), sel.active.r, sel.active.c).name),
        ctx.wb.protectedRangeAt(ctx.sheetId(), sel.active.r, sel.active.c) && el('span.status-item.muted', { title: ctx.wb.protectedRangeAt(ctx.sheetId(), sel.active.r, sel.active.c).description || 'Protected range' }, 'Protected'),
        error && el('span.status-item.status-error', { title: help }, help),
        filterNote,
      ].filter(Boolean));
      right.replaceChildren(el('span.status-item.muted.status-size', {}, `${sheet.rows.toLocaleString()} rows, ${sheet.cols} columns`));
      return;
    }
    const items = [el('span.status-item.status-address', {}, ranges.length === 1 ? rangeName(range) : ranges.length <= 3 ? ranges.map(rangeName).join(', ') : `${ranges.length} ranges`)];
    // The statistics stand at the right, in this order: Average, Count, Numerical Count, Minimum, Maximum, Sum.
    const stats = [];
    const stat = (label, value, extra = '') => el(`span.status-item.status-stat${extra}`, {}, el('span.muted', {}, `${label}: `), value);
    const summary = selectionStats();
    if (summary) {
      const { s, fmt } = summary;
      if (s.nums && prefs.avg) stats.push(stat('Average', fmt(s.avg)));
      if (prefs.count) stats.push(stat('Count', String(s.count)));
      if (prefs.numCount) stats.push(stat('Numerical Count', String(s.nums)));
      if (s.nums > 1 && prefs.min) stats.push(stat('Minimum', fmt(s.min), '.status-extra'));
      if (s.nums > 1 && prefs.max) stats.push(stat('Maximum', fmt(s.max), '.status-extra'));
      if (s.nums && prefs.sum) stats.push(stat('Sum', fmt(s.sum)));
    }
    if (filterNote) items.push(filterNote);
    left.replaceChildren(...items);
    right.replaceChildren(...stats);
  }

  const unsubscribe = ctx.subscribe(refresh);
  refresh();
  return { el: root, refresh, announce, destroy: () => { clearTimeout(a11yTimer); unsubscribe(); } };
}
