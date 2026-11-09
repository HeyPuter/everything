import { describe, it, expect } from 'vitest';
import { parsePointInput, matchOption, opts } from '../src/editor/input.js';
import { defaultHeader } from '../src/core/schema.js';

const header = defaultHeader();
const last = { x: 10, y: 20 };
const close = (p, x, y) => {
  expect(p.kind).toBe('point');
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

describe('parsePointInput', () => {
  it('reads absolute points', () => {
    close(parsePointInput('3,4', { last, header }), 3, 4);
    close(parsePointInput('#3,4', { last, header }), 3, 4);
    close(parsePointInput(' -1.5 , 2e1 ', { last, header }), -1.5, 20);
  });

  it('reads relative points', () => {
    close(parsePointInput('@5,-5', { last, header }), 15, 15);
    close(parsePointInput('@', { last, header }), 10, 20);
  });

  it('reads polar points', () => {
    close(parsePointInput('@10<90', { last, header }), 10, 30);
    close(parsePointInput('10<0', { last, header }), 10, 0);
  });

  it('reads a bare distance for direct entry', () => {
    expect(parsePointInput('25', { last, header })).toEqual({ kind: 'distance', d: 25 });
  });

  it('reads an angle lock', () => {
    const p = parsePointInput('<45', { last, header });
    expect(p.kind).toBe('angle');
    expect(p.a).toBeCloseTo(Math.PI / 4, 12);
  });

  it('ignores a z coordinate', () => {
    close(parsePointInput('1,2,3', { last, header }), 1, 2);
  });

  it('reports empty and invalid input', () => {
    expect(parsePointInput('  ', { header }).kind).toBe('empty');
    expect(parsePointInput('abc', { header }).kind).toBe('invalid');
    expect(parsePointInput('1,x', { header }).kind).toBe('invalid');
  });

  it('prefers keyword options', () => {
    const options = opts('Close', 'Undo');
    expect(parsePointInput('c', { header, options })).toEqual({ kind: 'option', option: 'close' });
  });
});

describe('options', () => {
  it('builds keys from labels', () => {
    expect(opts('Close', 'eXit')).toEqual([
      { key: 'C', label: 'Close', value: 'close' },
      { key: 'X', label: 'Exit', value: 'exit' },
    ]);
  });

  it('matches keys and unique label prefixes', () => {
    const o = [...opts('Arc', 'Close'), { key: 'U', label: 'Undo', value: 'undo' }];
    expect(matchOption('a', o)).toBe('arc');
    expect(matchOption('clo', o)).toBe('close');
    expect(matchOption('UNDO', o)).toBe('undo');
    expect(matchOption('z', o)).toBeNull();
  });

  it('does not guess between ambiguous prefixes', () => {
    const o = [
      { key: 'X', label: 'Center', value: 'center' },
      { key: 'Y', label: 'Close', value: 'close' },
    ];
    expect(matchOption('c', o)).toBeNull();
    expect(matchOption('ce', o)).toBe('center');
  });

  it('takes a whole label even when it starts other labels', () => {
    const o = [
      { key: 'M', label: 'Middle', value: 'center|middle' },
      { key: 'ML', label: 'Middle left', value: 'left|middle' },
      { key: 'MC', label: 'Middle center', value: 'center|middle' },
    ];
    expect(matchOption('Middle', o)).toBe('center|middle');
    expect(matchOption('middle l', o)).toBe('left|middle');
    expect(matchOption('mid', o)).toBeNull();
  });
});
