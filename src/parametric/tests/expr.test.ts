import { describe, expect, it } from 'vitest';
import { evaluate, evaluateVariables, ExprError, referencedNames, renameReferences, reservedName } from '../src/model/expr';

describe('expression evaluator', () => {
  it('handles precedence, unary minus and powers', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('10 / 4')).toBe(2.5);
  });

  it('supports functions in degrees and constants', () => {
    expect(evaluate('sin(30)')).toBeCloseTo(0.5, 12);
    expect(evaluate('sqrt(16) + abs(-2)')).toBe(6);
    expect(evaluate('max(1, 5, 3)')).toBe(5);
    expect(evaluate('2*pi')).toBeCloseTo(Math.PI * 2, 12);
  });

  it('converts unit suffixes into the display unit', () => {
    // Display unit is inches (25.4 mm); result is returned in mm.
    expect(evaluate('1', { kind: 'length', bareScale: 25.4 })).toBeCloseTo(25.4, 9);
    expect(evaluate('25.4mm', { kind: 'length', bareScale: 25.4 })).toBeCloseTo(25.4, 9);
    expect(evaluate('1in + 10mm', { kind: 'length', bareScale: 1 })).toBeCloseTo(35.4, 9);
    expect(evaluate('1rad', { kind: 'angle' })).toBeCloseTo(57.29578, 4);
  });

  it('accepts the degree sign and rejects stray characters with a readable error', () => {
    expect(evaluate('45°', { kind: 'angle' })).toBe(45);
    expect(evaluate('30° + 15', { kind: 'angle' })).toBe(45);
    expect(evaluate('90 ° / 2', { kind: 'angle' })).toBe(45);
    expect(() => evaluate('45Â°', { kind: 'angle' })).toThrow(ExprError);
  });

  it('looks up variables and rejects unknown names', () => {
    expect(evaluate('W/2 + 1', { lookup: (n) => (n === 'W' ? 10 : undefined) })).toBe(6);
    expect(() => evaluate('Q + 1')).toThrow(ExprError);
    expect(() => evaluate('1 +')).toThrow(ExprError);
    expect(() => evaluate('alert(1)')).toThrow(ExprError);
    expect(() => evaluate('')).toThrow(ExprError);
  });

  it('evaluates variables in dependency order and reports cycles', () => {
    const { values, errors } = evaluateVariables([
      { name: 'B', expr: 'A * 2' },
      { name: 'A', expr: '5' },
      { name: 'X', expr: 'Y + 1' },
      { name: 'Y', expr: 'X + 1' },
    ]);
    expect(values.get('A')).toBe(5);
    expect(values.get('B')).toBe(10);
    expect(errors.has('X') || errors.has('Y')).toBe(true);
  });

  it('lists referenced names', () => {
    expect(referencedNames('Width * 2 + sin(Angle) + 3mm')).toEqual(['Width', 'Angle']);
  });

  it('renames variable references and nothing else', () => {
    const m = new Map([['W', 'Width'], ['in', 'Inside'], ['sin', 'Sine']]);
    expect(renameReferences('W/2 + 3in + "W" - Wx + sin(30) + in', m)).toBe('Width/2 + 3in + "Width" - Wx + sin(30) + Inside');
    expect(renameReferences('2.5e3 * W', m)).toBe('2.5e3 * Width');
  });

  it('takes names like toString or constructor as variables, not as built-ins', () => {
    const lookup = (n: string) => ({ toString: 4, constructor: 5 } as Record<string, number>)[n];
    expect(evaluate('toString * 2', { lookup })).toBe(8);
    expect(evaluate('constructor + 1', { lookup })).toBe(6);
    expect(() => evaluate('valueOf(1)')).toThrow('Unknown function "valueOf"');
    expect(() => evaluate('1 constructor', { kind: 'length', lookup })).toThrow(ExprError);
    expect(referencedNames('toString + 1')).toEqual(['toString']);
  });

  it('checks how many values a function takes', () => {
    expect(() => evaluate('round(2.567, 2)')).toThrow('round() takes one value');
    expect(() => evaluate('sin()')).toThrow('sin() takes one value');
    expect(() => evaluate('max()')).toThrow('max() takes one or more values');
    expect(evaluate('max(1, 5, 3) + min(2)')).toBe(7);
  });

  it('reports a division by zero, even inside a larger expression', () => {
    expect(() => evaluate('W / (N - 1)', { lookup: (n) => (n === 'W' ? 10 : 1) })).toThrow('Division by zero');
    expect(() => evaluate('1 / (1 / 0)')).toThrow('Division by zero');
    expect(evaluate('0 / 5')).toBe(0);
  });

  it('says a unit cannot be used where a plain number goes', () => {
    expect(() => evaluate('50mm')).toThrow('A unit ("mm") cannot be used here; give a plain number');
    expect(evaluateVariables([{ name: 'W', expr: '2 in' }]).errors.get('W')).toMatch(/unit \("in"\)/);
    expect(evaluate('50mm', { kind: 'length' })).toBe(50);
  });

  it('reserves the names a variable would be shadowed by or confused with', () => {
    // A variable "pi" evaluated to its own value but =pi*2 used the constant.
    expect(evaluateVariables([{ name: 'pi', expr: '3' }, { name: 'b', expr: 'pi*2' }]).values.get('b')).toBeCloseTo(2 * Math.PI);
    for (const n of ['pi', 'PI', 'm', 'mm', 'in', 'deg', 'rad', 'sqrt', 'min']) expect(reservedName(n), n).toBe(true);
    for (const n of ['Width', 'Pi', 'M', 'Min', 'constructor', 'toString', 'x']) expect(reservedName(n), n).toBe(false);
  });
});
