import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { evaluateField, fieldResultPlan } from '../src/engine/field-results.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function open(body) {
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)]))));
  return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
}

// Update Fields ignored \# on document statistics, and the new value an information field names.
// §17.16.4.2: a numeric picture formats a numeric result. NUMWORDS \# "#,##0" saved as "1,234" must not
// become "1234" on Update Fields.
it('document statistics honour the \\# numeric picture', async () => {
  expect(evaluateField(' NUMWORDS \\# "000" ', { text: 'one two three' })).toBe('003');
  expect(evaluateField(' NUMPAGES \\# "#,##0" ', { pages: 1234 })).toBe('1,234');
  const model = await open('<w:p><w:r><w:t>one two</w:t></w:r></w:p><w:p><w:fldSimple w:instr=" NUMCHARS \\# &quot;0000&quot; "><w:r><w:t>0010</w:t></w:r></w:fldSimple></w:p>');
  // "one two" + the result "0010" = 10 characters without spaces: the cached result is already right.
  expect(fieldResultPlan(model, { properties: {} })).toEqual([]);
});

// AUTHOR, TITLE, SUBJECT, KEYWORDS and COMMENTS take an optional new value ({ AUTHOR "NewName" }) that
// replaces the property and is the field's result.
it('a document information field with an argument shows that argument', () => {
  const properties = { author: 'Alice', title: 'Old title' };
  expect(evaluateField(' AUTHOR "New Name" ', { properties })).toBe('New Name');
  expect(evaluateField(' TITLE "Quarterly report" \\* Upper ', { properties })).toBe('QUARTERLY REPORT');
});

