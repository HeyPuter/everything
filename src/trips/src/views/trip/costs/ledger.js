import { el, uid, append, clear } from '../../../ui/dom.js';
import { button, chip, emptyState } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { makeSortable } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { add, positionOf, rateState, toTrip } from '../../../lib/costs/ledger.js';
import { orderBetween, orderKeys } from '../../../shared/order.js';
import { attempt, byOrder, categoryBadge, categoryLabel, dayOf, money } from './shared.js';
import { expenseFields } from './detail.js';
import { icon } from './icons.js';
import { ledgerChips } from './extras/index.js';

/** New order keys for a moved item, or for the whole group when its keys leave no room. */
export function reorderWrites(list, from, to) {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const left = next[to - 1]?.order ?? null;
  const right = next[to + 1]?.order ?? null;
  const ordered = next.every((entity) => typeof entity.order === 'string');
  if (ordered) {
    try { return [{ entity: moved, order: orderBetween(left, right) }]; } catch { /* Rebalance below. */ }
  }
  const keys = orderKeys(next.length);
  return next.map((entity, index) => ({ entity, order: keys[index] })).filter((item) => item.entity.order !== item.order);
}

/** The Expenses tab: filters, the ledger grouped by day, and drag or Alt+Arrow reordering within a day. */
export function createLedger({ space, getModel, people, onOpen, onAdd }) {
  const filters = { q: '', cat: '', day: '', view: 'all' };
  const searchId = uid('costs-search');
  const search = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', placeholder: t('costs.searchPlaceholder'),
    oninput: () => { filters.q = search.value.trim().toLocaleLowerCase(); render(); } });
  const catSelect = el('select.select', { 'aria-label': t('costs.filterCategory'), onchange: () => { filters.cat = catSelect.value; render(); } });
  const daySelect = el('select.select', { 'aria-label': t('costs.filterDay'), onchange: () => { filters.day = daySelect.value; render(); } });
  const views = segmented({ label: t('costs.filterView'), value: 'all', items: [
    { value: 'all', label: t('costs.viewAll') }, { value: 'mine', label: t('costs.viewPaidByMe') }, { value: 'owed', label: t('costs.viewOwed') },
  ], onChange: (value) => { filters.view = value; render(); } });
  const list = el('div.costs-ledger');
  const element = el('div.costs-panel', {}, el('h2.sr-only', {}, t('costs.tabExpenses')),
    el('div.costs-filters', {}, el('label.sr-only', { htmlFor: searchId }, t('costs.search')), el('div.input-prefix', {}, icon('search'), search), catSelect, daySelect, views.element),
    list);
  let sortables = [];

  const filtered = () => Boolean(filters.q || filters.cat || filters.day || filters.view !== 'all');
  function matches(entity, model) {
    if (filters.cat && (entity.cat || 'other') !== filters.cat) return false;
    if (filters.day && (filters.day === 'none' ? dayOf(entity) !== '' : dayOf(entity) !== filters.day)) return false;
    if (filters.q) {
      const text = [entity.name, entity.note ?? '', ...(entity.split.items ?? []).map((item) => item.label)].join(' ').toLocaleLowerCase();
      if (!text.includes(filters.q)) return false;
    }
    if (filters.view === 'mine' && !entity.payers.some((payer) => payer.who === model.me)) return false;
    if (filters.view === 'owed') {
      const view = model.balances.views.get(entity.id);
      if (entity.private || !view || view.unpaid || positionOf(view.own, model.me) <= 0) return false;
    }
    return true;
  }

  function options(model, all) {
    const cats = [...new Set([...model.categories, ...all.map((entity) => entity.cat || 'other')])];
    catSelect.replaceChildren(el('option', { value: '' }, t('costs.allCategories')), ...cats.map((cat) => el('option', { value: cat }, categoryLabel(cat, space))));
    catSelect.value = cats.includes(filters.cat) ? filters.cat : '';
    filters.cat = catSelect.value;
    const days = [...new Set(all.map(dayOf))].filter(Boolean).sort();
    append(clear(daySelect), [el('option', { value: '' }, t('costs.allDays')), ...days.map((day) => el('option', { value: day }, formatDate(day, { weekday: true }))),
      all.some((entity) => !dayOf(entity)) ? el('option', { value: 'none' }, t('costs.noDate')) : null]);
    daySelect.value = filters.day && [...daySelect.options].some((option) => option.value === filters.day) ? filters.day : '';
    filters.day = daySelect.value;
  }

  function row(entity, model, canMove) {
    const view = entity.private ? null : model.balances.views.get(entity.id);
    const state = rateState(entity, model.tripCurrency);
    const tripAmount = view?.total ?? null;
    const meta = [];
    if (!entity.private && model.splitCosts) {
      if (!entity.payers.length) meta.push(t('costs.notPaid'));
      else meta.push(entity.payers.length === 1 ? t('costs.paidByName', { name: people.name(entity.payers[0].who) }) : t('costs.paidByCount', { count: entity.payers.length }));
      meta.push(entity.split.parts.length === 1 ? t('costs.forName', { name: people.name(entity.split.parts[0].who) }) : t('costs.splitWays', { count: entity.split.parts.length }));
    }
    meta.push(categoryLabel(entity.cat, space));
    let position = null;
    if (view && !view.unpaid && model.splitCosts) {
      const value = positionOf(view.own, model.me);
      if (value > 0) position = el('span.costs-position.is-owed', {}, t('costs.youLent', { amount: money(value, entity.currency) }));
      else if (value < 0) position = el('span.costs-position.is-owing', {}, t('costs.youOweAmount', { amount: money(-value, entity.currency) }));
    }
    return el('li.costs-entry', { dataset: { sortableItem: '', label: entity.name } },
      canMove ? el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', dataset: { sortableHandle: '' } }, icon('grip', 16)) : null,
      el('button.costs-entry-main', { type: 'button', dataset: { focus: `exp:${entity.id}` }, onclick: () => onOpen(entity) },
        categoryBadge(entity.cat),
        el('span.costs-entry-text', {}, el('span.costs-entry-name', {}, entity.name), el('span.costs-entry-meta', {}, meta.join(' · '))),
        el('span.costs-entry-amounts', {},
          el('span.num.costs-entry-amount', {}, money(entity.amount, entity.currency)),
          state === 'frozen' && tripAmount !== null ? el('span.num.field-hint', {}, t('costs.approx', { amount: money(tripAmount, model.tripCurrency) })) : null,
          position)),
      el('span.costs-entry-chips', {},
        entity.private ? chip(t('costs.private'), {}) : null,
        state === 'pending' ? chip(t('costs.ratePending'), { status: 'warn' }) : null,
        ...ledgerChips(entity)));
  }

  async function move(group, from, to) {
    const writes = reorderWrites(group, from, to);
    const shared = writes.filter((item) => !item.entity.private);
    const privates = writes.filter((item) => item.entity.private);
    await attempt(async () => {
      if (shared.length) await space.apply(shared.map((item) => space.ops.patch('exp', item.entity.id, { set: { order: item.order } })), { history: t('costs.historyReorder') });
      for (const item of privates) await space.privateItems('exp').put({ ...expenseFields(item.entity), order: item.order }, item.entity.id);
    });
  }

  function render() {
    for (const sortable of sortables) sortable.destroy();
    sortables = [];
    const model = getModel();
    const all = [...model.shared, ...model.privates];
    options(model, all);
    if (!all.length) {
      list.replaceChildren(emptyState({ title: t('costs.emptyTitle'), body: t(model.canEdit ? 'costs.emptyBody' : 'costs.emptyViewer'), icon: 'wallet',
        action: button(model.canEdit ? t('costs.addExpense') : t('costs.addPrivate'), { variant: 'primary', icon: 'plus', onclick: onAdd }) }));
      return;
    }
    const shown = all.filter((entity) => matches(entity, model));
    if (!shown.length) {
      list.replaceChildren(emptyState({ title: t('costs.noMatchTitle'), body: t('costs.noMatchBody'), icon: 'search' }));
      return;
    }
    const groups = new Map();
    for (const entity of shown) {
      const day = dayOf(entity);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(entity);
    }
    const days = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
    const canMove = model.canEdit && !filtered();
    list.replaceChildren(...days.map((day) => {
      const group = groups.get(day).sort(byOrder);
      const total = group.reduce((sum, entity) => {
        let amount = null;
        try { amount = entity.private ? toTrip(entity.amount, entity, model.tripCurrency) : model.balances.views.get(entity.id)?.total; } catch { amount = null; }
        return Number.isSafeInteger(amount) ? add(sum, amount) : sum;
      }, 0);
      const headingId = uid('costs-day');
      const items = el('ul.card.costs-entries', { 'aria-labelledby': headingId }, group.map((entity) => row(entity, model, canMove && group.length > 1)));
      if (canMove && group.length > 1) sortables.push(makeSortable(items, { onMove: ({ from, to }) => move(group, from, to) }));
      return el('section.costs-day', {},
        el('h3.costs-day-head', { id: headingId }, el('span', {}, day ? formatDate(day, { weekday: true }) : t('costs.noDate')),
          el('span.num.costs-day-total', {}, money(total, model.tripCurrency))),
        items);
    }));
  }

  return { element, render, destroy() { for (const sortable of sortables) sortable.destroy(); sortables = []; } };
}
