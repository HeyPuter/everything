// Screen-only cues for header/footer editing: the inactive layer is dimmed,
// and while a header or footer is
// active, dashed boundaries with "Header"/"Footer" tags (in the margin) mark both areas.
const TAG_FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
const ACCENT = '#2B579A';

/** Vertical extent of the header and footer areas on a page, in page pixels. */
export function storyBoundaries(geometry, lines, kindOf) {
  let header = geometry.top, footer = geometry.height - geometry.bottom;
  for (const line of lines) {
    const kind = kindOf(line.pageStory);
    if (kind === 'header') header = Math.max(header, line.y + line.height);
    else if (kind === 'footer') footer = Math.min(footer, line.y);
  }
  return { header, footer };
}

/** Paint the cues for one page. `active` is 'body', 'header' or 'footer'. */
export function paintStoryChrome(ctx, geometry, { header, footer }, active) {
  ctx.save();
  // Fade the inactive content toward the page colour, so a coloured page keeps one colour.
  const dim = (y, height) => { ctx.save(); ctx.globalAlpha = .52; ctx.fillStyle = geometry.background || '#FFFFFF'; ctx.fillRect(0, y, geometry.width, height); ctx.restore(); };
  if (active === 'body') {
    dim(0, header);
    dim(footer, geometry.height - footer);
  } else {
    dim(header, footer - header);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    for (const y of [header, footer]) { ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(geometry.width, Math.round(y) + .5); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.font = TAG_FONT;
    for (const [label, y, below] of [['Header', header, true], ['Footer', footer, false]]) {
      const width = ctx.measureText(label).width + 12, x = geometry.left > width + 12 ? 6 : Math.max(4, geometry.left - 8), top = below ? y + 1 : y - 18;
      ctx.fillStyle = '#E8EEF7'; ctx.fillRect(x, top, width, 17);
      ctx.strokeStyle = ACCENT; ctx.strokeRect(x + .5, top + .5, width - 1, 16);
      ctx.fillStyle = ACCENT; ctx.textBaseline = 'middle'; ctx.fillText(label, x + 6, top + 9);
    }
  }
  ctx.restore();
}
