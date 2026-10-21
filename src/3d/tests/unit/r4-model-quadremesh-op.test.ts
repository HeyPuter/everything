// @vitest-environment happy-dom
// object.quadriflow_remesh: target modes, symmetry over the mesh's mirror axes, smooth shading and
// vertex group transfer.
import { describe, it, expect } from 'vitest';
(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/data';
import '../../src/modes/index';
import '../../src/modeling/index';
import type { MeshData } from '../../src/data/types';

function setup() {
  setApp(new App(startupDocument()));
  const ob = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  app.doc.scene.active_object = ob.id;
  return app.doc.meshes[ob.data!] as MeshData;
}

describe('object.quadriflow_remesh', () => {
  it('reaches about the wanted face count with quads only, smooth when asked', () => {
    const me = setup();
    me.vertex_groups = [{ name: 'G' }];
    me.weights = [Float32Array.from([1, 1, 1, 1, 0, 0, 0, 0])];
    expect(app.run('object.quadriflow_remesh', { target_faces: 300, smooth_normals: true, preserve_attributes: true, use_mesh_symmetry: false }, { invoke: false })).toBe('FINISHED');
    const n = me.offsets.length - 1;
    expect(n).toBeGreaterThan(150);
    expect(n).toBeLessThan(600);
    for (let f = 0; f < n; f++) expect(me.offsets[f + 1] - me.offsets[f]).toBe(4);
    expect(Array.from(me.smooth!).every(Boolean)).toBe(true);
    expect(me.weights[0].length).toBe(me.positions.length / 3);
    expect(Array.from(me.weights[0]).some((w) => w === 1) && Array.from(me.weights[0]).some((w) => w === 0)).toBe(true);
  });
  it('mirror X symmetry gives a mirrored result', () => {
    const me = setup();
    app.doc.scene.tool_settings.use_mesh_mirror_x = true;
    expect(app.run('object.quadriflow_remesh', { mode: 'EDGE', target_edge_length: 0.25 }, { invoke: false })).toBe('FINISHED');
    const P = me.positions;
    const key = (x: number, y: number, z: number) => [x, y, z].map((v) => Math.round(v * 1000)).join(',');
    const set = new Set<string>();
    for (let i = 0; i < P.length; i += 3) set.add(key(P[i], P[i + 1], P[i + 2]));
    for (let i = 0; i < P.length; i += 3) expect(set.has(key(-P[i], P[i + 1], P[i + 2]))).toBe(true);
    // every edge used by two quads: the halves are welded
    const use = new Map<string, number>();
    for (let f = 0; f < me.offsets.length - 1; f++)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        const a = me.indices[c],
          b = me.indices[c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f]];
        const k = a < b ? `${a}:${b}` : `${b}:${a}`;
        use.set(k, (use.get(k) ?? 0) + 1);
      }
    for (const u of use.values()) expect(u).toBe(2);
  });
});
