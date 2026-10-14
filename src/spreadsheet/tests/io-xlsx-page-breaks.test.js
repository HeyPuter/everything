import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { readXlsxPrint } from '../src/core/xlsx-print.js';
import { writeXlsxPrint } from '../src/core/xlsx-export-print.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

const book = (rows = 60) => {
  const cells = {};
  for (let r = 0; r < rows; r++) cells[`${r},0`] = { v: r + 1 };
  return new Workbook({ sheets: [{ name: 'Data', cells }] });
};

describe('xlsx page breaks', () => {
  it('reads manual breaks only and writes them as rowBreaks and colBreaks in schema order', () => {
    const xml = '<worksheet><sheetData/><pageSetup orientation="portrait"/><rowBreaks count="3" manualBreakCount="2"><brk id="10" max="16383" man="1"/><brk id="25" max="16383"/><brk id="40" max="16383" man="true"/></rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="4" max="1048575" man="1"/></colBreaks></worksheet>';
    const settings = readXlsxPrint(xml, [], 'Data', 0);
    expect(settings).toMatchObject({ rowBreaks: [10, 40], colBreaks: [4] });
    const out = writeXlsxPrint('<worksheet><sheetData/><drawing r:id="x"/></worksheet>', settings);
    expect(out).toMatch(/<pageSetup\b[^>]*\/><rowBreaks count="2" manualBreakCount="2"><brk id="10" max="16383" man="1"\/><brk id="40" max="16383" man="1"\/><\/rowBreaks><colBreaks count="1" manualBreakCount="1"><brk id="4" max="1048575" man="1"\/><\/colBreaks><drawing/);
    expect(readXlsxPrint('<worksheet><sheetData/><rowBreaks><brk id="3" man="1"/></rowBreaks></worksheet>', [], 'Data', 0)).toMatchObject({ rowBreaks: [3] });
  });

  it('round-trips through a native file and lets the native part win over the app record', async () => {
    const wb = book(), id = wb.activeSheetId;
    wb.setPageBreaks(id, { rows: [12, 30], cols: [2] });
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const back = await workbookFromFile(bytes, 'breaks.xlsx');
    expect(back.activeSheet.printSettings).toMatchObject({ rowBreaks: [12, 30], colBreaks: [2] });
    // Another program removed the breaks: the private record must not bring them back.
    const zip = X.CFB.read(bytes, { type: 'array' });
    const part = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
    const text = new TextDecoder().decode(part.content);
    expect(text).toContain('<rowBreaks');
    part.content = new TextEncoder().encode(text.replace(/<rowBreaks\b[\s\S]*?<\/rowBreaks>|<colBreaks\b[\s\S]*?<\/colBreaks>/g, ''));
    part.size = part.content.length;
    const edited = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'edited.xlsx');
    expect(edited.activeSheet.printSettings?.rowBreaks).toBeUndefined();
  });

  it('imports breaks from another program', async () => {
    const wb = await workbookFromFile(otherProgramsXlsx({ sheetXml: { Data: { rows: '<row r="1"><c r="A1"><v>1</v></c></row>',
      tail: '<rowBreaks count="1" manualBreakCount="1"><brk id="19" max="16383" man="1"/></rowBreaks>' } } }), 'other.xlsx');
    expect(wb.activeSheet.printSettings.rowBreaks).toEqual([19]);
  });

  it('keeps breaks and the page-break lines setting in the app format', () => {
    const wb = book(), id = wb.activeSheetId;
    wb.setPageBreaks(id, { rows: [7] });
    wb.setShowPageBreaks(id, true);
    const back = new Workbook(wb.toJSON());
    expect(back.activeSheet.printSettings.rowBreaks).toEqual([7]);
    expect(back.activeSheet.showPageBreaks).toBe(true);
  });
});
