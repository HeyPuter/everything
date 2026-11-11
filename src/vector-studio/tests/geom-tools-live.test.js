// Geometry tools and path commands leave the inputs of live objects (blend keys, a Repeat's source) alone.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { makeBlend } from '../src/features/artboards/blend.js';
import { makeRepeat } from '../src/features/repeat/repeat-model.js';
import { offsetPathDialog, divideBelow } from '../src/features/geometry/path-ops.js';

const solid = (color) => ({ type: 'solid', color });

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

/** A new document with a blend of two squares at (0,0) and (100,0), and a plain square at (0,100). */
function setup() {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const a = createPath(rectangle(0, 0, 20, 20), true, { fill: solid('#ff0000'), stroke: null });
  const b = createPath(rectangle(100, 0, 20, 20), true, { fill: solid('#0000ff'), stroke: null });
  const plain = createPath(rectangle(0, 100, 20, 20), true, { fill: solid('#00ff00'), stroke: null });
  let g;
  doc.transact('setup', () => {
    for (const n of [a, b, plain]) doc.insert(n, layer);
    g = makeBlend(doc, [a.id, b.id]);
  });
  app.notify = vi.fn();
  return { ed, doc, g, a: a.id, b: b.id, plain: plain.id, layer };
}

const ev = (x, y, extra = {}) => {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
};

async function stroke(tool, pts) {
  tool.onPointerDown(ev(...pts[0]));
  for (const p of pts.slice(1)) tool.onPointerMove(ev(...p));
  await tool.onPointerUp(ev(...pts[pts.length - 1]));
}

describe('geometry tools on live objects', () => {
  it('Shape Builder leaves out the keys of a selected blend', async () => {
    const { ed, g, plain } = setup();
    ed.select([g]);
    app.setTool('shape-builder');
    const tool = app.tool;
    const hint = vi.spyOn(app, 'setStatusHint');
    tool.facesKey = null;
    await tool.refreshFaces();
    expect(tool.leaves).toEqual([]);
    expect(hint).toHaveBeenLastCalledWith('Shape Builder works on paths. Expand the blend first (Object > Expand).');
    hint.mockRestore();
    ed.select([g, plain]);
    await tool.refreshFaces();
    expect(tool.leaves.map((n) => n.id)).toEqual([plain]);
    app.setTool('selection');
  });

  it('Knife does not cut the keys of a blend, selected or not', async () => {
    const { ed, doc, g, a, b, plain } = setup();
    app.setTool('knife');
    const cut = [[10, -10], [10, 130]];
    ed.select([g]);
    await stroke(app.tool, cut);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(app.notify).toHaveBeenCalledWith('The Knife works on paths. Expand the blend first (Object > Expand).');
    // With nothing selected the Knife cuts everything under it but the blend.
    ed.select([]);
    await stroke(app.tool, cut);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(doc.has(plain)).toBe(false);
    app.setTool('selection');
  });

  it('Eraser does not erase the keys of a blend, selected or not', async () => {
    const { ed, doc, g, a, b, plain } = setup();
    app.setTool('eraser');
    const rub = [[10, -10], [10, 130]];
    ed.select([g]);
    await stroke(app.tool, rub);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(doc.get(a).anchors).toHaveLength(4);
    expect(app.notify).toHaveBeenCalledWith('The Eraser works on paths. Expand the blend first (Object > Expand).');
    ed.select([]);
    await stroke(app.tool, rub);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(doc.get(a).anchors).toHaveLength(4);
    expect(doc.has(plain)).toBe(false);
    app.setTool('selection');
  });

  it('Join does not join the open paths of a blend, selected or not', async () => {
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = ed.doc;
    const layer = ed.targetLayer().id;
    const l1 = createPath([anchor(0, 0), anchor(50, 0)], false, { fill: null, stroke: solid('#000000'), strokeWidth: 1 });
    const l2 = createPath([anchor(60, 0), anchor(110, 0)], false, { fill: null, stroke: solid('#000000'), strokeWidth: 1 });
    let g;
    doc.transact('setup', () => {
      for (const n of [l1, l2]) doc.insert(n, layer);
      g = makeBlend(doc, [l1.id, l2.id]);
    });
    app.setTool('join');
    for (const sel of [[g], []]) {
      ed.select(sel);
      await stroke(app.tool, [[55, -5], [55, 0], [55, 5]]);
      expect(doc.get(g).children).toEqual([l1.id, l2.id]);
      expect(doc.get(l1.id).anchors).toHaveLength(2);
    }
    app.setTool('selection');
  });
});

describe('path commands on live objects', () => {
  it('Offset Path does not add an offset copy inside a selected blend', async () => {
    const { ed, doc, g, a, b } = setup();
    app.dialogs.form = vi.fn(async () => ({ offset: 5, joins: 'miter', miter: 4, preview: false }));
    ed.select([g]);
    expect(await offsetPathDialog(app)).toBe(false);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(app.notify).toHaveBeenCalledWith('Offset Path works on paths. Expand the blend first (Object > Expand).');
  });

  it('Divide Objects Below does not cut blend keys or use a Repeat source as the cutter', async () => {
    const { ed, doc, g, a, b, layer } = setup();
    const cutter = createPath([anchor(10, -20), anchor(10, 40)], false, { fill: null, stroke: solid('#000000'), strokeWidth: 1 });
    doc.transact('cutter', () => doc.insert(cutter, layer));
    ed.select([cutter.id]);
    await divideBelow(app);
    expect(doc.get(g).children).toEqual([a, b]);
    expect(doc.get(a).anchors).toHaveLength(4);
    // A Repeat of one path: its source is not a cutter of its own.
    const src = createPath(rectangle(300, 0, 20, 20), true, { fill: solid('#ff0000'), stroke: null });
    let r;
    doc.transact('repeat', () => {
      doc.insert(src, layer);
      r = makeRepeat(doc, [src.id], 'grid');
    });
    ed.select([r]);
    expect(await divideBelow(app)).toBe(false);
    expect(doc.get(r).children).toEqual([src.id]);
    expect(app.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Divide Objects Below works on paths\. Expand the .*repeat first/));
  });
});
