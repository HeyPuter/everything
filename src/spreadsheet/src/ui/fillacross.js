/**
 * Edit ▸ Fill ▸ Across Worksheets: copy the selected cells of the active sheet onto the same cells of the
 * other grouped sheets — everything, the contents alone, or the formatting alone. One undo step.
 */
import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';

export function openFillAcrossDialog(ctx) {
  const wb = ctx.wb;
  const sourceId = ctx.sheetId();
  const targets = (wb.sheetGroup || []).filter((id) => id !== sourceId);
  if (!targets.length) return null;
  const ranges = ctx.ranges();
  const name = fieldId('fill-across');
  const choices = [['all', 'All', 'Contents and formatting'], ['contents', 'Contents', 'Values and formulas; each sheet keeps its formatting'], ['formats', 'Formats', 'Formatting only; each sheet keeps its values']];
  const radios = choices.map(([value, label, hint], i) => el('label.check', {},
    el('input', { type: 'radio', name, value, checked: i === 0 }),
    el('span', {}, el('span', {}, label), el('span.small.muted', { style: { display: 'block' } }, hint))));
  const sheetNames = targets.map((id) => wb.sheet(id)?.name).filter(Boolean);
  const submit = (e) => {
    e.preventDefault();
    const what = content.querySelector(`input[name="${name}"]:checked`)?.value || 'all';
    modal.close();
    const written = wb.fillAcrossSheets(sourceId, targets, ranges, what);
    const message = written ? `Filled ${ranges.map(rangeName).join(', ')} across ${sheetNames.length} sheet${sheetNames.length === 1 ? '' : 's'}` : 'Those cells already match on every grouped sheet';
    toast(message, { icon: 'layers', duration: 2800 });
    ctx.announce?.(message);
  };
  const content = el('form.fill-across', { onsubmit: submit },
    el('p.small.muted.modal-text', {}, `Copies ${ranges.map(rangeName).join(', ')} from ${wb.sheet(sourceId)?.name} to the same cells of ${sheetNames.join(', ')}.`),
    el('fieldset.check-group.vertical', { role: 'radiogroup', 'aria-label': 'Fill' }, ...radios),
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Fill')));
  const modal = openModal({ title: 'Fill across worksheets', content, initialFocus: content.querySelector('input:checked'), onClose: () => ctx.grid?.focus?.() });
  return modal;
}
