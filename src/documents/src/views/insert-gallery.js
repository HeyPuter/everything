import { el } from '../ui/dom.js';
import { closeMenu } from '../ui/menu.js';

/**
 * Ribbon galleries for the Insert tab: drop-down menus whose choices are previews in a grid
 * (cover pages, headers, text boxes, WordArt, page numbers, equations). Each preview is a small,
 * original drawing of what the choice inserts. The grid takes the menu's arrow-key navigation
 * (menu.js moves within `.menu-custom-grid[data-columns]`), Enter chooses, and Escape closes.
 *
 * sections: [{ header?, columns?, items: [{ label, hint?, preview: Node, onSelect, disabled?, selected? }] }]
 * Returns openMenu items; plain menu items can follow them.
 */
export function galleryItems(sections, { columns = 3, size = 'medium', label = 'Gallery' } = {}) {
  return sections.flatMap(section => {
    if (!section.items.length) return [];
    const cols = section.columns || columns;
    const grid = el(`div.menu-custom-grid.insert-gallery.is-${section.size || size}`, { role: 'group', 'aria-label': section.header || label, dataset: { columns: String(cols) }, style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } },
      ...section.items.map(item => {
        const button = el('button.swatch.insert-gallery-item', { type: 'button', role: 'menuitem', tabindex: -1, disabled: !!item.disabled, 'aria-label': item.hint ? `${item.label}: ${item.hint}` : item.label,
          title: item.hint ? `${item.label}\n${item.hint}` : item.label, 'aria-current': item.selected ? 'true' : null,
          onclick: () => { closeMenu(); item.onSelect(); } },
        el('span.insert-gallery-preview', { 'aria-hidden': 'true' }, item.preview || null), el('span.insert-gallery-label', {}, item.label));
        return button;
      }));
    return [...(section.header ? [{ header: section.header }] : []), { custom: grid }];
  });
}

/** A miniature page drawn in SVG (8.5 × 11 proportions) from lines: [{ y, h, w, x?, color, align? }] in page percent. */
export function pagePreview(lines = [], { width = 64, background = '#ffffff', bands = [] } = {}) {
  const height = Math.round(width * 11 / 8.5);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 85 110'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  svg.classList.add('insert-page-preview');
  const add = (name, attrs) => { const node = document.createElementNS(ns, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); svg.append(node); return node; };
  add('rect', { x: 0.5, y: 0.5, width: 84, height: 109, rx: 2, fill: background, stroke: 'var(--hairline, #c8c8c8)' });
  for (const band of bands) add('rect', { x: band.x ?? 0.5, y: band.y, width: band.w ?? 84, height: band.h, fill: band.color, ...(band.stroke ? { stroke: band.stroke, 'stroke-width': band.strokeWidth || 1, fill: band.color || 'none' } : {}) });
  for (const line of lines) {
    const w = line.w, x = line.x ?? (line.align === 'center' ? (85 - w) / 2 : line.align === 'right' ? 85 - 10 - w : 10);
    add('rect', { x, y: line.y, width: w, height: line.h, rx: Math.min(1, line.h / 2), fill: line.color });
  }
  return svg;
}

/** A small text sample drawn as an element with its own styles (used for WordArt, symbols and numbering previews). */
export function textPreview(text, style = {}) {
  return el('span.insert-text-preview', { style }, text);
}
