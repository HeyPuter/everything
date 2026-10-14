import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { paintChart } from '../src/engine/canvas-charts.js';
import { CHART_TYPES, CHART_CONTENT_TYPE, CHART_RELATIONSHIP_TYPE, chartSpaceXml, chartDataFromXml, defaultChartData } from '../src/engine/chart-builder.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// The same inline frame the insert command writes: a 6in x 3.5in chart.
const inlineChart = relId => '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5486400" cy="3200400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Chart 1"/><wp:cNvGraphicFramePr/>'
  + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="${relId}"/></a:graphicData></a:graphic></wp:inline>`;
function chartDocx(chartXml) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="${CHART_CONTENT_TYPE}"/></Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart1" Type="${CHART_RELATIONSHIP_TYPE}" Target="charts/chart1.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:drawing>${inlineChart('rIdChart1')}</w:drawing></w:r></w:p><w:sectPr/></w:body></w:document>`,
    'word/charts/chart1.xml': chartXml,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}
const chartOf = pkg => Object.values(pkg.assets).find(a => a.chart).chart;
const expectedType = { column: 'column', bar: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut', scatter: 'scatter' };
const ids = CHART_TYPES.map(t => t.id);

it('lists every supported chart type once, grouped for the gallery', () => {
  expect(new Set(ids).size).toBe(ids.length);
  expect([...new Set(CHART_TYPES.map(t => t.group))]).toEqual(['Column', 'Bar', 'Line', 'Area', 'Pie', 'Scatter']);
  expect(CHART_TYPES.every(t => t.label && t.group)).toBe(true);
});

it.each(ids)('writes %s charts that open editable with decoded cached data', async type => {
  const data = { ...defaultChartData(type), title: 'Sales & <Costs>' }, xml = chartSpaceXml(data);
  expect(xml).not.toContain('externalData');
  const pkg = await DocxPackage.open(chartDocx(xml));
  expect(pkg.readOnly).toBeFalsy();
  const chart = chartOf(pkg), family = type.split('-')[0];
  expect(chart.type).toBe(expectedType[family]);
  expect(chart.series.map(s => s.name)).toEqual(data.series.map(s => s.name));
  expect(chart.series.map(s => s.values)).toEqual(data.series.map(s => s.values));
  if (family === 'scatter') expect(chart.series[0].xValues).toEqual(data.categories.map(Number));
  else expect(chart.series[0].categories).toEqual(data.categories);
  expect(chart.title.paragraphs[0].runs.map(r => r.text).join('')).toBe('Sales & <Costs>');
  expect(chart.legend).toBe(true); expect(chart.legendPosition).toBe(data.legend);
  if (type.endsWith('-stacked')) expect(chart.grouping).toBe('stacked');
  if (type.endsWith('-percent')) expect(chart.grouping).toBe('percentStacked');
  if (family === 'line') expect(!!chart.series[0].marker).toBe(type === 'line-markers');
  if (family === 'scatter') expect(!!chart.series[0].line).toBe(type === 'scatter-lines');
  if (family === 'pie') expect(chart.hole).toBe(0);
  if (family === 'doughnut') expect(chart.hole).toBe(50);
  expect(chartDataFromXml(xml)).toEqual({ ...data, style: 2 });
});

it.each(ids)('round trips %s chart parts byte for byte through editing, export and reopen', async type => {
  const bytes = chartDocx(chartSpaceXml(defaultChartData(type))), parts = unzipSync(bytes), pkg = await DocxPackage.open(bytes);
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const save = async () => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
  d.select(0); d.replace('Edited ');
  const saved = await save(), out = unzipSync(saved);
  for (const name of ['word/charts/chart1.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml']) expect(strFromU8(out[name]), name).toBe(strFromU8(parts[name]));
  const reopened = await DocxPackage.open(saved);
  expect(reopened.readOnly).toBeFalsy();
  expect(chartOf(reopened)).toEqual(chartOf(pkg));
  expect(strFromU8(out['word/document.xml'])).toContain('r:id="rIdChart1"');
});

it('keeps user data, colors, legend choice and absent titles', async () => {
  const data = { type: 'bar-stacked', title: '', legend: null, categories: ['North', 'South'], series: [{ name: 'Q1', values: [1.5, -2], color: '123456' }, { name: 'Q2', values: [3, 4], color: 'ABCDEF' }] };
  const xml = chartSpaceXml(data), chart = chartOf(await DocxPackage.open(chartDocx(xml)));
  expect(chart.title).toBeUndefined(); expect(chart.legend).toBe(false);
  expect(chart.series.map(s => s.fill)).toEqual(['#123456', '#abcdef']);
  expect(chart.categoryAxis.id).not.toBe(chart.valueAxis.id);
  expect(chartDataFromXml(xml)).toEqual({ ...data, style: 2 });
  const pie = { type: 'pie', title: 'Share', legend: 'b', categories: ['A', 'B', 'C'], series: [{ name: 'Mix', values: [1, 2, 3], color: '112233', colors: ['112233', '445566', '778899'] }] };
  const pieChart = chartOf(await DocxPackage.open(chartDocx(chartSpaceXml(pie))));
  expect(pieChart.series[0].points.map(p => p.fill)).toEqual(['#112233', '#445566', '#778899']);
  expect(chartDataFromXml(chartSpaceXml(pie))).toEqual({ ...pie, style: 2 });
});

it('normalizes blank or invalid cells and text scatter X values', async () => {
  const xml = chartSpaceXml({ type: 'scatter-lines', categories: ['a', 'b', 'c'], series: [{ name: 'S', values: ['', 'x', 2] }], legend: 'r' });
  const chart = chartOf(await DocxPackage.open(chartDocx(xml)));
  expect(chart.series[0]).toMatchObject({ xValues: [1, 2, 3], categories: ['a', 'b', 'c'], values: [0, 0, 2] });
  expect(() => chartSpaceXml({ type: 'pie', categories: ['a'], series: [{ values: [1] }, { values: [2] }] })).toThrow(RangeError);
  expect(() => chartSpaceXml({ type: 'radar', categories: ['a'], series: [{ values: [1] }] })).toThrow(RangeError);
});

it.each([
  ['automatic markers', x => x.replace(/<c:marker><c:symbol val="circle"\/>.*?<\/c:marker>/, '')],
  ['implicit smoothing', x => x.replace('<c:smooth val="0"/>', '')],
  ['smoothed lines', x => x.replace('<c:smooth val="0"/>', '<c:smooth val="1"/>')],
  ['unsupported symbols', x => x.replace('<c:symbol val="circle"/>', '<c:symbol val="diamond"/>')],
  ['inherited series paint', x => x.replace(/<c:spPr><a:noFill\/><a:ln w="28575".*?<\/c:spPr>/, '')],
  ['percent line grouping', x => x.replace('<c:grouping val="standard"/>', '<c:grouping val="percentStacked"/>')],
  ['moved axes', x => x.replace('<c:axPos val="b"/>', '<c:axPos val="t"/>')],
])('rejects line charts with %s', async (_, mutate) => {
  const xml = chartSpaceXml(defaultChartData('line-markers')), changed = mutate(xml);
  expect(changed).not.toBe(xml);
  await expect(DocxPackage.open(chartDocx(changed))).rejects.toThrow(/charts with/);
});

it.each([
  ['multiple pie series', x => x.replace(/(<c:ser>.*<\/c:ser>)/, '$1$1')],
  ['visible labels', x => x.replace('<c:showVal val="0"/>', '<c:showVal val="1"/>')],
  ['missing point paint', x => x.replace(/<c:dPt>.*?<\/c:dPt>/, '')],
  ['overlaid legends', x => x.replace('<c:overlay val="0"/></c:legend>', '<c:overlay val="1"/></c:legend>').replace(/(<c:legendPos val="r"\/>)<c:overlay val="0"\/>/, '$1<c:overlay val="1"/>')],
])('rejects pie charts with %s', async (_, mutate) => {
  const xml = chartSpaceXml(defaultChartData('pie')), changed = mutate(xml);
  expect(changed).not.toBe(xml);
  await expect(DocxPackage.open(chartDocx(changed))).rejects.toThrow(/charts with/);
});

it('rejects combination plots and still opens them read-only on request', async () => {
  const xml = chartSpaceXml(defaultChartData('column-clustered')), line = chartSpaceXml(defaultChartData('line')).match(/<c:lineChart>.*<\/c:lineChart>/)[0];
  const bytes = chartDocx(xml.replace('</c:barChart>', `</c:barChart>${line}`));
  await expect(DocxPackage.open(bytes)).rejects.toThrow(/charts with/);
  expect((await DocxPackage.open(bytes, { bestEffort: true })).readOnly).toBe(true);
});

function fakeContext() {
  const calls = { rects: [], texts: [], arcs: 0, fills: 0, strokes: 0, paths: 0 };
  const ctx = {
    calls, fontKerning: 'none', font: '', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic',
    save() {}, restore() {}, scale() {}, translate() {}, clip() {}, rect() {}, setLineDash() {},
    measureText: t => ({ width: String(t).length * 6 }),
    fillRect(x, y, w, h) { calls.rects.push({ color: String(this.fillStyle).toLowerCase(), x, y, w, h }); }, strokeRect() { calls.strokes++; },
    fillText(t) { calls.texts.push(String(t)); },
    beginPath() { calls.paths++; }, moveTo() {}, lineTo() {}, closePath() {}, arc() { calls.arcs++; },
    fill() { calls.fills++; calls.rects.push({ color: String(this.fillStyle).toLowerCase(), path: true }); },
    stroke() { calls.strokes++; calls.rects.push({ color: String(this.strokeStyle).toLowerCase(), path: true }); },
  };
  return ctx;
}
it.each(ids)('paints %s charts with axes, labels, legend and title', async type => {
  const data = defaultChartData(type), chart = chartOf(await DocxPackage.open(chartDocx(chartSpaceXml(data))));
  const ctx = fakeContext(); paintChart(ctx, chart, 576, 336);
  const { texts, rects, arcs, fills, strokes } = ctx.calls;
  expect(texts).toContain('Chart Title');
  const legendLabels = type === 'pie' || type === 'doughnut' ? data.categories : data.series.map(s => s.name);
  for (const name of legendLabels) expect(texts).toContain(name);
  const painted = new Set(rects.map(r => r.color));
  for (const color of data.series.map(s => `#${s.color.toLowerCase()}`)) expect(painted.has(color), color).toBe(true);
  if (type === 'pie' || type === 'doughnut') { expect(arcs).toBeGreaterThanOrEqual(4); return; }
  expect(texts.some(t => /^\d+%?$/.test(t))).toBe(true);
  if (!type.startsWith('scatter')) for (const name of data.categories) expect(texts).toContain(name);
  expect(strokes).toBeGreaterThan(3);
  if (type === 'line-markers' || type.startsWith('scatter') || type.startsWith('area')) expect(fills).toBeGreaterThan(0);
  if (type === 'line-markers' || type.startsWith('scatter')) expect(arcs).toBeGreaterThanOrEqual(data.categories.length);
  if (type === 'line') expect(arcs).toBe(0);
});
