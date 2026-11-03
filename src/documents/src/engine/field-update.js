// Updating sequence and cross-reference fields (ECMA-376 Part 1 §17.16.5.56
// SEQ, §17.16.5.51 REF) the way Update Field does: SEQ results count their
// identifier in document order; REF results repeat their bookmark's text.
import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries, bookmarksByName, bookmarkNamed } from './bookmarks.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
import { formatPageNumber } from './page-numbering.js';
import { formulaResult } from './table-formula.js';
import { fieldResultPlan, applyGeneralFormat } from './field-results.js';
import { noteKindOf } from './footnotes.js';
import { listMarkers, levelFor } from './numbering.js';
import { activeDescendants } from './docx-compatibility.js';

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

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const drawingFields = new Map();
/**
 * The SEQ fields in a drawing's text (a text box or shape holding a caption), in order: [{ instruction, result }].
 * Only the markup a reader shows is read, so a fallback copy of the text (VML beside DrawingML) is not counted twice.
 */
function drawingSequences(image) {
  const shell = image?.shell;
  if (typeof shell !== 'string' || !/\bSEQ\b/.test(shell)) return [];
  if (drawingFields.has(shell)) return drawingFields.get(shell);
  const found = [];
  try {
    const doc = new DOMParser().parseFromString(`<root>${shell}</root>`, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('unreadable drawing');
    const open = [];
    for (const node of activeDescendants(doc.documentElement)) {
      if (node.namespaceURI !== W) continue;
      if (node.localName === 'fldSimple') found.push({ instruction: node.getAttributeNS(W, 'instr') || '', result: node.textContent });
      else if (node.localName === 'fldChar') {
        const kind = node.getAttributeNS(W, 'fldCharType');
        if (kind === 'begin') open.push({ instruction: '', result: '', separated: false });
        else if (kind === 'separate' && open.length) open.at(-1).separated = true;
        else if (kind === 'end' && open.length) found.push(open.pop());
      } else if (node.localName === 'instrText' && open.length && !open.at(-1).separated) open.at(-1).instruction += node.textContent;
      else if (node.localName === 't' && open.length && open.at(-1).separated) open.at(-1).result += node.textContent;
    }
  } catch { found.length = 0; }
  const sequences = found.filter(f => /^\s*SEQ\b/i.test(f.instruction));
  if (drawingFields.size > 500) drawingFields.clear();
  drawingFields.set(shell, sequences);
  return sequences;
}
/** The SEQ fields in drawings, at the document positions of the drawings: [{ position, instruction, result }]. */
function drawingSequenceFields(paragraphs) {
  const result = [];
  let at = 0;
  for (const p of paragraphs) {
    let offset = at;
    for (const run of p.runs) {
      if (run.image?.shell) for (const field of drawingSequences(run.image)) result.push({ position: offset, ...field });
      offset += run.text.length;
    }
    at = offset + 1;
  }
  return result;
}

/**
 * The number a REF with \n, \r or \w shows for the paragraph a bookmark starts in (§17.16.5.51): its list
 * number without trailing periods ("2.1." shows "2.1"). \n shows the number as its level writes it; \r and \w add
 * the levels above it, which a number written with every level above it ("%1.%2") already shows, so only such
 * numbers are computed for them. Null when the paragraph is not numbered or the number cannot be computed here.
 */
function paragraphNumber(model, markers, index, context) {
  const p = model.paragraphs[index], marker = markers?.[index];
  if (!p?.list || !marker?.text || marker.suppressed || marker.level.format === 'bullet') return null;
  if (context) {
    const written = new Set([...marker.level.text.matchAll(/%([1-9])/g)].map(m => Number(m[1]) - 1));
    for (let level = 0; level <= p.list.level; level++) {
      if (written.has(level)) continue;
      // A level above that shows no number (none, bullets) adds nothing to the context.
      let definition; try { definition = levelFor(model.numbering, { ...p.list, level }); } catch { return null; }
      if (!['none', 'bullet'].includes(definition.format)) return null;
    }
  }
  return marker.text.replace(/\.+$/, '').trim() || null;
}

/**
 * The text each SEQ/REF/NOTEREF field should show now: [{ range, text }] where it differs. `notes`
 * gives the displayed note numbers ({ footnote: Map, endnote: Map }) for NOTEREF (§17.16.5.40).
 * `sequencesOnly` plans the SEQ fields alone, as inserting a caption renumbers them without updating
 * every other field.
 */
export function fieldUpdatePlan(model, { onIssue = () => {}, notes = null, sequencesOnly = false } = {}) {
  const ranges = bodyFieldRanges(model.paragraphs), text = model.text, changes = [];
  const counters = new Map();
  const bookmarks = bookmarksByName(bookmarkEntries(model.paragraphs, model.tables));
  // ASK and SET assign a value to a name during a mail merge without creating a bookmark;
  // a REF to such a name keeps its cached result (the merge evaluates it).
  const mergeNames = new Set(ranges.filter(r => ['ASK', 'SET'].includes(r.field.type)).map(r => /^\s*\w+\s+("?)([^\s"]+)\1/.exec(r.field.instruction)?.[2]?.toLowerCase()).filter(Boolean));
  const parents = new Set(ranges.map(r => r.parentId).filter(Boolean));
  let markers, indexes;
  const numberOf = (bookmark, context) => {
    if (markers === undefined) { try { markers = listMarkers(model.paragraphs, model.numbering); } catch { markers = null; } indexes = new Map(model.paragraphs.map((p, i) => [p.id, i])); }
    const index = indexes.get(bookmark.startParagraph);
    return index === undefined ? null : paragraphNumber(model, markers, index, context);
  };
  const count = seq => {
    let n = counters.get(seq.id) ?? 0;
    if (seq.reset !== null) n = seq.reset; else if (seq.next) n += 1;
    counters.set(seq.id, n);
    return n;
  };
  // A caption in a text box or shape counts where its drawing stands, as Word numbers it. Its result is drawing
  // text, which this update does not rewrite: one that should change is reported.
  const drawn = model.paragraphs.some(p => p.runs.some(r => r.image?.shell)) ? drawingSequenceFields(model.paragraphs) : [];
  let nextDrawn = 0;
  const countDrawn = before => {
    for (; nextDrawn < drawn.length && drawn[nextDrawn].position < before; nextDrawn++) {
      const seq = sequenceInstruction(drawn[nextDrawn].instruction);
      if (!seq) continue;
      const n = count(seq);
      let shown = null;
      try { shown = seq.hidden ? '' : withCases(seq.words ? applyGeneralFormat(String(Math.max(0, n)), seq.words) : formatPageNumber(Math.max(0, n), seq.format), seq.cases); } catch { /* reported below */ }
      if (seq.supported && shown !== drawn[nextDrawn].result.trim()) onIssue({ id: `drawing:${nextDrawn}`, message: 'A caption number in a text box or shape keeps its text; edit the drawing’s text to change it.' });
    }
  };
  for (const range of ranges) {
    const type = range.field.type;
    if (sequencesOnly && type !== 'SEQ') continue;
    if (type === 'SEQ') countDrawn(range.start);
    if (range.field.locked || parents.has(range.field.id)) continue;
    let value = null;
    if (type === 'SEQ') {
      const seq = sequenceInstruction(range.field.instruction);
      if (!seq) continue;
      const n = count(seq);
      if (!seq.supported) { onIssue({ id: range.field.id, message: 'A SEQ field with chapter numbering, a number picture or this number format keeps its cached result.' }); continue; }
      let number;
      try { number = seq.words ? applyGeneralFormat(String(Math.max(0, n)), seq.words) : formatPageNumber(Math.max(0, n), seq.format); }
      catch { onIssue({ id: range.field.id, message: 'A SEQ field whose number is too large for its number format keeps its cached result.' }); continue; }
      value = seq.hidden ? '' : withCases(number, seq.cases);
    } else if (type === 'REF') {
      let tokens; try { tokens = fieldInstructionTokens(range.field.instruction).slice(1); } catch { continue; }
      let relative = false, supported = true, number = null;
      const cases = [];
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '\\p') relative = true;
        else if (['\\n', '\\r', '\\w'].includes(tokens[i]) && !number) number = tokens[i];
        else if (tokens[i] === '\\h') continue; // Existing hyperlink envelopes remain intact.
        else if (tokens[i] === '\\*' && tokens[i + 1]?.toUpperCase() === 'MERGEFORMAT') i++;
        else if (tokens[i] === '\\*' && CASES.test(tokens[i + 1] || '')) cases.push(tokens[++i]);
        else { supported = false; break; }
      }
      const retain = reason => onIssue({ id: range.field.id, message: `${reason}; its cached result is retained.` });
      if (!supported || number && relative) { retain('This REF uses switches that cannot be refreshed yet'); continue; }
      const bookmark = bookmarkNamed(bookmarks, tokens[0]);
      if (!bookmark && mergeNames.has(tokens[0]?.toLowerCase())) continue;
      if (!bookmark) value = 'Error! Reference source not found.';
      else if (bookmark.start <= range.start && range.start < bookmark.end || range.start < bookmark.start && bookmark.start < range.end) {
        retain('A REF within its source bookmark cannot be refreshed yet'); continue;
      } else if (relative) value = withCases(range.end <= bookmark.start ? 'below' : 'above', cases);
      else if (number) {
        // A heading or list item's number ("see section 2.1"), as Insert Cross-reference writes it.
        const shown = numberOf(bookmark, number !== '\\n');
        if (shown === null) { retain('This REF uses number switches for a paragraph whose number cannot be worked out here'); continue; }
        value = withCases(shown, cases);
      } else {
        value = text.slice(bookmark.start, Math.min(bookmark.end, text.length));
        if (bookmark.columnRange || value.includes('\n')) { retain('A REF with structural content cannot be refreshed yet'); continue; }
        // Notes, pictures and equations in the target are object characters: the result leaves them out and
        // shows breaks as spaces, as the cross-reference was inserted (captions.js).
        value = value.replace(/\uFFFC/g, '').replace(/[\f\u000e]/g, ' ');
        value = withCases(value, cases);
      }
    } else if (type === '=') value = formulaResult(model, range.field.instruction, range.cellId || null);
    else if (type === 'NOTEREF' && notes) {
      let tokens; try { tokens = fieldInstructionTokens(range.field.instruction).slice(1); } catch { continue; }
      if (tokens.slice(1).some(t => !['\\h', '\\f', '\\p'].includes(t) && !/^\\\*$/.test(t) && t.toUpperCase() !== 'MERGEFORMAT')) { onIssue({ id: range.field.id, message: 'This NOTEREF uses switches that cannot be refreshed yet; its cached result is retained.' }); continue; }
      const bookmark = bookmarkNamed(bookmarks, tokens[0]);
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
  return [...changes, ...(sequencesOnly ? [] : fieldResultPlan(model))].sort((a, b) => a.range.start - b.range.start);
}

/**
 * Replace a field's result with `text` by editing its paragraph alone: the model is given just that paragraph
 * for the edit, which then costs that paragraph's work instead of the whole document's. Updating every result
 * through the whole document made Update Fields and Insert Caption quadratic: 200 captions in 2,000 paragraphs
 * took 5–7 seconds. Only a paragraph whose fields all start and end in it, in a document without block-level
 * controls (which span paragraphs), is edited this way; the result is the same as the document-wide edit's.
 * Returns false when it does not apply.
 */
function replaceInParagraph(model, range, text, paragraphs) {
  if (model.fixedText || model.hasBlockControls || range.startParagraph !== range.endParagraph) return false;
  const place = paragraphs.get(range.startParagraph), all = model.paragraphs;
  if (!place || all[place.index]?.id !== range.startParagraph) return false;
  const p = all[place.index], open = new Set();
  for (const marker of p.fieldMarkers || []) if (marker.type === 'start') open.add(marker.field.id);
  for (const marker of p.fieldMarkers || []) if (marker.type === 'end' && !open.delete(marker.field.id)) return false;
  if (open.size) return false;
  const window = [p];
  model.paragraphs = window;
  try {
    model.select(range.start - place.offset, range.end - place.offset);
    model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
    model.replaceResult(text, { checkpoint: false });
  } finally {
    const edited = model.paragraphs;
    model.paragraphs = all;
    all.splice(place.index, 1, ...edited);
    // A result never holds a paragraph mark, so the edit leaves one paragraph; if not, positions are found again.
    if (edited.length !== 1) paragraphs.clear();
  }
  return true;
}
/** Each paragraph's index and document position, by id. */
function paragraphPlaces(model) {
  const places = new Map();
  let offset = 0;
  model.paragraphs.forEach((p, index) => { places.set(p.id, { index, offset }); offset += p.runs.reduce((n, r) => n + r.text.length, 0) + 1; });
  return places;
}

/** Apply the plan inside one editor transaction; returns the number of fields updated. */
export function updateSequenceFields(model, options) {
  const tracking = model.trackChanges; model.trackChanges = false;
  const updated = new Set();
  // The selection stays on the text it was on: each result is selected to replace it, which moved the
  // caret to the last field updated (the first in the document) on every F9.
  const { anchor: anchorBefore, focus: focusBefore, controlCaret, controlSelection } = model.selection;
  let anchor = anchorBefore, focus = focusBefore;
  const typing = { typingFormat: model.typingFormat, typingStyle: model.typingStyle, typingDirectCleared: model.typingDirectCleared };
  try {
    // A cross-reference shows the text of what it refers to, which a SEQ field in this same pass may change:
    // plan again after applying, until nothing changes (a few passes; references do not refer to references).
    for (let pass = 0; pass < 3; pass++) {
      let applied = 0;
      const plan = fieldUpdatePlan(model, pass ? { ...options, onIssue: () => {} } : options);
      // Results are replaced from the last: the paragraphs before each one keep their places.
      const places = plan.length ? paragraphPlaces(model) : null;
      for (const { range, text } of [...plan].reverse()) {
        // A result never spans a paragraph mark: replacing one that does would merge paragraphs.
        if (range.startParagraph !== range.endParagraph && model.text.slice(range.start, range.end).includes('\n')) continue;
        const map = at => at <= range.start ? at : at >= range.end ? at + text.length - (range.end - range.start) : range.start + Math.min(at - range.start, text.length);
        anchor = map(anchor); focus = map(focus);
        if (!places.size || !replaceInParagraph(model, range, text, places)) {
          model.select(range.start, range.end);
          model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
          model.replaceResult(text, { checkpoint: false });
        }
        updated.add(range.field.id); applied++;
      }
      if (!applied) break;
    }
    if (updated.size) {
      model.select(anchor, focus, ...(anchor === anchorBefore && focus === focusBefore ? [controlCaret, controlSelection] : []));
      Object.assign(model, typing);
    }
  } finally { model.trackChanges = tracking; }
  if (updated.size) model.didChange();
  return updated.size;
}
