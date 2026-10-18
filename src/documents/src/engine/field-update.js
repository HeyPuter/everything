// Updating sequence and cross-reference fields (ECMA-376 Part 1 §17.16.5.56
// SEQ, §17.16.5.51 REF) the way Update Field does: SEQ results count their
// identifier in document order; REF results repeat their bookmark's text.
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { formatPageNumber } from './page-numbering.js';
import { formulaResult } from './table-formula.js';
import { fieldResultPlan, applyGeneralFormat } from './field-results.js';
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
// Case conversions of the general formatting switch (§17.16.4.3), applied to the result's text in order.
const CASES = /^(Upper|Lower|Caps|FirstCap)$/i;
const withCases = (text, cases) => cases.reduce(applyGeneralFormat, text);

/** Parse a SEQ instruction; a general formatting switch overrides result hiding. */
export function sequenceInstruction(instruction) {
  let tokens;
  try { tokens = fieldInstructionTokens(instruction).slice(1); } catch { return null; }
  const id = tokens[0];
  if (!id || id.startsWith('\\')) return null;
  // `supported` is false for what this evaluator cannot reproduce (chapter numbering, number pictures, number
  // formats such as CardText or Ordinal): such a field keeps its cached result, though it still counts.
  const result = { id, format: 'decimal', words: null, cases: [], repeat: false, next: true, reset: null, hidden: false, supported: true };
  let generalFormatting = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\\*' && tokens[i + 1]) {
      generalFormatting = true;
      const name = tokens[i + 1], f = FORMATS[name] ?? FORMATS[name.toUpperCase()];
      if (f) { result.format = f; result.words = null; }
      else if (/^(Ordinal|CardText|OrdText)$/i.test(name)) result.words = name;
      else if (CASES.test(name)) result.cases.push(name);
      else if (!/^(MERGEFORMAT|CHARFORMAT)$/i.test(name)) result.supported = false;
      i++;
    }
    else if (t === '\\c') { result.repeat = true; result.next = false; }
    else if (t === '\\n') result.next = true;
    else if (t === '\\h') result.hidden = true;
    else if (t === '\\r' && /^\d+$/.test(tokens[i + 1] || '')) { result.reset = Number(tokens[i + 1]); i++; }
    else { result.supported = false; if (/^\\[s#]$/.test(t)) i++; }
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
      if (!seq.supported) { onIssue({ id: range.field.id, message: 'A SEQ field with chapter numbering, a number picture or this number format keeps its cached result.' }); continue; }
      value = seq.hidden ? '' : withCases(seq.words ? applyGeneralFormat(String(Math.max(0, n)), seq.words) : formatPageNumber(Math.max(0, n), seq.format), seq.cases);
    } else if (type === 'REF') {
      let tokens; try { tokens = fieldInstructionTokens(range.field.instruction).slice(1); } catch { continue; }
      let relative = false, supported = true;
      const cases = [];
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '\\p') relative = true;
        else if (tokens[i] === '\\h') continue; // Existing hyperlink envelopes remain intact.
        else if (tokens[i] === '\\*' && tokens[i + 1]?.toUpperCase() === 'MERGEFORMAT') i++;
        else if (tokens[i] === '\\*' && CASES.test(tokens[i + 1] || '')) cases.push(tokens[++i]);
        else { supported = false; break; }
      }
      const retain = reason => onIssue({ id: range.field.id, message: `${reason}; its cached result is retained.` });
      if (!supported) { retain('This REF uses switches that cannot be refreshed yet'); continue; }
      const bookmark = bookmarks.get(tokens[0]);
      if (!bookmark && mergeNames.has(tokens[0])) continue;
      if (!bookmark) value = 'Error! Reference source not found.';
      else if (bookmark.start <= range.start && range.start < bookmark.end || range.start < bookmark.start && bookmark.start < range.end) {
        retain('A REF within its source bookmark cannot be refreshed yet'); continue;
      } else if (relative) value = withCases(range.end <= bookmark.start ? 'below' : 'above', cases);
      else {
        value = text.slice(bookmark.start, Math.min(bookmark.end, text.length));
        if (bookmark.columnRange || /[\n￼]/.test(value)) { retain('A REF with structural or object content cannot be refreshed yet'); continue; }
        value = withCases(value, cases);
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
  const tracking = model.trackChanges; model.trackChanges = false;
  const updated = new Set();
  try {
    // A cross-reference shows the text of what it refers to, which a SEQ field in this same pass may change:
    // plan again after applying, until nothing changes (a few passes; references do not refer to references).
    for (let pass = 0; pass < 3; pass++) {
      let applied = 0;
      for (const { range, text } of [...fieldUpdatePlan(model, pass ? { ...options, onIssue: () => {} } : options)].reverse()) {
        // A result never spans a paragraph mark: replacing one that does would merge paragraphs.
        if (model.text.slice(range.start, range.end).includes('\n')) continue;
        model.select(range.start, range.end);
        model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
        model.replace(text, { checkpoint: false });
        updated.add(range.field.id); applied++;
      }
      if (!applied) break;
    }
  } finally { model.trackChanges = tracking; }
  if (updated.size) model.didChange();
  return updated.size;
}
