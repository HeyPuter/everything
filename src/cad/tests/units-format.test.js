import { describe, expect, it } from 'vitest';
import { defaultHeader } from '../src/core/schema.js';
import { formatAngle, formatLinear, formatNumber, parseAngle, parseLength } from '../src/core/units.js';

const DEG = Math.PI / 180;
const inch = { ...defaultHeader(), units: 'in' };

describe('formatNumber', () => {
  it('pads or trims decimals', () => {
    expect(formatNumber(12.5, 4)).toBe('12.5000');
    expect(formatNumber(12.5, 4, true)).toBe('12.5');
    expect(formatNumber(100, 2, true)).toBe('100');
    expect(formatNumber(0.1 + 0.2, 2)).toBe('0.30');
    expect(formatNumber(3, 0)).toBe('3');
  });

  it('never shows negative zero', () => {
    expect(formatNumber(-0.0001, 2)).toBe('0.00');
    expect(formatNumber(-0.0001, 2, true)).toBe('0');
  });
});

describe('formatLinear', () => {
  it('formats decimal with the header precision', () => {
    expect(formatLinear(12.5, defaultHeader())).toBe('12.5000');
    expect(formatLinear(12.5, { format: 'decimal', precision: 2 })).toBe('12.50');
    expect(formatLinear(-3, { format: 'decimal', precision: 1 })).toBe('-3.0');
  });

  it('formats architectural feet and inches', () => {
    const o = { format: 'architectural', precision: 4 };
    expect(formatLinear(40.5, o)).toBe('3\'-4 1/2"');
    expect(formatLinear(36, o)).toBe('3\'-0"');
    expect(formatLinear(4.5, o)).toBe('4 1/2"');
    expect(formatLinear(0.25, o)).toBe('1/4"');
    expect(formatLinear(-40.5, o)).toBe('-3\'-4 1/2"');
    expect(formatLinear(11.99, { format: 'architectural', precision: 2 })).toBe('1\'-0"');
    expect(formatLinear(1 / 256, { format: 'architectural', precision: 8 })).toBe('1/256"');
    expect(formatLinear(12.5, o)).toBe('1\'-0 1/2"');
    expect(formatLinear(-24.0625, o)).toBe('-2\'-0 1/16"');
  });

  it('formats engineering feet and decimal inches', () => {
    expect(formatLinear(40.5, { format: 'engineering', precision: 2 })).toBe('3\'-4.50"');
    expect(formatLinear(6.25, { format: 'engineering', precision: 2 })).toBe('6.25"');
  });

  it('formats fractional', () => {
    const o = { format: 'fractional', precision: 4 };
    expect(formatLinear(4.5, o)).toBe('4 1/2');
    expect(formatLinear(0.375, o)).toBe('3/8');
    expect(formatLinear(4, o)).toBe('4');
    expect(formatLinear(4.03, { format: 'fractional', precision: 1 })).toBe('4');
  });

  it('formats scientific', () => {
    expect(formatLinear(12.5, { format: 'scientific', precision: 4 })).toBe('1.2500E+01');
    expect(formatLinear(0.00125, { format: 'scientific', precision: 2 })).toBe('1.25E-03');
  });
});

describe('formatAngle', () => {
  it('formats the four angle formats', () => {
    expect(formatAngle(30 * DEG, { angularFormat: 'deg', angularPrecision: 0 })).toBe('30');
    expect(formatAngle(30.5 * DEG, { angularFormat: 'deg', angularPrecision: 2 })).toBe('30.50');
    expect(formatAngle((12 + 30 / 60 + 15 / 3600) * DEG, { angularFormat: 'dms', angularPrecision: 4 })).toBe('12d30\'15"');
    expect(formatAngle(30 * DEG, { angularFormat: 'rad', angularPrecision: 4 })).toBe('0.5236r');
    expect(formatAngle(12.5 * DEG, { angularFormat: 'grad', angularPrecision: 2 })).toBe('13.89g');
  });

  it('shows dms at the requested precision', () => {
    const a = (12 + 30 / 60 + 15 / 3600) * DEG;
    expect(formatAngle(a, { angularFormat: 'dms', angularPrecision: 0 })).toBe('13d');
    expect(formatAngle(a, { angularFormat: 'dms', angularPrecision: 2 })).toBe('12d30\'');
    expect(formatAngle(a, { angularFormat: 'dms', angularPrecision: 6 })).toBe('12d30\'15.00"');
  });

  it('uses degree signs on request', () => {
    expect(formatAngle(Math.PI / 2, { angularFormat: 'deg' }, { symbol: true })).toBe('90°');
    expect(formatAngle(Math.PI / 4, { angularFormat: 'dms', angularPrecision: 2 }, { symbol: true })).toBe('45°0\'');
  });
});

describe('parseLength', () => {
  it('parses numbers, fractions and mixed numbers', () => {
    expect(parseLength('12.5')).toBe(12.5);
    expect(parseLength('.5')).toBe(0.5);
    expect(parseLength('-3')).toBe(-3);
    expect(parseLength('3/4')).toBe(0.75);
    expect(parseLength('1-1/2')).toBe(1.5);
    expect(parseLength('1 1/2')).toBe(1.5);
    expect(parseLength('-1-1/2')).toBe(-1.5);
    expect(parseLength('1.25E+01')).toBe(12.5);
    expect(parseLength('2e-3')).toBe(0.002);
  });

  it('parses feet and inches in inch drawings', () => {
    expect(parseLength('3\'4"', inch)).toBe(40);
    expect(parseLength('3\'-4 1/2"', inch)).toBe(40.5);
    expect(parseLength('3\' 4-1/2"', inch)).toBe(40.5);
    expect(parseLength('5\'', inch)).toBe(60);
    expect(parseLength('4.5"', inch)).toBe(4.5);
    expect(parseLength('-2\'6"', inch)).toBe(-30);
    expect(parseLength('1.5\'', inch)).toBe(18);
  });

  it('rejects feet and inches in metric drawings', () => {
    expect(parseLength('3\'4"', defaultHeader())).toBeNaN();
    expect(parseLength('5\'', { units: 'mm' })).toBeNaN();
  });

  it('rejects junk', () => {
    expect(parseLength('')).toBeNaN();
    expect(parseLength('abc')).toBeNaN();
    expect(parseLength('1/0')).toBeNaN();
    expect(parseLength('3\'x"', inch)).toBeNaN();
    expect(parseLength('1..2')).toBeNaN();
  });

  it('round-trips the formats', () => {
    const arch = { ...inch, linearFormat: 'architectural', linearPrecision: 4 };
    for (const v of [40.5, 0.25, 123.4375, 12, 0, 12.5]) expect(parseLength(formatLinear(v, arch), arch)).toBeCloseTo(v, 9);
    const eng = { ...inch, linearFormat: 'engineering', linearPrecision: 2 };
    for (const v of [40.5, 7.25, 100.75]) expect(parseLength(formatLinear(v, eng), eng)).toBeCloseTo(v, 9);
    const frac = { linearFormat: 'fractional', linearPrecision: 3 };
    for (const v of [4.5, 0.375, 10.125]) expect(parseLength(formatLinear(v, frac), frac)).toBeCloseTo(v, 9);
    const sci = { linearFormat: 'scientific', linearPrecision: 4 };
    for (const v of [12.5, 0.00125, 98765]) expect(parseLength(formatLinear(v, sci), sci)).toBeCloseTo(v, 9);
    for (const v of [1.2345, -7.5]) expect(parseLength(formatLinear(v, defaultHeader()))).toBeCloseTo(v, 9);
  });
});

describe('parseAngle', () => {
  it('parses degrees by default', () => {
    expect(parseAngle('30')).toBeCloseTo(30 * DEG, 12);
    expect(parseAngle('-45.5')).toBeCloseTo(-45.5 * DEG, 12);
    expect(parseAngle('90', defaultHeader())).toBeCloseTo(Math.PI / 2, 12);
  });

  it('parses degrees, minutes and seconds', () => {
    const v = (30 + 15 / 60 + 10 / 3600) * DEG;
    expect(parseAngle('30d15\'10"')).toBeCloseTo(v, 12);
    expect(parseAngle('30°15\'10"')).toBeCloseTo(v, 12);
    expect(parseAngle('30d 15\' 10"')).toBeCloseTo(v, 12);
    expect(parseAngle('30d15\'')).toBeCloseTo((30 + 0.25) * DEG, 12);
    expect(parseAngle('30d')).toBeCloseTo(30 * DEG, 12);
    expect(parseAngle('-30d30\'')).toBeCloseTo(-30.5 * DEG, 12);
  });

  it('parses radians and grads', () => {
    expect(parseAngle('1.2r')).toBeCloseTo(1.2, 12);
    expect(parseAngle('50g')).toBeCloseTo(Math.PI / 4, 12);
    expect(parseAngle('100G')).toBeCloseTo(Math.PI / 2, 12);
  });

  it('reads bare numbers in the header unit', () => {
    expect(parseAngle('1.5', { angularFormat: 'rad' })).toBeCloseTo(1.5, 12);
    expect(parseAngle('100', { angularFormat: 'grad' })).toBeCloseTo(Math.PI / 2, 12);
    expect(parseAngle('10', { angularFormat: 'dms' })).toBeCloseTo(10 * DEG, 12);
  });

  it('rejects junk', () => {
    expect(parseAngle('')).toBeNaN();
    expect(parseAngle('abc')).toBeNaN();
    expect(parseAngle('12x')).toBeNaN();
    expect(parseAngle('r')).toBeNaN();
  });

  it('round-trips the formats', () => {
    for (const fmt of ['deg', 'dms', 'rad', 'grad']) {
      const h = { angularFormat: fmt, angularPrecision: fmt === 'dms' ? 4 : 6 };
      for (const a of [0.5, 1.25, -0.75]) {
        const tol = fmt === 'dms' ? 1e-5 : 1e-5;
        expect(Math.abs(parseAngle(formatAngle(a, h), h) - a)).toBeLessThan(tol);
      }
    }
  });
});
