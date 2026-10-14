/**
 * Command palette: every menu action, searchable by name. Ctrl/Cmd+Shift+P
 * (or Alt+/) opens it; typing filters, arrows move, Enter runs.
 */

import { SAMPLE_SCRIPTS } from '../core/scripts.js';
import { isComposing, el, MOD_KEY, IS_MAC } from './dom.js';
import { icon } from './icons.js';
import { ariaKeyShortcuts } from './menu.js';
import { GROUP_BLOCKED_COMMANDS } from '../core/sheet-group.js';

/**
 * The actions the palette offers. `flags` gates the context-dependent ones
 * (templates, file picker, AI, the active cell's formula/table/note) and
 * `fns` carries the few actions that are plain functions rather than editor
 * commands. Each entry: { label, section, icon, shortcut, cmd, arg, fn, keywords }.
 */
export function paletteCommands(flags = {}) {
  const M = MOD_KEY;
  // macOS takes ⌘+Shift+3, 4, 5 and 6 for screenshots before the page sees them, so on a Mac the number-format and border chords go with Control.
  const K = IS_MAC ? '⌃' : M;
  const c = (label, section, ic, cmd, arg = null, extra = {}) => ({ label, section, icon: ic, cmd, arg, ...extra });
  // What the menus grey out is left out here, on the same flags: the palette has no greyed row, and an enabled
  // row whose command does nothing would run in silence.
  const noDecimals = ['date', 'time', 'datetime', 'text', 'custom'].includes(flags.style?.fmt);
  const list = [
    c('New spreadsheet', 'File', 'filePlus', 'new'),
    flags.templates && c('New from template…', 'File', 'sparkle', 'newFromTemplate'),
    flags.pick && c('Open from Puter…', 'File', 'folderOpen', 'open', null, { shortcut: `${M}+O` }),
    c('Import from device…', 'File', 'upload', 'import', null, { keywords: 'xlsx csv ods upload file' }),
    c('Import into this spreadsheet…', 'File', 'sheet', 'importSheets', null, { keywords: 'add sheets from file' }),
    c('Import from URL…', 'File', 'external', 'importUrl', null, { keywords: 'web address fetch csv xlsx download link' }),
    c('Save', 'File', 'save', 'save', null, { shortcut: `${M}+S` }),
    c('Save a copy…', 'File', 'duplicate', 'saveAs'),
    c('Rename spreadsheet…', 'File', 'pencil', 'rename'),
    flags.share && c('Share…', 'File', 'share', 'share', null, { keywords: 'invite collaborate people access permission send email username' }),
    flags.mail && c('Send a copy…', 'File', 'sendCopy', 'sendCopy', null, { keywords: 'email mail attachment attach send xlsx pdf csv' }),
    flags.mail && flags.share && c('Send a link…', 'File', 'sendLink', 'sendLink', null, { keywords: 'email mail link invite share view edit' }),
    c('Document details…', 'File', 'info', 'docInfo', null, { keywords: 'info size path statistics' }),
    c('Version history…', 'File', 'clock', 'versions', null, { keywords: 'snapshots restore backup earlier revert undo save version' }),
    c(flags.changesPane ? 'Hide changes' : 'Show changes', 'File', 'showChanges', 'showChanges', null, { keywords: 'track changes edits history who changed audit log recent review' }),
    c(flags.saving ? 'Export as .xlsx…' : 'Download .xlsx', 'File', 'fileDown', 'downloadXlsx', null, { keywords: 'excel export' }),
    c(flags.saving ? 'Export as .ods…' : 'Download .ods', 'File', 'fileDown', 'downloadOds', null, { keywords: 'libreoffice export' }),
    c(flags.saving ? 'Export sheet as .csv…' : 'Download sheet as .csv', 'File', 'fileDown', 'downloadCsv', null, { keywords: 'export' }),
    c(flags.saving ? 'Export sheet as .tsv…' : 'Download sheet as .tsv', 'File', 'fileDown', 'downloadTsv', null, { keywords: 'export tab separated text' }),
    c(flags.saving ? 'Export sheet as a web page…' : 'Download sheet as a web page (.html)', 'File', 'fileDown', 'downloadHtml', null, { keywords: 'export html table publish' }),
    c('Download selection as .csv', 'File', 'fileDown', 'downloadRangeCsv', null, { keywords: 'export range' }),
    c('Save as PDF…', 'File', 'fileDown', 'exportPdf', null, { keywords: 'export print' }),
    c('Print…', 'File', 'printer', 'print', null, { shortcut: `${M}+P` }),
    c('Options…', 'File', 'options', 'options', null, { shortcut: `${M}+,`, keywords: 'preferences settings enter direction fill handle autosave' }),
    c('Back to all spreadsheets', 'File', 'back', 'home'),

    flags.canUndo !== false && c('Undo', 'Edit', 'undo', 'undo', null, { shortcut: `${M}+Z` }),
    flags.canRedo !== false && c('Redo', 'Edit', 'redo', 'redo', null, { shortcut: `${M}+Shift+Z` }),
    !flags.chart && c('Cut', 'Edit', 'cut', 'cut', null, { shortcut: `${M}+X` }),
    c('Copy', 'Edit', 'copy', 'copy', null, { shortcut: `${M}+C` }),
    c('Paste', 'Edit', 'paste', 'paste', null, { shortcut: `${M}+V` }),
    c('Paste values only', 'Edit', 'paste', 'pasteValues', null, { shortcut: `${M}+Shift+V` }),
    c('Paste formats only', 'Edit', 'paint', 'pasteFormats'),
    c('Paste transposed', 'Edit', 'paste', 'pasteTranspose', null, { keywords: 'rows columns swap' }),
    c('Paste links to the copied cells', 'Edit', 'link', 'pasteSpecial', 'link', { keywords: 'reference formulas follow source' }),
    c('Copy link to this cell or range', 'Edit', 'link', 'copyLink', null, { keywords: 'url share address deep link open at' }),
    c('Insert copied cells, shifting down', 'Edit', 'arrowDown', 'pasteSpecial', 'insertDown', { keywords: 'paste insert make room push' }),
    c('Insert copied cells, shifting right', 'Edit', 'chevR', 'pasteSpecial', 'insertRight', { keywords: 'paste insert make room push' }),
    flags.copiedCells && c('Insert copied cells…', 'Edit', 'paste', 'insertCopiedCells', null, { keywords: 'paste insert shift dialog' }),
    c('Paste special…', 'Edit', 'paste', 'pasteSpecialMenu', null, { shortcut: `${M}+Alt+V`, keywords: 'skip blanks column widths add subtract multiply divide' }),
    c('Find and replace…', 'Edit', 'search', 'find', null, { shortcut: `${M}+F` }),
    c('Go to cell or range…', 'Edit', 'search', 'goTo', null, { shortcut: `${M}+G`, keywords: 'jump name box' }),
    c('Select cells of a kind…', 'Edit', 'sliders', 'selectSpecialMenu', null, { keywords: 'go to special blanks formulas constants' }),
    c('Select all', 'Edit', 'check', 'selectAll', null, { shortcut: `${M}+A` }),
    c('Clear contents', 'Edit', 'eraser', 'clear', null, { shortcut: 'Delete' }),
    c('Clear formatting', 'Edit', 'eraser', 'clearFormat', null),
    c('Fill down', 'Edit', 'arrowDown', 'fillDown', null, { shortcut: `${M}+D` }),
    c('Fill right', 'Edit', 'arrowRight', 'fillRight', null, { shortcut: `${M}+R` }),
    c('Fill series…', 'Edit', 'arrowDown', 'fillSeries', null, { keywords: 'sequence step dates numbers' }),
    c('Fill justify', 'Edit', 'alignLeft', 'fillJustify', null, { keywords: 'rewrap text lines column width join split' }),
    c('Insert today’s date', 'Edit', 'calendar', 'insertDate', null, { shortcut: `${M}+;` }),
    c('Insert the current time', 'Edit', 'clock', 'insertTime', null, { shortcut: `${M}+Shift+;` }),
    c('Copy the formula from the cell above', 'Edit', 'fx', 'copyAbove', 'formula', { shortcut: `${M}+'` }),
    c('Recalculate all formulas', 'Edit', 'reset', 'recalc', null, { shortcut: 'F9', keywords: 'refresh now today rand' }),
    c('Scroll back to the active cell', 'Edit', 'back', 'scrollToActive', null, { shortcut: `${M}+Backspace` }),

    c('Show formulas', 'View', 'fx', 'showFormulas', null, { shortcut: `${K}+\``, keywords: 'toggle' }),
    c('Gridlines', 'View', 'borders', 'gridlines', null, { keywords: 'toggle hide show lines' }),
    c('Show zeros', 'View', 'eye', 'zeros', null, { keywords: 'toggle hide zero values' }),
    c('Row and column headers', 'View', 'borders', 'toggleHeaders', null, { keywords: 'toggle hide show' }),
    c('Focus mode', 'View', 'eyeOff', 'focusMode', null, { keywords: 'toolbar hide distraction' }),
    c('Check spelling as you type', 'View', 'text', 'toggleSpellcheck', null, { keywords: 'spellcheck toggle' }),
    c('AutoCorrect Options…', 'Tools', 'autoCorrect', 'autoCorrectOptions', null, { keywords: 'autocorrect replace text typing typos capitals capitalize symbols' }),
    c('Customize the Ribbon…', 'Tools', 'customizeRibbon', 'options', 'ribbon', { keywords: 'ribbon tabs groups custom hide rename' }),
    c('Customize Quick Access Toolbar…', 'Tools', 'customizeQuickAccess', 'options', 'quickAccess', { keywords: 'quick access toolbar qat' }),
    c('Customize Keyboard…', 'Tools', 'customizeKeyboard', 'options', 'keyboard', { keywords: 'keyboard shortcuts keys hotkeys' }),
    c('Spelling…', 'Tools', 'spell', 'spelling', null, { shortcut: 'F7', keywords: 'spell check spellcheck proofing dictionary typos misspelled' }),
    c('Thesaurus', 'Tools', 'thesaurus', 'thesaurus', null, { shortcut: 'Shift+F7', keywords: 'synonyms antonyms words meaning alternative' }),
    c('Translate', 'Tools', 'translate', 'translatePane', null, { keywords: 'translator language translation convert' }),
    flags.fullscreen && c('Full screen', 'View', 'monitor', 'fullscreen'),
    c('Zoom in', 'View', 'zoomIn', 'zoom', 0.1),
    c('Zoom out', 'View', 'zoomOut', 'zoom', -0.1),
    c('Custom zoom…', 'View', 'zoomIn', 'zoomCustom', null, { keywords: 'percentage scale magnification' }),
    c('Custom views…', 'View', 'customViews', 'customViews', null, { keywords: 'saved view show add named layout zoom hidden print' }),
    !flags.chartSheet && c('New sheet view', 'View', 'sheetView', 'sheetView', 'new', { keywords: 'personal temporary filter my own view collaborate' }),
    flags.sheetView && c('Exit sheet view', 'View', 'exitView', 'sheetView', 'exit', { keywords: 'default view leave' }),
    !flags.chartSheet && c('Sheet view options…', 'View', 'sliders', 'sheetView', 'options', { keywords: 'rename duplicate delete switch personal view' }),
    !flags.chartSheet && (!flags.viewMode || flags.viewMode === 'normal') && c('Page breaks', 'View', 'pageBreak', 'showPageBreaks', null, { keywords: 'dashed lines pages print toggle' }),
    c('Insert page break', 'File', 'breaks', 'pageBreak', 'insert', { keywords: 'print new page manual' }),
    c('Remove page break', 'File', 'eraser', 'pageBreak', 'remove', { keywords: 'print manual' }),
    c('Reset all page breaks', 'File', 'reset', 'pageBreak', 'reset', { keywords: 'print manual clear' }),
    !flags.chartSheet && c('Sheet background…', 'File', 'background', 'sheetBackground', 'pick', { keywords: 'picture image wallpaper tile' }),
    flags.background && c('Delete sheet background', 'File', 'deleteItem', 'sheetBackground', 'delete', { keywords: 'picture image wallpaper remove' }),
    c('Reset zoom to 100%', 'View', 'reset', 'zoom', 'reset'),
    c('Freeze first row', 'View', 'pin', 'freeze', { rows: 1 }, { keywords: 'lock header' }),
    c('Freeze first column', 'View', 'pin', 'freeze', { cols: 1 }, { keywords: 'lock' }),
    c('Freeze rows up to the selection', 'View', 'pin', 'freeze', 'rows'),
    c('Freeze columns up to the selection', 'View', 'pin', 'freeze', 'cols'),
    c('Unfreeze', 'View', 'reset', 'freeze', 'none', { keywords: 'panes' }),
    c('Hide rows', 'View', 'eyeOff', 'hide', 'row', { shortcut: `${M}+9` }),
    c('Hide columns', 'View', 'eyeOff', 'hide', 'col', { shortcut: `${M}+0` }),
    c('Unhide rows', 'View', 'eye', 'unhide', 'row', { shortcut: `${M}+Shift+9`, keywords: 'show hidden' }),
    c('Unhide columns', 'View', 'eye', 'unhide', 'col', { shortcut: `${M}+Shift+0`, keywords: 'show hidden' }),
    c('Group rows', 'View', 'rows', 'group', 'row', { shortcut: 'Alt+Shift+Right', keywords: 'outline collapse' }),
    c('Group columns', 'View', 'cols', 'group', 'col', { keywords: 'outline collapse' }),
    c('Ungroup rows', 'View', 'rows', 'ungroup', 'row', { shortcut: 'Alt+Shift+Left' }),
    c('Ungroup columns', 'View', 'cols', 'ungroup', 'col'),
    c('Collapse all row groups', 'View', 'chevU', 'collapseAll', 'row'),
    c('Expand all row groups', 'View', 'chevD', 'expandAll', 'row'),
    c('Collapse all column groups', 'View', 'chevL', 'collapseAll', 'col'),
    c('Expand all column groups', 'View', 'chevR', 'expandAll', 'col'),

    c('Insert row above', 'Insert', 'arrowUp', 'insertRows', 'above', { shortcut: `${M}+Shift+=` }),
    c('Insert row below', 'Insert', 'arrowDown', 'insertRows', 'below'),
    c('Insert column left', 'Insert', 'chevL', 'insertCols', 'left'),
    c('Insert column right', 'Insert', 'chevR', 'insertCols', 'right'),
    c('Insert cells, shifting down', 'Insert', 'arrowDown', 'insertCells', 'down'),
    c('Insert cells, shifting right', 'Insert', 'chevR', 'insertCells', 'right'),
    c('Delete rows', 'Insert', 'trash', 'deleteRows', null, { shortcut: `${M}+-`, keywords: 'remove' }),
    c('Delete columns', 'Insert', 'trash', 'deleteCols', null, { keywords: 'remove' }),
    c('Delete cells, shifting up', 'Insert', 'arrowUp', 'deleteCells', 'up', { keywords: 'remove' }),
    c('Delete cells, shifting left', 'Insert', 'chevL', 'deleteCells', 'left', { keywords: 'remove' }),
    c('Checkbox', 'Insert', 'check', 'insertCheckbox', null, { keywords: 'tick boolean' }),
    c('Dropdown…', 'Insert', 'chevD', 'insertDropdown', null, { keywords: 'list validation select' }),
    c('Date picker…', 'Insert', 'calendar', 'datePicker'),
    c('Link…', 'Insert', 'link', 'link', null, { shortcut: `${M}+K`, keywords: 'hyperlink url' }),
    flags.hasLink && c('Remove link', 'Insert', 'unlink', 'unlink'),
    c(flags.hasNote ? 'Edit note' : 'Note', 'Insert', 'note', 'note', null, { shortcut: 'Shift+F2', keywords: 'comment' }),
    flags.hasNote && c('Delete note', 'Insert', 'trash', 'deleteNote', null, { keywords: 'comment remove' }),
    c('Chart…', 'Insert', 'chartColumn', 'insertChart', null, { keywords: 'graph bar line pie' }),
    c('Image…', 'Insert', 'image', 'insertImage', null, { keywords: 'picture upload' }),
    flags.pick && c('Image from Puter…', 'Insert', 'folderOpen', 'insertImagePuter', null, { keywords: 'picture cloud storage drive logo' }),
    c('Image from URL…', 'Insert', 'external', 'insertImageUrl', null, { keywords: 'picture web address link logo' }),
    c('Place picture in cell…', 'Insert', 'placeInCell', 'insertImage', 'cell', { keywords: 'image in cell value photo logo' }),
    flags.cellPicture && c('Place the cell picture over cells', 'Insert', 'placeOverCells', 'placeOverCells', null, { keywords: 'image float picture' }),
    flags.cellPicture && c('Alt text for the cell picture…', 'Insert', 'altText', 'cellAltText', null, { keywords: 'image description accessibility' }),
    flags.copiedCells && c('Paste copied cells as a picture', 'Edit', 'pastePicture', 'pasteWith', { picture: true }, { keywords: 'image snapshot' }),
    flags.copiedCells && c('Paste copied cells as a linked picture', 'Edit', 'linkedPicture', 'pasteWith', { picture: 'linked' }, { keywords: 'camera live image snapshot' }),
    c('Text box…', 'Insert', 'text', 'insertTextBox', null, { keywords: 'label note caption title floating shape drawing' }),
    c('SmartArt graphic…', 'Insert', 'smartArt', 'smartArt', { action: 'insertDialog' }, { keywords: 'diagram org chart organization process cycle hierarchy venn pyramid matrix list timeline' }),
    flags.sparklines && c('Sparkline settings…', 'Format', 'chartLine', 'editSparkline', null, { keywords: 'mini chart axis markers colors data' }),
    c('Sparklines…', 'Insert', 'chartLine', 'insertSparklines', null, { keywords: 'mini chart line column win loss data' }),
    flags.sparklines && c('Group using active sparkline', 'Format', 'chartLine', 'groupSparklines', null, { keywords: 'mini chart shared settings' }),
    flags.sparklines && c('Ungroup selected sparklines', 'Format', 'chartLine', 'groupSparklines', 'ungroup', { keywords: 'mini chart independent settings' }),
    flags.sparklines && c('Clear selected sparklines', 'Format', 'eraser', 'clearSparklines', null, { keywords: 'remove delete mini chart' }),
    flags.sparklines && c('Clear entire selected sparkline groups', 'Format', 'eraser', 'clearSparklines', 'groups', { keywords: 'remove delete mini charts' }),
    c('Sparkline function', 'Insert', 'chartLine', 'insertFunction', 'SPARKLINE', { keywords: 'mini chart in cell' }),
    c('New sheet', 'Insert', 'plus', 'newSheet', null, { shortcut: 'Shift+F11', keywords: 'tab' }),
    flags.grouped && c('Fill across worksheets…', 'Edit', 'layers', 'fillAcrossSheets', null, { keywords: 'group copy same cells other sheets contents formats' }),
    c('Duplicate sheet', 'Insert', 'duplicate', 'duplicateSheet', null, { keywords: 'tab copy' }),
    c('Move or Copy sheet…', 'Insert', 'layers', 'moveOrCopySheet', null, { keywords: 'tab order reorder duplicate destination' }),
    c('Copy sheet to another spreadsheet…', 'Insert', 'copy', 'copySheetTo', null, { keywords: 'tab move export file workbook' }),
    // The sheet tab's other actions, for the active sheet; what the tab menu greys out is left out here.
    c('Rename sheet…', 'Insert', 'pencil', 'renameSheet', null, { keywords: 'tab name' }),
    c('Sheet color…', 'Insert', 'fill', 'sheetColor', null, { keywords: 'tab colour' }),
    !flags.sheet?.first && c('Move sheet left', 'Insert', 'chevL', 'moveSheet', 'left', { keywords: 'tab order reorder' }),
    !flags.sheet?.last && c('Move sheet right', 'Insert', 'chevR', 'moveSheet', 'right', { keywords: 'tab order reorder' }),
    c(flags.sheet?.protected ? 'Unprotect sheet' : 'Protect sheet', 'Insert', 'lock', 'protectSheet', null, { keywords: 'lock unlock tab' }),
    !flags.sheet?.only && c('Hide sheet', 'Insert', 'eyeOff', 'hideSheet', null, { keywords: 'tab' }),
    !flags.sheet?.only && c(flags.sheet?.holdsWork ? 'Delete sheet…' : 'Delete sheet', 'Insert', 'trash', 'deleteSheet', null, { keywords: 'tab remove' }),
    flags.grouped ? c('Ungroup sheets', 'Insert', 'layers', 'ungroupSheets', null, { keywords: 'tabs group selected sheets single' })
      : !flags.sheet?.only && c('Select all sheets', 'Insert', 'layers', 'selectAllSheets', null, { keywords: 'tabs group several sheets at once edit together' }),
    c('Insert function…', 'Insert', 'sigma', 'functionMenu', null, { shortcut: 'Shift+F3', keywords: 'formula wizard' }),
    c('AutoSum', 'Insert', 'sigma', 'autosum', null, { shortcut: 'Alt+=', keywords: 'sum total' }),

    c('Sort range A to Z', 'Data', 'sortAsc', 'sort', 'asc', { keywords: 'ascending' }),
    c('Sort range Z to A', 'Data', 'sortDesc', 'sort', 'desc', { keywords: 'descending' }),
    c('Sort range…', 'Data', 'sliders', 'sortDialog', null, { keywords: 'multiple columns color' }),
    c(flags.filter ? 'Remove filter' : 'Create filter', 'Data', 'filter', 'filter', null, { shortcut: `${M}+Shift+L` }),
    flags.hasTable ? c('Edit table…', 'Data', 'table', 'editTable', null, { keywords: 'name style totals' }) : c('Create table…', 'Data', 'table', 'insertTable', null, { keywords: 'structured banded' }),
    flags.hasTable && c('Toggle the table’s totals row', 'Data', 'sigma', 'tableTotals'),
    c('Subtotals…', 'Data', 'sigma', 'subtotal', null, { keywords: 'group by outline' }),
    c('Auto Outline', 'Data', 'group', 'autoOutline', null, { keywords: 'group rows columns summary totals outline automatic' }),
    c('Clear Outline', 'Data', 'eraser', 'clearOutline', null, { keywords: 'remove groups ungroup all outline' }),
    c('Outline settings…', 'Data', 'sliders', 'outlineSettings', null, { keywords: 'summary rows below columns right automatic styles outline' }),
    c('Pivot table…', 'Data', 'pivot', 'pivot', null, { keywords: 'summarize' }),
    c('Column stats…', 'Data', 'chartColumn', 'columnStats', null, { keywords: 'summary distribution' }),
    c('Data form…', 'Data', 'dataForm', 'dataForm', null, { keywords: 'record entry fields list database criteria find' }),
    c('Goal seek…', 'Data', 'sliders', 'goalSeek', null, { keywords: 'what if solve' }),
    c('Data table…', 'Data', 'table', 'dataTable', null, { keywords: 'what if analysis sensitivity' }),
    c('Solver…', 'Data', 'solver', 'solver', null, { keywords: 'optimize optimization maximize minimize linear programming constraints simplex nonlinear evolutionary' }),
    c('Data analysis…', 'Data', 'dataAnalysis', 'dataAnalysis', null, { keywords: 'statistics anova regression histogram correlation covariance descriptive t-test z-test f-test fourier sampling random moving average smoothing rank percentile' }),
    c('Remove duplicate rows…', 'Data', 'dedupe', 'dedupe', null, { keywords: 'unique' }),
    c('Remove empty rows', 'Data', 'rows', 'removeEmptyRows', null, { keywords: 'blank' }),
    c('Randomize range', 'Data', 'sortAsc', 'shuffle', null, { keywords: 'shuffle random order' }),
    c('Split text to columns', 'Data', 'cols', 'splitText', null, { keywords: 'delimiter comma' }),
    c('Text to Columns…', 'Data', 'cols', 'splitTextDialog', null, { keywords: 'split delimiter separator fixed width' }),
    c('Trim whitespace', 'Data', 'text', 'textCase', 'trim'),
    c('UPPERCASE text', 'Data', 'text', 'textCase', 'upper', { keywords: 'case' }),
    c('lowercase text', 'Data', 'text', 'textCase', 'lower', { keywords: 'case' }),
    c('Capitalize Each Word', 'Data', 'text', 'textCase', 'proper', { keywords: 'case title' }),
    c('Convert text to numbers', 'Data', 'number', 'textCase', 'number', { keywords: 'stored as text' }),
    c('Data validation…', 'Data', 'validation', 'validation', null, { keywords: 'rules dropdown checkbox' }),
    c('Named ranges…', 'Data', 'tag', 'names', null, { keywords: 'define name' }),
    c('Protected ranges…', 'Data', 'lock', 'protectRanges', null, { keywords: 'lock sheet protect' }),
    c('Edit links…', 'Data', 'editLinks', 'editLinks', null, { keywords: 'external workbook references other file update values change source break startup prompt' }),

    c('Bold', 'Format', 'bold', 'bold', null, { shortcut: `${M}+B` }),
    c('Italic', 'Format', 'italic', 'italic', null, { shortcut: `${M}+I` }),
    c('Underline', 'Format', 'underline', 'underline', null, { shortcut: `${M}+U` }),
    c('Strikethrough', 'Format', 'strike', 'strike', null, { shortcut: `${M}+5` }),
    c('Format Cells…', 'Format', 'formatCells', 'formatCells', null, { shortcut: `${M}+1`, keywords: 'number alignment font border fill dialog' }),
    c('Conditional formatting…', 'Format', 'highlighter', 'condFormat', null, { keywords: 'rules color scale data bars' }),
    c('Alternating colors', 'Format', 'rows', 'bands', null, { keywords: 'banding stripes zebra' }),
    c('Cell styles…', 'Format', 'paint', 'cellStylesMenu', null, { keywords: 'title heading total good bad' }),
    !flags.editing && c('New cell style…', 'Format', 'plus', 'newCellStyle', null, { keywords: 'named style create define by example' }),
    !flags.editing && c('Merge cell styles…', 'Format', 'paint', 'mergeCellStyles', null, { keywords: 'copy styles from another workbook spreadsheet import' }),
    c('Paint format', 'Format', 'paint', 'paintFormat', null, { keywords: 'copy formatting brush' }),
    // A single unmerged cell has nothing to merge; one row nothing to merge vertically, one column nothing horizontally.
    flags.merged ? c('Unmerge cells', 'Format', 'unmerge', 'merge', null, { keywords: 'merge split' }) : !flags.singleCell && c('Merge cells', 'Format', 'merge', 'merge', null, { keywords: 'unmerge' }),
    !flags.singleCell && !flags.oneCol && c('Merge horizontally', 'Format', 'rows', 'mergeAcross'),
    !flags.singleCell && !flags.oneRow && c('Merge vertically', 'Format', 'cols', 'mergeDown'),
    c('Wrap text', 'Format', 'wrap', 'wrapMode', 'wrap'),
    c('Clip text', 'Format', 'x', 'wrapMode', 'clip'),
    c('Overflow text', 'Format', 'chevR', 'wrapMode', 'overflow'),
    c('Align left', 'Format', 'alignLeft', 'align', 'left'),
    c('Align center', 'Format', 'alignCenter', 'align', 'center'),
    c('Align right', 'Format', 'alignRight', 'align', 'right'),
    c('Align top', 'Format', 'arrowUp', 'valign', 'top', { keywords: 'vertical' }),
    c('Align middle', 'Format', 'borderTop', 'valign', 'middle', { keywords: 'vertical' }),
    c('Align bottom', 'Format', 'arrowDown', 'valign', 'bottom', { keywords: 'vertical' }),
    c('Increase indent', 'Format', 'indentMore', 'indent', 1),
    c('Decrease indent', 'Format', 'indentLess', 'indent', -1),
    c('Rotate text up (45°)', 'Format', 'text', 'rotate', 45, { keywords: 'tilt angle' }),
    c('Rotate text down (−45°)', 'Format', 'text', 'rotate', -45, { keywords: 'tilt angle' }),
    c('Rotate text up (90°)', 'Format', 'text', 'rotate', 90, { keywords: 'vertical angle' }),
    c('Rotate text down (−90°)', 'Format', 'text', 'rotate', -90, { keywords: 'vertical angle' }),
    c('Custom text rotation…', 'Format', 'text', 'rotate', 'custom', { keywords: 'angle degrees tilt' }),
    c('No text rotation', 'Format', 'text', 'rotate', 0, { keywords: 'angle reset' }),
    c('Larger font', 'Format', 'fontSize', 'fontStep', 1, { shortcut: `${M}+Shift+>` }),
    c('Smaller font', 'Format', 'fontSize', 'fontStep', -1, { shortcut: `${M}+Shift+<` }),
    c('Custom font size…', 'Format', 'fontSize', 'fontSize', null, { keywords: 'text size typography' }),
    c('Number format: Automatic', 'Format', 'text', 'fmt', 'general', { shortcut: `${K}+Shift+~`, keywords: 'general reset' }),
    c('Number format: Number', 'Format', 'number', 'fmt', 'number', { shortcut: `${K}+Shift+!`, keywords: 'decimal thousands' }),
    c('Number format: Currency', 'Format', 'currency', 'fmt', 'currency', { shortcut: `${K}+Shift+$`, keywords: 'money dollar euro' }),
    c('Number format: Percent', 'Format', 'percent', 'fmt', 'percent', { shortcut: `${K}+Shift+%` }),
    c('Number format: Date', 'Format', 'calendar', 'fmt', 'date', { shortcut: `${K}+Shift+#` }),
    c('Number format: Time', 'Format', 'clock', 'fmt', 'time', { shortcut: `${K}+Shift+@` }),
    c('Number format: Scientific', 'Format', 'number', 'fmt', 'scientific', { shortcut: `${K}+Shift+^` }),
    c('Number format: Plain text', 'Format', 'text', 'fmt', 'text', { keywords: 'as typed' }),
    !noDecimals && c('More decimal places', 'Format', 'decMore', 'dec', 1),
    !noDecimals && c('Fewer decimal places', 'Format', 'decLess', 'dec', -1),
    c('All borders', 'Format', 'borders', 'borders', 'all'),
    c('Outer borders', 'Format', 'borderOuter', 'borders', 'outer', { shortcut: `${K}+Shift+&`, keywords: 'outline box' }),
    c('Inner borders', 'Format', 'borders', 'borders', 'inner'),
    c('No borders', 'Format', 'borderNone', 'borders', 'none', { shortcut: `${K}+Shift+_`, keywords: 'remove clear' }),
    c('Fit columns to content', 'Format', 'cols', 'autofit', null, { keywords: 'autofit width' }),
    c('Fit rows to content', 'Format', 'rows', 'fitRows', null, { keywords: 'autofit height' }),
    c('Resize rows…', 'Format', 'rows', 'resizeRows', null, { keywords: 'height' }),
    c('Resize columns…', 'Format', 'cols', 'resizeCols', null, { keywords: 'width' }),

    flags.hasFormula && c('Evaluate formula step by step…', 'Formula', 'fx', 'evaluateFormula', null, { keywords: 'debug audit' }),
    flags.hasFormula && c('Show precedents', 'Formula', 'fx', 'trace', 'precedents', { shortcut: `${M}+[`, keywords: 'audit cells it reads' }),
    c('Show dependents', 'Formula', 'fx', 'trace', 'dependents', { shortcut: `${M}+]`, keywords: 'audit formulas reading this cell' }),
    c('Replace formulas with values', 'Formula', 'number', 'toValues', null, { keywords: 'convert static results constants' }),
    flags.ai && c(flags.aiPanel ? 'Close the AI assistant' : 'Open the AI assistant', 'View', 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, keywords: 'chat copilot gemini ask analyze agent sidebar panel help' }),
    flags.ai && c('Write a formula with AI…', 'Formula', 'sparkle', 'aiFormula', null, { keywords: 'generate assistant' }),
    c(flags.scriptsPane ? 'Close the Code Editor' : 'Open the Code Editor', 'Automate', 'codeEditor', 'scriptsPane', null, { keywords: 'script macro code automate javascript editor' }),
    c('New script', 'Automate', 'newScript', 'newScript', null, { keywords: 'macro code automate javascript' }),
    c(flags.recording ? 'Stop recording actions' : 'Record actions', 'Automate', 'recordActions', 'recordActions', null, { keywords: 'macro recorder automate script' }),
    c('All scripts…', 'Automate', 'allScripts', 'scriptGallery', null, { keywords: 'gallery samples macros my scripts library' }),
    c('Script reference', 'Automate', 'scriptReference', 'scriptReference', null, { keywords: 'api documentation help javascript' }),
    ...SAMPLE_SCRIPTS.map((sample) => c(`Run sample script: ${sample.name}`, 'Automate', 'runScript', 'runScript', { sample: sample.id }, { keywords: `macro ${sample.description}` })),
    flags.ai && flags.hasFormula && c('Explain this formula (AI)…', 'Formula', 'sparkle', 'aiExplain', null, { keywords: 'assistant' }),
    flags.ai && c('Ask AI about this data…', 'Data', 'sparkle', 'aiAsk', null, { keywords: 'question summarize insights assistant analyze' }),

    flags.chart && !flags.chartIsImage && c('Edit the selected chart…', 'Chart', 'chartColumn', 'editChart', flags.chart, { shortcut: 'Enter', keywords: 'type range title colors' }),
    flags.chart && flags.chartIsImage && c('Replace the selected image…', 'Chart', 'image', 'replaceImage', flags.chart),
    flags.chart && flags.chartIsImage && c('Place the selected picture in a cell', 'Chart', 'placeInCell', 'placeObjectInCell', flags.chart, { keywords: 'image cell value' }),
    flags.chart && flags.chartIsImage && c('Crop the selected picture…', 'Chart', 'crop', 'pictureFormat', { action: 'crop' }, { keywords: 'image trim aspect' }),
    flags.chart && flags.chartIsImage && c('Picture corrections…', 'Chart', 'corrections', 'pictureFormat', { action: 'correctionsDialog' }, { keywords: 'image brightness contrast transparency' }),
    flags.chart && flags.chartIsImage && c('Reset the selected picture', 'Chart', 'resetPicture', 'pictureFormat', { action: 'reset' }, { keywords: 'image corrections style' }),
    flags.chart && c(flags.chartIsImage ? 'Duplicate the selected image' : 'Duplicate the selected chart', 'Chart', 'duplicate', 'duplicateChart', { id: flags.chart }),
    flags.chart && c(flags.chartIsImage ? 'Copy the selected image' : 'Copy the selected chart as a picture', 'Chart', 'copy', 'copyChart', { id: flags.chart }, { keywords: 'clipboard png' }),
    flags.chart && c(flags.chartIsImage ? 'Download the selected image' : 'Download the selected chart as PNG', 'Chart', 'download', 'downloadChart', { id: flags.chart, format: 'png' }),
    flags.chart && !flags.chartIsImage && c('Download the selected chart as SVG', 'Chart', 'download', 'downloadChart', { id: flags.chart, format: 'svg' }),
    flags.chart && c(flags.chartIsImage ? 'Delete the selected image' : 'Delete the selected chart', 'Chart', 'trash', 'deleteChart', flags.chart, { shortcut: 'Delete', keywords: 'remove' }),
    flags.fns?.shortcuts && { label: 'Keyboard shortcuts…', section: 'Help', icon: 'keyboard', fn: flags.fns.shortcuts, keywords: 'keys help' },
    flags.fns?.locale && { label: 'Regional format…', section: 'Help', icon: 'monitor', fn: flags.fns.locale, keywords: 'locale decimal comma date order language' },
  ];
  // Grouped sheets: the commands for one sheet's objects are greyed in the menus, so they are left out here.
  return list.filter((item) => item && !(flags.grouped && item.cmd && GROUP_BLOCKED_COMMANDS.has(item.cmd)));
}

const RECENT_KEY = 'spreadsheet:palette:recent';
const RECENT_MAX = 8;

/** Labels of the actions used most recently, newest first. */
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
 * lead the list.
 */
export function matchCommands(commands, query, limit = 40, recent = recentCommands()) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const lead = recent.map((label) => commands.find((c) => c.label === label)).filter(Boolean);
    const rest = commands.filter((c) => !lead.includes(c));
    return [...lead.map((c) => ({ ...c, recent: true })), ...rest].slice(0, limit);
  }
  const scored = [];
  commands.forEach((cmd, i) => {
    const label = cmd.label.toLowerCase();
    const hay = `${label} ${cmd.section.toLowerCase()} ${(cmd.keywords || '').toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    let score = 3;
    if (label.startsWith(words.join(' '))) score = 0;
    else if (words.every((w) => label.includes(w))) score = new RegExp(`(^|[^a-z])${words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label) ? 1 : 2;
    scored.push({ cmd, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.cmd);
}

/**
 * Open the palette. `run(cmd, arg)` runs an editor command; entries with `fn`
 * call it instead. Resolves to nothing; `onClose` fires when it goes away.
 */
export function openCommandPalette({ commands, run, onClose, placeholder = 'Search the menus…' }) {
  const input = el('input.palette-input', {
    type: 'text', placeholder, 'aria-label': 'Search the menus', autocomplete: 'off', spellcheck: false,
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
  });
  const list = el('div.palette-list', { role: 'listbox', id: 'palette-list', 'aria-label': 'Actions' });
  // "No action matches" is said beside the listbox, not inside it as a child that is no option, and
  // as a status, so a screen reader hears it when the search comes up empty.
  const empty = el('div.palette-empty', { role: 'status', 'aria-live': 'polite' });
  const panel = el('div.palette-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search the menus' },
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
    empty.textContent = shown.length ? '' : 'No action matches that';
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
      el('span.menu-label', {}, cmd.label, el('span.palette-section', { id: `palette-sec-${i}` }, cmd.recent ? `Recent · ${cmd.section}` : cmd.section)),
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
    rememberCommand(cmd.label);
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
