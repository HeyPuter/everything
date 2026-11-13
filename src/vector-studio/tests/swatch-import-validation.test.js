import { describe, expect, it } from 'vitest';
import { parseSwatchLibrary, parseSwatchFile } from '../src/features/paint/swatch-libraries.js';
import { paintCss } from '../src/ui/widgets.js';
import { sampleFreeform } from '../src/features/paint/freeform.js';
import { encodeSwatchExchange } from '../src/features/paint/swatch-exchange.js';

const stop = { offset: 0, color: '#123456' };
const point = { x: 0.2, y: 0.3, color: '#123456' };
const parse = (paint) => parseSwatchLibrary(JSON.stringify({ swatches: [{ name: 'Input', paint }] }));

describe('Imported swatch paint validation', () => {
  it.each([
    { type: 'linear', stops: null },
    { type: 'linear', stops: {} },
    { type: 'radial', stops: [null] },
    { type: 'linear', stops: [{ ...stop, offset: 'bad' }] },
    { type: 'linear', stops: [{ offset: 0, color: 17, opacity: 0.5 }] },
    { type: 'linear', stops: [stop], x1: 10 },
    { type: 'radial', stops: [stop], focal: 'bad' },
    { type: 'solid', color: 17 },
    { type: 'solid' },
    { type: 'freeform', points: [null] },
    { type: 'freeform', points: [point], lines: 'bad' },
    { type: 'freeform', points: [point], lines: [[0, 2]] },
    { type: 'pattern', id: 'p', transform: [1, 0] },
  ])('rejects malformed paint %j', (paint) => {
    expect(parse(paint)).toBeNull();
  });
  it('keeps valid entries from a library with malformed gradients and safely previews them', () => {
    const library = parseSwatchLibrary(JSON.stringify({ name: 'Mixed', swatches: [
      { name: 'Broken', paint: { type: 'linear', stops: null } },
      { name: 'Good', paint: { type: 'linear', stops: [stop, { offset: 1, color: '#abcdef', opacity: 0.5 }] } },
    ] }));
    expect(library.swatches.map((s) => s.name)).toEqual(['Good']);
    expect(() => library.swatches.map((s) => paintCss(s.paint))).not.toThrow();
  });
  it('preserves valid gradients, global colors, and pattern definitions', () => {
    const swatches = [
      { name: 'Global', paint: { type: 'solid', color: '#123456' }, global: true, group: 'Brand' },
      { name: 'Linear', paint: { type: 'linear', angle: 30, stops: [{ ...stop, midpoint: 0.3, swatchId: 'global', tint: 0.6 }, { offset: 1, color: '#abcdef', opacity: 0.5 }] } },
      { name: 'Radial', paint: { type: 'radial', aspect: 0.5, focal: [0.2, -0.1], focalRadius: 0.2, x1: 10, y1: 20, x2: 30, y2: 40, stops: [stop] } },
      { name: 'Freeform', paint: { type: 'freeform', mode: 'lines', points: [point, { ...point, x: 0.8, color: '#abcdef', spread: 0.2 }], lines: [[0, 1]] } },
      { name: 'Pattern', paint: { type: 'pattern', id: 'p', transform: [1, 0, 0, 1, 10, 20] }, pattern: { id: 'p', name: 'Pattern', width: 20, height: 20, art: { roots: [], nodes: [] } } },
    ];
    const lib = parseSwatchLibrary(JSON.stringify({ swatches }));
    expect(lib.swatches).toEqual(swatches);
    expect(sampleFreeform(lib.swatches[3].paint, 0.5, 0.5).a).toBe(1);
  });
  it('normalizes valid short and unprefixed hex colors before previewing', () => {
    const paint = parse({ type: 'linear', stops: [{ offset: 0, color: '#abc', opacity: 0.5 }, { offset: 1, color: '123456' }] }).swatches[0].paint;
    expect(paint.stops.map((s) => s.color)).toEqual(['#aabbcc', '#123456']);
    expect(paintCss(paint)).toContain('rgba(170, 187, 204, 0.5)');
  });
  it('still imports valid binary exchange gradients', () => {
    const original = [{ name: 'Gradient', paint: { type: 'linear', angle: 90, stops: [stop, { offset: 1, color: '#abcdef' }] } }];
    const result = parseSwatchFile(encodeSwatchExchange(original), 'example.vswx');
    expect(result.swatches[0].paint.stops.map((s) => s.color)).toEqual(['#123456', '#abcdef']);
    expect(() => paintCss(result.swatches[0].paint)).not.toThrow();
  });
  it('rejects a binary gradient with a non-finite angle', () => {
    const bytes = encodeSwatchExchange([{ name: 'Bad', paint: { type: 'linear', angle: 0, stops: [stop] } }]);
    // Header, type, UTF-8 name length/name, shape, then the angle float.
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(12 + 1 + 2 + 3 + 1, Infinity);
    expect(parseSwatchFile(bytes, 'bad.vswx')).toBeNull();
  });
});
