// Original DrawingML chart-part writer for newly inserted charts. It writes a
// self-contained c:chartSpace (ECMA-376 Part 1, 21.2) with literal cached data
// and no embedded workbook, declaring every visible property explicitly so the
// strict reader in docx-charts.js never depends on application style defaults.
import { parseXml } from './docx-xml.js';

export const CHART_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const CHART_TYPES = [
  { id: 'column-clustered', label: 'Clustered column', group: 'Column' },
  { id: 'column-stacked', label: 'Stacked column', group: 'Column' },
  { id: 'column-percent', label: '100% stacked column', group: 'Column' },
  { id: 'bar-clustered', label: 'Clustered bar', group: 'Bar' },
  { id: 'bar-stacked', label: 'Stacked bar', group: 'Bar' },
  { id: 'bar-percent', label: '100% stacked bar', group: 'Bar' },
  { id: 'line', label: 'Line', group: 'Line' },
  { id: 'line-markers', label: 'Line with markers', group: 'Line' },
  { id: 'area', label: 'Area', group: 'Area' },
  { id: 'area-stacked', label: 'Stacked area', group: 'Area' },
  { id: 'pie', label: 'Pie', group: 'Pie' },
  { id: 'doughnut', label: 'Doughnut', group: 'Pie' },
  { id: 'scatter', label: 'Scatter', group: 'Scatter' },
  { id: 'scatter-lines', label: 'Scatter with lines', group: 'Scatter' },
];
const BARS = { 'column-clustered': ['col', 'clustered'], 'column-stacked': ['col', 'stacked'], 'column-percent': ['col', 'percentStacked'], 'bar-clustered': ['bar', 'clustered'], 'bar-stacked': ['bar', 'stacked'], 'bar-percent': ['bar', 'percentStacked'] };
export const CHART_PALETTE = ['2F6DB5', 'E8833A', '3FA66B', 'C94C4C', '8A63B8', 'D4B23A'];
const FONT = 'Calibri', TEXT = '595959', TITLE = '404040', AXIS = 'BFBFBF', GRID = 'E0E0E0';
const CATEGORY_AXIS = 500100, VALUE_AXIS = 500200;
const round = type => type === 'pie' || type === 'doughnut';

const xmlText = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The reader limits cached labels to 200 characters.
const label = value => xmlText(String(value ?? '').slice(0, 200));
const hex = (value, fallback) => /^[0-9a-f]{6}$/i.test(value || '') ? value.toUpperCase() : fallback;
// Cached numbers must be finite and within the reader's +/-1e12 range; blank
// cells become zero because the reader requires complete caches.
function numeric(value) {
  const n = typeof value === 'string' && !value.trim() ? 0 : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return 0;
  return Math.max(-1e12, Math.min(1e12, n));
}
const v = (name, value) => `<c:${name} val="${value}"/>`;
const solid = color => `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
// Every drawn line declares width, cap, compound type and alignment (a:ln).
const line = (color, width = 9525) => color ? `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${solid(color)}<a:round/></a:ln>` : '<a:ln><a:noFill/></a:ln>';
const shapeProperties = (fill, outline) => `<c:spPr>${fill ? solid(fill) : '<a:noFill/>'}${outline}<a:effectLst/></c:spPr>`;
const runProperties = (tag, size, color, extra = '') => `<a:${tag} sz="${size}" b="0" i="0" u="none" strike="noStrike" kern="1200" baseline="0"${extra}>${solid(color)}<a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:${tag}>`;
const textProperties = (size, color) => `<c:txPr><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr>${runProperties('defRPr', size, color)}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const labelSwitches = '<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>';
const dataLabels = `<c:dLbls>${labelSwitches}</c:dLbls>`;
const strings = values => `<c:strLit><c:ptCount val="${values.length}"/>${values.map((t, i) => `<c:pt idx="${i}"><c:v>${label(t)}</c:v></c:pt>`).join('')}</c:strLit>`;
const numbers = values => `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((n, i) => `<c:pt idx="${i}"><c:v>${numeric(n)}</c:v></c:pt>`).join('')}</c:numLit>`;
const seriesStart = (s, i) => `${v('idx', i)}${v('order', i)}<c:tx><c:v>${label(s.name)}</c:v></c:tx>`;
const marker = (color, size) => color ? `<c:marker>${v('symbol', 'circle')}${v('size', size)}${shapeProperties(color, line(color))}</c:marker>` : `<c:marker>${v('symbol', 'none')}</c:marker>`;

function title(text) {
  if (!text) return v('autoTitleDeleted', 1);
  const run = `<a:r><a:rPr lang="en-US"/><a:t>${label(String(text).replace(/[\r\n\t]+/g, ' '))}</a:t></a:r>`;
  return `<c:title><c:tx><c:rich><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr>${runProperties('defRPr', 1400, TITLE)}</a:pPr>${run}</a:p></c:rich></c:tx>${v('overlay', 0)}${shapeProperties(null, line(null))}</c:title>${v('autoTitleDeleted', 0)}`;
}
function axis(tag, id, cross, position, { grid = false, format, between } = {}) {
  const shared = `${v('axId', id)}<c:scaling>${v('orientation', 'minMax')}</c:scaling>${v('delete', 0)}${v('axPos', position)}`
    + (grid ? `<c:majorGridlines>${shapeProperties(null, line(GRID))}</c:majorGridlines>` : '')
    + (format ? `<c:numFmt formatCode="${format}" sourceLinked="0"/>` : '')
    + `${v('majorTickMark', 'none')}${v('minorTickMark', 'none')}${v('tickLblPos', 'nextTo')}${shapeProperties(null, line(grid ? null : AXIS))}${v('crossAx', cross)}${v('crosses', 'autoZero')}`;
  return tag === 'catAx'
    ? `<c:catAx>${shared}${v('auto', 1)}${v('lblAlgn', 'ctr')}${v('lblOffset', 100)}${v('noMultiLvlLbl', 0)}</c:catAx>`
    : `<c:valAx>${shared}${v('crossBetween', between)}</c:valAx>`;
}

function plotXml(type, categories, series) {
  const colors = series.map((s, i) => hex(s.color, CHART_PALETTE[i % CHART_PALETTE.length]));
  const ids = `${v('axId', CATEGORY_AXIS)}${v('axId', VALUE_AXIS)}`;
  if (round(type)) {
    const s = series[0], points = categories.map((_, i) => hex(s.colors?.[i], CHART_PALETTE[i % CHART_PALETTE.length]));
    const dPt = points.map((color, i) => `<c:dPt>${v('idx', i)}${v('bubble3D', 0)}${shapeProperties(color, line('FFFFFF', 19050))}</c:dPt>`).join('');
    const body = `${v('varyColors', 1)}<c:ser>${seriesStart(s, 0)}${dPt}<c:cat>${strings(categories)}</c:cat><c:val>${numbers(s.values)}</c:val></c:ser>${dataLabels}${v('firstSliceAng', 0)}`;
    return type === 'pie' ? `<c:pieChart>${body}</c:pieChart>` : `<c:doughnutChart>${body}${v('holeSize', 50)}</c:doughnutChart>`;
  }
  if (BARS[type]) {
    const [direction, grouping] = BARS[type], horizontal = direction === 'bar';
    const ser = series.map((s, i) => `<c:ser>${seriesStart(s, i)}${shapeProperties(colors[i], line(null))}${v('invertIfNegative', 0)}<c:cat>${strings(categories)}</c:cat><c:val>${numbers(s.values)}</c:val></c:ser>`).join('');
    return `<c:barChart>${v('barDir', direction)}${v('grouping', grouping)}${v('varyColors', 0)}${ser}${dataLabels}${v('gapWidth', 150)}${v('overlap', grouping === 'clustered' ? 0 : 100)}${ids}</c:barChart>`
      + axis('catAx', CATEGORY_AXIS, VALUE_AXIS, horizontal ? 'l' : 'b')
      + axis('valAx', VALUE_AXIS, CATEGORY_AXIS, horizontal ? 'b' : 'l', { grid: true, format: grouping === 'percentStacked' ? '0%' : 'General', between: 'between' });
  }
  if (type === 'line' || type === 'line-markers') {
    const ser = series.map((s, i) => `<c:ser>${seriesStart(s, i)}${shapeProperties(null, line(colors[i], 28575))}${marker(type === 'line-markers' && colors[i], 5)}<c:cat>${strings(categories)}</c:cat><c:val>${numbers(s.values)}</c:val>${v('smooth', 0)}</c:ser>`).join('');
    return `<c:lineChart>${v('grouping', 'standard')}${v('varyColors', 0)}${ser}${dataLabels}${v('marker', 1)}${ids}</c:lineChart>`
      + axis('catAx', CATEGORY_AXIS, VALUE_AXIS, 'b') + axis('valAx', VALUE_AXIS, CATEGORY_AXIS, 'l', { grid: true, format: 'General', between: 'between' });
  }
  if (type === 'area' || type === 'area-stacked') {
    const ser = series.map((s, i) => `<c:ser>${seriesStart(s, i)}${shapeProperties(colors[i], line(null))}<c:cat>${strings(categories)}</c:cat><c:val>${numbers(s.values)}</c:val></c:ser>`).join('');
    return `<c:areaChart>${v('grouping', type === 'area' ? 'standard' : 'stacked')}${v('varyColors', 0)}${ser}${dataLabels}${ids}</c:areaChart>`
      + axis('catAx', CATEGORY_AXIS, VALUE_AXIS, 'b') + axis('valAx', VALUE_AXIS, CATEGORY_AXIS, 'l', { grid: true, format: 'General', between: 'midCat' });
  }
  if (type === 'scatter' || type === 'scatter-lines') {
    // Numeric categories are X values; any text category writes text X values,
    // which consumers plot at their 1-based positions.
    const xs = categories.every(t => String(t).trim() && Number.isFinite(Number(t))) ? `<c:xVal>${numbers(categories)}</c:xVal>` : `<c:xVal>${strings(categories)}</c:xVal>`;
    const ser = series.map((s, i) => `<c:ser>${seriesStart(s, i)}${shapeProperties(null, line(type === 'scatter-lines' && colors[i], 19050))}${marker(colors[i], 7)}${xs}<c:yVal>${numbers(s.values)}</c:yVal>${v('smooth', 0)}</c:ser>`).join('');
    return `<c:scatterChart>${v('scatterStyle', 'lineMarker')}${v('varyColors', 0)}${ser}${dataLabels}${ids}</c:scatterChart>`
      + axis('valAx', CATEGORY_AXIS, VALUE_AXIS, 'b', { grid: true, format: 'General', between: 'midCat' })
      + axis('valAx', VALUE_AXIS, CATEGORY_AXIS, 'l', { grid: true, format: 'General', between: 'midCat' });
  }
  throw new RangeError(`Unknown chart type: ${type}`);
}

/** Returns a complete chart part. Element order follows the dml-chart.xsd sequences. */
export function chartSpaceXml({ type, title: heading = '', categories = [], series = [], legend = 'b', style = 2 } = {}) {
  if (!CHART_TYPES.some(t => t.id === type)) throw new RangeError(`Unknown chart type: ${type}`);
  if (!categories.length || categories.length > 100) throw new RangeError('A chart needs 1–100 categories.');
  if (!series.length || series.length > (round(type) ? 1 : 20)) throw new RangeError(round(type) ? 'Pie and doughnut charts use one series.' : 'A chart needs 1–20 series.');
  const rows = series.map(s => ({ ...s, values: categories.map((_, i) => s.values?.[i]) }));
  const legendXml = legend === 'r' || legend === 'b' ? `<c:legend>${v('legendPos', legend)}${v('overlay', 0)}${shapeProperties(null, line(null))}</c:legend>` : '';
  const styleXml = Number.isInteger(style) && style >= 1 && style <= 48 ? v('style', style) : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}">${v('date1904', 0)}${v('lang', 'en-US')}${v('roundedCorners', 0)}${styleXml}`
    + `<c:chart>${title(heading)}<c:plotArea><c:layout/>${plotXml(type, categories, rows)}${shapeProperties(null, line(null))}</c:plotArea>`
    + `${legendXml}${v('plotVisOnly', 1)}${v('dispBlanksAs', 'gap')}</c:chart>`
    + `${shapeProperties('FFFFFF', line('D9D9D9'))}${textProperties(1000, TEXT)}</c:chartSpace>`;
}

/** Sample data for a newly inserted chart of the given type. */
export function defaultChartData(type) {
  const base = { type, title: 'Chart Title', legend: 'b' };
  if (round(type)) return { ...base, legend: 'r', categories: ['Category 1', 'Category 2', 'Category 3', 'Category 4'], series: [{ name: 'Series 1', values: [8, 5, 3, 2], color: CHART_PALETTE[0], colors: CHART_PALETTE.slice(0, 4) }] };
  if (type === 'scatter' || type === 'scatter-lines') return { ...base, categories: ['1', '2', '3', '4', '5'], series: [
    { name: 'Series 1', values: [2, 4, 3, 6, 5], color: CHART_PALETTE[0] }, { name: 'Series 2', values: [1, 2, 5, 4, 7], color: CHART_PALETTE[1] }] };
  return { ...base, categories: ['Category 1', 'Category 2', 'Category 3', 'Category 4'], series: [
    { name: 'Series 1', values: [5, 3, 4, 6], color: CHART_PALETTE[0] },
    { name: 'Series 2', values: [2, 4, 3, 5], color: CHART_PALETTE[1] },
    { name: 'Series 3', values: [3, 2, 5, 4], color: CHART_PALETTE[2] }] };
}

/** Reads back the editable data from a chart part this builder wrote. */
export function chartDataFromXml(xml) {
  const root = parseXml(xml).documentElement;
  const kids = n => [...(n?.children || [])], one = (n, name, ns = C) => kids(n).find(c => c.namespaceURI === ns && c.localName === name);
  const all = (n, name) => kids(n).filter(c => c.namespaceURI === C && c.localName === name);
  const attr = (n, name) => one(n, name)?.getAttribute('val');
  const cached = n => { const data = kids(n)[0], out = []; for (const pt of all(data, 'pt')) out[Number(pt.getAttribute('idx'))] = one(pt, 'v')?.textContent ?? ''; return out; };
  const color = props => one(one(props, 'solidFill', A), 'srgbClr', A)?.getAttribute('val') || null;
  const lineColor = props => color(one(props, 'ln', A));
  const chart = one(root, 'chart'), plot = one(chart, 'plotArea');
  const group = ['barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart'].map(n => one(plot, n)).find(Boolean);
  if (!group) throw new RangeError('Unsupported chart part.');
  const ser = all(group, 'ser'), kind = group.localName;
  let type;
  if (kind === 'barChart') type = `${attr(group, 'barDir') === 'bar' ? 'bar' : 'column'}-${{ clustered: 'clustered', stacked: 'stacked', percentStacked: 'percent' }[attr(group, 'grouping')]}`;
  else if (kind === 'lineChart') type = ser.some(s => attr(one(s, 'marker'), 'symbol') === 'circle') ? 'line-markers' : 'line';
  else if (kind === 'areaChart') type = attr(group, 'grouping') === 'stacked' ? 'area-stacked' : 'area';
  else if (kind === 'scatterChart') type = ser.some(s => lineColor(one(s, 'spPr'))) ? 'scatter-lines' : 'scatter';
  else type = kind === 'pieChart' ? 'pie' : 'doughnut';
  const categories = cached(one(ser[0], kind === 'scatterChart' ? 'xVal' : 'cat'));
  const series = ser.map(s => {
    const tx = one(s, 'tx'), props = one(s, 'spPr');
    const name = one(tx, 'v')?.textContent ?? cached(one(tx, 'strRef'))?.[0] ?? '';
    const values = cached(one(s, kind === 'scatterChart' ? 'yVal' : 'val')).map(Number);
    if (round(type)) { const colors = all(s, 'dPt').map(p => color(one(p, 'spPr'))); return { name, values, color: colors[0] || null, colors }; }
    const paint = kind === 'lineChart' ? lineColor(props) : kind === 'scatterChart' ? color(one(one(s, 'marker'), 'spPr')) || lineColor(props) : color(props);
    return { name, values, color: paint };
  });
  const runs = [...(one(one(chart, 'title'), 'tx')?.getElementsByTagNameNS(A, 't') || [])];
  const style = attr(root, 'style');
  return { type, title: runs.map(t => t.textContent).join(''), categories, series, legend: attr(one(chart, 'legend'), 'legendPos') || null, ...(style ? { style: Number(style) } : {}) };
}
