import { describe, it, expect } from 'vitest';
import { lightWireShape, lightMarkerShape, spotBlendAngle, spotCircle, spotSilhouette, SPOT_CONE_LENGTH, SUN_LINE_LENGTH } from '../../src/editors/view3d/lightshapes';

const base = { spot_size: Math.PI / 4, spot_blend: 0.15, size: 1, size_y: 0.5, shape: 'SQUARE', cutoff_distance: 40 };
const zs = (seg: number[]) => seg.filter((_, i) => i % 3 === 2);

describe('light shapes', () => {
  it('spot cone sides are 10 units long and the base circle matches the spot size', () => {
    const c = spotCircle(Math.PI / 8);
    expect(Math.hypot(c.r, c.z)).toBeCloseTo(SPOT_CONE_LENGTH, 6);
    expect(Math.atan2(c.r, -c.z)).toBeCloseTo(Math.PI / 8, 6);
  });

  it('blend circle lies in the base plane, inside the outer circle', () => {
    const seg = lightWireShape({ type: 'SPOT', ...base });
    const c = spotCircle(Math.PI / 8);
    // two rings + the direction line
    const pts: [number, number, number][] = [];
    for (let i = 0; i < seg.length; i += 3) pts.push([seg[i], seg[i + 1], seg[i + 2]]);
    const radii = new Set(pts.filter((p) => Math.abs(p[2] - c.z) < 1e-6).map((p) => Math.round(Math.hypot(p[0], p[1]) * 1000) / 1000));
    expect([...radii].sort()).toEqual([Math.round(-c.z * Math.tan(spotBlendAngle(Math.PI / 4, 0.15)) * 1000) / 1000, Math.round(c.r * 1000) / 1000].sort());
    // inner/outer radius ratio for the default blend
    const inner = -c.z * Math.tan(spotBlendAngle(Math.PI / 4, 0.15));
    expect(inner / c.r).toBeCloseTo(0.914, 2);
    // direction line reaches the cutoff distance
    expect(Math.min(...zs(seg))).toBeCloseTo(-40, 6);
  });

  it('sun has a 20 unit direction line, area its shape and a line to the cutoff distance', () => {
    expect(lightWireShape({ type: 'SUN', ...base })).toEqual([0, 0, 0, 0, 0, -SUN_LINE_LENGTH]);
    const area = lightWireShape({ type: 'AREA', ...base, cutoff_distance: 3 });
    expect(Math.min(...zs(area))).toBeCloseTo(-3, 6);
    const xs = area.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(0.5, 6);
    expect(lightWireShape({ type: 'POINT', ...base })).toEqual([]);
  });

  it('marker: sun adds rays', () => {
    expect(lightMarkerShape('SUN').length).toBeGreaterThan(lightMarkerShape('POINT').length);
  });

  it('spot silhouette lines are tangent to the cone as seen from the eye', () => {
    const half = Math.PI / 8;
    const { z, r } = spotCircle(half);
    const h = -z;
    for (const eye of [
      [5, 3, -2],
      [-4, 1, 6],
      [0.5, -7, 1],
    ] as [number, number, number][]) {
      const seg = spotSilhouette(eye, z, r);
      expect(seg.length).toBe(12);
      for (const k of [3, 9]) {
        const th = Math.atan2(seg[k + 1], seg[k]);
        const n = [h * Math.cos(th), h * Math.sin(th), r];
        expect(n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2]).toBeCloseTo(0, 6);
      }
    }
    // looking straight into the cone there is no silhouette
    expect(spotSilhouette([0, 0, -20], z, r)).toEqual([]);
    // side view from +X: silhouette at ±Y
    const side = spotSilhouette([100, 0, 0], z, r);
    expect(Math.abs(side[4])).toBeCloseTo(r, 6);
    expect(Math.abs(side[3])).toBeCloseTo(0, 6);
  });
});
