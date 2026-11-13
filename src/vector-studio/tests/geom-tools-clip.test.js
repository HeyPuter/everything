// Geometry tools and path commands on clipping groups: what the group shows takes part, and the
// clipping path keeps clipping (it is never cut into loose pieces or replaced by another object).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { flattenPath } from '../src/model/bezier.js';
import { subpathsOf } from '../src/features/geometry/nodes-io.js';
import { nodeBounds } from '../src/model/geometry.js';

const solid = (color) => ({ type: 'solid', color });

let app;
beforeAll(async () => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
  await loadGeom();
  app = await bootAppWithFeatures();
});

function areaOf(doc, n) {
  if (n.type === 'group') return n.children.reduce((s, c) => s + areaOf(doc, doc.get(c)), 0);
  let total = 0;
  for (const sp of subpathsOf(doc, n)) {
    const pts = flattenPath(sp.anchors, true, 0.005);
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
    total += s / 2;
  }
  return Math.abs(total);
}

/**
 * A new document with a clip group: a red 200 x 100 rectangle at (0,0) clipped by an unpainted
 * 100 x 100 square at (50,0); plus, when asked, a green square at (300,0) outside.
 */
function setup({ outside = false } = {}) {
  const ed = app.newDocument();
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = ed.doc;
  const layer = ed.targetLayer().id;
  const art = createPath(rectangle(0, 0, 200, 100), true, { fill: solid('#ff0000'), stroke: null });
  const mask = createPath(rectangle(50, 0, 100, 100), true, { fill: null, stroke: null });
  const g = createGroup([art.id, mask.id], { clip: true });
  const green = createPath(rectangle(300, 0, 100, 100), true, {
    fill: solid('#00ff00'),
    stroke: null,
  });
  doc.transact('setup', () => {
    doc.insert(g, layer, Infinity, [
      { ...art, parent: g.id },
      { ...mask, parent: g.id },
    ]);
    if (outside) doc.insert(green, layer);
  });
  app.notify = vi.fn();
  return { ed, doc, layer, g: g.id, art: art.id, mask: mask.id, green: green.id };
}

const ev = (x, y, extra = {}) => {
  const s = app.editor.view.toScreen(x, y);
  return {
    x,
    y,
    sx: s.x,
    sy: s.y,
    shift: false,
    alt: false,
    mod: false,
    button: 0,
    pointerType: 'mouse',
    pressure: 0.5,
    native: {},
    ...extra,
  };
};

async function stroke(tool, pts) {
  tool.onPointerDown(ev(...pts[0]));
  for (const p of pts.slice(1)) tool.onPointerMove(ev(...p));
  await tool.onPointerUp(ev(...pts[pts.length - 1]));
}

/** The clip group still clips with the original clipping path, unchanged. */
function expectMaskIntact(doc, g, mask) {
  const grp = doc.get(g);
  expect(grp.clip).toBe(true);
  expect(grp.children.at(-1)).toBe(mask);
  expect(doc.get(mask).anchors).toHaveLength(4);
}

describe('Shape Builder on a clipping group', () => {
  it('finds regions only where the group shows, and puts results outside it', async () => {
    const { ed, doc, layer, g, mask, art } = setup();
    ed.select([g]);
    app.setTool('shape-builder');
    const tool = app.tool;
    tool.facesKey = null;
    await tool.refreshFaces();
    expect(tool.faces).toHaveLength(1);
    // The hidden parts of the rectangle are not regions to click.
    expect(tool.faceAt(20, 50)).toBe(-1);
    const i = tool.faceAt(100, 50);
    expect(i).toBe(0);
    await tool.apply([i], i, false);
    expect(doc.has(g)).toBe(false);
    expect(doc.has(mask)).toBe(false);
    expect(doc.has(art)).toBe(false);
    const kids = doc.get(layer).children.map((id) => doc.get(id));
    expect(kids).toHaveLength(1);
    expect(kids[0].fill.color).toBe('#ff0000');
    expect(areaOf(doc, kids[0])).toBeCloseTo(100 * 100, 0);
    app.setTool('selection');
  });
});

describe('Knife and Eraser on a clipping group', () => {
  it('the Knife cuts the contents of a selected clipping group, not its clipping path', async () => {
    const { ed, doc, g, mask } = setup();
    ed.select([g]);
    app.setTool('knife');
    await stroke(app.tool, [
      [100, -10],
      [100, 110],
    ]);
    expectMaskIntact(doc, g, mask);
    expect(doc.get(g).children).toHaveLength(3);
    app.setTool('selection');
  });

  it('the Knife with nothing selected leaves clipping paths whole', async () => {
    const { ed, doc, g, mask } = setup();
    ed.select([]);
    app.setTool('knife');
    await stroke(app.tool, [
      [100, -10],
      [100, 110],
    ]);
    expectMaskIntact(doc, g, mask);
    expect(doc.get(g).children).toHaveLength(3);
    app.setTool('selection');
  });

  it('the Eraser erases the contents, not the clipping path', async () => {
    const { ed, doc, g, mask } = setup();
    ed.select([g]);
    app.setTool('eraser');
    app.tool.size = 10;
    await stroke(app.tool, [
      [100, -10],
      [100, 110],
    ]);
    expectMaskIntact(doc, g, mask);
    expect(doc.get(g).children).toHaveLength(3);
    ed.select([]);
    await stroke(app.tool, [
      [70, -10],
      [70, 110],
    ]);
    expectMaskIntact(doc, g, mask);
    app.setTool('selection');
  });

  it('a clipping path cut by itself (Direct Selection) still clips as one', async () => {
    const { ed, doc, g, art } = setup();
    ed.select([doc.get(g).children[1]]);
    app.setTool('knife');
    await stroke(app.tool, [
      [100, -10],
      [100, 110],
    ]);
    const grp = doc.get(g);
    expect(grp.clip).toBe(true);
    expect(grp.children).toHaveLength(2);
    expect(grp.children[0]).toBe(art);
    const m = doc.get(grp.children[1]);
    expect(m.type).toBe('group');
    expect(m.children).toHaveLength(2);
    app.setTool('selection');
  });
});

describe('Merge Brush and clipping groups', () => {
  it('does not merge a new blob into clipped artwork of the same color', async () => {
    const { ed, doc, layer, g, art } = setup();
    ed.select([]);
    ed.setStyle({ fill: solid('#ff0000'), stroke: null });
    app.setTool('blob-brush');
    const tool = app.tool;
    tool.size = 10;
    tool.pressureSize = false;
    await stroke(tool, [
      [100, 50],
      [250, 50],
    ]);
    // The blob stays its own object, fully visible, outside the clip group.
    expect(doc.get(art).anchors).toHaveLength(4);
    const kids = doc.get(layer).children;
    expect(kids).toHaveLength(2);
    expect(kids[0]).toBe(g);
    expect(nodeBounds(doc, doc.get(kids[1])).w).toBeGreaterThan(150);
    app.setTool('selection');
  });
});
