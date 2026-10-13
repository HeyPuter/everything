/**
 * Chart Design and Format, as pure patches over a chart: Add Chart Element, Quick Layout, Change
 * Colors, Chart Styles, Switch Row/Column, the series behind Select Data, and the fill, outline and
 * effects of one element. Each returns the fields to hand `wb.updateChart`, or null when the chart
 * cannot take the change.
 */
import { colName } from './cell.js';
import { chartData } from './charts.js';
import { quoteSheet } from './refs.js';
import { CHART_LINE_GREY, CHART_TEXT_GREY, excelChartAppearance, subtypeOf } from './chart-subtypes.js';

const PIE = new Set(['pie', 'donut']);
const BARS = new Set(['column', 'bar', 'combo', 'histogram', 'waterfall']);
// Treemaps, sunbursts and funnels have no value axis; the other newer types draw their own kind of plot.
const AXIS_FREE = new Set(['radar', 'treemap', 'sunburst', 'funnel']);
const SPECIAL = new Set(['treemap', 'sunburst', 'boxWhisker', 'funnel', 'stock', 'surface']);
const AXES = t => !PIE.has(t) && !AXIS_FREE.has(t);
export const isPieChart = chart => PIE.has(chart?.type);
export const hasAxes = chart => AXES(chart?.type);
/** Charts drawn in the default style carry an appearance; older app charts keep their own look and fewer options. */
export const styledChart = chart => !!chart?.appearance;

const labelStyle = a => ({ ...(a?.xStyle || { font: 'calibri', size: 12, color: CHART_TEXT_GREY }), color: a?.xStyle?.color || CHART_TEXT_GREY });

/** What Add Chart Element shows as on: each submenu's current choice. */
export function chartElementState(chart) {
  const a = chart.appearance || {};
  const horizontal = chart.type === 'bar';
  const valueLabels = a.valueLabels?.find(l => l?.show);
  return {
    axes: { horizontal: !a.hideXAxis, vertical: !a.hideYAxis },
    axisTitles: { horizontal: !!(horizontal ? chart.yTitle : chart.xTitle), vertical: !!(horizontal ? chart.xTitle : chart.yTitle) },
    chartTitle: chart.title || chart.titleRef ? 'above' : 'none',
    dataLabels: PIE.has(chart.type)
      ? (a.pie?.labels && (a.pie.labels.value || a.pie.labels.percent || a.pie.labels.category) ? a.pie.labels.position || 'bestFit' : 'none')
      : chart.labels ? valueLabels?.position || 'show' : 'none',
    dataTable: a.dataTable ? (a.dataTable.keys ? 'keys' : 'noKeys') : 'none',
    gridlines: { horizontal: horizontal ? !!a.xGridlines : chart.gridlines !== false, vertical: horizontal ? chart.gridlines !== false : !!a.xGridlines },
    legend: chart.legend === false ? 'none' : chart.legendPos || 'bottom',
    trendline: chart.trendline ? 'linear' : 'none',
  };
}

/** The data label positions available for the chart's type. */
export function dataLabelPositions(chart) {
  if (PIE.has(chart.type)) return chart.type === 'donut' ? [['ctr', 'Show']] : [['ctr', 'Center'], ['inEnd', 'Inside End'], ['outEnd', 'Outside End'], ['bestFit', 'Best Fit']];
  if (['column', 'bar'].includes(chart.type)) return chart.stacked ? [['ctr', 'Center'], ['inEnd', 'Inside End'], ['inBase', 'Inside Base']]
    : [['ctr', 'Center'], ['inEnd', 'Inside End'], ['inBase', 'Inside Base'], ['outEnd', 'Outside End']];
  if (['line', 'scatter'].includes(chart.type)) return [['ctr', 'Center'], ['l', 'Left'], ['r', 'Right'], ['t', 'Above'], ['b', 'Below']];
  return [['show', 'Show']];
}

/**
 * Add Chart Element: `element` names the submenu (axes, axisTitles, chartTitle, dataLabels, dataTable,
 * gridlines, legend, trendline) and `value` the choice. `seriesCount` sizes per-series settings.
 */
export function chartElementPatch(chart, element, value, { seriesCount = 1 } = {}) {
  const a = { ...(chart.appearance || {}) };
  const styled = !!chart.appearance;
  const horizontal = chart.type === 'bar';
  const done = patch => (styled ? { ...patch, appearance: { ...a, ...(patch.appearance || {}) } } : (() => { const { appearance, ...rest } = patch; return rest; })());
  switch (element) {
    case 'axes': {
      if (!AXES(chart.type) || !styled) return null;
      const key = value.axis === 'horizontal' ? 'hideXAxis' : 'hideYAxis';
      return done({ appearance: { [key]: !value.on } });
    }
    case 'axisTitles': {
      if (!AXES(chart.type)) return null;
      // A bar chart's categories run down its left side: its vertical axis title is the category one.
      const key = (value.axis === 'horizontal') !== horizontal ? 'xTitle' : 'yTitle';
      return done({ [key]: value.on ? chart[key] || 'Axis Title' : '', [`${key}Ref`]: undefined });
    }
    case 'chartTitle':
      return value === 'none' ? done({ title: '', titleRef: undefined }) : done({ title: chart.title || 'Chart title' });
    case 'dataLabels': {
      if (PIE.has(chart.type)) {
        if (!styled || !a.pie) return done({ labels: value !== 'none' });
        const labels = { ...a.pie.labels, value: value !== 'none', hidden: false, position: value === 'none' || value === 'show' ? a.pie.labels.position : value };
        return done({ labels: value !== 'none', appearance: { pie: { ...a.pie, labels } } });
      }
      if (value === 'none') return done({ labels: false, appearance: { valueLabels: (a.valueLabels || []).map(l => ({ ...l, show: false })) } });
      const position = value === 'show' ? null : value;
      const style = labelStyle(a);
      const valueLabels = Array.from({ length: Math.max(seriesCount, a.valueLabels?.length || 0) }, (_, i) => ({
        hidden: [], ...(a.valueLabels?.[i] || {}), show: true, style: a.valueLabels?.[i]?.style || style, position }));
      return done({ labels: true, appearance: { valueLabels } });
    }
    case 'dataTable': {
      if (!AXES(chart.type) || !styled || chart.type === 'scatter' || chart.type === 'bubble' || SPECIAL.has(chart.type)) return null;
      if (value === 'none') { delete a.dataTable; return { appearance: a }; }
      return done({ appearance: { dataTable: { horizontal: true, vertical: true, outline: true, keys: value === 'keys',
        style: labelStyle(a), fill: 'none', stroke: CHART_LINE_GREY, width: 1 } } });
    }
    case 'gridlines': {
      if (!AXES(chart.type)) return null;
      // Value gridlines run across the value axis: horizontal ones on a column chart, vertical ones on a bar chart.
      const valueGrid = (value.axis === 'horizontal') !== horizontal;
      if (valueGrid) return done({ gridlines: !!value.on });
      if (!styled) return null;
      return done({ appearance: { xGridlines: !!value.on, gridlineStyles: { ...(a.gridlineStyles || {}), ...(value.on && !a.gridlineStyles?.x ? { x: { color: CHART_LINE_GREY, width: 1 } } : {}) } } });
    }
    case 'legend':
      if (value === 'none') return done({ legend: false });
      return done({ legend: true, legendPos: value, appearance: { legendPos: value, legend: null } });
    case 'trendline':
      if (PIE.has(chart.type) || chart.stacked || SPECIAL.has(chart.type)) return null;
      return done({ trendline: value === 'linear' });
    default: return null;
  }
}

/** Fold several element patches into one change. */
function combine(chart, steps, options) {
  let current = chart, patch = {};
  for (const [element, value] of steps) {
    const next = chartElementPatch(current, element, value, options);
    if (!next) continue;
    patch = { ...patch, ...next, ...(next.appearance ? { appearance: next.appearance } : {}) };
    current = { ...current, ...next };
  }
  return patch;
}

/** Quick Layout: preset arrangements of the title, legend, axis titles, labels, gridlines and a data table. */
export const QUICK_LAYOUTS = Object.freeze([
  { id: 1, label: 'Layout 1', steps: [['chartTitle', 'above'], ['legend', 'right'], ['dataLabels', 'none'], ['dataTable', 'none'], ['gridlines', { axis: 'horizontal', on: true }]] },
  { id: 2, label: 'Layout 2', steps: [['chartTitle', 'above'], ['legend', 'top'], ['dataLabels', 'outEnd'], ['axes', { axis: 'vertical', on: false }], ['gridlines', { axis: 'horizontal', on: false }], ['dataTable', 'none']] },
  { id: 3, label: 'Layout 3', steps: [['chartTitle', 'above'], ['legend', 'bottom'], ['dataLabels', 'none'], ['dataTable', 'none'], ['axes', { axis: 'vertical', on: true }], ['gridlines', { axis: 'horizontal', on: true }]] },
  { id: 4, label: 'Layout 4', steps: [['chartTitle', 'none'], ['legend', 'bottom'], ['dataLabels', 'outEnd'], ['dataTable', 'none'], ['gridlines', { axis: 'horizontal', on: false }]] },
  { id: 5, label: 'Layout 5', steps: [['chartTitle', 'above'], ['legend', 'none'], ['dataTable', 'keys'], ['axisTitles', { axis: 'vertical', on: true }], ['dataLabels', 'none']] },
  { id: 6, label: 'Layout 6', steps: [['chartTitle', 'above'], ['legend', 'right'], ['axisTitles', { axis: 'vertical', on: true }], ['axisTitles', { axis: 'horizontal', on: true }], ['dataLabels', 'none'], ['dataTable', 'none']] },
  { id: 7, label: 'Layout 7', steps: [['chartTitle', 'none'], ['legend', 'right'], ['axisTitles', { axis: 'vertical', on: true }], ['axisTitles', { axis: 'horizontal', on: true }], ['gridlines', { axis: 'vertical', on: true }], ['dataLabels', 'none'], ['dataTable', 'none']] },
]);
const PIE_LAYOUTS = Object.freeze([
  { id: 1, label: 'Layout 1', steps: [['chartTitle', 'above'], ['legend', 'none'], ['dataLabels', 'bestFit']] },
  { id: 2, label: 'Layout 2', steps: [['chartTitle', 'above'], ['legend', 'top'], ['dataLabels', 'inEnd']] },
  { id: 3, label: 'Layout 3', steps: [['chartTitle', 'none'], ['legend', 'bottom'], ['dataLabels', 'none']] },
  { id: 4, label: 'Layout 4', steps: [['chartTitle', 'none'], ['legend', 'none'], ['dataLabels', 'ctr']] },
  { id: 5, label: 'Layout 5', steps: [['chartTitle', 'above'], ['legend', 'right'], ['dataLabels', 'outEnd']] },
]);
// Charts that name their own parts (a treemap's boxes, a funnel's stages) arrange only the title, legend and labels.
const PLAIN_LAYOUTS = Object.freeze([
  { id: 1, label: 'Layout 1', steps: [['chartTitle', 'above'], ['legend', 'top'], ['dataLabels', 'show']] },
  { id: 2, label: 'Layout 2', steps: [['chartTitle', 'above'], ['legend', 'none'], ['dataLabels', 'show']] },
  { id: 3, label: 'Layout 3', steps: [['chartTitle', 'none'], ['legend', 'right'], ['dataLabels', 'show']] },
  { id: 4, label: 'Layout 4', steps: [['chartTitle', 'above'], ['legend', 'bottom'], ['dataLabels', 'none']] },
]);
export const quickLayoutsFor = chart => (PIE.has(chart.type) ? PIE_LAYOUTS : AXIS_FREE.has(chart.type) && chart.type !== 'radar' ? PLAIN_LAYOUTS : QUICK_LAYOUTS);

export function quickLayoutPatch(chart, id, options) {
  const layout = quickLayoutsFor(chart).find(l => l.id === id);
  if (!layout) return null;
  const patch = combine(chart, layout.steps, options);
  // A pie's labels in Layout 1 name the slice and its share.
  if (PIE.has(chart.type) && id === 1 && patch.appearance?.pie) patch.appearance.pie.labels = { ...patch.appearance.pie.labels, category: true, percent: true, value: false };
  return patch;
}

/** Change Colors palettes: four colourful sequences over the accents, then each accent in shades. */
export function colorPalettes(accents) {
  const acc = accents.slice(0, 6);
  const rotate = k => acc.map((_, i) => acc[(i * (k + 1) + k) % acc.length]);
  const colorful = [
    { id: 'colorful1', label: 'Colorful Palette 1', colors: acc },
    { id: 'colorful2', label: 'Colorful Palette 2', colors: [acc[1], acc[3], acc[5], acc[1], acc[3], acc[5]].map((c, i) => (i < 3 ? c : shade(c, -0.25))) },
    { id: 'colorful3', label: 'Colorful Palette 3', colors: [acc[2], acc[4], acc[0], acc[2], acc[4], acc[0]].map((c, i) => (i < 3 ? c : shade(c, -0.25))) },
    { id: 'colorful4', label: 'Colorful Palette 4', colors: rotate(3) },
  ];
  const mono = acc.map((c, k) => ({ id: `mono${k + 1}`, label: `Monochromatic Palette ${k + 1}`,
    colors: [0, -0.25, 0.25, -0.5, 0.45, -0.65].map(t => shade(c, t)) }));
  return { colorful, monochromatic: mono };
}

/** A hex colour toward white (t > 0) or black (t < 0). */
export function shade(hex, t) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return hex;
  const to = t > 0 ? 255 : 0, k = Math.abs(t);
  return `#${[m[1], m[2], m[3]].map(h => Math.round(parseInt(h, 16) * (1 - k) + to * k).toString(16).padStart(2, '0')).join('')}`;
}

/** Apply a palette: one colour per series (per slice for a pie), cycling, darker on each lap. */
export function colorsPatch(chart, palette, count) {
  const colors = Array.from({ length: Math.max(1, Math.min(50, count)) }, (_, i) => {
    const base = palette[i % palette.length], lap = Math.floor(i / palette.length);
    return lap ? shade(base, lap % 2 ? -0.3 : 0.3) : base;
  });
  const patch = { colors };
  // Points coloured one by one lose those colours to the new palette.
  if (chart.appearance?.pointColors?.some(p => p?.length)) patch.appearance = { ...chart.appearance, pointColors: [] };
  return patch;
}

/**
 * Chart Styles: original combinations of background, gridlines, borders and labels. Each starts
 * from the default look for the chart's subtype, so applying one replaces the last.
 */
export const CHART_STYLES = Object.freeze([
  { id: 1, label: 'Style 1' }, { id: 2, label: 'Style 2' }, { id: 3, label: 'Style 3' }, { id: 4, label: 'Style 4' },
  { id: 5, label: 'Style 5' }, { id: 6, label: 'Style 6' }, { id: 7, label: 'Style 7' }, { id: 8, label: 'Style 8' },
]);

export function chartStylePatch(chart, id, { seriesCount = 1 } = {}) {
  if (!CHART_STYLES.some(s => s.id === id)) return null;
  const subtype = subtypeOf(chart);
  const old = chart.appearance || {};
  const font = old.titleStyle?.font || 'calibri';
  const fresh = excelChartAppearance(subtype, { font });
  // Elements the user added stay; only their look changes.
  const keep = ['lines', 'lineDefault', 'dataTable', 'hideXAxis', 'hideYAxis', 'xGridlines', 'yFormat', 'xFormat', 'yStep', 'xStep', 'yUnits', 'blanks', 'plot', 'title', 'legend', 'legendPos', 'pointColors', 'seriesTypes', 'seriesGroups'];
  const a = { ...fresh, ...Object.fromEntries(keep.filter(k => old[k] !== undefined).map(k => [k, old[k]])) };
  if (a.pie && old.pie) a.pie = { ...a.pie, labels: { ...a.pie.labels, ...old.pie.labels, style: a.pie.labels.style } };
  const text = (color, scale = 1) => ['textStyle', 'titleStyle', 'legendStyle', 'xStyle', 'yStyle', 'y2Style'].forEach(k => { a[k] = { ...a[k], color, size: Math.round(a[k].size * scale * 100) / 100 }; });
  const patch = { appearance: a };
  const labels = position => {
    patch.labels = true;
    if (a.pie) a.pie = { ...a.pie, labels: { ...a.pie.labels, value: true, position: position === 'inEnd' ? 'inEnd' : 'bestFit' } };
    a.valueLabels = Array.from({ length: seriesCount }, (_, i) => ({ hidden: [], ...(old.valueLabels?.[i] || {}), show: true,
      style: { ...a.xStyle, color: position === 'inEnd' && BARS.has(chart.type) ? '#ffffff' : a.xStyle.color }, position: BARS.has(chart.type) ? position : null }));
  };
  switch (id) {
    case 1: patch.gridlines = true; patch.labels = false; a.valueLabels = (old.valueLabels || []).map(l => ({ ...l, show: false })); break;
    case 2: patch.gridlines = false; a.hideYAxis = true; labels('inEnd'); if (a.gapWidth != null && !chart.stacked) a.gapWidth = 80; break;
    case 3: patch.gridlines = true; a.gridlineStyles = { y: { color: CHART_LINE_GREY, width: 1 } }; if (a.gapWidth != null) Object.assign(a, { gapWidth: 60, overlap: chart.stacked ? 100 : 0 });
      a.titleStyle = { ...a.titleStyle, bold: true }; break;
    case 4: patch.gridlines = true; a.plotFill = '#f2f2f2'; a.gridlineStyles = { y: { color: '#ffffff', width: 1.5 } }; break;
    case 5: patch.gridlines = true; a.borderColor = '#a6a6a6'; a.plotStroke = '#d9d9d9'; a.bars = Array.from({ length: seriesCount }, () => ({ stroke: '#ffffff', strokeWidth: 1, points: [] }));
      if (a.pie) a.pie = { ...a.pie, stroke: '#ffffff', strokeWidth: 2 }; break;
    case 6: patch.gridlines = true; a.background = '#404040'; a.borderColor = '#404040'; a.gridlineStyles = { y: { color: '#595959', width: 1 } };
      a.axisStyles = { ...a.axisStyles, x: { ...(a.axisStyles?.x || {}), color: '#7f7f7f' } }; text('#d9d9d9');
      if (a.pie) a.pie = { ...a.pie, stroke: '#404040' }; break;
    case 7: patch.gridlines = true; a.plotFill = '#f7f7f7'; a.xGridlines = true; a.gridlineStyles = { x: { color: CHART_LINE_GREY, width: 1 }, y: { color: CHART_LINE_GREY, width: 1 } };
      a.titleStyle = { ...a.titleStyle, size: Math.round(a.titleStyle.size * 1.15 * 100) / 100 }; break;
    case 8: patch.gridlines = false; a.border = true; a.borderColor = 'none'; a.axisStyles = { ...a.axisStyles, x: { ...(a.axisStyles?.x || {}), color: '#7f7f7f' } };
      labels('outEnd'); text('#404040'); break;
    default: break;
  }
  return patch;
}

/** Switch Row/Column: series from rows instead of columns, or back. Charts with their own series references cannot. */
export function switchRowColumnPatch(wb, sheetId, chart) {
  if (chart.sourceRefs?.length) return null;
  const data = chartData(wb, sheetId, chart);
  return { seriesIn: data.orientation === 'rows' ? 'cols' : 'rows' };
}

const refOf = (sheetName, r1, c1, r2 = r1, c2 = c1) => `${quoteSheet(sheetName)}!$${colName(c1)}$${r1 + 1}${r1 === r2 && c1 === c2 ? '' : `:$${colName(c2)}$${r2 + 1}`}`;

/**
 * The series of a chart as Select Data lists them: each one's name (and the cell it comes from), values
 * and categories, as sheet-qualified references. A range chart is read from its range.
 */
export function chartSeriesSources(wb, sheetId, chart) {
  if (chart.sourceRefs?.length) return chart.sourceRefs.map(s => ({ ...s }));
  const data = chartData(wb, sheetId, chart), layout = data.sourceLayout, sheet = wb.sheet(sheetId);
  if (!layout || !sheet) return [];
  const rows = layout.orientation === 'rows';
  const at = (line, point) => (rows ? [line, point] : [point, line]);
  const span = line => {
    if (line == null || !layout.points.length) return '';
    const first = layout.points[0], last = layout.points.at(-1);
    const [r1, c1] = at(line, first), [r2, c2] = at(line, last);
    return refOf(sheet.name, r1, c1, r2, c2);
  };
  const xy = chart.type === 'scatter' || chart.type === 'bubble';
  const categories = xy ? span(layout.xLine) : span(layout.categoryLine);
  return data.series.map((s, i) => {
    const line = layout.lines[i];
    const nameRef = layout.nameLine != null ? refOf(sheet.name, ...at(line, layout.nameLine)) : '';
    return { name: s.name, nameRef, categories, values: span(line), ...(chart.type === 'bubble' ? { sizes: span(layout.sizeLine) } : {}) };
  });
}

/** The patch that makes a chart read its series from `sources` (Select Data's legend entries). */
export function seriesSourcesPatch(chart, sources) {
  const clean = sources.slice(0, 60).map(s => ({ name: s.name || '', nameRef: s.nameRef || '', categories: s.categories || '', values: s.values || '',
    ...(s.sizes ? { sizes: s.sizes } : {}), ...(s.literal ? { literal: s.literal } : {}) }));
  return { sourceRefs: clean };
}

/** Move Chart and chart sheets: a range chart whose data lies on another sheet reads it through references. */
export function detachedChart(wb, sheetId, chart) {
  if (chart.sourceRefs?.length) return { ...chart };
  const sourceRefs = chartSeriesSources(wb, sheetId, chart);
  return { ...chart, sourceRefs };
}

/**
 * Format ▸ Shape Fill / Shape Outline / Shape Effects for one element: `key` is chartArea, plotArea,
 * title, legend, xAxis, yAxis, gridlines-x, gridlines-y, series:j or point:j:i. `fill` and `outline` are a
 * hex colour or 'none'; `effect` is { shadow, glow }.
 */
export function elementFormatPatch(chart, key, { fill, outline, outlineWidth, effect } = {}) {
  if (!chart.appearance) {
    const m = /^series:(\d+)$/.exec(key);
    if (m && fill) { const colors = [...(chart.colors || [])]; colors[+m[1]] = fill; return { colors }; }
    return null;
  }
  const a = { ...chart.appearance };
  const patch = { appearance: a };
  const series = /^series:(\d+)$/.exec(key), point = /^point:(\d+):(\d+)$/.exec(key);
  if (effect) {
    const effectKey = point ? `series:${point[1]}` : key;
    if (!['chartArea', 'plotArea', 'title', 'legend'].includes(effectKey) && !/^series:\d+$/.test(effectKey)) return null;
    a.effects = { ...(a.effects || {}), [effectKey]: { shadow: !!effect.shadow, glow: effect.glow || null } };
    if (!effect.shadow && !effect.glow) delete a.effects[effectKey];
    return patch;
  }
  const line = (o, w) => ({ ...(o !== undefined ? { color: o } : {}), ...(w != null ? { width: w } : {}) });
  switch (true) {
    case key === 'chartArea':
      if (fill !== undefined) a.background = fill;
      if (outline !== undefined) { a.borderColor = outline; a.border = outline !== 'none'; }
      if (outlineWidth != null) a.borderWidth = outlineWidth;
      return patch;
    case key === 'plotArea':
      if (fill !== undefined) a.plotFill = fill;
      if (outline !== undefined) a.plotStroke = outline;
      if (outlineWidth != null) a.plotStrokeWidth = outlineWidth;
      return patch;
    case key === 'title' || key === 'legend': {
      const box = `${key}Box`;
      a[box] = { ...(a[box] || {}), ...(fill !== undefined ? { fill } : {}), ...(outline !== undefined ? { stroke: outline } : {}) };
      return patch;
    }
    case key === 'xAxis' || key === 'yAxis' || key === 'y2Axis': {
      const axis = key === 'xAxis' ? 'x' : key === 'yAxis' ? 'y' : 'y2';
      if (outline === undefined && outlineWidth == null) return null;
      a.axisStyles = { ...(a.axisStyles || {}), [axis]: { ...(a.axisStyles?.[axis] || {}), ...line(outline, outlineWidth) } };
      return patch;
    }
    case /^gridlines-(x|y|y2)$/.test(key): {
      const axis = key.slice(10);
      if (outline === undefined && outlineWidth == null) return null;
      a.gridlineStyles = { ...(a.gridlineStyles || {}), [axis]: { ...(a.gridlineStyles?.[axis] || {}), ...line(outline, outlineWidth) } };
      return patch;
    }
    case !!series: {
      const j = +series[1];
      if (fill !== undefined) {
        const colors = [...(chart.colors || [])];
        while (colors.length < j) colors.push(null);
        colors[j] = fill === 'none' ? 'none' : fill;
        patch.colors = colors;
      }
      if (outline !== undefined || outlineWidth != null) {
        if (BARS.has(chart.type) || PIE.has(chart.type)) {
          if (PIE.has(chart.type)) a.pie = { ...a.pie, ...(outline !== undefined ? { stroke: outline } : {}), ...(outlineWidth != null ? { strokeWidth: outlineWidth } : {}) };
          else {
            const bars = [...(a.bars || [])];
            while (bars.length <= j) bars.push(null);
            bars[j] = { points: [], ...(bars[j] || {}), ...(outline !== undefined ? { stroke: outline } : {}), ...(outlineWidth != null ? { strokeWidth: outlineWidth } : {}) };
            a.bars = bars;
          }
        } else {
          const lines = [...(a.lines || [])];
          while (lines.length <= j) lines.push({ ...(a.lineDefault || { width: 2, marker: true }) });
          lines[j] = { ...lines[j], ...(outline === 'none' ? { visible: false } : outline !== undefined ? { color: outline, visible: true } : {}),
            ...(outlineWidth != null ? { width: outlineWidth } : {}) };
          a.lines = lines;
        }
      }
      return patch;
    }
    case !!point: {
      const j = +point[1], i = +point[2];
      if (fill === undefined) return null;
      if (PIE.has(chart.type)) {
        const colors = [...(chart.colors || [])];
        while (colors.length < i) colors.push(null);
        colors[i] = fill;
        return { colors };
      }
      const pointColors = [...(a.pointColors || [])];
      while (pointColors.length <= j) pointColors.push([]);
      pointColors[j] = [...pointColors[j].filter(p => p.index !== i), { index: i, color: fill }];
      a.pointColors = pointColors;
      return patch;
    }
    default: return null;
  }
}


/**
 * Recommended Charts: the subtypes that suit the selection's shape, best first. Text or dates down the
 * side with numbers beside them make columns, lines and bars; one series also a pie; numbers alone in
 * two or three columns a scatter or bubble chart.
 */
export function recommendedSubtypes(data, { levels = 0 } = {}) {
  const series = data?.series || [], n = data?.categories?.length || 0;
  const named = (data?.categories || []).some((c, i) => c !== String(i + 1));
  const positive = series.every(s => s.values.every(v => v == null || v >= 0));
  const out = [];
  // Columns headed High, Low and Close (after Open and Volume, when there) are prices.
  const names = series.map(s => String(s.name).trim().toLowerCase());
  const stock = ['hlc', 'ohlc', 'vhlc', 'vohlc'].find(kind => {
    const want = { hlc: ['high', 'low', 'close'], ohlc: ['open', 'high', 'low', 'close'], vhlc: ['volume', 'high', 'low', 'close'], vohlc: ['volume', 'open', 'high', 'low', 'close'] }[kind];
    return names.length === want.length && want.every((w, i) => names[i].startsWith(w));
  });
  if (stock) out.push({ hlc: 'stockHlc', ohlc: 'stockOhlc', vhlc: 'stockVhlc', vohlc: 'stockVohlc' }[stock]);
  // Two or more label columns over one column of numbers are a hierarchy.
  if (levels > 1 && series.length === 1 && positive) out.push('treemap', 'sunburst');
  // A long single column of numbers is a distribution; categories that repeat group it into boxes.
  const repeats = named && new Set(data.categories).size < n;
  if (series.length >= 1 && n >= 10 && (!named || repeats)) out.push(...(series.length === 1 && !named ? ['histogram'] : []), 'boxWhisker');
  // One series that falls stage by stage reads as a funnel.
  const v = series[0]?.values || [];
  if (series.length === 1 && named && n >= 3 && n <= 12 && positive && v.every((x, i) => x != null && (i === 0 || x <= v[i - 1]))) out.push('funnel');
  if (!named && series.length >= 2) out.push('scatter');
  if (!named && series.length === 3) out.push('bubble');
  out.push('columnClustered');
  if (series.length === 1 && positive && n <= 12) out.push('pie');
  out.push(n > 12 ? 'line' : 'lineMarkers');
  if (series.length > 1) out.push('columnStacked');
  out.push('barClustered');
  if (series.length === 1 && positive && n <= 12) out.push('doughnut');
  if (series.length > 1) out.push('areaStacked', 'comboColumnLine');
  out.push('area');
  return [...new Set(out)].slice(0, 8);
}
