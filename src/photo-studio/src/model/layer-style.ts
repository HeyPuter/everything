import type { Layer } from './document';
import type { LayerStyle } from '../imaging/effects/types';
import { defaultBevel, defaultColorOverlay, defaultDropShadow, defaultInnerGlow, defaultInnerShadow, defaultOuterGlow, defaultSatin, defaultStroke } from '../imaging/effects/types';

// Helpers for the layer style stored on `Layer.style` (see imaging/effects).
type Any = { enabled?: boolean };
const on = (fx: Any | undefined) => !!fx && fx.enabled !== false;
const some = (list: Any[] | undefined) => !!list?.some((f) => f && f.enabled !== false);
/** The layer's style when it is enabled and has at least one enabled effect. */
export function activeLayerStyle(l: Layer): LayerStyle | undefined {
  const s = l.style as LayerStyle | undefined;
  if (!s || s.enabled === false) return undefined;
  return some(s.dropShadow) || some(s.innerShadow) || on(s.outerGlow) || on(s.innerGlow) || on(s.bevel) || on(s.satin) ||
    some(s.colorOverlay) || some(s.gradientOverlay) || on(s.patternOverlay) || some(s.stroke)
    ? s
    : undefined;
}
// Projects can be edited by hand; clamp every size so a hostile value cannot
// allocate unbounded work buffers (sizes and distances are pixels).
const clampNum = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
// Effects stored with some settings left out (libraries, hand-edited files)
// take the rest from the defaults, so no geometry is computed from undefined.
const defaultGradientOverlay = () => ({
  enabled: true, blendMode: 'normal', opacity: 1, style: 'linear', angle: 90, scale: 1,
  gradient: { kind: 'solid', colorStops: [{ location: 0, color: [0, 0, 0] }, { location: 1, color: [255, 255, 255] }], opacityStops: [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }] },
});
const defaultPatternOverlay = () => ({ enabled: true, blendMode: 'normal', opacity: 1, patternId: 'checker', scale: 1 });
const listDefaults: Record<string, () => object> = { dropShadow: defaultDropShadow, innerShadow: defaultInnerShadow, colorOverlay: defaultColorOverlay, gradientOverlay: defaultGradientOverlay, stroke: defaultStroke };
const singleDefaults: Record<string, () => object> = { outerGlow: defaultOuterGlow, innerGlow: defaultInnerGlow, bevel: defaultBevel, satin: defaultSatin, patternOverlay: defaultPatternOverlay };
export function sanitizeStyle(style: LayerStyle): LayerStyle {
  const s = structuredClone(style) as LayerStyle & Record<string, unknown>;
  for (const [k, d] of Object.entries(listDefaults)) if (Array.isArray(s[k])) s[k] = (s[k] as object[]).filter(obj).map((fx) => ({ ...d(), ...fx }));
  for (const [k, d] of Object.entries(singleDefaults)) if (obj(s[k])) s[k] = { ...d(), ...(s[k] as object) };
  s.scale = clampNum(s.scale, 0.01, 10, 1);
  const fix = (fx: Record<string, unknown> | undefined) => {
    if (!fx) return;
    for (const k of ['size', 'soften']) if (k in fx) fx[k] = clampNum(fx[k], 0, 250, 0);
    if ('distance' in fx) fx.distance = clampNum(fx.distance, 0, 1000, 0);
    for (const k of ['opacity', 'spread', 'range', 'jitter', 'noise', 'highlightOpacity', 'shadowOpacity'])
      if (k in fx) fx[k] = clampNum(fx[k], 0, 1, 0);
    if ('depth' in fx) fx.depth = clampNum(fx.depth, 0, 10, 1);
  };
  for (const list of [s.dropShadow, s.innerShadow, s.colorOverlay, s.gradientOverlay, s.stroke]) list?.forEach((fx) => fix(fx as never));
  for (const fx of [s.outerGlow, s.innerGlow, s.bevel, s.satin, s.patternOverlay]) fix(fx as never);
  return s;
}

// ----- Validation -----
// Styles come from hand-editable files (projects, preset files, libraries)
// and are used as they are, so one whose settings do not have the shape the
// renderer reads is refused where it enters. Settings may be left out (they
// default, see sanitizeStyle); unknown settings are ignored.
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(fin);
const point = (v: unknown) => obj(v) && fin(v.x) && fin(v.y);
/** Structural check of a gradient (solid or noise) from a file. */
export function validGradient(g: unknown): boolean {
  if (!obj(g)) return false;
  if (g.kind === 'noise') return fin(g.roughness) && ['rgb', 'hsb', 'lab'].includes(g.model as string) && triple(g.min) && triple(g.max) && fin(g.seed);
  const stop = (x: unknown): x is Record<string, unknown> => obj(x) && fin(x.location) && (x.midpoint === undefined || fin(x.midpoint));
  return (
    g.kind === 'solid' &&
    Array.isArray(g.colorStops) && g.colorStops.length > 0 && g.colorStops.length <= 256 &&
    g.colorStops.every((x) => stop(x) && (x.color === 'foreground' || x.color === 'background' || triple(x.color))) &&
    Array.isArray(g.opacityStops) && g.opacityStops.length <= 256 &&
    g.opacityStops.every((x) => stop(x) && fin(x.opacity)) &&
    (g.smoothness === undefined || fin(g.smoothness))
  );
}
const contour = (c: unknown) => obj(c) && Array.isArray(c.points) && c.points.length <= 256 && c.points.every(point);
const NUMBERS = new Set(['opacity', 'angle', 'distance', 'spread', 'size', 'noise', 'range', 'jitter', 'depth', 'soften', 'altitude', 'highlightOpacity', 'shadowOpacity', 'scale']);
const FLAGS = new Set(['enabled', 'useGlobalLight', 'antiAliased', 'glossAntiAliased', 'knockout', 'invert', 'reverse', 'dither', 'alignWithLayer', 'linkWithLayer']);
const WORDS = new Set(['blendMode', 'highlightMode', 'shadowMode', 'technique', 'style', 'direction', 'position', 'source', 'method', 'patternId']);
const COLORS = new Set(['color', 'highlightColor', 'shadowColor']);
function settingsOk(fx: unknown, bevel = false): boolean {
  if (!obj(fx)) return false;
  for (const [k, v] of Object.entries(fx)) {
    if (v === undefined) continue;
    const ok = NUMBERS.has(k) ? fin(v)
      : FLAGS.has(k) ? typeof v === 'boolean'
      : WORDS.has(k) ? typeof v === 'string' && v.length <= 64
      : COLORS.has(k) ? triple(v)
      : k === 'offset' ? point(v)
      : k === 'gradient' ? validGradient(v)
      : k === 'glossContour' ? contour(v)
      : k === 'contour' ? (bevel ? obj(v) && contour(v.contour) && settingsOk({ ...v, contour: undefined }) : contour(v))
      : k === 'texture' ? bevel && obj(v) && typeof v.patternId === 'string' && settingsOk(v)
      : k === 'fill' ? obj(v) && (v.type === 'color' ? triple(v.color) : v.type === 'gradient' ? validGradient(v.gradient) : v.type === 'pattern' && typeof v.patternId === 'string') && settingsOk(v)
      : true;
    if (!ok) return false;
  }
  return true;
}
/** Structural check of a layer style from a file (see above). */
export function validLayerStyle(v: unknown): v is LayerStyle {
  if (!obj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    const ok = k === 'enabled' ? typeof x === 'boolean'
      : ['scale', 'globalAngle', 'globalAltitude'].includes(k) ? fin(x)
      : k in listDefaults ? Array.isArray(x) && x.length <= 10 && x.every((fx) => settingsOk(fx))
      : k in singleDefaults ? settingsOk(x, k === 'bevel')
      : true;
    if (!ok) return false;
  }
  return true;
}
