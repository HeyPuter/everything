import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import { polygonize, fieldElements, fieldAt, cubeTable, falloff } from '../../src/metaball/polygonize';
import { newMetaElement } from '../../src/metaball/data';
import type { EvalMesh } from '../../src/eval/types';
import type { MetaElement } from '../../src/metaball/types';

function bounds(m: EvalMesh) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.positions[i + k]);
      hi[k] = Math.max(hi[k], m.positions[i + k]);
    }
  return { lo, hi };
}

/** Every undirected edge is used by exactly two faces, once in each direction. */
function checkClosedManifold(m: EvalMesh) {
  const dir = new Map<string, number>();
  const nf = m.offsets.length - 1;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const a = m.indices[c],
        b = m.indices[c + 1 < e ? c + 1 : s];
      const k = `${a}>${b}`;
      dir.set(k, (dir.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const [k, n] of dir) {
    const [a, b] = k.split('>');
    if (n !== 1 || dir.get(`${b}>${a}`) !== 1) bad++;
  }
  return bad;
}

/** Signed volume (positive when faces point outwards). */
function volume(m: EvalMesh) {
  let v = 0;
  const P = m.positions;
  const nf = m.offsets.length - 1;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const a = m.indices[s] * 3;
    for (let c = s + 1; c + 1 < e; c++) {
      const b = m.indices[c] * 3,
        d = m.indices[c + 1] * 3;
      v += (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
    }
  }
  return v;
}

const ball = (o: Partial<MetaElement> = {}): MetaElement => ({ ...newMetaElement('BALL'), ...o });

describe('metaball field', () => {
  it('falls off as stiffness * (1 - d²/r²)³ and is zero beyond the radius', () => {
    expect(falloff(0, 2, 2)).toBeCloseTo(2);
    expect(falloff(4, 2, 2)).toBe(0);
    expect(falloff(1, 2, 2)).toBeCloseTo(2 * 0.75 ** 3);
  });

  it('derives a closed, oriented triangulation for all 256 cube cases', () => {
    const t = cubeTable();
    expect(t.length).toBe(256);
    expect(t[0].length).toBe(0);
    expect(t[255].length).toBe(0);
    // every crossing edge of a configuration is used by exactly one loop
    for (let cfg = 1; cfg < 255; cfg++) {
      const used = t[cfg].flat();
      expect(new Set(used).size).toBe(used.length);
    }
  });
});

describe('metaball polygonization', () => {
  it('a single ball is closed, manifold, outward facing and sized by radius/stiffness/threshold', () => {
    const { mesh } = polygonize(fieldElements([ball()]), 0.6, 0.1);
    expect(mesh.offsets.length - 1).toBeGreaterThan(100);
    expect(checkClosedManifold(mesh)).toBe(0);
    expect(volume(mesh)).toBeGreaterThan(0);
    // surface where 2(1 - d²/4)³ = 0.6
    const expected = Math.sqrt(4 * (1 - Math.cbrt(0.3)));
    const { lo, hi } = bounds(mesh);
    for (let k = 0; k < 3; k++) {
      expect(hi[k]).toBeGreaterThan(expected - 0.03);
      expect(hi[k]).toBeLessThanOrEqual(expected + 0.002);
      expect(lo[k]).toBeLessThan(-expected + 0.03);
    }
    expect(mesh.smooth?.every((s) => s === 1)).toBe(true);
  });

  it('weak elements below the threshold produce nothing', () => {
    const { mesh } = polygonize(fieldElements([ball({ stiffness: 0.5 })]), 0.6, 0.2);
    expect(mesh.positions.length).toBe(0);
  });

  it('a negative element carves the surface', () => {
    const a = polygonize(fieldElements([ball()]), 0.6, 0.1).mesh;
    const b = polygonize(fieldElements([ball(), ball({ co: [1, 0, 0], radius: 1.5, use_negative: true })]), 0.6, 0.1).mesh;
    expect(checkClosedManifold(b)).toBe(0);
    expect(volume(b)).toBeLessThan(volume(a) * 0.9);
    expect(bounds(b).hi[0]).toBeLessThan(bounds(a).hi[0] - 0.1);
  });

  it('two nearby balls merge into one blob and stay manifold', () => {
    const { mesh } = polygonize(fieldElements([ball(), ball({ co: [1.5, 0, 0] })]), 0.6, 0.15);
    expect(checkClosedManifold(mesh)).toBe(0);
    const { lo, hi } = bounds(mesh);
    expect(lo[0]).toBeLessThan(-1);
    expect(hi[0]).toBeGreaterThan(2.5);
    // the field between the centres stays above the threshold (joined)
    expect(fieldAt(fieldElements([ball(), ball({ co: [1.5, 0, 0] })]), 0.75, 0, 0)).toBeGreaterThan(0.6);
  });

  it('capsules, planes, cubes and ellipsoids extend along their size', () => {
    const r = Math.sqrt(4 * (1 - Math.cbrt(0.3)));
    const ext = (e: MetaElement) => bounds(polygonize(fieldElements([e]), 0.6, 0.05).mesh).hi;
    expect(ext(newMetaElement('CAPSULE'))[0]).toBeCloseTo(1 + r, 1);
    expect(ext(newMetaElement('CAPSULE'))[1]).toBeCloseTo(r, 1);
    const pl = ext(newMetaElement('PLANE'));
    expect(pl[1]).toBeCloseTo(1 + r, 1);
    expect(pl[2]).toBeCloseTo(r, 1);
    expect(ext(newMetaElement('CUBE'))[2]).toBeCloseTo(1 + r, 1);
    const el = ext(newMetaElement('ELLIPSOID'));
    expect(el[0]).toBeCloseTo(1.2 * r, 1);
    expect(el[1]).toBeCloseTo(0.8 * r, 1);
  });

  it('places elements through rotations and owner transforms', () => {
    const e = newMetaElement('CAPSULE');
    const s = Math.SQRT1_2;
    e.rotation = [s, 0, 0, s]; // 90° about Z: capsule along Y
    const hi = bounds(polygonize(fieldElements([e]), 0.6, 0.05).mesh).hi;
    expect(hi[1]).toBeGreaterThan(hi[0] + 0.5);
    const moved = bounds(polygonize(fieldElements([ball()], new Matrix4().makeTranslation(5, 0, 0)), 0.6, 0.1).mesh);
    expect(moved.lo[0]).toBeGreaterThan(3.5);
  });
});
