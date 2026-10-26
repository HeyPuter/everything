import { el, uid, append, clear } from '../../../ui/dom.js';
import { button, emptyState, iconButton } from '../../../ui/bits.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { displayLocale, prefs } from '../../../lib/prefs.js';
import { decimalInput, moneyInput, parseDecimal, parseMoney } from '../../../lib/costs/input.js';
import { convertBack, fetchRate, localToday } from '../../../lib/costs/fx.js';
import { netsOf, pairwise, simplify, toTrip } from '../../../lib/costs/ledger.js';
import { settleAllOp } from '../../../lib/costs/adapters.js';
import { validateEntity } from '../../../shared/schema/index.js';
import { attempt, balanceText, errorText, money } from './shared.js';
import { currencySelect, same } from './form.js';
import { icon } from './icons.js';
import { createCurrencyBalances, usesSeveralCurrencies } from './extras/index.js';

const RATE = /^(?:0|[1-9]\d{0,50})(?:\.\d{1,18})?$/;
const SETTLE_FIELDS = ['from', 'to', 'amount', 'currency', 'rate', 'date', 'note'];

export const setSplitCosts = (space, value) => attempt(() => space.apply([space.ops.patch('meta', 'meta', { set: { 'settings.splitCosts': value } })], { history: t('costs.historySplit') }));

/** Record or edit a settlement. `prefill` is `{from, to, amount}` in the trip currency. */
export function openSettleForm({ space, model, people, session, track, settle = null, prefill = null }) {
  const locale = displayLocale();
  const { tripCurrency } = model;
  const editing = Boolean(settle);
  const roster = [...new Set([...people.list.map((person) => person.id), ...(settle ? [settle.from, settle.to] : []), ...(prefill ? [prefill.from, prefill.to] : [])])];
  const pick = (value) => {
    const select = el('select.select', { id: uid('costs-settle') }, roster.map((who) => el('option', { value: who }, people.name(who))));
    select.value = value ?? '';
    return select;
  };
  const from = pick(settle?.from ?? prefill?.from ?? people.me);
  const to = pick(settle?.to ?? prefill?.to ?? roster.find((who) => who !== people.me));
  const state = { currency: settle?.currency ?? prefill?.currency ?? tripCurrency, amountEdited: editing || Boolean(prefill?.currency), rateEdited: false };
  const amount = el('input.input.num', { id: uid('costs-settle'), inputMode: 'decimal', autocomplete: 'off',
    value: settle ? moneyInput(settle.amount, settle.currency, locale) : prefill ? moneyInput(prefill.amount, prefill.currency ?? tripCurrency, locale) : '',
    oninput: () => { state.amountEdited = true; hint(); } });
  const currency = currencySelect({ id: uid('costs-settle'), value: state.currency, preferred: [tripCurrency, prefs().currency, state.currency].filter(Boolean) });
  const rate = el('input.input.num', { id: uid('costs-settle'), inputMode: 'decimal', autocomplete: 'off',
    value: settle && typeof settle.rate === 'string' ? decimalInput(settle.rate, locale) : '', oninput: () => { state.rateEdited = true; hint(); } });
  const rateHint = el('span.field-hint', { id: uid('costs-hint') });
  rate.setAttribute('aria-describedby', rateHint.id);
  const date = el('input.input', { id: uid('costs-settle'), type: 'date', value: settle ? settle.date ?? '' : localToday() });
  const note = el('textarea.textarea', { id: uid('costs-settle'), rows: 2, maxLength: 100_000, value: settle?.note ?? '' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const field = (label, control, extra) => el('div.field', {}, el('label.field-label', { htmlFor: control.id }, label), control, extra);
  const rateRow = field(t('costs.rate'), rate, rateHint);

  const rateValue = () => { const value = parseDecimal(rate.value, locale); return value && RATE.test(value) && /[1-9]/.test(value) ? value : null; };
  function hint() {
    rateRow.hidden = state.currency === tripCurrency;
    if (rateRow.hidden) return;
    const value = rateValue();
    let converted = null;
    try { converted = value ? toTrip(parseMoney(amount.value, state.currency, locale), { currency: state.currency, rate: value }, tripCurrency) : null; } catch { converted = null; }
    rateHint.textContent = !rate.value.trim() ? t('costs.ratePendingHint') : !value ? t('costs.rateInvalid')
      : converted === null ? t('costs.rateOne', { from: state.currency, rate: rate.value, to: tripCurrency })
        : t('costs.rateConverted', { from: state.currency, rate: rate.value, to: tripCurrency, amount: money(converted, tripCurrency) });
  }
  let request = 0;
  async function loadRate() {
    if (state.currency === tripCurrency) { hint(); return; }
    const mine = ++request;
    rateHint.textContent = t('costs.rateFetching');
    const value = await fetchRate({ fx: session?.services?.fx, from: state.currency, to: tripCurrency, date: date.value || null });
    if (mine !== request) return;
    if (value && !state.rateEdited) {
      rate.value = decimalInput(value, locale);
      // A suggested payment keeps its value when it is paid in another currency.
      if (prefill && !state.amountEdited) {
        const back = convertBack(prefill.amount, value, tripCurrency, state.currency);
        if (back) amount.value = moneyInput(back, state.currency, locale);
      }
    }
    hint();
  }
  currency.addEventListener('change', () => {
    state.currency = currency.value;
    state.rateEdited = false;
    rate.value = '';
    if (prefill && !state.amountEdited && state.currency === tripCurrency) amount.value = moneyInput(prefill.amount, tripCurrency, locale);
    void loadRate();
  });
  date.addEventListener('change', () => { if (!state.rateEdited && (!editing || state.currency !== settle.currency)) { rate.value = ''; void loadRate(); } });

  const save = button(editing ? t('costs.saveChanges') : t('costs.recordPayment'), { variant: 'primary', type: 'submit' });
  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    const fail = (message, control) => { error.textContent = message; error.hidden = false; control?.focus(); };
    if (from.value === to.value) { fail(t('costs.errorSamePerson'), to); return; }
    let value;
    try { value = parseMoney(amount.value, state.currency, locale); } catch { fail(t('costs.errorAmount'), amount); return; }
    if (value <= 0) { fail(t('costs.errorPositive'), amount); return; }
    const fields = { from: from.value, to: to.value, amount: value, currency: state.currency };
    if (state.currency !== tripCurrency) {
      if (rate.value.trim()) {
        const frozen = rateValue();
        if (!frozen) { fail(t('costs.rateInvalid'), rate); return; }
        fields.rate = frozen;
      } else {
        save.setAttribute('aria-busy', 'true');
        fields.rate = await fetchRate({ fx: session?.services?.fx, from: state.currency, to: tripCurrency, date: date.value || null });
        save.setAttribute('aria-busy', 'false');
      }
    }
    if (date.value) fields.date = date.value;
    if (note.value.trim()) fields.note = note.value;
    try { validateEntity('trip', 'settle', fields); } catch { fail(t('costs.errorInvalid')); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      if (!editing) {
        await space.apply([space.ops.create('settle', fields)], { history: t('costs.historySettle') });
        toast(t('costs.paymentRecorded'), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
      } else {
        const set = {}; const unset = [];
        for (const key of SETTLE_FIELDS) {
          if (fields[key] === undefined) { if (settle[key] !== undefined) unset.push(key); }
          else if (!same(fields[key], settle[key])) set[key] = fields[key];
        }
        if (Object.keys(set).length || unset.length) {
          await space.apply([space.ops.patch('settle', settle.id, { set, unset })], { history: t('costs.historySettleEdit') });
          toast(t('costs.paymentSaved'), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
        }
      }
      dialog.close('saved');
    } catch (cause) { fail(errorText(cause)); }
    finally { save.setAttribute('aria-busy', 'false'); }
  }
  const form = el('form.costs-form', { onsubmit: submit, noValidate: true },
    el('div.field-row', {}, field(t('costs.from'), from), field(t('costs.to'), to)),
    el('div.field-row', {}, field(t('costs.amount'), amount), field(t('costs.currency'), currency)),
    rateRow, field(t('costs.date'), date), field(t('costs.note'), note), error,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  hint();
  if (state.currency !== tripCurrency && !rate.value) void loadRate();
  const dialog = track(openModal({ title: editing ? t('costs.editPayment') : t('costs.recordPayment'), content: form }));
  return dialog;
}

/** Per-person arithmetic behind the balances and the chosen payments. */
function openMath({ model, people, transfers, simplified, track }) {
  const { tripCurrency } = model;
  const rows = [...model.balances.people.values()].sort((a, b) => b.net - a.net);
  const cell = (value) => el('td.num', {}, money(value, tripCurrency));
  const table = el('div.costs-table-wrap', { tabIndex: 0, role: 'region', 'aria-label': t('costs.mathTable') }, el('table.costs-table', {},
    el('thead', {}, el('tr', {}, [t('costs.person'), t('costs.mathPaid'), t('costs.mathShare'), t('costs.mathRepaid'), t('costs.mathRepaidTo'), t('costs.mathSent'), t('costs.mathReceived'), t('costs.balance')]
      .map((label, index) => el('th', { scope: 'col', className: index ? 'num' : '' }, label)))),
    el('tbody', {}, rows.map((entry) => el('tr', {}, el('th', { scope: 'row' }, people.name(entry.who)),
      cell(entry.paid), cell(entry.share), cell(entry.repaid), cell(entry.repaidTo), cell(entry.sent), cell(entry.received), el('td.num', {}, el('strong', {}, money(entry.net, tripCurrency))))))));
  const steps = el('ol.costs-steps', {}, transfers.map((transfer) => el('li', {}, t(simplified ? 'costs.mathStep' : 'costs.mathPair', {
    from: people.name(transfer.from), to: people.name(transfer.to), amount: money(transfer.amount, tripCurrency) }))));
  return track(openModal({ title: t('costs.mathTitle'), wide: true, content: el('div.costs-math', {},
    el('p', {}, t('costs.mathIntro')), table,
    el('h3.costs-block-title', {}, t('costs.mathHow')), el('p', {}, t(simplified ? 'costs.mathGreedy' : 'costs.mathPairwise')),
    transfers.length ? steps : el('p.field-hint', {}, t('costs.allSettled'))) }));
}

/** The Balances tab: net balances, suggested payments, settle all, and the payment history. */
export function createSettle({ space, getModel, people, session, track }) {
  const key = `trips:costs:simplify:${space.ref?.s ?? ''}`;
  let simplified = true;
  try { simplified = globalThis.localStorage?.getItem(key) !== '0'; } catch { simplified = true; }
  const element = el('div.costs-panel');
  const titleId = uid('costs-balances');
  const switchId = uid('costs-simplify');
  const currencyKey = `trips:costs:bycur:${space.ref?.s ?? ''}`;
  let perCurrency = false;
  try { perCurrency = globalThis.localStorage?.getItem(currencyKey) === '1'; } catch { perCurrency = false; }
  const currencies = createCurrencyBalances({ getModel, people, record: (prefill) => openSettleForm({ space, model: getModel(), people, session, track, prefill }) });
  const currencyId = uid('costs-bycur');

  async function settleAll(transfers, model) {
    const total = transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
    const ok = await confirmDialog({ title: t('costs.settleAllTitle'), body: t('costs.settleAllBody', { count: transfers.length, total: money(total, model.tripCurrency) }), confirmLabel: t('costs.settleAll') });
    if (!ok) return;
    const today = localToday();
    const rows = transfers.map((transfer) => ({ from: transfer.from, to: transfer.to, amount: transfer.amount, currency: model.tripCurrency, date: today }));
    // The worker takes at most 100 transfers per op; pairwise lists in very large groups can be longer.
    const ops = [];
    for (let index = 0; index < rows.length; index += 100) ops.push(settleAllOp(space, rows.slice(index, index + 100)));
    const done = await attempt(async () => { await space.apply(ops); return true; });
    if (!done) return;
    const ids = ops.flatMap((op) => op.args.newIds.settle);
    toast(t('costs.settledAll', { count: transfers.length }), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.apply(ids.filter((id) => space.get('settle', id)).map((id) => space.ops.remove('settle', id)))) } });
  }

  async function remove(settle) {
    const ok = await confirmDialog({ title: t('costs.deletePaymentTitle'), body: t('costs.deletePaymentBody'), confirmLabel: t('costs.delete'), danger: true });
    if (!ok) return;
    const { id: _id, v: _v, rev: _rev, upd: _upd, by: _by, cr: _cr, t: _t, ...fields } = settle;
    const done = await attempt(async () => { await space.apply([space.ops.remove('settle', settle.id)]); return true; });
    if (done) toast(t('costs.paymentDeleted'), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.apply([space.ops.create('settle', structuredClone(fields))])) } });
  }

  function render() {
    const model = getModel();
    const form = (extra) => openSettleForm({ space, model, people, session, track, ...extra });
    if (!model.splitCosts) {
      element.replaceChildren(el('h2.sr-only', {}, t('costs.balances')), emptyState({ title: t('costs.splitOffTitle'), body: t('costs.splitOffBody'), icon: 'users',
        action: model.canTrip ? button(t('costs.turnOnSplit'), { variant: 'primary', onclick: () => setSplitCosts(space, true) }) : null }));
      return;
    }
    const { balances, tripCurrency } = model;
    const nets = netsOf(balances);
    const transfers = simplified ? simplify(nets) : pairwise(balances, model.settlements, tripCurrency);
    const ids = [...new Set([...people.list.map((person) => person.id), ...[...balances.people.values()].filter((entry) => entry.net || entry.paid || entry.share).map((entry) => entry.who)])];
    const rows = ids.map((who) => ({ who, net: nets.get(who) ?? 0 })).sort((a, b) => b.net - a.net || (people.name(a.who) < people.name(b.who) ? -1 : 1));
    const pendingCount = balances.pending.expenses.length + balances.pending.settlements.length;
    const several = usesSeveralCurrencies(model);
    const currencySwitch = several ? el('span.costs-switch', {}, el('span', { id: currencyId }, t('costExtras.byCurrency')),
      el('button.switch', { type: 'button', role: 'switch', dataset: { focus: 'bycur' }, 'aria-checked': String(perCurrency), 'aria-labelledby': currencyId, onclick: () => {
        perCurrency = !perCurrency;
        try { globalThis.localStorage?.setItem(currencyKey, perCurrency ? '1' : '0'); } catch { /* Per-device preference. */ }
        render();
        element.querySelector('[data-focus="bycur"]')?.focus();
      } }, el('span.switch-thumb'))) : null;

    const balanceList = el('ul.card.costs-balances', { 'aria-labelledby': titleId }, rows.map(({ who, net }) => el('li.costs-line', {},
      people.avatar(who), el('span', {}, people.name(who)),
      el('span.costs-balance.num', { dataset: { sign: net > 0 ? 'plus' : net < 0 ? 'minus' : 'zero' } },
        balanceText(net, tripCurrency, who === people.me)))));

    const toggle = el('button.switch', { type: 'button', role: 'switch', dataset: { focus: 'simplify' }, 'aria-checked': String(simplified), 'aria-labelledby': switchId, onclick: () => {
      simplified = !simplified;
      try { globalThis.localStorage?.setItem(key, simplified ? '1' : '0'); } catch { /* Per-device preference. */ }
      render();
      element.querySelector('[data-focus="simplify"]')?.focus();
    } }, el('span.switch-thumb'));
    const transferList = transfers.length ? el('ul.card.costs-transfers', {}, transfers.map((transfer) => el('li.costs-line', {},
      people.avatar(transfer.from, 24), el('span.costs-transfer', {}, el('span', {}, people.name(transfer.from)), icon('to', 16), el('span', {}, people.name(transfer.to))),
      el('strong.num', {}, money(transfer.amount, tripCurrency)),
      model.canEdit ? button(t('costs.record'), { size: 'sm', variant: 'outline', dataset: { focus: `rec:${transfer.from}:${transfer.to}` }, 'aria-label': t('costs.recordLabel', { from: people.name(transfer.from), to: people.name(transfer.to) }),
        onclick: () => form({ prefill: transfer }) }) : null)))
      : el('p.costs-settled', {}, icon('check', 18), el('span', {}, t('costs.allSettled')));

    const history = [...model.settlements].sort((a, b) => ((b.date ?? '') < (a.date ?? '') ? -1 : (b.date ?? '') > (a.date ?? '') ? 1 : (b.cr ?? 0) - (a.cr ?? 0)));
    const historyList = history.length ? el('ul.card.costs-history', {}, history.map((settle) => {
      let tripAmount = null;
      try { tripAmount = toTrip(settle.amount, settle, tripCurrency); } catch { tripAmount = null; }
      return el('li.costs-line', {},
        el('span.costs-history-text', {}, el('span', {}, t('costs.paidTo', { from: people.name(settle.from), to: people.name(settle.to) })),
          el('span.field-hint', {}, [settle.date ? formatDate(settle.date) : t('costs.noDate'), settle.note].filter(Boolean).join(' · '))),
        el('span.costs-entry-amounts', {}, el('span.num', {}, money(settle.amount, settle.currency)),
          settle.currency !== tripCurrency ? el('span.num.field-hint', {}, tripAmount === null ? t('costs.ratePending') : t('costs.approx', { amount: money(tripAmount, tripCurrency) })) : null),
        model.canEdit ? iconButton('more', t('costs.paymentActions'), { dataset: { focus: `pay:${settle.id}` }, onclick: (event) => openMenu(event.currentTarget, [
          { label: t('costs.edit'), icon: 'pencil', onSelect: () => form({ settle }) },
          { label: t('costs.delete'), icon: 'trash', danger: true, onSelect: () => remove(settle) },
        ]) }) : null);
    })) : el('p.field-hint', {}, t('costs.noPayments'));

    if (several && perCurrency) currencies.render();
    const showCurrencies = several && perCurrency;
    append(clear(element), [
      pendingCount && !showCurrencies ? el('p.costs-notice', { role: 'note' }, icon('warning', 16), el('span', {}, t('costs.pendingExcluded', { count: pendingCount }))) : null,
      currencySwitch ? el('div.costs-heading-actions', {}, currencySwitch) : null,
      showCurrencies ? currencies.element : null,
      showCurrencies ? null : el('section.costs-block', {}, el('h2.costs-heading', { id: titleId }, t('costs.balances')), balanceList),
      showCurrencies ? null : el('section.costs-block', {},
        el('div.costs-heading-row', {}, el('h2.costs-heading', {}, t('costs.suggested')),
          el('div.costs-heading-actions', {},
            el('span.costs-switch', {}, el('span', { id: switchId }, t('costs.simplify')), toggle),
            button(t('costs.showMath'), { size: 'sm', variant: 'ghost', onclick: () => openMath({ model, people, transfers, simplified, track }) }),
            model.canEdit && transfers.length ? button(t('costs.settleAll'), { size: 'sm', variant: 'primary', onclick: () => settleAll(transfers, model) }) : null)),
        transferList),
      el('section.costs-block', {},
        el('div.costs-heading-row', {}, el('h2.costs-heading', {}, t('costs.payments')),
          model.canEdit ? button(t('costs.recordPayment'), { size: 'sm', variant: 'outline', icon: 'plus', onclick: () => form({}) }) : null),
        historyList)]);
  }
  return { element, render };
}
