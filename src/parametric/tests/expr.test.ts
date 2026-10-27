import { describe, expect, it } from 'vitest';
import { evaluate, evaluateVariables, ExprError, referencedNames } from '../src/model/expr';

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

  it('accepts degree symbol and deg suffix for angles', () => {
    expect(evaluate('45\u00B0', { kind: 'angle' })).toBe(45);
    expect(evaluate('45deg', { kind: 'angle' })).toBe(45);
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
});
