import { el, button, modal, toast } from './lib/ui.js';
import { sameEncryptionPassword } from './core/security.js';

const PERMISSIONS = [
  ['print', 'Print'],
  ['copy', 'Copy text and images'],
  ['annotate', 'Comment and fill in forms'],
  ['edit', 'Edit content and pages'],
];
/**
 * Choose the password readers need and, optionally, a permissions password with the actions
 * allowed without it. Resolves to the new protection, to null when it is removed, or to
 * undefined when the dialog is cancelled.
 */
export function protectDialog(current, { signal } = {}) {
  return new Promise((resolve) => {
    let result;
    // A file opened with its permissions password keeps an open password that is not known
    // here; leaving the fields empty keeps it.
    const unknownOpen = current?.open === null && (current.openFrom || current.original);
    const passwordField = (id, label, value = '') => {
      const input = el('input', {
        class: 'input',
        id,
        type: 'password',
        autocomplete: 'new-password',
        maxlength: 127,
        value,
        ...(unknownOpen && id !== 'protect-owner' && { placeholder: 'Unchanged' }),
      });
      return { input, row: el('div', { class: 'field' }, el('label', { for: id }, label), input) };
    };
    const open = passwordField('protect-open', 'Password to open', current?.open || '');
    const confirm = passwordField('protect-confirm', 'Confirm password', current?.open || '');
    if (unknownOpen) {
      const hint = el(
        'p',
        { class: 'muted field-hint', id: 'protect-open-hint' },
        'Leave empty to keep the current password to open.',
      );
      open.row.append(hint);
      open.input.setAttribute('aria-describedby', hint.id);
    }
    const owner = passwordField(
      'protect-owner',
      'Permissions password',
      current?.permissions || '',
    );
    // A file opened with its reader password keeps restrictions whose password is not known
    // here; they show as ticked so that changing the open password does not drop them.
    const restricted =
      Boolean(current?.permissions) ||
      Object.values(current?.allow || {}).some((allowed) => allowed === false);
    const restrict = el('input', {
      type: 'checkbox',
      id: 'protect-restrict',
      checked: restricted,
    });
    const allowances = PERMISSIONS.map(([key, label]) => {
      const box = el('input', {
        type: 'checkbox',
        id: `protect-allow-${key}`,
        checked: current?.allow?.[key] !== false,
      });
      return {
        key,
        box,
        row: el(
          'label',
          { class: 'checkbox-row', for: `protect-allow-${key}` },
          el('span', {}, label),
          box,
        ),
      };
    });
    const restrictions = el(
      'div',
      { class: 'stack protect-restrictions' },
      owner.row,
      el('p', { class: 'muted' }, 'Without the permissions password, readers can only:'),
      ...allowances.map((a) => a.row),
    );
    const syncRestrictions = () => {
      restrictions.hidden = !restrict.checked;
    };
    restrict.onchange = syncRestrictions;
    syncRestrictions();
    const show = el('input', { type: 'checkbox', id: 'protect-show' });
    show.onchange = () => {
      for (const { input } of [open, confirm, owner])
        input.type = show.checked ? 'text' : 'password';
    };
    const form = el(
      'form',
      { class: 'stack' },
      el(
        'p',
        { class: 'muted' },
        'The PDF is encrypted with AES-256 when you download or save it. Passwords stay in this tab only.',
      ),
      open.row,
      confirm.row,
      el(
        'label',
        { class: 'checkbox-row', for: 'protect-restrict' },
        el('span', {}, 'Restrict printing, copying, or editing'),
        restrict,
      ),
      restrictions,
      el(
        'label',
        { class: 'checkbox-row', for: 'protect-show' },
        el('span', {}, 'Show passwords'),
        show,
      ),
    );
    const fail = (message, input) => {
      toast(message, { error: true });
      input.focus();
    };
    const apply = () => {
      const openValue = open.input.value;
      const ownerValue = restrict.checked ? owner.input.value : '';
      const keepOpen = unknownOpen && !openValue && !confirm.input.value;
      if (!openValue && !restrict.checked && !keepOpen)
        return fail(
          'Enter a password to open the PDF, or restrict what readers can do.',
          open.input,
        );
      if (openValue !== confirm.input.value)
        return fail('The passwords do not match.', confirm.input);
      // Invisible characters such as soft hyphens are dropped from PDF passwords.
      const invisible = 'Use visible characters. This password is empty in the PDF.';
      if (openValue && sameEncryptionPassword(openValue, '')) return fail(invisible, open.input);
      if (restrict.checked && !ownerValue)
        return fail('Enter a permissions password.', owner.input);
      if (restrict.checked && sameEncryptionPassword(ownerValue, ''))
        return fail(invisible, owner.input);
      if (restrict.checked && sameEncryptionPassword(ownerValue, openValue))
        return fail(
          'Use a different permissions password. These passwords are equivalent in the PDF, so the open password would lift the restrictions.',
          owner.input,
        );
      const allow = Object.fromEntries(
        allowances.map(({ key, box }) => [key, restrict.checked ? box.checked : true]),
      );
      // Permissions finer than the checkboxes carry over while their box is left as it was.
      const { R, P } = current?.original?.security || {};
      const base = restrict.checked ? (current?.base ?? (R >= 3 ? P : null)) : null;
      result = keepOpen
        ? { open: null, permissions: ownerValue, allow, base, openFrom: unknownOpen }
        : { open: openValue, permissions: ownerValue, allow, base };
      dialog.close();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      apply();
    };
    const dialog = modal(
      current ? 'Change password' : 'Protect with password',
      form,
      [
        button('Cancel', null, () => dialog.close()),
        current &&
          button('Remove password', 'LockOpen', () => {
            result = null;
            dialog.close();
          }),
        button(current ? 'Update' : 'Protect', 'Lock', apply, 'btn primary'),
      ].filter(Boolean),
      { signal },
    );
    dialog.addEventListener('close', () => resolve(result), { once: true });
    open.input.focus();
  });
}
