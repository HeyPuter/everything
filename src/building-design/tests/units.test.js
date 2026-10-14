import { describe, it, expect } from 'vitest';
import { formatImperial, formatMetric, formatLength, formatDimension, parseLength, parseAngle, formatArea, MM_PER_FOOT, MM_PER_INCH } from '../src/core/units.js';

const IMP = { system: 'imperial', fraction: 8 };
const MET = { system: 'metric', metric: 'mm', decimals: 0 };

describe('formatting', () => {
  it('formats feet and inches with reduced fractions', () => {
    expect(formatImperial(10 * MM_PER_FOOT + 6.5 * MM_PER_INCH)).toBe(`10' - 6 1/2"`);
    expect(formatImperial(0)).toBe(`0' - 0"`);
    expect(formatImperial(MM_PER_INCH * 0.25)).toBe(`0' - 0 1/4"`);
    expect(formatImperial(-MM_PER_FOOT)).toBe(`-1' - 0"`);
  });

  it('rounds to the nearest fraction and carries into feet', () => {
    expect(formatImperial(MM_PER_FOOT - 0.1)).toBe(`1' - 0"`);
  });

  it('formats metric lengths', () => {
    expect(formatMetric(1234.4)).toBe('1234');
    expect(formatMetric(1234, 'm')).toBe('1.234 m');
    expect(formatMetric(1500, 'cm')).toBe('150 cm');
    expect(formatLength(3000, MET)).toBe('3000');
    expect(formatDimension(3000, { system: 'metric', metric: 'm' })).toBe('3.00');
  });

  it('formats areas', () => {
    expect(formatArea(12e6, MET)).toBe('12.00 m²');
    expect(formatArea(100 * MM_PER_FOOT * MM_PER_FOOT, IMP)).toBe('100 SF');
  });
});

describe('parsing', () => {
  it('parses feet and inches in many spellings', () => {
    const v = 10 * MM_PER_FOOT + 6 * MM_PER_INCH;
    for (const s of [`10' 6"`, `10'-6"`, `10' - 6"`, `10'6"`, `10ft 6in`]) expect(parseLength(s, IMP)).toBeCloseTo(v, 6);
    expect(parseLength(`6 1/2"`, IMP)).toBeCloseTo(6.5 * MM_PER_INCH, 6);
    expect(parseLength(`1/2"`, IMP)).toBeCloseTo(0.5 * MM_PER_INCH, 6);
  });

  it('reads bare numbers in the project unit', () => {
    expect(parseLength('12', IMP)).toBeCloseTo(12 * MM_PER_FOOT, 6);
    expect(parseLength('2400', MET)).toBe(2400);
    expect(parseLength('2.4', { system: 'metric', metric: 'm' })).toBeCloseTo(2400, 6);
  });

  it('accepts explicit metric units and arithmetic', () => {
    expect(parseLength('3.2m', IMP)).toBeCloseTo(3200, 6);
    expect(parseLength('350 cm', MET)).toBeCloseTo(3500, 6);
    expect(parseLength('3000 + 250', MET)).toBe(3250);
    expect(parseLength('3000 - 250', MET)).toBe(2750);
  });

  it('rejects junk', () => {
    expect(parseLength('abc', MET)).toBeNaN();
    expect(parseLength('', MET)).toBeNaN();
  });

  it('parses angles', () => {
    expect(parseAngle('90')).toBeCloseTo(Math.PI / 2);
    expect(parseAngle('45°')).toBeCloseTo(Math.PI / 4);
    expect(parseAngle('x')).toBeNaN();
  });
});
