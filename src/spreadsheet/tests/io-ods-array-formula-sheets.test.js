import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// An .ods spells an array formula's block on its first cell (table:number-matrix-rows-spanned), and the
// reader marked every cell inside such a block as one of its results. The blocks were kept for the
// whole file, not the sheet, so a value on a later sheet at the same address as an earlier sheet's
// array formula was taken for an array result and opened blank: a Grand Total column next to a
// sheet of SUMIF formulas lost its numbers when saved as .ods and opened again.

const file = (tables) => new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>'
  + '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
  + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2"'
  + ` office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document>`);
const number = (n) => `<table:table-cell office:value-type="float" office:value="${n}"><text:p>${n}</text:p></table:table-cell>`;

it('keeps the values of a later sheet where an earlier sheet has an array formula', async () => {
  const wb = await workbookFromFile(file('<table:table table:name="Sums"><table:table-row>'
    + '<table:table-cell table:formula="of:=[.B1:.B2]*2" table:number-matrix-columns-spanned="1" table:number-matrix-rows-spanned="2" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>'
    + `${number(1)}</table:table-row><table:table-row><table:table-cell office:value-type="float" office:value="4"><text:p>4</text:p></table:table-cell>${number(2)}</table:table-row></table:table>`
    + `<table:table table:name="Totals"><table:table-row>${number(275)}${number(5)}</table:table-row><table:table-row>${number(123)}</table:table-row></table:table>`), 'arrays.fods');
  const sums = wb.sheetByName('Sums').id, totals = wb.sheetByName('Totals').id;
  expect([wb.getValue(sums, 0, 0), wb.getValue(sums, 1, 0)]).toEqual([2, 4]);
  expect([wb.getValue(totals, 0, 0), wb.getValue(totals, 1, 0), wb.getValue(totals, 0, 1)]).toEqual([275, 123, 5]);
});

it('keeps them through a save as .ods', async () => {
  const wb = new Workbook();
  const first = wb.activeSheetId;
  wb.setInput(first, 0, 1, '3');
  wb.setArrayFormula(first, { r1: 0, c1: 0, r2: 1, c2: 0 }, '=B1:B2*2');
  expect(wb.getValue(first, 1, 0)).toBe(0);
  const second = wb.addSheet('Totals').id;
  wb.setInput(second, 0, 0, '330');
  wb.setInput(second, 1, 0, '275');
  const back = await workbookFromFile(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), 'saved.ods');
  const totals = back.sheetByName('Totals').id;
  expect([back.getValue(totals, 0, 0), back.getValue(totals, 1, 0)]).toEqual([330, 275]);
});
