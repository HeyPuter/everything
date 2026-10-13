import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { createGroup, createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { applyStyle, commonStyle } from '../src/ops/paint-ops.js';
import { stackItems, itemPaint } from '../src/model/appearance.js';
import { appearanceOwners, setAppearanceTarget, effectItemIndex } from '../src/features/paint/appearance-ops.js';
import { applyEffect } from '../src/features/paint/effects-ui.js';
import { createEffect } from '../src/features/paint/effects-model.js';

const solid = (color) => ({ type: 'solid', color });
const kinds = (n) => stackItems(n).map((it) => (it.base ? `${it.type}*` : it.type));
const rowLabels = (p) => [...p.list.querySelectorAll('.ap-row')].map((r) => r.getAttribute('aria-label'));
const key = (el, k, opts = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

describe('Appearance panel: fills and strokes', () => {
  it('adds a stroke above the picked item and edits it from the paint panels', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2 });
    ed.select([id]);
    const p = panel('appearance');
    expect(rowLabels(p)).toEqual(['Stroke:', 'Fill:', 'Opacity: Default']);
    // Pick the fill, then Add New Stroke: it goes right above the fill (under the base stroke).
    p.pick('item:0');
    p.addPaint('stroke');
    expect(kinds(ed.doc.get(id))).toEqual(['fill*', 'stroke', 'stroke*']);
    const added = stackItems(ed.doc.get(id))[1];
    expect(added.stroke).toEqual(solid('#0000ff'));
    expect(added.strokeWidth).toBe(2);
    expect(p.selectedRow).toBe('item:1');
    expect(rowLabels(p)).toEqual(['Stroke:', 'Stroke:', 'Fill:', 'Opacity: Default']);
    // The paint panels now edit the new stroke, not the object's own.
    expect(commonStyle(ed, 'stroke')).toEqual(solid('#0000ff'));
    applyStyle(ed, { stroke: solid('#00ff00'), strokeWidth: 9 }, 'Stroke Color');
    const n = ed.doc.get(id);
    expect(stackItems(n)[1].stroke).toEqual(solid('#00ff00'));
    expect(stackItems(n)[1].strokeWidth).toBe(9);
    expect(n.stroke).toEqual(solid('#0000ff'));
    expect(n.strokeWidth).toBe(2);
    expect(commonStyle(ed, 'strokeWidth')).toBe(9);
    // Fill edits still go to the object's fill.
    applyStyle(ed, { fill: solid('#ffff00') });
    expect(ed.doc.get(id).fill).toEqual(solid('#ffff00'));
    // Picking the object's own stroke sends edits there again.
    p.pick('item:2');
    applyStyle(ed, { stroke: solid('#111111') });
    expect(ed.doc.get(id).stroke).toEqual(solid('#111111'));
    expect(stackItems(ed.doc.get(id))[1].stroke).toEqual(solid('#00ff00'));
    // One undo step per edit.
    ed.doc.undo();
    expect(ed.doc.get(id).stroke).toEqual(solid('#0000ff'));
  });

  it('turns on a None fill instead of stacking a second one', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: null, stroke: solid('#000000') });
    ed.select([id]);
    const p = panel('appearance');
    p.addPaint('fill');
    expect(ed.doc.get(id).fill).toEqual(solid('#ffffff'));
    expect(ed.doc.get(id).appearance).toBeUndefined();
    // The fill row is picked now: the next fill goes right above it.
    p.addPaint('fill');
    expect(kinds(ed.doc.get(id))).toEqual(['fill*', 'fill', 'stroke*']);
  });

  it('duplicates, hides, reorders and removes items', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2 });
    ed.select([id]);
    const p = panel('appearance');
    p.pick('item:1');
    p.duplicateItem();
    let n = ed.doc.get(id);
    expect(kinds(n)).toEqual(['fill*', 'stroke*', 'stroke']);
    expect(stackItems(n)[2]).toMatchObject({ stroke: solid('#0000ff'), strokeWidth: 2 });
    p.update();
    // The eye hides just that item.
    const eye = p.list.querySelector('[data-row="item:2"] .ap-eye');
    eye.click();
    expect(stackItems(ed.doc.get(id))[2].hidden).toBe(true);
    p.update();
    p.list.querySelector('[data-row="item:2"] .ap-eye').click();
    expect(stackItems(ed.doc.get(id))[2].hidden).toBeUndefined();
    // Alt+Down on the top row moves it under the fill... one step at a time.
    p.update();
    key(p.list.querySelector('[data-row="item:2"]'), 'ArrowDown', { altKey: true });
    expect(kinds(ed.doc.get(id))).toEqual(['fill*', 'stroke', 'stroke*']);
    key(p.list.querySelector('[data-row="item:1"]'), 'ArrowDown', { altKey: true });
    expect(kinds(ed.doc.get(id))).toEqual(['stroke', 'fill*', 'stroke*']);
    expect(p.selectedRow).toBe('item:0');
    // Dropping a row above another moves it up the stack.
    p.dropItem('item:0', 2, false);
    expect(kinds(ed.doc.get(id))).toEqual(['fill*', 'stroke*', 'stroke']);
    // Removing the object's own stroke hands its place to the other stroke.
    ed.doc.transact('Recolor', () => ed.doc.update(id, { appearance: ed.doc.get(id).appearance.map((it) => (it.base ? it : { ...it, stroke: solid('#00ff00'), strokeWidth: 5 })) }));
    p.pick('item:1');
    p.deleteItem();
    n = ed.doc.get(id);
    expect(n.stroke).toEqual(solid('#00ff00'));
    expect(n.strokeWidth).toBe(5);
    expect(n.appearance).toBeUndefined();
    // Removing the only stroke leaves None.
    p.pick('item:1');
    p.deleteItem();
    expect(ed.doc.get(id).stroke).toBe(null);
  });

  it('gives a picked item its own effects and opacity', async () => {
    const { app, ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2 });
    ed.select([id]);
    const p = panel('appearance');
    p.pick('item:1');
    expect(effectItemIndex(ed)).toBe(1);
    applyEffect(app, createEffect('dropShadow'));
    const n = ed.doc.get(id);
    expect(n.effects || []).toEqual([]);
    expect(stackItems(n)[1].effects.map((e) => e.type)).toEqual(['dropShadow']);
    p.update();
    // The disclosure shows the item's effect and opacity.
    expect(p.list.querySelector('[data-row="item:1"] .ap-tw').getAttribute('aria-expanded')).toBe('false');
    key(p.list.querySelector('[data-row="item:1"]'), 'ArrowRight');
    expect(rowLabels(p)).toEqual(['Stroke:', 'Drop Shadow', 'Opacity: Default', 'Fill:', 'Opacity: Default']);
    p.openItemOpacity(p.list.querySelector('[data-row="item:1:opacity"]'), 1);
    const input = document.querySelector('.ap-item-opacity input');
    input.value = '40';
    key(input, 'Enter');
    expect(stackItems(ed.doc.get(id))[1].opacity).toBeCloseTo(0.4);
    const sel = document.querySelector('.ap-item-opacity select');
    sel.value = 'multiply';
    sel.dispatchEvent(new Event('change'));
    expect(stackItems(ed.doc.get(id))[1].blendMode).toBe('multiply');
    // Picking an object-level row sends new effects to the object again.
    p.pick('opacity');
    expect(effectItemIndex(ed)).toBe(null);
    applyEffect(app, createEffect('blur'));
    expect(ed.doc.get(id).effects.map((e) => e.type)).toEqual(['blur']);
    // Item effects delete from their own row.
    p.pick('item:1:fx:0');
    p.deleteItem();
    expect(stackItems(ed.doc.get(id))[1].effects).toBeUndefined();
  });

  it('clears, reduces and shows hidden attributes', async () => {
    const { ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), effects: [{ ...createEffect('blur'), hidden: true }], appearance: [{ type: 'fill', base: true, hidden: true }, { type: 'stroke', base: true }, { type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 4 }] });
    ed.select([id]);
    const p = panel('appearance');
    expect(menuItem(p, 'Show All Hidden Attributes').enabled).toBe(true);
    menuItem(p, 'Show All Hidden Attributes').run();
    let n = ed.doc.get(id);
    expect(stackItems(n).some((it) => it.hidden)).toBe(false);
    expect(n.effects[0].hidden).toBeUndefined();
    menuItem(p, 'Reduce to Basic Appearance').run();
    n = ed.doc.get(id);
    expect(n.appearance).toBeUndefined();
    expect(n.effects).toEqual([]);
    expect(n.fill).toEqual(solid('#ff0000'));
    ed.doc.transact('x', () => ed.doc.update(id, { appearance: [{ type: 'fill', base: true }, { type: 'fill', fill: solid('#000000') }, { type: 'stroke', base: true }] }));
    menuItem(p, 'Clear Appearance').run();
    n = ed.doc.get(id);
    expect([n.fill, n.stroke, n.appearance]).toEqual([null, null, undefined]);
  });
});

describe('Appearance panel: containers', () => {
  it('shows a group stack with its contents and adds group strokes', async () => {
    const { ed, doc, panel } = await paintSetup();
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    const b = createPath(rectangle(20, 0, 10, 10), true, { fill: solid('#ff0000') });
    const g = createGroup([a.id, b.id]);
    doc.transact('add', () => doc.insert(g, ed.targetLayer().id, Infinity, [a, b]));
    doc.repairParents();
    ed.select([g.id]);
    const p = panel('appearance');
    expect(rowLabels(p)).toEqual(['Contents', 'Opacity: Default']);
    p.addPaint('stroke');
    expect(kinds(doc.get(g.id))).toEqual(['contents', 'stroke']);
    // The group's stroke is the target of the paint panels; its children keep theirs.
    applyStyle(ed, { stroke: solid('#00ff00') });
    expect(stackItems(doc.get(g.id))[1].stroke).toEqual(solid('#00ff00'));
    expect(doc.get(a.id).stroke).toEqual(solid('#000000'));
    // Without a picked item, paint goes to the contents as before.
    setAppearanceTarget(ed, null);
    applyStyle(ed, { fill: solid('#0000ff') });
    expect(doc.get(a.id).fill).toEqual(solid('#0000ff'));
    // Activating Contents selects the group's objects.
    p.update(true);
    key(p.list.querySelector('[data-row="item:0"]'), 'Enter');
    expect([...ed.selection].sort()).toEqual([a.id, b.id].sort());
  });

  it('targets a layer from the Layers panel', async () => {
    const { app, ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#ff0000') });
    const layer = ed.targetLayer();
    app.openPanel('layers');
    const lp = app.dock.panels.get('layers');
    lp.ensureBuilt();
    lp.selectRow(ed.doc.get(layer.id), {});
    expect(appearanceOwners(ed).map((n) => n.id)).toEqual([layer.id]);
    const p = panel('appearance');
    expect(p.kind.textContent).toBe('Layer');
    p.addPaint('fill');
    expect(kinds(ed.doc.get(layer.id))).toEqual(['contents', 'fill']);
    expect(itemPaint(ed.doc.get(layer.id), stackItems(ed.doc.get(layer.id))[1])).toEqual(solid('#ffffff'));
    // Selecting something else targets that object again.
    ed.select([id]);
    expect(appearanceOwners(ed).map((n) => n.id)).toEqual([id]);
  });

  it('shows Characters for type and mixed stacks as mixed', async () => {
    const { app, ed, add, panel } = await paintSetup();
    const a = add({ fill: solid('#ff0000') });
    const b = add({ fill: solid('#ff0000'), appearance: [{ type: 'stroke', base: true }, { type: 'fill', base: true }] }, [20, 0, 10, 10]);
    ed.select([a, b]);
    const p = panel('appearance');
    expect(p.list.textContent).toContain('Mixed Appearances');
    const t = createText('Hello', 0, 40);
    ed.doc.transact('add', () => ed.doc.insert(t, ed.targetLayer().id));
    ed.select([t.id]);
    p.update(true);
    expect(rowLabels(p)).toEqual(['Characters', 'Opacity: Default']);
    // A new stroke on type paints every character over their own paint.
    p.addPaint('stroke');
    expect(kinds(ed.doc.get(t.id))).toEqual(['contents', 'stroke']);
    expect(rowLabels(p)).toEqual(['Stroke:', 'Characters', 'Opacity: Default']);
    expect(app.editor).toBe(ed);
  });
});
