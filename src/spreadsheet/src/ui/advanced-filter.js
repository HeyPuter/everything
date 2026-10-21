/** Data ▸ Sort & Filter ▸ Advanced: filter a list by a criteria range, in place or copied elsewhere. */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { advancedFilter } from '../core/advanced-filter.js';

const absolute = (range) => rangeName(range).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');

export function openAdvancedFilter(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const list = ctx.dataRange();
  const sheetName = quoteSheet(wb.sheet(sheetId)?.name || '');
  const inPlace = el('input', { type: 'radio', name: fieldId('af-action'), id: fieldId('af-in-place'), checked: true });
  const copy = el('input', { type: 'radio', name: inPlace.name, id: fieldId('af-copy') });
  const listInput = el('input.input', { type: 'text', id: fieldId('af-list'), value: list && list.r2 > list.r1 ? `${sheetName}!${absolute(list)}` : '', autocomplete: 'off', spellcheck: false });
  const criteriaInput = el('input.input', { type: 'text', id: fieldId('af-criteria'), autocomplete: 'off', spellcheck: false });
  const copyInput = el('input.input', { type: 'text', id: fieldId('af-copy-to'), autocomplete: 'off', spellcheck: false, disabled: true });
  const unique = el('input', { type: 'checkbox', id: fieldId('af-unique') });
  const { alert, refuse } = fieldAlert('advanced-filter');
  const sync = () => { copyInput.disabled = !copy.checked; };
  inPlace.addEventListener('change', sync);
  copy.addEventListener('change', sync);
  const submit = (e) => {
    e.preventDefault();
    const listRef = ctx.resolveRange(listInput.value.trim());
    if (!listRef || listRef.sheetId !== sheetId) return refuse(listInput, 'Enter the list range on this sheet, such as $A$1:$D$40');
    const critText = criteriaInput.value.trim();
    const critRef = critText ? ctx.resolveRange(critText) : null;
    if (critText && !critRef) return refuse(criteriaInput, 'Enter the criteria range, such as $F$1:$G$3');
    let copyTo = null;
    if (copy.checked) {
      const ref = ctx.resolveRange(copyInput.value.trim());
      if (!ref) return refuse(copyInput, 'Enter where to copy the records, such as $J$1');
      copyTo = { sheetId: ref.sheetId, range: ref.range };
    }
    const out = advancedFilter(wb, sheetId, { list: listRef.range, criteria: critRef && { sheetId: critRef.sheetId, range: critRef.range }, copyTo, unique: unique.checked });
    if (out.error) return refuse(null, out.error);
    modal.close();
    toast(copyTo ? `${out.copied} record${out.copied === 1 ? '' : 's'} copied` : `${out.shown} of ${out.shown + out.hidden} records shown`, { icon: 'filter' });
  };
  const field = (label, input) => el('div.field', {}, el('label.field-label', { for: input.id }, label), input);
  const content = el('form.af-dialog', { onsubmit: submit },
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Action'),
      el('label.check', { for: inPlace.id }, inPlace, el('span', {}, 'Filter the list, in-place')),
      el('label.check', { for: copy.id }, copy, el('span', {}, 'Copy to another location'))),
    field('List range:', listInput),
    field('Criteria range:', criteriaInput),
    field('Copy to:', copyInput),
    el('label.check', { for: unique.id }, unique, el('span', {}, 'Unique records only')),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Advanced Filter', content, initialFocus: listInput.value ? criteriaInput : listInput, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
