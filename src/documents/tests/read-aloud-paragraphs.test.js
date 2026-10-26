import { describe, it, expect } from 'vitest';
import { speakableParagraphs } from '../src/views/read-aloud.js';

const run = (text, revision) => ({ text, ...(revision ? { revision: { type: revision, author: 'A', date: '2026-01-01T00:00:00Z' } } : {}) });

describe('speakableParagraphs', () => {
  const paragraphs = [{ runs: [run('Keep '), run('old ', 'del'), run('new ', 'ins'), run('word￼.')] }, { runs: [run('  ')] }, { runs: [run('Last')] }];
  it('leaves out deleted text and maps every spoken character to its document position', () => {
    const [first, last, ...rest] = speakableParagraphs(paragraphs, 'all');
    expect(rest).toEqual([]);
    expect(first.text).toBe('Keep new word .');
    expect([first.start, first.end]).toEqual([0, 19]);
    expect(first.at).toEqual([0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(last).toMatchObject({ start: 23, end: 27, text: 'Last', at: [23, 24, 25, 26] });
  });
  it('in the Original view, reads the deleted text and leaves out the inserted', () => {
    expect(speakableParagraphs(paragraphs, 'original')[0].text).toBe('Keep old word .');
  });
});
