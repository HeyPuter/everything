/**
 * The number format a freshly typed formula implies, inferred at
 * entry: =TODAY() reads as a date rather than 46279, =NOW() as a date and
 * time, =TIME(9,30,0) as a time, =50% as a percent, and =A1*2 carries A1's
 * currency or percent. The format is only suggested for a cell that has no
 * number format of its own; the caller decides whether to store it.
 */

import { parseFormula } from './formula/parser.js';
import { localeCurrency } from './format.js';

/** Functions whose result is a date, a time, or both. */
const DATE_FUNCTIONS = new Map([
  ['TODAY', 'date'], ['DATE', 'date'], ['DATEVALUE', 'date'], ['EDATE', 'date'], ['EOMONTH', 'date'],
  ['WORKDAY', 'date'], ['WORKDAY.INTL', 'date'], ['TO_DATE', 'date'],
  ['NOW', 'datetime'], ['EPOCHTODATE', 'datetime'],
  ['TIME', 'time'], ['TIMEVALUE', 'time'],
]);

/**
 * Financial functions whose result Excel shows as money or as a rate: =PMT(5%/12,60,10000) reads -$188.71 rather
 * than -188.7123364, and =IRR(B2:B6) 13.07% rather than 0.130662386 (with two places, where Excel's whole percent
 * would show a monthly rate of 0.42% as 0%).
 */
const FINANCE_FUNCTIONS = new Map([
  ['PMT', 'currency'], ['IPMT', 'currency'], ['PPMT', 'currency'], ['PV', 'currency'], ['FV', 'currency'], ['NPV', 'currency'],
  ['RATE', 'percent'], ['IRR', 'percent'], ['MIRR', 'percent'],
]);

/** Functions whose result reads in the format of the first argument that has one. */
const CARRY_FUNCTIONS = new Set([
  'SUM', 'MIN', 'MAX', 'AVERAGE', 'MEDIAN', 'SMALL', 'LARGE', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS',
  'IFERROR', 'IFNA', 'INDEX', 'MINIFS', 'MAXIFS', 'SUMIFS', 'AVERAGEIFS', 'SUMPRODUCT',
]);

const DATE_KINDS = new Set(['date', 'datetime', 'time']);
/** Formats that survive a product or quotient: a price times a count is still a price; a date times two is not a date. */
const SCALAR_KINDS = new Set(['percent', 'currency', 'number', 'scientific']);
/** The style keys that describe a number format (and nothing else). */
const FORMAT_KEYS = ['fmt', 'dateStyle', 'cur', 'dec', 'group', 'sec', 'code'];
const MAX_DEPTH = 40;

/** The number-format part of a style, or null when it has no format worth carrying. */
export function formatPart(style) {
  const fmt = style?.fmt;
  if (!fmt || fmt === 'general' || fmt === 'text') return null;
  const out = {};
  for (const k of FORMAT_KEYS) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

function scalarOnly(part) {
  return part && SCALAR_KINDS.has(part.fmt) ? part : null;
}

function firstOf(nodes, walk) {
  for (const n of nodes) {
    const part = walk(n);
    if (part) return part;
  }
  return null;
}

/**
 * The style patch a formula implies, or null. `styleOfRef(ref)` returns the
 * style of a reference's first cell (any sheet), or null. `refOfName(name, sheet)`
 * returns the cells a defined name stands for, so =SUM(Prices) carries their
 * format as =SUM(B2:B3) does; without it a name carries nothing.
 */
export function impliedFormulaStyle(formula, styleOfRef, refOfName = null) {
  let ast;
  try { ast = parseFormula(formula); } catch { return null; }
  const walk = (node, depth = 0) => {
    if (!node || depth > MAX_DEPTH) return null;
    const next = (n) => walk(n, depth + 1);
    switch (node.type) {
      case 'ref':
        return formatPart(styleOfRef(node.ref));
      case 'percent':
        return { fmt: 'percent' };
      case 'unary':
        return node.op === '-' || node.op === '+' ? next(node.arg) : null;
      case 'binary': {
        if (node.op === '+' || node.op === '-') {
          const left = next(node.left);
          const right = next(node.right);
          // A date minus a date is a number of days, not another date.
          if (node.op === '-' && left && right && DATE_KINDS.has(left.fmt) && DATE_KINDS.has(right.fmt)) return null;
          return left || right;
        }
        if (node.op === '*' || node.op === '/') return scalarOnly(next(node.left)) || scalarOnly(next(node.right));
        return null;
      }
      case 'call': {
        const name = String(node.name).toUpperCase();
        const args = node.args || [];
        const dated = DATE_FUNCTIONS.get(name);
        if (dated) return { fmt: dated };
        const finance = FINANCE_FUNCTIONS.get(name);
        // Money in the regional format's currency, as the ribbon's Currency button gives it.
        if (finance === 'currency') return { fmt: 'currency', ...(localeCurrency() !== 'USD' ? { cur: localeCurrency() } : {}) };
        if (finance === 'percent') return { fmt: 'percent', dec: 2 };
        if (name === 'IF') return firstOf(args.slice(1, 3), next);
        if (name === 'CHOOSE') return firstOf(args.slice(1), next);
        if (name === 'SUMIF' || name === 'AVERAGEIF') return next(args[2] ?? args[0]);
        if (name === 'LET') return args.length ? next(args[args.length - 1]) : null;
        if (CARRY_FUNCTIONS.has(name)) return firstOf(args, next);
        // A bare word no function answers to is a defined name, which stands for the cells it was given.
        if (node.bare && refOfName) {
          const ref = refOfName(node.name, node.sheet);
          return ref ? formatPart(styleOfRef(ref)) : null;
        }
        return null;
      }
      default:
        return null;
    }
  };
  return walk(ast);
}
