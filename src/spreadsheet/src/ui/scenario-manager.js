/**
 * Data ▸ What-If Analysis ▸ Scenario Manager: the list of the sheet's scenarios with Add, Delete,
 * Edit, Merge and Summary, and Show to put a scenario's values into its changing cells.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { parseInput, editText } from '../core/format.js';
import { cellsText, parseChangingCells, saveScenario, deleteScenario, showScenario, mergeScenarios, createScenarioSummary,
  currentValues, scenarioCheck, scenarioLocked, scenarioHidden, MAX_CHANGING_CELLS } from '../core/scenarios.js';
import { t } from '../i18n/index.js';

const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' });
/** A stored value as the Values step shows it: as a cell opened for editing would, so it reads back as itself in
 * the regional format (1,5 where the decimal mark is a comma, text that looks like a number with its apostrophe). */
const valueText = (v) => editText(v == null || v === '' ? null : { v, f: null });

/** Selected cells as the changing cells a new scenario starts with. */
function selectionCells(ctx) {
  const out = [];
  for (const g of ctx.ranges?.() || [ctx.range()]) {
    for (let r = g.r1; r <= g.r2 && out.length <= MAX_CHANGING_CELLS; r++) for (let c = g.c1; c <= g.c2 && out.length <= MAX_CHANGING_CELLS; c++) out.push({ r, c });
  }
  return out;
}

/** Step two of Add and Edit: a value for each changing cell. */
function openValues(ctx, draft, { replacing, onDone }) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const start = draft.values?.length === draft.cells.length ? draft.values : currentValues(wb, sheetId, draft.cells);
  const inputs = draft.cells.map((p, i) => el('input.input', { type: 'text', value: valueText(start[i]), autocomplete: 'off', spellcheck: false,
    'aria-label': t('scenarioManager.values.valueFor', { cell: cellsText([p]) }) }));
  const { alert, refuse } = fieldAlert('scenario-values');
  const collect = () => {
    const values = [];
    for (const input of inputs) {
      const text = input.value.trim();
      if (text.startsWith('=')) { refuse(input, t('scenarioManager.values.noFormula')); return null; }
      const v = parseInput(text).v;
      values.push(v == null ? '' : v);
    }
    return values;
  };
  const commit = (again) => {
    const values = collect();
    if (!values) return;
    const problem = saveScenario(wb, sheetId, { ...draft, values }, replacing);
    if (problem) return refuse(null, problem);
    modal.close();
    onDone?.(draft.name);
    if (again) openScenarioEditor(ctx, null, { onDone });
  };
  const content = el('form.sm-values', { onsubmit: (e) => { e.preventDefault(); commit(false); } },
    el('p.small.muted', {}, t('scenarioManager.values.intro')),
    el('div.sm-values-list', {}, ...draft.cells.map((p, i) => el('label.sm-value-row', {}, el('span.sm-value-index', {}, t('scenarioManager.values.index', { n: i + 1 })), el('span.sm-value-cell', {}, cellsText([p])), inputs[i]))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      replacing == null ? el('button.btn', { type: 'button', onclick: () => commit(true) }, t('common.add')) : null,
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('scenarioManager.values.title'), content, initialFocus: inputs[0] });
}

/** Add Scenario / Edit Scenario: name, changing cells, comment and protection. */
export function openScenarioEditor(ctx, existing, { onDone } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const name = el('input.input', { type: 'text', id: fieldId('sm-name'), value: existing?.name || '', autocomplete: 'off', maxLength: 255 });
  const cells = el('input.input', { type: 'text', id: fieldId('sm-cells'), value: cellsText(existing?.cells || selectionCells(ctx)), autocomplete: 'off', spellcheck: false });
  const comment = el('textarea.input.sm-comment', { id: fieldId('sm-comment'), rows: 3 });
  comment.value = existing ? existing.comment : `Created on ${today()}`;
  const prevent = el('input', { type: 'checkbox', id: fieldId('sm-lock'), checked: existing ? existing.locked : true });
  const hide = el('input', { type: 'checkbox', id: fieldId('sm-hide'), checked: !!existing?.hidden });
  const { alert, refuse } = fieldAlert('scenario-edit');
  const submit = async (e) => {
    e.preventDefault();
    const list = parseChangingCells(cells.value);
    if (!list) return refuse(cells, t('scenarioManager.edit.badCells'));
    let editComment = comment.value;
    if (existing && existing.comment === editComment && existing.name) editComment = `${existing.comment}${existing.comment ? '\n' : ''}Modified on ${today()}`;
    const draft = { name: name.value.trim(), cells: list, comment: editComment, locked: prevent.checked, hidden: hide.checked,
      values: existing && JSON.stringify(existing.cells) === JSON.stringify(list) ? existing.values : null };
    const problem = scenarioCheck(wb, sheetId, { ...draft, values: [] }, existing?.name ?? null);
    if (problem) return refuse(problem.field === 'cells' ? cells : name, problem.message);
    // A scenario holds values: showing one writes them over a formula in a changing cell, so that is said first, as Excel says it.
    if (list.some((p) => wb.getCell(sheetId, p.r, p.c)?.f != null) && !await confirmDialog({ title: existing ? t('scenarioManager.edit.titleEdit') : t('scenarioManager.edit.titleAdd'),
      message: t('scenarioManager.edit.formulaWarning'), confirmLabel: t('common.ok'), danger: false })) return;
    modal.close();
    openValues(ctx, draft, { replacing: existing?.name ?? null, onDone });
  };
  const content = el('form.sm-edit', { onsubmit: submit },
    el('div.field', {}, el('label.field-label', { for: name.id }, t('scenarioManager.edit.name')), name),
    el('div.field', {}, el('label.field-label', { for: cells.id }, t('scenarioManager.changingCells')), cells,
      el('span.small.muted', {}, t('scenarioManager.edit.cellsHint'))),
    el('div.field', {}, el('label.field-label', { for: comment.id }, t('scenarioManager.comment')), comment),
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('scenarioManager.edit.protection')),
      el('label.check', { for: prevent.id }, prevent, el('span', {}, t('scenarioManager.edit.preventChanges'))),
      el('label.check', { for: hide.id }, hide, el('span', {}, t('scenarioManager.edit.hide')))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: existing ? t('scenarioManager.edit.titleEdit') : t('scenarioManager.edit.titleAdd'), content, initialFocus: name });
  return modal;
}

function openMerge(ctx, onDone) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const others = wb.sheets.filter((s) => s.id !== sheetId && s.kind !== 'chart');
  const list = el('select.select.sm-list', { size: 6, 'aria-label': t('scenarioManager.merge.sheet') }, ...others.map((s) => el('option', { value: s.id }, s.name)));
  const note = el('p.small.muted', {}, '');
  const describe = () => {
    const s = wb.sheet(list.value);
    const n = s?.scenarios?.list?.length || 0;
    note.textContent = s ? t('scenarioManager.merge.count', { count: n }) : '';
  };
  list.addEventListener('change', describe);
  if (others.length) { list.selectedIndex = 0; describe(); }
  const { alert, refuse } = fieldAlert('scenario-merge');
  const submit = (e) => {
    e.preventDefault();
    if (!list.value) return refuse(list, t('scenarioManager.merge.noSheet'));
    const n = mergeScenarios(wb, sheetId, list.value);
    if (!n) return refuse(list, t('scenarioManager.merge.noScenarios'));
    modal.close();
    onDone?.();
  };
  const content = el('form', { onsubmit: submit },
    el('div.field', {}, el('span.field-label', {}, t('scenarioManager.merge.from')), list), note, alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('scenarioManager.merge.title'), content, initialFocus: list });
}

function openSummary(ctx, close) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const state = wb.sheet(sheetId)?.scenarios;
  const summary = el('input', { type: 'radio', name: fieldId('sm-report'), id: fieldId('sm-summary'), checked: true });
  const pivot = el('input', { type: 'radio', name: fieldId('sm-report'), id: fieldId('sm-pivot'), disabled: true });
  const last = state?.results?.length ? state.results.map((g) => cellsText([{ r: g.r1, c: g.c1 }]) + (g.r2 !== g.r1 || g.c2 !== g.c1 ? `:${cellsText([{ r: g.r2, c: g.c2 }])}` : '')).join(',') : '';
  const results = el('input.input', { type: 'text', id: fieldId('sm-results'), value: last || cellsText([ctx.active()]), autocomplete: 'off', spellcheck: false });
  const { alert, refuse } = fieldAlert('scenario-summary');
  const submit = (e) => {
    e.preventDefault();
    const text = results.value.trim();
    const cells = text ? parseChangingCells(text) : [];
    if (!cells) return refuse(results, t('scenarioManager.summary.badCells'));
    const out = createScenarioSummary(wb, sheetId, cells);
    if (out.error) return refuse(null, out.error);
    modal.close();
    close();
    wb.setActiveSheet(out.sheetId);
    toast(t('scenarioManager.summary.created'), { icon: 'check' });
  };
  const content = el('form', { onsubmit: submit },
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('scenarioManager.summary.reportType')),
      el('label.check', { for: summary.id }, summary, el('span', {}, t('scenarioManager.summary.summary'))),
      el('label.check', { for: pivot.id, title: t('scenarioManager.summary.notAvailable') }, pivot, el('span', {}, t('scenarioManager.summary.pivot')))),
    el('div.field', {}, el('label.field-label', { for: results.id }, t('scenarioManager.summary.resultCells')), results),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('scenarioManager.summary.title'), content, initialFocus: results });
}

export function openScenarioManager(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const listBox = el('select.select.sm-list', { size: 8, 'aria-label': t('scenarioManager.scenarios') });
  const cellsOut = el('output.sm-detail');
  const commentOut = el('output.sm-detail.sm-detail-comment');
  const empty = el('p.small.muted.sm-empty', {}, t('scenarioManager.empty'));
  // On a protected sheet a hidden scenario is not listed, and one with Prevent changes cannot be edited or deleted.
  const scenarios = () => (wb.sheet(sheetId)?.scenarios?.list || []).filter((s) => !scenarioHidden(wb, sheetId, s));
  const selected = () => scenarios().find((s) => s.name === listBox.value) || null;
  const buttons = {};
  const sync = (keep) => {
    const list = scenarios();
    const pick = keep ?? listBox.value;
    listBox.replaceChildren(...list.map((s) => el('option', { value: s.name }, s.name)));
    const at = Math.max(0, list.findIndex((s) => s.name === pick));
    if (list.length) listBox.selectedIndex = at;
    empty.hidden = !!list.length;
    listBox.hidden = !list.length;
    const s = selected();
    cellsOut.textContent = s ? cellsText(s.cells) : '';
    commentOut.textContent = s ? s.comment : '';
    for (const key of ['delete', 'edit', 'show']) buttons[key].disabled = !s || (key !== 'show' && scenarioLocked(wb, sheetId, s));
    buttons.summary.disabled = !list.length;
  };
  listBox.addEventListener('change', () => sync());
  listBox.addEventListener('dblclick', () => show());
  const show = () => {
    const s = selected();
    if (!s) return;
    showScenario(wb, sheetId, s.name);
    sync(s.name);
  };
  buttons.add = el('button.btn', { type: 'button', onclick: () => openScenarioEditor(ctx, null, { onDone: (name) => sync(name) }) }, t('scenarioManager.add'));
  // Deleting the last scenario turns Delete off and hides the list: the focus goes on to Add rather than to the page.
  buttons.delete = el('button.btn', { type: 'button', onclick: () => { const s = selected(); if (s && deleteScenario(wb, sheetId, s.name)) { sync(); if (buttons.delete.disabled) (listBox.hidden ? buttons.add : listBox).focus(); } } }, t('common.delete'));
  buttons.edit = el('button.btn', { type: 'button', onclick: () => { const s = selected(); if (s) openScenarioEditor(ctx, s, { onDone: (name) => sync(name) }); } }, t('scenarioManager.editButton'));
  buttons.merge = el('button.btn', { type: 'button', onclick: () => openMerge(ctx, () => sync()) }, t('scenarioManager.mergeButton'));
  buttons.summary = el('button.btn', { type: 'button', onclick: () => openSummary(ctx, () => modal.close()) }, t('scenarioManager.summaryButton'));
  buttons.show = el('button.btn.btn-primary', { type: 'button', onclick: show }, t('common.show'));
  const content = el('div.sm-manager', {},
    el('div.sm-top', {},
      el('div.sm-list-wrap', {}, el('span.field-label', {}, t('scenarioManager.scenariosLabel')), listBox, empty),
      el('div.sm-buttons', {}, buttons.add, buttons.delete, buttons.edit, buttons.merge, buttons.summary)),
    el('div.sm-details', {},
      el('span.field-label', {}, t('scenarioManager.changingCells')), cellsOut,
      el('span.field-label', {}, t('scenarioManager.comment')), commentOut),
    el('div.row.row-end', {}, buttons.show, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.close'))));
  // The list and buttons are set before the dialog opens, so the focus starts on a control that is shown and on.
  sync();
  const modal = openModal({ title: t('scenarioManager.title'), content, initialFocus: listBox.hidden ? buttons.add : listBox, onClose: () => ctx.grid?.focus?.() });
  return { ...modal, select: (name) => sync(name), refresh: () => sync() };
}
