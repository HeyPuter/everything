// Cost extras (spec §5 [3]): partial payments, per-currency balances, expenses split across trips, the budget planner.
import './extras.css';
import { el, uid } from '../../../../ui/dom.js';
import { button, chip } from '../../../../ui/bits.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate } from '../../../../lib/format.js';
import { localToday } from '../../../../lib/costs/fx.js';
import { duePayments, isPartial } from '../../../../lib/costs/due.js';
import { balancesByCurrency } from '../../../../lib/costs/currencies.js';
import { acrossDrift } from '../../../../lib/costs/across.js';
import { isDate } from '../../../../shared/dates.js';
import { balanceText, money } from '../shared.js';
import { icon } from '../icons.js';
import { openPaymentPlan, openRecordPayment } from './payments.js';

export { createBudgetSection, openBudgetEditor } from './budget.js';

const paidOf = (exp) => exp.payers.reduce((sum, payer) => sum + payer.amount, 0);

function dueText(item) {
  if (item.overdue) return t('costExtras.overdue', { date: formatDate(item.due) });
  if (item.days === 0) return t('costExtras.dueToday');
  if (item.days === 1) return t('costExtras.dueInOne');
  if (item.days <= 30) return t('costExtras.dueIn', { days: new Intl.NumberFormat().format(item.days) });
  return t('costExtras.dueOn', { date: formatDate(item.due) });
}

/** Status chips for a ledger row: something still due, or a share of a payment split across trips. */
export function ledgerChips(entity, { today = localToday() } = {}) {
  if (entity.private) return [];
  const out = [];
  if (isDate(entity.due) && paidOf(entity) !== entity.amount) {
    const [item] = duePayments([entity], { today });
    if (item) out.push(chip(item.overdue ? t('costExtras.chipOverdue') : t('costExtras.chipDue', { amount: money(item.left, entity.currency) }), { status: item.overdue ? 'danger' : 'warn' }));
  }
  if (entity.across) out.push(chip(t('costExtras.chipAcross', { count: entity.across.parts.length })));
  return out;
}

/** The Overview's list of payments still due, soonest first. */
export function createDueSection({ space, getModel, people, track }) {
  const element = el('section.costs-block.cx-due');
  const headingId = uid('cx-due');
  function render() {
    const model = getModel();
    const list = duePayments(model.shared, { today: localToday() });
    element.hidden = !list.length;
    if (!list.length) { element.replaceChildren(); return; }
    element.replaceChildren(el('h2.costs-heading', { id: headingId }, t('costExtras.dueTitle')),
      el('ul.card.costs-history', { 'aria-labelledby': headingId }, list.map((item) => el('li.costs-line.cx-due-row', { dataset: { overdue: String(item.overdue) } },
        el('span.costs-history-text', {}, el('span', {}, item.exp.name),
          el('span.field-hint', {}, [dueText(item), t('costExtras.dueLeft', { left: money(item.left, item.exp.currency), amount: money(item.exp.amount, item.exp.currency) })].join(' · '))),
        model.canEdit ? button(t('costExtras.record'), { size: 'sm', variant: 'outline', dataset: { focus: `due:${item.exp.id}` },
          onclick: () => openRecordPayment({ space, people, track, id: item.exp.id }) }) : null))));
  }
  return { element, render };
}

/**
 * Per-currency balances for the Balances tab: one block per currency with its nets and suggested payments.
 * `record({from, to, amount, currency})` opens the settlement form for that currency.
 */
export function createCurrencyBalances({ getModel, people, record }) {
  const element = el('div.cx-currencies');
  function render() {
    const model = getModel();
    const entries = balancesByCurrency({ expenses: model.shared, settlements: model.settlements, tripCurrency: model.tripCurrency });
    element.replaceChildren(el('p.field-hint', {}, t('costExtras.byCurrencyHint')), ...entries.map(({ currency, balances, nets, transfers }) => {
      const headingId = uid('cx-cur');
      const rows = [...nets].filter(([, net]) => net !== 0).sort((a, b) => b[1] - a[1]);
      return el('section.costs-block', {},
        el('div.costs-heading-row', {}, el('h2.costs-heading', { id: headingId }, t('costExtras.currencyHeading', { currency })),
          el('span.field-hint.num', {}, t('costExtras.currencySpend', { amount: money(balances.spend, currency) }))),
        rows.length ? el('ul.card.costs-balances', { 'aria-labelledby': headingId }, rows.map(([who, net]) => el('li.costs-line', {}, people.avatar(who), el('span', {}, people.name(who)),
          el('span.costs-balance.num', { dataset: { sign: net > 0 ? 'plus' : 'minus' } }, balanceText(net, currency, who === people.me)))))
          : el('p.costs-settled', {}, icon('check', 18), el('span', {}, t('costExtras.currencySettled', { currency }))),
        transfers.length ? el('ul.card.costs-transfers', {}, transfers.map((transfer) => el('li.costs-line', {},
          people.avatar(transfer.from, 24), el('span.costs-transfer', {}, el('span', {}, people.name(transfer.from)), icon('to', 16), el('span', {}, people.name(transfer.to))),
          el('strong.num', {}, money(transfer.amount, currency)),
          model.canEdit ? button(t('costs.record'), { size: 'sm', variant: 'outline', dataset: { focus: `rec:${currency}:${transfer.from}:${transfer.to}` },
            'aria-label': t('costs.recordLabel', { from: people.name(transfer.from), to: people.name(transfer.to) }), onclick: () => record({ ...transfer, currency }) }) : null))) : null);
    }));
  }
  return { element, render };
}

/** True when the trip has expenses or payments in more than one currency. */
export const usesSeveralCurrencies = (model) => new Set([...model.shared, ...model.settlements].map((entity) => entity.currency)).size > 1;

/**
 * Detail-dialog blocks for one shared expense: its payment plan (what is paid, what is due, record and change) and its
 * split across trips (parts, drift warning, or the button to split it). `openAcross` opens the split dialog.
 */
export function detailBlocks({ space, entity, model, people, track, openAcross }) {
  if (entity.private) return [];
  const blocks = [];
  const { canEdit } = model;
  const partial = isPartial(entity) || (isDate(entity.due) && !entity.payers.length);
  if (partial) {
    const [item] = duePayments([entity], { today: localToday() });
    blocks.push(el('section.costs-detail-block.cx-payment', {}, el('h3.costs-block-title', {}, t('costExtras.paymentHeading')),
      el('p', {}, t('costExtras.paidOf', { paid: money(paidOf(entity), entity.currency), amount: money(entity.amount, entity.currency) })),
      item ? el('p.field-hint', { dataset: { overdue: String(item.overdue) } }, [dueText(item), t('costExtras.dueLeft', { left: money(item.left, entity.currency), amount: money(entity.amount, entity.currency) })].join(' · ')) : null,
      el('p.field-hint', {}, t('costExtras.balancesNote')),
      canEdit ? el('div.costs-actions', {},
        button(t('costExtras.record'), { size: 'sm', variant: 'primary', onclick: () => openRecordPayment({ space, people, track, id: entity.id }) }),
        button(t('costExtras.changePlan'), { size: 'sm', variant: 'ghost', onclick: () => openPaymentPlan({ space, people, track, id: entity.id }) })) : null));
  } else if (canEdit && entity.amount > 0) {
    blocks.push(el('div.costs-actions.cx-extra-actions', {}, button(t('costExtras.plan'), { size: 'sm', variant: 'ghost', onclick: () => openPaymentPlan({ space, people, track, id: entity.id }) }),
      !entity.across && openAcross ? button(t('costExtras.acrossButton'), { size: 'sm', variant: 'ghost', onclick: () => openAcross(entity) }) : null));
  }
  if (entity.across) {
    const here = entity.across.parts.find((part) => part.s === space.ref?.s);
    blocks.push(el('section.costs-detail-block.cx-across-info', {}, el('h3.costs-block-title', {}, t('costExtras.acrossHeading')),
      here ? el('p', {}, t('costExtras.acrossPart', { amount: money(here.amount, entity.currency), total: money(entity.across.total, entity.currency) })) : null,
      acrossDrift(entity, space.ref?.s) ? el('p.costs-notice', { role: 'note' }, icon('warning', 16), el('span', {}, t('costExtras.acrossDrift'))) : null,
      el('ul.costs-plain-list', {}, entity.across.parts.map((part) => {
        const title = part.title || t('costExtras.acrossUntitled');
        const self = part.s === space.ref?.s;
        return el('li.costs-row', {}, el('span.costs-row-name', {}, self ? `${title} · ${t('costExtras.acrossHere')}` : el('a', { href: `#/t/${part.w}/${part.s}/costs`, 'aria-label': t('costExtras.acrossOpen', { trip: title }) }, title)),
          el('span.num', {}, money(part.amount, entity.currency)));
      }))));
  }
  return blocks;
}

export { openPaymentPlan, openRecordPayment };
export const openAcrossDialog = (options) => import('./across.js').then((module) => module.openAcrossDialog(options));
