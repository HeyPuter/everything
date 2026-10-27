import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

// A field inserted or deleted with Track Changes on has its code (begin, instruction, separator and end
// delimiters) inside the w:ins or w:del as well as its result (§17.13.5.18 ins, §17.13.5.14 del, §17.16.18
// fldChar). Saving keeps the delimiters there, and accepting or rejecting the change resolves the whole field.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function docx(paragraph) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document ${W}><w:body>${paragraph}<w:p><w:r><w:t>Second</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}
const REV = 'w:id="1" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"';
const field = (result = 'today') => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const inserted = `<w:p><w:r><w:t xml:space="preserve">Date: </w:t></w:r><w:ins ${REV}>${field()}</w:ins><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`;
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));
const body = parts => strFromU8(parts['word/document.xml']);
const fields = d => bodyFieldRanges(d.paragraphs).map(f => ({ start: f.start, end: f.end, revision: f.field.revision?.type || null }));

it('keeps an inserted field\'s code inside its insertion through edits and reopening', async () => {
  const bytes = docx(inserted), pkg = await DocxPackage.open(bytes), doc = model(pkg);
  expect(fields(doc)).toEqual([{ start: 6, end: 11, revision: 'ins' }]);
  expect(await save(pkg, doc)).toEqual(unzipSync(bytes));
  doc.select(doc.text.indexOf(' end') + 4); doc.replace('!');
  const out = await save(pkg, doc);
  // One insertion holds the begin delimiter through the end delimiter.
  expect(body(out)).toMatch(/<w:ins [^>]*w:author="Reviewer"[^>]*><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:instrText xml:space="preserve"> DATE <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t[^>]*>today<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r><\/w:ins>/);
  const reopened = model(await DocxPackage.open(zipSync(out)));
  expect(fields(reopened)).toEqual([{ start: 6, end: 11, revision: 'ins' }]);
});

it.each([
  ['rejecting all changes removes', false, 'Date:  end\nSecond', []],
  ['accepting all changes keeps', true, 'Date: today end\nSecond', [{ start: 6, end: 11, revision: null }]],
])('%s an inserted field, code and all', async (_, accept, text, after) => {
  const pkg = await DocxPackage.open(docx(inserted)), doc = model(pkg);
  expect(doc.resolveRevisions(accept)).toBe(true);
  expect(doc.text).toBe(text); expect(fields(doc)).toEqual(after);
  const out = body(await save(pkg, doc));
  expect(out).not.toMatch(/<w:ins[ >]/);
  expect(out.includes('fldChar')).toBe(accept);
  doc.undo(); expect(fields(doc)).toEqual([{ start: 6, end: 11, revision: 'ins' }]);
});

it('rejects the change at the caret together with the field it inserted', async () => {
  const pkg = await DocxPackage.open(docx(inserted)), doc = model(pkg);
  doc.select(8); expect(doc.resolveRevisions(false, 8, 8)).toBe(true);
  expect(doc.text).toBe('Date:  end\nSecond'); expect(fields(doc)).toEqual([]);
});

it('keeps a field whose delimiters are only partly tracked as it was', async () => {
  const partly = `<w:p><w:r><w:t xml:space="preserve">Date: </w:t></w:r><w:ins ${REV}>${field().replace('<w:r><w:fldChar w:fldCharType="end"/></w:r>', '')}</w:ins><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const pkg = await DocxPackage.open(docx(partly)), doc = model(pkg);
  expect(fields(doc)).toEqual([{ start: 6, end: 11, revision: null }]);
  expect(doc.resolveRevisions(false)).toBe(true);
  expect(fields(doc)).toEqual([{ start: 6, end: 6, revision: null }]);
});

// Word writes a deleted field's code as w:delInstrText (§17.16, deleted field code) and its result as w:delText (§17.3.3.8).
const deletedField = field().replace(/instrText/g, 'delInstrText').replace(/<w:t>(.*?)<\/w:t>/, '<w:delText>$1</w:delText>');
const deleted = `<w:p><w:r><w:t xml:space="preserve">Date: </w:t></w:r><w:del ${REV}>${deletedField}</w:del><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`;

it('opens a deleted field written with w:delInstrText and saves it deleted', async () => {
  const bytes = docx(deleted), pkg = await DocxPackage.open(bytes), doc = model(pkg);
  expect(pkg.readOnly).toBeFalsy();
  expect(doc.text).toBe('Date: today end\nSecond');
  expect(fields(doc)).toEqual([{ start: 6, end: 11, revision: 'del' }]);
  expect(bodyFieldRanges(doc.paragraphs)[0].field.instruction).toBe(' DATE ');
  expect(await save(pkg, doc)).toEqual(unzipSync(bytes));
  doc.select(doc.text.indexOf(' end') + 4); doc.replace('!');
  const out = await save(pkg, doc);
  expect(body(out)).toMatch(/<w:del [^>]*w:author="Reviewer"[^>]*><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:delInstrText xml:space="preserve"> DATE <\/w:delInstrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:delText[^>]*>today<\/w:delText><\/w:r><w:r><w:fldChar w:fldCharType="end"\/><\/w:r><\/w:del>/);
  expect(body(out)).not.toMatch(/<w:instrText/);
  expect(fields(model(await DocxPackage.open(zipSync(out))))).toEqual([{ start: 6, end: 11, revision: 'del' }]);
});

it.each([
  ['accepting removes', true, 'Date:  end\nSecond', []],
  ['rejecting restores', false, 'Date: today end\nSecond', [{ start: 6, end: 11, revision: null }]],
])('%s a deleted field, code and all', async (_, accept, text, after) => {
  const pkg = await DocxPackage.open(docx(deleted)), doc = model(pkg);
  expect(doc.resolveRevisions(accept)).toBe(true);
  expect(doc.text).toBe(text); expect(fields(doc)).toEqual(after);
  const out = body(await save(pkg, doc));
  expect(out).not.toMatch(/<w:del[ >]|delInstrText/);
  if (!accept) expect(out).toContain('<w:instrText xml:space="preserve"> DATE </w:instrText>');
});

it('resolves a field another reviewer deleted from an insertion like its text', async () => {
  const nested = `<w:p><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:del w:id="2" w:author="Bo" w:date="2026-01-02T00:00:00Z">${deletedField}</w:del></w:ins></w:p>`;
  let pkg = await DocxPackage.open(docx(nested)), doc = model(pkg);
  expect(fields(doc)).toEqual([{ start: 0, end: 5, revision: 'del' }]);
  doc.select(5); doc.replace('?');
  const out = body(await save(pkg, doc));
  expect(out).toMatch(/<w:ins [^>]*w:author="Ada"[^>]*><w:del [^>]*w:author="Bo"[^>]*><w:r><w:fldChar w:fldCharType="begin"\/>[^]*<w:fldChar w:fldCharType="end"\/><\/w:r><\/w:del><\/w:ins>/);
  // Rejecting only Bo's deletion brings Ada's insertion back, field and all.
  pkg = await DocxPackage.open(docx(nested)); doc = model(pkg);
  expect(doc.resolveRevisions(false, 0, 6, { only: r => r.author === 'Bo' })).toBe(true);
  expect(fields(doc)).toEqual([{ start: 0, end: 5, revision: 'ins' }]);
  expect(bodyFieldRanges(doc.paragraphs)[0].field.revision.author).toBe('Ada');
  // Rejecting everything rejects that insertion too.
  pkg = await DocxPackage.open(docx(nested)); doc = model(pkg);
  expect(doc.resolveRevisions(false)).toBe(true);
  expect(fields(doc)).toEqual([]); expect(doc.text).toBe('\nSecond');
});
