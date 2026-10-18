import { expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { checkAccessibility } from '../src/core/accessibility-check.js';

// The status bar runs the accessibility checker after every pause in editing. On a sheet of tens of thousands
// of coloured cells each pause froze the window for about half a second: every filled cell was put through the
// calculator and the style lookup, and every cell's colours were measured again, though a styled sheet repeats
// a handful of colour pairings. Plain values are now read as stored and each pairing is judged once.
it('reads plain values as stored, without the calculator or a second style lookup', () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 5; c++) cells.push({ r, c, cell: { v: r + c, s: { color: '#fde8e8', bg: r % 2 ? '#ffffff' : '#fef3c7' } } });
  cells.push({ r: 0, c: 9, cell: { f: '=1+1', s: { color: '#ffffff', bg: '#ffffff' } } });
  wb.setCells(id, cells);
  const getValue = vi.spyOn(wb, 'getValue');
  const styleAt = vi.spyOn(wb, 'styleAt');
  const findings = checkAccessibility(wb);
  // Light pink text on white or pale yellow is too faint everywhere; the formula's white on white too.
  expect(findings.filter((f) => f.rule === 'contrast')).toHaveLength(10001);
  expect(getValue).toHaveBeenCalledTimes(1);
  expect(styleAt).not.toHaveBeenCalled();
});

it('still reads the row, column and sheet formats under a cell\'s own', () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }] });
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'a' } }, { r: 1, c: 0, cell: { v: 'b', s: { bg: '#0b0b0b' } } }, { r: 2, c: 1, cell: { v: 'c' } }]);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 1048575, c2: 0 }, { color: '#ffffff' });
  // A1: white on white (column format alone); A2: white on black (its own fill); B3: no colour at all.
  expect(checkAccessibility(wb).filter((f) => f.rule === 'contrast').map((f) => f.label)).toEqual(['A1 (Data)']);
});
