/**
 * Editing together, in the interface: the people in a shared workbook beside the Share button (their initials in
 * their colours; a click takes you to where they are), the list of everyone here, and the part of the Share
 * dialog that starts editing together, hands out invitation links and manages who may edit.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { confirmDialog, promptDialog } from './modal.js';
import { colorFor, colorsFor, initials } from '../collab/protocol.js';
import { invitationLink, startSharing, stopSharing } from '../collab/session.js';
import { unreachableMessage } from '../collab/api.js';
import { rangeName } from '../core/cell.js';
import { t, compareText } from '../i18n/index.js';

/** The people in the room, one entry per person (their most recently active session), never this one. */
export function peopleHere(client) {
  const byUser = new Map();
  for (const p of client.people.values()) {
    if (p.user === client.user?.uuid) continue;
    const prior = byUser.get(p.user);
    if (!prior || p.at > prior.at) byUser.set(p.user, p);
  }
  const colors = colorsFor([...byUser.keys()]);
  return [...byUser.values()].sort((a, b) => compareText(a.username, b.username)).map((p) => ({
    id: p.session, user: p.user, name: p.username, role: p.role, color: colors.get(p.user),
    sheet: p.state?.sheet ?? null, sel: p.state?.sel ?? null, active: p.state?.active ?? null, editing: !!p.state?.editing,
  }));
}

/** Where someone is, as "Sheet1!B4" (or "Sheet1"). */
export function placeOf(wb, person) {
  const sheet = person.sheet && wb.sheet(person.sheet);
  if (!sheet) return null;
  const target = person.sel || (person.active && { r1: person.active.r, c1: person.active.c, r2: person.active.r, c2: person.active.c });
  return target ? `${sheet.name}!${rangeName(target)}` : sheet.name;
}

/**
 * The people bar beside Share: up to four avatars (a click goes to that person), then a button listing everyone.
 * `jump(person)` shows where someone is.
 */
export function createPeopleBar({ client, wb, jump }) {
  const root = el('div.collab-people', { role: 'group', 'aria-label': t('coauthor.peopleEditing') });
  const avatar = (p, extra = '') => el('button.collab-avatar', {
    type: 'button', className: `collab-avatar${extra}`, style: { '--peer': p.color },
    title: t('coauthor.avatarTitle', { name: p.name, place: placeOf(wb, p) || '', where: placeOf(wb, p) ? 'at' : 'none', typing: p.editing ? 'yes' : 'no' }),
    'aria-label': t('coauthor.avatarLabel', { name: p.name, role: p.role, place: placeOf(wb, p) || '', where: placeOf(wb, p) ? 'at' : 'none' }),
    onclick: () => jump(p),
  }, initials(p.name));
  const list = (anchor) => {
    const people = peopleHere(client);
    openMenu({
      anchor, label: t('coauthor.peopleHere'), minWidth: 260,
      items: [
        { header: people.length ? t('coauthor.hereNowCount', { count: people.length + 1 }) : t('coauthor.onlyYou') },
        { label: client.user?.username != null ? t('coauthor.nameYou', { name: client.user.username }) : t('coauthor.youYou'), icon: 'user', disabled: true },
        ...people.map((p) => ({ label: placeOf(wb, p) ? t('coauthor.nameAtPlace', { name: p.name, place: placeOf(wb, p) }) : p.name, icon: 'user', onSelect: () => jump(p) })),
      ],
    });
  };
  function update() {
    const people = peopleHere(client);
    root.hidden = false;
    const shown = people.slice(0, 4);
    root.replaceChildren(
      ...shown.map((p) => avatar(p)),
      el('button.collab-list-btn', {
        type: 'button', html: icon('people', 16), 'aria-haspopup': 'menu',
        'aria-label': people.length ? t('coauthor.everyoneHereLabel', { count: people.length + 1 }) : t('coauthor.onlyYou'),
        title: people.length ? t('coauthor.everyoneHereTitle', { count: people.length + 1 }) : t('coauthor.onlyYou'),
        onclick: (e) => list(e.currentTarget),
      }, people.length > 4 ? el('span.collab-more', {}, `+${people.length - 4}`) : null,
      // A phone has no room for the faces beside the document's name: the button says how many are here instead.
      people.length ? el('span.collab-count', { 'aria-hidden': 'true' }, String(people.length + 1)) : null),
    );
  }
  update();
  return { el: root, update };
}

/** What the save pill says for a shared workbook: [icon, label, title]. */
export function roomStatus(client) {
  const { state, pending, message } = client.status;
  // The connection's own explanation says the changes are kept already; any other reason is told it in full.
  if (state === 'offline') return ['cloudOff', pending ? t('coauthor.status.offlineWaiting', { count: pending }) : t('coauthor.status.offline'), message === unreachableMessage() ? message : t('coauthor.status.offlineKept', { reason: (message || t('coauthor.status.offline')).replace(/[.。]$/, '') })];
  if (state === 'error') return ['alert', t('coauthor.status.notConnected'), message || t('coauthor.status.unreachable')];
  if (state === 'syncing' || pending) return ['spinner', t('coauthor.status.syncing'), t('coauthor.status.syncingTitle')];
  if (state === 'connecting') return ['spinner', t('coauthor.status.connecting'), t('coauthor.status.connectingTitle')];
  if (!client.canEdit) return ['eye', t('coauthor.status.viewOnly'), client.full ? t('coauthor.status.viewOnlyFull') : t('coauthor.status.viewOnlyTitle')];
  return ['people', t('coauthor.status.live'), client.full ? t('coauthor.status.liveFull') : t('coauthor.status.liveTitle')];
}

/**
 * The Share dialog's part about editing together. Not shared yet: a button that starts it (`onStarted(link)`
 * then opens the shared workbook). Shared: invitation links, invitations by name, and who has access.
 */
export function coauthorSection({ doc, onStarted }) {
  const box = el('section.collab-share', { 'aria-labelledby': 'collab-share-h' });
  const heading = el('h3.share-h3#collab-share-h', {}, t('coauthor.share.heading'));
  const client = doc.collab;
  if (!client) {
    const progress = el('p.field-hint', { role: 'status' });
    const start = el('button.btn.btn-primary', {
      type: 'button',
      onclick: async () => {
        start.disabled = true;
        try {
          const room = await startSharing(doc, (text) => { progress.textContent = text; });
          progress.textContent = t('coauthor.share.opening');
          onStarted?.(room);
        } catch (e) {
          console.error(e);
          progress.textContent = '';
          toast(e?.message || t('coauthor.share.couldNotStart'), { icon: 'alert', duration: 5000 });
          start.disabled = false;
        }
      },
    }, el('span', { html: icon('people', 16) }), el('span', {}, t('coauthor.share.start')));
    box.append(heading,
      el('p.collab-share-text', {}, t('coauthor.share.intro')),
      el('div.row', {}, start), progress);
    return box;
  }
  const owner = client.user?.uuid === client.owner;
  const roleSel = el('select.select.share-mode', { 'aria-label': t('coauthor.share.linkRole') },
    el('option', { value: 'editor' }, t('coauthor.share.canEdit')), el('option', { value: 'viewer' }, t('coauthor.share.canView')));
  const copy = async (role) => {
    let url;
    try { url = await invitationLink(client, role); } catch (e) { toast(e?.message || t('coauthor.share.couldNotInvite'), { icon: 'alert' }); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(role ? t('coauthor.share.invitationCopied', { role: role === 'editor' ? 'editor' : 'viewer' }) : t('coauthor.share.linkCopied'), { icon: 'link', duration: 3500 });
    } catch {
      await promptDialog({ title: t('coauthor.share.invitationLink'), label: t('coauthor.share.address'), value: url, confirmLabel: t('common.done') });
    }
  };
  const members = el('div.version-list.share-list.collab-members', { role: 'list', 'aria-label': t('coauthor.share.members') });
  async function loadMembers() {
    let res;
    try { res = await client.request({ op: 'members' }); } catch (e) { members.replaceChildren(el('div.version-empty', {}, el('p', {}, e?.message || t('coauthor.share.couldNotReadMembers')))); return; }
    const here = new Set([...client.people.values()].map((p) => p.user));
    members.replaceChildren(...res.members.map((m) => {
      const me = m.uuid === client.user?.uuid;
      const control = owner && m.role !== 'owner'
        ? el('select.select.share-mode', {
          'aria-label': t('coauthor.share.accessFor', { name: m.username }),
          onchange: async (e) => {
            const role = e.currentTarget.value;
            try { await client.request({ op: 'role', uuid: m.uuid, role }); toast(role === 'removed' ? t('coauthor.share.removed', { name: m.username }) : t('coauthor.share.roleChanged', { name: m.username, role: role === 'editor' ? 'editor' : 'viewer' }), { icon: 'check', duration: 2200 }); }
            catch (err) { toast(err?.message || t('coauthor.share.couldNotChange'), { icon: 'alert' }); }
            loadMembers();
          },
        }, ...[['editor', t('coauthor.share.canEdit')], ['viewer', t('coauthor.share.canView')], ['removed', t('common.remove')]].map(([value, label]) => el('option', { value, selected: value === m.role }, label)))
        : el('span.share-level', {}, t('coauthor.share.roleName', { role: m.role }));
      return el('div.version-row.share-row', { role: 'listitem' },
        el('span.share-avatar.collab-member-avatar', { 'aria-hidden': 'true', style: { '--peer': colorFor(m.uuid) } }, initials(m.username)),
        el('div.version-main', {},
          el('div.version-when', { dir: 'auto' }, me ? t('coauthor.nameYou', { name: m.username }) : m.username),
          el('div.version-meta', {}, me || here.has(m.uuid) ? t('coauthor.share.hereNow') : t('coauthor.share.notHere'))),
        control);
    }));
  }
  const inviteName = el('input.input', { type: 'text', placeholder: t('coauthor.share.usernamePlaceholder'), 'aria-label': t('coauthor.share.usernameLabel'), autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const inviteRole = el('select.select.share-mode', { 'aria-label': t('coauthor.share.inviteRole') }, el('option', { value: 'editor' }, t('coauthor.share.canEdit')), el('option', { value: 'viewer' }, t('coauthor.share.canView')));
  const inviteForm = el('form.share-add', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = inviteName.value.trim();
      if (!name) { inviteName.focus(); return; }
      try {
        await client.request({ op: 'invite-user', username: name, role: inviteRole.value });
        client.allowLiveUpdates().catch(() => {});
        inviteName.value = '';
        toast(t('coauthor.share.invited', { name }), { icon: 'check', duration: 3000 });
        loadMembers();
      } catch (err) { toast(err?.message || t('coauthor.share.couldNotInviteUser'), { icon: 'alert' }); }
    },
  }, inviteName, inviteRole, el('button.btn.btn-primary', { type: 'submit' }, t('coauthor.share.invite')));
  const stop = el('button.btn.btn-danger', {
    type: 'button',
    onclick: async () => {
      if (!await confirmDialog({ title: t('coauthor.share.stopTitle'), message: t('coauthor.share.stopMessage'), confirmLabel: t('coauthor.share.stop') })) return;
      try { await stopSharing(doc); toast(t('coauthor.share.stopped'), { icon: 'check' }); onStarted?.(null); }
      catch (e) { toast(e?.message ? t('coauthor.share.couldNotStopReason', { reason: e.message.replace(/[.。]$/, '') }) : t('coauthor.share.couldNotStop'), { icon: 'alert', duration: 6000 }); }
    },
  }, t('coauthor.share.stop'));
  box.append(...[heading,
    el('p.collab-share-text', {}, owner
      ? t('coauthor.share.liveOwner')
      : t('coauthor.share.liveMember')),
    owner ? el('div.row.collab-link-row', {}, roleSel, el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copy(roleSel.value) }, el('span', {}, t('coauthor.share.copyInvitation')))) : el('div.row.collab-link-row', {}, el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copy(null) }, el('span', {}, t('coauthor.share.copyLink')))),
    owner && inviteForm,
    el('h3.share-h3', {}, t('coauthor.share.inThisWorkbook')),
    members,
    owner && el('div.row.collab-stop-row', {}, stop)].filter(Boolean));
  loadMembers();
  return box;
}
