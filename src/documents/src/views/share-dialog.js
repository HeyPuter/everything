/**
 * The Share dialog: invite people by Puter username or email address with a
 * role (can edit, can comment, can view), copy a link that admits whoever
 * opens it with a chosen role, see and change who has access, send a copy of
 * the document by email (Word or PDF), and stop sharing.
 *
 * Sharing starts with the first invitation or link: until then nothing leaves
 * this device. `api` is the editor's collaboration controller (collab.js).
 */
import { el } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { EMAIL } from '../lib/mail-send.js';
import { roleLabel, INVITE_ROLES, initials } from '../collab/protocol.js';

const ROLE_HINTS = { editor: 'Can change the text and formatting', commenter: 'Can read and add comments', viewer: 'Can read only' };

const roleSelect = (value, label, onchange, { owner = false, remove = false } = {}) => {
  const select = el('select.input.sh-role', { 'aria-label': label, onchange: () => onchange(select.value) },
    ...(owner ? [el('option', { value: 'owner' }, 'Owner')] : []),
    ...INVITE_ROLES.map(role => el('option', { value: role, title: ROLE_HINTS[role] }, roleLabel(role))),
    ...(remove ? [el('option', { value: 'removed' }, 'Remove access')] : []));
  select.value = value;
  return select;
};

export function openShareDialog(api) {
  const live = () => api.live();
  const status = el('p.sh-status', { role: 'status', 'aria-live': 'polite' });
  const say = (text, error = false) => { status.textContent = text || ''; status.classList.toggle('is-error', !!error); };
  const busy = async (button, label, fn) => {
    const text = button.textContent;
    button.disabled = true; button.textContent = label;
    try { return await fn(); }
    catch (e) { say(e?.message || String(e), true); return null; }
    finally { button.disabled = false; button.textContent = text; }
  };

  /* ---- Invite ---- */
  const people = el('input.input', { type: 'text', placeholder: api.local ? 'Not available for local sharing' : 'Puter usernames or email addresses', 'aria-label': 'People to invite', autocomplete: 'off', disabled: api.local,
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); invite.click(); } } });
  let inviteRole = 'editor';
  const inviteRoleSelect = roleSelect(inviteRole, 'Role for the people you invite', v => { inviteRole = v; });
  const note = el('textarea.input.sh-note', { rows: 1, placeholder: 'Add a message (optional)', 'aria-label': 'Message for the people you invite', disabled: api.local });
  const invite = el('button.btn.btn-primary', { type: 'button', disabled: api.local, onclick: () => busy(invite, 'Inviting…', async () => {
    const names = people.value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!names.length) { say('Enter at least one Puter username or email address.', true); people.focus(); return; }
    const bad = names.filter(n => !EMAIL.test(n) && !/^@?[A-Za-z0-9._-]{1,64}$/.test(n));
    if (bad.length) { say(`“${bad[0]}” is neither a Puter username nor an email address.`, true); return; }
    await api.ensureShared(text => say(text));
    const emailed = [], invited = [], failed = [];
    for (const name of names) {
      if (EMAIL.test(name)) {
        const result = await api.emailInvitation(name, inviteRole, note.value.trim());
        (result.ok ? emailed : failed).push(result.ok ? name : `${name}: ${result.message}`);
      } else {
        await live().inviteUser(name.replace(/^@/, ''), inviteRole);
        invited.push(name.replace(/^@/, ''));
      }
    }
    people.value = ''; note.value = '';
    const parts = [];
    if (invited.length) parts.push(`${invited.join(', ')} can open the document from its link once signed in to Puter.`);
    if (emailed.length) parts.push(`Invitation sent to ${emailed.join(', ')}.`);
    if (failed.length) parts.push(`Not sent: ${failed.join('; ')}`);
    say(parts.join(' '), !!failed.length);
    if (invited.length) await copyInviteLink(inviteRole, { quiet: true });
    renderAccess();
  }) }, 'Invite');
  const inviteSection = el('section.sh-section', {},
    el('h3.sh-heading', {}, 'Invite people'),
    el('div.sh-row', {}, people, inviteRoleSelect),
    note,
    el('div.sh-row.sh-row-end', {}, el('span.field-hint', {}, api.local ? 'This document is on this device: share it with other tabs of this browser using the link below.' : 'People sign in to Puter to open it. Invitations expire after seven days.'), invite));

  /* ---- Link ---- */
  let linkRole = 'editor';
  const linkRoleSelect = roleSelect(linkRole, 'What people with the link can do', v => { linkRole = v; });
  const copy = el('button.btn.btn-outline', { type: 'button', onclick: () => copyInviteLink(linkRole) }, 'Copy Link');
  async function copyInviteLink(role, { quiet = false } = {}) {
    return busy(copy, 'Preparing…', async () => {
      await api.ensureShared(text => say(text));
      const url = await live().inviteLink(role);
      linkField.value = url; linkField.hidden = false;
      try { await navigator.clipboard.writeText(url); if (!quiet) say(`Link copied. Anyone who opens it ${role === 'editor' ? 'can edit' : role === 'commenter' ? 'can comment' : 'can view'}${api.local ? ' (in this browser)' : ' once signed in to Puter'}.`); }
      catch { if (!quiet) say('Copy the link below.'); linkField.select(); }
      renderAccess();
      return url;
    });
  }
  const linkField = el('input.input.sh-link', { readOnly: true, hidden: true, 'aria-label': 'Invitation link', onfocus: e => e.target.select() });
  const revoke = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => busy(revoke, 'Turning off…', async () => { await live()?.revokeLinks(); linkField.hidden = true; say('Earlier links and invitations no longer admit anyone new. People who joined keep their access.'); }) }, 'Turn Off Earlier Links');
  const linkSection = el('section.sh-section', {},
    el('h3.sh-heading', {}, 'Share a link'),
    el('div.sh-row', {}, el('span.sh-link-label', {}, 'People with the link'), linkRoleSelect, copy),
    linkField,
    el('div.sh-row', {}, revoke));

  /* ---- Access ---- */
  const access = el('div.sh-access', { role: 'list', 'aria-label': 'People with access' });
  // Each change reloads the list; when reloads overlap, only the latest one's answer is shown.
  let accessRequest = 0;
  async function renderAccess() {
    const request = ++accessRequest;
    const session = live();
    revoke.hidden = !session || session.local;
    stop.hidden = !session || !session.canManage;
    if (!session) { access.replaceChildren(el('p.sh-muted', {}, 'Only you. Invite people or copy a link to start editing together.')); return; }
    access.replaceChildren(el('p.sh-muted', {}, 'Loading…'));
    let data;
    try { data = await session.members(); } catch (e) { if (request === accessRequest) access.replaceChildren(el('p.sh-muted', {}, e.message)); return; }
    if (request !== accessRequest) return;
    const here = new Set(session.people().map(p => p.name));
    const rows = data.members.map(m => el('div.sh-person', { role: 'listitem' },
      el('span.sh-avatar', { 'aria-hidden': 'true' }, initials(m.username)),
      el('span.sh-name', {}, m.username, here.has(m.username) ? el('span.sh-here', {}, ' · here now') : null),
      m.role === 'owner' || !session.canManage || session.local ? el('span.sh-role-text', {}, roleLabel(m.role))
        : roleSelect(m.role, `Access for ${m.username}`, async role => {
          if (role === 'removed' && !await confirmDialog({ title: 'Remove access?', message: `${m.username} will no longer be able to open this document.`, confirmLabel: 'Remove' })) { renderAccess(); return; }
          try { await session.setRole(m.uuid, role); say(role === 'removed' ? `${m.username} no longer has access.` : `${m.username} ${roleLabel(role).toLowerCase()} now.`); } catch (e) { say(e.message, true); }
          renderAccess();
        }, { remove: true })));
    for (const n of data.named || []) if (!data.members.some(m => m.username.toLowerCase() === n.username.toLowerCase())) rows.push(el('div.sh-person.is-pending', { role: 'listitem' },
      el('span.sh-avatar', { 'aria-hidden': 'true' }, initials(n.username)), el('span.sh-name', {}, n.username, el('span.sh-here', {}, ' · invited')), el('span.sh-role-text', {}, roleLabel(n.role))));
    access.replaceChildren(...rows);
  }
  const accessSection = el('section.sh-section', {}, el('h3.sh-heading', {}, 'People with access'), access);

  /* ---- Send a copy ---- */
  const to = el('input.input', { type: 'email', placeholder: 'Email address', 'aria-label': 'Send a copy to', autocomplete: 'email' });
  const format = el('select.input.sh-role', { 'aria-label': 'Format of the copy' }, el('option', { value: 'docx' }, 'Word document (.docx)'), el('option', { value: 'pdf' }, 'PDF'));
  const send = el('button.btn.btn-outline', { type: 'button', onclick: () => busy(send, 'Sending…', async () => {
    const address = to.value.trim();
    if (!EMAIL.test(address)) { say('Enter the email address to send the copy to.', true); to.focus(); return; }
    const result = await api.sendCopy(address, format.value, note.value.trim());
    if (result.ok) { say(`A copy was sent to ${address}.`); to.value = ''; } else say(result.message, true);
  }) }, 'Send Copy');
  const download = el('button.btn.btn-ghost', { type: 'button', onclick: () => api.downloadCopy(format.value) }, 'Download Instead');
  const copySection = el('details.sh-section.sh-copy', {},
    el('summary.sh-heading', {}, 'Send a copy by email'),
    el('div.sh-row', {}, to, format),
    el('div.sh-row.sh-row-end', {}, el('span.field-hint', {}, api.canEmail ? 'Sent from your Puter email address as an attachment. The copy does not change when the document does.' : 'Email is not available here; download the copy and attach it yourself.'), download, send));
  send.disabled = !api.canEmail; to.disabled = !api.canEmail;

  /* ---- Footer ---- */
  const stop = el('button.btn.btn-ghost.sh-stop', { type: 'button', onclick: async () => {
    if (!await confirmDialog({ title: 'Stop sharing?', message: 'Everyone else loses access and their open copies stop updating. The document stays yours.', confirmLabel: 'Stop Sharing' })) return;
    await busy(stop, 'Stopping…', async () => { await live()?.stop(); say('Sharing stopped.'); renderAccess(); });
  } }, 'Stop Sharing');
  const done = el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Done');
  const content = el('div.ed-dialog-body.sh-dialog', {}, inviteSection, linkSection, accessSection, copySection, status, el('div.modal-actions', {}, stop, done));
  const modal = openModal({ title: `Share “${api.documentName() || 'Untitled document'}”`, content, onClose: () => api.onClose?.() });
  renderAccess();
  queueMicrotask(() => (api.local ? copy : people).focus());
  return modal;
}

/** A short line for toasts about a role. */
export const roleSentence = role => ({ owner: 'You own this document.', editor: 'You can edit this document.', commenter: 'You can comment on this document.', viewer: 'You can view this document.' })[role] || '';
