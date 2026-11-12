import { describe, it, expect } from 'vitest';
import { parseCssColor } from '../src/lib/color.js';
import { svgToDocument } from '../src/features/io/svg-import.js';

describe('CSS color parsing', () => {
  it('rejects malformed rgb() and hsl() colors instead of throwing or storing NaN', () => {
    expect(parseCssColor('rgb(10,20)')).toBeNull();
    expect(parseCssColor('rgb(a, b, c)')).toBeNull();
    expect(parseCssColor('hsl(120)')).toBeNull();
  });

  it('reads the none keyword and hue units', () => {
    expect(parseCssColor('rgb(none 20 30)')).toEqual({ hex: '#00141e', alpha: 1 });
    expect(parseCssColor('hsl(0.5turn 100% 50%)').hex).toBe('#00ffff');
    expect(parseCssColor('hsl(180deg, 100%, 50%)').hex).toBe('#00ffff');
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ hex: '#0a141e', alpha: 0.5 });
  });

  it('keeps SVG shapes whose fill is malformed (drawn black, as browsers do)', () => {
    const doc = svgToDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<rect width="10" height="10" fill="rgb(10,20)"/>' +
        '<rect x="20" width="10" height="10" fill="rgb(none 20 30)"/></svg>',
    );
    const fills = [];
    doc.walk((n) => {
      if (n.type === 'path') fills.push(n.fill.color);
    });
    expect(fills).toEqual(['#000000', '#00141e']);
  });
});
