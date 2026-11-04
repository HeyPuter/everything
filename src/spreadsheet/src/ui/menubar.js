/**
 * The menu bar under the document title: File, Edit, View, Insert, Format,
 * Data, Tools, Help. Each title opens a popover menu built at that moment from
 * the editor's state (checked toggles, the active cell's note or table, what
 * the host can do), so the menus never go stale. Hovering another title while
 * a menu is open switches to it; Left and Right arrows do the same from the
 * keyboard; clicking the open title closes it.
 *
 * Menu items are plain data ({ label, icon, shortcut, cmd, arg, checked,
 * disabled, submenu } or { fn } for the few that are not editor commands) and
 * are mapped onto menu.js items when a menu opens.
 */

import { el, MOD_KEY, IS_MAC } from './dom.js';
import { openMenu } from './menu.js';
import { chartSheetCommand } from '../core/chartsheet.js';
import { CELL_STYLES } from '../core/cellstyles.js';
import { TABLE_STYLES } from '../core/tables.js';
import { GROUP_BLOCKED_COMMANDS, GROUP_BLOCKED_HINT } from '../core/sheet-group.js';
import { withCustomShortcuts } from './custom-shortcuts.js';
import { hasDecimalPlaces } from '../core/format.js';
import { t, tSource } from '../i18n/index.js';

// Each menu's id and the catalog key of its title: the title is looked up where it is drawn (t() at import
// would run before the interface language is loaded).
export const MENU_TITLES = [
  ['file', 'menubar.titles.file'], ['edit', 'menubar.titles.edit'], ['view', 'menubar.titles.view'], ['insert', 'menubar.titles.insert'],
  ['format', 'menubar.titles.format'], ['data', 'menubar.titles.data'], ['tools', 'menubar.titles.tools'], ['help', 'menubar.titles.help'],
];

/** The cell kinds "Select cells of a kind" offers (mirrors Workbook.specialCells). Each label is a getter, read in the interface language when it is shown. */
export const SPECIAL_KINDS = {
  get blanks() { return t('menubar.special.blanks'); },
  get formulas() { return t('menubar.special.formulas'); },
  get constants() { return t('menubar.special.constants'); },
  get numbers() { return t('menubar.special.numbers'); },
  get text() { return t('menubar.special.text'); },
  get errors() { return t('menubar.special.errors'); },
  get notes() { return t('menubar.special.notes'); },
  get currentRegion() { return t('menubar.special.currentRegion'); },
  get rowDiff() { return t('menubar.special.rowDiff'); },
  get colDiff() { return t('menubar.special.colDiff'); },
  get precedents() { return t('menubar.special.precedents'); },
  get dependents() { return t('menubar.special.dependents'); },
  get lastCell() { return t('menubar.special.lastCell'); },
  get visible() { return t('menubar.special.visible'); },
  get conditionalFormats() { return t('menubar.special.conditionalFormats'); },
  get validation() { return t('menubar.special.validation'); },
};

/**
 * The menus for a given editor state. `f` carries the flags the menus depend
 * on: templates, pick, saving, share (the host can share files), mail (email can be sent from here), ai, fullscreen, isFullscreen, filter,
 * aiPanel (the AI assistant is open), hasFormula, hasTable, hasNote, hasLink, sparklines (the sheet holds native
 * sparklines), showFormulas, gridlines, zeros,
 * headers, focus, spell, editing (a cell is being edited, so the commands
 * that act on the sheet behind it wait), singleCell (one unmerged cell is
 * selected, so there is nothing to merge), merged (the selection holds merged
 * cells, which the merge command unmerges), oneRow and oneCol (the selection
 * spans one row or one column, so there is nothing to merge vertically or
 * horizontally), away (the formula being typed is showing another sheet to
 * pick references on, so the items for the active sheet or cell wait),
 * canUndo, canRedo, style (the active cell's style), grouped (several sheets are
 * grouped, so the commands for one sheet's objects wait), and
 * fns { shortcuts, locale, about }.
 */
export function menubarMenus(f = {}) {
  const M = MOD_KEY;
  // macOS takes ⌘+Shift+3, 4, 5 and 6 for screenshots before the page sees them, so on a Mac the number-format and border chords go with Control.
  const K = IS_MAC ? '⌃' : M;
  const i = (label, icon, cmd, arg = null, extra = {}) => ({ label, icon, cmd, arg, ...extra });
  // A submenu is asked for by its catalog key: `name` is its English title, which stays the same in every
  // language, for code that finds a submenu by name (the ribbon's buttons that open one of these).
  const sub = (key, icon, items) => ({ label: t(key), name: tSource(key), icon, submenu: items.filter(Boolean) });
  const fn = (label, icon, func, extra = {}) => func && { label, icon, fn: func, ...extra };
  const sep = { separator: true };
  const st = f.style || {};
  const fmt = st.fmt || 'general';
  // Middle is the default vertical alignment and is stored as no `valign` at all, as the toolbar's own menu reads it.
  const valign = st.valign || 'middle';
  const saving = !!f.saving;
  const editing = !!f.editing;
  // An item whose command does nothing while a cell is being edited (the toolbar greys the same ones out).
  const waits = (item) => (editing && item.cmd ? { ...item, disabled: true } : item);
  // An item for "the active sheet" or "the active cell" while a formula being typed shows another sheet to pick
  // references on: the sheet shown and the formula's own are both candidates (the labels read the one, the
  // commit takes the entry home to the other), so the item waits for the entry to end.
  const home = (item) => (f.away && item.cmd ? { ...item, disabled: true } : item);

  const file = [
    i(t('menubar.file.newSpreadsheet'), 'filePlus', 'new'),
    f.templates && i(t('menubar.file.newFromTemplate'), 'sparkle', 'newFromTemplate'),
    f.pick && i(t('menubar.file.openFromPuter'), 'folderOpen', 'open', null, { shortcut: `${M}+O` }),
    sub('menubar.file.import', 'upload', [
      i(t('menubar.file.fromThisDevice'), 'upload', 'import'),
      i(t('menubar.file.fromAUrl'), 'external', 'importUrl'),
      i(t('menubar.file.intoThisSpreadsheet'), 'sheet', 'importSheets'),
    ]),
    sep,
    i(t('menubar.file.save'), 'save', 'save', null, { shortcut: `${M}+S` }),
    i(t('menubar.file.saveACopy'), 'duplicate', 'saveAs'),
    i(t('menubar.file.rename'), 'pencil', 'rename'),
    (f.share || f.mail) && sub('menubar.file.share', 'share', [
      f.share && i(t('menubar.file.shareWithPeople'), 'share', 'share'),
      f.mail && i(t('menubar.file.sendACopy'), 'sendCopy', 'sendCopy'),
      f.mail && f.share && i(t('menubar.file.sendALink'), 'sendLink', 'sendLink'),
    ]),
    i(t('menubar.file.versionHistory'), 'clock', 'versions'),
    i(t('menubar.file.showChanges'), 'showChanges', 'showChanges', null, { checked: !!f.changesPane }),
    i(t('menubar.file.documentDetails'), 'info', 'docInfo'),
    sep,
    sub(saving ? 'menubar.file.export' : 'menubar.file.download', 'fileDown', [
      i(t('menubar.file.excelWorkbookXlsx'), 'fileDown', 'downloadXlsx'),
      i(t('menubar.file.openDocumentOds'), 'fileDown', 'downloadOds'),
      i(t('menubar.file.sheetAsCsv'), 'fileDown', 'downloadCsv'),
      i(t('menubar.file.sheetAsTsv'), 'fileDown', 'downloadTsv'),
      i(t('menubar.file.sheetAsAWebPageHtml'), 'fileDown', 'downloadHtml'),
      i(t('menubar.file.selectionAsCsv'), 'fileDown', 'downloadRangeCsv'),
      sep,
      i(t('menubar.file.pdf'), 'fileDown', 'exportPdf'),
    ]),
    i(t('menubar.file.print'), 'printer', 'print', null, { shortcut: `${M}+P` }),
    sub('menubar.file.printArea', 'printer', [
      i(t('menubar.file.setPrintArea'), 'printer', 'printArea', 'set'),
      i(t('menubar.file.addToPrintArea'), 'plus', 'printArea', 'add'),
      i(t('menubar.file.clearPrintArea'), 'eraser', 'printArea', 'clear'),
    ].map(waits)),
    sub('menubar.file.pageBreaks', 'breaks', [
      i(t('menubar.file.insertPageBreak'), 'breaks', 'pageBreak', 'insert'),
      i(t('menubar.file.removePageBreak'), 'eraser', 'pageBreak', 'remove'),
      i(t('menubar.file.resetAllPageBreaks'), 'reset', 'pageBreak', 'reset'),
    ].map(waits)),
    sub('menubar.file.sheetBackground', 'background', [
      i(f.background ? t('menubar.file.replaceBackground') : t('menubar.file.backgroundPicture'), 'background', 'sheetBackground', 'pick', { disabled: f.chartSheet }),
      i(t('menubar.file.deleteBackground'), 'deleteItem', 'sheetBackground', 'delete', { disabled: !f.background }),
    ].map(waits)),
    sep,
    i(t('menubar.file.options'), 'options', 'options', null, { shortcut: `${M}+,` }),
    sep,
    i(t('menubar.file.backToAllSpreadsheets'), 'back', 'home'),
  ];

  const edit = [
    i(t('menubar.edit.undo'), 'undo', 'undo', null, { shortcut: `${M}+Z`, disabled: editing || f.canUndo === false }),
    i(t('menubar.edit.redo'), 'redo', 'redo', null, { shortcut: `${M}+Shift+Z`, disabled: editing || f.canRedo === false }),
    sep,
    waits(i(t('menubar.edit.cut'), 'cut', 'cut', null, { shortcut: `${M}+X`, disabled: !!f.chart })),
    waits(i(t('menubar.edit.copy'), 'copy', 'copy', null, { shortcut: `${M}+C` })),
    waits(i(t('menubar.edit.paste'), 'paste', 'paste', null, { shortcut: `${M}+V` })),
    sub('menubar.edit.pasteSpecial', 'paste', [
      i(t('menubar.edit.valuesOnly'), 'paste', 'pasteValues', null, { shortcut: `${M}+Shift+V` }),
      i(t('menubar.edit.formattingOnly'), 'paint', 'pasteFormats'),
      i(t('menubar.edit.formulasOnlyKeepFormatting'), 'fx', 'pasteSpecial', 'formulas'),
      i(t('menubar.edit.transposed'), 'pivot', 'pasteTranspose'),
      i(t('menubar.edit.skipBlanks'), 'paste', 'pasteSpecial', 'skipBlanks'),
      i(t('menubar.edit.columnWidthsOnly'), 'cols', 'pasteSpecial', 'widths'),
      i(t('menubar.edit.linksToTheCopiedCells'), 'link', 'pasteSpecial', 'link'),
      sep,
      i(t('menubar.edit.insertCopiedCellsShiftingDown'), 'arrowDown', 'pasteSpecial', 'insertDown'),
      i(t('menubar.edit.insertCopiedCellsShiftingRight'), 'chevR', 'pasteSpecial', 'insertRight'),
      sep,
      { header: t('menubar.edit.combineWithTheNumbersHere') },
      i(t('menubar.edit.add'), null, 'pasteSpecial', 'add'),
      i(t('menubar.edit.subtract'), null, 'pasteSpecial', 'sub'),
      i(t('menubar.edit.multiply'), null, 'pasteSpecial', 'mul'),
      i(t('menubar.edit.divide'), null, 'pasteSpecial', 'div'),
      sep,
      i(t('menubar.edit.pasteSpecialDialog'), 'paste', 'pasteSpecialMenu', null, { shortcut: IS_MAC ? '⌃+⌘+V' : `${M}+Alt+V` }),
    ].map(waits)),
    i(t('menubar.edit.copyLinkToThisCellOrRange'), 'link', 'copyLink'),
    sep,
    sub('menubar.edit.fill', 'arrowDown', [
      waits(i(t('menubar.edit.down'), 'fillDown', 'fillDown', null, { shortcut: `${M}+D` })),
      waits(i(t('menubar.edit.right'), 'fillRight', 'fillRight', null, { shortcut: `${M}+R` })),
      waits(i(t('menubar.edit.up'), 'fillUp', 'fillUp')),
      waits(i(t('menubar.edit.left'), 'fillLeft', 'fillLeft')),
      i(t('menubar.edit.series'), 'series', 'fillSeries'),
      waits(i(t('menubar.edit.justify'), 'alignLeft', 'fillJustify')),
      waits(i(t('menubar.edit.flashFill'), 'flashFill', 'flashFill', null, { shortcut: `${M}+E` })),
      waits(i(t('menubar.edit.acrossWorksheets'), 'layers', 'fillAcrossSheets', null, f.grouped ? {} : { disabled: true, hint: t('menubar.edit.groupSheetsFirst', { key: IS_MAC ? '⌘' : 'Ctrl' }) })),
      sep,
      i(t('menubar.edit.todaysDate'), 'calendar', 'insertDate', null, { shortcut: `${M}+;` }),
      i(t('menubar.edit.theCurrentTime'), 'clock', 'insertTime', null, { shortcut: `${M}+Shift+;` }),
      i(t('menubar.edit.theFormulaFromTheCellAbove'), 'fx', 'copyAbove', 'formula', { shortcut: `${M}+'` }),
    ]),
    sep,
    i(t('menubar.edit.findAndReplace'), 'search', 'find', null, { shortcut: `${M}+F` }),
    i(t('menubar.edit.goToCellOrRange'), 'search', 'goTo', null, { shortcut: `${M}+G` }),
    sub('menubar.edit.select', 'check', [
      i(t('menubar.edit.all'), 'check', 'selectAll', null, { shortcut: `${M}+A` }),
      sep,
      { header: t('menubar.edit.cellsOfAKind') },
      ...Object.entries(SPECIAL_KINDS).map(([kind, label]) => i(label, null, 'selectSpecial', kind)),
    ]),
    sep,
    sub('menubar.edit.delete', 'trash', [
      i(t('menubar.edit.rows'), 'rows', 'deleteRows', null, { shortcut: `${M}+-` }),
      i(t('menubar.edit.columns'), 'cols', 'deleteCols'),
      i(t('menubar.edit.cellsShiftingUp'), 'arrowUp', 'deleteCells', 'up'),
      i(t('menubar.edit.cellsShiftingLeft'), 'chevL', 'deleteCells', 'left'),
    ]),
    waits(i(t('menubar.edit.clearContents'), 'eraser', 'clear', null, { shortcut: 'Delete' })),
    i(t('menubar.edit.clearFormatting'), 'eraser', 'clearFormat', null),
    sep,
    i(t('menubar.edit.recalculateAllFormulas'), 'reset', 'recalc', null, { shortcut: 'F9' }),
  ];

  const view = [
    // The sheet's view comes first.
    i(t('menubar.view.normal'), 'normalView', 'viewMode', 'normal', { checked: (f.viewMode || 'normal') === 'normal', disabled: f.chartSheet }),
    i(t('menubar.view.pageLayout'), 'pageLayout', 'viewMode', 'pageLayout', { checked: f.viewMode === 'pageLayout', disabled: f.chartSheet }),
    i(t('menubar.view.pageBreakPreview'), 'pageBreak', 'viewMode', 'pageBreak', { checked: f.viewMode === 'pageBreak', disabled: f.chartSheet }),
    waits(i(t('menubar.view.customViews'), 'customViews', 'customViews')),
    sub('menubar.view.sheetView', 'sheetView', [
      i(t('menubar.view.default'), null, 'sheetView', { action: 'switch', id: null }, { checked: !f.sheetView, disabled: f.chartSheet }),
      sep,
      i(t('menubar.view.newSheetView'), 'sheetView', 'sheetView', 'new', { disabled: f.chartSheet }),
      i(t('menubar.view.keep'), 'save', 'sheetView', 'keep', { disabled: !f.sheetView?.temporary }),
      i(t('menubar.view.exit'), 'exitView', 'sheetView', 'exit', { disabled: !f.sheetView }),
      i(t('menubar.view.options'), 'sliders', 'sheetView', 'options', { disabled: f.chartSheet }),
    ].map(waits)),
    sep,
    i(t('menubar.view.showFormulas'), 'fx', 'showFormulas', null, { shortcut: `${K}+\``, checked: !!f.showFormulas }),
    i(t('menubar.view.gridlines'), 'borders', 'gridlines', null, { checked: f.gridlines !== false }),
    i(t('menubar.view.showZeros'), 'eye', 'zeros', null, { checked: f.zeros !== false }),
    i(t('menubar.view.rowAndColumnHeaders'), 'borders', 'toggleHeaders', null, { checked: f.headers !== false }),
    i(t('menubar.view.formulaBar'), 'fx', 'formulaBar', null, { checked: f.formulaBar !== false }),
    i(t('menubar.view.pageBreaks'), 'pageBreak', 'showPageBreaks', null, { checked: !!f.showPageBreaks, disabled: f.chartSheet || (f.viewMode && f.viewMode !== 'normal') }),
    sep,
    sub('menubar.view.freeze', 'pin', [
      i(t('menubar.view.firstRow'), 'pin', 'freeze', { rows: 1 }),
      i(t('menubar.view.firstColumn'), 'pin', 'freeze', { cols: 1 }),
      i(t('menubar.view.rowsUpToTheSelection'), 'pin', 'freeze', 'rows'),
      i(t('menubar.view.columnsUpToTheSelection'), 'pin', 'freeze', 'cols'),
      sep,
      i(t('menubar.view.unfreeze'), 'reset', 'freeze', 'none'),
    ]),
    i(t('menubar.view.split'), 'split', 'split', null, { checked: !!f.split }),
    sub('menubar.view.hideAndUnhide', 'eyeOff', [
      i(t('menubar.view.hideRows'), 'eyeOff', 'hide', 'row', { shortcut: `${M}+9` }),
      i(t('menubar.view.hideColumns'), 'eyeOff', 'hide', 'col', { shortcut: `${M}+0` }),
      sep,
      i(t('menubar.view.unhideRows'), 'eye', 'unhide', 'row', { shortcut: `${M}+Shift+9` }),
      i(t('menubar.view.unhideColumns'), 'eye', 'unhide', 'col', { shortcut: `${M}+Shift+0` }),
    ]),
    sub('menubar.view.group', 'rows', [
      i(t('menubar.view.groupRows'), 'rows', 'group', 'row', { shortcut: 'Alt+Shift+Right' }),
      i(t('menubar.view.groupColumns'), 'cols', 'group', 'col'),
      i(t('menubar.view.ungroupRows'), 'rows', 'ungroup', 'row', { shortcut: 'Alt+Shift+Left' }),
      i(t('menubar.view.ungroupColumns'), 'cols', 'ungroup', 'col'),
      sep,
      i(t('menubar.view.collapseAllRowGroups'), 'chevU', 'collapseAll', 'row'),
      i(t('menubar.view.expandAllRowGroups'), 'chevD', 'expandAll', 'row'),
      i(t('menubar.view.collapseAllColumnGroups'), 'chevL', 'collapseAll', 'col'),
      i(t('menubar.view.expandAllColumnGroups'), 'chevR', 'expandAll', 'col'),
    ]),
    sep,
    sub('menubar.view.zoom', 'zoomIn', [
      i(t('menubar.view.customZoom'), 'zoomIn', 'zoomCustom'),
      i(t('menubar.view.zoomIn'), 'zoomIn', 'zoom', 0.1),
      i(t('menubar.view.zoomOut'), 'zoomOut', 'zoom', -0.1),
      i(t('menubar.view.resetTo100'), 'reset', 'zoom', 'reset'),
    ]),
    i(t('menubar.view.focusMode'), 'eyeOff', 'focusMode', null, { checked: !!f.focus }),
    f.ai && i(t('menubar.view.aiAssistant'), 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, checked: !!f.aiPanel }),
    f.fullscreen && i(t('menubar.view.fullScreen'), 'monitor', 'fullscreen', null, { checked: !!f.isFullscreen }),
  ];

  const insert = [
    sub('menubar.insert.rowsAndColumns', 'rows', [
      i(t('menubar.insert.rowAbove'), 'arrowUp', 'insertRows', 'above', { shortcut: `${M}+Shift+=` }),
      i(t('menubar.insert.rowBelow'), 'arrowDown', 'insertRows', 'below'),
      sep,
      i(t('menubar.insert.columnLeft'), 'chevL', 'insertCols', 'left'),
      i(t('menubar.insert.columnRight'), 'chevR', 'insertCols', 'right'),
    ]),
    sub('menubar.insert.cells', 'borders', [
      i(t('menubar.insert.cellsShiftingDown'), 'arrowDown', 'insertCells', 'down'),
      i(t('menubar.insert.cellsShiftingRight'), 'chevR', 'insertCells', 'right'),
      sep,
      waits(i(t('menubar.insert.copiedCells'), 'paste', 'insertCopiedCells', null, { disabled: editing || !f.copiedCells })),
    ]),
    sep,
    i(t('menubar.insert.chart'), 'chartColumn', 'insertChart'),
    i(t('menubar.insert.sparklines'), 'chartLine', 'insertSparklines'),
    sub('menubar.insert.image', 'image', [
      i(t('menubar.insert.fromThisDevice'), 'image', 'insertImage'),
      f.pick && i(t('menubar.insert.fromPuter'), 'folderOpen', 'insertImagePuter'),
      i(t('menubar.insert.fromAUrl'), 'external', 'insertImageUrl'),
      sep,
      // The picture as the active cell's value, sized to the cell: it moves, sorts and copies with it.
      sub('menubar.insert.placeInCell', 'placeInCell', [
        i(t('menubar.insert.fromThisDevice'), 'image', 'insertImage', 'cell'),
        f.pick && i(t('menubar.insert.fromPuter'), 'folderOpen', 'insertImagePuter', 'cell'),
        i(t('menubar.insert.fromAUrl'), 'external', 'insertImageUrl', 'cell'),
      ]),
    ]),
    i(t('menubar.insert.textBox'), 'text', 'insertTextBox'),
    i(t('menubar.insert.smartArt'), 'smartArt', 'smartArt', { action: 'insertDialog' }),
    i(t('menubar.insert.slicer'), 'slicer', 'insertSlicer', null, { disabled: !f.hasTable && !f.pivotReport }),
    i(t('menubar.insert.timeline'), 'timeline', 'insertTimeline', null, { disabled: !f.pivotReport }),
    sep,
    sub('menubar.insert.function', 'sigma', [
      i(t('menubar.insert.functionList'), 'sigma', 'functionMenu', null, { shortcut: 'Shift+F3' }),
      i(t('menubar.insert.insertFunctionDialog'), 'fx', 'insertFunctionDialog'),
      i(t('menubar.insert.autoSum'), 'sigma', 'autosum', null, { shortcut: 'Alt+=' }),
      i(t('menubar.insert.sparkline'), 'chartLine', 'insertFunction', 'SPARKLINE'),
    ]),
    i(t('menubar.insert.checkbox'), 'check', 'insertCheckbox'),
    i(t('menubar.insert.dropdown'), 'chevD', 'insertDropdown'),
    i(t('menubar.insert.datePicker'), 'calendar', 'datePicker'),
    sep,
    home(i(t('menubar.insert.link'), 'link', 'link', null, { shortcut: `${M}+K` })),
    f.hasLink && home(i(t('menubar.insert.removeLink'), 'unlink', 'unlink')),
    home(i(f.hasNote ? t('menubar.insert.editNote') : t('menubar.insert.note'), 'note', 'note', null, { shortcut: 'Shift+F2' })),
    f.hasNote && home(i(t('menubar.insert.deleteNote'), 'trash', 'deleteNote')),
    !f.hasNote && home(i(f.hasComment ? t('menubar.insert.replyToComment') : t('menubar.insert.comment'), 'comment', f.hasComment ? 'replyComment' : 'newComment', null, { shortcut: `${M}+Shift+F2` })),
    f.hasComment && home(i(t('menubar.insert.deleteComment'), 'deleteComment', 'deleteComment')),
    sep,
    // What the sheet tab's menu offers, for the active sheet, with the same greying: the last sheet showing cannot be
    // hidden or deleted, an end one not moved past the end, and under Protect Workbook (`locked`) no sheet is added,
    // renamed, coloured, moved, hidden or deleted. Delete asks first only when the sheet holds work.
    sub('menubar.insert.sheet', 'sheet', [
      i(t('menubar.insert.newSheet'), 'plus', 'newSheet', null, { shortcut: 'Shift+F11', disabled: !!f.sheet?.locked }),
      ...[
        i(t('menubar.insert.duplicateSheet'), 'duplicate', 'duplicateSheet', null, { disabled: !!f.sheet?.locked }),
        i(t('menubar.insert.moveOrCopySheet'), 'layers', 'moveOrCopySheet', null, { disabled: !!f.sheet?.locked }),
        i(t('menubar.insert.copySheetToAnotherSpreadsheet'), 'copy', 'copySheetTo'),
        i(t('menubar.insert.renameSheet'), 'pencil', 'renameSheet', null, { disabled: !!f.sheet?.locked }),
        i(t('menubar.insert.sheetColor'), 'fill', 'sheetColor', null, { disabled: !!f.sheet?.locked }),
        sep,
        i(t('menubar.insert.moveSheetLeft'), 'chevL', 'moveSheet', 'left', { disabled: !!f.sheet?.first || !!f.sheet?.locked }),
        i(t('menubar.insert.moveSheetRight'), 'chevR', 'moveSheet', 'right', { disabled: !!f.sheet?.last || !!f.sheet?.locked }),
        sep,
        i(f.sheet?.protected ? t('menubar.insert.unprotectSheet') : t('menubar.insert.protectSheet'), 'lock', 'protectSheet'),
        i(t('menubar.insert.hideSheet'), 'eyeOff', 'hideSheet', null, { disabled: !!f.sheet?.only || !!f.sheet?.locked }),
        i(f.sheet?.holdsWork ? t('menubar.insert.deleteSheetAsk') : t('menubar.insert.deleteSheet'), 'trash', 'deleteSheet', null, { disabled: !!f.sheet?.only || !!f.sheet?.locked, danger: true }),
      ].map(home),
      sep,
      // Grouping: edits on the sheet in view reach every grouped sheet (Shift- or Ctrl-click the tabs to pick some).
      f.grouped ? i(t('menubar.insert.ungroupSheets'), 'layers', 'ungroupSheets') : i(t('menubar.insert.selectAllSheets'), 'layers', 'selectAllSheets', null, { disabled: !!f.sheet?.only }),
    ]),
  ];

  // One choice of several is a radio item, so a screen reader does not call a number format or an alignment a checkbox.
  const fmtItem = (label, icon, value, shortcut) => i(label, icon, 'fmt', value, { checked: fmt === value, radio: true, shortcut });
  const noDecimals = !hasDecimalPlaces(st);
  // The sparkline commands lead the menu only on a sheet that holds sparklines: elsewhere they could only
  // answer that there is none, and they pushed Number and Text down on every sheet.
  const sparklines = f.sparklines ? [
    i(t('menubar.format.sparklineSettings'), 'chartLine', 'editSparkline'),
    sub('menubar.format.sparklineGrouping', 'chartLine', [
      i(t('menubar.format.groupUsingActiveSparkline'), 'chartLine', 'groupSparklines'),
      i(t('menubar.format.ungroupSelectedSparklines'), 'chartLine', 'groupSparklines', 'ungroup'),
    ]),
    sub('menubar.format.clearSparklines', 'eraser', [
      i(t('menubar.format.selectedSparklines'), 'eraser', 'clearSparklines'),
      i(t('menubar.format.entireSelectedGroups'), 'eraser', 'clearSparklines', 'groups'),
    ]),
    sep,
  ] : [];
  const format = [
    ...sparklines,
    sub('menubar.format.numberMenu', 'number', [
      fmtItem(t('menubar.format.automatic'), 'text', 'general', `${K}+Shift+~`),
      fmtItem(t('menubar.format.number'), 'number', 'number', `${K}+Shift+!`),
      fmtItem(t('menubar.format.currency'), 'currency', 'currency', `${K}+Shift+$`),
      fmtItem(t('menubar.format.percent'), 'percent', 'percent', `${K}+Shift+%`),
      fmtItem(t('menubar.format.date'), 'calendar', 'date', `${K}+Shift+#`),
      fmtItem(t('menubar.format.time'), 'clock', 'time', `${K}+Shift+@`),
      fmtItem(t('menubar.format.scientific'), 'number', 'scientific', `${K}+Shift+^`),
      fmtItem(t('menubar.format.plainText'), 'text', 'text'),
      sep,
      // Dates, times, text and custom codes have no decimal places to step, as the toolbar shows.
      waits(i(t('menubar.format.moreDecimalPlaces'), 'decMore', 'dec', 1, { disabled: noDecimals })),
      waits(i(t('menubar.format.fewerDecimalPlaces'), 'decLess', 'dec', -1, { disabled: noDecimals })),
      sep,
      i(t('menubar.format.moreFormats'), 'sliders', 'formatCells', 'number'),
    ]),
    sub('menubar.format.text', 'bold', [
      i(t('menubar.format.bold'), 'bold', 'bold', null, { shortcut: `${M}+B`, checked: !!st.bold }),
      i(t('menubar.format.italic'), 'italic', 'italic', null, { shortcut: `${M}+I`, checked: !!st.italic }),
      i(t('menubar.format.underline'), 'underline', 'underline', null, { shortcut: `${M}+U`, checked: !!st.underline }),
      i(t('menubar.format.strikethrough'), 'strike', 'strike', null, { shortcut: `${M}+5`, checked: !!st.strike }),
      sep,
      i(t('menubar.format.largerFont'), 'fontSize', 'fontStep', 1, { shortcut: `${M}+Shift+>` }),
      i(t('menubar.format.smallerFont'), 'fontSize', 'fontStep', -1, { shortcut: `${M}+Shift+<` }),
      i(t('menubar.format.customFontSize'), 'fontSize', 'fontSize'),
    ]),
    sub('menubar.format.alignment', 'alignLeft', [
      i(t('menubar.format.left'), 'alignLeft', 'align', 'left', { checked: st.align === 'left', radio: true }),
      i(t('menubar.format.center'), 'alignCenter', 'align', 'center', { checked: st.align === 'center', radio: true }),
      i(t('menubar.format.right'), 'alignRight', 'align', 'right', { checked: st.align === 'right', radio: true }),
      sep,
      // A cell with no `valign` is ticked Middle, as the toolbar's vertical-align menu ticks it: a radio
      // group with nothing chosen leaves a screen reader saying none of the three is in force.
      i(t('menubar.format.top'), 'arrowUp', 'valign', 'top', { checked: valign === 'top', radio: true }),
      i(t('menubar.format.middle'), 'borderTop', 'valign', 'middle', { checked: valign === 'middle', radio: true }),
      i(t('menubar.format.bottom'), 'arrowDown', 'valign', 'bottom', { checked: valign === 'bottom', radio: true }),
      sep,
      i(t('menubar.format.increaseIndent'), 'indentMore', 'indent', 1),
      i(t('menubar.format.decreaseIndent'), 'indentLess', 'indent', -1),
    ]),
    sub('menubar.format.wrapping', 'wrap', [
      i(t('menubar.format.overflow'), 'chevR', 'wrapMode', 'overflow', { checked: !st.wrap && !st.clip, radio: true }),
      i(t('menubar.format.wrap'), 'wrap', 'wrapMode', 'wrap', { checked: !!st.wrap, radio: true }),
      i(t('menubar.format.clip'), 'x', 'wrapMode', 'clip', { checked: !st.wrap && !!st.clip, radio: true }),
    ]),
    sub('menubar.format.rotation', 'text', [
      i(t('menubar.format.none'), 'text', 'rotate', 0, { checked: !st.rot, radio: true }),
      i(t('menubar.format.tiltUp45'), 'text', 'rotate', 45, { checked: st.rot === 45, radio: true }),
      i(t('menubar.format.tiltDown45'), 'text', 'rotate', -45, { checked: st.rot === -45, radio: true }),
      i(t('menubar.format.rotateUp90'), 'text', 'rotate', 90, { checked: st.rot === 90, radio: true }),
      i(t('menubar.format.rotateDown90'), 'text', 'rotate', -90, { checked: st.rot === -90, radio: true }),
      sep,
      // Any angle from −90 to 90, asked for in a dialog; the command clamps and rounds it.
      i(t('menubar.format.customAngle'), 'text', 'rotate', 'custom'),
    ]),
    sub('menubar.format.borders', 'borders', [
      i(t('menubar.format.allBorders'), 'borders', 'borders', 'all'),
      i(t('menubar.format.outerBorders'), 'borderOuter', 'borders', 'outer', { shortcut: `${K}+Shift+&` }),
      i(t('menubar.format.innerBorders'), 'borders', 'borders', 'inner'),
      sep,
      i(t('menubar.format.noBorders'), 'borderNone', 'borders', 'none', { shortcut: `${K}+Shift+_` }),
    ]),
    sep,
    sub('menubar.format.mergeCells', 'merge', [
      f.merged ? i(t('menubar.format.unmergeCells'), 'unmerge', 'merge') : i(t('menubar.format.mergeAndCenter'), 'merge', 'merge', null, { disabled: !!f.singleCell }),
      i(t('menubar.format.mergeHorizontally'), 'rows', 'mergeAcross', null, { disabled: !!f.singleCell || !!f.oneCol }),
      i(t('menubar.format.mergeVertically'), 'cols', 'mergeDown', null, { disabled: !!f.singleCell || !!f.oneRow }),
    ].map(waits)),
    sub('menubar.format.rowsAndColumns', 'cols', [
      i(t('menubar.format.fitColumnsToContent'), 'cols', 'autofit'),
      i(t('menubar.format.fitRowsToContent'), 'rows', 'fitRows'),
      sep,
      i(t('menubar.format.resizeColumns'), 'cols', 'resizeCols'),
      i(t('menubar.format.resizeRows'), 'rows', 'resizeRows'),
    ]),
    sep,
    i(t('menubar.format.conditionalFormatting'), 'highlighter', 'condFormat'),
    i(t('menubar.format.alternatingColors'), 'rows', 'bands'),
    sub('menubar.format.cellStyles', 'paint', [
      ...CELL_STYLES.map((s) => i(s.label, null, 'cellStyle', s.key, {
        // A sample of the style as it would look on the sheet: on paper, whatever the app's theme. A preset
        // that names no ink or fill of its own shows the paper's, as the cell it makes will; the menu's own
        // dark tokens made a Note sample near-white ink on its pale yellow fill, and a Heading navy on black.
        paper: true,
        style: { color: s.patch.color || 'var(--ink)', background: s.patch.bg || 'var(--surface)', fontWeight: s.patch.bold ? '700' : '400', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--hairline)' },
      })),
      // The workbook's own styles, then the tools that make, change and bring in styles.
      (f.customCellStyles || []).length && sep,
      (f.customCellStyles || []).length && { header: t('menubar.format.custom') },
      ...(f.customCellStyles || []).map((name) => i(name, null, 'cellStyle', { custom: name })),
      sep,
      waits(i(t('menubar.format.newCellStyle'), 'plus', 'newCellStyle')),
      sub('menubar.format.modifyAStyle', 'pencil', [
        ...CELL_STYLES.map((s) => i(s.label, null, 'modifyCellStyle', s.key)),
        ...(f.customCellStyles || []).map((name) => i(name, null, 'modifyCellStyle', { custom: name })),
      ].map(waits)),
      (f.customCellStyles || []).length > 1 && sub('menubar.format.deleteAStyle', 'trash', (f.customCellStyles || []).map((name) => i(name, null, 'deleteCellStyle', { custom: name })).map(waits)),
      (f.customCellStyles || []).length === 1 && waits(i(t('menubar.format.deleteStyleNamed', { name: f.customCellStyles[0] }), 'trash', 'deleteCellStyle', { custom: f.customCellStyles[0] })),
      waits(i(t('menubar.format.mergeStyles'), 'paint', 'mergeCellStyles')),
    ]),
    i(t('menubar.format.paintFormat'), 'paint', 'paintFormat'),
    sep,
    i(t('menubar.format.formatCells'), 'formatCells', 'formatCells', null, { shortcut: `${M}+1` }),
    i(t('menubar.format.clearFormatting'), 'eraser', 'clearFormat', null),
  ];

  const data = [
    sub('menubar.data.sort', 'sortAsc', [
      i(t('menubar.data.sortRangeAToZ'), 'sortAsc', 'sort', 'asc'),
      i(t('menubar.data.sortRangeZToA'), 'sortDesc', 'sort', 'desc'),
      i(t('menubar.data.sortRange'), 'sliders', 'sortDialog'),
      sep,
      i(t('menubar.data.randomizeRange'), 'sortAsc', 'shuffle'),
    ]),
    // A checked item keeps one name, as Home ▸ Sort & Filter ▸ Filter does: "Remove filter, checked" read as both an action and a state.
    i(t('menubar.data.filter'), 'filter', 'filter', null, { shortcut: `${M}+Shift+L`, checked: !!f.filter }),
    sep,
    f.hasTable ? i(t('menubar.data.editTable'), 'table', 'editTable') : i(t('menubar.data.createTable'), 'table', 'insertTable'),
    f.hasTable && i(t('menubar.data.totalRow'), 'sigma', 'tableTotals', null, { checked: !!f.table?.totalsRow, disabled: editing || !!f.away || !!f.sheet?.protected }),
    f.hasTable && sub('menubar.data.tableTools', 'table', [
      i(t('menubar.data.summarizeWithPivotTable'), 'pivot', 'tableSource', 'pivot'),
      i(t('menubar.data.removeDuplicates'), 'dedupe', 'tableSource', 'dedupe'),
      i(t('menubar.data.resizeTable'), 'resizeTable', 'tableResize'),
      i(t('menubar.data.insertSlicer'), 'slicer', 'insertSlicer'),
    ].map(item => ({ ...item, disabled: editing || !!f.away || !!f.sheet?.protected }))),
    f.hasTable && sub('menubar.data.tableOptions', 'table', [
      i(t('menubar.data.headerRow'), 'table', 'tableOption', 'headerRow', { checked: f.table?.headerRow !== false }),
      ...[['banded', t('menubar.data.bandedRows')], ['bandedColumns', t('menubar.data.bandedColumns')], ['firstColumn', t('menubar.data.firstColumn')], ['lastColumn', t('menubar.data.lastColumn')]].map(([key, label]) =>
        i(label, 'table', 'tableOption', key, { checked: key === 'banded' ? f.table?.banded !== false : !!f.table?.[key] })),
      i(t('menubar.data.filterButton'), 'table', 'tableOption', 'filterButton', { checked: !!f.tableFilterButton, disabled: f.table?.headerRow === false }),
      sub('menubar.data.tableStyles', 'paint', TABLE_STYLES.map(([key, label]) =>
        i(label, 'table', 'tableStyle', key, { checked: !f.table?.customStyle && f.table?.style === key, radio: true }))),
      i(t('menubar.data.convertToRange'), 'table', 'tableConvert'),
    ].map(item => ({ ...item, disabled: !!item.disabled || editing || !!f.away || !!f.sheet?.protected,
      ...(item.submenu && { submenu: item.submenu.map(child => ({ ...child, disabled: editing || !!f.away || !!f.sheet?.protected })) }) }))),
    i(t('menubar.data.pivotTable'), 'pivot', 'pivot'),
    i(t('menubar.data.subtotals'), 'sigma', 'subtotal'),
    sub('menubar.data.outline', 'group', [
      i(t('menubar.data.autoOutline'), 'group', 'autoOutline'),
      i(t('menubar.data.clearOutline'), 'eraser', 'clearOutline'),
      sep,
      i(t('menubar.data.outlineSettings'), 'sliders', 'outlineSettings'),
    ].map(waits)),
    i(t('menubar.data.columnStats'), 'chartColumn', 'columnStats'),
    i(t('menubar.data.goalSeek'), 'sliders', 'goalSeek'),
    i(t('menubar.data.dataTable'), 'table', 'dataTable'),
    i(t('menubar.data.scenarioManager'), 'scenarioManager', 'scenarioManager'),
    i(t('menubar.data.forecastSheet'), 'forecast', 'forecastSheet'),
    i(t('menubar.data.solver'), 'solver', 'solver'),
    i(t('menubar.data.dataAnalysis'), 'dataAnalysis', 'dataAnalysis'),
    i(t('menubar.data.advancedFilter'), 'filterAdvanced', 'advancedFilter'),
    i(t('menubar.data.form'), 'dataForm', 'dataForm'),
    f.ai && i(t('menubar.data.askAiAboutThisData'), 'sparkle', 'aiAsk'),
    sep,
    i(t('menubar.data.dataValidation'), 'validation', 'validation'),
    i(t('menubar.data.textToColumns'), 'cols', 'splitTextDialog'),
    i(t('menubar.data.namedRanges'), 'tag', 'names'),
    i(t('menubar.data.defineName'), 'tag', 'defineName'),
    i(t('menubar.data.createNamesFromSelection'), 'tag', 'createNames'),
    i(t('menubar.data.protectedRanges'), 'lock', 'protectRanges'),
    i(t('menubar.data.editLinks'), 'editLinks', 'editLinks'),
    sep,
    sub('menubar.data.dataCleanup', 'dedupe', [
      i(t('menubar.data.removeDuplicateRows'), 'dedupe', 'dedupe'),
      i(t('menubar.data.removeEmptyRows'), 'rows', 'removeEmptyRows'),
      sep,
      i(t('menubar.data.trimWhitespace'), 'text', 'textCase', 'trim'),
      i(t('menubar.data.convertTextToNumbers'), 'number', 'textCase', 'number'),
      i(t('menubar.data.splitTextToColumns'), 'cols', 'splitText'),
      sep,
      { header: t('menubar.data.changeCase') },
      i(t('menubar.data.uppercase'), 'text', 'textCase', 'upper'),
      i(t('menubar.data.lowercase'), 'text', 'textCase', 'lower'),
      i(t('menubar.data.capitalizeEachWord'), 'text', 'textCase', 'proper'),
    ]),
  ];

  const tools = [
    i(t('menubar.tools.evaluateFormulaStepByStep'), 'fx', 'evaluateFormula', null, { disabled: !f.hasFormula }),
    i(t('menubar.tools.showPrecedents'), 'fx', 'trace', 'precedents', { shortcut: `${M}+[`, disabled: !f.hasFormula }),
    i(t('menubar.tools.showDependents'), 'fx', 'trace', 'dependents', { shortcut: `${M}+]` }),
    i(t('menubar.tools.removeTraceHighlights'), 'eraser', 'clearTrace'),
    i(t('menubar.tools.replaceFormulasWithValues'), 'number', 'toValues'),
    f.ai && sep,
    f.ai && i(t('menubar.tools.aiAssistant'), 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, checked: !!f.aiPanel }),
    f.ai && i(t('menubar.tools.writeAFormulaWithAi'), 'sparkle', 'aiFormula'),
    f.ai && i(t('menubar.tools.explainThisFormulaAi'), 'sparkle', 'aiExplain', null, { disabled: !f.hasFormula }),
    sep,
    i(t('menubar.tools.spelling'), 'spell', 'spelling', null, { shortcut: 'F7' }),
    i(t('menubar.tools.thesaurus'), 'thesaurus', 'thesaurus', null, { shortcut: 'Shift+F7', checked: f.languagePane === 'thesaurus' }),
    i(t('menubar.tools.translate'), 'translate', 'translatePane', null, { checked: f.languagePane === 'translate' }),
    sub('menubar.tools.automate', 'codeEditor', [
      i(t('menubar.tools.codeEditor'), 'codeEditor', 'scriptsPane', null, { checked: !!f.scriptsPane }),
      i(t('menubar.tools.newScript'), 'newScript', 'newScript'),
      i(t('menubar.tools.runScript'), 'runScript', 'runScript', null, { disabled: !!f.scriptRunning }),
      i(f.recording ? t('menubar.tools.stopRecording') : t('menubar.tools.recordActions'), 'recordActions', 'recordActions', null, { checked: !!f.recording }),
      i(t('menubar.tools.allScripts'), 'allScripts', 'scriptGallery'),
      i(t('menubar.tools.scriptReference'), 'scriptReference', 'scriptReference'),
    ]),
    i(t('menubar.tools.checkSpellingAsYouType'), 'text', 'toggleSpellcheck', null, { checked: f.spell !== false }),
    i(t('menubar.tools.autoCorrectOptions'), 'autoCorrect', 'autoCorrectOptions'),
    fn(t('menubar.tools.regionalFormat'), 'monitor', f.fns?.locale),
    sep,
    i(t('menubar.tools.customizeTheRibbon'), 'customizeRibbon', 'options', 'ribbon'),
    i(t('menubar.tools.customizeQuickAccessToolbar'), 'customizeQuickAccess', 'options', 'quickAccess'),
    i(t('menubar.tools.customizeKeyboard'), 'customizeKeyboard', 'options', 'keyboard'),
    i(t('menubar.tools.options'), 'options', 'options', null, { shortcut: `${M}+,` }),
  ];

  const help = [
    i(t('menubar.help.searchTheMenus'), 'search', 'palette', null, { shortcut: `${M}+Shift+P` }),
    fn(t('menubar.help.keyboardShortcuts'), 'keyboard', f.fns?.shortcuts),
    f.fns?.about && sep,
    fn(t('menubar.help.aboutSpreadsheet'), 'info', f.fns?.about),
  ];

  const lists = { file, edit, view, insert, format, data, tools, help };
  const capabilities = items => items.map(item => item && (item.submenu
    ? { ...item, submenu: capabilities(item.submenu) }
    : f.chartSheet && item.cmd && !chartSheetCommand(item.cmd) ? { ...item, disabled: true }
      // Grouped sheets: a command for one sheet's objects waits, and says why.
      : f.grouped && item.cmd && GROUP_BLOCKED_COMMANDS.has(item.cmd) ? { ...item, disabled: true, hint: GROUP_BLOCKED_HINT } : item));
  return MENU_TITLES.map(([id, title]) => ({ id, label: t(title), items: withCustomShortcuts(tidy(capabilities(lists[id]))) }));
}

/** Drop false entries and separators that would sit at an edge or beside another. */
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
    out.push(it.submenu ? { ...it, submenu: tidy(it.submenu) } : it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** Every leaf item (through submenus) of a menu list. */
export function menuLeaves(items) {
  const out = [];
  for (const it of items) {
    if (it.submenu) out.push(...menuLeaves(it.submenu));
    else if (it.label && (it.cmd || it.fn)) out.push(it);
  }
  return out;
}

/**
 * Build the bar. `flags()` returns the state menubarMenus needs, `run(cmd,
 * arg)` runs an editor command, `onClose(reason)` runs when a menu closes, with
 * the menu's reason ('select', 'escape', 'tab', 'outside', 'api', …), so the
 * editor can put focus back on the grid after a choice and leave it on the
 * title after Escape.
 */
export function createMenubar({ flags, run, onClose = null }) {
  const root = el('nav.menubar', { role: 'menubar', 'aria-label': t('menubar.menus') });
  const buttons = [];
  let openId = null;

  for (const [id, title] of MENU_TITLES) {
    const btn = el('button.menubar-btn', {
      type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: buttons.length ? -1 : 0,
      'data-menu': id,
      onclick: () => (openId === id ? closeOpen() : open(id)),
      // A finger cannot hover, but a tap fires pointerenter on its way to click: switching here too would
      // open the tapped menu, and the click would then find it open and close it.
      onpointerenter: (e) => { if (e.pointerType !== 'touch' && openId && openId !== id) open(id); },
      onfocus: () => setTabStop(btn),
      onkeydown: (e) => {
        const at = buttons.indexOf(btn);
        if (e.key === 'ArrowRight') { e.preventDefault(); buttons[(at + 1) % buttons.length].focus(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); buttons[(at - 1 + buttons.length) % buttons.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus(); }
        // Down opens the menu on its first item and Up on its last, as a menu bar's titles do.
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(id, { last: e.key === 'ArrowUp' }); }
      },
    }, t(title));
    buttons.push(btn);
    root.append(btn);
  }

  /** Roving tabindex: Tab lands on the title used last. */
  function setTabStop(btn) {
    for (const b of buttons) b.tabIndex = b === btn ? 0 : -1;
  }

  let closeCurrent = null;
  function closeOpen() { closeCurrent?.(); }

  function open(id, { last = false } = {}) {
    const at = MENU_TITLES.findIndex(([k]) => k === id);
    const btn = buttons[at];
    const def = menubarMenus(flags()).find((m) => m.id === id);
    openId = id;
    // Hand over from the open menu before this one opens, then take focus: the
    // menu remembers what was focused as it opened and returns there on Escape,
    // which must be this title rather than the one that opened the first menu.
    closeCurrent?.();
    closeCurrent = null;
    btn.focus({ preventScroll: true });
    setTabStop(btn);
    for (const b of buttons) b.classList.toggle('open', b === btn);
    const api = openMenu({
      anchor: btn, opener: btn, items: toMenuItems(def.items, run), label: def.label, minWidth: 260,
      // Left and Right at the top level, and Right on a submenu item with nothing more to open, move on to the neighbouring title.
      onNavigate: (dir) => open(MENU_TITLES[(at + dir + MENU_TITLES.length) % MENU_TITLES.length][0]),
      onClose: (reason) => {
        btn.classList.remove('open');
        if (openId !== id) return; // another title took over
        openId = null;
        closeCurrent = null;
        onClose?.(reason);
      },
    });
    closeCurrent = api.close;
    if (last) api.focusLast();
  }

  return {
    el: root,
    open,
    close: closeOpen,
    get openId() { return openId; },
    destroy() { closeOpen(); root.remove(); },
  };
}

export function toMenuItems(items, run) {
  return items.map((it) => {
    if (it.separator || it.header || it.custom) return it;
    if (it.submenu) return { ...it, submenu: toMenuItems(it.submenu, run) };
    return { ...it, onSelect: () => (it.fn ? it.fn() : run(it.cmd, it.arg)) };
  });
}
