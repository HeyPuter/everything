/**
 * The thesaurus's pure parts: the question Puter's AI is asked about a word, reading its answer into senses
 * (a part of speech, a short meaning, synonyms and antonyms), and putting a chosen word into a cell's text.
 */

/** The question for one word, asking for a JSON answer the pane can lay out. */
export function thesaurusPrompt(word) {
  return [
    'You are a thesaurus. For the word or phrase between the markers, list its common senses.',
    'Reply with JSON only, no prose and no code fences, in exactly this shape:',
    '{"senses":[{"pos":"noun|verb|adjective|adverb|other","meaning":"a few words","synonyms":["..."],"antonyms":["..."]}]}',
    'Give at most 6 senses, at most 10 synonyms and 4 antonyms each, most common first, in the language of the word. Use an empty list when there are none.',
    `<<<\n${String(word).slice(0, 200)}\n>>>`,
  ].join('\n');
}

const clean = (list, max) => (Array.isArray(list) ? [...new Set(list.filter((w) => typeof w === 'string').map((w) => w.trim()).filter((w) => w && w.length <= 60))].slice(0, max) : []);

/** The senses in an answer (JSON, perhaps wrapped in prose or a code fence); [] when it holds none. */
export function parseThesaurus(reply) {
  const text = String(reply ?? '');
  const startAt = text.indexOf('{');
  const endAt = text.lastIndexOf('}');
  if (startAt < 0 || endAt <= startAt) return [];
  let data;
  try { data = JSON.parse(text.slice(startAt, endAt + 1)); } catch { return []; }
  const senses = Array.isArray(data?.senses) ? data.senses : Array.isArray(data) ? data : [];
  return senses.slice(0, 8).map((s) => ({
    pos: typeof s?.pos === 'string' ? s.pos.trim().toLowerCase().slice(0, 20) : '',
    meaning: typeof s?.meaning === 'string' ? s.meaning.trim().slice(0, 120) : '',
    synonyms: clean(s?.synonyms, 12),
    antonyms: clean(s?.antonyms, 6),
  })).filter((s) => s.synonyms.length || s.antonyms.length);
}

/** `word` cased as `like` was: "Happy" → "Glad", "HAPPY" → "GLAD". */
export function matchCase(like, word) {
  const l = String(like), w = String(word);
  if (l.length > 1 && l === l.toUpperCase() && l !== l.toLowerCase()) return w.toUpperCase();
  if (l[0] && l[0] !== l[0].toLowerCase() && w === w.toLowerCase()) return w.charAt(0).toUpperCase() + w.slice(1);
  return w;
}

/**
 * A cell's text with `word` replaced by `replacement`: the whole text when it is the word, otherwise the word's
 * first appearance as a whole word (in any case), cased as it was. Null when the text does not hold the word.
 */
export function replaceInText(text, word, replacement) {
  const t = String(text ?? ''), w = String(word).trim();
  if (!w) return null;
  if (t.trim().toLowerCase() === w.toLowerCase()) return t.replace(t.trim(), matchCase(t.trim(), replacement));
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(t);
  if (!m) return null;
  const at = m.index + m[1].length;
  return t.slice(0, at) + matchCase(m[2], replacement) + t.slice(at + m[2].length);
}

/** The word a cell's text offers for looking up: the text itself when it is short, else its first word. */
export function lookupWord(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (t.length <= 40 && t.split(/\s+/).length <= 3) return t;
  return (/[\p{L}][\p{L}'’-]*/u.exec(t) || [''])[0];
}
