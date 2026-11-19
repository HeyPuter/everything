// Stored adjustment layers keep a loosely typed `AdjustmentSpec`; this
// normalizes it against the engine's defaults into a typed Adjustment (and
// back). Pure: used by the renderer hook, the editors and the PSD codec.
import { ADJUSTMENT_KINDS, curveFunction, defaultParams, type Adjustment, type AdjustmentKind } from '../../imaging/adjust';
import type { AdjustmentSpec } from '../../model/document';
import { normalizeRelight } from '../../imaging/relight/model';

export const isAdjustmentKind = (k: unknown): k is AdjustmentKind => typeof k === 'string' && (ADJUSTMENT_KINDS as string[]).includes(k);

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

// Missing or mistyped fields fall back to the defaults so older or foreign
// files never crash the engine; unknown extra fields are dropped.
function merge(def: unknown, value: unknown): unknown {
  if (plain(def)) {
    const out: Record<string, unknown> = {};
    const v = plain(value) ? value : {};
    for (const k of Object.keys(def)) out[k] = merge(def[k], v[k]);
    return out;
  }
  if (Array.isArray(def)) return Array.isArray(value) ? structuredClone(value) : structuredClone(def);
  if (def === null) return value === undefined ? null : structuredClone(value);
  if (def === undefined) return value === undefined ? undefined : structuredClone(value);
  return typeof value === typeof def ? value : def;
}

/** Typed adjustment for a stored spec, or undefined for unknown kinds. */
export function specAdjustment(spec: AdjustmentSpec | undefined): Adjustment | undefined {
  if (!spec || !isAdjustmentKind(spec.kind)) return undefined;
  // Lights are a list of records: each is checked and clamped.
  if (spec.kind === 'relight') return { kind: 'relight', params: normalizeRelight(spec.params) };
  const def = defaultParams(spec.kind) as unknown as Record<string, unknown>;
  const params = merge(def, spec.params) as Record<string, unknown>;
  // Optional fields that have no default.
  const raw = plain(spec.params) ? spec.params : {};
  if (spec.kind === 'color-lookup') params.source = plain(raw.source) ? structuredClone(raw.source) : null;
  if (spec.kind === 'curves')
    for (const k of ['rgb', 'r', 'g', 'b']) {
      const ch = (raw as Record<string, Record<string, unknown> | undefined>)[k];
      if (Array.isArray(ch?.values)) (params[k] as Record<string, unknown>).values = [...(ch.values as number[])];
    }
  if (spec.kind === 'gradient-map') {
    const g = (raw as { gradient?: { stops?: unknown; opacityStops?: unknown } }).gradient;
    if (!Array.isArray(g?.stops) || !g.stops.length) (params as { gradient: unknown }).gradient = structuredClone(def.gradient);
    else if (Array.isArray(g.opacityStops)) (params.gradient as Record<string, unknown>).opacityStops = structuredClone(g.opacityStops);
  }
  return { kind: spec.kind, params } as Adjustment;
}

export const adjustmentSpec = (adj: Adjustment): AdjustmentSpec => ({ kind: adj.kind, params: structuredClone(adj.params) as unknown as Record<string, unknown> });

/** Point-mode curve approximating free-form pencil values: points are added
 * where the curve through the current points deviates most, until it stays
 * within 1.5 codes or 16 points are used. */
export function valuesToPoints(values: readonly number[]): [number, number][] {
  const clampByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const pts: [number, number][] = [
    [0, clampByte(values[0])],
    [255, clampByte(values[255])],
  ];
  while (pts.length < 16) {
    const f = curveFunction({ mode: 'points', points: pts });
    let worst = -1,
      err = 1.5;
    for (let x = 1; x < 255; x++) {
      const d = Math.abs(f(x / 255) * 255 - values[x]);
      if (d > err && !pts.some((q) => Math.abs(q[0] - x) < 3)) (err = d), (worst = x);
    }
    if (worst < 0) break;
    pts.push([worst, clampByte(values[worst])]);
    pts.sort((a, b) => a[0] - b[0]);
  }
  return pts;
}
