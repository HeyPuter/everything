/**
 * Data ▸ Solver: find the values of some cells (the variable cells) that make a formula cell (the
 * objective) as large or as small as it can be, or equal to a value, while other cells meet constraints.
 *
 * A model is kept per sheet in hidden, sheet-scoped defined names (solver_opt, solver_adj, solver_lhs1 …),
 * the convention spreadsheet files use for it, so a model saved here opens elsewhere and back again. The
 * dialog edits the model as text (references relative to the sheet); prepareSolver() turns that into the
 * numeric problem the engines solve, with an evaluate(x) that writes trial values into the variable cells
 * and reads the objective and constraint cells through the workbook's own recalculation:
 *
 *   Simplex LP      solver-lp.js   linear models; coefficients measured from the sheet, then checked
 *   GRG Nonlinear   solver-nlp.js  smooth nonlinear models, from the current values (or many starts)
 *   Evolutionary    solver-evo.js  non-smooth models, inside bounds
 *
 * Integer, binary and all-different constraints go through branch and bound (solver-lp.js) over the LP or
 * GRG relaxation; the Evolutionary method handles them in its population. Every engine is a generator
 * that yields between evaluations: solveSolver() runs one to the end, runSolver() spreads it over frames.
 * The trial values are written straight into the cells and taken out again around every slice of work,
 * so nothing outside the solve ever sees them. applySolverResult() then keeps (or restores) the values,
 * saves the model and adds the chosen reports, as one undo step.
 */
import { cellKey, colName } from './cell.js';
import { mapFormulaRefs, sameSheetName } from './refs.js';
import { isError } from './formula/functions.js';
import { solveLP, sensitivity, branchAndBound } from './solver-lp.js';
import { solveNLP, solveNLPMultistart, seededRandom, violations } from './solver-nlp.js';
import { solveEvolutionary } from './solver-evo.js';

export const RELATIONS = [['<=', '<='], ['=', '='], ['>=', '>='], ['int', 'int'], ['bin', 'bin'], ['dif', 'dif']];
const REL_CODE = { '<=': 1, '=': 2, '>=': 3, int: 4, bin: 5, dif: 6 };
const CODE_REL = { 1: '<=', 2: '=', 3: '>=', 4: 'int', 5: 'bin', 6: 'dif' };
const REL_WORD = { int: 'integer', bin: 'binary', dif: 'AllDifferent' };
export const ENGINES = [['grg', 'GRG Nonlinear'], ['simplex', 'Simplex LP'], ['evolutionary', 'Evolutionary']];
const ENGINE_CODE = { grg: 1, simplex: 2, evolutionary: 3 };
const CODE_ENGINE = { 1: 'grg', 2: 'simplex', 3: 'evolutionary' };
const UNLIMITED = 2147483647;
/** The most variable cells a model may have: the dense methods grow with the square of the count. */
export const MAX_VARIABLES = 1000;

export const DEFAULT_OPTIONS = Object.freeze({
  precision: 1e-6, scaling: true, ignoreInteger: false, integerOptimality: 1,
  maxTime: null, maxIterations: null, maxSubproblems: null, maxFeasible: null,
  convergence: 1e-4, derivatives: 'forward', multistart: false, population: 100, seed: 0, requireBounds: true,
  mutationRate: 0.075, maxTimeNoImprove: 30,
});

/** A model with nothing in it: the dialog's starting point. */
export function emptyModel(objective = '') {
  return { objective, goal: 'max', value: 0, variables: '', constraints: [], nonNegative: true, engine: 'grg', options: { ...DEFAULT_OPTIONS } };
}

/* ---------- References as text ---------- */

const sheetNameOf = (wb, sheetId) => wb.sheet(sheetId)?.name || '';

/** Every reference in `text` given the sheet's name, so a stored name stays anchored to it. */
function qualify(wb, sheetId, text) {
  const name = sheetNameOf(wb, sheetId);
  return mapFormulaRefs(String(text), (ref) => ({ ...ref, sheet: ref.sheet || name }));
}

/** References on the sheet itself without the sheet's name, as the dialog shows them. */
function unqualify(wb, sheetId, text) {
  const name = sheetNameOf(wb, sheetId);
  return mapFormulaRefs(String(text), (ref) => (sameSheetName(ref.sheet, name) && !ref.sheetEnd ? { ...ref, sheet: null } : ref));
}

/** "$B$2:$B$4,$D$2" (or names of ranges) as ranges on the sheet; null when a part is not one. */
export function parseRanges(wb, sheetId, text) {
  const parts = String(text ?? '').split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = [];
  for (const part of parts) {
    const found = wb.rangeFromText(sheetId, part.replace(/^=/, ''));
    if (!found || found.sheetId !== sheetId) return null;
    out.push(found.range);
  }
  return out;
}

const cellsOf = (ranges) => {
  const out = [];
  const seen = new Set();
  for (const g of ranges) for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
    const key = cellKey(r, c);
    if (!seen.has(key)) { seen.add(key); out.push({ r, c }); }
  }
  return out;
};
const abs = ({ r, c }) => `$${colName(c)}$${r + 1}`;
const rangeText = (g) => (g.r1 === g.r2 && g.c1 === g.c2 ? abs({ r: g.r1, c: g.c1 }) : `${abs({ r: g.r1, c: g.c1 })}:${abs({ r: g.r2, c: g.c2 })}`);

/* ---------- The model kept in defined names ---------- */

const isSolverName = (n, sheetName) => /^solver_/i.test(n.name) && sameSheetName(n.sheet || '', sheetName);
const optNumber = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const flag = (on) => (on ? '1' : '2');

/** The names that hold a model, for a sheet. */
export function solverNameEntries(wb, sheetId, model) {
  const sheet = sheetNameOf(wb, sheetId);
  const o = { ...DEFAULT_OPTIONS, ...(model.options || {}) };
  const limit = (v) => String(v == null ? UNLIMITED : v);
  const list = [];
  const put = (name, ref) => list.push({ name, ref: String(ref), hidden: true, sheet });
  if (model.objective) put('solver_opt', qualify(wb, sheetId, model.objective));
  put('solver_typ', model.goal === 'min' ? 2 : model.goal === 'value' ? 3 : 1);
  put('solver_val', Number(model.value) || 0);
  if (model.variables) put('solver_adj', qualify(wb, sheetId, model.variables));
  put('solver_num', model.constraints.length);
  model.constraints.forEach((k, i) => {
    put(`solver_lhs${i + 1}`, qualify(wb, sheetId, k.lhs));
    put(`solver_rel${i + 1}`, REL_CODE[k.rel] || 1);
    const word = REL_WORD[k.rel];
    const rhs = word ? `"${word}"` : String(k.rhs).trim().replace(/^=/, '');
    put(`solver_rhs${i + 1}`, word || optNumber(rhs) != null ? rhs : qualify(wb, sheetId, rhs));
  });
  put('solver_eng', ENGINE_CODE[model.engine] || 1);
  put('solver_neg', flag(model.nonNegative !== false));
  put('solver_pre', o.precision);
  put('solver_scl', flag(o.scaling));
  put('solver_rlx', flag(o.ignoreInteger));
  put('solver_tol', o.integerOptimality / 100);
  put('solver_tim', limit(o.maxTime));
  put('solver_itr', limit(o.maxIterations));
  put('solver_nod', limit(o.maxSubproblems));
  put('solver_mip', limit(o.maxFeasible));
  put('solver_cvg', o.convergence);
  put('solver_drv', o.derivatives === 'central' ? 2 : 1);
  put('solver_msl', flag(o.multistart));
  put('solver_ssz', o.population);
  put('solver_rsd', o.seed);
  put('solver_rbv', flag(o.requireBounds));
  put('solver_mrt', o.mutationRate);
  put('solver_mni', o.maxTimeNoImprove);
  put('solver_est', 1);
  put('solver_nwt', 1);
  put('solver_sho', 2);
  put('solver_ver', 3);
  return list;
}

/** Does the sheet have a model saved? */
export function hasSolverModel(wb, sheetId) {
  const sheet = sheetNameOf(wb, sheetId);
  return (wb.names || []).some((n) => isSolverName(n, sheet) && /^solver_(opt|adj)$/i.test(n.name));
}

/** The sheet's saved model, or an empty one. */
export function readSolverModel(wb, sheetId) {
  const sheet = sheetNameOf(wb, sheetId);
  const get = new Map((wb.names || []).filter((n) => isSolverName(n, sheet)).map((n) => [n.name.toLowerCase(), String(n.ref)]));
  const model = emptyModel();
  if (!get.size) return model;
  const text = (key) => get.get(key);
  const num = (key) => optNumber(text(key));
  const on = (key, fallback) => (text(key) == null ? fallback : num(key) === 1);
  const lim = (key) => { const v = num(key); return v == null || v >= UNLIMITED ? null : v; };
  if (text('solver_opt')) model.objective = unqualify(wb, sheetId, text('solver_opt'));
  model.goal = { 1: 'max', 2: 'min', 3: 'value' }[num('solver_typ')] || 'max';
  model.value = num('solver_val') ?? 0;
  if (text('solver_adj')) model.variables = unqualify(wb, sheetId, text('solver_adj'));
  const count = num('solver_num') || 0;
  for (let i = 1; i <= count; i++) {
    const lhs = text(`solver_lhs${i}`);
    const rel = CODE_REL[num(`solver_rel${i}`)];
    if (!lhs || !rel) continue;
    let rhs = text(`solver_rhs${i}`) ?? '';
    if (REL_WORD[rel]) rhs = REL_WORD[rel];
    else if (optNumber(rhs) == null) rhs = unqualify(wb, sheetId, rhs);
    model.constraints.push({ lhs: unqualify(wb, sheetId, lhs), rel, rhs });
  }
  model.engine = CODE_ENGINE[num('solver_eng')] || 'grg';
  model.nonNegative = on('solver_neg', true);
  const o = model.options;
  o.precision = num('solver_pre') ?? o.precision;
  o.scaling = on('solver_scl', o.scaling);
  o.ignoreInteger = on('solver_rlx', o.ignoreInteger);
  if (num('solver_tol') != null) o.integerOptimality = num('solver_tol') * 100;
  o.maxTime = lim('solver_tim');
  o.maxIterations = lim('solver_itr');
  o.maxSubproblems = lim('solver_nod');
  o.maxFeasible = lim('solver_mip');
  o.convergence = num('solver_cvg') ?? o.convergence;
  o.derivatives = num('solver_drv') === 2 ? 'central' : 'forward';
  o.multistart = on('solver_msl', o.multistart);
  o.population = num('solver_ssz') ?? o.population;
  o.seed = num('solver_rsd') ?? o.seed;
  o.requireBounds = on('solver_rbv', o.requireBounds);
  o.mutationRate = num('solver_mrt') ?? o.mutationRate;
  o.maxTimeNoImprove = num('solver_mni') ?? o.maxTimeNoImprove;
  return model;
}

/** The workbook's names with this sheet's model replaced by `model` (none when it is null). */
function namesWithModel(wb, sheetId, model) {
  const sheet = sheetNameOf(wb, sheetId);
  const kept = (wb.names || []).filter((n) => !isSolverName(n, sheet));
  const next = model ? [...kept, ...solverNameEntries(wb, sheetId, model)] : kept;
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

/** Save the model into the sheet's names as one undo step; nothing is recorded when it is unchanged. */
export function saveSolverModel(wb, sheetId, model, label = 'Solver model') {
  const next = namesWithModel(wb, sheetId, model);
  const same = next.length === wb.names.length && next.every((n, i) => wb.names[i] && n.name === wb.names[i].name && n.ref === wb.names[i].ref && (n.sheet || null) === (wb.names[i].sheet || null));
  if (same) return false;
  wb._setNames(next, label);
  return true;
}

/* ---------- Load and save a model in cells ---------- */

const SUM_FORM = /^SUMPRODUCT\(--\((.+)\)\)=ROWS\(([^()]+)\)\*COLUMNS\(([^()]+)\)$/i;

/** The formulas that describe a model in a column of cells (the last one, the options, is text). */
export function modelToCells(model) {
  const out = [];
  const obj = String(model.objective).replace(/^=/, '');
  out.push(model.goal === 'min' ? `=MIN(${obj})` : model.goal === 'value' ? `=${obj}=${Number(model.value) || 0}` : `=MAX(${obj})`);
  out.push(`=COUNT(${String(model.variables).replace(/^=/, '')})`);
  for (const k of model.constraints) {
    const L = String(k.lhs).replace(/^=/, '');
    const single = !L.includes(':') && !L.includes(',');
    const rhs = String(k.rhs).replace(/^=/, '');
    const all = (cond) => `=SUMPRODUCT(--(${cond}))=ROWS(${L})*COLUMNS(${L})`;
    if (k.rel === 'int') out.push(single ? `=INT(${L})=${L}` : all(`INT(${L})=${L}`));
    else if (k.rel === 'bin') out.push(single ? `=OR(${L}=0,${L}=1)` : all(`(${L}=0)+(${L}=1)`));
    else if (k.rel === 'dif') out.push(`=SUMPRODUCT(1/COUNTIF(${L},${L}))=ROWS(${L})*COLUMNS(${L})`);
    else out.push(single ? `=${L}${k.rel}${rhs}` : all(`${L}${k.rel}${rhs}`));
  }
  const o = { ...DEFAULT_OPTIONS, ...(model.options || {}) };
  const pairs = { engine: model.engine, nonnegative: model.nonNegative !== false ? 1 : 0, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? '' : typeof v === 'boolean' ? (v ? 1 : 0) : v])) };
  out.push(`Solver model: ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ')}`);
  return out;
}

/** A model read back from cells modelToCells wrote (a column or a row of them). Returns { model } or { error }. */
export function modelFromCells(wb, sheetId, range) {
  const cells = [];
  for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) cells.push(wb.getCell(sheetId, r, c));
  const formulas = cells.map((cell) => (cell?.f != null ? String(cell.f).replace(/^=/, '') : null));
  const model = emptyModel();
  const first = formulas[0];
  if (!first) return { error: 'The first cell must hold the objective, as Save Model writes it (=MAX(…), =MIN(…) or =cell=value)' };
  let m;
  if ((m = /^(MAX|MIN)\(([^()]+)\)$/i.exec(first))) { model.goal = m[1].toUpperCase() === 'MAX' ? 'max' : 'min'; model.objective = m[2]; }
  else if ((m = /^([^=<>]+)=(-?[\d.eE+-]+)$/.exec(first))) { model.goal = 'value'; model.objective = m[1]; model.value = Number(m[2]); }
  else return { error: 'The first cell must hold the objective, as Save Model writes it (=MAX(…), =MIN(…) or =cell=value)' };
  if (!formulas[1] || !(m = /^COUNT\((.+)\)$/i.exec(formulas[1]))) return { error: 'The second cell must count the variable cells, as =COUNT(…)' };
  model.variables = m[1];
  let i = 2;
  for (; i < formulas.length && formulas[i]; i++) {
    const f = formulas[i];
    let k = null;
    if ((m = /^SUMPRODUCT\(1\/COUNTIF\(([^,()]+),\1\)\)=ROWS\(\1\)\*COLUMNS\(\1\)$/i.exec(f))) k = { lhs: m[1], rel: 'dif', rhs: 'AllDifferent' };
    else if ((m = SUM_FORM.exec(f))) {
      const inner = m[1], L = m[2];
      let n;
      if ((n = /^INT\((.+)\)=\1$/i.exec(inner))) k = { lhs: L, rel: 'int', rhs: 'integer' };
      else if ((n = /^\((.+)=0\)\+\(\1=1\)$/.exec(inner))) k = { lhs: L, rel: 'bin', rhs: 'binary' };
      else if ((n = /^(.+?)(<=|>=|=)(.+)$/.exec(inner)) && n[1] === L) k = { lhs: L, rel: n[2], rhs: n[3] };
    } else if ((m = /^INT\(([^()]+)\)=\1$/i.exec(f))) k = { lhs: m[1], rel: 'int', rhs: 'integer' };
    else if ((m = /^OR\(([^=,()]+)=0,\1=1\)$/i.exec(f))) k = { lhs: m[1], rel: 'bin', rhs: 'binary' };
    else if ((m = /^([^<>=]+?)(<=|>=|=)(.+)$/.exec(f))) k = { lhs: m[1], rel: m[2], rhs: m[3] };
    if (!k) return { error: `The constraint in cell ${i + 1} of the range is not one Save Model writes` };
    model.constraints.push(k);
  }
  const optionsCell = cells[i] && typeof cells[i].v === 'string' ? cells[i].v : (i + 1 < cells.length && typeof cells[i + 1]?.v === 'string' ? cells[i + 1].v : null);
  if (optionsCell && /^Solver model:/i.test(optionsCell)) {
    for (const part of optionsCell.replace(/^Solver model:/i, '').split(';')) {
      const [key, raw] = part.split('=').map((t) => t?.trim());
      if (!key) continue;
      if (key === 'engine') { if (ENGINE_CODE[raw]) model.engine = raw; continue; }
      if (key === 'nonnegative') { model.nonNegative = raw !== '0'; continue; }
      if (!(key in DEFAULT_OPTIONS)) continue;
      const d = DEFAULT_OPTIONS[key];
      model.options[key] = typeof d === 'boolean' ? raw === '1' : key === 'derivatives' ? (raw === 'central' ? 'central' : 'forward') : raw === '' ? null : optNumber(raw) ?? d;
    }
  }
  for (const key of ['objective', 'variables']) model[key] = unqualify(wb, sheetId, model[key]);
  for (const k of model.constraints) { k.lhs = unqualify(wb, sheetId, k.lhs); if (!REL_WORD[k.rel] && optNumber(k.rhs) == null) k.rhs = unqualify(wb, sheetId, k.rhs); }
  return { model };
}

/** Write the model into cells from (r, c) down, as one undo step. Returns how many cells it took. */
export function saveModelToCells(wb, sheetId, r, c, model) {
  const lines = modelToCells(model);
  const entries = lines.map((text, i) => ({ r: r + i, c, cell: text.startsWith('=') ? { v: null, f: text.slice(1) } : { v: text, f: null } }));
  wb.setCells(sheetId, entries, 'Save Solver model');
  return lines.length;
}

/* ---------- Preparing a solve ---------- */

const numeric = (v) => (typeof v === 'number' ? v : v == null || v === '' ? 0 : typeof v === 'boolean' ? (v ? 1 : 0) : NaN);

/**
 * Check a model and set up the problem. Returns { error, field } (field: 'objective' | 'variables' |
 * 'constraint' | 'value') or the prepared problem.
 */
export function prepareSolver(wb, sheetId, model, { now = () => Date.now() } = {}) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return { error: 'Solver works on a worksheet' };
  const options = { ...DEFAULT_OPTIONS, ...(model.options || {}) };
  const objRanges = parseRanges(wb, sheetId, model.objective);
  if (!objRanges || objRanges.length !== 1 || objRanges[0].r1 !== objRanges[0].r2 || objRanges[0].c1 !== objRanges[0].c2) {
    return { error: 'Enter one cell on this sheet for the objective, like $B$10', field: 'objective' };
  }
  const objective = { r: objRanges[0].r1, c: objRanges[0].c1 };
  if (model.goal === 'value' && !Number.isFinite(Number(model.value))) return { error: 'Enter the number the objective should reach', field: 'value' };
  const varRanges = parseRanges(wb, sheetId, model.variables);
  if (!varRanges) return { error: 'Enter the variable cells as ranges on this sheet, like $B$2:$B$5 or $B$2,$D$2', field: 'variables' };
  const vars = cellsOf(varRanges);
  if (vars.length > MAX_VARIABLES) return { error: `A model can have at most ${MAX_VARIABLES} variable cells`, field: 'variables' };
  const varIndex = new Map(vars.map((p, j) => [cellKey(p.r, p.c), j]));
  for (const p of vars) {
    const cell = sheet.cells.get(cellKey(p.r, p.c));
    if (cell?.f != null) return { error: `The variable cell ${abs(p)} holds a formula; variable cells must hold numbers or be blank`, field: 'variables' };
    if (cell?.v != null && typeof cell.v !== 'number') return { error: `The variable cell ${abs(p)} holds text; variable cells must hold numbers or be blank`, field: 'variables' };
    if (cell?.v == null && wb.spillAt(sheetId, p.r, p.c)) return { error: `The variable cell ${abs(p)} shows part of an array formula's result`, field: 'variables' };
  }
  if (wb._gridLocked?.(sheet) && vars.some((p) => wb.lockedAt(sheetId, p.r, p.c))) return { error: 'The sheet is protected and some variable cells are locked', field: 'variables' };
  const objCell = sheet.cells.get(cellKey(objective.r, objective.c));
  if (!objCell || objCell.f == null) return { error: 'The objective cell must hold a formula that depends on the variable cells', field: 'objective' };

  const n = vars.length;
  const lb = new Array(n).fill(-Infinity), ub = new Array(n).fill(Infinity);
  const integer = new Array(n).fill(false), binary = new Array(n).fill(false);
  const groups = [];
  const rows = []; // every expanded constraint, bounds included, for the reports
  const ignoreInteger = !!options.ignoreInteger;
  for (const [index, k] of model.constraints.entries()) {
    const lhsRanges = parseRanges(wb, sheetId, k.lhs);
    if (!lhsRanges || lhsRanges.length !== 1) return { error: `Constraint ${index + 1}: enter its cell reference as one range on this sheet`, field: 'constraint', index };
    const L = lhsRanges[0];
    const cells = cellsOf([L]);
    if (REL_WORD[k.rel]) {
      const js = cells.map((p) => varIndex.get(cellKey(p.r, p.c)));
      if (js.some((j) => j == null)) return { error: `Constraint ${index + 1}: ${k.rel === 'dif' ? 'all-different' : k.rel === 'bin' ? 'binary' : 'integer'} constraints apply to variable cells only`, field: 'constraint', index };
      cells.forEach((p, i) => rows.push({ constraint: index, lhs: p, rel: k.rel, rhs: { kind: 'word' }, j: js[i], bound: true }));
      if (ignoreInteger) continue;
      if (k.rel === 'dif') {
        groups.push(js);
        for (const j of js) { integer[j] = true; lb[j] = Math.max(lb[j], 1); ub[j] = Math.min(ub[j], js.length); }
      } else {
        for (const j of js) {
          integer[j] = true;
          if (k.rel === 'bin') { binary[j] = true; lb[j] = Math.max(lb[j], 0); ub[j] = Math.min(ub[j], 1); }
        }
      }
      continue;
    }
    // The right side: a number, a reference (one cell, or a range the size of the left), or a formula.
    const text = String(k.rhs ?? '').trim().replace(/^=/, '');
    if (!text) return { error: `Constraint ${index + 1}: enter a number, a reference or a formula for the constraint`, field: 'constraint', index };
    let rhsOf;
    const constant = optNumber(text);
    if (constant != null) rhsOf = () => ({ kind: 'const', v: constant });
    else {
      const ranges = parseRanges(wb, sheetId, text);
      const found = ranges?.length === 1 ? { sheetId, range: ranges[0] } : (!text.includes(',') ? wb.rangeFromText(sheetId, text) : null);
      if (found) {
        const R = found.range;
        const h = R.r2 - R.r1 + 1, w = R.c2 - R.c1 + 1;
        const one = h === 1 && w === 1;
        if (!one && (h !== L.r2 - L.r1 + 1 || w !== L.c2 - L.c1 + 1)) return { error: `Constraint ${index + 1}: the right side must be one cell or a range the size of the left side`, field: 'constraint', index };
        rhsOf = (p) => ({ kind: 'cell', sheetId: found.sheetId, r: one ? R.r1 : R.r1 + (p.r - L.r1), c: one ? R.c1 : R.c1 + (p.c - L.c1) });
      } else {
        const probe = wb.evaluateText(sheetId, L.r1, L.c1, text);
        if (isError(probe) && ['#NAME?', '#REF!'].includes(probe.error)) return { error: `Constraint ${index + 1}: the right side is not a number, a reference or a formula`, field: 'constraint', index };
        rhsOf = () => ({ kind: 'formula', text, r: L.r1, c: L.c1 });
      }
    }
    for (const p of cells) {
      const rhs = rhsOf(p);
      const row = { constraint: index, lhs: p, rel: k.rel, rhs, j: varIndex.get(cellKey(p.r, p.c)), bound: false };
      // A variable cell against a constant (or a cell holding a plain number) is a bound on that variable.
      if (row.j != null) {
        let v = null;
        if (rhs.kind === 'const') v = rhs.v;
        else if (rhs.kind === 'cell' && !(rhs.sheetId === sheetId && varIndex.has(cellKey(rhs.r, rhs.c)))) {
          const cell = wb.sheet(rhs.sheetId)?.cells.get(cellKey(rhs.r, rhs.c));
          if (!cell || (cell.f == null && (cell.v == null || typeof cell.v === 'number'))) v = typeof cell?.v === 'number' ? cell.v : 0;
        }
        if (v != null) {
          row.bound = true; row.value = v;
          if (k.rel !== '>=') ub[row.j] = Math.min(ub[row.j], v);
          if (k.rel !== '<=') lb[row.j] = Math.max(lb[row.j], v);
        }
      }
      rows.push(row);
    }
  }
  // Assume nonnegative: a variable with no lower bound of its own gets zero.
  if (model.nonNegative !== false) for (let j = 0; j < n; j++) if (lb[j] === -Infinity) lb[j] = 0;

  const original = vars.map((p) => sheet.cells.get(cellKey(p.r, p.c)));
  const x0 = original.map((cell) => (typeof cell?.v === 'number' ? cell.v : 0));
  let applied = false;
  const write = (x) => {
    vars.forEach((p, j) => {
      const old = original[j];
      sheet.cells.set(cellKey(p.r, p.c), { v: x[j], f: null, ...(old?.s ? { s: old.s } : {}) });
    });
    applied = true;
    wb._invalidate();
  };
  const restore = () => {
    if (!applied) return;
    vars.forEach((p, j) => { const old = original[j]; if (old) sheet.cells.set(cellKey(p.r, p.c), old); else sheet.cells.delete(cellKey(p.r, p.c)); });
    applied = false;
    wb._invalidate();
  };
  const readRhs = (rhs) => {
    if (rhs.kind === 'const') return rhs.v;
    if (rhs.kind === 'cell') return numeric(wb.getValue(rhs.sheetId, rhs.r, rhs.c));
    if (rhs.kind === 'formula') { const v = wb.evaluateText(sheetId, rhs.r, rhs.c, rhs.text); return numeric(v && typeof v === 'object' && v.range ? v.values?.[0]?.[0] : v); }
    return 0;
  };
  /** The sheet at x: the objective's value and each row's two sides. */
  const evaluateAt = (x) => {
    write(x);
    const f = numeric(wb.getValue(sheetId, objective.r, objective.c));
    const lhs = rows.map((row) => (row.rhs.kind === 'word' ? x[row.j] : numeric(wb.getValue(sheetId, row.lhs.r, row.lhs.c))));
    const rhs = rows.map((row) => (row.rhs.kind === 'word' ? x[row.j] : readRhs(row.rhs)));
    return { f, lhs, rhs };
  };
  const objectiveBefore = numeric(wb.getValue(sheetId, objective.r, objective.c));
  return {
    wb, sheetId, model, options, objective, vars, rows, lb, ub, integer, binary, groups, x0, objectiveBefore,
    evaluateAt, restore, now, start: null, cancelled: false,
    hasInteger: integer.some(Boolean),
  };
}

/* ---------- Solving ---------- */

const MESSAGES = {
  optimal: 'Solver found a solution. All constraints and optimality conditions are met.',
  optimalInteger: 'Solver found an integer solution within the integer optimality tolerance. All constraints are met.',
  localOptimal: 'Solver found a locally optimal solution. All constraints and optimality conditions are met.',
  converged: 'Solver converged on the current solution. All constraints are met.',
  evoConverged: 'Solver converged on this solution, which is likely near the best one. All constraints are met.',
  noImprovement: 'Solver could not improve on the current solution. All constraints are met.',
  infeasible: 'Solver could not find a solution that meets all the constraints.',
  unbounded: 'The objective can grow without limit. Add constraints or bounds on the variable cells.',
  notLinear: 'This model is not linear, so Simplex LP cannot solve it. Choose GRG Nonlinear or Evolutionary.',
  stopped: 'Solving was stopped. The best solution found so far is shown.',
  timeLimit: 'Solving reached the time limit. The best solution found so far is shown.',
  iterationLimit: 'Solving reached the iteration limit. The best solution found so far is shown.',
  nodeLimit: 'Solving reached the limit on subproblems. The best solution found so far is shown.',
  feasibleLimit: 'Solving reached the limit on integer solutions. The best solution found so far is shown.',
  error: 'A trial value made a formula in the model fail (an error, or text where a number was expected).',
  needsBounds: 'The Evolutionary method needs a lower and an upper bound on every variable cell. Add them as constraints, or clear Require Bounds on Variables in Options.',
  notNumber: 'The objective cell does not hold a number.',
};

/** Statuses after which the solution found can be kept. */
const KEEPABLE = new Set(['optimal', 'optimalInteger', 'localOptimal', 'converged', 'evoConverged', 'noImprovement', 'stopped', 'timeLimit', 'iterationLimit', 'nodeLimit', 'feasibleLimit']);
/** Statuses that are a solution meeting the model, not a stop on the way. */
const SOLVED = new Set(['optimal', 'optimalInteger', 'localOptimal', 'converged', 'evoConverged', 'noImprovement']);

export const solverMessage = (status) => MESSAGES[status] || MESSAGES.error;

/**
 * Solve: a generator yielding progress ({ phase, evals, iterations, subproblems, objective }) and returning
 * the result { status, ok, solved, message, x, objective, rowsAt, iterations, subproblems, evals, seconds,
 * engine, sensitivity, linear }.
 */
export function* solverSteps(p) {
  const o = p.options;
  p.start = p.now();
  const sense = p.model.goal === 'min' ? 1 : p.model.goal === 'max' ? -1 : 0;
  const target = Number(p.model.value) || 0;
  const active = p.rows.map((row, i) => i).filter((i) => !p.rows[i].bound);
  const stop = () => {
    if (p.cancelled) return 'stopped';
    if (o.maxTime != null && (p.now() - p.start) / 1000 >= o.maxTime) return 'timeLimit';
    return null;
  };
  let evals = 0, lastObjective = null;
  const at0 = p.evaluateAt(p.x0);
  const rowScale = active.map((i) => Math.max(1, Math.abs(at0.rhs[i]) || 0));
  if (sense === 0) rowScale.push(Math.max(1, Math.abs(target)));
  // The engines' view: f to minimize and g[i] (rel) 0 for every row that is not a bound.
  const problemRows = active.map((i, k) => ({ rel: p.rows[i].rel, scale: rowScale[k] }));
  if (sense === 0) problemRows.push({ rel: '=', scale: rowScale.at(-1) });
  const evaluate = (x) => {
    evals++;
    const at = p.evaluateAt(x);
    lastObjective = at.f;
    const g = active.map((i) => at.lhs[i] - at.rhs[i]);
    if (sense === 0) g.push(at.f - target);
    return { f: sense === 0 ? 0 : sense * at.f, g };
  };
  if (!Number.isFinite(at0.f)) return finish({ status: 'notNumber' });
  const problem = { n: p.vars.length, x0: p.x0.slice(), lb: p.lb.slice(), ub: p.ub.slice(), rows: problemRows, evaluate };
  const progress = (extra = {}) => ({ evals, objective: lastObjective, ...extra });
  const intTol = 1e-6;
  const gap = Math.max(0, (o.integerOptimality ?? 0) / 100);
  const lim = (v) => (v == null || !(v > 0) ? Infinity : v);
  let result;

  if (p.model.engine === 'simplex') {
    const n = problem.n;
    // Measure the coefficients: the change in every function for a unit step in each variable.
    const base = p.x0.map((v) => (Number.isFinite(v) ? v : 0));
    const F0 = evaluate(base);
    yield progress({ phase: 'linear' });
    if (!F0.g.every(Number.isFinite)) return finish({ status: 'error' });
    const cols = [];
    for (let j = 0; j < n; j++) {
      const x = base.slice(); x[j] += 1;
      const F = evaluate(x);
      if (!Number.isFinite(F.f) || !F.g.every(Number.isFinite)) return finish({ status: 'error' });
      cols.push({ f: F.f - F0.f, g: F.g.map((v, i) => v - F0.g[i]) });
      yield progress({ phase: 'linear' });
      const reason = stop(); if (reason) return finish({ status: reason });
    }
    // Linearity: predicted and recalculated values must agree at points away from the base.
    const rand = seededRandom(9157);
    for (let t = 0; t < 2; t++) {
      const delta = base.map((v) => (rand() * 2 - 1) * Math.max(1, Math.abs(v)));
      const F = evaluate(base.map((v, j) => v + delta[j]));
      yield progress({ phase: 'linear' });
      const check = (actual, start, key, i) => {
        let predicted = start, spread = Math.abs(start);
        for (let j = 0; j < n; j++) { const d = (key === 'f' ? cols[j].f : cols[j].g[i]) * delta[j]; predicted += d; spread += Math.abs(d); }
        return Number.isFinite(actual) && Math.abs(actual - predicted) <= 1e-6 * Math.max(1, spread, Math.abs(actual));
      };
      if (!check(F.f, F0.f, 'f') || !F.g.every((v, i) => check(v, F0.g[i], 'g', i))) return finish({ status: 'notLinear' });
    }
    const lp = {
      c: cols.map((col) => col.f),
      A: problemRows.map((_, i) => cols.map((col) => col.g[i])),
      rel: problemRows.map((row) => row.rel),
      b: problemRows.map((_, i) => cols.reduce((s, col, j) => s + col.g[i] * base[j], 0) - F0.g[i]),
    };
    const fConst = F0.f - cols.reduce((s, col, j) => s + col.f * base[j], 0);
    const maxIter = lim(o.maxIterations) === Infinity ? 100000 : o.maxIterations;
    const linear = { cols, base, F0, lp, fConst };
    if (p.hasInteger) {
      let iterations = 0;
      const relax = function* (lo, hi) {
        const r = solveLP({ ...lp, lb: lo, ub: hi }, { maxIter });
        iterations += r.iterations;
        yield progress({ phase: 'branch' });
        return r;
      };
      const r = yield* branchAndBound(relax, p.lb, p.ub, { integer: p.integer, groups: p.groups, intTol, gap, maxNodes: lim(o.maxSubproblems), maxFeasible: lim(o.maxFeasible), stop });
      result = { status: r.status === 'optimal' ? (gap > 0 && r.subproblems > 1 ? 'optimalInteger' : 'optimal') : r.status, x: r.x, subproblems: r.subproblems, iterations, linear };
    } else {
      const r = solveLP({ ...lp, lb: p.lb, ub: p.ub }, { maxIter });
      yield progress({ phase: 'simplex', iterations: r.iterations });
      result = { status: r.status, x: r.x, iterations: r.iterations, linear, lpResult: r };
    }
  } else if (p.model.engine === 'evolutionary') {
    const r = yield* solveEvolutionary({ ...problem, integer: p.integer, groups: p.groups }, {
      precision: o.precision, convergence: o.convergence, population: o.population, mutationRate: o.mutationRate,
      seed: o.seed, maxIter: lim(o.maxIterations), maxTimeNoImprove: o.maxTimeNoImprove ?? 30, requireBounds: o.requireBounds !== false, stop, now: p.now,
    });
    result = { status: r.status === 'converged' ? 'evoConverged' : r.status, x: r.x, iterations: r.iterations };
  } else {
    const nlpOptions = { precision: o.precision, convergence: o.convergence, maxIter: lim(o.maxIterations) === Infinity ? 5000 : o.maxIterations,
      central: o.derivatives === 'central', autoScale: o.scaling !== false, stop, starts: Math.max(2, Math.min(1000, Math.round(o.population || 100))), seed: o.seed };
    const local = (pr) => (o.multistart && !p.hasInteger ? solveNLPMultistart(pr, nlpOptions) : solveNLP(pr, nlpOptions));
    if (p.hasInteger) {
      let iterations = 0;
      const relax = function* (lo, hi) {
        const r = yield* local({ ...problem, lb: lo, ub: hi, x0: problem.x0.map((v, j) => Math.min(hi[j], Math.max(lo[j], v))) });
        iterations += r.iterations || 0;
        return { ...r, status: r.status === 'converged' ? 'optimal' : r.status };
      };
      const r = yield* branchAndBound(relax, p.lb, p.ub, { integer: p.integer, groups: p.groups, intTol: 1e-5, gap, maxNodes: lim(o.maxSubproblems), maxFeasible: lim(o.maxFeasible), stop });
      // Each subproblem's solution is only locally optimal, so the integer one is reported as such.
      result = { status: r.status === 'optimal' ? (gap > 0 ? 'optimalInteger' : 'localOptimal') : r.status, x: r.x, subproblems: r.subproblems, iterations };
    } else {
      const r = yield* local(problem);
      const status = r.status === 'optimal' ? 'localOptimal' : r.status;
      result = { status, x: r.x, iterations: r.iterations, nlp: r };
    }
  }
  return finish(result);

  function finish(r) {
    const x = r.x ? r.x.map((v, j) => (p.integer[j] ? Math.round(v) : Math.abs(v) < 1e-12 ? 0 : v)) : null;
    let status = r.status;
    let at = null;
    if (x) {
      at = p.evaluateAt(x);
      evals++;
      // A solution that failed the sheet's own check is not one.
      const ok = Number.isFinite(at.f) && feasibleRows(p, at, x);
      if (!ok && SOLVED.has(status)) status = Number.isFinite(at.f) ? 'infeasible' : 'error';
    }
    p.restore();
    const seconds = (p.now() - p.start) / 1000;
    const keepable = !!x && KEEPABLE.has(status);
    return {
      status, message: solverMessage(status), ok: keepable, solved: SOLVED.has(status), x: keepable ? x : null,
      objective: at ? at.f : NaN, rowsAt: at, engine: p.model.engine, iterations: r.iterations ?? 0, subproblems: r.subproblems ?? 0,
      evals, seconds, linear: r.linear || null, lpResult: r.lpResult || null, nlp: r.nlp || null,
    };
  }
}

/** Does the sheet at a point meet every row (bounds, integers and all-different groups included)? */
function feasibleRows(p, at, x) {
  const tol = p.options.precision ?? 1e-6;
  for (const [i, row] of p.rows.entries()) {
    if (row.rhs.kind === 'word') {
      const v = x[row.j];
      if (row.rel === 'int' && !p.options.ignoreInteger && Math.abs(v - Math.round(v)) > 1e-6) return false;
      if (row.rel === 'bin' && !p.options.ignoreInteger && v !== 0 && v !== 1) return false;
      continue;
    }
    const [viol] = violations([{ rel: row.rel }], [at.lhs[i] - at.rhs[i]]);
    if (!(viol <= tol * Math.max(1, Math.abs(at.rhs[i])) * 10)) return false;
  }
  if (!p.options.ignoreInteger) for (const g of p.groups) if (new Set(g.map((j) => x[j])).size !== g.length) return false;
  for (let j = 0; j < x.length; j++) if (x[j] < p.lb[j] - tol * Math.max(1, Math.abs(p.lb[j])) || x[j] > p.ub[j] + tol * Math.max(1, Math.abs(p.ub[j]))) return false;
  return true;
}

/** Run a solve to the end at once (tests, and models small enough not to need the frames). */
export function solveSolver(p) {
  const steps = solverSteps(p);
  try {
    let s;
    while (!(s = steps.next()).done);
    return s.value;
  } finally { p.restore(); }
}

/**
 * Run a solve a slice at a time, giving the page its frames back in between (the trial values are taken
 * out of the cells during the pauses). `onProgress` hears the latest progress after each slice; set
 * `p.cancelled` to stop. Resolves with the result.
 */
export async function runSolver(p, { onProgress = null, sliceMs = 40, pause = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}) {
  const steps = solverSteps(p);
  try {
    for (;;) {
      const begin = Date.now();
      let s, last = null;
      do {
        s = steps.next();
        if (!s.done) last = s.value;
      } while (!s.done && Date.now() - begin < sliceMs);
      if (s.done) return s.value;
      p.restore();
      if (last) onProgress?.(last);
      await pause();
    }
  } finally { p.restore(); }
}

/* ---------- Results and reports ---------- */

const NUMBER_KEYS = ['fmt', 'dec', 'cur', 'code', 'dateStyle', 'sec', 'group'];
/** The number format a cell shows its value with, as a style to give a report cell. */
function numberStyle(wb, sheetId, r, c) {
  const s = wb.styleAt?.(sheetId, r, c);
  if (!s) return null;
  const out = {};
  for (const k of NUMBER_KEYS) if (s[k] != null) out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

/** A label for a cell: the nearest text to its left and above it, as a report's Name column shows. */
export function cellLabel(wb, sheetId, r, c) {
  const text = (rr, cc) => { const v = wb.getValue(sheetId, rr, cc); return typeof v === 'string' && v.trim() ? v.trim() : null; };
  let left = null, top = null;
  for (let cc = c - 1; cc >= 0 && !left; cc--) left = text(r, cc);
  for (let rr = r - 1; rr >= 0 && !top; rr--) top = text(rr, c);
  return [left, top].filter(Boolean).join(' ');
}

const ENGINE_LABEL = Object.fromEntries(ENGINES);
const big = (v) => (v === Infinity || v > 1e30 ? 1e30 : v === -Infinity || v < -1e30 ? -1e30 : v);
const relText = (rel) => (rel === 'int' ? '=integer' : rel === 'bin' ? '=binary' : rel === 'dif' ? '=AllDifferent' : rel);

/** Text of a row's right side for the report's Formula column. */
function rhsText(row) {
  if (row.rhs.kind === 'const') return String(row.rhs.v);
  if (row.rhs.kind === 'cell') return abs(row.rhs);
  if (row.rhs.kind === 'formula') return row.rhs.text;
  return '';
}

/** The reports a result can have: Answer always; Sensitivity and Limits for a continuous model solved. */
export function availableReports(p, result) {
  if (!result.x) return [];
  const list = ['answer'];
  const continuous = !p.hasInteger && p.model.engine !== 'evolutionary';
  if (continuous && result.solved) list.push('sensitivity', 'limits');
  return list;
}

/** Rows of a report sheet: [[value | { v, s }]], built from blocks of lines. */
function reportBuilder() {
  const entries = [];
  let r = 0;
  const bold = { bold: true };
  const head = { bold: true, bb: true };
  return {
    entries,
    line(...cells) { cells.forEach((v, c) => { if (v != null && v !== '') entries.push({ r, c: c + 1, cell: typeof v === 'object' ? { v: v.v, f: null, ...(v.s ? { s: v.s } : {}) } : { v, f: null } }); }); r++; },
    title(text) { entries.push({ r, c: 0, cell: { v: text, f: null, s: { bold: true, size: 14 } } }); r++; },
    heading(text) { r++; entries.push({ r, c: 0, cell: { v: text, f: null, s: bold } }); r++; },
    header(...labels) { labels.forEach((v, c) => entries.push({ r, c: c + 1, cell: { v, f: null, s: head } })); r++; },
    blank() { r++; },
    get row() { return r; },
  };
}

const vcell = (v, s) => ({ v, s });

function answerReport(wb, p, result, when) {
  const b = reportBuilder();
  const sheetName = sheetNameOf(wb, p.sheetId);
  const o = p.options;
  b.title('Answer Report');
  b.line(`Worksheet: ${sheetName}`);
  b.line(`Report created: ${when}`);
  b.line(`Result: ${result.message}`);
  b.heading('Solver engine');
  b.line(`Engine: ${ENGINE_LABEL[p.model.engine]}`);
  b.line(`Solution time: ${result.seconds.toFixed(3)} seconds`);
  b.line(`Iterations: ${result.iterations}   Subproblems: ${result.subproblems}   Trial solutions: ${result.evals}`);
  b.heading('Solver options');
  const limit = (v, unit = '') => (v == null ? 'Unlimited' : `${v}${unit}`);
  b.line(`Max time ${limit(o.maxTime, ' s')}, Iterations ${limit(o.maxIterations)}, Precision ${o.precision}${o.scaling ? ', Use automatic scaling' : ''}`);
  if (p.model.engine === 'grg') b.line(`Convergence ${o.convergence}, ${o.derivatives === 'central' ? 'Central' : 'Forward'} derivatives${o.multistart ? `, Multistart with population ${o.population}` : ''}`);
  if (p.model.engine === 'evolutionary') b.line(`Convergence ${o.convergence}, Population ${o.population}, Mutation rate ${o.mutationRate}, Random seed ${o.seed}, Time without improvement ${o.maxTimeNoImprove} s`);
  b.line(`Max subproblems ${limit(o.maxSubproblems)}, Max integer solutions ${limit(o.maxFeasible)}, Integer tolerance ${o.integerOptimality}%${o.ignoreInteger ? ', Ignore integer constraints' : ''}${p.model.nonNegative !== false ? ', Assume nonnegative' : ''}`);
  const goal = p.model.goal === 'min' ? 'Min' : p.model.goal === 'value' ? `Value of ${p.model.value}` : 'Max';
  b.heading(`Objective Cell (${goal})`);
  b.header('Cell', 'Name', 'Original Value', 'Final Value');
  const os = numberStyle(wb, p.sheetId, p.objective.r, p.objective.c);
  b.line(abs(p.objective), cellLabel(wb, p.sheetId, p.objective.r, p.objective.c), vcell(p.objectiveBefore, os), vcell(result.objective, os));
  b.heading('Variable Cells');
  b.header('Cell', 'Name', 'Original Value', 'Final Value', 'Integer');
  p.vars.forEach((v, j) => {
    const s = numberStyle(wb, p.sheetId, v.r, v.c);
    b.line(abs(v), cellLabel(wb, p.sheetId, v.r, v.c), vcell(p.x0[j], s), vcell(result.x[j], s), p.binary[j] ? 'Binary' : p.integer[j] ? 'Integer' : 'Contin');
  });
  b.heading('Constraints');
  b.header('Cell', 'Name', 'Cell Value', 'Formula', 'Status', 'Slack');
  const at = result.rowsAt;
  const tol = (p.options.precision ?? 1e-6) * 10;
  p.rows.forEach((row, i) => {
    const s = numberStyle(wb, p.sheetId, row.lhs.r, row.lhs.c);
    const lhs = at.lhs[i], rhs = at.rhs[i];
    if (row.rhs.kind === 'word') {
      b.line(abs(row.lhs), cellLabel(wb, p.sheetId, row.lhs.r, row.lhs.c), vcell(lhs, s), `${abs(row.lhs)}${relText(row.rel)}`, 'Binding', 0);
      return;
    }
    const slack = row.rel === '=' ? 0 : Math.abs(lhs - rhs);
    const binding = slack <= tol * Math.max(1, Math.abs(rhs));
    b.line(abs(row.lhs), cellLabel(wb, p.sheetId, row.lhs.r, row.lhs.c), vcell(lhs, s), `${abs(row.lhs)}${row.rel}${rhsText(row)}`, binding ? 'Binding' : 'Not Binding', binding ? 0 : slack);
  });
  return { entries: b.entries, widths: [16, 80, 200, 110, 110, 150, 90, 80] };
}

function sensitivityReport(wb, p, result, when) {
  const b = reportBuilder();
  b.title('Sensitivity Report');
  b.line(`Worksheet: ${sheetNameOf(wb, p.sheetId)}`);
  b.line(`Report created: ${when}`);
  const at = result.rowsAt;
  const active = p.rows.map((row, i) => i).filter((i) => !p.rows[i].bound);
  if (p.model.engine === 'simplex' && result.lpResult?.tableau) {
    const sens = sensitivity(result.lpResult);
    const max = p.model.goal === 'max';
    const flip = (v) => (max ? -v : v) || 0;
    // The engine's f is the objective times -1 for Max (and zero for Value Of): back to the sheet's sign.
    const coef = result.linear.cols.map((col) => (p.model.goal === 'max' ? -col.f : p.model.goal === 'min' ? col.f : 0));
    b.heading('Variable Cells');
    b.header('Cell', 'Name', 'Final Value', 'Reduced Cost', 'Objective Coefficient', 'Allowable Increase', 'Allowable Decrease');
    p.vars.forEach((v, j) => {
      const sv = sens.variables[j];
      const s = numberStyle(wb, p.sheetId, v.r, v.c);
      // The engine minimized -objective for Max: its increase is the objective's decrease.
      const inc = p.model.goal === 'value' ? 0 : max ? sv.decrease : sv.increase;
      const dec = p.model.goal === 'value' ? 0 : max ? sv.increase : sv.decrease;
      b.line(abs(v), cellLabel(wb, p.sheetId, v.r, v.c), vcell(result.x[j], s), p.model.goal === 'value' ? 0 : flip(sv.reducedCost), coef[j], big(inc), big(dec));
    });
    b.heading('Constraints');
    b.header('Cell', 'Name', 'Final Value', 'Shadow Price', 'Constraint R.H. Side', 'Allowable Increase', 'Allowable Decrease');
    active.forEach((i, k) => {
      const row = p.rows[i];
      const sr = sens.rows[k];
      const s = numberStyle(wb, p.sheetId, row.lhs.r, row.lhs.c);
      b.line(abs(row.lhs), cellLabel(wb, p.sheetId, row.lhs.r, row.lhs.c), vcell(at.lhs[i], s), p.model.goal === 'value' ? 0 : flip(sr.dual), at.rhs[i], big(sr.increase), big(sr.decrease));
    });
  } else {
    const nlp = result.nlp;
    const max = p.model.goal === 'max';
    b.heading('Variable Cells');
    b.header('Cell', 'Name', 'Final Value', 'Reduced Gradient');
    p.vars.forEach((v, j) => {
      const s = numberStyle(wb, p.sheetId, v.r, v.c);
      const rg = nlp?.reducedGradient?.[j] ?? 0;
      b.line(abs(v), cellLabel(wb, p.sheetId, v.r, v.c), vcell(result.x[j], s), (max ? -rg : rg) || 0);
    });
    b.heading('Constraints');
    b.header('Cell', 'Name', 'Final Value', 'Lagrange Multiplier');
    active.forEach((i, k) => {
      const row = p.rows[i];
      const s = numberStyle(wb, p.sheetId, row.lhs.r, row.lhs.c);
      const mult = nlp?.multipliers?.[k] ?? 0;
      b.line(abs(row.lhs), cellLabel(wb, p.sheetId, row.lhs.r, row.lhs.c), vcell(at.lhs[i], s), (max ? -mult : mult) || 0);
    });
  }
  return { entries: b.entries, widths: [16, 80, 200, 100, 110, 150, 120, 120] };
}

/**
 * Limits: each variable moved alone, the others held at the solution, as far down and up as the
 * constraints allow, with the objective at each end.
 */
function limitsReport(wb, p, result, when) {
  const b = reportBuilder();
  b.title('Limits Report');
  b.line(`Worksheet: ${sheetNameOf(wb, p.sheetId)}`);
  b.line(`Report created: ${when}`);
  const x = result.x;
  const os = numberStyle(wb, p.sheetId, p.objective.r, p.objective.c);
  b.heading('Objective');
  b.header('Cell', 'Name', 'Value');
  b.line(abs(p.objective), cellLabel(wb, p.sheetId, p.objective.r, p.objective.c), vcell(result.objective, os));
  b.heading('Variable');
  b.header('Cell', 'Name', 'Value', '', 'Lower Limit', 'Objective Result', '', 'Upper Limit', 'Objective Result');
  const limits = variableLimits(p, result);
  try {
    p.vars.forEach((v, j) => {
      const s = numberStyle(wb, p.sheetId, v.r, v.c);
      const L = limits[j];
      b.line(abs(v), cellLabel(wb, p.sheetId, v.r, v.c), vcell(x[j], s), '', vcell(big(L.lower), s), vcell(L.lowerObjective, os), '', vcell(big(L.upper), s), vcell(L.upperObjective, os));
    });
  } finally { p.restore(); }
  return { entries: b.entries, widths: [16, 80, 200, 100, 16, 100, 120, 16, 100, 120] };
}

/** For each variable: how low and how high it can go alone, and the objective there. */
export function variableLimits(p, result) {
  const x = result.x;
  const n = x.length;
  const active = p.rows.map((row, i) => i).filter((i) => !p.rows[i].bound);
  const lin = result.linear;
  const out = [];
  const objectiveAt = (j, v) => {
    if (!Number.isFinite(v)) return NaN;
    const xx = x.slice(); xx[j] = v;
    return p.evaluateAt(xx).f;
  };
  if (lin) {
    // Linear: each row's room for the variable is plain arithmetic on its coefficients.
    for (let j = 0; j < n; j++) {
      let lo = p.lb[j], hi = p.ub[j];
      active.forEach((i, k) => {
        const a = lin.cols[j].g[k];
        if (Math.abs(a) < 1e-12) return;
        // The row is g = a·x_j + rest, asked to be (rel) 0.
        let rest = lin.F0.g[k] - a * lin.base[j];
        for (let q = 0; q < n; q++) if (q !== j) rest += lin.cols[q].g[k] * (x[q] - lin.base[q]);
        const edge = -rest / a;
        const rel = p.rows[i].rel;
        if (rel === '=') { lo = Math.max(lo, edge); hi = Math.min(hi, edge); return; }
        if ((rel === '<=') === (a > 0)) hi = Math.min(hi, edge); else lo = Math.max(lo, edge);
      });
      out.push({ lower: lo, upper: hi, lowerObjective: objectiveAt(j, lo), upperObjective: objectiveAt(j, hi) });
    }
    return out;
  }
  // Nonlinear: bisect between the solution and each bound (or a far point) for the edge of feasibility.
  const meets = (xx) => {
    const at = p.evaluateAt(xx);
    return { ok: Number.isFinite(at.f) && feasibleRows(p, at, xx), f: at.f };
  };
  for (let j = 0; j < n; j++) {
    const ends = [];
    for (const dir of [-1, 1]) {
      const bound = dir < 0 ? p.lb[j] : p.ub[j];
      const far = Number.isFinite(bound) ? bound : x[j] + dir * 1e6 * Math.max(1, Math.abs(x[j]));
      const probe = (v) => { const xx = x.slice(); xx[j] = v; return meets(xx); };
      const atFar = probe(far);
      if (atFar.ok) { ends.push({ v: Number.isFinite(bound) ? far : dir * Infinity, f: Number.isFinite(bound) ? atFar.f : NaN }); continue; }
      let good = x[j], bad = far, goodF = result.objective;
      for (let k = 0; k < 40; k++) {
        const mid = (good + bad) / 2;
        const r = probe(mid);
        if (r.ok) { good = mid; goodF = r.f; } else bad = mid;
        if (Math.abs(bad - good) <= 1e-9 * Math.max(1, Math.abs(good))) break;
      }
      ends.push({ v: good, f: goodF });
    }
    out.push({ lower: ends[0].v, lowerObjective: ends[0].f, upper: ends[1].v, upperObjective: ends[1].f });
  }
  return out;
}

const REPORT_BUILDERS = { answer: ['Answer Report', answerReport], sensitivity: ['Sensitivity Report', sensitivityReport], limits: ['Limits Report', limitsReport] };

/**
 * Finish a solve as one undo step: save the model, keep the solution (or leave the original values) and add
 * the chosen reports as sheets before the model's. Returns { reportSheetIds }.
 */
export function applySolverResult(wb, p, result, { keep = true, reports = [], when = new Date().toLocaleString() } = {}) {
  const sheetId = p.sheetId;
  const built = [];
  const allowed = availableReports(p, result);
  for (const kind of reports) {
    if (!allowed.includes(kind)) continue;
    const [title, build] = REPORT_BUILDERS[kind];
    built.push({ title, ...build(wb, p, result, when) });
  }
  const reportSheetIds = [];
  wb.transaction('Solver', () => {
    saveSolverModel(wb, sheetId, p.model, 'Solver');
    if (keep && result.x) {
      const sheet = wb.sheet(sheetId);
      const entries = p.vars.map((v, j) => ({ r: v.r, c: v.c, cell: { v: result.x[j], f: null, ...(sheet.cells.get(cellKey(v.r, v.c))?.s ? { s: sheet.cells.get(cellKey(v.r, v.c)).s } : {}) } }));
      wb.setCells(sheetId, entries, 'Solver');
    }
    for (const report of built) {
      let k = 1;
      while (wb.sheetByName(`${report.title} ${k}`)) k++;
      const index = Math.max(0, wb.sheets.findIndex((s) => s.id === sheetId));
      const added = wb.addSheet(`${report.title} ${k}`, index);
      if (!added) continue;
      reportSheetIds.push(added.id);
      wb.setCells(added.id, report.entries, 'Solver');
      report.widths.forEach((w, c) => wb.setColWidth(added.id, c, w));
    }
    // A new sheet becomes the active one; the model's sheet stays in front.
    if (reportSheetIds.length) wb.setActiveSheet(sheetId);
  });
  return { reportSheetIds };
}

