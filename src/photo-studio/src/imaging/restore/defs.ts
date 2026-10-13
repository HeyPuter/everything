// The Portrait & Restore filters: names, groups, settings and the
// normalization of saved settings. No algorithms here (the dialog, recorded
// actions and Live Filters read it without loading them).
import type { ParamSpec, ParamValues } from '../types';
import { cleanStats, type TransferStats } from './transfer';
import type { Hint } from './colorize';

export type RestoreFilterId = 'jpeg' | 'restore' | 'skin' | 'colorize' | 'transfer' | 'depth' | 'style' | 'scene';
export type RestoreGroup = 'Portrait' | 'Restoration' | 'Color' | 'Creative';
export type RestoreFilterDef = {
  id: RestoreFilterId;
  label: string;
  group: RestoreGroup;
  description: string;
  params: ParamSpec[];
  // What the mask overlay shows for this filter, when it has one.
  overlay?: string;
};

const sel = (key: string, label: string, options: [string, string][], def: string): ParamSpec => ({ key, label, type: 'select', options: options.map(([value, l]) => ({ value, label: l })), default: def });
const numP = (key: string, label: string, min: number, max: number, def: number, unit?: string, step = 1): ParamSpec => ({ key, label, type: 'number', min, max, step, default: def, unit });
const check = (key: string, label: string, def: boolean): ParamSpec => ({ key, label, type: 'checkbox', default: def });

export const SCENE_PRESETS: { id: string; label: string; group: string; prompt: string }[] = [
  { id: 'golden-hour', label: 'Golden hour', group: 'Time of day', prompt: 'the same scene at golden hour shortly before sunset, with warm low sunlight and long soft shadows' },
  { id: 'blue-hour', label: 'Blue hour', group: 'Time of day', prompt: 'the same scene at dusk during the blue hour, with a deep blue sky and soft cool light' },
  { id: 'night', label: 'Night', group: 'Time of day', prompt: 'the same scene at night, lit by moonlight and artificial lights where they would plausibly be' },
  { id: 'midday', label: 'Bright midday', group: 'Time of day', prompt: 'the same scene at bright midday with clear daylight' },
  { id: 'spring', label: 'Spring', group: 'Season', prompt: 'the same scene in spring, with fresh green leaves and blossoms where plants are' },
  { id: 'summer', label: 'Summer', group: 'Season', prompt: 'the same scene in high summer, with lush green vegetation' },
  { id: 'autumn', label: 'Autumn', group: 'Season', prompt: 'the same scene in autumn, with orange, red and yellow foliage where plants are' },
  { id: 'winter', label: 'Winter', group: 'Season', prompt: 'the same scene in winter, with snow on the ground and on surfaces where it would settle' },
  { id: 'fog', label: 'Fog', group: 'Weather', prompt: 'the same scene in light fog that grows denser with distance' },
  { id: 'rain', label: 'Rain', group: 'Weather', prompt: 'the same scene in rain, with wet reflective surfaces and an overcast sky' },
  { id: 'snowfall', label: 'Snowfall', group: 'Weather', prompt: 'the same scene during gentle snowfall' },
  { id: 'overcast', label: 'Overcast', group: 'Weather', prompt: 'the same scene under a soft overcast sky with diffuse light' },
  { id: 'clear', label: 'Clear sky', group: 'Weather', prompt: 'the same scene under a clear blue sky' },
  { id: 'custom', label: 'Custom…', group: 'Custom', prompt: '' },
];

export const RESTORE_FILTERS: RestoreFilterDef[] = [
  {
    id: 'skin',
    label: 'Skin Smoothing',
    group: 'Portrait',
    description: 'Evens out skin while keeping pores and fine texture. Skin is found automatically, or limited to the selection.',
    overlay: 'Skin mask',
    params: [
      sel('area', 'Skin Area', [['auto', 'Detect skin'], ['selection', 'Selection only'], ['all', 'Whole image']], 'auto'),
      numP('smoothness', 'Smoothness', 0, 100, 50, '%'),
      numP('detail', 'Detail', 0, 100, 60, '%'),
      numP('tone', 'Even Tone', 0, 100, 30, '%'),
      numP('tolerance', 'Skin Range', 0, 100, 50, '%'),
    ],
  },
  {
    id: 'jpeg',
    label: 'JPEG Artifact Removal',
    group: 'Restoration',
    description: 'Removes 8×8 block edges, ringing around edges and blotchy color from compressed images.',
    params: [sel('strength', 'Strength', [['auto', 'Automatic'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'auto')],
  },
  {
    id: 'restore',
    label: 'Photo Restoration',
    group: 'Restoration',
    description: 'Repairs dust and scratches, reduces noise, restores faded color and contrast and removes print dots.',
    overlay: 'Detected defects',
    params: [
      numP('scratches', 'Scratches', 0, 100, 50, '%'),
      numP('dust', 'Dust', 0, 100, 50, '%'),
      numP('size', 'Defect Size', 1, 20, 4, 'px'),
      numP('denoise', 'Noise Reduction', 0, 100, 20, '%'),
      numP('fade', 'Color & Contrast', 0, 100, 50, '%'),
      numP('halftone', 'Print Dot Removal', 0, 100, 0, '%'),
    ],
  },
  {
    id: 'colorize',
    label: 'Colorize',
    group: 'Color',
    description: 'Click the preview to place color hints; colors spread through similar areas and stop at edges. Luminance is kept.',
    overlay: 'Colored area',
    params: [
      sel('source', 'Colors From', [['hints', 'Hints'], ['ai', 'AI suggestion and hints']], 'hints'),
      numP('saturation', 'Saturation', 0, 200, 100, '%'),
      numP('spread', 'Spread', 0, 100, 60, '%'),
      numP('radius', 'Hint Size', 1, 100, 6, 'px'),
    ],
  },
  {
    id: 'transfer',
    label: 'Color Transfer',
    group: 'Color',
    description: 'Takes the color look of another document, layer or file, matched separately in shadows, midtones and highlights.',
    params: [
      numP('strength', 'Strength', 0, 100, 80, '%'),
      check('preserve', 'Keep Luminance', true),
      numP('shadows', 'Shadows', 0, 100, 100, '%'),
      numP('midtones', 'Midtones', 0, 100, 100, '%'),
      numP('highlights', 'Highlights', 0, 100, 100, '%'),
    ],
  },
  {
    id: 'depth',
    label: 'Depth Blur',
    group: 'Creative',
    description: 'Blurs by estimated distance like a wide aperture. Click the preview to focus there.',
    overlay: 'Depth map',
    params: [
      sel('source', 'Depth', [['auto', 'Estimated'], ['layer', 'From a layer or channel']], 'auto'),
      check('subject', 'Keep Subject Near', true),
      check('invert', 'Invert Depth', false),
      numP('focal', 'Focal Distance', 0, 100, 20, '%'),
      numP('range', 'Focal Range', 0, 100, 20, '%'),
      numP('blur', 'Blur Strength', 0, 100, 40, '%'),
      sel('shape', 'Iris Shape', [['0', 'Circle'], ['5', 'Pentagon'], ['6', 'Hexagon'], ['8', 'Octagon']], '6'),
      numP('brightness', 'Bokeh Brightness', 0, 100, 20, '%'),
      numP('haze', 'Haze', 0, 100, 0, '%'),
      numP('warmth', 'Warmth', -100, 100, 0),
      numP('grain', 'Grain', 0, 100, 0, '%'),
    ],
  },
  {
    id: 'style',
    label: 'Style Transfer',
    group: 'Creative',
    description: 'Turns the photo into painted, drawn or printed art, or restyles it with AI from a description or a reference image.',
    params: [
      sel('style', 'Style', [['painterly', 'Painterly'], ['ink', 'Ink drawing'], ['pencil', 'Pencil sketch'], ['watercolor', 'Watercolor wash'], ['print', 'Halftone print'], ['ai', 'AI style (prompt)']], 'painterly'),
      numP('strength', 'Strength', 0, 100, 100, '%'),
      numP('brush', 'Brush Size', 1, 50, 6, 'px'),
    ],
  },
  {
    id: 'scene',
    label: 'Scene Changer',
    group: 'Creative',
    description: 'Changes time of day, season or weather with AI, optionally keeping the main subject unchanged.',
    overlay: 'Changed area',
    params: [
      sel('preset', 'Change To', SCENE_PRESETS.map((p) => [p.id, p.group === 'Custom' ? p.label : `${p.group}: ${p.label}`]), 'golden-hour'),
      check('protect', 'Protect Subject', true),
      numP('strength', 'Strength', 0, 100, 100, '%'),
    ],
  },
];

// Filters run in this order whatever order they are shown in: repairs first,
// then portrait and color work, then creative looks.
export const RUN_ORDER: RestoreFilterId[] = ['jpeg', 'restore', 'skin', 'colorize', 'transfer', 'depth', 'style', 'scene'];
export const GROUPS: RestoreGroup[] = ['Portrait', 'Restoration', 'Color', 'Creative'];
export const filterDef = (id: string) => RESTORE_FILTERS.find((f) => f.id === id);

export type RestoreEntry = {
  id: RestoreFilterId;
  enabled: boolean;
  params: ParamValues;
  // Colorize: color hints.
  hints?: Hint[];
  // Color Transfer: statistics of the reference and its name.
  reference?: TransferStats;
  referenceName?: string;
  // AI results and layer-based depth are pixels kept by the dialog, named here.
  aux?: string;
  // Prompt of Scene Changer (custom) and AI style.
  prompt?: string;
};
export type RestoreParams = { filters: RestoreEntry[] };

function cleanValue(s: ParamSpec, v: unknown): ParamValues[string] {
  if (s.type === 'number') return typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
  if (s.type === 'select') return typeof v === 'string' && s.options.some((o) => o.value === v) ? v : s.default;
  if (s.type === 'checkbox') return typeof v === 'boolean' ? v : s.default;
  return (s as { default: ParamValues[string] }).default;
}
export function defaultParams(def: RestoreFilterDef): ParamValues {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default as ParamValues[string]]));
}
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function cleanHints(v: unknown): Hint[] {
  if (!Array.isArray(v)) return [];
  const out: Hint[] = [];
  for (const h of v.slice(0, 256)) {
    const o = h as Partial<Hint> | null;
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number' || !Number.isFinite(o.x) || !Number.isFinite(o.y) || !isHex(o.color)) continue;
    const r = typeof o.radius === 'number' && Number.isFinite(o.radius) ? Math.min(100, Math.max(1, o.radius)) : 6;
    out.push({ x: Math.min(1, Math.max(0, o.x)), y: Math.min(1, Math.max(0, o.y)), color: o.color.toLowerCase(), radius: r });
  }
  return out;
}

/** Every filter once, in run order, with valid settings (unknown keys dropped). */
export function normalizeRestore(p: unknown): RestoreParams {
  const given = Array.isArray((p as { filters?: unknown })?.filters) ? ((p as { filters: unknown[] }).filters as Partial<RestoreEntry>[]) : [];
  const filters = RUN_ORDER.map((id): RestoreEntry => {
    const def = filterDef(id)!;
    const g = given.find((x) => x && typeof x === 'object' && x.id === id);
    const raw = (g?.params && typeof g.params === 'object' ? g.params : {}) as Record<string, unknown>;
    const params = Object.fromEntries(def.params.map((s) => [s.key, cleanValue(s, raw[s.key])]));
    const e: RestoreEntry = { id, enabled: !!g && g.enabled === true, params };
    if (id === 'colorize') e.hints = cleanHints(g?.hints);
    if (id === 'transfer') {
      const r = cleanStats(g?.reference);
      if (r) {
        e.reference = r;
        e.referenceName = typeof g?.referenceName === 'string' ? g.referenceName.slice(0, 200) : 'Reference';
      }
    }
    if (typeof g?.aux === 'string' && /^[\w-]{1,64}$/.test(g.aux)) e.aux = g.aux;
    if (typeof g?.prompt === 'string' && (id === 'scene' || id === 'style')) e.prompt = g.prompt.slice(0, 1000);
    return e;
  });
  return { filters };
}
export const enabledEntries = (p: RestoreParams) => p.filters.filter((f) => f.enabled);

/** Whether a filter's result depends on pixels outside the settings (AI
 * results, a depth layer), which Live Filters and actions cannot replay. */
export function needsPixels(e: RestoreEntry): boolean {
  if (!e.enabled) return false;
  if (e.id === 'scene') return true;
  if (e.id === 'style') return e.params.style === 'ai';
  if (e.id === 'colorize') return e.params.source === 'ai';
  if (e.id === 'depth') return e.params.source === 'layer';
  return false;
}
export const isDeterministic = (p: RestoreParams) => !p.filters.some(needsPixels);
/** Settings without pixel-dependent parts, for Live Filters and actions. */
export function replayable(p: RestoreParams): RestoreParams {
  return { filters: p.filters.map((f) => (needsPixels(f) ? { ...f, enabled: false } : f)).map(({ aux: _aux, ...f }) => f) };
}
