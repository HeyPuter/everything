import { describe, it, expect } from 'vitest';
import { darkPageRgb, darkPageColor } from '../src/engine/canvas-dark-page.js';

const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe('dark page colors', () => {
  it('turns white paper near-black and black ink near-white, readably', () => {
    const paper = darkPageRgb([255, 255, 255]), ink = darkPageRgb([0, 0, 0]);
    expect(paper).toEqual([28, 28, 28]);
    expect(ink).toEqual([227, 227, 227]);
    expect(contrast(paper, ink)).toBeGreaterThan(10);
  });
  it('keeps grays gray and a color its hue, and keeps ink readable on the paper', () => {
    const [r, g, b] = darkPageRgb([128, 128, 128]);
    expect(r).toBe(g); expect(g).toBe(b);
    const red = darkPageRgb([192, 0, 0]);
    expect(red[0]).toBeGreaterThan(red[1]); expect(red[0]).toBeGreaterThan(red[2]);
    // Dark blue headings and red text stay readable on the dark paper.
    for (const color of [[31, 56, 100], [192, 0, 0], [68, 84, 106]]) expect(contrast(darkPageRgb(color), darkPageRgb([255, 255, 255]))).toBeGreaterThan(4.5);
  });
  it('keeps a color\'s transparency and passes anything it cannot read', () => {
    const parse = value => ({ '#ffffff': [255, 255, 255, 1], 'rgba(0, 0, 0, 0.5)': [0, 0, 0, 0.5] })[value] || null;
    expect(darkPageColor('#ffffff', parse)).toBe('#1c1c1c');
    expect(darkPageColor('rgba(0, 0, 0, 0.5)', parse)).toBe('rgba(227, 227, 227, 0.5)');
    expect(darkPageColor('not a color', parse)).toBe('not a color');
  });
});
