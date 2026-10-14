// Tables of authorities (ECMA-376 Part 1 §17.16.5.62 TA, §17.16.5.67 TOA).
// A TA field marks a citation of a case, statute or other authority with its
// long form, short form and category; a TOA field's cached result lists one
// category's citations alphabetically with their pages, using "passim" for
// authorities cited on five or more pages when asked.
import { bodyFieldRanges } from './body-fields.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { fieldsOfType, insertEntryField, newBodyField, writeBlockField } from './generated-fields.js';

/** Default category names, numbered 1–7; 8–16 are free for the document to name. */
export const TOA_CATEGORIES = ['Cases', 'Statutes', 'Other Authorities', 'Rules', 'Treatises', 'Regulations', 'Constitutional Provisions', '8', '9', '10', '11', '12', '13', '14', '15', '16'];
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Parse a TA instruction: { long, short, category, bold, italic, bookmark }. */
export function parseAuthority(instruction) {
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return null; }
  const result = { long: null, short: null, category: 1, bold: false, italic: false, bookmark: null };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\\l') result.long = tokens[++i] ?? '';
    else if (t === '\\s') result.short = tokens[++i] ?? '';
    else if (t === '\\c') result.category = Math.max(1, Math.min(16, Number(tokens[++i]) || 1));
    else if (t === '\\b') result.bold = true;
    else if (t === '\\i') result.italic = true;
    else if (t === '\\r') result.bookmark = tokens[++i] ?? null;
  }
  return result.long || result.short ? result : null;
}

/** A TA instruction. The first mark of an authority carries its long form; later ones only the short form. */
export function authorityInstruction({ long = null, short, category = 1, bold = false, italic = false }) {
  const parts = ['TA'];
  if (long) parts.push('\\l', quote(long));
  if (short) parts.push('\\s', quote(short));
  if (long) parts.push('\\c', String(category));
  if (bold) parts.push('\\b');
  if (italic) parts.push('\\i');
  return ` ${parts.join(' ')} `;
}

/** TOA options: { category, passim, keepFormatting, headings, entrySeparator, pageSeparator, rangeSeparator, extra }. */
export function parseTableInstruction(instruction) {
  const options = { category: 1, passim: false, keepFormatting: true, headings: false, entrySeparator: '\t', pageSeparator: ', ', rangeSeparator: '–', extra: [] };
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return options; }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], arg = tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('\\') ? tokens[i + 1] : null;
    const take = () => { if (arg !== null) i++; return arg; };
    if (t === '\\c') options.category = Math.max(1, Math.min(16, Number(take()) || 1));
    else if (t === '\\p') options.passim = true;
    else if (t === '\\f') options.keepFormatting = false;
    else if (t === '\\h') options.headings = true;
    else if (t === '\\e') options.entrySeparator = take() ?? '\t';
    else if (t === '\\l') options.pageSeparator = take() ?? ', ';
    else if (t === '\\g') options.rangeSeparator = take() ?? '–';
    else options.extra.push(arg !== null ? `${t} ${quote(take())}` : t);
  }
  return options;
}

export function tableInstruction(options = {}) {
  const o = { category: 1, passim: false, keepFormatting: true, headings: true, entrySeparator: '\t', pageSeparator: ', ', ...options };
  const parts = ['TOA', '\\h', '\\c', quote(String(o.category))];
  if (!o.headings) parts.splice(1, 1);
  if (o.passim) parts.push('\\p');
  if (!o.keepFormatting) parts.push('\\f');
  if (o.entrySeparator !== '\t') parts.push('\\e', quote(o.entrySeparator));
  if (o.pageSeparator !== ', ') parts.push('\\l', quote(o.pageSeparator));
  for (const extra of o.extra || []) parts.push(extra);
  return ` ${parts.join(' ')} `;
}

/** Authority marks in document order with their parsed fields. */
export function authorityMarks(paragraphs) {
  return bodyFieldRanges(paragraphs).filter(r => r.field.type === 'TA').map(r => ({ ...r, authority: parseAuthority(r.field.instruction) })).filter(r => r.authority);
}

/** Authorities by long citation: [{ long, short, category, marks }]; short-only marks join the authority with that short form. */
export function authorities(paragraphs) {
  const marks = authorityMarks(paragraphs), list = [];
  for (const mark of marks) {
    const a = mark.authority;
    let owner = a.long ? list.find(x => x.long === a.long) : list.find(x => x.short && x.short === a.short);
    if (!owner && a.long) list.push(owner = { long: a.long, short: a.short || a.long, category: a.category, marks: [] });
    if (!owner) continue; // A short form without its long form is not listed.
    owner.marks.push(mark);
  }
  return list;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Rows of one category's table: [{ runs, heading? }]. `pageOf` maps positions to printed pages. */
export function tableRows(doc, options, pageOf) {
  const rows = [];
  const entries = authorities(doc.paragraphs).filter(a => a.category === options.category).sort((a, b) => collator.compare(a.long, b.long));
  if (options.headings && entries.length) rows.push({ heading: true, runs: [{ text: TOA_CATEGORIES[options.category - 1] }] });
  for (const entry of entries) {
    const pages = [];
    for (const mark of entry.marks) {
      const page = pageOf(mark.start, mark.startParagraph);
      if (page && !pages.some(p => p.text === page.text)) pages.push({ ...page, bold: mark.authority.bold, italic: mark.authority.italic });
    }
    pages.sort((a, b) => a.number - b.number);
    const pageRuns = options.passim && pages.length >= 5 ? [{ text: 'passim', italic: true }]
      : pages.flatMap((p, i) => [...(i ? [{ text: options.pageSeparator }] : []), { text: p.text, ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}) }]);
    rows.push({ runs: [{ text: entry.long.replace(/[\r\n]+/g, ' ') }, ...(pageRuns.length ? [{ text: options.entrySeparator }, ...pageRuns] : [])] });
  }
  return rows;
}

export function tableParagraphs(doc, rows, { leader = 'dot' } = {}) {
  const width = Math.max(1440, doc.sectionWritingWidth);
  if (!rows.length) return [{ style: 'Table of Authorities', runs: [{ text: 'No table of authorities entries found.' }], format: { indentLeft: 0, firstLine: 0, spaceAfter: 6 } }];
  return rows.map(row => row.heading
    ? { style: 'TOA Heading', runs: row.runs, format: { spaceBefore: 12, spaceAfter: 6, keepNext: true }, run: { bold: true, fontSize: 13 } }
    : { style: 'Table of Authorities', runs: row.runs, format: { indentLeft: 240, firstLine: -240, spaceBefore: 0, spaceAfter: 6 }, always: { tabs: [{ position: width, alignment: 'right', leader }] } });
}

/** Insert (or rebuild `existing`) a table of authorities. */
export function writeTableOfAuthorities(doc, { existing = null, options = null, pageOf, leader = 'dot' } = {}) {
  const parsed = options || (existing ? parseTableInstruction(existing.field.instruction) : parseTableInstruction(' TOA \\h \\c "1" '));
  const instruction = tableInstruction(parsed);
  const field = existing && existing.field.instruction === instruction ? existing.field : newBodyField(instruction);
  return writeBlockField(doc, { field, existing, rows: tableParagraphs(doc, tableRows(doc, parsed, pageOf), { leader }) });
}

export const tableFields = paragraphs => fieldsOfType(paragraphs, 'TOA');

/** Mark one citation after the selection (or caret). */
export function markAuthority(doc, options) {
  const known = authorities(doc.paragraphs).find(a => a.long === options.long);
  // A second mark of the same authority only needs its short form.
  const instruction = authorityInstruction(known ? { short: known.short, bold: options.bold, italic: options.italic } : options);
  return insertEntryField(doc, instruction, doc.range[1]);
}

/** Mark every occurrence of the short and long forms; returns the count. */
export function markAllAuthorities(doc, options) {
  let count = 0;
  const forms = [...new Set([options.short, options.long].filter(Boolean))];
  const existing = new Set(authorityMarks(doc.paragraphs).map(r => r.start));
  const positions = new Set();
  for (const form of forms) for (const match of doc.findMatches(form, { matchCase: true })) positions.add(match.end);
  const first = !authorities(doc.paragraphs).some(a => a.long === options.long);
  const sorted = [...positions].sort((a, b) => a - b).filter(at => !existing.has(at));
  // The first mark (document order) gets the long form; insert from the end so positions stay valid.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const instruction = authorityInstruction(i === 0 && first ? options : { short: options.short || options.long, bold: options.bold, italic: options.italic });
    insertEntryField(doc, instruction, sorted[i]); count++;
  }
  return count;
}
