/**
 * Chart elements inside a selected chart, picked and formatted: a click selects
 * the title, legend, plot area, an axis, a series (a second click one of its points), with handles
 * shown round it; a double-click opens the Format pane on the right for it; typing while the title is
 * selected edits the title in place; Delete removes the selected element.
 *
 * The element is a key: chartArea, plotArea, title, legend, xAxis, yAxis, y2Axis, xTitle, yTitle,
 * gridlines-x, gridlines-y, series:j, point:j:i, dataLabels:j, trendline:j, trendlineLabel:j, errorBars:j (see chart-design.js).
 */
import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { activeChart, isChartObject, ringCountOf, seriesCountOf } from './chart-actions.js';
import { chartElementKeys, elementLabel } from './chart-ribbon.js';
import { seriesColor } from './chartsvg.js';
import { chartData, chartTitles, chartXBounds, chartXBoundsPatch, CHART_DASH_CHOICES, CHART_DISPLAY_UNITS } from '../core/charts.js';
import { chartElementPatch, dataLabelPositions, elementFormatPatch, isPieChart, trendlineAllowed, trendlinePatch } from '../core/chart-design.js';
import { INTERCEPT_TYPES, TREND_LABEL_SIZE, TREND_TYPES, trendFor, trendName, trendProblem } from '../core/trendline.js';
import { ERROR_BAR_CAP_WIDTH, ERROR_BAR_COLOR, ERROR_BAR_TYPES, errorBarAmountInput, errorBarsAllowed, errorBarsFor, errorBarsPatch, normalizeErrorBars } from '../core/error-bars.js';
import { barSpacing, CHART_LINE_GREY } from '../core/chart-subtypes.js';
import { formatAxisTickValues, parseAxisTickValues } from '../core/axis-tick-values.js';

const PANE_TITLES = { chartArea: 'Format Chart Area', plotArea: 'Format Plot Area', title: 'Format Chart Title', legend: 'Format Legend',
  xAxis: 'Format Axis', yAxis: 'Format Axis', y2Axis: 'Format Axis', xTitle: 'Format Axis Title', yTitle: 'Format Axis Title',
  'gridlines-x': 'Format Gridlines', 'gridlines-y': 'Format Gridlines' };
const KEY_TITLES = [[/^series:/, 'Format Data Series'], [/^point:/, 'Format Data Point'], [/^dataLabels:/, 'Format Data Labels'],
  [/^trendline:/, 'Format Trendline'], [/^trendlineLabel:/, 'Format Trendline Label'], [/^errorBars:/, 'Format Error Bars']];
const AXIS_KEYS = ['xAxis', 'yAxis', 'y2Axis'];
/** An axis named by where it runs and what it measures: a scatter chart's both axes measure values, a bar chart's categories run down the side. */
export function axisName(chart, key) {
  if (key === 'y2Axis') return 'Secondary Vertical (Value) Axis';
  const scatter = chart.type === 'scatter' || chart.type === 'bubble', bar = chart.type === 'bar';
  if (key === 'xAxis') return `${bar ? 'Vertical' : 'Horizontal'} (${scatter ? 'Value' : 'Category'}) Axis`;
  return `${bar ? 'Horizontal' : 'Vertical'} (Value) Axis`;
}
const AXIS_PLOTS = new Set(['line', 'area', 'column', 'bar', 'combo', 'scatter', 'bubble', 'histogram']);
export const paneTitle = key => PANE_TITLES[key] || KEY_TITLES.find(([pattern]) => pattern.test(key))?.[1] || 'Format';

/** The element key a press on an SVG node names, given the element selected before it (a second press on a series picks its point). */
export function elementForNode(node, previous = null) {
  const hit = node?.closest?.('[data-el]');
  if (!hit) return 'chartArea';
  const kind = hit.getAttribute('data-el'), j = hit.getAttribute('data-series'), i = hit.getAttribute('data-point');
  if (kind === 'series' && j != null) {
    if (i != null && (previous === `series:${j}` || previous?.startsWith(`point:${j}:`))) return `point:${j}:${i}`;
    return `series:${j}`;
  }
  if (kind === 'dataLabels') return `dataLabels:${j ?? 0}`;
  if ((kind === 'trendline' || kind === 'trendlineLabel' || kind === 'errorBars') && j != null) return `${kind}:${j}`;
  return kind;
}

/** The SVG nodes an element key draws, for its selection handles. */
function nodesFor(svg, key) {
  if (!svg) return [];
  let m = /^series:(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="series"][data-series="${m[1]}"]`)];
  m = /^point:(\d+):(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="series"][data-series="${m[1]}"][data-point="${m[2]}"]`)];
  m = /^(dataLabels|trendline|trendlineLabel|errorBars):(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="${m[1]}"][data-series="${m[2]}"]`)];
  if (key === 'chartArea') return [];
  return [...svg.querySelectorAll(`[data-el="${key}"]`)];
}

export function createChartUi(ctx) {
  let chartId = null;
  let element = 'chartArea';
  let paneKey = null; // the element the open pane formats
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); syncOverlay(); renderPane(); ctx.notify?.(); };

  /* ---------- Selection handles ---------- */
  let overlay = null, observed = null;
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => requestAnimationFrame(syncOverlay)) : null;
  function boxOf(id) { return id ? [...ctx.grid.el.querySelectorAll('.chart-box[data-chart]')].find(b => b.dataset.chart === id) || null : null; }
  function syncOverlay() {
    const box = boxOf(chartId);
    if (observed !== box) { observer?.disconnect(); observed = box; if (box) observer?.observe(box.querySelector('.chart-body') || box, { childList: true, subtree: true }); }
    if (!box || element === 'chartArea') { overlay?.remove(); overlay = null; return; }
    const svg = box.querySelector('.chart-body svg'), nodes = nodesFor(svg, element);
    if (!nodes.length) { overlay?.remove(); overlay = null; return; }
    if (!overlay) overlay = el('div.chart-el-overlay', { 'aria-hidden': 'true' });
    if (overlay.parentNode !== box) box.append(overlay);
    const base = box.getBoundingClientRect();
    const rects = nodes.slice(0, 400).map(n => n.getBoundingClientRect()).filter(r => r.width || r.height);
    // A series shows a handle on each of its marks; anything else, a frame with corner handles.
    const many = /^series:/.test(element) || /^dataLabels:/.test(element);
    const scaleX = box.offsetWidth ? base.width / box.offsetWidth : 1, scaleY = box.offsetHeight ? base.height / box.offsetHeight : 1;
    const local = r => ({ x: (r.left - base.left) / scaleX, y: (r.top - base.top) / scaleY, w: r.width / scaleX, h: r.height / scaleY });
    if (many) {
      overlay.replaceChildren(...rects.map(local).map(r => el('span.chart-el-handle', { style: { left: `${r.x + r.w / 2 - 3}px`, top: `${r.y + Math.min(r.h / 2, 3) - 3}px` } })));
    } else {
      const all = rects.map(local);
      const x1 = Math.min(...all.map(r => r.x)), y1 = Math.min(...all.map(r => r.y));
      const x2 = Math.max(...all.map(r => r.x + r.w)), y2 = Math.max(...all.map(r => r.y + r.h));
      // A trendline label's corners resize it (see resizeTrendLabel), as the chart's own corner does the chart.
      const resizable = /^trendlineLabel:/.test(element) && !ctx.wb.sheet(ctx.sheetId())?.protected;
      const frame = el(`span.chart-el-frame${resizable ? '.resizable' : ''}`, { style: { left: `${x1 - 2}px`, top: `${y1 - 2}px`, width: `${x2 - x1 + 4}px`, height: `${y2 - y1 + 4}px` } },
        ...['nw', 'ne', 'sw', 'se'].map(c => el(`span.chart-el-corner.${c}`, resizable ? { title: 'Resize', dataset: { corner: c } } : {})));
      overlay.replaceChildren(frame);
    }
  }

  function setElement(key, { announce = true } = {}) {
    element = key || 'chartArea';
    if (paneKey && !pane.hidden) paneKey = element;
    if (announce) {
      const chart = activeChart(ctx);
      const names = chart ? chartData(ctx.wb, ctx.sheetId(), chart).series.map(s => s.name) : [];
      ctx.announce?.(`${elementLabel(element, names)} selected`);
    }
    changed();
  }

  /** The grid says which chart is selected (or none). */
  function chartSelected(id) {
    const chart = id ? ctx.wb.chartById(ctx.sheetId(), id) : null;
    const next = isChartObject(chart) ? id : null;
    if (next !== chartId) { chartId = next; element = 'chartArea'; cancelTitleEdit(); }
    if (!chartId && !pane.hidden && !activeChart(ctx)) hidePane();
    changed();
  }

  /* ---------- Pointer: pick an element, double-click to format it ---------- */
  const chartAt = target => {
    const box = target?.closest?.('.chart-box[data-chart]');
    const chart = box && ctx.wb.chartById(ctx.sheetId(), box.dataset.chart);
    return isChartObject(chart) ? { box, chart } : null;
  };
  function onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.chart-tool, .chart-resize, .chart-title-editor')) return;
    const hit = chartAt(e.target);
    if (!hit) return;
    const corner = hit.chart.id === chartId && e.target.closest('.chart-el-frame.resizable .chart-el-corner');
    if (corner) { resizeTrendLabel(e, corner.dataset.corner); return; }
    // A trendline label in the selected chart moves where it is dragged, rather than the chart.
    const label = hit.chart.id === chartId && e.target.closest('[data-el="trendlineLabel"]');
    if (label && !ctx.wb.sheet(ctx.sheetId())?.protected) { dragTrendLabel(e, label); return; }
    const previous = hit.chart.id === chartId ? element : null;
    const key = elementForNode(e.target, previous);
    // The grid selects the chart on the same press; the element follows once it has.
    setTimeout(() => { if (chartId !== hit.chart.id) chartSelected(hit.chart.id); if (element !== key) setElement(key); }, 0);
  }
  /** A trendline label follows the pointer; where it is let go becomes its place (labelPos), until Reset Position. */
  function dragTrendLabel(e, label) {
    e.preventDefault();
    e.stopPropagation();
    const j = +label.getAttribute('data-series'), key = `trendlineLabel:${j}`;
    if (element !== key) setElement(key);
    const svg = label.closest('svg'), [, , vw, vh] = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number), rect = svg.getBoundingClientRect();
    const view = { width: vw || rect.width || 1, height: vh || rect.height || 1 };
    const sx = rect.width / view.width || 1, sy = rect.height / view.height || 1;
    const left = Number(label.getAttribute('data-left')), top = Number(label.getAttribute('data-top'));
    let dx = 0, dy = 0;
    const move = ev => {
      dx = (ev.clientX - e.clientX) / sx;
      dy = (ev.clientY - e.clientY) / sy;
      label.setAttribute('transform', `translate(${dx} ${dy})`);
      syncOverlay();
    };
    const end = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      label.removeAttribute('transform');
      const chart = activeChart(ctx), clamp = v => Math.min(1, Math.max(0, v));
      // A press that barely moves only selects the label.
      if (ev.type === 'pointercancel' || !chart || Math.hypot(dx * sx, dy * sy) < 3) { syncOverlay(); return; }
      const patch = trendlinePatch(chart, j, { labelPos: { x: clamp((left + dx) / view.width), y: clamp((top + dy) / view.height) } }, seriesCountOf(ctx.wb, ctx.sheetId(), chart));
      if (patch) ctx.run('chart', { action: 'patch', patch, label: 'Move trendline label' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  /**
   * A corner of the selected trendline label scales its text (labelSize), the opposite corner staying put; where
   * it ends up becomes its place (labelPos), so the chart does not lay it out afresh at its new size.
   */
  function resizeTrendLabel(e, corner) {
    const m = /^trendlineLabel:(\d+)$/.exec(element), svg = boxOf(chartId)?.querySelector('.chart-body svg');
    const label = m && svg?.querySelector(`[data-el="trendlineLabel"][data-series="${m[1]}"]`);
    if (!label || ctx.wb.sheet(ctx.sheetId())?.protected) return;
    e.preventDefault();
    e.stopPropagation();
    const j = +m[1], [, , vw, vh] = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number), rect = svg.getBoundingClientRect();
    const view = { width: vw || rect.width || 1, height: vh || rect.height || 1 };
    const sx = rect.width / view.width || 1, sy = rect.height / view.height || 1;
    const num = name => Number(label.getAttribute(`data-${name}`)) || 0;
    const left = num('left'), top = num('top'), w = num('width') || 1, h = num('height') || 1, size = num('size') || 11;
    // Which way the corner grows the label, and the corner opposite it, which stays where it is.
    const ex = corner.includes('e') ? 1 : -1, ey = corner.includes('s') ? 1 : -1;
    const fx = ex > 0 ? left : left + w, fy = ey > 0 ? top : top + h;
    let scale = 1, moved = 0;
    const scaleFor = ev => {
      const dx = (ev.clientX - e.clientX) / sx, dy = (ev.clientY - e.clientY) / sy;
      moved = Math.hypot(dx * sx, dy * sy);
      // How far the pointer went along the label's diagonal, as a share of it.
      const grown = size * (1 + (ex * dx * w + ey * dy * h) / (w * w + h * h));
      return Math.min(TREND_LABEL_SIZE.max, Math.max(TREND_LABEL_SIZE.min, grown)) / size;
    };
    const move = ev => {
      scale = scaleFor(ev);
      label.setAttribute('transform', `translate(${fx} ${fy}) scale(${scale}) translate(${-fx} ${-fy})`);
      syncOverlay();
    };
    const end = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      label.removeAttribute('transform');
      const chart = activeChart(ctx), clamp = v => Math.min(1, Math.max(0, v));
      if (ev.type !== 'pointercancel') scale = scaleFor(ev);
      if (ev.type === 'pointercancel' || !chart || moved < 3 || Math.abs(scale - 1) < 1e-3) { syncOverlay(); return; }
      const x = ex > 0 ? fx : fx - w * scale, y = ey > 0 ? fy : fy - h * scale;
      const patch = trendlinePatch(chart, j, { labelSize: Math.round(size * scale * 100) / 100, labelPos: { x: clamp(x / view.width), y: clamp(y / view.height) } },
        seriesCountOf(ctx.wb, ctx.sheetId(), chart));
      if (patch) ctx.run('chart', { action: 'patch', patch, label: 'Resize trendline label' });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  function onDoubleClick(e) {
    const hit = chartAt(e.target);
    if (!hit || e.target.closest('.chart-tool')) return;
    e.preventDefault();
    e.stopPropagation();
    if (chartId !== hit.chart.id) chartSelected(hit.chart.id);
    const key = elementForNode(e.target, element);
    setElement(key, { announce: false });
    openPane(key);
  }

  /* ---------- Keys: type a title, delete an element ---------- */
  let titleEditor = null;
  function cancelTitleEdit() { titleEditor?.remove(); titleEditor = null; }
  function editTitle(initial = null) {
    const chart = activeChart(ctx), box = boxOf(chart?.id);
    if (!chart || !box) return;
    cancelTitleEdit();
    const svg = box.querySelector('.chart-body svg'), node = svg?.querySelector('[data-el="title"]');
    const base = box.getBoundingClientRect(), rect = node?.getBoundingClientRect();
    // A title linked to a cell shows that cell's text, not the text saved with the chart: that is what is edited.
    const shown = chartTitles(ctx.wb, ctx.sheetId(), chart).title ?? chart.title ?? '';
    const input = el('input.chart-title-editor', { type: 'text', value: initial ?? shown, 'aria-label': 'Chart title', maxlength: 200, spellcheck: false });
    if (rect) Object.assign(input.style, { top: `${rect.top - base.top - 4}px`, left: `${Math.max(4, rect.left - base.left - 20)}px`, width: `${Math.max(160, rect.width + 40)}px` });
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      cancelTitleEdit();
      if (commit && text !== shown.trim()) ctx.run('chart', { action: 'patch', patch: { title: text, titleRef: undefined }, label: 'Edit chart title' });
      ctx.grid.selectChart(chart.id);
      setElement(text ? 'title' : 'chartArea', { announce: false });
    };
    input.addEventListener('keydown', e => {
      if (isComposing(e)) return;
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    titleEditor = input;
    box.append(input);
    input.focus();
    if (initial == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
  }

  /** The grid hands a key pressed on a selected chart here first; true when the chart element took it. */
  function onChartKey(e, id) {
    if (isComposing(e) || id !== chartId) return false;
    const chart = activeChart(ctx);
    if (!chart || ctx.wb.sheet(ctx.sheetId())?.protected) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (element === 'title' && !mod && !e.altKey && (e.key.length === 1 || e.key === 'F2')) {
      e.preventDefault();
      editTitle(e.key === 'F2' ? null : e.key);
      return true;
    }
    if (e.key === 'Escape' && element !== 'chartArea') { e.preventDefault(); setElement('chartArea'); return true; }
    // Delete takes a trendline off its series, or its label off the trendline.
    const trend = /^(trendline|trendlineLabel):(\d+)$/.exec(element);
    if ((e.key === 'Delete' || e.key === 'Backspace') && trend) {
      e.preventDefault();
      const j = +trend[2], line = trend[1] === 'trendline';
      const patch = trendlinePatch(chart, j, line ? null : { dispEq: false, dispRSqr: false }, seriesCountOf(ctx.wb, ctx.sheetId(), chart));
      if (patch && trendFor(chart, j)) ctx.run('chart', { action: 'patch', patch, label: line ? 'Delete trendline' : 'Delete trendline label' });
      setElement('chartArea', { announce: false });
      return true;
    }
    // Delete takes a series' error bars away, both directions.
    const errors = /^errorBars:(\d+)$/.exec(element);
    if ((e.key === 'Delete' || e.key === 'Backspace') && errors) {
      e.preventDefault();
      const j = +errors[1], list = (chart.errorBars || []).slice();
      list[j] = null;
      if (errorBarsFor(chart, j)) ctx.run('chart', { action: 'patch', patch: { errorBars: normalizeErrorBars(list) || undefined }, label: 'Delete error bars' });
      setElement('chartArea', { announce: false });
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && element !== 'chartArea') {
      const removal = {
        title: ['chartTitle', 'none'], legend: ['legend', 'none'],
        xTitle: ['axisTitles', { axis: chart.type === 'bar' ? 'vertical' : 'horizontal', on: false }],
        yTitle: ['axisTitles', { axis: chart.type === 'bar' ? 'horizontal' : 'vertical', on: false }],
        xAxis: ['axes', { axis: 'category', on: false }], yAxis: ['axes', { axis: 'value', on: false }],
        'gridlines-y': ['gridlines', { axis: chart.type === 'bar' ? 'vertical' : 'horizontal', on: false }],
        'gridlines-x': ['gridlines', { axis: chart.type === 'bar' ? 'horizontal' : 'vertical', on: false }],
      }[element] || (/^dataLabels:/.test(element) ? ['dataLabels', 'none'] : null);
      // The secondary axis goes on its own; the plot area, a series or a point has nothing to delete, and
      // the key must not reach the grid, which would delete the whole chart.
      if (element === 'y2Axis' && chart.appearance) {
        e.preventDefault();
        ctx.run('chart', { action: 'patch', patch: { appearance: { ...chart.appearance, hideY2Axis: true } }, label: 'Delete axis' });
        setElement('chartArea', { announce: false });
        return true;
      }
      if (!removal) return /^(series|point):|^plotArea$/.test(element) ? (e.preventDefault(), true) : false;
      e.preventDefault();
      ctx.run('chart', { action: 'element', element: removal[0], value: removal[1] });
      setElement('chartArea', { announce: false });
      return true;
    }
    return false;
  }

  /* ---------- The Format pane ---------- */
  const paneTitleEl = el('h2.chart-pane-title');
  const paneBody = el('div.chart-pane-body');
  const pane = el('section.chart-format-pane', { role: 'region', 'aria-label': 'Format chart element', hidden: true },
    el('div.chart-pane-head', {}, paneTitleEl,
      el('button.icon-btn', { type: 'button', 'aria-label': 'Close Format pane', html: icon('x', 16), onclick: () => hidePane() })),
    paneBody);
  let paneSig = null;

  function openPane(key = element) {
    paneKey = key;
    pane.hidden = false;
    paneSig = null;
    renderPane();
    pane.querySelector('input, select, button:not(.icon-btn)')?.focus();
    ctx.onPaneToggle?.(true);
  }
  function hidePane() {
    if (pane.hidden) return;
    pane.hidden = true;
    paneKey = null;
    ctx.onPaneToggle?.(false);
    ctx.grid.focus();
  }

  // A change made in the pane redraws it at once (a Solid fill shows its colour, a logarithmic scale its base), the
  // control in use keeping the focus; a change from elsewhere waits until the pane is left, not to upset typing.
  let ownChange = false;
  const apply = (patch, label = 'Format chart') => { if (patch) { ownChange = true; ctx.run('chart', { action: 'patch', patch, label }); } };
  const controlKey = n => n?.getAttribute?.('aria-label') || (n?.closest?.('label') ? `label:${n.closest('label').textContent}` : n?.tagName === 'SUMMARY' ? `summary:${n.textContent}` : null);
  const format = opts => { const chart = activeChart(ctx); if (chart) apply(elementFormatPatch(chart, paneKey, { ...opts, rings: ringCountOf(ctx.wb, ctx.sheetId(), chart) })); };

  function section(title, ...content) {
    return el('details.chart-pane-section', { open: true }, el('summary', {}, title), el('div.chart-pane-fields', {}, ...content.flat(Infinity).filter(Boolean)));
  }
  const field = (label, control) => el('label.chart-pane-field', {}, el('span', {}, label), control);
  const color = (label, value, onPick) => {
    const input = el('input.chart-pane-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff', 'aria-label': label });
    input.addEventListener('change', () => onPick(input.value));
    return field(label, input);
  };
  const number = (label, value, onSet, { min = null, max = null, step = 'any', placeholder = 'Auto' } = {}) => {
    const input = el('input.input.chart-pane-number', { type: 'number', step, value: value ?? '', placeholder, 'aria-label': label, ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) });
    // A value the field refuses goes back to the one the chart keeps, rather than showing what the chart does not draw.
    input.addEventListener('change', () => {
      const before = ctx.wb.version, v = input.value.trim() === '' ? null : Number(input.value);
      if (v === null || Number.isFinite(v)) onSet(v);
      if (ctx.wb.version === before) input.value = value ?? '';
    });
    return field(label, input);
  };
  const checkbox = (label, checked, onSet) => {
    const input = el('input', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', () => onSet(input.checked));
    return el('label.check', {}, input, el('span', {}, label));
  };
  const choice = (label, value, options, onSet) => {
    const select = el('select.select', { 'aria-label': label }, ...options.map(([v, text]) => el('option', { value: v }, text)));
    select.value = value;
    select.addEventListener('change', () => onSet(select.value));
    return field(label, select);
  };
  const text = (label, value, onSet, { placeholder = null } = {}) => {
    const input = el('input.input', { type: 'text', value: value ?? '', 'aria-label': label, ...(placeholder ? { placeholder } : {}) });
    input.addEventListener('change', () => onSet(input.value));
    return field(label, input);
  };

  /** Fill & Line for the element: its fill (where it has one) and its border or line. */
  function fillAndLine(chart, key) {
    // A trendline's line, and error bars', are set in their own options.
    if (/^(trendline|errorBars)/.test(key)) return null;
    const a = chart.appearance || {};
    const seriesIndex = /^(?:series|point):(\d+)/.exec(key)?.[1];
    const lineOnly = /^(xAxis|yAxis|y2Axis|gridlines-)/.test(key) || (seriesIndex != null && ['line', 'scatter', 'radar'].includes(chart.type) && !/^point/.test(key));
    // A chart in the app's own style takes a series' colour and nothing else here (see elementFormatPatch).
    if (!chart.appearance && (!/^series:\d+$/.test(key) || lineOnly)) return null;
    const fills = {
      chartArea: a.background, plotArea: a.plotFill, title: a.titleBox?.fill, legend: a.legendBox?.fill,
    };
    const lines = {
      chartArea: a.border === false ? 'none' : a.borderColor, plotArea: a.plotStroke, title: a.titleBox?.stroke, legend: a.legendBox?.stroke,
      xAxis: a.axisStyles?.x?.color, yAxis: a.axisStyles?.y?.color, y2Axis: a.axisStyles?.y2?.color,
      'gridlines-x': a.gridlineStyles?.x?.color, 'gridlines-y': a.gridlineStyles?.y?.color,
    };
    const lineWidths = {
      chartArea: a.borderWidth, plotArea: a.plotStrokeWidth, xAxis: a.axisStyles?.x?.width, yAxis: a.axisStyles?.y?.width, y2Axis: a.axisStyles?.y2?.width,
      'gridlines-x': a.gridlineStyles?.x?.width, 'gridlines-y': a.gridlineStyles?.y?.width,
    };
    // A slice shows its category's colour; a ring of a doughnut of several series, its own colour first.
    const pointIndex = /^point:\d+:(\d+)$/.exec(key)?.[1];
    const ringColor = pointIndex != null && chart.type === 'donut' && ringCountOf(ctx.wb, ctx.sheetId(), chart) > 1
      ? (a.pointColors?.[+seriesIndex] || []).find(p => p.index === +pointIndex)?.color : null;
    const chosen = pointIndex != null && isPieChart(chart) ? ringColor ?? chart.colors?.[+pointIndex] : seriesIndex != null ? chart.colors?.[+seriesIndex] : null;
    const fill = fills[key] ?? chosen;
    const line = lines[key] ?? (seriesIndex != null ? (isPieChart(chart) ? a.pie?.stroke : a.bars?.[+seriesIndex]?.stroke ?? a.lines?.[+seriesIndex]?.color) : null);
    const seriesLine = a.lines?.[+seriesIndex] || a.lineDefault;
    // A series (or slice) on its automatic colour shows the colour it is drawn in, not the first series'.
    const drawn = seriesIndex == null ? '#4472c4' : pointIndex != null && isPieChart(chart) ? ringColor ?? seriesColor(chart, +pointIndex)
      : lineOnly ? seriesLine?.color || seriesColor(chart, +seriesIndex) : seriesColor(chart, +seriesIndex);
    const width = lineWidths[key] ?? (seriesIndex != null ? (isPieChart(chart) ? a.pie?.strokeWidth : a.bars?.[+seriesIndex]?.strokeWidth ?? (lineOnly ? seriesLine?.width : null)) : null);
    const parts = [];
    if (!lineOnly && !/^(xTitle|yTitle|dataLabels)/.test(key)) {
      const kind = fill === 'none' ? 'none' : fill ? 'solid' : 'auto';
      parts.push(el('h3.chart-pane-sub', {}, 'Fill'),
        choice('Fill', kind, [['auto', 'Automatic'], ['none', 'No fill'], ['solid', 'Solid fill']], v => format({ fill: v === 'none' ? 'none' : v === 'solid' ? (fill && fill !== 'none' ? fill : drawn) : null })),
        kind === 'solid' ? color('Fill Color', fill, v => format({ fill: v })) : null);
    }
    if (chart.appearance && !/^(xTitle|yTitle|dataLabels|point)/.test(key)) {
      const kind = line === 'none' ? 'none' : line ? 'solid' : 'auto';
      parts.push(el('h3.chart-pane-sub', {}, lineOnly && seriesIndex != null ? 'Line' : 'Border'),
        choice(lineOnly && seriesIndex != null ? 'Line' : 'Border', kind, [['auto', 'Automatic'], ['none', lineOnly ? 'No line' : 'No line'], ['solid', 'Solid line']],
          v => format({ outline: v === 'none' ? 'none' : v === 'solid' ? (line && line !== 'none' ? line : lineOnly && seriesIndex != null ? drawn : '#595959') : null })),
        kind === 'solid' || (lineOnly && seriesIndex != null) ? color('Line Color', line && line !== 'none' ? line : lineOnly && seriesIndex != null ? drawn : '#4472c4', v => format({ outline: v })) : null,
        // The width the line is drawn at, in points as Excel gives it; a title's or legend's border keeps no width of its own.
        key === 'title' || key === 'legend' ? null : number('Width (pt)', Number.isFinite(width) ? Math.round(width * 3 / 4 * 100) / 100 : null,
          v => { if (v != null && v >= 0) format({ outlineWidth: Math.round(v * 4 / 3 * 100) / 100 }); }, { min: 0, max: 20, step: 0.25, placeholder: '' }));
    }
    // This axis' line drawn along both plot edges it runs beside: the top and bottom for a horizontal axis, the
    // left and right for a vertical one; both axes boxed box the whole plot. An axis with no line, or the faint
    // default one that disappears into the gridlines, takes a dark line so the box shows.
    if (chart.appearance && AXIS_KEYS.includes(key)) {
      const k = key === 'xAxis' ? 'x' : key === 'yAxis' ? 'y' : 'y2', st = a.axisStyles?.[k];
      parts.push(checkbox('Box around plot area', !!st?.box, on => {
        const { box, ...rest } = st || { majorTick: 'none', minorTick: 'none' };
        const faint = !rest.color || rest.color === 'none' || rest.color.toLowerCase() === CHART_LINE_GREY;
        apply({ appearance: { ...a, axisStyles: { ...a.axisStyles, [k]: on ? { ...rest, box: true, ...(faint ? { color: '#595959' } : {}) } : rest } } }, 'Box around plot area');
      }));
    }
    return parts.length ? section('Fill & Line', parts) : null;
  }

  function effects(chart, key) {
    const effectKey = /^point:(\d+)/.test(key) ? `series:${key.split(':')[1]}` : key;
    if (!['chartArea', 'plotArea', 'title', 'legend'].includes(effectKey) && !/^series:\d+$/.test(effectKey)) return null;
    if (!chart.appearance) return null;
    const current = chart.appearance.effects?.[effectKey] || {};
    return section('Effects',
      checkbox('Shadow', current.shadow, on => format({ effect: { ...current, shadow: on } })),
      choice('Glow', current.glow || '', [['', 'No glow'], ['#4472c4', 'Blue'], ['#ed7d31', 'Orange'], ['#ffc000', 'Gold'], ['#70ad47', 'Green']],
        v => format({ effect: { ...current, glow: v || null } })));
  }

  function textOptions(chart, styleKey) {
    const a = chart.appearance;
    if (!a?.[styleKey]) return null;
    const st = a[styleKey];
    const set = patch => apply({ appearance: { ...a, [styleKey]: { ...st, ...patch } } });
    return section('Text',
      number('Size (pt)', Math.round(st.size * 3 / 4 * 10) / 10, v => { if (v >= 4 && v <= 72) set({ size: Math.round(v * 4 / 3 * 100) / 100 }); }, { min: 4, max: 72, step: 0.5 }),
      color('Text Color', st.color, v => set({ color: v })),
      checkbox('Bold', st.bold, on => set({ bold: on })),
      checkbox('Italic', st.italic, on => set({ italic: on })));
  }

  /** Format Trendline: its kind, forecast and intercept, its label, its line; a series without one is offered the kinds. */
  function trendlineOptions(chart, j) {
    if (!trendlineAllowed(chart)) return [el('p.chart-pane-note', {}, 'This kind of chart takes no trendline.')];
    const data = chartData(ctx.wb, ctx.sheetId(), chart), s = data.series[j], t = trendFor(chart, j);
    const set = (patch, label = 'Format trendline') => apply(trendlinePatch(chart, j, patch, seriesCountOf(ctx.wb, ctx.sheetId(), chart)), label);
    const kind = choice('Trendline type', t?.type || 'none', [['none', 'None'], ...TREND_TYPES], v => (v === 'none' ? set(null, 'Delete trendline') : set({ type: v })));
    if (!t) return [section('Trendline Options', kind)];
    const fit = t.type !== 'movingAvg', points = s ? s.values.map((v, i) => [['scatter', 'bubble'].includes(chart.type) ? (s.x || data.x)?.[i] : i + 1, v]) : [];
    const problem = s ? trendProblem(points, t) : null;
    return [section('Trendline Options', kind,
      t.type === 'poly' ? number('Order', t.order, v => { if (Number.isInteger(v) && v >= 2 && v <= 6) set({ order: v }); }, { min: 2, max: 6, step: 1, placeholder: '' }) : null,
      t.type === 'movingAvg' ? number('Period', t.period, v => { if (Number.isInteger(v) && v >= 2 && v <= 255) set({ period: v }); }, { min: 2, max: 255, step: 1, placeholder: '' }) : null,
      problem ? el('p.chart-pane-note', { role: 'status' }, problem) : null,
      text('Trendline Name', t.name, v => set({ name: v.trim() }), { placeholder: trendName({ ...t, name: '' }, s?.name ?? `Series${j + 1}`) }),
      fit ? [el('h3.chart-pane-sub', {}, 'Forecast'),
        number('Forward (periods)', t.forward, v => { if (v == null || v >= 0) set({ forward: v ?? 0 }); }, { min: 0, placeholder: '0' }),
        number('Backward (periods)', t.backward, v => { if (v == null || v >= 0) set({ backward: v ?? 0 }); }, { min: 0, placeholder: '0' })] : null,
      // An exponential curve can only cross above zero.
      INTERCEPT_TYPES.has(t.type) ? number('Set Intercept', t.intercept, v => { if (v == null || t.type !== 'exp' || v > 0) set({ intercept: v }); }) : null,
      fit ? [checkbox('Display Equation on chart', t.dispEq, on => set({ dispEq: on })), checkbox('Display R-squared value on chart', t.dispRSqr, on => set({ dispRSqr: on }))] : null),
    section('Line',
      choice('Line', t.color ? 'solid' : 'auto', [['auto', 'Automatic'], ['solid', 'Solid line']], v => set({ color: v === 'solid' ? t.color || seriesColor(chart, j) : undefined })),
      t.color ? color('Line Color', t.color, v => set({ color: v })) : null,
      number('Width (pt)', Math.round((t.width ?? 1.5) * 3 / 4 * 100) / 100, v => { if (v != null && v >= 0.25 && v <= 15) set({ width: Math.round(v * 4 / 3 * 100) / 100 }); }, { min: 0.25, max: 15, step: 0.25, placeholder: '' }),
      choice('Dash type', t.dash || 'auto', [['auto', 'Automatic'], ...CHART_DASH_CHOICES],
        v => set({ dash: v === 'auto' ? undefined : v })))];
  }

  /**
   * Format Error Bars: a series' vertical and horizontal bars, each on or off, with its direction, end
   * caps, amount (a fixed value, a percentage, standard deviations, the standard error, or amounts from
   * cells) and line.
   */
  function errorBarOptions(chart, j) {
    if (!errorBarsAllowed(chart)) return [el('p.chart-pane-note', {}, 'Error bars go on scatter and bubble charts.')];
    const sheetId = ctx.sheetId(), data = chartData(ctx.wb, sheetId, chart), count = seriesCountOf(ctx.wb, sheetId, chart);
    const bars = errorBarsFor(chart, j) || {};
    const set = (axis, bar, label = 'Format error bars') => apply(errorBarsPatch(chart, j, axis, bar, count), label);
    // The two directions show the same fields: each control is named for its own, so focus finds it again.
    const named = (node, label) => { node.querySelector('input, select')?.setAttribute('aria-label', label); return node; };
    const pt = px => Math.round(px * 3 / 4 * 100) / 100, px = v => Math.round(v * 4 / 3 * 100) / 100;
    const picker = data.series.length > 1 ? el('div.chart-pane-fields', {},
      choice('Series', String(j), data.series.map((s, k) => [String(k), s.name]), v => setElement(`errorBars:${v}`)),
      errorBarsFor(chart, j) ? el('button.btn.btn-sm', { type: 'button', onclick: () => apply({ errorBars: normalizeErrorBars(Array.from({ length: count }, () => bars)) || undefined }, 'Apply error bars to all series') },
        'Apply to all series') : null) : null;
    const axisSection = (axis, title, word) => {
      const bar = bars[axis];
      const show = checkbox(`Show ${word.toLowerCase()} error bars`, !!bar,
        on => set(axis, on ? bar || bars[axis === 'x' ? 'y' : 'x'] || { type: 'stdErr' } : null, on ? 'Add error bars' : 'Delete error bars'));
      if (!bar) return section(title, show);
      const update = patch => set(axis, patch);
      // A custom amount: cells (=Sheet1!$D$2:$D$9) or numbers (0.5, or 1, 2, 3); one amount stands for every point.
      const amountField = (label, side) => {
        const ref = bar[side], values = bar[`${side}Values`];
        const input = el('input.input', { type: 'text', value: ref ? `=${ref}` : values ? values.join(', ') : '', placeholder: '=Sheet1!$D$2:$D$10', 'aria-label': `${word} ${label.toLowerCase()}` });
        const note = el('p.chart-pane-note', { role: 'alert', hidden: true });
        input.addEventListener('change', () => {
          const result = errorBarAmountInput(ctx.wb, sheetId, input.value, side);
          note.hidden = !result.error;
          note.textContent = result.error || '';
          if (!result.error) update(result);
        });
        return [field(label, input), note];
      };
      const amount = {
        fixedVal: () => named(number('Fixed value', bar.value, v => { if (v != null && v >= 0) update({ value: v }); }, { min: 0, placeholder: '' }), `${word} fixed value`),
        percentage: () => named(number('Percentage (%)', bar.value, v => { if (v != null && v >= 0) update({ value: v }); }, { min: 0, placeholder: '' }), `${word} percentage`),
        stdDev: () => named(number('Standard deviation(s)', bar.value, v => { if (v != null && v >= 0) update({ value: v }); }, { min: 0, placeholder: '' }), `${word} standard deviations`),
        stdErr: () => null,
        cust: () => [amountField('Positive error value', 'plus'), amountField('Negative error value', 'minus'),
          el('p.chart-pane-note', {}, 'A range of cells gives each point its own amount; a single cell or number, every point the same.')],
      }[bar.type]();
      return section(title, show,
        named(choice('Direction', bar.direction, [['both', 'Both'], ['minus', 'Minus'], ['plus', 'Plus']], v => update({ direction: v })), `${word} error bar direction`),
        named(choice('End Style', bar.caps ? 'cap' : 'none', [['cap', 'Cap'], ['none', 'No Cap']], v => update({ caps: v === 'cap' })), `${word} error bar end style`),
        bar.caps ? named(number('Cap width (pt)', pt(bar.capWidth ?? ERROR_BAR_CAP_WIDTH), v => { if (v != null && v >= 0 && v <= 72) update({ capWidth: px(v) }); },
          { min: 0, max: 72, step: 0.5, placeholder: '' }), `${word} error bar cap width (pt)`) : null,
        el('h3.chart-pane-sub', {}, 'Error Amount'),
        named(choice('Error amount', bar.type, ERROR_BAR_TYPES, v => update({ type: v })), `${word} error amount`),
        amount,
        el('h3.chart-pane-sub', {}, 'Line'),
        named(color('Line Color', bar.color || ERROR_BAR_COLOR, v => update({ color: v })), `${word} error bar color`),
        named(number('Width (pt)', pt(bar.width ?? 1), v => { if (v != null && v >= 0.25 && v <= 15) update({ width: px(v) }); }, { min: 0.25, max: 15, step: 0.25, placeholder: '' }),
          `${word} error bar width (pt)`),
        named(choice('Dash type', bar.dash || 'solid', CHART_DASH_CHOICES, v => update({ dash: v === 'solid' ? undefined : v })), `${word} error bar dash type`));
    };
    return [picker, axisSection('y', 'Vertical Error Bars', 'Vertical'), axisSection('x', 'Horizontal Error Bars', 'Horizontal')].filter(Boolean);
  }

  /** Format Trendline Label: what it shows, the number format it shows it in and its text size. */
  function trendlineLabelOptions(chart, j) {
    const t = trendFor(chart, j);
    if (!t) return [];
    const set = patch => apply(trendlinePatch(chart, j, patch, seriesCountOf(ctx.wb, ctx.sheetId(), chart)), 'Format trendline label');
    return [section('Label Options',
      checkbox('Display Equation on chart', t.dispEq, on => set({ dispEq: on })),
      checkbox('Display R-squared value on chart', t.dispRSqr, on => set({ dispRSqr: on })),
      text('Number Format', t.labelFormat || 'General', v => set({ labelFormat: v.trim() || undefined })),
      // Blank goes back to the value axis' text size, which the label follows until it has its own.
      number('Font Size (pt)', t.labelSize ? Math.round(t.labelSize * 3 / 4 * 10) / 10 : null, v => {
        if (v === null) set({ labelSize: undefined });
        else if (v >= 4 && v <= 72) set({ labelSize: Math.round(v * 4 / 3 * 100) / 100 });
      }, { min: 4, max: 72, step: 0.5, placeholder: String(Math.round((chart.appearance?.yStyle?.size || 11) * 3 / 4 * 10) / 10) }),
      // A label dragged somewhere goes back to the place the chart finds for it.
      t.labelPos ? el('button.btn.btn-sm', { type: 'button', onclick: () => set({ labelPos: undefined }) }, 'Reset Position') : null)];
  }

  function options(chart, key) {
    const a = chart.appearance;
    // The axis scale, order, label place and display units are drawn on the plots of series against axes; the
    // newer types draw their own axes (bounds, unit, number format and text), so the pane offers only those there.
    const full = !!a && AXIS_PLOTS.has(chart.type);
    const out = [];
    if (key === 'title') {
      out.push(section('Title Options', text('Text', chartTitles(ctx.wb, ctx.sheetId(), chart).title ?? chart.title, v => apply({ title: v.trim(), titleRef: undefined }, 'Edit chart title'))), textOptions(chart, 'titleStyle'));
    } else if (key === 'legend') {
      out.push(section('Legend Options', choice('Legend Position', chart.legend === false ? 'none' : chart.legendPos, [['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right'], ['none', 'None']],
        v => apply(chartElementPatch(chart, 'legend', v)))), textOptions(chart, 'legendStyle'));
    } else if (key === 'xTitle' || key === 'yTitle') {
      out.push(section('Title Options', text('Text', chartTitles(ctx.wb, ctx.sheetId(), chart)[key] ?? chart[key], v => apply({ [key]: v.trim(), [`${key}Ref`]: undefined }))));
    } else if (key === 'yAxis' || (key === 'y2Axis' && a) || (key === 'xAxis' && (chart.type === 'scatter' || chart.type === 'bubble'))) {
      // A scatter chart's x axis is a value axis too: its bounds, in either style (see chartXBounds).
      // The secondary value axis has the primary's options, its own keys (it draws no logarithmic scale).
      const value = key !== 'xAxis', second = key === 'y2Axis', y = second ? 'y2' : value ? 'y' : 'x';
      const minKey = `${y}Min`, maxKey = `${y}Max`, stepKey = `${y}Step`, logKey = `${y}LogBase`;
      const reverseKey = second ? 'reverseSecondaryValues' : value ? 'reverseValues' : 'reverseCategories';
      const xb = chartXBounds(chart);
      const get = k => (k === 'yMin' || k === 'yMax' ? chart[k] : k === 'xMin' ? xb.min : k === 'xMax' ? xb.max : a?.[k]);
      const setBound = (k, v) => apply(k === 'yMin' || k === 'yMax' ? { [k]: v } : k === 'xMin' ? chartXBoundsPatch(chart, v, xb.max)
        : k === 'xMax' ? chartXBoundsPatch(chart, xb.min, v) : { appearance: { ...a, [k]: v } });
      const units = a?.[`${y}Units`]?.builtIn || 'none';
      // Custom values: ticks only where they are listed, written like pages to print (1, 2, 5-8).
      const tickValues = () => {
        const k = `${y}TickValues`;
        const input = el('input.input', { type: 'text', value: formatAxisTickValues(a[k]), placeholder: 'Auto', 'aria-label': 'Custom values' });
        const note = el('p.chart-pane-note', { role: 'alert', hidden: true });
        input.addEventListener('change', () => {
          const result = parseAxisTickValues(input.value);
          note.hidden = !result.error;
          note.textContent = result.error || '';
          if (result.error) return;
          const next = { ...a };
          if (result.values) next[k] = result.values; else delete next[k];
          apply({ appearance: next }, 'Set axis values');
        });
        return [field('Custom values', input), note, el('p.chart-pane-note', {}, 'Ticks go only at these values, like 1, 2, 5, 8, 12 or 1-5. Leave it empty for automatic ticks.')];
      };
      out.push(section('Axis Options',
        el('h3.chart-pane-sub', {}, 'Bounds'),
        number('Minimum', get(minKey), v => { const max = get(maxKey); if (v == null || max == null || v < max) setBound(minKey, v); }),
        number('Maximum', get(maxKey), v => { const min = get(minKey); if (v == null || min == null || v > min) setBound(maxKey, v); }),
        a ? el('h3.chart-pane-sub', {}, 'Units') : null,
        a ? number('Major', a[stepKey], v => { if (v == null || v > 0) apply({ appearance: { ...a, [stepKey]: v } }); }) : null,
        full ? tickValues() : null,
        full ? choice('Display units', units, [['none', 'None'], ...Object.keys(CHART_DISPLAY_UNITS).map(u => [u, u.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())])],
          v => { const next = { ...a }; const k = `${y}Units`; if (v === 'none') delete next[k]; else next[k] = { builtIn: v, divisor: CHART_DISPLAY_UNITS[v], label: '', style: a[second ? 'y2Style' : 'yStyle'], layout: null, rotation: 0 }; apply({ appearance: next }); }) : null,
        full && !second && !chart.stack100 ? checkbox('Logarithmic scale', a[logKey] > 1, on => { const next = { ...a }; if (on) next[logKey] = 10; else delete next[logKey]; apply({ appearance: next }); }) : null,
        full && !second && a[logKey] > 1 ? number('Base', a[logKey], v => { if (v >= 2 && v <= 1000) apply({ appearance: { ...a, [logKey]: v } }); }, { min: 2, max: 1000, step: 1, placeholder: '10' }) : null,
        full ? checkbox('Values in reverse order', a[reverseKey], on => apply({ appearance: { ...a, [reverseKey]: on } })) : null,
        full ? choice('Label Position', a[`${y}LabelPosition`] || 'nextTo', [['nextTo', 'Next to Axis'], ['high', 'High'], ['low', 'Low'], ['none', 'None']],
          v => apply({ appearance: { ...a, [`${y}LabelPosition`]: v } })) : null),
      a ? section('Number', text('Format Code', a[`${y}Format`] || '', v => apply({ appearance: { ...a, [`${y}Format`]: v.trim().slice(0, 255) } }))) : null,
      textOptions(chart, `${y}Style`));
    } else if (key === 'xAxis') {
      out.push(full ? section('Axis Options',
        checkbox('Categories in reverse order', a.reverseCategories, on => apply({ appearance: { ...a, reverseCategories: on } })),
        choice('Label Position', a.xLabelPosition || 'nextTo', [['nextTo', 'Next to Axis'], ['high', 'High'], ['low', 'Low'], ['none', 'None']], v => apply({ appearance: { ...a, xLabelPosition: v } })),
        number('Custom angle (°)', a.xRotationAuto === false || a.xRotation ? a.xRotation : null, v => apply({ appearance: { ...a, xRotation: v ?? 0, xRotationAuto: v == null } }), { min: -90, max: 90, step: 1 })) : null,
      textOptions(chart, 'xStyle'));
    } else if (/^series:\d+$/.test(key)) {
      const j = +key.split(':')[1];
      const bars = ['column', 'bar', 'combo'].includes(chart.type);
      const lineLike = ['line', 'scatter', 'radar'].includes(chart.type) || (chart.type === 'combo' && j === chartData(ctx.wb, ctx.sheetId(), chart).series.length - 1);
      const line = a ? a.lines?.[j] || a.lineDefault || { width: 2, marker: true, markerSize: 5 } : null;
      const setLine = patch => {
        const lines = [...(a.lines || [])];
        while (lines.length <= j) lines.push({ ...(a.lineDefault || { width: 2, marker: true, markerSize: 5 }) });
        lines[j] = { ...lines[j], ...patch };
        apply({ appearance: { ...a, lines } });
      };
      const fields = [];
      if (bars && a) {
        fields.push(number('Series Overlap (%)', a.overlap ?? 0, v => { if (v != null && v >= -100 && v <= 100) apply({ appearance: { ...a, overlap: v } }); }, { min: -100, max: 100, step: 1 }),
          number('Gap Width (%)', a.gapWidth ?? barSpacing(chart.stacked).gapWidth, v => { if (v != null && v >= 0 && v <= 500) apply({ appearance: { ...a, gapWidth: v } }); }, { min: 0, max: 500, step: 1 }));
      }
      if (chart.type === 'combo') fields.push(checkbox('Plot line on secondary axis', chart.secondaryAxis, on => apply({ secondaryAxis: on })));
      if (isPieChart(chart) && a?.pie) {
        fields.push(number('Angle of first slice (°)', a.pie.firstSliceAngle, v => { if (v != null && v >= 0 && v <= 360) apply({ appearance: { ...a, pie: { ...a.pie, firstSliceAngle: v } } }); }, { min: 0, max: 360, step: 1 }));
        if (chart.type === 'donut') fields.push(number('Doughnut Hole Size (%)', a.pie.holeSize, v => { if (v != null && v >= 10 && v <= 90) apply({ appearance: { ...a, pie: { ...a.pie, holeSize: v } } }); }, { min: 10, max: 90, step: 1 }));
      }
      if (chart.type === 'pie' || chart.type === 'donut') {
        fields.push(number('Pie Explosion (%)', chart.explosion || 0, v => { if (v != null && v >= 0 && v <= 400) apply({ explosion: v || null }); }, { min: 0, max: 400, step: 1 }));
      }
      if (chart.type === 'pie' && chart.ofPie) {
        const setOf = patch => apply({ ofPie: { ...chart.ofPie, ...patch } });
        fields.push(el('h3.chart-pane-sub', {}, 'Second Plot'),
          choice('Second plot', chart.ofPie.kind, [['pie', 'Pie'], ['bar', 'Stacked bar']], v => setOf({ kind: v })),
          number('Values in second plot', chart.ofPie.split, v => { if (Number.isInteger(v) && v >= 1 && v <= 1000) setOf({ split: v }); }, { min: 1, max: 1000, step: 1 }),
          number('Second Plot Size (%)', chart.ofPie.secondSize, v => { if (v != null && v >= 5 && v <= 200) setOf({ secondSize: v }); }, { min: 5, max: 200, step: 1 }),
          number('Gap Width (%)', chart.ofPie.gap, v => { if (v != null && v >= 0 && v <= 500) setOf({ gap: v }); }, { min: 0, max: 500, step: 1 }));
      }
      if (chart.type === 'treemap') {
        fields.push(choice('Parent labels', chart.treemapLabels || 'overlapping', [['overlapping', 'Overlapping'], ['banner', 'Banner'], ['none', 'None']], v => apply({ treemapLabels: v })));
      }
      if (chart.type === 'boxWhisker' && chart.box) {
        const setBox = patch => apply({ box: { ...chart.box, ...patch } });
        fields.push(number('Gap Width (%)', chart.box.gapWidth, v => { if (v != null && v >= 0 && v <= 500) setBox({ gapWidth: v }); }, { min: 0, max: 500, step: 1 }),
          checkbox('Show inner points', chart.box.innerPoints, on => setBox({ innerPoints: on })),
          checkbox('Show outlier points', chart.box.outliers, on => setBox({ outliers: on })),
          checkbox('Show mean markers', chart.box.meanMarkers, on => setBox({ meanMarkers: on })),
          checkbox('Show mean line', chart.box.meanLine, on => setBox({ meanLine: on })),
          choice('Quartile calculation', chart.box.quartiles, [['exclusive', 'Exclusive median'], ['inclusive', 'Inclusive median']], v => setBox({ quartiles: v })));
      }
      if (chart.type === 'funnel' && a) {
        fields.push(number('Gap Width (%)', a.gapWidth ?? 6, v => { if (v != null && v >= 0 && v <= 500) apply({ appearance: { ...a, gapWidth: v } }); }, { min: 0, max: 500, step: 1 }));
      }
      if (chart.type === 'stock') {
        fields.push(el('p.chart-pane-note', {}, { hlc: 'Reads the columns after the dates as High, Low and Close.', ohlc: 'Reads the columns after the dates as Open, High, Low and Close.',
          vhlc: 'Reads the columns after the dates as Volume, High, Low and Close.', vohlc: 'Reads the columns after the dates as Volume, Open, High, Low and Close.' }[chart.stock || 'hlc']));
      }
      if (lineLike && line) {
        fields.push(checkbox('Smoothed line', line.smooth ?? chart.smooth, on => setLine({ smooth: on })),
          choice('Dash type', line.dash || 'solid', CHART_DASH_CHOICES,
            v => setLine({ dash: v === 'solid' ? undefined : v })),
          el('h3.chart-pane-sub', {}, 'Marker'),
          choice('Marker', line.marker === false ? 'none' : line.markerSymbol || 'circle', [['none', 'None'], ['circle', 'Circle'], ['square', 'Square'], ['diamond', 'Diamond'], ['triangle', 'Triangle'], ['x', 'X'], ['plus', 'Plus'], ['star', 'Star'], ['dash', 'Dash']],
            v => setLine(v === 'none' ? { marker: false } : { marker: true, markerSymbol: v })),
          number('Marker Size', line.markerSize ?? 5, v => { if (v >= 2 && v <= 72) setLine({ markerSize: v, markerSizeUnit: 'pt' }); }, { min: 2, max: 72, step: 1 }));
      }
      if (fields.length) out.push(section('Series Options', fields));
    } else if (/^dataLabels:\d+$/.test(key) && a) {
      const j = +key.split(':')[1];
      const labels = a.valueLabels?.[j] || {};
      const setAll = patch => apply({ labels: true, appearance: { ...a, valueLabels: (a.valueLabels || [{}]).map(l => ({ hidden: [], show: true, style: a.xStyle, ...l, ...patch })) } });
      if (!isPieChart(chart)) {
        out.push(section('Label Options',
          choice('Label Position', labels.position || '', [['', 'Automatic'], ...dataLabelPositions(chart).filter(([v]) => v !== 'show')], v => setAll({ position: v || null })),
          text('Number Format', labels.numberFormat || '', v => setAll({ numberFormat: v.trim().slice(0, 255) }))));
      } else if (a.pie) {
        const l = a.pie.labels, setPie = patch => apply({ labels: true, appearance: { ...a, pie: { ...a.pie, labels: { ...l, ...patch } } } });
        out.push(section('Label Options',
          checkbox('Category Name', l.category, on => setPie({ category: on })), checkbox('Value', l.value, on => setPie({ value: on })),
          checkbox('Percentage', l.percent, on => setPie({ percent: on })), checkbox('Show Leader Lines', l.leaderLines, on => setPie({ leaderLines: on })),
          choice('Label Position', l.position, dataLabelPositions(chart), v => setPie({ position: v }))));
      }
    } else if (/^errorBars:\d+$/.test(key)) {
      out.push(...errorBarOptions(chart, +key.split(':')[1]));
    } else if (/^trendline:\d+$/.test(key)) {
      out.push(...trendlineOptions(chart, +key.split(':')[1]));
    } else if (/^trendlineLabel:\d+$/.test(key)) {
      out.push(...trendlineLabelOptions(chart, +key.split(':')[1]));
    } else if (key === 'chartArea' && a) {
      out.push(section('Chart Options',
        checkbox('Rounded corners', a.roundedCorners === true, on => apply({ appearance: { ...a, roundedCorners: on } })),
        choice('Show empty cells as', a.blanks || 'gap', [['gap', 'Gaps'], ['zero', 'Zero'], ['span', 'Connect data points with line']], v => apply({ appearance: { ...a, blanks: v, ...(a.radar ? { radar: { ...a.radar, blanks: v } } : {}) } })),
        checkbox('Show data in hidden rows and columns', chart.includeHidden, on => apply({ includeHidden: on }))));
    }
    return out;
  }

  // Format Axis formats one axis at a time; this picks which, as the axes themselves can be hard to click.
  function axisPicker(chart, key) {
    if (!AXIS_KEYS.includes(key)) return null;
    const keys = chartElementKeys(chart, 0).filter(k => AXIS_KEYS.includes(k));
    if (keys.length < 2) return null;
    return el('div.chart-pane-fields.chart-pane-axis', {}, choice('Axis', key, keys.map(k => [k, axisName(chart, k)]), k => setElement(k)));
  }

  function renderPane() {
    if (pane.hidden) return;
    const chart = activeChart(ctx);
    if (!chart) { hidePane(); return; }
    const key = paneKey || 'chartArea';
    const sig = `${chart.id}|${key}|${ctx.wb.version}`;
    const own = ownChange, inside = pane.contains(document.activeElement);
    ownChange = false;
    if (sig === paneSig || inside && !own && paneSig?.startsWith(`${chart.id}|${key}|`)) return;
    const focused = inside && paneBody.contains(document.activeElement) ? controlKey(document.activeElement) : null;
    paneSig = sig;
    paneTitleEl.textContent = paneTitle(key);
    const open = new Set([...paneBody.querySelectorAll('details.chart-pane-section:not([open]) > summary')].map(s => s.textContent));
    const sections = [axisPicker(chart, key), ...options(chart, key), fillAndLine(chart, key), effects(chart, key)].filter(Boolean);
    if (!chart.appearance && !sections.length) sections.push(el('p.chart-pane-note', {}, 'This chart keeps the app’s own style. Change Chart Type gives it the full formatting options.'));
    for (const s of sections) if (open.has(s.querySelector('summary')?.textContent)) s.open = false;
    paneBody.replaceChildren(...sections);
    if (focused) [...paneBody.querySelectorAll('input, select, button, summary')].find(n => controlKey(n) === focused)?.focus({ preventScroll: true });
  }
  pane.addEventListener('focusout', () => requestAnimationFrame(() => { if (!pane.contains(document.activeElement)) { paneSig = null; renderPane(); } }));
  pane.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); hidePane(); } });

  const onChange = () => { requestAnimationFrame(() => { syncOverlay(); renderPane(); }); };
  ctx.wb.addEventListener('change', onChange);
  ctx.grid.el.addEventListener('pointerdown', onPointerDown, true);
  ctx.grid.el.addEventListener('dblclick', onDoubleClick, true);

  return {
    pane,
    element: () => element,
    get chartId() { return chartId; },
    get paneOpen() { return !pane.hidden; },
    paneKey: () => paneKey,
    setElement,
    chartSelected,
    onChartKey,
    openPane,
    hidePane,
    editTitle,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() {
      observer?.disconnect();
      ctx.wb.removeEventListener('change', onChange);
      ctx.grid.el.removeEventListener('pointerdown', onPointerDown, true);
      ctx.grid.el.removeEventListener('dblclick', onDoubleClick, true);
      overlay?.remove();
      cancelTitleEdit();
      pane.remove();
    },
  };
}

