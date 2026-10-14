/**
 * The spelling checker behind Review ▸ Spelling (F7): English word lists from SCOWL (src/vendor/words-en.js,
 * loaded the first time they are needed), the person's own dictionary, and the words found in a sheet's text.
 *
 * A word is spelt right when the list has it as typed, in small letters, or with a capital (a list word with a
 * capital, a name, must keep it); in capitals, any of those will do. "word's" and "words'" stand when "word"
 * and "words" do. Suggestions are the list's words one or two edits away (a letter left out, added, changed,
 * or two swapped), nearest first, cased as the word was typed.
 */

export const LANGUAGES = [
  { code: 'en-US', label: 'English (United States)' },
  { code: 'en-GB', label: 'English (United Kingdom)' },
];

/** Undo the front coding of a generated list: each line, the shared length (a character code minus 48), then the rest. */
export function decodeWords(text) {
  const out = [];
  let prev = '';
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const word = prev.slice(0, line.charCodeAt(0) - 48) + line.slice(1);
    out.push(word);
    prev = word;
  }
  return out;
}

const loaded = new Map(); // language → Promise<{ words: Set, noSuggest: Set }>

/** The word list for a language, loaded once. */
export function loadWordList(language = 'en-US') {
  const lang = LANGUAGES.some((l) => l.code === language) ? language : 'en-US';
  if (!loaded.has(lang)) {
    loaded.set(lang, import('../vendor/words-en.js').then((m) => {
      const words = new Set(decodeWords(m.EN_US));
      if (lang === 'en-GB') {
        for (const w of decodeWords(m.EN_GB_DROP)) words.delete(w);
        for (const w of decodeWords(m.EN_GB_ADD)) words.add(w);
      }
      const noSuggest = new Set(decodeWords(m.NO_SUGGEST));
      for (const w of noSuggest) words.add(w);
      return { words, noSuggest };
    }));
  }
  return loaded.get(lang);
}

/** A checker over a word list (as loadWordList gives, or any Set) and the person's own words. */
export function createSpeller(list, { custom = [] } = {}) {
  const words = list instanceof Set ? list : list.words;
  const noSuggest = list instanceof Set ? new Set() : list.noSuggest;
  const own = new Set(custom.map((w) => normalize(w)));
  const ownLower = new Set([...own].map((w) => w.toLowerCase()));
  const known = (w) => words.has(w) || own.has(w);
  const knownAnyCase = (w) => known(w) || ownLower.has(w.toLowerCase());

  function check(raw) {
    const w = normalize(raw);
    if (!w) return true;
    if (known(w) || ownLower.has(w.toLowerCase())) return true;
    const lower = w.toLowerCase();
    const capital = lower.charAt(0).toUpperCase() + lower.slice(1);
    if (w === capital && known(lower)) return true; // a sentence's first word
    if (w === w.toUpperCase() && w !== lower && (known(lower) || known(capital))) return true; // in capitals
    // Possessives: the word's and the words'.
    if (/'s$/i.test(w) && w.length > 2) return check(w.slice(0, -2));
    if (/s'$/i.test(w) && w.length > 2) return check(w.slice(0, -1));
    return false;
  }

  // The list's words by length, for the search two edits out: built the first time a suggestion needs it.
  let byLength = null;
  const wordsOfLength = (n) => {
    if (!byLength) {
      byLength = new Map();
      for (const form of [...words, ...own]) {
        if (noSuggest.has(form)) continue;
        let bucket = byLength.get(form.length);
        if (!bucket) byLength.set(form.length, bucket = []);
        bucket.push(form);
      }
    }
    return byLength.get(n) || [];
  };

  function suggest(raw, limit = 8) {
    const w = normalize(raw);
    if (!w) return [];
    const lower = w.toLowerCase();
    const found = new Map(); // candidate → score (lower is better)
    const keep = (form, score) => {
      // A name offered for a word typed in small letters ranks a little after the common words.
      if (form !== form.toLowerCase() && w === lower) score += 0.3;
      const prev = found.get(form);
      if (prev == null || score < prev) found.set(form, score);
    };
    const consider = (cand, score) => {
      for (const form of [cand, cand.charAt(0).toUpperCase() + cand.slice(1)]) {
        if ((words.has(form) || own.has(form)) && !noSuggest.has(form)) keep(form, score);
      }
    };
    // A name typed in small letters ("paris"): the name first.
    const named = lower.charAt(0).toUpperCase() + lower.slice(1);
    if (named !== w && (words.has(named) || own.has(named))) found.set(named, 0);
    for (const [cand, cost] of edits(lower)) consider(cand, cost);
    // A word run together with the next ("alot" → "a lot").
    for (let i = 1; i < lower.length; i++) {
      const a = lower.slice(0, i), b = lower.slice(i);
      if ((a.length >= 3 || a === 'a') && b.length >= 3 && knownAnyCase(a) && knownAnyCase(b)) found.set(`${a} ${b}`, a === 'a' ? 0.9 : 2.5);
    }
    // Two edits out: the list's words within two letters of the length, measured one by one.
    if (found.size < limit && lower.length <= 20) {
      for (let n = Math.max(1, lower.length - 2); n <= lower.length + 2; n++) {
        for (const form of wordsOfLength(n)) {
          const d = distance(lower, form.toLowerCase(), 2);
          if (d === 2) keep(form, 2 + Math.abs(form.length - lower.length) * 0.1);
        }
      }
    }
    const ranked = [...found].sort((a, b) => a[1] - b[1]
      || Number(b[0][0].toLowerCase() === lower[0]) - Number(a[0][0].toLowerCase() === lower[0])
      || Math.abs(a[0].length - lower.length) - Math.abs(b[0].length - lower.length)
      || a[0].localeCompare(b[0]));
    const seen = new Set();
    const out = [];
    for (const [cand] of ranked) {
      const cased = caseLike(w, cand);
      if (cased === w || seen.has(cased)) continue;
      seen.add(cased);
      out.push(cased);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { check, suggest, has: known };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz'";
const VOWELS = new Set('aeiouy');
/** Neighbouring keys on a QWERTY keyboard, for the slips a finger makes. */
const KEYS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const near = (a, b) => {
  for (let row = 0; row < KEYS.length; row++) {
    const i = KEYS[row].indexOf(a);
    if (i < 0) continue;
    for (let dr = -1; dr <= 1; dr++) {
      const line = KEYS[row + dr];
      if (!line) continue;
      for (let dc = -1; dc <= 1; dc++) if (line[i + dc] === b) return true;
    }
  }
  return false;
};

/**
 * Every string one edit from `w`, with what the edit costs: two letters swapped, a doubled letter added or
 * dropped, a vowel for a vowel or a key for its neighbour cost less than any other change.
 */
function edits(w) {
  const out = new Map();
  const add = (s, cost) => { if (s && s !== w && !(out.get(s) <= cost)) out.set(s, cost); };
  for (let i = 0; i < w.length - 1; i++) add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2), 0.5);
  for (let i = 0; i < w.length; i++) add(w.slice(0, i) + w.slice(i + 1), w[i] === w[i - 1] || w[i] === w[i + 1] ? 0.6 : 1);
  const letters = new Set(ALPHABET + w);
  for (let i = 0; i <= w.length; i++) {
    for (const ch of letters) {
      if (i < w.length && ch !== w[i]) add(w.slice(0, i) + ch + w.slice(i + 1), (VOWELS.has(ch) && VOWELS.has(w[i])) || near(ch, w[i]) ? 0.8 : 1);
      add(w.slice(0, i) + ch + w.slice(i), ch === w[i] || ch === w[i - 1] ? 0.6 : 1);
    }
  }
  return out;
}

/** The edit distance between `a` and `b` (a swap of neighbours counting one), or max + 1 once it is past `max`. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** The suggestion in the case the word was typed: Capitalized, CAPITALS, or as the list spells it. */
function caseLike(typed, word) {
  if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return word.toUpperCase();
  if (typed[0] && typed[0] !== typed[0].toLowerCase()) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

const normalize = (w) => String(w || '').replace(/’/g, "'");

export const DEFAULT_SPELLING_OPTIONS = { ignoreUppercase: true, ignoreNumbers: true, ignoreAddresses: true };

/**
 * The words of a text to check: [{ word, start, end }]. Letters with apostrophes inside them make a word; a
 * hyphen or anything else separates words. Words next to a digit, inside an address (web, email or a file
 * path) or in capitals are left out as the options say.
 */
export function wordsIn(text, options = DEFAULT_SPELLING_OPTIONS) {
  text = String(text ?? '');
  const skip = [];
  if (options.ignoreAddresses !== false) {
    for (const m of text.matchAll(/\S*(?:@|:\/\/|www\.|[\\/])\S*/gi)) skip.push([m.index, m.index + m[0].length]);
  }
  const out = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu)) {
    const start = m.index, end = start + m[0].length, word = m[0];
    if (skip.some(([a, b]) => start >= a && end <= b)) continue;
    if (options.ignoreNumbers !== false && (/\d/.test(text[start - 1] || '') || /\d/.test(text[end] || ''))) continue;
    if (options.ignoreUppercase !== false && word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) continue;
    out.push({ word, start, end });
  }
  return out;
}

/**
 * The text cells of a sheet in reading order (row by row), as [r, c] pairs: inside `ranges` when given, else the
 * whole sheet; starting at `from` ({ r, c }) and wrapping round to the cells before it.
 */
export function textCellsInOrder(wb, sheetId, { ranges = null, from = null } = {}) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return [];
  const list = [];
  for (const [key, cell] of sheet.cells) {
    if (cell?.f != null || typeof cell?.v !== 'string' || !cell.v.trim()) continue;
    const [r, c] = key.split(',').map(Number);
    if (ranges && !ranges.some((rg) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2)) continue;
    list.push([r, c]);
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!from) return list;
  const at = list.findIndex(([r, c]) => r > from.r || (r === from.r && c >= from.c));
  return at <= 0 ? list : [...list.slice(at), ...list.slice(0, at)];
}

/** Replace the word at [start, end) of `text`. */
export const replaceWord = (text, start, end, word) => text.slice(0, start) + word + text.slice(end);
