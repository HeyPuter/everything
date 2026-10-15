import { describe, it, expect } from 'vitest';
import { emptyDocument, newObject, newCurve, newMeshData, uid } from '../../src/data/defaults';
import { plane } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newModifier } from '../../src/eval/modifiers';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { effectorForce, collectEffectors } from '../../src/physics/fields';
import { caches, startBudget } from '../../src/physics/common';
import { defaultField, defaultParticleSettings, defaultPointCache, type ForceFieldX } from '../../src/physics/types';
import { particleDraw } from '../../src/physics/particles';

function link(doc: DocumentData, ob: ObjectData) {
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function field(type: ForceFieldX['type'], extra: Partial<ForceFieldX> = {}) {
  const doc = emptyDocument();
  const ob = link(doc, newObject('F', 'EMPTY', null));
  ob.field = { ...defaultField(type), ...extra };
  return { doc, ob };
}
const force = (doc: DocumentData, p: number[], v = [0, 0, 0]) => {
  const out = [0, 0, 0];
  effectorForce(collectEffectors({ doc, graph: null }, 1), p[0], p[1], p[2], v[0], v[1], v[2], 1, out);
  return out;
};

describe('force field types and shapes', () => {
  it('magnetic fields push sideways to the motion', () => {
    const { doc } = field('MAGNET', { strength: 2 });
    const f = force(doc, [1, 0, 0], [0, 1, 0]);
    // perpendicular to the velocity (Y) and the field axis (Z)
    expect(Math.abs(f[0])).toBeGreaterThan(1);
    expect(f[1]).toBeCloseTo(0);
    expect(f[2]).toBeCloseTo(0);
    expect(force(doc, [1, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('harmonic fields pull towards the rest length and damp motion', () => {
    const { doc } = field('HARMONIC', { strength: 3, rest_length: 1, harmonic_damping: 0 });
    expect(force(doc, [3, 0, 0])[0]).toBeCloseTo(-6);
    expect(force(doc, [0.5, 0, 0])[0]).toBeCloseTo(1.5);
    expect(force(doc, [1, 0, 0])[0]).toBeCloseTo(0);
    const { doc: d2 } = field('HARMONIC', { strength: 0, harmonic_damping: 2 });
    expect(force(d2, [1, 0, 0], [1, 0, 0])[0]).toBeCloseTo(-2);
  });

  it('Lennard-Jones fields repel up close and attract a little further out', () => {
    const { doc } = field('LENNARDJ', { strength: 1, size: 1 });
    expect(force(doc, [0.8, 0, 0])[0]).toBeGreaterThan(0);
    expect(force(doc, [1.5, 0, 0])[0]).toBeLessThan(0);
  });

  it('line and plane shapes measure from the field axis and the field plane', () => {
    const { doc } = field('FORCE', { strength: 1, shape: 'LINE' });
    const f = force(doc, [2, 0, 5]);
    expect(f[0]).toBeCloseTo(1);
    expect(f[2]).toBeCloseTo(0);
    const { doc: d2 } = field('FORCE', { strength: 1, shape: 'PLANE' });
    const g = force(d2, [3, 4, 2]);
    expect(g[2]).toBeCloseTo(1);
    expect(Math.hypot(g[0], g[1])).toBeCloseTo(0);
  });

  it('surface shapes measure from the nearest point of the field mesh', () => {
    const doc = emptyDocument();
    const me = newMeshData('P', plane(2));
    doc.meshes[me.id] = me;
    const ob = link(doc, newObject('P', 'MESH', me.id));
    ob.field = { ...defaultField('FORCE'), strength: 1, shape: 'SURFACE' };
    const f = force(doc, [0.5, 0.5, 2]);
    expect(f[2]).toBeCloseTo(1);
    expect(Math.hypot(f[0], f[1])).toBeCloseTo(0);
  });

  it('curve guides lead particles along the curve', () => {
    caches.clear();
    startBudget(Infinity);
    const doc = emptyDocument();
    doc.scene.use_gravity = false;
    const me = newMeshData('E', plane(0.2));
    doc.meshes[me.id] = me;
    const emitter = link(doc, newObject('E', 'MESH', me.id));
    const ps = defaultParticleSettings(uid('pa'), 'P');
    Object.assign(ps, { count: 20, frame_start: 1, frame_end: 2, lifetime: 50, normal_factor: 0 });
    doc.particles[ps.id] = ps;
    const sys = { id: uid('psys'), name: 'P', settings: ps.id, seed: 1, point_cache: defaultPointCache(1, 60) };
    emitter.particle_systems.push(sys as never);
    const m = newModifier('PARTICLE_SYSTEM', uid('md'), []);
    m.particle_system = sys.id;
    emitter.modifiers.push(m);
    // a straight guide along +X, 10 m long
    const cu = newCurve('G');
    cu.splines.push({ type: 'POLY', bezier_points: [], points: [{ co: [0, 0, 0, 1], radius: 1, tilt: 0, weight: 1, select: false }, { co: [10, 0, 0, 1], radius: 1, tilt: 0, weight: 1, select: false }] as never, use_cyclic_u: false, resolution_u: 12, order_u: 4, use_smooth: false, material_index: 0 });
    doc.curves[cu.id] = cu;
    const guide = link(doc, newObject('G', 'CURVE', cu.id));
    guide.field = { ...defaultField('GUIDE'), guide_free: 0 };
    const g = new Depsgraph(doc);
    doc.scene.frame_current = 26;
    g.evaluate(doc);
    const draw = [...particleDraw.values()].find((d) => d.objectId === emitter.id);
    expect(draw?.points).toBeTruthy();
    const P = draw!.points!;
    expect(draw!.space).toBe('WORLD');
    // about half way through their life: around x = 5
    let sx = 0,
      n = 0;
    for (let i = 0; i < P.length; i += 3) {
      sx += P[i];
      n++;
    }
    expect(sx / n).toBeGreaterThan(4);
    expect(sx / n).toBeLessThan(6);
  });
});
