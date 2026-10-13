// Table formulas: the = (formula) field (ECMA-376 Part 1 §17.16.3, §17.16.5.4)
// evaluated over table cells. A formula such as `=SUM(ABOVE) \# "#,##0.00"`
// is stored as an ordinary field whose cached result is the computed text;
// Update Fields recomputes it. Supported: + - * / ^ %, comparisons, numbers,
// cell references (A1, A1:B3), ABOVE/BELOW/LEFT/RIGHT, and the functions below.
import { cellContext, rowGrid, verticalMerges } from './tables.js';
import { paragraphText, locate } from './model.js';
import { bodyFieldRanges } from './body-fields.js';
import { newBodyField } from './toc.js';
import { fieldInstructionTokens } from './docx-page-fields.js';

export const FORMULA_FUNCTIONS = Object.freeze(['ABS', 'AND', 'AVERAGE', 'COUNT', 'DEFINED', 'FALSE', 'IF', 'INT', 'MAX', 'MIN', 'MOD', 'NOT', 'OR', 'PRODUCT', 'ROUND', 'SIGN', 'SUM', 'TRUE']);
export const DIRECTIONS = Object.freeze(['ABOVE', 'BELOW', 'LEFT', 'RIGHT']);
export const NUMBER_FORMATS = Object.freeze(['0', '0.00', '#,##0', '#,##0.00', '$#,##0.00;($#,##0.00)', '0%', '0.00%']);

/** The leading number of a cell's text: currency, grouping, percent and accounting negatives allowed. */
export function cellNumber(text) {
  // The number must lead the cell's text: "12 boxes" counts, "Q1" does not.
  const match = /^\s*()([-+−]?)\s*\(?\s*[$€£¥]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(text);
  if (!match) return null;
  const value = Number(match[3].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const negative = match[2] === '-' || match[2] === '−' || /\(\s*[$€£¥]?\s*[\d.,]+\s*\)/.test(text);
  return negative ? -value : value;
}

/* ---- Parsing ---- */

function tokenize(source) {
  const tokens = [], pattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)|([A-Za-z]+)|(<=|>=|<>|[-+*/^%(),;=<>:]))/y;
  let at = 0;
  while (at < source.length) {
    pattern.lastIndex = at;
    const m = pattern.exec(source);
    if (!m) { if (!source.slice(at).trim()) break; throw new Error(`Unexpected "${source.slice(at).trim()[0]}" in the formula.`); }
    at = pattern.lastIndex;
    if (m[1] !== undefined) tokens.push({ type: 'number', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'ref', value: m[2].toUpperCase() });
    else if (m[3] !== undefined) tokens.push({ type: 'name', value: m[3].toUpperCase() });
    else if (m[4] !== undefined) tokens.push({ type: 'op', value: m[4] === ';' ? ',' : m[4] });
  }
  return tokens;
}

/** Parse a formula (without its leading =) into a tree. */
export function parseFormula(source) {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i], take = () => tokens[i++];
  const expect = value => { const t = take(); if (!t || t.value !== value) throw new Error(`Expected "${value}" in the formula.`); };
  const binary = (next, ops) => () => {
    let left = next();
    while (peek()?.type === 'op' && ops.includes(peek().value)) { const op = take().value; left = { type: 'binary', op, left, right: next() }; }
    return left;
  };
  const primary = () => {
    const t = take();
    if (!t) throw new Error('The formula ends too soon.');
    if (t.type === 'number') return { type: 'number', value: t.value };
    if (t.type === 'op' && t.value === '(') { const inner = comparison(); expect(')'); return inner; }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) { const operand = power(); return t.value === '-' ? { type: 'negate', operand } : operand; }
    if (t.type === 'ref') {
      const [from, to] = t.value.split(':');
      return { type: 'range', from: cellReference(from), to: cellReference(to || from) };
    }
    if (t.type === 'name') {
      if (DIRECTIONS.includes(t.value)) return { type: 'direction', value: t.value };
      if (t.value === 'TRUE' || t.value === 'FALSE') { if (peek()?.value === '(') { take(); expect(')'); } return { type: 'number', value: t.value === 'TRUE' ? 1 : 0 }; }
      if (!FORMULA_FUNCTIONS.includes(t.value)) throw new Error(`${t.value} is not a formula function.`);
      expect('(');
      const args = [];
      if (peek()?.value !== ')') { do args.push(comparison()); while (peek()?.value === ',' && take()); }
      expect(')');
      return { type: 'call', name: t.value, args };
    }
    throw new Error(`Unexpected "${t.value}" in the formula.`);
  };
  const percent = () => { let value = primary(); while (peek()?.value === '%') { take(); value = { type: 'percent', operand: value }; } return value; };
  const power = binary(percent, ['^']);
  const product = binary(power, ['*', '/']);
  const total = binary(product, ['+', '-']);
  const comparison = binary(total, ['=', '<', '>', '<=', '>=', '<>']);
  if (!tokens.length) throw new Error('Type a formula after the equals sign.');
  const tree = comparison();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].value}" in the formula.`);
  return tree;
}

/** A1 → { row: 0, column: 0 } (column letters A–Z, AA…, rows from 1). */
export function cellReference(text) {
  const m = /^([A-Z]+)(\d+)$/.exec(text);
  if (!m) throw new Error(`${text} is not a cell reference.`);
  const column = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(m[2]) - 1, column };
}
export const columnName = column => { let name = ''; for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };

/* ---- Evaluation ---- */

/** The text a cell shows (its own paragraphs, not nested tables'). */
function cellText(paragraphs, cell) {
  return paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join(' ').replace(/\ufffc/g, '');
}
function cellAt(table, row, column) {
  const r = table.rows[row];
  if (!r) return null;
  const owners = verticalMerges(table);
  const found = rowGrid(r).find(c => c.column <= column && c.end > column);
  return found ? owners.get(found.cell.id).cell : null;
}

/** Values for a direction: the run of numeric cells next to the formula's cell, stopping at the first without a number. */
function directionValues(context, direction) {
  const { table, rowIndex, column, end, paragraphs } = context, values = [];
  const step = { ABOVE: [-1, 0], BELOW: [1, 0], LEFT: [0, -1], RIGHT: [0, 1] }[direction];
  const owners = verticalMerges(table), own = owners.get(context.cellId);
  let row = step[0] < 0 ? own.rowIndex - 1 : step[0] > 0 ? own.endRow + 1 : rowIndex, col = step[1] < 0 ? column - 1 : step[1] > 0 ? end : column;
  const seen = new Set();
  while (row >= 0 && row < table.rows.length && col >= 0 && col < table.grid.length) {
    const cell = cellAt(table, row, col);
    if (!cell || seen.has(cell.id)) { row += step[0]; col += step[1]; continue; }
    seen.add(cell.id);
    const value = cellNumber(cellText(paragraphs, cell));
    // An empty or text cell ends the run (a header row stops ABOVE at the column's top).
    if (value === null) { if (values.length) break; if (!cellText(paragraphs, cell).trim()) { row += step[0]; col += step[1]; continue; } break; }
    values.push(value);
    if (step[0]) { const o = owners.get(cell.id); row = step[0] < 0 ? o.rowIndex - 1 : o.endRow + 1; }
    else { const placement = rowGrid(table.rows[row]).find(c => c.cell === cell || owners.get(c.cell.id).cell === cell); col = step[1] < 0 ? (placement?.column ?? col) - 1 : placement?.end ?? col + 1; }
  }
  return values;
}

function rangeValues(context, from, to) {
  const values = [], seen = new Set();
  for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++) for (let c = Math.min(from.column, to.column); c <= Math.max(from.column, to.column); c++) {
    const cell = cellAt(context.table, r, c);
    if (!cell || seen.has(cell.id)) continue;
    seen.add(cell.id);
    const value = cellNumber(cellText(context.paragraphs, cell));
    if (value !== null) values.push(value);
  }
  return values;
}

const FUNCTIONS = {
  SUM: v => v.reduce((a, b) => a + b, 0),
  PRODUCT: v => v.reduce((a, b) => a * b, 1),
  AVERAGE: v => { if (!v.length) throw new Error('AVERAGE has no numbers to average.'); return v.reduce((a, b) => a + b, 0) / v.length; },
  COUNT: v => v.length,
  MAX: v => (v.length ? Math.max(...v) : 0),
  MIN: v => (v.length ? Math.min(...v) : 0),
};

function evaluate(node, context) {
  const list = arg => arg.type === 'direction' ? directionValues(context, arg.value) : arg.type === 'range' ? rangeValues(context, arg.from, arg.to) : [evaluate(arg, context)];
  switch (node.type) {
    case 'number': return node.value;
    case 'negate': return -evaluate(node.operand, context);
    case 'percent': return evaluate(node.operand, context) / 100;
    case 'range': {
      const values = rangeValues(context, node.from, node.to);
      if (node.from.row === node.to.row && node.from.column === node.to.column) return values[0] ?? 0;
      return values.reduce((a, b) => a + b, 0);
    }
    case 'direction': return directionValues(context, node.value).reduce((a, b) => a + b, 0);
    case 'binary': {
      const a = evaluate(node.left, context), b = evaluate(node.right, context);
      switch (node.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': if (b === 0) throw new Error('!Zero Divide'); return a / b;
        case '^': return a ** b;
        case '=': return +(a === b); case '<>': return +(a !== b); case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
      }
      break;
    }
    case 'call': {
      const { name, args } = node;
      if (FUNCTIONS[name]) return FUNCTIONS[name](args.flatMap(list));
      const value = i => evaluate(args[i], context), need = n => { if (args.length !== n) throw new Error(`${name} takes ${n} ${n === 1 ? 'value' : 'values'}.`); };
      switch (name) {
        case 'ABS': need(1); return Math.abs(value(0));
        case 'INT': need(1); return Math.trunc(value(0));
        case 'SIGN': need(1); return Math.sign(value(0));
        case 'NOT': need(1); return +!value(0);
        case 'MOD': { need(2); const b = value(1); if (b === 0) throw new Error('!Zero Divide'); return value(0) % b; }
        case 'ROUND': { need(2); const f = 10 ** Math.trunc(value(1)); return Math.round(value(0) * f) / f; }
        case 'AND': need(2); return +(!!value(0) && !!value(1));
        case 'OR': need(2); return +(!!value(0) || !!value(1));
        case 'IF': need(3); return value(0) ? value(1) : value(2);
        case 'DEFINED': need(1); try { value(0); return 1; } catch { return 0; }
        case 'TRUE': return 1;
        case 'FALSE': return 0;
      }
    }
  }
  throw new Error('This formula cannot be calculated.');
}

/* ---- Number pictures (\#) ---- */

function splitSections(picture) {
  const sections = [''];
  let quoted = false;
  for (const ch of picture) {
    if (ch === "'") quoted = !quoted;
    if (ch === ';' && !quoted) sections.push(''); else sections[sections.length - 1] += ch;
  }
  return sections;
}
/** Format a number with a numeric picture (§17.16.4.2): 0 # , . and literals; sections positive;negative;zero. */
export function formatFormulaNumber(value, picture) {
  if (!Number.isFinite(value)) throw new Error('The result is not a number.');
  if (!picture) {
    const rounded = Math.round(value * 100) / 100;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }
  const sections = splitSections(picture);
  const negativeSection = value < 0 && sections.length > 1, zeroSection = value === 0 && sections.length > 2;
  const section = zeroSection ? sections[2] : negativeSection ? sections[1] : sections[0];
  const items = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === "'") { const end = section.indexOf("'", i + 1); items.push({ literal: section.slice(i + 1, end < 0 ? section.length : end) }); i = end < 0 ? section.length : end; }
    else if ('0#,.x'.includes(ch)) items.push({ token: ch === 'x' ? '#' : ch });
    else items.push({ literal: ch });
  }
  const first = items.findIndex(item => item.token && item.token !== ','), last = items.findLastIndex(item => item.token && item.token !== ',');
  if (first < 0) return items.map(item => item.literal ?? '').join('');
  const body = items.slice(first, last + 1), dot = body.findIndex(item => item.token === '.');
  const integer = dot < 0 ? body : body.slice(0, dot), fraction = dot < 0 ? [] : body.slice(dot + 1).filter(item => item.token);
  const decimals = fraction.length, grouping = integer.some(item => item.token === ',');
  const minimum = integer.filter(item => item.token === '0').length;
  let [whole, part = ''] = Math.abs(value).toFixed(decimals).split('.');
  if (whole === '0' && !minimum) whole = '';
  whole = whole.padStart(minimum, '0');
  if (grouping) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Optional fraction places drop their trailing zeros.
  for (let i = fraction.length - 1; i >= 0 && fraction[i].token === '#' && part.endsWith('0'); i--) part = part.slice(0, -1);
  const number = whole + (part ? '.' + part : decimals && fraction.some(f => f.token === '0') ? '.' : '');
  const inner = body.filter(item => item.literal).map(item => item.literal).join('');
  const sign = value < 0 && !negativeSection && Math.abs(value) >= 0.5 * 10 ** -decimals ? '-' : '';
  return sign + items.slice(0, first).map(item => item.literal ?? '').join('') + number + inner + items.slice(last + 1).map(item => item.literal ?? '').join('');
}

/* ---- Fields ---- */

/** Split an = field instruction into its formula and its \# picture. */
export function formulaInstruction(instruction) {
  const text = instruction.trim();
  if (!text.startsWith('=')) throw new Error('A formula starts with an equals sign.');
  const at = text.search(/\\[#*@]/);
  const formula = (at < 0 ? text.slice(1) : text.slice(1, at)).trim();
  let picture = null;
  if (at >= 0) {
    let tokens; try { tokens = fieldInstructionTokens(text.slice(at)); } catch { throw new Error('The number format is not valid.'); }
    for (let i = 0; i < tokens.length; i++) if (tokens[i] === '\\#') picture = tokens[++i] ?? null;
  }
  return { formula, picture };
}
export function buildInstruction(formula, picture) {
  const body = formula.trim().replace(/^=/, '').trim();
  return ` =${body}${picture ? ` \\# "${picture.replace(/(["\\])/g, '\\$1')}"` : ''} `;
}

/** Evaluate a formula for a cell (or outside tables, without cell references). Returns the result text. */
export function evaluateFormula(model, instruction, cellId) {
  const { formula, picture } = formulaInstruction(instruction.startsWith(' ') || instruction.startsWith('=') ? instruction : '=' + instruction);
  const tree = parseFormula(formula);
  const context = cellId ? (() => { const c = cellContext(model.tables, cellId); return { ...c, cellId, paragraphs: model.paragraphs }; })() : null;
  const needsTable = node => node && (['range', 'direction'].includes(node.type) || (node.args || []).some(needsTable) || needsTable(node.left) || needsTable(node.right) || needsTable(node.operand));
  if (!context && needsTable(tree)) throw new Error('Cell references work inside tables.');
  return formatFormulaNumber(evaluate(tree, context), picture);
}
/** Like evaluateFormula, but an error becomes the error text a field shows. */
export function formulaResult(model, instruction, cellId) {
  try { return evaluateFormula(model, instruction, cellId); }
  catch (error) { return error.message.startsWith('!') ? error.message : '!Syntax Error'; }
}

/** The formula a desktop word processor suggests for a cell: SUM above when numbers are above, else SUM to the left. */
export function suggestedFormula(model) {
  const p = model.paragraphs[locate(model.paragraphs, model.selection.focus).index];
  if (!p?.cellId) return '=';
  const context = { ...cellContext(model.tables, p.cellId), cellId: p.cellId, paragraphs: model.paragraphs };
  return directionValues(context, 'ABOVE').length ? '=SUM(ABOVE)' : directionValues(context, 'LEFT').length ? '=SUM(LEFT)' : '=';
}

let order = 3e6;
/** Insert an = field at the selection, with its computed result as the cached text. */
export function insertFormula(model, formula, picture = null) {
  const instruction = buildInstruction(formula, picture);
  const at = model.range[0], p = model.paragraphs[locate(model.paragraphs, at).index];
  const result = evaluateFormula(model, instruction, p.cellId || null);
  const field = newBodyField(instruction, { simple: true });
  model.checkpoint();
  if (model.range[0] !== model.range[1]) model.replace('', { checkpoint: false });
  const start = model.range[0];
  model.replace(result, { checkpoint: false });
  const location = locate(model.paragraphs, start), paragraph = model.paragraphs[location.index];
  (paragraph.fieldMarkers ||= []).push({ type: 'start', field, offset: location.offset, order: order++ }, { type: 'end', field, offset: location.offset + result.length, order: order++ });
  model.hasBodyFields = true;
  bodyFieldRanges(model.paragraphs);
  model.select(start + result.length);
  model.didChange(); return true;
}

/** Results to refresh for every = field: [{ range, text }]. */
export function formulaUpdates(model, ranges = bodyFieldRanges(model.paragraphs)) {
  const text = model.text, changes = [];
  for (const range of ranges) {
    if (range.field.type !== '=' || range.field.locked) continue;
    const value = formulaResult(model, range.field.instruction, range.cellId || null);
    if (text.slice(range.start, range.end) !== value) changes.push({ range, text: value });
  }
  return changes;
}
