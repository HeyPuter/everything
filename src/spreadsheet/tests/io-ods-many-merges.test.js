import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// The .ods writer searched every merged block for every row and every cell it wrote, so a report that
// merges a few cells on each of its rows slowed down with the square of its length: 20,000 merged
// blocks took about two seconds to save, 40,000 about seven. Merges are now indexed by row.
it('saves tens of thousands of merged blocks as .ods in linear time, each where it was', async () => {
  const count = 40000;
  const cells = {};
  const merges = [];
  for (let i = 0; i < count; i++) {
    cells[`${i * 2},1`] = { v: `Item ${i}` };
    merges.push({ r1: i * 2, c1: 1, r2: i * 2 + (i % 2), c2: 3 });
  }
  const wb = new Workbook({ sheets: [{ name: 'Report', cells, merges }] });
  const started = performance.now();
  const blob = await workbookToOds(wb, { settings: false });
  expect(performance.now() - started).toBeLessThan(3000);
  const back = (await workbookFromFile(new Uint8Array(await blob.arrayBuffer()), 'report.ods')).activeSheet;
  expect(back.merges).toHaveLength(count);
  expect(back.merges).toContainEqual({ r1: 0, c1: 1, r2: 0, c2: 3 });
  expect(back.merges).toContainEqual({ r1: 2, c1: 1, r2: 3, c2: 3 });
  expect(back.merges).toContainEqual({ r1: (count - 1) * 2, c1: 1, r2: (count - 1) * 2 + 1, c2: 3 });
  expect(back.cells.get(`${(count - 1) * 2},1`)?.v).toBe(`Item ${count - 1}`);
});
