import { describe, it, expect, beforeAll } from 'vitest';
import { emptyDocument, newObject, newMeshData, uid } from '../../src/data/defaults';
import { cube } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { caches, startBudget, getCache } from '../../src/physics/common';
import { fluidCacheKey, type FluidModifier } from '../../src/physics/fluid';
import '../../src/physics/fluid';

function addMesh(doc: DocumentData, name: string, size: number, loc: [number, number, number] = [0, 0, 0]): ObjectData {
  const me = newMeshData(name, cube(size));
  doc.meshes[me.id] = me;
  const ob = newObject(name, 'MESH', me.id);
  ob.location = loc;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function fluid(ob: ObjectData, type: FluidModifier['fluid_type']) {
  const m = newModifier('FLUID', uid('md'), []) as FluidModifier;
  m.fluid_type = type;
  ob.modifiers.push(m);
  return m;
}
function scene() {
  caches.clear();
  const doc = emptyDocument();
  const domain = addMesh(doc, 'Domain', 4);
  const dm = fluid(domain, 'DOMAIN');
  Object.assign(dm.domain_settings, { domain_type: 'LIQUID', resolution_max: 16, use_collision_border_left: true, use_collision_border_right: true, use_collision_border_front: true, use_collision_border_back: true, use_collision_border_bottom: true, use_collision_border_top: true });
  dm.point_cache.frame_end = 80;
  const water = addMesh(doc, 'Water', 1.5, [0, 0, 1]);
  const fm = fluid(water, 'FLOW');
  Object.assign(fm.flow_settings, { flow_type: 'LIQUID', flow_behavior: 'GEOMETRY', surface_distance: 0 });
  return { doc, domain, dm };
}

beforeAll(() => startBudget(Infinity));

describe('liquid domains', () => {
  it('a block of liquid falls and spreads over the domain floor, keeping its particles', () => {
    const { doc, domain, dm } = scene();
    const g = new Depsgraph(doc);
    const zRange = (f: number) => {
      doc.scene.frame_current = f;
      g.evaluate(doc);
      const fr = getCache<{ particles: Float32Array }, unknown>(fluidCacheKey(domain, dm)).frames.get(f)!;
      const P = fr.particles;
      let lo = Infinity,
        hi = -Infinity,
        xlo = Infinity,
        xhi = -Infinity;
      for (let i = 0; i < P.length; i += 3) {
        lo = Math.min(lo, P[i + 2]);
        hi = Math.max(hi, P[i + 2]);
        xlo = Math.min(xlo, P[i]);
        xhi = Math.max(xhi, P[i]);
      }
      return { lo, hi, n: P.length / 3, width: xhi - xlo };
    };
    const a = zRange(3);
    expect(a.n).toBeGreaterThan(100);
    const b = zRange(60);
    // grid units (16 cells over 4 m): the liquid reached the floor and is lower than where it started
    expect(b.lo).toBeLessThan(0.5);
    expect(b.hi).toBeLessThan(a.hi - 2);
    expect(b.width).toBeGreaterThan(a.width);
    expect(b.n).toBe(a.n);
    // the domain shows the liquid surface
    const m = g.get(domain.id)!.mesh!;
    expect(m.offsets.length - 1).toBeGreaterThan(20);
    let maxZ = -Infinity;
    for (let i = 2; i < m.positions.length; i += 3) maxZ = Math.max(maxZ, m.positions[i]);
    expect(maxZ).toBeLessThan(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const { doc, domain } = scene();
      const g = new Depsgraph(doc);
      doc.scene.frame_current = 20;
      g.evaluate(doc);
      return Array.from(g.get(domain.id)!.mesh!.positions.slice(0, 30));
    };
    expect(run()).toEqual(run());
  });
});

describe('fields in fluid domains', () => {
  it('a wind field pushes the liquid sideways', async () => {
    const { defaultField } = await import('../../src/physics/types');
    const sideways = (wind: boolean) => {
      const { doc, domain, dm } = scene();
      if (wind) {
        const w = newObject('Wind', 'EMPTY', null);
        w.rotation_euler = [0, Math.PI / 2, 0];
        w.field = { ...defaultField('WIND'), strength: 30 };
        doc.objects[w.id] = w;
        doc.object_order.push(w.id);
        doc.collections[doc.scene.collection].objects.push(w.id);
      }
      const g = new Depsgraph(doc);
      doc.scene.frame_current = 30;
      g.evaluate(doc);
      const P = getCache<{ particles: Float32Array }, unknown>(fluidCacheKey(domain, dm)).frames.get(30)!.particles;
      let x = 0;
      for (let i = 0; i < P.length; i += 3) x += P[i];
      return x / (P.length / 3);
    };
    expect(sideways(true)).toBeGreaterThan(sideways(false) + 0.5);
  });
});
