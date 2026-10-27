import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { revisionRanges } from '../src/engine/revisions.js';

// Accepting or rejecting one tracked change joined the runs of every paragraph of the document, not only
// the ones the change reached: each was then a changed paragraph, which the layout measured again.
const by = (type, author) => ({ type, author, date: '2026-01-01T00:00:00Z' });
const reviewed = i => paragraph('', { runs: [{ text: `Paragraph ${i} ` }, { text: 'in two runs ' },
  { text: i % 2 ? 'inserted' : 'deleted', revision: by(i % 2 ? 'ins' : 'del', i % 3 ? 'Ann' : 'Bob') }, { text: ' end' }, { text: '.' }] });

for (const accept of [true, false]) it(`joins only the resolved change's paragraph's runs (${accept ? 'Accept' : 'Reject'})`, () => {
  const doc = new TextDocument(Array.from({ length: 8 }, (_, i) => reviewed(i)));
  const before = doc.paragraphs.map(p => p.runs);
  const change = revisionRanges(doc.paragraphs).find(r => r.type === 'ins' && doc.text.slice(r.start - 25, r.start).includes('Paragraph 3 '));
  doc.select(change.start); expect(doc.resolveRevisions(accept, change.start, change.end)).toBe(true);
  const resolved = doc.paragraphs[3];
  expect(resolved.runs.map(r => [r.text, r.revision?.type ?? null])).toEqual(accept ? [['Paragraph 3 in two runs inserted end.', null]] : [['Paragraph 3 in two runs  end.', null]]);
  // Every other paragraph keeps its runs, and its changes, as they were.
  doc.paragraphs.forEach((p, i) => { if (i !== 3) expect(p.runs).toBe(before[i]); });
  expect(revisionRanges(doc.paragraphs)).toHaveLength(7);
  expect(doc.selection).toEqual({ anchor: change.start, focus: change.start });
  doc.undo();
  expect(revisionRanges(doc.paragraphs)).toHaveLength(8);
});

it('joins the runs of every paragraph whose changes a resolved range reaches', () => {
  const doc = new TextDocument(Array.from({ length: 6 }, (_, i) => reviewed(i)));
  const before = doc.paragraphs.map(p => p.runs);
  // From paragraph 1 into the middle of paragraph 3's insertion.
  const from = doc.text.indexOf('Paragraph 1 '), to = doc.text.indexOf('inserted', doc.text.indexOf('Paragraph 3 ')) + 3;
  doc.resolveRevisions(true, from, to);
  expect(doc.paragraphs.slice(1, 4).map(p => p.runs.map(r => [r.text, r.revision?.type ?? null]))).toEqual([
    [['Paragraph 1 in two runs inserted end.', null]], [['Paragraph 2 in two runs  end.', null]],
    [['Paragraph 3 in two runs ins', null], ['erted', 'ins'], [' end.', null]]]);
  for (const i of [0, 4, 5]) expect(doc.paragraphs[i].runs).toBe(before[i]);
});
