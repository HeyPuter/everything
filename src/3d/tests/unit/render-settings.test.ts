import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { filterTable, sampleFilter, filterWeight } from '../../src/render/final/filter';
import { shutterOffset, frameFileName, tileCount, expandRegion, filmTransparent, fpsPreset, fpsFromPreset, regionFromImageRect } from '../../src/render/final/units';
import { apertureSample, apertureRadius, apertureJitter, regionRect, cropProjection } from '../../src/render/final/camera';
import { whiteBalanceGains, lookParams, displayPixel, LOOKS } from '../../src/render/final/colormanage';
import { stampFields, pngWithText, pngText, timecode, stampLines, compositeOverlay } from '../../src/render/final/stamp';
import { simplifySubdivision, simplifyChildParticles, stretchedFrame, simplifySignature } from '../../src/eval/simplify';
import { startupDocument as newDocument } from '../../src/data/defaults';
import { patchPathTracingShader } from '../../src/render/final/pathtracer';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import type { DocumentData } from '../../src/data/types';

/** Fraction of filter samples left of `x` (the brightness of a pixel next to an edge). */
function edgeCoverage(type: 'BOX' | 'GAUSSIAN' | 'BLACKMAN_HARRIS', width: number, x: number) {
  const t = filterTable(type, width);
  const n = 4000;
  let c = 0;
  for (let i = 0; i < n; i++) if (sampleFilter(t, (i + 0.5) / n) < x) c++;
  return c / n;
}

describe('pixel filter', () => {
  it('matches the expected edge profiles', () => {
    // pixel centre half a pixel from a hard edge
    expect(edgeCoverage('BOX', 1.5, 0.5)).toBeCloseTo(1, 2);
    expect(edgeCoverage('GAUSSIAN', 1.5, 0.5)).toBeCloseTo(0.909, 1);
    expect(edgeCoverage('BLACKMAN_HARRIS', 1.5, 0.5)).toBeCloseTo(0.881, 1);
    expect(edgeCoverage('BLACKMAN_HARRIS', 3, 0.5)).toBeCloseTo(0.721, 1);
    expect(edgeCoverage('BLACKMAN_HARRIS', 3, 1.5)).toBeCloseTo(0.964, 1);
    expect(edgeCoverage('GAUSSIAN', 3, 1.5)).toBeCloseTo(0.976, 1);
  });
  it('is symmetric and bounded', () => {
    const t = filterTable('BLACKMAN_HARRIS', 1.5);
    expect(sampleFilter(t, 0.5)).toBeCloseTo(0, 2);
    expect(sampleFilter(t, 0)).toBeCloseTo(-1.5, 2);
    expect(sampleFilter(t, 1)).toBeCloseTo(1.5, 2);
    expect(filterWeight('GAUSSIAN', 2, 1.5)).toBe(0);
  });
});

describe('motion blur shutter position', () => {
  it('places samples before, around or after the frame', () => {
    const s = (p: 'START' | 'CENTER' | 'END') => [0, 1, 2, 3].map((i) => shutterOffset(i, 4, 1, p));
    expect(s('CENTER')).toEqual([-0.375, -0.125, 0.125, 0.375]);
    expect(s('START')).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(s('END')).toEqual([-0.875, -0.625, -0.375, -0.125]);
  });
});

describe('depth of field jitter', () => {
  it('samples stay inside the aperture', () => {
    for (const blades of [0, 5, 6]) {
      for (let i = 0; i < 200; i++) {
        const [x, y] = apertureSample((i * 0.618) % 1, (i * 0.414) % 1, blades, 0.3, 1);
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    expect(apertureRadius(50, 2.8)).toBeCloseTo(0.05 / 5.6, 6);
  });
  it('keeps the focus plane fixed', () => {
    const cam = new PerspectiveCamera(40, 1.5, 0.1, 100);
    cam.position.set(0, 0, 5);
    cam.updateMatrixWorld(true);
    const base = cam.projectionMatrix.clone();
    const focus = 3;
    const p = new Vector3(0.4, -0.2, 5 - focus); // on the focus plane
    const before = p.clone().project(cam);
    apertureJitter(cam, new Vector3(0, 0, 5), base, 0.05, -0.03, focus);
    const after = p.clone().project(cam);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const far = new Vector3(0.4, -0.2, -10);
    cam.position.set(0, 0, 5);
    cam.projectionMatrix.copy(base);
    cam.updateMatrixWorld(true);
    const f0 = far.clone().project(cam);
    apertureJitter(cam, new Vector3(0, 0, 5), base, 0.05, -0.03, focus);
    expect(Math.abs(far.clone().project(cam).x - f0.x)).toBeGreaterThan(1e-3);
  });
});

describe('render region', () => {
  it('converts the normalised region to pixels', () => {
    expect(regionRect({ use_border: false }, 100, 50)).toBeNull();
    expect(regionRect({ use_border: true, border_min_x: 0, border_max_x: 1, border_min_y: 0, border_max_y: 1 }, 100, 50)).toBeNull();
    expect(regionRect({ use_border: true, border_min_x: 0.25, border_max_x: 0.5, border_min_y: 0.2, border_max_y: 0.6 }, 100, 50)).toEqual({ x: 25, y: 20, w: 25, h: 20 });
  });
  it('crops the projection to the region', () => {
    const cam = new PerspectiveCamera(50, 2, 0.1, 100);
    cam.updateMatrixWorld(true);
    const full = new PerspectiveCamera().copy(cam);
    const rect = { x: 50, y: 10, w: 30, h: 20 };
    cropProjection(cam, rect, 200, 100);
    // a point projecting to the region's top-left pixel corner maps to NDC (-1, 1) in the crop
    const ndc = new Vector3(2 * (50 / 200) - 1, 1 - 2 * (10 / 100), 0.5);
    const world = ndc.clone().unproject(full);
    const c = world.clone().project(cam);
    expect(c.x).toBeCloseTo(-1, 5);
    expect(c.y).toBeCloseTo(1, 5);
  });
  it('places a region buffer into the frame', () => {
    const buf = new Float32Array([1, 2, 3, 4]);
    const out = expandRegion(buf, 1, { x: 1, y: 1, w: 2, h: 2 }, 4, 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4, 0]);
  });
  it('maps an image rectangle to a region (also inside a cropped result)', () => {
    const r = { use_border: false };
    expect(regionFromImageRect(10, 5, 30, 15, 40, 20, r, [40, 20])).toEqual({ min_x: 0.25, max_x: 0.75, min_y: 0.25, max_y: 0.75 });
    const crop = { use_border: true, use_crop_to_border: true, border_min_x: 0.5, border_max_x: 1, border_min_y: 0, border_max_y: 0.5 };
    const g = regionFromImageRect(0, 0, 20, 10, 20, 10, crop, [40, 20]);
    expect(g).toEqual({ min_x: 0.5, max_x: 1, min_y: 0, max_y: 0.5 });
  });
});

describe('colour management', () => {
  it('white balance is neutral at the reference white and matches expected gains', () => {
    const id = whiteBalanceGains(6500, 10);
    for (const v of id) expect(v).toBeCloseTo(1, 4);
    // expected gains (linear, relative) for a few settings
    const cases: [number, number, [number, number, number]][] = [
      [4000, 10, [0.45, 1.101, 3.703]],
      [10000, 10, [1.375, 0.972, 0.54]],
      [6500, -50, [0.568, 1.216, 0.684]],
      [6500, 60, [1.45, 0.86, 1.438]],
    ];
    for (const [t, tint, want] of cases) {
      const g = whiteBalanceGains(t, tint);
      for (let i = 0; i < 3; i++) expect(Math.abs(Math.log(g[i] / want[i]))).toBeLessThan(0.15);
    }
  });
  it('looks grade the display values', () => {
    expect(lookParams('AGX', 'None')).toBeNull();
    expect(lookParams('AGX', 'AgX - Base Contrast')).toBeNull();
    expect(lookParams('STANDARD', 'AgX - Punchy')).toBeNull();
    const none = [0, 0, 0, 0],
      grey = [0, 0, 0, 0],
      high = [0, 0, 0, 0];
    displayPixel(0.6, 0.2, 0.05, 1, { view_transform: 'AGX', exposure: 0, gamma: 1 }, none);
    displayPixel(0.6, 0.2, 0.05, 1, { view_transform: 'AGX', exposure: 0, gamma: 1, look: 'AgX - Greyscale' }, grey);
    displayPixel(0.18, 0.18, 0.18, 1, { view_transform: 'AGX', exposure: 0, gamma: 1, look: 'AgX - Very High Contrast' }, high);
    const base = [0, 0, 0, 0];
    displayPixel(0.18, 0.18, 0.18, 1, { view_transform: 'AGX', exposure: 0, gamma: 1 }, base);
    expect(grey[0]).toBeCloseTo(grey[1], 5);
    expect(grey[1]).toBeCloseTo(grey[2], 5);
    // the very high contrast look brightens mid tones: (1.4·x + 0.02)^1.4
    expect(high[0]).toBeCloseTo(Math.pow(1.4 * base[0] + 0.02, 1.4), 4);
    expect(high[0]).toBeGreaterThan(base[0]);
    expect(Object.keys(LOOKS.FILMIC)).toContain('High Contrast');
  });
});

describe('metadata', () => {
  const doc = newDocument() as DocumentData;
  it('collects the enabled fields', () => {
    const r = { ...doc.scene.render, use_stamp_lens: true, use_stamp_note: true, stamp_note_text: 'Hello' };
    const f = stampFields(r, { doc, frame: 12, renderTime: 3.5, filename: 'scene.p3d', now: new Date(2026, 0, 2, 3, 4, 5) });
    const map = Object.fromEntries(f.map((x) => [x.key, x.value]));
    expect(map.File).toBe('scene.p3d');
    expect(map.Date).toBe('2026/01/02 03:04:05');
    expect(map.Frame).toBe('012');
    expect(map.Note).toBe('Hello');
    expect(map.Scene).toBe(doc.scene.name);
    expect(map.Lens).toMatch(/mm|ortho/);
    expect(timecode(30, 24)).toBe('00:00:01+06');
  });
  it('wraps burn-in lines and composites the overlay', () => {
    const lines = stampLines(
      [
        { key: 'A', label: 'A', value: 'xxxx' },
        { key: 'B', label: 'B', value: 'yyyy' },
        { key: 'Note', label: 'Note', value: 'n' },
      ],
      false,
      (s) => s.length,
      6,
    );
    expect(lines).toEqual({ top: ['n'], bottom: ['xxxx', 'yyyy'] });
    const px = new Uint8ClampedArray([0, 0, 0, 255]);
    compositeOverlay(px, new Uint8ClampedArray([255, 255, 255, 128]));
    expect(px[0]).toBeGreaterThan(120);
  });
  it('writes and reads PNG text chunks', () => {
    // minimal PNG: signature + IHDR + IEND
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0];
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82];
    const png = new Uint8Array([...sig, ...ihdr, ...iend]);
    const out = pngWithText(png, [
      ['Frame', '12'],
      ['Camera', 'Camera'],
    ]);
    expect(pngText(out)).toEqual([
      ['Frame', '12'],
      ['Camera', 'Camera'],
    ]);
  });
});

describe('simplify and time stretching', () => {
  it('limits subdivision and child particles only when enabled', () => {
    const doc = newDocument() as DocumentData;
    const r = doc.scene.render;
    expect(simplifySubdivision(doc, false)).toBe(Infinity);
    expect(simplifyChildParticles(doc, true)).toBe(1);
    r.use_simplify = true;
    r.simplify_subdivision = 1;
    r.simplify_subdivision_render = 3;
    r.simplify_child_particles = 0.25;
    expect(simplifySubdivision(doc, false)).toBe(1);
    expect(simplifySubdivision(doc, true)).toBe(3);
    expect(simplifyChildParticles(doc, false)).toBe(0.25);
    expect(simplifySignature(doc, false)).not.toBe(simplifySignature(doc, true));
  });
  it('stretches animation time', () => {
    const doc = newDocument() as DocumentData;
    expect(stretchedFrame(doc, 50)).toBe(50);
    doc.scene.render.frame_map_old = 100;
    doc.scene.render.frame_map_new = 200;
    expect(stretchedFrame(doc, 200)).toBe(100);
  });
});

describe('output helpers', () => {
  it('frame rate presets', () => {
    expect(fpsPreset({ fps: 24, fps_base: 1 })).toBe('24');
    expect(fpsPreset({ fps: 30, fps_base: 1.001 })).toBe('29.97');
    expect(fpsPreset({ fps: 17, fps_base: 1 })).toBe('custom');
    expect(fpsFromPreset(29.97)).toEqual({ fps: 30, fps_base: 1.001 });
    expect(fpsFromPreset(25)).toEqual({ fps: 25, fps_base: 1 });
  });
  it('file names honour File Extensions', () => {
    expect(frameFileName('//render/shot_###', 7, 'png')).toBe('shot_007.png');
    expect(frameFileName('//render/shot_###', 7, 'png', false)).toBe('shot_007');
  });
  it('tiling and transparency', () => {
    expect(tileCount({ use_auto_tile: true, tile_size: 640 }, 1920, 1080)).toEqual([3, 2]);
    expect(tileCount({ use_auto_tile: false }, 1920, 1080)).toEqual([1, 1]);
    expect(filmTransparent({ film_transparent: false, use_sky: false })).toBe(true);
    expect(filmTransparent({ film_transparent: false, use_sky: true })).toBe(false);
  });
});

describe('path tracer shader', () => {
  it('gains the pixel filter and clamping', () => {
    const m = new PhysicalPathTracingMaterial();
    const src = patchPathTracingShader(m.fragmentShader);
    expect(src).toBeTruthy();
    expect(src).toContain('ptFilterSample( ruv.x )');
    expect((src!.match(/ptClamp\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(src).not.toContain('tentFilter( ruv.x )');
  });
});

describe('camera guides and mist falloff', async () => {
  const { insetRect, centerCut, compositionGuides } = await import('../../src/render/final/cameraoverlay');
  const { mistFactor } = await import('../../src/render/final/units');
  it('safe areas and the 4:3 center cut', () => {
    expect(insetRect({ x: 0, y: 0, w: 200, h: 100 }, 0.1, 0.05)).toEqual({ x: 10, y: 2.5, w: 180, h: 95 });
    expect(centerCut({ x: 0, y: 0, w: 160, h: 90 })).toEqual({ x: 20, y: 0, w: 120, h: 90 });
  });
  it('composition guides', () => {
    const r = { x: 0, y: 0, w: 90, h: 30 };
    expect(compositionGuides({ show_composition_thirds: true }, r)).toEqual([
      [30, 0, 30, 30],
      [0, 10, 90, 10],
      [60, 0, 60, 30],
      [0, 20, 90, 20],
    ]);
    // triangles: the lines from the corners meet the diagonal at right angles
    const [diag, a] = compositionGuides({ show_composition_golden_tria_a: true }, r);
    const d = [diag[2] - diag[0], diag[3] - diag[1]],
      l = [a[2] - a[0], a[3] - a[1]];
    expect(d[0] * l[0] + d[1] * l[1]).toBeCloseTo(0, 6);
    const harmony = compositionGuides({ show_composition_harmony_tri_a: true }, r);
    // harmonious lines run on to the frame edge
    expect(harmony[1][3] === 30 || harmony[1][2] === 90).toBe(true);
  });
  it('mist falloff', () => {
    expect(mistFactor(15, 5, 20)).toBeCloseTo(0.25, 6);
    expect(mistFactor(15, 5, 20, 'LINEAR')).toBeCloseTo(0.5, 6);
    expect(mistFactor(15, 5, 20, 'INVERSE_QUADRATIC')).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('display curve', async () => {
  const { curveTable, lookupCurve, viewCurve } = await import('../../src/render/final/colormanage');
  it('identity curve is skipped and custom curves pass through their points', () => {
    expect(viewCurve({ view_transform: 'STANDARD', exposure: 0, gamma: 1, use_curve_mapping: true, curve_mapping: [[0, 0], [1, 1]] })).toBeNull();
    const t = curveTable([
      [0, 0],
      [0.5, 0.8],
      [1, 1],
    ]);
    expect(lookupCurve(t, 0.5)).toBeCloseTo(0.8, 2);
    expect(lookupCurve(t, 0)).toBeCloseTo(0, 5);
    expect(lookupCurve(t, 1)).toBeCloseTo(1, 5);
  });
});

describe('video quality', async () => {
  const { videoBitrate } = await import('../../src/render/final/webm');
  it('scales the bitrate with quality', () => {
    expect(videoBitrate(1920, 1080, 24, 90)).toBeCloseTo(1920 * 1080 * 24 * 0.12, -3);
    expect(videoBitrate(1920, 1080, 24, 60)).toBeLessThan(videoBitrate(1920, 1080, 24, 90) / 3);
  });
});
