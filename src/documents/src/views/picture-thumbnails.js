import { el } from '../ui/dom.js';
import { resolveColor } from './picture-presets.js';

/**
 * Gallery previews for Picture Format and Shape Format: small canvases drawn from the selected picture
 * (corrections, colour, artistic effects, transparency, styles) or from a style's colours. They are
 * approximations for choosing; the document shows the real result once a preset is applied.
 */
const ratio = () => Math.min(2, window.devicePixelRatio || 1);
export function thumbCanvas(width = 64, height = 48) {
  const canvas = el('canvas', { 'aria-hidden': 'true', width: Math.round(width * ratio()), height: Math.round(height * ratio()) });
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx?.scale(ratio(), ratio());
  return { canvas, ctx, width, height };
}

/** The picture's pixels as a drawable source: an ImageBitmap/canvas from the editor's decoded images. */
export function pictureSource(editor, image) {
  // A styled picture is a drawing scene: preview the picture inside it, not the framed result.
  const find = node => !node ? null : node.type === 'picture' && node.image?.assetId ? node.image.assetId : (node.children || []).map(find).find(Boolean) || null;
  const id = image?.retainedDrawing ? find(editor?.model?.assets[image.assetId]?.scene) || image.assetId : image?.assetId;
  const entry = editor?.images?.get(id);
  const source = entry?.bitmap || entry;
  if (!source || source.previewPlaceholder || !(source.width > 0)) return null;
  return source;
}

/** Draw the picture contained in a w × h box (letterboxed), with an optional canvas filter. */
function drawPicture(ctx, source, w, h, { filter = 'none', alpha = 1, inset = 4 } = {}) {
  const scale = Math.min((w - inset * 2) / source.width, (h - inset * 2) / source.height);
  const dw = source.width * scale, dh = source.height * scale, x = (w - dw) / 2, y = (h - dh) / 2;
  ctx.save(); ctx.filter = filter; ctx.globalAlpha = alpha;
  ctx.drawImage(source, x, y, dw, dh);
  ctx.restore();
  return { x, y, width: dw, height: dh };
}
const checker = (ctx, w, h) => {
  ctx.save(); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#e4e4e4';
  for (let y = 0; y < h; y += 6) for (let x = (y / 6) % 2 ? 6 : 0; x < w; x += 12) ctx.fillRect(x, y, 6, 6);
  ctx.restore();
};

/** A preview of the picture through a CSS-style filter (brightness, contrast, saturate, grayscale, sepia…). */
export function filteredThumb(source, filter, { width = 64, height = 48, alpha = 1 } = {}) {
  const { canvas, ctx, width: w, height: h } = thumbCanvas(width, height);
  if (!ctx) return canvas;
  if (alpha < 1) checker(ctx, w, h);
  if (source) drawPicture(ctx, source, w, h, { filter, alpha });
  else { ctx.fillStyle = '#c7d3e3'; ctx.fillRect(4, 4, w - 8, h - 8); }
  return canvas;
}

/** A preview with a pixel effect applied to a small copy of the picture (artistic effects, temperature). */
export function processedThumb(source, apply, { width = 64, height = 48 } = {}) {
  const { canvas, ctx, width: w, height: h } = thumbCanvas(width, height);
  if (!ctx || !source) return filteredThumb(source, 'none', { width, height });
  const scale = Math.min((w - 8) / source.width, (h - 8) / source.height) * ratio();
  const sw = Math.max(1, Math.round(source.width * scale)), sh = Math.max(1, Math.round(source.height * scale));
  const work = new OffscreenCanvas(sw, sh), wctx = work.getContext('2d');
  wctx.drawImage(source, 0, 0, sw, sh);
  try {
    const data = wctx.getImageData(0, 0, sw, sh);
    const result = apply({ data: data.data, width: sw, height: sh });
    wctx.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  } catch { /* A preview that cannot be processed shows the picture unchanged. */ }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(work, (canvas.width - sw) / 2, (canvas.height - sh) / 2);
  ctx.restore();
  return canvas;
}

/** A preview of a picture style: frame geometry, outline, shadow, glow, soft edge, reflection. */
export function styleThumb(source, style, theme, { width = 64, height = 48 } = {}) {
  const { canvas, ctx, width: w, height: h } = thumbCanvas(width, height);
  if (!ctx) return canvas;
  const reflect = !!style.effects?.reflection;
  const box = { x: 10, y: 7, width: w - 20, height: reflect ? h - 22 : h - 14 };
  const path = new Path2D();
  const r = Math.min(box.width, box.height);
  if (style.geometry === 'ellipse') path.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
  else if (style.geometry === 'roundRect') path.roundRect(box.x, box.y, box.width, box.height, r * 0.18);
  else if (style.geometry === 'hexagon') { const q = box.width * 0.22; path.moveTo(box.x + q, box.y); path.lineTo(box.x + box.width - q, box.y); path.lineTo(box.x + box.width, box.y + box.height / 2); path.lineTo(box.x + box.width - q, box.y + box.height); path.lineTo(box.x + q, box.y + box.height); path.lineTo(box.x, box.y + box.height / 2); path.closePath(); }
  else if (style.geometry === 'snip2DiagRect') { const q = r * 0.2; path.moveTo(box.x + q, box.y); path.lineTo(box.x + box.width, box.y); path.lineTo(box.x + box.width, box.y + box.height - q); path.lineTo(box.x + box.width - q, box.y + box.height); path.lineTo(box.x, box.y + box.height); path.lineTo(box.x, box.y + q); path.closePath(); }
  else path.rect(box.x, box.y, box.width, box.height);
  ctx.save();
  if (style.rotation) { ctx.translate(w / 2, h / 2); ctx.rotate((style.rotation - 360) * Math.PI / 180); ctx.translate(-w / 2, -h / 2); }
  const shadow = style.effects?.shadow, glow = style.effects?.glow;
  if (glow) { ctx.save(); ctx.shadowColor = `#${resolveColor(glow.color, theme)}`; ctx.shadowBlur = 8; ctx.fillStyle = '#fff'; ctx.fill(path); ctx.restore(); }
  if (shadow) { ctx.save(); ctx.shadowColor = `rgba(0,0,0,${shadow.alpha ?? 0.4})`; ctx.shadowBlur = Math.max(2, shadow.blur / 12700 / 1.5); ctx.shadowOffsetX = Math.cos(shadow.direction * Math.PI / 180) * shadow.distance / 12700 / 2; ctx.shadowOffsetY = Math.sin(shadow.direction * Math.PI / 180) * shadow.distance / 12700 / 2; ctx.fillStyle = '#fff'; ctx.fill(path); ctx.restore(); }
  ctx.save(); ctx.clip(path);
  if (source) {
    const scale = Math.max(box.width / source.width, box.height / source.height);
    const dw = source.width * scale, dh = source.height * scale;
    ctx.drawImage(source, box.x + (box.width - dw) / 2, box.y + (box.height - dh) / 2, dw, dh);
  } else { ctx.fillStyle = '#9fb6d6'; ctx.fill(path); }
  if (style.effects?.softEdge) { const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(box.width, box.height) * 0.25, w / 2, h / 2, Math.max(box.width, box.height) * 0.62); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,1)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
  if (style.bevel) { const g = ctx.createLinearGradient(box.x, box.y, box.x + box.width, box.y + box.height); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(0.25, 'rgba(255,255,255,0)'); g.addColorStop(0.75, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.45)'); ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.width, box.height); }
  ctx.restore();
  if (style.outline) {
    ctx.lineWidth = Math.max(1, Math.min(4, style.outline.width / 12700 / 2));
    ctx.strokeStyle = `#${resolveColor(style.outline.color, theme)}`;
    if (style.outline.color === 'FFFFFF') { ctx.save(); ctx.lineWidth += 1; ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.stroke(path); ctx.restore(); ctx.strokeStyle = '#fff'; }
    ctx.stroke(path);
    if (style.outline.compound === 'dbl') { ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke(path); ctx.restore(); }
  }
  ctx.restore();
  if (reflect && source) {
    ctx.save(); ctx.globalAlpha = 0.35; ctx.translate(0, (box.y + box.height) * 2 + 1); ctx.scale(1, -1); ctx.clip(path);
    const scale = Math.max(box.width / source.width, box.height / source.height);
    ctx.drawImage(source, box.x + (box.width - source.width * scale) / 2, box.y + (box.height - source.height * scale) / 2, source.width * scale, source.height * scale);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, box.y + box.height, 0, h);
    fade.addColorStop(0, 'rgba(255,255,255,0.2)'); fade.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = fade; ctx.fillRect(0, box.y + box.height + 1, w, h);
  }
  return canvas;
}

/** A preview of a shape style or fill: a rounded rectangle with the style's fill, outline and shadow. */
export function shapeStyleThumb(style, theme, { width = 44, height = 32, text = null } = {}) {
  const { canvas, ctx, width: w, height: h } = thumbCanvas(width, height);
  if (!ctx) return canvas;
  const x = 5, y = 5, bw = w - 10, bh = h - 10;
  const fill = style.fill;
  let paint = 'transparent';
  if (fill?.type === 'solid') paint = `#${resolveColor(fill.color, theme)}`;
  else if (fill?.type === 'gradient') {
    const g = fill.path ? ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, bw / 1.6) : ctx.createLinearGradient(x, y, fill.angle % 180 === 0 ? x + bw : x, fill.angle % 180 === 0 ? y : y + bh);
    for (const stop of fill.stops) g.addColorStop(stop.position / 100000, `#${resolveColor(stop.color, theme)}`);
    paint = g;
  } else if (fill?.type === 'pattern') paint = `#${resolveColor(fill.foreground, theme)}`;
  ctx.save();
  const shadow = style.effects?.shadow;
  if (shadow) { ctx.shadowColor = `rgba(0,0,0,${shadow.alpha ?? 0.4})`; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1.5; }
  ctx.beginPath(); ctx.roundRect(x, y, bw, bh, 3);
  ctx.fillStyle = paint; ctx.fill();
  ctx.restore();
  const line = style.outline;
  if (line && line.color !== 'none') { ctx.lineWidth = Math.max(1, Math.min(3, (line.width || 12700) / 12700)); ctx.strokeStyle = `#${resolveColor(line.color, theme)}`; ctx.beginPath(); ctx.roundRect(x, y, bw, bh, 3); ctx.stroke(); }
  if (text) {
    ctx.fillStyle = fill?.type === 'solid' && luminance(resolveColor(fill.color, theme)) < 0.5 ? '#fff' : '#222';
    ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, w / 2, h / 2 + 0.5);
  }
  return canvas;
}
export function luminance(hex) {
  if (!hex) return 1;
  const [r, g, b] = hex.match(/../g).map(c => parseInt(c, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A preview of a line: weight, dash and arrowheads. */
export function lineThumb({ width = 1, dash = 'solid', compound = 'sng', head = null, tail = null }, { w = 90, h = 14 } = {}) {
  const { canvas, ctx } = thumbCanvas(w, h);
  if (!ctx) return canvas;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ed-ink').trim() || '#222';
  ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = Math.max(0.75, Math.min(6, width));
  const pattern = { sysDot: [1, 1], sysDash: [3, 1], dash: [4, 3], dashDot: [4, 3, 1, 3], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3] }[dash];
  if (pattern) ctx.setLineDash(pattern.map(v => v * Math.max(1, ctx.lineWidth)));
  const y = h / 2, x0 = head ? 10 : 4, x1 = tail ? w - 10 : w - 4;
  const strokeAt = dy => { ctx.beginPath(); ctx.moveTo(x0, y + dy); ctx.lineTo(x1, y + dy); ctx.stroke(); };
  if (compound === 'dbl') { const lw = ctx.lineWidth; ctx.lineWidth = Math.max(0.75, lw / 3); strokeAt(-lw / 3); strokeAt(lw / 3); }
  else strokeAt(0);
  ctx.setLineDash([]);
  const arrow = (x, dir, type) => {
    ctx.beginPath();
    if (type === 'oval') ctx.ellipse(x + dir * 3, y, 3.5, 3.5, 0, 0, Math.PI * 2);
    else if (type === 'diamond') { ctx.moveTo(x + dir * 7, y); ctx.lineTo(x + dir * 3.5, y - 3.5); ctx.lineTo(x, y); ctx.lineTo(x + dir * 3.5, y + 3.5); }
    else { ctx.moveTo(x + dir * 8, y); ctx.lineTo(x - dir * 0, y - 4); ctx.lineTo(x + dir * (type === 'stealth' ? 3 : 0), y); ctx.lineTo(x, y + 4); }
    ctx.closePath();
    if (type === 'arrow') ctx.stroke(); else ctx.fill();
  };
  if (head) arrow(2, 1, head.type);
  if (tail) arrow(w - 2, -1, tail.type);
  return canvas;
}

/** A preview of a page with an object at one of nine positions and text wrapped around it. */
export function positionThumb(h, v, { width = 40, height = 52 } = {}) {
  const { canvas, ctx } = thumbCanvas(width, height);
  if (!ctx) return canvas;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b8c1cc'; ctx.lineWidth = 1;
  ctx.fillRect(0.5, 0.5, width - 1, height - 1); ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  const left = 6, top = 6, right = width - 6, bottom = height - 6, bw = 12, bh = 12;
  const bx = left + (right - left - bw) * h, by = top + (bottom - top - bh) * v;
  ctx.fillStyle = '#9aa6b5';
  for (let y = top; y < bottom - 1; y += 4) {
    const overlaps = y + 2 > by - 1 && y < by + bh + 1;
    if (!overlaps) ctx.fillRect(left, y, right - left, 1.5);
    else { if (bx - 2 > left) ctx.fillRect(left, y, bx - 2 - left, 1.5); if (bx + bw + 2 < right) ctx.fillRect(bx + bw + 2, y, right - bx - bw - 2, 1.5); }
  }
  ctx.fillStyle = '#3F6FB5'; ctx.fillRect(bx, by, bw, bh);
  return canvas;
}
