import { el, uid } from '../../ui/dom.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatMoney } from '../../lib/format.js';
import { orderedCategories, isBuiltinCategory } from '../../lib/costs/categories.js';
import { computeBalances, netsOf, simplify } from '../../lib/costs/ledger.js';
import { displayConverter } from '../../lib/costs/fx.js';
import { attachments } from './files.js';

export function money(amount, currency) {
  if (!Number.isSafeInteger(amount) || !currency) return '';
  try { return formatMoney(amount, currency); } catch { return `${amount} ${currency}`; }
}
const categoryName = (id, space) => (isBuiltinCategory(id) ? t(`costs.cat.${id}`) : space.get('cat', id)?.name ?? t('costs.cat.other'));

/**
 * Totals, categories, suggested transfers and the expense list in the trip currency, with an approximate amount in
 * the sharer's display currency (`share.cur`) once a rate is known.
 */
export function renderCosts(ctx) {
  const { space, share, fx, signal } = ctx;
  const trip = space.get('meta', 'meta')?.currency;
  const expenses = space.select.exp.all();
  const root = el('div.public-costs');
  if (!trip || !expenses.length) { root.append(el('p.public-empty', {}, t('public.costsEmpty'))); return root; }
  const balances = computeBalances({ expenses, settlements: space.select.settle.all(), tripCurrency: trip });
  const approxNodes = [];
  const amount = (value, { approx = false } = {}) => {
    const node = el('span.public-money.num', {}, money(value, trip));
    if (approx && share.cur && share.cur !== trip) {
      const hint = el('span.public-approx.num', { hidden: true, dataset: { amount: String(value) } });
      approxNodes.push(hint);
      return [node, hint];
    }
    return node;
  };

  const totalId = uid('public-total');
  root.append(el('section.public-card.public-total', { 'aria-labelledby': totalId },
    el('h3.public-card-title', { id: totalId }, t('public.totalSpent')), el('p.public-total-value', {}, amount(balances.spend, { approx: true })),
    balances.pending.expenses.length > 0 && el('p.public-hint', {}, t('public.pendingRates', { count: new Intl.NumberFormat().format(balances.pending.expenses.length) }))));

  const cats = orderedCategories(space.select.costCat.all());
  const used = [...balances.byCategory.keys()].sort((a, b) => (cats.indexOf(a) + 1 || 999) - (cats.indexOf(b) + 1 || 999));
  if (used.length) {
    const catId = uid('public-cats');
    root.append(el('section.public-card', { 'aria-labelledby': catId }, el('h3.public-card-title', { id: catId }, t('public.byCategory')),
      el('ul.public-rows', {}, used.map((cat) => el('li.public-row.public-line', {}, el('span.public-row-title', {}, categoryName(cat, space)), amount(balances.byCategory.get(cat), { approx: true }))))));
  }

  const transfers = simplify(netsOf(balances));
  const owesId = uid('public-owes');
  root.append(el('section.public-card', { 'aria-labelledby': owesId }, el('h3.public-card-title', { id: owesId }, t('public.balances')),
    transfers.length ? el('ul.public-rows', {}, transfers.map((item) => el('li.public-row.public-line', {},
      el('span.public-row-title', {}, t('public.owes', { from: ctx.people(item.from), to: ctx.people(item.to) })), amount(item.amount, { approx: true }))))
      : el('p.public-empty', {}, t('public.settled'))));

  const listId = uid('public-exps');
  const sorted = [...expenses].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || (a.order ?? '').localeCompare(b.order ?? ''));
  root.append(el('section.public-card', { 'aria-labelledby': listId }, el('h3.public-card-title', { id: listId }, t('public.expenses')),
    el('ul.public-rows', {}, sorted.map((exp) => {
      const view = balances.views.get(exp.id);
      const payers = exp.payers.map((payer) => ctx.people(payer.who));
      const meta = [exp.date && formatDate(exp.date, { year: false }), categoryName(exp.cat || 'other', space),
        payers.length ? t('public.paidBy', { names: payers.join(', ') }) : t('public.unpaid')].filter(Boolean);
      return el('li.public-row.public-expense', {},
        el('div.public-row-body', {}, el('span.public-row-title', {}, exp.name), el('span.public-row-meta', {}, meta.join(' · ')),
          exp.note && el('p.public-notes', {}, exp.note.slice(0, 400)), attachments(ctx.files, ctx.filesFor(`exp:${exp.id}`))),
        el('div.public-amounts', {}, el('span.public-money.num', {}, money(exp.amount, exp.currency)),
          exp.currency !== trip && (view?.total != null ? el('span.public-approx.num', {}, money(view.total, trip)) : el('span.public-approx', {}, t('public.pendingRate')))));
    }))));

  if (approxNodes.length && fx) {
    void displayConverter({ fx, from: trip, to: share.cur, signal }).then((convert) => {
      if (!convert || signal?.aborted) return;
      for (const node of approxNodes) {
        try { node.textContent = t('costs.approx', { amount: money(convert(Number(node.dataset.amount)), share.cur) }); node.hidden = false; } catch { /* Leave it hidden. */ }
      }
    }).catch(() => {});
  }
  return root;
}
