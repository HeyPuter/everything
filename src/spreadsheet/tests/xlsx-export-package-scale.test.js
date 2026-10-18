import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.restoreAllMocks());

// Each part the .xlsx writer added after the library's own (a table, a drawing, a chart, a picture)
// rebuilt and re-sorted the package's whole directory, so saving a workbook of many tables or sheets
// slowed with the square of their number (2,000 tables took over two seconds). New parts now go in
// as they come, and the directory is built once when the package is written.
it('builds the package directory once, however many tables the workbook has', async () => {
  const count = 300;
  const cells = {};
  const tables = [];
  for (let i = 0; i < count; i++) {
    cells[`${i * 3},0`] = { v: 'Amount' };
    cells[`${i * 3 + 1},0`] = { v: i };
    tables.push({ name: `Table${i}`, range: { r1: i * 3, c1: 0, r2: i * 3 + 1, c2: 0 } });
  }
  const wb = new Workbook({ sheets: [{ name: 'Data', cells, tables }] });
  const rebuilds = vi.spyOn(X.CFB.utils, 'cfb_gc');
  const data = new Uint8Array(await (await workbookToXlsx(wb, { history: false })).arrayBuffer());
  expect(rebuilds.mock.calls.length).toBeLessThan(50);
  const zip = X.CFB.read(data, { type: 'array' });
  expect(zip.FullPaths.filter((p) => /\/xl\/tables\/table\d+\.xml$/.test(p))).toHaveLength(count);
  const back = (await workbookFromFile(data, 'tables.xlsx')).activeSheet;
  expect(back.tables.map((t) => t.name)).toEqual(tables.map((t) => t.name));
  expect(back.tables.at(-1).range).toEqual({ r1: (count - 1) * 3, c1: 0, r2: (count - 1) * 3 + 1, c2: 0 });
});
