import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { normalizeProject, normalizeAsset } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { STYLE_LOOKS, normalizeStylize, styleEffect, STYLE_AMOUNT_DEFAULT } from '../src/model/stylize.js';
import { EFFECTS } from '../src/model/catalog.js';
import { isKnownEffect } from '../src/model/clip-effects.js';
import { effectShader } from '../src/engine/shaders.js';
import { evaluate } from '../src/engine/scene.js';
import { RESTYLE_STYLES, restylePrompt, restylePicture, restyleFileName, fitSize } from '../src/media/restyle.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { addRestyledClip, replacePicture } from '../src/ui/inspector/stylize.js';
import { ATTRIBUTE_GROUPS } from '../src/ui/organize-actions.js';
import { fixture, onMain, clip, s } from './helpers.js';
import { createCompound, breakApart } from '../src/model/compound.js';

describe('style looks', () => {
  it('run on effects that exist, the new ones listed under Stylize', () => {
    for (const look of STYLE_LOOKS) {
      expect(isKnownEffect(look.effect), look.id).toBe(true);
      expect(effectShader(look.effect), look.id).toBeTruthy();
    }
    for (const id of ['ink-sketch', 'watercolor', 'neon-edges']) expect(EFFECTS.find((e) => e.id === id)?.cat).toBe('stylize');
    // Existing effects are reused rather than copied.
    expect(STYLE_LOOKS.find((l) => l.id === 'comic').effect).toBe('comic');
    expect(STYLE_LOOKS.find((l) => l.id === 'halftone').effect).toBe('halftone');
  });

  it('normalize to a known look and an amount', () => {
    expect(normalizeStylize(null)).toBe(null);
    expect(normalizeStylize({ id: 'nope' })).toBe(null);
    expect(normalizeStylize({ id: 'oil' })).toEqual({ id: 'oil', amount: STYLE_AMOUNT_DEFAULT });
    expect(normalizeStylize({ id: 'oil', amount: 140.4 })).toEqual({ id: 'oil', amount: 100 });
  });

  it('turn the amount into effect settings', () => {
    const lo = styleEffect({ id: 'oil', amount: 0 });
    const hi = styleEffect({ id: 'oil', amount: 100 });
    expect(lo.id).toBe('oil-paint');
    expect(hi.params.size).toBeGreaterThan(lo.params.size);
    expect(styleEffect({ id: 'oil', amount: 40 })).toBe(styleEffect({ id: 'oil', amount: 40 }));
    expect(styleEffect({ id: 'riso', amount: 50 }).params.ink).toMatch(/^#[0-9a-f]{6}$/);
    expect(styleEffect(null)).toBe(null);
  });

  it('render before the clip’s own effects, on video and image clips only', () => {
    const p = fixture();
    const [v] = onMain(p, clip('video', 0, 5, { stylize: { id: 'neon', amount: 80 }, effects: [{ id: 'vignette', params: { strength: 50 } }] }));
    const layer = evaluate(p, s(1)).find((l) => l.clip.id === v.id);
    expect(layer.effects.map((e) => e.id)).toEqual(['neon-edges', 'vignette']);
    v.stylize = null;
    expect(evaluate(p, s(1)).find((l) => l.clip.id === v.id).effects.map((e) => e.id)).toEqual(['vignette']);
  });

  it('save with the project and paste as an attribute', () => {
    const p = fixture();
    const [img] = onMain(p, clip('image', 0, 3, { stylize: { id: 'watercolor', amount: 55 } }));
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(findClip(back, img.id).clip.stylize).toEqual({ id: 'watercolor', amount: 55 });
    const g = ATTRIBUTE_GROUPS.find((x) => x.id === 'stylize');
    expect(g.keys).toEqual(['stylize']);
    expect(g.types).toEqual(['video', 'image']);
  });
});

describe('AI restyle', () => {
  afterEach(() => {
    delete globalThis.puter;
  });

  it('builds an instruction from a style chip and a description', () => {
    expect(restylePrompt('', null)).toBe('');
    const p = restylePrompt('warm autumn colors', 'storybook');
    expect(p).toMatch(/storybook illustration/);
    expect(p).toMatch(/warm autumn colors/);
    expect(p).toMatch(/Keep the same composition/);
    expect(restylePrompt('just this', null)).toMatch(/just this/);
    expect(RESTYLE_STYLES.length).toBeGreaterThanOrEqual(6);
  });

  it('sends the picture as input_image with its shape and reads the result', async () => {
    const txt2img = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
    const picture = { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), width: 640, height: 360 };
    const out = await restylePicture(picture, { style: 'clay', txt2img });
    const [prompt, options] = txt2img.mock.calls[0];
    expect(prompt).toMatch(/clay/);
    expect(options.ratio).toEqual({ w: 640, h: 360 });
    expect(options.input_image).toBe('data:image/png;base64,AQID');
    expect(out.blob.type).toBe('image/png');
  });

  it('reports failures in plain words', async () => {
    const picture = { blob: new Blob(['x'], { type: 'image/png' }), width: 10, height: 10 };
    await expect(restylePicture(picture, { style: 'clay', txt2img: async () => { throw { code: 'moderation_flagged' }; } })).rejects.toThrow(/content filter/);
    await expect(restylePicture(picture, { txt2img: async () => 'x' })).rejects.toThrow(/Pick a style/);
    await expect(restylePicture(picture, { style: 'clay' })).rejects.toThrow(/needs Puter/);
  });

  it('names results and fits the picture size', () => {
    expect(restyleFileName('Beach.jpg', 'pixel', 'image/jpeg')).toBe('Beach - Pixel art.jpg');
    expect(restyleFileName('', null)).toBe('Picture - Restyled.png');
    expect(fitSize(4000, 2000)).toEqual({ w: 1024, h: 512 });
    expect(fitSize(300, 200)).toEqual({ w: 300, h: 200 });
  });
});

/* ---- Style tab ----------------------------------------------------------------------- */

function env({ signedIn = true } = {}) {
  const p = fixture();
  const [img] = onMain(p, clip('image', 0, 4));
  const store = new EditorStore(p);
  const library = {
    backend: { kind: signedIn ? 'puter' : 'local' },
    importFile: async (file) => normalizeAsset({ kind: 'image', name: file.name, width: 640, height: 360 }),
  };
  const ctx = { store, library, player: { pause() {} } };
  ctx.actions = createActions(ctx);
  ctx.restyleServices = {
    picture: vi.fn(async () => ({ blob: new Blob(['p'], { type: 'image/png' }), width: 640, height: 360 })),
    restyle: vi.fn(async () => ({ blob: new Blob(['r'], { type: 'image/png' }) })),
  };
  if (signedIn) globalThis.puter = { ai: {} };
  store.select(img.id);
  const insp = createInspector(ctx);
  document.body.append(insp.el);
  [...insp.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Style').click();
  return { store, ctx, img, insp, live: () => findClip(store.project, img.id).clip };
}

const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

describe('style tab', () => {
  afterEach(() => {
    delete globalThis.puter;
    document.body.replaceChildren();
  });

  it('applies a look, sets its amount and removes it', () => {
    const { insp, live, store } = env();
    const tile = [...insp.el.querySelectorAll('.style-grid .choice')].find((b) => /Pencil hatch/.test(b.textContent));
    tile.click();
    expect(live().stylize).toEqual({ id: 'hatch', amount: STYLE_AMOUNT_DEFAULT });
    const range = insp.el.querySelector('.stylize-tab input[type=range]');
    range.value = '30';
    range.dispatchEvent(new Event('input'));
    range.dispatchEvent(new Event('change'));
    expect(live().stylize.amount).toBe(30);
    [...insp.el.querySelectorAll('.style-grid .choice')].find((b) => b.querySelector('.choice-label').textContent === 'None').click();
    expect(live().stylize).toBeUndefined();
    store.undo();
    expect(live().stylize).toEqual({ id: 'hatch', amount: 30 });
    insp.dispose();
  });

  it('asks signed-out users to sign in for AI restyle', () => {
    const { insp } = env({ signedIn: false });
    expect(insp.el.textContent).toMatch(/needs a Puter account/);
    expect(button(insp.el, 'Restyle')).toBeUndefined();
    insp.dispose();
  });

  it('restyles the picture and replaces it in one undoable step', async () => {
    const { insp, ctx, live, store } = env();
    live().adjust.exposure = 20;
    ctx.restyleServices.picture.mockResolvedValue({ blob: new Blob(['p']), width: 640, height: 360, baked: { settings: { adjust: { ...live().adjust } }, keyframes: {}, pictureSize: { width: 72, height: 40.5 } } });
    const go = button(insp.el, 'Restyle');
    expect(go.disabled).toBe(true);
    [...insp.el.querySelectorAll('.restyle-chip')].find((b) => b.textContent === 'Graphite').click();
    expect(go.disabled).toBe(false);
    go.click();
    await vi.waitFor(() => expect(insp.el.querySelector('.restyle-result img')).toBeTruthy());
    expect(ctx.restyleServices.restyle).toHaveBeenCalledWith(expect.objectContaining({ width: 640 }), { prompt: '', style: 'graphite' });
    const before = live().assetId;
    button(insp.el, 'Replace picture').click();
    await vi.waitFor(() => expect(live().assetId).not.toBe(before));
    expect(store.project.assets[live().assetId].name).toMatch(/Graphite/);
    expect(live().adjust.exposure).toBe(0);
    expect(live().pictureSize).toEqual({ width: 72, height: 40.5 });
    store.undo();
    expect(live().assetId).toBe(before);
    expect(live().adjust.exposure).toBe(20);
    insp.dispose();
  });

  it('keeps a running restyle and its picture across tab changes, and imports the picture once', async () => {
    const { insp, ctx, store } = env();
    let finish;
    ctx.restyleServices.restyle = vi.fn(() => new Promise((r) => (finish = () => r({ blob: new Blob(['r'], { type: 'image/png' }) }))));
    const importFile = vi.spyOn(ctx.library, 'importFile');
    const tab = (name) => [...insp.el.querySelectorAll('[role=tab]')].find((t) => t.textContent === name).click();
    [...insp.el.querySelectorAll('.restyle-chip')].find((b) => b.textContent === 'Graphite').click();
    button(insp.el, 'Restyle').click();
    await vi.waitFor(() => expect(finish).toBeTruthy());
    // Leaving and coming back shows the same job, and it cannot be started again.
    tab('Animation');
    tab('Style');
    [...insp.el.querySelectorAll('.restyle-chip')].find((b) => b.textContent === 'Graphite').click();
    expect(button(insp.el, 'Restyle').disabled).toBe(true);
    button(insp.el, 'Restyle').click();
    expect(ctx.restyleServices.restyle).toHaveBeenCalledTimes(1);
    // The picture arrives while another tab is open and is there on return.
    tab('Animation');
    finish();
    await new Promise((r) => setTimeout(r, 5));
    tab('Style');
    expect(insp.el.querySelector('.restyle-result img')).toBeTruthy();
    const assets = Object.keys(store.project.assets).length;
    button(insp.el, 'Save to media').click();
    button(insp.el, 'Save to media').click();
    button(insp.el, 'Add as clip').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(importFile).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.project.assets).length).toBe(assets + 1);
    insp.el.querySelector('[aria-label="Discard result"]').click();
    expect(insp.el.querySelector('.restyle-result img')).toBeNull();
    insp.dispose();
  });

  it('adds a restyled picture as a new clip over the source', async () => {
    const { ctx, store, img } = env();
    const asset = normalizeAsset({ kind: 'image', name: 'r.png', width: 10, height: 10 });
    store.update('add', (p) => (p.assets[asset.id] = asset), { structural: false });
    const c = addRestyledClip(ctx, img.id, asset);
    const f = findClip(store.project, c.id);
    expect(f.track.main).toBeFalsy();
    expect(f.clip).toMatchObject({ type: 'image', assetId: asset.id, start: img.start, duration: img.duration });
    expect(replacePicture(ctx, c.id, asset)).toBeTruthy();
    document.querySelector('.inspector')?.remove();
  });

  it.each(['image', 'video'])('keeps a restyled %s aligned through animated inherited motion and reopening', (type) => {
    const p = fixture();
    const [, source] = onMain(p, clip('image', 0, 1), clip(type, 1, 4));
    source.transform.rotation = -20;
    source.keyframes.x = [{ t: 0, v: -0.1, ease: 'easeIn' }, { t: s(4), v: 0.2 }];
    source.opacity = 0.7;
    const group = createCompound(p, [source.id]);
    Object.assign(group.transform, { x: 0.3, y: -0.1, sx: 0.6, sy: 1.4, rotation: 35, flipH: true });
    group.animLoop = { id: 'float', duration: s(2) };
    const [flat] = breakApart(p, group.id);
    const store = new EditorStore(p);
    store.seek(s(2));
    const asset = normalizeAsset({ ...p.assets[flat.assetId], id: 'restyled', kind: 'image', name: 'New picture' });
    p.assets[asset.id] = asset;
    const before = structuredClone(flat);
    const added = addRestyledClip({ store }, flat.id, asset);
    const compare = (project) => {
      for (const time of [2.1, 2.7, 3.2].map(s)) {
        const layers = evaluate(project, time);
        const original = layers.find((l) => l.clip.id === flat.id), result = layers.find((l) => l.clip.id === added.id);
        expect(result).toBeTruthy();
        for (const field of ['x', 'y', 'scale', 'rotation', 'sx', 'sy', 'skew', 'opacity', 'blur']) expect(result[field] ?? 0, field).toBeCloseTo(original[field] ?? 0, 8);
        expect(result.flipH).toBe(original.flipH);
        expect(result.flipV).toBe(original.flipV);
      }
    };
    expect(flat).toEqual(before);
    compare(store.project);
    compare(normalizeProject(JSON.parse(JSON.stringify(store.projectForSave()))));
    store.undo();
    expect(findClip(store.project, added.id)).toBeNull();
    store.redo();
    compare(store.project);
  });
});
