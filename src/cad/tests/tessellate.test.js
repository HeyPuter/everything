import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { emitEntity, makeContext, BoundsSink, insertMatrix } from '../src/core/tessellate.js';
import { RecordingSink } from '../src/core/display.js';
import { STANDARD_LINETYPES } from '../src/core/linetypes.js';
import { PALETTE } from '../src/core/colors.js';

const P = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

function drawing() {
  const d = new Drawing();
  for (const lt of STANDARD_LINETYPES) d.linetypes.set(lt.name, { ...lt });
  d.layers.set('Red', { ...d.layers.get('0'), name: 'Red', color: 1, linetype: 'Dashed', lineweight: 50 });
  d.layers.set('Off', { ...d.layers.get('0'), name: 'Off', on: false });
  d.layers.set('NoPlot', { ...d.layers.get('0'), name: 'NoPlot', plot: false });
  return d;
}

function emit(d, ent, opts = {}) {
  const sink = new RecordingSink();
  emitEntity(ent, sink, makeContext(d, { fg: [9, 9, 9], tol: 0.01, ...opts }));
  return sink.items;
}

describe('emitEntity', () => {
  it('resolves ByLayer color, linetype and lineweight', () => {
    const d = drawing();
    const [it] = emit(d, { ...P, layer: 'Red', type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(it.style.rgb).toEqual(PALETTE[1]);
    expect(it.style.lw).toBe(50);
    expect(it.style.basePattern).toBe(d.linetypes.get('Dashed').pattern);
    expect(it.style.pattern).toEqual([12, -6]);
  });

  it('applies global and entity linetype scales', () => {
    const d = drawing();
    d.header.ltscale = 2;
    const [it] = emit(d, { ...P, linetype: 'Dashed', ltscale: 0.5, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(it.style.pattern).toEqual([12, -6]);
    expect(it.style.ltscale).toBe(1);
  });

  it('maps index 7 to the foreground color', () => {
    const d = drawing();
    const [it] = emit(d, { ...P, type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 });
    expect(it.style.rgb).toEqual([9, 9, 9]);
    expect(it.style.aci7).toBe(true);
  });

  it('uses true colors', () => {
    const d = drawing();
    const [it] = emit(d, { ...P, color: '#336699', type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 });
    expect(it.style.rgb).toEqual([0x33, 0x66, 0x99]);
  });

  it('skips hidden layers, and non-plotting layers when plotting', () => {
    const d = drawing();
    expect(emit(d, { ...P, layer: 'Off', type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 })).toHaveLength(0);
    expect(emit(d, { ...P, layer: 'NoPlot', type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 })).toHaveLength(1);
    expect(emit(d, { ...P, layer: 'NoPlot', type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }, { plot: true })).toHaveLength(0);
  });

  it('draws block contents transformed, with ByBlock and layer 0 inheritance', () => {
    const d = drawing();
    d.blocks.set('B', {
      name: 'B',
      bx: 1,
      by: 0,
      entities: [
        { ...P, id: 1, color: 0, type: 'line', x1: 1, y1: 0, x2: 2, y2: 0 },
        { ...P, id: 2, layer: 'Red', type: 'line', x1: 1, y1: 0, x2: 1, y2: 1 },
      ],
    });
    const items = emit(d, { ...P, id: 99, color: 3, layer: 'Red', type: 'insert', name: 'B', x: 10, y: 10, sx: 2, sy: 2, rot: Math.PI / 2 });
    expect(items).toHaveLength(2);
    // ByBlock takes the reference's color; layer 0 takes its layer.
    expect(items[0].style.rgb).toEqual(PALETTE[3]);
    expect(items[0].style.id).toBe(99);
    // Base point (1,0) lands on the insertion point; +x becomes +y after rotation, scaled by 2.
    expect(items[0].pts[0]).toBeCloseTo(10);
    expect(items[0].pts[1]).toBeCloseTo(10);
    expect(items[0].pts[2]).toBeCloseTo(10);
    expect(items[0].pts[3]).toBeCloseTo(12);
    expect(items[1].style.rgb).toEqual(PALETTE[1]);
  });

  it('stops runaway recursion in self-referencing blocks', () => {
    const d = drawing();
    d.blocks.set('Loop', { name: 'Loop', bx: 0, by: 0, entities: [{ ...P, id: 1, type: 'insert', name: 'Loop', x: 1, y: 0, sx: 1, sy: 1, rot: 0 }] });
    expect(() => emit(d, { ...P, type: 'insert', name: 'Loop', x: 0, y: 0, sx: 1, sy: 1, rot: 0 })).not.toThrow();
  });

  it('draws a block that references itself only once per level, not exponentially', () => {
    const d = drawing();
    d.blocks.set('A', {
      name: 'A',
      bx: 0,
      by: 0,
      entities: [
        { ...P, id: 1, type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 },
        { ...P, id: 2, type: 'insert', name: 'A', x: 1, y: 0, sx: 1, sy: 1, rot: 0 },
        { ...P, id: 3, type: 'insert', name: 'A', x: 2, y: 0, sx: 1, sy: 1, rot: 0 },
      ],
    });
    expect(emit(d, { ...P, type: 'insert', name: 'A', x: 0, y: 0, sx: 1, sy: 1, rot: 0 })).toHaveLength(1);
  });

  it('keeps construction lines out of block bounds', () => {
    const d = drawing();
    d.blocks.set('X', { name: 'X', bx: 0, by: 0, entities: [{ ...P, id: 1, type: 'xline', x: 0, y: 0, dx: 1, dy: 0 }, { ...P, id: 2, type: 'line', x1: 0, y1: 0, x2: 5, y2: 5 }] });
    const sink = new BoundsSink();
    emitEntity({ ...P, type: 'insert', name: 'X', x: 10, y: 10, sx: 1, sy: 1, rot: 0 }, sink, makeContext(d, { bounds: true }));
    expect(sink.bounds).toEqual([10, 10, 15, 15]);
  });

  it('keeps construction line ends near the view, wherever the line is defined', () => {
    const d = drawing();
    const [it] = emit(d, { ...P, type: 'xline', x: 0, y: 0, dx: Math.SQRT1_2, dy: Math.SQRT1_2 }, { view: [59990, 59990, 60010, 60010] });
    for (const v of it.pts) expect(Math.abs(v - 60000)).toBeLessThan(60);
  });

  it('skips rays that point away from the view', () => {
    const d = drawing();
    expect(emit(d, { ...P, type: 'ray', x: 0, y: 0, dx: -1, dy: 0 }, { view: [100, -10, 120, 10] })).toHaveLength(0);
  });

  it('emits solid hatch fills and pattern lines', () => {
    const d = drawing();
    const sq = [[0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]];
    const solid = emit(d, { ...P, type: 'hatch', loops: sq, pattern: 'SOLID', scale: 1, angle: 0 });
    expect(solid).toHaveLength(1);
    expect(solid[0].kind).toBe('fill');
    const lines = emit(d, { ...P, type: 'hatch', loops: sq, pattern: 'LINES', scale: 1, angle: 0 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((i) => i.kind === 'line')).toBe(true);
  });

  it('tints the whole area of a hatch too dense to generate, and warns', () => {
    const d = drawing();
    const big = [[0, 0, 0, 3000, 0, 0, 3000, 3000, 0, 0, 3000, 0]];
    for (const pattern of ['CROSS', 'DASH']) {
      for (const plot of [false, true]) {
        const warnings = new Set();
        const ent = { ...P, type: 'hatch', loops: big, pattern, scale: 1, angle: 0 };
        const items = emit(d, ent, { hatchLimit: 1000, warnings, plot });
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe('fill');
        expect(items[0].rings[0]).toHaveLength(8);
        expect(items[0].style.alpha).toBeCloseTo(0.35);
        expect([...warnings]).toEqual(['hatch-dense']);
      }
    }
  });

  it('clips construction lines to the view', () => {
    const d = drawing();
    const [it] = emit(d, { ...P, type: 'xline', x: 0, y: 0, dx: 1, dy: 0 }, { view: [-10, -10, 10, 10] });
    expect(it.pts[0]).toBeLessThan(-10);
    expect(it.pts[2]).toBeGreaterThan(10);
    const [ray] = emit(d, { ...P, type: 'ray', x: 0, y: 0, dx: 1, dy: 0 }, { view: [-10, -10, 10, 10] });
    expect(ray.pts[0]).toBe(0);
  });

  it('draws text and dimensions as strokes', () => {
    const d = drawing();
    const t = emit(d, { ...P, type: 'text', x: 0, y: 0, h: 2, rot: 0, value: 'AB', style: 'Standard', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 });
    expect(t.length).toBeGreaterThan(2);
    const dim = emit(d, { ...P, type: 'dimension', dimType: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, lx: 50, ly: -10, rot: 0, text: '', style: 'Standard', x3: 0, y3: 0, x4: 0, y4: 0 });
    expect(dim.some((i) => i.kind === 'fill')).toBe(true);
    expect(dim.filter((i) => i.kind === 'line').length).toBeGreaterThan(3);
  });

  it('gives widths to wide polylines as fills', () => {
    const d = drawing();
    const items = emit(d, { ...P, type: 'polyline', pts: [0, 0, 0, 10, 0, 0], closed: false, width: 2 });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('fill');
    const ys = items[0].rings[0].filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeCloseTo(1);
    expect(Math.min(...ys)).toBeCloseTo(-1);
  });
});

describe('BoundsSink and insertMatrix', () => {
  it('accumulates bounds', () => {
    const s = new BoundsSink();
    s.line([0, 0, 5, -2], false);
    s.fill([[1, 1, 7, 1, 7, 3]]);
    expect(s.bounds).toEqual([0, -2, 7, 3]);
  });

  it('builds the reference matrix around the block base point', () => {
    const m = insertMatrix({ x: 10, y: 20, sx: 2, sy: 3, rot: 0 }, { bx: 1, by: 1 });
    // (1,1) -> (10,20); (2,2) -> (12,23)
    expect(m[0] * 1 + m[2] * 1 + m[4]).toBeCloseTo(10);
    expect(m[1] * 1 + m[3] * 1 + m[5]).toBeCloseTo(20);
    expect(m[0] * 2 + m[2] * 2 + m[4]).toBeCloseTo(12);
    expect(m[1] * 2 + m[3] * 2 + m[5]).toBeCloseTo(23);
  });
});
