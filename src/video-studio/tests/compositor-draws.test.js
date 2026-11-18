// What the compositor draws for a frame, watched through a stand-in WebGL context:
// where each quad is placed, which programs run, and how often a source is uploaded.
import { describe, it, expect } from 'vitest';
import { Compositor } from '../src/engine/compositor.js';
import { boxPoint } from '../src/lib/geometry.js';
import { evaluate } from '../src/engine/scene.js';
import { createCompound } from '../src/model/compound.js';
import { fixture, clip, onMain, s } from './helpers.js';

function fakeGl(counts) {
  return new Proxy({}, {
    get(_, k) {
      if (k === 'getParameter') return () => 33984;
      if (k === 'isEnabled') return () => true;
      if (k === 'getExtension') return () => null;
      if (typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)) return 1;
      return () => {
        counts[k] = (counts[k] || 0) + 1;
        return {};
      };
    },
  });
}

/** A compositor with no real context: records programs used and quads placed. */
function fakeComp(resolve, W = 1920, H = 1080) {
  const counts = {};
  const c = Object.assign(Object.create(Compositor.prototype), { gl: fakeGl(counts), width: W, height: H, projW: W, projH: H, programs: new Map(), textures: new Map(), frame: 0, lost: false, resolve, curveTextures: new Map(), lutTextures: new Map() });
  c.programsUsed = [];
  c.targets = [];
  c._program = (key) => {
    c.programsUsed.push(key);
    c.targets.push(c._bound);
    return { prog: {}, u: new Map() };
  };
  c.quads = [];
  const matrix = Compositor.prototype._matrix;
  c._matrix = (cx, cy, w, h, r, skew = 0) => {
    c.quads.push({ cx, cy, w, h, r, ...(skew ? { skew } : {}), projW: c.projW, projH: c.projH });
    return matrix.call(c, cx, cy, w, h, r, skew);
  };
  c.counts = counts;
  return c;
}

const video = { key: 'vid:1', source: { tag: 'video' }, width: 1920, height: 1080, dynamic: true };
const draw = (p, t, info = video, size = [1920, 1080]) => {
  const c = fakeComp(() => info, ...size);
  const layers = evaluate(p, s(t));
  c.render(layers, { settings: p.settings, time: t });
  return { c, layers };
};

describe('uploads', () => {
  it('uploads a playing video once per frame, however often the frame draws it', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.keyframes.x = [{ t: 0, v: -0.2, ease: 'linear' }, { t: s(4), v: 0.2, ease: 'linear' }];
    a.motionBlur = { on: true, amount: 50 };
    const { c, layers } = draw(p, 3);
    expect(layers[0].extras.motion.length).toBeGreaterThan(4);
    expect(c.counts.texImage2D).toBe(1);
    // The next frame uploads the next picture.
    c.render(layers, { settings: p.settings, time: 3 });
    expect(c.counts.texImage2D).toBe(2);

    const q = fixture();
    onMain(q, clip('video', 0, 4));
    q.settings.background = { type: 'blur', blur: 0.5, color: '#000000' };
    expect(draw(q, 1).c.counts.texImage2D).toBe(1);
  });

  it('enhances a still once, also behind a blurred backdrop', () => {
    for (const type of ['color', 'blur']) {
      const p = fixture();
      Object.assign(p.settings, { width: 1080, height: 1920, background: { type, blur: 0.5, color: '#000000' } });
      Object.assign(p.assets.img, { width: 1920, height: 1080 });
      const [a] = onMain(p, clip('image', 0, 4));
      a.enhance = { on: true, strength: 50 };
      const c = fakeComp(() => ({ key: 'img:img', source: {}, width: 1920, height: 1080, version: 1 }), 1080, 1920);
      const passes = [];
      for (let f = 0; f < 3; f++) {
        c.programsUsed.length = 0;
        c.render(evaluate(p, s(1)), { settings: p.settings, time: 1 });
        passes.push(c.programsUsed.filter((k) => k.startsWith('srcfx')).length);
      }
      expect(passes[0]).toBeGreaterThan(0);
      expect(passes.slice(1)).toEqual([0, 0]);
    }
  });
});

describe('clips with effects', () => {
  it('apply a separate width scale once', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.transform.sx = 0.5;
    a.effects = [{ id: 'glitch', params: {}, on: true }];
    const { c } = draw(p, 1);
    const [inner, placed] = [c.quads[0], c.quads.at(-1)];
    // Inside its buffer the clip fills it, unsqueezed.
    expect(inner).toMatchObject({ w: 1920, h: 1080, projW: 1920, projH: 1080 });
    // Placed, it is half as wide and as tall as the frame.
    expect(placed).toMatchObject({ cx: 960, cy: 540, w: 960, h: 1080, projW: 1920, projH: 1080 });
  });
});

describe('clips with effects and motion blur', () => {
  it('draw the blur samples around the clip in its buffer and place the clip once', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.transform.scale = 0.5;
    a.keyframes.x = [{ t: 0, v: -0.2, ease: 'linear' }, { t: s(4), v: 0.2, ease: 'linear' }];
    a.motionBlur = { on: true, amount: 50 };
    a.effects = [{ id: 'glitch', params: {}, on: true }];
    const { c, layers } = draw(p, 3);
    const n = layers[0].extras.motion.length;
    const samples = c.quads.slice(0, n);
    // In the buffer (the clip's own size) every sample is full size, a little to either side of the middle.
    for (const q of samples) {
      expect(q).toMatchObject({ projW: 1920, projH: 1080 });
      expect(q.w).toBeCloseTo(1920, 3);
      expect(Math.abs(q.cx - 960)).toBeLessThan(40);
    }
    expect(samples[0].cx).toBeLessThan(960);
    expect(samples.at(-1).cx).toBeGreaterThan(960);
    // Placed once at the clip's place and half size.
    const placed = c.quads.at(-1);
    expect(placed.cx).toBeCloseTo(960 + layers[0].x * 1920, 3);
    expect(placed).toMatchObject({ w: 960, h: 540, projW: 1920 });
  });
});

describe('clips with effects and a canvas fill', () => {
  it('fill the frame behind the clip, before and outside the clip\'s effect buffer', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.transform.scale = 0.5;
    a.canvas = { on: true, type: 'color', color: '#112233', color2: '#000000', angle: 180, blur: 50 };
    a.effects = [{ id: 'glitch', params: {}, on: true }];
    const { c, layers } = draw(p, 1);
    expect(layers[0].extras?.canvas).toBeTruthy();
    const used = c.programsUsed;
    expect(used.filter((k) => k === 'clipCanvas')).toHaveLength(1);
    // The fill comes first; then the clip alone, its effect, and its placing.
    expect(used.indexOf('clipCanvas')).toBeLessThan(used.indexOf('layer'));
    expect(used.indexOf('layer')).toBeLessThan(used.indexOf('fx:glitch'));
    expect(used.indexOf('fx:glitch')).toBeLessThan(used.indexOf('clipfx-place'));
    // It goes where the finished clip goes, not into the buffer the clip is drawn in alone.
    expect(c.targets[used.indexOf('clipCanvas')]).toBe(c.targets[used.indexOf('clipfx-place')]);
    expect(c.targets[used.indexOf('clipCanvas')]).not.toBe(c.targets[used.indexOf('layer')]);
  });
});

describe('compound clips', () => {
  it('place the motion blur samples of a clip inside them where they place the clip', () => {
    const p = fixture();
    const [a] = onMain(p, clip('video', 0, 4));
    a.keyframes.x = [{ t: 0, v: -0.2, ease: 'linear' }, { t: s(4), v: 0.2, ease: 'linear' }];
    a.motionBlur = { on: true, amount: 50 };
    const comp = createCompound(p, [a.id], { ripple: true, linkOverlays: true });
    Object.assign(comp.transform, { scale: 0.5, x: 0.25 });
    p.modified++;
    const [layer] = evaluate(p, s(2));
    const samples = layer.extras.motion;
    expect(layer).toMatchObject({ scale: 0.5 });
    expect(layer.x).toBeCloseTo(0.25);
    for (const m of samples) expect(m.scale).toBeCloseTo(0.5);
    // The samples straddle the clip's place, half as far apart as outside the compound.
    const mid = samples[Math.floor(samples.length / 2)];
    expect(mid.x).toBeCloseTo(0.25, 2);
    expect(samples.at(-1).x - samples[0].x).toBeGreaterThan(0);
    expect(samples.at(-1).x - samples[0].x).toBeLessThan(0.02);
  });
});


it('places effect-buffer motion samples through the full sheared transform', () => {
  const p = fixture();
  const [a] = onMain(p, clip('video', 0, 4));
  Object.assign(a.transform, { x: 0.1, y: 0.02, scale: 0.5, rotation: 30, flipV: true });
  a.keyframes.rotation = [{ t: 0, v: 15, ease: 'linear' }, { t: s(4), v: 75, ease: 'linear' }];
  a.keyframes.x = [{ t: 0, v: -0.1, ease: 'linear' }, { t: s(4), v: 0.1, ease: 'linear' }];
  a.motionBlur = { on: true, amount: 100 };
  a.effects = [{ id: 'glitch', params: {}, on: true }];
  const group = createCompound(p, [a.id], { ripple: false });
  Object.assign(group.transform, { scale: 0.7, rotation: 25, sx: 1.8, sy: 0.6, flipH: true });
  const { c, layers: [layer] } = draw(p, 1);
  const samples = layer.extras.motion;
  expect(c.quads).toHaveLength(samples.length + 1);
  const outer = c.quads.at(-1);
  for (const [i, sample] of samples.entries()) {
    const inner = c.quads[i];
    const expected = c.layerBox({ ...layer, ...sample }, video);
    for (const [u, v] of [[-0.5, -0.5], [0.5, 0.5], [0.2, -0.3]]) {
      const point = boxPoint(inner, inner.r, u, v);
      const actual = boxPoint(outer, outer.r, point[0] / inner.projW - 0.5, point[1] / inner.projH - 0.5);
      const wanted = boxPoint(expected, sample.rotation, u, v);
      actual.forEach((x, j) => expect(x).toBeCloseTo(wanted[j], 7));
    }
  }
});
