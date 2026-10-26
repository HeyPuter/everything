// Captions and cross-references as DOCX fields express them: a caption is a paragraph
// "<Label> <SEQ Label>" (§17.16.5.56); a cross-reference is a REF, PAGEREF or NOTEREF
// field (§17.16.5.51, §17.16.5.45, §17.16.5.40) pointing at a hidden _Ref bookmark.
import { bodyFieldRanges, newFieldEndOrder } from './body-fields.js';
import { bookmarkEntries, newBookmarkMarkers } from './bookmarks.js';
import { outlineEntries } from './outline.js';
import { hyperlinkId } from './hyperlinks.js';
import { newBodyField, nextMarkerOrder } from './generated-fields.js';
import { sequenceInstruction, updateSequenceFields } from './field-update.js';
import { noteReferences } from './footnotes.js';

export const CAPTION_LABELS = ['Figure', 'Table', 'Equation'];
/** Caption number formats and their SEQ general-formatting switch (§17.16.4.3). */
export const CAPTION_FORMATS = { ARABIC: '1, 2, 3, …', alphabetic: 'a, b, c, …', ALPHABETIC: 'A, B, C, …', roman: 'i, ii, iii, …', ROMAN: 'I, II, III, …' };
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
const offsetOf = (doc, index) => { let at = 0; for (let i = 0; i < index; i++) at += length(doc.paragraphs[i]) + 1; return at; };
const paragraphAt = (doc, position) => { let i = 0, pos = 0; while (i < doc.paragraphs.length - 1 && pos + length(doc.paragraphs[i]) < position) pos += length(doc.paragraphs[i++]) + 1; return i; };
/** A SEQ identifier for a label: letters, digits and underscores (spaces become underscores). */
export const sequenceId = label => label.trim().replace(/\s+/g, '_');

function addFieldMarkers(p, field, start, end, link) {
  const startOrder = nextMarkerOrder(), endOrder = nextMarkerOrder();
  (p.fieldMarkers ||= []).push({ type: 'start', field, offset: start, order: startOrder, ...(link ? { link } : {}) }, { type: 'end', field, offset: end, order: end > start ? newFieldEndOrder(p, end, endOrder) : endOrder, ...(link ? { link } : {}) });
}

/** Labels in use: the built-in ones, `custom` labels and every SEQ identifier already in the document. */
export function captionLabels(doc, custom = []) {
  const seen = new Map();
  for (const label of [...CAPTION_LABELS, ...custom]) seen.set(sequenceId(label).toLowerCase(), label);
  for (const r of bodyFieldRanges(doc.paragraphs)) {
    if (r.field.type !== 'SEQ') continue;
    const id = sequenceInstruction(r.field.instruction)?.id;
    if (id && !seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), id.replace(/_/g, ' '));
  }
  return [...seen.values()];
}

/**
 * Insert a caption paragraph below (or above) the selected picture, the table at the caret, or the current
 * paragraph. `format` is a SEQ general format (ARABIC, alphabetic, ALPHABETIC, roman, ROMAN); `excludeLabel`
 * leaves only the number visible.
 */
export function insertCaption(doc, { label = 'Figure', text = '', above = false, format = 'ARABIC', excludeLabel = false } = {}) {
  const id = sequenceId(label);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(id)) throw new Error('Use a label of letters and numbers, such as Figure or Table.');
  if (!Object.hasOwn(CAPTION_FORMATS, format)) throw new Error('Choose a caption number format.');
  let index;
  if (doc.tableContext && !doc.selectedImage) {
    doc.insertTableParagraph(!above);
    index = paragraphAt(doc, doc.range[0]);
  } else {
    const at = doc.range[0];
    let i = 0, pos = 0;
    while (i < doc.paragraphs.length - 1 && pos + length(doc.paragraphs[i]) < at) pos += length(doc.paragraphs[i++]) + 1;
    if (above) { doc.select(pos); doc.replaceUntracked('\n', { checkpoint: false }); index = i; }
    else { doc.select(pos + length(doc.paragraphs[i])); doc.replaceUntracked('\n', { checkpoint: false }); index = i + 1; }
  }
  const start = offsetOf(doc, index);
  doc.select(start, start + length(doc.paragraphs[index]));
  const styles = doc.styles?.definitions || {};
  const caption = Object.values(styles).find(s => s.type === 'paragraph' && s.name?.toLowerCase() === 'caption')?.id;
  if (caption) doc.setParagraphStyle(caption);
  else if (doc.styles?.defaultParagraph) doc.setParagraphStyle(doc.styles.defaultParagraph);
  const prefix = excludeLabel ? '' : `${label} `;
  const body = `${prefix}1${text ? `${/^[\s:.\-–—]/.test(text) ? '' : ': '}${text}` : ''}`;
  doc.select(start);
  doc.replaceUntracked(body, { checkpoint: false });
  if (!caption) { doc.select(start, start + body.length); doc.setRunFormat({ italic: true, fontSize: 9, color: '44546A' }); doc.setParagraphFormat({ spaceBefore: 0, spaceAfter: 10, keepNext: above }); }
  const p = doc.paragraphs[index];
  addFieldMarkers(p, newBodyField(` SEQ ${id} \\* ${format} `, { simple: true }), prefix.length, prefix.length + 1);
  doc.hasBodyFields = true;
  bodyFieldRanges(doc.paragraphs);
  updateSequenceFields(doc);
  const after = offsetOf(doc, index) + length(doc.paragraphs[index]);
  doc.select(after);
  doc.didChange();
  return index;
}

/**
 * What can be cross-referenced: headings, captions, named bookmarks and note references.
 * `notes` lists note texts and numbers: [{ kind: 'footnote'|'endnote', id, display, text }].
 */
export function referenceTargets(doc, { notes = [] } = {}) {
  const text = doc.text, ranges = bodyFieldRanges(doc.paragraphs);
  const headings = outlineEntries(doc.paragraphs).filter(e => e.text !== '(Empty heading)').map(e => ({ kind: 'heading', label: e.text, start: e.start, end: e.end, paragraphId: e.id }));
  const captions = [];
  for (const r of ranges) {
    if (r.field.type !== 'SEQ') continue;
    const seq = sequenceInstruction(r.field.instruction);
    if (!seq) continue;
    const pIndex = doc.paragraphs.findIndex(p => p.id === r.startParagraph), start = offsetOf(doc, pIndex);
    const whole = text.slice(start, start + length(doc.paragraphs[pIndex]));
    const rest = text.slice(r.end, start + whole.length), separator = /^\s*[:.\-–—]?\s*/.exec(rest)[0].length;
    const named = value => value.replace(/\uFFFC/g, '');
    captions.push({ kind: seq.id, label: named(whole).trim(), start, end: r.end, numberLabel: named(text.slice(start, r.end)), paragraphId: r.startParagraph,
      paragraphEnd: start + whole.length, textStart: r.end + separator, captionText: named(rest.slice(separator)) });
  }
  const bookmarks = bookmarkEntries(doc.paragraphs, doc.tables).filter(b => !b.name.startsWith('_')).map(b => ({ kind: 'bookmark', label: b.name, name: b.name, start: b.start, end: b.end }));
  const noteTargets = { footnote: [], endnote: [] };
  for (const kind of ['footnote', 'endnote']) {
    for (const ref of noteReferences(doc.paragraphs, kind)) {
      const note = notes.find(n => n.kind === kind && n.id === ref.id);
      noteTargets[kind].push({ kind, id: ref.id, display: note?.display || '', label: `${note?.display ?? ''} ${note?.text ?? ''}`.trim() || `${kind === 'footnote' ? 'Footnote' : 'Endnote'} ${ref.id}`,
        start: ref.position, end: ref.position + 1, paragraphId: ref.paragraphId });
    }
  }
  return { headings, captions, bookmarks, footnotes: noteTargets.footnote, endnotes: noteTargets.endnote };
}

/** The reference choices each kind of target offers. */
export function referenceChoices(kind) {
  if (kind === 'heading') return [['text', 'Heading text'], ['page', 'Page number'], ['position', 'Above/below']];
  if (kind === 'bookmark') return [['text', 'Bookmark text'], ['page', 'Page number'], ['position', 'Above/below']];
  if (kind === 'footnote' || kind === 'endnote') { const name = kind === 'footnote' ? 'Footnote' : 'Endnote'; return [['number', `${name} number`], ['formatted', `${name} number (formatted)`], ['page', 'Page number'], ['position', 'Above/below']]; }
  return [['entire', 'Entire caption'], ['label', 'Only label and number'], ['caption', 'Only caption text'], ['page', 'Page number'], ['position', 'Above/below']];
}

function refBookmark(doc, target, start = target.start, end = target.end) {
  if (target.name) return target.name;
  const existing = bookmarkEntries(doc.paragraphs, doc.tables).find(b => /^_Re?f/.test(b.name) && b.start === start && b.end === end);
  if (existing) return existing.name;
  const names = new Set(bookmarkEntries(doc.paragraphs, doc.tables).map(b => b.name));
  let name; do name = `_Ref${String(100000000 + Math.floor(Math.random() * 899999999))}`; while (names.has(name));
  const markers = newBookmarkMarkers(doc.paragraphs, name);
  const pIndex = doc.paragraphs.findIndex(p => p.id === target.paragraphId), base = offsetOf(doc, pIndex), p = doc.paragraphs[pIndex];
  (p.bookmarks ||= []).push({ ...markers[0], offset: start - base }, { ...markers[1], offset: end - base });
  return name;
}

/** Insert one field with `placeholder` as its result at the caret. */
function insertReferenceField(doc, instruction, placeholder, name, hyperlink) {
  // With Track Changes on, the selection it replaces is marked deleted and the result follows it.
  doc.replace(placeholder, { checkpoint: false });
  const at = doc.selection.focus - placeholder.length;
  const i = paragraphAt(doc, at), pos = offsetOf(doc, i);
  const link = hyperlink ? { anchor: name, id: hyperlinkId() } : null;
  if (link) doc.changeHyperlink(at, at + placeholder.length, link);
  addFieldMarkers(doc.paragraphs[i], newBodyField(instruction), at - pos, at - pos + placeholder.length, link);
  doc.hasBodyFields = true;
  bodyFieldRanges(doc.paragraphs);
  doc.select(at + placeholder.length);
}

/**
 * Insert a cross-reference at the caret. `show`: text | page | position (above/below) | entire | label |
 * caption | number | formatted. `hyperlink` (\h) links the result to its target; `aboveBelow` adds a
 * relative-position reference after it ("Figure 1 below").
 */
export function insertCrossReference(doc, target, { show = 'text', hyperlink = true, aboveBelow = false } = {}) {
  let start = target.start, end = target.end;
  if (show === 'entire' && target.paragraphEnd !== undefined) end = target.paragraphEnd;
  if (show === 'caption' && target.textStart !== undefined) { start = target.textStart; end = target.paragraphEnd; if (start >= end) throw new Error('This caption has no text after its number.'); }
  const name = refBookmark(doc, target, start, end);
  const h = hyperlink ? ' \\h' : '';
  const before = doc.range[0], relativeAt = () => (before < start ? 'below' : 'above');
  if (show === 'page') insertReferenceField(doc, ` PAGEREF ${name}${h} `, '1', name, hyperlink);
  else if (show === 'position') insertReferenceField(doc, ` REF ${name} \\p${h} `, relativeAt(), name, hyperlink);
  else if (show === 'number' || show === 'formatted') {
    insertReferenceField(doc, ` NOTEREF ${name}${show === 'formatted' ? ' \\f' : ''}${h} `, target.display || '1', name, hyperlink);
    if (show === 'formatted') { const at = doc.range[0], n = (target.display || '1').length; doc.select(at - n, at); doc.setRunFormat({ verticalAlign: 'superscript' }); doc.select(at); }
  } else {
    // Notes, pictures, equations and fields in the target are object characters in the text: the result
    // is plain text, so they are left out (kept, they were saved as invisible characters).
    const plain = value => value.replace(/\uFFFC/g, '').replace(/[\n\f\u000e]/g, ' ');
    const placeholder = show === 'label' ? plain(target.numberLabel || target.label) : show === 'entire' || show === 'caption' ? plain(doc.text.slice(start, end)) : (plain(doc.text.slice(start, end)) || target.label || name);
    insertReferenceField(doc, ` REF ${name}${h} `, placeholder || target.label || name, name, hyperlink);
  }
  if (aboveBelow && show !== 'position') {
    doc.replace(' ', { checkpoint: false });
    insertReferenceField(doc, ` REF ${name} \\p${h} `, relativeAt(), name, hyperlink);
  }
  doc.didChange();
  return name;
}
