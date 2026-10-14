/**
 * Share dialog: give other Puter users a spreadsheet to view or edit, by
 * username or email address, see who can reach it, change or withdraw their
 * access, and copy a link that opens it for them.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal, fieldAlert, focusListRow, promptDialog } from './modal.js';
import { toast } from './toast.js';
import * as P from '../lib/puter.js';
import { fileLink } from '../lib/links.js';
import { coauthorSection } from './coauthor.js';

export const SHARE_MODES = [['read', 'Can view'], ['write', 'Can edit']];
const modeLabel = (mode) => (mode === 'write' || mode === 'manage' ? 'Can edit' : 'Can view');
/** What a change of access says, as in "ana can now edit". */
const nowCan = (mode) => (mode === 'write' || mode === 'manage' ? 'can now edit' : 'can now view');

/** What a row says under the name: how the access came about, when that is not plain. */
function rowMeta(row) {
  if (row.who === 'anyone') return `Anyone signed in to Puter who has the link · ${modeLabel(row.mode).toLowerCase()}`;
  if (row.pending) return 'Invited · access starts when they join Puter with this address';
  if (row.inheritedFrom) return `Through the folder ${P.displayName(row.inheritedFrom)}`;
  if (row.mode === 'manage') return 'Can edit and share';
  return null;
}

/**
 * Open the dialog for the file at `path` (named `name`; `uid`, when known, spares a look-up for
 * the link). `onChange` runs after access was given or withdrawn; `onEmailLink`, when given, offers to
 * email a link to people (Send a link) in place of copying it.
 */
export function openShareDialog({ path, name, uid = null, onChange = null, doc = null, onLive = null, onEmailLink = null }) {
  const { alert, refuse, clear } = fieldAlert('share');
  const who = el('input.input', {
    type: 'text', placeholder: 'Username or email address', 'aria-label': 'Username or email address',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'send',
  });
  const mode = el('select.select.share-mode', { 'aria-label': 'Access' }, SHARE_MODES.map(([value, label]) => el('option', { value }, label)));
  const shareBtn = el('button.btn.btn-primary', { type: 'submit' }, 'Share');
  const list = el('div.version-list.share-list', { role: 'list', 'aria-label': 'People with access' });
  const linkBtn = el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copyLink() }, el('span', {}, 'Copy link'));
  let busy = false;
  let closed = false;
  let loadId = 0;

  function setBusy(value, { keepButtons = false } = {}) {
    busy = value;
    content.setAttribute('aria-busy', String(value));
    if (!keepButtons) for (const control of content.querySelectorAll('button, input, select')) control.disabled = value;
  }

  // The wait and its outcome are said aloud, as in the version history: a notice swapped in for the rows is not heard.
  const status = el('p.visually-hidden', { role: 'status' });
  const say = (text) => { if (status.textContent !== text) status.textContent = text; };

  /** A notice in place of the rows; `retry` offers to read the access again, for a failure that may pass. */
  function notice(text, { retry: offerRetry = false } = {}) {
    say(text);
    list.removeAttribute('role');
    list.replaceChildren(el('div.version-empty', {}, el('p', {}, text),
      offerRetry && el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: retry }, 'Try again')));
  }

  async function retry() {
    if (busy || closed) return;
    await refresh();
    if (closed || content.contains(document.activeElement)) return;
    (list.querySelector('.version-empty button') || list.querySelector('[data-action]') || who).focus();
  }

  async function refresh() {
    if (closed) return;
    const requestId = ++loadId;
    // Only a list with nothing in it yet says it is loading: read again after a change, the rows stay
    // in place until the new ones replace them, so the dialog neither jumps nor loses the focused control.
    if (!list.querySelector('.share-row')) notice('Loading…');
    let rows;
    try { rows = await P.shareAccess(path); }
    catch (e) {
      if (closed || requestId !== loadId) return;
      console.error(e);
      if (e?.code === 'subject_does_not_exist' || e?.code === 'forbidden') {
        // Not the user's to share (someone else's file, shared with them to view or edit): the form that
        // could only be refused goes, and the focus it had moves on. The link still opens it for whoever has access.
        const hadFocus = addForm.contains(document.activeElement);
        addForm.hidden = true;
        hint.hidden = true;
        clear();
        notice(e.message);
        if (hadFocus) doneBtn.focus();
      } else notice('Could not read who has access', { retry: true });
      return;
    }
    if (closed || requestId !== loadId) return;
    if (!rows.length) { notice('Only you can open this spreadsheet. Add someone above to share it.'); return; }
    say(`${rows.length} ${rows.length === 1 ? 'person or group has' : 'people or groups have'} access`);
    list.setAttribute('role', 'list');
    list.replaceChildren(...rows.map((row, idx) => {
      const meta = rowMeta(row);
      const person = row.who === 'user' || row.who === 'invite';
      // Only access given on this file, to a person or an invite, is the app's to change here: a link is
      // the owner's to open and close on Puter, and access from a folder above is changed on that folder.
      // An invite's level is fixed until it is taken up, and one who may share onward was made so on Puter.
      const own = !!row.recipient;
      const level = own && !row.pending && row.mode !== 'manage'
        ? el('select.select.share-mode', {
          'aria-label': `Access for ${row.label}`, dataset: { action: 'mode' },
          onchange: (e) => changeMode(row, e.currentTarget.value, idx),
        }, SHARE_MODES.map(([value, label]) => el('option', { value, selected: value === (row.mode === 'write' ? 'write' : 'read') }, label)))
        : row.who !== 'anyone' && el('span.share-level', {}, modeLabel(row.mode));
      return el('div.version-row.share-row', { role: 'listitem' },
        el('span.share-avatar', { 'aria-hidden': 'true', html: person ? null : icon(row.who === 'anyone' ? 'link' : 'users', 16) },
          person ? row.label.slice(0, 1).toUpperCase() : null),
        el('div.version-main', {},
          el('div.version-when', { dir: 'auto', title: row.label }, row.label),
          meta && el('div.version-meta', {}, meta)),
        level,
        own && el('button.icon-btn', {
          type: 'button', html: icon('x', 16), dataset: { action: 'remove' },
          'aria-label': row.pending ? `Cancel the invitation to ${row.label}` : `Remove ${row.label}`,
          title: row.pending ? 'Cancel the invitation' : 'Remove access',
          onclick: () => remove(row, idx),
        }));
    }));
    setBusy(busy);
  }

  async function add() {
    if (busy || closed) return;
    const recipient = who.value.trim();
    if (!recipient) { refuse(who, 'Enter a username or an email address'); return; }
    if (/\s/.test(recipient)) { refuse(who, 'A username or an email address has no spaces'); return; }
    clear();
    const from = document.activeElement;
    setBusy(true);
    try {
      const share = await P.shareFile(path, recipient, mode.value);
      if (closed) return;
      who.value = '';
      const named = share.pending ? (share.label || recipient) : (share.recipient || recipient);
      toast(share.pending ? `Invited ${named}` : share.isNew ? `Shared with ${named}` : `${named} ${nowCan(share.mode)}`, { icon: 'check', duration: 2500 });
      onChange?.();
      await refresh();
    } catch (e) {
      if (closed) return;
      console.error(e);
      // The field is enabled again first: the refusal puts the focus on it.
      setBusy(false);
      refuse(who, e?.message || 'Could not share the spreadsheet');
      return;
    } finally {
      if (busy) setBusy(false);
    }
    if (!closed && !content.contains(document.activeElement)) (from?.isConnected ? from : who).focus();
  }

  async function changeMode(row, next, idx) {
    if (busy || closed) return;
    setBusy(true);
    try {
      await P.shareFile(path, row.recipient, next);
      if (closed) return;
      toast(`${row.label} ${nowCan(next)}`, { icon: 'check', duration: 2000 });
      onChange?.();
    } catch (e) {
      console.error(e);
      if (!closed) toast(e?.message || 'Could not change the access', { icon: 'alert', duration: 4000 });
    } finally {
      // The rows are read again either way: a refused change must not leave the list showing it.
      if (!closed) await refresh();
      setBusy(false);
      if (!closed && !content.contains(document.activeElement)) focusListRow(list, idx, 'mode', who);
    }
  }

  async function remove(row, idx) {
    if (busy || closed) return;
    setBusy(true);
    try {
      await P.unshareFile(path, row.recipient);
      if (closed) return;
      toast(row.pending ? `Invitation to ${row.label} cancelled` : `Removed ${row.label}`, { icon: 'check', duration: 2000 });
      onChange?.();
      await refresh();
    } catch (e) {
      console.error(e);
      if (!closed) toast(e?.message || 'Could not remove the access', { icon: 'alert', duration: 4000 });
    } finally {
      setBusy(false);
      // The row that took the removed one's place (or the same row, when the removal failed), else the name field.
      if (!closed && !content.contains(document.activeElement)) focusListRow(list, idx, 'remove', who);
    }
  }

  /**
   * Inside the Puter desktop the link is Puter's own, which opens the file in this app; on the web it
   * is this page's, naming the file by its id, since each person the file is shared with reaches it
   * at an address of their own. Either way it opens only for the people the file is shared with.
   */
  async function copyLink() {
    if (busy || closed) return;
    setBusy(true, { keepButtons: true });
    let url = null;
    try {
      url = await P.puterShareLink(path);
      if (!url) {
        const id = uid || (await P.statFile(path).catch(() => null))?.uid || null;
        if (id) url = fileLink(location, id);
      }
    } finally { setBusy(false); }
    if (closed) return;
    if (!url) { toast('Could not make a link to this spreadsheet', { icon: 'alert', duration: 3500 }); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. Only people with access can open it', { icon: 'link', duration: 3000 });
    } catch {
      await promptDialog({ title: 'Link to this spreadsheet', label: 'Address (copy it from here)', value: url, confirmLabel: 'Done' });
    }
  }

  const addForm = el('form.share-add', { onsubmit: (e) => { e.preventDefault(); add(); } }, who, mode, shareBtn);
  const hint = el('p.field-hint', {}, 'Share with a Puter username, or an email address: someone without an account is invited to join.');
  const doneBtn = el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Done');
  // Editing together (see coauthor.js) comes first: it is what most people sharing a spreadsheet want.
  const live = doc && coauthorSection({ doc, onStarted: (room) => { modal.close(); onLive?.(room); } });
  const content = el('div.share-dialog', {},
    live,
    live && el('h3.share-h3', {}, 'Share the file'),
    addForm,
    alert,
    hint,
    el('h3.share-h3', {}, 'People with access'),
    status,
    list,
    el('div.row.share-foot', {},
      linkBtn,
      onEmailLink && el('button.btn.btn-outline', { type: 'button', html: icon('sendLink', 16), onclick: () => { modal.close(); onEmailLink(); } }, el('span', {}, 'Email a link…')),
      el('div.grow'),
      doneBtn));
  const modal = openModal({ title: `Share "${name}"`, content, initialFocus: who, onClose: () => { closed = true; } });
  modal.panel.classList.add('share-panel');
  refresh();
  return modal;
}
