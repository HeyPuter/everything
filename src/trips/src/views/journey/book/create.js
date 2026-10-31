// New-book and book-settings dialogs: title, format (or a custom size in mm) and auto-fill.
import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { formatNumber } from '../../../lib/format.js';
import { BOOK_LIMITS, FORMAT_IDS } from '../../../lib/book/constants.js';
import { FORMATS, formatFields } from '../../../lib/book/formats.js';

const formatLabel = (id) => (id === 'custom' ? t('book.format.custom')
  : t(`book.format.${id}`, { w: formatNumber(FORMATS[id].w / 10), h: formatNumber(FORMATS[id].h / 10) }));

/**
 * Resolves `{title, fmt, w?, h?, fill}` or null when cancelled. `book` prefills the settings form; `fill` asks whether to
 * fill a new book from the journey.
 */
export function openBookForm({ book = null, title = '', fill = true, onDelete } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const titleField = field({ label: t('book.form.title'), value: book?.title ?? title, maxLength: BOOK_LIMITS.title, required: true });
    const legendId = uid('bk-fmt');
    let fmt = book?.fmt ?? 'sq21';
    const width = field({ label: t('book.form.width'), type: 'number', value: String(book?.w ?? 210), min: BOOK_LIMITS.minMm, max: BOOK_LIMITS.maxMm, step: 1 });
    const height = field({ label: t('book.form.height'), type: 'number', value: String(book?.h ?? 210), min: BOOK_LIMITS.minMm, max: BOOK_LIMITS.maxMm, step: 1 });
    const custom = el('div.bk-grid2', { hidden: fmt !== 'custom' }, width.element, height.element);
    const formats = el('fieldset.bk-group', { 'aria-labelledby': legendId }, el('legend', { id: legendId }, t('book.form.format')),
      el('div.bk-formats', {}, FORMAT_IDS.map((id) => el('label.check-field.bk-format', {},
        el('input', { type: 'radio', name: legendId, value: id, checked: fmt === id, onchange: () => { fmt = id; custom.hidden = id !== 'custom'; } }),
        el('span', {}, formatLabel(id))))), custom, el('p.bk-muted', {}, t('book.form.bleed')));
    const fillBox = el('input', { type: 'checkbox', checked: fill });
    const form = el('form.bk-form', { onsubmit: (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      result = { title: titleField.input.value.trim(), ...formatFields(fmt, { w: width.input.value, h: height.input.value }), fill: !book && fillBox.checked };
      dialog.close('confirm');
    } }, titleField.element, formats,
    book ? null : el('label.check-field', {}, fillBox, el('span', {}, t('book.form.fill'))),
    book && onDelete ? el('div.bk-danger', {}, button(t('book.form.delete'), { variant: 'danger', size: 'sm', onclick: () => { dialog.close('delete'); onDelete(); } })) : null,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t(book ? 'ui.save' : 'book.form.create'), { type: 'submit', variant: 'primary' })));
    const dialog = openModal({ title: t(book ? 'book.form.settings' : 'book.form.new'), content: form, onClose: () => resolve(result) });
  });
}
