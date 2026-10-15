// Text strip rasterisation (2D canvas, bundled Inter font). Geometry:
// font_size is the em size in output pixels, the anchor box spans ascent 0.96 em / descent
// 0.24 em around the baseline, lines advance 1.16 em, shadow_offset and outline_width are
// relative to the font size and box_margin to the image width.
import type { Strip } from './types';

const ASC = 0.96,
  DESC = 0.24,
  LINE = 1.16;

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

export function fontFor(s: Strip, px: number) {
  return `${s.use_italic ? 'italic ' : ''}${s.use_bold ? 600 : 400} ${px}px Inter, system-ui, sans-serif`;
}

/** Word-wrap `text` to lines no wider than `maxWidth` (explicit newlines kept). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line && measure(next.trimEnd()) > maxWidth && w.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface TextLayoutBox {
  lines: { text: string; x: number; baseline: number; width: number }[];
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
  const lines = wrapLines(s.text ?? '', maxW, (t) => g.measureText(t).width);
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
    return { text, x, baseline: top - ASC * fs - i * lh, width: w };
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
    g.fillStyle = css(s.box_color, 'rgba(51,51,51,0.7)');
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
    g.fillStyle = css(s.shadow_color, 'rgba(0,0,0,0.7)');
    const blur = (s.shadow_blur ?? 0) * fs * 0.5;
    if (blur > 0) g.filter = `blur(${blur}px)`;
    for (const l of L.lines) g.fillText(l.text, l.x + dx, Y(l.baseline) + dy);
    g.restore();
  }
  if (s.use_outline) {
    g.save();
    g.strokeStyle = css(s.outline_color, 'rgba(0,0,0,0.7)');
    g.lineJoin = 'round';
    g.lineWidth = Math.max(0.5, (s.outline_width ?? 0.05) * fs * 0.8);
    for (const l of L.lines) g.strokeText(l.text, l.x, Y(l.baseline));
    g.restore();
  }
  g.fillStyle = css(s.color, '#fff');
  for (const l of L.lines) g.fillText(l.text, l.x, Y(l.baseline));
  g.restore();
  return L;
}
