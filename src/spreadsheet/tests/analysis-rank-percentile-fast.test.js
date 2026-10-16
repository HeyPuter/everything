import { it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { rankAndPercentile } from '../src/core/analysis-tools.js';

const v = (cell) => (cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell);

// Rank and Percentile called RANK.EQ and PERCENTRANK.INC with a fresh copy of the column for every point,
// so each call sorted the whole column again: 8,000 values took seconds. It sorts once now, and still
// gives exactly what the worksheet functions give, ties and PERCENTRANK's three-digit truncation included.
it('matches RANK.EQ and PERCENTRANK.INC worked out in the sheet, on random data with ties', () => {
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const n = 300;
  const values = Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 'skip' : i % 5 === 0 ? Math.round(rand() * 1000) / 7 : Math.floor(rand() * 40) - 10));
  const wb = new Workbook();
  const id = wb.activeSheetId;
  values.forEach((x, r) => wb.setInput(id, r, 0, String(x)));
  const range = `$A$1:$A$${n}`;
  values.forEach((_, r) => {
    wb.setInput(id, r, 1, `=RANK.EQ(A${r + 1},${range})`);
    wb.setInput(id, r, 2, `=PERCENTRANK.INC(${range},A${r + 1})`);
  });
  const layout = rankAndPercentile([{ label: 'X', values }]);
  const body = layout.cells.slice(1).map((row) => row.map(v));
  expect(body).toHaveLength(values.filter((x) => typeof x === 'number').length);
  expect(new Set(body.map((row) => row[2])).size).toBeLessThan(body.length); // there are ties
  for (const [point, value, rank, percent] of body) {
    expect(value).toBe(values[point - 1]);
    expect(rank).toBe(wb.getValue(id, point - 1, 1));
    expect(percent).toBe(wb.getValue(id, point - 1, 2));
  }
});

it('ranks a long column quickly', () => {
  const values = Array.from({ length: 40000 }, (_, i) => (i * 7919) % 1000);
  const t = performance.now();
  const layout = rankAndPercentile([{ label: 'A', values }]);
  expect(performance.now() - t).toBeLessThan(5000);
  expect(v(layout.cells[1][2])).toBe(1);
  expect(v(layout.cells[40000][2])).toBe(40000 - 39);
});
