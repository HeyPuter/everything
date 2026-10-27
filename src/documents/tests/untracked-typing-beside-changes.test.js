import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';

// Typing untracked text beside a tracked change keeps the typed text out of that change. Doing so
// joined the runs of every paragraph in the document, not only the one typed in: each was then a
// changed paragraph, which the layout measured again on that keystroke.
const reviewed = i => paragraph('', { runs: [{ text: `Paragraph ${i} ` }, { text: 'in two runs ' }, { text: 'inserted', revision: { type: 'ins', author: 'A', date: '2026-01-01T00:00:00Z' } }, { text: ' end.' }] });

it('joins only the typed paragraph\'s runs when typing beside a tracked change', () => {
  const doc = new TextDocument(Array.from({ length: 6 }, (_, i) => reviewed(i)));
  const before = doc.paragraphs.map(p => p.runs);
  const second = doc.text.indexOf('Paragraph 2 '), at = doc.text.indexOf('inserted', second) + 'inserted'.length;
  doc.select(at); doc.replace('typed');
  const typed = doc.paragraphs[2];
  expect(typed.runs.map(r => [r.text, r.revision?.type ?? null])).toEqual([['Paragraph 2 in two runs ', null], ['inserted', 'ins'], ['typed', null], [' end.', null]]);
  // Every other paragraph keeps its runs as they were.
  doc.paragraphs.forEach((p, i) => { if (i !== 2) expect(p.runs).toBe(before[i]); });
  expect(doc.text).toContain('insertedtyped end.');
});
