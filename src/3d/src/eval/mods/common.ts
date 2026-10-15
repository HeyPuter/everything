// Shared helpers for the modifier families in this directory: typed property readers, vertex
// group access, weight falloff mapping and influence masks.
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext } from '../types';
import { groupWeights } from '../meshbuild';
import { proceduralTexture } from '../textures';
import { evalCurve, type CurvePoint } from '../../nodes/curves';

export const num = (m: ModifierBase, k: string, d = 0) => (typeof m[k] === 'number' && Number.isFinite(m[k]) ? (m[k] as number) : d);
export const bool = (m: ModifierBase, k: string, d = false) => (typeof m[k] === 'boolean' ? (m[k] as boolean) : d);
export const str = (m: ModifierBase, k: string, d = '') => (typeof m[k] === 'string' ? (m[k] as string) : d);
export const vec = (m: ModifierBase, k: string, d: number[]) => (Array.isArray(m[k]) ? (m[k] as number[]) : d);
export const objId = (m: ModifierBase, k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : null);

/** Matrix taking a target object's local space into the modified object's local space. */
export function targetToLocal(ctx: ModifierContext, id: string | null): Matrix4 | null {
  if (!id || !ctx.graph) return null;
  const t = ctx.graph.get(id);
  const own = ctx.graph.get(ctx.ob.id);
  if (!t || !own) return null;
  return own.world.clone().invert().multiply(t.world);
}

export function worldOf(ctx: ModifierContext, id?: string): Matrix4 {
  return ctx.graph?.get(id ?? ctx.ob.id)?.world.clone() ?? new Matrix4();
}

/** Index of a vertex group by name in an evaluated mesh, or -1. */
export function groupIndex(m: EvalMesh, name: string): number {
  if (!name || !m.vertex_groups) return -1;
  return m.vertex_groups.findIndex((g) => g.name === name);
}

/** Per-vertex influence from an optional vertex group (1 when unset). */
export function vgroupFactor(m: EvalMesh, mod: ModifierBase, key = 'vertex_group', invertKey = 'invert_vertex_group'): Float32Array | null {
  const w = groupWeights(m, str(mod, key));
  if (!w) return null;
  if (!bool(mod, invertKey)) return w;
  const out = new Float32Array(w.length);
  for (let i = 0; i < w.length; i++) out[i] = 1 - w[i];
  return out;
}

/** Replace one vertex group's weights, returning a new mesh (other groups are shared). */
export function withGroupWeights(m: EvalMesh, gi: number, w: Float32Array): EvalMesh {
  const weights = (m.weights ?? []).slice();
  weights[gi] = w;
  return { ...m, weights };
}

// ---------------------------------------------------------------------------
// Falloff mapping (shared by the vertex weight modifiers)

export const FALLOFF_ITEMS: [string, string][] = [
  ['LINEAR', 'Linear'],
  ['CURVE', 'Custom Curve'],
  ['SHARP', 'Sharp'],
  ['SMOOTH', 'Smooth'],
  ['ROOT', 'Root'],
  ['ICON_SPHERECURVE', 'Sphere'],
  ['RANDOM', 'Random'],
  ['STEP', 'Median Step'],
];

/** Stable pseudo random value in [0, 1) for an integer key. */
export function hash01(i: number, seed = 0): number {
  let h = (Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed + 1, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}

export function curvePoints(c: unknown): CurvePoint[] | null {
  const flat = (c as Record<string, unknown> | null)?.curve_0;
  if (!Array.isArray(flat)) return null;
  const pts: CurvePoint[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) pts.push({ x: flat[i] as number, y: flat[i + 1] as number, handle: flat[i + 2] as number });
  return pts.sort((a, b) => a.x - b.x);
}

/** A 0..1 → 0..1 curve stored like the node editor's float curve (`curve_0` = [x, y, handle, …]). */
export function defaultMapCurve(): Record<string, unknown> {
  return { curve_kind: 'FLOAT', curve_extend: 'HORIZONTAL', curve_active: 0, curve_0: [0, 0, 0, 1, 1, 0] };
}

/** Map weights in place through a falloff type (and optional inversion). */
export function mapFalloff(w: Float32Array, type: string, invert: boolean, curve?: unknown, seed = 0) {
  const pts = type === 'CURVE' ? curvePoints(curve) : null;
  for (let i = 0; i < w.length; i++) {
    let x = w[i];
    switch (type) {
      case 'CURVE':
        x = pts ? evalCurve(pts, x) : x;
        break;
      case 'SHARP':
        x = x * x;
        break;
      case 'SMOOTH':
        x = 3 * x * x - 2 * x * x * x;
        break;
      case 'ROOT':
        x = Math.sqrt(Math.max(0, x));
        break;
      case 'ICON_SPHERECURVE':
        x = Math.sqrt(Math.max(0, 2 * x - x * x));
        break;
      case 'RANDOM':
        x = x * hash01(i, seed);
        break;
      case 'STEP':
        x = x >= 0.5 ? 1 : 0;
        break;
    }
    w[i] = invert ? 1 - x : x;
  }
}

/**
 * Influence mask for the vertex weight modifiers: a constant times an optional vertex group and
 * an optional texture. Returns null when the mask is the constant 1.
 */
export function weightMask(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): Float32Array | null {
  const nv = m.positions.length / 3;
  const k = num(mod, 'mask_constant', 1);
  const g = groupWeights(m, str(mod, 'mask_vertex_group'));
  const tex = mod.mask_texture as Record<string, unknown> | null | undefined;
  if (k === 1 && !g && !tex) return null;
  const out = new Float32Array(nv).fill(k);
  if (g) {
    const inv = bool(mod, 'invert_mask_vertex_group');
    for (let i = 0; i < nv; i++) out[i] *= inv ? 1 - (g[i] ?? 0) : g[i] ?? 0;
  }
  if (tex && typeof tex === 'object' && tex.type) {
    const coords = str(mod, 'mask_tex_mapping', 'LOCAL');
    const P = m.positions;
    const p = new Vector3();
    const world = coords === 'GLOBAL' ? worldOf(ctx) : null;
    const toObj = coords === 'OBJECT' ? targetToLocal(ctx, objId(mod, 'mask_tex_map_object'))?.invert() ?? null : null;
    for (let i = 0; i < nv; i++) {
      p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      if (world) p.applyMatrix4(world);
      else if (toObj) p.applyMatrix4(toObj);
      out[i] *= proceduralTexture(tex, p.x, p.y, p.z);
    }
  }
  return out;
}

/**
 * Final steps shared by the vertex weight modifiers: blend the new weights with the originals
 * by the mask, optionally normalize them to the full 0..1 range, then clamp.
 */
export function finishWeights(org: Float32Array, nw: Float32Array, mask: Float32Array | null, normalize: boolean, members?: ArrayLike<number>) {
  if (mask) for (let i = 0; i < nw.length; i++) nw[i] = org[i] + (nw[i] - org[i]) * mask[i];
  if (normalize) {
    let lo = Infinity,
      hi = -Infinity;
    const each = (fn: (i: number) => void) => {
      if (members) for (let k = 0; k < members.length; k++) fn(members[k]);
      else for (let i = 0; i < nw.length; i++) fn(i);
    };
    each((i) => {
      lo = Math.min(lo, nw[i]);
      hi = Math.max(hi, nw[i]);
    });
    if (hi > lo) each((i) => (nw[i] = (nw[i] - lo) / (hi - lo)));
  }
  for (let i = 0; i < nw.length; i++) nw[i] = Math.max(0, Math.min(1, nw[i]));
}
