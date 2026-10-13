import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { docBrushes, setDocBrushes } from '../src/features/brushes/brush-model.js';
import { userLibraries } from '../src/features/paint/user-libraries.js';
import { symbolDefs } from '../src/features/symbols/model.js';
import { swatchesOf, groupsOf } from '../src/features/paint/swatch-model.js';
import { anchor } from '../src/model/bezier.js';
import { createPath } from '../src/model/nodes.js';

const labelsOf = (spec) => spec.filter((x) => x && typeof x === 'object').map((x) => x.label);

describe('Brushes panel menu', () => {
  it('is the panel header menu, sorts by name and saves user libraries', async () => {
    const { app, ed, panel, menuItem } = await paintSetup();
    const p = panel('brushes');
    expect(p.el.querySelector('[aria-label="Brushes Panel Menu"]')).toBe(null);
    const labels = labelsOf(p.menu());
    for (const l of ['New Brush...', 'Duplicate Brush', 'Delete Brush', 'Remove Brush Stroke', 'Sort by Name', 'Select All Unused', 'Thumbnail View', 'List View', 'Brush Options...', 'Open Brush Library', 'Save Brush Library...']) expect(labels).toContain(l);
    const doc = ed.doc;
    const list = docBrushes(doc).filter((b) => b.type === docBrushes(doc)[0].type).slice(0, 2);
    doc.transact('t', () => setDocBrushes(doc, [{ ...list[0], name: 'Zulu' }, { ...list[1], name: 'Alpha' }]));
    menuItem(p, 'Sort by Name').run();
    expect(docBrushes(doc).map((b) => b.name)).toEqual(['Alpha', 'Zulu']);
    app.dialogs.form = async () => ({ name: 'Kit' });
    await menuItem(p, 'Save Brush Library...').run();
    const saved = userLibraries(app, 'brushes');
    expect(saved[0].name).toBe('Kit');
    expect(saved[0].items.map((b) => b.name)).toEqual(['Alpha', 'Zulu']);
    // The saved library opens in the panel and its brushes join a document when used.
    menuItem(p, 'Open Brush Library').submenu.find((x) => x.label === 'User Defined').submenu[0].run();
    expect(p.source).toBe(`user:${saved[0].id}`);
    expect(p.brushes().length).toBe(2);
    doc.transact('t', () => setDocBrushes(doc, []));
    const path = createPath([anchor(0, 0), anchor(100, 0)], false, { stroke: { type: 'solid', color: '#000000' }, strokeWidth: 1 });
    doc.transact('Add', () => doc.insert(path, ed.targetLayer().id));
    ed.select([path.id]);
    p.choose(p.brushes()[0]);
    expect(docBrushes(doc).map((b) => b.name)).toEqual(['Alpha']);
    expect(doc.get(path.id).brush.id).toBe(saved[0].items[0].id);
  });
});

describe('Symbols panel menu', () => {
  it('saves symbols as a user library and adds them back', async () => {
    const { app, ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: { type: 'solid', color: '#ff0000' } });
    ed.select([id]);
    app.dialogs.form = async () => ({ name: 'Star', kind: 'dynamic', reg: 'cc' });
    app.dialogs.open = async ({ buttons }) => {
      const ok = buttons?.find((b) => b.primary);
      return typeof ok?.value === 'function' ? ok.value() : ok?.value;
    };
    await app.commands.run('symbol.new', { direct: true });
    expect(symbolDefs(ed.doc).length).toBe(1);
    const p = panel('symbols');
    expect(p.el.querySelector('[aria-label="Symbols panel menu"]')).toBe(null);
    const labels = p.menu().map((x) => (typeof x === 'string' ? x : x.label));
    expect(labels).toContain('Save Symbol Library...');
    expect(labels).toContain('symbol.sortByName');
    app.dialogs.form = async () => ({ name: 'My Set' });
    await menuItem(p, 'Save Symbol Library...').run();
    expect(userLibraries(app, 'symbols')[0].name).toBe('My Set');
    // A new document gets the symbols from User Defined.
    const ed2 = app.newDocument();
    expect(symbolDefs(ed2.doc).length).toBe(0);
    menuItem(p, 'Open Symbol Library').submenu.find((x) => x.label === 'User Defined').submenu[0].run();
    expect(symbolDefs(ed2.doc).length).toBe(1);
  });
});

describe('Color Guide panel menu', () => {
  it('switches variations and rules, limits colors and sets options with a live preview', async () => {
    const { app, ed, panel, menuItem } = await paintSetup();
    const p = panel('colorGuide');
    const labels = labelsOf(p.menu());
    expect(labels).toEqual(['Show Tints and Shades', 'Show Warm and Cool', 'Show Vivid and Muted', 'Harmony Rules', 'Limit Colors to Swatch Library', 'Set Base Color to Current Color', 'Save Colors as Swatches', 'Edit or Apply Colors...', 'Color Guide Options...']);
    menuItem(p, 'Show Warm and Cool').run();
    expect(p.settings.variation).toBe('warmCool');
    expect(p.leftLabel.textContent).toBe('Cool');
    menuItem(p, 'Triad').run();
    expect(p.settings.rule).toBe('triad');
    expect(p.strip.children.length).toBe(3);
    const limit = menuItem(p, 'Limit Colors to Swatch Library').submenu;
    expect(limit[0].label).toBe('None');
    if (limit[1]) {
      limit[1].run();
      expect(p.settings.limit).not.toBe('none');
    }
    let preview = null;
    app.dialogs.form = async ({ onChange }) => {
      onChange({ steps: 2, amount: 50 });
      preview = p.grid.querySelector('.cg-grid-row').children.length;
      return null;
    };
    await menuItem(p, 'Color Guide Options...').run();
    expect(preview).toBe(5);
    expect(p.settings.steps).toBe(4);
    app.dialogs.form = async () => ({ steps: 3, amount: 60 });
    await menuItem(p, 'Color Guide Options...').run();
    expect(p.settings.steps).toBe(3);
    expect(p.settings.amount).toBe(60);
    const groups = groupsOf(ed.doc).length;
    menuItem(p, 'Save Colors as Swatches').run();
    expect(groupsOf(ed.doc).length).toBe(groups + 1);
    expect(swatchesOf(ed.doc).length).toBeGreaterThan(0);
  });
});

describe('Pattern Options panel menu', () => {
  it('lists pattern commands and toggles options while editing', async () => {
    const { app, ed, add, panel, menuItem } = await paintSetup();
    const p = panel('patternOptions');
    const labels = p.menu().map((x) => (typeof x === 'string' ? x : x.label));
    expect(labels).toEqual(['Make Pattern', 'pattern.edit', '-', 'Save a Copy...', 'Exit Pattern Editing', 'pattern.cancel', '-', 'Size Tile to Art', 'Move Tile with Art', '-', 'Dim Copies', 'Show Tile Edge', 'Show Swatch Bounds', '-', 'pattern.tileEdgeColor']);
    expect(menuItem(p, 'Show Tile Edge').enabled).toBe(false);
    const id = add({ fill: { type: 'solid', color: '#ff0000' } });
    ed.select([id]);
    app.commands.run('pattern.make');
    p.update();
    const before = menuItem(p, 'Show Tile Edge').checked;
    menuItem(p, 'Show Tile Edge').run();
    expect(menuItem(p, 'Show Tile Edge').checked).toBe(!before);
    app.commands.run('pattern.cancel');
  });
});
