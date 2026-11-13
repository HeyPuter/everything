import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { DEFAULT_GRAPHIC_STYLES } from '../src/features/paint/graphic-styles.js';

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const group = createGroup([]);
  const inside = [];
  const outside = [];
  const style = DEFAULT_GRAPHIC_STYLES.find((s) => s.id === 'gs-neon').style;
  doc.transact('Artwork', () => {
    doc.insert(group, ed.targetLayer().id);
    for (const [parent, ids] of [[group.id, inside], [ed.targetLayer().id, outside]]) {
      for (const n of [
        createPath(rectangle(0, 0, 20, 20), true, structuredClone(style)),
        createText('Text', 0, 50),
        createPath([anchor(0, 0)], false),
      ]) {
        doc.insert(n, parent);
        ids.push(n.id);
      }
      const clip = createGroup([], { clip: true });
      doc.insert(clip, parent);
      const mask = createPath(rectangle(0, 0, 50, 50), true);
      doc.insert(mask, clip.id);
      ids.push(mask.id);
    }
  });
  ed.select([group.id]);
  await app.commands.run('object.isolate');
  return { app, ed, doc, group, inside, outside };
}

describe('Select commands in isolation mode', () => {
  it.each(['fill', 'stroke', 'fillStroke', 'strokeWeight', 'opacity', 'blendMode', 'appearance', 'shape', 'shapesText', 'appearanceAttribute', 'graphicStyle'])('keeps Same %s inside the isolated group', async (what) => {
    const { app, ed, inside, outside } = await setup();
    ed.select([inside[0]]);
    expect(app.commands.isEnabled(`select.same.${what}`)).toBe(true);
    await app.commands.run(`select.same.${what}`);
    expect(ed.selection.has(inside[0])).toBe(true);
    expect([...ed.selection].some((id) => outside.includes(id))).toBe(false);
    expect([...ed.selection].every((id) => ed.inIsolation(id))).toBe(true);
  });

  it.each([['text', 1], ['stray', 2], ['clipping', 3]])('keeps Object %s inside the isolated group', async (what, index) => {
    const { app, ed, inside } = await setup();
    await app.commands.run(`select.object.${what}`);
    expect([...ed.selection]).toEqual([inside[index]]);
  });

  it('does not select siblings outside an isolated single object', async () => {
    const { app, ed, inside } = await setup();
    await app.commands.run('object.isolate', { id: inside[0] });
    await app.commands.run('select.all');
    await app.commands.run('select.nextAbove');
    expect([...ed.selection]).toEqual([inside[0]]);
  });

  it.each(['hidden', 'locked'])('cannot select inside an isolated group whose layer became %s', async (key) => {
    const { app, ed, doc, group } = await setup();
    doc.transact('Layer state', () => doc.update(group.parent || doc.get(group.id).parent, { [key]: true }));
    await app.commands.run('select.object.text');
    expect(ed.selection.size).toBe(0);
  });
});
