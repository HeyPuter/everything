/**
 * Insert Timelines (a choice of the PivotTable's date fields) and Timeline Settings (caption and
 * which parts show), the two dialogs of a timeline.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { insertTimeline, pivotDateFields } from '../core/timeline.js';
import { decodeXlsxString } from '../core/xlsx-string.js';
import { t } from '../i18n/index.js';

export function openInsertTimelineDialog(ctx, pivot) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const fields = pivotDateFields(wb, pivot);
  if (!fields.length) {
    toast(t('inserttimeline.noDates', { name: decodeXlsxString(pivot.name) }), { icon: 'info', duration: 3200 });
    return null;
  }
  const { alert, refuse } = fieldAlert('timeline');
  const boxes = fields.map((field, i) => {
    const id = fieldId('timeline-field');
    const input = el('input', { type: 'checkbox', id, checked: fields.length === 1 && i === 0 });
    return { field, input, node: el('label.find-option', { for: id }, input, el('span', {}, field.name)) };
  });
  const submit = e => {
    e?.preventDefault();
    const chosen = boxes.filter(b => b.input.checked);
    if (!chosen.length) { modal.close(); return; }
    const ids = [];
    try { wb.transaction('Insert timeline', () => { for (const b of chosen) ids.push(insertTimeline(wb, sheetId, pivot, b.field.index)); }); }
    catch (error) { refuse(null, error.message || t('inserttimeline.couldNotInsert')); return; }
    modal.close();
    if (ids.length) {
      ctx.grid.selectChart?.(ids.at(-1));
      toast(t('inserttimeline.inserted'), { icon: 'timeline', duration: 2800 });
    }
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, t('inserttimeline.choose', { name: decodeXlsxString(pivot.name) })),
    el('div.field', { role: 'group', 'aria-label': t('inserttimeline.dateFields') }, el('div.dedupe-cols', {}, ...boxes.map(b => b.node))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('inserttimeline.title'), content, initialFocus: boxes[0].input, onClose: () => ctx.grid.focus() });
  return modal;
}

export function openTimelineSettingsDialog(ctx, control) {
  const { wb } = ctx;
  const caption = el('input.input', { type: 'text', value: control.title || '', 'aria-label': t('inserttimeline.caption') });
  const checks = [['showHeader', 'inserttimeline.show.header'], ['showSelectionLabel', 'inserttimeline.show.selectionLabel'], ['showTimeLevel', 'inserttimeline.show.timeLevel'], ['showHorizontalScrollbar', 'inserttimeline.show.scrollbar'], ['lockedPosition', 'inserttimeline.show.lockPosition'], ['print', 'inserttimeline.show.print']]
    .map(([key, label]) => ({ key, input: el('input', { type: 'checkbox', checked: key === 'lockedPosition' ? !!control[key] : control[key] !== false }), label: t(label) }));
  const submit = e => {
    e?.preventDefault();
    wb.updateChart(ctx.sheetId(), control.id, { title: caption.value, ...Object.fromEntries(checks.map(c => [c.key, c.input.checked])) }, 'Edit timeline');
    modal.close();
  };
  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('inserttimeline.caption')), caption),
    el('div.field', {}, el('span.field-label', {}, t('common.show')), ...checks.map(c => el('label.check', {}, c.input, el('span', {}, c.label)))),
    el('p.field-hint', {}, t('inserttimeline.filters', { name: decodeXlsxString(control.report.name), field: control.field })),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.save'))));
  const modal = openModal({ title: t('inserttimeline.settingsTitle'), content, initialFocus: caption, onClose: () => ctx.grid.focus() });
  return modal;
}
