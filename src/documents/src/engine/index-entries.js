// Index entries and generated indexes (ECMA-376 Part 1 §17.16.5.72 XE,
// §17.16.5.29 INDEX). An XE field marks a hidden entry ("Main:Sub") at a
// position; an INDEX field's cached result lists the entries alphabetically
// with the pages they fall on, indented or run-in, with letter headings.
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { fieldsOfType, insertEntryField, insertEntryFields, newBodyField, writeBlockField } from './generated-fields.js';

const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const escapeLevel = text => text.replace(/:/g, '\\:');

/** Parse an XE instruction: { levels, bold, italic, crossReference, bookmark, type, yomi }. */
export function parseEntry(instruction) {
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return null; }
  if (!tokens.length || tokens[0].startsWith('\\')) return null;
  // Colons separate levels; a backslash-escaped colon is literal text.
  const levels = tokens[0].replace(/\\:/g, '\u0000').split(':').map(s => s.replace(/\u0000/g, ':').trim()).filter(Boolean);
  const entry = { levels, bold: false, italic: false, crossReference: null, bookmark: null, type: null, yomi: null };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\\b') entry.bold = true;
    else if (t === '\\i') entry.italic = true;
    else if (t === '\\t') entry.crossReference = tokens[++i] ?? '';
    else if (t === '\\r') entry.bookmark = tokens[++i] ?? null;
    else if (t === '\\f') entry.type = tokens[++i] ?? null;
    else if (t === '\\y') entry.yomi = tokens[++i] ?? null;
  }
  return entry.levels.length ? entry : null;
}

/** An XE instruction from entry options. */
export function entryInstruction({ main, sub = '', third = '', bold = false, italic = false, crossReference = null, bookmark = null, type = null }) {
  const text = [main, sub, third].map(s => String(s || '').trim()).filter(Boolean).map(escapeLevel).join(':');
  if (!text) throw new Error('Type the main entry for the index.');
  const parts = ['XE', quote(text)];
  if (crossReference !== null && crossReference !== undefined) parts.push('\\t', quote(crossReference));
  if (bookmark) parts.push('\\r', bookmark);
  if (bold) parts.push('\\b');
  if (italic) parts.push('\\i');
  if (type) parts.push('\\f', quote(type));
  return ` ${parts.join(' ')} `;
}

/** INDEX options: { columns, runIn, rightAlign, headings, entrySeparator, pageSeparator, rangeSeparator, crossSeparator, type, bookmark, letters, lcid, extra }. */
export function parseIndexInstruction(instruction) {
  const options = { columns: 1, runIn: false, rightAlign: false, headings: null, entrySeparator: ', ', pageSeparator: ', ', rangeSeparator: '–', crossSeparator: '. ', type: null, bookmark: null, letters: null, lcid: null, extra: [] };
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return options; }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], arg = tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('\\') ? tokens[i + 1] : null;
    const take = () => { if (arg !== null) i++; return arg; };
    if (t === '\\c') options.columns = Math.max(1, Math.min(4, Number(take()) || 1));
    else if (t === '\\r') options.runIn = true;
    else if (t === '\\e') { options.entrySeparator = take() ?? ', '; options.rightAlign = options.entrySeparator === '\t'; }
    else if (t === '\\l') options.pageSeparator = take() ?? ', ';
    else if (t === '\\g') options.rangeSeparator = take() ?? '–';
    else if (t === '\\k') options.crossSeparator = take() ?? '. ';
    else if (t === '\\h') options.headings = take() ?? 'A';
    else if (t === '\\f') options.type = take();
    else if (t === '\\b') options.bookmark = take();
    else if (t === '\\p') options.letters = take();
    else if (t === '\\z') options.lcid = take();
    else options.extra.push(arg !== null ? `${t} ${quote(take())}` : t);
  }
  return options;
}

export function indexInstruction(options = {}) {
  const o = { columns: 1, runIn: false, rightAlign: false, headings: null, entrySeparator: ', ', pageSeparator: ', ', rangeSeparator: '–', crossSeparator: '. ', ...options };
  const parts = ['INDEX'];
  if (o.headings) parts.push('\\h', quote(o.headings));
  if (o.runIn) parts.push('\\r');
  if (o.rightAlign) parts.push('\\e', quote('\t'));
  else if (o.entrySeparator !== ', ') parts.push('\\e', quote(o.entrySeparator));
  if (o.pageSeparator !== ', ') parts.push('\\l', quote(o.pageSeparator));
  if (o.rangeSeparator !== '–') parts.push('\\g', quote(o.rangeSeparator));
  if (o.crossSeparator !== '. ') parts.push('\\k', quote(o.crossSeparator));
  if (o.type) parts.push('\\f', quote(o.type));
  if (o.bookmark) parts.push('\\b', o.bookmark);
  if (o.letters) parts.push('\\p', quote(o.letters));
  parts.push('\\c', quote(String(o.columns || 1)));
  parts.push('\\z', quote(o.lcid || '1033'));
  for (const extra of o.extra || []) parts.push(extra);
  return ` ${parts.join(' ')} `;
}

/** Index entry fields with their parsed entry, in document order. */
export function indexEntries(paragraphs) {
  return bodyFieldRanges(paragraphs).filter(r => r.field.type === 'XE').map(r => ({ ...r, entry: parseEntry(r.field.instruction) })).filter(r => r.entry);
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const sortText = node => (node.yomi || node.text).replace(/^[^\p{L}\p{N}]+/u, '');

/**
 * The rows of an index. `pageOf(position, paragraphId)` gives the printed page ({ text, number }) of a
 * position; `options` come from parseIndexInstruction.
 */
export function indexRows(doc, options, pageOf) {
  const scope = options.bookmark ? bookmarkEntries(doc.paragraphs, doc.tables).find(b => b.name === options.bookmark) : null;
  const marks = new Map(bookmarkEntries(doc.paragraphs, doc.tables).map(b => [b.name, b]));
  const root = { children: new Map() };
  for (const r of indexEntries(doc.paragraphs)) {
    const e = r.entry;
    if (options.type && (e.type || 'I') !== options.type) continue;
    if (scope && (r.start < scope.start || r.start > scope.end)) continue;
    let node = root;
    e.levels.slice(0, 3).forEach((text, i) => {
      const key = text.toLowerCase();
      if (!node.children.has(key)) node.children.set(key, { text, yomi: i === 0 ? e.yomi : null, children: new Map(), pages: [], cross: [] });
      node = node.children.get(key);
    });
    if (e.crossReference !== null) { if (!node.cross.includes(e.crossReference)) node.cross.push(e.crossReference); continue; }
    let page;
    const mark = e.bookmark && marks.get(e.bookmark);
    if (mark) {
      const from = pageOf(mark.start, mark.startParagraph), to = pageOf(Math.max(mark.start, mark.end - 1), mark.endParagraph || mark.startParagraph);
      if (from && to) page = from.number === to.number ? { ...from } : { text: `${from.text}${options.rangeSeparator}${to.text}`, number: from.number };
    } else page = pageOf(r.start, r.startParagraph);
    if (!page) continue;
    if (!node.pages.some(p => p.text === page.text)) node.pages.push({ ...page, bold: e.bold, italic: e.italic });
    else { const same = node.pages.find(p => p.text === page.text); same.bold ||= e.bold; same.italic ||= e.italic; }
  }
  const sorted = map => [...map.values()].sort((a, b) => collator.compare(sortText(a), sortText(b)));
  const letters = options.letters ? /^\s*(\S)\s*-\s*(\S)\s*$/.exec(options.letters) : null;
  const pageRuns = node => {
    const runs = [];
    node.pages.sort((a, b) => a.number - b.number).forEach((p, i) => {
      if (i) runs.push({ text: options.pageSeparator });
      runs.push({ text: p.text, ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}) });
    });
    for (const cross of node.cross) {
      runs.push({ text: runs.length ? options.crossSeparator : '' });
      const [see, ...rest] = cross.split(' ');
      runs.push({ text: see, italic: true }, ...(rest.length ? [{ text: ` ${rest.join(' ')}` }] : []));
    }
    return runs;
  };
  const separator = node => node.pages.length || node.cross.length ? [{ text: options.rightAlign && node.pages.length ? '\t' : node.pages.length ? options.entrySeparator : options.crossSeparator }] : [];
  const rows = [];
  let letter = null;
  for (const main of sorted(root.children)) {
    const first = sortText(main)[0]?.toUpperCase() || '';
    if (letters && (first < letters[1].toUpperCase() || first > letters[2].toUpperCase())) continue;
    if (options.headings && first !== letter) {
      letter = first;
      const heading = /\p{L}/u.test(first) ? options.headings.replace(/A/, first) : options.headings.replace(/A/, '#');
      if (heading.trim()) rows.push({ heading: true, level: 0, runs: [{ text: heading }] });
    }
    if (options.runIn) {
      const runs = [{ text: main.text }, ...separator(main), ...pageRuns(main)];
      const subs = sorted(main.children);
      subs.forEach((sub, i) => {
        runs.push({ text: i === 0 ? (main.pages.length || main.cross.length ? '; ' : ': ') : '; ' }, { text: sub.text }, ...separator(sub), ...pageRuns(sub));
      });
      rows.push({ level: 1, runs: runs.filter(r => r.text) });
      continue;
    }
    rows.push({ level: 1, runs: [{ text: main.text }, ...separator(main), ...pageRuns(main)].filter(r => r.text) });
    for (const sub of sorted(main.children)) {
      rows.push({ level: 2, runs: [{ text: sub.text }, ...separator(sub), ...pageRuns(sub)].filter(r => r.text) });
      for (const third of sorted(sub.children)) rows.push({ level: 3, runs: [{ text: third.text }, ...separator(third), ...pageRuns(third)].filter(r => r.text) });
    }
  }
  return rows;
}

/** Paragraph rows for writeBlockField from index rows. */
export function indexParagraphs(doc, rows, { rightAlign = false, leader = 'dot', columns = 1 } = {}) {
  const width = Math.max(1440, Math.round(doc.sectionWritingWidth / Math.max(1, columns)));
  if (!rows.length) return [{ style: 'Index 1', runs: [{ text: 'No index entries found.' }], format: { indentLeft: 0, firstLine: 0, spaceBefore: 0, spaceAfter: 0 } }];
  return rows.map(row => row.heading
    ? { style: 'Index Heading', runs: row.runs, format: { indentLeft: 0, firstLine: 0, spaceBefore: 12, spaceAfter: 3, keepNext: true }, run: { bold: true, fontSize: 13 } }
    : { style: `Index ${row.level}`, runs: row.runs, format: { indentLeft: 200 * row.level, firstLine: -200, spaceBefore: 0, spaceAfter: 0 }, always: { tabs: rightAlign ? [{ position: width, alignment: 'right', leader }] : [] } });
}

/** Insert (or rebuild `existing`) an index. `pageOf` maps positions to printed pages. */
export function writeIndex(doc, { existing = null, options = null, pageOf, leader = 'dot' } = {}) {
  const parsed = options || (existing ? parseIndexInstruction(existing.field.instruction) : parseIndexInstruction(' INDEX '));
  const rows = indexParagraphs(doc, indexRows(doc, parsed, pageOf), { rightAlign: parsed.rightAlign, leader, columns: parsed.columns });
  const instruction = indexInstruction(parsed);
  const field = existing && existing.field.instruction === instruction ? existing.field : newBodyField(instruction);
  return writeBlockField(doc, { field, existing, rows });
}

export const indexFields = paragraphs => fieldsOfType(paragraphs, 'INDEX');

/** Mark one entry after the selection (or caret). */
export function markEntry(doc, options) {
  return insertEntryField(doc, entryInstruction(options), doc.range[1]);
}

/** Mark every occurrence of `text` (whole words, matching case) with the same entry; returns the count. */
export function markAllEntries(doc, text, options) {
  const needle = String(text || '');
  if (!needle.trim()) throw new Error('Select the text to mark first.');
  const instruction = entryInstruction(options);
  const found = doc.findMatches(needle, { matchCase: true, wholeWord: true });
  const marked = new Set(indexEntries(doc.paragraphs).filter(r => r.field.instruction === instruction).map(r => r.start));
  // One change for all of them (from the last, as before, so the caret ends at the first).
  return insertEntryFields(doc, [...found].reverse().filter(match => !marked.has(match.end)).map(match => ({ instruction, position: match.end }))).length;
}
