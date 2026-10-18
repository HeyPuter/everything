// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { documentHtml, documentMarkdown, documentPlainText } from '../src/lib/document-export.js';

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
});
