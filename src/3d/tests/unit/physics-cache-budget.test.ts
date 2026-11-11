import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube, grid } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import '../../src/physics/engine';
import { cacheMemory, cachedBytes, caches, startBudget } from '../../src/physics/common';
import { smokeDraw, type FluidModifier } from '../../src/physics/fluid';
import { defaultCollision, defaultParticleSettings, defaultPointCache } from '../../src/physics/types';
import { particleDraw } from '../../src/physics/particles';

const DEFAULT = cacheMemory.budget;
afterEach(() => (cacheMemory.budget = DEFAULT));
beforeAll(() => startBudget(Infinity));

function addMesh(doc: DocumentData, name: string, arrays: ReturnType<typeof cube>, loc: [number, number, number]): ObjectData {
  const me = newMeshData(name, arrays);
  doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  ob.location = loc;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}

const at = (g: Depsgraph, doc: DocumentData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
  return g;
};

function clothScene() {
  caches.clear();
  const doc = emptyDocument();
  const ob = addMesh(doc, 'Cloth', grid(20, 20, 2), [0, 0, 2]);
  ob.modifiers.push(newModifier('CLOTH', uid('md'), []));
  const box = addMesh(doc, 'Box', cube(1), [0, 0, 0]);
  box.collision = defaultCollision();
  return { doc, ob };
}

function smokeScene() {
  caches.clear();
  const doc = emptyDocument();
  const domain = addMesh(doc, 'Domain', cube(4), [0, 0, 2]);
  const dm = newModifier('FLUID', uid('md'), []) as FluidModifier;
  dm.fluid_type = 'DOMAIN';
  dm.domain_settings.resolution_max = 24;
  domain.modifiers.push(dm);
  const flow = addMesh(doc, 'Emitter', cube(0.6), [0, 0, 0.6]);
  const fm = newModifier('FLUID', uid('md'), []) as FluidModifier;
  fm.fluid_type = 'FLOW';
  flow.modifiers.push(fm);
  return { doc, key: `${domain.id}:${dm.id}` };
}

function particleScene() {
  caches.clear();
  const doc = emptyDocument();
  const ob = addMesh(doc, 'Emitter', grid(4, 4, 2), [0, 0, 1]);
  const ps = defaultParticleSettings(uid('pa'), 'PS');
  ps.count = 3000;
  ps.frame_end = 30;
  doc.particles[ps.id] = ps;
  const sysId = uid('psys');
  ob.particle_systems.push({ name: 'P', settings: ps.id, seed: 7, id: sysId, point_cache: defaultPointCache(1, 250) } as never);
  const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
  m.particle_system = sysId;
  ob.modifiers.push(m);
  return { doc, key: `${ob.id}:${m.id}` };
}

describe('simulation cache memory budget', () => {
  it('cloth: drops far frames to stay in budget and simulates them again identically', () => {
    // reference without a limit
    let { doc, ob } = clothScene();
    let g = new Depsgraph(doc);
    const ref = new Map<number, number[]>();
    for (let f = 1; f <= 60; f++) ref.set(f, Array.from(at(g, doc, f).get(ob.id)!.mesh!.positions));
    const full = cachedBytes();
    // the same with room for about 10 frames
    ({ doc, ob } = clothScene());
    g = new Depsgraph(doc);
    cacheMemory.budget = full / 6;
    for (let f = 1; f <= 60; f++) expect(Array.from(at(g, doc, f).get(ob.id)!.mesh!.positions)).toEqual(ref.get(f));
    expect(cachedBytes()).toBeLessThanOrEqual(cacheMemory.budget);
    // scrubbing back to dropped frames simulates them again, with the same result
    for (const f of [5, 2, 40, 60, 30]) expect(Array.from(at(g, doc, f).get(ob.id)!.mesh!.positions)).toEqual(ref.get(f));
    expect(cachedBytes()).toBeLessThanOrEqual(cacheMemory.budget);
  });

  it('smoke and particles give the same frames with a small budget', () => {
    const run = (budget: number, scene: () => { doc: DocumentData; key: string }, read: (key: string) => unknown) => {
      cacheMemory.budget = budget;
      const { doc, key } = scene();
      const g = new Depsgraph(doc);
      const out: unknown[] = [];
      for (let f = 1; f <= 30; f++) out.push(JSON.stringify(read((at(g, doc, f), key))));
      for (const f of [4, 20, 9]) out.push(JSON.stringify(read((at(g, doc, f), key))));
      return { out, bytes: cachedBytes() };
    };
    const smoke = (k: string) => Array.from(smokeDraw.get(k)?.data ?? []);
    const parts = (k: string) => Array.from(particleDraw.get(k)?.points ?? []).map((x) => Math.round(x * 1e5));
    for (const [scene, read] of [[smokeScene, smoke], [particleScene, parts]] as const) {
      const a = run(DEFAULT, scene, read);
      const b = run(a.bytes / 5, scene, read);
      expect(b.out).toEqual(a.out);
      expect(b.bytes).toBeLessThanOrEqual(a.bytes / 5);
    }
  });

  it('keeps baked frames even over the budget and says so', () => {
    const { doc, ob } = clothScene();
    const g = new Depsgraph(doc);
    const mod = ob.modifiers[0] as unknown as { point_cache: { is_baked: boolean } };
    for (let f = 1; f <= 30; f++) at(g, doc, f);
    mod.point_cache.is_baked = true;
    at(g, doc, 30);
    const kept = caches.values().next().value!.frames.size;
    let reported = 0;
    const was = cacheMemory.onOverflow;
    cacheMemory.onOverflow = () => reported++;
    cacheMemory.budget = 1000;
    try {
      // an unbaked simulation that needs room
      const other = addMesh(doc, 'Cloth2', grid(10, 10, 2), [3, 0, 2]);
      other.modifiers.push(newModifier('CLOTH', uid('md'), []));
      for (let f = 1; f <= 10; f++) at(g, doc, f);
    } finally {
      cacheMemory.onOverflow = was;
    }
    expect(caches.values().next().value!.frames.size).toBe(kept);
    expect(reported).toBeGreaterThan(0);
  });
});
