/**
 * Autocorrect as you type: straight quotes become
 * typographic ones, two hyphens between words an em dash, three periods an
 * ellipsis, (c) (r) (tm) their symbols, 1/2 1/4 3/4 real fractions, and the
 * pronoun i a capital.
 *
 * The engine inserts the typed character first; the correction then
 * replaces the characters just before the caret as its own step, so Undo
 * takes back the correction alone and leaves what was typed. It can be
 * switched off from the account menu.
 */

const KEY = 'documents:autocorrect';
const CAP_KEY = 'documents:autocapitalize';
const HINTED_KEY = 'documents:autocorrect-hinted';

const storage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

/** Whether autocorrect is on (it is, until turned off). */
export function autocorrectEnabled() {
  try { return storage()?.getItem(KEY) !== '0'; } catch { return true; }
}

export function setAutocorrectEnabled(on) {
  try { on ? storage()?.removeItem(KEY) : storage()?.setItem(KEY, '0'); } catch { /* private mode */ }
}

/** Whether capitalizing the first letter of a sentence is on (it is, until turned off). */
export function capitalizeSentencesEnabled() {
  try { return storage()?.getItem(CAP_KEY) !== '0'; } catch { return true; }
}

export function setCapitalizeSentencesEnabled(on) {
  try { on ? storage()?.removeItem(CAP_KEY) : storage()?.setItem(CAP_KEY, '0'); } catch { /* private mode */ }
}

/** Whether the one-time note about autocorrect has been shown; marks it shown. */
export function autocorrectHinted() {
  try {
    if (storage()?.getItem(HINTED_KEY) === '1') return true;
    storage()?.setItem(HINTED_KEY, '1');
  } catch { /* fine */ }
  return false;
}

export const FRACTIONS = { '1/2': '½', '1/4': '¼', '3/4': '¾' };
const SYMBOLS = { c: '©', r: '®', tm: '™' };

/** Whether a quote typed after `last` opens (start of text, after space, an opening bracket, or a dash). */
export function opensQuote(last) {
  return last === '' || /[\s(\[{<‘“—–\-/]/.test(last);
}

/** The typographic quote for a straight one typed after `last`. */
export function smartQuote(typed, last) {
  if (typed === '"') return opensQuote(last) ? '“' : '”';
  if (typed === "'") return opensQuote(last) ? '‘' : '’';
  return typed;
}

/**
 * The correction for `before`, the paragraph's text up to and including
 * the character just typed: `{ back, text }` replaces the last `back`
 * characters with `text`, or null when nothing applies.
 */
/** The run of non-space characters the caret is in, up to and including the typed character. */
const currentWord = (before) => before.slice(before.search(/\S*$/));

/**
 * Whether the word being typed is a web address or an email, where quotes,
 * hyphens, and periods are part of the address and must stay as typed.
 */
export function insideAddress(before) {
  // The bracket or quote an address is typed after is not part of it.
  const word = currentWord(String(before || '')).replace(/^[(\[{<"'“‘«]+/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /^(?:www\.|mailto:)/i.test(word) || /\S@[a-z0-9]/i.test(word);
}

export function correction(before, typed) {
  if (typeof before !== 'string' || !typed || typed.length !== 1 || !before.endsWith(typed)) return null;
  if (insideAddress(before)) return null;
  const prev = before.slice(0, -1);
  const last = prev.slice(-1);
  let out = smartQuote(typed, last);
  let back = 1;
  // "word--next" or "word -- next": the two hyphens become an em dash once the next word starts.
  if (typed !== '-' && !/\s/.test(typed) && /(^|[^-])--$/.test(prev)) { back = 3; out = `—${out}`; }
  else if (typed !== '-' && !/\s/.test(typed) && /\S --\s$/.test(prev)) { back = 5; out = ` — ${out}`; }
  else if (typed === '.' && /(^|[^.])\.\.\.$/.test(before)) return { back: 3, text: '…' };
  else if (typed === ')') {
    const m = /\((c|r|tm)\)$/i.exec(before);
    if (m) return { back: m[0].length, text: SYMBOLS[m[1].toLowerCase()] };
  } else if (typed === ' ') {
    const m = /(^|[\s(“‘])([13]\/[24]) $/.exec(before);
    if (m && FRACTIONS[m[2]]) return { back: 4, text: `${FRACTIONS[m[2]]} ` };
  }
  // The pronoun I, written as a word of its own or in I'm, I'll, I'd or I've, is a capital once the word ends. A
  // period ends it only with the space after it ("i.e." goes on, and "i. " opens a list item at a paragraph's
  // start), and a bracket not at all (the numeral of a list item "(i)").
  if (out === typed && back === 1 && /^[\s,;:!?]$/.test(typed)) {
    const m = /(?:^|[\s"“‘])(i(?:['’](?:m|ll|d|ve))?)$/.exec(prev) || (/\s/.test(typed) ? /[\s"“‘](i\.)$/.exec(prev) : null);
    if (m) return { back: m[1].length + 1, text: `I${m[1].slice(1)}${typed}` };
  }
  return out === typed && back === 1 ? null : { back, text: out };
}

// Abbreviations that end in a period without ending a sentence, so the next
// word is not capitalized after them.
const ABBREVIATIONS = /(?:^|[\s("“‘[])(e\.g|i\.e|etc|vs|cf|mr|mrs|ms|dr|prof|jr|sr|fig|inc|ltd|approx|dept|vol|pp|no|st|ave|blvd|a\.m|p\.m|u\.s|u\.k|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)\.["”’)\]]*\s*$/i;

/** Whether the text before a sentence-ending period is a known abbreviation. */
export function endsWithAbbreviation(prev) {
  // The longest abbreviation, its closing quotes and trailing spaces fit in the tail; scanning
  // a whole paragraph at every space made sentence case quadratic in its length.
  return ABBREVIATIONS.test(String(prev || '').slice(-32));
}

/**
 * Capitalize the first letter of a sentence. `before` is the paragraph text
 * up to and including the typed character. Returns `{ back: 1, text }` when a
 * lowercase letter begins a sentence — at the start of the paragraph, or
 * after sentence-ending punctuation and a space — or null.
 */
export function sentenceCapital(before, typed) {
  // Any lowercase letter with a single uppercase form ("é" too, not "ß", whose capital is two letters).
  if (typeof before !== 'string' || !/^\p{Ll}$/u.test(typed) || typed.toUpperCase().length !== typed.length || !before.endsWith(typed)) return null;
  // An opening quote or bracket may stand between the sentence's start and its first letter.
  const prev = before.slice(0, -1).replace(/["'“‘(\[]+$/, '');
  const atParagraphStart = /^\s*$/.test(prev);
  // An ellipsis ends a sentence too, whether typed as three periods or as the character autocorrect makes of them.
  const afterSentenceEnd = /[.!?…]["'”’)\]]?\s+$/.test(prev) && !endsWithAbbreviation(prev);
  if (!atParagraphStart && !afterSentenceEnd) return null;
  return { back: 1, text: typed.toUpperCase() };
}

/** The selection target covering the last `back` characters before `offset` in a block. */
export function replaceTarget(blockId, offset, back) {
  const story = { kind: 'story', storyType: 'body' };
  return {
    kind: 'selection',
    start: { kind: 'text', blockId, offset: Math.max(0, offset - back), story },
    end: { kind: 'text', blockId, offset, story },
    story,
  };
}

/** Plain text of a paragraph or heading from the Document API. */
export function paragraphText(node) {
  const content = node?.node?.paragraph || node?.node?.heading;
  return (content?.inlines || []).map((i) => i.run?.text || '').join('');
}

/**
 * Apply the correction for a typed character whose end sits at `caret`
 * (`{ blockId, offset }`). Resolves `{ status: 'applied', fix }`,
 * `{ status: 'none' }` when nothing applies, or `{ status: 'mismatch' }`
 * when the text before that point does not end with the typed character
 * (the engine has not taken the keystroke yet, it went elsewhere, or the
 * paragraph holds things the offsets do not count), so the caller can wait
 * and look again.
 */
export async function autocorrectAt(api, replace, caret, typed, { punctuation = true, capitalize = false } = {}) {
  if (!caret?.blockId || !Number.isFinite(caret.offset) || caret.offset < 1) return { status: 'mismatch' };
  let text;
  try { text = paragraphText(await api.getNodeById({ nodeId: caret.blockId })); } catch { return { status: 'none' }; }
  const before = text.slice(0, caret.offset);
  if (!before.endsWith(typed)) return { status: 'mismatch' };
  const fix = (punctuation ? correction(before, typed) : null) || (capitalize ? sentenceCapital(before, typed) : null);
  if (!fix || fix.back > before.length) return { status: 'none' };
  const r = await replace({ target: replaceTarget(caret.blockId, caret.offset, fix.back), replacement: fix.text });
  if (r == null || r.ok === false || r.receipt?.success === false) return { status: 'none' };
  return { status: 'applied', fix };
}
