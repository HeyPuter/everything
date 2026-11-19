// The image File → Print hands to the browser: the composite as 8-bit sRGB in
// a quickly compressed PNG. Free of UI so the export worker can run it.
import type { ExportContext, SourceImage } from './encode';
import { convertToSrgb } from './color';
import { encodePng, rgba16To8 } from './png';

/** The composite as 8-bit sRGB for printing. Colors are converted before the
 * samples are reduced to 8 bits: reducing linear (32-bit) samples first bands
 * the shadows. With `owned`, `src` is converted in place. */
export function printPixels(
  src: SourceImage,
  ctx: ExportContext,
  owned = false,
): Uint8ClampedArray {
  const data = owned ? src.data : src.data.slice();
  if (ctx.profile) convertToSrgb(data, ctx.profile);
  return data instanceof Uint16Array ? rgba16To8(data) : data;
}
export function printPng(src: SourceImage, ctx: ExportContext, owned = false): Uint8Array {
  return encodePng(
    { width: src.width, height: src.height, data: printPixels(src, ctx, owned), channels: 4 },
    { level: 1 },
  );
}
