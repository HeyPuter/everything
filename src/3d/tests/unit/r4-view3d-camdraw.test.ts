import { describe, it, expect } from 'vitest';
import { cameraExtrasGeometry } from '../../src/editors/view3d/camdraw';
import { newCamera } from '../../src/data/defaults';

describe('camera display extras', () => {
  it('draws the clip range, focus cross and mist range along -Z', () => {
    const ca = { ...newCamera('C'), show_limits: true, show_mist: true, clip_start: 1, clip_end: 12 };
    ca.dof = { ...ca.dof, use_dof: true, focus_distance: 6, focus_object: null };
    const g = cameraExtrasGeometry(ca, { start: 3, depth: 5 });
    expect(g.lines.slice(0, 6)).toEqual([0, 0, -1, 0, 0, -12]);
    // the focus cross lies in the plane z = -6
    expect(g.lines.length).toBe(18);
    expect(g.lines.filter((_, i) => i % 3 === 2 && i >= 6).every((z) => z === -6)).toBe(true);
    expect(g.mistLines).toEqual([0, 0, -3, 0, 0, -8]);
    expect(g.dots.length / 3).toBe(4);
  });

  it('draws nothing when the options are off', () => {
    const g = cameraExtrasGeometry({ ...newCamera('C'), show_limits: false }, { start: 3, depth: 5 });
    expect(g.lines.length + g.mistLines.length + g.dots.length).toBe(0);
  });
});
