import { it, expect } from 'vitest';
import { assignFootnotes } from '../src/engine/footnote-layout.js';

it('assigns each note to the page of its first reference, in reference order', () => {
  const lines = [
    { paragraphId: 'a', start: 0, end: 10, page: 0 }, { paragraphId: 'a', start: 10, end: 20, page: 1 },
    // Header lines and lines laid out only for measuring never take a note.
    { paragraphId: 'b', start: 21, end: 30, page: 0, pageStory: 'header1' }, { paragraphId: 'b', start: 21, end: 30, page: 1, virtual: true },
    { paragraphId: 'b', start: 21, end: 30, page: 2 },
  ];
  const refs = [{ id: '1', paragraphId: 'a', position: 9 }, { id: '2', paragraphId: 'a', position: 10 }, { id: '3', paragraphId: 'b', position: 30 }, { id: '1', paragraphId: 'b', position: 25 }, { id: '4', paragraphId: 'gone', position: 0 }];
  expect([...assignFootnotes({ lines }, refs)]).toEqual([[0, ['1']], [1, ['2']], [2, ['3']]]);
});

it('assigns thousands of references without scanning every line for each', () => {
  const lines = [], refs = [];
  for (let p = 0, at = 0; p < 8000; p++, at += 481) {
    for (let l = 0; l < 6; l++) lines.push({ paragraphId: `p${p}`, start: at + l * 80, end: at + (l + 1) * 80, page: Math.floor(p / 8) });
    refs.push({ id: String(p + 1), paragraphId: `p${p}`, position: at + 470 });
  }
  const started = performance.now(), pages = assignFootnotes({ lines }, refs);
  // A scan of every line per reference took about half a second here; an index of the paragraphs' lines takes a few milliseconds.
  expect(performance.now() - started).toBeLessThan(100);
  expect(pages.size).toBe(1000);
  expect(pages.get(999)).toEqual(['7993', '7994', '7995', '7996', '7997', '7998', '7999', '8000']);
});
