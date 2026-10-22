import { expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';
import { MAX_ROW } from '../src/core/refs.js';

// A SYLK file names each cell's row (C;Y5;X2;K2), and the reader made a list for every row up to the one
// named, so a file of thirty bytes naming row 99,999,999 built a hundred million lists and ran the tab out
// of memory. Only the rows named get one now; a cell past the grid is still left out and counted.

const bytes = (text) => new TextEncoder().encode(text);

it('opens a SYLK file naming a row far past the grid', async () => {
  const wb = await workbookFromFile(bytes('ID;PWXL;N;E\nC;Y1;X1;K1\nC;Y99999999;X1;K2\nE\n'), 'far.slk');
  expect([...wb.sheets[0].cells.keys()]).toEqual(['0,0']);
  expect(wb.importTruncated).toEqual({ rows: 1, cols: 0 });
}, 60000);

it('reads the rows of an ordinary SYLK file where they are, past a gap', async () => {
  const wb = await workbookFromFile(bytes(`ID;PWXL;N;E\nC;Y1;X1;K1\nC;Y5;X2;K2\nC;Y${MAX_ROW + 1};X1;K3\nE\n`), 'gaps.slk');
  const id = wb.activeSheetId;
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 4, 1), wb.getValue(id, MAX_ROW, 0)]).toEqual([1, 2, 3]);
});
