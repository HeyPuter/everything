import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addPattern } from '../src/features/patterns/model.js';

describe('Select Same pattern paints', () => {
  it.each(['fill', 'stroke', 'fillStroke', 'appearance'])('distinguishes pattern definitions for %s', async (what) => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [];
    doc.transact('Patterns', () => {
      for (const [id, color] of [['red-tile', '#ff0000'], ['blue-tile', '#0000ff']]) {
        const tile = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'solid', color } });
        addPattern(doc, { id, width: 10, height: 10, art: { roots: [tile.id], nodes: [tile] } });
      }
      for (const [i, id] of ['red-tile', 'red-tile', 'blue-tile'].entries()) {
        const paint = { type: 'pattern', id };
        const p = createPath(rectangle(i * 30, 0, 20, 20), true, { fill: paint, stroke: paint });
        doc.insert(p, ed.targetLayer().id);
        ids.push(p.id);
      }
    });
    ed.select([ids[0]]);
    await app.commands.run(`select.same.${what}`);
    expect([...ed.selection]).toEqual(ids.slice(0, 2));
  });
});
