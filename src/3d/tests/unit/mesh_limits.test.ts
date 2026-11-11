// @vitest-environment happy-dom
// Operators and modifiers refuse results too large for the tab's memory instead of crashing.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { ensureMeshSize, MeshTooLargeError, MAX_MESH_ELEMENTS } from '../../src/mesh/limits';
import { catmullClark } from '../../src/eval/modifiers';
import type { EvalMesh } from '../../src/eval/types';
import '../../src/ops/data';
import '../../src/ops/object';
import '../../src/modes/index';
import '../../src/editors/properties/stack';

beforeEach(() => {
  setApp(new App(startupDocument()));
});

describe('mesh size ceiling', () => {
  it('allows up to the ceiling and refuses above it', () => {
    expect(() => ensureMeshSize('X', MAX_MESH_ELEMENTS)).not.toThrow();
    expect(() => ensureMeshSize('X', MAX_MESH_ELEMENTS + 1)).toThrow(MeshTooLargeError);
    expect(() => ensureMeshSize('X', 0, MAX_MESH_ELEMENTS + 1)).toThrow(/vertices/);
  });

  it('primitives: normal sizes build, huge ones are refused before allocating', () => {
    expect(prim.icoSphere(8).indices.length).toBe(983040);
    expect(() => prim.icoSphere(10)).toThrow(MeshTooLargeError);
    expect(() => prim.grid(10000, 10000)).toThrow(MeshTooLargeError);
    expect(() => prim.circle(10000000, 1, 'TRIFAN')).toThrow(MeshTooLargeError);
    expect(prim.uvSphere(64, 32).offsets.length - 1).toBe(64 * 32);
  });

  it('Add Ico Sphere with 10 subdivisions reports instead of crashing', () => {
    const before = Object.keys(app.doc.objects).length;
    expect(app.run('mesh.primitive_ico_sphere_add', { subdivisions: 10 })).toBe('CANCELLED');
    expect(app.reports.some((r) => r.type === 'ERROR' && /lower settings/.test(r.message))).toBe(true);
    expect(Object.keys(app.doc.objects).length).toBe(before);
    expect(app.run('mesh.primitive_ico_sphere_add', { subdivisions: 5 })).toBe('FINISHED');
  });

  it('a Subdivision modifier too deep for memory shows an error and keeps the base mesh', () => {
    const ob = app.activeObject!;
    const me = newMeshData('g', prim.grid(100, 100));
    app.doc.meshes[me.id] = me;
    ob.data = me.id;
    app.run('object.modifier_add', { type: 'SUBSURF' });
    Object.assign(ob.modifiers[0], { levels: 6 });
    app.graph.evaluate(app.doc);
    const ev = app.graph.get(ob.id)!;
    expect(ev.error).toMatch(/Subdivision would make/);
    expect(ev.mesh!.indices.length).toBe(me.indices.length);
    Object.assign(ob.modifiers[0], { levels: 2 });
    app.graph.evaluate(app.doc);
    expect(app.graph.get(ob.id)!.error).toBeUndefined();
    expect(() => catmullClark(me as unknown as EvalMesh, 6)).toThrow(MeshTooLargeError);
  });

  it('Edit Mode Screw with huge steps reports and leaves the mesh alone', () => {
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'SELECT' });
    const me = app.doc.meshes[app.activeObject!.data!];
    const n = me.indices.length;
    app.reports.length = 0;
    // a single edge as the profile
    const sel = new Uint8Array(me.positions.length / 3);
    sel[me.indices[0]] = sel[me.indices[1]] = 1;
    me.select_vert = sel;
    expect(app.run('mesh.screw', { steps: 100000, turns: 1000, center: [0, 0, 0], axis: [0, 0, 1] }, { invoke: false })).toBe('CANCELLED');
    expect(app.reports.some((r) => r.type === 'ERROR' && /Screw would make/.test(r.message))).toBe(true);
    expect(app.doc.meshes[app.activeObject!.data!].indices.length).toBe(n);
    expect(app.run('mesh.screw', { steps: 12, turns: 1, center: [0, 0, 0], axis: [0, 0, 1] }, { invoke: false })).toBe('FINISHED');
  });
});

describe('undo history memory', () => {
  it('drops the oldest steps when their arrays exceed the memory limit', async () => {
    const { UndoStack } = await import('../../src/app/undo');
    const u = new UndoStack();
    u.memoryLimit = 10 * 2 ** 20;
    const doc = startupDocument();
    const me = Object.values(doc.meshes)[0];
    u.reset(doc);
    for (let i = 0; i < 20; i++) {
      me.positions = new Float32Array(2 ** 20 / 4).fill(i); // 1 MB of new data per step
      u.push(doc, `step ${i}`);
    }
    expect(u.history.length).toBeLessThanOrEqual(11);
    expect(u.history.length).toBeGreaterThanOrEqual(9);
    expect(u.topLabel).toBe('step 19');
    // undo still works over what is kept, and the step count limit still applies without big arrays
    expect(u.undo()).not.toBeNull();
    const v = new UndoStack();
    v.reset(doc);
    for (let i = 0; i < 70; i++) v.push(doc, `s${i}`);
    expect(v.history.length).toBe(65);
  });
});
