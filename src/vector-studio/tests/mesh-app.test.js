import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, defaultLabel } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds, visualBounds, transformNodes, transformFromOriginals, collectOriginals } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { isLive, expandLive } from '../src/model/live.js';
import { applyStyle, commonStyle } from '../src/ops/paint-ops.js';
import { convertToMesh } from '../src/features/mesh/mesh-ops.js';
import { selectMeshPoints, meshPointSelection } from '../src/features/mesh/mesh-edit.js';
import { coonsPatchData } from '../src/features/mesh/mesh-export.js';
import { idx } from '../src/features/mesh/mesh-model.js';
import { drawNode } from '../src/render/draw.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
function click(app, tool, x, y, mods = {}) {
  tool.onPointerDown(ev(app, x, y, mods));
  tool.onPointerUp(ev(app, x, y, mods));
}
function drag(app, tool, from, to, mods = {}) {
  tool.onPointerDown(ev(app, from[0], from[1], mods));
  tool.onPointerMove(ev(app, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, mods));
  tool.onPointerMove(ev(app, to[0], to[1], mods));
  tool.onPointerUp(ev(app, to[0], to[1], mods));
}
function addRect(app, x, y, w, h, color = '#3366cc') {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color }, stroke: null });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return doc.get(n.id);
}
function makeMesh(app, opts = { rows: 2, cols: 2 }) {
  const r = addRect(app, 100, 100, 200, 100);
  const doc = app.editor.doc;
  let m;
  doc.transact('Mesh', () => {
    m = convertToMesh(doc, r.id, opts);
  });
  return doc.get(m.id);
}

describe('gradient mesh objects', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  it('converts a path into a live mesh node with bounds, label and hit testing', () => {
    const m = makeMesh(app);
    expect(m.type).toBe('mesh');
    expect(isLive(m)).toBe(true);
    expect(defaultLabel(m)).toBe('<Mesh>');
    expect(m.points.every((p) => p.c === '#3366cc')).toBe(true);
    const b = nodeBounds(app.editor.doc, m);
    expect(b).toMatchObject({ x: 100, y: 100, w: 200, h: 100 });
    expect(visualBounds(app.editor.doc, m).w).toBeCloseTo(200);
    expect(hitTest(app.editor.doc, 150, 150, 1)?.id).toBe(m.id);
    expect(hitTest(app.editor.doc, 350, 150, 1)).toBeNull();
  });

  it('Create Gradient Mesh converts the selection in one undo step', async () => {
    const r = addRect(app, 0, 0, 100, 100);
    app.editor.select([r.id]);
    expect(app.commands.isEnabled('mesh.create')).toBe(true);
    const run = app.commands.run('mesh.create');
    await new Promise((res) => setTimeout(res, 0));
    const dlg = document.querySelector('dialog');
    expect(dlg.querySelector('h2').textContent).toBe('Create Gradient Mesh');
    // The preview shows the mesh while the dialog is open.
    expect(app.editor.doc.leaves().some((n) => n.type === 'mesh')).toBe(true);
    const inputs = dlg.querySelectorAll('input[type=text]');
    inputs[0].value = '3';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await run;
    const mesh = app.editor.doc.leaves().find((n) => n.type === 'mesh');
    expect(mesh.rows).toBe(3);
    expect(mesh.cols).toBe(4);
    expect([...app.editor.selection]).toEqual([mesh.id]);
    app.editor.doc.undo();
    expect(app.editor.doc.get(r.id)).toBeTruthy();
    expect(app.editor.doc.leaves().some((n) => n.type === 'mesh')).toBe(false);
  });

  it('cancelling the dialog leaves the path alone', async () => {
    const r = addRect(app, 0, 0, 100, 100);
    app.editor.select([r.id]);
    const run = app.commands.run('mesh.create');
    await new Promise((res) => setTimeout(res, 0));
    [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Cancel').click();
    await run;
    expect(app.editor.doc.get(r.id)).toBeTruthy();
    expect(app.editor.doc.undoStack.at(-1).label).toBe('Rect');
  });

  it('moves, scales and rotates with its points', () => {
    const m = makeMesh(app);
    const doc = app.editor.doc;
    doc.transact('Move', () => transformNodes(doc, [m.id], [2, 0, 0, 1, 10, 20]));
    const moved = doc.get(m.id);
    expect(moved.points[0]).toMatchObject({ x: 210, y: 120 });
    expect(nodeBounds(doc, moved)).toMatchObject({ x: 210, y: 120, w: 400, h: 100 });
    const orig = collectOriginals(doc, [m.id]);
    doc.transact('Drag', () => transformFromOriginals(doc, orig, [1, 0, 0, 1, 5, 0]));
    expect(doc.get(m.id).points[0].x).toBe(215);
    doc.undo();
    doc.undo();
    expect(doc.get(m.id).points[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('draws through its own renderer', () => {
    const m = makeMesh(app);
    const calls = [];
    const ctx = new Proxy(
      { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), canvas: { width: 800, height: 600 } },
      { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) },
    );
    drawNode(ctx, app.editor.doc, m, { hairline: 1, scale: 1 });
    expect(calls.some(([k]) => k === 'clip')).toBe(true);
    // Interaction slices skip it as one leaf.
    calls.length = 0;
    drawNode(ctx, app.editor.doc, m, { hairline: 1, scale: 1, leafFilter: (id) => id !== m.id });
    expect(calls.some(([k]) => k === 'clip')).toBe(false);
  });

  it('expands into a clipped group of filled cells', () => {
    const m = makeMesh(app);
    const doc = app.editor.doc;
    doc.update = doc.update.bind(doc);
    let g;
    doc.transact('Expand', () => {
      g = expandLive(doc, m.id);
    });
    expect(g.type).toBe('group');
    const clip = doc.get(g.children[0]);
    expect(clip.type).toBe('group');
    expect(clip.clip).toBe(true);
    const cells = clip.children.slice(0, -1).map((id) => doc.get(id));
    expect(cells.length).toBeGreaterThan(4);
    expect(cells.every((c) => c.type === 'path' && c.fill.color === '#3366cc')).toBe(true);
    const b = nodeBounds(doc, g);
    expect(b.x).toBeCloseTo(100);
    expect(b.w).toBeCloseTo(200);
  });

  it('exports SVG as a clipped image and PDF as a Coons patch mesh shading', async () => {
    const m = makeMesh(app);
    const doc = app.editor.doc;
    doc.transact('Color', () => doc.update(m.id, { points: m.points.map((p, k) => (k === 0 ? { ...p, c: '#ff0000', a: 0.5 } : p)) }));
    const { exportSVG } = await import('../src/features/io/svg-export.js');
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(svg).toMatch(/<clipPath id="[^"]+">\s*<path d="M 100 100 /);
    expect(svg).toMatch(/<image x="100" y="100" width="200" height="100"[^>]*xlink:href="data:image\/png;base64,/);
    const { writePDF } = await import('../src/features/io/pdf.js');
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    const s = new TextDecoder('latin1').decode(bytes);
    expect(s).toContain('/ShadingType 6');
    expect(s).toContain('/ColorSpace /DeviceGray /BitsPerCoordinate 32');
    expect(s).toContain('/S /Luminosity');
    expect(s).toMatch(/\/Sh\d+ sh/);
  });

  it('writes patches in the Coons patch stream layout', () => {
    const m = makeMesh(app, { rows: 1, cols: 1 });
    const { bytes, decode } = coonsPatchData(m);
    expect(bytes.length).toBe(1 + 96 + 24);
    expect(decode).toEqual([100, 300, 100, 200]);
    const dv = new DataView(bytes.buffer);
    // First point is the top-left corner, fourth the top-right.
    expect(dv.getUint32(1)).toBe(0);
    expect(dv.getUint32(1 + 3 * 8)).toBe(0xffffffff);
    expect(dv.getUint32(1 + 3 * 8 + 4)).toBe(0);
    // First color: #3366cc in 16 bits.
    expect(dv.getUint16(97)).toBe(Math.round((0x33 / 255) * 65535));
  });
});

describe('editing mesh points', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  it('colors selected points from the paint controls and reports their color', () => {
    const m = makeMesh(app);
    const k = idx(m, 1, 1);
    selectMeshPoints(app.editor, m.id, [k]);
    expect(commonStyle(app.editor, 'fill')).toEqual({ type: 'solid', color: '#3366cc' });
    applyStyle(app.editor, { fill: { type: 'solid', color: '#ff8800' } });
    const after = app.editor.doc.get(m.id);
    expect(after.points[k].c).toBe('#ff8800');
    expect(after.points[0].c).toBe('#3366cc');
    applyStyle(app.editor, { opacity: 0.25 });
    expect(app.editor.doc.get(m.id).points[k].a).toBe(0.25);
    expect(app.editor.doc.get(m.id).opacity).toBe(1);
    // A different selection drops the point selection.
    app.editor.select([m.id]);
    expect(meshPointSelection(app.editor).size).toBe(0);
    expect(commonStyle(app.editor, 'fill')).toBe('mixed');
    applyStyle(app.editor, { fill: { type: 'solid', color: '#00ff00' } });
    expect(app.editor.doc.get(m.id).points.every((p) => p.c === '#00ff00')).toBe(true);
  });

  it('Mesh tool converts a filled path and adds lines through the click', () => {
    const r = addRect(app, 100, 100, 200, 100);
    app.editor.setStyle({ fill: { type: 'solid', color: '#ffffff' } });
    app.setTool('mesh');
    click(app, app.tool, 150, 125);
    const doc = app.editor.doc;
    expect(doc.get(r.id)).toBeUndefined();
    const m = doc.leaves().find((n) => n.type === 'mesh');
    expect(m.rows).toBe(2);
    expect(m.cols).toBe(2);
    const k = idx(m, 1, 1);
    expect(m.points[k].x).toBeCloseTo(150, 3);
    expect(m.points[k].y).toBeCloseTo(125, 3);
    expect(m.points[k].c).toBe('#ffffff');
    expect(m.points[0].c).toBe('#3366cc');
    expect([...meshPointSelection(app.editor).get(m.id)]).toEqual([k]);
    doc.undo();
    expect(doc.get(r.id)).toBeTruthy();
  });

  it('Mesh tool adds a line on a line, drags points, and removes lines with Option', () => {
    const m0 = makeMesh(app, { rows: 1, cols: 1 });
    const doc = app.editor.doc;
    app.editor.select([m0.id]);
    app.setTool('mesh');
    // Shift-click keeps the existing color.
    click(app, app.tool, 200, 150, { shift: true });
    let m = doc.get(m0.id);
    expect(m.rows).toBe(2);
    expect(m.points[idx(m, 1, 1)].c).toBe('#3366cc');
    // Click on the new row line: one more column.
    click(app, app.tool, 250, 150);
    m = doc.get(m0.id);
    expect(m.cols).toBe(3);
    expect(m.rows).toBe(2);
    // Drag the center point.
    drag(app, app.tool, [200, 150], [210, 160]);
    m = doc.get(m0.id);
    expect(m.points[idx(m, 1, 1)].x).toBeCloseTo(210, 3);
    expect(m.points[idx(m, 1, 1)].y).toBeCloseTo(160, 3);
    // Option-click the point: its row and column lines go.
    click(app, app.tool, 210, 160, { alt: true });
    m = doc.get(m0.id);
    expect(m.rows).toBe(1);
    expect(m.cols).toBe(2);
  });

  it('Direct Selection selects points, patches and drags them', () => {
    const m = makeMesh(app);
    app.editor.select([m.id]);
    app.setTool('direct-selection');
    // Inside patch (0, 1): its four corners.
    click(app, app.tool, 260, 120);
    const sel = meshPointSelection(app.editor).get(m.id);
    expect([...sel].sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    // A click on a selected point narrows to it; dragging moves it with handles.
    click(app, app.tool, 200, 150);
    expect([...meshPointSelection(app.editor).get(m.id)]).toEqual([4]);
    drag(app, app.tool, [200, 150], [190, 140]);
    const after = app.editor.doc.get(m.id);
    expect(after.points[4]).toMatchObject({ x: 190, y: 140 });
    expect(after.points[1].x).toBe(200);
    // Marquee picks points inside.
    app.tool.onPointerDown(ev(app, 50, 50));
    app.tool.onPointerMove(ev(app, 120, 220));
    app.tool.onPointerUp(ev(app, 120, 220));
    expect([...meshPointSelection(app.editor).get(m.id)].sort((a, b) => a - b)).toEqual([0, 3, 6]);
  });

  it('Direct Selection marquee in a rotated view picks only the points inside the turned marquee', () => {
    const m = makeMesh(app);
    app.editor.select([m.id]);
    app.setTool('direct-selection');
    const view = app.editor.view;
    view.set({ rotation: 45 });
    // A screen-aligned marquee started off the mesh, above and right of its center.
    const c = view.toScreen(200, 150);
    const box = { x0: c.x + 20, y0: c.y - 200, x1: c.x + 400, y1: c.y + 30 };
    const corners = [
      view.toDoc(box.x0, box.y0),
      view.toDoc(box.x1, box.y0),
      view.toDoc(box.x1, box.y1),
      view.toDoc(box.x0, box.y1),
    ];
    const inMarquee = (p) => {
      const s = view.toScreen(p.x, p.y);
      return s.x >= box.x0 && s.x <= box.x1 && s.y >= box.y0 && s.y <= box.y1;
    };
    const xs = corners.map((q) => q.x);
    const ys = corners.map((q) => q.y);
    const inBounds = (p) =>
      p.x >= Math.min(...xs) && p.x <= Math.max(...xs) && p.y >= Math.min(...ys) && p.y <= Math.max(...ys);
    const expected = m.points.flatMap((p, k) => (inMarquee(p) ? [k] : []));
    // The marquee's axis-aligned bounds take in more points than the marquee itself.
    expect(expected.length).toBeGreaterThan(0);
    expect(m.points.filter(inBounds).length).toBeGreaterThan(expected.length);
    const [a, b] = [corners[0], corners[2]];
    app.tool.onPointerDown(ev(app, a.x, a.y));
    app.tool.onPointerMove(ev(app, b.x, b.y));
    app.tool.onPointerUp(ev(app, b.x, b.y));
    expect([...meshPointSelection(app.editor).get(m.id)].sort((p, q) => p - q)).toEqual(expected);
  });

  it('Delete removes the lines through selected mesh points', async () => {
    const m = makeMesh(app, { rows: 3, cols: 3 });
    selectMeshPoints(app.editor, m.id, [idx(m, 1, 1)]);
    await app.commands.run('edit.clear');
    const after = app.editor.doc.get(m.id);
    expect(after).toBeTruthy();
    expect(after.rows).toBe(2);
    expect(after.cols).toBe(2);
    // Corner points have no interior lines: nothing happens.
    selectMeshPoints(app.editor, m.id, [0]);
    await app.commands.run('edit.clear');
    expect(app.editor.doc.get(m.id).rows).toBe(2);
    // Without points selected the whole mesh goes.
    app.editor.select([m.id]);
    await app.commands.run('edit.clear');
    expect(app.editor.doc.get(m.id)).toBeUndefined();
  });
});
