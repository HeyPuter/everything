// GPU compilation of adjustment layers for the compositor's LUT pass, and
// layer naming.
import { ADJUSTMENT_LABELS, clarityDehazeAmounts, compileAdjustment, grainAmounts, isIdentityAdjustment, type AdjustmentKind } from '../../imaging/adjust';
import type { SpatialFilter } from '../../renderer/spatial-pass';
import type { AdjustmentSpec, Layer } from '../../model/document';
import { curveEntries, type CompiledLut } from '../../renderer/lut-shaders';
import { specAdjustment } from './spec';
export { adjustmentSpec, isAdjustmentKind, specAdjustment } from './spec';

function sample(t: Float32Array, x: number) {
  const p = (x <= 0 ? 0 : x >= 1 ? 1 : x) * (t.length - 1),
    i = p >= t.length - 1 ? t.length - 2 : p | 0;
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

/** Renderer hook: compile a layer's adjustment for the LUT pass. The engine's
 * composite curve runs before the per-channel curves; the shader has one
 * per-channel row, so the two are composed here. */
export function compileSpec(spec: AdjustmentSpec): CompiledLut | null {
  const adj = specAdjustment(spec);
  if (!adj) return null;
  const c = compileAdjustment(adj, { postCurves: true, lutSize: 33, curveSize: 4096 });
  const out: CompiledLut = {};
  if (c.curves) {
    const { rgb, r, g, b } = c.curves;
    const comp = (t: Float32Array) => Float32Array.from({ length: curveEntries }, (_, i) => sample(t, sample(rgb, i / (curveEntries - 1))));
    out.curves = { r: comp(r), g: comp(g), b: comp(b) };
  }
  if (c.lut3d) out.lut3d = c.lut3d;
  if (c.postCurves) out.postCurves = c.postCurves;
  return out.curves || out.lut3d ? out : null;
}

/** Renderer hook: filter passes for the spatial kinds (null for the others
 * and for settings that change nothing). */
export function compileSpatial(spec: AdjustmentSpec): SpatialFilter | null {
  // Called every frame for every adjustment layer: skip the normalization
  // (which copies payloads such as LUT files) for the color kinds.
  if (spec?.kind !== 'clarity-dehaze' && spec?.kind !== 'grain') return null;
  const adj = specAdjustment(spec);
  if (!adj || isIdentityAdjustment(adj)) return null;
  if (adj.kind === 'clarity-dehaze') return { type: 'clarity-dehaze', ...clarityDehazeAmounts(adj.params) };
  if (adj.kind === 'grain') {
    const g = grainAmounts(adj.params);
    return { type: 'grain', strength: g.strength, cell: g.cell, roughness: g.roughness, color: g.color };
  }
  return null;
}

/** "Levels 1", "Levels 2"... unique among existing layer names. */
export function adjustmentLayerName(kind: AdjustmentKind, names: Iterable<string>) {
  const taken = new Set(names);
  let n = 1;
  while (taken.has(`${ADJUSTMENT_LABELS[kind]} ${n}`)) n++;
  return `${ADJUSTMENT_LABELS[kind]} ${n}`;
}

export const layerAdjustment = (l: Layer | undefined) => (l?.kind === 'adjustment' ? specAdjustment(l.adjustment) : undefined);
