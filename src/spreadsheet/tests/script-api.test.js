import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

/** Run `code` on `wb` in a worker thread; resolves with the result and the console lines. */
async function run(wb, code, opts = {}) {
  const logs = [];
  const result = await runScript({ wb, code, transport: nodeTransport(), timeout: 10000, onLog: (l) => logs.push(l), ...opts });
  return { ...result, logs };
}
const sid = (wb, name) => wb.sheetByName(name).id;
const value = (wb, a1, sheet = 'Sheet1') => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  const c = m[1].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return wb.getValue(sid(wb, sheet), Number(m[2]) - 1, c);
};
function book(rows = []) {
  const wb = new Workbook();
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(wb.activeSheetId, r, c, String(v))));
  wb.clearHistory();
  return wb;
}

describe('script API', () => {
  it('writes values and formulas and reads them back', async () => {
    const wb = book();
    const res = await run(wb, `async function main(workbook) {
      const sheet = workbook.getActiveWorksheet();
      sheet.getRange('A1:B2').setValues([[1, 2], [3, '=A1+B1+A2']]);
      const values = await sheet.getRange('A1:B2').getValues();
      const formulas = await sheet.getRange('B2').getFormulas();
      console.log(JSON.stringify(values), formulas[0][0]);
    }`);
    expect(res.ok).toBe(true);
    expect(value(wb, 'B2')).toBe(6);
    expect(res.logs.map((l) => l.text)).toEqual(['[[1,2],[3,6]] =A1+B1+A2']);
  });

  it('reads displayed text, the used range and the selection', async () => {
    const wb = book([['Name', 'Amount'], ['a', '1.5'], ['b', '2']]);
    const res = await run(wb, `async function main(workbook) {
      const sheet = workbook.getActiveWorksheet();
      const used = await sheet.getUsedRange();
      console.log(used.getAddress(), used.getRowCount(), used.getColumnCount());
      console.log(workbook.getSelectedRange().getAddress({ sheet: false }));
      sheet.getRange('B2:B3').setNumberFormat('0.00');
      console.log((await sheet.getRange('B2:B3').getTexts()).join('|'));
    }`, { env: { selection: () => ({ sheetId: wb.activeSheetId, range: { r1: 1, c1: 0, r2: 2, c2: 1 } }) } });
    expect(res.error).toBe(null);
    expect(res.logs.map((l) => l.text)).toEqual(['Sheet1!A1:B3 3 2', 'A2:B3', '1.50|2.00']);
  });

  it('formats cells: fill, font, alignment, borders, sizes', async () => {
    const wb = book([['x']]);
    const res = await run(wb, `async function main(workbook) {
      const r = workbook.getActiveWorksheet().getRange('A1:B2');
      const f = r.getFormat();
      f.getFill().setColor('#ff0000');
      f.getFont().setBold(true).setItalic(true).setColor('blue').setSize(15).setName('Georgia');
      f.setHorizontalAlignment('center');
      f.setWrapText(true);
      f.setBorder('outline', { style: 'medium', color: '#00ff00' });
      f.setColumnWidth(150);
      console.log(await f.getFill().getColor(), await f.getFont().getBold(), await f.getFont().getSize(), await f.getHorizontalAlignment());
    }`);
    expect(res.error).toBe(null);
    const s = wb.styleAt(wb.activeSheetId, 1, 1);
    expect(s).toMatchObject({ bg: '#ff0000', bold: true, italic: true, color: '#0000ff', align: 'center', wrap: true });
    expect(s.size).toBe(20);
    expect(wb.colWidth(wb.activeSheetId, 0)).toBe(150);
    expect(res.logs[0].text).toBe('#ff0000 true 15 center');
  });

  it('inserts and deletes rows, columns and cells', async () => {
    const wb = book([['a'], ['b'], ['c'], ['=A3']]);
    const res = await run(wb, `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      s.getRange('2:2').insert();
      s.getRange('A:A').insert();
      s.getRange('B1').delete('up');
    }`);
    expect(res.error).toBe(null);
    // Row inserted above b, column A pushed to B, then B1 deleted pulling the column up.
    expect(value(wb, 'B1')).toBe(null);
    expect(value(wb, 'B2')).toBe('b');
    expect(wb.getCell(wb.activeSheetId, 3, 1).f).toBe('B3');
  });

  it('sorts, fills, merges and removes duplicates', async () => {
    const wb = book([['Name', 'n'], ['c', '3'], ['a', '1'], ['b', '2'], ['a', '1']]);
    const res = await run(wb, `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      s.getRange('A1:B5').removeDuplicates([0, 1], true);
      s.getRange('A1:B4').sort([{ column: 1, ascending: false }], { hasHeaders: true });
      s.getRange('D1:D2').setValues([[1], [2]]);
      s.getRange('D1:D2').autoFill('D1:D5');
      s.getRange('F1:G1').merge();
    }`);
    expect(res.error).toBe(null);
    expect([value(wb, 'A2'), value(wb, 'A3'), value(wb, 'A4'), value(wb, 'A5')]).toEqual(['c', 'b', 'a', null]);
    expect(value(wb, 'D5')).toBe(5);
    expect(wb.mergeAt(wb.activeSheetId, 0, 5)).toBeTruthy();
  });

  it('adds, renames, hides and deletes sheets, tables and charts', async () => {
    const wb = book([['Item', 'Qty'], ['x', '1'], ['y', '2']]);
    const res = await run(wb, `async function main(workbook) {
      const data = workbook.addWorksheet('Data');
      data.getRange('A1').setValue('hello');
      data.setName('Info');
      console.log(workbook.getWorksheets().map((s) => s.getName()).join(','));
      const t = workbook.getActiveWorksheet().addTable('A1:B3', { name: 'Stock' });
      console.log(t.getName(), (await t.getRange()).getAddress());
      workbook.getActiveWorksheet().addChart('column', 'A1:B3', { title: 'Qty' });
      const extra = workbook.addWorksheet();
      extra.delete();
      workbook.getWorksheet('info').setVisible(false);
    }`);
    expect(res.error).toBe(null);
    expect(res.logs.map((l) => l.text)).toEqual(['Sheet1,Info', 'Stock Sheet1!A1:B3']);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Sheet1', 'Info']);
    expect(wb.sheetByName('Info').hidden).toBe(true);
    expect(value(wb, 'A1', 'Info')).toBe('hello');
    expect(wb.sheets[0].tables[0].name).toBe('Stock');
    expect(wb.sheets[0].charts[0]).toMatchObject({ type: 'column', title: 'Qty' });
    // Adding a sheet did not bring it to the front.
    expect(wb.activeSheetId).toBe(wb.sheets[0].id);
  });

  it('reports a refused change at the line that made it, keeping what came before', async () => {
    const wb = book();
    const res = await run(wb, `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      s.getRange('A1').setValue(1);
      s.getRange('A1:B1').setValues([[1]]);
    }`);
    expect(res.ok).toBe(false);
    expect(res.error.line).toBe(4);
    expect(res.error.message).toMatch(/1 row\(s\) by 2 column\(s\)/);
    expect(value(wb, 'A1')).toBe(1);
  });

  it('says when a read was not awaited', async () => {
    const wb = book();
    const res = await run(wb, `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      const v = s.getRange('A1').getValues();
      s.getRange('B1').setValues(v);
    }`);
    expect(res.error.message).toMatch(/forget await/);
    expect(res.error.line).toBe(4);
  });

  it('reports syntax errors and a missing main with their lines', async () => {
    const wb = book();
    const syntax = await run(wb, 'async function main(workbook) {\n  const x = ;\n}');
    expect(syntax.ok).toBe(false);
    expect(syntax.error.line).toBe(2);
    const none = await run(wb, 'function other() {}');
    expect(none.error.message).toMatch(/main/);
  });

  it('writes dates as dates and text as text when asked', async () => {
    const wb = book();
    const res = await run(wb, `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      s.getRange('A1').setValue(new Date(2024, 0, 15));
      s.getRange('A2').setValue('007', { asText: true });
      s.getRange('A3').setValue('007');
    }`);
    expect(res.error).toBe(null);
    expect(value(wb, 'A1')).toBe(45306);
    expect(wb.styleAt(wb.activeSheetId, 0, 0).fmt).toBe('date');
    expect(value(wb, 'A2')).toBe('007');
    expect(value(wb, 'A3')).toBe(7);
  });

  it('runs the gallery samples', async () => {
    const { SAMPLE_SCRIPTS } = await import('../src/core/scripts.js');
    const wb = book([['Name', 'Q1', 'Q2'], ['a', '1', '2'], ['b', '3', '4'], ['', '', ''], ['a', '5', '6']]);
    wb.addSheet('Hidden');
    wb.setSheetHidden(wb.sheetByName('Hidden').id, true);
    wb.setActiveSheet(wb.sheets[0].id);
    wb.setHidden(wb.sheets[0].id, 'row', [1], true);
    for (const sample of SAMPLE_SCRIPTS) {
      const res = await run(wb, sample.code, { env: { selection: () => ({ sheetId: wb.sheets.find((s) => s.name === 'Sheet1').id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }) } });
      expect(res.error, sample.name).toBe(null);
      wb.setActiveSheet(wb.sheetByName('Sheet1').id);
    }
    expect(wb.sheets[0].name).toBe('Contents');
    expect(wb.sheetByName('Hidden').hidden).toBe(false);
    expect(wb.isHidden(sid(wb, 'Sheet1'), 'row', 1)).toBe(false);
  });

  it('documents exactly the methods the runtime has', async () => {
    const { SCRIPT_API } = await import('../src/core/script-api-docs.js');
    const wb = book([['a', 'b'], ['1', '2']]);
    const res = await run(wb, `async function main(workbook) {
      const names = (o) => Object.keys(Object.getPrototypeOf(o) === Object.prototype ? o : Object.getPrototypeOf(o)).filter((k) => !k.startsWith('_')).sort();
      const sheet = workbook.getActiveWorksheet();
      const range = sheet.getRange('A1');
      const table = sheet.addTable('A1:B2');
      console.log(JSON.stringify({ Workbook: names(workbook), Worksheet: names(sheet), Range: names(range), Format: names(range.getFormat()),
        Fill: names(range.getFormat().getFill()), Font: names(range.getFormat().getFont()), Table: names(table), console: names(console) }));
    }`);
    expect(res.error).toBe(null);
    const actual = JSON.parse(res.logs[0].text);
    for (const [owner, methods] of Object.entries(SCRIPT_API)) expect(actual[owner], owner).toEqual(methods.map(([name]) => name).sort());
  });
});
