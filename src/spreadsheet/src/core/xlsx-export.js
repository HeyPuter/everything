import { rebaseExternalWorkbooks } from './external-workbooks.js';
import { writeXlsxExternalWorkbooks } from './xlsx-external-workbooks.js';
import { nativePivotRuleOwners, exportPivotRuleSheet } from './native-pivot-rule-bindings.js';
import { encodeXlsxAttribute } from './xlsx-string.js';
import { nativeSparklineExtension } from './xlsx-sparklines.js';
import { prepareXlsxSlicers, writeXlsxSlicers } from './xlsx-export-slicers.js';
import { exportXlsxScrollControls } from './xlsx-scroll-controls.js';
import { COMPATIBILITY_EXTENSION, COMPATIBILITY_NAMESPACE } from './xlsx-calculation-compatibility.js';
import { writeXlsxIgnoredErrors } from './xlsx-ignored-errors.js';
import { fontThemeXml, effectiveFontTheme } from './font-theme.js';
import { writeXlsxRichText } from './xlsx-rich-text.js';
import { effectiveColorPalette } from './font-color.js';
/** Complete the XLSX parts that the vendored Community Edition does not write. */
import { exportStyles, xmlTag, xmlText } from './xlsx-export-styles.js';
import { exportDrawings, updateDrawingMetadata } from './xlsx-export-drawings.js';
import { xlsxAttr, xlsxWidthFromPixels, readXlsxStyles } from './xlsx-styles.js';
import { normalizeNativeDefaultHeight } from './xlsx-sheet-format.js';
import { tableStyleParts, parseTableSpec } from './tables.js';
import { writeThemeInfo } from './workbook-theme.js';
import { parseFormula } from './formula/parser.js';
import { writeXlsxPrint } from './xlsx-export-print.js';
import { writeXlsxOutlineSettings } from './xlsx-outline.js';
import { writeXlsxBackground } from './xlsx-background.js';
import { writeXlsxSheetCustomViews, writeXlsxWorkbookCustomViews } from './xlsx-custom-views.js';
import { richValueWriter } from './xlsx-rich-values.js';
import { scenariosXml } from './scenarios.js';
import { parseKey } from './cell.js';
import { MAX_COL } from './refs.js';
import { toFileFormula } from './xlfn.js';
import { writeXlsxConditionalFormats } from './xlsx-export-condformat.js';
import { readXlsxConditionalFormats } from './xlsx-condformat.js';
import { writeExportMetadata } from './xlsx-export-meta.js';
import { normalizeSplit, splitPaneXml, paneName } from './split-panes.js';
import { conditionalFormatSignature } from './xlsx-condformat-reconcile.js';
import { createPersonList, writeXlsxThreadedComments, writeXlsxPersons } from './xlsx-threaded-comments.js';
import { writeXlsxScripts } from './xlsx-scripts.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// Totals cells and table-column metadata must describe the same operation.
// Excel repairs inconsistent tables by removing their totals-row boundary,
// making a subtotal of its own data column circular. Derive metadata from the
// current cells so edits, undo and structural changes cannot leave stale totals.
function tableTotal(cell, table, column) {
  if (!table.totalsRow || !cell) return { attrs: {}, formula: '' };
  // Non-text constants are custom totals without a formula. A label would
  // contradict their native cell type; inventing a formula would change them.
  if (!cell.f) return { attrs: typeof cell.v === 'string' ? { totalsRowLabel: cell.v }
    : cell.v != null ? { totalsRowFunction: 'custom' } : {}, formula: '' };
  let builtIn;
  try {
    const ast = parseFormula(cell.f), ref = ast.args?.[1];
    const spec = ref?.type === 'tref' ? parseTableSpec(ref.spec) : null;
    if (!cell.F && ast.type === 'call' && ast.name.toUpperCase() === 'SUBTOTAL' && !ast.sheet && ast.args.length === 2
      && ast.args[0].type === 'num' && (!ref.table || ref.table.toLowerCase() === table.name.toLowerCase())
      && spec?.rows === 'data' && spec.cols?.every(name => name.toLowerCase() === column.toLowerCase())) {
      // Only 100-series SUBTOTALs match Excel's built-in totals: the other
      // variants include manually hidden rows and must remain custom formulas.
      builtIn = { 101: 'average', 102: 'countNums', 103: 'count', 104: 'max', 105: 'min', 107: 'stdDev', 109: 'sum', 110: 'var' }[ast.args[0].value];
    }
  } catch { /* Unsupported formulas remain verbatim custom totals. */ }
  return { attrs: { totalsRowFunction: builtIn || 'custom' },
    formula: builtIn ? '' : xmlTag('totalsRowFormula', { array: cell.F ? 1 : null }, xmlText(cell.f).replace(/\r/g, '&#13;')) };
}

function worksheetViews(X, wb, sheet) {
  const r = sheet.frozenRows, c = sheet.frozenCols;
  const base = { r: r ? sheet.frozenOrigin?.r || 0 : 0, c: c ? sheet.frozenOrigin?.c || 0 : 0 };
  const origin = sheet.viewOrigin || { r: base.r + r, c: base.c + c };
  const topLeft = { r: r ? base.r : origin.r, c: c ? base.c : origin.c };
  const saved = sheet.viewSelection;
  const active = saved?.active || { r: base.r + r, c: base.c + c };
  const pane = active.r >= base.r + r && r ? (active.c >= base.c + c && c ? 'bottomRight' : 'bottomLeft')
    : active.c >= base.c + c && c ? 'topRight' : 'topLeft';
  const at = X.utils.encode_cell({ r: r ? Math.max(base.r + r, origin.r) : origin.r, c: c ? Math.max(base.c + c, origin.c) : origin.c });
  const selection = saved ? xmlTag('selection', {
    pane: r || c ? pane : null, activeCell: X.utils.encode_cell(active),
    activeCellId: saved.ranges.length > 1 ? saved.activeRange : null,
    sqref: saved.ranges.map(rg => X.utils.encode_range({ s: { r: rg.r1, c: rg.c1 }, e: { r: rg.r2, c: rg.c2 } })).join(' '),
  }) : r || c ? xmlTag('selection', { pane, activeCell: at, sqref: at }) : '';
  const split = !r && !c ? normalizeSplit(sheet.split) : null;
  if (split) return splitSheetViews(X, wb, sheet, split);
  const body = (r || c ? xmlTag('pane', { xSplit: c || null, ySplit: r || null, topLeftCell: at, activePane: pane, state: 'frozen' }) : '') + selection;
  return xmlTag('sheetViews', {}, xmlTag('sheetView', {
    workbookViewId: 0, rightToLeft: sheet.rightToLeft ? 1 : undefined, showGridLines: Number(sheet.gridlines), showRowColHeaders: Number(sheet.headers !== false), showZeros: Number(sheet.zeros), tabSelected: Number(wb.activeSheetId === sheet.id),
    view: { pageLayout: 'pageLayout', pageBreak: 'pageBreakPreview' }[sheet.viewMode] || null,
    zoomScale: sheet.viewZoom != null ? Math.round(sheet.viewZoom * 100) : null,
    // Excel keeps each view's zoom; the one shown is the zoom the sheet is viewed at.
    zoomScalePageLayoutView: sheet.viewMode === 'pageLayout' && sheet.viewZoom != null ? Math.round(sheet.viewZoom * 100) : null,
    zoomScaleSheetLayoutView: sheet.viewMode === 'pageBreak' && sheet.viewZoom != null ? Math.round(sheet.viewZoom * 100) : null,
    topLeftCell: topLeft.r || topLeft.c ? X.utils.encode_cell(topLeft) : null,
  }, body));
}

/**
 * A split window: xSplit and ySplit are distances in twentieths of a point (frozen panes count lines there),
 * sheetView names the top-left pane's first cell and the pane the bottom-right one's. The selection is the
 * active pane's, which is the bottom-right one, where Split leaves the active cell.
 */
function splitSheetViews(X, wb, sheet, split) {
  const origin = sheet.viewOrigin || { r: split.r, c: split.c };
  const at = X.utils.encode_cell({ r: split.y ? origin.r : split.r, c: split.x ? origin.c : split.c });
  const activePane = paneName(split, { left: false, top: false });
  const saved = sheet.viewSelection;
  const selection = saved ? xmlTag('selection', {
    pane: activePane, activeCell: X.utils.encode_cell(saved.active),
    activeCellId: saved.ranges.length > 1 ? saved.activeRange : null,
    sqref: saved.ranges.map(rg => X.utils.encode_range({ s: { r: rg.r1, c: rg.c1 }, e: { r: rg.r2, c: rg.c2 } })).join(' '),
  }) : xmlTag('selection', { pane: activePane, activeCell: at, sqref: at });
  return xmlTag('sheetViews', {}, xmlTag('sheetView', {
    workbookViewId: 0, rightToLeft: sheet.rightToLeft ? 1 : undefined, showGridLines: Number(sheet.gridlines), showRowColHeaders: Number(sheet.headers !== false), showZeros: Number(sheet.zeros), tabSelected: Number(wb.activeSheetId === sheet.id),
    zoomScale: sheet.viewZoom != null ? Math.round(sheet.viewZoom * 100) : null,
    topLeftCell: split.r || split.c ? X.utils.encode_cell({ r: split.r, c: split.c }) : null,
  }, splitPaneXml(split, { topLeftCell: at, activePane }) + selection));
}

/** The ZIP is patched before compression; other parts (formulas, comments, links) remain intact. */
/**
 * A What-If data table ({=TABLE(row input, column input)}) as Excel keeps it: a dataTable formula naming its input
 * cells, two-dimensional with both, otherwise a row (dtr) or column table with the one.
 */
export function dataTableFormula(ref, row, col) {
  const cell = (text) => { const t = text.trim().replace(/\$/g, ''); return /^[A-Z]{1,3}[1-9]\d*$/i.test(t) ? t.toUpperCase() : t ? false : null; };
  const r = cell(row), c = cell(col);
  if (r === false || c === false || (!r && !c)) return null;
  const attrs = r && c ? { ref, dt2D: 1, dtr: 1, r1: r, r2: c } : r ? { ref, dt2D: 0, dtr: 1, r1: r } : { ref, dt2D: 0, dtr: 0, r1: c };
  return `<f t="dataTable"${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}/>`;
}

export async function completeXlsx(X, wb, book, bytes, { sourceWorkbook = null } = {}) {
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const get = path => { const file = X.CFB.find(zip, path); return file ? decoder.decode(file.content) : ''; };
  const set = (path, text) => X.CFB.utils.cfb_add(zip, path, encoder.encode(text));
  // Theme references are workbook-wide. Preserve the imported palette rather
  // than resolving font colors against the writer's unrelated default theme.
  if (wb.colorPalette?.theme) {
    const slots = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    let theme = get('/xl/theme/theme1.xml');
    slots.forEach((slot, i) => {
      const rgb = wb.colorPalette.theme[i];
      if (rgb) theme = theme.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}><a:srgbClr val="${rgb.slice(1).toUpperCase()}"/></a:${slot}>`);
    });
    set('/xl/theme/theme1.xml', theme);
  }
  const normalFont = wb.normalFont || { name: 'Calibri', sz: 12 };
  const fonts = fontThemeXml(effectiveFontTheme(wb.fontTheme));
  if (fonts) set('/xl/theme/theme1.xml', get('/xl/theme/theme1.xml').replace(/<a:fontScheme\b[^>]*>[\s\S]*?<\/a:fontScheme>/, fonts));
  if (wb.themeInfo) set('/xl/theme/theme1.xml', writeThemeInfo(get('/xl/theme/theme1.xml'), wb.themeInfo));
  let sourceStyles = get('/xl/styles.xml');
  if (wb.colorPalette?.indexed?.length) {
    const indexed = xmlTag('indexedColors', {}, effectiveColorPalette(wb.colorPalette).indexed.map(c => xmlTag('rgbColor', { rgb: `FF${(c || '#000000').slice(1).toUpperCase()}` })).join(''));
    sourceStyles = sourceStyles.replace(/<colors\b[^>]*>[\s\S]*?<\/colors>/g, '').replace('</styleSheet>', xmlTag('colors', {}, indexed) + '</styleSheet>');
  }
  const defaultVAlign = wb.sheets.find(s => s.kind !== 'chart')?.defaultVAlign || 'middle';
  const slicers = prepareXlsxSlicers(wb);
  const styles = exportStyles(sourceStyles, wb.normalFont, wb.colorPalette, defaultVAlign, wb.fontTheme, wb.nativeNormalStyle, wb.nativeNormalFill, wb.nativeDefaultCellFormat, wb.cellStyles);
  // Reuse identical hidden helpers after import; never shadow a user name or
  // table, including local names which would intercept a global helper call.
  const usedNames = new Set([...wb.names.map(n => n.name), ...wb.tableNames()].map(n => n.toUpperCase()));
  const localNames = new Set(wb.names.filter(n => n.sheet).map(n => n.name.toUpperCase()));
  const helperNames = new Map(wb.names.filter(n => n.hidden && !n.sheet && !localNames.has(n.name.toUpperCase())).map(n => [n.ref, n.name]));
  const helpers = [];
  let helperIndex = 0;
  const defineHelper = ref => {
    if (helperNames.has(ref)) return helperNames.get(ref);
    let name;
    do { name = `_PuterCF${++helperIndex}`; } while (usedNames.has(name.toUpperCase()));
    usedNames.add(name.toUpperCase()); helperNames.set(ref, name);
    helpers.push(xmlTag('definedName', { name, hidden: 1 }, xmlText(toFileFormula(ref))));
    return name;
  };
  const drawingRecords = new Map();
  const pivotRulePriorities = new Map(), pivotRuleOwners = nativePivotRuleOwners(wb.nativePivots);
  const conditionalRecords = new Map();
  const recordDrawing = (name, id, key) => {
    if (!drawingRecords.has(name)) drawingRecords.set(name, []);
    drawingRecords.get(name).push({ id, key });
  };
  const groupRecords = new Map();
  const recordGroup = (name, key) => { if (!groupRecords.has(name)) groupRecords.set(name, []); groupRecords.get(name).push(key); };
  let types = get('/[Content_Types].xml'), tableId = 0;
  const contentType = (path, type) => { types = types.replace('</Types>', xmlTag('Override', { PartName: path, ContentType: type }) + '</Types>'); };
  const richValues = richValueWriter({ get, set, binary: (path, data) => X.CFB.utils.cfb_add(zip, path, data), contentType });
  const persons = createPersonList();
  for (const [i, sheet] of wb.sheets.entries()) {
    const ws = book.Sheets[sheet.name], path = `/xl/worksheets/sheet${i + 1}.xml`;
    if (sheet.kind === 'chart') {
      const chartPath = `/xl/chartsheets/sheet${i + 1}.xml`;
      const drawing = await exportDrawings(X, wb, sheet, i + 1, { set, binary: (path, data) => X.CFB.utils.cfb_add(zip, path, data), contentType, recordDrawing, recordGroup, slicers });
      const views = xmlTag('sheetViews', {}, xmlTag('sheetView', {
        workbookViewId: 0, tabSelected: Number(wb.activeSheetId === sheet.id), zoomToFit: Number(!!sheet.zoomToFit),
        zoomScale: sheet.viewZoom != null ? Math.round(sheet.viewZoom * 100) : null,
      }));
      const properties = sheet.color ? xmlTag('sheetPr', {}, xmlTag('tabColor', { rgb: `FF${sheet.color.slice(1).toUpperCase()}` })) : '';
      const protection = sheet.protected ? xmlTag('sheetProtection', { content: 1, objects: 1 }) : '';
      set(chartPath, writeXlsxPrint(HEADER + xmlTag('chartsheet', { xmlns: MAIN, 'xmlns:r': REL.slice(0, -1) },
        properties + views + protection + xmlTag('drawing', { 'r:id': 'puterDrawing' })), sheet.printSettings));
      set(`/xl/chartsheets/_rels/sheet${i + 1}.xml.rels`, HEADER + xmlTag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
        xmlTag('Relationship', { Id: 'puterDrawing', Type: `${REL}drawing`, Target: drawing })));
      // SheetJS supplies the workbook's sheet IDs and order. Change only this
      // relationship's part and type; hidden states and local names keep those IDs.
      set('/xl/_rels/workbook.xml.rels', get('/xl/_rels/workbook.xml.rels').replace(/<Relationship\b[^>]*\/>/g, rel =>
        xlsxAttr(rel, 'Target')?.replace(/^\/?xl\//, '') === `worksheets/sheet${i + 1}.xml`
          ? rel.replace(/Target="[^"]*"/, `Target="chartsheets/sheet${i + 1}.xml"`).replace(`${REL}worksheet`, `${REL}chartsheet`) : rel));
      types = types.replace(/<Override\b[^>]*\/>/g, entry => xlsxAttr(entry, 'PartName') === path ? '' : entry);
      contentType(chartPath, 'application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml');
      X.CFB.utils.cfb_del(zip, path);
      X.CFB.utils.cfb_del(zip, `/xl/worksheets/_rels/sheet${i + 1}.xml.rels`);
      continue;
    }
    let xml = get(path);
    xml = xml.replace(/<c\b[^>]*>/g, head => {
      const cell = ws[xlsxAttr(head, 'r')];
      if (!cell) return head;
      const index = styles.cell(cell.s, Number(xlsxAttr(head, 's') || 0));
      return head.replace(/\ss="[^"]*"/, '').replace(/(\sr="[^"]*")/, `$1 s="${index}"`);
    });
    xml = xml.replace(/<sheetViews\b[^>]*>[\s\S]*?<\/sheetViews>/, worksheetViews(X, wb, sheet));
    xml = xml.replace(/<f\b[^>]*\bt="array"[^>]*\bref="([^"]+)"[^>]*>(?:_xlfn\.)?TABLE\(([^(),]*),([^(),]*)\)<\/f>/g, (all, ref, row, col) => dataTableFormula(ref, row, col) || all);
    // A protected sheet says so where Excel reads it, right after the cells (and any sheetCalcPr); no password is set.
    xml = xml.replace(/<sheetProtection\b[^>]*\/>/g, '');
    if (sheet.protected) {
      const protection = xmlTag('sheetProtection', { sheet: 1, objects: 1, scenarios: 1 });
      xml = /<sheetCalcPr\b[^>]*\/>/.test(xml) ? xml.replace(/(<sheetCalcPr\b[^>]*\/>)/, `$1${protection}`)
        : xml.replace(/(<\/sheetData>|<sheetData\/>)/, `$1${protection}`);
    }
    // Scenarios follow the protection (OOXML order: sheetProtection, protectedRanges, scenarios, autoFilter...).
    xml = xml.replace(/<scenarios\b[\s\S]*?<\/scenarios>|<scenarios\b[^>]*\/>/g, '');
    const scenarios = scenariosXml(sheet.scenarios);
    if (scenarios) xml = xml.replace(/<(?:autoFilter|sortState|dataConsolidate|customSheetViews|mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/, (m) => scenarios + m);
    // Retain untouched native units when the font basis is unchanged. This
    // also preserves dimensions in another app that has a font we lack.
    const native = JSON.stringify(sheet.nativeWidths?.font) === JSON.stringify(normalFont) ? sheet.nativeWidths : null;
    const def = native?.default;
    const widthAttrs = def && def.pixels === sheet.defaultColWidth
      ? { defaultColWidth: def.width, baseColWidth: def.base }
      : { defaultColWidth: xlsxWidthFromPixels(sheet.defaultColWidth, normalFont) };
    const height = normalizeNativeDefaultHeight(sheet.nativeDefaultHeight);
    const heightMode = height?.pixels === sheet.defaultRowHeight ? height.mode : null;
    // An absent format element has different Excel initialization semantics.
    // Retain it while both defaults still match; explicit line edits live in
    // cols/row records and do not require changing the worksheet defaults.
    const implicitFormat = heightMode === 'implicit' && def?.pixels === sheet.defaultColWidth && def.base === 10 && def.width == null;
    const format = implicitFormat ? '' : xmlTag('sheetFormatPr', { defaultRowHeight: sheet.defaultRowHeight * 3 / 4, ...widthAttrs,
      customHeight: heightMode === 'auto' ? null : 1 });
    xml = /<sheetFormatPr\b/.test(xml) ? xml.replace(/<sheetFormatPr\b[^>]*\/>/, format) : xml.replace('</sheetViews>', `</sheetViews>${format}`);
    const columnRuns = [];
    const sheetVAlign = sheet.defaultVAlign || 'middle';
    const defaultColumnStyle = sheetVAlign !== defaultVAlign ? styles.cell({ valign: sheetVAlign }) : null;
    // Excel treats a column record with no width as zero-width. Retain the
    // sheet's default width when a style-only span supplies its alignment.
    const defaultColumnAttrs = { width: widthAttrs.defaultColWidth ?? xlsxWidthFromPixels(sheet.defaultColWidth, normalFont), customWidth: 1, style: defaultColumnStyle };
    let nextDefaultColumn = 0;
    const columnKeys = [...new Set([...Object.keys(ws['!cols'] || {}), ...Object.keys(native?.cols || {})])].map(Number).sort((a, b) => a - b);
    for (const c of columnKeys) {
      if (defaultColumnStyle != null && c > nextDefaultColumn) columnRuns.push({ min: nextDefaultColumn + 1, max: c, attrs: defaultColumnAttrs });
      nextDefaultColumn = c + 1;
      const col = ws['!cols']?.[c] || {}, pixels = col.wpx ?? sheet.defaultColWidth;
      const saved = native?.cols[c];
      const attrs = { width: saved?.pixels === pixels ? saved.width : xlsxWidthFromPixels(pixels, normalFont), customWidth: 1,
        hidden: col.hidden ? 1 : null, style: sheet.colStyles.has(c) ? styles.cell({ valign: sheetVAlign, ...sheet.colStyles.get(c) }) : defaultColumnStyle };
      const previous = columnRuns.at(-1), signature = JSON.stringify(attrs);
      if (previous?.max === c && previous.signature === signature) previous.max = c + 1;
      else columnRuns.push({ min: c + 1, max: c + 1, attrs, signature });
    }
    if (defaultColumnStyle != null && nextDefaultColumn <= MAX_COL) columnRuns.push({ min: nextDefaultColumn + 1, max: MAX_COL + 1, attrs: defaultColumnAttrs });
    const columns = columnRuns.map(({ min, max, attrs }) => xmlTag('col', { min, max, ...attrs })).join('');
    xml = xml.replace(/<cols\b[^>]*>[\s\S]*?<\/cols>/, '');
    if (columns) xml = xml.replace(/(<sheetData\b)/, `${xmlTag('cols', {}, columns)}$1`);
    xml = xml.replace(/<row\b[^>]*>/g, head => {
      const r = Number(xlsxAttr(head, 'r')) - 1, style = sheet.rowStyles.get(r);
      // Our row layout is fixed until the user asks to fit it. Excel auto-fits
      // materialized rows without customHeight, even when sheetFormatPr has a
      // custom default height. Spell out the inherited height on existing rows
      // as well; do not materialize the otherwise empty million-row sheet.
      if (xlsxAttr(head, 'ht') == null) head = head.replace(/(\/?>)$/, ` ht="${sheet.defaultRowHeight * 3 / 4}" customHeight="1"$1`);
      if (sheet.rowHeightModes.get(r) === 'auto') head = head.replace(/\scustomHeight="[^"]*"/g, '');
      return style ? head.replace(/\ss="[^"]*"|\scustomFormat="[^"]*"/g, '').replace(/(\/?>)$/, ` s="${styles.cell({ valign: sheetVAlign, ...ws['!nativeRowStyleBase'], ...style })}" customFormat="1"$1`) : head;
    });
    if (sheet.color) {
      const tag = xmlTag('tabColor', { rgb: `FF${sheet.color.slice(1).toUpperCase()}` });
      xml = /<sheetPr\b/.test(xml) ? xml.replace(/(<sheetPr\b[^>]*>)/, `$1${tag}`) : xml.replace(/(<worksheet\b[^>]*>)/, `$1<sheetPr>${tag}</sheetPr>`);
    }
    if (sheet.tables.length || sheet.charts.length) {
      const relPath = `/xl/worksheets/_rels/sheet${i + 1}.xml.rels`;
      let rels = get(relPath) || HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      const parts = [];
      const drawing = await exportDrawings(X, wb, sheet, i + 1, { set, binary: (path, data) => X.CFB.utils.cfb_add(zip, path, data), contentType, recordDrawing, recordGroup, slicers });
      if (drawing) {
        rels = rels.replace('</Relationships>', xmlTag('Relationship', { Id: 'puterDrawing', Type: `${REL}drawing`, Target: drawing }) + '</Relationships>');
        // A DrawingML drawing precedes the VML drawing used by cell comments.
        const tag = xmlTag('drawing', { 'r:id': 'puterDrawing' });
        xml = xml.replace(/(<legacyDrawing\b|<\/worksheet>)/, `${tag}$1`);
      }
      for (const t of sheet.tables) {
        const id = ++tableId, target = `/xl/tables/table${id}.xml`, relId = `puterTable${id}`;
        const ref = X.utils.encode_range({ s: { r: t.range.r1, c: t.range.c1 }, e: { r: t.range.r2, c: t.range.c2 } });
        let columns = '';
        const columnNames = wb.tableColumns(sheet.id, t);
        for (let c = t.range.c1; c <= t.range.c2; c++) {
          const offset = c - t.range.c1, template = ws['!tableFormulas']?.[t.id]?.[offset];
          const formula = template ? xmlTag('calculatedColumnFormula', { array: template.array ? 1 : null }, xmlText(template.formula).replace(/\r/g, '&#13;')) : null;
          const total = tableTotal(ws[X.utils.encode_cell({ r: t.range.r2, c })], t, columnNames[offset]);
          columns += xmlTag('tableColumn', { id: offset + 1, name: encodeXlsxAttribute(columnNames[offset]), ...total.attrs }, (formula || '') + total.formula || null);
        }
        const name = `PuterTableStyle${id}`, appearance = tableStyleParts(t, wb);
        if (appearance) styles.tableStyle(name, appearance);
        const filterRef = X.utils.encode_range({ s: { r: t.range.r1, c: t.range.c1 }, e: { r: t.range.r2 - Number(t.totalsRow), c: t.range.c2 } });
        // A table whose Header Row is off has no AutoFilter: headerRowCount="0" and its names in tableColumn.
        const filter = t.headerRow === false ? null : book.Sheets[sheet.name]?.['!tableFilters']?.[t.id];
        set(target, HEADER + xmlTag('table', { xmlns: MAIN, id, name: encodeXlsxAttribute(t.name), displayName: encodeXlsxAttribute(t.name), ref, ...(t.headerRow === false ? { headerRowCount: 0 } : {}), totalsRowCount: Number(t.totalsRow), totalsRowShown: Number(t.totalsRow) },
          (filter ? xmlTag('autoFilter', { ref: filterRef }, filter.filterColumns || null) : '') + xmlTag('tableColumns', { count: t.range.c2 - t.range.c1 + 1 }, columns)
          + xmlTag('tableStyleInfo', { name: t.style === 'none' ? null : name, showFirstColumn: Number(!!t.firstColumn), showLastColumn: Number(!!t.lastColumn), showRowStripes: Number(t.banded), showColumnStripes: Number(!!t.bandedColumns) })));
        rels = rels.replace('</Relationships>', xmlTag('Relationship', { Id: relId, Type: `${REL}table`, Target: `../tables/table${id}.xml` }) + '</Relationships>');
        contentType(target, 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml');
        parts.push(xmlTag('tablePart', { 'r:id': relId }));
      }
      ({ xml, rels } = exportXlsxScrollControls(wb, sheet, i + 1, xml, rels, { get, set, contentType }));
      set(relPath, rels);
      if (parts.length) xml = xml.replace('</worksheet>', xmlTag('tableParts', { count: parts.length }, parts.join('')) + '</worksheet>');
    }
    if (sheet.background) {
      // Page Layout ▸ Background: the tiled picture, kept as the worksheet's <picture>.
      const relPath = `/xl/worksheets/_rels/sheet${i + 1}.xml.rels`;
      let rels = get(relPath) || HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      ({ xml, rels } = writeXlsxBackground(xml, rels, sheet.background, i + 1, { binary: (path, data) => X.CFB.utils.cfb_add(zip, path, data), contentType }));
      set(relPath, rels);
    }
    const imageValues = new Map();
    for (const [key, cell] of sheet.cells) {
      if (!cell.f && !cell.v?.image) continue;
      const { r, c } = parseKey(key), value = wb.getValue(sheet.id, r, c);
      // A computed picture came from an IMAGE formula (origin 1) or from a reference to another cell's picture (4).
      if (value?.image) imageValues.set(X.utils.encode_cell({ r, c }), { ...value, computed: !!cell.f, ...(cell.f ? { origin: /^\s*(?:_xlfn\.)?IMAGE\s*\(/i.test(cell.f) ? 1 : 4 } : {}) });
    }
    const ruleRecords = [];
    const pivotPriorities = new Map();
    for (const rule of sheet.rules) for (const id of rule.pivotRuleIds || []) pivotPriorities.set(id, new Set());
    pivotRulePriorities.set(sheet.id, pivotPriorities);
    xml = writeXlsxConditionalFormats(xml, wb, exportPivotRuleSheet(sheet, pivotRuleOwners), styles, defineHelper, (start, end, priority) => {
      for (let i = start; i <= end; i++) for (const id of sheet.rules[i].pivotRuleIds || []) {
        if (!pivotPriorities.has(id)) pivotPriorities.set(id, new Set());
        pivotPriorities.get(id).add(priority);
      }
      const previous = ruleRecords.at(-1);
      if (previous?.start === start && previous.end === end) previous.priorities.push(priority);
      else ruleRecords.push({ start, end, priorities: [priority] });
    });
    if (sheet.rules.length) conditionalRecords.set(sheet.name, { xml, entries: ruleRecords });
    const sparklineExtension = nativeSparklineExtension(sheet.sparklineGroups);
    if (sparklineExtension) xml = xml.includes('</extLst>') ? xml.replace('</extLst>', `${sparklineExtension}</extLst>`)
      : xml.replace('</worksheet>', `<extLst>${sparklineExtension}</extLst></worksheet>`);
    xml = writeXlsxIgnoredErrors(xml, sheet.ignoredErrors);
    xml = writeXlsxRichText(xml, ws, wb.colorPalette, normalFont, wb.fontTheme);
    writeXlsxThreadedComments(sheet, i + 1, persons, { get, set, contentType });
    set(path, richValues.sheet(writeXlsxSheetCustomViews(writeXlsxOutlineSettings(writeXlsxPrint(xml, sheet.printSettings), sheet.outlineSettings), wb.customViews || [], sheet), imageValues));
  }
  writeXlsxPersons(persons, { get, set, contentType });
  let workbook = get('/xl/workbook.xml');
  if (helpers.length) workbook = workbook.includes('</definedNames>')
    ? workbook.replace('</definedNames>', `${helpers.join('')}</definedNames>`)
    : workbook.replace(/<(?:calcPr|oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/, match => xmlTag('definedNames', {}, helpers.join('')) + match);
  const { firstSheetId, ...windowView } = wb.workbookView || {};
  const firstSheet = firstSheetId == null ? null : wb.sheets.findIndex(s => s.id === firstSheetId);
  const views = xmlTag('bookViews', {}, xmlTag('workbookView', {
    ...windowView, firstSheet: firstSheet >= 0 ? firstSheet : null,
    activeTab: Math.max(0, wb.sheets.findIndex(s => s.id === wb.activeSheetId)),
  }));
  workbook = /<bookViews\b/.test(workbook) ? workbook.replace(/<bookViews\b[^>]*>[\s\S]*?<\/bookViews>/, views) : workbook.replace('<sheets>', `${views}<sheets>`);
  // Protect Workbook: the structure lock sits just before the views, where the schema has it; no password is set.
  workbook = workbook.replace(/<workbookProtection\b[^>]*\/>/g, '');
  if (wb.structureProtected) workbook = workbook.replace(/<bookViews\b/, `${xmlTag('workbookProtection', { lockStructure: 1 })}<bookViews`);
  // Edit Links ▸ Startup Prompt: workbookPr's updateLinks says whether opening the book asks about its links (the
  // default, written as nothing), updates them, or leaves them; the element comes before the protection and the views.
  workbook = workbook.replace(/(<workbookPr\b[^>]*?)\s+updateLinks="[^"]*"/, '$1');
  const updateLinks = wb.linkStartup === 'update' ? 'always' : wb.linkStartup === 'none' ? 'never' : null;
  if (updateLinks) {
    workbook = /<workbookPr\b/.test(workbook)
      ? workbook.replace(/<workbookPr\b/, `<workbookPr updateLinks="${updateLinks}"`)
      : workbook.replace(/<(workbookProtection|bookViews)\b/, (m) => `${xmlTag('workbookPr', { updateLinks })}${m}`);
  }
  if (wb.iteration || wb.calcMode === 'manual') {
    const calc = xmlTag('calcPr', { calcMode: wb.calcMode === 'manual' ? 'manual' : null, ...(wb.iteration ? { iterate: 1, iterateCount: wb.iteration.iterateCount, iterateDelta: wb.iteration.iterateDelta } : {}) });
    workbook = /<calcPr\b/.test(workbook) ? workbook.replace(/<calcPr\b[^>]*\/>/, calc) : workbook.replace('</workbook>', `${calc}</workbook>`);
  }
  const compatibility = wb.calculationCompatibility;
  const extension = xmlTag('ext', { uri: COMPATIBILITY_EXTENSION, 'xmlns:xlwcv': COMPATIBILITY_NAMESPACE },
    xmlTag('xlwcv:version', { setVersion: compatibility.version, warnBelowVersion: compatibility.warnBelowVersion }));
  workbook = workbook.includes('</extLst>') ? workbook.replace('</extLst>', `${extension}</extLst>`)
    : workbook.replace('</workbook>', `${xmlTag('extLst', {}, extension)}</workbook>`);
  if (wb.dataModel) workbook = (await import('./xlsx-data-model.js')).writeXlsxDataModel(wb.dataModel, workbook,
    { get, set, binary: (path, data) => X.CFB.utils.cfb_add(zip, path, data), contentType });
  if (wb.nativePivots) workbook = (await import('./xlsx-pivots.js')).writeXlsxPivots(wb, workbook, { get, set, contentType, styles, pivotRulePriorities });
  if (wb.externalWorkbooks) workbook = writeXlsxExternalWorkbooks(rebaseExternalWorkbooks(wb.externalWorkbooks, sourceWorkbook), workbook, { get, set, contentType });
  workbook = writeXlsxWorkbookCustomViews(workbook, wb.customViews || [], wb);
  set('/xl/workbook.xml', workbook);
  set('/xl/styles.xml', styles.xml());
  if (book.PuterExportMeta && conditionalRecords.size) {
    const theme = effectiveColorPalette(wb.colorPalette).theme;
    const nativeStyles = readXlsxStyles({ files: { 'xl/styles.xml': { content: encoder.encode(styles.xml()) } },
      Themes: { themeElements: { clrScheme: theme.map(rgb => ({ rgb: rgb.slice(1) })) } } });
    for (const [name, { xml, entries }] of conditionalRecords) {
      const names = new Set(wb.names.filter(n => !n.sheet || n.sheet === name).map(n => n.name.toUpperCase()));
      const rules = readXlsxConditionalFormats(xml, nativeStyles, nativeStyles.colors, names, { priorities: true });
      const byPriority = new Map();
      for (const { priority, ...rule } of rules) {
        if (!byPriority.has(priority)) byPriority.set(priority, []);
        byPriority.get(priority).push(await conditionalFormatSignature(rule));
      }
      const baseline = entries.map(({ priorities, ...entry }) => ({ ...entry,
        signatures: priorities.flatMap(priority => byPriority.get(priority) || []) }));
      // Do not treat a native projection the reader cannot understand as a
      // deleted app rule. Such records remain privately owned until supported.
      book.PuterExportMeta.data.sheets[name].nativeConditionalFormats = { version: 3, entries: baseline.filter(entry => entry.signatures.length) };
    }
  }
  writeXlsxSlicers(wb, slicers, { get, set, contentType });
  writeXlsxScripts(wb, { get, set, contentType });
  richValues.finish();
  set('/[Content_Types].xml', types);
  if (drawingRecords.size) await updateDrawingMetadata(X, zip, book, wb, drawingRecords, { get, set, groups: groupRecords });
  if (book.PuterExportMeta) {
    book.PuterExportMeta.data.nativeFillBaseline = styles.fillBaseline();
    writeExportMetadata(X, book, { get, set });
  }
  return X.CFB.write(zip, { type: 'array', fileType: 'zip', compression: true });
}
