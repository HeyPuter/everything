import { el, uid as uniqueId } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field, choiceGroup } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { ensureShareConsent, forgetShareConsent } from '../../../lib/deploy.js';
import { formatInstant } from '../../../lib/format.js';
import { isUuid } from '../../../shared/ids.js';
import { icon } from './icons.js';
import { errorMessage } from './errors.js';
import { roleLabel } from './people.js';
import { namedErrorMessage, sendNamedInvite, sentView, usernameField } from './named/index.js';
import {
  DEFAULT_EXPIRY_DAYS, DEFAULT_MAX_USES, EXPIRY_DAYS, LABEL_CHARS, MAX_USES, canRevoke, cleanLabel, expiryAt, grantable,
  inviteURL, isRole, looksLikeEmail, mailtoURL,
} from './logic.js';

const HEX64 = /^[0-9a-f]{64}$/;
const count = (value) => new Intl.NumberFormat().format(value);
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let consentDeclined = false;

export function formatExpiry(exp) {
  try { return formatInstant(exp, localZone(), { style: 'medium' }); } catch { return ''; }
}

/** `invite.list` items, minus anything malformed. Newest first. */
export function cleanInvites(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && HEX64.test(item.id) && isRole(item.role) && item.role !== 'owner'
    && Number.isSafeInteger(item.exp) && Number.isSafeInteger(item.max) && item.max >= 1)
    .map((item) => ({
      id: item.id, role: item.role, exp: item.exp, max: item.max, uses: Number.isSafeInteger(item.uses) && item.uses >= 0 ? item.uses : 0,
      created: Number.isSafeInteger(item.created) ? item.created : 0, by: isUuid(item.by) ? item.by : null,
      label: typeof item.label === 'string' ? item.label.slice(0, LABEL_CHARS) : '', named: typeof item.named === 'string' ? item.named.slice(0, 64) : '',
    }))
    .sort((a, b) => b.created - a.created);
}

/** The owner grants the KV-share permission once before the first invite. Refusing degrades members to the worker path. */
async function shareConsent({ puter, session, uid, role }) {
  if (role !== 'owner' || consentDeclined || !session.db) return;
  try { await ensureShareConsent({ puter, db: session.db, uid }); }
  catch (error) {
    if (error?.code === 'account_changed') throw error;
    if (error?.code === 'consent_denied') { consentDeclined = true; toast(t('members.consentDenied'), { duration: 10_000 }); }
  }
}

export function inviteTitle(invite) {
  if (invite.label) return t('members.linkFor', { name: invite.label });
  if (invite.named) return t('members.linkFor', { name: invite.named });
  return t('members.linkAnyone');
}

export function inviteRow(invite, { me, members, onRevoke }) {
  const by = members.find((member) => member.uid === invite.by)?.name;
  const uses = invite.max === 1 ? (invite.uses ? '' : t('members.linkUnused')) : t('members.linkUses', { uses: count(invite.uses), max: count(invite.max) });
  const expiry = formatExpiry(invite.exp);
  const details = [roleLabel(invite.role), uses, expiry && t('members.linkExpires', { date: expiry }), by && t('members.linkBy', { name: by })].filter(Boolean).join(' · ');
  const title = inviteTitle(invite);
  return el('li.list-row.member-row', { dataset: { key: invite.id } },
    el('span.members-row-icon', {}, icon(invite.label || invite.named ? 'mail' : 'link')),
    el('div.member-text', {}, el('span.member-name', {}, title), el('span.member-sub', {}, details)),
    canRevoke(me, invite) && button(t('members.revoke'), { size: 'sm', variant: 'ghost', 'aria-label': t('members.revokeLabel', { name: title }),
      dataset: { focus: `invite:${invite.id}` }, onclick: () => onRevoke(invite) }));
}

async function copy(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('members.copied'));
  } catch {
    input.focus(); input.select();
    toast(t('members.copyManual'));
  }
}

function resultView({ url, label, tripTitle, close, copy = {} }) {
  const id = uniqueId('invite-url');
  const input = el('input.input.invite-url', { id, readOnly: true, value: url, spellcheck: false, onfocus: (event) => event.target.select() });
  const copyButton = button(t('members.copy'), { variant: 'primary', icon: 'copy', onclick: () => copy(url, input) });
  const shareText = t(copy.shareText ?? 'members.shareText', { title: tripTitle });
  const actions = el('div.invite-result-actions', {}, copyButton);
  if (typeof navigator.share === 'function') {
    const share = button(t('members.share'), { variant: 'outline', onclick: () => navigator.share({ title: shareText, text: shareText, url }).catch(() => {}) });
    share.prepend(icon('share'));
    actions.append(share);
  }
  if (looksLikeEmail(label)) {
    actions.append(el('a.btn.btn-outline', { href: mailtoURL(label, shareText, t(copy.emailBody ?? 'members.emailBody', { title: tripTitle, url })) }, icon('mail'), t('members.email')));
  }
  return el('div.invite-result', {},
    el('p.invite-result-title', {}, label ? t('members.inviteReadyFor', { name: label }) : t('members.inviteReady')),
    el('div.field', {}, el('label.field-label', { htmlFor: id }, t('members.inviteLinkLabel')), input),
    actions,
    el('p.members-hint', {}, t('members.inviteOnce')),
    el('div.modal-actions', {}, button(t('members.done'), { onclick: () => close() })));
}

/** Create-link dialog. Resolves when it closes; `onCreated` runs after a link is made. `copy` overrides string keys for other space kinds. */
export function openInviteDialog({ api, session, puter, uid, me, ref, tripTitle, onCreated, location = globalThis.location, copy = {} }) {
  const roles = grantable(me.role);
  const mode = choiceGroup({ label: t('sharing.inviteWho'), value: 'anyone', onChange: (value) => sync(value), items: [
    { value: 'anyone', label: t('members.inviteAnyone'), hint: t('members.inviteAnyoneHint') },
    { value: 'personal', label: t('members.invitePersonal'), hint: t('members.invitePersonalHint') },
    { value: 'puter', label: t('sharing.inviteUser'), hint: t('sharing.inviteUserHint') },
  ] });
  const username = usernameField({ self: session?.account?.username });
  const label = field({ label: t('members.inviteLabel'), hint: t('members.inviteLabelHint'), maxLength: LABEL_CHARS * 2, autocomplete: 'off' });
  const role = choiceGroup({ label: t('members.inviteRole'), value: roles.includes('editor') ? 'editor' : roles[0],
    items: roles.map((value) => ({ value, label: roleLabel(value), hint: t(`${copy.roleHint ?? 'members.roleHint'}.${value}`) })) });
  const expiry = field({ label: t('members.inviteExpiry'), type: 'select', value: String(DEFAULT_EXPIRY_DAYS),
    options: EXPIRY_DAYS.map((days) => ({ value: String(days), label: days === 1 ? t('members.inviteDay') : t('members.inviteDays', { count: count(days) }) })) });
  const max = field({ label: t('members.inviteMax'), type: 'select', value: String(DEFAULT_MAX_USES),
    options: MAX_USES.map((value) => ({ value: String(value), label: t('members.inviteMaxCount', { count: count(value) }) })) });
  const alert = el('p.members-alert', { role: 'alert', hidden: true });
  const submit = button(t('members.inviteCreate'), { type: 'submit', variant: 'primary' });
  const whoId = uniqueId('invite-who');
  const roleId = uniqueId('invite-role');
  const form = el('form.invite-form', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void create(); } },
    el('div.invite-group', {}, el('span.field-label', { id: whoId }, t('sharing.inviteWho')), mode.element),
    label.element, username.element,
    el('div.invite-group', {}, el('span.field-label', { id: roleId }, t('members.inviteRole')), role.element),
    el('div.field-row.invite-limits', {}, expiry.element, max.element),
    alert,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), submit));
  mode.element.setAttribute('aria-labelledby', whoId);
  role.element.setAttribute('aria-labelledby', roleId);
  function sync(value) {
    label.element.hidden = value !== 'personal';
    max.element.hidden = value !== 'anyone';
    if (value !== 'personal') label.setError('');
    username.element.hidden = value !== 'puter';
    if (value !== 'puter') username.clear();
    expiry.element.querySelector('.field-label').textContent = t(value === 'puter' ? 'sharing.inviteExpiry' : 'members.inviteExpiry');
    submit.textContent = t(value === 'puter' ? 'sharing.send' : 'members.inviteCreate');
  }
  sync('anyone');
  const dialog = openModal({ title: t('members.inviteTitle'), content: form });

  let busy = false;
  async function create() {
    if (busy) return;
    if (mode.value === 'puter') { void named(); return; }
    const personal = mode.value === 'personal';
    let name;
    if (personal) {
      const cleaned = cleanLabel(label.input.value);
      if (cleaned.error) { label.setError(t(cleaned.error === 'required' ? 'members.inviteLabelRequired' : 'members.inviteLabelTooLong')); label.input.focus(); return; }
      name = cleaned.value;
      label.setError('');
    }
    busy = true; submit.setAttribute('aria-busy', 'true'); alert.hidden = true;
    try {
      await shareConsent({ puter, session, uid, role: me.role });
      const input = { role: role.value, exp: expiryAt(Number(expiry.input.value)), max: personal ? 1 : Number(max.input.value), ...(name ? { label: name } : {}) };
      const result = await api.call(ref, 'invite.create', input);
      const url = inviteURL(location.href, ref, result.token);
      onCreated?.();
      if (!form.isConnected) return;
      const panel = resultView({ url, label: name, tripTitle, close: () => dialog.close('done'), copy });
      form.replaceWith(panel);
      panel.querySelector('.btn-primary')?.focus();
    } catch (error) {
      alert.textContent = errorMessage(error, { context: 'invite' }); alert.hidden = false;
    } finally {
      busy = false; submit.setAttribute('aria-busy', 'false');
    }
  }
  async function named() {
    const name = username.read();
    if (!name) return;
    busy = true; submit.setAttribute('aria-busy', 'true'); alert.hidden = true;
    try {
      await shareConsent({ puter, session, uid, role: me.role });
      await sendNamedInvite(api, ref, { role: role.value, exp: expiryAt(Number(expiry.input.value)), username: name });
      onCreated?.();
      if (!form.isConnected) return;
      const panel = sentView({ username: name, close: () => dialog.close('done') });
      form.replaceWith(panel);
      panel.querySelector('.btn-primary')?.focus();
    } catch (error) {
      // The consent was withdrawn in Puter: ask again on the next attempt.
      if (error?.code === 'share_consent_required' && session.db) { consentDeclined = false; await forgetShareConsent({ db: session.db }).catch(() => {}); }
      alert.textContent = namedErrorMessage(error); alert.hidden = false;
    } finally {
      busy = false; submit.setAttribute('aria-busy', 'false');
    }
  }
  return dialog;
}
