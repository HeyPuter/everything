import { describe, expect, it } from 'vitest';
import { MixerBrush, mixPaint, mixerPresets, type MixerSettings } from '../src/engine/mixer';
import { artStrokes, artStyles, type ArtStyle } from '../src/engine/art-history';
import { StrokeSession } from '../src/engine/paint';
import { TileStore, emptyGrid, readRGBA, gridFromImage } from '../src/model/tiles';

describe('subtractive paint mixing', () => {
  it('mixes a paint blue and a paint yellow into green, unlike an RGB average', () => {
    const out = mixPaint([30, 80, 200], 1, [240, 210, 40], 1);
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[1]).toBeGreaterThan(out[2]);
    // Mixing darkens (pigments absorb), while an RGB average stays light gray.
    expect(out[0] + out[1] + out[2]).toBeLessThan((30 + 240 + 80 + 210 + 200 + 40) / 2);
  });
  it('keeps a color mixed with itself and respects weights', () => {
    expect(mixPaint([120, 60, 200], 1, [120, 60, 200], 3).map(Math.round)).toEqual([120, 60, 200]);
    const mostlyRed = mixPaint([230, 20, 20], 9, [20, 20, 230], 1);
    expect(mostlyRed[0]).toBeGreaterThan(mostlyRed[2]);
  });
});

const settings = (s: Partial<MixerSettings>): MixerSettings => ({ wet: 0, load: 0.5, mix: 0, flow: 1, ...s });
const px = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a]);

describe('mixer brush', () => {
  it('deposits reservoir paint when dry', () => {
    const b = new MixerBrush(10);
    b.loadColor([200, 30, 30]);
    const s = settings({});
    b.dab(5, 5, s);
    const out = new Uint8ClampedArray(4);
    // The first dab covers most of the way; dragging on completes the coverage.
    b.pixel(5, 5, 1, px(255, 255, 255), px(255, 255, 255), s, out);
    expect(out[0]).toBeGreaterThan(200);
    expect(out[1]).toBeLessThan(100);
    for (let x = 6; x < 30; x++) {
      b.dab(x, 5, s);
      b.pixel(x, 5, 1, out.slice(), out.slice(), s, out);
    }
    [200, 30, 30, 255].forEach((v, i) => expect(Math.abs(out[i] - v)).toBeLessThanOrEqual(2));
  });
  it("runs dry along a stroke with a light load, longer with a heavy one", () => {
    const dabsUntilDry = (load: number) => {
      const b = new MixerBrush(10);
      b.loadColor([0, 0, 0]);
      let n = 0;
      while (b.level > 0 && n < 10000) {
        b.dab(n, 0, settings({ load }));
        n++;
      }
      return n;
    };
    expect(dabsUntilDry(0.1)).toBeLessThan(dabsUntilDry(0.9) / 5);
  });
  it('picks up canvas paint and smears it where the tip moves', () => {
    const b = new MixerBrush(4);
    b.clean();
    const s = settings({ wet: 1, mix: 1 });
    const out = new Uint8ClampedArray(4);
    // Pick up blue at (10, 10) with the tip centred there…
    b.dab(10, 10, s);
    for (let i = 0; i < 6; i++) b.pixel(10, 10, 1, px(20, 40, 220), px(20, 40, 220), s, out);
    // …then move the brush one pixel left: that tip cell now lies over white.
    b.dab(9, 10, s);
    b.pixel(9, 10, 1, px(255, 255, 255), px(255, 255, 255), s, out);
    expect(out[2]).toBeGreaterThan(out[0] + 40);
  });
  it('a clean brush with no reservoir and nothing picked up leaves the canvas alone', () => {
    const b = new MixerBrush(6);
    b.clean();
    const s = settings({ mix: 0.5 });
    b.dab(3, 3, s);
    const out = new Uint8ClampedArray(4);
    b.pixel(3, 3, 1, px(10, 20, 30), px(10, 20, 30), s, out);
    expect([...out]).toEqual([10, 20, 30, 255]);
    expect(b.loadedColor()).toBeUndefined();
  });
  it('loads a sampled image and reports its average color', () => {
    const b = new MixerBrush(2);
    const img = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
    b.loadImage(img, 2, 2);
    const c = b.loadedColor()!;
    expect(c[0]).toBeGreaterThan(100);
    expect(c[2]).toBeGreaterThan(100);
  });
  it('offers wet/load/mix combinations', () => {
    expect(mixerPresets.find((p) => p.id === 'very-wet')!.settings).toEqual({ wet: 1, load: 0.5, mix: 1 });
  });
  it('paints through the engine as a custom dab target', () => {
    const store = new TileStore();
    const white = new Uint8ClampedArray(32 * 32 * 4).fill(255);
    const grid = gridFromImage(store, { width: 32, height: 32, data: white });
    const b = new MixerBrush(8);
    b.loadColor([0, 0, 200]);
    const s = settings({});
    const session = new StrokeSession(store, grid, {
      tip: { size: 8, hardness: 1, spacing: 0.2, roundness: 1, angle: 0 },
      opacity: 1,
      flow: 1,
      target: { kind: 'custom', dab: (x, y) => b.dab(x, y, s), pixel: (x, y, a, cur, out) => b.pixel(x, y, a, cur, cur, s, out) },
    });
    session.addPoint(8, 16);
    session.addPoint(24, 16);
    const out = readRGBA(store, session.commit(), { x: 16, y: 16, width: 1, height: 1 });
    expect(out.data[2]).toBeGreaterThan(195);
    expect(out.data[0]).toBeLessThan(10);
    expect(emptyGrid(4).tiles).toEqual({});
  });
});

describe('art history strokes', () => {
  // Source: left half red, right half blue.
  const source = (x: number, _y: number, out: Uint8ClampedArray) => {
    out.set(x < 50 ? [220, 0, 0, 255] : [0, 0, 220, 255]);
    return true;
  };
  it('is deterministic for a seed and colors strokes from the source', () => {
    const a = artStrokes(source, undefined, 30, 50, { style: 'tight-medium', area: 20, size: 4, tolerance: 0, seed: 7 });
    const b = artStrokes(source, undefined, 30, 50, { style: 'tight-medium', area: 20, size: 4, tolerance: 0, seed: 7 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    for (const s of a) expect(s.color).toEqual(s.points[0][0] < 50 ? [220, 0, 0] : [0, 0, 220]);
  });
  it('dabs are single points; long styles are longer than short ones', () => {
    const len = (style: ArtStyle) => {
      const s = artStrokes(source, undefined, 30, 50, { style, area: 10, size: 4, tolerance: 0, seed: 3, count: 4 });
      return Math.max(...s.map((x) => x.points.length));
    };
    expect(len('dab')).toBe(1);
    expect(len('tight-long')).toBeGreaterThan(len('tight-short'));
    expect(Object.keys(artStyles)).toHaveLength(10);
  });
  it('strokes follow edges: at the red/blue boundary they run vertically', () => {
    const s = artStrokes(source, undefined, 50, 50, { style: 'tight-long', area: 1, size: 4, tolerance: 0, seed: 5, count: 6 });
    for (const st of s) {
      const [x0, y0] = st.points[0],
        [x1, y1] = st.points[st.points.length - 1];
      expect(Math.abs(y1 - y0)).toBeGreaterThan(Math.abs(x1 - x0));
    }
  });
  it('tolerance skips areas that already match the source', () => {
    const same = artStrokes(source, source, 30, 50, { style: 'tight-short', area: 20, size: 4, tolerance: 20, seed: 1 });
    expect(same).toEqual([]);
    const differ = artStrokes(source, (_x, _y, o) => (o.set([255, 255, 255, 255]), true), 30, 50, { style: 'tight-short', area: 20, size: 4, tolerance: 20, seed: 1 });
    expect(differ.length).toBeGreaterThan(0);
  });
});

describe('pressure strokes', () => {
  it('places every dab on the stroke when the pen rests while pressure drops', () => {
    const store = new TileStore();
    const dabs: [number, number][] = [];
    const session = new StrokeSession(store, emptyGrid(4), {
      tip: { size: 20, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 },
      dynamics: { pressureSize: true },
      opacity: 1,
      flow: 1,
      target: { kind: 'custom', dab: (x, y) => dabs.push([x, y]), pixel: (_x, _y, _a, cur, out) => out.set(cur) },
    });
    session.addPoint(10, 10, 1);
    session.addPoint(14, 10, 0.1);
    // The pen rests while pressure keeps dropping, then moves on.
    session.addPoint(14, 10, 0.05);
    session.addPoint(14, 10, 0.05);
    session.addPoint(20, 10, 0.05);
    expect(dabs.length).toBeGreaterThan(2);
    for (const [x, y] of dabs) {
      expect(x).toBeGreaterThanOrEqual(10);
      expect(x).toBeLessThanOrEqual(20);
      expect(y).toBe(10);
    }
  });
});
