// A one-device-pixel white surround keeps the existing blue insertion caret
// visible on dark shading and artwork without reading back the painted canvas.
// This is an editing overlay, independent of document ink and export geometry.
export function paintInsertionCaret(ctx, caret, scale, clip) {
  const width = caret.width ?? 1.5;
  if (!(width > 0 && caret.height > 0)) return;
  const edge = 1 / scale;
  ctx.save();
  if (clip) {
    ctx.beginPath(); ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top); ctx.clip();
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(caret.x - edge, caret.y - edge, width + 2 * edge, caret.height + 2 * edge);
  ctx.fillStyle = '#375f91';
  ctx.fillRect(caret.x, caret.y, width, caret.height);
  ctx.restore();
}

// Text an input method is still composing is underlined, as native fields mark it, so the part a
// conversion or commit will change stands apart from the committed text around it. The line sits
// just below the baseline of the text it marks (rects from selectionRects, one per line).
export function paintCompositionUnderline(ctx, rects, lines, page, scale) {
  const thickness = Math.max(1, Math.round(scale)) / scale;
  ctx.save();
  ctx.fillStyle = '#3c4043';
  for (const rect of rects) {
    if (rect.page !== page || !(rect.width > 0)) continue;
    const line = lines.find(l => l.page === page && !l.cellText && l.y <= rect.y + 1e-6 && rect.y < l.y + l.height);
    const bottom = rect.y + rect.height - thickness;
    const y = line ? Math.min(line.baseline + Math.max(2, thickness * 2), bottom) : bottom;
    ctx.fillRect(rect.x, y, rect.width, thickness);
  }
  ctx.restore();
}
