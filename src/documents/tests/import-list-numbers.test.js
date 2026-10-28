// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';
import { markdownHtml } from '../src/lib/markdown-html.js';
import { documentPlainText } from '../src/lib/document-export.js';

/** A Markdown file or web page opened as a new document, as the editor opens one, and its text with list markers. */
const opened = (html) => {
  const doc = new TextDocument([paragraph()]), fragment = htmlFragment(html, { copied: false });
  for (const p of fragment.paragraphs) p.mark = true;
  pasteFragment(doc, fragment);
  return documentPlainText(doc).trim().split('\n');
};

it('numbers on through a list whose items hold code or more paragraphs, as READMEs write steps', () => {
  expect(opened(markdownHtml('1. Install\n\n   ```\n   npm i\n   ```\n\n2. Build\n\n   More about building.\n\n3. Run\n'))).toEqual(['1.\tInstall', 'npm i', '2.\tBuild', 'More about building.', '3.\tRun']);
});

it('starts a list at the number it gives', () => {
  expect(opened(markdownHtml('5. five\n6. six\n'))).toEqual(['5.\tfive', '6.\tsix']);
  expect(opened('<ol start="3"><li>c</li><li>d</li></ol>')).toEqual(['3.\tc', '4.\td']);
});

it('keeps two lists one after another apart', () => {
  expect(opened('<ol><li>a</li><li>b</li></ol><ol><li>x</li><li>y</li></ol>')).toEqual(['1.\ta', '2.\tb', '1.\tx', '2.\ty']);
  expect(opened(markdownHtml('1. a\n2. b\n\n---\n\n1. x\n2. y\n'))).toEqual(['1.\ta', '2.\tb', '1.\tx', '2.\ty']);
});

it('goes on numbering an outer list after a list nested in its item', () => {
  const [a, point, b] = opened('<ol><li>a<ul><li>point</li></ul></li><li>b</li></ol>');
  expect([a, b]).toEqual(['1.\ta', '2.\tb']);
  expect(point).toMatch(/^  \S\tpoint$/);
});
