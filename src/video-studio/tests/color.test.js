import { describe, it, expect } from 'vitest';
import {
  normalizeGrade, keyedAdjust, monotoneCurve, sampleCurve, bakeCurves, isIdentityCurve, normalizeCurve,
  packGrade, effectiveAdjust, wheelVector, nearestHslRange, pixelStats, autoAdjustValues, ensureGrade, emptyGrade,
  HSL_RANGES, ADJUST_SECTIONS,
} from '../src/model/color.js';
import { parseCube, lutVolume, applyLut, lutName, CubeError } from '../src/model/cube.js';
import { createProject, makeClip, normalizeClip, normalizeProject, DEFAULT_ADJUST } from '../src/model/project.js';
import { gradeParams } from '../src/engine/compositor.js';
import { clipLayer, evaluate } from '../src/engine/scene.js';
import { splitKeyframes, scaleKeyframes, shiftKeyframes, baseValue, setBaseValue } from '../src/model/keyframes.js';
import { lutIdsIn } from '../src/engine/luts.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

describe('adjust model', () => {
  it('has every slider of the Color tab in DEFAULT_ADJUST, each once', () => {
    const keys = ADJUST_SECTIONS.flatMap((s) => s.keys.map((k) => k.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(DEFAULT_ADJUST).sort());
  });

  it('loads old projects (12 adjust keys, no grade) with the new keys at zero and no grade', () => {
    const old = { type: 'video', id: 'c1', start: 0, duration: US, adjust: { brightness: 10, contrast: -5, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vignette: 0, sharpen: 0, fade: 0, grain: 0 } };
    const c = normalizeClip(old);
    expect(c.adjust).toMatchObject({ brightness: 10, contrast: -5, whites: 0, blacks: 0, brilliance: 0, clarity: 0, vibrance: 0 });
    expect('grade' in c).toBe(false);
    const layer = normalizeClip({ type: 'adjust', id: 'c2', start: 0, duration: US, adjust: { exposure: 5 } });
    expect(layer.keyframes).toEqual({});
    expect('grade' in layer).toBe(false);
  });

  it('clamps new adjust keys like the old ones', () => {
    const c = normalizeClip({ type: 'image', id: 'c', adjust: { whites: 500, clarity: -900, vibrance: 'x' } });
    expect(c.adjust).toMatchObject({ whites: 100, clarity: -100, vibrance: 0 });
  });

  it('round-trips a full grade through project save and load', () => {
    const p = createProject();
    const clip = makeClip('video', { assetId: 'a1', duration: US });
    p.assets.a1 = { id: 'a1', kind: 'video', name: 'v.mp4', duration: 10 * US, width: 640, height: 360 };
    clip.grade = {
      off: { hsl: true, nonsense: true },
      lut: { id: 'abc123', name: 'Film', intensity: 70 },
      hsl: { red: { h: 10, s: -20, l: 0 }, blue: { h: 0, s: 0, l: 0 } },
      curves: { master: [[0, 0], [0.5, 0.6], [1, 1]], red: [[0, 0], [1, 1]] },
      wheels: { intensity: 80, shadows: { x: 0.2, y: -0.1, l: 5 }, midtones: { x: 0, y: 0, l: 0 } },
    };
    clip.keyframes = { 'adjust.exposure': [{ t: 0, v: 10, ease: 'linear' }, { t: US, v: 20, ease: 'linear' }] };
    T.mainTrack(p).clips.push(clip);
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    const c = T.mainTrack(back).clips[0];
    expect(c.grade).toEqual({
      off: { hsl: true },
      lut: { id: 'abc123', name: 'Film', intensity: 70 },
      hsl: { red: { h: 10, s: -20, l: 0 } },
      curves: { master: [[0, 0], [0.5, 0.6], [1, 1]] },
      wheels: { intensity: 80, shadows: { x: 0.2, y: -0.1, l: 5 }, midtones: { x: 0, y: 0, l: 0 }, highlights: { x: 0, y: 0, l: 0 }, offset: { x: 0, y: 0, l: 0 } },
    });
    expect(c.keyframes['adjust.exposure']).toHaveLength(2);
  });
});

describe('normalizeGrade', () => {
  it('returns null for missing or neutral grades', () => {
    expect(normalizeGrade(null)).toBe(null);
    expect(normalizeGrade('x')).toBe(null);
    expect(normalizeGrade(emptyGrade())).toBe(null);
  });

  it('rejects unsafe LUT ids and clamps values', () => {
    expect(normalizeGrade({ lut: { id: '../../etc', name: 'x' } })).toBe(null);
    const g = normalizeGrade({ lut: { id: 'ok_1', intensity: 400 }, hsl: { red: { h: 300, s: -300, l: 'q' } }, wheels: { shadows: { x: 3, y: 4, l: 0 } } });
    expect(g.lut).toEqual({ id: 'ok_1', name: 'LUT', intensity: 100 });
    expect(g.hsl.red).toEqual({ h: 100, s: -100, l: 0 });
    // Pucks stay inside the wheel.
    expect(Math.hypot(g.wheels.shadows.x, g.wheels.shadows.y)).toBeCloseTo(1);
  });

  it('sorts, clamps and de-duplicates curve points', () => {
    expect(normalizeCurve([[1, 1], [0.5, 2], [0, -1], [0.5, 0.3], ['a', 1]])).toEqual([[0, 0], [0.5, 1], [1, 1]]);
    expect(normalizeCurve([[0.5, 0.5]])).toBe(null);
  });

  it('ensureGrade fills a partial grade in place', () => {
    const clip = { grade: { lut: { id: 'a', name: 'A', intensity: 50 } } };
    const g = ensureGrade(clip);
    expect(g).toBe(clip.grade);
    expect(g.lut.intensity).toBe(50);
    expect(g.wheels.offset).toEqual({ x: 0, y: 0, l: 0 });
    expect(g.off).toEqual({});
  });
});

describe('curves', () => {
  it('passes through every control point', () => {
    const pts = [[0, 0.1], [0.3, 0.2], [0.6, 0.85], [1, 0.9]];
    const f = monotoneCurve(pts);
    for (const [x, y] of pts) expect(f(x)).toBeCloseTo(y, 6);
  });

  it('is the identity for the default curve and holds the ends flat', () => {
    const f = monotoneCurve([[0.1, 0.2], [0.9, 0.7]]);
    expect(f(0)).toBe(0.2);
    expect(f(1)).toBe(0.7);
    const id = sampleCurve([[0, 0], [1, 1]], 5);
    expect([...id]).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('never overshoots monotone data (no ringing between points)', () => {
    const pts = [[0, 0], [0.2, 0.05], [0.25, 0.9], [0.8, 0.95], [1, 1]];
    const s = sampleCurve(pts, 512);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] - 1e-6);
    expect(Math.max(...s)).toBeLessThanOrEqual(1);
  });

  it('bakes master, red, green and blue into RGBA rows', () => {
    const t = bakeCurves({ red: [[0, 1], [1, 0]] }, 256);
    expect(t).toHaveLength(256 * 4);
    expect(t[0]).toBe(0); // master identity at 0
    expect(t[1]).toBe(1); // red inverted at 0
    expect(t[255 * 4 + 1]).toBe(0);
    expect(t[255 * 4 + 2]).toBe(1); // green identity at 1
  });

  it('knows identity curves', () => {
    expect(isIdentityCurve([[0, 0], [0.5, 0.5], [1, 1]])).toBe(true);
    expect(isIdentityCurve([[0, 0], [0.5, 0.6], [1, 1]])).toBe(false);
  });
});

describe('.cube parsing', () => {
  const cube3 = (size, fn, head = '') => {
    let s = `${head}LUT_3D_SIZE ${size}\n`;
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) s += `${fn(r / (size - 1), g / (size - 1), b / (size - 1)).join(' ')}\n`;
    return s;
  };

  it('parses a 3D table with title, comments, CRLF and blank lines', () => {
    const text = `# made by hand\r\nTITLE "Warm look"\r\n\r\n${cube3(2, (r, g, b) => [r, g, b]).replace(/\n/g, '\r\n')}`;
    const lut = parseCube(text);
    expect(lut).toMatchObject({ kind: '3d', size: 2, title: 'Warm look', domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
    expect(lut.data).toHaveLength(8 * 3);
    expect(lutName(lut, 'x.cube')).toBe('Warm look');
    expect(lutName({ title: '' }, 'Film Emulation.CUBE')).toBe('Film Emulation');
    // A # inside the quoted title is part of it, not a comment.
    expect(parseCube(`TITLE "Look #2" # by hand\n${cube3(2, (r, g, b) => [r, g, b])}`).title).toBe('Look #2');
    expect(parseCube(`TITLE Plain # note\n${cube3(2, (r, g, b) => [r, g, b])}`).title).toBe('Plain');
  });

  it('orders entries red fastest and interpolates trilinearly', () => {
    const lut = parseCube(cube3(5, (r, g, b) => [r * r, g, 1 - b]));
    const out = applyLut(lut, [0.5, 0.25, 0.75]);
    expect(out[0]).toBeCloseTo(0.25, 5); // grid point: exact
    expect(out[1]).toBeCloseTo(0.25, 5);
    expect(out[2]).toBeCloseTo(0.25, 5);
    const mid = applyLut(lut, [0.375, 0, 0]); // halfway between 0.25 and 0.5 on red
    expect(mid[0]).toBeCloseTo((0.0625 + 0.25) / 2, 5);
  });

  it('builds an RGBA volume with red along x', () => {
    const lut = parseCube(cube3(3, (r, g, b) => [r, g, b]));
    const vol = lutVolume(lut);
    expect(vol.size).toBe(3);
    expect(vol.data).toHaveLength(27 * 4);
    // Entry (r=1, g=0, b=0) is index 1.
    expect([...vol.data.slice(4, 8)]).toEqual([0.5, 0, 0, 1]);
  });

  it('parses 1D tables with an input range and resamples them into a volume', () => {
    const text = 'LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0 2\n0 0 0\n0.5 0.25 1\n1 1 1\n';
    const lut = parseCube(text);
    expect(lut).toMatchObject({ kind: '1d', size: 3, domainMin: [0, 0, 0], domainMax: [2, 2, 2] });
    expect(applyLut(lut, [1, 1, 1])).toEqual([0.5, 0.25, 1]);
    expect(applyLut(lut, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.25);
    const vol = lutVolume(lut);
    expect(vol.size).toBe(33);
    // Along red at the middle of the axis: the middle entry's red.
    expect(vol.data[16 * 4]).toBeCloseTo(0.5);
    // Green and blue follow their own axes.
    expect(vol.data[(16 * 33) * 4 + 1]).toBeCloseTo(0.25);
  });

  it('accepts DOMAIN_MIN / DOMAIN_MAX and ignores unknown keywords', () => {
    const lut = parseCube(`LUT_3D_SIZE 2\nDOMAIN_MIN -0.1 0 0\nDOMAIN_MAX 1.1 1 1\nLUT_IN_VIDEO_RANGE\n${cube3(2, (r, g, b) => [r, g, b]).split('\n').slice(1).join('\n')}`);
    expect(lut.domainMin).toEqual([-0.1, 0, 0]);
    expect(lut.domainMax).toEqual([1.1, 1, 1]);
  });

  it('handles the largest allowed size (65)', () => {
    const lut = parseCube(cube3(65, (r, g, b) => [r, g, b]));
    expect(lut.size).toBe(65);
    expect(applyLut(lut, [0.3, 0.6, 0.9]).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.3, 0.6, 0.9]);
  });

  it('rejects broken files with readable errors', () => {
    expect(() => parseCube('0 0 0\n')).toThrow(/size is missing/);
    expect(() => parseCube('LUT_3D_SIZE 66\n')).toThrow(CubeError);
    expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(/2 to 65/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/2 entries but its size needs 8/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n')).toThrow(/not a number/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0\n')).toThrow(/three numbers/);
    expect(() => parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n1 1 1\n')).toThrow(/more entries/);
    expect(() => parseCube('LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n')).toThrow(/both/);
    expect(() => parseCube('TITLE "x"\n')).toThrow(/no table data/);
    expect(() => parseCube('LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 1 1\n0 0 0\n1 1 1\n')).toThrow(/DOMAIN_MAX/);
    expect(() => parseCube(42)).toThrow(/text/);
  });
});

describe('keyframed adjust values', () => {
  const clipWithKeys = () => {
    const c = makeClip('video', { assetId: 'a1', duration: 4 * US });
    c.adjust.exposure = 5;
    c.keyframes = { 'adjust.exposure': [{ t: 0, v: 0, ease: 'linear' }, { t: 2 * US, v: 40, ease: 'linear' }], x: [{ t: 0, v: 0.1, ease: 'linear' }] };
    return c;
  };

  it('interpolates adjust keys and leaves unkeyed values alone', () => {
    const c = clipWithKeys();
    expect(keyedAdjust(c, US).exposure).toBe(20);
    expect(keyedAdjust(c, 3 * US).exposure).toBe(40);
    expect(keyedAdjust(c, US).contrast).toBe(0);
    // Nothing keyed: the very same object (no per-frame copies).
    const plain = makeClip('video');
    expect(keyedAdjust(plain, US)).toBe(plain.adjust);
  });

  it('reaches the compositor through scene layers, for clips and color layers', () => {
    const p = createProject();
    p.assets.a1 = { id: 'a1', kind: 'video', name: 'v.mp4', duration: 10 * US, width: 640, height: 360 };
    const c = clipWithKeys();
    T.mainTrack(p).clips.push(c);
    expect(clipLayer(p, c, US, 0).adjust.exposure).toBe(20);
    const layer = makeClip('adjust', { start: 0, duration: 4 * US });
    layer.keyframes['adjust.saturation'] = [{ t: 0, v: -100, ease: 'linear' }, { t: 4 * US, v: 100, ease: 'linear' }];
    layer.grade = { lut: { id: 'abc', name: 'A', intensity: 50 } };
    T.addClip(p, layer);
    const adj = evaluate(p, 2 * US).find((l) => l.kind === 'adjust');
    expect(adj.adjust.saturation).toBe(0);
    expect(adj.grade.lut.id).toBe('abc');
    expect([...lutIdsIn(p)]).toEqual(['abc']);
  });

  it('reads and writes base values for adjust props', () => {
    const c = makeClip('image');
    setBaseValue(c, 'adjust.whites', 30);
    expect(c.adjust.whites).toBe(30);
    expect(baseValue(c, 'adjust.whites')).toBe(30);
    setBaseValue(c, 'scale', 2);
    expect(baseValue(c, 'scale')).toBe(2);
  });

  it('survives split, trim and speed changes like transform keys', () => {
    const c = clipWithKeys();
    const [l, r] = splitKeyframes(c.keyframes, US);
    expect(l['adjust.exposure'].at(-1)).toMatchObject({ t: US, v: 20 });
    expect(r['adjust.exposure'][0]).toMatchObject({ t: 0, v: 20 });
    const half = scaleKeyframes(c.keyframes, 0.5);
    expect(half['adjust.exposure'][1].t).toBe(US);
    const trimmed = shiftKeyframes(c.keyframes, -US, 3 * US);
    expect(trimmed['adjust.exposure'][0]).toMatchObject({ t: 0, v: 20 });
    // Through the timeline operations as well.
    const p = createProject();
    p.assets.a1 = { id: 'a1', kind: 'video', name: 'v.mp4', duration: 10 * US, width: 640, height: 360 };
    T.mainTrack(p).clips.push(c);
    const right = T.splitClip(p, c.id, US);
    expect(right.keyframes['adjust.exposure'][0].v).toBe(20);
    T.setSpeed(p, c.id, 2);
    expect(T.findClip(p, c.id).clip.keyframes['adjust.exposure'].at(-1).t).toBe(US / 2);
  });
});

describe('grade parameter packing', () => {
  it('skips everything for ungraded clips', () => {
    expect(packGrade(null)).toBe(null);
    expect(packGrade(emptyGrade())).toBe(null);
    expect(gradeParams(DEFAULT_ADJUST, null, null).ext).toBe(null);
  });

  it('packs HSL as degrees, saturation and value factors in range order', () => {
    const x = packGrade({ hsl: { orange: { h: 50, s: -100, l: 100 } } });
    const i = HSL_RANGES.findIndex((r) => r.id === 'orange');
    expect(x.hsl).toHaveLength(24);
    expect([...x.hsl.slice(i * 3, i * 3 + 3)].map((v) => Math.round(v * 1000) / 1000)).toEqual([15, -1, 0.6]);
    expect(x.hsl[0]).toBe(0);
  });

  it('packs curves with a stable cache key, ignoring identity channels', () => {
    const a = packGrade({ curves: { master: [[0, 0], [0.5, 0.7], [1, 1]], red: [[0, 0], [1, 1]] } });
    expect(Object.keys(a.curves)).toEqual(['master']);
    const b = packGrade({ curves: { master: [[0, 0], [0.5, 0.7], [1, 1]] } });
    expect(a.curvesKey).toBe(b.curvesKey);
    expect(packGrade({ curves: { red: [[0, 0], [1, 1]] } })).toBe(null);
  });

  it('packs wheels scaled by intensity and the LUT with its mix', () => {
    const w = { intensity: 50, shadows: { x: 1, y: 0, l: 0 }, midtones: { x: 0, y: 0, l: 0 }, highlights: { x: 0, y: 0, l: 100 }, offset: { x: 0, y: 0, l: 0 } };
    const x = packGrade({ wheels: w, lut: { id: 'L1', intensity: 25 } });
    // Shadows pushed toward red: red up, green and blue down, no change in luma.
    expect(x.wheels.lift[0]).toBeGreaterThan(0);
    expect(x.wheels.lift[1]).toBeLessThan(0);
    const l = x.wheels.lift;
    expect(0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]).toBeCloseTo(0, 6);
    expect(x.wheels.gain).toEqual(wheelVector('highlights', w.highlights, 50));
    expect(x.wheels.gain[0]).toBeCloseTo(0.25);
    expect(x.lut).toEqual({ id: 'L1', mix: 0.25 });
    expect(packGrade({ lut: { id: 'L1', intensity: 0 } })).toBe(null);
  });

  it('honors section bypass for packed parts and for the sliders', () => {
    const g = { off: { lut: true, hsl: true, light: true }, lut: { id: 'L', intensity: 100 }, hsl: { red: { h: 10, s: 0, l: 0 } }, curves: { blue: [[0, 0.2], [1, 1]] } };
    const x = packGrade(g);
    expect(x.lut).toBe(null);
    expect(x.hsl).toBe(null);
    expect(x.curves.blue).toBeTruthy();
    const a = effectiveAdjust({ ...DEFAULT_ADJUST, exposure: 30, saturation: 20, whites: 10 }, g);
    expect(a).toMatchObject({ exposure: 0, whites: 0, saturation: 20 });
    const params = gradeParams({ ...DEFAULT_ADJUST, exposure: 30, clarity: 15 }, { id: 'vivid', intensity: 100 }, g);
    expect(params.exposure).toBe(0);
    expect(params.clarity).toBe(15);
    expect(params.saturation).toBe(30); // the filter still applies
  });
});

describe('color helpers', () => {
  it('finds the nearest hue range', () => {
    expect(nearestHslRange(1, 0, 0)).toBe('red');
    expect(nearestHslRange(1, 0.5, 0)).toBe('orange');
    expect(nearestHslRange(0, 1, 1)).toBe('aqua');
    expect(nearestHslRange(0.1, 0.3, 1)).toBe('blue');
    expect(nearestHslRange(1, 0, 0.9)).toBe('magenta');
    expect(nearestHslRange(0.9, 0.05, 0.1)).toBe('red');
  });

  const frame = (w, hgt, fn) => {
    const d = new Uint8ClampedArray(w * hgt * 4);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) d.set([...fn(x, y), 255], (y * w + x) * 4);
    return d;
  };

  it('measures luma percentiles inside a rectangle only', () => {
    // Left half black bars, right half a grey ramp.
    const d = frame(100, 10, (x) => (x < 50 ? [0, 0, 0] : [(x - 50) * 5, (x - 50) * 5, (x - 50) * 5]));
    const all = pixelStats(d, 100, 10);
    const inside = pixelStats(d, 100, 10, { rect: { x: 50, y: 0, w: 50, h: 10 } });
    expect(all.low).toBe(0);
    expect(inside.low).toBe(0);
    expect(inside.median).toBeGreaterThan(all.median);
    expect(inside.count).toBe(500);
  });

  it('auto adjust brightens a dark, flat, blue frame and warms it', () => {
    const d = frame(64, 64, (x, y) => {
      const v = 30 + ((x + y) % 40);
      return [v * 0.8, v, v * 1.3];
    });
    const p = autoAdjustValues(pixelStats(d, 64, 64));
    expect(p.exposure).toBeGreaterThan(20);
    expect(p.contrast).toBeGreaterThan(0);
    expect(p.temperature).toBeGreaterThan(0);
    expect(p.blacks).toBeLessThanOrEqual(0);
    for (const v of Object.values(p)) expect(Math.abs(v)).toBeLessThanOrEqual(60);
  });

  it('auto adjust leaves a well exposed neutral frame nearly alone', () => {
    const d = frame(64, 64, (x) => [x * 4, x * 4, x * 4]);
    const p = autoAdjustValues(pixelStats(d, 64, 64));
    expect(Math.abs(p.exposure)).toBeLessThan(15);
    expect(p.temperature).toBe(0);
    expect(p.tint).toBe(0);
    expect(p.whites).toBe(0);
    expect(autoAdjustValues({ count: 0 })).toBe(null);
  });
});
