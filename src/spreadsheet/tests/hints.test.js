import { describe, it, expect } from 'vitest';
import { completionContext, matchFunctions, matchColumns, signatureFor } from '../src/core/formula/hints.js';

describe('completionContext', () => {
  it('sees a function name being typed', () => {
    expect(completionContext('=su')).toEqual({ kind: 'name', prefix: 'su', start: 1 });
    expect(completionContext('=1+AVER')).toEqual({ kind: 'name', prefix: 'AVER', start: 3 });
    expect(completionContext('=IF(A1,su', 9)).toEqual({ kind: 'name', prefix: 'su', start: 7 });
  });

  it('sees a name with a digit in it, since only A1-shaped words are references', () => {
    expect(completionContext('=1+DAYS36')).toEqual({ kind: 'name', prefix: 'DAYS36', start: 3 });
    expect(completionContext('=ATAN2')).toEqual({ kind: 'name', prefix: 'ATAN2', start: 1 });
    expect(completionContext('=BIN2D')).toEqual({ kind: 'name', prefix: 'BIN2D', start: 1 });
    expect(completionContext('=SUM(Q1Sal', 10)).toEqual({ kind: 'name', prefix: 'Q1Sal', start: 5 });
    expect(matchFunctions('DAYS36')).toContain('DAYS360');
    // LOG1 has the shape of a cell reference (column LOG, row 1), so it stays one.
    expect(completionContext('=LOG1')).toBeNull();
  });

  it('does not suggest for references, sheet names, strings, or values', () => {
    expect(completionContext('=A1')).toBeNull();
    expect(completionContext('=$AB12')).toBeNull();
    expect(completionContext('=1E5')).toBeNull();
    expect(completionContext('=Data!A')).toEqual({ kind: 'name', sheet: 'Data', prefix: 'A', start: 6 });
    expect(completionContext('="su')).toBeNull();
    expect(completionContext('hello')).toBeNull();
    expect(completionContext('=')).toBeNull();
    // After a range colon the letters are a reference, so the call hint shows instead.
    expect(completionContext('=SUM(A1:B')).toMatchObject({ kind: 'call', name: 'SUM', argIndex: 0 });
  });

  it('reports the enclosing call and current argument', () => {
    expect(completionContext('=SUM(')).toEqual({ kind: 'call', name: 'SUM', argIndex: 0, start: 1 });
    expect(completionContext('=SUM(A1, B')).toMatchObject({ kind: 'name', prefix: 'B' }); // could be a function
    expect(completionContext('=IF(A1>1, ')).toEqual({ kind: 'call', name: 'IF', argIndex: 1, start: 1 });
    expect(completionContext('=IF(SUM(A1,A2), ')).toEqual({ kind: 'call', name: 'IF', argIndex: 1, start: 1 });
    expect(completionContext('=IF(SUM(A1,', 11)).toEqual({ kind: 'call', name: 'SUM', argIndex: 1, start: 4 });
    expect(completionContext('=TEXT(A1, "a,b", ')).toEqual({ kind: 'call', name: 'TEXT', argIndex: 2, start: 1 });
    expect(completionContext('=SUM(A1)+')).toBeNull();
  });

  it('respects the caret position', () => {
    const text = '=SUM(A1, 2)+MAX(1,2)';
    expect(completionContext(text, 9).argIndex).toBe(1);
    expect(completionContext(text, 9).name).toBe('SUM');
    expect(completionContext(text, 18)).toMatchObject({ name: 'MAX', argIndex: 1 });
  });
});

describe('matchFunctions / signatureFor', () => {
  it('ranks documented functions first and caps the list', () => {
    const list = matchFunctions('s');
    expect(list.length).toBeLessThanOrEqual(8);
    expect(list[0]).toBe('SUM');
    expect(matchFunctions('xlo')).toEqual(['XLOOKUP']);
    expect(matchFunctions('')).toEqual([]);
    expect(matchFunctions('zzz')).toEqual([]);
    expect(matchFunctions('sa', 8, ['Sales', 'salary'])).toEqual(['Sales', 'salary']);
    expect(matchFunctions('s', 3, ['Sales'])[0]).toBe('Sales');
  });

  it('has a fallback signature for every function', () => {
    expect(signatureFor('SUMIF').params).toContain('criteria');
    expect(signatureFor('NOSUCHFUNCTION')).toEqual({ name: 'NOSUCHFUNCTION', params: '...', description: '' });
  });
});

describe('structured reference completion', () => {
  it('knows when a table column is being typed', () => {
    expect(completionContext('=SUM(Sales[Am')).toEqual({ kind: 'column', table: 'Sales', prefix: 'Am', start: 11, atRow: false, wrapped: false });
    expect(completionContext('=[@Qt')).toEqual({ kind: 'column', table: null, prefix: 'Qt', start: 3, atRow: true, wrapped: false });
    expect(completionContext('=Sales[[#Headers],[Pr')).toEqual({ kind: 'column', table: 'Sales', prefix: 'Pr', start: 19, atRow: false, wrapped: true });
    expect(completionContext('=Sales[')).toEqual({ kind: 'column', table: 'Sales', prefix: '', start: 7, atRow: false, wrapped: false });
    expect(completionContext('=Sales[Amount]')).toBeNull();
    expect(completionContext('=Sales[Amount]+su')).toEqual({ kind: 'name', prefix: 'su', start: 15 });
    expect(matchColumns('a', ['Amount', 'Qty', 'Actual'])).toEqual(['Amount', 'Actual']);
    expect(matchColumns('#h', ['Amount'])).toEqual(['#Headers']);
    expect(matchColumns('', ['Amount', 'Qty'])).toEqual(['Amount', 'Qty']);
  });
});
