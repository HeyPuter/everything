import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  formatUnit,
  levelingRotation,
  lineAngle,
  pixelsPerUnit,
  rulerMetrics,
  sampleAverage,
  scaledArea,
  scaledLength,
  scaleFactor,
  short,
  snapAngle,
  validScale,
} from '../src/imaging/measure/geometry';
import { circularity, grayValues, histogramStats, labelRegions, measureRegions, summarize, toCSV } from '../src/imaging/measure/regions';
import { mapAnnotations, parseNotes, tidyAnnotations, validateAnnotations, type Annotations } from '../src/model/annotations';
import { cropDocument, newDocument, resizeDocument } from '../src/model/document';
import { validateDocument } from '../src/model/serialization';
import { rulerTicks, rulerUnitScale } from '../src/ui/rulers';
import { mask8, rgba8 } from '../src/imaging/types';

const disc = (w: number, h: number, cx: number, cy: number, r: number) => {
  const m = mask8(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m.data[y * w + x] = 255;
  return m;
};
const rect = (w: number, h: number, x0: number, y0: number, rw: number, rh: number, v = 255) => {
  const m = mask8(w, h);
  for (let y = y0; y < y0 + rh; y++) m.data.fill(v, y * w + x0, y * w + x0 + rw);
  return m;
};

describe('ruler geometry', () => {
  it('measures angles counterclockwise from the x axis with y pointing down', () => {
    expect(lineAngle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(lineAngle({ x: 0, y: 0 }, { x: 10, y: -10 })).toBeCloseTo(45);
    expect(lineAngle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(-90);
    expect(lineAngle({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe(180);
    expect(lineAngle({ x: 3, y: 3 }, { x: 3, y: 3 })).toBe(0);
  });
  it('reports length, deltas and the protractor angle', () => {
    const m = rulerMetrics({ a: { x: 10, y: 20 }, b: { x: 13, y: 24 } });
    expect(m).toMatchObject({ x: 10, y: 20, dx: 3, dy: 4, length: 5, l1: 5 });
    expect(m.l2).toBeUndefined();
    const p = rulerMetrics({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 0, y: 5 } });
    expect(p.angle).toBeCloseTo(90);
    expect(p.l1).toBe(10);
    expect(p.l2).toBe(5);
    expect(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: -1 })).toBeCloseTo(135);
    expect(angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
  it('levels a line to the nearest horizontal or vertical', () => {
    // A line falling 10° to the right needs a 10° counterclockwise turn.
    const r = 10 * (Math.PI / 180);
    expect(levelingRotation({ x: 0, y: 0 }, { x: Math.cos(r), y: Math.sin(r) })).toBeCloseTo(-10);
    expect(levelingRotation({ x: 0, y: 0 }, { x: Math.cos(-r), y: Math.sin(-r) })).toBeCloseTo(10);
    // Nearly vertical lines become vertical.
    expect(levelingRotation({ x: 0, y: 0 }, { x: Math.sin(r), y: Math.cos(r) })).toBeCloseTo(10);
    expect(levelingRotation({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });
  it('snaps to 45° steps', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(p.x).toBeCloseTo(Math.hypot(10, 1));
    expect(p.y).toBeCloseTo(0);
    const q = snapAngle({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(q.x).toBeCloseTo(q.y);
  });
});

describe('measurement scale and units', () => {
  it('converts pixels to logical units', () => {
    const s = { pixels: 200, length: 5, units: 'mm' };
    expect(scaleFactor(s)).toBe(0.025);
    expect(scaledLength(400, s)).toBe(10);
    expect(scaledArea(40_000, s)).toBeCloseTo(25);
    expect(scaledLength(7)).toBe(7);
    expect(validScale(s)).toBe(true);
    expect(validScale({ pixels: 0, length: 1, units: 'mm' })).toBe(false);
    expect(validScale({ pixels: 1, length: 1, units: '' })).toBe(false);
  });
  it('formats ruler units from document resolution', () => {
    expect(pixelsPerUnit('in', 300, 1000)).toBe(300);
    expect(pixelsPerUnit('cm', 254, 1000)).toBeCloseTo(100);
    expect(pixelsPerUnit('percent', 72, 400)).toBe(4);
    expect(formatUnit(150, 'in', 300, 1000)).toBe('0.500');
    expect(formatUnit(127, 'mm', 254, 1000)).toBe('12.7');
    expect(formatUnit(36, 'pica', 72, 1000)).toBe('3.00');
    expect(formatUnit(12.4, 'px', 72, 1000)).toBe('12');
    expect(short(120, 4)).toBe('120');
    expect(short(2.5, 4)).toBe('2.5');
    expect(short(0.041666, 3)).toBe('0.042');
    expect(short(-0.00001, 2)).toBe('0');
  });
  it('labels rulers in the chosen unit', () => {
    const doc = { ...newDocument(600, 300), resolution: { horizontalResolution: 100, horizontalResolutionUnit: 'PPI' as const, widthUnit: 'Inches' as const, verticalResolution: 100, verticalResolutionUnit: 'PPI' as const, heightUnit: 'Inches' as const } };
    const scale = rulerUnitScale(doc, 'in');
    expect(scale).toEqual({ x: 100, y: 100 });
    // At 100% zoom one inch is 100 screen pixels: labels every inch.
    const html = rulerTicks(600, 0, 1, false, scale.x);
    expect(html).toContain('<b>1</b>');
    expect(html).toContain('<b>2</b>');
    expect(rulerUnitScale(doc, 'percent')).toEqual({ x: 6, y: 3 });
    expect(rulerUnitScale(doc, 'bogus')).toEqual({ x: 1, y: 1 });
  });
});

describe('sampling averages', () => {
  it('averages a square around the pixel, weighted by alpha', () => {
    const img = rgba8(5, 5, [0, 0, 0, 255]);
    img.data.set([255, 0, 0, 255], (2 * 5 + 2) * 4);
    expect(sampleAverage(img, 2.7, 2.2, 1)).toEqual([255, 0, 0, 255]);
    const avg = sampleAverage(img, 2, 2, 3)!;
    expect(avg[0]).toBeCloseTo(255 / 9);
    // Transparent pixels do not darken the color.
    const t = rgba8(3, 1, [0, 0, 0, 0]);
    t.data.set([200, 100, 50, 255], 4);
    const s = sampleAverage(t, 1, 0, 3)!;
    expect(s.slice(0, 3)).toEqual([200, 100, 50]);
    expect(s[3]).toBeCloseTo(255 / 3);
    // Clipped at the image edge; fully transparent gives null.
    expect(sampleAverage(img, 0, 0, 101)![0]).toBeCloseTo(255 / 25);
    expect(sampleAverage(rgba8(2, 2), 0, 0, 3)).toBeNull();
    expect(sampleAverage(img, -10, -10, 3)).toBeNull();
  });
});

describe('region measurements', () => {
  it('labels 8-connected regions', () => {
    const m = mask8(5, 3);
    m.data[0] = 255;
    m.data[6] = 255; // diagonal neighbour joins the first region
    m.data[4] = 128;
    m.data[14] = 255;
    const { count } = labelRegions(m);
    expect(count).toBe(3);
  });
  it('measures a square: area, size, perimeter and circularity', () => {
    const [r] = measureRegions(rect(40, 40, 10, 5, 20, 20), null);
    expect(r.area).toBe(400);
    expect(r).toMatchObject({ x: 10, y: 5, width: 20, height: 20 });
    // Straight sides measure exactly; smoothing rounds the four corners.
    expect(r.perimeter).toBeGreaterThan(76);
    expect(r.perimeter).toBeLessThanOrEqual(80);
    expect(r.circularity).toBeCloseTo((4 * Math.PI * 400) / r.perimeter ** 2, 6);
    expect(r.circularity).toBeGreaterThan(0.78);
    expect(r.circularity).toBeLessThan(0.86);
  });
  it('measures a disc close to 2πr with circularity near 1', () => {
    const [r] = measureRegions(disc(120, 120, 60, 60, 40), null);
    expect(r.area).toBeCloseTo(Math.PI * 1600, -2);
    expect(r.perimeter / (2 * Math.PI * 40)).toBeGreaterThan(0.99);
    expect(r.perimeter / (2 * Math.PI * 40)).toBeLessThan(1.02);
    expect(r.circularity).toBeGreaterThan(0.96);
  });
  it('counts holes in the perimeter and weights partial coverage', () => {
    const ring = rect(30, 30, 5, 5, 20, 20);
    for (let y = 10; y < 20; y++) ring.data.fill(0, y * 30 + 10, y * 30 + 20);
    const [r] = measureRegions(ring, null);
    expect(r.area).toBe(400 - 100);
    expect(r.perimeter).toBeGreaterThan(76 + 36);
    // A one-pixel line keeps its raw contour (smoothing would erase it).
    const line = measureRegions(rect(20, 5, 2, 2, 10, 1), null)[0];
    expect(line.perimeter).toBeCloseTo(2 * 9 + 2 * Math.SQRT2 * 0.5 * 2, 6);
    expect(measureRegions(rect(5, 5, 2, 2, 1, 1), null)[0].perimeter).toBeCloseTo(2 * Math.SQRT2, 6);
    const half = rect(10, 10, 0, 0, 4, 4, 128);
    expect(measureRegions(half, null)[0].area).toBeCloseTo((16 * 128) / 255);
  });
  it('computes gray statistics and integrated density', () => {
    const img = rgba8(4, 1, [0, 0, 0, 255]);
    [10, 20, 30, 200].forEach((v, i) => img.data.set([v, v, v, 255], i * 4));
    const gray = grayValues(img);
    expect([...gray]).toEqual([10, 20, 30, 200]);
    const mask = rect(4, 1, 0, 0, 3, 1);
    const [r] = measureRegions(mask, gray);
    expect(r.mean).toBeCloseTo(20);
    expect(r.median).toBe(20);
    expect(r.min).toBe(10);
    expect(r.max).toBe(30);
    expect(r.std).toBeCloseTo(Math.sqrt(200 / 3));
    expect(r.integratedDensity).toBeCloseTo(60);
  });
  it('orders regions by area and summarizes them', () => {
    const m = rect(50, 20, 0, 0, 10, 10);
    for (let y = 0; y < 5; y++) m.data.fill(255, y * 50 + 30, y * 50 + 35);
    const regions = measureRegions(m, new Uint8Array(1000).fill(100));
    expect(regions.map((r) => r.area)).toEqual([100, 25]);
    const s = summarize(regions)!;
    expect(s.area).toBe(125);
    expect(s.perimeter).toBeCloseTo(regions[0].perimeter + regions[1].perimeter);
    expect(s).toMatchObject({ x: 0, y: 0, width: 35, height: 10, mean: 100, min: 100, max: 100 });
    expect(summarize([])).toBeNull();
    expect(measureRegions(mask8(4, 4), null)).toEqual([]);
  });
  it('derives statistics from weighted histograms', () => {
    const h = new Float64Array(256);
    h[0] = 1;
    h[255] = 3;
    expect(histogramStats(h)).toMatchObject({ mean: 191.25, median: 255, min: 0, max: 255 });
    expect(histogramStats(new Float64Array(256)).mean).toBe(0);
    expect(circularity(Math.PI, 2 * Math.PI)).toBeCloseTo(1);
    expect(circularity(10, 0)).toBe(0);
  });
});

describe('measurement log CSV', () => {
  it('quotes cells that need it', () => {
    const csv = toCSV([{ id: 'a', label: 'Label' }, { id: 'b', label: 'Area, px' }], [{ a: 'He said "hi"', b: 12.5 }, { a: 'plain' }]);
    expect(csv).toBe('Label,"Area, px"\r\n"He said ""hi""",12.5\r\nplain,\r\n');
  });
});

describe('document annotations', () => {
  const sample = (): Annotations => ({
    samplers: [{ x: 10, y: 20 }],
    counts: [{ id: 'g1', name: 'Cells', color: '#ff0000', markerSize: 3, labelSize: 10, visible: true, points: [[5, 5], [50, 40]] }],
    notes: [{ id: 'n1', x: 30, y: 30, author: 'A', text: 'Check this', color: '#ffd60a', created: '2026-01-01T00:00:00.000Z' }],
    scale: { pixels: 100, length: 2, units: 'cm' },
  });
  it('validates saved annotations', () => {
    expect(() => validateAnnotations(sample())).not.toThrow();
    expect(() => validateAnnotations(undefined)).not.toThrow();
    expect(() => validateAnnotations({ samplers: Array.from({ length: 11 }, () => ({ x: 0, y: 0 })) })).toThrow();
    expect(() => validateAnnotations({ counts: [{ ...sample().counts![0], color: 'red' }] })).toThrow();
    expect(() => validateAnnotations({ notes: [{ ...sample().notes![0], x: NaN }] })).toThrow();
    expect(() => validateAnnotations({ scale: { pixels: -1, length: 1, units: 'cm' } })).toThrow();
    const doc = { ...newDocument(100, 80), annotations: sample() };
    expect(validateDocument(structuredClone(doc)).annotations?.scale?.units).toBe('cm');
    expect(() => validateDocument({ ...doc, annotations: { samplers: 'x' } })).toThrow();
  });
  it('follows crops and resizes', () => {
    const doc = { ...newDocument(100, 80), annotations: sample() };
    cropDocument(doc, { x: 5, y: 10, width: 50, height: 50 });
    expect(doc.annotations.samplers![0]).toEqual({ x: 5, y: 10 });
    expect(doc.annotations.counts![0].points[0]).toEqual([0, -5]);
    expect(doc.annotations.notes![0]).toMatchObject({ x: 25, y: 20 });
    resizeDocument(doc, 100, 25);
    expect(doc.annotations.samplers![0]).toEqual({ x: 10, y: 5 });
    const a = sample();
    mapAnnotations(a, (x, y) => [y, x]);
    expect(a.samplers![0]).toEqual({ x: 20, y: 10 });
  });
  it('keeps color samplers on the same pixel when the canvas rotates or flips', () => {
    // Samplers name a pixel; geometry maps points. A 90° turn of a 100 x 80
    // canvas maps the point (x, y) to (80 - y, x), the pixel to (79 - y, x).
    const a: Annotations = { samplers: [{ x: 10, y: 20 }, { x: 99, y: 79 }] };
    mapAnnotations(a, (x, y) => [80 - y, x]);
    expect(a.samplers).toEqual([{ x: 59, y: 10 }, { x: 0, y: 99 }]);
    // Floating point turns used to leave 50.00000000000001 or 79.99999999 behind.
    const b: Annotations = { samplers: [{ x: 30, y: 20 }] };
    const c = Math.cos(Math.PI / 2),
      s = Math.sin(Math.PI / 2);
    mapAnnotations(b, (x, y) => [c * x - s * y + 100, s * x + c * y]);
    expect(b.samplers).toEqual([{ x: 79, y: 30 }]);
    const flip: Annotations = { samplers: [{ x: 0, y: 5 }] };
    mapAnnotations(flip, (x, y) => [100 - x, y]);
    expect(flip.samplers).toEqual([{ x: 99, y: 5 }]);
  });
  it('drops empty collections', () => {
    expect(tidyAnnotations({ samplers: [], notes: [] })).toBeUndefined();
    expect(tidyAnnotations({ samplers: [], counts: sample().counts })).toEqual({ counts: sample().counts });
  });
  it('imports notes from JSON and plain text', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const json = parseNotes(JSON.stringify({ notes: [{ x: 10, y: 500, text: 'one', author: 'B' }, 'two', { text: 'three', color: '#00ff00' }] }), 200, 100, { author: 'Me', color: '#ffd60a' }, now);
    expect(json.map((n) => n.text)).toEqual(['one', 'two', 'three']);
    expect(json[0]).toMatchObject({ x: 10, y: 99, author: 'B' });
    expect(json[1]).toMatchObject({ author: 'Me', color: '#ffd60a', created: now.toISOString() });
    expect(json[2].color).toBe('#00ff00');
    const text = parseNotes('First note\nstill first\n\n\nSecond note\n', 200, 100, { author: '', color: '#ffd60a' });
    expect(text.map((n) => n.text)).toEqual(['First note\nstill first', 'Second note']);
    expect(text[1].x).toBeGreaterThan(text[0].x);
    expect(() => parseNotes('{"items": []}', 10, 10, { author: '', color: '#ffd60a' })).toThrow();
    expect(() => validateAnnotations({ notes: json })).not.toThrow();
  });
});
