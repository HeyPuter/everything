const normalize = (value) => value.replace(/\s+/g, ' ');
// The combining accents of Latin, Greek, and Cyrillic letters. Marks that change a letter
// elsewhere (kana voicing, Indic viramas) are kept.
const DIACRITICS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
// Typographic quotes, which a typed query almost never has: "don't" finds "don’t".
const SINGLE_QUOTES = /[\u2018-\u201b\u2032]/g,
  DOUBLE_QUOTES = /[\u201c-\u201f\u2033]/g;
// Lowercasing is context-sensitive for Greek sigma, so fold the final form to match prefixes.
// Accents are ignored, as PDF readers ignore them by default: "cafe" finds "café".
const fold = (value) =>
  value
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
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
    last = '';
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
    const hyphenated =
      item.hasEOL &&
      /\p{L}[-\u00ad\u2010]$/u.test(last + chunk) &&
      /^\p{Ll}/u.test(strings[i + 1]?.str || '');
    if (hyphenated) {
      chunk = chunk.slice(0, -1);
      origin.pop();
    }
    const start = length;
    chunks.push(chunk);
    origins.push(origin);
    length += chunk.length;
    ranges.push({ start, end: length });
    if (chunk) {
      trailingSpace = chunk.endsWith(' ');
      last = chunk.at(-1);
    }
    if (item.hasEOL && !trailingSpace && !hyphenated) {
      chunks.push(' ');
      length++;
      trailingSpace = true;
      last = ' ';
    }
  });
  return { text: chunks.join(''), ranges, origins };
}
