import { describe, it, expect } from 'vitest';
import { TileStore, gridFromImage, readRGBA } from '../src/model/tiles';
import { StrokeSession } from '../src/engine/paint';

const solid = (w: number, h: number, rgba: number[]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};
const tip = { size: 20, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 };

describe('stroke sessions on locked transparency', () => {
  it('Behind and Clear leave a layer with locked transparency unchanged', () => {
    for (const mode of ['behind', 'clear'] as const) {
      const store = new TileStore();
      const base = gridFromImage(store, solid(60, 60, [0, 255, 0, 255]));
      const s = new StrokeSession(store, base, { tip, opacity: 1, flow: 1, target: { kind: 'color', rgb: [255, 0, 0], mode, preserveAlpha: true } });
      s.addPoint(30, 30);
      expect([...readRGBA(store, s.commit(), { x: 30, y: 30, width: 1, height: 1 }).data], mode).toEqual([0, 255, 0, 255]);
    }
  });
});
