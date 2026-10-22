/**
 * AST → formula text, and a walk that evaluates every part of a formula so
 * it can be shown step by step (the Evaluate formula dialog).
 */

import { refToText, quoteSheet } from '../refs.js';
import { evaluate, evaluateFormula, evaluateBinding } from './evaluator.js';
import { parseFormula } from './parser.js';
import { formatValue } from '../format.js';

const PRECEDENCE = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

/** The text of an AST node, as a user would type it. */
export function astToText(node) {
  switch (node.type) {
    case 'num': return String(node.value);
    case 'str': return `"${String(node.value).replace(/"/g, '""')}"`;
    case 'bool': return node.value ? 'TRUE' : 'FALSE';
    case 'err': return node.value;
    case 'empty': return '';
    case 'ref': return refToText(node.ref);
    case 'tref': return `${node.table || ''}[${node.spec}]`;
    // @ takes the reference beside it before a percent sign applies, so @(A1:A3%) keeps its parentheses.
    case 'unary': return node.op === '@' && node.arg.type === 'percent' ? `@(${astToText(node.arg)})` : `${node.op}${wrap(node.arg, 6)}`;
    case 'percent': return `${wrap(node.arg, 6)}%`;
    // Every operator here groups to the left, ^ included, so a right operand of equal precedence keeps its parentheses: 2^(3^2).
    case 'binary': {
      // A chain of operators parses left-deep, so its spine is walked as a list, as the evaluator
      // does, and 1+1+… with thousands of terms does not recurse once per term.
      const spine = [];
      let leftmost = node;
      while (leftmost.type === 'binary') { spine.push(leftmost); leftmost = leftmost.left; }
      let text = astToText(leftmost);
      for (let i = spine.length - 1; i >= 0; i--) {
        const { op, right } = spine[i];
        if (i < spine.length - 1 && !spine[i + 1].parenthesized && PRECEDENCE[spine[i + 1].op] < PRECEDENCE[op]) text = `(${text})`;
        text = `${text}${op}${wrap(right, PRECEDENCE[op] + 1)}`;
        if (spine[i].parenthesized) text = `(${text})`;
      }
      return text;
    }
    case 'call': {
      // A sheet-scoped name keeps its sheet, or two scopes' names would print alike and re-parse as the wrong one.
      const name = node.sheet ? `${quoteSheet(node.sheet)}!${node.name}` : node.name;
      return node.bare ? name : `${name}(${node.args.map(astToText).join(',')})`;
    }
    case 'apply': return `${astToText(node.fn)}(${node.args.map(astToText).join(',')})`;
    case 'array': return `{${node.rows.map((row) => row.map(astToText).join(',')).join(';')}}`;
    case 'union': return `(${node.parts.map(astToText).join(',')})`;
    case 'range': return `${wrap(node.left, 9)}:${wrap(node.right, 10)}`;
    case 'intersection': {
      const rights = [];
      let leftmost = node;
      while (leftmost.type === 'intersection') { rights.push(leftmost.right); leftmost = leftmost.left; }
      const parts = [wrap(leftmost, 8)];
      for (let i = rights.length - 1; i >= 0; i--) parts.push(wrap(rights[i], 9));
      return parts.join(' ');
    }
    default: return '?';
  }
}

function wrap(node, minPrecedence) {
  const text = astToText(node);
  const p = node.type === 'binary' ? PRECEDENCE[node.op] : node.type === 'intersection' ? 8 : node.type === 'range' ? 9 : 10;
  return !node.parenthesized && p < minPrecedence ? `(${text})` : text;
}

/** A value as the dialog shows it: ranges as a compact grid, errors by name, text quoted. */
export function describeValue(value) {
  if (value == null) return '(blank)';
  if (typeof value === 'object') {
    if (value.error) return value.error;
    if (value.lambda) return 'LAMBDA';
    if (value.range) {
      const rows = value.values.slice(0, 4).map((row) => row.slice(0, 6).map((v) => describeValue(v)).join(' | ') + (row.length > 6 ? ' | …' : ''));
      const more = value.values.length > 4 ? `\n… ${value.values.length} rows` : '';
      return `${rows.join('\n')}${more}`;
    }
    return '(object)';
  }
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return formatValue(value, null);
}

/**
 * Every part of a formula with its value, innermost first: [{ depth, text,
 * value }]. `ctx` is the evaluator context for the cell the formula sits in.
 */
export function evaluateParts(formula, ctx) {
  let ast;
  try { ast = parseFormula(formula); } catch (e) { return { error: e.message, parts: [] }; }
  const parts = [];
  const seen = new Set();
  // `scope` is the context a part is evaluated in: inside a LET, the names bound before it.
  const walk = (node, depth, scope) => {
    switch (node.type) {
      case 'call':
        if (node.name === 'LET' && !node.sheet && node.args.length >= 3) {
          // Each value sees the names before it and the result sees them all, as in the evaluator; the names themselves are declarations, not parts.
          const locals = new Map(scope.locals || []);
          const inner = { ...scope, locals };
          const args = node.args;
          for (let i = 0; i + 1 < args.length - 1; i += 2) {
            walk(args[i + 1], depth + 1, inner);
            const name = args[i].type === 'call' && args[i].bare && !args[i].sheet ? args[i].name : null;
            if (!name) break;
            let value;
            try { value = args[i + 1].type === 'empty' ? null : evaluateBinding(args[i + 1], inner); } catch (e) { value = { error: '#ERROR!' }; }
            locals.set(name, value);
          }
          walk(args[args.length - 1], depth + 1, inner);
          break;
        }
        if (node.name !== 'LAMBDA') for (const a of node.args) walk(a, depth + 1, scope);
        break;
      case 'apply': for (const a of node.args) walk(a, depth + 1, scope); break;
      case 'union': for (const a of node.parts) walk(a, depth + 1, scope); break;
      case 'binary': case 'intersection': {
        // A chain of operators parses left-deep, so its spine is walked as a list, as the evaluator
        // does, and 1+1+… with thousands of terms does not recurse once per term. Each link of the
        // chain is a part one level deeper than the one it feeds.
        const spine = [];
        let leftmost = node;
        while (leftmost.type === 'binary' || leftmost.type === 'intersection') { spine.push(leftmost); leftmost = leftmost.left; }
        walk(leftmost, depth + spine.length, scope);
        for (let i = spine.length - 1; i >= 1; i--) {
          walk(spine[i].right, depth + i + 1, scope);
          part(spine[i], depth + i, scope);
        }
        walk(node.right, depth + 1, scope);
        break;
      }
      case 'range': walk(node.left, depth + 1, scope); walk(node.right, depth + 1, scope); break;
      case 'unary': case 'percent': walk(node.arg, depth + 1, scope); break;
      default: break;
    }
    part(node, depth, scope);
  };
  const part = (node, depth, scope) => {
    if (node.type === 'num' || node.type === 'str' || node.type === 'bool' || node.type === 'empty' || node.type === 'err') return;
    const text = astToText(node);
    if (seen.has(`${depth}:${text}`)) return;
    seen.add(`${depth}:${text}`);
    let value;
    try { value = (node === ast ? evaluateFormula : evaluate)(node, scope); } catch (e) { value = { error: '#ERROR!' }; }
    parts.push({ depth, text, value });
  };
  walk(ast, 0, ctx);
  return { error: null, parts };
}
