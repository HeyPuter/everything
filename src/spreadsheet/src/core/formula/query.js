/**
 * QUERY(data, query, [headers]) — the Google Sheets query language over a
 * range, enough of it for everyday use:
 *
 *   select A, B, sum(C)          columns by sheet letter (or Col1, Col2 for arrays), * for all,
 *                                aggregates sum / avg / count / max / min, scalars year / month /
 *                                day / hour / minute / upper / lower / len
 *   where A > 3 and (B = 'x' or B is null)
 *                                =, <>, !=, <, <=, >, >=, is null, is not null, contains,
 *                                starts with, ends with, matches (regex), like (% and _), not
 *   group by A, year(C)          columns or scalars of them, with aggregates in the select
 *   order by C desc, A           asc by default
 *   limit 10 offset 5
 *   label sum(C) 'Total', A 'Name'
 *
 * Values: numbers, 'strings' or "strings", true/false, date '2026-08-28'.
 * Rows that fail the where clause are dropped; the header row (guessed when
 * `headers` is left out) becomes the header of the result, with aggregate
 * columns labelled "sum Amount" unless a label says otherwise.
 */

import { mean, sum } from '../numeric.js';
import { nestedRepeat, subjectLimit } from './regex-safety.js';
import { colName } from '../cell.js';
import { ymdToSerial, serialToYMD } from '../format.js';

class QueryError extends Error {}

const KEYWORDS = new Set(['select', 'where', 'group', 'by', 'order', 'asc', 'desc', 'limit', 'offset', 'label', 'and', 'or', 'not', 'is', 'null', 'contains', 'starts', 'ends', 'with', 'matches', 'like', 'true', 'false', 'date', 'format', 'options',
  'pivot', 'datetime', 'timeofday', 'timestamp']); // the last four are the language's, and reported as unsupported rather than as syntax errors
const UNSUPPORTED_LITERALS = new Set(['datetime', 'timeofday', 'timestamp']);

/** A token as the user wrote it, for an error message. */
const tokenText = (t) => (t.type === 'string' ? `'${t.value}'` : t.type === 'ident' && t.quoted ? `\`${t.value}\`` : String(t.value));
const AGGREGATES = new Set(['sum', 'avg', 'count', 'max', 'min']);
const SCALARS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'upper', 'lower', 'len', 'dayofweek']);

function tokenizeQuery(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== ch) text += src[j++];
      if (j >= src.length) throw new QueryError('Unterminated string');
      out.push({ type: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new QueryError('Unterminated identifier');
      out.push({ type: 'ident', value: src.slice(i + 1, j), quoted: true }); // a header name, whatever its letters spell
      i = j + 1;
      continue;
    }
    // A minus directly before digits is a sign when nothing precedes it that a number could follow.
    const prev = out[out.length - 1];
    const signed = ch === '-' && (!prev || prev.type === 'op' || prev.type === 'kw') && /^-(?:\d|\.\d)/.test(src.slice(i));
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && (signed || ch !== '-')) { out.push({ type: 'number', value: parseFloat(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (word) {
      const lower = word[0].toLowerCase();
      out.push(KEYWORDS.has(lower) ? { type: 'kw', value: lower } : { type: 'ident', value: word[0] });
      i += word[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') { out.push({ type: 'op', value: two === '!=' ? '<>' : two }); i += 2; continue; }
    if ('=<>(),*'.includes(ch)) { out.push({ type: 'op', value: ch }); i++; continue; }
    throw new QueryError(`Unexpected character "${ch}"`);
  }
  return out;
}

/**
 * Compiled `matches` and `like` patterns with the longest text each may be run on, kept across the
 * rows of one query and the next.
 */
const PATTERN_CACHE = new Map();
function patternRegex(source, userPattern = null, flags = '') {
  const key = flags ? `(?${flags})${source}` : source;
  let entry = PATTERN_CACHE.get(key);
  if (!entry) {
    if (userPattern != null && nestedRepeat(userPattern)) throw new QueryError('Bad regular expression');
    // The user's pattern must compile on its own: zzz)|(a would otherwise close the anchoring group
    // around it and match a part of the cell.
    let re;
    try { if (userPattern != null) new RegExp(userPattern, flags); re = new RegExp(source, flags); } catch { throw new QueryError('Bad regular expression'); }
    // Two overlapping repeats, (\w+)\s*(\w+)=, divide a long run of text in every way: seconds on a
    // cell of a few thousand characters, once per row, with no way to interrupt it. Past the
    // pattern's limit the text is refused as the pattern itself would be, as REGEXMATCH and Find do.
    entry = { re, limit: userPattern == null ? Infinity : subjectLimit(userPattern) };
    if (PATTERN_CACHE.size >= 256) PATTERN_CACHE.clear();
    PATTERN_CACHE.set(key, entry);
  }
  return entry;
}

/**
 * Does the text match a `like` pattern, in which % stands for any run of
 * characters (a line break among them) and _ for exactly one, case-sensitively?
 * Each % takes as little as it can and gives up one more character whenever
 * the rest of the pattern fails after it, so the work is bounded by the text's
 * length times the pattern's, where the regular expression this used to compile
 * to backtracked through every split of every % and took seconds for
 * %a%a%a%b over a few hundred characters.
 */
function likeMatch(text, pattern) {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < text.length) {
    if (j < pattern.length && (pattern[j] === '_' || pattern[j] === text[i])) { i++; j++; continue; }
    if (j < pattern.length && pattern[j] === '%') { star = j++; mark = i; continue; }
    if (star < 0) return false;
    j = star + 1;
    i = ++mark;
  }
  while (j < pattern.length && pattern[j] === '%') j++;
  return j === pattern.length;
}

/** A `matches` pattern split from RE2's leading inline flags, (?i), (?s), (?m) and combinations, which REGEXMATCH reads too. */
function inlineFlags(pattern) {
  let flags = '';
  for (let m = /^\(\?([ims]+)\)/.exec(pattern); m; m = /^\(\?([ims]+)\)/.exec(pattern)) {
    for (const f of m[1]) if (!flags.includes(f)) flags += f;
    pattern = pattern.slice(m[0].length);
  }
  return { pattern, flags };
}

/** Parse the query text into { select, where, groupBy, orderBy, limit, offset, labels }. */
export function parseQuery(src) {
  const tokens = tokenizeQuery(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isKw = (v) => peek()?.type === 'kw' && peek().value === v;
  const isOp = (v) => peek()?.type === 'op' && peek().value === v;
  const expectKw = (v) => { if (!isKw(v)) throw new QueryError(`Expected ${v}`); next(); };
  const expectOp = (v) => { if (!isOp(v)) throw new QueryError(`Expected ${v}`); next(); };

  function column() {
    const t = next();
    if (!t || t.type !== 'ident') throw new QueryError('Expected a column');
    return t.quoted ? { type: 'col', name: t.value, quoted: true } : { type: 'col', name: t.value };
  }
  function term() {
    const t = peek();
    if (!t) throw new QueryError('Unexpected end of query');
    if (t.type === 'ident') {
      const lower = t.value.toLowerCase();
      if (!t.quoted && (AGGREGATES.has(lower) || SCALARS.has(lower)) && tokens[pos + 1]?.type === 'op' && tokens[pos + 1].value === '(') {
        next(); next();
        const arg = term();
        expectOp(')');
        return AGGREGATES.has(lower) ? { type: 'agg', fn: lower, arg } : { type: 'scalar', fn: lower, arg };
      }
      return column();
    }
    if (t.type === 'number') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'string') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) { next(); return { type: 'lit', value: t.value === 'true' }; }
    if (t.type === 'kw' && t.value === 'date') {
      next();
      const s = next();
      if (!s || s.type !== 'string') throw new QueryError('date needs a quoted yyyy-mm-dd');
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.value.trim());
      if (!m) throw new QueryError('date needs yyyy-mm-dd');
      return { type: 'lit', value: ymdToSerial(Number(m[1]), Number(m[2]), Number(m[3])) };
    }
    if (t.type === 'op' && t.value === '(') { next(); const inner = condition(); expectOp(')'); return inner; }
    if (t.type === 'kw' && UNSUPPORTED_LITERALS.has(t.value)) throw new QueryError(`${t.value} literals are not supported`);
    throw new QueryError(`Unexpected "${tokenText(t)}"`);
  }
  function comparison() {
    const left = term();
    if (isKw('is')) {
      next();
      let negate = false;
      if (isKw('not')) { next(); negate = true; }
      expectKw('null');
      return { type: 'isnull', arg: left, negate };
    }
    if (peek()?.type === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(peek().value)) {
      const op = next().value;
      return { type: 'cmp', op, left, right: term() };
    }
    if (isKw('contains') || isKw('matches') || isKw('like')) { const op = next().value; return { type: 'text', op, left, right: term() }; }
    if (isKw('starts') || isKw('ends')) { const op = next().value; expectKw('with'); return { type: 'text', op, left, right: term() }; }
    return left; // a bare boolean column
  }
  function notExpr() {
    if (isKw('not')) { next(); return { type: 'not', arg: notExpr() }; }
    return comparison();
  }
  function andExpr() {
    let left = notExpr();
    while (isKw('and')) { next(); left = { type: 'and', left, right: notExpr() }; }
    return left;
  }
  function condition() {
    let left = andExpr();
    while (isKw('or')) { next(); left = { type: 'or', left, right: andExpr() }; }
    return left;
  }

  const q = { select: null, where: null, groupBy: [], orderBy: [], limit: null, offset: 0, labels: [] };
  if (isKw('select')) {
    next();
    if (isOp('*')) { next(); q.select = '*'; } else {
      q.select = [term()];
      while (isOp(',')) { next(); q.select.push(term()); }
    }
  }
  if (isKw('where')) { next(); q.where = condition(); }
  if (isKw('group')) {
    next(); expectKw('by');
    // A scalar of a column, year(C) or upper(A), groups by its answer, as it does in select and
    // order by: a month-by-month summary is written that way. An aggregate cannot be grouped by.
    const groupTerm = () => {
      const e = term();
      if (e.type === 'agg') throw new QueryError('Aggregates cannot be grouped by');
      return e;
    };
    q.groupBy = [groupTerm()];
    while (isOp(',')) { next(); q.groupBy.push(groupTerm()); }
  }
  if (isKw('order')) {
    next(); expectKw('by');
    for (;;) {
      const expr = term();
      let desc = false;
      if (isKw('asc')) next(); else if (isKw('desc')) { next(); desc = true; }
      q.orderBy.push({ expr, desc });
      if (isOp(',')) { next(); continue; }
      break;
    }
  }
  if (isKw('limit')) { next(); const t = next(); if (t?.type !== 'number') throw new QueryError('limit needs a number'); q.limit = Math.max(0, Math.trunc(t.value)); }
  if (isKw('offset')) { next(); const t = next(); if (t?.type !== 'number') throw new QueryError('offset needs a number'); q.offset = Math.max(0, Math.trunc(t.value)); }
  if (isKw('label')) {
    next();
    for (;;) {
      const expr = term();
      const t = next();
      if (t?.type !== 'string') throw new QueryError('label needs quoted text');
      q.labels.push({ expr, text: t.value });
      if (isOp(',')) { next(); continue; }
      break;
    }
  }
  if (isKw('pivot')) throw new QueryError('pivot clauses are not supported');
  if (isKw('format') || isKw('options')) throw new QueryError('format and options clauses are not supported');
  if (pos < tokens.length) throw new QueryError(`Unexpected "${tokenText(peek())}"`);
  return q;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const blank = (v) => v == null || v === '';

function exprKey(e) {
  if (e.type === 'col') return e.name.toUpperCase();
  if (e.type === 'agg' || e.type === 'scalar') return `${e.fn}(${exprKey(e.arg)})`;
  return JSON.stringify(e.value);
}

/** Does the first row of the data look like a header (text over values)? */
function guessHeaders(rows) {
  if (rows.length < 2) return 0;
  const first = rows[0];
  const textish = first.filter((v) => typeof v === 'string' && v !== '').length;
  if (!textish || textish < first.filter((v) => !blank(v)).length) return 0;
  const typedBelow = rows.slice(1, 6).some((row) => row.some((v) => v != null && typeof v !== 'string'));
  return typedBelow ? 1 : 0;
}

/**
 * Run a parsed (or textual) query over `values` (rows of scalars).
 * `firstCol` is the sheet column index of the data's first column, so that
 * letters in the query name the same columns they do on the sheet.
 * Returns { values } (rows) or { error }.
 */
export function runQuery(values, query, { headers = -1, firstCol = 0 } = {}) {
  let q;
  try { q = typeof query === 'string' ? parseQuery(query) : query; } catch (e) { return { error: '#VALUE!', message: e.message }; }
  const width = values.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = values.map((r) => { const out = r.slice(); while (out.length < width) out.push(null); return out; });
  const headerRows = headers >= 0 ? Math.min(headers, rows.length) : guessHeaders(rows);
  const headerNames = [];
  for (let c = 0; c < width; c++) {
    const cells = rows.slice(0, headerRows).map((r) => r[c]).filter((v) => !blank(v)).map(String);
    headerNames.push(cells.join(' '));
  }
  const body = rows.slice(headerRows);

  // A bare word of one to three letters is a sheet column and ColN the Nth column of the data, as in
  // Sheets; any other word, and any word in backticks, is a header of the data.
  const colIndex = (name, quoted) => {
    if (!quoted) {
      const m = /^col(\d+)$/i.exec(name);
      if (m) return Number(m[1]) - 1;
      if (/^[A-Za-z]{1,3}$/.test(name)) {
        let n = 0;
        for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1 - firstCol;
      }
    }
    return headerNames.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  };
  const resolveCols = (e) => {
    if (e.type === 'col') {
      const idx = colIndex(e.name, e.quoted);
      if (idx < 0 || idx >= width) throw new QueryError(`No column ${e.name}`);
      return { ...e, idx };
    }
    if (e.type === 'agg' || e.type === 'scalar') return { ...e, arg: resolveCols(e.arg) };
    if (e.type === 'cmp' || e.type === 'text') return { ...e, left: resolveCols(e.left), right: resolveCols(e.right) };
    if (e.type === 'and' || e.type === 'or') return { ...e, left: resolveCols(e.left), right: resolveCols(e.right) };
    if (e.type === 'not' || e.type === 'isnull') return { ...e, arg: resolveCols(e.arg) };
    return e;
  };
  try {
    q = {
      ...q,
      select: q.select === '*' || q.select === null ? q.select : q.select.map(resolveCols),
      where: q.where ? resolveCols(q.where) : null,
      groupBy: q.groupBy.map(resolveCols),
      orderBy: q.orderBy.map((o) => ({ ...o, expr: resolveCols(o.expr) })),
      labels: q.labels.map((l) => ({ ...l, expr: resolveCols(l.expr) })),
    };
  } catch (e) { return { error: '#VALUE!', message: e.message }; }

  const scalar = (fn, v) => {
    if (fn === 'upper') return blank(v) ? null : String(v).toUpperCase();
    if (fn === 'lower') return blank(v) ? null : String(v).toLowerCase();
    if (fn === 'len') return blank(v) ? 0 : String(v).length;
    if (!isNum(v)) return null;
    const { y, m, d, weekday } = serialToYMD(v);
    // A time rounding up to the next midnight is hour 0 of that day, not hour 24.
    const secs = Math.round(((v % 1) + 1) % 1 * 86400) % 86400;
    // The query language counts months from 0 (January) and days of the week from 1 (Sunday).
    return { year: y, month: m - 1, day: d, dayofweek: weekday + 1, hour: Math.floor(secs / 3600), minute: Math.floor((secs % 3600) / 60), second: secs % 60 }[fn];
  };
  const value = (e, row) => {
    if (e.type === 'lit') return e.value;
    if (e.type === 'col') return row[e.idx] ?? null;
    if (e.type === 'scalar') return scalar(e.fn, value(e.arg, row));
    throw new QueryError('Aggregates belong in select, order by, or label');
  };
  const compare = (a, b) => {
    if (blank(a) && blank(b)) return 0;
    if (blank(a)) return -1;
    if (blank(b)) return 1;
    if (isNum(a) && isNum(b)) return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a !== typeof b) return typeof a === 'number' ? -1 : typeof b === 'number' ? 1 : String(a) < String(b) ? -1 : 1;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  const test = (cond, row) => {
    switch (cond.type) {
      case 'and': return test(cond.left, row) && test(cond.right, row);
      case 'or': return test(cond.left, row) || test(cond.right, row);
      case 'not': return !test(cond.arg, row);
      case 'isnull': return blank(value(cond.arg, row)) !== cond.negate;
      case 'cmp': {
        const a = value(cond.left, row);
        const b = value(cond.right, row);
        // Every comparison with an empty cell is false, as in Sheets; only "is null" sees empties.
        // The literal '' is a value, though: A <> '' picks the rows with text in A.
        const empty = (e, v) => e.type !== 'lit' && blank(v);
        if (empty(cond.left, a) || empty(cond.right, b)) return false;
        if (cond.op === '=') return typeof a === typeof b && compare(a, b) === 0;
        if (cond.op === '<>') return !(typeof a === typeof b && compare(a, b) === 0);
        if (typeof a !== typeof b) return false;
        const c = compare(a, b);
        return cond.op === '<' ? c < 0 : cond.op === '<=' ? c <= 0 : cond.op === '>' ? c > 0 : c >= 0;
      }
      case 'text': {
        const a = value(cond.left, row);
        const b = value(cond.right, row);
        if (blank(a) || blank(b)) return false;
        const s = String(a);
        const p = String(b);
        if (cond.op === 'contains') return s.includes(p);
        if (cond.op === 'starts') return s.startsWith(p);
        if (cond.op === 'ends') return s.endsWith(p);
        if (cond.op === 'matches') {
          const { pattern, flags } = inlineFlags(p);
          const { re, limit } = patternRegex(`^(?:${pattern})$`, pattern, flags);
          if (s.length > limit) throw new QueryError('Text too long for this regular expression');
          return re.test(s);
        }
        return likeMatch(s, p);
      }
      default: { const v = value(cond, row); return v === true; }
    }
  };
  const aggregate = (fn, list) => {
    const nums = list.filter(isNum);
    switch (fn) {
      case 'sum': return sum(nums);
      case 'avg': return nums.length ? mean(nums) : null;
      case 'count': return list.filter((v) => !blank(v)).length;
      case 'max': return nums.length ? nums.reduce((a, b) => Math.max(a, b), -Infinity) : (list.filter((v) => !blank(v)).sort(compare).pop() ?? null);
      case 'min': return nums.length ? nums.reduce((a, b) => Math.min(a, b), Infinity) : (list.filter((v) => !blank(v)).sort(compare)[0] ?? null);
      default: return null;
    }
  };
  const labelFor = (e) => {
    const custom = q.labels.find((l) => exprKey(l.expr) === exprKey(e));
    if (custom) return custom.text;
    if (e.type === 'col') return headerNames[e.idx] || '';
    if (e.type === 'agg') return `${e.fn} ${labelFor(e.arg) || colName(e.arg.idx + firstCol)}`.trim();
    if (e.type === 'scalar') return `${e.fn}(${labelFor(e.arg)})`;
    return String(e.value);
  };

  try {
    let kept = q.where ? body.filter((row) => test(q.where, row)) : body;
    const select = q.select === '*' || q.select === null ? Array.from({ length: width }, (_, i) => ({ type: 'col', name: colName(i + firstCol), idx: i })) : q.select;
    const hasAgg = select.some((e) => e.type === 'agg') || q.orderBy.some((o) => o.expr.type === 'agg');
    let out;
    if (hasAgg || q.groupBy.length) {
      for (const e of select) if (e.type !== 'agg' && !q.groupBy.some((g) => exprKey(g) === exprKey(e))) throw new QueryError('Columns in select must be grouped or aggregated');
      const groups = new Map();
      for (const row of kept) {
        const key = q.groupBy.map((g) => JSON.stringify(value(g, row) ?? null)).join('\u0000');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const evalGroup = (e, rowsOf) => (e.type === 'agg' ? aggregate(e.fn, rowsOf.map((r) => value(e.arg, r))) : value(e, rowsOf[0]));
      // Groups come out in group-key order, as Sheets does.
      out = [...groups.values()]
        .map((rowsOf) => ({ cells: select.map((e) => evalGroup(e, rowsOf)), sort: q.orderBy.map((o) => evalGroup(o.expr, rowsOf)), key: q.groupBy.map((g) => value(g, rowsOf[0])) }))
        .sort((a, b) => { for (let i = 0; i < a.key.length; i++) { const c = compare(a.key[i], b.key[i]); if (c) return c; } return 0; });
    } else {
      out = kept.map((row) => ({ cells: select.map((e) => value(e, row)), sort: q.orderBy.map((o) => value(o.expr, row)) }));
    }
    if (q.orderBy.length) {
      out.sort((a, b) => {
        for (let i = 0; i < q.orderBy.length; i++) {
          const c = compare(a.sort[i], b.sort[i]);
          if (c) return q.orderBy[i].desc ? -c : c;
        }
        return 0;
      });
    }
    out = out.slice(q.offset, q.limit == null ? undefined : q.offset + q.limit);
    const result = out.map((o) => o.cells);
    if (headerRows > 0) result.unshift(select.map(labelFor));
    if (!result.length) return { values: [[null]] };
    return { values: result };
  } catch (e) {
    return { error: e instanceof QueryError ? '#VALUE!' : '#ERROR!', message: e.message };
  }
}
