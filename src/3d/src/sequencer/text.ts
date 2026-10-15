// Text strip rasterisation (2D canvas, bundled Inter font). Geometry:
// font_size is the em size in output pixels, the anchor box spans ascent 0.96 em / descent
// 0.24 em around the baseline, lines advance 1.16 em, shadow_offset and outline_width are
// relative to the font size and box_margin to the image width.
import type { Strip } from './types';

export const ASC = 0.96,
  DESC = 0.24,
  LINE = 1.16;

/** Width of a string in the strip's font at `px` (text editing: cursor and selection geometry). */
export function measureText(s: Strip, px: number, text: string) {
  const g = measureCtx();
  g.font = fontFor(s, px);
  return g.measureText(text).width;
}

let measureCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
function measureCtx(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  measureCanvas ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
  return measureCanvas.getContext('2d') as CanvasRenderingContext2D;
}

function css(c: number[] | undefined, fallback: string) {
  if (!c) return fallback;
  const [r, g, b, a = 1] = c;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

// Embedded font files are registered with the document's font set under generated family names.
const families = new WeakMap<Uint8Array, string>();
let familyCount = 0;
const fontListeners = new Set<() => void>();

/** Called when an embedded font finishes loading (previews re-render). */
export function onFontLoaded(fn: () => void) {
  fontListeners.add(fn);
}

function familyOf(file: { bytes: Uint8Array; filepath: string }): string | null {
  const known = families.get(file.bytes);
  if (known) return known;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return null;
  const name = `seqfont${++familyCount}`;
  families.set(file.bytes, name);
  const face = new FontFace(name, file.bytes as Uint8Array<ArrayBuffer>);
  face.load().then(
    (f) => {
      document.fonts.add(f);
      for (const fn of fontListeners) fn();
    },
    () => console.warn('sequencer: cannot read font', file.filepath),
  );
  return name;
}

export function fontFor(s: Strip, px: number) {
  const fam = s.font_file ? familyOf(s.font_file) : null;
  return `${s.use_italic ? 'italic ' : ''}${s.use_bold ? 600 : 400} ${px}px ${fam ? `"${fam}", ` : ''}Inter, system-ui, sans-serif`;
}

/** A wrapped line: displayed text and the index of its first character in the source text. */
export interface WrappedLine {
  text: string;
  start: number;
}

/** Word-wrap with source positions (explicit newlines kept; spaces at wrap points are dropped). */
export function wrapRanges(text: string, maxWidth: number, measure: (s: string) => number): WrappedLine[] {
  const out: WrappedLine[] = [];
  let po = 0;
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '',
      lineStart = po,
      pos = po;
    for (const w of words) {
      const next = line + w;
      if (line && measure(next.trimEnd()) > maxWidth && w.trim()) {
        out.push({ text: line.trimEnd(), start: lineStart });
        line = w.trimStart();
        lineStart = pos + (w.length - line.length);
      } else {
        if (!line) lineStart = pos;
        line = next;
      }
      pos += w.length;
    }
    out.push({ text: line.trimEnd(), start: lineStart });
    po += para.length + 1;
  }
  return out;
}

/** Word-wrap `text` to lines no wider than `maxWidth` (explicit newlines kept). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  return wrapRanges(text, maxWidth, measure).map((l) => l.text);
}

export interface TextLayoutBox {
  lines: { text: string; start: number; x: number; baseline: number; width: number }[];
  /** block bounds in output pixels, y up */
  left: number;
  right: number;
  bottom: number;
  top: number;
  fontPx: number;
}

/** Layout in output pixels (y up) for a W×H frame scaled by `k` (preview scale). */
export function layoutTextStrip(s: Strip, W: number, H: number, k = 1): TextLayoutBox {
  const fs = Math.max(1, (s.font_size ?? 60) * k);
  const g = measureCtx();
  g.font = fontFor(s, fs);
  const maxW = Math.max(fs, (s.wrap_width ?? 1) * W);
  const ranges = wrapRanges(s.text ?? '', maxW, (t) => g.measureText(t).width);
  const lines = ranges.map((r) => r.text);
  const widths = lines.map((l) => g.measureText(l).width);
  const blockW = Math.max(0, ...widths);
  const lh = fs * LINE;
  const blockH = (lines.length - 1) * lh + (ASC + DESC) * fs;
  const [lx, ly] = s.location ?? [0.5, 0.5];
  const ax = lx * W,
    ay = ly * H;
  const left = s.anchor_x === 'LEFT' ? ax : s.anchor_x === 'RIGHT' ? ax - blockW : ax - blockW / 2;
  const bottom = s.anchor_y === 'BOTTOM' ? ay : s.anchor_y === 'TOP' ? ay - blockH : ay - blockH / 2;
  const top = bottom + blockH;
  const out = lines.map((text, i) => {
    const w = widths[i];
    const x = s.alignment_x === 'LEFT' ? left : s.alignment_x === 'RIGHT' ? left + blockW - w : left + (blockW - w) / 2;
    return { text, start: ranges[i].start, x, baseline: top - ASC * fs - i * lh, width: w };
  });
  return { lines: out, left, right: left + blockW, bottom, top, fontPx: fs };
}

/** Draw the text strip into a W×H canvas context (cleared by the caller). */
export function drawTextStrip(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: Strip, W: number, H: number, k = 1) {
  const L = layoutTextStrip(s, W, H, k);
  const fs = L.fontPx;
  const Y = (y: number) => H - y;
  g.save();
  g.font = fontFor(s, fs);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  if (s.use_box) {
    const m = (s.box_margin ?? 0.01) * W;
    const pad = 0.1 * fs;
    const x0 = L.left - m,
      x1 = L.right + m,
      y0 = L.bottom - m - pad,
      y1 = L.top + m + pad;
    g.fillStyle = css(s.box_color, 'rgba(48, 49, 51,0.7)');
    const r = Math.max(0, Math.min(1, s.box_roundness ?? 0)) * Math.min(x1 - x0, y1 - y0) * 0.5;
    g.beginPath();
    if (r > 0 && 'roundRect' in g) (g as CanvasRenderingContext2D).roundRect(x0, Y(y1), x1 - x0, y1 - y0, r);
    else g.rect(x0, Y(y1), x1 - x0, y1 - y0);
    g.fill();
  }
  if (s.use_shadow) {
    const d = (s.shadow_offset ?? 0.04) * fs;
    const a = s.shadow_angle ?? (65 * Math.PI) / 180;
    const dx = Math.cos(a) * d,
      dy = Math.sin(a) * d; // positive: down
    g.save();
    g.fillStyle = css(s.shadow_color, 'rgba(0, 0, 0,0.7)');
    const blur = (s.shadow_blur ?? 0) * fs * 0.5;
    if (blur > 0) g.filter = `blur(${blur}px)`;
    for (const l of L.lines) g.fillText(l.text, l.x + dx, Y(l.baseline) + dy);
    g.restore();
  }
  if (s.use_outline) {
    g.save();
    g.strokeStyle = css(s.outline_color, 'rgba(0, 0, 0,0.7)');
    g.lineJoin = 'round';
    g.lineWidth = Math.max(0.5, (s.outline_width ?? 0.05) * fs * 0.8);
    for (const l of L.lines) g.strokeText(l.text, l.x, Y(l.baseline));
    g.restore();
  }
  g.fillStyle = css(s.color, '#ffffff');
  for (const l of L.lines) g.fillText(l.text, l.x, Y(l.baseline));
  g.restore();
  return L;
}
