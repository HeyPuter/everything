import { describe, it, expect } from 'vitest';
import { backgroundImagePlacement, newBackgroundImage } from '../../src/editors/view3d/camerabgplace';
import { boundsTexSpace, manualTexSpace } from '../../src/render/texspace';
import type { DocumentData, ObjectData } from '../../src/data/types';

describe('camera background image placement', () => {
  const frame = { x: 100, y: 50, w: 400, h: 200 };
  it('stretches to the frame by default', () => {
    const p = backgroundImagePlacement(frame, 100, 100, newBackgroundImage());
    expect(p).toEqual({ cx: 300, cy: 150, w: 400, h: 200, rotation: 0 });
  });
  it('fits inside or crops to the frame keeping the aspect', () => {
    const fit = backgroundImagePlacement(frame, 100, 100, { ...newBackgroundImage(), frame_method: 'FIT' });
    expect([fit.w, fit.h]).toEqual([200, 200]);
    const crop = backgroundImagePlacement(frame, 100, 100, { ...newBackgroundImage(), frame_method: 'CROP' });
    expect([crop.w, crop.h]).toEqual([400, 400]);
  });
  it('offsets in frame widths (y up) and scales', () => {
    const p = backgroundImagePlacement(frame, 100, 50, { ...newBackgroundImage(), offset: [0.25, 0.1], scale: 0.5, rotation: 1 });
    expect(p.cx).toBeCloseTo(400);
    expect(p.cy).toBeCloseTo(110);
    expect([p.w, p.h]).toEqual([200, 100]);
    expect(p.rotation).toBe(1);
  });
});

describe('texture space', () => {
  it('centres on the bounds with half sizes', () => {
    const b = boundsTexSpace(new Float32Array([-1, 0, 2, 3, 4, 2]));
    expect(b.location).toEqual([1, 2, 2]);
    expect(b.size[0]).toBe(2);
    expect(b.size[1]).toBe(2);
    expect(b.size[2]).toBeGreaterThan(0);
  });
  it('is manual only when automatic is off', () => {
    const me = { use_auto_texspace: true, texspace_location: [1, 0, 0], texspace_size: [2, 1, 1] };
    const doc = { meshes: { m: me }, curves: {} } as unknown as DocumentData;
    const ob = { data: 'm' } as ObjectData;
    expect(manualTexSpace(doc, ob)).toBeNull();
    me.use_auto_texspace = false;
    expect(manualTexSpace(doc, ob)).toEqual([-1, -1, -1, 3, 1, 1]);
  });
});
