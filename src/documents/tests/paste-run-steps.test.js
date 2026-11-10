// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';
import { markdownHtml } from '../src/lib/markdown-html.js';

/**
 * Formatting each run of a pasted, opened or inserted web page is a command over its whole paragraph, so a
 * paragraph of thousands of formatted runs took time growing with the square of their number: a Markdown file
 * of "*a" 30,000 times (60 kB) took over four minutes to open. Past a budget, a paragraph's text goes in
 * without its character formatting.
 */
const paste = html => {
  const fragment = htmlFragment(html, { copied: false });
  for (const p of fragment.paragraphs) p.mark = true;
  const doc = new TextDocument([paragraph()]);
  const start = performance.now();
  pasteFragment(doc, fragment);
  return { doc, ms: performance.now() - start };
};

it('opens a paragraph of many thousands of formatted runs in moments, its text whole', () => {
  const { doc, ms } = paste(`<h1>Title</h1><p>${'<b>a</b> '.repeat(15000)}end</p><p><i>after</i></p>`);
  expect(ms).toBeLessThan(3000);
  expect(doc.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Title', `${'a '.repeat(15000)}end`, 'after']);
  // The other paragraphs keep their own formatting.
  expect(doc.paragraphs[0].runs[0].bold).toBe(true);
  expect(doc.paragraphs[2].runs[0].italic).toBe(true);
});

it('opens a Markdown file of alternating emphasis in moments', () => {
  const { doc, ms } = paste(markdownHtml(`Start ${'*a'.repeat(4000)} end`));
  expect(ms).toBeLessThan(3000);
  expect(doc.paragraphs[0].runs.map(r => r.text).join('')).toMatch(/^Start .* end$/);
});

it('keeps the character formatting of ordinary paragraphs, however many there are', () => {
  const { doc } = paste(`${'<p>Plain <b>bold</b> and <a href="https://example.com/">a link</a>.</p>'.repeat(3000)}`);
  expect(doc.paragraphs).toHaveLength(3000);
  for (const p of [doc.paragraphs[0], doc.paragraphs.at(-1)]) {
    expect(p.runs.find(r => r.text === 'bold')?.bold).toBe(true);
    expect(p.runs.find(r => r.text === 'a link')?.link?.target).toBe('https://example.com/');
  }
});

it('keeps the character formatting of a long paragraph of a few hundred formatted runs', () => {
  const { doc } = paste(`<p>${'<b>a</b> '.repeat(400)}end</p>`);
  expect(doc.paragraphs[0].runs.filter(r => r.bold && r.text === 'a')).toHaveLength(400);
});
