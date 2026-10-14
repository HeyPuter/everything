/**
 * AutoCorrect: small fixes made to text as it is typed into a cell, never to a formula.
 *
 * A correction is looked for when a word ends: a space, a line break or a punctuation mark typed after it
 * (correctBeforeCaret), or the entry committed (correctTail). The word is the run of text since the last
 * whitespace. In order:
 *  - the replacement list: the whole word ("(c)", "--", "teh") or its letters ("teh," → "the,"), matched
 *    without regard to case; a word typed with a capital, or in capitals, keeps that case;
 *  - TWo INitial CApitals: a word of three or more letters whose first two are capitals and the rest small
 *    letters gets a small second letter, unless the word is on the exceptions list (IDs, PCs …);
 *  - accidental caps lock: "hELLO" (a small first letter and capitals after) is "Hello";
 *  - names of days: "monday" is "Monday";
 *  - first letter of a sentence: a word after a full stop, question or exclamation mark and a space starts
 *    with a capital, unless the word before is an abbreviation on the exceptions list (e.g., etc., Dr.).
 *    The first word of a cell is left as typed: a list of lowercase codes or tags is common in a sheet.
 *  - math symbols (off unless switched on): "\alpha" is "α", "\infty" is "∞" ….
 */

export const DEFAULT_REPLACEMENTS = [
  ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['(e)', '€'], ['...', '…'], ['--', '–'], ['---', '—'],
  ['->', '→'], ['<-', '←'], ['<->', '↔'], ['=>', '⇒'], ['<=>', '⇔'], ['+-', '±'], ['!=', '≠'], ['~=', '≈'],
  ['abotu', 'about'], ['accomodate', 'accommodate'], ['acheive', 'achieve'], ['acknowledgement', 'acknowledgment'], ['adn', 'and'],
  ['alot', 'a lot'], ['amoung', 'among'], ['basicly', 'basically'], ['becasue', 'because'], ['becuase', 'because'], ['beggining', 'beginning'],
  ['beleive', 'believe'], ['calender', 'calendar'], ['catagory', 'category'], ['comming', 'coming'], ['commitee', 'committee'],
  ['definately', 'definitely'], ['dont', 'don’t'], ['doesnt', 'doesn’t'], ['existance', 'existence'], ['foriegn', 'foreign'],
  ['freind', 'friend'], ['goverment', 'government'], ['hte', 'the'], ['independant', 'independent'], ['occured', 'occurred'],
  ['occurence', 'occurrence'], ['neccessary', 'necessary'], ['recieve', 'receive'], ['recieved', 'received'], ['recomend', 'recommend'],
  ['seperate', 'separate'], ['succesful', 'successful'], ['teh', 'the'], ['thier', 'their'], ['tommorow', 'tomorrow'], ['tomorow', 'tomorrow'],
  ['truely', 'truly'], ['untill', 'until'], ['wich', 'which'], ['wierd', 'weird'], ['wont', 'won’t'], ['yuo', 'you'],
].map(([from, to]) => ({ from, to }));

/** Words after which a sentence does not start (abbreviations ending in a full stop). */
export const DEFAULT_FIRST_LETTER_EXCEPTIONS = ['approx.', 'cf.', 'dept.', 'dr.', 'e.g.', 'etc.', 'fig.', 'i.e.', 'inc.', 'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.', 'ltd.', 'misc.', 'mr.', 'mrs.', 'ms.', 'no.', 'p.', 'pp.', 'prof.', 'qty.', 'st.', 'vs.'];

/** Words left as typed by the two-initial-capitals rule. */
export const DEFAULT_INITIAL_CAPS_EXCEPTIONS = ['IDs', 'PCs', 'CDs', 'TVs', 'OKs', 'ATMs'];

/** "\name" words the math rule turns into symbols. */
export const MATH_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π', infty: '∞', pm: '±', times: '×', div: '÷', le: '≤', ge: '≥', ne: '≠',
  approx: '≈', sqrt: '√', sum: '∑', prod: '∏', int: '∫', partial: '∂', in: '∈', notin: '∉', degree: '°', rightarrow: '→', leftarrow: '←', cdot: '·',
};

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const DEFAULT_AUTOCORRECT = {
  replaceText: true,
  twoInitialCaps: true,
  sentenceCaps: true,
  dayNames: true,
  capsLock: true,
  mathSymbols: false,
  replacements: DEFAULT_REPLACEMENTS,
  firstLetterExceptions: DEFAULT_FIRST_LETTER_EXCEPTIONS,
  initialCapsExceptions: DEFAULT_INITIAL_CAPS_EXCEPTIONS,
};

const MAX_ENTRIES = 2000;
const cleanList = (list, fallback) => (Array.isArray(list) ? list.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim().slice(0, 64)).slice(0, MAX_ENTRIES) : fallback.slice());

/** Settings as stored (or anything else) made whole: the defaults fill in what is missing or malformed. */
export function normalizeAutoCorrect(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const flag = (k) => (typeof o[k] === 'boolean' ? o[k] : DEFAULT_AUTOCORRECT[k]);
  const replacements = Array.isArray(o.replacements)
    ? o.replacements.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string' && e.from.trim() && !/\s/.test(e.from.trim()))
      .map((e) => ({ from: e.from.trim().slice(0, 64), to: e.to.slice(0, 255) })).slice(0, MAX_ENTRIES)
    : DEFAULT_REPLACEMENTS.map((e) => ({ ...e }));
  return {
    replaceText: flag('replaceText'), twoInitialCaps: flag('twoInitialCaps'), sentenceCaps: flag('sentenceCaps'), dayNames: flag('dayNames'),
    capsLock: flag('capsLock'), mathSymbols: flag('mathSymbols'), replacements,
    firstLetterExceptions: cleanList(o.firstLetterExceptions, DEFAULT_FIRST_LETTER_EXCEPTIONS),
    initialCapsExceptions: cleanList(o.initialCapsExceptions, DEFAULT_INITIAL_CAPS_EXCEPTIONS),
  };
}

/** Text the corrections leave alone: a formula, and an entry forced to text that starts with one. */
export const isFormulaText = (text) => /^\s*[=+]/.test(String(text)) || /^'?=/.test(String(text));

/** A character that ends a word as it is typed. */
export const isWordEnd = (ch) => typeof ch === 'string' && ch.length === 1 && /[\s.,;:!?)\]}"'”’]/.test(ch);

/** The replacement word cased like the typed one: "Teh" → "The", "TEH" → "THE". */
function caseLike(typed, word) {
  const letters = typed.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return word.toUpperCase();
  if (letters && letters[0] === letters[0].toUpperCase() && letters[0] !== letters[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function replacementFor(token, settings) {
  const lower = token.toLowerCase();
  // An entry spelt with capitals matches only as spelt; one in small letters matches any case.
  let hit = settings.replacements.find((e) => e.from === token);
  if (!hit) hit = settings.replacements.find((e) => e.from === e.from.toLowerCase() && e.from.toLowerCase() === lower);
  if (!hit) return null;
  return /\p{L}/u.test(hit.from) && hit.from === hit.from.toLowerCase() ? caseLike(token, hit.to) : hit.to;
}

/**
 * The correction for the word that ends at `end` in `text` (the word starts after the last whitespace before
 * `end`), or null. { start, end, from, to, rule }: text.slice(start, end) === from is to be replaced by `to`.
 */
export function correctWord(text, end, raw) {
  const settings = raw?.replacements ? raw : normalizeAutoCorrect(raw);
  text = String(text);
  if (isFormulaText(text) || end <= 0) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, end);
  const result = (from, to, rule, offset = 0) => (to == null || to === from ? null : { start: start + offset, end: start + offset + from.length, from, to, rule });
  // Math symbols: \name.
  if (settings.mathSymbols) {
    const m = /^\\([A-Za-z]+)$/.exec(token);
    if (m && MATH_SYMBOLS[m[1]]) return result(token, MATH_SYMBOLS[m[1]], 'math');
  }
  if (!token || /[@/\\]|:\/\/|^www\./i.test(token)) return null; // addresses, paths and links are left as typed
  // The whole token, then its letters without the punctuation around them.
  const parts = /^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’-]*?)([^\p{L}\p{N}]*)$/u.exec(token);
  if (settings.replaceText) {
    const whole = replacementFor(token, settings);
    if (whole != null) return result(token, whole, 'replace');
    if (parts && (parts[1] || parts[3])) {
      const inner = replacementFor(parts[2], settings);
      if (inner != null) return result(parts[2], inner, 'replace', parts[1].length);
    }
  }
  if (!parts) return null;
  const [, lead, word] = parts;
  const at = lead.length;
  if (/\d/.test(word)) return null; // part numbers and codes stay as typed
  if (settings.twoInitialCaps && /^\p{Lu}\p{Lu}\p{Ll}+$/u.test(word) && word.length >= 3 && !settings.initialCapsExceptions.includes(word)) {
    return result(word, word[0] + word[1].toLowerCase() + word.slice(2), 'twoInitialCaps', at);
  }
  if (settings.capsLock && /^\p{Ll}\p{Lu}{2,}$/u.test(word)) {
    return result(word, word[0].toUpperCase() + word.slice(1).toLowerCase(), 'capsLock', at);
  }
  if (settings.dayNames && DAYS.includes(word)) return result(word, word[0].toUpperCase() + word.slice(1), 'dayNames', at);
  if (settings.sentenceCaps && /^\p{Ll}/u.test(word) && startsSentence(text, start + at, settings)) {
    return result(word, word[0].toUpperCase() + word.slice(1), 'sentenceCaps', at);
  }
  return null;
}

/** Whether the word at `index` follows the end of a sentence (and so is not the first word of the cell). */
function startsSentence(text, index, settings) {
  const before = text.slice(0, index);
  const m = /(\S+)\s+$/.exec(before);
  if (!m || !/[.!?]["'”’)]*$/.test(m[1])) return false;
  const prev = m[1].replace(/["'”’)]+$/, '').toLowerCase();
  // An abbreviation, or a single letter with a full stop (an initial), does not end a sentence.
  if (settings.firstLetterExceptions.some((w) => w.toLowerCase() === prev)) return false;
  if (/^\p{L}\.$/u.test(prev)) return false;
  return true;
}

/**
 * A word-ending character was just typed at `caret - 1`: the text with the word before it corrected, or null.
 * { text, caret, correction }.
 */
export function correctBeforeCaret(text, caret, settings) {
  text = String(text);
  if (caret < 1 || !isWordEnd(text[caret - 1])) return null;
  const correction = correctWord(text, caret - 1, settings);
  return correction ? applyCorrection(text, caret, correction) : null;
}

/** The entry is being committed: its last word, corrected (the text as it was when there is nothing to do). */
export function correctTail(text, settings) {
  text = String(text);
  const end = text.replace(/\s+$/, '').length;
  const correction = correctWord(text, end, settings);
  return correction ? applyCorrection(text, text.length, correction).text : text;
}

function applyCorrection(text, caret, correction) {
  const next = text.slice(0, correction.start) + correction.to + text.slice(correction.end);
  return { text: next, caret: caret + correction.to.length - correction.from.length, correction };
}
