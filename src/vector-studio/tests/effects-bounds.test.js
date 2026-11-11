import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { visualBounds } from '../src/model/geometry.js';
import { effectsMargin } from '../src/render/effects.js';

const solid = (color) => ({ type: 'solid', color });

describe('raster effect layers', () => {
  it('keep the artwork a shadow, blur or glow reads from when the object runs off screen', () => {
    // At 400% a shadow 40pt to the right comes from artwork 160 device px to its left.
    expect(effectsMargin([{ type: 'dropShadow', x: 40, y: 0, blur: 0 }], 4)).toBeGreaterThanOrEqual(160);
    expect(effectsMargin([{ type: 'dropShadow', x: 0, y: -30, blur: 10 }], 2)).toBeGreaterThanOrEqual(2 * (30 + 15));
    expect(effectsMargin([{ type: 'blur', radius: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'outerGlow', blur: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'innerGlow', blur: 10 }], 4)).toBeGreaterThanOrEqual(120);
    expect(effectsMargin([{ type: 'feather', radius: 10 }], 4)).toBeGreaterThanOrEqual(120);
  });

  it('stay within the margin limits for small, huge and broken values', () => {
    expect(effectsMargin([{ type: 'dropShadow', x: 1, y: 1, blur: 0 }], 1)).toBe(96);
    expect(effectsMargin([{ type: 'dropShadow', x: 1e9, y: 0, blur: 0 }], 64)).toBe(1536);
    expect(effectsMargin([{ type: 'blur', radius: NaN }, { type: 'dropShadow', x: Infinity, y: NaN }], 4)).toBe(96);
  });
});

describe('visual bounds of a clipping group', () => {
  it('reach as far as the group’s own drop shadow', () => {
    const doc = VDocument.create({ width: 400, height: 400 });
    const layer = doc.layers()[0].id;
    const art = createPath(rectangle(100, 100, 150, 150), true, { fill: solid('#3366cc') });
    const clip = createPath(rectangle(120, 120, 100, 100), true, {});
    const g = createGroup([art.id, clip.id], { clip: true, effects: [{ type: 'dropShadow', x: 30, y: 30, blur: 5, opacity: 1, color: '#000000' }] });
    doc.transact('Make', () => doc.insert(g, layer, Infinity, [{ ...art, parent: g.id }, { ...clip, parent: g.id }]));
    const b = visualBounds(doc, doc.get(g.id));
    // The shadow of the 100pt clip reaches to 220 + 30 + its blur.
    expect(b.x + b.w).toBeGreaterThanOrEqual(250);
    expect(b.y + b.h).toBeGreaterThanOrEqual(250);
    // Without effects the clip path is the bounds.
    doc.transact('No effects', () => doc.update(g.id, { effects: [] }));
    expect(visualBounds(doc, doc.get(g.id))).toEqual({ x: 120, y: 120, w: 100, h: 100 });
  });
});
