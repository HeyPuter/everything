import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { paragraph, TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = () => new Uint8Array(readFileSync('public/fixtures/best-effort.docx'));
const text = pkg => new TextDocument(pkg.paragraphs).text;

it('opens unsupported sections, fields and revisions with readable content and supported neighboring formatting', async () => {
  const pkg = await DocxPackage.open(source(), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  // Tracked deletions stay in the text as revisions (shown struck through in All Markup).
  expect(text(pkg)).toBe('Best-effort opening\nField result: September 17, 2026\nDeleted wordsInserted words\nStill readable after unsupported content.');
  expect(pkg.paragraphs[0].runs[0].bold).toBe(true);
  expect(pkg.paragraphs[2].runs.find(run => run.text === 'Inserted words')).toMatchObject({ italic: true, revision: { type: 'ins' } });
  expect(pkg.paragraphs[2].runs.find(run => run.text === 'Deleted words').revision.type).toBe('del');
  expect(pkg.parts).toEqual(unzipSync(source()));
  const model = new TextDocument(pkg.paragraphs); model.select(0); model.replace('Change');
  expect(() => pkg.export(model.paragraphs)).toThrow('read-only');
  expect(() => pkg.export()).toThrow('read-only');
});

it('keeps ordinary documents editable and round-trips their edits', async () => {
  const original = createDocx([paragraph('Editable')]);
  const pkg = await DocxPackage.open(new Uint8Array(await original.export().arrayBuffer()), { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  const model = new TextDocument(pkg.paragraphs); model.select(8); model.replace(' still');
  const reopened = await DocxPackage.open(new Uint8Array(await pkg.export(model.paragraphs).arrayBuffer()), { bestEffort: true });
  expect(text(reopened)).toBe('Editable still');
});

it('uses only one alternate branch and flattens unsupported nested tables without losing text', async () => {
  const parts = unzipSync(source());
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:body>', '<w:body><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:unknown"><mc:Choice Requires="x"><w:p><w:r><w:t>Unused choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback text</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:tbl><w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr><w:tr><w:tc><w:tbl><w:tblPr><w:tblLayout w:type="fixed"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Nested cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>'));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(text(pkg)).toContain('Fallback text\nNested cell\nBest-effort opening');
  expect(text(pkg)).not.toContain('Unused choice');
});

it('still rejects corrupt archives and unsafe XML rather than disguising them as unsupported features', async () => {
  await expect(DocxPackage.open(new Uint8Array([1, 2, 3]), { bestEffort: true })).rejects.toThrow('archive');
  const parts = unzipSync(source()); parts['word/document.xml'] = strToU8('<!DOCTYPE doc [<!ENTITY x "test">]><doc/>');
  await expect(DocxPackage.open(zipSync(parts), { bestEffort: true })).rejects.toThrow('entity');
});
it('keeps fallback page backgrounds local to each read-only preview', async () => {
  const parts=unzipSync(source());
  parts['word/document.xml']=strToU8(strFromU8(parts['word/document.xml']).replace('<w:body>','<w:background w:color="123456"/><w:body>'));
  const colored=await DocxPackage.open(zipSync(parts),{bestEffort:true});
  expect(colored.readOnly).toBe(true);expect(colored.pageSettings.background).toBe('123456');
  const ordinary=await DocxPackage.open(source(),{bestEffort:true});
  expect(ordinary.readOnly).toBe(true);expect(ordinary.pageSettings.background).toBe('auto');
  expect(colored.pageSettings.background).toBe('123456');
});
