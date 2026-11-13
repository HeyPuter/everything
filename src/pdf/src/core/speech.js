// Chinese and Japanese put no space between words, so a line break inside a phrase is no
// pause: a voice read "中" ending one line and "文" starting the next as two words.
const UNSPACED = '[\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u3000-\\u303f\\uff00-\\uffef]';
const UNSPACED_BREAK = new RegExp(`(?<=${UNSPACED})\\n(?=${UNSPACED})`, 'gu');
/**
 * The words of a page's text items, line by line. A word hyphenated at the end of a line is
 * spoken whole, as it is found by Find: a voice reads "exam- ple" as two words.
 */
export function pageSpeechText(items) {
  return items
    .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
    .join('')
    .replace(/(\p{L})[-\u00ad\u2010]\n[ \t]*(?=\p{Ll})/gu, '$1')
    .replace(UNSPACED_BREAK, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
/** The last boundary between whole characters at or before `max` (`max` when none is). */
function characterBoundary(text, max, lang) {
  if (typeof Intl.Segmenter !== 'function') {
    const high = text.charCodeAt(max - 1);
    return high >= 0xd800 && high <= 0xdbff && max > 1 ? max - 1 : max;
  }
  let at = 0;
  for (const { index } of new Intl.Segmenter(lang, { granularity: 'grapheme' }).segment(
    text.slice(0, max + 1),
  )) {
    if (index > max) break;
    at = index;
  }
  return at > 0 ? at : max;
}
/**
 * Page text cut into pieces to speak one after another, whole sentences where they fit.
 * Chrome stops speaking a long utterance after about fifteen seconds without ever ending it,
 * so a page read as one utterance fell silent partway and Read to end never moved on.
 */
export function speechChunks(text, { max = 200, lang } = {}) {
  const flowing = String(text).replace(/\s+/g, ' ').trim();
  if (!flowing) return [];
  const sentences =
    typeof Intl.Segmenter === 'function'
      ? Array.from(
          new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(flowing),
          (part) => part.segment,
        )
      : [flowing];
  const chunks = [];
  let current = '';
  const add = (piece) => {
    if (current && current.length + piece.length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += piece;
  };
  for (let sentence of sentences) {
    // A sentence too long to speak whole breaks at the last space that fits, or else between
    // whole characters: never inside an emoji's code units or between a letter and its mark.
    while (sentence.length > max) {
      const space = sentence.lastIndexOf(' ', max);
      const at = space > 0 ? space + 1 : characterBoundary(sentence, max, lang);
      add(sentence.slice(0, at));
      sentence = sentence.slice(at);
    }
    add(sentence);
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
