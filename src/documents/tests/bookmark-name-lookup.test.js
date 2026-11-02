import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { indexRows, parseIndexInstruction } from '../src/engine/index-entries.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

// Fields find their bookmark as Word does: bookmark names do not differ by letter case alone, and of several
// bookmarks sharing a name the first in the document counts (ECMA-376 Part 1 §17.13.6.2). REF, PAGEREF and an
// index entry's page range took the last of a name, and REF target missed the bookmark Target.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
async function open(body) {
  const parts = unzipSync(new Uint8Array(await createDocx([paragraph()]).export().arrayBuffer()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  const pkg = await DocxPackage.open(zipSync(parts));
  return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
}
const field = (instr, result) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const marked = (id, name, text, extra = '') => `<w:p${extra}><w:bookmarkStart w:id="${id}" w:name="${name}"/><w:r><w:t>${text}</w:t></w:r><w:bookmarkEnd w:id="${id}"/></w:p>`;

it('REF finds its bookmark whatever the case it is written in', async () => {
  const { d } = await open(marked(1, 'Target', 'source text') + `<w:p>${field(' REF target \\h ', 'old')}</w:p><w:p>${field(' REF TARGET \\* Upper ', 'old')}</w:p>`);
  updateSequenceFields(d);
  expect(d.text).toBe('source text\nsource text\nSOURCE TEXT');
});

it('REF to a bookmark name used twice shows the first bookmark', async () => {
  const { d } = await open(marked(0, 'Target', 'First') + marked(1, 'Target', 'Second') + `<w:p>${field(' REF Target ', 'old')}</w:p>`);
  updateSequenceFields(d);
  expect(d.text).toBe('First\nSecond\nFirst');
});

it('an index entry\'s page range (XE \\r) on a name used twice spans the first bookmark', async () => {
  const xe = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> XE "Entry" \\r target </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const { d } = await open(marked(0, 'Target', 'First page') + marked(1, 'Target', 'Second') + `<w:p><w:r><w:t>X</w:t></w:r>${xe}</w:p>`);
  const pageOf = (position, paragraphId) => { const n = d.paragraphs.findIndex(p => p.id === paragraphId) + 1; return { text: String(n), number: n }; };
  expect(indexRows(d, parseIndexInstruction(' INDEX '), pageOf)[0].runs.map(r => r.text).join('')).toBe('Entry, 1');
});

it('PAGEREF to a name used twice, written in another case, shows the first bookmark\'s page', async () => {
  const { pkg, d } = await open(`<w:p>${field(' PAGEREF TARGET \\h ', '9')}</w:p>` + marked(0, 'Target', 'First') + marked(1, 'target', 'Second', '><w:pPr><w:pageBreakBefore/></w:pPr'));
  const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
  refreshPageReferences(d, m => layoutDocument(m.paragraphs, measure, pageGeometry(m.pageSettings), m.numbering, m.tables, pkg.pageStories, { styles: m.styles }), pkg.pageStories, { checkpoint: false });
  expect(d.text.split('\n')[0]).toBe('1');
});
