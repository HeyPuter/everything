// The filter catalog shared by the UI and the filter worker: both operation
// libraries, their menu placement and how far each neighborhood filter reaches.
// No DOM here; the worker and Node tests import it.
import { filtersA } from '../../imaging/filters/index-a';
import { filtersB } from '../../imaging/filters/index-b';
import { cleanPaths, cleanPins, type ImageOperation, type ParamSpec, type ParamValues } from '../../imaging/types';

export const allFilters: ImageOperation[] = [...filtersA, ...filtersB];
const byId = new Map(allFilters.map((op) => [op.id, op]));
export { GALLERY_ID, RESTORE_ID, renamedFilters, categorySlug, topLevelFilter, commandId, opIdFromCommand } from './menu';
import { GALLERY_ID, RESTORE_ID, renamedFilters } from './menu';
import { normalizeRestore } from '../../imaging/restore/defs';

/** Pseudo-operations that run stacks of their own (not in the menu catalog). */
export const isStackOp = (id: string) => id === GALLERY_ID || id === RESTORE_ID;
export function filterOp(id: string): ImageOperation | undefined {
  return byId.get(renamedFilters[id] ?? id);
}
const n = (p: ParamValues, k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0);
// Output pixels depend on inputs at most this far away (document pixels at
// scale 1), mirroring each operation's declared support. With a selection only
// its bounds grown by this margin are processed; filters missing here depend on
// absolute position or the whole image and always receive the full canvas.
const margins: Record<string, (p: ParamValues) => number> = {
  'gaussian-blur': (p) => 3 * n(p, 'radius') + 3,
  'box-blur': (p) => n(p, 'radius') + 1,
  blur: () => 1,
  'blur-more': () => 2,
  'motion-blur': (p) => n(p, 'distance') / 2 + 2,
  'edge-preserving-blur': (p) => 3 * n(p, 'radius') + 8,
  'surface-blur': (p) => 3 * n(p, 'radius') + 8,
  'lens-blur': (p) => 1.2 * n(p, 'radius') + 8,
  despeckle: () => 3,
  'dust-and-scratches': (p) => n(p, 'radius') + 1,
  median: (p) => n(p, 'radius') + 1,
  denoise: (p) => (p.quality === 'high' ? 6 : 4) + 2 + 24 + 4,
  'sharpen-details': (p) => (n(p, 'radius') * 3 + 2) * Math.min(4, Math.ceil(n(p, 'iterations') / 4)) + 4,
  'reduce-noise': (p) => 3 * (0.6 + n(p, 'strength') * 0.25) + 12 * (n(p, 'color') / 100) + 11,
  'high-pass': (p) => 3 * n(p, 'radius') + 3,
  maximum: (p) => n(p, 'radius') + 1,
  minimum: (p) => n(p, 'radius') + 1,
  custom: () => 2,
  sharpen: () => 1,
  'sharpen-more': () => 1,
  'sharpen-edges': () => 6,
  'advanced-sharpen': (p) => 3 * n(p, 'radius') + 4,
  'unsharp-mask': (p) => 3 * n(p, 'radius') + 3,
  emboss: (p) => n(p, 'height') / 2 + 2,
  'find-edges': () => 1,
  solarize: () => 0,
  'broadcast-safe': () => 0,
  'trace-contour': () => 1,
  'oil-paint': (p) => (n(p, 'cleanliness') * 1.05 + 2 * (1 + n(p, 'stylization') * 1.2) + 2) * n(p, 'scale') + 4,
  'glowing-edges': (p) => n(p, 'smoothness') * 0.9 + n(p, 'width') + 4,
  'shape-blur': (p) => n(p, 'radius') + 1,
  'hsb-hsl': () => 0,
};
/** Reach of one filter in pixels at `scale`, or undefined when it is not local. */
export function filterMargin(id: string, params: ParamValues, scale = 1): number | undefined {
  const m = margins[renamedFilters[id] ?? id];
  return m ? Math.ceil(m(params) * scale) + 1 : undefined;
}
export type MarginEntry = { id: string; params: ParamValues; enabled?: boolean };
/** Combined reach of a filter stack (margins add up), undefined if any is global. */
export function stackMargin(entries: MarginEntry[], scale = 1): number | undefined {
  let total = 0;
  for (const e of entries) {
    if (e.enabled === false) continue;
    if (e.id === GALLERY_ID) {
      const inner = stackMargin(galleryEffects(e.params), scale);
      if (inner === undefined) return undefined;
      total += inner;
      continue;
    }
    const m = filterMargin(e.id, e.params, scale);
    if (m === undefined) return undefined;
    total += m;
  }
  return total;
}

export type GalleryEffect = { id: string; params: ParamValues; enabled: boolean };
export function galleryEffects(params: ParamValues): GalleryEffect[] {
  const list = (params as unknown as { effects?: unknown }).effects;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is GalleryEffect => !!x && typeof x === 'object' && typeof (x as GalleryEffect).id === 'string' && !!filterOp((x as GalleryEffect).id))
    .map((x) => ({ id: x.id, params: normalizeParams(filterOp(x.id)!.params, x.params ?? {}), enabled: x.enabled !== false }));
}
// The gallery offers the texture-like effects of these groups.
export const galleryGroups: { label: string; ids: string[] }[] = [
  { label: 'Stylize', ids: ['diffuse', 'emboss', 'extrude', 'find-edges', 'glowing-edges', 'oil-paint', 'solarize', 'tiles', 'trace-contour', 'wind'] },
  { label: 'Pixelate', ids: ['color-halftone', 'crystallize', 'facet', 'fragment', 'mezzotint', 'mosaic', 'pointillize'] },
  { label: 'Distort', ids: ['glass', 'ocean-ripple', 'ripple', 'pinch', 'spherize', 'twirl', 'wave', 'zigzag'] },
  { label: 'Noise', ids: ['add-noise', 'dust-and-scratches', 'median', 'reduce-noise'] },
];

/** Defaults overlaid with the valid values of `params` (numbers clamped, unknown
 * keys dropped), so recorded or saved settings can never crash an operation. */
export function normalizeParams(specs: ParamSpec[], params: Record<string, unknown>): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    const v = params?.[s.key];
    switch (s.type) {
      case 'number':
        out[s.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
        break;
      case 'select':
        out[s.key] = typeof v === 'string' && s.options.some((o) => o.value === v) ? v : s.default;
        break;
      case 'checkbox':
        out[s.key] = typeof v === 'boolean' ? v : s.default;
        break;
      case 'color':
        out[s.key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : s.default;
        break;
      case 'point': {
        const pt = v as { x?: unknown; y?: unknown } | undefined;
        out[s.key] =
          pt && typeof pt.x === 'number' && typeof pt.y === 'number' && Number.isFinite(pt.x) && Number.isFinite(pt.y)
            ? { x: Math.min(1, Math.max(0, pt.x)), y: Math.min(1, Math.max(0, pt.y)) }
            : { ...s.default };
        break;
      }
      case 'pins':
        out[s.key] = cleanPins(s, v);
        break;
      case 'paths':
        out[s.key] = cleanPaths(s, v);
        break;
    }
  }
  return out;
}
/** Params for an operation ID, including the gallery's effect list and the
 * Portrait & Restore stack. */
export function normalizeFor(id: string, params: Record<string, unknown>): ParamValues {
  if (id === GALLERY_ID) return { effects: galleryEffects(params as ParamValues) } as unknown as ParamValues;
  if (id === RESTORE_ID) return normalizeRestore(params) as unknown as ParamValues;
  const op = filterOp(id);
  return op ? normalizeParams(op.params, params) : {};
}
