import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { newExcelChart, subtypeOf } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

const decode = entry => new TextDecoder().decode(entry.content);
const TREE = [['Region', 'Country', 'Sales'], ['Europe', 'France', 50], ['', 'Spain', 30], ['Asia', 'Japan', 60], ['', 'India', 45], ['Africa', 'Kenya', 15]];
const BOX = [['Course', 'Class A', 'Class B'], ['Math', 70, 60], ['Art', 90, 55], ['Math', 80, 65], ['Art', 60, 75], ['Math', 75, 40], ['Art', 85, 50]];
const FUNNEL = [['Stage', 'Count'], ['Visits', 500], ['Trials', 300], ['Orders', 80]];
const PRICES = [['Date', 'Volume', 'Open', 'High', 'Low', 'Close'], ['Mon', 100, 10, 12, 9, 11], ['Tue', 120, 11, 13, 8, 9], ['Wed', 90, 9, 10, 7, 9.5]];
const GRID = [['', 'S1', 'S2', 'S3'], ['a', 1, 4, 2], ['b', 5, 8, 6], ['c', 3, 9, 7]];
const PIE = [['Item', 'Share'], ['Rent', 40], ['Food', 25], ['Travel', 12], ['Fun', 8], ['Books', 5]];

function book(rows, subtype, range = { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, patch = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') wb.setInput(id, r, c, String(v)); }));
  wb.addChart(id, { ...newExcelChart(wb, id, range, subtype), ...patch });
  return { wb, id };
}

/** Export, optionally edit the package, and reopen, with or without the app's own sidecar. */
async function cycle(wb, { meta = false, edit = null } = {}) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const parts = Object.fromEntries(zip.FullPaths.map((p, i) => [p.slice(zip.FullPaths[0].length - 1), zip.FileIndex[i]]).filter(([, f]) => f.content?.length).map(([p, f]) => [p, decode(f)]));
  if (!meta) X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(parts['/xl/workbook.xml'].replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
  if (edit) for (const [path, xml] of Object.entries(edit(parts))) X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(xml));
  return { wb: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'cycle.xlsx'), parts };
}
const drawn = (wb, chart) => renderChartSvg(chartData(wb, wb.sheets[0].id, chart), chart, 480, 288);

describe('extended chart parts', () => {
  it.each([['treemap', TREE], ['sunburst', TREE], ['boxWhisker', BOX], ['funnel', FUNNEL]])('writes a %s as a chartex part and reads it back natively', async (subtype, rows) => {
    const { wb } = book(rows, subtype, undefined, subtype === 'treemap' ? { treemapLabels: 'banner' } : subtype === 'boxWhisker' ? { box: { quartiles: 'inclusive', meanLine: true, innerPoints: true } } : {});
    const { wb: back, parts } = await cycle(wb);
    const ex = parts['/xl/charts/chartEx1_1.xml'];
    expect(ex).toContain(`layoutId="${subtype}"`);
    expect(ex).toContain('<cx:f>Sheet1!$A$2:$');
    expect(parts['/[Content_Types].xml']).toContain('application/vnd.ms-office.chartex+xml');
    expect(parts['/[Content_Types].xml']).toContain('application/vnd.ms-office.chartstyle+xml');
    expect(parts['/xl/drawings/_rels/drawing1.xml.rels']).toContain('http://schemas.microsoft.com/office/2014/relationships/chartEx');
    expect(parts['/xl/charts/_rels/chartEx1_1.xml.rels']).toContain('chartColorStyle');
    expect(parts['/xl/drawings/drawing1.xml']).toMatch(/<mc:AlternateContent[^>]*><mc:Choice xmlns:cx\d="[^"]+" Requires="cx\d"><xdr:graphicFrame/);
    expect(parts['/xl/drawings/drawing1.xml']).toContain('<mc:Fallback><xdr:sp');
    const chart = back.sheets[0].charts[0];
    expect(chart.type).toBe(subtype);
    expect(subtypeOf(chart)).toBe(subtype);
    const data = chartData(back, back.sheets[0].id, chart);
    if (subtype === 'treemap' || subtype === 'sunburst') {
      expect(ex).toContain('<cx:f>Sheet1!$A$2:$B$6</cx:f><cx:lvl ptCount="5"><cx:pt idx="0">France</cx:pt>');
      expect(data.levels).toEqual([['Europe', 'France'], ['Europe', 'Spain'], ['Asia', 'Japan'], ['Asia', 'India'], ['Africa', 'Kenya']]);
      expect(data.series[0]).toMatchObject({ name: 'Sales', values: [50, 30, 60, 45, 15] });
    } else expect(data.series.length).toBe(rows[0].length - 1);
    if (subtype === 'treemap') expect(chart.treemapLabels).toBe('banner');
    if (subtype === 'boxWhisker') {
      expect(chart.box).toMatchObject({ quartiles: 'inclusive', meanLine: true, innerPoints: true, meanMarkers: true, outliers: true });
      expect(data.categories).toEqual(['Math', 'Art', 'Math', 'Art', 'Math', 'Art']);
    }
    expect(drawn(back, chart)).not.toMatch(/NaN|Infinity/);
  });

  it('keeps the whole model through the sidecar and follows sheet edits afterwards', async () => {
    const { wb } = book(TREE, 'sunburst', undefined, { title: 'Regions', description: 'Sales by region' });
    const { wb: back, parts } = await cycle(wb, { meta: true });
    // The exported drawing reads back natively, so the sidecar records its baseline for later reconciliation.
    expect(Object.values(parts).some(xml => xml.includes('nativeDrawings'))).toBe(true);
    const chart = back.sheets[0].charts[0];
    expect(chart).toMatchObject({ type: 'sunburst', title: 'Regions', description: 'Sales by region', labels: true });
    expect(chart.range).toEqual({ r1: 0, c1: 0, r2: 5, c2: 2 });
    back.setInput(back.sheets[0].id, 1, 2, '99');
    expect(chartData(back, back.sheets[0].id, chart).series[0].values[0]).toBe(99);
  });

  it('reads named sources, as other apps write them', async () => {
    const { wb } = book(TREE, 'treemap');
    const { wb: back } = await cycle(wb, { edit: parts => ({
      '/xl/charts/chartEx1_1.xml': parts['/xl/charts/chartEx1_1.xml'].replace('<cx:f>Sheet1!$A$2:$B$6</cx:f>', '<cx:f dir="row">_xlchart.v1.0</cx:f>')
        .replace('<cx:f>Sheet1!$C$2:$C$6</cx:f>', '<cx:f>_xlchart.v1.1</cx:f>'),
      '/xl/workbook.xml': parts['/xl/workbook.xml'].replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '').replace('</workbook>', '<definedNames><definedName name="_xlchart.v1.0" hidden="1">Sheet1!$A$2:$B$6</definedName>'
        + '<definedName name="_xlchart.v1.1" hidden="1">Sheet1!$C$2:$C$6</definedName></definedNames></workbook>').replace(/<definedNames>([\s\S]*?)<\/definedNames><definedNames>/, '<definedNames>$1'),
    }) });
    const chart = back.sheets[0].charts[0];
    expect(chart.sourceRefs[0]).toMatchObject({ categories: '_xlchart.v1.0', values: '_xlchart.v1.1' });
    const data = chartData(back, back.sheets[0].id, chart);
    expect(data.levels[2]).toEqual(['Asia', 'Japan']);
    expect(data.series[0].values).toEqual([50, 30, 60, 45, 15]);
  });
});

describe('classic chart parts', () => {
  it.each([['stockHlc', 'hlc'], ['stockOhlc', 'ohlc'], ['stockVhlc', 'vhlc'], ['stockVohlc', 'vohlc']])('writes %s as c:stockChart', async (subtype, kind) => {
    const rows = kind === 'vhlc' ? PRICES.map(row => [row[0], row[1], ...row.slice(3)]) : kind === 'hlc' ? PRICES.map(row => [row[0], ...row.slice(3)]) : kind === 'ohlc' ? PRICES.map(row => [row[0], ...row.slice(2)]) : PRICES;
    const { wb } = book(rows, subtype);
    const { wb: back, parts } = await cycle(wb);
    const xml = parts['/xl/charts/chart1_1.xml'];
    expect(xml).toContain('<c:stockChart>');
    expect(xml).toContain('<c:hiLowLines>');
    expect(xml.includes('<c:upDownBars>')).toBe(kind.includes('o'));
    expect(xml.includes('<c:barChart>')).toBe(kind.startsWith('v'));
    expect(xml.match(/<c:stockChart>[\s\S]*?<\/c:stockChart>/)[0]).not.toContain('<c:varyColors');
    const chart = back.sheets[0].charts[0];
    expect(chart).toMatchObject({ type: 'stock', stock: kind });
    expect(subtypeOf(chart)).toBe(subtype);
    const svg = drawn(back, chart);
    expect(svg.match(/chart-stock-hilo/g)).toHaveLength(3);
  });

  it.each([['surface3d', 'c:surface3DChart'], ['surfaceWireframe3d', 'c:surface3DChart'], ['contour', 'c:surfaceChart'], ['contourWireframe', 'c:surfaceChart']])('writes %s with a series axis and a 3-D view', async (subtype, element) => {
    const { wb } = book(GRID, subtype);
    const { wb: back, parts } = await cycle(wb);
    const xml = parts['/xl/charts/chart1_1.xml'];
    expect(xml).toContain(`<${element}>`);
    expect(xml).toContain(`<c:wireframe val="${subtype.toLowerCase().includes('wireframe') ? 1 : 0}"/>`);
    expect(xml).toContain('<c:serAx>');
    expect(xml).toMatch(/<c:view3D>.*<\/c:view3D><c:plotArea>/);
    expect(xml).not.toMatch(/<c:dPt>|<c:dLbls>/);
    const chart = back.sheets[0].charts[0];
    expect(subtypeOf(chart)).toBe(subtype);
    expect(chartData(back, back.sheets[0].id, chart).series.map(s => s.values)).toEqual([[1, 5, 3], [4, 8, 9], [2, 6, 7]]);
  });

  it.each(['pieExploded', 'pieOfPie', 'barOfPie', 'doughnutExploded'])('keeps %s through a native-only cycle', async subtype => {
    const { wb } = book(PIE, subtype);
    const { wb: back, parts } = await cycle(wb);
    const xml = parts['/xl/charts/chart1_1.xml'];
    if (subtype.endsWith('OfPie')) {
      expect(xml).toContain(`<c:ofPieType val="${subtype === 'barOfPie' ? 'bar' : 'pie'}"/>`);
      expect(xml).toContain('<c:splitPos val="3"/><c:secondPieSize val="75"/>');
      expect(xml).not.toContain('firstSliceAng');
    } else expect(xml).toContain('<c:explosion val="15"/>');
    const chart = back.sheets[0].charts[0];
    expect(subtypeOf(chart)).toBe(subtype);
    const svg = drawn(back, chart);
    expect(svg).not.toMatch(/NaN|Infinity/);
    if (subtype.endsWith('OfPie')) expect(svg.match(/chart-ofpie-connector/g)).toHaveLength(2);
  });
});
