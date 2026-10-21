import { describe, it, expect, beforeAll } from 'vitest';
import { Vector3 } from 'three';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube, grid, plane } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { loadRapier } from '../../src/physics/engine';
import { rigidBodyCache, rigidBodyMatrix } from '../../src/physics/rigidbody';
import { caches, startBudget } from '../../src/physics/common';
import { defaultRigidBody, defaultRigidBodyWorld, defaultCollision, defaultParticleSettings, defaultPointCache, type ClothModifier } from '../../src/physics/types';
import { particleDraw } from '../../src/physics/particles';

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

function evalAt(graph: Depsgraph, doc: DocumentData, f: number) {
  doc.scene.frame_current = f;
  graph.evaluate(doc);
  return graph;
}

beforeAll(async () => {
  await loadRapier();
  startBudget(Infinity);
});

describe('rigid bodies', () => {
  it('a dropped box comes to rest on a passive plane', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
    const ground = addMesh(doc, 'Ground', plane(20));
    ground.rigid_body = defaultRigidBody('PASSIVE');
    const box = addMesh(doc, 'Box', cube(2), [0, 0, 5]);
    box.rigid_body = { ...defaultRigidBody('ACTIVE'), collision_shape: 'BOX' };
    const g = new Depsgraph(doc);
    evalAt(g, doc, 1);
    expect(g.get(box.id)!.world.elements[14]).toBeCloseTo(5);
    evalAt(g, doc, 20);
    const z20 = g.get(box.id)!.world.elements[14];
    expect(z20).toBeLessThan(5);
    evalAt(g, doc, 150);
    const z150 = g.get(box.id)!.world.elements[14];
    evalAt(g, doc, 160);
    const z160 = g.get(box.id)!.world.elements[14];
    // resting on the plane: centre one half-size above it, not moving any more
    expect(z150).toBeGreaterThan(0.9);
    expect(z150).toBeLessThan(1.1);
    expect(Math.abs(z160 - z150)).toBeLessThan(1e-3);
  });

  it('bounciness makes a sphere bounce and lose energy', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
    const ground = addMesh(doc, 'Ground', plane(20));
    ground.rigid_body = { ...defaultRigidBody('PASSIVE'), collision_shape: 'BOX', restitution: 0.9 };
    const ball = addMesh(doc, 'Ball', cube(1), [0, 0, 4]);
    ball.rigid_body = { ...defaultRigidBody('ACTIVE'), collision_shape: 'SPHERE', restitution: 0.9, linear_damping: 0 };
    const g = new Depsgraph(doc);
    const zs: number[] = [];
    for (let f = 1; f <= 120; f++) zs.push(evalAt(g, doc, f).get(ball.id)!.world.elements[14]);
    // find local maxima after the first impact
    const peaks: number[] = [];
    for (let i = 1; i < zs.length - 1; i++) if (zs[i] > zs[i - 1] && zs[i] >= zs[i + 1] && i > 5) peaks.push(zs[i]);
    expect(peaks.length).toBeGreaterThan(1);
    expect(peaks[0]).toBeLessThan(4);
    expect(peaks[1]).toBeLessThan(peaks[0]);
  });

  it('scrubbing backward uses the cache; changing settings invalidates it', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 100);
    const ground = addMesh(doc, 'Ground', plane(20));
    ground.rigid_body = defaultRigidBody('PASSIVE');
    const box = addMesh(doc, 'Box', cube(2), [0, 0, 5]);
    box.rigid_body = { ...defaultRigidBody('ACTIVE'), collision_shape: 'BOX' };
    const g = new Depsgraph(doc);
    evalAt(g, doc, 40);
    const cache = rigidBodyCache();
    expect(cache.frames.size).toBe(40);
    const m10 = rigidBodyMatrix(doc, box.id, 10)!.elements[14];
    evalAt(g, doc, 10);
    expect(g.get(box.id)!.world.elements[14]).toBeCloseTo(m10);
    expect(cache.frames.size).toBe(40);
    // determinism: a fresh simulation gives identical results
    box.rigid_body.mass = 2;
    evalAt(g, doc, 10);
    expect(rigidBodyCache().frames.size).toBe(10);
    // beyond the end frame the last state holds
    evalAt(g, doc, 200);
    expect(rigidBodyCache().last).toBe(100);
  });

  it('collision shapes respect object scale', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
    const ground = addMesh(doc, 'Ground', plane(20));
    ground.rigid_body = defaultRigidBody('PASSIVE');
    const box = addMesh(doc, 'Box', cube(2), [0, 0, 5]);
    box.scale = [1, 1, 0.25];
    box.rigid_body = { ...defaultRigidBody('ACTIVE'), collision_shape: 'BOX' };
    const g = new Depsgraph(doc);
    evalAt(g, doc, 150);
    expect(g.get(box.id)!.world.elements[14]).toBeCloseTo(0.25, 1);
    // scale stays in the evaluated matrix
    const s = new Vector3().setFromMatrixColumn(g.get(box.id)!.world, 2).length();
    expect(s).toBeCloseTo(0.25, 3);
  });
});

describe('cloth', () => {
  it('falls under gravity while pinned corners stay fixed', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Cloth', grid(10, 10, 2), [0, 0, 2]);
    const me = doc.meshes[ob.data!];
    // pin two corners (vertex group)
    const n = me.positions.length / 3;
    const w = new Float32Array(n);
    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = me.positions[i * 3],
        y = me.positions[i * 3 + 1];
      if (y > 0.99 && Math.abs(Math.abs(x) - 1) < 1e-3) {
        w[i] = 1;
        corners.push(i);
      }
    }
    expect(corners.length).toBe(2);
    me.vertex_groups = [{ name: 'Pin' }];
    me.weights = [w];
    const mod = newModifier('CLOTH', uid('md'), []) as ClothModifier;
    mod.settings.vertex_group_mass = 'Pin';
    ob.modifiers.push(mod);
    const g = new Depsgraph(doc);
    evalAt(g, doc, 1);
    const rest = g.get(ob.id)!.mesh!.positions.slice();
    evalAt(g, doc, 40);
    const p = g.get(ob.id)!.mesh!.positions;
    for (const c of corners) for (let k = 0; k < 3; k++) expect(p[c * 3 + k]).toBeCloseTo(rest[c * 3 + k], 4);
    // the free edge has fallen
    let minZ = Infinity;
    for (let i = 0; i < n; i++) minZ = Math.min(minZ, p[i * 3 + 2]);
    expect(minZ).toBeLessThan(-0.8);
    // edges do not stretch excessively (structural constraints hold)
    const a = 0,
      b = 1;
    const len = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
    expect(len).toBeLessThan(0.2 * 1.25);
  });

  it('collides with a collision object', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Cloth', grid(12, 12, 2), [0, 0, 1]);
    const box = addMesh(doc, 'Box', cube(1), [0, 0, 0]);
    box.collision = defaultCollision();
    ob.modifiers.push(newModifier('CLOTH', uid('md'), []));
    const g = new Depsgraph(doc);
    for (let f = 1; f <= 60; f++) evalAt(g, doc, f);
    const p = g.get(ob.id)!.mesh!.positions;
    const wm = g.get(ob.id)!.world.elements;
    // vertices above the box top stay above it (box top at z = 0.5)
    for (let i = 0; i < p.length / 3; i++) {
      const x = p[i * 3] + wm[12],
        y = p[i * 3 + 1] + wm[13],
        z = p[i * 3 + 2] + wm[14];
      if (Math.abs(x) < 0.4 && Math.abs(y) < 0.4) expect(z).toBeGreaterThan(0.49);
    }
  });
});

describe('particles', () => {
  function emitterDoc(count = 200) {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Emitter', plane(2), [0, 0, 1]);
    const ps = defaultParticleSettings(uid('pa'), 'ParticleSettings');
    ps.count = count;
    ps.frame_start = 1;
    ps.frame_end = 21;
    ps.lifetime = 30;
    doc.particles[ps.id] = ps;
    const sysId = uid('psys');
    ob.particle_systems.push({ name: 'ParticleSystem', settings: ps.id, seed: 7, id: sysId, point_cache: defaultPointCache(1, 250) } as never);
    const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
    m.particle_system = sysId;
    ob.modifiers.push(m);
    return { doc, ob, ps, key: `${ob.id}:${m.id}` };
  }

  it('emits over the frame range and respects lifetimes', () => {
    const { doc, key } = emitterDoc(200);
    const g = new Depsgraph(doc);
    evalAt(g, doc, 11);
    const c11 = particleDraw.get(key)!.count;
    expect(c11).toBeGreaterThan(90);
    expect(c11).toBeLessThan(110);
    evalAt(g, doc, 25);
    expect(particleDraw.get(key)!.count).toBe(200);
    // particles born at frame 1 die at frame 31, the last ones (born ~21) at ~51
    evalAt(g, doc, 41);
    const c41 = particleDraw.get(key)!.count;
    expect(c41).toBeLessThan(110);
    expect(c41).toBeGreaterThan(90);
    evalAt(g, doc, 60);
    expect(particleDraw.get(key)!.count).toBe(0);
  });

  it('is deterministic per seed and frame (scrubbing)', () => {
    const a = emitterDoc(100);
    const g = new Depsgraph(a.doc);
    evalAt(g, a.doc, 30);
    const first = particleDraw.get(a.key)!.points!.slice();
    evalAt(g, a.doc, 10);
    evalAt(g, a.doc, 30);
    expect(Array.from(particleDraw.get(a.key)!.points!)).toEqual(Array.from(first));
    // a fresh run reproduces the same frame
    caches.clear();
    const g2 = new Depsgraph(a.doc);
    evalAt(g2, a.doc, 30);
    expect(Array.from(particleDraw.get(a.key)!.points!)).toEqual(Array.from(first));
    // particles fall under gravity
    const zs = Array.from(first).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeLessThan(0);
  });

  it('settings changes invalidate the cache', () => {
    const { doc, ps, key } = emitterDoc(100);
    const g = new Depsgraph(doc);
    evalAt(g, doc, 30);
    const before = particleDraw.get(key)!.points!.slice();
    ps.normal_factor = 5;
    evalAt(g, doc, 30);
    const after = particleDraw.get(key)!.points!;
    expect(Array.from(after)).not.toEqual(Array.from(before));
  });

  it('hair strands have the requested length and segments', () => {
    const { doc, ps, key } = emitterDoc(50);
    ps.type = 'HAIR';
    ps.hair_length = 0.5;
    ps.hair_step = 4;
    ps.render_type = 'PATH';
    // no path subdivision: one line per segment
    (ps as { display_step?: number }).display_step = 0;
    const g = new Depsgraph(doc);
    evalAt(g, doc, 1);
    const d = particleDraw.get(key)!;
    expect(d.count).toBe(50);
    expect(d.lines!.length).toBe(50 * 4 * 6);
    // first strand: root to tip length
    const root = d.lines!.subarray(0, 3),
      tip = d.lines!.subarray(3 * 6 + 3, 3 * 6 + 6);
    expect(Math.hypot(tip[0] - root[0], tip[1] - root[1], tip[2] - root[2])).toBeCloseTo(0.5, 4);
  });
});
