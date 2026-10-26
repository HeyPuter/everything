// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { markdownHtml } from '../src/lib/markdown-html.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';

const open = markdown => {
  const doc = new TextDocument([paragraph()]), fragment = htmlFragment(markdownHtml(markdown));
  for (const p of fragment.paragraphs) p.mark = true;
  pasteFragment(doc, fragment);
  return doc.paragraphs.map(p => p.runs.map(r => r.text).join(''));
};

it('keeps the text of HTML in a Markdown file, but none of its scripts or styles', () => {
  const readme = '<p align="center">\n  A fast, private word processor.\n</p>\n\n# Install\n\n<details>\n<summary>Advanced options</summary>\nSet the port with PORT.\n</details>\n\nPress <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.<br>Done.\n\n<script>alert(1)</script>\n<style>p { color: red }</style>\n\nEnd';
  expect(open(readme)).toEqual(['A fast, private word processor.', 'Install', 'Advanced options Set the port with PORT.', 'Press Ctrl+S to save.\vDone.', 'End']);
});

it('keeps the alignment that align attributes and <center> give blocks', () => {
  const doc = new TextDocument([paragraph()]);
  const fragment = htmlFragment(markdownHtml('<h1 align="center">Documents</h1>\n\n<p align="right">A fast word processor.</p>\n\n<div align="center">\n\nLogo line\n\n</div>\n\n<center>Old style</center>\n\n<table align="center"><tr><td>Cell</td></tr></table>\n\n<div align="center"><table><tr><td>Centered table</td></tr></table></div>\n\nBody'));
  for (const p of fragment.paragraphs) p.mark = true;
  pasteFragment(doc, fragment);
  expect(doc.paragraphs.map(p => [p.runs.map(r => r.text).join(''), p.format?.alignment ?? 'left'])).toEqual([
    ['Documents', 'center'], ['A fast word processor.', 'right'], ['Logo line', 'center'], ['Old style', 'center'], ['Cell', 'left'], ['Centered table', 'left'], ['Body', 'left'],
  ]);
});

it('opens Markdown nested too deeply to convert as its plain text, one paragraph per line', () => {
  // Thousands of nested quotations or emphasis markers overflow the Markdown converters' recursion.
  expect(open(`Intro <b>&amp;</b>\r\n${'>'.repeat(5000)} deep\n`)).toEqual(['Intro <b>&amp;</b>', `${'>'.repeat(5000)} deep`]);
  expect(open(`${'*'.repeat(5000)}a${'*'.repeat(5000)}`)).toEqual([`${'*'.repeat(5000)}a${'*'.repeat(5000)}`]);
});

it('opens footnotes as their numbered notes, without the arrows a web page links back with', () => {
  const lines = open('A claim[^1] and[^1] another[^n].\n\n[^1]: The source.\n[^n]: Second note\n\n    with more.\n');
  expect(lines.join('\n')).not.toContain('↩');
  expect(lines).toContain('The source.');
  expect(lines).toContain('with more.');
  expect(lines[0]).toBe('A claim1 and1 another2.');
});
