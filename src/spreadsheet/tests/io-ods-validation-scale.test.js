import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// A workbook from Excel can carry one dropdown rule per cell of a scattered list (its sqref names
// them one by one), and saving it as .ods looked every cell and every run up against every rule:
// 12,000 such cells took three seconds to save, 20,000 about ten. The rules are now indexed by row and edge.
const book = (count, late = false) => {
  const cells = {};
  for (let r = 0; r < count; r++) cells[`${r},0`] = { v: r };
  const validations = Array.from({ length: count }, (_, i) => ({
    range: { r1: i, c1: 1 + (i % 3), r2: i, c2: 1 + (i % 3) }, type: 'list', source: i % 2 ? 'a,b' : 'x,y',
  }));
  // One rule past the data, over a block, to cover the repeated rows and columns beyond the used range.
  if (late) validations.push({ range: { r1: count + 5, c1: 6, r2: count + 9, c2: 8 }, type: 'list', source: 'late' });
  return new Workbook({ sheets: [{ name: 'Data', cells, validations }] });
};
const timed = async (wb) => {
  const started = performance.now();
  const blob = await workbookToOds(wb, { settings: false });
  return { ms: performance.now() - started, blob };
};

it('saves thousands of single-cell validation rules as .ods in linear time, each on its own cell', async () => {
  // Four times the rules cost about four times the time (under 3x measured); the search took 17x.
  // A ratio, so a busy machine slows both saves alike.
  await timed(book(625));
  const small = await timed(book(2500));
  const count = 10000;
  const large = await timed(book(count, true));
  expect(large.ms).toBeLessThan(small.ms * 7);
  const back = (await workbookFromFile(new Uint8Array(await large.blob.arrayBuffer()), 'scattered.ods')).activeSheet;
  const at = (r, c) => {
    const rule = back.validations.findLast((v) => r >= v.range.r1 && r <= v.range.r2 && c >= v.range.c1 && c <= v.range.c2);
    return rule && { source: [].concat(rule.source).join(',') };
  };
  expect(at(0, 1)?.source).toBe('x,y');
  expect(at(1, 2)?.source).toBe('a,b');
  expect(at(1, 1)).toBeUndefined();
  expect(at(count - 1, 1 + ((count - 1) % 3))?.source).toBe('a,b');
  expect(at(count + 7, 7)?.source).toBe('late');
  expect(at(count + 7, 5)).toBeUndefined();
});
