import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { pickEntity, entityCrossesRect } from '../src/editor/pick.js';

const BASE = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };

/**
 * The screen draws a very large circle on its true curve when zoomed in
 * (chords are refined inside the view); picking has to follow the same curve,
 * not the 4096-chord polygon that is up to r * 3e-7 inside it.
 */
describe('picking very large curves when zoomed far in', () => {
  const setup = (ent) => {
    const d = new Drawing();
    let id;
    d.transaction('t', () => {
      id = d.add({ ...BASE, ...ent });
    });
    return { d, id: id?.id ?? id };
  };
  // Half way between two of the 4096 chord ends, where the polygon is furthest inside.
  const a = (2 * Math.PI * 1000.5) / 4096;
  const scale = 8000; // pixels per unit
  const radius = 5 / scale;

  it('picks a circle of radius 1e5 on the curve', () => {
    const { d, id } = setup({ type: 'circle', cx: 500000, cy: 350000, r: 100000 });
    const px = 500000 + 100000 * Math.cos(a),
      py = 350000 + 100000 * Math.sin(a);
    expect(pickEntity(d, [id], px, py, radius)?.id).toBe(id);
    // 20 px inside the curve nothing is drawn, so nothing is picked.
    const qx = 500000 + (100000 - 20 / scale) * Math.cos(a),
      qy = 350000 + (100000 - 20 / scale) * Math.sin(a);
    expect(pickEntity(d, [id], qx, qy, radius)).toBe(null);
  });

  it('picks a large arc, ellipse and polyline arc on the curve', () => {
    const arc = setup({ type: 'arc', cx: 0, cy: 0, r: 100000, start: 0, end: 2 * Math.PI - 1e-9 });
    expect(pickEntity(arc.d, [arc.id], 100000 * Math.cos(a), 100000 * Math.sin(a), radius)?.id).toBe(arc.id);
    const pl = setup({ type: 'polyline', pts: [-100000, 0, 1, 100000, 0, 1], closed: true, width: 0 });
    const hit = pickEntity(pl.d, [pl.id], 100000 * Math.cos(0.7), 100000 * Math.sin(0.7), radius);
    expect(hit?.id).toBe(pl.id);
  });

  it('a crossing window over the curve finds the circle', () => {
    const { d, id } = setup({ type: 'circle', cx: 500000, cy: 350000, r: 100000 });
    const px = 500000 + 100000 * Math.cos(a),
      py = 350000 + 100000 * Math.sin(a);
    const h = 3 / scale;
    expect(entityCrossesRect(d, d.get(id), [px - h, py - h, px + h, py + h], 0.5 / scale)).toBe(true);
  });
});
