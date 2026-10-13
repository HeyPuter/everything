import { describe, it, expect } from 'vitest';
import {
  LM, faceWidth, faceFrame, matchFaces, smoothLandmarks, trackFaces, FACE_HOLD, faceHandles, warpPlan, warpOffset,
  packHandles, fillPolygon, blurMask, faceMasks, spotStrength, spotRadius, hairRegion,
} from '../src/engine/face-geometry.js';
import { meanLuma } from '../src/engine/face-render.js';
import { makeupRegions, makeupMasks } from '../src/engine/makeup-geometry.js';

/** Points on an ellipse for a list of landmark ids, starting at angle a0 (degrees) and stepping by da. */
function ring(pts, ids, cx, cy, rx, ry, a0, da) {
  ids.forEach((id, k) => {
    const a = ((a0 + da * k) * Math.PI) / 180;
    pts[id * 2] = cx + Math.cos(a) * rx;
    pts[id * 2 + 1] = cy + Math.sin(a) * ry;
  });
}

/**
 * A stylized face looking at the camera, centered at (cx, cy), about
 * 320 * s pixels wide, with the landmarks the face tools use in place.
 */
function syntheticFace(cx = 500, cy = 500, s = 1) {
  const pts = new Float32Array(478 * 2);
  for (let i = 0; i < 478; i++) {
    pts[i * 2] = cx;
    pts[i * 2 + 1] = cy;
  }
  ring(pts, LM.oval, cx, cy, 160 * s, 210 * s, -90, 10);
  ring(pts, LM.eyeA, cx - 60 * s, cy - 60 * s, 30 * s, 10 * s, 180, 22.5);
  ring(pts, LM.eyeB, cx + 60 * s, cy - 60 * s, 30 * s, 10 * s, 0, -22.5);
  ring(pts, LM.browA, cx - 60 * s, cy - 95 * s, 40 * s, 7 * s, 180, 36);
  ring(pts, LM.browB, cx + 60 * s, cy - 95 * s, 40 * s, 7 * s, 0, -36);
  ring(pts, LM.lipsOuter, cx, cy + 100 * s, 60 * s, 22 * s, 180, 18);
  ring(pts, LM.lipsInner, cx, cy + 100 * s, 50 * s, 8 * s, 180, 18);
  const set = (id, x, y) => {
    pts[id * 2] = cx + x * s;
    pts[id * 2 + 1] = cy + y * s;
  };
  set(LM.irisA, -60, -60);
  set(LM.irisB, 60, -60);
  set(LM.noseTip, 0, 30);
  set(LM.noseBase, 0, 45);
  set(LM.alaA, -25, 45);
  set(LM.alaB, 25, 45);
  set(LM.wingA, -22, 30);
  set(LM.wingB, 22, 30);
  return pts;
}

const jitter = (pts, amount, seed) => {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  };
  return pts.map((v) => v + rnd() * 2 * amount);
};
const shift = (pts, dx, dy) => pts.map((v, i) => v + (i % 2 ? dy : dx));
const spread = (frames, i) => {
  const xs = frames.map((f) => f[i]);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('face frame', () => {
  it('measures a face and its axes', () => {
    const f = syntheticFace();
    const fr = faceFrame(f);
    expect(fr.width).toBeCloseTo(faceWidth(f));
    expect(fr.width).toBeGreaterThan(300);
    expect(fr.ux[0]).toBeCloseTo(1);
    expect(fr.uy[1]).toBeCloseTo(1);
  });
});

describe('steadying landmarks', () => {
  it('averages out jitter on a still face', () => {
    const base = syntheticFace();
    const raw = [];
    const out = [];
    let prev = null;
    for (let k = 0; k < 60; k++) {
      const next = jitter(base, 2, k + 1);
      raw.push(next);
      prev = smoothLandmarks(prev, next, 1 / 30);
      out.push(prev);
    }
    const i = LM.chin * 2;
    expect(spread(out.slice(10), i)).toBeLessThan(spread(raw.slice(10), i) * 0.6);
  });

  it('follows real motion almost at once', () => {
    const a = syntheticFace();
    const b = shift(a, 60, 0); // a fifth of the face width in one frame
    const s = smoothLandmarks(a, b, 1 / 30);
    expect(s[0] - a[0]).toBeGreaterThan(60 * 0.85);
  });

  it('takes new points as they are after a jump or a mismatch', () => {
    const a = syntheticFace();
    const b = shift(a, 3, 0);
    expect([...smoothLandmarks(a, b, 0)]).toEqual([...b]);
    expect([...smoothLandmarks(a, b, 1)]).toEqual([...b]);
    expect([...smoothLandmarks(null, b, 1 / 30)]).toEqual([...b]);
    expect([...smoothLandmarks(a.slice(2), b, 1 / 30)]).toEqual([...b]);
  });

  it('matches faces by position, whatever order the model reports them in', () => {
    const left = syntheticFace(300, 500, 0.5);
    const right = syntheticFace(800, 500, 0.5);
    expect(matchFaces([left, right], [shift(right, 4, 0), shift(left, -3, 2)])).toEqual([1, 0]);
    expect(matchFaces([left], [right])).toEqual([-1]);
  });

  it('holds a briefly lost face, then lets it go', () => {
    const f = syntheticFace();
    let tracks = trackFaces(null, [f], 0, 0);
    tracks = trackFaces(tracks, [], 0.1, 0.1);
    expect(tracks).toHaveLength(1);
    tracks = trackFaces(tracks, [], FACE_HOLD + 0.05, 0.1);
    expect(tracks).toHaveLength(0);
  });
});

describe('face shape warp', () => {
  const face = syntheticFace();
  const zero = { slim: 0, eyes: 0, nose: 0, smile: 0, chin: 0 };
  const px = (id) => [face[id * 2], face[id * 2 + 1]];

  it('adds no handles when every amount is zero', () => {
    expect(faceHandles(face, zero)).toEqual([]);
    expect(warpPlan([face], zero).groups).toEqual([]);
  });

  it('pulls the jaw toward the middle for a slimmer face and pushes it out for a fuller one', () => {
    const slim = faceHandles(face, { ...zero, slim: 1 });
    const [ax, ay] = px(LM.jawA[2]);
    const [bx, by] = px(LM.jawB[2]);
    // The picture at the jaw comes from further out: content moves inward.
    expect(warpOffset(slim, ax, ay)[0]).toBeGreaterThan(5);
    expect(warpOffset(slim, bx, by)[0]).toBeLessThan(-5);
    const full = faceHandles(face, { ...zero, slim: -1 });
    expect(warpOffset(full, ax, ay)[0]).toBeLessThan(-5);
  });

  it('enlarges the eyes around the iris', () => {
    const hs = faceHandles(face, { ...zero, eyes: 1 });
    const [ix, iy] = px(LM.irisA);
    expect(warpOffset(hs, ix, iy)).toEqual([0, 0]);
    // Right of the iris the picture is sampled nearer the iris: magnified.
    expect(warpOffset(hs, ix + 15, iy)[0]).toBeGreaterThan(1);
    expect(warpOffset(faceHandles(face, { ...zero, eyes: -1 }), ix + 15, iy)[0]).toBeLessThan(-1);
  });

  it('lifts the mouth corners for a smile and lengthens the chin', () => {
    const [mx, my] = px(LM.mouthA);
    expect(warpOffset(faceHandles(face, { ...zero, smile: 1 }), mx, my)[1]).toBeLessThan(-2);
    expect(warpOffset(faceHandles(face, { ...zero, smile: -1 }), mx, my)[1]).toBeGreaterThan(2);
    const [cx, cy] = px(LM.chin);
    expect(warpOffset(faceHandles(face, { ...zero, chin: 1 }), cx, cy)[1]).toBeGreaterThan(5);
  });

  it('narrows the nose', () => {
    const [ax, ay] = px(LM.alaA);
    expect(warpOffset(faceHandles(face, { ...zero, nose: 1 }), ax, ay)[0]).toBeGreaterThan(1);
  });

  it('never folds the picture, even with every slider at either end', () => {
    for (const sign of [1, -1]) {
      const hs = faceHandles(face, { slim: sign, eyes: sign, nose: sign, smile: sign, chin: -sign });
      const map = (x, y) => {
        const [dx, dy] = warpOffset(hs, x, y);
        return [x - dx, y - dy];
      };
      let minDet = Infinity;
      for (let y = 220; y <= 780; y += 4) {
        for (let x = 280; x <= 720; x += 4) {
          const a = map(x, y);
          const bx = map(x + 1, y);
          const by = map(x, y + 1);
          minDet = Math.min(minDet, (bx[0] - a[0]) * (by[1] - a[1]) - (bx[1] - a[1]) * (by[0] - a[0]));
        }
      }
      expect(minDet).toBeGreaterThan(0.2);
    }
  });

  it('leaves everything outside each face group untouched', () => {
    const { handles, groups } = warpPlan([face], { slim: 1, eyes: 1, nose: 1, smile: 1, chin: 1 });
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect([g.first, g.end]).toEqual([0, handles.length]);
    for (let a = 0; a < 360; a += 15) {
      const x = g.cx + Math.cos((a * Math.PI) / 180) * (g.reach + 1);
      const y = g.cy + Math.sin((a * Math.PI) / 180) * (g.reach + 1);
      expect(warpOffset(handles, x, y)).toEqual([0, 0]);
    }
    // Far from the face nothing moves at all.
    expect(warpOffset(handles, 50, 50)).toEqual([0, 0]);
  });

  it('can reshape only the largest face', () => {
    const small = syntheticFace(150, 150, 0.4);
    const all = warpPlan([small, face], { ...zero, slim: 1 });
    const largest = warpPlan([small, face], { ...zero, slim: 1 }, 'largest');
    expect(all.groups).toHaveLength(2);
    expect(largest.groups).toHaveLength(1);
    expect(largest.groups[0].cx).toBeCloseTo(500, 0);
  });

  it('packs handles as three texture rows', () => {
    const hs = faceHandles(face, { ...zero, eyes: 1 });
    const data = packHandles(hs);
    const n = hs.length;
    expect(data).toHaveLength(n * 3 * 4);
    expect([...data.slice(0, 2)]).toEqual([hs[0].c[0], hs[0].c[1]].map(Math.fround));
    expect(data[n * 4]).toBeCloseTo(hs[0].m[0]);
    expect(data[2 * n * 4]).toBeCloseTo(hs[0].s);
    expect(packHandles([])).toHaveLength(12);
  });
});

describe('region masks', () => {
  it('fills a polygon with antialiased coverage and cuts holes', () => {
    const w = 20;
    const buf = new Float32Array(w * w);
    fillPolygon(buf, w, w, [2, 2, 12, 2, 12, 12, 2, 12]);
    const sum = buf.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(100, 1);
    expect(buf[5 * w + 5]).toBe(1);
    expect(buf[0]).toBe(0);
    const half = new Float32Array(w * w);
    fillPolygon(half, w, w, [2.5, 2, 12, 2, 12, 12, 2.5, 12]);
    expect(half[5 * w + 2]).toBeCloseTo(0.5);
    fillPolygon(buf, w, w, [5, 5, 9, 5, 9, 9, 5, 9], 'cut');
    expect(buf[7 * w + 7]).toBe(0);
    expect(buf.reduce((a, b) => a + b, 0)).toBeCloseTo(84, 1);
  });

  it('blurs without losing mass or changing flat areas', () => {
    const w = 30;
    const buf = new Float32Array(w * w);
    buf[15 * w + 15] = 1;
    blurMask(buf, w, w, 3);
    expect(buf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(buf[15 * w + 15]).toBeLessThan(0.1);
    const flat = new Float32Array(w * w).fill(0.5);
    blurMask(flat, w, w, 4);
    expect(Math.max(...flat.map((v) => Math.abs(v - 0.5)))).toBeLessThan(1e-6);
  });

  it('gives the same blur when limited to the part that was drawn', () => {
    const w = 40;
    const a = new Float32Array(w * w);
    fillPolygon(a, w, w, [10, 12, 18, 11, 16, 20]);
    const b = Float32Array.from(a);
    blurMask(a, w, w, 2);
    blurMask(b, w, w, 2, [10, 11, 18, 20]);
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i])))).toBeLessThan(1e-6);
  });

  it('marks skin, under-eye, lips and mouth in their own channels', () => {
    const face = syntheticFace();
    const m = faceMasks([face], 1000, 1000);
    const at = (x, y, ch) => {
      const mx = Math.floor(((x - m.rect[0]) / m.rect[2]) * m.width);
      const my = Math.floor(((y - m.rect[1]) / m.rect[3]) * m.height);
      return m.data[(my * m.width + mx) * 4 + ch];
    };
    expect(at(400, 520, 0)).toBeGreaterThan(200); // cheek: spots are cleared
    expect(at(440, 440, 0)).toBe(0); // eye: never
    expect(at(500, 600, 0)).toBe(0); // mouth: never
    expect(at(440, 462, 1)).toBeGreaterThan(80); // under the eye
    expect(at(440, 520, 1)).toBe(0);
    expect(at(500, 582, 2)).toBeGreaterThan(200); // upper lip
    expect(at(500, 600, 2)).toBeLessThan(40); // not inside the mouth
    expect(at(500, 600, 3)).toBeGreaterThan(200); // inside the mouth
    expect(at(500, 640, 3)).toBe(0);
    expect(faceMasks([], 100, 100)).toBeNull();
  });

  it('keeps masks small for big faces', () => {
    const m = faceMasks([syntheticFace(1500, 1500, 4)], 3000, 3000, { maxSide: 256 });
    expect(Math.max(m.width, m.height)).toBeLessThanOrEqual(256);
  });
});

describe('blemish spots', () => {
  const w = 40;
  const flat = () => new Float32Array(w * w).fill(0.6);
  const r = 4;

  it('finds a small dark spot and not the skin around it', () => {
    const v = flat();
    for (let y = 19; y <= 21; y++) for (let x = 19; x <= 21; x++) v[y * w + x] = 0.5;
    expect(spotStrength(v, w, w, 20, 20, r)).toBe(1);
    expect(spotStrength(v, w, w, 30, 30, r)).toBe(0);
    expect(spotStrength(flat(), w, w, 20, 20, r)).toBe(0);
  });

  it('ignores faint texture, bright spots, edges and lines', () => {
    const faint = flat();
    faint[20 * w + 20] = 0.595;
    expect(spotStrength(faint, w, w, 20, 20, r)).toBe(0);
    const bright = flat();
    bright[20 * w + 20] = 0.9;
    expect(spotStrength(bright, w, w, 20, 20, r)).toBe(0);
    const edge = flat();
    for (let y = 0; y < w; y++) for (let x = 20; x < w; x++) edge[y * w + x] = 0.3;
    expect(spotStrength(edge, w, w, 20, 20, r)).toBe(0);
    expect(spotStrength(edge, w, w, 21, 20, r)).toBe(0);
    const line = flat();
    for (let x = 0; x < w; x++) line[20 * w + x] = 0.4;
    expect(spotStrength(line, w, w, 20, 20, r)).toBe(0);
  });

  it('misses spots larger than the ring; a wider ring catches them', () => {
    const v = flat();
    for (let y = 12; y <= 28; y++) for (let x = 12; x <= 28; x++) v[y * w + x] = 0.45;
    expect(spotStrength(v, w, w, 20, 20, r)).toBe(0);
    expect(spotStrength(v, w, w, 20, 20, r * 3)).toBe(1);
  });

  it('scales the ring with the face', () => {
    expect(spotRadius(100)).toBe(1.5);
    expect(spotRadius(500)).toBeCloseTo(6);
    expect(spotRadius(5000)).toBe(10);
  });
});

describe('hair', () => {
  it('looks around the heads, in a square that stays put for small moves', () => {
    const face = syntheticFace();
    const r = hairRegion([face]);
    expect(r[2]).toBe(r[3]);
    expect(r[0]).toBeLessThan(340);
    expect(r[0] + r[2]).toBeGreaterThan(660);
    expect(r[1]).toBeLessThan(290 - 100); // above the forehead
    expect(r[1] + r[3]).toBeGreaterThan(710); // down past the chin
    expect(hairRegion([shift(face, 0.6, -0.4)])).toEqual(r);
    expect(hairRegion([])).toBeNull();
    const two = hairRegion([syntheticFace(300, 500, 0.5), syntheticFace(900, 500, 0.5)]);
    expect(two[0]).toBeLessThan(220);
    expect(two[0] + two[2]).toBeGreaterThan(980);
  });

  it('measures the mean brightness of the hair the matte covers', () => {
    const w = 32;
    const rgba = new Uint8ClampedArray(w * w * 4);
    const matte = new Uint8ClampedArray(w * w);
    for (let i = 0; i < w * w; i++) {
      const hair = i % w < 16;
      rgba.set(hair ? [51, 51, 51, 255] : [255, 255, 255, 255], i * 4);
      matte[i] = hair ? 255 : 0;
    }
    expect(meanLuma(rgba, matte, w, w, w, w)).toBeCloseTo(0.2, 2);
    expect(meanLuma(rgba, new Uint8ClampedArray(w * w), w, w, w, w)).toBeNull();
  });
});

describe('makeup regions', () => {
  const face = syntheticFace();
  const center = (poly) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < poly.length; i += 2) {
      x += poly[i];
      y += poly[i + 1];
    }
    return [(x * 2) / poly.length, (y * 2) / poly.length];
  };

  it('places each product where it goes on the face', () => {
    const r = makeupRegions(face);
    const [blushA, blushB] = r.blush.map(center);
    // Blush on the cheeks: below the eyes, beside the nose, above the mouth.
    expect(blushA[0]).toBeLessThan(440);
    expect(blushB[0]).toBeGreaterThan(560);
    for (const b of [blushA, blushB]) {
      expect(b[1]).toBeGreaterThan(470);
      expect(b[1]).toBeLessThan(590);
    }
    // Eyeshadow above the lids and below the brows; eyeliner hugs the lash line.
    for (const poly of r.shadow) {
      for (let i = 1; i < poly.length; i += 2) {
        expect(poly[i]).toBeLessThanOrEqual(441);
        expect(poly[i]).toBeGreaterThan(408);
      }
    }
    for (const poly of r.liner) for (let i = 1; i < poly.length; i += 2) expect(Math.abs(poly[i] - 430)).toBeLessThan(15);
    expect(r.brows).toHaveLength(2);
    expect(r.contour.length).toBeGreaterThanOrEqual(8);
    expect(r.highlight.length).toBeGreaterThanOrEqual(6);
    // Everything stays on the face.
    for (const key of ['blush', 'shadow', 'liner', 'brows', 'contour', 'highlight']) {
      for (const poly of r[key]) {
        for (let i = 0; i < poly.length; i += 2) {
          expect(Math.abs(poly[i] - 500)).toBeLessThan(175);
          expect(Math.abs(poly[i + 1] - 500)).toBeLessThan(225);
        }
      }
    }
  });

  it('draws soft masks, keeping shadow and liner off the eyes', () => {
    const m = makeupMasks([face], 1000, 1000);
    expect(m.color).toHaveLength(m.width * m.height * 4);
    expect(m.sculpt).toHaveLength(m.width * m.height * 4);
    const at = (buf, x, y, c) => {
      const mx = Math.floor(((x - m.rect[0]) * m.width) / m.rect[2]);
      const my = Math.floor(((y - m.rect[1]) * m.height) / m.rect[3]);
      return buf[(my * m.width + mx) * 4 + c];
    };
    expect(at(m.color, 421, 528, 0)).toBeGreaterThan(150); // blush on the apple of the cheek
    expect(at(m.color, 440, 422, 1)).toBeGreaterThan(60); // shadow on the lid
    expect(at(m.color, 440, 440, 1)).toBe(0); // not on the eye
    expect(at(m.color, 440, 440, 2)).toBe(0);
    expect(at(m.color, 440, 405, 3)).toBeGreaterThan(150); // brow
    expect(at(m.sculpt, 500, 352, 1)).toBeGreaterThan(150); // highlight mid-forehead
    expect(at(m.sculpt, 375, 521, 0)).toBeGreaterThan(60); // contour under the cheekbone
    expect(at(m.sculpt, 500, 352, 0)).toBe(0);
    expect(at(m.color, m.rect[0] + 1, m.rect[1] + 1, 0)).toBe(0);
    expect(makeupMasks([], 100, 100)).toBeNull();
  });
});
