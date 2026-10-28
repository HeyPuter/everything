// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
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
  // The rule between them is a line under an empty paragraph.
  expect(opened(markdownHtml('1. a\n2. b\n\n---\n\n1. x\n2. y\n'))).toEqual(['1.\ta', '2.\tb', '', '1.\tx', '2.\ty']);
});

it('goes on numbering an outer list after a list nested in its item', () => {
  const [a, point, b] = opened('<ol><li>a<ul><li>point</li></ul></li><li>b</li></ol>');
  expect([a, b]).toEqual(['1.\ta', '2.\tb']);
  expect(point).toMatch(/^  \S\tpoint$/);
});

describe('a web page Google Docs exports', () => {
  // File > Download > Web page: nesting by class (lst-kix_<list>-<level>), each level a list of its own, numbering
  // carried on by the style sheet, and a blank line an empty paragraph the style sheet gives a height.
  const page = `<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"><style type="text/css">
ol.lst-kix_abc-0.start{counter-reset:lst-ctn-kix_abc-0 0}.lst-kix_abc-0>li{counter-increment:lst-ctn-kix_abc-0}
ul.lst-kix_def-1{list-style-type:none}.c2{height:11pt}.c0{margin:0;padding:0}.c4{font-weight:700}
</style></head><body class="c5 doc-content">
<p class="c0"><span class="c4">Plan</span></p><p class="c0 c2"><span class="c1"></span></p>
<p class="c0"><span class="c1">After a blank line</span></p>
<ol class="c3 lst-kix_abc-0 start" start="1"><li class="c0 li-bullet-0"><span class="c1">One</span></li></ol>
<ul class="c3 lst-kix_def-1 start"><li class="c0 li-bullet-1"><span class="c1">Detail</span></li><li class="c0 li-bullet-1"><span class="c1">More</span></li></ul>
<ol class="c3 lst-kix_abc-0"><li class="c0 li-bullet-0"><span class="c1">Two</span></li></ol>
<p class="c0"><span class="c1">End</span></p></body></html>`;
  // (Its blank lines need a browser's style sheets: tests/browser/google-docs-import.spec.js.)
  it('keeps its nested lists, numbered on', async () => {
    const { htmlBody } = await import('../src/lib/importers.js');
    const lines = opened(htmlBody(page)).filter(Boolean);
    expect(lines).toEqual(['Plan', 'After a blank line', '1.\tOne', expect.stringMatching(/^  \S\tDetail$/), expect.stringMatching(/^  \S\tMore$/), '2.\tTwo', 'End']);
  });
});

describe('horizontal rules and table rows', () => {
  const model = (html) => {
    const doc = new TextDocument([paragraph()]), fragment = htmlFragment(html, { copied: false });
    for (const p of fragment.paragraphs) p.mark = true;
    pasteFragment(doc, fragment);
    return doc;
  };
  it('keeps a horizontal rule as a line under an empty paragraph, as Word draws one', () => {
    for (const html of ['<p>Above</p><hr><p>Below</p>', markdownHtml('Above\n\n---\n\nBelow\n')]) {
      const doc = model(html);
      expect(doc.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Above', '', 'Below']);
      expect(doc.paragraphs[1].format?.paragraphBorders?.bottom?.style).toBe('single');
      expect(doc.paragraphs[0].format?.paragraphBorders?.bottom?.style ?? 'none').toBe('none');
      expect(doc.paragraphs[2].format?.paragraphBorders?.bottom?.style ?? 'none').toBe('none');
    }
  });
  it('keeps every cell in its column when cells before it are empty', () => {
    expect(model('<table><tr><th></th><th>Q1</th><th>Q2</th></tr><tr><td>Sales</td><td></td><td>9</td></tr></table>').paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['\tQ1\tQ2', 'Sales\t\t9']);
  });
});
