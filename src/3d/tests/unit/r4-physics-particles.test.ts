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

import { childSettings, childStrands, describeChildren, shapeCurve } from '../../src/physics/children';
import { smoothStrands, strandRadii } from '../../src/physics/hairpaths';
import { MeshSampler, planSamples } from '../../src/physics/sampling';
import { grid as gridPrim } from '../../src/mesh/primitives';

describe('hair children', () => {
  // two straight parents 1 m apart, 1 m long, 5 points each
  const parents = new Float32Array([0, 0, 0, 0, 0, 0.25, 0, 0, 0.5, 0, 0, 0.75, 0, 0, 1, 1, 0, 0, 1, 0, 0.25, 1, 0, 0.5, 1, 0, 0.75, 1, 0, 1]);
  const base = (over: Record<string, unknown>) => childSettings({ child_type: 'SIMPLE', child_radius: 0.2, ...over }, 8);
  it('simple children surround their parent and clumping pulls the tips in', () => {
    const cs = base({});
    const d = describeChildren(parents, 5, 2, cs, 1, null);
    expect(d.n).toBe(16);
    const free = childStrands(parents, 5, d, cs);
    const tipDist = (pts: Float32Array, c: number) => Math.hypot(pts[c * 15 + 12] - (c < 8 ? 0 : 1), pts[c * 15 + 13], pts[c * 15 + 14] - 1);
    const clumped = childStrands(parents, 5, d, { ...cs, clump: 1 });
    for (let c = 0; c < 16; c++) {
      expect(tipDist(free, c)).toBeLessThanOrEqual(0.2001);
      expect(tipDist(clumped, c)).toBeLessThan(1e-5);
    }
  });

  it('kinks displace the children periodically; length shortens them', () => {
    const cs = base({ kink: 'RADIAL', kink_amplitude: 0.1, kink_frequency: 2 });
    const d = describeChildren(parents, 5, 2, cs, 1, null);
    const plain = childStrands(parents, 5, d, base({}));
    const k = childStrands(parents, 5, d, cs);
    let moved = 0;
    for (let i = 0; i < k.length; i++) if (Math.abs(k[i] - plain[i]) > 1e-4) moved++;
    expect(moved).toBeGreaterThan(10);
    const half = childStrands(parents, 5, describeChildren(parents, 5, 2, base({ child_length: 0.5 }), 1, null), base({ child_length: 0.5 }));
    // the tip ends half way up
    expect(half[14]).toBeCloseTo(0.5, 3);
    expect(shapeCurve(0.5, 0)).toBeCloseTo(0.5, 6);
    expect(shapeCurve(0.5, 0.5)).toBeGreaterThan(0.5);
  });

  it('interpolated children grow from the surface between parents', () => {
    const mesh = { positions: new Float32Array([-0.5, -0.5, 0, 1.5, -0.5, 0, 1.5, 0.5, 0, -0.5, 0.5, 0]), offsets: new Uint32Array([0, 4]), indices: new Uint32Array([0, 1, 2, 3]), uvs: new Float32Array(0), normals: new Float32Array(0) };
    const cs = childSettings({ child_type: 'INTERPOLATED' }, 10);
    const d = describeChildren(parents, 5, 2, cs, 3, new MeshSampler(mesh as never));
    const pts = childStrands(parents, 5, d, cs);
    for (let c = 0; c < d.n; c++) {
      // roots on the surface, tips one metre up (both parents are straight up)
      expect(pts[c * 15 + 2]).toBeCloseTo(0, 5);
      expect(pts[c * 15 + 14]).toBeCloseTo(1, 4);
      expect(pts[c * 15]).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(pts[c * 15]).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });

  it('paths are subdivided by the steps and smoothed with B-Spline; strands taper', () => {
    const r = smoothStrands(parents, 5, 2, false);
    expect(r.per).toBe(17);
    expect(r.points[16 * 3 + 2]).toBeCloseTo(1, 6);
    // Catmull-Rom goes through the keys
    expect(r.points[4 * 3 + 2]).toBeCloseTo(0.25, 6);
    const b = smoothStrands(parents, 5, 1, true);
    expect(b.points[2]).toBeCloseTo(0, 6);
    const radii = strandRadii(5, { root_radius: 1, tip_radius: 0, radius_scale: 0.02 });
    expect(radii[0]).toBeCloseTo(0.01, 6);
    expect(radii[4]).toBe(0);
    expect(radii[2]).toBeLessThan(radii[1]);
  });
});

describe('emission distributions', () => {
  const mesh = () => {
    const me = newMeshData('g', gridPrim(4, 4, 2));
    return { positions: me.positions, offsets: me.offsets, indices: me.indices, uvs: new Float32Array(0), normals: new Float32Array(0) };
  };
  it('jittered spreads the particles evenly over the faces, grid makes its own count', () => {
    const sm = new MeshSampler(mesh() as never);
    const jit = planSamples(sm, { emit_from: 'FACE', distribution: 'JIT', use_emit_random: false }, 1, 160);
    expect(jit.length).toBe(160);
    // 16 equal faces: 10 particles in each quarter of the plane
    const q = [0, 0, 0, 0];
    for (const s of jit) q[(s.px > 0 ? 1 : 0) + (s.py > 0 ? 2 : 0)]++;
    expect(q).toEqual([40, 40, 40, 40]);
    const rnd = planSamples(sm, { emit_from: 'FACE', distribution: 'RAND' }, 1, 160);
    expect(rnd.length).toBe(160);
    const g = planSamples(sm, { emit_from: 'FACE', distribution: 'GRID', grid_resolution: 4 }, 1, 999);
    expect(g.length).toBe(25);
    // vertices in order
    const v = planSamples(sm, { emit_from: 'VERT', use_emit_random: false }, 1, 30);
    expect(v[3].px).toBeCloseTo(sm.mesh.positions[9], 6);
  });
});
