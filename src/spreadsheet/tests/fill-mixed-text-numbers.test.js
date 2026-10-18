import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Excel fills "text1, textA" on as "text2, textA, text3, textA": in a block mixing text that ends in a number
// with other cells, each such text counts on by one with every repeat of the block. Only a block made wholly of
// such texts counted; a mixed one was repeated as it was.
function filled(seed, target, at = 0) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  seed.forEach((v, i) => wb.setInput(id, at + i, 0, v));
  wb.fill(id, { r1: at, c1: 0, r2: at + seed.length - 1, c2: 0 }, parseRange(target));
  const n = parseRange(target);
  return Array.from({ length: n.r2 - n.r1 + 1 }, (_, i) => wb.getValue(id, n.r1 + i, 0));
}

describe('filling a block that mixes counted text with other cells', () => {
  it('counts each text ending in a number on by one per repeat', () => {
    expect(filled(['text1', 'textA'], 'A1:A6')).toEqual(['text1', 'textA', 'text2', 'textA', 'text3', 'textA']);
    expect(filled(['Unit 7', 'East', 'Bay 2'], 'A1:A6')).toEqual(['Unit 7', 'East', 'Bay 2', 'Unit 8', 'East', 'Bay 3']);
  });

  it('counts down when filled upward', () => {
    expect(filled(['text5', 'textA'], 'A1:A6', 4)).toEqual(['text3', 'textA', 'text4', 'textA', 'text5', 'textA']);
  });
});
