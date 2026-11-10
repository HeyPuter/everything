import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { emitEntity, makeContext, BoundsSink, insertMatrix } from '../src/core/tessellate.js';
import { RecordingSink } from '../src/core/display.js';
import { STANDARD_LINETYPES } from '../src/core/linetypes.js';
import { PALETTE } from '../src/core/colors.js';
import { tessellate } from '../src/core/geom/tessellate.js';

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

  it('starts dashed construction lines on a whole pattern from their base point', () => {
    const d = drawing();
    // Dashed: 12 + 6 = 18 units per pattern; the start must not follow the view.
    for (const cx of [0, 0.37, 1.1, 2.9, -500.3]) {
      const [x] = emit(d, { ...P, linetype: 'Dashed', type: 'xline', x: 3, y: 0, dx: 1, dy: 0 }, { view: [cx - 10, -10, cx + 10, 10] });
      const phase = (((x.pts[0] - 3) % 18) + 18) % 18;
      expect(Math.min(phase, 18 - phase)).toBeLessThan(1e-9);
      expect(x.pts[0]).toBeLessThan(cx - 10);
      expect(x.pts[2]).toBeGreaterThan(cx + 10);
    }
    const [ray] = emit(d, { ...P, linetype: 'Dashed', type: 'ray', x: 3, y: 0, dx: 1, dy: 0 }, { view: [90, -10, 110, 10] });
    expect((ray.pts[0] - 3) % 18).toBeCloseTo(0, 9);
    expect(ray.pts[0]).toBeGreaterThanOrEqual(3);
  });

  it('draws text and dimensions as strokes', () => {
    const d = drawing();
    const t = emit(d, { ...P, type: 'text', x: 0, y: 0, h: 2, rot: 0, value: 'AB', style: 'Standard', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0 });
    expect(t.length).toBeGreaterThan(2);
    const dim = emit(d, { ...P, type: 'dimension', dimType: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, lx: 50, ly: -10, rot: 0, text: '', style: 'Standard', x3: 0, y3: 0, x4: 0, y4: 0 });
    expect(dim.some((i) => i.kind === 'fill')).toBe(true);
    expect(dim.filter((i) => i.kind === 'line').length).toBeGreaterThan(3);
  });

  it('places dimension text by the width of its text style font', () => {
    const d = drawing();
    d.textStyles.set('Mono', { ...d.textStyles.get('Standard'), name: 'Mono', font: 'mono' });
    d.dimStyles.set('Standard', { ...d.dimStyles.get('Standard'), textStyle: 'Mono' });
    // radius text sits beyond the end of the leader at x = 20
    const items = emit(d, { ...P, type: 'dimension', dimType: 'radius', x1: 0, y1: 0, x2: 10, y2: 0, lx: 20, ly: 0, rot: 0, text: 'iiiiiiii', style: 'Standard', x3: 0, y3: 0, x4: 0, y4: 0 });
    const leader = items.findIndex((i) => i.kind === 'line' && i.pts[2] === 20);
    const xs = items.slice(leader + 1).filter((i) => i.kind === 'line').flatMap((i) => i.pts.filter((_, k) => k % 2 === 0));
    expect(Math.min(...xs)).toBeGreaterThan(20.5);
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

  describe('wide polyline corners', () => {
    const inRing = (x, y, r) => {
      let inside = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
      }
      return inside;
    };
    const cover = (items, x, y) => items.filter((i) => i.kind === 'fill' && inRing(x, y, i.rings[0])).length;

    it('fills the outside of a corner and does not overlap on the inside', () => {
      const d = drawing();
      const items = emit(d, { ...P, type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 10, 10, 0], closed: false, width: 2 });
      expect(items).toHaveLength(2);
      // the outer corner of the band is at (11, -1), the inner one at (9, 1)
      expect(cover(items, 10.9, -0.9)).toBe(1);
      expect(cover(items, 10.5, -0.2)).toBe(1);
      expect(cover(items, 9.3, 0.6)).toBe(1);
      expect(cover(items, 9.6, 0.3)).toBe(1);
      expect(cover(items, 11.1, -1.1)).toBe(0);
      // the ends stay square
      expect(cover(items, -0.1, 0)).toBe(0);
      expect(cover(items, 10, 10.1)).toBe(0);
    });

    it('covers a filled donut without slits or overlaps', () => {
      const d = drawing();
      // inner radius 0, outer radius 10
      const items = emit(d, { ...P, type: 'polyline', pts: [-5, 0, 1, 5, 0, 1], closed: true, width: 10 });
      let holes = 0,
        doubled = 0;
      // angles that never fall on the edge between two quads
      for (let a = 0.41; a < 360; a += 1.9) {
        for (const r of [0.5, 3, 5, 7, 9, 9.9]) {
          const c = cover(items, r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180));
          if (c === 0) holes++;
          if (c > 1) doubled++;
        }
      }
      expect(holes).toBe(0);
      expect(doubled).toBe(0);
      expect(cover(items, 10.2, 0.3)).toBe(0);
    });

    it('cuts off the corner of a very sharp turn instead of drawing a long spike', () => {
      const d = drawing();
      const items = emit(d, { ...P, type: 'polyline', pts: [0, 0, 0, 10, 0, 0, 0, 0.5, 0], closed: false, width: 1 });
      // two bands and the triangle that closes the notch between their ends
      expect(items).toHaveLength(3);
      const xs = items.flatMap((i) => i.rings[0].filter((_, k) => k % 2 === 0));
      expect(Math.max(...xs)).toBeLessThan(10.1);
      expect(cover(items, 10.004, -0.2)).toBeGreaterThan(0);
    });
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

describe('view-dependent tessellation of very large curves', () => {
  const TOL = 2.5e-4;
  // Largest distance from the curve to the chords that cross the box.
  const worstIn = (pts, closed, box, dist) => {
    const n = pts.length >> 1;
    let worst = 0,
      seen = 0;
    for (let i = 0, m = closed ? n : n - 1; i < m; i++) {
      const j = (i + 1) % n;
      const x1 = pts[i * 2],
        y1 = pts[i * 2 + 1],
        x2 = pts[j * 2],
        y2 = pts[j * 2 + 1];
      if (Math.min(x1, x2) > box[2] || Math.max(x1, x2) < box[0] || Math.min(y1, y2) > box[3] || Math.max(y1, y2) < box[1]) continue;
      seen++;
      worst = Math.max(worst, dist((x1 + x2) / 2, (y1 + y2) / 2));
    }
    return { worst, seen };
  };
  const clipAt = (x, y, half = 500) => ({ state: { used: false }, box: () => [x - half, y - half, x + half, y + half] });
  const R = 1e5;
  const a = 1 + Math.PI / 4096;
  const px = R * Math.cos(a),
    py = R * Math.sin(a);
  const view = [px - 1, py - 1, px + 1, py + 1];

  it('keeps circles, arcs and polyline arcs within tolerance inside the clip box', () => {
    const circ = { type: 'circle', cx: 0, cy: 0, r: R };
    const onCircle = (x, y) => Math.abs(R - Math.hypot(x, y));
    const plain = tessellate(circ, TOL)[0];
    expect(worstIn(plain.pts, true, view, onCircle).worst).toBeGreaterThan(TOL * 10);
    const clip = clipAt(px, py);
    const fine = tessellate(circ, TOL, clip)[0];
    expect(clip.state.used).toBe(true);
    const r = worstIn(fine.pts, true, clip.box(), onCircle);
    expect(r.seen).toBeGreaterThan(10);
    expect(r.worst).toBeLessThanOrEqual(TOL * 1.001);
    // the plain points are all still there, in order
    let k = 0;
    for (let i = 0; i < fine.pts.length && k < plain.pts.length; i += 2) {
      if (fine.pts[i] === plain.pts[k] && fine.pts[i + 1] === plain.pts[k + 1]) k += 2;
    }
    expect(k).toBe(plain.pts.length);
    expect(fine.pts.length / 2).toBeLessThan(4096 + 2000);

    const arc = { type: 'arc', cx: 0, cy: 0, r: R, start: 0.2, end: 3 };
    const fa = tessellate(arc, TOL, clipAt(px, py))[0];
    expect(worstIn(fa.pts, false, view, onCircle).worst).toBeLessThanOrEqual(TOL * 1.001);
    expect(fa.pts.slice(0, 2)).toEqual(tessellate(arc, TOL)[0].pts.slice(0, 2));
    expect(fa.pts.slice(-2)).toEqual(tessellate(arc, TOL)[0].pts.slice(-2));

    // a half circle as a polyline arc segment, both directions
    for (const bulge of [1, -1]) {
      const pl = { type: 'polyline', pts: [R, 0, bulge, -R, 0, 0], closed: false };
      const y = bulge > 0 ? py : -py;
      const fp = tessellate(pl, TOL, clipAt(px, y))[0];
      const res = worstIn(fp.pts, false, [px - 1, y - 1, px + 1, y + 1], onCircle);
      expect(res.seen).toBeGreaterThan(0);
      expect(res.worst).toBeLessThanOrEqual(TOL * 1.001);
      expect(fp.pts.slice(0, 2)).toEqual([R, 0]);
      expect(fp.pts.slice(-2)).toEqual([-R, 0]);
    }
  });

  it('keeps ellipses within tolerance inside the clip box', () => {
    const e = { type: 'ellipse', cx: 10, cy: -5, mx: R * Math.cos(0.3), my: R * Math.sin(0.3), ratio: 0.4, start: 0, end: Math.PI * 2 };
    const t = 0.7 + Math.PI / 4096;
    const at = (u) => [e.cx + e.mx * Math.cos(u) - e.ratio * e.my * Math.sin(u), e.cy + e.my * Math.cos(u) + e.ratio * e.mx * Math.sin(u)];
    const [ex, ey] = at(t);
    // distance to the ellipse, by its implicit equation scaled to length
    const dist = (x, y) => {
      const c = Math.cos(0.3),
        s = Math.sin(0.3);
      const u = ((x - e.cx) * c + (y - e.cy) * s) / R,
        v = (-(x - e.cx) * s + (y - e.cy) * c) / (R * 0.4);
      const f = u * u + v * v - 1;
      return Math.abs(f) / (2 * Math.hypot(u / R, v / (R * 0.4)));
    };
    const box = [ex - 1, ey - 1, ex + 1, ey + 1];
    expect(worstIn(tessellate(e, TOL)[0].pts, true, box, dist).worst).toBeGreaterThan(TOL * 5);
    const clip = clipAt(ex, ey);
    const fine = tessellate(e, TOL, clip)[0];
    expect(clip.state.used).toBe(true);
    expect(worstIn(fine.pts, true, box, dist).worst).toBeLessThanOrEqual(TOL * 1.001);
  });

  it('does nothing for curves the chord limit is fine enough for', () => {
    const clip = clipAt(100, 0);
    const c = { type: 'circle', cx: 0, cy: 0, r: 100 };
    expect(tessellate(c, 0.01, clip)).toEqual(tessellate(c, 0.01));
    expect(clip.state.used).toBe(false);
  });
});
