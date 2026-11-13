import { describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { GlobalEdit, similarObjects } from '../src/features/panels/select-commands.js';

const extraStroke = (color) => [{ type: 'fill', base: true }, { type: 'stroke', base: true }, { type: 'stroke', stroke: { type: 'solid', color }, strokeWidth: 6 }];
const cases = [
  ['appearance', extraStroke('#ff0000'), extraStroke('#0000ff')],
  ['widthProfile', [{ t: 0, l: 0, r: 0 }, { t: 1, l: 1, r: 1 }], [{ t: 0, l: 1, r: 1 }, { t: 1, l: 0, r: 0 }]],
  ['brush', { id: 'def.basic', seed: 7 }, { id: 'lib.bristle.soft-round', seed: 7 }],
  ['brushPressure', [[0, 0.2], [1, 1]], [[0, 1], [1, 0.2]]],
  ['dashAlign', 'exact', 'corners'],
];

function setup(styles) {
  const app = bootApp();
  const ed = app.newDocument();
  const nodes = styles.map((style, i) => createPath(rectangle(i * 40, 0, 20, 20), true, { dash: [4, 3], ...('brushPressure' in style ? { brush: { id: 'lib.cal.pressure-pen', seed: 7 } } : {}), ...structuredClone(style) }));
  ed.doc.transact('Artwork', () => nodes.forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
  return { app, ed, nodes };
}

describe('Global Edit appearance', () => {
  it.each(cases)('matches the full %s attribute', (key, first, different) => {
    const { ed, nodes } = setup([{ [key]: first }, { [key]: first }, { [key]: different }]);
    expect(similarObjects(ed.doc, nodes[0])).toEqual(nodes.slice(0, 2).map((n) => n.id));
  });

  it.each(cases)('propagates changes and removal of %s in the same undo step', (key, first, next) => {
    const { app, ed, nodes } = setup([{ [key]: first }, { [key]: first }]);
    const session = new GlobalEdit(app, ed, nodes.map((n) => n.id));
    try {
      const before = ed.doc.undoStack.length;
      ed.doc.transact('Appearance', () => ed.doc.update(nodes[0].id, { [key]: next }));
      expect(ed.doc.get(nodes[1].id)[key]).toEqual(next);
      expect(ed.doc.undoStack).toHaveLength(before + 1);
      ed.doc.undo();
      expect(ed.doc.get(nodes[0].id)[key]).toEqual(first);
      expect(ed.doc.get(nodes[1].id)[key]).toEqual(first);
      ed.doc.redo();
      expect(ed.doc.get(nodes[1].id)[key]).toEqual(next);
      ed.doc.transact('Remove attribute', () => ed.doc.update(nodes[1].id, { [key]: undefined }));
      expect(ed.doc.get(nodes[0].id)[key]).toBeUndefined();
    } finally {
      session.stop();
    }
  });

  it('matches equivalent stack effects with different instance IDs', () => {
    const appearance = (id) => [{ type: 'fill', base: true, effects: [{ id, type: 'blur', radius: 2 }] }];
    const { ed, nodes } = setup([{ appearance: appearance('a') }, { appearance: appearance('b') }]);
    expect(similarObjects(ed.doc, nodes[0])).toEqual(nodes.map((n) => n.id));
  });
});
