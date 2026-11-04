// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { htmlFragment } from '../src/engine/clipboard-fragment.js';

/**
 * A web page opened as a document (or pasted) is read by htmlFragment. Its whitespace was trimmed and
 * collapsed with regular expressions anchored only at the end (/ +$/, /\v+$/, /[\s ]*\n[\s ]*\/g), which try
 * every start position: a stretch of spaces or preformatted line breaks took time growing with
 * the square of its length, and a page of a few hundred kilobytes held the window for minutes.
 */
const SIZE = 200000;
const timed = html => { const start = performance.now(); const fragment = htmlFragment(html, { copied: false }); return { fragment, ms: performance.now() - start }; };
const texts = fragment => fragment.paragraphs.map(p => p.text);

it('reads a long stretch of spaces in a paragraph in linear time', () => {
  const { fragment, ms } = timed(`<p>a${' '.repeat(SIZE)}b</p>`);
  expect(texts(fragment)).toEqual(['a b']);
  expect(ms).toBeLessThan(1500);
});

it('reads a long stretch of spaces around a line break in linear time', () => {
  const { fragment, ms } = timed(`<p>a${' '.repeat(SIZE)}\n${'\t'.repeat(SIZE)}b</p>`);
  expect(texts(fragment)).toEqual(['a b']);
  expect(ms).toBeLessThan(1500);
});

it('reads preformatted text with many line breaks, and its trailing ones, in linear time', () => {
  const { fragment, ms } = timed(`<pre>a${'\n'.repeat(SIZE)}b${'\n'.repeat(SIZE)}</pre>`);
  expect(texts(fragment)).toEqual([`a${'\v'.repeat(SIZE)}b`]);
  expect(ms).toBeLessThan(1500);
});

it('reads a link whose address is padded with a long stretch of spaces in linear time', () => {
  const { fragment, ms } = timed(`<p><a href="https://example.com/${' '.repeat(SIZE)}x ">site</a></p>`);
  // A browser follows the address with its tabs and line breaks left out, and spaces only trimmed at its ends.
  expect(fragment.paragraphs[0].runs[0].link).toBe(`https://example.com/${' '.repeat(SIZE)}x`);
  expect(ms).toBeLessThan(1500);
});

it('keeps trimming whitespace as before', () => {
  expect(texts(htmlFragment('<p>  Two\n   spaced   words </p><p>Line<br>break<br><br></p>', { copied: false }))).toEqual(['Two spaced words', 'Line\vbreak']);
  expect(texts(htmlFragment('<p>no  break and \nline</p>', { copied: false }))).toEqual(['no  break and line']);
  expect(texts(htmlFragment('<table><tr><td>A  </td><td><p>B</p><p>C</p></td></tr></table>', { copied: false }))).toEqual(['A\tB C']);
  expect(htmlFragment('<p><a href=" \u0001https://example.com/a\n \t">x</a></p>', { copied: false }).paragraphs[0].runs[0].link).toBe('https://example.com/a');
});
