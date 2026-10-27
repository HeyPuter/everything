import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, locate } from '../src/engine/model.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => dom.window.close());

function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return doc;
}
// Headings, lists, links, alignment, colours and empty paragraphs, as an import or a web page brings them.
const blocks = n => Array.from({ length: n }, (_, i) => [
  `<h${1 + i % 3}>Heading ${i}</h${1 + i % 3}>`,
  `<p>Paragraph ${i} with <b>bold</b>, <i>italic</i> and <a href="https://example.com/${i}">a link</a>.</p>`,
  `<ul><li>Item ${i}</li><li>Nested <u>${i}</u><ul><li>Deeper 😀 ${i}</li></ul></li></ul>`,
  `<ol><li>First ${i}</li><li>Second ${i}</li></ol>`,
  `<p style="text-align:center"><span style="color:#ff0000;font-size:18pt">Centred ${i}</span></p>`,
  '<p></p>',
][i % 6]).join('');
const imported = n => { const fragment = htmlFragment(blocks(n)); for (const p of fragment.paragraphs) p.mark = true; return fragment; };
// Everything but the generated ids, which differ between runs.
const state = doc => JSON.stringify({ paragraphs: doc.paragraphs, numbering: doc.numbering, selection: doc.selection, text: doc.text }).replace(/"(id|hyperlinkId|date)":"[^"]*"/g, '');

/** How many times the document's paragraphs are read while `action` runs. */
function paragraphReads(doc, action) {
  let reads = 0, array = doc.paragraphs, proxy = null;
  const counted = list => new Proxy(list, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  Object.defineProperty(doc, 'paragraphs', { configurable: true, get: () => proxy?.target === array ? proxy.value : (proxy = { target: array, value: counted(array) }).value, set: value => { array = value; } });
  // Undo snapshots copy the document, which a counting proxy cannot be; the paste makes none of its own.
  doc.checkpoint = () => {};
  try { action(); } finally { delete doc.paragraphs; doc.paragraphs = array; delete doc.checkpoint; }
  return reads;
}

it('a formatted paste reads each paragraph a bounded number of times, however long it is', () => {
  const reads = n => { const doc = documentWith(['']); return paragraphReads(doc, () => pasteFragment(doc, imported(n))) / htmlFragment(blocks(n)).paragraphs.length; };
  const short = reads(60), long = reads(600);
  // Per pasted paragraph, a paste ten times as long reads about as much: each command no longer counts
  // through the whole document to find its place.
  expect(long).toBeLessThan(short * 1.5);
  expect(long).toBeLessThan(150);
});

it('a formatted paste gives the same document as commands that read the whole text each time', () => {
  for (const [lines, at, tracked] of [[[''], 0, false], [['Before text here.', 'After.'], 7, false], [['One', 'Two three'], 9, true]]) {
    const pasted = documentWith(lines), plain = documentWith(lines);
    for (const doc of [pasted, plain]) { doc.trackChanges = tracked; doc.select(at); }
    // The second document runs every command as before: no fixed text to find positions in.
    plain.withFixedText = action => action();
    expect(pasteFragment(pasted, imported(30))).toBe(true);
    expect(pasteFragment(plain, imported(30))).toBe(true);
    expect(state(pasted)).toBe(state(plain));
    expect(pasted.paragraphs.some(p => p.list)).toBe(true);
    expect(pasted.paragraphs.some(p => p.runs.some(r => r.bold))).toBe(true);
  }
});

it('finds every position\'s paragraph from the fixed text as locate() does', () => {
  const doc = documentWith(['', 'Alpha', '', 'Beta gamma', 'é😀', '']);
  const length = doc.text.length;
  doc.withFixedText(() => {
    for (let at = -2; at <= length + 3; at++) expect(doc.locate(at), `position ${at}`).toEqual(locate(doc.paragraphs, at));
  });
  expect(doc.fixedText).toBe(null);
});
