/**
 * Specific help for an error in a cell. The generic text for each code lives
 * in format.js; when the formula shows what went wrong, the message names
 * it: the misspelled function or unknown name behind a #NAME? (with the
 * closest real one), or the missing sheet behind a #REF!.
 */

import { tokenize, upperName } from './formula/tokenizer.js';
import { FUNCTIONS, FUNCTION_NAMES } from './formula/functions.js';
import { errorHelp } from './format.js';

/** Names people bring from other tools, and what they are called here. */
const ALIASES = {
  AVG: 'AVERAGE', MEAN: 'AVERAGE', TOTAL: 'SUM', STDDEV: 'STDEV', LENGTH: 'LEN', STRLEN: 'LEN', SUBSTR: 'MID', SUBSTRING: 'MID',
  TRUNCATE: 'TRUNC', DATEDIFF: 'DATEDIF', STRCAT: 'CONCAT', IFELSE: 'IF', ISNULL: 'ISBLANK', ISEMPTY: 'ISBLANK', CEIL: 'CEILING',
  SQR: 'SQRT', RANDOM: 'RAND', RANDINT: 'RANDBETWEEN', STR: 'TEXT', TOSTRING: 'TEXT', TONUMBER: 'VALUE', PARSEINT: 'INT', INTEGER: 'INT',
  MODULO: 'MOD', REMAINDER: 'MOD', MAXIMUM: 'MAX', MINIMUM: 'MIN', DISTINCT: 'UNIQUE', CONTAINS: 'REGEXMATCH', STDEVS: 'STDEV.S',
  STDEVP: 'STDEV.P', VARS: 'VAR.S', LOOKUPV: 'VLOOKUP', LOOKUPH: 'HLOOKUP', COUNTDISTINCT: 'COUNTUNIQUE', NOWDATE: 'TODAY', CURRENTDATE: 'TODAY',
};

/** Levenshtein distance, case-insensitive. */
export function editDistance(a, b) {
  a = String(a).toUpperCase();
  b = String(b).toUpperCase();
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The candidate closest to `name`: an alias, a name that differs by a typo
 * or two (one for short names), or a candidate the name is a prefix of.
 * Null when nothing is close.
 */
export function closestName(name, candidates, maxDistance = null) {
  const upper = String(name).toUpperCase();
  if (ALIASES[upper] && candidates.some((c) => c.toUpperCase() === ALIASES[upper])) return candidates.find((c) => c.toUpperCase() === ALIASES[upper]);
  const limit = maxDistance ?? (upper.length <= 4 ? 1 : 2);
  let best = null;
  let bestScore = Infinity;
  for (const cand of candidates) {
    const u = cand.toUpperCase();
    if (u === upper) return cand;
    const d = editDistance(upper, u);
    // A typo or two, or a truncated name (SUMPROD → SUMPRODUCT); shorter distance wins, then the shorter name.
    const score = d <= limit ? d : (u.startsWith(upper) && upper.length >= 3 && u.length - upper.length <= 4) ? 2.5 : Infinity;
    if (score < bestScore || (score === bestScore && best && cand.length < best.length)) { best = cand; bestScore = score; }
  }
  return best;
}

/** Names bound by LET or LAMBDA in the formula: they are not unknown. */
function boundNames(tokens) {
  const bound = new Set();
  tokens.forEach((t, i) => {
    if (t.type !== 'name' || (t.value !== 'LET' && t.value !== 'LAMBDA') || tokens[i + 1]?.type !== 'lparen') return;
    // The call's top-level arguments, each as its tokens.
    const args = [[]];
    let depth = 0;
    for (let j = i + 2; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.type === 'lparen' || u.type === 'lbrace') depth++;
      else if (u.type === 'rparen' || u.type === 'rbrace') { if (depth === 0) break; depth--; }
      else if (u.type === 'comma' && depth === 0) { args.push([]); continue; }
      args[args.length - 1].push(u);
    }
    args.forEach((arg, k) => {
      if (k === args.length - 1) return; // the body
      if (t.value === 'LET' && k % 2 === 1) return; // a value, not a name
      if (arg.length !== 1) return;
      if (arg[0].type === 'name') bound.add(arg[0].value);
      // An optional parameter, LAMBDA(a,[b],...), tokenizes as a bare bracketed name.
      else if (arg[0].type === 'tref' && arg[0].table === null && /^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*$/u.test(arg[0].spec.trim())) bound.add(upperName(arg[0].spec.trim()));
    });
  });
  return bound;
}

/**
 * explainError(code, formula, lookup) → the help text for the error.
 * lookup = { names: string[] (defined names), hidden: string[] (hidden ones: known, never suggested), tables: string[],
 * hasSheet(name) }
 */
export function explainError(code, formula, lookup = {}) {
  const base = errorHelp(code);
  if (formula == null || (code !== '#NAME?' && code !== '#REF!' && code !== '#CALC!')) return base;
  let tokens;
  try { tokens = tokenize(formula); } catch { return base; }
  if (code === '#CALC!') {
    // A function named without its parentheses is a function value, which a cell cannot show.
    const bare = tokens.find((t, i) => t.type === 'name' && FUNCTIONS[t.value] && tokens[i + 1]?.type !== 'lparen');
    return bare ? `#CALC!: ${formula.slice(bare.start, bare.end)} is a function: call it with parentheses, as in ${bare.value}(…).` : base;
  }
  if (code === '#REF!') {
    for (const t of tokens) {
      if (t.type !== 'ref') continue;
      // #REF!A1 is how a reference to a deleted sheet is written: no sheet of that name ever existed.
      if (t.sheet === '#REF!') return `#REF!: ${formula.slice(t.start, t.end)} refers to a sheet that was deleted.`;
      for (const sheet of [t.sheet, t.sheetEnd]) {
        if (sheet && lookup.hasSheet && !lookup.hasSheet(sheet)) return `#REF!: There is no sheet named "${sheet}". It may have been renamed or deleted.`;
      }
    }
    return base;
  }
  const names = lookup.names || [];
  const tables = lookup.tables || [];
  const hidden = lookup.hidden || [];
  const known = (n) => !!FUNCTIONS[n] || n === 'LET' || n === 'LAMBDA' || names.some((x) => upperName(x) === n) || hidden.some((x) => upperName(x) === n)
    || tables.some((x) => upperName(x) === n);
  const bound = boundNames(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'name' || known(t.value) || bound.has(t.value)) continue;
    const called = tokens[i + 1]?.type === 'lparen';
    const original = formula.slice(t.start, t.end);
    if (called) {
      const guess = closestName(t.value, FUNCTION_NAMES);
      return `#NAME?: There is no function called ${original}${guess ? `. Did you mean ${guess}?` : '.'}`;
    }
    const guess = closestName(t.value, [...names, ...tables]);
    if (guess) return `#NAME?: ${original} is not a named range, table, or function. Did you mean ${guess}?`;
    // A function written without its parentheses: only a near-exact match is worth suggesting,
    // and one letter is within a letter of N() or T() without meaning either.
    const fn = t.value.length >= 3 ? closestName(t.value, FUNCTION_NAMES, 1) : null;
    if (fn) return `#NAME?: ${original} is not a named range. Did you mean the function ${fn}()?`;
    return `#NAME?: ${original} is not a named range, table, or function. Text needs quotes: "…".`;
  }
  return base;
}
