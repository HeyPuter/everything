import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { placeSheet } from '../core/sheet-placement.js';
import { t, tRich } from '../i18n/index.js';

export function openMoveSheetDialog(ctx, id) {
  const { wb } = ctx;
  const source = wb.sheet(id);
  if (!source || source.hidden || source.externalCache) return null;
  if (ctx.grid?.editing && !ctx.grid.commitEdit()) return null;

  const book = el('select.select', { 'aria-label': t('movesheet.toWorkbook') }, el('option', { value: 'current' }, ctx.doc?.name || t('movesheet.thisSpreadsheet')));
  const destinations = el('select.input.sheet-destinations', { 'aria-label': t('movesheet.beforeSheet'), size: 8 });
  const copy = el('input', { type: 'checkbox' });
  const name = el('span', { dir: 'auto' }, source.name);
  const { alert: error, refuse, clear } = fieldAlert('move-sheet');
  const submitButton = el('button.btn.btn-primary', { type: 'submit' }, t('movesheet.move'));
  let busy = false;

  function sync() {
    const sheet = wb.sheet(id);
    const available = sheet && !sheet.hidden && !sheet.externalCache;
    name.textContent = sheet?.name || source.name;
    submitButton.textContent = copy.checked ? t('common.copy') : t('movesheet.move');
    submitButton.disabled = busy || !available || destinations.selectedIndex < 0;
    if (!available) refuse(null, t('movesheet.unavailable'));
  }

  function refresh(initial = false) {
    if (busy) return;
    const selected = initial ? id : destinations.value;
    destinations.replaceChildren(...wb.visibleSheets.map(sheet => el('option', { value: sheet.id }, sheet.name)),
      el('option', { value: '' }, t('movesheet.end')));
    destinations.value = selected;
    clear();
    if (destinations.selectedIndex < 0) refuse(null, t('movesheet.destinationGone'));
    sync();
  }

  const changed = e => { if (e.detail?.type === 'structure' || e.detail?.type === 'load') refresh(); };
  destinations.addEventListener('change', () => { clear(); sync(); });
  copy.addEventListener('change', sync);

  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    if (destinations.selectedIndex < 0) { refuse(destinations, t('movesheet.chooseDestination')); return; }
    if (wb.structureProtected) { refuse(null, t('movesheet.protected')); return; }
    if (ctx.grid?.editing && !ctx.grid.commitEdit()) return;
    busy = true;
    sync();
    try {
      const options = { id, before: destinations.value || null, copy: copy.checked };
      const result = ctx.run ? await ctx.run('placeSheet', options) : placeSheet(wb, id, options);
      if (result) modal.close();
      else { busy = false; refresh(); refuse(null, t('movesheet.changed')); }
    } catch (err) {
      console.error(err);
      refuse(null, t('movesheet.failed'));
    } finally {
      busy = false;
      sync();
    }
  };

  const content = el('form', { onsubmit: submit },
    el('p.field-hint', {}, ...tRich('movesheet.sheet', { name })),
    el('label.field', {}, el('span.field-label', {}, t('movesheet.toWorkbook')), book),
    el('label.field', {}, el('span.field-label', {}, t('movesheet.beforeSheet')), destinations),
    el('label.check', {}, copy, el('span', {}, t('movesheet.createCopy'))),
    error,
    ctx.run && el('div.row', {}, el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { modal.close(); ctx.run('copySheetTo', id); } }, t('movesheet.copyToAnother'))),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), submitButton));
  const modal = openModal({ title: t('movesheet.title'), className: 'move-sheet', content, initialFocus: destinations,
    onClose: () => { wb.removeEventListener('change', changed); ctx.grid?.focus(); } });
  wb.addEventListener('change', changed);
  refresh(true);
  return modal;
}
