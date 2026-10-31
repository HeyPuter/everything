import { el, uid, append, clear } from '../../../ui/dom.js';
import { button, emptyState } from '../../../ui/bits.js';
import { openModal } from '../../../ui/modal.js';
import { makeSortable } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { add } from '../../../lib/costs/ledger.js';
import { isBuiltinCategory } from '../../../lib/costs/categories.js';
import { orderKeys } from '../../../shared/order.js';
import { attempt, categoryBadge, categoryLabel, money } from './shared.js';
import { icon } from './icons.js';
import { createBudgetSection, createDueSection } from './extras/index.js';

/** Drag or Alt+Arrow the categories into a new display order, saved as `costCat` entities. */
export function openCategoryOrder({ space, model, track }) {
  let order = [...model.categories];
  const list = el('ul.card.costs-order', {}, order.map((cat) => el('li.costs-line', { dataset: { sortableItem: '', label: categoryLabel(cat, space), cat } },
    el('button.icon-btn.icon-btn-sm.sortable-grip.is-visible', { type: 'button', dataset: { sortableHandle: '' } }, icon('grip', 16)),
    categoryBadge(cat), el('span', {}, categoryLabel(cat, space)))));
  const sortable = makeSortable(list, { onMove: () => { order = [...list.querySelectorAll('[data-cat]')].map((node) => node.dataset.cat); } });
  async function save() {
    const keys = orderKeys(order.length);
    const existing = new Map();
    const extras = [];
    for (const entry of [...space.select.costCat.all()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))) {
      if (existing.has(entry.cat) || !isBuiltinCategory(entry.cat)) extras.push(entry); else existing.set(entry.cat, entry);
    }
    const ops = order.flatMap((cat, index) => {
      const entry = existing.get(cat);
      if (!entry) return [space.ops.create('costCat', { cat, order: keys[index] })];
      return entry.order === keys[index] ? [] : [space.ops.patch('costCat', entry.id, { set: { order: keys[index] } })];
    });
    ops.push(...extras.map((entry) => space.ops.remove('costCat', entry.id)));
    if (ops.length && await attempt(async () => { await space.apply(ops, { history: t('costs.historyCategories') }); return true; }) === undefined) return;
    dialog.close('saved');
  }
  const dialog = track(openModal({ title: t('costs.reorderCategories'), onClose: () => sortable.destroy(),
    content: el('div', {}, el('p.field-hint.costs-order-hint', {}, t('costs.reorderHint')), list),
    actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', onclick: save })] }));
  return dialog;
}

/** The Overview tab: spend by category, the per-person summary and display-currency totals. */
export function createOverview({ space, getModel, people, track, display }) {
  const element = el('div.costs-panel');
  const due = createDueSection({ space, getModel, people, track });
  const budget = createBudgetSection({ space, getModel, track });
  function render() {
    const model = getModel();
    due.render(); budget.render();
    const { balances, personal, tripCurrency } = model;
    const totals = new Map();
    for (const [cat, amount] of balances.byCategory) totals.set(cat, add(totals.get(cat) ?? 0, amount));
    for (const [cat, amount] of personal.byCategory) totals.set(cat, add(totals.get(cat) ?? 0, amount));
    const cats = [...new Set([...model.categories, ...totals.keys()])].filter((cat) => totals.get(cat));
    const grand = [...totals.values()].reduce(add, 0);
    const largest = Math.max(1, ...cats.map((cat) => Math.abs(totals.get(cat))));
    const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
    const headingId = uid('costs-cats');

    const byCategory = cats.length ? el('ul.card.costs-bars', { 'aria-labelledby': headingId }, cats.map((cat) => {
      const amount = totals.get(cat);
      const privatePart = personal.byCategory.get(cat) ?? 0;
      return el('li.costs-bar-row', {}, categoryBadge(cat),
        el('span.costs-bar-label', {}, el('span', {}, categoryLabel(cat, space)),
          privatePart ? el('span.field-hint', {}, t('costs.inclPrivate', { amount: money(privatePart, tripCurrency) })) : null),
        el('span.costs-bar', { 'aria-hidden': 'true' }, el('span.costs-bar-fill', { style: { inlineSize: `${Math.max(2, Math.round(Math.abs(amount) / largest * 100))}%` } })),
        el('span.costs-bar-value', {}, el('span.num', {}, money(amount, tripCurrency)), el('span.field-hint.num', {}, grand ? percent.format(amount / grand) : '')));
    })) : emptyState({ title: t('costs.noSpendTitle'), body: t('costs.noSpendBody'), icon: 'wallet' });

    let summary = null;
    if (model.splitCosts) {
      const ids = [...new Set([...people.list.map((person) => person.id), ...balances.people.keys()])];
      const entries = ids.map((who) => balances.people.get(who) ?? { who, paid: 0, share: 0, unpaidShare: 0, net: 0 });
      const cell = (value) => el('td.num', {}, money(value, tripCurrency));
      summary = el('div.costs-table-wrap', { tabIndex: 0, role: 'region', 'aria-label': t('costs.perPerson') }, el('table.costs-table', {},
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('costs.person')), el('th.num', { scope: 'col' }, t('costs.mathPaid')),
          el('th.num', { scope: 'col' }, t('costs.budget')), el('th.num', { scope: 'col' }, t('costs.balance')))),
        el('tbody', {}, entries.map((entry) => el('tr', {}, el('th', { scope: 'row' }, el('span.costs-person', {}, people.avatar(entry.who, 24), people.name(entry.who))),
          cell(entry.paid), cell(add(entry.share, entry.unpaidShare)), cell(entry.net)))),
        el('tfoot', {}, el('tr', {}, el('th', { scope: 'row' }, t('costs.total')),
          cell(entries.reduce((sum, entry) => add(sum, entry.paid), 0)), cell(entries.reduce((sum, entry) => add(sum, add(entry.share, entry.unpaidShare)), 0)), el('td')))));
    }

    append(clear(element), [due.element, budget.element,
      el('section.costs-block', {},
        el('div.costs-heading-row', {}, el('h2.costs-heading', { id: headingId }, t('costs.byCategory')),
          model.canEdit ? button(t('costs.reorderCategories'), { size: 'sm', variant: 'ghost', onclick: () => openCategoryOrder({ space, model, track }) }) : null),
        byCategory,
        el('p.costs-totals', {}, el('span', {}, t('costs.totalSpend')), el('strong.num', {}, money(grand, tripCurrency)), display.approx(grand)),
        balances.unpaid ? el('p.field-hint', {}, t('costs.unpaidTotal', { amount: money(balances.unpaid, tripCurrency) })) : null,
        personal.total ? el('p.field-hint', {}, t('costs.privateTotal', { amount: money(personal.total, tripCurrency) })) : null),
      summary ? el('section.costs-block', {}, el('h2.costs-heading', {}, t('costs.perPerson')), el('p.field-hint', {}, t('costs.budgetHint')), summary) : null]);
  }
  return { element, render };
}
