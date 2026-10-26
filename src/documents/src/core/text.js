/**
 * Plain-text statistics for the status bar. A word is a run of anything
 * but whitespace, the rule the document engine's own count follows too,
 * so "12 of 340 words" for a selection agrees with the document's total:
 * "snake_case_name", "user@example.com" and "a/b" are one word each, as is
 * a lone dash. Combining marks and the zero-width joiners Persian and Indic
 * scripts write inside words sit inside their word and split nothing.
 * Thai, Lao, Khmer and Myanmar put no spaces between words, so a run that
 * holds them counts the words Intl.Segmenter finds in it. Pictures and note
 * marks (U+FFFC) are not words, and a column break separates words.
 */

const WORD_RE = /[^\s\u200B\u000e]+/gu;
const WHITESPACE_RE = /\s/;
const SPACELESS_RE = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
let segmenter;

function spacelessWords(token) {
  segmenter ??= typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  if (!segmenter) return 1;
  let count = 0;
  for (const segment of segmenter.segment(token)) if (segment.isWordLike) count++;
  return Math.max(1, count); // a run of marks alone is still one word
}

export function countWords(text) {
  if (!text) return 0;
  let s = String(text);
  if (s.includes('\uFFFC')) s = s.replace(/\uFFFC/g, '');
  const m = s.match(WORD_RE);
  if (!m) return 0;
  if (!SPACELESS_RE.test(s)) return m.length;
  let count = 0;
  for (const token of m) count += SPACELESS_RE.test(token) ? spacelessWords(token) : 1;
  return count;
}

export function countCharacters(text, { spaces = true } = {}) {
  if (!text) return 0;
  const s = String(text);
  let count = 0;
  // Count code points directly: live statistics must not allocate an array
  // entry for every character or copies of a long document without whitespace.
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i);
    if (code === 10 || (code === 13 && s.charCodeAt(i + 1) === 10)) continue;
    if (!spaces && WHITESPACE_RE.test(s[i])) continue;
    if (code > 0xffff) i++;
    count++;
  }
  return count;
}

export function countParagraphs(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/** Reading time at ~230 words per minute, in whole minutes (minimum 1 for any text). */
export function readingMinutes(words) {
  if (!words) return 0;
  return Math.max(1, Math.round(words / 230));
}

/** Both character counts from one pass over the text: live statistics run on every typing pause. */
export function countCharacterKinds(text) {
  if (!text) return { characters: 0, charactersNoSpaces: 0 };
  const s = String(text);
  let characters = 0, charactersNoSpaces = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i);
    if (code === 10 || (code === 13 && s.charCodeAt(i + 1) === 10)) continue;
    const space = WHITESPACE_RE.test(s[i]);
    if (code > 0xffff) i++;
    characters++;
    if (!space) charactersNoSpaces++;
  }
  return { characters, charactersNoSpaces };
}

/**
 * The statistics of a text. `known` carries counts the engine reports for
 * the document (words, paragraphs); those are not counted again from the text.
 */
export function textStats(text, known = null) {
  const words = Number.isInteger(known?.words) && known.words >= 0 ? known.words : countWords(text);
  return {
    words,
    ...countCharacterKinds(text),
    paragraphs: Number.isInteger(known?.paragraphs) && known.paragraphs >= 0 ? known.paragraphs : countParagraphs(text),
    readingMinutes: readingMinutes(words),
  };
}

export function formatCount(n, singular, plural = `${singular}s`) {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** "12 of 340 words" for a selection inside a larger document. */
export function formatSelectionCount(selected, total, singular, plural = `${singular}s`) {
  return `${selected.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? singular : plural}`;
}

/**
 * Prefer the engine's own word and paragraph counts when it reports them:
 * its text projection joins paragraphs without separators, which merges the
 * last word of one paragraph with the first of the next and hides paragraph
 * breaks. Characters keep coming from the text.
 */
export function mergeEngineCounts(stats, counts) {
  if (!stats || !counts) return stats;
  const out = { ...stats };
  if (Number.isInteger(counts.words) && counts.words >= 0) { out.words = counts.words; out.readingMinutes = readingMinutes(counts.words); }
  if (Number.isInteger(counts.paragraphs) && counts.paragraphs >= 0) out.paragraphs = counts.paragraphs;
  return out;
}
