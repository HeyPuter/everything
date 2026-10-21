import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { findAll, replaceCells } from '../src/core/search.js';

// Replace rewrote a cell as a fresh entry, so a cell with a link (Insert ▸ Link) lost it: replacing
// "Acme" with "Apex" in "Acme website" left plain text that no longer opened the site. The link is
// no part of the text and stays, as it does through Paste Special operations and Text to number.
describe('replacing in a cell that carries a link', () => {
  it('keeps the link on the new text, and undo puts the old text back with it', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    expect(wb.setLink(id, 0, 0, 'https://acme.example.com', 'Acme website')).toBe(true);
    expect(wb.setLink(id, 1, 0, '#Sheet1!C5', 'Acme totals')).toBe(true);
    wb.setInput(id, 2, 0, 'Acme plain');
    expect(replaceCells(wb, id, findAll(wb, id, 'Acme'), 'Acme', 'Apex')).toBe(3);
    expect(wb.linkAt(id, 0, 0)).toEqual({ url: 'https://acme.example.com', label: 'Apex website' });
    expect(wb.linkAt(id, 1, 0)).toEqual({ url: '#Sheet1!C5', label: 'Apex totals' });
    expect(wb.linkAt(id, 2, 0)).toBeNull();
    wb.undo();
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: 'Acme website', hyperlink: 'https://acme.example.com' });
    wb.redo();
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: 'Apex website', hyperlink: 'https://acme.example.com' });
  });

  it('drops the link when the replacement empties the cell, as clearing it does', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setLink(id, 0, 0, 'https://acme.example.com', 'Acme');
    expect(replaceCells(wb, id, findAll(wb, id, 'Acme', { wholeCell: true }), 'Acme', '', { wholeCell: true })).toBe(1);
    expect(wb.getCell(id, 0, 0)?.hyperlink).toBeUndefined();
    expect(wb.linkAt(id, 0, 0)).toBeNull();
  });
});
