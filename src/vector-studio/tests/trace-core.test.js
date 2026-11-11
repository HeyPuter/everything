import { describe, it, expect } from 'vitest';
import { quantize, kmeans, rgbToOklab } from '../src/features/trace/color.js';
import { components, mergeRegions } from '../src/features/trace/regions.js';
import { buildChains, regionContours, contourArea } from '../src/features/trace/contours.js';
import { fitChain, reverseGeometry, findCorners } from '../src/features/trace/fit.js';
import { traceImage, parsePathData } from '../src/features/trace/trace-core.js';
import { PRESETS, normalizeOptions, matchingPreset, presetOptions, gridSize } from '../src/features/trace/presets.js';
import { flattenPath } from '../src/model/bezier.js';
import { makeImage } from './trace-helpers.js';

const RED = [220, 40, 40];
const BLUE = [30, 90, 200];
const WHITE = [250, 250, 250];
const GREEN = [40, 160, 60];

/** A scene with a disc, a square, a band and an enclosed blob (holes and junctions). */
const scene = (x, y) => {
  if ((x - 40) ** 2 + (y - 40) ** 2 < 8 ** 2) return GREEN; // inside the disc: a hole in it
  if ((x - 40) ** 2 + (y - 40) ** 2 < 25 ** 2) return RED;
  if (x > 70 && x < 110 && y > 20 && y < 70) return BLUE;
  if (y > 80) return GREEN;
  return WHITE;
};

/** Area enclosed by a shape's path data (even-odd), from flattened outlines. */
function shapeArea(d) {
  let total = 0;
  for (const s of parsePathData(d)) {
    const pts = flattenPath(s.anchors, true, 0.05);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    total += a / 2;
  }
  return Math.abs(total);
}

/** Segments of path data as [from, ...controls, to] number lists. */
function segments(d) {
  const out = [];
  for (const s of parsePathData(d)) {
    const a = s.anchors;
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      const q = a[(i + 1) % a.length];
      out.push([p.x, p.y, p.ox, p.oy, q.ix, q.iy, q.x, q.y]);
    }
  }
  return out;
}

describe('color quantization', () => {
  it('finds the exact colors of a flat image (limited palette)', () => {
    const img = makeImage(30, 10, (x) => (x < 10 ? RED : x < 20 ? BLUE : WHITE));
    const q = quantize(img, { mode: 'color', palette: 'limited', colors: 3 });
    expect(q.palette).toHaveLength(3);
    const hex = q.palette.map((c) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)].join());
    expect(hex.sort()).toEqual([RED, BLUE, WHITE].map((c) => c.join()).sort());
    expect(q.labels[0]).not.toBe(q.labels[15]);
    expect(q.labels[0]).toBe(q.labels[9]);
  });

  it('uses only the colors an image has with the automatic palette', () => {
    const img = makeImage(40, 40, (x, y) => ((x - 20) ** 2 + (y - 20) ** 2 < 100 ? RED : WHITE), 3);
    const q = quantize(img, { mode: 'color', palette: 'auto', colors: 16 });
    expect(q.palette.length).toBeLessThanOrEqual(3);
    expect(q.palette.length).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic', () => {
    const img = makeImage(50, 50, (x, y) => [x * 5, y * 5, (x + y) * 2]);
    const a = quantize(img, { mode: 'color', palette: 'limited', colors: 6 });
    const b = quantize(img, { mode: 'color', palette: 'limited', colors: 6 });
    expect([...a.labels]).toEqual([...b.labels]);
  });

  it('separates perceptually distinct colors in OKLab', () => {
    const lab = rgbToOklab(255, 255, 255);
    expect(lab[0]).toBeCloseTo(1, 3);
    expect(Math.abs(lab[1])).toBeLessThan(1e-3);
    const pts = new Float64Array([0, 0, 0, 0.1, 0, 0, 5, 5, 5, 5.1, 5, 5]);
    const r = kmeans(pts, 3, 2);
    expect(r.k).toBe(2);
    expect([...r.counts].sort()).toEqual([2, 2]);
  });

  it('thresholds black and white, quantizes grays and keeps transparency out', () => {
    const img = makeImage(4, 1, (x) => (x < 1 ? [10, 10, 10] : x < 2 ? [200, 200, 200] : x < 3 ? [120, 120, 120, 255] : [0, 0, 0, 0]));
    const bw = quantize(img, { mode: 'bw', threshold: 128 });
    expect([...bw.labels]).toEqual([0, 1, 0, -1]);
    expect(quantize(img, { mode: 'bw', threshold: 100 }).labels[2]).toBe(1);
    const gray = quantize(img, { mode: 'gray', grays: 3 });
    expect(new Set([...gray.labels].filter((l) => l >= 0)).size).toBe(3);
    expect(gray.palette.every((c) => c.r === c.g && c.g === c.b)).toBe(true);
  });

  it('maps onto document swatches exactly', () => {
    const img = makeImage(20, 1, (x) => (x < 10 ? [250, 10, 20] : [10, 20, 240]));
    const q = quantize(img, { mode: 'color', palette: 'swatches', swatches: ['#ff0000', '#0000ff', '#00ff00'] });
    expect(q.palette[q.labels[0]]).toEqual({ r: 255, g: 0, b: 0 });
    expect(q.palette[q.labels[15]]).toEqual({ r: 0, g: 0, b: 255 });
  });
});

describe('regions', () => {
  it('finds 4-connected components', () => {
    // Two diagonal pixels are separate regions.
    const labels = Int32Array.from([1, 0, 0, 1]);
    const cc = components(labels, 2, 2);
    expect(cc.count).toBe(4);
    expect(components(Int32Array.from([1, 1, 0, 0]), 2, 2).count).toBe(2);
  });

  it('absorbs specks smaller than the noise size into their surroundings', () => {
    const w = 20;
    const labels = new Int32Array(w * w);
    labels[5 * w + 5] = 1; // a one-pixel speck
    for (let y = 10; y < 16; y++) for (let x = 10; x < 16; x++) labels[y * w + x] = 2; // a 36-pixel square
    const cc = components(labels, w, w);
    expect(cc.count).toBe(3);
    const merged = mergeRegions(cc, w, w, { minArea: 4 });
    expect(merged.regions).toHaveLength(2);
    expect(merged.regions.map((r) => r.area).sort((a, b) => a - b)).toEqual([36, 364]);
    expect(merged.region[5 * w + 5]).toBe(merged.region[0]);
    // A larger noise size removes the square too.
    expect(mergeRegions(components(labels, w, w), w, w, { minArea: 40 }).regions).toHaveLength(1);
  });

  it('caps the number of regions', () => {
    const w = 40;
    const labels = new Int32Array(w * w).map((_, i) => ((i % w) + Math.floor(i / w)) % 2); // checkerboard
    const r = mergeRegions(components(labels, w, w), w, w, { minArea: 1, maxRegions: 50 });
    expect(r.regions.length).toBeLessThanOrEqual(50);
  });
});

describe('shared boundaries', () => {
  it('splits boundaries into chains shared by exactly two regions', () => {
    const w = 6;
    // Left half region 0, right top 1, right bottom 2: a T junction.
    const region = new Int32Array(w * w).map((_, i) => (i % w < 3 ? 0 : Math.floor(i / w) < 3 ? 1 : 2));
    const g = buildChains(region, w, w);
    for (const c of g.chains) expect(c.left).not.toBe(c.right);
    const contours = regionContours(g, 3);
    for (let r = 0; r < 3; r++) {
      expect(contours[r]).toHaveLength(1);
      // Outer contours run counterclockwise on screen (negative shoelace area) and enclose the region.
      const area = contourArea(g, contours[r][0]);
      expect(area).toBe(r === 0 ? -18 : -9);
    }
  });

  it('gives a region with an island a hole contour', () => {
    const w = 9;
    const region = new Int32Array(w * w).map((_, i) => (Math.abs((i % w) - 4) <= 1 && Math.abs(Math.floor(i / w) - 4) <= 1 ? 1 : 0));
    const g = buildChains(region, w, w);
    const contours = regionContours(g, 2);
    expect(contours[0]).toHaveLength(2);
    const areas = contours[0].map((c) => contourArea(g, c)).sort((a, b) => a - b);
    expect(areas).toEqual([-81, 9]);
    expect(contourArea(g, contours[1][0])).toBe(-9);
  });
});

describe('curve fitting', () => {
  const circleChain = (R) => {
    const w = 2 * R + 20;
    const region = new Int32Array(w * w).map((_, i) => (((i % w) + 0.5 - w / 2) ** 2 + (Math.floor(i / w) + 0.5 - w / 2) ** 2 < R * R ? 1 : 0));
    const g = buildChains(region, w, w);
    return { chain: g.chains.find((c) => c.left === 1 || c.right === 1), c: w / 2 };
  };

  it('fits a pixel circle with a few smooth curves close to the true circle', () => {
    const R = 60;
    const { chain, c } = circleChain(R);
    const g = fitChain(chain.pts, true, { tolerance: 0.6, cornerAngle: 70 });
    expect(g.segs.length).toBeLessThanOrEqual(12);
    expect(g.segs.every((s) => s.length === 6)).toBe(true);
    const anchors = parsePathData(`M${g.x0} ${g.y0}${g.segs.map((s) => `C${s.join(' ')}`).join('')}Z`)[0].anchors;
    for (const p of flattenPath(anchors, true, 0.1)) expect(Math.abs(Math.hypot(p.x - c, p.y - c) - R)).toBeLessThan(1);
  });

  it('keeps rectangle corners exact and straight sides as lines', () => {
    const w = 30;
    const region = new Int32Array(w * w).map((_, i) => (i % w >= 5 && i % w < 25 && Math.floor(i / w) >= 8 && Math.floor(i / w) < 20 ? 1 : 0));
    const chain = buildChains(region, w, w).chains.find((c) => c.left === 1 || c.right === 1);
    const g = fitChain(chain.pts, true, { tolerance: 0.5, cornerAngle: 70 });
    expect(g.segs).toHaveLength(4);
    expect(g.segs.every((s) => s.length === 2)).toBe(true);
    const pts = [[g.x0, g.y0], ...g.segs].map(([x, y]) => `${x},${y}`).sort();
    expect(new Set(pts)).toEqual(new Set(['5,8', '25,8', '25,20', '5,20']));
  });

  it('finds fewer corners at a lower Corners setting', () => {
    // A rounded square: sharp-ish turns that only a high setting calls corners.
    const xs = [];
    const ys = [];
    const n = 120;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      xs.push(Math.round(30 * Math.sign(c) * Math.abs(c) ** 0.35));
      ys.push(Math.round(30 * Math.sign(s) * Math.abs(s) ** 0.35));
    }
    const many = findCorners(xs, ys, true, 40).length;
    const few = findCorners(xs, ys, true, 140).length;
    expect(few).toBeLessThan(many);
  });

  it('reverses geometry exactly', () => {
    const g = { x0: 0, y0: 0, segs: [[10, 0], [12, 2, 14, 6, 10, 10], [0, 10]] };
    const r = reverseGeometry(g);
    expect(r.x0).toBe(0);
    expect(r.y0).toBe(10);
    expect(r.segs).toEqual([[10, 10], [14, 6, 12, 2, 10, 0], [0, 0]]);
    expect(reverseGeometry(r)).toEqual(g);
  });
});

describe('traceImage', () => {
  const img = makeImage(120, 100, scene, 3);

  it('produces abutting shapes that share every boundary exactly (no gaps)', () => {
    const r = traceImage(img, { mode: 'color', palette: 'limited', colors: 4, noise: 4, method: 'abutting' });
    expect(r.stats.colors).toBe(4);
    const all = new Map();
    const key = (s) => s.map((v) => v.toFixed(2)).join(',');
    r.shapes.forEach((s, i) => {
      for (const seg of segments(s.d)) {
        const k = key(seg);
        if (!all.has(k)) all.set(k, new Set());
        all.get(k).add(i);
      }
    });
    const onBorder = (seg) => [0, 6].every((j) => seg[j] === 0 || seg[j] === 120) && seg[0] === seg[6] ? true : [1, 7].every((j) => seg[j] === 0 || seg[j] === 100) && seg[1] === seg[7];
    let shared = 0;
    r.shapes.forEach((s, i) => {
      for (const seg of segments(s.d)) {
        if (onBorder(seg)) continue;
        const rev = [seg[6], seg[7], seg[4], seg[5], seg[2], seg[3], seg[0], seg[1]];
        const owners = all.get(key(rev));
        expect(owners, `segment ${key(seg)} has no twin`).toBeTruthy();
        expect([...owners].some((o) => o !== i)).toBe(true);
        shared++;
      }
    });
    expect(shared).toBeGreaterThan(10);
    // Together the shapes tile the image.
    const covered = r.shapes.reduce((a, s) => a + shapeArea(s.d), 0);
    expect(Math.abs(covered - 120 * 100) / (120 * 100)).toBeLessThan(0.002);
  });

  it('stacks shapes without holes when overlapping', () => {
    const ab = traceImage(img, { mode: 'color', palette: 'limited', colors: 4, noise: 4, method: 'abutting' });
    const ov = traceImage(img, { mode: 'color', palette: 'limited', colors: 4, noise: 4, method: 'overlapping' });
    const subs = (r) => r.shapes.reduce((a, s) => a + parsePathData(s.d).length, 0);
    expect(subs(ov)).toBeLessThan(subs(ab));
    // The background comes first, with the disc and the square stacked on it instead of cut out.
    expect(parsePathData(ov.shapes[0].d)).toHaveLength(1);
    expect(parsePathData(ab.shapes[0].d).length).toBeGreaterThan(1);
  });

  it('traces black and white with white left out', () => {
    const r = traceImage(img, { mode: 'bw', threshold: 128, ignoreWhite: true, noise: 4 });
    expect(r.shapes.every((s) => s.f === '#000000')).toBe(true);
    expect(r.stats.colors).toBe(1);
    // Dark areas: the red disc ring, the blue square and the green band.
    const area = r.shapes.reduce((a, s) => a + shapeArea(s.d), 0);
    expect(area).toBeGreaterThan(1500);
    expect(area).toBeLessThan(120 * 100 * 0.6);
  });

  it('turns thin lines into centerline strokes', () => {
    const line = makeImage(100, 60, (x, y) => (Math.abs(y - 30 - 0.2 * (x - 50)) < 2 && x > 10 && x < 90 ? [0, 0, 0] : [255, 255, 255]), 3);
    const r = traceImage(line, { mode: 'bw', strokes: true, fills: false, strokeWidth: 8, ignoreWhite: true, noise: 2 });
    expect(r.shapes).toHaveLength(1);
    const s = r.shapes[0];
    expect(s.s).toBe('#000000');
    expect(s.sw).toBeGreaterThanOrEqual(3);
    expect(s.sw).toBeLessThanOrEqual(5);
    const a = parsePathData(s.d)[0].anchors;
    const ends = [a[0], a[a.length - 1]].sort((p, q) => p.x - q.x);
    expect(ends[0].x).toBeLessThan(16);
    expect(ends[1].x).toBeGreaterThan(84);
    // Thick areas are not strokes.
    const blob = makeImage(60, 60, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 400 ? [0, 0, 0] : [255, 255, 255]));
    expect(traceImage(blob, { mode: 'bw', strokes: true, fills: false, strokeWidth: 8, ignoreWhite: true }).shapes).toHaveLength(0);
  });

  it('removes speckle noise', () => {
    const noisy = makeImage(80, 80, (x, y) => ((Math.floor(x) * 7 + Math.floor(y) * 13) % 97 === 0 ? [0, 0, 0] : (x - 40) ** 2 + (y - 40) ** 2 < 400 ? RED : WHITE));
    const clean = traceImage(noisy, { mode: 'color', palette: 'limited', colors: 3, noise: 9 });
    const raw = traceImage(noisy, { mode: 'color', palette: 'limited', colors: 3, noise: 1 });
    expect(clean.shapes.length).toBeLessThan(raw.shapes.length);
    expect(clean.shapes.length).toBeLessThanOrEqual(2);
  });

  it('stays fast on a megapixel image', () => {
    const big = makeImage(1200, 860, (x, y) => [128 + 100 * Math.sin(x / 37) * Math.cos(y / 53), 128 + 90 * Math.sin((x + y) / 71), 128 + 80 * Math.cos(x / 23 - y / 41)]);
    let last = 0;
    let calls = 0;
    const t0 = performance.now();
    const r = traceImage(big, { mode: 'color', palette: 'limited', colors: 8, noise: 16 }, { onProgress: (v) => ((last = v), calls++) });
    const ms = performance.now() - t0;
    expect(r.shapes.length).toBeGreaterThan(8);
    expect(last).toBe(1);
    expect(calls).toBeGreaterThan(4);
    expect(ms).toBeLessThan(15000);
  });
});

describe('presets', () => {
  it('normalizes and clamps options', () => {
    const o = normalizeOptions({ colors: 99, noise: -5, mode: 'nope', paths: 50.4, fills: false, strokes: false });
    expect(o.colors).toBe(30);
    expect(o.noise).toBe(1);
    expect(o.mode).toBe('color');
    expect(o.paths).toBe(50);
    expect(o.fills).toBe(true);
  });

  it('has unique, complete presets that round-trip through matching', () => {
    const ids = new Set(PRESETS.map((p) => p.id));
    const labels = new Set(PRESETS.map((p) => p.label));
    expect(ids.size).toBe(PRESETS.length);
    expect(labels.size).toBe(PRESETS.length);
    expect(PRESETS.length).toBeGreaterThanOrEqual(12);
    for (const p of PRESETS) {
      expect(matchingPreset(presetOptions(p.id))?.id).toBe(p.id);
      if (p.quick) expect(p.icon).toBeTruthy();
    }
    expect(matchingPreset({ ...presetOptions('bw'), threshold: 77 })).toBe(null);
  });

  it('traces a sample with every preset', () => {
    const small = makeImage(60, 50, (x, y) => scene(x * 2, y * 2), 2);
    for (const p of PRESETS) {
      const r = traceImage(small, presetOptions(p.id), { scale: 1 });
      expect(r.stats.paths, p.label).toBeGreaterThan(0);
      expect(r.shapes.every((s) => /^M[\d.\s-]+/.test(s.d))).toBe(true);
    }
  });

  it('works at a resolution suited to the image', () => {
    expect(gridSize(4000, 3000, 2)).toMatchObject({ w: 1200, h: 900 });
    expect(gridSize(100, 50, 2)).toMatchObject({ w: 400, h: 200, scale: 4 });
    expect(gridSize(800, 600, 3).w).toBe(1700);
  });
});

describe('reading pixels to trace', () => {
  it('reads a large image only at the working resolution', async () => {
    const { tracePixels, setPixelSource } = await import('../src/features/trace/trace-runner.js');
    setPixelSource(null);
    const reads = [];
    const OrigImage = globalThis.Image;
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    globalThis.Image = class {
      naturalWidth = 6000;
      naturalHeight = 4000;
      decode() {
        return Promise.resolve();
      }
    };
    HTMLCanvasElement.prototype.getContext = function () {
      return {
        drawImage() {},
        getImageData: (x, y, w, h) => {
          reads.push([w, h]);
          return { data: new Uint8ClampedArray(w * h * 4) };
        },
      };
    };
    try {
      const doc = { assets: new Map([['big', { mime: 'image/png', data: 'data:image/png;base64,' }]]) };
      const { image, scale, natural } = await tracePixels(doc, 'big', 2);
      expect(natural).toEqual({ width: 6000, height: 4000 });
      expect([image.width, image.height]).toEqual([1200, 800]);
      expect(scale).toBeCloseTo(0.2);
      // The full 24-megapixel image is never read (or kept in the pixel cache).
      expect(reads).toEqual([[1200, 800]]);
      // Another detail level reuses the known size and reads only its own grid.
      await tracePixels(doc, 'big', 3);
      expect(reads).toEqual([[1200, 800], [1700, 1133]]);
    } finally {
      globalThis.Image = OrigImage;
      HTMLCanvasElement.prototype.getContext = origGetContext;
      setPixelSource(null);
    }
  });
});
