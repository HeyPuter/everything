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
import { t } from '../i18n/index.js';

/** [mode, label] for each level of access; the label is read when drawn, in the interface language. */
export const SHARE_MODES = [
  Object.defineProperty(['read'], 1, { enumerable: true, get: () => t('share.canView') }),
  Object.defineProperty(['write'], 1, { enumerable: true, get: () => t('share.canEdit') }),
];
const canEdit = (mode) => mode === 'write' || mode === 'manage';
const modeLabel = (mode) => (canEdit(mode) ? t('share.canEdit') : t('share.canView'));
/** The `mode` a message's select reads: edit or view. */
const accessLevel = (mode) => (canEdit(mode) ? 'edit' : 'view');

/** What a row says under the name: how the access came about, when that is not plain. */
function rowMeta(row) {
  if (row.who === 'anyone') return t('share.metaAnyone', { mode: accessLevel(row.mode) });
  if (row.pending) return t('share.metaInvited');
  if (row.inheritedFrom) return t('share.metaThroughFolder', { folder: P.displayName(row.inheritedFrom) });
  if (row.mode === 'manage') return t('share.metaCanShare');
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
    type: 'text', placeholder: t('share.whoPlaceholder'), 'aria-label': t('share.whoPlaceholder'),
    autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'send',
  });
  const mode = el('select.select.share-mode', { 'aria-label': t('share.access') }, SHARE_MODES.map(([value, label]) => el('option', { value }, label)));
  const shareBtn = el('button.btn.btn-primary', { type: 'submit' }, t('share.share'));
  const list = el('div.version-list.share-list', { role: 'list', 'aria-label': t('share.peopleWithAccess') });
  const linkBtn = el('button.btn.btn-outline', { type: 'button', html: icon('link', 16), onclick: () => copyLink() }, el('span', {}, t('share.copyLink')));
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
      offerRetry && el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: retry }, t('common.tryAgain'))));
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
    if (!list.querySelector('.share-row')) notice(t('common.loading'));
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
      } else notice(t('share.readFailed'), { retry: true });
      return;
    }
    if (closed || requestId !== loadId) return;
    if (!rows.length) { notice(t('share.onlyYou')); return; }
    say(t('share.accessCount', { count: rows.length }));
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
          'aria-label': t('share.accessFor', { name: row.label }), dataset: { action: 'mode' },
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
          'aria-label': row.pending ? t('share.cancelInvitationTo', { name: row.label }) : t('share.removeName', { name: row.label }),
          title: row.pending ? t('share.cancelInvitation') : t('share.removeAccess'),
          onclick: () => remove(row, idx),
        }));
    }));
    setBusy(busy);
  }

  async function add() {
    if (busy || closed) return;
    const recipient = who.value.trim();
    if (!recipient) { refuse(who, t('share.enterRecipient')); return; }
    if (/\s/.test(recipient)) { refuse(who, t('share.noSpaces')); return; }
    clear();
    const from = document.activeElement;
    setBusy(true);
    try {
      const share = await P.shareFile(path, recipient, mode.value);
      if (closed) return;
      who.value = '';
      const named = share.pending ? (share.label || recipient) : (share.recipient || recipient);
      toast(share.pending ? t('share.invited', { name: named }) : share.isNew ? t('share.sharedWith', { name: named }) : t('share.nowCan', { name: named, mode: accessLevel(share.mode) }), { icon: 'check', duration: 2500 });
      onChange?.();
      await refresh();
    } catch (e) {
      if (closed) return;
      console.error(e);
      // The field is enabled again first: the refusal puts the focus on it.
      setBusy(false);
      refuse(who, e?.message || t('share.shareFailed'));
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
      toast(t('share.nowCan', { name: row.label, mode: accessLevel(next) }), { icon: 'check', duration: 2000 });
      onChange?.();
    } catch (e) {
      console.error(e);
      if (!closed) toast(e?.message || t('share.changeFailed'), { icon: 'alert', duration: 4000 });
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
      toast(row.pending ? t('share.invitationCancelled', { name: row.label }) : t('share.removed', { name: row.label }), { icon: 'check', duration: 2000 });
      onChange?.();
      await refresh();
    } catch (e) {
      console.error(e);
      if (!closed) toast(e?.message || t('share.removeFailed'), { icon: 'alert', duration: 4000 });
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
    if (!url) { toast(t('share.linkFailed'), { icon: 'alert', duration: 3500 }); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('share.linkCopied'), { icon: 'link', duration: 3000 });
    } catch {
      await promptDialog({ title: t('share.linkTitle'), label: t('share.linkLabel'), value: url, confirmLabel: t('common.done') });
    }
  }

  const addForm = el('form.share-add', { onsubmit: (e) => { e.preventDefault(); add(); } }, who, mode, shareBtn);
  const hint = el('p.field-hint', {}, t('share.hint'));
  const doneBtn = el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.done'));
  // Editing together (see coauthor.js) comes first: it is what most people sharing a spreadsheet want.
  const live = doc && coauthorSection({ doc, onStarted: (room) => { modal.close(); onLive?.(room); } });
  // A shared workbook opened by someone it was shared with has no file of theirs: only the live part applies.
  const fileless = !path && !!live;
  const content = fileless ? el('div.share-dialog', {}, live, el('div.row.share-foot', {}, el('div.grow'), doneBtn)) : el('div.share-dialog', {},
    live,
    live && el('h3.share-h3', {}, t('share.shareTheFile')),
    addForm,
    alert,
    hint,
    el('h3.share-h3', {}, t('share.peopleWithAccess')),
    status,
    list,
    el('div.row.share-foot', {},
      linkBtn,
      onEmailLink && el('button.btn.btn-outline', { type: 'button', html: icon('sendLink', 16), onclick: () => { modal.close(); onEmailLink(); } }, el('span', {}, t('share.emailLink'))),
      el('div.grow'),
      doneBtn));
  const modal = openModal({ title: t('share.title', { name }), content, initialFocus: fileless ? null : who, onClose: () => { closed = true; } });
  modal.panel.classList.add('share-panel');
  if (!fileless) refresh();
  return modal;
}
