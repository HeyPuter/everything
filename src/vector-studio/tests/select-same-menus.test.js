import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { MENUS } from '../src/ui/menus.js';
import { resolveItems } from '../src/ui/menubar.js';
import { saveSelection, savedSelectionsOf, applySavedSelection } from '../src/features/panels/select-commands.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });
const anchor = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });

let app;
let doc;
const sel = () => [...app.editor.selection].sort();

function addNode(node) {
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return node.id;
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 600, height: 400 });
  ed.view.set({ width: 800, height: 600 });
  doc = ed.doc;
});

describe('Select > Same', () => {
  it('lists the new entries in reference order', () => {
    const select = MENUS.find((m) => m.label === 'Select');
    const same = select.submenu.find((i) => i.label === 'Same').submenu;
    expect(same[0]).toBe('select.same.shapesText');
    expect(same.indexOf('select.same.size')).toBe(same.indexOf('select.same.fontSize') + 1);
    expect(same.indexOf('select.same.textFillStroke')).toBe(same.indexOf('select.same.textStroke') + 1);
    const object = select.submenu.find((i) => i.label === 'Object').submenu;
    expect(object.indexOf('select.object.bristleStrokes')).toBe(object.indexOf('select.object.brushStrokes') - 1);
    expect(select.submenu.indexOf('select.update')).toBe(select.submenu.indexOf('select.edit') + 1);
    for (const id of ['select.same.shapesText', 'select.same.size', 'select.same.textFillStroke', 'select.object.bristleStrokes', 'select.update']) expect(app.commands.get(id), id).toBeTruthy();
  });

  it('Shapes & Text matches outlines whatever their paint and text by its characters', () => {
    const a = addNode(createPath(rectangle(10, 10, 40, 20), true, { fill: solid('#ff0000') }));
    const b = addNode(createPath(rectangle(200, 50, 40, 20), true, { fill: solid('#00ff00'), strokeWidth: 4 }));
    addNode(createPath(rectangle(10, 100, 40, 30), true, { fill: solid('#ff0000') }));
    const t1 = addNode(createText('Label', 10, 200));
    const t2 = addNode(createText('Label', 300, 200, { fill: solid('#0000ff'), char: { ...createText('', 0, 0).char, fontSize: 30 } }));
    addNode(createText('Other', 300, 300));
    app.editor.select([a]);
    app.commands.run('select.same.shapesText');
    expect(sel()).toEqual([a, b].sort());
    app.editor.select([t1]);
    app.commands.run('select.same.shapesText');
    expect(sel()).toEqual([t1, t2].sort());
    // Several references: the union of their matches.
    app.editor.select([a, t1]);
    app.commands.run('select.same.shapesText');
    expect(sel()).toEqual([a, b, t1, t2].sort());
  });

  it('matches font size alone, and text fill and stroke together', () => {
    const base = createText('', 0, 0).char;
    const a = addNode(createText('one', 10, 50, { char: { ...base, fontFamily: 'Lato', fontSize: 18 } }));
    const b = addNode(createText('two', 10, 100, { char: { ...base, fontFamily: 'Lora', fontSize: 18 }, stroke: solid('#ff0000'), strokeWidth: 1 }));
    const c = addNode(createText('three', 10, 150, { char: { ...base, fontFamily: 'Lato', fontSize: 24 }, stroke: solid('#ff0000'), strokeWidth: 1 }));
    app.editor.select([a]);
    app.commands.run('select.same.size');
    expect(sel()).toEqual([a, b].sort());
    app.editor.select([b]);
    app.commands.run('select.same.textFillStroke');
    expect(sel()).toEqual([b, c].sort());
    app.editor.select([a]);
    app.commands.run('select.same.textFillStroke');
    expect(sel()).toEqual([a]);
  });
});

describe('Select > Object > Bristle Brush Strokes', () => {
  it('selects only strokes painted with a bristle brush', () => {
    const bristle = addNode(createPath([anchor(0, 0), anchor(100, 0)], false, { brush: { id: 'lib.bristle.soft-round' } }));
    const basic = addNode(createPath([anchor(0, 50), anchor(100, 50)], false, { brush: { id: 'def.basic' } }));
    addNode(createPath([anchor(0, 90), anchor(100, 90)], false));
    app.commands.run('select.object.bristleStrokes');
    expect(sel()).toEqual([bristle]);
    app.commands.run('select.object.brushStrokes');
    expect(sel()).toEqual([bristle, basic].sort());
  });
});

describe('Select > Update Selection', () => {
  it('stores the current selection in the saved selection last saved or chosen', () => {
    const a = addNode(createPath(rectangle(10, 10, 20, 20), true));
    const b = addNode(createPath(rectangle(50, 10, 20, 20), true));
    const c = addNode(createPath(rectangle(90, 10, 20, 20), true));
    doc.transact('Save', () => saveSelection(doc, 'Pair', [a, b]));
    const id = savedSelectionsOf(doc)[0].id;
    app.editor.select([c]);
    // Nothing chosen yet in this window.
    expect(app.commands.isEnabled('select.update')).toBe(false);
    applySavedSelection(app.editor, id);
    expect(sel()).toEqual([a, b].sort());
    app.editor.select([a, c]);
    expect(app.commands.isEnabled('select.update')).toBe(true);
    expect(app.commands.label('select.update')).toContain('Pair');
    app.commands.run('select.update');
    expect(savedSelectionsOf(doc)[0].ids.sort()).toEqual([a, c].sort());
    doc.undo();
    expect(savedSelectionsOf(doc)[0].ids.sort()).toEqual([a, b].sort());
    // The menu marks the active saved selection.
    const select = MENUS.find((m) => m.label === 'Select');
    const items = resolveItems(app, select.submenu);
    const saved = items.find((i) => i.label === 'Saved Selections');
    expect(saved.items[0].checked).toBe(true);
  });
});
