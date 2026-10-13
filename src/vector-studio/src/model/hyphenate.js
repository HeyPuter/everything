/**
 * Automatic hyphenation without a dictionary: break points inside a word
 * from syllable rules. Vowel groups are syllable nuclei; the consonants
 * between two nuclei split so that the next syllable starts with a cluster
 * that can begin a syllable, digraphs stay together, doubled consonants
 * split, and common prefixes and suffixes are syllables of their own. A
 * final silent "e" (and the "-es"/"-ed" endings that do not add a syllable)
 * is not a nucleus. The rules are English ones: words in other languages
 * (see model/languages.js) are not hyphenated until rules for them exist.
 */
import { languageBase } from './languages.js';

export const HYPHENATION_DEFAULTS = Object.freeze({
  minWord: 6, // shortest word to hyphenate (letters)
  minBefore: 2, // letters before a hyphen
  minAfter: 2, // letters after a hyphen
  limit: 2, // consecutive hyphenated lines (0 = no limit)
  zone: 36, // unjustified text: hyphenate only when the line would end further than this from the margin (pt)
  capitalized: true, // hyphenate words that start with a capital
});

/** Hyphenation settings of a paragraph with the defaults filled in. */
export function hyphenationOf(para) {
  return { ...HYPHENATION_DEFAULTS, ...(para?.hyphenation || {}) };
}

const VOWELS = new Set('aeiouàáâãäåæèéêëìíîïòóôõöøœùúûüýÿ');
const DIGRAPHS = new Set(['ch', 'sh', 'th', 'ph', 'wh', 'gh', 'qu', 'gu']);
const ONSETS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw', 'wr', 'kn', 'ch', 'sh', 'th', 'ph', 'wh', 'qu', 'scr', 'spl', 'spr', 'str', 'squ', 'thr', 'shr', 'sch', 'chr']);
const PREFIXES = ['counter', 'inter', 'under', 'trans', 'super', 'over', 'anti', 'semi', 'multi', 'non', 'dis', 'mis', 'pre', 'out', 'sub', 'un', 're'];
const SUFFIXES = ['tions', 'sions', 'tion', 'sion', 'ments', 'ment', 'ness', 'less', 'ship', 'able', 'ible', 'ful', 'ings', 'ing'];
const SYLLABIC_ES = /(?:[sxzc]|ch|sh|g)es$/;
const SYLLABIC_ED = /[td]ed$/;

function vowelAt(w, i) {
  const c = w[i];
  if (VOWELS.has(c)) return !(c === 'u' && i > 0 && w[i - 1] === 'q');
  // "y" is a vowel after a consonant ("hyphen", "rhythm"), a consonant at the start or after a vowel ("yes", "player").
  if (c === 'y') return i > 0 && !VOWELS.has(w[i - 1]);
  return false;
}

/** Where a consonant cluster between two nuclei splits: the number of its letters that stay with the first syllable. */
function splitCluster(c) {
  const n = c.length;
  if (n === 1) return c === 'x' ? 1 : 0;
  if (n === 2) {
    if (c === 'ck') return 2;
    if (DIGRAPHS.has(c)) return 0;
    return 1;
  }
  // Longest cluster (up to three letters) that can start the next syllable, leaving at least one letter.
  for (let k = Math.min(3, n - 1); k >= 2; k--) {
    const tail = c.slice(n - k);
    if (ONSETS.has(tail)) {
      // A digraph at the start stays whole ("ath-lete").
      const head = c.slice(0, n - k);
      return head.length === 1 || !DIGRAPHS.has(c.slice(0, 2)) ? n - k : 2;
    }
  }
  // No onset: the last consonant starts the next syllable ("ing-ton").
  return DIGRAPHS.has(c.slice(0, 2)) && n === 3 ? 2 : n - 1;
}

const cache = new Map();

/** Break points of a lower-case word: indexes k where it can break between word[k-1] and word[k]. */
function rawPoints(w) {
  let hit = cache.get(w);
  if (hit) return hit;
  const n = w.length;
  // Syllable nuclei: runs of vowels.
  const nuclei = [];
  for (let i = 0; i < n; ) {
    if (!vowelAt(w, i)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && vowelAt(w, j)) j++;
    nuclei.push([i, j]);
    i = j;
  }
  // Silent endings: "-e" (not "-le"), "-es" and "-ed" that add no syllable.
  const last = nuclei[nuclei.length - 1];
  if (nuclei.length > 1 && last) {
    const tail = w.slice(last[0]);
    const silentE = tail === 'e' && !/[^aeiou]le$/.test(w);
    const silentEs = tail === 'es' && !SYLLABIC_ES.test(w);
    const silentEd = tail === 'ed' && !SYLLABIC_ED.test(w);
    if (silentE || silentEs || silentEd) nuclei.pop();
  }
  const points = new Set();
  for (let k = 1; k < nuclei.length; k++) {
    const a = nuclei[k - 1][1];
    const b = nuclei[k][0];
    if (b <= a) continue;
    points.add(a + splitCluster(w.slice(a, b)));
  }
  // Prefixes and suffixes are syllables of their own.
  for (const p of PREFIXES) {
    // Short prefixes only before a consonant: "re-view", but not "re-adable"; "over-all" is fine.
    if (w.startsWith(p) && n - p.length >= 3 && (p.length >= 4 || !vowelAt(w, p.length)) && nuclei.some(([s]) => s >= p.length)) {
      for (const q of [...points]) if (q > 0 && q < p.length + 1 && q !== p.length) points.delete(q);
      points.add(p.length);
      break;
    }
  }
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && n - s.length >= 2) {
      // The suffix boundary replaces the rule breaks right next to it ("re-mark-able").
      const at = n - s.length;
      points.delete(at - 1);
      points.delete(at + 1);
      points.add(at);
      break;
    }
  }
  // A consonant before a final "-le" starts its syllable ("ta-ble").
  if (/[^aeiouy]le$/.test(w) && nuclei.length > 1) {
    points.delete(n - 2);
    points.add(n - 3);
  }
  hit = [...points].filter((k) => k > 0 && k < n).sort((x, y) => x - y);
  if (cache.size > 5000) cache.clear();
  cache.set(w, hit);
  return hit;
}

/**
 * Hyphenation points of a word under a paragraph's settings (see
 * HYPHENATION_DEFAULTS): indexes k where it may break with a hyphen after
 * word[k-1]. Words with non-letters, short words and (optionally)
 * capitalized words get none.
 */
export function hyphenPoints(word, opts = HYPHENATION_DEFAULTS, language = null) {
  const rules = hyphenationRules(language);
  if (!rules) return [];
  const o = { ...HYPHENATION_DEFAULTS, ...opts };
  if (word.length < Math.max(2, o.minWord) || !/^\p{L}+$/u.test(word)) return [];
  if (!o.capitalized && word[0] !== word[0].toLowerCase()) return [];
  // All-caps words are usually acronyms.
  if (word.length > 1 && word === word.toUpperCase()) return [];
  const before = Math.max(1, o.minBefore);
  const after = Math.max(1, o.minAfter);
  return rules(word.toLowerCase()).filter((k) => k >= before && word.length - k >= after);
}

/** Hyphenation rules by primary language subtag: lowercase word -> break offsets. */
const RULES = { en: rawPoints };

/** The rules for a language (null when it has none: no hyphenation); no language means English. */
export function hyphenationRules(language) {
  return RULES[languageBase(language)] || null;
}

/** A word with its hyphenation points shown (for tests and previews): "hy-phen-ation". */
export function hyphenateWord(word, opts, language) {
  const pts = hyphenPoints(word, opts, language);
  let out = '';
  let prev = 0;
  for (const k of pts) {
    out += `${word.slice(prev, k)}-`;
    prev = k;
  }
  return out + word.slice(prev);
}
