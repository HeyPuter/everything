import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';
import { continueNumbering } from '../src/engine/list-definitions.js';

// Two numbered lists, the second with a paragraph that is no list item between its items.
function lists() {
  const doc = new TextDocument(['a1', 'a2', 'plain', 'b1', 'b2', 'gap', 'b3'].map(text => paragraph(text)));
  const at = i => doc.paragraphOffset(i);
  doc.select(at(0), at(1) + 2); doc.toggleList('number');
  doc.select(at(3), at(6) + 2); doc.toggleList('number');
  doc.select(at(5)); doc.toggleList('number');
  return { doc, at, labels: () => listMarkers(doc.paragraphs, doc.numbering).map(m => m?.text ?? '-').join(' ') };
}

it('continues the numbering of a list past a paragraph between its items', () => {
  const { doc, at, labels } = lists();
  expect(labels()).toBe('1. 2. - 1. 2. - 3.');
  doc.select(at(3)); expect(continueNumbering(doc)).toBe(true);
  expect(labels()).toBe('1. 2. - 3. 4. - 5.');
  doc.undo(); expect(labels()).toBe('1. 2. - 1. 2. - 3.');
});

it('restarts the whole rest of a list, so Continue Numbering takes all of it afterwards', () => {
  const { doc, at, labels } = lists();
  doc.select(at(4)); doc.restartNumbering(1);
  expect(labels()).toBe('1. 2. - 1. 1. - 2.');
  expect(new Set([4, 6].map(i => doc.paragraphs[i].list.numId)).size).toBe(1);
  doc.select(at(4)); expect(continueNumbering(doc)).toBe(true);
  expect(labels()).toBe('1. 2. - 1. 2. - 3.');
});
