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

// Search logical source paragraphs, so repeated headers are counted once and
// formatting boundaries do not interrupt text. Never match half a grapheme.
export function findText(paragraphs, query, { matchCase = false, wholeWord = false } = {}) {
  checkedSearchText(query);
  if (!query) return [];
  const matchLiteral = literalMatcher(query, matchCase);
  const matches = []; let at = 0;
  paragraphs.forEach((p, paragraph) => {
    const text = p.runs.map(r => r.text).join('');
    const boundaries = new Set([...inlineSegments(text)].map(s => s.index).concat(text.length));
    const wordStarts = new Set(), wordEnds = new Set();
    if (wholeWord) for (const segment of words.segment(text)) if (segment.isWordLike) { wordStarts.add(segment.index); wordEnds.add(segment.index + segment.segment.length); }
    let previousEnd = 0;
    for (const { start, end } of matchLiteral(text)) {
      if (start >= previousEnd && boundaries.has(start) && boundaries.has(end) && (!wholeWord || wordStarts.has(start) && wordEnds.has(end))) {
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
      delete run.noteMark; delete run.bodySymbol; delete run.noBreakHyphen;
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
