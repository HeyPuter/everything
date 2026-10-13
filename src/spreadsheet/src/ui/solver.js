/**
 * Data ▸ Analyze ▸ Solver: the Solver Parameters dialog (objective, goal, variable cells, the constraint
 * list, nonnegativity and the solving method), the constraint editor, the Options dialog, Load/Save model,
 * the progress dialog with Stop while the solve runs a frame at a time, and the Results dialog that keeps
 * or restores the values, adds reports and can save the solution as a scenario.
 */
import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert, confirmDialog, promptDialog } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { saveScenario } from '../core/scenarios.js';
import { RELATIONS, ENGINES, DEFAULT_OPTIONS, emptyModel, readSolverModel, saveSolverModel, prepareSolver, runSolver, applySolverResult,
  availableReports, modelToCells, modelFromCells, saveModelToCells, parseRanges } from '../core/solver.js';

const ENGINE_NOTES = {
  grg: 'For smooth nonlinear models. Starts from the current values and finds a locally optimal solution; turn on Multistart in Options to search from many starting points.',
  simplex: 'For linear models: the objective and every constraint must be sums of the variable cells times constants. Finds the best solution and supports sensitivity analysis.',
  evolutionary: 'For models built on functions that are not smooth, such as IF, lookups or rounding. Needs bounds on the variable cells and searches with a population of trial solutions.',
};
const REPORTS = [['answer', 'Answer'], ['sensitivity', 'Sensitivity'], ['limits', 'Limits']];
const RELATION_LABEL = { '<=': '<=', '=': '=', '>=': '>=', int: 'int', bin: 'bin', dif: 'dif' };
const WORD = { int: 'integer', bin: 'binary', dif: 'AllDifferent' };

const constraintText = (k) => `${k.lhs} ${k.rel === 'int' || k.rel === 'bin' || k.rel === 'dif' ? '= ' + WORD[k.rel] : `${RELATION_LABEL[k.rel]} ${k.rhs}`}`;
const clone = (m) => JSON.parse(JSON.stringify(m));
const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** A selection as dialog text: absolute references, the ranges joined by commas. */
function selectionText(ctx) {
  const ranges = ctx.ranges?.() || [ctx.range()];
  return ranges.map((g) => {
    const a = `$${cellName(g.r1, g.c1).replace(/(\d+)$/, '$$$1')}`;
    return g.r1 === g.r2 && g.c1 === g.c2 ? a : `${a}:$${cellName(g.r2, g.c2).replace(/(\d+)$/, '$$$1')}`;
  }).join(',');
}

/** Add Constraint / Change Constraint. `onDone(constraint, again)`. */
function openConstraintEditor(ctx, existing, onDone) {
  const sheetId = ctx.sheetId();
  const lhs = el('input.input', { type: 'text', id: fieldId('sv-lhs'), value: existing?.lhs || selectionText(ctx), autocomplete: 'off', spellcheck: false });
  const rel = el('select.select.sv-rel', { id: fieldId('sv-rel'), 'aria-label': 'Relation' }, ...RELATIONS.map(([key, label]) => el('option', { value: key }, label)));
  rel.value = existing?.rel || '<=';
  const rhs = el('input.input', { type: 'text', id: fieldId('sv-rhs'), value: existing && !WORD[existing.rel] ? existing.rhs : '', autocomplete: 'off', spellcheck: false });
  const { alert, refuse } = fieldAlert('solver-constraint');
  const sync = () => {
    const word = WORD[rel.value];
    rhs.disabled = !!word;
    if (word) rhs.value = word;
    else if (Object.values(WORD).includes(rhs.value)) rhs.value = '';
  };
  rel.addEventListener('change', sync);
  sync();
  const collect = () => {
    const left = lhs.value.trim();
    const ranges = parseRanges(ctx.wb, sheetId, left);
    if (!ranges || ranges.length !== 1) { refuse(lhs, 'Enter one range on this sheet, like $B$4 or $B$4:$B$6'); return null; }
    const word = WORD[rel.value];
    const right = word || rhs.value.trim().replace(/^=/, '');
    if (!right) { refuse(rhs, 'Enter a number, a cell reference or a formula'); return null; }
    if (!word && !Number.isFinite(Number(right))) {
      const ref = parseRanges(ctx.wb, sheetId, right);
      if (ref && ref.length === 1) {
        const R = ref[0], L = ranges[0];
        const one = R.r1 === R.r2 && R.c1 === R.c2;
        if (!one && (R.r2 - R.r1 !== L.r2 - L.r1 || R.c2 - R.c1 !== L.c2 - L.c1)) { refuse(rhs, 'Use one cell, or a range the same size as the cell reference'); return null; }
      } else {
        const probe = ctx.wb.evaluateText(sheetId, ranges[0].r1, ranges[0].c1, right);
        if (probe && typeof probe === 'object' && ['#NAME?', '#REF!'].includes(probe.error)) { refuse(rhs, 'Enter a number, a cell reference or a formula'); return null; }
      }
    }
    return { lhs: left, rel: rel.value, rhs: right };
  };
  const commit = (again) => {
    const k = collect();
    if (!k) return;
    modal.close();
    onDone(k, again);
  };
  const content = el('form.sv-constraint', { onsubmit: (e) => { e.preventDefault(); commit(false); } },
    el('div.sv-constraint-row', {},
      el('div.field', {}, el('label.field-label', { for: lhs.id }, 'Cell reference'), lhs),
      el('div.field.sv-rel-field', {}, el('label.field-label', { for: rel.id }, 'Relation'), el('div.select-wrap', {}, rel)),
      el('div.field', {}, el('label.field-label', { for: rhs.id }, 'Constraint'), rhs)),
    el('p.small.muted', {}, 'The constraint can be a number, a cell or range of the same size, or a formula. int, bin and dif make the cells whole numbers, 0 or 1, or all different (1 to n).'),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn', { type: 'button', onclick: () => commit(true) }, 'Add Another'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: existing ? 'Change Constraint' : 'Add Constraint', content, initialFocus: lhs });
  return modal;
}

/** Solver Options: All Methods, GRG Nonlinear and Evolutionary tabs over one options object. */
function openOptions(options, onDone) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const id = (name) => fieldId(`sv-opt-${name}`);
  const num = (name, value, attrs = {}) => el('input.input.sv-num', { type: 'text', inputmode: 'decimal', id: id(name), value: value == null ? '' : String(value), autocomplete: 'off', ...attrs });
  const check = (name, on) => el('input', { type: 'checkbox', id: id(name), checked: !!on });
  const f = {
    precision: num('precision', o.precision), scaling: check('scaling', o.scaling), ignoreInteger: check('ignore', o.ignoreInteger),
    integerOptimality: num('intopt', o.integerOptimality), maxTime: num('time', o.maxTime, { placeholder: 'Unlimited' }), maxIterations: num('iter', o.maxIterations, { placeholder: 'Unlimited' }),
    maxSubproblems: num('nodes', o.maxSubproblems, { placeholder: 'Unlimited' }), maxFeasible: num('feasible', o.maxFeasible, { placeholder: 'Unlimited' }),
    grgConvergence: num('grg-cvg', o.convergence), forward: el('input', { type: 'radio', name: id('drv'), id: id('fwd'), checked: o.derivatives !== 'central' }),
    central: el('input', { type: 'radio', name: id('drv'), id: id('ctr'), checked: o.derivatives === 'central' }), multistart: check('ms', o.multistart),
    grgPopulation: num('grg-pop', o.population), grgSeed: num('grg-seed', o.seed), grgBounds: check('grg-rbv', o.requireBounds),
    evoConvergence: num('evo-cvg', o.convergence), mutationRate: num('mrt', o.mutationRate), evoPopulation: num('evo-pop', o.population),
    evoSeed: num('evo-seed', o.seed), maxTimeNoImprove: num('mni', o.maxTimeNoImprove), evoBounds: check('evo-rbv', o.requireBounds),
  };
  // Options both methods share stay in step whichever tab they are changed on.
  const twin = (a, b, prop = 'value') => { a.addEventListener('input', () => { b[prop] = a[prop]; }); b.addEventListener('input', () => { a[prop] = b[prop]; }); a.addEventListener('change', () => { b[prop] = a[prop]; }); b.addEventListener('change', () => { a[prop] = b[prop]; }); };
  twin(f.grgConvergence, f.evoConvergence); twin(f.grgPopulation, f.evoPopulation); twin(f.grgSeed, f.evoSeed); twin(f.grgBounds, f.evoBounds, 'checked');
  const row = (label, control) => el('div.sv-opt-row', {}, el('label', { for: control.id }, label), control);
  const tick = (label, control) => el('label.check', { for: control.id }, control, el('span', {}, label));
  const panels = {
    all: el('div.sv-opt-panel', {},
      row('Constraint precision', f.precision), tick('Use automatic scaling', f.scaling),
      el('fieldset.sv-opt-group', {}, el('legend', {}, 'Integer constraints'), tick('Ignore integer constraints', f.ignoreInteger), row('Integer optimality (%)', f.integerOptimality)),
      el('fieldset.sv-opt-group', {}, el('legend', {}, 'Solving limits'), row('Max time (seconds)', f.maxTime), row('Iterations', f.maxIterations)),
      el('fieldset.sv-opt-group', {}, el('legend', {}, 'Evolutionary and integer limits'), row('Max subproblems', f.maxSubproblems), row('Max feasible solutions', f.maxFeasible))),
    grg: el('div.sv-opt-panel', {},
      row('Convergence', f.grgConvergence),
      el('fieldset.sv-opt-group', {}, el('legend', {}, 'Derivatives'), el('div.row', {}, tick('Forward', f.forward), tick('Central', f.central))),
      el('fieldset.sv-opt-group', {}, el('legend', {}, 'Multistart'), tick('Use multistart', f.multistart), row('Population size', f.grgPopulation), row('Random seed', f.grgSeed), tick('Require bounds on variables', f.grgBounds))),
    evo: el('div.sv-opt-panel', {},
      row('Convergence', f.evoConvergence), row('Mutation rate', f.mutationRate), row('Population size', f.evoPopulation), row('Random seed', f.evoSeed),
      row('Max time without improvement (seconds)', f.maxTimeNoImprove), tick('Require bounds on variables', f.evoBounds)),
  };
  const TABS = [['all', 'All Methods'], ['grg', 'GRG Nonlinear'], ['evo', 'Evolutionary']];
  let active = 'all';
  const tabId = fieldId('sv-tabs');
  for (const [key, p] of Object.entries(panels)) { p.id = `${tabId}-${key}-panel`; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', `${tabId}-${key}`); }
  const tabs = el('div.seg.fc-tabs.sv-tabs', { role: 'tablist', 'aria-label': 'Options for' }, TABS.map(([key, label]) => el('button.seg-btn', {
    type: 'button', role: 'tab', id: `${tabId}-${key}`, dataset: { key }, 'aria-controls': panels[key].id, onclick: () => { active = key; syncTabs(); },
  }, label)));
  const syncTabs = () => {
    for (const b of tabs.children) { b.setAttribute('aria-selected', String(b.dataset.key === active)); b.tabIndex = b.dataset.key === active ? 0 : -1; }
    for (const [key, p] of Object.entries(panels)) p.hidden = key !== active;
  };
  tabs.addEventListener('keydown', (e) => {
    if (isComposing(e) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const i = TABS.findIndex(([key]) => key === active);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    e.preventDefault();
    active = TABS[next][0];
    syncTabs();
    tabs.children[next].focus();
  });
  syncTabs();
  const { alert, refuse } = fieldAlert('solver-options');
  const read = (input, { min = -Infinity, max = Infinity, open = false, blank = false, integer = false } = {}) => {
    const t = input.value.trim();
    if (!t) return blank ? { ok: true, v: null } : { ok: false };
    const v = Number(t);
    if (!Number.isFinite(v) || (open ? v <= min : v < min) || v > max || (integer && !Number.isInteger(v))) return { ok: false };
    return { ok: true, v };
  };
  const submit = (e) => {
    e.preventDefault();
    const out = {};
    const take = (key, input, rules, message, tab) => {
      const r = read(input, rules);
      if (!r.ok) { active = tab; syncTabs(); refuse(input, message); return false; }
      out[key] = r.v;
      return true;
    };
    if (!take('precision', f.precision, { min: 0, max: 1, open: true }, 'Enter a precision between 0 and 1', 'all')) return;
    if (!take('integerOptimality', f.integerOptimality, { min: 0, max: 100 }, 'Enter a percentage from 0 to 100', 'all')) return;
    if (!take('maxTime', f.maxTime, { min: 0, open: true, blank: true }, 'Enter a number of seconds, or leave it blank for no limit', 'all')) return;
    if (!take('maxIterations', f.maxIterations, { min: 1, blank: true, integer: true }, 'Enter a whole number of iterations, or leave it blank', 'all')) return;
    if (!take('maxSubproblems', f.maxSubproblems, { min: 1, blank: true, integer: true }, 'Enter a whole number, or leave it blank', 'all')) return;
    if (!take('maxFeasible', f.maxFeasible, { min: 1, blank: true, integer: true }, 'Enter a whole number, or leave it blank', 'all')) return;
    if (!take('convergence', f.grgConvergence, { min: 0, max: 1, open: true }, 'Enter a convergence between 0 and 1', 'grg')) return;
    if (!take('population', f.grgPopulation, { min: 10, max: 10000, integer: true }, 'Enter a population of 10 to 10000', 'grg')) return;
    if (!take('seed', f.grgSeed, { min: 0, integer: true }, 'Enter a whole number for the seed (0 picks a new one each time)', 'grg')) return;
    if (!take('mutationRate', f.mutationRate, { min: 0, max: 1 }, 'Enter a mutation rate from 0 to 1', 'evo')) return;
    if (!take('maxTimeNoImprove', f.maxTimeNoImprove, { min: 0, open: true }, 'Enter a number of seconds', 'evo')) return;
    Object.assign(out, { scaling: f.scaling.checked, ignoreInteger: f.ignoreInteger.checked, derivatives: f.central.checked ? 'central' : 'forward',
      multistart: f.multistart.checked, requireBounds: f.grgBounds.checked });
    modal.close();
    onDone(out);
  };
  const content = el('form.sv-options', { onsubmit: submit }, tabs, ...Object.values(panels), alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Solver Options', content });
}

/** Load/Save Model: a range to read a model from, or the top cell to write it down from. */
function openLoadSave(ctx, model, onLoad) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const need = modelToCells(model).length;
  const range = el('input.input', { type: 'text', id: fieldId('sv-model'), value: selectionText(ctx), autocomplete: 'off', spellcheck: false });
  const { alert, refuse } = fieldAlert('solver-model');
  const load = async () => {
    const ranges = parseRanges(wb, sheetId, range.value);
    if (!ranges || ranges.length !== 1) return refuse(range, 'Enter the range that holds a saved model, like $H$2:$H$8');
    const g = ranges[0];
    // A single cell stands for the column of a model saved from it down.
    const span = g.r1 === g.r2 && g.c1 === g.c2 ? { ...g, r2: g.r1 + 200 } : g;
    const out = modelFromCells(wb, sheetId, span);
    if (out.error) return refuse(range, out.error);
    if (model.objective || model.constraints.length) {
      const ok = await confirmDialog({ title: 'Load Model', message: 'Replace the current model with the one in these cells?', confirmLabel: 'Replace', danger: false });
      if (!ok) return;
    }
    modal.close();
    onLoad(out.model);
  };
  const save = async () => {
    const ranges = parseRanges(wb, sheetId, range.value);
    if (!ranges || ranges.length !== 1) return refuse(range, 'Enter the top cell of an empty column range to save the model to');
    const { r1, c1 } = ranges[0];
    let used = false;
    for (let r = r1; r < r1 + need; r++) { const cell = wb.getCell(sheetId, r, c1); if (cell && (cell.v != null || cell.f != null)) used = true; }
    if (used) {
      const ok = await confirmDialog({ title: 'Save Model', message: `The ${need} cells from ${cellName(r1, c1)} down are not all empty. Replace their contents with the model?`, confirmLabel: 'Replace', danger: false });
      if (!ok) return;
    }
    saveModelToCells(wb, sheetId, r1, c1, model);
    modal.close();
    toast(`Model saved to ${cellName(r1, c1)}:${cellName(r1 + need - 1, c1)}`, { icon: 'check' });
  };
  const content = el('form.sv-loadsave', { onsubmit: (e) => { e.preventDefault(); load(); } },
    el('div.field', {}, el('label.field-label', { for: range.id }, 'Model range'), range),
    el('p.small.muted', {}, `Load reads a model saved in cells. Save writes this model down a column from the cell given, in ${need} cells: formulas you can read and check, with the options in the last cell.`),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn', { type: 'button', onclick: save }, 'Save'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Load')));
  const modal = openModal({ title: 'Load/Save Model', content, initialFocus: range });
}

/** The progress dialog: what the search has reached, and Stop. Returns { update(progress), close }. */
function openProgress(onStop) {
  const status = el('p.sv-progress-status', { role: 'status', 'aria-live': 'polite' }, 'Setting up the model…');
  const bar = el('div.sv-progress-bar', { 'aria-hidden': 'true' }, el('span'));
  const stop = el('button.btn.btn-primary', { type: 'button', onclick: () => { stop.disabled = true; stop.textContent = 'Stopping…'; onStop(); } }, 'Stop');
  const content = el('div.sv-progress', {}, bar, status, el('div.row.row-end', {}, stop));
  const modal = openModal({ title: 'Solving…', content, initialFocus: stop });
  const format = (v) => (Number.isFinite(v) ? Number(v.toPrecision(8)).toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—');
  return {
    update(p) {
      const parts = [];
      if (p.phase === 'linear') parts.push('Measuring the model');
      if (p.subproblems) parts.push(`Subproblem ${p.subproblems}`);
      if (p.evals) parts.push(`Trial solution ${p.evals}`);
      if (p.objective != null) parts.push(`Objective ${format(p.objective)}`);
      status.textContent = parts.join(' · ');
    },
    close: () => modal.close(),
  };
}

/** Solver Results: keep or restore, reports, return to the parameters, save as a scenario. */
function openResults(ctx, prepared, result, { onReturn }) {
  const { wb } = ctx;
  const sheetId = prepared.sheetId;
  const allowed = availableReports(prepared, result);
  const keep = el('input', { type: 'radio', name: fieldId('sv-keep'), id: fieldId('sv-keep-on'), checked: result.ok, disabled: !result.ok });
  const restore = el('input', { type: 'radio', name: keep.name, id: fieldId('sv-keep-off'), checked: !result.ok });
  const back = el('input', { type: 'checkbox', id: fieldId('sv-back') });
  const reportBoxes = REPORTS.map(([key, label]) => {
    const box = el('input', { type: 'checkbox', id: fieldId(`sv-rep-${key}`), value: key, disabled: !allowed.includes(key) });
    return el('label.check', { for: box.id, title: allowed.includes(key) ? null : key === 'answer' ? 'There is no solution to report on' : 'Available for a continuous model solved by Simplex LP or GRG Nonlinear' }, box, el('span', {}, label));
  });
  const done = (apply) => {
    if (apply) {
      const reports = reportBoxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
      const { reportSheetIds } = applySolverResult(wb, prepared, result, { keep: keep.checked && result.ok, reports });
      if (reportSheetIds.length) toast(`${reportSheetIds.length === 1 ? 'Report' : `${reportSheetIds.length} reports`} added before this sheet`, { icon: 'check' });
    } else {
      applySolverResult(wb, prepared, result, { keep: false });
    }
    const again = back.checked;
    modal.close();
    if (again) onReturn();
  };
  const saveAsScenario = async () => {
    if (!result.x) return;
    const name = await promptDialog({ title: 'Save Scenario', label: 'Scenario name', confirmLabel: 'Save' });
    if (!name) return;
    const problem = saveScenario(wb, sheetId, { name, cells: prepared.vars.map((v) => ({ r: v.r, c: v.c })), values: result.x, comment: `Created by Solver on ${new Date().toLocaleDateString()}` });
    if (problem) toast(problem, { icon: 'alert' });
    else toast(`Scenario “${name}” saved`, { icon: 'check' });
  };
  const detail = result.solved && prepared.model.engine === 'grg' && result.status === 'localOptimal'
    ? 'GRG Nonlinear finds a locally optimal solution. Another starting point, or Multistart in Options, may find a better one.'
    : result.status === 'optimal' && prepared.model.engine === 'simplex' ? 'Simplex LP found the best solution of this linear model.' : null;
  const content = el('form.sv-results', { onsubmit: (e) => { e.preventDefault(); done(true); } },
    el('p.modal-text.sv-result-message', { 'data-status': result.status }, result.message),
    detail && el('p.small.muted', {}, detail),
    el('div.sv-results-grid', {},
      el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Values'),
        el('label.check', { for: keep.id }, keep, el('span', {}, 'Keep Solver solution')),
        el('label.check', { for: restore.id }, restore, el('span', {}, 'Restore original values'))),
      el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Reports (each on a new sheet)'), ...reportBoxes)),
    el('label.check', { for: back.id }, back, el('span', {}, 'Return to Solver Parameters')),
    el('p.small.muted.sv-result-stats', {}, [`${result.seconds.toFixed(2)} s`, count(result.evals, 'trial solution'), result.iterations && count(result.iterations, 'iteration'), result.subproblems && count(result.subproblems, 'subproblem')].filter(Boolean).join(' · ')),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost.sv-scenario', { type: 'button', disabled: !result.x, onclick: saveAsScenario }, 'Save Scenario…'),
      el('span.sv-spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => done(false) }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Solver Results', content, onClose: () => ctx.grid?.focus?.() });
  return modal;
}

/** The Solver Parameters dialog. `start` is a model to show (returning to the dialog), else the sheet's saved one. */
export function openSolver(ctx, start = null) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const model = start ? clone(start) : readSolverModel(wb, sheetId);
  if (!model.objective) {
    const a = ctx.active();
    model.objective = `$${cellName(a.r, a.c).replace(/(\d+)$/, '$$$1')}`;
  }
  const objective = el('input.input', { type: 'text', id: fieldId('sv-obj'), value: model.objective, autocomplete: 'off', spellcheck: false });
  const goalName = fieldId('sv-goal');
  const goals = Object.fromEntries([['max', 'Max'], ['min', 'Min'], ['value', 'Value Of:']].map(([key]) => [key, el('input', { type: 'radio', name: goalName, id: fieldId(`sv-goal-${key}`), value: key, checked: model.goal === key })]));
  const value = el('input.input.sv-value', { type: 'text', inputmode: 'decimal', id: fieldId('sv-val'), value: String(model.value ?? 0), 'aria-label': 'Value of', autocomplete: 'off', disabled: model.goal !== 'value' });
  for (const radio of Object.values(goals)) radio.addEventListener('change', () => { value.disabled = !goals.value.checked; });
  const variables = el('input.input', { type: 'text', id: fieldId('sv-adj'), value: model.variables, autocomplete: 'off', spellcheck: false, placeholder: 'e.g. $B$2:$B$5' });
  const list = el('select.select.sm-list.sv-list', { size: 7, id: fieldId('sv-list'), 'aria-label': 'Constraints' });
  const empty = el('p.small.muted.sm-empty.sv-empty', {}, 'No constraints yet. Choose Add to limit the cells the model uses.');
  const nonNegative = el('input', { type: 'checkbox', id: fieldId('sv-neg'), checked: model.nonNegative !== false });
  const engine = el('select.select', { id: fieldId('sv-eng') }, ...ENGINES.map(([key, label]) => el('option', { value: key }, label)));
  engine.value = model.engine;
  const note = el('p.small.muted.sv-engine-note', { id: fieldId('sv-note') }, ENGINE_NOTES[model.engine]);
  engine.setAttribute('aria-describedby', note.id);
  engine.addEventListener('change', () => { note.textContent = ENGINE_NOTES[engine.value]; });
  let options = { ...DEFAULT_OPTIONS, ...model.options };
  let constraints = model.constraints.map((k) => ({ ...k }));
  const buttons = {};
  const sync = (pick = list.selectedIndex) => {
    list.replaceChildren(...constraints.map((k, i) => el('option', { value: String(i) }, constraintText(k))));
    list.hidden = !constraints.length;
    empty.hidden = !!constraints.length;
    if (constraints.length) list.selectedIndex = Math.max(0, Math.min(constraints.length - 1, pick));
    buttons.change.disabled = buttons.remove.disabled = !constraints.length;
    buttons.reset.disabled = false;
  };
  const current = () => ({
    objective: objective.value.trim(), goal: Object.entries(goals).find(([, r]) => r.checked)?.[0] || 'max', value: value.value.trim() === '' ? 0 : Number(value.value),
    variables: variables.value.trim(), constraints: constraints.map((k) => ({ ...k })), nonNegative: nonNegative.checked, engine: engine.value, options: { ...options },
  });
  const add = () => openConstraintEditor(ctx, null, (k, again) => { constraints.push(k); sync(constraints.length - 1); if (again) add(); else list.focus(); });
  buttons.add = el('button.btn', { type: 'button', onclick: add }, 'Add…');
  buttons.change = el('button.btn', { type: 'button', onclick: () => {
    const i = list.selectedIndex;
    if (i < 0) return;
    openConstraintEditor(ctx, constraints[i], (k, again) => { constraints[i] = k; sync(i); if (again) add(); else list.focus(); });
  } }, 'Change…');
  buttons.remove = el('button.btn', { type: 'button', onclick: () => { const i = list.selectedIndex; if (i < 0) return; constraints.splice(i, 1); sync(i); (constraints.length ? list : buttons.add).focus(); } }, 'Delete');
  buttons.reset = el('button.btn', { type: 'button', onclick: async () => {
    const ok = await confirmDialog({ title: 'Reset All', message: 'Clear the objective, variable cells, constraints and options?', confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    const blank = emptyModel();
    objective.value = ''; variables.value = ''; goals.max.checked = true; value.value = '0'; value.disabled = true;
    nonNegative.checked = true; engine.value = blank.engine; note.textContent = ENGINE_NOTES[blank.engine];
    options = { ...DEFAULT_OPTIONS }; constraints = [];
    sync();
    objective.focus();
  } }, 'Reset All');
  buttons.loadSave = el('button.btn', { type: 'button', onclick: () => openLoadSave(ctx, current(), (m) => {
    objective.value = m.objective; variables.value = m.variables; goals[m.goal].checked = true; value.value = String(m.value ?? 0); value.disabled = m.goal !== 'value';
    nonNegative.checked = m.nonNegative !== false; engine.value = m.engine; note.textContent = ENGINE_NOTES[m.engine];
    options = { ...DEFAULT_OPTIONS, ...m.options }; constraints = m.constraints.map((k) => ({ ...k }));
    sync(0);
  }) }, 'Load/Save…');
  list.addEventListener('dblclick', () => buttons.change.click());
  list.addEventListener('keydown', (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); buttons.remove.click(); } });
  const optionsBtn = el('button.btn', { type: 'button', onclick: () => openOptions(options, (next) => { options = { ...options, ...next }; }) }, 'Options…');
  const { alert, refuse } = fieldAlert('solver');

  let closingTo = null;
  const close = () => {
    // Close keeps the model as it stands, as the dialog's saved state.
    const m = current();
    if (m.objective || m.variables || m.constraints.length) saveSolverModel(wb, sheetId, m);
    modal.close();
  };
  const solve = (e) => {
    e?.preventDefault();
    const m = current();
    if (m.goal === 'value' && !Number.isFinite(m.value)) return refuse(value, 'Enter the number the objective should reach');
    const prepared = prepareSolver(wb, sheetId, m);
    if (prepared.error) {
      const field = { objective, variables, value, constraint: list }[prepared.field] || null;
      if (prepared.field === 'constraint' && Number.isInteger(prepared.index)) list.selectedIndex = prepared.index;
      return refuse(field, prepared.error);
    }
    closingTo = prepared;
    modal.close();
    const progress = openProgress(() => { prepared.cancelled = true; });
    runSolver(prepared, { onProgress: (p) => progress.update(p) }).then((result) => {
      progress.close();
      openResults(ctx, prepared, result, { onReturn: () => openSolver(ctx, m) });
    }, (err) => {
      progress.close();
      console.error(err);
      toast(`Solver stopped: ${err?.message || 'unexpected error'}`, { icon: 'alert', duration: 5000 });
    });
  };

  const field = (label, control, extra = null) => el('div.field', {}, el('label.field-label', { for: control.id }, label), control, extra);
  const content = el('form.sv-dialog', { onsubmit: solve },
    field('Set objective', objective),
    el('div.sv-goal', { role: 'radiogroup', 'aria-labelledby': `${goalName}-label` }, el('span.field-label.sv-goal-label', { id: `${goalName}-label` }, 'To'),
      el('label.check', { for: goals.max.id }, goals.max, el('span', {}, 'Max')),
      el('label.check', { for: goals.min.id }, goals.min, el('span', {}, 'Min')),
      el('label.check', { for: goals.value.id }, goals.value, el('span', {}, 'Value of')), value),
    field('By changing variable cells', variables, el('span.small.muted', {}, 'Separate ranges with commas.')),
    el('div.sv-constraints', {},
      el('div.sv-list-wrap', {}, el('label.field-label', { for: list.id }, 'Subject to the constraints'), list, empty),
      el('div.sm-buttons.sv-buttons', {}, buttons.add, buttons.change, buttons.remove, buttons.reset, buttons.loadSave)),
    el('label.check', { for: nonNegative.id }, nonNegative, el('span', {}, 'Make unconstrained variables non-negative')),
    el('div.sv-engine', {},
      el('div.field', {}, el('label.field-label', { for: engine.id }, 'Solving method'), el('div.sv-engine-row', {}, el('div.select-wrap', {}, engine), optionsBtn)),
      note),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: close }, 'Close'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Solve')));
  const modal = openModal({ title: 'Solver Parameters', content, wide: true, initialFocus: objective, onClose: () => { if (!closingTo) ctx.grid?.focus?.(); } });
  sync(0);
  return modal;
}
