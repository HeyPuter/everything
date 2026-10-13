import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { graphicStylesOf, linkedStyle, mergeStyles, unusedGraphicStyleIds, setGraphicStyles } from '../src/features/paint/graphic-styles.js';
import { graphicStyleLibraries } from '../src/features/paint/graphic-style-libraries.js';
import { createEffect } from '../src/features/paint/effects-model.js';
import { applyStyle } from '../src/ops/paint-ops.js';
import { userLibraries } from '../src/features/paint/user-libraries.js';
import { newPathStyle } from '../src/tools/pen.js';

const solid = (color) => ({ type: 'solid', color });

describe('Appearance panel menu', () => {
  it('lists its entries and runs them', async () => {
    const { app, ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: null, effects: [createEffect('dropShadow')] });
    ed.select([id]);
    const p = panel('appearance');
    const labels = p.menu().filter((x) => typeof x === 'object').map((x) => x.label);
    expect(labels).toEqual(['Add New Fill', 'Add New Stroke', 'Add New Effect', 'Duplicate Item', 'Remove Item', 'Clear Appearance', 'Reduce to Basic Appearance', 'New Art Has Basic Appearance', 'Show All Hidden Attributes', 'Hide Thumbnail', 'Redefine Graphic Style']);
    expect(menuItem(p, 'Add New Effect').submenu.length).toBeGreaterThan(3);
    menuItem(p, 'Add New Stroke').run();
    expect(ed.doc.get(id).stroke).toEqual(solid('#000000'));
    p.selectedRow = 0;
    menuItem(p, 'Duplicate Item').run();
    expect(ed.doc.get(id).effects.length).toBe(2);
    p.selectedRow = 1;
    menuItem(p, 'Remove Item').run();
    expect(ed.doc.get(id).effects.length).toBe(1);
    menuItem(p, 'Reduce to Basic Appearance').run();
    expect(ed.doc.get(id).effects).toEqual([]);
    menuItem(p, 'Clear Appearance').run();
    expect(ed.doc.get(id).fill).toBe(null);
    menuItem(p, 'Hide Thumbnail').run();
    expect(p.thumb.hidden).toBe(true);
    expect(app.prefs.get('appearanceThumb')).toBe(false);
  });

  it('keeps new art basic unless the option is off', async () => {
    const { app, ed, menuItem, panel } = await paintSetup();
    ed.setStyle({ effects: [createEffect('dropShadow')] });
    expect(ed.basicNewArt).toBe(true);
    expect(newPathStyle(ed).effects).toEqual([]);
    const p = panel('appearance');
    menuItem(p, 'New Art Has Basic Appearance').run();
    expect(app.prefs.get('newArtBasic')).toBe(false);
    expect(ed.basicNewArt).toBe(false);
    expect(newPathStyle(ed).effects.length).toBe(1);
  });
});

describe('Graphic style links', () => {
  it('links on apply, breaks on edit, and redefines linked objects', async () => {
    const { app, ed, add, panel, menuItem } = await paintSetup();
    const a = add({ fill: solid('#ffffff') });
    const b = add({ fill: solid('#ffffff') }, [20, 0, 10, 10]);
    const gp = panel('graphicStyles');
    const gs = graphicStylesOf(ed.doc).find((g) => g.id === 'gs-soft-shadow');
    ed.select([a, b]);
    gp.onClick(gs, {});
    expect(ed.doc.get(a).graphicStyle).toBe(gs.id);
    expect(linkedStyle(ed.doc, ed.doc.get(a))?.id).toBe(gs.id);
    const ap = panel('appearance');
    ed.select([a]);
    ap.update(true);
    expect(ap.styleName.textContent).toBe('Soft Shadow');
    // Editing the appearance breaks the link.
    applyStyle(ed, { fill: solid('#00ff00') });
    expect(linkedStyle(ed.doc, ed.doc.get(a))).toBe(null);
    // Redefine the style from the edited object: b, still linked, follows.
    gp.picked = new Set([gs.id]);
    menuItem(gp, 'Redefine Graphic Style').run();
    expect(graphicStylesOf(ed.doc).find((g) => g.id === gs.id).style.fill).toEqual(solid('#00ff00'));
    expect(ed.doc.get(b).fill).toEqual(solid('#00ff00'));
    expect(linkedStyle(ed.doc, ed.doc.get(a))?.id).toBe(gs.id);
    ed.select([a]);
    expect(menuItem(gp, 'Break Link to Graphic Style').enabled).toBe(true);
    menuItem(gp, 'Break Link to Graphic Style').run();
    expect(ed.doc.get(a).graphicStyle).toBeUndefined();
    expect(app.commands.isEnabled('select.same.graphicStyle')).toBe(true);
  });
});

describe('Graphic Styles panel menu', () => {
  it('duplicates, merges, sorts, deletes and selects unused styles', async () => {
    const { app, ed, add, panel, menuItem } = await paintSetup();
    const doc = ed.doc;
    const p = panel('graphicStyles');
    const n0 = graphicStylesOf(doc).length;
    p.picked = new Set(['gs-neon', 'gs-haze']);
    menuItem(p, 'Duplicate Graphic Style').run();
    expect(graphicStylesOf(doc).length).toBe(n0 + 2);
    expect(graphicStylesOf(doc).some((g) => g.name === 'Neon Glow copy')).toBe(true);
    app.dialogs.form = async () => ({ name: 'Merged' });
    p.picked = new Set(['gs-neon', 'gs-haze']);
    await menuItem(p, 'Merge Graphic Styles').run();
    const merged = graphicStylesOf(doc).find((g) => g.name === 'Merged');
    expect(merged.style.effects.map((e) => e.type)).toEqual(['outerGlow', 'blur']);
    expect(merged.style.blendMode).toBe('multiply');
    menuItem(p, 'Sort by Name').run();
    const names = graphicStylesOf(doc).map((g) => g.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })));
    const id = add({ fill: solid('#ffffff') });
    ed.select([id]);
    p.onClick(graphicStylesOf(doc).find((g) => g.id === 'gs-neon'), {});
    menuItem(p, 'Select All Unused').run();
    expect(p.picked.has('gs-neon')).toBe(false);
    expect(p.picked.size).toBe(unusedGraphicStyleIds(doc).length);
    app.dialogs.confirm = async () => true;
    const before = graphicStylesOf(doc).length;
    const del = p.ids().length;
    await menuItem(p, 'Delete Graphic Style').run();
    expect(graphicStylesOf(doc).length).toBe(before - del);
    expect(graphicStylesOf(doc).some((g) => g.id === 'gs-neon')).toBe(true);
  });

  it('switches views and opens libraries', async () => {
    const { app, ed, panel, menuItem } = await paintSetup();
    const p = panel('graphicStyles');
    menuItem(p, 'Large List View').run();
    expect(p.grid.classList.contains('view-largeList')).toBe(true);
    expect(p.grid.querySelector('.gst-name')).toBeTruthy();
    const libs = graphicStyleLibraries();
    expect(libs.length).toBeGreaterThan(2);
    for (const lib of libs) for (const s of lib.styles) expect(s.style.effects.every(Boolean)).toBe(true);
    menuItem(p, 'Open Graphic Style Library').submenu[0].run();
    const pop = document.querySelector('.gst-lib');
    expect(pop.textContent).toContain(libs[0].name);
    const n = graphicStylesOf(ed.doc).length;
    [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Add All to Graphic Styles').click();
    expect(graphicStylesOf(ed.doc).length).toBe(n + libs[0].styles.length);
    app.dialogs.form = async () => ({ name: 'Mine' });
    await menuItem(p, 'Save Graphic Style Library...').run();
    expect(userLibraries(app, 'graphicStyles')[0].items.length).toBe(graphicStylesOf(ed.doc).length);
    const user = menuItem(p, 'Open Graphic Style Library').submenu.find((x) => x.label === 'User Defined').submenu;
    expect(user[0].label).toBe('Mine');
  });

  it('merges styles: later fills win, effects stack, opacity multiplies', () => {
    const m = mergeStyles([
      { fill: solid('#111111'), stroke: null, opacity: 0.5, effects: [{ type: 'blur', radius: 1 }] },
      { fill: null, stroke: solid('#222222'), opacity: 0.5, effects: [{ type: 'feather', radius: 2 }] },
    ]);
    expect(m.fill).toEqual(solid('#111111'));
    expect(m.stroke).toEqual(solid('#222222'));
    expect(m.strokeWidth).toBe(1);
    expect(m.opacity).toBe(0.25);
    expect(m.effects.map((e) => e.type)).toEqual(['blur', 'feather']);
  });

  it('adds a style to the current appearance with Alt+click', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#123456'), stroke: null });
    ed.select([id]);
    const p = panel('graphicStyles');
    ed.doc.transact('t', () => setGraphicStyles(ed.doc, [{ id: 'fx-only', name: 'Blur', style: { effects: [createEffect('blur', { radius: 2 })] } }]));
    p.update();
    p.onClick(graphicStylesOf(ed.doc)[0], { altKey: true });
    expect(ed.doc.get(id).fill).toEqual(solid('#123456'));
    expect(ed.doc.get(id).effects.map((e) => e.type)).toEqual(['blur']);
  });
});
