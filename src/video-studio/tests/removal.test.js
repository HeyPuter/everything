import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  REMOVAL_DEFAULT, MAX_REGIONS, normalizeRemoval, normalizeRegion, defaultRegion, removalAt, evaluateRegions, addRegion, removeRegion,
  setRegionValues, regionBounds, followKeys, regionProp, parseRegionProp, clearRegionKeys, regionFeather, removalActive,
} from '../src/model/removal.js';
import { normalizeClipExtras, enhanceAt, upscaleFactor, EXTRA_DEFAULTS } from '../src/model/clip-extras.js';
import { baseValue, setBaseValue } from '../src/model/keyframes.js';
import { normalizeClip, makeClip, createProject } from '../src/model/project.js';
import { evaluate } from '../src/engine/scene.js';
import * as SF from '../src/engine/source-fx.js';
import { Compositor } from '../src/engine/compositor.js';
import { captureAttributes, applyAttributes, attributeGroupsFor } from '../src/ui/organize-actions.js';
import { propLabel } from '../src/ui/timeline/keyframe-panel.js';
import { trackBox, trackSize, trackTimes, followRegion } from '../src/ui/removal-track.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { removeEdit } from '../src/ui/remove-edit-state.js';
import { createRemovalOverlay } from '../src/ui/removal-overlay.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

const box = (x, y, w, h) => ({ ...defaultRegion('rectangle', { x, y, w, h }) });
const brush = (pts, size = 0.1, extra = {}) => ({ ...defaultRegion('brush'), strokes: [{ size, erase: false, pts }], ...extra });

/* Model ------------------------------------------------------------------------ */

describe('object removal model', () => {
  it('normalizes saved removal settings and regions', () => {
    expect(normalizeRemoval(null)).toBeNull();
    const out = normalizeRemoval({
      on: false, feather: 400, grain: -5,
      regions: [
        { id: 'r1', type: 'rectangle', x: 0.1, y: -0.2, w: 0.3, h: 0.1, rotation: 0, hidden: true },
        { type: 'brush', strokes: [{ size: 0.05, pts: [0, 0, 0.1, 0.1] }, { pts: [] }] },
        { type: 'star' },
        'nope',
      ],
    });
    expect(out).toMatchObject({ on: false, feather: 100, grain: 0 });
    expect(out.regions).toHaveLength(2);
    expect(out.regions[0]).toEqual({ id: 'r1', type: 'rectangle', x: 0.1, y: -0.2, w: 0.3, h: 0.1, rotation: 0, hidden: true });
    expect(out.regions[1]).toMatchObject({ type: 'brush', w: 1, h: 1, strokes: [{ size: 0.05, erase: false, pts: [0, 0, 0.1, 0.1] }] });
    expect(out.regions[1].id).toMatch(/^rg/);
    expect(normalizeRemoval({}).regions).toEqual([]);
    expect(normalizeRemoval({ regions: Array.from({ length: 20 }, () => box(0, 0, 0.1, 0.1)) }).regions).toHaveLength(MAX_REGIONS);
    expect(normalizeRegion({ type: 'rectangle', w: 'x' })).toMatchObject({ w: 0.6 });
  });

  it('survives project normalization on video and image clips', () => {
    const removal = { on: true, feather: 20, grain: 50, regions: [box(0, 0, 0.2, 0.2)] };
    const v = normalizeClip({ ...makeClip('video', { assetId: 'a', duration: US }), removal });
    expect(v.removal).toEqual(removal);
    const i = normalizeClip({ ...makeClip('image', { assetId: 'a', duration: US }), removal });
    expect(i.removal.regions).toHaveLength(1);
    expect(normalizeClip(makeClip('video', { assetId: 'a', duration: US })).removal).toBeUndefined();
  });

  it('renders only when on with a visible shape, regions as feathered add masks', () => {
    const clip = { keyframes: {}, removal: { on: true, feather: 40, grain: 30, regions: [box(0.1, 0, 0.2, 0.2), defaultRegion('brush'), { ...box(0, 0, 0.1, 0.1), hidden: true }] } };
    const r = removalAt(clip, 0);
    expect(r.grain).toBeCloseTo(0.3);
    expect(r.masks).toHaveLength(1);
    expect(r.masks[0]).toMatchObject({ type: 'rectangle', mode: 'add', x: 0.1, feather: regionFeather(40), opacity: 1, invert: false });
    expect(removalActive(clip.removal)).toBe(true);
    expect(removalAt({ removal: { ...clip.removal, on: false } }, 0)).toBeNull();
    expect(removalAt({ removal: { on: true, regions: [defaultRegion('brush')] } }, 0)).toBeNull();
    expect(removalAt({}, 0)).toBeNull();
  });

  it('keyframes region positions as remove<i>.x / .y', () => {
    const clip = makeClip('video', { assetId: 'a', duration: 2 * US });
    addRegion(clip, box(0, 0, 0.2, 0.2));
    addRegion(clip, brush([0, 0]));
    expect(regionProp(1, 'x')).toBe('remove1.x');
    expect(parseRegionProp('remove12.y')).toEqual({ index: 12, key: 'y' });
    expect(parseRegionProp('mask0.x')).toBeNull();
    clip.keyframes['remove1.x'] = [{ t: 0, v: 0, ease: 'linear' }, { t: 2 * US, v: 0.4, ease: 'linear' }];
    expect(evaluateRegions(clip, US)[1].x).toBeCloseTo(0.2);
    expect(evaluateRegions(clip, US)[0].x).toBe(0);
    // Generic keyframe plumbing reads and writes the region.
    expect(baseValue(clip, 'remove0.y')).toBe(0);
    setBaseValue(clip, 'remove0.y', 0.25);
    expect(clip.removal.regions[0].y).toBe(0.25);
    // A keyed value gets a key at the playhead; an unkeyed one changes the region.
    setRegionValues(clip, 1, { x: 0.3, y: 0.1 }, US);
    expect(clip.keyframes['remove1.x'].map((k) => k.v)).toEqual([0, 0.3, 0.4]);
    expect(clip.removal.regions[1].y).toBe(0.1);
  });

  it('keeps later region keys in line when one is removed', () => {
    const clip = makeClip('image', { assetId: 'a', duration: US });
    for (let i = 0; i < 3; i++) addRegion(clip, box(i / 10, 0, 0.1, 0.1));
    clip.keyframes['remove0.x'] = [{ t: 0, v: 1, ease: 'linear' }];
    clip.keyframes['remove2.x'] = [{ t: 0, v: 3, ease: 'linear' }];
    removeRegion(clip, 1);
    expect(clip.removal.regions.map((r) => r.x)).toEqual([0, 0.2]);
    expect(clip.keyframes['remove0.x'][0].v).toBe(1);
    expect(clip.keyframes['remove1.x'][0].v).toBe(3);
    expect(clip.keyframes['remove2.x']).toBeUndefined();
    clearRegionKeys(clip, 0);
    expect(clip.keyframes['remove0.x']).toBeUndefined();
    expect(clip.keyframes['remove1.x']).toBeDefined();
    expect(removeRegion(clip, 9)).toBe(false);
    const full = makeClip('image', { assetId: 'a', duration: US });
    for (let i = 0; i < MAX_REGIONS; i++) addRegion(full, box(0, 0, 0.1, 0.1));
    expect(addRegion(full, box(0, 0, 0.1, 0.1))).toBe(-1);
  });

  it('measures region bounds for boxes and paintings', () => {
    expect(regionBounds(box(0, 0, 0.2, 0.4))).toEqual({ x: 0.4, y: 0.3, w: expect.closeTo(0.2), h: expect.closeTo(0.4) });
    // Clamped to the picture.
    expect(regionBounds(box(-0.5, 0, 0.2, 0.2)).x).toBe(0);
    // A painting's bounds include the brush width (a fraction of the short side).
    const b = regionBounds(brush([0, 0, 0.1, 0], 0.1), 2);
    expect(b.x).toBeCloseTo(0.5 - 0.025);
    expect(b.w).toBeCloseTo(0.1 + 0.05);
    expect(b.y).toBeCloseTo(0.45);
    expect(b.h).toBeCloseTo(0.1);
    expect(regionBounds(defaultRegion('brush'))).toBeNull();
    expect(regionBounds({ ...box(0, 0, 0.1, 0.1), hidden: true })).toBeNull();
  });

  it('turns tracked points into position keys that keep the offset at the playhead', () => {
    const region = { ...box(0.1, 0.05, 0.1, 0.1) };
    const points = [{ t: 2 * US, x: 0.7, y: 0.5 }, { t: 0, x: 0.5, y: 0.5 }, { t: US, x: 0.6, y: 0.55 }];
    const keys = followKeys(region, points, US);
    expect(keys.x.map((k) => k.t)).toEqual([0, US, 2 * US]);
    expect(keys.x.map((k) => k.v)).toEqual([0, 0.1, 0.2]);
    expect(keys.y.map((k) => k.v)).toEqual([0, 0.05, 0]);
    expect(followKeys(region, [], 0)).toBeNull();
  });
});

describe('enhance quality model', () => {
  it('normalizes, keyframes strength and reaches the layer', () => {
    expect(normalizeClipExtras({ enhance: { strength: 300 } }, {}).enhance).toEqual({ on: true, strength: 100 });
    expect(normalizeClipExtras({ enhance: { on: false } }, {}).enhance).toEqual({ ...EXTRA_DEFAULTS.enhance, on: false });
    const clip = { keyframes: { 'enhance.strength': [{ t: 0, v: 0, ease: 'linear' }, { t: US, v: 80, ease: 'linear' }] }, enhance: { on: true, strength: 50 } };
    expect(enhanceAt(clip, US / 2)).toEqual({ strength: 0.4 });
    expect(enhanceAt(clip, 0)).toBeNull();
    expect(enhanceAt({ enhance: { on: false, strength: 50 } }, 0)).toBeNull();
    expect(enhanceAt({}, 0)).toBeNull();
  });

  it('knows when a source is smaller than the frame', () => {
    expect(upscaleFactor(640, 360, 1920, 1080)).toBe(3);
    expect(upscaleFactor(1920, 1080, 1920, 1080)).toBe(1);
    expect(upscaleFactor(0, 0, 1920, 1080)).toBe(0);
  });

  it('puts removal and enhance on scene layers', () => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'a.png', width: 640, height: 360, duration: 0 };
    const c = makeClip('image', { assetId: 'a', duration: 2 * US });
    c.removal = { ...REMOVAL_DEFAULT, regions: [box(0, 0, 0.2, 0.2)] };
    c.enhance = { on: true, strength: 60 };
    T.mainTrack(p).clips.push(c);
    const layer = evaluate(p, US).find((l) => l.clip?.id === c.id);
    expect(layer.removal.masks).toHaveLength(1);
    expect(layer.enhance).toEqual({ strength: 0.6 });
    c.removal.on = false;
    c.enhance.on = false;
    const off = evaluate(p, US).find((l) => l.clip?.id === c.id);
    expect(off.removal).toBeNull();
    expect(off.enhance).toBeNull();
  });

  it('copies with paste attributes and presets, with their keyframes', () => {
    const src = makeClip('video', { assetId: 'a', duration: 2 * US });
    src.enhance = { on: true, strength: 70 };
    src.removal = { ...REMOVAL_DEFAULT, regions: [box(0, 0, 0.1, 0.1)] };
    src.keyframes['remove0.x'] = [{ t: 0, v: 0, ease: 'linear' }, { t: 2 * US, v: 0.2, ease: 'linear' }];
    src.keyframes['enhance.strength'] = [{ t: US, v: 20, ease: 'linear' }];
    expect(attributeGroupsFor(src).map((g) => g.id)).toEqual(expect.arrayContaining(['enhance', 'removal']));
    const dst = makeClip('image', { assetId: 'b', duration: 4 * US });
    applyAttributes(dst, captureAttributes(src), ['enhance', 'removal'], src.duration);
    expect(dst.enhance).toEqual(src.enhance);
    expect(dst.removal).toEqual(src.removal);
    expect(dst.removal).not.toBe(src.removal);
    expect(dst.keyframes['remove0.x'][1].t).toBe(4 * US);
    expect(dst.keyframes['enhance.strength'][0].t).toBe(2 * US);
  });

  it('names region keyframes in the keyframe lane', () => {
    expect(propLabel('remove0.x')).toBe('Removal region 1 position X');
    expect(propLabel('remove2.y')).toBe('Removal region 3 position Y');
    expect(propLabel('enhance.strength')).toBe('Enhance strength');
  });
});

/* Engine --------------------------------------------------------------------------- */

const code = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('source pass shaders', () => {
  const sources = Object.entries({
    REMOVE_PREP_FS: SF.REMOVE_PREP_FS, REMOVE_DETAIL_FS: SF.REMOVE_DETAIL_FS, PULL_FS: SF.PULL_FS, PUSH_FS: SF.PUSH_FS,
    REMOVE_FINAL_FS: SF.REMOVE_FINAL_FS, UPSCALE_FS: SF.UPSCALE_FS, ENHANCE_FS: SF.ENHANCE_FS,
  });

  it.each(sources)('%s is GLSL ES 3.00 with one main() writing outColor', (name, src) => {
    expect(src.startsWith('#version 300 es\n')).toBe(true);
    const c = code(src);
    expect(c.match(/\bvoid\s+main\s*\(\s*\)/g)).toHaveLength(1);
    expect(c).toMatch(/precision\s+highp\s+float;/);
    expect(c).toMatch(/\bout\s+vec4\s+outColor;/);
    expect(c.slice(c.search(/\bvoid\s+main\s*\(/))).toMatch(/\boutColor\s*=/);
    expect(src).not.toMatch(/gl_FragColor|texture2D\s*\(|\bvarying\b|undefined|NaN|\$\{/);
    for (const [open, close] of [['(', ')'], ['{', '}'], ['[', ']']]) {
      let depth = 0;
      for (const ch of c) {
        if (ch === open) depth++;
        else if (ch === close) depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${name} ${open}${close}`).toBe(0);
    }
  });

  it('fills holes from known pixels only and keeps known pixels exact', () => {
    // Pull weighs by how known each pixel is; push keeps a fully known pixel as it is.
    expect(SF.PULL_FS).toMatch(/acc \+= s\.rgb \* \(w \* s\.a\)/);
    expect(SF.PUSH_FS).toMatch(/mix\(coarse, fine\.rgb, fine\.a\)/);
    // The hole reaches into the feather; the blend is soft.
    expect(SF.REMOVE_PREP_FS).toMatch(/smoothstep\(0\.02, 0\.12, cov\)/);
    expect(SF.REMOVE_FINAL_FS).toMatch(/smoothstep\(0\.02, 0\.5, cov\)/);
    // Upscaling is clamped to the nearest pixels (no ringing), sharpening to the local range (no halos).
    expect(SF.UPSCALE_FS).toMatch(/clamp\(acc \/ wsum, lo, hiC\)/);
    expect(SF.ENHANCE_FS).toMatch(/clamp\(sharp, mn2, mx2\)/);
  });

  it('sizes the pyramid, the fill and the enhanced picture', () => {
    const levels = SF.pyramidLevels(5, 3);
    expect(levels).toEqual([{ w: 5, h: 3 }, { w: 3, h: 2 }, { w: 2, h: 1 }, { w: 1, h: 1 }]);
    expect(SF.pyramidLevels(1, 1)).toEqual([{ w: 1, h: 1 }]);
    expect(SF.fillSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(SF.fillSize(4096, 2160)).toEqual({ w: 2048, h: 1080 });
    // Not shown larger: enhance at the source size.
    expect(SF.enhanceSize(1920, 1080, 960)).toEqual({ w: 1920, h: 1080, scale: 1 });
    expect(SF.enhanceSize(640, 360, 700)).toEqual({ w: 640, h: 360, scale: 1 });
    // Shown 3x: upscale in quarter steps, capped.
    expect(SF.enhanceSize(640, 360, 1920)).toEqual({ w: 1920, h: 1080, scale: 3 });
    expect(SF.enhanceSize(640, 360, 1500)).toEqual({ w: 1440, h: 810, scale: 2.25 });
    expect(SF.enhanceSize(320, 180, 3840).scale).toBe(SF.UPSCALE_MAX);
    expect(SF.enhanceSize(2000, 1000, 8000).w).toBeLessThanOrEqual(4096);
    expect(SF.enhanceAmounts(0.5, 1)).toEqual({ sharp: 0.5, detail: 0.3, step: 1 });
    expect(SF.enhanceAmounts(1, 3).step).toBeCloseTo(1.8);
  });
});

/** A WebGL2 stand-in that records draws, enough for the compositor to run. */
function fakeGl() {
  let n = 0;
  const draws = [];
  const consts = new Map();
  const impl = {
    draws,
    createTexture: () => ({ tex: ++n }),
    createFramebuffer: () => ({ fb: ++n }),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
    createShader: () => ({}),
    createProgram: () => ({ prog: ++n }),
    getShaderParameter: () => true,
    getProgramParameter: (p, name) => (name === proxy.ACTIVE_UNIFORMS ? 0 : true),
    getParameter: () => proxy.TEXTURE0,
    isEnabled: () => true,
    getExtension: () => null,
    drawArrays: () => draws.push(impl.current),
    useProgram: (p) => {
      impl.current = p;
    },
  };
  const proxy = new Proxy(impl, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) {
        if (!consts.has(prop)) consts.set(prop, consts.size + 1);
        return consts.get(prop);
      }
      return () => {};
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  });
  return proxy;
}

describe('compositor wiring', () => {
  let comp;
  let gl;
  let keys;
  const clip = { id: 'c1', type: 'image' };
  const base = { kind: 'media', clip, x: 0, y: 0, scale: 1, rotation: 0, sx: 1, sy: 1, opacity: 1, blur: 0, width: 320, height: 180, crop: null, adjust: null, masks: [], extras: null };
  const settings = { background: { type: 'color', color: '#000000' } };
  const removal = { masks: [{ ...box(0, 0, 0.2, 0.2), mode: 'add', feather: 4, opacity: 1, invert: false }], grain: 0.5 };

  beforeEach(() => {
    gl = fakeGl();
    const canvas = { width: 0, height: 0, getContext: () => gl };
    comp = new Compositor(canvas, { resolve: () => ({ key: 'img:a', source: {}, width: 320, height: 180, version: 1 }) });
    comp.resize(1280, 720, 1920, 1080);
    comp._removalRaster = { get: vi.fn(() => ({ canvas: {}, key: 'cover1', width: 128, height: 72 })), dispose() {} };
    keys = [];
    const program = comp._program.bind(comp);
    comp._program = (key, vs, fs) => {
      keys.push(key);
      return program(key, vs, fs);
    };
  });

  const layerDrawTex = () => {
    // The texture bound on unit 0 for the clip's own draw.
    const calls = [];
    const bind = comp._bindTex.bind(comp);
    comp._bindTex = (unit, tex) => {
      calls.push([unit, tex, keys[keys.length - 1]]);
      bind(unit, tex);
    };
    return calls;
  };

  it('draws plain layers straight from the upload', () => {
    comp.render([base], { settings, time: 0 });
    expect(keys.some((k) => k.startsWith('srcfx'))).toBe(false);
  });

  it('fills removal regions with a push-pull pyramid before the clip is drawn', () => {
    const binds = layerDrawTex();
    comp.render([{ ...base, removal }], { settings, time: 0 });
    const levels = SF.pyramidLevels(320, 180).length;
    const count = (k) => keys.filter((x) => x === k).length;
    expect(count('srcfx-prep')).toBe(1);
    // Colors and grain each pull down and push back up.
    expect(count('srcfx-pull')).toBe(2 * (levels - 1));
    expect(count('srcfx-push')).toBe(2 * (levels - 1));
    expect(count('srcfx-detail')).toBe(1);
    expect(keys.indexOf('srcfx-final')).toBeLessThan(keys.lastIndexOf('layer'));
    const out = [...comp.clipFxPool.entries()].find(([k]) => k.startsWith('srcfx-rm:c1'))[1];
    expect(out.w).toBe(320);
    expect(binds.filter(([unit, , k]) => unit === 0 && k === 'layer').at(-1)[1]).toBe(out.tex);
    expect(comp._removalRaster.get).toHaveBeenCalledWith('rm:c1', removal.masks, 320, 180, 320);
  });

  it('reuses the result for the same frame and redraws when the regions change', () => {
    comp.render([{ ...base, removal }], { settings, time: 0 });
    keys.length = 0;
    comp.render([{ ...base, removal }], { settings, time: 0 });
    expect(keys).not.toContain('srcfx-prep');
    comp._removalRaster.get.mockReturnValue({ canvas: {}, key: 'cover2', width: 128, height: 72 });
    comp.render([{ ...base, removal }], { settings, time: 0 });
    expect(keys).toContain('srcfx-prep');
  });

  it('skips the grain pyramid at no grain', () => {
    comp.render([{ ...base, removal: { ...removal, grain: 0 } }], { settings, time: 0 });
    expect(keys).not.toContain('srcfx-detail');
  });

  it('enhances at the shown size, upscaling small sources first', () => {
    // 320 wide shown across 1280 output pixels: four times, capped at three.
    comp.render([{ ...base, enhance: { strength: 0.5 } }], { settings, time: 0 });
    expect(keys.filter((k) => k.startsWith('srcfx'))).toEqual(['srcfx-up', 'srcfx-enhance']);
    const out = [...comp.clipFxPool.entries()].find(([k]) => k.startsWith('srcfx-en:c1'))[1];
    expect([out.w, out.h]).toEqual([960, 540]);
    // Shown smaller than the source: no upscale.
    keys.length = 0;
    comp.render([{ ...base, scale: 0.2, enhance: { strength: 0.5 } }], { settings, time: 0 });
    expect(keys.filter((k) => k.startsWith('srcfx'))).toEqual(['srcfx-enhance']);
  });

  it('runs removal, then enhance, and returns the picture the layer draws', () => {
    comp.render([{ ...base, removal, enhance: { strength: 1 } }], { settings, time: 0 });
    const order = keys.filter((k) => k === 'srcfx-final' || k === 'srcfx-up' || k === 'srcfx-enhance' || k === 'layer');
    expect(order.slice(-4)).toEqual(['srcfx-final', 'srcfx-up', 'srcfx-enhance', 'layer']);
    const entry = SF.processSource(comp, { ...base, removal, enhance: { strength: 1 } }, { key: 'img:a', width: 320, height: 180, version: 1 }, { tex: {}, w: 320, h: 180, version: 1 });
    expect([entry.w, entry.h, entry.ok]).toEqual([960, 540, true]);
    // Nothing to do: the upload comes back as it is.
    const plain = { tex: {}, w: 320, h: 180 };
    expect(SF.processSource(comp, base, {}, plain)).toBe(plain);
  });
});

/* Tracking ----------------------------------------------------------------------- */

describe('follow motion', () => {
  it('sizes the tracking frames and box', () => {
    expect(trackSize(16 / 9)).toEqual({ tw: 320, th: 180 });
    expect(trackSize(9 / 16)).toEqual({ tw: 180, th: 320 });
    expect(trackBox({ x: 0.5, y: 0.5, w: 0.01, h: 0.2 }, 320, 180)).toEqual({ x: 160 + 1.6 - 6, y: 90 + 18 - 18, w: 12, h: 36 });
    const { fwd, back } = trackTimes(US, 2 * US, 10);
    expect(fwd[0]).toBe(US);
    expect(fwd).toHaveLength(10);
    expect(back[0]).toBe(US - US / 10);
    expect(back.at(-1)).toBe(0);
  });

  it('keys a region along a moving bright square', async () => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'video', name: 'v.mp4', width: 320, height: 180, duration: US, hasVideo: true };
    const c = makeClip('video', { assetId: 'a', duration: US });
    addRegion(c, box(-0.25, 0, 0.1, 0.1));
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    // A square that starts at x = 0.25 of the frame and moves right by 4 pixels a frame.
    const frameAt = (k) => {
      const f = new Float32Array(320 * 180);
      for (let y = 80; y < 100; y++) for (let x = 70 + 4 * k; x < 90 + 4 * k; x++) f[y * 320 + x] = 1;
      for (let i = 0; i < f.length; i += 7) f[i] += 0.05;
      return f;
    };
    const frames = async (srcTimes) => srcTimes.map((t) => ({ t, frame: frameAt(Math.round((t / US) * 15)) }));
    const progress = vi.fn();
    const n = await followRegion(ctx, c.id, 0, { frames, onProgress: progress });
    expect(n).toBeGreaterThan(0);
    const keys = T.findClip(store.project, c.id).clip.keyframes['remove0.x'];
    expect(keys[0].v).toBeCloseTo(-0.25, 2);
    // About 4 / 320 of the width per 1/15 s: + 0.17 over the second.
    expect(keys.at(-1).v).toBeGreaterThan(-0.25 + 0.12);
    expect(progress).toHaveBeenLastCalledWith(1);
  });
});

/* Inspector ------------------------------------------------------------------------- */

describe('remove panel', () => {
  let env;
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'p.jpg', duration: 0, width: 640, height: 360, fps: 0, hasVideo: false, hasAudio: false };
    const c = makeClip('image', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    store.select(c.id);
    insp.showVideoSub('remove');
    env = { store, el: insp.el, id: c.id, insp };
  });
  afterEach(() => env.el.remove());
  const clip = () => T.findClip(env.store.project, env.id).clip;
  const field = (label) => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.firstChild?.textContent === label);
  const button = (text) => [...env.el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const drag = (label, v) => {
    const input = field(label).querySelector('input[type=range]');
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('opens on the preview editor for this clip with tools and an empty list', () => {
    expect(removeEdit.active(env.id)).toBe(true);
    expect(env.el.querySelector('.removal-tab')).not.toBeNull();
    expect([...env.el.querySelectorAll('.removal-tools [role=radio]')].map((b) => b.textContent)).toEqual(['Brush', 'Box', 'Erase']);
    expect(env.el.querySelector('.insp-empty').hidden).toBe(false);
    [...env.el.querySelectorAll('.removal-tools [role=radio]')].find((b) => b.textContent === 'Box').click();
    expect(removeEdit.tool).toBe('box');
    expect(env.el.querySelector('.removal-tool-hint').textContent).toMatch(/box/i);
  });

  it('adds a painted region, lists it, keys its position, and deletes it', () => {
    button('New painted region').click();
    expect(clip().removal).toMatchObject({ on: true, regions: [{ type: 'brush' }] });
    expect(env.el.querySelector('.removal-list .mask-row-name').textContent).toMatch(/1\. Painted \(empty\)/);
    expect(env.el.querySelector('.section-title')?.textContent).toBeTruthy();
    drag('Position X', 10);
    expect(clip().removal.regions[0].x).toBeCloseTo(0.1);
    env.el.querySelector('[aria-label="Add keyframe for Position X"]').click();
    expect(clip().keyframes['remove0.x']).toEqual([{ t: 0, v: expect.closeTo(0.1), ease: 'linear' }]);
    env.store.seek(US);
    drag('Position X', -20);
    expect(clip().keyframes['remove0.x'].map((k) => k.v)).toEqual([expect.closeTo(0.1), expect.closeTo(-0.2)]);
    expect(env.el.querySelector('.removal-list .mask-row-mode').textContent).toBe('Moves');
    env.el.querySelector('[aria-label="Delete region 1"]').click();
    expect(clip().removal.regions).toEqual([]);
    expect(clip().keyframes['remove0.x']).toBeUndefined();
    env.store.undo();
    expect(clip().removal.regions).toHaveLength(1);
    expect(clip().keyframes['remove0.x']).toHaveLength(2);
  });

  it('turns removal off and on, sets feather and grain, and resets', () => {
    button('New painted region').click();
    const sw = field('Remove objects').querySelector('[role=switch]');
    sw.click();
    expect(clip().removal.on).toBe(false);
    sw.click();
    expect(clip().removal.on).toBe(true);
    drag('Feather', 55);
    drag('Grain', 10);
    expect(clip().removal).toMatchObject({ feather: 55, grain: 10 });
    env.el.querySelector('[aria-label="Reset Remove object"]').click();
    expect(clip().removal).toEqual({ ...REMOVAL_DEFAULT, regions: [] });
  });

  it('offers follow motion only on video clips', () => {
    button('New painted region').click();
    expect(button('Follow motion').disabled).toBe(true);
  });
});

describe('enhance section', () => {
  let env;
  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'p.jpg', duration: 0, width: 640, height: 360, fps: 0, hasVideo: false, hasAudio: false };
    const c = makeClip('image', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    store.select(c.id);
    insp.showVideoSub('basic');
    env = { store, el: insp.el, id: c.id, p };
  });
  afterEach(() => env.el.remove());
  const clip = () => T.findClip(env.store.project, env.id).clip;

  it('turns on from its header, notes a small source, and keyframes strength', () => {
    const box = env.el.querySelector('[aria-label="Apply enhance quality"]');
    expect(box).not.toBeNull();
    const note = env.el.querySelector('.enhance-small');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/640 × 360, smaller than the 1920 × 1080 frame/);
    box.click();
    expect(clip().enhance).toEqual({ on: true, strength: 50 });
    const section = box.closest('.extra-section');
    const input = section.querySelector('input[type=range]');
    input.value = '80';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(clip().enhance.strength).toBe(80);
    env.store.update('Big picture', (p) => {
      p.assets.a.width = 3840;
      p.assets.a.height = 2160;
    });
    expect(note.hidden).toBe(true);
  });
});

/* On-canvas editor ------------------------------------------------------------------- */

describe('removal overlay', () => {
  let env;
  beforeEach(() => {
    const p = createProject();
    p.assets.a = { id: 'a', kind: 'image', name: 'p.jpg', duration: 0, width: 1920, height: 1080, fps: 0, hasVideo: false, hasAudio: false };
    const c = makeClip('image', { assetId: 'a', duration: 2 * US });
    T.mainTrack(p).clips.push(c);
    const store = new EditorStore(p);
    const ctx = { store };
    ctx.actions = createActions(ctx);
    const overlay = createRemovalOverlay({ store, actions: ctx.actions, stage: null });
    document.body.append(overlay.el);
    // Panel stand-in: editing is on for this clip.
    const panel = document.createElement('div');
    document.body.append(panel);
    removeEdit.open(panel, c.id);
    removeEdit.set({ index: 0, tool: 'brush', size: 0.05, show: true });
    const draw = () => {
      const layer = evaluate(store.project, US).find((l) => l.clip?.id === c.id);
      const box = Compositor.prototype.layerBox.call({ projW: 1920, projH: 1080 }, layer, { width: 1920, height: 1080 });
      overlay.draw(layer, box, 0.5, 960, 540);
      return layer;
    };
    store.seek(US);
    env = { store, overlay, panel, id: c.id, draw };
  });
  afterEach(() => {
    env.overlay.el.remove();
    env.panel.remove();
  });
  const clip = () => T.findClip(env.store.project, env.id).clip;
  const fire = (el, type, x, y, extra = {}) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }));
  const stroke = (pts, extra) => {
    env.draw();
    const catcher = env.overlay.el.querySelector('[data-rh]');
    fire(catcher, 'pointerdown', ...pts[0], extra);
    for (const p of pts.slice(1)) fire(env.overlay.el, 'pointermove', ...p, extra);
    fire(env.overlay.el, 'pointerup', ...pts.at(-1), extra);
  };

  it('is active only for the clip whose Remove panel is open', () => {
    const layer = env.draw();
    expect(env.overlay.active(layer)).toBe(true);
    expect(env.overlay.active({ ...layer, clip: { id: 'other' } })).toBe(false);
    env.panel.remove();
    expect(env.overlay.active(layer)).toBe(false);
  });

  it('paints a region with the brush as one undo step, then erases part of it', () => {
    stroke([[480, 270], [500, 270], [520, 280]]);
    const r = clip().removal;
    expect(r.on).toBe(true);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].type).toBe('brush');
    const s = r.regions[0].strokes[0];
    expect(s).toMatchObject({ size: 0.05, erase: false });
    // Css (480, 270) is the middle of the picture; 40 css px right is 80 source px of 1920.
    expect(s.pts.slice(0, 2)).toEqual([0, 0]);
    expect(s.pts.at(-2)).toBeCloseTo(80 / 1920, 3);
    // The tint shows the painting through an SVG mask.
    env.draw();
    expect(env.overlay.el.querySelectorAll('mask path')).toHaveLength(1);
    expect(env.overlay.el.querySelector('.removal-tint')).not.toBeNull();
    removeEdit.set({ tool: 'erase' });
    stroke([[490, 270], [495, 270]]);
    expect(clip().removal.regions[0].strokes.map((x) => x.erase)).toEqual([false, true]);
    env.store.undo();
    expect(clip().removal.regions[0].strokes).toHaveLength(1);
    env.store.undo();
    expect(clip().removal?.regions?.length || 0).toBe(0);
  });

  it('drags out a box, then moves and resizes it', () => {
    removeEdit.set({ tool: 'box' });
    stroke([[240, 135], [480, 270], [720, 405]]);
    const [r] = clip().removal.regions;
    expect(r).toMatchObject({ type: 'rectangle', x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(removeEdit.index).toBe(0);
    // Move by its center handle: 96 css px right = 0.1 of the width.
    env.draw();
    const center = env.overlay.el.querySelector('.mask-handle.center');
    fire(center, 'pointerdown', 480, 270);
    fire(env.overlay.el, 'pointermove', 576, 270);
    fire(env.overlay.el, 'pointerup', 576, 270);
    expect(clip().removal.regions[0].x).toBeCloseTo(0.1);
    // Drag the bottom-right corner in; the top-left stays.
    env.draw();
    const se = [...env.overlay.el.querySelectorAll('.mask-handle.corner')].find((el) => el.dataset.rh === 'se');
    fire(se, 'pointerdown', 816, 405);
    fire(env.overlay.el, 'pointermove', 720, 405);
    fire(env.overlay.el, 'pointerup', 720, 405);
    const b = clip().removal.regions[0];
    expect(b.w).toBeCloseTo(0.4);
    expect(b.x - b.w / 2).toBeCloseTo(-0.15);
  });

  it('moves a region with a key at the playhead once its position is keyed', () => {
    removeEdit.set({ tool: 'box' });
    stroke([[240, 135], [720, 405]]);
    env.store.update('key', (p) => {
      T.findClip(p, env.id).clip.keyframes['remove0.x'] = [{ t: 0, v: 0, ease: 'linear' }];
    });
    env.draw();
    fire(env.overlay.el.querySelector('.mask-handle.center'), 'pointerdown', 480, 270);
    fire(env.overlay.el, 'pointermove', 576, 270);
    fire(env.overlay.el, 'pointerup', 576, 270);
    expect(clip().keyframes['remove0.x'].map((k) => [k.t, k.v])).toEqual([[0, 0], [US, expect.closeTo(0.1)]]);
    expect(clip().removal.regions[0].x).toBe(0);
  });
});
