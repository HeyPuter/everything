/** Data ▸ Sort & Filter ▸ Advanced: filter a list by a criteria range, in place or copied elsewhere. */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { advancedFilter } from '../core/advanced-filter.js';
import { t } from '../i18n/index.js';

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
    if (!listRef || listRef.sheetId !== sheetId) return refuse(listInput, t('advancedFilter.badList'));
    const critText = criteriaInput.value.trim();
    const critRef = critText ? ctx.resolveRange(critText) : null;
    if (critText && !critRef) return refuse(criteriaInput, t('advancedFilter.badCriteria'));
    let copyTo = null;
    if (copy.checked) {
      const ref = ctx.resolveRange(copyInput.value.trim());
      if (!ref) return refuse(copyInput, t('advancedFilter.badCopyTo'));
      copyTo = { sheetId: ref.sheetId, range: ref.range };
    }
    const out = advancedFilter(wb, sheetId, { list: listRef.range, criteria: critRef && { sheetId: critRef.sheetId, range: critRef.range }, copyTo, unique: unique.checked });
    if (out.error) return refuse(null, out.error);
    modal.close();
    toast(copyTo ? t('advancedFilter.copied', { count: out.copied }) : t('advancedFilter.shown', { shown: out.shown, total: out.shown + out.hidden }), { icon: 'filter' });
  };
  const field = (label, input) => el('div.field', {}, el('label.field-label', { for: input.id }, label), input);
  const content = el('form.af-dialog', { onsubmit: submit },
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('advancedFilter.action')),
      el('label.check', { for: inPlace.id }, inPlace, el('span', {}, t('advancedFilter.inPlace'))),
      el('label.check', { for: copy.id }, copy, el('span', {}, t('advancedFilter.copy')))),
    field(t('advancedFilter.listRange'), listInput),
    field(t('advancedFilter.criteriaRange'), criteriaInput),
    field(t('advancedFilter.copyTo'), copyInput),
    el('label.check', { for: unique.id }, unique, el('span', {}, t('advancedFilter.unique'))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('advancedFilter.title'), content, initialFocus: listInput.value ? criteriaInput : listInput, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
