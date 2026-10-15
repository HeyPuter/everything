import { describe, it, expect } from 'vitest';
import { Matrix3, Vector3 } from 'three';
import { bendMatrix, evalNumeric, falloffWeight, randomOffset, seededRandom, shearMatrix, toSpherePoint, warpPoint, type BendFrame } from '../../src/ops/transform_math';

const close = (a: Vector3, b: Vector3, eps = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  expect(a.z).toBeCloseTo(b.z, 5);
  void eps;
};

describe('proportional falloff', () => {
  it('is 1 at the selection and 0 at the radius for every curve', () => {
    for (const f of ['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR']) {
      expect(falloffWeight(f, 0)).toBeCloseTo(1);
      expect(falloffWeight(f, 1)).toBe(0);
      expect(falloffWeight(f, 0.5)).toBeGreaterThan(0);
      expect(falloffWeight(f, 0.5)).toBeLessThan(1);
    }
    expect(falloffWeight('CONSTANT', 0.99)).toBe(1);
    expect(falloffWeight('LINEAR', 0.25)).toBeCloseTo(0.75);
    expect(falloffWeight('SMOOTH', 0.5)).toBeCloseTo(0.5);
  });
});

describe('shear', () => {
  it('slides points along one axis in proportion to the other', () => {
    const m = shearMatrix(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0), Math.PI / 4);
    close(new Vector3(0, 2, 0).applyMatrix4(m), new Vector3(2, 2, 0));
    close(new Vector3(0, -1, 3).applyMatrix4(m), new Vector3(-1, -1, 3));
    // points on the measuring line through the center stay put
    close(new Vector3(5, 0, 1).applyMatrix4(m), new Vector3(5, 0, 1));
  });
  it('works around a center', () => {
    const m = shearMatrix(new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0), Math.atan(0.5));
    close(new Vector3(0, 1, 0).applyMatrix4(m), new Vector3(0, 1, 0));
    close(new Vector3(0, 3, 0).applyMatrix4(m), new Vector3(1, 3, 0));
  });
});

describe('bend', () => {
  const f: BendFrame = { origin: new Vector3(0, 0, 0), dir: new Vector3(1, 0, 0), side: new Vector3(0, 1, 0), length: 2 };
  it('leaves points before the origin alone', () => {
    close(new Vector3(-1, 0.5, 0).applyMatrix4(bendMatrix(f, Math.PI / 2, new Vector3(-1, 0.5, 0))), new Vector3(-1, 0.5, 0));
  });
  it('rolls the region onto a quarter circle', () => {
    const angle = Math.PI / 2;
    const R = f.length / angle;
    // the end of the region lands a quarter turn around the centre of curvature (0, R)
    const end = new Vector3(2, 0, 0);
    close(end.clone().applyMatrix4(bendMatrix(f, angle, end)), new Vector3(R, R, 0));
    // points beyond the region continue along the tangent (straight up)
    const beyond = new Vector3(3, 0, 0);
    close(beyond.clone().applyMatrix4(bendMatrix(f, angle, beyond)), new Vector3(R, R + 1, 0));
    // arc length is preserved along the bend
    const mid = new Vector3(1, 0, 0);
    const pm = mid.clone().applyMatrix4(bendMatrix(f, angle, mid));
    expect(pm.distanceTo(new Vector3(0, R, 0))).toBeCloseTo(R);
  });
  it('is the identity without an angle', () => {
    const p = new Vector3(1, 2, 3);
    close(p.clone().applyMatrix4(bendMatrix(f, 0, p)), p);
  });
});

describe('warp', () => {
  it('wraps a horizontal strip into a ring around the center', () => {
    const view = new Matrix3(); // right = X, up = Y, towards the viewer = Z
    const c = new Vector3(0, 0, 0);
    const a = warpPoint(new Vector3(-1, 2, 0), c, view, Math.PI * 2, 0, -1, 1);
    const b = warpPoint(new Vector3(0, 2, 0), c, view, Math.PI * 2, 0, -1, 1);
    const d = warpPoint(new Vector3(1, 2, 0), c, view, Math.PI * 2, 0, -1, 1);
    // every point keeps its distance (y) from the center as radius
    for (const p of [a, b, d]) expect(Math.hypot(p.x, p.y)).toBeCloseTo(2);
    // the start and the end of the strip meet after a full turn
    close(a, d);
    // the middle lands half way round
    close(b, new Vector3(0, -2, 0));
  });
});

describe('to sphere', () => {
  it('moves points onto the sphere by the factor', () => {
    const c = new Vector3();
    close(toSpherePoint(new Vector3(4, 0, 0), c, 2, 1), new Vector3(2, 0, 0));
    close(toSpherePoint(new Vector3(4, 0, 0), c, 2, 0.5), new Vector3(3, 0, 0));
    close(toSpherePoint(new Vector3(4, 0, 0), c, 2, 0), new Vector3(4, 0, 0));
  });
});

describe('randomize', () => {
  it('is deterministic per seed and bounded by the amount', () => {
    const a = seededRandom(7),
      b = seededRandom(7),
      c = seededRandom(8);
    const va = randomOffset(a, 0.3, 0, 0, null);
    const vb = randomOffset(b, 0.3, 0, 0, null);
    const vc = randomOffset(c, 0.3, 0, 0, null);
    close(va, vb);
    expect(va.distanceTo(vc)).toBeGreaterThan(1e-6);
    expect(va.length()).toBeCloseTo(0.3);
    const r = seededRandom(1);
    for (let i = 0; i < 50; i++) expect(randomOffset(r, 0.3, 1, 0, null).length()).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

describe('numeric input', () => {
  it('evaluates expressions and units', () => {
    expect(evalNumeric('2')).toBe(2);
    expect(evalNumeric('2*3+1')).toBe(7);
    expect(evalNumeric('-')).toBe(-1);
    expect(evalNumeric('')).toBeNull();
    expect(evalNumeric('1+')).toBe(1);
    expect(evalNumeric('(1+2')).toBe(3);
    expect(evalNumeric('50cm', 'distance')).toBeCloseTo(0.5);
    expect(evalNumeric('1m+20cm', 'distance')).toBeCloseTo(1.2);
    expect(evalNumeric('2ft', 'distance')).toBeCloseTo(0.6096);
    expect(evalNumeric('5mm', 'distance')).toBeCloseTo(0.005);
    expect(evalNumeric('pi', 'angle')).toBeCloseTo(Math.PI);
    expect(evalNumeric('1r', 'angle')).toBeCloseTo(180 / Math.PI);
    expect(evalNumeric('45°', 'angle')).toBe(45);
  });
});
