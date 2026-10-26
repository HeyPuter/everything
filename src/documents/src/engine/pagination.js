import { rowMinimumHeight } from './block-layout.js';
import { borderOutset, borderWidth, sameParagraphBorders, visibleParagraphBorders } from './paragraph-borders.js';
// Original page placement over measured lines. No text measurement, mutation,
// package access or painting belongs here. Authored breaks delimit constraints.
import { paginateTableRows } from './table-pagination.js';
import { paginateTableWithHeader } from './table-headers.js';
import { pageBounds, offsetPage } from './page-bounds.js';
import { placeNestedFloatingTables } from './nested-floating-tables.js';
import { paginateFloatingFlow } from './floating-table-flow.js';
const lineHeight = line => line.virtual ? 0 : line.height;
const lineFitHeight = line => line.virtual ? 0 : line.fitHeight ?? line.height;
// Clearance belongs to the outgoing page's obstacles. If pagination moves
// this restart to another page/column, that old-page gap must not travel.
function pageClearance(line, pageIndex) {
  if (!line.clearanceBefore || line.clearancePage === pageIndex) return line;
  const before = line.clearanceBefore;
  return { ...line, baseline: line.baseline - before, height: line.height - before,
    fitHeight: lineFitHeight(line) - before, wrapBefore: (line.wrapBefore || 0) - before,
    clearanceBefore: 0 };
}
const trailingLeading = line => line ? lineHeight(line) - lineFitHeight(line) : 0;
const tableFitInset = segment => segment.tableRow?.fixedHeight != null ? segment.tableRow.bottomFitInset || 0 : 0;
const segmentFitHeight = segment => segment.height - trailingLeading(segment.lines.at(-1)) - tableFitInset(segment);
const emptyFlowBreak = line => ['page', 'column'].includes(line?.hardBreak) && line.start === line.end;
// An empty authored break stays in the outgoing column/page even when its
// line box no longer fits. Otherwise overflow and the break advance twice.
// A terminal page break retaining its paragraph mark still needs real space.
const floatingBreak = line => emptyFlowBreak(line) && (line.hardBreak === 'column' || !line.pageBreakWithMark);
const exceeds = (a, b) => a > b + 1e-6;
const tableRowsOf = s => !s ? [] : s.tableHeader ? [...s.tableHeader.headerRows, ...s.tableHeader.rows]
  : s.tableGroup?.rows || (s.tableRow ? [s.tableRow] : []);

function appendTopBottomBands(bands, line, y, page, anchorBefore) {
  for (const [top, bottom] of line.topBottomBands || []) bands.push({ page,
    top: y - anchorBefore + top, bottom: y - anchorBefore + bottom });
}

function trimTopBottomBands(bands, page, y) {
  let kept = 0;
  for (const band of bands) if (band.page === page && band.bottom > y + 1e-6) bands[kept++] = band;
  bands.length = kept;
}

function clearTopBottomBands(line, y, page, bands, anchorBefore, paragraphBefore) {
  if (line.virtual) return line;
  let textY = y;
  for (let attempt = 0; attempt <= bands.length; attempt++) {
    // Before-spacing travels with the first line. Testing only the final text
    // rectangle misses a thin rule crossed by that spacing. The paragraph's
    // before-spacing is reapplied after clearance (independent native controls).
    const band = bands.find(e => e.page === page && e.top < textY + line.height - 1e-6 && e.bottom > textY - anchorBefore + 1e-6);
    if (!band) break;
    textY = band.bottom + paragraphBefore;
  }
  const before = textY - y;
  return before > 0 ? { ...line, baseline: line.baseline + before, height: line.height + before,
    fitHeight: lineFitHeight(line) + before, wrapBefore: (line.wrapBefore || 0) + before } : line;
}

function segmentsOf(blocks, page) {
  let hasFloating = false;
  const raw = blocks.flatMap(({ lines, format, styleId, leadingFlowBreaks, borderGroupStart, tableRow, tableGroup, tableHeader, floatingFlow, height }, index) => {
    if (floatingFlow) { hasFloating = true; return [{ floatingFlow }]; }
    // During column balancing the required terminal boundary follows the table
    // below the balanced region; its height must not move earlier rows.
    const boundary = !page.balanceBoundaryBottom && blocks[index + 1]?.lines?.[0]?.continuousBoundaryLine;
    if (tableHeader) return [{ tableHeader, height, format, lines: [], before: 0, after: 0, keepNext: boundary }];
    if (tableGroup) return [{ tableGroup, height, format, lines: [], before: 0, after: 0, keepNext: boundary }];
    // First-cell keeps connect rows through the next row's initial content;
    // a final row connects to the following paragraph.
    if (tableRow) return [{ tableRow, height, format, lines: [], before: 0, after: 0,
      keepNext: format.keepNext || boundary }];
    const segments = [];
    let start = 0, breaks = 0, before = leadingFlowBreaks ? 0 : format.spaceBefore * 4 / 3;
    lines.forEach((line, i) => {
      if (!['page', 'column'].includes(line.hardBreak) && i !== lines.length - 1) return;
      const end = i === lines.length - 1;
      const content = lines.slice(start, i + 1);
      const paragraphId = lines[0]?.paragraphId, visible = paragraphId && content.some(line => !line.virtual);
      segments.push({
        lines: content, format, before, styleId, paragraphId, borderGroupStart,
        leadingBreakStart: start === 0 && leadingFlowBreaks > 0,
        deferredBefore: start > 0 && breaks === leadingFlowBreaks,
        after: end && !line.virtual ? format.spaceAfter * 4 / 3 : 0,
        breakBefore: start === 0 && format.pageBreakBefore,
        breakAfter: ['page', 'column'].includes(line.hardBreak) ? line.hardBreak : null,
        keepNext: end && format.keepNext,
        height: content.reduce((sum, l) => sum + lineHeight(l), 0),
        topBorder: visible ? borderOutset(format.paragraphBorders?.top) : 0,
        bottomBorder: visible ? borderOutset(format.paragraphBorders?.bottom) : 0,
        bordersVisible: visibleParagraphBorders(format.paragraphBorders),
      });
      start = i + 1; breaks++;
      const next = lines[i + 1], hasFollowingContent = next && (next.start !== next.end || next.hardBreak);
      before = breaks === leadingFlowBreaks && hasFollowingContent && !page.suppressSpBfAfterPgBrk ? format.spaceBefore * 4 / 3 : 0;
    });
    return segments;
  });
  if (!hasFloating) return raw;
  // Floating tables must not sever paragraph keeps, contextual spacing or border
  // groups. Attach their source-position work to the next real flow segment.
  const segments = []; let pending = [];
  for (const segment of raw) {
    if (segment.floatingFlow) pending.push(segment.floatingFlow);
    else {
      if (pending.length) { segment.beforeFloating = pending; pending = []; }
      segments.push(segment);
    }
  }
  if (pending.length) throw new Error('Floating tables require following body content.');
  return segments;
}

const borderEdge = (segment, side) => segment?.[side === 'top' ? 'topBorder' : 'bottomBorder'] || 0;
const joinedBorders = (a, b) => a?.paragraphId && b?.paragraphId && a.bordersVisible && (!b.borderGroupStart || a.paragraphId === b.paragraphId) && sameParagraphBorders(a.format.paragraphBorders, b.format.paragraphBorders);

function paragraphGap(previous, next, after = previous?.after || 0, samePage = true) {
  let before = next.before;
  if (!previous && next.format.autoSpaceBefore) before = 0;
  if (previous?.paragraphId && next.paragraphId && previous.format.autoSpacingListId !== undefined && previous.format.autoSpacingListId === next.format.autoSpacingListId) {
    if (previous.format.autoSpaceAfter) after = 0;
    if (next.format.autoSpaceBefore) before = 0;
  }
  let gap = next.format.addParagraphSpacing ? after + before : Math.max(after, before);
  // §17.3.1.9 subtracts from the collapsed gap: 10pt after / 12pt before
  // leaves 2pt if only the first paragraph requests contextual spacing.
  if (previous?.paragraphId && next.paragraphId && previous.paragraphId !== next.paragraphId && previous.styleId === next.styleId) {
    gap -= (previous.format.contextualSpacing ? after : 0) + (next.format.contextualSpacing ? next.before : 0);
  }
  const joined = samePage && joinedBorders(previous, next);
  const between = joined ? previous.format.paragraphBorders?.between : null;
  // Distance is honored on both sides, contrary to §17.3.1.5's ignored-space
  // rule. Independent native controls: paragraph-between-distance.
  const borders = joined ? 2 * borderOutset(between) - borderWidth(between) : (samePage ? borderEdge(previous, 'bottom') : 0) + borderEdge(next, 'top');
  return Math.max(0, gap) + borders;
}

function wrappingBefore(previous, next) {
  if (!previous && next.format.autoSpaceBefore) return 0;
  if (previous?.paragraphId && next.paragraphId) {
    if (next.format.contextualSpacing && previous.styleId === next.styleId) return 0;
    if (next.format.autoSpaceBefore && previous.format.autoSpacingListId !== undefined &&
        previous.format.autoSpacingListId === next.format.autoSpacingListId) return 0;
  }
  return next.before;
}

// Which suffixes can fill fresh pages with at least two lines per page? This
// look-ahead matters with mixed heights: taking one extra small line now can
// strand a large line plus two small lines across the following two pages.
// Prefix heights and suffix counts keep this pass linear in the line count.
function widowSuffixes(lines, capacity) {
  const heights = [0];
  for (const line of lines) heights.push(heights.at(-1) + lineHeight(line));
  const valid = Array(lines.length + 1).fill(false), counts = Array(lines.length + 2).fill(0);
  valid[lines.length] = true; counts[lines.length] = 1;
  let end = lines.length;
  for (let start = lines.length - 1; start >= 0; start--) {
    while (end > start && exceeds(heights[end] - heights[start] - trailingLeading(lines[end - 1]), capacity)) end--;
    valid[start] = end >= start + 2 && counts[start + 2] > counts[end + 1];
    counts[start] = counts[start + 1] + Number(valid[start]);
  }
  return valid;
}

// With different first/even stories, a suffix must fit the actual following
// pages. A uniform-capacity look-ahead can strand a singleton on a short page
// even when leaving two more lines here would avoid it.
function widowPageSuffixes(lines, firstPage, maxPages, capacityAt) {
  const heights = [0], rows = new Map();
  for (const line of lines) heights.push(heights.at(-1) + lineHeight(line));
  let next = Array(lines.length + 1).fill(false); next[lines.length] = true;
  const lastPage = Math.min(maxPages - 1, firstPage + Math.floor(lines.length / 2) - 1);
  for (let part = lastPage; part >= firstPage; part--) {
    const counts = Array(lines.length + 2).fill(0), valid = Array(lines.length + 1).fill(false);
    for (let i = lines.length; i >= 0; i--) counts[i] = counts[i + 1] + Number(next[i]);
    valid[lines.length] = true;
    const capacity = capacityAt(part); let end = lines.length;
    for (let start = lines.length - 1; start >= 0; start--) {
      while (end > start && exceeds(heights[end] - heights[start] - trailingLeading(lines[end - 1]), capacity)) end--;
      valid[start] = end >= start + 2 && counts[start + 2] > counts[end + 1];
    }
    rows.set(part, valid); next = valid;
  }
  return rows;
}

export function paginateParagraphs(blocks, page, maxPages, startY = page.top) {
  return createParagraphPaginator()(blocks, page, maxPages, startY);
}

// Measured blocks stay immutable during one document layout. Natural sizing,
// repeated headers and merged-cell reflow can reuse their paragraph segments.
// The owner creates a fresh paginator for every layout, so edits cannot reuse
// stale measurements. Break-spacing compatibility and boundary balancing affect
// segment preparation; physical bounds are evaluated separately on every call.
export function createParagraphPaginator() {
  const prepared = new WeakMap();
  return function paginate(blocks, page, maxPages, startY = page.top, previousSectionAfter = 0) {
    let modes = prepared.get(blocks);
    if (!modes) { modes = []; prepared.set(blocks, modes); }
    const mode = Number(!!page.suppressSpBfAfterPgBrk) + 2 * Number(!!page.balanceBoundaryBottom);
    const segments = modes[mode] ?? (modes[mode] = segmentsOf(blocks, page));
    const result = paginateSegments(segments, page, maxPages, startY, paginate, previousSectionAfter);
    return blocks.floatingTables?.length
      ? placeNestedFloatingTables(blocks.floatingTables, result, page, maxPages, startY, paginate) : result;
  };
}

function paginateSegments(segments, page, maxPages, startY, paginateParagraphs, previousSectionAfter = 0) {
  const lines = [], cells = [], repeatedLines = [], floatingTables = [];
  const activeBands = [];
  let tableBandHeights;
  let pageIndex = 0, top, bottom, capacity;
  const bounds = () => {
    const fragment = page.cellFragments?.[pageIndex];
    const physical = pageBounds(page, pageIndex);
    top = fragment?.top ?? physical.top;
    // The final exact-height fragment retains overflow source positions without
    // allocating pages. Painting and interaction use its separate cell clip.
    bottom = fragment ? (page.clipOverflow && pageIndex === page.cellFragments.length - 1 ? Infinity : fragment.bottom) : physical.bottom;
    capacity = bottom - top;
  };
  bounds();
  // A continuous section's region starts below the sections above it on the same page: that page is
  // occupied even though the region's own top is where it starts (continuous-columns.js).
  let y = startY, previousAfter = 0, previous = null, previousLine = null, occupied = startY > top || !!page.startsOccupied, deferredAfter = 0, shadeAfter = 0;
  const advance = (physical = false) => {
    const next = physical && page.flowColumns ? (Math.floor(pageIndex / page.flowColumns) + 1) * page.flowColumns : pageIndex + 1;
    if (next >= maxPages) throw new Error(`This preview supports up to ${Math.floor(maxPages / (page.flowColumns || 1))} pages. Reduce the document length or adjust its formatting.`);
    // The other columns on that shared page are as short as the first: rules that move text on, move it on.
    pageIndex = next; bounds(); y = top; previousAfter = 0; occupied = !!page.startsOccupied && next < (page.flowColumns || 1); activeBands.length = 0;
  };
  const place = (line, anchorBefore = 0) => {
    if (floatingBreak(line) && exceeds(y + line.height + borderOutset(line.paragraphFrame?.borders.bottom), bottom)) y = Math.max(top + borderOutset(line.paragraphFrame?.borders.top), bottom - borderOutset(line.paragraphFrame?.borders.bottom) - line.height);
    const lineY = line.emptySectionBoundary && !(line.continuousBoundaryLine && page.balanceBoundaryBottom) ? Math.min(y, Math.max(top, bottom - line.height)) : y;
    const placed = { ...line, page: pageIndex, y: lineY, baseline: lineY + line.baseline, ...(anchorBefore ? { anchorBefore } : {}) };
    if (line.paragraphBackground) {
      let before = 0;
      // Paragraph spacing is shaded only between adjacent shaded paragraphs.
      // The preceding after-spacing owns its part of the collapsed gap; only
      // the remainder belongs to the following fill. Wait for physical placement
      // so a page/column break cannot leave a painted tail on the prior page.
      if (previousLine?.paragraphBackground && previousLine.page === pageIndex &&
          previousLine.paragraphBackground.x === line.paragraphBackground.x &&
          previousLine.paragraphBackground.width === line.paragraphBackground.width) {
        const gap = Math.max(0, lineY - previousLine.y - previousLine.height);
        previousLine.paragraphBackground.after = Math.min(shadeAfter, gap);
        before = gap - previousLine.paragraphBackground.after;
      }
      placed.paragraphBackground = { ...line.paragraphBackground, before, after: 0 };
    }
    if (line.topBottomBands) appendTopBottomBands(activeBands, line, lineY, pageIndex, anchorBefore);
    lines.push(placed); previousLine = placed;
    if (!line.virtual) {
      y += line.height; occupied = true;
      if (activeBands.length) trimTopBottomBands(activeBands, pageIndex, y);
    }
  };

  const clearTableBands = (index, start, bands) => {
    if (!bands.some(b => b.page === pageIndex && b.bottom > start + 1e-6)) return start;
    const rows = tableRowsOf(segments[index]), tableId = rows[0]?.cells[0]?.tableId;
    if (!rows.length || tableRowsOf(segments[index - 1])[0]?.cells[0]?.tableId === tableId) return start;
    tableBandHeights ??= new Map();
    if (!tableBandHeights.has(index)) {
      // A table can use space above the object only when the complete table
      // fits. Reuse row pagination for exact, merged and repeated-header rows.
      const allRows = rows.slice();
      for (let next = index + 1; next < segments.length; next++) {
        const followingRows = tableRowsOf(segments[next]);
        if (!followingRows.length || followingRows[0].cells[0]?.tableId !== tableId) break;
        allRows.push(...followingRows);
      }
      const naturalPage = { ...page, height: 1e9, top: 0, bottom: 0, pageBounds: undefined, cellFragments: undefined };
      tableBandHeights.set(index, paginateTableRows(allRows, naturalPage, 1, 0, paginateParagraphs).endY);
    }
    const height = tableBandHeights.get(index);
    let result = start;
    for (let attempt = 0; attempt <= bands.length; attempt++) {
      const band = bands.find(b => b.page === pageIndex && b.top < result + height - 1e-6 && b.bottom > result + 1e-6);
      if (!band) break;
      result = band.bottom;
    }
    return result;
  };

  const wrappedGroupHeight = (first, last, initialGap) => {
    const bands = activeBands.slice();
    let probeY = y, prior = previous, after = previousAfter, tail, fitInset = 0;
    for (let index = first; index <= last; index++) {
      const segment = segments[index];
      const gap = index === first ? initialGap : paragraphGap(prior, segment, after);
      const ownGap = Math.max(0, gap - paragraphGap(prior, { ...segment, before: 0, topBorder: 0 }, after,
        index !== first || previousLine?.page === pageIndex));
      probeY += gap;
      fitInset = 0;
      if (segment.lines.length) for (let i = 0; i < segment.lines.length; i++) {
        let line = segment.lines[i];
        const before = i === 0 ? Math.min(ownGap, probeY - top) : 0;
        if (line.topBottomBands) appendTopBottomBands(bands, line, probeY, pageIndex, before);
        line = clearTopBottomBands(line, probeY, pageIndex, bands, before, i === 0 ? wrappingBefore(prior, segment) : 0);
        probeY += lineHeight(line); tail = line;
      } else {
        probeY = clearTableBands(index, probeY, bands);
        const rowStart = prior?.tableRow && segment.tableRow && !segment.keepNext &&
          prior.tableRow.cells[0]?.tableId === segment.tableRow.cells[0]?.tableId;
        probeY += rowStart ? rowMinimumHeight(segment.tableRow) : segment.height;
        fitInset = rowStart ? 0 : tableFitInset(segment);
        tail = null;
      }
      prior = segment; after = segment.after;
    }
    return probeY - y + borderEdge(segments[last], 'bottom') - trailingLeading(tail) - fitInset;
  };

  const placeFloating = segment => {
    for (const floating of segment.beforeFloating || []) {
      const result = paginateFloatingFlow(floating, offsetPage(page, pageIndex), maxPages - pageIndex, y + previousAfter, paginateParagraphs,
        (page.floatingPageSideBase || 0) + pageIndex);
      if (result) {
        for (const key of ['lines', 'cells', 'repeatedLines', 'floatingTables']) {
          const target = { lines, cells, repeatedLines, floatingTables }[key];
          for (const item of result[key]) target.push({ ...item, page: item.page + pageIndex });
        }
        pageIndex += result.pageCount - 1; bounds(); y = top;
        previousAfter = 0; previous = null; previousLine = null; occupied = false;
      }
    }
  };
  for (let first = 0; first < segments.length;) {
    placeFloating(segments[first]);
    let last = first, groupHeight = segments[first].height;
    // An empty section boundary is an insertion position, not a following
    // paragraph to keep on this page. Including its preceding gap can move
    // the last real paragraph and create an extra page before the next section.
    while (segments[last].keepNext && !segments[last].breakAfter && segments[last + 1] && !segments[last + 1].breakBefore && !emptyFlowBreak(segments[last + 1].lines[0]) && !(segments[last + 1].lines[0]?.emptySectionBoundary && segments[last + 1].lines[0]?.virtual)) {
      const current = segments[last], next = segments[last + 1];
      const nextRowStart = current.tableRow && next.tableRow && !next.keepNext &&
        current.tableRow.cells[0]?.tableId === next.tableRow.cells[0]?.tableId;
      groupHeight += paragraphGap(current, next) + (nextRowStart ? rowMinimumHeight(next.tableRow) : next.height);
      last++;
    }
    groupHeight += borderEdge(segments[last], 'bottom') - trailingLeading(segments[last].lines.at(-1)) - tableFitInset(segments[last]);
    const explicitBreak = segments[first].breakBefore && occupied;
    const precedingAfter = explicitBreak ? previousAfter : first === 0 ? previousSectionAfter : 0;
    if (explicitBreak) advance(true);
    let gap = paragraphGap(previous, segments[first], previousAfter, previousLine?.page === pageIndex);
    // The preceding after-spacing is consumed at section and explicit page
    // boundaries. Modern compatibility suppresses pageBreakBefore gaps entirely.
    if (explicitBreak && page.compatibilityMode >= 15) gap = borderEdge(segments[first], 'top');
    else if (explicitBreak || first === 0) gap = Math.max(borderEdge(segments[first], 'top'), gap - precedingAfter);
    // Ordinary adjacent border groups already replaced their touching edges
    // with the between border. Do not reintroduce top clearance here.
    // Evaluate a complete keepNext chain once. Re-grouping its suffix after a
    // forced fallback would keep pushing an oversized chain onto extra pages.
    const keepGroup = last > first || segments[first].format.keepLines;
    const bandGroup = keepGroup && (activeBands.length || segments.slice(first, last + 1).some(s => s.lines[0]?.topBottomBands));
    const keepHeight = bandGroup ? wrappedGroupHeight(first, last, gap) : gap + groupHeight;
    if (keepGroup && exceeds(y + keepHeight, bottom) && !floatingBreak(segments[first].lines[0])) {
      if (occupied) advance();
      // Automatic moves suppress the initial gap; keep internal collapsed gaps.
      gap = borderEdge(segments[first], 'top');
    }
    for (let index = first; index <= last; index++) {
      const segment = segments[index], content = segment.lines;
      if (index !== first) placeFloating(segment);
      const following = segments[index + 1];
      const after = segment.paragraphId && following?.paragraphId && segment.styleId === following.styleId && segment.format.contextualSpacing ? 0 : segment.after;
      const topBorder = borderEdge(segment, 'top'), bottomBorder = borderEdge(segment, 'bottom');
      // Leading run-level breaks postpone the before-gap, but must retain the
      // preceding paragraph's after-spacing across every intervening blank page.
      if (segment.leadingBreakStart) deferredAfter = index === 0 ? previousSectionAfter : explicitBreak && index === first ? precedingAfter : previousAfter;
      const freshTop = () => top + topBorder;
      const nextPage = () => { advance(); y = freshTop(); };
      if (index !== first) gap = paragraphGap(previous, segment, previousAfter, previousLine?.page === pageIndex);
      if (segment.deferredBefore) gap = Math.max(topBorder, gap - deferredAfter);
      // A trailing run-level page break leaves only a virtual paragraph mark on
      // this page. The following paragraph starts at the top without a before-gap.
      if (!occupied && previousLine?.page === pageIndex && previousLine.virtual && !previousLine.emptySectionBoundary) gap = topBorder;
      const keptHeight = segment.format.keepLines && (activeBands.length || content[0]?.topBottomBands)
        ? wrappedGroupHeight(index, index, gap) : gap + segmentFitHeight(segment) + bottomBorder;
      if (segment.format.keepLines && exceeds(y + keptHeight, bottom) && !floatingBreak(content[0])) {
        if (occupied) advance();
        gap = topBorder;
      }
      const sameStyle = previous?.paragraphId && segment.paragraphId && previous.paragraphId !== segment.paragraphId && previous.styleId === segment.styleId;
      shadeAfter = sameStyle && previous.format.contextualSpacing ? 0 : Math.min(shadeAfter, gap);
      // A paragraph-relative drawing starts before this paragraph's contribution
      // to the collapsed gap and its top-border clearance. Keep the preceding
      // paragraph's after-spacing; suppressed gaps must not shift the anchor.
      const anchorBefore = Math.max(0, gap - paragraphGap(previous, { ...segment, before: 0, topBorder: 0 }, previousAfter, previousLine?.page === pageIndex));
      const gapPage = pageIndex;
      y += gap;
      if (segment.tableGroup || segment.tableRow || segment.tableHeader) {
        if (activeBands.length) y = clearTableBands(index, y, activeBands);
        const tablePage = offsetPage(page, pageIndex);
        const result = segment.tableHeader ? paginateTableWithHeader(segment.tableHeader, tablePage, maxPages - pageIndex, y, paginateParagraphs) : paginateTableRows(segment.tableGroup?.rows || [segment.tableRow], tablePage, maxPages - pageIndex, y, paginateParagraphs);
        for (const line of result.lines) lines.push({ ...line, page: pageIndex + line.page });
        for (const line of result.repeatedLines || []) repeatedLines.push({ ...line, page: pageIndex + line.page });
        for (const cell of result.cells) cells.push({ ...cell, page: pageIndex + cell.page });
        pageIndex += result.pageCount - 1; bounds(); y = result.endY; previousAfter = 0; previous = segment; previousLine = null; occupied = true;
        if (activeBands.length) trimTopBottomBands(activeBands, pageIndex, y);
        continue;
      }
      let validSuffix, suffixCapacity, pageSuffixes;
      const textCapacityAt = part => {
        const physical = pageBounds(page, part), fragment = page.cellFragments?.[part];
        return (fragment?.bottom ?? physical.bottom) - (fragment?.top ?? physical.top) - topBorder - bottomBorder;
      };
      let start = 0;
      while (start < content.length) {
        const textCapacity = capacity - topBorder - bottomBorder;
        if (segment.format.widowControl) {
          if (page.pageBounds) {
            pageSuffixes ??= widowPageSuffixes(content, pageIndex + 1, maxPages, textCapacityAt);
            validSuffix = pageSuffixes.get(pageIndex + 1) || [];
          } else if (suffixCapacity !== textCapacity) {
            validSuffix = widowSuffixes(content, textCapacity); suffixCapacity = textCapacity;
          }
        }
        let end = start, fitY = y;
        const fitBands = activeBands.length || content[0]?.topBottomBands ? activeBands.slice() : null;
        const fitLines = fitBands ? [] : null;
        while (end < content.length) {
          let line = pageClearance(content[end], pageIndex);
          if (fitBands) {
            const ownGap = end === 0 && pageIndex === gapPage ? Math.min(anchorBefore, fitY - top) : 0;
            if (line.topBottomBands) appendTopBottomBands(fitBands, line, fitY, pageIndex, ownGap);
            line = clearTopBottomBands(line, fitY, pageIndex, fitBands, ownGap, end === 0 ? wrappingBefore(previous, segment) : 0);
            fitLines[end] = line;
          }
          // Cell paragraphs retain their final after-spacing inside the cell
          // border. Body after-spacing may instead be suppressed at a page cut.
          // An after-gap larger than a fresh page cannot keep advancing an
          // otherwise fitting line; retain the existing overflow fallback.
          const tail = page.tableDepth && end === content.length - 1 && line.height + after <= textCapacity ? after : 0;
          const anchorGap = line.floatingFitHeight && end === 0 && pageIndex === gapPage ? Math.min(anchorBefore, fitY - top) : 0;
          const placementHeight = Math.max(lineFitHeight(line), (line.floatingFitHeight || 0) - anchorGap);
          if (!line.virtual && !floatingBreak(line) && exceeds(fitY + placementHeight + bottomBorder + tail, line.continuousBoundaryLine && page.balanceBoundaryBottom || bottom)) break;
          fitY += lineHeight(line); end++;
        }
        // Oversized inline content retains its authored extent on a fresh
        // page. Consume it once, including in editable layout; never loop over
        // blank pages waiting for an impossible fit. Other oversized lines
        // retain the separate read-only preview policy.
        if (end === start && (page.allowOversizedLines || content[start].oversizedInlineHeight) && !occupied && exceeds(lineFitHeight(content[start]), textCapacity)) {
          y = freshTop(); end = start + 1;
        }
        if (end === start) {
          if (!occupied && fitLines?.[start]?.topBottomBands && exceeds(lineFitHeight(fitLines[start]), textCapacity)) throw new Error('This positioned drawing paragraph is taller than the page writing area.');
          if (occupied || exceeds(lineFitHeight(content[start]), textCapacity)) { nextPage(); continue; }
          // Before-spacing alone must not create a blank page.
          if (exceeds(y, freshTop())) { y = freshTop(); continue; }
          // A side-wrapped drawing's reserved height can exceed what this paragraph's
          // borders, a tall header or note area leave on every page. Start it here.
          end = start + 1;
        }
        if (segment.format.widowControl && end < content.length) {
          let balanced = end;
          while (balanced >= start + 2 && !validSuffix[balanced]) balanced--;
          if (balanced >= start + 2) end = balanced;
          else if (validSuffix[start] && (occupied || y > freshTop())) {
            if (occupied) nextPage(); else y = freshTop();
            continue;
          }
          // Moving on helps when the next physical page has the room this one lacks: the columns left
          // on a page shared with an earlier section, or a page under a taller header, can have less.
          const ahead = occupied ? textCapacityAt(page.flowColumns ? (Math.floor(pageIndex / page.flowColumns) + 1) * page.flowColumns : pageIndex + 1) : textCapacity;
          // Move the first line forward instead of leaving it alone. On an empty
          // page a single fitting line is unavoidable, so always make progress.
          if (end - start === 1 && (occupied || y > freshTop()) && !exceeds(lineHeight(content[start]) + lineFitHeight(content[start + 1]), Math.max(textCapacity, ahead))) {
            if (occupied) nextPage(); else y = freshTop();
            continue;
          }
          // Reserve a preceding line for a final singleton if that pair can fit.
          if (content.length - end === 1 && end - start >= 2 && !exceeds(lineHeight(content[end - 1]) + lineFitHeight(content[end]), textCapacity)) {
            if (end - start === 2 && occupied && !exceeds(segmentFitHeight(segment), Math.max(textCapacity, ahead))) { nextPage(); continue; }
            // Don't exchange one unavoidable singleton for another on this page.
            if (end - start > 2) end--;
          }
        }
        for (; start < end; start++) {
          const first = start === 0 && pageIndex === gapPage;
          place(pageClearance(fitLines?.[start] || content[start], pageIndex), first ? Math.min(anchorBefore, y - top) : 0);
        }
        if (start < content.length) nextPage();
      }
      shadeAfter = previousLine?.paragraphBackground ? Math.max(0, Math.min(segment.after, bottom - previousLine.y - previousLine.height)) : 0;
      if (page.tableDepth && previousLine?.paragraphEnd) previousLine.paragraphAfter = after;
      previousAfter = segment.after; previous = segment;
      if (segment.breakAfter) advance(segment.breakAfter === 'page');
    }
    first = last + 1;
  }
  // A trailing band still contributes to the region's occupied extent even
  // when no following line needs clearance (e.g. the next continuous section).
  const endY = Math.max(y + previousAfter + borderEdge(previous, 'bottom'),
    ...activeBands.filter(b => b.page === pageIndex).map(b => b.bottom));
  return { lines: lines.sort((a,b) => a.start - b.start), repeatedLines, cells, floatingTables, pageCount: pageIndex + 1, endY: Math.min(page.balanceBoundaryBottom || bottom, endY) };
}
