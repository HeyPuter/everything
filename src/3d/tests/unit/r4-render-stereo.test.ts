// Stereoscopy / multi-view rendering (views, eye placement, combining eyes) and the shutter
// curve of motion blur.
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { defaultRender } from '../../src/data/defaults';
import { renderViews, multiview, eyeTransform, defaultCameraStereo, combineStereo, anaglyph, interlace, uniqueViewName, viewFileName, stereoResult } from '../../src/render/final/stereo';
import { applyEye } from '../../src/render/final/stereocamera';
import { shutterTime, shutterCurvePoints, shutterOffset } from '../../src/render/final/units';
import { curveTable } from '../../src/render/final/colormanage';
import type { RenderResult } from '../../src/render/final/result';

const img = (w: number, h: number, rgba: [number, number, number, number]) => {
  const a = new Float32Array(w * h * 4);
  for (let i = 0; i < a.length; i += 4) a.set(rgba, i);
  return a;
};

describe('render views', () => {
  it('renders nothing extra unless multi-view is on, then the enabled eyes or views', () => {
    const r = defaultRender();
    expect(renderViews(r)).toEqual([]);
    r.use_multiview = true;
    expect(renderViews(r).map((v) => [v.name, v.eye, v.suffix])).toEqual([
      ['left', 'left', '_L'],
      ['right', 'right', '_R'],
    ]);
    multiview(r).views[1].use = false;
    expect(renderViews(r).map((v) => v.name)).toEqual(['left']);
    const mv = multiview(r);
    mv.views_format = 'MULTIVIEW';
    mv.views.push({ name: uniqueViewName(mv.views), camera_suffix: '_top', use: true });
    expect(renderViews(r).map((v) => [v.name, v.suffix])).toEqual([
      ['left', '_L'],
      ['RenderView', '_top'],
    ]);
    expect(uniqueViewName(mv.views)).toBe('RenderView.001');
    expect(viewFileName('render_0001.png', '_L')).toBe('render_0001_L.png');
  });

  it('places the eyes by pivot, converging off-axis or by turning inward', () => {
    const s = defaultCameraStereo();
    // left pivot: the left eye at the camera, the right one interocular distance to the right
    expect(eyeTransform(s, 'left').offset).toBe(0);
    expect(eyeTransform(s, 'right').offset).toBeCloseTo(0.065);
    const L = eyeTransform(s, 'left'),
      R = eyeTransform(s, 'right');
    // off-axis: opposite frustum shifts that meet at the convergence distance
    expect(L.shift).toBeCloseTo(0.0325 / 1.95);
    expect(R.shift).toBeCloseTo(-0.0325 / 1.95);
    expect(L.yaw).toBe(0);
    s.pivot = 'CENTER';
    expect(eyeTransform(s, 'left').offset).toBeCloseTo(-0.0325);
    s.convergence_mode = 'TOE';
    expect(eyeTransform(s, 'right').yaw).toBeCloseTo(Math.atan2(0.0325, 1.95));
    expect(eyeTransform(s, 'right').shift).toBe(0);
    s.convergence_mode = 'PARALLEL';
    expect(eyeTransform(s, 'right')).toEqual({ offset: 0.0325, shift: 0, yaw: 0 });
  });

  it('off-axis eyes see the convergence point at the image centre', () => {
    const s = defaultCameraStereo();
    for (const eye of ['left', 'right'] as const) {
      const cam = new PerspectiveCamera(40, 1.5, 0.1, 100);
      cam.updateMatrixWorld(true);
      const t = eyeTransform(s, eye);
      applyEye(cam, t.offset, t.shift, t.yaw);
      // the convergence point on the axis through the middle between the eyes
      const p = new Vector3(0.0325, 0, -1.95).project(cam);
      expect(p.x).toBeCloseTo(0, 5);
      expect(p.y).toBeCloseTo(0, 5);
    }
  });

  it('combines eyes as anaglyph, interlaced, side-by-side and top-bottom images', () => {
    const L = img(4, 2, [1, 0.5, 0.25, 1]);
    const R = img(4, 2, [0, 0.1, 0.9, 1]);
    expect(Array.from(anaglyph(L, R, 'RED_CYAN').slice(0, 4))).toEqual([1, 0.1, 0.9, 1].map((x) => Math.fround(x)));
    expect(Array.from(anaglyph(L, R, 'YELLOW_BLUE').slice(0, 3))).toEqual([1, 0.5, 0.9].map((x) => Math.fround(x)));
    const rows = interlace(L, R, 4, 2, 'ROW_INTERLEAVED', false);
    expect(rows[0]).toBe(1);
    expect(rows[4 * 4]).toBe(0);
    const f = { display_mode: 'SIDEBYSIDE', anaglyph_type: 'RED_CYAN', interlace_type: 'ROW_INTERLEAVED', use_interlace_swap: false, use_sidebyside_crosseyed: false, use_squeezed_frame: false } as const;
    const sbs = combineStereo(L, R, 4, 2, f);
    expect([sbs.width, sbs.height]).toEqual([8, 2]);
    expect(sbs.data[0]).toBe(1);
    expect(sbs.data[4 * 4]).toBe(0);
    const cross = combineStereo(L, R, 4, 2, { ...f, use_sidebyside_crosseyed: true });
    expect(cross.data[0]).toBe(0);
    const sq = combineStereo(L, R, 4, 2, { ...f, use_squeezed_frame: true });
    expect([sq.width, sq.height]).toEqual([4, 2]);
    expect(sq.data[2 * 4]).toBe(0);
    const tb = combineStereo(L, R, 4, 2, { ...f, display_mode: 'TOPBOTTOM' });
    expect([tb.width, tb.height]).toEqual([4, 4]);
    expect(tb.data[0]).toBe(1);
    expect(tb.data[2 * 4 * 4]).toBe(0);
  });

  it('builds the combined result of a stereo render', () => {
    const L = img(2, 2, [1, 0, 0, 1]);
    const R = img(2, 2, [0, 1, 1, 1]);
    const r = { width: 2, height: 2, passes: { Combined: L }, views: [{ name: 'left', suffix: '_L', passes: { Combined: L } }, { name: 'right', suffix: '_R', passes: { Combined: R } }], stereo: { display_mode: 'ANAGLYPH', anaglyph_type: 'RED_CYAN', interlace_type: 'ROW_INTERLEAVED', use_interlace_swap: false, use_sidebyside_crosseyed: false, use_squeezed_frame: false } } as unknown as RenderResult;
    const c = stereoResult(r)!;
    expect(Array.from(c.passes.Combined!.slice(0, 4))).toEqual([1, 1, 1, 1]);
    expect(c.views).toBeUndefined();
    expect(stereoResult({ ...r, views: undefined })).toBeNull();
  });
});

describe('shutter curve', () => {
  it('places samples evenly with an open shutter and densely where it is wide open', () => {
    const flat = curveTable([[0, 1], [1, 1]]);
    expect(shutterTime(0.25, flat)).toBeCloseTo(0.25, 2);
    const bump = curveTable(shutterCurvePoints('SHARP'));
    // a peaked curve pulls samples towards the middle of the interval
    expect(shutterTime(0.25, bump)).toBeGreaterThan(0.3);
    expect(shutterTime(0.5, bump)).toBeCloseTo(0.5, 2);
    expect(shutterOffset(0, 4, 1, 'CENTER', bump)).toBeGreaterThan(shutterOffset(0, 4, 1, 'CENTER'));
  });

  it('presets open over the first half and close over the second', () => {
    for (const shape of ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINE'] as const) {
      const p = shutterCurvePoints(shape);
      expect(p[0]).toEqual([0, 0]);
      expect(p[p.length - 1]).toEqual([1, 0]);
      expect(Math.max(...p.map((q) => q[1]))).toBe(1);
    }
    expect(shutterCurvePoints('MAX')).toEqual([[0, 1], [1, 1]]);
    // root opens faster than sharp
    expect(shutterCurvePoints('ROOT')[1][1]).toBeGreaterThan(shutterCurvePoints('SHARP')[1][1]);
  });
});
