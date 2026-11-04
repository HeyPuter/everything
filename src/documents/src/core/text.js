/**
 * Plain-text statistics for the status bar. A word is a run of anything
 * but whitespace, the rule the document engine's own count follows too,
 * so "12 of 340 words" for a selection agrees with the document's total:
 * "snake_case_name", "user@example.com" and "a/b" are one word each, as is
 * a lone dash. Combining marks and the zero-width joiners Persian and Indic
 * scripts write inside words sit inside their word and split nothing.
 * Thai, Lao, Khmer and Myanmar put no spaces between words, so a run that
 * holds them counts the words Intl.Segmenter finds in it. Chinese and
 * Japanese are counted as desktop word processors count East Asian text:
 * each ideograph or kana (and Bopomofo letter) is a word of its own, the
 * other letters and digits between them make words as usual, and the
 * punctuation between them is not a word. Korean puts spaces between its
 * words and is counted like any other text. Pictures and note marks
 * (U+FFFC) are not words, and a column break separates words.
 */

const WORD_RE = /[^\s\u200B\u000e]+/gu;
const WHITESPACE_RE = /\s/;
const SPACELESS_RE = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
// The prolonged sound mark (ー) is written inside katakana words but belongs to no one script.
const EAST_ASIAN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u30FC\uFF70]/u;
const EAST_ASIAN_SPLIT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u30FC\uFF70]/gu;
const WORDLIKE_RE = /[\p{L}\p{N}]/u;
let segmenter;

function spacelessWords(token) {
  segmenter ??= typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  if (!segmenter) return 1;
  let count = 0;
  for (const segment of segmenter.segment(token)) if (segment.isWordLike) count++;
  return Math.max(1, count); // a run of marks alone is still one word
}

/** A whitespace-delimited token holding Chinese or Japanese: its characters, and the words between them. */
function eastAsianWords(token) {
  let count = 0;
  const pieces = token.split(EAST_ASIAN_SPLIT_RE);
  count += pieces.length - 1;
  for (const piece of pieces) if (piece && WORDLIKE_RE.test(piece)) count += SPACELESS_RE.test(piece) ? spacelessWords(piece) : 1;
  return count;
}

export function countWords(text) {
  if (!text) return 0;
  let s = String(text);
  if (s.includes('\uFFFC')) s = s.replace(/\uFFFC/g, '');
  const m = s.match(WORD_RE);
  if (!m) return 0;
  const spaceless = SPACELESS_RE.test(s), eastAsian = EAST_ASIAN_RE.test(s);
  if (!spaceless && !eastAsian) return m.length;
  let count = 0;
  for (const token of m) count += eastAsian && EAST_ASIAN_RE.test(token) ? eastAsianWords(token) : spaceless && SPACELESS_RE.test(token) ? spacelessWords(token) : 1;
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

let graphemeSegmenter;
/**
 * The start of `text`, at most `max` UTF-16 code units long, ending between two characters a reader sees: never
 * inside an emoji (two code units, or several joined), a flag, or a letter and its accents. A cut that would halve
 * one leaves it out (a character longer than `max` on its own is kept whole). Text within the limit is returned as is.
 */
export function clipText(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  graphemeSegmenter ??= typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  if (!graphemeSegmenter) return s.slice(0, /[\ud800-\udbff]/.test(s[max - 1] || '') ? max - 1 : max);
  // Graphemes past the cut do not matter: segmenting a bounded window keeps a long text cheap.
  let end = 0;
  for (const { segment, index } of graphemeSegmenter.segment(s.slice(0, max + 64))) {
    if (index + segment.length > max) return s.slice(0, end || index + segment.length);
    end = index + segment.length;
  }
  return s.slice(0, end);
}
