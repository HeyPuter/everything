import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { makeImage } from './trace-helpers.js';
import { fakeAI } from './generative-helpers.js';
import { createImage } from '../src/model/nodes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { MENUS } from '../src/ui/menus.js';
import { cancelOpenDialogs } from '../src/ui/dialogs/dialog.js';
import { setPixelSource } from '../src/features/trace/trace-runner.js';
import { setPixelEncoder } from '../src/features/trace/image-ops.js';
import { reflect, mirrorPad, localFill, composeExpansion, blendExpansion, patchSearch } from '../src/features/mockup/outpaint.js';
import { marginsFor, localMargins, bleedTarget, expandHooks, expandPrompt, frameTargets } from '../src/features/mockup/expand-image.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (fn, tries = 400) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out');
};
const openDlg = () => document.querySelector('dialog[open]');
const button = (dlg, text) => [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const at = (px, x, y) => [...px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];

afterEach(async () => {
  await cancelOpenDialogs();
  setPixelSource(null);
  setPixelEncoder(null);
  expandHooks.decode = null;
});

describe('Local expansion', () => {
  it('reflects coordinates at any distance', () => {
    expect([-1, -2, 0, 4, 5, 6, 9, 12].map((v) => reflect(v, 0, 5))).toEqual([1, 2, 0, 4, 3, 2, 1, 4]);
    expect(reflect(7, 3, 4)).toBe(3);
  });

  it('mirrors the image into the margins without a seam', () => {
    const px = makeImage(4, 2, (x) => [Math.floor(x) * 60 + 30, 0, 0]);
    const big = mirrorPad(px, { left: 2, right: 3, top: 1, bottom: 0 });
    expect(big.width).toBe(9);
    expect(big.height).toBe(3);
    // Row 1 is the original row 0: margin, original, margin.
    const row = Array.from({ length: 9 }, (_, x) => at(big, x, 1)[0]);
    expect(row).toEqual([150, 90, 30, 90, 150, 210, 150, 90, 30]);
  });

  it('keeps the original pixels and continues the image into the margins', async () => {
    // Left half red, right half blue.
    const px = makeImage(40, 30, (x) => (x < 20 ? [220, 30, 30] : [30, 30, 220]));
    const big = await localFill(px, { left: 0, top: 10, right: 16, bottom: 0 });
    expect(big.width).toBe(56);
    expect(big.height).toBe(40);
    for (const [x, y] of [[0, 10], [39, 39], [19, 25]]) expect(at(big, x, y)).toEqual(at(px, x, y - 10));
    // The right margin continues the blue half, the top margin above the red half stays red.
    expect(at(big, 50, 20)[2]).toBeGreaterThan(150);
    expect(at(big, 5, 3)[0]).toBeGreaterThan(150);
    expect(at(big, 5, 3)[2]).toBeLessThan(100);
  });

  it('continues a texture with patches of the image itself', async () => {
    // Vertical stripes, 3 pixels wide.
    const colors = [[250, 200, 40], [30, 60, 160]];
    const px = makeImage(30, 24, (x) => colors[Math.floor(x / 3) % 2]);
    const big = await localFill(px, { left: 0, top: 0, right: 20, bottom: 0 });
    let fromImage = 0;
    let total = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 30; x < 50; x++) {
        const c = at(big, x, y);
        total++;
        if (colors.some((k) => Math.abs(k[0] - c[0]) + Math.abs(k[1] - c[1]) + Math.abs(k[2] - c[2]) < 6)) fromImage++;
      }
    }
    expect(fromImage / total).toBeGreaterThan(0.98);
    // Stripes keep their width: most margin columns are a single color top to bottom.
    let solid = 0;
    for (let x = 30; x < 50; x++) {
      const first = at(big, x, 0)[0];
      if (Array.from({ length: 24 }, (_, y) => at(big, x, y)[0]).every((v) => Math.abs(v - first) < 6)) solid++;
    }
    expect(solid).toBeGreaterThan(15);
  });

  it('gives up the patch search for tiny images but still mirrors', async () => {
    expect(patchSearch(new Uint8ClampedArray(6 * 6 * 4), 6, 6, { x: 1, y: 1, w: 3, h: 3 })).toBeNull();
    const px = makeImage(3, 3, () => [10, 20, 30]);
    const big = await localFill(px, { left: 4, top: 4, right: 4, bottom: 4 });
    expect(at(big, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it('builds the padded image and mask for AI and keeps only generated margins', () => {
    const px = makeImage(4, 4, () => [200, 10, 10]);
    const { image, mask } = composeExpansion(px, { left: 2, top: 0, right: 0, bottom: 0 });
    expect(at(image, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(at(image, 2, 0)).toEqual([200, 10, 10, 255]);
    expect(at(mask, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(mask, 3, 3)).toEqual([0, 0, 0, 255]);
    const gen = makeImage(6, 4, () => [0, 255, 0]);
    const out = blendExpansion(mirrorPad(px, { left: 2 }), gen, px, { left: 2 }, { band: 1 });
    expect(at(out, 0, 1)).toEqual([0, 255, 0, 255]);
    expect(at(out, 2, 1)).toEqual([200, 10, 10, 255]);
  });
});

describe('Expansion targets', () => {
  const node = { width: 100, height: 50, transform: [2, 0, 0, 2, 10, 20] };

  it('turns a document rectangle into whole-pixel margins along the image sides', () => {
    const m = marginsFor(node, { width: 200, height: 100 }, { x: 0, y: 20, w: 210, h: 120 });
    expect(m.pixels).toEqual({ left: 10, top: 0, right: 0, bottom: 20 });
    expect(m.local).toEqual({ left: 5, top: 0, right: 0, bottom: 10 });
    expect(marginsFor(node, { width: 200, height: 100 }, { x: 20, y: 30, w: 10, h: 10 })).toBeNull();
    expect(localMargins(node, { width: 100, height: 50 }, { left: 0.4, top: 0, right: 0, bottom: 0 })).toBeNull();
  });

  it('finds the bleed to fill from the sides that reach the artboard edge', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument({ width: 300, height: 200, bleed: 9 });
    const doc = app.editor.doc;
    doc.assets.set('a', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' });
    // Touches the left and top edges only.
    const img = createImage('a', 150, 100, [1, 0, 0, 1, 0, 0]);
    doc.transact('i', () => doc.insert(img, app.editor.targetLayer().id));
    expect(bleedTarget(doc, doc.get(img.id))).toEqual({ x: -9, y: -9, w: 159, h: 109 });
    doc.transact('m', () => doc.update(img.id, { transform: [1, 0, 0, 1, 50, 50] }));
    expect(() => bleedTarget(doc, doc.get(img.id))).toThrow(/does not reach/);
    app.newDocument({ width: 300, height: 200 });
    const d2 = app.editor.doc;
    d2.assets.set('a', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' });
    const i2 = createImage('a', 300, 200);
    d2.transact('i', () => d2.insert(i2, app.editor.targetLayer().id));
    expect(() => bleedTarget(d2, d2.get(i2.id))).toThrow(/no bleed/);
  });

  it('describes the job for the image model', () => {
    const p = expandPrompt('more sky');
    expect(p).toContain('more sky');
    expect(p).toMatch(/mask/);
  });
});

async function setup({ ai = null, bleed = 0 } = {}) {
  const app = await bootAppWithFeatures();
  app.generativeAI = ai;
  app.newDocument({ width: 400, height: 300, bleed });
  const ed = app.editor;
  const doc = ed.doc;
  doc.assets.set('pic', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=', name: 'pic.png' });
  // 100 x 60 points showing 50 x 30 pixels.
  const img = createImage('pic', 100, 60, [1, 0, 0, 1, 0, 0]);
  doc.transact('i', () => doc.insert(img, ed.targetLayer().id));
  ed.select([img.id]);
  setPixelSource(() => makeImage(50, 30, (x) => (x < 25 ? [200, 40, 40] : [40, 40, 200])));
  const encoded = [];
  setPixelEncoder((px) => {
    encoded.push(px);
    return `data:image/png;base64,${encoded.length}`;
  });
  return { app, ed, doc, img: img.id, encoded };
}

describe('Expand Image commands', () => {
  it('sits under Object > Generative after Rewrite', async () => {
    const { app } = await setup();
    const gen = MENUS.find((m) => m.label === 'Object').submenu.find((m) => m.label === 'Generative').submenu;
    const i = gen.findIndex((m) => m.label === 'Expand Image');
    expect(gen[i - 2].label).toBe('Rewrite');
    expect(gen[i].submenu).toEqual(['expandImage.makeFrame', 'expandImage.fill', '-', 'expandImage.expand']);
    expect(gen[i + 1]).toBe('expandImage.bleed');
    for (const id of ['expandImage.makeFrame', 'expandImage.fill', 'expandImage.expand', 'expandImage.bleed']) expect(app.commands.get(id), id).toBeTruthy();
    expect(app.commands.isEnabled('expandImage.makeFrame')).toBe(true);
    expect(app.commands.isEnabled('expandImage.fill')).toBe(false);
  });

  it('Make Frame then Fill Frame extends the image on this device when AI is unavailable', async () => {
    const { app, ed, doc, img, encoded } = await setup();
    app.commands.run('expandImage.makeFrame');
    const frame = doc.get(ed.topSelection()[0]);
    expect(frame.name).toBe('Expand Frame');
    expect(frame.expandFrame).toBe(img);
    expect(frameTargets(ed).image.id).toBe(img);
    // Pretend the frame was resized to 20 points past the right edge only.
    doc.transact('resize', () => doc.update(frame.id, { anchors: frame.anchors.map((a) => ({ ...a, x: a.x < 50 ? 0 : 120, ix: a.x < 50 ? 0 : 120, ox: a.x < 50 ? 0 : 120, y: a.y < 30 ? 0 : 60, iy: a.y < 30 ? 0 : 60, oy: a.y < 30 ? 0 : 60 })) }));
    const p = app.commands.run('expandImage.fill');
    const dlg = await until(openDlg);
    // Without Puter AI the dialog says the image is extended locally.
    expect(dlg.textContent).toMatch(/on this device/);
    expect(dlg.querySelector('input[type="radio"]')).toBeNull();
    const before = doc.undoStack.length;
    button(dlg, 'Expand').click();
    await p;
    const n = doc.get(img);
    expect(n.width).toBeCloseTo(120);
    expect(n.height).toBeCloseTo(60);
    expect(n.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(n.asset).not.toBe('pic');
    expect(encoded[encoded.length - 1].width).toBe(60);
    expect(doc.has(frame.id)).toBe(false);
    expect(ed.topSelection()).toEqual([img]);
    expect(doc.undoStack.length).toBe(before + 2);
    doc.undo();
    doc.undo();
    expect(doc.get(img).asset).toBe('pic');
    expect(doc.has(frame.id)).toBe(true);
  });

  it('Expand By grows each side by the given margins', async () => {
    const { app, doc, img, encoded } = await setup();
    const p = app.commands.run('expandImage.expand');
    const dlg = await until(openDlg);
    const field = (label) => {
      const l = [...dlg.querySelectorAll('label')].find((x) => x.textContent.trim() === label);
      return dlg.querySelector(`#${l.htmlFor}`);
    };
    for (const [k, v] of [['Top', '10 pt'], ['Bottom', '0 pt'], ['Left', '20 pt'], ['Right', '0 pt']]) {
      field(k).value = v;
      field(k).dispatchEvent(new Event('input', { bubbles: true }));
    }
    button(dlg, 'Expand').click();
    await p;
    const n = doc.get(img);
    expect(n.width).toBeCloseTo(120);
    expect(n.height).toBeCloseTo(70);
    expect(n.transform[4]).toBeCloseTo(-20);
    expect(n.transform[5]).toBeCloseTo(-10);
    const out = encoded[encoded.length - 1];
    expect([out.width, out.height]).toEqual([60, 35]);
    // The original pixels moved by the margins.
    expect(at(out, 10, 5)).toEqual([200, 40, 40, 255]);
  });

  it('Fill Bleed generates the margins with Puter AI and keeps the original', async () => {
    const ai = fakeAI();
    const { app, ed, doc, img, encoded } = await setup({ ai, bleed: 10 });
    expandHooks.decode = async () => makeImage(30, 20, () => [0, 220, 0]);
    // The image covers the artboard's top-left corner.
    const p = app.commands.run('expandImage.bleed');
    const dlg = await until(openDlg);
    expect(dlg.querySelector('input[type="radio"][value="ai"]').checked).toBe(true);
    const prompt = [...dlg.querySelectorAll('input[type="text"]')].pop();
    prompt.value = 'more brick wall';
    button(dlg, 'Expand').click();
    await p;
    expect(ai.calls.txt2img).toHaveLength(1);
    const call = ai.calls.txt2img[0];
    expect(call.prompt).toContain('more brick wall');
    expect(call.options.input_images).toHaveLength(2);
    expect(call.options.input_images.every((u) => u.startsWith('data:image/png'))).toBe(true);
    const n = doc.get(img);
    const b = nodeBounds(doc, n);
    expect(b.x).toBeCloseTo(-10);
    expect(b.y).toBeCloseTo(-10);
    expect(b.w).toBeCloseTo(110);
    expect(b.h).toBeCloseTo(70);
    const out = encoded[encoded.length - 1];
    expect([out.width, out.height]).toEqual([55, 35]);
    // Generated margins far from the seam, original pixels unchanged.
    expect(at(out, 0, 0)[1]).toBeGreaterThan(150);
    expect(at(out, 5, 5)).toEqual([200, 40, 40, 255]);
    expect(ed.topSelection()).toEqual([img]);
  });

  it('offers the local fill when Puter AI fails', async () => {
    const ai = fakeAI({ fail: { txt2img: new Error('Model unavailable') } });
    const { app, doc, img } = await setup({ ai, bleed: 10 });
    const p = app.commands.run('expandImage.bleed');
    let dlg = await until(openDlg);
    button(dlg, 'Expand').click();
    dlg = await until(() => (openDlg()?.textContent.includes('Model unavailable') ? openDlg() : null));
    expect(dlg.textContent).toMatch(/on this device instead/);
    button(dlg, 'Extend Here').click();
    await p;
    expect(doc.get(img).asset).not.toBe('pic');
    expect(doc.get(img).width).toBeCloseTo(110);
  });
});
