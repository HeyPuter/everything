import { describe, it, expect } from 'vitest';
import { cornerAlignedDash } from '../src/features/paint/stroke-geometry.js';
import { dashPattern } from '../src/features/paint/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';

/** Where path distance `x` falls in a canvas dash pattern: [in a dash, distance into it, its length]. */
function at({ dash, offset }, x) {
  const total = dash.reduce((a, b) => a + b, 0);
  let p = (((x + offset) % total) + total) % total;
  for (let i = 0; i < dash.length; i++) {
    if (p < dash[i]) return [i % 2 === 0, p, dash[i]];
    p -= dash[i];
  }
  return [false, 0, 0];
}

describe('Dashes aligned to corners', () => {
  it('centers a dash on every corner of a rectangle whose sides need different stretches', () => {
    const rect = rectangle(0, 0, 200, 100);
    for (const anchors of [rect, [...rect.slice(2), ...rect.slice(0, 2)]]) {
      const d = cornerAlignedDash([12, 6], anchors, true);
      for (const x of [0, 200, 300, 500]) {
        const [inDash, into, len] = at(d, x);
        expect(inDash).toBe(true);
        // Each side contributes half of its own stretched dash.
        expect(into).toBeGreaterThan(len * 0.4);
        expect(into).toBeLessThan(len * 0.6);
      }
    }
  });

  it('starts and ends an open path with half a dash, and fits smooth paths as a whole', () => {
    const [a, b, c] = rectangle(0, 0, 200, 100);
    const d = cornerAlignedDash([12, 6], [a, b, c], false);
    expect(at(d, 0)).toEqual([true, 0, expect.closeTo(6.06, 2)]);
    expect(at(d, 299.99)[0]).toBe(true);
    expect(at(d, 200)[0]).toBe(true);
    const round = cornerAlignedDash([10, 5], ellipse(0, 0, 100, 60), true);
    expect(round.dash).toHaveLength(2);
  });

  it('is what the canvas strokes with', () => {
    const node = createPath(rectangle(0, 0, 200, 100), true, {
      dash: [12, 6],
      dashAlign: 'corners',
    });
    expect(at(dashPattern(node), 300)[0]).toBe(true);
  });
});
