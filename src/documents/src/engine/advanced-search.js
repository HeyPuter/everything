import { paragraphText, paragraphFormat, runFormat } from './model.js';
import { effectiveStyleId } from './styles.js';
import { inlineSegments } from './images.js';
import { MAX_DOCUMENT_CHARACTERS } from './text-limits.js';

/**
 * Advanced Find and Replace: special characters, a documented wildcard subset, prefix/suffix and
 * punctuation/whitespace-insensitive matching, and formatting conditions on the found text. Matching runs
 * over the document text (paragraphs joined by "\n"), so a search can cross paragraph marks with ^p.
 * Replacement goes through the model's ordinary replace and formatting commands inside one transaction.
 *
 * Special characters (in Find and in Replace):
 *   ^p paragraph mark · ^t tab · ^l manual line break · ^m manual page break · ^n column break ·
 *   ^s non-breaking space · ^- optional hyphen · ^~ non-breaking hyphen · ^+ em dash · ^= en dash · ^^ caret
 * Find only: ^? any character · ^# any digit · ^$ any letter · ^w white space · ^g picture
 * Replace only: ^& the found text · \1–\9 a wildcard group (with wildcards on)
 *
 * Wildcards (case-sensitive, as desktop word processors treat them):
 *   ? one character · * any run of characters within a paragraph · [abc] one of · [a-z] a range ·
 *   [!abc] none of · {n} {n,} {n,m} repeat the previous item · @ one or more of the previous item ·
 *   < start of a word · > end of a word · ( ) a group for \1–\9 · \ treats the next character literally
 */

const LITERAL_CODES = { p: '\n', t: '\t', l: '\v', m: '\f', n: '\u000e', s: ' ', '-': '­', '~': '‑', '+': '—', '=': '–', '^': '^' };
const PATTERN_CODES = { '?': '[^\\n]', '#': '\\p{Nd}', $: '\\p{L}', w: '[ \\t\\u00a0]+', g: '\\uFFFC' };
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';

/** One token of a Find pattern: a literal string or a regular-expression fragment. */
function tokens(query) {
  const out = [];
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '^' && i + 1 < query.length) {
      const code = query[i + 1];
      if (Object.hasOwn(LITERAL_CODES, code)) { out.push({ literal: LITERAL_CODES[code] }); i++; continue; }
      if (Object.hasOwn(PATTERN_CODES, code)) { out.push({ pattern: PATTERN_CODES[code] }); i++; continue; }
      throw new Error(`^${code} is not a recognized special character.`);
    }
    // Astral characters stay whole.
    const cp = query.codePointAt(i), text = String.fromCodePoint(cp);
    out.push({ literal: text }); i += text.length - 1;
  }
  return out;
}

/** The regular-expression source for a wildcard pattern. */
function wildcardSource(query) {
  let source = '', previous = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '\\') {
      if (i + 1 >= query.length) throw new Error('A backslash must be followed by the character to find.');
      const cp = query.codePointAt(i + 1), next = String.fromCodePoint(cp);
      source += escapeRegExp(next); i += next.length; previous = true; continue;
    }
    if (ch === '^' && i + 1 < query.length) {
      const [token] = tokens(query.slice(i, i + 2));
      source += token.pattern ?? escapeRegExp(token.literal); i++; previous = true; continue;
    }
    if (ch === '?') { source += '[^\\n]'; previous = true; continue; }
    if (ch === '*') { source += '[^\\n]*?'; previous = false; continue; }
    if (ch === '@') { if (!previous) throw new Error('@ must follow a character or group.'); source += '+'; previous = false; continue; }
    if (ch === '<') { source += `(?<!${WORD})(?=${WORD})`; continue; }
    if (ch === '>') { source += `(?<=${WORD})(?!${WORD})`; continue; }
    if (ch === '(' || ch === ')') { source += ch; previous = ch === ')'; continue; }
    if (ch === '[') {
      const end = query.indexOf(']', i + 2);
      if (end < 0) throw new Error('A [ must be closed with ].');
      let body = query.slice(i + 1, end), negate = false;
      if (body.startsWith('!')) { negate = true; body = body.slice(1); }
      if (!body) throw new Error('Put at least one character between [ and ].');
      const parts = [...body].map((c, index, all) => c === '-' && index > 0 && index < all.length - 1 ? '-' : c.replace(/[\\\]^[-]/g, '\\$&'));
      source += `[${negate ? '^\\n' : ''}${parts.join('')}]`; i = end; previous = true; continue;
    }
    if (ch === '{') {
      const end = query.indexOf('}', i);
      const body = end < 0 ? '' : query.slice(i + 1, end);
      if (!previous || !/^\d+(,\d*)?$/.test(body)) throw new Error('Use {n}, {n,} or {n,m} after a character or group.');
      source += `{${body}}`; i = end; previous = false; continue;
    }
    const cp = query.codePointAt(i), text = String.fromCodePoint(cp);
    source += escapeRegExp(text); i += text.length - 1; previous = true;
  }
  return source;
}

/** The regular-expression source for an ordinary (non-wildcard) search. */
function literalSource(query, { ignorePunctuation, ignoreWhitespace }) {
  // White space is what \s matches except the paragraph mark, which the option does not ignore in Word either.
  const filler = [ignorePunctuation && '\\p{P}', ignoreWhitespace && '\\t\\v\\f\\r\\p{Zs}\\u2028\\u2029\\ufeff'].filter(Boolean);
  const gap = filler.length ? `[${filler.join('')}]*` : '';
  const parts = tokens(query).filter(t => t.pattern || !(ignorePunctuation && /^\p{P}$/u.test(t.literal)) && !(ignoreWhitespace && /^\s$/u.test(t.literal)));
  if (!parts.length) throw new Error('Enter text to find. Punctuation and spaces alone are ignored with these options.');
  return parts.map(t => t.pattern ?? escapeRegExp(t.literal)).join(gap);
}

/** A compiled matcher for these options. Throws a readable error for an invalid pattern. */
export function compileQuery(query, options = {}) {
  if (typeof query !== 'string' || query.length > 255) throw new Error('Find text must be up to 255 characters.');
  let source = options.wildcards ? wildcardSource(query) : literalSource(query, options);
  if (options.wholeWord && !options.wildcards) source = `(?<!${WORD})(?:${source})(?!${WORD})`;
  else {
    if (options.matchPrefix && !options.wildcards) source = `(?<!${WORD})(?:${source})`;
    if (options.matchSuffix && !options.wildcards) source = `(?:${source})(?!${WORD})`;
  }
  const flags = `gu${options.matchCase || options.wildcards ? '' : 'i'}`;
  try { return new RegExp(source, flags); } catch { throw new Error('This pattern cannot be searched. Check its brackets and repeat counts.'); }
}

/** Paragraph boundaries in the joined document text. */
function paragraphSpans(paragraphs) {
  const spans = []; let at = 0;
  for (const p of paragraphs) { const length = paragraphText(p).length; spans.push({ p, start: at, end: at + length }); at += length + 1; }
  return spans;
}

/** Whether a run satisfies the run conditions of `format`. */
function runMatches(run, conditions) {
  const f = runFormat(run);
  for (const [key, value] of Object.entries(conditions)) {
    if (key === 'characterStyle') { if ((run.styleId || '') !== value) return false; continue; }
    if (key === 'highlight' && value === 'any') { if (f.highlight === 'none') return false; continue; }
    if (key === 'fontAscii') { if (String(f.fontAscii || '').toLowerCase() !== String(value).toLowerCase()) return false; continue; }
    if (key === 'underline') { if ((f.underlineStyle !== 'none') !== value) return false; continue; }
    if (JSON.stringify(f[key] ?? null) !== JSON.stringify(value)) return false;
  }
  return true;
}

function paragraphMatches(p, conditions, { styles, numbering }) {
  if (!Object.keys(conditions).length) return true;
  const format = paragraphFormat(p, numbering);
  for (const [key, value] of Object.entries(conditions)) {
    if (key === 'paragraphStyle') { if ((effectiveStyleId(p, styles) || '') !== value) return false; continue; }
    if (JSON.stringify(format[key] ?? null) !== JSON.stringify(value)) return false;
  }
  return true;
}

/** Split a format condition into the run and paragraph parts. */
export function splitFormat(format = {}) {
  const run = {}, paragraph = {};
  for (const [key, value] of Object.entries(format)) {
    if (value === undefined) continue;
    if (key === 'paragraphStyle' || ['alignment', 'outlineLevel', 'indentLeft', 'indentRight', 'firstLine', 'spaceBefore', 'spaceAfter', 'lineSpacing', 'lineRule', 'keepNext', 'keepLines', 'pageBreakBefore', 'widowControl'].includes(key)) paragraph[key] = value;
    else run[key] = value;
  }
  return { run, paragraph };
}

/** Whether every character of [start, end) in the paragraph has the run conditions. */
function rangeHasFormat(p, from, to, conditions) {
  if (!Object.keys(conditions).length) return true;
  let at = 0;
  for (const run of p.runs) {
    const a = Math.max(from, at), b = Math.min(to, at + run.text.length);
    if (b > a && !runMatches(run, conditions)) return false;
    at += run.text.length;
  }
  return true;
}

/**
 * Find matches. options: matchCase, wholeWord, wildcards, matchPrefix, matchSuffix, ignorePunctuation,
 * ignoreWhitespace, format (run and paragraph conditions), within ([start, end] to search a selection).
 * context: { styles, numbering } for paragraph styles and list geometry. An empty query with a format
 * finds each stretch of text that has it.
 */
export function advancedFind(paragraphs, query, options = {}, context = {}) {
  const { run: runConditions, paragraph: paragraphConditions } = splitFormat(options.format);
  const formatted = Object.keys(runConditions).length || Object.keys(paragraphConditions).length;
  if (!query && !formatted) return [];
  const spans = paragraphSpans(paragraphs), text = spans.map(s => paragraphText(s.p)).join('\n');
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('This document is too long to search with these options.');
  const [low, high] = options.within || [0, text.length];
  const matches = [], graphemes = new Map();
  // Segment each paragraph once, not once per match, so many matches in a long paragraph stay linear.
  const startsAt = i => {
    if (!graphemes.has(i)) { const s = spans[i]; graphemes.set(i, new Set([...inlineSegments(paragraphText(s.p))].map(x => x.index + s.start).concat(s.end))); }
    return graphemes.get(i);
  };
  const spanAt = position => { let lo = 0, hi = spans.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid].start <= position) lo = mid; else hi = mid - 1; } return lo; };
  const pictureAt = position => {
    const s = spans[spanAt(position)]; let at = s.start;
    for (const run of s.p.runs) { if (position < at + run.text.length) return !!run.image; at += run.text.length; }
    return false;
  };
  const accept = (start, end, groups) => {
    if (start < low || end > high || end <= start) return;
    const first = spanAt(start), last = spanAt(Math.max(start, end - 1));
    for (let i = first; i <= last; i++) {
      const s = spans[i];
      if (!paragraphMatches(s.p, paragraphConditions, context)) return;
      if (!rangeHasFormat(s.p, Math.max(start, s.start) - s.start, Math.min(end, s.end) - s.start, runConditions)) return;
    }
    // A paragraph mark between two cells, or between a cell and the body, is a table boundary: Word
    // never matches across one, and replacing such a match edited the wrong cells.
    const crossed = end === spans[last].end + 1 ? last + 1 : last;
    for (let i = first; i < crossed; i++) if ((spans[i].p.cellId || null) !== (spans[i + 1]?.p.cellId || null)) return;
    // ^p is a paragraph mark, not a section break (Word's ^b): replacing one ended the section and lost its page setup.
    for (let i = first; i < crossed; i++) if (spans[i].p.sectionEnd) return;
    // An object character is a picture only when it is one: ^g, ^? and wildcards never take a field,
    // equation or note reference, which Replace All then deleted.
    for (let at = text.indexOf('\uFFFC', start); at >= 0 && at < end; at = text.indexOf('\uFFFC', at + 1)) if (!pictureAt(at)) return;
    // Never match half a grapheme or half a picture.
    const s = spans[first], e = spans[last];
    if (!startsAt(first).has(start)) return;
    if (!startsAt(last).has(end) && end !== e.end + 1) return;
    matches.push({ start, end, paragraph: first, offset: start - s.start, text: text.slice(start, end), ...(groups ? { groups } : {}) });
  };
  if (query) {
    const pattern = compileQuery(query, options);
    for (const m of text.matchAll(pattern)) {
      if (!m[0].length) continue;
      accept(m.index, m.index + m[0].length, m.length > 1 ? m.slice(1) : null);
      if (matches.length > 10000) throw new Error('More than 10,000 matches. Narrow the search.');
    }
  } else {
    // Format-only search: maximal stretches of text, per paragraph, that carry the formatting.
    for (const s of spans) {
      if (!paragraphMatches(s.p, paragraphConditions, context)) continue;
      let at = s.start, open = null;
      for (const run of s.p.runs) {
        const ok = run.text.length && runMatches(run, runConditions);
        if (ok && open === null) open = at;
        if (!ok && open !== null && run.text.length) { accept(open, at); open = null; }
        at += run.text.length;
      }
      if (open !== null) accept(open, at);
      if (!s.p.runs.length && !Object.keys(runConditions).length && s.end === s.start) continue;
    }
  }
  return matches;
}

/** Expand a replacement template for one match. */
export function expandReplacement(template, match, { wildcards = false } = {}) {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '^' && i + 1 < template.length) {
      const code = template[i + 1];
      if (code === '&') { out += match.text; i++; continue; }
      if (Object.hasOwn(LITERAL_CODES, code)) { out += LITERAL_CODES[code]; i++; continue; }
      throw new Error(`^${code} cannot be used in replacement text.`);
    }
    if (wildcards && ch === '\\' && /[1-9]/.test(template[i + 1] || '')) { out += match.groups?.[Number(template[i + 1]) - 1] ?? ''; i++; continue; }
    if (wildcards && ch === '\\' && i + 1 < template.length) { out += template[i + 1]; i++; continue; }
    out += ch;
  }
  if (/[\u0000-\u0008\u000b-\u000d\u000f-\u001f]/.test(out.replace(/[\v\f]/g, ''))) throw new Error('The replacement contains characters a document cannot hold.');
  return out;
}

/**
 * Replace matches (from advancedFind on the same model) in one transaction. `template` follows
 * expandReplacement; an empty template with formatting only changes the found text's formatting.
 * format: run properties and/or { paragraphStyle } / paragraph properties to apply to the result.
 * Returns the number of replacements.
 */
export function replaceAdvanced(model, matches, template, { wildcards = false, format = null } = {}) {
  if (!matches.length) return 0;
  const { run: runPatch, paragraph: paragraphPatch } = splitFormat(format || {});
  const { paragraphStyle, ...paragraphFormatPatch } = paragraphPatch;
  const formatOnly = !template && (Object.keys(runPatch).length || Object.keys(paragraphPatch).length);
  const texts = matches.map(m => formatOnly ? m.text : expandReplacement(template, m, { wildcards }));
  if (model.text.length + matches.reduce((n, m, i) => n + texts[i].length - (m.end - m.start), 0) > MAX_DOCUMENT_CHARACTERS) throw new Error('The replacement would make the document too long.');
  model.checkpoint();
  const checkpoint = model.checkpoint;
  model.checkpoint = () => {};
  // Matches already fall on grapheme boundaries. Selecting through the model
  // re-segmented the whole edited document per match, making Replace All quadratic.
  const select = (anchor, focus) => {
    if (model.hasMacroButtons || model.hasNoteMarks) return model.select(anchor, focus);
    model.cellBlock = null; model.selection = { anchor, focus };
    model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
  };
  const selection = { ...model.selection };
  // Without formatting to apply, a match within one paragraph is replaced in a view of just that paragraph.
  const starts = !Object.keys(runPatch).length && !Object.keys(paragraphPatch).length && model.paragraphsEditAlone ? model.paragraphStarts() : null;
  let first = null, count = 0;
  try {
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i], text = texts[i];
      let start = m.start, end = m.end;
      if (!formatOnly && text !== m.text) {
        // Text put back after the author deleted it is found as a move anywhere in the document.
        const alone = starts && !m.text.includes('\n') && !(text && model.trackChanges && model.lastTrackedDeletion);
        if (!alone) select(m.start, m.end);
        // A replacement the document refuses changes nothing, and its formatting is not applied.
        if (!(alone ? model.replaceWithinParagraph(m.paragraph, starts[m.paragraph], m.start, m.end, text) : model.replace(text, { checkpoint: false }))) continue;
        end = model.selection.focus; start = end - text.length;
      }
      if (end > start) {
        select(start, end);
        if (Object.keys(runPatch).length) {
          const { characterStyle, ...direct } = runPatch;
          if (characterStyle !== undefined) model.setCharacterStyle(characterStyle);
          if (Object.keys(direct).length) model.setRunFormat(direct);
        }
        if (paragraphStyle !== undefined) model.setParagraphStyle(paragraphStyle);
        if (Object.keys(paragraphFormatPatch).length) model.setParagraphFormat(paragraphFormatPatch);
      }
      first = [start, end]; count++;
    }
  } finally { model.checkpoint = checkpoint; }
  // Nothing changed (every match already deleted, say): no replacement and no undo step.
  if (!count) { model.history.pop(); model.selection = selection; return 0; }
  model.select(first[1]);
  model.didChange();
  return matches.length;
}

/** A readable summary of format conditions, for the Find panel. */
export function describeFormat(format = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(format)) {
    if (value === undefined) continue;
    if (key === 'bold') parts.push(value ? 'Bold' : 'Not bold');
    else if (key === 'italic') parts.push(value ? 'Italic' : 'Not italic');
    else if (key === 'underline') parts.push(value ? 'Underline' : 'No underline');
    else if (key === 'strikethrough') parts.push(value === 'none' ? 'No strikethrough' : 'Strikethrough');
    else if (key === 'fontAscii') parts.push(`Font: ${value}`);
    else if (key === 'fontSize') parts.push(`${value} pt`);
    else if (key === 'color') parts.push(value === 'auto' ? 'Automatic color' : `Color #${value}`);
    else if (key === 'highlight') parts.push(value === 'any' ? 'Highlight' : value === 'none' ? 'No highlight' : `Highlight: ${value}`);
    else if (key === 'paragraphStyle') parts.push(`Style: ${value || 'Default paragraph'}`);
    else if (key === 'characterStyle') parts.push(`Character style: ${value || 'Default characters'}`);
    else if (key === 'alignment') parts.push(`Aligned ${value === 'both' ? 'justified' : value}`);
    else if (key === 'capitalization') parts.push(value === 'caps' ? 'All caps' : value === 'smallCaps' ? 'Small caps' : 'No caps');
    else if (key === 'verticalAlign') parts.push(value === 'baseline' ? 'Not raised or lowered' : value === 'superscript' ? 'Superscript' : 'Subscript');
    else parts.push(`${key}: ${value}`);
  }
  return parts.join(', ');
}
