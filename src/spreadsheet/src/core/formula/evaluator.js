/**
 * Evaluate a parsed formula against a sheet.
 *
 * ctx = {
 *   currentSheet: string,             name of the sheet the formula lives on
 *   cell: { r, c },                   where it lives
 *   getValue(sheet, r, c),            computed scalar for a cell (sheet may be null)
 *   getRangeValues(ref),              2D array for a range ref (already clamped)
 *   sheetExists(name),
 *   sheetsBetween(a, b),              the sheet names from a to b in tab order (3D spans), or null
 * }
 */

import { FUNCTIONS, EMPTY, err, isError, isRange, scalar, toNumber, toText, toBool, compareValues, realPower } from './functions.js';
import { runtime, isLambda, invoke } from './lambda.js';
import { upperName } from './tokenizer.js';
import { MAX_TEXT } from '../cell.js';
import { MAX_ROW, MAX_COL } from '../refs.js';
import { MIN_NORMAL, flushUnderflow, finalCancellation, hasZeroHighWord } from '../numeric.js';

/** Functions a bare name still calls: they take no arguments, so `=PI` and `=TODAY` mean PI() and TODAY(). */
const ZERO_ARG_FUNCTIONS = new Set(['TRUE', 'FALSE', 'PI', 'NOW', 'TODAY', 'RAND', 'NA', 'ROW', 'COLUMN', 'SHEET', 'SHEETS']);

/**
 * Argument positions where an empty slot still takes the function's default
 * rather than reading as 0, FALSE or "": the `,,` idiom depends on it, as in
 * OFFSET(A1,1,0,,2) keeping the base's height, XLOOKUP(x,a,b,,2) still
 * answering #N/A, SEQUENCE(10,,0) counting from zero, or RATE(n,p,pv,,,)
 * starting from the usual guess. Everywhere else an empty argument is a
 * value: VLOOKUP(x,r,2,) matches exactly and LEFT(t,) is "".
 */
const EMPTY_KEEPS_DEFAULT = {
  OFFSET: [3, 4], ADDRESS: [2, 3], INDIRECT: [1], XLOOKUP: [3, 5], XMATCH: [3], LOOKUP: [2],
  SUMIF: [2], AVERAGEIF: [2], HYPERLINK: [1], SHEETS: [0], SPARKLINE: [1, 2],
  SEQUENCE: [1, 2, 3], RANDARRAY: [0, 1, 2, 3, 4], SORT: [1, 2], FILTER: [2], TAKE: [1, 2], EXPAND: [1, 2],
  TEXTBEFORE: [2], TEXTAFTER: [2], TRIMRANGE: [1, 2], SPLIT: [2, 3], GROUPBY: [4, 5], PIVOTBY: [5, 6, 7, 8],
  REDUCE: [0], SCAN: [0], NUMBERVALUE: [1, 2], COMPLEX: [2], PROB: [3], 'BINOM.DIST.RANGE': [3],
  'BETA.DIST': [4, 5], 'BETA.INV': [3, 4], RATE: [5], IRR: [1], XIRR: [2], DDB: [4], DB: [4], VDB: [5],
  ACCRINT: [4], ACCRINTM: [3], TREND: [1, 2], GROWTH: [1, 2], LINEST: [1], LOGEST: [1],
  NETWORKDAYS: [2], WORKDAY: [2], 'NETWORKDAYS.INTL': [2], 'WORKDAY.INTL': [2], ISBETWEEN: [2, 3], IMAGE: [1, 2], EPOCHTODATE: [1],
  DCOUNT: [1], DCOUNTA: [1], // DCOUNT(db,,criteria) counts every matching record, as documented
};

/** What a built-in receives for an argument left empty at `index`. */
function emptyArgument(name, index) {
  return EMPTY_KEEPS_DEFAULT[name]?.includes(index) ? undefined : EMPTY;
}

function binary(op, a, b, final = false) {
  if (op === '&') {
    const x = toText(a); if (isError(x)) return x;
    const y = toText(b); if (isError(y)) return y;
    // A cell holds at most 32,767 characters (the file format's limit); longer text answers #VALUE! rather than growing without bound.
    if (x.length + y.length > MAX_TEXT) return err('#VALUE!');
    return x + y;
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const x = scalar(a); if (isError(x)) return x;
    const y = scalar(b); if (isError(y)) return y;
    if (op === '=' || op === '<>') {
      // Equality never coerces across types: 1 = "1" is FALSE.
      const same = (x == null ? typeof y !== 'string' && typeof y !== 'boolean' && (y == null || y === 0) : false)
        || (y == null ? typeof x !== 'string' && typeof x !== 'boolean' && (x === 0) : false)
        || (x == null && y == null)
        || (x != null && y != null && typeof x === typeof y && compareValues(x, y) === 0)
        || (x == null && y === '') || (y == null && x === '') || (x == null && y === false) || (y == null && x === false);
      return op === '=' ? same : !same;
    }
    const c = compareValues(x, y);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  }
  const x = toNumber(a); if (isError(x)) return x;
  const y = toNumber(b); if (isError(y)) return y;
  let out;
  switch (op) {
    case '+': out = final ? finalCancellation(x, x + y) : x + y; break;
    case '-': out = final ? finalCancellation(x, x - y) : x - y; break;
    case '*': out = flushUnderflow(x * y); break;
    case '/':
      // A subnormal divisor is treated as zero even when its originating
      // function (for example EXP) retained a nonzero value.
      if (Math.abs(y) < MIN_NORMAL) return err('#DIV/0!');
      out = flushUnderflow(x / y); break;
    case '^': return realPower(x, y, true);
    default: return err('#VALUE!');
  }
  return Number.isFinite(out) ? out : err('#NUM!');
}

/**
 * Apply a scalar operation across ranges: a range against a
 * scalar maps every cell; two ranges pair up cell by cell, a single row or
 * column stretching to match; cells with no partner are #N/A.
 */
/**
 * A bounded reference is read only to a fixed distance past its data. In
 * array arithmetic it must still stand for every cell it names, so the values
 * are padded with blanks to the reference's shape. The rows past what was read
 * are one shared, frozen blank row, so A1:A200000 costs its 200,000 slots once
 * rather than a cell each; whatever is then built from it is charged to the
 * array budget and refused past it, never quietly cut to the window.
 */
function fullValues(v) {
  const ref = v.ref;
  if (!ref || ref.kind !== 'range') return v.values;
  const rows = ref.r2 - ref.r1 + 1;
  const cols = ref.c2 - ref.c1 + 1;
  const vr = v.values.length;
  const vc = v.values[0]?.length || 0;
  if (vr === rows && vc === cols) return v.values;
  const out = new Array(rows);
  const blank = vr < rows ? Object.freeze(new Array(cols).fill(null)) : null;
  for (let r = 0; r < rows; r++) {
    const row = v.values[r];
    if (!row) { out[r] = blank; continue; }
    if (row.length === cols) { out[r] = row; continue; }
    const full = new Array(cols);
    for (let c = 0; c < cols; c++) full[c] = row[c] ?? null;
    out[r] = full;
  }
  return out;
}

/**
 * A whole column (row) is read only to the used area, but stands for every row (column) of
 * what it is paired with: it never stretches like a single row, and its cells past the data
 * are blank rather than missing. An array computed from one — --(A:A>0), N(A:A), A:A*2 — stands
 * for the same rows, and says so with a flag of its own, since it has no address to say it with.
 */
const tall = (v) => isRange(v) && (v.ref ? v.ref.kind === 'cols' : !!v.tall);
const wide = (v) => isRange(v) && (v.ref ? v.ref.kind === 'rows' : !!v.wide);

/**
 * The shape an array stands for, which for a reference is every cell it names rather than the
 * window that was read of it. A computed array carries the extent it was built from (see `shaped`),
 * so a summary sheet's SUMPRODUCT(A:A,--(Data!B:B>0)) pairs two whole columns of different sheets
 * as SUMPRODUCT(A:A,Data!B:B) already does, rather than answering #VALUE! for a shape mismatch.
 */
function extentOf(v) {
  if (!isRange(v)) return null;
  if (v.ref) return [v.ref.r2 - v.ref.r1 + 1, v.ref.c2 - v.ref.c1 + 1];
  if (v.extent) return v.extent;
  return [v.values.length, v.values[0]?.length || 0];
}

/**
 * A computed array with the extent it stands for and the whole-column/row flags of what it was
 * built from. The extent is left off when it is the array's own shape — which is the usual case,
 * and keeps a plain array ({1,2,3}, SEQUENCE(3)) exactly as it was — so only an array standing for
 * more rows or columns than it holds carries one.
 */
function shaped(values, rows, cols, isTall, isWide) {
  const out = { range: true, values };
  const h = values.length;
  const w = values[0]?.length || 0;
  if (rows > h || cols > w) out.extent = [Math.max(rows, h), Math.max(cols, w)];
  if (isTall) out.tall = true;
  if (isWide) out.wide = true;
  return out;
}

function broadcast(a, b, fn) {
  const A = isRange(a) ? fullValues(a) : [[a]];
  const B = isRange(b) ? fullValues(b) : [[b]];
  const ra = A.length;
  const ca = A[0]?.length || 0;
  const rb = B.length;
  const cb = B[0]?.length || 0;
  const tallA = tall(a), tallB = tall(b), wideA = wide(a), wideB = wide(b);
  const oneRowA = ra === 1 && !tallA, oneRowB = rb === 1 && !tallB;
  const oneColA = ca === 1 && !wideA, oneColB = cb === 1 && !wideB;
  const rows = oneRowA ? rb : oneRowB ? ra : Math.max(ra, rb);
  const cols = oneColA ? cb : oneColB ? ca : Math.max(ca, cb);
  // An operator's array counts against the cell's budget as a function's does: SEQUENCE(2000)*SEQUENCE(1,2000)+0+0+… would otherwise build one four-million-cell array per operator.
  if (arrayBudget + rows * cols > ARRAY_BUDGET) { arrayBudget = ARRAY_BUDGET + 1; return err('#NUM!'); }
  arrayBudget += rows * cols;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const x = A[oneRowA ? 0 : r]?.[oneColA ? 0 : c];
      const y = B[oneRowB ? 0 : r]?.[oneColB ? 0 : c];
      const missing = (!oneRowA && !tallA && r >= ra) || (!oneColA && !wideA && c >= ca) || (!oneRowB && !tallB && r >= rb) || (!oneColB && !wideB && c >= cb);
      row.push(missing ? err('#N/A') : fn(x ?? null, y ?? null));
    }
    out.push(row);
  }
  // The extent of the operand whose shape decided each axis: paired with a whole column the result
  // stands for every row of it, however few of them were read.
  const ea = extentOf(a);
  const eb = extentOf(b);
  const axis = (i, oneA, oneB, read) => (oneA ? (eb?.[i] ?? read) : oneB ? (ea?.[i] ?? read) : Math.max(ea?.[i] ?? read, eb?.[i] ?? read));
  return shaped(out, axis(0, oneRowA, oneRowB, rows), axis(1, oneColA, oneColB, cols), tallA || tallB, wideA || wideB);
}

const isArray = (v) => isRange(v) && (v.values.length > 1 || (v.values[0]?.length || 0) > 1);

/**
 * A function's answer with any non-finite number turned into #NUM!, so an
 * overflow or an out-of-calendar date is an error IFERROR and ISERROR can
 * see, never a NaN that COUNT and MAX would take for a number.
 */
/**
 * Arrays a single cell's formula may build in one calculation, in cells. Each
 * generator caps itself, but nested generators multiply, so one cell in a
 * foreign file could otherwise pin the processor for minutes on open.
 */
export const ARRAY_BUDGET = 4_000_000;
// Reference unions can grow combinatorially without reading a single cell.
// Bound their area objects separately from the eventual array of cell values.
const MAX_REFERENCE_AREAS = 100_000;
let arrayBudget = 0;
export function resetArrayBudget() { arrayBudget = 0; }

/**
 * Run one formula's evaluation with a budget of its own and hand the caller's back afterwards. A
 * cell read by way of another, or settled while a sheet's spills are worked out, is then charged
 * neither for what its reader built nor for what the cells before it did, so its value does not
 * depend on which cell the grid happened to ask for first.
 */
export function withArrayBudget(fn) {
  const outer = arrayBudget;
  arrayBudget = 0;
  try { return fn(); } finally { arrayBudget = outer; }
}

function finiteResult(v) {
  if (v === EMPTY) return null; // a function that hands an empty argument back yields a blank
  if (typeof v === 'number') return Number.isFinite(v) ? v : err('#NUM!');
  const computed = isRange(v) && !v.ref && !v.areas?.every(area => area.ref);
  if (computed) {
    arrayBudget += v.values.length * (v.values[0]?.length || 0);
    if (arrayBudget > ARRAY_BUDGET) return err('#NUM!');
  }
  const unfit = (x) => (typeof x === 'number' && !Number.isFinite(x)) || x === EMPTY;
  if (computed && v.values.some((row) => row.some(unfit))) {
    return { ...v, values: v.values.map((row) => row.map((x) => (x === EMPTY ? null : unfit(x) ? err('#NUM!') : x))) };
  }
  return v;
}
const NOT_TAKEN = Symbol('not taken');

function mapRange(v, fn) {
  const values = fullValues(v);
  // The array a unary operator builds counts against the cell's budget as a function's does.
  if (arrayBudget + values.length * (values[0]?.length || 0) > ARRAY_BUDGET) { arrayBudget = ARRAY_BUDGET + 1; return err('#NUM!'); }
  const out = values.map((row) => row.map((x) => fn(x ?? null)));
  const extent = extentOf(v);
  return shaped(out, extent?.[0] ?? out.length, extent?.[1] ?? (out[0]?.length || 0), tall(v), wide(v));
}

/**
 * A single-value function over arrays, as SUM(LEN(A1:A3)) or ROUND(B1:B3/2,0) needs: the
 * function runs once per cell, with the pairing rules of the operators — a lone value or a
 * single row or column stretches to the array's shape, and cells with no partner are #N/A.
 */
function liftCall(def, args, ctx) {
  const grids = args.map((a) => (isRange(a) ? fullValues(a) : null));
  const talls = args.map(tall);
  const wides = args.map(wide);
  let rows = 1;
  let cols = 1;
  // and the extent each axis stands for, taken from the arguments that decided it (see broadcast).
  let rowsExtent = 1;
  let colsExtent = 1;
  grids.forEach((g, k) => {
    if (!g) return;
    const r = g.length;
    const c = g[0]?.length || 0;
    const extent = extentOf(args[k]);
    if (r !== 1 || talls[k]) { rows = rows === 1 ? r : Math.max(rows, r); rowsExtent = Math.max(rowsExtent, extent?.[0] ?? r); }
    if (c !== 1 || wides[k]) { cols = cols === 1 ? c : Math.max(cols, c); colsExtent = Math.max(colsExtent, extent?.[1] ?? c); }
  });
  if (arrayBudget + rows * cols > ARRAY_BUDGET) { arrayBudget = ARRAY_BUDGET + 1; return err('#NUM!'); }
  const out = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const scalars = new Array(args.length);
      let cell;
      for (let k = 0; k < args.length && cell === undefined; k++) {
        const g = grids[k];
        if (!g) { scalars[k] = args[k]; continue; }
        const gr = g.length;
        const gc = g[0]?.length || 0;
        const oneRow = gr === 1 && !talls[k], oneCol = gc === 1 && !wides[k];
        if ((!oneRow && !talls[k] && r >= gr) || (!oneCol && !wides[k] && c >= gc)) { cell = err('#N/A'); break; }
        const v = g[oneRow ? 0 : r]?.[oneCol ? 0 : c] ?? null;
        // Errors in direct arguments stop the call, as for a scalar call, unless the function inspects them.
        if (!def.tolerant && isError(v)) cell = v;
        scalars[k] = v;
      }
      row[c] = cell === undefined ? scalar(def.fn(scalars, ctx)) : cell;
    }
    out[r] = row;
  }
  return shaped(out, rowsExtent, colsExtent, talls.some(Boolean), wides.some(Boolean));
}

/**
 * A reference argument with every cell it names: a bounded reference is read only a fixed
 * distance past its data, but the arrays computed from it (B1:B5000>1, LEN(A1:A5000)) have its
 * full shape, so a function taking both (FILTER, SUMPRODUCT, SORTBY) must see the same shape in
 * each, and one sizing its answer by the reference (SORT, TAKE, TOCOL) must see every cell.
 * Whole columns and rows keep their read window, and so does a reference of more cells than
 * the array budget allows: it is handed over as read, its extent beside it, as an address
 * consumer sees it.
 */
function fullRange(v) {
  const ref = v.ref;
  if (ref?.kind === 'range' && (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1) > ARRAY_BUDGET) return v;
  const values = fullValues(v);
  if (values === v.values) return v;
  arrayBudget += values.length * (values[0]?.length || 0);
  return { ...v, values };
}

/** A built-in's answer for evaluated arguments: cell by cell when a single-value function meets an array. */
function callNative(def, args, ctx) {
  if (def.lift && args.some(isArray)) return liftCall(def, args, ctx);
  // Address consumers (SUM, INDEX, ROW) read the reference itself, and count or skip the cells past the values read.
  if (!def.refArgs) {
    args = args.map((a) => (isRange(a) && a.ref ? fullRange(a) : a));
    if (arrayBudget > ARRAY_BUDGET) return err('#NUM!');
  }
  return def.fn(args, ctx);
}

/**
 * A reference as the evaluator reads it: missing sheets are #REF!, and A1#
 * becomes the range the array formula at A1 spills over (#REF! when A1 does
 * not spill).
 */
function resolveRef(ref, ctx) {
  if (ref.sheet && !ctx.sheetExists(ref.sheet)) return err('#REF!');
  if (!ref.spill) return ref;
  const range = ctx.getSpillRange ? ctx.getSpillRange(ref) : null;
  if (!range) return err('#REF!');
  const single = range.r1 === range.r2 && range.c1 === range.c2;
  return { ...ref, spill: false, kind: single ? 'cell' : 'range', r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 };
}

/** Named and structured references retain their address even for one cell. */
function referenceValue(source, ctx) {
  let ref = resolveRef(source, ctx);
  if (isError(ref)) return ref;
  if (ctx.referenceMode && !ref.sheetEnd) {
    ref = { ...ref, sheet: ref.sheet || ctx.currentSheet };
    let values;
    return { range: true, get values() {
      return values ??= ref.kind === 'cell'
        ? [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]] : ctx.getRangeValues(ref);
    }, ref };
  }
  if (ref.kind === 'cell' && !ref.sheetEnd) {
    return { range: true, values: [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]], ref };
  }
  return evaluate({ type: 'ref', ref }, ctx);
}

/** Preserve the areas' addresses without reading cells outside an operation's result. */
function referenceUnion(areas) {
  // Consumers such as SUBTOTAL read individual areas, so guard those reads as
  // well as flattening the union. Address-only consumers never spend this budget.
  areas = areas.map(area => {
    let values;
    return { range: true, ref: area.ref, get values() {
      if (values) return values;
      if (arrayBudget > ARRAY_BUDGET) return values = [[err('#NUM!')]];
      const grid = area.values;
      for (const row of grid) arrayBudget += row.length;
      return values = arrayBudget > ARRAY_BUDGET ? [[err('#NUM!')]] : grid;
    } };
  });
  let values;
  return { range: true, areas, get values() {
    if (values) return values;
    const grids = areas.map(area => area.values);
    return values = arrayBudget > ARRAY_BUDGET ? [[err('#NUM!')]]
      : grids.flatMap(grid => grid.flatMap(row => row.map(value => [value ?? null])));
  } };
}

function intersectReferences(a, b, ctx) {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const parts = value => isRange(value) && !value.sheetSpan ? value.areas || [value] : null;
  const left = parts(a), right = parts(b);
  if (!left || !right || !left.every(area => area.ref && !area.ref.sheetEnd) || !right.every(area => area.ref && !area.ref.sheetEnd)) return err('#VALUE!');
  const sheet = left[0]?.ref.sheet || ctx.currentSheet;
  const sameSheet = area => String(area.ref.sheet || ctx.currentSheet).toLowerCase() === String(sheet).toLowerCase();
  if (!left.every(sameSheet) || !right.every(sameSheet)) return err('#VALUE!');
  // Charge non-overlapping pairs too: a chain of sparse unions must not repeat
  // an otherwise unbounded amount of unsuccessful intersection work.
  arrayBudget += left.length * right.length;
  if (arrayBudget > ARRAY_BUDGET) return err('#NUM!');
  const areas = [];
  for (const x of left) for (const y of right) {
    const r1 = Math.max(x.ref.r1, y.ref.r1), r2 = Math.min(x.ref.r2, y.ref.r2);
    const c1 = Math.max(x.ref.c1, y.ref.c1), c2 = Math.min(x.ref.c2, y.ref.c2);
    if (r1 > r2 || c1 > c2) continue;
    if (areas.length >= MAX_REFERENCE_AREAS) return err('#NUM!');
    const kind = r1 === r2 && c1 === c2 ? 'cell'
      : r1 === 0 && r2 === MAX_ROW ? 'cols' : c1 === 0 && c2 === MAX_COL ? 'rows' : 'range';
    areas.push(referenceValue({ sheet, kind, r1, c1, r2, c2, absR1: false, absC1: false, absR2: false, absC2: false }, ctx));
  }
  if (!areas.length) return err('#NULL!');
  return areas.length === 1 ? areas[0] : referenceUnion(areas);
}

/** A binding or returned reference carries its address into the next scope. */
export function evaluateBinding(node, ctx) {
  return node.type === 'ref' ? referenceValue(node.ref, ctx) : evaluate(node, ctx);
}

/** Run deferred built-ins consistently for direct calls and function values. */
/** The value of a lazily evaluated argument once it has been chosen: an omitted one counts as 0. */
export function chosen(thunk) {
  return thunk.omitted ? 0 : thunk();
}

function evaluateLazy(name, def, thunks, ctx) {
  if (name === 'IF' && thunks.length) {
    // IF over a range of conditions picks a value for every cell.
    const cond = thunks[0]();
    if (isArray(cond)) {
      const yes = thunks[1] ? chosen(thunks[1]) : true;
      const no = thunks[2] ? chosen(thunks[2]) : false;
      const pickYes = broadcast(cond, yes, (c, y) => { const b = toBool(c); return isError(b) ? b : b ? y : NOT_TAKEN; });
      if (isError(pickYes)) return pickYes;
      return broadcast(pickYes, no, (y, n) => (y === NOT_TAKEN ? n : y));
    }
    thunks[0] = () => cond;
  }
  if (name === 'IFS' && thunks.length) {
    // IFS over an array of conditions picks a value for every cell, as IF does. The scalar
    // conditions ahead of the first array are tested in turn, so an early TRUE still answers
    // without evaluating what follows; from the first array on, every remaining pair is
    // evaluated once and broadcast, each cell taking the value of its first TRUE condition.
    for (let i = 0; i + 1 < thunks.length; i += 2) {
      const cond = thunks[i]();
      if (!isArray(cond)) {
        thunks[i] = () => cond;
        const b = toBool(cond);
        if (isError(b) || b) break;
        continue;
      }
      let picked = null;
      for (let j = i; j + 1 < thunks.length; j += 2) {
        const c = j === i ? cond : thunks[j]();
        const value = chosen(thunks[j + 1]);
        const taken = broadcast(c, value, (x, y) => { const b = toBool(x); return isError(b) ? b : b ? y : NOT_TAKEN; });
        if (isError(taken)) return taken;
        picked = picked ? broadcast(picked, taken, (p, t) => (p === NOT_TAKEN ? t : p)) : taken;
        if (isError(picked)) return picked;
      }
      return { range: true, values: picked.values.map((row) => row.map((v) => (v === NOT_TAKEN ? err('#N/A') : v))) };
    }
  }
  if (name === 'SWITCH' && thunks.length) {
    // SWITCH over an array of expressions answers a value for every cell: the cases and
    // their results are evaluated once and broadcast, each cell taking its first matching case.
    const target = thunks[0]();
    if (isArray(target)) {
      let picked = broadcast(target, null, (t) => (isError(t) ? t : NOT_TAKEN));
      if (isError(picked)) return picked;
      let i = 1;
      for (; i + 1 < thunks.length; i += 2) {
        const candidate = thunks[i]();
        const value = chosen(thunks[i + 1]);
        const matched = broadcast(target, candidate, (t, c) => (isError(t) ? t : isError(c) ? c : def.matches(t, c)));
        if (isError(matched)) return matched;
        const taken = broadcast(matched, value, (m, v) => (m === true ? v : m === false ? NOT_TAKEN : m));
        if (isError(taken)) return taken;
        picked = broadcast(picked, taken, (p, t) => (p === NOT_TAKEN ? t : p));
        if (isError(picked)) return picked;
      }
      const fallback = i < thunks.length ? chosen(thunks[i]) : err('#N/A');
      return broadcast(picked, fallback, (p, f) => (p === NOT_TAKEN ? f : p));
    }
    thunks[0] = () => target;
  }
  if ((name === 'IFERROR' || name === 'IFNA') && thunks.length) {
    const value = thunks[0]();
    if (isRange(value)) {
      const catches = (v) => isError(v) && (name === 'IFERROR' || v.error === '#N/A');
      // Keep successful arrays (and their references) intact, without
      // evaluating a fallback that no element needs.
      if (!value.values.some((row) => row.some(catches))) return value;
      // IFERROR(x,): a replacement left empty is 0 when an element needs it, as for a single value.
      const fallback = thunks[1] ? chosen(thunks[1]) : '';
      return broadcast(value, fallback, (v, replacement) => catches(v) ? replacement : v);
    }
    thunks[0] = () => value;
  }
  return def.fn(thunks, ctx);
}

function invokeExpression(fn, nodes, ctx) {
  if (fn.native?.lazy) {
    const def = fn.native;
    const thunks = nodes.map((arg) => () => def.refArgs ? evaluateBinding(arg, ctx) : evaluate(arg, ctx));
    return evaluateLazy(fn.name, def, thunks, ctx);
  }
  // A LAMBDA parameter left empty is omitted (ISOMITTED sees it); a built-in
  // called through a name reads the slot exactly as a direct call would.
  const empty = fn.native ? (i) => emptyArgument(fn.name, i) : () => undefined;
  const result = invoke(fn, nodes.map((arg, i) => arg.type === 'empty' ? empty(i) : evaluateBinding(arg, ctx)));
  return fn.native ? finiteResult(result) : result;
}

/** Evaluate a complete formula (also a defined name or a LAMBDA body). */
export function evaluateFormula(node, ctx) {
  return evaluate(node, ctx, true);
}

export function evaluate(node, ctx, final = false) {
  switch (node.type) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'err': return err(node.value);
    case 'empty': return null;

    case 'array': {
      // An array constant is a range with no address; elements are scalars.
      const values = [];
      for (const row of node.rows) {
        const out = [];
        for (const item of row) {
          const v = scalar(evaluate(item, ctx));
          out.push(v === undefined ? null : v);
        }
        values.push(out);
      }
      return { range: true, values };
    }

    case 'ref': {
      if (ctx.referenceMode && !node.ref.sheetEnd) return referenceValue(node.ref, ctx);
      const ref = resolveRef(node.ref, ctx);
      if (isError(ref)) return ref;
      if (ref.sheetEnd) {
        // Sheet1:Sheet3!A1: the same cells on every sheet of the span, as
        // one column of values with the per-sheet areas kept (like a union).
        const names = ctx.sheetsBetween?.(ref.sheet, ref.sheetEnd);
        if (!names) return err('#REF!');
        const areas = names.filter(name => ctx.isWorksheet?.(name) !== false).map((name) => {
          const one = { ...ref, sheet: name };
          delete one.sheetEnd;
          if (ctx.referenceMode) return referenceValue(one, ctx);
          return ref.kind === 'cell'
            ? { range: true, values: [[ctx.getValue(name, ref.r1, ref.c1) ?? null]], ref: one }
            : { range: true, values: ctx.getRangeValues(one), ref: one };
        });
        if (ctx.referenceMode) {
          const value = referenceUnion(areas);
          value.sheetSpan = names;
          return value;
        }
        return { range: true, values: areas.flatMap((a) => a.values.flatMap((row) => row.map((x) => [x ?? null]))), areas, sheetSpan: names };
      }
      if (ref.kind === 'cell') return ctx.getValue(ref.sheet, ref.r1, ref.c1);
      return { range: true, values: ctx.getRangeValues(ref), ref };
    }

    case 'union': {
      // (A1:A3, C1:C3): every part must be a reference. The result holds
      // all their cells as one column, so SUM, COUNT, MAX, COUNTIF, ... read
      // them together, and keeps the areas for AREAS and INDEX's area_num.
      const areas = [];
      for (const part of node.parts) {
        // (#REF!,#REF!) is what a union becomes once its cells are deleted: it reads #REF!, as a lone #REF!A1 does.
        if (part.type === 'err') return evaluate(part, ctx);
        if (!['ref', 'tref', 'union', 'range', 'intersection', 'call', 'apply'].includes(part.type)) return err('#VALUE!');
        const v = evaluate(part, ctx);
        if (isError(v)) return v;
        if (ctx.referenceMode) {
          if (!isRange(v) || v.sheetSpan || !(v.areas || [v]).every(area => area.ref && !area.ref.sheetEnd)) return err('#VALUE!');
          areas.push(...(v.areas || [v]));
          continue;
        }
        if (!isRange(v)) {
          if (part.type !== 'ref') return err('#VALUE!');
          const ref = resolveRef(part.ref, ctx);
          areas.push({ range: true, values: [[v ?? null]], ref: isError(ref) ? undefined : ref });
          continue;
        }
        if (v.areas) areas.push(...v.areas); else areas.push(v);
      }
      if (ctx.referenceMode) return referenceUnion(areas);
      const values = areas.flatMap((a) => a.values.flatMap((row) => row.map((x) => [x ?? null])));
      return { range: true, values, areas };
    }

    case 'intersection': {
      const refCtx = { ...ctx, referenceMode: true };
      const rights = [];
      let first = node;
      while (first.type === 'intersection') { rights.push(first.right); first = first.left; }
      let value = evaluateBinding(first, refCtx);
      for (let i = rights.length - 1; i >= 0 && !isError(value); i--) value = intersectReferences(value, evaluateBinding(rights[i], refCtx), refCtx);
      return value;
    }

    case 'range': {
      // A1:INDEX(A1:A5,3), OFFSET(A1,1,0):A5: the block spanning two references on one sheet,
      // with its own address, so it feeds SUM as a range and spills from a cell.
      const refCtx = { ...ctx, referenceMode: true };
      const a = evaluateBinding(node.left, refCtx); if (isError(a)) return a;
      const b = evaluateBinding(node.right, refCtx); if (isError(b)) return b;
      if (!isRange(a) || !a.ref || a.ref.sheetEnd || !isRange(b) || !b.ref || b.ref.sheetEnd) return err('#VALUE!');
      const sheetA = a.ref.sheet || ctx.currentSheet;
      const sheetB = b.ref.sheet || ctx.currentSheet;
      if (String(sheetA).toLowerCase() !== String(sheetB).toLowerCase()) return err('#VALUE!');
      const r1 = Math.min(a.ref.r1, b.ref.r1), r2 = Math.max(a.ref.r2, b.ref.r2);
      const c1 = Math.min(a.ref.c1, b.ref.c1), c2 = Math.max(a.ref.c2, b.ref.c2);
      const single = r1 === r2 && c1 === c2;
      const ref = { sheet: a.ref.sheet || b.ref.sheet || null, kind: single ? 'cell' : 'range', r1, c1, r2, c2, absR1: false, absC1: false, absR2: false, absC2: false };
      return referenceValue(ref, ctx);
    }

    case 'apply': {
      // The expression must produce a LAMBDA; call it with the arguments.
      const fn = evaluate(node.fn, ctx);
      if (isError(fn)) return fn;
      if (!isLambda(fn)) return err('#VALUE!');
      return invokeExpression(fn, node.args, ctx);
    }

    case 'tref': {
      // Table1[Amount]: the workbook turns the table and column names into cells.
      const ref = ctx.resolveTableRef ? ctx.resolveTableRef(node.table, node.spec) : err('#NAME?');
      if (isError(ref)) return ref;
      return referenceValue(ref, ctx);
    }

    case 'unary': {
      const v = evaluate(node.arg, ctx);
      if (node.op === '@') return intersect(v, ctx);
      if (node.op === '+') return v; // =+A1 hands the value on unchanged, text and booleans included
      const neg = (x) => { const n = toNumber(x); return isError(n) || hasZeroHighWord(n) ? n : -n; };
      return finiteResult(isArray(v) ? mapRange(v, neg) : neg(v));
    }

    case 'percent': {
      const v = evaluate(node.arg, ctx);
      const pct = (x) => { const n = toNumber(x); return isError(n) ? n : flushUnderflow(n / 100); };
      return finiteResult(isArray(v) ? mapRange(v, pct) : pct(v));
    }

    case 'binary': {
      // A chain of operators parses left-deep, so 1+1+… with thousands of terms (legal within the
      // formula length limit) would recurse once per term. The left spine is walked as a list instead, so the
      // depth of the recursion follows the nesting of the formula, not the number of its operands.
      const spine = [];
      let leftmost = node;
      while (leftmost.type === 'binary') { spine.push(leftmost); leftmost = leftmost.left; }
      let value = evaluate(leftmost, ctx);
      for (let i = spine.length - 1; i >= 0; i--) {
        const { op, right } = spine[i];
        const b = evaluate(right, ctx);
        const correct = final && i === 0 && !node.parenthesized;
        value = isArray(value) || isArray(b) ? broadcast(value, b, (x, y) => binary(op, x, y, correct)) : binary(op, value, b, correct);
      }
      return value;
    }

    case 'call': {
      // Once a cell's array budget is spent, every further call in it fails at once rather than
      // building more arrays that would be thrown away.
      if (arrayBudget > ARRAY_BUDGET) return err('#NUM!');
      const nameCtx = node.sheet ? ctx.nameContext?.(node.sheet) : ctx;
      if (!nameCtx) return err('#REF!');
      // Names bound by LET or a LAMBDA parameter shadow everything else.
      const local = node.sheet ? undefined : ctx.locals?.get(node.name);
      if (local !== undefined) {
        if (node.bare) return local;
        if (isLambda(local)) return invokeExpression(local, node.args, ctx);
        // LET(PI,5,PI()): a local that is no LAMBDA leaves the call form to the built-in of that name.
        if (!FUNCTIONS[node.name]) return err('#VALUE!');
      }
      if (!node.sheet && !node.bare && node.name === 'LET') return evalLet(node, ctx);
      if (!node.sheet && !node.bare && node.name === 'LAMBDA') return makeLambda(node, ctx);
      // ISOMITTED(param): was this optional LAMBDA parameter left out by the caller?
      if (!node.sheet && !node.bare && node.name === 'ISOMITTED') {
        const name = bindingName(node.args[0]);
        if (!name || node.args.length !== 1) return err('#VALUE!');
        return !!ctx.omitted?.has(name);
      }
      const def = node.sheet ? undefined : FUNCTIONS[node.name];
      // A bare name can share a built-in's spelling. Parentheses select
      // the built-in call; without them, an existing defined name wins.
      if (node.bare) {
        const ref = nameCtx.getNamedRef?.(node.name);
        if (ref) return referenceValue(ref, nameCtx);
      }
      const named = node.bare || !def ? nameCtx.getNamedFormula?.(node.name) : null;
      if (named) {
        // A name that stands for a value must not expand through itself; a name that defines a
        // LAMBDA may call itself, and the lambda's own depth limit bounds that recursion.
        const definesLambda = named?.type === 'call' && named.name === 'LAMBDA';
        const depth = definesLambda ? (ctx.nameDepth || 0) : (ctx.nameDepth || 0) + 1;
        if (depth > 64) return err('#CYCLE!');
        // A workbook definition is outside the caller's lexical scope.
        // Retain its calling cell, but do not capture LET/LAMBDA bindings.
        const value = evaluateFormula(named, { ...nameCtx, locals: undefined, omitted: undefined, nameDepth: depth });
        if (node.bare) return value;
        // Called with arguments: the name must hold a LAMBDA.
        if (!isLambda(value)) return isError(value) ? value : err('#VALUE!');
        return invokeExpression(value, node.args, ctx);
      }
      if (!node.sheet && node.bare && ctx.resolveTableRef) {
        const ref = ctx.resolveTableRef(node.name, '');
        if (ref && !isError(ref)) return referenceValue(ref, ctx);
        if (isError(ref) && ref.error !== '#NAME?') return ref;
      }
      if (!def) return err('#NAME?');
      // A function named without parentheses is passed along as a function
      // (GROUPBY(..., SUM), BYROW(range, MAX)); the few that take no
      // arguments (PI, TODAY, RAND) are still called.
      if (node.bare && !ZERO_ARG_FUNCTIONS.has(node.name)) return { lambda: true, native: def, name: node.name, params: [], ctx };
      if (def.lazy) {
        // Reference-producing choices must keep a selected cell's address,
        // while leaving unselected arguments unevaluated.
        const thunks = node.args.map((arg) => {
          const thunk = () => def.refArgs ? evaluateBinding(arg, ctx) : evaluate(arg, ctx);
          // IF(x,,5): an argument left empty is 0 when it is the value chosen.
          if (arg.type === 'empty') thunk.omitted = true;
          return thunk;
        });
        return evaluateLazy(node.name, def, thunks, ctx);
      }
      const args = [];
      for (let i = 0; i < node.args.length; i++) {
        const arg = node.args[i];
        // LEFT(A1,): an argument left empty is the value 0, FALSE or "" to the
        // function, not a missing one, except where the default is what the
        // idiom relies on (OFFSET's height and width, XLOOKUP's fallback).
        if (arg.type === 'empty') { args.push(emptyArgument(node.name, i)); continue; }
        if (def.refArgs && arg.type === 'ref' && !arg.ref.sheetEnd) {
          if (ctx.referenceMode) { args.push(referenceValue(arg.ref, ctx)); continue; }
          // ROW(B7) wants the address, not the value the cell holds.
          const ref = resolveRef(arg.ref, ctx);
          if (isError(ref)) return ref;
          // Address-only consumers must not calculate the referenced cells:
          // those cells may themselves depend on this formula. Other reference
          // functions can still read the values when they need them.
          let values;
          args.push({ range: true, get values() { return values ??= ctx.getRangeValues(ref); }, ref });
          continue;
        }
        const v = evaluate(arg, ctx);
        // Errors in direct arguments stop the call, unless the function
        // exists to inspect them (ISERROR, TYPE, N).
        if (!def.tolerant && isError(v)) return v;
        args.push(v);
      }
      // A range result stays a range so it can feed another function
      // (SUM(INDIRECT(...))); the cell that owns the formula collapses it.
      return finiteResult(callNative(def, args, ctx));
    }

    default:
      return err('#VALUE!');
  }
}

/**
 * A name in LET or LAMBDA must be a bare word that is not a cell reference.
 * Function names may be shadowed (a parameter called `n` or `row` is fine).
 */
function bindingName(node) {
  return node && node.type === 'call' && node.bare && !node.sheet ? node.name : null;
}

/** A LAMBDA parameter: `x`, or `[x]` for an optional one → { name, optional } or null. */
export function paramSpec(node) {
  const plain = bindingName(node);
  if (plain) return { name: plain, optional: false };
  if (node && node.type === 'tref' && node.table === null && /^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*$/u.test(node.spec.trim())) return { name: upperName(node.spec.trim()), optional: true };
  return null;
}

/**
 * Implicit intersection (the @ operator): from a range, the single value on
 * the formula's row (for a column) or column (for a row); a lone cell is
 * itself; anything wider is #VALUE!. The row (or column) is found within the
 * reference's own extent rather than the window read of it: a bounded
 * reference is read only so far past its data and a whole column only to its
 * used area, so a row of the reference beyond what was read is a blank cell,
 * not an error.
 */
function intersect(v, ctx) {
  if (!isRange(v)) return v;
  const ref = v.ref;
  // An array with no address (@SEQUENCE(3), @{1,2,3}) yields its top-left value.
  if (!ref) return v.values[0]?.[0] ?? null;
  const rows = Math.max(ref.r2 - ref.r1 + 1, v.values.length);
  const cols = Math.max(ref.c2 - ref.c1 + 1, v.values[0]?.length || 0);
  if (rows === 1 && cols === 1) return v.values[0]?.[0] ?? null;
  const cell = ctx.cell;
  if (!cell) return err('#VALUE!');
  if (cols === 1) {
    const i = cell.r - ref.r1;
    return i >= 0 && i < rows ? (v.values[i]?.[0] ?? null) : err('#VALUE!');
  }
  if (rows === 1) {
    const j = cell.c - ref.c1;
    return j >= 0 && j < cols ? (v.values[0]?.[j] ?? null) : err('#VALUE!');
  }
  return err('#VALUE!');
}

/**
 * LET(name1, value1, [name2, value2, ...], result): values are evaluated in
 * order, each seeing the names before it; the result sees them all. The
 * bindings live in one Map that a LAMBDA created here captures, so a
 * lambda can call itself by its LET name.
 */
function evalLet(node, ctx) {
  const args = node.args;
  if (args.length < 3 || args.length % 2 === 0) return err('#VALUE!');
  const locals = new Map(ctx.locals || []);
  const scope = { ...ctx, locals };
  for (let i = 0; i + 1 < args.length - 1; i += 2) {
    const name = bindingName(args[i]);
    if (!name) return err('#VALUE!');
    const v = args[i + 1].type === 'empty' ? null : evaluateBinding(args[i + 1], scope);
    locals.set(name, v);
  }
  return evaluateBinding(args[args.length - 1], scope);
}

/** LAMBDA(param1, ..., body): a callable value; the body runs when it is called. */
function makeLambda(node, ctx) {
  const args = node.args;
  if (!args.length) return err('#VALUE!');
  const params = [];
  const optional = [];
  for (let i = 0; i < args.length - 1; i++) {
    const spec = paramSpec(args[i]);
    if (!spec) return err('#VALUE!');
    params.push(spec.name);
    if (spec.optional) optional.push(spec.name);
  }
  return { lambda: true, params, optional, body: args[args.length - 1], ctx };
}

runtime.evaluate = (node, ctx) => node.type === 'ref' ? referenceValue(node.ref, ctx) : evaluateFormula(node, ctx);
runtime.callLazy = evaluateLazy;
runtime.callNative = callNative;

/**
 * True when the AST calls a function whose result changes without input changing. The answer rests
 * on the formula's text alone, so it is remembered on the tree, which is kept with the cell: the
 * book is asked this of every formula in it once a minute, to see whether the clock has moved on.
 */
export function isVolatile(node) {
  if (!node || typeof node !== 'object') return false;
  if (node._vol === undefined) node._vol = volatileNode(node);
  return node._vol;
}

function volatileNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'call') {
    if (FUNCTIONS[node.name]?.volatile) return true;
    return node.args.some(volatileNode);
  }
  if (node.type === 'binary') return volatileNode(node.left) || volatileNode(node.right);
  if (node.type === 'apply') return volatileNode(node.fn) || node.args.some(volatileNode);
  if (node.type === 'unary' || node.type === 'percent') return volatileNode(node.arg);
  if (node.type === 'array') return node.rows.some((row) => row.some(volatileNode));
  if (node.type === 'union') return node.parts.some(volatileNode);
  if (node.type === 'intersection') {
    let leftmost = node;
    while (leftmost.type === 'intersection') { if (volatileNode(leftmost.right)) return true; leftmost = leftmost.left; }
    return volatileNode(leftmost);
  }
  if (node.type === 'range') return volatileNode(node.left) || volatileNode(node.right);
  return false;
}
