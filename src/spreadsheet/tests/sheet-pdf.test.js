import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { sheetsToPdf, textWidth, wrapLines, bandsOf, pdfByte } from '../src/core/sheet-pdf.js';

const text = (bytes) => String.fromCharCode(...bytes);

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item');
  wb.setInput(id, 0, 1, 'Cost (€)');
  wb.setInput(id, 1, 0, 'Paper');
  wb.setInput(id, 1, 1, '12.5');
  wb.setInput(id, 2, 0, 'Ink');
  wb.setInput(id, 2, 1, '=B2*2');
  return { wb, id };
}

describe('sheetsToPdf', () => {
  it('writes a well-formed PDF whose cross-reference offsets point at its objects', () => {
    const { wb, id } = book();
    const bytes = sheetsToPdf(wb, [{ sheetId: id }], { title: 'Budget' });
    const s = text(bytes);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(s)[1]);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) => expect(s.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
    // Each content stream's /Length is its byte count.
    for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = m.index + m[0].length;
      expect(s.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
    }
  });

  it('draws the displayed values, computed formulas included, and the euro sign in the PDF encoding', () => {
    const { wb, id } = book();
    const s = text(sheetsToPdf(wb, [{ sheetId: id }]));
    expect(s).toContain('(Paper) Tj');
    expect(s).toContain('(12.5) Tj');
    expect(s).toContain('(25) Tj');
    expect(s).toContain('(Cost \\(\x80\\)) Tj');
    expect(s).toContain('Sheet1 · Page 1 of 1'.replace('·', '\xb7'));
  });

  it('takes only the range asked for', () => {
    const { wb, id } = book();
    const s = text(sheetsToPdf(wb, [{ sheetId: id, range: { r1: 1, c1: 0, r2: 1, c2: 0 } }]));
    expect(s).toContain('(Paper) Tj');
    expect(s).not.toContain('(Ink) Tj');
  });

  it('puts every sheet of a workbook on its own pages and bolds bold cells', () => {
    const { wb, id } = book();
    const other = wb.addSheet('Notes');
    wb.setInput(other.id, 0, 0, 'Second');
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true });
    const s = text(sheetsToPdf(wb, wb.sheets.map((sh) => ({ sheetId: sh.id }))));
    expect(s).toMatch(/\/Count 2 /);
    expect(s).toContain('(Second) Tj');
    expect(s).toContain('/F2 ');
  });

  it('fills, borders and colours cells, and wraps text that asks to', () => {
    const { wb, id } = book();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bg: '#ffcc00', bb: true, color: '#1f4e79', wrap: true });
    wb.setInput(id, 0, 0, 'A long heading that has to wrap inside its cell');
    const s = text(sheetsToPdf(wb, [{ sheetId: id }]));
    expect(s).toMatch(/q 1 0\.8 0 rg [\d.]+ [\d.]+ [\d.]+ [\d.]+ re f Q/);
    expect(s).toMatch(/q 0 0 0 RG 0\.75 w [\d. ]+ m [\d. ]+ l S Q/);
    expect(s).toContain('0.12 0.31 0.47 rg');
    expect((s.match(/Tm \((A long|heading|has|wrap|inside|its|cell)[^)]*\) Tj/g) || []).length).toBeGreaterThan(1);
  });

  it('splits a sheet too wide to scale onto several pages across', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let c = 0; c < 60; c++) wb.setInput(id, 0, c, `c${c}`);
    const s = text(sheetsToPdf(wb, [{ sheetId: id }]));
    expect(Number(/\/Count (\d+)/.exec(s)[1])).toBeGreaterThan(1);
  });
});

describe('PDF text helpers', () => {
  it('measures, wraps and encodes text', () => {
    expect(textWidth('ii', 10)).toBeLessThan(textWidth('MM', 10));
    expect(textWidth('a', 10, true)).toBeGreaterThan(0);
    const lines = wrapLines('one two three four five six', textWidth('one two', 10) + 1, 10, false);
    expect(lines[0]).toBe('one two');
    expect(lines.join(' ')).toBe('one two three four five six');
    expect(pdfByte('é')).toBe(0xe9);
    expect(pdfByte('€')).toBe(0x80);
    expect(pdfByte('漢')).toBe(0x3f);
  });

  it('bands lines by capacity', () => {
    expect(bandsOf([10, 10, 10], 25)).toEqual([[0, 2], [2, 3]]);
    expect(bandsOf([50, 10], 25)).toEqual([[0, 1], [1, 2]]);
  });
});
