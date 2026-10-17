import { describe, expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// XLOOKUP answers with the cells it finds in a return reference, as INDEX does, so it can end a
// range (Microsoft's own SUM(XLOOKUP(...):XLOOKUP(...)) example) and feeds ROW, CELL and ISREF.
const DATA = { A1: 'Jan', A2: 'Feb', A3: 'Mar', A4: 'Apr', B1: 10, B2: 20, B3: 30, B4: 40, C1: 1, C2: 2, C3: 3, C4: 4, E1: 'h1', F1: 'h2' };

describe('XLOOKUP as a reference', () => {
  it('spans a range between two lookups', () => {
    expect(calc('SUM(XLOOKUP("Feb",A1:A4,B1:B4):XLOOKUP("Mar",A1:A4,B1:B4))', DATA)).toBe(50);
    expect(calc('SUM(B1:XLOOKUP("Mar",A1:A4,B1:B4))', DATA)).toBe(60);
    expect(calc('SUM(XLOOKUP("Feb",A:A,B:B):B4)', DATA)).toBe(90);
  });

  it('hands its address to reference consumers', () => {
    expect(calc('ROW(XLOOKUP("Mar",A1:A4,B1:B4))', DATA)).toBe(3);
    expect(calc('CELL("address",XLOOKUP("Feb",A1:A4,B1:B4))', DATA)).toBe('$B$2');
    expect(calc('ISREF(XLOOKUP("Feb",A1:A4,B1:B4))', DATA)).toBe(true);
    expect(calc('COLUMN(XLOOKUP("h2",E1:F1,E1:F1))', DATA)).toBe(6);
    expect(calc('ROWS(XLOOKUP("Feb",A1:A4,B1:C4))', DATA)).toBe(1);
    expect(calc('COLUMNS(XLOOKUP("Feb",A1:A4,B1:C4))', DATA)).toBe(2);
  });

  it('still answers values, and values alone for an array with no address', () => {
    expect(calc('XLOOKUP("Feb",A1:A4,B1:B4)+1', DATA)).toBe(21);
    expect(calc('XLOOKUP("Zzz",A1:A4,B1:B4,"none")', DATA)).toBe('none');
    expect(calc('SUM(XLOOKUP({"Jan";"Feb"},A1:A4,B1:B4))', DATA)).toBe(30);
    expect(calc('SUM(XLOOKUP("Feb",A1:A4,B1:C4))', DATA)).toBe(22);
    expect(calc('XLOOKUP("Feb",A1:A4,{1;2;3;4})', DATA)).toBe(2);
    expect(calc('ISREF(XLOOKUP("Feb",A1:A4,{1;2;3;4}))', DATA)).toBe(false);
  });
});
