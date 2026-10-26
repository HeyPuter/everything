// A sheet (a single page or a spread) drawn at any size: the trim box is the size container, elements sit in fractions
// of it and may run into the 3 mm bleed. Used by the editor stage, page thumbnails and the print document.
import { el } from '../../../ui/dom.js';
import { BLEED_MM, SAFE_MM, sheetSize } from '../../../lib/book/formats.js';
import { elementsOf } from '../../../lib/book/model.js';
import { renderElement } from './elements.js';
import { applyPalette, paint } from './palette.js';

/**
 * `mode`: `edit` (bleed visible, guides), `thumb` (trimmed, thumbnails) or `print` (bleed kept, no guides).
 * `ctx()` returns the shared render context `{space, entries, stats, shapes, travelKey, track}`.
 * Returns `{element, nodes, update(page, {overrides}), destroy()}`.
 */
export function createSheet({ book, page, mode = 'edit', ctx, palette, decorate }) {
  const size = sheetSize(book, page.kind);
  const trim = el('div.bk-trim');
  const bleed = el('div.bk-bleed', {}, trim);
  const element = el('div.bk-sheet', { dataset: { kind: page.kind, mode }, style: { aspectRatio: `${size.w} / ${size.h}` } }, bleed);
  bleed.style.inset = `${(-BLEED_MM / size.h) * 100}% ${(-BLEED_MM / size.w) * 100}%`;
  trim.style.inset = `${(BLEED_MM / (size.h + 2 * BLEED_MM)) * 100}% ${(BLEED_MM / (size.w + 2 * BLEED_MM)) * 100}%`;
  if (mode === 'edit') {
    const sx = `${(SAFE_MM / size.w) * 100}%`;
    const sy = `${(SAFE_MM / size.h) * 100}%`;
    const guides = el('div.bk-guides', { 'aria-hidden': 'true' }, el('span.bk-safe', { style: { inset: `${sy} ${sx}` } }));
    if (page.kind === 'spread') {
      guides.append(el('span.bk-gutter'), el('span.bk-safe', { style: { inset: `${sy} calc(50% + ${sx}) ${sy} ${sx}` } }), el('span.bk-safe', { style: { inset: `${sy} ${sx} ${sy} calc(50% + ${sx})` } }));
      guides.firstElementChild.remove();
    }
    element.append(guides);
  }
  if (palette) applyPalette(element, palette);
  const nodes = new Map();
  let current = page;

  function update(next = current, { overrides = null } = {}) {
    current = next;
    bleed.style.background = paint(current.bg ?? book.bg, 'surface');
    const base = { ...ctx(), sheet: size, page: current, thumbs: mode === 'thumb', print: mode === 'print' };
    const seen = new Set();
    let index = 0;
    for (const item of elementsOf(current)) {
      const shown = overrides?.has(item.id) ? { ...item, ...overrides.get(item.id) } : item;
      const node = renderElement(nodes.get(item.id), shown, base);
      if (!nodes.has(item.id)) nodes.set(item.id, node);
      decorate?.(node, shown);
      // Moving a node drops its focus, so only nodes out of place move.
      if (trim.children[index] !== node) trim.insertBefore(node, trim.children[index] ?? null);
      index += 1;
      seen.add(item.id);
    }
    for (const [id, node] of nodes) if (!seen.has(id)) { node.remove(); nodes.delete(id); }
  }

  update(page);
  return {
    element, nodes, trim, size,
    get page() { return current; },
    update,
    setPalette(next) { applyPalette(element, next); },
    destroy() { element.remove(); nodes.clear(); },
  };
}
