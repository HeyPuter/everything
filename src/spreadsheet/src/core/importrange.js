/**
 * IMPORTRANGE(file, range): values from another spreadsheet on the Puter
 * drive. The pure parts live here (which file, which cells, reading them out
 * of a loaded Workbook); the editor supplies the file reading.
 */

import { parseRefText } from './refs.js';
import { htmlTableRows } from './html-table.js';
import { isSpreadsheetFile } from './filetypes.js';
import { getLocale, typedDateKind } from './format.js';

/** "Budget" → "Spreadsheets/Budget.xlsx"; a path with a slash is used as given (an extension is added when missing). */
export function resolveImportPath(name, folder, ensureXlsx) {
  const text = String(name ?? '').trim();
  if (!text) return null;
  // Explicit supported filenames must resolve to the file the user named.
  if (isSpreadsheetFile(text) && !/\.xlsx$/i.test(text)) return text.includes('/') ? text : `${folder}/${text}`;
  if (text.includes('/')) {
    // A path keeps its extension; a suffix of digits alone (Reports/Q1.2024) is part of the name.
    const ext = /\.([a-z0-9]{2,5})$/i.exec(text)?.[1];
    return ext && /[a-z]/i.test(ext) ? text : `${text}.xlsx`;
  }
  return `${folder}/${ensureXlsx(text)}`;
}

/** "Sheet1!A1:B10", "'Q1 Data'!A1:A9", or "A1:B10" (the first sheet) → { sheet, ref } or null. */
export function parseImportRange(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let sheet = null;
  let body = t;
  const bang = t.lastIndexOf('!');
  if (bang > 0) {
    sheet = t.slice(0, bang).trim();
    if (/^'.*'$/.test(sheet)) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    body = t.slice(bang + 1).trim();
  }
  const ref = parseRefText(body.toUpperCase(), sheet);
  if (!ref) return null;
  return { sheet, ref };
}

/** The values of `spec` (from parseImportRange) in `wb`, as rows, or { error }. Whole columns and rows clamp to the used area. */
export function readImportRange(wb, spec) {
  const target = spec.sheet ? wb.sheetByName(spec.sheet) : wb.sheets.find((s) => !s.hidden) || wb.sheets[0];
  if (!target) return { error: '#REF!' };
  const used = wb.usedRange(target.id) || { r2: -1, c2: -1 };
  const r1 = spec.ref.r1;
  const c1 = spec.ref.c1;
  // Empty imports still return at least one row and column. Apply that
  // minimum before checking the cell budget, using the same bounds below.
  const r2 = Math.max(r1, spec.ref.kind === 'cols' ? used.r2 : Math.min(spec.ref.r2, Math.max(target.rows - 1, r1)));
  const c2 = Math.max(c1, spec.ref.kind === 'rows' ? used.c2 : Math.min(spec.ref.c2, Math.max(target.cols - 1, c1)));
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200000) return { error: '#NUM!' };
  const out = [];
  for (let r = r1; r <= r2; r++) {
    const row = [];
    for (let c = c1; c <= c2; c++) {
      const v = wb.getValue(target.id, r, c);
      row.push(v == null ? null : v && typeof v === 'object' && !v.error ? null : v);
    }
    out.push(row);
  }
  return out;
}

/** Formats whose serials would read as bare numbers in a spill, which carries no number format of its own. */

/**
 * `text` read the way typed input is, in the user's locale (as a file import
 * reads it). A formula stays text, and so does a date or time: shown as
 * 46027 it would mean nothing, while "2026-01-05" reads (and DATEVALUE converts).
 */
function typedValue(text, parseInput) {
  const parsed = parseInput(text, getLocale());
  // A month and year or a duration (Feb 2024, 25:30) is a date or time too, read with a custom code of its own.
  return parsed.f != null || typedDateKind(parsed) ? text : parsed.v;
}

/**
 * Rows of typed values from delimited text (for IMPORTDATA): the delimiter
 * is detected unless given; cells are read the way typed input is.
 */
export function rowsFromDelimited(text, delimiter, { detectDelimiter, parseDelimited, parseInput }) {
  const src = String(text ?? '').replace(/^\ufeff/, '');
  const delim = delimiter || detectDelimiter(src, '');
  // Empty records still occupy rows. Removing them changes the addresses
  // of later records and understates the rectangular import size.
  const rows = parseDelimited(src, delim);
  if (!rows.some((row) => row.some((cell) => String(cell ?? '').trim() !== ''))) return { error: '#N/A' };
  let width = 0;
  for (const row of rows) {
    width = Math.max(width, row.length);
    if (rows.length * width > 200000) return { error: '#NUM!' };
  }
  return rows.map((row) => row.map((cell) => typedValue(cell, parseInput)));
}

/** Elements shown on a line of their own, so text on either side of one reads as separate words. */
const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TD', 'TH', 'TR', 'UL']);

/** Elements whose text the page never shows: code, style rules, and markup held back for scripts. */
const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** An element's text as the page shows it: a space stands in for each line break a <br> or a block element makes (the caller collapses whitespace). */
function shownText(el) {
  if (!el.firstElementChild) return el.textContent;
  let out = '';
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3) out += node.nodeValue;
    else if (node.nodeType === 1 && !HIDDEN_TAGS.has(node.tagName)) out += BLOCK_TAGS.has(node.tagName) ? ` ${shownText(node)} ` : shownText(node);
  }
  return out;
}

/**
 * Rows from a web page (for IMPORTHTML): the `index`-th (1-based) table as a
 * grid of typed values, or the `index`-th list as one column. Needs a DOM
 * parser (the browser's, or jsdom in tests).
 */
export function rowsFromHtml(html, kind, index, parseInput) {
  if (typeof DOMParser === 'undefined') return { error: '#N/A' };
  let doc;
  try { doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html'); } catch { return { error: '#N/A' }; }
  const n = Math.max(1, Math.trunc(Number(index) || 1));
  const typed = (el) => typedValue(shownText(el).replace(/\s+/g, ' ').trim(), parseInput);
  if (kind === 'list') {
    const lists = [...doc.querySelectorAll('ul, ol')].filter((l) => !l.parentElement?.closest('ul, ol'));
    const list = lists[n - 1];
    if (!list) return { error: '#N/A' };
    const items = [];
    // Walk siblings once, without copying a potentially enormous live
    // collection, and apply the same cell budget as table imports.
    for (let li = list.firstElementChild; li; li = li.nextElementSibling) {
      if (li.tagName !== 'LI') continue;
      if (items.length >= 200000) return { error: '#NUM!' };
      items.push([typed(li)]);
    }
    return items.length ? items : { error: '#N/A' };
  }
  const tables = [...doc.querySelectorAll('table')].filter((t) => !t.parentElement?.closest('table'));
  const table = tables[n - 1];
  if (!table) return { error: '#N/A' };
  const rows = [];
  const tableRows = htmlTableRows(table);
  const groupEnds = new Map();
  tableRows.forEach((tr, r) => groupEnds.set(tr.parentElement, r + 1));
  const rowSpans = new Map();
  let width = 0;
  for (const [r, tr] of tableRows.entries()) {
    const row = [];
    for (const [c, end] of rowSpans) {
      if (end > r) row[c] = null;
      else rowSpans.delete(c);
    }
    let c = 0;
    for (const td of tr.children) {
      if (td.tagName !== 'TD' && td.tagName !== 'TH') continue;
      while (c in row) c++;
      // Use the browser's bounded span, not the untrusted attribute as an allocation size.
      const span = td.colSpan;
      width = Math.max(width, c + span);
      // Empty rows occupy spreadsheet addresses too. Bound the complete
      // rectangle before expanding cells or padding those rows.
      if (tableRows.length * width > 200000) return { error: '#NUM!' };
      const groupEnd = groupEnds.get(tr.parentElement);
      const end = td.rowSpan === 0 ? groupEnd : Math.min(r + td.rowSpan, groupEnd);
      row[c] = typed(td);
      for (let i = 0; i < span; i++) {
        if (i) row[c + i] = null;
        if (end > r + 1) rowSpans.set(c + i, end);
      }
      c += span;
    }
    rows.push(Array.from(row, (value) => value ?? null));
  }
  if (!width) return { error: '#N/A' };
  return rows.map((r) => { const out = r.slice(); while (out.length < width) out.push(null); return out; });
}

/**
 * Rows from an XML or HTML document by XPath (for IMPORTXML): one row per
 * matched node, the node's text (or an attribute's value) as the cell.
 * Needs a DOM with XPath (the browser's, or jsdom in tests).
 */
export function rowsFromXml(text, xpath, parseInput) {
  if (typeof DOMParser === 'undefined' || typeof XPathResult === 'undefined') return { error: '#N/A' };
  const src = String(text ?? '');
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(src, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) doc = null;
  } catch { doc = null; }
  if (!doc) { try { doc = new DOMParser().parseFromString(src, 'text/html'); } catch { return { error: '#N/A' }; } }
  let result;
  try {
    const ns = (prefix) => doc.documentElement?.lookupNamespaceURI(prefix) || null;
    result = doc.evaluate(String(xpath), doc, ns, XPathResult.ANY_TYPE, null);
  } catch { return { error: '#VALUE!' }; }
  const typed = (t) => typedValue(String(t ?? '').replace(/\s+/g, ' ').trim(), parseInput);
  if (result.resultType === XPathResult.NUMBER_TYPE) return [[result.numberValue]];
  if (result.resultType === XPathResult.STRING_TYPE) return [[typed(result.stringValue)]];
  if (result.resultType === XPathResult.BOOLEAN_TYPE) return [[result.booleanValue]];
  const rows = [];
  for (let node = result.iterateNext(); node; node = result.iterateNext()) {
    rows.push([typed(node.nodeType === 2 ? node.value : node.textContent)]);
    if (rows.length > 100000) return { error: '#NUM!' };
  }
  return rows.length ? rows : { error: '#N/A' };
}

/**
 * A file name for something fetched from a URL, so the importer knows the
 * format: the address's last path segment, or "Imported.xlsx" / "Imported.xls" /
 * "Imported.csv" by sniffing the bytes. A zip is a spreadsheet package; a compound
 * file or markup (a web page's table, an Excel 2003 XML sheet, as an "export as
 * Excel" link often serves) is named .xls, so the importer reads it by its bytes
 * rather than as delimited text, which a .csv name would make of it.
 */
export function importNameFor(url, bytes = null) {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
  name = name.replace(/[\\/:*?"<>|]/g, '').trim();
  if (isSpreadsheetFile(name)) return name;
  const zip = bytes && bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const cfb = bytes && bytes.length > 3 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  const markup = bytes && /^<[!?a-z]/i.test(new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^\ufeff/, '').trimStart());
  const base = name.replace(/\.[^.]*$/, '') || 'Imported';
  return `${base}.${zip ? 'xlsx' : cfb || markup ? 'xls' : 'csv'}`;
}

/** The MIME type of image bytes by their signature (PNG, JPEG, GIF, WebP, SVG), or null. */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = new TextDecoder('utf-8').decode(b.slice(0, 512)).replace(/^\ufeff/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}
