/**
 * The newer chart types in an .xlsx file: treemap, sunburst, box and whisker and funnel charts are
 * stored as extended chart parts (cx:chartSpace, application/vnd.ms-office.chartex+xml) beside a
 * chart style and colour style, and placed in the drawing inside mc:AlternateContent, whose fallback
 * readers without the extended charts show instead. Each part keeps its worksheet references live
 * and caches the values they held.
 */
import { colName } from './cell.js';
import { chartData } from './charts.js';
import { quoteSheet } from './refs.js';
import { fontName, styleToNumFmt } from './format.js';
import { xmlTag as tag, xmlText } from './xlsx-export-styles.js';
import { seriesColor } from '../ui/chartsvg.js';

export const CHARTEX_TYPES = new Set(['treemap', 'sunburst', 'boxWhisker', 'funnel']);
export const CHARTEX_NS = 'http://schemas.microsoft.com/office/drawing/2014/chartex';
export const CHARTEX_REL = 'http://schemas.microsoft.com/office/2014/relationships/chartEx';
export const CHARTEX_CONTENT_TYPE = 'application/vnd.ms-office.chartex+xml';
export const CHART_STYLE_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartStyle';
export const CHART_COLORS_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CS = 'http://schemas.microsoft.com/office/drawing/2012/chartStyle';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
// The capability each layout needs of a reader: the 2016 layouts, and the funnel added after them.
const REQUIRES = { treemap: ['cx1', 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex'], sunburst: ['cx1', 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex'],
  boxWhisker: ['cx1', 'http://schemas.microsoft.com/office/drawing/2015/9/8/chartex'], funnel: ['cx2', 'http://schemas.microsoft.com/office/drawing/2015/10/21/chartex'] };

const paint = color => (/^#[\da-f]{6}/i.test(color || '') ? tag('a:solidFill', {}, tag('a:srgbClr', { val: color.slice(1, 7).toUpperCase() })) : tag('a:noFill'));
const absolute = (sheetName, r1, c1, r2, c2) => `${quoteSheet(sheetName)}!$${colName(c1)}$${r1 + 1}${r1 === r2 && c1 === c2 ? '' : `:$${colName(c2)}$${r2 + 1}`}`;
const runStyle = (s = {}) => tag('a:defRPr', { sz: Math.round((s.size || 12) * 75), b: Number(!!s.bold), i: Number(!!s.italic) },
  (/^#[\da-f]{6}$/i.test(s.color || '') ? paint(s.color) : '') + tag('a:latin', { typeface: fontName(s.font) || 'Calibri' }));
const textProps = s => tag('cx:txPr', {}, tag('a:bodyPr', { spcFirstLastPara: 1, vertOverflow: 'ellipsis', wrap: 'square', lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 'ctr', anchorCtr: 1 })
  + tag('a:lstStyle') + tag('a:p', {}, tag('a:pPr', { algn: 'ctr', rtl: 0 }, runStyle(s)) + tag('a:endParaRPr', { lang: 'en-US' })));

/** The cells of a reference as rows of { v, text }, or null for a reference that names no range. */
function readCells(wb, sheetId, ref) {
  const resolved = ref && wb.rangeFromText(sheetId, ref);
  if (!resolved) return null;
  const { range } = resolved, rows = [];
  for (let r = range.r1; r <= Math.min(range.r2, range.r1 + 4999); r++) {
    const row = [];
    for (let c = range.c1; c <= Math.min(range.c2, range.c1 + 63); c++) {
      const v = wb.getValue(resolved.sheetId, r, c);
      row.push({ v, text: v == null ? '' : wb.getDisplay(resolved.sheetId, r, c, v), style: wb.styleAt(resolved.sheetId, r, c) });
    }
    rows.push(row);
  }
  return { rows, vertical: range.r2 - range.r1 >= range.c2 - range.c1 };
}

/**
 * The references a chart's series read: its imported ones, or those of the cells its range lays out:
 * { name, nameRef, categories, values, levels } per series, `levels` the label columns of a hierarchy.
 */
export function chartExSources(wb, sheet, ch, data = chartData(wb, sheet.id, ch)) {
  if (ch.sourceRefs?.length) return ch.sourceRefs.map(s => ({ ...s }));
  const layout = data.sourceLayout;
  if (!layout?.points.length) return [];
  const rows = layout.orientation === 'rows', first = layout.points[0], last = layout.points.at(-1);
  const span = (from, to = from) => (rows ? absolute(sheet.name, from, first, to, last) : absolute(sheet.name, first, from, last, to));
  const levels = layout.levelLines;
  const categories = levels?.length ? span(levels[0], levels.at(-1)) : layout.categoryLine != null ? span(layout.categoryLine) : '';
  return data.series.map((s, i) => ({ name: s.name, categories,
    nameRef: layout.nameLine != null && layout.lines[i] != null ? (rows ? absolute(sheet.name, layout.lines[i], layout.nameLine, layout.lines[i], layout.nameLine) : absolute(sheet.name, layout.nameLine, layout.lines[i], layout.nameLine, layout.lines[i])) : '',
    values: layout.lines[i] != null ? span(layout.lines[i]) : '' }));
}

/** A string dimension: its formula and one cached level per label column, the innermost first. */
function stringDimension(wb, sheetId, ref, fallback) {
  const cells = readCells(wb, sheetId, ref);
  let levels;
  if (cells) {
    const count = cells.vertical ? cells.rows[0]?.length || 0 : cells.rows.length;
    const length = cells.vertical ? cells.rows.length : cells.rows[0]?.length || 0;
    levels = Array.from({ length: count }, (_, k) => Array.from({ length }, (_, i) => (cells.vertical ? cells.rows[i][k] : cells.rows[k][i]).text)).reverse();
  } else levels = [fallback];
  const lvl = values => tag('cx:lvl', { ptCount: values.length }, values.map((v, i) => (v === '' || v == null ? '' : tag('cx:pt', { idx: i }, xmlText(v)))).join(''));
  return tag('cx:strDim', { type: 'cat' }, (ref ? tag('cx:f', { dir: cells && !cells.vertical ? 'row' : null }, xmlText(ref)) : '') + levels.map(lvl).join(''));
}

function numberDimension(wb, sheetId, ref, type, fallback, format) {
  const cells = readCells(wb, sheetId, ref);
  const values = cells ? (cells.vertical ? cells.rows.map(row => row[0]?.v) : (cells.rows[0] || []).map(cell => cell.v)) : fallback;
  return tag('cx:numDim', { type }, (ref ? tag('cx:f', { dir: cells && !cells.vertical ? 'row' : null }, xmlText(ref)) : '')
    + tag('cx:lvl', { ptCount: values.length, formatCode: format || 'General' },
      values.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? tag('cx:pt', { idx: i }, xmlText(v)) : '')).join('')));
}

/** The cx:chartSpace of a treemap, sunburst, box and whisker or funnel chart. */
export function chartExXml(X, wb, sheet, ch) {
  const data = chartData(wb, sheet.id, ch), sources = chartExSources(wb, sheet, ch, data);
  const ap = ch.appearance || {}, hierarchy = ch.type === 'treemap' || ch.type === 'sunburst';
  const used = hierarchy || ch.type === 'funnel' ? sources.slice(0, 1) : sources;
  let dataXml = '', seriesXml = '';
  used.forEach((source, j) => {
    const series = data.series[j] || { name: source.name, values: [] };
    const format = source.valueFormat || (series.style ? styleToNumFmt(series.style) : 'General');
    dataXml += tag('cx:data', { id: j }, stringDimension(wb, sheet.id, source.categories, data.categories)
      + numberDimension(wb, sheet.id, source.values, hierarchy ? 'size' : 'val', series.values, format));
    const name = tag('cx:tx', {}, tag('cx:txData', {}, (source.nameRef ? tag('cx:f', {}, xmlText(source.nameRef)) : '') + tag('cx:v', {}, xmlText(series.name || source.name || `Series${j + 1}`))));
    // Hierarchies colour each branch from the colour style; the other layouts carry their series colour.
    const fill = hierarchy ? '' : tag('cx:spPr', {}, paint(seriesColor(ch, j)));
    const visibility = { treemap: { seriesName: 0, categoryName: 1, value: 1 }, sunburst: { seriesName: 0, categoryName: 1, value: 0 },
      funnel: { seriesName: 0, categoryName: 0, value: 1 }, boxWhisker: { seriesName: 0, categoryName: 0, value: 1 } }[ch.type];
    const labelStyle = ap.valueLabels?.find(l => l?.style)?.style || ap.xStyle;
    const labels = ch.labels ? tag('cx:dataLabels', { pos: ch.type === 'boxWhisker' ? 'r' : ch.type === 'treemap' ? 'inEnd' : 'ctr' },
      (labelStyle ? textProps(labelStyle) : '') + tag('cx:visibility', visibility)) : '';
    const box = ch.box || {};
    const layoutPr = ch.type === 'treemap' ? tag('cx:layoutPr', {}, tag('cx:parentLabelLayout', { val: ch.treemapLabels || 'overlapping' }))
      : ch.type === 'boxWhisker' ? tag('cx:layoutPr', {}, tag('cx:visibility', { meanLine: Number(!!box.meanLine), meanMarker: Number(box.meanMarkers !== false),
        nonoutliers: Number(!!box.innerPoints), outliers: Number(box.outliers !== false) }) + tag('cx:statistics', { quartileMethod: box.quartiles === 'inclusive' ? 'inclusive' : 'exclusive' }))
        : '';
    seriesXml += tag('cx:series', { layoutId: ch.type, formatIdx: j }, name + fill + labels + tag('cx:dataId', { val: j }) + layoutPr);
  });
  const axisText = s => (s ? textProps(s) : '');
  const hide = flag => (flag ? 1 : null);
  let axes = '';
  if (ch.type === 'boxWhisker') {
    const scaling = { ...(ch.yMin != null ? { min: ch.yMin } : {}), ...(ch.yMax != null ? { max: ch.yMax } : {}), ...(ap.yStep ? { majorUnit: ap.yStep } : {}) };
    axes = tag('cx:axis', { id: 0, hidden: hide(ap.hideXAxis) }, tag('cx:catScaling', { gapWidth: (ch.box?.gapWidth ?? 100) / 100 }) + tag('cx:tickLabels') + axisText(ap.xStyle))
      + tag('cx:axis', { id: 1, hidden: hide(ap.hideYAxis) }, tag('cx:valScaling', scaling) + (ch.gridlines !== false ? tag('cx:majorGridlines') : '') + tag('cx:tickLabels')
        + (ap.yFormat ? tag('cx:numFmt', { formatCode: ap.yFormat, sourceLinked: 0 }) : '') + axisText(ap.yStyle));
  } else if (ch.type === 'funnel') {
    axes = tag('cx:axis', { id: 0, hidden: hide(ap.hideXAxis) }, tag('cx:catScaling', { gapWidth: (ap.gapWidth ?? 6) / 100 }) + tag('cx:tickLabels') + axisText(ap.xStyle));
  }
  const title = ch.title || ch.titleRef ? tag('cx:title', { pos: 't', align: 'ctr', overlay: 0 }, tag('cx:tx', {}, tag('cx:txData', {},
    (ch.titleRef ? tag('cx:f', {}, xmlText(ch.titleRef)) : '') + tag('cx:v', {}, xmlText(data.titles?.title ?? ch.title ?? ''))))
    + (ap.titleStyle ? textProps(ap.titleStyle) : '')) : '';
  const legend = ch.legend !== false ? tag('cx:legend', { pos: { top: 't', right: 'r', bottom: 'b' }[ch.legendPos] || 'b', align: 'ctr', overlay: 0 }, ap.legendStyle ? textProps(ap.legendStyle) : null) : '';
  const area = tag('cx:spPr', {}, paint(ap.background === 'none' ? null : ap.background || '#ffffff')
    + tag('a:ln', {}, paint(ap.border === false || ap.borderColor === 'none' ? null : ap.borderColor || '#d9d9d9')));
  return HEADER + tag('cx:chartSpace', { 'xmlns:a': A, 'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'xmlns:cx': CHARTEX_NS },
    tag('cx:chartData', {}, dataXml)
    + tag('cx:chart', {}, title + tag('cx:plotArea', {}, tag('cx:plotAreaRegion', {}, seriesXml) + axes) + legend)
    + area + (ap.textStyle ? textProps(ap.textStyle) : ''));
}

/** The drawing's frame for an extended chart: the chart for readers that know it, a note for those that do not. */
export function chartExFrame(ch, id, relId, nonVisual) {
  const [prefix, ns] = REQUIRES[ch.type] || REQUIRES.treemap;
  const frame = tag('xdr:graphicFrame', { macro: '' }, tag('xdr:nvGraphicFramePr', {}, nonVisual + tag('xdr:cNvGraphicFramePr'))
    + tag('xdr:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: 0, cy: 0 }))
    + tag('a:graphic', {}, tag('a:graphicData', { uri: CHARTEX_NS }, tag('cx:chart', { 'xmlns:cx': CHARTEX_NS, 'r:id': relId }))));
  const note = tag('xdr:sp', { macro: '', textlink: '' }, tag('xdr:nvSpPr', {}, tag('xdr:cNvPr', { id, name: ch.title || `Chart ${id}` }) + tag('xdr:cNvSpPr', {}, tag('a:spLocks', { noTextEdit: 1 })))
    + tag('xdr:spPr', {}, tag('a:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: 4572000, cy: 2743200 })) + tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'))
      + paint('#ffffff') + tag('a:ln', { w: 9525 }, paint('#d9d9d9')))
    + tag('xdr:txBody', {}, tag('a:bodyPr', { vertOverflow: 'clip', horzOverflow: 'clip' }) + tag('a:lstStyle')
      + tag('a:p', {}, tag('a:r', {}, tag('a:rPr', { lang: 'en-US', sz: 1100 }) + tag('a:t', {}, `This ${{ treemap: 'treemap', sunburst: 'sunburst', boxWhisker: 'box and whisker', funnel: 'funnel' }[ch.type] || ''} chart needs a newer spreadsheet app to be shown.`)))));
  return tag('mc:AlternateContent', { 'xmlns:mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006' },
    tag('mc:Choice', { [`xmlns:${prefix}`]: ns, Requires: prefix }, frame) + tag('mc:Fallback', {}, note));
}

const STYLE_ENTRIES = ['axisTitle', 'categoryAxis', 'chartArea', 'dataLabel', 'dataLabelCallout', 'dataPoint', 'dataPoint3D', 'dataPointLine', 'dataPointMarker',
  'dataPointMarkerLayout', 'dataPointWireframe', 'dataTable', 'downBar', 'dropLine', 'errorBar', 'floor', 'gridlineMajor', 'gridlineMinor', 'hiLoLine', 'leaderLine',
  'legend', 'plotArea', 'plotArea3D', 'seriesAxis', 'seriesLine', 'title', 'trendline', 'trendlineLabel', 'upBar', 'valueAxis', 'wall'];

/** The chart style an extended chart part refers to: plain entries, the part's own formatting decides its look. */
export function chartExStyleXml() {
  const entry = name => (name === 'dataPointMarkerLayout' ? tag('cs:dataPointMarkerLayout', { symbol: 'circle', size: 5 })
    : tag(`cs:${name}`, {}, tag('cs:lnRef', { idx: 0 }) + tag('cs:fillRef', { idx: name === 'dataPoint' ? 1 : 0 }, name === 'dataPoint' ? tag('cs:styleClr', { val: 'auto' }) : null)
      + tag('cs:effectRef', { idx: 0 }) + tag('cs:fontRef', { idx: 'minor' }, tag('a:schemeClr', { val: 'tx1' }))));
  return HEADER + tag('cs:chartStyle', { 'xmlns:cs': CS, 'xmlns:a': A, id: 410 }, STYLE_ENTRIES.map(entry).join(''));
}

/** Its colour style: the theme's six accents in turn, then lighter and darker laps of them. */
export function chartExColorsXml() {
  const accents = [1, 2, 3, 4, 5, 6].map(i => tag('a:schemeClr', { val: `accent${i}` })).join('');
  const lap = (mod, off) => tag('cs:variation', {}, tag('a:lumMod', { val: mod }) + (off ? tag('a:lumOff', { val: off }) : ''));
  return HEADER + tag('cs:colorStyle', { 'xmlns:cs': CS, 'xmlns:a': A, meth: 'cycle', id: 10 },
    accents + tag('cs:variation') + lap(60000) + lap(80000, 20000) + lap(80000) + lap(60000, 40000) + lap(50000));
}
