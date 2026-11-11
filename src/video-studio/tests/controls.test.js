import { describe, it, expect, afterEach } from 'vitest';
import { sliderField, parseNumber } from '../src/ui/controls.js';

afterEach(() => document.body.replaceChildren());

function type(num, text) {
  num.value = text;
  num.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('slider number box', () => {
  it('reads a decimal comma as a decimal point', () => {
    const got = [];
    const f = sliderField({ label: 'Line height', min: 0.5, max: 3, step: 0.05, decimals: 2, value: 1, onInput: (v) => got.push(v) });
    document.body.append(f.el);
    const num = f.el.querySelector('.num-input');
    type(num, '1,5');
    expect(got.at(-1)).toBe(1.5);
    expect(num.value).toBe('1.50');
    type(num, '−0,75');
    expect(got.at(-1)).toBe(0.5);
  });

  it('parses typed numbers', () => {
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber(' 12.25 ')).toBe(12.25);
    expect(parseNumber('−20')).toBe(-20);
    expect(parseNumber('-3,5%')).toBe(-3.5);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('')).toBeNaN();
    expect(parseNumber('abc')).toBeNaN();
  });
});
