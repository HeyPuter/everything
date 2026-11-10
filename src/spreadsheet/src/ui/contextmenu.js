/** Right-click and long-press menus for cells, row headers, and column headers. */

import { openMenu } from './menu.js';
import { MOD_KEY } from './dom.js';
import { colName } from '../core/cell.js';
import { pasteGalleryItems } from './pastespecialdialog.js';
import { elementForNode, paneTitle } from './chart-format-pane.js';
import { t } from '../i18n/index.js';

/** The Paste Special flyout: the Paste gallery, then Paste Special…. */
const pasteSpecialItems = (ctx) => pasteGalleryItems().map((item) => (item.header || item.separator ? item
  : { label: item.label, icon: item.icon, shortcut: item.cmd === 'pasteSpecialMenu' ? `${MOD_KEY}+Alt+V` : undefined, onSelect: () => ctx.run(item.cmd, item.arg) }));

function linkItems(ctx) {
  const link = ctx.wb.linkAt(ctx.sheetId(), ctx.active().r, ctx.active().c);
  if (!link) return [{ label: t('contextmenu.link.insert'), icon: 'link', shortcut: `${MOD_KEY}+K`, onSelect: () => ctx.run('link') }];
  return [
    { label: t('contextmenu.link.open'), icon: 'external', onSelect: () => ctx.run('openLink') },
    { label: t('contextmenu.link.edit'), icon: 'link', shortcut: `${MOD_KEY}+K`, onSelect: () => ctx.run('link') },
    { label: t('contextmenu.link.remove'), icon: 'unlink', onSelect: () => ctx.run('unlink') },
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
    { label: t('contextmenu.pageBreak.insert'), icon: 'breaks', onSelect: () => ctx.run('pageBreak', 'insert') },
    there && { label: t('contextmenu.pageBreak.remove'), onSelect: () => ctx.run('pageBreak', 'remove') },
    (p.rowBreaks?.length || p.colBreaks?.length) && { label: t('contextmenu.pageBreak.resetAll'), onSelect: () => ctx.run('pageBreak', 'reset') },
    kind === 'cell' && { label: t('contextmenu.printArea.set'), icon: 'printArea', onSelect: () => ctx.run('printArea', 'set') },
    kind === 'cell' && p.areas?.length && { label: t('contextmenu.printArea.reset'), onSelect: () => ctx.run('printArea', 'clear') },
  ];
}

/** Group, Regroup and Ungroup for the objects selected, each offered when it can act. */
function groupItems(ctx) {
  const sheet = ctx.wb.sheet(ctx.sheetId()), ids = ctx.grid?.selectedCharts || [];
  const objects = ids.map((id) => sheet?.charts.find((o) => o.id === id)).filter(Boolean);
  const units = new Set(objects.map((o) => o.group || o.id)).size;
  return [
    { label: t('contextmenu.object.group'), icon: 'groupObjects', disabled: units < 2, onSelect: () => ctx.run('groupObjects', 'group') },
    { label: t('contextmenu.object.regroup'), icon: 'groupObjects', disabled: !ctx.wb.canRegroup?.(ctx.sheetId()), onSelect: () => ctx.run('groupObjects', 'regroup') },
    { label: t('contextmenu.object.ungroup'), icon: 'ungroup', disabled: !objects.some((o) => o.group), onSelect: () => ctx.run('groupObjects', 'ungroup') },
  ];
}

export function openCellContextMenu(ctx, { x, y, kind, chartId, target = null }) {
  if (kind === 'chart' && ctx.wb.chartById(ctx.sheetId(), chartId)?.type === 'smartart') {
    // A SmartArt graphic: its text, its layout, and the actions every drawing object has.
    const smartArt = (action, extra = {}) => () => ctx.run('smartArt', { action, id: chartId, ...extra });
    openMenu({
      x, y, label: t('contextmenu.smartArt.menu'), restoreFocus: false, onClose: () => ctx.grid.focus(),
      items: [
        { label: t('contextmenu.smartArt.showTextPane'), icon: 'textPane', shortcut: 'Enter', onSelect: () => ctx.run('editChart', chartId) },
        { label: t('contextmenu.smartArt.changeLayout'), icon: 'smartArt', onSelect: smartArt('layoutDialog') },
        { label: t('contextmenu.smartArt.addShape'), icon: 'addShape', submenu: [
          { label: t('contextmenu.smartArt.addShapeAfter'), onSelect: smartArt('add', { where: 'after' }) }, { label: t('contextmenu.smartArt.addShapeBefore'), onSelect: smartArt('add', { where: 'before' }) },
          { label: t('contextmenu.smartArt.addShapeAbove'), onSelect: smartArt('add', { where: 'above' }) }, { label: t('contextmenu.smartArt.addShapeBelow'), onSelect: smartArt('add', { where: 'below' }) }] },
        { label: t('contextmenu.smartArt.resetGraphic'), icon: 'resetStyle', onSelect: smartArt('reset') },
        { label: t('contextmenu.smartArt.convertToShapes'), icon: 'convertShapes', onSelect: smartArt('convert') },
        { separator: true },
        { label: t('contextmenu.object.duplicate'), icon: 'duplicate', onSelect: () => ctx.run('duplicateChart', { id: chartId }) },
        { label: t('contextmenu.object.copyAsPicture'), icon: 'copy', onSelect: () => ctx.run('copyChart', { id: chartId }) },
        { label: t('contextmenu.object.downloadPng'), icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'png' }) },
        { label: t('contextmenu.object.downloadSvg'), icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'svg' }) },
        { separator: true },
        { label: t('contextmenu.object.bringToFront'), icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'front' }) },
        { label: t('contextmenu.object.sendToBack'), icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'back' }) },
        { label: t('contextmenu.object.group'), icon: 'groupObjects', submenu: groupItems(ctx) },
        { label: t('contextmenu.object.selectionPane'), icon: 'selectionPane', onSelect: () => ctx.run('selectionPane') },
        { label: t('contextmenu.object.editAltText'), icon: 'altText', onSelect: () => ctx.run('altText', chartId) },
        { separator: true },
        { label: t('contextmenu.smartArt.delete'), icon: 'trash', shortcut: 'Delete', danger: true, onSelect: () => ctx.run('deleteChart', chartId) },
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
    // A right-click on an element of a chart (an axis, a series, a trendline...) selects it and offers its Format
    // pane, as a double-click opens it. On a selected series it formats the series; on a selected point, the point.
    const element = !image && !textBox && !scroll && !slicer && target?.closest?.('[data-el]') ? elementForNode(target, ctx.chartUi?.chartId === chartId ? ctx.chartUi.element() : null, { drill: false }) : null;
    // The grid has just selected the chart (see grid.js); the chart UI hears of it after this, so it is told now.
    if (element && ctx.chartUi && ctx.chartUi.chartId !== chartId) ctx.chartUi.chartSelected(chartId);
    if (element && ctx.chartUi?.chartId === chartId && ctx.chartUi.element() !== element) ctx.run('chart', { action: 'selectElement', element });
    const formatElement = element ? () => { ctx.run('chart', { action: 'selectElement', element }); ctx.run('chart', { action: 'formatPane', element }); } : null;
    openMenu({
      x, y, label: slicer ? t('contextmenu.object.menu.slicer') : scroll ? t('contextmenu.object.menu.scrollBar') : image ? t('contextmenu.object.menu.image') : textBox ? t('contextmenu.object.menu.textBox') : t('contextmenu.object.menu.chart'), restoreFocus: false, onClose: () => ctx.grid.focus(),
      items: [
        !image && { label: slicer ? t('contextmenu.object.edit.slicer') : scroll ? t('contextmenu.object.edit.scrollBar') : textBox ? t('contextmenu.object.edit.text') : t('contextmenu.object.edit.chart'), icon: textBox ? 'text' : 'chartColumn', shortcut: 'Enter', onSelect: () => ctx.run('editChart', chartId) },
        formatElement && { label: t('contextmenu.formatElement', { title: paneTitle(element) }), icon: 'chartColumn', onSelect: formatElement },
        image && !linked && { label: t('contextmenu.image.replace'), icon: 'image', onSelect: () => ctx.run('replaceImage', chartId) },
        image && linked && { label: t('contextmenu.image.goToLinkedCells'), icon: 'linkedPicture', onSelect: () => ctx.run('replaceImage', chartId) },
        image && { label: t('contextmenu.image.placeInCell'), icon: 'placeInCell', onSelect: () => ctx.run('placeObjectInCell', chartId) },
        image && { label: t('contextmenu.image.formatPicture'), icon: 'pictureStyles', submenu: [
          { label: t('contextmenu.image.crop'), icon: 'crop', disabled: linked, onSelect: () => ctx.run('pictureFormat', { action: 'crop' }) },
          { label: t('contextmenu.image.corrections'), icon: 'corrections', onSelect: () => ctx.run('pictureFormat', { action: 'correctionsDialog' }) },
          { label: t('contextmenu.image.reset'), icon: 'resetPicture', onSelect: () => ctx.run('pictureFormat', { action: 'reset' }) },
        ] },
        { separator: true },
        { label: t('contextmenu.object.duplicate'), icon: 'duplicate', onSelect: () => ctx.run('duplicateChart', { id: chartId }) },
        { label: slicer ? t('contextmenu.object.copy.slicer') : scroll ? t('contextmenu.object.copy.scrollBar') : image ? t('contextmenu.object.copy.image') : textBox ? t('contextmenu.object.copy.text') : t('contextmenu.object.copyAsPicture'), icon: 'copy', onSelect: () => ctx.run('copyChart', { id: chartId }) },
        !image && !textBox && !scroll && !slicer && { label: t('contextmenu.object.downloadPng'), icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'png' }) },
        !image && !textBox && !scroll && !slicer && { label: t('contextmenu.object.downloadSvg'), icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId, format: 'svg' }) },
        image && { label: t('contextmenu.image.download'), icon: 'download', onSelect: () => ctx.run('downloadChart', { id: chartId }) },
        { separator: true },
        { label: t('contextmenu.object.bringToFront'), icon: 'bringForward', submenu: [
          { label: t('contextmenu.object.bringToFront'), icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'front' }) },
          { label: t('contextmenu.object.bringForward'), icon: 'bringForward', onSelect: () => ctx.run('orderObject', { where: 'forward' }) }] },
        { label: t('contextmenu.object.sendToBack'), icon: 'sendBackward', submenu: [
          { label: t('contextmenu.object.sendToBack'), icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'back' }) },
          { label: t('contextmenu.object.sendBackward'), icon: 'sendBackward', onSelect: () => ctx.run('orderObject', { where: 'backward' }) }] },
        { label: t('contextmenu.object.group'), icon: 'groupObjects', submenu: groupItems(ctx) },
        (image || textBox) && { label: t('contextmenu.object.rotate'), icon: 'rotateObjects', submenu: [
          { label: t('contextmenu.object.rotateRight'), icon: 'rotateObjects', onSelect: () => ctx.run('rotateObjects', 'right') },
          { label: t('contextmenu.object.rotateLeft'), icon: 'rotateLeft', onSelect: () => ctx.run('rotateObjects', 'left') },
          { label: t('contextmenu.object.flipVertical'), icon: 'flipV', onSelect: () => ctx.run('rotateObjects', 'flipV') },
          { label: t('contextmenu.object.flipHorizontal'), icon: 'flipH', onSelect: () => ctx.run('rotateObjects', 'flipH') }] },
        { label: t('contextmenu.object.selectionPane'), icon: 'selectionPane', onSelect: () => ctx.run('selectionPane') },
        !scroll && !slicer && { label: t('contextmenu.object.editAltText'), icon: 'altText', onSelect: () => ctx.run('altText', chartId) },
        { separator: true },
        { label: scroll ? t('contextmenu.object.delete.scrollBar') : image ? t('contextmenu.object.delete.image') : textBox ? t('contextmenu.object.delete.textBox') : t('contextmenu.object.delete.chart'), icon: 'trash', shortcut: 'Delete', danger: true, onSelect: () => ctx.run('deleteChart', chartId) },
      ],
    });
    return;
  }
  const editItems = [
    { label: t('common.cut'), icon: 'cut', shortcut: `${MOD_KEY}+X`, onSelect: () => ctx.run('cut') },
    { label: t('common.copy'), icon: 'copy', shortcut: `${MOD_KEY}+C`, onSelect: () => ctx.run('copy') },
    { id: 'paste', label: t('common.paste'), icon: 'paste', shortcut: `${MOD_KEY}+V`, onSelect: () => ctx.run('paste') },
    { id: 'pasteValues', label: t('contextmenu.pasteValuesOnly'), icon: 'paste', shortcut: `${MOD_KEY}+Shift+V`, onSelect: () => ctx.run('pasteValues') },
    { id: 'pasteSpecialMenu', label: t('contextmenu.pasteSpecialMenu'), icon: 'paste', onSelect: () => ctx.run('pasteSpecialMenu', { x, y }) },
    ctx.doc?.path && { label: (() => { const rg = ctx.range(); return rg.r1 === rg.r2 && rg.c1 === rg.c2 ? t('contextmenu.copyLinkCell') : t('contextmenu.copyLinkRange'); })(), icon: 'link', onSelect: () => ctx.run('copyLink') },
    { separator: true },
  ];
  const sheet = ctx.wb.sheet(ctx.sheetId());
  let items;
  // The header menus: the clipboard, Insert, Delete, Clear Contents, Format Cells…, Row Height… or Column Width…,
  // Hide and Unhide; the app's further line tools follow below them.
  const pasteSpecial = { label: t('contextmenu.pasteSpecial'), icon: 'paste', submenu: pasteSpecialItems(ctx) };
  const clipboard = [...editItems.filter((item) => item && item.id !== 'pasteValues' && item.id !== 'pasteSpecialMenu')];
  clipboard.splice(clipboard.findIndex((item) => item.id === 'paste') + 1, 0, pasteSpecial);
  if (kind === 'row') {
    const { r1, r2 } = ctx.range();
    const hiddenRows = ctx.wb.hiddenWithin(ctx.sheetId(), 'row', r1, r2);
    const nr = r2 - r1 + 1;
    items = [...clipboard,
      { label: t('common.insert'), icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'above') },
      { label: t('common.delete'), icon: 'deleteRows', onSelect: () => ctx.run('deleteRows') },
      { label: t('contextmenu.clearContents'), icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      { separator: true },
      { label: t('contextmenu.formatCells'), icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      { label: t('contextmenu.row.height'), icon: 'rowHeight', onSelect: () => ctx.run('resizeRows') },
      { label: t('common.hide'), icon: 'hideEye', onSelect: () => ctx.run('hide', 'row') },
      { label: t('contextmenu.unhide'), icon: 'showHide', disabled: !hiddenRows.length, onSelect: () => ctx.run('unhide', 'row') },
      { separator: true },
      { label: t('contextmenu.row.insertBelow', { count: nr }), icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'below') },
      { label: t('contextmenu.row.autoFit', { count: nr }), icon: 'rowHeight', onSelect: () => ctx.run('fitRows') },
      { label: t('contextmenu.row.group', { count: nr, from: r1 + 1, to: r2 + 1 }), icon: 'group', onSelect: () => ctx.run('group', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => g.to >= r1 && g.from <= r2) && { label: t('contextmenu.row.ungroup'), icon: 'ungroup', onSelect: () => ctx.run('ungroup', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => !g.collapsed) && { label: t('contextmenu.row.collapseAll'), icon: 'chevU', onSelect: () => ctx.run('collapseAll', 'row') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'row').some((g) => g.collapsed) && { label: t('contextmenu.row.expandAll'), icon: 'chevD', onSelect: () => ctx.run('expandAll', 'row') },
      sheet.frozenRows === r2 + 1
        ? { label: t('contextmenu.row.unfreeze'), icon: 'freeze', onSelect: () => ctx.run('freeze', 'rows-none') }
        : { label: t('contextmenu.row.freezeUpTo', { row: r2 + 1 }), icon: 'freeze', onSelect: () => ctx.run('freeze', 'rows') },
      ...pageBreakItems(ctx, 'row')];
  } else if (kind === 'col') {
    const { c1, c2 } = ctx.range();
    const hiddenCols = ctx.wb.hiddenWithin(ctx.sheetId(), 'col', c1, c2);
    const nc = c2 - c1 + 1;
    items = [...clipboard,
      { label: t('common.insert'), icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'left') },
      { label: t('common.delete'), icon: 'deleteCols', onSelect: () => ctx.run('deleteCols') },
      { label: t('contextmenu.clearContents'), icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      { separator: true },
      { label: t('contextmenu.formatCells'), icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      { label: t('contextmenu.col.width'), icon: 'colWidth', onSelect: () => ctx.run('resizeCols') },
      { label: t('common.hide'), icon: 'hideEye', onSelect: () => ctx.run('hide', 'col') },
      { label: t('contextmenu.unhide'), icon: 'showHide', disabled: !hiddenCols.length, onSelect: () => ctx.run('unhide', 'col') },
      { separator: true },
      { label: t('contextmenu.col.insertRight', { count: nc }), icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'right') },
      { label: t('contextmenu.col.autoFit'), icon: 'colWidth', onSelect: () => ctx.run('autofit') },
      { label: t('contextmenu.sortAToZ'), icon: 'sortAsc', onSelect: () => ctx.run('sort', 'asc') },
      { label: t('contextmenu.sortZToA'), icon: 'sortDesc', onSelect: () => ctx.run('sort', 'desc') },
      { label: ctx.wb.filterAt(ctx.sheetId(), ctx.active().r, ctx.active().c) ? t('contextmenu.filter.removeLower') : t('contextmenu.filter.create'), icon: 'filter', onSelect: () => ctx.run('filter') },
      { label: t('contextmenu.columnStats'), icon: 'columnStats', onSelect: () => ctx.run('columnStats') },
      { label: t('contextmenu.col.group', { count: nc, from: colName(c1), to: colName(c2) }), icon: 'group', onSelect: () => ctx.run('group', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => g.to >= c1 && g.from <= c2) && { label: t('contextmenu.col.ungroup'), icon: 'ungroup', onSelect: () => ctx.run('ungroup', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => !g.collapsed) && { label: t('contextmenu.col.collapseAll'), icon: 'chevL', onSelect: () => ctx.run('collapseAll', 'col') },
      ctx.wb.outlineGroups(ctx.sheetId(), 'col').some((g) => g.collapsed) && { label: t('contextmenu.col.expandAll'), icon: 'chevR', onSelect: () => ctx.run('expandAll', 'col') },
      sheet.frozenCols === c2 + 1
        ? { label: t('contextmenu.col.unfreeze'), icon: 'freeze', onSelect: () => ctx.run('freeze', 'cols-none') }
        : { label: t('contextmenu.col.freezeUpTo', { col: colName(c2) }), icon: 'freeze', onSelect: () => ctx.run('freeze', 'cols') },
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
    const filtered = ctx.filterShownAt ? ctx.filterShownAt(ctx.sheetId(), active.r, active.c) : !!ctx.wb.filterAt(ctx.sheetId(), active.r, active.c);
    // The cell menu: clipboard, Insert… and Delete… by how the cells move, Clear Contents, Filter and Sort,
    // notes, Format Cells…, the pick list, Define Name and links. The app's further tools follow in submenus.
    items = [
      ...editItems.filter((item) => item && item.id !== 'pasteValues' && item.id !== 'pasteSpecialMenu'),
    ];
    items.splice(items.findIndex((item) => item.id === 'paste') + 1, 0, { label: t('contextmenu.pasteSpecial'), icon: 'paste', submenu: pasteSpecialItems(ctx) });
    items.push(
      // After a copy the menu offers the copied cells to insert, the cells here moving aside (the Insert Paste dialog).
      flags?.copiedCells && { label: t('contextmenu.insertCopiedCells'), icon: 'paste', onSelect: () => ctx.run('insertCopiedCells') },
      { label: t('contextmenu.insert.menu'), icon: 'insertCells', submenu: [
        { label: t('contextmenu.insert.shiftRight'), icon: 'insertCells', onSelect: () => ctx.run('insertCells', 'right') },
        { label: t('contextmenu.insert.shiftDown'), icon: 'insertCells', onSelect: () => ctx.run('insertCells', 'down') },
        { label: t('contextmenu.entireRows', { count: nr }), icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'above') },
        { label: t('contextmenu.entireColumns', { count: nc }), icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'left') },
        { separator: true },
        { label: t('contextmenu.insert.rowsBelow', { count: nr }), icon: 'insertRows', onSelect: () => ctx.run('insertRows', 'below') },
        { label: t('contextmenu.insert.columnsRight', { count: nc }), icon: 'insertCols', onSelect: () => ctx.run('insertCols', 'right') },
        { separator: true },
        { label: t('contextmenu.insert.checkboxes', { count: nr * nc }), icon: 'checkbox', onSelect: () => ctx.run('insertCheckbox') },
        { label: t('contextmenu.insert.dropdown'), icon: 'dropdown', onSelect: () => ctx.run('insertDropdown') },
        { label: t('contextmenu.insert.datePicker'), icon: 'calendar', onSelect: () => ctx.run('datePicker') },
        { label: t('contextmenu.insert.chart'), icon: 'chartColumn', onSelect: () => ctx.run('insertChart') },
        { label: t('contextmenu.insert.image'), icon: 'image', onSelect: () => ctx.run('insertImage') },
        flags?.pick && { label: t('contextmenu.insert.imageFromPuter'), icon: 'folderOpen', onSelect: () => ctx.run('insertImagePuter') },
        { label: t('contextmenu.insert.imageFromUrl'), icon: 'external', onSelect: () => ctx.run('insertImageUrl') },
        { label: t('contextmenu.insert.textBox'), icon: 'textBox', onSelect: () => ctx.run('insertTextBox') },
        { label: t('contextmenu.insert.fillSeries'), icon: 'series', onSelect: () => ctx.run('fillSeries') },
      ] },
      { label: t('contextmenu.delete.menu'), icon: 'deleteCells', submenu: [
        { label: t('contextmenu.delete.shiftLeft'), icon: 'deleteCells', onSelect: () => ctx.run('deleteCells', 'left') },
        { label: t('contextmenu.delete.shiftUp'), icon: 'deleteCells', onSelect: () => ctx.run('deleteCells', 'up') },
        { label: t('contextmenu.entireRows', { count: nr }), icon: 'deleteRows', onSelect: () => ctx.run('deleteRows') },
        { label: t('contextmenu.entireColumns', { count: nc }), icon: 'deleteCols', onSelect: () => ctx.run('deleteCols') },
        { separator: true },
        { label: t('contextmenu.delete.duplicateRows'), icon: 'dedupe', onSelect: () => ctx.run('dedupe') },
        { label: t('contextmenu.delete.emptyRows'), icon: 'rows', onSelect: () => ctx.run('removeEmptyRows') },
      ] },
      { label: t('contextmenu.clearContents'), icon: 'eraser', shortcut: 'Delete', onSelect: () => ctx.run('clear') },
      ...pageBreakItems(ctx, 'cell'),
      // A picture placed in the cell: lift it out to float over the cells, or describe it.
      ...(flags?.cellPicture ? [{ separator: true },
        { label: t('contextmenu.placeOverCells'), icon: 'placeOverCells', onSelect: () => ctx.run('placeOverCells') },
        { label: t('contextmenu.object.editAltText'), icon: 'altText', onSelect: () => ctx.run('cellAltText') }] : []),
      { separator: true },
      { label: t('contextmenu.filter.menu'), icon: 'filter', submenu: [
        { label: filtered ? t('contextmenu.filter.remove') : t('contextmenu.filter.menu'), icon: filtered ? 'filterClear' : 'filter', shortcut: `${MOD_KEY}+Shift+L`, onSelect: () => ctx.run('filter') },
      ] },
      { label: t('contextmenu.sort.menu'), icon: 'sortAsc', submenu: [
        { label: t('contextmenu.sortAToZ'), icon: 'sortAsc', onSelect: () => ctx.run('sort', 'asc') },
        { label: t('contextmenu.sortZToA'), icon: 'sortDesc', onSelect: () => ctx.run('sort', 'desc') },
        { separator: true },
        { label: t('contextmenu.sort.custom'), icon: 'sortCustom', onSelect: () => ctx.run('sortDialog') },
        nr > 1 && { label: t('contextmenu.sort.randomize'), icon: 'sortAsc', onSelect: () => ctx.run('shuffle') },
      ] },
      table ? { label: t('contextmenu.table.menu'), icon: 'formatTable', submenu: [
        { label: t('contextmenu.table.edit', { name: table.name }), icon: 'formatTable', onSelect: () => ctx.run('editTable') },
        { label: table.totalsRow ? t('contextmenu.table.removeTotalsRow') : t('contextmenu.table.totalsRow'), icon: 'subtotal', onSelect: () => ctx.run('tableTotals') },
        { label: t('contextmenu.table.convertToRange'), icon: 'convertToRange', onSelect: () => ctx.run('tableConvert') },
      ] } : null,
      { separator: true },
      // Threaded comments first: start one, or reply to and delete the one here.
      // A cell holds a thread or a note, not both.
      ...(ctx.wb.sheet(ctx.sheetId())?.comments?.has(`${active.r},${active.c}`)
        ? [{ label: t('contextmenu.comment.reply'), icon: 'comment', onSelect: () => ctx.run('replyComment') }, { label: t('contextmenu.comment.delete'), icon: 'deleteComment', onSelect: () => ctx.run('deleteComment') }]
        : [!note && { label: t('contextmenu.comment.new'), icon: 'comment', shortcut: `${MOD_KEY}+Shift+F2`, onSelect: () => ctx.run('newComment') },
          note ? { label: t('contextmenu.note.edit'), icon: 'note', shortcut: 'Shift+F2', onSelect: () => ctx.run('note') } : { label: t('contextmenu.note.new'), icon: 'note', shortcut: 'Shift+F2', onSelect: () => ctx.run('note') },
          note && { label: t('contextmenu.note.delete'), icon: 'deleteNote', onSelect: () => ctx.run('deleteNote') }]),
      { label: t('contextmenu.showChanges'), icon: 'showChanges', onSelect: () => ctx.run('showChanges', 'selection') },
      { separator: true },
      { label: t('contextmenu.formatCells'), icon: 'formatCells', shortcut: `${MOD_KEY}+1`, onSelect: () => ctx.run('formatCells') },
      nr * nc === 1 && { label: t('contextmenu.pickFromList'), icon: 'dropdown', shortcut: 'Alt+↓', onSelect: () => ctx.run('pickFromList') },
      { label: t('contextmenu.defineName'), icon: 'defineName', onSelect: () => ctx.run('defineName') },
      ...linkItems(ctx),
      { separator: true },
      { label: t('contextmenu.format.menu'), icon: 'paint', submenu: [
        { label: t('contextmenu.format.conditional'), icon: 'condFormat', onSelect: () => ctx.run('condFormat') },
        { label: t('contextmenu.format.alternatingColors'), icon: 'formatTable', onSelect: () => ctx.run('bands') },
        { label: t('contextmenu.format.clearFormats'), icon: 'clearFormat', onSelect: () => ctx.run('clearFormat') },
        { label: ctx.wb.protectedRangeAt(ctx.sheetId(), active.r, active.c) ? t('contextmenu.format.protectedRanges') : t('contextmenu.format.protectRange'), icon: 'protectRanges', onSelect: () => ctx.run('protectRanges') },
        { separator: true },
        merged
          ? { label: t('contextmenu.format.unmerge'), icon: 'unmerge', onSelect: () => ctx.run('merge') }
          : { label: t('contextmenu.format.merge'), icon: 'merge', disabled: singleCell, onSelect: () => ctx.run('merge') },
        nr > 1 && nc > 1 && { label: t('contextmenu.format.mergeAcross'), icon: 'merge', onSelect: () => ctx.run('mergeAcross') },
        nr > 1 && nc > 1 && { label: t('contextmenu.format.mergeDown'), icon: 'merge', onSelect: () => ctx.run('mergeDown') },
      ] },
      { label: t('contextmenu.data.menu'), icon: 'database', submenu: [
        table ? null : { label: t('contextmenu.data.createTable'), icon: 'table', onSelect: () => ctx.run('insertTable') },
        { label: t('contextmenu.data.subtotals'), icon: 'subtotal', onSelect: () => ctx.run('subtotal') },
        { label: t('contextmenu.data.pivotTable'), icon: 'pivot', onSelect: () => ctx.run('pivot') },
        { label: t('contextmenu.columnStats'), icon: 'columnStats', onSelect: () => ctx.run('columnStats') },
        { separator: true },
        { label: t('contextmenu.data.splitText'), icon: 'textToColumns', onSelect: () => ctx.run('splitTextMenu', { x, y }) },
        { label: t('contextmenu.data.changeText'), icon: 'text', onSelect: () => ctx.run('textMenu', { x, y }) },
        { label: t('contextmenu.data.validation'), icon: 'validation', onSelect: () => ctx.run('validation') },
        { label: t('contextmenu.data.selectCells'), icon: 'goTo', onSelect: () => ctx.run('selectSpecialMenu', { x, y }) },
        (nr * nc > 1 || table) && { label: nr * nc > 1 ? t('contextmenu.data.downloadSelectionCsv') : t('contextmenu.data.downloadTableCsv', { name: table.name }), icon: 'fileDown', onSelect: () => ctx.run('downloadRangeCsv') },
      ] },
      { label: t('contextmenu.formula.menu'), icon: 'fx', submenu: [
        hasFormula && { label: t('contextmenu.formula.evaluate'), icon: 'evaluate', onSelect: () => ctx.run('evaluateFormula') },
        { label: t('contextmenu.formula.toValues'), icon: 'toValues', onSelect: () => ctx.run('toValues') },
        hasFormula && { label: t('contextmenu.formula.precedents'), icon: 'precedents', shortcut: `${MOD_KEY}+[`, onSelect: () => ctx.run('trace', 'precedents') },
        { label: t('contextmenu.formula.dependents'), icon: 'dependents', shortcut: `${MOD_KEY}+]`, onSelect: () => ctx.run('trace', 'dependents') },
        hasFormula && { label: t('contextmenu.formula.goalSeek'), icon: 'goalSeek', onSelect: () => ctx.run('goalSeek') },
        ctx.canAI?.() && { separator: true },
        ctx.canAI?.() && { label: t('contextmenu.formula.aiWrite'), icon: 'sparkle', onSelect: () => ctx.run('aiFormula') },
        hasFormula && ctx.canAI?.() && { label: t('contextmenu.formula.aiExplain'), icon: 'sparkle', onSelect: () => ctx.run('aiExplain') },
        ctx.canAI?.() && { label: nr * nc > 1 ? t('contextmenu.formula.aiAskCells') : t('contextmenu.formula.aiAskData'), icon: 'sparkle', onSelect: () => ctx.run('aiAsk') },
        ctx.canAI?.() && { label: t('contextmenu.formula.aiAssistant'), icon: 'sparkle', onSelect: () => ctx.run('aiPanel', true) },
        { separator: true },
        { label: t('contextmenu.formula.insertFunction'), icon: 'fx', shortcut: 'Shift+F3', onSelect: () => ctx.run('functionMenu') },
        nr * nc > 1 && { label: t('contextmenu.formula.createNames'), icon: 'createNames', onSelect: () => ctx.run('createNames') },
      ] },
    );
  }
  openMenu({ x, y, items, label: t('contextmenu.cellMenu'), restoreFocus: false, onClose: () => ctx.grid.focus() });
}
