import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { rangeName } from '../core/cell.js';
import { t } from '../i18n/index.js';

export function openSparklineCreateDialog(ctx, { type = null } = {}) {
  const sheetId = ctx.sheetId(), inputs = {};
  const content = el('form', { noValidate: true }), { alert, refuse } = fieldAlert('sparkline-create');
  const field = (key, label, value, choices) => {
    const input = choices ? el('select.select', { 'aria-label': label }, choices.map(([value, text]) => el('option', { value }, text)))
      : el('input.input', { type: 'text', 'aria-label': label, autocomplete: 'off' });
    input.value = value; inputs[key] = input;
    content.append(el('label.field', {}, el('span.field-label', {}, label), input));
  };
  field('source', t('sparklinecreatedialog.dataRange'), '');
  field('location', t('sparklinecreatedialog.locationRange'), rangeName(ctx.range()));
  field('type', t('sparklinecreatedialog.chartType'), ['line', 'column', 'stacked'].includes(type) ? type : 'line', [['line', t('sparklinecreatedialog.typeLine')], ['column', t('sparklinecreatedialog.typeColumn')], ['stacked', t('sparklinecreatedialog.typeWinLoss')]]);
  field('orientation', t('sparklinecreatedialog.perRowOrColumn'), 'auto', [['auto', t('sparklinecreatedialog.automatic')], ['rows', t('sparklinecreatedialog.dataRow')], ['columns', t('sparklinecreatedialog.dataColumn')]]);
  content.append(el('p.small.muted', {}, t('sparklinecreatedialog.note')));
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('sparklinecreatedialog.create'))));
  content.addEventListener('submit', event => {
    event.preventDefault();
    const error = ctx.wb.createNativeSparklines(sheetId, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    if (error) return refuse(inputs[error.field], error.message);
    modal.close();
  });
  const modal = openModal({ title: t('sparklinecreatedialog.title'), content, initialFocus: inputs.source, onClose: () => ctx.grid.focus() });
  return modal;
}
