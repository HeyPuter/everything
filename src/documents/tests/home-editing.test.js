import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { changeCase, convertCase, nextCycleCase, captureFormat, applyFormat, sortParagraphs, wordAt, moveParagraphs } from '../src/engine/home-editing.js';
import { formattingMarks } from '../src/engine/formatting-marks.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument } from '../src/engine/layout.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

async function styledDocument(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
async function roundTrip(pkg, doc) {
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  return DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
}
const texts = doc => doc.paragraphs.map(paragraphText);

describe('Change Case', () => {
  it('converts with the same length so runs keep their place', () => {
    expect(convertCase('hello WORLD. again', 'sentence')).toBe('Hello world. Again');
    expect(convertCase("it's a dog's life", 'title')).toBe("It's A Dog's Life");
    expect(convertCase('Straße', 'upper')).toBe('STRAßE');
    expect(convertCase('aBc', 'toggle')).toBe('AbC');
  });
  it('cycles lowercase, capitalized and uppercase as Shift+F3 does', () => {
    expect(nextCycleCase('hello there')).toBe('title');
    expect(nextCycleCase('Hello There')).toBe('upper');
    expect(nextCycleCase('HELLO')).toBe('lower');
  });
  it('changes a selection across formatted runs in one undo step and saves it', async () => {
    const { pkg, doc } = await styledDocument(['make me loud']);
    doc.select(5, 7); doc.setRunFormat({ bold: true });
    doc.select(0, 12);
    expect(changeCase(doc, 'upper')).toBe(true);
    expect(texts(doc)).toEqual(['MAKE ME LOUD']);
    expect(doc.paragraphs[0].runs.map(r => [r.text, r.bold])).toEqual([['MAKE ', false], ['ME', true], [' LOUD', false]]);
    expect(doc.range).toEqual([0, 12]);
    const reopened = await roundTrip(pkg, doc);
    expect(reopened.paragraphs[0].runs.map(r => r.text).join('')).toBe('MAKE ME LOUD');
    doc.undo();
    expect(texts(doc)).toEqual(['make me loud']);
  });
  it('acts on the word at the caret when nothing is selected', async () => {
    const { doc } = await styledDocument(['one two three']);
    doc.select(5);
    changeCase(doc, 'upper');
    expect(texts(doc)).toEqual(['one TWO three']);
    expect(wordAt('one two', 3)).toEqual([0, 3]);
    expect(wordAt('one  two', 4)).toBe(null);
  });
  it('starts Sentence case after the previous sentence', async () => {
    const { doc } = await styledDocument(['First one. second ONE']);
    doc.select(11, 21);
    changeCase(doc, 'sentence');
    expect(texts(doc)).toEqual(['First one. Second one']);
  });
});

describe('Format Painter', () => {
  it('copies character style and direct formatting onto another selection', async () => {
    const { pkg, doc } = await styledDocument(['source text', 'target text']);
    doc.select(0, 6); doc.setRunFormat({ italic: true, color: 'C00000' }); doc.setCharacterStyle('Strong');
    doc.select(2);
    const captured = captureFormat(doc);
    expect(captured.characterStyle).toBe('Strong');
    expect(captured.run).toMatchObject({ italic: true, color: 'C00000' });
    doc.select(12, 18);
    expect(applyFormat(doc, captured)).toBe(true);
    const target = doc.paragraphs[1].runs[0];
    expect(target.text).toBe('target');
    expect(target).toMatchObject({ italic: true, color: 'C00000', bold: true, styleId: 'Strong' });
    const reopened = await roundTrip(pkg, doc);
    expect(reopened.paragraphs[1].runs[0]).toMatchObject({ text: 'target', italic: true, color: 'C00000', bold: true, styleId: 'Strong' });
  });
  it('copies paragraph style and formatting from a caret, painting the word at the target caret', async () => {
    const { doc } = await styledDocument(['Heading here', 'plain words']);
    doc.select(0); doc.setParagraphStyle('Heading2'); doc.setParagraphFormat({ alignment: 'center' });
    const captured = captureFormat(doc);
    expect(captured.paragraph).toEqual({ styleId: 'Heading2', format: { alignment: 'center' } });
    doc.select(15);
    applyFormat(doc, captured);
    expect(doc.paragraphs[1].styleId).toBe('Heading2');
    expect(doc.paragraphs[1].format.alignment).toBe('center');
    expect(doc.range).toEqual([13, 18]);
  });
  it('removes direct formatting the source does not have', async () => {
    const { doc } = await styledDocument(['plain', 'bold']);
    doc.select(6, 10); doc.setRunFormat({ bold: true });
    doc.select(1, 3);
    const captured = captureFormat(doc);
    doc.select(6, 10); applyFormat(doc, captured);
    expect(doc.paragraphs[1].runs[0].bold).toBe(false);
  });
});

describe('Sort', () => {
  it('orders paragraphs by text, keeping formatting and selecting the result', async () => {
    const { pkg, doc } = await styledDocument(['cherry', 'Apple', 'banana']);
    doc.select(7, 12); doc.setRunFormat({ bold: true });
    doc.select(0, doc.text.length);
    expect(sortParagraphs(doc)).toBe(true);
    expect(texts(doc)).toEqual(['Apple', 'banana', 'cherry']);
    expect(doc.paragraphs[0].runs[0].bold).toBe(true);
    expect(doc.range).toEqual([0, doc.text.length]);
    const reopened = await roundTrip(pkg, doc);
    expect(reopened.paragraphs.map(paragraphText)).toEqual(['Apple', 'banana', 'cherry']);
    doc.undo();
    expect(texts(doc)).toEqual(['cherry', 'Apple', 'banana']);
  });
  it('sorts numbers and dates descending, empty keys first when ascending', async () => {
    const { doc } = await styledDocument(['Item 10', 'Item 9', 'Item 100']);
    doc.select(0, doc.text.length);
    sortParagraphs(doc, { type: 'number', descending: true });
    expect(texts(doc)).toEqual(['Item 100', 'Item 10', 'Item 9']);
    const dates = (await styledDocument(['2024-03-01', '', '2023-12-25'])).doc;
    dates.select(0, dates.text.length);
    sortParagraphs(dates, { type: 'date' });
    expect(texts(dates)).toEqual(['', '2023-12-25', '2024-03-01']);
  });
  it('excludes the paragraph a selection ends at the start of', async () => {
    const { doc } = await styledDocument(['b', 'a', 'c']);
    doc.select(0, 4);
    sortParagraphs(doc);
    expect(texts(doc)).toEqual(['a', 'b', 'c']);
    doc.select(0, 2);
    expect(() => sortParagraphs(doc)).toThrow(/two or more/);
  });
  it('refuses table cells', async () => {
    const { doc } = await styledDocument(['x']);
    doc.insertTable(2, 2, 600);
    const cell = doc.paragraphs.findIndex(p => p.cellId);
    doc.select(doc.paragraphOffset(cell), doc.paragraphOffset(cell + 2));
    expect(() => sortParagraphs(doc)).toThrow(/table/);
  });
});

describe('Formatting marks', () => {
  const measure = (text, style) => ({ width: text.length * style.fontSize * 0.6, ascent: style.fontSize, descent: style.fontSize / 3 });
  it('marks spaces, tabs, line breaks, page breaks and paragraph ends from the layout', async () => {
    const { doc } = await styledDocument(['a b\tc\vd']);
    doc.insertPageBreak(); doc.replace('e');
    const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { styles: doc.styles });
    const marks = layout.pages.flatMap((page, index) => formattingMarks(layout.lines.filter(l => l.page === index), doc.text, doc.paragraphs, doc.pageSettings, page));
    expect(marks.map(m => m.kind)).toEqual(['space', 'tab', 'lineBreak', 'break', 'paragraph']);
    const tab = marks.find(m => m.kind === 'tab');
    expect(tab.width).toBeGreaterThan(0);
    expect(marks.find(m => m.kind === 'break').text).toBe('Page Break');
  });
  it('shows end-of-cell marks in tables', async () => {
    const { doc } = await styledDocument(['x']);
    doc.insertTable(1, 2, 600);
    const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { styles: doc.styles });
    const marks = formattingMarks(layout.lines, doc.text, doc.paragraphs, doc.pageSettings, layout.page);
    expect(marks.filter(m => m.kind === 'cell')).toHaveLength(2);
  });
});

describe('Move paragraphs', () => {
  it('moves the selected paragraphs past a neighbour and keeps them selected, in one undo step', async () => {
    const { pkg, doc } = await styledDocument(['one', 'two', 'three', 'four']);
    doc.select(4, 13); // "two\nthree"
    expect(moveParagraphs(doc, -1)).toBe(true);
    expect(texts(doc)).toEqual(['two', 'three', 'one', 'four']);
    expect(doc.text.slice(...doc.range)).toBe('two\nthree');
    expect(moveParagraphs(doc, -1)).toBe(false);
    expect(moveParagraphs(doc, 1)).toBe(true);
    expect(moveParagraphs(doc, 1)).toBe(true);
    expect(texts(doc)).toEqual(['one', 'four', 'two', 'three']);
    const reopened = await roundTrip(pkg, doc);
    expect(reopened.paragraphs.map(paragraphText)).toEqual(['one', 'four', 'two', 'three']);
  });
  it('does not move into or out of a table', async () => {
    const { doc } = await styledDocument(['above']);
    doc.insertTable(1, 1, 600);
    const after = doc.paragraphs.findIndex(p => !p.cellId && doc.paragraphs.indexOf(p) > 0);
    doc.select(doc.paragraphOffset(after));
    expect(moveParagraphs(doc, -1)).toBe(false);
  });
});

describe('reordering paragraphs that a bookmark or comment spans', () => {
  const doc = () => {
    const d = new TextDocument([paragraph('cherry'), paragraph('banana'), paragraph('apple'), paragraph('')]);
    d.select(2, 10); d.addBookmark('Span'); // from inside "cherry" into "banana"
    d.select(14, 17); d.addComment({ author: 'A', text: 'on apple' }); // within "apple"
    return d;
  };
  const saveable = d => createDocx(d.paragraphs).export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, {}, {}, d.comments);
  it('refuses Sort rather than end a range before it starts', () => {
    const d = doc(), before = d.text;
    d.select(0, d.text.length - 1);
    expect(() => sortParagraphs(d)).toThrow(/cannot be sorted/);
    expect(d.text).toBe(before);
  });
  it('refuses to move a paragraph past the one its range continues into, and moves it past others', () => {
    const d = doc();
    d.select(0, 3);
    expect(moveParagraphs(d, 1)).toBe(false);
    d.select(d.text.indexOf('apple'));
    expect(moveParagraphs(d, -1)).toBe(true);
    expect(d.text).toBe('cherry\napple\nbanana\n');
    expect(() => saveable(d)).not.toThrow();
  });
  it('still sorts paragraphs whose ranges stay inside one paragraph', () => {
    const d = new TextDocument([paragraph('cherry'), paragraph('banana'), paragraph('apple')]);
    d.select(7, 13); d.addBookmark('Inside');
    d.select(0, d.text.length);
    expect(sortParagraphs(d)).toBe(true);
    expect(d.text).toBe('apple\nbanana\ncherry');
  });
});

describe('Change Case and Sort with Track Changes on', () => {
  const tracked = text => { const d = new TextDocument([paragraph(text)]); d.trackChanges = true; d.revisionAuthor = 'Me'; return d; };
  const changes = d => {
    const out = []; let at = 0;
    for (const p of d.paragraphs) for (const r of p.runs) { if (r.revision) out.push([r.revision.type, r.text]); at += r.text.length; }
    return out;
  };
  it('marks the old text deleted and the new text inserted, keeping each run\'s formatting', () => {
    const d = new TextDocument([paragraph('hello world')]);
    d.select(0, 5); d.toggleBold();
    d.trackChanges = true; d.revisionAuthor = 'Me';
    d.select(3, 8);
    expect(changeCase(d, 'upper')).toBe(true);
    expect(changes(d)).toEqual([['del', 'lo'], ['ins', 'LO'], ['del', ' wo'], ['ins', ' WO']]);
    expect(d.paragraphs[0].runs.filter(r => r.revision?.type === 'ins').map(r => !!r.bold)).toEqual([true, false]);
    expect(d.text).toBe('helloLO wo WOrld');
    // The selection covers the changed text, deletions and insertions.
    expect(d.range).toEqual([3, 13]);
    d.undo();
    expect(d.text).toBe('hello world');
    expect(changes(d)).toEqual([]);
  });
  it('changes the word at the caret and leaves the caret after it', () => {
    const d = tracked('one two');
    d.select(5);
    expect(changeCase(d, 'upper')).toBe(true);
    expect(changes(d)).toEqual([['del', 'two'], ['ins', 'TWO']]);
    expect(d.range).toEqual([10, 10]);
  });
  it('refuses Sort, which it could not show as a tracked change', () => {
    const d = new TextDocument([paragraph('b'), paragraph('a')]);
    d.trackChanges = true;
    d.select(0, d.text.length);
    expect(() => sortParagraphs(d)).toThrow(/Track Changes/);
    expect(d.text).toBe('b\na');
  });
});
