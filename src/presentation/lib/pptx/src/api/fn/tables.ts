import type { TextFieldPlacement } from "../../internal/drawingml/text-body-mutation.ts";
export type { TextFieldPlacement } from "../../internal/drawingml/text-body-mutation.ts";
// Table cell access.

import { resolveChartPartName } from "./charts.ts";
import {
  applyAlignmentToAllParagraphs,
  applyFormatToAllRuns,
  buildColorElement,
  clearFill as clearFillImpl,
  setSolidFill,
  setTextBody,
  type TextFormat,
  type ParagraphAlignment,
} from "../../internal/drawingml/index.ts";
import type { Emu } from "../units.ts";
import {
  buildTableCell,
  buildTableRow,
} from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  allChildElements,
  attr,
  elem,
  firstChildElement,
  getAttrValue,
  insertChildByRank,
  qname,
  text,
} from "../../internal/xml/index.ts";
import {
  CELL_COL,
  CELL_ELEMENT,
  CELL_ROW,
  CELL_TABLE,
  type PresentationData,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_SHAPES,
  type SlideData,
  type SlideShapeData,
  type TableCellData,
} from "../_internal-symbols.ts";
import {
  emuCoordinate32,
  emuExtent,
  lineWidthEmu,
  normalizeGuid,
} from "../../internal/bounds.ts";
import { commitSlideData, refreshSlideData } from "./_helpers.ts";
import {
  type ShapeParagraphElement,
  readParagraphElements,
} from "./shape-runs.ts";
import {
  ALIGN_TOKEN_MAP,
  parsePPrLikeElement,
  type ParagraphProperties,
} from "./shape-paragraph.ts";
import { resolveShapeColor } from "./shape-color-context.ts";
import { getSlides } from "./slide-query.ts";

// ---------------------------------------------------------------------------
// Table cell access.
//
// `addSlideTable` builds the cell tree under `<a:graphic>/<a:graphicData>/
// <a:tbl>`. These helpers let callers reach individual `<a:tc>` cells to
// re-fill text, paint backgrounds, or align contents without rebuilding
// the table.

export type { TableCellData };

const NAME_A_GRAPHIC_TBL = qname("a", "graphic", NS.dml);
const NAME_A_GRAPHIC_DATA_TBL = qname("a", "graphicData", NS.dml);
const NAME_A_TBL = qname("a", "tbl", NS.dml);
const NAME_A_TC_PR = qname("a", "tcPr", NS.dml);
const NAME_A_TX_BODY_TBL = qname("a", "txBody", NS.dml);

const findTblElement = (shape: SlideShapeData): XmlElement | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "graphicFrame") return null;
  const graphic = firstChildElement(shape[SHAPE_ELEMENT], NAME_A_GRAPHIC_TBL);
  if (!graphic) return null;
  const graphicData = firstChildElement(graphic, NAME_A_GRAPHIC_DATA_TBL);
  if (!graphicData) return null;
  return firstChildElement(graphicData, NAME_A_TBL);
};

/**
 * `true` when the shape is a `<p:graphicFrame>` wrapping `<a:tbl>` —
 * i.e. a table. Sharper than `getShapeKind(shape) === 'graphicFrame'`,
 * which also matches charts and SmartArt frames.
 */
export const isTableShape = (shape: SlideShapeData): boolean =>
  findTblElement(shape) !== null;

/**
 * Returns every table graphic-frame shape on the slide, in document
 * order. Convenience over `getSlideShapes(slide).filter(isTableShape)`
 * — pairs `getSlideCharts(slide)` for cases where the caller wants
 * just the tables.
 */
export const getSlideTables = (
  slide: SlideData,
): ReadonlyArray<SlideShapeData> => {
  const out: SlideShapeData[] = [];
  for (const shape of slide[SLIDE_SHAPES]) {
    if (isTableShape(shape)) out.push(shape);
  }
  return out;
};

/**
 * Dense per-slide table count array. Counts `isTableShape` matches per
 * slide. Rounds out the density-array family alongside the chart,
 * shape, text, and comment counters.
 */
export const getPresentationTableCountsBySlide = (
  pres: PresentationData,
): ReadonlyArray<number> =>
  getSlides(pres).map((s) => getSlideTables(s).length);

/**
 * `true` when the shape is a `<p:graphicFrame>` wrapping a chart
 * reference (`<c:chart>`). Charts, tables, and SmartArt all share
 * the graphic-frame kind; this predicate filters down to charts only.
 */
export const isChartShape = (shape: SlideShapeData): boolean =>
  resolveChartPartName(shape[SHAPE_SLIDE], shape) !== null;

const NAME_A_GRID_COL = qname("a", "gridCol", NS.dml);
const ATTR_W_TBL = qname("", "w", "");
const ATTR_H_TBL = qname("", "h", "");

const tableRows = (tbl: XmlElement): XmlElement[] =>
  tbl.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "tr",
  );

const rowCells = (tr: XmlElement): XmlElement[] =>
  tr.children.filter(
    (c): c is XmlElement =>
      c.kind === "element" &&
      c.name.namespaceURI === NS.dml &&
      c.name.localName === "tc",
  );

const buildCellHandle = (
  table: SlideShapeData,
  tc: XmlElement,
  row: number,
  col: number,
): TableCellData => ({
  [CELL_TABLE]: table,
  [CELL_ELEMENT]: tc,
  [CELL_ROW]: row,
  [CELL_COL]: col,
});

/**
 * Returns a 2D array of cell handles for the given table shape, in
 * row-major order. Throws if the shape isn't a table graphic frame.
 */
export const getTableCells = (
  table: SlideShapeData,
): ReadonlyArray<ReadonlyArray<TableCellData>> => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("getTableCells: shape is not a table graphic frame");
  const rows = tableRows(tbl);
  return rows.map((tr, rowIdx) =>
    rowCells(tr).map((tc, colIdx) =>
      buildCellHandle(table, tc, rowIdx, colIdx),
    ),
  );
};

/**
 * Reads the table-style GUID from `<a:tbl><a:tblPr><a:tableStyleId>`.
 * Decks use GUIDs to reference built-in table styles
 * (`{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}` = "Medium Style 2 -
 * Accent 1", etc.) and theme-local styles. Returns `null` when the
 * table doesn't reference one (it may have an inline style or no style).
 */
export const getTableStyleId = (table: SlideShapeData): string | null => {
  const tbl = findTblElement(table);
  if (!tbl) return null;
  const tblPr = firstChildElement(tbl, qname("a", "tblPr", NS.dml));
  if (!tblPr) return null;
  const idEl = firstChildElement(tblPr, qname("a", "tableStyleId", NS.dml));
  if (!idEl) return null;
  let acc = "";
  for (const c of idEl.children) {
    if (c.kind === "text" || c.kind === "cdata") acc += c.data;
  }
  return acc.trim() || null;
};

/**
 * Writes `<a:tbl><a:tblPr><a:tableStyleId>` to the given GUID. Pass
 * `null` to remove the style. Replaces any inline style as well, since
 * CT_TableProperties permits only one style choice. The GUID must include
 * its curly braces — e.g.
 * `'{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}'` ("Medium
 * Style 2 - Accent 1"). Creates `<a:tblPr>` if absent. Throws when the
 * shape isn't a table graphic frame.
 */
export const setTableStyleId = (
  table: SlideShapeData,
  styleId: string | null,
): void => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("setTableStyleId: shape is not a table graphic frame");
  // Validate before changing either style representation.
  const guid =
    styleId === null
      ? null
      : normalizeGuid(styleId, "setTableStyleId: styleId");
  const tblPr = ensureTblPr(tbl);
  // tableStyleId is the LAST child of <a:tblPr> per CT_TableProperties.
  tblPr.children = tblPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        (c.name.localName === "tableStyleId" ||
          c.name.localName === "tableStyle")
      ),
  );
  if (guid !== null) {
    tblPr.children.push(
      elem(qname("a", "tableStyleId", NS.dml), { children: [text(guid)] }),
    );
  }
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * Reads the boolean style flags off `<a:tblPr>` — which header /
 * footer rows + columns are banded or emphasised. Mirrors the
 * `firstRow` / `bandRow` flags exposed by `addSlideTable`.
 *
 * Per ECMA-376 §17.18.95 / §21.1.3.15:
 *
 *   - `firstRow` — header row is styled differently.
 *   - `lastRow` — total row is styled differently.
 *   - `firstCol` — first column is styled differently.
 *   - `lastCol` — last column is styled differently.
 *   - `bandRow` — alternating row shading.
 *   - `bandCol` — alternating column shading.
 *
 * Renderers use these to switch on the corresponding table style
 * variant. Returns all-`false` for tables that don't author `<a:tblPr>`.
 */
export const getTableStyleFlags = (
  table: SlideShapeData,
): {
  firstRow: boolean;
  lastRow: boolean;
  firstCol: boolean;
  lastCol: boolean;
  bandRow: boolean;
  bandCol: boolean;
} => {
  const empty = {
    firstRow: false,
    lastRow: false,
    firstCol: false,
    lastCol: false,
    bandRow: false,
    bandCol: false,
  };
  const tbl = findTblElement(table);
  if (!tbl) return empty;
  const tblPr = firstChildElement(tbl, qname("a", "tblPr", NS.dml));
  if (!tblPr) return empty;
  const readBool = (attr: string): boolean => {
    const v = getAttrValue(tblPr, qname("", attr, ""));
    return v === "1" || v === "true";
  };
  return {
    firstRow: readBool("firstRow"),
    lastRow: readBool("lastRow"),
    firstCol: readBool("firstCol"),
    lastCol: readBool("lastCol"),
    bandRow: readBool("bandRow"),
    bandCol: readBool("bandCol"),
  };
};

const ensureTblPr = (tbl: XmlElement): XmlElement => {
  let tblPr = firstChildElement(tbl, qname("a", "tblPr", NS.dml));
  if (tblPr === null) {
    tblPr = elem(qname("a", "tblPr", NS.dml));
    // <a:tblPr> is the FIRST child of <a:tbl> per the schema.
    tbl.children.unshift(tblPr);
  }
  return tblPr;
};

const TABLE_STYLE_FLAG_KEYS = [
  "firstRow",
  "lastRow",
  "firstCol",
  "lastCol",
  "bandRow",
  "bandCol",
] as const;

/**
 * Sets one or more boolean style flags on `<a:tblPr>`. Only the keys
 * present in `flags` are touched — omitted keys are left at their
 * current state. A flag set to `false` strips the attribute (rather
 * than emitting `="0"`), so defaults round-trip as omitted attributes.
 *
 * See `getTableStyleFlags` for the meaning of each flag.
 */
export const setTableStyleFlags = (
  table: SlideShapeData,
  flags: {
    firstRow?: boolean;
    lastRow?: boolean;
    firstCol?: boolean;
    lastCol?: boolean;
    bandRow?: boolean;
    bandCol?: boolean;
  },
): void => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("setTableStyleFlags: shape is not a table graphic frame");
  const tblPr = ensureTblPr(tbl);
  for (const key of TABLE_STYLE_FLAG_KEYS) {
    const v = flags[key];
    if (v === undefined) continue;
    tblPr.attrs = tblPr.attrs.filter(
      (a) => !(a.name.namespaceURI === "" && a.name.localName === key),
    );
    if (v) tblPr.attrs.push(attr(qname("", key, ""), "1"));
  }
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * Returns the table's row + column counts. Throws when the shape
 * isn't a table graphic frame.
 */
export const getTableDimensions = (
  table: SlideShapeData,
): { readonly rows: number; readonly cols: number } => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("getTableDimensions: shape is not a table graphic frame");
  const rows = tableRows(tbl);
  const cols = rows[0] !== undefined ? rowCells(rows[0]).length : 0;
  return { rows: rows.length, cols };
};

/**
 * Returns each column's width in EMU, in left-to-right order, as
 * declared on `<a:tblGrid>/<a:gridCol w="...">`. Missing or
 * unparseable widths default to 0. Throws when the shape isn't a
 * table graphic frame.
 */
export const getTableColumnWidths = (
  table: SlideShapeData,
): ReadonlyArray<Emu> => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("getTableColumnWidths: shape is not a table graphic frame");
  const grid = firstChildElement(tbl, qname("a", "tblGrid", NS.dml));
  if (!grid) return [];
  const out: Emu[] = [];
  for (const col of allChildElements(grid, NAME_A_GRID_COL)) {
    const v = getAttrValue(col, ATTR_W_TBL);
    const n = v !== null ? Number.parseInt(v, 10) : 0;
    out.push((Number.isFinite(n) ? n : 0) as Emu);
  }
  return out;
};

/**
 * Returns the table's nominal `(width, height)` derived from
 * summing the `<a:gridCol w>` and `<a:tr h>` attributes (both in
 * EMU). Useful for layout pipelines that want to know how big a
 * table really is without dereferencing the shape's `<a:xfrm>`.
 *
 * Throws when the shape isn't a table graphic frame.
 */
export const getTableSize = (
  table: SlideShapeData,
): { readonly width: Emu; readonly height: Emu } => {
  const widths = getTableColumnWidths(table);
  const heights = getTableRowHeights(table);
  const width = widths.reduce((sum, w) => sum + w, 0) as Emu;
  const height = heights.reduce((sum, h) => sum + h, 0) as Emu;
  return { width, height };
};

/**
 * Returns each row's height in EMU, in top-to-bottom order, from
 * `<a:tr h="...">`. Missing or unparseable heights default to 0.
 * Throws when the shape isn't a table graphic frame.
 */
export const getTableRowHeights = (
  table: SlideShapeData,
): ReadonlyArray<Emu> => {
  const tbl = findTblElement(table);
  if (!tbl)
    throw new Error("getTableRowHeights: shape is not a table graphic frame");
  const out: Emu[] = [];
  for (const tr of tableRows(tbl)) {
    const v = getAttrValue(tr, ATTR_H_TBL);
    const n = v !== null ? Number.parseInt(v, 10) : 0;
    out.push((Number.isFinite(n) ? n : 0) as Emu);
  }
  return out;
};

/**
 * Sets a single column's width on the table grid. Throws on
 * out-of-range column indices or non-table shapes. The total table
 * graphic-frame extent is not auto-adjusted. Readers and resolved
 * shape bounds use the grid's extent; the raw frame remains available
 * through `getShapeBounds` for lossless editing.
 */
export const setTableColumnWidth = (
  table: SlideShapeData,
  col: number,
  width: Emu,
): void => {
  const tbl = requireTbl(table);
  const grid = firstChildElement(tbl, qname("a", "tblGrid", NS.dml));
  if (!grid) throw new Error("table has no <a:tblGrid>");
  const cols = allChildElements(grid, NAME_A_GRID_COL);
  const target = cols[col];
  if (!target)
    throw new RangeError(
      `table column ${col} out of range (have ${cols.length})`,
    );
  target.attrs = target.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "w"),
  );
  target.attrs.push(
    attr(ATTR_W_TBL, String(emuExtent(width, "setTableColumnWidth: width"))),
  );
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * Sets a single row's height. Throws on out-of-range row indices or
 * non-table shapes. As with `setTableColumnWidth`, the table's
 * `<a:xfrm>` extent is left to the caller.
 */
export const setTableRowHeight = (
  table: SlideShapeData,
  row: number,
  height: Emu,
): void => {
  const tbl = requireTbl(table);
  const rows = tableRows(tbl);
  const target = rows[row];
  if (!target)
    throw new RangeError(`table row ${row} out of range (have ${rows.length})`);
  target.attrs = target.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "h"),
  );
  target.attrs.push(
    attr(ATTR_H_TBL, String(emuExtent(height, "setTableRowHeight: height"))),
  );
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * Returns the cell at `(row, col)`. Throws on out-of-range coordinates
 * or non-table shapes.
 */
export const getTableCell = (
  table: SlideShapeData,
  row: number,
  col: number,
): TableCellData => {
  const cells = getTableCells(table);
  const r = cells[row];
  if (!r)
    throw new RangeError(
      `table row ${row} out of range (have ${cells.length})`,
    );
  const c = r[col];
  if (!c)
    throw new RangeError(
      `table column ${col} out of range in row ${row} (have ${r.length})`,
    );
  return c;
};

const commitTableCell = (cell: TableCellData): void => {
  const shape = cell[CELL_TABLE];
  commitSlideData(shape[SHAPE_SLIDE]);
  refreshSlideData(shape[SHAPE_SLIDE]);
};

const ensureCellTxBody = (cell: TableCellData): XmlElement => {
  const tc = cell[CELL_ELEMENT];
  let txBody = firstChildElement(tc, NAME_A_TX_BODY_TBL);
  if (txBody === null) {
    txBody = elem(NAME_A_TX_BODY_TBL);
    // bodyPr lstStyle a:p — keep the canonical ordering.
    txBody.children.push(elem(qname("a", "bodyPr", NS.dml)));
    txBody.children.push(elem(qname("a", "lstStyle", NS.dml)));
    // Insert before <a:tcPr> per the schema.
    const tcPrIdx = tc.children.findIndex(
      (c) =>
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === "tcPr",
    );
    if (tcPrIdx >= 0) tc.children.splice(tcPrIdx, 0, txBody);
    else tc.children.push(txBody);
  }
  return txBody;
};

const ensureCellTcPr = (cell: TableCellData): XmlElement => {
  const tc = cell[CELL_ELEMENT];
  let tcPr = firstChildElement(tc, NAME_A_TC_PR);
  if (tcPr === null) {
    tcPr = elem(NAME_A_TC_PR);
    // <a:tcPr> is the LAST child of <a:tc>.
    tc.children.push(tcPr);
  }
  return tcPr;
};

/** Replaces a cell's text. `\n` starts a new paragraph. Optional `fields`
 * retain existing field elements at their new UTF-16 ranges in `text`; their
 * source indices refer to this cell before replacement. The remaining text
 * keeps the ordinary first-run formatting behavior. */
export const setTableCellText = (
  cell: TableCellData,
  text: string,
  options: { fields?: readonly TextFieldPlacement[] } = {},
): void => {
  const txBody = ensureCellTxBody(cell);
  setTextBody(txBody, text, options.fields);
  commitTableCell(cell);
};

/**
 * Reads the cell's merge / span attributes:
 *
 *   - `gridSpan` — number of columns this cell spans (≥1, default 1).
 *   - `rowSpan` — number of rows this cell spans (≥1, default 1).
 *   - `hMerge` — `true` when this cell is the right half of a horizontal
 *     span (it's painted by an earlier cell with `gridSpan > 1`).
 *   - `vMerge` — `true` when this cell is the bottom half of a vertical
 *     span (it's painted by an earlier cell with `rowSpan > 1`).
 *
 * Renderers should skip painting cells where `hMerge` or `vMerge` is
 * true; those cells exist only so the row/column grid stays consistent.
 */
export const getTableCellSpan = (
  cell: TableCellData,
): { gridSpan: number; rowSpan: number; hMerge: boolean; vMerge: boolean } => {
  const el = cell[CELL_ELEMENT];
  const gs = getAttrValue(el, qname("", "gridSpan", ""));
  const rs = getAttrValue(el, qname("", "rowSpan", ""));
  const hm = getAttrValue(el, qname("", "hMerge", ""));
  const vm = getAttrValue(el, qname("", "vMerge", ""));
  const parseSpan = (v: string | null): number => {
    if (v === null) return 1;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  return {
    gridSpan: parseSpan(gs),
    rowSpan: parseSpan(rs),
    hMerge: hm === "1" || hm === "true",
    vMerge: vm === "1" || vm === "true",
  };
};

const ATTR_GRID_SPAN = qname("", "gridSpan", "");
const ATTR_ROW_SPAN = qname("", "rowSpan", "");
const ATTR_H_MERGE = qname("", "hMerge", "");
const ATTR_V_MERGE = qname("", "vMerge", "");

const setSpanAttr = (
  tc: XmlElement,
  name: ReturnType<typeof qname>,
  value: string,
): void => {
  tc.attrs = tc.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === name.localName),
  );
  tc.attrs.push(attr(name, value));
};

/** A cell already carries a merge marker / multi-cell span. */
const cellIsMergedAlready = (tc: XmlElement): boolean => {
  const gs = getAttrValue(tc, ATTR_GRID_SPAN);
  const rs = getAttrValue(tc, ATTR_ROW_SPAN);
  const hm = getAttrValue(tc, ATTR_H_MERGE);
  const vm = getAttrValue(tc, ATTR_V_MERGE);
  return (
    (gs !== null && Number.parseInt(gs, 10) > 1) ||
    (rs !== null && Number.parseInt(rs, 10) > 1) ||
    hm === "1" ||
    hm === "true" ||
    vm === "1" ||
    vm === "true"
  );
};

/**
 * Merges a rectangular block of table cells into a single visual cell.
 *
 * The block's top-left cell `(row, col)` becomes the anchor and carries
 * `gridSpan` (= `colSpan`) / `rowSpan`; the cells it covers are marked
 * `hMerge` / `vMerge` per ECMA-376 §21.1.3.18 (`CT_TableCell`) so the
 * grid stays rectangular while only the anchor is painted. This
 * is the write counterpart to {@link getTableCellSpan}.
 *
 * Constraints, enforced loudly (these are authoring-boundary inputs):
 *
 *   - `rowSpan` / `colSpan` must be ≥ 1, and at least one must be > 1
 *     (a 1×1 "merge" is a no-op the caller didn't mean).
 *   - The block must lie fully inside the table grid.
 *   - No cell in the block may already participate in another merge —
 *     overlapping merges corrupt the grid and trip a reader's repair
 *     prompt. Split the existing merge first.
 *
 * The anchor cell's text is preserved; covered cells keep their own
 * `<a:txBody>` in the XML (renderers ignore it while the merge marker
 * is set) so the operation stays losslessly reversible.
 */
export const mergeTableCells = (
  table: SlideShapeData,
  block: {
    readonly row: number;
    readonly col: number;
    readonly rowSpan: number;
    readonly colSpan: number;
  },
): void => {
  const { row, col, rowSpan, colSpan } = block;
  if (
    !Number.isInteger(rowSpan) ||
    !Number.isInteger(colSpan) ||
    rowSpan < 1 ||
    colSpan < 1
  ) {
    throw new RangeError(
      `mergeTableCells: rowSpan / colSpan must be integers ≥ 1 (got ${rowSpan} × ${colSpan})`,
    );
  }
  if (rowSpan === 1 && colSpan === 1) {
    throw new RangeError("mergeTableCells: a 1×1 block is not a merge");
  }
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) {
    throw new RangeError(
      `mergeTableCells: row / col must be non-negative integers (got ${row}, ${col})`,
    );
  }

  const cells = getTableCells(table);
  const lastRow = row + rowSpan - 1;
  const lastCol = col + colSpan - 1;
  if (lastRow >= cells.length) {
    throw new RangeError(
      `mergeTableCells: block rows ${row}..${lastRow} exceed table height ${cells.length}`,
    );
  }
  for (let r = row; r <= lastRow; r++) {
    const rowCellsArr = cells[r]!;
    if (lastCol >= rowCellsArr.length) {
      throw new RangeError(
        `mergeTableCells: block cols ${col}..${lastCol} exceed row ${r} width ${rowCellsArr.length}`,
      );
    }
  }

  // Reject overlaps with any pre-existing merge before mutating anything,
  // so a rejected call leaves the table untouched.
  for (let r = row; r <= lastRow; r++) {
    for (let c = col; c <= lastCol; c++) {
      if (cellIsMergedAlready(cells[r]![c]![CELL_ELEMENT])) {
        throw new Error(
          `mergeTableCells: cell (${r}, ${c}) is already part of a merge; split it before re-merging`,
        );
      }
    }
  }

  for (let r = row; r <= lastRow; r++) {
    for (let c = col; c <= lastCol; c++) {
      const tc = cells[r]![c]![CELL_ELEMENT];
      if (r === row && c === col) {
        if (colSpan > 1) setSpanAttr(tc, ATTR_GRID_SPAN, String(colSpan));
        if (rowSpan > 1) setSpanAttr(tc, ATTR_ROW_SPAN, String(rowSpan));
        continue;
      }
      // Covered cells: a column offset from the anchor sets hMerge; a row
      // offset sets vMerge. The bottom-right block carries both.
      if (c > col) setSpanAttr(tc, ATTR_H_MERGE, "1");
      if (r > row) setSpanAttr(tc, ATTR_V_MERGE, "1");
    }
  }

  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * One side of a cell's border, as read from `<a:tcPr><a:ln{L|R|T|B}>`.
 * `widthEmu` is the line width in EMU; `color` is `#RRGGBB` or `null`
 * when the border has no solid color, including explicitly hidden borders.
 */
export interface TableCellBorder {
  // Read contract: `getTableCellBorders` always populates all three (each is the
  // concrete value or `null` when un-styled). The setter takes a `Partial` of
  // this (see `setTableCellBorders`), so authoring `{ color, widthEmu }` without
  // `dash` is allowed without widening what reads return.
  readonly color: string | null;
  readonly widthEmu: number | null;
  readonly dash: string | null;
  /** Explicit `<a:noFill/>`: suppress this border instead of inheriting it.
   * Omitted on other borders; width and dash can still be authored when hidden. */
  readonly noFill?: boolean;
}

export interface TableCellBorders {
  readonly left: TableCellBorder | null;
  readonly right: TableCellBorder | null;
  readonly top: TableCellBorder | null;
  readonly bottom: TableCellBorder | null;
  readonly tlToBr: TableCellBorder | null;
  readonly blToTr: TableCellBorder | null;
}

/**
 * Reads the per-side borders on a cell. Returns `null` for sides with
 * no explicit `<a:ln{Side}>` element (those inherit from the table
 * style / theme). All four cardinal sides plus the two diagonals
 * (TL→BR, BL→TR) are surfaced because real templates use them all.
 */
export const getTableCellBorders = (
  pres: PresentationData,
  cell: TableCellData,
  colorMap?: Readonly<Record<string, string>> | null,
): TableCellBorders => {
  const tcPr = firstChildElement(cell[CELL_ELEMENT], NAME_A_TC_PR);
  const empty: TableCellBorders = {
    left: null,
    right: null,
    top: null,
    bottom: null,
    tlToBr: null,
    blToTr: null,
  };
  if (!tcPr) return empty;
  const readLn = (local: string): TableCellBorder | null => {
    const ln = firstChildElement(tcPr, qname("a", local, NS.dml));
    if (!ln) return null;
    const w = getAttrValue(ln, qname("", "w", ""));
    const widthEmu = w !== null ? Number.parseInt(w, 10) : null;
    const noFill = firstChildElement(ln, qname("a", "noFill", NS.dml)) !== null;
    let color: string | null = null;
    const solid = firstChildElement(ln, qname("a", "solidFill", NS.dml));
    if (solid && !noFill) {
      for (const c of solid.children) {
        if (c.kind !== "element" || c.name.namespaceURI !== NS.dml) continue;
        color = resolveShapeColor(pres, cell[CELL_TABLE], c, colorMap);
        break;
      }
    }
    const prstDash = firstChildElement(ln, qname("a", "prstDash", NS.dml));
    const dash = prstDash ? getAttrValue(prstDash, qname("", "val", "")) : null;
    return { color, widthEmu, dash, ...(noFill ? { noFill: true } : {}) };
  };
  return {
    left: readLn("lnL"),
    right: readLn("lnR"),
    top: readLn("lnT"),
    bottom: readLn("lnB"),
    tlToBr: readLn("lnTlToBr"),
    blToTr: readLn("lnBlToTr"),
  };
};

const BORDER_SIDE_LOCALS = {
  left: "lnL",
  right: "lnR",
  top: "lnT",
  bottom: "lnB",
  tlToBr: "lnTlToBr",
  blToTr: "lnBlToTr",
} as const;

// CT_TableCellProperties (a:tcPr) is an xsd:sequence: the six border lines
// (lnL/lnR/lnT/lnB/lnTlToBr/lnBlToTr), then cell3D, then the fill choice, then
// headers, then extLst. Border setters must drop their element at the mandated
// slot, or styling a cell's fill before its borders emits invalid order.
const TCPR_CHILD_RANK: Record<string, number> = {
  lnL: 0,
  lnR: 1,
  lnT: 2,
  lnB: 3,
  lnTlToBr: 4,
  lnBlToTr: 5,
  cell3D: 6,
  noFill: 7,
  solidFill: 7,
  gradFill: 7,
  blipFill: 7,
  pattFill: 7,
  grpFill: 7,
  headers: 8,
  extLst: 9,
};
const tcPrChildRank = (el: XmlElement): number =>
  el.name.namespaceURI === NS.dml
    ? (TCPR_CHILD_RANK[el.name.localName] ?? 99)
    : 99;

const writeBorderLn = (
  tcPr: XmlElement,
  local: "lnL" | "lnR" | "lnT" | "lnB" | "lnTlToBr" | "lnBlToTr",
  border: Partial<TableCellBorder> | null,
): void => {
  // Strip any prior side first.
  tcPr.children = tcPr.children.filter(
    (c) =>
      !(
        c.kind === "element" &&
        c.name.namespaceURI === NS.dml &&
        c.name.localName === local
      ),
  );
  if (border === null) return;
  const lnAttrs = [];
  if (border.widthEmu !== null && border.widthEmu !== undefined) {
    const w = lineWidthEmu(border.widthEmu, "setTableCellBorders: widthEmu");
    lnAttrs.push(attr(qname("", "w", ""), String(w)));
  }
  const children: XmlElement[] = [];
  if (border.noFill) {
    children.push(elem(qname("a", "noFill", NS.dml)));
  } else if (border.color !== null && border.color !== undefined) {
    children.push(
      elem(qname("a", "solidFill", NS.dml), {
        children: [buildColorElement(border.color)],
      }),
    );
  }
  if (border.dash !== null && border.dash !== undefined) {
    children.push(
      elem(qname("a", "prstDash", NS.dml), {
        attrs: [attr(qname("", "val", ""), border.dash)],
      }),
    );
  }
  insertChildByRank(
    tcPr,
    elem(qname("a", local, NS.dml), { attrs: lnAttrs, children }),
    tcPrChildRank,
  );
};

/**
 * Sets one or more side borders on a cell. Sides listed with `null` are
 * removed from the `<a:tcPr>`; sides omitted from the partial are left
 * untouched. Pass the whole `sides` arg as `null` to clear every side
 * in one call. Creates `<a:tcPr>` if absent.
 * Use `{ noFill: true }` to explicitly hide a side; unlike `null`, this
 * suppresses inherited borders. `noFill` takes precedence over `color`.
 *
 * The diagonal sides (`tlToBr` / `blToTr`) are independent of the
 * cardinal four — a strikethrough cell can have only a diagonal.
 */
export const setTableCellBorders = (
  cell: TableCellData,
  sides: {
    left?: Partial<TableCellBorder> | null;
    right?: Partial<TableCellBorder> | null;
    top?: Partial<TableCellBorder> | null;
    bottom?: Partial<TableCellBorder> | null;
    tlToBr?: Partial<TableCellBorder> | null;
    blToTr?: Partial<TableCellBorder> | null;
  } | null,
): void => {
  const tcPr = ensureCellTcPr(cell);
  if (sides === null) {
    for (const local of Object.values(BORDER_SIDE_LOCALS))
      writeBorderLn(tcPr, local, null);
  } else {
    for (const [key, local] of Object.entries(
      BORDER_SIDE_LOCALS,
    ) as ReadonlyArray<
      [
        keyof typeof BORDER_SIDE_LOCALS,
        (typeof BORDER_SIDE_LOCALS)[keyof typeof BORDER_SIDE_LOCALS],
      ]
    >) {
      const v = sides[key];
      if (v === undefined) continue;
      writeBorderLn(tcPr, local, v);
    }
  }
  commitTableCell(cell);
};

/**
 * Reads the cell's text direction (`<a:tcPr vert="…"/>`) — same tokens
 * as `getShapeTextDirection`. Returns `null` for the default
 * horizontal direction.
 *
 * Vertical column headers in tables almost always emit `<a:tcPr
 * vert="vert270"/>` or `"eaVert"` so the header label reads bottom-to-
 * top alongside its column.
 */
export const getTableCellTextDirection = (
  cell: TableCellData,
):
  | "vert"
  | "vert270"
  | "wordArtVert"
  | "eaVert"
  | "mongolianVert"
  | "wordArtVertRtl"
  | null => {
  const tcPr = firstChildElement(cell[CELL_ELEMENT], NAME_A_TC_PR);
  if (!tcPr) return null;
  const v = getAttrValue(tcPr, qname("", "vert", ""));
  if (
    v === "vert" ||
    v === "vert270" ||
    v === "wordArtVert" ||
    v === "eaVert" ||
    v === "mongolianVert" ||
    v === "wordArtVertRtl"
  )
    return v;
  return null;
};

/**
 * Sets the cell's text-direction via `<a:tcPr vert="…"/>`. Same six
 * `ST_TextVerticalType` values as `setShapeTextDirection`. Passing
 * `null` (or `'horz'`) clears the attribute so the cell uses the
 * default horizontal direction. Creates `<a:tcPr>` if absent.
 */
export const setTableCellTextDirection = (
  cell: TableCellData,
  direction:
    | "horz"
    | "vert"
    | "vert270"
    | "wordArtVert"
    | "eaVert"
    | "mongolianVert"
    | "wordArtVertRtl"
    | null,
): void => {
  const tcPr = ensureCellTcPr(cell);
  tcPr.attrs = tcPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "vert"),
  );
  if (direction !== null && direction !== "horz") {
    tcPr.attrs.push(attr(qname("", "vert", ""), direction));
  }
  commitTableCell(cell);
};

/**
 * Reads the cell's vertical text anchor (`<a:tcPr anchor="t|ctr|b"/>`)
 * — `'top'`, `'center'`, `'bottom'`, or `null` for the default
 * (`ctr` / center per the schema).
 */
export const getTableCellAnchor = (
  cell: TableCellData,
): "top" | "center" | "bottom" | null => {
  const tcPr = firstChildElement(cell[CELL_ELEMENT], NAME_A_TC_PR);
  if (!tcPr) return null;
  const v = getAttrValue(tcPr, qname("", "anchor", ""));
  if (v === "t") return "top";
  if (v === "ctr") return "center";
  if (v === "b") return "bottom";
  return null;
};

/**
 * Sets the cell's vertical text anchor (`<a:tcPr anchor="t|ctr|b"/>`).
 * Pass `null` to clear the attribute so the cell uses the table's
 * default (`ctr`). Creates `<a:tcPr>` if absent.
 */
export const setTableCellAnchor = (
  cell: TableCellData,
  anchor: "top" | "center" | "bottom" | null,
): void => {
  const tcPr = ensureCellTcPr(cell);
  tcPr.attrs = tcPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && a.name.localName === "anchor"),
  );
  if (anchor !== null) {
    const mapped = anchor === "top" ? "t" : anchor === "center" ? "ctr" : "b";
    tcPr.attrs.push(attr(qname("", "anchor", ""), mapped));
  }
  commitTableCell(cell);
};

/**
 * Reads the cell's inset margins (`<a:tcPr marL marR marT marB>`) in
 * EMU. Each side is `null` when the cell doesn't author it (renderers
 * should fall back to the spec defaults — 91440 EMU / 0.1 inch
 * for the horizontal margins, 45720 EMU for the vertical).
 */
export const getTableCellMargins = (
  cell: TableCellData,
): {
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
} => {
  const tcPr = firstChildElement(cell[CELL_ELEMENT], NAME_A_TC_PR);
  const empty = { left: null, right: null, top: null, bottom: null };
  if (!tcPr) return empty;
  const read = (name: string): number | null => {
    const v = getAttrValue(tcPr, qname("", name, ""));
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    left: read("marL"),
    right: read("marR"),
    top: read("marT"),
    bottom: read("marB"),
  };
};

/**
 * Sets the cell's inset margins (`<a:tcPr marL marR marT marB>`) in
 * EMU. Sides set to `null` are stripped from the XML so they fall back
 * to the spec defaults. Creates `<a:tcPr>` if absent.
 *
 * Pass `null` for the whole `margins` arg to drop every authored side
 * at once.
 */
export const setTableCellMargins = (
  cell: TableCellData,
  margins: {
    left?: number | null;
    right?: number | null;
    top?: number | null;
    bottom?: number | null;
  } | null,
): void => {
  const tcPr = ensureCellTcPr(cell);
  const MAR_ATTRS = new Set(["marL", "marR", "marT", "marB"]);
  tcPr.attrs = tcPr.attrs.filter(
    (a) => !(a.name.namespaceURI === "" && MAR_ATTRS.has(a.name.localName)),
  );
  if (margins !== null) {
    const pairs: ReadonlyArray<
      ["marL" | "marR" | "marT" | "marB", number | null | undefined]
    > = [
      ["marL", margins.left],
      ["marR", margins.right],
      ["marT", margins.top],
      ["marB", margins.bottom],
    ];
    for (const [name, val] of pairs) {
      if (val !== null && val !== undefined) {
        const emu = emuCoordinate32(val, `setTableCellMargins: ${name}`);
        tcPr.attrs.push(attr(qname("", name, ""), String(emu)));
      }
    }
  }
  commitTableCell(cell);
};

/** Reads the cell's plain text (paragraphs joined with `\n`). */
export const getTableCellText = (cell: TableCellData): string => {
  const txBody = firstChildElement(cell[CELL_ELEMENT], NAME_A_TX_BODY_TBL);
  if (!txBody) return "";
  const lines: string[] = [];
  for (const p of txBody.children) {
    if (
      p.kind !== "element" ||
      p.name.namespaceURI !== NS.dml ||
      p.name.localName !== "p"
    )
      continue;
    let line = "";
    for (const r of p.children) {
      if (
        r.kind !== "element" ||
        r.name.namespaceURI !== NS.dml ||
        r.name.localName !== "r"
      )
        continue;
      const tEl = firstChildElement(r, qname("a", "t", NS.dml));
      if (!tEl) continue;
      for (const child of tEl.children) {
        if (child.kind === "text" || child.kind === "cdata") line += child.data;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
};

/** One paragraph of a cell's text, with its alignment and inline elements. */
export interface TableCellParagraph {
  /** Paragraph geometry and spacing, before table/list-style resolution. */
  readonly properties?: Readonly<Partial<ParagraphProperties>>;
  /** Effective paragraph font, including an empty paragraph's end properties. */
  readonly defaultFormat?: Readonly<TextFormat>;
  /** Effective invisible paragraph-end character used for final-line metrics. */
  readonly endMarkerFormat?: Readonly<TextFormat>;
  /** Insertion-point font for an empty paragraph or trailing empty line. */
  readonly emptyLineFormat?: Readonly<TextFormat>;
  /**
   * Horizontal alignment from `<a:pPr algn>`, or `null` when unset (the
   * cell then inherits the left default).
   */
  readonly align: ParagraphAlignment | null;
  /** Runs / fields / breaks in document order, with their literal `<a:rPr>` format. */
  readonly elements: ReadonlyArray<ShapeParagraphElement>;
}

/** Body-level line-spacing switches; omission is kept distinct from false. */
export const getTableCellTextSpacing = (
  cell: TableCellData,
): {
  compatibleLineSpacing: boolean | null;
  includeOuterSpacing: boolean | null;
} => {
  const body = firstChildElement(
    cell[CELL_ELEMENT],
    qname("a", "txBody", NS.dml),
  );
  const props = body && firstChildElement(body, qname("a", "bodyPr", NS.dml));
  const read = (name: string): boolean | null => {
    const value = props && getAttrValue(props, qname("", name, ""));
    return value === "1" || value === "true"
      ? true
      : value === "0" || value === "false"
        ? false
        : null;
  };
  return {
    compatibleLineSpacing: read("compatLnSpc"),
    includeOuterSpacing: read("spcFirstLastPara"),
  };
};

/**
 * Reads a cell's text as structured paragraphs — each carrying its
 * alignment and per-run format (`size`, `bold`, `italic`, `color`,
 * `font`, …) — for renderers that need to reproduce styled cell text.
 * `getTableCellText` is the flat-string counterpart when only the visible
 * characters matter. Returns an empty array when the cell has no
 * `<a:txBody>`.
 *
 * The cell's `<a:txBody>` uses the same DrawingML paragraph grammar as a
 * shape's, so this shares `readParagraphElements` with
 * `getShapeParagraphElements`. Table-style and theme-level defaults are not
 * folded in here: explicit run properties win, and absent ones are left
 * `undefined` for the caller to resolve.
 */
export const getTableCellParagraphs = (
  cell: TableCellData,
): ReadonlyArray<TableCellParagraph> => {
  const txBody = firstChildElement(cell[CELL_ELEMENT], NAME_A_TX_BODY_TBL);
  if (!txBody) return [];
  const out: TableCellParagraph[] = [];
  for (const p of txBody.children) {
    if (
      p.kind !== "element" ||
      p.name.namespaceURI !== NS.dml ||
      p.name.localName !== "p"
    )
      continue;
    const pPr = firstChildElement(p, qname("a", "pPr", NS.dml));
    const algn = pPr ? getAttrValue(pPr, qname("", "algn", "")) : null;
    // Normalise the raw OOXML token (`ctr`, `l`, …) to the friendly form the
    // rest of the API uses, mirroring the shape-text alignment cascade. A
    // token outside the map is malformed input and reads as unset.
    const align: ParagraphAlignment | null =
      algn !== null ? (ALIGN_TOKEN_MAP[algn] ?? null) : null;
    out.push({
      align,
      properties: pPr ? parsePPrLikeElement(pPr) : {},
      elements: readParagraphElements(p),
    });
  }
  return out;
};

/** Sets a solid background color on a cell (`<a:tcPr><a:solidFill>`). */
export const setTableCellFill = (cell: TableCellData, color: string): void => {
  const tcPr = ensureCellTcPr(cell);
  setSolidFill(tcPr, color);
  commitTableCell(cell);
};

/** Removes any background fill from a cell. */
export const clearTableCellFill = (cell: TableCellData): void => {
  const tcPr = ensureCellTcPr(cell);
  clearFillImpl(tcPr);
  commitTableCell(cell);
};

/**
 * Reads the cell's solid background color. Returns `#RRGGBB` for
 * `<a:srgbClr>`, `scheme:<token>` for `<a:schemeClr>`, or `null` when
 * the cell has no fill, no `<a:tcPr>`, or the fill is non-solid
 * (gradient / pattern / image).
 */
export const getTableCellFill = (cell: TableCellData): string | null => {
  const tcPr = firstChildElement(cell[CELL_ELEMENT], NAME_A_TC_PR);
  if (!tcPr) return null;
  const solid = firstChildElement(tcPr, qname("a", "solidFill", NS.dml));
  if (!solid) return null;
  const srgb = firstChildElement(solid, qname("a", "srgbClr", NS.dml));
  if (srgb) {
    const v = getAttrValue(srgb, qname("", "val", ""));
    if (v) return `#${v.toUpperCase()}`;
  }
  const scheme = firstChildElement(solid, qname("a", "schemeClr", NS.dml));
  if (scheme) {
    const v = getAttrValue(scheme, qname("", "val", ""));
    if (v) return `scheme:${v}`;
  }
  return null;
};

/** Applies a TextFormat to every run in the cell's text. */
export const setTableCellTextFormat = (
  cell: TableCellData,
  format: TextFormat,
): void => {
  const txBody = ensureCellTxBody(cell);
  applyFormatToAllRuns(txBody, format);
  commitTableCell(cell);
};

/** Sets horizontal alignment on every paragraph in the cell. */
export const setTableCellAlignment = (
  cell: TableCellData,
  align: ParagraphAlignment,
): void => {
  const txBody = ensureCellTxBody(cell);
  applyAlignmentToAllParagraphs(txBody, align);
  commitTableCell(cell);
};

/** Zero-based (row, col) of the cell. */
export const getTableCellPosition = (
  cell: TableCellData,
): { row: number; col: number } => ({
  row: cell[CELL_ROW],
  col: cell[CELL_COL],
});

/**
 * Reads the horizontal alignment from the cell's first paragraph
 * (`l`, `ctr`, `r`, `just`, `dist`, `justLow`, `thaiDist`). Returns
 * `null` when the cell has no `<a:txBody>` or its first paragraph
 * has no explicit `algn` attribute (it then defaults to `l`).
 */
export const getTableCellAlignment = (
  cell: TableCellData,
): ParagraphAlignment | null => {
  const txBody = firstChildElement(cell[CELL_ELEMENT], NAME_A_TX_BODY_TBL);
  if (!txBody) return null;
  for (const p of txBody.children) {
    if (
      p.kind !== "element" ||
      p.name.namespaceURI !== NS.dml ||
      p.name.localName !== "p"
    )
      continue;
    const pPr = firstChildElement(p, qname("a", "pPr", NS.dml));
    if (!pPr) return null;
    const v = getAttrValue(pPr, qname("", "algn", ""));
    return (v as ParagraphAlignment | null) ?? null;
  }
  return null;
};

const requireTbl = (table: SlideShapeData): XmlElement => {
  const tbl = findTblElement(table);
  if (!tbl) throw new Error("table shape is not a table graphic frame");
  return tbl;
};

const tableColumnCount = (tbl: XmlElement): number => {
  const grid = firstChildElement(tbl, qname("a", "tblGrid", NS.dml));
  if (!grid) return 0;
  return allChildElements(grid, NAME_A_GRID_COL).length;
};

interface MergeBlock {
  readonly row: number;
  readonly col: number;
  readonly rowSpan: number;
  readonly colSpan: number;
  /** Every `<a:tc>` in the block, the anchor first. */
  readonly cells: ReadonlyArray<XmlElement>;
}

const mergeFlag = (tc: XmlElement, name: ReturnType<typeof qname>): boolean => {
  const v = getAttrValue(tc, name);
  return v === "1" || v === "true";
};

const spanValue = (tc: XmlElement, name: ReturnType<typeof qname>): number => {
  const n = Number.parseInt(getAttrValue(tc, name) ?? "", 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
};

/** The table's merged blocks: each anchor (a span > 1 on a cell that isn't
 * itself covered) with its span clamped to the grid. */
const tableMerges = (tbl: XmlElement): MergeBlock[] => {
  const grid = tableRows(tbl).map(rowCells);
  const out: MergeBlock[] = [];
  grid.forEach((tcs, row) =>
    tcs.forEach((tc, col) => {
      if (mergeFlag(tc, ATTR_H_MERGE) || mergeFlag(tc, ATTR_V_MERGE)) return;
      const rowSpan = Math.min(spanValue(tc, ATTR_ROW_SPAN), grid.length - row);
      const colSpan = Math.min(spanValue(tc, ATTR_GRID_SPAN), tcs.length - col);
      if (rowSpan < 2 && colSpan < 2) return;
      const cells: XmlElement[] = [];
      for (let r = row; r < row + rowSpan; r++)
        for (let c = col; c < col + colSpan; c++) {
          const cell = grid[r]![c];
          if (cell) cells.push(cell);
        }
      out.push({ row, col, rowSpan, colSpan, cells });
    }),
  );
  return out;
};

/** Grows or shrinks a merge's span on every cell of the block that states it
 * (PowerPoint repeats spans on some covered cells); a span of 1 is dropped. */
const resizeMerge = (
  block: MergeBlock,
  name: ReturnType<typeof qname>,
  delta: number,
): void => {
  for (const tc of block.cells) {
    if (getAttrValue(tc, name) === null) continue;
    const next = spanValue(tc, name) + delta;
    if (next > 1) setSpanAttr(tc, name, String(next));
    else
      tc.attrs = tc.attrs.filter(
        (a) =>
          !(a.name.namespaceURI === "" && a.name.localName === name.localName),
      );
  }
};

/** Swaps two `<a:tc>` elements, which may sit in different rows. */
const swapCells = (
  trA: XmlElement,
  a: XmlElement,
  trB: XmlElement,
  b: XmlElement,
): void => {
  const ia = trA.children.indexOf(a);
  const ib = trB.children.indexOf(b);
  trA.children[ia] = b;
  trB.children[ib] = a;
};

const rowDefaultHeight = (tbl: XmlElement): number => {
  // Use the average height of existing rows, or 370000 (≈ 0.4in) as a
  // sane default when the table has no rows yet.
  const rows = tableRows(tbl);
  if (rows.length === 0) return 370000;
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    const h = getAttrValue(r, ATTR_H_TBL);
    if (h !== null) {
      const n = Number.parseInt(h, 10);
      if (Number.isFinite(n)) {
        sum += n;
        count++;
      }
    }
  }
  return count > 0 ? Math.round(sum / count) : 370000;
};

/**
 * Inserts a row into the table. `atIndex` is 0-based; `undefined`
 * appends at the end. `cells` supplies cell values; missing cells
 * become blank, extras are dropped. The row's height matches the
 * average of existing rows (or a 0.4in default for empty tables).
 */
export const insertTableRow = (
  table: SlideShapeData,
  atIndex?: number,
  cells: ReadonlyArray<string> = [],
): void => {
  const tbl = requireTbl(table);
  const colCount = tableColumnCount(tbl);
  const padded: string[] = [];
  for (let i = 0; i < colCount; i++) padded.push(cells[i] ?? "");
  const row = buildTableRow(padded, rowDefaultHeight(tbl));

  const rows = tableRows(tbl);
  const insertAt =
    atIndex !== undefined
      ? Math.max(0, Math.min(atIndex, rows.length))
      : rows.length;
  // A row inserted inside a vertical merge joins it: the merge grows and
  // the new cells under it are covered.
  const newCells = rowCells(row);
  for (const m of tableMerges(tbl)) {
    if (insertAt <= m.row || insertAt >= m.row + m.rowSpan) continue;
    resizeMerge(m, ATTR_ROW_SPAN, 1);
    for (let c = m.col; c < m.col + m.colSpan; c++) {
      const tc = newCells[c];
      if (!tc) continue;
      if (c > m.col) setSpanAttr(tc, ATTR_H_MERGE, "1");
      setSpanAttr(tc, ATTR_V_MERGE, "1");
    }
  }
  if (insertAt === rows.length) {
    tbl.children.push(row);
  } else {
    const target = rows[insertAt]!;
    const idx = tbl.children.indexOf(target);
    tbl.children.splice(idx, 0, row);
  }
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/** Removes the row at `atIndex` from the table. Throws on out-of-range. */
export const removeTableRow = (
  table: SlideShapeData,
  atIndex: number,
): void => {
  const tbl = requireTbl(table);
  const rows = tableRows(tbl);
  if (atIndex < 0 || atIndex >= rows.length) {
    throw new RangeError(
      `removeTableRow: index ${atIndex} out of range (have ${rows.length})`,
    );
  }
  // Merges crossing the row shrink; when the row holds a merge's anchor,
  // the anchor (text and formatting) moves down into the row below first.
  for (const m of tableMerges(tbl)) {
    if (m.rowSpan < 2 || atIndex < m.row || atIndex >= m.row + m.rowSpan)
      continue;
    if (atIndex === m.row) {
      const top = rowCells(rows[atIndex]!);
      const next = rowCells(rows[atIndex + 1]!);
      for (let c = m.col; c < m.col + m.colSpan; c++)
        if (top[c] && next[c])
          swapCells(rows[atIndex]!, top[c]!, rows[atIndex + 1]!, next[c]!);
    }
    resizeMerge(m, ATTR_ROW_SPAN, -1);
  }
  const target = rows[atIndex]!;
  tbl.children = tbl.children.filter((c) => c !== target);
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/**
 * Inserts a column into the table. `atIndex` defaults to the end.
 * `widthEmu` defaults to the average of existing column widths (or
 * 914400 = 1in if the table has no columns). Existing rows get a new
 * blank cell at `atIndex`.
 */
export const insertTableColumn = (
  table: SlideShapeData,
  atIndex?: number,
  widthEmu?: number,
): void => {
  const tbl = requireTbl(table);
  const grid = firstChildElement(tbl, qname("a", "tblGrid", NS.dml));
  if (!grid) throw new Error("table is missing <a:tblGrid>");
  const cols = allChildElements(grid, NAME_A_GRID_COL);
  const insertAt =
    atIndex !== undefined
      ? Math.max(0, Math.min(atIndex, cols.length))
      : cols.length;

  // Default width: average of existing widths.
  let defaultWidth = widthEmu;
  if (defaultWidth === undefined) {
    let sum = 0;
    let count = 0;
    for (const col of cols) {
      const w = getAttrValue(col, ATTR_W_TBL);
      if (w !== null) {
        const n = Number.parseInt(w, 10);
        if (Number.isFinite(n)) {
          sum += n;
          count++;
        }
      }
    }
    defaultWidth = count > 0 ? Math.round(sum / count) : 914400;
  }
  const newCol = elem(NAME_A_GRID_COL, {
    attrs: [attr(ATTR_W_TBL, String(defaultWidth))],
  });
  if (insertAt === cols.length) {
    grid.children.push(newCol);
  } else {
    const target = cols[insertAt]!;
    const idx = grid.children.indexOf(target);
    grid.children.splice(idx, 0, newCol);
  }

  // A column inserted inside a horizontal merge joins it: the merge grows
  // and the new cells under it are covered.
  const merges = tableMerges(tbl);
  // Add a blank <a:tc> at the same column index in every row.
  tableRows(tbl).forEach((tr, rowIdx) => {
    const tcs = rowCells(tr);
    const newCell = buildTableCell("");
    for (const m of merges) {
      if (insertAt <= m.col || insertAt >= m.col + m.colSpan) continue;
      if (rowIdx < m.row || rowIdx >= m.row + m.rowSpan) continue;
      setSpanAttr(newCell, ATTR_H_MERGE, "1");
      if (rowIdx > m.row) setSpanAttr(newCell, ATTR_V_MERGE, "1");
    }
    if (insertAt >= tcs.length) {
      tr.children.push(newCell);
    } else {
      const target = tcs[insertAt]!;
      const idx = tr.children.indexOf(target);
      tr.children.splice(idx, 0, newCell);
    }
  });
  for (const m of merges)
    if (insertAt > m.col && insertAt < m.col + m.colSpan)
      resizeMerge(m, ATTR_GRID_SPAN, 1);

  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};

/** Removes the column at `atIndex` (and the corresponding cell in every row). */
export const removeTableColumn = (
  table: SlideShapeData,
  atIndex: number,
): void => {
  const tbl = requireTbl(table);
  const grid = firstChildElement(tbl, qname("a", "tblGrid", NS.dml));
  if (!grid) throw new Error("table is missing <a:tblGrid>");
  const cols = allChildElements(grid, NAME_A_GRID_COL);
  if (atIndex < 0 || atIndex >= cols.length) {
    throw new RangeError(
      `removeTableColumn: index ${atIndex} out of range (have ${cols.length})`,
    );
  }
  // Merges crossing the column shrink; when the column holds a merge's
  // anchor, the anchor (text and formatting) moves right into the next
  // column first.
  const rows = tableRows(tbl);
  for (const m of tableMerges(tbl)) {
    if (m.colSpan < 2 || atIndex < m.col || atIndex >= m.col + m.colSpan)
      continue;
    if (atIndex === m.col)
      for (let r = m.row; r < m.row + m.rowSpan; r++) {
        const tcs = rowCells(rows[r]!);
        if (tcs[atIndex] && tcs[atIndex + 1])
          swapCells(rows[r]!, tcs[atIndex]!, rows[r]!, tcs[atIndex + 1]!);
      }
    resizeMerge(m, ATTR_GRID_SPAN, -1);
  }
  const targetCol = cols[atIndex]!;
  grid.children = grid.children.filter((c) => c !== targetCol);
  for (const tr of tableRows(tbl)) {
    const tcs = rowCells(tr);
    if (atIndex < tcs.length) {
      tr.children = tr.children.filter((c) => c !== tcs[atIndex]);
    }
  }
  commitSlideData(table[SHAPE_SLIDE]);
  refreshSlideData(table[SHAPE_SLIDE]);
};
