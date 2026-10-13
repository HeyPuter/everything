import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { liveArtwork, isLive } from '../src/model/live.js';
import { nodeBounds, visualBounds, transformNodes } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { drawArtwork } from '../src/render/draw.js';
import { expandNodeAppearance } from '../src/ops/expand-appearance.js';
import { translate, scale } from '../src/lib/matrix.js';
import { stackItems, normalizeAppearance, isBasicStack, itemPaint, stackPaints, mapStackPaints, hasAppearanceStack, layerAppearanceArtwork } from '../src/model/appearance.js';

beforeAll(() => installCanvasStub());

const solid = (color) => ({ type: 'solid', color });
const red = solid('#ff0000');
const blue = solid('#0000ff');
const green = solid('#00ff00');

/** A document with a rectangle 10,10 20x20 carrying `style`. */
function setup(style = {}, extra = {}) {
  const doc = VDocument.create({ width: 400, height: 200 });
  const layer = doc.layers()[0].id;
  const r = createPath(rectangle(10, 10, 20, 20), true, { fill: red, stroke: blue, strokeWidth: 2, ...style }, extra);
  doc.transact('make', () => doc.insert(r, layer));
  return { doc, id: r.id, layer };
}

/** Two strokes (a wide green one under the base stroke) and the base fill. */
const TWO_STROKES = [{ type: 'stroke', stroke: green, strokeWidth: 10, strokeJoin: 'round' }, { type: 'fill', base: true }, { type: 'stroke', base: true }];

describe('appearance stacks: model', () => {
  it('fills in the implicit base items', () => {
    const { doc, id } = setup();
    const n = doc.get(id);
    expect(hasAppearanceStack(n)).toBe(false);
    expect(stackItems(n)).toEqual([{ type: 'fill', base: true }, { type: 'stroke', base: true }]);
    expect(stackItems(createGroup([]))).toEqual([{ type: 'contents' }]);
    expect(stackItems(createText('Hi', 0, 0))).toEqual([{ type: 'contents' }]);
    // A stored stack that lost its base stroke gets it back above the last fill.
    const lost = { ...n, appearance: [{ type: 'fill', base: true }, { type: 'fill', fill: green }] };
    expect(stackItems(lost).map((it) => (it.base ? `base-${it.type}` : it.type))).toEqual(['base-fill', 'fill', 'base-stroke']);
    expect(itemPaint(n, { type: 'stroke', base: true })).toEqual(blue);
  });

  it('stores basic stacks as no stack at all', () => {
    const { doc, id } = setup();
    const n = doc.get(id);
    expect(normalizeAppearance(n, stackItems(n))).toEqual({ appearance: undefined });
    expect(isBasicStack(n, [{ type: 'fill', base: true, opacity: 1, blendMode: 'normal', effects: [] }, { type: 'stroke', base: true }])).toBe(true);
    // Stroke below fill, item opacity or a hidden item is not basic.
    expect(normalizeAppearance(n, [{ type: 'stroke', base: true }, { type: 'fill', base: true }]).appearance).toHaveLength(2);
    expect(normalizeAppearance(n, [{ type: 'fill', base: true, opacity: 0.5 }, { type: 'stroke', base: true }]).appearance[0]).toEqual({ type: 'fill', base: true, opacity: 0.5 });
    // Base items never store paint of their own.
    expect(normalizeAppearance(n, [{ type: 'fill', base: true, fill: green, hidden: true }, { type: 'stroke', base: true }]).appearance[0]).toEqual({ type: 'fill', base: true, hidden: true });
  });

  it('draws one virtual copy per fill and stroke, in paint order', () => {
    const { doc, id } = setup({ appearance: TWO_STROKES });
    const n = doc.get(id);
    expect(isLive(n)).toBe(true);
    const { items } = liveArtwork(doc, n);
    expect(items.map((v) => [v.fill?.color ?? null, v.stroke?.color ?? null, v.stroke ? v.strokeWidth : 0])).toEqual([
      [null, '#00ff00', 10],
      ['#ff0000', null, 0],
      [null, '#0000ff', 2],
    ]);
    expect(items[0].strokeJoin).toBe('round');
    expect(items.every((v) => v.source === id && !v.appearance)).toBe(true);
    // The selection box stays on the geometry; the visual bounds reach the wide stroke.
    expect(nodeBounds(doc, n)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    const vb = visualBounds(doc, n);
    expect(vb.x).toBeLessThanOrEqual(5);
    expect(vb.w).toBeGreaterThanOrEqual(30);
    // Rendering goes through the stack without errors.
    const canvas = document.createElement('canvas');
    expect(() => drawArtwork(canvas.getContext('2d'), doc, { scale: 1, hairline: 1 })).not.toThrow();
  });

  it('hit tests every item: the wide stroke under the fill is clickable', () => {
    const { doc, id } = setup({ appearance: TWO_STROKES });
    expect(hitTest(doc, 7, 20, 0.5)?.id).toBe(id);
    const plain = setup();
    expect(hitTest(plain.doc, 7, 20, 0.5)).toBe(null);
  });

  it('skips hidden items and items without paint', () => {
    const { doc, id } = setup({ appearance: [{ type: 'fill', base: true, hidden: true }, { type: 'stroke', base: true }, { type: 'fill', fill: null }] });
    const { items } = liveArtwork(doc, doc.get(id));
    expect(items).toHaveLength(1);
    expect(items[0].stroke).toEqual(blue);
  });

  it('gives each item its own opacity, blending and effects, and the object its geometry effects', () => {
    const appearance = [{ type: 'fill', base: true, opacity: 0.5, blendMode: 'multiply', effects: [{ type: 'roundCorners', radius: 3 }] }, { type: 'stroke', base: true }];
    const { doc, id } = setup({ appearance, effects: [{ type: 'dropShadow', x: 2, y: 2, blur: 1, opacity: 0.5, color: '#000000' }, { type: 'roundCorners', radius: 1 }] });
    const [fill, stroke] = liveArtwork(doc, doc.get(id)).items;
    expect(fill.opacity).toBe(0.5);
    expect(fill.blendMode).toBe('multiply');
    // The item's own effect first, then the object's geometry effects (raster effects stay on the object).
    expect(fill.effects.map((e) => `${e.type}:${e.radius}`)).toEqual(['roundCorners:3', 'roundCorners:1']);
    expect(stroke.effects.map((e) => e.type)).toEqual(['roundCorners']);
    // Object-level geometry effects are framed by the object's own bounds.
    expect(stroke.effects[0].frame).toEqual({ x: 10, y: 10, w: 20, h: 20 });
  });

  it('expands into one path per fill and stroke', () => {
    const { doc, id, layer } = setup({ appearance: TWO_STROKES, opacity: 0.8 });
    let out;
    doc.transact('Expand Appearance', () => {
      out = expandNodeAppearance(doc, id);
    });
    const g = doc.get(out);
    expect(g.type).toBe('group');
    expect(g.opacity).toBe(0.8);
    expect(g.parent).toBe(layer);
    const kids = g.children.map((c) => doc.get(c));
    expect(kids.map((k) => k.type)).toEqual(['path', 'path', 'path']);
    expect(kids.map((k) => [k.fill?.color ?? null, k.stroke?.color ?? null])).toEqual([
      [null, '#00ff00'],
      ['#ff0000', null],
      [null, '#0000ff'],
    ]);
    expect(kids.some((k) => k.appearance)).toBe(false);
  });

  it('moves gradient paints and scales stroke weights of extra items with the object', () => {
    const grad = { type: 'linear', angle: 0, x1: 10, y1: 20, x2: 30, y2: 20, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };
    const { doc, id } = setup({ appearance: [{ type: 'fill', base: true }, { type: 'fill', fill: grad }, { type: 'stroke', base: true }, { type: 'stroke', stroke: green, strokeWidth: 4 }] });
    doc.transact('Move', () => transformNodes(doc, [id], translate(5, 7)));
    let st = doc.get(id).appearance;
    expect([st[1].fill.x1, st[1].fill.y1, st[1].fill.x2]).toEqual([15, 27, 35]);
    expect(st[3].strokeWidth).toBe(4);
    doc.transact('Scale', () => transformNodes(doc, [id], scale(2, 2), { scaleStrokes: true }));
    st = doc.get(id).appearance;
    expect(st[3].strokeWidth).toBeCloseTo(8);
    expect(st[1].fill.x1).toBeCloseTo(30);
  });

  it('lists and maps the paints of extra items', () => {
    const { doc, id } = setup({ appearance: TWO_STROKES });
    const n = doc.get(id);
    expect(stackPaints(n)).toEqual([green]);
    const next = mapStackPaints(n, (p) => ({ ...p, color: '#123456' }));
    expect(next[0].stroke.color).toBe('#123456');
    expect(next[1]).toBe(n.appearance[1]);
    expect(mapStackPaints(n, (p) => p)).toBe(null);
  });

  it('survives save and load', () => {
    const { doc, id } = setup({ appearance: TWO_STROKES });
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.get(id).appearance).toEqual(TWO_STROKES);
    expect(liveArtwork(copy, copy.get(id)).items).toHaveLength(3);
    // Documents without stacks load unchanged.
    const plain = setup();
    const back = VDocument.fromJSON(JSON.parse(JSON.stringify(plain.doc.toJSON())));
    expect('appearance' in back.get(plain.id)).toBe(false);
  });
});

describe('appearance stacks: containers and type', () => {
  it('paints a group fill under its contents, over every shape inside', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0].id;
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: red, stroke: null });
    const b = createPath(rectangle(20, 0, 10, 10), true, { fill: red, stroke: null });
    const g = createGroup([a.id, b.id], { appearance: [{ type: 'stroke', stroke: green, strokeWidth: 6 }, { type: 'contents' }] });
    doc.transact('make', () => doc.insert(g, layer, Infinity, [a, b]));
    doc.repairParents();
    const { items, vdoc } = liveArtwork(doc, doc.get(g.id));
    expect(items).toHaveLength(3);
    const [stroke, ...kids] = items;
    expect(kids.map((k) => k.id)).toEqual([a.id, b.id]);
    expect(stroke.type).toBe('group');
    const copies = stroke.children.map((c) => vdoc.get(c));
    expect(copies.map((c) => [c.source, c.stroke.color, c.strokeWidth, c.fill])).toEqual([
      [a.id, '#00ff00', 6, null],
      [b.id, '#00ff00', 6, null],
    ]);
    // Clicking a child still finds that child; clicking the group stroke finds the shape it came from.
    expect(hitTest(doc, 5, 5, 0.5)?.id).toBe(a.id);
    expect(hitTest(doc, -2, 5, 0.5)?.id).toBe(a.id);
    expect(nodeBounds(doc, doc.get(g.id))).toEqual({ x: 0, y: 0, w: 30, h: 10 });
    expect(visualBounds(doc, doc.get(g.id)).x).toBeLessThan(-2);
  });

  it('keeps clipping in a clip group contents item', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0].id;
    const a = createPath(rectangle(0, 0, 40, 40), true, { fill: red, stroke: null });
    const m = createPath(rectangle(0, 0, 10, 10), true, { fill: null, stroke: null });
    const g = createGroup([a.id, m.id], { clip: true, appearance: [{ type: 'contents' }, { type: 'fill', fill: green, opacity: 0.5 }] });
    doc.transact('make', () => doc.insert(g, layer, Infinity, [a, m]));
    doc.repairParents();
    const { items } = liveArtwork(doc, doc.get(g.id));
    expect(items[0].clip).toBe(true);
    expect(items[0].children).toEqual([a.id, m.id]);
    expect(items[1].clip).toBe(true);
    expect(items[1].opacity).toBe(0.5);
  });

  it('paints type items over every character alike', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0].id;
    const t = createText('Hello', 10, 50, { runs: [{ len: 2, fill: red }, { len: 3 }], appearance: [{ type: 'stroke', stroke: green, strokeWidth: 3 }, { type: 'contents' }] });
    doc.transact('make', () => doc.insert(t, layer));
    const { items } = liveArtwork(doc, doc.get(t.id));
    expect(items).toHaveLength(2);
    expect(items[0].stroke).toEqual(green);
    expect(items[0].fill).toBe(null);
    expect(items[0].runs.every((r) => !('fill' in r))).toBe(true);
    // The characters keep their own paint.
    expect(items[1].runs[0].fill).toEqual(red);
  });

  it('draws a layer stack around the layer contents', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0];
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: red, stroke: null });
    doc.transact('make', () => {
      doc.insert(a, layer.id);
      doc.update(layer.id, { appearance: [{ type: 'contents' }, { type: 'stroke', stroke: green, strokeWidth: 2 }] });
    });
    const art = layerAppearanceArtwork(doc, doc.get(layer.id));
    expect(art.items.map((n) => n.id)[0]).toBe(a.id);
    expect(art.items[1].children).toHaveLength(1);
    expect(layerAppearanceArtwork(doc, doc.get(layer.id))).toBe(art);
    const canvas = document.createElement('canvas');
    expect(() => drawArtwork(canvas.getContext('2d'), doc, { scale: 1, hairline: 1 })).not.toThrow();
  });
});
