/**
 * Automatic hyphenation: an original, rule-based English syllabifier and the line-end decision that
 * uses it. No third-party pattern data is used. The rules favour precision over recall: a missed
 * break only leaves a line a little shorter, while a wrong one is visible, so ambiguous positions
 * (vowel pairs, mixed-case words, words with digits or symbols) are never broken.
 *
 * Positions are code-unit indices into the word: a point p breaks the word into word.slice(0, p)
 * and word.slice(p), with a hyphen shown after the first part.
 */

/** Typographic minimums for English: two letters before a break and three after it. */
export const LEFT_MIN = 2, RIGHT_MIN = 3, MIN_WORD = LEFT_MIN + RIGHT_MIN;

const VOWEL = /[aeiou]/;
// Consonant pairs that spell one sound and stay together at the start of a syllable.
const INITIAL_DIGRAPHS = new Set(['ch', 'sh', 'th', 'ph', 'wh', 'qu']);
// Pairs that close a syllable: the break comes after them (tick-et, sing-er, laugh-able).
const FINAL_DIGRAPHS = new Set(['ck', 'ng', 'gh']);
// Clusters that can begin an English syllable, longest first when scanning.
const ONSETS = new Set(['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'tr', 'tw', 'dw', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'sc',
  'thr', 'shr', 'phr', 'phl', 'chr', 'sch', 'scr', 'spl', 'spr', 'str', 'squ', 'skr']);
// After a short vowel a two-letter s-cluster is usually split (mis-ter, whis-per, dis-cuss).
const SPLIT_PAIRS = new Set(['sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'sc']);
// Prefixes whose boundary is a reliable break when a consonant follows and enough of the word remains.
const PREFIXES = ['counter', 'under', 'inter', 'intra', 'trans', 'super', 'hyper', 'ultra', 'extra', 'micro', 'multi', 'semi', 'tele', 'auto', 'over', 'post', 'fore', 'mis', 'dis', 'non', 'sub', 'out', 'un'];
// Suffixes that attach to a whole stem; the stem is syllabified on its own (state-ment, care-ful).
const STEM_SUFFIXES = ['ments', 'ment', 'ness', 'less', 'ship', 'hood', 'ful', 'ly'];
// Words the rules split badly, with their break points written out (original list).
const EXCEPTIONS = new Map([
  ['present', 'pres-ent'], ['record', 'rec-ord'], ['project', 'proj-ect'], ['product', 'prod-uct'], ['progress', 'prog-ress'],
  ['every', 'ev-ery'], ['several', 'sev-eral'], ['general', 'gen-eral'], ['government', 'gov-ern-ment'], ['governments', 'gov-ern-ments'],
  ['develop', 'de-vel-op'], ['development', 'de-vel-op-ment'], ['family', 'fam-ily'], ['minute', 'min-ute'], ['finish', 'fin-ish'],
  ['problem', 'prob-lem'], ['problems', 'prob-lems'], ['product', 'prod-uct'], ['products', 'prod-ucts'], ['knowledge', 'knowl-edge'],
  ['company', 'com-pany'], ['companies', 'com-pa-nies'], ['business', 'busi-ness'], ['citizen', 'cit-izen'], ['city', 'city'],
  ['study', 'study'], ['student', 'stu-dent'], ['students', 'stu-dents'], ['national', 'na-tional'], ['natural', 'nat-ural'],
  ['position', 'po-si-tion'], ['positions', 'po-si-tions'], ['possible', 'pos-si-ble'], ['similar', 'sim-ilar'], ['visible', 'vis-ible'],
  ['history', 'his-tory'], ['habit', 'habit'], ['value', 'value'], ['figure', 'fig-ure'], ['figures', 'fig-ures'],
  ['planet', 'plan-et'], ['planets', 'plan-ets'], ['second', 'sec-ond'], ['seconds', 'sec-onds'], ['seven', 'seven'],
  ['eleven', 'eleven'], ['level', 'level'], ['levels', 'lev-els'], ['model', 'model'], ['models', 'mod-els'],
  ['method', 'meth-od'], ['methods', 'meth-ods'], ['metal', 'metal'], ['medical', 'med-ical'], ['memory', 'mem-ory'],
  ['moment', 'mo-ment'], ['money', 'money'], ['never', 'never'], ['other', 'other'], ['others', 'oth-ers'],
  ['period', 'pe-ri-od'], ['private', 'pri-vate'], ['proper', 'prop-er'], ['properly', 'prop-erly'], ['property', 'prop-erty'],
  ['public', 'pub-lic'], ['reason', 'rea-son'], ['reasons', 'rea-sons'], ['robin', 'robin'], ['second', 'sec-ond'],
  ['shadow', 'shad-ow'], ['solid', 'solid'], ['special', 'spe-cial'], ['travel', 'trav-el'], ['widow', 'wid-ow'],
  ['window', 'win-dow'], ['windows', 'win-dows'], ['women', 'wom-en'], ['woman', 'wom-an'], ['water', 'wa-ter'],
  ['language', 'lan-guage'], ['languages', 'lan-guages'], ['english', 'eng-lish'], ['document', 'doc-u-ment'], ['documents', 'doc-u-ments'],
  ['paragraph', 'para-graph'], ['paragraphs', 'para-graphs'], ['hyphenation', 'hy-phen-ation'], ['hyphenate', 'hy-phen-ate'], ['hyphenated', 'hy-phen-ated'],
  ['automatic', 'au-to-mat-ic'], ['automatically', 'au-to-mat-i-cally'], ['information', 'in-for-ma-tion'], ['different', 'dif-fer-ent'], ['difference', 'dif-fer-ence'],
  ['interest', 'in-ter-est'], ['interesting', 'in-ter-est-ing'], ['children', 'chil-dren'], ['example', 'ex-am-ple'], ['examples', 'ex-am-ples'],
  ['probably', 'prob-a-bly'], ['another', 'an-oth-er'], ['however', 'how-ev-er'], ['whatever', 'what-ev-er'], ['without', 'with-out'],
  ['within', 'with-in'], ['therefore', 'there-fore'], ['nowhere', 'no-where'], ['somewhere', 'some-where'], ['everywhere', 'ev-ery-where'],
  ['everyone', 'ev-ery-one'], ['someone', 'some-one'], ['sometimes', 'some-times'], ['together', 'to-geth-er'], ['character', 'char-ac-ter'],
  ['characters', 'char-ac-ters'], ['political', 'po-lit-i-cal'], ['politics', 'pol-i-tics'], ['typography', 'ty-pog-ra-phy'], ['available', 'avail-able'],
  ['responsibility', 're-spon-si-bil-ity'], ['management', 'man-age-ment'], ['temperature', 'tem-per-a-ture'], ['significant', 'sig-nif-i-cant'], ['knowledge', 'knowl-edge'],
]);

const isLetter = ch => /[a-z]/.test(ch);
const unique = list => [...new Set(list)].sort((a, b) => a - b);

/** Syllable nuclei of a lowercase word as [start, end) spans of vowel letters. */
function nuclei(w) {
  const spans = [];
  const vowelAt = i => {
    const ch = w[i];
    if (VOWEL.test(ch)) return !(ch === 'u' && w[i - 1] === 'q'); // the u of qu is part of the consonant
    // y is a vowel after a consonant (city, rhythm), a consonant at the start or after a vowel (yes, player).
    return ch === 'y' && i > 0 && !VOWEL.test(w[i - 1]) && w[i - 1] !== 'y';
  };
  for (let i = 0; i < w.length; i++) {
    if (!vowelAt(i)) continue;
    const last = spans.at(-1);
    if (last && last[1] === i) last[1] = i + 1; else spans.push([i, i + 1]);
  }
  if (spans.length < 2) return spans;
  const last = spans.at(-1), end = w.length;
  const consonant = i => i >= 0 && !vowelAt(i);
  // A final silent e (make, complete) is not a syllable, except in consonant + le (ta-ble, lit-tle).
  if (last[0] === end - 1 && last[1] === end && w[end - 1] === 'e' && consonant(end - 2) && !(w[end - 2] === 'l' && consonant(end - 3) && w[end - 3] !== 'l')) spans.pop();
  // -es and -ed form no syllable except after sibilants (box-es) or t/d (want-ed).
  else if (last[0] === end - 2 && last[1] === end - 1 && w[end - 2] === 'e' && consonant(end - 3) && !(/[lr]/.test(w[end - 3]) && consonant(end - 4) && w[end - 4] !== w[end - 3])) {
    if (w[end - 1] === 'd' && !/[td]/.test(w[end - 3])) spans.pop();
    else if (w[end - 1] === 's' && !/[sxz]/.test(w[end - 3]) && !/(ch|sh|g|c)$/.test(w.slice(0, end - 2))) spans.pop();
  }
  return spans;
}

/** Where a consonant cluster [a, b) between two nuclei divides. */
function clusterBreak(w, a, b) {
  const cluster = w.slice(a, b), n = cluster.length;
  if (n === 0) return null; // two vowel groups meeting: ambiguous, never broken
  if (n === 1) return cluster === 'x' ? b : a; // ex-am-ple; otherwise the consonant starts the syllable (pa-per)
  if (n === 2) {
    if (FINAL_DIGRAPHS.has(cluster)) return b;
    if (INITIAL_DIGRAPHS.has(cluster)) return a;
    if (cluster[0] === cluster[1]) return a + 1;
    if (ONSETS.has(cluster) && !SPLIT_PAIRS.has(cluster)) return a;
    return a + 1;
  }
  // Longer clusters: the closing syllable keeps a final digraph; the next syllable starts with the
  // longest cluster that can begin a syllable, and at least one consonant stays behind.
  if (cluster[0] === cluster[1]) return a + 1; // lit-tle, set-tle
  let from = a + 1;
  if (FINAL_DIGRAPHS.has(w.slice(a, a + 2)) || INITIAL_DIGRAPHS.has(w.slice(a, a + 2)) && !ONSETS.has(w.slice(a, b))) from = a + 2;
  for (let s = from; s < b; s++) {
    const onset = w.slice(s, b);
    if (onset.length === 1 || ONSETS.has(onset) || INITIAL_DIGRAPHS.has(onset)) {
      // Do not split a digraph across the break (pamph-let rather than pamp-hlet).
      if (s > a && INITIAL_DIGRAPHS.has(w.slice(s - 1, s + 1)) && !ONSETS.has(w.slice(s - 1, b))) continue;
      return s;
    }
  }
  return b - 1;
}

/** Break points of a lowercase word of plain letters, before the minimums are applied. */
function syllablePoints(w) {
  const spans = nuclei(w), points = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    let point = clusterBreak(w, spans[i][1], spans[i + 1][0]);
    // -tion and -sion keep their n before a following vowel (na-tion-al, pro-fes-sion-al).
    if (point !== null && /[ts]io$/.test(w.slice(0, point)) && w[point] === 'n' && VOWEL.test(w[point + 1] || '')) point++;
    // A vowel pair before -tion divides before its a (cre-ation, vari-ation).
    if (point !== null && /^[ts]ion/.test(w.slice(point)) && w[point - 1] === 'a' && VOWEL.test(w[point - 2] || '')) point--;
    if (point !== null) points.push(point);
  }
  // A final syllabic -ed or -es is broken before the ending (want-ed, box-es): too short to break at all.
  if (spans.length > 1 && spans.at(-1)[0] === w.length - 2 && /e[ds]$/.test(w) && !/[^aeiouy][lr]e[ds]$/.test(w)) points.pop();
  // Consonant + le keeps its consonant (ta-ble, han-dled, ti-tles), after ck (pick-les).
  const le = /([^aeiouyl])l(e|es|ed)$/.exec(w);
  if (le && points.length) {
    const at = le.index;
    points[points.length - 1] = w.slice(at - 1, at + 1) === 'ck' ? at + 1 : at;
  }
  return points;
}

function rawPoints(w) {
  if (EXCEPTIONS.has(w)) {
    const points = []; let at = 0;
    for (const part of EXCEPTIONS.get(w).split('-').slice(0, -1)) { at += part.length; points.push(at); }
    return points;
  }
  // Inflected forms of listed words keep their stem's points.
  for (const ending of ['s', 'es', 'ed', 'ing']) {
    const stem = w.slice(0, -ending.length);
    if (w.endsWith(ending) && EXCEPTIONS.has(stem)) return [...rawPoints(stem), ...(ending === 'ing' ? [stem.length] : [])];
  }
  for (const suffix of STEM_SUFFIXES) {
    const stem = w.slice(0, -suffix.length);
    if (w.endsWith(suffix) && stem.length >= 3 && nuclei(stem).length && !(suffix === 'ly' && /[^aeiou]l$/.test(stem))) {
      return [...rawPoints(stem), stem.length];
    }
  }
  if (w.length > 6 && w.endsWith('thing')) return [...rawPoints(w.slice(0, -5)), w.length - 5];
  let points = syllablePoints(w);
  // -ing: break before the suffix (mak-ing, go-ing), between doubled consonants (run-ning) and before
  // a consonant + l (han-dling).
  if (w.length >= 6 && w.endsWith('ing')) {
    const at = w.length - 3, before = w[at - 1], previous = w[at - 2];
    let point = at;
    if (before === previous && !VOWEL.test(before)) point = at - 1;
    else if (before === 'l' && previous && !VOWEL.test(previous) && previous !== 'l') point = at - 2;
    const digraph = INITIAL_DIGRAPHS.has(w.slice(at - 2, at)) || FINAL_DIGRAPHS.has(w.slice(at - 2, at));
    points = points.filter(p => p < point - (digraph ? 2 : 1));
    points.push(point);
  }
  for (const prefix of PREFIXES) {
    if (!w.startsWith(prefix) || w.length - prefix.length < 4) continue;
    const next = w[prefix.length];
    if (VOWEL.test(next) || next === 'y' || next === prefix.at(-1)) continue;
    // Only accept the prefix when the rest still has a vowel of its own (dis-tance, not dis-h).
    if (!nuclei(w.slice(prefix.length)).length) continue;
    points = [...points.filter(p => p > prefix.length + 1), prefix.length, ...syllablePoints(prefix).filter(p => p < prefix.length)];
    break;
  }
  return points;
}

/**
 * Break points for one word, applying the left/right minimums. Words that are not plain Latin
 * letters (digits, symbols, inner punctuation other than an apostrophe, mixed case after the first
 * letter) get none. `caps: false` leaves words written entirely in capitals unhyphenated.
 */
export function hyphenationPoints(word, { caps = true } = {}) {
  if (typeof word !== 'string' || word.length < MIN_WORD || word.length > 64) return [];
  if (!/^[A-Za-z][A-Za-z'’]*[A-Za-z]$/.test(word)) return [];
  const upper = word === word.toUpperCase();
  if (upper && !caps) return [];
  if (!upper && /[A-Z]/.test(word.slice(1))) return [];
  const lower = word.toLowerCase();
  // Apostrophes split the word; each letter run is hyphenated on its own (rock'n'roll stays whole).
  const points = [];
  let offset = 0;
  for (const part of lower.split(/['’]/)) {
    if (part.length >= MIN_WORD && [...part].every(isLetter)) for (const p of rawPoints(part)) points.push(offset + p);
    offset += part.length + 1;
  }
  return unique(points).filter(p => p >= LEFT_MIN && p <= word.length - RIGHT_MIN && /[a-z]/i.test(word[p - 1]) && /[a-z]/i.test(word[p]));
}

/** The word with its break points marked, for dialogs and tests: hy-phen-ation. */
export function hyphenate(word, options) {
  const points = hyphenationPoints(word, options);
  let out = '', at = 0;
  for (const p of points) { out += word.slice(at, p) + '-'; at = p; }
  return out + word.slice(at);
}

/** English or unspecified languages are hyphenated; text tagged with another language is not. */
export function hyphenatedLanguage(language) {
  return !language || /^en(?:-|$)/i.test(language);
}

const TOKEN_STOP = /^[\s­‑‐-]$/u;
/**
 * The plain word around chars[index] in a laid-out paragraph: { from, to, start, end, text } where
 * [start, end) are the letter characters. Null for anything that is not a plain word (images,
 * fields, tabs, soft hyphens already present, URL-like or numeric tokens).
 */
export function lineWordAt(chars, index, lower = 0) {
  if (!chars[index] || TOKEN_STOP.test(chars[index].text)) return null;
  let from = index, to = index + 1;
  while (from > lower && chars[from - 1] && !TOKEN_STOP.test(chars[from - 1].text) && chars[from - 1].text) from--;
  while (to < chars.length && !TOKEN_STOP.test(chars[to].text) && chars[to].text) to++;
  const token = chars.slice(from, to);
  if (token.some(c => c.image || c.positionalTab || c.ignoredCellBreak || c.text.length !== 1)) return null;
  const text = token.map(c => c.text).join('');
  // Opening and closing punctuation around the word is allowed; anything inside it is not.
  const match = /^([("'‘“[]*)([A-Za-z][A-Za-z'’]*[A-Za-z])([)"'’”\].,;:!?]*)$/.exec(text);
  if (!match) return null;
  const start = from + match[1].length, end = start + match[2].length;
  return { from, to, start, end, text: match[2] };
}
