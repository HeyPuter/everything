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

/** [start, end) of a paragraph's text tracked as deleted, or null when it has none. */
export function deletedSpans(p) {
  if (!p.runs.some(r => r.revision?.type === 'del')) return null;
  const spans = []; let at = 0;
  for (const run of p.runs) { if (run.revision?.type === 'del' && run.text) spans.push([at, at + run.text.length]); at += run.text.length; }
  return spans;
}
/** Whether [start, end) takes in any of `spans`. */
export const overlaps = (spans, start, end) => !!spans && spans.some(([a, b]) => a < end && b > start);

// Search logical source paragraphs, so repeated headers are counted once and
// formatting boundaries do not interrupt text. Never match half a grapheme.
// With `skipDeleted` (Track Changes on), text tracked as deleted is not found: replacing it again
// only added the replacement once more beside the deletion.
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

export function findText(paragraphs, query, { matchCase = false, wholeWord = false, skipDeleted = false } = {}) {
  checkedSearchText(query);
  if (!query) return [];
  // Punctuation or spaces alone are no whole word.
  if (wholeWord && ![...words.segment(query)].some(segment => segment.isWordLike)) return [];
  const fold = quoteFolding(query);
  if (fold) query = fold(query);
  const matchLiteral = literalMatcher(query, matchCase), simpleQuery = SIMPLE.test(query), matchSimple = simpleQuery && simpleMatcher(query, matchCase);
  const matches = []; let at = 0;
  paragraphs.forEach((p, paragraph) => {
    const text = p.runs.map(r => r.text).join(''), searched = fold ? fold(text) : text;
    const deleted = skipDeleted ? deletedSpans(p) : null;
    // Segmenting every paragraph of a long document on each search held up typing while Find was open.
    const simple = simpleQuery && SIMPLE.test(searched);
    const boundaries = simple ? null : new Set([...inlineSegments(text)].map(s => s.index).concat(text.length));
    // Whole words: neither end of a match falls inside a word. A query may begin or end with punctuation
    // ("Inc.", "C++", "$100"), whose ends are no word's start or end but still stand apart from the words around.
    const insideWords = new Set();
    if (wholeWord) for (const segment of words.segment(text)) if (segment.isWordLike) for (let i = 1; i < segment.segment.length; i++) insideWords.add(segment.index + i);
    let previousEnd = 0;
    for (const { start, end } of simple ? matchSimple(searched) : matchLiteral(searched)) {
      if (start >= previousEnd && (simple || boundaries.has(start) && boundaries.has(end)) && (!wholeWord || !insideWords.has(start) && !insideWords.has(end)) && !overlaps(deleted, start, end)) {
        matches.push({ start: at + start, end: at + end, paragraph, offset: start, text: text.slice(start, end) }); previousEnd = end;
      }
    }
    at += text.length + 1;
  });
  return matches;
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
      const run = { ...(removed[0].contentControl?.placeholder ? removed[0].contentControl.inputRun : removed[0]), text: replacement };
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
