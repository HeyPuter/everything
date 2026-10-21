// Simulation results compared with values recorded from a reference run of the same scenes
// (default settings): positions at given frames, with a tolerance for the different solvers.
import { describe, it, expect, beforeAll } from 'vitest';
import { emptyDocument, newObject, newMeshData } from '../../src/data/defaults';
import { cube, plane } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { loadRapier } from '../../src/physics/engine';
import { caches, startBudget } from '../../src/physics/common';
import { defaultRigidBody, defaultRigidBodyWorld } from '../../src/physics/types';

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

beforeAll(async () => {
  await loadRapier();
  startBudget(Infinity);
});

describe('rigid body fall (reference values)', () => {
  it('a 2 m cube dropped from 5 m onto a passive plane', () => {
    caches.clear();
    const doc = emptyDocument();
    doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
    const ground = addMesh(doc, 'Plane', plane(20));
    ground.rigid_body = defaultRigidBody('PASSIVE');
    const box = addMesh(doc, 'Cube', cube(2), [0, 0, 5]);
    box.rigid_body = defaultRigidBody('ACTIVE');
    const g = new Depsgraph(doc);
    const z: Record<number, number> = {};
    for (let f = 1; f <= 80; f++) {
      doc.scene.frame_current = f;
      g.evaluate(doc);
      z[f] = g.get(box.id)!.world.elements[14];
    }
    // reference: 1: 5.0, 10: 4.3061, 20: 1.9425, 25: 1.0114, 30: 1.0001, 80: 1.0001
    expect(z[1]).toBeCloseTo(5, 4);
    expect(Math.abs(z[10] - 4.3061)).toBeLessThan(0.02);
    expect(Math.abs(z[20] - 1.9425)).toBeLessThan(0.05);
    expect(Math.abs(z[30] - 1.0001)).toBeLessThan(0.06);
    expect(Math.abs(z[80] - 1.0001)).toBeLessThan(0.06);
  });
});

import { newModifier } from '../../src/eval/modifiers';
import { getCache } from '../../src/physics/common';
import { defaultParticleSettings, defaultPointCache } from '../../src/physics/types';
import { particleCacheKey } from '../../src/physics/particles';
import { uid } from '../../src/data/defaults';

describe('particle emission (reference values)', () => {
  it('default emitter on a 2 m cube: alive counts and heights over time', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Cube', cube(2));
    const ps = defaultParticleSettings(uid('pa'), 'P');
    doc.particles[ps.id] = ps;
    const sys = { id: uid('psys'), name: 'P', settings: ps.id, seed: 0, point_cache: defaultPointCache(1, 250) };
    ob.particle_systems.push(sys as never);
    const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
    m.particle_system = sys.id;
    ob.modifiers.push(m);
    const g = new Depsgraph(doc);
    const stats: Record<number, [number, number, number]> = {};
    for (let f = 1; f <= 60; f++) {
      doc.scene.frame_current = f;
      g.evaluate(doc);
      if ([1, 2, 10, 50, 51, 60].includes(f)) {
        const fr = getCache<{ pos: Float32Array; state: Uint8Array }, unknown>(particleCacheKey(ob, m)).frames.get(f)!;
        let n = 0,
          z = 0,
          zmax = -Infinity;
        for (let i = 0; i < fr.state.length; i++)
          if (fr.state[i] === 1) {
            n++;
            z += fr.pos[i * 3 + 2];
            zmax = Math.max(zmax, fr.pos[i * 3 + 2]);
          }
        stats[f] = [n, +(z / Math.max(1, n)).toFixed(4), +zmax.toFixed(4)];
      }
    }
    // reference: 1: 1 alive, 2: 6, 10: 46, 50: 247, 51+: 251; mean height at 50 ≈ -6.43
    expect(stats[1][0]).toBeLessThanOrEqual(2);
    expect(Math.abs(stats[2][0] - 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(stats[10][0] - 46)).toBeLessThanOrEqual(2);
    expect(Math.abs(stats[50][0] - 247)).toBeLessThanOrEqual(3);
    expect(Math.abs(stats[60][0] - 251)).toBeLessThanOrEqual(3);
    expect(Math.abs(stats[50][1] - -6.43)).toBeLessThan(0.3);
    expect(Math.abs(stats[60][1] - -6.62)).toBeLessThan(0.3);
  });
});

import { grid } from '../../src/mesh/primitives';
import type { ClothModifier } from '../../src/physics/types';

describe('cloth (reference values)', () => {
  it('a 2 m cloth pinned along one edge swings down and hangs', () => {
    caches.clear();
    const doc = emptyDocument();
    const ob = addMesh(doc, 'Cloth', grid(11, 11, 2), [0, 0, 2]);
    const me = doc.meshes[ob.data!];
    const n = me.positions.length / 3;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) if (me.positions[i * 3 + 1] > 0.99) w[i] = 1;
    me.vertex_groups = [{ name: 'Pin' } as never];
    (me as unknown as { weights: Float32Array[] }).weights = [w];
    const mod = newModifier('CLOTH', uid('md'), []) as ClothModifier;
    mod.settings.vertex_group_mass = 'Pin';
    ob.modifiers.push(mod);
    const g = new Depsgraph(doc);
    const out: Record<number, number[]> = {};
    for (let f = 1; f <= 60; f++) {
      doc.scene.frame_current = f;
      g.evaluate(doc);
      if ([5, 10, 20, 40, 60].includes(f)) {
        const p = g.get(ob.id)!.mesh!.positions;
        let zs = 0,
          zmin = Infinity,
          ymin = Infinity;
        for (let i = 0; i < n; i++) {
          zs += p[i * 3 + 2] + 2;
          zmin = Math.min(zmin, p[i * 3 + 2] + 2);
          ymin = Math.min(ymin, p[i * 3 + 1]);
        }
        out[f] = [+(zs / n).toFixed(4), +zmin.toFixed(4), +ymin.toFixed(4)];
      }
    }
    // reference (mean z, min z, min y): 5: 1.93 1.92 -0.99, 10: 1.70 1.62 -0.90, 20: 1.14 0.50 -0.17, 60: 1.03 0.12 1.0
    expect(Math.abs(out[5][0] - 1.9305)).toBeLessThan(0.02);
    expect(Math.abs(out[10][0] - 1.7027)).toBeLessThan(0.04);
    expect(Math.abs(out[20][0] - 1.1436)).toBeLessThan(0.08);
    expect(Math.abs(out[20][2] - -0.1735)).toBeLessThan(0.1);
    // hanging at the end: about the cloth's length below the pinned edge
    expect(Math.abs(out[60][0] - 1.0343)).toBeLessThan(0.05);
    expect(Math.abs(out[60][1] - 0.1232)).toBeLessThan(0.08);
  });
});
