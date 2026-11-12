// Editing core leftovers from the first review wave.
import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function setup(app = bootApp()) {
  const ed = app.newDocument();
  return { app, ed, doc: ed.doc, layer: ed.doc.layers()[0] };
}

describe('Reverse Path Direction', () => {
  it('reverses a subpath once when both it and its compound path are selected', async () => {
    const { app, ed, doc, layer } = setup();
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    const c = createCompound([a.id, b.id], { fill: { type: 'solid', color: '#000000' } });
    doc.transact('t', () => doc.insert(c, layer.id, Infinity, [a, b]));
    const first = (id) => doc.get(id).anchors.map((p) => [p.x, p.y]);
    const [a0, b0] = [first(a.id), first(b.id)];
    ed.select([c.id, a.id]);
    await app.commands.run('path.reverse');
    expect(first(a.id)).not.toEqual(a0);
    expect(first(a.id)).toEqual(first(b.id).map(([x, y]) => [x - 20, y]));
    expect(first(b.id)).not.toEqual(b0);
  });
});
