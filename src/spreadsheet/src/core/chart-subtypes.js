/**
 * The chart workflow: the Insert ▸ Charts galleries (each button a drop-down of subtypes), the
 * default look a new chart takes (theme series colours, a 14pt dark grey
 * title, 9pt grey axis labels, light grey major gridlines, the legend at the bottom, a white chart area
 * with a light grey border), and the subtype a chart is, so Change Chart Type can show it and swap it.
 *
 * The look is an `appearance` (see charts.js): the same model imported charts carry, so new
 * charts draw through the native-style renderer and write the same DrawingML Excel reads back.
 */
import { colName, normalizeRange } from './cell.js';
import { chartData, defaultChart } from './charts.js';
import { quoteSheet } from './refs.js';
import { t } from '../i18n/index.js';

// Default chart text: Text 1 at 65% (#595959); its lines: Text 1 at 15% (#D9D9D9).
export const CHART_TEXT_GREY = '#595959';
export const CHART_LINE_GREY = '#d9d9d9';
// Points as the model's pixels (the appearance stores sizes at 96 dpi, as imported charts do).
const pt = n => Math.round(n * 4 / 3 * 100) / 100;

/**
 * The galleries, in the order the ribbon shows them. Each subtype names the chart model it makes: a type and the
 * flags that make the variant (stacking, markers, the lines of a scatter chart).
 */
export const CHART_GALLERIES = Object.freeze([
  { id: 'column', get label() { return t('chartSubtypes.column'); }, icon: 'chartColumn', get more() { return t('chartSubtypes.moreColumn'); }, groups: [
    { get header() { return t('chartSubtypes.column'); }, items: [
      { id: 'columnClustered', get label() { return t('chartSubtypes.clusteredColumn'); }, type: 'column', icon: 'chartColumnClustered' },
      { id: 'columnStacked', get label() { return t('chartSubtypes.stackedColumn'); }, type: 'column', stacked: true, icon: 'chartColumnStacked' },
      { id: 'columnStacked100', get label() { return t('chartSubtypes.stacked100Column'); }, type: 'column', stacked: true, stack100: true, icon: 'chartColumnStacked100' }] }] },
  { id: 'line', get label() { return t('chartSubtypes.line'); }, icon: 'chartLine', get more() { return t('chartSubtypes.moreLine'); }, groups: [
    { get header() { return t('chartSubtypes.line'); }, items: [
      { id: 'line', get label() { return t('chartSubtypes.line'); }, type: 'line', markers: false, icon: 'chartLinePlain' },
      { id: 'lineStacked', get label() { return t('chartSubtypes.stackedLine'); }, type: 'line', stacked: true, markers: false, icon: 'chartLineStacked' },
      { id: 'lineStacked100', get label() { return t('chartSubtypes.stacked100Line'); }, type: 'line', stacked: true, stack100: true, markers: false, icon: 'chartLineStacked100' },
      { id: 'lineMarkers', get label() { return t('chartSubtypes.lineMarkers'); }, type: 'line', markers: true, icon: 'chartLineMarkers' },
      { id: 'lineStackedMarkers', get label() { return t('chartSubtypes.stackedLineMarkers'); }, type: 'line', stacked: true, markers: true, icon: 'chartLineStackedMarkers' },
      { id: 'lineStacked100Markers', get label() { return t('chartSubtypes.stacked100LineMarkers'); }, type: 'line', stacked: true, stack100: true, markers: true, icon: 'chartLineStacked100Markers' }] }] },
  { id: 'pie', get label() { return t('chartSubtypes.pie'); }, icon: 'chartPie', get more() { return t('chartSubtypes.morePie'); }, groups: [
    { get header() { return t('chartSubtypes.pie'); }, items: [
      { id: 'pie', get label() { return t('chartSubtypes.pie'); }, type: 'pie', icon: 'chartPie' },
      { id: 'pieExploded', get label() { return t('chartSubtypes.explodedPie'); }, type: 'pie', explosion: 15, icon: 'chartPieExploded' },
      { id: 'pieOfPie', get label() { return t('chartSubtypes.pieOfPie'); }, type: 'pie', ofPie: 'pie', icon: 'chartPieOfPie' },
      { id: 'barOfPie', get label() { return t('chartSubtypes.barOfPie'); }, type: 'pie', ofPie: 'bar', icon: 'chartBarOfPie' }] },
    { get header() { return t('chartSubtypes.doughnut'); }, items: [
      { id: 'doughnut', get label() { return t('chartSubtypes.doughnut'); }, type: 'donut', icon: 'chartDoughnut' },
      { id: 'doughnutExploded', get label() { return t('chartSubtypes.explodedDoughnut'); }, type: 'donut', explosion: 15, icon: 'chartDoughnutExploded' }] }] },
  { id: 'bar', get label() { return t('chartSubtypes.bar'); }, icon: 'chartBar', get more() { return t('chartSubtypes.moreBar'); }, groups: [
    { get header() { return t('chartSubtypes.bar'); }, items: [
      { id: 'barClustered', get label() { return t('chartSubtypes.clusteredBar'); }, type: 'bar', icon: 'chartBarClustered' },
      { id: 'barStacked', get label() { return t('chartSubtypes.stackedBar'); }, type: 'bar', stacked: true, icon: 'chartBarStacked' },
      { id: 'barStacked100', get label() { return t('chartSubtypes.stacked100Bar'); }, type: 'bar', stacked: true, stack100: true, icon: 'chartBarStacked100' }] }] },
  { id: 'area', get label() { return t('chartSubtypes.area'); }, icon: 'chartArea', get more() { return t('chartSubtypes.moreArea'); }, groups: [
    { get header() { return t('chartSubtypes.area'); }, items: [
      { id: 'area', get label() { return t('chartSubtypes.area'); }, type: 'area', icon: 'chartArea' },
      { id: 'areaStacked', get label() { return t('chartSubtypes.stackedArea'); }, type: 'area', stacked: true, icon: 'chartAreaStacked' },
      { id: 'areaStacked100', get label() { return t('chartSubtypes.stacked100Area'); }, type: 'area', stacked: true, stack100: true, icon: 'chartAreaStacked100' }] }] },
  { id: 'scatter', get label() { return t('chartSubtypes.scatter'); }, icon: 'chartScatter', get more() { return t('chartSubtypes.moreScatter'); }, groups: [
    { get header() { return t('chartSubtypes.scatter'); }, items: [
      { id: 'scatter', get label() { return t('chartSubtypes.scatter'); }, type: 'scatter', markers: true, lines: 'none', icon: 'chartScatter' },
      { id: 'scatterSmoothMarkers', get label() { return t('chartSubtypes.scatterSmoothMarkers'); }, type: 'scatter', markers: true, lines: 'smooth', icon: 'chartScatterSmoothMarkers' },
      { id: 'scatterSmooth', get label() { return t('chartSubtypes.scatterSmooth'); }, type: 'scatter', markers: false, lines: 'smooth', icon: 'chartScatterSmooth' },
      { id: 'scatterLinesMarkers', get label() { return t('chartSubtypes.scatterLinesMarkers'); }, type: 'scatter', markers: true, lines: 'straight', icon: 'chartScatterLinesMarkers' },
      { id: 'scatterLines', get label() { return t('chartSubtypes.scatterLines'); }, type: 'scatter', markers: false, lines: 'straight', icon: 'chartScatterLines' }] },
    { get header() { return t('chartSubtypes.bubble'); }, items: [{ id: 'bubble', get label() { return t('chartSubtypes.bubble'); }, type: 'bubble', icon: 'chartBubble' }] }] },
  { id: 'hierarchy', get label() { return t('chartSubtypes.hierarchy'); }, icon: 'chartTreemap', get more() { return t('chartSubtypes.moreHierarchy'); }, groups: [
    { get header() { return t('chartSubtypes.treemap'); }, items: [{ id: 'treemap', get label() { return t('chartSubtypes.treemap'); }, type: 'treemap', icon: 'chartTreemap' }] },
    { get header() { return t('chartSubtypes.sunburst'); }, items: [{ id: 'sunburst', get label() { return t('chartSubtypes.sunburst'); }, type: 'sunburst', icon: 'chartSunburst' }] }] },
  { id: 'statistic', get label() { return t('chartSubtypes.statistic'); }, icon: 'chartBoxWhisker', get more() { return t('chartSubtypes.moreStatistic'); }, groups: [
    { get header() { return t('chartSubtypes.histogram'); }, items: [{ id: 'histogram', get label() { return t('chartSubtypes.histogram'); }, type: 'histogram', icon: 'chartHistogram' }] },
    { get header() { return t('chartSubtypes.boxAndWhisker'); }, items: [{ id: 'boxWhisker', get label() { return t('chartSubtypes.boxAndWhisker'); }, type: 'boxWhisker', icon: 'chartBoxWhisker' }] }] },
  { id: 'other', get label() { return t('chartSubtypes.otherCharts'); }, icon: 'chartStockOhlc', get more() { return t('chartSubtypes.moreOther'); }, groups: [
    { get header() { return t('chartSubtypes.waterfallAndFunnel'); }, items: [
      { id: 'waterfall', get label() { return t('chartSubtypes.waterfall'); }, type: 'waterfall', icon: 'chartWaterfall' },
      { id: 'funnel', get label() { return t('chartSubtypes.funnel'); }, type: 'funnel', icon: 'chartFunnel' }] },
    { get header() { return t('chartSubtypes.stock'); }, items: [
      { id: 'stockHlc', get label() { return t('chartSubtypes.highLowClose'); }, type: 'stock', stock: 'hlc', icon: 'chartStockHlc' },
      { id: 'stockOhlc', get label() { return t('chartSubtypes.openHighLowClose'); }, type: 'stock', stock: 'ohlc', icon: 'chartStockOhlc' },
      { id: 'stockVhlc', get label() { return t('chartSubtypes.volumeHighLowClose'); }, type: 'stock', stock: 'vhlc', icon: 'chartStockVhlc' },
      { id: 'stockVohlc', get label() { return t('chartSubtypes.volumeOpenHighLowClose'); }, type: 'stock', stock: 'vohlc', icon: 'chartStockVohlc' }] },
    { get header() { return t('chartSubtypes.surface'); }, items: [
      { id: 'surface3d', get label() { return t('chartSubtypes.surface3d'); }, type: 'surface', surfaceView: 'surface3d', icon: 'chartSurface' },
      { id: 'surfaceWireframe3d', get label() { return t('chartSubtypes.wireframeSurface3d'); }, type: 'surface', surfaceView: 'wireframe3d', icon: 'chartSurfaceWireframe' },
      { id: 'contour', get label() { return t('chartSubtypes.contour'); }, type: 'surface', surfaceView: 'contour', icon: 'chartContour' },
      { id: 'contourWireframe', get label() { return t('chartSubtypes.wireframeContour'); }, type: 'surface', surfaceView: 'wireframeContour', icon: 'chartContourWireframe' }] },
    { get header() { return t('chartSubtypes.radar'); }, items: [
      { id: 'radar', get label() { return t('chartSubtypes.radar'); }, type: 'radar', markers: false, icon: 'chartRadar' },
      { id: 'radarMarkers', get label() { return t('chartSubtypes.radarMarkers'); }, type: 'radar', markers: true, icon: 'chartRadarMarkers' },
      { id: 'radarFilled', get label() { return t('chartSubtypes.filledRadar'); }, type: 'radar', filled: true, icon: 'chartRadarFilled' }] }] },
  { id: 'combo', get label() { return t('chartSubtypes.combo'); }, icon: 'chartCombo', get more() { return t('chartSubtypes.moreCombo'); }, groups: [
    { get header() { return t('chartSubtypes.combo'); }, items: [
      { id: 'comboColumnLine', get label() { return t('chartSubtypes.columnLine'); }, type: 'combo', icon: 'chartCombo' },
      { id: 'comboColumnLineSecondary', get label() { return t('chartSubtypes.columnLineSecondary'); }, type: 'combo', secondaryAxis: true, icon: 'chartComboSecondary' }] }] },
]);

/** The All Charts list of Insert Chart and Change Chart Type: the chart families. */
export const CHART_FAMILIES = Object.freeze([
  { id: 'column', get label() { return t('chartSubtypes.column'); }, icon: 'chartColumn', subtypes: ['columnClustered', 'columnStacked', 'columnStacked100'] },
  { id: 'line', get label() { return t('chartSubtypes.line'); }, icon: 'chartLine', subtypes: ['line', 'lineStacked', 'lineStacked100', 'lineMarkers', 'lineStackedMarkers', 'lineStacked100Markers'] },
  { id: 'pie', get label() { return t('chartSubtypes.pie'); }, icon: 'chartPie', subtypes: ['pie', 'pieExploded', 'pieOfPie', 'barOfPie', 'doughnut', 'doughnutExploded'] },
  { id: 'bar', get label() { return t('chartSubtypes.bar'); }, icon: 'chartBar', subtypes: ['barClustered', 'barStacked', 'barStacked100'] },
  { id: 'area', get label() { return t('chartSubtypes.area'); }, icon: 'chartArea', subtypes: ['area', 'areaStacked', 'areaStacked100'] },
  { id: 'scatter', get label() { return t('chartSubtypes.scatter'); }, icon: 'chartScatter', subtypes: ['scatter', 'scatterSmoothMarkers', 'scatterSmooth', 'scatterLinesMarkers', 'scatterLines', 'bubble'] },
  { id: 'stock', get label() { return t('chartSubtypes.stock'); }, icon: 'chartStockOhlc', subtypes: ['stockHlc', 'stockOhlc', 'stockVhlc', 'stockVohlc'] },
  { id: 'surface', get label() { return t('chartSubtypes.surface'); }, icon: 'chartSurface', subtypes: ['surface3d', 'surfaceWireframe3d', 'contour', 'contourWireframe'] },
  { id: 'radar', get label() { return t('chartSubtypes.radar'); }, icon: 'chartRadar', subtypes: ['radar', 'radarMarkers', 'radarFilled'] },
  { id: 'treemap', get label() { return t('chartSubtypes.treemap'); }, icon: 'chartTreemap', subtypes: ['treemap'] },
  { id: 'sunburst', get label() { return t('chartSubtypes.sunburst'); }, icon: 'chartSunburst', subtypes: ['sunburst'] },
  { id: 'histogram', get label() { return t('chartSubtypes.histogram'); }, icon: 'chartHistogram', subtypes: ['histogram'] },
  { id: 'boxWhisker', get label() { return t('chartSubtypes.boxAndWhiskerFamily'); }, icon: 'chartBoxWhisker', subtypes: ['boxWhisker'] },
  { id: 'waterfall', get label() { return t('chartSubtypes.waterfall'); }, icon: 'chartWaterfall', subtypes: ['waterfall'] },
  { id: 'funnel', get label() { return t('chartSubtypes.funnel'); }, icon: 'chartFunnel', subtypes: ['funnel'] },
  { id: 'combo', get label() { return t('chartSubtypes.combo'); }, icon: 'chartCombo', subtypes: ['comboColumnLine', 'comboColumnLineSecondary'] },
]);

export const CHART_SUBTYPES = Object.freeze(CHART_GALLERIES.flatMap(g => g.groups.flatMap(group => group.items))
  .map(s => Object.freeze(s)));
export const chartSubtype = id => CHART_SUBTYPES.find(s => s.id === id) || null;
/** The subtype Alt+F1 and the Recommended Charts default insert: the default chart. */
export const DEFAULT_SUBTYPE = 'columnClustered';

const textStyle = (font, size, color = CHART_TEXT_GREY) => ({ font, size, color });

/** The line every series of a line or scatter subtype starts with (series without their own `lines` entry). */
function lineTemplate(subtype) {
  if (subtype.type === 'scatter') {
    return { width: pt(1.5) * (subtype.lines === 'none' ? 1 : 1.5), visible: subtype.lines !== 'none', smooth: subtype.lines === 'smooth',
      marker: subtype.markers !== false, markerSymbol: 'circle', markerSize: 5 };
  }
  if (subtype.type === 'radar') return { width: pt(2.25), marker: !!subtype.markers, markerSymbol: 'circle', markerSize: 5 };
  return { width: pt(2.25), marker: !!subtype.markers, markerSymbol: 'circle', markerSize: 5 };
}

/** Bar geometry for each grouping: clustered bars 219% apart overlapping -27%, stacks 150% and 100%. */
export const barSpacing = stacked => (stacked ? { gapWidth: 150, overlap: 100 } : { gapWidth: 219, overlap: -27 });

/**
 * The appearance of a new chart of `subtype` in the default style. `font` is the theme's body font
 * key (Calibri in the default theme).
 */
export function excelChartAppearance(subtype, { font = 'calibri' } = {}) {
  const s = typeof subtype === 'string' ? chartSubtype(subtype) : subtype;
  const label = textStyle(font, pt(9));
  const appearance = {
    background: '#ffffff', border: true, borderColor: CHART_LINE_GREY, roundedCorners: false, excelLayout: true,
    textStyle: textStyle(font, pt(10)), titleStyle: textStyle(font, pt(14)), legendStyle: label,
    xStyle: label, yStyle: label, y2Style: label,
    legendPos: 'bottom',
    gridlineStyles: { y: { color: CHART_LINE_GREY, width: 1 } },
    axisStyles: { x: { color: CHART_LINE_GREY, width: 1, majorTick: 'none', minorTick: 'none' },
      y: { color: 'none', majorTick: 'none', minorTick: 'none' },
      ...(s.secondaryAxis ? { y2: { color: 'none', majorTick: 'none', minorTick: 'none' } } : {}) },
    lines: [], lineDefault: lineTemplate(s),
    blanks: 'gap',
  };
  if (['column', 'bar', 'combo'].includes(s.type)) Object.assign(appearance, barSpacing(!!s.stacked));
  if (s.type === 'scatter' || s.type === 'bubble') {
    appearance.categoryBetween = false;
    appearance.axisStyles.x = { color: CHART_LINE_GREY, width: 1, majorTick: 'none', minorTick: 'none' };
  }
  if (s.type === 'line' || s.type === 'area') appearance.categoryBetween = s.type === 'line';
  if (s.type === 'pie' || s.type === 'donut') {
    appearance.pie = { holeSize: 75, firstSliceAngle: 0, varyColors: true, stroke: '#ffffff', strokeWidth: 1, points: [],
      labels: { style: textStyle(font, pt(9), '#404040'), value: false, category: false, percent: false, series: false, hidden: false,
        leaderLines: true, position: 'bestFit', separator: ', ', numberFormat: '', points: [] } };
  }
  if (s.type === 'bubble') appearance.bubble = { scale: 100, sizeRepresents: 'area', showNegative: false, xGrid: false, series: [] };
  if (s.type === 'radar') appearance.radar = { style: s.filled ? 'filled' : s.markers ? 'marker' : 'standard', blanks: 'gap', series: [] };
  // A funnel's bars nearly touch; the hierarchy charts and surfaces have no value gridlines of their own to draw.
  if (s.type === 'funnel') Object.assign(appearance, { gapWidth: 6, gridlineStyles: {} });
  if (s.type === 'treemap' || s.type === 'sunburst') appearance.gridlineStyles = {};
  return appearance;
}

/** The chart fields a subtype sets, over whatever else the chart keeps (its data, title and formatting). */
export function subtypeFields(subtype) {
  const s = typeof subtype === 'string' ? chartSubtype(subtype) : subtype;
  // The variant options are reset with every change of subtype: null drops what the old one set.
  return { type: s.type, stacked: !!s.stacked, stack100: !!s.stack100, secondaryAxis: !!s.secondaryAxis,
    smooth: s.type === 'scatter' ? s.lines === 'smooth' : false,
    explosion: s.explosion || null,
    ofPie: s.ofPie ? { kind: s.ofPie, split: 3, secondSize: 75, gap: 100 } : null,
    stock: s.stock || null, surfaceView: s.surfaceView || null };
}

/** The default title: the series' name when one series is charted, else the placeholder "Chart title". A pie
 * charts only its first series; a doughnut charts every series, a ring each. */
export function defaultChartTitle(data, type) {
  const series = data?.series || [];
  if (['pie', 'histogram', 'waterfall', 'treemap', 'sunburst', 'funnel'].includes(type) || series.length === 1) {
    const name = series[0]?.name;
    if (name && !/^Series ?\d+$/.test(name)) return name;
  }
  return 'Chart title';
}

/**
 * A chart of `subtype` over `range`, as Insert ▸ Charts makes one: the default look and size
 * (5 × 3 inches, 480 × 288 pixels), its title, and placed beside the data, its top-left corner by the
 * selection's top-right one (below the data when the sheet has no room to its right).
 */
export function newExcelChart(wb, sheetId, range, subtypeId = DEFAULT_SUBTYPE, { font = 'calibri' } = {}) {
  const subtype = chartSubtype(subtypeId) || chartSubtype(DEFAULT_SUBTYPE);
  // Several ranges selected together chart the box around them, less the lines between them (see chartAreas).
  const areas = Array.isArray(range) ? chartAreas(range) : null;
  const r = areas ? areas.box : normalizeRange(range);
  const sheet = wb.sheet(sheetId);
  const base = defaultChart(r, { r: r.r1, c: r.c2 + 1 });
  const chart = { ...base, ...subtypeFields(subtype), w: 480, h: 288, dx: 0, dy: 0, legendPos: 'bottom',
    appearance: excelChartAppearance(subtype, { font }) };
  if (sheet && r.c2 + 1 + 4 > sheet.cols) chart.anchor = { r: r.r2 + 2, c: r.c1 };
  if (areas?.lines && sheet) Object.assign(chart, areaSources(wb, sheetId, sheet, chart, areas));
  const data = chartData(wb, sheetId, chart);
  chart.title = defaultChartTitle(data, chart.type);
  // A pie names its slices in the legend; a single series needs no legend of its name beside its title.
  chart.legend = ['pie', 'donut'].includes(chart.type) || data.series.length > 1;
  if (chart.type === 'histogram' || chart.type === 'waterfall') chart.legend = chart.type === 'waterfall';
  // A hierarchy's legend names its top-level branches; its leaves carry their own names.
  if (chart.type === 'treemap' || chart.type === 'sunburst') {
    const branches = new Set((data.levels || []).map(path => path[0]).filter(Boolean));
    chart.legend = (data.levels || []).some(path => path.length > 1) && branches.size <= 12;
    chart.labels = true;
    if (chart.type === 'treemap') chart.legendPos = 'top';
  }
  if (chart.type === 'funnel') Object.assign(chart, { legend: false, labels: true });
  // A stock chart's legend names its price columns; a surface's, its value bands, beside the plot.
  if (chart.type === 'stock') chart.legend = true;
  if (chart.type === 'surface') Object.assign(chart, { legend: true, legendPos: 'right' });
  if (chart.type === 'boxWhisker') chart.legend = data.series.length > 1;
  if (chart.legendPos !== 'bottom' && chart.appearance) chart.appearance = { ...chart.appearance, legendPos: chart.legendPos };
  return chart;
}

/**
 * Ranges selected together (Ctrl-click) that a chart reads as one table, as Excel charts them: ranges over the
 * same rows set their columns side by side, ranges over the same columns their rows one under another.
 * Returns the box around them and the columns (rows) selected in it, `lines` null for a single range; null
 * when the ranges do not line up so.
 */
export function chartAreas(ranges) {
  const areas = ranges.map(normalizeRange);
  if (!areas.length) return null;
  if (areas.length === 1) return { box: areas[0], lines: null, across: true };
  const across = areas.every(a => a.r1 === areas[0].r1 && a.r2 === areas[0].r2);
  if (!across && !areas.every(a => a.c1 === areas[0].c1 && a.c2 === areas[0].c2)) return null;
  const lines = new Set();
  for (const a of areas) for (let i = across ? a.c1 : a.r1; i <= (across ? a.c2 : a.r2); i++) lines.add(i);
  const box = { r1: Math.min(...areas.map(a => a.r1)), c1: Math.min(...areas.map(a => a.c1)), r2: Math.max(...areas.map(a => a.r2)), c2: Math.max(...areas.map(a => a.c2)) };
  return { box, lines, across };
}

const refOf = (sheetName, r1, c1, r2 = r1, c2 = c1) => `${quoteSheet(sheetName)}!$${colName(c1)}$${r1 + 1}${r1 === r2 && c1 === c2 ? '' : `:$${colName(c2)}$${r2 + 1}`}`;

/**
 * The series of the box around ranges selected together, read with a series down each column (across each row
 * of ranges one under another) and kept where their line is selected, each with references of its own; the
 * labels likewise, when their line is selected.
 */
function areaSources(wb, sheetId, sheet, chart, { lines, across }) {
  const seriesIn = across ? 'cols' : 'rows';
  const data = chartData(wb, sheetId, { ...chart, seriesIn }), layout = data.sourceLayout;
  if (!layout) return { seriesIn };
  const at = (line, point) => (across ? [point, line] : [line, point]);
  const span = line => (line == null || !lines.has(line) || !layout.points.length ? ''
    : refOf(sheet.name, ...at(line, layout.points[0]), ...at(line, layout.points.at(-1))));
  const xy = chart.type === 'scatter' || chart.type === 'bubble';
  const categories = xy ? span(layout.xLine) : span(layout.categoryLine);
  const sourceRefs = data.series.flatMap((s, i) => {
    const line = layout.lines[i];
    if (!lines.has(line)) return [];
    const nameRef = layout.nameLine != null ? refOf(sheet.name, ...at(line, layout.nameLine)) : '';
    return [{ name: s.name, nameRef, categories, values: span(line), ...(chart.type === 'bubble' ? { sizes: span(layout.sizeLine) } : {}) }];
  });
  return sourceRefs.length ? { seriesIn, sourceRefs } : { seriesIn };
}

/** Which subtype a chart is, for the galleries' and Change Chart Type's checked tile. */
export function subtypeOf(chart) {
  if (!chart) return null;
  const a = chart.appearance, line = a?.lines?.[0] || a?.lineDefault;
  switch (chart.type) {
    case 'column': case 'bar': case 'area':
      return `${chart.type}${chart.type === 'area' ? '' : chart.stacked ? '' : 'Clustered'}${chart.stack100 ? 'Stacked100' : chart.stacked ? 'Stacked' : ''}`;
    case 'line': {
      const markers = line ? line.marker !== false : true;
      return `line${chart.stack100 ? 'Stacked100' : chart.stacked ? 'Stacked' : ''}${markers ? 'Markers' : ''}`;
    }
    case 'pie': return chart.ofPie ? (chart.ofPie.kind === 'bar' ? 'barOfPie' : 'pieOfPie') : chart.explosion ? 'pieExploded' : 'pie';
    case 'donut': return chart.explosion ? 'doughnutExploded' : 'doughnut';
    case 'stock': return { ohlc: 'stockOhlc', vhlc: 'stockVhlc', vohlc: 'stockVohlc' }[chart.stock] || 'stockHlc';
    case 'surface': return { wireframe3d: 'surfaceWireframe3d', contour: 'contour', wireframeContour: 'contourWireframe' }[chart.surfaceView] || 'surface3d';
    case 'scatter': {
      const visible = line ? line.visible !== false : false, markers = line ? line.marker !== false : true;
      const smooth = line?.smooth ?? chart.smooth;
      if (!visible) return 'scatter';
      return `scatter${smooth ? 'Smooth' : 'Lines'}${markers ? 'Markers' : ''}`;
    }
    case 'bubble': return 'bubble';
    case 'radar': return a?.radar?.style === 'filled' ? 'radarFilled' : a?.radar?.style === 'marker' ? 'radarMarkers' : 'radar';
    case 'combo': return chart.secondaryAxis ? 'comboColumnLineSecondary' : 'comboColumnLine';
    default: return chart.type;
  }
}

/**
 * Change Chart Type: the patch that turns `chart` into `subtypeId`, keeping its data, title and the
 * formatting both types share. A chart drawn in the default style keeps that style for the new type.
 */
export function changeSubtypePatch(chart, subtypeId, { font = 'calibri' } = {}) {
  const subtype = chartSubtype(subtypeId);
  if (!subtype) return null;
  const patch = subtypeFields(subtype);
  if (!chart.appearance) return patch;
  const fresh = excelChartAppearance(subtype, { font: chart.appearance.titleStyle?.font || font });
  const old = chart.appearance;
  const keep = ['background', 'border', 'borderColor', 'borderWidth', 'roundedCorners', 'textStyle', 'titleStyle', 'legendStyle', 'xStyle', 'yStyle', 'y2Style',
    'plotFill', 'plotStroke', 'titleBox', 'legendBox', 'shadow', 'dataTable', 'blanks', 'xGridlines', 'hideXAxis', 'hideYAxis', 'yFormat', 'yStep', 'yUnits', 'yLogBase', 'yTickValues',
    'reverseValues', 'valueLabels', 'gridlineStyles'];
  const appearance = { ...fresh, ...Object.fromEntries(keep.filter(k => old[k] !== undefined).map(k => [k, old[k]])) };
  // The axis lines are the new type's own: a bar chart's categories run down the left, a scatter's values along the bottom.
  if (!['pie', 'donut'].includes(subtype.type) && old.axisStyles) {
    appearance.axisStyles = { ...fresh.axisStyles };
    // An axis boxing the plot (Format Axis' Box around plot area) keeps its box, in the line it draws it in.
    for (const [k, st] of Object.entries(old.axisStyles)) if (st?.box && fresh.axisStyles?.[k]) {
      appearance.axisStyles[k] = { ...fresh.axisStyles[k], box: true, color: st.color, width: st.width, dash: st.dash };
    }
  }
  // Bars switching between clustered and stacked take that grouping's spacing; between types they keep theirs.
  if (['column', 'bar', 'combo'].includes(subtype.type) && ['column', 'bar', 'combo'].includes(chart.type) && !!chart.stacked === !!subtype.stacked) {
    for (const k of ['gapWidth', 'overlap']) if (old[k] != null) appearance[k] = old[k];
  }
  if (old.pointColors && ['pie', 'donut'].includes(subtype.type) === ['pie', 'donut'].includes(chart.type)) appearance.pointColors = old.pointColors;
  if (['pie', 'donut'].includes(subtype.type) && old.pie) appearance.pie = { ...old.pie, holeSize: fresh.pie.holeSize };
  patch.appearance = appearance;
  return patch;
}
