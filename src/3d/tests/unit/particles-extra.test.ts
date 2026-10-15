import { describe, it, expect, beforeAll } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { emptyDocument, newObject, newMeshData, uid, newCollection } from '../../src/data/defaults';
import { cube, plane, grid } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { caches, startBudget, getCache } from '../../src/physics/common';
import { defaultParticleSettings, defaultPointCache, type ParticleSettingsX } from '../../src/physics/types';
import { particleCacheKey, particleDraw } from '../../src/physics/particles';
const particleDrawValues = () => particleDraw.values();
import { defaultBoidSettings, newBoidRule } from '../../src/physics/boids';

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
function emitter(doc: DocumentData, ob: ObjectData, settings: Partial<ParticleSettingsX>) {
  const ps = defaultParticleSettings(uid('pa'), 'P');
  Object.assign(ps, { count: 60, frame_start: 1, frame_end: 3, lifetime: 100, normal_factor: 0 }, settings);
  doc.particles[ps.id] = ps;
  const sys = { id: uid('psys'), name: 'P', settings: ps.id, seed: 1, point_cache: defaultPointCache(1, 120) };
  ob.particle_systems.push(sys as never);
  const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
  m.particle_system = sys.id;
  ob.modifiers.push(m);
  return { ps, m };
}
function framePos(ob: ObjectData, m: { id: string }, f: number) {
  const fr = getCache<{ pos: Float32Array; state: Uint8Array }, unknown>(particleCacheKey(ob, m as never)).frames.get(f)!;
  const pts: Vector3[] = [];
  for (let i = 0; i < fr.state.length; i++) if (fr.state[i] === 1) pts.push(new Vector3(fr.pos[i * 3], fr.pos[i * 3 + 1], fr.pos[i * 3 + 2]));
  return pts;
}
const at = (g: Depsgraph, doc: DocumentData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
};

beforeAll(() => startBudget(Infinity));

describe('particle physics types and rendering', () => {
  it('boids fly towards a goal without gravity, keeping their personal space', () => {
    caches.clear();
    const doc = emptyDocument();
    const goal = addMesh(doc, 'Goal', cube(0.2), [20, 0, 5]);
    const ob = addMesh(doc, 'Flock', plane(2));
    const b = defaultBoidSettings();
    b.rules = [newBoidRule('SEPARATE'), { ...newBoidRule('GOAL'), object: goal.id }, newBoidRule('FLOCK')];
    Object.assign(b, { air_speed_max: 8, air_personal_space: 0.4 });
    const { m } = emitter(doc, ob, { physics_type: 'BOIDS', boids: b, normal_factor: 1 });
    const g = new Depsgraph(doc);
    at(g, doc, 48);
    const pts = framePos(ob, m, 48);
    const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
    // the flock moved towards the goal and did not fall
    expect(c.x).toBeGreaterThan(4);
    expect(c.z).toBeGreaterThan(0);
    // speed limit: 2 seconds at 8 m/s at most
    expect(c.length()).toBeLessThan(17);
    let close = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (pts[i].distanceTo(pts[j]) < 0.05) close++;
    expect(close).toBeLessThan(pts.length / 4);
  });

  it('fluid particles push each other apart instead of piling into one point', () => {
    const spread = (physics: 'NEWTON' | 'FLUID') => {
      caches.clear();
      const doc = emptyDocument();
      addMesh(doc, 'Floor', plane(10), [0, 0, 0]).collision = { use: true, thickness_outer: 0.02, cloth_friction: 5, damping: 0.1, use_culling: false } as never;
      const ob = addMesh(doc, 'Source', plane(0.2), [0, 0, 1]);
      const { m } = emitter(doc, ob, { physics_type: physics, count: 80, fluid: { fluid_radius: 0.3, stiffness: 2, stiffness_near: 2, rest_density: 1, linear_viscosity: 0.2, square_viscosity: 0 } });
      const g = new Depsgraph(doc);
      at(g, doc, 60);
      const pts = framePos(ob, m, 60);
      const c = pts.reduce((a, p) => a.add(p), new Vector3()).divideScalar(pts.length);
      return pts.reduce((a, p) => a + Math.hypot(p.x - c.x, p.y - c.y), 0) / pts.length;
    };
    expect(spread('FLUID')).toBeGreaterThan(spread('NEWTON') + 0.1);
  });

  it('keyed particles travel to the matching particles of their target system', () => {
    caches.clear();
    const doc = emptyDocument();
    const target = addMesh(doc, 'Target', plane(0.1), [5, 0, 0]);
    emitter(doc, target, { physics_type: 'NO', count: 10 });
    const ob = addMesh(doc, 'Source', plane(0.1), [0, 0, 0]);
    const { m } = emitter(doc, ob, { physics_type: 'KEYED', count: 10, lifetime: 40, keyed_targets: [{ object: target.id, system: 1 }], keyed_loops: 1 });
    const g = new Depsgraph(doc);
    at(g, doc, 21);
    const half = framePos(ob, m, 21);
    // half way through their life they are half way there
    for (const p of half) expect(p.x).toBeGreaterThan(1.5);
    for (const p of half) expect(p.x).toBeLessThan(3.5);
  });

  it('collection rendering instances the collection objects, rotation follows the chosen axis', () => {
    caches.clear();
    const doc = emptyDocument();
    const a = addMesh(doc, 'A', cube(0.1), [10, 0, 0]);
    const b = addMesh(doc, 'B', cube(0.1), [10, 1, 0]);
    const coll = newCollection('Bits');
    doc.collections[coll.id] = coll;
    coll.objects.push(a.id, b.id);
    const ob = addMesh(doc, 'Emitter', plane(1));
    const { m } = emitter(doc, ob, { physics_type: 'NO', count: 6, render_type: 'COLLECTION', instance_collection: coll.id, use_rotations: true, rotation_mode: 'GLOB_Z' });
    const g = new Depsgraph(doc);
    at(g, doc, 5);
    const inst = g.get(ob.id)!.mesh!.instances!;
    expect(inst.length).toBe(6);
    expect(new Set(inst.map((i) => i.objectId))).toEqual(new Set([a.id, b.id]));
    const x = new Vector3(1, 0, 0).transformDirection(new Matrix4().fromArray(inst[0].matrix));
    expect(x.z).toBeCloseTo(1, 3);
    void m;
  });
});

describe('particle vertex groups', () => {
  it('a density group limits where particles and hair come from; length and size groups scale them', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Emitter', grid(10, 10, 2) as never);
    const me = doc.meshes[ob.data!];
    const nv = me.positions.length / 3;
    const right = new Float32Array(nv);
    for (let i = 0; i < nv; i++) right[i] = me.positions[i * 3] > 0.2 ? 1 : 0;
    me.vertex_groups.push({ name: 'Right' });
    me.weights.push(right);
    const { m } = emitter(doc, ob, { physics_type: 'NO', count: 50 });
    Object.assign(ob.particle_systems[0], { vertex_group_density: 'Right' });
    const g = new Depsgraph(doc);
    at(g, doc, 5);
    const pts = framePos(ob, m, 5);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(p.x).toBeGreaterThan(-0.05);
    // inverted: the other side
    caches.clear();
    Object.assign(ob.particle_systems[0], { invert_vertex_group_density: true });
    at(g, doc, 6);
    for (const p of framePos(ob, m, 6)) expect(p.x).toBeLessThan(0.45);
  });
});

describe('hair dynamics', () => {
  it('simulated hair droops under gravity and keeps its roots on the emitter', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Head', plane(1), [0, 0, 1]);
    // slightly tilted strands (perfectly upright ones would balance)
    const { m } = emitter(doc, ob, { type: 'HAIR', count: 20, hair_length: 0.5, hair_step: 5, render_type: 'PATH', normal_factor: 1, object_align_factor: [0.3, 0, 0] });
    const g = new Depsgraph(doc);
    const tips = () => {
      const d = [...particleDrawValues()].find((x) => x.objectId === ob.id)!;
      const L = d.lines!;
      // last segment of every strand: z of its end point (object space)
      let z = 0,
        n = 0;
      for (let i = 0; i < L.length; i += 6 * 5) {
        z += L[i + 6 * 4 + 5];
        n++;
      }
      return z / n;
    };
    at(g, doc, 30);
    const still = tips();
    expect(still).toBeGreaterThan(0.4);
    Object.assign(ob.particle_systems[0], { use_hair_dynamics: true });
    at(g, doc, 31);
    const drooped = tips();
    expect(drooped).toBeLessThan(0.3);
    void m;
  });
});
