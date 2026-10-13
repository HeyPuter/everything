import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { fakeAI, diskPicture, stripesPicture, until, flush } from './generative-helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { MENUS } from '../src/ui/menus.js';

afterEach(() => vi.restoreAllMocks());

async function setup({ ai = fakeAI(), picture = diskPicture } = {}) {
  const app = await bootAppWithFeatures();
  app.generativeAI = ai;
  app.generativeDecode = async () => picture();
  const ed = app.newDocument({ width: 400, height: 300 });
  return { app, ed, doc: ed.doc, ai };
}

function addShape(doc, anchors, closed = true, style = {}) {
  const p = createPath(anchors, closed, { fill: { type: 'solid', color: '#3366ff' }, ...style });
  doc.transact('add', () => doc.insert(p, doc.layers()[0].id));
  return p.id;
}

function panelOf(app) {
  return app.dock.panels.get('generate');
}

async function generate(app, prompt = 'a red ball', settings = {}) {
  const p = panelOf(app);
  p.use({ prompt, settings: { detail: 1, count: 2, ...settings } });
  await p.generate();
  return p;
}

describe('generative menus and commands', () => {
  it('lists the Generative submenu, Remove Background and Generation History', async () => {
    const { app } = await setup();
    const object = MENUS.find((m) => m.label === 'Object');
    const gen = object.submenu.find((i) => i.label === 'Generative');
    const ids = gen.submenu.flatMap((i) => (typeof i === 'string' ? [i] : i.submenu || [])).filter((i) => i !== '-');
    for (const id of ids) expect(app.commands.get(id), id).toBeTruthy();
    expect(object.submenu.indexOf('object.removeBackground')).toBe(object.submenu.indexOf('object.expandAppearance') + 1);
    expect(app.commands.get('panel.generationHistory')).toBeTruthy();
    expect(app.commands.isEnabled('generative.vectors')).toBe(true);
    expect(app.commands.isEnabled('generative.shapeFill')).toBe(false);
    expect(app.commands.isEnabled('object.removeBackground')).toBe(false);
  });

  it('opens the Generate panel in the requested mode', async () => {
    const { app, doc, ed } = await setup();
    await app.commands.run('generative.patterns');
    const p = panelOf(app);
    expect(p.mode).toBe('pattern');
    expect(p.el.querySelector('.gen-modes [aria-checked="true"]').dataset.value).toBe('pattern');
    expect(document.activeElement).toBe(p.promptBox);
    ed.select([addShape(doc, ellipse(10, 10, 80, 60))]);
    expect(app.commands.isEnabled('generative.shapeFill')).toBe(true);
    await app.commands.run('generative.shapeFill');
    expect(p.mode).toBe('shapeFill');
    expect(p.typeSeg.el.hidden).toBe(true);
  });
});

describe('Generate Vectors', () => {
  it('places the first variation on the artboard and swaps in others', async () => {
    const { app, ed, doc, ai } = await setup();
    await app.commands.run('generative.vectors');
    const p = await generate(app, 'a red ball');
    expect(ai.calls.txt2img).toHaveLength(2);
    expect(ai.calls.txt2img[0].prompt).toMatch(/^a red ball\./);
    expect(p.variations).toHaveLength(2);
    const tiles = p.el.querySelectorAll('.gen-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0].getAttribute('aria-pressed')).toBe('true');
    const placed = doc.get(p.placement.id);
    expect(placed.type).toBe('group');
    expect(placed.name).toBe('Generated: A red ball');
    expect([...ed.selection]).toEqual([placed.id]);
    // Subjects take the middle of the artboard.
    const b = nodeBounds(doc, placed);
    expect(b.x).toBeGreaterThan(80);
    expect(b.x + b.w).toBeLessThan(320);
    expect(Math.abs(b.x + b.w / 2 - 200)).toBeLessThan(10);
    // Choosing another variation swaps it in place, as one undo step.
    tiles[1].click();
    expect(doc.get(placed.id)).toBeFalsy();
    const swapped = doc.get(p.placement.id);
    expect(swapped.parent).toBe(placed.parent);
    expect(tiles[1].getAttribute('aria-pressed')).toBe('true');
    doc.undo();
    expect(doc.get(placed.id)).toBeTruthy();
    expect(doc.get(swapped.id)).toBeFalsy();
    // And the generation is in the history.
    expect(app.generativeHistory.entries[0]).toMatchObject({ kind: 'vectors', prompt: 'a red ball' });
    expect(app.generativeHistory.entries[0].items).toHaveLength(2);
  });

  it('fits the selection and matches its style when asked', async () => {
    const { app, ed, doc, ai } = await setup({ ai: fakeAI({ chat: () => 'flat shapes with thick outlines' }) });
    const id = addShape(doc, rectangle(20, 30, 100, 50), true, { fill: { type: 'solid', color: '#ff8800' } });
    ed.select([id]);
    openPanel(app);
    const p = await generate(app, 'a sailboat', { reference: true, count: 1 });
    expect(ai.calls.txt2img[0].prompt).toMatch(/#ff8800/);
    expect(ai.calls.txt2img[0].options.ratio).toEqual({ w: 16, h: 9 });
    const b = nodeBounds(doc, doc.get(p.placement.id));
    expect(b.x).toBeGreaterThanOrEqual(19.5);
    expect(b.y).toBeGreaterThanOrEqual(29.5);
    expect(b.x + b.w).toBeLessThanOrEqual(120.5);
    expect(b.y + b.h).toBeLessThanOrEqual(80.5);
    // Above the selected object.
    const layer = doc.layers()[0];
    expect(layer.children.indexOf(p.placement.id)).toBe(layer.children.indexOf(id) + 1);
  });

  it('can be cancelled while generating', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { app, doc } = await setup({ ai: fakeAI({ gate }) });
    openPanel(app);
    const p = panelOf(app);
    p.use({ prompt: 'a kite', settings: { detail: 1, count: 1 } });
    const done = p.generate();
    await flush(3);
    expect(p.busy).toBe(true);
    expect(p.progress.el.hidden).toBe(false);
    expect(p.goBtn.disabled).toBe(true);
    p.progress.cancelButton.click();
    await done;
    release();
    expect(p.busy).toBe(false);
    expect(p.status.textContent).toBe('Cancelled.');
    expect(p.variations).toHaveLength(0);
    expect(doc.layers()[0].children).toHaveLength(0);
  });

  it('explains what is needed when signed out or offline', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    app.puter = { ai: { chat: vi.fn(), txt2img: vi.fn() } };
    app.onSignIn = vi.fn();
    openPanel(app);
    const p = panelOf(app);
    p.update();
    expect(p.notice.el.hidden).toBe(false);
    expect(p.notice.el.textContent).toMatch(/Sign in/);
    expect(p.goBtn.disabled).toBe(true);
    p.notice.el.querySelector('button').click();
    expect(app.onSignIn).toHaveBeenCalled();
    app.setUser({ username: 'me' }, null);
    p.update();
    expect(p.notice.el.hidden).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    p.update();
    expect(p.notice.el.textContent).toMatch(/offline/);
    // Generating anyway reports the problem without calling the service.
    p.promptBox.value = 'a cat';
    await p.generate();
    expect(p.status.textContent).toMatch(/offline/);
    expect(app.puter.ai.txt2img).not.toHaveBeenCalled();
  });

  it('reports service errors in the panel', async () => {
    const { app } = await setup({ ai: fakeAI({ fail: { txt2img: { code: 'moderation_flagged' } } }) });
    openPanel(app);
    const p = await generate(app, 'something');
    expect(p.status.textContent).toMatch(/content filter/);
    expect(p.variations).toHaveLength(0);
  });
});

describe('Generative Shape Fill', () => {
  it('clips generated art into the selected shape', async () => {
    const { app, ed, doc } = await setup();
    const id = addShape(doc, ellipse(50, 40, 200, 120));
    ed.select([id]);
    await app.commands.run('generative.shapeFill');
    const p = await generate(app, 'autumn leaves');
    const rec = p.placement;
    expect(rec.kind).toBe('clip');
    const g = doc.get(rec.clipId);
    expect(g.clip).toBe(true);
    expect(g.children[g.children.length - 1]).toBe(id);
    expect(doc.get(id).fill).toBe(null);
    // The art covers the shape.
    const art = nodeBounds(doc, doc.get(rec.artId));
    expect(art.x).toBeLessThanOrEqual(50.5);
    expect(art.y).toBeLessThanOrEqual(40.5);
    expect(art.x + art.w).toBeGreaterThanOrEqual(249.5);
    expect(art.y + art.h).toBeGreaterThanOrEqual(159.5);
    // Swapping keeps the clip and the shape.
    p.choose(1);
    expect(p.placement.clipId).toBe(rec.clipId);
    expect(doc.get(rec.artId)).toBeFalsy();
    expect(doc.get(rec.clipId).children).toEqual([p.placement.artId, id]);
    doc.undo();
    doc.undo();
    expect(doc.get(id).fill).toEqual({ type: 'solid', color: '#3366ff' });
    expect(doc.get(id).parent).toBe(doc.layers()[0].id);
  });
});

describe('Generate Patterns', () => {
  it('turns a chosen variation into a pattern swatch and fills the selection', async () => {
    const { app, ed, doc, ai } = await setup({ picture: stripesPicture });
    const id = addShape(doc, rectangle(0, 0, 100, 100));
    ed.select([id]);
    await app.commands.run('generative.patterns');
    const p = await generate(app, 'stripes');
    expect(ai.calls.txt2img[0].prompt).toMatch(/seamless repeating pattern/);
    expect(ai.calls.txt2img[0].options.ratio).toEqual({ w: 1, h: 1 });
    // Nothing is added until a variation is chosen.
    expect(doc.root.patterns || []).toHaveLength(0);
    p.el.querySelectorAll('.gen-tile')[0].click();
    const pats = doc.root.patterns;
    expect(pats).toHaveLength(1);
    expect(pats[0].name).toBe('Stripes');
    expect(pats[0].width).toBe(72);
    expect(pats[0].art.nodes.length).toBeGreaterThan(1);
    expect(doc.root.swatches.some((s) => s.paint.type === 'pattern' && s.paint.id === pats[0].id)).toBe(true);
    expect(doc.get(id).fill).toEqual({ type: 'pattern', id: pats[0].id });
    expect(p.status.textContent).toMatch(/Added "Stripes" to Swatches and filled the selected object/);
    doc.undo();
    expect(doc.root.patterns || []).toHaveLength(0);
  });
});

describe('Generation History panel', () => {
  it('lists generations and places results again', async () => {
    const { app, doc, ed } = await setup();
    openPanel(app);
    await generate(app, 'a red ball', { count: 1 });
    app.openPanel('generationHistory');
    const hp = app.dock.panels.get('generationHistory');
    hp.update();
    const entries = hp.el.querySelectorAll('.gen-hist-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].textContent).toMatch(/A red ball/);
    ed.clearSelection();
    const before = doc.layers()[0].children.length;
    entries[0].querySelector('.gen-tile').click();
    expect(doc.layers()[0].children.length).toBe(before + 1);
    // Delete it.
    entries[0].querySelector('[aria-label="Delete from history"]').click();
    expect(hp.el.querySelectorAll('.gen-hist-entry')).toHaveLength(0);
    expect(app.generativeHistory.entries).toHaveLength(0);
    expect(hp.empty.hidden).toBe(false);
  });

  it('sends a prompt and its settings back to the Generate panel', async () => {
    const { app } = await setup();
    app.generativeHistory.add({ kind: 'pattern', prompt: 'tiny lemons', settings: { style: 'retro', detail: 3 }, items: [] });
    app.openPanel('generationHistory');
    const hp = app.dock.panels.get('generationHistory');
    hp.el.querySelector('[aria-label="Use this prompt again"]').click();
    const p = panelOf(app);
    expect(p.promptBox.value).toBe('tiny lemons');
    expect(p.mode).toBe('pattern');
    expect(p.styleSel.sel.value).toBe('retro');
    expect(p.detail.value).toBe('3');
  });
});

describe('contextual task bar', () => {
  it('offers generative actions for the selection', async () => {
    const { app, ed, doc } = await setup();
    const labels = () => [...app.taskbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent);
    app.taskbar.hidden = true;
    await until(() => !app.taskbar.hidden);
    expect(labels()).toContain('Generate Vectors');
    ed.select([addShape(doc, ellipse(10, 10, 50, 50))]);
    await until(() => labels().includes('Shape Fill'));
    const g = app.taskbar.querySelector('[data-cmd="generative.shapeFill"]');
    expect(g.disabled).toBe(false);
  });
});

function openPanel(app) {
  app.openPanel('generate');
}
