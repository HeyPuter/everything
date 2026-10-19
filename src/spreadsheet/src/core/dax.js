/** DAX measure expressions have their own column/measure semantics. Do not
 * translate them into worksheet formulas or infer aggregates from captions.
 * This first evaluator handles scalar calls and column aggregates; callers
 * supply columns already restricted to the measure's filter context.
 */
export class DaxError extends Error {
  constructor(message) { super(message); this.name = 'DaxError'; }
}
export function parseDax(expression) {
  if (typeof expression !== 'string' || expression.length > 1024 * 1024) throw new DaxError('DAX expression exceeds size limit');
  const tokens = []; let at = 0;
  while (at < expression.length) {
    if (tokens.length >= 10000) throw new DaxError('DAX expression exceeds token limit');
    const c = expression[at];
    if (/\s/.test(c)) { at++; continue; }
    if (expression.startsWith('//', at) || expression.startsWith('--', at)) { const end = expression.indexOf('\n', at); at = end < 0 ? expression.length : end + 1; continue; }
    if (expression.startsWith('/*', at)) { const end = expression.indexOf('*/', at + 2); if (end < 0) throw new DaxError('Unterminated DAX comment'); at = end + 2; continue; }
    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c; let value = '', ended = false; at++;
      while (at < expression.length) {
        const next = expression[at++];
        if (next !== close) { value += next; continue; }
        if (expression[at] === close) { value += close; at++; continue; }
        ended = true; break;
      }
      if (!ended) throw new DaxError('Unterminated DAX identifier or string');
      tokens.push({ kind: c, value }); continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(at));
    if (number) { const value = Number(number[0]); if (!Number.isFinite(value) || !/[.eE]/.test(number[0]) && !Number.isSafeInteger(value)) throw new DaxError('Invalid or inexact DAX number'); tokens.push({ kind: 'number', value }); at += number[0].length; continue; }
    const word = /^[\p{L}_][\p{L}\p{M}\p{N}_]*/u.exec(expression.slice(at));
    if (word) { tokens.push({ kind: 'word', value: word[0] }); at += word[0].length; continue; }
    if ('(),+-'.includes(c)) { tokens.push({ kind: c }); at++; continue; }
    throw new DaxError(`Unsupported DAX syntax at character ${at + 1}`);
  }
  let pos = 0;
  const take = kind => tokens[pos]?.kind === kind ? tokens[pos++] : null;
  const expect = kind => { if (!take(kind)) throw new DaxError(`Expected ${kind} in DAX expression`); };
  const read = depth => {
    if (depth > 64) throw new DaxError('DAX expression exceeds nesting limit');
    const token = tokens[pos++]; if (!token) throw new DaxError('Incomplete DAX expression');
    if (token.kind === '+' || token.kind === '-') {
      const argument = read(depth + 1); return { kind: 'sign', negative: token.kind === '-', argument };
    }
    if (token.kind === '(') { const node = read(depth + 1); expect(')'); return node; }
    if (token.kind === 'number' || token.kind === '"') return { kind: 'literal', value: token.value };
    if (token.kind === '[') return { kind: 'reference', table: null, name: token.value };
    if (token.kind === 'word' || token.kind === "'") {
      const reference = take('[');
      if (reference) return { kind: 'reference', table: token.value, name: reference.value };
      if (token.kind === 'word' && take('(')) {
        const args = [];
        if (!take(')')) { do { args.push(read(depth + 1)); } while (take(',')); expect(')'); }
        return { kind: 'call', name: token.value.toUpperCase(), args };
      }
      return { kind: 'table', name: token.value };
    }
    throw new DaxError('Invalid DAX expression');
  };
  const ast = read(0);
  if (pos !== tokens.length) throw new DaxError('Unsupported trailing DAX expression');
  return ast;
}

/** null is DAX BLANK, distinct from numeric zero and the empty string. The
 * provider controls table/column identity and filter context, not this parser.
 * No functions execute external code, queries or data connections.
 */
export function evaluateDax(expression, context = {}, { maxValues = 4 * 1048576 } = {}) {
  const ast = parseDax(expression);
  if (!Number.isSafeInteger(maxValues) || maxValues < 0) throw new DaxError('Invalid DAX evaluation limit');
  let remaining = maxValues;
  const numeric = v => { if (v == null) return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw new DaxError('DAX expression requires a finite number'); return v; };
  const arity = (node, min, max = min) => { if (node.args.length < min || node.args.length > max) throw new DaxError(`Invalid argument count for ${node.name}`); };
  const aggregate = node => {
    arity(node, 1); const ref = node.args[0];
    if (ref.kind !== 'reference') throw new DaxError(`${node.name} requires a column reference`);
    const values = context.column?.(ref.table ?? context.table, ref.name);
    if (!values || typeof values[Symbol.iterator] !== 'function') throw new DaxError(`Unresolved DAX column ${ref.name}`);
    const integer = context.columnType?.(ref.table ?? context.table, ref.name) === 'integer';
    let count = 0, sum = 0, min = Infinity, max = -Infinity, text = false, integerSum = 0n, integerMin = null, integerMax = null, word = null;
    for (const value of values) {
      if (--remaining < 0) throw new DaxError('DAX evaluation exceeds value limit');
      if (value == null) continue;
      // Native whole-number storage exposes BigInt so values above 2^53 never
      // pass through a lossy Number conversion, including before COUNT.
      const storedInteger = integer && typeof value === 'bigint';
      if (storedInteger && (value < -(1n << 63n) || value >= 1n << 63n)) throw new DaxError('Data Model integer overflow');
      if (node.name === 'COUNTA' || node.name === 'COUNT') {
        if (!storedInteger && !['number', 'string', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new DaxError('Invalid DAX column value');
        if (node.name === 'COUNT' && typeof value === 'boolean') throw new DaxError('COUNT does not support logical columns');
        count++; continue;
      }
      if (node.name === 'AVERAGE' && typeof value === 'boolean') continue;
      if (node.name === 'AVERAGE' && typeof value === 'string') { text = true; continue; }
      // MIN and MAX take text too, compared without regard to case, as DAX compares it: MIN of pear, apple, fig is apple.
      if ((node.name === 'MIN' || node.name === 'MAX') && typeof value === 'string') {
        const k = value.toLowerCase();
        if (!word || (node.name === 'MIN' ? k < word.k : k > word.k)) word = { k, value };
        continue;
      }
      if (!storedInteger) numeric(value);
      count++;
      if (integer) {
        if (!storedInteger && !Number.isInteger(value)) throw new DaxError('A whole-number model column contains a fractional value');
        const exact = BigInt(value);
        if (exact < -(1n << 63n) || exact >= 1n << 63n) throw new DaxError('Data Model integer overflow');
        integerSum += exact;
        if (integerMin == null || exact < integerMin) integerMin = exact;
        if (integerMax == null || exact > integerMax) integerMax = exact;
      } else { sum += value; min = Math.min(min, value); max = Math.max(max, value); }
    }
    if (!count && word) return word.value;
    if (!count || node.name === 'AVERAGE' && text) return null;
    if (node.name === 'COUNT' || node.name === 'COUNTA') return count;
    if (integer) {
      if (node.name === 'AVERAGE') return numeric(Number(integerSum) / count);
      const exact = node.name === 'MIN' ? integerMin : node.name === 'MAX' ? integerMax : integerSum;
      if (exact < -(1n << 63n) || exact >= 1n << 63n) throw new DaxError('Data Model integer overflow');
      return exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : exact;
    }
    const result = node.name === 'MIN' ? min : node.name === 'MAX' ? max : node.name === 'AVERAGE' ? sum / count : sum;
    return numeric(result);
  };
  const run = node => {
    if (node.kind === 'literal') return node.value;
    if (node.kind === 'sign') { const raw = run(node.argument), value = typeof raw === 'bigint' ? raw : numeric(raw); return value == null ? null : node.negative ? -value : value; }
    if (node.kind === 'reference') {
      if (!context.measure) throw new DaxError(`Unresolved DAX measure ${node.name}`);
      return context.measure(node.table ?? context.table, node.name);
    }
    if (node.kind !== 'call') throw new DaxError('A DAX table cannot be used as a scalar');
    if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA'].includes(node.name)) return aggregate(node);
    if (node.name === 'BLANK') { arity(node, 0); return null; }
    if (node.name === 'TRUE' || node.name === 'FALSE') { arity(node, 0); return node.name === 'TRUE'; }
    if (node.name === 'COUNTROWS') {
      arity(node, 0, 1);
      if (node.args.length && node.args[0].kind !== 'table') throw new DaxError('COUNTROWS requires a table');
      const count = context.rowCount?.(node.args[0]?.name ?? context.table);
      if (!Number.isSafeInteger(count) || count < 0) throw new DaxError('Unresolved DAX table');
      return count || null;
    }
    if (node.name === 'DIVIDE') {
      arity(node, 2, 3);
      const constant = n => n.kind === 'literal' || n.kind === 'sign' && constant(n.argument) || n.kind === 'call' && n.name === 'BLANK' && !n.args.length;
      if (node.args[2] && !constant(node.args[2])) throw new DaxError('DIVIDE alternate result must be a constant');
      const decimal = v => numeric(typeof v === 'bigint' ? Number(v) : v);
      const numerator = decimal(run(node.args[0])), denominator = decimal(run(node.args[1]));
      if (!denominator) return node.args[2] ? run(node.args[2]) : null;
      return numerator == null ? null : numeric(numerator / denominator);
    }
    throw new DaxError(`Unsupported DAX function ${node.name}`);
  };
  return run(ast);
}
