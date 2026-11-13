import { describe, expect, it } from 'vitest';
import { bootApp } from './helpers.js';
import { scriptAPI } from '../src/features/scripts/runner.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function setup() {
  const app = bootApp();
  const ed = app.newDocument();
  const node = createPath(rectangle(0, 0, 20, 20), true);
  ed.doc.transact('Artwork', () => ed.doc.insert(node, ed.targetLayer().id));
  const script = scriptAPI(app, ed, 'Script');
  return { app, ed, node, ...script };
}

const edit = {
  update: (api, node) => api.update(node.id, { opacity: 0.25 }),
  create: (api) => api.create({ type: 'path', anchors: [{ x: 0, y: 0 }], closed: false }),
  remove: (api, node) => api.remove(node.id),
  select: (api, node) => api.select([node.id]),
};

describe('script document lifecycle', () => {
  it.each(Object.keys(edit))('rejects %s after the script document closes', async (method) => {
    const { app, ed, node, api, changes } = setup();
    const other = app.newDocument();
    await app.closeDocument(ed, { force: true });
    const before = [...ed.doc.nodes.entries()];
    const history = [...ed.doc.undoStack];
    expect(() => edit[method](api, node)).toThrow(/document.*closed/i);
    expect([...ed.doc.nodes.entries()]).toEqual(before);
    expect(ed.doc.undoStack).toEqual(history);
    expect(changes()).toBe(0);
    expect(app.editor).toBe(other);
    expect(other.selection.size).toBe(0);
  });

  it('continues editing the original open document after a tab switch', () => {
    const { app, ed, node, api } = setup();
    const other = app.newDocument();
    api.update(node.id, { opacity: 0.25 });
    api.select([node.id]);
    expect(ed.doc.get(node.id).opacity).toBe(0.25);
    expect([...ed.selection]).toEqual([node.id]);
    expect(app.editor).toBe(other);
    ed.doc.undo();
    expect(ed.doc.get(node.id).opacity).toBe(1);
  });
});
