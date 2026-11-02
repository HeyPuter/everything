import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { chartSpaceXml } from '../src/engine/chart-builder.js';

// A chart or picture the user deleted (or replaced) must not stay in the saved file with its data:
// its part, the parts only it used (a chart's workbook and colors), their relationships and
// content types go. Parts something else still uses, and parts the file never used, stay.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships', T = `${R}`;
const PNG = readFileSync('icon-128.png');
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"`;
const chartRun = (id, rel) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2743200" cy="1828800"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Chart ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="${rel}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const pictureRun = (id, rel) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
// The chart part as this editor writes one (its own reader accepts it), linked to a workbook as Word's are.
const CHART = chartSpaceXml({ type: 'column-clustered', title: '', legend: null, categories: ['Q1', 'Q2'], series: [{ name: 'Secret revenue', values: [4, 7], color: '4472C4' }] })
  .replace('</c:chartSpace>', '<c:externalData r:id="rWorkbook"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>');

/** Independently written: a chart with its workbook and colors; a picture; a picture part the file never used. */
function source({ body, header = null }) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/word/charts/colors1.xml" ContentType="application/vnd.ms-office.chartcolorstyle+xml"/>${header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${T}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rChart" Type="${T}/chart" Target="charts/chart1.xml"/><Relationship Id="rPicture" Type="${T}/image" Target="media/image1.png"/><Relationship Id="rUnused" Type="${T}/image" Target="media/unused.png"/>${header ? `<Relationship Id="rHeader" Type="${T}/header" Target="header1.xml"/>` : ''}</Relationships>`,
    'word/document.xml': `<w:document ${NS}><w:body>${body}<w:sectPr>${header ? '<w:headerReference w:type="default" r:id="rHeader"/>' : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/charts/chart1.xml': CHART,
    'word/charts/_rels/chart1.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rWorkbook" Type="${T}/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/><Relationship Id="rColors" Type="http://schemas.microsoft.com/office/2011/relationships/chartColorStyle" Target="colors1.xml"/></Relationships>`,
    'word/charts/colors1.xml': '<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" meth="cycle" id="10"/>',
    'word/embeddings/Microsoft_Excel_Worksheet.xlsx': 'Secret revenue workbook',
    'word/media/image1.png': PNG,
    'word/media/unused.png': PNG,
  };
  if (header) {
    files['word/header1.xml'] = `<w:hdr ${NS}>${header}</w:hdr>`;
    files['word/_rels/header1.xml.rels'] = `<Relationships xmlns="${REL}"><Relationship Id="rHeaderPicture" Type="${T}/image" Target="media/image1.png"/></Relationships>`;
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
}
const CHART_PARTS = ['word/charts/chart1.xml', 'word/charts/_rels/chart1.xml.rels', 'word/charts/colors1.xml', 'word/embeddings/Microsoft_Excel_Worksheet.xlsx'];

async function open(bytes) {
  const pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
}
const save = async ({ pkg, model }) => unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer()));
const remove = (model, kind) => {
  const at = model.paragraphs.flatMap(p => p.runs).filter(r => r.image).find(r => kind === 'chart' ? r.image.kind === 'chart' : r.image.kind !== 'chart');
  const offset = model.text.indexOf('￼', model.paragraphs.slice(0, model.paragraphs.findIndex(p => p.runs.includes(at))).reduce((n, p) => n + p.runs.reduce((m, r) => m + r.text.length, 0) + 1, 0));
  model.select(offset, offset + 1); model.replace('');
};
const text = (parts, name) => strFromU8(parts[name]);
const leaks = parts => Object.entries(parts).filter(([, bytes]) => strFromU8(bytes).includes('Secret revenue')).map(([name]) => name);

describe('parts a deleted drawing leaves', () => {
  it('drops a deleted chart’s part, workbook and colors with their relationships and content types', async () => {
    const doc = await open(source({ body: `<w:p><w:r><w:t>Before</w:t></w:r>${chartRun(1, 'rChart')}</w:p><w:p>${pictureRun(2, 'rPicture')}</w:p>` }));
    remove(doc.model, 'chart');
    const parts = await save(doc);
    for (const name of CHART_PARTS) expect(parts[name], name).toBeUndefined();
    expect(leaks(parts)).toEqual([]);
    expect(text(parts, 'word/_rels/document.xml.rels')).not.toMatch(/rChart|charts\//);
    expect(text(parts, '[Content_Types].xml')).not.toMatch(/charts\//);
    // The picture still shown, and the picture part the file never used, stay as they were.
    expect(parts['word/media/image1.png']).toBeDefined();
    expect(parts['word/media/unused.png']).toBeDefined();
    expect(text(parts, 'word/_rels/document.xml.rels')).toMatch(/rUnused/);
    const reopened = await open(zipSync(parts));
    expect(reopened.model.text).toBe('Before\n￼');
  });

  it('keeps a picture whose frame’s text has quotes and equals signs before its reference', async () => {
    const tricky = pictureRun(2, 'rPicture').replace('name="Picture 2"', 'name="Picture 2" descr="it&apos;s a=&quot;b&quot; c=" title=\'x="y\'');
    const doc = await open(source({ body: `<w:p><w:r><w:t>Before</w:t></w:r>${chartRun(1, 'rChart')}</w:p><w:p><w:r><w:t xml:space="preserve">Text with "quotes" and it's = signs </w:t></w:r>${tricky}</w:p>` }));
    remove(doc.model, 'chart');
    const parts = await save(doc);
    expect(parts['word/charts/chart1.xml']).toBeUndefined();
    expect(parts['word/media/image1.png']).toBeDefined();
    expect(text(parts, 'word/_rels/document.xml.rels')).toMatch(/Id="rPicture"/);
  });

  it('keeps the chart for Undo after a save, and saves it again once undone', async () => {
    const bytes = source({ body: `<w:p><w:r><w:t>Before</w:t></w:r>${chartRun(1, 'rChart')}</w:p>` });
    const doc = await open(bytes);
    doc.model.history = [];
    remove(doc.model, 'chart');
    expect(leaks(await save(doc))).toEqual([]);
    doc.model.undo();
    const parts = await save(doc), original = unzipSync(bytes);
    for (const name of CHART_PARTS) expect(parts[name], name).toEqual(original[name]);
    expect(text(parts, 'word/_rels/document.xml.rels')).toMatch(/Id="rChart"/);
  });

  it('keeps a chart part another drawing still uses', async () => {
    const twice = await open(source({ body: `<w:p>${chartRun(1, 'rChart')}${chartRun(2, 'rChart')}</w:p>` }));
    remove(twice.model, 'chart');
    const parts = await save(twice);
    for (const name of CHART_PARTS) expect(parts[name], name).toBeDefined();
    expect(text(parts, 'word/_rels/document.xml.rels')).toMatch(/Id="rChart"/);
  });

  it('drops a deleted picture’s part unless the header still shows it', async () => {
    const doc = await open(source({ body: `<w:p><w:r><w:t>Text</w:t></w:r>${pictureRun(2, 'rPicture')}</w:p>` }));
    remove(doc.model, 'picture');
    const parts = await save(doc);
    expect(parts['word/media/image1.png']).toBeUndefined();
    expect(text(parts, 'word/_rels/document.xml.rels')).not.toMatch(/rPicture/);
    expect(parts['word/media/unused.png']).toBeDefined();
    const shared = await open(source({ body: `<w:p><w:r><w:t>Text</w:t></w:r>${pictureRun(2, 'rPicture')}</w:p>`, header: `<w:p>${pictureRun(9, 'rHeaderPicture')}</w:p>` }));
    remove(shared.model, 'picture');
    expect((await save(shared))['word/media/image1.png']).toBeDefined();
  });
});
