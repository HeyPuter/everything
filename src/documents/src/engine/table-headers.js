import { paragraphBorderInsets } from './paragraph-borders.js';
import { blockMinimumHeight, paragraphLayoutBlocks } from './block-layout.js';
import { paginateTableRows } from './table-pagination.js';
import { shiftCellClip } from './cell-clipping.js';
import { pageBounds, offsetPage } from './page-bounds.js';

/**
 * Measure the one source header. Repeated copies never enter document content. Null when the header
 * cannot repeat: rows too tall to leave a page room for the table body (or for one of its lines) are
 * laid out once, as ordinary rows, as Word does, rather than refusing the table.
 */
export function prepareTableHeader(rows, count, page, paginateText) {
  if (rows.slice(0, count).some((row, i) => row.cells.some(cell => i + cell.rowSpan > count))) throw new Error('A vertical merge cannot cross the repeated-header boundary. Include all of its rows in the header or split the merged cell.');
  const headerRows = rows.slice(0, count).map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell,
    page: { ...cell.page, height: 1e9, top: cell.margins.top / 15, bottom: cell.margins.bottom / 15 } })) }));
  const header = paginateTableRows(headerRows, { ...page, height: 1e9, top: 0, bottom: 0 }, 1, 0, paginateText);
  const body = rows.slice(count), height = header.endY, capacity = page.height - page.top - page.bottom;
  if (height > capacity + 1e-6 || body.length && height >= capacity - 1e-6) return null;
  for (const row of body) for (const cell of row.cells) {
    if (cell.page.clipOverflow) continue;
    const omitHeader = (page.compatibilityMode ?? 12) >= 15 && (row.fixedHeight ?? row.minimumHeight ?? row.minHeight / 15) > capacity - height + 1e-6;
    const available = capacity - (omitHeader ? 0 : height);
    for (const block of paragraphLayoutBlocks(cell.blocks)) if (block.lines.some(line => line.height + paragraphBorderInsets(block) + (cell.margins.top + cell.margins.bottom) / 15 > available + 1e-6)) return null;
  }
  const naturalMinimum = Math.max(0, ...(body[0]?.cells.map(c => blockMinimumHeight(c.blocks[0]) + (c.margins.top + c.margins.bottom) / 15) || []));
  const minimum = body[0]?.fixedHeight == null ? naturalMinimum : Math.min(body[0].fixedHeight, naturalMinimum, capacity - height);
  return { header, headerRows, rows: body, height, minimum };
}

export function paginateTableWithHeader(table, page, maxPages, startY, paginateText) {
  const { header, rows, height, minimum } = table;
  const bodyCapacity = part => { const b = pageBounds(page, part); return b.bottom - b.top - height; };
  const legacy = (page.compatibilityMode ?? 12) < 15;
  const oversized = (row, part = 0) => (row.fixedHeight ?? row.minimumHeight ?? row.minHeight / 15) > bodyCapacity(part) + 1e-6;
  if (!legacy && rows.length && (page.pageBounds || rows.some(row => oversized(row)))) return paginateVariableHeaders(table, page, maxPages, startY, paginateText, oversized);
  let firstPage = 0, top = startY;
  const advance = () => {
    if (++firstPage >= maxPages) throw new Error(`This preview supports up to ${maxPages} pages. Reduce the document length or adjust its formatting.`);
    top = pageBounds(page, firstPage).top;
  };
  if (top + height + minimum > pageBounds(page, firstPage).bottom + 1e-6) advance();
  const bodyPage = { ...page, top: page.top + height, tableBodyBelowHeader: true };
  const placeBody = () => {
    let hints;
    for (let pass = 0; pass <= rows.length + 1; pass++) {
      const bodyRows = rows.map((row, index) => {
        // Legacy compatibility modes retain the header over an oversized minimum-height row
        // and lays it on one page, allowing its extent past the paper.
        const unbroken = legacy && oversized(row, firstPage + (hints?.[index]?.start.page || 0)) && row.fixedHeight == null;
        const fixedHeight = unbroken ? Math.max(row.minimumHeight, row.height) : row.fixedHeight;
        return { ...row, fixedHeight, cells: row.cells.map(cell => ({ ...cell,
          page: { ...cell.page, top: cell.page.top + height, ...(unbroken ? { clipOverflow: true } : {}) } })) };
      });
      const result = bodyRows.length ? paginateTableRows(bodyRows, offsetPage(bodyPage, firstPage), maxPages - firstPage, top + height, paginateText) : { lines: [], cells: [], pageCount: 1, endY: top + height };
      if (!legacy || !page.pageBounds || rows.every((row, index) => row.fixedHeight != null || oversized(row, firstPage + (hints?.[index]?.start.page || 0)) === oversized(row, firstPage + result.rowBounds[index].start.page))) return result;
      hints = result.rowBounds;
    }
    throw new Error('Repeated header placement did not converge with changing page-story bounds.');
  };
  let body = placeBody();
  // Move the first header with a kept first body row instead of stranding it.
  if (body.cells.length && body.cells.every(cell => cell.page > 0) && !(legacy && rows[0] && oversized(rows[0]))) { advance(); body = placeBody(); }
  const lines = body.lines.map(line => ({ ...line, page: firstPage + line.page }));
  const cells = body.cells.map(cell => ({ ...cell, page: firstPage + cell.page })), repeatedLines = [];
  for (let part = 0; part < body.pageCount; part++) {
    const pageIndex = firstPage + part, y = part ? pageBounds(page, pageIndex).top : top;
    const copies = header.lines.map(line => ({ ...line, header: true, repeatedHeader: !!part, page: pageIndex, y: y + line.y, baseline: y + line.baseline,
      ...(line.cellClip ? { cellClip: shiftCellClip(line.cellClip, y) } : {}) }));
    (part ? repeatedLines : lines).push(...copies);
    for (const cell of header.cells) cells.push({ ...cell, header: true, repeatedHeader: !!part, page: pageIndex, y: y + cell.y, ...(cell.cellClip ? { cellClip: shiftCellClip(cell.cellClip, y) } : {}) });
  }
  return { lines, repeatedLines, cells, pageCount: firstPage + body.pageCount, endY: body.endY };
}

// Compatibility mode 15 and later omits repetitions on pages occupied by a row whose declared
// height cannot coexist with the header, then resumes them for later rows.
function paginateVariableHeaders(table, page, maxPages, startY, paginateText, oversized) {
  const { header, rows, height } = table;
  const physical = part => pageBounds(page, part);
  const lines = [], cells = [], repeatedLines = [], headers = new Set(), headerless = new Set();
  let currentPage = 0, y = startY;
  const advance = () => {
    if (++currentPage >= maxPages) throw new Error(`This preview supports up to ${maxPages} pages. Reduce the document length or adjust its formatting.`);
    y = physical(currentPage).top;
  };
  const addHeader = (index, top, repeated = true) => {
    if (headers.has(index)) return;
    headers.add(index);
    for (const line of header.lines) (repeated ? repeatedLines : lines).push({ ...line, header: true, repeatedHeader: repeated,
      page: index, y: top + line.y, baseline: top + line.baseline,
      ...(line.cellClip ? { cellClip: shiftCellClip(line.cellClip, top) } : {}) });
    for (const cell of header.cells) cells.push({ ...cell, header: true, repeatedHeader: repeated, page: index, y: top + cell.y, ...(cell.cellClip ? { cellClip: shiftCellClip(cell.cellClip, top) } : {}) });
  };
  const firstMinimum = rows[0].fixedHeight ?? rows[0].minimumHeight ?? table.minimum;
  if (y > physical(currentPage).top && y + height + firstMinimum > physical(currentPage).bottom) advance();
  addHeader(currentPage, y, false); y += height;
  // Keep each connected vertical-merge group together in the row paginator.
  for (let first = 0; first < rows.length;) {
    let last = first;
    for (let i = first; i <= last; i++) for (const cell of rows[i].cells) last = Math.max(last, i + cell.rowSpan - 1);
    const group = rows.slice(first, last + 1); let omit = oversized(group[0], currentPage);
    if (omit && y > physical(currentPage).top) {
      advance(); omit = oversized(group[0], currentPage);
      if (!omit) { addHeader(currentPage, y); y += height; }
    }
    else if (y >= physical(currentPage).bottom) { advance(); addHeader(currentPage, y); y += height; }
    const topEdge = omit ? group[0].topEdge || 0 : 0;
    const mixed = !!page.pageBounds || group.some(row => oversized(row, currentPage));
    const groupPage = offsetPage({ ...page, top: page.top + (mixed ? 0 : height), tableBodyBelowHeader: !mixed }, currentPage);
    const prepared = group.map((row, i) => ({ ...row, ...(omit && !i ? { beforeEdge: topEdge } : {}),
      cells: row.cells.map(cell => ({ ...cell, page: { ...cell.page, top: cell.page.top + (mixed ? 0 : height) } })) }));
    let result = paginateTableRows(prepared, groupPage, maxPages - currentPage, y, paginateText);
    let reserved = {};
    if (mixed) {
      // Physical rows, rather than their merge-connected group, determine
      // whether a page can carry a header. Reflow merged text through each
      // reserved body area before committing either text or header copies.
      for (let pass = 0; ; pass++) {
        const omitted = new Set(), normal = new Set();
        result.rowBounds.forEach((bound, i) => {
          for (let part = bound.start.page; part <= bound.end.page; part++) {
            const top = part === bound.start.page ? bound.start.y : pageBounds(groupPage, part).top;
            const end = part === bound.end.page ? bound.end.y : pageBounds(groupPage, part).bottom;
            if (end > top + 1e-6) (oversized(group[i], currentPage + part) ? omitted : normal).add(part);
          }
        });
        const next = Object.fromEntries([...normal].filter(part => !omitted.has(part) && !headerless.has(currentPage + part)).map(part => [part, physical(currentPage + part).top + height]));
        if (JSON.stringify(next) === JSON.stringify(reserved)) break;
        if (pass >= maxPages + group.length) throw new Error('Table header placement did not converge.');
        reserved = next;
        result = paginateTableRows(prepared, { ...groupPage, tablePageTops: reserved }, maxPages - currentPage, y, paginateText);
      }
    }
    for (const line of result.lines) lines.push({ ...line, page: currentPage + line.page });
    for (const cell of result.cells) cells.push({ ...cell, page: currentPage + cell.page });
    for (const part of new Set(result.cells.map(cell => cell.page))) {
      const index = currentPage + part;
      if ((!mixed || reserved[part] != null) && !headerless.has(index)) addHeader(index, physical(index).top);
      else headerless.add(index);
    }
    currentPage += result.pageCount - 1; y = result.endY;
    first = last + 1;
  }
  return { lines, cells, repeatedLines, pageCount: currentPage + 1, endY: y };
}
