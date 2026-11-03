import { el, uid } from '../../../ui/dom.js';
import { button, iconButton, chip } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { openModal, promptDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale, prefs } from '../../../lib/prefs.js';
import { decimalInput, decimalsEqual, evenPercents, moneyInput, parseDecimal, parseMoney } from '../../../lib/costs/input.js';
import { fetchRate, localToday } from '../../../lib/costs/fx.js';
import { convertMinor, isCurrency, splitAmount } from '../../../shared/money.js';
import { newId } from '../../../shared/ids.js';
import { orderBetween } from '../../../shared/order.js';
import { plainObject } from '../../../shared/schema/dsl.js';
import { validateEntity } from '../../../shared/schema/index.js';
import { attempt, categoryLabel, dayOf, errorText, money } from './shared.js';
import { presetBar } from './presets/index.js';
import { attachReceipts, canAttachReceipts } from './receipt/attach.js';
import { chooseLocalFiles } from '../../../lib/files/index.js';
import { attachmentList } from '../../../lib/files/ui.js';

const FIELDS = ['name', 'amount', 'currency', 'rate', 'date', 'order', 'cat', 'note', 'payers', 'split', 'links', 'due'];
const MODES = ['equal', 'amounts', 'percent', 'shares', 'items'];
const RATE = /^(?:0|[1-9]\d{0,50})(?:\.\d{1,18})?$/;

const canonical = (value) => JSON.stringify(value, (_, item) => (plainObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item));
export const same = (a, b) => canonical(a) === canonical(b);

/** ISO 4217 codes for the currency picker: the trip's, the display currency and those in use first. */
export function currencySelect({ id, value, preferred }) {
  const names = (() => { try { return new Intl.DisplayNames([displayLocale()], { type: 'currency' }); } catch { return null; } })();
  const label = (code) => { const name = names?.of(code); return name && name !== code ? `${code} · ${name}` : code; };
  const all = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []).filter(isCurrency);
  const top = [...new Set(preferred.filter(isCurrency))];
  const select = el('select.select', { id },
    el('optgroup', { label: t('costs.currencyCommon') }, top.map((code) => el('option', { value: code }, label(code)))),
    el('optgroup', { label: t('costs.currencyAll') }, all.filter((code) => !top.includes(code)).map((code) => el('option', { value: code }, label(code)))));
  select.value = value;
  return select;
}

/** A labelled control in the `.field` layout, with an error line. */
function labelled(label, control, { hint } = {}) {
  const id = control.id || uid('costs-field');
  control.id = id;
  const error = el('span.field-error', { id: `${id}-error`, hidden: true, 'aria-live': 'polite' });
  const hintNode = hint ? el('span.field-hint', { id: `${id}-hint` }, hint) : null;
  if (hintNode) control.setAttribute('aria-describedby', hintNode.id);
  const node = el('div.field', {}, el('label.field-label', { htmlFor: id }, label), control, hintNode, error);
  return {
    node, control, hint: hintNode,
    setError(message = '') {
      error.textContent = message; error.hidden = !message;
      control.setAttribute('aria-invalid', String(Boolean(message)));
      const described = [hintNode?.id, message && error.id].filter(Boolean).join(' ');
      if (described) control.setAttribute('aria-describedby', described); else control.removeAttribute('aria-describedby');
    },
  };
}

function nextOrder(entities, date) {
  const orders = entities.filter((entity) => dayOf(entity) === (date ?? '') && typeof entity.order === 'string').map((entity) => entity.order).sort();
  try { return orderBetween(orders.at(-1) ?? null, null); } catch { return undefined; }
}

/**
 * Add or edit an expense. `expense` edits (shared or private); `copy` prefills a new one. `onSaved(id)` runs after
 * the change is applied locally.
 */
export function openExpenseForm({ space, model, people, session, track, expense = null, copy = null, onSaved }) {
  const locale = displayLocale();
  const editing = Boolean(expense);
  const source = expense ?? copy;
  const { tripCurrency } = model;
  const me = people.me;
  const id = expense?.id ?? newId();
  const openBase = editing && !expense.private ? space.store?.serverVersion?.('exp', id) : undefined;
  const lockedPrivate = !model.canEdit;
  // A partial payment (with a due date) keeps its payers below the amount until it is paid in full.
  const partialOk = editing && !expense.private && typeof expense.due === 'string';
  const partialNow = partialOk && expense.payers.length > 0 && expense.payers.reduce((sum, payer) => sum + payer.amount, 0) !== expense.amount;
  const state = {
    private: editing ? Boolean(expense.private) : lockedPrivate || Boolean(copy?.private),
    currency: source?.currency ?? tripCurrency,
    rateEdited: false,
    payMode: source ? (source.payers.length === 0 ? 'none' : source.payers.length === 1 && !partialNow ? 'one' : 'several') : 'one',
    splitMode: source?.split.mode ?? 'equal',
    participants: new Set(source ? source.split.parts.map((part) => part.who) : people.list.map((person) => person.id)),
    paid: new Set(source ? source.split.parts.filter((part) => part.paid).map((part) => part.who) : []),
    links: [...(source?.links ?? [])],
  };
  if (!state.participants.size) state.participants.add(me);
  // People shown in the payer and split lists: everyone in the trip plus anyone already on this expense.
  const roster = () => [...new Set([...people.list.map((person) => person.id), ...(source?.payers ?? []).map((payer) => payer.who), ...(source?.split.parts ?? []).map((part) => part.who)])];

  const nameField = labelled(t('costs.name'), el('input.input', { value: source?.name ?? '', maxLength: 500, required: true, autocomplete: 'off' }));
  const amountField = labelled(t('costs.amount'), el('input.input.num', { value: source ? moneyInput(source.amount, source.currency, locale) : '', inputMode: 'decimal', autocomplete: 'off', required: true }));
  const preferredCurrencies = [tripCurrency, prefs().currency, ...model.shared.map((entity) => entity.currency), state.currency].filter(Boolean);
  const currencyField = labelled(t('costs.currency'), currencySelect({ value: state.currency, preferred: preferredCurrencies }));
  const rateInput = el('input.input.num', { value: source?.currency === state.currency && typeof source?.rate === 'string' ? decimalInput(source.rate, locale) : '', inputMode: 'decimal', autocomplete: 'off' });
  const rateField = labelled(t('costs.rate'), rateInput, { hint: ' ' });
  const dateField = labelled(t('costs.date'), el('input.input', { type: 'date', value: source ? source.date ?? '' : localToday() }));
  const catSelect = el('select.select', {}, model.categories.map((cat) => el('option', { value: cat }, categoryLabel(cat, space))));
  catSelect.value = source?.cat && model.categories.includes(source.cat) ? source.cat : 'other';
  const catField = labelled(t('costs.category'), catSelect);
  const noteField = labelled(t('costs.note'), el('textarea.textarea', { value: source?.note ?? '', maxLength: 100_000, rows: 2 }));

  const privateBox = el('input', { type: 'checkbox', checked: state.private, disabled: editing || lockedPrivate,
    onchange: () => { state.private = privateBox.checked; renderSections(); } });
  const privateRow = el('label.check-field', {}, privateBox, el('span', {}, t('costs.privateLabel')),
    el('span.field-hint', {}, lockedPrivate && !editing ? t('costs.privateOnly') : t('costs.privateHint')));

  // Paid by
  const payerSelect = el('select.select', { id: uid('costs-payer'), onchange: () => { state.payer = payerSelect.value; } });
  const payerInputs = new Map();
  const payBox = el('div.costs-rows');
  const payStatus = el('p.field-hint.costs-status', { 'aria-live': 'polite' });
  const payError = el('p.field-error', { role: 'alert', hidden: true });
  const payMode = segmented({ label: t('costs.paidBy'), value: state.payMode, items: [
    { value: 'one', label: t('costs.payOne') }, { value: 'several', label: t('costs.paySeveral') }, { value: 'none', label: t('costs.payNone') },
  ], onChange: (value) => { state.payMode = value; renderPayers(); renderSplit(); updateStatus(); } });

  // Split
  const valueInputs = new Map();
  const shareOutputs = new Map();
  const items = (source?.split.mode === 'items' ? source.split.items ?? [] : []).map((item) => ({ label: item.label, amount: moneyInput(item.amount, source.currency, locale), who: new Set(item.who) }));
  const splitBox = el('div.costs-rows');
  const splitStatus = el('p.field-hint.costs-status', { 'aria-live': 'polite' });
  const splitError = el('p.field-error', { role: 'alert', hidden: true });
  const splitMode = segmented({ label: t('costs.splitMode'), value: state.splitMode, items: MODES.map((mode) => ({ value: mode, label: t(`costs.mode.${mode}`) })),
    onChange: (value) => { state.splitMode = value; renderSplit(); updateStatus(); } });
  const evenButton = button(t('costs.even'), { size: 'sm', variant: 'ghost', onclick: () => {
    const chosen = roster().filter((who) => state.participants.has(who));
    if (!chosen.length) return;
    evenPercents(chosen.length, id).forEach((value, index) => { const input = valueInputs.get(`percent:${chosen[index]}`); if (input) input.value = decimalInput(value, locale); });
    updateStatus();
  } });
  const guestButton = model.canPlan ? button(t('costs.addGuest'), { size: 'sm', variant: 'ghost', icon: 'plus', onclick: addGuest }) : null;
  const presets = presetBar({ space, people, track, canEdit: model.canEdit, roster,
    rows: () => roster().filter((who) => state.participants.has(who)).map((who) => [who, valueInputs.get(`shares:${who}`)?.value ?? '1']),
    apply: ({ participants, weights }) => {
      if (state.splitMode !== 'shares') { state.splitMode = 'shares'; splitMode.setValue('shares'); }
      state.participants = new Set(participants);
      renderSplit();
      for (const [who, weight] of weights) { const input = valueInputs.get(`shares:${who}`); if (input) input.value = decimalInput(weight, locale); }
      updateStatus();
    } });

  const links = el('div.costs-links');
  const linkSelect = el('select.select', { id: uid('costs-link'), onchange: () => {
    const [type, target] = linkSelect.value.split(':');
    linkSelect.value = '';
    if (type && target && !state.links.some((link) => link.t === type && link.id === target)) { state.links.push({ t: type, id: target }); renderLinks(); }
  } });

  // Receipts: live attachments when editing a shared expense; otherwise files picked now are uploaded after saving.
  const staged = [];
  const stagedList = el('ul.costs-receipt-list', { role: 'list' });
  const receiptLive = editing && !expense.private ? attachmentList(space, { t: 'exp', id }, { label: t('costs.receipts') }) : null;
  const receiptAdd = button(t('costs.receiptAdd'), { size: 'sm', variant: 'outline', icon: 'plus', onclick: async () => {
    const files = await chooseLocalFiles();
    if (!files.length) return;
    staged.push(...files);
    renderReceipts();
    receiptAdd.focus();
  } });
  const receiptSection = receiptLive ? el('div.field', {}, receiptLive.element)
    : el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costs.receipts')), stagedList, receiptAdd, el('p.field-hint', {}, t('costs.receiptHint')));
  function renderReceipts() {
    stagedList.replaceChildren(...staged.map((file, index) => el('li', {}, chip(file.name, { onRemove: () => { staged.splice(index, 1); renderReceipts(); receiptAdd.focus(); } }))));
    stagedList.hidden = !staged.length;
  }

  const formError = el('p.field-error', { role: 'alert', hidden: true });
  const payersSection = el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costs.paidBy')), payMode.element, payBox, payStatus, payError);
  const splitSection = el('fieldset.costs-section', {}, el('legend.field-label', {}, t('costs.split')),
    el('div.costs-split-head', {}, splitMode.element, evenButton, guestButton), presets.element, splitBox, splitStatus, splitError);

  function amountValue() {
    try { return parseMoney(amountField.control.value, state.currency, locale); } catch { return null; }
  }
  function showsSplit() {
    if (state.private) return false;
    if (model.splitCosts) return true;
    // Keep an existing split visible so it is never rewritten without the user seeing it.
    return Boolean(source && (source.payers.some((payer) => payer.who !== me) || source.split.parts.some((part) => part.who !== me)));
  }

  function renderPayers() {
    const list = roster();
    payerSelect.replaceChildren(...list.map((who) => el('option', { value: who }, people.name(who))));
    state.payer ??= source?.payers.length === 1 ? source.payers[0].who : list.includes(me) ? me : list[0] ?? '';
    payerSelect.value = state.payer;
    payBox.replaceChildren();
    if (state.payMode === 'one') payBox.append(labelled(t('costs.payer'), payerSelect).node);
    if (state.payMode === 'several') {
      for (const who of list) {
        let input = payerInputs.get(who);
        if (!input) {
          const stored = source?.payers.find((payer) => payer.who === who);
          input = el('input.input.num.costs-value', { inputMode: 'decimal', autocomplete: 'off', value: stored ? moneyInput(stored.amount, source.currency, locale) : '',
            'aria-label': t('costs.payerAmount', { name: people.name(who) }), oninput: updateStatus });
          payerInputs.set(who, input);
        }
        payBox.append(el('div.costs-row', {}, people.avatar(who, 24), el('span.costs-row-name', {}, people.name(who)), input));
      }
    }
  }

  function renderSplit() {
    const mode = state.splitMode;
    evenButton.hidden = mode !== 'percent';
    presets.show(mode);
    splitBox.replaceChildren();
    shareOutputs.clear();
    if (mode === 'items') { renderItems(); return; }
    for (const who of roster()) {
      const box = el('input', { type: 'checkbox', checked: state.participants.has(who), 'aria-label': t('costs.includePerson', { name: people.name(who) }),
        onchange: () => { if (box.checked) state.participants.add(who); else state.participants.delete(who); renderSplit(); updateStatus(); } });
      let input = null;
      if (mode !== 'equal' && state.participants.has(who)) {
        input = valueInputs.get(`${mode}:${who}`);
        if (!input) {
          const stored = source?.split.mode === mode ? source.split.parts.find((part) => part.who === who) : null;
          const value = stored?.value === undefined ? (mode === 'shares' ? '1' : '') : mode === 'amounts' ? moneyInput(stored.value, source.currency, locale) : decimalInput(stored.value, locale);
          input = el('input.input.num.costs-value', { inputMode: 'decimal', autocomplete: 'off', value, oninput: updateStatus,
            'aria-label': t(`costs.valueLabel.${mode}`, { name: people.name(who) }) });
          valueInputs.set(`${mode}:${who}`, input);
        }
      }
      const output = el('output.costs-share.num');
      shareOutputs.set(who, output);
      const paidBox = el('input', { type: 'checkbox', checked: state.paid.has(who), 'aria-label': t('costs.paidBackLabel', { name: people.name(who) }),
        onchange: () => { if (paidBox.checked) state.paid.add(who); else state.paid.delete(who); } });
      splitBox.append(el('div.costs-row', {}, box, people.avatar(who, 24), el('span.costs-row-name', {}, people.name(who)), input, output,
        state.participants.has(who) && state.payMode !== 'none' ? el('label.costs-paid', { title: t('costs.paidBack') }, paidBox, el('span', {}, t('costs.paidBack'))) : null));
    }
  }

  function renderItems() {
    items.forEach((item, index) => {
      const label = el('input.input', { value: item.label, maxLength: 500, 'aria-label': t('costs.itemLabel', { n: index + 1 }), oninput: () => { item.label = label.value; } });
      const amount = el('input.input.num.costs-value', { value: item.amount, inputMode: 'decimal', 'aria-label': t('costs.itemAmount', { n: index + 1 }), oninput: () => { item.amount = amount.value; updateStatus(); } });
      const who = el('div.costs-item-people', { role: 'group', 'aria-label': t('costs.itemPeople', { n: index + 1 }) }, roster().map((person) => {
        const box = el('input', { type: 'checkbox', checked: item.who.has(person), onchange: () => { if (box.checked) item.who.add(person); else item.who.delete(person); updateStatus(); } });
        return el('label.costs-person-check', {}, box, el('span', {}, people.name(person)));
      }));
      splitBox.append(el('div.costs-item', {}, el('div.costs-item-head', {}, label, amount,
        iconButton('trash', t('costs.removeItem', { n: index + 1 }), { onclick: () => { items.splice(index, 1); renderSplit(); updateStatus(); } })), who));
    });
    splitBox.append(button(t('costs.addItem'), { size: 'sm', variant: 'outline', icon: 'plus', onclick: () => {
      items.push({ label: '', amount: '', who: new Set(state.participants) });
      renderSplit(); updateStatus();
      splitBox.querySelectorAll('.costs-item-head .input')[items.length * 2 - 2]?.focus();
    } }));
  }

  function renderLinks() {
    const options = [
      ['res', t('costs.linkBookings'), space.select.res?.all() ?? [], (entity) => entity.title],
      ['place', t('costs.linkPlaces'), space.select.place?.all() ?? [], (entity) => entity.name],
      ['visit', t('costs.linkVisits'), space.select.visit?.all() ?? [], (entity) => entity.title || space.get('place', entity.placeId)?.name || ''],
    ];
    linkSelect.replaceChildren(el('option', { value: '' }, t('costs.linkPick')), ...options.filter(([, , list]) => list.length).map(([type, label, list, name]) =>
      el('optgroup', { label }, list.filter((entity) => name(entity)).slice(0, 500).map((entity) => el('option', { value: `${type}:${entity.id}` }, name(entity))))));
    links.replaceChildren(...state.links.map((link, index) => {
      const target = space.get(link.t, link.id);
      const label = target ? (target.title || target.name || space.get('place', target.placeId)?.name || t('costs.linkUnknown')) : t('costs.linkUnknown');
      return chip(label, { onRemove: () => { state.links.splice(index, 1); renderLinks(); } });
    }));
  }

  /** The payers in minor units, or a translated error. */
  function readPayers(amount) {
    if (state.payMode === 'none') return { payers: [] };
    if (state.payMode === 'one') return { payers: payerSelect.value ? [{ who: payerSelect.value, amount }] : [] , error: payerSelect.value ? null : t('costs.errorPayer') };
    const payers = [];
    for (const [who, input] of payerInputs) {
      if (!input.value.trim() || !roster().includes(who)) continue;
      let value;
      try { value = parseMoney(input.value, state.currency, locale); } catch { return { error: t('costs.errorPayerAmount', { name: people.name(who) }) }; }
      if (value) payers.push({ who, amount: value });
    }
    if (!payers.length) return { error: t('costs.errorPayer') };
    const total = payers.reduce((sum, payer) => sum + payer.amount, 0);
    if (total !== amount && !(partialOk && (amount < 0 ? total > amount : total < amount))) return { payers, error: t('costs.errorPayerTotal', { left: money(amount - total, state.currency) }) };
    return { payers };
  }

  /** The split as stored, or a translated error. */
  function readSplit(amount) {
    const mode = state.splitMode;
    if (mode === 'items') {
      const parsed = [];
      for (const [index, item] of items.entries()) {
        let value;
        try { value = parseMoney(item.amount, state.currency, locale); } catch { return { error: t('costs.errorItemAmount', { n: index + 1 }) }; }
        if (!item.who.size) return { error: t('costs.errorItemPeople', { n: index + 1 }) };
        parsed.push({ label: item.label.trim(), amount: value, who: roster().filter((who) => item.who.has(who)) });
      }
      if (!parsed.length) return { error: t('costs.errorItems') };
      const total = parsed.reduce((sum, item) => sum + item.amount, 0);
      const parts = roster().filter((who) => parsed.some((item) => item.who.includes(who))).map((who) => ({ who }));
      const split = { mode, parts, items: parsed };
      return total === amount ? { split } : { split, error: t('costs.errorSplitLeft', { left: money(amount - total, state.currency) }) };
    }
    const chosen = roster().filter((who) => state.participants.has(who));
    if (!chosen.length) return { error: t('costs.errorParticipants') };
    if (mode === 'equal') return { split: { mode, parts: chosen.map((who) => ({ who })) } };
    const parts = [];
    for (const who of chosen) {
      const text = valueInputs.get(`${mode}:${who}`)?.value ?? '';
      if (mode === 'amounts') {
        let value;
        try { value = text.trim() ? parseMoney(text, state.currency, locale) : 0; } catch { return { error: t('costs.errorValue', { name: people.name(who) }) }; }
        parts.push({ who, value });
      } else {
        const value = text.trim() ? parseDecimal(text, locale) : mode === 'percent' ? '0' : null;
        if (value === null || value.startsWith('-')) return { error: t('costs.errorValue', { name: people.name(who) }) };
        parts.push({ who, value: /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value });
      }
    }
    const split = { mode, parts };
    if (mode === 'amounts') {
      const total = parts.reduce((sum, part) => sum + part.value, 0);
      if (total !== amount) return { split, error: t('costs.errorSplitLeft', { left: money(amount - total, state.currency) }) };
    }
    if (mode === 'percent' && !decimalsEqual(parts.map((part) => String(part.value)), 100)) return { split, error: t('costs.errorPercent') };
    if (mode === 'shares' && parts.every((part) => Number(part.value) === 0)) return { split, error: t('costs.errorShares') };
    return { split };
  }

  function updateStatus() {
    const amount = amountValue();
    payStatus.textContent = '';
    splitStatus.textContent = '';
    for (const output of shareOutputs.values()) output.textContent = '';
    if (!presets.element.hidden) presets.sync();
    if (amount === null) return;
    if (state.payMode === 'several') {
      const assigned = [...payerInputs.entries()].filter(([who]) => roster().includes(who)).reduce((sum, [, input]) => {
        try { return sum + (input.value.trim() ? parseMoney(input.value, state.currency, locale) : 0); } catch { return sum; }
      }, 0);
      payStatus.textContent = assigned === amount ? t('costs.allAssigned') : t('costs.leftToAssign', { left: money(amount - assigned, state.currency) });
    }
    const { split, error } = readSplit(amount);
    if (state.splitMode === 'percent' && split) {
      const values = split.parts.map((part) => String(part.value));
      try { splitStatus.textContent = t('costs.percentTotal', { total: decimalSum(values) }); } catch { /* Shown on save. */ }
    } else if (error && split) splitStatus.textContent = error;
    if (split && !error) {
      try {
        for (const share of splitAmount(amount, split, { expenseId: id })) shareOutputs.get(share.who)?.replaceChildren(money(share.amount, state.currency));
      } catch { /* Shown on save. */ }
    }
  }

  function decimalSum(values) {
    const scale = Math.max(0, ...values.map((value) => (value.split('.')[1] ?? '').length));
    const total = values.reduce((sum, value) => { const [whole, fraction = ''] = value.split('.'); return sum + BigInt(whole + fraction.padEnd(scale, '0')); }, 0n);
    const text = total.toString().padStart(scale + 1, '0');
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 18 }).format(Number(scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text));
  }

  let rateRequest = 0;
  async function refreshRate({ force = false } = {}) {
    const differs = state.currency !== tripCurrency;
    rateField.node.hidden = !differs;
    if (!differs) return;
    if (!force && (state.rateEdited || rateInput.value.trim())) { showRateHint(); return; }
    const request = ++rateRequest;
    rateField.hint.textContent = t('costs.rateFetching');
    const rate = await fetchRate({ fx: session?.services?.fx, from: state.currency, to: tripCurrency, date: dateField.control.value || null });
    if (request !== rateRequest) return;
    if (rate) rateInput.value = decimalInput(rate, locale);
    showRateHint();
  }
  function rateValue() {
    const value = parseDecimal(rateInput.value, locale);
    return value && RATE.test(value) && /[1-9]/.test(value) ? value : null;
  }
  function showRateHint() {
    if (state.currency === tripCurrency) return;
    const rate = rateValue();
    const amount = amountValue();
    if (!rateInput.value.trim()) { rateField.hint.textContent = t('costs.ratePendingHint'); return; }
    if (!rate) { rateField.hint.textContent = t('costs.rateInvalid'); return; }
    const converted = amount === null ? null : (() => { try { return convertMinor(amount, rate, state.currency, tripCurrency); } catch { return null; } })();
    rateField.hint.textContent = converted === null ? t('costs.rateOne', { from: state.currency, rate: rateInput.value, to: tripCurrency })
      : t('costs.rateConverted', { from: state.currency, rate: rateInput.value, to: tripCurrency, amount: money(converted, tripCurrency) });
  }

  async function addGuest() {
    const name = await promptDialog({ title: t('costs.addGuest'), label: t('costs.guestName'), confirmLabel: t('costs.add') });
    if (!name?.trim()) return;
    const op = space.ops.create('guest', { name: name.trim().slice(0, 500) });
    const done = await attempt(() => space.apply([op], { history: t('costs.historyGuest') }));
    if (done === undefined && !space.get('guest', op.id)) return;
    people.refresh();
    state.participants.add(op.id);
    renderPayers(); renderSplit(); updateStatus();
  }

  function renderSections() {
    const show = showsSplit();
    payersSection.hidden = !show;
    splitSection.hidden = !show;
    receiptSection.hidden = state.private || !model.canEdit || !canAttachReceipts(space, session);
  }

  async function save(event) {
    event?.preventDefault();
    for (const node of [payError, splitError, formError]) node.hidden = true;
    nameField.setError(); amountField.setError(); rateField.setError();
    const name = nameField.control.value.trim();
    if (!name) { nameField.setError(t('costs.errorName')); nameField.control.focus(); return; }
    let amount;
    try { amount = parseMoney(amountField.control.value, state.currency, locale); } catch (error) {
      amountField.setError(t(error.code === 'too_many_decimals' ? 'costs.errorDecimals' : 'costs.errorAmount'));
      amountField.control.focus(); return;
    }
    const fields = { name, amount, currency: state.currency };
    const date = dateField.control.value;
    if (date) fields.date = date;
    if (catSelect.value) fields.cat = catSelect.value;
    const note = noteField.control.value;
    if (note.trim()) fields.note = note;
    if (state.links.length) fields.links = state.links.map((link) => ({ t: link.t, id: link.id }));
    const order = editing ? expense.order : nextOrder([...model.shared, ...model.privates], date || null);
    if (order) fields.order = order;
    if (!showsSplit()) {
      if (editing && !state.private && amount === expense.amount) {
        fields.payers = structuredClone(expense.payers);
        fields.split = structuredClone(expense.split);
      } else {
        fields.payers = editing && !state.private && !expense.payers.length ? [] : [{ who: me, amount }];
        fields.split = { mode: 'equal', parts: [{ who: me }] };
      }
    } else {
      const payers = readPayers(amount);
      if (payers.error) { payError.textContent = payers.error; payError.hidden = false; payersSection.scrollIntoView?.({ block: 'nearest' }); return; }
      const split = readSplit(amount);
      if (split.error) { splitError.textContent = split.error; splitError.hidden = false; splitSection.scrollIntoView?.({ block: 'nearest' }); return; }
      fields.payers = payers.payers;
      fields.split = split.split;
      if (fields.payers.length && state.paid.size) {
        try {
          const shares = splitAmount(amount, fields.split, { expenseId: id });
          fields.split.parts = fields.split.parts.map((part, index) => {
            const share = shares[index].amount;
            const repayable = share !== 0 && fields.payers.some((payer) => payer.who !== part.who && payer.amount !== 0);
            if (!state.paid.has(part.who) || !repayable) return part;
            // A partial amount paid back stays as it was while it still fits the share.
            const prior = source?.split.parts.find((item) => item.who === part.who)?.paid;
            const keep = Number.isSafeInteger(prior) && prior !== 0 && (prior < 0) === (share < 0) && Math.abs(prior) <= Math.abs(share);
            return { ...part, paid: keep ? prior : share };
          });
        } catch { /* Validation below reports it. */ }
      }
    }
    if (partialOk && !state.private && fields.payers.reduce((sum, payer) => sum + payer.amount, 0) !== amount) fields.due = expense.due;
    // Rate: kept frozen unless the currency changed or the user typed one; fetched now when missing.
    if (state.currency !== tripCurrency) {
      if (rateInput.value.trim()) {
        const rate = rateValue();
        if (!rate) { rateField.setError(t('costs.rateInvalid')); rateInput.focus(); return; }
        fields.rate = rate;
      } else {
        saveButton.setAttribute('aria-busy', 'true');
        fields.rate = await fetchRate({ fx: session?.services?.fx, from: state.currency, to: tripCurrency, date: date || null });
        saveButton.setAttribute('aria-busy', 'false');
      }
    }
    try { validateEntity('trip', 'exp', fields); } catch {
      formError.textContent = t('costs.errorInvalid'); formError.hidden = false; return;
    }
    saveButton.setAttribute('aria-busy', 'true');
    const ok = await persist(fields);
    saveButton.setAttribute('aria-busy', 'false');
    if (!ok) return;
    dialog.close('saved');
    if (staged.length && !state.private) void attachReceipts({ space, id, files: staged.splice(0), session });
    onSaved?.(id, fields);
  }

  async function persist(fields) {
    try {
      if (state.private) {
        await space.privateItems('exp').put(fields, id);
        return true;
      }
      if (!editing) {
        await space.apply([space.ops.create('exp', fields, { id })], { history: t('costs.historyAdd') });
        toast(t('costs.added', { name: fields.name }), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
        return true;
      }
      const set = {}; const unset = [];
      for (const key of FIELDS) {
        if (fields[key] === undefined) { if (expense[key] !== undefined) unset.push(key); }
        else if (!same(fields[key], expense[key])) set[key] = fields[key];
      }
      if (Object.keys(set).length || unset.length) {
        const op = space.ops.patch('exp', id, { set, unset }, { base: true });
        // Fields someone else changed since the form opened get a conflict instead of a silent overwrite.
        const current = space.get('exp', id);
        if (openBase && current && [...Object.keys(set), ...unset].some((key) => !same(current[key], expense[key]))) op.base = openBase;
        await space.apply([op], { history: t('costs.historyEdit') });
        toast(t('costs.saved', { name: fields.name }), { action: { label: t('costs.undo'), onClick: () => attempt(() => space.history.undo()) } });
      }
      return true;
    } catch (error) {
      formError.textContent = errorText(error); formError.hidden = false;
      return false;
    }
  }

  currencyField.control.addEventListener('change', () => {
    state.currency = currencyField.control.value;
    state.rateEdited = false;
    rateInput.value = '';
    void refreshRate({ force: true });
    updateStatus();
  });
  amountField.control.addEventListener('input', () => { updateStatus(); showRateHint(); });
  rateInput.addEventListener('input', () => { state.rateEdited = true; showRateHint(); });
  dateField.control.addEventListener('change', () => { if (!state.rateEdited && (!editing || state.currency !== expense.currency)) { rateInput.value = ''; void refreshRate({ force: true }); } });

  const saveButton = button(editing ? t('costs.saveChanges') : t('costs.addExpense'), { variant: 'primary', type: 'submit' });
  const form = el('form.costs-form', { onsubmit: save, noValidate: true },
    nameField.node,
    el('div.field-row', {}, amountField.node, currencyField.node),
    rateField.node,
    el('div.field-row', {}, dateField.node, catField.node),
    editing && !expense.private ? null : privateRow,
    payersSection, splitSection,
    noteField.node,
    receiptSection,
    el('div.field', {}, el('label.field-label', { htmlFor: linkSelect.id }, t('costs.links')), links, linkSelect),
    formError,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), saveButton));
  renderPayers(); renderSplit(); renderLinks(); renderReceipts(); renderSections(); updateStatus();
  rateField.node.hidden = state.currency === tripCurrency;
  if (state.currency !== tripCurrency) { if (rateInput.value) showRateHint(); else void refreshRate({ force: true }); }
  const dialog = track(openModal({ title: editing ? t('costs.editExpense') : t('costs.newExpense'), content: form, wide: true, onClose: () => { presets.destroy(); receiptLive?.destroy(); } }));
  return dialog;
}
