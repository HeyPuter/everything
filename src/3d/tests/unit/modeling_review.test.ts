// @vitest-environment happy-dom
// Edit Mode and modelling regressions found by review, run through the app's operators.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { MeshData } from '../../src/data/types';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/editors/uv/uveditor';
import '../../src/modeling/index';

beforeEach(() => {
  setApp(new App(startupDocument()));
});

const mesh = () => app.doc.meshes[app.activeObject!.data!] as MeshData;

describe('UV operators', () => {
  it('cancel on a mesh whose UV maps were all removed', () => {
    expect(app.run('mesh.uv_texture_remove')).toBe('FINISHED');
    expect(mesh().uvs.length).toBe(0);
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'SELECT' });
    app.reports.length = 0;
    expect(app.run('uv.align', {}, { invoke: false })).toBe('CANCELLED');
    expect(app.reports.filter((r) => r.type === 'ERROR')).toEqual([]);
    expect(mesh().uvs.length).toBe(0);
  });
});
