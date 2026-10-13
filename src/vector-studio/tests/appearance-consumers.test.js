import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource } from '../src/features/geometry/engine/index.js';
import { paintSetup } from './panels-paint-helpers.js';
import { createGroup, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { stackItems, itemPaint } from '../src/model/appearance.js';
import { graphicStylesOf, styleOfNode, applyGraphicStyle, linkedStyle } from '../src/features/paint/graphic-styles.js';
import { addSwatch, updateSwatch, swatchUsage, unusedSwatchIds } from '../src/features/paint/swatch-model.js';
import { colorTargets, colorPatches, collectColors, invertColor } from '../src/features/paint/edit-colors.js';
import { selectSame } from '../src/ops/select-ops.js';
import { selectSameAppearanceAttribute } from '../src/features/panels/select-commands.js';
import { outlineStroke } from '../src/features/geometry/path-ops.js';
import { newPathStyle } from '../src/tools/pen.js';
import { pickStyle } from '../src/model/nodes.js';
import { liveArtwork, liveDef } from '../src/model/live.js';
import { applyBrush, selectionBrush } from '../src/features/brushes/brush-ops.js';
import { docBrushes } from '../src/features/brushes/brush-model.js';
import { applyProfile, selectionProfile } from '../src/features/brushes/profiles-ui.js';
import { WIDTH_PROFILES } from '../src/features/brushes/width-profile.js';

beforeAll(() => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
});

const solid = (color) => ({ type: 'solid', color });
const STACK = [{ type: 'fill', base: true }, { type: 'stroke', base: true }, { type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 6 }];
const kinds = (n) => stackItems(n).map((it) => (it.base ? `${it.type}*` : it.type));

describe('stacks in graphic styles, the Eyedropper and new art', () => {
  it('saves a stack in a graphic style, applies it and keeps the link', async () => {
    const { ed, add, panel } = await paintSetup();
    const src = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), appearance: STACK });
    const dst = add({ fill: solid('#ffffff') }, [20, 0, 10, 10]);
    const style = styleOfNode(ed.doc, ed.doc.get(src));
    expect(style.appearance).toEqual(STACK);
    ed.select([dst]);
    applyGraphicStyle(ed, style, 'gs-test');
    expect(kinds(ed.doc.get(dst))).toEqual(['fill*', 'stroke*', 'stroke']);
    // A style without extra items clears them.
    const plain = graphicStylesOf(ed.doc).find((g) => g.id === 'gs-default');
    applyGraphicStyle(ed, plain.style, plain.id);
    expect(ed.doc.get(dst).appearance).toBeUndefined();
    expect(linkedStyle(ed.doc, ed.doc.get(dst))?.id).toBe('gs-default');
    // An object with a stack does not match a style without one.
    ed.doc.transact('x', () => ed.doc.update(dst, { appearance: STACK }));
    expect(linkedStyle(ed.doc, ed.doc.get(dst))).toBe(null);
    // Thumbnails draw stacks.
    const gp = panel('graphicStyles');
    expect(gp.el).toBeTruthy();
  });

  it('keeps a group style on the group', async () => {
    const { ed, doc } = await paintSetup();
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') });
    const g = createGroup([a.id], { appearance: [{ type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 3 }, { type: 'contents' }] });
    const b = createPath(rectangle(0, 20, 10, 10), true, { fill: solid('#ff0000') });
    const g2 = createGroup([b.id]);
    doc.transact('add', () => {
      doc.insert(g, ed.targetLayer().id, Infinity, [a]);
      doc.insert(g2, ed.targetLayer().id, Infinity, [b]);
    });
    doc.repairParents();
    const style = styleOfNode(doc, doc.get(g.id));
    ed.select([g2.id]);
    applyGraphicStyle(ed, style);
    expect(kinds(doc.get(g2.id))).toEqual(['stroke', 'contents']);
    expect(doc.get(b.id).appearance).toBeUndefined();
  });

  it('picks up and applies stacks with the Eyedropper', async () => {
    const { app, ed, add } = await paintSetup();
    const src = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), appearance: STACK });
    const dst = add({ fill: solid('#ffffff') }, [40, 0, 10, 10]);
    const plain = add({ fill: solid('#00ffff') }, [80, 0, 10, 10]);
    ed.select([dst]);
    app.setTool('eyedropper');
    const tool = app.tool;
    tool.onPointerDown({ x: 5, y: 5, alt: false });
    expect(kinds(ed.doc.get(dst))).toEqual(['fill*', 'stroke*', 'stroke']);
    expect(ed.style.appearance).toEqual(STACK);
    // Picking a plain object clears the stack.
    tool.onPointerDown({ x: 85, y: 5, alt: false });
    expect(ed.doc.get(dst).appearance).toBeUndefined();
    expect(ed.doc.get(dst).fill).toEqual(solid('#00ffff'));
    expect(ed.doc.get(plain).appearance).toBeUndefined();
  });

  it('leaves extra fills and strokes out of basic new art', async () => {
    const { app, ed } = await paintSetup();
    ed.setStyle({ appearance: STACK });
    expect(pickStyle(ed.style).appearance).toEqual(STACK);
    expect(newPathStyle(ed).appearance).toBeUndefined();
    app.prefs.set('newArtBasic', false);
    expect(newPathStyle(ed).appearance).toEqual(STACK);
  });
});

describe('stacks in swatches, recoloring and Select Same', () => {
  it('updates global swatch colors in extra items and counts their use', async () => {
    const { ed, add } = await paintSetup();
    const doc = ed.doc;
    doc.transact('sw', () => addSwatch(doc, { id: 'sw-x', name: 'Brand', paint: solid('#123456'), global: true }));
    const linked = { type: 'solid', color: '#123456', swatchId: 'sw-x' };
    const id = add({ fill: solid('#ffffff'), appearance: [{ type: 'fill', base: true }, { type: 'stroke', base: true }, { type: 'stroke', stroke: linked, strokeWidth: 2 }] });
    expect(swatchUsage(doc, 'sw-x')).toBe(1);
    expect(unusedSwatchIds(doc)).not.toContain('sw-x');
    doc.transact('edit', () => updateSwatch(doc, 'sw-x', { paint: solid('#abcdef') }));
    expect(stackItems(doc.get(id))[2].stroke).toMatchObject({ color: '#abcdef', swatchId: 'sw-x' });
  });

  it('recolors extra items with the rest of the artwork', async () => {
    const { ed, add, doc } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: null, appearance: [{ type: 'fill', base: true }, { type: 'stroke', base: true }, { type: 'fill', fill: solid('#00ff00'), opacity: 0.5 }] });
    const a = createPath(rectangle(40, 0, 10, 10), true, { fill: solid('#ff0000') });
    const g = createGroup([a.id], { appearance: [{ type: 'contents' }, { type: 'stroke', stroke: solid('#0000ff'), strokeWidth: 2 }] });
    doc.transact('add', () => doc.insert(g, ed.targetLayer().id, Infinity, [a]));
    doc.repairParents();
    const nodes = colorTargets(doc, [id, g.id]);
    expect(nodes.map((n) => n.id)).toContain(g.id);
    const colors = collectColors(nodes).map((c) => c.color);
    expect(colors).toEqual(expect.arrayContaining(['#ff0000', '#00ff00', '#0000ff']));
    const patches = colorPatches(nodes, invertColor);
    doc.transact('Invert', () => {
      for (const [nid, p] of patches) doc.update(nid, p);
    });
    expect(itemPaint(doc.get(id), stackItems(doc.get(id))[2]).color).toBe('#ff00ff');
    expect(stackItems(doc.get(g.id))[1].stroke.color).toBe('#ffff00');
    expect(doc.get(a.id).fill.color).toBe('#00ffff');
  });

  it('matches stacks in Select Same Appearance and their effects in Appearance Attribute', async () => {
    const { ed, add } = await paintSetup();
    const style = { fill: solid('#ff0000'), stroke: solid('#000000') };
    const withFx = [{ type: 'fill', base: true }, { type: 'stroke', base: true, effects: [{ type: 'roundCorners', radius: 2 }] }];
    const a = add({ ...style, appearance: STACK });
    const b = add({ ...style, appearance: STACK }, [20, 0, 10, 10]);
    const c = add({ ...style }, [40, 0, 10, 10]);
    const d = add({ ...style, appearance: withFx }, [60, 0, 10, 10]);
    ed.select([a]);
    selectSame(ed, 'appearance');
    expect([...ed.selection].sort()).toEqual([a, b].sort());
    ed.select([d]);
    expect(selectSameAppearanceAttribute(ed)).toEqual([d]);
    expect(c).toBeTruthy();
  });
});

describe('brushes and width profiles on one stroke', () => {
  it('puts a brush and a profile on the picked stroke only', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: null, stroke: solid('#0000ff'), strokeWidth: 2, appearance: STACK }, [0, 0, 100, 100]);
    ed.select([id]);
    const p = panel('appearance');
    p.pick('item:2');
    const brush = docBrushes(ed.doc)[0];
    expect(applyBrush(ed, brush.id)).toBe(true);
    let n = ed.doc.get(id);
    expect(n.brush).toBeUndefined();
    expect(stackItems(n)[2].brush.id).toBe(brush.id);
    expect(selectionBrush(ed)).toBe(brush.id);
    // The brushed stroke draws as brush artwork inside the stack.
    const item = liveArtwork(ed.doc, n).items.find((v) => v.brush);
    expect(liveDef(item).key).toBe('brush');
    applyProfile(ed, WIDTH_PROFILES.find((w) => w.id === 'lens').points);
    n = ed.doc.get(id);
    expect(stackItems(n)[2].widthProfile).toHaveLength(3);
    expect(n.widthProfile).toBeUndefined();
    expect(selectionProfile(ed)).toHaveLength(3);
  });
});

describe('Outline Stroke with several strokes', () => {
  it('outlines every stroke of the stack', async () => {
    const { app, ed, add, doc } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 2, appearance: STACK }, [0, 0, 100, 100]);
    ed.select([id]);
    expect(app.commands.get('path.outlineStroke').enabled(app)).toBe(true);
    await outlineStroke(app);
    expect(doc.get(id)).toBeUndefined();
    const leaves = doc.leaves().filter((n) => n.type !== 'path' || doc.get(n.parent)?.type !== 'compound');
    // The fill stays a fill; both strokes became filled outlines.
    expect(leaves.every((n) => !n.stroke)).toBe(true);
    const colors = leaves.map((n) => n.fill?.color).sort();
    expect(colors).toEqual(['#00ff00', '#0000ff', '#ff0000'].sort());
    expect(leaves.some((n) => n.appearance)).toBe(false);
  });
});
