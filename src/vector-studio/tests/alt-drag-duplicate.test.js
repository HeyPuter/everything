import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { TransformSession } from '../src/tools/transform-session.js';

describe('Alt-drag duplicate', () => {
  it('puts each copy right above its original, in every container, in one undo step', () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const layer = ed.targetLayer().id;
    const rect = (x, parent) => {
      const p = createPath(rectangle(x, 0, 10, 10), true);
      doc.insert(p, parent);
      return p.id;
    };
    let a, b, c, g, x, y;
    doc.transact('Add', () => {
      a = rect(0, layer);
      b = rect(20, layer);
      g = doc.insert(createGroup([]), layer).id;
      x = rect(40, g);
      y = rect(60, g);
      c = rect(80, layer);
    });
    ed.select([c, a, y]);
    const s = new TransformSession(ed, 'Move', { duplicate: true, copyLabel: 'Copy' });
    s.apply([1, 0, 0, 1, 0, 50]);
    s.commit();
    const copies = [...ed.selection];
    expect(copies).toHaveLength(3);
    const kids = doc.get(layer).children;
    expect(kids).toHaveLength(6);
    expect([kids[0], kids[2], kids[3], kids[4]]).toEqual([a, b, g, c]);
    expect(copies).toContain(kids[1]);
    expect(copies).toContain(kids[5]);
    const gk = doc.get(g).children;
    expect([gk[0], gk[1]]).toEqual([x, y]);
    expect(copies).toContain(gk[2]);
    for (const id of copies) expect(doc.get(id).anchors[0].y).toBe(50);
    expect(doc.get(a).anchors[0].y).toBe(0);
    expect(doc.undoLabel).toBe('Copy');
    doc.undo();
    expect(doc.get(layer).children).toEqual([a, b, g, c]);
    expect(doc.get(g).children).toEqual([x, y]);
  });
});
