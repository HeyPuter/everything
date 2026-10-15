// Vertex weight modifiers: Edit (remap one group), Mix (combine two groups) and Proximity
// (weights from the distance to another object).
import { Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, defaultMapCurve, finishWeights, groupIndex, mapFalloff, num, objId, str, weightMask, withGroupWeights, worldOf } from './common';
import { EdgeQuery, PointQuery, SurfaceQuery, transformedPositions } from './spatial';

const maskDefaults = () => ({
  mask_constant: 1,
  mask_vertex_group: '',
  invert_mask_vertex_group: false,
  mask_texture: null,
  mask_tex_use_channel: 'INT',
  mask_tex_mapping: 'LOCAL',
  mask_tex_uv_layer: '',
  mask_tex_map_object: null,
  mask_tex_map_bone: '',
});

/** Simple seed from the object name so random falloffs differ per object but stay stable. */
function nameSeed(ctx: ModifierContext): number {
  const s = ctx.ob?.name ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export function weightEdit(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const gi = groupIndex(m, str(mod, 'vertex_group'));
  if (gi < 0 || !m.weights) return m;
  const src = m.weights[gi];
  const nv = m.positions.length / 3;
  const def = num(mod, 'default_weight', 0);
  const org = new Float32Array(nv);
  for (let i = 0; i < nv; i++) org[i] = src[i] > 0 ? src[i] : def;
  const nw = org.slice();
  mapFalloff(nw, str(mod, 'falloff_type', 'LINEAR'), bool(mod, 'invert_falloff'), mod.map_curve, nameSeed(ctx));
  finishWeights(org, nw, weightMask(m, mod, ctx), bool(mod, 'normalize'));
  const add = bool(mod, 'use_add'),
    rem = bool(mod, 'use_remove');
  const addT = num(mod, 'add_threshold', 0.01),
    remT = num(mod, 'remove_threshold', 0.01);
  const out = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const member = src[i] > 0;
    if (member) out[i] = rem && nw[i] < remT ? 0 : nw[i];
    else if (add && nw[i] > addT) out[i] = nw[i];
  }
  return withGroupWeights(m, gi, out);
}

function mix(a: number, b: number, mode: string): number {
  switch (mode) {
    case 'SET':
      return b;
    case 'ADD':
      return a + b;
    case 'SUB':
      return a - b;
    case 'MUL':
      return a * b;
    case 'DIV':
      return b !== 0 ? a / b : a > 0 ? 1 : 0;
    case 'DIF':
      return Math.abs(a - b);
    case 'AVG':
      return (a + b) / 2;
    case 'MIN':
      return Math.min(a, b);
    case 'MAX':
      return Math.max(a, b);
  }
  return a;
}

export function weightMix(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const ga = groupIndex(m, str(mod, 'vertex_group_a'));
  if (ga < 0 || !m.weights) return m;
  const gb = groupIndex(m, str(mod, 'vertex_group_b'));
  const A = m.weights[ga],
    B = gb >= 0 ? m.weights[gb] : null;
  const nv = m.positions.length / 3;
  const set = str(mod, 'mix_set', 'AND');
  const inSet = (i: number) => {
    const a = A[i] > 0,
      b = !!B && B[i] > 0;
    switch (set) {
      case 'ALL':
        return true;
      case 'A':
        return a;
      case 'B':
        return b;
      case 'OR':
        return a || b;
      default:
        return a && b;
    }
  };
  const members: number[] = [];
  for (let i = 0; i < nv; i++) if (inSet(i)) members.push(i);
  const da = num(mod, 'default_weight_a'),
    db = num(mod, 'default_weight_b');
  const invA = bool(mod, 'invert_vertex_group_a'),
    invB = bool(mod, 'invert_vertex_group_b');
  const mode = str(mod, 'mix_mode', 'SET');
  const org = new Float32Array(nv),
    nw = new Float32Array(nv);
  for (const i of members) {
    const a0 = A[i] > 0 ? A[i] : da;
    const b0 = B && B[i] > 0 ? B[i] : db;
    org[i] = a0;
    nw[i] = mix(invA ? 1 - a0 : a0, invB ? 1 - b0 : b0, mode);
  }
  finishWeights(org, nw, weightMask(m, mod, ctx), bool(mod, 'normalize'), members);
  const out = Float32Array.from(A);
  for (const i of members) out[i] = nw[i];
  return withGroupWeights(m, ga, out);
}

export function weightProximity(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const gi = groupIndex(m, str(mod, 'vertex_group'));
  const tid = objId(mod, 'target');
  const target = tid ? ctx.graph?.get(tid) : undefined;
  if (gi < 0 || !m.weights || !target) return m;
  const src = m.weights[gi];
  const nv = m.positions.length / 3;
  const members: number[] = [];
  for (let i = 0; i < nv; i++) if (src[i] > 0) members.push(i);
  const dist = new Float32Array(nv);
  const own = worldOf(ctx);
  if (str(mod, 'proximity_mode', 'OBJECT') === 'OBJECT') {
    const d = new Vector3().setFromMatrixPosition(own).distanceTo(new Vector3().setFromMatrixPosition(target.world));
    dist.fill(d);
  } else {
    const geo = (mod.proximity_geometry as string[] | undefined) ?? ['VERTEX'];
    const tm = target.mesh;
    if (!tm || !geo.length) return m;
    const TP = transformedPositions(tm.positions, target.world);
    const pq = geo.includes('VERTEX') ? new PointQuery(TP) : null;
    const eq = geo.includes('EDGE') ? new EdgeQuery(TP, tm) : null;
    const fq = geo.includes('FACE') && tm.offsets.length > 1 ? new SurfaceQuery(tm, target.world) : null;
    const p = new Vector3();
    for (const i of members) {
      p.fromArray(m.positions, i * 3).applyMatrix4(own);
      let d = Infinity;
      if (pq) d = Math.min(d, pq.nearest(p)?.dist ?? Infinity);
      if (eq) d = Math.min(d, eq.nearest(p)?.dist ?? Infinity);
      if (fq) d = Math.min(d, fq.nearest(p)?.distance ?? Infinity);
      dist[i] = d;
    }
  }
  const lo = num(mod, 'min_dist', 0),
    hi = num(mod, 'max_dist', 1);
  const org = Float32Array.from(src);
  const nw = new Float32Array(nv);
  for (const i of members) {
    if (hi === lo) nw[i] = dist[i] > lo ? 1 : 0;
    else nw[i] = Math.max(0, Math.min(1, (dist[i] - lo) / (hi - lo)));
  }
  mapFalloff(nw, str(mod, 'falloff_type', 'LINEAR'), bool(mod, 'invert_falloff'), mod.map_curve, nameSeed(ctx));
  finishWeights(org, nw, weightMask(m, mod, ctx), bool(mod, 'normalize'), members);
  const out = Float32Array.from(src);
  for (const i of members) out[i] = nw[i];
  return withGroupWeights(m, gi, out);
}

export const weightModifiers: ModifierType[] = [
  {
    type: 'VERTEX_WEIGHT_EDIT',
    label: 'Vertex Weight Edit',
    category: 'EDIT',
    icon: 'mod_vertex_weight',
    defaults: () => ({
      vertex_group: '',
      default_weight: 0,
      falloff_type: 'LINEAR',
      invert_falloff: false,
      map_curve: defaultMapCurve(),
      normalize: false,
      use_add: false,
      add_threshold: 0.01,
      use_remove: false,
      remove_threshold: 0.01,
      ...maskDefaults(),
    }),
    deps: (m) => [m.mask_tex_map_object as string],
    supportsEditMode: true,
    apply: weightEdit,
  },
  {
    type: 'VERTEX_WEIGHT_MIX',
    label: 'Vertex Weight Mix',
    category: 'EDIT',
    icon: 'mod_vertex_weight',
    defaults: () => ({
      vertex_group_a: '',
      vertex_group_b: '',
      invert_vertex_group_a: false,
      invert_vertex_group_b: false,
      default_weight_a: 0,
      default_weight_b: 0,
      mix_mode: 'SET',
      mix_set: 'AND',
      normalize: false,
      ...maskDefaults(),
    }),
    deps: (m) => [m.mask_tex_map_object as string],
    supportsEditMode: true,
    apply: weightMix,
  },
  {
    type: 'VERTEX_WEIGHT_PROXIMITY',
    label: 'Vertex Weight Proximity',
    category: 'EDIT',
    icon: 'mod_vertex_weight',
    defaults: () => ({
      vertex_group: '',
      target: null,
      proximity_mode: 'OBJECT',
      proximity_geometry: ['VERTEX'],
      min_dist: 0,
      max_dist: 1,
      falloff_type: 'LINEAR',
      invert_falloff: false,
      map_curve: defaultMapCurve(),
      normalize: false,
      ...maskDefaults(),
    }),
    deps: (m) => [m.target as string, m.mask_tex_map_object as string],
    supportsEditMode: true,
    apply: weightProximity,
  },
];

for (const t of weightModifiers) registerModifier(t);
