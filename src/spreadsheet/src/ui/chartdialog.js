/**
 * Insert / edit chart dialog: type, data range, title, orientation,
 * headers, stacking, trendline, legend, axis bounds, series colors, with a
 * live preview.
 */

import { el, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { renderChartSvg, seriesColor } from './chartsvg.js';
import { CHART_DASH_CHOICES, CHART_DESCRIPTION_MAX_LENGTH, CHART_TYPES, chartErrorValues, chartData, chartTitles, chartSeriesLine, chartSeriesLinePatch, chartXBounds, chartXBoundsPatch, chartXGridlines, defaultChart, normalizeChart } from '../core/charts.js';
import { parseRange, rangeName } from '../core/cell.js';
import { changeSubtypePatch } from '../core/chart-subtypes.js';
import { chartElementPatch, trendlineAllowed } from '../core/chart-design.js';
import { DEFAULT_TREND, TREND_TYPES, normalizeTrend, trendFor } from '../core/trendline.js';
import { ERROR_BAR_DEFAULT_VALUES, ERROR_BAR_TYPES, errorBarAmountInput, normalizeErrorBar, normalizeErrorBars } from '../core/error-bars.js';

const TYPE_ICONS = { column: 'chartColumn', bar: 'chartBar', line: 'chartLine', area: 'chartArea', pie: 'chartPie', donut: 'chartPie', scatter: 'chartScatter', combo: 'chartCombo', histogram: 'chartHistogram', waterfall: 'chartWaterfall', radar: 'chartRadar', bubble: 'chartBubble',
  treemap: 'chartTreemap', sunburst: 'chartSunburst', boxWhisker: 'chartBoxWhisker', funnel: 'chartFunnel', stock: 'chartStockOhlc', surface: 'chartSurface' };
// The subtype a chart in Excel's style becomes when the dialog gives it another type: each family's first.
const TYPE_SUBTYPES = { column: 'columnClustered', bar: 'barClustered', line: 'line', area: 'area', pie: 'pie', donut: 'doughnut', scatter: 'scatter',
  combo: 'comboColumnLine', histogram: 'histogram', waterfall: 'waterfall', radar: 'radar', bubble: 'bubble', treemap: 'treemap', sunburst: 'sunburst',
  boxWhisker: 'boxWhisker', funnel: 'funnel', stock: 'stockHlc', surface: 'surface3d' };
// What a change of subtype sets that the dialog has no field for.
const SUBTYPE_KEYS = ['appearance', 'explosion', 'ofPie', 'stock', 'surfaceView'];

/** openChartDialog(ctx, { chart }) edits; openChartDialog(ctx, { range }) inserts. */
export function openChartDialog(ctx, { chart = null, range = null, type = null } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const sheet = wb.sheet(sheetId);
  const src = range || chart?.range || ctx.range();
  const draft = chart ? { ...chart } : { ...defaultChart(src, { r: 0, c: 0 }) };
  // A chart type picked on the ribbon starts the new chart as that type.
  if (!chart && type && CHART_TYPES.some(([key]) => key === type)) draft.type = type;
  Object.assign(draft, chartTitles(wb, sheetId, draft));

  const preview = el('div.chart-preview', { 'aria-hidden': 'true' });
  const error = el('p.field-error', { id: fieldId('chart'), hidden: true, role: 'alert' });

  function canChange() {
    if (!wb.isProtected(sheetId)) return true;
    error.textContent = 'This sheet is protected. Unprotect it before changing charts.';
    error.hidden = false;
    return false;
  }

  const typeBtns = CHART_TYPES.map(([key, label]) => el('button.chart-type', {
    type: 'button', role: 'radio', 'aria-checked': String(draft.type === key), title: label, dataset: { type: key },
    onclick: () => { draft.type = key; restyle(); syncTypes(); refresh(); },
  }, el('span', { html: icon(TYPE_ICONS[key], 20) }), el('span.chart-type-label', {}, label)));
  // A chart in Excel's style draws from its appearance, which belongs to its type: another type takes that type's
  // own (as Change Chart Type gives it), or a scatter chart would come out as lines and a bubble chart as a line.
  let restyled = null;
  function restyle() {
    if (!chart?.appearance) return;
    const patch = draft.type === chart.type ? null : changeSubtypePatch(chart, TYPE_SUBTYPES[draft.type]);
    restyled = patch && normalizeChart({ ...chart, ...patch });
    for (const k of SUBTYPE_KEYS) draft[k] = (restyled || chart)[k];
  }
  const typeRow = el('div.chart-types', { role: 'radiogroup', 'aria-label': 'Chart type' }, ...typeBtns);
  typeRow.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
    if (!step) return;
    const index = typeBtns.indexOf(e.target.closest('[role="radio"]'));
    if (index < 0) return;
    e.preventDefault();
    const next = typeBtns[(index + step + typeBtns.length) % typeBtns.length];
    next.click();
    next.focus();
  });
  const syncTypes = () => {
    for (const b of typeBtns) {
      const selected = b.dataset.type === draft.type;
      b.setAttribute('aria-checked', String(selected));
      b.tabIndex = selected ? 0 : -1;
    }
    const stackable = ['column', 'bar', 'area', 'combo'].includes(draft.type);
    stackedOnly.hidden = !stackable;
    stack100Field.hidden = !stackable || !stackedBox.checked;
    // A chart in the app's own style draws trendlines on columns, lines and points; one in Excel's style wherever Excel does.
    trendRow.hidden = !trendlineAllowed({ type: draft.type, stacked: stackableChecked() }) || !draft.appearance && !['column', 'line', 'scatter'].includes(draft.type);
    syncTrend();
    errorRow.hidden = !['scatter', 'bubble'].includes(draft.type);
    axis2Field.hidden = draft.type !== 'combo';
    stackedField.hidden = stackedOnly.hidden && stack100Field.hidden && axis2Field.hidden;
    const pieLike = draft.type === 'pie' || draft.type === 'donut';
    // Radars, hierarchies and funnels have no axes to title or bound.
    const radar = ['radar', 'treemap', 'sunburst', 'funnel'].includes(draft.type);
    axisRow.hidden = pieLike || radar;
    y2TitleField.hidden = draft.type !== 'combo' || !axis2Box.checked;
    boundsRow.hidden = pieLike || radar && draft.type !== 'radar';
    xBoundsRow.hidden = !xyChart();
    const valueAxis = xyChart() ? 'Vertical axis' : 'Value axis';
    yMinLabel.textContent = `${valueAxis} minimum`; yMaxLabel.textContent = `${valueAxis} maximum`;
    yMinInput.setAttribute('aria-label', `${valueAxis} minimum`); yMaxInput.setAttribute('aria-label', `${valueAxis} maximum`);
    binsField.hidden = draft.type !== 'histogram';
    labelsField.hidden = pieLike;
    hGridField.hidden = pieLike || radar;
    vGridField.hidden = pieLike || radar || draft.type === 'surface';
    smoothField.hidden = !['line', 'area', 'combo'].includes(draft.type);
    markerSizeRow.hidden = markerSizeField.hidden = !['line', 'scatter'].includes(draft.type);
    // Points along x values, a hierarchy's levels and a histogram's bins have no category labels to pick.
    categoriesField.hidden = xyChart() || ['treemap', 'sunburst', 'histogram'].includes(draft.type);
    categoriesRow.hidden = categoriesField.hidden || !!draft.sourceRefs?.length;
  };

  const rangeInput = el('input.input', { type: 'text', value: rangeName(draft.range), 'aria-label': 'Data range', spellcheck: false, autocomplete: 'off', placeholder: 'A1:B10 or a table name' });
  const sourceText = (source, key) => source[key] || source.literal?.[key]?.map(v => JSON.stringify(v)).join(', ') || '';
  const sourceInputs = (draft.sourceRefs || []).map((source, i) => ({ source,
    heading: el('span.field-label', {}, source.name || `Series ${i + 1}`),
    categories: el('input.input', { type: 'text', value: sourceText(source, 'categories'), 'aria-label': `Categories for series ${i + 1}`, spellcheck: false }),
    values: el('input.input', { type: 'text', value: sourceText(source, 'values'), 'aria-label': `Values for series ${i + 1}`, spellcheck: false }),
    ...(draft.type === 'bubble' ? { sizes: el('input.input', { type: 'text', value: sourceText(source, 'sizes'), 'aria-label': `Bubble sizes for series ${i + 1}`, spellcheck: false }) } : {}),
  }));
  const titleInput = el('input.input', { type: 'text', value: draft.title || '', 'aria-label': 'Title', placeholder: 'Optional', maxlength: 200 });
  const descriptionInput = el('textarea.input', { value: draft.description || '', 'aria-label': 'Alternative text', rows: 2, maxlength: CHART_DESCRIPTION_MAX_LENGTH, placeholder: 'Describe what the chart communicates' });
  const seriesSel = el('select.select', { 'aria-label': 'Series in' },
    el('option', { value: 'auto' }, 'Detect automatically'),
    el('option', { value: 'cols' }, 'Columns'),
    el('option', { value: 'rows' }, 'Rows'));
  seriesSel.value = draft.seriesIn;
  const headersSel = el('select.select', { 'aria-label': 'Headers' },
    el('option', { value: 'auto' }, 'Detect automatically'),
    el('option', { value: 'true' }, 'First row is labels'),
    el('option', { value: 'false' }, 'No labels'));
  headersSel.value = String(draft.headers);
  // Whether the first column (the first row, with series in rows) labels the categories or plots as a series.
  const categoriesSel = el('select.select', { 'aria-label': 'Categories' },
    el('option', { value: 'auto' }, 'Detect automatically'),
    el('option', { value: 'true' }, 'First column'),
    el('option', { value: 'false' }, 'None (number the points)'));
  categoriesSel.value = String(draft.categoryLabels ?? 'auto');
  const categoriesField = el('label.field', {}, el('span.field-label', {}, 'Categories'), categoriesSel);
  const categoriesRow = el('div.row.row-2', { hidden: !!draft.sourceRefs?.length }, categoriesField);
  const stackedBox = el('input', { type: 'checkbox', checked: !!draft.stacked });
  const stack100Box = el('input', { type: 'checkbox', checked: !!draft.stack100 });
  // The trendline every series takes: the first series' kind and label to begin with. A chart whose series differ
  // keeps each its own unless these are changed.
  const firstTrend = trendFor(draft, 0) || (draft.trendline ? DEFAULT_TREND : null);
  let trendTouched = false;
  const trendSel = el('select.select', { 'aria-label': 'Trendline' }, el('option', { value: 'none' }, 'None'),
    ...TREND_TYPES.map(([value, label]) => el('option', { value }, label)));
  trendSel.value = firstTrend?.type || 'none';
  const orderSel = el('select.select', { 'aria-label': 'Order' }, ...[2, 3, 4, 5, 6].map(n => el('option', { value: String(n) }, String(n))));
  orderSel.value = String(firstTrend?.order || 2);
  const periodInput = el('input.input', { type: 'number', min: 2, max: 255, step: 1, value: firstTrend?.period || 2, 'aria-label': 'Period' });
  const eqBox = el('input', { type: 'checkbox', checked: !!firstTrend?.dispEq });
  const r2Box = el('input', { type: 'checkbox', checked: !!firstTrend?.dispRSqr });
  // The trendline's line: its dash (dashed unless chosen) and its width, in points as Excel gives it (kept in px).
  const trendDashSel = el('select.select', { 'aria-label': 'Trendline line style' }, el('option', { value: 'auto' }, 'Automatic (dashed)'),
    ...CHART_DASH_CHOICES.map(([value, label]) => el('option', { value }, label)));
  trendDashSel.value = firstTrend?.dash || 'auto';
  const trendWidthInput = el('input.input', { type: 'number', min: 0.25, max: 15, step: 0.25, placeholder: 'Auto', 'aria-label': 'Trendline width (pt)',
    value: firstTrend?.width != null ? Math.round(firstTrend.width * 3 / 4 * 100) / 100 : '' });
  const axis2Box = el('input', { type: 'checkbox', checked: !!draft.secondaryAxis });
  const axis2Field = el('label.check', {}, axis2Box, el('span', {}, 'Line on its own axis (right)'));
  const legendSel = el('select.select', { 'aria-label': 'Legend' },
    el('option', { value: 'bottom' }, 'Legend below'),
    el('option', { value: 'top' }, 'Legend above'),
    el('option', { value: 'right' }, 'Legend on the right'),
    el('option', { value: 'none' }, 'No legend'));
  legendSel.value = draft.legend === false ? 'none' : (draft.legendPos || 'bottom');
  const labelsBox = el('input', { type: 'checkbox', checked: !!draft.labels });
  // Gridlines by the way they run: on a bar chart the value gridlines are the vertical ones.
  const barChart = () => draft.type === 'bar';
  const hGridBox = el('input', { type: 'checkbox', checked: barChart() ? chartXGridlines(draft) : draft.gridlines !== false });
  const vGridBox = el('input', { type: 'checkbox', checked: barChart() ? draft.gridlines !== false : chartXGridlines(draft) });
  const smoothBox = el('input', { type: 'checkbox', checked: !!draft.smooth });
  const hiddenBox = el('input', { type: 'checkbox', checked: !!draft.includeHidden });
  const hGridField = el('label.check', {}, hGridBox, el('span', {}, 'Horizontal gridlines'));
  const vGridField = el('label.check', {}, vGridBox, el('span', {}, 'Vertical gridlines'));
  const smoothField = el('label.check', {}, smoothBox, el('span', {}, 'Smooth lines'));
  const hiddenField = el('label.check', {}, hiddenBox, el('span', {}, 'Include hidden cells'));
  const numberInput = (value, label) => el('input.input', { type: 'number', step: 'any', value: value ?? '', 'aria-label': label, placeholder: 'Auto' });
  const yMinInput = numberInput(draft.yMin, 'Value axis minimum');
  const yMaxInput = numberInput(draft.yMax, 'Value axis maximum');
  const yMinLabel = el('span.field-label', {}, 'Value axis minimum'), yMaxLabel = el('span.field-label', {}, 'Value axis maximum');
  const boundsRow = el('div.row.row-2', {},
    el('label.field', {}, yMinLabel, yMinInput),
    el('label.field', {}, yMaxLabel, yMaxInput));
  // A scatter or bubble chart measures values along both axes, so each has its own bounds.
  let xBounds = chartXBounds(draft);
  const xMinInput = numberInput(xBounds.min, 'Horizontal axis minimum');
  const xMaxInput = numberInput(xBounds.max, 'Horizontal axis maximum');
  const xBoundsRow = el('div.row.row-2', {},
    el('label.field', {}, el('span.field-label', {}, 'Horizontal axis minimum'), xMinInput),
    el('label.field', {}, el('span.field-label', {}, 'Horizontal axis maximum'), xMaxInput));
  const xyChart = () => draft.type === 'scatter' || draft.type === 'bubble';
  const binsInput = el('input.input', { type: 'number', min: 2, max: 100, step: 1, value: draft.bins ?? '', 'aria-label': 'Number of bins', placeholder: 'Auto' });
  const binsField = el('label.field', {}, el('span.field-label', {}, 'Bins'), binsInput);
  // Every series' marker size, in points as Format Data Series gives it. It shows the size the series share (blank when
  // they differ or keep the default) and changes them only once it says something else.
  const markerSizeInput = el('input.input', { type: 'number', min: 2, max: 72, step: 1, 'aria-label': 'Marker size (pt)', placeholder: 'Auto' });
  const markerSizeField = el('label.field', {}, el('span.field-label', {}, 'Marker size (pt)'), markerSizeInput);
  const markerSizeRow = el('div.row.row-2', {}, markerSizeField);
  let markerSizeShown = null, markerSize = null;
  const markerPatch = (target) => (markerSize == null || markerSizeField.hidden ? {}
    : chartSeriesLinePatch(target, readData().series.map((_, i) => i), { markerSize, marker: true }));
  // One color swatch per series (per slice for pies), rebuilt when the series change.
  const colorsRow = el('div.chart-colors', { role: 'group', 'aria-label': 'Series colors' });
  let colorsKey = '';
  function syncColors(data) {
    const pieLike = draft.type === 'pie' || draft.type === 'donut';
    const names = pieLike ? data.categories.slice(0, 12)
      : draft.type === 'waterfall' ? ['Increase', 'Decrease', 'Total']
        : draft.type === 'histogram' ? ['Count'] : data.series.map((s) => s.name);
    // The row is rebuilt only when the series change. A colour being picked keeps its own
    // input, or the browser's colour popup would close after every step of the drag.
    const key = `${pieLike}|${names.join('\u0000')}`;
    const fallbackFor = (i) => (draft.type === 'waterfall' && i === 1 ? '#c22a2a' : draft.type === 'waterfall' && i === 2 ? '#918f88' : null);
    const syncValues = () => {
      colorsRow.querySelectorAll('input.chart-color-input').forEach((input, i) => {
        const value = draft.colors?.[i] || fallbackFor(i) || seriesColor(draft, i);
        if (input.value !== value) input.value = value;
      });
      const reset = colorsRow.querySelector('.chart-colors-reset');
      if (reset) reset.hidden = !(draft.colors || []).some(Boolean);
    };
    if (key === colorsKey) { syncValues(); return; }
    colorsKey = key;
    colorsRow.replaceChildren(...[...names.map((name, i) => {
      const input = el('input.chart-color-input', {
        type: 'color', value: draft.colors?.[i] || fallbackFor(i) || seriesColor(draft, i), 'aria-label': `Color of ${name}`, title: `Color of ${name}`,
        oninput: () => { const list = (draft.colors || []).slice(); list[i] = input.value; draft.colors = list; refresh(); },
      });
      return el('label.chart-color', {}, input, el('span.chart-color-name', {}, name));
    }), names.length ? el('button.btn.btn-ghost.btn-sm.chart-colors-reset', { type: 'button', hidden: !(draft.colors || []).some(Boolean), onclick: () => { draft.colors = []; refresh(); } }, 'Reset colors') : null].filter(Boolean));
    colorsRow.hidden = !names.length;
  }
  const stackedOnly = el('label.check', {}, stackedBox, el('span', {}, 'Stacked'));
  const stack100Field = el('label.check', {}, stack100Box, el('span', {}, '100% stacked'));
  const stackedField = el('div.check-group', {}, stackedOnly, stack100Field, axis2Field);
  const stackableChecked = () => ['column', 'bar', 'area', 'combo'].includes(draft.type) && stackedBox.checked;
  stackedBox.addEventListener('change', () => syncTypes());
  const orderField = el('label.field', {}, el('span.field-label', {}, 'Order'), orderSel);
  const periodField = el('label.field', {}, el('span.field-label', {}, 'Period'), periodInput);
  const trendLabelFields = el('div.check-group', {}, el('label.check', {}, eqBox, el('span', {}, 'Show equation')), el('label.check', {}, r2Box, el('span', {}, 'Show R² value')));
  const trendRow = el('div.row.row-2', {},
    el('label.field', {}, el('span.field-label', {}, 'Trendline'), trendSel),
    orderField, periodField, el('div.field', {}, el('span.field-label', {}, 'Trendline label'), trendLabelFields),
    el('label.field', {}, el('span.field-label', {}, 'Trendline line style'), trendDashSel),
    el('label.field', {}, el('span.field-label', {}, 'Trendline width (pt)'), trendWidthInput));
  // Only what the kind takes shows: a polynomial's order, a moving average's period, the equation and R² of a fit.
  const syncTrend = () => {
    const kind = trendSel.value;
    orderField.hidden = kind !== 'poly';
    periodField.hidden = kind !== 'movingAvg';
    trendLabelFields.parentNode.hidden = kind === 'none' || kind === 'movingAvg';
    trendDashSel.parentNode.hidden = trendWidthInput.parentNode.hidden = kind === 'none';
  };
  for (const input of [trendSel, orderSel, periodInput, eqBox, r2Box, trendDashSel, trendWidthInput]) {
    input.addEventListener('input', () => { trendTouched = true; syncTrend(); });
    input.addEventListener('change', () => { trendTouched = true; syncTrend(); });
  }
  /** The trendline fields for a chart of `count` series: as the chart had them until the form changes them. */
  function trendFields(count) {
    if (!trendTouched || trendRow.hidden) return { trendline: !!draft.trendline, trendlines: draft.trendlines };
    if (trendSel.value === 'none') return { trendline: false, trendlines: undefined };
    const widthPt = trendWidthInput.value.trim() === '' ? null : Number(trendWidthInput.value);
    const chosen = { type: trendSel.value, order: Number(orderSel.value), period: Number(periodInput.value), dispEq: eqBox.checked, dispRSqr: r2Box.checked,
      dash: trendDashSel.value === 'auto' ? undefined : trendDashSel.value, width: widthPt == null ? undefined : Math.round(widthPt * 4 / 3 * 100) / 100 };
    return { trendline: true, trendlines: Array.from({ length: Math.max(1, count, draft.trendlines?.length || 0) }, (_, j) => normalizeTrend({ ...(trendFor(draft, j) || {}), ...chosen })) };
  }
  // Error bars on a scatter or bubble chart, up and down and to each side: every series takes the kind and
  // amount chosen here, as it does the trendline; Format Error Bars sets each series' own.
  const errorAxes = [['y', 'Vertical'], ['x', 'Horizontal']].map(([axis, word]) => {
    const first = (draft.errorBars || []).find(b => b?.[axis])?.[axis] || null;
    const kind = el('select.select', { 'aria-label': `${word} error bars` }, el('option', { value: 'none' }, 'None'),
      ...ERROR_BAR_TYPES.map(([value, label]) => el('option', { value }, label)));
    kind.value = first?.type || 'none';
    const amount = el('input.input', { type: 'number', min: 0, step: 'any', 'aria-label': `${word} error amount`, value: first && first.type !== 'cust' ? first.value : '' });
    const cells = el('input.input', { type: 'text', 'aria-label': `${word} error cells`, placeholder: '=Sheet1!$D$2:$D$10',
      value: first?.plus ? `=${first.plus}` : first?.plusValues ? first.plusValues.join(', ') : '' });
    const amountLabel = el('span.field-label', {});
    const amountField = el('label.field', {}, amountLabel, amount), cellsField = el('label.field', {}, el('span.field-label', {}, `${word} error cells`), cells);
    const state = { axis, word, kind, amount, cells, touched: false, fields: [el('label.field', {}, el('span.field-label', {}, `${word} error bars`), kind), amountField, cellsField] };
    state.sync = () => {
      amountField.hidden = !['fixedVal', 'percentage', 'stdDev'].includes(kind.value);
      cellsField.hidden = kind.value !== 'cust';
      amountLabel.textContent = { fixedVal: `${word} error amount`, percentage: `${word} error percentage (%)`, stdDev: `${word} standard deviations` }[kind.value] || '';
    };
    // A kind picked anew starts at its own amount (5 %, not the 1 a fixed value had).
    kind.addEventListener('change', () => { if (state.lastKind !== kind.value) amount.value = ERROR_BAR_DEFAULT_VALUES[kind.value] ?? ''; state.lastKind = kind.value; });
    state.lastKind = kind.value;
    for (const input of [kind, amount, cells]) {
      input.addEventListener('input', () => { state.touched = true; state.sync(); });
      input.addEventListener('change', () => { state.touched = true; state.sync(); });
    }
    state.sync();
    return state;
  });
  const errorRow = el('div.row.row-2', {}, ...errorAxes.flatMap(s => s.fields));
  /** The error bar fields for a chart of `count` series, as the chart had them until the form changes them; or { error, field }. */
  function errorFields(count) {
    if (errorRow.hidden || !errorAxes.some(s => s.touched)) return { errorBars: draft.errorBars };
    const list = Array.from({ length: Math.max(1, count, draft.errorBars?.length || 0) }, (_, j) => ({ ...(draft.errorBars?.[j] || {}) }));
    for (const s of errorAxes) {
      if (!s.touched) continue;
      if (s.kind.value === 'none') { list.forEach(bars => delete bars[s.axis]); continue; }
      let fields = {};
      if (s.kind.value === 'cust') {
        const plus = errorBarAmountInput(wb, sheetId, s.cells.value, 'plus');
        if (plus.error || !s.cells.value.trim()) return { error: plus.error || `Enter the cells that hold the ${s.word.toLowerCase()} error amounts`, field: s.cells };
        const minus = errorBarAmountInput(wb, sheetId, s.cells.value, 'minus');
        fields = { ...plus, ...minus };
      } else if (s.kind.value !== 'stdErr') {
        const v = Number(s.amount.value);
        if (s.amount.value.trim() === '' || !Number.isFinite(v) || v < 0) return { error: `The ${s.word.toLowerCase()} error amount must be a number of 0 or more`, field: s.amount };
        fields = { value: v };
      }
      list.forEach(bars => { bars[s.axis] = normalizeErrorBar({ ...(bars[s.axis] || {}), type: s.kind.value, ...fields }); });
    }
    return { errorBars: normalizeErrorBars(list) || undefined };
  }
  const labelsField = el('label.check', {}, labelsBox, el('span', {}, 'Show values'));
  const xTitleInput = el('input.input', { type: 'text', value: draft.xTitle || '', 'aria-label': 'Horizontal axis title', placeholder: 'Optional', maxlength: 80 });
  const yTitleInput = el('input.input', { type: 'text', value: draft.yTitle || '', 'aria-label': 'Vertical axis title', placeholder: 'Optional', maxlength: 80 });
  const y2TitleInput = el('input.input', { type: 'text', value: draft.y2Title || '', 'aria-label': 'Secondary axis title', placeholder: 'Optional', maxlength: 80 });
  const y2TitleField = el('label.field', {}, el('span.field-label', {}, 'Secondary axis title'), y2TitleInput);
  const axisRow = el('div.row.row-2', {},
    el('label.field', {}, el('span.field-label', {}, 'Horizontal axis title'), xTitleInput),
    el('label.field', {}, el('span.field-label', {}, 'Vertical axis title'), yTitleInput), y2TitleField);

  // The fields a problem can be laid at; the message names it and the field at fault is marked and focused.
  const checkedFields = [rangeInput, yMinInput, yMaxInput, xMinInput, xMaxInput, binsInput, markerSizeInput, periodInput, trendWidthInput, ...errorAxes.flatMap(s => [s.amount, s.cells]), ...sourceInputs.flatMap(s => [s.categories, s.values, ...(s.sizes ? [s.sizes] : [])])];
  /** Reads the form into the draft; null, or { msg, fields } for what stops the chart. */
  function readForm() {
    const problem = (msg, ...fields) => ({ msg, fields });
    // A range, a named range, a table name, or Table[Column] — on this sheet.
    if (sourceInputs.length) {
      const next = [];
      for (const s of sourceInputs) {
        const source = { ...s.source, literal: { ...s.source.literal } };
        for (const key of ['categories', 'values', ...(s.sizes ? ['sizes'] : [])]) {
          const value = s[key].value.trim();
          // Imported charts can retain deleted helper references. Let unrelated
          // edits preserve them, while requiring any replacement to be valid.
          if (value === sourceText(s.source, key)) continue;
          delete source.literal[key];
          source[key] = value;
          if (key === 'categories' && !value) continue;
          const r = wb.rangeFromText(sheetId, value)?.range;
          if (!r) {
            let literal;
            try { literal = JSON.parse(`[${value}]`); } catch { /* Not a list of literal values. */ }
            if (value && literal?.length && literal.length <= 5000 && literal.every(v => v === null || Number.isFinite(v) || key === 'categories' && typeof v === 'string')) {
              source.literal[key] = literal; source[key] = ''; continue;
            }
            return problem('Enter a range such as Data!A1:A20 or comma-separated values', s[key]);
          }
          if ((r.r1 !== r.r2 && r.c1 !== r.c2) || Math.max(r.r2 - r.r1, r.c2 - r.c1) >= 5000) return problem('Choose one row or column with up to 5,000 cells', s[key]);
        }
        next.push(source);
      }
      draft.sourceRefs = next;
    } else {
      const parsed = wb.rangeFromText(sheetId, rangeInput.value.trim());
      if (parsed && parsed.sheetId !== sheetId) return problem('The chart can only show cells from this sheet', rangeInput);
      const r = parsed?.range || null;
      if (!r) return problem('Enter a range like A1:B10, or a table name', rangeInput);
      if (r.r2 - r.r1 + 1 > 5000 || r.c2 - r.c1 + 1 > 200) return problem('That range is too large to chart', rangeInput);
      draft.range = r;
    }
    for (const [key, input] of [['title', titleInput], ['xTitle', xTitleInput], ['yTitle', yTitleInput], ['y2Title', y2TitleInput]]) {
      const value = input.value.trim();
      if (value !== (draft[key] || '').trim()) delete draft[`${key}Ref`];
      draft[key] = value;
    }
    if (descriptionInput.value !== (draft.description || '')) draft.description = descriptionInput.value;
    draft.seriesIn = seriesSel.value;
    draft.headers = headersSel.value === 'auto' ? 'auto' : headersSel.value === 'true';
    draft.categoryLabels = categoriesSel.value === 'auto' ? 'auto' : categoriesSel.value === 'true';
    // A type the Stacked boxes are hidden for takes no stack from them: only the one it came with (a stacked line chart).
    const kept = !!chart && chart.type === draft.type;
    draft.stacked = stackedOnly.hidden ? kept && !!chart.stacked : stackedBox.checked;
    draft.stack100 = stackedOnly.hidden ? kept && !!chart.stack100 : stackedBox.checked && stack100Box.checked;
    draft.secondaryAxis = axis2Box.checked;
    y2TitleField.hidden = draft.type !== 'combo' || !draft.secondaryAxis;
    draft.legend = legendSel.value !== 'none';
    if (legendSel.value !== 'none') draft.legendPos = legendSel.value;
    draft.labels = labelsBox.checked;
    draft.gridlines = (barChart() ? vGridBox : hGridBox).checked;
    const xGrid = (barChart() ? hGridBox : vGridBox).checked;
    if (xGrid !== chartXGridlines(draft)) Object.assign(draft, chartElementPatch(draft, 'gridlines', { axis: barChart() ? 'horizontal' : 'vertical', on: xGrid }));
    draft.smooth = smoothBox.checked;
    draft.includeHidden = hiddenBox.checked;
    const yMin = yMinInput.value.trim() === '' ? null : Number(yMinInput.value);
    const yMax = yMaxInput.value.trim() === '' ? null : Number(yMaxInput.value);
    if (yMin != null && yMax != null && yMin >= yMax) return problem('The axis minimum must be below the maximum', yMinInput, yMaxInput);
    draft.yMin = Number.isFinite(yMin) ? yMin : null;
    draft.yMax = Number.isFinite(yMax) ? yMax : null;
    if (xyChart()) {
      const xMin = xMinInput.value.trim() === '' ? null : Number(xMinInput.value);
      const xMax = xMaxInput.value.trim() === '' ? null : Number(xMaxInput.value);
      if (xMin != null && xMax != null && xMin >= xMax) return problem('The axis minimum must be below the maximum', xMinInput, xMaxInput);
      xBounds = { min: Number.isFinite(xMin) ? xMin : null, max: Number.isFinite(xMax) ? xMax : null };
      Object.assign(draft, chartXBoundsPatch(draft, xBounds.min, xBounds.max));
    }
    const bins = binsInput.value.trim() === '' ? null : Number(binsInput.value);
    const binsOk = bins == null || (Number.isInteger(bins) && bins >= 2 && bins <= 100);
    // The field is hidden for every type but histogram, so only a histogram is held up by what it says.
    if (draft.type === 'histogram' && !binsOk) return problem('Bins must be a whole number from 2 to 100', binsInput);
    draft.bins = binsOk ? bins : null;
    const size = markerSizeInput.value.trim();
    if (!markerSizeField.hidden && size !== '' && !(Number(size) >= 2 && Number(size) <= 72)) return problem('The marker size must be from 2 to 72 pt', markerSizeInput);
    markerSize = size === '' || size === markerSizeShown ? null : Number(size);
    const period = Number(periodInput.value);
    if (!trendRow.hidden && trendSel.value === 'movingAvg' && !(Number.isInteger(period) && period >= 2 && period <= 255)) return problem('The period must be a whole number from 2 to 255', periodInput);
    const errorCheck = errorFields(readData().series.length);
    if (errorCheck.error) return problem(errorCheck.error, errorCheck.field);
    const trendWidth = trendWidthInput.value.trim() === '' ? null : Number(trendWidthInput.value);
    if (!trendRow.hidden && trendSel.value !== 'none' && trendWidth != null && !(trendWidth >= 0.25 && trendWidth <= 15)) return problem('The trendline width must be from 0.25 to 15 pt', trendWidthInput);
    return null;
  }

  // The range is read again only when something it depends on changes: a large range takes
  // hundreds of milliseconds to read, and a title keystroke must not pay that.
  let dataKey = null;
  let dataCache = null;
  function readData() {
    const r = draft.range;
    const key = [wb.version, r.r1, r.c1, r.r2, r.c2, draft.seriesIn, draft.headers, draft.categoryLabels, draft.type, draft.includeHidden, JSON.stringify(draft.sourceRefs), draft.titleRef, draft.xTitleRef, draft.yTitleRef, draft.y2TitleRef].join('|');
    if (key !== dataKey) { dataKey = key; dataCache = chartData(wb, sheetId, draft); }
    return dataCache;
  }

  // A chart in Excel's style shows its labels by its appearance's per-series settings as well as by `labels`: the
  // Labels box turns those on or off too, as Add Chart Element ▸ Data Labels does, or labels taken off there would
  // stay off with the box ticked.
  function labelsPatch(data) {
    if (!chart?.appearance || !!draft.labels === !!chart.labels) return null;
    const base = { ...chart, ...Object.fromEntries(SUBTYPE_KEYS.map(k => [k, draft[k]])), type: draft.type };
    if (!base.appearance) return null;
    const count = ['pie', 'donut'].includes(draft.type) ? data.categories.length : data.series.length;
    return chartElementPatch(base, 'dataLabels', draft.labels ? 'show' : 'none', { seriesCount: count });
  }

  function refresh() {
    const problem = readForm();
    error.hidden = !problem;
    error.textContent = problem?.msg || '';
    for (const field of checkedFields) {
      const bad = !!problem?.fields.includes(field);
      field.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad) field.setAttribute('aria-describedby', error.id); else field.removeAttribute('aria-describedby');
    }
    if (problem) { preview.replaceChildren(); return; }
    const data = readData();
    categoriesSel.options[1].textContent = data.orientation === 'rows' ? 'First row' : 'First column';
    // Resolve linked names through the same live data as the legend and colors.
    // Updating a heading must not replace the source's name reference or cache.
    sourceInputs.forEach((s, i) => { s.heading.textContent = data.series[i]?.name || s.source.name || `Series ${i + 1}`; });
    const labelPatch = labelsPatch(data);
    if (markerSizeShown == null) {
      const sizes = data.series.map((_, i) => chartSeriesLine(draft, i)?.markerSize ?? null);
      markerSizeShown = sizes.length && sizes[0] != null && sizes.every(v => v === sizes[0]) ? String(sizes[0]) : '';
      markerSizeInput.value = markerSizeShown;
    }
    let shown = { ...draft, ...trendFields(data.series.length), ...errorFields(data.series.length), ...(labelPatch?.appearance ? { appearance: labelPatch.appearance } : {}) };
    shown = { ...shown, ...markerPatch(shown) };
    const errorValues = shown.errorBars ? chartErrorValues(wb, sheetId, shown) : null;
    preview.innerHTML = renderChartSvg(errorValues ? { ...data, errorValues } : data, shown, draft.appearance ? draft.w : 440, draft.appearance ? draft.h : 230);
    syncColors(data);
  }
  // Typing a title redraws the preview once the typing pauses, not on every character.
  let redraw = 0;
  const refreshSoon = () => { clearTimeout(redraw); redraw = setTimeout(refresh, 150); };
  for (const input of sourceInputs.flatMap(s => [s.categories, s.values, ...(s.sizes ? [s.sizes] : [])])) input.addEventListener('input', refreshSoon);
  for (const input of [rangeInput, seriesSel, headersSel, categoriesSel, stackedBox, stack100Box, trendSel, orderSel, periodInput, eqBox, r2Box, trendDashSel, trendWidthInput, axis2Box, legendSel, labelsBox, hGridBox, vGridBox, smoothBox, hiddenBox, yMinInput, yMaxInput, xMinInput, xMaxInput, binsInput]) input.addEventListener('input', refresh);
  for (const input of [titleInput, descriptionInput, xTitleInput, yTitleInput, y2TitleInput, markerSizeInput]) input.addEventListener('input', refreshSoon);
  for (const s of errorAxes) { s.kind.addEventListener('change', refresh); s.amount.addEventListener('input', refresh); s.cells.addEventListener('input', refreshSoon); s.cells.addEventListener('change', refresh); }
  for (const input of [seriesSel, headersSel, categoriesSel, stackedBox, stack100Box, trendSel, orderSel, eqBox, r2Box, axis2Box, legendSel, labelsBox, hGridBox, vGridBox, smoothBox, hiddenBox]) input.addEventListener('change', refresh);

  const submit = (e) => {
    e?.preventDefault();
    if (!canChange()) return;
    const problem = readForm();
    if (problem) { refresh(); problem.fields[0].focus(); return; }
    const trend = { ...trendFields(readData().series.length), ...errorFields(readData().series.length) };
    if (chart) {
      const labelPatch = labelsPatch(readData());
      const update = {
        type: draft.type, range: draft.range, title: draft.title, description: draft.description, seriesIn: draft.seriesIn, headers: draft.headers, categoryLabels: draft.categoryLabels, stacked: draft.stacked, stack100: draft.stack100, ...trend,
        legend: draft.legend, legendPos: draft.legendPos, labels: draft.labels, gridlines: draft.gridlines, xGridlines: draft.xGridlines, smooth: draft.smooth, xTitle: draft.xTitle, yTitle: draft.yTitle, y2Title: draft.y2Title,
        colors: draft.colors, yMin: draft.yMin, yMax: draft.yMax, bins: draft.bins, secondaryAxis: draft.secondaryAxis, includeHidden: draft.includeHidden,
        ...(draft.sourceRefs ? { sourceRefs: draft.sourceRefs } : {}),
        titleRef: draft.titleRef, xTitleRef: draft.xTitleRef, yTitleRef: draft.yTitleRef, y2TitleRef: draft.y2TitleRef,
        ...(restyled ? Object.fromEntries(SUBTYPE_KEYS.map(k => [k, draft[k]])) : {}),
        ...(draft.appearance && draft.appearance !== chart.appearance ? { appearance: draft.appearance } : {}),
        ...(labelPatch?.appearance ? { appearance: labelPatch.appearance } : {}),
        ...(xyChart() ? chartXBoundsPatch({ appearance: labelPatch?.appearance || draft.appearance }, xBounds.min, xBounds.max) : {}),
      };
      wb.updateChart(sheetId, chart.id, { ...update, ...markerPatch({ ...chart, ...update }) });
      modal.close();
      ctx.grid.selectChart(chart.id);
      return;
    }
    // Place the new chart just right of its data, or below when there is no room; where that is out
    // of the window, in the middle of the window instead.
    const r = draft.range;
    let anchor = { r: r.r1, c: r.c2 + 1 };
    if (anchor.c + 4 > sheet.cols) anchor = { r: r.r2 + 2, c: r.c1 };
    let place = { anchor, dx: draft.dx || 0, dy: draft.dy || 0 };
    const seen = ctx.grid.placeInView?.({ ...place, w: draft.w, h: draft.h });
    if (seen) place = seen;
    // Below data in the sheet's last rows the grid would draw the chart clamped onto that data, and
    // move it once the sheet grew: the sheet grows now to hold the whole chart, as typing there would.
    // At the grid's very bottom, where it cannot, the chart goes right of the data after all.
    const rowsNeeded = place.anchor.r + 1 + Math.ceil((place.dy + draft.h) / sheet.defaultRowHeight);
    if (rowsNeeded > sheet.rows) wb.ensureSize(sheetId, rowsNeeded, sheet.cols);
    if (place.anchor.r >= sheet.rows) {
      place = { ...place, anchor: { r: r.r1, c: r.c2 + 1 } };
      if (place.anchor.c >= sheet.cols) wb.ensureSize(sheetId, sheet.rows, place.anchor.c + 1);
    }
    const fresh = { ...draft, ...trend, ...place };
    const id = wb.addChart(sheetId, { ...fresh, ...markerPatch(fresh) });
    modal.close();
    ctx.grid.selectChart(id);
  };

  // The bins field is hidden for every type but histogram; the browser must not check it then.
  const content = el('form.chart-form', { onsubmit: submit, novalidate: true },
    el('div.chart-form-grid', {},
      el('div.chart-form-fields', {},
        el('div.field', {}, el('span.field-label', {}, 'Type'), typeRow),
        sourceInputs.length ? el('div', {}, ...sourceInputs.map(s => el('div.field', {},
          s.heading,
          el('label.field', {}, el('span.field-label', {}, s.sizes ? 'X values' : 'Categories'), s.categories),
          el('label.field', {}, el('span.field-label', {}, s.sizes ? 'Y values' : 'Values'), s.values),
          ...(s.sizes ? [el('label.field', {}, el('span.field-label', {}, 'Bubble sizes'), s.sizes)] : []))), error)
          : el('label.field', {}, el('span.field-label', {}, 'Data range'), rangeInput, error),
        el('label.field', {}, el('span.field-label', {}, 'Title'), titleInput),
        el('label.field', {}, el('span.field-label', {}, 'Alternative text'), descriptionInput),
        el('div.row.row-2', { hidden: !!sourceInputs.length },
          el('label.field', {}, el('span.field-label', {}, 'Series in'), seriesSel),
          el('label.field', {}, el('span.field-label', {}, 'Labels'), headersSel)),
        categoriesRow,
        axisRow,
        xBoundsRow,
        boundsRow,
        binsField,
        el('div.row.row-2', {},
          el('label.field', {}, el('span.field-label', {}, 'Legend'), legendSel),
          el('div.field', {}, el('span.field-label', {}, 'Options'), el('div.check-group', {}, labelsField, hGridField, vGridField, smoothField, hiddenField))),
        el('div.row', {}, stackedField),
        trendRow,
        errorRow,
        markerSizeRow,
        el('div.field', {}, el('span.field-label', {}, 'Colors'), colorsRow)),
      el('div.chart-form-preview', {}, el('span.field-label', {}, 'Preview'), preview)),
    el('div.row.row-end', {},
      chart && el('button.btn.btn-danger', { type: 'button', onclick: () => { if (!canChange()) return; wb.deleteChart(sheetId, chart.id); modal.close(); ctx.grid.focus(); } }, 'Delete chart'),
      el('div.grow'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, chart ? 'Save' : 'Insert')));
  // The roving tabindex is set before the modal picks the first control to focus, so an edited
  // chart's own type takes the focus (and the first arrow moves from it), not the first in the row.
  syncTypes();
  const modal = openModal({ title: chart ? 'Edit chart' : 'Insert chart', content, wide: true, initialFocus: chart ? null : titleInput, onClose: () => { clearTimeout(redraw); ctx.grid.focus(); } });
  refresh();
  return modal;
}
