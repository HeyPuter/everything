import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { defaultChartData, chartDataFromXml } from '../src/engine/chart-builder.js';

let dom, chartFragment, chartXml;
beforeAll(async () => {
  dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; globalThis.document = dom.window.document;
  ({ chartFragment, chartXml } = await import('../src/views/insert-chart.js'));
});
afterAll(() => { delete globalThis.document; dom.window.close(); });
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

it('writes an inserted chart as its own chart part that reopens with the same data, and leaves none after undo', async () => {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.replace('Sales: ');
  const data = { ...defaultChartData('line-markers'), title: 'Sales by quarter' };
  const { image, assets } = await chartFragment(doc, pkg.parts, data, { id: 1 });
  Object.assign(doc.assets, assets);
  const { assetId, id, ...properties } = image;
  doc.insertImage(assetId, properties);
  const bytes = new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
  const parts = unzipSync(bytes), chartPath = Object.keys(parts).find(p => /^word\/charts\/canvas-chart-.*\.xml$/.test(p));
  expect(chartPath).toBeTruthy();
  expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain(chartPath.replace('word/', ''));
  expect(strFromU8(parts['[Content_Types].xml'])).toContain(`/${chartPath}`);
  const reopened = await DocxPackage.open(bytes);
  expect(reopened.readOnly).toBeFalsy();
  const saved = images(reopened)[0];
  expect(saved.kind).toBe('chart');
  expect(chartDataFromXml(chartXml(saved, reopened.assets, reopened.parts))).toMatchObject({ type: 'line-markers', title: 'Sales by quarter', categories: data.categories });
  expect(chartDataFromXml(chartXml(image, doc.assets, pkg.parts)).series.map(s => s.values)).toEqual(data.series.map(s => s.values));
  doc.undo();
  const undone = unzipSync(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  expect(Object.keys(undone).filter(p => p.startsWith('word/charts/'))).toEqual([]);
});

it('explains labels the chart reader cannot keep', async () => {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const data = { ...defaultChartData('column-clustered'), categories: ['東京', 'B', 'C', 'D'] };
  await expect(chartFragment({ assets: {} }, pkg.parts, data, { id: 1 })).rejects.toThrow(/Latin script/);
});
