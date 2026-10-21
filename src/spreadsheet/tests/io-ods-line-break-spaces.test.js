import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

const texts = ['x\n y', 'Total \nnext', 'ab\n  ', ' a \n \n b ', 'p\n\n q', 'plain\nlines', ' lead and trail '];

// An .ods marks a space a reader must keep (at either end of a paragraph, or in a run of them) as text:s.
// A space beside a line break was written bare at the edge of a paragraph, where LibreOffice and this app's
// reader drop it, so a cell reading "Total \nnext" or an indented second line came back without it.
it('keeps the spaces beside line breaks in a cell saved as .ods', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  texts.forEach((text, r) => wb.setCells(id, [{ r, c: 0, cell: { v: text } }]));
  const blob = await workbookToOds(wb, { settings: false });
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' }), 'content.xml').content);
  expect(content).toContain('<text:p>x<text:line-break/><text:s/>y</text:p>');
  expect(content).toContain('<text:p>plain</text:p><text:p>lines</text:p>');
  const back = await workbookFromFile(blob, 'spaces.ods');
  texts.forEach((text, r) => {
    expect(back.getValue(back.activeSheetId, r, 0)).toBe(text);
    expect(back.getCell(back.activeSheetId, r, 0).richText).toBeUndefined();
  });
});
