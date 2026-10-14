import { workbookPathUri } from '../core/workbook-location.js';
import { conditionalFontStyle } from '../core/style-values.js';
import { openSparklineDialog } from '../ui/sparklinedialog.js';
import { openSparklineCreateDialog } from '../ui/sparklinecreatedialog.js';
import { openSlicerDialog } from '../ui/slicerdialog.js';
import { openInsertSlicersDialog } from '../ui/insertslicers.js';
import { openInsertTimelineDialog, openTimelineSettingsDialog } from '../ui/inserttimeline.js';
import { deleteTimeline } from '../core/timeline.js';
import { openTableResizeDialog } from '../ui/tableresize.js';
import { setTableHeaderRow, setTableFilterButton, tableFilterButtonOn } from '../core/table-header-row.js';
import { nativePivotAt, tableSlicerProblem } from '../core/slicer-insert.js';
import { slicerClipboard, readSlicerClipboard } from '../ui/slicer.js';
import { slicerItems } from '../core/slicer.js';
import { filterValueIdentity } from '../core/sheet-filters.js';
import { openScrollDialog } from '../ui/scrolldialog.js';
import { scrollControlValue, scrollControlTarget } from '../core/scroll-control.js';
import { scrollControlClipboard, readScrollControlClipboard } from '../ui/scroll-control.js';
import { conditionalFormulaFields } from '../core/conditional-scale.js';
/**
 * The editor screen: top bar, formatting toolbar, formula bar, grid, sheet
 * tabs, and status bar around one open Doc. Everything the toolbar, menus,
 * and shortcuts can do goes through ctx.run(command), so each action has
 * exactly one implementation.
 */
import { imageToPng } from '../ui/picture-raster.js';

import { isComposing, el, isMod, MOD_KEY, IS_MAC, formatBytes } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createGrid } from '../ui/grid.js';
import { ACCOUNTING_CODE, accountingCode, isAccountingCode, FONT_SIZES, ptToPx, pxToPt } from '../ui/toolbar.js';
import { createRibbon } from '../ui/ribbon.js';
import { createInk } from '../ui/ink.js';
import { openInsertDeleteDialog } from '../ui/insertdeletedialog.js';
import { openSymbolDialog } from '../ui/symboldialog.js';
import { shapeSvg, iconSvg, svgDataUrl, openShapesMenu, openIconsDialog } from '../ui/shapes.js';
import { flashFill } from '../core/flashfill.js';
import { createWatchWindow } from '../ui/watchwindow.js';
import { createAccessibilityPane } from '../ui/accessibility-pane.js';
import { createChangesPane } from '../ui/changes-pane.js';
import { openAltTextDialog } from '../ui/alttext.js';
import { invalidCells } from '../core/validation-circles.js';
import { openRecommendedPivots } from '../ui/recommended-pivots.js';
import { createErrorSmartTag, openErrorCheckingOptions } from '../ui/error-smarttag.js';
import { createQuickAnalysis } from '../ui/quick-analysis.js';
import { quickTotalEntries } from '../core/quick-totals.js';
import { createComments, COMMENT_COMMANDS } from '../ui/comments.js';
import { copyThreads, pasteThreads } from '../core/comments.js';
import { pageBreaks, pagesOf, insertBreaks, removeBreaks, hasBreakAt, moveBreak, moveAreaEdge } from '../ui/pagebreaks.js';
import { createPageLayout } from '../ui/page-layout.js';
import { consolidate } from '../core/consolidate.js';
import { openConsolidateDialog } from '../ui/consolidatedialog.js';
import { attachKeyTips } from '../ui/keytips.js';
import { createFormulaBar } from '../ui/formulabar.js';
import { createSheetTabs, sheetHoldsWork } from '../ui/sheettabs.js';
import { openCopySheetDialog } from '../ui/copysheet.js';
import { openMoveSheetDialog } from '../ui/movesheet.js';
import { placeSheet } from '../core/sheet-placement.js';
import { openImportPlacementDialog } from '../ui/importdialog.js';
import { openTextBoxDialog } from '../ui/textboxdialog.js';
import { rangeLink } from '../lib/links.js';
import { chipFor, isRangeSource, checkValue } from '../core/validation.js';
import { createStatusBar } from '../ui/statusbar.js';
import { createFindBar } from '../ui/findbar.js';
import { openPrintDialog, currentPrintPrefs } from '../ui/printdialog.js';
import { installSheetFontLoading } from '../ui/sheet-fonts.js';
import { installPrintFallback } from '../ui/print.js';
import { openNamesManager } from '../ui/names.js';
import { openCreateNamesDialog } from '../ui/createnames.js';
import { conditionalFormattingItems, openQuickRuleDialog, presetRule, clearRules } from '../ui/condformat-quick.js';
import { normalizePrintSettings } from '../core/print-settings.js';
import { rememberFunction } from '../ui/recent-functions.js';
import { openInsertFunctionDialog, openFunctionArgumentsDialog } from '../ui/insertfunction.js';
import { openConditionalFormatting } from '../ui/condformat.js';
import { openValidationManager } from '../ui/validation.js';
import { openSortDialog, looksLikeHeader, sortHeaderDefault, rearrangeProblem } from '../ui/sortdialog.js';
import { openChartDialog } from '../ui/chartdialog.js';
import { runChartAction, insertChart as insertExcelChart, insertChartSheet } from '../ui/chart-actions.js';
import { createChartUi } from '../ui/chart-format-pane.js';
import { openTemplatePicker } from '../ui/templates.js';
import { openSubtotalDialog } from '../ui/subtotaldialog.js';
import { openDataForm } from '../ui/dataform.js';
import { openEditLinks, updateAllLinks } from '../ui/editlinks.js';
import { openFormatCellsDialog } from '../ui/formatcells.js';
import { openTableDialog } from '../ui/tabledialog.js';
import { openAiDialog } from '../ui/aidialog.js';
import { createAiPanel, loadAiSettings } from '../ui/aipanel.js';
import { openEvaluateDialog } from '../ui/evaluatedialog.js';
import { resolveImportPath, parseImportRange, readImportRange, rowsFromDelimited, rowsFromHtml, rowsFromXml, importNameFor, sniffImageType } from '../core/importrange.js';
import { resolveTableSpec, TABLE_STYLES } from '../core/tables.js';
import { signatureFor } from '../core/formula/hints.js';
import { openPivotDialog } from '../ui/pivotdialog.js';
import { openSeriesDialog } from '../ui/seriesdialog.js';
import { openGoalSeek } from '../ui/goalseek.js';
import { openDataTable } from '../ui/datatable.js';
import { openForecastSheet } from '../ui/forecast-sheet.js';
import { openScenarioManager } from '../ui/scenario-manager.js';
import { openSolver } from '../ui/solver.js';
import { openDataAnalysis } from '../ui/analysis-tools.js';
import { openCustomViews } from '../ui/customviews.js';
import { openZoomDialog } from '../ui/zoomdialog.js';
import { openSheetViewOptions, askViewName, nextViewName } from '../ui/sheetviews.js';
import { createSelectionPane } from '../ui/selection-pane.js';
import { createSmartArtUi, runSmartArtAction, smartArtLook } from '../ui/smartart.js';
import { createSmartArtPane } from '../ui/smartart-pane.js';
import { smartArtSvg, smartArtAltText } from '../core/smartart.js';
import { arrangeTargets } from '../ui/arrange-ribbon.js';
import { openAdvancedFilter } from '../ui/advanced-filter.js';
import { fromText as getDataText, fromWorkbook as getDataWorkbook, fromWeb as getDataWeb, fromTable as getDataTable, blankQuery, queryIo, fitQueryTables } from '../ui/get-data.js';
import { openQueryEditor } from '../ui/query-editor.js';
import { createQueriesPane } from '../ui/queries-pane.js';
import { createAutomate, AUTOMATE_COMMANDS, scriptOfLink } from '../ui/automate.js';
import { createPictures, PICTURE_COMMANDS } from '../ui/pictures.js';
import { isCellPicture } from '../core/cell-picture.js';
import { pictureIsPlain } from '../core/picture-format.js';
import { linkedPictureTarget, rangePicture } from '../core/range-picture.js';
import { refreshAll as refreshAllQueries, refreshQuery as refreshOneQuery, queryById, queryForTable } from '../core/queries.js';
import { clearSheetFilters, reapplySheetFilters } from '../core/advanced-filter.js';
import { toggleDetail } from '../core/outline-detail.js';
import { openDatePicker } from '../ui/datepicker.js';
import { openDedupeDialog } from '../ui/dedupedialog.js';
import { openTextToColumnsDialog } from '../ui/textcolumnsdialog.js';
import { openProtectedRanges } from '../ui/protect.js';
import { openColumnStats } from '../ui/colstats.js';
import { cellStyle } from '../core/cellstyles.js';
import { definitionFor, stylePatch, customStyleNamed, builtinOverride } from '../core/custom-cell-styles.js';
import { openCellStylesGallery, openStyleDialog, openMergeStylesDialog, saveCellStyle, deleteCellStyle } from '../ui/cellstyles-ui.js';
import { autoOutline, clearOutline, applyOutlineStyles } from '../core/auto-outline.js';
import { openOutlineSettings } from '../ui/outline-settings.js';
import { renderChartSvg, standaloneSvg, setThemeSeriesColors } from '../ui/chartsvg.js';
import { openWordArtMenu } from '../ui/wordart.js';
import { openEquationDialog, runInsertEquation } from '../ui/equation.js';
import { openThemeEffectsMenu } from '../ui/theme-effects.js';
import { openThemesMenu, openThemeColorsMenu, openThemeFontsMenu } from '../ui/themes.js';
import { themedPreset, themedCellStylePatch, themedSeriesColors } from '../core/workbook-theme.js';
import { chartData } from '../core/charts.js';
import { chartSheetCommand } from '../core/chartsheet.js';
import { openCellContextMenu } from '../ui/contextmenu.js';
import { openMenu } from '../ui/menu.js';
import { openValuePicker } from '../ui/listpicker.js';
import { promptDialog, openModal, confirmDialog, fieldAlert } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { confirmValidation, validationAlertStyle } from '../ui/validation-alert.js';
import { openAppMenu, openLocaleDialog, openAbout, renderAccountButton } from '../ui/appmenu.js';
import { createMenubar, SPECIAL_KINDS } from '../ui/menubar.js';
import { paletteCommands, openCommandPalette } from '../ui/palette.js';
import { openVersionHistory } from '../ui/versions.js';
import { openShareDialog } from '../ui/share.js';
import { openSendCopyDialog, openSendLinkDialog } from '../ui/send-mail.js';
import { createMentionNotifier, createMentionAlerts } from '../ui/mention-notify.js';
import { createMailer } from '../lib/mail.js';
import { createPeopleBar, peopleHere, roomStatus } from '../ui/coauthor.js';
import { mapLine, mapGap } from '../collab/ops.js';
import { openShortcuts } from '../ui/shortcuts.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';
import { trackEvent } from '../lib/analytics.js';
import { VIEW_ONLY, autoSaveEnabled } from '../lib/doc.js';
import { cellName, colName, normalizeRange, rangeName, parseRange, parseCellRef, parseKey } from '../core/cell.js';
import { parseRefText, MAX_ROW, MAX_COL } from '../core/refs.js';
import { formatValue, todaySerial, formatDate, fontStack, indentWidth, parseInput, MAX_DECIMAL_PLACES, AUTOMATIC_FORMAT, cellCurrency, currencyDecimals, localeInfo, editText } from '../core/format.js';
import { maxLineWidth, cellLayoutText } from '../core/textfit.js';
import { toDelimited, parseClipboard, parseDelimited } from '../core/tsv.js';
import { detectDelimiter, workbookFromFile, rangeToCsv, CSV_MIME } from '../core/io.js';
import { cellsToHtml, copyMergeLayout, parseHtmlClipboard, cellsFromHtmlRows, isOwnHtmlClipboard } from '../core/clipboard.js';
import { eachStoredCell, lineSpan } from '../core/sparse-range.js';
import { MAX_ROWS, MAX_COLS, MIN_COL_WIDTH, MAX_COL_WIDTH, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT, cellFromInput, safeLinkUrl } from '../core/workbook.js';
import { isSpreadsheetFile } from '../core/filetypes.js';
import { FUNCTION_NAMES } from '../core/formula/functions.js';
import { RULE_TYPES } from '../core/condformat.js';
// Formulas that reach outside the spreadsheet: pasted from a web page they could send the sheet's
// contents anywhere, so such a paste asks first, as a file from elsewhere does (the same list serves both).
import { formulaReachesOut, textReachesOut } from '../core/reaches-out.js';
import * as S from '../core/selection.js';
import { formatNativePivotBorders, formatNativePivotStyleAndBorders } from '../core/native-pivot-border-selection.js';
import { formatNativePivotSelection, clearNativePivotSelection, pasteNativePivotStyles, pasteNativePivotClipboardStyles } from '../core/native-pivot-style-selection.js';
import { pasteOptions, legacyMode, pasteLabel, composePaste, cellsFromText } from '../core/paste-special.js';
import { refill, autoFillChoices, defaultAutoFill, justifyLines } from '../core/autofill-options.js';
import { openPasteSpecialDialog, openInsertPasteDialog, pasteGallery } from '../ui/pastespecialdialog.js';
import { createOptionButton } from '../ui/option-button.js';
import { GROUP_BLOCKED_COMMANDS, GROUP_BLOCKED_REASON } from '../core/sheet-group.js';
import { openFillAcrossDialog } from '../ui/fillacross.js';
import { createAutoCorrector, openAutoCorrectDialog, syncAutoCorrectSettings } from '../ui/autocorrect.js';
import { appOptions, appOption, setAppOptions, onAppOptions, syncAppOptions, displayUserName } from '../lib/app-options.js';
import { installAppOptions } from '../lib/apply-options.js';
import { syncCustomizations, keymapStore, parseCommandId } from '../lib/customize.js';
import { chordFromEvent } from '../core/keymap.js';
import { listExtension } from '../core/entry-options.js';
import { openOptionsDialog } from '../ui/options-dialog.js';
import { createQuickAccess } from '../ui/quick-access.js';
import { withCustomShortcuts } from '../ui/custom-shortcuts.js';
import { syncErrorChecking } from '../ui/error-smarttag.js';
import { isFormulaText } from '../core/autocorrect.js';
import { openSpellingDialog } from '../ui/spelling.js';
import { createLanguagePane } from '../ui/language-pane.js';
import { translatePrompt } from '../core/formula/functions.js';

const MAX_FORMAT_CELLS = 20000;
// Clipboard height can exceed JavaScript's argument limit, even when the
// cells ultimately pasted are clipped to the sheet's supported dimensions.
const clipboardWidth = (rows) => rows.reduce((width, row) => Math.max(width, row.length), 0);
export function editorView({ doc, goHome, openPath, newDoc, templateDoc, importFile, openLive = null, initialRange = null, leaveDialog = null }) {
  let destroyed = false;
  let palette = null; // the open command palette, closed with the view
  const { wb } = doc;
  // Charts without colours of their own draw in the theme's accents once one is chosen. Listening before the grid
  // does, the palette is in place when a theme change redraws them.
  const syncChartTheme = () => setThemeSeriesColors(themedSeriesColors(wb));
  syncChartTheme();
  wb.addEventListener('change', syncChartTheme);
  // The app's options (File ▸ Options): applied before anything reads them, AI features among them.
  installAppOptions();
  // AI() formulas ask Puter's AI; without the SDK, or with AI features turned off in the options, they show #N/A.
  // TRANSLATE and DETECTLANGUAGE: the same AI, with the reply tidied to just the answer. Review ▸ Translate asks the same way.
  const aiTranslate = async (prompt) => String(await P.aiChat(prompt, { feature: 'translate' })).trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');
  const setAiProviders = () => {
    wb.setAsyncProvider('AI', P.canAI() ? (text) => P.aiChat(text) : null);
    wb.setAsyncProvider('TRANSLATE', P.canAI() ? aiTranslate : null);
    wb.setAsyncProvider('DETECTLANGUAGE', P.canAI() ? async (text) => { const m = /\b([a-z]{2,3})(?:-[A-Za-z]{2,4})?\b/i.exec(String(await P.aiChat(text, { feature: 'detect-language' })).trim()); return m ? m[1].toLowerCase() : { error: '#N/A' }; } : null);
  };
  setAiProviders();
  // A fetch that failed: too much data, or an address off the public internet (this computer, a
  // private network), is a #VALUE! that says so (the status bar shows the reason); anything else
  // (offline, a missing page) stays #N/A, with the reason as well. The fetch helpers mark both
  // refusals with a code, so a server's own wording is never mistaken for them.
  const explained = (e) => e?.code === 'too-large' || e?.code === 'not-public';
  const fetchError = (e) => ({ error: explained(e) ? '#VALUE!' : '#N/A', message: e?.message || undefined });
  // The URL dialogs refuse such an address before fetching, where the helper can tell one apart.
  const NOT_PUBLIC = 'Only addresses on the public internet can be fetched, not this computer’s or a private network’s';
  const urlProblem = (v) => {
    const text = String(v).trim();
    if (!/^https?:\/\/\S+$/i.test(text)) return 'Enter a web address starting with http:// or https://';
    return (P.isPublicHttpUrl?.(text) ?? true) ? null : NOT_PUBLIC;
  };
  // IMPORTDATA: a CSV or TSV from the web, through Puter's fetch.
  wb.setAsyncProvider('IMPORTDATA', async (text) => {
    const [url, delimiter] = JSON.parse(text);
    let body;
    try { body = await P.fetchText(url); } catch (e) { return fetchError(e); }
    return rowsFromDelimited(body, delimiter, { detectDelimiter, parseDelimited, parseInput });
  });
  // IMPORTHTML: a table or list from a web page.
  wb.setAsyncProvider('IMPORTHTML', async (text) => {
    const [url, kind, index] = JSON.parse(text);
    let body;
    try { body = await P.fetchText(url); } catch (e) { return fetchError(e); }
    return rowsFromHtml(body, kind, index, parseInput);
  });
  // IMPORTXML: nodes picked by XPath from a web document.
  wb.setAsyncProvider('IMPORTXML', async (text) => {
    const [url, xpath] = JSON.parse(text);
    let body;
    try { body = await P.fetchText(url); } catch (e) { return fetchError(e); }
    return rowsFromXml(body, xpath, parseInput);
  });
  // WEBSERVICE: the text a web address answers with; the cell text limit applies.
  wb.setAsyncProvider('WEBSERVICE', async (url) => {
    let body;
    try { body = await P.fetchText(url); } catch (e) { return fetchError(e); }
    return String(body).length > 32767 ? { error: '#VALUE!' } : String(body);
  });
  // IMPORTRANGE: other spreadsheets on the drive, parsed once and kept for a short while.
  const imported = new Map(); // path → { at, wb: Promise<Workbook> }
  wb.setAsyncProvider('IMPORTRANGE', async (text) => {
    const [file, range] = JSON.parse(text);
    const path = resolveImportPath(file, P.FOLDER, P.ensureXlsx);
    const spec = parseImportRange(range);
    if (!path || !spec) return { error: '#REF!' };
    const now = Date.now();
    let entry = imported.get(path);
    if (!entry || now - entry.at > 30000) {
      entry = { at: now, wb: P.readFile(path).then((bytes) => workbookFromFile(bytes, P.displayName(path))) };
      imported.set(path, entry);
    }
    let other;
    try { other = await entry.wb; } catch (e) { imported.delete(path); return { error: P.isNotFound(e) ? '#REF!' : '#N/A' }; }
    return readImportRange(other, spec);
  });
  const listeners = new Set();
  let notifyQueued = false;
  let clip = null; // { cells, origin, sheetId, text }
  let painter = null; // format painter: { cells, range } copied from the selection, waiting for a target
  let tracing = null; // the sheet whose precedents/dependents are highlighted in the grid
  let circledSheet = null; // the sheet whose invalid cells are circled (Circle Invalid Data)

  // While the listeners refresh the chrome, the command flags are worked out once: the ribbon alone asks
  // for them from every button it resolves, and each asking looked the selection and the sheet up again.
  let flagsMemo = null;
  let dispatching = false;
  const notify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    requestAnimationFrame(() => {
      notifyQueued = false;
      dispatching = true;
      flagsMemo = null;
      try { for (const fn of listeners) fn(); } finally { dispatching = false; flagsMemo = null; }
    });
  };

  // Email from this workbook: Send a copy, Send a link, and @mention notes (lib/mail.js).
  const mailer = createMailer();

  /* ---------- Context shared by the components ---------- */

  // Text was pasted into the entry under way (the in-cell editor or the formula bar). Pasted text is outside
  // content, as a paste onto the grid is: a formula in it that reaches out is not let out on the strength of
  // the paste alone, while the same formula typed by hand is consent. Cleared when the entry ends.
  let entryPasted = false;

  const ctx = {
    wb,
    doc,
    saveSourceForCopy: async () => await flush({ leaving: false }) && doc.status === 'saved' && !!doc.path && !doc.hasPendingWrites,
    grid: null,
    sheetId: () => grid.sheetId,
    range: () => grid.range,
    ranges: () => grid.ranges,
    active: () => grid.active,
    selection: () => grid.selection,
    activeCell: () => wb.getCell(grid.sheetId, grid.active.r, grid.active.c),
    // The style a formatting command reads and toggles: the cell being edited while one is (on its own sheet), else the active cell.
    style: () => styleTarget().style,
    dataRange: (fallback) => dataRange(fallback),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    announce: (text) => statusBar?.announce(text),
    painting: () => !!painter,
    // What the menu bar and the palette read (merged, singleCell, ...), for the cell menu to grey its items the same way.
    flags: () => (dispatching ? (flagsMemo ??= commandFlags()) : commandFlags()),
    // The formula bar says when text was pasted into the entry under way (see `entryPasted`).
    notePastedEntry: () => { entryPasted = true; },
    run,
  };

  /** A strict validation rule refused an entry: its notice, as the editor shows it for a typed entry. */
  const invalidEntry = (v, { dialog = false } = {}) => {
    if (!dialog) toast(v.message || 'That value is not allowed here', { icon: 'alert', duration: 3500 });
  };

  // AutoCorrect: words fixed as they are typed into a cell or the formula bar (Tools ▸ AutoCorrect Options).
  const autoCorrector = createAutoCorrector({ announce: (text) => statusBar?.announce(text) });
  ctx.autocorrect = autoCorrector;
  if (!session.signedOut) syncAutoCorrectSettings().catch(() => {});

  const grid = createGrid({
    wb,
    sheetId: wb.activeSheetId,
    autocorrect: autoCorrector,
    // The entry is written: its last word, corrected, is a step of its own, so Ctrl/Cmd+Z brings back what was typed.
    afterCommit: ({ sheetId: sid, r, c, text }) => {
      if (isFormulaText(text)) return;
      queueMicrotask(() => offerFlashFill(sid, r, c)); // after AutoCorrect's own step, if it takes one
      const fixed = autoCorrector.tail(text);
      if (fixed === text || editText(wb.getCell(sid, r, c)) !== text) return;
      if (wb.validateInput(sid, r, c, fixed).ok === false) return;
      wb.setInput(sid, r, c, fixed, { label: 'AutoCorrect' });
      statusBar?.announce(`AutoCorrect changed the entry to ${fixed}. ${MOD_KEY}+Z puts back what was typed`);
    },
    // Editing in cells turned off (the options): F2 and a double-click put the caret in the formula bar.
    // (Not while the formula bar is hidden: there the cell is the only place to edit.)
    onEditInBar: () => { if (!appOption('showFormulaBar') || view.focus) return false; formulaBar.focusInput(); return true; },
    // A row typed at the foot of a list takes on the list's formats and formulas (the options), in the entry's step.
    extendEntry: ({ sheetId: sid, r, c }) => {
      if (!appOption('extendLists')) return;
      const { style, formulas } = listExtension(wb, sid, r, c);
      if (style) wb.applyStyle(sid, { r1: r, c1: c, r2: r, c2: c }, style);
      for (const f of formulas) wb.setInput(sid, r, f.c, f.input);
    },
    onSelection: notify,
    onEdit: (e) => { if (e.editing) { endCut(); optionButton?.hide(); } else entryPasted = false; notify(); }, // typing into a cell ends a cut
    onCommand: (cmd, arg) => run(cmd, arg),
    onFilled: (info) => offerAutoFill(info),
    // A chart's own elements (Chart Design, Format and the Format pane) follow the chart selected on the grid.
    onChartSelection: (id) => { chartUi?.chartSelected(id); ctx.smartArt?.chartSelected(id); notify(); },
    // A SmartArt diagram draws the shapes picked in it (a click on one, or the Text Pane's cursor) framed.
    smartArtSelection: (id) => ctx.smartArt?.selected(id),
    onChartKey: (e, id) => !!chartUi?.onChartKey(e, id),
    canOpen: P.canPickFiles(), // Ctrl+O only where a file picker exists
    onContextMenu: (info) => openCellContextMenu(ctx, info),
    announce: (text) => statusBar?.announce(text),
    onZoom: () => { try { localStorage.setItem('spreadsheet:zoom', String(grid.zoom)); } catch { /* no storage */ } notify(); },
    validate: (r, c, text) => {
      // Run before a committed entry is written. Text pasted into the entry (noted here from the viewport's
      // paste event and the formula bar, or by the grid on its own editor) that reaches out is put through
      // the question a paste onto the grid gets, so the formula lands #BLOCKED! with the notice, not live.
      if ((entryPasted || grid.editState?.pasted) && textReachesOut(text)) doc.distrustExternal();
      const v = wb.validateInput(grid.sheetId, r, c, text);
      return { ok: v.ok, message: v.message, rule: v.rule, strict: v.rule ? v.rule.strict !== false : false };
    },
    onInvalid: invalidEntry,
    onListOpen: ({ r, c, rule }) => openListPicker(r, c, rule),
    onDateOpen: ({ r, c }) => openDatePicker(ctx, r, c),
    onFilterOpen: ({ r, c }) => openFilterMenu(c, r),
    // Page Break Preview: a page break or the print area's edge dragged to another line.
    onPageBreakMove: (info) => run('movePageBreak', info),
    onPrintAreaEdge: (info) => run('printAreaEdge', info),
    // Arrange ▸ Align ▸ Snap to Grid and Snap to Shape, for objects dragged on the sheet.
    snap: () => ({ grid: !!view.snapGrid, shape: !!view.snapShape }),
    // A header drag reordered rows or columns: the selection the user had before it joins the step, so
    // undoing the move puts it back, as undoing Insert or Delete rows does.
    rememberSelection: ({ sel, extras }) => rememberStepSelection({
      sheetId: grid.sheetId, ranges: [...extras, S.selRange(sel)].map((rg) => ({ ...rg })), active: { ...sel.active },
    }),
  });
  ctx.grid = grid;
  // SmartArt: the shapes picked in a diagram, and its Text Pane (made below with the other task panes).
  ctx.notify = notify;
  ctx.refused = (what) => refusedByProtection(what);
  ctx.smartArt = createSmartArtUi(ctx);
  // The Paste Options and Auto Fill Options button, at the corner of what was just pasted or filled.
  const optionButton = createOptionButton({ grid, host: grid.el });
  let lastPaste = null; // { text, html, paste, from, mark, external }: what the Paste Options button pastes again
  let lastFill = null; // { sheetId, source, target, mark, kind }: what the Auto Fill Options button fills again
  ctx.subscribe(() => optionButton.place());
  const chartUi = ctx.chartUi = createChartUi({ ...ctx, wb, grid, notify, onPaneToggle: () => notify() });
  // Draw tab: pens, eraser and lasso over the sheet (ui/ink.js).
  const ink = ctx.ink = createInk({ wb, grid, notify, subscribe: ctx.subscribe, refused: (what) => refusedByProtection(what), announce: (text) => statusBar?.announce(text) });
  try {
    const savedZoom = parseFloat(localStorage.getItem('spreadsheet:zoom'));
    if (savedZoom && savedZoom !== 1 && wb.sheet(wb.activeSheetId)?.viewZoom == null) grid.setZoom(savedZoom, true);
  } catch { /* no storage */ }
  if (wb.sheet(wb.activeSheetId)?.viewZoom != null) grid.setZoom(wb.sheet(wb.activeSheetId).viewZoom, true);

  /* ---------- View options (remembered on this device) ---------- */

  // Sheets shown in print preview this session draw their page breaks in Normal view afterwards, until
  // View ▸ Page Breaks turns them off; the sheet's own setting (showPageBreaks) is the one saved.
  const previewedSheets = new Set();
  const pageBreakLinesOn = (id) => !!wb.sheet(id)?.showPageBreaks || previewedSheets.has(id);
  let selectionPane = null; // made once the editor's commands exist (see below)
  /*
   * The sheet view each person is in is their own: remembered on this device for this file, never saved in
   * it, and taken up again when the file opens here.
   */
  const sheetViewKey = () => (doc.path ? `spreadsheet:sheet-views:${doc.path}` : null);
  function rememberSheetViews() {
    const key = sheetViewKey();
    if (!key) return;
    const mine = Object.fromEntries(wb.sheets.filter((s) => s.personalView && !s.sheetViews?.find((v) => v.id === s.personalView.id)?.temporary).map((s) => [s.id, s.personalView.id]));
    try { if (Object.keys(mine).length) localStorage.setItem(key, JSON.stringify(mine)); else localStorage.removeItem(key); } catch { /* no storage */ }
  }
  try {
    const key = sheetViewKey(), mine = key ? JSON.parse(localStorage.getItem(key) || '{}') || {} : {};
    for (const [sheetId, viewId] of Object.entries(mine)) wb.enterSheetView(sheetId, viewId, { undoable: false });
  } catch { /* no storage, or nothing remembered */ }

  const view = { focus: false, spell: true };
  try { Object.assign(view, JSON.parse(localStorage.getItem('spreadsheet:view') || '{}') || {}); } catch { /* no storage */ }
  // Header visibility now follows the saved worksheet view, not a device-wide override.
  delete view.headers;
  // The formula bar's switch moved into the person's options (View ▸ Formula bar is the same switch); a device
  // that had it off keeps it off.
  if (view.formulaBar === false && appOption('showFormulaBar')) setAppOptions({ showFormulaBar: false });
  delete view.formulaBar;
  // A sheet added here starts the way the options say: in the chosen view, with or without headers.
  const syncNewSheetDefaults = () => {
    const o = appOptions();
    wb.newSheetDefaults = { ...(o.newView !== 'normal' ? { viewMode: o.newView } : {}), ...(o.showHeaders ? {} : { headers: false }) };
  };
  syncNewSheetDefaults();
  function applyView() {
    const o = appOptions();
    root.classList.toggle('focus-mode', !!view.focus);
    // What the window shows around the sheet: View ▸ Formula bar and the options' View page.
    root.classList.toggle('no-formula-bar', !o.showFormulaBar);
    root.classList.toggle('no-status-bar', !o.showStatusBar);
    root.classList.toggle('no-sheet-tabs', !o.showSheetTabs);
    root.classList.toggle('no-hscroll', !o.showHScroll);
    root.classList.toggle('no-vscroll', !o.showVScroll);
    root.classList.toggle('no-objects', !o.showObjects);
    root.classList.toggle('no-comment-marks', o.commentIndicators === 'none');
    grid.setSpellcheck(view.spell !== false);
    try { localStorage.setItem('spreadsheet:view', JSON.stringify(view)); } catch { /* no storage */ }
  }
  const isFullscreen = () => !!document.fullscreenElement;
  async function toggleFullscreen() {
    try {
      if (isFullscreen()) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('Full screen is not available here', { icon: 'info' });
    }
  }

  /* ---------- Commands ---------- */

  /** Per-column filter menu: sort, search, and a checklist of values. */
  function openFilterMenu(c, r = grid.active.r) {
    const sheetId = grid.sheetId;
    const sheet = wb.sheet(sheetId);
    const f = wb.filterAt(sheetId, r, c) || sheet?.filter;
    if (!f) return;
    wb.activateFilter(sheetId, f);
    if (refusedByProtection('change the filter')) return;
    const header = wb.getDisplay(sheetId, f.range.r1, c) || `Column ${cellName(0, c).replace(/\d+$/, '')}`;
    const all = wb.filterValues(sheetId, c);
    const current = f.criteria[c];
    // Values the criteria still name but the column no longer holds are left out: counted, they would
    // inflate the summary, and "Select all" could never reach a state that means no filter. An entry is
    // chosen by its text, or by the number behind it: after a regional-format change the text differs
    // (1.5 reads 1,5) while the keys the filter also judges by still match, so the rows it keeps stay checked.
    const listed = new Set(all.map((v) => v.value));
    const identity = text => filterValueIdentity(text, current);
    const named = new Set((current?.values || []).map(identity));
    const chosenKeys = new Set(current?.keys || []);
    const selectedByKey = new Set();
    if (chosenKeys.size) for (const [text, keys] of wb.filterKeysByText(sheetId, c)) {
      if ([...keys].some(key => chosenKeys.has(key))) selectedByKey.add(identity(text));
    }
    const chosen = (text) => named.has(identity(text)) || selectedByKey.has(identity(text));
    const selected = new Set(current?.values ? [...listed].filter(chosen) : listed);
    let valuesChanged = false; // a checkbox, Select all or Clear was used, so the value list is what Apply stores
    const dataRange = { r1: f.range.r1 + 1, c1: f.range.c1, r2: f.range.r2, c2: f.range.c2 };

    const search = el('input.input', { type: 'search', placeholder: 'Search values', 'aria-label': 'Search values', autocomplete: 'off' });
    const listEl = el('div.filter-values', { role: 'group', 'aria-label': 'Values' });
    const summary = el('div.filter-summary');
    // Filter by condition: any comparison the conditional-formatting rules know.
    const CONDITIONS = RULE_TYPES.filter((t) => !t.scale && !t.rangeWide && !t.date && !t.databar && !t.bands && !t.icons);
    const condSelect = el('select.input.filter-cond', { 'aria-label': 'Condition' },
      el('option', { value: '' }, 'No condition'),
      ...CONDITIONS.map((t) => el('option', { value: t.value }, t.label)));
    const condValue = el('input.input', { type: 'text', 'aria-label': 'Condition value', placeholder: 'Value', autocomplete: 'off' });
    const condValue2 = el('input.input', { type: 'text', 'aria-label': 'Second value', placeholder: 'and', autocomplete: 'off' });
    // A refused condition names its field, marked invalid and described by the message, as the dialogs' fields are.
    const { alert: condError, refuse: refuseCond, clear: clearCond } = fieldAlert('filter-cond');
    if (current?.op) { condSelect.value = current.op; condValue.value = current.value ?? ''; condValue2.value = current.value2 ?? ''; }
    if (current?.formula) { condSelect.value = 'formula'; condValue.value = current.formula; }
    const syncCond = () => {
      const t = CONDITIONS.find((x) => x.value === condSelect.value);
      condValue.hidden = !t || t.args < 1;
      condValue2.hidden = !t || t.args < 2;
      condValue.placeholder = t?.formula ? `=${colName(c)}${f.range.r1 + 2}>100` : t?.numeric ? 'Number' : 'Value';
      clearCond();
      listEl.classList.toggle('dimmed', !!t);
    };
    condSelect.addEventListener('change', syncCond);
    /**
     * The keyboard inside the menu. The menu's own arrow keys know only its items (the sort
     * entries) and Tab leaves it; here Down, Up and Tab move through every control of this menu
     * (the sort items, swatches, condition fields, search, value checkboxes and buttons) in reading
     * order and wrap, and Home and End go to the ends except in a text field, where they move the
     * caret. The condition select keeps Up and Down for picking a condition. True when handled.
     */
    const controls = () => [...menu.menu.querySelectorAll('button, input, select')].filter((n) => !n.disabled && !n.closest('[hidden]'));
    const navigate = (e) => {
      if (isComposing(e)) return false;
      const t = e.target;
      if (t === condSelect && e.key !== 'Tab') return false;
      const inText = t instanceof HTMLInputElement && t.type !== 'checkbox';
      const step = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) ? 1 : e.key === 'ArrowUp' || e.key === 'Tab' ? -1 : 0;
      const ends = !inText && (e.key === 'Home' || e.key === 'End');
      if (!step && !ends) return false;
      const list = controls();
      const next = ends ? list[e.key === 'Home' ? 0 : list.length - 1] : list[(list.indexOf(t) + step + list.length) % list.length];
      if (!next) return false;
      e.preventDefault();
      e.stopPropagation();
      next.focus();
      return true;
    };
    // The menu closes on Tab before any listener on its content runs (it listens on the document in
    // the capture phase, and leaves a key whose default is already prevented alone), so Tab is caught
    // earlier still, on the window, for as long as the menu is open.
    const onTab = (e) => { if (e.key === 'Tab' && menu.owns(e.target)) navigate(e); };
    window.addEventListener('keydown', onTab, true);
    for (const input of [condSelect, condValue, condValue2]) input.addEventListener('keydown', (e) => { if (isComposing(e) || navigate(e)) return; e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') menu.close(); });
    syncCond();
    /**
     * What is wrong with the typed condition, or null: the same checks the
     * conditional formatting dialog makes. A comparison with nothing to
     * compare against would quietly hide every row.
     */
    // A typed value is read as the grid reads a typed entry, in the regional format (1,5 in de-DE; 1,000; 10%;
    // a date), as the conditional-formatting dialog reads its values; the number read is what is stored and
    // compared, so 12.5% meets a cell showing 12.50% and 1,5 is not refused as "not a number".
    const numberOf = (text) => { const { v } = parseInput(text.trim()); return typeof v === 'number' ? v : null; };
    const conditionProblem = (t) => {
      const v1 = condValue.value.trim();
      const v2 = condValue2.value.trim();
      if (t.formula) return v1.startsWith('=') ? null : 'A custom formula starts with =';
      if (t.args >= 1 && v1 === '') return 'Enter a value';
      if (t.args >= 2 && v2 === '') return 'Enter both values';
      if (t.numeric && (numberOf(v1) == null || (t.args === 2 && numberOf(v2) == null))) return 'This condition needs numbers';
      return null;
    };
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const matches = all.filter((v) => !q || v.value.toLowerCase().includes(q));
      const shown = matches.slice(0, 300);
      // A note under the list: no matches, or a list cut short, so the values past the cap are known to exist.
      const note = !shown.length ? 'No matches' : shown.length < matches.length ? `Showing ${shown.length} of ${matches.length} values. Type to find the rest` : null;
      listEl.replaceChildren(...shown.map(({ value, count }) => {
        const id = `fv-${Math.random().toString(36).slice(2, 8)}`;
        const input = el('input', { type: 'checkbox', id, checked: selected.has(value), onchange: () => { valuesChanged = true; if (input.checked) selected.add(value); else selected.delete(value); updateSummary(); } });
        // The blank cells are listed as (Blanks); a cell whose text is exactly that is quoted to tell it apart.
        return el('label.filter-value', { for: id }, input, el('span.filter-value-text', {}, value === '' ? '(Blanks)' : value === '(Blanks)' ? '"(Blanks)"' : value), el('span.filter-count', {}, String(count)));
      }), ...(note ? [el('div.menu-header', {}, note)] : [])); // replaceChildren would print a bare `false`
      updateSummary();
    };
    const updateSummary = () => { summary.textContent = `${selected.size} of ${all.length} selected`; };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => { if (isComposing(e) || navigate(e)) return; e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'Escape') menu.close(); });
    listEl.addEventListener('keydown', (e) => { if (navigate(e)) return; if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });

    const apply = () => {
      const t = CONDITIONS.find((x) => x.value === condSelect.value);
      const problem = t ? conditionProblem(t) : null;
      if (problem) {
        refuseCond(problem === 'Enter both values' ? condValue2 : condValue, problem);
        return;
      }
      menu.close();
      if (t?.formula) {
        wb.setFilterCriteria(sheetId, c, { formula: condValue.value.trim() });
      } else if (t) {
        // Equal to and Not equal to take the number when the text reads as one, and the text itself otherwise.
        const raw = (v) => { const n = t.numeric || t.value === 'eq' || t.value === 'neq' ? numberOf(v) : null; return n != null ? n : v; };
        wb.setFilterCriteria(sheetId, c, { op: t.value, value: t.args >= 1 ? raw(condValue.value) : undefined, value2: t.args >= 2 ? raw(condValue2.value) : undefined });
      } else if (!current?.color || valuesChanged) { // Apply with the values untouched keeps a colour filter as it is
        if (all.every((v) => selected.has(v.value))) wb.setFilterCriteria(sheetId, c, null);
        else wb.setFilterCriteria(sheetId, c, { values: [...selected], ...(current?.caseSensitive === false ? { caseSensitive: false } : {}) });
      }
      grid.focus();
    };
    const actions = el('div.filter-actions', {},
      el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { valuesChanged = true; for (const v of all) selected.add(v.value); render(); } }, 'Select all'),
      el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { valuesChanged = true; selected.clear(); render(); } }, 'Clear'),
      el('div.grow'),
      el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: apply }, 'Apply'));

    // Filter by fill color: the fills used in the column (style or conditional), plus "no fill".
    const fills = wb.filterColors(sheetId, c);
    const colorRow = fills.filter((x) => x.color).length ? el('div.filter-colors', { role: 'group', 'aria-label': 'Filter by color' },
      // One fill at a time, so the swatches are radios and the chosen one carries aria-checked, as every
      // other swatch grid in the app does: a class and an outline said which was in force to the eye only,
      // and a screen reader read a row of plain buttons with nothing to tell them apart.
      ...fills.map(({ color, count }) => el('button.swatch', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(current?.color === color),
        className: `swatch${color ? '' : ' none'}`,
        style: color ? { background: color } : null, 'aria-label': color ? `Fill ${color} (${count})` : `No fill (${count})`, title: `${color || 'No fill'} · ${count} row${count === 1 ? '' : 's'}`,
        onclick: () => { menu.close(); wb.setFilterCriteria(sheetId, c, { color }); grid.focus(); },
      }))) : null;
    // The workbook declines to sort over merged cells, an array result, protected cells or part of a table: that is said rather than nothing happening.
    const sortBy = (ascending) => {
      if (!wb.sortRangeBy(sheetId, dataRange, [{ col: c, ascending }])) { toast(rearrangeProblem(wb, sheetId, dataRange, 'row') || 'Nothing to sort', { icon: 'info' }); return; }
      wb.reapplyFilter(sheetId);
    };
    const rect = grid.cellRect(f.range.r1, c);
    const anchor = { getBoundingClientRect: () => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }), setAttribute() {} };
    const menu = openMenu({
      anchor, label: `Filter ${header}`, minWidth: 260,
      items: [
        { header },
        { label: 'Sort A to Z', icon: 'sortAsc', onSelect: () => sortBy(true) },
        { label: 'Sort Z to A', icon: 'sortDesc', onSelect: () => sortBy(false) },
        current && { label: 'Clear filter from this column', icon: 'x', onSelect: () => wb.setFilterCriteria(sheetId, c, null) },
        { separator: true },
        colorRow && { header: 'Filter by fill color' },
        colorRow && { custom: colorRow },
        { header: 'Filter by condition' },
        { custom: el('div.filter-cond-row', {}, condSelect, condValue, condValue2, condError) },
        { header: 'Filter by values' },
        { custom: el('div.fn-search', {}, search) },
        { custom: listEl },
        { custom: summary },
        { custom: actions },
      ],
      onClose: () => { window.removeEventListener('keydown', onTab, true); grid.focus(); },
    });
    menu.menu.addEventListener('keydown', navigate); // the sort items, swatches and buttons: before the menu's own arrow handling on the document
    render();
    setTimeout(() => search.focus(), 0);
  }

  function openListPicker(r, c, rule) {
    const sheetId = grid.sheetId;
    const typed = Array.isArray(rule.source) || isRangeSource(rule.source);
    const entries = wb.listOptionsFor(sheetId, rule, { typed, r, c, labels: true });
    const values = entries.map((entry) => entry.value);
    // An option reads as its source cell shows it, so a list of dates shows dates rather than serials and
    // an amount keeps its symbol; one with no cell behind it reads in this cell's own format. The chosen
    // value is still inserted typed. A format that hides the value (;;;) must not hide the option.
    // "This cell's own format" is what the cell shows, the format its column or row carries included,
    // so a list of amounts in a Currency column reads the way the cells under it do.
    const style = wb.styleAt(sheetId, r, c);
    const numberLabel = (v) => { const label = formatValue(v, style); return label.trim() ? label : String(v); };
    const options = entries.map(({ value: v, text }) => text ?? (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? numberLabel(v) : String(v)));
    const seen = new Set();
    const ambiguous = new Set();
    for (const label of options) {
      if (seen.has(label)) ambiguous.add(label);
      seen.add(label);
    }
    if (!options.length) { toast('This list has no options yet', { icon: 'info' }); return; }
    const currentValue = wb.getValue(sheetId, r, c);
    const hasValue = currentValue != null && currentValue !== '';
    const currentText = typeof currentValue === 'boolean' ? (currentValue ? 'TRUE' : 'FALSE') : String(currentValue ?? '');
    let selected = typed ? values.findIndex((value) => value === currentValue) : options.indexOf(currentText);
    // Match manual numeric aliases (such as 42.0 for 42) using the same
    // equivalence as validation, after preferring an exact unformatted label.
    if (!typed && selected < 0 && hasValue && typeof currentValue !== 'object') {
      selected = options.findIndex((label) => checkValue({ type: 'list', source: [label] }, currentValue).ok);
    }
    const rect = grid.cellRect(r, c);
    const anchor = { getBoundingClientRect: () => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }), setAttribute() {} };
    openValuePicker({
      anchor, labels: options, minWidth: Math.max(160, rect.width),
      current: selected, // the index of the cell's option, so the picker opens on it without scanning the items itself
      itemAt: (i) => {
        const type = ambiguous.has(options[i]) ? { string: 'Text', number: 'Number', boolean: 'Boolean' }[typeof values[i]] : null;
        return {
          label: options[i], shortcut: type, ariaLabel: type ? `${options[i]} (${type})` : null,
          checked: i === selected,
          swatch: rule.chips ? chipFor(rule, options[i], options)?.bg : null,
          onSelect: () => {
            // Source cells already have types. Do not reparse their labels as
            // dates, numbers, or formulas when inserting the chosen value.
            // For manually listed options, retain ordinary numeric/boolean
            // input only when it still matches the particular label selected.
            const literal = typed || /^[=']/.test(options[i])
              || !checkValue({ type: 'list', source: [options[i]] }, parseInput(options[i]).v).ok;
            wb.setInput(sheetId, r, c, values[i], { literal });
            grid.focus();
          },
        };
      },
      clearItem: hasValue ? { label: 'Clear', icon: 'x', onSelect: () => { wb.setInput(sheetId, r, c, ''); grid.focus(); } } : null,
      onClose: () => grid.focus(),
    });
  }

  function selectLocation(sheetId, range) {
    if (!range || !wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) {
      toast('That range is beyond this sheet’s available size', { icon: 'alert' }); return false;
    }
    // Navigating is not an edit. A target on a hidden sheet is refused, rather than the
    // sheet revealed: unhiding dirtied the document, pushed a "Show sheet" step and let the autosave write
    // the reveal into the file, so merely opening a shared ?range= link or a #Sheet!A1 link exposed the sheet.
    const sheet = wb.sheet(sheetId);
    if (sheet?.hidden) {
      toast(`${sheet.name} is hidden. Unhide it from the sheet tabs to go there`, { icon: 'info', duration: 3500 });
      return null;
    }
    if (sheetId !== wb.activeSheetId) wb.setActiveSheet(sheetId);
    return grid.selectByName(rangeName(range));
  }

  /** Jump to a "#Sheet!A1" / "#Name" link target, switching sheets when needed. */
  function followInternalLink(url) {
    const target = wb.resolveLink(url, grid.sheetId, grid.active);
    if (!target) { toast('That link points somewhere that no longer exists', { icon: 'alert' }); return false; }
    if (!selectLocation(target.sheetId, target.range)) return false;
    grid.focus();
    return true;
  }
  ctx.followInternalLink = followInternalLink;

  function openLinkDialog() {
    if (grid.editing && !grid.commitEdit()) return;
    const { r, c } = grid.active;
    const sheetId = grid.sheetId;
    if (wb.lockedAt(sheetId, r, c)) return; // a protected cell: the workbook says so, and would refuse the link
    const existing = wb.linkAt(sheetId, r, c);
    // A table's header holds its column's name, so the workbook declines a HYPERLINK formula there: said before the dialog opens.
    const table = wb.tableAt(sheetId, r, c);
    if (table && r === table.range.r1) { toast('A table header holds its column name and cannot hold a link', { icon: 'info', duration: 3000 }); return; }
    const cell = wb.getCell(sheetId, r, c);
    const labelNow = existing ? existing.label : cell && cell.f == null && cell.v != null ? wb.getDisplay(sheetId, r, c) : '';
    // A number or boolean keeps its type through the link: the dialog shows it as the cell formats it,
    // but unless that text is changed the value itself goes to the workbook, so a SUM over the cell
    // still counts it and removing the link gives the number back rather than "$1,000.00" as text.
    // An existing link's label is what its HYPERLINK computes (1000, not the "$1,000.00" shown) or a
    // typed address's own text; an error result has no value to hand back and the text stands in.
    const linkValue = existing ? (cell.f != null ? wb.getValue(sheetId, r, c) : cell.v) : null;
    const typedValue = existing
      ? (linkValue != null && typeof linkValue !== 'object' ? linkValue : null)
      : cell?.f == null && (typeof cell?.v === 'number' || typeof cell?.v === 'boolean') ? cell.v : null;
    const textInput = el('input.input', { type: 'text', 'aria-label': 'Text', placeholder: 'Text to show', value: labelNow, autocomplete: 'off' });
    const urlInput = el('input.input', { type: 'text', inputmode: 'url', 'aria-label': 'Link', placeholder: 'https://example.com or name@example.com', value: existing?.url || '', autocomplete: 'off', spellcheck: false });
    // A refusal names its field (the link, or the cell or range): marked invalid, described by the message
    // and focused, as the dialogs' shared fieldAlert does; the mark goes when that field's value next changes.
    const error = el('p.field-error', { id: `link-error-${Math.random().toString(36).slice(2, 8)}`, hidden: true, role: 'alert' });
    let blamed = null;
    const clearError = () => { error.hidden = true; if (blamed) { blamed.removeAttribute('aria-invalid'); blamed.removeAttribute('aria-describedby'); blamed = null; } };
    const refuse = (field, message) => {
      clearError();
      error.textContent = message;
      error.hidden = false;
      blamed = field;
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', error.id);
      field.focus();
      return false;
    };
    const unmark = (e) => { if (e.target === blamed) clearError(); };
    // Where the link goes: a web address, a place on a sheet, or a named range.
    const hasSheets = (ref) => ref && wb.sheetByName(ref.sheet) && (!ref.sheetEnd || wb.sheetByName(ref.sheetEnd));
    const namedRanges = wb.names.filter((n) => hasSheets(wb.parseNamedRef(n.ref)));
    const internal = existing && existing.url.startsWith('#') ? existing.url.slice(1) : null;
    const parsedInternal = internal ? wb.parseNamedRef(internal) : null;
    // A sheet picker cannot represent both endpoints of a span. Keep its
    // complete address in the link field instead of reducing it to one sheet.
    const internalRef = hasSheets(parsedInternal) && !parsedInternal.sheetEnd ? parsedInternal : null;
    const internalName = internal && !internalRef ? namedRanges.find((n) => wb.nameLabel(n).toLowerCase() === internal.toLowerCase()) : null;
    const kindSelect = el('select.select', { 'aria-label': 'Link to' },
      el('option', { value: 'web' }, 'Web address or email'),
      el('optgroup', { label: 'Sheets' }, ...wb.sheets.map((sh) => el('option', { value: `sheet:${sh.id}` }, sh.name))),
      namedRanges.length ? el('optgroup', { label: 'Named ranges' }, ...namedRanges.map((n) => el('option', { value: `name:${wb.nameLabel(n)}` }, wb.nameLabel(n)))) : null);
    const rangeInput = el('input.input', { type: 'text', 'aria-label': 'Cell or range', placeholder: 'A1, A1:C10, or A1#', value: 'A1', autocomplete: 'off', spellcheck: false });
    if (internalRef) {
      const target = wb.sheetByName(internalRef.sheet);
      if (target) { kindSelect.value = `sheet:${target.id}`; rangeInput.value = rangeName(internalRef).replace(/\$/g, '') + (internalRef.spill ? '#' : ''); }
    } else if (internalName) kindSelect.value = `name:${wb.nameLabel(internalName)}`;
    const initialKind = kindSelect.value, initialRange = rangeInput.value;
    const webField = el('label.field', {}, el('span.field-label', {}, 'Link'), urlInput);
    const rangeField = el('label.field', {}, el('span.field-label', {}, 'Cell or range'), rangeInput);
    const syncKind = () => {
      const kind = kindSelect.value;
      webField.hidden = kind !== 'web';
      rangeField.hidden = !kind.startsWith('sheet:');
      clearError();
    };
    kindSelect.addEventListener('change', syncKind);
    syncKind();
    const targetUrl = () => {
      const kind = kindSelect.value;
      if (kind === 'web') return urlInput.value.trim();
      if (kind.startsWith('name:')) return `#${kind.slice(5)}`;
      if (existing && kind === initialKind && rangeInput.value.trim() === initialRange) return existing.url;
      const targetId = kind.slice(6);
      const text = rangeInput.value.trim(), spill = text.endsWith('#');
      const range = spill ? parseRefText(text.slice(0, -1)) : parseRange(text);
      if (!range || (spill && range.kind !== 'cell')) return null;
      const address = wb.internalLinkFor(targetId, range);
      return address && spill ? `${address}#` : address;
    };
    const submit = (e) => {
      e?.preventDefault();
      const url = targetUrl();
      if (url == null) return refuse(rangeInput, 'Enter a cell or range like A1, B2:D9, or A1#');
      if (!url) return refuse(urlInput, 'Enter a link');
      if (!safeLinkUrl(url)) return refuse(urlInput, 'Enter a web address, email, or place in this spreadsheet');
      // Saved as it was: nothing is written, so the cell keeps its kind (a typed address stays typed text,
      // a numeric label a number) and there is nothing to undo.
      if (existing && url === existing.url && textInput.value === labelNow) { modal.close(); grid.focus(); return; }
      // A place link with no text shows the place, not the raw address.
      const label = textInput.value.trim() || (url.startsWith('#') ? url.slice(1).replace(/'/g, '') : '');
      // False from the workbook means nothing was recorded (a protected cell, which it reports itself); nothing is announced as done either way, so the dialog simply closes.
      wb.setLink(sheetId, r, c, url, typedValue != null && textInput.value === labelNow ? typedValue : label);
      modal.close();
      grid.focus();
    };
    const content = el('form', { onsubmit: submit, oninput: unmark, onchange: unmark },
      el('label.field', {}, el('span.field-label', {}, 'Text'), textInput),
      el('label.field', {}, el('span.field-label', {}, 'Link to'), el('div.select-wrap', {}, kindSelect)),
      webField,
      rangeField,
      error, // below whichever of the two fields is shown, so a refusal of either is in view
      el('div.row.row-end', {},
        existing && el('button.btn.btn-danger', { type: 'button', onclick: () => { wb.removeLink(sheetId, r, c); modal.close(); grid.focus(); } }, 'Remove link'),
        el('div.grow'),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'submit' }, existing ? 'Save' : 'Insert')));
    // Starts on the address for an existing link or a cell with text, else on the text; through openModal, whose screen-size guard keeps a phone's keyboard down.
    const modal = openModal({ title: existing ? 'Edit link' : 'Insert link', content, initialFocus: existing || labelNow ? urlInput : textInput });
  }

  function openNoteDialog() {
    if (grid.editing && !grid.commitEdit()) return;
    const { r, c } = grid.active;
    const sheetId = grid.sheetId;
    if (wb.lockedAt(sheetId, r, c)) return; // a protected cell: the workbook says so, and would refuse the note
    const existing = wb.getNote(sheetId, r, c) || '';
    const area = el('textarea.input.note-area', { rows: 4, 'aria-label': 'Note', placeholder: 'Write a note about this cell', value: existing, maxlength: 4000 });
    const submit = (e) => {
      e?.preventDefault();
      wb.setNote(sheetId, r, c, area.value);
      modal.close();
      grid.focus();
    };
    const content = el('form', { onsubmit: submit },
      el('label.field', {}, el('span.field-label', {}, `Note on ${cellName(r, c)}`), area),
      el('div.row.row-end', {},
        existing && el('button.btn.btn-danger', { type: 'button', onclick: () => { wb.setNote(sheetId, r, c, null); modal.close(); grid.focus(); } }, 'Delete'),
        el('div.grow'),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'submit' }, existing ? 'Save' : 'Add note')));
    area.addEventListener('keydown', (e) => { if (isComposing(e)) return; if (e.key === 'Enter' && isMod(e)) submit(e); });
    const modal = openModal({ title: existing ? 'Edit note' : 'Add note', content, initialFocus: area });
    area.setSelectionRange(area.value.length, area.value.length); // the caret after the note, where the field took the focus
  }

  /**
   * Select a named range, switching sheets if needed. Synchronous; true when
   * found, false when the name means nothing here, null when it was refused
   * with an explanation of its own (a missing sheet, a formula name).
   */
  function goToName(name, scopeSheet = wb.activeSheetId) {
    // Menu entries identify their exact scope, including workbook scope
    // when the current sheet has an override with the same spelling.
    const entry = name && typeof name === 'object' ? name : null;
    if (entry) name = entry.name;
    const directRange = !entry && parseRange(String(name).trim());
    if (directRange) return selectLocation(scopeSheet, directRange);
    // Sheet!A1, 'My sheet'!A1:B5, Sheet!MyTable: switch to that sheet, then find the rest there.
    const qualified = /^(?:'((?:[^']|'')+)'|([^'!\[\]]+))!(.+)$/.exec(String(name).trim());
    if (qualified) {
      const sheetName = qualified[1] != null ? qualified[1].replace(/''/g, "'") : qualified[2].trim();
      const target = wb.sheetByName(sheetName);
      if (!target) { toast(`There is no sheet called ${sheetName}`, { icon: 'info' }); return null; }
      const rest = qualified[3].trim();
      const range = parseRange(rest);
      if (range) {
        return selectLocation(target.id, range);
      }
      return goToName(rest, target.id);
    }
    const scopeName = entry ? entry.sheet || null : wb.sheet(scopeSheet)?.name;
    let ref = wb.namedLocation(name, scopeName, grid.active);
    if (!ref && !entry && String(name).trim().endsWith('#')) {
      const location = wb.resolveLink(`#${name}`, scopeSheet, grid.active);
      if (location) ref = { sheet: wb.sheet(location.sheetId).name, ...location.range };
    }
    if (!ref) {
      // A table name selects the table (its header and data); Table[Column] selects that part.
      const m = /^([A-Za-z_][A-Za-z0-9_.]*)(?:\[(.*)\])?$/.exec(String(name).trim());
      const found = m ? wb.tableByName(m[1]) : null;
      if (found) {
        const rect = m[2] != null ? resolveTableSpec(found.table, wb.tableColumns(found.sheet.id, found.table), m[2], null) : null;
        if (rect?.error) { toast(`${name} is not part of table ${found.table.name}`, { icon: 'info' }); return null; }
        ref = rect ? { sheet: found.sheet.name, ...rect } : { sheet: found.sheet.name, ...found.table.range };
      }
    }
    if (!ref) {
      if (wb.isNamedFormula(name, scopeName)) { toast(`${name} is a formula, not a place. Use it in a formula: =${name}`, { icon: 'info', duration: 3000 }); return null; }
      return false;
    }
    const target = wb.sheetByName(ref.sheet);
    if (!target) { toast('That name points at a sheet that no longer exists', { icon: 'alert' }); return null; }
    return selectLocation(target.id, wb.navigationRange(target.id, ref));
  }
  ctx.goToName = goToName;
  ctx.canAI = () => P.canAI();

  /** Formatting a whole column must not create a million styled cells. */
  /**
   * The range a data command works on: the selection, or, for a single
   * cell, the block of data around it (not the whole sheet, whose title
   * rows would otherwise become the header). An empty, isolated cell
   * falls back to the sheet's used range.
   */
  function dataRange(fallback = wb.usedRange(grid.sheetId)) {
    if (!S.isSingle(grid.selection)) return toUsedExtent(grid.range);
    return wb.dataRegion(grid.sheetId, grid.active.r, grid.active.c) || fallback;
  }

  /**
   * Whole columns or rows (a range reaching row 1,048,576 or column XFD) as far as the sheet's content goes,
   * as the data commands take them: a sort, a subtotal or a duplicate check over column A works on its
   * data, not on a million blank rows. Other ranges are left as they are.
   */
  function toUsedExtent(range, sheetId = grid.sheetId) {
    if (range.r2 < MAX_ROW && range.c2 < MAX_COL) return range;
    const used = wb.usedRange(sheetId);
    const r2 = range.r2 >= MAX_ROW ? Math.max(range.r1, Math.min(range.r2, used?.r2 ?? range.r1)) : range.r2;
    const c2 = range.c2 >= MAX_COL ? Math.max(range.c1, Math.min(range.c2, used?.c2 ?? range.c1)) : range.c2;
    return { ...range, r2, c2 };
  }

  /** `what` names the command in the note when the range is cut short ("Checkboxes inserted through row 200"). */
  function formatRange(range = grid.range, what = 'Formatting applied') {
    const sheet = wb.sheet(grid.sheetId);
    const used = wb.usedRange(grid.sheetId) || { r2: -1, c2: -1 };
    let { r1, c1, r2, c2 } = range;
    const total = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (total <= MAX_FORMAT_CELLS) return range;
    r2 = Math.min(r2, Math.max(used.r2, r1 + 199, grid.active.r));
    c2 = Math.min(c2, Math.max(used.c2, c1 + 25, grid.active.c));
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_FORMAT_CELLS) r2 = r1 + Math.floor(MAX_FORMAT_CELLS / (c2 - c1 + 1)) - 1;
    toast(`${what} through row ${r2 + 1}`, { icon: 'info' });
    return normalizeRange({ r1, c1, r2: Math.min(r2, sheet.rows - 1), c2: Math.min(c2, sheet.cols - 1) });
  }

  /**
   * A range without the rows a filter is hiding: one range per run of shown
   * rows, or the range itself when nothing in it is filtered out. Clearing
   * and formatting a filtered list touch what is on screen.
   */
  function shownRuns(rg, sheetId = grid.sheetId) {
    const hidden = wb.sheet(sheetId)?.filterHidden;
    if (!hidden?.size) return [rg];
    const out = [];
    let start = null;
    for (let r = rg.r1; r <= rg.r2 + 1; r++) {
      const shown = r <= rg.r2 && !hidden.has(r);
      if (shown && start == null) start = r;
      if (!shown && start != null) { out.push({ ...rg, r1: start, r2: r - 1, scope: rg.scope === 'sheet' || rg.scope === 'rows' ? 'rows' : undefined }); start = null; }
    }
    return out;
  }

  /**
   * What a formatting command formats, and the cell whose style it reads: the selection on the
   * sheet shown, or, while a cell is being edited, that cell on its own sheet. Formatting does not
   * commit an entry (the cell is styled mid-edit), and a formula may be showing another
   * sheet to pick references on, whose selection is not what the user means to format.
   */
  function styleTarget() {
    const edit = grid.editing ? grid.editState : null;
    // Include row/column defaults and a spilled result's inherited number format,
    // so every control fed by it reports the format the cell is really in rather than only the one it stores.
    const { sheetId, r, c } = edit ? { sheetId: edit.sheetId, r: edit.r, c: edit.c } : { sheetId: grid.sheetId, r: grid.active.r, c: grid.active.c };
    const ranges = edit ? [{ r1: r, c1: c, r2: r, c2: c }] : grid.formatRanges;
    return { sheetId, ranges, style: wb.displayStyleAt(sheetId, r, c) || {} };
  }

  /**
   * Run an edit over every selected range (Ctrl/Cmd+click adds ranges) as one undo step,
   * leaving out the rows a filter hides: as one call per run of shown rows, or, for an edit
   * the workbook makes in one call over a range (`skipRows`), as `fn(range, skipRow)` with
   * the rows to pass over. A filtered list cut into thousands of runs then costs one call
   * and one history entry rather than one apiece, which took a minute over 20,000 rows.
   * `fn` also receives the sheet the ranges are on: the cell being edited (see `styleTarget`)
   * may be on another sheet than the one shown. A protected cell among the shown rows of any
   * range refuses every range up front, as the workbook refuses one range holding such a cell:
   * all or nothing, rather than the other ranges done and that one not.
   * The workbook's notice has named the cell then, and null says so.
   */
  function eachRange(label, fn, { cap = true, skipRows = false, what = undefined, nativeScope = false } = {}) {
    const { sheetId, ranges: selected } = styleTarget();
    const ranges = selected.map((rg) => (cap ? formatRange(rg, what) : rg));
    const runs = ranges.flatMap((rg) => shownRuns(rg, sheetId));
    if (runs.some((rg) => wb.lockedIn(sheetId, nativeScope ? { ...rg,
      ...(['columns', 'sheet'].includes(rg.scope) ? { r1: 0, r2: MAX_ROW } : {}),
      ...(['rows', 'sheet'].includes(rg.scope) ? { c1: 0, c2: MAX_COL } : {}),
    } : rg))) return null;
    const hidden = wb.sheet(sheetId)?.filterHidden;
    const skipRow = hidden?.size ? (r) => hidden.has(r) : null;
    const calls = skipRows ? ranges.map((rg) => () => fn(rg, skipRow, sheetId)) : runs.map((rg) => () => fn(rg, null, sheetId));
    if (!calls.length) return undefined;
    if (calls.length === 1) return calls[0]();
    return wb.transaction(label, () => { for (const call of calls) call(); });
  }

  /** A reference typed in a dialog (Sheet2!A1:C9, A1:C9 on this sheet, or a defined name) as { sheetId, range }, or null. */
  function resolveRangeText(text) {
    const here = wb.sheet(grid.sheetId)?.name;
    const body = String(text).trim().replace(/^=/, '');
    const bang = body.lastIndexOf('!');
    const sheetName = bang > 0 ? body.slice(0, bang).replace(/^'(.*)'$/s, '$1').replace(/''/g, "'") : null;
    const ref = parseRefText(bang > 0 ? body.slice(bang + 1) : body, sheetName) || wb.namedRef?.(body, here);
    if (!ref || ref.r1 == null || ref.c1 == null) return null;
    const target = ref.sheet ? wb.sheetByName(ref.sheet) : wb.sheet(grid.sheetId);
    if (!target || target.kind === 'chart') return null;
    return { sheetId: target.id, range: { r1: ref.r1, c1: ref.c1, r2: ref.r2 ?? ref.r1, c2: ref.c2 ?? ref.c1 } };
  }
  ctx.resolveRange = resolveRangeText;

  /** Remove the notes, or the links, of the selected cells: only cells that have one are visited. */
  function clearInSelection(kind) {
    const sheet = wb.sheet(grid.sheetId);
    if (!sheet) return;
    const inside = (r, c) => grid.ranges.some((rg) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2);
    if (kind === 'notes') {
      for (const key of [...sheet.notes.keys()]) {
        const { r, c } = parseKey(key);
        if (inside(r, c)) wb.setNote(sheet.id, r, c, null);
      }
      comments.clearIn(sheet.id, inside);
      return;
    }
    for (const key of [...sheet.cells.keys()]) {
      const { r, c } = parseKey(key);
      if (inside(r, c) && wb.linkAt(sheet.id, r, c)) wb.removeLink(sheet.id, r, c);
    }
  }

  /** Handle native selections atomically; false means the ordinary path should run. */
  function nativeFormatRanges(apply, { onApplied = null, cap = true } = {}) {
    const { sheetId, ranges: selected } = styleTarget();
    // Prepare all visible ranges together when a native report is affected.
    // Sequential applyStyle calls cannot keep cell edits and semantic rules in
    // sync, or undo an earlier range if a later native selection is unsupported.
    if (selected.some(rg => wb.nativePivotOverlap(sheetId, rg))) {
      const ranges = selected.map(rg => cap ? formatRange(rg) : rg).flatMap(rg => shownRuns(rg, sheetId));
      if (ranges.some(rg => wb.lockedIn(sheetId, rg))) return true;
      let changed;
      try {
        changed = apply(sheetId, ranges);
      } catch {
        toast('This formatting cannot be applied to the selected part of the pivot table', { icon: 'info', duration: 5000 });
        return true;
      }
      // Callers adding layout edits wrap both operations in one transaction.
      if (changed) onApplied?.(sheetId, ranges);
      return true;
    }
    return false;
  }

  function nativeStyleRanges(patch, onApplied = null) {
    return nativeFormatRanges((sid, ranges) => formatNativePivotSelection(wb, new Map([[sid, ranges]]), patch,
      { maxCells: MAX_FORMAT_CELLS, defaultSize: 13 }), { onApplied });
  }

  /** Merge a style patch into every selected range, the rows a filter hides left out. */
  function styleRanges(label, patch) {
    if (nativeStyleRanges(patch)) return;
    return eachRange(label, (rg, skipRow, sheetId) => wb.applyStyle(sheetId, rg, patch, { skipRow }), { skipRows: true });
  }

  function fittedStyleRanges(label, patch, fit = true) {
    const fitRanges = (sid, ranges) => {
      if (fit && sid === grid.sheetId) for (const rg of ranges) grid.autoFitRows(rg.r1, Math.min(rg.r2, rg.r1 + 500));
    };
    wb.transaction(label, () => {
      if (nativeStyleRanges(patch, fitRanges)) return;
      eachRange(label, (rg, _, sid) => {
        wb.applyStyle(sid, rg, patch);
        fitRanges(sid, [rg]);
      });
    });
  }

  function growFontRows(sid, tallest) {
    // Grow rows that can no longer show the text; never shrink or unhide them.
    for (const [r, px] of tallest) {
      const needed = Math.ceil(px * 1.35) + 8;
      if (!wb.isHidden(sid, 'row', r) && wb.rowHeight(sid, r) < needed) wb.setRowHeight(sid, r, needed, { auto: wb.sheet(sid).rowHeightModes.get(r) === 'auto' });
    }
  }

  function nativeFontSizeRanges(sizeAt) {
    const tallest = new Map();
    return nativeStyleRanges((sid, r, c) => {
      const px = sizeAt(sid, r, c);
      if (!px) return null;
      tallest.set(r, Math.max(tallest.get(r) || 0, px));
      return { size: px === 13 ? null : px };
    }, sid => growFontRows(sid, tallest));
  }

  /**
   * A command that takes one range, given a Ctrl/Cmd+click selection of several: refused with a word
   * rather than run on the last range
   * added, the one holding the active cell, while the others sit selected and nothing is said.
   */
  function oneRange(what) {
    if (grid.ranges.length <= 1) return true;
    toast(`Select one range to ${what}`, { icon: 'info', duration: 3000 });
    keepFocus();
    return false;
  }

  /**
   * Would splitting the first column of the selected ranges (in the rows on show) write a piece over a cell
   * that holds something? Mirrors how the workbook splits: the delimiter given, or the one most rows contain
   * (space last), quoted fields kept whole. Split text asks before replacing data.
   */
  function splitWouldOverwrite(delimiter) {
    const sheetId = grid.sheetId;
    if (delimiter && typeof delimiter === 'object') {
      // The Text to Columns choices: whatever the split writes, other than over the text itself.
      const ranges = delimiter.dest ? [grid.range] : grid.ranges.flatMap((rg) => shownRuns(rg, sheetId));
      return ranges.some((rg) => (wb.splitTextPlan(sheetId, { ...rg, c2: rg.c1 }, delimiter).entries || []).some(({ r, c }) => {
        if (c === rg.c1 && r >= rg.r1 && r <= rg.r2) return false;
        const cell = wb.getCell(sheetId, r, c);
        return !!cell && (cell.v != null || cell.f != null);
      }));
    }
    for (const rg of grid.ranges) for (const run of shownRuns(rg, sheetId)) {
      const texts = [];
      for (let r = run.r1; r <= run.r2; r++) {
        const cell = wb.getCell(sheetId, r, rg.c1);
        if (cell && cell.f == null && typeof cell.v === 'string') texts.push({ r, v: cell.v });
      }
      if (!texts.length) continue;
      let delim = delimiter;
      if (!delim) {
        let best = 0;
        for (const d of ['\t', ',', ';', '|', ' ']) { const n = texts.filter((t) => t.v.includes(d)).length; if (n > best) { best = n; delim = d; } }
        if (!delim) continue;
      }
      for (const { r, v } of texts) {
        const parts = delim === ' ' ? v.trim().split(/\s+/) : (parseDelimited(v, delim)[0] || []);
        for (let i = 1; i < parts.length; i++) {
          const cell = wb.getCell(sheetId, r, rg.c1 + i);
          if (cell && (cell.v != null || cell.f != null)) return true;
        }
      }
    }
    return false;
  }

  /**
   * A protected sheet refuses every edit. Commands that would only report
   * "nothing to do" (or a change that did not happen) say so instead.
   */
  function refusedByProtection(what = 'make changes') {
    if (!wb.isProtected(grid.sheetId)) return false;
    const name = wb.sheet(grid.sheetId)?.name || 'This sheet';
    lastProtectedToast = Date.now();
    lastProtectedKey = String(grid.sheetId);
    toast(`${name} is protected. Unprotect it from the sheet tab menu to ${what}`, { icon: 'lock', duration: 3500 });
    statusBar?.announce(`${name} is protected`);
    return true;
  }

  /**
   * A shortcut is about to write into a cell without the editor (today's date, the time, the cell above,
   * a sum): a strict validation rule refuses it as the editor refuses the same entry typed, with the
   * rule's notice; a rule that only marks invalid entries lets it through. Paste stays the accepted way
   * past a rule.
   *
   * These chords put their text into the cell's entry, so the rule's Stop alert refuses them
   * as it refuses a typed entry, and Retry goes back to that entry. `retryText` is that text, when
   * the chord has one an entry can hold.
   */
  function allowedByRule(verdict, retryText = null) {
    if (verdict.ok !== false || !verdict.rule || verdict.rule.strict === false) return true;
    statusBar?.announce(verdict.message || 'Invalid value');
    const dialog = validationAlertStyle(verdict.rule) === 'stop';
    invalidEntry(verdict, { dialog });
    if (dialog) {
      const at = grid.active, sheet = grid.sheetId, version = wb.version;
      confirmValidation(verdict).then(choice => {
        const unchanged = grid.sheetId === sheet && grid.active.r === at.r && grid.active.c === at.c && wb.version === version && !grid.editing;
        if (choice === 'retry' && retryText != null && unchanged) grid.beginEdit({ text: retryText, mode: 'inplace' });
        else keepFocus();
      });
    }
    return false;
  }

  function keepFocus() {
    if (!grid.editing) grid.focus();
    else grid.focusEditor();
  }

  /** What the menu bar and the command palette need to know right now: the host, the active cell, the view toggles. */
  function commandFlags() {
    const sheetId = grid.sheetId;
    const { r, c } = grid.active;
    const cell = wb.getCell(sheetId, r, c);
    const sheet = wb.sheet(sheetId);
    return {
      templates: !!templateDoc, pick: P.canPickFiles(), share: P.canShare(), mail: mailer.available(), ai: P.canAI(), aiPanel: !!aiPanel?.isOpen, saving: P.isApp() && P.canSaveFiles(),
      fullscreen: !!document.fullscreenEnabled, isFullscreen: isFullscreen(), filter: !!wb.filterAt(sheetId, grid.active.r, grid.active.c),
      hasFormula: cell?.f != null, hasTable: !!wb.tableAt(sheetId, r, c), table: wb.tableAt(sheetId, r, c),
      tableFilterButton: tableFilterButtonOn(wb, sheetId, wb.tableAt(sheetId, r, c)), pivotReport: !!nativePivotAt(wb, sheetId, r, c), hasNote: !!wb.getNote(sheetId, r, c), hasLink: !!wb.linkAt(sheetId, r, c),
      languagePane: languagePane?.open ? languagePane.mode : null,
      hasComment: !!sheet?.comments?.has(`${r},${c}`), hasComments: !!sheet?.comments?.size, commentsPane: !!ctx.comments?.paneOpen, queriesPane: !!queriesPane?.open, changesPane: !!changesPane?.open, hasQueries: !!wb.queries?.length,
      // Automate: the Code Editor is open, actions are being recorded, a script is running.
      scriptsPane: !!automate?.paneOpen, recording: !!automate?.recording, scriptRunning: !!automate?.running,
      chartSheet: sheet?.kind === 'chart',
      // The sheet holds native sparklines, so the commands that edit, regroup or clear them have something to act on.
      sparklines: !!sheet?.sparklineGroups?.length,
      chart: grid.selectedChart || (sheet?.kind === 'chart' ? sheet.charts[0]?.id : null), chartIsImage: wb.chartById(sheetId, grid.selectedChart)?.type === 'image',
      // A picture placed in the active cell (not an IMAGE result): Place over Cells and Alt Text act on it.
      cellPicture: isCellPicture(cell?.v) && cell?.f == null,
      showFormulas: !!grid.showFormulas, gridlines: sheet?.gridlines !== false, zeros: sheet?.zeros !== false, viewMode: sheet?.viewMode || 'normal',
      showPageBreaks: pageBreakLinesOn(sheetId), background: !!sheet?.background,
      // Arrange: the Selection Pane, and snapping for objects dragged on the sheet.
      selectionPane: !!selectionPane?.open, snapGrid: !!view.snapGrid, snapShape: !!view.snapShape,
      // View ▸ Sheet View: the view this person is in, if any, and whether it is the temporary one.
      sheetView: sheet?.personalView ? (sheet.sheetViews || []).find((v) => v.id === sheet.personalView.id) || null : null,
      headers: sheet?.headers !== false, focus: !!view.focus, spell: view.spell !== false,
      split: !!sheet?.split && !sheet.frozenRows && !sheet.frozenCols, formulaBar: appOption('showFormulaBar'),
      // While a cell is being edited the sheet behind it is off limits: undo, paste, fill and the like wait.
      editing: !!grid.editing,
      // Cells copied here wait on the clipboard: Insert Copied Cells has something to insert.
      copiedCells: !!clip && !clip.cut,
      // Only single unmerged cells selected (Ctrl/Cmd+click adds ranges): nothing to merge, as the toolbar and the cell menu grey it out.
      singleCell: grid.ranges.every((rg) => rg.r1 === rg.r2 && rg.c1 === rg.c2 && !wb.mergeAt(sheetId, rg.r1, rg.c1)),
      // Merged cells under any selected range: the merge command unmerges them all, and the menus say so.
      merged: grid.ranges.some((rg) => wb.mergesIn(sheetId, rg).length > 0),
      // One row (or one column): nothing to merge vertically (or horizontally).
      oneRow: grid.range.r1 === grid.range.r2, oneCol: grid.range.c1 === grid.range.c2,
      // The formula being typed is showing another sheet to pick references on: the items that act on "the
      // active sheet" or "the active cell" have two candidates, and wait until the entry is home again.
      away: !!grid.editing && grid.editState.sheetId !== sheetId,
      canUndo: wb.canUndo(), canRedo: wb.canRedo(), style: styleTarget().style,
      // Several sheets are grouped: edits reach each of them, and the commands for one sheet's objects wait.
      grouped: !!wb.sheetGroup,
      // The workbook's own cell styles, for the Format menu's Cell styles list.
      customCellStyles: wb.cellStyles.filter((d) => !d.builtin).map((d) => d.name),
      // The active sheet among those on show, for the Sheet commands: the last one showing cannot be hidden or
      // deleted, an end one not moved past the end, and one holding work is asked about before it goes.
      sheet: sheetFlags(sheetId),
      fns: { shortcuts: openShortcuts, locale: openLocaleDialog, about: openAbout },
    };
  }

  function sheetFlags(sheetId) {
    const sheet = wb.sheet(sheetId);
    const visible = wb.visibleSheets;
    const at = visible.findIndex((s) => s.id === sheetId);
    return { only: visible.length <= 1, first: at <= 0, last: at < 0 || at >= visible.length - 1, protected: !!sheet?.protected, holdsWork: !!sheet && sheetHoldsWork(sheet) };
  }

  /**
   * How far a sheet's cells may reach: MAX_ROWS/MAX_COLS are the caps on growing a sheet by hand, not the
   * grid's limits, and a file may have brought a larger sheet, which keeps its own size (the workbook's
   * `gridLimits`). Cutting and pasting read these, so the lower half of an imported 50,000-row sheet takes
   * a moved or pasted block as typing there already does.
   */
  const sheetLimits = (sid) => {
    const sheet = wb.sheet(sid);
    return { rows: Math.max(sheet?.rows || 0, MAX_ROWS), cols: Math.max(sheet?.cols || 0, MAX_COLS) };
  };

  /**
   * Why the workbook would not shift a block of cells aside, so the notice names what happened instead of
   * listing everything it might have been. Asked in the order the workbook checks: a table it would tear or
   * behead, then a merged block or a protected range only half inside the band being shifted. Null when the
   * refusal was none of those, which leaves content pushed past the edge of the sheet.
   */
  function shiftProblem(sheetId, range, axis, remove) {
    const sheet = wb.sheet(sheetId);
    if (!sheet) return null;
    const rg = normalizeRange(range);
    const [lo, hi, olo, ohi] = axis === 'row' ? ['r1', 'r2', 'c1', 'c2'] : ['c1', 'c2', 'r1', 'r2'];
    const at = rg[lo];
    const n = rg[hi] - rg[lo] + 1;
    const b1 = rg[olo];
    const b2 = rg[ohi];
    const inside = (m) => m[olo] >= b1 && m[ohi] <= b2;
    const touches = (m) => !(m[ohi] < b1 || m[olo] > b2) && m[hi] >= at;
    // The band runs along the other axis: cells shifted down move within columns, and vice versa.
    const whole = axis === 'row' ? 'whole columns of it' : 'whole rows of it';
    for (const t of sheet.tables) {
      if (!touches(t.range)) continue;
      if (!inside(t.range)) return `The cells cannot be shifted: table ${t.name} would be left ragged. Select ${whole}, or move the table first`;
      if (remove && axis === 'row' && at <= t.range.r1 && at + n > t.range.r1 && at + n <= t.range.r2) return `The cells cannot be shifted: table ${t.name} would lose its header row`;
    }
    for (const m of sheet.merges) {
      if (touches(m) && !inside(m)) return `The cells cannot be shifted: only part of the merged cell ${rangeName(m)} would move. Unmerge it first, or take it all in`;
    }
    for (const p of sheet.protectedRanges) {
      if (touches(p.range) && !inside(p.range)) return `The cells cannot be shifted: only part of the protected range ${rangeName(p.range)} would move`;
    }
    return null;
  }

  /** The number-format keys a spilled cell carries from its array's anchor, with the empty ones dropped. */
  function formatOnly(style) {
    const out = {};
    for (const [key, value] of Object.entries(style || {})) if (value != null) out[key] = value;
    return Object.keys(out).length ? out : undefined;
  }

  /**
   * Decimal places an Automatic cell is showing right now, which More and Fewer decimal places step from:
   * the digits after the locale's decimal mark in what the cell prints, as a General
   * cell steps (7 shows none, so More gives 7.0 and Fewer leaves it at 7; 1.5 shows one, so More gives 1.50).
   * Anything that is not a plain number shows none.
   */
  function generalDecimals(sheetId, r, c) {
    const value = wb.getValue(sheetId, r, c);
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    const fraction = String(wb.getDisplay(sheetId, r, c)).split(localeInfo().decimal)[1];
    return fraction ? fraction.replace(/\D.*$/, '').length : 0;
  }

  /** The commands F4 can repeat: the formatting and structural ones, which act on whatever is selected. */
  const REPEATABLE = new Set(['bold', 'italic', 'underline', 'strike', 'fmt', 'align', 'valign', 'wrap', 'wrapMode', 'merge', 'indent', 'dec',
    'borders', 'bg', 'color', 'font', 'fontSize', 'fontStep', 'rotate', 'insertRows', 'insertCols', 'deleteRows', 'deleteCols', 'insertCells',
    'deleteCells', 'clear', 'clearFormat', 'clearAll', 'hide', 'cellStyle']);
  let lastRepeatable = null;
  /** The Power Query Editor, on a query of the workbook or a new one not yet saved. */
  function editQuery(_, opts = {}) {
    if (destroyed) return;
    openQueryEditor(ctx, opts);
  }
  /** A query that reads the web may run only once the file's outside content is allowed, as IMPORT formulas wait. */
  async function allowQuerySources(queries) {
    if (wb.externalAllowed !== false) return true;
    const web = queries.filter((q) => q.source?.kind === 'web').map((q) => q.source.url);
    if (!web.length) return true;
    const ok = await confirmDialog({ title: 'Refresh', message: `The queries in this workbook read from the web (${web.slice(0, 3).join(', ')}${web.length > 3 ? ', …' : ''}). Allow this workbook to reach those addresses?`, confirmLabel: 'Allow', danger: false });
    if (ok) doc.allowExternal();
    return ok;
  }
  /** What Edit Links needs from the editor: this book's path, and reading, picking and opening other files on the drive. */
  function linkHost() {
    return {
      docPath: () => doc.path || null,
      read: async (path) => workbookFromFile(await P.readFile(path), P.displayName(path)),
      open: (path) => run('openFile', path),
      pick: P.canPickFiles() ? () => P.pickFile() : null,
      // A book from elsewhere reads no other file until allowed, as its IMPORTRANGE formulas wait.
      allow: async () => {
        if (wb.externalAllowed !== false) return true;
        const ok = await confirmDialog({ title: 'Read linked workbooks', message: 'This workbook came from elsewhere, so it has not been allowed to read other files. Allow it to read the workbooks it links to?', confirmLabel: 'Allow', danger: false });
        if (ok) doc.allowExternal();
        return ok;
      },
    };
  }
  /** Commands that may touch every selected cell, which the long-operation alert counts first. */
  const LONG_COMMANDS = new Set(['clear', 'clearAll', 'clearFormat', 'fillDown', 'fillRight', 'toValues', 'textCase', 'sort']);
  /**
   * How many cells `cmd` would change: the selected cells that hold something (the used range), or every
   * selected cell for a fill, which writes them all.
   */
  function affectedCells(cmd) {
    const used = wb.usedRange(grid.sheetId);
    let n = 0;
    for (const rg of grid.ranges) {
      const box = cmd === 'fillDown' || cmd === 'fillRight' || !used ? rg
        : { r1: Math.max(rg.r1, used.r1), c1: Math.max(rg.c1, used.c1), r2: Math.min(rg.r2, used.r2), c2: Math.min(rg.c2, used.c2) };
      if (box.r2 >= box.r1 && box.c2 >= box.c1) n += (box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1);
    }
    return n;
  }

  /** File ▸ Options…, on `section`. */
  function openOptions(section) {
    return openOptionsDialog({
      wb, run, flags: commandFlags, ribbon: toolbar, docName: () => doc.name,
      accountName: () => session.user?.username || '',
      openLocale: openLocaleDialog,
      setAutoSave: (on) => { doc.setAutoSave?.(on); autoSaveSwitch.setAttribute('aria-checked', String(on)); },
      afterCalcChange: () => { grid.refresh(); notify(); },
      afterErrorChecking: () => { grid.redraw(); errorTag.sync(); },
      onOptionsClosed: () => keepFocus(),
    }, { section });
  }

  async function run(cmd, arg) {
    // While a script runs the workbook is its alone; one Undo takes back everything it did once it ends.
    if (automate?.running && !AUTOMATE_COMMANDS.has(cmd)) { toast('A script is running. Wait for it to finish, or stop it in the Code Editor', { icon: 'info' }); return; }
    // F4 (and Ctrl+Y with nothing to redo) repeats the last formatting or structural command on the selection now.
    if (cmd === 'repeat') { if (lastRepeatable && !grid.editing) return run(lastRepeatable.cmd, lastRepeatable.arg); return; }
    if (cmd === 'redo' && !grid.editing && !wb.canRedo() && lastRepeatable) return run('repeat');
    if (REPEATABLE.has(cmd) && !(arg instanceof Event) && !(arg instanceof HTMLElement)) lastRepeatable = { cmd, arg };
    const chartSheet = wb.sheet(grid.sheetId)?.kind === 'chart';
    if (chartSheet && !chartSheetCommand(cmd) && !AUTOMATE_COMMANDS.has(cmd)) return;
    // A command for one sheet's objects (a table, a chart, a rule, a sort) has no meaning across a group of sheets.
    if (wb.sheetGroup && GROUP_BLOCKED_COMMANDS.has(cmd)) {
      toast(GROUP_BLOCKED_REASON, { icon: 'layers', duration: 4000 });
      statusBar?.announce(GROUP_BLOCKED_REASON);
      return;
    }
    if (COMMENT_COMMANDS.has(cmd)) { comments.run(cmd, arg); return; }
    // Pictures in cells, Picture Format and pictures of cells (ui/pictures.js).
    if (PICTURE_COMMANDS.has(cmd)) { if (grid.editing && !grid.commitEdit()) return; return pictures.run(cmd, arg); }
    if (cmd === 'copy' && (chartSheet || grid.selectedChart)) { return run('copyChart', { id: grid.selectedChart || wb.sheet(grid.sheetId).charts[0]?.id }); }
    if (cmd === 'cut' && grid.selectedChart) return; // Drawing cut is unsupported; never cut the cells behind it.
    if (chartSheet && ['editChart', 'deleteChart', 'duplicateChart'].includes(cmd) && !arg) arg = grid.selectedChart || wb.sheet(grid.sheetId).charts[0]?.id;
    if (chartSheet && cmd === 'deleteChart' && !['image', 'text'].includes(wb.chartById(grid.sheetId, arg)?.type)) return run('deleteSheet', grid.sheetId);
    if (chartSheet && cmd === 'zoomFit') { wb.setSheetView(grid.sheetId, { zoomToFit: true }); grid.refresh(); notify(); return; }
    // The sheet a command acts on. A command that commits an open edit before acting reads it again after
    // the commit (`committed`): a formula may have been showing another sheet to pick references on, and
    // the commit brings the grid home, so the rows selected there must not be applied to the sheet left.
    let sheetId = grid.sheetId;
    const committed = () => {
      if (grid.editing && !grid.commitEdit()) return false;
      sheetId = grid.sheetId;
      return true;
    };
    // A command that would change a great many cells asks first, when the options say to (Editing ▸ Long operations).
    if (LONG_COMMANDS.has(cmd) && !grid.editing && appOption('longOperationAlert')) {
      const cells = affectedCells(cmd);
      if (cells > appOption('longOperationCells') * 1000) {
        const ok = await confirmDialog({
          title: 'This may take a while',
          message: `This changes about ${cells.toLocaleString()} cells, which can take some time. Go ahead?`,
          confirmLabel: 'Continue', danger: false,
        });
        if (!ok || destroyed) { keepFocus(); return; }
      }
    }
    switch (cmd) {
      case 'options':
        if (grid.editing && !grid.commitEdit()) return;
        openOptions(typeof arg === 'string' ? arg : 'general');
        return;
      case 'bold': case 'italic': case 'underline': case 'strike': {
        // Decide once from the active cell, so every range (and every run of shown rows) gets the same state.
        const on = !ctx.style()[cmd];
        styleRanges('Format', { [cmd]: on ? true : null });
        keepFocus();
        return;
      }
      case 'wrap': {
        const on = !ctx.style().wrap;
        fittedStyleRanges('Wrap text', { wrap: on ? true : null });
        keepFocus();
        return;
      }
      case 'fitRows': {
        // The rows of every selected range (Ctrl/Cmd+click adds ranges), as one undo step, as Fit columns to content does.
        // Whole columns stop at the last row holding anything or a height of its own, not at row 1,048,576.
        const sheet = wb.sheet(sheetId);
        let last = wb.usedRange(sheetId)?.r2 ?? -1;
        for (const r of sheet.rowHeights.keys()) if (r > last) last = r;
        wb.transaction('Fit rows', () => {
          for (const { from, to } of lineRuns(grid.ranges, 'row')) {
            const end = to >= MAX_ROW ? Math.min(to, Math.max(from, last)) : to;
            grid.autoFitRows(from, end, { force: true });
          }
        });
        keepFocus();
        return;
      }
      case 'align': {
        const current = ctx.style().align;
        styleRanges('Align', { align: current === arg ? null : arg });
        keepFocus();
        return;
      }
      case 'fmt': {
        // The toolbar's Percent and Currency buttons press on and off ({ fmt, toggle: true }). Every other
        // caller (the Ctrl/Cmd+Shift+% and $ chords, the Format menu's radio items, the palette) applies its
        // format and leaves it applied: over cells already in it, nothing changes.
        const toggle = !!(arg && typeof arg === 'object' && arg.toggle);
        let patch;
        if (arg && typeof arg === 'object' && !toggle) {
          patch = { ...arg };
          if (patch.fmt === 'percent' && ctx.style().dec == null && ctx.style().fmt !== 'percent') patch.dec = 0;
          if (patch.fmt === 'number' && ctx.style().fmt !== 'number' && ctx.style().dec == null) patch.dec = 2;
        } else {
          const asked = toggle ? arg.fmt : arg;
          const current = ctx.style().fmt || 'general';
          const next = toggle && asked === current ? 'general' : asked;
          patch = { fmt: next === 'general' ? null : next };
          if (next === 'percent' && ctx.style().dec == null) patch.dec = 0;
          // Back to Automatic (the chord, the palette, a button pressed off) clears the format's details with it,
          // as the Format menu's entry and Format cells do, so none shapes the next entry.
          if (next === 'general') Object.assign(patch, AUTOMATIC_FORMAT);
          else if (next === 'date' || next === 'text') patch.dec = null;
        }
        // The Currency format takes the regional format's own currency on a cell in none (pounds in British
        // English, euros in German); a currency style without
        // `cur` is in US dollars already, so that one is left unstamped and a file keeps its dollars everywhere.
        if (patch.fmt === 'currency' && patch.cur === undefined && ctx.style().fmt !== 'currency') {
          const cur = cellCurrency(ctx.style());
          if (cur !== 'USD') patch.cur = cur;
        }
        // The Accounting preset takes the same currency, quoted into its code, and keeps it in the style so the
        // picker shows it and a later Currency format keeps it; a cell already in Accounting keeps its own.
        if (patch.fmt === 'custom' && patch.code === ACCOUNTING_CODE) {
          const current = ctx.style();
          if (current.fmt === 'custom' && isAccountingCode(current.code)) patch.code = current.code;
          else {
            const cur = cellCurrency(current);
            if (cur !== 'USD') { patch.code = accountingCode(cur); patch.cur = cur; }
          }
        }
        styleRanges('Number format', patch);
        keepFocus();
        return;
      }
      case 'dec': {
        // Each cell steps its own decimal places and keeps its own format: a General
        // cell becomes Number, and a date, time, text or custom code has none to step and is left alone,
        // rather than every cell taking the active cell's format. The active cell says whether there is
        // anything to step at all, as the menus and toolbar grey the command out by it.
        const fixed = ['time', 'datetime', 'date', 'text', 'custom'];
        const step = Number(arg) || 0;
        if (!step || fixed.includes(ctx.style().fmt)) return;
        const decimalPatch = (sid, r, c) => {
          // Use displayed formatting, including inherited spill formats. General
          // starts at the places shown; currencies start at their currency's count.
          const s = wb.displayStyleAt(sid, r, c) || {};
          if (fixed.includes(s.fmt)) return null;
          const fmt = s.fmt && s.fmt !== 'general' ? s.fmt : 'number';
          const shown = s.dec ?? (s.fmt === 'currency' ? currencyDecimals(s.cur)
            : !s.fmt || s.fmt === 'general' ? generalDecimals(sid, r, c) : 2);
          const dec = Math.max(0, Math.min(MAX_DECIMAL_PLACES, shown + step));
          return fmt === s.fmt && dec === s.dec ? null : { fmt, dec };
        };
        if (!nativeStyleRanges(decimalPatch)) eachRange('Decimals', (rg, skipRow, sid) => {
          const entries = [];
          for (let r = rg.r1; r <= rg.r2; r++) {
            if (skipRow?.(r)) continue;
            for (let c = rg.c1; c <= rg.c2; c++) {
              const patch = decimalPatch(sid, r, c);
              if (!patch) continue;
              const cell = wb.getCell(sid, r, c), s = wb.displayStyleAt(sid, r, c) || {};
              entries.push({ r, c, cell: { ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s: { ...s, ...patch } } });
            }
          }
          if (entries.length) wb.setCellsWithTableHeaders(sid, entries, 'Format', rg);
        }, { skipRows: true });
        keepFocus();
        return;
      }
      case 'font':
        styleRanges('Font', { font: !arg || arg === 'default' ? null : arg });
        keepFocus();
        return;
      case 'fontStep': {
        // The next size up or down the toolbar's list, stepped for each cell from its own size:
        // 13px beside 24px becomes 14 and 28, not 14 and 14 with the larger
        // cell shrunk by a command named "Larger font".
        const up = Number(arg) > 0;
        const stepSize = (size) => (up ? FONT_SIZES.find((s) => s > size) : [...FONT_SIZES].reverse().find((s) => s < size));
        wb.transaction('Font size', () => {
          if (nativeFontSizeRanges((sid, r, c) => stepSize(wb.styleAt(sid, r, c)?.size || 13))) return;
          eachRange('Font size', (rg, _, sid) => {
            const entries = [];
            const tallest = new Map(); // row → the largest size it gained, for the row height
            for (let r = rg.r1; r <= rg.r2; r++) {
              for (let c = rg.c1; c <= rg.c2; c++) {
                const cell = wb.getCell(sid, r, c);
                const s = wb.styleAt(sid, r, c) || {};
                const px = stepSize(s.size || 13);
                if (!px) continue; // already at the end of the list
                entries.push({ r, c, cell: { ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s: wb.patchedCellStyle(sid, r, c, { size: px === 13 ? null : px }) } });
                tallest.set(r, Math.max(tallest.get(r) || 0, px));
              }
            }
            if (!entries.length) return;
            wb.setCellsWithTableHeaders(sid, entries, 'Font size', rg);
            growFontRows(sid, tallest);
          });
        });
        keepFocus();
        return;
      }
      case 'fontSize': {
        let px = Number(arg);
        if (arg == null) {
          const text = await promptDialog({
            title: 'Custom font size', label: 'Font size', value: String(pxToPt(ctx.style().size || 13)), confirmLabel: 'OK', inputMode: 'decimal',
            hint: 'Enter a size from 1 to 409 points. Decimals are supported.',
            validate: (value) => /^\d+(?:\.\d+)?$/.test(value) && Number(value) >= 1 && Number(value) <= 409 ? null : 'Enter a number from 1 to 409.',
          });
          if (text == null) { keepFocus(); return; }
          px = ptToPx(Number(text));
        }
        if (!Number.isFinite(px) || px <= 0) return;
        wb.transaction('Font size', () => {
          if (nativeFontSizeRanges(() => px)) return;
          eachRange('Font size', (range, _, sid) => {
            wb.applyStyle(sid, range, { size: px === 13 ? null : px });
            const tallest = new Map();
            for (let r = range.r1; r <= range.r2; r++) tallest.set(r, px);
            growFontRows(sid, tallest);
          });
        });
        keepFocus();
        return;
      }
      case 'merge': {
        if (grid.editing) return;
        const a = grid.active;
        // Every selected range (Ctrl/Cmd+click adds ranges) becomes a merged block of its own; when any of
        // them holds merged cells already, they are all unmerged instead. One undo step either way.
        const ranges = grid.ranges;
        const existing = ranges.flatMap((range) => wb.mergesIn(sheetId, range));
        if ([...ranges, ...existing].some((g) => wb.lockedIn(sheetId, g))) return;
        const blocks = ranges.filter((range) => range.r1 !== range.r2 || range.c1 !== range.c2);
        // Merge Cells ('plain') merges without centring and leaves merged cells merged; Unmerge Cells only unmerges.
        if (arg === 'unmerge' && !existing.length) { keepFocus(); return; }
        if (arg === 'plain' && existing.length) { keepFocus(); return; }
        if (existing.length) {
          wb.transaction('Unmerge cells', () => { for (const range of ranges) wb.unmergeCells(sheetId, range); });
        } else if (blocks.length) {
          let cleared = 0;
          for (const range of blocks) eachStoredCell(wb.sheet(sheetId), range, (r, c, cell) => {
            if ((r !== range.r1 || c !== range.c1) && cell.v != null) cleared++;
          });
          const refused = [];
          wb.transaction('Merge cells', () => {
            for (const range of blocks) {
              if (wb.mergeCells(sheetId, range) === false) { refused.push(range); continue; }
              if (arg !== 'plain' && !wb.styleAt(sheetId, range.r1, range.c1)?.align) wb.applyStyle(sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 }, { align: 'center' });
            }
          });
          // The workbook declines a block past its size limit or over a table's header and data cells (a protected sheet it reports itself).
          if (refused.length === blocks.length) { if (!wb.isProtected(sheetId)) toast(mergeRefusal(refused[0]), { icon: 'info', duration: 3500 }); }
          else if (cleared) toast(`Merged. Only the top-left value${blocks.length > 1 ? ' of each block' : ''} was kept (${cleared} cleared)`, { icon: 'merge', duration: 4000 });
        }
        grid.setSelection(S.single(a.r, a.c), { scroll: false });
        keepFocus();
        return;
      }
      case 'mergeAcross': case 'mergeDown': {
        // Merge each row (or each column) of the selection on its own.
        if (grid.editing) return;
        if (!oneRange('merge')) return;
        const a = grid.active;
        // Whole columns or rows are merged line by line as far as the sheet's data reaches, not a million blocks.
        const used = wb.usedRange(sheetId);
        const range = { ...grid.range };
        if (range.r2 >= MAX_ROW) range.r2 = Math.max(range.r1, Math.min(range.r2, used?.r2 ?? range.r1));
        if (range.c2 >= MAX_COL) range.c2 = Math.max(range.c1, Math.min(range.c2, used?.c2 ?? range.c1));
        if (range.r1 === range.r2 && range.c1 === range.c2) return;
        const blocks = [];
        if (cmd === 'mergeAcross') { for (let r = range.r1; r <= range.r2; r++) if (range.c1 !== range.c2) blocks.push({ r1: r, r2: r, c1: range.c1, c2: range.c2 }); }
        else for (let c = range.c1; c <= range.c2; c++) if (range.r1 !== range.r2) blocks.push({ r1: range.r1, r2: range.r2, c1: c, c2: c });
        if (!blocks.length) return;
        if ([range, ...wb.mergesIn(sheetId, range)].some((g) => wb.lockedIn(sheetId, g))) return;
        let cleared = 0;
        eachStoredCell(wb.sheet(sheetId), range, (r, c, cell) => {
          const first = cmd === 'mergeAcross' ? c === range.c1 : r === range.r1;
          if (!first && cell.v != null) cleared++;
        });
        let refused = 0;
        wb.transaction(cmd === 'mergeAcross' ? 'Merge horizontally' : 'Merge vertically', () => {
          wb.unmergeCells(sheetId, range);
          for (const b of blocks) if (wb.mergeCells(sheetId, b) === false) refused++;
        });
        if (refused === blocks.length) { if (!wb.isProtected(sheetId)) toast(mergeRefusal(range), { icon: 'info', duration: 3500 }); }
        else if (cleared) toast(`Merged. Only the first value of each ${cmd === 'mergeAcross' ? 'row' : 'column'} was kept (${cleared} cleared)`, { icon: 'merge', duration: 4000 });
        grid.setSelection(S.fromRange(range, a), { scroll: false });
        keepFocus();
        return;
      }
      case 'indent': {
        // Each cell steps from its own indent, rather than every
        // cell taking the active cell's level: Increase indent over a cell at 0 and one at 5 gives 1 and 6,
        // not 1 and 1 with four levels lost.
        const by = Number(arg) || 0;
        if (!by) return;
        const indentPatch = (sid, r, c) => {
          const current = wb.styleAt(sid, r, c)?.indent || 0;
          const indent = Math.max(0, Math.min(10, current + by));
          return indent === current ? null : { indent: indent || null };
        };
        if (!nativeStyleRanges(indentPatch)) eachRange('Indent', (rg, skipRow, sid) => {
          const entries = [];
          for (let r = rg.r1; r <= rg.r2; r++) {
            if (skipRow?.(r)) continue;
            for (let c = rg.c1; c <= rg.c2; c++) {
              const patch = indentPatch(sid, r, c);
              if (!patch) continue;
              const cell = wb.getCell(sid, r, c);
              entries.push({ r, c, cell: { ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s: wb.patchedCellStyle(sid, r, c, patch) } });
            }
          }
          if (entries.length) wb.setCellsWithTableHeaders(sid, entries, 'Indent', rg);
        }, { skipRows: true });
        keepFocus();
        return;
      }
      case 'valign':
        styleRanges('Align', { valign: arg === 'middle' ? null : arg });
        keepFocus();
        return;
      case 'wrapMode': {
        // Text wrapping: overflow into empty neighbours (default), wrap onto lines, or clip at the cell edge.
        const patch = arg === 'wrap' ? { wrap: true, clip: null } : arg === 'clip' ? { wrap: null, clip: true } : { wrap: null, clip: null };
        fittedStyleRanges('Text wrapping', patch, arg === 'wrap');
        keepFocus();
        return;
      }
      case 'rotate': {
        // Text rotation in degrees, -90..90; positive tilts the text up. Rows grow to fit.
        if (!committed()) return;
        let deg = arg;
        if (arg === 'custom') {
          const text = await promptDialog({
            title: 'Text rotation', label: 'Angle in degrees, from -90 to 90 (positive tilts the text up)',
            value: String(ctx.style().rot || 0), confirmLabel: 'Rotate',
            validate: (v) => (/^-?\d{1,2}$/.test(v.trim()) && Math.abs(Number(v)) <= 90 ? null : 'Enter a whole number from -90 to 90'),
          });
          if (text == null) return;
          deg = Number(text);
        }
        deg = Math.max(-90, Math.min(90, Math.round(Number(deg) || 0)));
        fittedStyleRanges('Text rotation', { rot: deg || null }, !!deg);
        keepFocus();
        return;
      }
      case 'color': case 'bg':
        styleRanges('Color', { [cmd]: arg || null });
        keepFocus();
        return;
      case 'borders': {
        const kind = arg && typeof arg === 'object' ? arg.kind : arg;
        const options = arg && typeof arg === 'object' ? { color: arg.color ?? null, style: arg.style ?? 'thin' } : {};
        // Never truncate border geometry: a clipped range would move its edges.
        if (!nativeFormatRanges((sid, ranges) => formatNativePivotBorders(wb, new Map([[sid, ranges]]), kind,
          { ...options, maxCells: MAX_FORMAT_CELLS }), { cap: false })) {
          eachRange('Borders', (rg, _, sid) => wb.applyBorders(sid, rg, kind, options), { cap: false, nativeScope: true });
        }
        keepFocus();
        return;
      }
      case 'cellStylesMenu':
        // The gallery: built-in, custom and themed styles, with New Cell Style… and Merge Styles… (ui/cellstyles-ui.js).
        openCellStylesGallery(ctx, arg);
        return;
      case 'cellStyle': {
        // A custom style, or a built-in this workbook modified, applies its own definition's parts; a built-in as
        // it comes applies its preset. Either way the cells keep the style's name, to follow it when it changes.
        const own = definitionFor(wb, arg);
        const builtIn = own ? null : themedPreset(cellStyle(arg), wb) || themedCellStylePatch(arg, wb);
        const preset = own ? { label: own.name, ...stylePatch(own) } : builtIn && { ...builtIn, patch: { ...builtIn.patch, cellStyle: arg === 'normal' ? null : builtIn.label } };
        if (!preset) return;
        const borders = (preset.borders || []).map(b => ({ ...b, color: b.color ?? null, style: b.style ?? 'thin' }));
        if (!nativeFormatRanges((sid, ranges) => formatNativePivotStyleAndBorders(wb, new Map([[sid, ranges]]), preset.patch, borders,
          { maxCells: MAX_FORMAT_CELLS, defaultSize: 13 }), { cap: false })) {
          wb.transaction(`Cell style: ${preset.label}`, () => eachRange('Cell style', (rg, _, sid) => {
            wb.applyStyle(sid, rg, preset.patch);
            for (const b of borders) wb.applyBorders(sid, rg, b.kind, b);
          }, { cap: false, nativeScope: true }));
        }
        keepFocus();
        return;
      }
      case 'clearFormat':
        if (!nativeFormatRanges((sid, ranges) => clearNativePivotSelection(wb, new Map([[sid, ranges]]),
          { maxCells: MAX_FORMAT_CELLS, defaultSize: 13 }), { cap: false })) {
          eachRange('Clear formatting', (rg, skipRow, sid) => wb.clearRange(sid, rg, { contents: false, styles: true, skipRow }), { cap: false, skipRows: true });
        }
        keepFocus();
        return;
      case 'formatCells':
        if (!committed()) return;
        openFormatCellsDialog(ctx, { panel: typeof arg === 'string' ? arg : 'number' });
        return;
      case 'applyFormat': {
        // From the Format cells dialog: a style patch and ordered border actions, as one undo step.
        const { patch = {}, border = null, borders: edgeBorders = null } = arg || {};
        const borders = (Array.isArray(edgeBorders) ? edgeBorders : border ? [border] : [])
          .map(b => ({ ...b, color: b.color ?? null, style: b.style ?? 'thin' }));
        wb.transaction('Format cells', () => {
          const fit = (sid, ranges) => {
            if (sid === grid.sheetId && (patch.wrap || patch.rot || patch.size)) for (const rg of ranges) grid.autoFitRows(rg.r1, Math.min(rg.r2, rg.r1 + 500));
          };
          if (nativeFormatRanges((sid, ranges) => formatNativePivotStyleAndBorders(wb, new Map([[sid, ranges]]), patch, borders,
            { maxCells: MAX_FORMAT_CELLS, defaultSize: 13 }), { cap: false, onApplied: fit })) return;
          eachRange('Format cells', (rg, _, sid) => {
            if (Object.keys(patch).length) wb.applyStyle(sid, rg, patch);
            for (const b of borders) wb.applyBorders(sid, rg, b.kind, b);
            fit(sid, [rg]);
          }, { cap: false, nativeScope: true });
        });
        keepFocus();
        return;
      }
      case 'paintFormat': {
        // Copy the selection's formatting; the next selection receives it: one made with the
        // pointer, or one moved to with the keyboard and confirmed by Enter or this command again.
        // A double-click on Paint format ('sticky') keeps painting every selection until Escape.
        if (!committed()) return;
        const sticky = arg === 'sticky';
        if (painter && sticky && onPainterSource()) {
          painter.sticky = true;
          toast('Formatting copied. Select each range to paint; Escape stops', { icon: 'paint', duration: 3000 });
          notify(); keepFocus();
          return;
        }
        if (painter) {
          // Run again while still on the source, the painter is put away.
          if (onPainterSource()) stopPainting(); else applyPainter();
          keepFocus();
          return;
        }
        const range = grid.range;
        if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 10000) { toast('Select a smaller area to copy formatting from', { icon: 'info' }); return; }
        painter = { cells: wb.copyRange(sheetId, range), range, sheetId, sticky };
        grid.el.classList.add('painting');
        toast(sticky ? 'Formatting copied. Select each range to paint; Escape stops' : 'Formatting copied. Select the cells to paint (Escape cancels)', { icon: 'paint', duration: 3000 });
        notify();
        keepFocus();
        return;
      }
      // The Clear menu: everything, notes, or links in the selection, each one undo step.
      case 'calcMode':
        wb.setCalcMode(arg);
        toast(arg === 'manual' ? 'Manual calculation: press F9 to calculate' : 'Automatic calculation', { icon: 'calculator', duration: 2200 });
        notify(); keepFocus();
        return;
      case 'insertDialog': case 'deleteDialog':
        if (!committed()) return;
        openInsertDeleteDialog(ctx, cmd === 'insertDialog' ? 'insert' : 'delete');
        return;
      case 'clearAll':
        if (grid.editing) return;
        wb.transaction('Clear All', () => {
          eachRange('Clear All', (rg, skipRow, sid) => wb.clearRange(sid, rg, { contents: true, styles: true, skipRow }), { cap: false, skipRows: true });
          clearInSelection('notes');
          clearInSelection('links');
        });
        keepFocus();
        return;
      case 'clearNotes':
        if (!committed()) return;
        wb.transaction('Clear Comments and Notes', () => clearInSelection('notes'));
        keepFocus();
        return;
      case 'clearLinks':
        if (!committed()) return;
        wb.transaction('Clear Hyperlinks', () => clearInSelection('links'));
        keepFocus();
        return;
      case 'clear':
        if (grid.editing) return;
        eachRange('Clear', (rg, skipRow) => wb.clearRange(sheetId, rg, { contents: true, skipRow }), { cap: false, skipRows: true });
        keepFocus();
        return;
      case 'insertRows': {
        if (!committed()) return;
        if (!oneRange('insert rows')) return;
        const r = grid.range;
        // Whole columns selected: one row goes in at the active cell, not a sheet's worth.
        const wholeCols = r.r1 === 0 && r.r2 >= wb.sheet(sheetId).rows - 1;
        const n = wholeCols ? 1 : r.r2 - r.r1 + 1;
        const at = wholeCols ? grid.active.r + (arg === 'above' ? 0 : 1) : arg === 'above' ? r.r1 : r.r2 + 1;
        const before = selectionSnapshot();
        if (wb.pivotLineEditBlocked(sheetId, 'row', at, n)) { keepFocus(); return; }
        if (!wb.insertRows(sheetId, at, n)) {
          if (!wb.isProtected(sheetId)) toast(`${n === 1 ? 'The row' : 'The rows'} cannot be inserted here: cells would be pushed off the sheet`, { icon: 'alert', duration: 3500 });
          keepFocus();
          return;
        }
        grid.setSelection(S.selectRows(at, at + n - 1, { rows: wb.sheet(sheetId).rows, cols: wb.sheet(sheetId).cols }), { scroll: false });
        rememberStepSelection(before);
        keepFocus();
        return;
      }
      case 'insertCols': {
        if (!committed()) return;
        if (!oneRange('insert columns')) return;
        const r = grid.range;
        const wholeRows = r.c1 === 0 && r.c2 >= wb.sheet(sheetId).cols - 1;
        const n = wholeRows ? 1 : r.c2 - r.c1 + 1;
        const at = wholeRows ? grid.active.c + (arg === 'left' ? 0 : 1) : arg === 'left' ? r.c1 : r.c2 + 1;
        const before = selectionSnapshot();
        if (wb.pivotLineEditBlocked(sheetId, 'col', at, n)) { keepFocus(); return; }
        if (!wb.insertCols(sheetId, at, n)) {
          if (!wb.isProtected(sheetId)) toast(`${n === 1 ? 'The column' : 'The columns'} cannot be inserted here: cells would be pushed off the sheet`, { icon: 'alert', duration: 3500 });
          keepFocus();
          return;
        }
        grid.setSelection(S.selectCols(at, at + n - 1, { rows: wb.sheet(sheetId).rows, cols: wb.sheet(sheetId).cols }), { scroll: false });
        rememberStepSelection(before);
        keepFocus();
        return;
      }
      case 'insertCells': {
        // Insert blank cells here, pushing the cells below (or to the right) out of the way.
        if (!committed()) return;
        if (!oneRange('insert cells')) return;
        const range = grid.range;
        const sideways = arg === 'right';
        if (wb.pivotBlockEditBlocked(sheetId, range, sideways ? 'col' : 'row', false)) { keepFocus(); return; }
        const ok = wb.insertCells(sheetId, range, sideways ? 'right' : 'down');
        if (!ok) {
          if (!wb.isProtected(sheetId)) toast(shiftProblem(sheetId, range, sideways ? 'col' : 'row', false)
            || `The cells cannot be shifted: what is ${sideways ? 'to their right' : 'below them'} would be pushed past the edge of the sheet`, { icon: 'info', duration: 4000 });
          return;
        }
        grid.setSelection(S.fromRange(range, grid.active), { scroll: false });
        keepFocus();
        return;
      }
      case 'deleteCells': {
        if (!committed()) return;
        if (!oneRange('delete cells')) return;
        const range = grid.range;
        if (wb.pivotBlockEditBlocked(sheetId, range, arg === 'left' ? 'col' : 'row', true)) { keepFocus(); return; }
        if (!wb.deleteCells(sheetId, range, arg === 'left' ? 'left' : 'up')) {
          if (!wb.isProtected(sheetId)) toast('That shift would split a table or remove its header', { icon: 'info' });
          return;
        }
        grid.setSelection(S.fromRange(range, grid.active), { scroll: false });
        keepFocus();
        return;
      }
      case 'deleteRows': case 'deleteCols': {
        // Several ranges (Ctrl/Cmd+click) delete every line they touch, bottom-up, in one undo step.
        if (!committed()) return;
        const isRow = cmd === 'deleteRows';
        if (refusedByProtection(isRow ? 'delete rows' : 'delete columns')) return;
        let runs = lineRuns(grid.ranges, isRow ? 'row' : 'col');
        // Rows a filter hides are not part of what the user sees selected; only the shown rows go.
        const hidden = isRow ? wb.sheet(sheetId)?.filterHidden : null;
        if (hidden?.size) {
          runs = runs.flatMap(({ from, to }) => {
            const parts = [];
            let end = null;
            for (let i = to; i >= from - 1; i--) {
              const shown = i >= from && !hidden.has(i);
              if (shown && end == null) end = i;
              if (!shown && end != null) { parts.push({ from: i + 1, to: end }); end = null; }
            }
            return parts;
          });
        }
        const r = grid.range;
        const before = selectionSnapshot();
        // One deletion for every run: the workbook renumbers cells and formulas once, however many runs a filter made.
        if (!wb.deleteLines(sheetId, isRow ? 'row' : 'col', runs)) { keepFocus(); return; }
        const sheet = wb.sheet(sheetId);
        grid.setSelection(isRow ? S.single(Math.min(r.r1, sheet.rows - 1), grid.active.c) : S.single(grid.active.r, Math.min(r.c1, sheet.cols - 1)));
        // Undoing brings the lines back: the selection goes back to the lines the user had, as it does for an
        // insert, rather than staying on the single cell the deletion left behind.
        rememberStepSelection(before);
        keepFocus();
        return;
      }
      case 'sort': {
        if (!committed()) return;
        if (refusedByProtection('sort')) return;
        if (!oneRange('sort')) return;
        // In a sheet view the filters are one's own, but sorting moves the rows themselves, for everyone.
        if (wb.sheet(sheetId)?.personalView) toast('Sorting reorders the rows for everyone; in a sheet view only the filters are your own', { icon: 'info', duration: 3500 });
        let range = grid.range;
        const single = S.isSingle(grid.selection);
        const sheet = wb.sheet(sheetId);
        // A single cell sorts the block of data around it; whole columns (the
        // column header's menu) sort the sheet's rows by that column, each row
        // kept together. A header row is left in place: the block around a cell
        // and whole columns are read for one as the sort dialog reads them; an
        // explicit selection keeps its first row only when that text row sits
        // over typed values, so a plain list of names sorts whole.
        const wholeCols = range.r1 === 0 && range.r2 >= sheet.rows - 1;
        // A toolbar click leaves the focus on its button: the grid takes it back once the command is done.
        if (single || wholeCols) {
          range = single ? dataRange() : wb.usedRange(sheetId);
          if (!range) { toast('Nothing to sort', { icon: 'info' }); keepFocus(); return; }
        }
        const col = grid.active.c;
        let { r1 } = range;
        // The sort dialog's default header rule, shared so a quick sort and the dialog keep the same first row.
        if (r1 < range.r2 && sortHeaderDefault(wb, sheetId, range, { expanded: single || wholeCols })) r1++;
        const rows = { ...range, r1, r2: Math.min(range.r2, sheet.rows - 1) };
        if (!wb.sortRange(sheetId, rows, col, arg !== 'desc')) { toast(rearrangeProblem(wb, sheetId, rows, 'row') || 'Nothing to sort', { icon: 'info' }); keepFocus(); return; }
        toast(arg === 'desc' ? 'Sorted Z to A' : 'Sorted A to Z');
        keepFocus();
        return;
      }
      case 'hide': case 'unhide': {
        if (!committed()) return;
        if (refusedByProtection('hide or show lines')) return;
        const r = grid.range;
        const axis = arg;
        const from = axis === 'row' ? r.r1 : r.c1;
        const to = axis === 'row' ? r.r2 : r.c2;
        const indices = [];
        for (const run of lineRuns(grid.ranges, axis)) for (let i = run.from; i <= run.to; i++) indices.push(i);
        if (cmd === 'hide') {
          const sheet = wb.sheet(sheetId);
          const total = axis === 'row' ? sheet.rows : sheet.cols;
          // A row a filter hides is as invisible as one hidden by hand, so the landing skips both.
          const hiddenAt = (i) => (axis === 'row' ? wb.isRowHidden(sheetId, i) : sheet.hiddenCols.has(i));
          // The workbook keeps at least one line showing; asking to hide them all is told so rather than ignored (a protected sheet it reports itself).
          if (wb.setHidden(sheetId, axis, indices, true) === false) { if (!wb.isProtected(sheetId)) toast(`Every ${axis === 'row' ? 'row' : 'column'} cannot be hidden: the sheet keeps at least one showing`, { icon: 'info', duration: 3000 }); keepFocus(); return; }
          // Land on the next visible line so the selection is not invisible.
          let next = to + 1;
          while (next < total && hiddenAt(next)) next++;
          if (next >= total) { next = from - 1; while (next >= 0 && hiddenAt(next)) next--; }
          if (next >= 0) grid.setSelection(axis === 'row' ? S.single(next, grid.active.c) : S.single(grid.active.r, next), { scroll: false });
        } else {
          wb.setHidden(sheetId, axis, indices, false);
        }
        keepFocus();
        return;
      }
      case 'group': case 'ungroup': {
        // Rows by default; columns when whole columns are selected (or asked for).
        if (!committed()) return;
        if (refusedByProtection('group rows or columns')) return;
        // A group is one run of lines: several ranges are refused rather than the last one added grouped.
        if (!oneRange(cmd === 'group' ? 'group rows or columns' : 'ungroup rows or columns')) return;
        const r = grid.range;
        const sheet = wb.sheet(sheetId);
        const wholeCols = r.r1 === 0 && r.r2 >= sheet.rows - 1 && !(r.c1 === 0 && r.c2 >= sheet.cols - 1);
        const axis = arg === 'col' || arg === 'row' ? arg : wholeCols ? 'col' : 'row';
        const from = axis === 'row' ? r.r1 : r.c1;
        const to = axis === 'row' ? r.r2 : r.c2;
        const what = axis === 'row' ? 'rows' : 'columns';
        if (cmd === 'group') {
          const ok = wb.groupLines(sheetId, axis, from, to);
          toast(ok ? `Grouped ${what} ${axis === 'row' ? `${from + 1}–${to + 1}` : `${colName(from)}–${colName(to)}`}. Use the − button beside the headers to collapse` : `Those ${what} cannot be grouped like that (a group may sit inside another, not across one)`, { icon: ok ? 'check' : 'info', duration: 3200 });
        } else {
          const n = wb.ungroupLines(sheetId, axis, from, to);
          toast(n ? `Ungrouped ${what}` : `No group of ${what} here`, { icon: n ? 'check' : 'info' });
        }
        keepFocus();
        return;
      }
      case 'collapseAll': case 'expandAll':
        wb.setAllGroups(sheetId, arg === 'col' ? 'col' : 'row', cmd === 'collapseAll');
        keepFocus();
        return;
      case 'toggleGroup':
        if (arg) wb.toggleGroup(sheetId, arg.axis, arg.from, arg.to);
        keepFocus();
        return;
      case 'freeze': {
        const sheet = wb.sheet(sheetId);
        const a = grid.active;
        const rg = grid.range;
        // Whole columns (or rows) selected: freeze up to the active cell, not a sheet's worth.
        const wholeCols = rg.r1 === 0 && rg.r2 >= sheet.rows - 1;
        const wholeRows = rg.c1 === 0 && rg.c2 >= sheet.cols - 1;
        let rows = sheet.frozenRows;
        let cols = sheet.frozenCols;
        const r0 = rows ? sheet.frozenOrigin?.r || 0 : 0;
        const c0 = cols ? sheet.frozenOrigin?.c || 0 : 0;
        if (arg === 'none') { rows = 0; cols = 0; }
        else if (arg === 'first-row') rows = 1;
        else if (arg === 'first-col') cols = 1;
        else if (arg === 'here') { rows = Math.max(0, a.r - r0); cols = Math.max(0, a.c - c0); }
        // Freezing up to the selection reads its last row (or column): a Ctrl/Cmd+click selection of several
        // ranges is refused rather than frozen up to the last range added, which may be far down the sheet.
        else if (arg === 'rows') { if (!oneRange('freeze rows')) return; rows = Math.max(0, (wholeCols ? a.r : rg.r2) + 1 - r0); }
        else if (arg === 'cols') { if (!oneRange('freeze columns')) return; cols = Math.max(0, (wholeRows ? a.c : rg.c2) + 1 - c0); }
        else if (arg === 'rows-none') rows = 0;
        else if (arg === 'cols-none') cols = 0;
        else if (arg && typeof arg === 'object') { rows = arg.rows ?? rows; cols = arg.cols ?? cols; }
        wb.setFrozen(sheetId, rows, cols);
        ({ frozenRows: rows, frozenCols: cols } = sheet); // what was stored, within the workbook's limits
        // What the grid froze: a pane that would fill most of the window is not drawn, and its lines still scroll.
        const shown = grid.frozen;
        const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
        const both = (a, b) => [a, b].filter(Boolean).join(' and ');
        const frozenText = both(shown.rows ? count(shown.rows, 'row') : '', shown.cols ? count(shown.cols, 'column') : '');
        const dropped = both(rows && !shown.rows ? count(rows, 'row') : '', cols && !shown.cols ? count(cols, 'column') : '');
        const droppedText = dropped ? `${dropped} would fill most of the window, so ${dropped.includes(' and ') || !dropped.startsWith('1 ') ? 'they are' : 'it is'} not frozen` : '';
        if (frozenText || dropped) toast([frozenText ? `Frozen ${frozenText}` : '', droppedText].filter(Boolean).join('. '), { icon: 'pin', duration: dropped ? 3200 : 1600 });
        keepFocus();
        return;
      }
      case 'split':
        // View ▸ Split: at the active cell, or off again; splitting unfreezes and freezing unsplits.
        grid.toggleSplit();
        keepFocus();
        return;
      case 'filter': {
        if (!committed()) return;
        if (refusedByProtection('change the filter')) return;
        const sheet = wb.sheet(sheetId);
        const filter = wb.filterAt(sheetId, grid.active.r, grid.active.c);
        if (filter) { wb.activateFilter(sheetId, filter); wb.clearFilter(sheetId); toast('Filter removed', { icon: 'filter' }); keepFocus(); return; }
        if (!oneRange('create a filter')) return;
        const range = dataRange();
        if (!range || range.r1 >= range.r2) { toast('Select at least two rows, with headers on top', { icon: 'info' }); keepFocus(); return; }
        wb.setFilterRange(sheetId, range);
        toast('Filter added. Use the buttons in the header row', { icon: 'filter' });
        keepFocus();
        return;
      }
      case 'filterMenu': openFilterMenu(arg); return;
      case 'sortDialog': {
        if (!committed()) return;
        if (!oneRange('sort')) return;
        const range = dataRange();
        if (!range) { toast('Nothing to sort', { icon: 'info' }); return; }
        openSortDialog(ctx, range);
        return;
      }
      case 'evaluateFormula': if (!committed()) return; openEvaluateDialog(ctx); return;
      case 'aiFormula': if (!committed()) return; openAiDialog(ctx, { mode: 'write' }); return;
      case 'aiExplain': if (!committed()) return; openAiDialog(ctx, { mode: 'explain' }); return;
      case 'aiAsk': if (!committed()) return; openAiDialog(ctx, { mode: 'ask' }); return;
      case 'aiPanel':
        if (!aiPanel || !P.canAI()) { toast(appOption('aiFeatures') ? 'AI is not available here' : 'AI features are turned off in Options ▸ Privacy', { icon: 'info' }); return; }
        // Opened from the keyboard mid-entry, the panel leaves the focus on the cell being typed into.
        if (arg === false || (arg == null && aiPanel.isOpen)) aiPanel.close();
        else aiPanel.open({ focus: !grid.editing, prompt: typeof arg === 'string' ? arg : null });
        return;
      case 'insertTable': {
        if (!committed()) return;
        const a = grid.active;
        const existing = wb.tableAt(sheetId, a.r, a.c);
        const preset = typeof arg?.style === 'string' ? arg.style : null;
        // Format as Table on a table restyles it; elsewhere the Create Table dialog opens with the style chosen.
        if (existing && preset) { if (!refusedByProtection('change the table')) wb.updateTable(sheetId, existing.id, { style: preset, customStyle: null }); keepFocus(); return; }
        if (existing) { openTableDialog(ctx, { table: existing }); return; }
        if (!oneRange('create a table')) return;
        const range = dataRange(grid.range);
        if (range.r1 >= range.r2) { toast('Select the header row and at least one row of data', { icon: 'info' }); return; }
        openTableDialog(ctx, { range, style: preset });
        return;
      }
      case 'formatAsTableMenu': {
        // Home ▸ Format as Table: the table styles as a gallery of samples.
        const anchor = arg instanceof HTMLElement ? arg : null;
        const gallery = el('div.table-gallery', { role: 'group', 'aria-label': 'Table styles' }, ...TABLE_STYLES.map(([key, label, look]) => el('button.table-gallery-item', {
          type: 'button', role: 'menuitem', title: label, 'aria-label': `${label} table style`, onclick: () => { menu.close(); run('insertTable', { style: key }); },
        }, el('span.ribbon-table-sample', { 'aria-hidden': 'true', style: { '--table-head': look.header, '--table-band': look.band } },
          ...Array.from({ length: 12 }, (_, i) => el('span', { dataset: { row: Math.floor(i / 3) } }))), el('span.table-gallery-label', {}, label))));
        const menu = openMenu({ anchor, label: 'Format as Table', minWidth: 300, items: [{ header: 'Table styles' }, { custom: gallery }, { separator: true }, { label: 'New Table…', icon: 'table', onSelect: () => run('insertTable') }] });
        gallery.querySelector('button')?.focus();
        return;
      }
      case 'editTableById': {
        // From the names manager: switch to the table's sheet, select it, and open its dialog.
        const t = wb.tableById(arg.sheetId, arg.id);
        if (!t) return;
        if (arg.sheetId !== wb.activeSheetId) wb.setActiveSheet(arg.sheetId);
        grid.setSelection(S.fromRange(t.range, { r: t.range.r1, c: t.range.c1 }));
        openTableDialog(ctx, { table: t });
        return;
      }
      case 'editTable': {
        if (!committed()) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (t) openTableDialog(ctx, { table: t });
        return;
      }
      case 'tableTotals': {
        if (grid.editing || refusedByProtection('change the table')) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (t) wb.setTableTotals(sheetId, t.id, !t.totalsRow);
        keepFocus();
        return;
      }
      case 'tableSource': {
        if (grid.editing || refusedByProtection('use the table')) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (!t) return;
        const range = { ...t.range, r2: t.range.r2 - (t.totalsRow ? 1 : 0) };
        if (arg === 'pivot') openPivotDialog({ ...ctx, dataRange: () => range });
        else if (arg === 'dedupe') openDedupeDialog(ctx, range);
        return;
      }
      case 'tableResize': {
        if (grid.editing || refusedByProtection('resize the table')) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (t) openTableResizeDialog(ctx, t);
        return;
      }
      case 'insertSlicer': case 'insertTimeline': {
        if (!committed() || refusedByProtection(cmd === 'insertSlicer' ? 'insert slicers' : 'insert a timeline')) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        const pivot = nativePivotAt(wb, sheetId, grid.active.r, grid.active.c);
        if (cmd === 'insertTimeline') {
          if (pivot) openInsertTimelineDialog(ctx, pivot);
          else toast('Select a cell in a PivotTable that has a date field to insert a timeline', { icon: 'info', duration: 3000 });
          return;
        }
        const problem = t ? tableSlicerProblem(wb, sheetId, t) : pivot ? null : tableSlicerProblem(wb, sheetId, null);
        if (problem) { toast(problem, { icon: 'info', duration: 3000 }); return; }
        openInsertSlicersDialog(ctx, t ? { table: t } : { pivot });
        return;
      }
      case 'tableRename': {
        if (grid.editing) return 'Finish the cell entry before renaming the table.';
        if (refusedByProtection('rename the table')) return 'Unprotect the sheet to rename the table.';
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (!t || t.id !== arg?.id) return 'Select this table before renaming it.';
        const name = String(arg.name ?? '').trim();
        const problem = wb.validateTableName(name, t.name);
        if (problem) return problem;
        return wb.updateTable(sheetId, t.id, { name }) ? null : 'The table could not be renamed.';
      }
      case 'tableOption': case 'tableStyle': case 'tableConvert': {
        // Contextual ribbon and menus share the workbook's existing table transactions.
        // Never commit a cell entry just to act on the table behind it.
        if (grid.editing || refusedByProtection('change the table')) return;
        const t = wb.tableAt(sheetId, grid.active.r, grid.active.c);
        if (!t) return;
        if (cmd === 'tableConvert') wb.deleteTable(sheetId, t.id);
        else if (cmd === 'tableStyle') {
          if (!TABLE_STYLES.some(([key]) => key === arg)) return;
          wb.updateTable(sheetId, t.id, { style: arg, customStyle: null });
        } else if (arg === 'headerRow' || arg === 'filterButton') {
          const problem = arg === 'headerRow' ? setTableHeaderRow(wb, sheetId, t.id, t.headerRow === false)
            : setTableFilterButton(wb, sheetId, t.id, !tableFilterButtonOn(wb, sheetId, t));
          if (problem) toast(problem, { icon: 'info', duration: 3000 });
        } else {
          if (!['banded', 'bandedColumns', 'firstColumn', 'lastColumn'].includes(arg)) return;
          const on = arg === 'banded' ? t.banded !== false : !!t[arg];
          wb.updateTable(sheetId, t.id, { [arg]: !on });
        }
        keepFocus();
        return;
      }
      // Data ▸ Form: a record at a time over the list at the selection (see ui/dataform.js, core/data-form.js).
      case 'dataForm': {
        if (!committed()) return;
        openDataForm(ctx);
        return;
      }
      // Data ▸ Queries & Connections ▸ Edit Links: the book's links to other workbooks (see ui/editlinks.js, core/edit-links.js).
      case 'editLinks': {
        if (!committed()) return;
        openEditLinks(ctx, linkHost());
        return;
      }
      case 'subtotal': {
        if (!committed()) return;
        if (!oneRange('add subtotals')) return;
        const range = dataRange();
        if (!range) { toast('Nothing to subtotal', { icon: 'info' }); return; }
        openSubtotalDialog(ctx, range);
        return;
      }
      /* ---------- Cell styles management and outline tools ---------- */
      case 'newCellStyle': if (!committed()) return; openStyleDialog(ctx, { mode: 'new' }); return;
      case 'modifyCellStyle': case 'duplicateCellStyle': {
        if (!committed()) return;
        // From the menus a style comes by its name or preset key; from the gallery as { builtin } or { custom }.
        const ref = typeof arg === 'string' ? (cellStyle(arg) ? { builtin: arg } : { custom: arg }) : arg;
        openStyleDialog(ctx, { mode: cmd === 'modifyCellStyle' ? 'modify' : 'duplicate', ref });
        return;
      }
      case 'saveCellStyle': {
        if (!arg?.def) return;
        const n = saveCellStyle(wb, arg);
        toast(arg.oldName ? `Style ${arg.def.name} saved${n ? `; ${n} cell${n === 1 ? '' : 's'} updated` : ''}` : `Style ${arg.def.name} added to Cell Styles`, { icon: 'paint', duration: 2600 });
        keepFocus();
        return;
      }
      case 'deleteCellStyle': {
        if (!committed()) return;
        const ref = typeof arg === 'string' ? (cellStyle(arg) ? { builtin: arg } : { custom: arg }) : arg;
        if (ref?.builtin) {
          if (!builtinOverride(wb, ref.builtin)) { toast('Built-in styles stay in the gallery. Modify one to change it for this spreadsheet', { icon: 'info', duration: 3200 }); return; }
          deleteCellStyle(wb, ref);
          toast(`${cellStyle(ref.builtin).label} is as built in again`, { icon: 'check' });
          keepFocus();
          return;
        }
        if (!customStyleNamed(wb, ref?.custom)) return;
        const ok = await confirmDialog({ title: `Delete style "${ref.custom}"?`, message: 'Cells formatted with it keep their formatting. You can undo this.', confirmLabel: 'Delete style' });
        if (ok) deleteCellStyle(wb, ref);
        keepFocus();
        return;
      }
      case 'mergeCellStyles':
        if (!committed()) return;
        openMergeStylesDialog(ctx, {
          listFiles: () => P.listFiles(), pickFile: P.canPickFiles() ? () => P.pickFile({ accept: ['.xlsx', '.xlsm', '.ods'] }) : null,
          readFile: (path) => P.readFile(path), open: (bytes, name) => workbookFromFile(bytes, name), currentPath: doc.path,
        });
        return;
      case 'autoOutline': {
        if (!committed()) return;
        if (refusedByProtection('outline rows and columns')) return;
        // A single cell outlines the whole sheet; a selected block only what lies in it.
        const rg = grid.range;
        const n = autoOutline(wb, sheetId, rg.r1 === rg.r2 && rg.c1 === rg.c2 ? null : rg);
        toast(n ? `Outline built: ${n} group${n === 1 ? '' : 's'} from the summary formulas` : 'No summary formulas (such as SUM or SUBTOTAL next to the cells they total) to build an outline from', { icon: n ? 'check' : 'info', duration: 3600 });
        keepFocus();
        return;
      }
      case 'clearOutline': {
        if (!committed()) return;
        if (refusedByProtection('clear the outline')) return;
        const rg = grid.range;
        const sheet = wb.sheet(sheetId);
        const whole = (rg.r1 === rg.r2 && rg.c1 === rg.c2) || (rg.r1 === 0 && rg.c1 === 0 && rg.r2 >= sheet.rows - 1 && rg.c2 >= sheet.cols - 1);
        toast(clearOutline(wb, sheetId, whole ? null : rg) ? 'Outline cleared' : 'No outline here to clear', { icon: 'info' });
        keepFocus();
        return;
      }
      case 'outlineSettings': {
        if (!committed()) return;
        if (!arg?.settings) { openOutlineSettings(ctx); return; }
        // From the dialog: keep its settings, then Create or Apply Styles with them, as one step.
        let made = 0;
        let styled = true;
        wb.transaction(arg.then === 'create' ? 'Auto Outline' : arg.then === 'styles' ? 'Apply outline styles' : 'Outline settings', () => {
          wb.setOutlineSettings(sheetId, arg.settings);
          if (arg.then === 'create') made = autoOutline(wb, sheetId);
          if (arg.then === 'styles') styled = applyOutlineStyles(wb, sheetId);
        });
        if (arg.then === 'create') toast(made ? `Outline built: ${made} group${made === 1 ? '' : 's'}` : 'No summary formulas to build an outline from', { icon: made ? 'check' : 'info', duration: 3200 });
        if (arg.then === 'styles' && !styled) toast('There is no outline to style yet', { icon: 'info' });
        grid.refresh();
        keepFocus();
        return;
      }
      case 'textCase': {
        if (!committed()) return;
        if (refusedByProtection('change the text')) return;
        // Every selected range, and only the rows a filter shows, as clearing and formatting cover them; one undo step.
        let n = 0;
        let refused = false;
        const done = eachRange(arg === 'number' ? 'Convert to numbers' : 'Change text', (rg) => {
          const changed = wb.transformText(sheetId, rg, arg);
          if (changed === false) refused = true; else n += changed;
        }, { cap: false });
        // A protected cell refused the change; the workbook's notice has named it.
        if (done === null || (!n && refused)) { keepFocus(); return; }
        const label = { trim: 'Trimmed', upper: 'Uppercased', lower: 'Lowercased', proper: 'Capitalized', number: 'Converted' }[arg] || 'Changed';
        toast(n ? `${label} ${n} cell${n === 1 ? '' : 's'}` : arg === 'number' ? 'No text that reads as a number' : 'No text to change', { icon: n ? 'check' : 'info' });
        keepFocus();
        return;
      }
      case 'textMenu': {
        const anchor = arg instanceof HTMLElement ? arg : null;
        openMenu({
          anchor, x: anchor ? null : (arg?.x ?? null), y: anchor ? null : (arg?.y ?? null), label: 'Change text',
          items: [
            { label: 'Trim whitespace', icon: 'text', onSelect: () => run('textCase', 'trim') },
            { label: 'UPPERCASE', icon: 'text', onSelect: () => run('textCase', 'upper') },
            { label: 'lowercase', icon: 'text', onSelect: () => run('textCase', 'lower') },
            { label: 'Capitalize Each Word', icon: 'text', onSelect: () => run('textCase', 'proper') },
            { separator: true },
            { label: 'Convert text to numbers', icon: 'number', onSelect: () => run('textCase', 'number') },
          ],
          onClose: () => keepFocus(),
        });
        return;
      }
      case 'splitTextMenu': {
        // Which separator: detected, or one of the usual ones, or typed.
        const anchor = arg instanceof HTMLElement ? arg : null;
        const options = [['auto', 'Detect automatically'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], [' ', 'Space'], ['|', 'Pipe |'], ['/', 'Slash /'], ['-', 'Dash -']];
        openMenu({
          anchor, x: anchor ? null : (arg?.x ?? null), y: anchor ? null : (arg?.y ?? null), label: 'Split text on', minWidth: 200,
          items: [
            { header: 'Separator' },
            ...options.map(([d, label]) => ({ label, onSelect: () => run('splitText', d === 'auto' ? null : d) })),
            { separator: true },
            { label: 'Custom…', onSelect: async () => {
              const d = await promptDialog({ title: 'Split text', label: 'Separator', value: '', confirmLabel: 'Split', validate: (v) => (v.length ? null : 'Enter a separator') });
              if (d != null) run('splitText', d);
            } },
            { label: 'Text to Columns…', icon: 'textToColumns', onSelect: () => run('splitTextDialog') },
          ],
          onClose: () => keepFocus(),
        });
        return;
      }
      case 'splitTextDialog': {
        // Text to Columns: separators or fixed widths, a preview, a format per column and a destination.
        if (!committed()) return;
        if (refusedByProtection('split the text')) return;
        openTextToColumnsDialog(ctx, { range: grid.range, allowDest: grid.ranges.length === 1, resolve: resolveRangeText, onSplit: (options) => run('splitText', options) });
        return;
      }
      case 'splitText': {
        if (!committed()) return;
        if (refusedByProtection('split the text')) return;
        // The pieces land right of each text: a cell there that holds something is asked about first,
        // rather than written over unasked.
        if (splitWouldOverwrite(arg || null)) {
          const replace = await confirmDialog({ title: 'Split text to columns', message: 'The destination cells already contain data. Overwrite them?', confirmLabel: 'Overwrite', cancelLabel: 'Cancel', danger: true });
          if (destroyed) return;
          if (!replace) { keepFocus(); return; }
        }
        // The first column of every selected range, in the rows a filter shows, as other edits cover a selection; one undo step.
        let rows = 0;
        let cols = 0;
        let reason = null;
        const dest = arg && typeof arg === 'object' ? arg.dest : null;
        const splitOne = (rg) => {
          const out = wb.splitTextToColumns(sheetId, { ...rg, c2: rg.c1 }, arg || null);
          rows += out.rows;
          cols = Math.max(cols, out.cols);
          reason ??= out.reason;
        };
        // Pieces sent elsewhere keep the rows of the text they came from, so the selection is read whole, once.
        const done = dest ? (wb.lockedIn(sheetId, { ...grid.range, c2: grid.range.c1 }) ? null : splitOne(grid.range)) : eachRange('Split text', splitOne, { cap: false });
        if (done === null) { keepFocus(); return; } // a protected cell among the selected ranges; the workbook's notice has named it
        const problem = { room: "Can't split: the pieces would run past the last column", merged: "Can't split: the pieces would land under merged cells" }[reason];
        if (!rows) {
          // A protected cell right of the text refused the split; the workbook's notice has named it.
          if (reason !== 'protected') toast(problem || (typeof arg === 'string' && arg ? `No text containing "${arg === '\t' ? 'a tab' : arg}" to split` : 'No text with a separator to split'), { icon: 'info' });
          keepFocus();
          return;
        }
        toast(`Split ${rows} cell${rows === 1 ? '' : 's'} into ${cols} columns`);
        // A range the split had to refuse is not passed over in silence.
        if (problem) toast(problem, { icon: 'info' });
        const range = grid.range;
        if (dest) grid.setSelection(S.fromRange({ r1: dest.r, c1: dest.c, r2: dest.r + range.r2 - range.r1, c2: Math.min(dest.c + cols - 1, wb.sheet(sheetId).cols - 1) }, { r: dest.r, c: dest.c }), { scroll: false });
        else if (grid.ranges.length === 1) grid.setSelection(S.fromRange({ ...range, c2: Math.min(range.c1 + cols - 1, wb.sheet(sheetId).cols - 1) }, grid.active), { scroll: false });
        keepFocus();
        return;
      }
      case 'shuffle': {
        // Randomize range: the selected rows in a random order (a header row is left in place).
        if (!committed()) return;
        if (refusedByProtection('shuffle rows')) return;
        if (!oneRange('shuffle rows')) return;
        let range = dataRange();
        if (!range || range.r1 >= range.r2) { toast('Select at least two rows to shuffle', { icon: 'info' }); keepFocus(); return; }
        if (looksLikeHeader(wb, sheetId, range)) range = { ...range, r1: range.r1 + 1 };
        const moved = wb.shuffleRows(sheetId, range);
        // Protected cells, a table's edge, merges or an array result refuse the shuffle: say which, as the sort does.
        toast(moved ? `Shuffled ${range.r2 - range.r1 + 1} rows` : rearrangeProblem(wb, sheetId, range, 'row', 'shuffle') || 'Nothing to shuffle', { icon: moved ? 'check' : 'info' });
        if (moved) grid.setSelection(S.fromRange(range, { r: range.r1, c: range.c1 }), { scroll: false });
        keepFocus();
        return;
      }
      case 'removeEmptyRows': {
        if (!committed()) return;
        if (refusedByProtection('remove rows')) return;
        if (!oneRange('remove empty rows')) return;
        const range = dataRange();
        if (!range) { toast('Nothing to check', { icon: 'info' }); keepFocus(); return; }
        // A protected range can keep every empty row: the workbook's notice names it, and "no empty rows" would contradict it.
        let refused = false;
        const onProtection = ({ detail }) => { if (detail?.type === 'protected' && detail.sheetId === sheetId) refused = true; };
        wb.addEventListener('change', onProtection);
        let removed;
        try { removed = wb.removeEmptyRows(sheetId, range); } finally { wb.removeEventListener('change', onProtection); }
        if (!removed && refused) { keepFocus(); return; }
        toast(removed ? `Removed ${removed} empty row${removed === 1 ? '' : 's'}` : 'No empty rows in the selection', { icon: removed ? 'check' : 'info' });
        if (removed) {
          // The selection shrinks to the rows left; an active cell that sat below them moves up into the last one.
          const r2 = Math.max(range.r1, range.r2 - removed);
          grid.setSelection(S.fromRange({ ...range, r2 }, { r: Math.min(grid.active.r, r2), c: grid.active.c }), { scroll: false });
        }
        keepFocus();
        return;
      }
      case 'dedupe': {
        if (!committed()) return;
        if (refusedByProtection('remove duplicates')) return;
        if (!oneRange('remove duplicates')) return;
        const range = dataRange();
        if (!range) { toast('Nothing to check', { icon: 'info' }); return; }
        if (range.r1 >= range.r2) { toast('Select at least two rows', { icon: 'info' }); return; }
        openDedupeDialog(ctx, range);
        return;
      }
      /* ---------- Show Changes (Review ▸ Show Changes, the cell menu) ---------- */
      // With 'selection' (the cell menu) the pane opens on the changes to the selected cells; alone it opens or closes.
      case 'showChanges':
        if (arg === 'selection') changesPane.show({ selection: true });
        else changesPane.toggle();
        notify();
        return;
      case 'resizeCols': case 'resizeRows': {
        if (!committed()) return;
        const isCol = cmd === 'resizeCols';
        if (refusedByProtection(isCol ? 'resize columns' : 'resize rows')) return;
        // One size goes to one run of lines: a Ctrl/Cmd+click selection of several is refused rather than
        // the last range added resized while the dialog counts only its lines.
        if (!oneRange(isCol ? 'resize columns' : 'resize rows')) return;
        const r = grid.range;
        const from = isCol ? r.c1 : r.r1;
        const to = isCol ? r.c2 : r.r2;
        const current = isCol ? wb.colWidth(sheetId, from) || 100 : wb.rowHeight(sheetId, from) || 26;
        const n = to - from + 1;
        const what = isCol ? `column${n === 1 ? '' : 's'}` : `row${n === 1 ? '' : 's'}`;
        const min = isCol ? MIN_COL_WIDTH : MIN_ROW_HEIGHT;
        const max = isCol ? MAX_COL_WIDTH : MAX_ROW_HEIGHT;
        const text = await promptDialog({
          title: isCol ? 'Column width' : 'Row height',
          label: `${isCol ? 'Width' : 'Height'} in pixels for ${n === 1 ? `${what} ${isCol ? colName(from) : from + 1}` : `${n} ${what}`}`,
          value: String(current), confirmLabel: 'Resize',
          validate: (v) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `Enter a number from ${min} to ${max}`),
        });
        if (text == null) return;
        const px = Number(text);
        wb.transaction(isCol ? 'Resize columns' : 'Resize rows', () => {
          for (let i = from; i <= to; i++) {
            if (isCol) wb.setColWidth(sheetId, i, px);
            else wb.setRowHeight(sheetId, i, px);
          }
        });
        keepFocus();
        return;
      }
      case 'autofit': {
        // The columns of every selected range, as one undo step.
        let fitted = false;
        wb.transaction('Fit columns', () => { for (const { from, to } of lineRuns(grid.ranges, 'col')) if (autofitColumns(from, to)) fitted = true; });
        if (!fitted) toast('Nothing to fit: the selected columns are empty', { icon: 'info' });
        keepFocus();
        return;
      }
      case 'fillSeries': if (!committed()) return; openSeriesDialog(ctx); return;
      case 'fillDown': case 'fillRight': case 'fillUp': case 'fillLeft': {
        if (grid.editing) return;
        // Every selected range (Ctrl/Cmd+click adds ranges) fills from its own first row or column, as one undo step.
        // A protected cell in any of them refuses the whole fill up front (the workbook's notice names it), as one
        // range holding such a cell is refused whole: all or nothing, not the other ranges filled and that one not.
        if (grid.ranges.some((rg) => wb.lockedIn(sheetId, rg))) { keepFocus(); return; }
        const direction = { fillDown: 'down', fillRight: 'right', fillUp: 'up', fillLeft: 'left' }[cmd];
        wb.transaction('Fill', () => { for (const rg of grid.ranges) wb.fillDirection(sheetId, rg, direction); });
        keepFocus();
        return;
      }
      case 'copy': copyToClipboard(false); return;
      case 'cut': copyToClipboard(true); return;
      case 'paste': await pasteFromClipboard(); return;
      case 'pasteValues': await pasteFromClipboard({ valuesOnly: true }); return;
      case 'pasteFormats': await pasteFromClipboard({ mode: 'formats' }); return;
      case 'pasteTranspose': await pasteFromClipboard({ mode: 'transpose' }); return;
      case 'pasteSpecial': await pasteFromClipboard({ mode: arg }); return;
      // Paste Special… (Ctrl+Alt+V, the menus' Paste Special…): the dialog, over what the clipboard holds.
      case 'pasteSpecialMenu': case 'pasteSpecialDialog': await openPasteSpecial(); return;
      // A choice of the Paste gallery (Home ▸ Paste arrow, the cell menu): Paste Special's options without the dialog.
      case 'pasteWith': await pasteFromClipboard({ paste: arg }); return;
      // Insert Copied Cells: the cells copied here go in, the cells already there shifting right or down.
      case 'insertCopiedCells': {
        if (!committed()) return;
        if (arg === 'down' || arg === 'right') { await pasteFromClipboard({ mode: arg === 'down' ? 'insertDown' : 'insertRight' }); return; }
        if (!clip) { toast('Copy cells first, then insert them', { icon: 'info' }); keepFocus(); return; }
        openInsertPasteDialog({ range: { r1: 0, c1: 0, r2: (clip.rows?.length || 1) - 1, c2: (clip.cols?.length || 1) - 1 },
          onInsert: (direction) => run('insertCopiedCells', direction), onClose: () => keepFocus() });
        return;
      }
      case 'fillJustify': if (!committed()) return; fillJustify(); keepFocus(); return;
      case 'toValues': {
        // Freeze the selection: formulas become the values they show.
        if (!committed()) return;
        if (refusedByProtection('replace formulas')) return;
        // Every selected range, without the rows a filter hides: what is on screen is what freezes, as when clearing.
        let n = 0;
        if (eachRange('Replace formulas with values', (rg) => { n += wb.formulasToValues(sheetId, rg); }, { cap: false }) === null) { keepFocus(); return; }
        toast(n ? `Replaced ${n} formula${n === 1 ? '' : 's'} with ${n === 1 ? 'its value' : 'their values'}` : 'No formulas in the selection (errors are left as they are)', { icon: n ? 'check' : 'info', duration: 2500 });
        keepFocus();
        return;
      }
      // A clicked toolbar button holds the focus a browser gave it; every command that changes the sheet hands it back to the grid.
      // Undo and redo say which way the history moves, so the selection kept around a structural step can follow (see `historyMove`).
      case 'undo': if (!grid.editing) { historyMove = 'undo'; try { wb.undo(); } finally { historyMove = 'push'; } } keepFocus(); return;
      case 'redo': if (!grid.editing) { historyMove = 'redo'; try { wb.redo(); } finally { historyMove = 'push'; } } keepFocus(); return;
      case 'undoSteps': case 'redoSteps': {
        // As undo and redo: the sheet behind an open edit waits for the edit, which is neither thrown away nor committed.
        if (grid.editing) { keepFocus(); return; }
        historyMove = cmd === 'undoSteps' ? 'undo' : 'redo';
        let n;
        try { n = wb[cmd](Number(arg) || 1); } finally { historyMove = 'push'; }
        toast(`${cmd === 'undoSteps' ? 'Undid' : 'Redid'} ${n} step${n === 1 ? '' : 's'}`, { icon: cmd === 'undoSteps' ? 'undo' : 'redo', duration: 1500 });
        keepFocus();
        return;
      }
      case 'selectAll': {
        if (!committed()) return;
        // As Ctrl/Cmd+A steps: the block of data around the active cell first, the whole sheet on a second
        // press; a grid without the stepping takes the whole sheet at once.
        if (grid.selectAll) { grid.selectAll(); return; }
        const sheet = wb.sheet(sheetId);
        grid.setSelection(S.selectAll({ rows: sheet.rows, cols: sheet.cols }), { scroll: false });
        return;
      }
      case 'escape':
        optionButton.hide();
        endCut(); // the cut cells stay; a paste now copies them
        if (painter) stopPainting();
        if (tracing) { tracing = null; grid.setHighlights([], -1); }
        return;
      case 'save': await saveNow(); return;
      case 'saveAs': await saveAs(); return;
      case 'rename': await renameDoc(); return;
      case 'downloadXlsx': await exportFile('xlsx'); return;
      case 'downloadCsv': await exportFile('csv'); return;
      case 'downloadTsv': await exportFile('tsv'); return;
      case 'downloadHtml': await exportFile('html'); return;
      case 'downloadOds': await exportFile('ods'); return;
      case 'docInfo': {
        if (!committed()) return;
        const st = doc.path ? await P.statFile(doc.path).catch(() => null) : null;
        if (destroyed) return; // the editor was left while Puter answered
        let cells = 0;
        let formulas = 0;
        const rows = wb.sheets.map((sh) => {
          let n = 0;
          let f = 0;
          for (const cell of sh.cells.values()) { if (cell.v != null || cell.f != null) { n++; if (cell.f != null) f++; } }
          cells += n; formulas += f;
          return el('tr', {}, el('td', {}, sh.name + (sh.hidden ? ' (hidden)' : '')), el('td.num', {}, n.toLocaleString()), el('td.num', {}, f.toLocaleString()), el('td.num', {}, String(sh.charts.length)), el('td.num', {}, String(sh.tables.length)));
        });
        const fact = (k, v) => el('tr', {}, el('th', {}, k), el('td', {}, v));
        const size = st?.size != null ? formatBytes(st.size) : 'Not saved yet';
        const when = doc.lastSaved ? new Date(doc.lastSaved).toLocaleString() : (st?.modified ? new Date((st.modified < 1e12 ? st.modified * 1000 : st.modified)).toLocaleString() : (doc.path ? 'Unknown' : 'Not saved yet'));
        openModal({
          title: 'Document details', wide: true,
          content: el('div', {},
            el('table.details-table', {}, el('tbody', {},
              fact('Name', doc.name), fact('Location', doc.path || 'Not saved yet'), fact('Size', size), fact('Last saved', when),
              fact('Sheets', String(wb.sheets.length)), fact('Cells with content', cells.toLocaleString()), fact('Formulas', formulas.toLocaleString()),
              fact('Named ranges', String(wb.names.length)), fact('Tables', String(wb.tableNames().length)), fact('Functions available', String(FUNCTION_NAMES.length)))),
            el('table.details-table.details-sheets', {},
              el('thead', {}, el('tr', {}, el('th', {}, 'Sheet'), el('th.num', {}, 'Cells'), el('th.num', {}, 'Formulas'), el('th.num', {}, 'Charts'), el('th.num', {}, 'Tables'))),
              el('tbody', {}, ...rows))),
          onClose: () => keepFocus(),
        });
        return;
      }
      case 'downloadRangeCsv': {
        // The selection (or the table around the active cell) as CSV.
        if (!committed()) return;
        if (!oneRange('export the selection')) return;
        const a = grid.active;
        const table = S.isSingle(grid.selection) ? wb.tableAt(sheetId, a.r, a.c) : null;
        const range = table ? table.range : grid.range;
        const blob = new Blob([rangeToCsv(wb, sheetId, range)], { type: CSV_MIME });
        const label = table ? table.name : rangeName(range).replace(':', '-');
        const name = `${P.sanitizeName(doc.name)} - ${label}.csv`;
        // A save that failed (out of space, offline) is said, as the sheet exports say it; the editor may have been left by then.
        if (P.isApp() && P.canSaveFiles()) P.saveFileAs(blob, name).then((saved) => saved && toast(`Saved ${saved.name}`, { icon: 'check' })).catch((e) => { if (!destroyed) toast(`Could not export: ${e?.message || 'unknown error'}`, { icon: 'alert' }); });
        else P.downloadBlob(blob, name);
        return;
      }
      case 'exportPdf':
        toast('In the print dialog, choose "Save as PDF" as the destination', { icon: 'fileDown', duration: 4200 });
        openPrintDialog(ctx);
        return;
      case 'import': fileInput.click(); return;
      case 'importSheets': sheetsInput.click(); return;
      case 'versions': {
        if (!committed()) return;
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        if (!doc.path) await flush({ leaving: false });
        if (destroyed) return;
        if (!doc.path) { toast('Save the spreadsheet first', { icon: 'info' }); return; }
        openVersionHistory(doc, { onRestored: () => { grid.refresh(); keepFocus(); } });
        return;
      }
      case 'sendCopy': {
        // Email the workbook as it is now, from the signed-in user (ui/send-mail.js).
        if (!committed()) return;
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        openSendCopyDialog({ doc, sheetId: grid.sheetId, range: S.isSingle(grid.selection) ? null : { ...grid.range }, mailer, user: session.user, onClose: () => keepFocus() });
        return;
      }
      case 'sendLink': {
        if (!await savedForSharing()) return;
        openSendLinkDialog({ doc, mailer, user: session.user, onClose: () => keepFocus() });
        return;
      }
      case 'share': {
        if (!await savedForSharing()) return;
        openShareDialog({
          path: doc.path, name: doc.name, uid: doc.uid, doc: openLive ? doc : null,
          onEmailLink: mailer.available() ? () => run('sendLink') : null,
          // Editing together started (or stopped): the workbook opens again as the room's (or as the file).
          onLive: async (room) => {
            if (destroyed) return;
            if (room) openLive?.({ ...room, path: doc.path, uid: doc.uid });
            else openPath(doc.path, { reload: true });
          },
        });
        return;
      }
      case 'importUrl': {
        // A file on the web (a published CSV, an .xlsx on a server) fetched through Puter.
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        const url = await promptDialog({
          title: 'Import from URL', label: 'Address of a .csv, .tsv, .xlsx, or .ods file', placeholder: 'https://example.com/data.csv', confirmLabel: 'Import',
          validate: urlProblem,
          hint: 'The sheets in the file are added to this spreadsheet. The address must allow access from other sites.',
        });
        if (!url) { keepFocus(); return; }
        if (!committed()) return;
        toast('Fetching…', { icon: 'spinner', duration: 1500 });
        try {
          const bytes = await P.fetchBytes(url.trim());
          if (destroyed) return;
          const name = importNameFor(url.trim(), bytes);
          const other = await workbookFromFile(bytes, name);
          if (destroyed) return;
          if (other.sheets.length === 1 && /\.(csv|tsv|txt)$/i.test(name)) other.renameSheet(other.sheets[0].id, name.replace(/\.[^.]+$/, '').slice(0, 31) || other.sheets[0].name);
          openImportPlacementDialog(ctx, other, name);
        } catch (e) {
          if (destroyed) return;
          console.error(e);
          toast(explained(e) ? e.message : 'Could not fetch or read that file', { icon: 'alert', duration: 5000 });
        }
        keepFocus();
        return;
      }
      case 'open': {
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        const picked = await P.pickFile();
        if (destroyed) return; // the editor was left while the picker was open
        if (picked && await flush()) openPath(picked.path);
        return;
      }
      // The save flush waits on may finish after the editor was left: nothing opens then.
      case 'new': if (await flush() && !destroyed) newDoc(); return;
      case 'newFromTemplate': openTemplatePicker({ onPick: async (id) => { if (await flush() && !destroyed) templateDoc?.(id); } }); return;
      case 'home': await leave(); return;
      case 'functionMenu': openFunctionMenu(arg instanceof HTMLElement ? arg : null); return;
      case 'palette': {
        // Every menu action by name: Ctrl/Cmd+Shift+P, Alt+/, or the Search button.
        if (!committed()) return;
        palette?.close();
        palette = openCommandPalette({ commands: withCustomShortcuts(paletteCommands(commandFlags())), run, onClose: () => { palette = null; keepFocus(); } });
        return;
      }
      case 'insertFunction': insertFunction(arg); return;
      case 'insertFunctionDialog': openInsertFunctionDialog(ctx, { onPick: (name) => run('functionArgs', name) }); return;
      case 'functionArgs': {
        // Function Arguments for a function picked from a category or Insert Function. Mid-entry the
        // function goes in at the caret instead, so the formula being typed is not replaced.
        const name = String(arg || '').toUpperCase();
        if (!FUNCTION_NAMES.includes(name)) return;
        if (grid.editing) { insertFunction(name); return; }
        if (refusedByProtection('enter a formula')) return;
        rememberFunction(name);
        openFunctionArgumentsDialog(ctx, name, { apply: (call) => { if (grid.beginEdit({ text: `=${call}`, mode: 'inplace' }) !== false) grid.commitEdit(); keepFocus(); } });
        return;
      }
      case 'autosum': {
        // With a guessable range the sum is written straight away; otherwise
        // the editor opens with =SUM( so a range can be picked. Mid-edit the
        // chord inserts SUM( at the caret, never a formula into the cell behind.
        if (grid.editing) { insertFunction('SUM'); return; }
        if (refusedByProtection('add a sum')) return;
        const { r, c } = grid.active;
        const isNum = (rr, cc) => typeof wb.getValue(sheetId, rr, cc) === 'number';
        let rr = r - 1;
        while (rr >= 0 && isNum(rr, c)) rr--;
        let cc = c - 1;
        if (rr === r - 1) while (cc >= 0 && isNum(r, cc)) cc--;
        const range = rr < r - 1 ? { r1: rr + 1, c1: c, r2: r - 1, c2: c } : cc < c - 1 ? { r1: r, c1: cc + 1, r2: r, c2: c - 1 } : null;
        if (range && S.isSingle(grid.selection)) {
          // A protected cell: the workbook says so and would refuse the sum, so the selection stays on it.
          if (wb.lockedAt(sheetId, r, c)) return;
          const text = `=SUM(${rangeName(range)})`;
          if (!allowedByRule(wb.validateInput(sheetId, r, c, text), text)) return;
          wb.setInput(sheetId, r, c, text);
          grid.setSelection(S.single(r + (range.c1 === c ? 1 : 0), c + (range.r1 === r ? 1 : 0)));
        } else insertFunction('SUM');
        return;
      }
      case 'recalc': {
        // Every formula, not the volatile ones alone: a result written in the regional format (TEXT, DOLLAR)
        // can be stale though no cell changed.
        wb.recalculate();
        imported.clear(); // IMPORTRANGE reads its files afresh too
        const asked = wb.clearAsyncCache();
        grid.refresh();
        toast(asked ? 'Recalculated; AI answers are being asked for again' : 'Recalculated', { icon: 'reset', duration: 1600 });
        keepFocus();
        return;
      }
      case 'newSheet': {
        if (!committed()) return;
        const sheet = wb.addSheet();
        if (sheet) wb.setActiveSheet(sheet.id);
        return;
      }
      // The tab strip's other structural actions come through here too, so an
      // open edit is committed before the sheet changes. Committed inside the
      // structure event instead, it would sit in the history before the sheet
      // step, whose snapshot predates it: the first undo would take both away.
      case 'duplicateSheet':
        if (!committed()) return;
        wb.duplicateSheet(arg || sheetId);
        return;
      case 'moveOrCopySheet':
        if (!committed()) return;
        openMoveSheetDialog(ctx, arg || sheetId);
        return;
      case 'placeSheet':
        if (!committed() || !arg?.id) return false;
        return !!placeSheet(wb, arg.id, arg);
      case 'showSheet': case 'hideSheet': {
        if (!committed()) return;
        // Hiding a grouped sheet hides the whole group, as long as a sheet outside it stays on show.
        const group = cmd === 'hideSheet' && wb.sheetGroup;
        if (group && (!arg || group.includes(arg))) {
          if (group.length >= wb.visibleSheets.length) { toast('At least one sheet must stay visible. Ungroup the sheets first', { icon: 'eyeOff', duration: 3500 }); return; }
          wb.transaction('Hide sheets', () => { for (const id of group) wb.setSheetHidden(id, true); });
          return;
        }
        wb.setSheetHidden(arg || sheetId, cmd === 'hideSheet');
        return;
      }
      case 'selectAllSheets':
        if (!committed()) return;
        wb.groupSheets(wb.visibleSheets.filter((s) => s.kind !== 'chart' || s.id === wb.activeSheetId).map((s) => s.id));
        return;
      case 'ungroupSheets':
        wb.ungroupSheets();
        keepFocus();
        return;
      case 'fillAcrossSheets':
        if (!committed() || !wb.sheetGroup) return;
        openFillAcrossDialog(ctx);
        return;
      case 'deleteSheet': {
        // From the tab menu, the Insert menu or the palette alike: the last sheet showing stays, and one
        // holding work is asked about first, through the tab strip's own question.
        if (!committed()) return;
        const group = wb.sheetGroup;
        if (group && (!arg || group.includes(arg))) {
          // A grouped sheet goes with the rest of its group, in one step that one undo brings back.
          if (group.length >= wb.visibleSheets.length) { toast('A spreadsheet needs at least one sheet. Ungroup the sheets first', { icon: 'trash', duration: 3500 }); return; }
          const ok = await confirmDialog({ title: `Delete ${group.length} sheets?`, message: `${group.map((id) => wb.sheet(id)?.name).join(', ')} and everything on them will be removed. You can undo this.`, confirmLabel: 'Delete sheets' });
          if (!ok || destroyed) return;
          wb.transaction('Delete sheets', () => { for (const id of group) wb.deleteSheet(id); });
          return;
        }
        const sheet = wb.sheet(arg || sheetId);
        if (!sheet || wb.visibleSheets.length <= 1) return;
        if (sheetHoldsWork(sheet) && !await sheetTabs.confirmDelete(sheet)) return;
        if (destroyed) return;
        wb.deleteSheet(sheet.id);
        return;
      }
      case 'renameSheet': {
        if (!committed()) return;
        const sheet = wb.sheet(arg || sheetId);
        if (sheet) await sheetTabs.rename(sheet);
        return;
      }
      case 'moveSheet': {
        // Among the tabs on show, as the tab menu moves them: past a hidden sheet would not move the tab visibly.
        const id = arg?.id || sheetId;
        const visible = wb.visibleSheets;
        const at = visible.findIndex((s) => s.id === id);
        const neighbour = visible[at + ((arg?.dir || arg) === 'left' ? -1 : 1)];
        if (at < 0 || !neighbour) return;
        wb.moveSheet(id, wb.sheets.indexOf(neighbour));
        return;
      }
      case 'protectSheet': {
        const sheet = wb.sheet(arg || sheetId);
        if (sheet) wb.setSheetProtected(sheet.id, !sheet.protected);
        keepFocus();
        return;
      }
      case 'sheetColor': {
        // The tab strip's swatches, beside the active tab's options button (or the element asked from).
        const sheet = wb.sheet(sheetId);
        if (sheet) sheetTabs.colorMenu(sheet, arg instanceof HTMLElement ? arg : sheetTabs.el.querySelector('.tab-menu-btn'));
        return;
      }
      case 'copySheetTo': {
        // Copying reads and writes other files on Puter; the document itself stays open, so this is not a leave.
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        if (!committed()) return;
        openCopySheetDialog(ctx, arg || grid.sheetId);
        return;
      }
      case 'openFile': { if (arg && await flush() && !destroyed) openPath(arg); return; }
      case 'copyAbove': {
        // Ctrl+' brings the formula (or text) of the cell above down as written, its references unshifted
        // (Ctrl+D is the one that shifts them); Ctrl+Shift+" brings its value.
        const { r, c } = grid.active;
        if (r === 0) return;
        const stored = wb.getCell(sheetId, r - 1, c);
        const above = stored && (stored.v != null || stored.f != null) ? stored : null;
        // The cell above may show part of a spilled array result (=SEQUENCE(3)) and hold nothing of its own.
        // Both chords copy the value it plainly shows, with the array's number format, rather
        // than returning without a word from a documented key.
        const spill = above ? null : wb.spillAt(sheetId, r - 1, c);
        const spilled = spill && spill.value != null && typeof spill.value !== 'object' ? spill.value : null;
        if (!above && spilled == null) return;
        const aboveStyle = above ? above.s : formatOnly(spill.style);
        if (arg === 'value') {
          // The value itself, not its displayed text, so nothing is rounded or re-typed on the
          // way; a cell with no format of its own takes the one above, so a date stays a date.
          const value = wb.getValue(sheetId, r - 1, c);
          if (grid.editing) grid.insertText(wb.getDisplay(sheetId, r - 1, c));
          else if (allowedByRule(wb.validateValue(sheetId, r, c, value))) wb.setCells(sheetId, [{ r, c, cell: { v: value, f: null, s: wb.getCell(sheetId, r, c)?.s ?? aboveStyle } }], 'Copy value above');
        } else if (grid.editing) {
          grid.insertText(above ? (above.f != null ? `=${above.f}` : String(above.v)) : String(spilled));
        } else if (above?.f != null) {
          // The same text the chord inserts mid-edit, entered as if typed: a formula is checked by its result, as a typed one is.
          const text = `=${above.f}`;
          if (allowedByRule(wb.validateInput(sheetId, r, c, text), text)) wb.setInput(sheetId, r, c, text, { label: 'Copy formula above' });
        } else if (!above) {
          // A spilled cell holds no formula of its own to bring down, so its value comes instead.
          if (allowedByRule(wb.validateValue(sheetId, r, c, spilled))) wb.setCells(sheetId, [{ r, c, cell: { v: spilled, f: null, s: wb.getCell(sheetId, r, c)?.s ?? aboveStyle } }], 'Copy value above');
        } else if (allowedByRule(wb.validateValue(sheetId, r, c, above.v))) {
          // A value comes down with its formatting, as a copy would bring it.
          wb.pasteCells(sheetId, wb.copyRange(sheetId, { r1: r - 1, c1: c, r2: r - 1, c2: c }), r, c, { r: r - 1, c });
        }
        keepFocus();
        return;
      }
      case 'insertDate': case 'insertTime': {
        const now = new Date();
        const text = cmd === 'insertDate' ? formatDate(todaySerial(), 'iso') : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const { r, c } = grid.active;
        if (grid.editing) grid.insertText(text);
        else if (allowedByRule(wb.validateInput(sheetId, r, c, text), text)) wb.setInput(sheetId, r, c, text);
        keepFocus();
        return;
      }
      case 'gridlines':
        wb.setGridlines(sheetId, wb.sheet(sheetId).gridlines === false);
        grid.refresh();
        keepFocus();
        return;
      case 'zeros':
        wb.setZeros(sheetId, wb.sheet(sheetId).zeros === false);
        grid.refresh();
        toast(wb.sheet(sheetId).zeros === false ? 'Zero values hidden on this sheet' : 'Zero values shown', { icon: 'eye', duration: 1600 });
        keepFocus();
        return;
      case 'showFormulas':
        grid.setShowFormulas(!grid.showFormulas);
        toast(grid.showFormulas ? 'Showing formulas' : 'Showing values', { icon: 'fx', duration: 1400 });
        notify();
        return;
      case 'focusMode':
        view.focus = !view.focus;
        applyView();
        toast(view.focus ? 'Focus mode: the toolbar and formula bar are hidden (View menu to bring them back)' : 'Toolbar and formula bar shown', { icon: 'eye', duration: 2600 });
        keepFocus();
        return;
      case 'formulaBar':
        // View ▸ Show ▸ Formula Bar, remembered on this device.
        setAppOptions({ showFormulaBar: !appOption('showFormulaBar') }); // the options' listener applies it
        notify();
        keepFocus();
        return;
      case 'toggleHeaders':
        grid.setShowHeaders(!grid.showHeaders);
        keepFocus();
        return;
      case 'spelling':
        if (!committed()) return;
        await openSpellingDialog(ctx);
        return;
      case 'thesaurus': case 'translatePane': {
        const tool = cmd === 'thesaurus' ? 'thesaurus' : 'translate';
        if (!languagePane) return;
        if (languagePane.open && languagePane.mode === tool) { languagePane.hide(); return; }
        languagePane.show(tool, { fromCell: true });
        return;
      }
      case 'autoCorrectOptions':
        if (!committed()) return;
        openAutoCorrectDialog({ onClose: () => keepFocus() });
        return;
      case 'toggleSpellcheck':
        view.spell = view.spell === false;
        applyView();
        toast(view.spell ? 'Spelling is checked while you type text' : 'Spelling suggestions off', { icon: 'text', duration: 1800 });
        keepFocus();
        return;
      case 'fullscreen':
        await toggleFullscreen();
        keepFocus();
        return;
      case 'sheet': {
        if (grid.editing && !grid.acceptsRef() && !grid.commitEdit()) return; // mid-formula, the other sheet is for picking references
        const visible = wb.visibleSheets;
        const i = visible.findIndex((s) => s.id === wb.activeSheetId);
        const next = visible[(i + (arg === 'prev' ? -1 : 1) + visible.length) % visible.length];
        if (next && next.id !== wb.activeSheetId) wb.setActiveSheet(next.id);
        return;
      }
      case 'zoomCustom': {
        // View ▸ Zoom: the presets, Fit selection (a chart sheet fits its window), or a percentage of one's own.
        const chartSheet = wb.sheet(sheetId)?.kind === 'chart';
        openZoomDialog({ zoom: grid.zoom, apply: (z) => run('zoomTo', z), fit: () => run(chartSheet ? 'zoomFit' : 'zoomSelection'), onClose: () => keepFocus() });
        return;
      }
      case 'zoomTo':
        grid.setZoom(Number(arg) || 1);
        try { localStorage.setItem('spreadsheet:zoom', String(grid.zoom)); } catch { /* no storage */ }
        notify();
        keepFocus();
        return;
      case 'zoom': {
        const next = arg === 'reset' ? 1 : grid.zoom + Number(arg);
        grid.setZoom(next);
        try { localStorage.setItem('spreadsheet:zoom', String(grid.zoom)); } catch { /* no storage */ }
        notify();
        keepFocus();
        return;
      }
      case 'names': if (!committed()) return; openNamesManager(ctx); return;
      case 'defineName': if (!committed()) return; openNamesManager(ctx, { define: true }); return;
      case 'createNames': {
        if (!committed() || !oneRange('create names')) return;
        const range = dataRange(null);
        if (!range) { toast('Select the labels and the cells to name', { icon: 'info' }); keepFocus(); return; }
        openCreateNamesDialog(ctx, range);
        return;
      }
      case 'viewMode':
        // Normal, Page Layout or Page Break Preview, for the sheet in view (each sheet keeps its own and saves it).
        if (wb.sheet(grid.sheetId)?.kind === 'chart' || (grid.editing && !grid.commitEdit())) return;
        wb.setSheetViewMode(grid.sheetId, arg === 'pageBreak' || arg === 'pageLayout' ? arg : 'normal');
        refreshPageView(true);
        notify(); keepFocus();
        return;
      case 'consolidate': {
        // Data ▸ Consolidate: the dialog, then the combined table written at the active cell as one undo step.
        if (!committed()) return;
        if (!arg?.refs) { openConsolidateDialog(ctx); return; }
        const sources = arg.refs.map((text) => {
          const at = resolveRangeText(text);
          if (!at) return null;
          const rows = [];
          for (let r = at.range.r1; r <= Math.min(at.range.r2, at.range.r1 + 5000); r++) {
            const row = [];
            for (let c = at.range.c1; c <= Math.min(at.range.c2, at.range.c1 + 500); c++) { const v = wb.getValue(at.sheetId, r, c); row.push(v && typeof v === 'object' ? null : v); }
            rows.push(row);
          }
          return rows;
        }).filter(Boolean);
        const table = consolidate(sources, arg);
        if (!table) { toast('There was nothing to consolidate in those references', { icon: 'info', duration: 3000 }); return; }
        const { r: r0, c: c0 } = grid.active;
        const entries = [];
        table.forEach((row, i) => row.forEach((v, j) => entries.push({ r: r0 + i, c: c0 + j, cell: v == null ? null : { v, f: null, s: wb.getCell(sheetId, r0 + i, c0 + j)?.s } })));
        if (wb.setCells(sheetId, entries, 'Consolidate')) grid.setSelection(S.fromRange({ r1: r0, c1: c0, r2: r0 + table.length - 1, c2: c0 + table[0].length - 1 }, { r: r0, c: c0 }));
        keepFocus();
        return;
      }
      case 'watchWindow': watchWindow.toggle(); return;
      case 'accessibility': accessibilityPane.toggle(); return;
      case 'quickTotal': {
        // Quick Analysis ▸ Totals: formulas in the row below the selection, or the column to its right.
        if (!committed() || refusedByProtection('add totals') || !oneRange('add totals')) return;
        const entries = quickTotalEntries(wb, sheetId, grid.range, arg?.kind, arg?.direction);
        if (!entries?.length) return;
        if (entries.some((e) => { const cell = wb.getCell(sheetId, e.r, e.c); return cell && (cell.v != null || cell.f != null); })) {
          toast(`There is already data ${arg.direction === 'rows' ? 'below' : 'to the right of'} the selection`, { icon: 'info', duration: 3000 });
          return;
        }
        wb.transaction('Quick totals', () => {
          for (const e of entries) { wb.setInput(sheetId, e.r, e.c, e.input); wb.applyStyle(sheetId, { r1: e.r, c1: e.c, r2: e.r, c2: e.c }, e.style); }
        });
        keepFocus();
        return;
      }
      case 'errorCheckingOptions': openErrorCheckingOptions({ ...ctx, refreshErrorTag: () => errorTag.sync() }); return;
      case 'circleInvalid': {
        // Red circles around the cells that break their validation rule; they go as each is fixed.
        const found = invalidCells(wb, sheetId);
        circledSheet = found.cells.length ? sheetId : null;
        grid.setHighlights(found.cells.map((cell) => ({ ...cell, kind: 'invalid' })), -1);
        if (found.more) toast('This sheet has more than 255 invalid cells. Only 255 are circled', { icon: 'info', duration: 3500 });
        else statusBar?.announce(found.cells.length ? `${found.cells.length} invalid cell${found.cells.length === 1 ? '' : 's'} circled` : 'No invalid data');
        keepFocus();
        return;
      }
      case 'clearCircles':
        if (circledSheet != null) { circledSheet = null; grid.setHighlights([], -1); }
        keepFocus();
        return;
      case 'altText': {
        const id = arg || grid.selectedChart;
        if (!id) { toast('Select a picture, chart or text box to describe', { icon: 'info', duration: 2500 }); return; }
        openAltTextDialog(ctx, id);
        return;
      }
      case 'orderObject': {
        // Bring to Front, Bring Forward, Send Backward, Send to Back: the place in the sheet's drawing order of the
        // object named, or of every object selected (whole groups).
        const ids = arrangeTargets(ctx, arg?.id ? [arg.id] : null);
        if (!ids.length) { toast('Select a chart, picture, shape or text box first', { icon: 'info', duration: 2500 }); return; }
        if (wb.orderObjects(sheetId, ids, arg?.where)) statusBar?.announce({ front: 'Brought to front', forward: 'Brought forward', backward: 'Sent backward', back: 'Sent to back' }[arg?.where] || 'Order changed');
        notify(); keepFocus();
        return;
      }
      case 'alignObjects': {
        const ids = arrangeTargets(ctx);
        if (wb.alignObjects(sheetId, ids, arg)) statusBar?.announce(['horizontal', 'vertical'].includes(arg) ? `Distributed ${arg}ly` : `Aligned ${arg}`);
        else if (ids.length < 2) toast('Select two or more objects to align (three to distribute)', { icon: 'info', duration: 2800 });
        notify(); keepFocus();
        return;
      }
      case 'groupObjects': {
        // Arrange ▸ Group: Group, Regroup (the group last ungrouped) and Ungroup.
        if (arg === 'regroup') {
          const group = wb.regroupObjects(sheetId);
          if (group) grid.selectCharts(wb.sheet(sheetId).charts.filter((o) => o.group === group).map((o) => o.id));
        } else if (arg === 'ungroup') {
          if (wb.ungroupObjects(sheetId, arrangeTargets(ctx))) statusBar?.announce('Ungrouped');
        } else {
          const group = wb.groupObjects(sheetId, arrangeTargets(ctx));
          if (group) { grid.selectCharts(wb.sheet(sheetId).charts.filter((o) => o.group === group).map((o) => o.id)); statusBar?.announce('Grouped'); }
          else toast('Select two or more objects to group', { icon: 'info', duration: 2500 });
        }
        notify(); keepFocus();
        return;
      }
      case 'rotateObjects':
        if (!wb.rotateObjects(sheetId, arrangeTargets(ctx), arg)) toast('Pictures, shapes and text boxes can be rotated; charts and controls cannot', { icon: 'info', duration: 3000 });
        notify(); keepFocus();
        return;
      case 'snapObjects': {
        const key = arg === 'shape' ? 'snapShape' : 'snapGrid';
        view[key] = !view[key];
        applyView();
        statusBar?.announce(`${arg === 'shape' ? 'Snap to shape' : 'Snap to grid'} ${view[key] ? 'on' : 'off'}`);
        notify(); keepFocus();
        return;
      }
      case 'selectionPane': selectionPane?.toggle(); notify(); return;
      case 'objectsVisible':
        if (arg?.ids?.length) wb.setObjectsHidden(sheetId, arg.ids, !!arg.hidden);
        notify();
        return;
      case 'renameObject':
        if (arg?.id) wb.renameObject(sheetId, arg.id, arg.name);
        notify();
        return;
      case 'moveObjectInOrder':
        if (arg?.id) wb.moveObjectInOrder(sheetId, arg.id, arg.to);
        notify();
        return;
      case 'deleteObjects':
        if (Array.isArray(arg) && wb.deleteObjects(sheetId, arg)) statusBar?.announce(`${arg.length} objects deleted`);
        keepFocus();
        return;
      case 'addWatch': {
        // Add Watch: the selected cells, as many as the Watch Window lists for a selection (the first 100).
        const cells = [];
        for (const rg of grid.ranges) for (let rr = rg.r1; rr <= rg.r2 && cells.length < 100; rr++) for (let cc = rg.c1; cc <= rg.c2 && cells.length < 100; cc++) cells.push({ r: rr, c: cc });
        const added = wb.addWatches(grid.sheetId, cells);
        watchWindow.show();
        if (!added) toast('Those cells are already watched', { icon: 'info', duration: 2000 });
        return;
      }
      case 'flashFill': {
        // Flash Fill (Ctrl+E): the examples typed in the active column teach the pattern; the empty cells of the
        // column within the data around them are filled the same way, as one undo step.
        if (!committed()) return;
        const { r, c } = grid.active;
        const { entries } = flashFillPlan(sheetId, r, c);
        if (!entries.length) { toast('Flash Fill found no pattern to fill. Type an example or two, then try again', { icon: 'info', duration: 3200 }); keepFocus(); return; }
        if (wb.setCells(sheetId, entries, 'Flash Fill')) toast(`Flash Fill changed ${entries.length} cell${entries.length === 1 ? '' : 's'}`, { icon: 'flashFill', duration: 2200 });
        keepFocus();
        return;
      }
      case 'protectWorkbook':
        wb.setStructureProtected(!wb.structureProtected);
        toast(wb.structureProtected ? 'Workbook structure protected: sheets cannot be added, moved, renamed or deleted' : 'Workbook structure unprotected', { icon: 'lock', duration: 2600 });
        notify(); keepFocus();
        return;
      case 'wordArtMenu': if (refusedByProtection('insert WordArt')) return; openWordArtMenu(ctx, arg instanceof HTMLElement ? arg : null); return;
      case 'insertEquation': if (refusedByProtection('insert an equation')) return; runInsertEquation(ctx, arg); return;
      case 'themesMenu': case 'themeColorsMenu': case 'themeFontsMenu': case 'themeEffectsMenu': {
        const open = { themesMenu: openThemesMenu, themeColorsMenu: openThemeColorsMenu, themeFontsMenu: openThemeFontsMenu, themeEffectsMenu: openThemeEffectsMenu }[cmd];
        open(ctx, arg instanceof HTMLElement ? arg : null);
        return;
      }
      case 'drawTool': case 'drawPenMenu': case 'drawAddPen': case 'drawInkToShape': case 'drawTouch': ink.command(cmd, arg); return;
      case 'shapesMenu': if (refusedByProtection('insert a shape')) return; openShapesMenu(arg instanceof HTMLElement ? arg : null, run); return;
      case 'iconsDialog': if (refusedByProtection('insert icons')) return; openIconsDialog(ctx); return;
      case 'insertShape': case 'insertIcons': {
        // Shapes and icons go on the sheet as pictures at the active cell, each beside the last, the newest selected.
        if (!committed() || refusedByProtection('insert a picture')) return;
        const pictures = cmd === 'insertShape' ? [shapeSvg(arg)] : (Array.isArray(arg) ? arg : [arg]).map((n) => iconSvg(n));
        let dx = 4, id = null;
        wb.transaction(cmd === 'insertShape' ? 'Insert shape' : 'Insert icons', () => {
          for (const p of pictures.filter(Boolean)) {
            id = wb.addChart(sheetId, { type: 'image', src: svgDataUrl(p.svg), title: p.label || 'Icon', anchor: { ...grid.active }, dx, dy: 4, w: p.w, h: p.h }) || id;
            dx += p.w + 8;
          }
        });
        if (id) grid.selectChart(id);
        return;
      }
      case 'symbolDialog':
        if (refusedByProtection('insert a symbol')) return;
        openSymbolDialog(ctx);
        return;
      case 'insertSymbol': {
        // Insert ▸ Symbol: at the caret of the entry being typed, or at the end of the active cell's contents in a new edit.
        if (!arg) return;
        if (grid.editing) { grid.insertText(String(arg)); grid.focusEditor(); return; }
        if (refusedByProtection('insert a symbol')) return;
        const cell = wb.getCell(sheetId, grid.active.r, grid.active.c);
        const current = cell?.f != null ? `=${cell.f}` : cell?.v != null ? wb.getDisplay(sheetId, grid.active.r, grid.active.c) : '';
        grid.beginEdit({ text: `${current}${arg}`, mode: 'inplace' });
        return;
      }
      case 'useName': {
        // Use in Formula: mid-entry the name goes in at the caret; otherwise an entry starts with it.
        if (!arg) return;
        if (grid.editing) { grid.insertText(String(arg)); grid.focusEditor(); return; }
        if (refusedByProtection('enter a formula')) return;
        grid.beginEdit({ text: `=${arg}`, mode: 'inplace' });
        return;
      }
      case 'pasteNameMenu': {
        // F3: Paste Name. The workbook's names (and this sheet's own), then its tables, at the active cell.
        const sheetName = wb.sheet(sheetId)?.name;
        const names = [...new Set([
          ...wb.names.filter((n) => !n.hidden && (!n.sheet || n.sheet === sheetName)).map((n) => n.name),
          ...wb.sheets.flatMap((sh) => sh.tables || []).map((t) => t.name).filter(Boolean),
        ])].sort((a, b) => a.localeCompare(b));
        if (!names.length) { toast('There are no names in this workbook yet. Define one from Formulas ▸ Define Name', { icon: 'info', duration: 3000 }); keepFocus(); return; }
        const rect = grid.cellRect(grid.active.r, grid.active.c);
        openMenu({
          x: rect.left, y: rect.bottom + 2, label: 'Paste Name', minWidth: 200,
          items: [{ header: 'Paste name' }, ...names.slice(0, 200).map((name) => ({ label: name, icon: 'tag', onSelect: () => run('useName', name) }))],
          onClose: (reason) => { if (reason !== 'select') keepFocus(); },
        });
        return;
      }
      case 'toggleRibbon': toolbar.toggleCollapsed(); keepFocus(); return;
      case 'pickFromList': {
        // Pick From Drop-down List: the distinct text entries in the column's block of data above and below the cell.
        if (!committed()) return;
        const { r, c } = grid.active;
        const found = new Set();
        const take = (rr) => { const v = wb.getValue(sheetId, rr, c); if (typeof v === 'string' && v.trim()) found.add(v); return v != null && v !== ''; };
        for (let rr = r - 1; rr >= 0 && take(rr); rr--);
        for (let rr = r + 1, end = wb.sheet(sheetId).rows; rr < end && take(rr); rr++);
        const values = [...found].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        if (!values.length) { toast('There are no text entries above or below this cell to pick from', { icon: 'info' }); keepFocus(); return; }
        const rect = grid.cellRect(r, c);
        openMenu({
          x: rect.left, y: rect.bottom + 2, label: 'Pick from list', minWidth: Math.max(160, rect.width), search: values.length >= 12 ? 'Search entries' : null,
          items: values.slice(0, 500).map((v) => ({ label: v, onSelect: () => { if (grid.beginEdit({ text: v, mode: 'inplace' }) !== false) grid.commitEdit(); keepFocus(); } })),
          onClose: (reason) => { if (reason !== 'select') keepFocus(); },
        });
        return;
      }
      case 'toggleFormulaBar': formulaBar.setExpanded(!formulaBar.expanded); keepFocus(); return;
      case 'clearTrace':
        tracing = null;
        grid.setHighlights([], -1);
        keepFocus();
        return;
      case 'pageSetup': {
        // Page Layout choices are stored with the sheet and saved in the file's page setup.
        if (!committed() || !arg || typeof arg !== 'object') return;
        const sheet = wb.sheet(sheetId);
        const current = sheet.printSettings || normalizePrintSettings({});
        wb.setPrintSettings(sheetId, { ...current, ...arg, margins: { ...current.margins, ...(arg.margins || {}) } });
        notify();
        keepFocus();
        return;
      }
      case 'pageBreak': {
        // Page Layout ▸ Breaks: insert or remove a manual page break at the selection, or reset them all.
        if (!committed()) return;
        const sheet = wb.sheet(sheetId);
        if (sheet.kind === 'chart') return;
        const settings = sheet.printSettings || {};
        const at = { active: grid.active, wholeRows: grid.range.c1 === 0 && grid.range.c2 >= MAX_COL, wholeCols: grid.range.r1 === 0 && grid.range.r2 >= MAX_ROW };
        if (arg === 'reset') {
          if (!settings.rowBreaks?.length && !settings.colBreaks?.length) { toast('This sheet has no manual page breaks', { icon: 'info' }); keepFocus(); return; }
          wb.setPageBreaks(sheetId, { rows: [], cols: [] }, 'Reset all page breaks');
          statusBar?.announce('All manual page breaks removed');
        } else if (arg === 'remove') {
          if (!hasBreakAt(settings, at)) { toast('There is no manual page break beside the selected cell', { icon: 'info' }); keepFocus(); return; }
          wb.setPageBreaks(sheetId, removeBreaks(settings, at), 'Remove page break');
          statusBar?.announce('Page break removed');
        } else {
          const next = insertBreaks(settings, at);
          if (!wb.setPageBreaks(sheetId, next, 'Insert page break')) { toast('A page already starts at the selected cell', { icon: 'info' }); keepFocus(); return; }
          statusBar?.announce('Page break inserted');
        }
        refreshPageView(true);
        notify(); keepFocus();
        return;
      }
      case 'movePageBreak': {
        if (!arg) return;
        const sheet = wb.sheet(grid.sheetId), area = pageBreaks(wb, grid.sheetId)?.area;
        if (!sheet || !area) return;
        const list = moveBreak(sheet.printSettings, area, arg);
        wb.setPageBreaks(grid.sheetId, arg.axis === 'row' ? { rows: list } : { cols: list }, 'Move page break');
        refreshPageView(true);
        notify(); keepFocus();
        return;
      }
      case 'printAreaEdge': {
        // The print area's edge dragged in Page Break Preview: the area grows or shrinks to that line.
        if (!arg) return;
        const sheet = wb.sheet(grid.sheetId), area = pageBreaks(wb, grid.sheetId)?.area;
        if (!sheet || !area) return;
        const current = sheet.printSettings || normalizePrintSettings({});
        const next = moveAreaEdge(area, arg.edge, arg.to);
        wb.setPrintSettings(grid.sheetId, { ...current, areas: [next, ...current.areas.slice(1)] }, 'Print area');
        statusBar?.announce(`Print area set to ${rangeName(next)}`);
        refreshPageView(true);
        notify(); keepFocus();
        return;
      }
      case 'showPageBreaks': {
        // View ▸ Page Breaks: Normal view's dashed lines where the pages break, kept with the sheet.
        const sheet = wb.sheet(grid.sheetId);
        if (!sheet || sheet.kind === 'chart') return;
        const on = arg == null ? !pageBreakLinesOn(grid.sheetId) : !!arg;
        if (!on) previewedSheets.delete(grid.sheetId);
        wb.setShowPageBreaks(grid.sheetId, on);
        refreshPageView(true);
        notify(); keepFocus();
        return;
      }
      case 'printArea': {
        if (!committed()) return;
        const sheet = wb.sheet(sheetId);
        if (sheet.kind === 'chart') return;
        const current = sheet.printSettings || normalizePrintSettings({});
        if (arg === 'clear') {
          if (!current.areas.length) { toast('There is no print area to clear', { icon: 'info' }); keepFocus(); return; }
          wb.setPrintSettings(sheetId, { ...current, areas: [] });
          toast('Print area cleared', { icon: 'printer', duration: 1800 });
        } else {
          const areas = arg === 'add' ? [...current.areas, ...grid.ranges] : [...grid.ranges];
          wb.setPrintSettings(sheetId, { ...current, areas });
          toast(`Print area ${arg === 'add' ? 'extended to' : 'set to'} ${areas.map(rangeName).join(', ')}`, { icon: 'printer', duration: 2400 });
        }
        notify();
        keepFocus();
        return;
      }
      case 'zoomSelection': {
        // Zoom to Selection: the largest zoom at which the selected range fits the visible grid.
        const rg = grid.range;
        const zs = wb.sheet(sheetId);
        const w = lineSpan(zs, 'col', rg.c1, rg.c2, zs.defaultColWidth ?? wb.colWidth(sheetId, -1));
        const h = lineSpan(zs, 'row', rg.r1, rg.r2, zs.defaultRowHeight ?? wb.rowHeight(sheetId, -1));
        const vp = grid.viewport;
        const availW = Math.max(40, (vp?.clientWidth || 0) - 52), availH = Math.max(40, (vp?.clientHeight || 0) - 30);
        if (!w || !h) return;
        run('zoomTo', Math.max(0.1, Math.min(4, Math.floor(Math.min(availW / w, availH / h) * 100) / 100)));
        grid.scrollToActive();
        return;
      }
      case 'validation': if (!committed()) return; openValidationManager(ctx); return;
      case 'insertCheckbox': {
        // Checkboxes: a checkbox rule over every selected range (the rows a filter hides left out,
        // as when formatting); blank cells start unchecked. One undo step for all of them.
        if (!committed()) return;
        // A protected cell anywhere in the selection refuses the whole insertion up front, as a protected sheet
        // does (the workbook's notice names it): no rule goes over cells whose FALSE it would then decline to write.
        if (grid.ranges.some((rg) => wb.lockedIn(sheetId, rg))) return;
        let total = 0;
        let refused = false;
        wb.transaction('Insert checkboxes', () => eachRange('Insert checkboxes', (range) => {
          if (refused) return;
          if (!wb.addValidation(sheetId, { range, type: 'checkbox', strict: true, allowBlank: true })) { refused = true; return; }
          const entries = [];
          let cells = 0;
          for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
            // A merged block is one cell: its top-left takes the checkbox and the cells hidden under it stay
            // empty, as a paste leaves them, rather than holding a FALSE apiece that unmerging would show.
            if (coveredByMerge(sheetId, r, c)) continue;
            cells++;
            const cell = wb.getCell(sheetId, r, c);
            if (!cell || (cell.v == null && cell.f == null)) entries.push({ r, c, cell: { v: false, f: null, s: cell?.s } });
          }
          if (entries.length) wb.setCells(sheetId, entries, 'Insert checkboxes');
          total += cells;
        }, { what: 'Checkboxes inserted' }));
        if (refused || !total) return;
        toast(total === 1 ? 'Checkbox inserted. Space toggles it' : `${total} checkboxes inserted`, { icon: 'check', duration: 2200 });
        keepFocus();
        return;
      }
      case 'insertDropdown': if (!committed()) return; openValidationManager(ctx, { type: 'list' }); return;
      case 'condFormat': if (!committed()) return; openConditionalFormatting(ctx); return;
      case 'condFormatMenu':
        if (!committed()) return;
        openMenu({ anchor: arg instanceof HTMLElement ? arg : null, label: 'Conditional formatting', minWidth: 240,
          items: conditionalFormattingItems(run), onClose: (reason) => { if (reason !== 'select') keepFocus(); } });
        return;
      case 'quickRule': {
        if (!committed() || refusedByProtection('add conditional formatting') || !oneRange('add conditional formatting')) return;
        if (typeof arg === 'string') { openQuickRuleDialog(ctx, arg, grid.range); return; }
        const rule = presetRule(grid.range, arg || {});
        if (rule && wb.addRule(sheetId, rule)) toast(`${{ databar: 'Data bars', scale: 'Color scale', icons: 'Icon set' }[arg.kind]} added to ${rangeName(grid.range)}`, { icon: 'highlighter', duration: 1800 });
        keepFocus();
        return;
      }
      case 'clearRules': {
        if (!committed() || refusedByProtection('clear conditional formatting')) return;
        const cleared = clearRules(wb, sheetId, arg === 'sheet' ? null : grid.ranges);
        toast(cleared ? `Cleared ${cleared} rule${cleared === 1 ? '' : 's'}${arg === 'sheet' ? ' from this sheet' : ' from the selection'}` : arg === 'sheet' ? 'This sheet has no conditional formatting' : 'The selection has no conditional formatting', { icon: cleared ? 'eraser' : 'info', duration: 2000 });
        keepFocus();
        return;
      }
      case 'pivot': openPivotDialog(ctx); return;
      case 'recommendedPivots': openRecommendedPivots(ctx); return;
      case 'goalSeek': if (!committed()) return; openGoalSeek(ctx); return;
      case 'dataTable': if (!committed()) return; openDataTable(ctx); return;
      case 'forecastSheet': if (!committed()) return; openForecastSheet(ctx); return;
      case 'scenarioManager': if (!committed()) return; openScenarioManager(ctx); return;
      case 'solver': if (!committed()) return; openSolver(ctx); return;
      case 'dataAnalysis': if (!committed()) return; openDataAnalysis(ctx); return;
      case 'customViews': if (!committed()) return; openCustomViews(ctx); return;
      case 'sheetView': {
        // View ▸ Sheet View: New, Keep, Exit, switching views, and Options (rename, duplicate, delete).
        if (!committed()) return;
        const sheet = wb.sheet(sheetId);
        if (!sheet || sheet.kind === 'chart') return;
        const action = typeof arg === 'string' ? arg : arg?.action;
        const views = sheet.sheetViews || [];
        if (action === 'new') {
          if (wb.newSheetView(sheetId)) toast('You are in a temporary sheet view: the filters you set stay yours. Keep it to give it a name', { icon: 'sheetView', duration: 4000 });
        } else if (action === 'keep') {
          const at = views.find((v) => v.id === sheet.personalView?.id);
          if (!at) { toast('Choose New first: Keep names the temporary view you are in', { icon: 'info', duration: 3000 }); return; }
          const name = await askViewName(views, { title: 'Keep View', value: at.temporary ? nextViewName(views) : at.name, except: at.id, confirmLabel: 'Keep' });
          if (name != null && wb.keepSheetView(sheetId, name)) statusBar?.announce(`Sheet view ${name.trim()} kept`);
        } else if (action === 'exit') {
          if (wb.exitSheetView(sheetId)) statusBar?.announce('Back to the default view');
        } else if (action === 'switch') {
          if (arg?.id) wb.enterSheetView(sheetId, arg.id); else wb.exitSheetView(sheetId);
        } else if (action === 'rename') wb.renameSheetView(sheetId, arg.id, arg.name);
        else if (action === 'duplicate') wb.duplicateSheetView(sheetId, arg.id);
        else if (action === 'delete') wb.deleteSheetView(sheetId, arg.id);
        else if (action === 'options') { openSheetViewOptions(ctx); return; }
        rememberSheetViews();
        notify(); keepFocus();
        return;
      }
      case 'addCustomView': {
        // The zoom in force may be this device's, not yet the sheet's own: the view keeps what is on screen.
        if (!committed() || !arg?.name) return;
        if (wb.sheet(grid.sheetId)?.viewZoom == null && grid.zoom !== 1) wb.setSheetView(grid.sheetId, { viewZoom: grid.zoom });
        if (wb.addCustomView(arg.name, { print: arg.print !== false, hidden: arg.hidden !== false })) {
          statusBar?.announce(`View ${arg.name} added`);
          toast(`View “${arg.name}” added`, { icon: 'customViews', duration: 1800 });
        }
        notify();
        return;
      }
      case 'deleteCustomView':
        if (wb.deleteCustomView(arg)) statusBar?.announce('View deleted');
        notify();
        return;
      case 'showCustomView': {
        // Show a view: the grid goes to the view's sheet first, so leaving this one does not record its place over the view's.
        if (!committed()) return;
        const view = wb.customViews.find((v) => v.id === arg);
        if (!view) return;
        const front = wb.sheet(view.activeSheetId);
        if (front && !front.hidden && front.id !== wb.activeSheetId) wb.setActiveSheet(front.id);
        wb.showCustomView(view.id);
        grid.reloadSheetView();
        refreshPageView(true);
        statusBar?.announce(`View ${view.name} shown`);
        notify(); keepFocus();
        return;
      }
      case 'advancedFilter': if (!committed()) return; if (refusedByProtection('filter the list')) return; openAdvancedFilter(ctx); return;
      // Data ▸ Get & Transform Data and Queries & Connections (see ui/get-data.js, ui/query-editor.js, core/queries.js).
      case 'getDataText': if (!committed()) return; getDataText(ctx, editQuery); return;
      case 'getDataWorkbook': if (!committed()) return; getDataWorkbook(ctx, editQuery); return;
      case 'getDataWeb': if (!committed()) return; if (session.signedOut && (!await session.signIn() || destroyed)) return; getDataWeb(ctx, editQuery); return;
      case 'getDataTable': {
        if (!committed()) return;
        if (!oneRange('get data from a range')) return;
        getDataTable(ctx, editQuery, { createTable: (then) => {
          const range = dataRange(grid.range);
          if (range.r1 >= range.r2) { toast('Select the header row and at least one row of data', { icon: 'info' }); return; }
          openTableDialog(ctx, { range, onCreated: then });
        } });
        return;
      }
      case 'blankQuery': if (!committed()) return; blankQuery(ctx, editQuery); return;
      case 'powerQueryEditor': if (!committed()) return; editQuery(ctx, { queryId: typeof arg === 'string' ? arg : null }); return;
      case 'queriesPane': queriesPane.toggle(); notify(); return;
      case 'refreshQuery': {
        // Table Design ▸ Refresh, or a query named by id: the query behind the table at the active cell is run again.
        if (!committed()) return;
        const a = grid.active;
        const table = wb.tableAt(sheetId, a.r, a.c);
        const query = typeof arg === 'string' ? queryById(wb, arg) : table && queryForTable(wb, sheetId, table.id);
        if (!query) { toast(table ? 'This table was not loaded by a query' : 'Select a cell in a table loaded by a query', { icon: 'info' }); return; }
        if (!await allowQuerySources([query]) || destroyed) return;
        const res = await refreshOneQuery(wb, query, queryIo(ctx));
        if (destroyed) return;
        toast(res.error ? `${query.name}: ${res.error}` : `${query.name} refreshed: ${res.rows.toLocaleString()} row${res.rows === 1 ? '' : 's'}`, { icon: res.error ? 'alert' : 'refresh', duration: res.error ? 5000 : 2000 });
        if (!res.error) fitQueryTables(ctx, [query]);
        queriesPane.noteResults(res.error ? [{ name: query.name, error: res.error }] : []);
        keepFocus();
        return;
      }
      case 'refreshAll': {
        // Data ▸ Refresh All: every query is run again and its table rewritten, then every formula is recalculated.
        if (!wb.queries?.length) { await run('recalc'); return; }
        if (!committed()) return;
        if (!await allowQuerySources(wb.queries) || destroyed) return;
        toast('Refreshing…', { icon: 'spinner', duration: 1500 });
        const res = await refreshAllQueries(wb, queryIo(ctx));
        if (destroyed) return;
        fitQueryTables(ctx, wb.queries.filter((q) => !res.failed.some((f) => f.name === q.name)));
        wb.recalculate();
        imported.clear();
        wb.clearAsyncCache();
        grid.refresh();
        queriesPane.noteResults(res.failed);
        toast(res.failed.length ? `${res.failed.length} of ${res.failed.length + res.refreshed} queries could not be refreshed: ${res.failed[0].name}: ${res.failed[0].error}`
          : `Refreshed ${res.refreshed} quer${res.refreshed === 1 ? 'y' : 'ies'} and recalculated`, { icon: res.failed.length ? 'alert' : 'reset', duration: res.failed.length ? 6000 : 2000 });
        keepFocus();
        return;
      }
      case 'clearFilters':
        if (!committed()) return;
        if (refusedByProtection('change the filter')) return;
        toast(clearSheetFilters(wb, sheetId) ? 'Filters cleared' : 'Nothing is filtered on this sheet', { icon: 'filter' });
        keepFocus();
        return;
      case 'reapplyFilters':
        if (!committed()) return;
        if (refusedByProtection('change the filter')) return;
        if (!reapplySheetFilters(wb, sheetId)) toast('There is no filter on this sheet to reapply', { icon: 'info' });
        keepFocus();
        return;
      case 'showDetail': case 'hideDetail': {
        if (!committed()) return;
        const sheet = wb.sheet(sheetId), rg = grid.range;
        const wholeColumns = rg.r1 === 0 && rg.r2 >= sheet.rows - 1 && !(rg.c1 === 0 && rg.c2 >= sheet.cols - 1);
        if (!toggleDetail(wb, sheetId, { active: grid.active, wholeColumns }, cmd === 'showDetail')) toast(`No outline group to ${cmd === 'showDetail' ? 'show' : 'hide'} here`, { icon: 'info' });
        keepFocus();
        return;
      }
      case 'datePicker': if (!committed()) return; openDatePicker(ctx, grid.active.r, grid.active.c); return;
      case 'protectRanges': if (!committed()) return; openProtectedRanges(ctx); return;
      case 'columnStats':
        if (!committed()) return;
        if (!openColumnStats(ctx, grid.active.c)) toast('Nothing on this sheet yet', { icon: 'info' });
        return;
      case 'bands': {
        // One click banding: header row plus two gentle colors; the rules dialog edits it.
        if (!committed()) return;
        if (!oneRange('add alternating colors')) return;
        const range = dataRange(grid.range);
        const header = looksLikeHeader(wb, sheetId, range);
        if (!wb.addRule(sheetId, { range, type: 'bands', style: {}, header, headerColor: '#e0ecff', color1: '#f2f1ee', color2: '#ffffff' })) return;
        toast('Alternating colors added. Edit them under Conditional formatting', { icon: 'highlighter', duration: 3000 });
        keepFocus();
        return;
      }
      case 'editSparkline': if (!committed()) return; openSparklineDialog(ctx); return;
      case 'insertSparklines': if (!committed() || !oneRange('insert sparklines')) return; openSparklineCreateDialog(ctx, { type: typeof arg === 'string' ? arg : null }); return;
      case 'groupSparklines': {
        if (!committed()) return;
        const hidden = wb.sheet(sheetId).filterHidden, { r, c } = grid.active;
        const error = wb.regroupNativeSparklines(sheetId, grid.ranges, { ungroup: arg === 'ungroup', templateRef: cellName(r, c), skipRow: row => hidden.has(row) });
        toast(error || (arg === 'ungroup' ? 'Sparklines ungrouped' : 'Sparklines grouped using the active sparkline’s settings'), { icon: error ? 'info' : 'check' });
        keepFocus(); return;
      }
      case 'clearSparklines': {
        if (!committed()) return;
        const hidden = wb.sheet(sheetId).filterHidden;
        const count = wb.clearNativeSparklines(sheetId, grid.ranges, { groups: arg === 'groups', skipRow: r => hidden.has(r) });
        if (count === 0) toast('No sparklines in the selection', { icon: 'info' });
        else if (count != null) toast(`Cleared ${count} sparkline${count === 1 ? '' : 's'}`, { icon: 'check' });
        keepFocus(); return;
      }
      case 'insertChart': {
        // Insert ▸ Chart…: the Insert Chart dialog, on Recommended Charts or on the family asked for.
        if (!committed()) return;
        if (!oneRange('insert a chart')) return;
        const family = typeof arg === 'string' ? { donut: 'pie', bubble: 'scatter' }[arg] || arg : null;
        return runChartAction(ctx, family ? { action: 'insertDialog', family } : { action: 'recommended' });
      }
      case 'quickChart': {
        // Alt+F1: the default chart of the selection, on the sheet beside it.
        if (!committed()) return;
        if (!oneRange('insert a chart')) return;
        insertExcelChart(ctx);
        return;
      }
      case 'insertChartSheet': {
        // F11: the default chart of the selection on a chart sheet of its own.
        if (!committed()) return;
        if (!oneRange('insert a chart')) return;
        insertChartSheet(ctx);
        return;
      }
      case 'chart': return runChartAction(ctx, arg);
      case 'smartArt': { if (!committed()) return; const changed = runSmartArtAction(ctx, arg); if (changed) keepFocusUnlessPane(); notify(); return; }
      case 'editChart': {
        const chart = wb.chartById(sheetId, arg || grid.selectedChart);
        if (chart?.type === 'slicer') openSlicerDialog(ctx, chart);
        else if (chart?.type === 'timeline') openTimelineSettingsDialog(ctx, chart);
        else if (chart?.type === 'scroll') openScrollDialog(ctx, chart);
        else if (chart?.type === 'text' && chart.equation) openEquationDialog(ctx, { equation: chart });
        else if (chart?.type === 'text') openTextBoxDialog(ctx, { textbox: chart });
        else if (chart?.type === 'smartart') { grid.selectChart(chart.id, { focus: false }); smartArtPane.show({ focus: true }); }
        else if (chart && chart.type !== 'image') openChartDialog(ctx, { chart });
        return;
      }
      case 'insertTextBox': openTextBoxDialog(ctx); return;
      case 'deleteChart': {
        const id = arg || grid.selectedChart;
        if (!id) return;
        const kind = wb.chartById(sheetId, id)?.type;
        if (kind === 'timeline') { if (!deleteTimeline(wb, sheetId, id)) return; }
        else if (!wb.deleteChart(sheetId, id)) return;
        toast(kind === 'slicer' ? 'Slicer deleted' : kind === 'timeline' ? 'Timeline deleted' : kind === 'image' ? 'Image deleted' : kind === 'text' ? 'Text box deleted' : kind === 'smartart' ? 'SmartArt deleted' : 'Chart deleted', { icon: 'trash', duration: 1600 });
        keepFocus();
        return;
      }
      case 'duplicateChart': {
        const id = wb.duplicateChart(sheetId, arg?.id || arg || grid.selectedChart);
        if (id) { grid.selectChart(id); toast('Duplicated. Drag the copy where you want it', { icon: 'duplicate', duration: 2200 }); }
        keepFocus();
        return;
      }
      case 'copyChart': {
        // A PNG of the chart (or the picture itself) on the clipboard, for documents and chats.
        const id = arg?.id || grid.selectedChart;
        const ch = wb.chartById(sheetId, id);
        if (!ch) return;
        if (ch.type === 'slicer') {
          const data = slicerClipboard(document, ch, slicerItems(wb, ch), wb);
          try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([data.text], { type: 'text/plain' }), 'text/html': new Blob([data.html], { type: 'text/html' }) })]); toast('Slicer copied', { icon: 'copy' }); }
          catch { toast('Could not copy the slicer', { icon: 'alert' }); }
          keepFocus(); return;
        }
        if (ch.type === 'timeline') { toast('A timeline cannot be copied; insert another from Insert ▸ Timeline', { icon: 'info', duration: 3000 }); keepFocus(); return; }
        if (ch.type === 'scroll') {
          const data = copyScroll(ch);
          try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([data.text], { type: 'text/plain' }), 'text/html': new Blob([data.html], { type: 'text/html' }) })]); toast('Scroll bar copied', { icon: 'copy' }); }
          catch { toast('Could not copy the scroll bar', { icon: 'alert' }); }
          keepFocus(); return;
        }
        if (ch.type === 'text') {
          try { await navigator.clipboard.writeText(ch.text); toast('Text copied', { icon: 'copy', duration: 1800 }); } catch { toast('Could not copy the text', { icon: 'alert' }); }
          keepFocus();
          return;
        }
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { toast('This browser cannot copy images; use Download instead', { icon: 'info', duration: 3500 }); return; }
        try {
          let blob;
          if (ch.type === 'smartart') blob = await svgToPng(smartArtPicture(ch), ch.w, ch.h);
          else if (ch.type === 'image') {
            const shown = linkedPictureNow(ch);
            const raw = await (await fetch(shown.src)).blob();
            blob = raw.type === 'image/png' && pictureIsPlain(shown) ? raw : await imageToPng(shown.src, shown);
          } else {
            const cs = getComputedStyle(grid.viewport);
            const svg = standaloneSvg(renderChartSvg(chartData(wb, sheetId, ch), ch, ch.w, ch.h), (n) => cs.getPropertyValue(n));
            blob = await svgToPng(svg, ch.w, ch.h);
          }
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast(ch.type === 'image' ? 'Image copied' : ch.type === 'smartart' ? 'SmartArt copied as a picture' : 'Chart copied as a picture', { icon: 'copy', duration: 1800 });
        } catch (e) {
          console.error(e);
          toast('Could not copy the picture', { icon: 'alert' });
        }
        keepFocus();
        return;
      }
      case 'downloadChart': {
        const id = arg?.id || grid.selectedChart;
        const ch = wb.chartById(sheetId, id);
        if (!ch) return;
        try {
          let blob;
          let name;
          if (ch.type === 'smartart') {
            const format = arg?.format === 'svg' ? 'svg' : 'png', svg = smartArtPicture(ch);
            blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await svgToPng(svg, ch.w, ch.h);
            name = `${P.sanitizeName(ch.name || 'SmartArt') || 'SmartArt'}.${format}`;
          } else if (ch.type === 'image' && ch.pictureRef) {
            const shown = linkedPictureNow(ch);
            blob = await imageToPng(shown.src, shown);
            name = `${P.sanitizeName(ch.title || 'picture') || 'picture'}.png`;
          } else if (ch.type === 'image') {
            if (!pictureIsPlain(ch)) blob = await imageToPng(ch.src, ch);
            else {
              const drawing = ch.drawingShape && await (await import('../core/drawingml-raster.js')).drawingRasterSource(ch.src, ch);
              blob = await (await fetch(drawing?.src || ch.src)).blob();
            }
            const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
            name = `${P.sanitizeName((ch.title || 'image').replace(/\.[^.]+$/, '')) || 'image'}.${ext}`;
          } else {
            const format = arg?.format === 'svg' ? 'svg' : 'png';
            const cs = getComputedStyle(grid.viewport);
            const svg = standaloneSvg(renderChartSvg(chartData(wb, sheetId, ch), ch, ch.w, ch.h), (n) => cs.getPropertyValue(n));
            blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await svgToPng(svg, ch.w, ch.h);
            name = `${P.sanitizeName(ch.title || 'chart') || 'chart'}.${format}`;
          }
          // A save that failed (out of space, offline) is said, as the sheet exports say it; the editor may have been left by then.
        if (P.isApp() && P.canSaveFiles()) P.saveFileAs(blob, name).then((saved) => saved && toast(`Saved ${saved.name}`, { icon: 'check' })).catch((e) => { if (!destroyed) toast(`Could not export: ${e?.message || 'unknown error'}`, { icon: 'alert' }); });
          else P.downloadBlob(blob, name);
        } catch (e) {
          console.error(e);
          toast('Could not export that', { icon: 'alert' });
        }
        keepFocus();
        return;
      }
      // Insert ▸ Pictures: over the cells, or with 'cell' into the active cell as its value (Place in Cell).
      case 'insertImage': if (!committed()) return; replaceImageId = null; imageIntoCell = arg === 'cell'; imageInput.click(); return;
      case 'sheetBackground': {
        if (!committed()) return;
        const sheet = wb.sheet(sheetId);
        if (!sheet || sheet.kind === 'chart') return;
        if (arg === 'delete') {
          if (wb.setSheetBackground(sheetId, null)) statusBar?.announce('Sheet background deleted');
          else toast('This sheet has no background', { icon: 'info' });
          keepFocus();
          return;
        }
        if (refusedByProtection('change the background')) return;
        backgroundSheet = sheetId;
        backgroundInput.click();
        return;
      }
      case 'replaceImage': {
        const id = arg || grid.selectedChart || null;
        // A linked picture's double-click (or Enter) goes to the cells it shows.
        const linked = id && wb.chartById(sheetId, id)?.pictureRef;
        if (linked) {
          const target = linkedPictureTarget(wb, sheetId, linked);
          if (target) { grid.selectChart(null); selectLocation(target.sheetId, target.range); }
          else toast(`The cells this picture showed (${linked}) are gone`, { icon: 'info', duration: 3000 });
          return;
        }
        replaceImageId = id; imageIntoCell = false; if (replaceImageId) imageInput.click(); return;
      }
      case 'insertImagePuter': {
        if (!P.canPickFiles() || !committed()) return;
        if (refusedByProtection('insert images')) return;
        // The picker and file read may finish after the user has moved to another cell or sheet.
        const target = { sheetId: grid.sheetId, anchor: { ...grid.active }, inCell: arg === 'cell' };
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        const picked = await P.pickFile({ accept: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] });
        if (destroyed) return;
        if (!picked) { keepFocus(); return; }
        if (picked.item?.size > MAX_IMAGE_BYTES) {
          toast(`${picked.name} is too large to put on the sheet (over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`, { icon: 'info', duration: 3500 });
          keepFocus(); return;
        }
        try {
          const bytes = await P.readFile(picked.path);
          if (destroyed || !wb.sheet(target.sheetId)) return;
          const type = sniffImageType(bytes);
          if (!type) { toast('That file is not a supported image. Choose a PNG, JPEG, GIF, WebP, or SVG', { icon: 'alert', duration: 4000 }); keepFocus(); return; }
          await insertImageFile(new File([bytes], picked.name, { type }), target);
        } catch (e) {
          if (destroyed) return;
          toast(`Could not load that image from Puter: ${e?.message || e?.error?.message || 'unknown error'}`, { icon: 'alert', duration: 4000 });
          keepFocus();
        }
        return;
      }
      case 'insertImageUrl': {
        // A picture from the web, fetched through Puter so it lands in the file like an uploaded one.
        const url = await promptDialog({
          title: arg === 'cell' ? 'Place picture in cell from URL' : 'Insert image from URL', label: 'Address of a PNG, JPEG, GIF, WebP, or SVG image', placeholder: 'https://example.com/logo.png', confirmLabel: arg === 'cell' ? 'Place in Cell' : 'Insert',
          validate: urlProblem,
        });
        if (!url) { keepFocus(); return; }
        if (!committed()) return;
        const target = { sheetId: grid.sheetId, anchor: { ...grid.active }, inCell: arg === 'cell' };
        try {
          const bytes = await P.fetchBytes(url.trim());
          if (destroyed) return;
          const type = sniffImageType(bytes);
          if (!type) { toast('That address did not return an image', { icon: 'alert', duration: 4000 }); keepFocus(); return; }
          let name = 'image';
          try { name = decodeURIComponent(new URL(url.trim()).pathname.split('/').filter(Boolean).pop() || 'image'); } catch { /* keep the default */ }
          await insertImageFile(new File([bytes], name, { type }), target);
        } catch (e) {
          if (destroyed) return;
          console.error(e);
          toast(explained(e) ? e.message : 'Could not fetch that image', { icon: 'alert', duration: 4000 });
          keepFocus();
        }
        return;
      }
      // A protected sheet is said before the dialog opens, not when it is submitted.
      case 'note': if (refusedByProtection('add a note')) return; if (ctx.comments?.hasThread()) { run('replyComment'); return; } openNoteDialog(); return;
      case 'link': if (refusedByProtection('add a link')) return; openLinkDialog(); return;
      case 'unlink':
        // The link of the cell the entry goes into, as Link… commits and edits that cell's; a formula shown
        // on another sheet would otherwise unlink that sheet's active cell.
        if (!committed()) return;
        wb.removeLink(sheetId, grid.active.r, grid.active.c);
        keepFocus();
        return;
      // Automate (ui/automate.js): scripts, the Code Editor, Record Actions and script buttons.
      case 'scriptsPane': case 'newScript': case 'openScript': case 'recordActions': case 'stopRecording': case 'scriptGallery':
      case 'runScript': case 'stopScript': case 'scriptReference': case 'insertScriptButton':
        return automate?.run(cmd, arg);
      case 'openDrawingLink': {
        const url = safeLinkUrl(wb.chartById(sheetId, arg)?.hyperlink);
        if (!url) return;
        // A script button (Automate ▸ Script Button) runs its script.
        if (scriptOfLink(url) != null) { automate?.run('runScript', { name: scriptOfLink(url) }); return; }
        if (url.startsWith('#')) { followInternalLink(url); return; }
        window.open(url, '_blank', 'noopener');
        return;
      }
      case 'openLink': {
        const link = wb.linkAt(sheetId, grid.active.r, grid.active.c);
        if (!link) return;
        if (link.url.startsWith('#')) { followInternalLink(link.url); return; }
        window.open(link.url, '_blank', 'noopener');
        return;
      }
      case 'deleteNote':
        if (!committed()) return; // the note of the cell the entry goes into, as Edit note commits and edits it
        wb.setNote(sheetId, grid.active.r, grid.active.c, null);
        keepFocus();
        return;
      case 'goToName': goToName(arg); return;
      case 'selectSpecialMenu': {
        const anchor = arg instanceof HTMLElement ? arg : null;
        const scope = S.isSingle(grid.selection) ? 'the data' : rangeName(grid.range);
        openMenu({
          anchor, x: anchor ? null : (arg?.x ?? null), y: anchor ? null : (arg?.y ?? null), label: 'Select cells', minWidth: 220,
          items: [
            { header: `Within ${scope}` },
            ...Object.entries(SPECIAL_KINDS).map(([kind, label]) => ({ label, onSelect: () => run('selectSpecial', kind) })),
          ],
          onClose: () => keepFocus(),
        });
        return;
      }
      case 'selectSpecial': {
        // Go To Special: every cell of a kind becomes part of a multi-range selection. A selection of several
        // ranges (Ctrl/Cmd+click) is searched range by range, every area of it.
        if (!committed()) return;
        // The kinds that start from the active cell look at the whole sheet; the others at the selection, or the sheet when one cell is selected.
        const whole = ['currentRegion', 'lastCell', 'precedents', 'dependents'].includes(arg);
        const scopes = whole || (grid.ranges.length === 1 && S.isSingle(grid.selection)) ? [wb.usedRange(sheetId)].filter(Boolean) : grid.ranges;
        if (!scopes.length) { toast('Nothing on this sheet yet', { icon: 'info' }); return; }
        let truncated = false;
        const ranges = scopes.flatMap((scope) => { const found = wb.specialCells(sheetId, scope, arg, 500, grid.active); truncated ||= !!found.truncated; return found; });
        const label = (SPECIAL_KINDS[arg] || arg).toLowerCase();
        if (!ranges.length) { toast(`No ${label} in ${scopes.length === 1 ? rangeName(scopes[0]) : 'the selection'}`, { icon: 'info' }); return; }
        grid.setRanges(ranges);
        const n = ranges.reduce((sum, rg) => sum + (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1), 0);
        // The workbook stops after a few hundred blocks and marks the list; the count is then a first helping, not the whole.
        toast(truncated ? `Selected the first ${n} cells: ${label} (there are more)` : `Selected ${n} cell${n === 1 ? '' : 's'}: ${label}`, { icon: 'check', duration: 2200 });
        keepFocus();
        return;
      }
      case 'trace': {
        // Formula auditing: light up the cells this formula reads (precedents)
        // or the formulas that read this cell (dependents). Escape clears.
        if (!committed()) return;
        const { r, c } = grid.active;
        const what = arg === 'dependents' ? 'dependents' : 'precedents';
        const cells = what === 'dependents' ? wb.dependents(sheetId, r, c) : wb.precedents(sheetId, r, c);
        const here = cells.filter((x) => x.sheetId === sheetId);
        const elsewhere = cells.length - here.length;
        grid.setHighlights(here.map(({ r: rr, c: cc }) => ({ r: rr, c: cc })), -1);
        tracing = here.length ? sheetId : null;
        if (!cells.length) {
          const cell = wb.getCell(sheetId, r, c);
          toast(what === 'precedents'
            ? (cell?.f != null ? 'This formula does not read any cells directly' : `${cellName(r, c)} is not a formula`)
            : `No formulas read ${cellName(r, c)}`, { icon: 'info', duration: 2600 });
          return;
        }
        if (!here.length) {
          // Every one is on another sheet: nothing was highlighted, so no cell is named and Escape has
          // nothing to clear, instead of "A1 reads  (2 on other sheets). Escape clears the highlight".
          const some = `${elsewhere} cell${elsewhere === 1 ? '' : 's'} on other sheets`;
          toast(what === 'precedents' ? `${cellName(r, c)} reads ${some}` : `Read by ${some}`, { icon: 'fx', duration: 5000 });
          statusBar?.announce(`${cells.length} ${what}, none on this sheet`);
          return;
        }
        const names = here.slice(0, 6).map((x) => cellName(x.r, x.c)).join(', ');
        const more = here.length > 6 ? ` and ${here.length - 6} more` : '';
        const other = elsewhere ? ` (${elsewhere} on other sheet${elsewhere === 1 ? '' : 's'})` : '';
        toast(`${what === 'precedents' ? `${cellName(r, c)} reads` : `Read by`} ${names}${more}${other}. Escape clears the highlight`, { icon: 'fx', duration: 5000 });
        statusBar?.announce(`${cells.length} ${what} highlighted`);
        return;
      }
      case 'print':
        openPrintDialog(ctx);
        if (wb.sheet(sheetId)?.kind !== 'chart') { previewedSheets.add(sheetId); refreshPageView(true); }
        return;
      case 'find': if (!committed()) return; findBar.open({ replace: arg === 'replace' }); return;
      case 'findNext': if (!committed()) return; findBar.findNext(); return;
      case 'goTo': {
        if (!committed()) return;
        // Focus mode (or View ▸ Formula Bar unticked) hides the formula bar and its name box: ask for the address instead.
        if (root.classList.contains('focus-mode') || root.classList.contains('no-formula-bar')) {
          const text = await promptDialog({ title: 'Go to', label: 'Cell, range, or name', placeholder: 'B7, B2:D9, Total, or Sheet2!A1', confirmLabel: 'Go' });
          if (destroyed) return;
          // Whatever the name box accepts: a cell or range, a named range, a table, or a place on another sheet.
          const target = text?.trim();
          if (target && !grid.selectByName(target) && goToName(target) === false) toast('That is not a cell, range, or name in this spreadsheet', { icon: 'info' });
          keepFocus();
          return;
        }
        formulaBar.focusNameBox();
        return;
      }
      case 'scrollToActive': grid.scrollToActive(); keepFocus(); return;
      case 'copyLink': {
        // An address that opens this file with the selected cells chosen.
        if (!committed()) return;
        if (session.signedOut && (!await session.signIn() || destroyed)) return;
        if (!doc.path) {
          try { await doc.save(); } catch (e) { toast(e?.message || 'Could not save the spreadsheet', { icon: 'alert', duration: 4000 }); return; }
          if (destroyed) return;
        }
        if (!doc.path) { toast('Save the spreadsheet first, then copy a link to it', { icon: 'info', duration: 3500 }); return; }
        const rg = grid.range;
        const url = rangeLink(location, doc.path, wb.sheet(grid.sheetId).name, rg);
        const what = rg.r1 === rg.r2 && rg.c1 === rg.c2 ? cellName(rg.r1, rg.c1) : rangeName(rg);
        try {
          await navigator.clipboard.writeText(url);
          toast(`Link to ${what} copied`, { icon: 'link', duration: 2200 });
        } catch {
          await promptDialog({ title: `Link to ${what}`, label: 'Address (copy it from here)', value: url, confirmLabel: 'Done' });
        }
        keepFocus();
        return;
      }
      case 'replace': if (!committed()) return; findBar.open({ replace: true }); return;
      default:
        console.warn('Unknown command', cmd);
    }
  }

  // Pictures travel in the file as data URLs: one past this would swell the file (and the local draft) beyond what saves.
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  /**
   * An image file as a data URL plus its size. Big bitmaps are scaled down
   * (longest side 1600px, JPEG for photos) so the file stays reasonable.
   */
  async function readImageFile(file) {
    if (file.size > MAX_IMAGE_BYTES) throw Object.assign(new Error(`${file.name} is too large (over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`), { code: 'too-large' });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('bad image'));
      im.src = dataUrl;
    });
    const width = img.naturalWidth || img.width || 240;
    const height = img.naturalHeight || img.height || 160;
    const longest = Math.max(width, height);
    if (file.type === 'image/svg+xml' || file.type === 'image/gif' || (longest <= 1600 && file.size <= 1.5 * 1024 * 1024)) return { src: dataUrl, width, height };
    const scale = Math.min(1, 1600 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = file.type === 'image/png';
    return { src: canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), width: canvas.width, height: canvas.height };
  }

  /** A SmartArt diagram as a picture of its own, in the workbook's theme (one another program drew, as it drew it). */
  function smartArtPicture(ch) {
    if (ch.fallback?.src) return decodeURIComponent(escape(atob(ch.fallback.src.split(',')[1])));
    return smartArtSvg(ch, ch.w, ch.h, { ...smartArtLook(wb), idPrefix: 'sap', label: ch.decorative ? '' : ch.description || smartArtAltText(ch) });
  }
  /** After a SmartArt command the keyboard goes back to the sheet, unless the Text Pane has it. */
  function keepFocusUnlessPane() {
    if (!ctx.smartArt?.pane?.el.contains(document.activeElement)) keepFocus();
  }

  function svgToPng(svg, width, height) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      img.onload = () => {
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const g = canvas.getContext('2d');
        g.scale(scale, scale);
        g.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad svg')); };
      img.src = url;
    });
  }

  /** The rows (or columns) covered by several ranges, merged into runs and ordered last-first so deleting them keeps indices valid. */
  function lineRuns(ranges, axis) {
    const spans = ranges.map((rg) => (axis === 'row' ? [rg.r1, rg.r2] : [rg.c1, rg.c2])).sort((a, b) => a[0] - b[0]);
    const runs = [];
    for (const [a, b] of spans) {
      const last = runs[runs.length - 1];
      if (last && a <= last.to + 1) last.to = Math.max(last.to, b);
      else runs.push({ from: a, to: b });
    }
    return runs.reverse();
  }

  function stopPainting() {
    painter = null;
    grid.el.classList.remove('painting');
    notify();
  }

  /** Is the selection still the cells the painter copied from (nothing picked yet)? */
  function onPainterSource() {
    const range = grid.range;
    const src = painter.range;
    return grid.sheetId === painter.sheetId && range.r1 === src.r1 && range.c1 === src.c1 && range.r2 === src.r2 && range.c2 === src.c2;
  }

  function pasteClipboardStyles(sheetId, cells, r, c, target, options) {
    const actual = wb.stylePasteRange(sheetId, cells, r, c, target);
    if (!actual || !wb.nativePivotOverlap(sheetId, actual)) return wb.pasteStyles(sheetId, cells, r, c, target, options) !== false;
    try {
      return pasteNativePivotClipboardStyles(wb, sheetId, cells, r, c, target,
        { ...options, maxCells: MAX_FORMAT_CELLS, defaultSize: 13 });
    } catch {
      toast('This formatting cannot be applied to the selected part of the pivot table', { icon: 'info', duration: 5000 });
      return false;
    }
  }

  /** Format painter: paint the copied formatting onto the selection and put the painter away. */
  function applyPainter() {
    if (!painter || grid.editing) return;
    // The painter copies one block onto one: a Ctrl/Cmd+click selection of several ranges is refused, with the
    // painter still armed to pick again, rather than the last range added painted and the others left plain.
    if (!oneRange('paint formatting onto')) return;
    const range = grid.range;
    const target = S.isSingle(grid.selection)
      ? { r1: range.r1, c1: range.c1, r2: Math.min(range.r1 + painter.cells.length - 1, wb.sheet(grid.sheetId).rows - 1), c2: Math.min(range.c1 + painter.cells[0].length - 1, wb.sheet(grid.sheetId).cols - 1) }
      : formatRange();
    // A protected sheet or range refuses the formatting and says so; the painter is put away without claiming a paint.
    if (wb.lockedIn(grid.sheetId, target)) { stopPainting(); return; }
    const actual = wb.stylePasteRange(grid.sheetId, painter.cells, target.r1, target.c1, target);
    if (actual && wb.nativePivotOverlap(grid.sheetId, actual)) {
      try {
        pasteNativePivotStyles(wb, grid.sheetId, painter.cells, target.r1, target.c1, target,
          { maxCells: MAX_FORMAT_CELLS, defaultSize: 13 });
      } catch {
        toast('This formatting cannot be applied to the selected part of the pivot table', { icon: 'info', duration: 5000 });
        stopPainting(); return;
      }
    } else wb.pasteStyles(grid.sheetId, painter.cells, target.r1, target.c1, target);
    grid.setSelection(S.fromRange(target, { r: target.r1, c: target.c1 }), { scroll: false });
    if (painter.sticky) { toast('Formatting painted. Select more cells, or press Escape to stop', { icon: 'paint', duration: 1600 }); return; }
    stopPainting();
    toast('Formatting painted', { icon: 'paint', duration: 1400 });
  }

  /** Once the pointer has picked a selection, paint it. */
  function paintOnRelease() {
    if (!painter) return;
    setTimeout(() => {
      if (!painter || grid.editing || onPainterSource()) return; // still on the source: nothing picked yet
      applyPainter();
    }, 0);
  }

  /** Enter on cells reached with the keyboard paints them, as a paste does; on the source it moves down as usual. */
  function paintOnEnter(e) {
    if (!painter || grid.editing || e.key !== 'Enter' || e.shiftKey || e.altKey || isMod(e) || isComposing(e)) return;
    if (e.target !== grid.viewport || onPainterSource()) return;
    e.preventDefault();
    e.stopPropagation();
    applyPainter();
  }

  /**
   * Fit the columns c1..c2 to their content: the cells in the rows on show,
   * a row hidden by hand or by a filter counting for nothing. Columns holding nothing
   * keep their width; true when any was fitted.
   */
  function autofitColumns(c1, c2, sheetId = grid.sheetId, maxWidth = 500) {
    const sheet = wb.sheet(sheetId);
    const widths = new Map();
    const measured = new Set();
    for (let c = c1; c <= c2; c++) widths.set(c, 40);
    const canvas = document.createElement('canvas').getContext('2d');
    const css = getComputedStyle(grid.el);
    const baseSize = parseFloat(css.getPropertyValue('--grid-font-size')) || 13;
    const family = css.fontFamily || 'system-ui';
    const measure = (r, c, value, st) => {
      st = conditionalFontStyle(st, wb.conditionalStyle(sheetId, r, c, value));
      const bold = st?.bold;
      canvas.font = `${st?.italic ? 'italic ' : ''}${bold ? '600 ' : ''}${st?.size || baseSize}px ${fontStack(st?.font) || family}`;
      const width = maxLineWidth(cellLayoutText(formatValue(value, st), st?.wrap), (line) => canvas.measureText(line).width);
      const indent = indentWidth(value, st, grid.indentUnit);
      widths.set(c, Math.max(widths.get(c), width + (14 + indent)));
      measured.add(c);
    };
    for (const [key, cell] of sheet.cells) {
      const i = key.indexOf(',');
      const c = Number(key.slice(i + 1));
      if (c < c1 || c > c2 || widths.get(c) >= maxWidth || (cell.v == null && cell.f == null)) continue;
      const r = Number(key.slice(0, i));
      if (wb.isRowHidden(sheetId, r)) continue;
      // The cell's own style over the format its column or row carries, so a column formatted as
      // Currency is fitted to what its cells show rather than to their bare numbers.
      measure(r, c, wb.getValue(sheetId, r, c), wb.displayStyleAt(sheetId, r, c));
    }
    // Array results have no stored value of their own, but their displayed text also needs room.
    for (const { r, c, value } of wb.spillEntries(sheetId, { r1: 0, c1, r2: sheet.rows - 1, c2 })) {
      if (value == null || widths.get(c) >= maxWidth || wb.isRowHidden(sheetId, r)) continue;
      measure(r, c, value, wb.displayStyleAt(sheetId, r, c));
    }
    // A whole-sheet or whole-row selection takes in every empty column: those are not shrunk to slivers.
    if (!measured.size) return false;
    wb.transaction('Fit columns', () => {
      for (const c of measured) wb.setColWidth(sheetId, c, Math.min(maxWidth, Math.ceil(widths.get(c))));
    });
    return true;
  }

  /** Delimited text files carry no column widths: their used columns are fitted once on open, without dirtying the document. */
  function fitColumnsOnOpen() {
    const ids = wb.fitColumnsOnOpen;
    wb.fitColumnsOnOpen = null;
    if (!ids?.length) return;
    const wasDirty = wb.dirty;
    for (const sid of ids) {
      const used = wb.usedRange(sid);
      if (!used) continue;
      autofitColumns(used.c1, Math.min(used.c2, used.c1 + 60), sid, 320);
    }
    wb.clearHistory();
    if (!wasDirty) wb.markClean();
    grid.refresh();
  }

  /* ---------- Clipboard ---------- */

  function rangeTexts(range) {
    const rows = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row = [];
      for (let c = range.c1; c <= range.c2; c++) row.push(wb.getDisplay(grid.sheetId, r, c));
      rows.push(row);
    }
    return rows;
  }

  /**
   * Several selected ranges copy as one block when they line up:
   * the same rows side by side (columns joined) or the same columns one under
   * another (rows joined). Returns { rows, cols } or null when they do not.
   */
  function alignedIndices(ranges) {
    const sameRows = ranges.every((rg) => rg.r1 === ranges[0].r1 && rg.r2 === ranges[0].r2);
    const sameCols = ranges.every((rg) => rg.c1 === ranges[0].c1 && rg.c2 === ranges[0].c2);
    if (!sameRows && !sameCols) return null;
    const rows = new Set();
    const cols = new Set();
    for (const rg of ranges) {
      for (let r = rg.r1; r <= rg.r2; r++) if (!wb.isRowHidden(grid.sheetId, r)) rows.add(r);
      for (let c = rg.c1; c <= rg.c2; c++) if (!wb.isHidden(grid.sheetId, 'col', c)) cols.add(c);
    }
    return { rows: [...rows].sort((a, b) => a - b), cols: [...cols].sort((a, b) => a - b) };
  }

  /** Why the workbook declined to merge the range: its size limit, or a table whose header and data cells stay separate. */
  function mergeRefusal(range) {
    if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 20000) return 'Select at most 20,000 cells to merge at once';
    return 'The header and data cells of a table cannot be merged';
  }

  function snapshotClip(cut) {
    // Whole columns and rows copy as far as the sheet holds anything: below and right of that every cell is
    // blank, so a paste of the shorter block leaves what a paste of the whole lines would.
    let range = toUsedExtent(grid.range);
    let multi = null;
    if (grid.ranges.length > 1) {
      multi = alignedIndices(grid.ranges.map((rg) => toUsedExtent(rg)));
      if (!multi) { toast('Copied the last range only: several ranges copy together only when they share the same rows or the same columns', { icon: 'info', duration: 3500 }); }
      else range = { r1: multi.rows[0], c1: multi.cols[0], r2: multi.rows[multi.rows.length - 1], c2: multi.cols[multi.cols.length - 1] };
    }
    const total = multi ? multi.rows.length * multi.cols.length : (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (total > 200000) { toast('Selection too large to copy', { icon: 'alert' }); return null; }
    // Hidden and filtered-out rows (and hidden columns) are skipped:
    // a copy of a filtered list is what is on screen.
    const { rows, cols, all } = multi ? { ...multi, all: false } : wb.visibleIndices(grid.sheetId, range);
    if (!rows.length || !cols.length) { toast('Only hidden cells are selected', { icon: 'info' }); return null; }
    const sheet = wb.sheet(grid.sheetId);
    // A cut of protected cells is refused before the clipboard is replaced;
    // hidden protected cells are not being cut.
    if (cut && lockedCells(grid.sheetId, rows, cols)) return null;
    const values = rows.map(() => []);
    // Capture conditional/table looks from the same computed values as the text, including spills.
    const looks = (sheet.rules.length || sheet.tables.length) && total <= 20000 ? rows.map(() => []) : null;
    const texts = rows.map((r, i) => cols.map((c) => {
      const value = wb.getValue(grid.sheetId, r, c);
      if (looks) looks[i].push(wb.conditionalStyle(grid.sheetId, r, c, value));
      // Retain scalar results at copy time. In-cell graphics still copy as
      // blank values, while error constants remain errors rather than text.
      let copied = value ?? null;
      if (value && typeof value === 'object') copied = typeof value.error === 'string' ? { error: value.error } : null;
      else if (typeof value === 'number' && !Number.isFinite(value)) copied = { error: '#NUM!' };
      values[i].push(copied);
      return wb.getDisplay(grid.sheetId, r, c, value);
    }));
    const cells = all ? wb.copyRange(grid.sheetId, range) : wb.copyCells(grid.sheetId, rows, cols);
    // When the anchor is copied, spill slots stay empty in the embedded cells so the formula can
    // spill again. The HTML's number-format hints still need the format those results display.
    let styles = null;
    if (total <= 20000) rows.forEach((r, i) => cols.forEach((c, j) => {
      const cell = cells[i][j];
      if (wb.hasNativePivotDisplay(grid.sheetId)) {
        styles ??= rows.map(() => []);
        styles[i][j] = wb.displayStyleAt(grid.sheetId, r, c);
        return;
      }
      if (values[i][j] == null || cell?.v != null || cell?.f != null) return;
      const spill = wb.spillAt(grid.sheetId, r, c);
      if (!spill?.style || !Object.keys(spill.style).length) return;
      styles ??= rows.map(() => []);
      styles[i][j] = { ...cell?.s, ...spill.style, ...wb.getCell(grid.sheetId, r, c)?.s };
    }));
    // Where each copied line came from: with hidden lines skipped, a pasted
    // formula shifts by its own cell's move, not by its place in the compacted
    // block. Another tab cannot be told the lines, so its paste leaves such
    // formulas as they are rather than shifting them wrongly.
    const origin = { r: range.r1, c: range.c1, ...(all ? {} : { rows, cols }) };
    // Notes travel with their cells (a paste of values or formatting alone leaves them behind).
    let notes = sheet.notes.size ? rows.map((r) => cols.map((c) => wb.getNote(grid.sheetId, r, c))) : null;
    if (notes && !notes.some((row) => row.some(Boolean))) notes = null;
    // The copy's own tag rides on the table: a paste tells this copy by it from one made in
    // another tab of this app, whose HTML embeds cells the same way and may show the same text.
    const copyId = Math.random().toString(36).slice(2, 10);
    // A merged block travels as one cell with its spans, so a report header keeps its layout in Word or
    // Excel instead of arriving as one plain cell per column. The lines the copy took are named with the
    // merges, since hidden rows and columns are skipped and a merge's span is its share of what was taken.
    // Ordinary cells already carry their line formats in `cells`; only anchored spill slots need overrides.
    const mergeLayout = copyMergeLayout(sheet.merges, rows, cols);
    const conditionalFormats = wb.copyConditionalFormats(grid.sheetId, rows, cols);
    const nativeSparklines = wb.copyNativeSparklines(grid.sheetId, rows, cols);
    const validations = wb.copyValidations(grid.sheetId, rows, cols);
    const html = cellsToHtml(texts, cells, looks, values, all ? origin : null, { styles, mergeLayout, conditionalFormats, validations, nativeSparklines, externalWorkbooks: wb.externalWorkbooks, sourceWorkbook: workbookPathUri(P.resolvedAbsolutePath?.(doc.path)), colorPalette: wb.colorPalette, normalFill: wb.nativeNormalFill, indentUnit: grid.indentUnit })
      .replace('<table', `<table data-spreadsheet-copy="${copyId}"`);
    clip = { cells, values, notes, nativeSparklines, nativePivots: wb.copyNativePivots(grid.sheetId, rows, cols), conditionalFormats, validations, merges: mergeLayout.ranges, sourceMerges: mergeLayout.sources, partialMerge: mergeLayout.partial, origin, sheetId: grid.sheetId, text: toDelimited(texts, '\t'), html, copyId, range, rows, cols, visibleOnly: !all && !multi, multi: !!multi,
      // A cut moves its cells when it is pasted, once: until then
      // nothing changes, and Escape, another copy, editing a cell, or any other
      // change to the workbook (its version moving on) turns it into a copy.
      cut: cut ? { sheetId: grid.sheetId, range, rows, cols, all, version: wb.version } : null };
    clip.threads = copyThreads(wb, grid.sheetId, rows, cols); // threaded comments come along with Paste All
    grid.setCutRange(cut ? range : null);
    return clip;
  }

  /** The cut is over (pasted, cancelled, or overtaken by another change): a paste now copies the cells, and their outline goes. */
  function endCut() {
    if (!clip?.cut) return;
    clip.cut = null;
    grid.setCutRange(null);
  }

  let pasting = false; // the paste's own changes never cancel the cut it is completing
  function disarmCutOnChange() {
    if (clip?.cut && !pasting && wb.version !== clip.cut.version) endCut();
  }

  /** Does a protected range cover one of the cells at rows × cols? Reports the first, as a refused edit would. */
  function lockedCells(sheetId, rows, cols) {
    if (wb.isProtected(sheetId)) { wb.lockedAt(sheetId, rows[0], cols[0]); return true; }
    for (const { range: locked } of wb.sheet(sheetId).protectedRanges) {
      const r = rows.find((r) => r >= locked.r1 && r <= locked.r2);
      if (r === undefined) continue;
      const c = cols.find((c) => c >= locked.c1 && c <= locked.c2);
      if (c === undefined) continue;
      wb.lockedAt(sheetId, r, c);
      return true;
    }
    return false;
  }

  /** Are two copied blocks the same cells (values, formulas and styles)? */
  function sameCells(a, b) {
    const empty = (cell) => !cell || (cell.v == null && cell.f == null && !cell.s);
    if (a.length !== b.length) return false;
    return a.every((row, i) => row.length === b[i].length && row.every((x, j) => {
      const y = b[i][j];
      return empty(x) ? empty(y) : !empty(y) && JSON.stringify(x) === JSON.stringify(y);
    }));
  }

  /**
   * Paste a cut block: its cells leave their place as they land, in one undo
   * step. Returns the destination range; null when refused; undefined when the
   * cut has gone stale (its cells changed since, or their sheet is gone), so
   * the paste falls back to a copy of what was cut.
   */
  function finishCut(sheetId, r, c, cells) {
    const from = clip.cut;
    if (!wb.sheet(from.sheetId)) return undefined;
    const now = from.all ? wb.copyRange(from.sheetId, from.range) : wb.copyCells(from.sheetId, from.rows, from.cols);
    if (!sameCells(now, cells)) return undefined;
    if (from.all) return wb.placeMoved(sheetId, r, c, cells, from);
    if (clip.partialMerge) {
      toast('Select every row and column of a merged cell to move it. Hidden rows or columns can leave part of it behind', { icon: 'merge', duration: 4000 });
      return null;
    }
    // A filtered or multi-range cut moves what was on screen as one packed
    // block; the hidden cells stay where they are.
    const limit = sheetLimits(sheetId);
    // A cut cannot discard the source cells whose destination falls off-grid.
    if (r + cells.length > limit.rows || c + cells[0].length > limit.cols) return null;
    const dst = { r1: r, c1: c, r2: r + cells.length - 1, c2: c + cells[0].length - 1 };
    if (wb.lockedIn(sheetId, dst) || lockedCells(from.sheetId, from.rows, from.cols)) return null;
    // As placeMoved: spilled values whose formula was not cut have no cell of their own to move, so they are copied.
    if (from.rows.some((rr) => from.cols.some((cc) => { const a = wb.spillAt(from.sheetId, rr, cc)?.anchor; return a && !(from.rows.includes(a.r) && from.cols.includes(a.c)); }))) return false;
    const arrays = new Map();
    for (const rr of from.rows) for (const cc of from.cols) {
      const a = wb.fixedArrayAt(from.sheetId, rr, cc);
      if (a) arrays.set(a.key, a);
    }
    const selectedRows = new Set(from.rows), selectedCols = new Set(from.cols);
    for (const a of arrays.values()) {
      for (let rr = a.r1; rr <= a.r2; rr++) if (!selectedRows.has(rr)) return false;
      for (let cc = a.c1; cc <= a.c2; cc++) if (!selectedCols.has(cc)) return false;
    }
    // As a rectangular cut, a packed cut cannot land on part of a merge.
    // Fully covered merges give way; merges leaving with this cut are exempt.
    const sourceMerges = sheetId === from.sheetId ? clip.sourceMerges || [] : [];
    const sameMerge = (a, b) => a.r1 === b.r1 && a.r2 === b.r2 && a.c1 === b.c1 && a.c2 === b.c2;
    const destinationMerges = wb.mergesIn(sheetId, dst).filter(m => !sourceMerges.some(s => sameMerge(s, m)));
    if (destinationMerges.some(m => m.r1 < dst.r1 || m.r2 > dst.r2 || m.c1 < dst.c1 || m.c2 > dst.c2)) return null;

    const clearEntries = from.rows.flatMap((rr) => from.cols.map((cc) => ({ r: rr, c: cc, cell: null })));
    // Preflight the destination before clearing cells or notes. When the
    // move overlaps itself, account for the source cells that will leave.
    if (!wb.pasteCells(sheetId, cells, r, c, clip.origin, null,
      { checkOnly: true, merges: clip.merges, clearEntries: sheetId === from.sheetId ? clearEntries : [],
        clearMerges: [...sourceMerges, ...destinationMerges] })) return null;
    return wb.transaction('Move cells', () => {
      const carried = wb.preparePackedMoveCells(from.sheetId, sheetId, from.rows, from.cols, r, c, cells);
      wb.moveConditionalFormatsFromCells(from.sheetId, sheetId, from.rows, from.cols, r, c);
      wb.setCells(from.sheetId, clearEntries, 'Move cells');
      for (const merge of clip.sourceMerges || []) wb.unmergeCells(from.sheetId, merge);
      for (const merge of destinationMerges) wb.unmergeCells(sheetId, merge);
      if (clip.notes) for (const rr of from.rows) for (const cc of from.cols) wb.setNote(from.sheetId, rr, cc, null);
      wb.pasteCells(sheetId, carried, r, c, null, null, { notes: clip.notes, merges: clip.merges });
      wb.moveNativeSparklinesFromCells(from.sheetId, sheetId, from.rows, from.cols, r, c);
      return dst;
    });
  }

  /**
   * Why a cut could not be placed at (r, c), said rather than the cut dropped in silence: the sheet's edge, or a
   * merged block the cells would land on part of (both are refused). A protected cell the workbook has named
   * itself; asking it again here only repeats a notice the throttle folds into the first.
   */
  function explainRefusedMove(sheetId, r, c, cells) {
    const dst = { r1: r, c1: c, r2: r + cells.length - 1, c2: c + cells[0].length - 1 };
    const limit = sheetLimits(sheetId);
    if (dst.r2 >= limit.rows || dst.c2 >= limit.cols) { toast('The cells cannot be moved there: they would run past the sheet', { icon: 'info', duration: 3500 }); return; }
    if (wb.lockedIn(sheetId, dst)) return;
    const inside = (m) => m.r1 >= dst.r1 && m.r2 <= dst.r2 && m.c1 >= dst.c1 && m.c2 <= dst.c2;
    if (wb.mergesIn(sheetId, dst).some((m) => !inside(m))) toast('The cells cannot be moved onto part of a merged cell. Unmerge it first, or move them elsewhere', { icon: 'info', duration: 3500 });
  }

  function copyScroll(ch) {
    const target = scrollControlTarget(wb, grid.sheetId, ch);
    const linkRef = target ? `'${wb.sheet(target.sheetId).name.replace(/'/g, "''")}'!$${colName(target.range.c1)}$${target.range.r1 + 1}` : ch.linkRef;
    return scrollControlClipboard(document, { ...ch, linkRef }, scrollControlValue(wb, grid.sheetId, ch));
  }

  function onCopyEvent(e, cut) {
    // Browser Edit > Copy and native accessibility actions can deliver a copy
    // event without the grid's keydown handler. Respect its drawing selection.
    if ((grid.selectedChart || wb.sheet(grid.sheetId)?.kind === 'chart') && document.activeElement === grid.viewport) {
      e.preventDefault();
      const control = wb.chartById(grid.sheetId, grid.selectedChart);
      if (control?.type === 'slicer' && !cut) { const data = slicerClipboard(document, control, slicerItems(wb, control), wb); e.clipboardData.setData('text/plain', data.text); e.clipboardData.setData('text/html', data.html); }
      else if (control?.type === 'scroll' && !cut) { const data = copyScroll(control); e.clipboardData.setData('text/plain', data.text); e.clipboardData.setData('text/html', data.html); }
      else if (!cut) run('copy');
      return;
    }
    if (grid.editing) return; // the textarea handles its own copy/paste
    if (document.activeElement !== grid.viewport) return;
    const c = snapshotClip(cut);
    if (!c) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', c.text);
    e.clipboardData.setData('text/html', c.html);
    statusBar?.announce(`${cut ? 'Cut' : 'Copied'} ${c.multi ? `${c.rows.length} × ${c.cols.length} cells from ${grid.ranges.length} ranges` : rangeName(c.range)}${c.visibleOnly ? ' (visible cells only)' : ''}`);
    if (c.visibleOnly) toast(`${cut ? 'Cut' : 'Copied'} the visible cells only; hidden rows and columns were skipped`, { icon: 'info', duration: 2500 });
  }

  function onPasteEvent(e) {
    // A paste into the in-cell editor: the browser inserts the text, and the entry is noted as pasted into
    // for the commit (see `entryPasted`); the cells behind the editor take nothing.
    if (grid.editing) {
      const focused = document.activeElement;
      if (grid.viewport.contains(focused) && focused.classList?.contains('grid-editor')) entryPasted = true;
      return;
    }
    if (document.activeElement !== grid.viewport) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const html = e.clipboardData?.getData('text/html') ?? '';
    // A picture on the clipboard (a screenshot, an image copied from a page)
    // lands as a floating image. Cells copied from Excel come with a picture
    // too, but also text, and the text wins. A page's "Copy image" puts an
    // <img> fragment beside the bitmap: HTML with no table in it is no cells.
    const image = !text && [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    const picture = image && (!html || !parseHtmlClipboard(html)) ? image : null;
    if (picture) {
      e.preventDefault();
      grid.consumePlainPaste();
      insertPastedImage(picture);
      return;
    }
    e.preventDefault();
    if (wb.sheet(grid.sheetId)?.kind === 'chart') { statusBar?.announce('Choose a worksheet to paste cells'); return; }
    pasteAndOffer(text, html, grid.consumePlainPaste() ? 'values' : 'all');
  }

  /** A picture from the clipboard lands as a floating image at the active cell. */
  /**
   * A picture pasted while a cell is selected floats over the cells; the Paste Options button then offers
   * it placed in the cell instead (or back over the cells), each choice the paste done again that way.
   */
  async function insertPastedImage(picture, { inCell = false } = {}) {
    replaceImageId = null;
    const file = new File([picture], picture.name || `Pasted image.${picture.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'}`, { type: picture.type });
    const from = { sheetId: grid.sheetId, active: { ...grid.active }, range: { ...grid.range } };
    const before = wb.historyTop;
    const made = await insertImageFile(file, { sheetId: from.sheetId, anchor: from.active, inCell });
    const mark = wb.historyTop;
    if (!made || !mark || mark === before || destroyed) return;
    optionButton.show({
      kind: 'paste', sheetId: from.sheetId, range: { r1: from.active.r, c1: from.active.c, r2: from.active.r, c2: from.active.c }, mark,
      items: [{ header: 'Paste Picture' }, { key: 'floating', label: 'Place over Cells', icon: 'placeOverCells' }, { key: 'cell', label: 'Place in Cell', icon: 'placeInCell' }],
      checked: made,
      onPick: (item) => {
        if (item.key === made || wb.historyTop !== mark || grid.sheetId !== from.sheetId) { optionButton.hide(); return; }
        historyMove = 'undo';
        try { wb.undo(); } finally { historyMove = 'push'; }
        grid.selectChart(null);
        grid.setSelection(S.fromRange(from.range, from.active), { scroll: false });
        insertPastedImage(picture, { inCell: item.key === 'cell' });
      },
    });
  }

  /**
   * Paste at the selection. The internal clipboard wins when the system text
   * matches what was last copied here; otherwise an HTML table (from another
   * spreadsheet app, a web page, or this app in another tab) or plain text.
   * mode: 'all' | 'values' | 'formats' | 'transpose'
   */
  /**
   * Is the clipboard's text what was copied here? Windows hands text back with
   * CRLF line ends, and a system may add one at the end; a cut read as
   * another app's text would copy its cells instead of moving them.
   */
  function sameText(text, copied) {
    if (text === copied) return true;
    const lines = (s) => s.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    return lines(text) === lines(copied);
  }

  /**
   * Is the pasted content what was last copied here? Text alone can match by
   * chance ("10" copied from another app when the copied formula showed 10):
   * HTML from elsewhere lacks the cells this app embeds in its own, and HTML
   * from another tab of this app carries that tab's copy tag, not this one's.
   */
  function isInternal(text, html) {
    if (!clip) return false;
    // The browser hands the HTML back wrapped in a document of its own, so the tag is looked for, not the whole.
    const own = (h) => h === clip.html || isOwnHtmlClipboard(h, clip.copyId);
    if (text === '') return !html || own(html);
    if (!sameText(text, clip.text)) return false;
    if (!html) return true;
    return own(html);
  }

  function applyPaste(text, options = {}) {
    if (wb.sheet(grid.sheetId)?.kind === 'chart') { statusBar?.announce('Choose a worksheet to paste cells'); return; }
    if (!oneRange('paste into')) return; // a paste lands in one range; several selected would take it in the last alone
    // Paste Special's options (what, operation, skip blanks, transpose), from an old single mode or the dialog's choices.
    const special = pasteOptions(options.paste ?? options.mode ?? (options.valuesOnly ? 'values' : 'all'));
    const mode = legacyMode(special) === 'all' ? 'all' : 'special';
    const html = options.html ?? '';
    const control = mode === 'all' && (readSlicerClipboard(document, html, wb) || readScrollControlClipboard(document, html));
    if (control) {
      const a = grid.active, id = wb.addChart(grid.sheetId, { ...control, anchor: { r: a.r, c: a.c }, anchorMode: undefined, dx: 0, dy: 0 });
      if (id) grid.selectChart(id);
      return;
    }
    const internal = isInternal(text, html);
    const label = internal && clip.cut && mode === 'all' ? 'Move cells' : pasteLabel(special);
    // The pasted block and any table expansion it triggers are one action.
    const sheetId = grid.sheetId;
    let refused = false;
    const onProtection = ({ detail }) => {
      if (['protected', 'array-edit', 'pivot-edit', 'merge-paste'].includes(detail?.type) && detail.sheetId === sheetId) refused = true;
    };
    // Use the workbook's actual refusal, which accounts for tiled pastes,
    // clipped bounds, and skipped blanks, rather than guessing from a range.
    wb.addEventListener('change', onProtection);
    pasting = true;
    try {
      return wb.transaction(label, () => applyPasteContents(text, { html, special }, () => refused, internal));
    } finally {
      pasting = false;
      wb.removeEventListener('change', onProtection);
      // A paste special of a cut copies the cells, and ends the cut so a later paste does not move them.
      if (internal && mode !== 'all') endCut();
    }
  }

  /** Is (r, c) hidden under a merge? A merged cell takes one value, at its top-left, so a paste never writes there. */
  /**
   * How many of a pasted block's values fell under a merged cell. A merge holds one value, at its top-left,
   * so the workbook writes nothing to the cells beneath it — deliberate, since e1a0f0c, rather than burying
   * values where nothing shows them — but the paste said nothing about it, so a 2×2 block dropped on a
   * merged A1:B2 kept one number and lost three without a word. `filled(i, j)` says whether the source had
   * anything at that offset in the block, so only real values are counted, and a tiled paste counts each
   * repeat. Said in the shape Merge cells uses for the values it clears.
   */
  function mergeLosses(sheetId, block, h, w, filled) {
    if (typeof filled === 'number') return filled; // a path that counted them as it wrote
    if (!filled || !wb.sheet(sheetId)?.merges.length) return 0;
    let lost = 0;
    for (let rr = block.r1; rr <= block.r2; rr++) {
      for (let cc = block.c1; cc <= block.c2; cc++) {
        if (coveredByMerge(sheetId, rr, cc) && filled((rr - block.r1) % h, (cc - block.c1) % w)) lost++;
      }
    }
    return lost;
  }

  /** Is there anything in this copied cell to lose? */
  const cellFilled = (cell) => !!cell && (cell.v != null || cell.f != null);

  function coveredByMerge(sheetId, r, c) {
    const m = wb.mergeAt(sheetId, r, c);
    return !!m && (m.r1 !== r || m.c1 !== c);
  }

  function applyPasteContents(text, { html = '', special = pasteOptions('all') } = {}, wasRefused, internal) {
    // One of the single modes the paths below carry out, or 'composed' for a combination of options.
    let mode = legacyMode(special) ?? 'composed';
    const { r, c } = { r: grid.range.r1, c: grid.range.c1 };
    const sheetId = grid.sheetId;
    const limit = sheetLimits(sheetId);
    const selectBlock = (h, w, allowTile = true, absorb = true, filled = null) => {
      if (wasRefused()) return;
      // What ran past the last row or column was dropped: say how much, rather than lose it silently.
      const rowsOut = Math.max(0, r + h - limit.rows), colsOut = Math.max(0, c + w - limit.cols);
      if (rowsOut || colsOut) {
        const count = (n, noun) => (n ? `${n} ${noun}${n === 1 ? '' : 's'}` : '');
        toast(`${[count(rowsOut, 'row'), count(colsOut, 'column')].filter(Boolean).join(' and ')} did not fit on the sheet`, { icon: 'info', duration: 3500 });
      }
      const target = grid.range;
      const th = target.r2 - target.r1 + 1;
      const tw = target.c2 - target.c1 + 1;
      const tiled = allowTile && th % h === 0 && tw % w === 0 && (th > h || tw > w);
      const block = tiled ? target : { r1: r, c1: c, r2: Math.min(r + h - 1, wb.sheet(sheetId).rows - 1), c2: Math.min(c + w - 1, wb.sheet(sheetId).cols - 1) };
      // Adjacent rows or columns pasted beside a table join it.
      if (absorb) wb.extendTableToCover(sheetId, block);
      // The cells a merge hides took nothing: say how much was left behind rather than drop it in silence.
      const lost = mergeLosses(sheetId, block, h, w, filled);
      if (lost) {
        toast(lost === 1
          ? 'Pasted. One value fell under a merged cell and was left out'
          : `Pasted. ${lost} values fell under merged cells and were left out`, { icon: 'merge', duration: 4500 });
      }
      grid.setSelection(S.fromRange(block, { r, c }), { scroll: false });
    };
    // Pasted text on several lines wraps, as lines added with Alt+Enter do, so the rows can show them all.
    const wrapMultiline = (table, target = null) => {
      if (wasRefused() || !table.some((row) => row.some((t) => typeof t === 'string' && t.includes('\n')))) return;
      const h = table.length, w = clipboardWidth(table);
      const reps = wb.pasteReps(h, w, target);
      let last = -1;
      for (let ry = 0; ry < reps.rows; ry++) for (let rx = 0; rx < reps.cols; rx++) table.forEach((row, i) => row.forEach((t, j) => {
        if (typeof t !== 'string' || !t.includes('\n') || /^=./.test(t)) return;
        const rr = r + ry * h + i, cc = c + rx * w + j;
        if (rr >= limit.rows || cc >= limit.cols || coveredByMerge(sheetId, rr, cc) || wb.styleAt(sheetId, rr, cc)?.wrap) return;
        wb.applyStyle(sheetId, { r1: rr, c1: cc, r2: rr, c2: cc }, { wrap: true });
        last = Math.max(last, rr);
      }));
      if (last >= 0) grid.autoFitRows(r, Math.min(last, r + 500));
    };
    const inserting = mode === 'insertDown' || mode === 'insertRight';
    const insertCopied = (h, w, write) => {
      const block = { r1: r, c1: c, r2: r + h - 1, c2: c + w - 1 };
      if (block.r2 >= limit.rows || block.c2 >= limit.cols) {
        toast(`The copied cells would exceed the paste limit of ${limit.rows.toLocaleString()} rows or ${limit.cols.toLocaleString()} columns`, { icon: 'info' });
        return;
      }
      const direction = mode === 'insertRight' ? 'right' : 'down';
      if (wb.lockedAfterCellInsertion(sheetId, block, direction)) return;
      let ok = false;
      wb.transaction('Insert copied cells', () => {
        ok = wb.insertCells(sheetId, block, direction, { merges: copiedMerges, cells });
        if (ok) write();
      });
      if (!ok) {
        if (!wasRefused() && !wb.isProtected(sheetId)) toast(shiftProblem(sheetId, block, direction === 'right' ? 'col' : 'row', false)
          || `The cells cannot be shifted: what is ${direction === 'right' ? 'to their right' : 'below them'} would be pushed past the edge of the sheet`, { icon: 'info', duration: 4000 });
        return;
      }
      selectBlock(h, w, false);
    };
    // Cells from another tab of this app travel inside the HTML.
    let cells = internal ? clip.cells : null;
    let origin = internal ? clip.origin : null;
    let parsed = null;
    if (!cells && html) {
      parsed = parseHtmlClipboard(html, text);
      if (parsed?.error) { toast(parsed.error, { icon: 'alert' }); return; }
      if (parsed?.cells) {
        cells = parsed.cells;
        origin = parsed.origin ?? null;
        // Any page can carry this app's cell payload: formulas in it are outside content until allowed.
        if (mode !== 'formats' && cells.some((row) => row.some((cell) => formulaReachesOut(cell?.f)))) doc.distrustExternal();
      }
    }
    const externalWorkbooks = internal ? null : parsed?.externalWorkbooks;
    // A qualified external name can itself contain a function that reaches out.
    if (externalWorkbooks?.books.some(book => book.names.some(name => formulaReachesOut(name.ref)))) doc.distrustExternal();
    const conditionalFormats = internal ? clip.conditionalFormats : parsed?.conditionalFormats;
    const nativeSparklines = internal ? clip.nativeSparklines : parsed?.nativeSparklines;
    if (!internal && nativeSparklines?.groups.some(group => formulaReachesOut(group.dateFormula) || group.sparklines.some(spark => formulaReachesOut(spark.formula)))) doc.distrustExternal();
    const validations = internal ? clip.validations : parsed?.validations;
    if (!internal && validations?.some(({ rule }) => (rule.type === 'formula' || rule.type === 'list' && isRangeSource(rule.source)) && formulaReachesOut(rule.source))) doc.distrustExternal();
    if (!internal && conditionalFormats?.some(({ rule }) => conditionalFormulaFields(rule).some(key => formulaReachesOut(rule[key])))) doc.distrustExternal();
    const copiedValues = internal ? clip.values : parsed?.values;
    const copiedMerges = internal ? clip.merges || [] : parsed?.merges || [];
    // Another app's numbers combine on the old arithmetic path, which reads them in the current locale.
    if (!cells && mode === 'composed') mode = legacyMode(special, { cells: false }) ?? 'composed';
    // Column widths travel only with cells copied in this spreadsheet, from a sheet that is still there.
    const pasteWidths = (quiet = false) => {
      if (!internal || !clip.cols) { if (!quiet) toast('Column widths can only be pasted from cells copied in this spreadsheet', { icon: 'info', duration: 3000 }); return false; }
      if (!wb.sheet(clip.sheetId)) { if (!quiet) toast('The copied cells\' sheet is gone', { icon: 'info' }); return false; }
      const n = clip.cols.length;
      wb.transaction('Paste column widths', () => {
        for (let j = 0; j < n && c + j < wb.sheet(sheetId).cols; j++) wb.setColWidth(sheetId, c + j, wb.colWidth(clip.sheetId, clip.cols[j]));
      });
      return true;
    };
    if (mode === 'composed') {
      // A combination of Paste Special's options: the copied cells (or another app's table or text, read
      // as cells) written once with every option applied, as one undo step.
      let data = null;
      if (cells) data = { cells, values: copiedValues, notes: internal ? clip.notes : null, origin, conditionalFormats, validations, merges: copiedMerges };
      else if (parsed?.rows) {
        const rows = parsed.rows, w = clipboardWidth(rows);
        const grid2 = rows.map(() => Array(w).fill(null));
        for (const { i, j, cell } of cellsFromHtmlRows(rows, undefined, { values: special.what.startsWith('values') })) grid2[i][j] = cell;
        data = { cells: grid2, values: grid2.map((row) => row.map((cell) => (cell && cell.f == null ? cell.v : null))), merges: [] };
        if (!special.what.startsWith('values') && special.what !== 'formats' && rows.some((row) => row.some(({ text, value }) => value === undefined && textReachesOut(text)))) doc.distrustExternal();
      } else if (text) {
        const rows = parseClipboard(text);
        if (!rows.length) return;
        if (special.what === 'formats') { toast('Plain text carries no formatting to paste', { icon: 'info', duration: 3000 }); return; }
        if (!special.what.startsWith('values') && rows.some((row) => row.some(textReachesOut))) doc.distrustExternal();
        data = { ...cellsFromText(rows, (t) => cellFromInput(t)), merges: [] };
      }
      if (!data) return;
      const done = composePaste(wb, sheetId, data, r, c, grid.range, special, limit);
      if (!done || wasRefused()) return;
      if (special.what === 'allWidths') pasteWidths(true);
      if (internal && special.what === 'comments' && !special.transpose) pasteThreads(wb, sheetId, clip.threads, r, c);
      const h = data.cells.length, w = clipboardWidth(data.cells);
      const filled = (i, j) => cellFilled(data.cells[i]?.[j]);
      const absorb = !['formats', 'comments', 'validation'].includes(special.what);
      if (special.transpose) selectBlock(w, h, false, absorb, done.pasted?.mergeLosses ?? ((i, j) => filled(j, i)));
      else selectBlock(h, w, true, absorb, done.pasted?.mergeLosses ?? filled);
      return;
    }
    if (mode === 'values' && copiedValues) {
      const h = copiedValues.length, w = clipboardWidth(copiedValues);
      // A selection that is a multiple of the block takes the values over and over, as a full paste does.
      const reps = wb.pasteReps(h, w, grid.range);
      const target = { r1: r, c1: c, r2: Math.min(limit.rows - 1, r + h * reps.rows - 1), c2: Math.min(limit.cols - 1, c + w * reps.cols - 1) };
      if (target.r2 < r || target.c2 < c || wb.lockedIn(sheetId, target)) return;
      wb.pasteLiteralValues(sheetId, copiedValues, r, c, grid.range);
      wrapMultiline(copiedValues, grid.range);
      selectBlock(h, w, true, true, (i, j) => { const v = copiedValues[i]?.[j]; return v != null && v !== ''; });
      return;
    }
    const OPS = ['add', 'sub', 'mul', 'div'];
    if (mode === 'widths') {
      // The widths are read from the copied cells' sheet, which may have been deleted since: a missing sheet
      // has only default widths to give, so the paste is refused, as the Links paste refuses it. The columns
      // the copy took skip hidden ones, as the copied cells do: the block's bounds would paste a hidden
      // column's zero width as a sliver between the others.
      if (pasteWidths()) selectBlock(1, clip.cols.length, false, false);
      return;
    }
    if (mode === 'link') {
      // Links: formulas that point back at the copied cells, so they follow later edits.
      if (!internal || !clip.rows) { toast('Links can only be pasted from cells copied in this spreadsheet', { icon: 'info', duration: 3000 }); return; }
      if (!wb.sheet(clip.sheetId)) { toast('The copied cells\' sheet is gone', { icon: 'info' }); return; }
      const n = wb.pasteLinks(sheetId, r, c, clip.sheetId, clip.rows, clip.cols);
      if (n) selectBlock(clip.rows.length, clip.cols.length, false);
      toast(n ? `Pasted ${n} link${n === 1 ? '' : 's'} to the copied cells` : 'No links pasted', { icon: n ? 'link' : 'info' });
      return;
    }
    if (OPS.includes(mode)) {
      let numbers;
      if (copiedValues) {
        numbers = copiedValues.map((row) => row.map((value) => typeof value === 'number' ? value : null));
      } else {
        const src = text || (internal ? clip.text : '') || (parsed?.rows ? parsed.rows.map((row) => row.map((x) => x.text).join('\t')).join('\n') : '');
        if (!src) return;
        // The text is read as typed input is, in the current locale ("1.234,5" in de-DE, "50 %", "1,5 €").
        numbers = parseClipboard(src).map((row) => row.map((t) => {
          const { v, f } = parseInput(t);
          return f == null && typeof v === 'number' ? v : null;
        }));
      }
      const changed = wb.pasteOperation(sheetId, numbers, r, c, mode);
      toast(changed ? `${{ add: 'Added to', sub: 'Subtracted from', mul: 'Multiplied', div: 'Divided' }[mode]} ${changed} cell${changed === 1 ? '' : 's'}` : 'No cells changed', { icon: changed ? 'check' : 'info' });
      if (changed) selectBlock(numbers.length, clipboardWidth(numbers), false);
      return;
    }
    if (cells) {
      const h = cells.length;
      const w = cells[0].length;
      const notes = internal ? clip.notes : null; // the notes of cells copied here come along, except with formulas only
      if (inserting) { insertCopied(h, w, () => wb.pasteCells(sheetId, cells, r, c, origin, null, { notes, merges: copiedMerges, conditionalFormats, validations, nativeSparklines, externalWorkbooks })); return; }
      if (mode === 'formats') { if (pasteClipboardStyles(sheetId, cells, r, c, grid.range, { merges: copiedMerges, conditionalFormats, externalWorkbooks })) selectBlock(h, w, true, false); return; }
      const fromCells = (i, j) => cellFilled(cells[i]?.[j]);
      if (mode === 'transpose') { const pasted = wb.pasteCells(sheetId, cells, r, c, origin, null, { transpose: true, notes, merges: copiedMerges, conditionalFormats, validations, nativeSparklines, externalWorkbooks }); selectBlock(w, h, false, true, pasted.mergeLosses ?? ((i, j) => cellFilled(cells[j]?.[i]))); return; }
      if (mode === 'formulas' || mode === 'skipBlanks') { const pasted = wb.pasteCells(sheetId, cells, r, c, origin, grid.range, { keepStyles: mode === 'formulas', skipBlanks: mode === 'skipBlanks', notes: mode === 'skipBlanks' ? notes : null, merges: mode === 'skipBlanks' ? copiedMerges : [], conditionalFormats, validations, nativeSparklines, externalWorkbooks }); selectBlock(h, w, true, true, pasted.mergeLosses ?? fromCells); return; }
      if (mode === 'values') {
        // Values only: what the cells showed, retyped from the plain text.
        const src = text || (internal ? clip.text : '');
        const texts = src ? parseClipboard(src) : cells.map((row) => row.map((cell) => (cell && cell.f == null ? formatValue(cell.v, cell.s) : '')));
        wb.pasteValues(sheetId, texts, r, c, grid.range);
        wrapMultiline(texts, grid.range);
        selectBlock(texts.length, clipboardWidth(texts), true, true, (i, j) => (texts[i]?.[j] ?? '') !== '');
        return;
      }
      if (internal && clip.cut && mode === 'all') {
        // Cut then paste moves the cells: formulas that pointed at them follow, and theirs keep their targets.
        const moved = finishCut(sheetId, r, c, cells);
        if (moved === null) { explainRefusedMove(sheetId, r, c, cells); return; }
        endCut();
        if (moved) { selectBlock(h, w, false); return; }
        // The cut went stale, or took part of an array without its formula: what was cut is pasted as a copy.
        if (moved === false) toast('Copied instead of moved: the cut cells are part of an array whose formula stays where it is', { icon: 'info', duration: 4000 });
      }
      const pasted = wb.pasteCells(sheetId, cells, r, c, origin, grid.range, { notes, merges: copiedMerges, conditionalFormats, validations, nativeSparklines, externalWorkbooks, nativePivots: internal ? clip.nativePivots : null });
      if (internal && mode === 'all') pasteThreads(wb, sheetId, clip.threads, r, c);
      // A copied report remains its own object beside a table, rather than
      // joining that table through the ordinary adjacent-cell expansion.
      selectBlock(h, w, true, !(internal && clip.nativePivots), pasted.mergeLosses ?? fromCells);
      return;
    }
    if (parsed?.rows) {
      const rows = parsed.rows;
      const w = clipboardWidth(rows);
      // A table cell reading "=IMPORTDATA(...)" becomes that formula: outside content until allowed.
      if (mode !== 'formats' && mode !== 'values' && rows.some((row) => row.some(({ text, value }) => value === undefined && textReachesOut(text)))) doc.distrustExternal();
      if (inserting) {
        insertCopied(rows.length, w, () => wb.pasteEntries(sheetId,
          cellsFromHtmlRows(rows).map(({ i, j, cell }) => ({ r: r + i, c: c + j, cell })),
          { merges: copiedMerges, rows: rows.length, cols: w, r, c }));
        return;
      }
      if (mode === 'formats') {
        const styled = rows.map((row) => row.map(({ style }) => ({ v: null, f: null, s: style })));
        if (pasteClipboardStyles(sheetId, styled, r, c, grid.range, { merges: copiedMerges, conditionalFormats, externalWorkbooks })) selectBlock(rows.length, w, true, false);
        return;
      }
      const transposed = mode === 'transpose';
      const keepStyles = mode === 'values' || mode === 'formulas';
      const withMerges = copiedMerges.length && (mode === 'all' || transposed || mode === 'skipBlanks');
      // The table repeats across a selection that is a multiple of it, as a block copied here would.
      const reps = transposed ? { rows: 1, cols: 1 } : wb.pasteReps(rows.length, w, grid.range);
      // Formulas only keeps the formatting already at the destination: the table's own is left out.
      const source = mode === 'formulas' ? rows.map((row) => row.map(({ style, ...cell }) => cell)) : rows;
      const entries = [];
      let hiddenByMerge = 0; // values a merge left no room for, counted as they are passed over
      for (let ry = 0; ry < reps.rows; ry++) {
        for (let rx = 0; rx < reps.cols; rx++) {
          const r0 = r + ry * rows.length;
          const c0 = c + rx * w;
          // Values only writes what the table showed: no HYPERLINK formula for a link and no formula from text that reads as one.
          // A full HTML paste parses in the source format; destination formats
          // participate only when the selected paste mode keeps them.
          const destinationStyle = keepStyles ? (i, j) => wb.styleAt(sheetId, r0 + (transposed ? j : i), c0 + (transposed ? i : j)) : undefined;
          for (const { i, j, cell } of cellsFromHtmlRows(source, destinationStyle, { values: mode === 'values' })) {
            const e = transposed ? { r: r0 + j, c: c0 + i, cell } : { r: r0 + i, c: c0 + j, cell };
            if (e.r >= limit.rows || e.c >= limit.cols || !withMerges && coveredByMerge(sheetId, e.r, e.c)) {
              if (e.r < limit.rows && e.c < limit.cols && cellFilled(e.cell)) hiddenByMerge++;
              continue;
            }
            if (mode === 'skipBlanks' && e.cell?.v == null && e.cell?.f == null) continue;
            if (mode === 'values' && e.cell) {
              const s = wb.styleAt(sheetId, e.r, e.c);
              e.cell = { v: e.cell.v, f: e.cell.f, s: e.cell.s?.wrap && !s?.wrap ? { ...(s || {}), wrap: true } : s };
            }
            entries.push(e);
          }
        }
      }
      const pasted = wb.pasteEntries(sheetId, entries, { merges: mode === 'all' || mode === 'transpose' || mode === 'skipBlanks' ? copiedMerges : [],
        rows: rows.length, cols: w, r, c, target: grid.range, transpose: transposed, keepStyles });
      if (transposed) selectBlock(w, rows.length, false, true, pasted?.mergeLosses ?? hiddenByMerge); else selectBlock(rows.length, w, true, true, pasted?.mergeLosses ?? hiddenByMerge);
      return;
    }
    if (!text) return;
    const rows = parseClipboard(text);
    if (!rows.length) return;
    // Formatting only from another app's plain text: there is none to paste, which is said rather than nothing happening.
    if (mode === 'formats') { toast('Plain text carries no formatting to paste', { icon: 'info', duration: 3000 }); return; }
    // Pasted text that reads as a reaching formula is outside content too.
    if (rows.some((row) => row.some(textReachesOut))) doc.distrustExternal();
    if (inserting) { insertCopied(rows.length, clipboardWidth(rows), () => wb.pasteValues(sheetId, rows, r, c)); return; }
    if (mode === 'skipBlanks') {
      // Plain text: write only the non-empty cells.
      const entries = [];
      rows.forEach((row, i) => row.forEach((t, j) => { if (t !== '' && r + i < limit.rows && c + j < limit.cols && !coveredByMerge(sheetId, r + i, c + j)) entries.push({ r: r + i, c: c + j, cell: cellFromInput(t, wb.styleAt(sheetId, r + i, c + j)) }); }));
      wb.setCellsWithTableHeaders(sheetId, entries, 'Paste');
      wrapMultiline(rows);
      selectBlock(rows.length, clipboardWidth(rows), false, true, (i, j) => (rows[i]?.[j] ?? '') !== '');
      return;
    }
    const transposed = mode === 'transpose';
    const table = transposed ? Array.from({ length: clipboardWidth(rows) }, (_, j) => rows.map((row) => row[j] ?? '')) : rows;
    // Text from another app fills a selection that is a multiple of it, as cells copied here do.
    wb.pasteValues(sheetId, table, r, c, transposed ? null : grid.range);
    wrapMultiline(table, transposed ? null : grid.range);
    selectBlock(table.length, clipboardWidth(table), !transposed, true, (i, j) => (table[i]?.[j] ?? '') !== '');
  }

  async function copyToClipboard(cut) {
    if (grid.editing) { document.execCommand?.(cut ? 'cut' : 'copy'); return; }
    const c = snapshotClip(cut);
    if (!c) return;
    // Return focus before the clipboard permission/write can wait. A late
    // completion must not interrupt an edit or control focused meanwhile.
    grid.focus();
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([c.text], { type: 'text/plain' }), 'text/html': new Blob([c.html], { type: 'text/html' }) })]);
      } else await navigator.clipboard?.writeText(c.text);
    } catch { /* internal clipboard still works */ }
    if (destroyed) return;
    toast(cut ? 'Cut. The cells move when you paste them' : 'Copied', { icon: cut ? 'cut' : 'copy', duration: cut ? 2200 : 1200 });
  }

  /** The Paste Special dialog over what the clipboard holds; another app's content greys what it cannot carry. */
  async function openPasteSpecial() {
    if (grid.editing) return;
    if (wb.sheet(grid.sheetId)?.kind === 'chart') { statusBar?.announce('Choose a worksheet to paste cells'); return; }
    if (!oneRange('paste into')) return;
    const read = await readClipboard();
    if (!read) return;
    if (read.picture) { insertPastedImage(read.picture); return; }
    const external = !isInternal(read.text, read.html);
    const go = (paste) => { pasteAndOffer(read.text, read.html, paste); grid.focus(); };
    openPasteSpecialDialog({ external, onPaste: go, onPasteLink: () => go({ link: true }), onClose: () => keepFocus() });
  }

  /**
   * What the clipboard holds: { text, html, picture }, or null (after saying so) when the read went stale
   * because the sheet or selection changed while it waited, or there is nothing to paste.
   */
  async function readClipboard() {
    const target = { sheetId: grid.sheetId, range: { ...grid.range }, version: wb.version };
    let text = null;
    let html = '';
    let picture = null;
    // A clipboard read that waits on a permission prompt must not stall the
    // paste: after a moment, fall back to what was last copied here.
    const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 1200));
    try {
      if (navigator.clipboard?.read) {
        const items = await Promise.race([navigator.clipboard.read(), timeout]);
        let pictureOf = null;
        for (const item of items || []) {
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          const image = item.types.find((type) => type.startsWith('image/'));
          if (image) pictureOf = () => item.getType(image);
        }
        if (items && text == null) text = '';
        // A picture (a screenshot, an image copied from a page) is pasted as one, as the shortcut does:
        // with no text, and no HTML or HTML that holds no table (a page's "Copy image" brings an <img>
        // fragment). Cells copied from Excel come with a picture too, which is never read; the text wins.
        if (pictureOf && !text && (!html || !parseHtmlClipboard(html))) picture = await pictureOf();
      } else text = (await Promise.race([navigator.clipboard?.readText(), timeout])) ?? null;
    } catch { text = null; }
    if (destroyed) return null;
    // A clipboard permission prompt or slow read can outlive the selection.
    // Never overwrite cells the user moved to or edited while it was pending.
    if (grid.editing || grid.sheetId !== target.sheetId || wb.version !== target.version
      || ['r1', 'c1', 'r2', 'c2'].some((key) => grid.range[key] !== target.range[key])) {
      toast('The sheet or selection changed. Paste again where you want the data', { icon: 'info', duration: 3500 });
      return null;
    }
    if (picture) return { text: '', html: '', picture };
    if (text == null) {
      if (!clip) { toast('Nothing to paste. Use the keyboard shortcut to paste from other apps', { icon: 'info' }); return null; }
      text = '';
    }
    return { text, html, picture: null };
  }

  async function pasteFromClipboard({ valuesOnly = false, mode = null, paste = null } = {}) {
    if (grid.editing) { document.execCommand?.('paste'); return; }
    if (!oneRange('paste into')) return; // said before the clipboard is read, which can wait on a permission prompt
    // Paste Special ▸ Picture and Linked Picture: a picture of the cells copied here.
    if (paste?.picture) {
      if (!clip || clip.cut || clip.multi || !wb.sheet(clip.sheetId)) { toast('Copy a range of cells first, then paste it as a picture', { icon: 'info', duration: 3000 }); keepFocus(); return; }
      pictures.run('pastePicture', { linked: paste.picture === 'linked', source: { sheetId: clip.sheetId, range: clip.range } });
      return;
    }
    const read = await readClipboard();
    if (!read) return;
    if (read.picture) { insertPastedImage(read.picture); return; }
    pasteAndOffer(read.text, read.html, paste ?? mode ?? (valuesOnly ? 'values' : 'all'));
    grid.focus();
  }

  /**
   * Paste, then offer the Paste Options button at the pasted block's corner, which pastes the same
   * clipboard again another way (see repasteWith). Nothing is offered after a move (a cut pasted) or a
   * paste that changed nothing.
   */
  function pasteAndOffer(text, html, paste) {
    const before = wb.historyTop;
    const from = { sheetId: grid.sheetId, range: { ...grid.range }, active: { ...grid.active } };
    const internal = isInternal(text, html);
    const moving = internal && clip.cut && legacyMode(pasteOptions(paste)) === 'all';
    applyPaste(text, { html, paste });
    const mark = wb.historyTop;
    if (moving || !mark || mark === before) { optionButton.hide(); return; }
    lastPaste = { text, html, paste: pasteOptions(paste), from, mark, external: !internal };
    if (!appOption('pasteOptionsButton')) { optionButton.hide(); return; } // turned off in the options
    optionButton.show({
      kind: 'paste', sheetId: grid.sheetId, range: { ...grid.range }, mark,
      // The pictures of the cells are pastes of their own, not another way of pasting these cells.
      items: pasteGallery({ external: !internal }).filter((item) => !item.paste?.picture).map((item) => (item.header ? item : { ...item, key: JSON.stringify(pasteOptions(item.paste)) })),
      checked: JSON.stringify(lastPaste.paste),
      onPick: (item) => repasteWith(item.paste),
    });
  }

  /** The Paste Options button's choice: the last paste undone and done again with these options, as one step. */
  function repasteWith(paste) {
    const last = lastPaste;
    if (!last || wb.historyTop !== last.mark || grid.editing || grid.sheetId !== last.from.sheetId) { optionButton.hide(); return; }
    historyMove = 'undo';
    try { wb.undo(); } finally { historyMove = 'push'; }
    grid.setSelection(S.fromRange(last.from.range, last.from.active), { scroll: false });
    pasteAndOffer(last.text, last.html, paste);
    grid.focus();
  }

  /**
   * What Flash Fill would write in column `c` around row `r`: the examples typed in the column teach the pattern
   * from the cells beside them. { entries, examples, rows }: the cells to fill, how many examples taught it, and
   * the rows looked at ({ r, target }).
   */
  function flashFillPlan(sheetId, r, c) {
    const region = wb.dataRegion(sheetId, r, c) || { r1: r, c1: c, r2: r, c2: c };
    const area = { r1: region.r1, r2: region.r2, c1: Math.min(region.c1, c - 1 >= 0 ? c - 1 : c), c2: Math.max(region.c2, c) };
    const cols = [];
    for (let cc = area.c1; cc <= area.c2; cc++) if (cc !== c) cols.push(cc);
    const shown = (rr, cc) => { const v = wb.getValue(sheetId, rr, cc); return v == null || (typeof v === 'object') ? null : wb.getDisplay(sheetId, rr, cc); };
    const rows = [];
    for (let rr = area.r1; rr <= area.r2; rr++) {
      const target = wb.getCell(sheetId, rr, c);
      rows.push({ r: rr, sources: cols.map((cc) => shown(rr, cc)), target: target?.v != null || target?.f != null ? shown(rr, c) : null });
    }
    // A header above the examples fits no pattern: try again without the first row before giving up.
    let filled = flashFill(rows), from = 0;
    if (!filled && rows.length > 1) { filled = flashFill(rows.slice(1)); from = 1; }
    const entries = [];
    if (filled) filled.forEach((text, i) => { const row = rows[i + from]; if (text != null && text !== '' && row.sources.some((v) => v != null)) entries.push({ r: row.r, c, cell: { v: text, f: null, s: wb.getCell(sheetId, row.r, c)?.s } }); });
    return { entries, examples: filled ? rows.slice(from).filter((row) => row.target != null && row.target !== '').length : 0, rows: rows.slice(from) };
  }

  /**
   * Flash Fill as you type (the options): once a second example in a row follows a pattern from the cells beside
   * it, and the column below is still empty, a notice offers to fill the rest the same way.
   */
  let flashOffer = null;
  function offerFlashFill(sheetId, r, c) {
    flashOffer?.dismiss?.();
    flashOffer = null;
    if (!appOption('autoFlashFill') || grid.sheetId !== sheetId || r < 1) return;
    const above = wb.getCell(sheetId, r - 1, c);
    if (above?.v == null || above.f != null || typeof wb.getValue(sheetId, r, c) !== 'string') return;
    const { entries, examples, rows } = flashFillPlan(sheetId, r, c);
    // The examples must be the column's first entries, the one just typed the last of them, with only blanks below.
    const typed = rows.filter((row) => row.target != null && row.target !== '').map((row) => row.r);
    if (examples < 2 || !entries.length || typed.at(-1) !== r || typed.some((rr, i) => i && rr !== typed[i - 1] + 1) || entries.some((e) => e.r < r)) return;
    const mark = wb.historyTop;
    flashOffer = toast(`Flash Fill can fill ${entries.length} more cell${entries.length === 1 ? '' : 's'} in this column the same way`, {
      icon: 'flashFill', duration: 8000,
      action: { label: 'Fill', onClick: () => {
        // Only while the sheet is as it was when offered: an edit since may have changed the pattern.
        if (destroyed || wb.historyTop !== mark || grid.editing) return;
        if (wb.setCells(sheetId, entries, 'Flash Fill')) statusBar?.announce(`Flash Fill changed ${entries.length} cells`);
        keepFocus();
      } },
    });
  }

  /** After a fill-handle drag: the Auto Fill Options button, to fill the same cells again another way. */
  function offerAutoFill({ source, target, inverted = false }, kind = null) {
    const mark = wb.historyTop;
    if (!mark) return;
    const sheetId = grid.sheetId;
    lastFill = { sheetId, source: normalizeRange(source), target: normalizeRange(target), mark, kind: kind || defaultAutoFill(wb, sheetId, source, target, inverted) };
    if (!appOption('fillOptionsButton')) { optionButton.hide(); return; } // turned off in the options
    optionButton.show({
      kind: 'fill', sheetId, range: lastFill.target, mark,
      items: autoFillChoices(wb, sheetId, source, target).map(([key, label]) => ({ key, label })),
      checked: lastFill.kind,
      onPick: (item) => refillWith(item.key),
    });
  }

  /** The Auto Fill Options button's choice: the fill undone and done again that way, as one step. */
  function refillWith(kind) {
    const last = lastFill;
    if (!last || wb.historyTop !== last.mark || grid.editing || grid.sheetId !== last.sheetId) { optionButton.hide(); return; }
    historyMove = 'undo';
    try { wb.undo(); } finally { historyMove = 'push'; }
    const { sheetId, source, target } = last;
    if (kind === 'flash') {
      // Flash Fill learns from the cells dragged from and fills the rest of their column.
      const below = target.r2 > source.r2;
      grid.setSelection(S.fromRange(target, { r: below ? source.r2 + 1 : target.r1, c: source.c1 }), { scroll: false });
      run('flashFill');
    } else {
      refill(wb, sheetId, source, target, kind);
      grid.setSelection(S.fromRange(target, { r: source.r1, c: source.c1 }), { scroll: false });
    }
    if (wb.historyTop && wb.historyTop !== last.mark) offerAutoFill({ source, target }, kind);
    grid.focus();
  }

  /**
   * Home ▸ Fill ▸ Justify: the text in the selection's first column, rejoined and broken again into lines
   * as wide as the selected columns, one line a cell down the column. A blank cell keeps paragraphs apart.
   */
  function fillJustify() {
    const sheetId = grid.sheetId;
    const range = grid.range;
    const c = range.c1;
    let last = range.r2;
    // One row selected takes the text from there down to the first blank.
    if (range.r1 === range.r2) while (last + 1 < sheetLimits(sheetId).rows && wb.getCell(sheetId, last + 1, c)?.v != null) last++;
    const texts = [];
    for (let r = range.r1; r <= last; r++) {
      const cell = wb.getCell(sheetId, r, c);
      if (cell?.f != null || (cell?.v != null && typeof cell.v !== 'string')) {
        toast('Justify works on text only: the cells hold numbers or formulas', { icon: 'info', duration: 3500 });
        return;
      }
      texts.push(cell?.v ?? null);
    }
    if (!texts.some((t) => t != null && String(t).trim())) { toast('There is no text to justify in the selected column', { icon: 'info' }); return; }
    let width = 0;
    for (let cc = range.c1; cc <= range.c2; cc++) width += wb.colWidth(sheetId, cc);
    const style = wb.styleAt(sheetId, range.r1, c);
    const canvas = document.createElement('canvas').getContext('2d');
    const css = getComputedStyle(grid.el);
    const baseSize = parseFloat(css.getPropertyValue('--grid-font-size')) || 13;
    canvas.font = `${style?.italic ? 'italic ' : ''}${style?.bold ? '600 ' : ''}${style?.size || baseSize}px ${fontStack(style?.font) || css.fontFamily || 'system-ui'}`;
    const lines = justifyLines(texts, Math.max(10, width - 8), (t) => canvas.measureText(t).width);
    const end = Math.max(last, range.r1 + lines.length - 1);
    if (range.r1 !== range.r2 && lines.length > range.r2 - range.r1 + 1) toast('The text runs below the selected range', { icon: 'info', duration: 3000 });
    const entries = [];
    for (let r = range.r1; r <= end; r++) {
      const prev = wb.getCell(sheetId, r, c);
      const text = lines[r - range.r1] ?? '';
      entries.push({ r, c, cell: { ...(prev || {}), v: text === '' ? null : text, f: null } });
    }
    if (wb.lockedIn(sheetId, { r1: range.r1, c1: c, r2: end, c2: c })) return;
    wb.setCellsWithTableHeaders(sheetId, entries, 'Justify');
    grid.setSelection(S.fromRange({ r1: range.r1, c1: range.c1, r2: range.r1 + Math.max(0, lines.length - 1), c2: range.c2 }, { r: range.r1, c: range.c1 }), { scroll: false });
  }

  /* ---------- Functions ---------- */

  const COMMON_FUNCTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'IF', 'SUMIF', 'COUNTIF', 'VLOOKUP', 'XLOOKUP', 'ROUND', 'TODAY', 'CONCAT', 'IFERROR'];

  function openFunctionMenu(anchor) {
    const search = el('input.input', { type: 'search', placeholder: 'Search functions', 'aria-label': 'Search functions', autocomplete: 'off' });
    const listEl = el('div.fn-list', { role: 'group' });
    const render = () => {
      const q = search.value.trim().toUpperCase();
      const names = q ? FUNCTION_NAMES.filter((n) => n.includes(q)) : COMMON_FUNCTIONS;
      listEl.replaceChildren(...[
        !q && P.canAI() && el('button.menu-item.fn-item', {
          type: 'button', role: 'menuitem', tabindex: -1, onclick: () => { menu.close(); run('aiFormula'); },
        }, el('span.menu-icon', { html: icon('sparkle', 16) }), el('span.menu-label', {}, el('span.fn-name', {}, 'Write a formula with AI…'), el('span.fn-desc', {}, 'Describe what to calculate; the sheet\'s headers and tables are explained to the AI'))),
        !q && el('div.menu-header', {}, 'Common'),
        ...names.slice(0, 40).map((n) => el('button.menu-item.fn-item', {
          type: 'button', role: 'menuitem', tabindex: -1, title: signatureFor(n).params ? `${n}(${signatureFor(n).params})` : n,
          onclick: () => { menu.close(); insertFunction(n); },
        }, el('span.menu-icon', { html: icon('fx', 16) }), el('span.menu-label', {}, el('span.fn-name', {}, n), signatureFor(n).description && el('span.fn-desc', {}, signatureFor(n).description)))),
        !names.length && el('div.menu-header', {}, 'No matches'),
        el('div.menu-sep', { role: 'separator' }),
        el('button.menu-item.fn-item', { type: 'button', role: 'menuitem', tabindex: -1, onclick: () => { menu.close(); run('insertFunctionDialog'); } },
          el('span.menu-icon', { html: icon('fx', 16) }), el('span.menu-label', {}, el('span.fn-name', {}, 'More functions…'), el('span.fn-desc', {}, 'Browse every function by category, then fill in its arguments'))),
      ].filter(Boolean)); // replaceChildren would print a bare `false`
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); listEl.querySelector('button')?.focus(); }
      if (e.key === 'Enter') { e.preventDefault(); listEl.querySelector('button')?.click(); }
    });
    render();
    const menu = openMenu({
      anchor: anchor || formulaBar.el.querySelector('.fx-btn'), label: 'Insert function', minWidth: 260,
      items: [{ custom: el('div.fn-search', {}, search) }, { custom: listEl }],
      onClose: () => keepFocus(),
    });
    setTimeout(() => search.focus(), 0);
  }

  /** Insert =NAME( with a guessed range for the aggregate functions. */
  function insertFunction(name) {
    rememberFunction(name);
    const aggregate = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'MEDIAN', 'PRODUCT'].includes(name);
    if (grid.editing) {
      grid.insertText(`${name}(`);
      return;
    }
    // An aggregate over a Ctrl/Cmd+click selection of several ranges has no one range to add up and no one
    // place for the result: refused with a word, rather than the last range added summed in silence.
    if (aggregate && !S.isSingle(grid.selection) && !oneRange('insert a function')) return;
    const { r, c } = grid.active;
    let guess = '';
    if (aggregate && !S.isSingle(grid.selection)) {
      guess = rangeName(grid.range);
    } else if (aggregate) {
      const isNum = (rr, cc) => typeof wb.getValue(grid.sheetId, rr, cc) === 'number';
      let rr = r - 1;
      while (rr >= 0 && isNum(rr, c)) rr--;
      if (rr < r - 1) guess = rangeName({ r1: rr + 1, c1: c, r2: r - 1, c2: c });
      else {
        let cc = c - 1;
        while (cc >= 0 && isNum(r, cc)) cc--;
        if (cc < c - 1) guess = rangeName({ r1: r, c1: cc + 1, r2: r, c2: c - 1 });
      }
    }
    if (!S.isSingle(grid.selection) && aggregate) {
      // With a range selected, the result goes beside it: right of a single
      // row, otherwise under the last cell with content in the selected
      // columns (a whole column would put it past the end of the sheet).
      const range = grid.range;
      const acrossRow = range.r1 === range.r2;
      const last = lastUsedLine(range, acrossRow ? 'col' : 'row');
      let arg = range;
      let target;
      if (acrossRow) {
        const c = last == null ? range.c2 + 1 : Math.min(last + 1, range.c2 + 1);
        if (c <= range.c2) arg = { ...range, c2: c - 1 };
        target = { r: range.r1, c };
      } else {
        const r = last == null ? range.r2 + 1 : Math.min(last + 1, range.r2 + 1);
        if (r <= range.r2) arg = { ...range, r2: r - 1 };
        target = { r, c: range.c1 };
      }
      if (!wb.canEnsureSize(grid.sheetId, target.r + 1, target.c + 1)) { toast('There is no room beside the selection for the result', { icon: 'info' }); return; }
      guess = rangeName(arg);
      const existing = wb.getCell(grid.sheetId, target.r, target.c);
      if (!existing || (existing.v == null && existing.f == null)) {
        // A protected cell: the workbook says so and would refuse the formula, so the selection stays where it is.
        if (wb.lockedAt(grid.sheetId, target.r, target.c)) return;
        const text = `=${name}(${guess})`;
        if (!allowedByRule(wb.validateInput(grid.sheetId, target.r, target.c, text))) return;
        wb.setInput(grid.sheetId, target.r, target.c, text);
        grid.setSelection(S.single(target.r, target.c));
        grid.focus();
        return;
      }
      // Something is there already: offer the formula for editing instead of writing over it.
      grid.setSelection(S.single(target.r, target.c));
    }
    grid.beginEdit({ text: `=${name}(${guess}${guess ? ')' : ''}`, mode: 'inplace' });
    if (guess) {
      // Leave the caret inside the parentheses so the range can be adjusted.
      const ta = grid.el.querySelector('.grid-editor');
      const pos = `=${name}(`.length;
      ta?.setSelectionRange(pos, pos + guess.length);
    }
  }

  /** The last row (or column) inside `range` holding a value or formula, or null when the range is empty. */
  function lastUsedLine(range, axis) {
    let last = null;
    for (const [key, cell] of wb.sheet(grid.sheetId).cells) {
      if (cell.v == null && cell.f == null) continue;
      const i = key.indexOf(',');
      const r = Number(key.slice(0, i));
      const c = Number(key.slice(i + 1));
      if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
      const line = axis === 'row' ? r : c;
      if (last == null || line > last) last = line;
    }
    return last;
  }

  /* ---------- File ---------- */

  // "Leave without saving" was chosen: the navigation that follows flushes
  // again (the router does), and must not ask a second time. Any new edit
  // makes the question worth asking again.
  let abandoned = false;
  // The flush under way: a second caller (the router flushes again on the way
  // out) waits for its answer rather than saving and asking a second time.
  let flushing = null;
  // While a flush on the way out saves, a conflict its save raises (the kind, once raised) is answered
  // in the leave dialog, which can also leave, rather than in the conflict dialog, which cannot.
  let leavingSave = null;
  /**
   * Save before the document is left (or, with leaving false, before an
   * operation that needs the file). True when it is safe to go on.
   */
  function flush(opts) {
    if (!flushing) flushing = runFlush(opts).finally(() => { flushing = null; });
    return flushing;
  }

  async function runFlush({ leaving = true } = {}) {
    if (grid.editing && !grid.commitEdit()) return false;
    if (doc.status === 'saved' && !doc.hasPendingWrites) return true;
    doc.writeDraft();
    if (session.signedOut && wb.dirty) {
      if (abandoned) return true;
      // Nowhere to write without a session: keep editing, leave the edits to
      // the local draft, or sign in so the save below can go through.
      const choice = leaveDialog ? await leaveDialog() : 'stay';
      if (destroyed) return false;
      // The dialog handed focus back to the button that opened it; editing continues in the grid.
      if (choice === 'stay') { keepFocus(); return false; }
      if (choice === 'leave') { abandoned = true; return true; }
      if (!await session.signIn() || destroyed) return false;
      if (grid.editing && !grid.commitEdit()) return false;
    }
    // This flush's own marker: "Overwrite with mine" and "Try again" run another flush, which installs
    // one of its own, and this one must leave that in place on the way out — cleared, the conflict that
    // flush's save raises lands in the dialog that cannot leave, after the navigation was already refused.
    const mine = leaving ? { kind: null } : null;
    try {
      if (leaving) leavingSave = mine;
      let saved = await doc.save();
      while (saved) {
        // A save can finish while a new entry is still in the cell editor.
        // Commit and validate that entry before deciding navigation is safe.
        if (grid.editing && !grid.commitEdit()) return false;
        if (!wb.dirty) break;
        saved = await doc.save();
      }
      // The file is not as this document last saw it (changed, moved or deleted elsewhere, or not to be
      // checked), so the save asked instead of writing. That must not keep the user here: the draft
      // written above holds the edits on this device, so leaving is offered along with overwriting.
      const kind = leavingSave?.kind;
      if (!saved && kind && doc.status === 'conflict') {
        if (abandoned) return true;
        const kept = !wb.dirty || doc.writeDraft();
        const choice = await conflictLeaveDialog(kind, kept);
        if (destroyed) return false;
        if (choice === 'leave') { abandoned = true; return true; }
        if (choice === 'overwrite') { await doc.forceSave().catch(() => {}); return runFlush({ leaving }); }
        keepFocus();
        return false;
      }
      return saved;
    } catch (e) {
      if (destroyed) return false;
      if (!leaving) { toast('Could not save to Puter. Your changes are still open', { icon: 'alert', duration: 5000 }); return false; }
      // Puter would not take the save (offline, out of space). The draft
      // written above keeps the edits on this device, so a save that keeps
      // failing must not keep the user in the editor for ever.
      if (abandoned) return true;
      const kept = !wb.dirty || doc.writeDraft();
      const choice = await saveFailedDialog(e?.message, kept);
      if (destroyed) return false;
      if (choice === 'retry') return runFlush({ leaving });
      if (choice === 'leave') { abandoned = true; return true; }
      keepFocus();
      return false;
    } finally { if (leavingSave === mine) leavingSave = null; }
  }

  /**
   * The save on the way out found the file changed elsewhere, moved or deleted, or not to be checked: leave
   * (the local draft keeps the edits, to be offered again), keep editing, or write this version over what is there.
   */
  function conflictLeaveDialog(kind, kept) {
    return new Promise((resolve) => {
      const missing = kind === 'missing';
      const unchecked = kind === 'unchecked';
      const what = missing ? `"${doc.name}" is no longer at ${doc.path}: it was deleted, or moved where it cannot be followed.`
        : unchecked ? `Whether "${doc.name}" was saved since you opened it, perhaps from another device or tab, could not be checked.`
          : `"${doc.name}" was saved, moved or renamed since you opened it, perhaps from another device or tab.`;
      const where = missing ? 'and can be recovered from Unsaved spreadsheets on the home screen' : 'and are offered again when you open this spreadsheet here';
      const action = missing ? 'put the file back at the old address with them' : unchecked ? 'save them anyway' : 'keep your version and overwrite theirs';
      const content = el('div', {},
        el('p.modal-text', {}, kept
          ? `${what} Your changes were not saved. Leave, and they stay on this device, ${where}; or ${action}.`
          : `${what} Your changes were not saved, and this browser could not keep a copy of them either. Leaving now discards them.`),
        el('div.row.row-end', { style: { flexWrap: 'wrap' } },
          el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Keep editing'),
          el(`button.btn${kept ? '' : '.btn-danger'}`, { type: 'button', onclick: () => { resolve('leave'); modal.close(); } }, kept ? 'Leave' : 'Leave without saving'),
          el(`button.btn${missing || unchecked ? '.btn-primary' : '.btn-danger'}`, { type: 'button', onclick: () => { resolve('overwrite'); modal.close(); } }, missing ? 'Keep it here' : unchecked ? 'Save anyway' : 'Overwrite with mine')));
      const modal = openModal({ title: missing ? 'This file was moved or deleted' : unchecked ? 'This file could not be checked' : 'This file changed elsewhere', content, onClose: () => resolve('stay') });
    });
  }

  /** The save failed on the way out: leave (the local draft keeps the edits), keep editing, or try again. */
  function saveFailedDialog(reason, kept) {
    return new Promise((resolve) => {
      const why = reason ? ` (${String(reason).replace(/\.$/, '')})` : '';
      const content = el('div', {},
        el('p.modal-text', {}, kept
          ? `Puter could not save this spreadsheet${why}. Your changes are kept in this browser, and saving is offered again when you open it here.`
          : `Puter could not save this spreadsheet${why}, and this browser could not keep a copy of your changes either. Leaving now discards them.`),
        el('div.row.row-end', { style: { flexWrap: 'wrap' } },
          el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Keep editing'),
          el(`button.btn${kept ? '' : '.btn-danger'}`, { type: 'button', onclick: () => { resolve('leave'); modal.close(); } }, kept ? 'Leave' : 'Leave without saving'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve('retry'); modal.close(); } }, 'Retry')));
      const modal = openModal({ title: 'Could not save', content, onClose: () => resolve('stay') });
    });
  }

  /** The open file is not where it was: save the edits as a new file, put the file back at its old address, or keep working (the local draft holds the edits). */
  function missingFileDialog() {
    return new Promise((resolve) => {
      const content = el('div', {},
        el('p.modal-text', {}, `"${doc.name}" is no longer at ${doc.path}: it was deleted, or moved where it cannot be followed. Your changes are still here, and can be saved as a new file or put back at the old address.`),
        el('div.row.row-end', { style: { flexWrap: 'wrap' } },
          el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Keep editing'),
          el('button.btn', { type: 'button', onclick: () => { resolve('keep'); modal.close(); } }, 'Keep it here'),
          el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve('saveAs'); modal.close(); } }, 'Save as new file')));
      const modal = openModal({ title: 'This file was moved or deleted', content, onClose: () => resolve('stay') });
    });
  }

  async function saveNow() {
    if (grid.editing && !grid.commitEdit()) return;
    // Saving needs a session; Puter's own dialog asks for it, then the save goes ahead.
    if (session.signedOut && (!await session.signIn() || destroyed)) return;
    try {
      const saved = await doc.save();
      if (saved && !wb.dirty) toast('Saved', { icon: 'cloud', duration: 1200 });
    } catch (e) {
      toast(`Could not save: ${e?.message || 'unknown error'}`, { icon: 'alert', duration: 5000 });
    }
  }

  // What the file is named before its .xlsx, as the rename and the copy will write it: ".xlsx" alone names nothing.
  const fileBaseName = (v) => P.sanitizeName(v).replace(/\.xlsx$/i, '');

  async function renameDoc() {
    const name = await promptDialog({
      title: 'Rename spreadsheet', label: 'Name', value: doc.name, confirmLabel: 'Rename',
      validate: (v) => (fileBaseName(v) ? null : 'Enter a name'),
    });
    if (name == null || name === doc.name) return;
    const err = await doc.rename(name);
    if (destroyed) return; // the editor was left while Puter renamed; the next screen keeps its own title
    if (err) toast(err, { icon: 'alert' });
    else refreshTitle();
  }

  /**
   * Sharing hands out a file: an unsaved spreadsheet is saved first, as for a link to a range. Saved by hand,
   * not flushed: a flush has nothing to write for a blank book that was never changed. A file that is not an
   * .xlsx (a .csv opened from the drive) is saved as one first, where its edits go from now on: shared as it
   * was, it would never see them. Resolves whether there is a file to share now.
   */
  async function savedForSharing() {
    if (grid.editing && !grid.commitEdit()) return false;
    if (session.signedOut && (!await session.signIn() || destroyed)) return false;
    if (!doc.path || !doc.isXlsxPath) {
      try { await doc.save(); } catch (e) { toast(e?.message || 'Could not save the spreadsheet', { icon: 'alert', duration: 4000 }); return false; }
      if (destroyed) return false;
    }
    if (!doc.path) { toast('Save the spreadsheet first, then share it', { icon: 'info' }); return false; }
    return true;
  }

  async function saveAs() {
    if (grid.editing && !grid.commitEdit()) return;
    if (session.signedOut && (!await session.signIn() || destroyed)) return;
    const name = await promptDialog({
      title: 'Save a copy', label: 'Name', value: `${doc.name} copy`, confirmLabel: 'Save copy',
      hint: `Saved to ${P.FOLDER}/ in your Puter cloud. You will continue in the copy.`,
      validate: (v) => (fileBaseName(v) ? null : 'Enter a name'),
    });
    if (name == null) return;
    const err = await doc.saveAs(name);
    if (destroyed) return;
    if (err) toast(err, { icon: 'alert' });
    else { toast('Copy saved', { icon: 'cloud' }); refreshTitle(); }
  }

  async function exportFile(kind) {
    if (grid.editing && !grid.commitEdit()) return;
    try {
      const sheet = wb.sheet(grid.sheetId);
      const perSheet = kind === 'csv' || kind === 'tsv' || kind === 'html';
      const blob = kind === 'csv' ? doc.toCsvBlob(grid.sheetId) : kind === 'tsv' ? doc.toTsvBlob(grid.sheetId) : kind === 'html' ? doc.toHtmlBlob(grid.sheetId) : kind === 'ods' ? await doc.toOdsBlob() : await doc.toXlsxBlob();
      const name = perSheet ? `${P.sanitizeName(doc.name)}${wb.sheets.length > 1 ? ` - ${sheet.name}` : ''}.${kind}` : `${P.sanitizeName(doc.name)}.${kind === 'ods' ? 'ods' : 'xlsx'}`;
      if (P.isApp() && P.canSaveFiles()) {
        // Puter's save dialog is not awaited (a cancelled one never settles), so its failure is reported from here.
        P.saveFileAs(blob, name).then((saved) => saved && toast(`Saved ${saved.name}`, { icon: 'check' }))
          .catch((e) => { if (!destroyed) toast(`Could not export: ${e?.message || 'unknown error'}`, { icon: 'alert' }); });
      } else {
        P.downloadBlob(blob, name);
      }
    } catch (e) {
      toast(`Could not export: ${e?.message || 'unknown error'}`, { icon: 'alert' });
    }
  }

  async function leave() {
    if (await flush()) goHome();
  }

  const fileInput = el('input', {
    type: 'file', accept: '.xlsx,.xlsm,.xls,.csv,.tsv,.ods,.txt', hidden: true, 'aria-hidden': 'true', tabindex: -1,
    onchange: async () => { const f = fileInput.files?.[0]; fileInput.value = ''; if (f && await flush() && !destroyed) importFile(f); },
  });
  // Images float over the sheet like charts and travel in the file as data URLs.
  let replaceImageId = null;
  let imageIntoCell = false; // the picture chosen goes into the active cell (Insert ▸ Pictures ▸ Place in Cell)
  const imageInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', hidden: true, 'aria-hidden': 'true', tabindex: -1,
    onchange: async () => {
      const f = imageInput.files?.[0];
      imageInput.value = '';
      const replaceId = replaceImageId, inCell = imageIntoCell;
      replaceImageId = null; imageIntoCell = false;
      if (f) await insertImageFile(f, { replaceId, inCell });
    },
  });
  // Page Layout ▸ Background: a picture tiled behind the cells of the sheet in view.
  let backgroundSheet = null;
  const backgroundInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml', hidden: true, 'aria-hidden': 'true', tabindex: -1,
    onchange: async () => {
      const f = backgroundInput.files?.[0], sheetId = backgroundSheet;
      backgroundInput.value = '';
      backgroundSheet = null;
      if (!f || destroyed || !wb.sheet(sheetId)) return;
      try {
        let { src, width, height } = await readImageFile(f);
        // The file keeps a background as a PNG, JPEG, GIF or BMP picture: others are drawn into a PNG.
        if (!/^data:image\/(png|jpeg|gif|bmp);/i.test(src)) {
          const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = src; });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(width)); canvas.height = Math.max(1, Math.round(height));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          src = canvas.toDataURL('image/png');
        }
        if (destroyed) return;
        if (wb.isProtected(sheetId)) { toast('This sheet is protected. Unprotect it before changing its background', { icon: 'lock', duration: 3500 }); return; }
        if (wb.setSheetBackground(sheetId, src)) {
          toast('Background set. It shows behind the cells on screen and is not printed', { icon: 'image', duration: 3000 });
          statusBar?.announce('Sheet background set');
        } else toast('That picture is too large for a background', { icon: 'info', duration: 3000 });
      } catch (e) {
        if (destroyed) return;
        toast(e?.code === 'too-large' ? `${f.name} is too large (over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)` : 'Could not read that image', { icon: 'alert', duration: 3500 });
      }
      keepFocus();
    },
  });
  /** A linked picture as it shows now: the picture of its cells, drawn afresh (a static picture as it is). */
  function linkedPictureNow(ch) {
    const target = ch.pictureRef && linkedPictureTarget(wb, grid.sheetId, ch.pictureRef);
    const live = target && rangePicture(wb, target.sheetId, target.range);
    return live ? { ...ch, src: svgDataUrl(live.svg), srcRect: null, fillRect: null } : ch;
  }

  /**
   * Put an image file on the sheet at the active cell, into the image being replaced, or with `inCell`
   * into the cell itself as its value. Resolves to what was made: 'floating', 'cell', or null.
   */
  async function insertImageFile(f, { sheetId = grid.sheetId, anchor = { ...grid.active }, replaceId = null, inCell = false } = {}) {
    if (destroyed) return null;
    const atDestination = () => grid.sheetId === sheetId && grid.active.r === anchor.r && grid.active.c === anchor.c && !grid.editing;
    let made = null;
    try {
      const { src, width, height } = await readImageFile(f);
      if (destroyed || !wb.sheet(sheetId)) return null;
      if (wb.isProtected(sheetId) && !inCell) {
        toast('This sheet is protected. Unprotect it before inserting or replacing images', { icon: 'lock', duration: 3500 });
        return null;
      }
      if (inCell) {
        // The picture is the cell's value: it moves, sorts and copies with the cell. Its file name is a first alt text.
        const alt = f.name && !/^(?:pasted )?image(?:\.\w+)?$/i.test(f.name) ? f.name.replace(/\.[^.]+$/, '') : '';
        if (await pictures.placeSourceInCell(src, { sheetId, at: anchor, alt })) {
          made = 'cell';
          statusBar?.announce(`Picture placed in ${cellName(anchor.r, anchor.c)}`);
        }
      } else if (replaceId) {
        if (!wb.chartById(sheetId, replaceId)) return;
        wb.updateChart(sheetId, replaceId, { src, title: f.name }, 'Replace image');
        toast('Image replaced', { icon: 'image', duration: 1600 });
      } else {
        // Fit large pictures to a sensible on-sheet size; they keep their proportions.
        const scale = Math.min(1, 480 / width, 320 / height);
        const id = wb.addChart(sheetId, { type: 'image', src, title: f.name, anchor, dx: 4, dy: 4, w: Math.round(width * scale), h: Math.round(height * scale) });
        if (!id) return null;
        made = 'floating';
        if (atDestination()) grid.selectChart(id);
        toast('Image inserted. Drag to move, drag the corner to resize', { icon: 'image', duration: 2600 });
      }
    } catch (e) {
      if (destroyed) return;
      // A picture over the size cap is refused by its code, and told apart from one that could not be decoded.
      if (e?.code === 'too-large') toast(`${f.name} is too large to put on the sheet (over ${MAX_IMAGE_BYTES / (1024 * 1024)} MB)`, { icon: 'info', duration: 3500 });
      else { console.error(e); toast('Could not read that image', { icon: 'alert' }); }
    }
    if (atDestination()) keepFocus();
    return made;
  }
  // Where the assistant is on screen, open or collapsed to its strip: a file dropped there goes with the next message.
  function overAssistant(x, y) {
    if (!aiPanel || x == null) return false;
    const target = aiPanel.isOpen ? aiPanel.el : aiPanel.rail;
    if (!target?.isConnected || target.hidden) return false;
    const r = target.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  }
  function dragOver(x, y) {
    const over = overAssistant(x, y);
    aiPanel?.setDropTarget(over);
    return over;
  }
  /**
   * A file dropped anywhere on the app while this sheet is open: on the
   * assistant, it and any dropped with it go with the next message; elsewhere
   * an image lands at the active cell, a spreadsheet opens as a new document.
   */
  async function acceptDrop(f, { files, x, y } = {}) {
    if (overAssistant(x, y)) {
      aiPanel.setDropTarget(false);
      aiPanel.open();
      aiPanel.attach(files?.length ? files : [f]);
      return;
    }
    if (grid.editing && !grid.commitEdit()) return;
    if (f.type.startsWith('image/')) { replaceImageId = null; await insertImageFile(f); return; }
    if (isSpreadsheetFile(f.name)) { if (await flush() && !destroyed) importFile(f); return; }
    toast(`Cannot open ${f.name}. Drop a spreadsheet (.xlsx, .csv, .ods, …) or an image`, { icon: 'info', duration: 3200 });
  }
  // Import into this spreadsheet: a dialog places the file's sheets (new sheets, the current sheet, appended rows, or at the selected cell).
  const sheetsInput = el('input', {
    type: 'file', accept: '.xlsx,.xlsm,.xls,.csv,.tsv,.ods,.txt', hidden: true, 'aria-hidden': 'true', tabindex: -1,
    onchange: async () => {
      const f = sheetsInput.files?.[0];
      sheetsInput.value = '';
      if (!f) return;
      if (grid.editing && !grid.commitEdit()) return;
      try {
        const bytes = await f.arrayBuffer();
        if (destroyed) return;
        const other = await workbookFromFile(bytes, f.name);
        if (destroyed) return;
        // A lone sheet from a CSV takes the file's name, which is what people look for in the tabs.
        if (other.sheets.length === 1 && /\.(csv|tsv|txt)$/i.test(f.name)) other.renameSheet(other.sheets[0].id, f.name.replace(/\.[^.]+$/, '').slice(0, 31) || other.sheets[0].name);
        openImportPlacementDialog(ctx, other, f.name);
      } catch (e) {
        if (destroyed) return;
        console.error(e);
        toast(`Could not read ${f.name}`, { icon: 'alert', duration: 5000 });
      }
      keepFocus();
    },
  });

  /* ---------- Top bar and menu bar ---------- */

  /* ---------- Editing together (a shared workbook; see collab/ and coauthor.js) ---------- */

  const room = doc.collab || null;
  const FLAG_MS = 4000;
  /** Show where someone is: their sheet, with their selection. */
  const jumpTo = (person) => {
    if (!person.sheet || !wb.sheet(person.sheet)) { toast(`${person.name} has not picked a cell yet`, { icon: 'info', duration: 2200 }); return; }
    if (grid.editing && !grid.commitEdit()) return;
    if (wb.activeSheetId !== person.sheet) wb.setActiveSheet(person.sheet);
    const target = person.sel || { r1: person.active.r, c1: person.active.c, r2: person.active.r, c2: person.active.c };
    grid.setRanges([target], person.active || { r: target.r1, c: target.c1 });
    statusBar?.announce(`At ${person.name}'s selection`);
    keepFocus();
  };
  const peopleBar = room ? createPeopleBar({ client: room, wb, jump: jumpTo }) : null;
  let lastPresence = '';
  const sharePresence = () => {
    if (!room) return;
    const state = { sheet: grid.sheetId, sel: grid.range, active: grid.active, editing: grid.editing };
    const key = JSON.stringify(state);
    if (key === lastPresence) return;
    lastPresence = key;
    room.setPresence(state);
  };
  // A person's name flag shows while they move or type, then shrinks to a tab in their colour, so names do not cover the cells.
  const movedAt = new Map(); // session → { key, at }
  let flagTimer = null;
  const showPeople = () => {
    if (!room || destroyed) return;
    const now = Date.now();
    const people = peopleHere(room).map((p) => {
      const key = JSON.stringify([p.sheet, p.sel, p.active, p.editing]);
      const seen = movedAt.get(p.id);
      if (seen?.key !== key) movedAt.set(p.id, { key, at: now });
      return { ...p, quiet: !p.editing && now - movedAt.get(p.id).at > FLAG_MS };
    });
    peopleBar.update();
    grid.setPeers(people);
    clearTimeout(flagTimer);
    const next = Math.min(...people.filter((p) => !p.quiet && !p.editing).map((p) => movedAt.get(p.id).at + FLAG_MS - now + 20));
    if (Number.isFinite(next)) flagTimer = setTimeout(showPeople, Math.max(50, next));
    const bySheet = new Map();
    for (const p of people) if (p.sheet) bySheet.set(p.sheet, [...(bySheet.get(p.sheet) || []), { name: p.name, color: p.color }]);
    sheetTabs.setPeers(bySheet);
  };
  const onRoomRefused = (e) => toast(e.detail?.message || 'That change could not be shared', { icon: 'alert', duration: 4000 });
  const onRoomRole = (e) => toast(e.detail?.role === 'viewer' ? 'You can now only view this shared workbook' : 'You can now edit this shared workbook', { icon: 'info', duration: 4000 });
  const onRoomClosed = (e) => toast(`${e.detail?.message || 'This shared workbook is no longer available'} What you see stays open; use File > Save a copy to keep it.`, { icon: 'alert', duration: 8000 });
  // Rows or columns someone else inserted, deleted or moved carry this person's selection along with the cells.
  const onRoomRemote = (e) => {
    const ops = (e.detail?.ops || []).filter((op) => op.s === grid.sheetId && op.axis);
    if (!ops.length || grid.editing) return;
    const map = (range) => {
      let { r1, c1, r2, c2 } = range;
      for (const op of ops) {
        const along = op.axis === 'row' ? ['r1', 'r2'] : ['c1', 'c2'];
        const box = { r1, c1, r2, c2 };
        let a = mapLine(op, op.s, op.axis, box[along[0]]), b = mapLine(op, op.s, op.axis, box[along[1]]);
        if (a < 0 || b < 0) { a = Math.max(0, mapGap(op, op.s, op.axis, box[along[0]])); b = Math.max(a, mapGap(op, op.s, op.axis, box[along[1]] + 1) - 1); }
        if (op.t === 'insert' && box[along[0]] < op.at && box[along[1]] >= op.at) b = box[along[1]] + op.n;
        box[along[0]] = a; box[along[1]] = Math.max(a, b);
        ({ r1, c1, r2, c2 } = box);
      }
      return { r1, c1, r2, c2 };
    };
    const ranges = grid.ranges.map(map);
    const act = map({ r1: grid.active.r, c1: grid.active.c, r2: grid.active.r, c2: grid.active.c });
    grid.setRanges(ranges, { r: act.r1, c: act.c1 });
  };
  const onRoomOnline = () => room?.resume();
  const onRoomVisible = () => { if (document.visibilityState === 'visible') room?.resume(); };

  // The tooltip carries the whole name: the title is cut short with an ellipsis when the window is narrow.
  const titleTip = () => `Rename "${doc.name}"`;
  // A name in a right-to-left script is laid out that way, its number at its own end, as a cell is.
  const titleBtn = el('button.doc-title', { type: 'button', dir: 'auto', title: titleTip(), onclick: () => run('rename') }, doc.name);
  // Beside the name while several sheets are grouped: what is typed lands on all of them.
  const groupBadge = el('span.doc-group-badge', { hidden: true, title: 'Several sheets are grouped: edits apply to each of them. Click a sheet outside the group, or right-click a tab, to ungroup.' }, '[Group]');
  // A plain status while signed in; without a session it is the button that starts the sign-in and the save.
  const status = el('button.save-status', { type: 'button', 'aria-live': 'polite', disabled: true, onclick: () => { if (session.signedOut) run('save'); } });
  const searchBtn = el('button.icon-btn.desktop-only', { type: 'button', html: icon('search', 20), 'aria-label': 'Search the menus', title: `Search the menus (${MOD_KEY}+Shift+P)`, onclick: () => run('palette') });
  const avatar = el('button.icon-btn.user-btn', {
    type: 'button', 'aria-label': 'Account menu', 'aria-haspopup': 'menu',
    onclick: (e) => openAppMenu(e.currentTarget, { onOptions: () => run('options') }),
  });
  renderAccountButton(avatar);

  // Save, Undo and Redo stand in the title row as a quick access toolbar; the ribbon fills it.
  // The AutoSave switch leads the row: off, edits wait for Save (they are still kept in this browser's draft).
  const autoSaveSwitch = el('button.autosave-switch', { type: 'button', role: 'switch', 'aria-label': 'AutoSave', 'aria-checked': String(autoSaveEnabled()),
    title: 'AutoSave: save changes as you work', onclick: () => {
      const on = autoSaveSwitch.getAttribute('aria-checked') !== 'true';
      doc.setAutoSave?.(on);
      autoSaveSwitch.setAttribute('aria-checked', String(on));
      statusBar?.announce(on ? 'AutoSave on' : `AutoSave off. Changes are saved when you press ${MOD_KEY}+S`);
    } }, el('span.autosave-label', {}, 'AutoSave'), el('span.autosave-track', { 'aria-hidden': 'true' }, el('span.autosave-knob')));
  const quickAccess = el('div.quick-access', { role: 'toolbar', 'aria-label': 'Quick access' },
    autoSaveSwitch,
    el('button.icon-btn.qat-btn', { type: 'button', html: icon('save', 18), 'aria-label': 'Save', title: `Save (${MOD_KEY}+S)`, onclick: () => run('save') }));
  ctx.quickAccess = quickAccess;
  // The menu bar sits in the title row, left of the centred name;
  // its menus are built from the moment's state when opened. After Escape the menu has put focus back on its title, and
  // after Tab the browser moves on from there; after a choice or a press elsewhere the grid takes focus back.
  const menubar = createMenubar({ flags: commandFlags, run, onClose: (reason) => { if (reason !== 'escape' && reason !== 'tab') keepFocus(); } });
  const topbar = el('div.topbar', {},
    el('button.icon-btn', { type: 'button', html: icon('back', 20), 'aria-label': 'Back to all spreadsheets', title: 'All spreadsheets', onclick: () => run('home') }),
    el('span.brand-mark.desktop-only', { html: icon('brand', 16, 2.2), 'aria-hidden': 'true' }),
    quickAccess,
    el('div.topbar-menus', {}, menubar.el),
    el('div.topbar-title-wrap', {}, titleBtn, groupBadge, status),
    el('div.topbar-actions', {}, searchBtn,
      // The Comments button beside Share: the sheet's comment threads in the Comments pane.
      el('button.icon-btn.desktop-only.topbar-comments', { type: 'button', html: icon('chat', 20), 'aria-label': 'Comments', title: 'Comments', onclick: () => run('toggleComments') }),
      peopleBar?.el,
      ...(P.canShare() ? [el('button.btn.share-btn.desktop-only', { type: 'button', title: 'Share this spreadsheet', onclick: () => run('share') },
      el('span', { html: icon('share', 16) }), el('span', {}, 'Share'))] : []), avatar));
  const header = el('header.editor-header', {}, topbar);

  function refreshStatus() {
    if (room) {
      const [ic, label, title] = roomStatus(room);
      status.disabled = true;
      status.className = `save-status shared ${room.status.state}`;
      status.replaceChildren(el('span', { html: icon(ic, 14, 2), className: ic === 'spinner' ? 'spin' : '' }), el('span.save-label', {}, label));
      status.title = title;
      return;
    }
    if (session.signedOut) {
      // Nowhere to write yet: the pill invites the sign-in that saving needs. The edits are normally copied into
      // this browser's draft meanwhile; when they could not be (the book outgrew local storage), it says so here
      // too, since a closed tab would then lose them.
      const noCopy = doc.status === 'unsaved' && doc.draftKept === false;
      status.className = 'save-status signed-out';
      status.disabled = false;
      status.replaceChildren(el('span', { html: icon('cloudOff', 14, 2) }), el('span.save-label', {}, noCopy ? 'Sign in to save. This browser could not keep a copy' : 'Sign in to save'));
      status.title = noCopy ? 'Not saved, and this browser could not keep a copy of the changes. Sign in to Puter to save this spreadsheet to your own cloud' : 'Not saved. Sign in to Puter to save this spreadsheet to your own cloud';
      status.setAttribute('aria-label', noCopy ? 'Not saved, and this browser could not keep a copy. Sign in to Puter to save this spreadsheet' : 'Not saved. Sign in to Puter to save this spreadsheet');
      return;
    }
    status.disabled = true;
    status.removeAttribute('aria-label');
    const map = {
      saved: ['cloud', 'Saved'],
      saving: ['spinner', 'Saving…'],
      unsaved: ['clock', 'Unsaved changes'],
      error: ['alert', 'Not saved'],
      offline: ['cloudOff', 'Offline'],
      // A file moved or deleted elsewhere, or one that could not be checked, is a conflict too (see doc.js), but not one that changed: the reason names which.
      conflict: ['alert', /moved or deleted/i.test(doc.error || '') ? 'Moved or deleted' : /could not be checked/i.test(doc.error || '') ? 'Could not be checked' : 'Changed elsewhere'],
    };
    // Shared only to view: said at rest, and in place of a save that was refused (not while offline, which passes).
    if (doc.viewOnly && (doc.status === 'saved' || doc.status === 'error')) map[doc.status] = ['eye', doc.status === 'saved' ? 'View only' : 'View only · Not saved'];
    const [ic, base] = map[doc.status] || map.saved;
    // Unsaved edits are normally copied into this browser's draft; when they could not be (the book
    // outgrew local storage), the pill says so, since a closed tab would then lose them.
    const noCopy = doc.status === 'unsaved' && doc.draftKept === false;
    const label = noCopy ? `${base}. This browser could not keep a copy` : base;
    status.className = `save-status ${doc.status}`;
    status.replaceChildren(el('span', { html: icon(ic, 14, 2), className: ic === 'spinner' ? 'spin' : '' }), el('span.save-label', {}, label));
    status.title = doc.error ? `${label}: ${doc.error}` : doc.viewOnly ? `${label}: ${VIEW_ONLY}` : (doc.path ? `${label} · ${doc.path}` : label);
  }

  function refreshTitle() {
    titleBtn.textContent = doc.name;
    titleBtn.title = titleTip();
    groupBadge.hidden = !wb.sheetGroup;
    const group = wb.sheetGroup ? ' [Group]' : '';
    document.title = `${doc.name}${group} · Spreadsheet`;
    P.setWindowTitle(`${doc.name}${group}`);
    refreshStatus();
  }

  /* ---------- Assemble ---------- */

  let aiPanel = null;
  let languagePane = null; // Review ▸ Thesaurus and Translate, made below
  let queriesPane = null; // Data ▸ Queries & Connections, made below
  let automate = null; // Automate: scripts, the Code Editor and Record Actions, made below
  // Pictures in cells, Picture Format, and pictures of copied cells (ui/pictures.js).
  const pictures = createPictures(ctx, { keepFocus: () => keepFocus(), selectLocation: (sid, range) => selectLocation(sid, range) });
  ctx.pictures = pictures;
  let changesPane = null; // Review ▸ Show Changes, made below
  const toolbar = createRibbon(ctx);
  ctx.ribbon = toolbar;
  // The Quick Access Toolbar holds what the person keeps there (ui/quick-access.js): in the title row, or in a
  // row of its own under the ribbon.
  const qatBar = el('div.quick-access-bar', { hidden: true });
  const qatHome = { parent: quickAccess.parentNode, next: quickAccess.nextSibling };
  const qat = createQuickAccess(ctx, { root: quickAccess, place: (below) => {
    if (below) { qatBar.append(quickAccess); qatBar.hidden = false; }
    else if (quickAccess.parentNode !== qatHome.parent) { qatHome.parent.insertBefore(quickAccess, qatHome.next); qatBar.hidden = true; }
  } });
  ctx.subscribe(() => qat.refresh());
  const formulaBar = createFormulaBar(ctx, { fixedActions: true });
  const sheetTabs = createSheetTabs(ctx, { excelLayout: true });
  const statusBar = createStatusBar(ctx);
  const watchWindow = createWatchWindow({ ...ctx, run, docName: () => doc.name, goTo: (sid, r, c) => selectLocation(sid, { r1: r, c1: c, r2: r, c2: c }) });
  // Review ▸ Check Accessibility: a finding goes to its cells, or selects its object.
  // Review ▸ Thesaurus and Translate, answered by Puter's AI.
  languagePane = createLanguagePane({ ...ctx, run,
    ai: P.canAI() ? (prompt) => P.aiChat(prompt, { feature: 'thesaurus' }) : null,
    translate: P.canAI() ? (text, from, to) => aiTranslate(translatePrompt(text, from || '', to || 'English')) : null });
  // Page Layout ▸ Arrange ▸ Selection Pane: the sheet's drawing objects, front first.
  selectionPane = createSelectionPane({ ...ctx, run, notify });
  // SmartArt Design ▸ Text Pane: the selected diagram's outline to type into.
  const smartArtPane = ctx.smartArt.pane = createSmartArtPane(ctx);
  const accessibilityPane = createAccessibilityPane({ ...ctx, run, reveal: (item) => {
    if (item.target?.range) { selectLocation(item.sheetId, item.target.range); return; }
    const obj = item.target?.chartId && wb.chartById(item.sheetId, item.target.chartId);
    if (obj) { selectLocation(item.sheetId, { r1: obj.anchor.r, c1: obj.anchor.c, r2: obj.anchor.r, c2: obj.anchor.c }); grid.selectChart(obj.id); return; }
    if (wb.sheet(item.sheetId) && !wb.sheet(item.sheetId).hidden) wb.setActiveSheet(item.sheetId);
  } });
  // Review ▸ Show Changes: the recent edits, each with who made it; the signed-in user is the author of the edits made here.
  changesPane = createChangesPane({ ...ctx, run, reveal: (sid, range) => selectLocation(sid, range), currentUser: () => session.user?.username || null });
  const syncChangeAuthor = () => { wb.changeAuthor = displayUserName(session.user?.username) || null; };
  syncChangeAuthor();
  // Data ▸ Queries & Connections: the queries of the workbook, beside the sheet.
  ctx.autofitColumns = (sid, c1, c2) => autofitColumns(c1, c2, sid);
  queriesPane = createQueriesPane({ ...ctx, run, edit: (id) => editQuery(ctx, { queryId: id }), allowQuerySources });
  // Automate: scripts run apart from the app (lib/script-sandbox.js); what they ask of the editor comes through here.
  automate = ctx.automate = createAutomate(ctx, {
    notify,
    keepFocus: () => keepFocus(),
    // While a script runs, the sheet, the formula bar and the sheet tabs take no input of their own.
    busy: (on) => { for (const node of [grid.el, formulaBar.el, sheetTabs.el]) node.inert = on; },
    env: () => ({
      name: doc.name,
      selection: () => ({ sheetId: grid.sheetId, range: { ...grid.range } }),
      select: (sheetId, range) => selectLocation(sheetId, range),
      autofit: (sheetId, axis, from, to) => {
        if (axis === 'col') autofitColumns(from, to, sheetId);
        else if (sheetId === grid.sheetId) grid.autoFitRows(from, Math.min(to, from + 2000), { force: true });
      },
      // A formula a script writes that reaches outside the file waits for the user's Allow, as one in a shared file does.
      distrust: () => doc.distrustExternal(),
    }),
  });
  ctx.onQueriesChanged = () => { queriesPane.render(true); notify(); };
  const findBar = createFindBar(ctx);
  // Background error checking's smart tag beside the active cell (Convert to Number, Ignore Error…).
  // Quick Analysis: the button at the corner of a selected block of data, and Ctrl+Q.
  const quickAnalysis = createQuickAnalysis({ ...ctx, run });
  const errorTag = createErrorSmartTag({ ...ctx, run, focusFormulaBar: () => formulaBar.focusInput(), refreshErrorTag: () => errorTag.sync() });
  // Threaded comments: the card beside a cell and the Comments pane (Review ▸ Comments).
  // @mentions: the people a comment can name, telling them when it is posted, and telling the user when a
  // comment names them (ui/mention-notify.js).
  const mentionNotifier = createMentionNotifier({ doc, wb, mailer, me: () => session.user });
  const comments = createComments(ctx, { author: () => displayUserName(session.user?.username) || 'You', keepFocus: () => keepFocus(),
    refused: (what) => refusedByProtection(what), onPaneToggle: () => notify(),
    mentionPeople: () => mentionNotifier.candidates(),
    onMentioned: (posted) => { mentionNotifier.notify(posted).catch((e) => console.error(e)); } });
  const mentionAlerts = createMentionAlerts({
    wb, me: () => session.user, fileKey: () => doc.uid || doc.path,
    goTo: (sheetId, r, c) => { if (destroyed) return; if (selectLocation(sheetId, { r1: r, c1: c, r2: r, c2: c })) comments.run('showComment'); },
  });
  mentionAlerts.start();
  comments.attach();
  ctx.comments = comments;
  ctx.subscribe(() => comments.sync());
  // The AI assistant, beside the sheet. Its tools act on the workbook directly; what only the editor knows
  // (the selection, how wide a column's text is, the document's trust in outside content) comes through here.
  aiPanel = P.canAI() ? createAiPanel(ctx, {
    sheetId: () => grid.sheetId,
    selection: () => ({ sheetId: grid.sheetId, range: { ...grid.range } }),
    select: (sheetId, range) => { const ok = selectLocation(sheetId, range); return ok !== false && ok !== null; },
    showSheet: (sheetId) => { if (!wb.sheet(sheetId)?.hidden) wb.setActiveSheet(sheetId); },
    autofit: (sheetId, c1, c2) => autofitColumns(c1, c2, sheetId),
    // A formula the AI writes that reaches outside the file was put together from the sheet's own cells, which
    // anyone may have written: it waits for the user's Allow, as one pasted from a web page does.
    distrust: () => doc.distrustExternal(),
    // A change waits while the user is typing into a cell, until the entry is committed or cancelled.
    whenIdle: () => (grid.editing ? new Promise((resolve) => {
      const off = ctx.subscribe(() => { if (!grid.editing) { off(); resolve(); } });
    }) : null),
  }, {
    onToggle: (open) => {
      root?.classList.toggle('ai-open', open);
      notify();
    },
  }) : null;

  // Content from other files or the web waits for a yes in a file from elsewhere.
  const externalNotice = el('div.notice-bar', { role: 'status', hidden: true },
    el('span.notice-icon', { html: icon('alert', 16, 2) }),
    el('span.notice-text', {}, 'This spreadsheet pulls in content from other files or the web, or asks the AI. Nothing has been loaded or asked yet.'),
    el('span.notice-actions', {},
      el('button.btn.btn-sm', { type: 'button', onclick: () => { externalNotice.hidden = true; keepFocus(); } }, 'Keep blocked'),
      el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => { doc.allowExternal(); externalNotice.hidden = true; grid.refresh(); notify(); keepFocus(); } }, 'Allow')));
  const pivotNoticeText = el('span.notice-text');
  const pivotNotice = el('div.notice-bar.pivot-display-notice', { role: 'status', hidden: true },
    el('span.notice-icon', { html: icon('alert', 16, 2) }), pivotNoticeText);
  function updatePivotDisplayNotice() {
    const issues = wb.nativePivotDisplayIssues(grid.sheetId);
    pivotNotice.hidden = !issues.length;
    pivotNoticeText.textContent = issues.length
      ? `Some formatting in PivotTable “${issues[0].name}” is not supported yet. Cached cell formatting is shown.${issues.length > 1 ? ` ${issues.length - 1} other PivotTable${issues.length > 2 ? 's are' : ' is'} affected.` : ''}` : '';
    pivotNotice.title = issues.map(issue => `${issue.name}: ${issue.message}`).join('\n');
  }
  updatePivotDisplayNotice();
  const root = el('div.editor.view', {},
    fileInput,
    sheetsInput,
    imageInput,
    backgroundInput,
    header,
    // The sheet's column, and the assistant beside it from under the title row down (a thin strip when collapsed).
    el('div.editor-body', {},
      el('div.editor-main', {},
        toolbar.el,
        qatBar,
        formulaBar.el,
        externalNotice,
        automate.notice,
        pivotNotice,
        // The page's main landmark: the grid (the panel the sheet tabs control) and the find bar over it.
        // The task panes (Accessibility, Thesaurus and Translate, Changes, Selection, Queries) dock at the grid's right
        // edge, under the ribbon and beside whatever column is open to the right; one at a time (see taskPanes).
        el('main.editor-grid', {}, grid.el, findBar.el, accessibilityPane.el, languagePane.el, changesPane.el, selectionPane.el, queriesPane.el, smartArtPane.el),
        sheetTabs.el,
        statusBar.el,
        watchWindow.el,
        errorTag.el,
        quickAnalysis.el),
      chartUi.pane,
      comments.el,
      automate.pane,
      aiPanel?.el,
      aiPanel?.rail));
  // The task panes over the grid take turns: opening one closes whichever other was open, so none hides another.
  const taskPanes = [accessibilityPane, languagePane, changesPane, selectionPane, queriesPane, smartArtPane];
  for (const pane of taskPanes) {
    const show = pane.show.bind(pane);
    pane.show = (...args) => {
      for (const other of taskPanes) if (other !== pane && other.open) other.hide();
      return show(...args);
    };
  }
  // Alt (or F10) shows key tips on the ribbon; they wait while an entry, a menu or a dialog has the keyboard.
  const keyTips = attachKeyTips({
    ribbon: toolbar.el, fileButton: () => menubar.el.querySelector('[data-menu="file"]'), openFile: () => menubar.open('file'),
    blocked: () => destroyed || grid.editing || !root.isConnected || !!document.querySelector('.modal-root, .menu'), onExit: () => keepFocus(),
  });
  applyView();
  if (aiPanel && loadAiSettings().open) aiPanel.open({ focus: false });

  // The assistant's heading stands level with the ribbon's tab row beside it, whatever height that row has.
  const tabRow = toolbar.el.querySelector('.ribbon-tab-row');
  const menubarObserver = aiPanel && tabRow && typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const height = tabRow.getBoundingClientRect().height;
    if (height) aiPanel.el.style.setProperty('--editor-menubar-h', `${height}px`);
  }) : null;
  menubarObserver?.observe(tabRow);

  grid.viewport.addEventListener('pointerup', paintOnRelease);
  grid.el.addEventListener('keydown', paintOnEnter, true); // before the grid moves the selection down
  // WebKit can target clipboard events at the body or the DOM selection rather
  // than the focused grid. Listen on the document; the handlers use focus to
  // decide which editor owns the operation and leave other fields alone.
  const onNativeCopy = e => onCopyEvent(e, false);
  const onNativeCut = e => onCopyEvent(e, true);
  document.addEventListener('copy', onNativeCopy);
  document.addEventListener('cut', onNativeCut);
  document.addEventListener('paste', onPasteEvent);
  wb.addEventListener('change', disarmCutOnChange);
  // Page Break Preview follows the sheet: its pages are laid out again as cells, sizes or page setup change.
  // Page Layout view lays the sheet out as its printed pages; the view is the sheet's own (sheet.viewMode).
  const sheetViewMode = () => wb.sheet(grid.sheetId)?.viewMode || 'normal';
  const pageLayout = createPageLayout({
    wb, fileName: () => doc.name, redraw: () => grid.redraw(), focusGrid: () => grid.focus(),
    commit: (id, patch) => { wb.setPrintSettings(id, { ...(wb.sheet(id).printSettings || normalizePrintSettings({})), ...patch }); notify(); },
  });
  let pageViewKey = null;
  let pageLayoutKey = null;

  function refreshPageView(force = false) {
    const mode = sheetViewMode();
    const on = mode === 'pageBreak';
    if (mode === 'pageLayout') {
      // The pages follow the page setup and the sheet's sizes (the grid lays them out again with its
      // layout), and the used range: Fit to pages and the page count (&N) read it.
      const sheet = wb.sheet(grid.sheetId);
      const key = JSON.stringify([grid.sheetId, wb.usedRange(grid.sheetId), sheet.printSettings]);
      const fresh = !grid.pageLayout;
      grid.setPageLayout(pageLayout);
      if (!fresh && key !== pageLayoutKey) grid.refresh();
      pageLayoutKey = key;
    } else { grid.setPageLayout(null); pageLayoutKey = null; }
    // Normal view can show where the pages break (View ▸ Page Breaks, or after a print preview), as dashed lines.
    const lines = mode === 'normal' && pageBreakLinesOn(grid.sheetId);
    const key = on || lines ? `${grid.sheetId}|${wb.version}|${on}` : null;
    if (!force && key === pageViewKey) return;
    pageViewKey = key;
    const breaks = on || lines ? pageBreaks(wb, grid.sheetId) : null;
    if (on) grid.setPageView({ area: breaks?.area || { r1: 0, c1: 0, r2: 0, c2: 0 }, pages: pagesOf(breaks), rowBreaks: breaks?.rowBreaks || [], colBreaks: breaks?.colBreaks || [] });
    else grid.setPageView(lines && breaks ? { lines: true, area: breaks.area, rowBreaks: breaks.rowBreaks, colBreaks: breaks.colBreaks } : null);
  }
  ctx.viewMode = sheetViewMode;
  const unsubscribePageView = ctx.subscribe(() => refreshPageView());
  refreshPageView();

  /*
   * Where the selection was before an Insert rows or columns step, and where the step left it: undoing the
   * step puts the selection back, and redoing it selects the inserted lines again, rather than
   * leaving a whole-line selection where the lines were. A step is known by its place in the history, counted
   * from the workbook's history notices, the editor's own undo and redo commands saying which way the count
   * moves (every undo goes through them). A document loaded afresh starts the count over.
   */
  let historyDepth = 0;
  let historyMove = 'push'; // 'undo' or 'redo' while those commands run; a notice outside them is a new step
  const stepSelections = new Map(); // the step's depth → { before, after }
  function selectionSnapshot() {
    return { sheetId: grid.sheetId, ranges: grid.ranges.map((rg) => ({ ...rg })), active: { ...grid.active } };
  }
  function rememberStepSelection(before) {
    stepSelections.set(historyDepth, { before, after: selectionSnapshot() });
  }
  function restoreSelection(snap) {
    if (snap && grid.sheetId === snap.sheetId) grid.setRanges(snap.ranges, snap.active);
  }
  let lastProtectedToast = 0;
  let lastProtectedKey = null;
  let trackedEdit = false;
  const onWbChange = (e) => {
    if (e.detail?.type === 'sheet-group') { refreshTitle(); notify(); return; }
    abandoned = false;
    // One activation per editor session, including typing, pasting and AI-made data changes.
    if (!trackedEdit && e.detail?.type === 'cells' && wb.dirty) {
      trackedEdit = true;
      trackEvent('Spreadsheet Edited');
    }
    if (e.detail?.type === 'merge-paste') {
      const message = e.detail.reason === 'table' ? 'Merged cells cannot be pasted into a table’s header or data rows.'
        : e.detail.reason === 'invalid' ? 'The copied merged ranges do not fit their cell data.'
          : 'The copied cells would cross part of a merged cell. Unmerge the destination or choose another range.';
      toast(message, { icon: 'merge', duration: 4000 });
      statusBar?.announce(message);
      return;
    }
    if (e.detail?.type === 'pivot-edit') {
      const message = e.detail.reason === 'bounds' ? 'The whole pivot table must fit within the sheet limits.'
        : e.detail.reason === 'name' ? `The destination sheet already has a pivot table named “${e.detail.name}”.`
        : e.detail.reason === 'table-overlap' ? 'A pivot table cannot overlap a table. Choose another range.'
        : e.detail.reason === 'copy-limit' ? 'The copied pivot tables exceed this spreadsheet’s storage limit.'
        : e.detail.reason === 'copy-layout' ? 'The pivot table cannot keep its layout at this destination. Choose an unmerged range or paste values only.'
        : e.detail.reason === 'clear-partial' ? `Select the entire pivot table “${e.detail.name}” to delete it.`
        : e.detail.reason === 'move-partial' ? `Select the entire pivot table “${e.detail.name}” to move it.`
        : e.detail.reason === 'overlap' ? `The destination overlaps the pivot table “${e.detail.name}”. Choose another range.`
        : `This edit would split the pivot table “${e.detail.name}”. Select all of its rows or columns to delete it.`;
      toast(message, { icon: 'info', duration: 4000 });
      statusBar?.announce(message);
      return;
    }
    if (e.detail?.type === 'array-edit') {
      const ref = rangeName(e.detail.range);
      const message = e.detail.reason === 'overlap' ? `The array at ${ref} would overlap other content. Choose an empty range.`
        : e.detail.reason === 'bounds' ? 'The whole array must fit within the sheet limits.'
          : e.detail.reason === 'formula' ? 'Enter a formula starting with =. To remove the array, select its full range and clear it.'
            : `Select the entire array ${ref} to change it. You can format individual cells.`;
      toast(message, { icon: 'info', duration: 4000 });
      statusBar?.announce(message);
      return;
    }
    if (e.detail?.type === 'external-blocked') { externalNotice.hidden = false; return; }
    // Typed text past what a file can store was cut: the cell keeps the first characters, and says so.
    if (e.detail?.type === 'truncated') { toast(`Text cut to ${e.detail.max.toLocaleString()} characters, the most a cell can hold`, { icon: 'info', duration: 3500 }); return; }
    if (e.detail?.type === 'protected' && e.detail.structure) {
      const now = Date.now();
      if (lastProtectedKey !== 'structure' || now - lastProtectedToast > 2500) {
        lastProtectedToast = now; lastProtectedKey = 'structure';
        toast('The workbook’s structure is protected. Unprotect it under Review ▸ Protect Workbook to add, move, rename or delete sheets', { icon: 'lock', duration: 4000 });
        statusBar?.announce('The workbook’s structure is protected');
      }
      return;
    }
    if (e.detail?.type === 'protected') {
      const now = Date.now();
      // One notice per protected range (or sheet) at a time: an edit refused cell by cell says it once, while a
      // refusal on another range a moment later is a new notice, not a repeat of the last one.
      const key = e.detail.range ? `${e.detail.sheetId}:${rangeName(e.detail.range)}` : String(e.detail.sheetId);
      if (key !== lastProtectedKey || now - lastProtectedToast > 2500) {
        lastProtectedToast = now;
        lastProtectedKey = key;
        if (e.detail.range) {
          const why = e.detail.description ? ` (${e.detail.description})` : '';
          toast(`${rangeName(e.detail.range)} is protected${why}. Unprotect it under Protected ranges in the cell menu`, { icon: 'lock', duration: 3800 });
          statusBar?.announce(`${rangeName(e.detail.range)} is protected`);
        } else {
          const name = wb.sheet(e.detail.sheetId)?.name || 'This sheet';
          toast(`${name} is protected. Unprotect it from the sheet tab menu to make changes`, { icon: 'lock', duration: 3500 });
          statusBar?.announce(`${name} is protected`);
        }
      }
      return;
    }
    // A restored draft or version replaces every sheet: the grid follows the new active one.
    if (e.detail?.type === 'active-sheet' || e.detail?.type === 'load' || (e.detail?.type === 'structure' && grid.sheetId !== wb.activeSheetId) || (e.detail?.type === 'history' && grid.sheetId !== wb.activeSheetId)) {
      grid.setSheet(wb.activeSheetId);
      if (wb.sheet(wb.activeSheetId)?.viewZoom != null) grid.setZoom(wb.sheet(wb.activeSheetId).viewZoom, true);
    }
    // Precedent and dependent highlights mark one sheet's cells as they were:
    // showing another sheet, or a structural change, leaves them behind.
    if (tracing && (grid.sheetId !== tracing || e.detail?.type === 'structure')) { tracing = null; grid.setHighlights([], -1); }
    // A circled cell loses its circle once its value is valid; another sheet clears them.
    if (circledSheet != null) {
      if (grid.sheetId !== circledSheet) { circledSheet = null; grid.setHighlights([], -1); }
      else if (e.detail?.type !== 'active-sheet') grid.setHighlights(invalidCells(wb, circledSheet).cells.map((cell) => ({ ...cell, kind: 'invalid' })), -1);
    }
    // The Paste or Auto Fill Options button goes with the next change, or when its sheet is no longer shown.
    const offered = optionButton.current;
    if (offered && (wb.historyTop !== offered.mark || grid.sheetId !== offered.sheetId)) optionButton.hide();
    if (e.detail?.type === 'load') { historyDepth = 0; stepSelections.clear(); }
    else if (e.detail?.type === 'history') {
      if (historyMove === 'undo') { const step = stepSelections.get(historyDepth); historyDepth--; restoreSelection(step?.before); }
      else if (historyMove === 'redo') { historyDepth++; restoreSelection(stepSelections.get(historyDepth)?.after); }
      else { historyDepth++; for (const depth of stepSelections.keys()) if (depth >= historyDepth) stepSelections.delete(depth); } // a new step discards the redo branch
    }
    updatePivotDisplayNotice();
    notify();
  };
  wb.addEventListener('change', onWbChange);
  if (room) {
    room.addEventListener('people', showPeople);
    room.addEventListener('remote', onRoomRemote);
    room.addEventListener('status', refreshStatus);
    room.addEventListener('refused', onRoomRefused);
    room.addEventListener('role', onRoomRole);
    room.addEventListener('closed', onRoomClosed);
    window.addEventListener('online', onRoomOnline);
    document.addEventListener('visibilitychange', onRoomVisible);
    ctx.subscribe(sharePresence);
    setTimeout(() => { sharePresence(); showPeople(); }, 0);
  }
  doc.addEventListener('status', refreshStatus);
  doc.addEventListener('draft', refreshStatus); // whether this browser holds a copy of the edits changed
  doc.addEventListener('path', refreshTitle);
  const onSession = () => {
    syncChangeAuthor();
    renderAccountButton(avatar);
    refreshStatus();
    // Edits made before signing in now have a place to go.
    if (session.signedIn && wb.dirty) doc.save({ auto: true }).catch(() => {});
  };
  session.addEventListener?.('change', onSession);

  // NOW() and TODAY() drift from the clock; refresh them each minute.
  const volatileTimer = setInterval(() => { if (!grid.editing && wb.refreshVolatile()) { grid.refresh(); notify(); } }, 60000);

  const onBeforeUnload = (e) => {
    if (grid.editing) grid.commitEdit();
    if (doc.status === 'saved' && !doc.hasPendingWrites && !grid.editing) return;
    doc.writeDraft();
    doc.save().catch(() => {});
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  // The browser's own Print command (File > Print) prints the sheet the way Ctrl+P does, not the app chrome.
  const uninstallPrint = installPrintFallback(() => {
    if (grid.editing) grid.commitEdit();
    return { wb, sheetId: grid.sheetId, docName: doc.name, opts: currentPrintPrefs(wb.sheet(grid.sheetId)) };
  });
  const stopSheetFonts = installSheetFontLoading(wb, () => grid.sheetId);
  // Signing out with edits that cannot be saved is refused by the account menu; no leave dialog here.
  const onSignOut = (e) => { e.detail?.waitUntil?.(flush({ leaving: false })); };
  window.addEventListener('app:before-signout', onSignOut);
  // The file was written by another copy of the app since we last saved: the user decides whose version wins.
  let conflictOpen = false;
  const onConflict = async (e) => {
    if (conflictOpen) return;
    // Raised by the save of a flush on the way out: the leave dialog puts the question, with leaving among the answers.
    if (leavingSave) { leavingSave.kind = e.detail?.kind || 'changed'; return; }
    conflictOpen = true;
    try {
      if (e.detail?.kind === 'missing') {
        // The file is gone from its address (deleted, or moved where the drive cannot follow it):
        // there is no "theirs" to reload, so the edits stay and are offered a home instead.
        const choice = await missingFileDialog();
        if (destroyed) return;
        if (choice === 'saveAs') await saveAs();
        else if (choice === 'keep') await doc.forceSave().catch(() => {});
        else keepFocus();
        return;
      }
      // With no baseline from the open (the look-up failed) nobody knows whether the file changed: the question says so.
      const overwrite = await confirmDialog(e.detail?.kind === 'unchecked' ? {
        title: 'This file could not be checked',
        message: `Whether "${doc.name}" was saved since you opened it, perhaps from another device or tab, could not be checked. Save your version anyway, or discard yours and reload the file?`,
        confirmLabel: 'Save anyway', cancelLabel: 'Reload the file', danger: true, dismissValue: null,
      } : {
        title: 'This file changed elsewhere',
        message: `"${doc.name}" was saved, moved or renamed since you opened it, perhaps from another device or tab. Keep your version and overwrite theirs, or discard yours and reload theirs?`,
        confirmLabel: 'Overwrite with mine', cancelLabel: 'Reload theirs', danger: true, dismissValue: null,
      });
      if (overwrite) await doc.forceSave().catch(() => {});
      else if (overwrite === false) { wb.markClean(); openPath(doc.path, { reload: true }); }
    } finally { conflictOpen = false; }
  };
  doc.addEventListener('conflict', onConflict);
  // Cells follow the regional format as they are drawn; a formula whose result is written in it (TEXT, DOLLAR,
  // FIXED, VALUE) is computed afresh, since the cache holds its answer in the old one.
  const onLocale = () => { wb.recalculate(); grid.redraw(); notify(); };
  window.addEventListener('app:locale', onLocale);

  // Global shortcuts that should work even when focus is in the chrome.
  const onKey = (e) => {
    // A menu or dialog that closed during an edit can leave focus on the
    // button that opened it; the keys pressed next belong to the cell.
    if (grid.editing && !isComposing(e) && !e.defaultPrevented && !e.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape') { e.preventDefault(); grid.cancelEdit(); return; }
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Tab') grid.focusEditor();
    }
    if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey && !isComposing(e)) {
      e.preventDefault();
      const visible = (node) => {
        for (let n = node; n && n !== root; n = n.parentElement) {
          if (n.hidden || n.hasAttribute('inert') || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden') return false;
        }
        return true;
      };
      const regions = [menubar.el, toolbar.el, formulaBar.el, grid.el, sheetTabs.el, statusBar.el, automate?.paneOpen && automate.pane, aiPanel && (aiPanel.isOpen ? aiPanel.el : aiPanel.rail)].filter(Boolean).filter(visible);
      const at = regions.findIndex((region) => region.contains(e.target));
      if (grid.editing && !grid.commitEdit()) return;
      for (let step = 1; step <= regions.length; step++) {
        const region = regions[(at + (e.shiftKey ? -step : step) + regions.length) % regions.length];
        // The assistant is entered at its message box, not at the resize handle that comes first in it.
        const target = region === grid.el ? grid.viewport : region === sheetTabs.el ? sheetTabs.el.querySelector('[role="tab"][aria-selected="true"]') : region === aiPanel?.el ? aiPanel.el.querySelector('.ai-input') : region === aiPanel?.rail ? aiPanel.rail : [...region.querySelectorAll('button, input, textarea, [tabindex]')]
          .find((node) => node.tabIndex >= 0 && !node.matches(':disabled') && visible(node));
        if (target) { target.focus({ preventScroll: true }); break; }
      }
      return;
    }
    if (isComposing(e) || !isMod(e) || e.defaultPrevented) return; // the grid handled it already
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); run('save'); }
    else if (k === 'f' && !e.shiftKey) { e.preventDefault(); run('find'); }
    else if (k === 'p') { e.preventDefault(); run(e.shiftKey ? 'palette' : 'print'); }
    else if (k === 'h') { e.preventDefault(); run('replace'); }
    else if (k === 'o' && P.canPickFiles()) { e.preventDefault(); run('open'); }
    else if (k === 'g' && !e.shiftKey) { e.preventDefault(); run('goTo'); }
    else if ((k === 'j' || e.code === 'KeyJ') && !e.shiftKey && !e.altKey && aiPanel) { e.preventDefault(); run('aiPanel'); }
    // Ctrl/Cmd+, opens the options, as preferences open in desktop apps.
    else if ((k === ',' || e.code === 'Comma') && !e.shiftKey && !e.altKey) { e.preventDefault(); run('options'); }
    else if (e.key === 'Backspace' && !grid.editing && !e.target.closest?.('input, textarea')) { e.preventDefault(); run('scrollToActive'); }
    else if (k === 'z' && !grid.editing && !e.target.closest?.('input, textarea')) { e.preventDefault(); run(e.shiftKey ? 'redo' : 'undo'); }
    // Bold, italic and underline apply to the cell mid-edit too; the grid takes them when nothing is being edited.
    else if ((k === 'b' || k === 'i' || k === 'u') && grid.editing && !e.shiftKey && !e.altKey) { e.preventDefault(); run({ b: 'bold', i: 'italic', u: 'underline' }[k]); }
  };
  root.addEventListener('keydown', onKey);
  // Shortcuts of the person's own (Options ▸ Keyboard Shortcuts) come before the built-in ones, on the sheet and in
  // the window around it; a built-in shortcut turned off there does nothing. Typing into a field keeps its keys.
  const onCustomKey = (e) => {
    if (isComposing(e) || e.defaultPrevented || grid.editing) return;
    const keymap = keymapStore.get();
    if (!Object.keys(keymap).length || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const chord = chordFromEvent(e, IS_MAC);
    if (!chord || !Object.hasOwn(keymap, chord)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!keymap[chord]) return;
    const { cmd, arg } = parseCommandId(keymap[chord]);
    run(cmd, arg);
  };
  root.addEventListener('keydown', onCustomKey, true);
  // Options changed (here, in another editor, or brought in from the account): the editor follows at once.
  const offOptions = onAppOptions((options, keys) => {
    if (destroyed) return;
    applyView();
    syncNewSheetDefaults();
    syncChangeAuthor();
    if (keys.includes('aiFeatures')) {
      setAiProviders();
      if (!options.aiFeatures && aiPanel?.isOpen) aiPanel.close();
      if (aiPanel) { aiPanel.el.hidden = !options.aiFeatures; if (aiPanel.rail) aiPanel.rail.hidden = !options.aiFeatures; }
    }
    if (keys.some((k) => ['commentIndicators', 'fillHandle', 'showObjects'].includes(k))) grid.refresh();
    notify();
  });
  const offKeymap = keymapStore.subscribe(() => notify());
  // The account's copies of the options and customizations, when another device changed them.
  if (!session.signedOut) {
    syncAppOptions().catch(() => {});
    syncCustomizations();
    syncErrorChecking().then(() => { if (!destroyed) { grid.redraw(); errorTag.sync(); } }).catch(() => {});
  }
  // Focus can fall back to the page itself while a cell is being edited (the
  // button that opened a menu was re-rendered away, say). Those keys are the
  // cell's too; the page has nothing else to do with them.
  const onStrayKey = (e) => {
    if (!grid.editing || isComposing(e) || e.defaultPrevented) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    if (e.key === 'Escape') { e.preventDefault(); grid.cancelEdit(); return; }
    grid.focusEditor();
  };
  document.addEventListener('keydown', onStrayKey);
  // Ctrl/Cmd+S and Ctrl/Cmd+P pressed in a dialog, a menu, or the palette (which
  // live outside the editor's root) would open the browser's own save-page and
  // print dialogs: the keys are swallowed there, and the commands wait.
  const onChromeKey = (e) => {
    if (isComposing(e) || !isMod(e) || e.defaultPrevented || root.contains(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 's' || k === 'p') e.preventDefault();
  };
  document.addEventListener('keydown', onChromeKey);

  refreshTitle();
  requestAnimationFrame(() => { fitColumnsOnOpen(); grid.refresh(); grid.focus(); });

  // Edits made here that never reached Puter (a closed tab while offline, a
  // save that failed) come back from the local draft, if wanted.
  let recoveryTimer = null;
  let keptDraftToast = null; // the offer to restore a draft dismissed without a decision: it goes with the editor
  if (doc.recoverable) {
    const when = new Date(doc.recoverable.savedAt);
    const stamp = when.toDateString() === new Date().toDateString()
      ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    recoveryTimer = setTimeout(async () => {
      if (!doc.recoverable) return;
      const restore = await confirmDialog({
        title: 'Unsaved changes found',
        message: doc.recoverableMayBeOlder
          ? `This spreadsheet was edited here at ${stamp}, but those changes never reached Puter, and the file has been saved since. Restoring replaces what is in the file now with those older edits; discarding keeps the file as it is.`
          : `This spreadsheet was edited here at ${stamp}, but those changes never reached Puter. Restore them? Discarding keeps the file as it is now.`,
        confirmLabel: 'Restore', cancelLabel: 'Discard', danger: false, dismissValue: null,
      });
      // The editor was left while the question was up (the router closes the dialog as dismissed after the
      // view is gone): the draft stays in storage, offered again on the next open, and nothing is said here.
      if (destroyed) return;
      if (restore) { doc.restoreDraft(); toast('Unsaved changes restored', { icon: 'check', duration: 2500 }); }
      else if (restore === false) doc.discardDraft();
      else {
        // Dismissed without a decision: the draft is kept, and the offer stays within reach while the editor is.
        keptDraftToast = toast(`The unsaved changes from ${stamp} are kept until you restore or discard them`, {
          icon: 'info', duration: 8000,
          action: { label: 'Restore', onClick: () => { if (!destroyed && doc.restoreDraft()) { toast('Unsaved changes restored', { icon: 'check', duration: 2500 }); grid.refresh(); keepFocus(); } } },
        });
      }
      grid.refresh();
      keepFocus();
    }, 250);
  }

  // Opened from a link with a range: land on those cells once the view is on screen.
  if (initialRange) setTimeout(() => followInternalLink(`#${initialRange}`), 0);

  /**
   * Someone else's spreadsheet (its address starts with another user's name, as a shared one's does) may be
   * shared with this user only to view. Puter says so only in the list of what is shared with them, and a save
   * would be refused: the status says View only from the start, and a notice says how to keep changes.
   */
  async function checkViewOnly() {
    const me = session.user?.username;
    const owner = /^\/([^/]+)\//.exec(doc.path || '')?.[1];
    if (!me || !owner || owner === me || !P.canShare()) return;
    const mode = await P.sharedModeOf(doc).catch(() => null);
    if (destroyed || !mode || P.canWriteMode(mode)) return;
    doc.viewOnly = true;
    refreshStatus();
    toast(VIEW_ONLY, { icon: 'eye', duration: 7000 });
  }
  if (!session.signedOut) checkViewOnly();

  // A saved book with links to other workbooks: its Startup Prompt says whether opening it updates them, offers to, or leaves them.
  if (doc.path && wb.externalWorkbooks?.books?.some((b) => !b.kind) && wb.linkStartup !== 'none') {
    setTimeout(() => {
      if (destroyed) return;
      const host = linkHost();
      if (wb.linkStartup === 'update' && wb.externalAllowed !== false) { updateAllLinks(ctx, host); return; }
      toast('This workbook reads values from other workbooks', { icon: 'link', duration: 9000,
        action: { label: 'Update links', onClick: async () => { if (await host.allow()) updateAllLinks(ctx, host); } } });
    }, 0);
  }

  return {
    el: root,
    doc,
    flush,
    acceptDrop,
    /** A file dragged over the screen at (x, y): true where the assistant would take it (null: the drag is over). */
    dragOver,
    /** Select a "Sheet!A1:B2" range (from an address with ?range=), switching sheets if needed. */
    goTo(range) { return followInternalLink(`#${range}`); },
    /** Run an editor command, as the menus and the palette do (tests and automation). */
    run,
    destroy() {
      destroyed = true;
      palette?.close();
      keptDraftToast?.dismiss();
      clearInterval(volatileTimer);
      clearTimeout(recoveryTimer);
      window.removeEventListener('beforeunload', onBeforeUnload);
      uninstallPrint();
      stopSheetFonts();
      document.removeEventListener('keydown', onStrayKey);
      document.removeEventListener('keydown', onChromeKey);
      offOptions();
      offKeymap();
      qat.destroy();
      flashOffer?.dismiss?.();
      document.removeEventListener('copy', onNativeCopy);
      document.removeEventListener('cut', onNativeCut);
      document.removeEventListener('paste', onPasteEvent);
      optionButton.destroy();
      window.removeEventListener('app:before-signout', onSignOut);
      doc.removeEventListener('conflict', onConflict);
      window.removeEventListener('app:locale', onLocale);
      wb.removeEventListener('change', onWbChange);
      if (room) {
        clearTimeout(flagTimer);
        room.removeEventListener('people', showPeople);
        room.removeEventListener('remote', onRoomRemote);
        room.removeEventListener('status', refreshStatus);
        room.removeEventListener('refused', onRoomRefused);
        room.removeEventListener('role', onRoomRole);
        room.removeEventListener('closed', onRoomClosed);
        window.removeEventListener('online', onRoomOnline);
        document.removeEventListener('visibilitychange', onRoomVisible);
      }
      wb.removeEventListener('change', syncChartTheme);
      wb.removeEventListener('change', disarmCutOnChange);
      unsubscribePageView();
      doc.removeEventListener('status', refreshStatus);
      doc.removeEventListener('draft', refreshStatus);
      doc.removeEventListener('path', refreshTitle);
      toolbar.destroy();
      ink.destroy();
      menubarObserver?.disconnect();
      menubar.destroy();
      keyTips.destroy();
      formulaBar.destroy();
      sheetTabs.destroy();
      statusBar.destroy();
      watchWindow.destroy();
      accessibilityPane.destroy();
      languagePane.destroy();
      changesPane.destroy();
      selectionPane.destroy();
      smartArtPane.destroy();
      errorTag.destroy();
      quickAnalysis.destroy();
      queriesPane.destroy();
      automate?.destroy();
      chartUi.destroy();
      comments.destroy();
      mentionAlerts.stop();
      findBar.destroy();
      aiPanel?.destroy();
      grid.destroy();
      session.removeEventListener?.('change', onSession);
      doc.destroy();
      document.title = 'Spreadsheet';
    },
  };
}
