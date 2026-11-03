// Partial payments: record a payment against an expense, or set who has paid so far and when the rest is due.
import { el, uid } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { moneyInput, parseMoney } from '../../../../lib/costs/input.js';
import { localToday } from '../../../../lib/costs/fx.js';
import { paymentPatch, planPatch } from '../../../../lib/costs/due.js';
import { addDays, isDate } from '../../../../shared/dates.js';
import { attempt, errorText, money } from '../shared.js';

const paidOf = (exp) => exp.payers.reduce((sum, payer) => sum + payer.amount, 0);
const roster = (people, exp) => [...new Set([...people.list.map((person) => person.id), ...exp.payers.map((payer) => payer.who), ...exp.split.parts.map((part) => part.who)])];

function labelled(label, control, hint) {
  control.id ||= uid('cx');
  const hintNode = hint ? el('span.field-hint', { id: `${control.id}-hint` }, hint) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
  return el('div.field', {}, el('label.field-label', { htmlFor: control.id }, label), control, hintNode);
}

/** Adds a payment toward what is left of a partially paid (or unpaid, with a due date) expense. */
export function openRecordPayment({ space, people, track, id }) {
  const entity = space.get('exp', id);
  if (!entity) return null;
  const locale = displayLocale();
  const left = entity.amount - paidOf(entity);
  const who = el('select.select', {}, roster(people, entity).map((person) => el('option', { value: person }, people.name(person))));
  who.value = entity.payers[0]?.who ?? people.me;
  const amount = el('input.input.num', { inputMode: 'decimal', autocomplete: 'off', value: moneyInput(left, entity.currency, locale) });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const save = button(t('costExtras.recordSave'), { variant: 'primary', type: 'submit' });
  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    const fail = (message) => { error.textContent = message; error.hidden = false; amount.focus(); };
    const current = space.get('exp', id);
    if (!current) { dialog.close('gone'); return; }
    let value;
    try { value = parseMoney(amount.value, current.currency, locale); } catch { fail(t('costExtras.errorAmount')); return; }
    const remaining = current.amount - paidOf(current);
    if (!value) { fail(t('costExtras.errorAmount')); return; }
    if (Math.abs(value) > Math.abs(remaining)) { fail(t('costExtras.errorTooMuch', { left: money(remaining, current.currency) })); return; }
    let patch;
    try { patch = paymentPatch(current, { who: who.value, amount: value }); } catch { fail(t('costExtras.errorPaid')); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      await space.apply([space.ops.patch('exp', id, patch, { base: true })], { history: t('costExtras.historyPayment') });
      toast(patch.unset.includes('due') ? t('costExtras.recordedFull') : t('costExtras.recorded'), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
      dialog.close('saved');
    } catch (cause) { fail(errorText(cause)); } finally { save.setAttribute('aria-busy', 'false'); }
  }
  const form = el('form.costs-form', { onsubmit: submit, noValidate: true },
    el('p.field-hint', {}, t('costExtras.recordLeft', { left: money(left, entity.currency) })),
    el('div.field-row', {}, labelled(t('costExtras.recordWho'), who), labelled(t('costExtras.recordAmount'), amount)),
    error, el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  const dialog = track(openModal({ title: t('costExtras.recordTitle', { name: entity.name }), content: form, initialFocus: amount }));
  return dialog;
}

/** Sets what each person has paid so far and the date the rest is due. */
export function openPaymentPlan({ space, people, track, id }) {
  const entity = space.get('exp', id);
  if (!entity) return null;
  const locale = displayLocale();
  const list = roster(people, entity);
  const due = el('input.input', { type: 'date', required: true, value: isDate(entity.due) ? entity.due : addDays(entity.date && entity.date > localToday() ? entity.date : localToday(), 14) });
  const inputs = new Map();
  const status = el('p.field-hint.costs-status', { 'aria-live': 'polite' });
  const rows = el('div.costs-rows', {}, list.map((person) => {
    const stored = entity.payers.find((payer) => payer.who === person);
    const input = el('input.input.num.costs-value', { inputMode: 'decimal', autocomplete: 'off', value: stored ? moneyInput(stored.amount, entity.currency, locale) : '',
      'aria-label': t('costExtras.planPaid', { name: people.name(person) }), oninput: update });
    inputs.set(person, input);
    return el('div.costs-row', {}, people.avatar(person, 24), el('span.costs-row-name', {}, people.name(person)), input);
  }));
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const save = button(t('costExtras.planSave'), { variant: 'primary', type: 'submit' });

  function read() {
    const payers = [];
    for (const [person, input] of inputs) {
      if (!input.value.trim()) continue;
      payers.push({ who: person, amount: parseMoney(input.value, entity.currency, locale) });
    }
    return payers;
  }
  function update() {
    try {
      const paid = paidOf({ payers: read() });
      status.textContent = t('costExtras.planStatus', { paid: money(paid, entity.currency), left: money(entity.amount - paid, entity.currency) });
    } catch { status.textContent = ''; }
  }
  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    const fail = (message, control) => { error.textContent = message; error.hidden = false; control?.focus(); };
    if (!isDate(due.value)) { fail(t('costExtras.errorDue'), due); return; }
    let payers;
    try { payers = read(); } catch { fail(t('costExtras.errorAmount')); return; }
    const current = space.get('exp', id);
    if (!current) { dialog.close('gone'); return; }
    let patch;
    try { patch = planPatch(current, { payers, due: due.value }); } catch { fail(t('costExtras.errorPaid')); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      await space.apply([space.ops.patch('exp', id, patch, { base: true })], { history: t('costExtras.historyPlan') });
      toast(t('costExtras.planSaved'), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
      dialog.close('saved');
    } catch (cause) { fail(errorText(cause)); } finally { save.setAttribute('aria-busy', 'false'); }
  }
  const form = el('form.costs-form', { onsubmit: submit, noValidate: true },
    el('p', {}, t('costExtras.planIntro')),
    labelled(t('costExtras.planDue'), due),
    el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costs.paidBy')), rows, status),
    el('p.field-hint', {}, t('costExtras.balancesNote')),
    error, el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  update();
  const dialog = track(openModal({ title: t('costExtras.planTitle', { name: entity.name }), content: form, wide: true }));
  return dialog;
}
