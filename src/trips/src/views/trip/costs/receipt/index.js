import './receipt.css';
import { el, append, clear } from '../../../../ui/dom.js';
import { button, spinner } from '../../../../ui/bits.js';
import { checkbox } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { t } from '../../../../lib/i18n/index.js';
import { aiPrefs } from '../../../../lib/prefs.js';
import { formatDate } from '../../../../lib/format.js';
import { localToday } from '../../../../lib/costs/fx.js';
import { RECEIPT_ACCEPT, readReceipt, receiptErrorCode } from '../../../../lib/ai/receipt.js';
import { chooseLocalFiles } from '../../../../lib/files/index.js';
import { attachReceipts, canAttachReceipts } from './attach.js';
import { categoryLabel, money } from '../shared.js';

export const canScan = (puter) => typeof puter?.ai?.chat === 'function';

/**
 * Expense fields for the form from a validated receipt. Nothing here is saved: the form opens with these values for
 * the user to check. `byItems` splits by line items among `people`; otherwise the items go into the note.
 */
export function receiptDraft(receipt, { me, people, tripCurrency, byItems = false, today = localToday(), line }) {
  const currency = receipt?.currency ?? tripCurrency;
  const everyone = people.length ? people : [me];
  const items = byItems && receipt?.itemsMatch ? receipt.items : [];
  const draft = {
    name: receipt?.name ?? '',
    amount: receipt?.amount ?? null,
    currency,
    date: receipt?.date ?? today,
    payers: [{ who: me, amount: receipt?.amount ?? 0 }],
    split: items.length
      ? { mode: 'items', parts: everyone.map((who) => ({ who })), items: items.map((item) => ({ label: item.label, amount: item.amount, who: [...everyone] })) }
      : { mode: 'equal', parts: everyone.map((who) => ({ who })) },
  };
  if (receipt?.cat) draft.cat = receipt.cat;
  if (!items.length && receipt?.items?.length && line) draft.note = receipt.items.map((item) => line(item, currency)).join('\n');
  return draft;
}

/** Picks a receipt photo, reads it with AI and opens the expense form prefilled. */
export async function scanReceipt(options) {
  const [file] = await chooseLocalFiles({ accept: RECEIPT_ACCEPT, multiple: false });
  if (file) openReceiptDialog({ ...options, file });
}

/**
 * `getModel()` is the costs model, `openForm(extra)` opens the expense form. The receipt can be attached to the saved
 * expense when it is shared and the member may upload files.
 */
export function openReceiptDialog({ file, space, getModel, people, session, puter, track, openForm }) {
  const model = getModel();
  const controller = new AbortController();
  const preview = URL.createObjectURL(file);
  const status = el('div.receipt-status', { role: 'status', 'aria-live': 'polite' });
  const summary = el('div.receipt-summary');
  const options = el('div.receipt-options');
  const actions = el('div.costs-actions');
  let receipt = null;
  let byItems = false;
  const canAttach = () => model.canEdit && canAttachReceipts(space, session);
  let attach = canAttach();

  const content = el('div.receipt', {},
    el('div.receipt-preview', {}, el('img', { src: preview, alt: t('receipt.previewAlt') })),
    el('div.receipt-body', {}, status, summary, options));
  const dialog = track(openModal({ title: t('receipt.title'), content, actions: [actions], wide: true, onClose: () => {
    controller.abort();
    // The form may still be showing the image; revoke after it closes.
    setTimeout(() => URL.revokeObjectURL(preview), 60_000);
  } }));

  const line = (item, currency) => `${item.label} · ${money(item.amount, currency)}`;
  function review() {
    const draft = receiptDraft(receipt, { me: people.me, people: people.list.map((person) => person.id), tripCurrency: model.tripCurrency, byItems, line });
    const withFile = attach && canAttach();
    dialog.close('review');
    openForm({ copy: draft, onSaved: withFile ? (id) => attachTo(id) : undefined });
  }
  const attachTo = (id) => attachReceipts({ space, id, files: [file], session, puter });

  function attachOption() {
    if (!canAttach()) return null;
    return checkbox(t('receipt.attach'), { checked: attach, onChange: (value) => { attach = value; } });
  }

  function showReading() {
    status.replaceChildren(spinner(), el('span', {}, t('receipt.reading')));
    summary.replaceChildren(el('p.field-hint', {}, t('receipt.billing')));
    options.replaceChildren();
    actions.replaceChildren(
      button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }),
      button(t('receipt.manual'), { onclick: () => { receipt = null; review(); } }));
  }

  function showResult(result) {
    receipt = result;
    const rows = [];
    const add = (label, value) => { if (value) rows.push(el('dt', {}, label), el('dd', {}, value)); };
    add(t('receipt.merchant'), result.name || t('receipt.unknown'));
    add(t('receipt.total'), result.amount !== null ? money(result.amount, result.currency) : t('receipt.unknown'));
    add(t('receipt.date'), result.date ? formatDate(result.date, { weekday: true }) : t('receipt.unknown'));
    if (result.cat) add(t('receipt.category'), categoryLabel(result.cat, space));
    if (result.tax) add(t('receipt.tax'), money(result.tax, result.currency));
    if (result.tip) add(t('receipt.tip'), money(result.tip, result.currency));
    if (result.items.length) add(t('receipt.items'), result.items.length === 1 ? t('receipt.itemCountOne') : t('receipt.itemCountMany', { count: result.items.length }));
    const warnings = result.warnings.map((code) => el('li', {}, t(`receipt.warn.${code}`)));
    if (result.confidence < 0.5) warnings.push(el('li', {}, t('receipt.warn.confidence')));
    status.replaceChildren(el('span', {}, t('receipt.read')));
    append(clear(summary), [el('dl.receipt-fields', {}, rows),
      warnings.length ? el('ul.receipt-warnings', { 'aria-label': t('receipt.checkThese') }, warnings) : null,
      el('p.field-hint', {}, t('receipt.reviewHint'))]);
    const splitByItems = result.itemsMatch && model.splitCosts && model.canEdit
      ? checkbox(t('receipt.splitItems'), { checked: byItems, onChange: (value) => { byItems = value; } }) : null;
    options.replaceChildren(...[splitByItems, attachOption()].filter(Boolean));
    const next = button(t('receipt.review'), { variant: 'primary', onclick: review });
    actions.replaceChildren(button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), next);
    next.focus();
  }

  function showError(error) {
    const code = receiptErrorCode(error);
    if (code === 'aborted') return;
    status.replaceChildren(el('span.receipt-error', {}, t(`receipt.error.${code}`)));
    summary.replaceChildren();
    options.replaceChildren(...[attachOption()].filter(Boolean));
    const manual = button(t('receipt.manual'), { variant: 'primary', onclick: () => { receipt = null; review(); } });
    actions.replaceChildren(button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }),
      ['credit', 'type', 'too_large', 'unavailable'].includes(code) ? null : button(t('receipt.retry'), { onclick: run }),
      manual);
    manual.focus();
  }

  async function run() {
    showReading();
    try {
      const { receipt: result } = await readReceipt(file, { puter, model: aiPrefs().quickModel, tripCurrency: model.tripCurrency, today: localToday(), signal: controller.signal });
      if (!controller.signal.aborted) showResult(result);
    } catch (error) {
      if (!controller.signal.aborted) showError(error);
    }
  }

  void run();
  return dialog;
}
