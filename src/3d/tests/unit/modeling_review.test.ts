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

describe('dissolve', () => {
  function gridInEdit(n: number) {
    app.run('mesh.primitive_grid_add', { x_subdivisions: n, y_subdivisions: n, size: 2 });
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'SELECT' });
  }
  it('dissolves every selected face of a large grid into one', () => {
    gridInEdit(40);
    app.doc.scene.tool_settings.mesh_select_mode = [false, false, true];
    expect(app.run('mesh.dissolve_faces')).toBe('FINISHED');
    const me = mesh();
    expect(me.offsets.length - 1).toBe(1);
    // straight boundary runs lose their middle vertices
    expect(me.positions.length / 3).toBe(4);
  });

  it('dissolves every edge of a grid into one quad, keeping the corners', () => {
    gridInEdit(5);
    expect(app.run('mesh.dissolve_edges', { use_verts: true })).toBe('FINISHED');
    const me = mesh();
    expect(me.offsets.length - 1).toBe(1);
    expect(me.positions.length / 3).toBe(4);
  });

  it('dissolves selected edges without the dissolve vertices option', () => {
    gridInEdit(3);
    app.run('mesh.dissolve_edges', { use_verts: false });
    const me = mesh();
    expect(me.offsets.length - 1).toBe(1);
    expect(me.positions.length / 3).toBe(12);
  });

  it('dissolves the inner vertices of a grid into one face', () => {
    gridInEdit(6);
    const me0 = mesh();
    const sel = new Uint8Array(me0.positions.length / 3);
    for (let i = 0; i < sel.length; i++) sel[i] = Math.abs(me0.positions[i * 3]) < 0.99 && Math.abs(me0.positions[i * 3 + 1]) < 0.99 ? 1 : 0;
    me0.select_vert = sel;
    expect(app.run('mesh.dissolve_verts')).toBe('FINISHED');
    const me = mesh();
    expect(me.offsets.length - 1).toBe(1);
    expect(me.positions.length / 3).toBe(24);
  });
});

describe('applying modifiers', () => {
  it('applies a geometry nodes modifier’s output, not the geometry its viewer shows', async () => {
    await import('../../src/editors/properties/stack');
    const { setup, node, link } = await import('./gnmesh-harness');
    await import('../../src/geonodes/index');
    const { viewerState } = await import('../../src/geonodes/results');
    const t = setup();
    link(t, t.gin, 'Geometry', t.out, 'Geometry');
    const grid = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 5, 'Vertices Y': 5 });
    const viewer = node(t, 'GeometryNodeViewer', {}, { viewer_active: true });
    link(t, grid, 'Mesh', viewer, 'Geometry');
    app.doc.node_groups[t.group.id] = t.group;
    const ob = app.activeObject!;
    app.run('object.modifier_add', { type: 'NODES' });
    const md = ob.modifiers[0];
    (md as unknown as { node_group: string }).node_group = t.group.id;
    viewerState.objectId = ob.id;
    viewerState.modifierId = md.id;
    app.graph.evaluate(app.doc);
    expect(app.graph.get(ob.id)!.mesh!.positions.length / 3).toBe(25);
    const before = mesh().positions.length / 3;
    expect(app.run('object.modifier_apply', { modifier: md.id })).toBe('FINISHED');
    expect(mesh().positions.length / 3).toBe(before);
    expect(viewerState.objectId).toBe(ob.id);
  });
});
