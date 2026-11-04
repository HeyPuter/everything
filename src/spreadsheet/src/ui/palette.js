/**
 * Command palette: every menu action, searchable by name. Ctrl/Cmd+Shift+P
 * (or Alt+/) opens it; typing filters, arrows move, Enter runs.
 */

import { SAMPLE_SCRIPTS, sampleName, sampleDescription } from '../core/scripts.js';
import { isComposing, el, MOD_KEY, IS_MAC } from './dom.js';
import { icon } from './icons.js';
import { ariaKeyShortcuts } from './menu.js';
import { GROUP_BLOCKED_COMMANDS } from '../core/sheet-group.js';
import { hasDecimalPlaces } from '../core/format.js';
import { t, tSource } from '../i18n/index.js';

/** The palette's sections, by the English name the entries give: the name shown is the message. */
const SECTIONS = {
  File: 'palette.section.file', Edit: 'palette.section.edit', View: 'palette.section.view', Tools: 'palette.section.tools',
  Insert: 'palette.section.insert', Data: 'palette.section.data', Format: 'palette.section.format', Formula: 'palette.section.formula',
  Automate: 'palette.section.automate', Chart: 'palette.section.chart', Help: 'palette.section.help',
};

/**
 * A palette entry's names: `label` and `section` in the interface language, `labelSource` and
 * `sectionSource` in English, so a search in English still finds an entry shown in another language and
 * the recently used list (kept by English label) survives a change of language.
 */
function named(key, section, values) {
  return { label: t(key, values), labelSource: tSource(key, values), section: t(SECTIONS[section]), sectionSource: tSource(SECTIONS[section]) };
}

/**
 * The actions the palette offers. `flags` gates the context-dependent ones
 * (templates, file picker, AI, the active cell's formula/table/note) and
 * `fns` carries the few actions that are plain functions rather than editor
 * commands. Each entry: { label, labelSource, section, sectionSource, icon, shortcut, cmd, arg, fn, keywords };
 * `keywords` are English search words, matched whatever the interface language.
 */
export function paletteCommands(flags = {}) {
  const M = MOD_KEY;
  // macOS takes ⌘+Shift+3, 4, 5 and 6 for screenshots before the page sees them, so on a Mac the number-format and border chords go with Control.
  const K = IS_MAC ? '⌃' : M;
  const c = (key, section, ic, cmd, arg = null, extra = {}) => ({ ...named(key, section), icon: ic, cmd, arg, ...extra });
  // What the menus grey out is left out here, on the same flags: the palette has no greyed row, and an enabled
  // row whose command does nothing would run in silence.
  const noDecimals = !hasDecimalPlaces(flags.style);
  const list = [
    c('palette.cmd.newSpreadsheet', 'File', 'filePlus', 'new'),
    flags.templates && c('palette.cmd.newFromTemplate', 'File', 'sparkle', 'newFromTemplate'),
    flags.pick && c('palette.cmd.openFromPuter', 'File', 'folderOpen', 'open', null, { shortcut: `${M}+O` }),
    c('palette.cmd.importFromDevice', 'File', 'upload', 'import', null, { keywords: 'xlsx csv ods upload file' }),
    c('palette.cmd.importIntoThisSpreadsheet', 'File', 'sheet', 'importSheets', null, { keywords: 'add sheets from file' }),
    c('palette.cmd.importFromURL', 'File', 'external', 'importUrl', null, { keywords: 'web address fetch csv xlsx download link' }),
    c('palette.cmd.save', 'File', 'save', 'save', null, { shortcut: `${M}+S` }),
    c('palette.cmd.saveACopy', 'File', 'duplicate', 'saveAs'),
    c('palette.cmd.renameSpreadsheet', 'File', 'pencil', 'rename'),
    flags.share && c('palette.cmd.share', 'File', 'share', 'share', null, { keywords: 'invite collaborate people access permission send email username' }),
    flags.mail && c('palette.cmd.sendACopy', 'File', 'sendCopy', 'sendCopy', null, { keywords: 'email mail attachment attach send xlsx pdf csv' }),
    flags.mail && flags.share && c('palette.cmd.sendALink', 'File', 'sendLink', 'sendLink', null, { keywords: 'email mail link invite share view edit' }),
    c('palette.cmd.documentDetails', 'File', 'info', 'docInfo', null, { keywords: 'info size path statistics' }),
    c('palette.cmd.versionHistory', 'File', 'clock', 'versions', null, { keywords: 'snapshots restore backup earlier revert undo save version' }),
    c(flags.changesPane ? 'palette.cmd.hideChanges' : 'palette.cmd.showChanges', 'File', 'showChanges', 'showChanges', null, { keywords: 'track changes edits history who changed audit log recent review' }),
    c(flags.saving ? 'palette.cmd.exportAsXlsx' : 'palette.cmd.downloadXlsx', 'File', 'fileDown', 'downloadXlsx', null, { keywords: 'excel export' }),
    c(flags.saving ? 'palette.cmd.exportAsOds' : 'palette.cmd.downloadOds', 'File', 'fileDown', 'downloadOds', null, { keywords: 'libreoffice export' }),
    c(flags.saving ? 'palette.cmd.exportSheetAsCsv' : 'palette.cmd.downloadSheetAsCsv', 'File', 'fileDown', 'downloadCsv', null, { keywords: 'export' }),
    c(flags.saving ? 'palette.cmd.exportSheetAsTsv' : 'palette.cmd.downloadSheetAsTsv', 'File', 'fileDown', 'downloadTsv', null, { keywords: 'export tab separated text' }),
    c(flags.saving ? 'palette.cmd.exportSheetAsAWebPage' : 'palette.cmd.downloadSheetAsAWebPageHtml', 'File', 'fileDown', 'downloadHtml', null, { keywords: 'export html table publish' }),
    c('palette.cmd.downloadSelectionAsCsv', 'File', 'fileDown', 'downloadRangeCsv', null, { keywords: 'export range' }),
    c('palette.cmd.saveAsPDF', 'File', 'fileDown', 'exportPdf', null, { keywords: 'export print' }),
    c('palette.cmd.print', 'File', 'printer', 'print', null, { shortcut: `${M}+P` }),
    c('palette.cmd.options', 'File', 'options', 'options', null, { shortcut: `${M}+,`, keywords: 'preferences settings enter direction fill handle autosave' }),
    c('palette.cmd.backToAllSpreadsheets', 'File', 'back', 'home'),

    flags.canUndo !== false && c('palette.cmd.undo', 'Edit', 'undo', 'undo', null, { shortcut: `${M}+Z` }),
    flags.canRedo !== false && c('palette.cmd.redo', 'Edit', 'redo', 'redo', null, { shortcut: `${M}+Shift+Z` }),
    !flags.chart && c('palette.cmd.cut', 'Edit', 'cut', 'cut', null, { shortcut: `${M}+X` }),
    c('palette.cmd.copy', 'Edit', 'copy', 'copy', null, { shortcut: `${M}+C` }),
    c('palette.cmd.paste', 'Edit', 'paste', 'paste', null, { shortcut: `${M}+V` }),
    c('palette.cmd.pasteValuesOnly', 'Edit', 'paste', 'pasteValues', null, { shortcut: `${M}+Shift+V` }),
    c('palette.cmd.pasteFormatsOnly', 'Edit', 'paint', 'pasteFormats'),
    c('palette.cmd.pasteTransposed', 'Edit', 'paste', 'pasteTranspose', null, { keywords: 'rows columns swap' }),
    c('palette.cmd.pasteLinksToTheCopiedCells', 'Edit', 'link', 'pasteSpecial', 'link', { keywords: 'reference formulas follow source' }),
    c('palette.cmd.copyLinkToThisCellOrRange', 'Edit', 'link', 'copyLink', null, { keywords: 'url share address deep link open at' }),
    c('palette.cmd.insertCopiedCellsShiftingDown', 'Edit', 'arrowDown', 'pasteSpecial', 'insertDown', { keywords: 'paste insert make room push' }),
    c('palette.cmd.insertCopiedCellsShiftingRight', 'Edit', 'chevR', 'pasteSpecial', 'insertRight', { keywords: 'paste insert make room push' }),
    flags.copiedCells && c('palette.cmd.insertCopiedCells', 'Edit', 'paste', 'insertCopiedCells', null, { keywords: 'paste insert shift dialog' }),
    c('palette.cmd.pasteSpecial', 'Edit', 'paste', 'pasteSpecialMenu', null, { shortcut: `${M}+Alt+V`, keywords: 'skip blanks column widths add subtract multiply divide' }),
    c('palette.cmd.findAndReplace', 'Edit', 'search', 'find', null, { shortcut: `${M}+F` }),
    c('palette.cmd.goToCellOrRange', 'Edit', 'search', 'goTo', null, { shortcut: `${M}+G`, keywords: 'jump name box' }),
    c('palette.cmd.selectCellsOfAKind', 'Edit', 'sliders', 'selectSpecialMenu', null, { keywords: 'go to special blanks formulas constants' }),
    c('palette.cmd.selectAll', 'Edit', 'check', 'selectAll', null, { shortcut: `${M}+A` }),
    c('palette.cmd.clearContents', 'Edit', 'eraser', 'clear', null, { shortcut: 'Delete' }),
    c('palette.cmd.clearFormatting', 'Edit', 'eraser', 'clearFormat', null),
    c('palette.cmd.fillDown', 'Edit', 'arrowDown', 'fillDown', null, { shortcut: `${M}+D` }),
    c('palette.cmd.fillRight', 'Edit', 'arrowRight', 'fillRight', null, { shortcut: `${M}+R` }),
    c('palette.cmd.fillSeries', 'Edit', 'arrowDown', 'fillSeries', null, { keywords: 'sequence step dates numbers' }),
    c('palette.cmd.fillJustify', 'Edit', 'alignLeft', 'fillJustify', null, { keywords: 'rewrap text lines column width join split' }),
    c('palette.cmd.insertTodaysDate', 'Edit', 'calendar', 'insertDate', null, { shortcut: `${M}+;` }),
    c('palette.cmd.insertTheCurrentTime', 'Edit', 'clock', 'insertTime', null, { shortcut: `${M}+Shift+;` }),
    c('palette.cmd.copyTheFormulaFromTheCellAbove', 'Edit', 'fx', 'copyAbove', 'formula', { shortcut: `${M}+'` }),
    c('palette.cmd.recalculateAllFormulas', 'Edit', 'reset', 'recalc', null, { shortcut: 'F9', keywords: 'refresh now today rand' }),
    c('palette.cmd.scrollBackToTheActiveCell', 'Edit', 'back', 'scrollToActive', null, { shortcut: `${M}+Backspace` }),

    c('palette.cmd.showFormulas', 'View', 'fx', 'showFormulas', null, { shortcut: `${K}+\``, keywords: 'toggle' }),
    c('palette.cmd.gridlines', 'View', 'borders', 'gridlines', null, { keywords: 'toggle hide show lines' }),
    c('palette.cmd.showZeros', 'View', 'eye', 'zeros', null, { keywords: 'toggle hide zero values' }),
    c('palette.cmd.rowAndColumnHeaders', 'View', 'borders', 'toggleHeaders', null, { keywords: 'toggle hide show' }),
    c('palette.cmd.focusMode', 'View', 'eyeOff', 'focusMode', null, { keywords: 'toolbar hide distraction' }),
    c('palette.cmd.checkSpellingAsYouType', 'View', 'text', 'toggleSpellcheck', null, { keywords: 'spellcheck toggle' }),
    c('palette.cmd.autocorrectOptions', 'Tools', 'autoCorrect', 'autoCorrectOptions', null, { keywords: 'autocorrect replace text typing typos capitals capitalize symbols' }),
    c('palette.cmd.customizeTheRibbon', 'Tools', 'customizeRibbon', 'options', 'ribbon', { keywords: 'ribbon tabs groups custom hide rename' }),
    c('palette.cmd.customizeQuickAccessToolbar', 'Tools', 'customizeQuickAccess', 'options', 'quickAccess', { keywords: 'quick access toolbar qat' }),
    c('palette.cmd.customizeKeyboard', 'Tools', 'customizeKeyboard', 'options', 'keyboard', { keywords: 'keyboard shortcuts keys hotkeys' }),
    c('palette.cmd.spelling', 'Tools', 'spell', 'spelling', null, { shortcut: 'F7', keywords: 'spell check spellcheck proofing dictionary typos misspelled' }),
    c('palette.cmd.thesaurus', 'Tools', 'thesaurus', 'thesaurus', null, { shortcut: 'Shift+F7', keywords: 'synonyms antonyms words meaning alternative' }),
    c('palette.cmd.translate', 'Tools', 'translate', 'translatePane', null, { keywords: 'translator language translation convert' }),
    flags.fullscreen && c('palette.cmd.fullScreen', 'View', 'monitor', 'fullscreen'),
    c('palette.cmd.zoomIn', 'View', 'zoomIn', 'zoom', 0.1),
    c('palette.cmd.zoomOut', 'View', 'zoomOut', 'zoom', -0.1),
    c('palette.cmd.customZoom', 'View', 'zoomIn', 'zoomCustom', null, { keywords: 'percentage scale magnification' }),
    c('palette.cmd.customViews', 'View', 'customViews', 'customViews', null, { keywords: 'saved view show add named layout zoom hidden print' }),
    !flags.chartSheet && c('palette.cmd.newSheetView', 'View', 'sheetView', 'sheetView', 'new', { keywords: 'personal temporary filter my own view collaborate' }),
    flags.sheetView && c('palette.cmd.exitSheetView', 'View', 'exitView', 'sheetView', 'exit', { keywords: 'default view leave' }),
    !flags.chartSheet && c('palette.cmd.sheetViewOptions', 'View', 'sliders', 'sheetView', 'options', { keywords: 'rename duplicate delete switch personal view' }),
    !flags.chartSheet && (!flags.viewMode || flags.viewMode === 'normal') && c('palette.cmd.pageBreaks', 'View', 'pageBreak', 'showPageBreaks', null, { keywords: 'dashed lines pages print toggle' }),
    c('palette.cmd.insertPageBreak', 'File', 'breaks', 'pageBreak', 'insert', { keywords: 'print new page manual' }),
    c('palette.cmd.removePageBreak', 'File', 'eraser', 'pageBreak', 'remove', { keywords: 'print manual' }),
    c('palette.cmd.resetAllPageBreaks', 'File', 'reset', 'pageBreak', 'reset', { keywords: 'print manual clear' }),
    !flags.chartSheet && c('palette.cmd.sheetBackground', 'File', 'background', 'sheetBackground', 'pick', { keywords: 'picture image wallpaper tile' }),
    flags.background && c('palette.cmd.deleteSheetBackground', 'File', 'deleteItem', 'sheetBackground', 'delete', { keywords: 'picture image wallpaper remove' }),
    c('palette.cmd.resetZoomTo100', 'View', 'reset', 'zoom', 'reset'),
    c('palette.cmd.freezeFirstRow', 'View', 'pin', 'freeze', { rows: 1 }, { keywords: 'lock header' }),
    c('palette.cmd.freezeFirstColumn', 'View', 'pin', 'freeze', { cols: 1 }, { keywords: 'lock' }),
    c('palette.cmd.freezeRowsUpToTheSelection', 'View', 'pin', 'freeze', 'rows'),
    c('palette.cmd.freezeColumnsUpToTheSelection', 'View', 'pin', 'freeze', 'cols'),
    c('palette.cmd.unfreeze', 'View', 'reset', 'freeze', 'none', { keywords: 'panes' }),
    c('palette.cmd.hideRows', 'View', 'eyeOff', 'hide', 'row', { shortcut: `${M}+9` }),
    c('palette.cmd.hideColumns', 'View', 'eyeOff', 'hide', 'col', { shortcut: `${M}+0` }),
    c('palette.cmd.unhideRows', 'View', 'eye', 'unhide', 'row', { shortcut: `${M}+Shift+9`, keywords: 'show hidden' }),
    c('palette.cmd.unhideColumns', 'View', 'eye', 'unhide', 'col', { shortcut: `${M}+Shift+0`, keywords: 'show hidden' }),
    c('palette.cmd.groupRows', 'View', 'rows', 'group', 'row', { shortcut: 'Alt+Shift+Right', keywords: 'outline collapse' }),
    c('palette.cmd.groupColumns', 'View', 'cols', 'group', 'col', { keywords: 'outline collapse' }),
    c('palette.cmd.ungroupRows', 'View', 'rows', 'ungroup', 'row', { shortcut: 'Alt+Shift+Left' }),
    c('palette.cmd.ungroupColumns', 'View', 'cols', 'ungroup', 'col'),
    c('palette.cmd.collapseAllRowGroups', 'View', 'chevU', 'collapseAll', 'row'),
    c('palette.cmd.expandAllRowGroups', 'View', 'chevD', 'expandAll', 'row'),
    c('palette.cmd.collapseAllColumnGroups', 'View', 'chevL', 'collapseAll', 'col'),
    c('palette.cmd.expandAllColumnGroups', 'View', 'chevR', 'expandAll', 'col'),

    c('palette.cmd.insertRowAbove', 'Insert', 'arrowUp', 'insertRows', 'above', { shortcut: `${M}+Shift+=` }),
    c('palette.cmd.insertRowBelow', 'Insert', 'arrowDown', 'insertRows', 'below'),
    c('palette.cmd.insertColumnLeft', 'Insert', 'chevL', 'insertCols', 'left'),
    c('palette.cmd.insertColumnRight', 'Insert', 'chevR', 'insertCols', 'right'),
    c('palette.cmd.insertCellsShiftingDown', 'Insert', 'arrowDown', 'insertCells', 'down'),
    c('palette.cmd.insertCellsShiftingRight', 'Insert', 'chevR', 'insertCells', 'right'),
    c('palette.cmd.deleteRows', 'Insert', 'trash', 'deleteRows', null, { shortcut: `${M}+-`, keywords: 'remove' }),
    c('palette.cmd.deleteColumns', 'Insert', 'trash', 'deleteCols', null, { keywords: 'remove' }),
    c('palette.cmd.deleteCellsShiftingUp', 'Insert', 'arrowUp', 'deleteCells', 'up', { keywords: 'remove' }),
    c('palette.cmd.deleteCellsShiftingLeft', 'Insert', 'chevL', 'deleteCells', 'left', { keywords: 'remove' }),
    c('palette.cmd.checkbox', 'Insert', 'check', 'insertCheckbox', null, { keywords: 'tick boolean' }),
    c('palette.cmd.dropdown', 'Insert', 'chevD', 'insertDropdown', null, { keywords: 'list validation select' }),
    c('palette.cmd.datePicker', 'Insert', 'calendar', 'datePicker'),
    c('palette.cmd.link', 'Insert', 'link', 'link', null, { shortcut: `${M}+K`, keywords: 'hyperlink url' }),
    flags.hasLink && c('palette.cmd.removeLink', 'Insert', 'unlink', 'unlink'),
    c(flags.hasNote ? 'palette.cmd.editNote' : 'palette.cmd.note', 'Insert', 'note', 'note', null, { shortcut: 'Shift+F2', keywords: 'comment' }),
    flags.hasNote && c('palette.cmd.deleteNote', 'Insert', 'trash', 'deleteNote', null, { keywords: 'comment remove' }),
    c('palette.cmd.chart', 'Insert', 'chartColumn', 'insertChart', null, { keywords: 'graph bar line pie' }),
    c('palette.cmd.image', 'Insert', 'image', 'insertImage', null, { keywords: 'picture upload' }),
    flags.pick && c('palette.cmd.imageFromPuter', 'Insert', 'folderOpen', 'insertImagePuter', null, { keywords: 'picture cloud storage drive logo' }),
    c('palette.cmd.imageFromURL', 'Insert', 'external', 'insertImageUrl', null, { keywords: 'picture web address link logo' }),
    c('palette.cmd.placePictureInCell', 'Insert', 'placeInCell', 'insertImage', 'cell', { keywords: 'image in cell value photo logo' }),
    flags.cellPicture && c('palette.cmd.placeTheCellPictureOverCells', 'Insert', 'placeOverCells', 'placeOverCells', null, { keywords: 'image float picture' }),
    flags.cellPicture && c('palette.cmd.altTextForTheCellPicture', 'Insert', 'altText', 'cellAltText', null, { keywords: 'image description accessibility' }),
    flags.copiedCells && c('palette.cmd.pasteCopiedCellsAsAPicture', 'Edit', 'pastePicture', 'pasteWith', { picture: true }, { keywords: 'image snapshot' }),
    flags.copiedCells && c('palette.cmd.pasteCopiedCellsAsALinkedPicture', 'Edit', 'linkedPicture', 'pasteWith', { picture: 'linked' }, { keywords: 'camera live image snapshot' }),
    c('palette.cmd.textBox', 'Insert', 'text', 'insertTextBox', null, { keywords: 'label note caption title floating shape drawing' }),
    c('palette.cmd.smartartGraphic', 'Insert', 'smartArt', 'smartArt', { action: 'insertDialog' }, { keywords: 'diagram org chart organization process cycle hierarchy venn pyramid matrix list timeline' }),
    flags.sparklines && c('palette.cmd.sparklineSettings', 'Format', 'chartLine', 'editSparkline', null, { keywords: 'mini chart axis markers colors data' }),
    c('palette.cmd.sparklines', 'Insert', 'chartLine', 'insertSparklines', null, { keywords: 'mini chart line column win loss data' }),
    flags.sparklines && c('palette.cmd.groupUsingActiveSparkline', 'Format', 'chartLine', 'groupSparklines', null, { keywords: 'mini chart shared settings' }),
    flags.sparklines && c('palette.cmd.ungroupSelectedSparklines', 'Format', 'chartLine', 'groupSparklines', 'ungroup', { keywords: 'mini chart independent settings' }),
    flags.sparklines && c('palette.cmd.clearSelectedSparklines', 'Format', 'eraser', 'clearSparklines', null, { keywords: 'remove delete mini chart' }),
    flags.sparklines && c('palette.cmd.clearEntireSelectedSparklineGroups', 'Format', 'eraser', 'clearSparklines', 'groups', { keywords: 'remove delete mini charts' }),
    c('palette.cmd.sparklineFunction', 'Insert', 'chartLine', 'insertFunction', 'SPARKLINE', { keywords: 'mini chart in cell' }),
    !flags.sheet?.locked && c('palette.cmd.newSheet', 'Insert', 'plus', 'newSheet', null, { shortcut: 'Shift+F11', keywords: 'tab' }),
    flags.grouped && c('palette.cmd.fillAcrossWorksheets', 'Edit', 'layers', 'fillAcrossSheets', null, { keywords: 'group copy same cells other sheets contents formats' }),
    !flags.sheet?.locked && c('palette.cmd.duplicateSheet', 'Insert', 'duplicate', 'duplicateSheet', null, { keywords: 'tab copy' }),
    !flags.sheet?.locked && c('palette.cmd.moveOrCopySheet', 'Insert', 'layers', 'moveOrCopySheet', null, { keywords: 'tab order reorder duplicate destination' }),
    c('palette.cmd.copySheetToAnotherSpreadsheet', 'Insert', 'copy', 'copySheetTo', null, { keywords: 'tab move export file workbook' }),
    // The sheet tab's other actions, for the active sheet; what the tab menu greys out is left out here
    // (under Protect Workbook, whatever changes the sheets).
    !flags.sheet?.locked && c('palette.cmd.renameSheet', 'Insert', 'pencil', 'renameSheet', null, { keywords: 'tab name' }),
    !flags.sheet?.locked && c('palette.cmd.sheetColor', 'Insert', 'fill', 'sheetColor', null, { keywords: 'tab colour' }),
    !flags.sheet?.first && !flags.sheet?.locked && c('palette.cmd.moveSheetLeft', 'Insert', 'chevL', 'moveSheet', 'left', { keywords: 'tab order reorder' }),
    !flags.sheet?.last && !flags.sheet?.locked && c('palette.cmd.moveSheetRight', 'Insert', 'chevR', 'moveSheet', 'right', { keywords: 'tab order reorder' }),
    c(flags.sheet?.protected ? 'palette.cmd.unprotectSheet' : 'palette.cmd.protectSheet', 'Insert', 'lock', 'protectSheet', null, { keywords: 'lock unlock tab' }),
    !flags.sheet?.only && !flags.sheet?.locked && c('palette.cmd.hideSheet', 'Insert', 'eyeOff', 'hideSheet', null, { keywords: 'tab' }),
    !flags.sheet?.only && !flags.sheet?.locked && c(flags.sheet?.holdsWork ? 'palette.cmd.deleteSheetAsk' : 'palette.cmd.deleteSheet', 'Insert', 'trash', 'deleteSheet', null, { keywords: 'tab remove' }),
    flags.grouped ? c('palette.cmd.ungroupSheets', 'Insert', 'layers', 'ungroupSheets', null, { keywords: 'tabs group selected sheets single' })
      : !flags.sheet?.only && c('palette.cmd.selectAllSheets', 'Insert', 'layers', 'selectAllSheets', null, { keywords: 'tabs group several sheets at once edit together' }),
    c('palette.cmd.insertFunction', 'Insert', 'sigma', 'functionMenu', null, { shortcut: 'Shift+F3', keywords: 'formula wizard' }),
    c('palette.cmd.autosum', 'Insert', 'sigma', 'autosum', null, { shortcut: 'Alt+=', keywords: 'sum total' }),

    c('palette.cmd.sortRangeAToZ', 'Data', 'sortAsc', 'sort', 'asc', { keywords: 'ascending' }),
    c('palette.cmd.sortRangeZToA', 'Data', 'sortDesc', 'sort', 'desc', { keywords: 'descending' }),
    c('palette.cmd.sortRange', 'Data', 'sliders', 'sortDialog', null, { keywords: 'multiple columns color' }),
    c(flags.filter ? 'palette.cmd.removeFilter' : 'palette.cmd.createFilter', 'Data', 'filter', 'filter', null, { shortcut: `${M}+Shift+L` }),
    flags.hasTable ? c('palette.cmd.editTable', 'Data', 'table', 'editTable', null, { keywords: 'name style totals' }) : c('palette.cmd.createTable', 'Data', 'table', 'insertTable', null, { keywords: 'structured banded' }),
    flags.hasTable && c('palette.cmd.toggleTheTablesTotalsRow', 'Data', 'sigma', 'tableTotals'),
    c('palette.cmd.subtotals', 'Data', 'sigma', 'subtotal', null, { keywords: 'group by outline' }),
    c('palette.cmd.autoOutline', 'Data', 'group', 'autoOutline', null, { keywords: 'group rows columns summary totals outline automatic' }),
    c('palette.cmd.clearOutline', 'Data', 'eraser', 'clearOutline', null, { keywords: 'remove groups ungroup all outline' }),
    c('palette.cmd.outlineSettings', 'Data', 'sliders', 'outlineSettings', null, { keywords: 'summary rows below columns right automatic styles outline' }),
    c('palette.cmd.pivotTable', 'Data', 'pivot', 'pivot', null, { keywords: 'summarize' }),
    c('palette.cmd.columnStats', 'Data', 'chartColumn', 'columnStats', null, { keywords: 'summary distribution' }),
    c('palette.cmd.dataForm', 'Data', 'dataForm', 'dataForm', null, { keywords: 'record entry fields list database criteria find' }),
    c('palette.cmd.goalSeek', 'Data', 'sliders', 'goalSeek', null, { keywords: 'what if solve' }),
    c('palette.cmd.dataTable', 'Data', 'table', 'dataTable', null, { keywords: 'what if analysis sensitivity' }),
    c('palette.cmd.solver', 'Data', 'solver', 'solver', null, { keywords: 'optimize optimization maximize minimize linear programming constraints simplex nonlinear evolutionary' }),
    c('palette.cmd.dataAnalysis', 'Data', 'dataAnalysis', 'dataAnalysis', null, { keywords: 'statistics anova regression histogram correlation covariance descriptive t-test z-test f-test fourier sampling random moving average smoothing rank percentile' }),
    c('palette.cmd.removeDuplicateRows', 'Data', 'dedupe', 'dedupe', null, { keywords: 'unique' }),
    c('palette.cmd.removeEmptyRows', 'Data', 'rows', 'removeEmptyRows', null, { keywords: 'blank' }),
    c('palette.cmd.randomizeRange', 'Data', 'sortAsc', 'shuffle', null, { keywords: 'shuffle random order' }),
    c('palette.cmd.splitTextToColumns', 'Data', 'cols', 'splitText', null, { keywords: 'delimiter comma' }),
    c('palette.cmd.textToColumns', 'Data', 'cols', 'splitTextDialog', null, { keywords: 'split delimiter separator fixed width' }),
    c('palette.cmd.trimWhitespace', 'Data', 'text', 'textCase', 'trim'),
    c('palette.cmd.uppercaseText', 'Data', 'text', 'textCase', 'upper', { keywords: 'case' }),
    c('palette.cmd.lowercaseText', 'Data', 'text', 'textCase', 'lower', { keywords: 'case' }),
    c('palette.cmd.capitalizeEachWord', 'Data', 'text', 'textCase', 'proper', { keywords: 'case title' }),
    c('palette.cmd.convertTextToNumbers', 'Data', 'number', 'textCase', 'number', { keywords: 'stored as text' }),
    c('palette.cmd.dataValidation', 'Data', 'validation', 'validation', null, { keywords: 'rules dropdown checkbox' }),
    c('palette.cmd.namedRanges', 'Data', 'tag', 'names', null, { keywords: 'define name' }),
    c('palette.cmd.protectedRanges', 'Data', 'lock', 'protectRanges', null, { keywords: 'lock sheet protect' }),
    c('palette.cmd.editLinks', 'Data', 'editLinks', 'editLinks', null, { keywords: 'external workbook references other file update values change source break startup prompt' }),

    c('palette.cmd.bold', 'Format', 'bold', 'bold', null, { shortcut: `${M}+B` }),
    c('palette.cmd.italic', 'Format', 'italic', 'italic', null, { shortcut: `${M}+I` }),
    c('palette.cmd.underline', 'Format', 'underline', 'underline', null, { shortcut: `${M}+U` }),
    c('palette.cmd.strikethrough', 'Format', 'strike', 'strike', null, { shortcut: `${M}+5` }),
    c('palette.cmd.formatCells', 'Format', 'formatCells', 'formatCells', null, { shortcut: `${M}+1`, keywords: 'number alignment font border fill dialog' }),
    c('palette.cmd.conditionalFormatting', 'Format', 'highlighter', 'condFormat', null, { keywords: 'rules color scale data bars' }),
    c('palette.cmd.alternatingColors', 'Format', 'rows', 'bands', null, { keywords: 'banding stripes zebra' }),
    c('palette.cmd.cellStyles', 'Format', 'paint', 'cellStylesMenu', null, { keywords: 'title heading total good bad' }),
    !flags.editing && c('palette.cmd.newCellStyle', 'Format', 'plus', 'newCellStyle', null, { keywords: 'named style create define by example' }),
    !flags.editing && c('palette.cmd.mergeCellStyles', 'Format', 'paint', 'mergeCellStyles', null, { keywords: 'copy styles from another workbook spreadsheet import' }),
    c('palette.cmd.paintFormat', 'Format', 'paint', 'paintFormat', null, { keywords: 'copy formatting brush' }),
    // A single unmerged cell has nothing to merge; one row nothing to merge vertically, one column nothing horizontally.
    flags.merged ? c('palette.cmd.unmergeCells', 'Format', 'unmerge', 'merge', null, { keywords: 'merge split' }) : !flags.singleCell && c('palette.cmd.mergeCells', 'Format', 'merge', 'merge', null, { keywords: 'unmerge' }),
    !flags.singleCell && !flags.oneCol && c('palette.cmd.mergeHorizontally', 'Format', 'rows', 'mergeAcross'),
    !flags.singleCell && !flags.oneRow && c('palette.cmd.mergeVertically', 'Format', 'cols', 'mergeDown'),
    c('palette.cmd.wrapText', 'Format', 'wrap', 'wrapMode', 'wrap'),
    c('palette.cmd.clipText', 'Format', 'x', 'wrapMode', 'clip'),
    c('palette.cmd.overflowText', 'Format', 'chevR', 'wrapMode', 'overflow'),
    c('palette.cmd.alignLeft', 'Format', 'alignLeft', 'align', 'left'),
    c('palette.cmd.alignCenter', 'Format', 'alignCenter', 'align', 'center'),
    c('palette.cmd.alignRight', 'Format', 'alignRight', 'align', 'right'),
    c('palette.cmd.alignTop', 'Format', 'arrowUp', 'valign', 'top', { keywords: 'vertical' }),
    c('palette.cmd.alignMiddle', 'Format', 'borderTop', 'valign', 'middle', { keywords: 'vertical' }),
    c('palette.cmd.alignBottom', 'Format', 'arrowDown', 'valign', 'bottom', { keywords: 'vertical' }),
    c('palette.cmd.increaseIndent', 'Format', 'indentMore', 'indent', 1),
    c('palette.cmd.decreaseIndent', 'Format', 'indentLess', 'indent', -1),
    c('palette.cmd.rotateTextUp45', 'Format', 'text', 'rotate', 45, { keywords: 'tilt angle' }),
    c('palette.cmd.rotateTextDown45', 'Format', 'text', 'rotate', -45, { keywords: 'tilt angle' }),
    c('palette.cmd.rotateTextUp90', 'Format', 'text', 'rotate', 90, { keywords: 'vertical angle' }),
    c('palette.cmd.rotateTextDown90', 'Format', 'text', 'rotate', -90, { keywords: 'vertical angle' }),
    c('palette.cmd.customTextRotation', 'Format', 'text', 'rotate', 'custom', { keywords: 'angle degrees tilt' }),
    c('palette.cmd.noTextRotation', 'Format', 'text', 'rotate', 0, { keywords: 'angle reset' }),
    c('palette.cmd.largerFont', 'Format', 'fontSize', 'fontStep', 1, { shortcut: `${M}+Shift+>` }),
    c('palette.cmd.smallerFont', 'Format', 'fontSize', 'fontStep', -1, { shortcut: `${M}+Shift+<` }),
    c('palette.cmd.customFontSize', 'Format', 'fontSize', 'fontSize', null, { keywords: 'text size typography' }),
    c('palette.cmd.numberFormatAutomatic', 'Format', 'text', 'fmt', 'general', { shortcut: `${K}+Shift+~`, keywords: 'general reset' }),
    c('palette.cmd.numberFormatNumber', 'Format', 'number', 'fmt', 'number', { shortcut: `${K}+Shift+!`, keywords: 'decimal thousands' }),
    c('palette.cmd.numberFormatCurrency', 'Format', 'currency', 'fmt', 'currency', { shortcut: `${K}+Shift+$`, keywords: 'money dollar euro' }),
    c('palette.cmd.numberFormatPercent', 'Format', 'percent', 'fmt', 'percent', { shortcut: `${K}+Shift+%` }),
    c('palette.cmd.numberFormatDate', 'Format', 'calendar', 'fmt', 'date', { shortcut: `${K}+Shift+#` }),
    c('palette.cmd.numberFormatTime', 'Format', 'clock', 'fmt', 'time', { shortcut: `${K}+Shift+@` }),
    c('palette.cmd.numberFormatScientific', 'Format', 'number', 'fmt', 'scientific', { shortcut: `${K}+Shift+^` }),
    c('palette.cmd.numberFormatPlainText', 'Format', 'text', 'fmt', 'text', { keywords: 'as typed' }),
    !noDecimals && c('palette.cmd.moreDecimalPlaces', 'Format', 'decMore', 'dec', 1),
    !noDecimals && c('palette.cmd.fewerDecimalPlaces', 'Format', 'decLess', 'dec', -1),
    c('palette.cmd.allBorders', 'Format', 'borders', 'borders', 'all'),
    c('palette.cmd.outerBorders', 'Format', 'borderOuter', 'borders', 'outer', { shortcut: `${K}+Shift+&`, keywords: 'outline box' }),
    c('palette.cmd.innerBorders', 'Format', 'borders', 'borders', 'inner'),
    c('palette.cmd.noBorders', 'Format', 'borderNone', 'borders', 'none', { shortcut: `${K}+Shift+_`, keywords: 'remove clear' }),
    c('palette.cmd.fitColumnsToContent', 'Format', 'cols', 'autofit', null, { keywords: 'autofit width' }),
    c('palette.cmd.fitRowsToContent', 'Format', 'rows', 'fitRows', null, { keywords: 'autofit height' }),
    c('palette.cmd.resizeRows', 'Format', 'rows', 'resizeRows', null, { keywords: 'height' }),
    c('palette.cmd.resizeColumns', 'Format', 'cols', 'resizeCols', null, { keywords: 'width' }),

    flags.hasFormula && c('palette.cmd.evaluateFormulaStepByStep', 'Formula', 'fx', 'evaluateFormula', null, { keywords: 'debug audit' }),
    flags.hasFormula && c('palette.cmd.showPrecedents', 'Formula', 'fx', 'trace', 'precedents', { shortcut: `${M}+[`, keywords: 'audit cells it reads' }),
    c('palette.cmd.showDependents', 'Formula', 'fx', 'trace', 'dependents', { shortcut: `${M}+]`, keywords: 'audit formulas reading this cell' }),
    c('palette.cmd.replaceFormulasWithValues', 'Formula', 'number', 'toValues', null, { keywords: 'convert static results constants' }),
    flags.ai && c(flags.aiPanel ? 'palette.cmd.closeTheAIAssistant' : 'palette.cmd.openTheAIAssistant', 'View', 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, keywords: 'chat copilot gemini ask analyze agent sidebar panel help' }),
    flags.ai && c('palette.cmd.writeAFormulaWithAI', 'Formula', 'sparkle', 'aiFormula', null, { keywords: 'generate assistant' }),
    c(flags.scriptsPane ? 'palette.cmd.closeTheCodeEditor' : 'palette.cmd.openTheCodeEditor', 'Automate', 'codeEditor', 'scriptsPane', null, { keywords: 'script macro code automate javascript editor' }),
    c('palette.cmd.newScript', 'Automate', 'newScript', 'newScript', null, { keywords: 'macro code automate javascript' }),
    c(flags.recording ? 'palette.cmd.stopRecordingActions' : 'palette.cmd.recordActions', 'Automate', 'recordActions', 'recordActions', null, { keywords: 'macro recorder automate script' }),
    c('palette.cmd.allScripts', 'Automate', 'allScripts', 'scriptGallery', null, { keywords: 'gallery samples macros my scripts library' }),
    c('palette.cmd.scriptReference', 'Automate', 'scriptReference', 'scriptReference', null, { keywords: 'api documentation help javascript' }),
    // A sample's name and description show translated; its English stays searchable.
    ...SAMPLE_SCRIPTS.map((sample) => ({ ...named('palette.cmd.runSampleScript', 'Automate', { name: sample.name }), label: t('palette.cmd.runSampleScript', { name: sampleName(sample) }), icon: 'runScript', cmd: 'runScript', arg: { sample: sample.id }, keywords: `macro ${sample.description} ${sampleDescription(sample)}` })),
    flags.ai && flags.hasFormula && c('palette.cmd.explainThisFormulaAI', 'Formula', 'sparkle', 'aiExplain', null, { keywords: 'assistant' }),
    flags.ai && c('palette.cmd.askAIAboutThisData', 'Data', 'sparkle', 'aiAsk', null, { keywords: 'question summarize insights assistant analyze' }),

    flags.chart && !flags.chartIsImage && c('palette.cmd.editTheSelectedChart', 'Chart', 'chartColumn', 'editChart', flags.chart, { shortcut: 'Enter', keywords: 'type range title colors' }),
    flags.chart && flags.chartIsImage && c('palette.cmd.replaceTheSelectedImage', 'Chart', 'image', 'replaceImage', flags.chart),
    flags.chart && flags.chartIsImage && c('palette.cmd.placeTheSelectedPictureInACell', 'Chart', 'placeInCell', 'placeObjectInCell', flags.chart, { keywords: 'image cell value' }),
    flags.chart && flags.chartIsImage && c('palette.cmd.cropTheSelectedPicture', 'Chart', 'crop', 'pictureFormat', { action: 'crop' }, { keywords: 'image trim aspect' }),
    flags.chart && flags.chartIsImage && c('palette.cmd.pictureCorrections', 'Chart', 'corrections', 'pictureFormat', { action: 'correctionsDialog' }, { keywords: 'image brightness contrast transparency' }),
    flags.chart && flags.chartIsImage && c('palette.cmd.resetTheSelectedPicture', 'Chart', 'resetPicture', 'pictureFormat', { action: 'reset' }, { keywords: 'image corrections style' }),
    flags.chart && c(flags.chartIsImage ? 'palette.cmd.duplicateTheSelectedImage' : 'palette.cmd.duplicateTheSelectedChart', 'Chart', 'duplicate', 'duplicateChart', { id: flags.chart }),
    flags.chart && c(flags.chartIsImage ? 'palette.cmd.copyTheSelectedImage' : 'palette.cmd.copyTheSelectedChartAsAPicture', 'Chart', 'copy', 'copyChart', { id: flags.chart }, { keywords: 'clipboard png' }),
    flags.chart && c(flags.chartIsImage ? 'palette.cmd.downloadTheSelectedImage' : 'palette.cmd.downloadTheSelectedChartAsPNG', 'Chart', 'download', 'downloadChart', { id: flags.chart, format: 'png' }),
    flags.chart && !flags.chartIsImage && c('palette.cmd.downloadTheSelectedChartAsSVG', 'Chart', 'download', 'downloadChart', { id: flags.chart, format: 'svg' }),
    flags.chart && c(flags.chartIsImage ? 'palette.cmd.deleteTheSelectedImage' : 'palette.cmd.deleteTheSelectedChart', 'Chart', 'trash', 'deleteChart', flags.chart, { shortcut: 'Delete', keywords: 'remove' }),
    flags.fns?.shortcuts && { ...named('palette.cmd.keyboardShortcuts', 'Help'), icon: 'keyboard', fn: flags.fns.shortcuts, keywords: 'keys help' },
    flags.fns?.locale && { ...named('palette.cmd.regionalFormat', 'Help'), icon: 'monitor', fn: flags.fns.locale, keywords: 'locale decimal comma date order language' },
  ];
  // Grouped sheets: the commands for one sheet's objects are greyed in the menus, so they are left out here.
  return list.filter((item) => item && !(flags.grouped && item.cmd && GROUP_BLOCKED_COMMANDS.has(item.cmd)));
}

const RECENT_KEY = 'spreadsheet:palette:recent';
const RECENT_MAX = 8;

/** Labels of the actions used most recently, newest first: their English labels (`labelSource`), whatever the interface language. */
export function recentCommands() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function rememberCommand(label) {
  try {
    const next = [label, ...recentCommands().filter((l) => l !== label)].slice(0, RECENT_MAX);
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* no storage */ }
}

/**
 * The commands matching a query: every word must occur in the label, section,
 * or keywords. Label matches rank above keyword matches, and a label that
 * starts with the query comes first. With no query, the recently used actions
 * lead the list. The label and section are matched as shown and in English,
 * so a command shown in Chinese is found by its Chinese name (a part of it:
 * Chinese puts no space between words) and by the English one.
 */
export function matchCommands(commands, query, limit = 40, recent = recentCommands()) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const lead = recent.map((label) => commands.find((c) => (c.labelSource ?? c.label) === label)).filter(Boolean);
    const rest = commands.filter((c) => !lead.includes(c));
    return [...lead.map((c) => ({ ...c, recent: true })), ...rest].slice(0, limit);
  }
  const scored = [];
  const wordStart = new RegExp(`(^|[^a-z])${words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const scoreOf = (label) => {
    if (label.startsWith(words.join(' '))) return 0;
    if (words.every((w) => label.includes(w))) return wordStart.test(label) ? 1 : 2;
    return 3;
  };
  commands.forEach((cmd, i) => {
    // The names as shown, then in English where they differ.
    const labels = [...new Set([cmd.label, cmd.labelSource ?? cmd.label].map((l) => l.toLowerCase()))];
    const sections = [...new Set([cmd.section, cmd.sectionSource ?? cmd.section].map((l) => l.toLowerCase()))];
    const hay = `${labels.join(' ')} ${sections.join(' ')} ${(cmd.keywords || '').toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    scored.push({ cmd, score: Math.min(...labels.map(scoreOf)), i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.cmd);
}

/**
 * Open the palette. `run(cmd, arg)` runs an editor command; entries with `fn`
 * call it instead. Resolves to nothing; `onClose` fires when it goes away.
 */
export function openCommandPalette({ commands, run, onClose, placeholder = t('palette.placeholder') }) {
  const input = el('input.palette-input', {
    type: 'text', placeholder, 'aria-label': t('palette.searchTheMenus'), autocomplete: 'off', spellcheck: false,
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
  });
  const list = el('div.palette-list', { role: 'listbox', id: 'palette-list', 'aria-label': t('palette.actions') });
  // "No action matches" is said beside the listbox, not inside it as a child that is no option, and
  // as a status, so a screen reader hears it when the search comes up empty.
  const empty = el('div.palette-empty', { role: 'status', 'aria-live': 'polite' });
  const panel = el('div.palette-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('palette.searchTheMenus') },
    el('div.palette-search', {}, el('span.palette-icon', { html: icon('search', 18, 2) }), input, el('kbd.palette-kbd', {}, 'Esc')),
    list, empty);
  const root = el('div.palette-root', {}, el('div.modal-scrim', { onclick: () => close() }), panel);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let shown = [];
  let index = 0;
  let closed = false;

  function render() {
    shown = matchCommands(commands, input.value);
    index = Math.min(index, Math.max(0, shown.length - 1));
    empty.textContent = shown.length ? '' : t('palette.noMatch');
    input.setAttribute('aria-expanded', String(shown.length > 0)); // an empty list is no list to expand
    if (!shown.length) {
      list.replaceChildren();
      input.removeAttribute('aria-activedescendant');
      return;
    }
    list.replaceChildren(...shown.map((cmd, i) => el('button.menu-item.palette-item', {
      type: 'button', role: 'option', id: `palette-opt-${i}`, 'aria-selected': String(i === index), tabindex: -1,
      // Named as a menu item is: the label alone, the section as its description and the shortcut as an
      // attribute, rather than all three run together into one name.
      'aria-label': cmd.label, 'aria-describedby': `palette-sec-${i}`, 'aria-keyshortcuts': ariaKeyShortcuts(cmd.shortcut),
      onmousemove: () => { if (index !== i) { index = i; highlight(); } },
      onclick: () => pick(cmd),
    },
      el('span.menu-icon', { html: icon(cmd.icon || 'chevR', 16, 2) }),
      el('span.menu-label', {}, cmd.label, el('span.palette-section', { id: `palette-sec-${i}` }, cmd.recent ? t('palette.recentSection', { section: cmd.section }) : cmd.section)),
      cmd.shortcut && el('span.menu-shortcut', { 'aria-hidden': 'true' }, cmd.shortcut))));
    highlight();
  }

  function highlight() {
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) rows[i].setAttribute('aria-selected', String(i === index));
    rows[index]?.scrollIntoView?.({ block: 'nearest' });
    if (rows[index]) input.setAttribute('aria-activedescendant', rows[index].id);
  }

  function pick(cmd) {
    close();
    rememberCommand(cmd.labelSource ?? cmd.label);
    if (cmd.fn) cmd.fn();
    else run(cmd.cmd, cmd.arg);
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    onClose?.();
    if (!onClose && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (isComposing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!root.contains(e.target)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { index = (index + 1) % shown.length; highlight(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { index = (index - 1 + shown.length) % shown.length; highlight(); } }
    else if (e.key === 'Home' && e.altKey) { e.preventDefault(); index = 0; highlight(); }
    else if (e.key === 'End' && e.altKey) { e.preventDefault(); index = Math.max(0, shown.length - 1); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[index]) pick(shown[index]); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  }

  input.addEventListener('input', () => { index = 0; render(); });
  // A press anywhere in the panel but the field (the search icon, the Esc hint, a row) keeps the focus in
  // the field, as a combobox does: it fell to the page, where the arrows and Enter reached nothing and Tab
  // walked into the app behind. A row's click still runs, and a press on the list itself, where its
  // scrollbar is, overlaid or not, is left alone to drag it.
  panel.addEventListener('mousedown', (e) => { if (e.target !== input && e.target !== list) e.preventDefault(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  render();
  input.focus();
  return { close, panel, input };
}
