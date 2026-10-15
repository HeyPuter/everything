import { describe, it, expect, beforeAll } from 'vitest';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube, grid } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { caches, startBudget } from '../../src/physics/common';
import { buildTopology, meshVolume, KIND_INTERNAL, KIND_SEW } from '../../src/physics/pbd';
import type { ClothModifier } from '../../src/physics/types';
import { triangulate } from '../../src/physics/colliders';
import '../../src/physics/cloth';

function addMesh(doc: DocumentData, name: string, arrays: ReturnType<typeof cube>, loc: [number, number, number] = [0, 0, 0]): ObjectData {
  const me = newMeshData(name, arrays);
  doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  ob.location = loc;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function cloth(ob: ObjectData, settings: Partial<ClothModifier['settings']>) {
  const m = newModifier('CLOTH', uid('md'), []) as ClothModifier;
  Object.assign(m.settings, settings);
  m.point_cache.frame_end = 200;
  ob.modifiers.push(m);
  return m;
}
const at = (g: Depsgraph, doc: DocumentData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
  return g;
};

beforeAll(() => startBudget(Infinity));

describe('cloth extras', () => {
  it('internal springs connect opposite sides of a closed mesh, sewing springs follow loose edges', () => {
    const c = cube(2);
    const t = buildTopology(c.positions, c.offsets, c.indices, { shear: true, bend: true, internal: { maxLength: 0, maxDiversion: Math.PI / 4, normalCheck: true } });
    const internal = Array.from(t.kind).filter((k) => k === KIND_INTERNAL).length;
    expect(internal).toBeGreaterThan(0);
    // every internal spring crosses the cube (length ~ the diagonal of the cube, never along a face)
    for (let i = 0; i < t.kind.length; i++) if (t.kind[i] === KIND_INTERNAL) expect(t.rest[i]).toBeGreaterThan(2.5);
    const g = grid(2, 2, 2);
    const s = buildTopology(g.positions, g.offsets, g.indices, { shear: true, bend: false, sewing: [0, 8] });
    const sew = Array.from(s.kind).map((k, i) => [k, i]).filter(([k]) => k === KIND_SEW);
    expect(sew.length).toBe(1);
    expect(s.rest[sew[0][1]]).toBe(0);
  });

  it('pressure inflates a closed cloth mesh', () => {
    const volumeAt = (pressure: boolean) => {
      caches.clear();
      const doc = emptyDocument();
      doc.scene.use_gravity = false;
      const ob = addMesh(doc, 'Ball', cube(1));
      cloth(ob, { use_pressure: pressure, uniform_pressure_force: 20, pressure_factor: 0, tension_stiffness: 2, compression_stiffness: 2, shear_stiffness: 1 });
      const g = new Depsgraph(doc);
      at(g, doc, 40);
      const m = g.get(ob.id)!.mesh!;
      return Math.abs(meshVolume(m.positions, Uint32Array.from(triangulate(m.positions, m.offsets, m.indices))));
    };
    const plain = volumeAt(false),
      inflated = volumeAt(true);
    expect(plain).toBeCloseTo(1, 1);
    expect(inflated).toBeGreaterThan(plain * 1.1);
  });

  it('sewing springs pull loose-edge ends together', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.use_gravity = false;
    const g0 = grid(1, 1, 1);
    // two separate quads one metre apart, sewn by a loose edge between near corners
    const P = new Float32Array([...g0.positions, ...Array.from(g0.positions).map((v, i) => (i % 3 === 0 ? v + 2 : v))]);
    const n0 = g0.positions.length / 3;
    const offsets = new Uint32Array([0, 4, 8]);
    const indices = new Uint32Array([...g0.indices, ...Array.from(g0.indices).map((v) => v + n0)]);
    const ob = addMesh(doc, 'Panels', { positions: P, offsets, indices, uvs: new Float32Array(16), normals: new Float32Array(24) } as never);
    // right edge of the first quad (x = 0.5) to the left edge of the second (x = 1.5)
    const right = [0, 1, 2, 3].filter((i) => P[i * 3] > 0);
    const left = [4, 5, 6, 7].filter((i) => P[i * 3] < 2);
    const me = doc.meshes[ob.data!];
    me.loose_edges = new Uint32Array([right[0], left.find((j) => Math.abs(P[j * 3 + 1] - P[right[0] * 3 + 1]) < 1e-6)!, right[1], left.find((j) => Math.abs(P[j * 3 + 1] - P[right[1] * 3 + 1]) < 1e-6)!]);
    cloth(ob, { use_sewing_springs: true });
    const g = new Depsgraph(doc);
    at(g, doc, 30);
    const m = g.get(ob.id)!.mesh!;
    const gap = Math.hypot(m.positions[me.loose_edges[0] * 3] - m.positions[me.loose_edges[1] * 3], m.positions[me.loose_edges[0] * 3 + 1] - m.positions[me.loose_edges[1] * 3 + 1]);
    expect(gap).toBeLessThan(0.3);
  });

  it('a structural stiffness group makes the weighted part stretch more', () => {
    const sagAt = (useGroup: boolean) => {
      caches.clear();
      const doc = emptyDocument();
      const ob = addMesh(doc, 'Curtain', grid(8, 8, 2), [0, 0, 3]);
      ob.rotation_euler = [Math.PI / 2, 0, 0];
      const me = doc.meshes[ob.data!];
      const nv = me.positions.length / 3;
      // pin the top row (local y = 1), stiffness group everywhere
      const pin = new Float32Array(nv),
        all = new Float32Array(nv).fill(1);
      for (let i = 0; i < nv; i++) if (me.positions[i * 3 + 1] > 0.99) pin[i] = 1;
      me.vertex_groups.push({ name: 'Pin' }, { name: 'Soft' });
      me.weights.push(pin, all);
      cloth(ob, { vertex_group_mass: 'Pin', vertex_group_structural_stiffness: useGroup ? 'Soft' : '', tension_stiffness: 15, tension_stiffness_max: 0.2, compression_stiffness_max: 0.2 });
      const g = new Depsgraph(doc);
      const ys: number[] = [];
      for (const f of [20, 40, 60, 80]) {
        at(g, doc, f);
        const P = g.get(ob.id)!.mesh!.positions;
        let minY = Infinity;
        for (let i = 1; i < P.length; i += 3) minY = Math.min(minY, P[i]);
        ys.push(minY);
      }
      return ys[3];
    };
    // the curtain hangs along local -Y: more stretch reaches further
    expect(sagAt(true)).toBeLessThan(sagAt(false) - 0.01);
  });
});
