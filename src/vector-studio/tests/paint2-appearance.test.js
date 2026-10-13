import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { paintSetup } from './panels-paint-helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { hitTest } from '../src/render/hit.js';
import { liveArtwork } from '../src/model/live.js';
import { expandNodeAppearance } from '../src/ops/expand-appearance.js';
import { writePDF } from '../src/features/io/pdf.js';
import { installFreeform } from '../src/features/paint/freeform.js';
import { TransformSession } from '../src/tools/transform-session.js';
import { enterMaskEditing, makeOpacityMask } from '../src/features/paint/opacity-mask.js';
import { translate } from '../src/lib/matrix.js';

beforeAll(() => {
  installCanvasStub();
  installFreeform();
});

const solid = (color) => ({ type: 'solid', color });
const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');
const FF = { type: 'freeform', points: [{ x: 0, y: 0.5, color: '#ff0000' }, { x: 1, y: 0.5, color: '#0000ff' }, { x: 0.5, y: 1, color: '#00ff00' }] };

function docWith(...nodes) {
  const doc = VDocument.create({ width: 200, height: 200 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => nodes.forEach((n) => doc.insert(n, layer)));
  return doc;
}

describe('layer appearance stacks', () => {
  it('a click on a layer stroke picks the object it outlines', () => {
    const rect = createPath(rectangle(50, 50, 40, 40), true, { fill: solid('#ff0000'), stroke: null, strokeWidth: 0 });
    const doc = docWith(rect);
    const layer = doc.layers()[0];
    doc.transact('stroke the layer', () => doc.update(layer.id, { appearance: [{ type: 'contents' }, { type: 'stroke', stroke: solid('#000000'), strokeWidth: 20 }] }));
    // Inside the object: the object itself.
    expect(hitTest(doc, 70, 70, 1)?.id).toBe(rect.id);
    // 6 units outside its edge, on the layer's 20-unit stroke: still the object.
    expect(hitTest(doc, 44, 70, 1)?.id).toBe(rect.id);
    // Beyond the stroke: nothing.
    expect(hitTest(doc, 30, 70, 1)).toBe(null);
    // Hidden items and locked objects are not clickable.
    doc.transact('lock', () => doc.update(rect.id, { locked: true }));
    expect(hitTest(doc, 44, 70, 1)).toBe(null);
  });
});

describe('knockout groups with their own stacks', () => {
  it('knock out within the contents and paint the group items over them', () => {
    const a = createPath(rectangle(0, 0, 40, 40), true, { fill: solid('#ff0000'), opacity: 0.5 });
    const b = createPath(rectangle(20, 20, 40, 40), true, { fill: solid('#0000ff'), opacity: 0.5 });
    const g = createGroup([], { knockout: true });
    const doc = docWith(g);
    doc.transact('fill', () => {
      doc.insert(a, g.id);
      doc.insert(b, g.id);
      doc.update(g.id, { appearance: [{ type: 'contents' }, { type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 3 }] });
    });
    const { items } = liveArtwork(doc, doc.get(g.id));
    const contents = items[0];
    expect(contents.knockout).toBe(true);
    expect(contents.children).toEqual([a.id, b.id]);
    expect(items[1].appearanceItem).toBe('stroke');
    // Expanding keeps the knockout on the contents, not around the stroke.
    let id = null;
    doc.transact('expand', () => (id = expandNodeAppearance(doc, g.id)));
    const root = doc.get(id);
    expect(root.knockout).toBeUndefined();
    const inner = doc.get(root.children[0]);
    expect(inner.knockout).toBe(true);
    expect(inner.children.map((c) => doc.get(c).fill.color)).toEqual(['#ff0000', '#0000ff']);
  });
});

describe('opacity masks edited in place', () => {
  it('large drags of mask art write geometry live (no bitmap preview)', async () => {
    const { ed, doc } = await paintSetup();
    const layer = ed.targetLayer().id;
    const target = createPath(rectangle(0, 0, 100, 100), true, { fill: solid('#ff0000') });
    const masks = Array.from({ length: 420 }, (_, i) => createPath(rectangle(i % 20, Math.floor(i / 20), 2, 2), true, { fill: solid('#ffffff') }));
    const mg = createGroup([]);
    doc.transact('build', () => {
      doc.insert(target, layer);
      doc.insert(mg, layer);
      masks.forEach((m) => doc.insert(m, mg.id));
    });
    ed.select([target.id, mg.id]);
    const owner = makeOpacityMask(ed);
    enterMaskEditing(ed, owner);
    const group = doc.get(ed.isolation);
    ed.select(group.children);
    const s = new TransformSession(ed, 'Move');
    s.apply(translate(5, 0));
    // The art moved in the document right away, so the mask redraws as it moves.
    expect(ed.dragPreview).toBeFalsy();
    s.commit();
  });
});

describe('PDF: freeform gradients on strokes and type', () => {
  it('paints a freeform stroke with a pattern of the blend', async () => {
    const node = createPath(rectangle(20, 20, 100, 40), true, { fill: null, stroke: FF, strokeWidth: 6 });
    const { bytes } = await writePDF(docWith(node), [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/Pattern CS \/P\d+ SCN\n/);
    expect(s).toMatch(/\/PatternType 1 \/PaintType 1 \/TilingType 1 \/BBox \[0 0 1 1\]/);
    expect(s).toMatch(/\/Im1 Do/);
  });

  it('fills and strokes type with the blend', async () => {
    const t = createText('Freeform', 20, 60, { fill: FF, stroke: { ...FF }, strokeWidth: 1 });
    t.char = { ...t.char, fontSize: 24 };
    const { bytes } = await writePDF(docWith(t), [{ x: 0, y: 0, w: 200, h: 200 }], { compress: false });
    const s = latin1(bytes);
    expect(s).toMatch(/\/Pattern cs \/P\d+ scn\n/);
    expect(s).toMatch(/\/Pattern CS \/P\d+ SCN\n/);
  });
});

describe('graphic styles on type: Override Character Color', () => {
  const style = { fill: solid('#00ff00'), stroke: solid('#0000ff'), strokeWidth: 3, opacity: 0.8, blendMode: 'normal', effects: [] };

  it('replaces the character colors by default', async () => {
    const { app, ed, doc, panel, menuItem } = await paintSetup();
    const t = createText('Hello', 10, 40, { fill: solid('#ff0000'), runs: [{ len: 2, fill: solid('#123456') }, { len: 3 }] });
    doc.transact('t', () => doc.insert(t, ed.targetLayer().id));
    ed.select([t.id]);
    const p = panel('graphicStyles');
    expect(menuItem(p, 'Override Character Color').checked).toBe(true);
    const { applyGraphicStyle } = await import('../src/features/paint/graphic-styles.js');
    applyGraphicStyle(ed, style, null);
    const n = doc.get(t.id);
    expect(n.fill).toEqual(solid('#00ff00'));
    expect(n.runs?.some((r) => 'fill' in r)).toBeFalsy();
    expect(app.prefs.get('graphicStylesOverrideCharColor')).not.toBe(false);
  });

  it('keeps them with the option off: the style paints under the characters', async () => {
    const { ed, doc, panel, menuItem } = await paintSetup();
    const t = createText('Hello', 10, 40, { fill: solid('#ff0000'), runs: [{ len: 2, fill: solid('#123456') }, { len: 3 }] });
    doc.transact('t', () => doc.insert(t, ed.targetLayer().id));
    ed.select([t.id]);
    const p = panel('graphicStyles');
    menuItem(p, 'Override Character Color').run();
    expect(menuItem(p, 'Override Character Color').checked).toBe(false);
    const { applyGraphicStyle } = await import('../src/features/paint/graphic-styles.js');
    applyGraphicStyle(ed, style, null);
    const n = doc.get(t.id);
    expect(n.fill).toEqual(solid('#ff0000'));
    expect(n.runs[0].fill).toEqual(solid('#123456'));
    expect(n.opacity).toBe(0.8);
    expect(n.appearance.map((it) => it.type)).toEqual(['fill', 'stroke', 'contents']);
    expect(n.appearance[0].fill).toEqual(solid('#00ff00'));
    expect(n.appearance[1]).toMatchObject({ stroke: solid('#0000ff'), strokeWidth: 3 });
    doc.undo();
    expect(doc.get(t.id).appearance).toBeUndefined();
  });
});
