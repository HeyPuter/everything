import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { luminanceToAlpha, maskedTargets, maskBounds } from '../src/features/paint/opacity-mask.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { drawArtwork } from '../src/render/draw.js';

const solid = (color) => ({ type: 'solid', color });

async function setup() {
  const s = await paintSetup();
  const a = s.add({ fill: solid('#ff0000') }, [0, 0, 100, 100]);
  const b = s.add({ fill: solid('#00ff00') }, [20, 20, 40, 40]);
  const m = s.add({ fill: solid('#ffffff') }, [10, 10, 50, 50]);
  return { ...s, a, b, m };
}

describe('Opacity masks', () => {
  it('makes a mask from the topmost object and releases it', async () => {
    const { app, ed, doc, a, m } = await setup();
    ed.select([a, m]);
    expect(app.commands.isEnabled('transparency.makeMask')).toBe(true);
    app.commands.run('transparency.makeMask');
    expect(doc.has(m)).toBe(false);
    const om = doc.get(a).opacityMask;
    expect(om.art.root).toBe(m);
    expect(om.clip).toBe(true);
    expect(om.invert).toBe(false);
    expect([...ed.selection]).toEqual([a]);
    expect(maskBounds(doc, om)).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    doc.undo();
    expect(doc.has(m)).toBe(true);
    expect(doc.get(a).opacityMask).toBeUndefined();
    doc.redo();
    ed.select([a]);
    app.commands.run('transparency.releaseMask');
    expect(doc.get(a).opacityMask).toBeUndefined();
    const layer = doc.get(doc.get(a).parent);
    const released = layer.children[layer.children.indexOf(a) + 1];
    expect(doc.get(released).fill).toEqual(solid('#ffffff'));
    expect(ed.selection.has(released)).toBe(true);
  });

  it('groups several objects under one mask and honors the new-mask preferences', async () => {
    const { app, ed, doc, a, b, m } = await setup();
    app.prefs.set('newMasksClip', false);
    app.prefs.set('newMasksInvert', true);
    ed.select([a, b, m]);
    app.commands.run('transparency.makeMask');
    const [gid] = [...ed.selection];
    const g = doc.get(gid);
    expect(g.type).toBe('group');
    expect(g.children).toEqual([a, b]);
    expect(g.opacityMask.clip).toBe(false);
    expect(g.opacityMask.invert).toBe(true);
  });

  it('moves a linked mask with its object, but not an unlinked one', async () => {
    const { app, ed, doc, a, m } = await setup();
    ed.select([a, m]);
    app.commands.run('transparency.makeMask');
    doc.transact('Move', () => transformNodes(doc, [a], translate(10, 5)));
    expect(doc.get(a).opacityMask.transform).toEqual([1, 0, 0, 1, 10, 5]);
    expect(app.commands.label('transparency.toggleMaskLink')).toBe('Unlink Opacity Mask');
    app.commands.run('transparency.toggleMaskLink');
    expect(app.commands.label('transparency.toggleMaskLink')).toBe('Link Opacity Mask');
    doc.transact('Move', () => transformNodes(doc, [a], translate(100, 0)));
    expect(doc.get(a).opacityMask.transform).toEqual([1, 0, 0, 1, 10, 5]);
    app.commands.run('transparency.releaseMask');
    const layer = doc.get(doc.get(a).parent);
    const released = doc.get(layer.children[layer.children.indexOf(a) + 1]);
    expect(released.anchors[0].x).toBeCloseTo(20);
    expect(released.anchors[0].y).toBeCloseTo(15);
  });

  it('toggles disable, clip and invert', async () => {
    const { app, ed, doc, a, m } = await setup();
    ed.select([a, m]);
    app.commands.run('transparency.makeMask');
    app.commands.run('transparency.toggleMask');
    expect(doc.get(a).opacityMask.disabled).toBe(true);
    expect(app.commands.label('transparency.toggleMask')).toBe('Enable Opacity Mask');
    app.commands.run('transparency.toggleMask');
    expect(doc.get(a).opacityMask.disabled).toBeUndefined();
    app.commands.run('transparency.maskClip');
    expect(doc.get(a).opacityMask.clip).toBeUndefined();
    app.commands.run('transparency.maskInvert');
    expect(doc.get(a).opacityMask.invert).toBe(true);
    expect(maskedTargets(ed).length).toBe(1);
  });

  it('converts luminance to alpha', () => {
    const d = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255]);
    luminanceToAlpha(d);
    expect([d[3], d[7], d[11]]).toEqual([255, 0, 128]);
    expect(d[0]).toBe(0);
    const e = new Uint8ClampedArray([255, 255, 255, 255]);
    luminanceToAlpha(e, true);
    expect(e[3]).toBe(0);
  });

  it('renders and exports masked objects', async () => {
    const { app, ed, doc, a, m } = await setup();
    ed.select([a, m]);
    app.commands.run('transparency.makeMask');
    const canvas = document.createElement('canvas');
    expect(() => drawArtwork(canvas.getContext('2d'), doc, { viewRect: null, scale: 1, hairline: 1 })).not.toThrow();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 200 } });
    expect(svg).toMatch(/<mask id="[^"]+" maskUnits="userSpaceOnUse"[^>]*mask-type:luminance/);
    expect(svg).toMatch(/<g mask="url\(#[^)]+\)">/);
    // The mask art is inside the mask, drawn on black (clipping).
    expect(svg).toMatch(/<mask[\s\S]*fill="#000"[\s\S]*<\/mask>/);
  });
});

describe('Transparency panel', () => {
  it('shows mask controls and the panel menu', async () => {
    const { app, ed, doc, a, m, panel, menuItem } = await setup();
    const p = panel('transparency');
    ed.select([a, m]);
    p.update();
    expect(p.makeBtn.textContent).toBe('Make Mask');
    expect(p.makeBtn.disabled).toBe(false);
    p.makeBtn.click();
    expect(doc.get(a).opacityMask).toBeTruthy();
    p.update();
    expect(p.makeBtn.textContent).toBe('Release');
    expect(p.clip.input.checked).toBe(true);
    p.invert.input.checked = true;
    p.invert.input.dispatchEvent(new Event('change'));
    expect(doc.get(a).opacityMask.invert).toBe(true);
    const labels = p.menu().map((x) => (typeof x === 'string' ? x : x.label));
    expect(labels).toEqual(['Hide Thumbnails', 'Hide Options', '-', 'transparency.makeMask', 'transparency.releaseMask', 'transparency.toggleMask', 'transparency.toggleMaskLink', '-', 'New Opacity Masks Are Clipping', 'New Opacity Masks Are Inverted']);
    menuItem(p, 'Hide Options').run();
    expect(p.options.hidden).toBe(true);
    menuItem(p, 'Hide Thumbnails').run();
    expect(p.thumbs.hidden).toBe(true);
    menuItem(p, 'New Opacity Masks Are Clipping').run();
    expect(app.prefs.get('newMasksClip')).toBe(false);
  });

  it('sets knockout shape only on objects inside knockout groups', async () => {
    const { app, ed, doc, a, b, panel } = await setup();
    ed.select([a, b]);
    app.commands.run('object.group');
    const gid = [...ed.selection][0];
    const p = panel('transparency');
    p.knockout.input.checked = true;
    p.knockout.input.dispatchEvent(new Event('change'));
    expect(doc.get(gid).knockout).toBe(true);
    ed.select([a]);
    p.update();
    expect(p.knockShape.input.disabled).toBe(false);
    p.knockShape.input.checked = true;
    p.knockShape.input.dispatchEvent(new Event('change'));
    expect(doc.get(a).knockoutShape).toBe(true);
  });
});
