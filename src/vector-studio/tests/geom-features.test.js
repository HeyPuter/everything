import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource, runGeom, OP } from '../src/features/geometry/engine/index.js';
import { VDocument } from '../src/model/document.js';
import { Editor } from '../src/editor.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle, ellipse, polygon } from '../src/model/shapes.js';
import { flattenPath, anchor } from '../src/model/bezier.js';
import { runPathfinder, buildResults, canRun } from '../src/features/geometry/pathfinder.js';
import { shapeBuilderPlan, splitPathAt, joinEnds } from '../src/features/geometry/tools.js';
import { addMidpoints, removeAnchorsKeepingShape, fitPolygon } from '../src/features/geometry/anchors.js';
import { recognizeShape, gridCells, cleanUpTargets, outlineStroke, divideBelow, simplifySubpaths, addAnchorPoints, strokeParams } from '../src/features/geometry/path-ops.js';
import { geometryLeaves, nodeFromSubpaths } from '../src/features/geometry/nodes-io.js';

beforeAll(() => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
});

function areaOf(anchors, closed = true) {
  const pts = flattenPath(anchors, closed, 0.005);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s / 2);
}

const solid = (color) => ({ type: 'solid', color });
const prefs = { get: () => undefined, set: () => {} };

function setup(nodes) {
  const doc = VDocument.create();
  const layer = doc.layers()[0];
  doc.transact('setup', () => nodes.forEach((n) => doc.insert(n, layer.id)));
  const editor = new Editor(doc, { prefs });
  const app = { editor, notify: vi.fn(), root: document.body, prefs, commands: { get: () => null } };
  return { doc, editor, app, layer };
}

describe('Pathfinder on documents', () => {
  it('Unite takes the topmost style and replaces the operands with one undo step', async () => {
    const a = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: solid('#000000'), strokeWidth: 3 });
    const b = createPath(rectangle(50, 50, 100, 100), true, { fill: solid('#00ff00'), stroke: null });
    const { doc, editor, app, layer } = setup([a, b]);
    editor.select([a.id, b.id]);
    expect(canRun(editor, 'unite')).toBe(true);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = doc.get(layer.id).children;
    expect(kids).toHaveLength(1);
    const r = doc.get(kids[0]);
    expect(r.type).toBe('path');
    expect(r.anchors).toHaveLength(8);
    expect(r.fill.color).toBe('#00ff00');
    expect(r.stroke).toBe(null);
    expect([...editor.selection]).toEqual([r.id]);
    expect(app.lastPathfinder).toBe('unite');
    doc.undo();
    expect(doc.get(layer.id).children).toEqual([a.id, b.id]);
  });

  it('Minus Front keeps the backmost style and makes a compound path for holes', async () => {
    const a = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000') });
    const b = createPath(ellipse(25, 25, 50, 50), true, { fill: solid('#0000ff') });
    const { doc, editor, app, layer } = setup([a, b]);
    editor.select([a.id, b.id]);
    await runPathfinder(app, 'minusFront');
    const r = doc.get(doc.get(layer.id).children[0]);
    expect(r.type).toBe('compound');
    expect(r.fill.color).toBe('#ff0000');
    expect(r.children).toHaveLength(2);
    const total = r.children.map((c) => doc.get(c)).reduce((s, c) => s + areaOf(c.anchors), 0);
    // Outer plus hole magnitudes; the hole is reversed so non-zero fill cuts it out.
    expect(total).toBeCloseTo(10000 + Math.PI * 625, -1);
  });

  it('Divide groups faces; Trim drops strokes; Outline strokes edges with 0 pt', async () => {
    const mk = () => [
      createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: solid('#000000'), strokeWidth: 2 }),
      createPath(rectangle(50, 50, 100, 100), true, { fill: solid('#00ff00'), stroke: solid('#000000'), strokeWidth: 2 }),
    ];
    for (const [kind, check] of [
      ['divide', (g, doc) => {
        expect(g.children).toHaveLength(3);
        expect(g.children.every((c) => doc.get(c).strokeWidth === 2)).toBe(true);
      }],
      ['trim', (g, doc) => {
        expect(g.children).toHaveLength(2);
        expect(g.children.every((c) => doc.get(c).stroke === null)).toBe(true);
      }],
      ['outline', (g, doc) => {
        expect(g.children).toHaveLength(4);
        const kids = g.children.map((c) => doc.get(c));
        expect(kids.every((k) => k.fill === null && k.strokeWidth === 0 && !k.closed)).toBe(true);
        expect(new Set(kids.map((k) => k.stroke.color))).toEqual(new Set(['#ff0000', '#00ff00']));
      }],
    ]) {
      const nodes = mk();
      const { doc, editor, app, layer } = setup(nodes);
      editor.select(nodes.map((n) => n.id));
      await runPathfinder(app, kind);
      const g = doc.get(doc.get(layer.id).children[0]);
      expect(g.type).toBe('group');
      check(g, doc);
    }
  });

  it('Merge joins overlapping fills of the same color only', async () => {
    const nodes = [
      createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000') }),
      createPath(rectangle(50, 0, 100, 100), true, { fill: solid('#ff0000') }),
      createPath(rectangle(120, 0, 100, 100), true, { fill: solid('#0000ff') }),
    ];
    const { doc, editor, app, layer } = setup(nodes);
    editor.select(nodes.map((n) => n.id));
    await runPathfinder(app, 'merge');
    const g = doc.get(doc.get(layer.id).children[0]);
    const kids = g.children.map((c) => doc.get(c));
    expect(kids).toHaveLength(2);
    const red = kids.find((k) => k.fill.color === '#ff0000');
    expect(areaOf(red.anchors)).toBeCloseTo(120 * 100, 2);
  });

  it('cancels when the artwork changes while a job runs', async () => {
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    const b = createPath(rectangle(5, 5, 10, 10), true, { fill: solid('#ff0000') });
    const { doc, editor, app } = setup([a, b]);
    editor.select([a.id, b.id]);
    const p = runPathfinder(app, 'unite');
    doc.transact('edit', () => doc.update(a.id, { opacity: 0.5 }));
    expect(await p).toBe(false);
    expect(doc.has(a.id)).toBe(true);
  });

  it('treats a selected compound child as the whole compound', () => {
    const k1 = createPath(rectangle(0, 0, 10, 10), true);
    const c = createCompound([], { fill: solid('#000000') });
    const { doc, editor } = setup([]);
    doc.transact('c', () => {
      doc.insert(c, doc.layers()[0].id);
      doc.insert(k1, c.id);
    });
    editor.select([k1.id]);
    expect(geometryLeaves(doc, editor.topSelection()).map((n) => n.id)).toEqual([c.id]);
  });
});

describe('buildResults', () => {
  it('uses the record owner for style and skips unfilled owners for Trim', () => {
    const leaves = [{ id: 'a', type: 'path', fill: null, stroke: solid('#111111') }, { id: 'b', type: 'path', fill: solid('#222222'), stroke: solid('#333333'), strokeWidth: 4 }];
    const sq = { closed: true, anchors: rectangle(0, 0, 1, 1) };
    const items = buildResults('trim', leaves, [{ owner: 0, cover: [0], subpaths: [sq] }, { owner: 1, cover: [1], subpaths: [sq] }]);
    expect(items).toHaveLength(1);
    expect(items[0].descendants).toHaveLength(1);
    expect(items[0].descendants[0].fill.color).toBe('#222222');
    expect(items[0].descendants[0].stroke).toBe(null);
  });
});

describe('Shape Builder planning', () => {
  it('merges touched faces and rebuilds the affected objects from the rest', () => {
    const faces = [
      { owner: 0, cover: [0], subpaths: [] },
      { owner: 1, cover: [0, 1], subpaths: [] },
      { owner: 1, cover: [1], subpaths: [] },
      { owner: 2, cover: [2], subpaths: [] },
    ];
    const plan = shapeBuilderPlan(faces, [0, 1], 0, false);
    expect(plan.affected).toEqual([0, 1]);
    expect(plan.mergeOwner).toBe(0);
    expect(plan.groupOfShape).toEqual(['merge', 'merge', 1]);
    expect(new Set(plan.shapes.map((s) => s.key)).size).toBe(2);
    const del = shapeBuilderPlan(faces, [1], 1, true);
    expect(del.groupOfShape).toEqual([0, 1]);
  });

  it('merges real faces through the engine', async () => {
    const faces = await runGeom(OP.DIVIDE, [
      { subpaths: [{ closed: true, anchors: rectangle(0, 0, 100, 100) }], filled: true },
      { subpaths: [{ closed: true, anchors: rectangle(50, 0, 100, 100) }], filled: true },
    ]);
    const left = faces.findIndex((f) => f.cover.length === 1 && f.owner === 0);
    const mid = faces.findIndex((f) => f.cover.length === 2);
    const plan = shapeBuilderPlan(faces, [left, mid], left, false);
    const recs = await runGeom(OP.UNITE_GROUPS, plan.shapes);
    expect(recs).toHaveLength(2);
    const merged = recs.find((r) => plan.groupOfShape[r.owner] === 'merge');
    expect(areaOf(merged.subpaths[0].anchors)).toBeCloseTo(10000, 2);
  });
});

describe('Scissors and Join', () => {
  it('splits an open path into two pieces at a segment parameter', () => {
    const pieces = splitPathAt([anchor(0, 0), anchor(100, 0), anchor(100, 100)], false, 0, 0.5);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].anchors.at(-1)).toMatchObject({ x: 50, y: 0 });
    expect(pieces[1].anchors[0]).toMatchObject({ x: 50, y: 0 });
    expect(pieces[1].anchors).toHaveLength(3);
  });

  it('opens a closed path at the cut and keeps its shape', () => {
    const circle = ellipse(0, 0, 100, 100);
    const [open] = splitPathAt(circle, true, 1, 0.5);
    expect(open.closed).toBe(false);
    expect(open.anchors).toHaveLength(6);
    expect(open.anchors[0]).toMatchObject({ x: open.anchors[5].x, y: open.anchors[5].y });
    expect(areaOf(open.anchors, true)).toBeCloseTo(areaOf(circle), 1);
  });

  it('refuses to split an open path at its endpoint', () => {
    expect(splitPathAt([anchor(0, 0), anchor(10, 0)], false, 0, 0)).toBe(null);
  });

  it('joins ends with a straight segment or merges coincident ends', () => {
    expect(joinEnds([anchor(0, 0), anchor(10, 0)], 'end', [anchor(20, 0), anchor(30, 0)], 'start')).toHaveLength(4);
    expect(joinEnds([anchor(0, 0), anchor(10, 0)], 'end', [anchor(30, 0), anchor(10, 0)], 'end')).toHaveLength(3);
    const j = joinEnds([anchor(0, 0), anchor(10, 0)], 'start', [anchor(-10, 0), anchor(-20, 0)], 'start');
    expect(j.map((a) => a.x)).toEqual([10, 0, -10, -20]);
  });
});

describe('anchor editing', () => {
  it('adds exact midpoints and removes them again without changing the shape', () => {
    const circle = ellipse(0, 0, 100, 100);
    const dense = addMidpoints(circle, true);
    expect(dense).toHaveLength(8);
    expect(areaOf(dense)).toBeCloseTo(areaOf(circle), 0);
    const back = removeAnchorsKeepingShape(dense, true, new Set([1, 3, 5, 7]));
    expect(back).toHaveLength(4);
    expect(areaOf(back)).toBeCloseTo(areaOf(circle), 0);
  });

  it('keeps open path endpoints', () => {
    const a = [anchor(0, 0), anchor(5, 5), anchor(10, 0)];
    expect(removeAnchorsKeepingShape(a, false, new Set([0, 2]))).toBe(a);
    expect(removeAnchorsKeepingShape(a, false, new Set([1]))).toHaveLength(2);
  });

  it('Add Anchor Points works on paths and compound children', () => {
    const p = createPath(rectangle(0, 0, 10, 10), true, {}, { shape: { kind: 'rect' } });
    const { doc, editor } = setup([p]);
    editor.select([p.id]);
    addAnchorPoints(editor);
    expect(doc.get(p.id).anchors).toHaveLength(8);
    expect(doc.get(p.id).shape).toBeUndefined();
  });
});

describe('Simplify', () => {
  it('fits a dense polygon with few curves and keeps real corners', async () => {
    const circle = Array.from({ length: 72 }, (_, i) => anchor(50 * Math.cos((i / 72) * Math.PI * 2), 50 * Math.sin((i / 72) * Math.PI * 2)));
    const [sp] = await simplifySubpaths([{ closed: true, anchors: circle }], 0.3, 30);
    expect(sp.anchors.length).toBeLessThan(12);
    expect(areaOf(sp.anchors)).toBeCloseTo(Math.PI * 2500, -2);
    const square = addMidpoints(addMidpoints(rectangle(0, 0, 100, 100), true), true);
    const [sq] = await simplifySubpaths([{ closed: true, anchors: square }], 0.3, 30);
    expect(sq.anchors).toHaveLength(4);
  });

  it('fitPolygon splits runs at corners', () => {
    const out = fitPolygon([anchor(0, 0), anchor(50, 0), anchor(100, 0), anchor(100, 100), anchor(0, 100)], true, 0.5, 30);
    expect(out).toHaveLength(4);
  });
});

describe('path commands', () => {
  it('recognizes rectangles, ellipses and regular polygons', () => {
    expect(recognizeShape(rectangle(10, 20, 30, 40), true)).toMatchObject({ kind: 'rect', cx: 25, cy: 40, w: 30, h: 40 });
    expect(recognizeShape(ellipse(0, 0, 80, 40), true)).toMatchObject({ kind: 'ellipse', w: 80, h: 40 });
    expect(recognizeShape(polygon(0, 0, 50, 6), true)).toMatchObject({ kind: 'polygon', sides: 6 });
    expect(recognizeShape([anchor(0, 0), anchor(10, 3), anchor(2, 9)], true)).toBe(null);
  });

  it('computes grid cells with gutters', () => {
    const { cells, cw, ch } = gridCells({ x: 0, y: 0, w: 110, h: 50 }, { rows: 2, cols: 2, rowGutter: 10, colGutter: 10 });
    expect(cells).toHaveLength(4);
    expect(cw).toBe(50);
    expect(ch).toBe(20);
    expect(cells[3]).toEqual({ x: 60, y: 30, w: 50, h: 20 });
  });

  it('finds stray points, unpainted objects and empty text for Clean Up', () => {
    const stray = createPath([anchor(1, 1)], false);
    const unpainted = createPath(rectangle(0, 0, 5, 5), true, { fill: null, stroke: null });
    const painted = createPath(rectangle(0, 0, 5, 5), true);
    const { doc } = setup([stray, unpainted, painted]);
    expect(cleanUpTargets(doc).sort()).toEqual([stray.id, unpainted.id].sort());
    expect(cleanUpTargets(doc, { stray: false, unpainted: true, emptyText: true })).toEqual([unpainted.id]);
  });

  it('Outline Stroke turns a stroked filled path into a group of fill and stroke shapes', async () => {
    const p = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 10 });
    const { doc, editor, app, layer } = setup([p]);
    editor.select([p.id]);
    expect(strokeParams(doc.get(p.id)).slice(0, 5)).toEqual([10, 0, 0, 10, 0]);
    await outlineStroke(app);
    const g = doc.get(doc.get(layer.id).children[0]);
    expect(g.type).toBe('group');
    const [fill, stroke] = g.children.map((c) => doc.get(c));
    expect(fill.stroke).toBe(null);
    expect(fill.fill.color).toBe('#ff0000');
    expect(stroke.type).toBe('compound');
    expect(stroke.fill.color).toBe('#0000ff');
    expect(stroke.stroke).toBe(null);
  });

  it('Outline Stroke keeps the dots of a dotted line (zero-length dashes with round caps)', async () => {
    const p = createPath([anchor(0, 0), anchor(100, 0)], false, { fill: null, stroke: solid('#0000ff'), strokeWidth: 10, strokeCap: 'round', dash: [0, 20] });
    const { doc, editor, app, layer } = setup([p]);
    editor.select([p.id]);
    await outlineStroke(app);
    const dots = doc.get(doc.get(layer.id).children[0]);
    expect(dots.type).toBe('compound');
    expect(dots.fill.color).toBe('#0000ff');
    const kids = dots.children.map((c) => doc.get(c));
    expect(kids).toHaveLength(5);
    for (const k of kids) expect(areaOf(k.anchors)).toBeCloseTo(Math.PI * 25, 0);
    // Butt caps draw nothing for zero-length dashes; an all-zero pattern stays solid.
    expect(strokeParams({ ...p, strokeCap: 'butt' }).slice(6)).toEqual([0, 20]);
    expect(strokeParams({ ...p, dash: [0, 0] }).slice(6)).toEqual([0, 0]);
  });

  it('Divide Objects Below cuts the objects under the selected path', async () => {
    const below = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000') });
    const cutter = createPath(rectangle(50, -10, 100, 120), true, { fill: solid('#000000') });
    const { doc, editor, app, layer } = setup([below, cutter]);
    editor.select([cutter.id]);
    await divideBelow(app);
    const kids = doc.get(layer.id).children.map((c) => doc.get(c));
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.fill.color === '#ff0000')).toBe(true);
    expect(kids.map((k) => areaOf(k.anchors)).sort((a, b) => a - b)).toEqual([expect.closeTo(5000, 2), expect.closeTo(5000, 2)]);
  });

  it('builds compound nodes for multi-subpath results', () => {
    const built = nodeFromSubpaths([{ closed: true, anchors: rectangle(0, 0, 1, 1) }, { closed: true, anchors: rectangle(2, 2, 1, 1) }], { fill: solid('#000000') });
    expect(built.node.type).toBe('compound');
    expect(built.descendants).toHaveLength(2);
    expect(built.descendants.every((d) => d.parent === built.node.id)).toBe(true);
  });
});

describe('PreviewSession', () => {
  it('rolls back previews and ignores late ones after dispose', async () => {
    const { PreviewSession } = await import('../src/features/geometry/path-ops.js');
    const p = createPath(rectangle(0, 0, 10, 10), true);
    const { doc } = setup([p]);
    const s = new PreviewSession(doc, 'Preview');
    s.show(() => doc.update(p.id, { opacity: 0.5 }));
    expect(doc.get(p.id).opacity).toBe(0.5);
    s.show(() => doc.update(p.id, { opacity: 0.25 }));
    expect(doc.get(p.id).opacity).toBe(0.25);
    s.dispose();
    expect(doc.get(p.id).opacity).toBe(1);
    s.show(() => doc.update(p.id, { opacity: 0.1 }));
    expect(doc.tx).toBe(null);
    expect(doc.get(p.id).opacity).toBe(1);
  });
});
