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

describe('vertex color operators on a face corner color attribute', () => {
  beforeEach(() => {
    setApp(new App(startupDocument()));
    app.run('object.select_all', { action: 'SELECT' });
    app.run('object.delete');
    app.run('mesh.primitive_cube_add');
    const me = app.doc.meshes[app.activeObject!.data!];
    // every face its own grey level (corners of a vertex differ)
    const nc = me.indices.length;
    const data = new Float32Array(nc * 4);
    for (let f = 0; f + 1 < me.offsets.length; f++)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) data.set([f / 10, f / 10, f / 10, 1], c * 4);
    me.color_attributes = [{ name: 'Col', domain: 'CORNER', data }];
    me.active_color_index = 0;
    app.run('object.mode_set', { mode: 'VERTEX_PAINT' });
  });

  const faceGreys = () => {
    const me = app.doc.meshes[app.activeObject!.data!];
    const a = me.color_attributes[0];
    return Array.from({ length: me.offsets.length - 1 }, (_, f) => +a.data[me.offsets[f] * 4].toFixed(3));
  };

  it('invert and levels keep the colors of each corner apart', () => {
    expect(app.run('paint.vertex_color_invert')).toBe('FINISHED');
    expect(faceGreys()).toEqual([1, 0.9, 0.8, 0.7, 0.6, 0.5]);
    expect(app.run('paint.vertex_color_levels', { offset: 0, gain: 0.5 })).toBe('FINISHED');
    expect(faceGreys()).toEqual([0.5, 0.45, 0.4, 0.35, 0.3, 0.25]);
  });

  it('Set Color with a vertex selection mask leaves the other corners alone', () => {
    const me = app.doc.meshes[app.activeObject!.data!];
    me.use_paint_mask_vertex = true;
    me.select_vert = new Uint8Array(me.positions.length / 3);
    me.select_vert[0] = 1;
    app.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
    const before = faceGreys();
    expect(app.run('paint.vertex_color_set')).toBe('FINISHED');
    const a = me.color_attributes[0];
    for (let f = 0; f + 1 < me.offsets.length; f++)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        const v = me.indices[c];
        if (v === 0) expect(Array.from(a.data.slice(c * 4, c * 4 + 3))).toEqual([1, 0, 0]);
        else expect(+a.data[c * 4].toFixed(3)).toBe(before[f]);
      }
  });
});
