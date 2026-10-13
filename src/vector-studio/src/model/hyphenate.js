/**
 * Automatic hyphenation. Languages with a pattern file
 * (model/hyphenation/patterns.js) hyphenate with Liang's patterns
 * (model/liang.js) once their file has loaded; loading starts the first
 * time a hyphenated paragraph asks for the language (see
 * setHyphenationLoader), and until then English uses the syllable rules
 * below and other languages are left whole. Exception lists (Preferences >
 * Hyphenation) fix the breaks of particular words per language.
 *
 * The fallback rules work without a dictionary: vowel groups are syllable
 * nuclei; the consonants between two nuclei split so that the next syllable
 * starts with a cluster that can begin a syllable, digraphs stay together,
 * doubled consonants split, and common prefixes and suffixes are syllables
 * of their own. A final silent "e" (and the "-es"/"-ed" endings that do not
 * add a syllable) is not a nucleus.
 */
import { languageBase } from './languages.js';
import { compilePatterns, parseException } from './liang.js';
import { PATTERN_FILES, patternKey } from './hyphenation/patterns.js';

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
  const ex = exceptionFor(language, word.toLowerCase());
  if (word.length < Math.max(2, o.minWord) || !/^\p{L}+$/u.test(word)) return [];
  if (!o.capitalized && word[0] !== word[0].toLowerCase()) return [];
  // All-caps words are usually acronyms.
  if (word.length > 1 && word === word.toUpperCase()) return [];
  const before = Math.max(1, o.minBefore);
  const after = Math.max(1, o.minAfter);
  return (ex ?? rules(word.toLowerCase())).filter((k) => k >= before && word.length - k >= after);
}

// ---- pattern files, loading and exceptions ----

const compiled = new Map(); // pattern key -> hyphenator
const pending = new Map(); // pattern key -> Promise
const requested = new Set(); // pattern keys the loader was asked for
let requestLoad = null;

/**
 * Who loads missing pattern files: fn(code) is called (once per pattern file)
 * when hyphenation asks for a language whose patterns have not loaded; the
 * app loads them and lays text out again. Without a loader, missing
 * languages stay on the fallback.
 */
export function setHyphenationLoader(fn) {
  requestLoad = fn;
}

/** Load the patterns of a language (resolves true when the language has patterns). */
export function loadHyphenation(code) {
  const key = patternKey(code);
  if (!key) return Promise.resolve(false);
  if (compiled.has(key)) return Promise.resolve(true);
  let p = pending.get(key);
  if (!p) {
    p = PATTERN_FILES[key]
      .load()
      .then((m) => {
        compiled.set(key, compilePatterns(m.default ?? m));
        return true;
      })
      .catch((err) => {
        pending.delete(key);
        throw err;
      });
    pending.set(key, p);
  }
  return p;
}

/** Whether a language's patterns are ready. */
export function hyphenationLoaded(code) {
  const key = patternKey(code);
  return Boolean(key && compiled.has(key));
}

/** Whether a language can be hyphenated at all (patterns exist, or the fallback rules). */
export function canHyphenate(code) {
  if (code === 'none') return false;
  return Boolean(patternKey(code)) || languageBase(code) === 'en';
}

let exceptionLists = new Map(); // language code (lower case) -> Map(word -> points)
let exceptionVersion = 0;

/**
 * Exception words by language code: { 'en-US': ['ty-po-graph-ic', 'Puter'] }.
 * An entry's hyphens are its only breaks; an entry without hyphens is never
 * hyphenated.
 */
export function setHyphenationExceptions(byLanguage) {
  exceptionLists = new Map();
  for (const [code, list] of Object.entries(byLanguage || {})) {
    if (!Array.isArray(list) || !list.length) continue;
    const m = new Map();
    for (const e of list) {
      const { word, points } = parseException(e);
      if (word) m.set(word, points);
    }
    exceptionLists.set(code.toLowerCase(), m);
  }
  exceptionVersion++;
}

export function hyphenationExceptionsVersion() {
  return exceptionVersion;
}

function exceptionFor(code, w) {
  if (!exceptionLists.size) return undefined;
  const tag = String(code || 'en-US').toLowerCase();
  return exceptionLists.get(tag)?.get(w) ?? exceptionLists.get(languageBase(tag))?.get(w);
}

/**
 * The rules for a language: lowercase word -> break offsets, or null (no
 * hyphenation). No language means English. Asks the loader for patterns
 * that are not there yet.
 */
export function hyphenationRules(language) {
  if (language === 'none') return null;
  const key = patternKey(language);
  const hit = key && compiled.get(key);
  if (hit) return hit;
  if (key && requestLoad && !pending.has(key) && !requested.has(key)) {
    // Ask once, after the layout pass that needed it.
    requested.add(key);
    const load = requestLoad;
    Promise.resolve().then(() => load(language));
  }
  return languageBase(language) === 'en' ? rawPoints : null;
}

/** The fallback syllable rules (English), for tests and previews. */
export const englishRules = rawPoints;

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
