// Redo puts back the selection each command left, and Undo the one it started from.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const sel = (ed) => [...ed.selection].sort();

describe('selection after undo and redo of object commands', () => {
  let app;
  let ed;
  let a;
  let b;
  beforeEach(() => {
    app = bootApp();
    ed = app.newDocument();
    const add = (x) => {
      const p = createPath(rectangle(x, 0, 10, 10), true);
      ed.doc.transact('Rect', () => ed.doc.insert(p, ed.targetLayer().id));
      return p.id;
    };
    a = add(0);
    b = add(20);
    ed.select([a, b]);
  });

  /** Run a command, then check Undo and Redo restore the selections around it. */
  async function roundTrip(cmd) {
    const before = sel(ed);
    const label = ed.doc.undoLabel;
    await app.commands.run(cmd);
    expect(ed.doc.undoLabel).not.toBe(label);
    const after = sel(ed);
    await app.commands.run('edit.undo');
    expect(sel(ed)).toEqual(before);
    await app.commands.run('edit.redo');
    expect(sel(ed)).toEqual(after);
    return after;
  }

  it('Group selects the group again on Redo', async () => {
    const after = await roundTrip('object.group');
    expect(after).toHaveLength(1);
    expect(ed.doc.get(after[0]).type).toBe('group');
  });

  it('Ungroup selects the released objects again on Redo', async () => {
    await app.commands.run('object.group');
    expect(await roundTrip('object.ungroup')).toEqual([a, b].sort());
  });

  it('Lock and Hide leave nothing selected after Redo', async () => {
    expect(await roundTrip('object.lock')).toEqual([]);
    await app.commands.run('object.unlockAll');
    ed.select([a]);
    expect(await roundTrip('object.hide')).toEqual([]);
  });

  it('Unlock All and Show All select what they released again on Redo', async () => {
    await app.commands.run('object.lock');
    expect(await roundTrip('object.unlockAll')).toEqual([a, b].sort());
    await app.commands.run('object.hide');
    expect(await roundTrip('object.showAll')).toEqual([a, b].sort());
  });

  it('Clipping mask, compound path and their releases select their results on Redo', async () => {
    const clip = await roundTrip('object.clipMake');
    expect(ed.doc.get(clip[0]).clip).toBe(true);
    await app.commands.run('edit.undo');
    const compound = await roundTrip('object.compoundMake');
    expect(ed.doc.get(compound[0]).type).toBe('compound');
    expect(await roundTrip('object.compoundRelease')).toEqual([a, b].sort());
  });

  it('Paste selects the pasted copies again on Redo', async () => {
    await app.commands.run('edit.copy');
    const after = await roundTrip('edit.pasteFront');
    expect(after).toHaveLength(2);
    expect(after).not.toContain(a);
  });

  it('Clear leaves nothing selected after Redo', async () => {
    expect(await roundTrip('edit.clear')).toEqual([]);
  });
});
