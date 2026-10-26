// "Save to collection" from a trip: one place, a selection or the whole trip, with a preview before saving.
import './collections.css';
import { el, uid as uniqueId } from '../../ui/dom.js';
import { button, spinner } from '../../ui/bits.js';
import { checkbox, field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { spaceRoute } from '../../shared/protocol.js';
import { newId } from '../../shared/ids.js';
import { isBuiltin } from '../../lib/categories.js';
import { STATUSES, appendOrders, fromPlace, samePlace } from './model.js';
import { createCollection, errorText, uidOf, withSpace } from './spaces.js';
import { writableCollections } from './transfer.js';

const NEW = '__new';
const KEEP = '__keep';

/**
 * `context` is the trip tab context (session, account, app); `space` the open trip. Saves the places in `placeIds`,
 * or every place in the trip when it is omitted. Resolves when the dialog closes.
 */
export async function openSaveToCollection(context, { space, placeIds = null }) {
  const me = uidOf(context);
  const places = (placeIds ? placeIds.map((id) => space.get('place', id)) : [...space.select.place.all()]).filter(Boolean);
  if (!places.length || !context.session?.api) { toast(t(context.session?.api ? 'collections.saveNothing' : 'collections.unavailable')); return; }
  const chosen = new Set(places.map((place) => place.id));
  let targets = [];
  let existing = [];
  let loadSeq = 0;

  const targetSelect = field({ label: t('collections.saveTarget'), type: 'select', options: [{ value: '', label: t('collections.loading') }], disabled: true });
  const newName = field({ label: t('collections.fieldName'), maxLength: 200, autocomplete: 'off', value: space.get('meta', 'meta')?.title ?? '' });
  newName.element.hidden = true;
  const statusSelect = field({ label: t('collections.saveStatus'), type: 'select', value: KEEP, options: [
    { value: KEEP, label: t('collections.saveStatusAuto') }, ...STATUSES.map((value) => ({ value, label: t(`collections.status.${value}`) })),
  ] });
  const previewId = uniqueId('col-preview');
  const summary = el('p.col-hint', { role: 'status' });
  const preview = el('ul.col-preview', { 'aria-labelledby': previewId });
  const alert = el('p.col-alert', { role: 'alert', hidden: true });
  const submit = button(t('collections.save'), { type: 'submit', variant: 'primary', disabled: true });
  const duplicate = (place) => existing.some((item) => samePlace(item, place));

  function renderPreview() {
    const all = places.length > 1 && checkbox(t('collections.selectAll'), { checked: places.every((place) => chosen.has(place.id)), onChange: (checked) => {
      for (const place of places) { if (checked) chosen.add(place.id); else chosen.delete(place.id); }
      renderPreview();
    } });
    preview.replaceChildren(...places.map((place) => el('li.col-preview-row', {},
      checkbox(place.name, { checked: chosen.has(place.id), onChange: (checked) => { if (checked) chosen.add(place.id); else chosen.delete(place.id); renderPreview(); } }),
      duplicate(place) && el('span.chip', {}, t('collections.alreadySaved')))));
    if (all) preview.prepend(el('li.col-preview-row.col-preview-all', {}, all));
    const picked = places.filter((place) => chosen.has(place.id));
    const fresh = picked.filter((place) => !duplicate(place));
    summary.textContent = picked.length - fresh.length
      ? t('collections.saveSummaryDupes', { count: formatNumber(fresh.length), dupes: formatNumber(picked.length - fresh.length) })
      : t('collections.saveSummary', { count: formatNumber(fresh.length) });
    submit.disabled = !fresh.length || !targetSelect.input.value;
  }
  async function loadTarget() {
    const value = targetSelect.input.value;
    newName.element.hidden = value !== NEW;
    existing = [];
    const seq = ++loadSeq;
    const target = targets.find((entry) => entry.ref.s === value);
    if (target) {
      summary.replaceChildren(spinner(), t('collections.loading'));
      try {
        const { value: items } = await withSpace(context, target.ref, (dest) => dest.select.saved.all().map((item) => ({ name: item.name, lat: item.lat, lng: item.lng, address: item.address, ids: item.ids })));
        if (seq === loadSeq) existing = items;
      } catch { /* duplicates are rechecked on save */ }
    }
    if (seq === loadSeq) renderPreview();
  }
  targetSelect.input.addEventListener('change', () => void loadTarget());

  async function save() {
    alert.hidden = true;
    let target = targets.find((entry) => entry.ref.s === targetSelect.input.value);
    const picked = places.filter((place) => chosen.has(place.id));
    if (!picked.length) return;
    submit.setAttribute('aria-busy', 'true');
    try {
      if (targetSelect.input.value === NEW) {
        const name = newName.input.value.replace(/\s+/g, ' ').trim();
        if (!name) { newName.setError(t('collections.nameRequired')); newName.input.focus(); return; }
        const ref = await createCollection(context, { name, icon: 'bookmark' }, { space: newId() });
        target = { ref, title: name, role: 'owner' };
      }
      const status = statusSelect.input.value === KEEP ? undefined : statusSelect.input.value;
      const { value, flush } = await withSpace(context, target.ref, async (dest) => {
        if (!dest.can('plan.edit')) throw Object.assign(new Error('forbidden'), { code: 'forbidden', status: 403 });
        const current = dest.select.saved.all();
        const fresh = picked.filter((place) => !current.some((item) => samePlace(item, place)));
        const orders = appendOrders(current, fresh.length);
        const ops = fresh.map((place, index) => dest.ops.create('saved', fromPlace(place, { uid: me, trip: space.ref, order: orders[index], status, builtin: isBuiltin })));
        if (ops.length) await dest.apply(ops);
        return fresh.length;
      }, { pull: true });
      if (flush?.status === 'rejected') throw Object.assign(new Error('forbidden'), { code: 'forbidden', status: 403 });
      dialog.close('saved');
      const message = t(flush?.status === 'queued' ? 'collections.savedQueued' : 'collections.savedTo', { count: formatNumber(value), name: target.title || t('collections.untitled') });
      toast(message, { action: context.app ? { label: t('collections.open'), onClick: () => context.app.navigate(`${spaceRoute(target.ref)}/places`) } : undefined });
    } catch (error) {
      alert.textContent = errorText(error); alert.hidden = false;
    } finally { submit.setAttribute('aria-busy', 'false'); }
  }

  const form = el('form.col-form', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void save(); } },
    el('div.field-row', {}, targetSelect.element, statusSelect.element), newName.element,
    el('h3.col-subhead', { id: previewId }, t(places.length === 1 ? 'collections.savePreviewOne' : 'collections.savePreview')), preview, summary, alert,
    el('div.modal-actions', {}, button(t('collections.cancel'), { onclick: () => dialog.close('cancel') }), submit));
  const dialog = openModal({ title: t(places.length === 1 ? 'collections.saveTitleOne' : 'collections.saveTitle', { name: places[0].name, count: formatNumber(places.length) }), content: form, wide: places.length > 1 });
  renderPreview();
  try {
    targets = await writableCollections(context);
    targetSelect.input.replaceChildren(
      ...targets.map((entry) => el('option', { value: entry.ref.s }, entry.title || t('collections.untitled'))),
      el('option', { value: NEW }, t('collections.newCollectionOption')));
    targetSelect.input.disabled = false;
    targetSelect.input.value = targets[0]?.ref.s ?? NEW;
    await loadTarget();
  } catch (error) { alert.textContent = errorText(error); alert.hidden = false; }
  return dialog.closed;
}
