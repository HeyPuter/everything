/**
 * The chart workflow: the Insert ▸ Charts galleries (each button a drop-down of subtypes), the
 * default look a new chart takes (theme series colours, a 14pt dark grey
 * title, 9pt grey axis labels, light grey major gridlines, the legend at the bottom, a white chart area
 * with a light grey border), and the subtype a chart is, so Change Chart Type can show it and swap it.
 *
 * The look is an `appearance` (see charts.js): the same model imported charts carry, so new
 * charts draw through the native-style renderer and write the same DrawingML Excel reads back.
 */
import { normalizeRange } from './cell.js';
import { chartData, defaultChart } from './charts.js';

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
  { id: 'column', label: 'Column', icon: 'chartColumn', more: 'More column chart types…', groups: [
    { header: 'Column', items: [
      { id: 'columnClustered', label: 'Clustered Column', type: 'column', icon: 'chartColumnClustered' },
      { id: 'columnStacked', label: 'Stacked Column', type: 'column', stacked: true, icon: 'chartColumnStacked' },
      { id: 'columnStacked100', label: '100% Stacked Column', type: 'column', stacked: true, stack100: true, icon: 'chartColumnStacked100' }] }] },
  { id: 'line', label: 'Line', icon: 'chartLine', more: 'More line chart types…', groups: [
    { header: 'Line', items: [
      { id: 'line', label: 'Line', type: 'line', markers: false, icon: 'chartLinePlain' },
      { id: 'lineStacked', label: 'Stacked Line', type: 'line', stacked: true, markers: false, icon: 'chartLineStacked' },
      { id: 'lineStacked100', label: '100% Stacked Line', type: 'line', stacked: true, stack100: true, markers: false, icon: 'chartLineStacked100' },
      { id: 'lineMarkers', label: 'Line with Markers', type: 'line', markers: true, icon: 'chartLineMarkers' },
      { id: 'lineStackedMarkers', label: 'Stacked Line with Markers', type: 'line', stacked: true, markers: true, icon: 'chartLineStackedMarkers' },
      { id: 'lineStacked100Markers', label: '100% Stacked Line with Markers', type: 'line', stacked: true, stack100: true, markers: true, icon: 'chartLineStacked100Markers' }] }] },
  { id: 'pie', label: 'Pie', icon: 'chartPie', more: 'More pie chart types…', groups: [
    { header: 'Pie', items: [
      { id: 'pie', label: 'Pie', type: 'pie', icon: 'chartPie' },
      { id: 'pieExploded', label: 'Exploded Pie', type: 'pie', explosion: 15, icon: 'chartPieExploded' },
      { id: 'pieOfPie', label: 'Pie of Pie', type: 'pie', ofPie: 'pie', icon: 'chartPieOfPie' },
      { id: 'barOfPie', label: 'Bar of Pie', type: 'pie', ofPie: 'bar', icon: 'chartBarOfPie' }] },
    { header: 'Doughnut', items: [
      { id: 'doughnut', label: 'Doughnut', type: 'donut', icon: 'chartDoughnut' },
      { id: 'doughnutExploded', label: 'Exploded Doughnut', type: 'donut', explosion: 15, icon: 'chartDoughnutExploded' }] }] },
  { id: 'bar', label: 'Bar', icon: 'chartBar', more: 'More bar chart types…', groups: [
    { header: 'Bar', items: [
      { id: 'barClustered', label: 'Clustered Bar', type: 'bar', icon: 'chartBarClustered' },
      { id: 'barStacked', label: 'Stacked Bar', type: 'bar', stacked: true, icon: 'chartBarStacked' },
      { id: 'barStacked100', label: '100% Stacked Bar', type: 'bar', stacked: true, stack100: true, icon: 'chartBarStacked100' }] }] },
  { id: 'area', label: 'Area', icon: 'chartArea', more: 'More area chart types…', groups: [
    { header: 'Area', items: [
      { id: 'area', label: 'Area', type: 'area', icon: 'chartArea' },
      { id: 'areaStacked', label: 'Stacked Area', type: 'area', stacked: true, icon: 'chartAreaStacked' },
      { id: 'areaStacked100', label: '100% Stacked Area', type: 'area', stacked: true, stack100: true, icon: 'chartAreaStacked100' }] }] },
  { id: 'scatter', label: 'Scatter', icon: 'chartScatter', more: 'More scatter chart types…', groups: [
    { header: 'Scatter', items: [
      { id: 'scatter', label: 'Scatter', type: 'scatter', markers: true, lines: 'none', icon: 'chartScatter' },
      { id: 'scatterSmoothMarkers', label: 'Scatter, smooth lines and markers', type: 'scatter', markers: true, lines: 'smooth', icon: 'chartScatterSmoothMarkers' },
      { id: 'scatterSmooth', label: 'Scatter, smooth lines', type: 'scatter', markers: false, lines: 'smooth', icon: 'chartScatterSmooth' },
      { id: 'scatterLinesMarkers', label: 'Scatter, straight lines and markers', type: 'scatter', markers: true, lines: 'straight', icon: 'chartScatterLinesMarkers' },
      { id: 'scatterLines', label: 'Scatter, straight lines', type: 'scatter', markers: false, lines: 'straight', icon: 'chartScatterLines' }] },
    { header: 'Bubble', items: [{ id: 'bubble', label: 'Bubble', type: 'bubble', icon: 'chartBubble' }] }] },
  { id: 'hierarchy', label: 'Hierarchy', icon: 'chartTreemap', more: 'More hierarchy charts…', groups: [
    { header: 'Treemap', items: [{ id: 'treemap', label: 'Treemap', type: 'treemap', icon: 'chartTreemap' }] },
    { header: 'Sunburst', items: [{ id: 'sunburst', label: 'Sunburst', type: 'sunburst', icon: 'chartSunburst' }] }] },
  { id: 'statistic', label: 'Statistic', icon: 'chartBoxWhisker', more: 'More statistical charts…', groups: [
    { header: 'Histogram', items: [{ id: 'histogram', label: 'Histogram', type: 'histogram', icon: 'chartHistogram' }] },
    { header: 'Box and Whisker', items: [{ id: 'boxWhisker', label: 'Box and Whisker', type: 'boxWhisker', icon: 'chartBoxWhisker' }] }] },
  { id: 'other', label: 'Other Charts', icon: 'chartStockOhlc', more: 'More chart types…', groups: [
    { header: 'Waterfall and Funnel', items: [
      { id: 'waterfall', label: 'Waterfall', type: 'waterfall', icon: 'chartWaterfall' },
      { id: 'funnel', label: 'Funnel', type: 'funnel', icon: 'chartFunnel' }] },
    { header: 'Stock', items: [
      { id: 'stockHlc', label: 'High-Low-Close', type: 'stock', stock: 'hlc', icon: 'chartStockHlc' },
      { id: 'stockOhlc', label: 'Open-High-Low-Close', type: 'stock', stock: 'ohlc', icon: 'chartStockOhlc' },
      { id: 'stockVhlc', label: 'Volume-High-Low-Close', type: 'stock', stock: 'vhlc', icon: 'chartStockVhlc' },
      { id: 'stockVohlc', label: 'Volume-Open-High-Low-Close', type: 'stock', stock: 'vohlc', icon: 'chartStockVohlc' }] },
    { header: 'Surface', items: [
      { id: 'surface3d', label: '3-D Surface', type: 'surface', surfaceView: 'surface3d', icon: 'chartSurface' },
      { id: 'surfaceWireframe3d', label: 'Wireframe 3-D Surface', type: 'surface', surfaceView: 'wireframe3d', icon: 'chartSurfaceWireframe' },
      { id: 'contour', label: 'Contour', type: 'surface', surfaceView: 'contour', icon: 'chartContour' },
      { id: 'contourWireframe', label: 'Wireframe Contour', type: 'surface', surfaceView: 'wireframeContour', icon: 'chartContourWireframe' }] },
    { header: 'Radar', items: [
      { id: 'radar', label: 'Radar', type: 'radar', markers: false, icon: 'chartRadar' },
      { id: 'radarMarkers', label: 'Radar with Markers', type: 'radar', markers: true, icon: 'chartRadarMarkers' },
      { id: 'radarFilled', label: 'Filled Radar', type: 'radar', filled: true, icon: 'chartRadarFilled' }] }] },
  { id: 'combo', label: 'Combo', icon: 'chartCombo', more: 'More combo charts…', groups: [
    { header: 'Combo', items: [
      { id: 'comboColumnLine', label: 'Column and line', type: 'combo', icon: 'chartCombo' },
      { id: 'comboColumnLineSecondary', label: 'Column and line, line on a second axis', type: 'combo', secondaryAxis: true, icon: 'chartComboSecondary' }] }] },
]);

/** The All Charts list of Insert Chart and Change Chart Type: the chart families. */
export const CHART_FAMILIES = Object.freeze([
  { id: 'column', label: 'Column', icon: 'chartColumn', subtypes: ['columnClustered', 'columnStacked', 'columnStacked100'] },
  { id: 'line', label: 'Line', icon: 'chartLine', subtypes: ['line', 'lineStacked', 'lineStacked100', 'lineMarkers', 'lineStackedMarkers', 'lineStacked100Markers'] },
  { id: 'pie', label: 'Pie', icon: 'chartPie', subtypes: ['pie', 'pieExploded', 'pieOfPie', 'barOfPie', 'doughnut', 'doughnutExploded'] },
  { id: 'bar', label: 'Bar', icon: 'chartBar', subtypes: ['barClustered', 'barStacked', 'barStacked100'] },
  { id: 'area', label: 'Area', icon: 'chartArea', subtypes: ['area', 'areaStacked', 'areaStacked100'] },
  { id: 'scatter', label: 'Scatter', icon: 'chartScatter', subtypes: ['scatter', 'scatterSmoothMarkers', 'scatterSmooth', 'scatterLinesMarkers', 'scatterLines', 'bubble'] },
  { id: 'stock', label: 'Stock', icon: 'chartStockOhlc', subtypes: ['stockHlc', 'stockOhlc', 'stockVhlc', 'stockVohlc'] },
  { id: 'surface', label: 'Surface', icon: 'chartSurface', subtypes: ['surface3d', 'surfaceWireframe3d', 'contour', 'contourWireframe'] },
  { id: 'radar', label: 'Radar', icon: 'chartRadar', subtypes: ['radar', 'radarMarkers', 'radarFilled'] },
  { id: 'treemap', label: 'Treemap', icon: 'chartTreemap', subtypes: ['treemap'] },
  { id: 'sunburst', label: 'Sunburst', icon: 'chartSunburst', subtypes: ['sunburst'] },
  { id: 'histogram', label: 'Histogram', icon: 'chartHistogram', subtypes: ['histogram'] },
  { id: 'boxWhisker', label: 'Box & Whisker', icon: 'chartBoxWhisker', subtypes: ['boxWhisker'] },
  { id: 'waterfall', label: 'Waterfall', icon: 'chartWaterfall', subtypes: ['waterfall'] },
  { id: 'funnel', label: 'Funnel', icon: 'chartFunnel', subtypes: ['funnel'] },
  { id: 'combo', label: 'Combo', icon: 'chartCombo', subtypes: ['comboColumnLine', 'comboColumnLineSecondary'] },
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

/** The default title: the series' name when one series is charted, else the placeholder "Chart title". */
export function defaultChartTitle(data, type) {
  const series = data?.series || [];
  if (['pie', 'donut', 'histogram', 'waterfall', 'treemap', 'sunburst', 'funnel'].includes(type) || series.length === 1) {
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
  const r = normalizeRange(range);
  const sheet = wb.sheet(sheetId);
  const base = defaultChart(r, { r: r.r1, c: r.c2 + 1 });
  const chart = { ...base, ...subtypeFields(subtype), w: 480, h: 288, dx: 0, dy: 0, legendPos: 'bottom',
    appearance: excelChartAppearance(subtype, { font }) };
  if (sheet && r.c2 + 1 + 4 > sheet.cols) chart.anchor = { r: r.r2 + 2, c: r.c1 };
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
    'plotFill', 'plotStroke', 'titleBox', 'legendBox', 'shadow', 'dataTable', 'blanks', 'xGridlines', 'hideXAxis', 'hideYAxis', 'yFormat', 'yStep', 'yUnits', 'valueLabels', 'gridlineStyles'];
  const appearance = { ...fresh, ...Object.fromEntries(keep.filter(k => old[k] !== undefined).map(k => [k, old[k]])) };
  // The axis lines are the new type's own: a bar chart's categories run down the left, a scatter's values along the bottom.
  if (!['pie', 'donut'].includes(subtype.type) && old.axisStyles) appearance.axisStyles = { ...fresh.axisStyles };
  // Bars switching between clustered and stacked take that grouping's spacing; between types they keep theirs.
  if (['column', 'bar', 'combo'].includes(subtype.type) && ['column', 'bar', 'combo'].includes(chart.type) && !!chart.stacked === !!subtype.stacked) {
    for (const k of ['gapWidth', 'overlap']) if (old[k] != null) appearance[k] = old[k];
  }
  if (old.pointColors && ['pie', 'donut'].includes(subtype.type) === ['pie', 'donut'].includes(chart.type)) appearance.pointColors = old.pointColors;
  if (['pie', 'donut'].includes(subtype.type) && old.pie) appearance.pie = { ...old.pie, holeSize: fresh.pie.holeSize };
  patch.appearance = appearance;
  return patch;
}
