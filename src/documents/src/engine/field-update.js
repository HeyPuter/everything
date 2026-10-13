// Updating sequence and cross-reference fields (ECMA-376 Part 1 §17.16.5.56
// SEQ, §17.16.5.51 REF) the way Update Field does: SEQ results count their
// identifier in document order; REF results repeat their bookmark's text.
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { formatPageNumber } from './page-numbering.js';
import { fieldResultPlan } from './field-results.js';

const FORMATS = { ARABIC: 'decimal', ROMAN: 'upperRoman', roman: 'lowerRoman', ALPHABETIC: 'upperLetter', alphabetic: 'lowerLetter' };

/** Parse a SEQ instruction; a general formatting switch overrides result hiding. */
export function sequenceInstruction(instruction) {
  let tokens;
  try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return null; }
  const id = tokens[0];
  if (!id || id.startsWith('\\')) return null;
  const result = { id, format: 'decimal', repeat: false, next: true, reset: null, hidden: false };
  let generalFormatting = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\\*' && tokens[i + 1]) { generalFormatting = true; const f = FORMATS[tokens[i + 1]] ?? FORMATS[tokens[i + 1].toUpperCase()]; if (f) result.format = f; i++; }
    else if (t === '\\c') { result.repeat = true; result.next = false; }
    else if (t === '\\n') result.next = true;
    else if (t === '\\h') result.hidden = true;
    else if (t === '\\r' && /^\d+$/.test(tokens[i + 1] || '')) { result.reset = Number(tokens[i + 1]); i++; }
    else if (t === '\\s') i++; // Chapter numbering is not evaluated.
  }
  result.hidden &&= !generalFormatting;
  return result;
}

/** The text each SEQ/REF field should show now: [{ range, text }] where it differs. */
export function fieldUpdatePlan(model, { onIssue = () => {} } = {}) {
  const ranges = bodyFieldRanges(model.paragraphs), text = model.text, changes = [];
  const counters = new Map();
  const bookmarks = new Map(bookmarkEntries(model.paragraphs, model.tables).map(b => [b.name, b]));
  for (const range of ranges) {
    const type = range.field.type;
    if (range.field.locked || ranges.some(r => r.parentId === range.field.id)) continue;
    let value = null;
    if (type === 'SEQ') {
      const seq = sequenceInstruction(range.field.instruction);
      if (!seq) continue;
      let n = counters.get(seq.id) ?? 0;
      if (seq.reset !== null) n = seq.reset; else if (seq.next) n += 1;
      counters.set(seq.id, n);
      value = seq.hidden ? '' : formatPageNumber(Math.max(0, n), seq.format);
    } else if (type === 'REF') {
      let tokens; try { tokens = fieldInstructionTokens(range.field.instruction).slice(1); } catch { continue; }
      let relative = false, supported = true;
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '\\p') relative = true;
        else if (tokens[i] === '\\h') continue; // Existing hyperlink envelopes remain intact.
        else if (tokens[i] === '\\*' && tokens[i + 1]?.toUpperCase() === 'MERGEFORMAT') i++;
        else { supported = false; break; }
      }
      const retain = reason => onIssue({ id: range.field.id, message: `${reason}; its cached result is retained.` });
      if (!supported) { retain('This REF uses switches that cannot be refreshed yet'); continue; }
      const bookmark = bookmarks.get(tokens[0]);
      if (!bookmark) value = 'Error! Reference source not found.';
      else if (bookmark.start <= range.start && range.start < bookmark.end || range.start < bookmark.start && bookmark.start < range.end) {
        retain('A REF within its source bookmark cannot be refreshed yet'); continue;
      } else if (relative) value = range.end <= bookmark.start ? 'below' : 'above';
      else {
        value = text.slice(bookmark.start, Math.min(bookmark.end, text.length));
        if (bookmark.columnRange || /[\n￼]/.test(value)) { retain('A REF with structural or object content cannot be refreshed yet'); continue; }
      }
    } else continue;
    if (text.slice(range.start, range.end) !== value) changes.push({ range, text: value });
  }
  // Dates, times and document information (field-results.js) refresh in the same pass.
  return [...changes, ...fieldResultPlan(model)].sort((a, b) => a.range.start - b.range.start);
}

/** Apply the plan inside one editor transaction; returns the number of fields updated. */
export function updateSequenceFields(model, options) {
  const changes = fieldUpdatePlan(model, options);
  const tracking = model.trackChanges; model.trackChanges = false;
  try {
    for (const { range, text } of [...changes].reverse()) {
      model.select(range.start, range.end);
      model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
      model.replace(text, { checkpoint: false });
    }
  } finally { model.trackChanges = tracking; }
  if (changes.length) model.didChange();
  return changes.length;
}
