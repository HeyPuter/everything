import { describe, expect, it } from 'vitest';
import { marqueePixels, marqueeRect } from '../src/features/selection';

const at = (x: number, y: number, mods: { shift?: boolean; alt?: boolean } = {}) => ({ x, y, shift: !!mods.shift, alt: !!mods.alt });

describe('marquee rectangle', () => {
  it('draws free rectangles in any direction, squares with Shift and from the center with Alt', () => {
    expect(marqueeRect([300, 250], at(200, 150), 'replace')).toEqual({ x: 200, y: 150, width: 100, height: 100 });
    expect(marqueeRect([10, 10], at(40, 20, { shift: true }), 'replace')).toEqual({ x: 10, y: 10, width: 30, height: 30 });
    expect(marqueeRect([50, 50], at(60, 70, { alt: true }), 'replace')).toEqual({ x: 40, y: 30, width: 20, height: 40 });
  });
  it('keeps a fixed ratio anchored at the start of the drag, in every direction', () => {
    const ratio = { style: 'ratio', width: 2, height: 1 };
    // Dragging up and to the left ends at the start point.
    expect(marqueeRect([300, 250], at(200, 150), 'replace', ratio)).toEqual({ x: 100, y: 150, width: 200, height: 100 });
    expect(marqueeRect([300, 250], at(200, 230), 'replace', ratio)).toEqual({ x: 200, y: 200, width: 100, height: 50 });
    // A vertical drag grows the rectangle too.
    expect(marqueeRect([100, 100], at(101, 250), 'replace', ratio)).toEqual({ x: 100, y: 100, width: 300, height: 150 });
  });
  it('places a fixed size at the pointer (centered with Alt)', () => {
    const size = { style: 'size', width: 50, height: 40 };
    expect(marqueeRect([100, 100], at(100, 100), 'replace', size)).toEqual({ x: 100, y: 100, width: 50, height: 40 });
    expect(marqueeRect([100, 100], at(180, 160), 'replace', size)).toEqual({ x: 180, y: 160, width: 50, height: 40 });
    expect(marqueeRect([100, 100], at(100, 100, { alt: true }), 'replace', size)).toEqual({ x: 75, y: 80, width: 50, height: 40 });
    // Missing or invalid sizes fall back to one pixel.
    expect(marqueeRect([5, 5], at(5, 5), 'replace', { style: 'size', width: 'x', height: -3 })).toEqual({ x: 5, y: 5, width: 1, height: 1 });
  });
});

describe('marquee pixels', () => {
  it('snaps each edge to the nearest pixel boundary', () => {
    // 10.6..21.2 covers pixels 11 to 20, not 11 to 21.
    expect(marqueePixels({ x: 10.6, y: 10.6, width: 10.6, height: 10.6 })).toEqual({ x: 11, y: 11, width: 10, height: 10 });
    expect(marqueePixels({ x: 10.4, y: 0, width: 10.2, height: 3 })).toEqual({ x: 10, y: 0, width: 11, height: 3 });
  });
});
