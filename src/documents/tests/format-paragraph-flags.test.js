import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { revisionView } from '../src/engine/revisions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
async function save(pkg, doc) {
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, xml: strFromU8(unzipSync(bytes)['word/document.xml']) };
}
const reopen = async bytes => { const pkg = await DocxPackage.open(bytes); return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets); };

it('stores mirror indents, line-number and hyphenation suppression as paragraph properties', async () => {
  const { pkg, doc } = documentWith(['Mirrored paragraph', 'Plain paragraph']);
  doc.select(0);
  expect(doc.setParagraphFormat({ mirrorIndents: true, suppressLineNumbers: true, suppressAutoHyphens: true, indentLeft: 1440 })).toBe(true);
  expect(doc.paragraphFormatting).toMatchObject({ mirrorIndents: true, suppressLineNumbers: true, suppressAutoHyphens: true });
  expect(() => doc.setParagraphFormat({ mirrorIndents: 'yes' })).toThrow();
  const { bytes, xml } = await save(pkg, doc);
  // Schema order: suppressLineNumbers, suppressAutoHyphens, ind, mirrorIndents.
  expect(xml).toMatch(/<w:suppressLineNumbers w:val="1"\/>[\s\S]*<w:suppressAutoHyphens w:val="1"\/>[\s\S]*<w:ind [^>]*\/><w:mirrorIndents w:val="1"\/>/);
  const reopened = await reopen(bytes);
  expect(reopened.paragraphs[0].format).toMatchObject({ mirrorIndents: true, suppressLineNumbers: true, suppressAutoHyphens: true, indentLeft: 1440 });
  expect(reopened.paragraphs[1].format).toMatchObject({ mirrorIndents: false, suppressLineNumbers: false, suppressAutoHyphens: false });
  doc.undo();
  expect(doc.paragraphFormatting.mirrorIndents).toBe(false);
});

it('mirrors indents on even pages without changing line width', () => {
  const { doc } = documentWith(['First page', 'Second page']);
  doc.select(0, doc.text.length);
  doc.setParagraphFormat({ mirrorIndents: true, indentLeft: 1440, indentRight: 0 });
  doc.select(doc.text.indexOf('Second')); doc.setParagraphFormat({ pageBreakBefore: true });
  const placed = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { styles: doc.styles });
  const first = placed.lines.find(l => l.paragraphId === doc.paragraphs[0].id), second = placed.lines.find(l => l.paragraphId === doc.paragraphs[1].id);
  expect(first.page).toBe(0); expect(second.page).toBe(1);
  // Odd page: indented from the left margin. Even page: the left indent moves to the right side.
  expect(first.fragments[0].x - second.fragments[0].x).toBeCloseTo(1440 / 15, 3);
});

it('hides hidden text unless formatting marks show it, and keeps w:vanish through DOCX', async () => {
  const { pkg, doc } = documentWith(['Shown secret text']);
  const start = doc.text.indexOf('secret');
  doc.select(start, start + 'secret '.length);
  expect(doc.setRunFormat({ vanish: true })).toBe(true);
  expect(doc.runFormatting.vanish).toBe(true);
  const visible = () => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { styles: doc.styles }).lines[0].fragments.map(f => f.text).join('');
  expect(visible()).toBe('Shown text');
  revisionView.showHidden = true;
  try { expect(visible()).toBe('Shown secret text'); } finally { revisionView.showHidden = false; }
  const { bytes, xml } = await save(pkg, doc);
  expect(xml).toMatch(/<w:vanish w:val="1"\/>[\s\S]*secret/);
  const reopened = await reopen(bytes);
  reopened.select(start + 1);
  expect(reopened.runFormatting.vanish).toBe(true);
  reopened.select(start, start + 'secret '.length);
  expect(reopened.setRunFormat({ vanish: false })).toBe(true);
  const again = await save(pkg, reopened);
  expect(again.xml).toMatch(/<w:vanish w:val="0"\/>/);
  expect((await reopen(again.bytes)).paragraphs[0].runs.every(r => !r.vanish)).toBe(true);
});
