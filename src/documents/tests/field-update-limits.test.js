import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { evaluateField } from '../src/engine/field-results.js';

// A number past what a Roman or letter numeral can show made formatPageNumber throw, and the throw stopped
// Update Fields as a whole: one SEQ \r 200000 \* roman (or NUMCHARS \* ALPHABETIC in a long document) left
// every other field in the document as it was, with an error.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const field = (instr, result) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

it('updates the other fields when one number is too large for its numeral format', async () => {
  const parts = unzipSync(new Uint8Array(await createDocx([paragraph()]).export().arrayBuffer()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p>${field(' SEQ Big \\r 200000 \\* roman ', 'old')}</w:p><w:p>${field(' SEQ Figure ', '9')}</w:p><w:sectPr/></w:body></w:document>`);
  const pkg = await DocxPackage.open(zipSync(parts));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const issues = [];
  expect(updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) })).toBe(1);
  expect(d.text).toBe('old\n1');
  expect(issues).toEqual(['A SEQ field whose number is too large for its number format keeps its cached result.']);
  expect(evaluateField(' NUMCHARS \\* ALPHABETIC ', { text: 'x'.repeat(5000) })).toBe('5000');
  expect(evaluateField(' NUMCHARS \\* ROMAN ', { text: 'x'.repeat(12) })).toBe('XII');
});
