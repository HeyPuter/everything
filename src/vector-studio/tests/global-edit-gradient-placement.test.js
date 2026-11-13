import { describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { createCompound, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { GlobalEdit, similarObjects } from '../src/features/panels/select-commands.js';

const gradient = (x, y, type = 'linear') => ({ type, angle: 0, x1: x, y1: y, x2: x + 20, y2: y, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] });
const style = (kind, paint) => kind === 'appearance' ? { appearance: [{ type: 'fill', base: true }, { type: 'stroke', base: true }, { type: 'fill', fill: paint }] } : { [kind]: paint };
const paintOf = (node, kind) => kind === 'appearance' ? node.appearance[2].fill : node[kind];

function setup(kind, type, compound = false) {
  const app = bootApp();
  const ed = app.newDocument();
  const paths = [[0, 0], [40, 30]].map(([x, y]) => createPath(rectangle(x, y, 20, 20), true, style(kind, gradient(x, y, type))));
  const nodes = compound ? paths.map((p) => createCompound([], style(kind, paintOf(p, kind)))) : paths;
  ed.doc.transact('Artwork', () => nodes.forEach((n, i) => {
    ed.doc.insert(n, ed.targetLayer().id);
    if (compound) ed.doc.insert(paths[i], n.id);
  }));
  const ids = similarObjects(ed.doc, ed.doc.get(nodes[0].id));
  expect(ids).toEqual(nodes.map((n) => n.id));
  const session = new GlobalEdit(app, ed, ids);
  return { ed, nodes, session };
}

const cases = ['linear', 'radial'].flatMap((type) => ['fill', 'stroke', 'appearance'].map((kind) => [type, kind]));
describe('gradient placement during Global Edit', () => {
  it.each(cases)('preserves %s gradient placement on %s during an opacity change', (type, kind) => {
    const { ed, nodes, session } = setup(kind, type);
    try {
      const before = paintOf(nodes[1], kind);
      ed.doc.transact('Opacity', () => ed.doc.update(nodes[0].id, { opacity: 0.5 }));
      expect(ed.doc.get(nodes[1].id).opacity).toBe(0.5);
      expect(paintOf(ed.doc.get(nodes[1].id), kind)).toEqual(before);
      ed.doc.undo();
      expect(ed.doc.get(nodes[1].id).opacity).toBe(1);
      expect(paintOf(ed.doc.get(nodes[1].id), kind)).toEqual(before);
    } finally { session.stop(); }
  });

  it.each(cases)('places changed %s gradient colors relative to each %s object', (type, kind) => {
    const { ed, nodes, session } = setup(kind, type);
    try {
      const original = paintOf(nodes[0], kind);
      const paint = { ...paintOf(nodes[1], kind), stops: [{ offset: 0, color: '#00ff00' }, { offset: 1, color: '#000000' }] };
      ed.doc.transact('Gradient colors', () => ed.doc.update(nodes[1].id, style(kind, paint)));
      expect(paintOf(ed.doc.get(nodes[0].id), kind)).toEqual({ ...original, stops: paint.stops });
      ed.doc.undo();
      expect(paintOf(ed.doc.get(nodes[0].id), kind)).toEqual(original);
      ed.doc.redo();
      expect(paintOf(ed.doc.get(nodes[0].id), kind)).toEqual({ ...original, stops: paint.stops });
    } finally { session.stop(); }
  });
  it('keeps compound gradients relative to their own subpaths', () => {
    const { ed, nodes, session } = setup('fill', 'linear', true);
    try {
      const paint = { ...nodes[0].fill, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] };
      ed.doc.transact('Colors', () => ed.doc.update(nodes[0].id, { fill: paint }));
      expect(ed.doc.get(nodes[1].id).fill).toEqual({ ...nodes[1].fill, stops: paint.stops });
    } finally { session.stop(); }
  });

  it('keeps fitted gradients fitted when copying new colors', () => {
    const { ed, nodes, session } = setup('fill', 'linear');
    try {
      const { x1, y1, x2, y2, ...fitted } = nodes[0].fill;
      ed.doc.transact('Fit gradients', () => nodes.forEach((n) => ed.doc.update(n.id, { fill: fitted })));
      const paint = { ...fitted, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] };
      ed.doc.transact('Colors', () => ed.doc.update(nodes[0].id, { fill: paint }));
      expect(ed.doc.get(nodes[1].id).fill).toEqual(paint);
      expect(ed.doc.get(nodes[1].id).fill.x1).toBeUndefined();
    } finally { session.stop(); }
  });

  it.each([false, true])('keeps moving one object independent, compound=%s', (compound) => {
    const { ed, nodes, session } = setup('fill', 'linear', compound);
    try {
      const peer = ed.doc.get(nodes[1].id);
      ed.doc.transact('Move', () => transformNodes(ed.doc, [nodes[0].id], translate(10, 15)));
      expect(ed.doc.get(nodes[0].id).fill).toMatchObject({ x1: 10, y1: 15 });
      expect(ed.doc.get(nodes[1].id)).toBe(peer);
    } finally { session.stop(); }
  });

});
