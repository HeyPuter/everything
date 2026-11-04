/**
 * Edit ▸ Fill ▸ Across Worksheets: copy the selected cells of the active sheet onto the same cells of the
 * other grouped sheets — everything, the contents alone, or the formatting alone. One undo step.
 */
import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { t } from '../i18n/index.js';

export function openFillAcrossDialog(ctx) {
  const wb = ctx.wb;
  const sourceId = ctx.sheetId();
  const targets = (wb.sheetGroup || []).filter((id) => id !== sourceId);
  if (!targets.length) return null;
  const ranges = ctx.ranges();
  const name = fieldId('fill-across');
  const choices = [['all', t('fillacross.all'), t('fillacross.allHint')], ['contents', t('fillacross.contents'), t('fillacross.contentsHint')], ['formats', t('fillacross.formats'), t('fillacross.formatsHint')]];
  // A list of references or sheet names: "A1:B2, D4" in English, "A1:B2、D4" in Chinese.
  const join = (items) => items.reduce((a, b) => t('fillacross.listJoin', { a, b }));
  const radios = choices.map(([value, label, hint], i) => el('label.check', {},
    el('input', { type: 'radio', name, value, checked: i === 0 }),
    el('span', {}, el('span', {}, label), el('span.small.muted', { style: { display: 'block' } }, hint))));
  const sheetNames = targets.map((id) => wb.sheet(id)?.name).filter(Boolean);
  const submit = (e) => {
    e.preventDefault();
    const what = content.querySelector(`input[name="${name}"]:checked`)?.value || 'all';
    modal.close();
    const written = wb.fillAcrossSheets(sourceId, targets, ranges, what);
    const message = written ? t('fillacross.filled', { ranges: join(ranges.map(rangeName)), count: sheetNames.length }) : t('fillacross.alreadyMatch');
    toast(message, { icon: 'layers', duration: 2800 });
    ctx.announce?.(message);
  };
  const content = el('form.fill-across', { onsubmit: submit },
    el('p.small.muted.modal-text', {}, t('fillacross.intro', { ranges: join(ranges.map(rangeName)), sheet: wb.sheet(sourceId)?.name, sheets: join(sheetNames) })),
    el('fieldset.check-group.vertical', { role: 'radiogroup', 'aria-label': t('fillacross.fill') }, ...radios),
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('fillacross.fill'))));
  const modal = openModal({ title: t('fillacross.title'), content, initialFocus: content.querySelector('input:checked'), onClose: () => ctx.grid?.focus?.() });
  return modal;
}
