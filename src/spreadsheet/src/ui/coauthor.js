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
import { colorFor, colorsFor, initials, roleLabel } from '../collab/protocol.js';
import { invitationLink, startSharing, stopSharing } from '../collab/session.js';
import { rangeName } from '../core/cell.js';

/** The people in the room, one entry per person (their most recently active session), never this one. */
export function peopleHere(client) {
  const byUser = new Map();
  for (const p of client.people.values()) {
    if (p.user === client.user?.uuid) continue;
    const prior = byUser.get(p.user);
    if (!prior || p.at > prior.at) byUser.set(p.user, p);
  }
  const colors = colorsFor([...byUser.keys()]);
  return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username)).map((p) => ({
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
  const root = el('div.collab-people', { role: 'group', 'aria-label': 'People editing this workbook' });
  const avatar = (p, extra = '') => el('button.collab-avatar', {
    type: 'button', className: `collab-avatar${extra}`, style: { '--peer': p.color },
    title: `${p.name}${placeOf(wb, p) ? ` · ${placeOf(wb, p)}` : ''}${p.editing ? ' · typing' : ''}. Click to go there`,
    'aria-label': `${p.name}, ${roleLabel(p.role).toLowerCase()}${placeOf(wb, p) ? `, at ${placeOf(wb, p)}` : ''}. Go to their location`,
    onclick: () => jump(p),
  }, initials(p.name));
  const list = (anchor) => {
    const people = peopleHere(client);
    openMenu({
      anchor, label: 'People here', minWidth: 260,
      items: [
        { header: people.length ? `Here now (${people.length + 1})` : 'Only you are here' },
        { label: `${client.user?.username ?? 'You'} (you)`, icon: 'user', disabled: true },
        ...people.map((p) => ({ label: `${p.name}${placeOf(wb, p) ? ` · ${placeOf(wb, p)}` : ''}`, icon: 'user', onSelect: () => jump(p) })),
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
        'aria-label': people.length ? `Everyone here: ${people.length + 1} people` : 'Only you are here',
        title: people.length ? `Everyone here (${people.length + 1})` : 'Only you are here',
        onclick: (e) => list(e.currentTarget),
      }, people.length > 4 ? el('span.collab-more', {}, `+${people.length - 4}`) : null),
    );
  }
  update();
  return { el: root, update };
}

/** What the save pill says for a shared workbook: [icon, label, title]. */
export function roomStatus(client) {
  const { state, pending, message } = client.status;
  const waiting = pending === 1 ? '1 change waiting' : `${pending} changes waiting`;
  if (state === 'offline') return ['cloudOff', pending ? `Offline · ${waiting}` : 'Offline', `${message || 'Offline'}. Your changes are kept on this device and sent when the connection returns`];
  if (state === 'error') return ['alert', 'Not connected', message || 'The shared workbook is not reachable'];
  if (state === 'syncing' || pending) return ['spinner', 'Syncing…', 'Sending your changes to everyone'];
  if (state === 'connecting') return ['spinner', 'Connecting…', 'Joining the shared workbook'];
  if (!client.canEdit) return ['eye', 'View only', 'You can view this shared workbook. Ask its owner for edit access'];
  return ['people', 'Live · Saved', 'Everyone sees your changes as you make them'];
}

/**
 * The Share dialog's part about editing together. Not shared yet: a button that starts it (`onStarted(link)`
 * then opens the shared workbook). Shared: invitation links, invitations by name, and who has access.
 */
export function coauthorSection({ doc, onStarted }) {
  const box = el('section.collab-share', { 'aria-labelledby': 'collab-share-h' });
  const heading = el('h3.share-h3#collab-share-h', {}, 'Edit together');
  const client = doc.collab;
  if (!client) {
    const progress = el('p.field-hint', { role: 'status' });
    const start = el('button.btn.btn-primary', {
      type: 'button',
      onclick: async () => {
        start.disabled = true;
        try {
          const room = await startSharing(doc, (text) => { progress.textContent = text; });
          progress.textContent = 'Opening the shared workbook…';
          onStarted?.(room);
        } catch (e) {
          console.error(e);
          progress.textContent = '';
          toast(e?.message || 'Could not start editing together', { icon: 'alert', duration: 5000 });
          start.disabled = false;
        }
      },
    }, el('span', { html: icon('people', 16) }), el('span', {}, 'Start editing together'));
    box.append(heading,
      el('p.collab-share-text', {}, 'Work on this spreadsheet at the same time as others: everyone sees each other\'s changes and selections as they happen. The file stays yours and is kept up to date.'),
      el('div.row', {}, start), progress);
    return box;
  }
  const owner = client.user?.uuid === client.owner;
  const roleSel = el('select.select.share-mode', { 'aria-label': 'What the link lets people do' },
    el('option', { value: 'editor' }, 'Can edit'), el('option', { value: 'viewer' }, 'Can view'));
  const copy = async (role) => {
    let url;
    try { url = await invitationLink(client, role); } catch (e) { toast(e?.message || 'Could not make an invitation', { icon: 'alert' }); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(role ? `Invitation copied: anyone signed in to Puter with it ${role === 'editor' ? 'can edit' : 'can view'} for 7 days` : 'Link copied: it opens this workbook for the people in it', { icon: 'link', duration: 3500 });
    } catch {
      await promptDialog({ title: 'Invitation link', label: 'Address (copy it from here)', value: url, confirmLabel: 'Done' });
    }
  };
  const members = el('div.version-list.share-list.collab-members', { role: 'list', 'aria-label': 'People in this shared workbook' });
  async function loadMembers() {
    let res;
    try { res = await client.request({ op: 'members' }); } catch (e) { members.replaceChildren(el('div.version-empty', {}, el('p', {}, e?.message || 'Could not read who has access'))); return; }
    const here = new Set([...client.people.values()].map((p) => p.user));
    members.replaceChildren(...res.members.map((m) => {
      const me = m.uuid === client.user?.uuid;
      const control = owner && m.role !== 'owner'
        ? el('select.select.share-mode', {
          'aria-label': `Access for ${m.username}`,
          onchange: async (e) => {
            const role = e.currentTarget.value;
            try { await client.request({ op: 'role', uuid: m.uuid, role }); toast(role === 'removed' ? `Removed ${m.username}` : `${m.username} ${role === 'editor' ? 'can now edit' : 'can now view'}`, { icon: 'check', duration: 2200 }); }
            catch (err) { toast(err?.message || 'Could not change the access', { icon: 'alert' }); }
            loadMembers();
          },
        }, ...[['editor', 'Can edit'], ['viewer', 'Can view'], ['removed', 'Remove']].map(([value, label]) => el('option', { value, selected: value === m.role }, label)))
        : el('span.share-level', {}, roleLabel(m.role));
      return el('div.version-row.share-row', { role: 'listitem' },
        el('span.share-avatar.collab-member-avatar', { 'aria-hidden': 'true', style: { '--peer': colorFor(m.uuid) } }, initials(m.username)),
        el('div.version-main', {},
          el('div.version-when', { dir: 'auto' }, `${m.username}${me ? ' (you)' : ''}`),
          el('div.version-meta', {}, me || here.has(m.uuid) ? 'Here now' : 'Not here')),
        control);
    }));
  }
  const inviteName = el('input.input', { type: 'text', placeholder: 'Puter username', 'aria-label': 'Puter username to invite', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const inviteRole = el('select.select.share-mode', { 'aria-label': 'Access for the invited person' }, el('option', { value: 'editor' }, 'Can edit'), el('option', { value: 'viewer' }, 'Can view'));
  const inviteForm = el('form.share-add', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = inviteName.value.trim();
      if (!name) { inviteName.focus(); return; }
      try {
        await client.request({ op: 'invite-user', username: name, role: inviteRole.value });
        inviteName.value = '';
        toast(`${name} can join with the workbook's link`, { icon: 'check', duration: 3000 });
        loadMembers();
      } catch (err) { toast(err?.message || 'Could not invite', { icon: 'alert' }); }
    },
  }, inviteName, inviteRole, el('button.btn.btn-primary', { type: 'submit' }, 'Invite'));
  const stop = el('button.btn.btn-danger', {
    type: 'button',
    onclick: async () => {
      if (!await confirmDialog({ title: 'Stop editing together?', message: 'Everyone else loses access to the live workbook. The file keeps every change made so far and is yours alone again.', confirmLabel: 'Stop editing together' })) return;
      try { await stopSharing(doc); toast('Editing together stopped', { icon: 'check' }); onStarted?.(null); }
      catch (e) { toast(e?.message || 'Could not stop editing together', { icon: 'alert' }); }
    },
  }, 'Stop editing together');
  box.append(heading,
    el('p.collab-share-text', {}, owner
      ? 'This spreadsheet is live: everyone in it sees changes as they happen. Send an invitation link, or invite people by their Puter username.'
      : 'This spreadsheet is live: everyone in it sees changes as they happen. Its owner decides who has access.'),
    owner ? el('div.row.collab-link-row', {}, roleSel, el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copy(roleSel.value) }, el('span', {}, 'Copy invitation link'))) : el('div.row.collab-link-row', {}, el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copy(null) }, el('span', {}, 'Copy link'))),
    owner && inviteForm,
    el('h3.share-h3', {}, 'In this workbook'),
    members,
    owner && el('div.row.collab-stop-row', {}, stop));
  loadMembers();
  return box;
}
