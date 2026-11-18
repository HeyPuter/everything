import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine/exporter.js', () => ({ renderStill: vi.fn(async () => ({ width: 64, height: 36, close: vi.fn() })) }));
import { renderStill } from '../src/engine/exporter.js';
import { clipPicture, replacePicture } from '../src/ui/inspector/stylize.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { normalizeProject } from '../src/model/project.js';
import { setTransition } from '../src/model/timeline.js';
import { evaluate, clipLayer } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { findClip } from '../src/model/timeline.js';
import { defaultMask } from '../src/model/masks.js';

beforeEach(() => {
  renderStill.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['picture'], { type: 'image/png' })));
});
afterEach(() => vi.restoreAllMocks());

async function capture(p, c, time) {
  const before = structuredClone(p);
  const result = await clipPicture({ store: { project: p }, library: {} }, c, time);
  expect(result.blob.type).toBe('image/png');
  expect(p).toEqual(before);
  const [project, , at] = renderStill.mock.lastCall;
  return evaluate(project, at);
}

describe('isolated pictures for AI restyling', () => {
  it.each(['image', 'video'])('retains animated color masks in a %s source capture', async (type) => {
    const p = fixture();
    const mask = { ...defaultMask('rectangle'), x: -0.25, w: 0.5, h: 1 };
    const [c] = onMain(p, clip(type, 1, 4, { masks: [mask], maskUse: 'color', adjust: { exposure: 20 } }));
    c.keyframes['mask0.x'] = [{ t: 0, v: -0.25 }, { t: s(4), v: 0.25 }];
    const [layer] = await capture(p, c, s(2));
    expect(layer.maskUse).toBe('color');
    expect(layer.masks).toHaveLength(1);
    expect(layer.masks[0].x).toBe(-0.125);
    expect(layer.adjust.exposure).toBe(20);
    expect(layer.opacity).toBe(1);
  });

  it('keeps alpha masks on the timeline rather than clipping the source capture', async () => {
    const p = fixture();
    const [c] = onMain(p, clip('image', 0, 4, { masks: [defaultMask('ellipse')] }));
    c.keyframes['mask0.x'] = [{ t: 0, v: 0.2 }];
    const [layer] = await capture(p, c, s(1));
    expect(layer.masks).toHaveLength(0);
    expect(layer.clip.keyframes['mask0.x']).toBeUndefined();
  });

  it.each(['image', 'video'])('fits a cropped %s capture to the visible source aspect ratio', async (type) => {
    const p = fixture();
    Object.assign(p.settings, { width: 72, height: 128 });
    const [c] = onMain(p, clip(type, 0, 4, { crop: { l: 0.25, r: 0, t: 0, b: 0 } }));
    Object.assign(p.assets[c.assetId], { width: 128, height: 72 });
    await capture(p, c, s(1));
    expect(renderStill.mock.lastCall[0].settings).toMatchObject({ width: 96, height: 72 });
  });

  it.each(['unequal axes', 'animated'])('omits inherited %s after flattening and reopening', async (motion) => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1), crop: { l: 0.1, t: 0, r: 0, b: 0 }, adjust: { exposure: 20 } }));
    const group = createCompound(p, [c.id]);
    Object.assign(group.transform, { x: 0.3, y: -0.2, scale: 0.5, rotation: 35 });
    group.opacity = 0.4;
    if (motion === 'unequal axes') Object.assign(group.transform, { sx: 0.6, sy: 1.5 });
    else group.animLoop = { id: 'float', duration: s(2) };
    breakApart(p, group.id);
    const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
    const flat = reopened.tracks.flatMap((t) => t.clips).find((c) => c.assetId);
    expect(flat.inherited?.length).toBeGreaterThan(0);
    const [layer] = await capture(reopened, flat, s(0.75));
    expect(layer).toMatchObject({ kind: 'media', x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotation: 0, opacity: 1 });
    expect(layer.sourceTime).toBe(s(1.75));
    expect(layer.crop).toEqual(flat.crop);
    expect(layer.adjust.exposure).toBe(20);
  });

  it.each(['image', 'video'])('captures only the selected %s source inside a retained transition', async (type) => {
    const p = fixture();
    const [a, b] = onMain(p, clip(type, 0, 2), clip(type, 2, 2, { assetId: 'silent', in: s(1) }));
    setTransition(p, a.id, 'mix', s(1));
    const group = createCompound(p, [a.id, b.id]);
    Object.assign(group, { start: s(3), in: s(1.6), duration: s(0.3) });
    const [flat] = breakApart(p, group.id);
    expect(flat.transitionSlices).toHaveLength(1);
    const at = s(3.15), expectedTime = clipLayer(p, flat, at, 0).sourceTime;
    const layers = await capture(p, flat, at);
    expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe('media');
    expect(layers[0].asset.id).toBe(flat.assetId);
    expect(layers[0].sourceTime).toBe(expectedTime);
  });
});


describe('replacing a captured picture', () => {
  function setup() {
    const p = fixture();
    const [c] = onMain(p, clip('image', 0, 4, {
      adjust: { exposure: 20, contrast: 15 }, crop: { l: 0.1, r: 0, t: 0, b: 0 },
      filter: { id: 'warm', intensity: 40 }, denoise: { on: true, strength: 30 },
      enhance: { on: true, strength: 35 }, effects: [{ id: 'vignette', params: { strength: 40 } }],
    }));
    c.transform.rotation = 25;
    c.keyframes.x = [{ t: 0, v: 0 }, { t: s(4), v: 0.3 }];
    const store = new EditorStore(normalizeProject(p));
    const ctx = { store, library: {}, player: { pause() {} } };
    ctx.actions = createActions(ctx);
    const live = () => findClip(store.project, c.id).clip;
    const asset = { ...store.project.assets[live().assetId], id: 'replacement', name: 'Restyled' };
    store.project.assets[asset.id] = asset;
    return { ctx, store, live, asset };
  }

  it('does not reapply baked color, crop, or source effects, and restores them with undo', async () => {
    const { ctx, store, live, asset } = setup();
    const original = structuredClone(live());
    const picture = await clipPicture(ctx, live(), s(1));
    replacePicture(ctx, live().id, asset, picture.baked);
    expect(live().adjust.exposure).toBe(0);
    expect(live().adjust.contrast).toBe(0);
    expect(live().crop).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    expect(live().filter).toBeNull();
    expect(live().denoise).toBeUndefined();
    expect(live().enhance).toBeUndefined();
    expect(live().transform).toEqual(original.transform);
    expect(live().effects).toEqual(original.effects);
    expect(live().keyframes.x).toEqual(original.keyframes.x);
    const replaced = structuredClone(live());
    expect(findClip(normalizeProject(store.projectForSave()), live().id).clip).toEqual(replaced);
    store.undo();
    expect(live()).toEqual(original);
    store.redo();
    expect(live()).toEqual(replaced);
  });

  it('captures animated color at the requested frame and consumes only its captured keys', async () => {
    const { ctx, live, asset } = setup();
    live().keyframes['adjust.exposure'] = [{ t: 0, v: 0 }, { t: s(4), v: 40 }];
    const picture = await clipPicture(ctx, live(), s(1));
    const [project, , time] = renderStill.mock.lastCall;
    expect(evaluate(project, time)[0].adjust.exposure).toBe(10);
    replacePicture(ctx, live().id, asset, picture.baked);
    expect(live().keyframes['adjust.exposure']).toBeUndefined();
    expect(live().keyframes.x).toHaveLength(2);
    expect(live().adjust.exposure).toBe(0);
  });

  it('keeps inactive source controls that were not rendered into the picture', async () => {
    const { ctx, live, asset } = setup();
    live().denoise.on = false;
    const before = structuredClone(live().denoise);
    const picture = await clipPicture(ctx, live(), s(1));
    replacePicture(ctx, live().id, asset, picture.baked);
    expect(live().denoise).toEqual(before);
  });

  it('preserves adjustments and keys edited after capture while clearing unchanged settings', async () => {
    const { ctx, live, asset } = setup();
    const picture = await clipPicture(ctx, live(), s(1));
    live().adjust.exposure = 35;
    live().keyframes['enhance.strength'] = [{ t: 0, v: 70 }];
    replacePicture(ctx, live().id, asset, picture.baked);
    expect(live().adjust.exposure).toBe(35);
    expect(live().adjust.contrast).toBe(0);
    expect(live().enhance.strength).toBe(35);
    expect(live().keyframes['enhance.strength']).toEqual([{ t: 0, v: 70 }]);
    expect(live().denoise).toBeUndefined();
  });
});
