import { describe, expect, it } from 'vitest';
import { colToLetters, createWorksheet, lettersToCol, parseAddress } from '../src/engine/worksheet.js';

describe('worksheet host', () => {
  it('maps columns and addresses', () => {
    expect(colToLetters(0)).toBe('A');
    expect(colToLetters(25)).toBe('Z');
    expect(colToLetters(26)).toBe('AA');
    expect(lettersToCol('C')).toBe(2);
    expect(parseAddress('b12')).toEqual({ col: 1, row: 11, key: 'B12' });
  });

  it('stores cell values', () => {
    const ws = createWorksheet();
    ws.set('A1', 42);
    expect(ws.get('A1')).toBe(42);
    expect(ws.get('B1')).toBe('');
  });
});
