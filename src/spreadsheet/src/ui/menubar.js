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

export const MENU_TITLES = [
  ['file', 'File'], ['edit', 'Edit'], ['view', 'View'], ['insert', 'Insert'],
  ['format', 'Format'], ['data', 'Data'], ['tools', 'Tools'], ['help', 'Help'],
];

/** The cell kinds "Select cells of a kind" offers (mirrors Workbook.specialCells). */
export const SPECIAL_KINDS = {
  blanks: 'Blank cells', formulas: 'Formulas', constants: 'Typed values', numbers: 'Numbers', text: 'Text', errors: 'Errors', notes: 'Cells with notes',
  currentRegion: 'Current region', rowDiff: 'Row differences', colDiff: 'Column differences', precedents: 'Precedents', dependents: 'Dependents',
  lastCell: 'Last cell', visible: 'Visible cells only', conditionalFormats: 'Conditional formats', validation: 'Data validation',
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
  const sub = (label, icon, items) => ({ label, icon, submenu: items.filter(Boolean) });
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
    i('New spreadsheet', 'filePlus', 'new'),
    f.templates && i('New from template…', 'sparkle', 'newFromTemplate'),
    f.pick && i('Open from Puter…', 'folderOpen', 'open', null, { shortcut: `${M}+O` }),
    sub('Import', 'upload', [
      i('From this device…', 'upload', 'import'),
      i('From a URL…', 'external', 'importUrl'),
      i('Into this spreadsheet…', 'sheet', 'importSheets'),
    ]),
    sep,
    i('Save', 'save', 'save', null, { shortcut: `${M}+S` }),
    i('Save a copy…', 'duplicate', 'saveAs'),
    i('Rename…', 'pencil', 'rename'),
    (f.share || f.mail) && sub('Share', 'share', [
      f.share && i('Share with people…', 'share', 'share'),
      f.mail && i('Send a copy…', 'sendCopy', 'sendCopy'),
      f.mail && f.share && i('Send a link…', 'sendLink', 'sendLink'),
    ]),
    i('Version history…', 'clock', 'versions'),
    i('Show changes', 'showChanges', 'showChanges', null, { checked: !!f.changesPane }),
    i('Document details…', 'info', 'docInfo'),
    sep,
    sub(saving ? 'Export' : 'Download', 'fileDown', [
      i(saving ? 'Excel workbook (.xlsx)…' : 'Excel workbook (.xlsx)', 'fileDown', 'downloadXlsx'),
      i(saving ? 'OpenDocument (.ods)…' : 'OpenDocument (.ods)', 'fileDown', 'downloadOds'),
      i(saving ? 'Sheet as .csv…' : 'Sheet as .csv', 'fileDown', 'downloadCsv'),
      i(saving ? 'Sheet as .tsv…' : 'Sheet as .tsv', 'fileDown', 'downloadTsv'),
      i(saving ? 'Sheet as a web page (.html)…' : 'Sheet as a web page (.html)', 'fileDown', 'downloadHtml'),
      i(saving ? 'Selection as .csv…' : 'Selection as .csv', 'fileDown', 'downloadRangeCsv'),
      sep,
      i('PDF…', 'fileDown', 'exportPdf'),
    ]),
    i('Print…', 'printer', 'print', null, { shortcut: `${M}+P` }),
    sub('Print area', 'printer', [
      i('Set print area', 'printer', 'printArea', 'set'),
      i('Add to print area', 'plus', 'printArea', 'add'),
      i('Clear print area', 'eraser', 'printArea', 'clear'),
    ].map(waits)),
    sub('Page breaks', 'breaks', [
      i('Insert page break', 'breaks', 'pageBreak', 'insert'),
      i('Remove page break', 'eraser', 'pageBreak', 'remove'),
      i('Reset all page breaks', 'reset', 'pageBreak', 'reset'),
    ].map(waits)),
    sub('Sheet background', 'background', [
      i(f.background ? 'Replace background…' : 'Background picture…', 'background', 'sheetBackground', 'pick', { disabled: f.chartSheet }),
      i('Delete background', 'deleteItem', 'sheetBackground', 'delete', { disabled: !f.background }),
    ].map(waits)),
    sep,
    i('Options…', 'options', 'options', null, { shortcut: `${M}+,` }),
    sep,
    i('Back to all spreadsheets', 'back', 'home'),
  ];

  const edit = [
    i('Undo', 'undo', 'undo', null, { shortcut: `${M}+Z`, disabled: editing || f.canUndo === false }),
    i('Redo', 'redo', 'redo', null, { shortcut: `${M}+Shift+Z`, disabled: editing || f.canRedo === false }),
    sep,
    waits(i('Cut', 'cut', 'cut', null, { shortcut: `${M}+X`, disabled: !!f.chart })),
    waits(i('Copy', 'copy', 'copy', null, { shortcut: `${M}+C` })),
    waits(i('Paste', 'paste', 'paste', null, { shortcut: `${M}+V` })),
    sub('Paste special', 'paste', [
      i('Values only', 'paste', 'pasteValues', null, { shortcut: `${M}+Shift+V` }),
      i('Formatting only', 'paint', 'pasteFormats'),
      i('Formulas only (keep formatting)', 'fx', 'pasteSpecial', 'formulas'),
      i('Transposed', 'pivot', 'pasteTranspose'),
      i('Skip blanks', 'paste', 'pasteSpecial', 'skipBlanks'),
      i('Column widths only', 'cols', 'pasteSpecial', 'widths'),
      i('Links to the copied cells', 'link', 'pasteSpecial', 'link'),
      sep,
      i('Insert copied cells, shifting down', 'arrowDown', 'pasteSpecial', 'insertDown'),
      i('Insert copied cells, shifting right', 'chevR', 'pasteSpecial', 'insertRight'),
      sep,
      { header: 'Combine with the numbers here' },
      i('Add', null, 'pasteSpecial', 'add'),
      i('Subtract', null, 'pasteSpecial', 'sub'),
      i('Multiply', null, 'pasteSpecial', 'mul'),
      i('Divide', null, 'pasteSpecial', 'div'),
      sep,
      i('Paste Special…', 'paste', 'pasteSpecialMenu', null, { shortcut: IS_MAC ? '⌃+⌘+V' : `${M}+Alt+V` }),
    ].map(waits)),
    i('Copy link to this cell or range', 'link', 'copyLink'),
    sep,
    sub('Fill', 'arrowDown', [
      waits(i('Down', 'fillDown', 'fillDown', null, { shortcut: `${M}+D` })),
      waits(i('Right', 'fillRight', 'fillRight', null, { shortcut: `${M}+R` })),
      waits(i('Up', 'fillUp', 'fillUp')),
      waits(i('Left', 'fillLeft', 'fillLeft')),
      i('Series…', 'series', 'fillSeries'),
      waits(i('Justify', 'alignLeft', 'fillJustify')),
      waits(i('Flash Fill', 'flashFill', 'flashFill', null, { shortcut: `${M}+E` })),
      waits(i('Across Worksheets…', 'layers', 'fillAcrossSheets', null, f.grouped ? {} : { disabled: true, hint: 'Group sheets first: Shift-click or ' + (IS_MAC ? '⌘' : 'Ctrl') + '-click their tabs' })),
      sep,
      i('Today’s date', 'calendar', 'insertDate', null, { shortcut: `${M}+;` }),
      i('The current time', 'clock', 'insertTime', null, { shortcut: `${M}+Shift+;` }),
      i('The formula from the cell above', 'fx', 'copyAbove', 'formula', { shortcut: `${M}+'` }),
    ]),
    sep,
    i('Find and replace…', 'search', 'find', null, { shortcut: `${M}+F` }),
    i('Go to cell or range…', 'search', 'goTo', null, { shortcut: `${M}+G` }),
    sub('Select', 'check', [
      i('All', 'check', 'selectAll', null, { shortcut: `${M}+A` }),
      sep,
      { header: 'Cells of a kind' },
      ...Object.entries(SPECIAL_KINDS).map(([kind, label]) => i(label, null, 'selectSpecial', kind)),
    ]),
    sep,
    sub('Delete', 'trash', [
      i('Rows', 'rows', 'deleteRows', null, { shortcut: `${M}+-` }),
      i('Columns', 'cols', 'deleteCols'),
      i('Cells, shifting up', 'arrowUp', 'deleteCells', 'up'),
      i('Cells, shifting left', 'chevL', 'deleteCells', 'left'),
    ]),
    waits(i('Clear contents', 'eraser', 'clear', null, { shortcut: 'Delete' })),
    i('Clear formatting', 'eraser', 'clearFormat', null),
    sep,
    i('Recalculate all formulas', 'reset', 'recalc', null, { shortcut: 'F9' }),
  ];

  const view = [
    // The sheet's view comes first.
    i('Normal', 'normalView', 'viewMode', 'normal', { checked: (f.viewMode || 'normal') === 'normal', disabled: f.chartSheet }),
    i('Page Layout', 'pageLayout', 'viewMode', 'pageLayout', { checked: f.viewMode === 'pageLayout', disabled: f.chartSheet }),
    i('Page Break Preview', 'pageBreak', 'viewMode', 'pageBreak', { checked: f.viewMode === 'pageBreak', disabled: f.chartSheet }),
    waits(i('Custom views…', 'customViews', 'customViews')),
    sub('Sheet view', 'sheetView', [
      i('Default', null, 'sheetView', { action: 'switch', id: null }, { checked: !f.sheetView, disabled: f.chartSheet }),
      sep,
      i('New sheet view', 'sheetView', 'sheetView', 'new', { disabled: f.chartSheet }),
      i('Keep…', 'save', 'sheetView', 'keep', { disabled: !f.sheetView?.temporary }),
      i('Exit', 'exitView', 'sheetView', 'exit', { disabled: !f.sheetView }),
      i('Options…', 'sliders', 'sheetView', 'options', { disabled: f.chartSheet }),
    ].map(waits)),
    sep,
    i('Show formulas', 'fx', 'showFormulas', null, { shortcut: `${K}+\``, checked: !!f.showFormulas }),
    i('Gridlines', 'borders', 'gridlines', null, { checked: f.gridlines !== false }),
    i('Show zeros', 'eye', 'zeros', null, { checked: f.zeros !== false }),
    i('Row and column headers', 'borders', 'toggleHeaders', null, { checked: f.headers !== false }),
    i('Formula bar', 'fx', 'formulaBar', null, { checked: f.formulaBar !== false }),
    i('Page breaks', 'pageBreak', 'showPageBreaks', null, { checked: !!f.showPageBreaks, disabled: f.chartSheet || (f.viewMode && f.viewMode !== 'normal') }),
    sep,
    sub('Freeze', 'pin', [
      i('First row', 'pin', 'freeze', { rows: 1 }),
      i('First column', 'pin', 'freeze', { cols: 1 }),
      i('Rows up to the selection', 'pin', 'freeze', 'rows'),
      i('Columns up to the selection', 'pin', 'freeze', 'cols'),
      sep,
      i('Unfreeze', 'reset', 'freeze', 'none'),
    ]),
    i('Split', 'split', 'split', null, { checked: !!f.split }),
    sub('Hide and unhide', 'eyeOff', [
      i('Hide rows', 'eyeOff', 'hide', 'row', { shortcut: `${M}+9` }),
      i('Hide columns', 'eyeOff', 'hide', 'col', { shortcut: `${M}+0` }),
      sep,
      i('Unhide rows', 'eye', 'unhide', 'row', { shortcut: `${M}+Shift+9` }),
      i('Unhide columns', 'eye', 'unhide', 'col', { shortcut: `${M}+Shift+0` }),
    ]),
    sub('Group', 'rows', [
      i('Group rows', 'rows', 'group', 'row', { shortcut: 'Alt+Shift+Right' }),
      i('Group columns', 'cols', 'group', 'col'),
      i('Ungroup rows', 'rows', 'ungroup', 'row', { shortcut: 'Alt+Shift+Left' }),
      i('Ungroup columns', 'cols', 'ungroup', 'col'),
      sep,
      i('Collapse all row groups', 'chevU', 'collapseAll', 'row'),
      i('Expand all row groups', 'chevD', 'expandAll', 'row'),
      i('Collapse all column groups', 'chevL', 'collapseAll', 'col'),
      i('Expand all column groups', 'chevR', 'expandAll', 'col'),
    ]),
    sep,
    sub('Zoom', 'zoomIn', [
      i('Custom zoom…', 'zoomIn', 'zoomCustom'),
      i('Zoom in', 'zoomIn', 'zoom', 0.1),
      i('Zoom out', 'zoomOut', 'zoom', -0.1),
      i('Reset to 100%', 'reset', 'zoom', 'reset'),
    ]),
    i('Focus mode', 'eyeOff', 'focusMode', null, { checked: !!f.focus }),
    f.ai && i('AI assistant', 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, checked: !!f.aiPanel }),
    f.fullscreen && i('Full screen', 'monitor', 'fullscreen', null, { checked: !!f.isFullscreen }),
  ];

  const insert = [
    sub('Rows and columns', 'rows', [
      i('Row above', 'arrowUp', 'insertRows', 'above', { shortcut: `${M}+Shift+=` }),
      i('Row below', 'arrowDown', 'insertRows', 'below'),
      sep,
      i('Column left', 'chevL', 'insertCols', 'left'),
      i('Column right', 'chevR', 'insertCols', 'right'),
    ]),
    sub('Cells', 'borders', [
      i('Cells, shifting down', 'arrowDown', 'insertCells', 'down'),
      i('Cells, shifting right', 'chevR', 'insertCells', 'right'),
      sep,
      waits(i('Copied Cells…', 'paste', 'insertCopiedCells', null, { disabled: editing || !f.copiedCells })),
    ]),
    sep,
    i('Chart…', 'chartColumn', 'insertChart'),
    i('Sparklines…', 'chartLine', 'insertSparklines'),
    sub('Image', 'image', [
      i('From this device…', 'image', 'insertImage'),
      f.pick && i('From Puter…', 'folderOpen', 'insertImagePuter'),
      i('From a URL…', 'external', 'insertImageUrl'),
      sep,
      // The picture as the active cell's value, sized to the cell: it moves, sorts and copies with it.
      sub('Place in Cell', 'placeInCell', [
        i('From this device…', 'image', 'insertImage', 'cell'),
        f.pick && i('From Puter…', 'folderOpen', 'insertImagePuter', 'cell'),
        i('From a URL…', 'external', 'insertImageUrl', 'cell'),
      ]),
    ]),
    i('Text box…', 'text', 'insertTextBox'),
    i('SmartArt…', 'smartArt', 'smartArt', { action: 'insertDialog' }),
    i('Slicer…', 'slicer', 'insertSlicer', null, { disabled: !f.hasTable && !f.pivotReport }),
    i('Timeline…', 'timeline', 'insertTimeline', null, { disabled: !f.pivotReport }),
    sep,
    sub('Function', 'sigma', [
      i('Function…', 'sigma', 'functionMenu', null, { shortcut: 'Shift+F3' }),
      i('Insert Function dialog…', 'fx', 'insertFunctionDialog'),
      i('AutoSum', 'sigma', 'autosum', null, { shortcut: 'Alt+=' }),
      i('Sparkline', 'chartLine', 'insertFunction', 'SPARKLINE'),
    ]),
    i('Checkbox', 'check', 'insertCheckbox'),
    i('Dropdown…', 'chevD', 'insertDropdown'),
    i('Date picker…', 'calendar', 'datePicker'),
    sep,
    home(i('Link…', 'link', 'link', null, { shortcut: `${M}+K` })),
    f.hasLink && home(i('Remove link', 'unlink', 'unlink')),
    home(i(f.hasNote ? 'Edit note' : 'Note', 'note', 'note', null, { shortcut: 'Shift+F2' })),
    f.hasNote && home(i('Delete note', 'trash', 'deleteNote')),
    !f.hasNote && home(i(f.hasComment ? 'Reply to comment' : 'Comment', 'comment', f.hasComment ? 'replyComment' : 'newComment', null, { shortcut: `${M}+Shift+F2` })),
    f.hasComment && home(i('Delete comment', 'deleteComment', 'deleteComment')),
    sep,
    // What the sheet tab's menu offers, for the active sheet, with the same greying: the last sheet showing cannot be
    // hidden or deleted, an end one not moved past the end. Delete asks first only when the sheet holds work.
    sub('Sheet', 'sheet', [
      i('New sheet', 'plus', 'newSheet', null, { shortcut: 'Shift+F11' }),
      ...[
        i('Duplicate sheet', 'duplicate', 'duplicateSheet'),
        i('Move or Copy sheet…', 'layers', 'moveOrCopySheet'),
        i('Copy sheet to another spreadsheet…', 'copy', 'copySheetTo'),
        i('Rename sheet…', 'pencil', 'renameSheet'),
        i('Sheet color…', 'fill', 'sheetColor'),
        sep,
        i('Move sheet left', 'chevL', 'moveSheet', 'left', { disabled: !!f.sheet?.first }),
        i('Move sheet right', 'chevR', 'moveSheet', 'right', { disabled: !!f.sheet?.last }),
        sep,
        i(f.sheet?.protected ? 'Unprotect sheet' : 'Protect sheet', 'lock', 'protectSheet'),
        i('Hide sheet', 'eyeOff', 'hideSheet', null, { disabled: !!f.sheet?.only }),
        i(f.sheet?.holdsWork ? 'Delete sheet…' : 'Delete sheet', 'trash', 'deleteSheet', null, { disabled: !!f.sheet?.only, danger: true }),
      ].map(home),
      sep,
      // Grouping: edits on the sheet in view reach every grouped sheet (Shift- or Ctrl-click the tabs to pick some).
      f.grouped ? i('Ungroup sheets', 'layers', 'ungroupSheets') : i('Select all sheets', 'layers', 'selectAllSheets', null, { disabled: !!f.sheet?.only }),
    ]),
  ];

  // One choice of several is a radio item, so a screen reader does not call a number format or an alignment a checkbox.
  const fmtItem = (label, icon, value, shortcut) => i(label, icon, 'fmt', value, { checked: fmt === value, radio: true, shortcut });
  const noDecimals = ['date', 'time', 'datetime', 'text', 'custom'].includes(fmt);
  // The sparkline commands lead the menu only on a sheet that holds sparklines: elsewhere they could only
  // answer that there is none, and they pushed Number and Text down on every sheet.
  const sparklines = f.sparklines ? [
    i('Sparkline settings…', 'chartLine', 'editSparkline'),
    sub('Sparkline grouping', 'chartLine', [
      i('Group using active sparkline', 'chartLine', 'groupSparklines'),
      i('Ungroup selected sparklines', 'chartLine', 'groupSparklines', 'ungroup'),
    ]),
    sub('Clear sparklines', 'eraser', [
      i('Selected sparklines', 'eraser', 'clearSparklines'),
      i('Entire selected groups', 'eraser', 'clearSparklines', 'groups'),
    ]),
    sep,
  ] : [];
  const format = [
    ...sparklines,
    sub('Number', 'number', [
      fmtItem('Automatic', 'text', 'general', `${K}+Shift+~`),
      fmtItem('Number', 'number', 'number', `${K}+Shift+!`),
      fmtItem('Currency', 'currency', 'currency', `${K}+Shift+$`),
      fmtItem('Percent', 'percent', 'percent', `${K}+Shift+%`),
      fmtItem('Date', 'calendar', 'date', `${K}+Shift+#`),
      fmtItem('Time', 'clock', 'time', `${K}+Shift+@`),
      fmtItem('Scientific', 'number', 'scientific', `${K}+Shift+^`),
      fmtItem('Plain text', 'text', 'text'),
      sep,
      // Dates, times, text and custom codes have no decimal places to step, as the toolbar shows.
      waits(i('More decimal places', 'decMore', 'dec', 1, { disabled: noDecimals })),
      waits(i('Fewer decimal places', 'decLess', 'dec', -1, { disabled: noDecimals })),
      sep,
      i('More formats…', 'sliders', 'formatCells', 'number'),
    ]),
    sub('Text', 'bold', [
      i('Bold', 'bold', 'bold', null, { shortcut: `${M}+B`, checked: !!st.bold }),
      i('Italic', 'italic', 'italic', null, { shortcut: `${M}+I`, checked: !!st.italic }),
      i('Underline', 'underline', 'underline', null, { shortcut: `${M}+U`, checked: !!st.underline }),
      i('Strikethrough', 'strike', 'strike', null, { shortcut: `${M}+5`, checked: !!st.strike }),
      sep,
      i('Larger font', 'fontSize', 'fontStep', 1, { shortcut: `${M}+Shift+>` }),
      i('Smaller font', 'fontSize', 'fontStep', -1, { shortcut: `${M}+Shift+<` }),
      i('Custom font size…', 'fontSize', 'fontSize'),
    ]),
    sub('Alignment', 'alignLeft', [
      i('Left', 'alignLeft', 'align', 'left', { checked: st.align === 'left', radio: true }),
      i('Center', 'alignCenter', 'align', 'center', { checked: st.align === 'center', radio: true }),
      i('Right', 'alignRight', 'align', 'right', { checked: st.align === 'right', radio: true }),
      sep,
      // A cell with no `valign` is ticked Middle, as the toolbar's vertical-align menu ticks it: a radio
      // group with nothing chosen leaves a screen reader saying none of the three is in force.
      i('Top', 'arrowUp', 'valign', 'top', { checked: valign === 'top', radio: true }),
      i('Middle', 'borderTop', 'valign', 'middle', { checked: valign === 'middle', radio: true }),
      i('Bottom', 'arrowDown', 'valign', 'bottom', { checked: valign === 'bottom', radio: true }),
      sep,
      i('Increase indent', 'indentMore', 'indent', 1),
      i('Decrease indent', 'indentLess', 'indent', -1),
    ]),
    sub('Wrapping', 'wrap', [
      i('Overflow', 'chevR', 'wrapMode', 'overflow', { checked: !st.wrap && !st.clip, radio: true }),
      i('Wrap', 'wrap', 'wrapMode', 'wrap', { checked: !!st.wrap, radio: true }),
      i('Clip', 'x', 'wrapMode', 'clip', { checked: !st.wrap && !!st.clip, radio: true }),
    ]),
    sub('Rotation', 'text', [
      i('None', 'text', 'rotate', 0, { checked: !st.rot, radio: true }),
      i('Tilt up (45°)', 'text', 'rotate', 45, { checked: st.rot === 45, radio: true }),
      i('Tilt down (−45°)', 'text', 'rotate', -45, { checked: st.rot === -45, radio: true }),
      i('Rotate up (90°)', 'text', 'rotate', 90, { checked: st.rot === 90, radio: true }),
      i('Rotate down (−90°)', 'text', 'rotate', -90, { checked: st.rot === -90, radio: true }),
      sep,
      // Any angle from −90 to 90, asked for in a dialog; the command clamps and rounds it.
      i('Custom angle…', 'text', 'rotate', 'custom'),
    ]),
    sub('Borders', 'borders', [
      i('All borders', 'borders', 'borders', 'all'),
      i('Outer borders', 'borderOuter', 'borders', 'outer', { shortcut: `${K}+Shift+&` }),
      i('Inner borders', 'borders', 'borders', 'inner'),
      sep,
      i('No borders', 'borderNone', 'borders', 'none', { shortcut: `${K}+Shift+_` }),
    ]),
    sep,
    sub('Merge cells', 'merge', [
      f.merged ? i('Unmerge cells', 'unmerge', 'merge') : i('Merge and center', 'merge', 'merge', null, { disabled: !!f.singleCell }),
      i('Merge horizontally', 'rows', 'mergeAcross', null, { disabled: !!f.singleCell || !!f.oneCol }),
      i('Merge vertically', 'cols', 'mergeDown', null, { disabled: !!f.singleCell || !!f.oneRow }),
    ].map(waits)),
    sub('Rows and columns', 'cols', [
      i('Fit columns to content', 'cols', 'autofit'),
      i('Fit rows to content', 'rows', 'fitRows'),
      sep,
      i('Resize columns…', 'cols', 'resizeCols'),
      i('Resize rows…', 'rows', 'resizeRows'),
    ]),
    sep,
    i('Conditional formatting…', 'highlighter', 'condFormat'),
    i('Alternating colors', 'rows', 'bands'),
    sub('Cell styles', 'paint', [
      ...CELL_STYLES.map((s) => i(s.label, null, 'cellStyle', s.key, {
        // A sample of the style as it would look on the sheet: on paper, whatever the app's theme. A preset
        // that names no ink or fill of its own shows the paper's, as the cell it makes will; the menu's own
        // dark tokens made a Note sample near-white ink on its pale yellow fill, and a Heading navy on black.
        paper: true,
        style: { color: s.patch.color || 'var(--ink)', background: s.patch.bg || 'var(--surface)', fontWeight: s.patch.bold ? '700' : '400', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--hairline)' },
      })),
      // The workbook's own styles, then the tools that make, change and bring in styles.
      (f.customCellStyles || []).length && sep,
      (f.customCellStyles || []).length && { header: 'Custom' },
      ...(f.customCellStyles || []).map((name) => i(name, null, 'cellStyle', { custom: name })),
      sep,
      waits(i('New cell style…', 'plus', 'newCellStyle')),
      sub('Modify a style', 'pencil', [
        ...CELL_STYLES.map((s) => i(s.label, null, 'modifyCellStyle', s.key)),
        ...(f.customCellStyles || []).map((name) => i(name, null, 'modifyCellStyle', { custom: name })),
      ].map(waits)),
      (f.customCellStyles || []).length > 1 && sub('Delete a style', 'trash', (f.customCellStyles || []).map((name) => i(name, null, 'deleteCellStyle', { custom: name })).map(waits)),
      (f.customCellStyles || []).length === 1 && waits(i(`Delete style “${f.customCellStyles[0]}”`, 'trash', 'deleteCellStyle', { custom: f.customCellStyles[0] })),
      waits(i('Merge styles…', 'paint', 'mergeCellStyles')),
    ]),
    i('Paint format', 'paint', 'paintFormat'),
    sep,
    i('Format Cells…', 'formatCells', 'formatCells', null, { shortcut: `${M}+1` }),
    i('Clear formatting', 'eraser', 'clearFormat', null),
  ];

  const data = [
    sub('Sort', 'sortAsc', [
      i('Sort range A to Z', 'sortAsc', 'sort', 'asc'),
      i('Sort range Z to A', 'sortDesc', 'sort', 'desc'),
      i('Sort range…', 'sliders', 'sortDialog'),
      sep,
      i('Randomize range', 'sortAsc', 'shuffle'),
    ]),
    // A checked item keeps one name, as Home ▸ Sort & Filter ▸ Filter does: "Remove filter, checked" read as both an action and a state.
    i('Filter', 'filter', 'filter', null, { shortcut: `${M}+Shift+L`, checked: !!f.filter }),
    sep,
    f.hasTable ? i('Edit table…', 'table', 'editTable') : i('Create table…', 'table', 'insertTable'),
    f.hasTable && i('Total row', 'sigma', 'tableTotals', null, { checked: !!f.table?.totalsRow, disabled: editing || !!f.away || !!f.sheet?.protected }),
    f.hasTable && sub('Table tools', 'table', [
      i('Summarize with PivotTable', 'pivot', 'tableSource', 'pivot'),
      i('Remove Duplicates', 'dedupe', 'tableSource', 'dedupe'),
      i('Resize Table…', 'resizeTable', 'tableResize'),
      i('Insert Slicer…', 'slicer', 'insertSlicer'),
    ].map(item => ({ ...item, disabled: editing || !!f.away || !!f.sheet?.protected }))),
    f.hasTable && sub('Table options', 'table', [
      i('Header Row', 'table', 'tableOption', 'headerRow', { checked: f.table?.headerRow !== false }),
      ...[['banded', 'Banded Rows'], ['bandedColumns', 'Banded Columns'], ['firstColumn', 'First Column'], ['lastColumn', 'Last Column']].map(([key, label]) =>
        i(label, 'table', 'tableOption', key, { checked: key === 'banded' ? f.table?.banded !== false : !!f.table?.[key] })),
      i('Filter Button', 'table', 'tableOption', 'filterButton', { checked: !!f.tableFilterButton, disabled: f.table?.headerRow === false }),
      sub('Table Styles', 'paint', TABLE_STYLES.map(([key, label]) =>
        i(label, 'table', 'tableStyle', key, { checked: !f.table?.customStyle && f.table?.style === key, radio: true }))),
      i('Convert to Range', 'table', 'tableConvert'),
    ].map(item => ({ ...item, disabled: !!item.disabled || editing || !!f.away || !!f.sheet?.protected,
      ...(item.submenu && { submenu: item.submenu.map(child => ({ ...child, disabled: editing || !!f.away || !!f.sheet?.protected })) }) }))),
    i('Pivot table…', 'pivot', 'pivot'),
    i('Subtotals…', 'sigma', 'subtotal'),
    sub('Outline', 'group', [
      i('Auto Outline', 'group', 'autoOutline'),
      i('Clear Outline', 'eraser', 'clearOutline'),
      sep,
      i('Outline settings…', 'sliders', 'outlineSettings'),
    ].map(waits)),
    i('Column stats…', 'chartColumn', 'columnStats'),
    i('Goal seek…', 'sliders', 'goalSeek'),
    i('Data table…', 'table', 'dataTable'),
    i('Scenario Manager…', 'scenarioManager', 'scenarioManager'),
    i('Forecast sheet…', 'forecast', 'forecastSheet'),
    i('Solver…', 'solver', 'solver'),
    i('Data analysis…', 'dataAnalysis', 'dataAnalysis'),
    i('Advanced filter…', 'filterAdvanced', 'advancedFilter'),
    i('Form…', 'dataForm', 'dataForm'),
    f.ai && i('Ask AI about this data…', 'sparkle', 'aiAsk'),
    sep,
    i('Data validation…', 'validation', 'validation'),
    i('Text to Columns…', 'cols', 'splitTextDialog'),
    i('Named ranges…', 'tag', 'names'),
    i('Define name…', 'tag', 'defineName'),
    i('Create names from selection…', 'tag', 'createNames'),
    i('Protected ranges…', 'lock', 'protectRanges'),
    i('Edit links…', 'editLinks', 'editLinks'),
    sep,
    sub('Data cleanup', 'dedupe', [
      i('Remove duplicate rows…', 'dedupe', 'dedupe'),
      i('Remove empty rows', 'rows', 'removeEmptyRows'),
      sep,
      i('Trim whitespace', 'text', 'textCase', 'trim'),
      i('Convert text to numbers', 'number', 'textCase', 'number'),
      i('Split text to columns', 'cols', 'splitText'),
      sep,
      { header: 'Change case' },
      i('UPPERCASE', 'text', 'textCase', 'upper'),
      i('lowercase', 'text', 'textCase', 'lower'),
      i('Capitalize Each Word', 'text', 'textCase', 'proper'),
    ]),
  ];

  const tools = [
    i('Evaluate formula step by step…', 'fx', 'evaluateFormula', null, { disabled: !f.hasFormula }),
    i('Show precedents', 'fx', 'trace', 'precedents', { shortcut: `${M}+[`, disabled: !f.hasFormula }),
    i('Show dependents', 'fx', 'trace', 'dependents', { shortcut: `${M}+]` }),
    i('Remove trace highlights', 'eraser', 'clearTrace'),
    i('Replace formulas with values', 'number', 'toValues'),
    f.ai && sep,
    f.ai && i('AI assistant', 'sparkle', 'aiPanel', null, { shortcut: `${M}+J`, checked: !!f.aiPanel }),
    f.ai && i('Write a formula with AI…', 'sparkle', 'aiFormula'),
    f.ai && i('Explain this formula (AI)…', 'sparkle', 'aiExplain', null, { disabled: !f.hasFormula }),
    sep,
    i('Spelling…', 'spell', 'spelling', null, { shortcut: 'F7' }),
    i('Thesaurus', 'thesaurus', 'thesaurus', null, { shortcut: 'Shift+F7', checked: f.languagePane === 'thesaurus' }),
    i('Translate', 'translate', 'translatePane', null, { checked: f.languagePane === 'translate' }),
    sub('Automate', 'codeEditor', [
      i('Code Editor', 'codeEditor', 'scriptsPane', null, { checked: !!f.scriptsPane }),
      i('New script', 'newScript', 'newScript'),
      i('Run script', 'runScript', 'runScript', null, { disabled: !!f.scriptRunning }),
      i(f.recording ? 'Stop recording' : 'Record actions', 'recordActions', 'recordActions', null, { checked: !!f.recording }),
      i('All scripts…', 'allScripts', 'scriptGallery'),
      i('Script reference', 'scriptReference', 'scriptReference'),
    ]),
    i('Check spelling as you type', 'text', 'toggleSpellcheck', null, { checked: f.spell !== false }),
    i('AutoCorrect Options…', 'autoCorrect', 'autoCorrectOptions'),
    fn('Regional format…', 'monitor', f.fns?.locale),
    sep,
    i('Customize the Ribbon…', 'customizeRibbon', 'options', 'ribbon'),
    i('Customize Quick Access Toolbar…', 'customizeQuickAccess', 'options', 'quickAccess'),
    i('Customize Keyboard…', 'customizeKeyboard', 'options', 'keyboard'),
    i('Options…', 'options', 'options', null, { shortcut: `${M}+,` }),
  ];

  const help = [
    i('Search the menus…', 'search', 'palette', null, { shortcut: `${M}+Shift+P` }),
    fn('Keyboard shortcuts…', 'keyboard', f.fns?.shortcuts),
    f.fns?.about && sep,
    fn('About Spreadsheet…', 'info', f.fns?.about),
  ];

  const lists = { file, edit, view, insert, format, data, tools, help };
  const capabilities = items => items.map(item => item && (item.submenu
    ? { ...item, submenu: capabilities(item.submenu) }
    : f.chartSheet && item.cmd && !chartSheetCommand(item.cmd) ? { ...item, disabled: true }
      // Grouped sheets: a command for one sheet's objects waits, and says why.
      : f.grouped && item.cmd && GROUP_BLOCKED_COMMANDS.has(item.cmd) ? { ...item, disabled: true, hint: GROUP_BLOCKED_HINT } : item));
  return MENU_TITLES.map(([id, label]) => ({ id, label, items: withCustomShortcuts(tidy(capabilities(lists[id]))) }));
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
  const root = el('nav.menubar', { role: 'menubar', 'aria-label': 'Menus' });
  const buttons = [];
  let openId = null;

  for (const [id, label] of MENU_TITLES) {
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
    }, label);
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
