import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// Part names compare without regard to ASCII case (ECMA-376 Part 2, §9.1.1.1): a relationship whose target
// is styles.xml names the ZIP item word/Styles.xml. Such packages open in Word; they opened here read-only,
// as if the styles, theme or pictures were missing.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const RENAMED = {
  'word/styles.xml': 'word/Styles.xml', 'word/settings.xml': 'word/SETTINGS.xml', 'word/numbering.xml': 'word/Numbering.xml',
  'word/theme/theme1.xml': 'word/Theme/Theme1.xml', 'word/media/image1.png': 'word/media/Image1.PNG', 'word/media/image2.jpg': 'word/Media/image2.JPG',
};
const original = () => readFileSync('tests/fixtures/image-content-types/correct.docx');
const recased = () => {
  const parts = unzipSync(original());
  for (const [from, to] of Object.entries(RENAMED)) { parts[to] = parts[from]; delete parts[from]; }
  return zipSync(parts);
};
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());

it('opens a package whose part names differ in case from their relationship targets as the same document', async () => {
  const expected = await DocxPackage.open(original()), pkg = await DocxPackage.open(recased(), { bestEffort: true });
  expect(pkg.previewIssues).toBeUndefined();
  expect(pkg.readOnly).toBeFalsy();
  const ids = paragraphs => paragraphs.map(({ id, ...p }) => JSON.stringify(p).replace(/word\/[A-Za-z]+\/[A-Za-z0-9.]+/g, name => name.toLowerCase()));
  expect(ids(pkg.paragraphs)).toEqual(ids(expected.paragraphs));
  expect(pkg.styles).toEqual(expected.styles);
  expect(pkg.numbering).toEqual(expected.numbering);
  expect(Object.values(pkg.assets).map(a => a.mime).sort()).toEqual(['image/jpeg', 'image/png']);
});

it('saves an edit into the parts as they are named, with no second copy', async () => {
  const pkg = await DocxPackage.open(recased()), doc = model(pkg);
  expect(unzipSync(await save(pkg, doc))).toEqual(unzipSync(recased()));
  doc.select(0); doc.replace('Edited '); doc.select(0, 6); doc.setParagraphStyle('Heading1');
  const parts = unzipSync(await save(pkg, doc));
  const names = Object.keys(parts).map(name => name.toLowerCase());
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  for (const name of Object.values(RENAMED)) expect(Object.hasOwn(parts, name), name).toBe(true);
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(model(reopened).text.startsWith('Edited ')).toBe(true);
  expect(reopened.paragraphs[0].styleId).toBe('Heading1');
});

it('reads a header whose part name and content type entry differ in case from its relationship target', async () => {
  const { docxWithParagraphs } = await import('./helpers/docx.js');
  const { strToU8, strFromU8 } = await import('fflate');
  const parts = unzipSync(docxWithParagraphs([{ text: 'Body' }]));
  const edit = (name, change) => { parts[name] = strToU8(change(strFromU8(parts[name]))); };
  parts['word/Header1.xml'] = strToU8('<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Running head</w:t></w:r></w:p></w:hdr>');
  edit('word/_rels/document.xml.rels', t => t.replace('</Relationships>', '<Relationship Id="rH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'));
  edit('[Content_Types].xml', t => t.replace('</Types>', '<Override PartName="/WORD/HEADER1.XML" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
  edit('word/document.xml', t => t.replace('<w:sectPr/>', '<w:sectPr><w:headerReference w:type="default" r:id="rH"/></w:sectPr>'));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.previewIssues).toBeUndefined();
  expect(pkg.readOnly).toBeFalsy();
  expect(Object.keys(pkg.pageStories.stories)).toEqual(['word/Header1.xml']);
  expect(pkg.pageStories.stories['word/Header1.xml'].paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Running head']);
});
