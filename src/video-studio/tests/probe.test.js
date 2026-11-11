import { describe, it, expect } from 'vitest';
import { svgForRaster, isSvg } from '../src/media/probe.js';

const root = (text) => new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;

describe('SVG pictures', () => {
  it('knows SVG files by type or by name', () => {
    expect(isSvg(new File([''], 'a.svg', { type: '' }))).toBe(true);
    expect(isSvg(new File([''], 'a', { type: 'image/svg+xml' }))).toBe(true);
    expect(isSvg(new File([''], 'a.png', { type: 'image/png' }))).toBe(false);
  });

  it('takes the shape from the viewBox when there is no width and height', () => {
    const out = svgForRaster('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>', 1000);
    expect([out.width, out.height]).toEqual([1000, 500]);
    const r = root(out.text);
    expect([r.getAttribute('width'), r.getAttribute('height'), r.getAttribute('viewBox')]).toEqual(['1000', '500', '0 0 100 50']);
  });

  it('scales a picture with only a width and height through a viewBox of its own units', () => {
    const out = svgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="40px" height="80"><rect width="40" height="80"/></svg>', 400);
    expect([out.width, out.height]).toEqual([200, 400]);
    expect(root(out.text).getAttribute('viewBox')).toBe('0 0 40 80');
  });

  it('completes a missing height from the viewBox, and uses 300 x 150 without either', () => {
    expect(svgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="10" viewBox="0 0 4 2"/>', 100)).toMatchObject({ width: 100, height: 50 });
    expect(svgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="100%"/>', 300)).toMatchObject({ width: 300, height: 150 });
  });

  it('refuses a damaged file or one that is not SVG', () => {
    expect(() => svgForRaster('<svg xmlns="http://www.w3.org/2000/svg"><rect')).toThrow(/damaged/);
    expect(() => svgForRaster('<html></html>')).toThrow(/damaged/);
  });
});
