// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { listKind } from '../src/engine/numbering.js';
import { documentHtml, documentMarkdown, documentPlainText } from '../src/lib/document-export.js';
import { markdownHtml } from '../src/lib/markdown-html.js';
import { htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';

const blankDoc = () => new TextDocument([paragraph()]);
const fill = (doc, table, row, cell, text) => { doc.selectCell(table.rows[row].cells[cell].id); doc.replace(text); };
const body = html => html.slice(html.indexOf('<body>') + 7, html.indexOf('</body>')).trim();

describe('Markdown and plain-text tables', () => {
  it('keeps cells in their columns around merged cells', () => {
    const doc = blankDoc();
    doc.insertTable(3, 3);
    const t = doc.tables[0];
    [['Name', 'Q1', 'Q2'], ['Alice', '10', '20'], ['Bob', '30', '40']].forEach((row, r) => row.forEach((text, c) => fill(doc, t, r, c, text)));
    doc.selectCell(t.rows[1].cells[0].id); doc.mergeCellBelow();
    expect(documentMarkdown(doc)).toBe('| Name | Q1 | Q2 |\n| --- | --- | --- |\n| Alice<br>Bob | 10 | 20 |\n|   | 30 | 40 |\n');
    expect(documentPlainText(doc)).toBe('Name\tQ1\tQ2\nAlice Bob\t10\t20\n\t30\t40\n');
  });
  it('keeps a cell after a horizontally merged one in its own column', () => {
    const doc = blankDoc();
    doc.insertTable(2, 3);
    const t = doc.tables[0];
    [['A', 'B', 'C'], ['x', 'y', 'z']].forEach((row, r) => row.forEach((text, c) => fill(doc, t, r, c, text)));
    doc.selectCell(t.rows[1].cells[0].id); const start = doc.selection.focus;
    doc.selectCell(t.rows[1].cells[1].id); doc.select(start, doc.selection.focus + 1);
    expect(doc.mergeCells()).toBeTruthy();
    expect(documentMarkdown(doc)).toBe('| A | B | C |\n| --- | --- | --- |\n| x<br>y |   | z |\n');
    expect(documentPlainText(doc)).toBe('A\tB\tC\nx y\t\tz\n');
  });
  it('keeps a pipe in a cell, or in a link in one, inside that cell', () => {
    const doc = blankDoc();
    doc.insertTable(1, 2);
    const t = doc.tables[0];
    fill(doc, t, 0, 0, 'a|b');
    fill(doc, t, 0, 1, 'site');
    const at = doc.text.indexOf('site'); doc.select(at, at + 4);
    doc.setHyperlink('https://example.com/?q=a|b');
    expect(documentMarkdown(doc)).toBe('| a\\|b | [site](https://example.com/?q=a%7Cb) |\n| --- | --- |\n');
  });
  it('keeps the text of a table nested in a cell', () => {
    const doc = blankDoc();
    doc.replace('Before');
    doc.insertTable(1, 2);
    doc.replace('Outer A');
    doc.insertTable(1, 2, 3000);
    doc.replace('Inner secret');
    const inner = doc.tables.find(t => t.parentCellId);
    fill(doc, inner, 0, 1, 'Inner two');
    expect(documentMarkdown(doc)).toContain('Inner secret \\| Inner two');
    expect(documentPlainText(doc)).toContain('Inner secret Inner two');
    expect(body(documentHtml(doc))).toContain('Inner secret');
  });
});

describe('line, page and column breaks', () => {
  const doc = () => {
    const d = blankDoc();
    d.replace('End of chapter one.'); d.insertPageBreak(); d.replace('Chapter two begins.');
    d.insertParagraph(); d.replace('Left column.'); d.insertColumnBreak(); d.replace('Right column.');
    d.insertParagraph(); d.replace('one\vtwo'); d.select(d.text.length - 7, d.text.length); d.toggleBold();
    return d;
  };
  it('start a new line in every format', () => {
    const d = doc();
    expect(documentPlainText(d)).toBe('End of chapter one.\nChapter two begins.\nLeft column.\nRight column.\none\ntwo\n');
    expect(documentMarkdown(d)).toBe('End of chapter one.\\\nChapter two begins.\n\nLeft column.\\\nRight column.\n\n**one\\\ntwo**\n');
    expect(body(documentHtml(d))).toBe('<p>End of chapter one.<br>Chapter two begins.</p><p>Left column.<br>Right column.</p><p><strong>one<br>two</strong></p>');
    expect(documentMarkdown(d) + documentPlainText(d) + documentHtml(d)).not.toMatch(/[\f\v\u000e\0]/);
  });
  it('keep a list item and a table cell whole, and are left out at a paragraph\'s ends', () => {
    const d = blankDoc();
    d.replace('first\vsecond'); d.toggleList('bullet');
    d.insertParagraph(); d.replace('\vtrailing\v');
    expect(documentMarkdown(d)).toBe('- first\\\n  second\n- trailing\n');
    d.insertParagraph(); d.toggleList('bullet');
    d.insertTable(1, 1); d.replace('cell\vline');
    expect(documentMarkdown(d)).toContain('| cell<br>line |');
    expect(documentPlainText(d)).toContain('cell line');
  });
});

describe('Markdown text that looks like markup', () => {
  // Opening the exported file again: the app's own Markdown import.
  const reopen = markdown => {
    const doc = blankDoc(), fragment = htmlFragment(markdownHtml(markdown));
    for (const p of fragment.paragraphs) p.mark = true;
    pasteFragment(doc, fragment);
    return doc.paragraphs.map(p => p.runs.map(r => r.text).join(''));
  };
  it('comes back as the same text', () => {
    const lines = ['AT&amp;T and &copy; sign, R&D', '~~not struck~~ and ~one~', '- not a list', '+ plus', '1) paren', '2024. A year', '---', '***', '===', '    four spaces', '\ttab', '# not a heading', '> not a quote'];
    const doc = blankDoc();
    lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
    const back = reopen(documentMarkdown(doc));
    expect(back.map(t => t.trim())).toEqual(lines.map(t => t.trim()));
  });
  it('after a line break too', () => {
    const doc = blankDoc();
    doc.replace('Intro\v- dash\v===\v3. three');
    expect(reopen(documentMarkdown(doc))).toEqual(['Intro\v- dash\v===\v3. three']);
  });
});

describe('exported lists', () => {
  // Levels 0/1/1/0/1/0, the second inner list bulleted.
  const nested = () => {
    const doc = blankDoc();
    doc.replace('a'); doc.toggleList('number');
    doc.insertParagraph(); doc.replace('a1'); doc.changeListLevel(1);
    doc.insertParagraph(); doc.replace('a2');
    doc.insertParagraph(); doc.replace('b'); doc.changeListLevel(-1);
    doc.insertParagraph(); doc.replace('b1'); doc.toggleList('bullet'); doc.changeListLevel(1);
    doc.insertParagraph(); doc.replace('c');
    // The last item continues the first list at its top level.
    doc.paragraphs.at(-1).list = { ...doc.paragraphs[0].list };
    return doc;
  };
  const shape = doc => doc.paragraphs.map(p => `${p.runs.map(r => r.text).join('')}:${p.list ? `${listKind(doc.numbering, p.list)}@${p.list.level}` : '-'}`);
  const reopen = (markdownOrHtml, html = false) => {
    const doc = blankDoc(), fragment = htmlFragment(html ? markdownOrHtml : markdownHtml(markdownOrHtml));
    for (const p of fragment.paragraphs) p.mark = true;
    pasteFragment(doc, fragment);
    return doc;
  };
  it('nest each level under its parent item and number each level on its own', () => {
    const doc = nested();
    expect(shape(doc)).toEqual(['a:number@0', 'a1:number@1', 'a2:number@1', 'b:number@0', 'b1:bullet@1', 'c:number@0']);
    expect(documentMarkdown(doc)).toBe('1. a\n   1. a1\n   2. a2\n2. b\n   - b1\n3. c\n');
    expect(shape(reopen(documentMarkdown(doc)))).toEqual(shape(doc));
    expect(body(documentHtml(doc))).toBe('<ol><li>a<ol><li>a1</li><li>a2</li></ol></li><li>b<ul><li>b1</li></ul></li><li>c</li></ol>');
    expect(shape(reopen(documentHtml(doc), true))).toEqual(shape(doc));
  });
  it('keep the number a list continues from after a paragraph between its items', () => {
    const doc = blankDoc();
    doc.replace('one'); doc.toggleList('number');
    doc.insertParagraph(); doc.replace('two');
    doc.insertParagraph(); doc.toggleList('number'); doc.replace('Between');
    doc.insertParagraph(); doc.replace('three');
    // "three" continues the list "Between" interrupted, as a list continued in Word does.
    doc.paragraphs.at(-1).list = { ...doc.paragraphs[0].list };
    expect(documentMarkdown(doc)).toBe('1. one\n2. two\n\nBetween\n\n3. three\n');
    expect(body(documentHtml(doc))).toBe('<ol><li>one</li><li>two</li></ol><p>Between</p><ol start="3"><li>three</li></ol>');
  });
});

