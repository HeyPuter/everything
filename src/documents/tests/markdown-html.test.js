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
