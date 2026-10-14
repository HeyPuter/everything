// Minimal xlsx writer scoped to chart-data needs.
//
// Readers expect an embedded workbook to back every chart so the chart
// data stays editable. We don't need a real spreadsheet — just
// a single sheet with the chart's category labels and series values.
// Number formats back source-linked chart labels. Everything beyond those
// cell styles (calculated columns, defined names,
// shared strings, charts within the xlsx itself) is deliberately
// excluded. The plan calls this out as a scope-creep risk; the file
// stays under `internal/chartml/` and is never exposed publicly.
//
// Schema (ECMA-376 Part 1 §18 SpreadsheetML, simplified):
//
//   /[Content_Types].xml      defaults + overrides
//   /_rels/.rels              → /xl/workbook.xml
//   /xl/workbook.xml          one <sheets>/<sheet> entry
//   /xl/_rels/workbook.xml.rels → /xl/worksheets/sheet1.xml
//   /xl/worksheets/sheet1.xml the data, using inline strings to skip
//                             the shared-strings table

import { writeZip } from "../opc/zip.ts";

const TEXT_ENCODER = new TextEncoder();
const encode = (s: string): Uint8Array => TEXT_ENCODER.encode(s);

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const colLetter = (col: number): string => {
  // 0-based to A, B, …, Z, AA, AB, … (A1-style).
  let n = col;
  let out = "";
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
};

const cellRef = (row: number, col: number): string =>
  `${colLetter(col)}${row + 1}`;

/** A row in the embedded sheet — string in column 0, numeric values after. */
export interface DataRow {
  readonly label: string;
  readonly values: ReadonlyArray<number | null>;
}

const packageWorkbook = (
  sheetXml: string,
  stylesXml: string | undefined,
  date1904: boolean | undefined,
): Uint8Array => {
  // ----- /xl/workbook.xml -----------------------------------------------
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    (date1904 ? '<workbookPr date1904="1"/>' : "") +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

  // ----- /xl/_rels/workbook.xml.rels ------------------------------------
  const workbookRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
    'Target="worksheets/sheet1.xml"/>' +
    (stylesXml
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      : "") +
    "</Relationships>";

  // ----- /_rels/.rels ---------------------------------------------------
  const rootRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="xl/workbook.xml"/></Relationships>';

  // ----- /[Content_Types].xml ------------------------------------------
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    (stylesXml
      ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      : "") +
    "</Types>";

  // Order matters — keep the conventional xlsx entry order.
  return writeZip([
    { name: "[Content_Types].xml", data: encode(contentTypesXml) },
    { name: "_rels/.rels", data: encode(rootRelsXml) },
    { name: "xl/workbook.xml", data: encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: encode(workbookRelsXml) },
    { name: "xl/worksheets/sheet1.xml", data: encode(sheetXml) },
    ...(stylesXml ? [{ name: "xl/styles.xml", data: encode(stylesXml) }] : []),
  ]);
};

// One cell style per distinct non-General number format, in first-use order.
const cellStyles = (
  requested: ReadonlyArray<string | undefined>,
): {
  styleAttr: (format: string | undefined) => string;
  stylesXml: string | undefined;
} => {
  const formats = [
    ...new Set(
      requested.filter((f): f is string => f !== undefined && f !== "General"),
    ),
  ];
  const styleIndices = new Map(formats.map((format, i) => [format, i + 1]));
  const styleIndex = (format: string | undefined): number =>
    format === undefined ? 0 : (styleIndices.get(format) ?? 0);
  const styleAttr = (format: string | undefined): string =>
    styleIndex(format) === 0 ? "" : ` s="${styleIndex(format)}"`;
  const stylesXml =
    formats.length === 0
      ? undefined
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<numFmts count="${formats.length}">${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEscape(f)}"/>`).join("")}</numFmts>` +
        '<fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${formats.length + 1}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${formats.map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join("")}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return { styleAttr, stylesXml };
};

/** One column of a column-oriented sheet: a text header over numbers. */
export interface DataColumn {
  readonly header: string;
  readonly values: ReadonlyArray<number | null>;
  readonly numberFormat?: string;
}

/**
 * Builds a single-sheet xlsx from columns, left to right from column A:
 * row 1 holds each column's header, the rows below its numbers (blanks
 * omitted). XY charts use it for their X / Y / size channels.
 */
export const buildEmbeddedXlsxColumns = (
  columns: ReadonlyArray<DataColumn>,
  options: { readonly date1904?: boolean } = {},
): Uint8Array => {
  const { styleAttr, stylesXml } = cellStyles(
    columns.map((column) => column.numberFormat),
  );
  const rows = columns.reduce(
    (count, column) => Math.max(count, column.values.length),
    0,
  );
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "<sheetData>",
    '<row r="1">',
    ...columns.map(
      (column, i) =>
        `<c r="${cellRef(0, i)}" t="inlineStr"><is><t>${xmlEscape(column.header)}</t></is></c>`,
    ),
    "</row>",
  ];
  for (let r = 0; r < rows; r++) {
    parts.push(`<row r="${r + 2}">`);
    columns.forEach((column, i) => {
      const v = column.values[r];
      if (v === null || v === undefined) return;
      parts.push(
        `<c r="${cellRef(r + 1, i)}"${styleAttr(column.numberFormat)}><v>${v}</v></c>`,
      );
    });
    parts.push("</row>");
  }
  parts.push("</sheetData></worksheet>");
  return packageWorkbook(parts.join(""), stylesXml, options.date1904);
};

/**
 * Builds the bytes of a fresh xlsx whose only sheet is laid out as
 *
 *   |       | seriesNames[0] | seriesNames[1] | ...
 *   |-------|----------------|----------------|----
 *   | row0  | row0.values[0] | row0.values[1] | ...
 *   | row1  | row1.values[0] | ...            | ...
 *
 * Header row is row 1 in the sheet (1-indexed). The first column carries
 * category labels; subsequent columns carry series values.
 */
export const buildEmbeddedXlsx = (
  seriesNames: ReadonlyArray<string>,
  rows: ReadonlyArray<DataRow>,
  options: {
    readonly seriesNumberFormats?: ReadonlyArray<string | undefined>;
    readonly categoryNumberFormat?: string;
    readonly date1904?: boolean;
  } = {},
): Uint8Array => {
  const { styleAttr, stylesXml } = cellStyles([
    options.categoryNumberFormat,
    ...(options.seriesNumberFormats ?? []),
  ]);
  // ----- /xl/worksheets/sheet1.xml --------------------------------------
  const sheetXmlParts: string[] = [];
  sheetXmlParts.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "<sheetData>",
  );

  // Header row.
  sheetXmlParts.push('<row r="1">');
  // A1 = blank.
  sheetXmlParts.push(
    `<c r="${cellRef(0, 0)}" t="inlineStr"><is><t></t></is></c>`,
  );
  for (let i = 0; i < seriesNames.length; i++) {
    sheetXmlParts.push(
      `<c r="${cellRef(0, i + 1)}" t="inlineStr"><is><t>${xmlEscape(seriesNames[i] ?? "")}</t></is></c>`,
    );
  }
  sheetXmlParts.push("</row>");

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const rowIdx = r + 1; // header sits at index 0.
    sheetXmlParts.push(`<row r="${rowIdx + 1}">`);
    if (options.categoryNumberFormat === undefined) {
      sheetXmlParts.push(
        `<c r="${cellRef(rowIdx, 0)}" t="inlineStr"><is><t>${xmlEscape(row.label)}</t></is></c>`,
      );
    } else if (row.label.trim() !== "") {
      sheetXmlParts.push(
        `<c r="${cellRef(rowIdx, 0)}"${styleAttr(options.categoryNumberFormat)}><v>${Number(row.label)}</v></c>`,
      );
    }
    for (let i = 0; i < row.values.length; i++) {
      const v = row.values[i];
      if (v === null || v === undefined) continue; // omit empty cell.
      sheetXmlParts.push(
        `<c r="${cellRef(rowIdx, i + 1)}"${styleAttr(options.seriesNumberFormats?.[i])}><v>${v}</v></c>`,
      );
    }
    sheetXmlParts.push("</row>");
  }

  sheetXmlParts.push("</sheetData></worksheet>");
  const sheetXml = sheetXmlParts.join("");

  return packageWorkbook(sheetXml, stylesXml, options.date1904);
};

/**
 * Returns the spreadsheet-cell reference span used by chart `<c:f>`
 * formulas. Example: `cellRange('Sheet1', 1, 0, 4)` →
 * `"Sheet1!$A$2:$A$5"` (column A, rows 2–5 inclusive, 0-indexed input).
 */
export const cellRange = (
  sheet: string,
  startRow: number,
  col: number,
  count: number,
): string => {
  const colA = colLetter(col);
  return `${sheet}!$${colA}$${startRow + 1}:$${colA}$${startRow + count}`;
};

/** Single-cell reference, e.g. `cellAddr('Sheet1', 0, 1)` → `"Sheet1!$B$1"`. */
export const cellAddr = (sheet: string, row: number, col: number): string =>
  `${sheet}!$${colLetter(col)}$${row + 1}`;
