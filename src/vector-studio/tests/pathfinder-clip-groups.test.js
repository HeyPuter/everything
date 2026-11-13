// Pathfinder on clipping groups: a clipping group selected as a whole takes part with what it shows
// (each clipped object cut to its clipping path, the clipping path itself not an operand), and the
// results land outside it. Paths picked inside a clipping group are combined as they are, and the
// group never ends up clipped by the wrong object.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource } from '../src/features/geometry/engine/index.js';
import { VDocument } from '../src/model/document.js';
import { Editor } from '../src/editor.js';
import {
  createPath,
  createCompound,
  createGroup,
  createImage,
  createText,
} from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { flattenPath, anchor } from '../src/model/bezier.js';
import { runPathfinder, canRun } from '../src/features/geometry/pathfinder.js';
import { geometryLeaves, subpathsOf } from '../src/features/geometry/nodes-io.js';
import { nodeBounds } from '../src/model/geometry.js';
import { makeClipMask } from '../src/ops/object-ops.js';
import { trapCommand, makeCompoundShape } from '../src/features/geometry/pathfinder-extras.js';
import { hitTest } from '../src/render/hit.js';
import { installCanvasStub } from './helpers.js';

beforeAll(() => {
  installCanvasStub();
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
});

const solid = (color) => ({ type: 'solid', color });
const prefs = { get: () => undefined, set: () => {} };
const rect = (x, y, w, h, style = {}) =>
  createPath(rectangle(x, y, w, h), true, { fill: null, stroke: null, ...style });
const filled = (x, y, w, h, color) => rect(x, y, w, h, { fill: solid(color) });

/** Signed area of a subpath list (a compound path's holes count negative when wound the other way). */
function areaOfSubpaths(subpaths) {
  let total = 0;
  for (const sp of subpaths) {
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
/** Painted area of a result node (a path, compound path or group of them). */
function areaOf(doc, n) {
  if (n.type === 'group') return n.children.reduce((s, c) => s + areaOf(doc, doc.get(c)), 0);
  return areaOfSubpaths(subpathsOf(doc, n));
}

/** A clip group of `content` (nodes or [node, descendants]) clipped by `mask`. */
function clipOf(content, mask, maskDescendants = []) {
  const descendants = [];
  const ids = [];
  for (const c of content) {
    const [node, desc = []] = Array.isArray(c) ? c : [c];
    ids.push(node.id);
    descendants.push(node, ...desc);
  }
  const g = createGroup([...ids, mask.id], { clip: true });
  return [g, [...descendants, mask, ...maskDescendants]];
}

function setup(items) {
  const doc = VDocument.create();
  const layer = doc.layers()[0];
  doc.transact('setup', () => {
    for (const it of items) {
      const [node, desc] = Array.isArray(it) ? it : [it, []];
      // Descendants name their parents.
      const byId = new Map(desc.map((d) => [d.id, d]));
      for (const n of [node, ...desc])
        for (const c of n.children || []) if (byId.has(c)) byId.get(c).parent = n.id;
      doc.insert(node, layer.id, Infinity, [...byId.values()]);
    }
  });
  const editor = new Editor(doc, { prefs });
  const app = {
    editor,
    notify: vi.fn(),
    root: document.body,
    prefs,
    commands: { get: () => null },
  };
  return { doc, editor, app, layer };
}

const kidsOf = (doc, id) => doc.get(id).children.map((c) => doc.get(c));

describe('Pathfinder with a clipping group selected as a whole', () => {
  it('unites what the group shows and not its unpainted clipping path, taking the front object paint', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(60, 0, 100, 100, '#0000ff');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a, b], mask);
    const { doc, editor, app, layer } = setup([clip]);
    editor.select([clip[0].id]);
    expect(canRun(editor, 'unite')).toBe(true);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    const r = kids[0];
    // Only the visible band 50..150 x 50..100 of the two squares.
    expect(r.type).toBe('path');
    expect(r.fill?.color).toBe('#0000ff');
    expect(areaOf(doc, r)).toBeCloseTo(100 * 50, 0);
    const bb = nodeBounds(doc, r);
    expect(bb.y).toBeCloseTo(50, 3);
    expect(bb.x + bb.w).toBeCloseTo(150, 3);
    expect(doc.has(clip[0].id)).toBe(false);
    expect(doc.has(mask.id)).toBe(false);
    expect([...editor.selection]).toEqual([r.id]);
  });

  it('combines with objects outside and puts the result outside the group', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a], mask);
    const p = filled(90, 60, 100, 30, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([clip[0].id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].fill.color).toBe('#00ff00');
    // Visible 50..100 square (2500) and the bar (3000) overlap in 90..100 x 60..90 (300).
    expect(areaOf(doc, kids[0])).toBeCloseTo(2500 + 3000 - 300, 0);
  });

  it('Minus Front cuts only what the clipping group shows', async () => {
    const back = filled(0, 0, 200, 100, '#ff0000');
    const a = filled(0, 0, 200, 100, '#0000ff');
    const mask = rect(0, 0, 50, 100);
    const clip = clipOf([a], mask);
    const { doc, editor, app, layer } = setup([back, clip]);
    editor.select([back.id, clip[0].id]);
    expect(await runPathfinder(app, 'minusFront')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].fill.color).toBe('#ff0000');
    expect(areaOf(doc, kids[0])).toBeCloseTo(150 * 100, 0);
  });

  it('Divide makes faces only where the group shows, without unpainted faces of the clipping path', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const mask = rect(50, 0, 100, 100);
    const clip = clipOf([a], mask);
    const p = filled(75, 0, 100, 100, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([clip[0].id, p.id]);
    expect(await runPathfinder(app, 'divide')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    const faces = kidsOf(doc, kids[0].id);
    expect(faces.every((f) => f.fill)).toBe(true);
    // Visible red 50..100 split by green 75..175.
    expect(areaOf(doc, kids[0])).toBeCloseTo(125 * 100, 0);
    // Red 50..75, the overlap 75..100 (green on top) and green 100..175.
    expect(faces).toHaveLength(3);
  });

  it('a clipped cutting line divides only where it shows', async () => {
    const line = createPath([anchor(-50, 50), anchor(250, 50)], false, {
      fill: null,
      stroke: solid('#000000'),
      strokeWidth: 1,
    });
    const clip = clipOf([line], rect(0, 0, 100, 100));
    const p = filled(150, 0, 100, 100, '#00ff00');
    const q = filled(20, 0, 40, 100, '#ff0000');
    const { doc, editor, app, layer } = setup([q, clip, p]);
    editor.select([q.id, clip[0].id, p.id]);
    expect(await runPathfinder(app, 'divide')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    const faces = kidsOf(doc, kids[0].id);
    // The red bar is cut where the line shows (0..100); the green square, past the clip, is not.
    expect(faces.filter((f) => f.fill.color === '#00ff00')).toHaveLength(1);
    expect(faces.filter((f) => f.fill.color === '#ff0000')).toHaveLength(2);
  });

  it('Trim and Crop see the visible part only', async () => {
    for (const kind of ['trim', 'crop']) {
      const a = filled(0, 0, 100, 100, '#ff0000');
      const mask = rect(0, 0, 50, 100);
      const clip = clipOf([a], mask);
      const p = filled(25, 0, 100, 100, '#00ff00');
      const { doc, editor, app, layer } = setup([p, clip]);
      editor.select([p.id, clip[0].id]);
      expect(await runPathfinder(app, kind), kind).toBe(true);
      const kids = kidsOf(doc, layer.id);
      expect(kids, kind).toHaveLength(1);
      // Trim: green 25..125 minus visible red 0..50, plus the red. Crop: the green under the red 25..50.
      expect(areaOf(doc, kids[0]), kind).toBeCloseTo(kind === 'trim' ? 125 * 100 : 25 * 100, 0);
    }
  });

  it('cuts nested clipping groups to every clipping path above them', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const inner = clipOf([a], rect(0, 0, 60, 100));
    const outer = clipOf([inner], rect(0, 0, 100, 40), inner[1]);
    const p = filled(200, 0, 10, 10, '#00ff00');
    const { doc, editor, app, layer } = setup([outer, p]);
    editor.select([outer[0].id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(areaOf(doc, kids[0])).toBeCloseTo(60 * 40 + 100, 0);
  });

  it('clips with a compound clipping path by its fill rule', async () => {
    const outerSq = createPath(rectangle(0, 0, 100, 100), true, {});
    const hole = createPath(rectangle(25, 25, 50, 50), true, {});
    const ring = createCompound(
      [outerSq.id, hole.id],
      { fill: null, stroke: null },
      { fillRule: 'evenodd' },
    );
    const a = filled(0, 0, 100, 100, '#ff0000');
    const clip = clipOf([a], ring, [outerSq, hole]);
    const p = filled(200, 0, 10, 10, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([clip[0].id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(areaOf(doc, kids[0])).toBeCloseTo(10000 - 2500 + 100, 0);
  });

  it('clips with a group used as the clipping path, and content that is itself a group', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(0, 100, 100, 100, '#0000ff');
    const inside = createGroup([a.id, b.id]);
    const m1 = rect(0, 0, 20, 200);
    const m2 = rect(80, 0, 20, 200);
    const maskGroup = createGroup([m1.id, m2.id]);
    const clip = clipOf([[inside, [a, b]]], maskGroup, [m1, m2]);
    const { doc, editor, app, layer } = setup([clip]);
    editor.select([clip[0].id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    // Two 20 x 200 strips.
    expect(areaOf(doc, kids[0])).toBeCloseTo(2 * 20 * 200, 0);
    expect(doc.has(inside.id)).toBe(false);
    expect(doc.has(maskGroup.id)).toBe(false);
  });

  it('keeps a stroked clipping path as an ordinary stroked path when its group is used up', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const mask = rect(50, 50, 100, 100, { stroke: solid('#000000'), strokeWidth: 2 });
    const clip = clipOf([a], mask);
    const p = filled(90, 60, 100, 30, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([clip[0].id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids.map((k) => k.type)).toEqual(['path', 'path']);
    const kept = kids.find((k) => k.id === mask.id);
    expect(kept).toBeTruthy();
    expect(kept.fill).toBe(null);
    expect(kept.stroke.color).toBe('#000000');
    expect(doc.has(clip[0].id)).toBe(false);
  });

  it('leaves a clipping group alone that still shows type or images', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const img = createImage('asset-1', 100, 100);
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([img, a], mask);
    const p = filled(90, 60, 100, 30, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([clip[0].id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids.map((k) => k.id)[0]).toBe(clip[0].id);
    expect(doc.get(clip[0].id).children).toEqual([img.id, mask.id]);
    expect(doc.get(clip[0].id).clip).toBe(true);
    expect(areaOf(doc, kids[1])).toBeCloseTo(2500 + 3000 - 300, 0);
  });

  it('does not count a clipped object that shows nothing', async () => {
    const a = filled(0, 0, 10, 10, '#ff0000');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a], mask);
    const p = filled(60, 60, 10, 10, '#00ff00');
    const q = filled(65, 65, 10, 10, '#0000ff');
    const { doc, editor, app, layer } = setup([clip, p, q]);
    editor.select([clip[0].id, p.id, q.id]);
    expect(await runPathfinder(app, 'intersect')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(areaOf(doc, kids[0])).toBeCloseTo(25, 0);
  });

  it('leaves out a group clipped by type, which it cannot cut to, and says so', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(50, 0, 100, 100, '#0000ff');
    const clip = clipOf([a, b], createText('Hi', 0, 50));
    const { doc, editor, app } = setup([clip]);
    editor.select([clip[0].id]);
    expect(canRun(editor, 'unite')).toBe(false);
    expect(await runPathfinder(app, 'unite')).toBe(false);
    expect(app.notify.mock.calls[0][0]).toMatch(/Create outlines of the clipping type first/);
    expect(doc.get(clip[0].id).children).toHaveLength(3);
  });

  it('geometryLeaves keeps its old answer without the clip option', () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a], mask);
    const { doc } = setup([clip]);
    expect(geometryLeaves(doc, [clip[0].id]).map((n) => n.id)).toEqual([a.id, mask.id]);
    const clipped = new Map();
    expect(geometryLeaves(doc, [clip[0].id], { clipped }).map((n) => n.id)).toEqual([a.id]);
    expect(clipped.get(a.id).masks.map((m) => m.id)).toEqual([mask.id]);
    expect(clipped.get(a.id).group.id).toBe(clip[0].id);
  });
});

describe('Pathfinder on paths picked inside a clipping group', () => {
  it('combines picked contents at full size inside the group, below the clipping path', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(60, 0, 100, 100, '#0000ff');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a, b], mask);
    const { doc, editor, app } = setup([clip]);
    editor.select([a.id, b.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, clip[0].id);
    expect(kids).toHaveLength(2);
    expect(kids[1].id).toBe(mask.id);
    expect(areaOf(doc, kids[0])).toBeCloseTo(160 * 100, 0);
  });

  it('a result that takes the place of the clipping path becomes the new clipping path', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(0, 0, 20, 20, '#0000ff');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a, b], mask);
    const { doc, editor, app } = setup([clip]);
    editor.select([b.id, mask.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const g = doc.get(clip[0].id);
    expect(g.clip).toBe(true);
    expect(g.children).toHaveLength(2);
    expect(g.children[0]).toBe(a.id);
    const m = doc.get(g.children[1]);
    expect(m.fill).toBe(null);
    expect(areaOf(doc, m)).toBeCloseTo(10000 + 400, 0);
  });

  it('a clipping path used up by a result placed elsewhere does not hand the clip to another object', async () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(0, 0, 20, 20, '#0000ff');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a, b], mask);
    const p = filled(140, 60, 100, 30, '#00ff00');
    const { doc, editor, app, layer } = setup([clip, p]);
    editor.select([mask.id, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const g = doc.get(clip[0].id);
    // b (painted) must not become the clipping path: the group no longer clips.
    expect(g.children).toEqual([a.id, b.id]);
    expect(g.clip).toBe(false);
    expect(doc.get(layer.id).children).toHaveLength(2);
  });

  it('several pieces that replace a clipping path clip together as one', async () => {
    const a = filled(0, 0, 300, 100, '#ff0000');
    const mask = rect(0, 0, 300, 100);
    const clip = clipOf([a], mask);
    const bar = filled(100, -10, 100, 120, '#00ff00');
    const { doc, editor, app } = setup([clip]);
    // The bar is picked inside the group too (drawn there in isolation mode).
    doc.transact('add', () => doc.insert(bar, clip[0].id, 1));
    editor.select([bar.id, mask.id]);
    expect(await runPathfinder(app, 'divide')).toBe(true);
    const g = doc.get(clip[0].id);
    expect(g.clip).toBe(true);
    expect(g.children[0]).toBe(a.id);
    expect(g.children).toHaveLength(2);
    expect(doc.get(g.children[1]).type).toBe('group');
  });
});

describe('clipping masks made of Pathfinder results', () => {
  const signed = (anchors) => {
    const pts = flattenPath(anchors, true, 0.01);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  };

  it('a compound path with holes clips by the non-zero rule as drawn and as Pathfinder sees it', async () => {
    // Minus Front of a square inside a bigger one: a frame with a hole.
    const outer = filled(0, 0, 100, 100, '#000000');
    const inner = filled(25, 25, 50, 50, '#ffffff');
    const art = filled(-50, -50, 200, 200, '#ff0000');
    const { doc, editor, app, layer } = setup([art, outer, inner]);
    editor.select([outer.id, inner.id]);
    expect(await runPathfinder(app, 'minusFront')).toBe(true);
    const frame = doc.get(doc.get(layer.id).children[1]);
    expect(frame.type).toBe('compound');
    expect(frame.fillRule).toBe('nonzero');
    // Under the non-zero rule the hole needs the other winding.
    const [a, b] = frame.children.map((id) => signed(doc.get(id).anchors));
    expect(Math.sign(a)).toBe(-Math.sign(b));
    editor.select([art.id, frame.id]);
    makeClipMask(editor);
    const [g] = editor.selection;
    expect(doc.get(g).clip).toBe(true);
    // Clicking the hole hits nothing; the frame shows the art.
    expect(hitTest(doc, 50, 50, 1)).toBe(null);
    expect(hitTest(doc, 10, 10, 1)?.id).toBe(art.id);
    // Pathfinder on the new clip group sees the frame.
    const p = filled(300, 0, 10, 10, '#00ff00');
    doc.transact('add', () => doc.insert(p, layer.id));
    editor.select([g, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].fill.color).toBe('#00ff00');
    expect(areaOf(doc, kids[0])).toBeCloseTo(10000 - 2500 + 100, 0);
  });

  it('a group of Divide pieces clips to all of them', async () => {
    const a = filled(0, 0, 100, 100, '#000000');
    const b = filled(50, 0, 100, 100, '#ffffff');
    const art = filled(-50, -50, 300, 200, '#ff0000');
    const { doc, editor, app, layer } = setup([art, a, b]);
    editor.select([a.id, b.id]);
    expect(await runPathfinder(app, 'divide')).toBe(true);
    const pieces = doc.get(layer.id).children[1];
    editor.select([art.id, pieces]);
    makeClipMask(editor);
    const [g] = editor.selection;
    expect(hitTest(doc, 25, 50, 1)?.id).toBe(art.id);
    expect(hitTest(doc, 75, 50, 1)?.id).toBe(art.id);
    expect(hitTest(doc, 125, 50, 1)?.id).toBe(art.id);
    expect(hitTest(doc, 175, 50, 1)).toBe(null);
    editor.select([g]);
    expect(await runPathfinder(app, 'unite')).toBe(false);
    const p = filled(140, 40, 100, 20, '#00ff00');
    doc.transact('add', () => doc.insert(p, layer.id));
    editor.select([g, p.id]);
    expect(await runPathfinder(app, 'unite')).toBe(true);
    const kids = kidsOf(doc, layer.id);
    expect(kids).toHaveLength(1);
    expect(areaOf(doc, kids[0])).toBeCloseTo(150 * 100 + 90 * 20, 0);
  });
});

describe('Pathfinder Trap on a clipping group', () => {
  it('traps where the shown colors meet and keeps the clipping path clipping', async () => {
    const a = filled(0, 0, 100, 100, '#ffff00');
    const b = filled(100, 0, 100, 100, '#000000');
    const mask = rect(50, 0, 100, 50);
    const clip = clipOf([a, b], mask);
    const { doc, editor, app, layer } = setup([clip]);
    app.prefs = { get: () => undefined, set: () => {} };
    app.dialogs = { form: async () => ({ thickness: 2, tint: 40, reverse: false }) };
    editor.select([clip[0].id]);
    expect(await trapCommand(app)).toBe(true);
    const g = doc.get(clip[0].id);
    expect(g.clip).toBe(true);
    expect(g.children.at(-1)).toBe(mask.id);
    // The traps go above the group, along the shown part of the edge only.
    const kids = doc.get(layer.id).children;
    expect(kids).toHaveLength(2);
    const traps = doc.get(kids[1]);
    expect(traps.name).toBe('Traps');
    const bb = nodeBounds(doc, traps);
    expect(bb.y + bb.h).toBeLessThanOrEqual(50 + 1e-3);
  });
});

describe('Make Compound Shape with a clipping path picked', () => {
  it('a clipping path moved into a compound shape outside its group does not hand the clip on', () => {
    const a = filled(0, 0, 100, 100, '#ff0000');
    const b = filled(0, 0, 20, 20, '#0000ff');
    const mask = rect(50, 50, 100, 100);
    const clip = clipOf([a, b], mask);
    const p = filled(140, 60, 100, 30, '#00ff00');
    const { doc, editor } = setup([clip, p]);
    editor.select([mask.id, p.id]);
    const id = makeCompoundShape(editor, 'unite');
    expect(doc.get(id).children).toEqual([mask.id, p.id]);
    const g = doc.get(clip[0].id);
    expect(g.children).toEqual([a.id, b.id]);
    expect(g.clip).toBe(false);
  });
});
