import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath } from '../src/model/nodes.js';
import { anchor } from '../src/model/bezier.js';
import { drawNode } from '../src/render/draw.js';
import { MAX_DASHES } from '../src/model/dash-limit.js';

beforeAll(() => installCanvasStub());

/** The dash pattern the canvas is given to stroke a 100 pt line. */
function drawnDash(style) {
  const doc = VDocument.create({ width: 400, height: 400 });
  const p = createPath([anchor(0, 0), anchor(100, 0)], false, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 2, ...style });
  doc.transact('add', () => doc.insert(p, doc.layers()[0].id));
  const dashes = [];
  const state = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setLineDash: (d) => dashes.push(d) };
  const ctx = new Proxy(state, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
  drawNode(ctx, doc, doc.get(p.id), {});
  return { dash: dashes[dashes.length - 1], offset: state.lineDashOffset };
}

describe('drawing dashed strokes', () => {
  it('draws patterns too dense to make out as a look-alike instead of taking seconds per frame', () => {
    // Ordinary patterns are drawn as they are.
    expect(drawnDash({ dash: [4, 2], dashOffset: 1 })).toEqual({ dash: [4, 2], offset: 1 });
    // Round caps covering every gap: solid.
    expect(drawnDash({ strokeCap: 'round', dash: [0.0001, 0.0001] }).dash).toEqual([]);
    // Butt caps: at most MAX_DASHES dashes, same proportions.
    const [d, g] = drawnDash({ dash: [0.0001, 0.0001] }).dash;
    expect(d).toBeCloseTo(g, 9);
    expect(d + g).toBeCloseTo(100 / MAX_DASHES, 6);
  });
});
