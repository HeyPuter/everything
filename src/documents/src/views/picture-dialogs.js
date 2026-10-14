import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { RESOLUTIONS } from './picture-presets.js';

/** Compress Pictures: resolution for the pictures' printed size, delete cropped areas, this picture or all. */
export function openCompressDialog({ selectedOnly = true, onApply }) {
  const only = el('input', { type: 'checkbox', checked: selectedOnly, disabled: !selectedOnly, id: 'pic-compress-only' });
  const crop = el('input', { type: 'checkbox', checked: true, id: 'pic-compress-crop' });
  const name = 'pic-compress-ppi';
  const choices = RESOLUTIONS.map(([label, ppi], i) => {
    const input = el('input', { type: 'radio', name, value: String(ppi), checked: ppi === 150, id: `pic-compress-${i}` });
    return el('label.pic-radio', { htmlFor: input.id }, input, label);
  });
  const working = el('p.pic-hint', { 'aria-live': 'polite' });
  let modal;
  const submit = async e => {
    e.preventDefault();
    const ppi = Number(e.target.querySelector(`input[name="${name}"]:checked`)?.value || 150);
    working.textContent = 'Compressing…';
    for (const button of e.target.querySelectorAll('button')) button.disabled = true;
    try { await onApply({ ppi, deleteCropped: crop.checked, selectedOnly: only.checked }); } finally { modal.close(); }
  };
  modal = openModal({ title: 'Compress Pictures', content: el('form.pic-dialog', { onsubmit: submit },
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Compression options'),
      el('label.pic-check', { htmlFor: only.id }, only, 'Apply only to this picture'),
      el('label.pic-check', { htmlFor: crop.id }, crop, 'Delete cropped areas of pictures')),
    el('fieldset.pic-fieldset', {}, el('legend', {}, 'Resolution'), el('div.pic-radios', { role: 'radiogroup', 'aria-label': 'Resolution' }, ...choices)),
    el('p.pic-hint', {}, 'Pictures are resampled for the size they are shown at. Compressing removes the original pictures kept for Reset Picture.'),
    working,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
  queueMicrotask(() => modal.panel?.querySelector('input:checked')?.focus());
  return modal;
}

/** Grid settings for aligning objects: spacing of the gridlines and whether objects snap to them. */
export function openGridDialog({ value = 0.125, snap = false, onApply }) {
  const size = el('input.input.pic-number', { type: 'number', min: 0.01, max: 2, step: 0.01, value, id: 'pic-grid-size', required: true });
  const snapBox = el('input', { type: 'checkbox', checked: snap, id: 'pic-grid-snap' });
  let modal;
  modal = openModal({ title: 'Grid Settings', content: el('form.pic-dialog', { onsubmit: e => { e.preventDefault(); if (!size.checkValidity()) { size.reportValidity(); return; } onApply({ size: Number(size.value), snap: snapBox.checked }); modal.close(); } },
    el('label.pic-field', { htmlFor: size.id }, el('span', {}, 'Grid spacing (in)'), size),
    el('label.pic-check', { htmlFor: snapBox.id }, snapBox, 'Snap objects to the grid while moving them'),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
  queueMicrotask(() => size.focus());
  return modal;
}
