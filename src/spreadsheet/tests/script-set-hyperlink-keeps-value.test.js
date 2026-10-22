import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const run = (wb, code) => runScript({ wb, code, transport: nodeTransport(), timeout: 10000 });

describe('a script\'s setHyperlink', () => {
  it('links the cell and keeps what it holds', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Docs');
    wb.setInput(id, 0, 1, '42');
    wb.setInput(id, 0, 2, '=B1*2');
    wb.setInput(id, 0, 3, '=A1&"!"');
    const res = await run(wb, `async function main(workbook) {
      const sheet = workbook.getActiveWorksheet();
      sheet.getRange('A1').setHyperlink('https://example.com/docs');
      sheet.getRange('B1').setHyperlink('https://example.com/b');
      sheet.getRange('D1').setHyperlink('#Sheet1!A1');
      sheet.getRange('E1').setHyperlink('https://example.com/e');
    }`);
    expect(res.ok).toBe(true);
    expect(wb.getCell(id, 0, 0)).toMatchObject({ v: 'Docs', hyperlink: 'https://example.com/docs' });
    expect(wb.getCell(id, 0, 1)).toMatchObject({ v: 42, hyperlink: 'https://example.com/b' });
    expect(wb.getValue(id, 0, 2)).toBe(84);
    expect(wb.getCell(id, 0, 3).f).toBe('A1&"!"');
    expect(wb.getValue(id, 0, 3)).toBe('Docs!');
    // An empty cell shows its address, as a link typed into one does.
    expect(wb.getValue(id, 0, 4)).toBe('https://example.com/e');
  });
});
