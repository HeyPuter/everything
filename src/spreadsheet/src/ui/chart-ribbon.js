/**
 * Ribbon descriptors for charts: the Insert ▸ Charts galleries, and the contextual Chart Design and
 * Format tabs shown while a chart is selected (see ribbon.js for the descriptor shape: `resolve`
 * returns the item a button runs or the submenu it opens, and `element` builds a control in place).
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { closeMenu, lazySubmenu } from './menu.js';
import { renderChartSvg, SERIES_COLORS } from './chartsvg.js';
import { customColorRows } from './colorpicker.js';
import { themeColorBlock } from './themes.js';
import { activeChart, seriesCountOf } from './chart-actions.js';
import { chartData } from '../core/charts.js';
import { CHART_FAMILIES, CHART_GALLERIES } from '../core/chart-subtypes.js';
import { CHART_STYLES, chartElementPatch, chartElementState, chartStylePatch, colorPalettes, dataLabelPositions, hasAxes, isPieChart, secondaryAxis,
  quickLayoutPatch, quickLayoutsFor, trendlineAllowed } from '../core/chart-design.js';
import { themedSeriesColors } from '../core/workbook-theme.js';
import { TREND_TYPES, trendFor } from '../core/trendline.js';
import { errorBarsAllowed, errorBarsFor } from '../core/error-bars.js';
import { arrangeGroup } from './arrange-ribbon.js';
import { t, tSource } from '../i18n/index.js';

const run = (ctx, arg) => ctx.run('chart', arg);
/** A descriptor's names from the catalog: its label, its accessible name if another, and `keytip`, the English key tips come from. */
const naming = (key, ariaKey = null) => ({ label: t(key), ...(ariaKey ? { ariaLabel: t(ariaKey) } : {}), keytip: tSource(ariaKey || key) });
const flags = ctx => ctx?.flags?.() || {};
const cannotInsert = ctx => !!(flags(ctx).editing || flags(ctx).chartSheet || flags(ctx).away);
const cannotEdit = ctx => !!flags(ctx).editing || !activeChart(ctx) || !!ctx.wb.sheet(ctx.sheetId())?.protected;

/** A grid of picture tiles inside a menu; a pick closes the menu and runs `onPick`. */
function tileGrid(label, tiles, { columns = 3, className = '' } = {}) {
  const grid = el(`div.chart-gallery-grid${className ? `.${className}` : ''}`, { role: 'group', 'aria-label': label, style: { gridTemplateColumns: `repeat(${columns}, auto)` } },
    ...tiles.map(tile => el('button.chart-gallery-tile', {
      type: 'button', role: tile.checked == null ? 'menuitem' : 'menuitemradio', tabindex: -1, title: tile.label, 'aria-label': tile.label,
      ...(tile.checked == null ? {} : { 'aria-checked': String(!!tile.checked) }),
      onclick: () => { closeMenu(); tile.onPick(); },
    }, el('span.chart-gallery-picture', { html: tile.html, 'aria-hidden': 'true' }))));
  grid.addEventListener('keydown', e => {
    const tilesEls = [...grid.querySelectorAll('button')], at = tilesEls.indexOf(document.activeElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (!step) return;
    const next = tilesEls[at + step];
    if (next) { e.preventDefault(); e.stopPropagation(); next.focus(); }
  });
  return grid;
}

/** Each Insert ▸ Charts button's accessible name, by its gallery's id. */
const GALLERY_NAMES = {
  column: 'chartRibbon.insert.column', line: 'chartRibbon.insert.line', pie: 'chartRibbon.insert.pie', bar: 'chartRibbon.insert.bar',
  area: 'chartRibbon.insert.area', scatter: 'chartRibbon.insert.scatter', hierarchy: 'chartRibbon.insert.hierarchy',
  statistic: 'chartRibbon.insert.statistic', other: 'chartRibbon.insert.other', combo: 'chartRibbon.insert.combo',
};
/** One Insert ▸ Charts button: its gallery of subtypes, then its More … chart types item. */
function gallery(g) {
  const named = GALLERY_NAMES[g.id];
  const ariaLabel = named ? t(named) : t('chartRibbon.insert.kind', { kind: g.label.toLowerCase() });
  return {
    label: g.label, glyph: g.icon, ariaLabel, keytip: named ? tSource(named) : tSource('chartRibbon.insert.kind', { kind: g.label.toLowerCase() }),
    resolve: (menus, ctx) => lazySubmenu({ label: g.label, disabled: cannotInsert(ctx) }, () => [
      ...g.groups.flatMap(group => [{ header: group.header }, { custom: tileGrid(group.header, group.items.map(item => ({
        label: item.label, html: icon(item.icon, 32), onPick: () => run(ctx, { action: 'insert', subtype: item.id }) })), { columns: Math.min(4, Math.max(3, group.items.length)) }) }]),
      { separator: true },
      // Each family's own page of the All Charts list; the other charts open on the first of theirs.
      { label: g.more, icon: g.icon, cmd: 'chart', arg: { action: 'insertDialog', family: CHART_FAMILIES.some(f => f.id === g.id) ? g.id : CHART_FAMILIES.find(f => f.subtypes.includes(g.groups[0].items[0].id))?.id } },
    ]),
  };
}

/** Insert ▸ Charts: Recommended Charts, then a gallery per chart family (the hierarchy, statistical, other and combo charts among them). */
export function chartInsertGroup() {
  return ['Charts',
    { ...naming('chartRibbon.recommendedCharts'), glyph: 'recommendedCharts', large: true,
      resolve: (menus, ctx) => ({ label: t('chartRibbon.recommendedCharts'), cmd: 'chart', arg: { action: 'recommended' }, disabled: cannotInsert(ctx) }) },
    ...CHART_GALLERIES.map(gallery),
  ];
}

/* ---------- Chart Design ---------- */

const radio = (label, checked, arg, extra = {}) => ({ label, cmd: 'chart', arg, radio: true, checked: !!checked, ...extra });
const check = (label, checked, arg, extra = {}) => ({ label, cmd: 'chart', arg, checked: !!checked, ...extra });

function addElementMenu(ctx) {
  const chart = activeChart(ctx);
  if (!chart) return [];
  const state = chartElementState(chart), axes = hasAxes(chart), styled = !!chart.appearance, pie = isPieChart(chart);
  const el2 = (element, value) => ({ action: 'element', element, value });
  // More Axis Options opens the axis selected in the chart, or the value axis.
  const current = ctx.chartUi?.element(), selectedAxis = ['xAxis', 'yAxis', 'y2Axis'].includes(current) ? current : 'yAxis';
  const can = (element, value) => !!chartElementPatch(chart, element, value, { seriesCount: 1 });
  const sub = (label, iconName, items, disabled = false) => ({ label, icon: iconName, submenu: items, disabled: disabled || !items.length });
  return [
    sub(t('chartRibbon.add.axes'), 'chartColumn', axes && styled ? [
      check(t('chartRibbon.add.horizontalAxis'), state.axes.horizontal, el2('axes', { axis: 'horizontal', on: !state.axes.horizontal })),
      check(t('chartRibbon.add.verticalAxis'), state.axes.vertical, el2('axes', { axis: 'vertical', on: !state.axes.vertical })),
      secondaryAxis(chart) && check(t('chartRibbon.add.secondaryVerticalAxis'), state.axes.secondary, el2('axes', { axis: 'secondary', on: !state.axes.secondary })),
      { separator: true }, { label: t('chartRibbon.add.moreAxisOptions'), cmd: 'chart', arg: { action: 'formatPane', element: selectedAxis } }].filter(Boolean) : [], !axes || !styled),
    sub(t('chartRibbon.add.axisTitles'), 'textBox', axes ? [
      check(t('chartRibbon.add.horizontalAxisTitle'), state.axisTitles.horizontal, el2('axisTitles', { axis: 'horizontal', on: !state.axisTitles.horizontal })),
      check(t('chartRibbon.add.verticalAxisTitle'), state.axisTitles.vertical, el2('axisTitles', { axis: 'vertical', on: !state.axisTitles.vertical })),
      secondaryAxis(chart) && check(t('chartRibbon.add.secondaryVerticalAxisTitle'), state.axisTitles.secondary, el2('axisTitles', { axis: 'secondary', on: !state.axisTitles.secondary }))].filter(Boolean) : [], !axes),
    sub(t('chartRibbon.add.chartTitle'), 'textBox', [
      radio(t('common.none'), state.chartTitle === 'none', el2('chartTitle', 'none')),
      radio(t('chartRibbon.add.aboveChart'), state.chartTitle === 'above', el2('chartTitle', 'above')),
      { separator: true }, { label: t('chartRibbon.add.moreTitleOptions'), cmd: 'chart', arg: { action: 'formatPane', element: 'title' } }]),
    sub(t('chartRibbon.add.dataLabels'), 'number', [
      radio(t('common.none'), state.dataLabels === 'none', el2('dataLabels', 'none')),
      ...dataLabelPositions(chart).map(([value, label]) => radio(label, state.dataLabels === value || (value === 'show' && state.dataLabels !== 'none'), el2('dataLabels', value))),
      { separator: true }, { label: t('chartRibbon.add.moreDataLabelOptions'), cmd: 'chart', arg: { action: 'formatPane', element: 'dataLabels:0' } }], !can('dataLabels', 'none')),
    sub(t('chartRibbon.add.dataTable'), 'table', axes && styled && can('dataTable', 'keys') ? [
      radio(t('common.none'), state.dataTable === 'none', el2('dataTable', 'none')),
      radio(t('chartRibbon.add.withLegendKeys'), state.dataTable === 'keys', el2('dataTable', 'keys')),
      radio(t('chartRibbon.add.noLegendKeys'), state.dataTable === 'noKeys', el2('dataTable', 'noKeys'))] : [], !axes || !styled),
    // A kind for every bar, and each direction on or off; the pane sets each series' bars on their own.
    sub(t('chartRibbon.add.errorBars'), 'chartScatter', errorBarsAllowed(chart) ? [
      radio(t('common.none'), state.errorBars.kind === 'none', el2('errorBars', 'none')),
      radio(t('chartRibbon.add.standardError'), state.errorBars.kind === 'stdErr', el2('errorBars', 'stdErr')),
      radio(t('chartRibbon.add.percentage'), state.errorBars.kind === 'percentage', el2('errorBars', 'percentage')),
      radio(t('chartRibbon.add.standardDeviation'), state.errorBars.kind === 'stdDev', el2('errorBars', 'stdDev')),
      { separator: true },
      check(t('chartRibbon.add.verticalErrorBars'), state.errorBars.y, el2('errorBars', { axis: 'y', on: !state.errorBars.y })),
      check(t('chartRibbon.add.horizontalErrorBars'), state.errorBars.x, el2('errorBars', { axis: 'x', on: !state.errorBars.x })),
      { separator: true }, { label: t('chartRibbon.add.moreErrorBarsOptions'), cmd: 'chart', arg: { action: 'formatPane', element: 'errorBars:0' } }] : [], !errorBarsAllowed(chart)),
    sub(t('chartRibbon.add.gridlines'), 'gridlines', axes ? [
      check(t('chartRibbon.add.horizontalLines'), state.gridlines.horizontal, el2('gridlines', { axis: 'horizontal', on: !state.gridlines.horizontal }),
        { disabled: !can('gridlines', { axis: 'horizontal', on: true }) }),
      check(t('chartRibbon.add.verticalLines'), state.gridlines.vertical, el2('gridlines', { axis: 'vertical', on: !state.gridlines.vertical }),
        { disabled: !can('gridlines', { axis: 'vertical', on: true }) })] : [], !axes),
    sub(t('chartRibbon.add.legend'), 'notes', [
      radio(t('common.none'), state.legend === 'none', el2('legend', 'none')),
      radio(t('chartRibbon.add.right'), state.legend === 'right', el2('legend', 'right')),
      radio(t('chartRibbon.add.top'), state.legend === 'top', el2('legend', 'top')),
      radio(t('chartRibbon.add.bottom'), state.legend === 'bottom', el2('legend', 'bottom')),
      { separator: true }, { label: t('chartRibbon.add.moreLegendOptions'), cmd: 'chart', arg: { action: 'formatPane', element: 'legend' } }]),
    sub(t('chartRibbon.add.trendline'), 'chartLine', can('trendline', 'linear') ? [
      radio(t('common.none'), state.trendline === 'none', el2('trendline', 'none')),
      ...TREND_TYPES.map(([value, label]) => radio(label, state.trendline === value, el2('trendline', value))),
      // The pane opens on the first series' trendline (adding none: it offers the kinds itself).
      { separator: true }, { label: t('chartRibbon.add.moreTrendlineOptions'), cmd: 'chart', arg: { action: 'formatPane', element: 'trendline:0' } }] : [], !can('trendline', 'linear')),
  ];
}

/** A small drawing of the selected chart with a patch applied, for the Quick Layout and Chart Styles galleries. */
function preview(ctx, chart, patch, w = 100, h = 66) {
  const sheetId = ctx.sheetId();
  const next = { ...chart, ...patch };
  const scaled = next.appearance ? { ...next, appearance: shrink(next.appearance, w / chart.w) } : next;
  try { return renderChartSvg(chartData(ctx.wb, sheetId, next), scaled, w, h); } catch { return ''; }
}
function shrink(a, k) {
  const out = { ...a, plot: null, title: null, legend: null };
  const size = st => ({ ...st, size: Math.max(4, st.size * Math.max(.3, k)) });
  for (const key of ['textStyle', 'titleStyle', 'legendStyle', 'xStyle', 'yStyle', 'y2Style']) if (a[key]) out[key] = size(a[key]);
  if (a.valueLabels) out.valueLabels = a.valueLabels.map(l => ({ ...l, style: l.style ? size(l.style) : l.style }));
  if (a.pie?.labels) out.pie = { ...a.pie, labels: { ...a.pie.labels, style: size(a.pie.labels.style) } };
  if (a.dataTable) out.dataTable = { ...a.dataTable, style: size(a.dataTable.style) };
  return out;
}

function quickLayoutMenu(ctx) {
  const chart = activeChart(ctx);
  if (!chart) return [];
  const count = seriesCountOf(ctx.wb, ctx.sheetId(), chart);
  return [{ custom: tileGrid(t('chartRibbon.quickLayout'), quickLayoutsFor(chart).map(l => ({ label: l.label,
    html: preview(ctx, chart, quickLayoutPatch(chart, l.id, { seriesCount: count })),
    onPick: () => run(ctx, { action: 'quickLayout', layout: l.id }) })), { columns: 3, className: 'chart-gallery-large' }) }];
}

function chartStylesMenu(ctx) {
  const chart = activeChart(ctx);
  if (!chart) return [];
  if (!chart.appearance) return [{ label: t('chartRibbon.stylesNeedDefault'), disabled: true }];
  const count = seriesCountOf(ctx.wb, ctx.sheetId(), chart);
  return [{ custom: tileGrid(t('chartRibbon.chartStyles'), CHART_STYLES.map(s => ({ label: s.label,
    html: preview(ctx, chart, chartStylePatch(chart, s.id, { seriesCount: count })),
    onPick: () => run(ctx, { action: 'style', style: s.id }) })), { columns: 4, className: 'chart-gallery-large' }) }];
}

function changeColorsMenu(ctx) {
  const chart = activeChart(ctx);
  if (!chart) return [];
  const accents = themedSeriesColors(ctx.wb) || SERIES_COLORS.slice(0, 6);
  const { colorful, monochromatic } = colorPalettes(accents);
  const row = p => el('button.chart-palette-row', { type: 'button', role: 'menuitem', tabindex: -1, title: p.label, 'aria-label': p.label,
    onclick: () => { closeMenu(); run(ctx, { action: 'colors', colors: p.colors }); } },
  ...p.colors.map(c => el('span.chart-palette-chip', { style: { background: c }, 'aria-hidden': 'true' })));
  return [{ header: t('chartRibbon.colorful') }, { custom: el('div.chart-palettes', { role: 'group', 'aria-label': t('chartRibbon.colorful') }, ...colorful.map(row)) },
    { header: t('chartRibbon.monochromatic') }, { custom: el('div.chart-palettes', { role: 'group', 'aria-label': t('chartRibbon.monochromatic') }, ...monochromatic.map(row)) }];
}

/** `key` names the label in the catalog. */
const design = (key, glyph, build, extra = {}) => {
  const n = naming(key);
  return { ...n, glyph, ariaLabel: n.label, ...extra,
    resolve: (menus, ctx) => { const disabled = cannotEdit(ctx); return lazySubmenu({ label: n.label, disabled }, () => (disabled ? [] : build(ctx))); } };
};
const action = (key, glyph, arg, extra = {}) => {
  const n = naming(key);
  return { ...n, glyph, ariaLabel: n.label, ...extra,
    resolve: (menus, ctx) => ({ label: n.label, cmd: 'chart', arg, disabled: cannotEdit(ctx) || !!extra.unavailable?.(ctx) }) };
};

export function chartDesignGroups() {
  return [
    ['Chart Layouts', { ...design('chartRibbon.addChartElement', 'addChartElement', addElementMenu), large: true }, { ...design('chartRibbon.quickLayout', 'quickLayout', quickLayoutMenu), large: true }],
    ['Chart Styles', { ...design('chartRibbon.changeColors', 'changeColors', changeColorsMenu), large: true }, { ...design('chartRibbon.chartStyles', 'chartStyles', chartStylesMenu), large: true }],
    ['Data', { ...action('chartRibbon.switchRowColumn', 'switchRowCol', { action: 'switchRowCol' }, { unavailable: ctx => !!activeChart(ctx)?.sourceRefs?.length }), large: true },
      { ...action('chartRibbon.selectData', 'selectData', { action: 'selectData' }), large: true }],
    ['Type', { ...action('chartRibbon.changeChartType', 'changeChartType', { action: 'changeType' }), large: true }],
    ['Location', { ...action('chartRibbon.moveChart', 'moveChart', { action: 'move' }), large: true }],
  ];
}

/* ---------- Format ---------- */

const ELEMENT_LABELS = { chartArea: 'chartRibbon.element.chartArea', plotArea: 'chartRibbon.element.plotArea', title: 'chartRibbon.element.chartTitle',
  legend: 'chartRibbon.element.legend', xAxis: 'chartRibbon.element.categoryAxis', yAxis: 'chartRibbon.element.valueAxis',
  y2Axis: 'chartRibbon.element.secondaryValueAxis', xTitle: 'chartRibbon.element.categoryAxisTitle', yTitle: 'chartRibbon.element.valueAxisTitle',
  'gridlines-y': 'chartRibbon.element.valueGridlines', 'gridlines-x': 'chartRibbon.element.categoryGridlines' };

/** The name the Chart Elements box gives an element key. */
export function elementLabel(key, names = []) {
  if (Object.hasOwn(ELEMENT_LABELS, key)) return t(ELEMENT_LABELS[key]);
  // A series is named as the chart names it, or by its number.
  const series = (i) => names[+i] ?? +i + 1;
  let m = /^series:(\d+)$/.exec(key);
  if (m) return t('chartRibbon.element.series', { name: series(m[1]) });
  m = /^point:(\d+):(\d+)$/.exec(key);
  if (m) return t('chartRibbon.element.point', { name: series(m[1]), point: +m[2] + 1 });
  m = /^dataLabels:(\d+)$/.exec(key);
  if (m) return t('chartRibbon.element.dataLabels', { name: series(m[1]) });
  m = /^(trendline|trendlineLabel):(\d+)$/.exec(key);
  if (m) return m[1] === 'trendlineLabel' ? t('chartRibbon.element.trendlineLabel', { name: series(m[2]) }) : t('chartRibbon.element.trendline', { name: series(m[2]) });
  m = /^errorBars:(\d+)$/.exec(key);
  if (m) return t('chartRibbon.element.errorBars', { name: series(m[1]) });
  return key;
}

/** The elements a chart has, in the Chart Elements box's order. */
export function chartElementKeys(chart, seriesCount) {
  const axes = hasAxes(chart), a = chart.appearance || {};
  return ['chartArea', ...(axes ? ['plotArea'] : []), ...(chart.title ? ['title'] : []), ...(chart.legend !== false ? ['legend'] : []),
    ...(axes && !a.hideXAxis ? ['xAxis'] : []), ...(axes && !a.hideYAxis ? ['yAxis'] : []), ...(secondaryAxis(chart) && !a.hideY2Axis ? ['y2Axis'] : []),
    ...(axes && chart.xTitle ? ['xTitle'] : []), ...(axes && chart.yTitle ? ['yTitle'] : []),
    ...(axes && chart.gridlines !== false ? ['gridlines-y'] : []), ...(axes && a.xGridlines ? ['gridlines-x'] : []),
    ...Array.from({ length: isPieChart(chart) ? 1 : seriesCount }, (_, j) => `series:${j}`),
    ...Array.from({ length: trendlineAllowed(chart) ? seriesCount : 0 }, (_, j) => trendFor(chart, j)).flatMap((trend, j) => (!trend ? []
      : trend.type !== 'movingAvg' && (trend.dispEq || trend.dispRSqr) ? [`trendline:${j}`, `trendlineLabel:${j}`] : [`trendline:${j}`])),
    ...Array.from({ length: seriesCount }, (_, j) => j).filter(j => errorBarsFor(chart, j)).map(j => `errorBars:${j}`)];
}

const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
function colorMenu(ctx, kind) {
  const pick = hex => run(ctx, { action: 'format', [kind]: hex });
  const block = themeColorBlock(ctx.wb, { onPick: c => { closeMenu(); pick(c.rgb.toLowerCase()); } });
  const standard = el('div.swatches', { role: 'group', 'aria-label': t('chartRibbon.standardColors'), 'data-cols': 10 },
    ...STANDARD.map(c => el('button.swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': c, title: c, style: { background: c }, onclick: () => { closeMenu(); pick(c); } })));
  const custom = customColorRows({ onPick: hex => { closeMenu(); pick(hex); }, role: 'menuitem', label: kind === 'fill' ? t('chartRibbon.fillColorNoun') : t('chartRibbon.outlineColorNoun') });
  return [...block.map(custom => ({ custom })), { header: t('chartRibbon.standardColors') }, { custom: standard }, ...custom.map(c => ({ custom: c })),
    { separator: true }, { label: kind === 'fill' ? t('chartRibbon.noFill') : t('chartRibbon.noOutline'), cmd: 'chart', arg: { action: 'format', [kind]: 'none' } },
    ...(kind === 'outline' ? [{ label: t('chartRibbon.weight'), submenu: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map(pt => ({ label: t('chartRibbon.points', { pt }), cmd: 'chart', arg: { action: 'format', outlineWidth: Math.round(pt * 4 / 3 * 100) / 100 } })) }] : [])];
}

function effectsMenu(ctx) {
  const chart = activeChart(ctx), key = ctx.chartUi?.element() || 'chartArea';
  const effectKey = /^point:(\d+)/.test(key) ? `series:${key.split(':')[1]}` : key;
  const current = chart?.appearance?.effects?.[effectKey] || {};
  const can = ['chartArea', 'plotArea', 'title', 'legend'].includes(effectKey) || /^series:\d+$/.test(effectKey);
  return [
    radio(t('chartRibbon.noEffect'), !current.shadow && !current.glow, { action: 'format', effect: { shadow: false, glow: null } }, { disabled: !can }),
    radio(t('chartRibbon.shadow'), current.shadow && !current.glow, { action: 'format', effect: { shadow: true, glow: null } }, { disabled: !can }),
    { header: t('chartRibbon.glow') },
    ...[['chartRibbon.glowBlue', '#4472c4'], ['chartRibbon.glowOrange', '#ed7d31'], ['chartRibbon.glowGold', '#ffc000'], ['chartRibbon.glowGreen', '#70ad47']].map(([name, c]) =>
      radio(t(name), current.glow === c, { action: 'format', effect: { shadow: false, glow: c } }, { disabled: !can, swatch: c })),
  ];
}

/** Format ▸ Current Selection: the Chart Elements box, kept in step with the element selected on the chart. */
function elementPicker(ctx) {
  const select = el('select.select.ribbon-control.chart-element-picker', { 'aria-label': t('chartRibbon.chartElements'), tabindex: -1, dataset: { keytipLabel: tSource('chartRibbon.chartElements') },
    onchange: () => run(ctx, { action: 'selectElement', element: select.value }) });
  const sync = () => {
    const chart = activeChart(ctx);
    select.disabled = !chart || !!flags(ctx).editing;
    if (!chart) { select.replaceChildren(); return; }
    const data = chartData(ctx.wb, ctx.sheetId(), chart), names = data.series.map(s => s.name);
    const keys = chartElementKeys(chart, data.series.length), current = ctx.chartUi?.element() || 'chartArea';
    if (!keys.includes(current)) keys.push(current);
    const sig = keys.join('|') + names.join('|');
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.replaceChildren(...keys.map(k => el('option', { value: k }, elementLabel(k, names))));
    }
    select.value = current;
  };
  sync();
  return Object.assign(el('div.chart-element-picker-wrap', {}, select), { refresh: sync });
}

function sizeFields(ctx) {
  const field = (label, name, key) => {
    const input = el('input.input.ribbon-control.chart-size-input', { type: 'number', min: 0.4, max: 40, step: 0.01, 'aria-label': t(name), tabindex: -1, dataset: { keytipLabel: tSource(name) },
      onchange: () => { const inches = Number(input.value); if (Number.isFinite(inches) && inches > 0) run(ctx, { action: 'size', [key]: Math.round(inches * 96) }); },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('change')); ctx.grid.focus(); } } });
    return { input, row: el('label.chart-size-field', {}, el('span', { html: icon(key === 'h' ? 'rowHeight' : 'colWidth', 16), 'aria-hidden': 'true' }), el('span.chart-size-label', {}, label), input, el('span', {}, '"')) };
  };
  const h = field(t('chartRibbon.height'), 'chartRibbon.shapeHeight', 'h'), w = field(t('chartRibbon.width'), 'chartRibbon.shapeWidth', 'w');
  const sync = () => {
    const chart = activeChart(ctx);
    for (const [f, key] of [[h, 'h'], [w, 'w']]) {
      f.input.disabled = !chart || !!flags(ctx).editing || ctx.wb.sheet(ctx.sheetId())?.kind === 'chart';
      if (document.activeElement !== f.input) f.input.value = chart ? (chart[key] / 96).toFixed(2) : '';
    }
  };
  sync();
  return Object.assign(el('div.chart-size-fields', {}, h.row, w.row), { refresh: sync });
}

export function chartFormatGroups() {
  const menu = (key, glyph, build) => design(key, glyph, build);
  return [
    ['Current Selection', { label: t('chartRibbon.chartElements'), element: elementPicker },
      action('chartRibbon.formatSelection', 'formatSelection', { action: 'formatPane' }),
      action('chartRibbon.resetToMatchStyle', 'resetStyle', { action: 'resetStyle' }, { unavailable: ctx => !activeChart(ctx)?.appearance })],
    ['Shape Styles', menu('chartRibbon.shapeFill', 'shapeFill', ctx => colorMenu(ctx, 'fill')), menu('chartRibbon.shapeOutline', 'shapeOutline', ctx => colorMenu(ctx, 'outline')),
      menu('chartRibbon.shapeEffects', 'shapeEffects', effectsMenu)],
    arrangeGroup({ large: false }),
    ['Size', { label: t('chartRibbon.size'), element: sizeFields }],
  ];
}

