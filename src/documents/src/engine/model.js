import { MAX_DOCUMENT_CHARACTERS, DOCUMENT_CHARACTER_LIMIT_MESSAGE, xmlAttributeText } from './text-limits.js';
import { validFontSize } from './font-size.js';
import { typedScriptRuns } from './script-input.js';
import {noteMarkRanges,noteMarkSelection} from './note-marks.js';
import {bodySymbolText} from './body-symbols.js';
import { plainTextFormattingRange, checkPlainTextObjects, formatPlainTextInputs } from './plain-text-controls.js';
import { bodyFieldRanges, replacedBodyFields, placeBodyFields, renameBodyFieldBookmarks, macroButtonSelection } from './body-fields.js';
import { synchronizeTocFormatting } from './toc-field-formatting.js';
import { synchronizeFieldHyperlinks, unwrapEditedFieldHyperlinks } from './body-field-hyperlinks.js';
import { selectedPictureControl, checkPictureControlEdit } from './picture-controls.js';
import { checkedTextFill } from './text-fill.js';
import { restorePlaceholderBookmarks } from './placeholder-bookmarks.js';
import { checkedTextShadow } from './text-shadow.js';
import { checkedText3d } from './text-3d.js';
import { checkedTextOutline } from './text-outline.js';
import { FONT_DEFAULTS, checkedFontEdit } from './font-families.js';
import { contentControlRanges, unwrapChangedContentControls, validatePersistentControls } from './content-controls.js';
import { inlineControlCaret, splitControlCaretRuns } from './content-control-caret.js';
import { blockControlGroups, blockControlSignature, persistentBlockReplacement, persistentBlockBoundary, inlineEditAncestors, unwrapChangedBlockControls, rehomeMovedBlockControls, mergeCellControls } from './block-controls.js';
import { checkedParagraphBorders } from './paragraph-borders.js';
import { checkedCellAlignment } from './cell-alignment.js';
import { checkedCellBorders, resolveCellBorders, effectiveCellBorders } from './cell-borders.js';
import { checkedCellMargins, resolveCellMargins } from './cell-margins.js';
import { checkedRowHeight, rowHeight } from './row-height.js';
import { checkedLineSpacing } from './line-spacing.js';
import { hasDirectRunFormatting, clearedRun, hasDirectMarkFormatting, clearMark, hasDirectParagraphFormatting, clearParagraph } from './direct-formatting.js';
import { findText, checkedSearchText, replacedRuns, replacedBookmarks } from './search.js';
import { advancedFind, replaceAdvanced } from './advanced-search.js';
import { checkedHyperlinkDestination, hyperlinkLabel, hyperlinkId, hyperlinkAt, hyperlinkRanges, hyperlinkBoundaryChanges } from './hyperlinks.js';
import { bookmarkEntries, checkedBookmarkName, newBookmarkMarkers, replaceBookmarkMarkers, bookmarkStructureState, repairStructuralBookmarks, normalizeBlockBookmarkScopes } from './bookmarks.js';
import { checkedUnderline, underlineDeclaration } from './underlines.js';
import { checkedCapitalization, checkCapitalizationText } from './capitalization.js';
import { checkedStrike } from './strikethrough.js';
import { checkedLigatures } from './ligatures.js';
import { checkedKerning } from './kerning.js';
import { checkedTextScale } from './text-scale.js';
import { checkedCharacterSpacing } from './character-spacing.js';
import { checkedHighlight, checkedShading, cellShadingFill } from './backgrounds.js';
import { checkedVerticalAlign, checkedBaselineShift } from './vertical-align.js';
import { normalizeColor } from './colors.js';
import { cellContext, tableCells, editableCells, verticalMerges, headerRowCount, tableId, fixedColumnWidths, documentBlocks, cellSpan, rowGrid, spanWidth } from './tables.js';
import { normalizeCellBlock, cellBlockPlacements } from './table-selection.js';
import { emptyStyles, resolveStyledParagraph, effectiveStyleId, editedStyle, resolveCharacterRun, paragraphRunStyle } from './styles.js';
import { emptyNumbering, levelFor, listKind, listGeometry, listMarkers, newList, restartList } from './numbering.js';
import { INDENT_KEYS, validateIndent, normalizeTabStops, sameValue } from './paragraph-geometry.js';
import { validatePageSettings, DOCUMENT_PAGE_KEYS, SECTION_TYPES } from './page-settings.js';
import { OBJECT, inlineSegments, validateImage, normalizeCrop, normalizedRotation, rotationOutsets, imageExtents, CROP_SIDES, isPositionedImage } from './images.js';
import { outlineEntries, builtinOutlineLevel } from './outline.js';
import { refreshConditionalTable } from './conditional-table-formatting.js';
import { eachRevisionTarget, revisionRanges, runFormatChange, paragraphFormatChange, acceptFormatChange, rejectFormatChange } from './revisions.js';
import { footnoteReferenceRun } from './footnotes.js';
import { commentAnchors, nextCommentId, addCommentMarkers, removeCommentMarkers, commentThread, checkedCommentText, initialsFor } from './comments.js';
/** Original canvas engine. Positions are UTF-16 offsets in paragraphs joined by '\n'. */
let nextId = 0;
export { PAGINATION_DEFAULTS, PARAGRAPH_FORMAT, RUN_FORMAT, runFormat } from './formatting.js';
import { PAGINATION_DEFAULTS, PARAGRAPH_FORMAT, PARAGRAPH_FLAGS, RUN_FORMAT, runFormat, clearAutomaticSpacing } from './formatting.js';

function commandRunFormat(run) {
  const format = runFormat(run);
  // Font Size displays the active script's size; scalar editing stays separate.
  if (format.cs || format.rtl) format.fontSize = format.fontSizeCs;
  return format;
}
export const paragraphFormat = (p, numbering, pageSettings) => {
  const format = listGeometry(p, numbering, { ...PARAGRAPH_FORMAT, ...p.format });
  if (pageSettings?.doNotUseHTMLParagraphAutoSpacing) for (const side of ['Before', 'After']) {
    if (format['autoSpace' + side]) format['space' + side] = format['explicitSpace' + side];
  }
  return format;
};
export const paragraph = (text = '', extra = {}) => ({
  id: `p${++nextId}`, runs: text ? [{ text, ...RUN_FORMAT, properties: '', overrides: {} }] : [], ...extra,
});
export const paragraphText = p => p.runs.map(r => r.text).join('');
/** A paragraph's text length, without joining its runs. */
export const paragraphLength = p => { let n = 0; for (const r of p.runs) n += r.text.length; return n; };
/** The document's text length (paragraphs and the marks between them), without joining any text. */
export const documentLength = paragraphs => paragraphs.reduce((n, p) => n + paragraphLength(p), paragraphs.length - 1);
export const documentText = paragraphs => paragraphs.map(paragraphText).join('\n');
// A model's text is asked for by every selection and command; joining a long document each time made
// batches of commands (a formatted paste or import) quadratic. Each paragraph's text is kept with the run
// texts it was joined from, and the document's with its paragraphs' texts; comparing them confirms the
// cached text without joining, and only paragraphs whose runs changed are joined again.
const paragraphTexts = new WeakMap(), documentTexts = new WeakMap();
function cachedParagraphText(p) {
  const cache = paragraphTexts.get(p), runs = p.runs;
  if (cache && cache.runs.length === runs.length) {
    let same = true;
    for (let i = 0; i < runs.length && same; i++) same = runs[i].text === cache.runs[i];
    if (same) return cache.text;
  }
  const text = paragraphText(p);
  paragraphTexts.set(p, { runs: runs.map(r => r.text), text });
  return text;
}
function cachedDocumentText(model) {
  const paragraphs = model.paragraphs, cache = documentTexts.get(model);
  const texts = paragraphs.map(cachedParagraphText);
  if (cache && cache.texts.length === texts.length && texts.every((text, i) => text === cache.texts[i])) return cache.text;
  const text = texts.join('\n');
  documentTexts.set(model, { texts, text });
  return text;
}
const copy = value => structuredClone(value);
const blockPrompt = control => control.placeholderParagraphs || [control.placeholderRuns || [{ ...copy(control.inputRun), text: '     ' }]];
// Paragraph separators and prompt runs are restored, with the surviving final
// paragraph mark supplying the last paragraph's properties. Earlier paragraphs
// use the default paragraph properties rather than the glossary's pPr.
function restoredBlockParagraphs(template, control) {
  const prompt = blockPrompt(control);
  return prompt.map((runs, i) => {
    const p = i === prompt.length - 1 ? copy(template) : paragraph('', {
      ...(template.cellId ? { cellId: template.cellId } : {}),
      ...(template.tableStyleId ? { tableStyleId: template.tableStyleId } : {}),
      ...(template.tableStyleRegions ? { tableStyleRegions: copy(template.tableStyleRegions) } : {}),
      blockControls: copy(template.blockControls),
    });
    p.id = i ? paragraph().id : template.id;
    p.runs = copy(runs); delete p.bookmarks;
    return p;
  });
}

function reparentCellContent(doc, paragraphs, from, to) {
  // Descendant paragraphs retain their inner cell identities. Only direct
  // content and immediate child tables move when their outer owner changes.
  for (const p of paragraphs) if (p.cellId === from) p.cellId = to;
  for (const table of doc.tables) if (table.parentCellId === from) table.parentCellId = to;
}
function tableContent(doc, table) {
  const owners = new Map(tableCells(table).map(c => [c.id,c.id])), byCell = new Map(), children = new Map();
  for (const nested of doc.tables) if (nested.parentCellId) {
    if (!children.has(nested.parentCellId)) children.set(nested.parentCellId, []);
    children.get(nested.parentCellId).push(nested);
  }
  const queue = [...owners.keys()];
  for (let i=0;i<queue.length;i++) for (const nested of children.get(queue[i]) || []) for (const cell of tableCells(nested)) {
    owners.set(cell.id, owners.get(queue[i])); queue.push(cell.id);
  }
  const start = doc.paragraphs.findIndex(p => owners.has(p.cellId)); let count = 0;
  for (const p of doc.paragraphs) if (owners.has(p.cellId)) {
    const owner = owners.get(p.cellId);
    if (!byCell.has(owner)) byCell.set(owner, []);
    byCell.get(owner).push(p); count++;
  }
  const selection = Object.fromEntries(Object.entries(doc.selection).map(([key, value]) => { const at = locate(doc.paragraphs, value); return [key, { id: doc.paragraphs[at.index].id, offset: at.offset }]; }));
  return { start, count, byCell, selection, bookmarks: bookmarkStructureState(doc.paragraphs, doc.tables) };
}
function removeOrphanedTables(doc) {
  for (;;) {
    const cells = new Set(doc.tables.flatMap(tableCells).map(cell => cell.id));
    const retained = doc.tables.filter(table => !table.parentCellId || cells.has(table.parentCellId));
    if (retained.length === doc.tables.length) return;
    doc.tables = retained;
  }
}
function applyTableContent(doc, table, state) {
  doc.paragraphs.splice(state.start, state.count, ...editableCells(table).flatMap(c => state.byCell.get(c.id) || []));
  // A table nested in a cell whose content was cleared or deleted went with it.
  const owned = new Set(doc.paragraphs.map(p => p.cellId).filter(Boolean));
  doc.tables = doc.tables.filter(t => !t.parentCellId || tableCells(t).some(cell => owned.has(cell.id)));
  removeOrphanedTables(doc);
  refreshTableStyles(doc, table);
  if (doc.hasBlockControls) rehomeMovedBlockControls(doc.paragraphs);
  repairStructuralBookmarks(doc.paragraphs, state.bookmarks, doc.tables, table.id);
  normalizeBlockBookmarkScopes(doc.paragraphs, doc.tables);
  for (const [key, point] of Object.entries(state.selection)) {
    const index = doc.paragraphs.findIndex(p => p.id === point.id);
    if (index >= 0) doc.selection[key] = doc.paragraphOffset(index) + point.offset;
  }
}
function refreshTableStyles(doc, table) {
  const cells = refreshConditionalTable(table);
  if (!cells) return;
  for (const p of doc.paragraphs) if (cells.has(p.cellId)) {
    p.tableStyleRegions = cells.get(p.cellId).styleRegions;
    resolveStyledParagraph(p, doc.styles, doc.numbering);
  }
}
function blankCellParagraph(template, cell) {
  const p = { ...copy(template), id: paragraph().id, cellId: cell.id, runs: [] }; delete p.bookmarks;
  delete p.fieldMarkers;
  // A new cell inherits formatting, not wrappers owned by the source cell.
  // Ancestors enclosing the table still own its structural change.
  if (p.blockControls) {
    p.blockControls = p.blockControls.filter(control => control.scope !== template.cellId);
    if (!p.blockControls.length) delete p.blockControls;
  }
  return p;
}
function clearMerge(cell) { cell.vMerge = null; cell.mergeChanged = true; delete cell.continuation; delete cell.continuationStyleId; }
function setCellWidths(table, widths) {
  const cells = table.rows.flatMap(rowGrid).map(item => ({ ...item, width: spanWidth(widths, item.column, item.span) }));
  const gaps = table.rows.flatMap(row => ['Before', 'After'].filter(side => row[`grid${side}`]).map(side => ({ row, side, width: spanWidth(widths, side === 'Before' ? 0 : widths.length - row.gridAfter, row[`grid${side}`]) })));
  if ([...cells, ...gaps].some(c => c.width > 31680)) throw new Error('The combined preferred width of a cell or omitted grid span cannot exceed 22 inches.');
  for (const { cell, width } of cells) {
    cell.width = { type: 'dxa', value: width }; cell.widthChanged = true;
  }
  for (const { row, side, width } of gaps) { row[`width${side}`] = { type: 'dxa', value: width }; row[`width${side}Changed`] = true; }
}

// Selection commands ask for the same document's boundaries many times in a
// row; segmenting a long document each time made batched edits quadratic.
let boundaryText = null, boundaryPoints = null, boundaryList = null;
const segmentPoints = (text, from, to) => [...inlineSegments(text.slice(from, to))].map(s => from + s.index);
export function boundaries(text) {
  if (text !== boundaryText) {
    // CR LF is one grapheme, so a stray CR makes a separator break uncertain.
    const whole = boundaryText === null || text.includes('\r') || boundaryText.includes('\r');
    boundaryList = whole ? segmentPoints(text, 0, text.length).concat(text.length) : editedBoundaries(boundaryText, boundaryList, text);
    // Callers share the frozen copy; copying from a frozen array is slow, so edits rebase the private list.
    boundaryPoints = Object.freeze(boundaryList.slice());
    boundaryText = text;
  }
  return boundaryPoints;
}
// After an edit, segment only the changed paragraphs. A line feed always
// breaks graphemes (UAX #29 GB4/GB5), so points outside them are reused or shifted.
function editedBoundaries(old, points, text) {
  const shortest = Math.min(old.length, text.length);
  let prefix = 0, suffix = 0;
  while (prefix < shortest && old.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
  while (suffix < shortest - prefix && old.charCodeAt(old.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)) suffix++;
  const from = prefix ? text.lastIndexOf('\n', prefix - 1) + 1 : 0, found = text.indexOf('\n', text.length - suffix);
  const to = found < 0 ? text.length : found, delta = text.length - old.length;
  const firstAt = position => { let low = 0, high = points.length; while (low < high) { const middle = (low + high) >> 1; if (points[middle] < position) low = middle + 1; else high = middle; } return low; };
  const kept = firstAt(from), moved = firstAt(to - delta);
  const result = points.slice(0, kept).concat(segmentPoints(text, from, to));
  for (let i = moved; i < points.length; i++) result.push(points[i] + delta);
  return result;
}

export function locate(paragraphs, position) {
  // Clamp within the walk; joining the whole document text made every lookup allocate it.
  let offset = Math.max(0, position);
  for (let index = 0; index < paragraphs.length; index++) {
    const length = paragraphLength(paragraphs[index]);
    if (offset <= length || index === paragraphs.length - 1) return { index, offset: Math.min(offset, length) };
    offset -= length + 1;
  }
}

// The first grapheme boundary at or after a position. Paragraph separators
// always break graphemes, so only the paragraph holding it is segmented.
function nextBoundary(paragraphs, position) {
  let at = 0;
  for (let index = 0; index < paragraphs.length; index++) {
    const size = paragraphLength(paragraphs[index]);
    if (position <= at + size || index === paragraphs.length - 1) {
      const text = paragraphText(paragraphs[index]);
      for (const segment of inlineSegments(text)) if (at + segment.index >= position) return at + segment.index;
      return at + text.length;
    }
    at += size + 1;
  }
}

function sliceRuns(runs, start, end = Infinity, includeEmptyEnd = false) {
  let at = 0;
  return runs.flatMap(run => {
    if (!run.text && run.contentControl) return at >= start && (at < end || includeEmptyEnd && at === end) ? [{ ...run }] : [];
    const text = run.text.slice(Math.max(0, start - at), Math.max(0, end - at));
    at += run.text.length;
    return text ? [{ ...run, text }] : [];
  });
}

/** Drop revision marks from runs in [start, end) without splitting untouched runs. */
function clearRevisions(paragraphs, start, end) {
  let at = 0, found = false;
  for (const p of paragraphs) {
    const size = p.runs.reduce((n, r) => n + r.text.length, 0);
    if (at + size >= start && at <= end && p.runs.some(r => r.revision)) { found = true; break; }
    at += size + 1; if (at > end) break;
  }
  if (!found) return;
  eachRevisionTarget(paragraphs, start, end, ({ run, mark }) => { if (!mark) delete run.revision; });
  for (const p of paragraphs) if (p.runs.length > 1) p.runs = normalize(p.runs);
}
function normalize(runs) {
  const result = [];
  for (const run of runs) {
    if (!run.text && !run.contentControl) continue;
    const last = result.at(-1);
    if (last && !last.image && !run.image && !last.math && !run.math && !last.field && !run.field && !last.noteMark && !run.noteMark && !last.bodySymbol && !run.bodySymbol && !last.noBreakHyphen && !run.noBreakHyphen && !last.breakClear && !run.breakClear && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...run, text: '' })) last.text += run.text;
    else result.push({ ...run });
  }
  return result;
}

export class TextDocument {
  constructor(paragraphs = [paragraph()], pageSettings, numbering = emptyNumbering(), styles, tables = [], assets = {}, { displayOnly = false, comments = null, trackChanges } = {}) {
    this.assets = { ...assets }; // Immutable bytes stay out of text/history snapshots.
    this.tables = copy(tables);
    this.styles = copy(styles || emptyStyles()); this.stylesEnabled = !!styles;
    this.numbering = copy(numbering);
    this.paragraphs = copy(paragraphs.length ? paragraphs : [paragraph()]);
    // Display permission applies only to initial resolution, never mutations.
    if (styles) for (const p of this.paragraphs) resolveStyledParagraph(p, this.styles, this.numbering, { displayOnly });
    documentBlocks(this.paragraphs, this.tables);
    this.hasColumnBookmarks = bookmarkEntries(this.paragraphs, this.tables).some(entry => entry.columnRange);
    this.pageSettings = validatePageSettings(pageSettings);
    // Section breaks inserted later copy the source section they split (see insertSectionBreakAt).
    this.sourceSectionCount = this.paragraphs.filter(p => p.sectionEnd).length + 1;
    this.selection = { anchor: 0, focus: 0 };
    // Null means the source has no managed comments part (page stories, plain imports).
    this.comments = comments ? copy(comments) : null;
    // Track Changes is a document setting, not an undoable edit. Undefined leaves the source setting alone.
    this.trackChanges = trackChanges; this.revisionAuthor = '';
    this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false;
    this.history = [];
    this.future = [];
    this.hasPlainTextControls = this.paragraphs.some(p => p.blockControls?.some(c => c.plainText) || p.runs.some(r => r.contentControl?.plainText));
    this.hasContentControls = this.paragraphs.some(p => p.runs.some(r => r.contentControl));
    this.hasPersistentControls = this.paragraphs.some(p => p.runs.some(r => r.contentControl?.persistent));
    this.hasPictureControls = this.paragraphs.some(p => p.runs.some(r => r.contentControl?.picture));
    this.hasBlockControls = this.paragraphs.some(p => p.blockControls?.length);
    this.hasPersistentBlockControls = this.paragraphs.some(p => p.blockControls?.some(c => c.persistent));
    this.hasBodyFields = this.paragraphs.some(p=>p.fieldMarkers?.length);
    const fields=this.hasBodyFields?bodyFieldRanges(this.paragraphs):[];
    this.hasTocFields=fields.some(r=>r.field.type==='TOC');
    this.hasHyperlinkFields=fields.some(r=>r.field.type==='HYPERLINK');
    this.hasMacroButtons=fields.some(r=>r.field.type==='MACROBUTTON');
    this.hasNoteMarks=this.paragraphs.some(p=>p.runs.some(r=>r.noteMark));
    this.revision = 0;
  }
  didChange(preservedBlockControls) {
    if(this.hasBodyFields){
      const ranges=bodyFieldRanges(this.paragraphs);
      if(this.hasTocFields)synchronizeTocFormatting(this.paragraphs,ranges,this.styles);
      if(this.hasHyperlinkFields)synchronizeFieldHyperlinks(this.paragraphs,ranges);
    }
    if (this.hasContentControls) unwrapChangedContentControls(this.paragraphs, this.hasPersistentControls);
    if (this.hasBlockControls) unwrapChangedBlockControls(this.paragraphs, this.tables, preservedBlockControls);
    this.revision++;
  }
  placeholderAt(position) {
    const inline = this.hasContentControls ? contentControlRanges(this.paragraphs).find(r => !r.control.picture && r.control.placeholder && position >= r.start && position < r.end) : undefined;
    if (inline) return inline;
    const block = this.hasBlockControls ? blockControlGroups(this.paragraphs).filter(r => r.control.placeholder && position >= r.start && (position < r.end || r.start === r.end && position === r.start)).at(-1) : undefined;
    return block ? { ...block, paragraph: block.paragraphs[0], localStart: 0, runs: block.paragraphs.flatMap(p => p.runs) } : undefined;
  }
  get text() { return cachedDocumentText(this); }
  get sectionPageSettings() {
    for (let i = locate(this.paragraphs, this.range[0]).index; i < this.paragraphs.length; i++) {
      if (this.paragraphs[i].sectionEnd) return this.paragraphs[i].sectionEnd;
    }
    return this.pageSettings;
  }
  get sectionWritingWidth() {
    const p = this.sectionPageSettings;
    return p.width - p.left - p.right;
  }
  clipboardText() {
    const [start, end] = this.range; let at = 0, text = '';
    for (const p of this.paragraphs) {
      for (const run of p.runs) {
        const length = run.text.length;
        if (run.image) { if (at >= start && at < end) text += run.image.alt || '[Image]'; }
        else if (run.bodySymbol) { if (at >= start && at < end) text += bodySymbolText(run, run.text); }
        else text += run.text.slice(Math.max(0, start - at), Math.max(0, end - at));
        at += length;
      }
      if (at >= start && at < end) text += '\n';
      at++;
    }
    return text.replace(/\u000e/g, '\n');
  }
  get range() { return [Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus)]; }
  get textFormattingRange() {
    let [start, end] = this.hasPlainTextControls ? plainTextFormattingRange(this.paragraphs, this.range) : this.range;
    // An inline placeholder's cached prompt is selected as one unit. Apply
    // selected formatting to that whole prompt, including keyboard selections
    // that reach only part of it. A caret still sets pending input formatting.
    if (start !== end && this.hasContentControls) for (const r of contentControlRanges(this.paragraphs)) {
      if (!r.control.picture && r.control.placeholder && start < r.end && end > r.start) {
        start = Math.min(start, r.start); end = Math.max(end, r.end);
      }
    }
    return [start, end];
  }
  get selectedParagraphs() {
    const [start, end] = this.range;
    const first = locate(this.paragraphs, start).index;
    const last = locate(this.paragraphs, end).index;
    // A selection ending at the next paragraph's start does not format that paragraph.
    const stop = end > start && locate(this.paragraphs, end).offset === 0 ? last - 1 : last;
    return this.paragraphs.slice(first, Math.max(first, stop) + 1);
  }
  get paragraphFormatting() {
    const formats = this.selectedParagraphs.map(p => paragraphFormat(p, this.numbering, this.pageSettings));
    return Object.fromEntries(Object.keys(PARAGRAPH_FORMAT).map(key => [key, formats.every(f => sameValue(f[key], formats[0][key])) ? formats[0][key] : null]));
  }
  get outline() { return outlineEntries(this.paragraphs); }
  get canSetOutlineLevel() { return this.selectedParagraphs.every(p => builtinOutlineLevel(effectiveStyleId(p, this.styles)) === null); }
  setOutlineLevel(value) {
    if (value !== null) return this.setParagraphFormat({ outlineLevel: value });
    const targets = this.selectedParagraphs.filter(p => Object.hasOwn(p.formatOverrides || {}, 'outlineLevel') || Object.hasOwn(p.styleContext?.properties || {}, 'outlineLevel') || !p.styleContext && Object.hasOwn(p.format || {}, 'outlineLevel'));
    if (!targets.length) return false;
    this.checkpoint();
    for (const p of targets) {
      if (p.formatOverrides) delete p.formatOverrides.outlineLevel;
      if (p.styleContext?.properties) delete p.styleContext.properties.outlineLevel;
      if (p.format) delete p.format.outlineLevel;
      p.outlineLevelCleared = true;
      resolveStyledParagraph(p, this.styles, this.numbering);
    }
    this.didChange(); return true;
  }
  setParagraphLineSpacing(value) {
    if (value !== null) return this.setParagraphFormat(checkedLineSpacing(value));
    const keys = ['lineRule', 'lineSpacing'];
    const targets = this.selectedParagraphs.filter(p => keys.some(key => key in (p.formatOverrides || {}) || !p.styleContext && key in (p.format || {})) || ['line', 'lineRule'].some(key => key in (p.styleContext?.properties?.spacing || {})));
    if (!targets.length) return false;
    this.checkpoint();
    for (const p of targets) {
      for (const key of keys) { if (p.formatOverrides) delete p.formatOverrides[key]; if (p.format) delete p.format[key]; }
      for (const key of ['line', 'lineRule']) if (p.styleContext?.properties?.spacing) delete p.styleContext.properties.spacing[key];
      p.lineSpacingCleared = true;
      resolveStyledParagraph(p, this.styles, this.numbering);
    }
    this.didChange(); return true;
  }
  setParagraphFormat(patch) {
    const pass = this.blockCellPass(() => this.setParagraphFormat(patch));
    if (pass !== undefined) return pass;
    if (!Object.keys(patch).length) return false;
    patch = { ...patch };
    if ('underlineColor' in patch && !('underline' in patch)) throw new Error('Set underline and its color together.');
    for (const [key, value] of Object.entries(patch)) {
      // suppressAutoHyphens (§17.3.1.34) is optional: absent means hyphenation is allowed.
      if (!(key in PARAGRAPH_FORMAT) && key !== 'suppressAutoHyphens') throw new Error('Unknown paragraph property.');
      if (key === 'paragraphBorders') {
        patch.paragraphBorders = checkedParagraphBorders(value);
      } else if (key === 'paragraphShading') {
        patch.paragraphShading = checkedShading(value);
      } else if (key === 'outlineLevel') {
        if (!Number.isInteger(value) || value < 0 || value > 9) throw new Error('Choose an outline level from 1–9 or Body text.');
      } else if (key === 'tabs') {
        patch.tabs = normalizeTabStops(value);
      } else if (INDENT_KEYS.includes(key)) {
        validateIndent(value);
      } else if (Object.hasOwn(PAGINATION_DEFAULTS, key) || Object.hasOwn(PARAGRAPH_FLAGS, key) || key === 'contextualSpacing') {
        if (typeof value !== 'boolean') throw new Error('Paragraph pagination must be on or off.');
      } else if (key === 'alignment') {
        if (!['left', 'center', 'right', 'both'].includes(value)) throw new Error('Choose left, center, right or justified alignment.');
      } else if (key === 'lineRule') {
        if (!['auto', 'exact', 'atLeast'].includes(value)) throw new Error('Unsupported line spacing rule.');
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 600) {
        throw new Error('Spacing must be a valid non-negative number up to 600.');
      }
    }
    const targets = this.selectedParagraphs;
    if ('outlineLevel' in patch && targets.some(p => { const fixed = builtinOutlineLevel(effectiveStyleId(p, this.styles)); return fixed !== null && fixed !== patch.outlineLevel; })) throw new Error('Built-in heading styles have a fixed outline level. Choose another paragraph style to change it.');
    if (patch.pageBreakBefore && targets.some(p => p.cellId)) throw new Error('Page breaks inside table cells are not supported yet.');
    for (const p of targets) {
      const format = { ...paragraphFormat(p, this.numbering), ...patch };
      if (format.lineSpacing < 0 || format.lineSpacing > (format.lineRule === 'auto' ? 5 : 600)) throw new Error('Line spacing must be 0–5 lines or 0–600 points.');
    }
    if (targets.every(p => !['Before', 'After'].some(side => Object.hasOwn(patch, 'space' + side) && p.format?.['autoSpace' + side]) && Object.entries(patch).every(([key, value]) => key === 'paragraphBorders' ? Object.entries(value).every(([side, border]) => sameValue(paragraphFormat(p, this.numbering).paragraphBorders[side], border)) : sameValue(paragraphFormat(p, this.numbering)[key], value)))) return false;
    this.checkpoint();
    for (const p of targets) {
      const borders = patch.paragraphBorders && { ...p.format?.paragraphBorders, ...copy(patch.paragraphBorders) };
      const borderOverrides = patch.paragraphBorders && { ...p.formatOverrides?.paragraphBorders, ...copy(patch.paragraphBorders) };
      p.format = { ...PARAGRAPH_FORMAT, ...p.format, ...copy(patch), ...(borders ? { paragraphBorders: borders } : {}) };
      clearAutomaticSpacing(p.format, patch);
      p.formatOverrides = { ...p.formatOverrides, ...copy(patch), ...(borderOverrides ? { paragraphBorders: borderOverrides } : {}) };
    }
    this.didChange();
    return true;
  }
  clearDirectParagraphFormatting() {
    const targets = new Set(this.selectedParagraphs.filter(hasDirectParagraphFormatting).map(p => p.id));
    if (!targets.size) return false;
    const paragraphs = this.paragraphs.map(p => {
      if (!targets.has(p.id)) return p;
      const next = copy(p); clearParagraph(next);
      if (this.stylesEnabled) resolveStyledParagraph(next, this.styles, this.numbering);
      return next;
    });
    listMarkers(paragraphs, this.numbering);
    this.checkpoint(); this.paragraphs = paragraphs; this.didChange(); return true;
  }
  setParagraphGeometry(patch, defaultTabStop = this.pageSettings.defaultTabStop) {
    const settings = validatePageSettings({ ...this.pageSettings, defaultTabStop });
    const changed = this.setParagraphFormat(patch);
    if (settings.defaultTabStop === this.pageSettings.defaultTabStop) return changed;
    if (!changed) this.checkpoint();
    this.pageSettings = settings; this.didChange(); return true;
  }
  adjustIndent(delta) {
    const targets = this.selectedParagraphs, current = targets.map(p => paragraphFormat(p, this.numbering).indentLeft);
    // Decreasing stops at the margin, as Decrease Indent does; an existing negative indent is left alone.
    const values = current.map(value => validateIndent(delta < 0 ? Math.max(Math.min(value, 0), value + delta) : value + delta));
    if (!delta || values.every((value, i) => value === current[i])) return false;
    this.checkpoint();
    targets.forEach((p, i) => {
      p.format = { ...PARAGRAPH_FORMAT, ...p.format, indentLeft: values[i] };
      p.formatOverrides = { ...p.formatOverrides, indentLeft: values[i] };
    });
    this.didChange(); return true;
  }
  get paragraphStyle() {
    const ids = this.selectedParagraphs.map(p => effectiveStyleId(p, this.styles) || '');
    return ids.every(id => id === ids[0]) ? ids[0] : null;
  }
  get paragraphStyles() {
    return Object.values(this.styles.definitions).filter(s => s.type === 'paragraph').map(s => {
      let error = s.error;
      try { resolveStyledParagraph({ runs: [], styleId: s.id }, this.styles, this.numbering); } catch (e) { error = e.message; }
      return { id: s.id, name: s.name, error };
    });
  }
  setParagraphStyle(id) {
    if (id && this.styles.definitions[id]?.type !== 'paragraph') throw new Error('Choose a paragraph style.');
    const targets = this.selectedParagraphs;
    if (targets.every(p => (p.styleId || '') === id)) return false;
    const next = targets.map(p => resolveStyledParagraph({ ...copy(p), styleId: id || null, styleChanged: true }, this.styles, this.numbering));
    this.checkpoint(); targets.forEach((p, i) => Object.assign(p, next[i]));
    this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false; this.stylesEnabled = true; this.didChange(); return true;
  }
  editParagraphStyle(id, patch) { return this.editNamedStyle(id, patch, 'paragraph'); }
  editNamedStyle(id, patch, type) {
    if (this.paragraphs.some(p => p.runs.some(r => r.image?.kind === 'drawing'))) throw new Error('Named styles are retained while the document contains grouped drawings. Apply direct formatting to body text instead.');
    if (!Object.keys(patch.paragraph || {}).length && !Object.keys(patch.run || {}).length && !['name', 'basedOn', 'next'].some(k => k in patch && patch[k] !== this.styles.definitions[id]?.[k])) return false;
    const styles = copy(this.styles); styles.definitions[id] = editedStyle(styles, id, patch, type);
    if (sameValue(styles, this.styles)) return false;
    const paragraphs = this.paragraphs.map(p => resolveStyledParagraph(copy(p), styles, this.numbering));
    listMarkers(paragraphs, this.numbering);
    this.checkpoint(); this.styles = styles; this.paragraphs = paragraphs; this.stylesEnabled = true; this.didChange(); return true;
  }
  createParagraphStyle(name, basedOn = this.paragraphStyle || '') {
    const styles = copy(this.styles); let id = 'CanvasStyle1', index = 1;
    while (Object.hasOwn(styles.definitions, id)) id = `CanvasStyle${++index}`;
    styles.definitions[id] = { id, type: 'paragraph', name, basedOn: basedOn || null, next: null, properties: {}, reference: {}, run: {}, generated: true };
    styles.definitions[id] = editedStyle(styles, id, { name, basedOn: basedOn || null });
    const targets = new Set(this.selectedParagraphs.map(p => p.id));
    const paragraphs = this.paragraphs.map(p => targets.has(p.id) ? resolveStyledParagraph({ ...copy(p), styleId: id, styleChanged: true }, styles, this.numbering) : p);
    this.checkpoint(); this.styles = styles; this.paragraphs = paragraphs; this.stylesEnabled = true; this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false; this.didChange(); return true;
  }
  get listFormatting() {
    const kinds = this.selectedParagraphs.map(p => listKind(this.numbering, p.list));
    return kinds.every(k => k === kinds[0]) ? kinds[0] : 'mixed';
  }
  toggleList(kind) {
    if (!['bullet', 'number'].includes(kind)) throw new Error('Choose bullets or numbering.');
    const targets = this.selectedParagraphs, remove = this.listFormatting === kind;
    this.checkpoint();
    let numId;
    if (!remove) {
      const first = this.paragraphs.indexOf(targets[0]), previous = this.paragraphs[first - 1];
      const existing = targets.find(p => listKind(this.numbering, p.list) === kind) || (previous && listKind(this.numbering, previous.list) === kind ? previous : null);
      numId = existing?.list.numId || newList(this.numbering, kind);
    }
    for (const p of targets) {
      // A direct numId=0 overrides inherited numbering when removing a list.
      p.list = remove ? null : { numId, level: listKind(this.numbering, p.list) === kind ? p.list.level : 0, direct: true };
      p.listChanged = true;
    }
    this.didChange(); return true;
  }
  changeListLevel(delta) {
    const targets = this.selectedParagraphs;
    if (!targets.every(p => p.list)) return this.adjustIndent(delta * 720);
    if (targets.some(p => p.list.level + delta < 0 || p.list.level + delta > 8)) return false;
    for (const p of targets) levelFor(this.numbering, { ...p.list, level: p.list.level + delta });
    this.checkpoint();
    for (const p of targets) { p.list = { ...p.list, direct: true, level: p.list.level + delta }; p.listChanged = true; }
    this.didChange(); return true;
  }
  restartNumbering(start = 1) {
    const first = this.selectedParagraphs[0];
    if (!first.list || listKind(this.numbering, first.list) !== 'number') return false;
    const counters = listMarkers(this.paragraphs, this.numbering)[this.paragraphs.indexOf(first)].counters;
    const originalList = { ...first.list }, next = copy(this.numbering), numId = restartList(next, first.list, start, counters);
    this.checkpoint(); this.numbering = next;
    // Restart the contiguous remainder of this list, including nested items.
    for (let i = this.paragraphs.indexOf(first); i < this.paragraphs.length; i++) {
      const p = this.paragraphs[i];
      if (!p.list || p.list.numId !== originalList.numId) break;
      if (p !== first && p.list.level < originalList.level) break;
      p.list = { ...p.list, numId, direct: true }; p.listChanged = true;
    }
    this.didChange(); return true;
  }
  insertParagraph() {
    const p = this.selectedParagraphs[0];
    if (this.range[0] === this.range[1] && p.list && !paragraphText(p)) {
      this.checkpoint(); p.list = null; p.listChanged = true; this.didChange(); return true;
    }
    const at = locate(this.paragraphs, this.range[0]), atEnd = this.range[0] === this.range[1] && at.offset === paragraphLength(p);
    const next = this.styles.definitions[effectiveStyleId(p, this.styles)]?.next;
    const changed = this.replace('\n');
    if (changed && atEnd && this.styles.definitions[next]?.type === 'paragraph') {
      const added = this.paragraphs[at.index + 1]; added.styleId = next; added.styleChanged = true;
      resolveStyledParagraph(added, this.styles, this.numbering); this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false;
    }
    return changed;
  }
  /** The number of sections: one per section break, plus the final section. */
  get sectionCount() { return this.paragraphs.reduce((n, p) => n + (p.sectionEnd ? 1 : 0), 1); }
  /** The index of the section holding a text position; a section break belongs to the section it ends. */
  sectionIndexAt(position = this.range[0]) {
    const at = locate(this.paragraphs, position).index;
    let index = 0;
    for (let i = 0; i < at; i++) if (this.paragraphs[i].sectionEnd) index++;
    return index;
  }
  /** Every section's page settings, in document order; the final section's are the document's own. */
  get sectionSettings() { return [...this.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd), this.pageSettings]; }
  /**
   * Change page settings. Section settings apply by `scope`: 'document' (every section), 'section' (the
   * caret's section, or `section`), 'forward' (from the caret on: a section break of `breakType` starts
   * a new section there unless the caret already starts one) or 'selection' (the selected text becomes
   * its own section between two breaks). Document-wide settings always apply to every section. With one
   * section the default scope is the document; with several, the caret's section.
   */
  setPageSettings(patch, { scope, section, breakType = 'nextPage' } = {}) {
    for (const key of ['compatibilityMode', 'splitPgBreakAndParaMark', 'suppressSpBfAfterPgBrk', 'noTabHangInd', 'forgetLastTabAlignment', 'allowSpaceOfSameStyleInTable', 'wrapTrailSpaces', 'ulTrailSpace', 'doNotExpandShiftReturn', 'doNotUseHTMLParagraphAutoSpacing']) if (key in patch && patch[key] !== this.pageSettings[key]) throw new Error('Page compatibility settings are retained from the document.');
    if ('backgroundPicture' in patch && patch.backgroundPicture !== null && JSON.stringify(patch.backgroundPicture) !== JSON.stringify(this.pageSettings.backgroundPicture)) throw new Error('Creating a picture page background is not supported.');
    scope ??= this.sectionCount > 1 ? 'section' : 'document';
    if (!['document', 'section', 'forward', 'selection'].includes(scope)) throw new Error('Unknown page settings scope.');
    const documentPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => DOCUMENT_PAGE_KEYS.includes(key)));
    if ('background' in patch && patch.background !== this.pageSettings.background) documentPatch.backgroundPicture = null;
    const sectionPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => !DOCUMENT_PAGE_KEYS.includes(key)));
    const plan = (first, last) => this.sectionSettings.map((settings, i) => validatePageSettings({ ...settings, ...documentPatch, ...(i >= first && i <= last ? sectionPatch : {}) }));
    const apply = next => {
      const ends = this.paragraphs.filter(p => p.sectionEnd);
      next.forEach((settings, i) => { if (i < ends.length) ends[i].sectionEnd = settings; else this.pageSettings = settings; });
    };
    const changed = next => next.some((settings, i) => Object.keys(settings).some(key => JSON.stringify(settings[key]) !== JSON.stringify(this.sectionSettings[i][key])));
    if (scope === 'document' || scope === 'section') {
      const at = scope === 'document' ? 0 : section ?? this.sectionIndexAt(this.range[0]);
      if (!Number.isInteger(at) || at < 0 || at >= this.sectionCount) throw new Error('There is no such section.');
      const next = plan(at, scope === 'document' ? this.sectionCount - 1 : at);
      if (!changed(next)) return false;
      this.checkpoint(); apply(next); this.didChange(); return true;
    }
    // A new section: validate the result before changing anything, so a failure leaves the document as it was.
    const [start, end] = this.range;
    if (scope === 'selection' && start === end) throw new Error('Select the text to give its own settings.');
    this.checkpoint();
    let caret = start;
    if (scope === 'selection' && !this.startsSection(end)) this.insertSectionBreakAt(end, breakType);
    if (!this.startsSection(start)) { this.insertSectionBreakAt(start, breakType); caret = start + 1; }
    const first = this.sectionIndexAt(caret);
    // A selection that already crossed section breaks gives its settings to every section it covers.
    const last = scope === 'selection' ? this.sectionIndexAt(Math.max(caret, end - 1 + (caret - start))) : this.sectionCount - 1;
    apply(plan(first, last));
    if (scope === 'selection') this.select(this.sectionRange(first).start, Math.max(this.sectionRange(first).start, this.sectionRange(last).end - 1));
    this.didChange(); return true;
  }
  /** Whether a position is the first in its section (the document start or just after a section break). */
  startsSection(position) {
    const at = locate(this.paragraphs, position);
    return at.offset === 0 && (at.index === 0 || !!this.paragraphs[at.index - 1].sectionEnd);
  }
  /** The text range of a section: from its first position to its section mark. */
  sectionRange(index) {
    let start = 0, at = 0, section = 0;
    for (const p of this.paragraphs) {
      const length = paragraphLength(p);
      if (section === index && p.sectionEnd) return { start, end: at + length + 1 };
      at += length + 1;
      if (p.sectionEnd) { section++; if (section === index) start = at; }
    }
    return { start, end: documentLength(this.paragraphs) };
  }
  /**
   * Insert a section break (§17.6.17) at the caret, or replacing the selection: the text before it ends a
   * section with a copy of the current section's settings, and the section after it starts by `type`.
   */
  insertSectionBreak(type = 'nextPage') {
    const [start, end] = this.range;
    this.checkpoint();
    if (start !== end) { this.replace(''); }
    this.insertSectionBreakAt(this.range[0], type);
    this.didChange(); return true;
  }
  insertSectionBreakAt(position, type) {
    if (!SECTION_TYPES.includes(type)) throw new Error('Choose a next page, continuous, even page or odd page section break.');
    const at = locate(this.paragraphs, position);
    if (this.paragraphs[at.index].cellId) throw new Error('Section breaks cannot be inserted in a table.');
    const index = this.sectionIndexAt(position);
    const owner = this.paragraphs.filter(p => p.sectionEnd)[index];
    const settings = owner ? owner.sectionEnd : this.pageSettings;
    this.select(position);
    this.replace('\n');
    const mark = this.paragraphs[at.index];
    mark.sectionEnd = copy(settings);
    mark.sectionProperties = owner ? owner.sectionProperties : null;
    mark.sectionSourceIndex = owner ? owner.sectionSourceIndex ?? index : this.sourceSectionCount - 1;
    const following = this.paragraphs.filter(p => p.sectionEnd)[index + 1];
    if (following) following.sectionEnd = validatePageSettings({ ...following.sectionEnd, sectionType: type });
    else this.pageSettings = validatePageSettings({ ...this.pageSettings, sectionType: type });
  }
  insertPageBreak() { return this.replace('\f'); }
  /**
   * A text-wrapping break (§17.3.3.1 br with clear): the line ends here and the text continues below
   * any floating objects beside it (clear 'all'), or a plain line break with clear 'none'.
   */
  insertTextWrappingBreak(clear = 'all') {
    if (!['none', 'left', 'right', 'all'].includes(clear)) throw new Error('Invalid text-wrapping break.');
    if (!this.replace('\v')) return false;
    // The break ends just before the caret: with Track Changes on it follows the struck-out selection.
    const at = locate(this.paragraphs, this.selection.focus - 1), p = this.paragraphs[at.index];
    let offset = 0;
    const run = p.runs.find(r => { const inside = at.offset >= offset && at.offset < offset + r.text.length; offset += r.text.length; return inside; });
    if (!run || run.text[at.offset - (offset - run.text.length)] !== '\v' || run.image || run.contentControl) return true;
    p.runs = [...sliceRuns(p.runs, 0, at.offset), { ...run, text: '\v', breakClear: clear }, ...sliceRuns(p.runs, at.offset + 1)];
    this.didChange(); return true;
  }
  insertColumnBreak() { return this.replace('\u000e'); }
  get tableContext() { return cellContext(this.tables, this.paragraphs[locate(this.paragraphs, this.selection.focus).index].cellId); }
  /** A rectangular cell selection (Select Column, a drag across cells), or null. It is not part of the document. */
  get activeCellBlock() {
    const block = this.cellBlock, table = block && this.tables.find(t => t.id === block.tableId);
    if (!table) return null;
    let normalized; try { normalized = normalizeCellBlock(table, block); } catch { return null; }
    return normalized && normalized.top === block.top && normalized.bottom === block.bottom && normalized.left === block.left && normalized.right === block.right ? { ...block, table } : null;
  }
  setCellBlock(block) {
    const table = block && this.tables.find(t => t.id === block.tableId);
    const normalized = table ? normalizeCellBlock(table, block) : null;
    const placements = normalized ? cellBlockPlacements(table, normalized) : [], first = placements[0];
    if (!first) { this.cellBlock = null; return false; }
    // Whole rows are one stretch of text, so text commands reach all of them. Any other block's text
    // selection covers its first cell: typing replaces that cell's text, as with any selection.
    const whole = normalized.left === 0 && normalized.right === table.grid.length, lastCell = whole ? placements.at(-1).cell : first.cell;
    const index = this.paragraphs.findIndex(p => p.cellId === first.cell.id);
    const last = this.paragraphs.findLastIndex(p => p.cellId === lastCell.id);
    this.select(this.paragraphOffset(index), this.paragraphOffset(last) + paragraphLength(this.paragraphs[last]));
    this.cellBlock = { tableId: table.id, top: normalized.top, bottom: normalized.bottom, left: normalized.left, right: normalized.right };
    return true;
  }
  /**
   * A rectangular cell selection that is not whole rows formats each of its cells in turn: the text
   * range through them would also reach the cells between. Returns undefined when there is no such block.
   */
  blockCellPass(fn) {
    if (!this.cellBlock || this.inBlockCellPass) return undefined;
    const block = this.activeCellBlock;
    if (!block || block.left === 0 && block.right === block.table.grid.length) return undefined;
    const selection = { ...this.selection }, saved = this.cellBlock;
    let changed = false;
    this.inBlockCellPass = true;
    try {
      for (const { cell } of cellBlockPlacements(block.table, block)) {
        const first = this.paragraphs.findIndex(p => p.cellId === cell.id), last = this.paragraphs.findLastIndex(p => p.cellId === cell.id);
        if (first < 0) continue;
        this.select(this.paragraphOffset(first), this.paragraphOffset(last) + paragraphLength(this.paragraphs[last]));
        if (fn()) changed = true;
      }
    } finally { this.inBlockCellPass = false; this.selection = selection; this.cellBlock = saved; }
    return changed;
  }
  get selectedTableCells() {
    const block = this.activeCellBlock;
    if (block) return cellBlockPlacements(block.table, block).map(p => p.cell);
    const ids = new Set(this.selectedParagraphs.map(p => p.cellId).filter(Boolean));
    return this.tables.flatMap(table => editableCells(table).filter(cell => ids.has(cell.id)));
  }
  get cellVerticalAlignment() {
    const cells = this.selectedTableCells, value = cells[0]?.vertical || 'top';
    return cells.length && cells.every(cell => (cell.vertical || 'top') === value) ? value : null;
  }
  get cellShading() {
    const cells = this.selectedTableCells, value = cells[0]?.shading || 'auto';
    return cells.length && cells.every(cell => (cell.shading || 'auto') === value) ? value : null;
  }
  get cellBorderValues() {
    const ids = new Set(this.selectedTableCells.map(cell => cell.id));
    return this.tables.flatMap(table => {
      const owners = verticalMerges(table);
      return table.rows.flatMap((row, rowIndex) => rowGrid(row).filter(({ cell }) => ids.has(cell.id)).map(({ cell, column, span }) => {
        const owner = owners.get(cell.id);
        return effectiveCellBorders(table, cell, rowIndex, column, span, owner.endRow - owner.rowIndex + 1);
      }));
    });
  }
  setCellMargins(value) {
    const patch = checkedCellMargins(value), ids = new Set(this.selectedTableCells.map(cell => cell.id));
    const changes = this.tables.flatMap(table => {
      const owners = verticalMerges(table);
      return tableCells(table).filter(cell => ids.has(owners.get(cell.id).cell.id));
    }).map(cell => ({ cell, patch: Object.fromEntries(Object.entries(patch).filter(([side, value]) => value === null ? Object.hasOwn(cell.directMargins || {}, side) : value !== cell.directMargins?.[side])) })).filter(change => Object.keys(change.patch).length);
    if (!changes.length) return false;
    this.checkpoint();
    for (const { cell, patch } of changes) {
      cell.directMargins = { ...cell.directMargins }; cell.marginChanges = { ...cell.marginChanges, ...patch };
      for (const [side, value] of Object.entries(patch)) { if (value === null) delete cell.directMargins[side]; else cell.directMargins[side] = value; }
      cell.margins = resolveCellMargins(cell.inheritedMargins, cell.directMargins, cell.marginDefaults);
    }
    this.didChange(); return true;
  }
  setCellBorders(value) {
    const patch = checkedCellBorders(value), ids = new Set(this.selectedTableCells.map(cell => cell.id));
    const changes = this.tables.flatMap(table => {
      const owners = verticalMerges(table);
      return tableCells(table).filter(cell => ids.has(owners.get(cell.id).cell.id));
    }).map(cell => ({ cell, patch: Object.fromEntries(Object.entries(patch).filter(([side, value]) => value === null ? Object.hasOwn(cell.directBorders || {}, side) : !sameValue(value, cell.directBorders?.[side]))) })).filter(change => Object.keys(change.patch).length);
    if (!changes.length) return false;
    this.checkpoint();
    for (const { cell, patch } of changes) {
      cell.directBorders = { ...cell.directBorders }; cell.borderChanges = { ...cell.borderChanges, ...copy(patch) };
      for (const [side, value] of Object.entries(patch)) { if (value === null) delete cell.directBorders[side]; else cell.directBorders[side] = copy(value); }
      cell.borders = resolveCellBorders(cell.inheritedBorders, cell.directBorders);
    }
    this.didChange(); return true;
  }
  setCellShading(value) {
    if (value !== null) value = checkedShading(value);
    // Write every physical member of a vertical merge so splitting it or opening
    // it in another consumer retains the fill across the whole selected cell.
    const ids = new Set(this.selectedTableCells.map(cell => cell.id));
    const cells = this.tables.flatMap(table => {
      const owners = verticalMerges(table);
      return tableCells(table).filter(cell => ids.has(owners.get(cell.id).cell.id));
    }).filter(cell => value === null ? cell.shadingExplicit : !cell.shadingExplicit || cell.shadingNil || cell.shading !== value);
    if (!cells.length) return false;
    this.checkpoint();
    for (const cell of cells) {
      cell.shading = value ?? cell.inheritedShading ?? 'auto'; cell.fill = cellShadingFill(cell.shading);
      cell.shadingExplicit = value !== null; cell.shadingNil = false; cell.shadingChanged = true;
    }
    this.didChange(); return true;
  }
  setCellVerticalAlignment(value) {
    if (value !== null) checkedCellAlignment(value);
    const cells = this.selectedTableCells.filter(cell => value === null ? cell.verticalExplicit : !cell.verticalExplicit || cell.vertical !== value);
    if (!cells.length) return false;
    this.checkpoint();
    for (const cell of cells) { cell.vertical = value ?? cell.inheritedVertical ?? 'top'; cell.verticalExplicit = value !== null; cell.verticalChanged = true; }
    this.didChange(); return true;
  }
  setTableProperties(patch) {
    const table = this.tableContext?.table; if (!table) return false;
    const next = copy(table);
    for (const key of Object.keys(patch)) if (!['layout', 'width', 'alignment', 'indent', 'columns', 'clearCellWidths'].includes(key)) throw new Error('Unknown table property.');
    if ('layout' in patch && !['fixed', 'autofit'].includes(patch.layout)) throw new Error('Choose fixed widths or AutoFit.');
    if ('alignment' in patch && !['left', 'center', 'right'].includes(patch.alignment)) throw new Error('Choose left, center or right table alignment.');
    if ('indent' in patch && (!Number.isInteger(patch.indent) || Math.abs(patch.indent) > 31680)) throw new Error('Table indentation must be between −22 and 22 inches.');
    if ('width' in patch) {
      const w = patch.width;
      if (!w || !['auto', 'nil', 'dxa', 'pct'].includes(w.type) || !Number.isFinite(w.value) || w.value < 0 || w.value > 31680 || w.type === 'dxa' && (!Number.isInteger(w.value) || !w.value)) throw new Error('Enter a valid table width.');
    }
    for (const key of ['layout', 'width', 'alignment', 'indent']) if (key in patch && !sameValue(table[key], patch[key])) { next[key] = copy(patch[key]); next[`${key}Changed`] = true; }
    if (next.floating) {
      if ('alignment' in patch) {
        if (patch.alignment === 'left') { delete next.floating.tblpXSpec; next.floating.tblpX = next.indent; }
        else { next.floating.tblpXSpec = patch.alignment; next.indent = 0; }
      }
      if ('indent' in patch) { next.floating.tblpX = patch.indent; delete next.floating.tblpXSpec; next.alignment = 'left'; }
      if (!sameValue(next.floating,table.floating)) next.floatingChanged = true;
    }
    // A table alignment command applies to every row, including imported
    // row/style/exception overrides; otherwise the control can appear inert.
    if ('alignment' in patch) for (const row of next.rows) if (row.alignment !== undefined && row.alignment !== patch.alignment) {
      row.alignment = patch.alignment; row.alignmentChanged = true;
    }
    if (patch.columns) {
      if (!Array.isArray(patch.columns) || patch.columns.length !== table.grid.length || patch.columns.some(w => !Number.isInteger(w) || w < 1 || w > 31680)) throw new Error('Enter a positive width for each column, up to 22 inches.');
      if (!sameValue(next.grid, patch.columns) || next.rows.some(row => rowGrid(row).some(({ cell, column, span }) => cell.width?.type !== 'dxa' || cell.width.value !== spanWidth(patch.columns, column, span)))) {
        next.grid = [...patch.columns]; next.gridChanged = true;
        setCellWidths(next, patch.columns);
        if (!('width' in patch)) { next.width = { type: 'dxa', value: patch.columns.reduce((a,b) => a+b, 0) }; next.widthChanged = true; }
      }
    }
    if (patch.clearCellWidths) for (const cell of tableCells(next)) if (cell.width?.type !== 'auto') { cell.width = { type: 'auto', value: 0 }; cell.widthChanged = true; }
    if (patch.clearCellWidths) for (const row of next.rows) for (const side of ['Before', 'After']) if (row[`grid${side}`] && row[`width${side}`]?.type !== 'auto') {
      row[`width${side}`] = { type: 'auto', value: 0 }; row[`width${side}Changed`] = true;
    }
    if (next.width?.type === 'dxa' && next.width.value > 31680) throw new Error('The preferred table width cannot exceed 22 inches.');
    if (next.layout === 'fixed' && next.grid.some(w => w <= 0)) throw new Error('Set positive column widths before choosing fixed layout.');
    if (sameValue(next, table)) return false;
    this.checkpoint(); Object.assign(table, next); this.didChange(); return true;
  }
  fitTable(mode) {
    if (!['contents', 'page'].includes(mode)) throw new Error('Choose contents or page width.');
    return this.setTableProperties({ layout: 'autofit', width: { type: mode === 'page' ? 'pct' : 'auto', value: mode === 'page' ? 5000 : 0 }, clearCellWidths: true });
  }
  get mergeCellsContext() {
    const ps = this.paragraphs.slice(locate(this.paragraphs, this.range[0]).index, locate(this.paragraphs, this.range[1]).index + 1);
    if (ps.some(p => !p.cellId)) return null;
    const selected = new Set(ps.map(p => p.cellId));
    const byCell = new Map(this.tables.flatMap(table => tableCells(table).map(cell => [cell.id, table])));
    // Resolve descendants to their cell in the nearest shared enclosing table.
    // A nested selection within one outer cell never makes that cell mergeable.
    for (let first = cellContext(this.tables, ps[0]?.cellId); first; first = cellContext(this.tables, first.table.parentCellId)) {
      const ids = new Set();
      for (let id of selected) {
        while (id && byCell.get(id) !== first.table) id = byCell.get(id)?.parentCellId;
        ids.add(id);
      }
      if (ids.has(undefined) || ids.size < 2 || [...ids].some(id => !first.row.cells.some(c => c.id === id))) continue;
      const owners = verticalMerges(first.table);
      if ([...ids].some(id => owners.get(id).cells.length > 1)) return null;
      const cells = first.row.cells.filter(c => ids.has(c.id));
      if (first.row.cells.slice(first.index, first.index + cells.length).some(c => !ids.has(c.id))) return null;
      return { ...first, cells };
    }
    return null;
  }
  mergeCells() {
    const context = this.mergeCellsContext;
    if (!context) throw new Error('Select text in two or more adjacent cells within one row.');
    const { table, row, cell, column, index, cells } = context, ids = new Set(cells.map(c => c.id));
    const span = cells.reduce((n, c) => n + cellSpan(c), 0);
    const width = table.layout === 'fixed' ? { type: 'dxa', value: Math.round(spanWidth(fixedColumnWidths(table, this.sectionWritingWidth), column, span)) } : { type: 'auto', value: 0 };
    const bookmarks = this.hasColumnBookmarks ? bookmarkStructureState(this.paragraphs, this.tables) : null;
    if (bookmarks) bookmarks.entries = bookmarks.entries.filter(entry => entry.columnRange);
    this.checkpoint(); clearMerge(cell); cell.span = span; cell.spanChanged = true; cell.width = width; cell.widthChanged = true;
    row.cells.splice(index + 1, cells.length - 1);
    for (const p of this.paragraphs) if (ids.has(p.cellId)) p.cellId = cell.id;
    for (const nested of this.tables) if (ids.has(nested.parentCellId)) nested.parentCellId = cell.id;
    if (this.hasPersistentBlockControls) mergeCellControls(this.paragraphs, ids, cell.id);
    if (this.hasBlockControls) rehomeMovedBlockControls(this.paragraphs);
    if (bookmarks) repairStructuralBookmarks(this.paragraphs, bookmarks, this.tables, table.id);
    normalizeBlockBookmarkScopes(this.paragraphs, this.tables);
    refreshTableStyles(this, table); this.didChange(); return true;
  }
  get mergeBelowContext() {
    const context = this.tableContext; if (!context) return null;
    const owners = verticalMerges(context.table), owner = owners.get(context.cell.id);
    const below = context.table.rows[owner.endRow + 1]; if (!below) return null;
    if ((context.row.alignment ?? context.table.alignment) !== (below.alignment ?? context.table.alignment)) return null;
    const entry = rowGrid(below).find(c => c.column === context.column && c.span === context.span);
    if (!entry || owners.get(entry.cell.id).cell !== entry.cell) return null;
    return { ...context, owner, below: owners.get(entry.cell.id) };
  }
  mergeCellBelow() {
    const context = this.mergeBelowContext;
    if (!context) throw new Error('The cell below must cover the same grid columns and row alignment. Align the table or split other merged cells first.');
    const { table, owner, below } = context, state = tableContent(this, table);
    this.checkpoint();
    owner.cell.vMerge = 'restart'; owner.cell.mergeChanged = true;
    below.cell.vMerge = 'continue'; below.cell.mergeChanged = true; delete below.cell.continuation;
    below.cell.continuationStyleId = this.styles.defaultParagraph;
    const moved = state.byCell.get(below.cell.id);
    reparentCellContent(this, moved, below.cell.id, owner.cell.id);
    if (this.hasPersistentBlockControls) mergeCellControls(this.paragraphs, new Set([owner.cell.id, below.cell.id]), owner.cell.id);
    state.byCell.get(owner.cell.id).push(...moved); state.byCell.delete(below.cell.id);
    applyTableContent(this, table, state); this.didChange(); return true;
  }
  get canSplitCell() {
    const c = this.tableContext; return !!c && (c.span > 1 || verticalMerges(c.table).get(c.cell.id).cells.length > 1);
  }
  splitCell() {
    const context = this.tableContext; if (!this.canSplitCell) return false;
    const { table, row, cell, column, index, span } = context;
    const owner = verticalMerges(table).get(cell.id);
    if (owner.cells.length > 1) {
      const state = tableContent(this, table), template = state.byCell.get(cell.id).at(-1);
      const addedCount = owner.cells.length * span - 1;
      if (documentLength(this.paragraphs) + addedCount > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
      const widths = table.layout === 'fixed' ? fixedColumnWidths(table, this.sectionWritingWidth) : null;
      this.checkpoint();
      for (const physical of owner.cells) {
        const row = table.rows.find(r => r.cells.includes(physical)), at = row.cells.indexOf(physical);
        const cells = [physical, ...Array.from({ length: span - 1 }, () => ({ ...copy(physical), id: tableId('cell'), generated: true }))];
        for (const [i, item] of cells.entries()) {
          clearMerge(item); item.span = 1; item.spanChanged = true;
          item.width = widths ? { type: 'dxa', value: Math.round(widths[column + i]) } : { type: 'auto', value: 0 }; item.widthChanged = true;
          if (!state.byCell.has(item.id)) state.byCell.set(item.id, [blankCellParagraph(template, item)]);
        }
        row.cells.splice(at, 1, ...cells);
      }
      applyTableContent(this, table, state); this.didChange(); return true;
    }
    if (documentLength(this.paragraphs) + span - 1 > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const widths = table.layout === 'fixed' ? fixedColumnWidths(table, this.sectionWritingWidth) : null;
    const last = this.paragraphs.findLastIndex(p => p.cellId === cell.id), template = this.paragraphs[last];
    const bookmarks = this.hasColumnBookmarks ? bookmarkStructureState(this.paragraphs, this.tables) : null;
    if (bookmarks) bookmarks.entries = bookmarks.entries.filter(entry => entry.columnRange);
    this.checkpoint();
    const added = Array.from({ length: span - 1 }, () => ({ ...copy(cell), id: tableId('cell'), generated: true }));
    for (const [i, item] of [cell, ...added].entries()) {
      clearMerge(item);
      item.span = 1; item.spanChanged = true; item.width = widths ? { type: 'dxa', value: Math.round(widths[column + i]) } : { type: 'auto', value: 0 }; item.widthChanged = true;
    }
    row.cells.splice(index + 1, 0, ...added);
    this.paragraphs.splice(last + 1, 0, ...added.map(c => blankCellParagraph(template, c)));
    if (bookmarks) {
      repairStructuralBookmarks(this.paragraphs, bookmarks, this.tables, table.id);
      normalizeBlockBookmarkScopes(this.paragraphs, this.tables);
    }
    refreshTableStyles(this, table); this.didChange(); return true;
  }
  get selectedTableRows() {
    const block = this.activeCellBlock;
    if (block) return block.table.rows.slice(block.top, block.bottom + 1);
    const rows = new Map();
    for (const table of this.tables) for (const [id, owner] of verticalMerges(table)) if (id === owner.cell.id) rows.set(id, table.rows.slice(owner.rowIndex, owner.endRow + 1));
    return [...new Set(this.selectedParagraphs.flatMap(p => rows.get(p.cellId) || []))];
  }
  get tableRowKeep() { const rows = this.selectedTableRows; return rows.length && rows.every(r => r.cantSplit === rows[0].cantSplit) ? rows[0].cantSplit : null; }
  get tableRowHeight() {
    const rows = this.selectedTableRows, first = rows.length && rowHeight(rows[0]);
    return first && rows.every(row => sameValue(rowHeight(row), first)) ? first : null;
  }
  setTableRowHeight(value) {
    const height = checkedRowHeight(value);
    const rows = this.selectedTableRows.filter(row => height === null ? row.heightExplicit : !row.heightExplicit || !sameValue(rowHeight(row), height));
    if (!rows.length) return false;
    this.checkpoint();
    for (const row of rows) {
      const next = height || row.inheritedRowHeight || { rule: 'auto', value: 0 };
      row.heightRule = next.rule; row.minHeight = next.value; row.heightExplicit = height !== null; row.heightChanged = true;
    }
    this.didChange(); return true;
  }
  setTableRowKeep(value) {
    if (typeof value !== 'boolean') throw new Error('Row pagination must be on or off.');
    const rows = this.selectedTableRows;
    if (rows.every(r => r.cantSplit === value)) return false;
    this.checkpoint(); rows.forEach(row => { row.cantSplit = value; row.keepChanged = true; }); this.didChange(); return true;
  }
  get headerRowsThroughSelection() {
    const table = this.tableContext?.table; if (!table) return 0;
    return Math.max(...this.selectedTableRows.filter(row => table.rows.includes(row)).map(row => table.rows.indexOf(row) + 1));
  }
  setTableHeaderRows(count) {
    const table = this.tableContext?.table; if (!table) return false;
    if (!Number.isInteger(count) || count < 0 || count > table.rows.length) throw new Error('Choose how many leading rows to repeat.');
    // Include whole vertical merges when defining an authored header region.
    for (const owner of new Set(verticalMerges(table).values())) if (owner.rowIndex < count) count = Math.max(count, owner.endRow + 1);
    const changed = table.rows.filter((row, i) => !!row.header !== (i < count));
    if (!changed.length) return false;
    this.checkpoint(); for (const row of changed) { row.header = table.rows.indexOf(row) < count; row.headerChanged = true; }
    refreshTableStyles(this, table); this.didChange(); return true;
  }
  paragraphOffset(index) { return this.paragraphs.slice(0, index).reduce((n, p) => n + paragraphLength(p) + 1, 0); }
  selectCell(id) {
    const index = this.paragraphs.findIndex(p => p.cellId === id);
    if (index < 0) return false;
    this.select(this.paragraphOffset(index)); return true;
  }
  moveCell(direction) {
    const context = this.tableContext; if (!context) return false;
    const cells = editableCells(context.table), index = cells.findIndex(c => c.id === context.cell.id);
    if (cells[index + direction]) { this.selectCell(cells[index + direction].id); return false; }
    if (direction > 0) return this.insertTableRow();
    const p = this.paragraphs.findIndex(p => p.cellId === context.cell.id);
    this.select(Math.max(0, this.paragraphOffset(p) - 1)); return false;
  }
  insertTable(rows = 2, columns = 2, availableWidth) {
    if (this.range[0] !== this.range[1]) throw new Error('Place the caret where you want to insert a table.');
    if(this.hasBodyFields && bodyFieldRanges(this.paragraphs).some(r=>r.start<=this.range[0]&&this.range[0]<=r.end))throw new Error('Tables inside body fields are not supported yet.');
    if (this.hasPersistentBlockControls && blockControlGroups(this.paragraphs).some(g => g.control.persistent && g.start <= this.range[0] && this.range[0] <= g.end)) throw new Error('Tables inside persistent content controls are not supported yet.');
    const parent = this.tableContext;
    if (!Number.isInteger(rows) || rows < 1 || rows > 500 || !Number.isInteger(columns) || columns < 1 || columns > 32) throw new Error('Choose 1–500 rows and 1–32 columns.');
    if (documentLength(this.paragraphs) + rows * columns + 1 > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const borderSize = 4; // Eighth-points; the generated table uses single borders.
    const page = this.sectionPageSettings;
    const borderSpace = parent || page.compatibilityMode >= 15 ? borderSize * 2.5 : 0;
    const width = (parent ? Math.floor(availableWidth) : this.sectionWritingWidth - (page.gutterAtTop ? 0 : page.gutter)) - borderSpace;
    if (!Number.isFinite(width) || width <= 0) throw new Error('The containing cell must have a resolved writing width.');
    const grid = Array.from({ length: columns }, (_, i) => Math.floor(width * (i + 1) / columns) - Math.floor(width * i / columns));
    if (grid.some(w => w < 360)) throw new Error('These columns are too narrow for the available space. Use fewer columns.');
    let styleId = 'CanvasTable1', styleIndex = 1;
    while (Object.hasOwn(this.styles.definitions, styleId)) styleId = `CanvasTable${++styleIndex}`;
    const styles = copy(this.styles);
    styles.definitions[styleId] = { id: styleId, type: 'table', name: 'Canvas table', basedOn: null, properties: {}, reference: {}, run: {}, generated: true };
    const table = { id: tableId('t'), grid, width: { type: 'dxa', value: width }, layout: 'fixed', alignment: 'left', indent: 0, margins: { top: 72, right: 108, bottom: 72, left: 108 }, borders: Object.fromEntries(['top', 'right', 'bottom', 'left', 'insideH', 'insideV'].map(s => [s, { style: 'single', size: borderSize, color: '000000' }])), styleId, rows: [] };
    if (parent) table.parentCellId = parent.cell.id;
    const content = [];
    for (let r = 0; r < rows; r++) {
      const row = { id: tableId('row'), cantSplit: true, minHeight: 0, cells: [] };
      grid.forEach(w => {
        const cell = { id: tableId('cell'), width: { type: 'dxa', value: w }, margins: { ...table.margins }, inheritedMargins: { ...table.margins }, directMargins: {}, vertical: 'top' };
        row.cells.push(cell);
        content.push(resolveStyledParagraph(paragraph('', { cellId: cell.id, tableStyleId: table.styleId }), styles, this.numbering));
      });
      table.rows.push(row);
    }
    const location = locate(this.paragraphs, this.range[0]);
    this.replace('\n'); // One transaction splits the surrounding paragraph.
    this.styles = styles; this.stylesEnabled = true;
    this.paragraphs.splice(location.index + 1, 0, ...content); this.tables.push(table);
    this.selectCell(table.rows[0].cells[0].id); this.didChange(); return true;
  }
  insertTableRow() {
    const context = this.tableContext; if (!context) return false;
    const { table } = context, owners = verticalMerges(table), rowIndex = owners.get(context.cell.id).endRow, row = table.rows[rowIndex];
    if (documentLength(this.paragraphs) + row.cells.length > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    if (table.rows.length >= 1000) throw new Error('This table already has 1,000 rows.');
    const next = { ...copy(row), id: tableId('row'), header: rowIndex + 1 < headerRowCount(table), headerChanged: true, cells: row.cells.map(c => ({ ...copy(c), id: tableId('cell'), generated: true })) };
    const state = tableContent(this, table);
    next.cells.forEach((cell, i) => {
      const owner = owners.get(row.cells[i].id); clearMerge(cell);
      if (owner.endRow > rowIndex) cell.vMerge = 'continue';
      else state.byCell.set(cell.id, [blankCellParagraph(state.byCell.get(owner.cell.id)[0], cell)]);
    });
    state.bookmarks.insertedRow = { tableId: table.id, after: row.id, id: next.id };
    this.checkpoint(); table.rows.splice(rowIndex + 1, 0, next); applyTableContent(this, table, state);
    this.selectCell(next.cells.find(c => state.byCell.has(c.id))?.id); this.didChange(); return true;
  }
  insertTableColumn() {
    const context = this.tableContext; if (!context) return false;
    const { table, end: position } = context;
    if (table.rows.some(row => row.gridBefore || row.gridAfter)) throw new Error('Column insertion in tables with omitted grid cells is not supported yet.');
    if (documentLength(this.paragraphs) + table.rows.length > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    if (table.grid.length >= 32) throw new Error('This table already has 32 columns.');
    const automatic = table.layout === 'autofit'; let grid = [...table.grid], total;
    if (automatic) grid.splice(position, 0, 0);
    else {
      const old = fixedColumnWidths(table, this.sectionWritingWidth);
      total = Math.round(old.reduce((a,b) => a+b, 0));
      const widths = old.map(w => w * old.length / (old.length + 1)); widths.splice(position, 0, total / (old.length + 1));
      grid = widths.map((w, i) => Math.round(widths.slice(0, i + 1).reduce((a,b) => a+b, 0)) - Math.round(widths.slice(0, i).reduce((a,b) => a+b, 0)));
      if (grid.some(w => w < 360)) throw new Error('The new column would leave too little writing space.');
    }
    const state = tableContent(this, table), owners = verticalMerges(table);
    state.bookmarks.gridEdit = { tableId: table.id, position, removed: 0, inserted: 1 };
    this.checkpoint(); let selected;
    for (const row of table.rows) {
      const entries = rowGrid(row), containing = entries.find(c => c.column < position && c.end > position);
      if (containing) { containing.cell.span = containing.span + 1; containing.cell.spanChanged = true; continue; }
      const { cell: source, index } = entries.find(c => c.end === position);
      const cell = { ...copy(source), id: tableId('cell'), span: 1, spanChanged: true, generated: true, width: { type: 'auto', value: 0 }, widthChanged: true };
      clearMerge(cell);
      state.byCell.set(cell.id, [blankCellParagraph(state.byCell.get(owners.get(source.id).cell.id).at(-1), cell)]);
      row.cells.splice(index + 1, 0, cell);
      if (row === context.row) selected = cell.id;
    }
    table.grid = grid; table.gridChanged = true;
    if (!automatic) { setCellWidths(table, grid); table.width = { type: 'dxa', value: total }; table.widthChanged = true; }
    applyTableContent(this, table, state);
    this.selectCell(selected); this.didChange(); return true;
  }
  deleteTablePart(kind = 'table') {
    const context = this.tableContext; if (!context) return false;
    if (!['table', 'row', 'column'].includes(kind)) throw new Error('Choose a table, row or column.');
    const { table, row, rowIndex, column, end, span } = context;
    if (kind === 'column' && table.rows.some(row => row.gridBefore || row.gridAfter)) throw new Error('Column deletion in tables with omitted grid cells is not supported yet.');
    if (kind === 'row' && table.rows.length === 1 || kind === 'column' && span === table.grid.length) kind = 'table';
    const entries = kind === 'column' ? table.rows.flatMap(rowGrid) : [];
    const removed = kind === 'table' ? tableCells(table) : kind === 'row' ? row.cells : entries.filter(c => c.column >= column && c.end <= end).map(c => c.cell);
    const ids = new Set(removed.map(c => c.id)), first = this.paragraphs.findIndex(p => ids.has(p.cellId));
    const widths = kind === 'column' ? table.layout === 'autofit' ? [...table.grid] : fixedColumnWidths(table, this.sectionWritingWidth) : null;
    const state = tableContent(this, table), owners = verticalMerges(table);
    if (kind === 'column') state.bookmarks.gridEdit = { tableId: table.id, position: column, removed: span, inserted: 0 };
    this.checkpoint();
    if (kind === 'table') { this.tables = this.tables.filter(t => t.id !== table.id); this.paragraphs.splice(state.start, state.count); removeOrphanedTables(this); }
    else if (kind === 'row') {
      for (const cell of row.cells) {
        const owner = owners.get(cell.id);
        if (owner.cell !== cell || owner.cells.length === 1) continue;
        const promoted = owner.cells[1], id = promoted.id;
        Object.assign(promoted, copy(cell), { id, generated: true, vMerge: 'restart', mergeChanged: true }); delete promoted.continuation; delete promoted.continuationStyleId;
        const content = state.byCell.get(cell.id); reparentCellContent(this, content, cell.id, id); state.byCell.set(id, content);
      }
      table.rows.splice(rowIndex, 1);
    }
    else {
      widths.splice(column, span); table.grid = widths.map(Math.round); table.gridChanged = true;
      for (const item of entries) {
        const overlap = Math.max(0, Math.min(item.end, end) - Math.max(item.column, column));
        if (overlap && !ids.has(item.cell.id)) { item.cell.span = item.span - overlap; item.cell.spanChanged = true; }
      }
      table.rows.forEach(r => { r.cells = r.cells.filter(c => !ids.has(c.id)); });
      if (table.layout !== 'autofit') { setCellWidths(table, table.grid); table.width = { type: 'dxa', value: table.grid.reduce((a,b) => a+b, 0) }; table.widthChanged = true; }
    }
    if (kind !== 'table') applyTableContent(this, table, state);
    if (!this.paragraphs.length) this.paragraphs.push(paragraph());
    if (kind === 'table') { repairStructuralBookmarks(this.paragraphs, state.bookmarks, this.tables, table.id); normalizeBlockBookmarkScopes(this.paragraphs, this.tables); }
    this.select(this.paragraphOffset(Math.max(0, Math.min(first, this.paragraphs.length - 1)))); this.didChange(); return true;
  }
  insertTableParagraph(after = true) {
    const context = this.tableContext; if (!context) return false;
    if (documentLength(this.paragraphs) >= MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const content = tableContent(this, context.table);
    const index = content.start + (after ? content.count : 0);
    const parent = cellContext(this.tables, context.table.parentCellId);
    const p = resolveStyledParagraph(paragraph('', parent ? { cellId: parent.cell.id, tableStyleId: parent.table.styleId, tableStyleRegions: parent.cell.styleRegions } : {}), this.styles, this.numbering);
    this.checkpoint(); this.paragraphs.splice(index, 0, p); this.select(this.paragraphOffset(index)); this.didChange(); return true;
  }
  replaceAcrossCells(text, checkpoint, insertedImage) {
    const [start, end] = this.range, groups = []; let at = 0;
    const removedBodyFields=this.hasBodyFields?new Set(bodyFieldRanges(this.paragraphs).filter(r=>start<=r.start&&end>=r.end&&(start<r.start||end>r.end)).map(r=>r.field.id)):undefined;
    // A surrounding selection owns the wrappers it removes, even when the
    // per-cell subrange happens to equal one wrapper's contents exactly.
    const removedPictureControls = this.hasPictureControls ? new Set(contentControlRanges(this.paragraphs).filter(r => r.control.picture && start <= r.start && end >= r.end && (start < r.start || end > r.end)).map(r => r.control.id)) : undefined;
    for (let i = 0; i < this.paragraphs.length;) {
      const cell = this.paragraphs[i].cellId || '', from = at;
      do { at += paragraphLength(this.paragraphs[i]) + 1; i++; } while (i < this.paragraphs.length && (this.paragraphs[i].cellId || '') === cell);
      if (end >= from && start <= at - 1) groups.push([Math.max(start, from), Math.min(end, at - 1)]);
    }
    if (!text && !groups.some(([a,b]) => b > a)) return false;
    if (checkpoint) this.checkpoint();
    for (let i = groups.length - 1; i >= 0; i--) {
      this.selection = { anchor: groups[i][0], focus: groups[i][1] };
      this.replace(i ? '' : text, { checkpoint: false, insertedImage: i ? undefined : insertedImage, removedPictureControls, removedBodyFields });
    }
    this.didChange(); return true;
  }
  snapshot() { return copy({ comments: this.comments, tables: this.tables, styles: this.styles, stylesEnabled: this.stylesEnabled, numbering: this.numbering, pageSettings: this.pageSettings, paragraphs: this.paragraphs, selection: this.selection, typingFormat: this.typingFormat, typingStyle: this.typingStyle, typingDirectCleared: this.typingDirectCleared }); }
  restore(state) {
    this.cellBlock = null;
    if (state.comments !== undefined) this.comments = copy(state.comments);
    this.tables = copy(state.tables || []);
    this.styles = copy(state.styles || emptyStyles()); this.stylesEnabled = !!state.stylesEnabled;
    this.numbering = copy(state.numbering || emptyNumbering());
    this.paragraphs = copy(state.paragraphs);
    this.pageSettings = validatePageSettings(state.pageSettings);
    this.selection = { ...state.selection };
    this.typingFormat = { ...state.typingFormat }; this.typingStyle = copy(state.typingStyle || null); this.typingDirectCleared = !!state.typingDirectCleared;
    this.didChange();
  }
  checkpoint() {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }
  select(anchor, focus = anchor, controlCaret, controlSelection) {
    this.cellBlock = null;
    const text = this.text, points = boundaries(text);
    const clamp = value => {
      const n = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, text.length));
      let low = 0, high = points.length - 1; // The first boundary at or after n.
      while (low < high) { const middle = (low + high) >> 1; if (points[middle] >= n) high = middle; else low = middle + 1; }
      return points[low] >= n ? points[low] : text.length;
    };
    const nextSelection = { anchor: clamp(anchor), focus: clamp(focus) };
    if (controlCaret) {
      if (nextSelection.anchor !== nextSelection.focus || !inlineControlCaret(this.paragraphs, nextSelection.focus, controlCaret)) throw new Error('Invalid inline content-control caret.');
      nextSelection.controlCaret = { id: controlCaret.id, side: controlCaret.side };
    }
    // A zero-length extended selection has distinct control boundary endpoints,
    // even though its text offsets match. Keep its anchor across normalization.
    if (controlSelection) {
      const owner = inlineControlCaret(this.paragraphs, nextSelection.anchor, { id: controlSelection.id, side: 'inside' });
      if (!owner || ![-1, 1].includes(controlSelection.direction)) throw new Error('Invalid inline content-control selection.');
      nextSelection.controlSelection = { id: controlSelection.id, direction: controlSelection.direction };
      if (controlSelection.adjacent !== undefined) {
        const neighbor = inlineControlCaret(this.paragraphs, nextSelection.anchor, { id: controlSelection.adjacent, side: 'inside' });
        if (!neighbor || neighbor.control.id === owner.control.id || neighbor.paragraph !== owner.paragraph ||
          (controlSelection.direction > 0 ? owner.end !== neighbor.start : owner.start !== neighbor.end)) throw new Error('Invalid adjacent content-control selection.');
        nextSelection.controlSelection.adjacent = neighbor.control.id;
      }
      if (controlSelection.focusCaret) {
        const caret = controlSelection.focusCaret;
        if (!inlineControlCaret(this.paragraphs, nextSelection.focus, caret)) throw new Error('Invalid inline content-control selection focus.');
        nextSelection.controlSelection.focusCaret = { id: caret.id, side: caret.side };
      }
    }
    this.selection = nextSelection;
    if(this.hasMacroButtons){
      const [start,end]=macroButtonSelection(bodyFieldRanges(this.paragraphs),...this.range);
      this.selection=anchor<=focus?{anchor:start,focus:end}:{anchor:end,focus:start};
    }
    if(this.hasNoteMarks){const[start,end]=noteMarkSelection(this.paragraphs,...this.range);this.selection=anchor<=focus?{anchor:start,focus:end}:{anchor:end,focus:start};}
    if (controlCaret && this.selection.anchor === nextSelection.anchor && this.selection.focus === nextSelection.focus) this.selection.controlCaret = { id: controlCaret.id, side: controlCaret.side };
    if (controlSelection && this.selection.anchor === nextSelection.anchor && this.selection.focus === nextSelection.focus) this.selection.controlSelection = nextSelection.controlSelection;
    this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false;
  }
  promptBoundary(position, direction) {
    if(this.hasNoteMarks)for(const r of noteMarkRanges(this.paragraphs))if(r.start<position&&position<r.end)return direction<0?r.start:r.end;
    if(this.hasMacroButtons)for(const r of bodyFieldRanges(this.paragraphs))if(r.field.type==='MACROBUTTON'&&r.start<position&&position<r.end)return direction<0?r.start:r.end;
    return position;
  }
  macroButtonAt(position) {
    return this.hasMacroButtons?bodyFieldRanges(this.paragraphs).find(r=>r.field.type==='MACROBUTTON'&&r.start<=position&&position<r.end):undefined;
  }
  formatAt(position = this.selection.focus, affinity = 'backward') {
    const { index, offset } = locate(this.paragraphs, position);
    let at = 0;
    for (const run of this.paragraphs[index].runs) {
      at += run.text.length;
      if (offset < at || offset === at && affinity === 'backward') return { ...run, ...runFormat(run), text: '' };
    }
    const p = this.paragraphs[index];
    return { text: '', ...runFormat(p.markFormat), properties: p.markProperties || '', hasDirectProperties: !!p.markHasDirectProperties, overrides: { ...p.markOverrides }, ...(this.stylesEnabled ? { styleId: p.markStyleId, styleChanged: !!p.markStyleId, styleManaged: true, directFormat: { ...p.styleContext?.mark } } : {}) };
  }
  typingRun(position = this.selection.focus, affinity) {
    affinity ??= position === this.selection.focus && this.selection.controlCaret?.side === 'after' ? 'forward' : 'backward';
    const source = this.formatAt(position, affinity), run = this.typingDirectCleared ? clearedRun(source) : source;
    delete run.image; delete run.contentControl; delete run.positionalTab; delete run.noteMark; delete run.bodySymbol; delete run.noBreakHyphen; delete run.breakClear; delete run.field; delete run.revision; delete run.math;
    // Boundary typing is plain text; strictly interior edits extend the link.
    const link = hyperlinkAt(this.paragraphs, position);
    if (!link || position <= link.start || position >= link.end) delete run.link;
    if (this.typingStyle) { run.styleId = this.typingStyle.id || null; run.styleChanged = true; }
    Object.assign(run, this.typingFormat); run.overrides = { ...run.overrides, ...this.typingFormat };
    if (this.stylesEnabled) {
      const p = this.paragraphs[locate(this.paragraphs, position).index];
      resolveCharacterRun(run, this.styles, paragraphRunStyle(p, this.styles));
    }
    return run;
  }
  get hyperlink() {
    const [start, end] = this.range;
    const found = hyperlinkAt(this.paragraphs, start) || (start === end ? hyperlinkAt(this.paragraphs, start, 'backward') : null);
    return found && end <= found.end ? found : null;
  }
  get bookmarks() { return bookmarkEntries(this.paragraphs, this.tables); }
  /** Comments with their current anchors, in document order; replies follow their parent. */
  get commentList() {
    const comments = this.comments || [], anchors = new Map(commentAnchors(this.paragraphs).map(a => [a.id, a]));
    const roots = comments.filter(c => !c.parentId || !comments.some(p => p.id === c.parentId));
    const position = c => anchors.get(c.id)?.start ?? Infinity;
    roots.sort((a, b) => position(a) - position(b) || Number(a.id) - Number(b.id));
    const list = [];
    for (const root of roots) for (const id of commentThread(comments, root.id)) {
      const c = comments.find(item => item.id === id);
      list.push({ ...c, start: anchors.get(id)?.start ?? anchors.get(root.id)?.start ?? null, end: anchors.get(id)?.end ?? anchors.get(root.id)?.end ?? null, rootId: root.id });
    }
    return list;
  }
  /** A comment made at a caret is anchored to the word around it. */
  commentRange() {
    let [start, end] = this.range;
    if (start !== end) return [start, end];
    // Step by code point and keep combining marks, so astral letters and
    // decomposed or Indic words are anchored whole, never mid-grapheme.
    const text = this.text, word = /^[\p{L}\p{M}\p{N}_'’-]$/u, points = boundaries(text);
    const before = at => /[\uDC00-\uDFFF]/.test(text[at - 1]) && at > 1 ? text.slice(at - 2, at) : text[at - 1];
    const after = at => String.fromCodePoint(text.codePointAt(at));
    let a = start, b = start;
    while (a > 0 && word.test(before(a))) a -= before(a).length;
    while (b < text.length && word.test(after(b))) b += after(b).length;
    return [points.findLast(p => p <= a) ?? 0, points.find(p => p >= b) ?? text.length];
  }
  addComment({ author = '', initials, text = '', date = new Date().toISOString().replace(/\.\d+Z$/, 'Z'), range } = {}) {
    this.comments ||= [];
    const body = checkedCommentText(text), id = nextCommentId(this.comments, this.commentIdFloor);
    const [start, end] = range || this.commentRange();
    this.checkpoint();
    addCommentMarkers(this.paragraphs, id, start, end);
    this.comments.push({ id, author, initials: initials ?? initialsFor(author), date, text: body, done: false, parentId: null, paraId: null });
    this.didChange(); return id;
  }
  replyToComment(parentId, { author = '', initials, text = '', date = new Date().toISOString().replace(/\.\d+Z$/, 'Z') } = {}) {
    const parent = this.comments?.find(c => c.id === parentId);
    if (!parent) throw new Error('That comment no longer exists.');
    const root = parent.parentId && this.comments.some(c => c.id === parent.parentId) ? parent.parentId : parent.id;
    const anchor = commentAnchors(this.paragraphs).find(a => a.id === root);
    const body = checkedCommentText(text), id = nextCommentId(this.comments, this.commentIdFloor);
    this.checkpoint();
    // Each reply is anchored on its parent's range.
    if (anchor) addCommentMarkers(this.paragraphs, id, anchor.start, anchor.end);
    this.comments.push({ id, author, initials: initials ?? initialsFor(author), date, text: body, done: false, parentId: root, paraId: null });
    this.didChange(); return id;
  }
  editComment(id, text) {
    const comment = this.comments?.find(c => c.id === id);
    if (!comment) throw new Error('That comment no longer exists.');
    const body = checkedCommentText(text);
    if (body === comment.text) return false;
    this.checkpoint(); comment.text = body; this.didChange(); return true;
  }
  setCommentDone(id, done = true) {
    const comment = this.comments?.find(c => c.id === id);
    if (!comment) throw new Error('That comment no longer exists.');
    const ids = commentThread(this.comments, comment.parentId || id);
    if (ids.every(cid => this.comments.find(c => c.id === cid).done === !!done)) return false;
    this.checkpoint();
    for (const cid of ids) this.comments.find(c => c.id === cid).done = !!done;
    this.didChange(); return true;
  }
  deleteComment(id) {
    if (!this.comments?.some(c => c.id === id)) return false;
    const ids = commentThread(this.comments, id);
    this.checkpoint();
    removeCommentMarkers(this.paragraphs, ids);
    this.comments = this.comments.filter(c => !ids.includes(c.id));
    this.didChange(); return true;
  }
  deleteAllComments({ resolvedOnly = false } = {}) {
    const ids = (this.comments || []).filter(c => !resolvedOnly || c.done).map(c => c.id);
    if (!ids.length) return false;
    this.checkpoint();
    removeCommentMarkers(this.paragraphs, ids);
    this.comments = this.comments.filter(c => !ids.includes(c.id));
    this.didChange(); return true;
  }
  addBookmark(name) {
    const markers = newBookmarkMarkers(this.paragraphs, name), [start, end] = this.range;
    this.checkpoint();
    for (const [i, position] of [start, end].entries()) { const at = locate(this.paragraphs, position); (this.paragraphs[at.index].bookmarks ||= []).push({ ...markers[i], offset: at.offset }); }
    this.didChange(); return true;
  }
  renameBookmark(id, name) {
    checkedBookmarkName(name);
    const entries = this.bookmarks, entry = entries.find(e => e.id === id);
    if (!entry) throw new Error('That bookmark no longer exists.');
    if (entry.name === name) return false;
    if (entries.some(e => e.name === name)) throw new Error('A bookmark with that name already exists.');
    const active = entries.find(e => e.name === entry.name) === entry, old = entry.name;
    this.checkpoint(); entry.startMarker.name = name;
    if (active) for (const p of this.paragraphs) for (const run of p.runs) if (run.link && !run.link.target && run.link.anchor === old) run.link = { ...run.link, anchor: name };
    if(active&&this.hasBodyFields)renameBodyFieldBookmarks(this.paragraphs,old,name);
    this.didChange(); return true;
  }
  removeBookmark(id) {
    if (!this.bookmarks.some(e => e.id === id)) return false;
    this.checkpoint();
    for (const p of this.paragraphs) if (p.bookmarks) { p.bookmarks = p.bookmarks.filter(m => m.id !== id); if (!p.bookmarks.length) delete p.bookmarks; }
    this.didChange(); return true;
  }
  setHyperlink(target, text) {
    if (this.hasPlainTextControls) checkPlainTextObjects(this.paragraphs, this.range);
    if (this.hasPictureControls) checkPictureControlEdit(this.paragraphs, this.range, true);
    const destination = checkedHyperlinkDestination(target);
    text ??= hyperlinkLabel(destination);
    let [start, end] = this.range;
    const existing = this.hyperlink;
    if (existing && existing.link.target === destination.target && existing.link.anchor === destination.anchor) return false;
    let checkpoint = true;
    if (start === end) {
      if (existing) { start = existing.start; end = existing.end; }
      else {
        if (typeof text !== 'string' || !text || /[\r\n\v\f\u000e]/.test(text)) throw new Error('Enter link text on one line.');
        this.replace(text); end = this.selection.focus; start = boundaries(this.text).filter(p => p <= start).at(-1) ?? 0; checkpoint = false;
      }
    }
    const link = existing ? { ...existing.link, id: hyperlinkId() } : { id: hyperlinkId() };
    delete link.fieldId;
    delete link.target; delete link.anchor; Object.assign(link, destination);
    if (Object.hasOwn(destination, 'anchor')) {
      let offset = 0;
      for (const p of this.paragraphs) {
        for (const run of p.runs) {
          if (offset < end && offset + run.text.length > start && (run.image?.hyperlink || run.image?.hyperlinkChanged)) throw new Error('Drawing hyperlinks to bookmarks are not supported yet.');
          offset += run.text.length;
        }
        offset++;
      }
    }
    if (checkpoint) this.checkpoint();
    this.changeHyperlink(start, end, link); this.didChange();
    return true;
  }
  removeHyperlink() {
    let [start, end] = this.range;
    if (start === end) { const link = this.hyperlink; if (!link) return false; start = link.start; end = link.end; }
    const changed = hyperlinkRanges(this.paragraphs).some(r => r.start < end && r.end > start);
    if (!changed) return false;
    this.checkpoint(); this.changeHyperlink(start, end, null); this.didChange();
    return true;
  }
  changeHyperlink(start, end, link) {
    if(this.hasHyperlinkFields)unwrapEditedFieldHyperlinks(this.paragraphs,bodyFieldRanges(this.paragraphs),start,end);
    let at = 0;
    for (const p of this.paragraphs) {
      const length = paragraphLength(p), a = Math.max(0, start - at), b = Math.min(length, end - at);
      if (b > a) p.runs = normalize([...sliceRuns(p.runs, 0, a), ...sliceRuns(p.runs, a, b).map(r => {
        const next = { ...r };
        if (r.image?.hyperlink || r.image?.hyperlinkChanged) {
          next.image = { ...r.image, hyperlink: link ? { ...link } : null, hyperlinkChanged: true };
          delete next.link;
        } else if (link) next.link = { ...link }; else delete next.link;
        return next;
      }), ...sliceRuns(p.runs, b)]);
      if(b>a&&p.fieldMarkers)p.fieldMarkers=p.fieldMarkers.map(marker=>{
        const selected=marker.type==='start'?a<=marker.offset&&marker.offset<b:a<marker.offset&&marker.offset<=b;
        if(!selected)return marker;
        const next={...marker};if(link)next.link={...link};else delete next.link;return next;
      });
      at += length + 1;
    }
  }
  get characterStyle() {
    const [start, end] = this.textFormattingRange;
    if (start === end) return this.typingStyle?.id ?? this.formatAt().styleId ?? '';
    const ids = []; let at = 0;
    for (const p of this.paragraphs) {
      for (const run of p.runs) {
        if (at < end && at + run.text.length > start) ids.push(run.styleId || '');
        at += run.text.length;
      }
      if (at >= start && at < end) ids.push(p.markStyleId || '');
      at++;
    }
    return ids.every(id => id === ids[0]) ? ids[0] ?? '' : null;
  }
  get characterStyles() {
    return Object.values(this.styles.definitions).filter(s => s.type === 'character').map(s => {
      let error = s.error;
      try { resolveCharacterRun({ styleId: s.id, styleManaged: true }, this.styles, this.styles.defaults.run); } catch (e) { error = e.message; }
      return { id: s.id, name: s.name, error };
    });
  }
  characterStyleState(id, styles = this.styles) {
    if (typeof id !== 'string' || id && styles.definitions[id]?.type !== 'character') throw new Error('Choose a character style.');
    const [start, end] = this.textFormattingRange, location = locate(this.paragraphs, start);
    if (start === end && this.paragraphs[location.index].runs.length) {
      const p = this.paragraphs[location.index], run = { ...this.typingRun(), styleId: id || null, styleChanged: true };
      resolveCharacterRun(run, styles, paragraphRunStyle(p, styles));
      return { paragraphs: this.paragraphs, typingStyle: { id } };
    }
    const paragraphs = copy(this.paragraphs); let at = 0;
    for (const p of paragraphs) {
      const length = paragraphLength(p), a = Math.max(0, start - at), b = Math.min(length, end - at);
      const mark = at + length >= start && at + length < end || start === end && at === start && !length;
      if (a < b) p.runs = normalize([
        ...sliceRuns(p.runs, 0, a),
        ...sliceRuns(p.runs, a, b).map(r => ({ ...r, styleId: id || null, styleChanged: true })),
        ...sliceRuns(p.runs, b),
      ]);
      if (mark) { p.markStyleId = id || null; p.markStyleChanged = true; }
      if (a < b || mark) resolveStyledParagraph(p, styles, this.numbering);
      at += length + 1;
    }
    if (this.hasPlainTextControls) formatPlainTextInputs(paragraphs, [start, end], r => ({ ...r, styleId: id || null, styleChanged: true }));
    return { paragraphs, typingStyle: null };
  }
  setCharacterStyle(id) {
    const next = this.characterStyleState(id);
    if (this.characterStyle === id) return false;
    if (next.paragraphs === this.paragraphs) { this.typingStyle = next.typingStyle; this.stylesEnabled = true; return false; }
    this.checkpoint(); Object.assign(this, next); this.stylesEnabled = true; this.didChange(); return true;
  }
  editCharacterStyle(id, patch) { return this.editNamedStyle(id, patch, 'character'); }
  createCharacterStyle(name, basedOn = this.characterStyle || '') {
    const styles = copy(this.styles); let id = 'CanvasCharacter1', index = 1;
    while (Object.hasOwn(styles.definitions, id)) id = `CanvasCharacter${++index}`;
    styles.definitions[id] = { id, type: 'character', name, basedOn: basedOn || null, properties: {}, reference: {}, run: {}, generated: true };
    styles.definitions[id] = editedStyle(styles, id, { name, basedOn: basedOn || null }, 'character');
    const next = this.characterStyleState(id, styles);
    this.checkpoint(); this.styles = styles; Object.assign(this, next); this.stylesEnabled = true; this.didChange(); return true;
  }
  get runFormatting() { return this.selectedRunFormatting(runFormat); }
  get runCommandFormatting() { return this.selectedRunFormatting(commandRunFormat); }
  selectedRunFormatting(formatRun) {
    const [start, end] = this.textFormattingRange;
    if (start === end) {
      const format = formatRun(this.typingRun());
      return Object.fromEntries(Object.keys(RUN_FORMAT).map(key => [key, format[key]]));
    }
    const formats = [];
    let at = 0;
    for (const p of this.paragraphs) {
      for (const run of p.runs) {
        if (at < end && at + run.text.length > start) formats.push(formatRun(run));
        at += run.text.length;
      }
      if (at >= start && at < end) formats.push(formatRun(p.markFormat));
      at++;
    }
    return Object.fromEntries(Object.keys(RUN_FORMAT).map(k => [k, formats.length && formats.every(f => f[k] === formats[0][k]) ? formats[0][k] : null]));
  }
  get selectedImage() {
    const [start, end] = this.range; if (end !== start + 1) return null;
    const at = locate(this.paragraphs, start); let offset = 0;
    return this.paragraphs[at.index].runs.find(run => { const match = offset === at.offset && !!run.image; offset += run.text.length; return match; })?.image || null;
  }
  moveImage(target) {
    const image = this.selectedImage, [start, end] = this.range;
    if (!image || image.anchor) throw new Error('Select an inline image to move through text.');
    if (!Number.isInteger(target) || target < 0 || target > documentLength(this.paragraphs) || !boundaries(this.text).includes(target)) throw new Error('Invalid image insertion position.');
    if (target >= start && target <= end) return false;
    this.checkpoint();
    this.replace('', { checkpoint: false });
    const position = target > start ? target - 1 : target;
    this.select(position, position);
    this.replace(OBJECT, { checkpoint: false, insertedImage: image });
    this.select(this.selection.focus - 1, this.selection.focus);
    return true;
  }
  arrangeImage(direction) {
    const image=this.selectedImage;
    if(!isPositionedImage(image)) throw new Error('Layer ordering applies to floating images.');
    if(direction==='behind' || direction==='inFront') return this.setImageProperties({anchor:{behind:direction==='behind'}});
    if(!['forward','backward','front','back'].includes(direction)) throw new Error('Unknown image arrangement.');
    const runs=this.paragraphs.flatMap(p=>p.runs).filter(r=>isPositionedImage(r.image) && r.image.anchor.behind===image.anchor.behind);
    runs.sort((a,b)=>a.image.anchor.order-b.image.anchor.order);
    const index=runs.findIndex(r=>r.image===image);
    const target=direction==='front'?runs.length-1:direction==='back'?0:Math.max(0,Math.min(runs.length-1,index+(direction==='forward'?1:-1)));
    if(index===target) return false;
    const [moving]=runs.splice(index,1);runs.splice(target,0,moving);
    // Dense integer ordering avoids overflow and resolves authored equal-height ties.
    this.checkpoint();
    runs.forEach((run,i)=>{const order=i+1;if(run.image.anchor.order!==order)run.image={...run.image,anchor:{...run.image.anchor,order},anchorChanged:true};});
    this.didChange();return true;
  }
  insertImage(assetId, properties) {
    if (this.hasPlainTextControls) checkPlainTextObjects(this.paragraphs, this.range);
    if (!this.assets[assetId]) throw new Error('The image asset is missing.');
    const typing = this.typingRun(this.range[0], this.range[0] === this.range[1] ? 'backward' : 'forward');
    if (typing.textScale !== 100) throw new Error('Set text width to 100% before inserting an inline picture.');
    const ids = this.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image.id));
    const id = Math.max(0, ...ids) + 1; if (id > 4294967295) throw new Error('This document has exhausted its drawing IDs.');
    const image = validateImage({ assetId, id, name: `Picture ${id}`, alt: '', ...properties });
    this.replace(OBJECT, { insertedImage: image });
    // A placeholder expands replacement to its entire prompt. Use the actual
    // inserted object's offset, rather than the original interior caret.
    const start = this.selection.focus - 1;
    this.select(start, start + 1); return true;
  }
  setImageProperties(patch) {
    const image = this.selectedImage; if (!image) throw new Error('Select one image to edit its properties.');
    if (Object.keys(patch).some(k => !['width', 'height', 'alt', 'crop', 'flipH', 'flipV', 'rotation', 'anchor'].includes(k))) throw new Error('Unknown image property.');
    if (patch.anchor) {
      if (!isPositionedImage(image)) throw new Error('This image is inline. Move it to another text position instead.');
      if (Object.keys(patch.anchor).some(k => !['x', 'y', 'behind', 'order'].includes(k))) throw new Error('Unknown image position property.');
      for (const key of ['x', 'y']) if (Object.hasOwn(patch.anchor, key) && (!Number.isInteger(patch.anchor[key]) || Math.abs(patch.anchor[key]) > 20116800)) throw new Error('Image offsets must be within 22 inches.');
      if (Object.hasOwn(patch.anchor, 'order') && (!Number.isInteger(patch.anchor.order) || patch.anchor.order < 0 || patch.anchor.order > 4294967295)) throw new Error('Invalid image stacking order.');
      if (Object.hasOwn(patch.anchor, 'behind') && typeof patch.anchor.behind !== 'boolean') throw new Error('Invalid image layer.');
    }
    if (Object.hasOwn(patch, 'rotation') && !Number.isInteger(patch.rotation)) throw new Error('Image rotation must use integer 1/60,000 degree units.');
    if (typeof patch.alt === 'string') patch = { ...patch, alt: xmlAttributeText(patch.alt) };
    if (image.retainedDrawing && Object.entries(patch).some(([k, v]) => k !== 'anchor' && JSON.stringify(v) !== JSON.stringify(image[k] ?? ({ flipH: false, flipV: false, rotation: 0 }[k])))) throw new Error('Grouped and alternate drawings are retained as complete objects. Their internal properties cannot be edited yet.');
    const next = { ...image, ...patch };
    if (patch.anchor) {
      next.anchor = { ...image.anchor, ...patch.anchor };
      for (const axis of ['x', 'y']) if (Object.hasOwn(patch.anchor, axis)) { delete next.anchor[axis + 'Align']; delete next.anchor[axis + 'Percentage']; }
    }
    const geometryChanged = ['width', 'height'].some(key => next[key] !== image[key]) || normalizedRotation(next.rotation) !== normalizedRotation(image.rotation);
    if (geometryChanged) {
      const oldRequired = rotationOutsets(image), nextRequired = rotationOutsets(next), oldExtent = imageExtents(image);
      next.effectExtent = Object.fromEntries(CROP_SIDES.map(side => [side, nextRequired[side] + Math.max(0, oldExtent[side] - oldRequired[side])]));
    }
    validateImage(next);
    if (Object.hasOwn(patch, 'rotation')) next.rotation = normalizedRotation(patch.rotation);
    if (Object.hasOwn(patch, 'crop')) next.crop = normalizeCrop(patch.crop);
    if (image.aspectLocked && Math.abs(next.width * image.height / image.width - next.height) > 1) throw new Error('This image locks its aspect ratio. Resize it with its proportions preserved.');
    const oldCrop = normalizeCrop(image.crop), nextCrop = normalizeCrop(next.crop), cropChanged = CROP_SIDES.some(k => oldCrop[k] !== nextCrop[k]);
    const flipChanges = Object.fromEntries(['flipH', 'flipV'].map(k => [`${k}Changed`, !!image[k] !== !!next[k]]));
    const rotationChanged = normalizedRotation(image.rotation) !== normalizedRotation(next.rotation);
    const anchorChanged = JSON.stringify(next.anchor) !== JSON.stringify(image.anchor);
    if (!anchorChanged && !cropChanged && !rotationChanged && !Object.values(flipChanges).some(Boolean) && ['width', 'height', 'alt'].every(k => image[k] === next[k])) return false;
    this.checkpoint();
    const updated = { ...next, sizeChanged: image.sizeChanged || next.width !== image.width || next.height !== image.height, altChanged: image.altChanged || next.alt !== image.alt, cropChanged: image.cropChanged || cropChanged };
    for (const key of Object.keys(flipChanges)) updated[key] = image[key] || flipChanges[key];
    updated.rotationChanged = image.rotationChanged || rotationChanged;
    updated.extentChanged = image.extentChanged || geometryChanged;
    updated.anchorChanged = image.anchorChanged || anchorChanged;
    for (const p of this.paragraphs) for (const run of p.runs) if (run.image === image) run.image = updated;
    this.didChange(); return true;
  }
  replaceDrawingText(expected, assetId, shell) {
    const image = this.selectedImage;
    if (image !== expected || !image?.retainedDrawing || !this.assets[assetId]?.scene || typeof shell !== 'string' || !shell) throw new Error('The selected drawing changed before its text could be applied.');
    this.checkpoint();
    for (const p of this.paragraphs) for (const run of p.runs) if (run.image === image) run.image = { ...image, assetId, shell };
    this.didChange(); return true;
  }
  get bold() { return this.runFormatting.bold === true; }
  get italic() { return this.runFormatting.italic === true; }
  get underline() { return this.runFormatting.underline === true; }
  clearDirectTextFormatting() {
    const [start, end] = this.textFormattingRange, location = locate(this.paragraphs, start);
    if (start === end && this.paragraphs[location.index].runs.length) {
      const p = this.paragraphs[location.index], next = clearedRun(this.typingRun());
      if (this.stylesEnabled) resolveCharacterRun(next, this.styles, paragraphRunStyle(p, this.styles));
      this.typingDirectCleared = true; this.typingFormat = {}; return false;
    }
    let at = 0, changed = false;
    const paragraphs = this.paragraphs.map(p => {
      const length = paragraphLength(p), a = Math.max(0, start - at), b = Math.min(length, end - at);
      const mark = at + length >= start && at + length < end || start === end && at === start && !length;
      at += length + 1;
      const runs = a < b ? sliceRuns(p.runs, a, b) : [];
      const clearRuns = runs.some(hasDirectRunFormatting), clearParagraphMark = mark && hasDirectMarkFormatting(p);
      if (!clearRuns && !clearParagraphMark) return p;
      const next = { ...p, runs: clearRuns ? normalize([...sliceRuns(p.runs, 0, a), ...runs.map(r => hasDirectRunFormatting(r) ? clearedRun(r) : r), ...sliceRuns(p.runs, b)]) : p.runs.map(r => ({ ...r })) };
      if (clearParagraphMark) clearMark(next);
      if (this.stylesEnabled) resolveStyledParagraph(next, this.styles, this.numbering);
      changed = true; return next;
    });
    if (!changed) return false;
    this.checkpoint(); this.paragraphs = paragraphs; this.typingFormat = {}; this.typingDirectCleared = false;
    if (this.hasPlainTextControls) formatPlainTextInputs(this.paragraphs, [start, end], clearedRun);
    this.didChange(); return true;
  }
  setFontSize(fontSize) { return this.setRunFormat({ fontSize, fontSizeCs: fontSize }); }
  setRunFormat(patch) {
    const pass = this.blockCellPass(() => this.setRunFormat(patch));
    if (pass !== undefined) return pass;
    if (patch.cs || patch.rtl) throw new Error('Active complex-script and RTL editing is not supported yet.');
    const legacyUnderline = 'underline' in patch && !('underlineStyle' in patch);
    patch = { ...underlineDeclaration(patch) };
    if (legacyUnderline && !('underlineColor' in patch)) patch.underlineColor = 'auto';
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(RUN_FORMAT, key)) throw new Error('Unknown text property.');
      if (Object.hasOwn(FONT_DEFAULTS, key)) patch[key] = checkedFontEdit(key, value);
      else if (key === 'fontSize' || key === 'fontSizeCs') {
        if (!validFontSize(value)) throw new Error('Font size must be 1–1638 pt in half-point steps.');
      } else if (key === 'textFill') {
        if (value === null) throw new Error('Use Clear Formatting to remove a text fill declaration.');
        patch[key] = checkedTextFill(value);
      } else if (key === 'textShadow') patch[key] = checkedTextShadow(value);
      else if (key === 'textOutline') patch[key] = checkedTextOutline(value);
      else if (key === 'text3d' || key === 'textScene') patch[key] = checkedText3d(value, key);
      else if (key === 'highlight') patch[key] = checkedHighlight(value);
      else if (key === 'underlineStyle') patch[key] = checkedUnderline(value);
      else if (key === 'capitalization') patch[key] = checkedCapitalization(value);
      else if (key === 'strikethrough') patch[key] = checkedStrike(value);
      else if (key === 'ligatures') patch[key] = checkedLigatures(value);
      else if (key === 'kerning') patch[key] = checkedKerning(value);
      else if (key === 'textScale') patch[key] = checkedTextScale(value);
      else if (key === 'characterSpacing') patch[key] = checkedCharacterSpacing(value);
      else if (key === 'baselineShift') patch[key] = checkedBaselineShift(value);
      else if (key === 'verticalAlign') patch[key] = checkedVerticalAlign(value);
      else if (key === 'shading') patch[key] = checkedShading(value);
      else if (['color', 'underlineColor'].includes(key)) patch[key] = normalizeColor(value);
      else if (typeof value !== 'boolean') throw new Error('Text formatting must be on or off.');
    }
    if (!Object.keys(patch).length || Object.entries(patch).every(([k, v]) => this.runFormatting[k] === v)) return false;
    const [start, end] = this.textFormattingRange;
    if (patch.textScale && patch.textScale !== 100 && start !== end) {
      let offset = 0;
      for (const p of this.paragraphs) {
        for (const run of p.runs) {
          if (run.image && offset < end && offset + run.text.length > start) throw new Error('Text width scaling on inline pictures is not supported.');
          offset += run.text.length;
        }
        offset++;
      }
    }
    if (start !== end && ('capitalization' in patch || 'characterSpacing' in patch)) {
      let at = 0;
      for (const p of this.paragraphs) {
        for (const run of p.runs) {
          if (at < end && at + run.text.length > start) checkCapitalizationText(run.text.slice(Math.max(0, start - at), Math.min(run.text.length, end - at)), { ...run, ...patch });
          at += run.text.length;
        }
        at++;
      }
    }
    if (start === end && this.paragraphs[locate(this.paragraphs, start).index].runs.length) {
      this.typingFormat = { ...this.typingFormat, ...patch };
      return false;
    }
    this.checkpoint();
    let at = 0;
    for (const p of this.paragraphs) {
      const length = paragraphLength(p);
      const a = Math.max(0, start - at), b = Math.min(length, end - at);
      if (a < b) p.runs = normalize([
        ...sliceRuns(p.runs, 0, a),
        ...sliceRuns(p.runs, a, b).map(r => ({ ...r, ...patch, overrides: { ...r.overrides, ...patch } })),
        ...sliceRuns(p.runs, b),
      ]);
      // Direct formatting applies to the mark when all paragraph text is
      // selected, even when the selection stops immediately before that mark.
      // A trailing partial selection must not change subsequent Enter typing.
      if (at + length >= start && at + length < end || start === end && at === start && !length || length > 0 && a === 0 && b === length) {
        p.markFormat = { ...runFormat(p.markFormat), ...patch };
        p.markOverrides = { ...p.markOverrides, ...patch };
      }
      at += length + 1;
    }
    if (this.hasPlainTextControls) formatPlainTextInputs(this.paragraphs, [start, end], r => ({ ...r, ...patch, overrides: { ...r.overrides, ...patch } }));
    this.didChange();
    return true;
  }
  findMatches(query, options) {
    // Advanced options (special characters, wildcards, formatting) use the advanced matcher.
    if (options?.advanced) return advancedFind(this.paragraphs, query, options, { styles: this.styles, numbering: this.numbering });
    return findText(this.paragraphs, query, options);
  }
  replaceMatches(query, text, options = {}, all = false) {
    if (options.advanced) {
      const [start, end] = this.range;
      const matches = this.findMatches(query, options).filter(m => all || m.start === start && m.end === end);
      return replaceAdvanced(this, matches, text, { wildcards: !!options.wildcards, format: options.replaceFormat || null });
    }
    checkedSearchText(text);
    const [start, end] = this.range;
    const promptFields=this.hasMacroButtons?bodyFieldRanges(this.paragraphs):null;
    let matches = this.findMatches(query, options).filter(m => {
      let range=promptFields?macroButtonSelection(promptFields,m.start,m.end):[m.start,m.end];
      if(this.hasNoteMarks)range=noteMarkSelection(this.paragraphs,...range);
      return (all||range[0]===start&&range[1]===end)&&m.text!==text;
    });
    if(this.hasMacroButtons||this.hasNoteMarks){
      const fields=promptFields, expanded=[],documentText=this.text;
      for(const m of matches){
        let range=fields?macroButtonSelection(fields,m.start,m.end):[m.start,m.end];
        if(this.hasNoteMarks)range=noteMarkSelection(this.paragraphs,...range);
        const [a,b]=range,previous=expanded.at(-1);
        if(previous&&a<previous.end){previous.end=Math.max(previous.end,b);previous.text=documentText.slice(previous.start,previous.end);continue;}
        expanded.push({...m,start:a,end:b,offset:m.offset+a-m.start,text:documentText.slice(a,b)});
      }
      matches=expanded;
    }
    if (!matches.length) return 0;
    if (this.trackChanges && !this.trackingInternal) return this.trackedReplaceMatches(matches, text);
    const persistentRanges = this.hasPersistentControls ? contentControlRanges(this.paragraphs).filter(r => r.control.persistent) : [];
    const updatedControls = new Map();
    for (const m of matches) {
      const r = persistentRanges.find(r => r.start <= m.start && m.end <= r.end); if (!r) continue;
      if (r.control.placeholder && m.start === r.start && m.end === r.end) m.discardedControl = r.control.id;
      const restoring = !text && m.start === r.start && m.end === r.end;
      if (!updatedControls.has(r.control.id)) updatedControls.set(r.control.id, { ...copy(r.control), placeholder: restoring });
      m.control = updatedControls.get(r.control.id);
      if (restoring) {
        m.replacementRuns = (m.control.placeholderRuns || [{ ...copy(m.control.inputRun), text: '     ' }]).map(run => ({ ...copy(run), contentControl: m.control }));
        m.insertedLength = m.replacementRuns.reduce((n,r) => n + r.text.length, 0);
      }
    }
    const updatedBlocks = new Map();
    const blockEdits = new Map();
    if (this.hasPersistentBlockControls) for (const match of matches) for (const control of this.paragraphs[match.paragraph].blockControls || []) if (control.persistent) {
      if (!blockEdits.has(control.id)) blockEdits.set(control.id, []);
      blockEdits.get(control.id).push(match);
    }
    if (this.hasPersistentBlockControls) for (const group of blockControlGroups(this.paragraphs).filter(g => g.control.persistent)) {
      const edits = blockEdits.get(group.control.id) || [];
      if (!edits.length) continue;
      if (group.control.placeholder && edits.length === 1 && edits[0].start === group.start && edits[0].end === group.end) edits[0].discardBlockPlaceholder = true;
      const restoring = !text && edits.length === 1 && !edits[0].control && edits[0].start === group.start && edits[0].end === group.end;
      const control = { ...copy(group.control), placeholder: restoring };
      updatedBlocks.set(control.id, control);
      if (restoring) {
        edits[0].blockPrompt = control;
        edits[0].insertedLength = blockPrompt(control).map(runs => runs.map(r => r.text).join('')).join('\n').length;
      }
    }
    if (documentLength(this.paragraphs) + matches.reduce((n, m) => n + (m.insertedLength ?? text.length) - m.text.length, 0) > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const byParagraph = new Map();
    for (const m of matches) { if (!byParagraph.has(m.paragraph)) byParagraph.set(m.paragraph, []); byParagraph.get(m.paragraph).push(m); }
    let paragraphs = this.paragraphs.flatMap((p, index) => {
      const edits = byParagraph.get(index); if (!edits) return p;
      if (edits[0].blockPrompt) {
        const restored = restoredBlockParagraphs(p, edits[0].blockPrompt);
        replaceBookmarkMarkers([p], restored, 0, paragraphLength(p), edits[0].insertedLength);
        if (this.stylesEnabled) for (const item of restored) resolveStyledParagraph(item, this.styles, this.numbering);
        return restored;
      }
      const next = { ...p, runs: normalize(replacedRuns(p.runs, edits, text)) };
      if (p.bookmarks) next.bookmarks = replacedBookmarks(p, edits, text.length);
      for (const run of next.runs) checkCapitalizationText(run.text, run);
      for (const change of hyperlinkBoundaryChanges(next.runs)) next.runs = normalize([...sliceRuns(next.runs, 0, change.start), ...sliceRuns(next.runs, change.start, change.end).map(r => { const run = { ...r }; if (change.link) run.link = { ...change.link }; else delete run.link; return run; }), ...sliceRuns(next.runs, change.end)]);
      if (this.stylesEnabled) resolveStyledParagraph(next, this.styles, this.numbering);
      return next;
    });
    if (updatedBlocks.size) {
      for (let i=0;i<paragraphs.length;i++) if (paragraphs[i].blockControls?.some(c => updatedBlocks.has(c.id))) paragraphs[i] = { ...paragraphs[i], blockControls: paragraphs[i].blockControls.map(c => updatedBlocks.get(c.id) || c) };
      for (const group of blockControlGroups(paragraphs)) if (updatedBlocks.has(group.control.id)) group.control.signature = blockControlSignature(group.paragraphs,group.control);
    }
    paragraphs = restorePlaceholderBookmarks(paragraphs, [...updatedControls.values(), ...updatedBlocks.values()]);
    if(this.hasBodyFields){
      let fields=bodyFieldRanges(this.paragraphs);
      for(const m of [...matches].sort((a,b)=>b.start-a.start))fields=replacedBodyFields(fields,m.start,m.end,m.insertedLength??text.length,!!m.discardBlockPlaceholder||!!m.discardedControl);
      paragraphs=placeBodyFields(paragraphs,fields);
    }
    bookmarkEntries(paragraphs, this.tables);
    if (persistentRanges.length) validatePersistentControls(paragraphs);
    const preservedBlockControls = this.hasBlockControls ? inlineEditAncestors(this.paragraphs, matches) : undefined;
    this.checkpoint(); this.paragraphs = paragraphs;
    this.select(matches[0].start + (matches[0].insertedLength ?? text.length)); this.didChange(preservedBlockControls); return matches.length;
  }
  // With Track Changes on, each replacement is an ordinary tracked edit, so
  // the found text is marked deleted and the replacement inserted. One step.
  trackedReplaceMatches(matches, text) {
    // Replacing text that is already marked deleted can change nothing; keep history exact then.
    const before = this.snapshot(); let count = 0;
    for (const m of [...matches].reverse()) {
      this.selection = { anchor: m.start, focus: m.end };
      this.typingFormat = {}; this.typingStyle = null; this.typingDirectCleared = false;
      if (this.replace(text, { checkpoint: false })) count++;
    }
    if (!count) { this.selection = before.selection; return 0; }
    this.history.push(before);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.selection = { anchor: this.selection.focus, focus: this.selection.focus };
    this.didChange(); return count;
  }
  leaveEmptyControl(side, destination) {
    const caret = this.selection.controlCaret;
    const range = caret?.side === 'inside' && inlineControlCaret(this.paragraphs, this.selection.focus, caret);
    if (!['before', 'after'].includes(side) || this.selection.anchor !== this.selection.focus || !range || range.start !== range.end) throw new Error('The caret is not inside an empty inline control.');
    if (destination !== undefined && (!Number.isInteger(destination) || destination < 0 || destination > documentLength(this.paragraphs) ||
      (side === 'before' ? destination > range.start : destination < range.end))) throw new Error('Invalid empty-control exit destination.');
    this.replace('', { restoreEmptyControl: true });
    const position = destination === undefined ? (side === 'before' ? range.start : this.selection.focus)
      : destination + (side === 'after' ? this.selection.focus - range.end : 0);
    this.select(position, position, destination === undefined || destination === range.start ? { id: caret.id, side } : undefined);
    return true;
  }
  /** Replace the selection; with Track Changes on, deletions are marked and insertions recorded. */
  replace(text, options = {}) {
    if (this.trackChanges && !this.trackingInternal) return this.trackedReplace(text, options);
    const [start, end] = this.range, length = documentLength(this.paragraphs);
    const result = this.replaceUntracked(text, options);
    // Untracked text never inherits a neighbour's revision. Measure what was actually
    // inserted: line endings are normalized and placeholders can change the span.
    const inserted = documentLength(this.paragraphs) - length + (end - start);
    if (result && inserted > 0) clearRevisions(this.paragraphs, start, start + inserted);
    return result;
  }
  newRevision(type) { return { type, author: this.revisionAuthor || 'Author', date: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }; }
  trackedReplace(text, { checkpoint = true, ...rest } = {}) {
    const [start, end] = this.range, backward = this.selection.focus < this.selection.anchor;
    if (checkpoint) this.checkpoint();
    // Inserting text always changes the document. Only a pure deletion can be a
    // no-op (text already marked deleted), and it can only touch the selected paragraphs.
    const span = () => this.paragraphs.length + JSON.stringify(this.paragraphs.slice(locate(this.paragraphs, start).index, locate(this.paragraphs, end).index + 1));
    const before = text ? null : span();
    this.trackingInternal = true;
    let caret, deletionRevision = null;
    try {
      let removed = 0;
      if (start < end) {
        // The author's own pending insertions simply disappear; other text is marked
        // deleted (another reviewer's insertion keeps its insertion beneath the deletion).
        const me = this.revisionAuthor || 'Author';
        const removals = revisionRanges(this.paragraphs).filter(r => r.type === 'ins' && r.author === me && r.start < end && r.end > start)
          .map(r => [Math.max(start, r.start), Math.min(end, r.end)]);
        const deletion = deletionRevision = this.newRevision('del');
        // A paragraph mark that ends a table cell (or sits before or after a table) cannot be deleted.
        const boundaries = new Set(this.paragraphs.filter((p, i) => (p.cellId || '') !== (this.paragraphs[i + 1]?.cellId || '')).map(p => p.id));
        const mark = revision => !revision ? { ...deletion } : revision.type === 'ins' && revision.author !== me ? { ...deletion, inserted: { author: revision.author, date: revision.date } } : revision;
        eachRevisionTarget(this.paragraphs, start, end, ({ paragraph, run, mark: isMark }) => {
          if (isMark) { if (!boundaries.has(paragraph.id)) paragraph.markRevision = mark(paragraph.markRevision); }
          else run.revision = mark(run.revision);
        });
        for (const [a, b] of removals.reverse()) {
          this.selection = { anchor: a, focus: b };
          this.replaceUntracked('', { checkpoint: false });
          removed += b - a;
        }
      }
      const insertAt = end - removed;
      if (text) {
        this.selection = { anchor: insertAt, focus: insertAt };
        // Typing that continues the author's own insertion from moments ago extends it, so one burst of
        // typing is one change even when it crosses a clock second.
        const me = this.revisionAuthor || 'Author', now = Date.now();
        const continued = revisionRanges(this.paragraphs).find(r => r.type === 'ins' && !r.move && r.author === me && r.end === insertAt && now - Date.parse(r.date) < 60000);
        const length = documentLength(this.paragraphs);
        this.replaceUntracked(text, { ...rest, checkpoint: false });
        const inserted = documentLength(this.paragraphs) - length, insertion = this.newRevision('ins');
        // Text deleted by this author and put back elsewhere is a move (§17.13.5.21/.25).
        const moved = this.trackMoves !== false && this.lastTrackedDeletion?.text === text && /\p{L}/u.test(text) && text.trim().length >= 3 ? this.lastTrackedDeletion : null;
        if (moved) {
          const name = `move${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          const source = revisionRanges(this.paragraphs).find(r => r.type === 'del' && !r.move && r.author === moved.author && r.date === moved.date && documentText(this.paragraphs).slice(r.start, r.end) === text);
          if (source) {
            eachRevisionTarget(this.paragraphs, source.start, source.end, ({ paragraph, run, mark }) => { const target = mark ? paragraph : run, key = mark ? 'markRevision' : 'revision'; if (target[key]?.type === 'del') target[key] = { ...target[key], move: true, moveName: name }; });
            Object.assign(insertion, { move: true, moveName: name });
          }
        }
        if (continued && !insertion.move) insertion.date = continued.date;
        eachRevisionTarget(this.paragraphs, insertAt, insertAt + inserted, ({ paragraph, run, mark }) => {
          if (mark) paragraph.markRevision = { ...insertion }; else { run.revision = { ...insertion }; delete run.formatRevision; }
        });
        this.lastTrackedDeletion = null;
        caret = insertAt + inserted;
      } else caret = backward ? start : insertAt;
      if (!text && deletionRevision) this.lastTrackedDeletion = { text: documentText(this.paragraphs).slice(start, end - removed), author: deletionRevision.author, date: deletionRevision.date };
    } finally { this.trackingInternal = false; }
    if (before !== null && span() === before) {
      if (checkpoint) this.history.pop();
      this.selection = { anchor: caret, focus: caret };
      return false;
    }
    // Inserted text can join the character after it (a regional indicator completing a flag): the caret
    // goes after the whole character, as an untracked insertion leaves it, never inside it.
    caret = nextBoundary(this.paragraphs, caret);
    this.selection = { anchor: caret, focus: caret };
    this.didChange();
    return true;
  }
  /** Insert a page field (PAGE, NUMPAGES…) as one object character at the caret, in header/footer stories. */
  insertFieldRun(field) {
    const [start, end] = this.range;
    if (start !== end) { this.checkpoint(); this.replaceUntracked('', { checkpoint: false }); }
    else this.checkpoint();
    const at = this.range[0], location = locate(this.paragraphs, at), p = this.paragraphs[location.index];
    const run = { ...this.typingRun(at), text: OBJECT, field: { ...field }, overrides: {} };
    delete run.styleChanged; delete run.revision;
    p.runs = normalize([...sliceRuns(p.runs, 0, location.offset), run, ...sliceRuns(p.runs, location.offset)]);
    for (const marker of [...(p.bookmarks || []), ...(p.fieldMarkers || [])]) if (marker.offset > location.offset) marker.offset++;
    this.selection = { anchor: at + 1, focus: at + 1 };
    this.didChange(); return true;
  }
  /** Insert an Office Math object ({ xml, text }) as one object character at the caret, replacing a selection. */
  insertMathRun(math) {
    if (!math?.xml || typeof math.text !== 'string') throw new Error('An equation needs its Office Math XML.');
    const [start, end] = this.range;
    this.checkpoint();
    // A replaced selection is an ordinary deletion: with Track Changes on it
    // stays as deleted text, and the equation follows it.
    if (start !== end) { this.selection = { anchor: start, focus: end }; this.replace('', { checkpoint: false }); }
    const at = this.range[0], location = locate(this.paragraphs, at), p = this.paragraphs[location.index];
    const run = { text: OBJECT, math: { xml: math.xml, text: math.text }, styleId: null, directFormat: {}, hasDirectProperties: false, styleManaged: true, properties: '', overrides: {} };
    p.runs = normalize([...sliceRuns(p.runs, 0, location.offset), run, ...sliceRuns(p.runs, location.offset)]);
    for (const marker of [...(p.bookmarks || []), ...(p.fieldMarkers || [])]) if (marker.offset > location.offset) marker.offset++;
    this.selection = { anchor: at + 1, focus: at + 1 };
    this.didChange(); return true;
  }
  /** Insert a footnote (or endnote) reference mark for note `id` at the caret (after any selection); `custom` marks follow as text. */
  insertFootnoteReference(id, kind = 'footnote', { custom = false } = {}) {
    this.checkpoint();
    const at = this.range[1], location = locate(this.paragraphs, at), p = this.paragraphs[location.index];
    const run = footnoteReferenceRun(this.typingRun(at), id, kind);
    if (custom) run.noteMark.custom = true;
    p.runs = normalize([...sliceRuns(p.runs, 0, location.offset), run, ...sliceRuns(p.runs, location.offset)]);
    for (const marker of [...(p.bookmarks || []), ...(p.fieldMarkers || [])]) if (marker.offset > location.offset || marker.offset === location.offset && marker.edge === 'end' && marker.comment) marker.offset++;
    this.hasNoteMarks = true;
    this.selection = { anchor: at + 1, focus: at + 1 };
    this.didChange(); return true;
  }
  /** Tracked changes overlapping [start, end]; a caret finds the change around it. */
  revisionsAt(start = this.range[0], end = this.range[1]) {
    return revisionRanges(this.paragraphs).filter(r => start === end ? r.start <= start && start <= r.end : r.start < end && r.end > start);
  }
  get revisions() { return revisionRanges(this.paragraphs); }
  /** Accept or reject the changes overlapping [start, end] (the whole document by default). */
  resolveRevisions(accept, start = 0, end = documentLength(this.paragraphs) + 1) {
    this.formatRejectSkipped = false;
    // Resolving changes is not itself a tracked formatting change.
    this.formatTrackingSuppressed = true;
    const targets = (start === end ? this.revisionsAt(start, end) : revisionRanges(this.paragraphs).filter(r => r.start < end && r.end > start))
      .map(r => ({ ...r, start: start === end ? r.start : Math.max(start, r.start), end: start === end ? r.end : Math.min(end, r.end) }));
    if (!targets.length) return false;
    this.checkpoint();
    this.trackingInternal = true;
    const caret = targets[0].start;
    try {
      for (const r of targets.reverse()) {
        if (r.type === 'format') {
          // Rejecting re-applies the recorded former formatting; a change recorded without it is kept.
          const resolve = (target, kind) => { if (accept) acceptFormatChange(target, kind); else if (!rejectFormatChange(target)) this.formatRejectSkipped = true; else if (kind === 'run') acceptFormatChange(target, 'run'); };
          let at = 0;
          for (const p of this.paragraphs) {
            const size = p.runs.reduce((n, run) => n + run.text.length, 0);
            if (at + size + 1 > r.start && at < r.end) {
              let touched = false;
              if (paragraphFormatChange(p) && at >= r.start && at + size + 1 <= r.end + 1) { resolve(p, 'paragraph'); touched = true; }
              eachRevisionTarget(this.paragraphs, Math.max(r.start, at), Math.min(r.end, at + size), ({ run, mark }) => { if (!mark && runFormatChange(run)) { resolve(run, 'run'); touched = true; } });
              if (touched && !accept && this.stylesEnabled) resolveStyledParagraph(p, this.styles, this.numbering);
            }
            at += size + 1;
            if (at > r.end) break;
          }
          continue;
        }
        const keep = r.type === 'ins' ? accept : !accept;
        // Rejecting a deletion of another reviewer's insertion restores that insertion.
        const kept = revision => revision?.inserted && !accept ? { type: 'ins', ...revision.inserted } : undefined;
        if (keep) eachRevisionTarget(this.paragraphs, r.start, r.end, ({ paragraph, run, mark }) => {
          const target = mark ? paragraph : run, key = mark ? 'markRevision' : 'revision', next = kept(target[key]);
          if (next) target[key] = next; else delete target[key];
        });
        else {
          // A removed paragraph mark merges its paragraph with the next one.
          const limit = documentLength(this.paragraphs);
          this.selection = { anchor: r.start, focus: Math.min(r.end, limit) };
          if (r.end > limit) for (const p of this.paragraphs.slice(-1)) delete p.markRevision;
          if (r.start < Math.min(r.end, limit)) this.replaceUntracked('', { checkpoint: false });
        }
      }
    } finally { this.trackingInternal = false; }
    for (const p of this.paragraphs) p.runs = normalize(p.runs);
    // Removing a change can join the characters on either side of the caret into one.
    const at = nextBoundary(this.paragraphs, Math.min(caret, documentLength(this.paragraphs)));
    this.selection = { anchor: at, focus: at };
    this.didChange(); return true;
  }
  replaceUntracked(text, { checkpoint = true, insertedImage, removedPictureControls, removedBodyFields, restoreEmptyControl = false, emptyInlineControl = false } = {}) {
    // Internal \v/\f/\u000e stand for manual line/page/column breaks; the DOCX codec writes elements, never XML control characters.
    text = String(text).replace(/\r\n?/g, '\n').replace(/[^\u0009-\u000C\u000e\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\ufffd');
    let [start, end] = this.range;
    if (start === end && !text && !restoreEmptyControl) return false;
    if(this.hasMacroButtons)[start,end]=macroButtonSelection(bodyFieldRanges(this.paragraphs),start,end);
    if(this.hasNoteMarks)[start,end]=noteMarkSelection(this.paragraphs,start,end);
    const picture = this.hasPictureControls && insertedImage ? selectedPictureControl(this.paragraphs, [start, end], removedPictureControls) : undefined;
    if (this.hasPictureControls && !picture) checkPictureControlEdit(this.paragraphs, [start, end], false, removedPictureControls);
    // Insertion adds before ordinary contents, but replaces a picture
    // placeholder. Keep the original selection until checkpoint for exact undo.
    if (picture) {
      if (picture.control.placeholder) { start = picture.start; end = picture.end; }
      else end = start;
    }
    const controlCaret = start === end ? this.selection.controlCaret : undefined;
    const explicitControl = controlCaret ? inlineControlCaret(this.paragraphs, start, controlCaret) : undefined;
    if (controlCaret && !explicitControl) throw new Error('Invalid inline content-control caret.');
    if (restoreEmptyControl && (text || !explicitControl || controlCaret.side !== 'inside' || explicitControl.start !== explicitControl.end)) throw new Error('Only an empty inline control can restore its prompt on navigation.');
    const outsideControl = controlCaret && controlCaret.side !== 'inside';
    const placeholder = text && (outsideControl ? undefined : explicitControl ? explicitControl.control.placeholder && explicitControl : this.placeholderAt(start));
    // Typing in placeholder contents replaces the prompt. Explicit surrounding
    // selections still replace exactly the selected document text.
    const replacingPlaceholder = placeholder && end <= placeholder.end;
    if (replacingPlaceholder) { start = placeholder.start; end = placeholder.end; }
    const selectionAnchor = this.selection.controlSelection && start < end
      ? inlineControlCaret(this.paragraphs, this.selection.anchor, { id: this.selection.controlSelection.id, side: 'inside' }) : undefined;
    const selectionOwner = start === this.selection.anchor ? selectionAnchor : undefined;
    const focusCaret = this.selection.controlSelection?.focusCaret;
    const selectedFocus = focusCaret && focusCaret.side !== 'inside'
      ? inlineControlCaret(this.paragraphs, this.selection.focus, focusCaret) : undefined;
    // A selection reaching outside the far boundary includes the wrapper too.
    // Its replacement belongs to the surrounding text, not the removed control.
    const removedFocus = selectedFocus && start <= selectedFocus.start && selectedFocus.end <= end;
    const persistent = outsideControl ? undefined : explicitControl || selectionOwner || (this.hasPersistentControls ? contentControlRanges(this.paragraphs).find(r => r.control.persistent && (!removedFocus || r.control.id !== selectedFocus.control.id) && (!r.control.picture || r.control.id === picture?.control.id) && r.start <= start && end <= r.end) : undefined);
    if (persistent && text.includes('\n')) throw new Error('An inline content control cannot contain a paragraph break.');
    const blockGroups = this.hasPersistentBlockControls ? blockControlGroups(this.paragraphs) : [];
    const blockBoundary = this.hasPersistentBlockControls ? persistentBlockBoundary(this.paragraphs, start, end, text, blockGroups) : undefined;
    const persistentBlock = this.hasPersistentBlockControls ? persistentBlockReplacement(this.paragraphs, start, end, blockBoundary?.control.id, blockGroups) : undefined;
    if (blockBoundary?.keepBlock) {
      // The boundary survives even when it belongs to the selected text.
      if (!text && (blockBoundary.side === 'start' ? start === blockBoundary.start - 1 && end === blockBoundary.start : start === blockBoundary.end && end === blockBoundary.end + 1)) return false;
      text += '\n';
    }
    const owner = persistent || persistentBlock;
    if (emptyInlineControl && (text || !persistent || persistent.control.picture || persistent.control.plainText || persistent.control.placeholder || start !== persistent.start || end !== persistent.end || start === end)) throw new Error('Only selected rich-text contents can be cleared to an empty control.');
    const restoringPlaceholder = !emptyInlineControl && owner && !text && start === owner.start && end === owner.end;
    if (restoringPlaceholder) text = persistent ? owner.control.placeholderRuns?.map(r => r.text).join('') || '     ' : blockPrompt(owner.control).map(runs => runs.map(r => r.text).join('')).join('\n');
    // Unlike an undeclared default prompt, a glossary definition is restored
    // when crossing the start erases all contents and converts the block inline.
    const boundaryPrompt = blockBoundary?.side === 'start' && end === blockBoundary.end ? blockBoundary.control.placeholderParagraphs?.[0] : undefined;
    const boundaryPromptText = boundaryPrompt?.map(r => r.text).join('') || '';
    text += boundaryPromptText;

    if (documentLength(this.paragraphs) - (end - start) + text.length > MAX_DOCUMENT_CHARACTERS) throw new Error(DOCUMENT_CHARACTER_LIMIT_MESSAGE);
    const a = locate(this.paragraphs, start), b = locate(this.paragraphs, end);
    const crossesSection = this.paragraphs.slice(a.index, b.index).some(p => p.sectionEnd);
    // A section mark owns the preceding section, whereas a surviving paragraph
    // mark supplies the merged paragraph's formatting. A body selection may
    // also wholly enclose tables; a partial cell selection cannot merge with it.
    const enteringTable = !this.paragraphs[a.index].cellId && this.paragraphs[b.index].cellId && b.offset === 0 && !this.paragraphs[b.index - 1]?.cellId;
    if (crossesSection && (this.paragraphs[a.index].cellId || this.paragraphs[b.index].cellId && !enteringTable)) throw new Error('A section break cannot be edited together with a partial table selection.');
    let format = this.typingRun(start, start === end && !(outsideControl && controlCaret.side === 'after') ? 'backward' : 'forward');
    if (insertedImage) format.image = insertedImage;
    if (replacingPlaceholder) {
      format = { ...copy(placeholder.control.inputRun), text: '' };
      if (insertedImage) format.image = insertedImage;
      if (this.typingDirectCleared) format = clearedRun(format);
      if (this.typingStyle) { format.styleId = this.typingStyle.id || null; format.styleChanged = true; }
      Object.assign(format, this.typingFormat); format.overrides = { ...this.typingFormat };
      if (this.stylesEnabled) resolveCharacterRun(format, this.styles, paragraphRunStyle(this.paragraphs[a.index], this.styles));
    }
    if (start !== end) {
      // Placeholder replacement can expand beyond the user's original caret
      // or selection. Retain a link only if it covers the actual replacement.
      const link = replacingPlaceholder ? hyperlinkRanges(this.paragraphs).find(r => r.start <= start && end <= r.end) : this.hyperlink;
      if (link) format.link = { ...link.link }; else delete format.link;
    }
    if (text.includes('\n')) delete format.link;
    if (picture) { delete format.link; format.contentControl = picture.control; }
    checkCapitalizationText(text, format);
    const nextBodyFields=this.hasBodyFields?replacedBodyFields(bodyFieldRanges(this.paragraphs).filter(r=>!removedBodyFields?.has(r.field.id)),start,end,text.length,!!replacingPlaceholder):null;
    if (!crossesSection && ((this.paragraphs[a.index].cellId || '') !== (this.paragraphs[b.index].cellId || '') || this.paragraphs.slice(a.index, b.index + 1).some(p => (p.cellId || '') !== (this.paragraphs[a.index].cellId || '')))) return this.replaceAcrossCells(text, checkpoint, insertedImage);
    const preservedBlockControls = this.hasBlockControls ? inlineEditAncestors(this.paragraphs, [{ start, end }]) : undefined;
    let insertedRuns;
    // Typing from a selection whose anchor is inside a restored prompt commits
    // those prompt contents even when the replacement ends at its leading edge.
    let updatedControl = text && selectionAnchor?.control.placeholder
      ? { ...copy(selectionAnchor.control), placeholder: false } : undefined;
    if (persistent) {
      const control = { ...copy(persistent.control), placeholder: !!restoringPlaceholder };
      updatedControl = control;
      format.contentControl = control;
      if (restoringPlaceholder) insertedRuns = (control.placeholderRuns || [{ ...copy(control.inputRun), text }]).map(r => ({ ...copy(r), contentControl: control }));
      if (emptyInlineControl) insertedRuns = [{ ...copy(control.inputRun), text: '', contentControl: control }];
    }
    const first = this.paragraphs[a.index], last = this.paragraphs[b.index];
    // Removing an empty paragraph's mark removes that paragraph: the following
    // paragraph keeps its own style and properties, as when Backspace at the
    // start of a heading deletes the empty line above it.
    const emptyFirst = !text && !crossesSection && b.index === a.index + 1 && b.offset === 0 && !first.runs.length
      && !blockBoundary && !persistentBlock && !persistent && sameValue(first.blockControls, last.blockControls);
    const boundaryRuns = controlCaret && start === end ? splitControlCaretRuns(first.runs, a.offset, controlCaret.side === 'inside' ? { ...controlCaret, side: 'before' } : controlCaret) : undefined;
    const lines = text.split('\n');
    const coveredBlockIds = this.hasPersistentBlockControls ? new Set(blockGroups.filter(g => g.control.persistent && start <= g.start && end > g.end).map(g => g.control.id)) : null;
    let replacements = lines.map((line, i) => {
      const retainedLast = blockBoundary?.keepBlock && i === lines.length - 1;
      const p = { ...copy(crossesSection || retainedLast || emptyFirst || replacingPlaceholder && persistentBlock && !persistent ? last : first), id: retainedLast ? last.id : i ? paragraph().id : first.id, runs: normalize([
        ...(i === 0 ? boundaryRuns?.before || sliceRuns(first.runs, 0, a.offset, start !== end) : []),
        ...(line || emptyInlineControl ? insertedRuns || typedScriptRuns(line, format, i === 0 && format.cs ? paragraphText(first).slice(0, a.offset) : '') : []),
        ...(i === lines.length - 1 ? boundaryRuns?.after || sliceRuns(last.runs, b.offset) : []),
      ]) };
      if (coveredBlockIds?.size && p.blockControls) {
        p.blockControls = p.blockControls.filter(c => !coveredBlockIds.has(c.id));
        if (!p.blockControls.length) delete p.blockControls;
      }
      delete p.sectionEnd; delete p.sectionProperties; delete p.sectionSourceIndex;
      if (i === lines.length - 1 && last.sectionEnd) {
        p.sectionEnd = copy(last.sectionEnd); p.sectionProperties = last.sectionProperties;
        if (last.sectionSourceIndex !== undefined) p.sectionSourceIndex = last.sectionSourceIndex;
      }
      if (i < lines.length - 1 && !retainedLast) {
        // Inserted breaks take the typing format; the surviving source mark
        // belongs to the final piece, after the retained suffix.
        clearMark(p); delete p.markRevision; p.markProperties = format.properties || ''; p.markHasDirectProperties = !!format.hasDirectProperties;
        if (p.styleContext) p.styleContext.mark = { ...format.directFormat };
        if (this.stylesEnabled) { p.markStyleId = format.styleId || null; p.markStyleChanged = true; }
        p.markFormat = runFormat(format);
        p.markOverrides = this.stylesEnabled ? { ...format.directFormat, ...format.overrides } : runFormat(format);
      } else if (!retainedLast && !emptyFirst && first !== last) {
        for (const key of ['markFormat', 'markOverrides', 'markProperties', 'markPropertiesChanged', 'markHasDirectProperties', 'markStyleId', 'markStyleChanged', 'markRevision']) {
          if (Object.hasOwn(last, key)) p[key] = copy(last[key]);
          else delete p[key];
        }
        p.markPropertiesChanged = true; p.markStyleChanged = true;
        if (p.styleContext) p.styleContext.mark = copy(last.styleContext?.mark || {});
      }
      return p;
    });
    if (blockBoundary && !blockBoundary.keepBlock) {
      const control = { ...copy(blockBoundary.control), kind: 'inline' };
      delete control.scope; delete control.signature;
      if (control.placeholderParagraphs) { control.placeholderRuns = control.placeholderParagraphs[0]; delete control.placeholderParagraphs; }
      if (blockBoundary.side === 'start' ? end > blockBoundary.start : start < blockBoundary.end || text) control.placeholder = false;
      if (boundaryPrompt) control.placeholder = true;
      const p = blockBoundary.side === 'start' ? replacements.at(-1) : replacements[0];
      const from = blockBoundary.side === 'start' ? paragraphLength(p) - (paragraphLength(last) - b.offset) - boundaryPromptText.length : 0;
      const to = blockBoundary.side === 'start' ? paragraphLength(p) : a.offset + lines[0].length;
      const contents = boundaryPrompt ? boundaryPrompt.map(r => ({ ...copy(r), contentControl: control })) : from === to ? [{ ...copy(control.inputRun), text: '', contentControl: control }] : sliceRuns(p.runs, from, to).map(r => ({ ...r, contentControl: control }));
      p.runs = normalize([...sliceRuns(p.runs, 0, from), ...contents, ...sliceRuns(p.runs, to)]);
      for (const replacement of replacements) {
        replacement.blockControls = replacement.blockControls?.filter(c => c.id !== control.id);
        if (!replacement.blockControls?.length) delete replacement.blockControls;
      }
    }
    if (updatedControl) for (const p of replacements) for (const run of p.runs) if (run.contentControl?.id === updatedControl.id) run.contentControl = updatedControl;
    let updatedBlockControl;
    if (persistentBlock) {
      const control = { ...copy(persistentBlock.control), placeholder: !!restoringPlaceholder && !persistent };
      if (restoringPlaceholder && !persistent) {
        replacements = restoredBlockParagraphs(last, control);
        replacements[0].id = first.id;
      }
      for (const p of replacements) p.blockControls = p.blockControls?.map(c => c.id === control.id ? control : c);
      // Rebase after the edit so restored placeholder content stays a placeholder.
      const owned = [...this.paragraphs.slice(0,a.index), ...replacements, ...this.paragraphs.slice(b.index+1)].filter(p => p.blockControls?.some(c => c.id === control.id));
      control.signature = blockControlSignature(owned, control);
      updatedBlockControl = control;
    }
    const removed = this.paragraphs.slice(a.index, b.index + 1);
    const discardedControl = replacingPlaceholder ? placeholder.control.id : undefined;
    replaceBookmarkMarkers(removed, replacements, a.offset, end - this.paragraphOffset(a.index), text.length, discardedControl, !!replacingPlaceholder && !!persistentBlock && !persistent);
    for (const p of replacements) for (const change of hyperlinkBoundaryChanges(p.runs)) {
      p.runs = normalize([...sliceRuns(p.runs, 0, change.start), ...sliceRuns(p.runs, change.start, change.end).map(r => { const next = { ...r }; if (change.link) next.link = { ...change.link }; else delete next.link; return next; }), ...sliceRuns(p.runs, change.end)]);
    }
    if (this.stylesEnabled) for (const p of replacements) resolveStyledParagraph(p, this.styles, this.numbering);
    if (this.hasPersistentControls || blockBoundary && !blockBoundary.keepBlock) validatePersistentControls([...this.paragraphs.slice(0,a.index), ...replacements, ...this.paragraphs.slice(b.index+1)]);
    let restoredParagraphs = restoringPlaceholder ? restorePlaceholderBookmarks([...this.paragraphs.slice(0,a.index), ...replacements, ...this.paragraphs.slice(b.index+1)], [updatedControl || updatedBlockControl]) : undefined;
    if(nextBodyFields)restoredParagraphs=placeBodyFields(restoredParagraphs||[...this.paragraphs.slice(0,a.index),...replacements,...this.paragraphs.slice(b.index+1)],nextBodyFields);
    if (checkpoint) this.checkpoint();
    if (blockBoundary && !blockBoundary.keepBlock) { this.hasContentControls = true; this.hasPersistentControls = true; }
    this.paragraphs.splice(a.index, b.index - a.index + 1, ...replacements);
    if (crossesSection && removed.some(p => p.cellId)) {
      const cells = new Set(this.paragraphs.map(p => p.cellId).filter(Boolean));
      this.tables = this.tables.filter(table => tableCells(table).some(cell => cells.has(cell.id)));
      removeOrphanedTables(this);
    }
    if (restoredParagraphs) this.paragraphs = restoredParagraphs;
    if (updatedBlockControl) for (const p of this.paragraphs) if (p.blockControls) p.blockControls = p.blockControls.map(c => c.id === updatedBlockControl.id ? updatedBlockControl : c);
    const caret = nextBoundary(this.paragraphs, start + text.length - (blockBoundary?.keepBlock ? 1 : 0));
    this.selection = { anchor: caret, focus: caret };
    if (controlCaret && inlineControlCaret(this.paragraphs, caret, controlCaret)) this.selection.controlCaret = { ...controlCaret };
    else if (outsideControl) {
      const next = contentControlRanges(this.paragraphs).find(r => r.start === caret);
      const before = next && { id: next.control.id, side: 'before' };
      if (before && inlineControlCaret(this.paragraphs, caret, before)) this.selection.controlCaret = before;
    }
    else if (persistent && (text || emptyInlineControl)) {
      const inside = { id: persistent.control.id, side: 'inside' };
      if (inlineControlCaret(this.paragraphs, caret, inside)) this.selection.controlCaret = inside;
    }
    this.didChange(preservedBlockControls);
    return true;
  }
  delete(direction) {
    const [start, end] = this.range;
    if (start !== end) {
      const selected = this.hasPersistentControls && contentControlRanges(this.paragraphs).find(r =>
        r.start === start && r.end === end && r.control.persistent && !r.control.picture && !r.control.plainText && !r.control.placeholder);
      return this.replace('', { emptyInlineControl: !!selected });
    }
    const caret = this.selection.controlCaret;
    const boundary = caret && inlineControlCaret(this.paragraphs, start, caret);
    const owned = caret?.side === 'inside' && boundary;
    if (boundary && boundary.start < boundary.end && (direction < 0 ? caret.side === 'after' : caret.side === 'before')) {
      // The first outside deletion selects contents without changing the package
      // or history. A second deletion clears them and retains the empty wrapper.
      this.select(direction < 0 ? boundary.end : boundary.start, direction < 0 ? boundary.start : boundary.end);
      return false;
    }
    if (owned && owned.start === owned.end) {
      // An owned empty rich-text wrapper is a deletion stop of its own.
      // Remove its envelope before consuming either neighboring character.
      this.checkpoint();
      for (const run of owned.runs) delete run.contentControl;
      for (const marker of [...(owned.paragraph.bookmarks || []), ...(owned.paragraph.fieldMarkers || [])])
        if (marker.contentControlId === caret.id) delete marker.contentControlId;
      this.selection = { anchor: start, focus: start };
      this.didChange();
      return true;
    }
    // A filled control's inside boundary does not consume outside text.
    // Keep ownership and history unchanged, including on repeated keys.
    if (owned && (direction < 0 ? start === owned.start : start === owned.end)) return false;
    const location = locate(this.paragraphs, start), p = this.paragraphs[location.index];
    if (direction < 0 && location.offset === 0 && p.list) {
      this.checkpoint(); p.list = null; p.listChanged = true; this.didChange(); return true;
    }
    const points = boundaries(this.text);
    const at = points.indexOf(start);
    if (at < 0) {
      // A caret inside a character (left there by an edit that joined two) moves after it first;
      // read as no position at all, it made Delete reach back to the document's start.
      const after = points.find(point => point > start) ?? points.at(-1);
      this.selection = { anchor: after, focus: after };
      return this.delete(direction);
    }
    const target = points[at + direction];
    if (target === undefined) return false;
    const other = this.paragraphs[locate(this.paragraphs, target).index];
    if (direction < 0 && location.offset === 0 && p.cellId && !other.cellId && other.sectionEnd && paragraphLength(other)) {
      // Backspace skips the section mark before the first table cell,
      // consuming the preceding body's last grapheme while retaining the break.
      // Validate the body replacement before committing history, so fields and
      // controls retain their safeguards and undo restores the original cell.
      const selection = { ...this.selection };
      this.selection = { anchor: target, focus: points[at - 2] };
      try {
        const changed = this.replace('');
        if (changed) this.history.at(-1).selection = selection;
        else this.selection = selection;
        return changed;
      } catch (error) { this.selection = selection; throw error; }
    }
    const sectionBeforeTable = direction > 0 && !p.cellId && p.sectionEnd && other.cellId;
    if ((p.cellId || '') !== (other.cellId || '') && !sectionBeforeTable) return false;
    if (this.hasPictureControls) checkPictureControlEdit(this.paragraphs, [Math.min(start, target), Math.max(start, target)]);
    if (this.hasPersistentBlockControls) {
      const groups = blockControlGroups(this.paragraphs);
      const boundary = persistentBlockBoundary(this.paragraphs, Math.min(start,target), Math.max(start,target), '', groups);
      persistentBlockReplacement(this.paragraphs, Math.min(start,target), Math.max(start,target), boundary?.control.id, groups);
      if (boundary?.keepBlock) return false;
      if (boundary) {
        // Validate converted inline/grapheme ownership before committing history.
        // Undo must restore the original caret, not the temporary delete range.
        const selection = { ...this.selection };
        this.selection = { anchor: start, focus: target };
        try {
          const changed = this.replace('');
          if (changed) this.history.at(-1).selection = selection;
          else this.selection = selection;
          return changed;
        } catch (error) { this.selection = selection; throw error; }
      }
    }
    // Snapshot before extending the deletion range, so undo restores the caret.
    this.checkpoint();
    this.selection = { anchor: start, focus: target };
    return this.replace('', { checkpoint: false });
  }
  // Formatting toggles change ordinary and complex-script declarations separately.
  // Keep setRunFormat scalar edits independent for styles and DOCX properties.
  toggleBold() {
    const [start, end] = this.textFormattingRange;
    const format = start === end ? this.typingRun(start) : this.formatAt(start, 'forward');
    return this.setRunFormat({ bold: format.bold !== true, boldCs: format.boldCs !== true });
  }
  toggleItalic() {
    const [start, end] = this.textFormattingRange;
    const format = start === end ? this.typingRun(start) : this.formatAt(start, 'forward');
    return this.setRunFormat({ italic: format.italic !== true, italicCs: format.italicCs !== true });
  }
  toggleUnderline() { return this.setRunFormat({ underline: !this.underline }); }
  undo() {
    if (!this.history.length) return false;
    this.future.push(this.snapshot());
    this.restore(this.history.pop());
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.history.push(this.snapshot());
    this.restore(this.future.pop());
    return true;
  }
}

// Table commands outside this file (table-editing.js) share the structural helpers above.
export const tableModelInternals = Object.freeze({ tableContent, applyTableContent, blankCellParagraph, clearMerge, setCellWidths, refreshTableStyles, reparentCellContent, removeOrphanedTables });
