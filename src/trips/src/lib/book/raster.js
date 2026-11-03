// Drawing a sheet onto a canvas for image export, matching the on-screen rendering (see views/journey/book/sheet.js).
import { PT_MM } from './formats.js';
import { elementsOf } from './model.js';

export const LINE_HEIGHT = 1.25;
export const FONT_STACKS = Object.freeze({
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive',
});
export const STYLE_WEIGHTS = Object.freeze({ title: 700, heading: 650, subtitle: 500, body: 400, caption: 400, quote: 400 });
export const FILTER_CSS = Object.freeze({
  none: 'none', bw: 'grayscale(1)', sepia: 'sepia(0.75)', warm: 'sepia(0.25) saturate(1.25)', cool: 'hue-rotate(-12deg) saturate(0.9) brightness(1.03)',
  fade: 'contrast(0.85) brightness(1.08) saturate(0.75)', vivid: 'saturate(1.45) contrast(1.06)',
});
export const DEFAULT_TEXT_SIZE = 12;

/**
 * Where a photo lands inside its box, like CSS `object-fit` (fill = cover, fit = contain) with `object-position` at
 * the focal point, then scaled by `zoom` around that point. Returns `{x, y, w, h}` relative to the box.
 */
export function photoRect(image, box, { fit = 'fill', fx = 0.5, fy = 0.5, zoom = 1 } = {}) {
  if (!(image.w > 0 && image.h > 0 && box.w > 0 && box.h > 0)) return { x: 0, y: 0, w: box.w, h: box.h };
  const scale = fit === 'fit' ? Math.min(box.w / image.w, box.h / image.h) : Math.max(box.w / image.w, box.h / image.h);
  const w0 = image.w * scale;
  const h0 = image.h * scale;
  const x0 = (box.w - w0) * fx;
  const y0 = (box.h - h0) * fy;
  const ox = box.w * fx;
  const oy = box.h * fy;
  return { x: ox + (x0 - ox) * zoom, y: oy + (y0 - oy) * zoom, w: w0 * zoom, h: h0 * zoom };
}

/** Lines of `text` that fit `width`, breaking at spaces and inside words that are too long. `measure(s)` → width. */
export function wrapText(text, width, measure) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
      if (/^\s+$/.test(token)) { if (line) line += token; continue; }
      if (measure((line + token).trimEnd()) <= width) { line += token; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      if (measure(token) <= width) { line = token; continue; }
      for (const char of token) {
        if (line && measure(line + char) > width) { lines.push(line); line = ''; }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export const fontFor = (item, px) => `${item.italic || item.style === 'quote' ? 'italic ' : ''}${item.bold ? 700 : STYLE_WEIGHTS[item.style] ?? 400} ${px}px ${FONT_STACKS[item.font] ?? FONT_STACKS.sans}`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else ctx.rect(x, y, w, h);
}

/**
 * Paints one sheet. `size` is the sheet's trim size in mm, `pxPerMm` the resolution, `bleed` mm drawn around the trim,
 * `color(name)` a palette lookup (null for none), and `content(item)` the loaded `{image, w, h}` or `{text}` of an
 * element (photos, SVG-drawn travel elements and icons, stats text).
 */
export function paintSheet(ctx, page, { size, pxPerMm, bleed = 0, color, content, bg = 'surface' }) {
  const offset = bleed * pxPerMm;
  const width = (size.w + bleed * 2) * pxPerMm;
  const height = (size.h + bleed * 2) * pxPerMm;
  ctx.save();
  ctx.fillStyle = color(page.bg ?? bg) ?? color('surface') ?? 'white';
  ctx.fillRect(0, 0, width, height);
  for (const item of elementsOf(page)) {
    const x = offset + item.x * size.w * pxPerMm;
    const y = offset + item.y * size.h * pxPerMm;
    const w = item.w * size.w * pxPerMm;
    const h = item.h * size.h * pxPerMm;
    const radius = (item.radius ?? 0) * pxPerMm;
    const loaded = content(item) ?? {};
    ctx.save();
    ctx.globalAlpha = Number.isFinite(item.opacity) ? item.opacity : 1;
    if (item.k === 'photo') {
      if (loaded.image) {
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        const rect = photoRect({ w: loaded.w, h: loaded.h }, { w, h }, item);
        ctx.filter = FILTER_CSS[item.filter] ?? 'none';
        ctx.drawImage(loaded.image, x + rect.x, y + rect.y, rect.w, rect.h);
        ctx.filter = 'none';
        if (item.frame > 0) {
          const line = item.frame * pxPerMm;
          ctx.lineWidth = line * 2;
          ctx.strokeStyle = color(item.frameColor ?? 'surface') ?? 'white';
          roundRect(ctx, x, y, w, h, radius);
          ctx.stroke();
        }
      }
    } else if (item.k === 'flag') {
      if (loaded.text) {
        ctx.font = `${h * 0.8}px ${FONT_STACKS.sans}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(loaded.text, x + w / 2, y + h / 2);
      }
    } else if (item.k === 'text' || item.k === 'stats') {
      const words = item.k === 'text' ? item.text : loaded.text;
      if (words) {
        const px = (item.size ?? DEFAULT_TEXT_SIZE) * PT_MM * pxPerMm;
        ctx.font = fontFor(item, px);
        ctx.fillStyle = color(item.color ?? 'ink') ?? 'black';
        ctx.textBaseline = 'top';
        const align = item.align === 'center' ? 'center' : item.align === 'end' ? 'right' : 'left';
        ctx.textAlign = align;
        const anchor = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
        roundRect(ctx, x, y, w, h, 0);
        ctx.clip();
        const lines = wrapText(words, w, (value) => ctx.measureText(value).width);
        lines.forEach((line, index) => ctx.fillText(line, anchor, y + index * px * LINE_HEIGHT + (px * (LINE_HEIGHT - 1)) / 2));
      }
    } else if (item.k === 'shape') {
      const stroke = (item.stroke ?? 0) * pxPerMm;
      ctx.beginPath();
      if (item.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2 - stroke / 2), Math.max(0, h / 2 - stroke / 2), 0, 0, Math.PI * 2);
      else roundRect(ctx, x + stroke / 2, y + stroke / 2, Math.max(0, w - stroke), Math.max(0, h - stroke), radius);
      const fill = color(item.fill ?? 'surface-2');
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke > 0 && color(item.color ?? 'ink')) { ctx.lineWidth = stroke; ctx.strokeStyle = color(item.color ?? 'ink'); ctx.stroke(); }
    } else if (item.k === 'line') {
      const stroke = Math.max(0.1, item.stroke ?? 0.5) * pxPerMm;
      ctx.fillStyle = color(item.color ?? 'ink') ?? 'black';
      ctx.fillRect(x, y + h / 2 - stroke / 2, w, stroke);
    } else if (loaded.image) {
      ctx.drawImage(loaded.image, x, y, w, h);
    }
    ctx.restore();
  }
  ctx.restore();
}
