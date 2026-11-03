import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

// A package whose [Content_Types] and relationships list a styles part it does not hold (a file cut down by a
// tool, or a part lost on the way) was refused outright as unreadable, data and all. Excel opens it with every
// cell in the default format; so does this app now, and its next save writes a styles part of its own.
it('opens a workbook whose listed styles part is missing, in the default format', async () => {
  const bytes = otherProgramsXlsx({ sheetXml: { Data: {
    head: '<cols><col min="1" max="1" width="20" style="1" customWidth="1"/></cols>',
    rows: '<row r="1" s="1" customFormat="1"><c r="A1" s="1"><v>5</v></c><c r="B1" s="2"><f>A1*2</f><v>10</v></c></row>',
  } } });
  const zip = X.CFB.read(bytes, { type: 'array' });
  expect(new TextDecoder().decode(X.CFB.find(zip, '/[Content_Types].xml').content)).toContain('/xl/styles.xml');
  X.CFB.utils.cfb_del(zip, '/xl/styles.xml');
  const wb = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'cut.xlsx');
  const id = wb.sheets[0].id;
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1)]).toEqual([5, 10]);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'cut.xlsx');
  expect(back.getValue(back.sheets[0].id, 0, 1)).toBe(10);
});
