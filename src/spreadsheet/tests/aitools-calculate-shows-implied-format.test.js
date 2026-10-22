import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const s = wb.activeSheetId;
  const env = { sheetId: () => s, selection: () => ({ sheetId: s, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }) };
  const calc = (formula, sheet) => JSON.parse(runTool(wb, 'calculate', { formula, ...(sheet ? { sheet } : {}) }, env).content);
  return { wb, s, calc };
}

describe('the assistant\'s calculate', () => {
  it('shows a result over dates as a date, as the cell would', () => {
    const { wb, s, calc } = setup();
    wb.setInput(s, 1, 1, '2024-01-02');
    wb.setInput(s, 2, 1, '2024-03-05');
    const latest = calc('=MAX(B2:B3)');
    expect(latest.value).toBe(45356);
    expect(latest.display).toBe(wb.getDisplay(s, 2, 1));
    expect(calc('=TODAY()').display).toMatch(/\d{4}|\//);
    // A date minus a date is a number of days.
    expect(calc('=B3-B2').display).toBe('63');
  });

  it('shows money and percentages in their formats, and plain numbers as before', () => {
    const { wb, s, calc } = setup();
    wb.setInput(s, 0, 0, '$1,234.50');
    wb.setInput(s, 0, 2, '12%');
    wb.setInput(s, 0, 3, '7');
    wb.addSheet('Rates');
    expect(calc('=A1*2').display).toBe('$2,469.00');
    expect(calc('=C1').display).toBe('12%');
    expect(calc('=D1/3').display).toBe('2.333333333');
    // References without a sheet are the sheet the formula is evaluated on.
    wb.setInput(wb.sheetByName('Rates').id, 0, 2, '5');
    expect(calc('=C1', 'Rates').display).toBe('5');
  });
});
