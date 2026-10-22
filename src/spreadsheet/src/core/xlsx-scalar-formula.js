import { parseFormula } from './formula/parser.js';
import { FUNCTIONS } from './formula/functions.js';

const REFERENCE_RESULTS = new Set(['OFFSET', 'INDIRECT', 'INDEX']);
const SCALAR_CHOICES = new Set(['IF', 'IFERROR', 'IFNA', 'IFS', 'SWITCH']);

/** Make legacy single-value evaluation explicit where an expression consumes
 * scalars. Range/array consumers keep their arguments intact: SUMPRODUCT and
 * aggregate formulas must not lose the arrays they intentionally evaluate.
 * Call only for ordinary XLSX cells, never names or array-formula records.
 */
export function xlsxScalarFormula(formula) {
  // The @ goes into the formula's own text, which otherwise stays as the file wrote it: its names
  // in their own spelling (a parsed name is upper case), its line breaks and its spaces.
  const at = new Set();
  const intersect = node => { at.add(node.start); };
  const visit = (node, depth = 0) => {
    if (depth > 200) throw new RangeError('Formula nesting');
    const next = child => visit(child, depth + 1);
    switch (node.type) {
      case 'ref': if (node.ref.kind !== 'cell' && !node.ref.spill) intersect(node); return;
      // Table import handles column/row semantics and array calculated columns.
      case 'tref': return;
      case 'range': case 'intersection': case 'union': case 'array': intersect(node); return;
      case 'unary': if (node.op !== '@') next(node.arg); return;
      case 'percent': next(node.arg); return;
      case 'binary': next(node.left); next(node.right); return;
      case 'call':
        // Names keep their own expression context; explicit spill references and
        // table expressions are handled outside this scalar-range conversion.
        if (node.bare) return;
        if (!node.sheet && REFERENCE_RESULTS.has(node.name)) intersect(node);
        else if (!node.sheet && (SCALAR_CHOICES.has(node.name) || FUNCTIONS[node.name]?.lift)) node.args.forEach(next);
        return;
      default:
    }
  };
  try {
    visit(parseFormula(formula, { starts: true }));
  } catch { return formula; }
  // A union standing for the whole formula (A1,B1) has no one place to start: it is intersected whole.
  if (at.has(undefined)) return `@(${formula})`;
  let out = '', last = 0;
  for (const start of [...at].sort((a, b) => a - b)) { out += `${formula.slice(last, start)}@`; last = start; }
  return out + formula.slice(last);
}
