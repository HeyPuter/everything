const normalize = (value) => value.replace(/\s+/g, ' ');
// The combining accents of Latin, Greek, and Cyrillic letters. Marks that change a letter
// elsewhere (kana voicing, Indic viramas) are kept.
const DIACRITICS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
// Typographic quotes, which a typed query almost never has: "don't" finds "don’t".
const SINGLE_QUOTES = /[\u2018-\u201b\u2032]/g,
  DOUBLE_QUOTES = /[\u201c-\u201f\u2033]/g;
// Hyphens as word processors set them, which a typed query has as "-": non-breaking hyphens
// keep a phone number on one line, and figure and en dashes or minus signs stand in for hyphens.
const HYPHENS = /[\u2010-\u2013\u2212]/g;
// Scripts written without spaces between words, and their punctuation.
const UNSPACED =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u3000-\\u303f\\uff00-\\uffef]';
const ENDS_UNSPACED = new RegExp(`${UNSPACED}$`, 'u'),
  STARTS_UNSPACED = new RegExp(`^${UNSPACED}`, 'u');
// Lowercasing is context-sensitive for Greek sigma, so fold the final form to match prefixes.
// Accents are ignored, as PDF readers ignore them by default: "cafe" finds "café".
const fold = (value) =>
  value
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(HYPHENS, '-')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .normalize('NFC');

export const searchQuery = (value) => fold(normalize(value).trim());
// A page repeats a few hundred distinct characters; folding each one once keeps indexing a
// page of a hundred thousand characters, which every redraw of it does, from pausing the view.
const foldedChars = new Map();
function foldChar(char) {
  let folded = foldedChars.get(char);
  if (folded === undefined) {
    folded = fold(char);
    if (foldedChars.size < 10000) foldedChars.set(char, folded);
  }
  return folded;
}

/**
 * Keep PDF.js text item offsets while preserving actual spaces and line breaks.
 * `origins[i][k]` is the UTF-16 offset in item i's string that produced folded offset k, so a
 * match in the folded text can be mapped back onto the characters shown on the page.
 */
export function indexPageText(items) {
  const chunks = [];
  const ranges = [];
  const origins = [];
  let length = 0;
  let trailingSpace = false,
    tail = '',
    // The last item that added text, and its chunk: a line can end in an empty item after
    // the item holding its hyphen.
    held = null,
    // The last character on the page as written, before folding: only a hyphen, not a dash
    // folded to one, breaks a word at the end of a line.
    lastChar = '';
  const strings = items.filter((item) => typeof item.str === 'string');
  strings.forEach((item, i) => {
    let chunk = '';
    const origin = [];
    let offset = 0;
    for (const char of item.str) {
      const start = offset;
      offset += char.length;
      if (/\s/.test(char)) {
        if (chunk ? chunk.endsWith(' ') : trailingSpace) continue;
        chunk += ' ';
        origin.push(start);
      } else {
        // Fold whole code points, then map each UTF-16 unit used by string search and DOM
        // ranges. Expanded lowercase forms still point back to their one source character.
        const folded = foldChar(char);
        chunk += folded;
        for (let k = 0; k < folded.length; k++) origin.push(start + Math.min(k, char.length - 1));
      }
    }
    // A word hyphenated at the end of a line is found whole, as PDF readers find it.
    if (chunk) lastChar = chunk.endsWith(' ') ? ' ' : item.str.at(-1);
    const hyphenated =
      item.hasEOL &&
      /\p{L}[-\u00ad\u2010]$/u.test(tail + chunk) &&
      /[-\u00ad\u2010]/.test(lastChar) &&
      /^\p{Ll}/u.test(strings[i + 1]?.str || '');
    if (hyphenated && chunk) {
      chunk = chunk.slice(0, -1);
      origin.pop();
    } else if (hyphenated) {
      // The hyphen ended an earlier item (in another font, say): take it off that one.
      const [at, chunkAt] = held;
      chunks[chunkAt] = chunks[chunkAt].slice(0, -1);
      origins[at].pop();
      ranges[at].end--;
      for (let k = at + 1; k < ranges.length; k++)
        ranges[k] = { start: length - 1, end: length - 1 };
      length--;
    }
    const start = length;
    chunks.push(chunk);
    origins.push(origin);
    length += chunk.length;
    ranges.push({ start, end: length });
    if (chunk) {
      trailingSpace = chunk.endsWith(' ');
      tail = (tail + chunk).slice(-2);
      held = [i, chunks.length - 1];
    }
    // Chinese and Japanese put no space between words, so a line break inside a phrase is
    // not one either: "中" ending a line and "文" starting the next are found as "中文".
    const unspaced = () => {
      if (!ENDS_UNSPACED.test(tail)) return false;
      let next = i + 1;
      while (next < strings.length && !strings[next].str) next++;
      return STARTS_UNSPACED.test(strings[next]?.str || '');
    };
    if (item.hasEOL && !trailingSpace && !hyphenated && !unspaced()) {
      chunks.push(' ');
      length++;
      trailingSpace = true;
      tail = ' ';
      lastChar = ' ';
      held = null;
    }
  });
  return { text: chunks.join(''), ranges, origins };
}
