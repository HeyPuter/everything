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
import { typedNumber, numberShown } from './typed-number.js';
import { saveScenario } from '../core/scenarios.js';
import { RELATIONS, ENGINES, DEFAULT_OPTIONS, emptyModel, readSolverModel, saveSolverModel, prepareSolver, runSolver, applySolverResult,
  availableReports, modelToCells, modelFromCells, saveModelToCells, parseRanges, solverMessageShown } from '../core/solver.js';
import { t, formatNumber } from '../i18n/index.js';

const ENGINE_NOTES = {
  grg: 'solver.engineNote.grg',
  simplex: 'solver.engineNote.simplex',
  evolutionary: 'solver.engineNote.evolutionary',
};
const ENGINE_LABELS = { grg: 'solver.engine.grg', simplex: 'solver.engine.simplex', evolutionary: 'solver.engine.evolutionary' };
const REPORTS = [['answer', 'solver.results.answer'], ['sensitivity', 'solver.results.sensitivity'], ['limits', 'solver.results.limits']];
const RELATION_LABEL = { '<=': '<=', '=': '=', '>=': '>=', int: 'int', bin: 'bin', dif: 'dif' };
/** The right side the model stores for int, bin and dif (English, as Excel saves it). */
const WORD = { int: 'integer', bin: 'binary', dif: 'AllDifferent' };
/** How the dialogs show that right side: AllDifferent is the same in every language, as in Excel. */
const wordLabel = (rel) => (rel === 'int' ? t('solver.word.integer') : rel === 'bin' ? t('solver.word.binary') : rel === 'dif' ? WORD.dif : null);

/** A constraint's right side as the dialogs show it: a number in the regional format, a reference or formula as stored. */
const rhsShown = (rhs) => (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(String(rhs ?? '').trim()) ? numberShown(Number(rhs)) : rhs);

const constraintText = (k) => `${k.lhs} ${k.rel === 'int' || k.rel === 'bin' || k.rel === 'dif' ? '= ' + wordLabel(k.rel) : `${RELATION_LABEL[k.rel]} ${rhsShown(k.rhs)}`}`;
const clone = (m) => JSON.parse(JSON.stringify(m));

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
  const rel = el('select.select.sv-rel', { id: fieldId('sv-rel'), 'aria-label': t('solver.constraint.relation') }, ...RELATIONS.map(([key, label]) => el('option', { value: key }, label)));
  rel.value = existing?.rel || '<=';
  const rhs = el('input.input', { type: 'text', id: fieldId('sv-rhs'), value: existing && !WORD[existing.rel] ? rhsShown(existing.rhs) : '', autocomplete: 'off', spellcheck: false });
  const { alert, refuse } = fieldAlert('solver-constraint');
  const sync = () => {
    const word = wordLabel(rel.value);
    rhs.disabled = !!word;
    if (word) rhs.value = word;
    else if (['int', 'bin', 'dif'].some((r) => wordLabel(r) === rhs.value)) rhs.value = '';
  };
  rel.addEventListener('change', sync);
  sync();
  const collect = () => {
    const left = lhs.value.trim();
    const ranges = parseRanges(ctx.wb, sheetId, left);
    if (!ranges || ranges.length !== 1) { refuse(lhs, t('solver.constraint.oneRange')); return null; }
    const word = WORD[rel.value];
    let right = word || rhs.value.trim().replace(/^=/, '');
    if (!right) { refuse(rhs, t('solver.constraint.noRhs')); return null; }
    // A number is stored as the model's formulas write one (2.5), whatever the regional format it was typed in.
    const constant = word || /^=/.test(rhs.value.trim()) ? null : typedNumber(right);
    if (constant != null) right = String(constant);
    else if (!word) {
      const ref = parseRanges(ctx.wb, sheetId, right);
      if (ref && ref.length === 1) {
        const R = ref[0], L = ranges[0];
        const one = R.r1 === R.r2 && R.c1 === R.c2;
        if (!one && (R.r2 - R.r1 !== L.r2 - L.r1 || R.c2 - R.c1 !== L.c2 - L.c1)) { refuse(rhs, t('solver.constraint.sameSize')); return null; }
      } else {
        const probe = ctx.wb.evaluateText(sheetId, ranges[0].r1, ranges[0].c1, right);
        if (probe && typeof probe === 'object' && ['#NAME?', '#REF!'].includes(probe.error)) { refuse(rhs, t('solver.constraint.noRhs')); return null; }
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
      el('div.field', {}, el('label.field-label', { for: lhs.id }, t('solver.constraint.cellReference')), lhs),
      el('div.field.sv-rel-field', {}, el('label.field-label', { for: rel.id }, t('solver.constraint.relation')), el('div.select-wrap', {}, rel)),
      el('div.field', {}, el('label.field-label', { for: rhs.id }, t('solver.constraint.constraint')), rhs)),
    el('p.small.muted', {}, t('solver.constraint.hint')),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn', { type: 'button', onclick: () => commit(true) }, t('solver.constraint.addAnother')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: existing ? t('solver.constraint.titleChange') : t('solver.constraint.titleAdd'), content, initialFocus: lhs });
  return modal;
}

/** Solver Options: All Methods, GRG Nonlinear and Evolutionary tabs over one options object. */
function openOptions(options, onDone) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const id = (name) => fieldId(`sv-opt-${name}`);
  const num = (name, value, attrs = {}) => el('input.input.sv-num', { type: 'text', inputmode: 'decimal', id: id(name), value: value == null ? '' : numberShown(value), autocomplete: 'off', ...attrs });
  const check = (name, on) => el('input', { type: 'checkbox', id: id(name), checked: !!on });
  const f = {
    precision: num('precision', o.precision), scaling: check('scaling', o.scaling), ignoreInteger: check('ignore', o.ignoreInteger),
    integerOptimality: num('intopt', o.integerOptimality), maxTime: num('time', o.maxTime, { placeholder: t('solver.options.unlimited') }), maxIterations: num('iter', o.maxIterations, { placeholder: t('solver.options.unlimited') }),
    maxSubproblems: num('nodes', o.maxSubproblems, { placeholder: t('solver.options.unlimited') }), maxFeasible: num('feasible', o.maxFeasible, { placeholder: t('solver.options.unlimited') }),
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
      row(t('solver.options.precision'), f.precision), tick(t('solver.options.scaling'), f.scaling),
      el('fieldset.sv-opt-group', {}, el('legend', {}, t('solver.options.integerGroup')), tick(t('solver.options.ignoreInteger'), f.ignoreInteger), row(t('solver.options.integerOptimality'), f.integerOptimality)),
      el('fieldset.sv-opt-group', {}, el('legend', {}, t('solver.options.limitsGroup')), row(t('solver.options.maxTime'), f.maxTime), row(t('solver.options.iterations'), f.maxIterations)),
      el('fieldset.sv-opt-group', {}, el('legend', {}, t('solver.options.evoIntegerGroup')), row(t('solver.options.maxSubproblems'), f.maxSubproblems), row(t('solver.options.maxFeasible'), f.maxFeasible))),
    grg: el('div.sv-opt-panel', {},
      row(t('solver.options.convergence'), f.grgConvergence),
      el('fieldset.sv-opt-group', {}, el('legend', {}, t('solver.options.derivatives')), el('div.row', {}, tick(t('solver.options.forward'), f.forward), tick(t('solver.options.central'), f.central))),
      el('fieldset.sv-opt-group', {}, el('legend', {}, t('solver.options.multistart')), tick(t('solver.options.useMultistart'), f.multistart), row(t('solver.options.population'), f.grgPopulation), row(t('solver.options.seed'), f.grgSeed), tick(t('solver.options.requireBounds'), f.grgBounds))),
    evo: el('div.sv-opt-panel', {},
      row(t('solver.options.convergence'), f.evoConvergence), row(t('solver.options.mutationRate'), f.mutationRate), row(t('solver.options.population'), f.evoPopulation), row(t('solver.options.seed'), f.evoSeed),
      row(t('solver.options.maxTimeNoImprove'), f.maxTimeNoImprove), tick(t('solver.options.requireBounds'), f.evoBounds)),
  };
  const TABS = [['all', 'solver.options.allMethods'], ['grg', 'solver.engine.grg'], ['evo', 'solver.engine.evolutionary']];
  let active = 'all';
  const tabId = fieldId('sv-tabs');
  for (const [key, p] of Object.entries(panels)) { p.id = `${tabId}-${key}-panel`; p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', `${tabId}-${key}`); }
  const tabs = el('div.seg.fc-tabs.sv-tabs', { role: 'tablist', 'aria-label': t('solver.options.tabsLabel') }, TABS.map(([key, label]) => el('button.seg-btn', {
    type: 'button', role: 'tab', id: `${tabId}-${key}`, dataset: { key }, 'aria-controls': panels[key].id, onclick: () => { active = key; syncTabs(); },
  }, t(label))));
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
    const text = input.value.trim();
    if (!text) return blank ? { ok: true, v: null } : { ok: false };
    const v = typedNumber(text);
    if (v == null || (open ? v <= min : v < min) || v > max || (integer && !Number.isInteger(v))) return { ok: false };
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
    if (!take('precision', f.precision, { min: 0, max: 1, open: true }, t('solver.options.errors.precision'), 'all')) return;
    if (!take('integerOptimality', f.integerOptimality, { min: 0, max: 100 }, t('solver.options.errors.percentage'), 'all')) return;
    if (!take('maxTime', f.maxTime, { min: 0, open: true, blank: true }, t('solver.options.errors.maxTime'), 'all')) return;
    if (!take('maxIterations', f.maxIterations, { min: 1, blank: true, integer: true }, t('solver.options.errors.iterations'), 'all')) return;
    if (!take('maxSubproblems', f.maxSubproblems, { min: 1, blank: true, integer: true }, t('solver.options.errors.wholeNumber'), 'all')) return;
    if (!take('maxFeasible', f.maxFeasible, { min: 1, blank: true, integer: true }, t('solver.options.errors.wholeNumber'), 'all')) return;
    if (!take('convergence', f.grgConvergence, { min: 0, max: 1, open: true }, t('solver.options.errors.convergence'), 'grg')) return;
    if (!take('population', f.grgPopulation, { min: 10, max: 10000, integer: true }, t('solver.options.errors.population'), 'grg')) return;
    if (!take('seed', f.grgSeed, { min: 0, integer: true }, t('solver.options.errors.seed'), 'grg')) return;
    if (!take('mutationRate', f.mutationRate, { min: 0, max: 1 }, t('solver.options.errors.mutationRate'), 'evo')) return;
    if (!take('maxTimeNoImprove', f.maxTimeNoImprove, { min: 0, open: true }, t('solver.options.errors.seconds'), 'evo')) return;
    Object.assign(out, { scaling: f.scaling.checked, ignoreInteger: f.ignoreInteger.checked, derivatives: f.central.checked ? 'central' : 'forward',
      multistart: f.multistart.checked, requireBounds: f.grgBounds.checked });
    modal.close();
    onDone(out);
  };
  const content = el('form.sv-options', { onsubmit: submit }, tabs, ...Object.values(panels), alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('solver.options.title'), content });
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
    if (!ranges || ranges.length !== 1) return refuse(range, t('solver.model.loadRange'));
    const g = ranges[0];
    // A single cell stands for the column of a model saved from it down.
    const span = g.r1 === g.r2 && g.c1 === g.c2 ? { ...g, r2: g.r1 + 200 } : g;
    const out = modelFromCells(wb, sheetId, span);
    if (out.error) return refuse(range, out.error);
    if (model.objective || model.constraints.length) {
      const ok = await confirmDialog({ title: t('solver.model.loadTitle'), message: t('solver.model.loadConfirm'), confirmLabel: t('common.replace'), danger: false });
      if (!ok) return;
    }
    modal.close();
    onLoad(out.model);
  };
  const save = async () => {
    const ranges = parseRanges(wb, sheetId, range.value);
    if (!ranges || ranges.length !== 1) return refuse(range, t('solver.model.saveRange'));
    const { r1, c1 } = ranges[0];
    let used = false;
    for (let r = r1; r < r1 + need; r++) { const cell = wb.getCell(sheetId, r, c1); if (cell && (cell.v != null || cell.f != null)) used = true; }
    if (used) {
      const ok = await confirmDialog({ title: t('solver.model.saveTitle'), message: t('solver.model.saveConfirm', { count: need, cell: cellName(r1, c1) }), confirmLabel: t('common.replace'), danger: false });
      if (!ok) return;
    }
    saveModelToCells(wb, sheetId, r1, c1, model);
    modal.close();
    toast(t('solver.model.saved', { range: `${cellName(r1, c1)}:${cellName(r1 + need - 1, c1)}` }), { icon: 'check' });
  };
  const content = el('form.sv-loadsave', { onsubmit: (e) => { e.preventDefault(); load(); } },
    el('div.field', {}, el('label.field-label', { for: range.id }, t('solver.model.range')), range),
    el('p.small.muted', {}, t('solver.model.hint', { count: need })),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn', { type: 'button', onclick: save }, t('common.save')),
      el('button.btn.btn-primary', { type: 'submit' }, t('solver.model.load'))));
  const modal = openModal({ title: t('solver.model.title'), content, initialFocus: range });
}

/** The progress dialog: what the search has reached, and Stop. Returns { update(progress), close }. */
function openProgress(onStop) {
  const status = el('p.sv-progress-status', { role: 'status', 'aria-live': 'polite' }, t('solver.progress.settingUp'));
  const bar = el('div.sv-progress-bar', { 'aria-hidden': 'true' }, el('span'));
  const stop = el('button.btn.btn-primary', { type: 'button', onclick: () => { stop.disabled = true; stop.textContent = t('solver.progress.stopping'); onStop(); } }, t('solver.progress.stop'));
  const content = el('div.sv-progress', {}, bar, status, el('div.row.row-end', {}, stop));
  const modal = openModal({ title: t('solver.progress.title'), content, initialFocus: stop });
  const format = (v) => (Number.isFinite(v) ? formatNumber(Number(v.toPrecision(8)), { maximumFractionDigits: 8 }) : '—');
  return {
    update(p) {
      const parts = [];
      if (p.phase === 'linear') parts.push(t('solver.progress.measuring'));
      if (p.subproblems) parts.push(t('solver.progress.subproblem', { n: p.subproblems }));
      if (p.evals) parts.push(t('solver.progress.trial', { n: p.evals }));
      if (p.objective != null) parts.push(t('solver.progress.objective', { value: format(p.objective) }));
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
    return el('label.check', { for: box.id, title: allowed.includes(key) ? null : key === 'answer' ? t('solver.results.noSolution') : t('solver.results.continuousOnly') }, box, el('span', {}, t(label)));
  });
  const done = (apply) => {
    if (apply) {
      const reports = reportBoxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
      const { reportSheetIds } = applySolverResult(wb, prepared, result, { keep: keep.checked && result.ok, reports });
      if (reportSheetIds.length) toast(t('solver.results.reportsAdded', { count: reportSheetIds.length }), { icon: 'check' });
    } else {
      applySolverResult(wb, prepared, result, { keep: false });
    }
    const again = back.checked;
    modal.close();
    if (again) onReturn();
  };
  const saveAsScenario = async () => {
    if (!result.x) return;
    const name = await promptDialog({ title: t('solver.results.saveScenarioTitle'), label: t('solver.results.scenarioName'), confirmLabel: t('common.save') });
    if (!name) return;
    const problem = saveScenario(wb, sheetId, { name, cells: prepared.vars.map((v) => ({ r: v.r, c: v.c })), values: result.x, comment: `Created by Solver on ${new Date().toLocaleDateString()}` });
    if (problem) toast(problem, { icon: 'alert' });
    else toast(t('solver.results.scenarioSaved', { name }), { icon: 'check' });
  };
  const detail = result.solved && prepared.model.engine === 'grg' && result.status === 'localOptimal'
    ? t('solver.results.grgNote')
    : result.status === 'optimal' && prepared.model.engine === 'simplex' ? t('solver.results.simplexNote') : null;
  const content = el('form.sv-results', { onsubmit: (e) => { e.preventDefault(); done(true); } },
    el('p.modal-text.sv-result-message', { 'data-status': result.status }, solverMessageShown(result.status)),
    detail && el('p.small.muted', {}, detail),
    el('div.sv-results-grid', {},
      el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('solver.results.values')),
        el('label.check', { for: keep.id }, keep, el('span', {}, t('solver.results.keep'))),
        el('label.check', { for: restore.id }, restore, el('span', {}, t('solver.results.restore')))),
      el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('solver.results.reports')), ...reportBoxes)),
    el('label.check', { for: back.id }, back, el('span', {}, t('solver.results.returnToParameters'))),
    el('p.small.muted.sv-result-stats', {}, [t('solver.results.seconds', { seconds: result.seconds.toFixed(2) }), t('solver.results.trialSolutions', { count: result.evals }), result.iterations && t('solver.results.iterations', { count: result.iterations }), result.subproblems && t('solver.results.subproblems', { count: result.subproblems })].filter(Boolean).join(' · ')),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost.sv-scenario', { type: 'button', disabled: !result.x, onclick: saveAsScenario }, t('solver.results.saveScenario')),
      el('span.sv-spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => done(false) }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('solver.results.title'), content, onClose: () => ctx.grid?.focus?.() });
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
  const goals = Object.fromEntries(['max', 'min', 'value'].map((key) => [key, el('input', { type: 'radio', name: goalName, id: fieldId(`sv-goal-${key}`), value: key, checked: model.goal === key })]));
  const value = el('input.input.sv-value', { type: 'text', inputmode: 'decimal', id: fieldId('sv-val'), value: numberShown(Number(model.value ?? 0)), 'aria-label': t('solver.valueOf'), autocomplete: 'off', disabled: model.goal !== 'value' });
  for (const radio of Object.values(goals)) radio.addEventListener('change', () => { value.disabled = !goals.value.checked; });
  const variables = el('input.input', { type: 'text', id: fieldId('sv-adj'), value: model.variables, autocomplete: 'off', spellcheck: false, placeholder: t('solver.variablesExample') });
  const list = el('select.select.sm-list.sv-list', { size: 7, id: fieldId('sv-list'), 'aria-label': t('solver.constraints') });
  const empty = el('p.small.muted.sm-empty.sv-empty', {}, t('solver.noConstraints'));
  const nonNegative = el('input', { type: 'checkbox', id: fieldId('sv-neg'), checked: model.nonNegative !== false });
  const engine = el('select.select', { id: fieldId('sv-eng') }, ...ENGINES.map(([key]) => el('option', { value: key }, t(ENGINE_LABELS[key]))));
  engine.value = model.engine;
  const note = el('p.small.muted.sv-engine-note', { id: fieldId('sv-note') }, t(ENGINE_NOTES[model.engine]));
  engine.setAttribute('aria-describedby', note.id);
  engine.addEventListener('change', () => { note.textContent = t(ENGINE_NOTES[engine.value]); });
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
    objective: objective.value.trim(), goal: Object.entries(goals).find(([, r]) => r.checked)?.[0] || 'max', value: value.value.trim() === '' ? 0 : typedNumber(value.value) ?? NaN,
    variables: variables.value.trim(), constraints: constraints.map((k) => ({ ...k })), nonNegative: nonNegative.checked, engine: engine.value, options: { ...options },
  });
  const add = () => openConstraintEditor(ctx, null, (k, again) => { constraints.push(k); sync(constraints.length - 1); if (again) add(); else list.focus(); });
  buttons.add = el('button.btn', { type: 'button', onclick: add }, t('solver.add'));
  buttons.change = el('button.btn', { type: 'button', onclick: () => {
    const i = list.selectedIndex;
    if (i < 0) return;
    openConstraintEditor(ctx, constraints[i], (k, again) => { constraints[i] = k; sync(i); if (again) add(); else list.focus(); });
  } }, t('solver.change'));
  buttons.remove = el('button.btn', { type: 'button', onclick: () => { const i = list.selectedIndex; if (i < 0) return; constraints.splice(i, 1); sync(i); (constraints.length ? list : buttons.add).focus(); } }, t('common.delete'));
  buttons.reset = el('button.btn', { type: 'button', onclick: async () => {
    const ok = await confirmDialog({ title: t('solver.resetAll'), message: t('solver.resetConfirm'), confirmLabel: t('common.reset'), danger: true });
    if (!ok) return;
    const blank = emptyModel();
    objective.value = ''; variables.value = ''; goals.max.checked = true; value.value = numberShown(0); value.disabled = true;
    nonNegative.checked = true; engine.value = blank.engine; note.textContent = t(ENGINE_NOTES[blank.engine]);
    options = { ...DEFAULT_OPTIONS }; constraints = [];
    sync();
    objective.focus();
  } }, t('solver.resetAll'));
  buttons.loadSave = el('button.btn', { type: 'button', onclick: () => openLoadSave(ctx, current(), (m) => {
    objective.value = m.objective; variables.value = m.variables; goals[m.goal].checked = true; value.value = numberShown(Number(m.value ?? 0)); value.disabled = m.goal !== 'value';
    nonNegative.checked = m.nonNegative !== false; engine.value = m.engine; note.textContent = t(ENGINE_NOTES[m.engine]);
    options = { ...DEFAULT_OPTIONS, ...m.options }; constraints = m.constraints.map((k) => ({ ...k }));
    sync(0);
  }) }, t('solver.loadSave'));
  list.addEventListener('dblclick', () => buttons.change.click());
  list.addEventListener('keydown', (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); buttons.remove.click(); } });
  const optionsBtn = el('button.btn', { type: 'button', onclick: () => openOptions(options, (next) => { options = { ...options, ...next }; }) }, t('solver.optionsButton'));
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
    if (m.goal === 'value' && !Number.isFinite(m.value)) return refuse(value, t('coreSolver.errors.value'));
    const prepared = prepareSolver(wb, sheetId, m);
    if (prepared.error) {
      const field = { objective, variables, value, constraint: list }[prepared.field] || null;
      if (prepared.field === 'constraint' && Number.isInteger(prepared.index)) list.selectedIndex = prepared.index;
      return refuse(field, prepared.shown ?? prepared.error);
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
      toast(err?.message ? t('solver.stoppedWith', { message: err.message }) : t('solver.stoppedUnexpected'), { icon: 'alert', duration: 5000 });
    });
  };

  const field = (label, control, extra = null) => el('div.field', {}, el('label.field-label', { for: control.id }, label), control, extra);
  const content = el('form.sv-dialog', { onsubmit: solve },
    field(t('solver.setObjective'), objective),
    el('div.sv-goal', { role: 'radiogroup', 'aria-labelledby': `${goalName}-label` }, el('span.field-label.sv-goal-label', { id: `${goalName}-label` }, t('solver.to')),
      el('label.check', { for: goals.max.id }, goals.max, el('span', {}, t('solver.max'))),
      el('label.check', { for: goals.min.id }, goals.min, el('span', {}, t('solver.min'))),
      el('label.check', { for: goals.value.id }, goals.value, el('span', {}, t('solver.valueOf'))), value),
    field(t('solver.variables'), variables, el('span.small.muted', {}, t('solver.variablesHint'))),
    el('div.sv-constraints', {},
      el('div.sv-list-wrap', {}, el('label.field-label', { for: list.id }, t('solver.subjectTo')), list, empty),
      el('div.sm-buttons.sv-buttons', {}, buttons.add, buttons.change, buttons.remove, buttons.reset, buttons.loadSave)),
    el('label.check', { for: nonNegative.id }, nonNegative, el('span', {}, t('solver.nonNegative'))),
    el('div.sv-engine', {},
      el('div.field', {}, el('label.field-label', { for: engine.id }, t('solver.method')), el('div.sv-engine-row', {}, el('div.select-wrap', {}, engine), optionsBtn)),
      note),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: close }, t('common.close')),
      el('button.btn.btn-primary', { type: 'submit' }, t('solver.solve'))));
  const modal = openModal({ title: t('solver.title'), content, wide: true, initialFocus: objective, onClose: () => { if (!closingTo) ctx.grid?.focus?.(); } });
  sync(0);
  return modal;
}
