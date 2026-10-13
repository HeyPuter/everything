import { isDocumentId } from './ids';
import type { IRect, RGBA8 } from '../imaging/types';
import type { Gradient } from '../imaging/gradient/gradient';
import { renderGradientInto } from '../imaging/gradient/gradient';
import type { GradientGeometry, LayerStyle, PatternPlacement } from '../imaging/effects/types';
import { gradientGeometryPoints } from '../imaging/effects/bounds';
import { renderPattern, type Pattern } from '../imaging/pattern/pattern';
import { findPatternPreset } from '../imaging/pattern/presets';
import { readRGBA, type TileGrid, type TileStore } from './tiles';
import type { Layer, PhotoDocument } from './document';

// Non-destructive gradient and pattern fill layers (kind "solid" with `fill`).
// Gradient stops are stored resolved (no foreground/background references),
// so a fill looks the same whatever the current colors are.
export type GradientLayerFill = { type: 'gradient'; gradient: Gradient } & GradientGeometry;
export type PatternLayerFill = { type: 'pattern' } & PatternPlacement;
export type LayerFill = GradientLayerFill | PatternLayerFill;
// Patterns defined from document pixels travel with the document; tiles live
// in the tile store like layer pixels (grid origin 0, bounds = tile size).
export type DocumentPattern = { id: string; name: string; width: number; height: number; grid: TileGrid };

const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Structural check used when loading projects. */
export function validLayerFill(f: unknown): f is LayerFill {
  if (!f || typeof f !== 'object') return false;
  const fill = f as LayerFill;
  if (fill.type === 'gradient') {
    const g = fill.gradient as Gradient | undefined;
    const okGradient = !!g && typeof g === 'object' &&
      (g.kind === 'solid' ? Array.isArray(g.colorStops) && Array.isArray(g.opacityStops) && g.colorStops.length > 0 : g.kind === 'noise');
    return okGradient && ['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(fill.style) && finite(fill.angle) && finite(fill.scale) && fill.scale > 0;
  }
  if (fill.type === 'pattern') return typeof fill.patternId === 'string' && finite(fill.scale) && fill.scale > 0;
  return false;
}
export function validDocumentPatterns(list: unknown): boolean {
  return Array.isArray(list) && list.length <= 256 && list.every((p) =>
    !!p && isDocumentId(p.id) && typeof p.name === 'string' && !!p.grid && typeof p.grid === 'object' &&
    Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width <= 4096 && p.height <= 4096);
}

// Decoded user patterns, keyed by their tile identities so history snapshots
// (which clone the grid objects) share one decode.
const decoded = new Map<string, Pattern>();
function patternKey(p: DocumentPattern) {
  return `${p.id}:${Object.values(p.grid.tiles).join(',')}:${p.width}x${p.height}`;
}
export function documentPatternPixels(p: DocumentPattern, store: TileStore): Pattern | undefined {
  const key = patternKey(p);
  let hit = decoded.get(key);
  if (hit) return hit;
  if (!(p.width > 0 && p.height > 0)) return undefined;
  try {
    hit = { id: p.id, name: p.name, tile: readRGBA(store, p.grid, { x: 0, y: 0, width: p.width, height: p.height }) };
  } catch {
    return undefined;
  }
  if (decoded.size > 64) decoded.delete(decoded.keys().next().value!);
  decoded.set(key, hit);
  return hit;
}
/** Look up a pattern by ID: built-in presets first, then the document's own. */
export function resolvePattern(doc: Pick<PhotoDocument, 'patterns'>, store: TileStore, id: string): Pattern | undefined {
  const preset = findPatternPreset(id);
  if (preset) return preset;
  const own = doc.patterns?.find((p) => p.id === id);
  return own ? documentPatternPixels(own, store) : undefined;
}
/** Pattern IDs a layer style refers to (overlay, stroke, bevel texture). */
export function stylePatternIds(style: LayerStyle): string[] {
  const ids = new Set<string>();
  if (style.patternOverlay) ids.add(style.patternOverlay.patternId);
  if (style.bevel?.texture) ids.add(style.bevel.texture.patternId);
  for (const s of style.stroke ?? []) if (s.fill.type === 'pattern') ids.add(s.fill.patternId);
  return [...ids];
}

/** Pixels of a fill over `rect` (document coordinates); `reference` is the
 * rectangle a layer-aligned gradient spans (the layer's frame). */
export function renderLayerFill(
  fill: LayerFill,
  rect: IRect,
  reference: IRect,
  doc: { width: number; height: number },
  pattern: (id: string) => Pattern | undefined,
): RGBA8 {
  const out: RGBA8 = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height * 4) };
  if (fill.type === 'gradient') {
    const frame = fill.alignWithLayer === false ? { x: 0, y: 0, width: doc.width, height: doc.height } : reference;
    const { start, end } = gradientGeometryPoints(frame, fill);
    renderGradientInto(out, fill.gradient, { type: fill.style, start, end, reverse: fill.reverse, dither: fill.dither, method: fill.method }, { x: rect.x, y: rect.y });
    return out;
  }
  const p = pattern(fill.patternId);
  if (!p) return out;
  const origin = fill.linkWithLayer ? { x: reference.x, y: reference.y } : { x: 0, y: 0 };
  const t = { scale: Math.max(0.01, fill.scale), angle: fill.angle ?? 0, offset: { x: origin.x + (fill.offset?.x ?? 0), y: origin.y + (fill.offset?.y ?? 0) } };
  if (t.scale === 1 && t.angle === 0 && Number.isInteger(t.offset.x) && Number.isInteger(t.offset.y))
    return renderPattern(rect.width, rect.height, p, t, { x: rect.x, y: rect.y });
  return transformedPattern(out, p, t.scale, t.angle, t.offset, rect);
}
// The transformed tiling of renderPattern with its per-pixel sampling
// inlined (bilinear on alpha-weighted texels, wrapping), since document-sized
// fills would otherwise spend most of their time in calls.
export function transformedPattern(out: RGBA8, p: Pattern, scale: number, angle: number, offset: { x: number; y: number }, rect: IRect): RGBA8 {
  const { width: tw, height: th, data: d } = p.tile;
  const o = out.data;
  const a = (angle * Math.PI) / 180, c = Math.cos(a) / scale, s = Math.sin(a) / scale;
  for (let y = 0; y < rect.height; y++) {
    const dy = rect.y + y + 0.5 - offset.y;
    const dx0 = rect.x + 0.5 - offset.x;
    // Texel-center coordinates (u - 0.5, v - 0.5) advance linearly along the row.
    let u = c * dx0 - s * dy - 0.5, v = s * dx0 + c * dy - 0.5;
    let i = y * rect.width * 4;
    for (let x = 0; x < rect.width; x++, i += 4, u += c, v += s) {
      const fx = Math.floor(u), fy = Math.floor(v);
      const tx = u - fx, ty = v - fy;
      let x0 = fx % tw, y0 = fy % th;
      if (x0 < 0) x0 += tw;
      if (y0 < 0) y0 += th;
      const x1 = x0 + 1 === tw ? 0 : x0 + 1, y1 = y0 + 1 === th ? 0 : y0 + 1;
      const i00 = (y0 * tw + x0) * 4, i10 = (y0 * tw + x1) * 4, i01 = (y1 * tw + x0) * 4, i11 = (y1 * tw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty) * d[i00 + 3], w10 = tx * (1 - ty) * d[i10 + 3];
      const w01 = (1 - tx) * ty * d[i01 + 3], w11 = tx * ty * d[i11 + 3];
      const sum = w00 + w10 + w01 + w11;
      if (sum <= 0) continue;
      const inv = 1 / sum;
      o[i] = (d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11) * inv;
      o[i + 1] = (d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11) * inv;
      o[i + 2] = (d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11) * inv;
      o[i + 3] = sum;
    }
  }
  return out;
}
/** Pixels of a fill layer in its source space (the transform places them;
 * fill layers span the document, so source and document frames coincide). */
export function fillLayerPixels(l: Layer, doc: Pick<PhotoDocument, 'patterns'>, store: TileStore): RGBA8 | undefined {
  if (!l.fill) return undefined;
  const w = Math.max(1, Math.round(l.sourceWidth)), h = Math.max(1, Math.round(l.sourceHeight));
  const frame = { x: 0, y: 0, width: w, height: h };
  return renderLayerFill(l.fill, frame, frame, frame, (id) => resolvePattern(doc, store, id));
}
