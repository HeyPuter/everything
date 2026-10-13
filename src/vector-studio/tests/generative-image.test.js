import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { makeImage } from './trace-helpers.js';
import { fakeAI, diskPicture, until } from './generative-helpers.js';
import { createPath, createGroup, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { setPixelSource } from '../src/features/trace/trace-runner.js';
import { setPixelEncoder } from '../src/features/trace/image-ops.js';
import { backgroundMask, maskAlpha, borderColors } from '../src/features/generative/background.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

const dialog = () => until(() => document.querySelector('dialog[open]'));
const button = (dlg, label) => [...dlg.querySelectorAll('.dialog-footer button'), ...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

const PALETTES = JSON.stringify([
  { name: 'Ember', colors: ['#2b0f0e', '#e4572e', '#ffc914'] },
  { name: 'Lagoon', colors: ['#0b3954', '#087e8b', '#bfd7ea'] },
]);

async function recolorSetup() {
  const app = await bootAppWithFeatures();
  const ai = fakeAI({ chat: () => PALETTES });
  app.generativeAI = ai;
  const ed = app.newDocument({ width: 300, height: 200 });
  const doc = ed.doc;
  const colors = ['#111111', '#777777', '#eeeeee'];
  const ids = colors.map((c, i) => createPath(rectangle(i * 40, 0, 30, 30), true, { fill: { type: 'solid', color: c }, stroke: null }));
  const g = createGroup([]);
  doc.transact('add', () => {
    doc.insert(g, doc.layers()[0].id);
    ids.forEach((p) => doc.insert(p, g.id));
  });
  ed.select([g.id]);
  return { app, ed, doc, ai, ids: ids.map((p) => p.id), colors };
}

describe('Generative Recolor', () => {
  it('previews palettes on the artwork and applies one as a single undo step', async () => {
    const { app, doc, ai, ids, colors } = await recolorSetup();
    expect(app.commands.isEnabled('generative.recolor')).toBe(true);
    const undoBefore = doc.undoStack.length;
    const done = app.commands.run('generative.recolor');
    const dlg = await dialog();
    expect(dlg.querySelectorAll('.gen-current .gen-chip')).toHaveLength(3);
    dlg.querySelector('.gen-prompt').value = 'campfire at night';
    dlg.querySelector('.gen-go').click();
    await until(() => dlg.querySelectorAll('.gen-palette').length === 2);
    expect(ai.calls.chat[0].prompt).toMatch(/campfire at night/);
    expect(ai.calls.chat[0].prompt).toMatch(/#111111/);
    // The first palette previews right away: dark to dark, light to light.
    expect(doc.get(ids[0]).fill.color).toBe('#2b0f0e');
    expect(doc.get(ids[2]).fill.color).toBe('#ffc914');
    dlg.querySelectorAll('.gen-palette')[1].click();
    expect(doc.get(ids[0]).fill.color).toBe('#0b3954');
    expect(doc.get(ids[2]).fill.color).toBe('#bfd7ea');
    button(dlg, 'Apply').click();
    expect(await done).toBe(true);
    expect(doc.undoStack.length).toBe(undoBefore + 1);
    expect(doc.undoLabel).toBe('Generative Recolor');
    doc.undo();
    ids.forEach((id, i) => expect(doc.get(id).fill.color).toBe(colors[i]));
    expect(app.generativeHistory.entries[0]).toMatchObject({ kind: 'recolor', prompt: 'campfire at night' });
  });

  it('leaves the artwork alone when cancelled', async () => {
    const { app, doc, ids, colors } = await recolorSetup();
    const undoBefore = doc.undoStack.length;
    const done = app.commands.run('generative.recolor');
    const dlg = await dialog();
    dlg.querySelector('.gen-prompt').value = 'sea';
    dlg.querySelector('.gen-go').click();
    await until(() => dlg.querySelectorAll('.gen-palette').length === 2);
    button(dlg, 'Cancel').click();
    await done;
    ids.forEach((id, i) => expect(doc.get(id).fill.color).toBe(colors[i]));
    expect(doc.undoStack.length).toBe(undoBefore);
  });

  it('opens a palette in Recolor Artwork to refine it', async () => {
    const { app } = await recolorSetup();
    app.commands.run('generative.recolor');
    const dlg = await dialog();
    dlg.querySelector('.gen-prompt').value = 'sea';
    dlg.querySelector('.gen-go').click();
    await until(() => dlg.querySelectorAll('.gen-palette').length === 2);
    button(dlg, 'Edit in Recolor Artwork').click();
    const rc = await until(() => document.querySelector('dialog[open] .recolor'));
    const values = [...rc.querySelectorAll('.rc-new')].map((i) => i.value);
    expect(values).toContain('#2b0f0e');
    expect(values).toContain('#ffc914');
  });

  it('recolors again from the history', async () => {
    const { app, doc, ed, ids } = await recolorSetup();
    app.generativeHistory.add({ kind: 'recolor', prompt: 'x', items: [{ name: 'Lagoon', colors: ['#0b3954', '#087e8b', '#bfd7ea'] }] });
    app.openPanel('generationHistory');
    const hp = app.dock.panels.get('generationHistory');
    hp.el.querySelector('.gen-hist-palette').click();
    expect(doc.get(ids[0]).fill.color).toBe('#0b3954');
    ed.clearSelection();
    expect(app.commands.isEnabled('generative.recolor')).toBe(false);
  });
});

describe('background mask', () => {
  it('finds the background from the border, including enclosed areas', () => {
    // A white picture with a blue ring (white inside and outside it).
    const ring = makeImage(40, 40, (x, y) => {
      const d = Math.hypot(x - 20, y - 20);
      return d > 8 && d < 14 ? [20, 40, 200] : [250, 250, 250];
    });
    expect(borderColors(ring)).toHaveLength(1);
    const keepHoles = backgroundMask(ring, { enclosed: false }).mask;
    const removeHoles = backgroundMask(ring, { enclosed: true }).mask;
    const at = (m, x, y) => m[y * 40 + x];
    expect(at(keepHoles, 0, 0)).toBe(0);
    expect(at(keepHoles, 20 + 11, 20)).toBe(1);
    expect(at(keepHoles, 20, 20)).toBe(1);
    expect(at(removeHoles, 20, 20)).toBe(0);
    expect(at(removeHoles, 20 + 11, 20)).toBe(1);
  });

  it('treats transparent pixels as background and softens edges', () => {
    const px = makeImage(10, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [10, 10, 10, 255] : [0, 0, 0, 0]));
    const { mask } = backgroundMask(px);
    expect(mask[5 * 10 + 5]).toBe(1);
    expect(mask[0]).toBe(0);
    const a = maskAlpha(mask, 10, 10);
    expect(a[0]).toBe(0);
    expect(a[5 * 10 + 5]).toBe(255);
    expect(a[3 * 10 + 3]).toBeGreaterThan(0);
    expect(a[3 * 10 + 3]).toBeLessThan(255);
  });
});

describe('Remove Background', () => {
  let encoded = [];
  beforeEach(() => {
    encoded = [];
    setPixelSource(() => diskPicture(40));
    setPixelEncoder((px) => {
      encoded.push(px);
      return `data:image/png;base64,encoded${encoded.length}`;
    });
  });
  afterEach(() => {
    setPixelSource(null);
    setPixelEncoder(null);
  });

  async function imageSetup() {
    const app = await bootAppWithFeatures();
    const ed = app.newDocument({ width: 400, height: 300 });
    const doc = ed.doc;
    doc.assets.set('pic', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const img = createImage('pic', 40, 40, [2, 0, 0, 2, 100, 50]);
    doc.transact('place', () => doc.insert(img, doc.layers()[0].id));
    ed.select([img.id]);
    return { app, ed, doc, id: img.id };
  }

  it('makes the background transparent in a new asset (undoable)', async () => {
    const { app, doc, id } = await imageSetup();
    expect(app.commands.isEnabled('object.removeBackground')).toBe(true);
    const done = app.commands.run('object.removeBackground');
    const dlg = await dialog();
    button(dlg, 'Remove').click();
    await done;
    expect(encoded).toHaveLength(1);
    const px = encoded[0];
    expect(px.width).toBe(40);
    expect(px.data[3]).toBe(0);
    expect(px.data[(20 * 40 + 20) * 4 + 3]).toBe(255);
    const asset = doc.get(id).asset;
    expect(asset).not.toBe('pic');
    expect(doc.assets.get(asset).data).toBe('data:image/png;base64,encoded1');
    expect(doc.undoLabel).toBe('Remove Background');
    doc.undo();
    expect(doc.get(id).asset).toBe('pic');
    expect(app.prefs.get('removeBackground').mode).toBe('alpha');
  });

  it('can clip the image with an editable path instead', async () => {
    const { app, ed, doc, id } = await imageSetup();
    const done = app.commands.run('object.removeBackground');
    const dlg = await dialog();
    dlg.querySelector('input[type=radio][value=clip]').checked = true;
    button(dlg, 'Remove').click();
    const out = await done;
    const g = doc.get([...ed.selection][0]);
    expect(out).toEqual([g.id]);
    expect(g.clip).toBe(true);
    expect(g.children[0]).toBe(id);
    const clipPath = doc.get(g.children[1]);
    expect(clipPath.type).toBe('compound');
    // The disk: radius 12 px around (20, 20), image scaled 2x at (100, 50): x from 116, 48 wide.
    const b = nodeBounds(doc, clipPath);
    expect(b.x).toBeGreaterThan(110);
    expect(b.x).toBeLessThan(122);
    expect(b.w).toBeGreaterThan(40);
    expect(b.w).toBeLessThan(56);
    expect(doc.get(id).asset).toBe('pic');
  });

  it('is offered in the task bar for images', async () => {
    const { app } = await imageSetup();
    await until(() => app.taskbar.querySelector('[data-cmd="object.removeBackground"]'));
  });
});
