import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { copyFragment, fragmentHtml, htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => dom.window.close());

function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return doc;
}
const shape = doc => doc.paragraphs.map(p => [p.runs.map(r => r.text).join(''), p.styleId || 'Normal']);
const copied = doc => htmlFragment(fragmentHtml(copyFragment(doc)));

function source() {
  const doc = documentWith(['Title', 'Body text', 'Closing heading']);
  doc.select(0); doc.setParagraphStyle('Heading1');
  doc.select(doc.text.length); doc.setParagraphStyle('Heading2');
  return doc;
}

it('carries the last paragraph’s mark in a Select All copy, so the paragraph keeps its formatting', () => {
  const doc = source();
  doc.select(0, doc.text.length);
  const fragment = copied(doc);
  expect(fragment.paragraphs.map(p => p.mark)).toEqual([true, true, true]);
  const target = documentWith(['']);
  expect(pasteFragment(target, fragment)).toBe(true);
  expect(shape(target)).toEqual([['Title', 'Heading1'], ['Body text', 'Normal'], ['Closing heading', 'Heading2']]);
  // Shift+Ctrl+End from inside an earlier paragraph takes the last mark too.
  doc.select(2, doc.text.length);
  expect(copyFragment(doc).paragraphs.at(-1).mark).toBe(true);
});

it('keeps text after the caret in its own paragraph when a whole-document copy is pasted mid-paragraph', () => {
  const doc = source();
  doc.select(0, doc.text.length);
  const target = documentWith(['abcdef']);
  target.select(3);
  pasteFragment(target, copied(doc));
  expect(shape(target)).toEqual([['abcTitle', 'Heading1'], ['Body text', 'Normal'], ['Closing heading', 'Heading2'], ['def', 'Normal']]);
  expect(target.selection.focus).toBe(target.text.indexOf('def'));
  // At a paragraph's end no empty paragraph is left behind.
  const atEnd = documentWith(['abc']);
  atEnd.select(3);
  pasteFragment(atEnd, copied(doc));
  expect(shape(atEnd)).toEqual([['abcTitle', 'Heading1'], ['Body text', 'Normal'], ['Closing heading', 'Heading2']]);
});

it('leaves the mark out of part of the last paragraph', () => {
  const doc = source();
  // The last word, double-clicked, or the last paragraph's text alone in a longer document.
  doc.select(doc.text.length - 7, doc.text.length);
  expect(copyFragment(doc).paragraphs.map(p => p.mark)).toEqual([false]);
  doc.select(doc.text.lastIndexOf('Closing'), doc.text.length);
  expect(copyFragment(doc).paragraphs.map(p => p.mark)).toEqual([false]);
  const target = documentWith(['abcdef']);
  target.select(3);
  pasteFragment(target, copied(doc));
  expect(shape(target)).toEqual([['abcClosing headingdef', 'Normal']]);
});
