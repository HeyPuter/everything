/**
 * Spell checking for documents: which words to check, how to rank suggestions, and the user's own
 * dictionary. The word list is the vendored en_US Hunspell dictionary (SCOWL), loaded on first use.
 */

const PERSONAL_KEY = 'documents:dictionary';

/** The default proofing options: skip words in UPPERCASE, words with numbers, and internet and file addresses. */
const ADDRESS = /^(?:https?:\/\/|www\.|mailto:)|@|\\|\/|\.[a-z]{2,4}$/i;

// Keep source offsets while introducing proofing boundaries at exempt runs.
// The ordinary fragment of a mixed noProof word is checked independently.
// The original text/model is never changed; no-exemption documents reuse text.
const foreignLanguage = language => !!language && !/^(?:en|x-none)(?:-|$)/i.test(language);
export function proofingText(text, paragraphs) {
  const pieces = [];
  let offset = 0, start = 0;
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) {
      const end = offset + run.text.length;
      // No-proofing text, text marked in another language (§17.3.2.20) and text already tracked as deleted are
      // not checked: correcting a deleted word would bring it back.
      if ((run.noProof || foreignLanguage(run.fontLanguage) || run.revision?.type === 'del') && end > offset) {
        pieces.push(text.slice(start, offset), ' '.repeat(end - offset));
        start = end;
      }
      offset = end;
    }
    offset++; // Paragraph separators occupy one source offset.
  }
  return pieces.length ? pieces.join('') + text.slice(start) : text;
}

/**
 * The words spelling checks: [{ start, end, word, wordStart?, wordEnd? }]. Hyphenated compounds are checked part by part;
 * apostrophes inside a word stay part of it and typographic ones are normalized.
 */
export function wordsToCheck(text) {
  const words = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  for (const segment of segmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    const start = segment.index, end = start + segment.segment.length;
    // An address or path runs across several segments: skip each piece that sits inside one.
    // Any whitespace bounds the token, not only a space: paragraphs are joined by line breaks, and an
    // address ending one paragraph must not exempt the first word of the next.
    let before = start;
    while (before > 0 && !/\s/.test(text[before - 1])) before--;
    const after = text.slice(end).search(/[\s]/);
    const token = text.slice(before, after < 0 ? text.length : end + after).replace(/[\s\u000b\f\n]+/g, '');
    if (ADDRESS.test(token.replace(/[.,;:!?)"'’”]+$/, ''))) continue;
    const word = segment.segment.replace(/’/g, "'");
    if (/\d/.test(word) || /_/.test(word)) continue;
    if (word.length > 1 && word === word.toUpperCase() && /\p{Lu}/u.test(word)) continue;
    // The only dictionary is English: a word with no Latin letter (Thai, Cyrillic, Han...) is not checked.
    if (!/\p{Script=Latin}/u.test(word)) continue;
    // Possessive and contraction forms the dictionary may lack: check the word itself. When that is less
    // than the segment, wordStart and wordEnd say where it is, so a correction keeps the "'s" and apostrophes.
    const trimmed = word.replace(/'s$/i, '').replace(/^'+|'+$/g, '');
    if (!trimmed || trimmed === word) { words.push({ start, end, word: trimmed || word }); continue; }
    const wordStart = start + word.match(/^'*/)[0].length;
    words.push({ start, end, word: trimmed, wordStart, wordEnd: wordStart + trimmed.length });
  }
  return words;
}

/** Damerau–Levenshtein distance, and whether the cheapest path is a single swap of neighbours. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const droppedVowel = (a, b) => b.length === a.length + 1 && [...b].some((ch, i) => /[aeiouy]/.test(ch) && b.slice(0, i) + b.slice(i + 1) === a);
const isSwap = (a, b) => a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length === 2 && [...a].sort().join() === [...b].sort().join();

/**
 * Order suggestions as a word processor lists them: closest first, a swapped pair of letters before
 * other single edits, then the same length and first letter, keeping the word's capitalization.
 */
export function rankSuggestions(word, suggestions, limit = 6) {
  const lower = word.toLowerCase(), capitalized = word[0] === word[0]?.toUpperCase() && word.slice(1) === word.slice(1).toLowerCase() && word[0] !== word[0]?.toLowerCase();
  const scored = [...new Set(suggestions)].map((s, index) => {
    const candidate = s.toLowerCase();
    let score = distance(lower, candidate) * 10;
    if (isSwap(lower, candidate)) score -= 6;
    if (droppedVowel(lower, candidate)) score -= 3; // a left-out vowel is the commonest slip after a swap
    if (candidate.length !== lower.length) score += 2;
    if (candidate[0] !== lower[0]) score += 3;
    if (s !== candidate && word === lower) score += 4; // a proper noun for a lowercase word
    return { s, score, index };
  }).sort((a, b) => a.score - b.score || a.index - b.index);
  const out = [];
  for (const { s } of scored) {
    const shaped = capitalized && s === s.toLowerCase() ? s[0].toUpperCase() + s.slice(1) : word === word.toUpperCase() && word.length > 1 ? s.toUpperCase() : s;
    if (!out.includes(shaped)) out.push(shaped);
    if (out.length >= limit) break;
  }
  return out;
}

export function personalWords() {
  try { const list = JSON.parse(localStorage.getItem(PERSONAL_KEY) || '[]'); return Array.isArray(list) ? list.filter(w => typeof w === 'string') : []; }
  catch { return []; }
}
export function addPersonalWord(word) {
  const list = personalWords();
  if (!list.includes(word)) { list.push(word); try { localStorage.setItem(PERSONAL_KEY, JSON.stringify(list.slice(-5000))); } catch { /* storage full or blocked */ } }
}

let speller = null;
/** Load the dictionary once: { correct(word), suggest(word), add(word) }. */
export function loadSpeller(base = document.baseURI) {
  speller ??= (async () => {
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import('nspell'),
      fetch(new URL('dictionaries/en-US.aff', base)).then(r => { if (!r.ok) throw new Error('The spelling dictionary could not be loaded.'); return r.text(); }),
      fetch(new URL('dictionaries/en-US.dic', base)).then(r => { if (!r.ok) throw new Error('The spelling dictionary could not be loaded.'); return r.text(); }),
    ]);
    const engine = nspell(aff, dic);
    for (const word of personalWords()) engine.add(word);
    return {
      correct: word => engine.correct(word) || engine.correct(word.toLowerCase()) && word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase(),
      suggest: word => rankSuggestions(word, engine.suggest(word)),
      add: word => { engine.add(word); addPersonalWord(word); },
    };
  })().catch(error => { speller = null; throw error; });
  return speller;
}
