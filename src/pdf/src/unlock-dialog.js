import {
  PasswordError,
  authenticateOwner,
  documentAccess,
  openedProtection,
  unlockPdf,
} from './core/security.js';
import { el, button, modal, toast } from './lib/ui.js';

/**
 * Open a password-protected PDF. Files that only restrict permissions open silently; other
 * files ask for the password until it is right or the reader cancels.
 * Resolves to `{ bytes, protection }` with the unlocked bytes and the protection to carry on
 * to downloads and saves (the file's own, until it is changed), or to null when the reader
 * cancels or the requesting operation is aborted.
 */
export async function promptUnlock(
  bytes,
  name,
  { signal, isCurrent = () => true, onOpen, beforeOpen } = {},
) {
  if (signal?.aborted || !isCurrent()) return null;
  try {
    const opened = await unlockPdf(bytes, '');
    if (signal?.aborted || !isCurrent()) return null;
    return { bytes: opened.bytes, protection: openedProtection(opened, '') };
  } catch (error) {
    if (signal?.aborted || !isCurrent()) return null;
    if (!(error instanceof PasswordError)) throw error;
  }
  if (beforeOpen && !(await beforeOpen())) return null;
  if (signal?.aborted || !isCurrent()) return null;
  return new Promise((resolve) => {
    let pending = false;
    const input = el('input', {
      class: 'input',
      id: 'unlock-password',
      type: 'password',
      autocomplete: 'off',
      required: true,
    });
    const show = el('input', { type: 'checkbox', id: 'unlock-show' });
    show.onchange = () => {
      input.type = show.checked ? 'text' : 'password';
    };
    const form = el(
      'form',
      { class: 'stack' },
      el('p', { class: 'muted' }, `${name} is password protected. Enter its password to open it.`),
      el('div', { class: 'field' }, el('label', { for: 'unlock-password' }, 'Password'), input),
      el(
        'label',
        { class: 'checkbox-row', for: 'unlock-show' },
        el('span', {}, 'Show password'),
        show,
      ),
    );
    const open = async () => {
      if (pending) return;
      const password = input.value;
      if (!password) {
        // Open sits outside the form, so the field's own "required" never spoke up.
        toast('Enter the password to open the PDF.', { error: true });
        input.focus();
        return;
      }
      pending = true;
      openButton.disabled = true;
      try {
        const opened = await unlockPdf(bytes, password);
        if (!dialog.open || signal?.aborted || !isCurrent()) return;
        resolve({ bytes: opened.bytes, protection: openedProtection(opened, password) });
        dialog.close();
      } catch (error) {
        // A rejected submission must not select or report an error on a newer draft.
        if (!dialog.open || signal?.aborted || !isCurrent() || input.value !== password) return;
        toast(
          error instanceof PasswordError ? 'That password is not right. Try again.' : error.message,
          { error: true },
        );
        input.focus();
        input.select();
      } finally {
        pending = false;
        openButton.disabled = false;
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      open();
    };
    const openButton = button('Open', 'LockOpen', open, 'btn primary');
    const dialog = modal(
      'Password required',
      form,
      [button('Cancel', null, () => dialog.close()), openButton],
      { signal },
    );
    onOpen?.(dialog);
    dialog.addEventListener('close', () => resolve(null), { once: true });
    input.focus();
  });
}

/** Lift restrictions only after authenticating the document's permissions (owner) password. */
export function promptOwner(protection, { signal, isCurrent = () => true, onOpen } = {}) {
  if (signal?.aborted || !isCurrent()) return Promise.resolve(null);
  const access = documentAccess(protection);
  if (access.owner) return Promise.resolve(protection);
  return new Promise((resolve) => {
    let pending = false;
    const input = el('input', {
      class: 'input',
      id: 'owner-password',
      type: 'password',
      autocomplete: 'off',
      required: true,
    });
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'This PDF has document restrictions. Enter its permissions password to unlock all editing or change its protection.',
      ),
      el(
        'dl',
        { class: 'detail-facts', 'aria-label': 'Document permissions' },
        ...[
          ['Printing', 'print'],
          ['Copying content', 'copy'],
          ['Editing content', 'edit'],
          ['Comments and links', 'annotate'],
          ['Filling forms', 'fill'],
          ['Pages and bookmarks', 'assemble'],
        ].flatMap(([label, key]) => [
          el('dt', {}, label),
          el(
            'dd',
            {},
            !access[key]
              ? 'Not allowed'
              : key === 'print' && !access.printHighQuality
                ? 'Low resolution only'
                : 'Allowed',
          ),
        ]),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'owner-password' }, 'Permissions password'),
        input,
      ),
    );
    const unlock = async () => {
      if (pending) return;
      const password = input.value;
      if (!password) {
        toast('Enter the permissions password.', { error: true });
        input.focus();
        return;
      }
      pending = true;
      unlockButton.disabled = true;
      try {
        const next = await authenticateOwner(protection, password);
        if (!dialog.open || signal?.aborted || !isCurrent()) return;
        resolve(next);
        dialog.close();
      } catch (error) {
        if (!dialog.open || signal?.aborted || !isCurrent() || input.value !== password) return;
        toast(
          error instanceof PasswordError
            ? 'Enter the permissions password. The password used only to open the PDF cannot lift restrictions.'
            : error.message,
          { error: true },
        );
        input.focus();
        input.select();
      } finally {
        pending = false;
        unlockButton.disabled = false;
      }
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      unlock();
    };
    const unlockButton = button('Unlock', 'LockOpen', unlock, 'btn primary');
    const dialog = modal(
      'Permissions password required',
      form,
      [button('Cancel', null, () => dialog.close()), unlockButton],
      { signal },
    );
    onOpen?.(dialog);
    dialog.addEventListener('close', () => resolve(null), { once: true });
    input.focus();
  });
}
