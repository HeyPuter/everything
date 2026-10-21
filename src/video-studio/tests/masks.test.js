import { describe, it, expect } from 'vitest';
import {
  defaultMask, normalizeMask, normalizeMasks, migrateLegacyMask, evaluateMasks, combineCoverage, setMaskValues,
  addMask, removeMask, moveMask, changeMaskType, maskHasShape, MAX_MASKS, maskProp, parseMaskProp, fitPathBox,
} from '../src/model/masks.js';
import {
  starPoints, polygonPoints, heartPoints, ellipsePoints, roundedRectPoints, roundedRectSdf, cubicAt, samplePath,
  insertPathPoint, nearestOnPolygon, maskOutline, maskContains, sourceToProject, projectToSource, maskToSource,
  sourceToMask, clipLine, pointInPolygon,
} from '../src/engine/mask-shapes.js';
import { maskSignature, maskResolution, blurAlpha, featherSigma } from '../src/engine/mask-raster.js';
import { baseValue, setBaseValue } from '../src/model/keyframes.js';
import { createProject, makeClip, normalizeClip, normalizeProject } from '../src/model/project.js';
import { evaluate } from '../src/engine/scene.js';
import * as T from '../src/model/timeline.js';
import { sliceProject } from '../src/model/slice.js';
import { US } from '../src/lib/time.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('mask model', () => {
  it('makes defaults for every shape, round shapes round', () => {
    for (const type of ['split', 'band', 'ellipse', 'rectangle', 'star', 'heart', 'polygon', 'text', 'pen', 'brush']) {
      const m = defaultMask(type, 16 / 9);
      expect(m.type).toBe(type);
      expect(m.mode).toBe('add');
      expect(normalizeMask(m)).toEqual(m);
    }
    const c = defaultMask('ellipse', 16 / 9);
    expect(c.w * 1920).toBeCloseTo(c.h * 1080);
    const portrait = defaultMask('star', 9 / 16);
    expect(portrait.w * 1080).toBeCloseTo(portrait.h * 1920);
    expect(defaultMask('nope')).toBeNull();
  });

  it('normalizes and clamps saved masks', () => {
    const m = normalizeMask({ type: 'star', x: 99, w: -1, feather: 300, opacity: 2, count: 50, inner: 0, mode: 'weird', invert: 1, hidden: true });
    expect(m).toMatchObject({ type: 'star', x: 10, w: 0.001, feather: 100, opacity: 1, count: 24, inner: 0.05, mode: 'add', invert: true, hidden: true });
    expect(normalizeMask({ type: 'blob' })).toBeNull();
    expect(normalizeMask(null)).toBeNull();
    const pen = normalizeMask({ type: 'pen', path: [{ x: 0.1, y: 'a' }, null, { x: 0.123456789, y: 0.2, ox: 0.05 }] });
    expect(pen.path).toEqual([{ x: 0.1, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 0.1235, y: 0.2, ix: 0, iy: 0, ox: 0.05, oy: 0 }]);
    const brush = normalizeMask({ type: 'brush', strokes: [{ size: 0.1, pts: [0, 0, 0.1] }, { pts: [] }, { size: 5, erase: 1, pts: [0.2, 0.2] }] });
    expect(brush.strokes).toEqual([{ size: 0.1, erase: false, pts: [0, 0] }, { size: 1, erase: true, pts: [0.2, 0.2] }]);
    const text = normalizeMask({ type: 'text', text: 'x'.repeat(500), font: '' });
    expect(text.text).toHaveLength(200);
    expect(text.font).toBe('Anton');
  });

  it('keeps at most four masks', () => {
    const list = Array.from({ length: 7 }, () => defaultMask('ellipse'));
    expect(normalizeMasks({ masks: list })).toHaveLength(MAX_MASKS);
    const clip = { masks: list.slice(0, MAX_MASKS) };
    expect(addMask(clip, defaultMask('heart'))).toBe(-1);
  });

  it('migrates the old single mask', () => {
    const [m] = normalizeMasks({ mask: { type: 'circle', x: 0.25, y: -0.1, w: 0.4, h: 0.3, rotation: 30, feather: 20, invert: true } });
    expect(m).toMatchObject({ type: 'ellipse', x: 0.25, y: -0.1, w: 0.4, h: 0.3, rotation: -30, feather: 20, invert: true, mode: 'add' });
    expect(normalizeMasks({ mask: { type: 'linear', x: 0, y: 0.2 } })[0]).toMatchObject({ type: 'split', y: 0.2 });
    expect(normalizeMasks({ mask: { type: 'mirror', h: 0.3 } })[0]).toMatchObject({ type: 'band', h: 0.3 });
    expect(normalizeMasks({ mask: { type: 'rectangle', w: 0.6, h: 0.4 } })[0]).toMatchObject({ type: 'rectangle', w: 0.6, h: 0.4 });
    expect(normalizeMasks({ mask: { type: 'bogus' } })).toEqual([]);
    expect(normalizeMasks({})).toEqual([]);
  });

  it('migrates old masks through crop and flip to the picture', () => {
    // Old masks were placed in the cropped box as shown.
    const crop = { l: 0.2, t: 0, r: 0.2, b: 0.5 };
    const m = migrateLegacyMask({ type: 'rectangle', x: 0.25, y: 0, w: 0.5, h: 0.5 }, crop, {});
    // Box x 0.75 of the visible 0.2..0.8 span -> source 0.65.
    expect(m.x).toBeCloseTo(0.15);
    expect(m.y).toBeCloseTo(-0.25);
    expect(m.w).toBeCloseTo(0.3);
    expect(m.h).toBeCloseTo(0.25);
    const flipped = migrateLegacyMask({ type: 'circle', x: 0.25, rotation: 20 }, null, { flipH: true });
    expect(flipped.x).toBeCloseTo(-0.25);
    expect(flipped.rotation).toBe(20);
  });

  it('normalizes clips: old mask migrates, new fields survive a round trip', () => {
    const old = normalizeClip({ type: 'video', assetId: 'a', duration: US, mask: { type: 'circle', x: 0.1 } });
    expect(old.mask).toBeUndefined();
    expect(old.masks).toHaveLength(1);
    expect(old.masks[0].type).toBe('ellipse');
    const plain = normalizeClip({ type: 'video', assetId: 'a', duration: US });
    expect(plain.masks).toBeUndefined();
    expect(plain.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false });
    const rich = normalizeClip({
      type: 'image', assetId: 'a', duration: US,
      transform: { scale: 2, sx: 1.5, sy: 1, uniform: false },
      masks: [defaultMask('heart'), { type: 'nope' }],
      motionBlur: { amount: 70 }, denoise: { on: false, strength: 20 }, relight: { angle: 45, intensity: 300 }, canvas: { type: 'gradient', color: 'red' },
    });
    expect(rich.transform).toMatchObject({ scale: 2, sx: 1.5, uniform: false });
    expect(rich.transform.sy).toBeUndefined();
    expect(rich.masks.map((m) => m.type)).toEqual(['heart']);
    expect(rich.motionBlur).toEqual({ on: true, amount: 70 });
    expect(rich.denoise).toEqual({ on: false, strength: 20 });
    expect(rich.relight).toMatchObject({ on: true, angle: 45, intensity: 100 });
    expect(rich.canvas).toMatchObject({ on: true, type: 'gradient', color: '#000000' });
    expect(normalizeClip(structuredClone(rich))).toEqual(rich);
    // Text clips get no masks or picture extras.
    const text = normalizeClip({ type: 'text', duration: US, masks: [defaultMask('heart')], canvas: { type: 'color' } });
    expect(text.masks).toBeUndefined();
    expect(text.canvas).toBeUndefined();
  });

  it('knows which masks have a shape', () => {
    expect(maskHasShape(defaultMask('pen'))).toBe(false);
    expect(maskHasShape({ ...defaultMask('pen'), path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] })).toBe(true);
    expect(maskHasShape(defaultMask('brush'))).toBe(false);
    expect(maskHasShape({ ...defaultMask('text'), text: '  ' })).toBe(false);
    expect(maskHasShape({ ...defaultMask('ellipse'), hidden: true })).toBe(false);
  });

  it('fits a pen box to its path without moving the shape', () => {
    const m = { ...defaultMask('pen'), x: 0.05, y: -0.1, rotation: 30, path: [
      { x: 0.1, y: 0.1, ix: 0, iy: 0, ox: 0.05, oy: -0.1 }, { x: 0.3, y: 0.15, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 0.2, y: 0.35, ix: 0, iy: 0, ox: 0, oy: 0 },
    ] };
    const fit = fitPathBox(m, 1920, 1080);
    const where = (mm, p) => maskToSource(mm, 1920, 1080, p.x * mm.w * 1920, p.y * mm.h * 1080);
    m.path.forEach((p, i) => {
      const [ax, ay] = where(m, p);
      const [bx, by] = where(fit, fit.path[i]);
      expect(bx).toBeCloseTo(ax, 6);
      expect(by).toBeCloseTo(ay, 6);
    });
    const xs = fit.path.flatMap((p) => [p.x, p.x + p.ox]);
    expect(Math.min(...xs)).toBeCloseTo(-0.5);
    expect(Math.max(...xs)).toBeCloseTo(0.5);
    expect(fit.w).toBeCloseTo(0.2);
  });

  it('changes shape keeping placement', () => {
    const m = { ...defaultMask('ellipse'), x: 0.2, rotation: 10, w: 0.3, mode: 'subtract' };
    const r = changeMaskType(m, 'star');
    expect(r).toMatchObject({ type: 'star', x: 0.2, rotation: 10, w: 0.3, mode: 'subtract', id: m.id, count: 5 });
    expect(changeMaskType(m, 'pen')).toMatchObject({ type: 'pen', w: 1, path: [] });
  });
});

describe('combining masks', () => {
  const e = (value, mode = 'add', extra = {}) => ({ value, mode, invert: false, opacity: 1, ...extra });
  it('adds as a union, subtracts and intersects', () => {
    expect(combineCoverage([])).toBe(1);
    expect(combineCoverage([e(1), e(0)])).toBe(1);
    expect(combineCoverage([e(0), e(1)])).toBe(1);
    expect(combineCoverage([e(0), e(0)])).toBe(0);
    expect(combineCoverage([e(0.5), e(0.5)])).toBeCloseTo(0.75);
    expect(combineCoverage([e(1), e(1, 'subtract')])).toBe(0);
    expect(combineCoverage([e(1), e(0.25, 'subtract')])).toBeCloseTo(0.75);
    expect(combineCoverage([e(1), e(0, 'intersect')])).toBe(0);
    expect(combineCoverage([e(0.8), e(0.5, 'intersect')])).toBeCloseTo(0.4);
  });

  it('starts from everything when the first mask subtracts, and treats a first intersect as add', () => {
    expect(combineCoverage([e(1, 'subtract')])).toBe(0);
    expect(combineCoverage([e(0, 'subtract')])).toBe(1);
    expect(combineCoverage([e(0.7, 'intersect')])).toBeCloseTo(0.7);
  });

  it('applies invert and opacity per mask', () => {
    expect(combineCoverage([e(1, 'add', { invert: true })])).toBe(0);
    expect(combineCoverage([e(1, 'add', { opacity: 0.5 })])).toBe(0.5);
    expect(combineCoverage([e(1), e(1, 'subtract', { opacity: 0.4 })])).toBeCloseTo(0.6);
  });
});

describe('mask keyframes', () => {
  function clipWithMasks() {
    const c = makeClip('video', { assetId: 'a1', start: 0, duration: 4 * US });
    c.masks = [defaultMask('ellipse'), defaultMask('rectangle')];
    return c;
  }

  it('names props and reads base values through the keyframe model', () => {
    expect(maskProp(1, 'x')).toBe('mask1.x');
    expect(parseMaskProp('mask12.feather')).toEqual({ index: 12, key: 'feather' });
    expect(parseMaskProp('x')).toBeNull();
    const c = clipWithMasks();
    c.masks[1].feather = 30;
    expect(baseValue(c, 'mask1.feather')).toBe(30);
    setBaseValue(c, 'mask0.x', 0.4);
    expect(c.masks[0].x).toBe(0.4);
    expect(baseValue(c, 'mask5.x')).toBe(0);
    setBaseValue(c, 'mask5.x', 1);
    expect(c.masks).toHaveLength(2);
    expect(baseValue(c, 'sx')).toBe(1);
  });

  it('evaluates keyed values over time', () => {
    const c = clipWithMasks();
    c.keyframes['mask0.x'] = [{ t: 0, v: -0.2, ease: 'linear' }, { t: 2 * US, v: 0.2, ease: 'linear' }];
    c.keyframes['mask1.rotation'] = [{ t: US, v: 90, ease: 'linear' }];
    const [a, b] = evaluateMasks(c, US);
    expect(a.x).toBeCloseTo(0);
    expect(b.rotation).toBe(90);
    expect(c.masks[0].x).toBe(0);
    expect(evaluateMasks({ masks: [] }, 0)).toEqual([]);
  });

  it('sets keyed values as keys and others on the mask', () => {
    const c = clipWithMasks();
    c.keyframes['mask0.x'] = [{ t: 0, v: 0, ease: 'linear' }];
    setMaskValues(c, 0, { x: 0.3, y: 0.1, roundness: 5 }, 2 * US);
    expect(c.keyframes['mask0.x']).toHaveLength(2);
    expect(c.masks[0].x).toBe(0);
    expect(c.masks[0].y).toBe(0.1);
    expect(c.masks[0].roundness).toBe(5);
    expect(setMaskValues(c, 9, { x: 1 }, 0)).toBe(false);
  });

  it('renumbers keyframes when masks are removed or reordered', () => {
    const c = clipWithMasks();
    c.masks.push(defaultMask('star'));
    c.keyframes['mask0.x'] = [{ t: 0, v: 1, ease: 'linear' }];
    c.keyframes['mask2.feather'] = [{ t: 0, v: 50, ease: 'linear' }];
    c.keyframes.opacity = [{ t: 0, v: 1, ease: 'linear' }];
    moveMask(c, 2, 0);
    expect(c.masks.map((m) => m.type)).toEqual(['star', 'ellipse', 'rectangle']);
    expect(Object.keys(c.keyframes).sort()).toEqual(['mask0.feather', 'mask1.x', 'opacity']);
    removeMask(c, 0);
    expect(c.masks.map((m) => m.type)).toEqual(['ellipse', 'rectangle']);
    expect(Object.keys(c.keyframes).sort()).toEqual(['mask0.x', 'opacity']);
    removeMask(c, 0);
    removeMask(c, 0);
    expect(c.masks).toBeUndefined();
    expect(moveMask(c, 0, 1)).toBe(false);
  });

  it('keeps keyed masks continuous through split, trim and speed changes', () => {
    const p = createProject();
    p.assets.a1 = { id: 'a1', kind: 'video', duration: 20 * US, width: 1920, height: 1080, hasAudio: false, hasVideo: true };
    const c = clipWithMasks();
    c.keyframes['mask1.w'] = [{ t: 0, v: 0.2, ease: 'linear' }, { t: 4 * US, v: 0.6, ease: 'linear' }];
    T.mainTrack(p).clips.push(c);
    const at = (t) => evaluate(p, t)[0].masks[1].w;
    expect(at(US)).toBeCloseTo(0.3);
    const right = T.splitClip(p, c.id, 2 * US);
    expect(at(US)).toBeCloseTo(0.3);
    expect(at(3 * US)).toBeCloseTo(0.5);
    expect(right.keyframes['mask1.w'][0]).toMatchObject({ t: 0, v: 0.4 });
    T.trimClip(p, right.id, 'start', 2.5 * US);
    expect(at(3 * US)).toBeCloseTo(0.5);
    T.setSpeed(p, c.id, 2);
    // Twice as fast: the left half's motion now ends at 1s.
    expect(evaluate(p, 0.5 * US)[0].masks[1].w).toBeCloseTo(0.3);
    // Slicing (export ranges) shifts keys the same way.
    const sliced = sliceProject(p, 0.25 * US, 5 * US);
    expect(evaluate(sliced, 0)[0].masks[1].w).toBeCloseTo(evaluate(p, 0.25 * US)[0].masks[1].w);
    expect(evaluate(sliced, 0)[0].masks[1].w).toBeCloseTo(0.25);
  });

  it('feeds masks and non-uniform scale to the layer', () => {
    const p = createProject();
    p.assets.a1 = { id: 'a1', kind: 'video', duration: 20 * US, width: 1920, height: 1080, hasAudio: false, hasVideo: true };
    const c = clipWithMasks();
    c.transform.sx = 2;
    c.keyframes.sy = [{ t: 0, v: 0.5, ease: 'linear' }];
    T.mainTrack(p).clips.push(c);
    const [layer] = evaluate(p, US);
    expect(layer.masks.map((m) => m.type)).toEqual(['ellipse', 'rectangle']);
    expect(layer.sx).toBe(2);
    expect(layer.sy).toBe(0.5);
    expect(layer.extras).toBeNull();
    const loaded = normalizeProject(structuredClone(p));
    expect(evaluate(loaded, US)[0].masks).toHaveLength(2);
  });
});

describe('mask geometry', () => {
  it('builds stars and polygons with the right corners', () => {
    const s = starPoints(5, 0.4);
    expect(s).toHaveLength(10);
    expect(s[0][0]).toBeCloseTo(0);
    expect(s[0][1]).toBeCloseTo(-1);
    s.forEach(([x, y], i) => expect(Math.hypot(x, y)).toBeCloseTo(i % 2 ? 0.4 : 1));
    const p = polygonPoints(6);
    expect(p).toHaveLength(6);
    for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(1);
    expect(polygonPoints(1)).toHaveLength(3);
    expect(ellipsePoints(8)).toHaveLength(8);
  });

  it('builds a heart filling its box, lobes up', () => {
    const pts = heartPoints(96);
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    expect(Math.min(...xs)).toBeCloseTo(-1);
    expect(Math.max(...xs)).toBeCloseTo(1);
    expect(Math.min(...ys)).toBeCloseTo(-1);
    expect(Math.max(...ys)).toBeCloseTo(1);
    expect(pointInPolygon(pts, 0, 0.6)).toBe(true);
    expect(pointInPolygon(pts, 0, -0.95)).toBe(false); // the notch between the lobes
    expect(pointInPolygon(pts, -0.5, -0.5)).toBe(true);
  });

  it('measures rounded rectangles', () => {
    expect(roundedRectSdf(0, 0, 10, 5, 0)).toBe(-5);
    expect(roundedRectSdf(12, 0, 10, 5, 0)).toBe(2);
    // A corner point is outside once the corner is rounded.
    expect(roundedRectSdf(9.9, 4.9, 10, 5, 0)).toBeLessThan(0);
    expect(roundedRectSdf(9.9, 4.9, 10, 5, 4)).toBeGreaterThan(0);
    const pts = roundedRectPoints(10, 5, 4, 8);
    for (const [x, y] of pts) expect(Math.abs(roundedRectSdf(x, y, 10, 5, 4))).toBeLessThan(1e-9);
    expect(roundedRectPoints(10, 5, 0)).toHaveLength(4);
    expect(roundedRectPoints(10, 5, 99).every(([x, y]) => Math.abs(roundedRectSdf(x, y, 10, 5, 5)) < 1e-9)).toBe(true);
  });

  it('samples bezier pen paths and inserts points without changing the shape', () => {
    expect(cubicAt([0, 0], [1, 1], [2, 1], [3, 0], 0)).toEqual([0, 0]);
    expect(cubicAt([0, 0], [1, 1], [2, 1], [3, 0], 1)).toEqual([3, 0]);
    const square = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }].map((p) => ({ ix: 0, iy: 0, ox: 0, oy: 0, ...p }));
    expect(samplePath(square).pts).toHaveLength(4);
    const curved = square.map((p) => ({ ...p }));
    curved[0].ox = 0.3;
    curved[1].ix = -0.3;
    const s = samplePath(curved, 16);
    expect(s.pts).toHaveLength(16 + 3);
    expect(s.at[5]).toEqual({ seg: 0, t: 5 / 16 });
    const before = samplePath(curved, 64).pts;
    const inserted = insertPathPoint(curved, 0, 0.5);
    expect(inserted).toHaveLength(5);
    const after = samplePath(inserted, 64).pts;
    // Every sample of the new path lies on the old outline.
    for (const q of after) expect(nearestOnPolygon(before, q).dist).toBeLessThan(2e-3);
    const straight = insertPathPoint(square, 2, 0.5);
    expect(straight[3]).toMatchObject({ x: 0, y: 0.5, ox: 0, ix: 0 });
  });

  it('maps between mask, source and project space', () => {
    const m = { ...defaultMask('rectangle'), x: 0.1, y: -0.2, rotation: 90 };
    const [sx, sy] = maskToSource(m, 1000, 500, 10, 0);
    expect(sx).toBeCloseTo(600);
    expect(sy).toBeCloseTo(160);
    const back = sourceToMask(m, 1000, 500, sx, sy);
    expect(back[0]).toBeCloseTo(10);
    expect(back[1]).toBeCloseTo(0);
    const layer = { crop: { l: 0.1, t: 0.2, r: 0.3, b: 0 }, flipH: true, flipV: false, rotation: 30 };
    const box = { cx: 900, cy: 500, w: 600, h: 400 };
    const pp = sourceToProject(layer, box, 1920, 1080, 700, 600);
    const round = projectToSource(layer, box, 1920, 1080, pp[0], pp[1]);
    expect(round[0]).toBeCloseTo(700);
    expect(round[1]).toBeCloseTo(600);
    // The middle of the visible source lands on the box center.
    const mid = sourceToProject({ crop: { l: 0.1, t: 0, r: 0.3, b: 0 } }, box, 1000, 1000, 400, 500);
    expect(mid[0]).toBeCloseTo(900);
    expect(mid[1]).toBeCloseTo(500);
  });

  it('tests coverage per shape', () => {
    const SW = 1000;
    const SH = 1000;
    const split = { ...defaultMask('split'), rotation: 0 };
    expect(maskContains(split, SW, SH, 500, 700)).toBe(true);
    expect(maskContains(split, SW, SH, 500, 300)).toBe(false);
    const band = { ...defaultMask('band'), h: 0.2 };
    expect(maskContains(band, SW, SH, 10, 550)).toBe(true);
    expect(maskContains(band, SW, SH, 10, 650)).toBe(false);
    const ell = { ...defaultMask('ellipse', 1), w: 0.4, h: 0.4 };
    expect(maskContains(ell, SW, SH, 690, 500)).toBe(true);
    expect(maskContains(ell, SW, SH, 650, 650)).toBe(false);
    const star = { ...defaultMask('star', 1), w: 0.8, h: 0.8 };
    expect(maskContains(star, SW, SH, 500, 500)).toBe(true);
    expect(maskContains(star, SW, SH, 500, 120)).toBe(true); // top point
    expect(maskContains(star, SW, SH, 300, 150)).toBe(false); // between points
    const poly = { ...defaultMask('polygon', 1), count: 4, w: 0.8, h: 0.8 };
    expect(maskContains(poly, SW, SH, 500, 120)).toBe(true);
    expect(maskContains(poly, SW, SH, 150, 150)).toBe(false); // a diamond
    const pen = { ...defaultMask('pen'), path: [{ x: -0.25, y: -0.25 }, { x: 0.25, y: -0.25 }, { x: 0, y: 0.25 }].map((p) => ({ ix: 0, iy: 0, ox: 0, oy: 0, ...p })) };
    expect(maskContains(pen, SW, SH, 500, 400)).toBe(true);
    expect(maskContains(pen, SW, SH, 300, 700)).toBe(false);
    expect(maskOutline(defaultMask('split'), SW, SH)).toBeNull();
  });

  it('clips lines to the frame', () => {
    expect(clipLine([50, 50], [1, 0], 0, 0, 100, 100)).toEqual([[0, 50], [100, 50]]);
    const diag = clipLine([50, 50], [1, 1], 0, 0, 100, 100);
    expect(diag[0][0]).toBeCloseTo(0);
    expect(diag[1][1]).toBeCloseTo(100);
    expect(clipLine([50, 150], [1, 0], 0, 0, 100, 100)).toBeNull();
  });
});

describe('mask raster helpers', () => {
  it('caches by what the masks look like', () => {
    const a = [defaultMask('ellipse')];
    const sig = maskSignature(a, 1920, 1080, 512);
    expect(maskSignature(structuredClone(a), 1920, 1080, 512)).toBe(sig);
    expect(maskSignature([{ ...a[0], x: 0.1 }], 1920, 1080, 512)).not.toBe(sig);
    expect(maskSignature(a, 1920, 1080, 1024)).not.toBe(sig);
    const brush = { ...defaultMask('brush'), strokes: [{ size: 0.1, erase: false, pts: [0, 0, 0.1, 0.1] }] };
    const moved = { ...brush, strokes: [{ size: 0.1, erase: false, pts: [0, 0, 0.1, 0.2] }] };
    expect(maskSignature([brush], 10, 10, 128)).not.toBe(maskSignature([moved], 10, 10, 128));
    // Masks without a shape do not change the picture.
    expect(maskSignature([...a, defaultMask('pen')], 1920, 1080, 512)).toBe(sig);
  });

  it('picks a resolution step and feathers by the short side', () => {
    expect(maskResolution(100)).toBe(128);
    expect(maskResolution(700)).toBe(768);
    expect(maskResolution(9000)).toBe(2048);
    expect(featherSigma({ feather: 50 }, 1920, 1080)).toBeCloseTo(108);
  });

  it('blurs an alpha edge softly and keeps its total', () => {
    const w = 40;
    const alpha = new Float32Array(w);
    for (let i = 20; i < w; i++) alpha[i] = 255;
    const sum = alpha.reduce((s, v) => s + v, 0);
    blurAlpha(alpha, w, 1, 3);
    expect(alpha[0]).toBeCloseTo(0);
    expect(alpha[39]).toBeCloseTo(255);
    expect(alpha[19]).toBeGreaterThan(60);
    expect(alpha[20]).toBeLessThan(200);
    expect(near(alpha.reduce((s, v) => s + v, 0), sum, 1)).toBe(true);
  });
});
