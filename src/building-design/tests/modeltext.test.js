import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { textStrokes, GLYPHS } from '../src/core/modeltext.js';
import { Scene } from '../src/core/scene.js';

describe('model text', () => {
  it('has a glyph for every letter and digit, and lays letters out on a pitch', () => {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') expect(GLYPHS[ch]?.length).toBeGreaterThan(0);
    const { strokes, width } = textStrokes('Hi 1');
    // Lower case reads as capitals; the space adds width but no strokes.
    expect(strokes.length).toBe(GLYPHS.H.length + GLYPHS.I.length + GLYPHS[1].length);
    expect(width).toBe(6 * 4 - 2);
  });

  it('stands up at its height above the level, or lies flat', () => {
    const { doc, add, L1 } = project();
    const sign = add({ kind: 'modelText', levelId: L1.id, at: [0, 0], rotation: 0, text: 'EXIT', size: 600, depth: 40, plane: 'vertical', offset: 2000 });
    const m = new Scene(doc).mesh(doc.get(sign.id));
    expect(m.bounds.min[2]).toBeGreaterThan(1900);
    expect(m.bounds.max[2]).toBeGreaterThan(2550);
    expect(m.bounds.max[1] - m.bounds.min[1]).toBeLessThan(200);
    const flat = add({ kind: 'modelText', levelId: L1.id, at: [0, 0], rotation: 0, text: 'EXIT', size: 600, depth: 10, plane: 'horizontal', offset: 0 });
    const f = new Scene(doc).mesh(doc.get(flat.id));
    expect(f.bounds.max[2] - f.bounds.min[2]).toBeCloseTo(10, 0);
  });
});
