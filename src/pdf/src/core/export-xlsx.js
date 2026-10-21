/**
 * SpreadsheetML (XLSX) from an export document model (see export-layout.js).
 *
 *   writeXlsx(model, { singleSheet, title, author, signal }) -> Promise<Uint8Array>
 *   parseCellValue(text) -> { type: 'n', value, format } | { type: 's', value }
 *
 * One worksheet per page (or one sheet for the whole document). Detected tables keep their
 * rows and columns (with merged cells for spanning headers); other text takes one row per
 * paragraph. Numbers, percentages, currency amounts and dates are stored as numbers with a
 * matching number format, and column widths follow the PDF geometry.
 */
import {
  xml,
  XML_HEADER,
  zipPackage,
  contentTypes,
  relationships,
  documentProperties,
  CORE_TYPES,
} from './ooxml-zip.js';
import { textOf } from './export-layout.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const serial = (y, m, d) => {
  const time = Date.UTC(y, m - 1, d);
  const date = new Date(time);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return (time - Date.UTC(1899, 11, 30)) / 86400000;
};

/** A cell's typed value: numbers (with currency, percent, negatives in parentheses) and dates. */
export function parseCellValue(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { type: 's', value: '' };
  let t = raw.replace(/−/g, '-').replace(/\s+/g, ' ');
  // Dates.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) {
    const v = serial(+m[1], +m[2], +m[3]);
    if (v != null) return { type: 'n', value: v, format: 'yyyy-mm-dd' };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const v = serial(+m[3], +m[1], +m[2]);
    if (v != null) return { type: 'n', value: v, format: 'm/d/yyyy' };
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(t);
  if (
    m &&
    MONTHS.includes(m[1].slice(0, 3).toLowerCase()) &&
    (m[1].length === 3 ||
      /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
        m[1],
      ))
  ) {
    const v = serial(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
    if (v != null)
      return {
        type: 'n',
        value: v,
        format: m[1].length === 3 ? 'mmm d, yyyy' : 'mmmm d, yyyy',
      };
  }
  // Numbers.
  let negative = false,
    parens = false;
  let p = /^\((.*)\)$/.exec(t);
  if (p) {
    negative = parens = true;
    t = p[1].trim();
  }
  let currency = '';
  const c = /^(-)?\s*([$€£¥])\s*(.*)$/.exec(t);
  if (c) {
    if (c[1]) negative = !negative;
    currency = c[2];
    t = c[3];
    p = /^\((.*)\)$/.exec(t);
    if (p) {
      negative = !negative;
      parens = true;
      t = p[1].trim();
    }
  }
  if (/^-/.test(t)) {
    negative = !negative;
    t = t.slice(1).trim();
  }
  let percent = false;
  if (/\s?%$/.test(t)) {
    percent = true;
    t = t.replace(/\s?%$/, '');
    p = /^\((.*)\)$/.exec(t);
    if (p) {
      negative = !negative;
      parens = true;
      t = p[1].trim();
    }
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^\.\d+$/.test(t)) return { type: 's', value: raw };
  const digits = t.replace(/[,.]/g, '');
  if (digits.length > 15 || (/^0\d/.test(t) && !t.includes('.'))) return { type: 's', value: raw };
  const grouped = t.includes(',');
  const decimals = (t.split('.')[1] || '').length;
  let value = Number(t.replace(/,/g, ''));
  if (negative) value = -value;
  const zeros = decimals ? '.' + '0'.repeat(decimals) : '';
  let format;
  if (percent) {
    value /= 100;
    format = `0${zeros}%`;
    if (parens) format += `;(0${zeros}%)`;
  } else if (currency) {
    const symbol = currency === '$' ? '\\$' : `"${currency}"`;
    format = `${symbol}#,##0${zeros}`;
    format += parens ? `;${symbol}(#,##0${zeros})` : '';
  } else if (grouped || parens) {
    format = `#,##0${zeros}`;
    if (parens) format += `;(#,##0${zeros})`;
  } else if (decimals) format = `0${zeros}`;
  else format = null;
  return {
    type: 'n',
    value: Number(value.toFixed(Math.min(15, decimals + (percent ? 2 : 0)))),
    format,
  };
}

const columnName = (n) => {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

class Styles {
  constructor() {
    this.formats = new Map(); // code -> id
    this.fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
    this.fontKeys = new Map([['', 0]]);
    this.fills = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
    ];
    this.fillKeys = new Map();
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.xfKeys = new Map([['0|0|0|', 0]]);
  }
  format(code) {
    if (!code) return 0;
    if (!this.formats.has(code)) this.formats.set(code, 164 + this.formats.size);
    return this.formats.get(code);
  }
  font({ bold, italic, color, size }) {
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}|${color && color !== '000000' ? color : ''}|${size || 11}`;
    if (key === '|' + '|11') return 0;
    if (!this.fontKeys.has(key)) {
      this.fontKeys.set(key, this.fonts.length);
      this.fonts.push(
        `<font>${bold ? '<b/>' : ''}${italic ? '<i/>' : ''}<sz val="${size || 11}"/>${color && color !== '000000' ? `<color rgb="FF${color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`,
      );
    }
    return this.fontKeys.get(key);
  }
  fill(color) {
    if (!color) return 0;
    if (!this.fillKeys.has(color)) {
      this.fillKeys.set(color, this.fills.length);
      this.fills.push(
        `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`,
      );
    }
    return this.fillKeys.get(color);
  }
  xf({ format, font = {}, fill, align, wrap }) {
    const numFmtId = this.format(format);
    const fontId = this.font(font);
    const fillId = this.fill(fill);
    const key = `${numFmtId}|${fontId}|${fillId}|${align || ''}${wrap ? 'w' : ''}`;
    if (!this.xfKeys.has(key)) {
      this.xfKeys.set(key, this.xfs.length);
      const alignment =
        align || wrap
          ? `<alignment${align ? ` horizontal="${align}"` : ''}${wrap ? ' wrapText="1"' : ''} vertical="top"/>`
          : '';
      this.xfs.push(
        `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${alignment ? ' applyAlignment="1">' + alignment + '</xf>' : '/>'}`,
      );
    }
    return this.xfKeys.get(key);
  }
  toXml() {
    const formats = [...this.formats.entries()]
      .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`)
      .join('');
    return (
      XML_HEADER +
      `<styleSheet xmlns="${MAIN}">` +
      (this.formats.size ? `<numFmts count="${this.formats.size}">${formats}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
      `</styleSheet>`
    );
  }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // row index -> Map(col -> cell)
    this.merges = [];
    this.widths = [];
    this.next = 0;
  }
  set(row, col, cell) {
    (this.rows[row] ||= new Map()).set(col, cell);
  }
  width(col, chars) {
    this.widths[col] = Math.max(this.widths[col] || 0, Math.min(80, chars));
  }
}

const plain = (runs) => runs.map((r) => (r.tab ? '\t' : r.text)).join('');
const styleOf = (runs) => {
  const text = runs.filter((r) => r.text.trim() && !r.tab);
  const first = text[0] || {};
  return {
    bold: text.length > 0 && text.every((r) => r.bold),
    italic: text.length > 0 && text.every((r) => r.italic),
    color: text.every((r) => r.color === first.color) ? first.color : null,
  };
};

function placeBlock(sheet, block, styles, strings) {
  const cellFor = (text, runs, { align, fill, header, size } = {}) => {
    const value = parseCellValue(text);
    const font = { ...styleOf(runs), size };
    if (header) font.bold = true;
    if (value.type === 'n')
      return {
        type: 'n',
        value: value.value,
        style: styles.xf({
          format: value.format,
          font,
          fill,
          align: align === 'center' ? 'center' : null,
        }),
      };
    if (!text) return fill ? { type: 'blank', style: styles.xf({ fill }) } : null;
    return {
      type: 's',
      value: strings(text),
      style: styles.xf({
        font,
        fill,
        align: align === 'center' || align === 'right' ? align : null,
      }),
    };
  };
  if (block.type === 'paragraph') {
    const text = plain(block.runs).trim();
    if (!text) return;
    const row = sheet.next++;
    const pieces = block.tabs ? text.split('\t') : [text.replace(/\t/g, ' ')];
    const size = block.heading ? Math.min(20, Math.max(11, Math.round(block.size))) : undefined;
    let prefix = '';
    if (block.list) prefix = block.list.kind === 'bullet' ? '• ' : `${block.list.marker} `;
    if (pieces.length === 1)
      sheet.longest = Math.max(sheet.longest || 0, Math.min(80, text.length * 0.9));
    pieces.forEach((piece, k) => {
      const cell = cellFor(k === 0 ? prefix + piece.trim() : piece.trim(), block.runs, { size });
      if (cell) sheet.set(row, k, cell);
      if (pieces.length > 1) sheet.width(k, Math.min(40, piece.length + 2));
    });
    return;
  }
  if (block.type === 'table') {
    if (sheet.next > 0 && sheet.rows[sheet.next - 1]) sheet.next++;
    const start = sheet.next;
    const geometry = [];
    for (let k = 0; k < block.columns.length - 1; k++)
      geometry.push((block.columns[k + 1] - block.columns[k]) / 5.25);
    block.rows.forEach((row, r) => {
      for (const cell of row.cells) {
        if (cell.merged) continue;
        const runs = cell.paragraphs.flatMap((p, k) => (k ? [{ text: '\n' }, ...p.runs] : p.runs));
        const text = cell.paragraphs
          .map((p) => plain(p.runs).replace(/\t/g, ' ').trim())
          .join('\n');
        const value = cellFor(text, runs, {
          align: cell.align,
          fill: cell.fill,
          header: row.header,
        });
        if (value) {
          if (text.includes('\n') && value.type === 's')
            value.style = styles.xf({
              font: {
                ...styleOf(runs),
                bold: row.header || styleOf(runs).bold,
              },
              fill: cell.fill,
              wrap: true,
            });
          sheet.set(start + r, cell.col, value);
        }
        const rowSpan = cell.rowSpan || 1;
        if (cell.span > 1 || rowSpan > 1)
          sheet.merges.push(
            `${columnName(cell.col)}${start + r + 1}:${columnName(cell.col + cell.span - 1)}${start + r + rowSpan}`,
          );
        if (cell.span === 1) {
          const longest = Math.max(0, ...text.split('\n').map((l) => l.length));
          sheet.width(cell.col, Math.max(geometry[cell.col] || 0, longest * 1.05 + 1));
        }
      }
    });
    geometry.forEach((w, k) => sheet.width(k, w));
    sheet.next = start + block.rows.length + 1;
  }
}

function sheetXml(sheet) {
  let data = '';
  let maxCol = 0;
  const lastRow = sheet.rows.length;
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    if (!row || !row.size) continue;
    const cells = [...row.entries()].sort((a, b) => a[0] - b[0]);
    data += `<row r="${r + 1}">`;
    for (const [col, cell] of cells) {
      maxCol = Math.max(maxCol, col);
      const ref = `${columnName(col)}${r + 1}`;
      const s = cell.style ? ` s="${cell.style}"` : '';
      if (cell.type === 'n') data += `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
      else if (cell.type === 's') data += `<c r="${ref}"${s} t="s"><v>${cell.value}</v></c>`;
      else data += `<c r="${ref}"${s}/>`;
    }
    data += '</row>';
  }
  const widths = [];
  for (let k = 0; k <= Math.max(maxCol, sheet.widths.length - 1); k++) {
    const w = sheet.widths[k];
    if (w)
      widths.push(
        `<col min="${k + 1}" max="${k + 1}" width="${Math.max(4, Math.round(w * 100) / 100)}" customWidth="1"/>`,
      );
  }
  const dimension = lastRow ? `A1:${columnName(maxCol)}${lastRow}` : 'A1';
  return (
    XML_HEADER +
    `<worksheet xmlns="${MAIN}" xmlns:r="${R}">` +
    `<dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    (widths.length ? `<cols>${widths.join('')}</cols>` : '') +
    `<sheetData>${data}</sheetData>` +
    (sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '') +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`
  );
}

export async function writeXlsx(model, options = {}) {
  const styles = new Styles();
  styles.xf({ font: { bold: true } });
  const strings = [];
  const stringIndex = new Map();
  let references = 0;
  const intern = (value) => {
    // Excel cells hold at most 32,767 characters.
    const text = value.length > 32767 ? value.slice(0, 32767) : value;
    references++;
    if (!stringIndex.has(text)) {
      stringIndex.set(text, strings.length);
      strings.push(text);
    }
    return stringIndex.get(text);
  };
  const sheets = [];
  for (const page of model.pages) {
    options.signal?.throwIfAborted();
    let sheet;
    if (options.singleSheet && sheets.length) {
      sheet = sheets[0];
      sheet.next += 1;
    } else {
      sheet = new Sheet(options.singleSheet ? 'Document' : `Page ${page.index + 1}`);
      sheets.push(sheet);
    }
    for (const block of [...page.header, ...page.blocks, ...page.footer])
      placeBlock(sheet, block, styles, intern);
  }
  if (!sheets.length) sheets.push(new Sheet('Sheet1'));
  // Text columns default to a readable width; long paragraphs overflow into empty neighbours.
  for (const sheet of sheets)
    if (!sheet.widths[0]) sheet.widths[0] = Math.min(80, Math.max(12, sheet.longest || 0));

  const parts = [];
  const rels = [];
  sheets.forEach((sheet, k) => {
    parts.push({
      name: `xl/worksheets/sheet${k + 1}.xml`,
      data: sheetXml(sheet),
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    });
    rels.push({
      id: `rId${k + 1}`,
      type: 'worksheet',
      target: `worksheets/sheet${k + 1}.xml`,
    });
  });
  rels.push({
    id: `rId${sheets.length + 1}`,
    type: 'styles',
    target: 'styles.xml',
  });
  rels.push({
    id: `rId${sheets.length + 2}`,
    type: 'sharedStrings',
    target: 'sharedStrings.xml',
  });
  const workbook =
    XML_HEADER +
    `<workbook xmlns="${MAIN}" xmlns:r="${R}"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="17000"/></bookViews><sheets>` +
    sheets
      .map((sheet, k) => `<sheet name="${xml(sheet.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`)
      .join('') +
    `</sheets></workbook>`;
  parts.push({
    name: 'xl/workbook.xml',
    data: workbook,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  });
  parts.push({
    name: 'xl/styles.xml',
    data: styles.toXml(),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  });
  const sst =
    XML_HEADER +
    `<sst xmlns="${MAIN}" count="${references}" uniqueCount="${strings.length}">` +
    // Excel reads "_xHHHH_" in a string as an escaped character; text that holds one literally
    // escapes its underscore (ECMA-376 ST_Xstring).
    strings
      .map(
        (s) =>
          `<si><t xml:space="preserve">${xml(s.replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_'))}</t></si>`,
      )
      .join('') +
    `</sst>`;
  parts.push({
    name: 'xl/sharedStrings.xml',
    data: sst,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  });
  parts.push({ name: 'xl/_rels/workbook.xml.rels', data: relationships(rels) });
  const props = documentProperties({
    title: options.title,
    author: options.author,
    application: 'PDF Editor',
  });
  parts.push({ name: 'docProps/core.xml', data: props.core });
  parts.push({ name: 'docProps/app.xml', data: props.app });
  parts.push({
    name: '_rels/.rels',
    data: relationships([
      { id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' },
      { id: 'rId2', type: 'core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
    ]),
  });
  const overrides = { ...CORE_TYPES };
  for (const part of parts) if (part.type) overrides[part.name] = part.type;
  return zipPackage(
    [
      { name: '[Content_Types].xml', data: contentTypes(parts, overrides) },
      ...parts.map(({ name, data }) => ({ name, data })),
    ],
    { signal: options.signal },
  );
}

export { textOf };
