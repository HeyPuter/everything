// Generated tables of contents and tables of figures (ECMA-376 Part 1
// §17.16.5.68 TOC, §17.16.5.45 PAGEREF, §17.16.5.63 TC). Entries come from
// outline levels (\o, \u), custom style mappings (\t), caption sequences (\c,
// \a) and TC entries (\f, \l). Each source paragraph gets a hidden _Toc
// bookmark; an entry links to it (\h) and its page number is a PAGEREF result
// refreshed from the current layout. Instructions round-trip as authored.
import { outlineEntries } from './outline.js';
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries, newBookmarkMarkers } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { newBodyField, fieldSpan, fieldsOfType, fieldsWithin, writeBlockField, paragraphLength as length, paragraphOffset, paragraphStyleNamed } from './generated-fields.js';
import { sequenceInstruction } from './field-update.js';

export { newBodyField };
export const TOC_INSTRUCTION = ' TOC \\o "1-3" \\h \\z \\u ';
export const TOC_TITLES = { contents: 'Contents', table: 'Table of Contents' };
/** Tab leaders a table can use between an entry and its page number (§17.18.85). */
export const TOC_LEADERS = { dot: 'Dots', hyphen: 'Dashes', underscore: 'Line', middleDot: 'Middle dots', none: 'None' };

/** Original table designs offered in the gallery. They differ only in direct formatting and options. */
export const TOC_DESIGNS = [
  { id: 'classic', name: 'Classic', title: 'Contents', leader: 'dot', levels: 3, description: 'Dotted leaders to right-aligned page numbers' },
  { id: 'open', name: 'Open', title: 'Table of Contents', leader: 'none', levels: 3, boldTop: true, description: 'Bold chapters, page numbers at the right margin' },
  { id: 'ruled', name: 'Ruled', title: 'Contents', leader: 'underscore', levels: 2, boldTop: true, description: 'Two levels with solid leaders' },
  { id: 'compact', name: 'Compact', title: 'Contents', leader: 'dot', levels: 3, rightAlign: false, description: 'Numbers follow each entry; no tab' },
  { id: 'web', name: 'Linked', title: 'Contents', leader: 'none', levels: 3, pageNumbers: false, description: 'Links only, for documents read on screen' },
];

const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const range = text => { const m = /^\s*(\d)\s*(?:-\s*(\d))?\s*$/.exec(text || ''); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null; };

/** The options a TOC instruction states. Unknown switches are kept in `extra` so a rebuild keeps them. */
export function parseTocInstruction(instruction) {
  const options = { headingRange: null, outline: false, styles: [], hyperlinks: false, hideInWeb: false, omitPageNumbers: null, separator: null,
    caption: null, captionNoLabel: null, tcIdentifier: null, tcLevels: null, bookmark: null, extra: [] };
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return { ...options, unparsed: true }; }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], next = tokens[i + 1], arg = next !== undefined && !next.startsWith('\\') ? next : null;
    const take = () => { if (arg !== null) i++; return arg; };
    if (t === '\\o') options.headingRange = range(take()) || [1, 9];
    else if (t === '\\u') options.outline = true;
    else if (t === '\\h') options.hyperlinks = true;
    else if (t === '\\z') options.hideInWeb = true;
    else if (t === '\\n') options.omitPageNumbers = range(take()) || [1, 9];
    else if (t === '\\p') options.separator = take() ?? ' ';
    else if (t === '\\c') options.caption = take() || 'Figure';
    else if (t === '\\a') options.captionNoLabel = take() || 'Figure';
    else if (t === '\\f') options.tcIdentifier = take() || 'C';
    else if (t === '\\l') options.tcLevels = range(take()) || [1, 9];
    else if (t === '\\b') options.bookmark = take();
    else if (t === '\\t') {
      const list = (take() || '').split(/[,;]/).map(s => s.trim());
      for (let k = 0; k + 1 < list.length; k += 2) if (list[k] && /^[1-9]$/.test(list[k + 1])) options.styles.push({ name: list[k], level: Number(list[k + 1]) });
    } else options.extra.push(arg !== null ? `${t} ${quote(take())}` : t);
  }
  return options;
}

/** Build an instruction from options (the inverse of parseTocInstruction). */
export function tocInstruction(options = {}) {
  const parts = ['TOC'];
  if (options.headingRange) parts.push(`\\o ${quote(options.headingRange.join('-'))}`);
  if (options.styles?.length) parts.push(`\\t ${quote(options.styles.map(s => `${s.name},${s.level}`).join(','))}`);
  if (options.caption) parts.push(`\\c ${quote(options.caption)}`);
  if (options.captionNoLabel) parts.push(`\\a ${quote(options.captionNoLabel)}`);
  if (options.tcIdentifier) parts.push(`\\f ${options.tcIdentifier}`);
  if (options.tcLevels) parts.push(`\\l ${quote(options.tcLevels.join('-'))}`);
  if (options.bookmark) parts.push(`\\b ${options.bookmark}`);
  if (options.hyperlinks) parts.push('\\h');
  if (options.hideInWeb) parts.push('\\z');
  if (options.omitPageNumbers) parts.push(options.omitPageNumbers[0] === 1 && options.omitPageNumbers[1] === 9 ? '\\n' : `\\n ${quote(options.omitPageNumbers.join('-'))}`);
  if (options.separator !== null && options.separator !== undefined) parts.push(`\\p ${quote(options.separator)}`);
  if (options.outline) parts.push('\\u');
  for (const extra of options.extra || []) parts.push(extra);
  return ` ${parts.join(' ')} `;
}

/** Options for a new table of contents from the dialog's choices. */
export function contentsOptions({ levels = 3, hyperlinks = true, pageNumbers = true, rightAlign = true, headingStyles = true, outline = true, styles = [] } = {}) {
  return { headingRange: headingStyles ? [1, levels] : null, outline, styles, hyperlinks, hideInWeb: true,
    omitPageNumbers: pageNumbers ? null : [1, 9], separator: rightAlign || !pageNumbers ? null : ' ', caption: null, captionNoLabel: null, tcIdentifier: null, tcLevels: null, bookmark: null, extra: [] };
}

// A caption label's SEQ identifier: Insert Caption numbers "My Chart" as SEQ My_Chart (see captions.js).
const sequenceIdentifier = label => String(label).trim().replace(/\s+/g, '_');

/** Options for a table of figures listing the captions labelled `label` (\c and \a name the SEQ identifier). */
export function figuresOptions({ label = 'Figure', includeLabel = true, hyperlinks = true, pageNumbers = true, rightAlign = true } = {}) {
  const id = sequenceIdentifier(label);
  return { ...contentsOptions({ hyperlinks, pageNumbers, rightAlign, headingStyles: false, outline: false }), caption: includeLabel ? id : null, captionNoLabel: includeLabel ? null : id };
}

/** Every TOC field in the document with its span and parsed options; `figures` tells tables of figures apart. */
export function tocFields(paragraphs) {
  return fieldsOfType(paragraphs, 'TOC').map(r => { const options = parseTocInstruction(r.field.instruction); return { ...r, options, figures: !!(options.caption || options.captionNoLabel) }; });
}

/** The first table of contents in the document with its paragraph span, or null. */
export function tableOfContents(paragraphs, { figures = false } = {}) {
  return tocFields(paragraphs).find(r => r.figures === figures) || (figures ? null : tocFields(paragraphs)[0] || null);
}

/** Headings for the table: outline levels 1..levels, excluding text inside an existing TOC result. */
export function tocHeadings(paragraphs, levels = 3, exclude = null) {
  return outlineEntries(paragraphs).filter(e => e.level <= levels && e.text !== '(Empty heading)' && !(exclude && e.start >= exclude.start && e.start <= exclude.end));
}

const clean = text => text.replace(/[\t\v\f\u000e￼]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The entries `options` collect from `doc`: [{ level, text, start, end, paragraphId, offset, endOffset, point }]. */
export function tocEntries(doc, options) {
  const paragraphs = doc.paragraphs, ranges = bodyFieldRanges(paragraphs);
  const excluded = ranges.filter(r => r.field.type === 'TOC').map(r => [r.start, r.end]);
  const inside = at => excluded.some(([a, b]) => at >= a && at <= b);
  const scope = options.bookmark ? bookmarkEntries(paragraphs, doc.tables).find(b => b.name === options.bookmark) : null;
  const inScope = at => !scope || at >= scope.start && at <= scope.end;
  const styleLevels = new Map((options.styles || []).map(s => [s.name.toLowerCase(), s.level]));
  const entries = [];
  let at = 0;
  const captionLabel = options.caption || options.captionNoLabel;
  const sequences = captionLabel ? new Map(ranges.filter(r => r.field.type === 'SEQ' && sequenceInstruction(r.field.instruction)?.id.toLowerCase() === sequenceIdentifier(captionLabel).toLowerCase()).map(r => [r.startParagraph, r])) : null;
  for (const p of paragraphs) {
    const size = length(p), text = clean(p.runs.map(r => r.image ? '' : r.text).join(''));
    if (text && !inside(at) && inScope(at)) {
      let level = null;
      if (sequences) {
        const seq = sequences.get(p.id);
        if (seq) {
          level = 1;
          let shown = text;
          if (options.captionNoLabel) {
            // Without its label and number: the text after the sequence number and its separator.
            const tail = p.runs.map(r => r.text).join('').slice(seq.end - at);
            shown = clean(tail.replace(/^\s*[:.\-–—]?\s*/, '')) || text;
          }
          entries.push({ level, text: shown, start: at, end: at + size, paragraphId: p.id });
        }
      } else {
        const outline = p.format?.outlineLevel ?? 9;
        const name = (p.resolvedStyleName || '').toLowerCase();
        if (styleLevels.has(name)) level = styleLevels.get(name);
        else if (outline < 9 && (options.outline || options.headingRange)) {
          const [low, high] = options.headingRange || [1, 9];
          if (outline + 1 >= low && outline + 1 <= high) level = outline + 1;
        }
        if (level) entries.push({ level, text, start: at, end: at + size, paragraphId: p.id });
      }
    }
    at += size + 1;
  }
  if (options.tcIdentifier) {
    for (const r of ranges) {
      if (r.field.type !== 'TC' || inside(r.start) || !inScope(r.start)) continue;
      const tc = parseTcInstruction(r.field.instruction);
      if (!tc || (tc.identifier || 'C').toUpperCase() !== options.tcIdentifier.toUpperCase()) continue;
      const [low, high] = options.tcLevels || [1, 9];
      if (tc.level < low || tc.level > high) continue;
      entries.push({ level: tc.level, text: tc.text, start: r.start, end: r.start, paragraphId: r.startParagraph, point: true, noPage: tc.noPage });
    }
    entries.sort((a, b) => a.start - b.start);
  }
  return entries;
}

/** Parse a TC entry (§17.16.5.63): its text, \f identifier, \l level and \n (no page number). */
export function parseTcInstruction(instruction) {
  let tokens; try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return null; }
  if (!tokens.length || tokens[0].startsWith('\\')) return null;
  const result = { text: tokens[0], identifier: null, level: 1, noPage: false };
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === '\\f') result.identifier = tokens[++i] || 'C';
    else if (tokens[i] === '\\l') { const level = Number(tokens[++i]); if (level >= 1 && level <= 9) result.level = level; }
    else if (tokens[i] === '\\n') result.noPage = true;
  }
  return result;
}

function entryBookmark(doc, entry) {
  const paragraphs = doc.paragraphs, marks = bookmarkEntries(paragraphs, doc.tables);
  const existing = marks.find(b => /^_Toc/.test(b.name) && b.startParagraph === entry.paragraphId && b.start === entry.start && b.end === entry.end);
  if (existing) return existing.name;
  const names = new Set(marks.map(b => b.name));
  let name;
  do name = `_Toc${String(100000000 + Math.floor(Math.random() * 899999999))}`; while (names.has(name));
  const markers = newBookmarkMarkers(paragraphs, name), index = paragraphs.findIndex(item => item.id === entry.paragraphId), p = paragraphs[index];
  const base = paragraphOffset(doc, index);
  (p.bookmarks ||= []).push({ ...markers[0], offset: entry.start - base }, { ...markers[1], offset: entry.end - base });
  return name;
}

/** Leader and alignment a table already shows, so a rebuild keeps its look. */
export function tocAppearance(doc, span) {
  const p = span && doc.paragraphs[span.first];
  const right = p?.format?.tabs?.find(t => t.alignment === 'right');
  const top = span && doc.paragraphs.slice(span.first, span.last + 1).find(q => !(q.format?.indentLeft > 0));
  return { leader: right ? right.leader || 'none' : 'dot', rightAlign: !!right || !span?.options?.separator, boldTop: !!top?.runs?.some(r => r.text.trim() && r.bold && !r.styleId) };
}

/**
 * Insert a table of contents at the caret (or rebuild `existing`) in `doc` (a TextDocument).
 * Call inside one editor transaction; page numbers start as "1" until refreshed.
 */
export function insertTableOfContents(doc, { title = TOC_TITLES.contents, levels = 3, existing = null, options: requested = null, leader = null, rightAlign = null, boldTop = null } = {}) {
  if (existing && !existing.whole) throw new Error('This table of contents shares its paragraphs with other text, so it cannot be rebuilt. Its page numbers can still be updated.');
  const options = requested || (existing ? parseTocInstruction(existing.field.instruction) : parseTocInstruction(TOC_INSTRUCTION.replace('1-3', `1-${levels}`)));
  const appearance = existing ? tocAppearance(doc, { ...existing, options }) : { leader: 'dot', rightAlign: !options.separator, boldTop: false };
  leader ??= appearance.leader; rightAlign ??= appearance.rightAlign; boldTop ??= appearance.boldTop;
  const figures = !!(options.caption || options.captionNoLabel);
  // Bookmarks first: they are paragraph-relative, so writing the table does not move them.
  const entries = tocEntries(doc, options).map(e => ({ ...e, name: entryBookmark(doc, e) }));
  const width = Math.max(1440, doc.sectionWritingWidth);
  const showPage = level => !options.omitPageNumbers || level < options.omitPageNumbers[0] || level > options.omitPageNumbers[1];
  const separator = options.separator ?? '\t';
  const rows = entries.map(entry => {
    const page = showPage(entry.level) && !entry.noPage;
    const tabs = page && separator === '\t' && rightAlign ? [{ position: Math.round(width), alignment: 'right', leader: leader === 'none' ? 'none' : leader }] : [];
    return {
      style: figures ? 'Table of Figures' : `TOC ${entry.level}`,
      runs: [{ text: entry.text, ...(boldTop && entry.level === 1 ? { bold: true } : {}) }, ...(page ? [{ text: separator }, { text: '1', pageRef: entry.name }] : [])],
      link: options.hyperlinks ? entry.name : null,
      format: { indentLeft: figures ? 0 : (entry.level - 1) * 220, firstLine: 0, spaceBefore: boldTop && entry.level === 1 ? 6 : 0, spaceAfter: 5 },
      always: { tabs },
    };
  });
  if (!rows.length) rows.push({ style: figures ? 'Table of Figures' : 'TOC 1', runs: [{ text: figures ? 'No table of figures entries found.' : 'No table of contents entries found.' }], format: { indentLeft: 0, firstLine: 0, spaceBefore: 0, spaceAfter: 5 } });
  const before = title && !existing ? [{ style: 'TOC Heading', runs: [{ text: title }], format: { spaceBefore: 12, spaceAfter: 6, keepNext: true }, run: { fontSize: 16, color: '2F5496' } }] : [];
  // A rebuild keeps the authored envelope unless the options changed its instruction.
  const instruction = tocInstruction(options);
  const field = existing && (!requested || parseTocInstruction(existing.field.instruction).unparsed || tocInstruction(parseTocInstruction(existing.field.instruction)) === instruction) ? existing.field : newBodyField(instruction);
  const result = writeBlockField(doc, { field, existing, rows, before });
  doc.hasTocFields = true;
  return { entries: entries.length, range: result };
}

/** Remove a table of contents (the first one by default) and the title paragraph this editor puts above it. */
export function removeTableOfContents(doc, target = tableOfContents(doc.paragraphs)) {
  const toc = target;
  if (!toc?.whole) return false;
  let start = toc.paragraphStart, first = toc.first;
  const before = doc.paragraphs[toc.first - 1];
  const titles = [...Object.values(TOC_TITLES), ...TOC_DESIGNS.map(d => d.title)];
  const heading = paragraphStyleNamed(doc, 'TOC Heading');
  if (before && (titles.includes(before.runs.map(r => r.text).join('')) || heading && before.styleId === heading)) { start -= length(before) + 1; first--; }
  const end = toc.paragraphEnd, removedBodyFields = fieldsWithin(doc, toc.start, toc.end);
  // Remove whole paragraphs without merging a neighbour into the table's formatting:
  // take the separator before the table, or, at the start, give the next paragraph back its own.
  if (start > 0) { doc.select(start - 1, end); doc.replaceUntracked('', { checkpoint: false, removedBodyFields }); }
  else if (end < doc.text.length) {
    const next = structuredClone(doc.paragraphs[toc.last + 1]);
    doc.select(0, end + 1); doc.replaceUntracked('', { checkpoint: false, removedBodyFields });
    const merged = doc.paragraphs[0];
    doc.paragraphs[0] = { ...next, runs: merged.runs, ...(merged.bookmarks ? { bookmarks: merged.bookmarks } : {}), ...(merged.fieldMarkers ? { fieldMarkers: merged.fieldMarkers } : {}) };
    if (!merged.bookmarks) delete doc.paragraphs[0].bookmarks;
    if (!merged.fieldMarkers) delete doc.paragraphs[0].fieldMarkers;
  } else { doc.select(0, end); doc.replaceUntracked('', { checkpoint: false, removedBodyFields }); }
  doc.select(Math.min(Math.max(0, start - 1), doc.text.length));
  doc.didChange();
  return first >= 0;
}

/** Page-number refresh scope for a table: the PAGEREF fields inside it. */
export function tocPageReferences(doc, span) {
  return new Set(bodyFieldRanges(doc.paragraphs).filter(r => r.field.type === 'PAGEREF' && r.start >= span.start && r.end <= span.end).map(r => r.field.id));
}

export { fieldSpan };
