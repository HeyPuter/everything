// Fields whose cached result this editor generates (ECMA-376 Part 1 §17.16.4.1,
// §17.16.5): a block field (TOC, INDEX, TOA, BIBLIOGRAPHY) owns whole result
// paragraphs between its begin and end delimiters; an inline field (CITATION)
// owns a span of one paragraph. Results are ordinary runs between zero-width
// field markers, so the DOCX writer emits begin/instr/separate/result/end.
import { bodyFieldRanges, ENTRY_FIELDS } from './body-fields.js';
import { bodyFieldInstruction } from './docx-body-fields.js';
import { pageFieldSegments } from './docx-page-fields.js';
import { hyperlinkId } from './hyperlinks.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const attr = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let fieldCount = 0, markerOrder = 5e6;

export const paragraphLength = p => p.runs.reduce((n, r) => n + r.text.length, 0);
export const paragraphText = p => p.runs.map(r => r.text).join('');
export const nextMarkerOrder = () => markerOrder++;
export { ENTRY_FIELDS };

/** A new body field record, as the reader would produce for a w:fldSimple with this instruction. */
export function newBodyField(instruction, { simple = false } = {}) {
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}"><w:fldSimple w:instr="${attr(instruction)}"/></w:p>`, 'application/xml').documentElement;
  const [segment] = pageFieldSegments(root, bodyFieldInstruction);
  if (!segment?.field) throw new Error('Invalid field instruction.');
  return { ...segment.field, id: `newField${++fieldCount}`, ...(simple ? { simple: true } : {}) };
}

/** Document offset of paragraph `index`. */
export function paragraphOffset(doc, index) {
  let at = 0; for (let i = 0; i < index; i++) at += paragraphLength(doc.paragraphs[i]) + 1;
  return at;
}
/** Index of the paragraph containing document position `position`. */
export function paragraphIndexAt(doc, position) {
  let i = 0, at = 0;
  while (i < doc.paragraphs.length - 1 && at + paragraphLength(doc.paragraphs[i]) < position) at += paragraphLength(doc.paragraphs[i++]) + 1;
  return i;
}

/** A field range with its paragraph span; `whole` when its result fills whole paragraphs. */
export function fieldSpan(paragraphs, range) {
  const first = paragraphs.findIndex(p => p.id === range.startParagraph), last = paragraphs.findIndex(p => p.id === range.endParagraph);
  let at = 0; for (let i = 0; i < first; i++) at += paragraphLength(paragraphs[i]) + 1;
  let end = at; for (let i = first; i <= last; i++) end += paragraphLength(paragraphs[i]) + (i < last ? 1 : 0);
  return { ...range, first, last, whole: range.start === at && range.end === end, paragraphStart: at, paragraphEnd: end };
}

/** Every field of `type` (outermost first, in document order) with its paragraph span. */
export function fieldsOfType(paragraphs, type) {
  return bodyFieldRanges(paragraphs).filter(r => r.field.type === type).map(r => fieldSpan(paragraphs, r));
}

/** The field of `type` containing `position`, else null. */
export function fieldAt(paragraphs, type, position) {
  return fieldsOfType(paragraphs, type).find(r => r.start <= position && position <= r.end) || null;
}

export const fieldsWithin = (doc, start, end) => new Set(bodyFieldRanges(doc.paragraphs).filter(r => r.start >= start && r.end <= end).map(r => r.field.id));

const styleNamed = (doc, name) => {
  if (!name) return null;
  const lower = name.toLowerCase();
  return Object.values(doc.styles?.definitions || {}).find(s => s.type === 'paragraph' && s.name?.toLowerCase() === lower)?.id || null;
};
export { styleNamed as paragraphStyleNamed };

function selectParagraph(doc, index) {
  const start = paragraphOffset(doc, index);
  doc.select(start, start + paragraphLength(doc.paragraphs[index]));
  return start;
}

/**
 * Write a block field's result. `rows` are [{ runs: [{ text, italic, bold, pageRef }], style, format, run, link }]:
 * `style` names a paragraph style used when the document has it, otherwise `format`/`run` apply directly;
 * `link` makes the row a hyperlink to that bookmark; a run with `pageRef` becomes a PAGEREF to that bookmark.
 * With `existing` (a whole-paragraph span from fieldSpan) the old result is replaced in place, else the
 * result is inserted as new paragraphs at the caret. `before` rows (such as a title) precede the field.
 * Call inside one editor transaction. Returns the new field's range.
 */
export function writeBlockField(doc, { field, existing = null, rows, before = [] }) {
  if (!rows.length) throw new Error('A generated field needs at least one result paragraph.');
  let insertAt;
  doc.typingFormat = {}; doc.typingStyle = null; doc.typingDirectCleared = true;
  if (existing) {
    if (!existing.whole) throw new Error('This field shares its paragraphs with other text, so it cannot be rebuilt. Its page numbers can still be updated.');
    field ||= existing.field;
    // Empty the old result but keep one of its paragraphs, so neither neighbour
    // takes on the result's paragraph formatting. Nested fields go with it.
    insertAt = existing.paragraphStart;
    doc.select(existing.paragraphStart, existing.paragraphEnd);
    doc.replaceUntracked('', { checkpoint: false, removedBodyFields: fieldsWithin(doc, existing.start, existing.end) });
    // The emptied paragraph still carries the outer field markers: drop them, they are rewritten below.
    const p = doc.paragraphs[paragraphIndexAt(doc, insertAt)];
    if (p.fieldMarkers) { p.fieldMarkers = p.fieldMarkers.filter(m => m.field.id !== field.id && m.field.id !== existing.field.id); if (!p.fieldMarkers.length) delete p.fieldMarkers; }
    before = [];
  } else {
    const [start] = doc.range, index = paragraphIndexAt(doc, start), at = paragraphOffset(doc, index);
    if (doc.paragraphs[index].cellId) throw new Error('Insert this outside a table.');
    insertAt = at;
    if (start > at) { doc.select(start); doc.replaceUntracked('\n', { checkpoint: false }); insertAt = start + 1; }
  }
  const all = [...before, ...rows];
  doc.select(insertAt);
  doc.typingDirectCleared = true;
  doc.replaceUntracked(all.map(row => row.runs.map(r => r.text).join('')).join('\n') + (existing ? '' : '\n'), { checkpoint: false });
  const firstIndex = paragraphIndexAt(doc, insertAt);
  const normal = doc.styles?.defaultParagraph || null;
  const outerStart = nextMarkerOrder();
  const rowIndexes = [];
  all.forEach((row, i) => {
    const index = firstIndex + i, start = selectParagraph(doc, index);
    const style = styleNamed(doc, row.style) || normal;
    if (style && doc.paragraphStyle !== style) doc.setParagraphStyle(style);
    selectParagraph(doc, index);
    const styled = !!styleNamed(doc, row.style);
    if (row.format && (!styled || row.forceFormat)) doc.setParagraphFormat(row.format);
    if (row.always) doc.setParagraphFormat(row.always);
    const length = paragraphLength(doc.paragraphs[index]);
    if (row.run && (!styled || row.forceFormat) && length) { doc.select(start, start + length); doc.setRunFormat(row.run); }
    let offset = 0;
    const pageRefs = [];
    for (const run of row.runs) {
      const a = start + offset, b = a + run.text.length;
      const patch = {};
      if (run.italic !== undefined) patch.italic = run.italic;
      if (run.bold !== undefined) patch.bold = run.bold;
      if (run.verticalAlign) patch.verticalAlign = run.verticalAlign;
      if (Object.keys(patch).length && b > a) { doc.select(a, b); doc.setRunFormat(patch); }
      if (run.pageRef) pageRefs.push({ offset, end: offset + run.text.length, name: run.pageRef, instruction: run.instruction });
      offset += run.text.length;
    }
    const link = row.link ? { anchor: row.link, id: hyperlinkId() } : null;
    if (link && length) doc.changeHyperlink(start, start + length, link);
    for (const ref of pageRefs) {
      const pageref = newBodyField(ref.instruction || ` PAGEREF ${ref.name} \\h `);
      (doc.paragraphs[index].fieldMarkers ||= []).push({ type: 'start', field: pageref, offset: ref.offset, order: nextMarkerOrder(), ...(link ? { link } : {}) },
        { type: 'end', field: pageref, offset: ref.end, order: nextMarkerOrder(), ...(link ? { link } : {}) });
    }
    if (i >= before.length) rowIndexes.push(index);
  });
  const first = doc.paragraphs[rowIndexes[0]], last = doc.paragraphs[rowIndexes.at(-1)];
  first.fieldMarkers = [{ type: 'start', field, offset: 0, order: outerStart }, ...(first.fieldMarkers || [])];
  (last.fieldMarkers ||= []).push({ type: 'end', field, offset: paragraphLength(last), order: nextMarkerOrder() });
  doc.hasBodyFields = true;
  doc.typingDirectCleared = false;
  const range = bodyFieldRanges(doc.paragraphs).find(r => r.field.id === field.id);
  doc.select(paragraphOffset(doc, rowIndexes[0]));
  doc.didChange();
  return fieldSpan(doc.paragraphs, range);
}

/**
 * Write an inline field's result `runs` ([{ text, italic, bold }]): replace `existing`'s result in place,
 * or insert a new field at the caret. Returns the field's range.
 */
export function writeInlineField(doc, { field, existing = null, runs }) {
  const text = runs.map(r => r.text).join('');
  if (text.includes('\n')) throw new Error('An inline field result cannot contain a paragraph break.');
  doc.typingFormat = {}; doc.typingStyle = null; doc.typingDirectCleared = !!existing;
  let start;
  if (existing) {
    field = existing.field; start = existing.start;
    doc.select(existing.start, existing.end);
    if (existing.start === existing.end) { if (text) doc.replaceUntracked(text, { checkpoint: false }); }
    else if (text) doc.replaceUntracked(text, { checkpoint: false });
    else throw new Error('A generated inline result cannot be empty.');
  } else {
    if (!text) throw new Error('A generated inline result cannot be empty.');
    start = doc.range[0];
    if (doc.range[1] > start) doc.replaceUntracked('', { checkpoint: false });
    doc.select(start);
    doc.replaceUntracked(text, { checkpoint: false });
    const index = paragraphIndexAt(doc, start), base = paragraphOffset(doc, index);
    (doc.paragraphs[index].fieldMarkers ||= []).push({ type: 'start', field, offset: start - base, order: nextMarkerOrder() }, { type: 'end', field, offset: start - base + text.length, order: nextMarkerOrder() });
    doc.hasBodyFields = true;
  }
  let offset = start;
  for (const run of runs) {
    const patch = {};
    if (run.italic !== undefined) patch.italic = run.italic;
    if (run.bold !== undefined) patch.bold = run.bold;
    if (run.verticalAlign) patch.verticalAlign = run.verticalAlign;
    if (Object.keys(patch).length && run.text) { doc.select(offset, offset + run.text.length); doc.setRunFormat(patch); }
    offset += run.text.length;
  }
  doc.typingDirectCleared = false;
  const range = bodyFieldRanges(doc.paragraphs).find(r => r.field.id === field.id);
  doc.select(range.end);
  doc.didChange();
  return range;
}

/** Insert a field without a visible result (XE, TA, TC) at `position`. */
export function insertEntryField(doc, instruction, position = doc.range[1]) {
  return insertEntryFields(doc, [{ instruction, position }])[0];
}

/**
 * Insert several entry fields as one change ([{ instruction, position }]; they have no text, so no
 * position moves). The caret ends at the last one. Returns the fields.
 */
export function insertEntryFields(doc, entries) {
  const fields = entries.map(({ instruction }) => {
    const field = newBodyField(instruction);
    if (!ENTRY_FIELDS.has(field.type)) throw new Error('Only index, authority and contents entries have no visible result.');
    return field;
  });
  if (!fields.length) return fields;
  doc.checkpoint();
  entries.forEach(({ position }, i) => {
    const field = fields[i], index = paragraphIndexAt(doc, position), base = paragraphOffset(doc, index), p = doc.paragraphs[index];
    // An entry marked where another field starts goes before that field, not into its result (Word marks the
    // entry beside the text); fields that end here still close before it.
    const offset = position - base, here = [...(p.fieldMarkers || [])].filter(m => m.offset === offset).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const next = here.findIndex(m => m.type === 'start'), high = here[next]?.order ?? 0, low = next > 0 ? here[next - 1].order ?? 0 : high - 1;
    const [startOrder, endOrder] = next < 0 ? [nextMarkerOrder(), nextMarkerOrder()] : [low + (high - low) / 3, low + (high - low) * 2 / 3];
    (p.fieldMarkers ||= []).push({ type: 'start', field, offset, order: startOrder }, { type: 'end', field, offset, order: endOrder });
  });
  doc.hasBodyFields = true;
  bodyFieldRanges(doc.paragraphs);
  doc.select(entries.at(-1).position);
  doc.didChange();
  return fields;
}

/** Remove a field and its whole result (or, for an entry field, just its markers). */
export function removeField(doc, range) {
  if (range.start === range.end) {
    doc.checkpoint();
    for (const p of doc.paragraphs) if (p.fieldMarkers?.some(m => m.field.id === range.field.id)) {
      p.fieldMarkers = p.fieldMarkers.filter(m => m.field.id !== range.field.id);
      if (!p.fieldMarkers.length) delete p.fieldMarkers;
    }
    doc.didChange();
    return true;
  }
  doc.select(range.start, range.end);
  return doc.replaceUntracked('', { checkpoint: false, removedBodyFields: fieldsWithin(doc, range.start, range.end) });
}

/** Replace field `range`'s instruction text (keeping its result and envelope). */
export function setFieldInstruction(doc, range, instruction) {
  const replacement = newBodyField(instruction);
  if (replacement.type !== range.field.type) throw new Error('A field keeps its type when its instruction changes.');
  const field = range.field;
  if (field.instruction === instruction) return false;
  doc.checkpoint();
  // The writer keeps the authored envelope (delimiter properties, lock and dirty
  // flags) and patches its instruction text; new fields have no envelope yet.
  if (field.source && !/^<w:fldSimple\b[^>]*\/>$/.test(field.source.trim())) field.originalInstruction ??= field.instruction;
  else field.source = replacement.source;
  field.instruction = instruction;
  for (const key of ['bookmark', 'bookmarkCodeRange']) { if (key in replacement) field[key] = replacement[key]; else delete field[key]; }
  doc.didChange();
  return true;
}
