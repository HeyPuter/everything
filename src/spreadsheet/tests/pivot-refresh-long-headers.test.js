// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot, refreshPivot, refreshablePivotSheets } from '../src/core/pivot.js';
import { insertPivotSheet } from '../src/ui/pivotdialog.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A pivot table's fields were kept as one string constant in a hidden name. ECMA-376 and Excel allow a string
// constant in a formula 255 characters at most, so long headers made a file Excel would repair. The JSON is now
// written as constants of 255 characters or fewer joined with &, a definition too long for a name is not kept, and
// the single constant of files written before is still read.
beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { vi.unstubAllGlobals(); });

function book(header) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [[`Region ${header}`, `Units "${header}"`], ['East', '5'], ['West', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  insertPivotSheet(wb, id, buildPivot(wb, id, { range: { r1: 0, c1: 0, r2: 2, c2: 1 }, rowField: 0, colField: null, valueField: 1, agg: 'sum', filters: [] }));
  return { wb, id, pivot: wb.sheets.at(-1) };
}
const fieldsName = (wb) => wb.names.find((n) => n.name === '_PuterPivot_Fields');
const literals = (formula) => [...formula.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));

it('writes long field headers as constants of 255 characters at most, and reopens and refreshes them', async () => {
  const { wb } = book('é'.repeat(200));
  const formula = fieldsName(wb).ref;
  expect(literals(formula).length).toBeGreaterThan(1);
  expect(Math.max(...literals(formula).map((t) => [...t].length))).toBeLessThanOrEqual(255);
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(bytes, { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/workbook.xml').content);
  const defined = /<definedName[^>]*name="_PuterPivot_Fields"[^>]*>([^<]*)<\/definedName>/.exec(xml)[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  expect(literals(defined).every((t) => [...t].length <= 255)).toBe(true);
  expect(defined.length).toBeLessThan(8192);
  const back = await workbookFromFile(bytes, 'Long.xlsx');
  const [data, pivot] = back.sheets;
  back.insertRows(data.id, 2, 1); back.setInput(data.id, 2, 0, 'North'); back.setInput(data.id, 2, 1, '4');
  expect(refreshablePivotSheets(back)).toEqual([pivot.id]);
  expect(refreshPivot(back, pivot.id)).toEqual({ rows: 3 });
  expect([1, 2, 3, 4].map((r) => back.getValue(pivot.id, r, 0))).toEqual(['East', 'North', 'West', 'Total']);
  expect(literals(fieldsName(back).ref).every((t) => [...t].length <= 255)).toBe(true);
});

it('keeps no definition too long for a name, and reads the single constant written before', () => {
  const { wb, pivot } = book('x'.repeat(5000));
  expect(fieldsName(wb)).toBeUndefined();
  expect(refreshablePivotSheets(wb)).toEqual([]);

  const short = book('');
  const name = fieldsName(short.wb);
  const json = literals(name.ref).join('');
  short.wb.names = short.wb.names.map((n) => (n === name ? { ...n, ref: `"${json.replace(/"/g, '""')}"` } : n));
  expect(refreshablePivotSheets(short.wb)).toEqual([short.pivot.id]);
  expect(refreshPivot(short.wb, short.pivot.id)).toEqual({ rows: 2 });
  expect(pivot).toBeTruthy();
});
