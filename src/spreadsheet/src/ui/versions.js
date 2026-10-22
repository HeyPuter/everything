/**
 * Version history dialog: the snapshots kept for the open document, with
 * Restore and Delete per entry and a way to save a labeled one now.
 */

import { el, formatBytes, relativeTime } from './dom.js';
import { icon } from './icons.js';
import { openModal, confirmDialog, focusListRow } from './modal.js';
import { toast } from './toast.js';
import { listVersions, deleteVersion, AUTO_VERSION_MS } from '../lib/versions.js';

const when = (at) => {
  const d = new Date(at);
  const abs = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${relativeTime(at)} · ${abs}`;
};

/** Open the dialog for `doc` (a Doc with a path). `onRestored` runs after a restore. */
export function openVersionHistory(doc, { onRestored } = {}) {
  const list = el('div.version-list', { role: 'list', 'aria-label': 'Versions' });
  const labelInput = el('input.input', { type: 'text', placeholder: 'Label (optional), e.g. Before Q3 changes', 'aria-label': 'Version label', maxlength: 40 });
  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, 'Save a version now');
  const hint = el('p.field-hint', {}, `A version is saved on its own about every ${Math.round(AUTO_VERSION_MS / 60000)} minutes while you work. Restoring keeps a version of the current state first.`);
  let busy = false;
  let closed = false;
  let loadId = 0;

  function setBusy(value, { keepButtons = false } = {}) {
    busy = value;
    content.setAttribute('aria-busy', String(value));
    if (!keepButtons) for (const control of content.querySelectorAll('button, input')) control.disabled = value;
  }

  // The wait and its outcome are said aloud, as on the home list: a notice swapped in for the rows is not heard.
  const status = el('p.visually-hidden', { role: 'status' });
  const say = (text) => { if (status.textContent !== text) status.textContent = text; };

  /**
   * A notice in place of the rows. Prose is no list item, so the list stops being a list while it shows one.
   * `retry` offers to read the versions again, for a failure that may pass (the connection, say).
   */
  function notice(text, { retry: offerRetry = false } = {}) {
    say(text);
    list.removeAttribute('role');
    list.replaceChildren(el('div.version-empty', {}, el('p', {}, text),
      offerRetry && el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: retry }, 'Try again')));
  }

  // The button pressed is replaced by the wait: the focus goes to what the reading brought, a row's
  // Restore, the Try again of another failure, or the label field when there is no version.
  async function retry() {
    if (busy || closed) return;
    await refresh();
    if (closed || content.contains(document.activeElement)) return;
    (list.querySelector('.version-empty button') || list.querySelector('[data-action="restore"]') || labelInput).focus();
  }

  async function refresh() {
    if (closed) return;
    const requestId = ++loadId;
    notice('Loading…');
    let versions = [];
    // The snapshot of a save made a moment ago may still be on its way: listed before it lands, the history read
    // "No versions yet" and stayed so, and a version saved by hand on the strength of that doubled it.
    try { await doc.versionSettled?.(); versions = await listVersions(doc.file ?? doc.path); }
    catch (e) {
      if (closed || requestId !== loadId) return;
      console.error(e);
      notice('Could not read the versions', { retry: true });
      return;
    }
    if (closed || requestId !== loadId) return;
    if (!versions.length) { notice('No versions yet. Save one now, or keep working and one will appear.'); return; }
    say(`${versions.length} version${versions.length === 1 ? '' : 's'}`);
    list.setAttribute('role', 'list');
    list.replaceChildren(...versions.map((v, idx) => el('div.version-row', { role: 'listitem' },
      el('div.version-main', {},
        el('div.version-when', {}, v.label || when(v.at)),
        el('div.version-meta', {}, `${v.label ? `${when(v.at)} · ` : ''}${formatBytes(v.size)}`)),
      el('button.btn.btn-sm', { type: 'button', dataset: { action: 'restore' }, onclick: () => restore(v) }, 'Restore'),
      el('button.icon-btn', { type: 'button', html: icon('trash', 16), 'aria-label': `Delete the version from ${when(v.at)}`, title: 'Delete', dataset: { action: 'delete' }, onclick: () => remove(v, idx) }))));
    setBusy(busy);
  }

  // Saving or deleting disables every control while it runs, which blurs the one pressed, and the rows
  // are rebuilt after: the focus is put back when the work is done, not left on the page.
  async function saveNow() {
    if (busy || closed) return;
    const from = content.contains(document.activeElement) ? document.activeElement : null;
    setBusy(true);
    try {
      // Null: the spreadsheet had no file yet, and Puter's Save dialog for it was cancelled.
      const entry = await doc.saveVersion(labelInput.value);
      if (closed || entry === null) return;
      labelInput.value = '';
      toast('Version saved', { icon: 'check', duration: 2000 });
      await refresh();
    } catch (e) {
      console.error(e);
      if (!closed) toast('Could not save a version', { icon: 'alert', duration: 4000 });
    } finally {
      setBusy(false);
      if (from && !closed && !content.contains(document.activeElement)) (from.isConnected ? from : labelInput).focus();
    }
  }

  async function restore(v) {
    if (busy || closed) return;
    // The buttons stay enabled while the question is open: the confirm hands focus back to the one that asked.
    setBusy(true, { keepButtons: true });
    try {
      const ok = await confirmDialog({
        title: 'Restore this version?',
        message: `The spreadsheet goes back to how it was ${when(v.at)}${v.label ? ` (${v.label})` : ''}. The current state is kept as a version first, so nothing is lost.`,
        confirmLabel: 'Restore', danger: false,
      });
      if (!ok || closed) return;
      setBusy(true);
      await doc.restoreVersion(v.path);
      if (closed) return;
      modal.close();
      toast('Version restored', { icon: 'check', duration: 2500 });
      onRestored?.();
    } catch (e) {
      console.error(e);
      if (!closed) toast(e?.message || 'Could not restore that version', { icon: 'alert', duration: 4000 });
    } finally { setBusy(false); }
  }

  async function remove(v, idx) {
    if (busy || closed) return;
    setBusy(true, { keepButtons: true });
    try {
      const ok = await confirmDialog({ title: 'Delete this version?', message: `The version from ${when(v.at)} is removed for good.`, confirmLabel: 'Delete' });
      if (!ok || closed) return;
      setBusy(true);
      await deleteVersion(v.path);
      // The document may have been counting the deleted snapshot as its newest, and would then skip
      // the automatic snapshot of every save until that one's ten minutes were up.
      doc.forgetVersionClock?.();
      if (!closed) await refresh();
    } catch (e) {
      console.error(e);
      if (!closed) toast('Could not delete the version', { icon: 'alert' });
    } finally {
      setBusy(false);
      // The row that took the deleted one's place (or the same row, when the delete failed), else the label field.
      if (!closed && !content.contains(document.activeElement)) focusListRow(list, idx, 'delete', labelInput);
    }
  }

  // A form, so Enter in the label field saves as the button does, as in every other dialog.
  const content = el('div', {},
    el('form.row.version-save', { onsubmit: (e) => { e.preventDefault(); saveNow(); } }, labelInput, saveBtn),
    hint,
    status,
    list);
  const modal = openModal({ title: 'Version history', content, onClose: () => { closed = true; } });
  refresh();
  return modal;
}
