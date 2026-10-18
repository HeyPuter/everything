import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { placeSheet } from '../core/sheet-placement.js';

export function openMoveSheetDialog(ctx, id) {
  const { wb } = ctx;
  const source = wb.sheet(id);
  if (!source || source.hidden || source.externalCache) return null;
  if (ctx.grid?.editing && !ctx.grid.commitEdit()) return null;

  const book = el('select.select', { 'aria-label': 'To workbook' }, el('option', { value: 'current' }, ctx.doc?.name || 'This spreadsheet'));
  const destinations = el('select.input.sheet-destinations', { 'aria-label': 'Before sheet', size: 8 });
  const copy = el('input', { type: 'checkbox' });
  const name = el('span', { dir: 'auto' }, source.name);
  const { alert: error, refuse, clear } = fieldAlert('move-sheet');
  const submitButton = el('button.btn.btn-primary', { type: 'submit' }, 'Move');
  let busy = false;

  function sync() {
    const sheet = wb.sheet(id);
    const available = sheet && !sheet.hidden && !sheet.externalCache;
    name.textContent = sheet?.name || source.name;
    submitButton.textContent = copy.checked ? 'Copy' : 'Move';
    submitButton.disabled = busy || !available || destinations.selectedIndex < 0;
    if (!available) refuse(null, 'This sheet is no longer available. Close the dialog and select a sheet.');
  }

  function refresh(initial = false) {
    if (busy) return;
    const selected = initial ? id : destinations.value;
    destinations.replaceChildren(...wb.visibleSheets.map(sheet => el('option', { value: sheet.id }, sheet.name)),
      el('option', { value: '' }, 'End of workbook'));
    destinations.value = selected;
    clear();
    if (destinations.selectedIndex < 0) refuse(null, 'Choose another destination; the selected sheet is no longer available.');
    sync();
  }

  const changed = e => { if (e.detail?.type === 'structure' || e.detail?.type === 'load') refresh(); };
  destinations.addEventListener('change', () => { clear(); sync(); });
  copy.addEventListener('change', sync);

  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    if (destinations.selectedIndex < 0) { refuse(destinations, 'Choose a destination'); return; }
    if (ctx.grid?.editing && !ctx.grid.commitEdit()) return;
    busy = true;
    sync();
    try {
      const options = { id, before: destinations.value || null, copy: copy.checked };
      const result = ctx.run ? await ctx.run('placeSheet', options) : placeSheet(wb, id, options);
      if (result) modal.close();
      else { busy = false; refresh(); refuse(null, 'The sheet or destination changed. Check your selection and try again.'); }
    } catch (err) {
      console.error(err);
      refuse(null, 'Could not move or copy this sheet. Check your selection and try again.');
    } finally {
      busy = false;
      sync();
    }
  };

  const content = el('form', { onsubmit: submit },
    el('p.field-hint', {}, 'Sheet: ', name),
    el('label.field', {}, el('span.field-label', {}, 'To workbook'), book),
    el('label.field', {}, el('span.field-label', {}, 'Before sheet'), destinations),
    el('label.check', {}, copy, el('span', {}, 'Create a copy')),
    error,
    ctx.run && el('div.row', {}, el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { modal.close(); ctx.run('copySheetTo', id); } }, 'Copy to another spreadsheet…')),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submitButton));
  const modal = openModal({ title: 'Move or Copy', className: 'move-sheet', content, initialFocus: destinations,
    onClose: () => { wb.removeEventListener('change', changed); ctx.grid?.focus(); } });
  wb.addEventListener('change', changed);
  refresh(true);
  return modal;
}
