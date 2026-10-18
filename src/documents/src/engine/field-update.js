// Updating sequence and cross-reference fields (ECMA-376 Part 1 §17.16.5.56
// SEQ, §17.16.5.51 REF) the way Update Field does: SEQ results count their
// identifier in document order; REF results repeat their bookmark's text.
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { formatPageNumber } from './page-numbering.js';
import { formulaResult } from './table-formula.js';
import { fieldResultPlan } from './field-results.js';
import { noteKindOf } from './footnotes.js';

/** The first note reference mark within [start, end]: { kind, id }. */
function noteMarkIn(paragraphs, start, end) {
  let at = 0;
  for (const p of paragraphs) {
    for (const run of p.runs) {
      const kind = noteKindOf(run);
      if (kind && at >= start && at < Math.max(end, start + 1)) return { kind, id: run.noteMark.id };
      at += run.text.length;
    }
    at++;
    if (at > end + 1) break;
  }
  return null;
}

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

/**
 * The text each SEQ/REF/NOTEREF field should show now: [{ range, text }] where it differs. `notes`
 * gives the displayed note numbers ({ footnote: Map, endnote: Map }) for NOTEREF (§17.16.5.40).
 */
export function fieldUpdatePlan(model, { onIssue = () => {}, notes = null } = {}) {
  const ranges = bodyFieldRanges(model.paragraphs), text = model.text, changes = [];
  const counters = new Map();
  const bookmarks = new Map(bookmarkEntries(model.paragraphs, model.tables).map(b => [b.name, b]));
  // ASK and SET assign a value to a name during a mail merge without creating a bookmark;
  // a REF to such a name keeps its cached result (the merge evaluates it).
  const mergeNames = new Set(ranges.filter(r => ['ASK', 'SET'].includes(r.field.type)).map(r => /^\s*\w+\s+("?)([^\s"]+)\1/.exec(r.field.instruction)?.[2]).filter(Boolean));
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
      if (!bookmark && mergeNames.has(tokens[0])) continue;
      if (!bookmark) value = 'Error! Reference source not found.';
      else if (bookmark.start <= range.start && range.start < bookmark.end || range.start < bookmark.start && bookmark.start < range.end) {
        retain('A REF within its source bookmark cannot be refreshed yet'); continue;
      } else if (relative) value = range.end <= bookmark.start ? 'below' : 'above';
      else {
        value = text.slice(bookmark.start, Math.min(bookmark.end, text.length));
        if (bookmark.columnRange || /[\n￼]/.test(value)) { retain('A REF with structural or object content cannot be refreshed yet'); continue; }
      }
    } else if (type === '=') value = formulaResult(model, range.field.instruction, range.cellId || null);
    else if (type === 'NOTEREF' && notes) {
      let tokens; try { tokens = fieldInstructionTokens(range.field.instruction).slice(1); } catch { continue; }
      if (tokens.slice(1).some(t => !['\\h', '\\f', '\\p'].includes(t) && !/^\\\*$/.test(t) && t.toUpperCase() !== 'MERGEFORMAT')) { onIssue({ id: range.field.id, message: 'This NOTEREF uses switches that cannot be refreshed yet; its cached result is retained.' }); continue; }
      const bookmark = bookmarks.get(tokens[0]);
      if (!bookmark) value = 'Error! Reference source not found.';
      else {
        // The bookmark encloses a note reference mark; show that note's number.
        const ref = noteMarkIn(model.paragraphs, bookmark.start, bookmark.end);
        if (!ref) { onIssue({ id: range.field.id, message: 'A NOTEREF bookmark without a note reference keeps its cached result.' }); continue; }
        value = notes[ref.kind]?.get(ref.id);
        if (value === undefined) continue;
        if (tokens.includes('\\p')) value = `${value} ${range.end <= bookmark.start ? 'below' : 'above'}`;
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
  let applied = 0;
  try {
    for (const { range, text } of [...changes].reverse()) {
      // A result never spans a paragraph mark: replacing one that does would merge paragraphs.
      if (model.text.slice(range.start, range.end).includes('\n')) continue;
      model.select(range.start, range.end);
      model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
      model.replace(text, { checkpoint: false });
      applied++;
    }
  } finally { model.trackChanges = tracking; }
  if (applied) model.didChange();
  return applied;
}
