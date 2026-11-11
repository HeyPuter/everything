import { describe, expect, it, vi } from 'vitest';
import { layer, newDocument } from '../src/model/document';
import { TileStore, gridFromImage, readRGBA, type TileGrid } from '../src/model/tiles';
import type { Editor } from '../src/editor';

const store = new TileStore();
let committed: TileGrid | undefined;
const target = { kind: 'pixels' as const, layer: layer('pixel', 'Layer', 2, 1), grid: undefined as unknown as TileGrid };
vi.mock('../src/features/pixels', () => ({
  pixelTarget: async () => target,
  commitTarget: (_e: unknown, _t: unknown, grid: TileGrid) => void (committed = grid),
  compositeRGBA: async () => undefined,
  toRGBA8: () => undefined,
}));
// A solid pattern of pure red at half alpha.
vi.mock('../src/features/effects/state', () => ({
  currentPattern: () => ({ id: 'p', name: 'Red', tile: { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 128]) } }),
  effectsState: { patternScale: 1 },
  resolveGradient: () => undefined,
}));

describe('Fill with Pattern, preserving transparency', () => {
  it('mixes the pattern into each pixel by its coverage and keeps the alpha', async () => {
    const { fillWithPattern } = await import('../src/features/effects/commands');
    const doc = newDocument(2, 1);
    // An opaque blue pixel and a quarter-opaque blue pixel.
    target.grid = gridFromImage(store, { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 64]) });
    doc.layers = [target.layer];
    const e = { doc, assets: { tiles: store } } as unknown as Editor;
    await fillWithPattern(e, 1, true);
    const out = readRGBA(store, committed!, { x: 0, y: 0, width: 2, height: 1 }).data;
    // Both pixels take half the pattern color, as Fill with a color does.
    const k = 128 / 255;
    const expected = [255 * k, 0, 255 * (1 - k), 255, 255 * k, 0, 255 * (1 - k), 64];
    for (let i = 0; i < 8; i++) expect(Math.abs(out[i] - expected[i]), `byte ${i}`).toBeLessThanOrEqual(1);
  });
});
