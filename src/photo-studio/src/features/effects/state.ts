import type { Editor } from '../../editor';
import type { Gradient, GradientMethod, GradientType, SolidGradient, StopColor } from '../../imaging/gradient/gradient';
import { gradientPresets } from '../../imaging/gradient/presets';
import type { BlendMode } from '../../imaging/blend/modes';
import type { RGB } from '../../imaging/effects/types';
import { patternPresets } from '../../imaging/pattern/presets';
import type { Pattern } from '../../imaging/pattern/pattern';
import { documentPatternPixels } from '../../model/fill-layer';
import { hexRgb } from '../pixels';
import { validGradient } from '../../model/layer-style';

// Shared state of the gradient and pattern features: the current gradient
// (Gradient tool, gradient fills, Gradients panel), tool options and the
// current pattern (Pattern Stamp, pattern fills, Patterns panel).
export type GradientToolOptions = {
  type: GradientType;
  mode: BlendMode;
  opacity: number;
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
  method: GradientMethod;
};
export const effectsState: {
  gradient: Gradient;
  tool: GradientToolOptions;
  patternId: string;
  patternAligned: boolean;
  patternScale: number;
} = {
  gradient: structuredClone(gradientPresets[0].gradients[0]),
  tool: { type: 'linear', mode: 'normal', opacity: 1, reverse: false, dither: true, transparency: true, method: 'perceptual' },
  patternId: 'checker',
  patternAligned: true,
  patternScale: 1,
};

const userKey = 'photo-studio-gradients';
export function loadUserGradients(): Gradient[] {
  try {
    const v = JSON.parse(localStorage.getItem(userKey) ?? '[]');
    if (Array.isArray(v)) return v.filter(validGradient);
  } catch {
    /* Optional. */
  }
  return [];
}
export function saveUserGradients(list: Gradient[]) {
  try {
    localStorage.setItem(userKey, JSON.stringify(list));
  } catch {
    /* Optional. */
  }
}
export function allGradientFolders(): { name: string; gradients: Gradient[] }[] {
  const user = loadUserGradients();
  return [...gradientPresets, ...(user.length ? [{ name: 'Saved', gradients: user }] : [])];
}
export const colors = (e: Editor): { foreground: RGB; background: RGB } => ({ foreground: hexRgb(e.color), background: hexRgb(e.background) });
/** A copy with foreground/background stops replaced by the current colors. */
export function resolveGradient(e: Editor, g: Gradient): Gradient {
  if (g.kind !== 'solid') return structuredClone(g);
  const { foreground, background } = colors(e);
  const fix = (c: StopColor): RGB => (c === 'foreground' ? foreground : c === 'background' ? background : [...c]);
  return { ...structuredClone(g), colorStops: g.colorStops.map((s) => ({ ...s, color: fix(s.color) })) } as SolidGradient;
}

/** Built-in patterns followed by the document's own. */
export function availablePatterns(e: Editor): Pattern[] {
  const own = (e.doc.patterns ?? []).map((p) => documentPatternPixels(p, e.assets.tiles)).filter((p): p is Pattern => !!p);
  return [...patternPresets(), ...own];
}
export function currentPattern(e: Editor): Pattern | undefined {
  const list = availablePatterns(e);
  return list.find((p) => p.id === effectsState.patternId) ?? list[0];
}
const thumbs = new Map<string, string>();
/** PNG data URL of a pattern tile repeated into a square swatch. */
export function patternThumb(p: Pattern, size = 40): string {
  const key = `${p.id}:${p.tile.width}x${p.tile.height}:${size}:${p.tile.data.length ? p.tile.data[0] + p.tile.data[p.tile.data.length - 1] : 0}`;
  let url = thumbs.get(key);
  if (url) return url;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const tile = document.createElement('canvas');
  tile.width = p.tile.width;
  tile.height = p.tile.height;
  tile.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.tile.data), p.tile.width, p.tile.height), 0, 0);
  // Large tiles are shown scaled down so the swatch reads as the pattern.
  const scale = Math.min(1, (size * 1.5) / Math.max(p.tile.width, p.tile.height));
  g.scale(scale, scale);
  g.fillStyle = g.createPattern(tile, 'repeat')!;
  g.fillRect(0, 0, size / scale, size / scale);
  url = c.toDataURL();
  thumbs.set(key, url);
  return url;
}
