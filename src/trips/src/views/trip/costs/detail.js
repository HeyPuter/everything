import { el, append, clear } from '../../../ui/dom.js';
import { button, chip } from '../../../ui/bits.js';
import { openModal, confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { expenseView, rateState } from '../../../lib/costs/ledger.js';
import { attempt, categoryBadge, categoryLabel, money } from './shared.js';
import { icon } from './icons.js';
import { detailBlocks } from './extras/index.js';
import { attachmentList } from '../../../lib/files/ui.js';

/** The fields that recreate an expense (for undoing a delete). */
export function expenseFields(entity) {
  const { id: _id, v: _v, rev: _rev, upd: _upd, by: _by, cr: _cr, t: _t, private: _private, ...fields } = entity;
  return structuredClone(fields);
}

/** Deletes a shared or private expense, offering Undo (a delete itself is not in the undo history). */
export async function deleteExpense(space, entity) {
  const ok = await confirmDialog({ title: t('costs.deleteTitle'), body: t('costs.deleteBody', { name: entity.name }), confirmLabel: t('costs.delete'), danger: true });
  if (!ok) return false;
  const fields = expenseFields(entity);
  const done = await attempt(async () => {
    if (entity.private) await space.privateItems('exp').remove(entity.id);
    else await space.apply([space.ops.remove('exp', entity.id)]);
    return true;
  });
  if (!done) return false;
  toast(t('costs.deleted', { name: entity.name }), { action: { label: t('costs.undo'), onClick: () => attempt(() => (entity.private
    ? space.privateItems('exp').put(fields, entity.id)
    : space.apply([space.ops.create('exp', fields)]))) } });
  return true;
}

/** One expense with shares, paid-back toggles, links and receipts. `onEdit`/`onCopy` open the form. */
export function openExpenseDetail({ space, model, people, track, id, priv = false, onEdit, onCopy, openAcross = null }) {
  const body = el('div.costs-detail');
  const actions = el('div.costs-actions');
  let dialog;
  const current = () => (priv ? model().privates.find((item) => item.id === id) : space.get('exp', id));
  // Receipts are trip files, so private expenses have none. The list keeps itself current.
  const receipts = priv ? null : attachmentList(space, { t: 'exp', id }, { label: t('costs.receipts') });

  function render() {
    const entity = current();
    if (!entity) { body.replaceChildren(el('p', {}, t('costs.goneBody'))); actions.replaceChildren(button(t('ui.close'), { onclick: () => dialog.close() })); return; }
    const { tripCurrency, canEdit } = model();
    const editable = entity.private || canEdit;
    let view = null;
    try { view = expenseView(entity, tripCurrency); } catch { view = null; }
    const state = rateState(entity, tripCurrency);
    const shareOf = new Map((view?.own.shares ?? []).map((share) => [share.who, share.amount]));
    const parts = entity.split.parts;
    const repayable = (who) => entity.payers.some((payer) => payer.who !== who && payer.amount !== 0);

    const togglePaid = (who, on) => attempt(async () => {
      const split = structuredClone(entity.split);
      split.parts = split.parts.map((part) => {
        if (part.who !== who) return part;
        const { paid: _paid, ...rest } = part;
        return on ? { ...rest, paid: shareOf.get(who) } : rest;
      });
      if (entity.private) await space.privateItems('exp').put({ ...expenseFields(entity), split }, entity.id);
      else await space.apply([space.ops.patch('exp', entity.id, { set: { split } }, { base: true })], { history: t('costs.historyPaid') });
    });

    append(clear(body), [
      el('div.costs-detail-head', {}, categoryBadge(entity.cat),
        el('div.costs-detail-title', {}, el('strong.num.costs-detail-amount', {}, money(entity.amount, entity.currency)),
          el('span.field-hint', {}, [entity.date ? formatDate(entity.date, { weekday: true }) : t('costs.noDate'), categoryLabel(entity.cat, space)].join(' · '))),
        entity.private ? chip(t('costs.private'), {}) : null),
      state === 'frozen' && view ? el('p.costs-detail-rate', {}, t('costs.rateLine', { amount: money(view.total, tripCurrency), from: entity.currency, rate: entity.rate, to: tripCurrency })) : null,
      state === 'pending' ? el('p.costs-notice', { role: 'note' }, icon('warning', 16), el('span', {}, t('costs.pendingOne'))) : null,
      entity.private ? el('p.field-hint', {}, icon('lock', 14), ' ', t('costs.privateHint')) : null,
      !entity.private ? el('section.costs-detail-block', {}, el('h3.costs-block-title', {}, t('costs.paidBy')),
        entity.payers.length ? el('ul.costs-plain-list', {}, entity.payers.map((payer) => el('li.costs-row', {}, people.avatar(payer.who, 24),
          el('span.costs-row-name', {}, people.name(payer.who)), el('span.num', {}, money(payer.amount, entity.currency)))))
          : el('p.field-hint', {}, t('costs.unpaidHint'))) : null,
      !entity.private ? el('section.costs-detail-block', {}, el('h3.costs-block-title', {}, t('costs.splitHeading', { mode: t(`costs.mode.${entity.split.mode}`) })),
        el('ul.costs-plain-list', {}, parts.map((part) => {
          const canToggle = editable && repayable(part.who) && shareOf.get(part.who);
          const paid = Boolean(part.paid);
          return el('li.costs-row', {}, people.avatar(part.who, 24), el('span.costs-row-name', {}, people.name(part.who)),
            el('span.num', {}, money(shareOf.get(part.who) ?? 0, entity.currency)),
            canToggle ? el('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-pressed': String(paid), onclick: () => togglePaid(part.who, !paid) },
              icon(paid ? 'check' : 'coins', 16), paid ? t('costs.paidBackDone') : t('costs.markPaid'))
              : paid ? chip(t('costs.paidBackDone'), { status: 'success' }) : null);
        })),
        entity.split.mode === 'items' ? el('ul.costs-plain-list.costs-items', {}, (entity.split.items ?? []).map((item) => el('li.costs-row', {},
          el('span.costs-row-name', {}, item.label || t('costs.itemUntitled')), el('span.field-hint', {}, item.who.map((who) => people.name(who)).join(', ')),
          el('span.num', {}, money(item.amount, entity.currency))))) : null) : null,
      ...detailBlocks({ space, entity, model: model(), people, track, openAcross: openAcross ? (expense) => { dialog.close('across'); openAcross(expense); } : null }),
      entity.note ? el('section.costs-detail-block', {}, el('h3.costs-block-title', {}, t('costs.note')), el('p.costs-note', {}, entity.note)) : null,
      entity.links?.length ? el('section.costs-detail-block', {}, el('h3.costs-block-title', {}, t('costs.links')), el('div.costs-links', {}, entity.links.map((link) => {
        const target = space.get(link.t, link.id);
        return chip(target ? (target.title || target.name || space.get('place', target.placeId)?.name || t('costs.linkUnknown')) : t('costs.linkUnknown'));
      }))) : null,
      receipts && !entity.private ? el('div.costs-detail-block', {}, receipts.element) : null,
    ]);
    append(clear(actions), [
      editable ? button(t('costs.delete'), { variant: 'danger', onclick: async () => { if (await deleteExpense(space, entity)) dialog.close('deleted'); } }) : null,
      editable || !entity.private ? button(t('costs.duplicate'), { onclick: () => { dialog.close('copy'); onCopy?.(entity); } }) : null,
      editable ? button(t('costs.edit'), { variant: 'primary', onclick: () => { dialog.close('edit'); onEdit?.(entity); } }) : null,
    ]);
  }

  render();
  const off = priv ? space.subscribe('exp', render) : space.subscribe((event) => { if (event.changed.has(`exp:${id}`) || event.types.has('file') || event.types.has('member') || event.types.has('guest')) render(); });
  dialog = track(openModal({ title: current()?.name ?? t('costs.expense'), content: body, actions: [actions], wide: true, onClose: () => { off(); receipts?.destroy(); } }));
  return dialog;
}
