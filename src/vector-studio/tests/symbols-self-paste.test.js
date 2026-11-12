import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { instancesOf } from '../src/features/symbols/model.js';
import { editingSymbol } from '../src/features/symbols/editing.js';
import { placeGraphic, useItem } from '../src/features/libraries/panel.js';
import { clipboard } from '../src/ops/clipboard.js';

const NESTED = 'A symbol cannot be placed inside itself.';
let app;

function addRect(x, y) {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, 40, 20), true, {
    fill: { type: 'solid', color: '#ff0000' },
  });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return n.id;
}

/** A symbol "Card" with one instance on the page, and its master open for editing in place. */
async function editCopiedSymbol() {
  const ed = app.editor;
  ed.select([addRect(100, 100)]);
  const { def, instance } = await app.commands.run('symbol.new', { direct: true, name: 'Card' });
  ed.select([instance.id]);
  await app.commands.run('edit.copy');
  await app.commands.run('symbol.edit');
  expect(editingSymbol(ed)).toBe(def.id);
  return { def, instance };
}

const insideMaster = (doc, def) =>
  instancesOf(doc, def.id).filter((n) => doc.isAncestor(def.id, n.id));

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument({ width: 600, height: 400 });
  clipboard.data = null;
});

describe('a symbol pasted into its own master', () => {
  it('every paste command refuses, says why and changes nothing', async () => {
    const { def } = await editCopiedSymbol();
    const doc = app.editor.doc;
    const notes = [];
    app.notify = (m) => notes.push(m);
    const kids = doc.get(def.id).children.slice();
    const undo = doc.history.undoStack?.length;
    for (const id of [
      'edit.paste',
      'edit.pasteFront',
      'edit.pasteBack',
      'edit.pasteInPlace',
      'edit.pasteAll',
    ]) {
      // Paste in Front/Back go next to the selection: select a part of the master.
      app.editor.select([kids[0]]);
      await app.commands.run(id);
      expect(notes.pop(), id).toBe(NESTED);
      expect(doc.get(def.id).children, id).toEqual(kids);
    }
    expect(insideMaster(doc, def)).toHaveLength(0);
    if (undo !== undefined) expect(doc.history.undoStack.length).toBe(undo);
  });

  it('a symbol that uses the one being edited is refused too, other artwork still pastes', async () => {
    const ed = app.editor;
    const doc = ed.doc;
    // Card, then Badge whose master holds a Card instance.
    ed.select([addRect(100, 100)]);
    const card = await app.commands.run('symbol.new', { direct: true, name: 'Card' });
    ed.select([card.instance.id, addRect(300, 100)]);
    const badge = await app.commands.run('symbol.new', { direct: true, name: 'Badge' });
    ed.select([badge.instance.id]);
    await app.commands.run('edit.copy');
    // Edit Card through a fresh Card instance.
    const card2 = await app.commands.run('symbol.place', { id: card.def.id });
    ed.select([card2.id]);
    await app.commands.run('symbol.edit');
    expect(editingSymbol(ed)).toBe(card.def.id);
    const notes = [];
    app.notify = (m) => notes.push(m);
    await app.commands.run('edit.paste');
    expect(notes.pop()).toBe(NESTED);
    expect(insideMaster(doc, badge.def)).toHaveLength(0);
    // Plain artwork pastes into the master as usual.
    const r = addRect(10, 10);
    ed.select([r]);
    await app.commands.run('edit.copy');
    await app.commands.run('symbol.exitEdit');
    ed.select([card2.id]);
    await app.commands.run('symbol.edit');
    const before = doc.get(card.def.id).children.length;
    await app.commands.run('edit.paste');
    expect(doc.get(card.def.id).children).toHaveLength(before + 1);
  });

  it('pasting the instance outside the master still works', async () => {
    const { def } = await editCopiedSymbol();
    await app.commands.run('symbol.exitEdit');
    const n = instancesOf(app.editor.doc, def.id).length;
    await app.commands.run('edit.paste');
    expect(instancesOf(app.editor.doc, def.id)).toHaveLength(n + 1);
  });

  it('placing a library graphic made from an instance refuses inside its master', async () => {
    const { def } = await editCopiedSymbol();
    const doc = app.editor.doc;
    const data = clipboard.data;
    const notes = [];
    app.notify = (m) => notes.push(m);
    const kids = doc.get(def.id).children.slice();
    expect(() => placeGraphic(app, data)).toThrow(NESTED);
    // Clicking or dropping the library item says why instead of failing silently.
    expect(useItem(app, { kind: 'graphic', data })).toBe(false);
    expect(notes.pop()).toBe(NESTED);
    expect(doc.get(def.id).children).toEqual(kids);
  });
});

describe('a symbol moved into its own master', () => {
  it('dragging an instance into the master in the Layers panel is refused', async () => {
    const { def, instance } = await editCopiedSymbol();
    const doc = app.editor.doc;
    const notes = [];
    app.notify = (m) => notes.push(m);
    const lp = app.dock.panels.get('layers');
    lp.expanded ??= new Set();
    const kids = doc.get(def.id).children.slice();
    lp.dropOn([instance.id], doc.get(def.id), 'into');
    expect(notes.pop()).toBe(NESTED);
    expect(doc.get(def.id).children).toEqual(kids);
    expect(insideMaster(doc, def)).toHaveLength(0);
    // Other artwork still moves in.
    const r = addRect(10, 10);
    lp.dropOn([r], doc.get(def.id), 'into');
    expect(doc.get(r).parent).toBe(def.id);
  });
});
