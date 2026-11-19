// Relight layers: settings normalization, light colors, the surface
// estimate, shading and soft shadows (CPU reference), and persistence.
import { describe, expect, it } from 'vitest';
import {
  MAX_LIGHTS,
  defaultRelightParams,
  estimateSurface,
  isIdentityRelight,
  newLight,
  normalizeRelight,
  packPair,
  prepareLights,
  relight,
  relightFloat,
  relightGeometry,
  shadowAt,
  temperatureRgb,
  unpackPair,
  type RelightParams,
} from '../src/imaging/relight';
import { applyAdjustment, isIdentityAdjustment } from '../src/imaging/adjust';
import { rgba8 } from '../src/imaging/types';
import { layer, newDocument } from '../src/model/document';
import { Assets } from '../src/model/assets';
import { deserialize, serialize } from '../src/model/serialization';
import { adjustmentSpec, specAdjustment } from '../src/features/adjust/spec';
import { compileSpatial } from '../src/features/adjust/compile';

const gray = (w: number, h: number, v = 128, a = 255) => {
  const img = rgba8(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([v, v, v, a], i * 4);
  return img;
};
const floats = (img: { data: Uint8ClampedArray }) => Float32Array.from(img.data, (v) => v / 255);
const params = (
  over: Partial<RelightParams> = {},
  light: Partial<RelightParams['lights'][number]> = {},
): RelightParams => {
  const p = defaultRelightParams();
  p.lights[0] = { ...p.lights[0], ...light };
  return { ...p, shadows: 0, ...over };
};
const lumAt = (px: Float32Array, w: number, x: number, y: number) => px[(y * w + x) * 4];

describe('relight settings', () => {
  it('normalize stored values: defaults, clamping, unique ids, at most eight lights', () => {
    expect(normalizeRelight(undefined)).toEqual(defaultRelightParams());
    const many = Array.from({ length: 12 }, () => ({
      id: 'same',
      x: 9,
      y: -9,
      brightness: 900,
      depth: 'far',
      color: [300, -4, 12.6],
    }));
    const p = normalizeRelight({
      lights: many,
      ambient: -10,
      relief: 400,
      detail: NaN,
      shadows: '50',
    });
    expect(p.lights).toHaveLength(MAX_LIGHTS);
    expect(new Set(p.lights.map((l) => l.id)).size).toBe(MAX_LIGHTS);
    expect(p.lights[0]).toMatchObject({
      id: 'same',
      x: 1.5,
      y: -0.5,
      brightness: 200,
      depth: 40,
      color: [255, 0, 13],
    });
    expect(p).toMatchObject({ ambient: 0, relief: 100, detail: 50, shadows: 30 });
    // Identifiers that could break markup are replaced.
    expect(normalizeRelight({ lights: [{ id: '<x>' }] }).lights[0].id).toMatch(/^light-\d+$/);
    expect(normalizeRelight({ lights: [] }).lights).toEqual([]);
  });
  it('name and place new lights apart from the existing ones', () => {
    const a = newLight([]),
      b = newLight([a]),
      c = newLight([a, b], { x: 0.1, y: 0.9 });
    expect([a.name, b.name, c.name]).toEqual(['Light 1', 'Light 2', 'Light 3']);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect([a.x, a.y]).not.toEqual([b.x, b.y]);
    expect([c.x, c.y]).toEqual([0.1, 0.9]);
  });
  it('are an identity only with all the existing light and no shining light', () => {
    expect(isIdentityRelight(params({ ambient: 100 }, { visible: false }))).toBe(true);
    expect(isIdentityRelight(params({ ambient: 100 }, { brightness: 0 }))).toBe(true);
    expect(isIdentityRelight(params({ ambient: 99 }, { visible: false }))).toBe(false);
    expect(isIdentityRelight(params({ ambient: 100 }))).toBe(false);
    expect(
      isIdentityAdjustment({ kind: 'relight', params: params({ ambient: 100, lights: [] }) }),
    ).toBe(true);
  });
  it('turn temperatures into colors balanced on a neutral 5500 K', () => {
    for (const v of temperatureRgb(5500)) expect(v).toBeCloseTo(1, 3);
    const warm = temperatureRgb(2700),
      cool = temperatureRgb(9500);
    expect(warm[0]).toBe(1);
    expect(warm[0] > warm[1] && warm[1] > warm[2]).toBe(true);
    expect(cool[2]).toBe(1);
    expect(cool[2] > cool[1] && cool[1] > cool[0]).toBe(true);
  });
  it('place lights in document pixels from fractions and the long side', () => {
    const [l] = prepareLights(
      params({}, { x: 0.25, y: 0.5, depth: 100, spread: 0, brightness: 50 }),
      400,
      200,
    );
    expect(l).toMatchObject({ x: 100, y: 100, z: 300, reach: 0.06 * 400, r: 0.5 });
    expect(prepareLights(params({}, { visible: false }), 10, 10)).toEqual([]);
  });
});

describe('relight surface estimate', () => {
  // A bright disc on a dark ground reads as a dome.
  const disc = () => {
    const img = rgba8(64, 64);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const v = Math.hypot(x - 32, y - 32) < 16 ? 230 : 30;
        img.data.set([v, v, v, 255], (y * 64 + x) * 4);
      }
    return img;
  };
  it('points normals outward at the edges of a bright shape', () => {
    const s = estimateSurface(floats(disc()), 64, 64, params({ relief: 80 }));
    const g = s.geometry;
    const n = (x: number, y: number) =>
      Array.from(s.normals.subarray((y * g.width + x) * 4, (y * g.width + x) * 4 + 4));
    expect(n(16, 32)[0]).toBeLessThan(-0.2); // left edge faces left
    expect(n(48, 32)[0]).toBeGreaterThan(0.2); // right edge faces right
    expect(n(32, 16)[1]).toBeLessThan(-0.2); // top edge faces up
    expect(n(32, 32)[2]).toBeGreaterThan(0.95); // the top of the dome faces the viewer
    expect(n(32, 32)[3]).toBeGreaterThan(n(2, 2)[3]); // and stands higher than the ground
    for (let i = 0; i < s.normals.length; i += 4)
      expect(Math.hypot(s.normals[i], s.normals[i + 1], s.normals[i + 2])).toBeCloseTo(1, 4);
  });
  it('is flat without relief and on plain areas', () => {
    const s = estimateSurface(floats(disc()), 64, 64, params({ relief: 0 }));
    for (let i = 0; i < s.normals.length; i += 4) expect(s.normals[i + 2]).toBe(1);
    const flat = estimateSurface(floats(gray(40, 30)), 40, 30, params());
    for (let i = 0; i < flat.normals.length; i += 4) expect(flat.normals[i + 2]).toBeCloseTo(1, 6);
  });
  it('works on a reduced copy at most 512 pixels long, scaled with the document', () => {
    const g = relightGeometry(6000, 4000, { relief: 50, detail: 50 });
    expect(g.factor).toBe(12);
    expect([g.width, g.height]).toEqual([500, 334]);
    expect(g.weights.reduce((a, b) => a + b)).toBeCloseTo(1, 9);
    expect(relightGeometry(6000, 4000, { relief: 50, detail: 100 }).weights[0]).toBeGreaterThan(
      g.weights[0],
    );
    expect(g.relief).toBeCloseTo(0.06 * 6000, 6);
  });
  it('casts soft shadows behind tall shapes, away from the light', () => {
    // A bright wall in the middle; the light sits low on the left.
    const img = rgba8(96, 32);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 96; x++)
        img.data.set(
          Array(3)
            .fill(x >= 44 && x < 52 ? 255 : 40)
            .concat(255),
          (y * 96 + x) * 4,
        );
    const p = params({ relief: 100, shadows: 100 }, { x: 0, y: 0.5, depth: 5, softness: 0 });
    const s = estimateSurface(floats(img), 96, 32, p);
    const [l] = prepareLights(p, 96, 32);
    const right = shadowAt(s.normals, s.geometry, 60, 16, l, 1),
      left = shadowAt(s.normals, s.geometry, 30, 16, l, 1);
    expect(left).toBe(1);
    expect(right).toBeLessThan(0.5);
    expect(shadowAt(s.normals, s.geometry, 60, 16, l, 0)).toBe(1);
    expect(s.shadows).toBeDefined();
    expect(estimateSurface(floats(img), 96, 32, { ...p, shadows: 0 }).shadows).toBeUndefined();
  });
  it('packs two shadow factors per channel exactly at 8-bit precision', () => {
    for (const [a, b] of [
      [0, 1],
      [1, 0],
      [0.5, 0.25],
      [1, 1],
    ]) {
      const [x, y] = unpackPair(packPair(a, b));
      expect(Math.abs(x - a)).toBeLessThanOrEqual(0.5 / 255);
      expect(Math.abs(y - b)).toBeLessThanOrEqual(0.5 / 255);
    }
    expect(Math.fround(packPair(1, 1))).toBe(packPair(1, 1));
  });
});

describe('relight shading', () => {
  it('keeps the image with all the existing light and no lights', () => {
    const img = gray(16, 16, 100);
    expect(relight(img, params({ ambient: 100 }, { visible: false })).data).toEqual(img.data);
  });
  it('dims the existing light in linear light by the ambient amount', () => {
    const out = relight(gray(8, 8, 200), params({ ambient: 50 }, { visible: false }));
    const expected = Math.pow(Math.pow(200 / 255, 2.2) * 0.5, 1 / 2.2) * 255;
    expect(Math.abs(out.data[0] - expected)).toBeLessThanOrEqual(1);
  });
  it('lights the side the light is on, falling off with distance', () => {
    const src = floats(gray(64, 32, 120));
    const out = relightFloat(src, 64, 32, params({ ambient: 40 }, { x: 0.1, y: 0.5, depth: 30 }));
    const near = lumAt(out, 64, 6, 16),
      mid = lumAt(out, 64, 32, 16),
      far = lumAt(out, 64, 60, 16);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(120 / 255);
  });
  it('lights a flat image less from behind than from in front', () => {
    const src = floats(gray(32, 32, 120));
    const front = relightFloat(src, 32, 32, params({ ambient: 0 }, { x: 0.5, y: 0.5, depth: 60 }));
    const back = relightFloat(
      src,
      32,
      32,
      params({ ambient: 0 }, { x: 0.5, y: 0.5, depth: -60, softness: 0 }),
    );
    expect(lumAt(back, 32, 16, 16)).toBeLessThan(lumAt(front, 32, 16, 16) * 0.2);
  });
  it('tints by the light color, keeps alpha and skips transparent pixels', () => {
    const img = gray(16, 16, 128, 200);
    img.data.set([10, 20, 30, 0], 0);
    const out = relight(img, params({ ambient: 30 }, { color: [255, 60, 0] }));
    const i = (8 * 16 + 8) * 4;
    expect(out.data[i]).toBeGreaterThan(out.data[i + 2] + 40);
    expect(out.data[i + 3]).toBe(200);
    expect(Array.from(out.data.subarray(0, 4))).toEqual([10, 20, 30, 0]);
  });
  it('places lights in the document for a crop (same pixels as the full image)', () => {
    const full = gray(40, 40, 140);
    const p = params({ ambient: 50, relief: 0 }, { x: 0.25, y: 0.25 });
    const whole = relight(full, p);
    const crop = rgba8(20, 20);
    for (let y = 0; y < 20; y++)
      crop.data.set(full.data.subarray(((y + 20) * 40 + 20) * 4, ((y + 20) * 40 + 40) * 4), y * 80);
    const part = relight(crop, p, { x: 20, y: 20, docWidth: 40, docHeight: 40 });
    for (let y = 0; y < 20; y += 5)
      for (let x = 0; x < 20; x += 5)
        expect(
          Math.abs(part.data[(y * 20 + x) * 4] - whole.data[((y + 20) * 40 + x + 20) * 4]),
        ).toBeLessThanOrEqual(1);
  });
  it('runs through the adjustment engine and blends by a selection', () => {
    const img = gray(16, 16, 128);
    const adj = { kind: 'relight' as const, params: params({ ambient: 20 }, { visible: false }) };
    const mask = { width: 16, height: 16, data: new Uint8Array(256) };
    mask.data.fill(255, 0, 128);
    const out = applyAdjustment(img, adj, mask);
    expect(out.data[0]).toBeLessThan(100);
    expect(out.data[255 * 4]).toBe(128);
  });
});

describe('relight layers in projects', () => {
  it('round-trip through .photo, normalize on read and compile to a filter pass', async () => {
    const doc = newDocument(32, 32, 'Relit'),
      assets = new Assets();
    const p = defaultRelightParams();
    p.lights.push({ ...newLight(p.lights), color: [20, 40, 250], depth: -70 });
    const spec = adjustmentSpec({ kind: 'relight', params: p });
    doc.layers = [
      { ...layer('adjustment', 'Relight 1', 32, 32), adjustment: spec, clipped: false },
    ];
    const restored = await deserialize(await serialize(doc, assets));
    const back = restored.document.layers[0];
    expect(back.name).toBe('Relight 1');
    expect(back.adjustment).toEqual(spec);
    expect(specAdjustment(back.adjustment)?.params).toEqual(p);
    expect(compileSpatial(back.adjustment!)).toEqual({ type: 'relight', params: p });
    expect(compileSpatial({ kind: 'relight', params: { ambient: 100, lights: [] } })).toBeNull();
    // Damaged records come back usable.
    expect(specAdjustment({ kind: 'relight', params: { lights: 'x' } })?.params).toEqual(
      defaultRelightParams(),
    );
  });
});
