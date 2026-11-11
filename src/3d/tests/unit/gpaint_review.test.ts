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
