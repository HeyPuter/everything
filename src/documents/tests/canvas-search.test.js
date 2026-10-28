import { MAX_DOCUMENT_CHARACTERS } from '../src/engine/text-limits.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph, runFormat } from '../src/engine/model.js';
import { findText } from '../src/engine/search.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/find-replace.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const whole = { wholeWord: true };
const layout = doc => layoutDocument(doc.paragraphs, (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3 }), pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const sameParts = (a, b, except = []) => { expect(Object.keys(a)).toEqual(Object.keys(b)); for (const key of Object.keys(a)) if (!except.includes(key)) expect(Buffer.from(a[key]).equals(Buffer.from(b[key])), key).toBe(true); };
const find = (text, query, options) => findText([paragraph(text)], query, options).map(m => [m.start, m.end]);
const formatted = doc => doc.paragraphs.map(p => p.runs.flatMap(r => Array.from(r.text, c => [c, runFormat(r), r.link?.target || r.link?.anchor])));

it('finds literal source text across run styles and table cells, counting repeated headers once without editing', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), before = doc.snapshot();
  expect(doc.findMatches('needle')).toHaveLength(15); expect(doc.findMatches('needle', whole)).toHaveLength(14);
  expect(doc.findMatches('needle', { ...whole, matchCase: true })).toHaveLength(13);
  expect(doc.findMatches('needle header')).toHaveLength(1); expect(layout(doc).repeatedLines.length).toBeGreaterThan(0);
  expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('treats regular-expression syntax and case folding as literal text with nonoverlapping matches', () => {
  expect(find('[a+b] [A+B] . $&', '[a+b]')).toEqual([[0, 5], [6, 11]]);
  expect(find('[a+b] [A+B]', '[a+b]', { matchCase: true })).toEqual([[0, 5]]);
  expect(find('aaaaa', 'aa')).toEqual([[0, 2], [2, 4]]);
  expect(find('x $& y', '$&')).toEqual([[2, 4]]);
  expect(find('K K k', 'k')).toEqual([[0, 1], [2, 3], [4, 5]]);
  expect(find('straße STRASSE', 'STRASSE')).toEqual([[7, 14]]);
});

it('uses whole-word boundaries and retries overlapping candidates rejected by a boundary', () => {
  expect(find('cat scatter cat-cat', 'cat', whole)).toEqual([[0, 3], [12, 15], [16, 19]]);
  expect(find("can't can canary", 'can', whole)).toEqual([[6, 9]]);
  expect(find('xa a a', 'a a', whole)).toEqual([[3, 6]]);
  expect(find('!', '!', whole)).toEqual([]);
  // A query may start or end with punctuation; its ends still stand apart from the words around it.
  const text = 'Acme Inc. sells C++ for $100 in the U.S. and Inc.x too; cats. U.S.A.';
  expect(find(text, 'Inc.', whole)).toEqual([[5, 9]]);
  expect(find(text, 'C++', whole)).toEqual([[16, 19]]);
  expect(find(text, '$100', whole)).toEqual([[24, 28]]);
  expect(find(text, 'U.S.', whole)).toEqual([[36, 40]]);
  expect(find(text, 'cats.', whole)).toEqual([[56, 61]]);
  expect(find(text, 'sells C++', whole)).toEqual([[10, 19]]);
  expect(find(text, 'cat', whole)).toEqual([]);
});

it('keeps combining sequences, emoji modifiers and joined emoji intact, without canonical normalization', () => {
  expect(find('Á A 😀 👍🏽 👩‍💻', 'A')).toEqual([[3, 4]]);
  expect(find('Á A 😀 👍🏽 👩‍💻', 'Á')).toEqual([[0, 2]]);
  expect(find('👍🏽 👍', '👍')).toEqual([[5, 7]]);
  expect(find('👩‍💻 👩', '👩')).toEqual([[6, 8]]);
  expect(find('café café', 'café')).toEqual([[0, 4]]);
  expect(find('café café', 'café')).toEqual([[5, 10]]);
});

it('does not join paragraphs, tabs, manual breaks or inline pictures when finding text', () => {
  const paragraphs = [paragraph('nee'), paragraph('dle nee\tdle nee\vdle nee\fdle nee\ufffcdle')];
  expect(findText(paragraphs, 'needle')).toEqual([]);
  expect(findText(paragraphs, '')).toEqual([]);
});

it('searches document-sized literals and long near-misses without regex compiler limits or rescanning every prefix', () => {
  const text = 'a'.repeat(100000);
  expect(find(text, text)).toEqual([[0, 100000]]);
  expect(find(text, 'a'.repeat(50000) + 'b')).toEqual([]);
});

it('replaces one selected match using its first character formatting, with literal replacement and undo/redo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), first = doc.findMatches('needle')[0];
  doc.select(first.start, first.end); const before = doc.snapshot(); expect(doc.replaceMatches('needle', '$&')).toBe(1);
  expect(doc.paragraphs[1].runs[0]).toMatchObject({ text: '$&', bold: true, italic: false });
  expect(doc.paragraphs[1].runs.at(-1).text).toBe(' in rich text');
  doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts); doc.redo(); expect(doc.text).toContain('$& in rich text');
});

it('replaces all original matches once in one transaction while preserving inheritance, links, bookmarks and package parts', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); doc.select(12, 3); const before = doc.snapshot();
  expect(doc.replaceMatches('needle', 'thread', whole, true)).toBe(14); expect(doc.history).toHaveLength(1);
  expect(doc.findMatches('needle', whole)).toHaveLength(0); expect(doc.findMatches('needles')).toHaveLength(1);
  expect(doc.paragraphs[3].runs[0].bold).toBe(true); expect(doc.paragraphs[4].runs[0].link.target).toBe('https://example.org/resource');
  const bookmark = doc.bookmarks[0]; expect(doc.text.slice(bookmark.start, bookmark.end)).toBe('thread');
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes)); expect(reopened.text).toBe(doc.text);
  expect(formatted(reopened)).toEqual(formatted(doc));
  expectBodyEditParts(unzipSync(bytes), pkg.parts);
  reopened.editParagraphStyle('SearchBase', { run: { italic: true } }); expect(reopened.paragraphs[3].runs.every(r => r.italic)).toBe(true);
  doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts); doc.redo(); expect(doc.findMatches('thread', whole)).toHaveLength(14);
});

it('maps overlapping and point bookmarks like ordinary replacements even when many matches change length', async () => {
  const pkg = await DocxPackage.open(source), batch = model(pkg), ordinary = model(pkg);
  for (const doc of [batch, ordinary]) {
    doc.select(doc.text.indexOf('Needle') + 2, doc.text.indexOf('needles') + 3); doc.addBookmark('Overlap');
    doc.select(doc.text.indexOf('Needle') + 3); doc.addBookmark('Point');
  }
  const matches = ordinary.findMatches('needle', whole);
  for (const m of [...matches].reverse()) { ordinary.select(m.start, m.end); ordinary.replace('longer thread'); }
  batch.replaceMatches('needle', 'longer thread', whole, true);
  expect(batch.text).toBe(ordinary.text);
  expect(batch.bookmarks.map(({ name, start, end }) => ({ name, start, end }))).toEqual(ordinary.bookmarks.map(({ name, start, end }) => ({ name, start, end })));
  expect(formatted(batch)).toEqual(formatted(ordinary));
});

it('clears a hyperlink when a replacement spans linked and unlinked text, retaining untouched link fragments', async () => {
  const doc = model(await DocxPackage.open(source)), p = doc.paragraphs[4]; p.runs.push({ ...p.runs[0], text: ' outside', link: undefined });
  expect(doc.replaceMatches('link outside', 'replacement', {}, true)).toBe(1);
  expect(doc.paragraphs[4].runs[0].link).toBeDefined(); expect(doc.paragraphs[4].runs.at(-1).link).toBeUndefined();
});

it('retains no-op redo and refuses to replace a stale or partial selection', async () => {
  const doc = model(await DocxPackage.open(source)); doc.replaceMatches('needle', 'thread', whole, true); doc.undo();
  const before = doc.snapshot(); expect(doc.replaceMatches('needle', 'needle', { matchCase: true }, true)).toBe(0);
  expect(doc.replaceMatches('needle', 'thread')).toBe(0); expect(doc.replaceMatches('', 'thread', {}, true)).toBe(0);
  expect(doc.snapshot()).toEqual(before); expect(doc.future).toHaveLength(1);
});

it('does not recursively replace inserted matches and handles deletion and thousands of matches in one undo step', () => {
  const doc = new TextDocument([paragraph('foo '.repeat(4000))]);
  expect(doc.replaceMatches('foo', 'foofoo', {}, true)).toBe(4000); expect(doc.text).toBe('foofoo '.repeat(4000)); expect(doc.history).toHaveLength(1);
  expect(doc.replaceMatches('foofoo', '', {}, true)).toBe(4000); expect(doc.text).toBe(' '.repeat(4000)); doc.undo(); doc.undo(); expect(doc.text).toBe('foo '.repeat(4000));
});

it('repaginates expanded table text and retains selection, caret and repeated-header hit geometry', async () => {
  const doc = model(await DocxPackage.open(source)), before = layout(doc);
  doc.replaceMatches('Flowing', 'Many more flowing words that fill the cell', {}, true); const after = layout(doc); expect(after.pageCount).toBeGreaterThan(before.pageCount);
  const match = doc.findMatches('flowing words')[0]; doc.select(match.start, match.end); const caret = caretRect(after, match.start);
  expect(hitTest(after, caret.page, caret.x, caret.y + caret.height / 2)).toBe(match.start); expect(selectionRects(after, match.start, match.end).length).toBeGreaterThan(0);
  const header = after.repeatedLines.find(l => l.fragments.some(f => f.text.includes('needle'))); expect(header).toBeDefined(); expect(hitTest(after, header.page, header.stops[0].x, header.y + header.height / 2)).toBe(header.start);
  doc.undo(); expect(layout(doc)).toEqual(before);
});

it.each(['a\nb', '\t', '\v', '\f', '\ufffc', '\ud800', '\u0000', '\ufffe', '\uffff'])('rejects structural or malformed find/replacement text atomically: %j', async text => {
  const doc = model(await DocxPackage.open(source)), before = doc.snapshot();
  expect(() => doc.findMatches(text)).toThrow(); expect(() => doc.replaceMatches('needle', text, {}, true)).toThrow();
  expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
});

it('saves significant replacement spaces and deletions without losing paragraph marks or bookmark pairs', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.replaceMatches('needle', ' padded ', whole, true);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.text).toBe(doc.text);
  const mark = reopened.bookmarks[0]; expect(reopened.text.slice(mark.start, mark.end)).toBe(' padded ');
  reopened.replaceMatches(' padded ', '', {}, true);
  expect(reopened.paragraphs).toHaveLength(doc.paragraphs.length); expect(reopened.bookmarks[0].start).toBe(reopened.bookmarks[0].end);
  const deleted = model(await DocxPackage.open(await save(pkg, reopened))); expect(deleted.text).toBe(reopened.text); expect(deleted.bookmarks).toHaveLength(1);
});

it('rolls back before recording history when a later replacement violates formatting or document size limits', () => {
  const doc = new TextDocument([paragraph('a'), paragraph('a', { runs: [{ text: 'a', capitalization: 'caps', characterSpacing: 1 }] })]), before = doc.snapshot();
  expect(() => doc.replaceMatches('a', 'ß', {}, true)).toThrow(/uppercase/); expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  expect(() => doc.replaceMatches('a', 'x'.repeat(MAX_DOCUMENT_CHARACTERS / 2 + 1), {}, true)).toThrow(/5,000,000/); expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
});

it('finds the same matches in plain Latin text by comparing characters directly, and quickly in a long document', () => {
  // Plain Latin text has a character boundary between every two characters and lowercases letter for letter, so it
  // is searched without segmenting it; text with anything else (here a mathematical letter after it) is not.
  const letters = ['a', 'A', 'b', 'B', 'à', 'À', 'ß', 'é', 'É', ' ', ' ', '\t', '-', '.', 'x', "'"];
  let seed = 11; const random = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let round = 0; round < 300; round++) {
    const text = Array.from({ length: 1 + random(40) }, () => letters[random(letters.length)]).join('');
    const from = random(text.length), query = [...text.slice(from, from + 1 + random(4))].map(c => random(2) ? c.toUpperCase() : c).join('');
    for (const options of [{}, { matchCase: true }, { wholeWord: true }, { wholeWord: true, matchCase: true }]) {
      const reference = findText([paragraph(`${text} \u{1D4B3}`)], query, options).filter(m => m.end <= text.length);
      expect(findText([paragraph(text)], query, options), JSON.stringify([text, query, options])).toEqual(reference);
    }
  }
  expect(find('aaaaa', 'AA')).toEqual([[0, 2], [2, 4]]);
  // Overlapping candidates stay linear: half a long run of one letter, looked for in it.
  expect(find('a'.repeat(100000), 'a'.repeat(50000))).toEqual([[0, 50000], [50000, 100000]]);
  const long = Array.from({ length: 600 }, (_, i) => paragraph(`P${i} ${'Every page is another chance to make the editor a little better. '.repeat(12)}`));
  const started = performance.now();
  for (let i = 0; i < 10; i++) expect(findText(long, 'the')).toHaveLength(14400);
  expect(performance.now() - started).toBeLessThan(250);
});
