import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { calc } from './helpers/calc.js';

// A lambda recursing under its depth cap of 400 can still run the call stack out when its body
// nests calls, and how soon depended on the engine's state: the overflow reached the workbook,
// which took it for a chain of cells and answered #ERROR! or #VALUE!. Running out of stack under
// a lambda calling itself is the recursion going deeper than the engine can run, which is what
// the depth cap reports: #NUM!, whatever the body.
const nest = (k, inner) => (k === 0 ? inner : `SUM(1,${nest(k - 1, inner)})`);
// Functions nested past 64 deep are refused as typed, as Excel refuses them; a file can still hold one.
const stored = (formula) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: null, f: formula } }]);
  return wb.getValue(id, 0, 0);
};

describe('a recursive lambda that runs the call stack out', () => {
  it('is #NUM!, like one past the depth cap', () => {
    expect(stored(`LET(f,LAMBDA(n,IF(n=0,0,${nest(100, 'f(n-1)')})),f(399))`)).toEqual({ error: '#NUM!' });
    expect(calc(`LET(f,LAMBDA(n,IF(n=0,0,${nest(8, 'f(n-1)')})),f(399))`)).toEqual({ error: '#NUM!' });
    expect(calc('LET(f,LAMBDA(n,IF(n=0,0,f(n-1))),f(400))')).toEqual({ error: '#NUM!' });
    // Passing itself along instead of calling itself by name is the same recursion.
    expect(stored(`LET(g,LAMBDA(f,n,IF(n=0,0,${nest(100, 'f(f,n-1)')})),g(g,399))`)).toEqual({ error: '#NUM!' });
  });

  it('is #NUM! for a named lambda too', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    expect(wb.defineName('DEEP', `LAMBDA(n,IF(n=0,0,${nest(100, 'DEEP(n-1)')}))`)).toBeNull();
    wb.setInput(id, 0, 0, '=DEEP(399)');
    wb.setInput(id, 1, 0, '=DEEP(3)');
    expect(wb.getValue(id, 0, 0)).toEqual({ error: '#NUM!' });
    expect(wb.getValue(id, 1, 0)).toBe(300);
  });

  // Light enough for a cold engine, whose interpreted frames are the largest.
  it('still answers when the stack suffices', () => {
    expect(stored(`LET(f,LAMBDA(n,IF(n=0,0,${nest(100, 'f(n-1)')})),f(3))`)).toBe(300);
    expect(calc('LET(f,LAMBDA(n,IF(n=0,0,n+f(n-1))),f(100))')).toBe(5050);
  });
});

describe('a chain of cells each reading the one before through a lambda', () => {
  // Every cell's lambda is one level of the same stack. That overflow is not the lambdas'
  // recursion: the workbook unwinds it and evaluates the chain from its far end.
  it.each([
    ['a LET-bound lambda', (r) => `=LET(f,LAMBDA(x,x+1),f(A${r}))`],
    ['a named lambda', (r) => `=INC(A${r})`],
  ])('is evaluated to its end through %s', (_, formula) => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    expect(wb.defineName('INC', 'LAMBDA(x,x+1)')).toBeNull();
    const rows = 8000;
    wb.setInput(id, 0, 0, '1');
    for (let r = 1; r < rows; r++) wb.setInput(id, r, 0, formula(r));
    expect(wb.getValue(id, rows - 1, 0)).toBe(rows);
  });
});
