// Sharing a collection: members and roles, invite links (the trip invite mechanics), the read-only public link and leaving.
import { el, uid as uniqueId } from '../../ui/dom.js';
import { button, iconButton, spinner } from '../../ui/bits.js';
import { switchField } from '../../ui/fields.js';
import { openMenu } from '../../ui/menu.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { can } from '../../shared/perms.js';
import { WORKER_PATTERN } from '../../shared/protocol.js';
import { isId } from '../../shared/ids.js';
import { canManage, grantable, roleIn, sortMembers } from '../trip/members/logic.js';
import { personAvatar, roleLabel } from '../trip/members/people.js';
import { cleanInvites, inviteRow, openInviteDialog } from '../trip/members/invites.js';
import { errorMessage } from '../trip/members/errors.js';
import { keepFocus, menuOpen } from '../trip/members/focus.js';
import { icon } from './icons.js';
import { errorText, leaveCollection } from './spaces.js';

const TOKEN = /^[0-9a-f]{32}$/;
export const INVITE_COPY = Object.freeze({ shareText: 'collections.shareText', emailBody: 'collections.emailBody', roleHint: 'collections.roleHint' });

/** `#/s/<worker>/<space>/<token>` on this app's address, without Puter launch parameters. */
export function publicURL(base, ref, token) {
  if (!WORKER_PATTERN.test(ref?.w) || !isId(ref?.s) || !TOKEN.test(token)) throw new TypeError('invalid_public_link');
  const url = new URL(base);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('puter.')) url.searchParams.delete(key);
  url.hash = `#/s/${ref.w}/${ref.s}/${token}`;
  return url.href;
}

async function copyText(text, input) {
  try { await navigator.clipboard.writeText(text); toast(t('collections.copied')); } catch { input.focus(); input.select(); toast(t('collections.copyManual')); }
}

export function openSharing({ space, context, ref, onLeft }) {
  const { session, account, puter } = context;
  const api = session.api;
  const uid = account?.uuid ?? session.account?.uuid;
  const offs = [];
  const busy = new Set();
  let invites = { status: 'idle', items: [] };
  let me = access();
  let token = null;
  let closed = false;
  let deferred = 0;

  function access() {
    const role = roleIn(space, uid);
    return { uid, role, perms: {}, manage: can(role, 'members.manage'), share: can(role, 'share.manage') };
  }
  const name = () => space.get('meta', 'meta')?.name || t('collections.untitled');

  const membersId = uniqueId('col-members');
  const list = el('ul.card.members-list', { 'aria-labelledby': membersId });
  const inviteButton = button(t('collections.invite'), { variant: 'primary', onclick: () => invite() });
  inviteButton.prepend(icon('invite', 16));
  const linksId = uniqueId('col-links');
  const linksBody = el('div');
  const links = el('section.col-share-section', { 'aria-labelledby': linksId }, el('h3', { id: linksId }, t('collections.inviteLinks')), linksBody);
  const publicSection = el('section.col-share-section');
  const leaveSection = el('section.col-share-section');
  const content = el('div.col-sharing', {},
    el('section.col-share-section', { 'aria-labelledby': membersId },
      el('div.col-share-head', {}, el('h3', { id: membersId }, t('collections.members')), inviteButton), list),
    links, publicSection, leaveSection);

  function memberRow(member) {
    const manageable = canManage(me, member);
    return el('li.list-row.member-row', { dataset: { key: member.uid } },
      personAvatar(member, { puter, presence: true }),
      el('div.member-text', {}, el('span.member-name', {}, member.name, member.uid === uid && el('span.chip.chip-accent.member-you', {}, t('collections.you')))),
      el('span.chip.member-role', { dataset: { role: member.role } }, roleLabel(member.role)),
      manageable && iconButton('more', t('collections.memberActions', { name: member.name }), {
        dataset: { focus: `member:${member.uid}` }, disabled: busy.has(member.uid), onclick: (event) => memberMenu(event.currentTarget, member),
      }));
  }
  function renderMembers() {
    if (closed) return;
    if (menuOpen(list)) { clearTimeout(deferred); deferred = setTimeout(renderMembers, 1000); return; }
    const all = sortMembers(space.members().filter((member) => member.role), uid);
    keepFocus(list, () => list.replaceChildren(...all.map(memberRow)));
  }
  function memberMenu(anchor, member) {
    openMenu(anchor, [
      ...grantable(me.role).map((role) => ({ label: t('collections.makeRole', { role: roleLabel(role) }), checked: member.role === role,
        onSelect: () => { if (member.role !== role) void act(member, 'member.role', { uuid: member.uid, role }, t('collections.roleChanged', { name: member.name, role: roleLabel(role) })); } })),
      { separator: true },
      { label: t('collections.removeMember'), icon: 'trash', danger: true, onSelect: () => void remove(member) },
    ]);
  }
  async function act(member, op, input, success) {
    busy.add(member.uid); renderMembers();
    try { await api.call(ref, op, input); toast(success); } catch (error) { toast(errorMessage(error, { context: 'member' })); } finally {
      busy.delete(member.uid);
      if (!closed) { renderMembers(); void space.sync?.().catch(() => {}); }
    }
  }
  async function remove(member) {
    const ok = await confirmDialog({ title: t('collections.removeTitle', { name: member.name }), body: t('collections.removeBody', { name: member.name }), confirmLabel: t('collections.removeMember'), danger: true });
    if (ok && !closed) await act(member, 'member.remove', { uuid: member.uid }, t('collections.removed', { name: member.name }));
  }

  function renderLinks() {
    links.hidden = !me.manage;
    if (!me.manage) return;
    let body;
    if (invites.status === 'loading' || invites.status === 'idle') body = el('p.col-hint', {}, spinner(), t('collections.linksLoading'));
    else if (invites.status === 'error') body = el('div.col-inline-error', {}, el('p', {}, errorMessage(invites.error)), button(t('collections.retry'), { size: 'sm', onclick: () => void loadInvites() }));
    else if (!invites.items.length) body = el('p.col-hint', {}, t('collections.linksEmpty'));
    else body = el('ul.card.members-list', { 'aria-labelledby': linksId }, invites.items.map((item) => inviteRow(item, { me, members: space.members(), onRevoke: revoke })));
    keepFocus(linksBody, () => linksBody.replaceChildren(body));
  }
  async function loadInvites() {
    if (closed || !me.manage) return;
    if (navigator.onLine === false) { invites = { status: 'error', items: [], error: { code: 'network', status: 0 } }; renderLinks(); return; }
    invites = { ...invites, status: 'loading' }; renderLinks();
    try { invites = { status: 'ready', items: cleanInvites((await api.call(ref, 'invite.list'))?.invites) }; } catch (error) { invites = { status: 'error', items: [], error }; }
    if (!closed) renderLinks();
  }
  async function revoke(item) {
    const ok = await confirmDialog({ title: t('collections.revokeTitle'), body: t('collections.revokeBody'), confirmLabel: t('collections.revoke'), danger: true });
    if (!ok || closed) return;
    try { await api.call(ref, 'invite.revoke', { id: item.id }); toast(t('collections.revoked')); } catch (error) { if (error?.code !== 'not_found') toast(errorMessage(error)); }
    void loadInvites();
  }
  function invite() {
    openInviteDialog({ api, session, puter, uid, me, ref, tripTitle: name(), copy: INVITE_COPY, onCreated: () => void loadInvites() });
  }

  function renderPublic() {
    publicSection.hidden = !me.share;
    if (!me.share) return;
    const share = space.get('meta', 'meta')?.share ?? {};
    const on = share.on === true;
    const titleId = uniqueId('col-public');
    const toggle = switchField(t('collections.publicToggle'), { checked: on, onChange: (value) => void setPublic(value ? { on: true } : { on: false }) });
    const parts = [el('h3', { id: titleId }, t('collections.publicTitle')), el('p.col-hint', {}, t('collections.publicHint')), toggle];
    if (on && token) {
      const url = publicURL(location.href, ref, token);
      const input = el('input.input.col-public-url', { readOnly: true, value: url, 'aria-label': t('collections.publicLink'), onfocus: (event) => event.target.select() });
      parts.push(el('div.col-public-link', {}, input, button(t('collections.copy'), { size: 'sm', variant: 'primary', icon: 'copy', onclick: () => copyText(url, input) })),
        el('p.col-hint', {}, t('collections.publicOnce')));
    } else if (on) parts.push(el('p.col-hint', {}, t('collections.publicHidden')));
    if (on) parts.push(el('div.col-actions', {}, button(t('collections.publicRotate'), { size: 'sm', variant: 'outline', onclick: () => void setPublic({ rotate: true }) }),
      button(t('collections.publicRevoke'), { size: 'sm', variant: 'ghost', onclick: () => void setPublic({ revoke: true }) })));
    publicSection.setAttribute('aria-labelledby', titleId);
    keepFocus(publicSection, () => publicSection.replaceChildren(...parts));
  }
  async function setPublic(input) {
    try {
      const result = await api.call(ref, 'share.set', input);
      token = result?.token && TOKEN.test(result.token) ? result.token : input.revoke || input.on === false ? null : token;
      toast(t(input.revoke ? 'collections.publicRevoked' : input.on === false ? 'collections.publicOff' : 'collections.publicOn'));
      await space.sync?.().catch(() => {});
    } catch (error) { toast(errorText(error)); }
    if (!closed) renderPublic();
  }

  function renderLeave() {
    if (me.role === 'owner') { leaveSection.replaceChildren(el('p.col-hint', {}, t('collections.ownerNote'))); return; }
    const control = button(t('collections.leave'), { variant: 'danger', onclick: () => void leave(control) });
    control.prepend(icon('leave', 16));
    leaveSection.replaceChildren(el('p.col-hint', {}, t('collections.leaveHint')), control);
  }
  async function leave(control) {
    const ok = await confirmDialog({ title: t('collections.leaveTitle', { name: name() }), body: t('collections.leaveBody'), confirmLabel: t('collections.leave'), danger: true });
    if (!ok || closed) return;
    control.setAttribute('aria-busy', 'true');
    try { await leaveCollection(context, ref); } catch (error) { control.setAttribute('aria-busy', 'false'); toast(errorText(error)); return; }
    toast(t('collections.left', { name: name() }));
    dialog.close('left');
    onLeft?.();
  }

  function update() {
    const before = me;
    me = access();
    inviteButton.hidden = !me.manage;
    renderMembers(); renderPublic();
    if (before.role !== me.role || before.manage !== me.manage) { renderLeave(); if (me.manage) void loadInvites(); else renderLinks(); }
  }
  offs.push(space.subscribe('member', update), space.subscribe({ type: 'meta', id: 'meta' }, update), space.subscribe('presence', renderMembers));
  inviteButton.hidden = !me.manage;
  renderMembers(); renderLinks(); renderPublic(); renderLeave();
  void loadInvites();
  const dialog = openModal({ title: t('collections.sharingTitle', { name: name() }), content, wide: true,
    onClose: () => { closed = true; clearTimeout(deferred); for (const off of offs.splice(0)) off(); } });
  return dialog;
}
