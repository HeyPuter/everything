import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
import { readVmlWatermark, vmlLength, vmlColor, vmlFraction, watermarkFrame } from '../src/engine/vml-watermarks.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

import { watermarkFixture as fixture, TEXT_PICT, PICTURE_PICT, PNG, NS } from './fixtures/vml-watermarks/fixture.js';

const watermarks = story => story.paragraphs.flatMap(p => p.runs.filter(r => r.vml).map(r => r.vml.watermark));

it('reads Word text and picture watermarks', () => {
  const doc = new DOMParser().parseFromString(`<w:r ${NS}>${TEXT_PICT}</w:r>`, 'application/xml');
  const text = readVmlWatermark(doc.documentElement.firstElementChild);
  expect(text).toMatchObject({ kind: 'text', text: 'CONFIDENTIAL', font: 'Calibri', color: 'C0C0C0', opacity: 0.5, rotation: 315, behind: true, width: vmlLength('527.85pt'),
    horizontal: { align: 'center', relativeFrom: 'margin' }, vertical: { align: 'center', relativeFrom: 'margin' } });
  const picture = readVmlWatermark(new DOMParser().parseFromString(`<w:r ${NS}>${PICTURE_PICT}</w:r>`, 'application/xml').documentElement.firstElementChild);
  expect(picture).toMatchObject({ kind: 'picture', imageRel: 'rIdWm', width: 200 * 12700, height: 100 * 12700 });
  expect(picture.gain).toBeCloseTo(0.3, 2);
  expect([vmlColor('#c0c0c0'), vmlColor('#abc'), vmlColor('silver [4]'), vmlFraction('32768f'), vmlFraction('.5'), vmlLength('1in')]).toEqual(['C0C0C0', 'AABBCC', 'C0C0C0', 0.5, 0.5, 914400]);
  // Not a watermark: an ordinary VML shape in a run.
  expect(readVmlWatermark(new DOMParser().parseFromString(`<w:pict ${NS}><v:rect style="width:10pt;height:10pt"/></w:pict>`, 'application/xml').documentElement)).toBe(null);
});

it('opens a document with Word watermarks for editing, keeps them on save and after editing the header', async () => {
  const bytes = fixture(), pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  expect(pkg.importIssues || []).toEqual([]);
  const first = pkg.pageStories.stories['word/header1.xml'], second = pkg.pageStories.stories['word/header2.xml'];
  expect(first.editable).toBe(true);
  expect(watermarks(first)).toMatchObject([{ kind: 'text', text: 'CONFIDENTIAL' }]);
  expect(watermarks(second)).toMatchObject([{ kind: 'picture', imageRel: 'rIdWm' }]);
  expect(paragraphText(first.paragraphs[0])).toBe('￼Acme internal');
  // Saved untouched: every part as it was.
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const save = async edits => unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, edits).arrayBuffer()));
  const original = unzipSync(bytes), untouched = await save();
  for (const path of ['word/header1.xml', 'word/header2.xml', 'word/media/watermark.png', 'word/_rels/header2.xml.rels']) expect(strFromU8(untouched[path]), path).toBe(strFromU8(original[path]));
  // The header's own text edited: the watermark is written again unchanged, before the edited text.
  const story = new TextDocument(first.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, first.tables, pkg.assets);
  story.select(story.text.length); story.replace(' (draft)');
  const second2 = new TextDocument(second.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, second.tables, pkg.assets);
  second2.select(second2.text.length); second2.replace('Logo page');
  const edited = await save({ 'word/header1.xml': { paragraphs: story.paragraphs, tables: story.tables }, 'word/header2.xml': { paragraphs: second2.paragraphs, tables: second2.tables } });
  const header1 = strFromU8(edited['word/header1.xml']);
  expect(header1).toContain('Acme internal (draft)');
  const pict = /<w:pict\b[\s\S]*<\/w:pict>/.exec(header1)[0];
  expect(pict).toContain('id="PowerPlusWaterMarkObject357476642"');
  expect(pict).toContain('string="CONFIDENTIAL"');
  expect(header1.indexOf('<w:pict')).toBeLessThan(header1.indexOf('Acme internal'));
  expect(strFromU8(edited['word/header2.xml'])).toContain('r:id="rIdWm"');
  expect(edited['word/media/watermark.png']).toEqual(PNG);
  const reopened = await DocxPackage.open(zipSync(edited));
  expect(reopened.readOnly).toBeFalsy();
  expect(watermarks(reopened.pageStories.stories['word/header1.xml'])).toMatchObject([{ kind: 'text', text: 'CONFIDENTIAL', rotation: 315 }]);
  expect(watermarks(reopened.pageStories.stories['word/header2.xml'])).toMatchObject([{ kind: 'picture' }]);
  expect(paragraphText(reopened.pageStories.stories['word/header2.xml'].paragraphs[0])).toBe('￼Logo page');
});

it('places a watermark centred on the margins, or at its offsets from the page', () => {
  const page = { width: 816, height: 1056, left: 96, right: 96, top: 96, bottom: 96 };
  const centred = { width: 9525 * 200, height: 9525 * 100, horizontal: { align: 'center', relativeFrom: 'margin', offset: 0 }, vertical: { align: 'center', relativeFrom: 'margin', offset: 0 } };
  expect(watermarkFrame(centred, page)).toEqual({ x: 308, y: 478, width: 200, height: 100 });
  expect(watermarkFrame({ ...centred, horizontal: { align: null, relativeFrom: 'page', offset: 9525 * 10 }, vertical: { align: 'bottom', relativeFrom: 'page', offset: 0 } }, page)).toEqual({ x: 10, y: 956, width: 200, height: 100 });
});

it('Design › Watermark replaces or removes a Word watermark instead of adding a second one', async () => {
  const { setWatermarkParts } = await import('../src/engine/package-design.js');
  const marks = xml => ({ word: (xml.match(/PowerPlusWaterMarkObject|WordPictureWatermark/g) || []).length, ours: (xml.match(/name="Document Watermark"/g) || []).length });
  let parts = unzipSync(fixture());
  setWatermarkParts(parts, { kind: 'text', text: 'SAMPLE', size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'horizontal' });
  for (const path of ['word/header1.xml', 'word/header2.xml']) expect(marks(strFromU8(parts[path])), path).toEqual({ word: 0, ours: 1 });
  // The header's own text stays.
  expect(strFromU8(parts['word/header1.xml'])).toContain('Acme internal');
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(watermarks(reopened.pageStories.stories['word/header1.xml'])).toEqual([]);
  // Remove Watermark removes Word's too.
  parts = unzipSync(fixture());
  setWatermarkParts(parts, null);
  for (const path of ['word/header1.xml', 'word/header2.xml']) expect(marks(strFromU8(parts[path])), path).toEqual({ word: 0, ours: 0 });
  expect(strFromU8(parts['word/header1.xml'])).toContain('Acme internal');
  expect((await DocxPackage.open(zipSync(parts))).readOnly).toBeFalsy();
});

it('Design › Watermark reads a Word watermark as the current one', async () => {
  const { readWatermark } = await import('../src/engine/package-design.js');
  const parts = unzipSync(fixture());
  expect(readWatermark(parts)).toEqual({ kind: 'text', text: 'CONFIDENTIAL', font: 'Calibri', size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal' });
  // Reading changes nothing.
  expect(unzipSync(zipSync(parts))['word/header1.xml']).toEqual(unzipSync(fixture())['word/header1.xml']);
  // A picture watermark alone: its picture, size in pixels and washout.
  const header1 = strFromU8(parts['word/header1.xml']).replace(/<w:pict>[\s\S]*<\/w:pict>/, '');
  const picture = readWatermark({ ...parts, 'word/header1.xml': new TextEncoder().encode(header1) });
  expect(picture).toMatchObject({ kind: 'picture', mime: 'image/png', width: 40, height: 20, scale: 'auto', washout: true });
  expect([...picture.bytes]).toEqual([...PNG]);
  // A horizontal one in a solid colour.
  const flat = strFromU8(parts['word/header1.xml']).replace('rotation:315;', '').replace('fillcolor="silver"', 'fillcolor="#FF0000"').replace('<v:fill opacity=".5"/>', '');
  expect(readWatermark({ ...parts, 'word/header1.xml': new TextEncoder().encode(flat) })).toMatchObject({ layout: 'horizontal', color: 'FF0000', semitransparent: false });
});
