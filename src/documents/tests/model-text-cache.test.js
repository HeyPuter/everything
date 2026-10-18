import { it, expect } from 'vitest';
import { TextDocument, paragraph, documentText, documentLength, paragraphLength, paragraphText } from '../src/engine/model.js';

it('keeps the joined text in step with every kind of edit, and reuses it while nothing changed', () => {
  const doc = new TextDocument([paragraph('Alpha beta'), paragraph('Gamma 😀 delta'), paragraph('')]);
  const check = () => expect(doc.text).toBe(documentText(doc.paragraphs));
  check();
  const first = doc.text;
  // Asked again with nothing changed, the same text comes back without joining the paragraphs again.
  expect(doc.text).toBe(first);
  doc.select(0, 5); doc.toggleBold(); check(); // runs split, text unchanged
  expect(doc.text).toBe(first);
  doc.select(6); doc.replace('new '); check();
  doc.select(doc.text.length); doc.replace('end'); check();
  doc.paragraphs[1].runs[0].text = 'Changed in place'; check();
  doc.paragraphs.splice(1, 1); check();
  doc.paragraphs.push(paragraph('Added')); check();
  doc.select(0, doc.text.length); doc.replace(''); check();
  doc.undo(); check();
  for (const p of doc.paragraphs) expect(paragraphLength(p)).toBe(paragraphText(p).length);
  expect(documentLength(doc.paragraphs)).toBe(doc.text.length);
  expect(documentLength([paragraph('')])).toBe(0);
});
