import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Excel fills "1st Period" on as "2nd Period, 3rd Period, ...". Only a number at the very end of the text
// counted, so "1st Period" was repeated as it was.
function filled(seed, target) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  seed.forEach((v, i) => wb.setInput(id, i, 0, v));
  wb.fill(id, { r1: 0, c1: 0, r2: seed.length - 1, c2: 0 }, parseRange(target));
  const n = parseRange(target);
  return Array.from({ length: n.r2 - n.r1 + 1 }, (_, i) => wb.getValue(id, n.r1 + i, 0));
}

describe('filling ordinal text', () => {
  it('counts on with the suffix each number takes', () => {
    expect(filled(['1st Period'], 'A1:A5')).toEqual(['1st Period', '2nd Period', '3rd Period', '4th Period', '5th Period']);
    expect(filled(['10th'], 'A1:A5')).toEqual(['10th', '11th', '12th', '13th', '14th']);
    expect(filled(['20TH Round'], 'A1:A4')).toEqual(['20TH Round', '21ST Round', '22ND Round', '23RD Round']);
    expect(filled(['Week 1st', 'Week 3rd'], 'A1:A4')).toEqual(['Week 1st', 'Week 3rd', 'Week 5th', 'Week 7th']);
  });

  it('leaves other text with a number inside it repeating', () => {
    expect(filled(['Room 1-A'], 'A1:A3')).toEqual(['Room 1-A', 'Room 1-A', 'Room 1-A']);
    expect(filled(['1stly'], 'A1:A2')).toEqual(['1stly', '1stly']);
  });
});
