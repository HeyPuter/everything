import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4 } from 'three';
import { emptyDocument, newObject } from '../../src/data/defaults';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newConstraint } from '../../src/eval/constraints';
import type { DocumentData, ObjectData, Vec3 } from '../../src/data/types';

interface Xf {
  loc?: number[];
  rot?: number[];
  scale?: number[];
}
interface Case {
  key: string;
  owner: Xf;
  target: Xf | null;
  type: string;
  props: Record<string, unknown>;
  expected: number[];
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/constraint_cases.json', import.meta.url), 'utf8')) as { cases: Case[]; extra: Record<string, number[]> };

function addEmpty(doc: DocumentData, name: string, xf: Xf = {}): ObjectData {
  const ob = newObject(name, 'EMPTY', null);
  ob.location = (xf.loc ?? [0, 0, 0]) as Vec3;
  ob.rotation_euler = (xf.rot ?? [0, 0, 0]) as Vec3;
  ob.scale = (xf.scale ?? [1, 1, 1]) as Vec3;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}

/** Row-major 4x4 (as printed by scripts) to a column-major Matrix4. */
const rowMajor = (a: number[]) => new Matrix4().set(...(a as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));

function expectMatrix(m: Matrix4, rows: number[], key: string, tol = 2e-3) {
  const e = rowMajor(rows).elements;
  const got = m.elements;
  const bad = got.some((v, i) => Math.abs(v - e[i]) > tol);
  if (bad) throw new Error(`${key}: got ${Array.from(m.clone().transpose().elements).map((x) => x.toFixed(4))} expected ${rows.map((x) => x.toFixed(4))}`);
}

describe('constraint types match expected transforms', () => {
  for (const cs of fixture.cases) {
    it(cs.key, () => {
      const doc = emptyDocument();
      const target = cs.target ? addEmpty(doc, 'T', cs.target) : null;
      const owner = addEmpty(doc, 'O', cs.owner);
      const c = newConstraint(cs.type, 'c1');
      if (target) c.target = target.id;
      Object.assign(c, cs.props);
      owner.constraints.push(c);
      const g = new Depsgraph(doc);
      g.evaluate(doc);
      expectMatrix(g.get(owner.id)!.world, cs.expected, cs.key);
    });
  }
});

describe('constraint spaces and Child Of', () => {
  it('Child Of keeps the owner in place when added, then follows the target', () => {
    const doc = emptyDocument();
    const t = addEmpty(doc, 'T', { loc: [-1, 0.5, 2], rot: [0.5, -0.4, 0.7], scale: [1, 2, 1] });
    const o = addEmpty(doc, 'O', { loc: [1, 2, 3], rot: [0.3, 0.2, 0.1] });
    const c = newConstraint('CHILD_OF', 'c1');
    c.target = t.id;
    o.constraints.push(c);
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    expectMatrix(g.get(o.id)!.world, fixture.extra.childof_init, 'init');
    t.location = [0, 0, 0];
    t.rotation_euler = [0, 0, 0.5];
    g.evaluate(doc);
    expectMatrix(g.get(o.id)!.world, fixture.extra.childof_moved, 'moved');
  });

  it('local and custom spaces convert owner and target matrices', () => {
    for (const [os, ts] of [
      ['WORLD', 'WORLD'],
      ['WORLD', 'LOCAL'],
      ['LOCAL', 'WORLD'],
      ['LOCAL', 'LOCAL'],
    ]) {
      const doc = emptyDocument();
      const par = addEmpty(doc, 'P', { loc: [0, 0, 1], rot: [0, 0, Math.PI / 2], scale: [2, 2, 2] });
      const o = addEmpty(doc, 'O', { loc: [1, 0, 0], rot: [0.1, 0, 0] });
      const t = addEmpty(doc, 'T', { loc: [0, 3, 0], rot: [0, 0.3, 0] });
      o.parent = par.id;
      t.parent = par.id;
      for (const kind of ['loc', 'rot'] as const) {
        o.constraints = [];
        const c = newConstraint(kind === 'loc' ? 'COPY_LOCATION' : 'COPY_ROTATION', 'c1');
        Object.assign(c, { target: t.id, owner_space: os, target_space: ts });
        o.constraints.push(c);
        const g = new Depsgraph(doc);
        g.evaluate(doc);
        expectMatrix(g.get(o.id)!.world, fixture.extra[`space_${kind}_${os}_${ts}`], `${kind} ${os}/${ts}`);
      }
    }
    const doc = emptyDocument();
    const par = addEmpty(doc, 'P', { loc: [0, 0, 1], rot: [0, 0, Math.PI / 2], scale: [2, 2, 2] });
    const o = addEmpty(doc, 'O', { loc: [1, 0, 0], rot: [0.1, 0, 0] });
    const t = addEmpty(doc, 'T', { loc: [0, 3, 0], rot: [0, 0.3, 0] });
    const cs = addEmpty(doc, 'C', { loc: [0, 0, 2], rot: [0.5, 0, 0] });
    o.parent = par.id;
    t.parent = par.id;
    const c = newConstraint('COPY_LOCATION', 'c1');
    Object.assign(c, { target: t.id, owner_space: 'CUSTOM', target_space: 'CUSTOM', space_object: cs.id, use_y: false });
    o.constraints.push(c);
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    expectMatrix(g.get(o.id)!.world, fixture.extra.space_loc_custom, 'custom');
  });
});

describe('animated constraint settings', () => {
  it('keyframed influence blends the constraint over time', async () => {
    const { insertKeyframe } = await import('../../src/anim/fcurve');
    const doc = emptyDocument();
    const t = addEmpty(doc, 'T', { loc: [4, 0, 0] });
    const o = addEmpty(doc, 'O', {});
    const c = newConstraint('COPY_LOCATION', 'c1');
    c.target = t.id;
    o.constraints.push(c);
    const fc = { data_path: 'constraints["Copy Location"].influence', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT' as const, modifiers: [] };
    insertKeyframe(fc, 1, 0, { interpolation: 'LINEAR' });
    insertKeyframe(fc, 11, 1, { interpolation: 'LINEAR' });
    const act = { id: 'act1', name: 'A', fcurves: [fc] };
    doc.actions[act.id] = act as never;
    o.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
    const g = new Depsgraph(doc);
    doc.scene.frame_current = 6;
    g.evaluate(doc);
    expect(g.get(o.id)!.world.elements[12]).toBeCloseTo(2, 3);
  });
});
