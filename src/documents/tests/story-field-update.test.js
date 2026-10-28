import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { updateStoryFields } from '../src/engine/field-results.js';

// Update Fields in a header or footer: DATE, FILENAME and other evaluated fields there get their current result,
// written inside each field's retained envelope. PAGE and NUMPAGES follow pagination as before.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const when = new Date(2026, 9, 3, 14, 5);
function source() {
  const parts = unzipSync(readFileSync('public/fixtures/page-number-parts.docx'));
  const complex = (code, cached, rPr = '') => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>${cached}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  parts['word/header1.xml'] = strToU8(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">Printed </w:t></w:r>${complex('DATE \\@ "MMMM d, yyyy"', 'January 1, 2000', '<w:rPr><w:b/></w:rPr>')}<w:r><w:t xml:space="preserve"> · </w:t></w:r><w:fldSimple w:instr=" FILENAME "><w:r><w:t>old.docx</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> · </w:t></w:r>${complex('PAGE', '9')}</w:p></w:hdr>`);
  return zipSync(parts);
}
const runs = model => model.paragraphs[0].runs.map(r => r.field ? `{${r.field.type}:${r.field.cachedText}}` : r.text).join('');

it('refreshes evaluated fields in a header, saves them in their envelopes and undoes in one step', async () => {
  const pkg = await DocxPackage.open(source()), story = pkg.pageStories.stories['word/header1.xml'];
  expect(story.editable).toBe(true);
  const model = new TextDocument(story.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, story.tables, pkg.assets);
  expect(runs(model)).toBe('Printed {DATE:January 1, 2000} · {FILENAME:old.docx} · {PAGE:9}');
  expect(updateStoryFields(model, { now: when, fileName: 'plan.docx' })).toBe(2);
  expect(runs(model)).toBe('Printed {DATE:October 3, 2026} · {FILENAME:plan.docx} · {PAGE:9}');
  expect(updateStoryFields(model, { now: when, fileName: 'plan.docx' })).toBe(0);
  const body = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const bytes = await pkg.export(body.paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets, { 'word/header1.xml': { paragraphs: model.paragraphs, tables: model.tables } });
  const xml = strFromU8(unzipSync(new Uint8Array(await bytes.arrayBuffer()))['word/header1.xml']);
  // The result keeps the old result's formatting, inside the field's own delimiters.
  expect(xml).toMatch(/<w:instrText xml:space="preserve"> DATE \\@ "MMMM d, yyyy" <\/w:instrText><\/w:r><w:r[^>]*><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r[^>]*><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">October 3, 2026<\/w:t><\/w:r><w:r[^>]*><w:fldChar w:fldCharType="end"\/>/);
  expect(xml).toMatch(/<w:fldSimple[^>]*w:instr=" FILENAME "[^>]*><w:r><w:t xml:space="preserve">plan\.docx<\/w:t><\/w:r><\/w:fldSimple>/);
  const again = await DocxPackage.open(new Uint8Array(await bytes.arrayBuffer()));
  expect(runs(new TextDocument(again.pageStories.stories['word/header1.xml'].paragraphs))).toBe('Printed {DATE:October 3, 2026} · {FILENAME:plan.docx} · {PAGE:9}');
  model.undo();
  expect(runs(model)).toBe('Printed {DATE:January 1, 2000} · {FILENAME:old.docx} · {PAGE:9}');
});

it('leaves locked fields and fields it cannot evaluate as they are', async () => {
  const parts = unzipSync(source());
  parts['word/header1.xml'] = strToU8(strFromU8(parts['word/header1.xml']).replace('<w:fldChar w:fldCharType="begin"/>', '<w:fldChar w:fldCharType="begin" w:fldLock="1"/>').replace(' FILENAME ', ' DOCVARIABLE Client '));
  const pkg = await DocxPackage.open(zipSync(parts)), story = pkg.pageStories.stories['word/header1.xml'];
  const model = new TextDocument(story.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, story.tables, pkg.assets);
  expect(updateStoryFields(model, { now: when, fileName: 'plan.docx' })).toBe(0);
  expect(model.history).toHaveLength(0);
});
