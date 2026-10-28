import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { copyFragment, fragmentHtml, htmlFragment, pasteFragment, carriesFormatting } from '../src/engine/clipboard-fragment.js';
import { mergedFragment, pastePayload, availablePasteModes } from '../src/engine/paste-modes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return doc;
}

function sourceHtml() {
  const source = documentWith(['Big red bold heading']);
  source.select(0); source.setParagraphStyle('Heading1');
  source.select(0, source.text.length); source.setRunFormat({ color: 'FF0000', fontSize: 20 });
  source.select(4, 7); source.setRunFormat({ italic: true });
  source.select(0, source.text.length + 1);
  return fragmentHtml(copyFragment(source));
}

it('keeps only emphasis when merging formatting and nothing when pasting text only', () => {
  const html = sourceHtml();
  const keep = documentWith(['Target: ']);
  keep.select(keep.text.length); pasteFragment(keep, htmlFragment(pastePayload('keep', { text: 'x', html }, fragmentHtml).html));
  const kept = keep.paragraphs.find(p => p.runs.some(r => r.text.includes('red')));
  expect(kept.runs.find(r => r.text.includes('red')).color).toBe('FF0000');

  const merge = documentWith(['Target: ']);
  merge.select(merge.text.length);
  const payload = pastePayload('merge', { text: 'Big red bold heading', html }, fragmentHtml);
  expect(pasteFragment(merge, htmlFragment(payload.html))).toBe(true);
  expect(merge.paragraphs).toHaveLength(1);
  expect(merge.text).toBe('Target: Big red bold heading');
  const runs = merge.paragraphs[0].runs;
  expect(runs.every(r => r.color === 'auto' && r.fontSize === 12)).toBe(true);
  expect(runs.find(r => r.text === 'red').italic).toBe(true);
  expect(merge.paragraphs[0].styleId ?? 'Normal').toBe('Normal');

  expect(pastePayload('text', { text: 'plain', html }, fragmentHtml)).toEqual({ text: 'plain', html: '' });
  expect(mergedFragment(null)).toBeNull();
  expect(availablePasteModes(merge, { html })).toEqual(['keep', 'merge', 'text']);
  expect(availablePasteModes(merge, { html: '' })).toEqual(['text']);
});

it('copies formatted text from within one table cell, but not a selection across cells or out of the table', () => {
  const doc = documentWith(['Before']);
  doc.insertTable(1, 2);
  doc.replace('Plain '); doc.setRunFormat({ bold: true }); doc.replace('bold');
  doc.insertParagraph(); doc.replace('Second');
  const text = doc.text, cellStart = text.indexOf('Plain');
  doc.select(cellStart, text.indexOf('Second') + 6);
  const fragment = copyFragment(doc);
  expect(fragment.paragraphs.map(p => p.text)).toEqual(['Plain bold', 'Second']);
  expect(fragment.paragraphs[0].runs.map(r => [r.text, r.format.bold])).toEqual([['Plain ', false], ['bold', true]]);
  // Pasted into the body, the bold word stays bold.
  const target = documentWith(['Target: ']);
  target.select(target.text.length);
  expect(pasteFragment(target, htmlFragment(fragmentHtml(fragment)))).toBe(true);
  expect(target.paragraphs[0].runs.map(r => [r.text, !!r.bold])).toEqual([['Target: Plain ', false], ['bold', true]]);
  // Into the next cell, or from the body into the table, the selection is not one cell's text.
  doc.select(cellStart, text.indexOf('Second') + 7);
  expect(copyFragment(doc)).toBeNull();
  doc.select(2, cellStart + 3);
  expect(copyFragment(doc)).toBeNull();
});

it('copies and pastes with formatting beside a footnote elsewhere in the document, but not over the note', () => {
  const doc = documentWith(['Plain bold here', 'Has a note']);
  doc.select(doc.text.length); doc.insertFootnoteReference('1', 'footnote');
  expect(doc.hasNoteMarks).toBe(true);
  doc.select(6, 10); doc.setRunFormat({ bold: true });
  // A word of the first paragraph copies with its formatting.
  doc.select(6, 10);
  const fragment = copyFragment(doc);
  expect(fragment.paragraphs[0].runs.map(r => [r.text, r.format.bold])).toEqual([['bold', true]]);
  // Pasted into the first paragraph, which holds no note, it keeps it.
  doc.select(15);
  expect(carriesFormatting(doc)).toBe(true);
  expect(pasteFragment(doc, htmlFragment(fragmentHtml(fragment)))).toBe(true);
  expect(doc.paragraphs[0].runs.map(r => [r.text, !!r.bold])).toEqual([['Plain ', false], ['bold', true], [' here', false], ['bold', true]]);
  // The paragraph holding the note, and a selection reaching the note, keep the plain-text path.
  const note = doc.text.indexOf('\ufffc');
  doc.select(note - 2);
  expect(carriesFormatting(doc)).toBe(false);
  doc.select(note - 4, note + 1);
  expect(copyFragment(doc)).toBeNull();
});
