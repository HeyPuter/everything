/**
 * Protected ranges: lock parts of a sheet against edits, with a note saying
 * why. Whole-sheet protection lives in the sheet tab menu; this is for a
 * few cells (totals, inputs that must not move) on an otherwise open sheet.
 */

import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { openModal, focusListRow, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { normalizeRange, rangeName } from '../core/cell.js';
import { t } from '../i18n/index.js';

export function openProtectedRanges(ctx) {
  const sheetId = ctx.sheetId();
  const wb = ctx.wb;
  const list = el('div.cf-list', { role: 'list', 'aria-label': t('protect.title') });
  let editingId = null;
  const rangeInput = el('input.input', { type: 'text', 'aria-label': t('protect.range'), value: rangeName(ctx.range()), spellcheck: false, autocomplete: 'off' });
  const descInput = el('input.input', { type: 'text', 'aria-label': t('protect.description'), placeholder: t('protect.descriptionPlaceholder'), autocomplete: 'off', maxlength: 200 });
  const { alert: error, refuse, clear: clearError } = fieldAlert('protect'); // every refusal here is about the range
  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, t('protect.protect'));
  // Hiding the button it was pressed on would drop the focus to the page: it goes to the form's first field, as in Named ranges.
  const cancelEdit = el('button.btn.btn-ghost', { type: 'button', hidden: true, onclick: () => { resetForm(); rangeInput.focus(); } }, t('protect.cancelEdit'));

  function resetForm() {
    editingId = null;
    rangeInput.value = rangeName(ctx.range());
    descInput.value = '';
    saveBtn.textContent = t('protect.protect');
    cancelEdit.hidden = true;
    clearError();
  }
  function load(p) {
    // The form no longer holds the refused range: the message and the mark go with it.
    clearError();
    editingId = p.id;
    rangeInput.value = rangeName(p.range);
    descInput.value = p.description || '';
    saveBtn.textContent = t('common.save');
    cancelEdit.hidden = false;
    rangeInput.focus();
  }
  function render() {
    clear(list);
    const items = wb.sheet(sheetId)?.protectedRanges || [];
    if (!items.length) { list.append(el('p.small.muted', { style: { padding: '6px 2px' } }, t('protect.empty'))); return; }
    // Unprotecting rebuilds the rows; the focus goes back to the row that took the place of the
    // unprotected one, or to the range field when none is left.
    items.forEach((p, idx) => {
      list.append(el('div.names-row', { role: 'listitem' },
        el('button.names-main', { type: 'button', onclick: () => load(p) },
          el('span.menu-icon', { html: icon('lock', 16) }),
          el('span.names-name', {}, rangeName(p.range)),
          el('span.names-ref', {}, p.description || t('protect.protected'))),
        el('button.icon-btn', { type: 'button', html: icon('unlock', 16), 'aria-label': t('protect.unprotectRange', { range: rangeName(p.range) }), title: t('protect.unprotect'), dataset: { action: 'delete' }, onclick: () => { wb.unprotectRange(sheetId, p.id); if (editingId === p.id) resetForm(); render(); toast(t('protect.unprotected', { range: rangeName(p.range) }), { icon: 'unlock' }); focusListRow(list, idx, 'delete', rangeInput); } })));
    });
  }
  const submit = (e) => {
    e.preventDefault();
    const text = rangeInput.value.trim();
    // The same reading as every other range box: within this sheet's limits, or a name for such a range.
    const parsed = wb.rangeFromText(sheetId, text);
    const range = parsed && parsed.sheetId === sheetId ? normalizeRange(parsed.range) : null;
    if (!range) return refuse(rangeInput, parsed ? t('protect.rangeOnSheet') : t('protect.rangeLike'));
    // The same cells twice would take two unprotects to free, so a second entry is refused.
    const twin = (wb.sheet(sheetId)?.protectedRanges || []).find(({ id, range: p }) => id !== editingId && p.r1 === range.r1 && p.c1 === range.c1 && p.r2 === range.r2 && p.c2 === range.c2);
    if (twin) return refuse(rangeInput, t('protect.alreadyProtected', { range: rangeName(range) }));
    clearError();
    if (editingId) wb.updateProtectedRange(sheetId, editingId, { range, description: descInput.value.trim() });
    else wb.protectRange(sheetId, range, descInput.value.trim());
    toast(t('protect.protectedToast', { range: rangeName(range) }), { icon: 'lock' });
    resetForm();
    render();
  };
  const form = el('form.cf-form', { onsubmit: submit },
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, t('protect.range')), rangeInput),
      el('label.field', {}, el('span.field-label', {}, t('protect.description')), descInput)),
    error,
    el('div.row.row-end', {}, cancelEdit, saveBtn));
  const modal = openModal({ title: t('protect.title'), content: el('div', {}, el('p.small.muted', {}, t('protect.intro')), list, form), wide: true, onClose: () => ctx.grid?.focus?.() });
  resetForm();
  render();
  return modal;
}
