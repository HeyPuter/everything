import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import * as XLSX from '../src/vendor/xlsx.mjs';
import { workbookFromFile } from '../src/core/io.js';

function file(rows) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body><office:spreadsheet><table:table table:name="Data">${rows}</table:table></office:spreadsheet></office:body>
</office:document>`;
}
const read = (rows) => workbookFromFile(new TextEncoder().encode(file(rows)), 'repeats.fods');
// The reader's own reason for the refusal, which the message shown to the person keeps as its cause.
const reason = (promise) => promise.then(() => 'accepted', (error) => error.cause?.message || error.message);

it.each(['row', 'column', 'covered column'])(
  'rejects an overflowing %s repeat without hanging', (axis) => {
    const count = '9'.repeat(310);
    const rows = axis === 'row'
      ? `<table:table-row table:number-rows-repeated="${count}"><table:table-cell office:value-type="float" office:value="7"/></table:table-row>`
      : `<table:table-row><table:${axis === 'column' ? 'table-cell office:value-type="float" office:value="7"' : 'covered-table-cell'} table:number-columns-repeated="${count}"/></table:table-row>`;
    // A separate process makes the original infinite loops safe to reproduce.
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', `
      import { workbookFromFile } from './src/core/io.js';
      try { await workbookFromFile(new TextEncoder().encode(${JSON.stringify(file(rows))}), 'repeats.fods'); console.log('accepted'); }
      catch (error) { console.log(error.cause?.message || error.message); }
    `], { cwd: new URL('../', import.meta.url), timeout: 2000, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ODS (row|column) repeat/);
  },
);

it.each(['row', 'column'].flatMap((axis) =>
  ['', '0', '-1', '1.5', '2oops', '1e3', 'NaN', 'Infinity', '9'.repeat(310)].map((count) => ({ axis, count })),
))('rejects malformed $axis repeat $count even on blank runs', async ({ axis, count }) => {
  const rows = axis === 'row'
    ? `<table:table-row table:number-rows-repeated="${count}"><table:table-cell/></table:table-row>`
    : `<table:table-row><table:table-cell table:number-columns-repeated="${count}"/></table:table-row>`;
  expect(await reason(read(rows))).toMatch(/ODS (row|column) repeat/);
});

it.each([
  '<table:table-row table:number-rows-repeated="1048577"><table:table-cell/></table:table-row>',
  '<table:table-row><table:table-cell table:number-columns-repeated="16385"/></table:table-row>',
  '<table:table-row><table:table-cell/></table:table-row><table:table-row table:number-rows-repeated="1048576"><table:table-cell/></table:table-row>',
  '<table:table-row><table:table-cell/><table:table-cell table:number-columns-repeated="16384"/></table:table-row>',
  '<table:table-row><table:table-cell table:number-columns-repeated="16383"/><table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="2"/></table:table-row>',
  '<table:table-row><table:table-cell table:number-columns-repeated="16383"/><table:covered-table-cell table:number-columns-repeated="2"/></table:table-row>',
])('rejects repeat counts extending beyond the supported grid: %s', async (rows) => {
  expect(await reason(read(rows))).toMatch(/ODS (row|column) repeat/);
});

it.each(['2', '0002', '+2', ' 2 ', '&#50;'])('accepts the valid integer spelling %s for repeat counts', async (count) => {
  const wb = await read(`<table:table-row table:number-rows-repeated="${count}"><table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="${count}"/></table:table-row>`);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) expect(wb.getValue(wb.activeSheetId, r, c)).toBe(7);
});

it('accepts compact blank runs up to the last supported row and column', () => {
  const bytes = new TextEncoder().encode(file(`<table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row>
    <table:table-row><table:table-cell table:number-columns-repeated="16383"/><table:table-cell office:value-type="float" office:value="7"/></table:table-row>`));
  const sheet = XLSX.read(bytes, { type: 'array', sheetStubs: true }).Sheets.Data;
  expect(sheet['!ref']).toBe('XFD1048576');
  expect(sheet.XFD1048576).toMatchObject({ t: 'n', v: 7 });
  expect(Object.keys(sheet).filter((key) => !key.startsWith('!'))).toEqual(['XFD1048576']);
});
