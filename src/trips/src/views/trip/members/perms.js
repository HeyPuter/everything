import { el, uid as uniqueId } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { PERMISSIONS } from '../../../shared/perms.js';
import { errorMessage } from './errors.js';
import { PERM_ACTIONS, minimumFor, nextPerms } from './logic.js';
import { keepFocus } from './focus.js';

/** The per-trip permission matrix (data-model §5). Only `perms.edit` (the owner) can change it. */
export function permsSection({ space, me }) {
  const titleId = uniqueId('members-perms');
  const hint = el('p.members-hint');
  const status = el('p.members-status', { role: 'status' });
  const table = el('table.perm-table', { 'aria-labelledby': titleId });
  const reset = button(t('members.permsReset'), { size: 'sm', variant: 'ghost', onclick: () => void save(null) });
  const element = el('section.members-section', { 'aria-labelledby': titleId },
    el('div.members-section-head', {}, el('h3', { id: titleId }, t('members.perms')), reset), hint, table, status);
  let saving = Promise.resolve();

  function save(next) {
    const current = me().perms;
    const same = JSON.stringify(nextPerms(current)) === JSON.stringify(next);
    if (same) return saving;
    const op = next ? space.ops.patch('meta', 'meta', { set: { perms: next } }) : space.ops.patch('meta', 'meta', { unset: ['perms'] });
    saving = saving.then(async () => {
      try { await space.apply([op]); status.textContent = t('members.permsSaved'); status.dataset.state = ''; }
      catch (error) { status.textContent = t('members.errSave', { reason: errorMessage(error) }); status.dataset.state = 'error'; update(); }
    });
    return saving;
  }
  function row(action, perms, editable) {
    const id = uniqueId('perm');
    const minimum = minimumFor(perms, action);
    const rule = PERMISSIONS[action];
    let control;
    if (editable && rule.allowed.length > 1) {
      control = el('select.select.perm-select', { 'aria-labelledby': id, dataset: { focus: `perm:${action}` },
        onchange: (event) => void save(nextPerms(me().perms, action, event.target.value)) },
      rule.allowed.map((role) => el('option', { value: role }, t(`members.permsLevel.${role}`))));
      control.value = minimum;
    } else control = el('span.perm-level', {}, t(`members.permsLevel.${minimum}`));
    return el('tr', {}, el('th', { scope: 'row', id }, t(`members.perm.${action}`)), el('td', {}, control));
  }
  function update() {
    const { perms, permsEdit } = me();
    hint.textContent = permsEdit ? t('members.permsHint') : t('members.permsReadOnly');
    reset.hidden = !permsEdit || nextPerms(perms) === null;
    keepFocus(table, () => table.replaceChildren(
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('members.permsAction')), el('th', { scope: 'col' }, t('members.permsWho')))),
      el('tbody', {}, PERM_ACTIONS.map((action) => row(action, perms, permsEdit)))));
  }
  update();
  return { element, update };
}
