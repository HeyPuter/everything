/** Chartsheet drawings occupy a canvas in absolute pixels, not a cell grid. */
export function chartSheetBounds(sheet) {
  let width = 1, height = 1;
  for (const object of sheet.charts) {
    width = Math.max(width, object.dx + object.w);
    height = Math.max(height, object.dy + object.h);
  }
  return { width, height };
}

export function chartSheetLayout(sheet, width, height, zoom = 1) {
  const bounds = chartSheetBounds(sheet);
  const scale = sheet.zoomToFit && width > 0 && height > 0
    ? Math.min(width / bounds.width, height / bounds.height) : zoom;
  return { scale, width: bounds.width * scale, height: bounds.height * scale };
}

// Cell commands have no target on a chartsheet. Keep the same capabilities in
// menus, the palette and shortcut dispatch, rather than pretending it is protected.
const CHART_SHEET_COMMANDS = new Set([
  'new', 'newFromTemplate', 'open', 'openFile', 'home', 'import', 'importUrl', 'importSheets',
  'save', 'saveAs', 'rename', 'share', 'versions', 'docInfo', 'downloadXlsx', 'downloadOds', 'exportPdf', 'print',
  'undo', 'redo', 'undoSteps', 'redoSteps', 'escape', 'palette', 'recalc', 'names', 'options',
  'newSheet', 'duplicateSheet', 'showSheet', 'hideSheet', 'deleteSheet', 'renameSheet', 'moveSheet',
  'protectSheet', 'sheetColor', 'copySheetTo', 'moveOrCopySheet', 'placeSheet', 'sheet', 'focusMode', 'fullscreen', 'zoom', 'zoomTo', 'zoomCustom', 'zoomFit',
  'customViews', 'addCustomView', 'deleteCustomView', 'showCustomView',
  'editChart', 'deleteChart', 'duplicateChart', 'copyChart', 'downloadChart', 'chart',
  'insertImage', 'insertImagePuter', 'insertImageUrl', 'replaceImage', 'insertTextBox', 'copy', 'paste', 'find', 'goTo', 'goToName',
]);
export const chartSheetCommand = command => CHART_SHEET_COMMANDS.has(command);
