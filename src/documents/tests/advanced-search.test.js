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
