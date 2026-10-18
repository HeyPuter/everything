/**
 * Flash Fill: learn, from the example cells typed into a column, how each is built from the cells beside it,
 * and fill the rest of the column the same way. A program is a list of parts, each literal text or a piece of
 * a neighbouring cell: the whole cell, its nth word (counted from either end, words split at spaces and
 * punctuation) or its nth run of letters or of digits (ABC and 123 in ABC123, 1 and 234 in $1,234), in its own
 * case, upper, lower or proper case, or just a word's first letter. It is read off the first example greedily,
 * longest piece first, and kept only when it rebuilds every example exactly; of the programs that do, the one
 * that copies the fewest letters and digits from the example as fixed text is taken.
 */

const SPLIT = /[\s,;@._\-/\\|()]+/;
const CASES = ['same', 'upper', 'lower', 'proper'];
const recase = (text, mode) => mode === 'upper' ? text.toUpperCase() : mode === 'lower' ? text.toLowerCase()
  : mode === 'proper' ? text.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : text;

function words(text) {
  return String(text).split(SPLIT).filter(Boolean);
}

// Runs of letters (an apostrophe inside a name, as in O'Brien, belongs to it) and runs of digits.
const RUN = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|\p{N}+/gu;
function runs(text) {
  return String(text).match(RUN) || [];
}

/** Every piece a source row offers, with how to get it again from another row. */
function pieces(sources) {
  const out = [];
  sources.forEach((value, col) => {
    if (value == null || value === '') return;
    const text = String(value);
    const list = words(text);
    const add = (piece, ref) => {
      if (!piece) return;
      for (const mode of CASES) out.push({ text: recase(piece, mode), ref: { ...ref, mode } });
    };
    add(text, { col, kind: 'whole' });
    list.forEach((w, i) => {
      add(w, { col, kind: 'word', index: i });
      add(w, { col, kind: 'word', index: i - list.length }); // the same word counted from the end
      add(w[0], { col, kind: 'initial', index: i });
      add(w[0], { col, kind: 'initial', index: i - list.length });
    });
    const parts = runs(text);
    parts.forEach((w, i) => {
      add(w, { col, kind: 'run', index: i });
      add(w, { col, kind: 'run', index: i - parts.length });
    });
  });
  return out;
}

function resolve(ref, sources) {
  const value = sources[ref.col];
  if (value == null || value === '') return null;
  const text = String(value);
  let piece;
  if (ref.kind === 'whole') piece = text;
  else {
    const list = ref.kind === 'run' ? runs(text) : words(text);
    const word = list[ref.index < 0 ? list.length + ref.index : ref.index];
    if (word == null) return null;
    piece = ref.kind === 'initial' ? word[0] : word;
  }
  return recase(piece, ref.mode);
}

/** Run a program on one row of sources: the text it builds, or null when a piece is missing there. */
export function runProgram(program, sources) {
  let out = '';
  for (const part of program) {
    if (part.literal != null) { out += part.literal; continue; }
    const piece = resolve(part.ref, sources);
    if (piece == null) return null;
    out += piece;
  }
  return out;
}

/** Programs that explain one example, best first: greedy, each step trying its longest pieces. */
function explain(sources, target, preferEnd) {
  const options = pieces(sources).filter((p) => p.text.length);
  const programs = [];
  // A few greedy variants: prefer the longest piece; among equals, words counted from the start or from the end.
  for (const variant of [0, 1, 2]) {
    const program = [];
    let at = 0;
    while (at < target.length) {
      const rest = target.slice(at);
      let best = null;
      for (const p of options) {
        if (!rest.startsWith(p.text)) continue;
        if (!best || p.text.length > best.text.length) { best = p; continue; }
        if (p.text.length < best.text.length) continue;
        // Whole cells before words, the cell's own case first, and a first or last word named as such (index 0 or -1),
        // so "Smith" from "John Smith" is the last word, and "Watson" from "Mary Jane Watson".
        const place = (x) => { const i = x.ref.index; if (i == null) return 0; if (i === 0 || i === -1) return 0; return (i < 0) === (preferEnd || variant === 1) ? 1 : 2; };
        const rank = (x) => (x.ref.kind === 'whole' ? 0 : x.ref.kind === 'run' ? 2 : 1) * 10 + (x.ref.mode === 'same' ? 0 : 1) + place(x) * 2;
        if (rank(p) < rank(best)) best = p;
      }
      // A single character piece is taken only for an initial-like spot; otherwise the character is literal text.
      if (best && (best.text.length > 1 || best.ref.kind === 'initial' || variant === 2)) {
        program.push({ ref: best.ref });
        at += best.text.length;
      } else {
        const last = program[program.length - 1];
        if (last?.literal != null) last.literal += target[at]; else program.push({ literal: target[at] });
        at++;
      }
    }
    programs.push(program);
  }
  return programs;
}

/**
 * Learn from rows of { sources: [...], target } where `target` is an example (a string) or null, and return the
 * filled text for each row whose target is null (null where the pattern does not apply), or null when no single
 * pattern rebuilds every example.
 */
export function flashFill(rows) {
  const examples = rows.filter((row) => row.target != null && row.target !== '');
  if (!examples.length) return null;
  // Letters and digits written into a program as fixed text are copied to every row: of the programs that
  // rebuild the examples, the one with the fewest is the pattern (ABC123 → ABC is the letters, not A and "BC").
  const fixed = (program) => program.reduce((n, part) => n + (part.literal?.match(/[\p{L}\p{N}]/gu)?.length || 0), 0);
  let best = null;
  for (const preferEnd of [false, true]) {
    for (const program of explain(examples[0].sources, String(examples[0].target), preferEnd)) {
      // A program of literal text alone copies the example everywhere; that is not a pattern.
      if (!program.some((part) => part.ref)) continue;
      if (!examples.every((row) => runProgram(program, row.sources) === String(row.target))) continue;
      if (!best || fixed(program) < fixed(best)) best = program;
    }
  }
  return best && rows.map((row) => (row.target != null && row.target !== '' ? undefined : runProgram(best, row.sources)));
}
