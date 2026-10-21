import { describe, it, expect, beforeAll } from 'vitest';
import { Vector3 } from 'three';
import { emptyDocument, newObject, newMeshData, uid, newCollection } from '../../src/data/defaults';
import { cube, plane } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { caches, startBudget, getCache } from '../../src/physics/common';
import { defaultParticleSettings, defaultPointCache, type ParticleSettingsX, type ParticleSystemX } from '../../src/physics/types';
import { particleCacheKey } from '../../src/physics/particles';
import { activeBoidState, boidAccelerations, boidDamage, defaultBoidSettings, ensureBoidStates, newBoidRule, type BoidOthers } from '../../src/physics/boids';
import { keyedPositionTimed, psysTargets } from '../../src/physics/keyed';
import { bindHairRoots, boundKeys } from '../../src/physics/hairbind';
import { editedFromStrands } from '../../src/hair/particle/keys';
import '../../src/physics/engine';

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
function emitter(doc: DocumentData, ob: ObjectData, settings: Partial<ParticleSettingsX>, sys: Partial<ParticleSystemX> = {}) {
  const ps = defaultParticleSettings(uid('pa'), 'P');
  Object.assign(ps, { count: 30, frame_start: 1, frame_end: 3, lifetime: 100, normal_factor: 0 }, settings);
  doc.particles[ps.id] = ps;
  const s = { id: uid('psys'), name: 'P', settings: ps.id, seed: 1, point_cache: defaultPointCache(1, 120), ...sys };
  ob.particle_systems.push(s as never);
  const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
  m.particle_system = s.id;
  ob.modifiers.push(m);
  return { ps, m, sys: s };
}
function frame(ob: ObjectData, m: { id: string }, f: number) {
  return getCache<{ pos: Float32Array; state: Uint8Array; land?: Uint8Array }, unknown>(particleCacheKey(ob, m as never)).frames.get(f)!;
}
const at = (g: Depsgraph, doc: DocumentData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
};

beforeAll(() => startBudget(Infinity));

describe('boid brain', () => {
  it('older rule lists become the first state; the active state steers', () => {
    const b = defaultBoidSettings();
    b.rules = [newBoidRule('GOAL')];
    expect(activeBoidState(b).rules[0].type).toBe('GOAL');
    const st = ensureBoidStates(b);
    expect(st.length).toBe(1);
    expect(st[0].rules[0].type).toBe('GOAL');
    b.states!.push({ ...st[0], name: 'Second', rules: [newBoidRule('FLOCK')] });
    b.active_boid_state_index = 1;
    expect(activeBoidState(b).rules[0].type).toBe('FLOCK');
  });

  it('fight: boids attack enemies, flee when outnumbered, and take damage', () => {
    const b = defaultBoidSettings();
    ensureBoidStates(b)[0].rules = [newBoidRule('FIGHT')];
    b.range = 2;
    const pos = new Float32Array([0, 0, 0]);
    const vel = new Float32Array([0, 0, 0]);
    const acc = new Float32Array(3);
    const enemy = (n: number): BoidOthers => ({ pos: new Float32Array(Array.from({ length: n }, () => [1, 0, 0]).flat()), alive: new Uint8Array(n).fill(1), alliance: 'ENEMY', strength: 0.5, accuracy: 1 });
    boidAccelerations(b, pos, vel, () => true, 1, new Map(), [], () => 0.5, acc, { others: [enemy(1)] });
    expect(acc[0]).toBeGreaterThan(0);
    // ten enemies against one boid with aggression 2: flee
    boidAccelerations(b, pos, vel, () => true, 1, new Map(), [], () => 0.5, acc, { others: [enemy(10)] });
    expect(acc[0]).toBeLessThan(0);
    const health = new Float32Array([1]);
    boidDamage(b, pos, () => true, 1, [enemy(2)], 0.5, health);
    expect(health[0]).toBeCloseTo(0.5, 5);
  });

  it('follow leader in a line: each boid follows the previous one', () => {
    const b = defaultBoidSettings();
    ensureBoidStates(b)[0].rules = [{ ...newBoidRule('FOLLOW_LEADER'), use_line: true, distance: 0 }];
    const pos = new Float32Array([0, 0, 0, 5, 0, 0]);
    const vel = new Float32Array(6);
    const acc = new Float32Array(6);
    boidAccelerations(b, pos, vel, () => true, 2, new Map(), [], () => 0.5, acc);
    // the second boid heads back to the first, the first has no leader
    expect(acc[3]).toBeLessThan(0);
    expect(acc[0]).toBe(0);
  });

  it('walking boids stay on the ground and run at the land speed', () => {
    caches.clear();
    const doc = emptyDocument();
    const floor = addMesh(doc, 'Floor', plane(40), [0, 0, 0]);
    floor.collision = { use: true, thickness_outer: 0.02, cloth_friction: 5, damping: 0.1, use_culling: false } as never;
    const goal = addMesh(doc, 'Goal', cube(0.2), [30, 0, 0]);
    const ob = addMesh(doc, 'Herd', plane(1), [0, 0, 0.5]);
    const b = defaultBoidSettings();
    Object.assign(b, { use_flight: false, use_land: true, land_speed_max: 2 });
    ensureBoidStates(b)[0].rules = [{ ...newBoidRule('GOAL'), object: goal.id }];
    const { m } = emitter(doc, ob, { physics_type: 'BOIDS', boids: b, count: 10 });
    const g = new Depsgraph(doc);
    at(g, doc, 49);
    const fr = frame(ob, m, 49);
    let maxZ = -Infinity,
      sx = 0,
      n = 0;
    for (let i = 0; i < fr.state.length; i++) {
      if (fr.state[i] !== 1) continue;
      maxZ = Math.max(maxZ, fr.pos[i * 3 + 2]);
      sx += fr.pos[i * 3];
      n++;
    }
    expect(n).toBeGreaterThan(0);
    // on the floor (not flying up), moving towards the goal no faster than the land speed (2 s)
    expect(maxZ).toBeLessThan(0.6);
    expect(sx / n).toBeGreaterThan(0.5);
    expect(sx / n).toBeLessThan(5);
    expect(fr.land?.some((x) => x === 1)).toBe(true);
  });
});

describe('particle targets', () => {
  it('targets live on the system (older files: on the settings)', () => {
    expect(psysTargets(undefined, { keyed_targets: [{ object: 'a', system: 1 }] })[0].object).toBe('a');
    expect(psysTargets({ targets: [] }, { keyed_targets: [{ object: 'a', system: 1 }] }).length).toBe(0);
  });

  it('keyed timing: particles reach each key at its time and stay for its duration', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    const out = [0, 0, 0];
    keyedPositionTimed(pts, [0, 10, 30], [0, 5, 0], 5, out);
    expect(out[0]).toBeCloseTo(5, 5);
    keyedPositionTimed(pts, [0, 10, 30], [0, 5, 0], 12, out);
    expect(out).toEqual([10, 0, 0]);
    keyedPositionTimed(pts, [0, 10, 30], [0, 5, 0], 22.5, out);
    expect(out[1]).toBeCloseTo(5, 5);
    keyedPositionTimed(pts, [0, 10, 30], [0, 5, 0], 99, out);
    expect(out).toEqual([10, 10, 0]);
  });

  it('keyed systems read their targets from the system list', () => {
    caches.clear();
    const doc = emptyDocument();
    const target = addMesh(doc, 'Target', plane(0.1), [5, 0, 0]);
    emitter(doc, target, { physics_type: 'NO', count: 10 });
    const ob = addMesh(doc, 'Source', plane(0.1), [0, 0, 0]);
    const { m } = emitter(doc, ob, { physics_type: 'KEYED', count: 10, lifetime: 40 }, { targets: [{ object: target.id, system: 1, time: 10, duration: 20 }], use_keyed_timing: true });
    const g = new Depsgraph(doc);
    at(g, doc, 25);
    const fr = frame(ob, m, 25);
    // born at frame ≤ 3, at the target from age 10 to 30: at frame 25 every particle sits there
    for (let i = 0; i < fr.state.length; i++) if (fr.state[i] === 1) expect(fr.pos[i * 3]).toBeGreaterThan(4.5);
  });
});

describe('instance weights', () => {
  it('Use Count repeats collection objects by their counts', () => {
    caches.clear();
    const doc = emptyDocument();
    const a = addMesh(doc, 'A', cube(0.1), [10, 0, 0]);
    const b = addMesh(doc, 'B', cube(0.1), [10, 1, 0]);
    const coll = newCollection('Bits');
    doc.collections[coll.id] = coll;
    coll.objects.push(a.id, b.id);
    const ob = addMesh(doc, 'Emitter', plane(1));
    emitter(doc, ob, { physics_type: 'NO', count: 8, render_type: 'COLLECTION', instance_collection: coll.id, use_collection_count: true, instance_weights: [{ object: a.id, name: 'A', count: 3 }, { object: b.id, name: 'B', count: 1 }] });
    const g = new Depsgraph(doc);
    at(g, doc, 5);
    const inst = g.get(ob.id)!.mesh!.instances!;
    expect(inst.length).toBe(8);
    expect(inst.filter((i) => i.objectId === a.id).length).toBe(6);
    expect(inst.filter((i) => i.objectId === b.id).length).toBe(2);
  });
});

describe('connected hair', () => {
  it('bound strands snap to the surface and follow its deformation', () => {
    // a unit quad in z = 0 and two strands slightly above it
    const mesh = { positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), offsets: new Uint32Array([0, 4]), indices: new Uint32Array([0, 1, 2, 3]), uvs: new Float32Array(0), normals: new Float32Array(0) };
    const ed = editedFromStrands(new Float32Array([0, 0, 0.2, 0, 0, 1.2, 0.5, 0.5, 0.1, 0.5, 0.5, 1.1]), 2, 2);
    const r = bindHairRoots(ed, mesh);
    expect(r.ed.co[2]).toBeCloseTo(0, 5);
    expect(r.ed.co[5]).toBeCloseTo(1, 5);
    // move the quad up by 2 and turn it upside down around X: the hair points down now
    const moved = new Float32Array([-1, 1, 2, 1, 1, 2, 1, -1, 2, -1, -1, 2]);
    const k = boundKeys(r.ed, r.binding, moved)!;
    expect(k[2]).toBeCloseTo(2, 5);
    expect(k[5]).toBeCloseTo(1, 5);
    // a mesh with another vertex count leaves the hair alone
    expect(boundKeys(r.ed, r.binding, new Float32Array(9))).toBeNull();
    void Vector3;
  });
});
