import { pageBounds, offsetPage } from './page-bounds.js';
import { floatingTableX, floatingTableY } from './floating-tables.js';
import { shiftTableItem } from './table-overlap.js';
import { tableBorderWidth } from './table-border-layout.js';

export class UnsupportedFloatingTableFlowError extends Error {
  constructor(message, tableId) { super(message); this.tableId = tableId; }
}

export function floatingFragmentBounds(cells, modern, table) {
  const edge = (cell, side) => tableBorderWidth(cell.borders?.[side]) / 2;
  const bottom = Math.max(...cells.map(c => c.y + c.height));
  return {
    // Borderless frames retain a one-pixel side clearance; modern numeric
    // positions already identify the leading outside edge of that frame.
    left: Math.min(...cells.map(c => c.x - (edge(c, 'left') || (modern ? 0 : 1)))),
    right: Math.max(...cells.map(c => c.x + c.width + (edge(c, 'right') || 1))),
    top: Math.min(...cells.map(c => c.y - edge(c, 'top'))),
    bottom: Math.max(...cells.map(c => c.y + c.height + (Math.abs(c.y + c.height - bottom) < 1e-6
      ? tableBorderWidth(c.pageBottomBorder ?? c.borders?.bottom ?? table.borders?.bottom) - (c.borderInsets?.bottom || 0) : 0))),
  };
}

export function floatingTableInset(cells, table, modern) {
  const first = cells.find(cell => cell.tableId === table.id);
  return modern ? tableBorderWidth(first.borders?.left) / 2 : -first.margins.left / 15;
}

// A multi-page floating table is paginated at its source position, then
// resumes regular paragraphs on the final fragment's page. The logical anchor
// paragraph can consequently end up on a different page from the first fragment.
export function paginateFloatingFlow(floating, page, maxPages, cursor, paginate, pageSideIndex = 0) {
  const position = floating.table.floating;
  const natural = floating.natural ||= paginate(floating.blocks, { ...page, pageBounds: undefined, height: 1e9, top: 0, bottom: 0 }, maxPages, 0);
  let y = floatingTableY(position, page, natural.endY, { y: cursor });
  // Retain the established single-page positioning path, including floats that
  // extend into the bottom margin. Only page-spanning tables consume flow pages.
  const probe = paginate(floating.blocks, { ...page, pageBounds: undefined, top: Math.min(0, y), bottom: 0 }, maxPages, y);
  floating.probe = { y, result: probe };
  if (probe.pageCount === 1) return null;
  // Keep the prior safe fallback until these combinations have native geometry
  // and editing coverage. Their single-page behavior stays on the existing path.
  if (floating.flowCount > 1 && floating.flowCollisionRestricted || page.bookFold || page.mirror || page.storyKind || position.tblpYSpec) {
    throw new UnsupportedFloatingTableFlowError('Multi-page floating tables with aligned positions, prohibited table overlap, booklet pages or header/footer anchors are not supported yet.', floating.table.id);
  }
  const modern = (page.compatibilityMode ?? 12) >= 15;
  let dx = floatingTableInset(probe.cells, floating.table, modern);
  const leading = Number(modern && position.vertAnchor !== 'text' && cursor > pageBounds(page).top + 1e-6 && y < cursor - 1e-6);
  if (leading >= maxPages) throw new Error('Floating table exceeds the page limit.');
  const flowPage = offsetPage(page, leading);
  // Measurement follows the logical anchor, which may be on the last fragment.
  // Resolve the side from the first physical fragment and retain it throughout.
  if (position.tblpXSpec) dx += floatingTableX(position, flowPage, floating.alignmentWidth, pageSideIndex + leading)
    - floatingTableX(position, floating.page, floating.alignmentWidth, floating.measuredPageIndex);
  const translated = !modern && position.vertAnchor !== 'text';
  // Page/margin positions cannot put the first ordinary-sized fragment beyond
  // the paper edge. That limit is established using a full writing-area
  // fragment, before applying the modern offset-dependent row cut.
  let ordinary;
  if (position.vertAnchor !== 'text') {
    ordinary = paginate(floating.blocks, flowPage, maxPages - leading, pageBounds(flowPage).top);
    const first = ordinary.cells.filter(cell => cell.tableId === floating.table.id && cell.page === 0);
    if (first.length) y = Math.min(y, flowPage.height - (floatingFragmentBounds(first, modern, floating.table).bottom - pageBounds(flowPage).top));
  }
  const initial = translated ? pageBounds(flowPage).top : Math.max(pageBounds(flowPage).top, y);
  const result = ordinary && initial === pageBounds(flowPage).top ? ordinary : paginate(floating.blocks, flowPage, maxPages - leading, initial);
  const dy = y - initial;
  const shifted = Object.fromEntries(['lines', 'cells', 'repeatedLines'].map(key =>
    [key, result[key].map(item => ({ ...shiftTableItem(item, dx, item.page === 0 ? dy : 0), page: item.page + leading }))]));
  const frames = [];
  for (let index = leading; index < result.pageCount + leading; index++) {
    const cells = shifted.cells.filter(cell => cell.tableId === floating.table.id && cell.page === index);
    if (!cells.length) continue;
    const bottom = Math.max(...cells.map(c => c.y + c.height));
    for (const cell of cells) if (Math.abs(cell.y + cell.height - bottom) < 1e-6 && !cell.pageBottomBorder && !cell.borders?.bottom) {
      cell.pageBottomBorder = floating.table.borders?.bottom;
    }
    frames.push({ tableId: floating.table.id, page: index, start: floating.start,
      left: Math.min(...cells.map(c => c.x)), right: Math.max(...cells.map(c => c.x + c.width)),
      top: Math.min(...cells.map(c => c.y)), bottom: Math.max(...cells.map(c => c.y + c.height)),
      wrapBounds: floatingFragmentBounds(cells, modern, floating.table), position, overlap: floating.table.overlap });
  }
  return { ...result, ...shifted, pageCount: result.pageCount + leading, floatingTables: frames };
}
