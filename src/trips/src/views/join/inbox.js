import './join.css';
import { el } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { spaceRoute } from '../../shared/protocol.js';
import { errorMessage } from '../trip/members/errors.js';
import { formatExpiry } from '../trip/members/invites.js';
import { roleLabel } from '../trip/members/people.js';

/** The invitations dialog over the entry's model (`createInboxEntry`). Accepting opens the trip. */
export function openInbox(model) {
  const body = el('div.join-inbox', { 'aria-live': 'polite' });
  const pending = new Set();
  const dialog = openModal({ title: t('join.inboxTitle'), content: body });

  async function accept(invite) {
    pending.add(invite.invite); render();
    try {
      const result = await model.invites.accept(invite);
      toast(result.indexed ? t('join.inboxJoined', { title: invite.title }) : t('join.notIndexed'), { duration: result.indexed ? 6000 : 10_000 });
      dialog.close('accept');
      model.context?.app?.navigate(spaceRoute(result.ref));
      void model.refresh();
    } catch (error) {
      pending.delete(invite.invite);
      toast(errorMessage(error));
      void model.refresh();
    }
  }
  async function decline(invite) {
    pending.add(invite.invite); render();
    try {
      await model.invites.decline(invite);
      toast(t('join.inboxDeclined'));
    } catch (error) {
      toast(errorMessage(error));
    }
    pending.delete(invite.invite);
    void model.refresh();
  }
  function item(invite) {
    const busy = pending.has(invite.invite);
    const expiry = formatExpiry(invite.exp);
    return el('li.join-inbox-item', {},
      el('strong.join-trip', {}, invite.title),
      el('span.join-hint', {}, t('join.inboxFrom', { owner: invite.ownerName || t('ui.unknown'), role: roleLabel(invite.role) })),
      expiry && el('span.join-hint', {}, t('join.expires', { date: expiry })),
      el('div.join-actions', {},
        button(t('join.inboxAccept'), { variant: 'primary', size: 'sm', busy, 'aria-label': t('join.inboxAcceptLabel', { title: invite.title }), onclick: () => void accept(invite) }),
        button(t('join.inboxDecline'), { variant: 'ghost', size: 'sm', disabled: busy, 'aria-label': t('join.inboxDeclineLabel', { title: invite.title }), onclick: () => void decline(invite) })));
  }
  function render() {
    let content;
    if (model.state === 'error' && !model.items.length) {
      content = el('div.join-error', { role: 'alert' }, el('p', {}, t('join.inboxError', { reason: errorMessage(model.error) })),
        button(t('members.retry'), { size: 'sm', onclick: () => void model.refresh() }));
    } else if (model.state === 'loading' && !model.items.length) content = el('p.join-loading', { role: 'status' }, spinner(), t('join.inboxLoading'));
    else if (!model.items.length) content = emptyState({ title: t('join.inboxEmpty'), body: t('join.inboxEmptyBody'), icon: 'users' });
    else content = el('ul.join-inbox-list', {}, model.items.map(item));
    const focusKey = document.activeElement?.closest?.('.join-inbox-item') ? document.activeElement.getAttribute('aria-label') : null;
    body.replaceChildren(content);
    if (focusKey) [...body.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === focusKey)?.focus();
  }
  const off = model.subscribe(render);
  void dialog.closed.then(off);
  render();
  void model.refresh();
  return dialog;
}
