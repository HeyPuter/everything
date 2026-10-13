// Running a Portrait & Restore stack: the enabled filters in run order, each
// on the previous result, then limited by the selection. Used by the dialog's
// worker (with AI results and layer pixels as named extras, a cache of stage
// results and the full-resolution source) and by the filter worker for Live
// Filters and recorded actions (settings only).
import { selectSubject } from '../segment/subject';
import type { Mask8, Progress, RGBA8 } from '../types';
import { checkCancelled } from '../types';
import { colorize } from './colorize';
import { removeJpegArtifacts, type DeblockStrength } from './deblock';
import { restorePhoto } from './defects';
import { normalizeRestore, RUN_ORDER, type RestoreEntry, type RestoreFilterId, type RestoreParams } from './defs';
import { blurRadius, depthBlur, depthFromImage, estimateDepth, type DepthBlurOptions } from './depth';
import { skinMask, skinScale, smoothSkin } from './skin';
import { stylize, type ClassicStyle } from './stylize';
import { colorTransfer } from './transfer';
import { copyRGBA, differenceMask, gaussian, keepAlpha, mixImages, mixMask, planeToMask, resizeRGBA, type Plane } from './util';

export type RestoreContext = {
  // Pixels of the source per document pixel (previews run reduced).
  scale: number;
  selection?: Mask8;
  // Named extra pixels (AI results, depth layers), at the size of the source.
  aux?: (name: string) => RGBA8 | undefined;
  // The full-resolution source, for filters that must see the original pixel grid.
  full?: () => RGBA8;
  // Cache for intermediate results (keys include everything they depend on).
  memo?: <T>(key: string, make: () => T) => T;
  // Return this filter's mask overlay, and an affected-area mask.
  overlay?: RestoreFilterId;
  affected?: boolean;
  // Lets the caller handle messages (cancellation) between stages.
  yield?: () => Promise<void>;
  seed?: number;
};
export type RestoreOutput = { image: RGBA8; overlay?: Mask8; affected?: Mask8 };
type StageOut = { image: RGBA8; overlay?: Mask8; area?: Mask8 };

const passthrough = (img: RGBA8): StageOut => ({ image: img });
const num = (e: RestoreEntry, k: string) => e.params[k] as number;
const str = (e: RestoreEntry, k: string) => e.params[k] as string;

/** Depth plane used by Depth Blur (also exported as a channel). */
export function depthPlane(img: RGBA8, e: RestoreEntry, ctx: RestoreContext, sig: string): Plane {
  const memo = ctx.memo ?? (<T,>(_k: string, make: () => T) => make());
  if (str(e, 'source') === 'layer' && e.aux) {
    const aux = ctx.aux?.(e.aux);
    if (aux) return memo(`depth-aux:${sig}:${e.aux}:${e.params.invert}`, () => depthFromImage(aux.width === img.width && aux.height === img.height ? aux : resizeRGBA(aux, img.width, img.height), !!e.params.invert));
  }
  const d = memo(`depth:${sig}:${e.params.subject}`, () => estimateDepth(img, { subject: !!e.params.subject }));
  if (!e.params.invert) return d;
  return memo(`depth-inv:${sig}:${e.params.subject}`, () => d.map((v) => 1 - v));
}
export function depthOptions(img: RGBA8, e: RestoreEntry, scale: number): DepthBlurOptions {
  const docSide = Math.max(img.width, img.height) / Math.max(1e-6, scale);
  return {
    focal: num(e, 'focal') / 100,
    range: num(e, 'range') / 100,
    blur: (num(e, 'blur') / 100) * docSide * 0.03,
    scale,
    blades: Number(str(e, 'shape')),
    brightness: num(e, 'brightness'),
    haze: num(e, 'haze'),
    warmth: num(e, 'warmth'),
    grain: num(e, 'grain'),
  };
}

async function stage(e: RestoreEntry, img: RGBA8, ctx: RestoreContext, first: boolean, sig: string, progress?: Progress): Promise<StageOut> {
  const memo = ctx.memo ?? (<T,>(_k: string, make: () => T) => make());
  switch (e.id) {
    case 'jpeg': {
      const strength = str(e, 'strength') as DeblockStrength;
      // Block edges exist only on the original pixel grid: previews of the
      // first filter clean the full-resolution source, then reduce it.
      if (first && ctx.scale < 1 && ctx.full) {
        const full = memo(`jpeg-full:${strength}`, () => removeJpegArtifacts(ctx.full!(), { strength }).image);
        return { image: resizeRGBA(full, img.width, img.height) };
      }
      return { image: removeJpegArtifacts(img, { strength }).image };
    }
    case 'restore': {
      const r = restorePhoto(
        img,
        {
          dust: num(e, 'dust'),
          scratches: num(e, 'scratches'),
          size: Math.max(1, num(e, 'size') * ctx.scale),
          denoise: num(e, 'denoise'),
          fade: num(e, 'fade'),
          halftone: num(e, 'halftone'),
          seed: ctx.seed,
        },
        progress,
      );
      const onlyDefects = !num(e, 'denoise') && !num(e, 'fade') && !num(e, 'halftone');
      return { image: r.image, overlay: r.defects, area: onlyDefects ? r.defects : undefined };
    }
    case 'skin': {
      const area = str(e, 'area');
      const full = (): Mask8 => ({ width: img.width, height: img.height, data: new Uint8Array(img.width * img.height).fill(255) });
      // "Selection only" smooths everywhere here: the stack's result is limited
      // by the selection at the end, and limiting it here too would apply a
      // feathered selection twice. The overlay still shows the selection.
      const mask = area === 'auto' ? memo(`skin-mask:${sig}:${e.params.tolerance}`, () => skinMask(img, { tolerance: num(e, 'tolerance') })) : full();
      const scale = area === 'auto' ? skinScale(mask) : Math.min(img.width, img.height) * 0.12;
      const smooth = smoothSkin(img, { smoothness: num(e, 'smoothness'), detail: num(e, 'detail'), tone: num(e, 'tone'), scale });
      return { image: area === 'auto' ? mixMask(img, smooth, mask) : smooth, overlay: area === 'selection' && ctx.selection ? ctx.selection : mask, area: mask };
    }
    case 'colorize': {
      const prior = str(e, 'source') === 'ai' && e.aux ? ctx.aux?.(e.aux) : undefined;
      if (!e.hints?.length && !prior) return passthrough(img);
      const r = colorize(img, { hints: e.hints ?? [], saturation: num(e, 'saturation'), spread: num(e, 'spread'), scale: ctx.scale, prior: prior && (prior.width === img.width && prior.height === img.height ? prior : resizeRGBA(prior, img.width, img.height)) });
      return { image: r.image, overlay: r.confidence, area: r.confidence };
    }
    case 'transfer': {
      if (!e.reference) return passthrough(img);
      return {
        image: colorTransfer(img, e.reference, {
          strength: num(e, 'strength'),
          preserveLuminance: !!e.params.preserve,
          shadows: num(e, 'shadows'),
          midtones: num(e, 'midtones'),
          highlights: num(e, 'highlights'),
        }),
      };
    }
    case 'depth': {
      const d = depthPlane(img, e, ctx, sig);
      const o = { ...depthOptions(img, e, ctx.scale), seed: ctx.seed };
      const image = depthBlur(img, d, o, progress);
      const R = Math.max(1e-6, o.blur * o.scale), rad = blurRadius(d, o);
      const area = planeToMask(rad.map((v) => v / R), img.width, img.height);
      return { image, overlay: planeToMask(d, img.width, img.height), area };
    }
    case 'style': {
      const s = num(e, 'strength') / 100;
      const style = str(e, 'style');
      if (style === 'ai') {
        const ai = e.aux ? ctx.aux?.(e.aux) : undefined;
        if (!ai) return passthrough(img);
        // The AI result is opaque: the layer keeps its own transparency.
        return { image: keepAlpha(mixImages(img, ai.width === img.width && ai.height === img.height ? ai : resizeRGBA(ai, img.width, img.height), s), img) };
      }
      const styled = stylize(img, { style: style as ClassicStyle, brush: num(e, 'brush'), scale: ctx.scale, seed: ctx.seed }, progress);
      return { image: s >= 1 ? styled : mixImages(img, styled, s) };
    }
    case 'scene': {
      const ai = e.aux ? ctx.aux?.(e.aux) : undefined;
      if (!ai) return passthrough(img);
      const gen = ai.width === img.width && ai.height === img.height ? ai : resizeRGBA(ai, img.width, img.height);
      const s = num(e, 'strength') / 100, n = img.width * img.height;
      const keep = e.params.protect ? memo(`subject:${sig}`, () => selectSubject(img)) : undefined;
      const area = new Uint8Array(n);
      for (let i = 0; i < n; i++) area[i] = Math.round(255 * s * (keep ? 1 - keep.data[i] / 255 : 1));
      const m = { width: img.width, height: img.height, data: area };
      return { image: keepAlpha(mixMask(img, copyRGBA(gen), m), img), overlay: m, area: m };
    }
  }
}

/** Run the enabled filters of `params` on `src`. */
export async function runRestore(src: RGBA8, params: RestoreParams | unknown, ctx: RestoreContext, progress?: Progress): Promise<RestoreOutput> {
  const p = normalizeRestore(params);
  const active = RUN_ORDER.map((id) => p.filters.find((f) => f.id === id)!).filter((f) => f.enabled);
  const memo = ctx.memo ?? (<T,>(_k: string, make: () => T) => make());
  let cur = src, overlay: Mask8 | undefined;
  const areas: (Mask8 | undefined)[] = [];
  let sig = `${src.width}x${src.height}`;
  for (let i = 0; i < active.length; i++) {
    checkCancelled(progress);
    const e = active[i];
    const inputSig = sig;
    sig += `|${JSON.stringify(e)}`;
    const sub: Progress | undefined = progress && { cancelled: progress.cancelled, report: (f) => progress.report?.((i + f) / active.length) };
    const input = cur;
    const out = await memo(`stage:${sig}`, () => stage(e, input, ctx, i === 0, inputSig, sub));
    cur = out.image;
    if (e.id === ctx.overlay) overlay = out.overlay;
    areas.push(out.area);
    progress?.report?.((i + 1) / active.length);
    await ctx.yield?.();
  }
  // An overlay of a filter that is switched off is computed on its own.
  if (ctx.overlay && !overlay && !active.some((f) => f.id === ctx.overlay)) {
    const e = p.filters.find((f) => f.id === ctx.overlay);
    if (e && (e.id === 'skin' || e.id === 'depth')) {
      const out = await memo(`overlay:${src.width}x${src.height}|${JSON.stringify(e)}`, () => stage({ ...e, enabled: true }, src, { ...ctx, overlay: undefined }, true, `${src.width}x${src.height}`));
      overlay = out.overlay;
    }
  }
  let image = cur === src ? copyRGBA(src) : copyRGBA(cur);
  if (ctx.selection) image = mixMask(src, image, ctx.selection);
  let affected: Mask8 | undefined;
  if (ctx.affected) affected = affectedArea(src, image, areas, ctx.selection);
  return { image, overlay, affected };
}

/** Where the stack changed the image: the filters' own areas when each has one
 * (skin, defects, colored area, changed scene), else measured differences. */
export function affectedArea(src: RGBA8, out: RGBA8, areas: (Mask8 | undefined)[], selection?: Mask8): Mask8 {
  const { width: w, height: h } = src, n = w * h;
  let m: Mask8;
  if (areas.length && areas.every((a) => a)) {
    const data = new Uint8Array(n);
    for (const a of areas) for (let i = 0; i < n; i++) if (a!.data[i] > data[i]) data[i] = a!.data[i];
    m = { width: w, height: h, data };
  } else {
    const diff = differenceMask(src, out, 10);
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = diff.data[i] / 255;
    const s = gaussian(p, w, h, Math.max(1, Math.min(w, h) * 0.004));
    m = planeToMask(s.map((v) => Math.min(1, v * 2.5)), w, h);
  }
  if (selection) for (let i = 0; i < n; i++) m.data[i] = (m.data[i] * selection.data[i]) / 255;
  return m;
}

/** The pipeline as a plain filter operation (Live Filters and actions). */
export async function applyRestore(src: RGBA8, params: unknown, ctx: { scale?: number; selection?: Mask8; seed?: number }, progress?: Progress): Promise<RGBA8> {
  return (await runRestore(src, params, { scale: ctx.scale ?? 1, selection: ctx.selection, seed: 7 }, progress)).image;
}
