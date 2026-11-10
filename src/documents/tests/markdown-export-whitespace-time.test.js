import { it, expect } from 'vitest';
import { TextDocument } from '../src/engine/model.js';
import { documentMarkdown } from '../src/lib/document-export.js';

/**
 * Markdown export split each run around its whitespace and trimmed the result with regular expressions
 * anchored only at the end (/^([\s\0]*)([\s\S]*?)([\s\0]*)$/, /[ \t\n]+$/), which try every start position:
 * a paragraph holding a long stretch of spaces, tabs or line breaks (as a document sent by anyone can) took
 * time growing with the square of that stretch, and exporting it held the window for minutes.
 */
const SIZE = 200000;
const exported = runs => {
  const start = performance.now();
  const markdown = documentMarkdown(new TextDocument([{ runs }]));
  return { markdown, ms: performance.now() - start };
};

it('exports a long stretch of spaces or tabs in linear time', () => {
  for (const space of [' ', '\t']) {
    const { markdown, ms } = exported([{ text: `a${space.repeat(SIZE)}b` }]);
    expect(markdown).toBe(`a${space.repeat(SIZE)}b\n`);
    expect(ms).toBeLessThan(1500);
  }
});

it('exports emphasized text around a long stretch of spaces in linear time', () => {
  const { markdown, ms } = exported([{ text: 'a', bold: true }, { text: `${' '.repeat(SIZE)}b`, bold: true }]);
  expect(markdown).toBe(`**a${' '.repeat(SIZE)}b**\n`);
  expect(ms).toBeLessThan(1500);
});

it('exports many line breaks in linear time', () => {
  const { markdown, ms } = exported([{ text: `a${'\v'.repeat(SIZE)}b${'\v'.repeat(SIZE)}` }]);
  expect(markdown).toBe(`a${'\\\n'.repeat(SIZE)}b\n`);
  expect(ms).toBeLessThan(3000);
});

it('keeps whitespace at the edges of runs and of the document as before', () => {
  expect(exported([{ text: 'plain ' }, { text: ' bold\v', bold: true }, { text: ' end' }]).markdown).toBe('plain  **bold**\\\n end\n');
  expect(exported([{ text: '\vlead and trail\v\v' }]).markdown).toBe('lead and trail\n');
  expect(exported([{ text: ' + kept' }]).markdown).toBe(' + kept\n');
});
