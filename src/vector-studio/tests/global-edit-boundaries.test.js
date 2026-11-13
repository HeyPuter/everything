import { describe, expect, it } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createGroup, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const group = createGroup([]);
  const nodes = [0, 30, 60].map((x) => createPath(rectangle(x, 0, 20, 20), true, { fill: { type: 'solid', color: '#ff0000' } }));
  ed.doc.transact('Artwork', () => {
    ed.doc.insert(group, ed.targetLayer().id);
    nodes.forEach((node, i) => ed.doc.insert(node, i < 2 ? group.id : ed.targetLayer().id));
  });
  ed.select([nodes[0].id]);
  return { app, ed, group, nodes };
}

function recolor(ed, node) {
  ed.doc.transact('Recolor', () => ed.doc.update(node.id, { fill: { type: 'solid', color: '#0000ff' } }));
}

describe('Global Edit boundaries', () => {
  it('starts with matching objects inside the isolated group only', async () => {
    const { app, ed, group, nodes } = await setup();
    await app.commands.run('object.isolate', { id: group.id });
    ed.select([nodes[0].id]);
    await app.commands.run('select.globalEdit');
    try {
      recolor(ed, nodes[0]);
      expect(ed.doc.get(nodes[1].id).fill.color).toBe('#0000ff');
      expect(ed.doc.get(nodes[2].id).fill.color).toBe('#ff0000');
      expect(app.globalEdit.size).toBe(2);
    } finally {
      app.stopGlobalEdit();
    }
  });

  it('drops members outside a group isolated during the session', async () => {
    const { app, ed, group, nodes } = await setup();
    await app.commands.run('select.globalEdit');
    await app.commands.run('object.isolate', { id: group.id });
    try {
      recolor(ed, nodes[0]);
      expect(ed.doc.get(nodes[1].id).fill.color).toBe('#0000ff');
      expect(ed.doc.get(nodes[2].id).fill.color).toBe('#ff0000');
    } finally {
      app.stopGlobalEdit();
    }
  });

  it.each(['locked', 'hidden'])('ends the session when a %s parent leaves fewer than two editable members', async (key) => {
    const { app, ed, group, nodes } = await setup();
    await app.commands.run('select.globalEdit');
    ed.doc.transact('Protect group', () => ed.doc.update(group.id, { [key]: true }));
    expect(app.globalEdit).toBeNull();
    recolor(ed, nodes[2]);
    expect(ed.doc.get(nodes[0].id).fill.color).toBe('#ff0000');
    expect(ed.doc.get(nodes[1].id).fill.color).toBe('#ff0000');
  });

  it.each(['locked', 'hidden'])('does not modify a member made %s during the session', async (key) => {
    const { app, ed, nodes } = await setup();
    await app.commands.run('select.globalEdit');
    try {
      ed.doc.transact('Protect object', () => ed.doc.update(nodes[2].id, { [key]: true }));
      recolor(ed, nodes[0]);
      expect(ed.doc.get(nodes[1].id).fill.color).toBe('#0000ff');
      expect(ed.doc.get(nodes[2].id).fill.color).toBe('#ff0000');
      expect(app.globalEdit.size).toBe(2);
      ed.doc.undo();
      expect(ed.doc.get(nodes[0].id).fill.color).toBe('#ff0000');
      expect(ed.doc.get(nodes[1].id).fill.color).toBe('#ff0000');
      expect(ed.doc.get(nodes[2].id)[key]).toBe(true);
    } finally {
      app.stopGlobalEdit();
    }
  });
});
