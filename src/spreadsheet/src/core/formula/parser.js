/**
 * Recursive-descent parser: tokens → AST.
 *
 * Precedence, lowest to highest (matching spreadsheet conventions):
 *   comparison  = <> < > <= >=
 *   concat      &
 *   additive    + -
 *   multiply    * /
 *   power       ^
 *   unary       - + @
 *   postfix     %
 *   intersection (space)
 *   range       :
 *
 * Node shapes:
 *   { type: 'num', value } | { type: 'str', value } | { type: 'bool', value }
 *   { type: 'err', value }
 *   { type: 'ref', ref }                 ref: parsed reference (see refs.js)
 *   { type: 'tref', table, spec }        structured reference (see tables.js)
 *   { type: 'unary', op, arg }
 *   { type: 'binary', op, left, right }
 *   { type: 'percent', arg }
 *   { type: 'call', name, args }
 *   { type: 'apply', fn, args }          calling an expression's result: LAMBDA(x, x+1)(4)
 *   { type: 'array', rows }              rows: node[][] from {1,2;3,4}
 *   { type: 'union', parts }             (A1:A3, C1:C3): several references as one argument
 *   { type: 'range', left, right }       A1:INDEX(A1:A5,3): the block between two reference expressions
 *   { type: 'intersection', left, right } A1:C4 B2:D5: cells shared by two references
 */

import { tokenize, FormulaSyntaxError } from './tokenizer.js';
import { parseRefText } from '../refs.js';

export { FormulaSyntaxError };

export function parseFormula(src, { namePositions = false, tablePositions = false } = {}) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const at = (type, value) => {
    const t = tokens[pos];
    return !!t && t.type === type && (value === undefined || t.value === value);
  };
  const expect = (type, what) => {
    if (!at(type)) {
      const t = peek();
      throw new FormulaSyntaxError(`Expected ${what}`, t ? t.start : src.length);
    }
    return next();
  };

  function comparison() {
    let left = concat();
    while (at('op') && ['=', '<>', '<', '>', '<=', '>='].includes(peek().value)) {
      const op = next().value;
      left = { type: 'binary', op, left, right: concat() };
    }
    return left;
  }

  function concat() {
    let left = additive();
    while (at('op', '&')) {
      next();
      left = { type: 'binary', op: '&', left, right: additive() };
    }
    return left;
  }

  function additive() {
    let left = multiplicative();
    while (at('op', '+') || at('op', '-')) {
      const op = next().value;
      left = { type: 'binary', op, left, right: multiplicative() };
    }
    return left;
  }

  function multiplicative() {
    let left = power();
    while (at('op', '*') || at('op', '/')) {
      const op = next().value;
      left = { type: 'binary', op, left, right: power() };
    }
    return left;
  }

  function power() {
    let left = unary();
    // Left-associative: 2^3^2 = 64.
    while (at('op', '^')) {
      next();
      left = { type: 'binary', op: '^', left, right: unary() };
    }
    return left;
  }

  function unary() {
    if (at('op', '-')) { next(); return { type: 'unary', op: '-', arg: unary() }; }
    if (at('op', '+')) { next(); return { type: 'unary', op: '+', arg: unary() }; }
    // @range: implicit intersection, the one value on the formula's own row or column (Excel writes it into saved formulas).
    if (at('op', '@')) { next(); return { type: 'unary', op: '@', arg: unary() }; }
    return postfix();
  }

  // Called after "(" for both named functions and expression calls.
  function callArguments() {
    const args = [];
    if (!at('rparen')) {
      for (;;) {
        args.push(at('comma') || at('rparen') ? { type: 'empty' } : comparison());
        if (!at('comma')) break;
        next();
      }
    }
    expect('rparen', '")"');
    return args;
  }

  // What may stand on either side of the range operator: something that can evaluate to a reference.
  const isReference = (node) => ['ref', 'tref', 'call', 'apply', 'range', 'intersection', 'union', 'err'].includes(node.type);

  // Token positions retain whitespace for reference operators without adding
  // whitespace tokens to the shared reference-rewriting/tokenization API.
  const intersectionSpace = () => pos > 0 && peek() && /^[ \n]+$/.test(src.slice(tokens[pos - 1].end, peek().start));

  function postfix() {
    let node = referenceRange();
    while (isReference(node) && intersectionSpace() && ['ref', 'tref', 'name', 'lparen', 'error'].includes(peek().type)) {
      const start = peek().start, right = referenceRange();
      if (!isReference(right)) throw new FormulaSyntaxError('Expected an intersecting reference', start);
      node = { type: 'intersection', left: node, right };
    }
    while (at('op', '%')) { next(); node = { type: 'percent', arg: node }; }
    return node;
  }

  function referenceAtom() {
    let node = primary();
    // An adjacent parenthesis calls a returned LAMBDA; a separating space
    // combines reference expressions, including parenthesized areas.
    while (at('lparen') && !intersectionSpace() && (node.type === 'call' || node.type === 'apply')) {
      next();
      node = { type: 'apply', fn: node, args: callArguments() };
    }
    return node;
  }

  function referenceRange() {
    let node = referenceAtom();
    while (at('colon') && isReference(node)) {
      // A1:INDEX(A1:A5,3), INDEX(..):INDEX(..), OFFSET(..):A5: the block between two references.
      // A plain A1:B2 is one token, so a colon only arrives here between reference expressions.
      const colon = next();
      const right = referenceAtom();
      if (!isReference(right)) throw new FormulaSyntaxError('Expected a reference after ":"', colon.start);
      node = { type: 'range', left: node, right };
    }
    return node;
  }

  function primary() {
    const t = peek();
    if (!t) throw new FormulaSyntaxError('Unexpected end of formula', src.length);

    switch (t.type) {
      case 'number': next(); return { type: 'num', value: t.value };
      case 'string': next(); return { type: 'str', value: t.value };
      case 'bool':
        next();
        // TRUE/FALSE are also zero-argument functions. Keep their literal
        // value while requiring empty parentheses when the call form is used.
        if (at('lparen')) { next(); expect('rparen', '")"'); }
        return { type: 'bool', value: t.value };
      case 'error': next(); return { type: 'err', value: t.value };
      case 'ref': {
        next();
        const ref = parseRefText(t.text, t.sheet, t.sheetEnd);
        if (!ref) throw new FormulaSyntaxError('Bad reference', t.start);
        if (ref.sheetEnd && t.spill) throw new FormulaSyntaxError('A 3D span cannot carry #', t.start);
        if (t.spill && ref.kind !== 'cell') throw new FormulaSyntaxError('Only a single cell can carry # for its spill', t.start);
        return { type: 'ref', ref: t.spill ? { ...ref, spill: true } : t.trim ? { ...ref, trim: t.trim } : ref };
      }
      case 'tref': next(); return { type: 'tref', table: t.table, spec: t.spec, ...(tablePositions ? { start: t.start, end: t.end } : {}) };
      case 'name': {
        next();
        if (at('lparen')) {
          next();
          const args = callArguments();
          return { type: 'call', name: t.value, args, ...(t.sheet ? { sheet: t.sheet } : {}), ...(namePositions ? { start: t.start, end: t.end } : {}) };
        }
        // A bare name is a zero-argument function (PI, TODAY) or unknown.
        return { type: 'call', name: t.value, args: [], bare: true, ...(t.sheet ? { sheet: t.sheet } : {}), ...(namePositions ? { start: t.start, end: t.end } : {}) };
      }
      case 'lparen': {
        next();
        const inner = comparison();
        if (at('comma')) {
          // (A1:A3, C1:C3): a union of references, one argument to SUM, COUNT, MAX, ...
          const parts = [inner];
          while (at('comma')) { next(); parts.push(comparison()); }
          expect('rparen', '")"');
          return { type: 'union', parts };
        }
        expect('rparen', '")"');
        // Final-operation cancellation correction is suppressed inside
        // parentheses, even when they are redundant for precedence.
        if (inner.type === 'binary' && (inner.op === '+' || inner.op === '-')) inner.parenthesized = true;
        return inner;
      }
      case 'lbrace': {
        // {1,2;3,4}: commas separate columns, semicolons rows. Every row
        // must be the same width.
        next();
        const rows = [[]];
        if (at('rbrace')) throw new FormulaSyntaxError('Empty array', t.start);
        for (;;) {
          rows[rows.length - 1].push(comparison());
          if (at('comma')) {
            if (next().value === ';') rows.push([]);
            continue;
          }
          break;
        }
        expect('rbrace', '"}"');
        if (rows.some((row) => row.length !== rows[0].length)) throw new FormulaSyntaxError('Array rows must be the same width', t.start);
        return { type: 'array', rows };
      }
      default:
        throw new FormulaSyntaxError('Unexpected token', t.start);
    }
  }

  let ast = comparison();
  // Defined names and chart references may store a union without enclosing
  // parentheses. At the root commas cannot be function/array separators.
  if (at('comma')) {
    const parts = [ast];
    while (at('comma')) { next(); parts.push(comparison()); }
    ast = { type: 'union', parts };
  }
  if (pos < tokens.length) throw new FormulaSyntaxError('Unexpected token', tokens[pos].start);
  return ast;
}
