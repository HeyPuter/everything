import './members.css';
import { el, uid as uniqueId } from '../../../ui/dom.js';
import { button, emptyState, iconButton, spinner } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { icon } from './icons.js';
import { access, canManage, grantable, sortMembers } from './logic.js';
import { errorMessage } from './errors.js';
import { nameList, personAvatar, roleLabel, viewLabel } from './people.js';
import { cleanInvites, inviteRow, openInviteDialog } from './invites.js';
import { guestSection } from './guests.js';
import { permsSection } from './perms.js';
import { keepFocus, menuOpen } from './focus.js';
import { shareSection } from './share/index.js';
import { transferSection } from '../transfer/index.js';

const count = (value) => new Intl.NumberFormat().format(value);

/** Members tab: people, presence, invite links, guests, the permission matrix and leaving. */
export async function mount(container, context) {
  if (!context.space || !context.session?.api || !context.account?.uuid) {
    container.replaceChildren(emptyState({ title: t('members.title'), body: t('members.unavailable'), icon: 'users' }));
    return undefined;
  }
  return membersView(container, context).destroy;
}

export function membersView(container, { space, session, account, app, puter, personal, ref = space.ref, window: win = globalThis.window }) {
  const uid = account.uuid;
  const api = session.api;
  const spaces = (session.personal ?? personal)?.spaces;
  const offs = [];
  const busy = new Set();
  let me = access(space, uid);
  let invites = { status: 'idle', items: [], error: null };
  let loadSeq = 0;
  let deferred = 0;
  let destroyed = false;

  const tripTitle = () => space.get('meta', 'meta')?.title || t('members.thisTrip');
  const members = () => sortMembers(space.members().filter((member) => member.role), uid);

  const titleId = uniqueId('members-title');
  const countNode = el('span.members-count');
  const inviteButton = button(t('members.invite'), { variant: 'primary', onclick: () => invite() });
  inviteButton.prepend(icon('invite'));
  const here = el('div.members-here');
  const list = el('ul.card.members-list', { 'aria-labelledby': titleId });
  const linksId = uniqueId('members-links');
  const linksBody = el('div.members-links-body');
  const refresh = iconButton('refresh', t('members.refresh'), { onclick: () => void loadInvites() });
  refresh.replaceChildren(icon('refresh'));
  const links = el('section.members-section', { 'aria-labelledby': linksId },
    el('div.members-section-head', {}, el('h3', { id: linksId }, t('members.links')), refresh),
    el('p.members-hint', {}, t('members.linksHint')), linksBody);
  const guests = guestSection({ space, me: () => me });
  const perms = permsSection({ space, me: () => me });
  const share = shareSection({ space, session, account, ref, window: win });
  const leaveSection = el('section.members-section.members-leave');
  const transfer = transferSection({ space, session, account, app, puter, personal, ref });
  container.replaceChildren(el('div.members-view', {},
    el('div.members-head', {}, el('div.members-heading', {}, el('h2', { id: titleId }, t('members.title')), countNode), inviteButton),
    here, list, links, share.element, guests.element, perms.element, transfer.element, leaveSection));

  function memberRow(member) {
    const view = member.active ? viewLabel(member.view) : '';
    const status = member.active ? (view ? t('members.activeOn', { view }) : t('members.activeNow')) : '';
    const manageable = canManage(me, member);
    return el('li.list-row.member-row', { dataset: { key: member.uid } },
      personAvatar(member, { puter, presence: true }),
      el('div.member-text', {},
        el('span.member-name', {}, member.name, member.uid === uid && el('span.chip.chip-accent.member-you', {}, t('members.you'))),
        status && el('span.member-sub', {}, status)),
      el('span.chip.member-role', { dataset: { role: member.role } }, member.role === 'owner' && icon('crown', 14), roleLabel(member.role)),
      manageable && iconButton('more', t('members.actionsFor', { name: member.name }), {
        dataset: { focus: `member:${member.uid}` }, disabled: busy.has(member.uid), onclick: (event) => memberMenu(event.currentTarget, member),
      }));
  }
  function renderMembers() {
    if (destroyed) return;
    // A re-render would detach an open menu's anchor; try again shortly.
    if (menuOpen(list)) { clearTimeout(deferred); deferred = setTimeout(renderMembers, 1000); return; }
    const all = members();
    countNode.textContent = all.length === 1 ? t('members.countOne') : t('members.count', { count: count(all.length) });
    keepFocus(list, () => list.replaceChildren(...all.map(memberRow)));
    const others = all.filter((member) => member.active && member.uid !== uid);
    here.hidden = !others.length;
    here.replaceChildren(
      el('span.members-here-label', {}, t('members.hereNow')),
      el('div.avatar-stack', { 'aria-hidden': 'true' }, others.slice(0, 5).map((member) => personAvatar(member, { puter, size: 26 }))),
      el('span.members-here-names', {}, nameList(others.map((member) => member.name))));
  }
  function memberMenu(anchor, member) {
    openMenu(anchor, [
      ...grantable(me.role).map((role) => ({ label: t('members.makeRole', { role: roleLabel(role) }), checked: member.role === role,
        onSelect: () => { if (member.role !== role) void act(member, 'member.role', { uuid: member.uid, role }, () => t('members.roleChanged', { name: member.name, role: roleLabel(role) })); } })),
      { separator: true },
      { label: t('members.remove'), icon: 'trash', danger: true, onSelect: () => void removeMember(member) },
    ]);
  }
  async function act(member, op, input, success) {
    busy.add(member.uid); renderMembers();
    try {
      await api.call(ref, op, input);
      toast(success());
    } catch (error) {
      toast(errorMessage(error, { context: 'member' }));
    } finally {
      busy.delete(member.uid);
      if (!destroyed) { renderMembers(); void space.sync().catch(() => {}); }
    }
  }
  async function removeMember(member) {
    const ok = await confirmDialog({ title: t('members.removeTitle', { name: member.name }), body: t('members.removeBody', { name: member.name }),
      confirmLabel: t('members.remove'), danger: true });
    if (ok && !destroyed) await act(member, 'member.remove', { uuid: member.uid }, () => t('members.removed', { name: member.name }));
  }

  function renderLinks() {
    links.hidden = !me.manage;
    if (!me.manage) return;
    refresh.disabled = invites.status === 'loading';
    let body;
    if (invites.status === 'loading' || invites.status === 'idle') body = el('p.members-loading', {}, spinner(), t('members.linksLoading'));
    else if (invites.status === 'offline') body = el('p.members-empty', {}, t('members.linksOffline'));
    else if (invites.status === 'error') {
      body = el('div.members-error', {}, el('p', {}, t('members.linksError', { reason: errorMessage(invites.error) })),
        button(t('members.retry'), { size: 'sm', onclick: () => void loadInvites() }));
    } else if (!invites.items.length) body = el('p.members-empty', {}, t('members.linksEmpty'));
    else {
      const people = space.members();
      body = el('ul.card.members-list', { 'aria-labelledby': linksId }, invites.items.map((item) => inviteRow(item, { me, members: people, onRevoke: revoke })));
    }
    keepFocus(linksBody, () => linksBody.replaceChildren(body));
  }
  async function loadInvites() {
    if (destroyed || !me.manage) return;
    const seq = ++loadSeq;
    if (win?.navigator?.onLine === false) { invites = { status: 'offline', items: [], error: null }; renderLinks(); return; }
    invites = { ...invites, status: 'loading' };
    renderLinks();
    try {
      const result = await api.call(ref, 'invite.list');
      if (destroyed || seq !== loadSeq) return;
      invites = { status: 'ready', items: cleanInvites(result?.invites), error: null };
    } catch (error) {
      if (destroyed || seq !== loadSeq) return;
      invites = { status: 'error', items: [], error };
    }
    renderLinks();
  }
  async function revoke(invite) {
    const ok = await confirmDialog({ title: t('members.revokeTitle'), body: t('members.revokeBody'), confirmLabel: t('members.revoke'), danger: true });
    if (!ok || destroyed) return;
    try {
      await api.call(ref, 'invite.revoke', { id: invite.id });
      toast(t('members.revoked'));
    } catch (error) {
      if (error?.code !== 'not_found') toast(errorMessage(error));
    }
    void loadInvites();
  }
  function invite() {
    if (!me.manage) return;
    openInviteDialog({ api, session, puter, uid, me, ref, tripTitle: tripTitle(), onCreated: () => void loadInvites() });
  }

  function renderLeave() {
    if (me.role === 'owner') {
      leaveSection.replaceChildren(el('p.members-hint', {}, t('members.ownerNote')));
      return;
    }
    const leaveId = uniqueId('members-leave');
    const leaveButton = button(t('members.leave'), { variant: 'danger', onclick: () => void leave(leaveButton) });
    leaveButton.prepend(icon('leave'));
    leaveSection.setAttribute('aria-labelledby', leaveId);
    leaveSection.replaceChildren(el('h3', { id: leaveId }, t('members.leave')), el('p.members-hint', {}, t('members.leaveHint')), el('div', {}, leaveButton));
  }
  async function leave(control) {
    const title = tripTitle();
    const ok = await confirmDialog({ title: t('members.leaveTitle', { title }), body: t('members.leaveBody'), confirmLabel: t('members.leave'), danger: true });
    if (!ok || destroyed) return;
    control.setAttribute('aria-busy', 'true');
    try {
      await api.call(ref, 'leave');
    } catch (error) {
      // Already removed: finish leaving locally.
      if (error?.code !== 'not_member') { control.setAttribute('aria-busy', 'false'); toast(errorMessage(error)); return; }
    }
    try { await spaces?.remove(ref); } catch { /* the index is a cache; the next heads check drops it */ }
    toast(t('members.left', { title }));
    app?.navigate('#/');
  }

  function update() {
    const before = me;
    me = access(space, uid);
    inviteButton.hidden = !me.manage;
    renderMembers();
    guests.update();
    perms.update();
    share.update();
    if (before.manage !== me.manage || before.role !== me.role) {
      renderLeave();
      if (me.manage) void loadInvites(); else renderLinks();
    }
  }
  const online = () => { if (['offline', 'error'].includes(invites.status)) void loadInvites(); };
  win?.addEventListener('online', online);
  offs.push(space.subscribe('member', update), space.subscribe({ type: 'meta', id: 'meta' }, update), space.subscribe('presence', renderMembers),
    () => win?.removeEventListener('online', online));

  inviteButton.hidden = !me.manage;
  renderMembers();
  renderLeave();
  renderLinks();
  void loadInvites();

  return {
    update,
    reloadInvites: loadInvites,
    destroy() {
      destroyed = true;
      clearTimeout(deferred);
      for (const off of offs.splice(0)) off();
      guests.destroy();
      share.destroy();
      transfer.destroy();
    },
  };
}
