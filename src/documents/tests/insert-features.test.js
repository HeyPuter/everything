import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { dropCapState, setDropCap } from '../src/engine/drop-caps.js';
import { parseDiagramDescription } from '../src/engine/diagram-builder.js';
import { documentProperties, setFieldContextProvider } from '../src/engine/field-results.js';
import { updateSequenceFields } from '../src/engine/field-update.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { setFieldContextProvider(null); dom.window.close(); });
const bytes = readFileSync('tests/fixtures/insert-features/insert-features.docx');
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

it('opens the independently written Insert features package for editing and keeps it byte-identical when unchanged', async () => {
  const pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  expect(pkg.paragraphs[0].frameProperties).toMatchObject({ dropCap: 'drop', lines: '3' });
  expect(bodyFieldRanges(pkg.paragraphs).map(r => r.field.type)).toEqual(['DATE', 'DOCPROPERTY']);
  expect(pkg.paragraphs[3].runs.some(r => r.math?.xml.includes('m:sSup'))).toBe(true);
  const [icon, diagram, chart, wordArt] = images(pkg);
  expect(pkg.assets[icon.assetId].mime).toBe('image/svg+xml'); expect(pkg.assets[icon.fallbackAssetId].mime).toBe('image/png');
  expect(parseDiagramDescription(diagram.alt)).toMatchObject({ layout: 'chevronProcess', colors: 'teal', items: [{ text: 'Plan' }, { text: 'Make' }, { text: 'Ship' }] });
  expect(pkg.assets[diagram.assetId].scene.type).toBe('group');
  expect(chart.kind).toBe('chart'); expect(pkg.assets[chart.assetId].chart.series[0].values).toEqual([4, 7, 5]);
  expect(wordArt.shell).toMatch(/w14:textOutline/);
  expect(pkg.pageStories.sections[0].pageNumbering).toEqual({ format: 'upperRoman', start: 4 });
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const same = new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
  expect(unzipSync(same)).toEqual(unzipSync(new Uint8Array(bytes)));
});

it('edits the fixture: fields refresh from document properties, the drop cap is removed, and the result reopens', async () => {
  const pkg = await DocxPackage.open(bytes);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(dropCapState(doc)).toMatchObject({ mode: 'drop', lines: 3 });
  setFieldContextProvider(() => ({ now: new Date(2027, 0, 5), properties: { ...documentProperties(pkg.parts), company: 'Renamed Works' } }));
  updateSequenceFields(doc);
  setFieldContextProvider(null);
  expect(doc.text).toContain('Dated January 5, 2027 for Renamed Works.');
  doc.select(0); setDropCap(doc, { mode: 'none' });
  expect(paragraphText(doc.paragraphs[0])).toMatch(/^Once upon a time/);
  const saved = await DocxPackage.open(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  expect(saved.readOnly).toBeFalsy();
  expect(saved.paragraphs[0].frameProperties).toBeFalsy();
  expect(bodyFieldRanges(saved.paragraphs).map(r => r.field.type)).toEqual(['DATE', 'DOCPROPERTY']);
  expect(images(saved)).toHaveLength(4);
});
