import { MAX_DOCUMENT_CHARACTERS } from './text-limits.js';
import { inlineSegments } from './images.js';

const words = new Intl.Segmenter('en', { granularity: 'word' });
const unsupported = /[\u0000-\u001f\u007f\ufffc\ufffe\uffff]/u;
export function checkedSearchText(text) {
  if (typeof text !== 'string' || unsupported.test(text) || !text.isWellFormed()) throw new Error('Use ordinary text without tabs, breaks or picture placeholders.');
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('Find and replacement text must fit within 5,000,000 characters.');
  return text;
}

function literalMatcher(query, matchCase) {
  const letters = Array.from(query), prefix = new Uint32Array(letters.length), folds = new Map();
  const equal = (a, b) => {
    if (a === b) return true;
    if (matchCase) return false;
    // Delegate simple/common Unicode folding to the same browser primitive as
    // normal text search, without compiling a document-sized regular expression.
    if (!folds.has(a)) folds.set(a, new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'iu'));
    return folds.get(a).test(b);
  };
  for (let i = 1, matched = 0; i < letters.length; i++) {
    while (matched && !equal(letters[matched], letters[i])) matched = prefix[matched - 1];
    if (equal(letters[matched], letters[i])) matched++;
    prefix[i] = matched;
  }
  return function* (text) {
    const starts = []; let position = 0, matched = 0;
    for (const letter of text) {
      starts.push(position); position += letter.length;
      while (matched && !equal(letters[matched], letter)) matched = prefix[matched - 1];
      if (equal(letters[matched], letter)) matched++;
      if (matched === letters.length) {
        yield { start: starts[starts.length - matched], end: position };
        matched = prefix[matched - 1];
      }
    }
  };
}

/**
 * [start, end) of a paragraph's text a search passes over, or null when it has none: text tracked as deleted with
 * `skipDeleted`, and the runs `hidden(run)` names (text the view hides, hidden-text.js).
 */
export function skippedSpans(p, skipDeleted, hidden = null) {
  const skipped = run => skipDeleted && run.revision?.type === 'del' || !!hidden?.(run);
  if (!p.runs.some(skipped)) return null;
  const spans = []; let at = 0;
  for (const run of p.runs) { if (run.text && skipped(run)) spans.push([at, at + run.text.length]); at += run.text.length; }
  return spans;
}
/** [start, end) of a paragraph's text tracked as deleted, or null when it has none. */
export const deletedSpans = p => skippedSpans(p, true);
/** Whether [start, end) takes in any of `spans`. */
export const overlaps = (spans, start, end) => !!spans && spans.some(([a, b]) => a < end && b > start);

// Search logical source paragraphs, so repeated headers are counted once and
// formatting boundaries do not interrupt text. Never match half a grapheme.
// With `skipDeleted` (Track Changes on), text tracked as deleted is not found: replacing it again
// only added the replacement once more beside the deletion. With `hidden(run)`, neither is text the view hides.
// Text of these characters has a grapheme boundary between every two (none combines with a neighbour), and
// matches without case as its lowercase form does: no character's lowercase differs in length or folds otherwise.
const SIMPLE = /^[\t\v\f\u000e\u0020-\u007e\u00a0-\u00ff\ufffc]*$/;
/**
 * Every match of a query in paragraphs of simple text, as literalMatcher finds them (overlapping ones too, in linear
 * time), comparing code units rather than asking a regular expression about each letter.
 */
function simpleMatcher(query, matchCase) {
  const needle = matchCase ? query : query.toLowerCase(), prefix = new Uint32Array(needle.length);
  for (let i = 1, matched = 0; i < needle.length; i++) {
    while (matched && needle.charCodeAt(matched) !== needle.charCodeAt(i)) matched = prefix[matched - 1];
    if (needle.charCodeAt(matched) === needle.charCodeAt(i)) matched++;
    prefix[i] = matched;
  }
  return function* (text) {
    const haystack = matchCase ? text : text.toLowerCase();
    for (let i = 0, matched = 0; i < haystack.length; i++) {
      const code = haystack.charCodeAt(i);
      while (matched && needle.charCodeAt(matched) !== code) matched = prefix[matched - 1];
      if (needle.charCodeAt(matched) === code) matched++;
      if (matched === needle.length) { yield { start: i + 1 - matched, end: i + 1 }; matched = prefix[matched - 1]; }
    }
  };
}

// A straight quote in the query also finds the typographic quotes autocorrect makes of it as you type, as Find
// does in desktop word processors: "don't" finds "don’t". Each family folds to its straight form (one code unit
// for one, so offsets stay); a curly quote typed in the query then finds either form too.
const QUOTE_FAMILIES = [[/'/, /[‘’]/g, "'"], [/"/, /[“”]/g, '"']];
function quoteFolding(query) {
  const families = QUOTE_FAMILIES.filter(([straight]) => straight.test(query));
  return families.length ? text => families.reduce((folded, [, curly, straight]) => folded.replace(curly, straight), text) : null;
}

/**
 * A paragraph's text with every grapheme in its decomposed form (NFD), and where each grapheme boundary of the
 * decomposed text lies in the original; null when the text is composed (NFC) already. An accented letter can be
 * one character (é) or a letter and a combining accent (e + ◌́), as text from macOS file names or some PDFs has it;
 * the two are the same text (canonically equivalent), and Find matches either form with either. Composed text is
 * searched for the composed query as it is: no composition reaches across a grapheme boundary, so whole graphemes
 * match there exactly when they match decomposed.
 */
function decomposed(text) {
  if (text.normalize('NFC') === text) return null;
  const original = new Map(); let out = '';
  for (const { segment, index } of inlineSegments(text)) { original.set(out.length, index); out += segment.normalize('NFD'); }
  original.set(out.length, text.length);
  return { text: out, original };
}

export function findText(paragraphs, query, { matchCase = false, wholeWord = false, skipDeleted = false, hidden = null } = {}) {
  checkedSearchText(query);
  if (!query) return [];
  // Punctuation or spaces alone are no whole word.
  if (wholeWord && ![...words.segment(query)].some(segment => segment.isWordLike)) return [];
  const fold = quoteFolding(query);
  if (fold) query = fold(query);
  // Simple text is composed (Latin-1 has no decomposed letters), and other text is compared decomposed.
  const composed = query.normalize('NFC');
  const matchLiteral = literalMatcher(composed, matchCase), simpleQuery = SIMPLE.test(composed), matchSimple = simpleQuery && simpleMatcher(composed, matchCase);
  let matchDecomposed = null;
  const matches = []; let at = 0;
  paragraphs.forEach((p, paragraph) => {
    const text = p.runs.map(r => r.text).join(''), searched = fold ? fold(text) : text;
    const deleted = skipDeleted || hidden ? skippedSpans(p, skipDeleted, hidden) : null;
    // Segmenting every paragraph of a long document on each search held up typing while Find was open.
    const simple = simpleQuery && SIMPLE.test(searched);
    const decomposition = simple ? null : decomposed(searched);
    const boundaries = simple || decomposition ? null : new Set([...inlineSegments(text)].map(s => s.index).concat(text.length));
    // Whole words: neither end of a match falls inside a word. A query may begin or end with punctuation
    // ("Inc.", "C++", "$100"), whose ends are no word's start or end but still stand apart from the words around.
    const insideWords = new Set();
    if (wholeWord) for (const segment of words.segment(text)) if (segment.isWordLike) for (let i = 1; i < segment.segment.length; i++) insideWords.add(segment.index + i);
    let previousEnd = 0;
    for (let { start, end } of simple ? matchSimple(searched) : decomposition ? (matchDecomposed ??= literalMatcher(query.normalize('NFD'), matchCase))(decomposition.text) : matchLiteral(searched)) {
      // A match in decomposed text counts where it starts and ends on graphemes of the original.
      if (decomposition) {
        if (!decomposition.original.has(start) || !decomposition.original.has(end)) continue;
        start = decomposition.original.get(start); end = decomposition.original.get(end);
      }
      if (start >= previousEnd && (simple || decomposition || boundaries.has(start) && boundaries.has(end)) && (!wholeWord || !insideWords.has(start) && !insideWords.has(end)) && !overlaps(deleted, start, end)) {
        matches.push({ start: at + start, end: at + end, paragraph, offset: start, text: text.slice(start, end) }); previousEnd = end;
      }
    }
    at += text.length + 1;
  });
  return matches;
}

const isLetter = ch => ch.toLowerCase() !== ch.toUpperCase();
// Upper case that keeps the text's length (ß stays ß rather than becoming SS), so offsets computed from the typed
// replacement still hold.
const upperChar = ch => { const upper = ch.toUpperCase(); return upper.length === ch.length ? upper : ch; };

/**
 * The replacement as a word processor puts it in when Match case is off: it takes the capitalization of the text it
 * replaces. Found in capitals (two letters or more), the replacement goes into capitals; found with a capital first
 * letter, a replacement typed all in lower case gets one too. Otherwise it goes in as typed.
 */
export function matchedCase(found, replacement) {
  const letters = [...String(found || '')].filter(isLetter);
  if (!replacement || !letters.length) return replacement;
  if (letters.length > 1 && letters.every(ch => ch === ch.toUpperCase())) return [...replacement].map(upperChar).join('');
  const typed = [...replacement];
  if (letters[0] !== letters[0].toUpperCase() || typed.some(ch => isLetter(ch) && ch !== ch.toLowerCase())) return replacement;
  const at = typed.findIndex(isLetter);
  if (at < 0) return replacement;
  typed[at] = upperChar(typed[at]);
  return typed.join('');
}

// Build one new run sequence per paragraph instead of repeatedly copying and
// segmenting the entire document for each occurrence in Replace All.
export function replacedRuns(runs, matches, replacement) {
  const result = []; let index = 0, offset = 0, position = 0;
  const consume = (end, keep, preserveEmptyAt = -1) => {
    const removed = [];
    while (position < end && index < runs.length) {
      const run = runs[index], size = Math.min(end - position, run.text.length - offset);
      if (!run.text && run.contentControl && (keep || position === preserveEmptyAt)) result.push({ ...run });
      if (size) {
        if (keep) result.push({ ...run, text: run.text.slice(offset, offset + size) });
        else removed.push(run);
      }
      offset += size; position += size;
      if (offset === run.text.length) { index++; offset = 0; }
    }
    return removed;
  };
  for (const match of matches) {
    consume(match.offset, true);
    const removed = consume(match.offset + match.text.length, false, match.offset);
    if (match.replacementRuns) result.push(...match.replacementRuns);
    else if (replacement) {
      const run = { ...(removed[0].contentControl?.placeholder ? removed[0].contentControl.inputRun : removed[0]), text: match.replacement ?? replacement };
      delete run.noteMark; delete run.bodySymbol; delete run.noBreakHyphen; delete run.vml;
      // New text is nobody's tracked insertion, deletion or formatting change, whatever the found text was.
      delete run.revision; delete run.formatRevision;
      if (match.control) run.contentControl = match.control;
      else if (run.contentControl?.persistent) delete run.contentControl;
      if (!run.link || removed.some(r => r.link?.id !== run.link.id)) delete run.link;
      result.push(run);
    }
  }
  consume(Infinity, true);
  const controls = new Map(matches.filter(m => m.control).map(m => [m.control.id, m.control]));
  if (controls.size) for (const run of result) if (controls.has(run.contentControl?.id)) run.contentControl = controls.get(run.contentControl.id);
  return result;
}

export function replacedBookmarks(paragraph, matches, inserted) {
  const markers = paragraph.bookmarks;
  if (!markers) return undefined;
  const starts = new Map(markers.filter(m => m.edge === 'start').map(m => [m.id, m.offset]));
  const points = new Set(markers.filter(m => m.edge === 'end' && starts.get(m.id) === m.offset).map(m => m.id));
  const deltas = [0];
  for (const m of matches) deltas.push(deltas.at(-1) + (m.insertedLength ?? inserted) - m.text.length);
  const discarded = new Set();
  for (const match of matches) if (match.discardedControl || match.discardBlockPlaceholder) {
    for (const marker of markers) if (marker.edge === 'end' && (match.discardBlockPlaceholder || marker.contentControlId === match.discardedControl) && starts.get(marker.id) >= match.offset && marker.offset <= match.offset + match.text.length) discarded.add(marker.id);
  }
  return markers.filter(marker => !discarded.has(marker.id)).map(marker => {
    let low = 0, high = matches.length;
    while (low < high) { const mid = (low + high) >>> 1; if (matches[mid].offset < marker.offset) low = mid + 1; else high = mid; }
    const index = low - 1, match = matches[index];
    const offset = !match ? marker.offset : marker.offset >= match.offset + match.text.length ? marker.offset + deltas[index + 1] : match.offset + deltas[index] + (marker.edge === 'end' || points.has(marker.id) ? (match.insertedLength ?? inserted) : 0);
    return { ...marker, offset };
  });
}
