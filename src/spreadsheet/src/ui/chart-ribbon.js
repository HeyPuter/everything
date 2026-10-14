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
import { CHART_STYLES, chartElementPatch, chartElementState, chartStylePatch, colorPalettes, dataLabelPositions, hasAxes, isPieChart,
  quickLayoutPatch, quickLayoutsFor } from '../core/chart-design.js';
import { themedSeriesColors } from '../core/workbook-theme.js';
import { arrangeGroup } from './arrange-ribbon.js';

const run = (ctx, arg) => ctx.run('chart', arg);
const flags = ctx => ctx?.flags?.() || {};
const cannotInsert = ctx => !!(flags(ctx).editing || flags(ctx).chartSheet || flags(ctx).away);
const cannotEdit = ctx => !!flags(ctx).editing || !activeChart(ctx) || !!ctx.wb.sheet(ctx.sheetId())?.protected;

/** A grid of picture tiles inside a menu; a pick closes the menu and runs `onPick`. */
function tileGrid(label, tiles, { columns = 3, className = '' } = {}) {
  const grid = el(`div.chart-gallery-grid${className ? `.${className}` : ''}`, { role: 'group', 'aria-label': label, style: { gridTemplateColumns: `repeat(${columns}, auto)` } },
    ...tiles.map(t => el('button.chart-gallery-tile', {
      type: 'button', role: t.checked == null ? 'menuitem' : 'menuitemradio', tabindex: -1, title: t.label, 'aria-label': t.label,
      ...(t.checked == null ? {} : { 'aria-checked': String(!!t.checked) }),
      onclick: () => { closeMenu(); t.onPick(); },
    }, el('span.chart-gallery-picture', { html: t.html, 'aria-hidden': 'true' }))));
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

/** One Insert ▸ Charts button: its gallery of subtypes, then its More … chart types item. */
function gallery(g) {
  return {
    label: g.label, glyph: g.icon, ariaLabel: g.id === 'other' ? 'Other Charts: waterfall, funnel, stock, surface or radar' : `Insert ${g.label.toLowerCase()} chart`,
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
    { label: 'Recommended Charts', glyph: 'recommendedCharts', ariaLabel: 'Recommended Charts', large: true,
      resolve: (menus, ctx) => ({ label: 'Recommended Charts', cmd: 'chart', arg: { action: 'recommended' }, disabled: cannotInsert(ctx) }) },
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
  const can = (element, value) => !!chartElementPatch(chart, element, value, { seriesCount: 1 });
  const sub = (label, iconName, items, disabled = false) => ({ label, icon: iconName, submenu: items, disabled: disabled || !items.length });
  return [
    sub('Axes', 'chartColumn', axes && styled ? [
      check('Horizontal Axis', state.axes.horizontal, el2('axes', { axis: 'horizontal', on: !state.axes.horizontal })),
      check('Vertical Axis', state.axes.vertical, el2('axes', { axis: 'vertical', on: !state.axes.vertical })),
      { separator: true }, { label: 'More Axis Options…', cmd: 'chart', arg: { action: 'formatPane', element: 'yAxis' } }] : [], !axes || !styled),
    sub('Axis Titles', 'textBox', axes ? [
      check('Horizontal Axis Title', state.axisTitles.horizontal, el2('axisTitles', { axis: 'horizontal', on: !state.axisTitles.horizontal })),
      check('Vertical Axis Title', state.axisTitles.vertical, el2('axisTitles', { axis: 'vertical', on: !state.axisTitles.vertical }))] : [], !axes),
    sub('Chart Title', 'textBox', [
      radio('None', state.chartTitle === 'none', el2('chartTitle', 'none')),
      radio('Above Chart', state.chartTitle === 'above', el2('chartTitle', 'above')),
      { separator: true }, { label: 'More Title Options…', cmd: 'chart', arg: { action: 'formatPane', element: 'title' } }]),
    sub('Data Labels', 'number', [
      radio('None', state.dataLabels === 'none', el2('dataLabels', 'none')),
      ...dataLabelPositions(chart).map(([value, label]) => radio(label, state.dataLabels === value || (value === 'show' && state.dataLabels !== 'none'), el2('dataLabels', value))),
      { separator: true }, { label: 'More Data Label Options…', cmd: 'chart', arg: { action: 'formatPane', element: 'dataLabels:0' } }]),
    sub('Data Table', 'table', axes && styled && can('dataTable', 'keys') ? [
      radio('None', state.dataTable === 'none', el2('dataTable', 'none')),
      radio('With Legend Keys', state.dataTable === 'keys', el2('dataTable', 'keys')),
      radio('No Legend Keys', state.dataTable === 'noKeys', el2('dataTable', 'noKeys'))] : [], !axes || !styled),
    sub('Gridlines', 'gridlines', axes ? [
      check('Horizontal Lines', state.gridlines.horizontal, el2('gridlines', { axis: 'horizontal', on: !state.gridlines.horizontal }),
        { disabled: !can('gridlines', { axis: 'horizontal', on: true }) }),
      check('Vertical Lines', state.gridlines.vertical, el2('gridlines', { axis: 'vertical', on: !state.gridlines.vertical }),
        { disabled: !can('gridlines', { axis: 'vertical', on: true }) })] : [], !axes),
    sub('Legend', 'notes', [
      radio('None', state.legend === 'none', el2('legend', 'none')),
      radio('Right', state.legend === 'right', el2('legend', 'right')),
      radio('Top', state.legend === 'top', el2('legend', 'top')),
      radio('Bottom', state.legend === 'bottom', el2('legend', 'bottom')),
      { separator: true }, { label: 'More Legend Options…', cmd: 'chart', arg: { action: 'formatPane', element: 'legend' } }]),
    sub('Trendline', 'chartLine', !pie && !chart.stacked ? [
      radio('None', state.trendline === 'none', el2('trendline', 'none')),
      radio('Linear', state.trendline === 'linear', el2('trendline', 'linear'))] : [], pie || !!chart.stacked),
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
  return [{ custom: tileGrid('Quick Layout', quickLayoutsFor(chart).map(l => ({ label: l.label,
    html: preview(ctx, chart, quickLayoutPatch(chart, l.id, { seriesCount: count })),
    onPick: () => run(ctx, { action: 'quickLayout', layout: l.id }) })), { columns: 3, className: 'chart-gallery-large' }) }];
}

function chartStylesMenu(ctx) {
  const chart = activeChart(ctx);
  if (!chart) return [];
  if (!chart.appearance) return [{ label: 'Chart styles need a chart in the default style. Change Chart Type gives it one.', disabled: true }];
  const count = seriesCountOf(ctx.wb, ctx.sheetId(), chart);
  return [{ custom: tileGrid('Chart Styles', CHART_STYLES.map(s => ({ label: s.label,
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
  return [{ header: 'Colorful' }, { custom: el('div.chart-palettes', { role: 'group', 'aria-label': 'Colorful' }, ...colorful.map(row)) },
    { header: 'Monochromatic' }, { custom: el('div.chart-palettes', { role: 'group', 'aria-label': 'Monochromatic' }, ...monochromatic.map(row)) }];
}

const design = (label, glyph, build, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => { const disabled = cannotEdit(ctx); return lazySubmenu({ label, disabled }, () => (disabled ? [] : build(ctx))); } });
const action = (label, glyph, arg, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => ({ label, cmd: 'chart', arg, disabled: cannotEdit(ctx) || !!extra.unavailable?.(ctx) }) });

export function chartDesignGroups() {
  return [
    ['Chart Layouts', { ...design('Add Chart Element', 'addChartElement', addElementMenu), large: true }, { ...design('Quick Layout', 'quickLayout', quickLayoutMenu), large: true }],
    ['Chart Styles', { ...design('Change Colors', 'changeColors', changeColorsMenu), large: true }, { ...design('Chart Styles', 'chartStyles', chartStylesMenu), large: true }],
    ['Data', { ...action('Switch Row/Column', 'switchRowCol', { action: 'switchRowCol' }, { unavailable: ctx => !!activeChart(ctx)?.sourceRefs?.length }), large: true },
      { ...action('Select Data', 'selectData', { action: 'selectData' }), large: true }],
    ['Type', { ...action('Change Chart Type', 'changeChartType', { action: 'changeType' }), large: true }],
    ['Location', { ...action('Move Chart', 'moveChart', { action: 'move' }), large: true }],
  ];
}

/* ---------- Format ---------- */

const ELEMENT_LABELS = { chartArea: 'Chart Area', plotArea: 'Plot Area', title: 'Chart Title', legend: 'Legend', xAxis: 'Category Axis',
  yAxis: 'Value Axis', y2Axis: 'Secondary Value Axis', xTitle: 'Category Axis Title', yTitle: 'Value Axis Title',
  'gridlines-y': 'Value Gridlines', 'gridlines-x': 'Category Gridlines' };

/** The name the Chart Elements box gives an element key. */
export function elementLabel(key, names = []) {
  if (ELEMENT_LABELS[key]) return ELEMENT_LABELS[key];
  let m = /^series:(\d+)$/.exec(key);
  if (m) return `Series "${names[+m[1]] ?? +m[1] + 1}"`;
  m = /^point:(\d+):(\d+)$/.exec(key);
  if (m) return `Series "${names[+m[1]] ?? +m[1] + 1}" Point ${+m[2] + 1}`;
  m = /^dataLabels:(\d+)$/.exec(key);
  if (m) return `Series "${names[+m[1]] ?? +m[1] + 1}" Data Labels`;
  return key;
}

/** The elements a chart has, in the Chart Elements box's order. */
export function chartElementKeys(chart, seriesCount) {
  const axes = hasAxes(chart), a = chart.appearance || {};
  return ['chartArea', ...(axes ? ['plotArea'] : []), ...(chart.title ? ['title'] : []), ...(chart.legend !== false ? ['legend'] : []),
    ...(axes && !a.hideXAxis ? ['xAxis'] : []), ...(axes && !a.hideYAxis ? ['yAxis'] : []),
    ...(axes && chart.xTitle ? ['xTitle'] : []), ...(axes && chart.yTitle ? ['yTitle'] : []),
    ...(axes && chart.gridlines !== false ? ['gridlines-y'] : []), ...(axes && a.xGridlines ? ['gridlines-x'] : []),
    ...Array.from({ length: isPieChart(chart) ? 1 : seriesCount }, (_, j) => `series:${j}`)];
}

const STANDARD = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
function colorMenu(ctx, kind) {
  const pick = hex => run(ctx, { action: 'format', [kind]: hex });
  const block = themeColorBlock(ctx.wb, { onPick: c => { closeMenu(); pick(c.rgb.toLowerCase()); } });
  const standard = el('div.swatches', { role: 'group', 'aria-label': 'Standard Colors', 'data-cols': 10 },
    ...STANDARD.map(c => el('button.swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': c, title: c, style: { background: c }, onclick: () => { closeMenu(); pick(c); } })));
  const custom = customColorRows({ onPick: hex => { closeMenu(); pick(hex); }, role: 'menuitem', label: kind === 'fill' ? 'fill color' : 'outline color' });
  return [...block.map(custom => ({ custom })), { header: 'Standard Colors' }, { custom: standard }, ...custom.map(c => ({ custom: c })),
    { separator: true }, { label: kind === 'fill' ? 'No Fill' : 'No Outline', cmd: 'chart', arg: { action: 'format', [kind]: 'none' } },
    ...(kind === 'outline' ? [{ label: 'Weight', submenu: [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6].map(pt => ({ label: `${pt} pt`, cmd: 'chart', arg: { action: 'format', outlineWidth: Math.round(pt * 4 / 3 * 100) / 100 } })) }] : [])];
}

function effectsMenu(ctx) {
  const chart = activeChart(ctx), key = ctx.chartUi?.element() || 'chartArea';
  const effectKey = /^point:(\d+)/.test(key) ? `series:${key.split(':')[1]}` : key;
  const current = chart?.appearance?.effects?.[effectKey] || {};
  const can = ['chartArea', 'plotArea', 'title', 'legend'].includes(effectKey) || /^series:\d+$/.test(effectKey);
  return [
    radio('No Effect', !current.shadow && !current.glow, { action: 'format', effect: { shadow: false, glow: null } }, { disabled: !can }),
    radio('Shadow', current.shadow && !current.glow, { action: 'format', effect: { shadow: true, glow: null } }, { disabled: !can }),
    { header: 'Glow' },
    ...[['Blue', '#4472c4'], ['Orange', '#ed7d31'], ['Gold', '#ffc000'], ['Green', '#70ad47']].map(([name, c]) =>
      radio(`${name} Glow`, current.glow === c, { action: 'format', effect: { shadow: false, glow: c } }, { disabled: !can, swatch: c })),
  ];
}

/** Format ▸ Current Selection: the Chart Elements box, kept in step with the element selected on the chart. */
function elementPicker(ctx) {
  const select = el('select.select.ribbon-control.chart-element-picker', { 'aria-label': 'Chart Elements', tabindex: -1,
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
  const field = (label, key) => {
    const input = el('input.input.ribbon-control.chart-size-input', { type: 'number', min: 0.4, max: 40, step: 0.01, 'aria-label': `Shape ${label}`, tabindex: -1,
      onchange: () => { const inches = Number(input.value); if (Number.isFinite(inches) && inches > 0) run(ctx, { action: 'size', [key]: Math.round(inches * 96) }); },
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('change')); ctx.grid.focus(); } } });
    return { input, row: el('label.chart-size-field', {}, el('span', { html: icon(key === 'h' ? 'rowHeight' : 'colWidth', 16), 'aria-hidden': 'true' }), el('span.chart-size-label', {}, label), input, el('span', {}, '"')) };
  };
  const h = field('Height', 'h'), w = field('Width', 'w');
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
  const menu = (label, glyph, build) => design(label, glyph, build);
  return [
    ['Current Selection', { label: 'Chart Elements', element: elementPicker },
      action('Format Selection', 'formatSelection', { action: 'formatPane' }),
      action('Reset to Match Style', 'resetStyle', { action: 'resetStyle' }, { unavailable: ctx => !activeChart(ctx)?.appearance })],
    ['Shape Styles', menu('Shape Fill', 'shapeFill', ctx => colorMenu(ctx, 'fill')), menu('Shape Outline', 'shapeOutline', ctx => colorMenu(ctx, 'outline')),
      menu('Shape Effects', 'shapeEffects', effectsMenu)],
    arrangeGroup({ large: false }),
    ['Size', { label: 'Size', element: sizeFields }],
  ];
}

