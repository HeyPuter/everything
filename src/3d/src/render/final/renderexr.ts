// Render results as OpenEXR files: the Combined pass (scene-linear, premultiplied alpha), or
// every pass of every rendered layer for MultiLayer files.
import type { RenderSettings } from '../../data/types';
import { writeExr, planes, type ExrChannel, type ExrCompression } from './exr';
import { passChannels, type PassName, type RenderResult } from './result';

export type ExrFormat = 'OPEN_EXR' | 'OPEN_EXR_MULTILAYER';
export const isExr = (f: string): f is ExrFormat => f === 'OPEN_EXR' || f === 'OPEN_EXR_MULTILAYER';

/** Channel names of a pass by its channel count. */
function channelNames(pass: string, n: number): string[] {
  if (pass === 'Combined' || pass.startsWith('Combined_') || n === 4) return pass === 'UV' ? ['U', 'V', 'A', 'W'].slice(0, n) : ['R', 'G', 'B', 'A'].slice(0, n);
  if (n === 1) return pass === 'Depth' || pass === 'Mist' ? ['Z'] : ['X'];
  if (n === 3) return ['X', 'Y', 'Z'];
  return Array.from({ length: n }, (_, i) => String.fromCharCode(82 + i));
}

/** Output settings of OpenEXR files. */
export function exrOptions(r: Pick<RenderSettings, 'color_depth' | 'exr_codec' | 'pixel_aspect_x' | 'pixel_aspect_y'>): { half: boolean; compression: ExrCompression; pixelAspect: number } {
  return { half: (r.color_depth ?? '16') !== '32', compression: r.exr_codec ?? 'ZIP', pixelAspect: (r.pixel_aspect_x || 1) / (r.pixel_aspect_y || 1) };
}

/** Encode a render result as OpenEXR. */
export function resultExr(result: RenderResult, r: RenderSettings, format: ExrFormat, layerName = 'ViewLayer'): Uint8Array {
  const { width: w, height: h } = result;
  const opts = exrOptions(r);
  const channels: ExrChannel[] = [];
  if (format === 'OPEN_EXR') {
    const c = result.passes.Combined;
    if (!c) throw new Error('The render has no Combined pass');
    const names = r.color_mode === 'RGBA' ? ['R', 'G', 'B', 'A'] : r.color_mode === 'BW' ? ['V'] : ['R', 'G', 'B'];
    if (r.color_mode === 'BW') {
      const v = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) v[i] = 0.2126 * c[i * 4] + 0.7152 * c[i * 4 + 1] + 0.0722 * c[i * 4 + 2];
      channels.push({ name: 'V', data: v });
    } else channels.push(...planes(c, 4, ['R', 'G', 'B', 'A']).filter((p) => names.includes(p.name)));
    return writeExr(channels, w, h, opts);
  }
  // multilayer: every view layer's passes (the shown one when only one was rendered)
  const layers = result.layers?.length ? result.layers.map((l) => ({ name: l.name, passes: l.passes })) : [{ name: layerName, passes: result.viewLayer ?? result.passes }];
  for (const l of layers)
    for (const [pass, data] of Object.entries(l.passes) as [PassName, Float32Array][]) {
      if (!data) continue;
      const n = passChannels(pass, data, w * h);
      channels.push(...planes(data, n, channelNames(pass, n), `${l.name}.${pass}.`));
    }
  // the composited image, when the passes were post-processed
  if (result.viewLayer && result.passes.Combined) channels.push(...planes(result.passes.Combined, 4, ['R', 'G', 'B', 'A'], 'Composite.Combined.'));
  return writeExr(channels, w, h, opts);
}
