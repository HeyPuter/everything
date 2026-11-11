import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, defaultLabel } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { liveArtwork, isLive } from '../src/model/live.js';
import { applyStyle } from '../src/ops/paint-ops.js';
import { createGraph, updateGraph, addDesign, setSeriesOption, selectedSeries } from '../src/features/graphs/graph-ops.js';
import { isGraph } from '../src/features/graphs/graph-live.js';
import { VDocument } from '../src/model/document.js';
import { createFlare } from '../src/features/flare/flare-model.js';
import { convertToMesh } from '../src/features/mesh/mesh-ops.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeGraph(app, type = 'column', data = null) {
  const doc = app.editor.doc;
  let id;
  doc.transact('Graph', () => {
    id = createGraph(doc, app.editor.targetLayer().id, { x: 100, y: 100, w: 200, h: 100 }, type, data ? { data } : {});
  });
  return doc.get(id);
}

describe('graphs in the document', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  it('creates a live graph with one key per series', () => {
    const g = makeGraph(app);
    const doc = app.editor.doc;
    expect(isLive(g)).toBe(true);
    expect(defaultLabel(g)).toBe('<Graph>');
    expect(g.children).toHaveLength(2);
    expect(g.children.map((id) => doc.get(id).name)).toEqual(['Series 1', 'Series 2']);
    const { items } = liveArtwork(doc, g);
    const marks = items.filter((n) => n.source === g.children[0]);
    // Four columns plus the legend swatch.
    expect(marks).toHaveLength(5);
    expect(items.some((n) => n.type === 'text' && n.text === 'Q1')).toBe(true);
    const b = nodeBounds(doc, g);
    expect(b.x).toBeLessThan(100);
    expect(b.x + b.w).toBeGreaterThan(300);
    expect(b.y + b.h).toBeGreaterThan(200);
  });

  it('recolors a series through its key and keeps the color across data edits', () => {
    const g = makeGraph(app);
    const doc = app.editor.doc;
    const key = g.children[1];
    // Group Selection on a column of the second series picks its key.
    app.setTool('group-selection');
    const col = liveArtwork(doc, g).items.find((n) => n.source === key && n.type === 'path');
    const a = col.anchors;
    const cx = (a[0].x + a[2].x) / 2;
    const cy = (a[0].y + a[2].y) / 2;
    app.tool.onPointerDown(ev(app, cx, cy));
    app.tool.onPointerUp(ev(app, cx, cy));
    expect([...app.editor.selection]).toEqual([key]);
    expect(selectedSeries(app.editor)).toEqual([{ graph: doc.get(g.id), index: 1 }]);
    applyStyle(app.editor, { fill: { type: 'solid', color: '#123456' } });
    let items = liveArtwork(doc, doc.get(g.id)).items;
    expect(items.filter((n) => n.source === key).every((n) => n.fill.color === '#123456')).toBe(true);
    doc.transact('Data', () => updateGraph(doc, g.id, { data: [['', 'Series 1', 'Series 2', 'Third'], ['A', '1', '2', '3']] }));
    const g2 = doc.get(g.id);
    expect(g2.children).toHaveLength(3);
    expect(doc.get(g2.children[1]).fill.color).toBe('#123456');
    expect(doc.get(g2.children[2]).name).toBe('Third');
    items = liveArtwork(doc, g2).items;
    expect(items.filter((n) => n.source === key && n.type === 'path')).toHaveLength(2);
    doc.undo();
    expect(doc.get(g.id).children).toHaveLength(2);
  });

  it('Selection tool picks the whole graph, which moves and scales live', () => {
    const g = makeGraph(app);
    const doc = app.editor.doc;
    const hit = hitTest(doc, 130, 190, 1);
    expect(app.editor.selectionTarget(hit.id).id).toBe(g.id);
    doc.transact('Move', () => transformNodes(doc, [g.id], [1, 0, 0, 1, 50, 10]));
    const moved = doc.get(g.id);
    expect(moved.live.matrix).toEqual([1, 0, 0, 1, 150, 110]);
    const key = doc.get(moved.children[0]);
    expect(key.anchors[0].x).toBeGreaterThan(350);
    const text = liveArtwork(doc, moved).items.find((n) => n.type === 'text' && n.text === 'Q1');
    expect(text.transform).toEqual([1, 0, 0, 1, 150, 110]);
  });

  it('expands and ungroups into ordinary artwork', async () => {
    const g = makeGraph(app, 'pie');
    const doc = app.editor.doc;
    app.editor.select([g.id]);
    await app.commands.run('object.ungroup');
    expect(doc.get(g.id)).toBeUndefined();
    const leaves = doc.leaves();
    expect(leaves.some((n) => n.type === 'text' && n.text === 'North')).toBe(true);
    expect(leaves.filter((n) => n.type === 'path').length).toBeGreaterThanOrEqual(8);
    expect(leaves.every((n) => !isLive(n) && !n.source)).toBe(true);
    doc.undo();
    expect(isGraph(doc.get(g.id))).toBe(true);
    app.editor.select([g.id]);
    await app.commands.run('object.expand');
    const grp = doc.get([...app.editor.selection][0]);
    expect(grp.type).toBe('group');
    expect(isLive(grp)).toBe(false);
  });

  it('draws column designs and marker designs', () => {
    const doc = app.editor.doc;
    const star = createPath(rectangle(0, 0, 10, 20), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Art', () => doc.insert(star, app.editor.targetLayer().id));
    let design;
    doc.transact('Design', () => (design = addDesign(doc, [star.id], 'Bar')));
    expect(doc.root.graphDesigns).toHaveLength(1);
    const g = makeGraph(app);
    for (const mode of ['vertical', 'uniform', 'repeat', 'sliding']) {
      doc.transact('Column', () => setSeriesOption(doc, [{ graph: doc.get(g.id), index: 0 }], 'column', { design: design.id, mode, unit: 1, fraction: 'chop' }));
      const items = liveArtwork(doc, doc.get(g.id)).items;
      const designed = items.filter((n) => n.type === 'group' && n.source === g.children[0]);
      expect(designed.length).toBeGreaterThan(0);
    }
    // Repeating with unit 1: value 3 makes three copies.
    doc.transact('Column', () => setSeriesOption(doc, [{ graph: doc.get(g.id), index: 0 }], 'column', { design: design.id, mode: 'repeat', unit: 1, fraction: 'scale' }));
    const vals = [3, 5, 4, 6];
    const items = liveArtwork(doc, doc.get(g.id)).items.filter((n) => n.type === 'group' && n.source === g.children[0]);
    expect(items.length).toBe(vals.reduce((a, b) => a + b, 0) + 1);
    doc.transact('Type', () => updateGraph(doc, g.id, { type: 'line' }));
    doc.transact('Marker', () => setSeriesOption(doc, [{ graph: doc.get(g.id), index: 0 }], 'marker', { design: design.id }));
    const li = liveArtwork(doc, doc.get(g.id)).items;
    expect(li.filter((n) => n.type === 'group' && n.source === g.children[0]).length).toBe(4 + 1);
  });

  it('a graph pasted into another document brings its column design along', async () => {
    const doc = app.editor.doc;
    const art = createPath(rectangle(0, 0, 10, 20), true, { fill: { type: 'solid', color: '#ff0000' } });
    doc.transact('Art', () => doc.insert(art, app.editor.targetLayer().id));
    let design;
    doc.transact('Design', () => (design = addDesign(doc, [art.id], 'Bar')));
    const g = makeGraph(app);
    doc.transact('Column', () => setSeriesOption(doc, [{ graph: doc.get(g.id), index: 0 }], 'column', { design: design.id, mode: 'repeat', unit: 1, fraction: 'scale' }));
    const designed = (d, n) => liveArtwork(d, n).items.filter((v) => v.type === 'group' && v.source === n.children[0]).length;
    const before = designed(doc, doc.get(g.id));
    app.editor.select([g.id]);
    app.commands.run('edit.copy');
    app.newDocument();
    // The other document has its own design named Bar: the pasted one is renamed, not merged.
    const d2 = app.editor.doc;
    const own = createPath(rectangle(0, 0, 5, 5), true, { fill: { type: 'solid', color: '#0000ff' } });
    d2.transact('Art', () => d2.insert(own, app.editor.targetLayer().id));
    d2.transact('Design', () => addDesign(d2, [own.id], 'Bar'));
    await app.commands.run('edit.paste');
    const pasted = d2.get(app.editor.topSelection()[0]);
    expect(designed(d2, pasted)).toBe(before);
    expect(d2.root.graphDesigns.map((x) => x.name)).toEqual(['Bar', 'Bar 2']);
    // Pasting again reuses the design; undo takes the design back with the graph.
    await app.commands.run('edit.paste');
    expect(d2.root.graphDesigns).toHaveLength(2);
    d2.undo();
    d2.undo();
    expect(d2.root.graphDesigns).toHaveLength(1);
  });

  it('graph tool drag creates a graph and opens the data window', async () => {
    app.setTool('graph-column');
    const t = app.tool;
    t.onPointerDown(ev(app, 100, 100));
    t.onPointerMove(ev(app, 200, 150));
    t.onPointerMove(ev(app, 300, 200));
    await t.onPointerUp(ev(app, 300, 200));
    const g = app.editor.doc.get([...app.editor.selection][0]);
    expect(isGraph(g)).toBe(true);
    expect(g.live.frame).toEqual({ w: 200, h: 100 });
    expect(g.live.type).toBe('column');
    const win = document.querySelector('.graph-data');
    expect(win).toBeTruthy();
    expect(win.getAttribute('role')).toBe('dialog');
    const cell = win.querySelector('input[data-r="1"][data-c="1"]');
    expect(cell.value).toBe('3');
    cell.value = '9';
    cell.dispatchEvent(new Event('input'));
    app.graphData.pasteAt('Q5\t7\t8', 5, 0);
    win.querySelector('.gd-apply').click();
    const g2 = app.editor.doc.get(g.id);
    expect(g2.live.data[1][1]).toBe('9');
    expect(g2.live.data[5]).toEqual(['Q5', '7', '8']);
    expect(app.editor.doc.undoLabel).toBe('Graph Data');
    app.graphData.importText('Year,Sales\n"2024",5\n"2025",8', 'sales.csv');
    win.querySelector('[aria-label="Transpose Row/Column"]').click();
    expect(app.graphData.data[0]).toEqual(['Year', '"2024"', '"2025"']);
    win.querySelector('[aria-label="Revert"]').click();
    expect(app.graphData.data[5]).toEqual(['Q5', '7', '8']);
    win.querySelector('.gd-close').click();
    await tick();
    expect(document.querySelector('.graph-data')).toBeNull();
  });

  it('closing the Graph Data window with Escape puts focus back on the canvas', async () => {
    const g = makeGraph(app);
    app.canvasHost.focus();
    app.graphData.show(g.id);
    const win = document.querySelector('.graph-data');
    expect(win.contains(document.activeElement)).toBe(true);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(document.querySelector('.graph-data')).toBeNull();
    expect(document.activeElement).toBe(app.canvasHost);
  });

  it('the Graph Data window follows undo, and edits stay with their own document', async () => {
    const g = makeGraph(app);
    const doc = app.editor.doc;
    app.graphData.show(g.id);
    const win = document.querySelector('.graph-data');
    const cell = (r, c) => win.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    cell(1, 1).value = '9';
    cell(1, 1).dispatchEvent(new Event('input'));
    app.graphData.apply();
    expect(doc.get(g.id).live.data[1][1]).toBe('9');
    expect(win.querySelector('.gd-status').textContent).toBe('Applied.');
    // Undo takes the graph back to 3: the window shows that, so a later Apply does not redo it.
    doc.undo();
    expect(cell(1, 1).value).toBe('3');
    cell(2, 1).value = '7';
    cell(2, 1).dispatchEvent(new Event('input'));
    cell(2, 2).value = 'n/a';
    cell(2, 2).dispatchEvent(new Event('input'));
    app.graphData.apply();
    expect(doc.get(g.id).live.data[1][1]).toBe('3');
    expect(doc.get(g.id).live.data[2][1]).toBe('7');
    // A cell the graph cannot use is reported, not dropped silently.
    expect(win.querySelector('.gd-status').textContent).toBe('Applied. Left out: 1 cell is not a number.');
    // Unapplied edits are kept through other changes to the document.
    cell(3, 1).value = '1';
    cell(3, 1).dispatchEvent(new Event('input'));
    doc.transact('Rect', () => doc.insert(createPath(rectangle(0, 0, 5, 5), true), app.editor.targetLayer().id));
    expect(cell(3, 1).value).toBe('1');
    // Switching to another document applies to the graph the window was editing.
    const first = app.editor;
    app.newDocument();
    expect(app.editor).not.toBe(first);
    app.graphData.apply();
    expect(doc.get(g.id).live.data[3][1]).toBe('1');
    expect(doc.undoLabel).toBe('Graph Data');
    // Deleting the graph closes a window without edits.
    first.doc.transact('Delete', () => first.doc.remove(g.id));
    expect(document.querySelector('.graph-data')).toBeNull();
    // Without edits, switching to a document with no graph selected closes the window.
    first.doc.undo();
    app.activate(first);
    app.graphData.show(g.id);
    app.newDocument();
    expect(document.querySelector('.graph-data')).toBeNull();
  });

  it('Graph Type changes the type and options with a preview', async () => {
    const g = makeGraph(app);
    app.editor.select([g.id]);
    const run = app.commands.run('graph.type');
    await tick();
    const dlg = document.querySelector('dialog');
    dlg.querySelector('[aria-label="Line"]').click();
    expect(app.editor.doc.get(g.id).live.type).toBe('line');
    const edge = [...dlg.querySelectorAll('label')].find((l) => l.textContent === 'Edge-to-edge lines');
    document.getElementById(edge.htmlFor).click();
    [...dlg.querySelectorAll('.gt-tab')][1].click();
    const len = [...dlg.querySelectorAll('label')].find((l) => l.textContent === 'Length');
    const sel = document.getElementById(len.htmlFor);
    sel.value = 'full';
    sel.dispatchEvent(new Event('change'));
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await run;
    const live = app.editor.doc.get(g.id).live;
    expect(live.type).toBe('line');
    expect(live.options.edgeToEdge).toBe(true);
    expect(live.options.value.tickLength).toBe('full');
    expect(app.editor.doc.undoLabel).toBe('Graph Type');
  });

  it('graphs, meshes and flares survive saving and loading', () => {
    const g = makeGraph(app, 'line');
    const doc = app.editor.doc;
    const r = createPath(rectangle(10, 10, 50, 50), true, { fill: { type: 'solid', color: '#00ff00' } });
    const f = createFlare(400, 400);
    doc.transact('More', () => {
      doc.insert(r, app.editor.targetLayer().id);
      convertToMesh(doc, r.id, { rows: 2, cols: 2 });
      doc.insert(f, app.editor.targetLayer().id);
    });
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    const g2 = copy.get(g.id);
    expect(isGraph(g2)).toBe(true);
    expect(liveArtwork(copy, g2).items.length).toBe(liveArtwork(doc, doc.get(g.id)).items.length);
    const mesh = copy.leaves().find((n) => n.type === 'mesh');
    expect(mesh?.points).toHaveLength(9);
    expect(nodeBounds(copy, copy.get(f.id))).toEqual(nodeBounds(doc, doc.get(f.id)));
  });

  it('exports graphs to SVG as plain artwork', async () => {
    makeGraph(app, 'bar');
    const { exportSVG } = await import('../src/features/io/svg-export.js');
    const svg = exportSVG(app.editor.doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(svg).toContain('>Q1<');
    expect((svg.match(/<rect|<path/g) || []).length).toBeGreaterThan(8);
  });
});
