import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';

/**
 * The Puter desktop window's close button, which waits for this (lib/puter.js onWindowClose). Edits the
 * autosave has not written yet are written first, and a save that cannot go through asks, as leaving the
 * document for another screen does. A document that was never saved has nowhere to go without the user:
 * inside the Puter desktop it waits for a first Save to ask where (lib/doc.js), so closing asks whether to
 * save it, as a desktop app does. Without this the window went at once, and a new document with it.
 */

export const CLOSE_TITLE = 'Save before closing?';

/** The question about a never-saved document: 'save', 'close' (and lose it), or 'stay'. */
export function closeDialog(doc) {
  return new Promise((resolve) => {
    const content = el('div', {},
      // A template or other file opened from the drive stays as it is: only the edits, which go to a new .docx, are at stake.
      el('p.modal-text', {}, doc.path
        ? `Your changes to “${P.displayName(doc.path)}” have not been saved yet. Save them as a new document to choose where it goes on Puter, or close without saving and lose them.`
        : `“${doc.name}” has not been saved yet. Save it to choose where it goes on Puter, or close without saving and lose it.`),
      el('div.row.row-end', { style: { flexWrap: 'wrap' } },
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-danger', { type: 'button', onclick: () => { resolve('close'); modal.close(); } }, 'Close without saving'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { resolve('save'); modal.close(); } }, 'Save…')));
    const modal = openModal({ title: CLOSE_TITLE, content, onClose: () => resolve('stay') });
  });
}

/**
 * Whether the window may close now. `open()` is the screen on show ({ kind, view }); `leaveDialog(doc, options)`
 * asks about edits that could not be written ('stay', 'leave' or 'sign-in'). A screen that changes while a
 * question is up is the user's answer: the window stays.
 */
export async function readyToClose({ open, leaveDialog }) {
  const shown = open();
  if (shown?.kind !== 'editor') return true;
  const { view } = shown, doc = view.doc;
  const still = () => open() === shown;
  if (doc.waitsForPlace) {
    const choice = await closeDialog(doc);
    if (!still() || choice === 'stay') return false;
    if (choice === 'close') return true;
    // Save…: Puter's Save dialog. Cancelling it keeps the window open, with the document as it was.
    try {
      view.engine?.finishComposition?.();
      if (!await doc.save()) return false;
    } catch (e) {
      toast(e?.message || String(e), { icon: 'alert', duration: 8000 });
      return false;
    }
    if (!still()) return false;
  }
  for (;;) {
    if (await view.flush()) return true;
    if (!still()) return false;
    const choice = await leaveDialog(doc, { unsaveable: !!view.unsaveable });
    if (!still() || choice === 'stay') return false;
    if (choice === 'leave') return true;
    // 'sign-in': with a session the save can go through; then try again.
    if (!await session.signIn() || !still()) return false;
  }
}

/**
 * The handler for the close button. Pressed again while a question or a save is under way, it changes
 * nothing: the answer to that decides.
 */
export function createCloseWindow({ open, leaveDialog, exit }) {
  let closing = null;
  return () => {
    if (closing) return closing;
    closing = readyToClose({ open, leaveDialog })
      .then((ok) => { if (ok) exit(); return ok; }, (e) => { console.error(e); return false; })
      .finally(() => { closing = null; });
    return closing;
  };
}
