import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { installCanvasStub, bootAppWithFeatures } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { liveArtwork, expandLive, isLive } from '../src/model/live.js';
import { transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { applyStyle, commonStyle } from '../src/ops/paint-ops.js';
import { faceAt, edgeAt } from '../src/features/regions/planar.js';
import {
  makeRegions,
  regionMap,
  regionPaints,
  paintFaces,
  paintEdges,
  mergeIntoRegions,
  releaseRegions,
  closeGapsWithPaths,
  connectedFaces,
} from '../src/features/regions/regions-model.js';

const solid = (c) => ({ type: 'solid', color: c });
const black = solid('#000000');

beforeAll(() => installCanvasStub());

function addTo(doc, node) {
  doc.transact('add', () => doc.insert(node, doc.layers()[0].id));
  return node.id;
}

/** Two overlapping squares (yellow under blue) and a line across both. */
function setup() {
  const doc = VDocument.create({ width: 400, height: 400 });
  const a = addTo(doc, createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ffcc00'), stroke: black, strokeWidth: 2 }));
  const b = addTo(doc, createPath(rectangle(50, 50, 100, 100), true, { fill: solid('#0066ff'), stroke: black, strokeWidth: 2 }));
  const l = addTo(doc, createPath([anchor(-20, 25), anchor(170, 25)], false, { fill: null, stroke: solid('#ff0000'), strokeWidth: 1 }));
  let g;
  doc.transact('make', () => {
    g = makeRegions(doc, [a, b, l]);
  });
  return { doc, g, a, b, l };
}

const fillAt = (doc, g, x, y) => {
  const { map, fills } = regionPaints(doc, doc.get(g));
  const f = faceAt(map, x, y);
  return f ? fills[f.id] : undefined;
};
const strokeAt = (doc, g, x, y) => {
  const { map, strokes } = regionPaints(doc, doc.get(g));
  const e = edgeAt(map, x, y, 0.5);
  return e ? strokes[e.id] : undefined;
};

describe('paint regions model', () => {
  it('makes regions that keep the look of the objects', () => {
    const { doc, g, a, b, l } = setup();
    const node = doc.get(g);
    expect(isLive(node)).toBe(true);
    expect(node.children).toEqual([a, b, l]);
    const map = regionMap(doc, node);
    // The line splits the yellow square into two; the overlap and the rest of blue make 4 faces.
    expect(map.faces).toHaveLength(4);
    expect(fillAt(doc, g, 10, 10).color).toBe('#ffcc00');
    expect(fillAt(doc, g, 10, 60).color).toBe('#ffcc00');
    expect(fillAt(doc, g, 75, 75).color).toBe('#0066ff');
    expect(fillAt(doc, g, 120, 120).color).toBe('#0066ff');
    expect(fillAt(doc, g, 200, 200)).toBeUndefined();
    // Edges keep the stroke of their path.
    expect(strokeAt(doc, g, 0, 60).strokeWidth).toBe(2);
    expect(strokeAt(doc, g, -10, 25).stroke.color).toBe('#ff0000');
    // Drawn: a fills group and a strokes group, the sources are not drawn themselves.
    const { items } = liveArtwork(doc, node);
    expect(items.map((n) => n.name)).toEqual(['Fills', 'Strokes']);
  });

  it('paints faces and edges, and paint survives editing the paths', () => {
    const { doc, g, l } = setup();
    const map = regionMap(doc, doc.get(g));
    doc.transact('paint', () => paintFaces(doc, g, [faceAt(map, 10, 10)], solid('#00aa00')));
    expect(fillAt(doc, g, 10, 10).color).toBe('#00aa00');
    expect(fillAt(doc, g, 10, 60).color).toBe('#ffcc00');
    doc.transact('stroke', () => paintEdges(doc, g, [edgeAt(map, 0, 60, 0.5)], { stroke: null }));
    expect(strokeAt(doc, g, 0, 60)).toBe(null);
    // Move the line down a little: the regions above and below it change shape but keep their paint.
    doc.transact('edit', () => doc.update(l, { anchors: [anchor(-20, 35), anchor(170, 35)] }));
    expect(fillAt(doc, g, 10, 10).color).toBe('#00aa00');
    expect(fillAt(doc, g, 10, 30).color).toBe('#00aa00');
    expect(fillAt(doc, g, 10, 60).color).toBe('#ffcc00');
    expect(strokeAt(doc, g, 0, 60)).toBe(null);
    // Undo brings back the line and the earlier paint.
    doc.undo();
    doc.undo();
    expect(strokeAt(doc, g, 0, 60).strokeWidth).toBe(2);
    doc.undo();
    expect(fillAt(doc, g, 10, 10).color).toBe('#ffcc00');
  });

  it('a face split by a merged path keeps its paint on both sides', () => {
    const { doc, g } = setup();
    const v = addTo(doc, createPath([anchor(20, -10), anchor(20, 110)], false, { fill: null, stroke: black, strokeWidth: 1 }));
    doc.transact('merge', () => mergeIntoRegions(doc, g, [v]));
    expect(doc.get(g).children).toContain(v);
    expect(fillAt(doc, g, 10, 10).color).toBe('#ffcc00');
    expect(fillAt(doc, g, 30, 10).color).toBe('#ffcc00');
    expect(regionMap(doc, doc.get(g)).faces.length).toBe(6);
  });

  it('merged filled paths paint what they cover', () => {
    const { doc, g } = setup();
    const r = addTo(doc, createPath(rectangle(10, 60, 20, 20), true, { fill: solid('#ff00ff'), stroke: null }));
    doc.transact('merge', () => mergeIntoRegions(doc, g, [r]));
    expect(fillAt(doc, g, 20, 70).color).toBe('#ff00ff');
    expect(fillAt(doc, g, 40, 70).color).toBe('#ffcc00');
  });

  it('paint moves with the group and exports and expands as plain paths', () => {
    const { doc, g } = setup();
    const map = regionMap(doc, doc.get(g));
    doc.transact('paint', () => paintFaces(doc, g, [faceAt(map, 120, 120)], solid('#123456')));
    doc.transact('move', () => transformNodes(doc, [g], translate(200, 0)));
    expect(fillAt(doc, g, 320, 120).color).toBe('#123456');
    expect(fillAt(doc, g, 210, 10).color).toBe('#ffcc00');
    const svg = exportSVG(doc, { rect: { x: 0, y: -50, w: 500, h: 300 } });
    const out = svgToDocument(svg);
    // 4 faces plus the stroke chains.
    expect(out.leaves().filter((n) => n.fill).length).toBe(4);
    let ex;
    doc.transact('expand', () => {
      ex = expandLive(doc, g);
    });
    expect(ex.children).toHaveLength(2);
    const fills = doc.get(ex.children[0]);
    expect(fills.children).toHaveLength(4);
    expect(doc.get(fills.children[0]).fill).toBeTruthy();
    const strokes = doc.get(ex.children[1]);
    expect(strokes.children.every((id) => doc.get(id).stroke && !doc.get(id).fill)).toBe(true);
  });

  it('closes gaps, and closing them with paths keeps the region without detection', () => {
    const doc = VDocument.create({ width: 400, height: 400 });
    const p = addTo(doc, createPath([anchor(54, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100), anchor(0, 0), anchor(50, 0)], false, { fill: solid('#ff0000'), stroke: black }));
    let g;
    doc.transact('make', () => {
      g = makeRegions(doc, [p], { on: true, size: 'medium' });
    });
    expect(regionMap(doc, doc.get(g)).faces).toHaveLength(1);
    expect(regionMap(doc, doc.get(g)).gaps).toHaveLength(1);
    expect(fillAt(doc, g, 50, 50).color).toBe('#ff0000');
    // Small gaps (3 pt) do not close a 4 pt gap.
    doc.transact('gaps', () => doc.update(g, { live: { ...doc.get(g).live, gaps: { ...doc.get(g).live.gaps, size: 'small' } } }));
    expect(regionMap(doc, doc.get(g)).faces).toHaveLength(0);
    doc.undo();
    doc.transact('close', () => closeGapsWithPaths(doc, g));
    doc.transact('off', () => doc.update(g, { live: { ...doc.get(g).live, gaps: { ...doc.get(g).live.gaps, on: false } } }));
    expect(regionMap(doc, doc.get(g)).faces).toHaveLength(1);
    expect(fillAt(doc, g, 50, 50).color).toBe('#ff0000');
  });

  it('finds faces connected through unstroked edges', () => {
    const { doc, g } = setup();
    const map = regionMap(doc, doc.get(g));
    const top = faceAt(map, 10, 10);
    expect(connectedFaces(doc, doc.get(g), top)).toHaveLength(1);
    doc.transact('unstroke', () => paintEdges(doc, g, [edgeAt(map, 10, 25, 0.5)], { stroke: null }));
    expect(connectedFaces(doc, doc.get(g), faceAt(regionMap(doc, doc.get(g)), 10, 10))).toHaveLength(2);
  });

  it('releases to the original paths', () => {
    const { doc, g, a, b, l } = setup();
    let out;
    doc.transact('release', () => {
      out = releaseRegions(doc, g);
    });
    expect(out).toEqual([a, b, l]);
    expect(doc.get(g)).toBeUndefined();
    expect(doc.get(a).fill.color).toBe('#ffcc00');
  });
});

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

describe('paint regions tools and commands', () => {
  let app;
  let doc;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    doc = app.editor.doc;
  });

  const add = (node) => addTo(doc, node);

  it('the bucket leaves regions outside the isolated group alone', async () => {
    const white = { fill: solid('#ffffff'), stroke: black };
    const a = add(createPath(rectangle(100, 100, 100, 100), true, white));
    const b = add(createPath(rectangle(150, 150, 100, 100), true, white));
    app.editor.select([a, b]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    const other = createGroup([]);
    doc.transact('group', () => {
      doc.insert(other, doc.layers()[0].id);
      doc.insert(createPath(rectangle(500, 500, 10, 10), true), other.id);
    });
    app.commands.run('object.isolate', { id: other.id });
    app.setTool('paint-bucket');
    app.editor.setStyle({ fill: solid('#ff0000') });
    const steps = doc.undoStack.length;
    app.tool.onPointerDown(ev(app, 175, 175));
    app.tool.onPointerUp(ev(app, 175, 175));
    expect(fillAt(doc, g, 175, 175).color).toBe('#ffffff');
    expect(doc.undoStack.length).toBe(steps);
    // Isolating the regions group itself paints it.
    app.commands.run('object.isolate', { id: g });
    app.tool.onPointerDown(ev(app, 175, 175));
    app.tool.onPointerUp(ev(app, 175, 175));
    expect(fillAt(doc, g, 175, 175).color).toBe('#ff0000');
  });

  it('Make from the menu shortcut command, then paint with the bucket', async () => {
    const a = add(createPath(rectangle(100, 100, 100, 100), true, { fill: solid('#ffffff'), stroke: black }));
    const b = add(createPath(rectangle(150, 150, 100, 100), true, { fill: solid('#ffffff'), stroke: black }));
    app.editor.select([a, b]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    expect(doc.get(g).live.kind).toBe('paintRegions');
    app.setTool('paint-bucket');
    const tool = app.tool;
    app.editor.setStyle({ fill: solid('#ff0000') });
    tool.onHover(ev(app, 175, 175));
    expect(tool.hot.face).toBeTruthy();
    tool.onPointerDown(ev(app, 175, 175));
    tool.onPointerUp(ev(app, 175, 175));
    expect(fillAt(doc, g, 175, 175).color).toBe('#ff0000');
    expect(fillAt(doc, g, 120, 120).color).toBe('#ffffff');
    expect(doc.undoLabel).toBe('Paint Region');
    // Drag across two regions: one undo step.
    app.editor.setStyle({ fill: solid('#00ff00') });
    const steps = doc.undoStack.length;
    tool.onPointerDown(ev(app, 120, 120));
    tool.onPointerMove(ev(app, 175, 175));
    tool.onPointerMove(ev(app, 230, 230));
    tool.onPointerUp(ev(app, 230, 230));
    expect(doc.undoStack.length).toBe(steps + 1);
    expect(fillAt(doc, g, 120, 120).color).toBe('#00ff00');
    expect(fillAt(doc, g, 230, 230).color).toBe('#00ff00');
    // Shift paints edges with the current stroke.
    app.editor.setStyle({ stroke: solid('#0000ff'), strokeWidth: 4 });
    tool.onPointerDown(ev(app, 100, 120, { shift: true }));
    tool.onPointerUp(ev(app, 100, 120, { shift: true }));
    expect(strokeAt(doc, g, 100, 120).stroke.color).toBe('#0000ff');
    expect(strokeAt(doc, g, 100, 120).strokeWidth).toBe(4);
    // Option picks up a region's fill.
    tool.onPointerDown(ev(app, 175, 175, { alt: true }));
    expect(app.editor.style.fill.color).toBe('#00ff00');
    // Arrow keys step through the document swatches.
    const before = JSON.stringify(app.editor.style.fill);
    expect(tool.onKeyDown({ key: 'ArrowRight', shiftKey: false })).toBe(true);
    expect(JSON.stringify(app.editor.style.fill)).not.toBe(before);
  });

  it('the bucket turns selected plain paths into regions on the first click', () => {
    const a = add(createPath(ellipse(100, 100, 100, 100), true, { fill: null, stroke: black }));
    const b = add(createPath(ellipse(160, 100, 100, 100), true, { fill: null, stroke: black }));
    app.editor.select([a, b]);
    app.setTool('paint-bucket');
    app.editor.setStyle({ fill: solid('#abcdef') });
    app.tool.onHover(ev(app, 180, 150));
    app.tool.onPointerDown(ev(app, 180, 150));
    app.tool.onPointerUp(ev(app, 180, 150));
    const g = app.editor.topSelection()[0];
    expect(doc.get(g).live.kind).toBe('paintRegions');
    expect(fillAt(doc, g, 180, 150).color).toBe('#abcdef');
    expect(fillAt(doc, g, 120, 150)).toBe(null);
    doc.undo();
    expect(doc.get(g)).toBeUndefined();
    expect(doc.get(a).parent).toBe(doc.layers()[0].id);
  });

  it('region selection applies panel paint to the selected regions and Delete clears it', async () => {
    const a = add(createPath(rectangle(100, 100, 100, 100), true, { fill: solid('#ffffff'), stroke: black }));
    const l = add(createPath([anchor(80, 150), anchor(220, 150)], false, { fill: null, stroke: black }));
    app.editor.select([a, l]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    app.setTool('region-select');
    const tool = app.tool;
    tool.onPointerDown(ev(app, 150, 120));
    tool.onPointerUp(ev(app, 150, 120));
    expect(app.editor.regionSelection.faces).toHaveLength(1);
    expect([...app.editor.selection]).toEqual([g]);
    applyStyle(app.editor, { fill: solid('#ff8800') }, 'Fill');
    expect(fillAt(doc, g, 150, 120).color).toBe('#ff8800');
    expect(fillAt(doc, g, 150, 180).color).toBe('#ffffff');
    expect(commonStyle(app.editor, 'fill').color).toBe('#ff8800');
    // Shift adds the other region; an edge click selects edges.
    tool.onPointerDown(ev(app, 150, 180, { shift: true }));
    expect(app.editor.regionSelection.faces).toHaveLength(2);
    expect(commonStyle(app.editor, 'fill')).toBe('mixed');
    tool.onPointerDown(ev(app, 150, 150));
    expect(app.editor.regionSelection.edges).toHaveLength(1);
    applyStyle(app.editor, { strokeWidth: 5 }, 'Stroke Weight');
    expect(strokeAt(doc, g, 150, 150).strokeWidth).toBe(5);
    expect(strokeAt(doc, g, 120, 150).strokeWidth).toBe(5);
    expect(strokeAt(doc, g, 100, 130).strokeWidth).toBe(1);
    await app.commands.run('edit.clear');
    expect(doc.get(g)).toBeTruthy();
    expect(strokeAt(doc, g, 150, 150)).toBe(null);
    // Selecting something else ends the region selection.
    app.editor.select([]);
    expect(app.editor.regionSelection).toBe(null);
  });

  it('whole selected groups take panel paint on every region', async () => {
    const a = add(createPath(rectangle(100, 100, 100, 100), true, { fill: solid('#ffffff'), stroke: black }));
    const l = add(createPath([anchor(80, 150), anchor(220, 150)], false, { fill: null, stroke: black }));
    app.editor.select([a, l]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    applyStyle(app.editor, { fill: solid('#112233') }, 'Fill');
    expect(fillAt(doc, g, 150, 120).color).toBe('#112233');
    expect(fillAt(doc, g, 150, 180).color).toBe('#112233');
  });

  it('Gap Options previews, counts gaps and closes them with paths in one step', async () => {
    const p = add(createPath([anchor(104, 100), anchor(200, 100), anchor(200, 200), anchor(100, 200), anchor(100, 100)], false, { fill: solid('#ff0000'), stroke: black }));
    app.editor.select([p]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    expect(regionMap(doc, doc.get(g)).faces).toHaveLength(0);
    const steps = doc.undoStack.length;
    const done = app.commands.run('paintRegions.gapOptions');
    await new Promise((r) => setTimeout(r, 0));
    const dlg = document.querySelector('dialog[open]');
    const sel = dlg.querySelector('select');
    sel.value = 'medium';
    sel.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('output').textContent).toBe('1');
    expect(regionMap(doc, doc.get(g)).faces).toHaveLength(1);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close Gaps with Paths').click();
    expect(dlg.querySelector('output').textContent).toBe('0');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.undoStack.length).toBe(steps + 1);
    expect(doc.get(g).children).toHaveLength(2);
    expect(doc.get(g).live.gaps.size).toBe('medium');
    // View > Show Paint Region Gaps toggles the preview.
    await app.commands.run('view.paintRegionGaps');
    expect(app.editor.viewOptions.paintRegionsGaps).toBe(true);
  });

  it('expand and release from the menu', async () => {
    const a = add(createPath(rectangle(100, 100, 100, 100), true, { fill: solid('#ffffff'), stroke: black }));
    app.editor.select([a]);
    await app.commands.run('paintRegions.make');
    const g = app.editor.topSelection()[0];
    await app.commands.run('paintRegions.release');
    expect(doc.get(g)).toBeUndefined();
    expect([...app.editor.selection]).toEqual([a]);
    doc.undo();
    app.editor.select([g]);
    await app.commands.run('paintRegions.expand');
    expect(doc.get(g)).toBeUndefined();
    const out = doc.get(app.editor.topSelection()[0]);
    expect(isLive(out)).toBe(false);
  });
});
