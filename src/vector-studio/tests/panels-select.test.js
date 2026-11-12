import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { createEffect } from '../src/features/paint/effects-model.js';
import { DEFAULT_GRAPHIC_STYLES } from '../src/features/paint/graphic-styles.js';
import { bootAppWithFeatures } from './helpers.js';
import { appearanceAttributes, matchesStyle, similarObjects, savedSelectionsOf } from '../src/features/panels/select-commands.js';
import { resolveItems } from '../src/ui/menubar.js';
import { MENUS } from '../src/ui/menus.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const solid = (color) => ({ type: 'solid', color });

async function setup() {
  const app = await bootAppWithFeatures();
  const notes = [];
  app.notify = (m) => notes.push(m);
  const ed = app.newDocument({ width: 400, height: 300 });
  const doc = ed.doc;
  const add = (anchors, style = {}, closed = true) => {
    const p = createPath(anchors, closed, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  return { app, ed, doc, add, notes };
}

describe('Select > Same > Appearance Attribute', () => {
  it('selects objects sharing an effect kind', async () => {
    const { app, ed, add } = await setup();
    const shadow = createEffect('dropShadow', { x: 2, y: 2 });
    const a = add(rectangle(0, 0, 10, 10), { effects: [shadow] });
    const b = add(rectangle(20, 0, 10, 10), { effects: [createEffect('dropShadow', { x: 9, y: 9 }), createEffect('blur', { radius: 2 })] });
    add(rectangle(40, 0, 10, 10), { effects: [createEffect('blur', { radius: 2 })] });
    add(rectangle(60, 0, 10, 10));
    expect(appearanceAttributes(ed.doc.get(b))).toEqual(['dropShadow', 'blur']);
    ed.select([a]);
    await app.commands.run('select.same.appearanceAttribute');
    expect([...ed.selection].sort()).toEqual([a, b].sort());
  });

  it('is unavailable for objects without attributes', async () => {
    const { app, ed, add } = await setup();
    ed.select([add(rectangle(0, 0, 10, 10))]);
    expect(app.commands.isEnabled('select.same.appearanceAttribute')).toBe(false);
    ed.select([add(rectangle(20, 0, 10, 10), { effects: [createEffect('blur', { radius: 2 })] })]);
    expect(app.commands.isEnabled('select.same.appearanceAttribute')).toBe(true);
  });
});

describe('Select > Same > Graphic Style', () => {
  it('selects the objects whose appearance matches the same graphic style', async () => {
    const { app, ed, add, notes } = await setup();
    const neon = DEFAULT_GRAPHIC_STYLES.find((s) => s.id === 'gs-neon').style;
    const a = add(rectangle(0, 0, 10, 10), structuredClone(neon));
    const b = add(ellipse(20, 0, 10, 10), structuredClone(neon));
    const c = add(rectangle(40, 0, 10, 10), { fill: solid('#ff0000') });
    expect(matchesStyle(ed.doc, ed.doc.get(a), neon)).toBe(true);
    expect(matchesStyle(ed.doc, ed.doc.get(c), neon)).toBe(false);
    ed.select([a]);
    await app.commands.run('select.same.graphicStyle');
    expect([...ed.selection].sort()).toEqual([a, b].sort());
    ed.select([c]);
    expect(app.commands.isEnabled('select.same.graphicStyle')).toBe(false);
    expect(notes).toEqual([]);
  });
});

describe('Select > Object > Direction Handles', () => {
  it('selects the anchors with handles and switches to Direct Selection', async () => {
    const { app, ed, add } = await setup();
    const curve = add([anchor(0, 0), { x: 50, y: 0, ix: 40, iy: -10, ox: 60, oy: 10 }, anchor(100, 0)], { fill: null }, false);
    ed.select([curve]);
    await app.commands.run('select.object.handles');
    expect(app.toolId).toBe('direct-selection');
    expect([...ed.anchors.get(curve)]).toEqual([1]);
  });
});

describe('Global Edit', () => {
  it('finds objects with the same shape and appearance, wherever they are', async () => {
    const { ed, doc, add } = await setup();
    const a = add(rectangle(0, 0, 20, 10), { fill: solid('#ff0000') });
    const b = add(rectangle(100, 50, 20, 10), { fill: solid('#ff0000') });
    add(rectangle(200, 0, 20, 11), { fill: solid('#ff0000') });
    add(rectangle(250, 0, 20, 10), { fill: solid('#00ff00') });
    expect(similarObjects(doc, doc.get(a)).sort()).toEqual([a, b].sort());
    void ed;
  });

  it('reshaping one member reshapes the others in the same undo step', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(rectangle(0, 0, 20, 10), { fill: solid('#ff0000') });
    const b = add(rectangle(100, 50, 20, 10), { fill: solid('#ff0000') });
    ed.select([a]);
    await app.commands.run('select.globalEdit');
    expect(app.globalEdit.size).toBe(2);
    expect(app.commands.label('select.globalEdit')).toBe('Stop Global Edit');
    const undo0 = doc.undoStack.length;
    doc.transact('Move Anchor', () => {
      const an = doc.get(a).anchors.map((p, i) => (i === 2 ? { ...p, x: p.x + 5, ix: p.ix + 5, ox: p.ox + 5 } : p));
      doc.update(a, { anchors: an });
    });
    expect(doc.undoStack.length).toBe(undo0 + 1);
    const bx = doc.get(b).anchors.map((p) => p.x - 100);
    const ax = doc.get(a).anchors.map((p) => p.x);
    expect(bx).toEqual(ax);
    // Appearance changes follow too.
    doc.transact('Fill', () => doc.update(b, { fill: solid('#0000ff') }));
    expect(doc.get(a).fill.color).toBe('#0000ff');
    // Moving one object moves only that object.
    doc.transact('Move', () => doc.update(a, { anchors: doc.get(a).anchors.map((p) => ({ ...p, x: p.x + 30, ix: p.ix + 30, ox: p.ox + 30 })) }));
    expect(doc.get(b).anchors[0].x).toBe(100);
    doc.undo();
    doc.undo();
    doc.undo();
    expect(doc.get(b).anchors.map((p) => p.x)).toEqual(rectangle(100, 50, 20, 10).map((p) => p.x));
    // After undo, editing the other member still propagates from it.
    doc.transact('Move Anchor', () => doc.update(b, { anchors: doc.get(b).anchors.map((p, i) => (i === 0 ? { ...p, y: p.y - 4, iy: p.iy - 4, oy: p.oy - 4 } : p)) }));
    expect(doc.get(a).anchors[0].y).toBe(-4);
    expect(doc.get(b).anchors[0].y).toBe(46);
    await app.commands.run('select.globalEdit');
    expect(app.globalEdit).toBeNull();
  });
});

describe('Saved selections', () => {
  it('saves, lists in the menu, reselects and edits named selections', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(rectangle(0, 0, 10, 10));
    const b = add(rectangle(20, 0, 10, 10));
    add(rectangle(40, 0, 10, 10));
    ed.select([a, b]);
    let done = app.commands.run('select.save');
    await tick();
    let dlg = document.querySelector('dialog[open]');
    const input = dlg.querySelector('input');
    input.value = 'Pair';
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'OK').click();
    await done;
    expect(savedSelectionsOf(doc)).toMatchObject([{ name: 'Pair', ids: [a, b] }]);
    ed.clearSelection();
    const select = MENUS.find((m) => m.label === 'Select');
    const sub = resolveItems(app, select.submenu).find((i) => i.label === 'Saved Selections');
    expect(sub.items.map((i) => i.label)).toEqual(['Pair']);
    sub.items[0].run(app);
    expect([...ed.selection].sort()).toEqual([a, b].sort());
    // Edit Selection renames.
    done = app.commands.run('select.edit');
    await tick();
    dlg = document.querySelector('dialog[open]');
    const name = dlg.querySelector('input[type=text]');
    name.value = 'Two squares';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'OK').click();
    await done;
    expect(savedSelectionsOf(doc)[0].name).toBe('Two squares');
    doc.undo();
    expect(savedSelectionsOf(doc)[0].name).toBe('Pair');
  });
});
