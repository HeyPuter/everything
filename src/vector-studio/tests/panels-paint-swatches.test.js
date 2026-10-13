import { describe, it, expect } from 'vitest';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { swatchesOf, groupsOf, addSwatch, addGroup, findSwatch, updateSwatch, duplicateSwatches, mergeSwatches, ungroupGroups, sortSwatches, unusedSwatchIds, usedColorsMissing, tinted } from '../src/features/paint/swatch-model.js';
import { parseSwatchLibrary, paletteText } from '../src/features/paint/swatch-libraries.js';
import { recentColors, RECENT_MAX } from '../src/features/paint/recent-colors.js';
import { userLibraries } from '../src/features/paint/user-libraries.js';
import { applyStyle } from '../src/ops/paint-ops.js';

const solid = (color, extra = {}) => ({ type: 'solid', color, ...extra });

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (style) => {
    const p = createPath(rectangle(0, 0, 10, 10), true, style);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  const panel = (id) => {
    app.openPanel(id);
    const p = app.dock.panels.get(id);
    p.ensureBuilt();
    p.update();
    return p;
  };
  const menuItem = (p, label) => {
    const find = (spec) => {
      for (const it of spec) {
        if (it && typeof it === 'object' && it.label === label) return it;
        if (it?.submenu) {
          const r = find(it.submenu);
          if (r) return r;
        }
      }
      return null;
    };
    return find(p.menu());
  };
  return { app, ed, doc, add, panel, menuItem };
}

describe('Swatch model operations', () => {
  it('duplicates, merges (relinking global users) and ungroups', async () => {
    const { doc, add } = await setup();
    let a, b, gid;
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      a = addSwatch(doc, { name: 'Keep', paint: solid('#112233'), global: true });
      b = addSwatch(doc, { name: 'Gone', paint: solid('#445566'), global: true });
    });
    const user = add({ fill: solid('#445566', { swatchId: b }) });
    doc.transact('dup', () => duplicateSwatches(doc, [a]));
    expect(swatchesOf(doc).map((s) => s.name)).toEqual(['Keep', 'Keep copy', 'Gone']);
    doc.transact('merge', () => mergeSwatches(doc, [a, b]));
    expect(findSwatch(doc, b)).toBe(null);
    expect(doc.get(user).fill).toEqual(solid('#112233', { swatchId: a }));
    doc.undo();
    expect(doc.get(user).fill.swatchId).toBe(b);
    doc.transact('group', () => (gid = addGroup(doc, 'G', { swatchIds: [a] })));
    expect(findSwatch(doc, a).group).toBe(gid);
    doc.transact('ungroup', () => ungroupGroups(doc, [gid]));
    expect(groupsOf(doc)).toEqual([]);
    expect(findSwatch(doc, a).group).toBeUndefined();
  });

  it('sorts by name and by kind within groups', async () => {
    const { doc } = await setup();
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      addSwatch(doc, { name: 'b grad', paint: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } });
      addSwatch(doc, { name: 'Zed', paint: solid('#000001') });
      addSwatch(doc, { name: 'apple', paint: solid('#000002'), global: true });
      addSwatch(doc, { name: 'Item 10', paint: solid('#000003') });
      addSwatch(doc, { name: 'Item 9', paint: solid('#000004') });
    });
    doc.transact('s', () => sortSwatches(doc, 'name'));
    expect(swatchesOf(doc).map((s) => s.name)).toEqual(['apple', 'b grad', 'Item 9', 'Item 10', 'Zed']);
    doc.transact('s', () => sortSwatches(doc, 'kind'));
    expect(swatchesOf(doc).map((s) => s.name)).toEqual(['Item 9', 'Item 10', 'Zed', 'apple', 'b grad']);
  });

  it('finds unused swatches and used colors that are not swatches', async () => {
    const { doc, add } = await setup();
    let red, blue, green;
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      red = addSwatch(doc, { name: 'Red', paint: solid('#ff0000') });
      blue = addSwatch(doc, { name: 'Blue', paint: solid('#0000ff'), global: true });
      green = addSwatch(doc, { name: 'Green', paint: solid('#00ff00') });
    });
    add({ fill: solid('#FF0000'), stroke: solid('#123456') });
    add({ fill: solid('#999999', { swatchId: blue }) });
    expect(unusedSwatchIds(doc)).toEqual([green]);
    expect(usedColorsMissing(doc)).toContain('#123456');
    expect(usedColorsMissing(doc)).not.toContain('#ff0000');
    expect(red).toBeTruthy();
  });

  it('keeps tints when a global swatch changes', async () => {
    const { doc, add } = await setup();
    let g;
    doc.transact('t', () => (g = addSwatch(doc, { name: 'G', paint: solid('#ff0000'), global: true })));
    const n = add({ fill: solid(tinted('#ff0000', 0.5), { swatchId: g, tint: 0.5 }) });
    expect(doc.get(n).fill.color).toBe('#ff8080');
    doc.transact('edit', () => updateSwatch(doc, g, { paint: solid('#0000ff') }));
    expect(doc.get(n).fill.color).toBe('#8080ff');
    expect(doc.get(n).fill.tint).toBe(0.5);
  });

  it('marks spot swatches global', async () => {
    const { doc } = await setup();
    let id;
    doc.transact('t', () => (id = addSwatch(doc, { name: 'Spot', paint: solid('#ff00ff'), spot: true })));
    expect(findSwatch(doc, id)).toMatchObject({ spot: true, global: true });
    doc.transact('t', () => updateSwatch(doc, id, { spot: undefined, global: undefined }));
    expect(findSwatch(doc, id).spot).toBeUndefined();
    expect(findSwatch(doc, id).global).toBeUndefined();
  });
});

describe('Swatch library files', () => {
  it('round-trips text palettes and reads JSON libraries', () => {
    const text = paletteText('Mine', [{ name: 'Red', paint: solid('#ff0000') }, { name: 'G', paint: { type: 'linear', stops: [] } }]);
    const lib = parseSwatchLibrary(text, 'x.gpl');
    expect(lib).toEqual({ name: 'Mine', swatches: [{ name: 'Red', paint: solid('#ff0000') }] });
    const json = JSON.stringify({ format: 'vector-studio-swatches', name: 'J', swatches: [{ name: 'A', paint: solid('#010203'), global: true }, { bogus: 1 }] });
    expect(parseSwatchLibrary(json, 'j.json')).toEqual({ name: 'J', swatches: [{ name: 'A', paint: solid('#010203'), global: true }] });
    expect(parseSwatchLibrary('#abcdef\nzzz', 'hex.txt').swatches.map((s) => s.paint.color)).toEqual(['#abcdef']);
    expect(parseSwatchLibrary('nothing here', 'n.txt')).toBe(null);
  });
});

describe('Swatches panel menu', () => {
  it('lists the panel menu entries and switches views', async () => {
    const { panel, menuItem } = await setup();
    const p = panel('swatches');
    const labels = p.menu().filter((x) => typeof x === 'object').map((x) => x.label);
    for (const l of ['New Swatch...', 'New Color Group...', 'Duplicate Swatch', 'Merge Swatches', 'Delete Swatch', 'Ungroup Color Group', 'Select All Unused', 'Add Used Colors', 'Sort by Name', 'Sort by Kind', 'Show Find Field', 'Small Thumbnail View', 'Large List View', 'Swatch Options...', 'Open Swatch Library', 'Save Swatch Library...']) expect(labels).toContain(l);
    menuItem(p, 'Large Thumbnail View').run();
    expect(p.list.classList.contains('view-largeThumb')).toBe(true);
    expect(p.list.classList.contains('grid')).toBe(true);
    menuItem(p, 'Large List View').run();
    expect(p.list.classList.contains('list')).toBe(true);
    expect(p.list.querySelector('.sw-kind-label')).toBeTruthy();
    menuItem(p, 'Show Find Field').run();
    expect(p.search.hidden).toBe(true);
    expect(menuItem(p, 'Show Find Field').checked).toBe(false);
  });

  it('selects unused swatches, adds used colors and sorts from the menu', async () => {
    const { doc, add, panel, menuItem } = await setup();
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      addSwatch(doc, { name: 'b', paint: solid('#ff0000') });
      addSwatch(doc, { name: 'a', paint: solid('#00ff00') });
    });
    add({ fill: solid('#ff0000'), stroke: solid('#abcdef') });
    add({ fill: solid('#ff0000'), stroke: solid('#ff0000') });
    doc.transact('t', () => doc.nodes.forEach((n) => n.type === 'path' && n.stroke?.color === '#000000' && doc.update(n.id, { stroke: null })));
    const p = panel('swatches');
    menuItem(p, 'Select All Unused').run();
    expect([...p.selected].map((id) => findSwatch(doc, id).name)).toEqual(['a']);
    menuItem(p, 'Add Used Colors').run();
    expect(swatchesOf(doc).map((s) => s.paint.color)).toEqual(['#ff0000', '#00ff00', '#abcdef']);
    menuItem(p, 'Sort by Name').run();
    expect(swatchesOf(doc)[0].name).toBe('a');
    p.selected = new Set(swatchesOf(doc).slice(0, 2).map((s) => s.id));
    menuItem(p, 'Duplicate Swatch').run();
    expect(swatchesOf(doc).length).toBe(5);
    p.selected = new Set(swatchesOf(doc).slice(0, 2).map((s) => s.id));
    menuItem(p, 'Merge Swatches').run();
    expect(swatchesOf(doc).length).toBe(4);
  });

  it('saves a user library and opens it from Open Swatch Library > User Defined', async () => {
    const { app, doc, panel, menuItem } = await setup();
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      addSwatch(doc, { name: 'Mine', paint: solid('#334455') });
    });
    const p = panel('swatches');
    app.dialogs.form = async () => ({ name: 'Saved Set' });
    await menuItem(p, 'Save Swatch Library...').run();
    expect(userLibraries(app, 'swatches').map((l) => l.name)).toEqual(['Saved Set']);
    const open = menuItem(p, 'Open Swatch Library').submenu.find((x) => x.label === 'User Defined').submenu.find((x) => x.label === 'Saved Set');
    open.run();
    const pop = document.querySelector('.sw-lib');
    expect(pop?.textContent).toContain('Saved Set');
    expect(pop.querySelectorAll('.swatch-cell').length).toBe(1);
  });

  it('marks spot swatches in the list', async () => {
    const { doc, panel } = await setup();
    doc.transact('t', () => {
      doc.updateRoot({ swatches: [] });
      addSwatch(doc, { name: 'Ink', paint: solid('#ff00ff'), spot: true });
    });
    const p = panel('swatches');
    p.renderKey = null;
    p.update();
    const item = p.list.querySelector('[aria-label="Ink (Spot)"]');
    expect(item?.querySelector('.sw-spot')).toBeTruthy();
  });
});

describe('Recent colors', () => {
  it('records applied solid colors, newest first, one per drag', async () => {
    const { app, ed, add } = await setup();
    const id = add({ fill: solid('#ffffff') });
    ed.select([id]);
    applyStyle(ed, { fill: solid('#111111') });
    applyStyle(ed, { fill: solid('#222222') }, 'x', 'drag-1');
    applyStyle(ed, { fill: solid('#333333') }, 'x', 'drag-1');
    expect(recentColors(app).slice(0, 2)).toEqual(['#333333', '#111111']);
    for (let i = 0; i < 12; i++) applyStyle(ed, { stroke: solid(`#0000${(i + 16).toString(16)}`) });
    expect(recentColors(app).length).toBe(RECENT_MAX);
  });

  it('shows recent colors in the Color and Swatches panels and applies them', async () => {
    const { app, ed, add, panel } = await setup();
    const id = add({ fill: solid('#ffffff') });
    ed.select([id]);
    applyStyle(ed, { fill: solid('#abcdef') });
    applyStyle(ed, { fill: solid('#ffffff') });
    const cp = panel('color');
    cp.update();
    const cell = cp.el.querySelector('.rc-cell[aria-label="Recent color #ABCDEF"]');
    expect(cell).toBeTruthy();
    cell.click();
    expect(ed.doc.get(id).fill.color).toBe('#abcdef');
    const sp = panel('swatches');
    sp.renderKey = null;
    sp.update();
    expect(sp.el.querySelector('.rc-cell[aria-label="Recent color #ABCDEF"]')).toBeTruthy();
    expect(app.prefs.get('recentColors')[0]).toBe('#abcdef');
  });
});
