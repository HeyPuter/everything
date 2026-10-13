/**
 * Chart elements inside a selected chart, picked and formatted: a click selects
 * the title, legend, plot area, an axis, a series (a second click one of its points), with handles
 * shown round it; a double-click opens the Format pane on the right for it; typing while the title is
 * selected edits the title in place; Delete removes the selected element.
 *
 * The element is a key: chartArea, plotArea, title, legend, xAxis, yAxis, y2Axis, xTitle, yTitle,
 * gridlines-x, gridlines-y, series:j, point:j:i, dataLabels:j (see chart-design.js).
 */
import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { activeChart, isChartObject } from './chart-actions.js';
import { elementLabel } from './chart-ribbon.js';
import { chartData, CHART_DISPLAY_UNITS } from '../core/charts.js';
import { chartElementPatch, dataLabelPositions, elementFormatPatch, isPieChart } from '../core/chart-design.js';
import { barSpacing } from '../core/chart-subtypes.js';

const PANE_TITLES = { chartArea: 'Format Chart Area', plotArea: 'Format Plot Area', title: 'Format Chart Title', legend: 'Format Legend',
  xAxis: 'Format Axis', yAxis: 'Format Axis', y2Axis: 'Format Axis', xTitle: 'Format Axis Title', yTitle: 'Format Axis Title',
  'gridlines-x': 'Format Gridlines', 'gridlines-y': 'Format Gridlines' };
export const paneTitle = key => PANE_TITLES[key] || (/^series:/.test(key) ? 'Format Data Series' : /^point:/.test(key) ? 'Format Data Point' : /^dataLabels:/.test(key) ? 'Format Data Labels' : 'Format');

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
  return kind;
}

/** The SVG nodes an element key draws, for its selection handles. */
function nodesFor(svg, key) {
  if (!svg) return [];
  let m = /^series:(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="series"][data-series="${m[1]}"]`)];
  m = /^point:(\d+):(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="series"][data-series="${m[1]}"][data-point="${m[2]}"]`)];
  m = /^dataLabels:(\d+)$/.exec(key);
  if (m) return [...svg.querySelectorAll(`[data-el="dataLabels"][data-series="${m[1]}"]`)];
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
      const frame = el('span.chart-el-frame', { style: { left: `${x1 - 2}px`, top: `${y1 - 2}px`, width: `${x2 - x1 + 4}px`, height: `${y2 - y1 + 4}px` } },
        ...['nw', 'ne', 'sw', 'se'].map(c => el(`span.chart-el-corner.${c}`)));
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
    const previous = hit.chart.id === chartId ? element : null;
    const key = elementForNode(e.target, previous);
    // The grid selects the chart on the same press; the element follows once it has.
    setTimeout(() => { if (chartId !== hit.chart.id) chartSelected(hit.chart.id); if (element !== key) setElement(key); }, 0);
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
    const input = el('input.chart-title-editor', { type: 'text', value: initial ?? chart.title ?? '', 'aria-label': 'Chart title', maxlength: 200, spellcheck: false });
    if (rect) Object.assign(input.style, { top: `${rect.top - base.top - 4}px`, left: `${Math.max(4, rect.left - base.left - 20)}px`, width: `${Math.max(160, rect.width + 40)}px` });
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      cancelTitleEdit();
      if (commit && text !== (chart.title || '')) ctx.run('chart', { action: 'patch', patch: { title: text, titleRef: undefined }, label: 'Edit chart title' });
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && element !== 'chartArea') {
      const removal = {
        title: ['chartTitle', 'none'], legend: ['legend', 'none'],
        xTitle: ['axisTitles', { axis: chart.type === 'bar' ? 'vertical' : 'horizontal', on: false }],
        yTitle: ['axisTitles', { axis: chart.type === 'bar' ? 'horizontal' : 'vertical', on: false }],
        xAxis: ['axes', { axis: 'horizontal', on: false }], yAxis: ['axes', { axis: 'vertical', on: false }],
        'gridlines-y': ['gridlines', { axis: chart.type === 'bar' ? 'vertical' : 'horizontal', on: false }],
        'gridlines-x': ['gridlines', { axis: chart.type === 'bar' ? 'horizontal' : 'vertical', on: false }],
      }[element] || (/^dataLabels:/.test(element) ? ['dataLabels', 'none'] : null);
      if (!removal) return /^(series|point):/.test(element) ? (e.preventDefault(), true) : false;
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

  const apply = (patch, label = 'Format chart') => { if (patch) ctx.run('chart', { action: 'patch', patch, label }); };
  const format = opts => { const chart = activeChart(ctx); if (chart) apply(elementFormatPatch(chart, paneKey, opts)); };

  function section(title, ...content) {
    return el('details.chart-pane-section', { open: true }, el('summary', {}, title), el('div.chart-pane-fields', {}, ...content.flat().filter(Boolean)));
  }
  const field = (label, control) => el('label.chart-pane-field', {}, el('span', {}, label), control);
  const color = (label, value, onPick) => {
    const input = el('input.chart-pane-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff', 'aria-label': label });
    input.addEventListener('change', () => onPick(input.value));
    return field(label, input);
  };
  const number = (label, value, onSet, { min = null, max = null, step = 'any', placeholder = 'Auto' } = {}) => {
    const input = el('input.input.chart-pane-number', { type: 'number', step, value: value ?? '', placeholder, 'aria-label': label, ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) });
    input.addEventListener('change', () => { const v = input.value.trim() === '' ? null : Number(input.value); if (v === null || Number.isFinite(v)) onSet(v); });
    return field(label, input);
  };
  const checkbox = (label, checked, onSet) => {
    const input = el('input', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', () => onSet(input.checked));
    return el('label.check', {}, input, el('span', {}, label));
  };
  const choice = (label, value, options, onSet) => {
    const select = el('select.input', { 'aria-label': label }, ...options.map(([v, text]) => el('option', { value: v }, text)));
    select.value = value;
    select.addEventListener('change', () => onSet(select.value));
    return field(label, select);
  };
  const text = (label, value, onSet) => {
    const input = el('input.input', { type: 'text', value: value ?? '', 'aria-label': label });
    input.addEventListener('change', () => onSet(input.value));
    return field(label, input);
  };

  /** Fill & Line for the element: its fill (where it has one) and its border or line. */
  function fillAndLine(chart, key) {
    const a = chart.appearance || {};
    const seriesIndex = /^(?:series|point):(\d+)/.exec(key)?.[1];
    const lineOnly = /^(xAxis|yAxis|y2Axis|gridlines-)/.test(key) || (seriesIndex != null && ['line', 'scatter', 'radar'].includes(chart.type) && !/^point/.test(key));
    const fills = {
      chartArea: a.background, plotArea: a.plotFill, title: a.titleBox?.fill, legend: a.legendBox?.fill,
    };
    const lines = {
      chartArea: a.border === false ? 'none' : a.borderColor, plotArea: a.plotStroke, title: a.titleBox?.stroke, legend: a.legendBox?.stroke,
      xAxis: a.axisStyles?.x?.color, yAxis: a.axisStyles?.y?.color, y2Axis: a.axisStyles?.y2?.color,
      'gridlines-x': a.gridlineStyles?.x?.color, 'gridlines-y': a.gridlineStyles?.y?.color,
    };
    const seriesColor = seriesIndex != null ? chart.colors?.[+seriesIndex] : null;
    const fill = fills[key] ?? seriesColor;
    const line = lines[key] ?? (seriesIndex != null ? (isPieChart(chart) ? a.pie?.stroke : a.bars?.[+seriesIndex]?.stroke ?? a.lines?.[+seriesIndex]?.color) : null);
    const parts = [];
    if (!lineOnly && !/^(xTitle|yTitle|dataLabels)/.test(key)) {
      const kind = fill === 'none' ? 'none' : fill ? 'solid' : 'auto';
      parts.push(el('h3.chart-pane-sub', {}, 'Fill'),
        choice('Fill', kind, [['auto', 'Automatic'], ['none', 'No fill'], ['solid', 'Solid fill']], v => format({ fill: v === 'none' ? 'none' : v === 'solid' ? (fill && fill !== 'none' ? fill : '#4472c4') : null })),
        kind === 'solid' ? color('Fill Color', fill, v => format({ fill: v })) : null);
    }
    if (!/^(xTitle|yTitle|dataLabels|point)/.test(key)) {
      const kind = line === 'none' ? 'none' : line ? 'solid' : 'auto';
      parts.push(el('h3.chart-pane-sub', {}, lineOnly && seriesIndex != null ? 'Line' : 'Border'),
        choice(lineOnly && seriesIndex != null ? 'Line' : 'Border', kind, [['auto', 'Automatic'], ['none', lineOnly ? 'No line' : 'No line'], ['solid', 'Solid line']],
          v => format({ outline: v === 'none' ? 'none' : v === 'solid' ? (line && line !== 'none' ? line : '#595959') : null })),
        kind === 'solid' || (lineOnly && seriesIndex != null) ? color('Line Color', line && line !== 'none' ? line : '#4472c4', v => format({ outline: v })) : null,
        number('Width (pt)', null, v => { if (v != null && v >= 0) format({ outlineWidth: Math.round(v * 4 / 3 * 100) / 100 }); }, { min: 0, max: 20, step: 0.25, placeholder: '' }));
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

  function options(chart, key) {
    const a = chart.appearance;
    const out = [];
    if (key === 'title') {
      out.push(section('Title Options', text('Text', chart.title, v => apply({ title: v.trim(), titleRef: undefined }, 'Edit chart title'))), textOptions(chart, 'titleStyle'));
    } else if (key === 'legend') {
      out.push(section('Legend Options', choice('Legend Position', chart.legend === false ? 'none' : chart.legendPos, [['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right'], ['none', 'None']],
        v => apply(chartElementPatch(chart, 'legend', v)))), textOptions(chart, 'legendStyle'));
    } else if (key === 'xTitle' || key === 'yTitle') {
      out.push(section('Title Options', text('Text', chart[key], v => apply({ [key]: v.trim(), [`${key}Ref`]: undefined }))));
    } else if (key === 'yAxis' || (key === 'xAxis' && (chart.type === 'scatter' || chart.type === 'bubble'))) {
      const value = key === 'yAxis';
      const minKey = value ? 'yMin' : 'xMin', maxKey = value ? 'yMax' : 'xMax', stepKey = value ? 'yStep' : 'xStep';
      const get = k => (k === 'yMin' || k === 'yMax' ? chart[k] : a?.[k]);
      const setBound = (k, v) => apply(k === 'yMin' || k === 'yMax' ? { [k]: v } : { appearance: { ...a, [k]: v } });
      const units = value ? a?.yUnits?.builtIn || 'none' : a?.xUnits?.builtIn || 'none';
      out.push(section('Axis Options',
        el('h3.chart-pane-sub', {}, 'Bounds'),
        number('Minimum', get(minKey), v => { const max = get(maxKey); if (v == null || max == null || v < max) setBound(minKey, v); }),
        number('Maximum', get(maxKey), v => { const min = get(minKey); if (v == null || min == null || v > min) setBound(maxKey, v); }),
        a ? el('h3.chart-pane-sub', {}, 'Units') : null,
        a ? number('Major', a[stepKey], v => { if (v == null || v > 0) apply({ appearance: { ...a, [stepKey]: v } }); }) : null,
        a ? choice('Display units', units, [['none', 'None'], ...Object.keys(CHART_DISPLAY_UNITS).map(u => [u, u.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())])],
          v => { const next = { ...a }; const k = value ? 'yUnits' : 'xUnits'; if (v === 'none') delete next[k]; else next[k] = { builtIn: v, divisor: CHART_DISPLAY_UNITS[v], label: '', style: a.yStyle, layout: null, rotation: 0 }; apply({ appearance: next }); }) : null,
        a ? checkbox('Values in reverse order', value ? a.reverseValues : a.reverseCategories, on => apply({ appearance: { ...a, [value ? 'reverseValues' : 'reverseCategories']: on } })) : null,
        a ? choice('Label Position', (value ? a.yLabelPosition : a.xLabelPosition) || 'nextTo', [['nextTo', 'Next to Axis'], ['high', 'High'], ['low', 'Low'], ['none', 'None']],
          v => apply({ appearance: { ...a, [value ? 'yLabelPosition' : 'xLabelPosition']: v } })) : null),
      a ? section('Number', text('Format Code', (value ? a.yFormat : a.xFormat) || '', v => apply({ appearance: { ...a, [value ? 'yFormat' : 'xFormat']: v.trim().slice(0, 255) } }))) : null,
      textOptions(chart, value ? 'yStyle' : 'xStyle'));
    } else if (key === 'xAxis') {
      out.push(a ? section('Axis Options',
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
          choice('Dash type', line.dash || 'solid', [['solid', 'Solid'], ['sysDot', 'Round Dot'], ['sysDash', 'Square Dot'], ['dash', 'Dash'], ['dashDot', 'Dash Dot'], ['lgDash', 'Long Dash']],
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
    } else if (key === 'chartArea' && a) {
      out.push(section('Chart Options',
        checkbox('Rounded corners', a.roundedCorners === true, on => apply({ appearance: { ...a, roundedCorners: on } })),
        choice('Show empty cells as', a.blanks || 'gap', [['gap', 'Gaps'], ['zero', 'Zero'], ['span', 'Connect data points with line']], v => apply({ appearance: { ...a, blanks: v, ...(a.radar ? { radar: { ...a.radar, blanks: v } } : {}) } })),
        checkbox('Show data in hidden rows and columns', chart.includeHidden, on => apply({ includeHidden: on }))));
    }
    return out;
  }

  function renderPane() {
    if (pane.hidden) return;
    const chart = activeChart(ctx);
    if (!chart) { hidePane(); return; }
    const key = paneKey || 'chartArea';
    const sig = `${chart.id}|${key}|${ctx.wb.version}`;
    if (sig === paneSig || pane.contains(document.activeElement) && paneSig?.startsWith(`${chart.id}|${key}|`)) return;
    paneSig = sig;
    paneTitleEl.textContent = paneTitle(key);
    const open = new Set([...paneBody.querySelectorAll('details.chart-pane-section:not([open]) > summary')].map(s => s.textContent));
    const sections = [...options(chart, key), fillAndLine(chart, key), effects(chart, key)].filter(Boolean);
    if (!chart.appearance && !sections.length) sections.push(el('p.chart-pane-note', {}, 'This chart keeps the app’s own style. Change Chart Type gives it the full formatting options.'));
    for (const s of sections) if (open.has(s.querySelector('summary')?.textContent)) s.open = false;
    paneBody.replaceChildren(...sections);
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

