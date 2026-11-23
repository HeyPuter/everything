import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { listKind, listMarkers } from '../src/engine/numbering.js';

it('keeps the nesting of a list switched between bullets and numbers', () => {
  const doc = new TextDocument(['top', 'sub', 'subsub', 'top2'].map(text => paragraph(text)));
  doc.select(0, doc.text.length); doc.toggleList('bullet');
  doc.select(doc.paragraphOffset(1)); doc.changeListLevel(1);
  doc.select(doc.paragraphOffset(2)); doc.changeListLevel(1); doc.changeListLevel(1);
  const levels = () => doc.paragraphs.map(p => p.list?.level ?? null);
  expect(levels()).toEqual([0, 1, 2, 0]);
  doc.select(0, doc.text.length); doc.toggleList('number');
  expect(levels()).toEqual([0, 1, 2, 0]);
  expect(doc.paragraphs.every(p => listKind(doc.numbering, p.list) === 'number')).toBe(true);
  expect(listMarkers(doc.paragraphs, doc.numbering).map(m => m.text)).toEqual(['1.', '1.1.', '1.1.1.', '2.']);
  doc.toggleList('bullet');
  expect(levels()).toEqual([0, 1, 2, 0]);
  doc.undo(); doc.undo();
  expect(doc.paragraphs.every(p => listKind(doc.numbering, p.list) === 'bullet')).toBe(true);
  expect(levels()).toEqual([0, 1, 2, 0]);
});
