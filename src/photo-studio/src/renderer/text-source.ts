// Rasterizes editable text layers for the compositor. Text is drawn on the
// main thread (OffscreenCanvas, where the document's fonts are loaded) at a
// resolution matching the layer's on-canvas scale, then placed through the
// layer's text matrix.

import type { Layer, Rect } from '../model/document';
import type { RGBA8 } from '../imaging/types';
import { findBundled, isFontAvailable, prepareFonts } from '../imaging/text/fonts';
import { renderText } from '../imaging/text/render';
import type { TextLayerData } from '../imaging/text/model';
import { textFrameOf, textScale } from '../model/text-layer';

// Quarter-octave steps keep live scaling from re-rendering on every frame,
// and rendering never below the needed resolution keeps edges crisp.
export function textRenderScale(l: Layer, maxSize = 8192): number {
  const [sx, sy] = textScale(l);
  const s = Math.max(1 / 16, Math.min(8, Math.max(Math.abs(sx), Math.abs(sy)) || 1));
  let q = Math.pow(2, Math.ceil(Math.log2(s) * 4 - 1e-6) / 4);
  const f = textFrameOf(l);
  // Ink can exceed the frame; leave room for it within the texture limit.
  const limit = maxSize / (Math.max(f.width, f.height) * 1.5 + 64);
  if (q > limit) q = Math.max(1 / 16, limit);
  return q;
}

const availability = new Map<string, boolean>();
export function missingFonts(data: TextLayerData): string[] {
  const out = new Set<string>();
  for (const p of data.content.paragraphs)
    for (const r of p.runs) {
      const f = r.style.family;
      if (findBundled(f)) continue;
      let ok = availability.get(f);
      if (ok === undefined) availability.set(f, (ok = isFontAvailable(f)));
      if (!ok) out.add(f);
    }
  return [...out];
}
export function forgetFontAvailability() {
  availability.clear();
}

// Imported text keeps its saved pixels (`asset`) until it is edited; they
// are shown instead of a substitute face when a font is not installed.
export function usesTextFallback(l: Layer): boolean {
  return !!l.asset && !!l.textData && missingFonts(l.textData).length > 0;
}

export type TextRaster = { image: RGBA8; rect: Rect };
export async function renderTextLayer(data: TextLayerData, ppi: number, scale: number): Promise<TextRaster> {
  await prepareFonts(data, { allowFallback: true });
  const r = renderText(data, { resolution: ppi, scale });
  if (!r.image.width || !r.image.height)
    return { image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, rect: { x: r.x, y: r.y, width: 1 / scale, height: 1 / scale } };
  return { image: r.image, rect: { x: r.x, y: r.y, width: r.image.width / r.scale, height: r.image.height / r.scale } };
}
