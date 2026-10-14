/**
 * View ▸ Zoom: the magnification as a choice of presets, the zoom that fits the selection in the window,
 * or a percentage of one's own from 10% to 400%.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';

export const ZOOM_PRESETS = [200, 100, 75, 50, 25];

/** A typed zoom as a whole percentage from 10 to 400, or null. */
export function parseZoomPercent(text) {
  const m = /^\s*(\d{1,3})\s*%?\s*$/.exec(String(text ?? ''));
  const n = m ? Number(m[1]) : NaN;
  return n >= 10 && n <= 400 ? n : null;
}

/** `zoom` is the zoom in force (1 = 100%); `apply(z)` sets one, `fit()` fits the selection. */
export function openZoomDialog({ zoom, apply, fit, canFit = true, onClose } = {}) {
  const name = fieldId('zoom-choice');
  const current = Math.round((zoom || 1) * 100);
  const radio = (value, label, extra = null) => {
    const input = el('input', { type: 'radio', name, id: fieldId('zoom-option'), value: String(value), checked: false });
    return { input, node: el('label.check.zoom-option', { for: input.id }, input, el('span', {}, label), extra) };
  };
  const custom = el('input.input.zoom-custom', { type: 'text', inputMode: 'numeric', autocomplete: 'off', value: String(current), 'aria-label': 'Zoom percentage', maxLength: 4 });
  const options = [
    ...ZOOM_PRESETS.map((n) => radio(n, `${n}%`)),
    radio('fit', 'Fit selection'),
    radio('custom', 'Custom:', el('span.zoom-custom-wrap', {}, custom, el('span.muted', {}, '%'))),
  ];
  const fitOption = options.find((o) => o.input.value === 'fit');
  fitOption.input.disabled = !canFit;
  (options.find((o) => o.input.value === String(current)) || options.at(-1)).input.checked = true;
  custom.addEventListener('focus', () => { options.at(-1).input.checked = true; });
  custom.addEventListener('input', () => { options.at(-1).input.checked = true; });
  const { alert, refuse } = fieldAlert('zoom-dialog');
  const submit = (e) => {
    e.preventDefault();
    const choice = options.find((o) => o.input.checked)?.input.value;
    if (choice === 'fit') { modal.close(); fit?.(); return; }
    const percent = choice === 'custom' ? parseZoomPercent(custom.value) : Number(choice);
    if (percent == null) return refuse(custom, 'Enter a whole percentage from 10% to 400%.');
    modal.close();
    apply?.(percent / 100);
  };
  const content = el('form.zoom-dialog', { onsubmit: submit },
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Magnification'), ...options.map((o) => o.node)),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Zoom', content, initialFocus: (options.find((o) => o.input.checked) || options[1]).input, onClose });
  return modal;
}
