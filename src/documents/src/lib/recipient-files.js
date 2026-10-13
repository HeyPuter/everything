/**
 * Reading recipient lists from files: comma- or tab-separated text and the
 * first rows of a spreadsheet workbook (.xlsx). The workbook reader is a
 * small original reader for cell values only; it uses the app's existing zip
 * library and ignores formatting, formulas (their cached values are used),
 * charts and everything else in the package.
 */
import { unzipSync, strFromU8 } from 'fflate';

const MAX_ROWS = 10000, MAX_COLUMNS = 200;

/** Guess the delimiter of delimited text from its first lines: tab, semicolon or comma. */
export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const count = c => (sample.match(new RegExp(c === '\t' ? '\\t' : c, 'g')) || []).length;
  const scores = [['\t', count('\t')], [';', count(';')], [',', count(',')]];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] ? scores[0][0] : ',';
}

/** Parse delimited text (RFC 4180 quoting) into rows of strings. */
export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length > MAX_ROWS) throw new Error(`Recipient lists can have up to ${MAX_ROWS.toLocaleString()} rows.`);
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

/** Turn rows (first row = headings) into a recipient list. Blank or repeated headings get unique names. */
export function rowsToList(rows, { firstRowHeadings = true } = {}) {
  if (!rows.length) throw new Error('This file has no rows of data.');
  const width = Math.min(MAX_COLUMNS, Math.max(...rows.map(r => r.length)));
  const headings = firstRowHeadings ? rows[0] : [];
  const seen = new Map();
  const columns = Array.from({ length: width }, (_, i) => {
    let name = String(headings[i] ?? '').trim().replace(/\s+/g, ' ') || `Column ${i + 1}`;
    const key = name.toLowerCase();
    if (seen.has(key)) { const n = seen.get(key) + 1; seen.set(key, n); name = `${name} ${n}`; } else seen.set(key, 1);
    return name;
  });
  const body = (firstRowHeadings ? rows.slice(1) : rows).map(r => ({ values: columns.map((_, i) => String(r[i] ?? '').trim()), included: true }));
  return { columns, rows: body, sort: [], filters: [] };
}

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const parse = bytes => {
  const doc = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This workbook has a damaged part.');
  return doc;
};
const byName = (node, name) => [...node.getElementsByTagNameNS(SHEET_NS, name)];
const resolve = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) { if (piece === '..') parts.pop(); else if (piece !== '.') parts.push(piece); }
  return parts.join('/');
};
/** Column letters to a 0-based index: A → 0, AB → 27. */
export const columnIndex = letters => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
/** A spreadsheet serial day number as an ISO date (1900 date system). */
export function serialDate(serial, date1904 = false) {
  const ms = Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/** The sheets of a workbook: [{ name, rows }], each a grid of strings. */
export function readWorkbook(bytes) {
  let parts;
  try { parts = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  catch { throw new Error('This file is not a readable .xlsx workbook.'); }
  const rootRels = parts['_rels/.rels'] ? parse(parts['_rels/.rels']) : null;
  const officeRel = rootRels && [...rootRels.getElementsByTagNameNS(REL_NS, 'Relationship')].find(r => /\/officeDocument$/.test(r.getAttribute('Type')));
  const workbookPath = officeRel ? resolve('', officeRel.getAttribute('Target')) : 'xl/workbook.xml';
  if (!parts[workbookPath]) throw new Error('This file is not a readable .xlsx workbook.');
  const workbook = parse(parts[workbookPath]);
  const date1904 = byName(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1' || byName(workbook, 'workbookPr')[0]?.getAttribute('date1904') === 'true';
  const relsPath = workbookPath.replace(/[^/]+$/, name => `_rels/${name}.rels`);
  const rels = parts[relsPath] ? [...parse(parts[relsPath]).getElementsByTagNameNS(REL_NS, 'Relationship')] : [];
  const target = type => rels.find(r => r.getAttribute('Type') === `${OFFICE_REL}/${type}`);
  const shared = [];
  const sharedRel = target('sharedStrings');
  if (sharedRel && parts[resolve(workbookPath, sharedRel.getAttribute('Target'))]) {
    for (const si of byName(parse(parts[resolve(workbookPath, sharedRel.getAttribute('Target'))]), 'si')) {
      // Rich text keeps its runs' text; phonetic guides are not part of the value.
      const texts = [...si.getElementsByTagNameNS(SHEET_NS, 't')].filter(t => t.parentNode.localName !== 'rPh');
      shared.push(texts.map(t => t.textContent).join(''));
    }
  }
  // Which cell styles show dates, so serial numbers read back as dates.
  const dateStyles = new Set();
  const stylesRel = target('styles');
  if (stylesRel && parts[resolve(workbookPath, stylesRel.getAttribute('Target'))]) {
    const styles = parse(parts[resolve(workbookPath, stylesRel.getAttribute('Target'))]);
    const custom = new Map(byName(styles, 'numFmt').map(f => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']));
    const xfs = byName(styles, 'cellXfs')[0];
    if (xfs) [...xfs.children].filter(n => n.localName === 'xf').forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId') || 0);
      const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '') || '';
      if (BUILTIN_DATE_FORMATS.has(id) || /[dy]|m{3,}/i.test(code) && !/^[#0.,%\s]*$/.test(code)) dateStyles.add(i);
    });
  }
  const sheets = [];
  for (const sheet of byName(workbook, 'sheet')) {
    const id = sheet.getAttributeNS(OFFICE_REL, 'id') || sheet.getAttribute('r:id');
    const rel = rels.find(r => r.getAttribute('Id') === id);
    const path = rel && resolve(workbookPath, rel.getAttribute('Target'));
    if (!path || !parts[path]) continue;
    const rows = [];
    for (const row of byName(parse(parts[path]), 'row')) {
      const index = Number(row.getAttribute('r') || rows.length + 1) - 1;
      if (index >= MAX_ROWS + 1) break;
      const values = [];
      let next = 0;
      for (const cell of [...row.children].filter(n => n.localName === 'c')) {
        const ref = /^([A-Z]+)/i.exec(cell.getAttribute('r') || '')?.[1];
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        if (col >= MAX_COLUMNS) continue;
        const type = cell.getAttribute('t'), v = [...cell.children].find(n => n.localName === 'v')?.textContent ?? '';
        let value;
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = [...cell.getElementsByTagNameNS(SHEET_NS, 't')].map(t => t.textContent).join('');
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') value = v;
        else if (v !== '' && dateStyles.has(Number(cell.getAttribute('s') || 0))) value = serialDate(Number(v), date1904);
        else value = v === '' ? '' : String(Number(v)) === v || !Number.isFinite(Number(v)) ? v : String(Number(Number(v).toPrecision(15)));
        values[col] = value;
      }
      rows[index] = Array.from(values, v => v ?? '');
    }
    sheets.push({ name: sheet.getAttribute('name') || `Sheet ${sheets.length + 1}`, rows: Array.from(rows, r => r || []).filter(r => r.some(v => String(v).trim())) });
  }
  if (!sheets.length) throw new Error('This workbook has no worksheets.');
  return sheets;
}

/** Read a recipient list from a File/Blob by its name: .xlsx workbooks, .tsv/.txt tab-separated, else comma-separated. */
export async function readRecipientFile(file, { sheet } = {}) {
  const name = file.name || '';
  if (file.size > 20 * 1024 * 1024) throw new Error('Recipient files can be up to 20 MB.');
  if (/\.xlsx$/i.test(name)) {
    const sheets = readWorkbook(new Uint8Array(await file.arrayBuffer()));
    const chosen = (sheet !== undefined && sheets[sheet]) || sheets.find(s => s.rows.length) || sheets[0];
    return { ...rowsToList(chosen.rows), sheets: sheets.map(s => s.name), sheet: sheets.indexOf(chosen) };
  }
  if (/\.(xls|xlsm|xlsb|ods|numbers)$/i.test(name)) throw new Error('Save this spreadsheet as .xlsx or .csv to use it as a recipient list.');
  const text = await file.text();
  return rowsToList(parseDelimited(text, /\.tsv$/i.test(name) ? '\t' : detectDelimiter(text)));
}

/** A recipient list as comma-separated text, for exporting. */
export function listToCsv(list) {
  const cell = v => /[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
  return [list.columns, ...list.rows.map(r => r.values)].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
