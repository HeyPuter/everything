// Thai, Lao, Khmer and Myanmar are written without spaces between words
// (UAX #14 line-break class SA), so only a dictionary can find where a line may
// break. Intl.Segmenter carries one for each of these scripts. Word boundaries
// count only between two such characters: punctuation, Latin text and spaces
// adjacent to them keep the ordinary rules. Other paragraphs are not segmented.
// All four scripts lie in the BMP, so one code unit identifies each side.
const COMPLEX = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const words = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

// Chinese and Japanese are written without spaces as well, but need no dictionary: a line may break
// before or after any ideograph or kana (UAX #14 class ID), including beside Latin text, except
// where the East Asian line rules (kinsoku, §17.3.1.16, applied to every paragraph) forbid
// it. These are the default lists of characters that may not start a line (closing
// punctuation, small kana, iteration and prolonged sound marks) and that may not end one (opening
// punctuation and currency signs) for Japanese and Chinese. Nor does a line break before a hyphen,
// on either side of a straight quote, or inside a doubled dash. Hangul is left to the space rules:
// Korean is wrapped between words. Spaces and inline objects keep their own rules.
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3001-\u303f\u30fb\u30fc\uff01-\uff65\uffe0-\uffe6]/u;
const NO_START = new Set('"\'-‐‑–!%),.:;?]}¢°·’”‰′″℃∶、。〃〆〉》」』】〕〗〙〞〟ぁぃぅぇぉっゃゅょゎゕゖ゛゜ゝゞ゠ァィゥェォッャュョヮヵヶ・ーヽヾㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ々〻‥…﹚﹜！＂％＇），．：；？］｝～｡｣､･ｧｨｩｪｫｬｭｮｯｰﾞﾟ￠');
const NO_END = new Set('"\'$([{£¥·‘“〈《「『【〔〖〘〝﹙﹛＄（［｛｢￡￥');
const OPEN_SPACE = /[\s\ufffc]/u;
const graphemes = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function* codePoints(text) { let index = 0; for (const segment of text) { yield { segment, index }; index += segment.length; } }
function ideographicBreaks(text, breaks) {
  let previous = null;
  for (const { segment, index } of graphemes ? graphemes.segment(text) : codePoints(text)) {
    // A grapheme takes its line-breaking behaviour from its base character.
    const base = String.fromCodePoint(segment.codePointAt(0));
    if (previous !== null && (IDEOGRAPHIC.test(previous) || IDEOGRAPHIC.test(base)) && !OPEN_SPACE.test(previous) && !OPEN_SPACE.test(base)
      && !NO_END.has(previous) && !NO_START.has(base) && !(previous === '—' && base === '—')) breaks.add(index);
    previous = base;
  }
}

/**
 * Offsets in `text` where a line may break besides spaces and hyphens: between dictionary-segmented
 * Thai, Lao, Khmer or Myanmar words, and beside ideographs and kana. Null when there are none.
 */
export function dictionaryBreaks(text) {
  const complex = !!words && COMPLEX.test(text), ideographic = IDEOGRAPHIC.test(text);
  if (!complex && !ideographic) return null;
  const breaks = new Set();
  if (complex) complexWordBreaks(text, breaks);
  if (ideographic) ideographicBreaks(text, breaks);
  return breaks.size ? breaks : null;
}

/**
 * Offsets in `text` between two dictionary-segmented Thai, Lao, Khmer or Myanmar words, or null when
 * there are none. Word-by-word caret movement uses these alone: Chinese and Japanese keep their
 * native word units there, although a line may break between any two ideographs.
 */
export function wordBreaks(text) {
  if (!words || !COMPLEX.test(text)) return null;
  const breaks = new Set();
  complexWordBreaks(text, breaks);
  return breaks.size ? breaks : null;
}

function complexWordBreaks(text, breaks) {
  for (const { segment, index } of words.segment(text)) {
    if (index && COMPLEX.test(segment[0]) && COMPLEX.test(text[index - 1])) breaks.add(index);
  }
}

// Thai and Lao leading vowels precede their consonant but are separate
// graphemes, as are a few following vowels. A forced break inside an overlong
// word keeps them with that consonant. A line that ends at a tab, space or
// manual break is not a forced break and is left alone.
const LEADING_VOWEL = /^[\u0e40-\u0e44\u0ec0-\u0ec4]$/u;
const FOLLOWING_VOWEL = /^[\u0e30\u0e32\u0e33\u0e45\u0eb0\u0eb2\u0eb3]/u;
const THAI_LAO = /^[\p{Script=Thai}\p{Script=Lao}]/u;
export const splitsSyllable = (before, after) => LEADING_VOWEL.test(before) && THAI_LAO.test(after) || FOLLOWING_VOWEL.test(after);
