// CSV parsing and splitting spreadsheet ranges into board tables. Board
// tables hold at most 20 rows, 12 columns, and 2,000 characters per cell.
import { columnName } from "./providers.js";
import { truncate } from "../model.js";

export const TABLE_ROWS = 20;
export const TABLE_COLUMNS = 12;
export const CELL_CHARACTERS = 2000;
export const MAX_TABLES = 40;
const CSV_ROWS = 5000,
  CSV_COLUMNS = 500;

function delimiter(text) {
  const end = Math.min(text.length, 4096),
    separators = [",", ";", "\t", "|"],
    records = [];
  let counts = separators.map(() => 0),
    quoted = false,
    nonblank = false,
    textCommas = 0;
  // A comma between two digits is a decimal comma, not a sign of the
  // delimiter; the others are counted apart.
  const push = () => records.push({ counts, textCommas });
  // Count delimiters in logical records. Quoted content, including doubled
  // quotes and newlines, says nothing about which separator a file uses.
  for (let n = 0; n < end && records.length < 5; n++) {
    const char = text[n];
    if (/\S/.test(char)) nonblank = true;
    if (char === '"') {
      if (quoted && text[n + 1] === '"') n++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === "\n") {
        if (nonblank) push();
        counts = separators.map(() => 0);
        textCommas = 0;
        nonblank = false;
      } else {
        const index = separators.indexOf(char);
        if (index !== -1) counts[index]++;
        if (
          char === "," &&
          !(/\d/.test(text[n - 1] || "") && /\d/.test(text[n + 1] || ""))
        )
          textCommas++;
      }
    }
  }
  // Ignore a cut-off record when complete records are available. For a
  // single very long record, use only its unquoted sample delimiters.
  if (
    records.length < 5 &&
    nonblank &&
    (end === text.length || !records.length)
  )
    push();
  let best = ",",
    score = 0;
  // Lines without any delimiter above the first that has one, such as a
  // report title, are not part of the table.
  const table = records.slice(
    Math.max(
      0,
      records.findIndex((r) => r.counts.some(Boolean)),
    ),
  );
  // Commas outside numbers in every record too: then another delimiter wins
  // only by number, since the commas may be the delimiter and the others
  // sit in a text column.
  const commas = table.length > 0 && table.every((r) => r.textCommas > 0);
  for (const [index, d] of separators.entries()) {
    const found = table.map((r) => r.counts[index]);
    // Another delimiter in every record goes before the comma: commas also
    // appear in text and in decimal numbers written the French way, which
    // is why spreadsheets there separate values with semicolons.
    const s = found.length && Math.min(...found) > 0 ? found[0] : 0;
    if (s && (s > score || (best === "," && (!commas || s >= score)))) {
      best = d;
      score = s;
    }
  }
  return best;
}

// RFC 4180 with quoted delimiters, doubled quotes, and embedded newlines.
export function parseCSV(text, separator) {
  text = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  // Excel reads and writes a first line such as "sep=;" naming the
  // delimiter; it is not part of the table.
  const hint = !separator && /^sep=([^"\n])(?:\n|$)/i.exec(text);
  if (hint) text = text.slice(hint[0].length);
  const d = separator || (hint ? hint[1] : delimiter(text));
  const rows = [];
  let row = [],
    value = "",
    quoted = false,
    truncated = false;
  const push = () => {
    if (row.length < CSV_COLUMNS) row.push(value);
    else truncated = true;
    value = "";
  };
  for (let n = 0; n < text.length; n++) {
    const char = text[n];
    if (quoted) {
      if (char !== '"') value += char;
      else if (text[n + 1] === '"') {
        value += '"';
        n++;
      } else quoted = false;
    } else if (char === '"' && value === "") quoted = true;
    else if (char === d) push();
    else if (char === "\n") {
      push();
      rows.push(row);
      row = [];
      if (rows.length >= CSV_ROWS) {
        truncated ||= n < text.length - 1;
        break;
      }
    } else value += char;
  }
  if (value || row.length) {
    push();
    rows.push(row);
  }
  return { rows, truncated };
}

// Removes empty trailing rows and columns and pads to a rectangle.
export function trimRows(rows) {
  const filled = rows.map((row) => (row || []).map((v) => String(v ?? "")));
  while (filled.length && !filled.at(-1).some((v) => v.trim())) filled.pop();
  const width = Math.max(
    0,
    ...filled.map((row) => {
      let n = row.length;
      while (n && !row[n - 1].trim()) n--;
      return n;
    }),
  );
  return filled.map((row) =>
    Array.from({ length: width }, (_, c) => row[c] ?? ""),
  );
}

// Where a sheet's data starts: its first row and column with a value.
function dataStart(rows) {
  let top = -1,
    left = Infinity;
  rows.forEach((row, r) => {
    const n = row.findIndex((v) => v.trim());
    if (n < 0) return;
    if (top < 0) top = r;
    left = Math.min(left, n);
  });
  return { top: Math.max(0, top), left: top < 0 ? 0 : left };
}

// Splits rows into table-sized chunks. In "split" mode the first row is a
// header repeated on every vertical chunk; "first" keeps one table.
// Data that starts below or right of A1 starts the table, and its header
// is the first row with a value.
// Each chunk carries its A1 source range for refreshing from Google Sheets.
export function splitTable(input, { mode = "split", header = true } = {}) {
  const trimmed = trimRows(input),
    offset = dataStart(trimmed),
    rows = trimmed.slice(offset.top).map((row) => row.slice(offset.left));
  const result = {
    tables: [],
    truncatedCells: 0,
    omittedRows: 0,
    omittedColumns: 0,
    rows: rows.length,
    columns: rows[0]?.length || 0,
  };
  if (!rows.length || !result.columns) return result;
  const cut = (value) => {
    if (value.length <= CELL_CHARACTERS) return value;
    result.truncatedCells++;
    return truncate(value, CELL_CHARACTERS - 1) + "…";
  };
  const hasHeader = header && rows.length > 1;
  const bodyRows = hasHeader ? TABLE_ROWS - 1 : TABLE_ROWS;
  const body = hasHeader ? rows.slice(1) : rows;
  const vertical = mode === "first" ? 1 : Math.ceil(body.length / bodyRows);
  const horizontal =
    mode === "first" ? 1 : Math.ceil(result.columns / TABLE_COLUMNS);
  // Only rows of tables that can be finished are started, so rows left out
  // are left out across every column and counted as such.
  const fit = Math.max(1, Math.floor(MAX_TABLES / horizontal));
  for (let v = 0; v < Math.min(vertical, fit); v++)
    for (let h = 0; h < horizontal; h++) {
      if (result.tables.length >= MAX_TABLES) break;
      const left = h * TABLE_COLUMNS,
        right = Math.min(result.columns, left + TABLE_COLUMNS);
      const start = v * bodyRows,
        chunk = body.slice(start, start + bodyRows);
      if (!chunk.length && v) continue;
      const cells = [...(hasHeader ? [rows[0]] : []), ...chunk].map((row) =>
        row.slice(left, right).map(cut),
      );
      // Source rows are 1-based and include the header row when present.
      const first = offset.top + 1,
        top = first + (hasHeader ? 1 : 0) + start,
        bottom = top + chunk.length - 1,
        from = columnName(offset.left + left),
        to = columnName(offset.left + right - 1);
      const range =
        v === 0 && hasHeader
          ? `${from}${first}:${to}${Math.max(first, bottom)}`
          : `${from}${top}:${to}${Math.max(top, bottom)}`;
      result.tables.push({
        cells,
        row: v,
        column: h,
        range,
        header: hasHeader,
      });
    }
  const coveredRows = Math.min(
    body.length,
    (mode === "first" ? 1 : Math.ceil(result.tables.length / horizontal)) *
      bodyRows,
  );
  result.omittedRows = Math.max(0, body.length - coveredRows);
  // Columns reach as far as the rightmost table that was made.
  const coveredColumns = Math.min(
    result.columns,
    Math.max(0, ...result.tables.map((t) => (t.column + 1) * TABLE_COLUMNS)),
  );
  result.omittedColumns = Math.max(0, result.columns - coveredColumns);
  return result;
}

// Cells for a stored A1 range, used when refreshing a Google Sheets table.
// Ranges below the header row get the header prepended again. A range with
// spare table rows grows with the sheet; full chunks cannot, so refreshed
// chunks never overlap. Returns the cells and the range they now cover.
export function rangeCells(input, range, header = true) {
  const rows = trimRows(input);
  // A stored range can name more columns than a table holds, as when a
  // board file was edited; the table keeps the columns it can.
  const { top, left } = range,
    right = Math.min(range.right, left + TABLE_COLUMNS - 1);
  const pick = (row) =>
    Array.from({ length: right - left + 1 }, (_, c) => {
      const value = row?.[left + c] ?? "";
      return value.length > CELL_CHARACTERS
        ? truncate(value, CELL_CHARACTERS - 1) + "…"
        : value;
    });
  // The header is the first row with a value, as the table was imported.
  const first = dataStart(rows).top;
  const out = header && top > first ? [pick(rows[first])] : [];
  const capacity = TABLE_ROWS - out.length;
  const bottom = Math.max(top, Math.min(rows.length - 1, top + capacity - 1));
  for (let r = top; r <= bottom; r++) out.push(pick(rows[r]));
  return {
    cells: out,
    range: `${columnName(left)}${top + 1}:${columnName(right)}${bottom + 1}`,
  };
}
