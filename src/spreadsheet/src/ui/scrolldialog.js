import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { t } from '../i18n/index.js';

export function openScrollDialog(ctx, control) {
  const inputs = {}, content = el('form'), { alert, refuse } = fieldAlert('scroll');
  const add = (key, label, type = 'text') => {
    const input = inputs[key] = el('input.input', { type, value: String(control[key] ?? ''), 'aria-label': label,
      ...(type === 'number' ? { min: 0, max: 30000, step: 1, required: true } : {}) });
    content.append(el('label.field', {}, el('span.field-label', {}, label), input));
  };
  add('title', t('common.name')); add('linkRef', t('scrolldialog.linkedCell'));
  for (const [key, label] of [['min', t('scrolldialog.minimum')], ['max', t('scrolldialog.maximum')], ['step', t('scrolldialog.arrowIncrement')], ['page', t('scrolldialog.pageIncrement')]]) add(key, label, 'number');
  for (const [key, label] of [['horizontal', t('scrolldialog.horizontal')], ['print', t('scrolldialog.printControl')]]) {
    inputs[key] = el('input', { type: 'checkbox', checked: control[key] });
    content.append(el('label.check', {}, inputs[key], el('span', {}, label)));
  }
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.save'))));
  content.addEventListener('submit', e => {
    e.preventDefault();
    const patch = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim()]));
    const target = patch.linkRef && ctx.wb.rangeFromText(ctx.sheetId(), patch.linkRef);
    if (patch.max < patch.min) { refuse(inputs.max, t('scrolldialog.maxBelowMin')); return; }
    if (patch.linkRef && (!target || target.range.r1 !== target.range.r2 || target.range.c1 !== target.range.c2)) { refuse(inputs.linkRef, t('scrolldialog.singleCell')); return; }
    ctx.wb.updateChart(ctx.sheetId(), control.id, patch, t('scrolldialog.title')); modal.close();
  });
  const modal = openModal({ title: t('scrolldialog.title'), content, initialFocus: inputs.title, onClose: () => ctx.grid.focus() });
  return modal;
}
