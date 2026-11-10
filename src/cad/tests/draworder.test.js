import { describe, it, expect } from 'vitest';
import { drawBands, nextBand, bandOrder } from '../src/core/display.js';
import { Batch, SEG_FLOATS, TRI_FLOATS } from '../src/render/batch.js';

const ents = (...groups) => groups.map((g, i) => ({ id: i + 1, orderGroup: g ?? undefined }));

describe('draw-order bands', () => {
  it('keeps a drawing that never used DRAWORDER in one band', () => {
    const b = drawBands(ents(null, null, null));
    expect(b.of.size).toBe(0);
    expect(b.band).toBe(0);
    expect(nextBand(b, {})).toBe(0);
  });

  it('starts a band at every change of order group', () => {
    const b = drawBands(ents(null, 7, 7, null, 9));
    expect([1, 2, 3, 4, 5].map((id) => b.of.get(id) ?? 0)).toEqual([0, 1, 1, 2, 3]);
    // Objects drawn after a group get a band of their own above it.
    expect(nextBand(b, {})).toBe(4);
    expect(nextBand(b, {})).toBe(4);
    expect(nextBand(b, { orderGroup: 11 })).toBe(5);
  });

  it('orders recorded items band by band, fills beneath lines', () => {
    const L = (n) => ({ kind: 'line', n });
    const F = (n) => ({ kind: 'fill', n });
    const out = bandOrder([
      { band: 0, items: [L(1)] },
      { band: 0, items: [F(2)] },
      { band: 1, items: [F(3), L(4)] },
      { band: 2, items: [L(5)] },
    ]);
    expect(out.map((it) => it.n)).toEqual([2, 1, 3, 4, 5]);
  });

  it('stores the band with every segment and fill vertex', () => {
    const b = new Batch(() => 0);
    b.band = 3;
    b.line([0, 0, 1, 0, 1, 1], false, { rgb: [0, 0, 0] });
    b.segs([0, 0, 2, 2], { rgb: [0, 0, 0] });
    b.fill([[0, 0, 1, 0, 1, 1]], { rgb: [0, 0, 0] });
    for (let i = 0; i < b.segCount; i++) expect(b.segF[i * SEG_FLOATS + 12]).toBe(3);
    for (let i = 0; i < b.vertCount; i++) expect(b.triF[i * TRI_FLOATS + 5]).toBe(3);
  });

  it('notes translucent fills, which must not hide what lies beneath', () => {
    const b = new Batch(() => 0);
    b.fill([[0, 0, 1, 0, 1, 1]], { rgb: [0, 0, 0] });
    expect(b.translucent).toBe(false);
    b.fill([[0, 0, 1, 0, 1, 1]], { rgb: [0, 0, 0], alpha: 0.4 });
    expect(b.translucent).toBe(true);
    b.reset();
    expect(b.translucent).toBe(false);
  });
});
