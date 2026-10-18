/**
 * Formula text as Excel stores it in .xlsx files. Functions added since
 * Excel 2007 are written with an _xlfn. prefix (SORT and FILTER with
 * _xlfn._xlws.), LAMBDA parameters with _xlpm., and a spill reference A1#
 * as ANCHORARRAY(A1). Files from Excel carry those prefixes, so they are
 * stripped on the way in and added on the way out; without them Excel
 * shows #NAME? for every XLOOKUP, IFS, or CONCAT we save.
 */

import { tokenize } from './formula/tokenizer.js';
import { freeNameTokens, tableReferenceTokens } from './formula/names.js';
import { FUNCTIONS } from './formula/functions.js';
import { spillRefsToFile, spillRefsFromFile } from './refs.js';

const XLWS = new Set(['SORT', 'FILTER']);
/** The functions that bind names; Excel writes every name they bind with an _xlpm. prefix. */
const BINDERS = new Set(['LET', 'LAMBDA', 'ISOMITTED']);
/** What a bare [name] must hold to declare an optional LAMBDA parameter, as names.js reads it. */
const PARAMETER = /^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*$/u;

export const XLFN = new Set(`
ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR
BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT
CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ENCODEURL ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST
F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTER FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV
GAMMALN.PRECISE GAUSS HSTACK HYPGEOM.DIST IFNA IFS IMAGE ISFORMULA ISO.CEILING ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP
MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC
PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ REDUCE RRI SCAN SEC
SECH SEQUENCE SHEET SHEETS SKEW.P SORT SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE
TEXTJOIN TEXTSPLIT TOCOL TOROW UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WORKDAY.INTL WRAPCOLS WRAPROWS XLOOKUP
XMATCH XOR Z.TEST GROUPBY PIVOTBY PERCENTOF TRIMRANGE REGEXTEST REGEXEXTRACT REGEXREPLACE IMCOSH IMSINH IMSEC IMCSC IMCOT IMSECH IMCSCH IMTAN TRANSLATE DETECTLANGUAGE
STOCKHISTORY FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT DBCS SINGLE
`.trim().split(/\s+/));

/** The index of the parenthesis closing the one at `open`, or -1. */
function matchingParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].type === 'lparen') depth++;
    else if (tokens[i].type === 'rparen' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Excel spells the implicit-intersection operator SINGLE() inside files:
 * @A1:A3 → SINGLE(A1:A3), @INDEX(…) → SINGLE(INDEX(…)), @(expr) → SINGLE(expr).
 * A bare @ in a saved formula reads as damage to Excel.
 */
function singleCallsToFile(formula) {
  if (!formula.includes('@')) return formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  let out = '', last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], operand = tokens[i + 1];
    if (t.type !== 'op' || t.value !== '@' || !operand) continue;
    let end = i + 1, inner;
    if (operand.type === 'lparen' || (operand.type === 'name' && tokens[i + 2]?.type === 'lparen')) {
      end = matchingParen(tokens, operand.type === 'lparen' ? i + 1 : i + 2);
      if (end < 0) continue;
      inner = operand.type === 'lparen' ? formula.slice(operand.end, tokens[end].start) : formula.slice(operand.start, tokens[end].end);
    } else if (['ref', 'name', 'number', 'string', 'tref'].includes(operand.type)) {
      inner = formula.slice(operand.start, operand.end);
    } else continue;
    out += `${formula.slice(last, t.start)}SINGLE(${singleCallsToFile(inner)})`;
    last = tokens[end].end;
    i = end;
  }
  return out + formula.slice(last);
}

const TRIM_FUNCTIONS = { _TRO_LEADING: 1, _TRO_TRAILING: 2, _TRO_ALL: 3 };

/** A trim reference's text with its periods taken off (or, given `trim`, put on) the colon that joins its ends. */
const trimColon = (text, trim = 0) => text.replace(/\.?:\.?(?=[^:]*$)/, `${trim & 1 ? '.' : ''}:${trim & 2 ? '.' : ''}`);

/**
 * A trim reference (A1:.B9) is written as the TRIMRANGE call it stands for, which every Excel
 * that reads trim references knows; Excel's own _xlfn._TRO_ALL, _TRO_LEADING and _TRO_TRAILING
 * calls on one reference read back as the reference.
 */
function trimRefsToFile(formula) {
  if (!formula.includes('.')) return formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  let out = '', last = 0;
  for (const t of tokens) {
    if (t.type !== 'ref' || !t.trim) continue;
    out += `${formula.slice(last, t.start)}_xlfn.TRIMRANGE(${trimColon(formula.slice(t.start, t.end))},${t.trim},${t.trim})`;
    last = t.end;
  }
  return out + formula.slice(last);
}

function trimRefsFromFile(formula) {
  if (!/_TRO_/i.test(formula)) return formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { return formula; }
  let out = '', last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const [t, open, ref, close] = tokens.slice(i, i + 4);
    const trim = t.type === 'name' && !t.sheet ? TRIM_FUNCTIONS[t.value.replace(/^(?:_XLFN\.)+/, '')] : 0;
    if (!trim || open?.type !== 'lparen' || ref?.type !== 'ref' || ref.spill || ref.trim || !ref.text.includes(':') || close?.type !== 'rparen') continue;
    out += `${formula.slice(last, t.start)}${trimColon(formula.slice(ref.start, ref.end), trim)}`;
    last = close.end;
    i += 3;
  }
  return out + formula.slice(last);
}

/** Our formula text → what goes into the file. */
export function toFileFormula(ours) {
  const formula = singleCallsToFile(ours);
  let out = formula;
  let tokens;
  try { tokens = tokenize(formula); } catch { tokens = null; }
  if (tokens) {
    let free;
    // A built-in called beside a LET name of its spelling that plainly holds a value is the built-in, as the evaluator reads it.
    const freeStarts = () => (free ??= new Set(freeNameTokens(formula, tokens, { includeCalls: true, builtin: (name) => !!FUNCTIONS[name] }).map((t) => t.start)));
    // A name LET or LAMBDA binds is a parameter, written _xlpm.name, and a bare
    // [name] in a LAMBDA's parameter list an optional one, written [_xlpm.name].
    // The analysis yields nothing for a formula the parser refuses, while one it
    // accepts always has its outermost binding call free, so an empty result
    // means no name is known to be a parameter and none is marked.
    const parameters = tokens.some((t) => t.type === 'name' && !t.sheet && BINDERS.has(t.value)) && freeStarts().size > 0;
    let declared;
    const optional = (t) => t.type === 'tref' && t.table === null && PARAMETER.test(t.spec.trim())
      && !(declared ??= new Set(tableReferenceTokens(formula, tokens).map((t) => t.start))).has(t.start);
    let text = '';
    let last = 0;
    tokens.forEach((t, i) => {
      if (parameters && optional(t)) {
        text += `${formula.slice(last, t.start)}[_xlpm.${t.spec.trim()}]`;
        last = t.end;
        return;
      }
      // The UI's @ shorthand inside a table is stored using the public
      // SpreadsheetML #This Row spelling. A literal @ in the column name
      // is escaped with an apostrophe and must stay a column character.
      if (t.type === 'tref' && t.spec.trimStart().startsWith('@')) {
        const column = t.spec.trim().slice(1).trim();
        const spec = column ? `[[#This Row],${column.startsWith('[') ? column : `[${column}]`}]` : '[#This Row]';
        text += `${formula.slice(last, t.start)}${t.table || ''}${spec}`;
        last = t.end;
        return;
      }
      if (t.type !== 'name' || t.sheet) return;
      let prefix;
      if (parameters && !freeStarts().has(t.start)) prefix = '_xlpm.';
      else if (tokens[i + 1]?.type === 'lparen' && XLFN.has(t.value) && freeStarts().has(t.start)) prefix = `_xlfn.${XLWS.has(t.value) ? '_xlws.' : ''}`;
      else return;
      text += `${formula.slice(last, t.start)}${prefix}`;
      last = t.start;
    });
    out = text + formula.slice(last);
  }
  return spillRefsToFile(trimRefsToFile(out));
}

// Characters that keep a column name in its own brackets after @ (Excel's structured-reference rules).
const BRACKETED_COLUMN = /[\s,:.[\]#'"{}$^&*+=\-<>/]/;

/**
 * A file spells the current row as [#This Row], as in T[[#This Row],[Qty]]; Excel shows and
 * edits it as the @ shorthand, T[@Qty], and so does the app. A column whose name holds a
 * character that needs escaping keeps its brackets (T[@[Unit price]]), as does a span of
 * columns (T[@[A]:[C]]); the whole row alone is T[@]. Other selectors are left as written.
 */
function thisRowFromFile(source) {
  if (!/#this\s+row/i.test(source)) return source;
  let tokens;
  try { tokens = tokenize(source); } catch { return source; }
  let out = '', last = 0;
  for (const t of tokens) {
    if (t.type !== 'tref') continue;
    const m = /^\s*(?:\[\s*#this\s+row\s*\]\s*(?:,\s*([\s\S]*?))?|#this\s+row)\s*$/i.exec(t.spec);
    if (!m) continue;
    const rest = m[1] ?? '';
    const single = /^\[([^\[\]]*(?:'.[^\[\]]*)*)\]$/.exec(rest);
    const column = !rest ? '' : single && single[1] && !BRACKETED_COLUMN.test(single[1]) ? single[1] : rest;
    out += `${source.slice(last, t.start)}${t.table || ''}[@${column}]`;
    last = t.end;
  }
  return out + source.slice(last);
}

/** Formula text from a file → ours, with optional uppercase workbook names. */
export function fromFileFormula(formula, definedNames) {
  const source = thisRowFromFile(String(formula));
  if (!/_xl(?:fn|ws|pm)\./i.test(source)) return spillRefsFromFile(source, definedNames);
  let tokens;
  try { tokens = tokenize(source); } catch { return source; }
  let out = '', last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // An optional LAMBDA parameter is declared as [_xlpm.name].
    if (t.type === 'tref' && t.table === null && /^\s*(?:_xlpm\.)+/i.test(t.spec)) {
      out += `${source.slice(last, t.start)}[${t.spec.trim().replace(/^(?:_xlpm\.)+/i, '')}]`;
      last = t.end;
      continue;
    }
    if (t.type !== 'name' || t.sheet) continue;
    const name = source.slice(t.start, t.end);
    // This reserved call always represents a spill, even when a local
    // function is also named ANCHORARRAY. Decode it before losing the marker.
    if (/^_xlfn\.ANCHORARRAY$/i.test(name)) continue;
    // Excel writes the @ operator as _xlfn.SINGLE(); a call on one reference
    // or name reads back as the operator. The name may be a
    // LET or LAMBDA parameter, which carries its own _xlpm. prefix.
    const [open, arg, close] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if (/^_xlfn\.SINGLE$/i.test(name) && open?.type === 'lparen' && (arg?.type === 'ref' || arg?.type === 'name') && close?.type === 'rparen') {
      out += `${source.slice(last, t.start)}@${source.slice(arg.start, arg.end).replace(/^(?:_xl(?:fn|ws|pm)\.)+/i, '')}`;
      last = close.end;
      i += 3;
      continue;
    }
    const plain = name.replace(/^(?:_xl(?:fn|ws|pm)\.)+/i, '');
    if (plain === name) continue;
    out += source.slice(last, t.start) + plain;
    last = t.end;
  }
  return trimRefsFromFile(spillRefsFromFile(out + source.slice(last), definedNames));
}
