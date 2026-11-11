// @vitest-environment happy-dom
// Grease Pencil and paint / sculpt modes: regressions found in review.
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/paint/index';

describe('vertex paint on a mesh without faces', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    app.run('object.select_all', { action: 'SELECT' });
    app.run('object.delete');
    app.run('mesh.primitive_cube_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'SELECT' });
    app.run('mesh.delete', { type: 'ONLY_FACE' });
    app.run('object.mode_set', { mode: 'OBJECT' });
    app.run('object.mode_set', { mode: 'VERTEX_PAINT' });
  });

  it('smooth and dirt report the missing faces instead of failing', () => {
    expect(app.doc.mode).toBe('VERTEX_PAINT');
    for (const op of ['paint.vertex_color_smooth', 'paint.vertex_color_dirt']) {
      const n = app.reports.length;
      expect(app.run(op)).toBe('CANCELLED');
      expect(app.reports.slice(n).map((r) => r.message)).toEqual(['The mesh has no faces']);
    }
  });
});

describe('very fast strokes', () => {
  it('spread their dabs over the whole move instead of stopping short', async () => {
    const { playStroke, runStroke } = await import('../../src/paint/stroke');
    const { replayDabs } = await import('../../src/greasepencil/strokereplay');
    const el = document.createElement('div');
    const view = { el, local: (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY }), drawSvg() {} };
    const xs: number[] = [];
    // radius 5 px at 10 % spacing: a dab per pixel, 1000 px in one move
    const ok = playStroke(view, [{ x: 0, y: 0 }, { x: 1000, y: 0 }], (e) => {
      runStroke(view, e, { spacing: () => 10, radiusPx: () => 5, dab: (d) => xs.push(d.x), end: () => {} });
      return true;
    });
    expect(ok).toBe(true);
    expect(xs.length).toBeGreaterThan(100);
    expect(xs.length).toBeLessThanOrEqual(201);
    expect(xs[xs.length - 1]).toBeGreaterThan(995);
    // the scripted Grease Pencil replay too
    const dabs = replayDabs([{ x: 0, y: 0, pressure: 1 }, { x: 5000, y: 0, pressure: 1 }], 10, 5);
    expect(dabs.length).toBeLessThanOrEqual(501);
    expect(dabs[dabs.length - 1].x).toBeGreaterThan(4990);
  });
});

describe('voxel remesh size', () => {
  it('rejects zero, negative and non-finite voxel sizes with a clear message', async () => {
    const { voxelRemesh } = await import('../../src/paint/remesh');
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const tris = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    for (const v of [0, -1, NaN, Infinity]) expect(() => voxelRemesh(pos, tris, v)).toThrow('Voxel size must be greater than zero');
    expect(() => voxelRemesh(pos, tris, 0.0001)).toThrow(/too small/);
  });
});
