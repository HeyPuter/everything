import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Excel continues "Qtr3 (or Q3 or Quarter3)" as Qtr4, Qtr1, Qtr2. Only Q3 wrapped round; Qtr3 and
// Quarter3 were counted as text with a number, on to Qtr5 and Quarter5.
function filled(seed, target) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, seed);
  wb.fill(id, parseRange('A1'), parseRange(target));
  const n = parseRange(target);
  return Array.from({ length: n.r2 - n.r1 + 1 }, (_, i) => wb.getValue(id, n.r1 + i, 0));
}

describe('filling quarter names', () => {
  it('wraps Qtr and Quarter round after the fourth, keeping the spelling and case', () => {
    expect(filled('Qtr3', 'A1:A5')).toEqual(['Qtr3', 'Qtr4', 'Qtr1', 'Qtr2', 'Qtr3']);
    expect(filled('Quarter3', 'A1:A4')).toEqual(['Quarter3', 'Quarter4', 'Quarter1', 'Quarter2']);
    expect(filled('Quarter 4', 'A1:A3')).toEqual(['Quarter 4', 'Quarter 1', 'Quarter 2']);
    expect(filled('QTR 2', 'A1:A4')).toEqual(['QTR 2', 'QTR 3', 'QTR 4', 'QTR 1']);
    expect(filled('Q3', 'A1:A3')).toEqual(['Q3', 'Q4', 'Q1']);
  });

  it('still counts on other text ending in a number', () => {
    expect(filled('Qtr5', 'A1:A3')).toEqual(['Qtr5', 'Qtr6', 'Qtr7']);
    expect(filled('Week 4', 'A1:A3')).toEqual(['Week 4', 'Week 5', 'Week 6']);
  });
});
