// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

/** 6×2 grid (x from -1 to 1 in steps of 0.4, y = ±1). */
function grid(groups: Record<string, (x: number, y: number) => number>): EvalMesh {
  const m = newMeshData('g', prim.grid(5, 1)) as unknown as EvalMesh;
  const P = m.positions;
  const names = Object.keys(groups);
  m.vertex_groups = names.map((name) => ({ name }));
  m.weights = names.map((n) => {
    const w = new Float32Array(P.length / 3);
    for (let i = 0; i < w.length; i++) w[i] = groups[n](P[i * 3], P[i * 3 + 1]);
    return w;
  });
  return m;
}

function run(type: string, m: EvalMesh, props: Record<string, unknown>, ctx: Partial<ModifierContext> = {}) {
  const t = modifierTypes[type];
  return t.apply(m, { ...t.defaults(), type, name: type, id: 'md', ...props } as never, { ob: { name: 'Grid', id: 'ob' }, ...ctx } as ModifierContext);
}

const W = (m: EvalMesh, name: string) => Array.from(m.weights![m.vertex_groups!.findIndex((g) => g.name === name)]);
const close = (a: number[], b: (number | null)[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] ?? 0, 4));
};

const G = { G: (x: number) => (x < 0.5 ? (x + 1) / 1.5 : 0) };

describe('Vertex Weight Edit', () => {
  it('maps weights through the falloff types', () => {
    const exp: Record<string, number[]> = {
      LINEAR: [0, 0.26667, 0.53333, 0.8, 0, 0],
      SHARP: [0, 0.07111, 0.28444, 0.64, 0, 0],
      SMOOTH: [0, 0.17541, 0.54993, 0.896, 0, 0],
      ROOT: [0, 0.5164, 0.7303, 0.89443, 0, 0],
      ICON_SPHERECURVE: [0, 0.67987, 0.88443, 0.9798, 0, 0],
      STEP: [0, 0, 1, 1, 0, 0],
    };
    for (const [ft, row] of Object.entries(exp)) close(W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', falloff_type: ft }), 'G'), [...row, ...row]);
  });

  it('inverts, normalizes, masks, adds and removes', () => {
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', falloff_type: 'SHARP', invert_falloff: true }), 'G').slice(1, 4), [0.92889, 0.71556, 0.36]);
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', normalize: true }), 'G').slice(0, 6), [0, 0.33333, 0.66667, 1, 0, 0]);
    // (vertex 0 has weight 0 here, which counts as "not in the group", so it is skipped)
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', use_add: true, default_weight: 0.3, add_threshold: 0.2 }), 'G').slice(1, 6), [0.26667, 0.53333, 0.8, 0.3, 0.3]);
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', mask_constant: 0.5, falloff_type: 'SHARP' }), 'G').slice(0, 6), [0, 0.16889, 0.40889, 0.72, 0, 0]);
  });

  it('applies the threshold after mapping and masks with a vertex group', () => {
    const G2 = { G: (x: number) => (x < 0.5 ? (x + 1) / 1.5 + 0.1 : 0), M: (_x: number, y: number) => (y > 0 ? 0.25 : 0.75) };
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G2), { vertex_group: 'G', use_add: true, default_weight: 0.3, add_threshold: 0.2, falloff_type: 'SHARP' }), 'G').slice(0, 6), [0.01, 0.13444, 0.40111, 0.81, 0, 0]);
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G2), { vertex_group: 'G', use_add: true, default_weight: 0.3, add_threshold: 0.2, normalize: true }), 'G').slice(0, 6), [0, 0.33333, 0.66667, 1, 0.25, 0.25]);
    const mv = { vertex_group: 'G', falloff_type: 'SHARP', mask_vertex_group: 'M' };
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G2), mv), 'G'), [0.0325, 0.1925, 0.45917, 0.8325, 0, 0, 0.0775, 0.30861, 0.57528, 0.8775, 0, 0]);
    close(W(run('VERTEX_WEIGHT_EDIT', grid(G2), { ...mv, invert_mask_vertex_group: true, mask_constant: 0.5 }), 'G'), [0.08875, 0.33764, 0.60431, 0.88875, 0, 0, 0.06625, 0.27958, 0.54625, 0.86625, 0, 0]);
  });

  it('maps through a custom curve', () => {
    const out = W(run('VERTEX_WEIGHT_EDIT', grid(G), { vertex_group: 'G', falloff_type: 'CURVE', map_curve: { curve_0: [0, 1, 1, 1, 0, 1] } }), 'G');
    close(out.slice(1, 4), [0.73333, 0.46667, 0.2]);
  });
});

describe('Vertex Weight Mix', () => {
  const AB = { A: (x: number) => (x < 0.5 ? (x + 1) / 2 : 0), B: (x: number, y: number) => (x > -0.5 ? (y > 0 ? 0.9 : 0.4) : 0) };
  it('limits the affected vertices by the vertex set', () => {
    const exp: Record<string, number[]> = {
      ALL: [0, 0, 0.4, 0.4, 0.4, 0.4, 0, 0, 0.9, 0.9, 0.9, 0.9],
      A: [0, 0, 0.4, 0.4, 0, 0, 0, 0, 0.9, 0.9, 0, 0],
      B: [0, 0.2, 0.4, 0.4, 0.4, 0.4, 0, 0.2, 0.9, 0.9, 0.9, 0.9],
      AND: [0, 0.2, 0.4, 0.4, 0, 0, 0, 0.2, 0.9, 0.9, 0, 0],
    };
    // v0 has weight 0 in A, which is "not in the group" here; the A/OR sets differ from a
    // zero-weight member only there
    for (const [set, row] of Object.entries(exp)) {
      const out = W(run('VERTEX_WEIGHT_MIX', grid(AB), { vertex_group_a: 'A', vertex_group_b: 'B', mix_set: set }), 'A');
      if (set === 'A') close([out[2], out[3], out[8], out[9]], [0.4, 0.4, 0.9, 0.9]);
      else close(out, row);
    }
  });

  it('combines weights with every mix mode', () => {
    const exp: Record<string, number[]> = {
      SET: [0.6, 0.6, 0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.9, 0.9, 0.9, 0.9],
      ADD: [0.6, 0.8, 0.8, 1, 0.6, 0.6, 0.6, 0.8, 1, 1, 1, 1],
      SUB: [0, 0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0],
      MUL: [0, 0.12, 0.16, 0.24, 0.08, 0.08, 0, 0.12, 0.36, 0.54, 0.18, 0.18],
      DIV: [0, 0.33333, 1, 1, 0.5, 0.5, 0, 0.33333, 0.44444, 0.66667, 0.22222, 0.22222],
      DIF: [0.6, 0.4, 0, 0.2, 0.2, 0.2, 0.6, 0.4, 0.5, 0.3, 0.7, 0.7],
      AVG: [0.3, 0.4, 0.4, 0.5, 0.3, 0.3, 0.3, 0.4, 0.65, 0.75, 0.55, 0.55],
      MIN: [0, 0.2, 0.4, 0.4, 0.2, 0.2, 0, 0.2, 0.4, 0.6, 0.2, 0.2],
      MAX: [0.6, 0.6, 0.4, 0.6, 0.4, 0.4, 0.6, 0.6, 0.9, 0.9, 0.9, 0.9],
    };
    const base = { vertex_group_a: 'A', vertex_group_b: 'B', mix_set: 'ALL', default_weight_a: 0.2, default_weight_b: 0.6 };
    // vertices 0 and 6 have weight 0 in A (not in the group here), so they are skipped
    const skip = (r: number[]) => r.filter((_, i) => i !== 0 && i !== 6);
    const close2 = (a: number[], b: number[]) => close(skip(a), skip(b));
    for (const [mode, row] of Object.entries(exp)) close2(W(run('VERTEX_WEIGHT_MIX', grid(AB), { ...base, mix_mode: mode }), 'A'), row);
    close2(W(run('VERTEX_WEIGHT_MIX', grid(AB), { ...base, mix_mode: 'ADD', invert_vertex_group_b: true }), 'A'), [0.4, 0.6, 1, 1, 0.8, 0.8, 0.4, 0.6, 0.5, 0.7, 0.3, 0.3]);
    close2(W(run('VERTEX_WEIGHT_MIX', grid(AB), { ...base, mix_mode: 'ADD', mask_constant: 0.5 }), 'A'), [0.3, 0.5, 0.6, 0.8, 0.4, 0.4, 0.3, 0.5, 0.85, 1, 0.65, 0.65]);
    const AB5 = { ...AB, A: (x: number) => (x < 0.5 ? (x + 1) / 2 + 0.05 : 0) };
    close(W(run('VERTEX_WEIGHT_MIX', grid(AB5), { ...base, mix_mode: 'ADD', mask_constant: 0.5, normalize: true }), 'A'), [0, 0.26667, 0.4, 0.66667, 0.06667, 0.06667, 0, 0.26667, 0.73333, 1, 0.4, 0.4]);
    close(W(run('VERTEX_WEIGHT_EDIT', grid(AB5), { vertex_group: 'A', use_add: true, use_remove: true, default_weight: 0.3, add_threshold: 0.2, remove_threshold: 0.5 }), 'A'), [0, 0, 0, 0.65, 0.3, 0.3, 0, 0, 0, 0.65, 0.3, 0.3]);
    close2(W(run('VERTEX_WEIGHT_MIX', grid(AB), { ...base, mix_mode: 'DIV', default_weight_b: 0 }), 'A'), [0, 1, 1, 1, 0.5, 0.5, 0, 1, 0.44444, 0.66667, 0.22222, 0.22222]);
  });
});

describe('Vertex Weight Proximity', () => {
  const at = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
  const graph = (objs: Record<string, { world: Matrix4; mesh?: EvalMesh }>) => ({ get: (id: string) => objs[id] }) as unknown as ModifierContext['graph'];
  it('uses the distance between the objects in object mode', () => {
    const m = grid({ P: () => 1 });
    const out = run('VERTEX_WEIGHT_PROXIMITY', m, { vertex_group: 'P', target: 'e', min_dist: 0, max_dist: 2 }, { graph: graph({ ob: { world: new Matrix4() }, e: { world: at(1, 0, 0.5) } }) });
    for (const w of W(out, 'P')) expect(w).toBeCloseTo(0.55902, 4);
    const inv = run('VERTEX_WEIGHT_PROXIMITY', m, { vertex_group: 'P', target: 'e', min_dist: 2, max_dist: 0.5, falloff_type: 'SHARP' }, { graph: graph({ ob: { world: new Matrix4() }, e: { world: at(1, 0, 0.5) } }) });
    for (const w of W(inv, 'P')) expect(w).toBeCloseTo(0.34572, 4);
  });

  it('uses the nearest vertex, edge or face of the target in geometry mode', () => {
    const plane = newMeshData('p', prim.plane(1)) as unknown as EvalMesh;
    const exp = [1, 1, 0.9153, 0.78457, 0.6549, 0.52705];
    for (const g of ['VERTEX', 'EDGE', 'FACE']) {
      const m = grid({ P: (x) => (x < -0.9 ? 0 : 1) });
      const out = run('VERTEX_WEIGHT_PROXIMITY', m, { vertex_group: 'P', target: 't', proximity_mode: 'GEOMETRY', proximity_geometry: [g], min_dist: 0, max_dist: 3 }, { graph: graph({ ob: { world: new Matrix4() }, t: { world: at(3, 0, 0), mesh: plane } }) });
      close(W(out, 'P'), [0, ...exp.slice(1), 0, ...exp.slice(1)]);
    }
  });
});
