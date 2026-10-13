import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { makeImage } from './trace-helpers.js';
import { createPath, createImage, defaultLabel } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { liveDef, liveArtwork } from '../src/model/live.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { widgetAt } from '../src/tools/widgets.js';
import { MENUS } from '../src/ui/menus.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { writePDF } from '../src/features/io/pdf.js';
import { setPixelSource } from '../src/features/trace/trace-runner.js';
import { isEnvelope } from '../src/features/envelope/envelope-model.js';
import { isMockup, mockupParts, mockupCorners, lightingOf, editingArt } from '../src/features/mockup/mockup-model.js';
import { effectiveFit } from '../src/features/mockup/mockup-ui.js';
import { lightingRaster, lightingHooks, photoBelow } from '../src/features/mockup/lighting.js';
import { rectQuad } from '../src/features/mockup/perspective.js';

const solid = (color) => ({ type: 'solid', color });
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  setPixelSource(null);
  lightingHooks.pixels = null;
  lightingRaster.render = lightingRaster.render.original || lightingRaster.render;
});

async function setup() {
  const app = await bootAppWithFeatures();
  app.newDocument();
  const ed = app.editor;
  ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  const doc = ed.doc;
  doc.assets.set('photo', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' });
  const photo = createImage('photo', 400, 300, [1, 0, 0, 1, 50, 50]);
  const art = createPath(rectangle(150, 120, 100, 60), true, { fill: solid('#cc3333'), stroke: null, strokeWidth: 0 });
  doc.transact('Setup', () => {
    doc.insert(photo, ed.targetLayer().id);
    doc.insert(art, ed.targetLayer().id);
  });
  ed.select([photo.id, art.id]);
  app.setTool('selection');
  return { app, ed, doc, photo: photo.id, art: art.id };
}

const ev = (app, x, y, extra = {}) => {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
};

describe('Mockup commands', () => {
  it('lists Make, Release, Edit Art and Detect Surface under Object > Mockup', async () => {
    const { app } = await setup();
    const object = MENUS.find((m) => m.label === 'Object').submenu;
    const sub = object.find((m) => m.label === 'Mockup');
    expect(sub.submenu).toEqual(['mockup.make', 'mockup.release', 'mockup.edit', '-', 'mockup.detect']);
    // Placed between Paint Regions and Trace Image.
    const labels = object.map((m) => m.label).filter(Boolean);
    expect(labels.indexOf('Mockup')).toBe(labels.indexOf('Paint Regions') + 1);
    expect(labels.indexOf('Trace Image')).toBe(labels.indexOf('Mockup') + 1);
    for (const id of sub.submenu.filter((x) => x !== '-')) expect(app.commands.get(id), id).toBeTruthy();
    expect(app.commands.isEnabled('mockup.make')).toBe(true);
    expect(app.commands.isEnabled('mockup.release')).toBe(false);
  });

  it('needs a photo and some art', async () => {
    const { app, ed, art } = await setup();
    ed.select([art]);
    expect(app.commands.isEnabled('mockup.make')).toBe(false);
  });

  it('Make puts the art on the photo as a live mockup in one undo step', async () => {
    const { app, ed, doc, photo, art } = await setup();
    const before = doc.undoStack.length;
    app.commands.run('mockup.make');
    const m = doc.get(ed.topSelection()[0]);
    expect(isMockup(m)).toBe(true);
    expect(liveDef(m).label).toBe('<Mockup>');
    expect(defaultLabel(m)).toBe('<Mockup>');
    const parts = mockupParts(doc, m);
    expect(parts.photo.id).toBe(photo);
    expect(isEnvelope(parts.art)).toBe(true);
    expect(parts.art.children).toEqual([art]);
    // The art starts over its own bounds, so nothing jumps.
    expect(mockupCorners(doc, m)).toEqual(rectQuad({ x: 150, y: 120, w: 100, h: 60 }));
    expect(lightingOf(parts.art)).toMatchObject({ type: 'mockupLighting', strength: 0.6 });
    expect(effectiveFit(doc, m)).toBe('perspective');
    expect(doc.undoStack.length).toBe(before + 1);
    doc.undo();
    expect(doc.get(art).parent).toBe(ed.targetLayer().id);
    expect(doc.get(photo).parent).toBe(ed.targetLayer().id);
  });

  it('dragging a corner handle fits the art in perspective, one undo step, Escape-safe', async () => {
    const { app, ed, doc } = await setup();
    app.commands.run('mockup.make');
    const m = doc.get(ed.topSelection()[0]);
    const h = widgetAt(ed, ev(app, 250, 180));
    expect(h?.id).toBe('mockup:corner2');
    const before = doc.undoStack.length;
    const d = h.begin(ev(app, 250, 180));
    d.move(ev(app, 280, 220));
    d.end(ev(app, 280, 220));
    expect(doc.undoStack.length).toBe(before + 1);
    const q = mockupCorners(doc, doc.get(m.id));
    expect(q[2]).toEqual({ x: 280, y: 220 });
    expect(q[0]).toEqual({ x: 150, y: 120 });
    // The art's mesh is the finer perspective mesh now.
    const mesh = mockupParts(doc, doc.get(m.id)).art.live.mesh;
    expect(mesh.rows).toBeGreaterThan(1);
    expect(effectiveFit(doc, doc.get(m.id))).toBe('perspective');
    // A corner dragged across the others is refused (the surface would fold).
    const h2 = widgetAt(ed, ev(app, 150, 120));
    const d2 = h2.begin(ev(app, 150, 120));
    d2.move(ev(app, 400, 400));
    d2.cancel();
    expect(mockupCorners(doc, doc.get(m.id))[0]).toEqual({ x: 150, y: 120 });
  });

  it('the middle handle slides the art and moving the mockup carries everything', async () => {
    const { app, ed, doc, photo } = await setup();
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    const h = widgetAt(ed, ev(app, 200, 150));
    expect(h.id).toBe('mockup:move');
    const d = h.begin(ev(app, 200, 150));
    d.move(ev(app, 210, 160));
    d.end(ev(app, 210, 160));
    expect(mockupCorners(doc, doc.get(id))[0]).toEqual({ x: 160, y: 130 });
    doc.transact('Move', () => transformNodes(doc, [id], translate(100, 0)));
    expect(mockupCorners(doc, doc.get(id))[0].x).toBeCloseTo(260);
    expect(doc.get(photo).transform[4]).toBeCloseTo(150);
    expect(effectiveFit(doc, doc.get(id))).toBe('perspective');
  });

  it('Release returns the photo and the untouched art', async () => {
    const { app, ed, doc, photo, art } = await setup();
    const before = nodeBounds(doc, doc.get(art));
    app.commands.run('mockup.make');
    const h = widgetAt(ed, ev(app, 250, 180));
    const d = h.begin(ev(app, 250, 180));
    d.move(ev(app, 300, 250));
    d.end(ev(app, 300, 250));
    app.commands.run('mockup.release');
    expect(ed.topSelection()).toEqual([photo, art]);
    expect(doc.get(art).parent).toBe(ed.targetLayer().id);
    expect(nodeBounds(doc, doc.get(art))).toEqual(before);
    // No gray envelope shape is left behind.
    expect(ed.targetLayer().children).toEqual([photo, art]);
  });

  it('Expand leaves plain artwork with the lighting still reading the photo', async () => {
    const { app, ed, doc, photo } = await setup();
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    app.commands.run('object.expand');
    const g = doc.get(ed.topSelection()[0]);
    expect(isMockup(g)).toBe(false);
    expect(g.type).toBe('group');
    expect(g.children[0]).toBe(photo);
    const expandedArt = doc.get(g.children[1]);
    expect(isEnvelope(expandedArt)).toBe(false);
    expect(expandedArt.effects.some((e) => e.type === 'mockupLighting')).toBe(true);
    expect(photoBelow(doc, expandedArt).id).toBe(photo);
    expect(doc.has(id)).toBe(true);
  });

  it('Edit Art isolates the art for editing; leaving isolation finishes', async () => {
    const { app, ed, doc, art } = await setup();
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    expect(app.commands.get('mockup.edit').label(app)).toBe('Edit Art');
    app.commands.run('mockup.edit');
    const env = mockupParts(doc, doc.get(id)).art;
    expect(editingArt(doc, doc.get(id))).toBe(true);
    expect(ed.isolation).toBe(env.id);
    expect(ed.topSelection()).toEqual([art]);
    // While editing, there are no corner handles.
    expect(widgetAt(ed, ev(app, 250, 180))).toBeNull();
    app.commands.run('object.exitIsolation');
    expect(editingArt(doc, doc.get(id))).toBe(false);
    // Double-click edits again; the command finishes.
    ed.select([id]);
    const s = ed.view.toScreen(200, 150);
    app.tool.onDoubleClick({ x: 200, y: 150, sx: s.x, sy: s.y, shift: false, alt: false });
    expect(editingArt(doc, doc.get(id))).toBe(true);
    expect(app.commands.get('mockup.edit').label(app)).toBe('Finish Editing Art');
    app.commands.run('mockup.edit');
    expect(editingArt(doc, doc.get(id))).toBe(false);
    expect(ed.isolation).toBeNull();
  });

  it('Detect Surface snaps the corners to the flat region under the art', async () => {
    const { app, ed, doc } = await setup();
    // The photo (400 x 300 points at 50, 50) is 200 x 150 pixels; a light card sits at pixels 40..150 x 30..110.
    setPixelSource(() => makeImage(200, 150, (x, y) => (x >= 40 && x < 150 && y >= 30 && y < 110 ? [240, 240, 236] : [70, 60, 50])));
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    await app.commands.run('mockup.detect');
    const q = mockupCorners(doc, doc.get(id));
    const want = [
      { x: 130, y: 110 },
      { x: 350, y: 110 },
      { x: 350, y: 270 },
      { x: 130, y: 270 },
    ];
    q.forEach((p, k) => expect(Math.hypot(p.x - want[k].x, p.y - want[k].y)).toBeLessThan(6));
  });

  it('switching to the mesh fit keeps the shape for bending; perspective returns to the corners', async () => {
    const { app, ed, doc } = await setup();
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    app.openPanel('mockup');
    await flush();
    const panel = app.panels?.get?.('mockup') || [...document.querySelectorAll('.panel-mockup')][0];
    expect(panel).toBeTruthy();
    const body = document.querySelector('.panel-mockup');
    const meshBtn = [...body.querySelectorAll('.mockup-fit button')].find((b) => b.textContent === 'Mesh');
    meshBtn.click();
    let m = doc.get(id);
    expect(m.live.fit).toBe('mesh');
    expect(mockupParts(doc, m).art.live.mesh.rows).toBe(4);
    // Direct Selection edits now: the corners stay put.
    expect(widgetAt(ed, ev(app, 250, 180))).toBeNull();
    const persp = [...body.querySelectorAll('.mockup-fit button')].find((b) => b.textContent === 'Perspective');
    persp.click();
    m = doc.get(id);
    expect(effectiveFit(doc, m)).toBe('perspective');
    expect(mockupCorners(doc, m)).toEqual(rectQuad({ x: 150, y: 120, w: 100, h: 60 }));
  });

  it('the panel edits lighting, opacity and blending as undoable steps', async () => {
    const { app, ed, doc } = await setup();
    app.openPanel('mockup');
    await flush();
    const body = document.querySelector('.panel-mockup');
    // Before a mockup exists the panel offers to make one.
    const make = [...body.querySelectorAll('button')].find((b) => b.textContent.includes('Make Mockup'));
    expect(make.disabled).toBe(false);
    make.click();
    const id = ed.topSelection()[0];
    app.dock?.refresh?.();
    await flush();
    const field = (label) => body.querySelector(`input[aria-label="${label}"]`);
    const commit = (input, v) => {
      input.value = v;
      input.dispatchEvent(new Event('blur'));
    };
    commit(field('Strength'), '80%');
    expect(lightingOf(mockupParts(doc, doc.get(id)).art).strength).toBeCloseTo(0.8);
    commit(field('Texture displacement'), '4 pt');
    expect(lightingOf(mockupParts(doc, doc.get(id)).art).displace).toBeCloseTo(4);
    commit(field('Opacity'), '50%');
    expect(mockupParts(doc, doc.get(id)).art.opacity).toBeCloseTo(0.5);
    const blend = body.querySelector('select[aria-label="Blending mode"]');
    blend.value = 'multiply';
    blend.dispatchEvent(new Event('change'));
    expect(mockupParts(doc, doc.get(id)).art.blendMode).toBe('multiply');
    const check = body.querySelector('.mockup-check input');
    check.checked = false;
    check.dispatchEvent(new Event('change'));
    expect(lightingOf(mockupParts(doc, doc.get(id)).art).hidden).toBe(true);
    doc.undo();
    expect(lightingOf(mockupParts(doc, doc.get(id)).art).hidden).toBeFalsy();
    // Corner fields move a corner.
    commit(field('Top left corner X'), '140 pt');
    expect(mockupCorners(doc, doc.get(id))[0].x).toBeCloseTo(140);
  });

  it('exports lit art to SVG as an image over the photo and to PDF', async () => {
    const { app, ed, doc } = await setup();
    app.commands.run('mockup.make');
    const original = lightingRaster.render;
    const calls = [];
    lightingRaster.render = Object.assign((d, node, rect, k) => {
      calls.push({ node, rect, k });
      return 'data:image/png;base64,AAAA';
    }, { original });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(calls.length).toBe(1);
    expect(calls[0].rect.x).toBeCloseTo(150, 0);
    expect(svg).toContain('xlink:href="data:image/png;base64,AAAA"');
    // The photo is written as an image too, below the art.
    expect(svg.indexOf('iVBORw0KGgo=')).toBeGreaterThan(-1);
    expect(svg.indexOf('iVBORw0KGgo=')).toBeLessThan(svg.indexOf('AAAA'));
    // Without lighting the art stays vector.
    app.openPanel('mockup');
    const id = ed.topSelection()[0];
    doc.transact('off', () => {
      const art = mockupParts(doc, doc.get(id)).art;
      doc.update(art.id, { effects: [] });
    });
    const plain = exportSVG(doc, { rect: { x: 0, y: 0, w: 612, h: 792 } });
    expect(plain).toMatch(/<path[^>]*fill="#cc3333"/);
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    expect(new TextDecoder('latin1').decode(bytes).startsWith('%PDF')).toBe(true);
  });

  it('the lighting effect reads the photo through the live artwork', async () => {
    const { app, ed, doc } = await setup();
    app.commands.run('mockup.make');
    const id = ed.topSelection()[0];
    const { items } = liveArtwork(doc, doc.get(id));
    expect(items.map((n) => n.type)).toEqual(['image', 'group']);
    expect(photoBelow(doc, items[1]).asset).toBe('photo');
  });
});
