import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { advancedFind, replaceAdvanced, compileQuery, expandReplacement, describeFormat } from '../src/engine/advanced-search.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
const find = (doc, query, options = {}) => advancedFind(doc.paragraphs, query, options, { styles: doc.styles, numbering: doc.numbering });
const texts = matches => matches.map(m => m.text);

it('finds special characters, digits, letters and paragraph marks', () => {
  const { doc } = documentWith(['Item\t42 apples', 'Second line']);
  expect(texts(find(doc, '^t'))).toEqual(['\t']);
  expect(texts(find(doc, '^#^#'))).toEqual(['42']);
  expect(texts(find(doc, 'apples^pSecond'))).toEqual(['apples\nSecond']);
  expect(texts(find(doc, 'S^?cond'))).toEqual(['Second']);
  expect(texts(find(doc, '^$^$^$^$', { matchCase: true }))).toEqual(['Item', 'appl', 'Seco', 'line']);
  expect(() => find(doc, '^q')).toThrow(/special character/);
});

it('supports prefix, suffix, whole words and ignoring punctuation or white space', () => {
  const { doc } = documentWith(['preview review reviewer re-view']);
  expect(texts(find(doc, 'view'))).toHaveLength(4);
  expect(texts(find(doc, 'view', { matchSuffix: true }))).toEqual(['view', 'view', 'view']);
  expect(texts(find(doc, 'review', { matchPrefix: true }))).toEqual(['review', 'review']);
  expect(texts(find(doc, 'review', { wholeWord: true }))).toEqual(['review']);
  expect(texts(find(doc, 'review', { wholeWord: true, ignorePunctuation: true }))).toEqual(['review', 're-view']);
  const spaced = documentWith(['data base and database']).doc;
  expect(texts(find(spaced, 'database', { ignoreWhitespace: true }))).toEqual(['data base', 'database']);
});

it('matches the documented wildcard subset case-sensitively', () => {
  const { doc } = documentWith(['cat cot cut Cat coat 2024-10-13 color colour']);
  expect(texts(find(doc, 'c?t', { wildcards: true }))).toEqual(['cat', 'cot', 'cut']);
  expect(texts(find(doc, 'c[ao]t', { wildcards: true }))).toEqual(['cat', 'cot']);
  expect(texts(find(doc, 'c[!a]t', { wildcards: true }))).toEqual(['cot', 'cut']);
  expect(texts(find(doc, '<c*t>', { wildcards: true }))).toEqual(['cat', 'cot', 'cut', 'coat']);
  expect(texts(find(doc, '[0-9]{4}-[0-9]{2}-[0-9]{2}', { wildcards: true }))).toEqual(['2024-10-13']);
  expect(texts(find(doc, 'colo@r', { wildcards: true }))).toEqual(['color']);
  expect(texts(find(doc, 'colo[u]{0,1}r', { wildcards: true }))).toEqual(['color', 'colour']);
  expect(() => compileQuery('[abc', { wildcards: true })).toThrow(/closed/);
  expect(() => compileQuery('{2}', { wildcards: true })).toThrow(/\{n\}/);
});

it('finds formatting with or without text and replaces with formatting in one undo step', async () => {
  const { pkg, doc } = documentWith(['Plain bold plain bold', 'Heading text']);
  let at = doc.text.indexOf('bold'); doc.select(at, at + 4); doc.setRunFormat({ bold: true });
  at = doc.text.lastIndexOf('bold'); doc.select(at, at + 4); doc.setRunFormat({ bold: true });
  expect(texts(find(doc, '', { format: { bold: true } }))).toEqual(['bold', 'bold']);
  expect(texts(find(doc, 'plain', { format: { bold: true } }))).toEqual([]);
  expect(texts(find(doc, 'bold', { format: { bold: false } }))).toEqual([]);
  doc.select(doc.text.indexOf('Heading')); doc.setParagraphStyle('Title');
  expect(texts(find(doc, 'text', { format: { paragraphStyle: 'Title' } }))).toEqual(['text']);
  expect(describeFormat({ bold: true, paragraphStyle: 'Title' })).toBe('Bold, Style: Title');
  // Empty replacement with formatting: keep the text, change its formatting.
  const matches = find(doc, '', { format: { bold: true } });
  const historyBefore = doc.history.length;
  expect(replaceAdvanced(doc, matches, '', { format: { bold: false, italic: true, color: 'C00000' } })).toBe(2);
  expect(doc.history.length).toBe(historyBefore + 1);
  expect(texts(find(doc, '', { format: { italic: true } }))).toEqual(['bold', 'bold']);
  expect(find(doc, '', { format: { bold: true } })).toEqual([]);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const xml = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['word/document.xml']);
  expect(xml).toMatch(/<w:i w:val="1"\/>[\s\S]*<w:color w:val="C00000"\/>[\s\S]*bold/);
  doc.undo();
  expect(texts(find(doc, '', { format: { bold: true } }))).toEqual(['bold', 'bold']);
});

it('replaces with special characters, found text and wildcard groups', async () => {
  const { pkg, doc } = documentWith(['Smith, John; Doe, Jane']);
  const matches = find(doc, '([A-Z][a-z]@), ([A-Z][a-z]@)', { wildcards: true });
  expect(texts(matches)).toEqual(['Smith, John', 'Doe, Jane']);
  expect(replaceAdvanced(doc, matches, '\\2 \\1', { wildcards: true })).toBe(2);
  expect(doc.text).toBe('John Smith; Jane Doe');
  expect(replaceAdvanced(doc, find(doc, '; '), '^p')).toBe(1);
  expect(doc.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['John Smith', 'Jane Doe']);
  expect(replaceAdvanced(doc, find(doc, 'Jane'), '[^&]^tx')).toBe(1);
  expect(doc.text).toBe('John Smith\n[Jane]\tx Doe');
  expect(expandReplacement('^^', { text: '' })).toBe('^');
  expect(() => expandReplacement('^?', { text: '' })).toThrow(/replacement/);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  expect(reopened.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['John Smith', '[Jane]\tx Doe']);
});

it('limits a search to the selection', () => {
  const { doc } = documentWith(['one two one two one']);
  expect(find(doc, 'one', { within: [4, 15] }).map(m => m.start)).toEqual([8]);
});

it('finds many matches in one long paragraph in linear time, still never splitting a grapheme', () => {
  const doc = new TextDocument([paragraph('ab '.repeat(9000) + 'aé')]);
  const started = performance.now();
  expect(find(doc, 'ab')).toHaveLength(9000);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(texts(find(doc, 'ae'))).toEqual([]);
  expect(texts(find(doc, 'ae^?'))).toEqual(['aé']);
});

it('never matches across a table boundary, and adds no undo step when nothing is replaced', () => {
  const doc = new TextDocument([paragraph('before')]);
  doc.select(6); doc.insertTable(1, 2);
  const t = doc.tables[0];
  doc.selectCell(t.rows[0].cells[0].id); doc.replace('c1');
  doc.selectCell(t.rows[0].cells[1].id); doc.replace('c2');
  const cells = () => doc.paragraphs.map(p => [p.cellId ? 'cell' : 'body', p.runs.map(r => r.text).join('')]);
  const before = cells();
  // The marks at the end of a cell and between the body and the table are not paragraph marks to search.
  expect(texts(find(doc, '1^pc'))).toEqual([]);
  expect(find(doc, '^p').every(m => doc.paragraphs[m.paragraph].cellId === null)).toBe(true);
  expect(replaceAdvanced(doc, find(doc, '1^pc'), 'X')).toBe(0);
  const history = doc.history.length;
  expect(replaceAdvanced(doc, find(doc, 'c^p'), '')).toBe(0);
  expect(doc.history.length).toBe(history);
  expect(cells()).toEqual(before);
});

it('does not take a paragraph mark for white space to ignore', () => {
  const { doc } = documentWith(['foo', 'bar', 'foo  bar', 'foo\tbar']);
  expect(texts(find(doc, 'foo bar', { ignoreWhitespace: true }))).toEqual(['foo  bar', 'foo\tbar']);
});

it('replaces thousands of matches across a long document in linear time', () => {
  const pkg = createDocx(Array.from({ length: 3000 }, (_, i) => paragraph(`Order ${i} ships in ${i % 9 + 1} days.`)), undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const started = performance.now();
  // A wildcard group and a paragraph break in the replacement.
  expect(doc.replaceMatches('in ([0-9]) days', '\\1 days^pfrom stock', { advanced: true, wildcards: true }, true)).toBe(3000);
  // Each replacement walked the whole document several times, so this took about twenty seconds.
  expect(performance.now() - started).toBeLessThan(12000);
  expect(doc.paragraphs).toHaveLength(6000);
  expect(doc.text.split('\n').slice(-2)).toEqual(['Order 2999 ships 3 days', 'from stock.']);
  expect(doc.undo()).toBe(true);
  expect(doc.text.split('\n').at(-1)).toBe('Order 2999 ships in 3 days.');
}, 120000);

it('takes only pictures for ^g, and never a field, equation or note reference in any pattern', () => {
  const doc = new TextDocument();
  doc.replace('Total pages: ');
  doc.select(doc.text.length); doc.insertFieldRun({ type: 'NUMPAGES', instruction: 'NUMPAGES' });
  doc.select(doc.text.length); doc.replace('. E=mc'); doc.select(doc.text.length); doc.insertMathRun({ xml: '<m:oMath/>', text: 'x²' });
  doc.select(doc.text.length); doc.replace(' cited'); doc.insertFootnoteReference('3', 'footnote'); doc.select(doc.text.length); doc.replace('.');
  const objects = () => doc.paragraphs[0].runs.filter(r => r.field || r.math || r.noteMark).length;
  expect(objects()).toBe(3);
  expect(find(doc, '^g')).toEqual([]);
  expect(find(doc, 'cited^?')).toEqual([]);
  expect(find(doc, 'pages: ?.', { wildcards: true })).toEqual([]);
  expect(doc.replaceMatches('^g', '', { advanced: true }, true)).toBe(0);
  expect(doc.replaceMatches('cited^?', 'quoted', { advanced: true }, true)).toBe(0);
  expect(objects()).toBe(3);
  // A picture is still found.
  const picture = [{ id: 'p1', runs: [{ text: 'See ' }, { text: '￼', image: { assetId: 'a', id: 1 } }, { text: ' here' }] }];
  expect(advancedFind(picture, '^g').map(m => m.start)).toEqual([4]);
  expect(advancedFind(picture, 'See ^?').map(m => m.text)).toEqual(['See ￼']);
});

it('does not take a section break for a paragraph mark', () => {
  const { doc } = documentWith(['First section.', 'Second section.']);
  doc.paragraphs[0].sectionEnd = { ...doc.pageSettings, orientation: 'landscape' };
  expect(find(doc, '^p')).toEqual([]);
  expect(find(doc, 'section.^pSecond')).toEqual([]);
  expect(doc.replaceMatches('^p', ' ', { advanced: true }, true)).toBe(0);
  expect(doc.paragraphs).toHaveLength(2);
  expect(doc.paragraphs[0].sectionEnd).toBeTruthy();
});
