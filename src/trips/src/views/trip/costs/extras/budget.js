// The budget planner: planned amounts per category and for the trip, edited in one dialog, shown in the Overview.
import { el, uid, append, clear } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { moneyInput, parseMoney } from '../../../../lib/costs/input.js';
import { localToday } from '../../../../lib/costs/fx.js';
import { budgetDuplicates, budgetEntries, budgetPlan } from '../../../../lib/costs/budget.js';
import { categoryBadge, categoryLabel, errorText, money } from '../shared.js';

/** The planner's numbers for the current model. */
export function planOf(space, model, today = localToday()) {
  return budgetPlan({ budgets: space.select.budget?.all?.() ?? [], byCategory: model.balances.byCategory, spend: model.balances.spend, categories: model.categories, meta: model.meta, today });
}

/** One dialog for the trip total and every category. Empty fields remove a budget. */
export function openBudgetEditor({ space, getModel, track }) {
  const model = getModel();
  const locale = displayLocale();
  const currency = model.tripCurrency;
  const budgets = space.select.budget?.all?.() ?? [];
  const entries = budgetEntries(budgets);
  const inputs = new Map();
  const input = (key, label) => {
    const stored = entries.get(key);
    const node = el('input.input.num.costs-value', { id: uid('cx-budget'), inputMode: 'decimal', autocomplete: 'off', value: stored ? moneyInput(stored.amount, currency, locale) : '', 'aria-label': label });
    inputs.set(key, node);
    return node;
  };
  const total = input('', t('costExtras.budgetTotal'));
  const rows = model.categories.map((cat) => el('div.costs-row', {}, categoryBadge(cat), el('span.costs-row-name', {}, categoryLabel(cat, space)), input(cat, categoryLabel(cat, space))));
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const save = button(t('ui.save'), { variant: 'primary', type: 'submit' });

  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    const ops = [];
    for (const [key, node] of inputs) {
      const text = node.value.trim();
      const stored = entries.get(key);
      if (!text) { if (stored) ops.push(space.ops.remove('budget', stored.id)); continue; }
      let amount;
      try { amount = parseMoney(text, currency, locale); } catch { amount = null; }
      if (!Number.isSafeInteger(amount) || amount < 0) { error.textContent = t('costExtras.budgetInvalid'); error.hidden = false; node.focus(); return; }
      if (!stored) ops.push(space.ops.create('budget', key ? { cat: key, amount } : { amount }));
      else if (stored.amount !== amount) ops.push(space.ops.patch('budget', stored.id, { set: { amount } }));
    }
    for (const extra of budgetDuplicates(budgets)) ops.push(space.ops.remove('budget', extra.id));
    if (!ops.length) { dialog.close('saved'); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      await space.apply(ops, { history: t('costExtras.historyBudget') });
      toast(t('costExtras.budgetSaved'));
      dialog.close('saved');
    } catch (cause) { error.textContent = errorText(cause); error.hidden = false; } finally { save.setAttribute('aria-busy', 'false'); }
  }
  const form = el('form.costs-form', { onsubmit: submit, noValidate: true },
    el('p.field-hint', {}, t('costExtras.budgetIntro', { currency })),
    el('div.field', {}, el('label.field-label', { htmlFor: total.id }, t('costExtras.budgetTotal')), total, el('span.field-hint', {}, t('costExtras.budgetTotalHint'))),
    el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costExtras.budgetCategories')), el('div.costs-rows', {}, rows)),
    error, el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  const dialog = track(openModal({ title: t('costExtras.budgetDialog'), content: form, wide: true }));
  return dialog;
}

function bar(spent, planned) {
  const ratio = planned ? Math.max(0, spent) / planned : 0;
  return el('span.costs-bar.cx-budget-bar', { 'aria-hidden': 'true', dataset: { over: String(ratio > 1) } },
    el('span.costs-bar-fill', { style: { inlineSize: `${Math.min(100, Math.max(2, Math.round(ratio * 100)))}%` } }));
}

/** The Overview's budget block. */
export function createBudgetSection({ space, getModel, track }) {
  const element = el('section.costs-block.cx-budget');
  const headingId = uid('cx-budget');
  function render() {
    const model = getModel();
    const currency = model.tripCurrency;
    const plan = planOf(space, model);
    const edit = model.canEdit ? button(plan.planned === null ? t('costExtras.budgetPlan') : t('costExtras.budgetEdit'), { size: 'sm', variant: plan.planned === null ? 'outline' : 'ghost',
      dataset: { focus: 'budget' }, onclick: () => openBudgetEditor({ space, getModel, track }) }) : null;
    const head = el('div.costs-heading-row', {}, el('h2.costs-heading', { id: headingId }, t('costExtras.budgetTitle')), edit);
    if (plan.planned === null) {
      element.replaceChildren(head, el('p.field-hint', {}, t('costExtras.budgetEmpty')));
      return;
    }
    const status = plan.left >= 0 ? t('costExtras.budgetLeft', { amount: money(plan.left, currency) }) : t('costExtras.budgetOver', { amount: money(-plan.left, currency) });
    const { timeline } = plan;
    const phase = timeline.phase === 'before' ? t('costExtras.budgetBefore') : timeline.phase === 'after' ? t('costExtras.budgetAfter') : null;
    const perDay = plan.perDay !== null && timeline.phase === 'during'
      ? t(timeline.left === 1 ? 'costExtras.budgetPerDayOne' : 'costExtras.budgetPerDay', { amount: money(plan.perDay, currency), days: new Intl.NumberFormat(displayLocale()).format(timeline.left) }) : null;
    const unplanned = plan.categories.filter((row) => row.planned === null).reduce((sum, row) => sum + row.spent, 0);
    append(clear(element), [head,
      el('div.cx-budget-total', { dataset: { over: String(plan.over) } },
        el('p.costs-totals', {}, el('span', {}, t('costExtras.budgetSpentOf', { spent: money(plan.spent, currency), planned: money(plan.planned, currency) })), el('strong.num', {}, status)),
        bar(plan.spent, plan.planned)),
      perDay ? el('p.field-hint', {}, perDay) : phase ? el('p.field-hint', {}, phase) : null,
      plan.categories.some((row) => row.planned !== null) ? el('ul.card.costs-bars', { 'aria-labelledby': headingId }, plan.categories.filter((row) => row.planned !== null).map((row) => el('li.costs-bar-row', { dataset: { over: String(row.over) } },
        categoryBadge(row.cat), el('span.costs-bar-label', {}, el('span', {}, categoryLabel(row.cat, space))), bar(row.spent, row.planned),
        el('span.costs-bar-value', {}, el('span.num', {}, t('costExtras.budgetSpentOf', { spent: money(row.spent, currency), planned: money(row.planned, currency) })),
          el('span.field-hint.num.cx-budget-state', {}, row.left >= 0 ? t('costExtras.budgetLeft', { amount: money(row.left, currency) }) : t('costExtras.budgetOver', { amount: money(-row.left, currency) })))))) : null,
      unplanned && plan.categories.some((row) => row.planned !== null) ? el('p.field-hint', {}, t('costExtras.budgetUnplanned', { amount: money(unplanned, currency) })) : null,
      plan.unallocated ? el('p.field-hint', {}, t('costExtras.budgetUnallocated', { amount: money(plan.unallocated, currency) })) : null,
      model.privates.length ? el('p.field-hint', {}, t('costExtras.budgetShared')) : null]);
  }
  return { element, render };
}

