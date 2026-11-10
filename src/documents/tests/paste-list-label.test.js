import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';
import { showLink, LINK_COLOR } from '../src/engine/link-appearance.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => dom.window.close());

function bulletItem() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.toggleList('bullet');
  return doc;
}
// A list label is painted with the paragraph mark's format (list-layout.js markerGeometry).
const mark = p => ({ color: p.markFormat?.color ?? 'auto', underlineStyle: p.markFormat?.underlineStyle ?? 'none', bold: !!p.markFormat?.bold });
const plain = { color: 'auto', underlineStyle: 'none', bold: false };

it('pastes a link into a list item without coloring or underlining the list label', () => {
  // As a browser or Google Docs copies a link: with its own color and underline, and without them.
  for (const html of ['<a href="https://example.com/" style="color:#1155cc;text-decoration:underline">gpt image tutorial</a>', '<a href="https://example.com/">gpt image tutorial</a>']) {
    const doc = bulletItem();
    expect(pasteFragment(doc, htmlFragment(html))).toBe(true);
    const p = doc.paragraphs[0];
    expect(p.list).toBeTruthy();
    expect(p.runs.map(r => r.text).join('')).toBe('gpt image tutorial');
    expect(p.runs.every(r => r.link && r.underlineStyle === 'single' && r.color !== 'auto')).toBe(true);
    expect(mark(p)).toEqual(plain);
    // The next item starts plain too.
    doc.insertParagraph(); doc.replace('next');
    expect(doc.paragraphs[1].runs.every(r => !r.link && (r.underlineStyle ?? 'none') === 'none' && (r.color ?? 'auto') === 'auto')).toBe(true);
  }
});

it('keeps other pasted formatting off the list label', () => {
  const doc = bulletItem();
  pasteFragment(doc, htmlFragment('<b style="color:#ff0000">Bold red</b>'));
  expect(doc.paragraphs[0].runs.every(r => r.bold && r.color === 'FF0000')).toBe(true);
  expect(mark(doc.paragraphs[0])).toEqual(plain);
});

it('gives a new link over a whole list item the link look without changing the label', () => {
  const doc = bulletItem();
  doc.replace('example.com');
  doc.select(0, 11);
  expect(doc.setHyperlink('https://example.com/')).toBe(true);
  showLink(doc);
  const p = doc.paragraphs[0];
  expect(p.runs.every(r => r.link && (r.styleId || r.color === LINK_COLOR && r.underlineStyle === 'single'))).toBe(true);
  expect(mark(p)).toEqual(plain);
  expect(p.markStyleId || null).toBeNull();
});

it('still formats the paragraph mark when the user formats all of a paragraph’s text', () => {
  const doc = bulletItem();
  doc.replace('Item');
  doc.select(0, 4);
  doc.setRunFormat({ bold: true });
  expect(mark(doc.paragraphs[0]).bold).toBe(true);
});
