import { describe, expect, it } from 'vitest';
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { rng } from '../src/imaging/filters/sampling';
import { correctLens, estimateCA, opticsActive } from '../src/imaging/filters/develop/optics';
import {
  detectUpright,
  geometryActive,
  transformGeometry,
} from '../src/imaging/filters/develop/geometry';

function make(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number, number?],
) {
  const img = rgba8(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      img.data.set([r, g, b, a ?? 255], (y * w + x) * 4);
    }
  return img;
}
const px = (img: RGBA8, x: number, y: number, c = 0) => img.data[(y * img.width + x) * 4 + c];

// Antialiased dark line of half-width ~1.5 px through (x0, y0) - (x1, y1) on white.
function lines(w: number, h: number, segs: [number, number, number, number][]) {
  return make(w, h, (x, y) => {
    let cover = 0;
    for (const [x0, y0, x1, y1] of segs) {
      const dx = x1 - x0,
        dy = y1 - y0,
        len = Math.hypot(dx, dy);
      const d = Math.abs((x + 0.5 - x0) * dy - (y + 0.5 - y0) * dx) / len;
      cover = Math.max(cover, Math.min(1, Math.max(0, 2 - d)));
    }
    const v = 255 * (1 - cover);
    return [v, v, v];
  });
}

// Darkness-weighted (transparent counts as nothing) x centroid of row y between columns x0 and x1.
function rowCentroid(img: RGBA8, y: number, x0: number, x1: number) {
  let s = 0,
    sx = 0;
  for (let x = x0; x < x1; x++) {
    const v = ((255 - px(img, x, y)) * px(img, x, y, 3)) / 255;
    s += v;
    sx += v * (x + 0.5);
  }
  return sx / s;
}
// Darkness-weighted y centroid of column x between rows y0 and y1.
function colCentroid(img: RGBA8, x: number, y0: number, y1: number) {
  let s = 0,
    sy = 0;
  for (let y = y0; y < y1; y++) {
    const v = ((255 - px(img, x, y)) * px(img, x, y, 3)) / 255;
    s += v;
    sy += v * (y + 0.5);
  }
  return sy / s;
}

describe('develop optics: identity', () => {
  it('is inactive at defaults and returns the input itself', () => {
    const src = make(20, 10, (x, y) => [x * 10, y * 20, 90]);
    expect(opticsActive({})).toBe(false);
    expect(opticsActive({ lensVignettingMidpoint: 80 })).toBe(false);
    expect(opticsActive({ removeCA: true })).toBe(true);
    expect(correctLens(src, {}, 1)).toBe(src);
    expect(geometryActive({ geoConstrain: true })).toBe(false);
    expect(transformGeometry(src, { geoConstrain: true, geoScale: 100 }, 1)).toBe(src);
  });

  it('is deterministic', () => {
    const src = make(64, 48, (x, y) => [(x * 37) % 256, (y * 53) % 256, ((x + y) * 11) % 256]);
    const p = { lensDistortion: 40, lensVignetting: 30, removeCA: true, defringePurple: 5 };
    expect(correctLens(src, p, 1).data).toEqual(correctLens(src, p, 1).data);
    const q = { geoRotate: 3, geoVertical: -20, geoConstrain: true };
    expect(transformGeometry(src, q, 1).data).toEqual(transformGeometry(src, q, 1).data);
  });
});

describe('develop optics: distortion', () => {
  // A horizontal line near the top: pincushion-type correction (positive)
  // moves its ends outward more than its middle, barrel-type (negative) the reverse.
  const src = lines(160, 120, [[0, 20, 160, 20]]);
  it('positive bows lines toward the center, negative away, corners stay filled', () => {
    const pos = correctLens(src, { lensDistortion: 80 }, 1),
      neg = correctLens(src, { lensDistortion: -80 }, 1);
    const bow = (img: RGBA8) => colCentroid(img, 80, 0, 60) - colCentroid(img, 12, 0, 60);
    expect(Math.abs(bow(src))).toBeLessThan(0.1);
    expect(bow(pos)).toBeGreaterThan(1.5);
    expect(bow(neg)).toBeLessThan(-1.5);
    for (const img of [pos, neg])
      for (const [x, y] of [
        [0, 0],
        [159, 0],
        [0, 119],
        [159, 119],
      ]) {
        expect(px(img, x, y, 3)).toBe(255);
        expect(px(img, x, y)).toBeGreaterThan(200);
      }
  });
});

describe('develop optics: vignetting', () => {
  it('brightens corners for positive values, darkens for negative, center unchanged', () => {
    const src = make(100, 80, () => [100, 100, 100]);
    const pos = correctLens(src, { lensVignetting: 60 }, 1),
      neg = correctLens(src, { lensVignetting: -60 }, 1);
    expect(px(pos, 50, 40)).toBe(100);
    expect(px(pos, 0, 0)).toBeGreaterThan(115);
    expect(px(neg, 0, 0)).toBeLessThan(85);
    // A higher midpoint confines the correction to the corners.
    const late = correctLens(src, { lensVignetting: 60, lensVignettingMidpoint: 90 }, 1);
    expect(px(pos, 5, 40)).toBeGreaterThan(100);
    expect(px(late, 5, 40)).toBeLessThan(px(pos, 5, 40));
  });
});

describe('develop optics: chromatic aberration', () => {
  // Soft-edged gray checkerboard whose red plane is magnified and blue plane shrunk
  // radially about the center (lateral color), supersampled 4 x 4.
  const W = 200,
    H = 160,
    E = 0.01;
  const check = (x: number, y: number) =>
    130 +
    100 *
      Math.max(-1, Math.min(1, 2.5 * Math.sin((Math.PI * x) / 10) * Math.sin((Math.PI * y) / 10)));
  const at = (x: number, y: number, s: number) => {
    let v = 0;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const u = x + (i + 0.5) / 4 - W / 2,
          w = y + (j + 0.5) / 4 - H / 2;
        v += check(W / 2 + u / s, H / 2 + w / s);
      }
    return v / 16;
  };
  const src = make(W, H, (x, y) => [at(x, y, 1 + E), at(x, y, 1), at(x, y, 1 - E)]);
  const misreg = (img: RGBA8) => {
    let s = 0;
    for (let y = 8; y < H - 8; y++)
      for (let x = 8; x < W - 8; x++)
        s +=
          Math.abs(px(img, x, y, 0) - px(img, x, y, 1)) +
          Math.abs(px(img, x, y, 2) - px(img, x, y, 1));
    return s;
  };
  it('estimates the radial scales of red and blue', () => {
    const { r, b } = estimateCA(src);
    expect(r).toBeCloseTo(E, 2);
    expect(b).toBeCloseTo(-E, 2);
    expect(Math.abs(r - E)).toBeLessThan(0.002);
    expect(Math.abs(b + E)).toBeLessThan(0.002);
  });
  it('reduces red / blue misregistration', () => {
    const out = correctLens(src, { removeCA: true }, 1);
    expect(misreg(out)).toBeLessThan(misreg(src) * 0.4);
  });
  it('leaves an aligned image alone', () => {
    const gray = make(W, H, (x, y) => {
      const v = at(x, y, 1);
      return [v, v, v];
    });
    expect(estimateCA(gray)).toEqual({ r: 0, b: 0 });
  });
});

describe('develop optics: defringe', () => {
  // Bright / dark edge with a 2 px purple fringe on the dark side, plus a purple
  // patch far from any strong edge.
  const fringe = [170, 60, 200];
  const src = make(96, 40, (x) => {
    if (x < 40) return [250, 250, 250];
    if (x < 42) return fringe as [number, number, number];
    if (x >= 80) return [120, 80, 140];
    return [20, 20, 20];
  });
  const chroma = (img: RGBA8, x: number) => {
    const r = px(img, x, 20, 0),
      g = px(img, x, 20, 1),
      b = px(img, x, 20, 2);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  it('desaturates a purple fringe next to a high-contrast edge', () => {
    const out = correctLens(src, { defringePurple: 10 }, 1);
    expect(chroma(out, 40)).toBeLessThan(chroma(src, 40) * 0.3);
    expect(chroma(out, 41)).toBeLessThan(chroma(src, 41) * 0.3);
    // Far from the edge the soft purple patch keeps its color.
    expect(chroma(out, 90)).toBe(chroma(src, 90));
  });
  it('the green control does not touch purple', () => {
    const out = correctLens(src, { defringeGreen: 20 }, 1);
    expect(chroma(out, 40)).toBe(chroma(src, 40));
  });
});

describe('develop geometry: transform', () => {
  it('positive rotation turns the picture clockwise', () => {
    const src = make(121, 121, (x, y) =>
      Math.hypot(x - 100, y - 60) < 3 ? [255, 255, 255] : [0, 0, 0],
    );
    const out = transformGeometry(src, { geoRotate: 10 }, 1);
    let s = 0,
      sx = 0,
      sy = 0;
    for (let y = 0; y < 121; y++)
      for (let x = 0; x < 121; x++) {
        const v = px(out, x, y);
        s += v;
        sx += v * (x + 0.5);
        sy += v * (y + 0.5);
      }
    const cx = sx / s,
      cy = sy / s;
    // Screen coordinates (y down): clockwise moves a point right of center downward.
    expect(cy - 60.5).toBeCloseTo(40 * Math.sin((10 * Math.PI) / 180), 0);
    expect(cx - 60.5).toBeCloseTo(40 * Math.cos((10 * Math.PI) / 180), 0);
  });

  it('leaves transparent corners without Constrain and fills them with it', () => {
    const src = make(80, 60, () => [128, 128, 128]);
    const free = transformGeometry(src, { geoRotate: 6, geoVertical: -30 }, 1),
      fill = transformGeometry(src, { geoRotate: 6, geoVertical: -30, geoConstrain: true }, 1);
    expect(px(free, 0, 59, 3)).toBe(0);
    expect(px(free, 79, 59, 3)).toBe(0);
    expect(fill.data.every((v, i) => (i & 3) !== 3 || v === 255)).toBe(true);
    // Alpha-weighted sampling: no dark fringe along the visible border.
    for (let i = 0; i < free.data.length; i += 4)
      if (free.data[i + 3] > 0) expect(free.data[i]).toBe(128);
  });

  it('keystone correction makes upward-converging lines parallel', () => {
    const W = 200,
      H = 200;
    const src = lines(W, H, [
      [60, 200, 80, 0],
      [140, 200, 120, 0],
    ]);
    const gap = (img: RGBA8, y: number) =>
      rowCentroid(img, y, 100, 200) - rowCentroid(img, y, 0, 100);
    expect(gap(src, 30) / gap(src, 170)).toBeLessThan(0.85);
    const up = detectUpright(src, 'vertical');
    expect(up.vertical).toBeLessThan(0);
    expect(Math.abs(up.rotate)).toBeLessThan(0.3);
    const out = transformGeometry(src, { upright: 'vertical' }, 1, undefined, up);
    expect(gap(out, 40) / gap(out, 160)).toBeGreaterThan(0.95);
    expect(gap(out, 40) / gap(out, 160)).toBeLessThan(1.05);
    // The same through the parameters alone (analysis inside the transform).
    expect(transformGeometry(src, { upright: 'vertical' }, 1).data).toEqual(out.data);
    // Manual: negative Vertical widens the top.
    const manual = transformGeometry(src, { geoVertical: -40 }, 1);
    expect(gap(manual, 40) / gap(manual, 160)).toBeGreaterThan(gap(src, 40) / gap(src, 160));
  });
});

describe('develop geometry: upright analysis', () => {
  // Grid of dark lines turned 3 degrees clockwise about the center.
  const grid = (deg: number) => {
    const a = (deg * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a);
    return make(256, 192, (x, y) => {
      const dx = x + 0.5 - 128,
        dy = y + 0.5 - 96;
      const u = c * dx + s * dy,
        v = -s * dx + c * dy;
      const du = Math.abs((((u % 40) + 60) % 40) - 20),
        dv = Math.abs((((v % 40) + 60) % 40) - 20);
      const cover = Math.max(0, Math.min(1, 1.5 - Math.min(du, dv)));
      const val = 230 - 200 * cover;
      return [val, val, val];
    });
  };
  it('finds a known tilt', () => {
    const r = detectUpright(grid(3), 'level');
    expect(r.rotate).toBeGreaterThan(-3.3);
    expect(r.rotate).toBeLessThan(-2.7);
    expect(r.vertical).toBe(0);
    const ccw = detectUpright(grid(-2), 'auto');
    expect(ccw.rotate).toBeGreaterThan(1.7);
    expect(ccw.rotate).toBeLessThan(2.3);
    expect(Math.abs(ccw.vertical)).toBeLessThan(3);
    // Applying the result levels the grid again.
    const fixed = transformGeometry(grid(3), { upright: 'level' }, 1);
    expect(Math.abs(detectUpright(fixed, 'level').rotate)).toBeLessThan(0.3);
  });

  it('returns zeros on noise and smooth gradients', () => {
    const r = rng(17);
    const noise = make(200, 150, () => {
      const v = r() * 255;
      return [v, v, v];
    });
    const ramp = make(200, 150, (x, y) => [x, (x + y) / 2, y]);
    for (const img of [noise, ramp])
      for (const mode of ['auto', 'level', 'vertical', 'full'] as const)
        expect(detectUpright(img, mode)).toEqual({ rotate: 0, vertical: 0, horizontal: 0 });
    // Nothing found: the transform hands back the input itself.
    expect(transformGeometry(noise, { upright: 'auto' }, 1)).toBe(noise);
  });
});
