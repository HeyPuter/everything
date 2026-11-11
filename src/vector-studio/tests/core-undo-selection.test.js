// Redo puts back the selection each command left, and Undo the one it started from.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { insertLayer } from '../src/ops/layer-ops.js';

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

describe('Next Object Above and Below', () => {
  it('skip hidden and locked objects instead of selecting them', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [0, 1, 2, 3].map((i) => {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    });
    doc.transact('Hide', () => doc.update(ids[1], { hidden: true }));
    doc.transact('Lock', () => doc.update(ids[2], { locked: true }));
    ed.select([ids[0]]);
    await app.commands.run('select.nextAbove');
    expect([...ed.selection]).toEqual([ids[3]]);
    await app.commands.run('select.nextAbove');
    expect([...ed.selection]).toEqual([ids[3]]);
    await app.commands.run('select.nextBelow');
    expect([...ed.selection]).toEqual([ids[0]]);
  });
});

describe('Arrange', () => {
  it('adds no undo step and keeps the document saved when nothing moves', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [0, 1].map((i) => {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    });
    doc.markSaved();
    ed.select([ids[1]]);
    await app.commands.run('object.bringToFront');
    await app.commands.run('object.bringForward');
    expect(doc.undoLabel).toBe('Rect');
    expect(doc.dirty).toBe(false);
    await app.commands.run('object.sendToBack');
    expect(doc.undoLabel).toBe('Send to Back');
    expect(doc.get(ed.targetLayer().id).children).toEqual([ids[1], ids[0]]);
  });
});

describe('Ungroup', () => {
  it('leaves hidden and locked contents unselected', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [0, 1, 2].map((i) => {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    });
    ed.select(ids);
    await app.commands.run('object.group');
    doc.transact('Flags', () => {
      doc.update(ids[0], { hidden: true });
      doc.update(ids[1], { locked: true });
    });
    await app.commands.run('object.ungroup');
    expect(doc.get(ed.targetLayer().id).children).toEqual(ids);
    expect([...ed.selection]).toEqual([ids[2]]);
  });
});

describe('Unlock All and Show All', () => {
  it('select only what can be selected afterwards', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [0, 1].map((i) => {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    });
    // Both hidden and locked, plus one only locked.
    doc.transact('Flags', () => {
      doc.update(ids[0], { hidden: true, locked: true });
      doc.update(ids[1], { locked: true });
    });
    await app.commands.run('object.unlockAll');
    expect(doc.get(ids[0]).locked).toBe(false);
    expect([...ed.selection]).toEqual([ids[1]]);
    doc.transact('Flags', () => doc.update(ids[0], { locked: true }));
    await app.commands.run('object.showAll');
    expect(doc.get(ids[0]).hidden).toBe(false);
    expect([...ed.selection]).toEqual([]);
  });
});

describe('Duplicate', () => {
  it('puts each copy right above its original, in every container, as one undo step', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const layer = ed.targetLayer().id;
    const ids = [0, 1, 2, 3].map((i) => {
      const p = createPath(rectangle(i * 20, 0, 10, 10), true);
      doc.transact('Rect', () => doc.insert(p, layer));
      return p.id;
    });
    ed.select([ids[2], ids[3]]);
    await app.commands.run('object.group');
    const [g] = ed.selection;
    const [a, b, c, d] = ids;
    ed.select([a, b, d]);
    await app.commands.run('edit.duplicate');
    const copies = [...ed.selection];
    expect(copies).toHaveLength(3);
    expect(doc.get(layer).children).toEqual([a, copies[0], b, copies[1], g]);
    expect(doc.get(g).children).toEqual([c, d, copies[2]]);
    expect(doc.get(copies[2]).parent).toBe(g);
    await app.commands.run('edit.undo');
    expect(doc.get(layer).children).toEqual([a, b, g]);
    expect(doc.get(g).children).toEqual([c, d]);
    // Alt+arrow nudges a copy the same way.
    ed.select([a]);
    app.canvasHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    const [copy] = ed.selection;
    expect(doc.get(layer).children).toEqual([a, copy, b, g]);
    expect(doc.get(copy).anchors[0].x).toBe(doc.get(a).anchors[0].x + 1);
  });
});

describe('object commands with a compound subpath direct-selected', () => {
  let app;
  let ed;
  let doc;
  let compound;
  let outer;
  let other;
  beforeEach(async () => {
    app = bootApp();
    ed = app.newDocument();
    doc = ed.doc;
    const add = (x, size) => {
      const p = createPath(rectangle(x, x, size, size), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    };
    outer = add(0, 100);
    const inner = add(25, 50);
    other = add(200, 10);
    ed.select([outer, inner]);
    await app.commands.run('object.compoundMake');
    [compound] = ed.selection;
  });

  it('Group groups the whole compound path', async () => {
    ed.selectAnchors(outer, [0]);
    ed.select([other], { add: true });
    await app.commands.run('object.group');
    const [g] = ed.selection;
    expect(doc.get(g).children).toEqual([compound, other]);
    expect(doc.get(compound).children.every((id) => doc.get(id).type === 'path')).toBe(true);
  });

  it('Make Clipping Mask and Make Compound Path take the whole compound path', async () => {
    ed.select([other]);
    ed.selectAnchors(outer, [0], { add: true });
    await app.commands.run('object.clipMake');
    const [clip] = ed.selection;
    expect(doc.get(clip).children).toEqual([compound, other]);
    await app.commands.run('edit.undo');
    ed.selectAnchors(outer, [0]);
    ed.select([other], { add: true });
    await app.commands.run('object.compoundMake');
    const [made] = ed.selection;
    expect(doc.has(compound)).toBe(false);
    expect(doc.get(made).children).toHaveLength(3);
    expect(doc.get(made).children.every((id) => doc.get(id).type === 'path')).toBe(true);
  });
});

describe('Arrange inside a clip group', () => {
  it('keeps the clipping path on top, so it keeps clipping', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const ids = [0, 1, 2].map((i) => {
      const p = createPath(rectangle(i * 5, 0, 50, 50), true);
      doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
      return p.id;
    });
    const [a, b, mask] = ids;
    ed.select(ids);
    await app.commands.run('object.clipMake');
    const [clip] = ed.selection;
    ed.selectAnchors(a, [0, 1, 2, 3]);
    await app.commands.run('object.bringToFront');
    expect(doc.get(clip).children).toEqual([b, a, mask]);
    await app.commands.run('object.bringForward');
    expect(doc.get(clip).children).toEqual([b, a, mask]);
    ed.selectAnchors(mask, [0, 1, 2, 3]);
    await app.commands.run('object.sendToBack');
    expect(doc.get(clip).children).toEqual([b, a, mask]);
    ed.selectAnchors(a, [0, 1, 2, 3]);
    await app.commands.run('object.sendToBack');
    expect(doc.get(clip).children).toEqual([a, b, mask]);
  });
});

describe('Select All with sublayers', () => {
  it('selects the objects in visible, unlocked sublayers, never a sublayer itself', async () => {
    const app = bootApp();
    const ed = app.newDocument();
    const doc = ed.doc;
    const layer = ed.targetLayer().id;
    const rect = (x) => createPath(rectangle(x, 0, 10, 10), true);
    const [a, b, c] = [rect(0), rect(20), rect(40)];
    let sub;
    let locked;
    doc.transact('Setup', () => {
      doc.insert(a, layer);
      sub = insertLayer(doc, layer).id;
      doc.insert(b, sub);
      locked = insertLayer(doc, layer, Infinity, { locked: true }).id;
      doc.insert(c, locked);
    });
    await app.commands.run('select.all');
    expect(new Set(ed.selection)).toEqual(new Set([a.id, b.id]));
    await app.commands.run('object.group');
    const [g] = ed.selection;
    expect(doc.get(g).children).toEqual([a.id, b.id]);
    expect(doc.get(sub).type).toBe('layer');
    expect(doc.get(sub).parent).toBe(layer);
  });
});
