// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { documentStatistics } from '../src/views/editor-commands.js';
import { countWords } from '../src/core/text.js';

// File > Info shows the document's words: the same count as the status bar and the Word Count dialog.
it('counts words with the status bar’s rule', () => {
  for (const text of ['我爱北京天安门。', 'ฉันไปโรงเรียน', 'one two\u000ethree', 'zero​width', 'Plain words here']) {
    expect(documentStatistics(text).words, text).toBe(countWords(text));
  }
  expect(documentStatistics('我爱北京天安门。').words).toBe(7);
});
