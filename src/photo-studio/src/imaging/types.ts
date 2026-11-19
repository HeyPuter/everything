// Shared pixel containers for the imaging modules (filters, adjustments,
// retouching, codecs, effects, text). They are plain typed arrays so every
// module runs unchanged on the main thread, in a worker and under Node tests.
//
// Color samples are straight (unassociated) RGBA in the document's encoded
// color space; alpha is coverage. Rows are top to bottom with no padding,
// exactly like ImageData, so `new ImageData(buf.data, buf.width)` works.
export type RGBA8 = { width: number; height: number; data: Uint8ClampedArray };
// Single-channel coverage (selections, masks, alpha channels): 0 = none, 255 = full.
export type Mask8 = { width: number; height: number; data: Uint8Array };
// Float RGBA for high-precision intermediates (32-bit documents, HDR math).
export type RGBAF = { width: number; height: number; data: Float32Array };
export type IRect = { x: number; y: number; width: number; height: number };
// Long operations report progress in [0, 1] and poll `cancelled` between rows
// or iterations so the UI can stay responsive and abort them.
export type Progress = { report?: (fraction: number) => void; cancelled?: () => boolean };

export function rgba8(width: number, height: number, fill?: [number, number, number, number]): RGBA8 {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill && fill.some((v) => v !== 0))
    for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}
export function mask8(width: number, height: number, value = 0): Mask8 {
  const data = new Uint8Array(width * height);
  if (value) data.fill(value);
  return { width, height, data };
}
export function cloneRGBA8(src: RGBA8): RGBA8 {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}
export class CancelledError extends Error {
  constructor() {
    super('The operation was cancelled.');
    this.name = 'CancelledError';
  }
}
export function checkCancelled(progress?: Progress) {
  if (progress?.cancelled?.()) throw new CancelledError();
}

// Declarative parameters let the UI build dialogs, presets, recorded actions
// and Live Filter settings from one description of each operation.
export type ParamSpec =
  | { key: string; label: string; type: 'number'; min: number; max: number; step?: number; default: number; unit?: string }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; default: string }
  | { key: string; label: string; type: 'checkbox'; default: boolean }
  | { key: string; label: string; type: 'color'; default: string }
  // Normalized position in the image, x and y in [0, 1].
  | { key: string; label: string; type: 'point'; default: { x: number; y: number } }
  // Movable pins, each with a value in [min, max] (Field Blur amounts).
  | { key: string; label: string; type: 'pins'; min: number; max: number; unit?: string; default: Pin[]; limit?: number }
  // Freehand polylines in normalized coordinates (Path Blur, Flame).
  | { key: string; label: string; type: 'paths'; default: NormPath[]; limit?: number };
// Pin and path coordinates are normalized to the image like `point`. A path
// point may carry a numeric tag `t` that a filter defines (a per-path flag).
export type Pin = { x: number; y: number; value: number };
export type NormPath = { x: number; y: number; t?: number }[];
export type ParamValues = Record<string, number | string | boolean | { x: number; y: number } | Pin[] | NormPath[]>;
export type OperationContext = {
  foreground: [number, number, number];
  background: [number, number, number];
  // Optional coverage of the active selection, same size as the source.
  selection?: Mask8;
  // Deterministic randomness for noise-like operations (Live Filters re-render).
  seed?: number;
  // Device pixels per document pixel of the source, for previews at reduced size:
  // radius-like parameters are multiplied by it so previews match full renders.
  scale?: number;
};
export interface ImageOperation {
  id: string;
  label: string;
  // Menu group, for example 'Blur', 'Distort' or 'Adjustments'.
  category: string;
  params: ParamSpec[];
  // True when the operation needs no dialog (for example Invert or Despeckle).
  immediate?: boolean;
  // Brings settings saved by an earlier version up to date (before normalizing).
  migrate?(params: Record<string, unknown>): Record<string, unknown>;
  apply(src: RGBA8, params: ParamValues, ctx: OperationContext, progress?: Progress): RGBA8 | Promise<RGBA8>;
}
export function defaults(op: Pick<ImageOperation, 'params'>): ParamValues {
  return Object.fromEntries(op.params.map((p) => [p.key, p.default]));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Valid pins of a `pins` parameter (coordinates and values clamped), or its default. */
export function cleanPins(spec: Extract<ParamSpec, { type: 'pins' }>, v: unknown): Pin[] {
  if (!Array.isArray(v)) return spec.default.map((p) => ({ ...p }));
  const out: Pin[] = [];
  for (const p of v.slice(0, spec.limit ?? 64)) {
    const q = p as Partial<Pin> | null;
    if (!q || ![q.x, q.y, q.value].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    out.push({ x: clamp01(q.x!), y: clamp01(q.y!), value: Math.min(spec.max, Math.max(spec.min, q.value!)) });
  }
  return out;
}
/** Valid polylines of a `paths` parameter (points clamped, empty paths dropped), or its default. */
export function cleanPaths(spec: Extract<ParamSpec, { type: 'paths' }>, v: unknown): NormPath[] {
  if (!Array.isArray(v)) return spec.default.map((path) => path.map((p) => ({ ...p })));
  const out: NormPath[] = [];
  for (const path of v.slice(0, spec.limit ?? 32)) {
    if (!Array.isArray(path)) continue;
    const pts: NormPath = [];
    for (const p of path.slice(0, 4096)) {
      const q = p as { x?: unknown; y?: unknown; t?: unknown } | null;
      if (q && typeof q.x === 'number' && typeof q.y === 'number' && Number.isFinite(q.x) && Number.isFinite(q.y))
        pts.push(typeof q.t === 'number' && Number.isFinite(q.t) ? { x: clamp01(q.x), y: clamp01(q.y), t: q.t } : { x: clamp01(q.x), y: clamp01(q.y) });
    }
    if (pts.length) out.push(pts);
  }
  return out;
}
