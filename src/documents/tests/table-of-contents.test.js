import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { insertTableOfContents, tableOfContents, removeTableOfContents } from '../src/engine/toc.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const layoutOf = p => d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, p.pageStories, { styles: d.styles });
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());

async function headingDocument() {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('Intro\nChapter one\nBody text\nChapter two\nSection two point one\nMore text');
  const style = name => d.paragraphStyles.find(s => s.name === name).id;
  for (const [text, name] of [['Chapter one', 'Heading 1'], ['Chapter two', 'Heading 1'], ['Section two point one', 'Heading 2']]) {
    const at = d.text.indexOf(text); d.select(at); d.setParagraphStyle(style(name));
  }
  d.select(d.text.indexOf('Chapter two')); d.setParagraphFormat({ pageBreakBefore: true });
  d.select(0);
  return { pkg, d };
}

describe('table of contents', () => {
  it('builds linked entries with page references, indents and dot leaders', async () => {
    const { pkg, d } = await headingDocument();
    d.select(d.text.indexOf('Chapter one'));
    insertTableOfContents(d);
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    expect(d.text.split('\n').slice(1, 5)).toEqual(['Contents', 'Chapter one\t1', 'Chapter two\t2', 'Section two point one\t2']);
    const toc = tableOfContents(d.paragraphs);
    expect(toc.whole).toBe(true);
    expect(d.text.slice(toc.start, toc.end)).toBe('Chapter one\t1\nChapter two\t2\nSection two point one\t2');
    const entry = d.paragraphs[toc.first + 2];
    expect(entry.format.indentLeft).toBe(220);
    expect(entry.format.tabs).toEqual([{ position: 9360, alignment: 'right', leader: 'dot' }]);
    expect(entry.runs[0].link.anchor).toMatch(/^_Toc\d{9}$/);
    expect(d.bookmarks.map(b => d.text.slice(b.start, b.end))).toEqual(['Chapter one', 'Chapter two', 'Section two point one']);
    const xml = strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
    expect(xml).toMatch(/<w:instrText[^>]*> TOC \\o "1-3" \\h \\z \\u <\/w:instrText>/);
    expect(xml).toMatch(/<w:hyperlink w:anchor="_Toc\d+"[^>]*>.*?PAGEREF _Toc\d+ \\h .*?<\/w:hyperlink>/);
    const again = await DocxPackage.open(await save(pkg, d)), reopened = new TextDocument(again.paragraphs, again.pageSettings, again.numbering, again.styles, again.tables, again.assets);
    expect(reopened.text).toBe(d.text);
    expect(bodyFieldRanges(reopened.paragraphs).map(r => r.field.type)).toEqual(['TOC', 'PAGEREF', 'PAGEREF', 'PAGEREF']);
    // Rebuilding keeps the heading that follows the table intact.
    insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) });
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    expect(d.text.split('\n').slice(1, 6)).toEqual(['Contents', 'Chapter one\t1', 'Chapter two\t2', 'Section two point one\t2', 'Chapter one']);
    expect(d.paragraphs[5].styleId).toBe('Heading1');
    expect(d.paragraphs[5].format.tabs).toEqual([]);
  });

  it('rebuilds the table from current headings and removes it with its title', async () => {
    const { pkg, d } = await headingDocument();
    insertTableOfContents(d);
    const at = d.text.indexOf('More text'); d.select(at, at + 4); d.replace('Appendix');
    d.select(d.text.indexOf('Appendix')); d.setParagraphStyle(d.paragraphStyles.find(s => s.name === 'Heading 1').id);
    insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) });
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    expect(d.text.split('\n').slice(0, 5)).toEqual(['Contents', 'Chapter one\t1', 'Chapter two\t2', 'Section two point one\t2', 'Appendix text\t2']);
    expect(d.bookmarks).toHaveLength(4);
    const headingStyle = d.paragraphs.find(p => p.runs.map(r => r.text).join('') === 'Chapter one' && !p.runs.some(r => r.link)).styleId;
    expect(headingStyle).toBe('Heading1');
    removeTableOfContents(d);
    expect(d.text.startsWith('Intro\nChapter one\nBody text')).toBe(true);
    expect(tableOfContents(d.paragraphs)).toBeNull();
    // Neither neighbour takes on the removed table's formatting.
    expect(d.paragraphs[1].styleId).toBe('Heading1');
    expect(d.paragraphs[0].format.tabs).toEqual([]);
  });

  // With Track Changes on, Remove Table of Contents removed the table untracked: no change to reject.
  it('removes the table as a tracked deletion that can be accepted or rejected', async () => {
    const { pkg, d } = await headingDocument();
    insertTableOfContents(d);
    refreshPageReferences(d, layoutOf(pkg), pkg.pageStories, { checkpoint: false });
    const withTable = d.text;
    d.revisionAuthor = 'Reviewer';
    expect(removeTableOfContents(d, tableOfContents(d.paragraphs), { tracked: true })).toBe(true);
    expect(d.text).toBe(withTable);
    const [deletion] = d.revisions;
    expect(d.revisions).toHaveLength(1);
    expect(deletion).toMatchObject({ type: 'del', author: 'Reviewer', start: withTable.indexOf('Contents') });
    expect(withTable.slice(deletion.end)).toMatch(/^Intro\nChapter one\nBody text/);
    d.resolveRevisions(false);
    expect(d.text).toBe(withTable);
    expect(tableOfContents(d.paragraphs)).not.toBeNull();
    removeTableOfContents(d, tableOfContents(d.paragraphs), { tracked: true });
    d.resolveRevisions(true);
    expect(d.text.startsWith('Intro\nChapter one\nBody text')).toBe(true);
    expect(tableOfContents(d.paragraphs)).toBeNull();
    // The deleted field is saved as deleted, code and all.
    removeTableOfContents(d);
    d.undo(); d.undo();
    insertTableOfContents(d);
    removeTableOfContents(d, tableOfContents(d.paragraphs), { tracked: true });
    const xml = strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:fldChar w:fldCharType="begin"\/><\/w:r><w:r><w:delInstrText xml:space="preserve"> TOC /);
  });
});
