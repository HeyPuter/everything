import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

it('returns the row and column numbers of every cell in a range', () => {
  const data = { A1: '1', A2: '2', A3: '3', A4: '4' };
  expect(calc('SUMPRODUCT((ROW(A1:A4)>2)*A1:A4)', data)).toBe(7);
  expect(calc('SUMPRODUCT(ROW(A1:A4),A1:A4)', data)).toBe(30);
  expect(calc('SUM(ROW(A1:A3))')).toBe(6);
  expect(calc('SUM(COLUMN(A1:C1))')).toBe(6);
  expect(calc('SUM(ROW(B2:C3))')).toBe(5);
  expect(calc('SUM(COLUMN(B2:C3))')).toBe(5);
  expect(calc('MAX(ROW(A5:A9))')).toBe(9);
});

it('keeps single-cell and bare forms scalar', () => {
  expect(calc('ROW(B7)')).toBe(7);
  expect(calc('COLUMN(C5)')).toBe(3);
  expect(calc('ROW()')).toBe(100);
  expect(calc('COLUMN()')).toBe(26);
  expect(calc('ROW(5)')).toEqual({ error: '#VALUE!' });
});

// A whole column numbers the rows it is read to, spilling from a cell as Excel's does (see row-column-whole-line).
it('starts a whole column or row at its first number', () => {
  expect(calc('ROW(A:A)')).toBe(1);
  expect(calc('COLUMN(3:3)')).toBe(1);
});

// A span too long to build is #NUM!, as SEQUENCE answers past its own cap: answering with the
// first row instead made SUM(ROW(A1:A100001)) 1 and MOD(ROW(...)) idioms silently count nothing.
it('answers #NUM! for a span past the array cap, not the first row again', () => {
  expect(calc('SUM(ROW(A1:A100000))')).toBe(5000050000);
  expect(calc('SUM(ROW(A1:A100001))')).toEqual({ error: '#NUM!' });
  expect(calc('ROWS(ROW(A1:A100001))')).toEqual({ error: '#NUM!' });
  expect(calc('SUMPRODUCT(--(MOD(ROW(A1:A100001),2)=0))')).toEqual({ error: '#NUM!' });
  expect(calc('SUM(ROW(A1:A200000))')).toEqual({ error: '#NUM!' });
});

it('numbers every column of a written-out span, however wide', () => {
  expect(calc('SUM(COLUMN(A1:ALM1))')).toBe(501501); // 1,001 columns, past the old 1,000 cap
  expect(calc('COLUMNS(COLUMN(A1:ALM1))')).toBe(1001);
  expect(calc('SUM(COLUMN(A1:XFD1))')).toBe(134225920); // the whole width of the sheet
  expect(calc('SUM(COLUMN(A:C))')).toBe(6);
  expect(calc('SUM(ROW(2:4))')).toBe(9);
});

it('spills when written on its own', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '=ROW(A1:A3)');
  wb.setInput(id, 4, 0, '=COLUMN(A1:C1)');
  expect([0, 1, 2].map((r) => wb.getValue(id, r, 0))).toEqual([1, 2, 3]);
  expect([0, 1, 2].map((c) => wb.getValue(id, 4, c))).toEqual([1, 2, 3]);
  wb.setInput(id, 6, 0, '=ROW(B9)');
  expect(wb.getValue(id, 6, 0)).toBe(9);
  expect(wb.getValue(id, 7, 0)).toBe(null);
});
