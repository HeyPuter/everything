// Paste in Front and Paste in Back next to objects inside compound paths and clipping masks.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

describe('Paste in Front / in Back inside containers', () => {
  let app;
  let ed;
  let doc;
  let copied;
  const add = (x, size) => {
    const p = createPath(rectangle(x, x, size, size), true);
    doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  beforeEach(async () => {
    app = bootApp();
    ed = app.newDocument();
    doc = ed.doc;
    copied = add(200, 10);
    ed.select([copied]);
    await app.commands.run('object.group');
    await app.commands.run('edit.copy');
  });

  it('pastes next to a compound path, never into it, when one of its subpaths is selected', async () => {
    const outer = add(0, 100);
    const inner = add(25, 50);
    ed.select([outer, inner]);
    await app.commands.run('object.compoundMake');
    const [compound] = ed.selection;
    const layer = ed.targetLayer().id;
    ed.selectAnchors(outer, [0]);
    await app.commands.run('edit.pasteFront');
    const [front] = ed.selection;
    ed.selectAnchors(inner, [0]);
    await app.commands.run('edit.pasteBack');
    const [back] = ed.selection;
    expect(doc.get(compound).children).toEqual([outer, inner]);
    const kids = doc.get(layer).children;
    expect(kids.slice(-3)).toEqual([back, compound, front]);
    expect(doc.get(front).type).toBe('group');
  });

  it('keeps the clipping path clipping when pasting in front of it', async () => {
    const art = add(0, 100);
    const mask = add(25, 50);
    ed.select([art, mask]);
    await app.commands.run('object.clipMake');
    const [clip] = ed.selection;
    ed.selectAnchors(mask, [0]);
    await app.commands.run('edit.pasteFront');
    const [pasted] = ed.selection;
    expect(doc.get(clip).children).toEqual([art, pasted, mask]);
  });
});
