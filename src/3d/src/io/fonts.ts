// Font loading and text layout for text (FONT) objects. Uses opentype.js (MIT) to read the bundled
// Inter font (SIL Open Font License, via @fontsource/inter) and converts glyph outlines into
// Bézier splines that the curve evaluator fills and extrudes.
import { parse, type Font, type Glyph } from 'opentype.js';
import type { BezierPoint, CurveData, Spline, Vec3, VectorFontData } from '../data/types';
import { setGlyphProvider } from '../eval/text';
import { layoutTextWith, type FontStyle, type GlyphSource, type TextLayout } from './textlayout';
import latinUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import boldUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import italicUrl from '@fontsource/inter/files/inter-latin-400-italic.woff?url';
import boldItalicUrl from '@fontsource/inter/files/inter-latin-700-italic.woff?url';
import latinExtUrl from '@fontsource/inter/files/inter-latin-ext-400-normal.woff?url';
import greekUrl from '@fontsource/inter/files/inter-greek-400-normal.woff?url';
import cyrillicUrl from '@fontsource/inter/files/inter-cyrillic-400-normal.woff?url';

let fonts: Font[] = [];
/** outline cache per font face (subsets and styles share names but not glyph indices) */
const outlineCache = new WeakMap<Font, Map<number, Spline[]>>();

/** Styled faces (latin subset), loaded on first use; other scripts fall back to the regular face. */
const STYLE_URLS: Record<Exclude<FontStyle, 'REGULAR'>, string> = { BOLD: boldUrl, ITALIC: italicUrl, BOLD_ITALIC: boldItalicUrl };
const styled = new Map<FontStyle, Font | null>();
const styleLoading = new Set<FontStyle>();
/** Called when a styled face finished loading (text objects using it must re-evaluate). */
export const fontLoadListeners: (() => void)[] = [];

function requestStyle(style: FontStyle) {
  if (style === 'REGULAR' || styled.has(style) || styleLoading.has(style) || typeof fetch === 'undefined') return;
  styleLoading.add(style);
  fetch(STYLE_URLS[style])
    .then((r) => r.arrayBuffer())
    .then((b) => parse(b))
    .catch(() => null)
    .then((f) => {
      styled.set(style, f);
      styleLoading.delete(style);
      for (const fn of fontLoadListeners) fn();
    });
}

/** Glyph lookup with fallback across the loaded subsets. */
function glyphFor(ch: string, style: FontStyle = 'REGULAR'): { font: Font; glyph: Glyph } | null {
  if (style !== 'REGULAR') {
    requestStyle(style);
    const f = styled.get(style);
    if (f) {
      const idx = f.charToGlyphIndex(ch);
      if (idx > 0) return { font: f, glyph: f.glyphs.get(idx) };
    }
  }
  for (const font of fonts) {
    const idx = font.charToGlyphIndex(ch);
    if (idx > 0) return { font, glyph: font.glyphs.get(idx) };
  }
  if (!fonts.length) return null;
  return { font: fonts[0], glyph: fonts[0].charToGlyph('?') };
}

function bp(co: Vec3): BezierPoint {
  return { co: [...co] as Vec3, handle_left: [...co] as Vec3, handle_right: [...co] as Vec3, handle_left_type: 'FREE', handle_right_type: 'FREE', radius: 1, tilt: 0 };
}

/** Glyph outline (em units, y up) as cyclic Bézier splines. */
export function glyphOutline(font: Font, glyph: Glyph): Spline[] {
  let cache = outlineCache.get(font);
  if (!cache) outlineCache.set(font, (cache = new Map()));
  const hit = cache.get(glyph.index);
  if (hit) return hit;
  const s = 1 / font.unitsPerEm;
  const out: Spline[] = [];
  let pts: BezierPoint[] = [];
  let cur: Vec3 = [0, 0, 0];
  const close = () => {
    if (pts.length > 1) {
      // the closing point duplicates the first one: merge their handles
      const first = pts[0],
        last = pts[pts.length - 1];
      if (Math.hypot(first.co[0] - last.co[0], first.co[1] - last.co[1]) < 1e-6) {
        first.handle_left = last.handle_left;
        pts.pop();
      }
      if (pts.length >= 2) out.push({ type: 'BEZIER', bezier_points: pts, points: [], use_cyclic_u: true, resolution_u: 0, order_u: 4, use_smooth: false, material_index: 0 });
    }
    pts = [];
  };
  for (const c of glyph.path.commands) {
    if (c.type === 'M') {
      close();
      cur = [c.x * s, c.y * s, 0];
      pts.push(bp(cur));
    } else if (c.type === 'L') {
      const p: Vec3 = [c.x * s, c.y * s, 0];
      const prev = pts[pts.length - 1];
      prev.handle_right = [cur[0] + (p[0] - cur[0]) / 3, cur[1] + (p[1] - cur[1]) / 3, 0];
      const n = bp(p);
      n.handle_left = [p[0] + (cur[0] - p[0]) / 3, p[1] + (cur[1] - p[1]) / 3, 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'Q') {
      const q: Vec3 = [c.x1 * s, c.y1 * s, 0],
        p: Vec3 = [c.x * s, c.y * s, 0];
      const prev = pts[pts.length - 1];
      prev.handle_right = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1]), 0];
      const n = bp(p);
      n.handle_left = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1]), 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'C') {
      const p: Vec3 = [c.x * s, c.y * s, 0];
      pts[pts.length - 1].handle_right = [c.x1 * s, c.y1 * s, 0];
      const n = bp(p);
      n.handle_left = [c.x2 * s, c.y2 * s, 0];
      pts.push(n);
      cur = p;
    } else if (c.type === 'Z') close();
  }
  close();
  cache.set(glyph.index, out);
  return out;
}

const source: GlyphSource = {
  advance(ch, style) {
    const g = glyphFor(ch, style);
    return g ? (g.glyph.advanceWidth ?? 0) / g.font.unitsPerEm : 0;
  },
  outline(ch, style) {
    const g = glyphFor(ch, style);
    return g ? glyphOutline(g.font, g.glyph) : null;
  },
  hasStyle(style) {
    return style === 'REGULAR' || !!styled.get(style);
  },
};

export type { TextLayout };

// ---------------------------------------------------------------------------
// custom fonts (font data-blocks packed in the document)

let fontTable: () => Record<string, VectorFontData> | undefined = () => undefined;
/** Where font data-blocks live (set by the text module: the document's `fonts`). */
export function setFontTable(fn: () => Record<string, VectorFontData> | undefined) {
  fontTable = fn;
}

const parsed = new WeakMap<Uint8Array, Font | null>();

/** Parse a font file; null when it cannot be read (unsupported format or damaged). */
export function parseFontBytes(bytes: Uint8Array): Font | null {
  if (parsed.has(bytes)) return parsed.get(bytes)!;
  let f: Font | null = null;
  try {
    f = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (!f.glyphs?.length) f = null;
  } catch {
    f = null;
  }
  parsed.set(bytes, f);
  return f;
}

function customFont(id: string | null | undefined): Font | null {
  if (!id) return null;
  const fd = fontTable()?.[id];
  return fd?.bytes ? parseFontBytes(fd.bytes) : null;
}

/** Glyph source honouring a text object's custom fonts (falls back to the built-in faces). */
function sourceFor(cu: CurveData): GlyphSource {
  if (!cu.font && !cu.font_bold && !cu.font_italic && !cu.font_bold_italic) return source;
  const slot: Record<FontStyle, Font | null> = { REGULAR: customFont(cu.font), BOLD: customFont(cu.font_bold), ITALIC: customFont(cu.font_italic), BOLD_ITALIC: customFont(cu.font_bold_italic) };
  const regular = slot.REGULAR;
  const pick = (ch: string, style: FontStyle): { font: Font; glyph: Glyph } | null => {
    const f = slot[style] ?? regular;
    if (f) {
      const idx = f.charToGlyphIndex(ch);
      if (idx > 0) return { font: f, glyph: f.glyphs.get(idx) };
    }
    // characters missing from the custom font come from the built-in one
    return glyphFor(ch, regular && !slot[style] ? 'REGULAR' : style);
  };
  return {
    advance(ch, style) {
      const g = pick(ch, style);
      return g ? (g.glyph.advanceWidth ?? 0) / g.font.unitsPerEm : 0;
    },
    outline(ch, style) {
      const g = pick(ch, style);
      return g ? glyphOutline(g.font, g.glyph) : null;
    },
    hasStyle(style) {
      if (style === 'REGULAR' || slot[style]) return true;
      // a custom regular face without a matching style face: synthesize italics, no fake bold
      return regular ? false : source.hasStyle(style);
    },
  };
}

/** Lay out a text body (see textlayout.ts) with the bundled fonts (or the object's own fonts). */
export function layoutText(cu: CurveData): TextLayout {
  const src = sourceFor(cu);
  return layoutTextWith(cu, fonts.length || src !== source ? src : null);
}

let loading: Promise<void> | null = null;

/** Load the bundled font subsets (once) and install the glyph provider. */
export function loadFonts(onReady: () => void): Promise<void> {
  loading ??= Promise.all(
    [latinUrl, latinExtUrl, greekUrl, cyrillicUrl].map((u) =>
      fetch(u)
        .then((r) => r.arrayBuffer())
        .then((b) => parse(b))
        .catch(() => null),
    ),
  ).then((list) => {
    fonts = list.filter((f): f is Font => !!f);
    setGlyphProvider({ layout: (cu) => layoutText(cu).splines });
    onReady();
  });
  return loading;
}
