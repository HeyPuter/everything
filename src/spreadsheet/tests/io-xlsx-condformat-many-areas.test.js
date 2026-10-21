import { expect, it } from 'vitest';
import { readXlsxConditionalFormats } from '../src/core/xlsx-condformat.js';

const styles = { dxfs: [{ bg: '#ffc7ce' }] };
const sheet = (sqref) => `<worksheet><sheetData/><conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting></worksheet>`;
const rows = (count) => Array.from({ length: count }, (_, i) => `A${i * 2 + 1}:XFD${i * 2 + 1}`).join(' ');

// A rule's sqref lists every area it covers, and a sheet edited for years (rows inserted and cut, cells
// pasted) carries rules of thousands of areas. Each area was compared with a fresh copy of all the areas
// before it, and the rule's whole block was searched again for each: such a file took seconds to open and
// as long again to save, growing with the square of the areas (8,000 areas 3 s, 32,000 areas 48 s). Each
// area is now compared only with the kept areas on its rows, and the block is read once.
it('reads a rule of many areas in about the time of their count', () => {
  const xml = sheet(rows(32000));
  const started = performance.now();
  const rules = readXlsxConditionalFormats(xml, styles, null, new Set());
  // Under a second here; the bound leaves room for a busy machine and none for the square.
  expect(performance.now() - started).toBeLessThan(20000);
  expect(rules).toHaveLength(32000);
  expect(rules.at(-1).range).toEqual({ r1: 63998, c1: 0, r2: 63998, c2: 16383 });
});

it('still leaves out an area inside an earlier one, keeping the order of the rest', () => {
  const ranges = (sqref) => readXlsxConditionalFormats(sheet(sqref), styles, null, new Set()).map((rule) => rule.range);
  expect(ranges('B2:D200 C3 A1 C3 E5:E6 B150:C160 A1:A1048576 A70')).toEqual([
    { r1: 1, c1: 1, r2: 199, c2: 3 }, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 4, c1: 4, r2: 5, c2: 4 }, { r1: 0, c1: 0, r2: 1048575, c2: 0 },
  ]);
});
