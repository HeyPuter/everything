import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

describe('Select Same freeform paints', () => {
  it.each(['fill', 'stroke', 'fillStroke', 'appearance'])('distinguishes freeform gradients for %s', async (what) => {
    const app = bootApp();
    const ed = app.newDocument();
    const paint = { type: 'freeform', points: [
      { x: 0, y: 0, color: '#FF0000' },
      { x: 1, y: 1, color: '#0000ff' },
    ] };
    const equivalent = { type: 'freeform', mode: 'points', points: paint.points.map((p) => ({
      color: p.color.toLowerCase(), y: p.y, x: p.x, opacity: 1, spread: 0,
    })) };
    const variants = [
      { ...paint, points: [{ ...paint.points[0], color: '#00ff00' }, paint.points[1]] },
      { ...paint, points: [{ ...paint.points[0], x: 0.5 }, paint.points[1]] },
      { ...paint, points: [{ ...paint.points[0], opacity: 0.5 }, paint.points[1]] },
      { ...paint, points: [{ ...paint.points[0], spread: 0.5 }, paint.points[1]] },
      { ...paint, mode: 'lines', lines: [[0, 1]] },
    ];
    const ids = [];
    ed.doc.transact('Freeform gradients', () => {
      for (const [i, p] of [paint, equivalent, ...variants].entries()) {
        const node = createPath(rectangle(i * 30, 0, 20, 20), true, { fill: p, stroke: p });
        ed.doc.insert(node, ed.targetLayer().id);
        ids.push(node.id);
      }
    });
    ed.select([ids[0]]);
    await app.commands.run(`select.same.${what}`);
    expect([...ed.selection]).toEqual(ids.slice(0, 2));
  });
});
