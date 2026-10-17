import { negativeWrapPreview } from './negative-wrap-preview.js';
import { manualBreakWrapPreview } from './manual-break-wrap-preview.js';
import { resolveEmptyTextFills } from './text-fill.js';
import { bodySymbolStyle } from './body-symbols.js';
import { inlineDisplayText } from './inline-display-text.js';
import { UnsupportedRotatedCellError, rotatedCellMinimumHeight, rotatedCellTextMetrics, rotatedCellFrame, finishRotatedCells, cellTextPoint, cellTextLocalPoint, cellTextRect } from './cell-text-direction.js';
import { fittedDrawingParagraphs } from './shape-autofit.js';
import { clipCellRect, cellClipContains } from './cell-clipping.js';
import { hasLineText } from './line-whitespace.js';
import { paginateColumnRegion } from './continuous-columns.js';
import { paginateColumnWidths } from './unequal-columns.js';
import { sectionColumnIntervals } from './section-columns.js';
import { columnFlowPage, placeColumnFlow, columnAtPoint } from './column-layout.js';
import { flatLineContains, flatLineRect } from './flat-drawing-lines.js';
import { canvasFontFamily, textFontStyle } from './font-families.js';
import { pageGeometry, readingPageGeometry } from './page-settings.js';
import { layoutParagraphBorders } from './paragraph-border-layout.js';
import { layoutTableBorders, tableRowBorderWidths, tableBorderWidth, cellBorderLayoutWidth, tableHorizontalInsets } from './table-border-layout.js';
import { cellWritingTopBorder, rowTableBorder } from './cell-borders.js';
import { checkJustificationText, justificationRange } from './justification.js';
import { contractionMetrics, fitContractedWord } from './justification-contraction.js';
import { borderOutset, visibleParagraphBorders } from './paragraph-borders.js';
import { documentBlocks, fixedColumnWidths, roundColumnWidths, autoColumnWidths, rowGrid, spanWidth, headerRowCount, minimumSpanWidth } from './tables.js';
import { measureTextGeometry } from './text-geometry.js';
import { prepareTableHeader } from './table-headers.js';
import { breakAfter, cellIntrinsicWidths } from './intrinsic-widths.js';
import { listMarkers } from './numbering.js';
import { markerGeometry } from './list-layout.js';
import { paragraphEdges } from './paragraph-geometry.js';
import { LineBuilder } from './line-builder.js';
import { bidiCharacters, bidiLineCharacters, bidiRtlSpace } from './bidi-text.js';
import { createParagraphPaginator } from './pagination.js';
import { paragraphText, paragraphFormat, runFormat } from './model.js';
import { revisionView, runRevisionDisplay } from './revisions.js';
import { inlineSegments, EMU_PER_PX, drawingOffsetPixels, imageExtents, inlineImageExtents, inlineImagePaintFrame, normalizedRotation, isPositionedImage, isSideWrappedImage } from './images.js';
import { squareFlowHints, squareFlowSignature, squareRow, joinSquareLine, clearingBreakTarget } from './square-wrap.js';
import { positionedImageFrame, positionedImageContains, positionedImageBounds, isCellRelativePosition, isPageBasedCellPosition } from './positioned-images.js';
import { resolveDrawingCollisions } from './drawing-collisions.js';
import { floatingParagraph } from './floating-images.js';
import { exactRowHeight, rowPadding } from './row-height.js';
import { blockMinimumHeight } from './block-layout.js';
import { sectionStoryBounds } from './story-clearance.js';
import { spacedFormat } from './document-views.js';
import { footnotePlan, endnotePlan, layoutWithFootnotes, pageRestartedNumbers, placeEndnotes } from './footnote-layout.js';
import { numberedParagraphs } from './footnotes.js';
import { pageBounds } from './page-bounds.js';
import { alignPageBody } from './page-vertical-alignment.js';
import { floatingTableX, floatingTableY } from './floating-tables.js';
import { floatingTableInset, floatingFragmentBounds, UnsupportedFloatingTableFlowError } from './floating-table-flow.js';
import { avoidTableOverlap, shiftTableItem } from './table-overlap.js';
import { nestedFloatingTableX } from './nested-floating-tables.js';
import { paragraphFrameGroups, measureParagraphFrame, placeParagraphFrames, UnsupportedParagraphFrameError } from './paragraph-frames.js';
import { autoHyphenationBreak, hyphenCharacter } from './hyphenation-layout.js';
import { hyphenationOf } from './hyphenation-settings.js';

export const PAGE = Object.freeze({ width: 816, height: 1056, margin: 96, gap: 24, lineHeight: 26, paragraphGap: 12, fontSize: 16 });
export const MAX_PAGES = 200;
export const font = style => `${style.italic ? 'italic' : 'normal'} ${style.bold ? 700 : 400} ${(style.fontSize ?? 12) * 4 / 3}px ${canvasFontFamily(style)}`;

/** Layout is independent of the painter. Every caret and fragment maps to UTF-16 source offsets. */
export function layoutDocument(paragraphs, measureBase, page = PAGE, numbering, tables = [], pageStories, storyOptions = {}) {
  let displayTables = tables;
  const negativeWrap = storyOptions.bestEffort || storyOptions.previewNegativeWrap ? negativeWrapPreview(paragraphs) : null;
  if (negativeWrap) paragraphs = negativeWrap.paragraphs;
  const manualWrap = storyOptions.bestEffort || storyOptions.previewManualBreakWrap ? manualBreakWrapPreview(paragraphs) : null;
  if (manualWrap) paragraphs = manualWrap.paragraphs;
  const approximations = [];
  const frameApproximations = [];
  const floatingTableApproximations = [];
  for (;;) {
    try {
      const result = layoutDocumentContent(paragraphs, measureBase, page, numbering, displayTables, pageStories, storyOptions);
      if (frameApproximations.length) result.frameApproximations = frameApproximations;
      if (floatingTableApproximations.length) result.floatingTableApproximations = floatingTableApproximations;
      if (negativeWrap?.approximations.length) result.negativeWrapApproximations = negativeWrap.approximations;
      if (manualWrap?.approximations.length) result.manualBreakWrapApproximations = manualWrap.approximations;
      return approximations.length ? { ...result, rotatedCellApproximations: approximations } : result;
    } catch (error) {
      if (storyOptions.bestEffort && error instanceof UnsupportedFloatingTableFlowError && error.tableId) {
        let recovered = false;
        displayTables = displayTables.map((table, index) => {
          if (table.id !== error.tableId || !table.floating) return table;
          recovered = true;
          floatingTableApproximations.push({ tableId: table.id, reason: error.message,
            message: `Table ${index + 1}: ${error.message} This table is shown in ordinary flow in the read-only preview; its position and surrounding pagination may differ.` });
          return { ...table, floating: null, alignment: 'left', indent: 0, indentDeclared: true };
        });
        // Each retry removes one identified declaration from a private view.
        // Unknown/already recovered IDs cannot create an unbounded retry.
        if (!recovered) throw error;
        continue;
      }
      if (storyOptions.bestEffort && error instanceof UnsupportedParagraphFrameError) {
        const ids = new Set(error.paragraphIds);
        let recovered = false;
        paragraphs = paragraphs.map(p => {
          if (!ids.has(p.id) || !p.frameProperties) return p;
          recovered = true;
          return { ...p, frameProperties: undefined };
        });
        if (!recovered) throw error;
        frameApproximations.push({ reason: error.message, message: `Paragraph frame: ${error.message} Its text remains in ordinary flow in this read-only preview.` });
        continue;
      }
      if (!(storyOptions.bestEffort || storyOptions.previewRotatedCells) || !(error instanceof UnsupportedRotatedCellError) || !error.cellId) throw error;
      let recovered = false;
      // Each retry removes only the identified rotation from a private view.
      // A repeated/unknown ID cannot make progress and must not loop forever.
      displayTables = displayTables.map((table, ti) => ({ ...table, rows: table.rows.map((row, ri) => ({ ...row,
        cells: row.cells.map((cell, ci) => {
          if (cell.id !== error.cellId || !cell.textDirection || cell.textDirection === 'lrTb') return cell;
          recovered = true;
          approximations.push({ cellId: cell.id, reason: error.message,
            message: `Table ${ti + 1}, row ${ri + 1}, cell ${ci + 1}: ${error.message} This cell is shown horizontally in the read-only preview.` });
          return { ...cell, textDirection: 'lrTb' };
        }),
      })) }));
      if (!recovered) throw error;
    }
  }
}

function layoutDocumentContent(paragraphs, measureBase, page, numbering, tables, pageStories, storyOptions) {
  paragraphs = fittedDrawingParagraphs(resolveEmptyTextFills(paragraphs), storyOptions.drawingLayouts);
  const totals = Object.values(pageStories?.stories || {}).some(s => s.paragraphs.some(p => p.runs.some(r => ['NUMPAGES', 'SECTIONPAGES'].includes(r.field?.type))));
  let counts = { pageCount: 1, sectionCounts: [] }, placed;
  const notes = footnotePlan(pageStories, paragraphs), endnotes = endnotePlan(pageStories, paragraphs), source = paragraphs;
  const numberNotes = () => numberedParagraphs(source, { footnote: notes?.numbers || new Map(), endnote: endnotes?.numbers || new Map() });
  if (notes || endnotes) paragraphs = numberNotes();
  for (let attempt = 0; attempt < MAX_PAGES; attempt++) {
    const flow = () => notes
      ? layoutWithFootnotes(notes, noteReserve => layoutWithWrap(paragraphs, measureBase, page, numbering, tables, pageStories, { ...storyOptions, ...counts, noteReserve }), measureBase, numbering, storyOptions)
      : layoutWithWrap(paragraphs, measureBase, page, numbering, tables, pageStories, { ...storyOptions, ...counts });
    placed = flow();
    // Footnotes numbered per page (§17.11.19 eachPage) need their pages first; renumber once and lay out again.
    if (notes?.restart === 'eachPage') {
      const renumbered = pageRestartedNumbers(notes, source, placed);
      if ([...renumbered].some(([id, display]) => notes.numbers.get(id) !== display)) { notes.numbers = renumbered; paragraphs = numberNotes(); placed = flow(); }
    }
    if (endnotes) placed = placeEndnotes(endnotes, placed, measureBase, numbering, storyOptions);
    const aligned = () => {
      const result = alignPageBody(placed, paragraphs, tables);
      return finishRotatedCells(result === placed ? placed : { ...result, paragraphBorders: layoutParagraphBorders(result), tableBorders: layoutTableBorders(result.cells) });
    };
    if (!totals) return aligned();
    const sectionCounts = [];
    for (const regions of placed.pageRegions) for (const section of new Set((regions || []).map(r => r.section))) sectionCounts[section] = (sectionCounts[section] || 0) + 1;
    const next = { pageCount: placed.pageCount, sectionCounts };
    if (JSON.stringify(next) === JSON.stringify(counts)) return aligned();
    counts = next;
  }
  throw new Error('Header/footer page-count fields did not converge during pagination.');
}

function layoutWithWrap(paragraphs, measureBase, page, numbering, tables, pageStories, storyOptions) {
  let placed = layoutPass(paragraphs, measureBase, page, numbering, tables, pageStories, undefined, storyOptions);
  if (!placed.paragraphFrames?.length && (page.storyKind === 'footer' && (page.compatibilityMode ?? 12) < 15 || !tables.some(t => t.floating) && !paragraphs.some(p => p.runs.some(r => isSideWrappedImage(r.image))))) return placed;
  let signature = squareFlowSignature(placed);
  for (let attempt = 0; attempt < paragraphs.length * 2 + 8; attempt++) {
    const next = layoutPass(paragraphs, measureBase, page, numbering, tables, pageStories, squareFlowHints(placed), storyOptions);
    const nextSignature = squareFlowSignature(next);
    if (nextSignature === signature) return next;
    placed = next; signature = nextSignature;
  }
  throw new Error('Square-wrapped drawing placement did not converge.');
}

function layoutPass(paragraphs, measureBase, page, numbering, tables, pageStories, wrapHints, storyOptions) {
  const mirroredIndents = new Map(paragraphs.filter(p => p.format?.mirrorIndents && !p.cellId && (p.format.indentRight ?? 0) !== (p.format.indentLeft ?? 0)).map(p => [p.id, ((p.format.indentRight ?? 0) - (p.format.indentLeft ?? 0)) / 15]));
  const paginateParagraphs = createParagraphPaginator();
  const measure = (text, style) => measureTextGeometry(text, style, measureBase);
  // Body paragraphs measured by an earlier layout with this measurer (paragraph-measure-cache.js).
  const paragraphCache = measureBase.paragraphCache?.();
  const pageKeys = new WeakMap(), sharedKey = paragraphCache && JSON.stringify([numbering ?? null, revisionView]);
  const pageKey = geometry => { let key = pageKeys.get(geometry); if (key === undefined) pageKeys.set(geometry, key = JSON.stringify(geometry)); return key; };
  // A screen view (web, draft, read) lays every section out on its own display geometry.
  const viewPage = storyOptions.viewGeometry || (geometry => geometry);
  page = viewPage(page);
  page = { ...page, allowOversizedLines: !!storyOptions.bestEffort, left: page.left ?? page.margin, right: page.right ?? page.margin, top: page.top ?? page.margin, bottom: page.bottom ?? page.margin };
  const markers = listMarkers(paragraphs, numbering);
  // The initial recto/verso side is retained through later numbering restarts.
  const firstPageSideOffset = (pageStories?.sections[0]?.pageNumbering?.start ?? 1) - 1;
  let hasRotatedCells = false;
  const tableWidths = {}, floatingAlignmentWidths = {};
  const finalPage = page, sectionPages = new Map(); let sectionPage = page;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (paragraphs[i].sectionEnd && paragraphs[i].cellId) throw new Error('Section breaks inside tables are not supported.');
    if (paragraphs[i].sectionEnd) sectionPage = { ...viewPage(pageGeometry(paragraphs[i].sectionEnd)), background: finalPage.background, backgroundPicture: finalPage.backgroundPicture, ...hyphenationOf(finalPage), allowOversizedLines: !!storyOptions.bestEffort };
    sectionPages.set(paragraphs[i].id, sectionPage);
  }
  // A drawing in a different section does not participate in column flow.
  // Resolve ownership once, including drawings inside table-cell paragraphs.
  let positionedSections;
  const sections = [], floatingTables = [], tableColumnApproximations = []; let currentSection;
  const sectionFloatingTables = new Map();
  const firstParagraph = block => block.paragraph || firstParagraph(block.rows[0].cells[0].content[0]);
  const sourceBlocks = documentBlocks(paragraphs, tables);
  const framePlan = paragraphFrameGroups(sourceBlocks), paragraphFrames = [];
  const blocks = sourceBlocks.flatMap((block, blockIndex) => {
    const frameGroup = block.paragraph && framePlan.byParagraph.get(block.paragraph.id);
    if (frameGroup && frameGroup.members[0] !== block) return [];
    const floatingAnchor = block.table?.floating ? sourceBlocks.slice(blockIndex + 1).find(b => b.paragraph)?.paragraph : null;
    const p = firstParagraph(block);
    page = sectionPages.get(p.id);
    if (!currentSection || currentSection.sourcePage !== page) {
      currentSection = { sourcePage: page, page, start: sections.reduce((n, section) => n + section.count, 0), count: 0, measures: [] };
      if (pageStories) {
        const dynamic = { ...page, boundsBase: { top: page.top, bottom: page.bottom, height: page.height }, boundsOrigin: 0 };
        const stories = sectionStoryBounds(page, pageStories, sections.length, currentSection, measureBase, numbering, storyOptions);
        const reserve = storyOptions.noteReserve, section = currentSection;
        // Footnote areas shorten the text area of the pages that reference them.
        dynamic.pageBounds = reserve && Object.keys(reserve).length ? local => {
          const bounds = stories(local), note = reserve[(section.pageOffset ?? 0) + local] || 0;
          return note ? { top: bounds.top, bottom: Math.max(bounds.top + 1, Math.min(bounds.bottom, page.height - page.bottom - note)) } : bounds;
        } : stories;
        currentSection.page = dynamic;
      }
      currentSection.physicalPage = currentSection.page;
      currentSection.page = columnFlowPage(currentSection.page);
      sections.push(currentSection);
    }
    page = currentSection.page;
    if (page.flowColumns) {
      if (block.table && page.columns.equalWidth === false && page.columns.entries.some(e => e.width !== page.columns.entries[0].width)) {
        const reason = 'Tables in unequal-width section columns are not supported yet.';
        if (!storyOptions.bestEffort) throw new Error(reason);
        // Keep rich cells and the surrounding column flow. Table measurement
        // retains the first column's available width across continuations;
        // this is a display-only approximation, not editable layout support.
        tableColumnApproximations.push({ section: sections.length - 1, tableId: block.table.id, reason,
          message: `Section ${sections.length}, table ${tables.indexOf(block.table) + 1}: table layout in unequal-width columns is approximated using the first column's width in this read-only preview.` });
      }
      positionedSections ??= new Set(paragraphs.filter(p => p.runs.some(r => isSideWrappedImage(r.image))).map(p => sectionPages.get(p.id)));
      if (positionedSections.has(currentSection.sourcePage)) throw new Error('Square-wrapped drawings and floating tables in section columns are not supported yet.');
      if (block.table?.floating) {
        const reason = 'Floating tables in section columns are not supported yet.';
        if (!storyOptions.bestEffort) throw new Error(reason);
        tableColumnApproximations.push({ section: sections.length - 1, tableId: block.table.id, reason,
          message: `Section ${sections.length}, table ${tables.indexOf(block.table) + 1}: floating positioning in columns is approximated as an inline table at the column start in this read-only preview.` });
        // Only the transient layout block changes. Keep the authored table,
        // its cells and its positioning declaration in the imported package.
        // Imported alignment/indent can be derived from tblpX/tblpXSpec. They
        // must not retain an absolute-page offset in the inline approximation.
        block = { ...block, table: { ...block.table, floating: null, alignment: 'left', indent: 0, indentDeclared: true } };
      }
    }
    const nextSectionPage = p.sectionEnd && sourceBlocks[blockIndex + 1] && sectionPages.get(firstParagraph(sourceBlocks[blockIndex + 1]).id);
    // Compatibility mode 15 keeps the required paragraph after a table. A section's
    // sole paragraph survives in older modes too. The next section must continue
    // on the same paper (independent continuous-boundary controls).
    const keepBoundaryLine = Boolean(nextSectionPage?.sectionType === 'continuous' &&
      ['width', 'height'].every(key => page[key] === nextSectionPage[key]) &&
      (sourceBlocks[blockIndex - 1]?.table && page.compatibilityMode >= 15 || currentSection.count === 0));
    const measureBlock = (block, page, cellEdges) => {
      if (block.paragraph) {
        const previous = paragraphs[block.index - 1];
        const edges = cellEdges?.first && !cellEdges.rowStart && !Object.hasOwn(cellEdges, 'previousStyleId') && previous ? { ...cellEdges, previousStyleId: previous.resolvedStyleId ?? previous.styleId ?? null } : cellEdges;
        const textMeasure = page.rotatedCellText ? (text, style) => rotatedCellTextMetrics(measure(text, style), style) : measure;
        const hints = page.paragraphFrameFlow ? undefined : wrapHints && { ...wrapHints, exclusions: wrapHints.exclusions.filter(e => cellEdges ? e.cellId === block.paragraph.cellId : !e.cellId) };
        const run = () => measureParagraph(block.paragraph, block.offset, textMeasure, page, markers[block.index], numbering, edges, hints, !cellEdges && keepBoundaryLine);
        // Cells, wrapping around drawings, unequal columns and drawings themselves (whose objects
        // keep their identity) are always measured again.
        let key = null;
        if (paragraphCache && !cellEdges && !hints && !page.rotatedCellText && !page.columnWidthAt && !block.paragraph.runs.some(r => r.image)) {
          try { key = JSON.stringify([block.paragraph, pageKey(page), markers[block.index] ?? null, keepBoundaryLine, sharedKey]); } catch { key = null; }
        }
        const measured = key === null ? run() : paragraphCache.measure(key, block.offset, run);
        // Removing a floating frame from body flow must not join paragraph
        // borders across the source paragraph that interrupted the group.
        if (!page.paragraphFrameFlow && framePlan.byParagraph.has(previous?.id)) measured.borderGroupStart = true;
        return [measured];
      }
      const { table } = block;
      const cellBorders = new Map(), cellBottomWidths = new Map(); let borderWidths = tableRowBorderWidths(block, cellBorders, undefined, cellBottomWidths);
      const horizontal = tableHorizontalInsets(block, cellBorders, page);
      const availableWidth = (page.width - page.left - page.right - horizontal.left - horizontal.right + horizontal.widthAdjustment) * 15;
      const alignments = block.rows.map(row => row.alignment ?? table.alignment);
      // A nested table's negative indent cannot cross its
      // containing writing edge. Top-level negative indents remain signed.
      const indent = table.parentCellId ? Math.max(0, table.indent) : table.indent;
      const preferredWidth = table.width?.type === 'pct' ? availableWidth * table.width.value / 5000 : table.width?.type === 'dxa' ? table.width.value : 0;
      // An explicit preferred table width may extend into margins (or
      // outside a parent cell). Auto width still uses the writing-area limit.
      // A floating table's numeric position is exposed as its editing indent,
      // but does not reduce the space used to determine its AutoFit width.
      const limit = Math.max(preferredWidth, availableWidth + (horizontal.overflowWidthAdjustment || 0) * 15 - (!table.floating && alignments.includes('left') ? indent : 0));
      const intrinsic = table.layout === 'autofit' ? table.grid.map(() => ({ min: 0, max: 0, floor: 0, paddingFloor: 0, contentMin: 0 })) : null, spans = [];
      if (intrinsic) for (const row of block.rows) for (const { cell, column, span } of rowGrid(row)) {
        if (!cell.rowSpan) continue;
        const metrics = cellIntrinsicWidths(cell, measure, page, numbering, markers, cellBorders.get(cell.id));
        const values = Object.fromEntries(['min', 'max', 'floor', 'paddingFloor', 'contentMin'].map(key => [key, metrics[key] * 15]));
        if (span > 1) spans.push({ column, span, ...values });
        else for (const key of ['min', 'max', 'floor', 'paddingFloor', 'contentMin']) intrinsic[column][key] = Math.max(intrinsic[column][key], values[key]);
      }
      // In modern compatibility, indivisible content expands an absolute-width AutoFit
      // table beyond the writing area. Automatic/percentage preferences retain
      // their limit and clip overflow, as do legacy tables.
      const contentLimit = intrinsic && table.width?.type === 'dxa' && preferredWidth > 0 && (page.compatibilityMode ?? 12) >= 15
        ? Math.max(limit, minimumSpanWidth(intrinsic.map(c => c.floor), spans, 'floor')) : limit;
      const rounding = {};
      const allocated = intrinsic ? autoColumnWidths(table, availableWidth, intrinsic, contentLimit, spans, rounding) : fixedColumnWidths(table, availableWidth);
      const totalWidth = allocated.reduce((a, b) => a + b, 0);
      const minimums = intrinsic && intrinsic.every((c, i) => allocated[i] >= c.min - 1e-6) ? intrinsic.map(c => c.min) : [];
      const widths = roundColumnWidths(allocated, totalWidth, minimums, spans, rounding).map(w => w / 15);
      tableWidths[table.id] = widths;
      const width = widths.reduce((a,b) => a+b, 0), available = page.width - page.left - page.right;
      // Legacy top-level floating alignments use the exterior cells' writing
      // width; modern compatibility aligns the outer frame. Keep grid allocation and
      // numeric offsets unchanged. Independent asymmetric native controls
      // distinguish this from doubling either the leading or trailing margin.
      const legacyFloating = table.floating?.tblpXSpec && !table.parentCellId && (page.compatibilityMode ?? 12) < 15;
      const floatingWidth = width - (legacyFloating ? rowGrid(block.rows[0]).reduce((sum, { cell, column, end }) =>
        sum + (column === 0 ? cell.margins.left : 0) + (end === table.grid.length ? cell.margins.right : 0), 0) / 15 : 0);
      if (table.floating) floatingAlignmentWidths[table.id] = floatingWidth;
      const floatingInsets = table.floating && table.parentCellId ? {
        left: horizontal.left,
        right: Math.max(0, ...block.rows.flatMap(row => rowGrid(row)
          .filter(({ end }) => end === table.grid.length)
          .map(({ cell }) => tableBorderWidth(cellBorders.get(cell.id).right) / 2))),
      } : null;
      const alignmentLeft = horizontal.alignmentLeft ?? horizontal.left, alignmentRight = horizontal.alignmentRight ?? horizontal.right;
      const alignmentCenter = horizontal.alignmentCenter ?? (horizontal.left - horizontal.right) / 2;
      const lefts = alignments.map(alignment => table.floating
        ? table.parentCellId ? nestedFloatingTableX(table.floating, page, width, cellEdges, wrapHints?.paragraphs.get(cellEdges.anchorId)?.[0]?.page || 0, floatingInsets)
          : floatingTableX(table.floating, page, floatingWidth, (wrapHints?.paragraphs.get(floatingAnchor?.id)?.[0]?.page || 0) + firstPageSideOffset)
        : page.left + (alignment === 'center' ? (available - width) / 2 + alignmentCenter : alignment === 'right' ? available - width - alignmentRight : indent / 15 + alignmentLeft));
      // Tables may cross the physical page edge; page painting clips their ink.
      // Keep full geometry for wrapping, pagination, editing and retained export.
      if (lefts.some(left => left !== lefts[0])) borderWidths = tableRowBorderWidths(block, cellBorders, { lefts, widths }, cellBottomWidths);
      const flexibleCounts = [0];
      for (const row of block.rows) flexibleCounts.push(flexibleCounts.at(-1) + Number(row.heightRule !== 'exact'));
      const padding = block.rows.map(rowPadding);
      // Combine each cell's padding and border before taking the row maximum.
      // The row reserves its own top-border width, even if the preceding row
      // paints a different winning border. Keep text outside the winning ink
      // when cell padding is narrower than that stroke. Coordinates use centerlines.
      const writingTops = block.rows.map(row => Math.max(0, ...row.cells.map(cell =>
        cell.margins.top + cellBorderLayoutWidth(cell, 'top', cellWritingTopBorder(cell, cellBorders.get(cell.id).top)) * 15)));
      const pageBottomWidths = block.rows.map((row, index) => Math.max(0, ...row.cells.map(cell => cellBorderLayoutWidth(cell, 'bottom', cell.borders?.bottom ?? rowTableBorder(table, index, 'bottom')))));
      // Writing space uses the row's own bottom extent. A following top border
      // can win the shared paint boundary in a different column without
      // shortening this row's content. Convert that own extent to the shared
      // centerline below; keep paint conflict resolution independent.
      const ownBottomWidths = block.rows.map(row => Math.max(0, ...row.cells.map(cell =>
        cellBorderLayoutWidth(cell, 'bottom', cellBorders.get(cell.id).bottom))));
      const insets = padding.map((value, index) => {
        const row = block.rows[index], bottomEdge = borderWidths[index + 1] * 15 / 2;
        const bottom = Math.max(bottomEdge, ...row.cells.map(cell => {
          const border = cellBorders.get(cell.id).bottom;
          const extent = cellBorderLayoutWidth(cell, 'bottom', border) + Math.max(0, borderWidths[index + 1] - ownBottomWidths[index]);
          return cell.margins.bottom + extent * 15 - bottomEdge;
        }));
        return { top: Math.max(borderWidths[index] * 15 / 2, writingTops[index] - borderWidths[index] * 15 / 2), bottom };
      });
      const rows = block.rows.map((row, rowIndex) => {
        let x = lefts[rowIndex] + spanWidth(widths, 0, row.gridBefore || 0);
        const pageTopBorders = {}, pageBottomBorders = {};
        const cells = rowGrid(row).map(({ cell, column, span, end, index }) => {
          const box = { ...cell, column, x, tableOffsetX: x - lefts[rowIndex], width: spanWidth(widths, column, span), tableId: table.id, rowId: row.id, depth: (page.tableDepth || 0) + 1 };
          if (table.floating && table.parentCellId) box.floatingTable = { position: table.floating, cellId: table.parentCellId };
          pageTopBorders[column] = cell.borders?.top ?? rowTableBorder(table, rowIndex, 'top');
          if (row.borderExceptions) pageBottomBorders[column] = cell.borders?.bottom ?? rowTableBorder(table, rowIndex, 'bottom');
          x += box.width;
          if (!cell.rowSpan) return null;
          // A vertical merge joins content, not the physical rows' side borders.
          // Missing continuation sides must not inherit the restart cell's ink.
          if (cell.rowSpan > 1) {
            const physicalRows = block.rows.slice(rowIndex, rowIndex + cell.rowSpan);
            const physicalBorders = physicalRows.map(r => {
              const physical = rowGrid(r).find(c => c.column === column && c.span === span);
              return cellBorders.get(physical.cell.id);
            });
            // Keep a uniform side as one stroke, including its dash phase.
            if (physicalRows.some(r => r.borderExceptions) || physicalBorders.some(borders =>
              ['left','right'].some(side => ['style','size','color','frame','shadow'].some(key =>
                borders[side]?.[key] !== physicalBorders[0][side]?.[key])))) {
              box.rowSideBorders = physicalBorders.map((borders, offset) => ({...borders,
                topInset: borderWidths[rowIndex + offset] / 2, bottomInset: borderWidths[rowIndex + offset + 1] / 2}));
            }
          }
          const margins = { ...cell.margins, left: Math.max(cell.margins.left, cellBorderLayoutWidth(cell, 'left', cellBorders.get(cell.id).left) * 15 / 2), right: Math.max(cell.margins.right, cellBorderLayoutWidth(cell, 'right', cellBorders.get(cell.id).right) * 15 / 2), top: insets[rowIndex].top, bottom: insets[rowIndex + cell.rowSpan - 1].bottom };
          // A merged fill retains its restart cell's bottom padding. The row
          // reserves shared padding, which can leave a gap or a paint overlap.
          if (cell.rowSpan > 1) box.fillPadding = { top: cell.margins.top / 15, bottom: cell.margins.bottom / 15 };
          box.margins = margins;
          box.pageBottomInset = padding[rowIndex + cell.rowSpan - 1].bottom / 15 + pageBottomWidths[rowIndex + cell.rowSpan - 1];
          const clipOverflow = flexibleCounts[rowIndex] === flexibleCounts[rowIndex + cell.rowSpan];
          const cellPage = { ...page, tableDepth: box.depth, allowOverflowIndents: true, clipOverflow, left: box.x + margins.left / 15, right: page.width - x + margins.right / 15, top: page.top + margins.top / 15, bottom: page.bottom + margins.bottom / 15 };
          if (cellPage.left >= page.width - cellPage.right) throw new Error('Cell margins leave no writing space.');
          const nestedFloats = [];
          const previousCell = row.cells[index - 1];
          const continuationContext = previousCell?.rowSpan === 0 ? { previousStyleId: previousCell.continuationStyleId ?? null } : {};
          const nextCell = row.cells[index + 1];
          const nextParagraph = nextCell?.rowSpan ? firstParagraph(nextCell.content[0]) : null;
          const followingContext = nextCell ? { nextStyleId: nextCell.rowSpan === 0
            ? nextCell.continuationStyleId ?? null : nextParagraph.resolvedStyleId ?? nextParagraph.styleId ?? null } : {};
          box.blocks = cell.content.flatMap((child, cellIndex) => {
            const anchor = child.table?.floating ? cell.content.slice(cellIndex + 1).find(b => b.paragraph)?.paragraph : null;
            // A text-box story shifts nested tables to the leading inner
            // border edge, but still measures widths against the padded area.
            const nestedShift = page.shapeText && child.table && !child.table.floating
              ? margins.left / 15 - tableBorderWidth(cellBorders.get(cell.id).left) / 2 : 0;
            const childPage = page.shapeText && child.table && !child.table.floating ? {
              ...cellPage, left: cellPage.left - nestedShift, right: cellPage.right + nestedShift,
            } : cellPage;
            const results = measureBlock(child, childPage, { left: box.x, right: x, anchorId: anchor?.id, first: cellIndex === 0, rowStart: rowIndex > 0 && cell === row.cells[0], ...continuationContext, ...followingContext, last: cellIndex === cell.content.length - 1, afterTable: !!cell.content[cellIndex - 1]?.table, hideMark: cell.hideMark && cellIndex === cell.content.length - 1 });
            if (child.paragraph) for (const result of results) {
              if (result.format.pageBreakBefore) {
                if (!storyOptions.bestEffort && !storyOptions.previewCellPageBreaks) throw new Error('Page breaks inside table cells are not supported yet.');
                // Only the measured preview changes; retain the authored
                // property and rich paragraph in the model and original file.
                result.format = { ...result.format, pageBreakBefore: false };
              }
              if (result.lines.some(l => ['page', 'column'].includes(l.hardBreak))) throw new Error('Page breaks inside table cells are not supported yet.');
              for (const line of result.lines) { line.cellId = cell.id; line.columnLeft = cellPage.left; }
            }
            if (child.table?.floating) {
              if (!anchor) throw new Error('Floating tables require a following anchor paragraph.');
              nestedFloats.push({ tableId: child.table.id, cellRight: x, position: child.table.floating, blocks: results, anchorId: anchor.id });
              return [];
            }
            return results;
          });
          if (nestedFloats.length) box.blocks.floatingTables = nestedFloats;
          box.page = cellPage;
          const natural = paginateParagraphs(box.blocks, { ...cellPage, height: 1e9, top: 0, bottom: 0 }, MAX_PAGES);
          box.contentHeight = natural.endY;
          if (cell.textDirection && cell.textDirection !== 'lrTb') {
            hasRotatedCells = true;
            if (!['btLr', 'tbRl'].includes(cell.textDirection)) throw new UnsupportedRotatedCellError('Unsupported table-cell text direction.', cell.id);
            if (cell.content.some(child => !child.paragraph)) throw new UnsupportedRotatedCellError('Nested tables within rotated cells require additional layout support.', cell.id);
            if (cell.hideMark) throw new UnsupportedRotatedCellError('Hidden terminal marks in rotated cells require additional layout support.', cell.id);
            const terminal = cell.content.at(-1), markStyle = runFormat(terminal.paragraph.markFormat);
            const placeholder = measureBlock({ ...terminal, paragraph: { ...terminal.paragraph, runs: [], format: { ...terminal.paragraph.format, spaceBefore: 0 } } }, cellPage)[0];
            placeholder.format = { ...placeholder.format, spaceBefore: 0 };
            const required = rotatedCellMinimumHeight(placeholder.format, markStyle, measure('', markStyle));
            placeholder.lines = [{ ...placeholder.lines[0], cellId: cell.id, height: required - placeholder.format.spaceAfter * 4 / 3, fitHeight: required - placeholder.format.spaceAfter * 4 / 3 }];
            box.blocks = [placeholder];
            box.contentHeight = required;
            // Row allocation uses only the terminal mark. Measure retained
            // source text after the final physical rectangle is known.
            box.layoutRotated = allocated => {
              const frame = rotatedCellFrame(allocated, cell.textDirection, 'top', 0, cellPage.compatibilityMode);
              const localPage = { ...cellPage, width: Math.max(1, frame.width), height: 1e9,
                left: 0, right: 0, top: 0, bottom: 0, pageBounds: undefined, boundsBase: undefined,
                columns: undefined, flowColumns: undefined, clipOverflow: true, rotatedCellText: true };
              const localBlocks = cell.content.flatMap((child, index) => measureBlock(child, localPage, {
                left: 0, right: frame.width, first: index === 0, last: index === cell.content.length - 1,
                ...continuationContext, ...followingContext,
              }));
              const local = paginateParagraphs(localBlocks, localPage, MAX_PAGES);
              return { local, geometry: localPage, matrix: rotatedCellFrame(allocated, cell.textDirection, cell.vertical, local.endY, cellPage.compatibilityMode).matrix };
            };
          }
          box.borders = cellBorders.get(cell.id);
          if (cell.rowSpan > 1) {
            // The bottom edge belongs to the last physical continuation. An
            // absent continuation border does not inherit the restart's edge.
            const last = rowGrid(block.rows[rowIndex + cell.rowSpan - 1]).find(c => c.column === column && c.span === span);
            box.borders = { ...box.borders, bottom: cellBorders.get(last.cell.id).bottom };
          }
          box.pageTopBorder = cell.borders?.top ?? rowTableBorder(table, rowIndex, 'top');
          return box;
        }).filter(Boolean);
        const declaredHeight = exactRowHeight(row);
        // The top border and both cell margins are preserved even when the
        // declared exact extent is smaller. Convert that edge extent to the
        // border centerlines used by the row boxes (see independent probes).
        const exactFloor = (padding[rowIndex].top + padding[rowIndex].bottom) / 15 + borderWidths[rowIndex];
        const fixedHeight = declaredHeight == null ? null : Math.max(declaredHeight, exactFloor) + (borderWidths[rowIndex + 1] - borderWidths[rowIndex]) / 2;
        const minimumHeight = (row.minHeight + insets[rowIndex].top + insets[rowIndex].bottom) / 15;
        const height = fixedHeight ?? Math.max(minimumHeight, ...cells.filter(c => c.rowSpan === 1).map(c => c.contentHeight + (c.margins.top + c.margins.bottom) / 15));
        const beforeEdge = rowIndex === 0 ? borderWidths[0] / 2 : 0;
        const afterEdge = rowIndex === block.rows.length - 1 ? borderWidths.at(-1) / 2 : 0;
        // An opposing next-row top border can win the shared paint boundary.
        // Its exterior half is not part of this exact row's page-fit demand.
        // Keep the centerline geometry and the row's own bottom edge intact.
        const bottomFitInset = Math.max(0, (borderWidths[rowIndex + 1] - ownBottomWidths[rowIndex]) / 2);
        const pageTopEdge = Math.max(0, ...row.cells.map(cell =>
          cellBorderLayoutWidth(cell, 'top', cell.borders?.top ?? rowTableBorder(table, rowIndex, 'top'))
        )) / 2;
        // A first-cell keep reserves the start of the following row, or the
        // following paragraph at the end of the table.
        const keepNext = cells[0]?.column === 0 && cells[0]?.blocks[0]?.format.keepNext;
        return { tableRow: { ...row, cells, height, minimumHeight, fixedHeight, beforeEdge, afterEdge, bottomFitInset, pageTopEdge, pageTopBorders, pageBottomBorders, paddingTop: padding[rowIndex].top / 15, paddingBottom: padding[rowIndex].bottom / 15, topInset: insets[rowIndex].top / 15, bottomInset: insets[rowIndex].bottom / 15, topEdge: borderWidths[rowIndex] / 2, bottomEdge: borderWidths[rowIndex + 1] / 2 }, height: height + beforeEdge + afterEdge, format: { keepLines: row.cantSplit, keepNext } };
      });
      // tblHeader is retained in nested tables, but those rows do not repeat.
      // A containing top-level header still repeats its complete nested content.
      const count = table.parentCellId ? 0 : headerRowCount(table);
      if (count) {
        const tableHeader = prepareTableHeader(rows.map(row => row.tableRow), count, page, paginateParagraphs);
        return [{ tableHeader, height: tableHeader.height + tableHeader.minimum, format: { keepLines: true } }];
      }
      return mergedRowGroups(rows);
    };
    const measuredPage = page;
    if (frameGroup) {
      const frame = measureParagraphFrame(frameGroup, page, (member, geometry) => measureBlock(member, geometry), paginateParagraphs, MAX_PAGES);
      paragraphFrames.push(frame);
      if (frameGroup.terminal) {
        const last = frameGroup.members.at(-1), offset = last.offset + paragraphText(last.paragraph).length;
        const anchor = { ...last.paragraph, id: frameGroup.anchorId, runs: [], list: null, fieldMarkers: [],
          format: { ...paragraphFormat(last.paragraph, numbering), spaceBefore: 0, spaceAfter: 0,
            paragraphBorders: {}, paragraphShading: 'auto', pageBreakBefore: false, keepNext: false, keepLines: false } };
        const empty = measureParagraph(anchor, offset, measure, page, null, numbering);
        const result = { ...empty, lines: empty.lines.map(line => ({ ...line, virtual: true, height: 0, fitHeight: 0, baseline: 0 })) };
        currentSection.count++; currentSection.measures.push(() => [result]);
        return [result];
      }
      return [];
    }
    currentSection.measures.push(widthAt => measureBlock(block, { ...measuredPage, columnWidthAt: widthAt }));
    const result = measureBlock(block, page);
    if (block.table?.floating) {
      const anchor = floatingAnchor;
      if (!anchor) throw new Error('Floating tables require a following anchor paragraph.');
      const floating = { table: block.table, blocks: result, page, anchorId: anchor.id,
        alignmentWidth: floatingAlignmentWidths[block.table.id],
        measuredPageIndex: (wrapHints?.paragraphs.get(anchor.id)?.[0]?.page || 0) + firstPageSideOffset,
        start: sourceBlocks.find(b => b.paragraph?.id === anchor.id).offset };
      floatingTables.push(floating);
      const own = sectionFloatingTables.get(currentSection) || [];
      own.push(floating); sectionFloatingTables.set(currentSection, own);
      currentSection.count++;
      return [{ floatingFlow: floating }];
    }
    // Keep the declared after-spacing even when an empty section-ending
    // paragraph has no visible line. It is subtracted from the next before-gap.
    if (p.sectionEnd) currentSection.after = paragraphFormat(p, numbering).spaceAfter * 4 / 3;
    currentSection.count += result.length; return result;
  });
  // Next-page sections cannot collide in one body flow. A continuous section
  // can share a sheet with preceding floats, including their overlap policy.
  let flowGroup = [];
  const assignFlowCount = () => {
    const collisionRestricted = flowGroup.some(floating => floating.table.overlap === 'never');
    for (const floating of flowGroup) { floating.flowCount = flowGroup.length; floating.flowCollisionRestricted = collisionRestricted; }
  };
  for (const section of sections) {
    if (section.sourcePage.sectionType !== 'continuous') { assignFlowCount(); flowGroup = []; }
    flowGroup.push(...(sectionFloatingTables.get(section) || []));
  }
  assignFlowCount();
  const placed = { lines: [], cells: [], repeatedLines: [], floatingTables: [], columnSeparators: [], pageCount: 0, pages: [], pageSections: [], pageRegions: [] };
  if (tableColumnApproximations.length) placed.tableColumnApproximations = tableColumnApproximations;
  if (!sections.length) sections.push({ page, start: 0, count: 0 });
  let nextPageNumber = 1;
  for (const [sectionIndex, section] of sections.entries()) {
    let start = pageStories?.sections[sectionIndex]?.pageNumbering?.start;
    const previous = sections[sectionIndex - 1];
    // Continuous margin changes take effect within the current sheet; its
    // existing vertical bounds remain in force until the next sheet. A new
    // sheet starts when the physical paper dimensions change.
    const continues = (before, after) => before && after?.sourcePage.sectionType === 'continuous'
      && ['width', 'height'].every(key => before.sourcePage[key] === after.sourcePage[key]);
    const continuous = Boolean(continues(previous, section));
    if (continuous && start !== undefined) {
      const reason = 'Page-number restarts in continuous sections are not supported yet.';
      if (!storyOptions.bestEffort) throw new Error(reason);
      (placed.numberingApproximations ||= []).push({ section: sectionIndex, reason,
        message: `Section ${sectionIndex + 1}: page-number restart at ${start} in a continuous section is ignored in this read-only preview; numbering continues from the previous section.` });
      // Ignore the restart before odd/even handling, so it cannot insert a
      // spurious blank sheet. Keep the authored page-story settings intact.
      start = undefined;
    }
    // The recto/verso side is preserved across numbering restarts in duplex
    // documents. Compare logical numbers, including an initially even section.
    if (sectionIndex && pageStories?.evenAndOdd && start !== undefined && start % 2 !== nextPageNumber % 2) {
      placed.pages.push(placed.pages.at(-1)); placed.pageSections.push(null); placed.pageCount++;
    }
    // An odd- or even-page section starts on the next page of that parity (§17.18.77); an empty page
    // between them takes the number in between unless the section restarts its numbering.
    const parity = { oddPage: 1, evenPage: 0 }[section.sourcePage.sectionType];
    if (sectionIndex && parity !== undefined && placed.pageCount && (start ?? nextPageNumber) % 2 !== parity) {
      placed.pages.push(placed.pages.at(-1)); placed.pageSections.push(null); placed.pageCount++;
      if (start === undefined) nextPageNumber++;
    }
    if (placed.pageCount >= MAX_PAGES) throw new Error(`This preview supports up to ${MAX_PAGES} pages.`);
    section.firstNumber = start ?? nextPageNumber;
    const balance = continues(section, sections[sectionIndex + 1]);
    const approximateAlignment = section.page.verticalAlignment && section.page.verticalAlignment !== 'top' && (continuous || balance || section.page.columns);
    if (approximateAlignment) {
      const reason = 'Vertical page alignment with columns or continuous sections is not supported yet.';
      if (!storyOptions.bestEffort) throw new Error(reason);
      (placed.alignmentApproximations ||= []).push({ section: sectionIndex, reason,
        message: `Section ${sectionIndex + 1}: ${section.page.verticalAlignment} vertical alignment with columns or continuous sections is shown at the top in this read-only preview.` });
    }
    let physical = section.physicalPage || section.page;
    let startY = pageBounds(physical).top;
    if (continuous) {
      const firstBounds = pageBounds(previous.physicalPage || previous.page, placed.pageCount - 1 - previous.pageOffset);
      const ownBounds = physical;
      physical = { ...physical, boundsBase: { top: physical.top, bottom: physical.bottom, height: physical.height }, boundsOrigin: 0,
        pageBounds: index => index === 0 ? firstBounds : pageBounds(ownBounds, index) };
      startY = placed.endY;
      section.firstNumber = nextPageNumber - 1;
    }
    section.physicalPage = physical;
    const offset = placed.pageCount - Number(continuous);
    section.pageOffset = offset;
    physical = { ...physical, floatingPageSideBase: offset + firstPageSideOffset };
    const sectionBlocks = blocks.slice(section.start, section.start + section.count);
    if (physical.columns?.equalWidth === false) sectionBlocks.remeasure = widthAt => section.measures.flatMap(measure => measure(widthAt));
    const paginateSection = () => continuous || balance
      ? paginateColumnRegion(sectionBlocks, physical, paginateParagraphs, MAX_PAGES - offset, startY, previous?.after || 0, balance)
      : placeColumnFlow(paginateColumnWidths(sectionBlocks, physical, paginateParagraphs, (MAX_PAGES - placed.pageCount) * (section.page.flowColumns || 1), startY, previous?.after || 0), section.sourcePage || section.page);
    let result = paginateSection();
    if (continuous) for (let attempt = 0; attempt < MAX_PAGES; attempt++) {
      const firstPage = Math.min(...result.lines.filter(line => !line.virtual).map(line => line.page), ...result.cells.map(cell => cell.page));
      if (!Number.isFinite(firstPage) || firstPage === (section.firstPage || 0)) break;
      section.firstPage = firstPage;
      result = paginateSection();
      if (attempt === MAX_PAGES - 1) throw new Error('Continuous-section first-page stories did not converge.');
    }
    nextPageNumber = section.firstNumber + result.pageCount;
    const regionIds = [], occupiedBottoms = Array(result.pageCount).fill(-Infinity);
    for (const line of result.lines) if (!line.virtual) occupiedBottoms[line.page] = Math.max(occupiedBottoms[line.page], Math.min(line.y + line.height, line.cellClip?.bottom ?? Infinity));
    for (const cell of result.cells) occupiedBottoms[cell.page] = Math.max(occupiedBottoms[cell.page], cell.y + cell.height);
    const occupiedPages = new Set([...result.lines, ...result.cells].map(item => item.page));
    for (let local = 0; local < result.pageCount; local++) {
      const index = offset + local, regions = placed.pageRegions[index] ||= [];
      const region = regions.length; regionIds.push(region);
      if (index < placed.pageCount && !occupiedPages.has(local)) continue;
      const top = local === 0 ? startY : pageBounds(physical, local).top;
      const bottom = local === result.pageCount - 1 ? Math.max(result.endY, occupiedBottoms[local]) : pageBounds(physical, local).bottom;
      const authoredGeometry = readingPageGeometry(section.sourcePage || section.page, section.firstNumber + local - 1);
      // Only the affected section's display geometry changes. The source page
      // settings and supported alignment on other pages remain intact.
      const geometry = approximateAlignment ? { ...authoredGeometry, verticalAlignment: 'top' } : authoredGeometry;
      regions.push({ section: sectionIndex, top, bottom, drawingBounds: pageBounds(physical, local), geometry,
        ...(physical.verticalAlignment && physical.verticalAlignment !== 'top' ? { alignmentBounds: pageBounds(physical, local) } : {}) });
      if (geometry.columns?.separator && result.lines.some(l => l.page === local && l.column > 0 && !l.virtual)) {
        const intervals = sectionColumnIntervals(geometry.columns, geometry.left*15, (geometry.width-geometry.left-geometry.right)*15);
        const end = occupiedBottoms[local];
        const lastColumn = Math.max(...result.lines.filter(l => l.page === local && !l.virtual).map(l => l.column || 0));
        for (let c=0;c<lastColumn;c++) placed.columnSeparators.push({ page:index, x:(intervals[c].right+intervals[c+1].left)/30-.5, y:top, width:1, height:Math.max(0,end-top) });
      }

      if (index >= placed.pageCount) {
        placed.pages.push(geometry); placed.pageSections.push(sectionIndex); placed.pageCount++;
      }
    }
    for (const key of ['lines', 'cells', 'repeatedLines']) placed[key].push(...result[key].map(item => {
      const base = section.sourcePage || section.page;
      const marginShift = readingPageGeometry(base, section.firstNumber + item.page - 1).left - base.left;
      let dx = marginShift;
      // Mirrored indents (§17.3.1.18): on even pages the left indent becomes the inside (right) one.
      // Text width is unchanged, so the line only moves sideways.
      const mirror = key === 'lines' && item.paragraphId && mirroredIndents.get(item.paragraphId);
      if (mirror && (offset + item.page) % 2 === 1) dx += mirror;
      return { ...shiftTableItem(item, dx, 0), ...(base.bookFold || base.mirror ? { pageMarginShift: marginShift } : {}), page: offset + item.page, region: regionIds[item.page] };
    }));
    placed.endY = result.endY;
    for (const frame of result.floatingTables || []) placed.floatingTables.push({ ...frame, page: offset + frame.page });
  }
  const nonoverlappingTables = placed.floatingTables.filter(frame => frame.overlap === 'never');
  for (const floating of floatingTables) {
    if (placed.floatingTables.some(frame => frame.tableId === floating.table.id)) continue;
    const anchor = placed.lines.find(l => l.paragraphId === floating.anchorId);
    if (!anchor) throw new Error('Missing floating-table anchor.');
    const geometry = placed.pages[anchor.page], naturalPage = { ...floating.page, pageBounds: undefined, height: 1e9, top: 0, bottom: 0 };
    const natural = floating.natural || paginateParagraphs(floating.blocks, naturalPage, MAX_PAGES, 0);
    const y = floatingTableY(floating.table.floating, geometry, natural.endY, anchor);
    let result = floating.probe?.y === y ? floating.probe.result : paginateParagraphs(floating.blocks, { ...floating.page, pageBounds: undefined, top: Math.min(0,y), bottom: 0 }, MAX_PAGES, y);
    if (result.pageCount !== 1) throw new Error('Multi-page floating tables are not supported yet.');
    if (floating.page.bookFold || floating.page.mirror) {
      const width = floating.alignmentWidth;
      const measuredPage = floating.measuredPageIndex;
      const dx = floatingTableX(floating.table.floating, geometry, width, anchor.page + firstPageSideOffset) - floatingTableX(floating.table.floating, floating.page, width, measuredPage);
      result = { ...result, ...Object.fromEntries(['lines', 'cells', 'repeatedLines'].map(key => [key, result[key].map(item => shiftTableItem(item, dx, 0))])) };
    }
    const inset = floatingTableInset(result.cells, floating.table, (floating.page.compatibilityMode ?? 12) >= 15);
    if (inset) result = { ...result, ...Object.fromEntries(['lines', 'cells', 'repeatedLines'].map(key => [key, result[key].map(item => shiftTableItem(item, inset, 0))])) };
    const cells = result.cells.filter(c => c.tableId === floating.table.id);
    const left = Math.min(...cells.map(c => c.x)), right = Math.max(...cells.map(c => c.x+c.width));
    const frame = avoidTableOverlap({ tableId: floating.table.id, page: anchor.page, start: anchor.start, left, right, top: y, bottom: result.endY, position: floating.table.floating, overlap: floating.table.overlap }, floating.table.overlap === 'never' ? placed.floatingTables : nonoverlappingTables, geometry);
    const wrapBounds = floatingFragmentBounds(cells, (floating.page.compatibilityMode ?? 12) >= 15, floating.table);
    frame.wrapBounds = { left: wrapBounds.left + frame.left - left, right: wrapBounds.right + frame.left - left,
      top: wrapBounds.top + frame.top - y, bottom: wrapBounds.bottom + frame.top - y };
    if (frame.bottom > geometry.height && frame.top !== y) throw new Error('Floating-table collisions crossing a page boundary are not supported yet.');
    for (const key of ['lines','cells','repeatedLines']) placed[key].push(...result[key].map(item => ({ ...shiftTableItem(item, frame.left-left, frame.top-y), page: anchor.page })));
    placed.floatingTables.push(frame);
    if (frame.overlap === 'never') nonoverlappingTables.push(frame);
  }
  const nestedFrames = new Map();
  for (const cell of placed.cells) if (cell.floatingTable) {
    const key = `${cell.tableId}:${cell.page}`, frame = nestedFrames.get(key);
    if (frame) {
      frame.left = Math.min(frame.left, cell.x); frame.right = Math.max(frame.right, cell.x + cell.width);
      frame.top = Math.min(frame.top, cell.y); frame.bottom = Math.max(frame.bottom, cell.y + cell.height);
    } else nestedFrames.set(key, { ...cell.floatingTable, tableId: cell.tableId, page: cell.page,
      left: cell.x, right: cell.x + cell.width, top: cell.y, bottom: cell.y + cell.height });
  }
  placed.floatingTables.push(...nestedFrames.values());
  placeParagraphFrames(paragraphFrames, placed, storyOptions.frameGeometry);
  // Source order remains authoritative for caret motion and document offsets.
  if (placed.floatingTables.length) placed.lines.sort((a,b) => a.start-b.start);
  page = finalPage;
  placed.floatingObjects = [];
  const allLines = [...placed.lines, ...placed.repeatedLines];
  for (const line of allLines) for (const f of line.fragments) if (isPositionedImage(f.image)) {
    const first = f.image.anchor.vertical === 'line' ? line : allLines.find(l => l.paragraphId === line.paragraphId && (!line.header || l.page === line.page) && (line.drawingSegmentStart === undefined || l.start >= line.drawingSegmentStart));
    const geometry = placed.pageRegions[first.page]?.[first.region]?.geometry || placed.pages[first.page];
    const cell = line.cellId ? placed.cells.find(c => c.id === line.cellId && c.page === first.page) : null;
    const frame = { ...positionedImageFrame(f, first, { ...geometry, drawingBounds: placed.pageRegions[first.page]?.[first.region]?.drawingBounds }, cell), region: first.region };
    // Unwrapped cell drawings belong to their anchor's page. Their ink
    // may extend outside both automatic and exact-height cells without clipping.
    placed.floatingObjects.push(frame);
  }
  resolveDrawingCollisions(placed.floatingObjects, placed.pages);
  placed.floatingObjects.sort((a, b) => a.image.anchor.order - b.image.anchor.order);
  const paragraphBorders = layoutParagraphBorders(placed);
  let offset = 0;
  const pageOffsets = placed.pages.map(p => { const start = offset; offset += p.height; return start; });
  return { ...placed, page, pageOffsets, tableWidths, paragraphBorders, tableBorders: layoutTableBorders(placed.cells), ...(hasRotatedCells ? { hasRotatedCells: true } : {}) };
}

// Give pagination all rows connected by vertical spans, without keeping them on a page.
function mergedRowGroups(rows) {
  const result = [];
  for (let first = 0; first < rows.length;) {
    let last = first;
    for (let i = first; i <= last; i++) for (const cell of rows[i].tableRow.cells) last = Math.max(last, i + cell.rowSpan - 1);
    if (last === first) { result.push(rows[first++]); continue; }
    const group = rows.slice(first, last + 1).map(r => r.tableRow);
    const height = (group[0].fixedHeight ?? Math.max(group[0].height, ...group[0].cells.map(c => blockMinimumHeight(c.blocks[0]) + (c.margins.top + c.margins.bottom) / 15))) + (group[0].beforeEdge || 0);
    result.push({ tableGroup: { rows: group }, height, format: { keepLines: false } }); first = last + 1;
  }
  return result;
}

function measureParagraph(p, documentOffset, measure, page, listMarker, numbering, cellBounds, wrapHints, keepBoundaryLine = false) {
  const lines = [], format = spacedFormat(paragraphFormat(p, numbering), page.textSpacing), text = paragraphText(p);
  if (p.list) format.autoSpacingListId = numbering.instances[p.list.numId].abstractId;
  if (page.doNotUseHTMLParagraphAutoSpacing) format.addParagraphSpacing = true;
  for (const side of ['Before', 'After']) if (format['autoSpace' + side]) {
    if (page.doNotUseHTMLParagraphAutoSpacing) {
      format['space' + side] = format['explicitSpace' + side];
      delete format['autoSpace' + side];
    } else if (cellBounds?.[side === 'Before' ? 'first' : 'last']) format['space' + side] = 0;
  }
  // An empty hidden end-of-cell paragraph contributes neither line spacing nor
  // before/after spacing, even with exact or minimum line height.
  // Normalize only this measured copy: typing must restore the stored format.
  // An empty terminal paragraph is suppressed immediately after
  // a nested table. A second paragraph, whitespace or any content retains its
  // normal allocation; the stored paragraph remains available for editing.
  const emptyTableEnd = cellBounds?.last && cellBounds.afterTable && !text.length && !listMarker;
  if ((cellBounds?.hideMark || emptyTableEnd) && !text.length && !listMarker) Object.assign(format, { spaceBefore: 0, spaceAfter: 0, lineRule: 'auto', lineSpacing: 1 });
  // Empty section-break paragraphs are normally suppressed. Required continuous
  // boundaries retain their line, spacing and shading, but never their border.
  // Spaces, drawing anchors and field boundaries still constitute paragraph
  // content, including zero-width XE entries and empty cached field results.
  const emptySectionBoundary = Boolean(p.sectionEnd) && !text.length && !listMarker && !p.fieldMarkers?.length;
  if (emptySectionBoundary) {
    format.paragraphBorders = {};
    if (!keepBoundaryLine) Object.assign(format, { spaceBefore: 0, spaceAfter: 0, pageBreakBefore: false, keepNext: false, keepLines: false, paragraphShading: 'auto' });
  }
  const floating = floatingParagraph(p, documentOffset, format, page);
  if (floating) return floating;
  checkJustificationText(text, format.alignment);
  if (cellBounds && page.allowSpaceOfSameStyleInTable) format.contextualSpacing = false;
  // Within a row, the next cell's first source paragraph supplies the context.
  // At the row end, an implicit Normal-style boundary is used instead.
  if (cellBounds?.last && format.contextualSpacing && (Object.hasOwn(cellBounds, 'nextStyleId')
    ? cellBounds.nextStyleId === (p.resolvedStyleId ?? p.styleId ?? null)
    : p.resolvedStyleName?.toLowerCase() === 'normal')) format.spaceAfter = 0;
  // Within a row, the first cell paragraph is compared with the preceding
  // source paragraph before vertical alignment. New rows start a new context.
  if (cellBounds?.first && Object.hasOwn(cellBounds, 'previousStyleId') && format.contextualSpacing &&
      cellBounds.previousStyleId === (p.resolvedStyleId ?? p.styleId ?? null)) format.spaceBefore = 0;
  // Validate each line when it is actually laid out below. A hanging indent can
  // leave no continuation width in a narrow cell even though its sole first
  // line (including an empty paragraph mark) has valid writing space.
  let chars = [];
  // Segment the whole paragraph, so a grapheme spanning two format runs stays intact.
  let runIndex = 0, runEnd = p.runs[0]?.text.length ?? 0, styleIndex = -1, runStyle, runHidden = false;
  for (const s of inlineSegments(text)) {
    while (s.index >= runEnd && runIndex < p.runs.length - 1) runEnd += p.runs[++runIndex].text.length;
    // Normalize the immutable run once; font-slot selection still follows each
    // grapheme, including one that crosses a source run boundary.
    if (styleIndex !== runIndex) {
      runStyle = bodySymbolStyle(p.runs[runIndex], runFormat(p.runs[runIndex]));
      if (page.textSpacing?.character) runStyle.characterSpacing = (runStyle.characterSpacing || 0) + page.textSpacing.character;
      if (p.runs[runIndex]?.noteMark) runStyle.noteMark = true;
      runHidden = !!p.runs[runIndex]?.vanish && !revisionView.showHidden;
      // Shown hidden text carries a dotted underline so it reads as hidden; the run itself is unchanged.
      if (p.runs[runIndex]?.vanish && revisionView.showHidden && (!runStyle.underlineStyle || runStyle.underlineStyle === 'none')) Object.assign(runStyle, { underline: true, underlineStyle: 'dotted', underlineColor: 'auto' });
      const display = runRevisionDisplay(p.runs[runIndex]);
      if (display?.hidden) runHidden = true; else if (display) Object.assign(runStyle, display);
      styleIndex = runIndex;
    }
    // Inline page/column breaks in cell XML are retained but have no
    // advance or pagination effect. Keep source offsets for editing and undo.
    const ignoredCellBreak = runHidden || !!p.cellId && (s.segment === '\f' || s.segment === '\u000e');
    const noBreakHyphen = !!p.runs[runIndex]?.noBreakHyphen;
    const displayText = inlineDisplayText(p.runs[runIndex], s.segment);
    chars.push({ text: ignoredCellBreak ? '' : displayText, ignoredCellBreak, ...(noBreakHyphen ? { noBreakHyphen: true } : {}), breakClear: p.runs[runIndex]?.breakClear, start: documentOffset + s.index, end: documentOffset + s.index + s.segment.length, style: textFontStyle(displayText, runStyle), image: runHidden ? undefined : p.runs[runIndex]?.image, positionalTab: p.runs[runIndex]?.positionalTab });
  }
  // Active RTL import/editing remains guarded while interaction is verified.
  // Do not alter the existing unmarked-text path during that rollout.
  if (chars.some(c=>c.style.rtl)) chars=bidiCharacters(chars);
  // Leading page/column breaks move the first text line without consuming its
  // first-line indent. Spaces, tabs, manual line breaks and list markers do
  // consume it. Keep source offsets and the break-only pagination lines intact.
  let firstIndentedStart = 0;
  if (!listMarker) while (['\f','\u000e'].includes(chars[firstIndentedStart]?.text)) firstIndentedStart++;
  const contractionSpace = format.alignment === 'both' && (page.compatibilityMode ?? 12) >= 15 ? contractionMetrics(measure) : null;
  let start = 0, row = null, pieceIndex = 0, pieces = [], clearance = null, drawingSegmentStart, hyphenatedLines = 0;
  const columnPage = page;
  do {
    if (columnPage.columnWidthAt && !cellBounds) page = { ...columnPage, right: columnPage.width-columnPage.left-columnPage.columnWidthAt(chars[start]?.start ?? documentOffset+text.length) };
    if (!row) row = squareRow(wrapHints, p.id, lines.length, paragraphEdges(format, page, start <= firstIndentedStart), page, 0, format.spaceBefore * 4 / 3, clearance);
    const edges = row.intervals[pieceIndex], right = edges.right;
    const { left, marker } = markerGeometry(start === 0 ? listMarker : null, runFormat(p.markFormat), edges.left, right, format, page, measure, documentOffset);
    const available = right - left;
    const scanner = new LineBuilder(left, right, format, page, measure, chars[start]?.start ?? documentOffset + text.length);
    let end = start, lastBreak = -1, contraction = null, visibleItems = 0, oversizedInline = false;
    while (end < chars.length) {
      const c = chars[end];
      if (c.ignoredCellBreak) { scanner.add(c); end++; continue; }
      if (c.text === '\v' || c.text === '\f' || c.text === '\u000e') break;
      const hangingSpace = c.text === ' ' && !bidiRtlSpace(c) && !page.wrapTrailSpaces && available > 0;
      // The first unbreakable item is accepted even when wider than the line,
      // including spaced/scaled graphemes and oversized inline drawings.
      // A tab at the right edge belongs to the next line, rather than collapsing
      // every subsequent tab onto the same zero-width caret position.
      if (c.text === '\t' && scanner.end >= right - 1e-6 && visibleItems > 0) break;
      if (c.positionalTab && scanner.end > scanner.positionalTarget(c) + 1e-6 && visibleItems > 0) { lastBreak = end; break; }
      scanner.add(c);
      const candidate = scanner.endBeforeSpace(chars[end + 1]);
      if (candidate > right + 1e-6 && visibleItems > 0 && !hangingSpace && !(oversizedInline && c.text === '\u00ad')) {
        contraction = contractionSpace && fitContractedWord(chars, start, end, lastBreak, scanner, right, contractionSpace);
        if (contraction) end = lastBreak = contraction.end;
        break;
      }
      end++; visibleItems++;
      // Legacy compatibility starts following spaces on the next line. Mode 15 keeps
      // invisible soft hyphens and hanging spaces with the oversized drawing;
      // visible text still starts the next line (independent native controls).
      if (c.image && !isPositionedImage(c.image) && inlineImageExtents(c.image, page).width / EMU_PER_PX > available + 1e-6) {
        if ((page.compatibilityMode ?? 12) < 15) break;
        oversizedInline = true;
      }
      if (oversizedInline && [' ', '\u00ad'].includes(c.text)) lastBreak = end;
      if (breakAfter(c.text, c.image, c.noBreakHyphen) && (c.text !== '\u00ad' || scanner.discretionaryEnd() <= right + 1e-6)) lastBreak = end;
    }
    // A word that fits the next interval stays intact instead of being split
    // into a narrow sliver beside a floating object.
    if (lastBreak < 0 && end < chars.length && !['\v','\f','\u000e'].includes(chars[end].text) && !pieces.length) {
      const fullEdges = paragraphEdges(format, page, start <= firstIndentedStart), fullWidth = fullEdges.right - fullEdges.left;
      const maximum = Math.max(...row.intervals.map(i => i.right - i.left));
      if (maximum < fullWidth - 1e-6) {
        const word = new LineBuilder(0,1e9,format,page,measure,chars[start].start);
        for (let i=start;i<chars.length;i++) {
          if ([' ','\v','\f','\u000e'].includes(chars[i].text)) break;
          word.add(chars[i]);
          if (word.end > fullWidth || breakAfter(chars[i].text, chars[i].image, chars[i].noBreakHyphen)) break;
        }
        // The obstacle is cleared before emergency character breaks are used.
        // Cap at the paragraph width so overlong words still make progress.
        if (word.end > maximum + 1e-6) {
          row = squareRow(wrapHints,p.id,lines.length,fullEdges,page,Math.min(word.end,fullWidth),format.spaceBefore * 4 / 3,clearance);
          pieceIndex = 0;
          continue;
        }
      }
    }
    if (lastBreak < 0 && end < chars.length && !['\v','\f','\u000e'].includes(chars[end].text) && pieceIndex + 1 < row.intervals.length) {
      const maximum = Math.max(...row.intervals.slice(pieceIndex+1).map(i => i.right-i.left));
      const word = new LineBuilder(0,1e9,format,page,measure,chars[start].start);
      // Stop as soon as no later interval can contain it, rather than scanning
      // the remaining paragraph for every slice of a long unbreakable word.
      for (let i=start;i<chars.length;i++) {
        if ([' ','\v','\f','\u000e'].includes(chars[i].text)) break;
        word.add(chars[i]);
        if (word.end > maximum || breakAfter(chars[i].text, chars[i].image, chars[i].noBreakHyphen)) break;
      }
      if (word.end <= maximum) { pieceIndex++; continue; }
    }
    // Automatic hyphenation splits the word that overflows the line when the line would otherwise
    // end further from the margin than the hyphenation zone (hyphenation-layout.js).
    const autoHyphen = page.autoHyphenation && !format.suppressAutoHyphens && !oversizedInline && !contraction && end < chars.length && !['\v', '\f', '\u000e'].includes(chars[end].text)
      ? autoHyphenationBreak(chars, start, end, lastBreak, { right, zone: page.hyphenationZone, caps: !page.doNotHyphenateCaps, limitReached: page.consecutiveHyphenLimit > 0 && hyphenatedLines >= page.consecutiveHyphenLimit,
        lineEnd: (to, hyphen) => { const probe = new LineBuilder(left, right, format, page, measure, chars[start].start); for (let i = start; i < to; i++) probe.add(chars[i]); if (hyphen) probe.add(hyphenCharacter(chars[to - 1])); return hyphen ? probe.end : probe.field.origin + probe.field.contentWidth; } })
      : null;
    if (autoHyphen !== null) end = lastBreak = autoHyphen;
    if (end < chars.length && !['\v', '\f', '\u000e'].includes(chars[end].text) && lastBreak > start) end = lastBreak;
    const softBreak = !oversizedInline && end < chars.length && !['\v', '\f', '\u000e'].includes(chars[end].text) && chars[end - 1]?.text === '\u00ad' && end === lastBreak;
    let span = chars.slice(start, end);
    if (softBreak) span[span.length - 1] = { ...span.at(-1), text: '-', discretionaryHyphen: true };
    if (autoHyphen !== null) span.push(hyphenCharacter(chars[end - 1]));
    hyphenatedLines = softBreak || autoHyphen !== null ? hyphenatedLines + 1 : 0;
    span = bidiLineCharacters(span);
    // A terminal break normally keeps the paragraph mark on the old page. Give
    // its following insertion position a caret, without consuming a line/gap.
    const virtual = emptySectionBoundary && !keepBoundaryLine || start === chars.length && chars.at(-1)?.text === '\f' && !page.splitPgBreakAndParaMark;
    const hardBreak = chars[end]?.text === '\f' ? 'page' : chars[end]?.text === '\v' ? 'line' : chars[end]?.text === '\u000e' ? 'column' : null;
    const offset = chars[start]?.start ?? documentOffset + text.length;
    const builder = new LineBuilder(left, right, format, page, measure, offset);
    for (const c of span) builder.add(c);
    const pageBreakWithMark = hardBreak === 'page' && end === chars.length - 1 && !page.splitPgBreakAndParaMark;
    // A terminal page break sharing the paragraph mark takes that mark's
    // metrics, not the break run's font. Visible text still contributes its
    // own metrics. Manual line breaks and split page breaks remain distinct.
    const markStyle = end === chars.length || pageBreakWithMark ? runFormat(p.markFormat) : hardBreak ? chars[end].style : null;
    // Terminal-mark and manual-line-break metrics are ignored on text lines.
    // Blank lines retain their own mark/break formatting, including when the
    // two have different fonts. Page and column breaks have separate rules.
    const ignoreMark = end === chars.length && (cellBounds?.hideMark || emptyTableEnd) ||
      (end === chars.length || hardBreak === 'line') && span.some(c => !c.image && !c.style.noteMark && hasLineText(c.text));
    let measured = builder.finish(markStyle, ignoreMark, !!marker);
    if (contraction) {
      let fraction = contraction.fraction;
      for (let attempt = 0; attempt < 4; attempt++) {
        const contracted = new LineBuilder(left, right, format, page, measure, offset);
        span.forEach((c, i) => contracted.add(i + start >= contraction.first && i + start < contraction.contentEnd && !c.image && c.text !== '\u00a0'
          ? { ...c, style: { ...c.style, justificationSpacing: -fraction * contractionSpace(c.style) } } : c));
        measured = contracted.finish(markStyle, ignoreMark, !!marker);
        const overflow = measured.width - measured.ignoredTrailingWidth - measured.ignoredTabWidth - available;
        if (overflow <= 1e-6) break;
        // Match the expansion path's finite-precision correction without
        // weakening cell bounds or moving the source's caret offsets.
        fraction += (overflow + .0001) / contraction.spaces;
      }
    }
    const lastLine = end === chars.length || hardBreak === 'page' && end === chars.length - 1 && !page.splitPgBreakAndParaMark;
    if (format.alignment === 'both' && !contraction && !lastLine && !(hardBreak === 'line' && page.doNotExpandShiftReturn)) {
      const range = justificationRange(span, measured, right, builder.field.tab);
      if (range) {
        let spacing = range.spacing;
        for (let attempt = 0; attempt < 4; attempt++) {
          const expanded = new LineBuilder(left, right, format, page, measure, offset);
          span.forEach((c, index) => expanded.add(index >= range.first && index < range.last && !c.image && (!/^\p{White_Space}+$/u.test(c.text) || c.text === ' ' || c.text === '\u00a0') ? { ...c, style: { ...c.style, justificationSpacing: spacing } } : c));
          measured = { ...expanded.finish(markStyle, ignoreMark, !!marker), justificationSpacing: spacing };
          const overflow = measured.stops.at(-1).x - measured.ignoredTrailingWidth - right;
          if (overflow <= 1e-6) break;
          // Native text advances use finite precision. Re-measure slightly
          // smaller gaps rather than weakening the cell's overflow check.
          spacing = Math.max(0, spacing - (overflow + .0001) / range.gaps);
        }
      }
    }
    const contentWidth = measured.width - measured.ignoredTabWidth - measured.ignoredTrailingWidth;
    const oversizedImage = span.some(c => c.image && !isPositionedImage(c.image) && inlineImageExtents(c.image, page).width / EMU_PER_PX > available + 1e-6);
    const oversizedText = cellBounds && contentWidth > available + 1e-6 && !oversizedImage && span.some(c => !c.image && c.text !== '\t' && measure(c.text, c.style).width > available + 1e-6);
    if (cellBounds && contentWidth > available + 1e-6 && !oversizedImage && !oversizedText) throw new Error('This text is too wide for the table cell. Use a smaller font or wider columns.');
    if (marker) {
      // A tall numbering label raises the first baseline, but layout retains
      // the paragraph text's descent and automatic-spacing metrics when
      // advancing to the next line. Extra leading does not scale marker rise.
      measured.spacingHeight ??= measured.ascent + measured.descent;
      measured.spacingAscent ??= measured.ascent;
      measured.ascent = Math.max(measured.ascent, marker.lineAscent ?? marker.ascent);
    }
    const naturalHeight = measured.ascent + measured.descent;
    // Zero exact points mean natural height, unlike zero multiples.
    // Preserve the stored rule/value so edits and export do not rewrite it.
    const exact = format.lineRule === 'exact' && format.lineSpacing !== 0;
    const height = format.lineRule === 'auto' ? naturalHeight + (measured.spacingHeight ?? naturalHeight) * (format.lineSpacing - 1) : exact ? format.lineSpacing * 4 / 3 : Math.max(naturalHeight, format.lineSpacing * 4 / 3);
    // Expanded automatic leading advances the next line but does not consume
    // space below the last line at a page boundary (native boundary controls).
    const fitHeight = format.lineRule === 'auto' ? Math.min(height, naturalHeight) : height;
    const capacity = page.height - page.top - page.bottom;
    // Oversized body content is consumed once on a fresh page. Use the same
    // physical-page editing clip for automatic leading extending past it.
    const oversizedInlineHeight = (fitHeight > capacity || height > capacity) && !page.tableDepth && !page.shapeText &&
      (format.lineRule === 'auto' && height > capacity && fitHeight <= capacity || measured.fragments.some(f => f.image
        ? !isPositionedImage(f.image) && inlineImageExtents(f.image, page).height / EMU_PER_PX > capacity
        : f.ascent + f.descent > capacity && !f.baselineShift));
    if (!page.clipOverflow && !page.allowOversizedLines && !oversizedInlineHeight && fitHeight + borderOutset(format.paragraphBorders.top) + borderOutset(format.paragraphBorders.bottom) > capacity) throw new Error('This font size and line spacing exceed the page height. Reduce one of them.');
    const baseline = height === 0 && ignoreMark ? measured.stops[0].ascent || 0
      // The baseline sits at 80% of exact line height for body text as well as shapes and
      // inline images, rather than the metric-based centering in §17.3.1.33.
      // Original four-font reference control: tests/fixtures/exact-font-baseline.
      : exact ? height * .8
      // Minimum-height text is bottom-aligned as well as inline pictures,
      // diverging from §17.3.1.33's centering rule for expanded minimum lines.
      : format.lineRule === 'atLeast' ? height - measured.descent
      // Automatic leading uses text metrics even when an object makes the
      // line taller; compression moves only that text share of the baseline.
      : format.lineRule === 'auto' ? measured.ascent + (measured.spacingAscent ?? measured.ascent) * (Math.min(1, format.lineSpacing) - 1)
      : measured.ascent + (height >= naturalHeight ? (height - naturalHeight) / 2 : height - naturalHeight);
    const shift = Math.max(0, available - contentWidth) * (format.alignment === 'center' ? 0.5 : format.alignment === 'right' ? 1 : 0);
    if (marker) marker.x += shift;
    for (const key of ['leaders', 'backgrounds', 'underlines', 'strikes']) measured[key].push(...(marker?.tabSuffix?.[key] || []));
    for (const leader of measured.leaders) leader.x += shift;
    for (const fragment of measured.fragments) fragment.x += shift;
    for (const stop of measured.stops) stop.x += shift;
    for (const b of measured.backgrounds) b.x += shift;
    for (const u of [...measured.underlines, ...measured.strikes]) u.x += shift;
    if (measured.ignoredTrailingWidth && measured.stops.at(-1).x > right) {
      // Source spaces remain intact. Only their visible geometry is bounded by
      // the writing edge, including in table cells and repeated headers.
      measured.hangingRight = right;
      for (const s of measured.stops) if (s.offset > measured.trailingStart && s.x >= right) { s.x = right; s.hanging = true; }
      const clip = span => { span.width = Math.max(0, Math.min(span.width, right - span.x)); span.x = Math.min(span.x, right); };
      for (const f of measured.fragments) if (f.end > measured.trailingStart) clip(f);
      for (const b of measured.backgrounds) clip(b);
      for (const u of [...measured.underlines, ...measured.strikes]) clip(u);
    }
    if (oversizedText) {
      // Glyph ink is clipped at the physical cell edge, not the paragraph's
      // writing margin. Keep full fragment advances for shaping, but expose
      // only visible positions to caret, hit testing and selection geometry.
      measured.textClip = { left: cellBounds.left, right: cellBounds.right };
      for (const stop of measured.stops) stop.x = Math.max(cellBounds.left, Math.min(stop.x, cellBounds.right));
    }
    pieces.push({
      ...(page.flowColumns ? { columnMeasureWidth: page.width-page.left-page.right } : {}),
      paragraphId: p.id, marker, height, fitHeight, baseline, ...(oversizedInlineHeight ? { oversizedInlineHeight: true } : {}), clip: emptySectionBoundary || exact && !page.shapeText,
      // Glyphs/decorations may overflow exact line boxes, while clipping applies to
      // run backgrounds and inline pictures. Empty section boundaries stay hidden.
      clipText: emptySectionBoundary || !exact,
      start: span[0]?.start ?? offset, end: span.at(-1)?.end ?? offset,
      paragraphEnd: end === chars.length, hardBreak, virtual, emptySectionBoundary, ...(autoHyphen !== null ? { autoHyphen: true } : {}),
      ...(drawingSegmentStart === undefined ? {} : { drawingSegmentStart }),
      ...(emptySectionBoundary && keepBoundaryLine ? { continuousBoundaryLine: true } : {}), ...measured,
      ...(hardBreak === 'page' && end === chars.length - 1 && !page.splitPgBreakAndParaMark ? { pageBreakWithMark: true } : {}),
    });
    // An ordinary manual break advances to the next available text region,
    // including the other side of a square-wrapped object on this same row.
    // Page/column breaks still terminate the row. Source break offsets remain
    // between the two pieces for caret navigation and selection.
    const nextClearance = hardBreak === 'line' ? clearingBreakTarget(wrapHints, p.id, chars[end].start, chars[end].breakClear, row.intervals[pieceIndex], pieceIndex === 0, paragraphEdges(format, page, start <= firstIndentedStart)) : null;
    if (end === chars.length || hardBreak && hardBreak !== 'line' || nextClearance || pieceIndex === row.intervals.length - 1) {
      const finished = pieces.length === 1 && !row.before ? pieces[0] : joinSquareLine(pieces, row.before, format);
      if (row.clearanceBefore) Object.assign(finished, { clearanceBefore: row.clearanceBefore, clearancePage: row.clearancePage });
      lines.push(finished); clearance = nextClearance;
      if (hardBreak && hardBreak !== 'line') drawingSegmentStart = chars[end].end;
      pieces = []; pieceIndex = 0; row = null;
    } else pieceIndex++;
    if (end === chars.length) break;
    start = end + (hardBreak ? 1 : 0);
  } while (start <= chars.length);
  const positioned = p.runs.filter(r => isPositionedImage(r.image));
  if (positioned.length) {
    const wrapped = positioned.some(r => r.image.anchor.wrap !== 'none');
    if (lines.some(l => l.hardBreak && l.hardBreak !== 'line') && wrapped || p.cellId && wrapped) throw new Error('Wrapped positioned drawings with page/column breaks are not supported yet; table drawings require no wrapping.');
    if (p.cellId && positioned.some(({ image }) => !isPageBasedCellPosition(image) && !isCellRelativePosition(image))) throw new Error('This drawing coordinate combination inside a table cell is not supported yet.');
    // A paragraph-relative square float must fit with its anchor on the page.
    // This reserves placement capacity, not text advancement or paragraph
    // height. Pagination discounts the anchor's own before-spacing.
    const sideFrames = (page.compatibilityMode ?? 12) >= 15 ? positioned.filter(({ image }) => isSideWrappedImage(image) && !image.hidden && image.anchor.vertical === 'paragraph' && image.anchor.y >= 0) : [];
    const sideHeights = sideFrames.map(({ image }) => drawingOffsetPixels(image.anchor.y) + imageExtents(image).height / EMU_PER_PX)
      .filter(height => height <= page.height - page.top - page.bottom + 1e-6);
    if (sideHeights.length) lines[0].floatingFitHeight = Math.max(...sideHeights);
    // wrapNone does not reserve paragraph or row height, or force keepLines.
    // Its extent is considered separately when vertically aligning a cell.
    const bands = positioned.filter(r => r.image.anchor.wrap === 'topAndBottom' && !r.image.hidden).map(({ image }) => {
      if (image.anchor.y < 0) throw new Error('Top-and-bottom drawings with negative paragraph offsets are not supported yet.');
      const top = drawingOffsetPixels(image.anchor.y);
      return [top, top + image.height / EMU_PER_PX];
    }).sort((a, b) => a[0] - b[0]);
    if (bands.length) {
      if (bands.at(-1)[1] > page.height - page.top - page.bottom) throw new Error('This positioned drawing paragraph is taller than the page writing area.');
      // The exclusion belongs to document flow, not the anchor paragraph's
      // height. Later paragraphs may still fit above the object (§20.4.2.20).
      lines[0].topBottomBands = bands;
    }
  }
  if (format.paragraphShading !== 'auto' || visibleParagraphBorders(format.paragraphBorders)) {
    // One paragraph-wide band, including hanging first lines/list labels. A
    // positive first-line indent and text alignment do not shorten the fill.
    const bordered = visibleParagraphBorders(format.paragraphBorders);
    // Paragraph decoration extends by 1.5pt on each horizontal side,
    // independently of font, line width and the authored border distance.
    // Keep text/wrapping and the authored-distance guard unchanged; physical
    // page/cell clipping bounds this additional decoration.
    for (const line of lines) if (!line.virtual) {
      const geometry = line.columnMeasureWidth === undefined ? page : { ...columnPage, right: columnPage.width-columnPage.left-line.columnMeasureWidth };
      const regular = paragraphEdges(format, geometry, false), first = paragraphEdges(format, geometry, true);
      const x = Math.min(regular.left, first.left, ...lines.filter(l => l.marker).map(l => l.marker.x));
      if (bordered && !cellBounds && !page.paragraphFrameFlow && (x - borderOutset(format.paragraphBorders.left) < 0 || regular.right + borderOutset(format.paragraphBorders.right) > page.width)) throw new Error('These paragraph borders extend outside the page. Increase its margins or paragraph indents, or reduce the border width and spacing.');
      const paintLeft = x - 2, paintRight = regular.right + 2;
      if (format.paragraphShading !== 'auto') line.paragraphBackground = { value: format.paragraphShading, x: paintLeft, width: paintRight - paintLeft, before: 0, after: 0 };
      if (bordered) line.paragraphFrame = { borders: format.paragraphBorders, x: paintLeft, right: paintRight, spaceAfter: format.spaceAfter * 4 / 3, contextualSpacing: format.contextualSpacing, styleId: p.resolvedStyleId ?? p.styleId ?? null };
    }
  }
  // Bar tabs draw a vertical rule beside every line of the paragraph, measured from the text margin.
  const bars = format.tabs.filter(t => t.alignment === 'bar');
  if (bars.length) for (const line of lines) if (!line.virtual) {
    const geometry = line.columnMeasureWidth === undefined ? page : columnPage;
    line.bars = bars.map(t => ({ x: geometry.left + t.position / 15 }));
  }
  return { lines, format, styleId: 'resolvedStyleId' in p ? p.resolvedStyleId : p.styleId ?? null, leadingFlowBreaks: /^[\f\u000e]+/.exec(text)?.[0].length || 0 };
}

export function lineAtPosition(layout, position, affinity = 'forward', pageHint = null) {
  // At a soft wrap, the caret belongs to the following line.
  const matches = l => position >= l.start && (affinity === 'backward' ? position <= l.end : position < l.end || position === l.end && (l.paragraphEnd || l.hardBreak));
  if (pageHint !== null) {
    const local = [...layout.lines, ...(layout.repeatedLines || [])].find(l => l.page === pageHint && matches(l));
    if (local) return local;
  }
  return layout.lines.find(matches) || layout.lines.at(-1);
}
const physicalWidth = (layout, page) => (layout.pages?.[page] || layout.page).width;
const visiblePageLine = (layout, line) => visibleCellLine(line) && (line.cellText ? line.x + line.width >= 0 && line.x < physicalWidth(layout, line.page) : line.stops.at(-1).x >= 0 && line.stops[0].x < physicalWidth(layout, line.page));
export function caretRect(layout, position, affinity = 'forward', pageHint = null) {
  const line = lineAtPosition(layout, position, affinity, pageHint);
  if (line.cellText) {
    const local = caretRect({ page: { width: Infinity }, lines: [{ ...line.cellText.line, page: 0 }] }, position, affinity);
    const rect = cellTextRect(line.cellText.matrix, { ...local, width: 1.5 });
    const clip = line.cellClip, width = Math.min(rect.width, clip.right - clip.left), height = Math.min(rect.height, clip.bottom - clip.top);
    return { page: line.page, x: Math.max(clip.left, Math.min(rect.x, clip.right - width)), y: Math.max(clip.top, Math.min(rect.y, clip.bottom - height)), width, height };
  }
  const stops = affinity === 'backward' || !line.wrapSegments ? line.stops : line.stops.filter((s, i, all) => s.offset !== all[i + 1]?.offset);
  const exact = line.bidi ? stops.filter(s=>s.offset===position) : [];
  const stop = exact.find(s=>s.affinity===affinity) || exact.find(s=>!s.affinity) || exact[0] || stops.find(s => s.offset >= position) || stops.at(-1);
  // A text region's starting stop may not yet carry run metrics. Use that
  // region's own fragments, rather than the first fragment across the picture
  // (which can be a zero-height floating anchor in the preceding region).
  const regions = line.wrapSegments?.filter(p => position >= p.start && position <= p.end);
  const region = regions?.length ? affinity === 'backward' ? regions[0] : regions.at(-1) : line;
  const run = stop.ascent !== undefined ? stop : region.fragments.find(f => position > f.start && position <= f.end) || region.fragments[0] || region;
  const top = line.baseline - run.ascent, bottom = line.baseline + run.descent;
  let y = line.clip ? Math.max(line.y, Math.min(top, line.y + line.height - 1)) : top;
  let height = line.clip ? Math.max(1, Math.min(line.y + line.height, bottom) - y) : bottom - top;
  if (line.cellClip) {
    const clip = line.cellClip, minimum = Math.min(1, clip.bottom - clip.top), edge = Math.min(y + height, clip.bottom);
    y = Math.max(clip.top, Math.min(y, clip.bottom - minimum));
    height = Math.max(minimum, edge - y);
  }
  if (line.oversizedInlineHeight) {
    const bottom = (layout.pages?.[line.page] || layout.page).height;
    const edge = Math.min(y + height, bottom);
    y = Math.max(0, Math.min(y, bottom - 1)); height = Math.max(1, edge - y);
  }
  const x = line.cellClip?.left === undefined ? stop.x : Math.max(line.cellClip.left, Math.min(stop.x, line.cellClip.right - Math.min(1, line.cellClip.right - line.cellClip.left)));
  if (line.cellClip?.left !== undefined && line.cellClip.right <= line.cellClip.left) height = 0;
  return { x: Math.max(0, Math.min(x, physicalWidth(layout, line.page) - 1)), y, page: line.page, height };
}
const visibleCellLine = line => !line.cellClip || line.y < line.cellClip.bottom && line.y + Math.max(line.height, 1) > line.cellClip.top && (line.cellClip.left === undefined || (line.cellText ? line.x + line.width > line.cellClip.left && line.x < line.cellClip.right : line.stops.at(-1).x >= line.cellClip.left && line.stops[0].x < line.cellClip.right));
const pageStart = (layout, page) => layout.pageOffsets?.[page] ?? page * layout.page.height;
export function verticalLine(layout, line, direction, x) {
  if (line.cellText) {
    const localY = line.cellText.line.y;
    return [...layout.lines, ...(layout.repeatedLines || [])]
      .filter(candidate => candidate.cellText && candidate.cellId === line.cellId && candidate.page === line.page
        && candidate.column === line.column && visiblePageLine(layout, candidate)
        && direction * (candidate.cellText.line.y - localY) > 1e-6)
      .sort((a, b) => Math.abs(a.cellText.line.y - localY) - Math.abs(b.cellText.line.y - localY))[0];
  }
  let flowHeight = 0;
  const flowOffsets = layout.pages?.some(p => p.columns && !p.storyKind) ? layout.pages.map(p => { const start = flowHeight; flowHeight += p.height * (p.columns?.count || 1); return start; }) : null;
  let regionOffset = 0;
  const regionFlows = layout.pageRegions?.some(regions => regions?.length > 1) ? layout.pageRegions.map(regions => (regions || []).map(region => {
    const offset = regionOffset, height = Math.max(1, region.bottom - region.top);
    regionOffset += height * (region.geometry.columns?.count || 1);
    return { offset, height, top: region.top };
  })) : null;
  const flowStart = l => {
    const region = regionFlows?.[l.page]?.[l.region];
    return region ? region.offset + (l.column || 0) * region.height - region.top
      : flowOffsets ? flowOffsets[l.page] + (l.column || 0) * layout.pages[l.page].height : pageStart(layout, l.page);
  };
  const y = l => flowStart(l) + (l.cellClip ? Math.max(l.cellClip.top, Math.min(l.y + l.height / 2, l.cellClip.bottom)) : l.y + l.height / 2);
  const rowId = layout.cells?.find(c => c.id === line.cellId)?.rowId;
  const rowCells = new Set(rowId ? layout.cells.filter(c => c.rowId === rowId).map(c => c.id) : []);
  const boxes = new Map((layout.cells || []).map(c => [`${c.id}/${c.page}/${c.column ?? 0}`, c]));
  const current = (layout.cells || []).filter(c => c.id === line.cellId && (!line.header || c.page === line.page));
  const candidates = [...layout.lines, ...(layout.repeatedLines || [])].filter(l => {
    if (!visiblePageLine(layout, l)) return false;
    if (direction * (y(l) - y(line)) <= 1e-6) return false;
    if (l.cellId === line.cellId) return !line.header || l.page === line.page;
    const box = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    return !rowCells.has(l.cellId) && !current.some(c => box && box.page === c.page && box.column === c.column && box.y < c.y + c.height - 1e-6 && box.y + box.height > c.y + 1e-6);
  });
  const inCell = line.cellId ? candidates.filter(l => l.cellId === line.cellId) : [];
  const distance = l => {
    const cell = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    const targetX = x + (l.columnOffset || 0) - (line.columnOffset || 0);
    return cell ? Math.max(cell.x - targetX, 0, targetX - cell.x - cell.width) : Math.max(l.stops[0].x - targetX, 0, targetX - l.stops.at(-1).x);
  };
  const verticalDistance = l => {
    const cell = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    return cell ? Math.max(0, direction * (flowStart(cell) + cell.y + (direction < 0 ? cell.height : 0) - y(line))) : Math.abs(y(l) - y(line));
  };
  if (inCell.length) return inCell.sort((a,b) => Math.abs(y(a) - y(line)) - Math.abs(y(b) - y(line)))[0];
  return candidates.sort((a,b) => verticalDistance(a) - verticalDistance(b) || distance(a) - distance(b) || Math.abs(y(a) - y(line)) - Math.abs(y(b) - y(line)))[0];
}
export function hitTest(layout, page, x, y) {
  return hitTestStop(layout, page, x, y).offset;
}
// Mixed-direction boundaries can share a logical offset at different visual
// positions. Pointer callers need the selected stop's affinity as well.
export function hitTestStop(layout, page, x, y) {
  const frame = layout.paragraphFrames?.findLast(f => f.page === page && x >= f.left && x <= f.right && y >= f.top && y < f.bottom);
  const cell = layout.cells?.filter(c => c.page === page && cellClipContains(c.cellClip, x, y) && x >= c.x && x <= c.x + c.width && y >= Math.max(c.y, c.cellClip?.top ?? -Infinity) && y <= c.y + c.height && y < (c.cellClip?.bottom ?? Infinity)).reduce((best, c) => !best || (c.depth || 0) > (best.depth || 0) ? c : best, null);
  let candidates = [...layout.lines, ...(layout.repeatedLines || [])].filter(l => l.page === page && (!cell || l.cellId === cell.id && l.column === cell.column) && visiblePageLine(layout, l));
  if (frame) candidates = candidates.filter(l => l.frameId === frame.frameId);
  else candidates = candidates.filter(l => !l.frameId);
  if (!cell && !frame) {
    const regions = layout.pageRegions?.[page];
    const region = regions?.reduce((best, r, index) => {
      const distance = v => Math.max(v.top - y, 0, y - v.bottom);
      return distance(r) < distance(regions[best]) || distance(r) === distance(regions[best]) && y >= r.top ? index : best;
    }, 0);
    if (regions?.length) candidates = candidates.filter(line => line.region === region);
    const column = columnAtPoint(regions?.[region]?.geometry || layout.pages?.[page], x);
    const inColumn = column === null ? [] : candidates.filter(l => l.column === column);
    if (inColumn.length) candidates = inColumn;
  }
  if (!candidates.length && cell) {
    candidates = layout.lines.filter(l => l.cellId === cell.id && visiblePageLine(layout, l));
    if (!candidates.length) return { offset: layout.lines.find(l => l.cellId === cell.id)?.start ?? 0 };
  }
  const real = candidates.filter(l => !l.virtual);
  const lines = real.length ? real : candidates;
  const top = l => (pageStart(layout, l.page) - pageStart(layout, page)) + l.y;
  const distance = l => Math.max(top(l) - y, 0, y - top(l) - l.height) + (l.cellText ? Math.max(l.x - x, 0, x - l.x - l.width) : l.cellId && !cell ? Math.max(l.stops[0].x - x, 0, x - l.stops.at(-1).x) : 0);
  const line = lines.reduce((best, l) => distance(l) < distance(best) || distance(l) === distance(best) && Math.abs(top(l) + l.height / 2 - y) < Math.abs(top(best) + best.height / 2 - y) ? l : best, lines[0]);
  if (!line) return { offset: 0 };
  return nearestStop(line, x, y);
}
export function nearestStop(line, x, y) {
  if (line.cellText && y !== undefined) {
    const local = cellTextLocalPoint(line.cellText.matrix, x, y);
    const stop = nearestStop(line.cellText.line, local.x);
    return { ...stop, ...cellTextPoint(line.cellText.matrix, stop.x, line.cellText.line.baseline) };
  }
  return line.stops.reduce((best, s) => Math.abs(s.x - x) < Math.abs(best.x - x) || s.hanging && s.x === best.x ? s : best, line.stops[0]);
}
export function imageAtPoint(layout, page, x, y, { includeBehindText = false } = {}) {
  let behind = null;
  for (const f of [...(layout.floatingObjects || [])].reverse()) {
    if (f.page !== page || f.image?.hidden || !cellClipContains(f.cellClip, x, y) || !((f.image.flatLine || f.image.flatGroup) ? flatLineContains(f.image,f.x,f.y,f.width,f.height,x,y) : positionedImageContains(f, x, y))) continue;
    if (!f.image.anchor?.behind) return f;
    behind ||= f;
  }
  if (includeBehindText && behind) return behind;
  let textHit = false;
  for (const line of [...layout.lines, ...(layout.repeatedLines || [])]) if (line.page === page && cellClipContains(line.cellClip, x, y)) {
    if (behind && !textHit) {
      const point = line.cellText ? cellTextLocalPoint(line.cellText.matrix, x, y) : { x, y };
      const textLine = line.cellText?.line || line;
      if (point.y >= textLine.y && point.y <= textLine.y + textLine.height &&
        textLine.fragments.some(f => !f.image && f.text && point.x >= f.x && point.x <= f.x + f.width)) textHit = true;
    }
    if (line.oversizedInlineHeight && (x < 0 || x >= physicalWidth(layout, page) || y < 0 || y >= (layout.pages?.[page] || layout.page).height)) continue;
    const image = line.fragments.find(f => {
      if (!f.image || f.image.hidden || isPositionedImage(f.image)) return false;
      if (f.uprightImage) {
        const frame = f.uprightImage;
        if ((line.clip || normalizedRotation(f.image.rotation)) && (x < line.x || x > line.x + line.width)) return false;
        if (f.image.flatLine || f.image.flatGroup) {
          const e = imageExtents(f.image);
          return flatLineContains(f.image, frame.x + e.left / EMU_PER_PX, frame.y + e.top / EMU_PER_PX, f.image.width / EMU_PER_PX, f.image.height / EMU_PER_PX, x, y);
        }
        return normalizedRotation(f.image.rotation) ? positionedImageContains(inlineImagePaintFrame(f.image, frame.x, frame.y), x, y)
          : x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
      }
      if (f.image.flatLine || f.image.flatGroup) {
        if (line.clip && (y < line.y || y > line.y + line.height)) return false;
        const e = imageExtents(f.image);
        return flatLineContains(f.image, f.x + e.left / EMU_PER_PX, line.baseline - f.ascent + e.top / EMU_PER_PX, f.image.width / EMU_PER_PX, f.image.height / EMU_PER_PX, x, y);
      }
      if ((line.clip || normalizedRotation(f.image.rotation)) && (y < line.y || y > line.y + line.height)) return false;
      return normalizedRotation(f.image.rotation) ? positionedImageContains(inlineImagePaintFrame(f.image, f.x, line.baseline - f.ascent), x, y)
        : x >= f.x && x <= f.x + f.width && y >= line.baseline - f.ascent && y <= line.baseline + f.descent;
    });
    if (image) return image;
  }
  return textHit ? null : behind;
}
export function selectionRects(layout, start, end) {
  return [...layout.lines, ...(layout.repeatedLines || [])].flatMap(line => line.wrapSegments && !line.cellText
    ? line.wrapSegments.map(segment => ({ ...segment, page: line.page, baseline: line.baseline, clip: line.clip, y: line.y + (line.wrapBefore || 0), height: line.height - (line.wrapBefore || 0), ...(line.oversizedInlineHeight ? { oversizedInlineHeight: true } : {}), cellClip: line.cellClip })) : [line]).flatMap(line => {
    if (end <= line.start || start > line.end || start === line.end && !line.paragraphEnd && !line.hardBreak) return [];
    if (line.cellText) {
      const pictures = line.fragments.filter(f => f.uprightImage && start < f.end && end > f.start);
      let ranges = [[start, end]];
      for (const picture of pictures) ranges = ranges.flatMap(([a, b]) => b <= picture.start || a >= picture.end ? [[a, b]]
        : [...(a < picture.start ? [[a, picture.start]] : []), ...(b > picture.end ? [[picture.end, b]] : [])]);
      const localLayout = { page: { width: Infinity }, lines: [{ ...line.cellText.line, page: 0 }] };
      const local = ranges.flatMap(([a, b]) => selectionRects(localLayout, a, b));
      const rects = local.map(rect => ({ ...cellTextRect(line.cellText.matrix, rect), page: line.page }));
      for (const picture of pictures) {
        const rect = normalizedRotation(picture.image.rotation)
          ? clipCellRect(positionedImageBounds(inlineImagePaintFrame(picture.image, picture.uprightImage.x, picture.uprightImage.y)), {left:line.x,right:line.x+line.width,top:-Infinity,bottom:Infinity})
          : picture.uprightImage;
        if (rect) rects.push({...rect,page:line.page});
      }
      return rects.map(rect => clipCellRect(rect, line.cellClip)).filter(Boolean);
    }
    const a = line.stops.find(s => s.offset >= Math.max(start, line.start)) || line.stops.at(-1);
    const b = [...line.stops].reverse().find(s => s.offset <= Math.min(end, line.end)) || line.stops[0];
    const newline = (line.paragraphEnd || line.hardBreak) && end > line.end ? 7 : 0;
    const edge = Math.min(line.hangingRight ?? Infinity, line.textClip?.right ?? Infinity);
    const width = Math.min(Math.max(0, b.x - a.x) + newline, Math.max(0, edge - a.x));
    const collapsed = !width && (b.offset > a.offset || newline) && (a.hanging || b.hanging);
    const rects = line.bidi ? line.fragments.flatMap(f=>{
      if(!f.caretStops || end<=f.start || start>=f.end) return [];
      const first=f.caretStops.find(s=>s.offset>=Math.max(start,f.start)) || f.caretStops.at(-1);
      const last=[...f.caretStops].reverse().find(s=>s.offset<=Math.min(end,f.end)) || f.caretStops[0];
      const x=Math.max(line.textClip?.left ?? -Infinity,f.x+Math.min(first.x,last.x));
      const right=Math.min(edge,f.x+Math.max(first.x,last.x));
      return [clipCellRect({page:line.page,x,y:line.y,width:Math.max(0,right-x),height:line.height},line.cellClip)];
    }) : [clipCellRect({ page: line.page, x: collapsed ? a.x - 1 : a.x, y: line.y, width: collapsed ? 1 : width, height: line.height }, line.cellClip)];
    if(line.bidi && newline) rects.push(clipCellRect({page:line.page,x:b.x,y:line.y,width:newline,height:line.height},line.cellClip));
    for (const f of line.fragments || []) if (f.image && normalizedRotation(f.image.rotation) && !isPositionedImage(f.image) && start < f.end && end > f.start) {
      const rect = positionedImageBounds(inlineImagePaintFrame(f.image, f.x, line.baseline - f.ascent));
      const bottom = Math.min(rect.y + rect.height, line.y + line.height);
      rect.y = Math.max(rect.y, line.y); rect.height = Math.max(0, bottom - rect.y);
      rects.push(clipCellRect({page: line.page, ...rect}, line.cellClip));
    }
    for (const f of line.fragments || []) if ((f.image?.flatLine || f.image?.flatGroup) && !isPositionedImage(f.image) && start < f.end && end > f.start) {
      const e = imageExtents(f.image);
      const rect = flatLineRect(f.image, f.x + e.left / EMU_PER_PX, line.baseline - f.ascent + e.top / EMU_PER_PX, f.image.width / EMU_PER_PX, f.image.height / EMU_PER_PX);
      if (line.clip) {
        const bottom = Math.min(rect.y + rect.height, line.y + line.height);
        rect.y = Math.max(rect.y, line.y); rect.height = Math.max(0, bottom - rect.y);
      }
      rects.push(clipCellRect({ page: line.page, ...rect }, line.cellClip));
    }
    const visible = rects.filter(Boolean);
    return line.oversizedInlineHeight ? visible.map(rect =>
      clipCellRect(rect, { left: 0, right: physicalWidth(layout, line.page), top: 0, bottom: (layout.pages?.[line.page] || layout.page).height })).filter(Boolean) : visible;
  }).concat((layout.floatingObjects || []).filter(f => start < f.end && end > f.start).map(f => clipCellRect({ page: f.page, ...((f.image.flatLine || f.image.flatGroup) ? flatLineRect(f.image,f.x,f.y,f.width,f.height) : positionedImageBounds(f)) }, f.cellClip)).filter(Boolean))
    .map(rect => rect.x >= 0 && rect.x + rect.width <= physicalWidth(layout, rect.page) ? rect
      : clipCellRect(rect, { left: 0, right: physicalWidth(layout, rect.page), top: -Infinity, bottom: Infinity })).filter(Boolean);
}
