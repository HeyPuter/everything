import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { drawNode } from '../src/render/draw.js';
import { viewHooks } from '../src/render/canvas-view.js';
import { VDocument } from '../src/model/document.js';
import { proofFilterMarkup, PROOFS, printTiles, savedViews, restoreView, captureView, levelRotation, PrintTilingTool } from '../src/features/workspace/view.js';
import { slideFit, slideKey, startPresentation } from '../src/features/workspace/presentation.js';
import { WORKSPACES, BASIC_TOOLS, savedWorkspaces, shownTools, setToolShown, newWindow, openToolDrawer } from '../src/features/workspace/window.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(opts = {}) {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 200, height: 100, ...opts });
  ed.view.set({ width: 800, height: 600 });
  return { app, ed, doc: ed.doc };
}

async function submitForm(values) {
  await tick();
  const dialog = document.querySelector('dialog[open]');
  for (const [label, value] of Object.entries(values)) {
    const lab = [...dialog.querySelectorAll('label')].find((l) => l.textContent === label);
    document.getElementById(lab.htmlFor).value = value;
  }
  [...dialog.querySelectorAll('.btn')].find((b) => b.textContent === 'OK').click();
}

describe('view toggles', () => {
  it('registers every View menu toggle and flips its view option', async () => {
    const { app, ed } = await setup();
    const toggles = { 'view.trim': 'trim', 'view.overprint': 'overprint', 'view.printTiling': 'printTiling', 'view.template': 'template', 'view.globalRulers': 'globalRulers', 'view.videoRulers': 'videoRulers', 'view.gradientAnnotator': 'gradientAnnotator', 'view.cornerWidget': 'cornerWidget', 'view.slices': 'slices', 'view.lockSlices': 'lockSlices' };
    for (const [id, key] of Object.entries(toggles)) {
      expect(app.commands.get(id), id).toBeTruthy();
      const before = Boolean(ed.viewOptions[key]);
      await app.commands.run(id);
      expect(Boolean(ed.viewOptions[key]), id).toBe(!before);
    }
    expect(app.commands.label('view.template')).toBe('Show Template');
    expect(app.commands.label('view.gradientAnnotator')).toBe('Show Gradient Annotator');
    expect(app.commands.get('view.template').shortcut).toBe('Shift+Mod+W');
  });

  it('clips the artwork to the artboards in Trim View', async () => {
    const { ed } = await setup();
    const clip = () => viewHooks.clipArt.map((f) => f(ed)).find(Boolean);
    expect(clip()).toBeFalsy();
    ed.setViewOption('trim', true);
    expect(clip().ops).toEqual([['R', 0, 0, 200, 100]]);
  });

  it('hides template layers and flags overprint for the renderer', async () => {
    const { ed, doc } = await setup();
    doc.transact('t', () => doc.update(doc.layers()[0].id, { template: true }));
    const opts = () => viewHooks.artOptions.reduce((o, f) => f(ed, o) || o, {});
    expect(opts().layerFilter).toBeUndefined();
    ed.setViewOption('template', false);
    expect(opts().layerFilter(doc.layers()[0])).toBe(false);
    ed.setViewOption('overprint', true);
    expect(opts().overprint).toBe(true);
  });

  it('draws overprinting objects with multiply in Overprint Preview', () => {
    const doc = VDocument.create();
    const n = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#00ffff'), stroke: null, overprintFill: true });
    const ops = [];
    const ctx = document.createElement('canvas').getContext('2d');
    const spy = new Proxy(ctx, {
      set(t, k, v) {
        if (k === 'globalCompositeOperation') ops.push(v);
        t[k] = v;
        return true;
      },
      get: (t, k) => (typeof t[k] === 'function' ? t[k].bind(t) : t[k]),
    });
    drawNode(spy, doc, n, { overprint: false });
    expect(ops).toEqual([]);
    drawNode(spy, doc, n, { overprint: true });
    expect(ops).toEqual(['multiply']);
  });
});

describe('proofing', () => {
  it('builds color-matrix filters for each proof', () => {
    for (const k of Object.keys(PROOFS)) expect(proofFilterMarkup(`p-${k}`, k)).toContain(`id="p-${k}"`);
    expect(proofFilterMarkup('x', 'protanopia')).toContain('color-interpolation-filters="linearRGB"');
    expect(proofFilterMarkup('x', 'protanopia')).toContain('0.152286 1.052583 -0.204868 0 0');
    expect(proofFilterMarkup('x', 'grayscale')).toContain('saturate');
  });

  it('applies the proof to the canvas and paint previews', async () => {
    const { app, ed } = await setup();
    await app.commands.run('view.proof.deuteranopia');
    expect(ed.viewOptions).toMatchObject({ proof: 'deuteranopia', proofColors: true });
    expect(app.views.get(ed).art.style.filter).toContain('#vs-proof-deuteranopia');
    expect(app.root.classList.contains('proof-colors')).toBe(true);
    expect(document.getElementById('vs-proof-deuteranopia')).toBeTruthy();
    expect(app.commands.isChecked('view.proof.deuteranopia')).toBe(true);
    await app.commands.run('view.proofColors');
    expect(app.views.get(ed).art.style.filter).toBe('');
    expect(app.root.classList.contains('proof-colors')).toBe(false);
  });
});

describe('view rotation and saved views', () => {
  it('rotates the view to presets and levels the selection', async () => {
    const { app, ed, doc } = await setup();
    await app.commands.run('view.rotate.45');
    expect(ed.view.rotation).toBe(45);
    expect(app.commands.isChecked('view.rotate.45')).toBe(true);
    await app.commands.run('view.rotate.-90');
    expect(ed.view.rotation).toBe(270);
    expect(app.commands.isChecked('view.rotate.-90')).toBe(true);
    const r = createPath(rectangle(10, 10, 40, 20), true, { fill: solid('#000000'), frameAngle: 30 });
    doc.transact('a', () => doc.insert(r, doc.layers()[0].id));
    ed.select([r.id]);
    expect(levelRotation(ed)).toBe(330);
    await app.commands.run('view.rotateToSelection');
    expect(ed.view.rotation).toBe(330);
  });

  it('saves named views in the document and restores them', async () => {
    const { app, ed, doc } = await setup();
    ed.view.set({ zoom: 2 });
    ed.view.centerOn(50, 40);
    const run = app.commands.run('view.newView');
    await submitForm({ Name: 'Detail' });
    await run;
    expect(savedViews(doc)).toEqual([expect.objectContaining({ name: 'Detail', zoom: 2 })]);
    expect(doc.dirty).toBe(true);
    const items = app.menuSources.get('savedViews')(app);
    expect(items.map((i) => i.label)).toEqual(['Detail']);
    ed.view.set({ zoom: 0.5 });
    items[0].run();
    expect(ed.view.zoom).toBe(2);
    const c = ed.view.toDoc(400, 300);
    expect(c.x).toBeCloseTo(50);
    expect(c.y).toBeCloseTo(40);
    // Survives a save and reload.
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(savedViews(copy)[0].name).toBe('Detail');
    expect(captureView(ed, 'x').rotation).toBe(0);
    restoreView(ed, { ...savedViews(doc)[0], rotation: 90 });
    expect(ed.view.rotation).toBe(90);
  });

  it('renames and deletes views in Edit Views', async () => {
    const { app, ed, doc } = await setup();
    doc.transact('v', () => doc.updateRoot({ views: [captureView(ed, 'One'), captureView(ed, 'Two')] }));
    const run = app.commands.run('view.editViews');
    await tick();
    const dialog = document.querySelector('dialog[open]');
    const name = dialog.querySelector('#ev-name');
    name.value = 'First';
    name.dispatchEvent(new Event('input'));
    const items = dialog.querySelectorAll('.ev-item');
    items[1].click();
    [...dialog.querySelectorAll('.btn')].find((b) => b.textContent === 'Delete').click();
    [...dialog.querySelectorAll('.btn')].find((b) => b.textContent === 'OK').click();
    await run;
    expect(savedViews(doc).map((v) => v.name)).toEqual(['First']);
  });
});

describe('rulers, print tiling and presentation', () => {
  it('switches between artboard and global rulers', async () => {
    const { app, ed, doc } = await setup({ artboards: 2 });
    ed.setActiveArtboard(1);
    expect(app.rulerOrigin(ed)).toBeNull();
    await app.commands.run('view.globalRulers');
    expect(app.rulerOrigin(ed)).toEqual({ x: doc.artboards[0].x, y: doc.artboards[0].y });
    expect(app.commands.label('view.globalRulers')).toBe('Change to Artboard Rulers');
  });

  it('tiles the artboards with printed pages and moves the tiling with its tool', async () => {
    const doc = VDocument.create({ width: 1000, height: 700 });
    const tiles = printTiles(doc, { w: 612, h: 792, margin: 18 });
    expect(tiles.map((t) => [t.x, t.y, t.n])).toEqual([[0, 0, 1], [612, 0, 2]]);
    const { app, ed } = await setup();
    app.setTool('print-tiling');
    expect(ed.viewOptions.printTiling).toBe(true);
    const t = app.tool;
    expect(t).toBeInstanceOf(PrintTilingTool);
    t.onPointerDown({ x: 0, y: 0 });
    t.onPointerMove({ x: -50, y: -20 });
    t.onPointerUp({ x: -50, y: -20 });
    expect(ed.doc.root.printTiling).toEqual({ x: -50, y: -20 });
    t.onDoubleClick();
    expect(ed.doc.root.printTiling).toBeNull();
  });

  it('presents artboards as slides', async () => {
    expect(slideFit({ x: 0, y: 0, w: 200, h: 100 }, 1000, 1000)).toEqual({ s: 5, x: 0, y: 250, w: 1000, h: 500 });
    expect(slideKey('ArrowRight', 0, 3)).toBe(1);
    expect(slideKey('ArrowRight', 2, 3)).toBe(2);
    expect(slideKey('PageUp', 2, 3)).toBe(1);
    expect(slideKey('End', 0, 3)).toBe(2);
    expect(slideKey('x', 0, 3)).toBeNull();
    const { app, ed } = await setup({ artboards: 3 });
    const show = startPresentation(app, ed, 0);
    expect(document.querySelector('dialog.presentation')).toBeTruthy();
    show.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    show.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(show.index).toBe(2);
    expect(show.dialog.querySelector('.pres-counter').textContent).toBe('3 / 3');
    show.dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog.presentation')).toBeNull();
    expect(ed.activeArtboard).toBe(2);
  });
});

describe('workspaces and toolbars', () => {
  it('applies built-in workspaces to the panel layout and bars', async () => {
    const { app } = await setup();
    await app.commands.run('window.workspace.typography');
    const layout = app.dock.getLayout();
    expect(layout.dock).toEqual(['properties', 'character', 'paragraph'].filter((id) => app.dock.panels.has(id)));
    expect(layout.active).toBe('character');
    expect(app.prefs.get('controlBar')).toBe(true);
    expect(app.controlBar.el.hidden).toBe(false);
    expect(app.commands.isChecked('window.workspace.typography')).toBe(true);
    expect(app.commands.label('window.resetWorkspace')).toBe('Reset Typography');
    await app.commands.run('window.workspace.essentials');
    expect(app.dock.getLayout().dock).toEqual(['properties', 'layers']);
    expect(app.prefs.get('controlBar')).toBe(false);
    expect(app.controlBar.el.hidden).toBe(true);
    // Unknown panels in a workspace are skipped; tabs and strip buttons follow the layout.
    expect(app.dock.el.querySelectorAll('.dock-tab').length).toBe(2);
    expect(Object.keys(WORKSPACES).every((k) => app.commands.get(`window.workspace.${k}`))).toBe(true);
  });

  it('saves, lists, renames and deletes workspaces', async () => {
    const { app } = await setup();
    await app.commands.run('window.workspace.classic');
    await app.commands.run('window.toolbar.basic');
    const run = app.commands.run('window.workspace.new');
    await submitForm({ Name: 'Mine' });
    await run;
    expect(savedWorkspaces(app).map((w) => w.name)).toEqual(['Mine']);
    expect(savedWorkspaces(app)[0].toolbar).toBe('basic');
    await app.commands.run('window.workspace.essentials');
    const items = app.menuSources.get('workspaces')(app);
    expect(items.map((i) => i.label)).toEqual(['Mine']);
    items[0].run();
    expect(app.prefs.get('workspace')).toBe('saved:Mine');
    expect(app.prefs.get('toolbarSet')).toBe('basic');
    const manage = app.commands.run('window.workspace.manage');
    await tick();
    const dialog = document.querySelector('dialog[open]');
    const name = dialog.querySelector('#mw-name');
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input'));
    [...dialog.querySelectorAll('.btn')].find((b) => b.textContent === 'OK').click();
    await manage;
    expect(savedWorkspaces(app).map((w) => w.name)).toEqual(['Renamed']);
    expect(app.prefs.get('workspace')).toBe('saved:Renamed');
  });

  it('switches tool sets and edits the toolbar', async () => {
    const { app } = await setup();
    const tools = () => [...app.toolbar.el.querySelectorAll('.tool-btn')].flatMap((b) => b._ids || []);
    const all = tools().length;
    await app.commands.run('window.toolbar.basic');
    expect(tools().length).toBeLessThan(all);
    expect(tools()).not.toContain('knife');
    expect(tools().every((id) => BASIC_TOOLS.includes(id))).toBe(true);
    expect([...shownTools(app)]).toEqual(BASIC_TOOLS);
    await app.commands.run('window.toolbar.advanced');
    expect(tools().length).toBe(all);
    setToolShown(app, 'zoom', false);
    expect(app.prefs.get('toolbarSet')).toBe('custom');
    expect(shownTools(app).has('zoom')).toBe(false);
    expect(app.toolbar.el.querySelector('[aria-label="Zoom Tool"]')).toBeNull();
    const drawer = openToolDrawer(app, app.toolbar.el);
    const item = drawer.querySelector('[data-tool="zoom"]');
    expect(item.classList.contains('in-toolbar')).toBe(false);
    [...item.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
    expect(shownTools(app).has('zoom')).toBe(true);
    await app.commands.run('window.toolbar');
    expect(app.root.classList.contains('hide-toolbar')).toBe(true);
    await app.commands.run('window.toolbar');
    expect(app.root.classList.contains('hide-toolbar')).toBe(false);
  });

  it('shows the Control bar with selection controls', async () => {
    const { app, ed, doc } = await setup();
    await app.commands.run('window.controlBar');
    const bar = app.controlBar.el;
    expect(bar.hidden).toBe(false);
    expect(app.root.classList.contains('has-control-bar')).toBe(true);
    app.controlBar.refresh();
    expect(bar.querySelector('.cb-kind').textContent).toBe('No Selection');
    expect(bar.querySelector('.cb-doc').hidden).toBe(false);
    const g = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    doc.transact('a', () => doc.insert(g, doc.layers()[0].id));
    ed.select([g.id]);
    app.controlBar.refresh();
    expect(bar.querySelector('.cb-kind').textContent).toBe('Path');
    expect(bar.querySelector('.cb-doc').hidden).toBe(true);
    expect(bar.querySelector('.cb-transform').hidden).toBe(false);
    const weight = bar.querySelector('input[aria-label="Stroke weight"]');
    weight.value = '4';
    weight.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(doc.get(g.id).strokeWidth).toBe(4);
  });
});

describe('document windows', () => {
  it('opens a second window on the same document', async () => {
    const { app, ed, doc } = await setup();
    const ed2 = newWindow(app, ed);
    expect(ed2.doc).toBe(doc);
    expect(ed2.name).toBe(`${ed.name}:2`);
    expect(app.editor).toBe(ed2);
    const r = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    doc.transact('a', () => doc.insert(r, doc.layers()[0].id));
    ed2.select([r.id]);
    // Undo restores the selection in the window being worked in.
    doc.transact('b', () => doc.update(r.id, { opacity: 0.5 }));
    ed2.clearSelection();
    doc.undo();
    expect([...ed2.selection]).toEqual([r.id]);
    // Closing one window of a changed document does not ask to save.
    expect(doc.dirty).toBe(true);
    expect(await app.closeDocument(ed2)).toBe(true);
    expect(app.editors).toEqual([ed]);
  });

  it('tiles, stacks, floats and consolidates documents', async () => {
    const { app } = await setup();
    const ed2 = app.newDocument();
    const host = app.canvasHost;
    await app.commands.run('window.arrange.tile');
    expect(host.classList.contains('arrange-tile')).toBe(true);
    expect([...app.views.values()].every((v) => !v.host.hidden)).toBe(true);
    await app.commands.run('window.arrange.cascade');
    expect([...app.views.values()].every((v) => v.host.classList.contains('floating'))).toBe(true);
    await app.commands.run('window.arrange.tile');
    await app.commands.run('window.arrange.float');
    expect(app.views.get(ed2).host.classList.contains('floating')).toBe(true);
    expect(app.views.get(ed2).host.querySelector('.float-head')).toBeTruthy();
    await app.commands.run('window.arrange.consolidate');
    expect(host.classList.contains('arrange-tile') || host.classList.contains('arrange-stack')).toBe(false);
    expect(app.views.get(ed2).host.classList.contains('floating')).toBe(false);
    expect([...app.views.values()].filter((v) => !v.host.hidden).length).toBe(1);
  });

  it('cycles screen modes', async () => {
    const { app } = await setup();
    await app.commands.run('window.screenMode');
    expect(app.root.classList.contains('screen-menu')).toBe(true);
    await app.commands.run('window.screenMode');
    expect(app.root.classList.contains('screen-full')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(app.root.classList.contains('screen-full')).toBe(false);
    await app.commands.run('window.screenMode.full');
    expect(app.commands.isChecked('window.screenMode.full')).toBe(true);
    await app.commands.run('window.screenMode.normal');
    expect(app.screenMode).toBe('normal');
  });
});
