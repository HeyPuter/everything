import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

const sides = (wb, id, r, c) => ['bt', 'bb', 'bl', 'br'].filter(k => wb.styleAt(id, r, c)?.[k]).join(' ');

// A merged cell keeps its block's bottom and right edges on its top-left cell too, for editing and copying it
// whole. Unmerging left them there, so an outline drawn round a merged B2:D4 came back, once the block was
// split, with a box round B2 inside it: a line under B2 and one to its right that nobody drew.
it('splits an outlined merged cell into the outline alone', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const block = { r1: 1, c1: 1, r2: 3, c2: 3 };
  wb.mergeCells(id, block);
  wb.applyBorders(id, block, 'outer', { style: 'thick', color: '#ff0000' });
  wb.unmergeCells(id, block);
  expect(sides(wb, id, 1, 1)).toBe('bt bl');
  expect(wb.styleAt(id, 1, 1)).toMatchObject({ bs: 'thick', bc: '#ff0000' });
  expect(sides(wb, id, 3, 1)).toBe('bb bl');
  expect(sides(wb, id, 1, 3)).toBe('bt br');
  expect(sides(wb, id, 2, 2)).toBe('');
  // One step takes the split back, the anchor's summary with it.
  wb.undo();
  expect(wb.mergeAt(id, 2, 2)).toMatchObject(block);
  expect(sides(wb, id, 1, 1)).toBe('bt bb bl br');
});

it('keeps the lines of a merged row or column that are its own edges', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const row = { r1: 0, c1: 0, r2: 0, c2: 2 };
  wb.mergeCells(id, row);
  wb.applyBorders(id, row, 'outer', { style: 'thin' });
  wb.unmergeCells(id, row);
  expect(sides(wb, id, 0, 0)).toBe('bt bb bl');
  expect(sides(wb, id, 0, 2)).toBe('bt bb br');
  // Inner lines drawn before merging stay when the block is split again.
  const box = { r1: 5, c1: 0, r2: 6, c2: 1 };
  wb.applyBorders(id, box, 'all', { style: 'thin' });
  wb.mergeCells(id, box);
  wb.unmergeCells(id, box);
  expect([sides(wb, id, 5, 0), sides(wb, id, 5, 1), sides(wb, id, 6, 0), sides(wb, id, 6, 1)]).toEqual(['bt bb bl br', 'bt bb bl br', 'bt bb bl br', 'bt bb bl br']);
});
