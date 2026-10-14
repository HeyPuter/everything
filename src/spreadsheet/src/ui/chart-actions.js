/**
 * The chart commands behind Insert ▸ Charts, the Chart Design and Format tabs and the Format pane:
 * one entry point, `runChartAction(ctx, arg)`, so the editor's command switch needs one case.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { chartData } from '../core/charts.js';
import { normalizeRange } from '../core/cell.js';
import { DEFAULT_SUBTYPE, changeSubtypePatch, newExcelChart } from '../core/chart-subtypes.js';
import { chartElementPatch, chartStylePatch, colorsPatch, detachedChart, elementFormatPatch, quickLayoutPatch, switchRowColumnPatch } from '../core/chart-design.js';
import { effectiveFontTheme } from '../core/font-theme.js';
import { fontKeyFor } from '../core/format.js';
import { openChartTypeDialog } from './chart-type-dialog.js';
import { openSelectDataDialog } from './chart-select-data.js';

const DRAWN = new Set(['image', 'text', 'slicer', 'scroll', 'smartart']);
/** Is this object a chart (not a picture, text box, slicer or form control)? */
export const isChartObject = obj => !!obj && !DRAWN.has(obj.type);

/** The chart the Chart Design and Format tabs act on: the selected one, or a chart sheet's own. */
export function activeChart(ctx) {
  const sheetId = ctx.sheetId(), sheet = ctx.wb.sheet(sheetId);
  const id = ctx.grid?.selectedChart || (sheet?.kind === 'chart' ? sheet.charts.find(isChartObject)?.id : null);
  const chart = id ? ctx.wb.chartById(sheetId, id) : null;
  return isChartObject(chart) ? chart : null;
}

/** The theme's body font, which a new chart's text takes (Calibri in the default theme). */
export function themeChartFont(wb) {
  const name = effectiveFontTheme(wb.fontTheme)?.minor?.latin?.typeface || 'Calibri';
  return fontKeyFor(name, { literal: true }) || 'calibri';
}

export const seriesCountOf = (wb, sheetId, chart) => {
  const data = chartData(wb, sheetId, chart);
  return ['pie', 'donut'].includes(chart.type) ? data.categories.length : data.series.length;
};

/** Insert a chart of `subtype` over `range` beside the data, select it and show Chart Design. */
export function insertChart(ctx, subtype = DEFAULT_SUBTYPE, range = null) {
  const { wb } = ctx, sheetId = ctx.sheetId(), sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return null;
  const r = normalizeRange(range || ctx.dataRange?.(ctx.range()) || ctx.range());
  if (r.r2 - r.r1 + 1 > 5000 || r.c2 - r.c1 + 1 > 200) { toast('That range is too large to chart', { icon: 'info' }); return null; }
  const chart = newExcelChart(wb, sheetId, r, subtype, { font: themeChartFont(wb) });
  // A chart placed in the sheet's last rows grows the sheet to hold it, as the Insert chart dialog does.
  const rowsNeeded = chart.anchor.r + 1 + Math.ceil(chart.h / (sheet.defaultRowHeight || 20));
  if (rowsNeeded > sheet.rows) wb.ensureSize(sheetId, rowsNeeded, sheet.cols);
  if (chart.anchor.c >= sheet.cols) wb.ensureSize(sheetId, sheet.rows, chart.anchor.c + 1);
  const id = wb.addChart(sheetId, chart);
  if (!id) return null;
  ctx.grid.selectChart(id);
  ctx.chartUi?.setElement('chartArea');
  ctx.ribbon?.select?.('Chart Design');
  return id;
}

/** A free chart sheet name: Chart1, Chart2, … */
function chartSheetName(wb) {
  for (let i = 1; ; i++) if (!wb.sheetByName(`Chart${i}`)) return `Chart${i}`;
}

/** Put `chart` (detached from its data sheet) on a new chart sheet before `index`; returns the sheet. */
export function newChartSheet(wb, chart, name = chartSheetName(wb), index = wb.sheets.indexOf(wb.sheet(wb.activeSheetId))) {
  const sheet = wb.addSheet(name, Math.max(0, index));
  if (!sheet) return null;
  sheet.kind = 'chart';
  sheet.zoomToFit = true;
  wb.addChart(sheet.id, { ...chart, anchorMode: 'absolute', anchor: { r: 0, c: 0 }, dx: 0, dy: 0, w: 960, h: 640, cellAnchor: undefined });
  return sheet;
}

/** F11: the selection's data charted on a chart sheet of its own, before the active sheet. */
export function insertChartSheet(ctx, subtype = DEFAULT_SUBTYPE) {
  const { wb } = ctx, sheetId = ctx.sheetId();
  if (wb.sheet(sheetId)?.kind === 'chart') return null;
  const r = normalizeRange(ctx.dataRange?.(ctx.range()) || ctx.range());
  const chart = detachedChart(wb, sheetId, newExcelChart(wb, sheetId, r, subtype, { font: themeChartFont(wb) }));
  if (!chart.sourceRefs?.length) { toast('Select the data to chart first', { icon: 'info' }); return null; }
  let sheet = null;
  wb.transaction('Insert chart sheet', () => { sheet = newChartSheet(wb, chart); });
  return sheet;
}

/** Move Chart: to a new chart sheet, or as an object onto another sheet. */
export function moveChart(ctx, chart, { newSheet = null, toSheetId = null }) {
  const { wb } = ctx, fromId = ctx.sheetId();
  const detached = detachedChart(wb, fromId, chart);
  const { id, ...model } = detached;
  let moved = false;
  wb.transaction('Move chart', () => {
    if (newSheet != null) {
      const name = String(newSheet).trim() || chartSheetName(wb);
      const problem = wb.validateSheetName(name);
      if (problem) throw new Error(problem);
      const sheet = newChartSheet(wb, model, name, wb.sheets.indexOf(wb.sheet(fromId)));
      if (!sheet) return;
      wb.deleteChart(fromId, id);
      moved = true;
      return;
    }
    const target = wb.sheet(toSheetId);
    if (!target || target.id === fromId) return;
    const placed = target.kind === 'chart' ? { ...model, anchorMode: 'absolute', anchor: { r: 0, c: 0 }, dx: 0, dy: 0 }
      : { ...model, anchorMode: undefined, cellAnchor: undefined, anchor: { r: 1, c: 1 }, dx: 0, dy: 0, w: model.w || 480, h: model.h || 288 };
    const newId = wb.addChart(target.id, placed);
    if (!newId) return;
    // A chart sheet whose only chart leaves goes with it.
    const fromSheet = wb.sheet(fromId);
    if (fromSheet.kind === 'chart' && fromSheet.charts.filter(isChartObject).length === 1) wb.deleteSheet(fromId);
    else wb.deleteChart(fromId, id);
    wb.setActiveSheet(target.id);
    moved = newId;
  });
  return moved;
}

/** The Move Chart dialog. */
export function openMoveChartDialog(ctx, chart) {
  const { wb } = ctx;
  const newRadio = el('input', { type: 'radio', name: 'move-chart', value: 'sheet' });
  const objRadio = el('input', { type: 'radio', name: 'move-chart', value: 'object', checked: true });
  const nameInput = el('input.input', { type: 'text', value: chartSheetName(wb), 'aria-label': 'New sheet name', maxlength: 31 });
  const sheets = wb.sheets.filter(s => !s.hidden && !s.veryHidden);
  const select = el('select.input', { 'aria-label': 'Object in' }, ...sheets.map(s => el('option', { value: s.id, selected: s.id === ctx.sheetId() }, s.name)));
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const sync = () => { nameInput.disabled = !newRadio.checked; select.disabled = newRadio.checked; };
  newRadio.addEventListener('change', sync); objRadio.addEventListener('change', sync);
  nameInput.addEventListener('focus', () => { newRadio.checked = true; sync(); });
  const submit = e => {
    e.preventDefault();
    try {
      if (newRadio.checked) {
        const problem = wb.validateSheetName(nameInput.value.trim());
        if (problem) { error.textContent = problem; error.hidden = false; nameInput.focus(); return; }
        moveChart(ctx, chart, { newSheet: nameInput.value.trim() });
      } else if (select.value !== ctx.sheetId()) moveChart(ctx, chart, { toSheetId: select.value });
    } catch (err) { error.textContent = err.message; error.hidden = false; return; }
    modal.close();
  };
  sync();
  const content = el('form.chart-move-form', { onsubmit: submit },
    el('p.field-label', {}, 'Choose where you want the chart to be placed:'),
    el('div.chart-move-row', {}, el('label.check', {}, newRadio, el('span', {}, 'New sheet:')), nameInput),
    el('div.chart-move-row', {}, el('label.check', {}, objRadio, el('span', {}, 'Object in:')), select),
    error,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Move Chart', content, initialFocus: objRadio, onClose: () => ctx.grid.focus() });
  return modal;
}

/**
 * The single command behind the chart UI. `arg.action` names what to do; the rest are its options.
 * Returns what the action made (a chart id, a patch) or null.
 */
export function runChartAction(ctx, arg = {}) {
  const { wb } = ctx, sheetId = ctx.sheetId();
  const action = arg.action;
  if (action === 'insert') return insertChart(ctx, arg.subtype, arg.range);
  if (action === 'insertSheet') return insertChartSheet(ctx, arg.subtype);
  if (action === 'insertDialog' || action === 'recommended') {
    return openChartTypeDialog(ctx, { mode: action === 'recommended' ? 'recommended' : 'insert', family: arg.family || null });
  }
  const chart = arg.id ? wb.chartById(sheetId, arg.id) : activeChart(ctx);
  if (!chart) return null;
  const update = (patch, label) => {
    if (!patch) return null;
    wb.updateChart(sheetId, chart.id, patch, label);
    return patch;
  };
  const count = () => seriesCountOf(wb, sheetId, chart);
  switch (action) {
    case 'element': return update(chartElementPatch(chart, arg.element, arg.value, { seriesCount: count() }), 'Add chart element');
    case 'quickLayout': return update(quickLayoutPatch(chart, arg.layout, { seriesCount: count() }), 'Quick layout');
    case 'colors': return update(colorsPatch(chart, arg.colors, count()), 'Change colors');
    case 'style': return update(chartStylePatch(chart, arg.style, { seriesCount: count() }), 'Chart style');
    case 'resetStyle': return update(chartStylePatch(chart, 1, { seriesCount: count() }), 'Reset to match style');
    case 'switchRowCol': {
      const patch = switchRowColumnPatch(wb, sheetId, chart);
      if (!patch) { toast('This chart’s series have their own references. Use Select Data to change them', { icon: 'info', duration: 3000 }); return null; }
      return update(patch, 'Switch row/column');
    }
    case 'changeType': {
      if (arg.subtype) return update(changeSubtypePatch(chart, arg.subtype, { font: themeChartFont(wb) }), 'Change chart type');
      return openChartTypeDialog(ctx, { mode: 'change', chart });
    }
    case 'selectData': {
      return openSelectDataDialog(ctx, chart);
    }
    case 'move': return openMoveChartDialog(ctx, chart);
    case 'format': {
      const key = arg.element || ctx.chartUi?.element() || 'chartArea';
      return update(elementFormatPatch(chart, key, arg), 'Format chart');
    }
    case 'size': {
      const patch = {};
      if (Number.isFinite(arg.w)) patch.w = Math.max(40, Math.min(4000, arg.w));
      if (Number.isFinite(arg.h)) patch.h = Math.max(30, Math.min(4000, arg.h));
      return update(patch, 'Size chart');
    }
    case 'patch': return update(arg.patch, arg.label || 'Format chart');
    case 'selectElement': ctx.chartUi?.setElement(arg.element); return null;
    case 'formatPane': ctx.chartUi?.openPane(arg.element || ctx.chartUi?.element() || 'chartArea'); return null;
    default: return null;
  }
}
