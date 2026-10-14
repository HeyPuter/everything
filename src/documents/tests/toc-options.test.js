import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { insertTableOfContents, parseTocInstruction, tocInstruction, contentsOptions, figuresOptions, tocFields, tableOfContents, tocPageReferences } from '../src/engine/toc.js';
import { insertCaption } from '../src/engine/captions.js';
import { insertEntryField } from '../src/engine/generated-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const layoutOf = p => d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, p.pageStories, { styles: d.styles });
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
async function doc(text) {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace(text);
  return { pkg, d };
}
const style = (d, name) => d.paragraphStyles.find(s => s.name === name).id;
const lines = (d, span) => d.text.slice(span.start, span.end).split('\n');

describe('table of contents options', () => {
  it('parses and writes switches, keeping unknown ones', () => {
    const options = parseTocInstruction(' TOC \\o "2-4" \\t "Title,1,Quote,2" \\h \\z \\n "3-4" \\p "-" \\u \\w ');
    expect(options).toMatchObject({ headingRange: [2, 4], styles: [{ name: 'Title', level: 1 }, { name: 'Quote', level: 2 }], hyperlinks: true, hideInWeb: true, omitPageNumbers: [3, 4], separator: '-', outline: true, extra: ['\\w'] });
    expect(tocInstruction(options)).toBe(' TOC \\o "2-4" \\t "Title,1,Quote,2" \\h \\z \\n "3-4" \\p "-" \\u \\w ');
    expect(tocInstruction(figuresOptions({ label: 'Table', includeLabel: false }))).toBe(' TOC \\a "Table" \\h \\z ');
  });

  it('builds from custom styles and levels, without page numbers, and from TC entries', async () => {
    const { pkg, d } = await doc('Report\nChapter\nDetail\nAside\nEnd');
    for (const [text, name] of [['Report', 'Title'], ['Chapter', 'Heading 1'], ['Detail', 'Heading 3']]) { d.select(d.text.indexOf(text)); d.setParagraphStyle(style(d, name)); }
    insertEntryField(d, ' TC "Marked aside" \\f C \\l 2 ', d.text.indexOf('Aside'));
    d.select(d.text.indexOf('End'));
    const options = { ...contentsOptions({ levels: 2, pageNumbers: false, styles: [{ name: 'Title', level: 1 }] }), tcIdentifier: 'C' };
    const { range } = insertTableOfContents(d, { title: null, options });
    expect(lines(d, range)).toEqual(['Report', 'Chapter', 'Marked aside']);
    expect(d.paragraphs.find(p => p.runs.map(r => r.text).join('') === 'Marked aside').format.indentLeft).toBe(220);
    expect(bodyFieldRanges(d.paragraphs).filter(r => r.field.type === 'PAGEREF')).toEqual([]);
    const xml = strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
    expect(xml).toContain(' TOC \\o "1-2" \\t "Title,1" \\f C \\h \\z \\n \\u ');
    expect(xml).toMatch(/TC "Marked aside" \\f C \\l 2 <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="end"\/>/);
  });

  it('puts the page number after a separator when numbers are not right-aligned', async () => {
    const { pkg, d } = await doc('Alpha\nBody');
    d.select(0); d.setParagraphStyle(style(d, 'Heading 1'));
    d.select(d.text.length);
    const { range } = insertTableOfContents(d, { title: null, options: contentsOptions({ rightAlign: false }), rightAlign: false });
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    expect(lines(d, tableOfContents(d.paragraphs))).toEqual(['Alpha 1']);
    expect(d.paragraphs.at(-2).format.tabs).toEqual([]);
    expect(range.field.instruction).toContain('\\p " "');
  });

  it('lists captions in a table of figures, with or without their labels, and refreshes only its page numbers', async () => {
    const { pkg, d } = await doc('Chart\nPhoto\nTable here');
    d.select(1); insertCaption(d, { label: 'Figure', text: 'Revenue' });
    d.select(d.text.indexOf('Photo')); insertCaption(d, { label: 'Figure', text: 'Office' });
    d.select(d.text.indexOf('Table here')); insertCaption(d, { label: 'Table', text: 'Costs', format: 'ROMAN' });
    expect(d.text).toContain('Table I: Costs');
    d.select(d.text.length);
    insertTableOfContents(d, { title: null, options: figuresOptions({ label: 'Figure' }) });
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    const figures = tocFields(d.paragraphs).find(t => t.figures);
    expect(lines(d, figures)).toEqual(['Figure 1: Revenue\t1', 'Figure 2: Office\t1']);
    d.select(d.text.length);
    insertTableOfContents(d, { title: null, options: figuresOptions({ label: 'Figure', includeLabel: false }) });
    expect(lines(d, tocFields(d.paragraphs).at(-1))).toEqual(['Revenue\t1', 'Office\t1']);
    expect(tocPageReferences(d, figures).size).toBe(2);
    const again = new TextDocument((await DocxPackage.open(await save(pkg, d))).paragraphs);
    expect(tocFields(again.paragraphs).map(t => t.figures)).toEqual([true, true]);
  });
});
