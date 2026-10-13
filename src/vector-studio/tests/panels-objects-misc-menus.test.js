import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createImage, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { addVariable, bind, captureDataSet, toCSV, importCSV, variablesOf, cellsToText } from '../src/features/variables/model.js';
import { createGraph } from '../src/features/graphs/graph-ops.js';
import { magicWandSelect, wandOptions } from '../src/features/artboards/magic-wand.js';
import { assetsOf } from '../src/features/panels/asset-export.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const solid = (color) => ({ type: 'solid', color });
const item = (panel, label) => panel.menu().find((x) => x && x.label === label);
const panel = (id) => {
  const p = app.dock.panels.get(id);
  p.ensureBuilt();
  return p;
};

/** A PNG header with a size, enough for the image reader. */
function png(w, h) {
  const b = new Uint8Array(33);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return new Blob([b], { type: 'image/png' });
}

describe('Variables panel', () => {
  it('swaps linked files and graph data from data sets', async () => {
    const ed = app.newDocument({ name: 'Vars' });
    const doc = ed.doc;
    const layer = doc.layers()[0];
    doc.assets.set('a1', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const img = createImage('a1', 100, 100, [1, 0, 0, 1, 0, 0], { link: { source: 'url', url: 'https://example.com/a.png' } });
    let gid;
    doc.transact('Build', () => {
      doc.insert(img, layer.id);
      gid = createGraph(doc, layer.id, { x: 0, y: 200, w: 100, h: 100 }, 'column', { data: [['', 'A'], ['x', '1']] });
      const iv = addVariable(doc, 'image', 'Photo');
      bind(doc, img.id, 'image', iv.id);
      const gv = addVariable(doc, 'graph', 'Sales');
      bind(doc, gid, 'graph', gv.id);
      captureDataSet(doc, 'First');
    });
    const first = doc.root.dataSets[0];
    const [iv, gv] = variablesOf(doc);
    expect(first.values[iv.id]).toBe('https://example.com/a.png');
    expect(first.values[gv.id]).toBe('\tA\nx\t1');
    // A second data set pointing at another file and other numbers.
    doc.transact('DS', () => doc.updateRoot({ dataSets: [...doc.root.dataSets, { id: 'ds2', name: 'Second', values: { [iv.id]: 'https://example.com/b.png', [gv.id]: '\tA\nx\t5' } }] }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, blob: async () => png(50, 25) });
    const p = panel('variables');
    expect(await p.apply('ds2')).toBe(true);
    globalThis.fetch = realFetch;
    const n = doc.get(img.id);
    expect(n).toMatchObject({ width: 50, height: 25, link: { url: 'https://example.com/b.png' } });
    // Placement keeps the proportions inside the old 100 x 100 box.
    expect(n.transform[0]).toBeCloseTo(2);
    expect(cellsToText(doc.get(gid).live.data)).toBe('\tA\nx\t5');
    // One undo step for the whole data set.
    doc.undo();
    expect(doc.get(img.id).asset).toBe('a1');
    // CSV marks linked files with @ and graph data with %.
    expect(toCSV(doc).split('\r\n')[0]).toBe('@Photo,%Sales');
    const ed2 = app.newDocument({ name: 'Vars 2' });
    ed2.doc.transact('CSV', () => importCSV(ed2.doc, '@Pic,%Chart,#Show\r\na.png,"1\t2",true\r\n'));
    expect(variablesOf(ed2.doc).map((v) => v.type)).toEqual(['image', 'graph', 'visibility']);
  });

  it('has a menu that saves and loads variable libraries', async () => {
    const ed = app.newDocument({ name: 'Lib' });
    const doc = ed.doc;
    doc.transact('V', () => {
      addVariable(doc, 'text', 'Title');
      captureDataSet(doc, 'One');
    });
    const p = panel('variables');
    p.update();
    for (const l of ['New Variable...', 'Make Linked File Dynamic', 'Make Graph Data Dynamic', 'Save Variable Library...', 'Load Variable Library...', 'Select All Bound Objects']) expect(item(p, l), l).toBeTruthy();
    const data = { format: 'vector-studio-variables', version: 1, variables: [{ id: 'x1', name: 'Title', type: 'text' }, { id: 'x2', name: 'Price', type: 'text' }], dataSets: [{ name: 'Row', values: { x1: 'Hi', x2: '$5' } }] };
    const added = await p.loadLibrary({ text: async () => JSON.stringify(data) });
    expect(added).toBe(1);
    expect(variablesOf(doc).map((v) => v.name)).toEqual(['Title', 'Price']);
    expect(doc.root.dataSets).toHaveLength(1);
    expect(Object.values(doc.root.dataSets[0].values).sort()).toEqual(['$5', 'Hi']);
  });
});

describe('Magic Wand panel menu', () => {
  it('limits the wand to the clicked object’s layer without Use All Layers', () => {
    const ed = app.newDocument({ name: 'Wand' });
    const doc = ed.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    const b = createPath(rectangle(20, 0, 10, 10), true, { fill: solid('#ff0000') });
    doc.transact('B', () => {
      doc.insert(a, doc.layers()[0].id);
      const l2 = doc.addLayer('Two');
      doc.insert(b, l2.id);
    });
    const p = panel('magicWand');
    p.update();
    expect(magicWandSelect(doc, a, wandOptions(app))).toHaveLength(2);
    item(p, 'Use All Layers').run();
    expect(magicWandSelect(doc, a, wandOptions(app))).toEqual([a.id]);
    item(p, 'Use All Layers').run();
    item(p, 'Hide Stroke Options').run();
    expect(p.strokeGroup.hidden).toBe(true);
    item(p, 'Show Stroke Options').run();
    expect(p.strokeGroup.hidden).toBe(false);
    item(p, 'Hide Transparency Options').run();
    expect(p.transparencyGroup.hidden).toBe(true);
    item(p, 'Show Transparency Options').run();
  });
});

describe('SVG Interactivity panel menu', () => {
  it('clears events on an object and in the document', () => {
    const ed = app.newDocument({ name: 'SVG' });
    const doc = ed.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true, { svgEvents: { onclick: 'go()' } });
    const b = createPath(rectangle(0, 0, 10, 10), true, { svgEvents: { onmouseover: 'x()' } });
    doc.transact('B', () => [a, b].forEach((n) => doc.insert(n, doc.layers()[0].id)));
    doc.transact('S', () => doc.updateRoot({ svgScript: 'var x;' }));
    const p = panel('svgInteractivity');
    ed.select([a.id]);
    p.update();
    item(p, 'Clear Events').run();
    expect(doc.get(a.id).svgEvents).toBeUndefined();
    item(p, 'Select Objects with Events').run();
    expect(ed.topSelection()).toEqual([b.id]);
    item(p, 'Clear All Events in Document').run();
    expect(doc.get(b.id).svgEvents).toBeUndefined();
    item(p, 'Remove All Scripts').run();
    expect(doc.root.svgScript).toBeUndefined();
  });
});

describe('Asset Export panel menu', () => {
  it('selects, sorts and removes assets', async () => {
    const ed = app.newDocument({ name: 'Assets' });
    const doc = ed.doc;
    const a = createPath(rectangle(0, 0, 10, 10), true, { name: 'zeta' });
    const b = createPath(rectangle(20, 0, 10, 10), true, { name: 'alpha' });
    doc.transact('B', () => [a, b].forEach((n) => doc.insert(n, doc.layers()[0].id)));
    ed.select([a.id, b.id]);
    await app.commands.run('assetExport.multiple');
    const p = panel('assetExport');
    p.update();
    item(p, 'Sort by Name').run();
    expect(assetsOf(doc).map((x) => x.name)).toEqual(['alpha', 'zeta']);
    item(p, 'Select All').run();
    expect(p.selected.size).toBe(2);
    item(p, 'Deselect All').run();
    expect(p.selected.size).toBe(0);
    doc.transact('Del', () => doc.remove(a.id));
    item(p, 'Remove Assets with Deleted Artwork').run();
    expect(assetsOf(doc).map((x) => x.name)).toEqual(['alpha']);
    item(p, 'Export Settings').submenu.find((x) => x.label === 'iOS Scales').run();
    expect(doc.root.assetExportSettings).toHaveLength(3);
  });
});

describe('3D and Materials panel menu', () => {
  it('copies, pastes and resets 3D settings', async () => {
    const ed = app.newDocument({ name: '3D' });
    const doc = ed.doc;
    const a = createPath(rectangle(0, 0, 50, 50), true, { fill: solid('#3366ff') });
    const b = createPath(rectangle(100, 0, 50, 50), true, { fill: solid('#ff6633') });
    doc.transact('B', () => [a, b].forEach((n) => doc.insert(n, doc.layers()[0].id)));
    ed.select([a.id]);
    await app.commands.run('effect.3d.extrude');
    const p = panel('3d');
    p.apply({ depth: 120 });
    item(p, 'Copy 3D Settings').run();
    ed.select([b.id]);
    item(p, 'Paste 3D Settings').run();
    const fx = doc.get(b.id).effects.find((e) => e.type === 'threeD');
    expect(fx).toMatchObject({ kind: 'extrude', depth: 120 });
    item(p, 'Reset to Defaults').run();
    expect(doc.get(b.id).effects.find((e) => e.type === 'threeD').depth).toBe(50);
    item(p, 'Mesh Quality').submenu.find((x) => x.label === 'High').run();
    expect(doc.get(b.id).effects.find((e) => e.type === 'threeD').detail).toBe('high');
    item(p, 'Remove 3D').run();
    expect(doc.get(b.id).effects.some((e) => e.type === 'threeD')).toBe(false);
  });
});

describe('Trace Image panel menu', () => {
  it('renames, exports and imports presets', async () => {
    app.newDocument({ name: 'Trace' });
    const p = panel('traceImage');
    p.update();
    app.dialogs.form = async () => ({ name: 'Mine' });
    await item(p, 'Save as New Preset...').run();
    const saved = app.prefs.get('tracePresets');
    expect(saved.map((x) => x.label)).toContain('Mine');
    app.dialogs.form = async () => ({ name: 'Renamed' });
    await p.menu().find((x) => x.label?.startsWith('Rename')).run();
    expect(app.prefs.get('tracePresets').map((x) => x.label)).toContain('Renamed');
    const file = { text: async () => JSON.stringify({ format: 'vector-studio-trace-presets', version: 1, presets: [{ label: 'From File', options: {} }] }) };
    expect(await p.importPresets(file)).toBe(1);
    expect(app.prefs.get('tracePresets').map((x) => x.label)).toContain('From File');
    expect(p.menu()).toContain('trace.make');
    app.prefs.set('tracePresets', []);
  });
});

describe('Libraries panel menu', () => {
  it('switches views and lists the add choices', () => {
    const p = panel('libraries');
    const menu = p.menu();
    expect(menu.find((x) => x.label === 'Add from Selection').submenu.filter((x) => x !== '-').map((x) => x.label)).toContain('Graphic');
    item(p, 'View as List').run();
    expect(p.view).toBe('list');
    item(p, 'View as Grid').run();
    expect(p.view).toBe('grid');
    expect(createGroup).toBeTypeOf('function');
  });
});
