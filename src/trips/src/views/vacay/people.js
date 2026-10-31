// People panel: you, fused people, read-only overlays, who you share with, and incoming invites.
import { el } from '../../ui/dom.js';
import { button, iconButton } from '../../ui/bits.js';
import { choiceGroup, field } from '../../ui/fields.js';
import { openMenu } from '../../ui/menu.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';
import { COLORS } from '../../lib/vacay/model.js';
import { daysText, errorText, nameOf } from './text.js';

const PEER_STATUS = { loading: 'loading', denied: 'denied', credit: 'credit', offline: 'offline', rate: 'rate', disabled: 'disabled', failed: 'failed', account: 'failed' };

function peerStatus(peer) {
  if (peer.status !== 'ok') return t(`vacay.status.${PEER_STATUS[peer.status] ?? 'failed'}`);
  if (peer.mode === 'view') return t('vacay.status.viewing');
  return t(`vacay.status.${{ yes: 'together', pending: 'pending', unlinked: 'unlinked', mismatch: 'mismatch' }[peer.verified] ?? 'pending'}`);
}

const swatch = (color, ring = false) => el(`span.vacay-swatch${ring ? '.is-ring' : ''}`, { 'aria-hidden': 'true', style: { '--mark': `var(--day-${color})` } });

export function colorItems(current, onPick) {
  return Array.from({ length: COLORS }, (_, index) => ({ label: t(`vacay.color.${index + 1}`), checked: current === index + 1, onSelect: () => onPick(index + 1) }));
}

/**
 * `model`: `{available, me: {name, color, used}, peers: [{peer, color, hidden, days}], grants: [{h, grant, linked}], incoming: [invite]}`.
 * `actions`: `{invite, accept(h), decline(h), leave(h), revoke(h), upgrade(h), toggle(h), color(h, slot), myColor(slot)}`.
 */
export function renderPeople(model, actions, { busy = false } = {}) {
  const rows = [];
  rows.push(el('li.vacay-person', { dataset: { focus: 'me' } }, swatch(model.me.color),
    el('span.vacay-person-text', {}, el('strong', {}, t('vacay.you')), el('span', {}, daysText(model.me.used))),
    iconButton('more', t('vacay.myColor'), { dataset: { focus: 'me:menu' }, onclick: (event) => openMenu(event.currentTarget, colorItems(model.me.color, actions.myColor)) })));
  for (const { peer, color, hidden, days } of model.peers) {
    const name = nameOf(peer.name);
    const items = [
      { label: hidden ? t('vacay.show') : t('vacay.hide'), onSelect: () => actions.toggle(peer.h) },
      { separator: true },
      ...colorItems(color, (slot) => actions.color(peer.h, slot)),
      { separator: true },
      { label: peer.mode === 'fused' ? t('vacay.dissolve') : t('vacay.removeOverlay'), danger: true, onSelect: () => actions.leave(peer.h) },
    ];
    rows.push(el(`li.vacay-person${hidden ? '.is-hidden' : ''}`, { dataset: { focus: `peer:${peer.h}`, peer: peer.h } }, swatch(color, peer.mode === 'view'),
      el('span.vacay-person-text', {}, el('strong', {}, name),
        el('span', {}, peerStatus(peer), peer.status === 'ok' ? ` · ${daysText(days)}` : '', hidden ? ` · ${t('vacay.hidden')}` : '')),
      peer.upgrade ? button(t('vacay.accept'), { size: 'sm', variant: 'primary', disabled: busy, 'aria-label': t('vacay.acceptTogether', { name }), onclick: () => actions.accept(peer.h) }) : null,
      iconButton('more', t('vacay.personActions', { name }), { dataset: { focus: `peer:${peer.h}:menu` }, onclick: (event) => openMenu(event.currentTarget, items) })));
  }
  const sharing = model.grants.filter(({ linked }) => !linked).map(({ h, grant }) => {
    const name = nameOf(grant.name);
    const pending = grant.mode === 'fused';
    const items = [
      ...(pending ? [] : [{ label: t('vacay.upgrade'), onSelect: () => actions.upgrade(h) }]),
      { label: pending ? t('vacay.cancelInvite') : t('vacay.stopSharing'), danger: true, onSelect: () => actions.revoke(h) },
    ];
    return el('li.vacay-person', { dataset: { focus: `grant:${h}`, grant: h } }, el('span.vacay-swatch.is-empty', { 'aria-hidden': 'true' }),
      el('span.vacay-person-text', {}, el('strong', {}, name), el('span', {}, t(pending ? 'vacay.grant.pending' : 'vacay.grant.view'))),
      iconButton('more', t('vacay.personActions', { name }), { dataset: { focus: `grant:${h}:menu` }, onclick: (event) => openMenu(event.currentTarget, items) }));
  });
  const incoming = model.incoming.map((invite) => {
    const name = nameOf(invite.name);
    return el('li.vacay-invite', { dataset: { focus: `invite:${invite.h}`, invite: invite.h } },
      el('p', {}, t(invite.mode === 'fused' ? 'vacay.invite.fused' : 'vacay.invite.view', { name })),
      invite.complete ? null : el('p.vacay-hint', {}, t('vacay.invite.incomplete')),
      el('div.vacay-invite-actions', {},
        button(t('vacay.decline'), { size: 'sm', disabled: busy, 'aria-label': t('vacay.declineFrom', { name }), onclick: () => actions.decline(invite.h) }),
        button(t('vacay.accept'), { size: 'sm', variant: 'primary', disabled: busy, 'aria-label': t('vacay.acceptFrom', { name }), onclick: () => actions.accept(invite.h) })));
  });
  return el('section.vacay-card.vacay-people', { 'aria-labelledby': 'vacay-people-title' },
    el('div.vacay-card-head', {}, el('h2', { id: 'vacay-people-title' }, t('vacay.people')),
      model.available ? button(t('vacay.inviteButton'), { size: 'sm', icon: 'plus', disabled: busy, dataset: { focus: 'invite' }, onclick: actions.invite }) : null),
    model.available ? null : el('p.vacay-hint', {}, t('vacay.sharingUnavailable')),
    incoming.length ? el('div', {}, el('h3.vacay-subhead', {}, t('vacay.invitations')), el('ul.vacay-list', {}, incoming)) : null,
    el('ul.vacay-list', { 'aria-label': t('vacay.people') }, rows),
    sharing.length ? el('div', {}, el('h3.vacay-subhead', {}, t('vacay.sharingWith')), el('ul.vacay-list', {}, sharing)) : null);
}

/** Invite dialog; `submit({username, mode})` rejects with a Vacay error to keep the dialog open. */
export function openInviteDialog({ submit }) {
  const username = field({ label: t('vacay.inviteUser'), hint: t('vacay.inviteUserHint'), autocomplete: 'off', spellcheck: false, required: true, maxLength: 64 });
  const mode = choiceGroup({ label: t('vacay.inviteMode'), value: 'fused', items: [
    { value: 'fused', label: t('vacay.modeFused'), hint: t('vacay.modeFusedHint') },
    { value: 'view', label: t('vacay.modeView'), hint: t('vacay.modeViewHint') },
  ] });
  const sendButton = button(t('vacay.inviteSend'), { type: 'submit', variant: 'primary' });
  const form = el('form.vacay-form', {
    onsubmit: async (event) => {
      event.preventDefault();
      username.setError('');
      if (!username.input.value.trim()) { username.setError(t('vacay.error.noUser')); username.input.focus(); return; }
      sendButton.setAttribute('aria-busy', 'true');
      try {
        await submit({ username: username.input.value, mode: mode.value });
        dialog.close('done');
      } catch (error) {
        username.setError(errorText(error));
        username.input.focus();
      } finally { sendButton.setAttribute('aria-busy', 'false'); }
    },
  }, username.element, el('fieldset.vacay-fieldset', {}, el('legend.field-label', {}, t('vacay.inviteMode')), mode.element),
  el('p.vacay-hint', {}, t('vacay.privacy')),
  el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), sendButton));
  const dialog = openModal({ title: t('vacay.inviteTitle'), content: form, initialFocus: username.input });
  return dialog;
}
