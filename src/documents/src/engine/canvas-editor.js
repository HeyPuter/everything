import { isNoteStoryKind } from './footnotes.js';
import { StorySession } from './story-session.js';
import { decodeShape } from './canvas-shapes.js';
import { wordPosition, optionWordPosition } from './word-navigation.js';
import { carriesFormatting, copyFragment, fragmentHtml, htmlFragment, pasteFragment, formattedPasteFits } from './clipboard-fragment.js';
import { showLink } from './link-appearance.js';
import { revisionView } from './revisions.js';

export const PASTED_PICTURE = /^image\/(png|jpeg|tiff)$/i;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
import { inlineControlCaret, adjacentInlineControl, moveInlineControlCaret, documentStartControlCaret, moveInlineControlHomeEnd, emptyControlPointerCaret, pointerControlSelection } from './content-control-caret.js';
import { paintControlCarets } from './canvas-control-caret.js';
import { paintStoryChrome, storyBoundaries } from './canvas-story-chrome.js';
import { paintInsertionCaret } from './canvas-caret.js';
import { cellTextLocalPoint } from './cell-text-direction.js';
import { pageStorySelectionLayout } from './page-story-positions.js';
import { pageStoryAtPoint } from './page-story-hit.js';
import { paintImage } from './paint-image.js';
import { prepareText3dFonts } from './text-3d-fonts.js';
import { localFontVersion } from './local-fonts.js';
import { ParagraphMeasureCache } from './paragraph-measure-cache.js';
import { displayedFont } from './font-availability.js';
import { preparedScriptMetrics } from './script-font-size.js';
import { text3dSurface } from './text-3d.js';
import { enterCellText, leaveCellText } from './canvas-cell-text.js';
import { tableBorderWidth } from './table-border-layout.js';
import { layoutPageStories } from './page-story-layout.js';
import { drawingPageContexts, drawingPageContext } from './shape-page-fields.js';
import { paintParagraphBorder } from './canvas-paragraph-borders.js';
import { paintTableBorder, paintCellDiagonals } from './canvas-table-borders.js';
import { deviceTableBorders, deviceTableFillRects } from './border-device-layout.js';
import { paragraphBackgrounds, paintOnParagraphBackground } from './paragraph-backgrounds.js';
import { paintParagraphBackgrounds } from './canvas-paragraph-backgrounds.js';
import { hyperlinkAtPoint } from './hyperlink-hit.js';
import { internalHyperlink, hyperlinkLabel } from './hyperlinks.js';
import { paintUnderline } from './canvas-underlines.js';
import { paintText, paintTextShadows } from './canvas-paint-text.js';
import { strikeSpans } from './strikethrough.js';
import { setCanvasTextStyle, measureCanvasText, setCanvasFontAlternatives, loadCanvasFonts } from './canvas-text.js';
import { hasRunBackground, runBackground, foregroundBackground, runBackgroundRect } from './backgrounds.js';
import { paintColor } from './colors.js';
import { TextDocument, boundaries, locate, paragraphFormat, paragraphText } from './model.js';
import { cellContext } from './tables.js';
import { cellBlockRects } from './table-selection.js';
import { paragraphEdges } from './paragraph-geometry.js';
import { pageGeometry } from './page-settings.js';
import { pageBorderStrokes } from './page-borders.js';
import { lineNumberLabels } from './line-numbers.js';
import { paintPagePictureBackground } from './canvas-page-background.js';
import { viewGeometry, viewPageStories, fitContinuousPages, isContinuousView, usesScreenGeometry } from './document-views.js';
import { font, layoutDocument, caretRect, lineAtPosition, verticalLine, hitTestStop, nearestStop, imageAtPoint, selectionRects } from './layout.js';
import { refreshPageReferences } from './page-reference-refresh.js';
import { positionedImageBounds } from './positioned-images.js';
import { createImageInteraction } from './image-interaction.js';
import { paintDecodedImage, imageInfo, decodeImage, decodeImages, validateImageAssets, imageCropRect, inlineImagePaintFrame, normalizedRotation, ANGLE_PER_DEGREE, EMU_PER_PX, isPositionedImage } from './images.js';
let nextAsset = 0;
// A document longer than this paints only the pages on screen (and a screenful either side) at
// once; the rest are painted when they scroll into view, when their pixels are read, or while the
// browser is idle.
const EAGER_PAGES = 80;
// Fields layout writes onto the style objects it measures with; measurement never reads them.
const LAYOUT_OUTPUT = new Set(['text', 'x', 'start', 'end', 'width', 'contentWidth', 'origin', 'ascent', 'descent', 'lineAscent', 'lineDescent', 'textParts', 'textOffsetX', 'textTransform', 'underline', 'strike', 'background', 'group', 'followingSpace', 'fastSpaces', 'lastSpace', 'spaceMetrics', 'trailingStart', 'numberEnd', 'numberDone', 'decimal', 'hasTextShadow', 'discretionaryOnly', 'colors']);

/** Canvas paint surface plus a real textarea for native input, composition and accessible text. */
export class CanvasEditor {
  constructor(host, { paragraphs, pageSettings, numbering, styles, tables, pageStories, comments = null, trackChanges, assets = {}, images = new Map(), borrowImages = false, drawingLayouts, inputLabel, readOnly = false, protectedPageFields = false, onChange = () => {}, onSelection = () => {}, onSave = () => {}, onLink = () => {}, onOpenLink = () => {}, onError = () => {}, onContextMenu = () => {}, onUpdateFields = null, correctTyping = null, linkTyping = null } = {}) {
    this.host = host;
    this.inputLabel = inputLabel;
    this.readOnly = readOnly;
    this.protectedPageFields = protectedPageFields;
    this.session = new StorySession(new TextDocument(paragraphs, pageSettings, numbering, styles, tables, assets, { displayOnly: readOnly, comments, trackChanges }), pageStories);
    this.storyPage = 0;
    this.images = images;
    this.borrowedImages = new Set(borrowImages ? images.values() : []);
    this.drawingLayouts = drawingLayouts;
    this.onChange = onChange; this.onSelection = onSelection; this.onSave = onSave; this.onError = onError;
    this.correctTyping = correctTyping; this.linkTyping = linkTyping;
    this.onUpdateFields = onUpdateFields;
    this.onLink = onLink; this.onOpenLink = onOpenLink; this.visitedLinks = new Set();
    this.zoom = 1;
    // The document view laid out on screen (document-views.js); null is Print Layout.
    this.view = null;
    // Screen-only painters run over each page after its content: (context, pageIndex, geometry) => void.
    this.overlays = [];
    this.destroyed = false;
    this.composition = null;
    this.accessible = false;
    this.preferredX = null;
    this.caretAffinity = 'forward';
    this.caretPage = null;
    this.abort = new AbortController();
    this.pages = document.createElement('div'); this.pages.className = 'canvas-pages';
    this.input = document.createElement('textarea');
    this.input.className = 'canvas-input';
    this.input.readOnly = readOnly;
    this.input.setAttribute('aria-label', 'Document text');
    this.input.setAttribute('aria-describedby', 'canvas-input-help');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.input.wrap = 'off';
    this.input.style.font = font({});
    this.input.setAttribute('data-testid', 'document-input');
    host.replaceChildren(this.pages, this.input);
    this.imageInteraction = createImageInteraction(this);
    const measureCanvas = document.createElement('canvas');
    const context = measureCanvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
    setCanvasFontAlternatives(context, this.model.styles.fontAlternatives);
    const separatorReady=()=>{if(!this.destroyed){this.measureCache.clear();try{this.relayout();this.revealCaret();}catch(error){this.onError(error);}}};
    // Every edit lays the whole story out again, measuring the same text with the same styles thousands
    // of times. Remember each measurement by style and exact text. A style object's key is computed once
    // (layout writes only its own output fields onto it, never ones measurement reads); font changes clear
    // the memory (refreshFonts, deferred script/separator faces, local font access); callers get a copy.
    // Measured paragraphs follow the same memory: they are dropped whenever measurements are.
    const measuredParagraphs = new ParagraphMeasureCache();
    let byStyle = new WeakMap(), byKey = new Map(), entries = 0, measuredFonts = localFontVersion();
    this.measureCache = { clear() { byStyle = new WeakMap(); byKey = new Map(); entries = 0; measuredParagraphs.clear(); } };
    const checkFonts = () => {
      const fonts = localFontVersion();
      if (fonts !== measuredFonts) { this.measureCache.clear(); measuredFonts = fonts; }
    };
    this.measure = (text, style) => {
      checkFonts();
      let texts = byStyle.get(style);
      if (!texts) {
        const key = JSON.stringify(style, (name, value) => LAYOUT_OUTPUT.has(name) ? undefined : value);
        texts = byKey.get(key);
        if (!texts) byKey.set(key, texts = new Map());
        byStyle.set(style, texts);
      }
      let result = texts.get(text);
      if (!result) {
        result = measureCanvasText(context, text, style, separatorReady);
        if (++entries > 200000) this.measureCache.clear();
        texts.set(text, result);
      }
      return { ...result };
    };
    this.measure.paragraphCache = () => { checkFonts(); return measuredParagraphs; };
    const listen = (node, name, fn) => node.addEventListener(name, fn, { signal: this.abort.signal });
    listen(this.pages, 'pointerdown', e => this.pointerDown(e));
    // A press anywhere else ends a run of quick presses, as it does natively.
    listen(document, 'pointerdown', e => { if (!this.pages.contains(e.target)) this.lastPress = null; });
    listen(this.pages, 'pointermove', e => this.pointerMove(e));
    listen(this.pages, 'pointerup', e => this.pointerUp(e));
    listen(this.pages, 'pointercancel', () => { this.touch = null; this.dragging = false; this.dragControl = null; this.stopAutoScroll(); this.imageInteraction.cancel(); });
    listen(this.pages, 'contextmenu', e => {
      // A long press opens the menu; lifting that finger is not a tap.
      this.touch = null;
      e.preventDefault(); const selected=this.model.selectedImage, position = this.point(e, false), normal=this.pointImage;
      this.point({clientX:e.clientX,clientY:e.clientY,altKey:true},false);
      const candidate=this.pointImage, picture=normal || (selected && candidate?.image.id===selected.id ? candidate : null);
      if (picture) this.model.select(picture.start, picture.end);
      else if (position < this.model.range[0] || position > this.model.range[1]) this.model.select(position, position);
      this.focus(); this.onSelection();
      const behind = !this.model.selectedImage && candidate;
      onContextMenu({event:e, behind, selectBehind:()=>{ if(behind){this.model.select(behind.start,behind.end);this.focus();this.onSelection();} }});
    });
    listen(this.pages, 'dblclick', e => this.selectWord(e));
    // A third click selects the paragraph. Pointer events report no click
    // count, so the click that follows the third press carries it.
    listen(this.pages, 'click', e => { if (e.detail === 3 && e.button === 0 && !e.shiftKey) this.selectParagraph(e); });
    listen(this.input, 'keydown', e => this.keydown(e));
    listen(this.input, 'contextmenu', e => {e.preventDefault();onContextMenu({event:e});});
    listen(this.input, 'beforeinput', e => this.beforeInput(e));
    listen(this.input, 'input', e => this.nativeInput(e));
    listen(this.input, 'compositionstart', () => {
      if (this.readOnly) return;
      const entry = this.session.capture(), before = entry.state, [start, end] = this.model.range;
      const caret = this.model.selection.controlCaret;
      const explicit = caret && inlineControlCaret(this.model.paragraphs, start, caret);
      const placeholder = caret ? caret.side === 'inside' && explicit?.control.placeholder && explicit : this.model.placeholderAt(start);
      if (placeholder && end <= placeholder.end) {
        this.model.select(placeholder.start, placeholder.end);
        this.model.typingFormat = { ...before.typingFormat }; this.model.typingStyle = before.typingStyle; this.model.typingDirectCleared = before.typingDirectCleared;
        this.syncInput(); this.paint();
      }
      this.composition = entry;
    });
    listen(this.input, 'compositionend', () => this.finishComposition());
    listen(this.input, 'select', () => this.nativeSelection());
    listen(this.input, 'keyup', () => this.nativeSelection());
    // A click in the native text (accessible text mode) moves the caret with no key or select
    // event; the toolbar's commands must act where it now is.
    listen(this.input, 'pointerup', () => this.nativeSelection());
    listen(this.input, 'focus', () => this.paint());
    listen(this.input, 'blur', () => { this.finishComposition(); this.paint(); });
    listen(this.input, 'copy', e => this.copy(e, false));
    listen(this.input, 'cut', e => this.copy(e, true));
    listen(this.input, 'paste', e => {
      if (this.composition || !e.clipboardData) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      // A copied picture or screenshot arrives as a file with no text beside it.
      const picture = !text && [...(e.clipboardData.files || [])].find(file => PASTED_PICTURE.test(file.type));
      if (picture) { if (!this.readOnly) this.insertImageFile(picture).catch(error => this.onError(error)); return; }
      this.pasteData(text, e.clipboardData.getData('text/html'));
    });
    // Moving the window to another display or changing browser zoom changes the device pixel ratio.
    // Give the page canvases a backing store at the new ratio, so text stays sharp.
    const watchResolution = () => {
      const query = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      query?.addEventListener('change', () => { if (this.destroyed) return; watchResolution(); this.resizeCanvases(); }, { once: true, signal: this.abort.signal });
    };
    watchResolution();
    // Pages left unpainted by the last paint are painted before they are shown.
    this.stalePages = new Set();
    document.addEventListener('scroll', () => this.paintShownPages(), { capture: true, passive: true, signal: this.abort.signal });
    window.addEventListener('resize', () => this.paintShownPages(), { signal: this.abort.signal });
    this.relayout();
  }
  focus() { this.input.focus({ preventScroll: true }); this.syncInput(); this.paint(); }
  /** The page the caret is on: a header or footer's own page while editing one. */
  get caretPageIndex() {
    if (this.session.path !== null) return this.storyPage ?? 0;
    try { return caretRect(this.selectionLayout, this.model.selection.focus, this.caretAffinity, this.caretPage).page ?? 0; } catch { return 0; }
  }
  get model() { return this.session.model; }
  get pageStories() { return this.session.pageStories; }
  exportText() { return this.session.body.text; }
  export(pkg) { return this.session.export(pkg); }
  editStory(path = null, page = 0) {
    if (this.readOnly || path !== null && !this.pageStories?.stories[path]?.editable) return false;
    this.finishComposition();
    this.session.activate(path); this.session.page = page; this.storyPage = page; this.caretPage = page;
    this.caretAffinity = 'forward'; this.preferredX = null;
    this.relayout(); this.focus(); this.revealCaret(); return true;
  }
  validateStory() {
    if (this.session.path === null && !this.protectedPageFields) return;
    for (const p of this.model.paragraphs) {
      if (this.session.path !== null && (p.sectionEnd || p.bookmarks?.length)) throw new Error('Sections and bookmarks cannot be added to headers or footers yet.');
      for (const r of p.runs) if (r.field && (r.text !== '\ufffc' || Object.keys(r.overrides || {}).length || r.styleChanged)) throw new Error('Page-field formatting cannot be changed yet. Select the surrounding text instead.');
    }
  }
  async refreshFonts() {
    if (this.destroyed) return;
    if (this.fontRefresh) return this.fontRefresh;
    this.fontRefresh = (async () => {
      // Font access changes presentation, never document formatting or history.
      // Rebuild retained text/diagram previews as well as body/story metrics.
      while (!this.destroyed) {
        const revision = this.session.revision;
        const fontVersion = localFontVersion();
        await loadCanvasFonts({ ...this.model, pageStories: this.pageStories });
        if (this.destroyed) return;
        const missing = new Set();
        const images = await decodeImages(this.model.assets, this.model.styles.fontAlternatives, name => missing.add(name),
          this.readOnly ? (id, error) => this.onError(new Error(`Image ${id}: ${error.message}`)) : undefined);
        if (this.destroyed || revision !== this.session.revision || fontVersion !== localFontVersion()) {
          for (const image of images.values()) image.close?.();
          continue;
        }
        const previous = this.images;
        this.images = images;
        this.measureCache.clear();
        try { this.relayout(); }
        catch (error) {
          this.images = previous;
          for (const image of images.values()) image.close?.();
          throw error;
        }
        this.releaseImages(previous);
        this.missingPictureFonts = [...missing];
        return;
      }
    })();
    try { await this.fontRefresh; }
    finally { this.fontRefresh = null; }
  }
  // Every match of an open search is tinted; the selected one keeps the selection color.
  setFindHighlights(matches = []) {
    const current = this.findHighlights || [];
    if (matches.length === current.length && matches.every((m, i) => m.start === current[i].start && m.end === current[i].end)) return;
    this.findHighlights = matches; this.findRects = null; this.paint();
  }
  /** Tinted document ranges beneath the text, such as commented text: [{ start, end, fill }] in document order. */
  setRangeTints(tints = [], layer = 'default') {
    // Separate layers (comments, highlighted merge fields) combine without replacing each other.
    this.tintLayers = { ...this.tintLayers, [layer]: tints };
    tints = Object.values(this.tintLayers).flat().sort((a, b) => a.start - b.start || a.end - b.end);
    const current = this.rangeTints || [];
    if (tints.length === current.length && tints.every((t, i) => t.start === current[i].start && t.end === current[i].end && t.fill === current[i].fill)) return;
    this.rangeTints = tints; this.tintRects = null; this.paint();
  }
  /** Vertical bars in the left margin beside lines that touch the given ranges (tracked changes). */
  // side: 'left', 'right' or 'outside' (right on odd pages, left on even ones).
  setMarginBars(ranges = [], color = '#7a7a7a', side = 'left') {
    const key = JSON.stringify([ranges.map(r => [r.start, r.end]), color, side]);
    if (key === this.marginBarKey) return;
    this.marginBarKey = key; this.marginBars = { ranges, color, side }; this.paint();
  }
  rangeTintRects() {
    const tints = this.rangeTints, layout = this.session.path === null ? this.selectionLayout : null;
    if (!tints?.length || !layout) return [];
    if (this.tintRects?.layout === layout) return this.tintRects.rects;
    const rects = [], { page, pages } = layout;
    for (const tint of tints) if (tint.end > tint.start) for (const rect of selectionRects({ lines: [...layout.lines, ...(layout.repeatedLines || [])], page, pages }, tint.start, tint.end)) rects.push({ ...rect, fill: tint.fill });
    this.tintRects = { layout, rects };
    return rects;
  }
  findHighlightRects() {
    const matches = this.findHighlights, layout = this.selectionLayout;
    if (!matches?.length || !layout) return [];
    if (this.findRects?.layout === layout) return this.findRects.rects;
    const rects = [], { page, pages } = layout;
    // Matches are in document order, so each line looks only at the matches that can reach it.
    for (const line of [...layout.lines, ...(layout.repeatedLines || [])]) {
      let low = 0, high = matches.length;
      while (low < high) { const mid = (low + high) >> 1; if (matches[mid].end <= line.start) low = mid + 1; else high = mid; }
      for (let i = low; i < matches.length && matches[i].start <= line.end; i++)
        for (const rect of selectionRects({ lines: [line], page, pages }, matches[i].start, matches[i].end)) rects.push({ ...rect, match: matches[i] });
    }
    this.findRects = { layout, rects };
    return rects;
  }
  selectMatch(match) {
    this.finishComposition(); this.model.select(match.start, match.end);
    this.caretAffinity = 'forward'; this.caretPage = null; this.preferredX = null;
    this.syncInput(); this.paint(); this.revealCaret(); this.onSelection();
  }
  replaceMatches(query, text, options, all) {
    this.finishComposition(); let count = 0, failure;
    const ok = this.execute(() => { count = this.model.replaceMatches(query, text, options, all); return count > 0; }, e => { failure = e; });
    if (!ok) throw failure || new Error('The replacement could not fit the document. Try shorter text.');
    return count;
  }
  execute(action, onFailure, options, quiet = false) {
    if (this.readOnly || this.viewOnly) return;
    // A command chosen while an input method composes (Bold on the toolbar) commits the composition
    // and then applies, rather than being dropped.
    this.finishComposition();
    try {
      const revision = this.session.revision;
      this.session.run(() => action(), () => {
        this.validateStory(); this.preferredX = null; this.caretAffinity = 'forward';
        this.relayout(); this.revealCaret();
      }, options);
      if (this.session.revision !== revision) this.onChange();
      return true;
    } catch (e) {
      this.relayout(); if (!quiet) this.onError(e); onFailure?.(e); return false;
    }
  }
  setTableProperties(patch) { return this.execute(() => this.model.setTableProperties(patch)); }
  /** Lay out a body model as this editor would, for field refreshes inside a transaction. */
  layoutModel(model) {
    return layoutDocument(model.paragraphs, this.measure, pageGeometry(model.pageSettings), model.numbering, model.tables, this.pageStories, { styles: model.styles, drawingLayouts: this.drawingLayouts });
  }
  /**
   * The file's section a section on screen takes its headers and footers from: section breaks inserted since
   * opening the file make sections of its own list (see StorySession.pageStories), so the two numberings differ.
   */
  sourceSection(shown, count) {
    const ends = this.session.body.paragraphs.filter(p => p.sectionEnd);
    return Math.max(0, Math.min(count - 1, shown < ends.length ? ends[shown].sectionSourceIndex ?? shown : count - 1));
  }
  /** Show a header, footer or footnote story the package just created; headers and footers apply to every section without one. */
  attachPageStory(path, kind, paragraphs, extra = {}) {
    const sections = this.session.body.paragraphs.filter(p => p.sectionEnd).length + 1;
    const current = this.session.definition || { sections: Array.from({ length: sections }, () => ({ header: {}, footer: {}, firstPageDifferent: false })), stories: {}, evenAndOdd: false };
    const { variant = 'default', section: shown = 0, story = {}, ...settings } = extra;
    const first = this.sourceSection(shown, current.sections.length);
    this.session.definition = { ...current, ...settings, stories: { ...current.stories, [path]: { kind, paragraphs, tables: [], editable: true, ...story } },
      sections: isNoteStoryKind(kind) ? current.sections : current.sections.map((section, i) => i < first || section[kind][variant] ? section : { ...section, [kind]: { ...section[kind], [variant]: path } }) };
    this.session.sectionRevision = undefined;
    this.relayout();
  }
  /** Different first page for a section, and different odd and even pages for the document (display only; the package writes them). */
  setStoryOptions({ section, firstPageDifferent, evenAndOdd, pageNumbering } = {}) {
    const current = this.session.definition || { sections: Array.from({ length: this.session.body.paragraphs.filter(p => p.sectionEnd).length + 1 }, () => ({ header: {}, footer: {}, firstPageDifferent: false })), stories: {}, evenAndOdd: false };
    const source = section === undefined ? undefined : this.sourceSection(section, current.sections.length);
    this.session.definition = { ...current, ...(evenAndOdd !== undefined ? { evenAndOdd: !!evenAndOdd } : {}),
      sections: current.sections.map((s, i) => {
        if (i !== source) return s;
        const next = firstPageDifferent !== undefined ? { ...s, firstPageDifferent: !!firstPageDifferent } : { ...s };
        // Page numbering (format and restart) applies to this section's PAGE fields and page count.
        if (pageNumbering !== undefined) { if (pageNumbering) next.pageNumbering = pageNumbering; else delete next.pageNumbering; }
        return next;
      }) };
    this.session.sectionRevision = undefined;
    if (this.session.path !== null) this.editStory(null); else this.relayout();
  }
  /** The section index of a body page. */
  sectionOfPage(page = this.caretPageIndex) { return this.layout?.pageSections?.[page] ?? 0; }
  updatePageReferences() {
    if (this.session.path !== null) { this.onError(new Error('Update page references from the document body.')); return false; }
    let result;
    const ok = this.execute(() => {
      result = refreshPageReferences(this.model, model => layoutDocument(model.paragraphs, this.measure, pageGeometry(model.pageSettings), model.numbering, model.tables, this.pageStories, { styles: model.styles, drawingLayouts: this.drawingLayouts }), this.pageStories, { checkpoint: false });
    });
    if (ok && result?.issues.length) this.onError(new Error([...new Set(result.issues.map(issue => issue.message))].join(' ')));
    this.syncInput(); this.onSelection(); return ok;
  }
  setCellVerticalAlignment(value) { return this.execute(() => this.model.setCellVerticalAlignment(value)); }
  setCellShading(value) { return this.execute(() => this.model.setCellShading(value)); }
  setCellBorders(value) { return this.execute(() => this.model.setCellBorders(value)); }
  setCellMargins(value) { return this.execute(() => this.model.setCellMargins(value)); }
  setTableRowHeight(value) { return this.execute(() => this.model.setTableRowHeight(value)); }
  setImageProperties(patch) { return this.execute(() => this.model.setImageProperties(patch)); }
  async applyDrawingText(pkg, image, frame, paragraphs, { signal, tables } = {}) {
    this.finishComposition();
    if (this.readOnly || this.viewOnly || this.destroyed || signal?.aborted) return false;
    const revision = this.session.revision, model = this.model;
    if (model.selectedImage !== image) throw new Error('Select the drawing again before editing its text.');
    const prepared = pkg.prepareDrawingTextEdit(image, frame, paragraphs, model.assets, model.styles, model.numbering, tables);
    if (!prepared) return true;
    validateImageAssets(model.assets, prepared.asset);
    const id = `drawing-edit:${++nextAsset}`;
    const pixelCount = image => image.previewPlaceholder ? 0 : image.rasterPixelCount ?? (image.bitmap ? image.bitmap.width * image.bitmap.height : image.width * image.height);
    const checkPixels = next => {
      const total = [...this.images].reduce((n, [key, bitmap]) => n + (key === id ? 0 : pixelCount(bitmap)), 0) + pixelCount(next);
      if (total > 64000000) throw new Error('This editing session supports up to 64 megapixels of image previews.');
    };
    const preview = await decodeShape(prepared.asset, this.images, model.styles.fontAlternatives, (_, next) => checkPixels(next));
    try {
      checkPixels(preview);
      if (this.destroyed || signal?.aborted) { preview.close(); return false; }
      if (revision !== this.session.revision || this.model !== model || model.selectedImage !== image) throw new Error('The document changed while the drawing text was being prepared.');
      model.assets[id] = prepared.asset; this.images.set(id, preview);
      let failure;
      if (!this.execute(() => model.replaceDrawingText(image, id, prepared.shell), error => { failure = error; })) throw failure || new Error('The drawing text could not be applied.');
      return true;
    } catch (error) {
      this.images.delete(id); delete model.assets[id]; preview.close(); throw error;
    }
  }
  /**
   * Viewing: the document stays editable underneath (layout, styles and saving are unchanged) while
   * every edit path refuses, so switching back loses nothing. A read-only package stays read-only.
   */
  setViewOnly(on) {
    this.finishComposition();
    this.viewOnly = !!on;
    this.input.readOnly = this.readOnly || this.viewOnly;
    if (this.viewOnly && this.session.path !== null) this.editStory(null);
    this.onSelection?.();
  }
  async insertImageFile(file) {
    if (this.readOnly || this.viewOnly) return false;
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or TIFF image up to 10 MB.');
    this.finishComposition();
    const path = this.session.path, revision = this.session.revision, selection = { ...this.model.selection }, bytes = new Uint8Array(await file.arrayBuffer()), info = imageInfo(bytes), asset = { bytes, mime: info.mime };
    validateImageAssets(this.model.assets, asset);
    const bitmap = await decodeImage(asset);
    if (this.destroyed) { bitmap.close(); return false; }
    if (path !== this.session.path || revision !== this.session.revision || selection.anchor !== this.model.selection.anchor || selection.focus !== this.model.selection.focus) { bitmap.close(); throw new Error('The insertion position changed while the image opened. Select its position and insert it again.'); }
    const line = lineAtPosition(this.selectionLayout, this.model.range[0], 'forward', this.caretPage), p = this.layout.pages[line.page] || this.layout.page;
    const paragraph = this.model.paragraphs[locate(this.model.paragraphs, this.model.range[0]).index], context = cellContext(this.model.tables, paragraph.cellId);
    const cell = this.selectionLayout.cells.find(c => c.id === line.cellId && c.page === line.page && c.column === line.column);
    const cellPage = cell ? { ...p, left: cell.x + context.cell.margins.left / 15, right: p.width - cell.x - cell.width + context.cell.margins.right / 15 } : p;
    const format = paragraphFormat(paragraph, this.model.numbering), edges = [true, false].map(first => paragraphEdges(format, cellPage, first));
    const width = Math.min(...edges.map(e => e.right - e.left));
    const height = Math.max(1, (p.height - p.top - p.bottom) / (format.lineRule === 'auto' ? format.lineSpacing : 1) - 32), scale = Math.min(1, width / bitmap.width, height / bitmap.height);
    let id; do { id = `canvas-image-${++nextAsset}`; } while (this.model.assets[id]);
    this.model.assets[id] = asset; this.images.set(id, bitmap);
    const ok = this.execute(() => this.model.insertImage(id, { width: Math.max(1, Math.floor(bitmap.width * scale * EMU_PER_PX)), height: Math.max(1, Math.floor(bitmap.height * scale * EMU_PER_PX)), alt: '' }));
    if (!ok) { delete this.model.assets[id]; this.images.delete(id); bitmap.close(); }
    this.focus(); return ok;
  }
  fitTable(mode) { this.execute(() => this.model.fitTable(mode)); this.focus(); }
  mergeCells() { this.execute(() => this.model.mergeCells()); this.focus(); }
  mergeCellBelow() { this.execute(() => this.model.mergeCellBelow()); this.focus(); }
  splitCell() { this.execute(() => this.model.splitCell()); this.focus(); }
  setTableRowKeep(value) { this.execute(() => this.model.setTableRowKeep(value)); this.focus(); }
  setTableHeaderRows(count) { this.execute(() => this.model.setTableHeaderRows(count)); this.focus(); }
  insertTable(rows, columns) {
    return this.execute(() => {
      const parent = this.model.tableContext;
      const box = parent && this.selectionLayout.cells.find(cell => cell.id === parent.cell.id);
      const width = box ? box.width * 15 - Math.max(parent.cell.margins.left, tableBorderWidth(box.borders.left) * 15 / 2) - Math.max(parent.cell.margins.right, tableBorderWidth(box.borders.right) * 15 / 2) : undefined;
      return this.model.insertTable(rows, columns, width);
    });
  }
  insertTableRow() { this.execute(() => this.model.insertTableRow()); this.focus(); }
  insertTableParagraph(after) { this.execute(() => this.model.insertTableParagraph(after)); this.focus(); }
  insertTableColumn() { this.execute(() => this.model.insertTableColumn()); this.focus(); }
  deleteTablePart(kind) { this.execute(() => this.model.deleteTablePart(kind)); this.focus(); }
  setCharacterStyle(id) { this.execute(() => this.model.setCharacterStyle(id)); this.focus(); }
  editCharacterStyle(id, patch) { return this.execute(() => this.model.editCharacterStyle(id, patch)); }
  createCharacterStyle(name, basedOn) { return this.execute(() => this.model.createCharacterStyle(name, basedOn)); }
  setParagraphStyle(id) { this.execute(() => this.model.setParagraphStyle(id)); this.focus(); }
  setOutlineLevel(value) { this.execute(() => this.model.setOutlineLevel(value)); this.focus(); }
  get outline() { return this.model.outline.map(entry => ({ ...entry, page: lineAtPosition(this.selectionLayout, entry.start, 'forward').page + 1 })); }
  goToParagraph(id) {
    this.finishComposition();
    const index = this.model.paragraphs.findIndex(p => p.id === id); if (index < 0) return false;
    this.model.select(this.model.paragraphOffset(index));
    this.caretAffinity = 'forward'; this.caretPage = null; this.preferredX = null;
    this.focus(); this.revealCaret(); this.onSelection(); return true;
  }
  editParagraphStyle(id, patch) { return this.execute(() => this.model.editParagraphStyle(id, patch)); }
  createParagraphStyle(name, basedOn) { return this.execute(() => this.model.createParagraphStyle(name, basedOn)); }
  toggleBold() { this.execute(() => this.model.toggleBold()); this.focus(); }
  setRunFormat(patch) { this.execute(() => this.model.setRunFormat(patch)); this.focus(); }
  setFontSize(size) { this.execute(() => this.model.setFontSize(size)); this.focus(); }
  toggleItalic() { this.execute(() => this.model.toggleItalic()); this.focus(); }
  toggleUnderline() { this.execute(() => this.model.toggleUnderline()); this.focus(); }
  clearDirectTextFormatting() { this.finishComposition(); const ok = this.execute(() => this.model.clearDirectTextFormatting()); this.focus(); return ok; }
  clearDirectParagraphFormatting() { this.finishComposition(); const ok = this.execute(() => this.model.clearDirectParagraphFormatting()); this.focus(); return ok; }
  setParagraphFormat(patch) { this.execute(() => this.model.setParagraphFormat(patch)); this.focus(); }
  setParagraphLineSpacing(value) { return this.execute(() => this.model.setParagraphLineSpacing(value)); }
  setParagraphGeometry(patch, defaultTabStop) { return this.execute(() => this.model.setParagraphGeometry(patch, defaultTabStop)); }
  toggleList(kind) { this.execute(() => this.model.toggleList(kind)); this.focus(); }
  changeListLevel(delta) { this.execute(() => this.model.changeListLevel(delta)); this.focus(); }
  restartNumbering() { this.execute(() => this.model.restartNumbering()); this.focus(); }
  adjustIndent(delta) { this.execute(() => this.model.adjustIndent(delta)); this.focus(); }
  insertTab() { this.execute(() => this.model.replace('\t')); this.focus(); }
  setPageSettings(patch, options) { return this.execute(() => this.model.setPageSettings(patch, options)); }
  insertSectionBreak(type) { const ok = this.execute(() => this.model.insertSectionBreak(type)); this.focus(); return ok; }
  insertPageBreak() { this.execute(() => this.model.insertPageBreak()); this.focus(); }
  travelHistory(direction) {
    if (this.readOnly || this.viewOnly) return;
    this.finishComposition();
    // The host can keep history beyond this editor's (changes that reopened the package).
    if (!this.session[direction === 'undo' ? 'history' : 'future'].length && this.onHistoryEnd?.(direction)) return;
    try {
      if (this.session[direction](() => { this.validateStory(); this.relayout(); })) this.onChange();
      this.focus(); this.revealCaret();
    } catch (e) { this.relayout(); this.onError(e); }
  }
  undo() { this.travelHistory('undo'); }
  redo() { this.travelHistory('redo'); }
  setZoom(value) {
    if (!Number.isFinite(value)) return;
    this.zoom = Math.max(0.1, Math.min(2, value));
    this.resizeCanvases();
  }
  setAccessible(value) {
    this.accessible = value;
    this.host.classList.toggle('accessible-editing', value);
    this.syncInput(); this.paint(); this.focus();
  }
  /**
   * Show the document in a screen view: { kind: 'web' | 'draft' | 'read', width, height, … } in layout
   * pixels, or null for Print Layout. Only the display changes; the model and its pages are untouched.
   */
  setView(view) {
    const next = view && usesScreenGeometry(view.kind) ? { ...view } : null;
    if (JSON.stringify(next) === JSON.stringify(this.view)) return false;
    this.finishComposition();
    if (next && this.session.path !== null) { this.session.activate(null); this.caretPage = null; }
    this.view = next;
    this.relayout();
    return true;
  }
  /** Lay the body and its page stories out for a view (null: the authored pages). */
  computeLayout(view = this.view) {
    this.measure.paragraphCache?.().nextGeneration();
    const body = this.session.body;
    const stories = view ? viewPageStories(this.pageStories, view.kind) : this.pageStories;
    let layout = layoutDocument(body.paragraphs, this.measure, pageGeometry(body.pageSettings), body.numbering, body.tables, stories, { bestEffort: this.readOnly, drawingLayouts: this.drawingLayouts, ...(!this.readOnly ? { styles: this.model.styles } : {}), ...(view ? { viewGeometry: viewGeometry(view) } : {}) });
    const storyLayout = layoutPageStories(layout, stories, [...body.paragraphs.filter(p => p.sectionEnd).map(p => p.sectionEnd), body.pageSettings], this.measure, this.model.numbering, { bestEffort: this.readOnly, drawingLayouts: this.drawingLayouts, ...(!this.readOnly ? { styles: this.model.styles } : {}) });
    if (view && isContinuousView(view.kind)) layout = fitContinuousPages(layout, storyLayout);
    // Draft shows text only: floating drawings stay in the document but are not drawn or hit.
    if (view?.kind === 'draft') layout = { ...layout, floatingObjects: [] };
    return { layout, storyLayout };
  }
  relayout() {
    this.tablePaintCache = new Map();
    ({ layout: this.layout, storyLayout: this.storyLayout } = this.computeLayout());
    if (this.session.path !== null) {
      this.storyPage = this.session.page;
      const occurrences = this.storyLayout.positions.filter(p => p.path === this.session.path);
      this.storyPage = occurrences.find(p => p.page === this.storyPage)?.page ?? occurrences[0]?.page;
      if (this.storyPage === undefined) this.session.activate(null);
      else this.session.page = this.storyPage;
    }
    // Section line numbers are labels beside the finished body lines (§17.6.8); views without pages show none.
    const body = this.session.body;
    this.lineNumbers = this.view ? [] : lineNumberLabels(this.layout, body.paragraphs, body.numbering, body.styles, this.measure);
    this.selectionLayout = this.session.path === null ? this.layout : pageStorySelectionLayout(this.layout, this.storyLayout, this.session.path, this.storyPage);
    this.input.setAttribute('aria-label', this.inputLabel || (this.session.path === null ? 'Document text' : ({ header: 'Header text', footer: 'Footer text', footnote: 'Footnote text', endnote: 'Endnote text' }[this.pageStories.stories[this.session.path].kind] || 'Story text')));
    this.drawingPageContexts = drawingPageContexts(this.layout, this.pageStories);
    while (this.pages.children.length > this.layout.pageCount) this.pages.lastChild.remove();
    while (this.pages.children.length < this.layout.pageCount) {
      const canvas = document.createElement('canvas');
      canvas.className = 'canvas-page';
      canvas.setAttribute('aria-hidden', 'true');
      // A page left for later paints itself before anything reads its pixels.
      for (const name of ['getContext', 'toDataURL', 'toBlob']) canvas[name] = (...args) => {
        const index = this.canvases?.indexOf(canvas) ?? -1;
        if (this.stalePages.has(index)) this.paint({ pages: [index] });
        return HTMLCanvasElement.prototype[name].apply(canvas, args);
      };
      this.pages.append(canvas);
    }
    this.canvases = [...this.pages.children];
    this.resizeCanvases();
    // Font and style edits can introduce an effect face absent at import time.
    // Prepare outlines without delaying input; repaint only the latest layout.
    const effectStyles = new Map(), approximateScripts = new Map();
    for (const lines of [this.layout.lines, this.storyLayout.lines]) for (const line of lines) for (const fragment of line.fragments) {
      if ((fragment.verticalAlign === 'superscript' || fragment.verticalAlign === 'subscript') && !fragment.image && fragment.text?.trim()) {
        const family = displayedFont(fragment, this.model.styles.fontAlternatives);
        const metrics = preparedScriptMetrics({ ...fragment, fontFamily: family });
        if (metrics.size === null || metrics.position === null) approximateScripts.set(family.toLowerCase(), family);
      }
      for (const color of fragment.colors?.length ? fragment.colors : [fragment]) {
        if (!color.text3d) continue;
        const style = { ...fragment, ...color };
        if (text3dSurface(style)) effectStyles.set(`${style.fontFamily}/${!!style.bold}/${!!style.italic}`, style);
      }
    }
    const layout = this.layout;
    if (effectStyles.size) prepareText3dFonts([...effectStyles.values()], this.model.styles.fontAlternatives).then(changed => {
      if (changed && !this.destroyed && this.layout === layout) this.paint();
    });
    const scriptFonts = [...approximateScripts.values()].sort();
    const scriptNoticeChanged = JSON.stringify(scriptFonts) !== JSON.stringify(this.approximateScriptFonts || []);
    this.approximateScriptFonts = scriptFonts;
    if (scriptNoticeChanged) this.onSelection();
  }
  resizeCanvases() {
    this.canvases.forEach((canvas, index) => {
      const geometry = this.layout.pages[index] || this.layout.page;
      canvas.dataset.page = index;
      const ratio = window.devicePixelRatio || 1;
      // Assigning a dimension clears and reallocates the canvas even when unchanged, and pages
      // off screen are repainted only later: keep the backing store of pages that kept their size.
      const width = Math.round(geometry.width * this.zoom * ratio), height = Math.round(geometry.height * this.zoom * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      // Shown at exactly its backing store's size: a fractional page size (A4, fit-width and
      // slider zooms) would otherwise make the browser resample, and blur, every page.
      canvas.style.width = `${width / ratio}px`;
      canvas.style.height = `${height / ratio}px`;
    });
    this.pages.style.gap = `${this.layout.page.gap * this.zoom}px`;
    this.syncInput(); this.paint(); this.onSelection();
  }
  printSheets() {
    this.finishComposition();
    // Printing always uses the authored pages, whatever view is on screen, and leaves out hidden text,
    // which is laid out only while the formatting marks show it: lay the pages out privately and put the
    // screen layout back afterwards, without touching the page canvases.
    const hidden = revisionView.showHidden && [this.session.body, ...Object.values(this.pageStories?.stories || {})].some(story => story?.paragraphs?.some(p => p.runs.some(r => r.vanish)));
    if (this.view || hidden) {
      const screen = { view: this.view, layout: this.layout, storyLayout: this.storyLayout, selectionLayout: this.selectionLayout, tablePaintCache: this.tablePaintCache, drawingPageContexts: this.drawingPageContexts };
      const shown = revisionView.showHidden;
      if (hidden) revisionView.showHidden = false;
      try {
        const printed = this.computeLayout(null);
        Object.assign(this, printed, { selectionLayout: printed.layout, tablePaintCache: new Map(), drawingPageContexts: drawingPageContexts(printed.layout, this.pageStories), view: null });
        return this.paintSheets();
      } finally { revisionView.showHidden = shown; Object.assign(this, screen); }
    }
    return this.paintSheets();
  }
  paintSheets() {
    this.printedLayout = { layout: this.layout, storyLayout: this.storyLayout };
    const sheets = this.layout.pages.map(geometry => {
      const canvas = document.createElement('canvas');
      canvas.className = 'document-page';
      canvas.style.width = `${geometry.width}px`; canvas.style.height = `${geometry.height}px`;
      canvas.width = Math.round(geometry.width * 2); canvas.height = Math.round(geometry.height * 2);
      return canvas;
    });
    this.paint({ canvases: sheets, printing: true });
    return sheets;
  }
  /** Indices of the page canvases on screen, with a screenful of margin; every page in a short document. */
  shownPages() {
    const all = this.canvases.map((_, index) => index);
    if (all.length <= EAGER_PAGES) return all;
    const host = this.host.getBoundingClientRect();
    const top = Math.max(host.top, 0), bottom = Math.min(host.bottom, window.innerHeight);
    const left = Math.max(host.left, 0), right = Math.min(host.right, window.innerWidth);
    const height = Math.max(0, bottom - top), width = Math.max(0, right - left);
    return all.filter(index => {
      const r = this.canvases[index].getBoundingClientRect();
      return r.bottom > top - height && r.top < bottom + height && r.right > left - width && r.left < right + width;
    });
  }
  paintShownPages() {
    if (this.destroyed || !this.stalePages.size) return;
    const pages = this.shownPages().filter(index => this.stalePages.has(index));
    if (pages.length) this.paint({ pages });
  }
  /** Paint every page left for later, for callers that read the page canvases' pixels. */
  flushPaint() {
    if (!this.destroyed && this.stalePages.size) this.paint({ pages: [...this.stalePages] });
  }
  schedulePaint() {
    if (this.paintTask || !this.stalePages.size || this.destroyed) return;
    const idle = typeof requestIdleCallback === 'function';
    const run = deadline => {
      this.paintTask = null;
      if (this.destroyed || !this.stalePages.size) return;
      // Nearest pages first, a couple at a time while the browser has idle time, so typing and
      // scrolling stay responsive.
      const shown = this.shownPages(), anchor = shown.length ? shown[0] : 0;
      const order = [...this.stalePages].sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
      do this.paint({ pages: order.splice(0, 2) });
      while (order.length && deadline && !deadline.didTimeout && deadline.timeRemaining() > 4);
      this.schedulePaint();
    };
    this.paintTask = idle ? { idle, id: requestIdleCallback(run, { timeout: 250 }) } : { idle, id: setTimeout(run, 16) };
  }
  paint({ canvases = this.canvases, printing = false, pages = null } = {}) {
    if (this.destroyed || !this.layout) return;
    let indices = null;
    if (canvases === this.canvases && !printing) {
      if (pages) { indices = pages.filter(index => index < canvases.length); for (const index of indices) this.stalePages.delete(index); }
      else {
        indices = this.shownPages();
        const shown = new Set(indices);
        this.stalePages = new Set(canvases.map((_, index) => index).filter(index => !shown.has(index)));
      }
    }
    const [start, end] = this.model.range;
    // A shape selected on its own shows only its frame handles.
    const shapeOnly = end === start + 1 && this.drawingEditor?.canResize(this.model.selectedImage);
    // A rectangular cell selection highlights whole cells rather than the text range through them.
    const rects = shapeOnly ? [] : this.model.cellBlock ? cellBlockRects(this.selectionLayout, this.model) : selectionRects(this.selectionLayout, start, end);
    const owned = this.model.selection.controlCaret?.side === 'inside' && start === end && !this.accessible && document.activeElement === this.input
      ? inlineControlCaret(this.model.paragraphs, start, this.model.selection.controlCaret) : null;
    const controlRects = owned && !owned.control.hiddenAppearance ? owned.start === owned.end
      ? [{ ...caretRect(this.selectionLayout, owned.start, this.caretAffinity, this.caretPage), empty: true }]
      : selectionRects(this.selectionLayout, owned.start, owned.end) : null;
    const caret = caretRect(this.selectionLayout, this.model.selection.focus, this.caretAffinity, this.caretPage);
    const found = printing ? [] : this.findHighlightRects();
    const tinted = printing ? [] : this.rangeTintRects();
    for (const index of indices || canvases.keys()) {
      const canvas = canvases[index], ctx = canvas.getContext('2d'), geometry = this.layout.pages[index] || this.layout.page;
      // A canvas keeps its pixels and drawing state between paints (resizeCanvases keeps unchanged sizes).
      ctx.reset?.();
      setCanvasFontAlternatives(ctx, this.model.styles.fontAlternatives);
      const scale = canvas.width / geometry.width;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.fillStyle = geometry.background || '#FFFFFF'; ctx.fillRect(0, 0, geometry.width, geometry.height);
      paintPagePictureBackground(ctx, geometry, this.images, { bestEffort: this.readOnly });
      ctx.fillStyle = '#000000';
      for (const separator of this.layout.columnSeparators || []) if (separator.page === index) ctx.fillRect(separator.x, separator.y, separator.width, separator.height);
      const sectionPage = geometry.pageBorders ? index - (this.layout.pageSections?.indexOf(this.layout.pageSections[index]) ?? 0) : 0;
      const pageBorders = pageBorderStrokes(this.storyLayout.borderMargins?.[index] ? { ...geometry, ...this.storyLayout.borderMargins[index] } : geometry, sectionPage);
      if (geometry.pageBorders?.zOrder === 'back') for (const border of pageBorders) paintParagraphBorder(ctx, border);
      // Screen cues for the story being edited: the inactive header/footer or body is faded.
      let storyChrome = null;
      if (!printing && this.pageStories) {
        const kindOf = path => this.pageStories.stories[path]?.kind;
        const activeKind = this.session.path === null ? 'body' : kindOf(this.session.path);
        const storyLines = this.storyLayout.lines.filter(line => line.page === index);
        if (activeKind === 'body' ? storyLines.some(line => ['header', 'footer'].includes(kindOf(line.pageStory))) : ['header', 'footer'].includes(activeKind))
          storyChrome = { bounds: storyBoundaries(geometry, storyLines, kindOf), active: activeKind };
      }
      // Header/footer stories paint beneath the body. Front/behind text
      // and relative drawing order apply within each story, not across them.
      for (const pageStory of [true, false]) {
        // Fade the header and footer before the body paints, so body text and drawings that reach
        // into the margins keep their own colours.
        if (!pageStory && storyChrome?.active === 'body') paintStoryChrome(ctx, geometry, storyChrome.bounds, 'body');
        const floatingObjects = pageStory ? this.storyLayout.floatingObjects : this.layout.floatingObjects || [];
        const paintFloating = behind => {
          // A hidden drawing (§20.4.2.5) keeps its anchor and place but paints nothing; hidden ink likewise.
          for (const f of floatingObjects) if (f.page === index && !!f.image.anchor.behind === behind && !this.hiddenDrawing?.(f.image) && !f.image.hidden) {
            if (f.cellClip) { ctx.save(); ctx.beginPath(); ctx.rect(f.cellClip.left ?? 0, f.cellClip.top, (f.cellClip.right ?? geometry.width) - (f.cellClip.left ?? 0), f.cellClip.bottom - f.cellClip.top); ctx.clip(); }
            const angle = normalizedRotation(f.image.rotation);
            if (angle) {
              ctx.save(); ctx.translate(f.x + f.width / 2, f.y + f.height / 2);
              ctx.rotate(angle / ANGLE_PER_DEGREE * Math.PI / 180);
              ctx.translate(-f.x - f.width / 2, -f.y - f.height / 2);
            }
            const bitmap = this.images.get(f.image.assetId);
            if (bitmap) {
              if (f.image.opacity !== undefined) { ctx.save(); ctx.globalAlpha *= f.image.opacity; }
              const { flipH, flipV } = f.image, cropped = !bitmap.previewPlaceholder && f.image.crop && Object.values(f.image.crop).some(Boolean);
              if (flipH || flipV || cropped) {
                ctx.save();
                ctx.translate(f.x + (flipH ? f.width : 0), f.y + (flipV ? f.height : 0));
                ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
                // Crop the source viewport, leaving negative crop outsets clear.
                // The anchor/wrapping frame stays fixed, including under flips.
                const rect = imageCropRect(bitmap.previewPlaceholder ? undefined : f.image.crop, bitmap.width, bitmap.height);
                if (rect) {
                  const [x, y, w, h] = rect.destination;
                  const [sx, sy, sw, sh] = rect.source, scaleX = w * f.width / sw, scaleY = h * f.height / sh;
                  ctx.beginPath(); ctx.rect(x * f.width, y * f.height, w * f.width, h * f.height); ctx.clip();
                  paintDecodedImage(ctx, bitmap, x * f.width - sx * scaleX, y * f.height - sy * scaleY, bitmap.width * scaleX, bitmap.height * scaleY, { ...drawingPageContext(this.drawingPageContexts, index, f.pageStory ? undefined : f.region), pageStory: !!f.pageStory, printing });
                }
                ctx.restore();
              } else paintDecodedImage(ctx, bitmap, f.x, f.y, f.width, f.height, { ...drawingPageContext(this.drawingPageContexts, index, f.pageStory ? undefined : f.region), pageStory: !!f.pageStory, printing, bitmapDisplayScale: printing ? undefined : scale });
              if (f.image.opacity !== undefined) ctx.restore();
            }
            // A selected shape shows its frame handles only; pictures and objects within a text selection are tinted.
            const handlesOnly = start === f.start && end === f.end && this.drawingEditor?.canResize(f.image);
            if (!printing && this.session.path === null && !f.pageStory && start < f.end && end > f.start && !handlesOnly) { ctx.fillStyle = 'rgba(55,95,145,.25)'; ctx.fillRect(f.x, f.y, f.width, f.height); }
            if (angle) ctx.restore();
            if (f.cellClip) ctx.restore();
          }
        };
        paintFloating(true);
        const paintedCells = pageStory ? this.storyLayout.cells : this.layout.cells;
        // Selection/caret paints reuse this layout's display projection. A new
        // layout clears the cache; zoom/DPR replace screen entries. Print must
        // have its own entry even when its scale equals the screen's 200% zoom.
        const cacheKey = `${printing}:${pageStory}:${index}`;
        let tablePaint = this.tablePaintCache.get(cacheKey);
        if (!tablePaint || tablePaint.scale !== scale) {
          const sourceTableBorders = (pageStory ? this.storyLayout.tableBorders : this.layout.tableBorders).filter(stroke => stroke.page === index);
          const tableBorders = deviceTableBorders(ctx, sourceTableBorders, printing, geometry);
          const filledCells = paintedCells.filter(cell => cell.page === index && cell.fill);
          tablePaint = { scale, tableBorders, filledCells, fillRects: deviceTableFillRects(ctx, paintedCells.filter(cell => cell.page === index), sourceTableBorders, tableBorders, printing) };
          this.tablePaintCache.set(cacheKey, tablePaint);
        }
        const { tableBorders, filledCells, fillRects } = tablePaint;
        for (const cell of filledCells) {
          const rect = fillRects.get(cell.id);
          ctx.fillStyle = cell.fill;
          if (rect.width > 0 && rect.height > 0) ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
        const pageLines = (pageStory ? this.storyLayout.lines : [...this.layout.lines, ...(this.layout.repeatedLines || [])]).filter(line => line.page === index);
        const backgrounds = paragraphBackgrounds(pageLines, geometry, paintedCells);
        const paragraphBorders = (pageStory ? this.storyLayout.borders : this.layout.paragraphBorders || []).filter(border => border.page === index);
        const paintedParagraphInk = paintParagraphBackgrounds(ctx, new Set([...backgrounds.values()].map(value => value.rect).filter(Boolean)), paragraphBorders);
        // Dashed gridlines mark borderless cell edges on screen (View Gridlines); they never print.
        for (const guide of printing || this.showTableGridlines === false ? [false] : [true, false]) for (const stroke of tableBorders) if (stroke.guide === guide) paintTableBorder(ctx, stroke);
        paintCellDiagonals(ctx, paintedCells.filter(cell => cell.page === index && (cell.borders?.tl2br || cell.borders?.tr2bl)));
        for (const border of paragraphBorders) paintParagraphBorder(ctx, border, paintedParagraphInk.get(border));
        // Run backgrounds precede selection and glyphs, including repeated headers.
        const surfaceGeometry = geometry;
        for (const physical of pageLines) {
          const { rect, base } = backgrounds.get(physical);
          paintOnParagraphBackground(ctx, rect, geometry, base, background => {
            ctx.save();
            const { line, geometry } = enterCellText(ctx, physical, surfaceGeometry);
            if (line.clip) { ctx.beginPath(); ctx.rect(0, line.y, geometry.width, line.height); ctx.clip(); }
            if (line.cellClip) { ctx.beginPath(); ctx.rect(line.cellClip.left ?? 0, line.cellClip.top, (line.cellClip.right ?? geometry.width) - (line.cellClip.left ?? 0), line.cellClip.bottom - line.cellClip.top); ctx.clip(); }
            if (line.textClip) { ctx.beginPath(); ctx.rect(line.textClip.left, 0, line.textClip.right - line.textClip.left, geometry.height); ctx.clip(); }
            const spans = [...(line.backgrounds || []), ...(line.marker && hasRunBackground(line.marker) ? [line.marker] : [])];
            for (const span of spans) {
              const band = runBackgroundRect(line, span);
              ctx.fillStyle = runBackground(span, background); ctx.fillRect(band.x, band.y, band.width, band.height);
            }
            ctx.restore();
          });
        }
        if (!printing && !pageStory) for (const r of tinted) if (r.page === index) { ctx.fillStyle = r.fill; ctx.fillRect(r.x, r.y, r.width, r.height); }
        if (!printing && !pageStory && this.marginBars?.ranges.length) {
          const side = this.marginBars.side === 'outside' ? (index % 2 ? 'left' : 'right') : this.marginBars.side;
          const bars = this.marginBars.ranges, x = side === 'right' ? Math.min(geometry.width - 5, geometry.width - (geometry.right ?? 96) + 20) : Math.max(4, (geometry.left ?? 96) - 22);
          ctx.fillStyle = this.marginBars.color;
          for (const line of pageLines) if (bars.some(r => r.start <= line.end && r.end > line.start)) ctx.fillRect(x, line.y, 1.25, line.height);
        }
        if (!printing && pageStory === (this.session.path !== null)) {
          ctx.fillStyle = 'rgba(255,196,0,.38)';
          for (const r of found) if (r.page === index && (r.match.start !== start || r.match.end !== end)) ctx.fillRect(r.x, r.y, r.width, r.height);
        }
        ctx.fillStyle = 'rgba(55,105,180,.28)';
        if (!printing && pageStory === (this.session.path !== null)) for (const r of rects) if (r.page === index) ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.fillStyle = '#000000'; ctx.textBaseline = 'alphabetic';
        // Inline drawing ink paints over surrounding paragraph glyphs,
        // including ink extending outside the drawing's layout rectangle.
        const inlinePictureLines = pageLines.filter(line => line.fragments.some(fragment => fragment.image && !isPositionedImage(fragment.image)));
        for (const imagesOnly of [false, true]) for (const physical of imagesOnly ? inlinePictureLines : pageLines) {
          const { rect, base } = backgrounds.get(physical);
          paintOnParagraphBackground(ctx, rect, geometry, base, background => {
            ctx.save();
            const { line, geometry } = enterCellText(ctx, physical, surfaceGeometry);
            if (line.clip && line.clipText !== false) { ctx.beginPath(); ctx.rect(0, line.y, geometry.width, line.height); ctx.clip(); }
            if (line.cellClip) { ctx.beginPath(); ctx.rect(line.cellClip.left ?? 0, line.cellClip.top, (line.cellClip.right ?? geometry.width) - (line.cellClip.left ?? 0), line.cellClip.bottom - line.cellClip.top); ctx.clip(); }
            if (line.textClip) { ctx.beginPath(); ctx.rect(line.textClip.left, 0, line.textClip.right - line.textClip.left, geometry.height); ctx.clip(); }
            if (!imagesOnly && line.marker) {
              const marker = line.marker; ctx.fillStyle = paintColor(marker.color, foregroundBackground(marker, background)); setCanvasTextStyle(ctx, marker); paintTextShadows(ctx, marker, line.baseline); paintText(ctx, marker, line.baseline);
              for (const u of marker.underlines || []) { ctx.fillStyle = paintColor(u.color, foregroundBackground(u, background)); paintUnderline(ctx, { ...u, x: u.x + marker.x }, line.baseline); }
            }
            // Bar tabs: a hairline over the line's full height, so consecutive lines join.
            for (const bar of imagesOnly ? [] : line.bars || []) { ctx.fillStyle = paintColor('auto', background); ctx.fillRect(Math.round(bar.x), line.y, 1, line.height); }
            for (const leader of imagesOnly ? [] : line.leaders || []) {
              ctx.save(); ctx.beginPath(); ctx.rect(leader.x, line.clipText === false ? 0 : line.y, leader.width, line.clipText === false ? geometry.height : line.height); ctx.clip();
              ctx.fillStyle = paintColor(leader.color, foregroundBackground(leader, background));
              setCanvasTextStyle(ctx, leader); paintTextShadows(ctx, leader, line.baseline); paintText(ctx, leader, line.baseline); ctx.restore();
            }
            for (const fragment of line.fragments) {
              if (!!fragment.image !== imagesOnly) continue;
              if (isPositionedImage(fragment.image)) continue;
              if (fragment.image) {
                const clipImage = line.clip && line.clipText === false || !!normalizedRotation(fragment.image.rotation);
                if (clipImage) { ctx.save(); ctx.beginPath(); ctx.rect(0, line.y, geometry.width, line.height); ctx.clip(); }
                const upright = fragment.uprightImage;
                if (upright) { ctx.save(); leaveCellText(ctx, physical.cellText.matrix); }
                const bitmap = this.hiddenDrawing?.(fragment.image) || fragment.image.hidden ? null : this.images.get(fragment.image.assetId), top = upright?.y ?? line.baseline - fragment.ascent;
                if (bitmap) {
                  if (fragment.image.opacity !== undefined) { ctx.save(); ctx.globalAlpha *= fragment.image.opacity; }
                  const { flipH, flipV } = fragment.image, angle = normalizedRotation(fragment.image.rotation), transformed = flipH || flipV || angle;
                  const {x: x0, y: y0, width, height} = inlineImagePaintFrame(fragment.image, upright?.x ?? fragment.x, top);
                  if (transformed) {
                    ctx.save(); ctx.translate(x0 + width / 2, y0 + height / 2);
                    if (angle) ctx.rotate(angle / ANGLE_PER_DEGREE * Math.PI / 180);
                    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
                  }
                  const left = transformed ? -width / 2 : x0, upper = transformed ? -height / 2 : y0;
                  if (bitmap.previewPlaceholder || !fragment.image.crop || !Object.values(fragment.image.crop).some(Boolean)) paintDecodedImage(ctx, bitmap, left, upper, width, height, { ...drawingPageContext(this.drawingPageContexts, index, line.pageStory ? undefined : line.region), pageStory: !!line.pageStory, printing, bitmapDisplayScale: printing ? undefined : scale });
                  else {
                    const rect = imageCropRect(fragment.image.crop, bitmap.width, bitmap.height);
                    if (rect) { const [x, y, w, h] = rect.destination; paintImage(ctx, bitmap, ...rect.source, left + x * width, upper + y * height, w * width, h * height); }
                  }
                  if (transformed) ctx.restore();
                  if (fragment.image.opacity !== undefined) ctx.restore();
                }
                if (!printing && this.session.path === null && !line.pageStory && start < fragment.end && end > fragment.start && !(start === fragment.start && end === fragment.end && this.drawingEditor?.canResize(fragment.image))) {
                  const box = normalizedRotation(fragment.image.rotation)
                    ? positionedImageBounds(inlineImagePaintFrame(fragment.image, upright?.x ?? fragment.x, top))
                    : {x:upright?.x ?? fragment.x,y:top,width:upright?.width ?? fragment.width,height:upright?.height ?? fragment.ascent};
                  ctx.save(); ctx.fillStyle = 'rgba(55,95,145,.25)'; ctx.fillRect(box.x, box.y, box.width, box.height); ctx.restore();
                }
                if (upright) ctx.restore();
                if (clipImage) ctx.restore();
              } else {
                setCanvasTextStyle(ctx, fragment);
                paintTextShadows(ctx, fragment, line.baseline);
                const colors = fragment.colors || [{ value: fragment.color }];
                colors.forEach((span, i) => {
                  ctx.save(); ctx.fillStyle = paintColor(span.value, foregroundBackground(span, background));
                  if (colors.length > 1) {
                    // Paint the same shaped text through adjacent color windows.
                    // Color boundaries must not break kerning or ligature shaping.
                    const left = i ? fragment.x + span.x : 0;
                    const right = i < colors.length - 1 ? fragment.x + span.x + span.width : geometry.width;
                    ctx.beginPath(); ctx.rect(left, 0, right - left, geometry.height); ctx.clip();
                  }
                  paintText(ctx, Object.hasOwn(span, 'textOutline') ? { ...fragment, textOutline: span.textOutline, textFill: span.textFill ?? null, text3d: span.text3d ?? null, textScene: span.textScene ?? null } : fragment, line.baseline); ctx.restore();
                });
              }
            }
            for (const u of imagesOnly ? [] : line.underlines) { ctx.fillStyle = paintColor(u.color, foregroundBackground(u, background)); paintUnderline(ctx, u, line.baseline); }
            for (const u of imagesOnly ? [] : [...(line.strikes || []), ...(line.marker ? strikeSpans(line.marker, line.marker, line.marker.x, line.marker.width) : [])]) { ctx.fillStyle = paintColor(u.color, foregroundBackground(u, background)); ctx.fillRect(u.x, line.baseline + u.offset, u.width, u.thickness); }
            ctx.restore();
          });
        }
        paintFloating(false);
      }
      for (const label of this.lineNumbers || []) if (label.page === index) {
        ctx.save(); ctx.fillStyle = paintColor(label.style.color, geometry.background || '#FFFFFF'); setCanvasTextStyle(ctx, label.style);
        paintText(ctx, { ...label.style, text: label.text, x: label.x, width: label.width }, label.baseline); ctx.restore();
      }
      if (geometry.pageBorders?.zOrder !== 'back') for (const border of pageBorders) paintParagraphBorder(ctx, border);
      if (storyChrome && storyChrome.active !== 'body') paintStoryChrome(ctx, geometry, storyChrome.bounds, storyChrome.active);
      if (!printing) for (const overlay of this.overlays) overlay(ctx, index, geometry);
      if (!printing && controlRects) paintControlCarets(ctx, controlRects, index, scale);
      if (!printing && start === end && caret.page === index && document.activeElement === this.input && !this.accessible) {
        const line = lineAtPosition(this.selectionLayout, this.model.selection.focus, this.caretAffinity, this.caretPage);
        const clip = line.cellClip;
        paintInsertionCaret(ctx, caret, scale, {
          left: Math.max(0, clip?.left ?? 0), top: Math.max(0, clip?.top ?? 0),
          right: Math.min(geometry.width, clip?.right ?? geometry.width), bottom: Math.min(geometry.height, clip?.bottom ?? geometry.height),
        });
      }
    }
    if (!printing) { this.positionInput(caret); this.imageInteraction?.update(); this.schedulePaint(); }
  }
  positionInput(caret) {
    if (this.accessible) return;
    const canvas = this.canvases[caret.page];
    if (!canvas) return;
    // Keep the native composition candidate window near the drawn caret.
    this.input.style.left = `${canvas.offsetLeft + caret.x * this.zoom}px`;
    this.input.style.top = `${canvas.offsetTop + caret.y * this.zoom}px`;
    this.input.style.height = `${caret.height * this.zoom}px`;
  }
  get inputText() { return this.model.text.replace(/[\v\f\u000e]/g, '\n'); }
  syncInput() {
    if (this.composition) return;
    if (this.input.value !== this.inputText) this.input.value = this.inputText;
    const [start, end] = this.model.range;
    const direction = this.model.selection.focus < this.model.selection.anchor ? 'backward' : 'forward';
    if (this.input.selectionStart !== start || this.input.selectionEnd !== end || this.input.selectionDirection !== direction) this.input.setSelectionRange(start, end, direction);
  }
  nativeSelection() {
    if (this.composition || this.input.value !== this.inputText) return;
    const a = this.input.selectionStart, b = this.input.selectionEnd;
    const backward = this.input.selectionDirection === 'backward';
    const anchor = backward ? b : a, focus = backward ? a : b;
    if (anchor === this.model.selection.anchor && focus === this.model.selection.focus) return;
    this.caretAffinity = 'forward'; this.caretPage = null; this.preferredX = null;
    this.model.select(anchor, focus); this.syncInput(); this.paint(); this.onSelection();
  }
  openHyperlink(link = this.model.hyperlink?.link) {
    if (!link) return;
    if (internalHyperlink(link)) { this.goToBookmark(this.model.bookmarks.find(b => b.name === link.anchor)?.id); return; }
    if (link.history) this.visitedLinks.add(link.target);
    this.onOpenLink(link.target);
  }
  setHyperlink(target, text, { appearance = false } = {}) {
    this.execute(() => { const changed = this.model.setHyperlink(target, text); if (changed && appearance) showLink(this.model); return changed; });
    this.focus();
  }
  removeHyperlink() { this.execute(() => this.model.removeHyperlink()); this.focus(); }
  get bookmarks() { return this.model.bookmarks.map(b => ({ id: b.id, name: b.name, start: b.start, end: b.end, page: lineAtPosition(this.selectionLayout, b.columnRange?.target ?? b.start, 'forward').page + 1 })); }
  addBookmark(name) { return this.execute(() => this.model.addBookmark(name)); }
  renameBookmark(id, name) { return this.execute(() => this.model.renameBookmark(id, name)); }
  removeBookmark(id) { return this.execute(() => this.model.removeBookmark(id)); }
  goToBookmark(id) {
    this.finishComposition(); const bookmark = this.model.bookmarks.find(b => b.id === id);
    this.model.select(bookmark?.columnRange?.target ?? bookmark?.start ?? 0);
    this.caretAffinity = 'forward'; this.caretPage = null; this.preferredX = null;
    this.focus(); this.revealCaret(); this.onSelection(); return true;
  }
  point(event, updateCaret = true) {
    // Coordinates remain in page units across zoom, scroll, and display scaling.
    // The vertically nearest page; pages shown side by side share a row, so the horizontal distance decides between them.
    const nearest = this.canvases.reduce((best, canvas) => {
      const r = canvas.getBoundingClientRect();
      const distance = Math.max(r.top - event.clientY, 0, event.clientY - r.bottom), across = Math.max(r.left - event.clientX, 0, event.clientX - r.right);
      return !best || distance < best.distance || distance === best.distance && across < best.across ? { canvas, r, distance, across } : best;
    }, null);
    if (!nearest) return 0;
    const page = Number(nearest.canvas.dataset.page), y = (event.clientY - nearest.r.top) / this.zoom;
    this.pointImage = imageAtPoint(this.selectionLayout, page, (event.clientX - nearest.r.left) / this.zoom, y, { includeBehindText: !!event.altKey });
    // A view can hide some drawings (hidden ink); they are not painted, so they are not hit either.
    if (this.pointImage && this.hiddenDrawing?.(this.pointImage.image)) this.pointImage = null;
    const hit = hitTestStop(this.selectionLayout, page, (event.clientX - nearest.r.left) / this.zoom, y), position = hit.offset;
    this.pointLink = hyperlinkAtPoint(this.selectionLayout, this.model.paragraphs, page, (event.clientX - nearest.r.left) / this.zoom, y, this.pointImage);
    if (!updateCaret) return position;
    this.caretPage = page;
    const prior = lineAtPosition(this.selectionLayout, position, 'backward', page);
    this.caretAffinity = prior.page === page && position === prior.end && Math.abs(prior.y + prior.height / 2 - y) <= prior.height / 2 ? 'backward' : 'forward';
    if (prior.wrapSegments && prior.page === page && y >= prior.y && y <= prior.y + prior.height) {
      const stop = nearestStop(prior, (event.clientX - nearest.r.left) / this.zoom);
      if (stop.offset === position && prior.wrapSegments.some(s => s.stops.at(-1) === stop)) this.caretAffinity = 'backward';
    }
    if (hit.affinity) this.caretAffinity = hit.affinity;
    return position;
  }
  controlPointerCaret(e, position, caret) {
    if (!caret || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || position !== this.model.text.length) return caret;
    // At the story end, an outside position is exposed in the blank area
    // past the final text. An internal paragraph end has no such pointer stop.
    const line = lineAtPosition(this.selectionLayout, position, this.caretAffinity, this.caretPage);
    const canvas = this.canvases[line.page], rect = canvas.getBoundingClientRect();
    let x = (e.clientX - rect.left) / this.zoom;
    if (line.cellText) x = cellTextLocalPoint(line.cellText.matrix, x, (e.clientY - rect.top) / this.zoom).x;
    const local = line.cellText?.line || line, edge = local.stops.reduce((right, s) => Math.max(right, s.x), -Infinity);
    return x > edge && local.stops.some(s => s.offset === position && s.x === edge) ? { ...caret, side: 'after' } : caret;
  }
  /**
   * A finger on the pages may be starting a scroll (touch-action: pan-y), so it does not place the
   * caret or bring up the keyboard yet: a tap does that when the finger lifts, and a sideways drag,
   * which never scrolls, selects from where it went down. Pictures take the press at once.
   */
  deferTouch(e) {
    if (e.pointerType !== 'touch' || this.model.selectedImage || this.imageInteraction.active) return false;
    this.point(e, false);
    if (this.pointImage) return false;
    // Scrolling is up to touch-action; this only stops the emulated mouse press from taking focus.
    e.preventDefault();
    this.touch = { down: e, x: e.clientX, y: e.clientY };
    return true;
  }
  pointerDown(e, tapped = false) {
    // Control+click is a Mac's secondary click: the context menu follows, and the selection it acts on stays.
    if (e.button !== 0 || MAC && e.ctrlKey) return;
    // A press during composition commits it and goes on to place the caret, as in a native field;
    // returning would let the press take focus from the document, losing what is typed next.
    if (this.composition) this.finishComposition();
    if (!tapped && this.deferTouch(e)) return;
    this.touch = null;
    this.typingGroup = null; this.deleteGroup = null;
    // Pointer events carry no click count: a quick second or third press in place counts up, unless the
    // pages moved in between (a scroll or relayout puts other text under the pointer).
    const last = this.lastPress, { left, top } = this.pages.getBoundingClientRect();
    const presses = last && e.timeStamp - last.time < 500 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5
      && left === last.left && top === last.top ? last.presses % 3 + 1 : 1;
    this.lastPress = { time: e.timeStamp, x: e.clientX, y: e.clientY, left, top, presses };
    this.unit = null;
    e.preventDefault();
    // Crop mode and Shift+click drawing selection take the press first (image-interaction.js).
    if (this.imageInteraction.pointerDown(e)) return;
    if (this.session.path !== null) {
      const story = this.storyAtEvent(e);
      if (story && this.pageStories.stories[story.pageStory].editable && (story.pageStory !== this.session.path || story.page !== this.storyPage)) this.editStory(story.pageStory, story.page);
      // Footnotes are edited in place: a click back in the body leaves the note.
      else if (!story && isNoteStoryKind(this.pageStories?.stories[this.session.path]?.kind) && !this.readOnly) this.editStory(null);
    } else if (!this.readOnly) {
      // A click in a footnote edits it directly.
      const story = this.storyAtEvent(e, true);
      if (story && isNoteStoryKind(this.pageStories?.stories[story.pageStory]?.kind) && this.pageStories.stories[story.pageStory].editable) this.editStory(story.pageStory, story.page);
    }
    let position = this.point(e), restoredPromptSelection, restoredOutsideCaret, sameOffsetCaret;
    if ((e.ctrlKey || e.metaKey) && this.pointLink) { this.openHyperlink(this.pointLink.link); return; }
    const selection = this.model.selection;
    if (!this.readOnly && !e.shiftKey && selection.anchor === selection.focus && selection.controlCaret?.side === 'inside') {
      const range = inlineControlCaret(this.model.paragraphs, selection.focus, selection.controlCaret);
      if (range && range.start === range.end && position === range.start) sameOffsetCaret = this.controlPointerCaret(e, position, selection.controlCaret);
      if (range && range.start === range.end && (position !== range.start || sameOffsetCaret?.side === 'after')) {
        const { scrollTop, scrollLeft } = this.host;
        const extendPrompt = !e.ctrlKey && !e.metaKey && !e.altKey;
        const word = extendPrompt && new Intl.Segmenter(undefined, { granularity: 'word' }).segment(this.model.text).containing(Math.max(0, position - 1));
        const targetEnd = word?.isWordLike ? word.index + word.segment.length : position;
        if (!this.execute(() => this.model.leaveEmptyControl(position < range.start ? 'before' : 'after'))) return;
        const exited = this.model.selection;
        // Restoring a glossary prompt can wrap lines. Hit the physical pointer
        // again after layout, without letting revealCaret move its target.
        this.host.scrollTop = scrollTop; this.host.scrollLeft = scrollLeft;
        position = this.point(e);
        sameOffsetCaret = undefined;
        if (extendPrompt && position === exited.focus) restoredOutsideCaret = exited.controlCaret;
        const prompt = this.model.placeholderAt(position);
        if (extendPrompt && prompt?.control.id === range.control.id) {
          // The first exit click extends through the original target word,
          // mapped across restoration. Do not consume the rest of its line
          // or paragraph; later ordinary clicks select only the prompt.
          restoredPromptSelection = [prompt.start, Math.max(prompt.end, targetEnd + prompt.end - range.start)];
        }
      }
    }
    if (this.pointImage && !e.shiftKey) { this.model.select(this.pointImage.start, this.pointImage.end); if (this.imageInteraction.begin(e)) { this.onSelection(); return; } }
    else if (restoredPromptSelection) this.model.select(...restoredPromptSelection);
    else if (!e.shiftKey && (this.model.macroButtonAt(position)||this.model.placeholderAt(position))) { const range = this.model.macroButtonAt(position)||this.model.placeholderAt(position); this.model.select(range.start, range.end); }
    else {
      const caret = !e.shiftKey ? restoredOutsideCaret || sameOffsetCaret || emptyControlPointerCaret(this.model.paragraphs, position, this.model.selection.controlCaret) : undefined;
      const extent = e.shiftKey ? pointerControlSelection(selection, position) : undefined;
      const anchorCaret = e.shiftKey && selection.anchor === position
        ? selection.controlCaret || (extent && { id: extent.id, side: 'inside' }) : undefined;
      this.model.select(e.shiftKey ? this.model.selection.anchor : position, position,
        anchorCaret || (caret && !restoredOutsideCaret && !sameOffsetCaret ? this.controlPointerCaret(e, position, caret) : caret), extent);
      // The second press takes the word and the third the paragraph; a drag from there extends by
      // whole words or paragraphs, as native selection does.
      const unit = !e.shiftKey && presses > 1 && !this.model.selection.controlCaret && this.textUnit(e, position, presses);
      if (unit) { this.model.select(unit.start, unit.end); this.unit = { ...unit, presses, model: this.model, path: this.session.path }; }
    }
    const dragSelection = this.model.selection;
    const dragRange = !this.readOnly && !e.shiftKey && dragSelection.anchor === dragSelection.focus &&
      dragSelection.controlCaret?.side === 'inside' && inlineControlCaret(this.model.paragraphs, position, dragSelection.controlCaret);
    this.dragControl = dragRange && dragRange.start === dragRange.end
      ? { position, caret: dragSelection.controlCaret, model: this.model, revision: this.session.revision } : null;
    this.dragging = true;
    // A tap is handled as its finger lifts, when there is no pointer left to capture.
    try { this.pages.setPointerCapture(e.pointerId); } catch { /* released */ }
    this.preferredX = null;
    this.focus(); this.onSelection();
  }
  pointerMove(e) {
    if (this.touch?.down.pointerId === e.pointerId) {
      const dx = Math.abs(e.clientX - this.touch.x), dy = Math.abs(e.clientY - this.touch.y);
      if (dx < 10 || dx <= dy) return;
      this.pointerDown(this.touch.down, true);
    }
    if (this.imageInteraction.move(e)) return;
    if (!this.dragging) {
      this.point(e, false);
      this.pages.title = this.pointLink ? `${this.pointLink.link.tooltip || hyperlinkLabel(this.pointLink.link)} (Ctrl/Cmd+click to open)` : '';
      this.pages.style.cursor = this.pointLink && (e.ctrlKey || e.metaKey) ? 'pointer' : '';
      return;
    }
    this.dragTo(e);
    this.dragPoint = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey };
    this.autoScroll();
  }
  /** The word (two presses) or paragraph (three) at a pointer position. */
  textUnit(e, position, presses) {
    if (presses === 3) {
      const { index, offset } = locate(this.model.paragraphs, position), start = position - offset;
      return { start, end: start + paragraphText(this.model.paragraphs[index]).length };
    }
    const word = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(this.model.text).containing(this.pointCharacter(e, position));
    return word ? { start: word.index, end: word.index + word.segment.length } : null;
  }
  /** Extend a pointer selection to a point. */
  dragTo(e) {
    const unit = this.unit?.model === this.model && this.unit;
    if (unit) {
      const position = this.point(e), other = this.textUnit(e, position, unit.presses) || { start: position, end: position };
      if (other.start < unit.start) this.model.select(unit.end, Math.min(other.start, position));
      else this.model.select(unit.start, Math.max(other.end, position, unit.end));
      this.syncInput(); this.paint(); this.onSelection();
      return;
    }
    const position = this.point(e), selection = this.model.selection;
    const extent = pointerControlSelection(selection, position);
    this.model.select(selection.anchor, position,
      position === selection.anchor && this.dragControl?.position === position &&
      this.dragControl.model === this.model && this.dragControl.revision === this.session.revision ? this.dragControl.caret
        : position === selection.anchor ? selection.controlCaret || (extent && { id: extent.id, side: 'inside' }) : undefined, extent);
    this.syncInput(); this.paint(); this.onSelection();
  }
  /**
   * While a selection drag holds the pointer near or past an edge of the view, keep scrolling (faster
   * the further out it is) and extend the selection over the text that comes under it, as native
   * selection does; the pointer need not keep moving.
   */
  autoScroll() {
    const step = () => {
      const point = this.dragPoint, bounds = this.host.getBoundingClientRect(), edge = 30;
      const speed = beyond => beyond > 0 ? Math.min(80, 8 + Math.round(beyond / 2)) : 0;
      const dy = point ? speed(point.clientY - (bounds.bottom - edge)) - speed(bounds.top + edge - point.clientY) : 0;
      const dx = point ? speed(point.clientX - (bounds.right - edge)) - speed(bounds.left + edge - point.clientX) : 0;
      if (!this.dragging || this.destroyed || !dx && !dy) { this.stopAutoScroll(); return; }
      const { scrollTop, scrollLeft } = this.host;
      this.host.scrollTop += dy; this.host.scrollLeft += dx;
      if (this.host.scrollTop !== scrollTop || this.host.scrollLeft !== scrollLeft) this.dragTo(point);
    };
    if (!this.scrollTimer) { this.scrollTimer = setInterval(step, 30); step(); }
  }
  stopAutoScroll() { clearInterval(this.scrollTimer); this.scrollTimer = null; this.dragPoint = null; }
  pointerUp(e) {
    if (this.touch?.down.pointerId === e.pointerId) {
      const { down, x, y } = this.touch;
      this.touch = null;
      if (Math.hypot(e.clientX - x, e.clientY - y) > 10) return;
      this.pointerDown(down, true);
    }
    if (this.imageInteraction.end(e)) return;
    const control = this.dragControl, wasDragging = this.dragging;
    this.dragging = false; this.dragControl = null; this.stopAutoScroll();
    if (!wasDragging || !control || this.readOnly || this.composition ||
      control.model !== this.model || control.revision !== this.session.revision) return;
    const position = this.point(e);
    if (position === control.position && this.controlPointerCaret(e, position, control.caret)?.side !== 'after') return;
    // A completed drag out of an empty persistent wrapper restores its prompt.
    // Its zero-length owner must survive the temporary drag selection, and the
    // release point must be tested again after the restored prompt reflows.
    const { scrollTop, scrollLeft } = this.host;
    const extendPrompt = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    const word = extendPrompt && new Intl.Segmenter(undefined, { granularity: 'word' }).segment(this.model.text).containing(Math.max(0, position - 1));
    const targetEnd = word?.isWordLike ? word.index + word.segment.length : position;
    this.model.select(control.position, control.position, control.caret);
    if (!this.execute(() => this.model.leaveEmptyControl(position < control.position ? 'before' : 'after'))) return;
    const exited = this.model.selection;
    this.host.scrollTop = scrollTop; this.host.scrollLeft = scrollLeft;
    const target = this.point(e), placeholder = this.model.placeholderAt(target);
    if (this.pointImage) this.model.select(this.pointImage.start, this.pointImage.end);
    else if (placeholder) {
      // As with an exit click, release inside the restored owner selects
      // through the originally targeted word, not the rest of its line.
      const end = extendPrompt && placeholder.control.id === control.caret.id
        ? Math.max(placeholder.end, targetEnd + placeholder.end - control.position) : placeholder.end;
      this.model.select(placeholder.start, end);
    }
    else this.model.select(target, target, extendPrompt && target === exited.focus ? exited.controlCaret : undefined);
    this.syncInput(); this.paint(); this.onSelection();
  }
  storyAtEvent(e, preferBody = this.session.path === null) {
    // Pointer capture retargets the double-click to the pages container.
    const canvas = this.canvases.find(canvas => { const r = canvas.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
    if (canvas) {
      const rect = canvas.getBoundingClientRect(), page = Number(canvas.dataset.page);
      const x = (e.clientX - rect.left) / this.zoom, y = (e.clientY - rect.top) / this.zoom;
      return pageStoryAtPoint(this.layout, this.storyLayout, page, x, y, preferBody);
    }
  }
  selectWord(e) {
    if (!this.readOnly) {
      const storyLine = this.storyAtEvent(e, true);
      if (storyLine && this.pageStories.stories[storyLine.pageStory].editable) this.editStory(storyLine.pageStory, storyLine.page);
      else if (this.session.path !== null) this.editStory(null);
    }
    // The second press already took the word, and a drag since extended it word by word.
    if (this.unit?.presses === 2 && this.unit.model === this.model && this.unit.path === this.session.path) return;
    const pos = this.point(e);
    if (this.pointImage) {
      this.model.select(this.pointImage.start, this.pointImage.end); this.focus(); this.onSelection(); return;
    }
    const word = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(this.model.text).containing(this.pointCharacter(e, pos));
    if (word) { this.model.select(word.index, word.index + word.segment.length); this.focus(); this.onSelection(); }
  }
  /**
   * The offset of the character under the pointer. A press resolves to the nearest caret stop, which
   * for the right half of a letter is the stop after it; the letter is the one between that stop and
   * its neighbour on the pointer's side.
   */
  pointCharacter(e, position) {
    let line;
    try { line = lineAtPosition(this.selectionLayout, position, this.caretAffinity, this.caretPage); } catch { return position; }
    const rect = this.canvases[line.page]?.getBoundingClientRect();
    if (!rect) return position;
    let x = (e.clientX - rect.left) / this.zoom;
    if (line.cellText) x = cellTextLocalPoint(line.cellText.matrix, x, (e.clientY - rect.top) / this.zoom).x;
    const local = line.cellText?.line || line, stop = nearestStop(local, x);
    if (!stop || stop.offset !== position || x === stop.x) return position;
    const side = local.stops.filter(s => x < stop.x ? s.x < stop.x : s.x > stop.x)
      .reduce((best, s) => !best || Math.abs(s.x - stop.x) < Math.abs(best.x - stop.x) ? s : best, null);
    return side && side.offset !== position ? Math.min(position, side.offset) : position;
  }
  selectParagraph(e) {
    if (this.unit?.presses === 3 && this.unit.model === this.model && this.unit.path === this.session.path) return;
    const pos = this.point(e, false);
    if (this.pointImage) return;
    const { index, offset } = locate(this.model.paragraphs, pos), start = pos - offset;
    this.model.select(start, start + paragraphText(this.model.paragraphs[index]).length);
    this.focus(); this.onSelection();
  }
  /** Where a body position sits in the scrolling host's content box, for margin annotations. */
  positionGeometry(position) {
    if (!this.layout || this.accessible) return null;
    let caret;
    try { caret = caretRect(this.layout, position, 'forward'); } catch { return null; }
    const canvas = this.canvases?.[caret.page];
    if (!canvas) return null;
    return { page: caret.page, top: canvas.offsetTop + caret.y * this.zoom, left: canvas.offsetLeft + caret.x * this.zoom, height: caret.height * this.zoom,
      pageLeft: canvas.offsetLeft, pageRight: canvas.offsetLeft + canvas.offsetWidth, pageTop: canvas.offsetTop, textRight: (() => { const g = this.layout.pages[caret.page] || this.layout.page; return canvas.offsetLeft + (g.width - (g.right || 0)) * this.zoom; })() };
  }
  revealCaret() {
    if (this.accessible) return;
    const caret = caretRect(this.selectionLayout, this.model.selection.focus, this.caretAffinity, this.caretPage), canvas = this.canvases[caret.page];
    const top = canvas.offsetTop + caret.y * this.zoom;
    if (top < this.host.scrollTop + 12) this.host.scrollTop = Math.max(0, top - 24);
    if (top + caret.height * this.zoom > this.host.scrollTop + this.host.clientHeight - 12) this.host.scrollTop = top + caret.height * this.zoom - this.host.clientHeight + 24;
    // Zoomed in, or on a narrow screen, the page is wider than the view: keep the caret in sight sideways too.
    const left = canvas.offsetLeft + caret.x * this.zoom;
    if (left < this.host.scrollLeft + 12) this.host.scrollLeft = Math.max(0, left - 24);
    else if (left > this.host.scrollLeft + this.host.clientWidth - 12) this.host.scrollLeft = left - this.host.clientWidth + 24;
  }
  move(key, shift, word, mod) {
    this.typingGroup = null; this.deleteGroup = null;
    // Arrow keys follow the physical reading axis. The reference application's
    // automation MoveUp/MoveDown calls do not perform this keyboard dispatch for rotated cells.
    const currentLine = ['ArrowUp', 'ArrowDown'].includes(key) || this.selectionLayout.hasRotatedCells && ['ArrowLeft', 'ArrowRight'].includes(key)
      ? lineAtPosition(this.selectionLayout, this.model.selection.focus, this.caretAffinity, this.caretPage) : null;
    const rotatedCrossLine = currentLine?.cellText && ['ArrowLeft', 'ArrowRight'].includes(key);
    const preferredCellId = rotatedCrossLine ? currentLine.cellId : null;
    if (this.preferredCellId !== preferredCellId) this.preferredX = null;
    this.preferredCellId = preferredCellId;
    if (rotatedCrossLine) {
      const forward = (key === 'ArrowRight' ? 1 : -1) === currentLine.cellText.matrix[2];
      key = forward ? 'ArrowDown' : 'ArrowUp';
    } else if (currentLine?.cellText) {
      const forward = (key === 'ArrowDown' ? 1 : -1) === currentLine.cellText.matrix[1];
      key = forward ? 'ArrowRight' : 'ArrowLeft';
    }
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(key)) this.preferredX = null;
    const { focus, anchor } = this.model.selection;
    // Ctrl word navigation follows the Windows native reference. Option follows
    // native Mac text fields: word starts going left, word ends going right.
    const nativeWord = word && mod;
    let target = focus, affinity = key === 'End' ? 'backward' : 'forward';
    const [start, end] = this.model.range;
    if (!shift && start !== end && ['ArrowLeft', 'ArrowRight'].includes(key)) {
      const direction = key === 'ArrowLeft' ? -1 : 1, edge = direction < 0 ? start : end;
      target = nativeWord ? this.model.promptBoundary(wordPosition(this.model.text, edge, direction, true), direction) : edge;
    }
    else if (word && !rotatedCrossLine && (key === 'ArrowUp' || key === 'ArrowDown')) {
      // Paragraph steps. Up goes to the start of this paragraph, or of the one
      // before when already there. Down goes to the next paragraph's start with
      // Ctrl, and to this paragraph's end (or the next's) with Option.
      const paragraphs = this.model.paragraphs, { index, offset } = locate(paragraphs, focus);
      const from = focus - offset, to = from + paragraphText(paragraphs[index]).length;
      if (key === 'ArrowUp') target = offset > 0 || index === 0 ? from : from - 1 - paragraphText(paragraphs[index - 1]).length;
      else if (nativeWord) target = index < paragraphs.length - 1 ? to + 1 : to;
      else target = focus < to || index === paragraphs.length - 1 ? to : to + 1 + paragraphText(paragraphs[index + 1]).length;
      affinity = key === 'ArrowDown' && !nativeWord ? 'backward' : 'forward';
      this.preferredX = null; this.caretPage = null;
    }
    else if (key === 'PageUp' || key === 'PageDown') {
      // A screenful of lines in the preferred column; the view scrolls by the
      // same distance so the caret keeps its place on screen.
      const direction = key === 'PageUp' ? -1 : 1, top = l => this.canvases[l.page].offsetTop + l.y * this.zoom;
      const from = lineAtPosition(this.selectionLayout, focus, this.caretAffinity, this.caretPage);
      this.preferredX ??= caretRect(this.selectionLayout, focus, this.caretAffinity, this.caretPage).x;
      const goal = top(from) + direction * Math.max(this.host.clientHeight - 48, 48);
      let line = from;
      for (let next; (next = verticalLine(this.selectionLayout, line, direction, this.preferredX));) {
        line = next;
        if (direction * (top(line) - goal) >= 0) break;
      }
      const stop = line === from ? null : nearestStop(line, this.preferredX);
      target = stop ? stop.offset : direction < 0 ? 0 : this.model.text.length;
      affinity = stop && (stop.affinity || (target === line.end ? 'backward' : 'forward')) || 'forward';
      this.caretPage = stop ? line.page : null;
      this.host.scrollTop += top(line) - top(from);
    }
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      if (nativeWord) target = wordPosition(this.model.text, focus, direction);
      else if (word) target = optionWordPosition(this.model.text, focus, direction);
      else {
        const stops = boundaries(this.model.text);
        target = direction < 0 ? [...stops].reverse().find(p => p < focus) ?? 0 : stops.find(p => p > focus) ?? this.model.text.length;
      }
      target = this.model.promptBoundary(target,direction);
      this.preferredX = null;
    } else {
      const line = currentLine || lineAtPosition(this.selectionLayout, focus, this.caretAffinity, this.caretPage);
      if (key === 'Home') target = mod ? 0 : line.start;
      if (key === 'End') target = mod ? this.model.text.length : line.end;
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        const readingLayout = rotatedCrossLine ? { page: { width: Infinity }, lines: [{ ...line.cellText.line, page: 0 }] } : this.selectionLayout;
        this.preferredX ??= caretRect(readingLayout, focus, this.caretAffinity, rotatedCrossLine ? null : this.caretPage).x;
        const next = verticalLine(this.selectionLayout, line, key === 'ArrowUp' ? -1 : 1, this.preferredX);
        if (next) this.preferredX += (next.columnOffset || 0) - (line.columnOffset || 0);
        const nextStop = next ? nearestStop(rotatedCrossLine ? next.cellText.line : next, this.preferredX) : null;
        target = nextStop ? nextStop.offset
          : rotatedCrossLine ? (key === 'ArrowUp' ? line.start : line.end) : key === 'ArrowUp' ? 0 : this.model.text.length;
        affinity = next && target === next.end ? 'backward' : 'forward';
        if (next?.wrapSegments?.some(s => s.stops.at(-1) === nextStop)) affinity = 'backward';
        if (nextStop?.affinity) affinity = nextStop.affinity;
        this.caretPage = next?.page ?? null;
      }
    }
    this.caretAffinity = affinity;
    if (mod && ['Home', 'End'].includes(key)) this.caretPage = null;
    let controlMove = null;
    if (shift && !word && !this.readOnly && this.model.hasPersistentControls && ['ArrowLeft', 'ArrowRight'].includes(key) && anchor === focus) {
      const selection = this.model.selection, direction = key === 'ArrowLeft' ? -1 : 1;
      const owner = selection.controlCaret?.side === 'inside' && inlineControlCaret(this.model.paragraphs, focus, selection.controlCaret);
      // Crossing an SDT boundary consumes a selection step before selecting
      // adjacent text, even when the control itself has nonempty contents.
      // Reversing that step returns to the same inside caret.
      if (owner && (owner.start === owner.end || focus === (direction < 0 ? owner.start : owner.end) || selection.controlSelection)) {
        const extent = selection.controlSelection;
        if (!extent || extent.direction !== direction) {
          // Reversing an adjacent-boundary step returns to the original
          // wrapper's boundary before reversing its first outward step.
          this.model.select(anchor, focus, extent?.adjacent ? { id: extent.id, side: 'inside' } : selection.controlCaret,
            !extent ? { id: owner.control.id, direction } : extent.adjacent ? { id: extent.id, direction: extent.direction } : undefined);
          this.syncInput(); this.paint(); this.onSelection(); return;
        }
        if (owner.start === owner.end) {
          this.execute(() => {
            this.model.leaveEmptyControl(direction < 0 ? 'before' : 'after', target);
            this.model.select(anchor, this.model.selection.focus, undefined, extent);
          });
          this.onSelection(); return;
        }
        if (!extent.adjacent) {
          const next = adjacentInlineControl(this.model.paragraphs, owner, direction);
          if (next) {
            // The neighboring SDT adds another zero-width stop. Backward
            // replacement at that junction uses its preceding wrapper.
            this.model.select(anchor, focus, direction < 0 ? { id: next.control.id, side: 'inside' } : selection.controlCaret,
              { ...extent, adjacent: next.control.id });
            this.syncInput(); this.paint(); this.onSelection(); return;
          }
        }
      }
    }
    if (!shift && this.model.hasPersistentControls) {
      if (!word && ['ArrowLeft', 'ArrowRight'].includes(key))
        controlMove = moveInlineControlCaret(this.model.paragraphs, this.model.selection, target, key === 'ArrowLeft' ? -1 : 1);
      else if (!this.readOnly && ['Home', 'End'].includes(key))
        controlMove = moveInlineControlHomeEnd(this.model.paragraphs, this.model.selection, target, key === 'Home' ? -1 : 1);
    }
    if (controlMove?.restoreEmpty && !this.readOnly) {
      const ok = this.execute(() => this.model.leaveEmptyControl(controlMove.controlCaret.side, controlMove.destination));
      if (ok && key === 'End') { this.caretAffinity = affinity; this.paint(); this.revealCaret(); }
      this.onSelection(); return;
    }
    let extent = shift ? this.model.selection.controlSelection : undefined;
    if (extent && !word && !this.readOnly && ['ArrowLeft', 'ArrowRight'].includes(key)) {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      // Once the text selection has expanded, its focus still passes through
      // rich-text control boundary stops independently of the original anchor.
      const next = anchor !== focus ? moveInlineControlCaret(this.model.paragraphs,
        { anchor: focus, focus, controlCaret: extent.focusCaret }, target, direction) : null;
      if (next && !next.restoreEmpty) {
        target = next.focus;
        extent = { ...extent, focusCaret: next.controlCaret };
      } else {
        extent = { ...extent }; delete extent.focusCaret;
        const original = inlineControlCaret(this.model.paragraphs, anchor, { id: extent.id, side: 'inside' });
        const owner = original && adjacentInlineControl(this.model.paragraphs, original, direction);
        if (owner && owner.start < target && target < owner.end) extent.focusCaret = { id: owner.control.id, side: 'inside' };
      }
    }
    if (controlMove) this.model.select(controlMove.anchor, controlMove.focus, controlMove.controlCaret);
    else this.model.select(shift ? anchor : target, target,
      !shift && mod && key === 'Home' && this.model.hasPersistentControls ? documentStartControlCaret(this.model.paragraphs) : undefined, extent);
    this.syncInput(); this.paint(); this.revealCaret(); this.onSelection();
  }
  keydown(e) {
    if (e.isComposing || this.composition || e.keyCode === 229) return;
    if (this.imageInteraction.keydown(e)) return;
    if (e.key === 'F9' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault(); if (this.onUpdateFields) this.onUpdateFields(); else this.updatePageReferences(); return;
    }
    const leaveWithTab = e.key === 'Tab' && this.leaveWithTab;
    this.leaveWithTab = false;
    // A letter chord follows the letter the layout types (QWERTZ moves Z, AZERTY moves A), and the
    // physical key only when the layout types another script there.
    const mod = e.ctrlKey || e.metaKey, typed = e.key || '';
    const letter = /^[a-z]$/i.test(typed) ? typed.toLowerCase() : [...typed].length === 1 && /\p{L}/u.test(typed) ? /^Key([A-Z])$/.exec(e.code || '')?.[1].toLowerCase() || '' : '';
    if (mod && !e.altKey && !e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault(); this.clearDirectTextFormatting(); return;
    }
    // A shifted chord is another shortcut (Shift+A is all caps, not select all); only redo shares its letter with undo.
    if (mod && !e.altKey && (!e.shiftKey || letter === 'z') && ['b', 'i', 'u', 'z', 'y', 's', 'a', 'k', 'j'].includes(letter)) {
      e.preventDefault();
      if (letter === 'b') this.toggleBold();
      if (letter === 'i') this.toggleItalic();
      if (letter === 'u') this.toggleUnderline();
      if (letter === 'z') e.shiftKey ? this.redo() : this.undo();
      if (letter === 'y') this.redo();
      if (letter === 's') this.onSave();
      if (letter === 'k' && !this.readOnly) this.onLink();
      if (letter === 'j') this.setParagraphFormat({ alignment: 'both' });
      if (letter === 'a') { this.model.select(0, this.model.text.length); this.syncInput(); this.paint(); this.onSelection(); }
      return;
    }
    if (e.altKey && e.shiftKey && !mod && ['ArrowLeft', 'ArrowRight'].includes(e.key) && this.model.selectedParagraphs.every(p => p.list)) {
      e.preventDefault(); this.changeListLevel(e.key === 'ArrowRight' ? 1 : -1); return;
    }
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      const done = this.execute(() => mod ? (e.shiftKey ? this.model.insertColumnBreak() : this.model.insertPageBreak()) : e.shiftKey ? this.model.replace('\v') : this.model.insertParagraph());
      // A new paragraph ends the word before it, which may be an address to link.
      if (done && !mod && !e.shiftKey) {
        const caret = this.model.selection.focus, place = locate(this.model.paragraphs, caret);
        if (place.offset === 0 && place.index > 0) {
          const previous = paragraphText(this.model.paragraphs[place.index - 1]);
          this.linkTypedAddress(caret - 1 - previous.length, place.index - 1, previous.length, caret);
        }
      }
      return;
    }
    // Escape then Tab leaves the editor; Shift+Tab also keeps normal focus navigation.
    if (e.key === 'Escape') { if (this.session.path !== null) { e.preventDefault(); this.editStory(null); } else this.leaveWithTab = true; return; }
    if (e.key === 'Tab' && !mod && !e.altKey && !leaveWithTab && this.model.tableContext) {
      e.preventDefault(); this.execute(() => this.model.moveCell(e.shiftKey ? -1 : 1)); return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey && !leaveWithTab) {
      e.preventDefault(); this.insertTab(); return;
    }
    if (this.accessible) return; // Native textarea navigation in accessible text mode.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      if (e.metaKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) this.move(e.key === 'ArrowLeft' ? 'Home' : 'End', e.shiftKey, false, false);
      // Cmd+Up and Cmd+Down go to the start and end of the document on a Mac.
      else if (e.metaKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) this.move(e.key === 'ArrowUp' ? 'Home' : 'End', e.shiftKey, false, true);
      else this.move(e.key, e.shiftKey, e.altKey || e.ctrlKey, mod);
    } else if (['Backspace', 'Delete'].includes(e.key) && !mod && !e.altKey) {
      // Shift+Delete on a selection is Cut on Windows and Linux; the browser's own key binding sends
      // the cut event (copy, then delete), or a plain forward delete on a Mac.
      if (e.key === 'Delete' && e.shiftKey && this.model.range[0] !== this.model.range[1]) return;
      e.preventDefault(); this.deleteText(e.key === 'Backspace' ? -1 : 1);
    }
  }
  beforeInput(e) {
    if (this.readOnly || this.viewOnly) { e.preventDefault(); return; }
    if (e.isComposing || this.composition || !e.cancelable) return;
    this.nativeSelection();
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); e.inputType === 'historyUndo' ? this.undo() : this.redo(); return; }
    const actions = {
      insertText: () => this.model.replace(e.data || ''),
      insertLineBreak: () => this.model.replace('\v'),
      insertParagraph: () => this.model.insertParagraph(),
      deleteContentBackward: () => this.model.delete(-1),
      deleteContentForward: () => this.model.delete(1),
      // Cmd+Backspace and Cmd+Fn+Backspace on a Mac. The native field's line is the whole paragraph.
      deleteSoftLineBackward: () => this.deleteToLineEdge(-1),
      deleteSoftLineForward: () => this.deleteToLineEdge(1),
      formatBold: () => this.model.toggleBold(),
      formatStrikeThrough: () => this.model.setRunFormat({ strikethrough: this.model.runFormatting.strikethrough === 'single' ? 'none' : 'single' }),
      formatItalic: () => this.model.toggleItalic(), formatUnderline: () => this.model.toggleUnderline(),
      formatJustifyFull: () => this.model.setParagraphFormat({ alignment: 'both' }),
      formatRemove: () => this.model.clearDirectTextFormatting(),
    };
    if (e.inputType === 'insertText') { e.preventDefault(); this.typeText(actions.insertText, e.data || ''); return; }
    if (actions[e.inputType]) { e.preventDefault(); this.execute(actions[e.inputType]); }
  }
  /** Delete from the caret to the start (or end) of its line as laid out, or the selection. */
  deleteToLineEdge(direction) {
    const [start, end] = this.model.range;
    if (start !== end) return this.model.replace('');
    const line = lineAtPosition(this.selectionLayout, start, this.caretAffinity, this.caretPage);
    const edge = direction < 0 ? line.start : line.end;
    // At the edge already, the key deletes what is across it, as Backspace or Delete would.
    if (edge === start) return this.model.delete(direction);
    this.model.select(Math.min(start, edge), Math.max(start, edge));
    return this.model.replace('');
  }
  // Typing continues one undo step until a new word starts.
  // Any other change, caret move, undo or story switch ends it.
  typeText(action, text) {
    const group = this.typingGroup, [start, end] = this.model.range;
    const newWord = /\S/u.test(text[0] || '') && /\s/u.test(group?.last || '');
    const merge = !!group && !newWord && start === end && group.at === start &&
      group.revision === this.session.revision && group.path === this.session.path;
    this.typingGroup = null;
    if (this.execute(action, undefined, { record: !merge })) {
      this.typingGroup = { revision: this.session.revision, path: this.session.path, at: this.model.selection.focus, last: text.at(-1) };
      if (text.length === 1) this.assistTyping(text);
    }
  }
  // A run of Backspace (or Delete) presses is one undo step,
  // until the caret moves or anything else changes.
  deleteText(direction) {
    const group = this.deleteGroup, [start, end] = this.model.range;
    const merge = !!group && start === end && group.direction === direction && group.at === start &&
      group.revision === this.session.revision && group.path === this.session.path;
    this.deleteGroup = null; this.typingGroup = null;
    if (this.execute(() => this.model.delete(direction), undefined, { record: !merge }))
      this.deleteGroup = { direction, at: this.model.selection.focus, revision: this.session.revision, path: this.session.path };
  }
  // Corrections and links made as you type (the host decides which, from its
  // settings). Each is its own undo step, so Undo takes back the change alone.
  assistTyping(typed) {
    const paragraphs = this.model.paragraphs, at = this.model.selection.focus, { index, offset } = locate(paragraphs, at);
    const fix = this.correctTyping?.(paragraphText(paragraphs[index]).slice(0, offset), typed, { list: !!paragraphs[index].list });
    if (fix && fix.back <= offset && fix.text !== undefined) {
      this.execute(() => {
        this.model.select(at - fix.back, at);
        const changed = this.model.replace(fix.text);
        // A typed list marker ("* ", "1. ") becomes a list.
        if (fix.list) this.model.toggleList(fix.list);
        return changed;
      }, undefined, undefined, true);
      if (fix.list) return;
    }
    if (/\s/.test(typed)) {
      const caret = this.model.selection.focus, place = locate(this.model.paragraphs, caret);
      this.linkTypedAddress(caret - place.offset, place.index, place.offset - 1, caret);
    }
  }
  /** Link the web address or email ending at `end` in a paragraph starting at `from`, and leave the caret at `caret`. */
  linkTypedAddress(from, index, end, caret) {
    const candidate = this.linkTyping?.(paragraphText(this.model.paragraphs[index]), end);
    if (!candidate) return;
    this.execute(() => {
      this.model.select(from + candidate.start, from + candidate.end);
      const linked = !this.model.hyperlink && this.model.setHyperlink(candidate.href);
      if (linked) showLink(this.model);
      this.model.select(caret);
      return linked;
    }, undefined, undefined, true);
    this.typingGroup = null;
  }
  reconcile(value, checkpoint) {
    const old = this.inputText;
    if (old === value) return false;
    const selection = this.model.selection, at = selection.focus, added = value.length - old.length;
    // Identical neighboring text makes a longest-prefix diff ambiguous. Keep an
    // insertion at its selected SDT boundary when the native value permits it.
    if (selection.controlCaret && selection.anchor === at && added > 0 &&
        value.slice(0, at) === old.slice(0, at) && value.slice(at + added) === old.slice(at)) {
      return this.model.replace(value.slice(at, at + added), { checkpoint });
    }
    let start = 0, end = old.length, tail = value.length;
    while (start < end && start < tail && old[start] === value[start]) start++;
    // Keep diffs at complete grapheme boundaries, including composed emoji.
    const points = boundaries(old);
    start = [...points].reverse().find(p => p <= start) ?? 0;
    while (end > start && tail > start && old[end - 1] === value[tail - 1]) { end--; tail--; }
    const safeEnd = points.find(p => p >= end) ?? old.length;
    tail += safeEnd - end; end = safeEnd;
    const typingFormat = this.model.typingFormat, typingStyle = this.model.typingStyle, typingDirectCleared = this.model.typingDirectCleared;
    const controlCaret = start === end && start === selection.anchor && end === selection.focus ? selection.controlCaret : undefined;
    const sameRange = start === Math.min(selection.anchor, selection.focus) && end === Math.max(selection.anchor, selection.focus);
    this.model.select(sameRange ? selection.anchor : start, sameRange ? selection.focus : end, controlCaret, sameRange ? selection.controlSelection : undefined);
    this.model.typingFormat = typingFormat; this.model.typingStyle = typingStyle; this.model.typingDirectCleared = typingDirectCleared;
    return this.model.replace(value.slice(start, tail), { checkpoint });
  }
  nativeInput() {
    if (this.readOnly || this.viewOnly) { this.syncInput(); return; }
    try {
      const revision = this.session.revision;
      this.session.run(() => {
        const value = this.input.value, a = this.input.selectionStart, b = this.input.selectionEnd;
        this.reconcile(value, false);
        const typingFormat = this.model.typingFormat, typingStyle = this.model.typingStyle, typingDirectCleared = this.model.typingDirectCleared;
        if (this.inputText === value) {
          const selection = this.model.selection;
          this.model.select(a, b, a === selection.anchor && b === selection.focus ? selection.controlCaret : undefined, a === selection.anchor && b === selection.focus ? selection.controlSelection : undefined);
        }
        this.model.typingFormat = typingFormat; this.model.typingStyle = typingStyle; this.model.typingDirectCleared = typingDirectCleared;
      }, () => { this.validateStory(); this.relayout(); this.revealCaret(); }, { record: !this.composition });
      if (!this.composition && revision !== this.session.revision) this.onChange();
    } catch (e) {
      if (this.composition) this.input.value = this.inputText;
      this.onError(e); this.relayout();
    }
  }
  finishComposition() {
    if (!this.composition) return;
    const before = this.composition;
    try { this.session.run(() => this.reconcile(this.input.value, false), () => this.validateStory(), { record: false }); }
    catch (e) { this.session.restore(before); this.onError(e); }
    this.composition = null;
    const changed = JSON.stringify(before.state.paragraphs) !== JSON.stringify(this.model.paragraphs);
    if (changed) this.session.record(before);
    this.relayout();
    if (changed) this.onChange();
  }
  copy(e, cut) {
    if (this.composition || !e.clipboardData) return;
    const [start, end] = this.model.range;
    if (start === end) return;
    e.preventDefault();
    const { text, html } = this.clipboardData();
    e.clipboardData.setData('text/plain', text);
    if (html) e.clipboardData.setData('text/html', html);
    if (cut) this.execute(() => this.model.replace(''));
  }
  /** The selection as plain text, and as formatted HTML when it holds only text. */
  clipboardData() {
    const fragment = copyFragment(this.model);
    return { text: this.model.clipboardText(), html: fragment ? fragmentHtml(fragment) : '' };
  }
  /** Paste with the clipboard's formatting where the document can take it, else as plain text. */
  pasteData(text, html = '') {
    const fragment = html && carriesFormatting(this.model) && !this.model.tableContext ? htmlFragment(html) : null;
    if (fragment && fragment.paragraphs.some(p => p.text) && formattedPasteFits(fragment) && this.execute(() => pasteFragment(this.model, fragment), () => {}, undefined, true)) return;
    if (text) this.execute(() => this.model.replace(text));
  }
  releaseImages(images) { for (const image of images.values()) if (!this.borrowedImages.has(image)) image.close?.(); images.clear(); }
  destroy() {
    if (this.paintTask) (this.paintTask.idle ? cancelIdleCallback : clearTimeout)(this.paintTask.id);
    this.destroyed = true; this.stopAutoScroll(); this.abort.abort(); this.releaseImages(this.images); this.borrowedImages.clear(); this.host.replaceChildren(); }
}
