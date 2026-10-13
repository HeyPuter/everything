import { describe, it, expect } from 'vitest';
import { quadHomography, mapUV, unmapUV, isConvexQuad, orderQuad, perspectiveMesh, meshQuad, perspectiveGrid, rectQuad } from '../src/features/mockup/perspective.js';
import { evalMesh } from '../src/features/envelope/envelope-model.js';
import { detectSurface, convexHull, largestQuad } from '../src/features/mockup/detect.js';
import { applyLighting, luminanceGrid, sampleGrid } from '../src/features/mockup/lighting.js';
import { initialQuad } from '../src/features/mockup/mockup-model.js';
import { makeImage } from './trace-helpers.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('Perspective mapping', () => {
  const quad = [
    { x: 10, y: 20 },
    { x: 210, y: 40 },
    { x: 190, y: 180 },
    { x: 30, y: 150 },
  ];

  it('maps the unit square corners onto the quad and inverts', () => {
    const H = quadHomography(quad);
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], k) => {
      const p = mapUV(H, u, v);
      expect(close(p.x, quad[k].x)).toBe(true);
      expect(close(p.y, quad[k].y)).toBe(true);
    });
    const p = mapUV(H, 0.3, 0.7);
    const back = unmapUV(H, p.x, p.y);
    expect(close(back.u, 0.3, 1e-9)).toBe(true);
    expect(close(back.v, 0.7, 1e-9)).toBe(true);
  });

  it('keeps straight lines straight and foreshortens the far side', () => {
    // A trapezoid: the top edge is shorter (farther away).
    const t = [
      { x: 40, y: 0 },
      { x: 60, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const H = quadHomography(t);
    const a = mapUV(H, 0.5, 0);
    const b = mapUV(H, 0.5, 0.5);
    const c = mapUV(H, 0.5, 1);
    // The center line stays straight (collinear).
    expect(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))).toBeLessThan(1e-6);
    // The middle of the square lies past the quad's vertical middle (toward the far, short edge).
    expect(b.y).toBeLessThan(50);
  });

  it('recognises convex, ordered quads', () => {
    expect(isConvexQuad(quad)).toBe(true);
    expect(isConvexQuad([quad[0], quad[2], quad[1], quad[3]])).toBe(false);
    expect(isConvexQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }])).toBe(false);
    const shuffled = [quad[2], quad[0], quad[3], quad[1]];
    expect(orderQuad(shuffled)).toEqual(quad);
  });

  it('builds envelope meshes that follow the perspective', () => {
    const rect = rectQuad({ x: 0, y: 0, w: 100, h: 50 });
    expect(perspectiveGrid(quadHomography(rect))).toBe(1);
    const m1 = perspectiveMesh(rect);
    expect(m1.rows).toBe(1);
    const mesh = perspectiveMesh(quad);
    expect(mesh.rows).toBeGreaterThan(3);
    const corners = meshQuad(mesh);
    corners.forEach((p, k) => {
      expect(close(p.x, quad[k].x, 1e-6)).toBe(true);
      expect(close(p.y, quad[k].y, 1e-6)).toBe(true);
    });
    // Inside a patch the Coons surface stays close to the true projective map.
    const H = quadHomography(quad);
    for (const [u, v] of [[0.13, 0.41], [0.5, 0.5], [0.77, 0.9]]) {
      const want = mapUV(H, u, v);
      const got = evalMesh(mesh, u, v);
      expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.25);
    }
  });

  it('places new art over its own bounds, or centered on the photo', () => {
    const photo = { x: 0, y: 0, w: 400, h: 300 };
    expect(initialQuad({ x: 50, y: 50, w: 100, h: 40 }, photo)[0]).toEqual({ x: 50, y: 50 });
    const q = initialQuad({ x: 900, y: 900, w: 100, h: 100 }, photo);
    expect(q[0].x).toBeCloseTo(125);
    expect(q[2].x - q[0].x).toBeCloseTo(150);
    expect(q[2].y - q[0].y).toBeCloseTo(150);
  });
});

describe('Surface detection', () => {
  // A light card in perspective on a darker, textured table.
  const card = [
    { x: 60, y: 50 },
    { x: 190, y: 70 },
    { x: 175, y: 160 },
    { x: 45, y: 140 },
  ];
  const inside = (x, y) => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = card[i];
      const b = card[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c < 0) return false;
      s++;
    }
    return s === 4;
  };
  const photo = makeImage(240, 200, (x, y) => {
    if (inside(x, y)) {
      // Soft shading across the card.
      const v = 235 - x * 0.12;
      return [v, v, v - 6];
    }
    const n = ((x * 7 + y * 13) % 5) * 3;
    return [90 + n, 70 + n, 55 + n];
  }, 2);

  it('finds the four corners of the flat region around a point', () => {
    const found = detectSurface(photo, 120, 105);
    expect(found).toBeTruthy();
    found.quad.forEach((p, k) => {
      expect(Math.hypot(p.x - card[k].x, p.y - card[k].y)).toBeLessThan(5);
    });
    expect(found.coverage).toBeGreaterThan(0.9);
  });

  it('gives up where there is no clear surface', () => {
    const noise = makeImage(120, 100, (x, y) => {
      const v = (x * 37 + y * 91 + x * y * 7) % 255;
      return [v, (v * 3) % 255, (v * 7) % 255];
    });
    expect(detectSurface(noise, 60, 50)).toBeNull();
  });

  it('inscribes the largest quadrilateral in a convex hull', () => {
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push({ x: 100 + Math.cos(a) * 50, y: 100 + Math.sin(a) * 30 });
    }
    pts.push({ x: 50, y: 70 }, { x: 150, y: 70 }, { x: 150, y: 130 }, { x: 50, y: 130 });
    const q = largestQuad(convexHull(pts));
    const xs = q.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBe(50);
    expect(xs[3]).toBe(150);
  });
});

describe('Mockup lighting', () => {
  const art = (w, h, color = [200, 40, 40]) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d.set([...color, 255], i * 4);
    return d;
  };

  it('leaves the art alone under even light', () => {
    const src = art(8, 8);
    const out = applyLighting(src, 8, 8, () => 0.5, { strength: 1 });
    expect([...out]).toEqual([...src]);
  });

  it('darkens the art in shadow and lightens it in highlights, keeping alpha', () => {
    const src = art(10, 2);
    src[3] = 128;
    const out = applyLighting(src, 10, 2, (x) => (x < 5 ? 0.3 : 0.7), { strength: 1 });
    // Left half darker than the original, right half lighter.
    expect(out[4 * 1]).toBeLessThan(200);
    expect(out[4 * 8]).toBeGreaterThan(200);
    expect(out[3]).toBe(128);
    // Half strength moves half as far toward the shading.
    const half = applyLighting(src, 10, 2, (x) => (x < 5 ? 0.3 : 0.7), { strength: 0.5 });
    expect(half[4 * 1]).toBeGreaterThan(out[4 * 1]);
    expect(half[4 * 1]).toBeLessThan(200);
  });

  it('returns null when the art is not over the photo', () => {
    expect(applyLighting(art(4, 4), 4, 4, () => NaN, { strength: 1 })).toBeNull();
  });

  it('displaces the art with the luminance', () => {
    const W = 20;
    const src = new Uint8ClampedArray(W * W * 4);
    // A one pixel vertical line at x = 10.
    for (let y = 0; y < W; y++) src.set([0, 0, 0, 255], (y * W + 10) * 4);
    // Darker than average at the top, brighter at the bottom: the halves move apart diagonally.
    const lum = (x, y) => (y < 10 ? 0.7 : 0.9);
    const out = applyLighting(src, W, W, lum, { strength: 0, displace: 20 });
    const alphaAt = (x, y) => out[(y * W + x) * 4 + 3];
    expect(alphaAt(12, 5)).toBeGreaterThan(200);
    expect(alphaAt(10, 3)).toBeLessThan(50);
    expect(alphaAt(8, 15)).toBeGreaterThan(200);
    expect(alphaAt(10, 15)).toBeLessThan(50);
  });

  it('builds a smoothed luminance grid', () => {
    const px = makeImage(64, 32, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
    const g = luminanceGrid(px, 16);
    expect(g.w).toBe(16);
    expect(g.h).toBe(8);
    expect(sampleGrid(g, 1, 4)).toBeLessThan(0.05);
    expect(sampleGrid(g, 15, 4)).toBeGreaterThan(0.95);
    expect(Number.isNaN(sampleGrid(g, -1, 4))).toBe(true);
  });
});
