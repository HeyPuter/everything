/** Right-click and long-press menus for cells, row headers, and column headers. */

import { openMenu } from './menu.js';
import { MOD_KEY } from './dom.js';
import { colName } from '../core/cell.js';
import { pasteGalleryItems } from './pastespecialdialog.js';

/** The Paste Special flyout: the Paste gallery, then Paste Special…. */
const pasteSpecialItems = (ctx) => pasteGalleryItems().map((item) => (item.header || item.separator ? item
  : { label: item.label, icon: item.icon, shortcut: item.cmd === 'pasteSpecialMenu' ? `${MOD_KEY}+Alt+V` : undefined, onSelect: () => ctx.run(item.cmd, item.arg) }));

function linkItems(ctx) {
  const link = ctx.wb.linkAt(ctx.sheetId(), ctx.active().r, ctx.active().c);
  if (!link) return [{ label: 'Link…', icon: 'link', shortcut: `${MOD_KEY}+K`, onSelect: () => ctx.run('link') }];
  return [
    { label: 'Open link', icon: 'external', onSelect: () => ctx.run('openLink') },
    { label: 'Edit link…', icon: 'link', shortcut: `${MOD_KEY}+K`, onSelect: () => ctx.run('link') },
    { label: 'Remove link', icon: 'unlink', onSelect: () => ctx.run('unlink') },
  ];
}

/**
 * In Page Break Preview the menus offer the page breaks at the selection and the print area, as the
 * Page Layout tab does; elsewhere they are left out.
 */
function pageBreakItems(ctx, kind) {
  const sheet = ctx.wb.sheet(ctx.sheetId());
  if (sheet?.viewMode !== 'pageBreak') return [];
  const p = sheet.printSettings || {}, at = ctx.active();
  const there = kind === 'row' ? p.rowBreaks?.includes(at.r) : kind === 'col' ? p.colBreaks?.includes(at.c) : p.rowBreaks?.includes(at.r) || p.colBreaks?.includes(at.c);
  return [
    { separator: true },
    { label: 'Insert Page Break', icon: 'breaks', onSelect: () => ctx.run('pageBreak', 'insert') },
    there && { label: 'Remove Page Break', onSelect: () => ctx.run('pageBreak', 'remove') },
    (p.rowBreaks?.length || p.colBreaks?.length) && { label: 'Reset All Page Breaks', onSelect: () => ctx.run('pageBreak', 'reset') },
    kind === 'cell' && { label: 'Set Print Area', icon: 'printArea', onSelect: () => ctx.run('printArea', 'set') },
    kind === 'cell' && p.areas?.length && { label: 'Reset Print Area', onSelect: () => ctx.run('printArea', 'clear') },
  ];
}

/** Group, Regroup and Ungroup for the objects selected, each offered when it can act. */
function groupItems(ctx) {
  const sheet = ctx.wb.sheet(ctx.sheetId()), ids = ctx.grid?.selectedCharts || [];
  const objects = ids.map((id) => sheet?.charts.find((o) => o.id === id)).filter(Boolean);
  const units = new Set(objects.map((o) => o.group || o.id)).size;
  return [
    { label: 'Group', icon: 'groupObjects', disabled: units < 2, onSelect: () => ctx.run('groupObjects', 'group') },
    { label: 'Regroup', icon: 'groupObjects', disabled: !ctx.wb.canRegroup?.(ctx.sheetId()), onSelect: () => ctx.run('groupObjects', 'regroup') },
    { label: 'Ungroup', icon: 'ungroup', disabled: !objects.some((o) => o.group), onSelect: () => ctx.run('groupObjects', 'ungroup') },
  ];
}

export function openCellContextMenu(ctx, { x, y, kind, chartId }) {
  if (kind === 'chart' && ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'smartart') {
    // A SmartArt graphic: its text, its layout, and the actions every drawing object has.
    const smartArt = (action, extra = {}) => () => ctx.run('smartArt', { action, id: chartId, ...extra });
    openMenu({
      x, y, label: 'SmartArt actions', restoreFocus: false, onClose: () => ctx.grid.focus(),
      items: [
        { label: 'Show Text Pane', icon: 'textPane', shortcut: 'Enter', onSelect: () => ctx.run('editChart', chartId) },
        { label: 'Change Layout…', icon: 'smartArt', onSelect: smartArt('layoutDialog') },
        { label: 'Add Shape', icon: 'addShape', submenu: [
          { label: 'Add Shape After', onSelect: smartArt('add', { where: 'after' }) }, { label: 'Add Shape Before', onSelect: smartArt('add', { where: 'before' }) },
          { label: 'Add Shape Above', onSelect: smartArt('add', { where: 'above' }) }, { label: 'Add Shape Below', onSelect: smartArt('add', { where: 'below' }) }] },
        { label: 'Reset Graphic', icon: 'resetStyle', onSelect: smartArt('reset') },
        { label: 'Convert to Shapes', icon: 'convertShapes', onSelect: smartArt('convert') },
        { separator: true },
        { label: 'Duplicate', icon: 'duplicate', onSelect: () => ctx.run('duplicateChart', { id: chartId }) },
        { label: 'Copy as picture', icon: 'copy', onSelect: () => ctx.run('copyChart', { id: chartId }) },
        { label: 'Download as PNG', icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'png' }) },
        { label: 'Download as SVG', icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'svg' }) },
        { separator: true },
        { label: 'Bring to Front', icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'front' }) },
        { label: 'Send to Back', icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'back' }) },
        { label: 'Group', icon: 'groupObjects', submenu: groupItems(ctx) },
        { label: 'Selection Pane…', icon: 'selectionPane', onSelect: () => ctx.run('selectionPane') },
        { label: 'Edit Alt Text…', icon: 'altText', onSelect: () => ctx.run('altText', chartId) },
        { separator: true },
        { label: 'Delete SmartArt', icon: 'trash', shortcut: 'Delete', danger: true, onSelect: () => ctx.run('deleteChart', chartId) },
      ],
    });
    return;
  }
  if (kind === 'chart') {
    const slicer = ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'slicer';
    const image = ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'image';
    const linked = image && !!ctx.wb.chartById(ctx.sheetId(), chartId)?.pictureRef;
    const scroll = ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'scroll';
    const textBox = ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'text';
    openMenu({
      x, y, label: slicer ? 'Slicer actions' : scroll ? 'Scroll bar actions' : image ? 'Image actions' : textBox ? 'Text box actions' : 'Chart actions', restoreFocus: false, onClose: () => ctx.grid.focus(),
      items: [
        !image && { label: slicer ? 'Edit slicer…' : scroll ? 'Edit scroll bar…' : textBox ? 'Edit text…' : 'Edit chart…', icon: textBox ? 'text' : 'chartColumn', shortcut: 'Enter', onSelect: () => ctx.run('editChart', chartId) },
        image && !linked && { label: 'Replace image…', icon: 'image', onSelect: () => ctx.run('replaceImage', chartId) },
        image && linked && { label: 'Go to Linked Cells', icon: 'linkedPicture', onSelect: () => ctx.run('replaceImage', chartId) },
        image && { label: 'Place in Cell', icon: 'placeInCell', onSelect: () => ctx.run('placeObjectInCell', chartId) },
        image && { label: 'Format Picture', icon: 'pictureStyles', submenu: [
          { label: 'Crop…', icon: 'crop', disabled: linked, onSelect: () => ctx.run('pictureFormat', { action: 'crop' }) },
          { label: 'Picture Corrections…', icon: 'corrections', onSelect: () => ctx.run('pictureFormat', { action: 'correctionsDialog' }) },
          { label: 'Reset Picture', icon: 'resetPicture', onSelect: () => ctx.run('pictureFormat', { action: 'reset' }) },
        ] },
        { separator: true },
        { label: 'Duplicate', icon: 'duplicate', onSelect: () => ctx.run('duplicateChart', { id: chartId }) },
        { label: slicer ? 'Copy slicer' : scroll ? 'Copy scroll bar' : image ? 'Copy image' : textBox ? 'Copy text' : 'Copy as picture', icon: 'copy', onSelect: () => ctx.run('copyChart', { id: chartId }) },
        !image && !textBox && !scroll && !slicer && { label: 'Download as PNG', icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'png' }) },
        !image && !textBox && !scroll && !slicer && { label: 'Download as SVG', icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'svg' }) },
        image && { label: 'Download image', icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId }) },
        { separator: true },
        { label: 'Bring to Front', icon: 'bringForward', submenu: [
          { label: 'Bring to Front', icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'front' }) },
          { label: 'Bring Forward', icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'forward' }) }] },
        { label: 'Send to Back', icon: 'sendBackward', submenu: [
          { label: 'Send to Back', icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'back' }) },
          { label: 'Send Backward', icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'backward' }) }] },
        { label: 'Group', icon: 'groupObjects', submenu: groupItems(ctx) },
        (image || textBox) && { label: 'Rotate', icon: 'rotateObjects', submenu: [
          { label: 'Rotate Right 90°', icon: 'rotateObjects', onSelect: () => ctx.run('rotateObjects', 'right') },
          { label: 'Rotate Left 90°', icon: 'rotateLeft', onSelect: () => ctx.run('rotateObjects', 'left') },
          { label: 'Flip Vertical', icon: 'flipV', onSelect: () => ctx.run('rotateObjects', 'flipV') },
          { label: 'Flip Horizontal', icon: 'flipH', onSelect: () => ctx.run('rotateObjects', 'flipH') }] },
        { label: 'Selection Pane…', icon: 'selectionPane', onSelect: () => ctx.run('selectionPane') },
        !scroll && !slicer && { label: 'Edit Alt Text…', icon: 'altText', onSelect: () => ctx.run('altText', chartId) },
        { separator: true },
        { label: scroll ? 'Delete scroll bar' : image ? 'Delete image' : textBox ? 'Delete text box' : 'Delete chart', icon: 'trash', shortcut: 'Delete', danger: true, onSelect: () => ctx.run('deleteChart', chartId) },
      ],
    });
    return;
  }
  const editItems = [
    { label: 'Cut', icon: 'cut', shortcut: `${MOD_KEY}+X`, onSelect: () => ctx.run('cut') },
    { label: 'Copy', icon: 'copy', shortcut: `${MOD_KEY}+C`, onSelect: () => ctx.run('copy') },
    { label: 'Paste', icon: 'paste', shortcut: `${MOD_KEY}+V`, onSelect: () => ctx.run('paste') },
    { label: 'Paste values only', icon: 'paste', shortcut: `${MOD_KEY}+Shift+V`, onSelect: () => ctx.run('pasteValues') },
    { label: 'Paste special…', icon: 'paste', onSelect: () => ctx.run('pasteSpecialMenu', { x, y }) },
    ctx.doc?.path && { label: (() => { const rg = ctx.range(); return rg.r1 === rg.r2 && rg.c1 === rg.c2 ? 'Copy link to this cell' : 'Copy link to this range'; })(), icon: 'link', onSelect: () => ctx.run('copyLink') },
    { separator: true },
  ];
  const sheet = ctx.wb.sheet(ctx.sheetId());
  let items;
  // The header menus: the clipboard, Insert, Delete, Clear Contents, Format Cells…, Row Height… or Column Width…,
  // Hide and Unhide; the app's further line tools follow below them.
  const pasteSpecial = { label: 'Paste Special', icon: 'paste', submenu: pasteSpecialItems(ctx) };
  const clipboard = [...editItems.filter((item) => item && !item.label?.startsWith?.('Paste values') && !item.label?.startsWith?.('Paste special'))];
  clipboard.splice(clipboard.findIndex((item) => item.label === 'Paste') + 1, 0, pasteSpecial);
  if (kind === 'row') {
    const { r1, r2 } = ctx.range();
    const hiddenRows = ctx.wb.hiddenWithin(ctx.sheetId(), 'row', r1, r2);
    const nr = r2 - r1 + 1;
    items = [...clipboard,
      { label: 'Insert', icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'above') },
      { label: 'Delete', icon: 'deleteRows', onSelect: () => ctx.run('deleteRows') },
      { label: 'Clear Contents', icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      { separator: true },
      { label: 'Format Cells…', icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      { label: 'Row Height…', icon: 'rowHeight', onSelect: () => ctx.run('resizeRows') },
      { label: 'Hide', icon: 'hideEye', onSelect: () => ctx.run('hide', 'row') },
      { label: 'Unhide', icon: 'showHide', disabled: !hiddenRows.length, onSelect: () => ctx.run('unhide', 'row') },
      { separator: true },
      { label: nr === 1 ? 'Insert row below' : `Insert ${nr} rows below`, icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'below') },
      { label: nr === 1 ? 'AutoFit Row Height' : 'AutoFit Row Heights', icon: 'rowHeight', onSelect: () => ctx.run('fitRows') },
      { label: nr === 1 ? 'Group row' : `Group rows ${r1 + 1}–${r2 + 1}`, icon: 'group', onSelect: () => ctx.run('group', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => g.to >= r1 && g.from <= r2) && { label: 'Ungroup rows', icon: 'ungroup', onSelect: () => ctx.run('ungroup', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => !g.collapsed) && { label: 'Collapse all row groups', icon: 'chevU', onSelect: () => ctx.run('collapseAll', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => g.collapsed) && { label: 'Expand all row groups', icon: 'chevD', onSelect: () => ctx.run('expandAll', 'row') },
      sheet.frozenRows === r2 + 1
        ? { label: 'Unfreeze rows', icon: 'freeze', onSelect: () => ctx.run('freeze', 'rows-none') }
        : { label: `Freeze rows up to ${r2 + 1}`, icon: 'freeze', onSelect: () => ctx.run('freeze', 'rows') },
      ...pageBreakItems(ctx, 'row')];
  } else if (kind === 'col') {
    const { c1, c2 } = ctx.range();
    const hiddenCols = ctx.wb.hiddenWithin(ctx.sheetId(), 'col', c1, c2);
    const nc = c2 - c1 + 1;
    items = [...clipboard,
      { label: 'Insert', icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'left') },
      { label: 'Delete', icon: 'deleteCols', onSelect: () => ctx.run('deleteCols') },
      { label: 'Clear Contents', icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      { separator: true },
      { label: 'Format Cells…', icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      { label: 'Column Width…', icon: 'colWidth', onSelect: () => ctx.run('resizeCols') },
      { label: 'Hide', icon: 'hideEye', onSelect: () => ctx.run('hide', 'col') },
      { label: 'Unhide', icon: 'showHide', disabled: !hiddenCols.length, onSelect: () => ctx.run('unhide', 'col') },
      { separator: true },
      { label: nc === 1 ? 'Insert column right' : `Insert ${nc} columns right`, icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'right') },
      { label: 'AutoFit Column Width', icon: 'colWidth', onSelect: () => ctx.run('autofit') },
      { label: 'Sort A to Z', icon: 'sortAsc', onSelect: () => ctx.run('sort', 'asc') },
      { label: 'Sort Z to A', icon: 'sortDesc', onSelect: () => ctx.run('sort', 'desc') },
      { label: ctx.wb.filterAt(ctx.sheetId(), ctx.active().r, ctx.active().c) ? 'Remove filter' : 'Create filter', icon: 'filter', onSelect: () => ctx.run('filter') },
      { label: 'Column stats…', icon: 'columnStats', onSelect: () => ctx.run('columnStats') },
      { label: nc === 1 ? 'Group column' : `Group columns ${colName(c1)}–${colName(c2)}`, icon: 'group', onSelect: () => ctx.run('group', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => g.to >= c1 && g.from <= c2) && { label: 'Ungroup columns', icon: 'ungroup', onSelect: () => ctx.run('ungroup', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => !g.collapsed) && { label: 'Collapse all column groups', icon: 'chevL', onSelect: () => ctx.run('collapseAll', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => g.collapsed) && { label: 'Expand all column groups', icon: 'chevR', onSelect: () => ctx.run('expandAll', 'col') },
      sheet.frozenCols === c2 + 1
        ? { label: 'Unfreeze columns', icon: 'freeze', onSelect: () => ctx.run('freeze', 'cols-none') }
        : { label: `Freeze columns up to ${colName(c2)}`, icon: 'freeze', onSelect: () => ctx.run('freeze', 'cols') },
      ...pageBreakItems(ctx, 'col')];
  } else {
    const range = ctx.range();
    const nr = range.r2 - range.r1 + 1;
    const nc = range.c2 - range.c1 + 1;
    const active = ctx.active();
    const cell = ctx.wb.getCell(ctx.sheetId(), active.r, active.c);
    const hasFormula = cell?.f != null;
    const table = ctx.wb.tableAt(ctx.sheetId(), active.r, active.c);
    const note = ctx.wb.getNote(ctx.sheetId(), active.r, active.c);
    // The merge command unmerges when any selected range (Ctrl/Cmd+click adds them) holds a merge, and merges nothing
    // when only single cells are selected: the editor's flags say which, as they do for the menu bar and the palette.
    const flags = ctx.flags?.() || null;
    const merged = flags ? !!flags.merged : (ctx.ranges?.() ?? [range]).some((rg) => ctx.wb.mergesIn(ctx.sheetId(), rg).length > 0);
    const singleCell = flags ? !!flags.singleCell : nr === 1 && nc === 1;
    const filtered = !!ctx.wb.filterAt(ctx.sheetId(), active.r, active.c);
    // The cell menu: clipboard, Insert… and Delete… by how the cells move, Clear Contents, Filter and Sort,
    // notes, Format Cells…, the pick list, Define Name and links. The app's further tools follow in submenus.
    items = [
      ...editItems.filter((item) => item && !item.label?.startsWith?.('Paste values') && !item.label?.startsWith?.('Paste special')),
    ];
    items.splice(items.findIndex((item) => item.label === 'Paste') + 1, 0, { label: 'Paste Special', icon: 'paste', submenu: pasteSpecialItems(ctx) });
    items.push(
      // After a copy the menu offers the copied cells to insert, the cells here moving aside (the Insert Paste dialog).
      flags?.copiedCells && { label: 'Insert Copied Cells…', icon: 'paste', onSelect: () => ctx.run('insertCopiedCells') },
      { label: 'Insert…', icon: 'insertCells', submenu: [
        { label: 'Shift cells right', icon: 'insertCells', onSelect: () => ctx.run('insertCells', 'right') },
        { label: 'Shift cells down', icon: 'insertCells', onSelect: () => ctx.run('insertCells', 'down') },
        { label: nr === 1 ? 'Entire row' : `Entire rows (${nr})`, icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'above') },
        { label: nc === 1 ? 'Entire column' : `Entire columns (${nc})`, icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'left') },
        { separator: true },
        { label: nr === 1 ? 'Row below' : `${nr} rows below`, icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'below') },
        { label: nc === 1 ? 'Column right' : `${nc} columns right`, icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'right') },
        { separator: true },
        { label: nr * nc === 1 ? 'Checkbox' : 'Checkboxes', icon: 'checkbox', onSelect: () => ctx.run('insertCheckbox') },
        { label: 'Dropdown…', icon: 'dropdown', onSelect: () => ctx.run('insertDropdown') },
        { label: 'Date picker…', icon: 'calendar', onSelect: () => ctx.run('datePicker') },
        { label: 'Chart…', icon: 'chartColumn', onSelect: () => ctx.run('insertChart') },
        { label: 'Image…', icon: 'image', onSelect: () => ctx.run('insertImage') },
        flags?.pick && { label: 'Image from Puter…', icon: 'folderOpen', onSelect: () => ctx.run('insertImagePuter') },
        { label: 'Image from URL…', icon: 'external', onSelect: () => ctx.run('insertImageUrl') },
        { label: 'Text box…', icon: 'textBox', onSelect: () => ctx.run('insertTextBox') },
        { label: 'Fill series…', icon: 'series', onSelect: () => ctx.run('fillSeries') },
      ] },
      { label: 'Delete…', icon: 'deleteCells', submenu: [
        { label: 'Shift cells left', icon: 'deleteCells', onSelect: () => ctx.run('deleteCells', 'left') },
        { label: 'Shift cells up', icon: 'deleteCells', onSelect: () => ctx.run('deleteCells', 'up') },
        { label: nr === 1 ? 'Entire row' : `Entire rows (${nr})`, icon: 'deleteRows', onSelect: () => ctx.run('deleteRows') },
        { label: nc === 1 ? 'Entire column' : `Entire columns (${nc})`, icon: 'deleteCols', onSelect: () => ctx.run('deleteCols') },
        { separator: true },
        { label: 'Remove duplicate rows…', icon: 'dedupe', onSelect: () => ctx.run('dedupe') },
        { label: 'Remove empty rows', icon: 'rows', onSelect: () => ctx.run('removeEmptyRows') },
      ] },
      { label: 'Clear Contents', icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      ...pageBreakItems(ctx, 'cell'),
      // A picture placed in the cell: lift it out to float over the cells, or describe it.
      ...(flags?.cellPicture ? [{ separator: true },
        { label: 'Place over Cells', icon: 'placeOverCells', onSelect: () => ctx.run('placeOverCells') },
        { label: 'Edit Alt Text…', icon: 'altText', onSelect: () => ctx.run('cellAltText') }] : []),
      { separator: true },
      { label: 'Filter', icon: 'filter', submenu: [
        { label: filtered ? 'Remove Filter' : 'Filter', icon: filtered ? 'filterClear' : 'filter', shortcut: `${MOD_KEY}+Shift+L`, onSelect: () => ctx.run('filter') },
      ] },
      { label: 'Sort', icon: 'sortAsc', submenu: [
        { label: 'Sort A to Z', icon: 'sortAsc', onSelect: () => ctx.run('sort', 'asc') },
        { label: 'Sort Z to A', icon: 'sortDesc', onSelect: () => ctx.run('sort', 'desc') },
        { separator: true },
        { label: 'Custom Sort…', icon: 'sortCustom', onSelect: () => ctx.run('sortDialog') },
        nr > 1 && { label: 'Randomize range', icon: 'sortAsc', onSelect: () => ctx.run('shuffle') },
      ] },
      table ? { label: 'Table', icon: 'formatTable', submenu: [
        { label: `Table ${table.name}…`, icon: 'formatTable', onSelect: () => ctx.run('editTable') },
        { label: table.totalsRow ? 'Remove Totals Row' : 'Totals Row', icon: 'subtotal', onSelect: () => ctx.run('tableTotals') },
        { label: 'Convert to Range', icon: 'convertToRange', onSelect: () => ctx.run('tableConvert') },
      ] } : null,
      { separator: true },
      // Threaded comments first: start one, or reply to and delete the one here.
      // A cell holds a thread or a note, not both.
      ...(ctx.wb.sheet(ctx.sheetId())?.comments?.has(`${active.r},${active.c}`)
        ? [{ label: 'Reply to Comment', icon: 'comment', onSelect: () => ctx.run('replyComment') }, { label: 'Delete Comment', icon: 'deleteComment', onSelect: () => ctx.run('deleteComment') }]
        : [!note && { label: 'New Comment', icon: 'comment', shortcut: `${MOD_KEY}+Shift+F2`, onSelect: () => ctx.run('newComment') },
          note ? { label: 'Edit Note', icon: 'note', shortcut: 'Shift+F2', onSelect: () => ctx.run('note') } : { label: 'New Note', icon: 'note', shortcut: 'Shift+F2', onSelect: () => ctx.run('note') },
          note && { label: 'Delete Note', icon: 'deleteNote', onSelect: () => ctx.run('deleteNote') }]),
      { label: 'Show Changes', icon: 'showChanges', onSelect: () => ctx.run('showChanges', 'selection') },
      { separator: true },
      { label: 'Format Cells…', icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      nr * nc === 1 && { label: 'Pick From Drop-down List…', icon: 'dropdown', shortcut: 'Alt+↓', onSelect: () => ctx.run('pickFromList') },
      { label: 'Define Name…', icon: 'defineName', onSelect: () => ctx.run('defineName') },
      ...linkItems(ctx),
      { separator: true },
      { label: 'Format', icon: 'paint', submenu: [
        { label: 'Conditional formatting…', icon: 'condFormat', onSelect: () => ctx.run('condFormat') },
        { label: 'Alternating colors', icon: 'formatTable', onSelect: () => ctx.run('bands') },
        { label: 'Clear Formats', icon: 'clearFormat', onSelect: () => ctx.run('clearFormat') },
        { label: ctx.wb.protectedRangeAt(ctx.sheetId(), active.r, active.c) ? 'Protected ranges…' : 'Protect range…', icon: 'protectRanges', onSelect: () => ctx.run('protectRanges') },
        { separator: true },
        merged
          ? { label: 'Unmerge cells', icon: 'unmerge', onSelect: () => ctx.run('merge') }
          : { label: 'Merge cells', icon: 'merge', disabled: singleCell, onSelect: () => ctx.run('merge') },
        nr > 1 && nc > 1 && { label: 'Merge horizontally', icon: 'merge', onSelect: () => ctx.run('mergeAcross') },
        nr > 1 && nc > 1 && { label: 'Merge vertically', icon: 'merge', onSelect: () => ctx.run('mergeDown') },
      ] },
      { label: 'Data', icon: 'database', submenu: [
        table ? null : { label: 'Create table…', icon: 'table', onSelect: () => ctx.run('insertTable') },
        { label: 'Subtotals…', icon: 'subtotal', onSelect: () => ctx.run('subtotal') },
        { label: 'Pivot table…', icon: 'pivot', onSelect: () => ctx.run('pivot') },
        { label: 'Column stats…', icon: 'columnStats', onSelect: () => ctx.run('columnStats') },
        { separator: true },
        { label: 'Split text to columns…', icon: 'textToColumns', onSelect: () => ctx.run('splitTextMenu', { x, y }) },
        { label: 'Change text…', icon: 'text', onSelect: () => ctx.run('textMenu', { x, y }) },
        { label: 'Data validation…', icon: 'validation', onSelect: () => ctx.run('validation') },
        { label: 'Select cells…', icon: 'goTo', onSelect: () => ctx.run('selectSpecialMenu', { x, y }) },
        (nr * nc > 1 || table) && { label: nr * nc > 1 ? 'Download selection as .csv' : `Download table ${table.name} as .csv`, icon: 'fileDown', onSelect: () => ctx.run('downloadRangeCsv') },
      ] },
      { label: 'Formula', icon: 'fx', submenu: [
        hasFormula && { label: 'Evaluate formula…', icon: 'evaluate', onSelect: () => ctx.run('evaluateFormula') },
        { label: 'Replace formulas with values', icon: 'toValues', onSelect: () => ctx.run('toValues') },
        hasFormula && { label: 'Show precedents', icon: 'precedents', shortcut: `${MOD_KEY}+[`, onSelect: () => ctx.run('trace', 'precedents') },
        { label: 'Show dependents', icon: 'dependents', shortcut: `${MOD_KEY}+]`, onSelect: () => ctx.run('trace', 'dependents') },
        hasFormula && { label: 'Goal seek…', icon: 'goalSeek', onSelect: () => ctx.run('goalSeek') },
        ctx.canAI?.() && { separator: true },
        ctx.canAI?.() && { label: 'Write a formula with AI…', icon: 'sparkle', onSelect: () => ctx.run('aiFormula') },
        hasFormula && ctx.canAI?.() && { label: 'Explain this formula (AI)…', icon: 'sparkle', onSelect: () => ctx.run('aiExplain') },
        ctx.canAI?.() && { label: nr * nc > 1 ? 'Ask AI about these cells…' : 'Ask AI about this data…', icon: 'sparkle', onSelect: () => ctx.run('aiAsk') },
        ctx.canAI?.() && { label: 'Ask the assistant…', icon: 'sparkle', onSelect: () => ctx.run('aiPanel', true) },
        { separator: true },
        { label: 'Insert function…', icon: 'fx', shortcut: 'Shift+F3', onSelect: () => ctx.run('functionMenu') },
        nr * nc > 1 && { label: 'Create names from selection…', icon: 'createNames', onSelect: () => ctx.run('createNames') },
      ] },
    );
  }
  openMenu({ x, y, items, label: 'Cell actions', restoreFocus: false, onClose: () => ctx.grid.focus() });
}
