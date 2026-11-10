// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { drawPreview } from '../src/ui/preview.js';

describe('drawPreview', () => {
  it('leaves a canvas without a 2D context alone instead of throwing', () => {
    // A browser can refuse a context (too many canvases, a lost GPU process); jsdom has none.
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    const d = new Drawing();
    const line = { id: 1, type: 'line', layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, x1: 0, y1: 0, x2: 5, y2: 5 };
    expect(() => drawPreview(canvas, d, [line])).not.toThrow();
  });
});
