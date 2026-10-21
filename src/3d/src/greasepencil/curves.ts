// Spline types of Grease Pencil strokes: a stroke is a poly line (the default), a Bézier curve
// (control points with left / right handles), a NURBS curve or a Catmull-Rom spline. Drawings keep
// the control points; `evaluatedDrawing` turns smooth strokes into the poly lines that are drawn,
// filled and fed to modifiers (radius, opacity, colors and weights are interpolated).
// Pure document logic (no DOM / WebGL), unit tested.
import { CurvesComponent, type AttrMap } from '../geonodes/geometry';
import { evaluateCurves, recalcHandles, setCurveAttr, setPointAttr } from '../geonodes/curves/curvedata';
import type { GPDrawing } from './types';

export const GP_CATMULL_ROM = 0,
  GP_POLY = 1,
  GP_BEZIER = 2,
  GP_NURBS = 3;
export const CURVE_TYPE_NAMES = ['CATMULL_ROM', 'POLY', 'BEZIER', 'NURBS'] as const;
export type GPCurveTypeName = (typeof CURVE_TYPE_NAMES)[number];

export const H_FREE = 0,
  H_AUTO = 1,
  H_VECTOR = 2,
  H_ALIGN = 3;
export const HANDLE_TYPE_NAMES = ['FREE', 'AUTO', 'VECTOR', 'ALIGN'] as const;

export const DEFAULT_RES = 12;
export const KNOTS_NORMAL = 0,
  KNOTS_ENDPOINT = 1,
  KNOTS_BEZIER = 2,
  KNOTS_ENDPOINT_BEZIER = 3;

export const strokeCurveType = (d: GPDrawing, s: number) => (d.curve_type && d.curve_type.length > s ? d.curve_type[s] : GP_POLY);

/** True when some stroke of the drawing is not a poly line. */
export function hasSmoothStrokes(d: GPDrawing): boolean {
  const t = d.curve_type;
  if (!t) return false;
  for (let i = 0; i < t.length; i++) if (t[i] !== GP_POLY) return true;
  return false;
}

export function hasBezier(d: GPDrawing): boolean {
  const t = d.curve_type;
  if (!t) return false;
  for (let i = 0; i < t.length; i++) if (t[i] === GP_BEZIER) return true;
  return false;
}

// ---------------------------------------------------------------------------
// handles

/**
 * Make the handle arrays of a drawing complete (allocated, right length) when it has Bézier
 * strokes; missing handles become auto handles. Mutates `d` (assign fresh arrays only).
 */
export function ensureHandles(d: GPDrawing) {
  const n = d.position.length / 3;
  if (!hasBezier(d)) return;
  const ok = (a: { length: number } | undefined, len: number) => !!a && a.length === len;
  if (!ok(d.handle_type_left, n) || !ok(d.handle_type_right, n) || !ok(d.handle_left, n * 3) || !ok(d.handle_right, n * 3)) {
    d.handle_left = d.position.slice();
    d.handle_right = d.position.slice();
    d.handle_type_left = new Uint8Array(n).fill(H_AUTO);
    d.handle_type_right = new Uint8Array(n).fill(H_AUTO);
    deriveHandles(d);
  }
  if (!ok(d.select_handle_left, n)) d.select_handle_left = new Uint8Array(n);
  if (!ok(d.select_handle_right, n)) d.select_handle_right = new Uint8Array(n);
}

/**
 * Recompute derived handles in place (auto and vector from the neighbouring points, aligned ones
 * opposite the other handle of their point). The handle arrays must be owned by the caller.
 */
export function deriveHandles(d: GPDrawing) {
  if (!hasBezier(d) || !d.handle_left || !d.handle_right || !d.handle_type_left || !d.handle_type_right) return;
  const types = Int32Array.from(d.curve_type!);
  const tl = Int32Array.from(d.handle_type_left),
    tr = Int32Array.from(d.handle_type_right);
  recalcHandles(d.position, d.offsets, d.cyclic, types, d.handle_left, d.handle_right, tl, tr);
}

/** A copy of the drawing with fresh handle arrays and derived handles recomputed. */
export function withDerived(d: GPDrawing): GPDrawing {
  if (!hasBezier(d)) return d;
  const out: GPDrawing = { ...d };
  ensureHandles(out);
  out.handle_left = out.handle_left!.slice();
  out.handle_right = out.handle_right!.slice();
  deriveHandles(out);
  return out;
}

// ---------------------------------------------------------------------------
// evaluation

/** Curves component of a drawing's control points (attributes that evaluation interpolates). */
export function drawingComponent(d: GPDrawing): CurvesComponent {
  const attrs: AttrMap = new Map();
  const np = d.position.length / 3,
    nc = d.offsets.length - 1;
  if (d.curve_type?.length === nc) setCurveAttr(attrs, 'curve_type', 'INT8', Int32Array.from(d.curve_type));
  if (d.resolution?.length === nc) setCurveAttr(attrs, 'resolution', 'INT', Int32Array.from(d.resolution, (r) => Math.max(1, r)));
  if (d.nurbs_order?.length === nc) setCurveAttr(attrs, 'nurbs_order', 'INT8', Int32Array.from(d.nurbs_order));
  if (d.knots_mode?.length === nc) setCurveAttr(attrs, 'knots_mode', 'INT8', Int32Array.from(d.knots_mode));
  if (hasBezier(d)) {
    const h = withDerived(d);
    setPointAttr(attrs, 'handle_left', 'FLOAT_VECTOR', h.handle_left!);
    setPointAttr(attrs, 'handle_right', 'FLOAT_VECTOR', h.handle_right!);
    setPointAttr(attrs, 'handle_type_left', 'INT8', Int32Array.from(h.handle_type_left!));
    setPointAttr(attrs, 'handle_type_right', 'INT8', Int32Array.from(h.handle_type_right!));
  }
  setPointAttr(attrs, 'radius', 'FLOAT', d.radius.length === np ? d.radius : new Float32Array(np).fill(0.01));
  if (d.opacity.length === np) setPointAttr(attrs, 'opacity', 'FLOAT', d.opacity);
  if (d.vertex_color.length === np * 4) setPointAttr(attrs, 'vertex_color', 'FLOAT_COLOR', d.vertex_color);
  if (d.miter_angle?.length === np) setPointAttr(attrs, '#miter', 'FLOAT', d.miter_angle);
  if (d.weights) for (const [k, w] of Object.entries(d.weights)) if (w.length === np) setPointAttr(attrs, `#w:${k}`, 'FLOAT', w);
  return new CurvesComponent(d.position, d.offsets, d.cyclic, attrs);
}

const evalCache = new WeakMap<GPDrawing, { keys: unknown[]; out: GPDrawing; controlIndex: Int32Array }>();

const evalKeys = (d: GPDrawing) => [d.position, d.offsets, d.radius, d.opacity, d.vertex_color, d.curve_type, d.resolution, d.nurbs_order, d.knots_mode, d.handle_left, d.handle_right, d.handle_type_left, d.handle_type_right, d.cyclic, d.miter_angle, d.weights];

/** Per stroke arrays copied unchanged to the evaluated drawing. */
const CURVE_DOMAIN: (keyof GPDrawing)[] = ['cyclic', 'material_index', 'start_cap', 'end_cap', 'fill_color', 'fill_opacity', 'fill_id', 'stroke_type', 'uv_translation', 'uv_rotation', 'uv_scale', 'is_fill_guide'];

function evaluate(d: GPDrawing): { out: GPDrawing; controlIndex: Int32Array } {
  const ev = evaluateCurves(drawingComponent(d));
  const c = ev.curves;
  const np = c.pointCount;
  const get = (name: string) => c.attrs.get(name)?.data as Float32Array | undefined;
  const out: GPDrawing = {
    position: c.positions,
    radius: get('radius') ?? new Float32Array(np).fill(0.01),
    opacity: get('opacity') ?? new Float32Array(np).fill(1),
    vertex_color: get('vertex_color') ?? new Float32Array(np * 4),
    select: new Uint8Array(np),
    offsets: c.curveOffsets,
  } as GPDrawing;
  for (const k of CURVE_DOMAIN) if (d[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = d[k];
  const m = get('#miter');
  if (m) out.miter_angle = m;
  if (d.weights) {
    out.weights = {};
    for (const k of Object.keys(d.weights)) {
      const w = get(`#w:${k}`);
      if (w) out.weights[k] = w;
    }
  }
  return { out, controlIndex: ev.controlIndex };
}

function cached(d: GPDrawing) {
  const keys = evalKeys(d);
  const hit = evalCache.get(d);
  if (hit && hit.keys.every((k, i) => k === keys[i])) return hit;
  const r = { keys, ...evaluate(d) };
  evalCache.set(d, r);
  return r;
}

/** The poly lines a drawing shows (the drawing itself when every stroke is a poly line). */
export function evaluatedDrawing(d: GPDrawing): GPDrawing {
  if (!hasSmoothStrokes(d)) return d;
  return cached(d).out;
}

/** Evaluated point index of each control point (-1 when no evaluated point matches it). */
export function evaluatedControlIndex(d: GPDrawing): Int32Array | null {
  if (!hasSmoothStrokes(d)) return null;
  return cached(d).controlIndex;
}
