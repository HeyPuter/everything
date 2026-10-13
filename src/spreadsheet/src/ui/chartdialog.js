/**
 * Insert / edit chart dialog: type, data range, title, orientation,
 * headers, stacking, legend, axis bounds, series colors, with a live
 * preview.
 */

import { el, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { renderChartSvg, seriesColor } from './chartsvg.js';
import { CHART_DESCRIPTION_MAX_LENGTH, CHART_TYPES, chartData, chartTitles, defaultChart } from '../core/charts.js';
import { parseRange, rangeName } from '../core/cell.js';

const TYPE_ICONS = { column: 'chartColumn', bar: 'chartBar', line: 'chartLine', area: 'chartArea', pie: 'chartPie', donut: 'chartPie', scatter: 'chartScatter', combo: 'chartCombo', histogram: 'chartHistogram', waterfall: 'chartWaterfall', radar: 'chartRadar', bubble: 'chartBubble',
  treemap: 'chartTreemap', sunburst: 'chartSunburst', boxWhisker: 'chartBoxWhisker', funnel: 'chartFunnel', stock: 'chartStockOhlc', surface: 'chartSurface' };

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
    onclick: () => { draft.type = key; syncTypes(); refresh(); },
  }, el('span', { html: icon(TYPE_ICONS[key], 20) }), el('span.chart-type-label', {}, label)));
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
    trendField.hidden = !['column', 'line', 'scatter'].includes(draft.type) || (draft.type === 'column' && stackedBox.checked);
    axis2Field.hidden = draft.type !== 'combo';
    stackedField.hidden = stackedOnly.hidden && stack100Field.hidden && trendField.hidden && axis2Field.hidden;
    const pieLike = draft.type === 'pie' || draft.type === 'donut';
    // Radars, hierarchies and funnels have no axes to title or bound.
    const radar = ['radar', 'treemap', 'sunburst', 'funnel'].includes(draft.type);
    axisRow.hidden = pieLike || radar;
    y2TitleField.hidden = draft.type !== 'combo' || !axis2Box.checked;
    boundsRow.hidden = pieLike || radar && draft.type !== 'radar';
    binsField.hidden = draft.type !== 'histogram';
    labelsField.hidden = pieLike;
    gridField.hidden = pieLike || radar;
    smoothField.hidden = !['line', 'area', 'combo'].includes(draft.type);
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
  const seriesSel = el('select.input', { 'aria-label': 'Series in' },
    el('option', { value: 'auto' }, 'Detect automatically'),
    el('option', { value: 'cols' }, 'Columns'),
    el('option', { value: 'rows' }, 'Rows'));
  seriesSel.value = draft.seriesIn;
  const headersSel = el('select.input', { 'aria-label': 'Headers' },
    el('option', { value: 'auto' }, 'Detect automatically'),
    el('option', { value: 'true' }, 'First row is labels'),
    el('option', { value: 'false' }, 'No labels'));
  headersSel.value = String(draft.headers);
  const stackedBox = el('input', { type: 'checkbox', checked: !!draft.stacked });
  const stack100Box = el('input', { type: 'checkbox', checked: !!draft.stack100 });
  const trendBox = el('input', { type: 'checkbox', checked: !!draft.trendline });
  const axis2Box = el('input', { type: 'checkbox', checked: !!draft.secondaryAxis });
  const axis2Field = el('label.check', {}, axis2Box, el('span', {}, 'Line on its own axis (right)'));
  const legendSel = el('select.input', { 'aria-label': 'Legend' },
    el('option', { value: 'bottom' }, 'Legend below'),
    el('option', { value: 'top' }, 'Legend above'),
    el('option', { value: 'right' }, 'Legend on the right'),
    el('option', { value: 'none' }, 'No legend'));
  legendSel.value = draft.legend === false ? 'none' : (draft.legendPos || 'bottom');
  const labelsBox = el('input', { type: 'checkbox', checked: !!draft.labels });
  const gridBox = el('input', { type: 'checkbox', checked: draft.gridlines !== false });
  const smoothBox = el('input', { type: 'checkbox', checked: !!draft.smooth });
  const hiddenBox = el('input', { type: 'checkbox', checked: !!draft.includeHidden });
  const gridField = el('label.check', {}, gridBox, el('span', {}, draft.appearance?.xGridlines || draft.appearance?.y2Gridlines ? 'Primary value gridlines' : 'Gridlines'));
  const smoothField = el('label.check', {}, smoothBox, el('span', {}, 'Smooth lines'));
  const hiddenField = el('label.check', {}, hiddenBox, el('span', {}, 'Include hidden cells'));
  const numberInput = (value, label) => el('input.input', { type: 'number', step: 'any', value: value ?? '', 'aria-label': label, placeholder: 'Auto' });
  const yMinInput = numberInput(draft.yMin, 'Value axis minimum');
  const yMaxInput = numberInput(draft.yMax, 'Value axis maximum');
  const boundsRow = el('div.row.row-2', {},
    el('label.field', {}, el('span.field-label', {}, 'Value axis minimum'), yMinInput),
    el('label.field', {}, el('span.field-label', {}, 'Value axis maximum'), yMaxInput));
  const binsInput = el('input.input', { type: 'number', min: 2, max: 100, step: 1, value: draft.bins ?? '', 'aria-label': 'Number of bins', placeholder: 'Auto' });
  const binsField = el('label.field', {}, el('span.field-label', {}, 'Bins'), binsInput);
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
  const trendField = el('label.check', {}, trendBox, el('span', {}, 'Trendline'));
  const stackedField = el('div.check-group', {}, stackedOnly, stack100Field, trendField, axis2Field);
  stackedBox.addEventListener('change', () => syncTypes());
  const labelsField = el('label.check', {}, labelsBox, el('span', {}, 'Show values'));
  const xTitleInput = el('input.input', { type: 'text', value: draft.xTitle || '', 'aria-label': 'Horizontal axis title', placeholder: 'Optional', maxlength: 80 });
  const yTitleInput = el('input.input', { type: 'text', value: draft.yTitle || '', 'aria-label': 'Vertical axis title', placeholder: 'Optional', maxlength: 80 });
  const y2TitleInput = el('input.input', { type: 'text', value: draft.y2Title || '', 'aria-label': 'Secondary axis title', placeholder: 'Optional', maxlength: 80 });
  const y2TitleField = el('label.field', {}, el('span.field-label', {}, 'Secondary axis title'), y2TitleInput);
  const axisRow = el('div.row.row-2', {},
    el('label.field', {}, el('span.field-label', {}, 'Horizontal axis title'), xTitleInput),
    el('label.field', {}, el('span.field-label', {}, 'Vertical axis title'), yTitleInput), y2TitleField);

  // The fields a problem can be laid at; the message names it and the field at fault is marked and focused.
  const checkedFields = [rangeInput, yMinInput, yMaxInput, binsInput, ...sourceInputs.flatMap(s => [s.categories, s.values, ...(s.sizes ? [s.sizes] : [])])];
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
    draft.stacked = stackedBox.checked;
    draft.stack100 = stackedBox.checked && stack100Box.checked;
    draft.trendline = trendBox.checked; draft.secondaryAxis = axis2Box.checked;
    y2TitleField.hidden = draft.type !== 'combo' || !draft.secondaryAxis;
    draft.legend = legendSel.value !== 'none';
    if (legendSel.value !== 'none') draft.legendPos = legendSel.value;
    draft.labels = labelsBox.checked;
    draft.gridlines = gridBox.checked;
    draft.smooth = smoothBox.checked;
    draft.includeHidden = hiddenBox.checked;
    const yMin = yMinInput.value.trim() === '' ? null : Number(yMinInput.value);
    const yMax = yMaxInput.value.trim() === '' ? null : Number(yMaxInput.value);
    if (yMin != null && yMax != null && yMin >= yMax) return problem('The axis minimum must be below the maximum', yMinInput, yMaxInput);
    draft.yMin = Number.isFinite(yMin) ? yMin : null;
    draft.yMax = Number.isFinite(yMax) ? yMax : null;
    const bins = binsInput.value.trim() === '' ? null : Number(binsInput.value);
    const binsOk = bins == null || (Number.isInteger(bins) && bins >= 2 && bins <= 100);
    // The field is hidden for every type but histogram, so only a histogram is held up by what it says.
    if (draft.type === 'histogram' && !binsOk) return problem('Bins must be a whole number from 2 to 100', binsInput);
    draft.bins = binsOk ? bins : null;
    return null;
  }

  // The range is read again only when something it depends on changes: a large range takes
  // hundreds of milliseconds to read, and a title keystroke must not pay that.
  let dataKey = null;
  let dataCache = null;
  function readData() {
    const r = draft.range;
    const key = [wb.version, r.r1, r.c1, r.r2, r.c2, draft.seriesIn, draft.headers, draft.type, draft.includeHidden, JSON.stringify(draft.sourceRefs), draft.titleRef, draft.xTitleRef, draft.yTitleRef, draft.y2TitleRef].join('|');
    if (key !== dataKey) { dataKey = key; dataCache = chartData(wb, sheetId, draft); }
    return dataCache;
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
    // Resolve linked names through the same live data as the legend and colors.
    // Updating a heading must not replace the source's name reference or cache.
    sourceInputs.forEach((s, i) => { s.heading.textContent = data.series[i]?.name || s.source.name || `Series ${i + 1}`; });
    preview.innerHTML = renderChartSvg(data, draft, draft.appearance ? draft.w : 440, draft.appearance ? draft.h : 230);
    syncColors(data);
  }
  // Typing a title redraws the preview once the typing pauses, not on every character.
  let redraw = 0;
  const refreshSoon = () => { clearTimeout(redraw); redraw = setTimeout(refresh, 150); };
  for (const input of sourceInputs.flatMap(s => [s.categories, s.values, ...(s.sizes ? [s.sizes] : [])])) input.addEventListener('input', refreshSoon);
  for (const input of [rangeInput, seriesSel, headersSel, stackedBox, stack100Box, trendBox, axis2Box, legendSel, labelsBox, gridBox, smoothBox, hiddenBox, yMinInput, yMaxInput, binsInput]) input.addEventListener('input', refresh);
  for (const input of [titleInput, descriptionInput, xTitleInput, yTitleInput, y2TitleInput]) input.addEventListener('input', refreshSoon);
  for (const input of [seriesSel, headersSel, stackedBox, stack100Box, trendBox, axis2Box, legendSel, labelsBox, gridBox, smoothBox, hiddenBox]) input.addEventListener('change', refresh);

  const submit = (e) => {
    e?.preventDefault();
    if (!canChange()) return;
    const problem = readForm();
    if (problem) { refresh(); problem.fields[0].focus(); return; }
    if (chart) {
      wb.updateChart(sheetId, chart.id, {
        type: draft.type, range: draft.range, title: draft.title, description: draft.description, seriesIn: draft.seriesIn, headers: draft.headers, stacked: draft.stacked, stack100: draft.stack100, trendline: draft.trendline,
        legend: draft.legend, legendPos: draft.legendPos, labels: draft.labels, gridlines: draft.gridlines, smooth: draft.smooth, xTitle: draft.xTitle, yTitle: draft.yTitle, y2Title: draft.y2Title,
        colors: draft.colors, yMin: draft.yMin, yMax: draft.yMax, bins: draft.bins, secondaryAxis: draft.secondaryAxis, includeHidden: draft.includeHidden,
        ...(draft.sourceRefs ? { sourceRefs: draft.sourceRefs } : {}),
        titleRef: draft.titleRef, xTitleRef: draft.xTitleRef, yTitleRef: draft.yTitleRef, y2TitleRef: draft.y2TitleRef,
      });
      modal.close();
      ctx.grid.selectChart(chart.id);
      return;
    }
    // Place the new chart just right of its data, or below when there is no room.
    const r = draft.range;
    let anchor = { r: r.r1, c: r.c2 + 1 };
    if (anchor.c + 4 > sheet.cols) anchor = { r: r.r2 + 2, c: r.c1 };
    // Below data in the sheet's last rows the grid would draw the chart clamped onto that data, and
    // move it once the sheet grew: the sheet grows now to hold the whole chart, as typing there would.
    // At the grid's very bottom, where it cannot, the chart goes right of the data after all.
    const rowsNeeded = anchor.r + 1 + Math.ceil(((draft.dy || 0) + draft.h) / sheet.defaultRowHeight);
    if (rowsNeeded > sheet.rows) wb.ensureSize(sheetId, rowsNeeded, sheet.cols);
    if (anchor.r >= sheet.rows) {
      anchor = { r: r.r1, c: r.c2 + 1 };
      if (anchor.c >= sheet.cols) wb.ensureSize(sheetId, sheet.rows, anchor.c + 1);
    }
    const id = wb.addChart(sheetId, { ...draft, anchor });
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
        axisRow,
        boundsRow,
        binsField,
        el('div.row.row-2', {},
          el('label.field', {}, el('span.field-label', {}, 'Legend'), legendSel),
          el('div.field', {}, el('span.field-label', {}, 'Options'), el('div.check-group', {}, labelsField, gridField, smoothField, hiddenField))),
        el('div.row', {}, stackedField),
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
