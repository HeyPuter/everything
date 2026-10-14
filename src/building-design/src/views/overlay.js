/**
 * Overlay drawing helpers (Canvas 2D, CSS pixels): text of view graphics,
 * snap markers, previews, temporary dimensions and grips.
 */

/** Draw text items of a 2D layer. toScreen maps model points to CSS px. */
export function drawLayerTexts(ctx, layer, toScreen, zoom, theme, flagsOf, viewRot = 0) {
  const texts = layer.texts();
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  for (const t of texts) {
    const px = t.size * zoom;
    if (px < 3.2 || px > 600) continue;
    const s = toScreen(t.at);
    if (s.x < -400 || s.y < -200 || s.x > W + 400 || s.y > H + 200) continue;
    const flags = flagsOf(t.id);
    if (flags & 4) continue;
    let color = t.color ? `rgb(${t.color[0]},${t.color[1]},${t.color[2]})` : theme.inkCss;
    if (flags & 1) color = theme.selCss;
    else if (flags & 2) color = theme.selCss;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(-(t.rot || 0) - viewRot);
    ctx.font = `${t.bold ? '600 ' : ''}${px.toFixed(1)}px ${theme.font}`;
    ctx.textAlign = t.align || 'center';
    ctx.textBaseline = t.baseline === 'bottom' ? 'alphabetic' : t.baseline || 'middle';
    if (flags & 8) ctx.globalAlpha = 0.45;
    if (flags & 16) ctx.globalAlpha = 0.25;
    const lines = String(t.text).split('\n');
    const lh = px * 1.25;
    const y0 = -((lines.length - 1) * lh) / 2;
    if (t.mask) {
      ctx.fillStyle = theme.bgCss;
      for (let i = 0; i < lines.length; i++) {
        const w = ctx.measureText(lines[i]).width;
        const x0 = ctx.textAlign === 'center' ? -w / 2 : ctx.textAlign === 'right' ? -w : 0;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(x0 - 2, y0 + i * lh - px * 0.6, w + 4, px * 1.2);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fillStyle = color;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, y0 + i * lh);
    ctx.restore();
  }
}

/** Snap marker shapes (screen px). */
export function drawSnapMarker(ctx, s, kind, color, label) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  const r = 6;
  ctx.beginPath();
  switch (kind) {
    case 'endpoint':
      ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
      break;
    case 'midpoint':
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r, s.y + r * 0.8);
      ctx.lineTo(s.x - r, s.y + r * 0.8);
      ctx.closePath();
      break;
    case 'intersection':
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      break;
    case 'center':
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.moveTo(s.x - 2, s.y);
      ctx.lineTo(s.x + 2, s.y);
      break;
    case 'perpendicular':
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x, s.y);
      ctx.lineTo(s.x, s.y + r);
      break;
    case 'nearest':
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.closePath();
      break;
    default:
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x + r, s.y);
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y + r);
  }
  ctx.stroke();
  if (label) {
    ctx.font = `11px system-ui, sans-serif`;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    roundRect(ctx, s.x + 10, s.y + 10, w + 10, 18, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, s.x + 15, s.y + 19);
  }
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A label in a rounded box (temporary dimensions, readouts). */
export function drawTag(ctx, x, y, text, { bg = '#ffffff', fg = '#15191f', border = '#2563eb', active = false } = {}) {
  ctx.save();
  ctx.font = `${active ? '600 ' : ''}12px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** A temporary dimension between two screen points with a label. */
export function drawTempDim(ctx, a, b, text, color, theme, offset = 18) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 4) return null;
  const nx = -dy / L;
  const ny = dx / L;
  const A = { x: a.x + nx * offset, y: a.y + ny * offset };
  const B = { x: b.x + nx * offset, y: b.y + ny * offset };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(a.x + nx * 4, a.y + ny * 4);
  ctx.lineTo(A.x + nx * 4, A.y + ny * 4);
  ctx.moveTo(b.x + nx * 4, b.y + ny * 4);
  ctx.lineTo(B.x + nx * 4, B.y + ny * 4);
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.stroke();
  for (const P of [A, B]) {
    ctx.beginPath();
    ctx.moveTo(P.x - 4, P.y + 4);
    ctx.lineTo(P.x + 4, P.y - 4);
    ctx.stroke();
  }
  ctx.restore();
  return drawTag(ctx, (A.x + B.x) / 2 + nx * 4, (A.y + B.y) / 2 + ny * 4, text, { bg: theme.bgCss, fg: theme.inkCss, border: color });
}

export function drawGrip(ctx, s, color, shape = 'square', active = false) {
  ctx.save();
  ctx.fillStyle = active ? color : '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
  else if (shape === 'diamond') {
    ctx.moveTo(s.x, s.y - 6);
    ctx.lineTo(s.x + 6, s.y);
    ctx.lineTo(s.x, s.y + 6);
    ctx.lineTo(s.x - 6, s.y);
    ctx.closePath();
  } else ctx.rect(s.x - 4.5, s.y - 4.5, 9, 9);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Two opposing arrows (flip control). */
export function drawFlipArrows(ctx, s, angle, color) {
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-9, -3);
  ctx.lineTo(-9, -7);
  ctx.lineTo(-14, 0);
  ctx.lineTo(-9, 7);
  ctx.lineTo(-9, 3);
  ctx.lineTo(9, 3);
  ctx.lineTo(9, 7);
  ctx.lineTo(14, 0);
  ctx.lineTo(9, -7);
  ctx.lineTo(9, -3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Polyline in screen space (from model points). */
export function strokeModel(ctx, pts, toScreen, color, width = 1.5, dash = null, close = false) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(p);
    if (i) ctx.lineTo(s.x, s.y);
    else ctx.moveTo(s.x, s.y);
  });
  if (close) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

export function fillModel(ctx, pts, toScreen, color, alpha = 0.15) {
  if (pts.length < 3) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(p);
    if (i) ctx.lineTo(s.x, s.y);
    else ctx.moveTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
