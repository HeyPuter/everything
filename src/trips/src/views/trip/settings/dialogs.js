// Trip dialogs: create/edit form, copy, delete and leave confirmations.
import './settings.css';
import { el, uid } from '../../../ui/dom.js';
import { button, chip, spinner } from '../../../ui/bits.js';
import { checkbox, field, segmented } from '../../../ui/fields.js';
import { dateField } from '../../../ui/dates.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale, localeRegion, prefs } from '../../../lib/prefs.js';
import { addDays, daysBetween, isDate } from '../../../shared/dates.js';
import { isCurrency } from '../../../shared/money.js';
import { newId } from '../../../shared/ids.js';
import { DomainError } from '../../../shared/errors.js';
import { COPY_GROUPS } from './copy.js';
import { coverURL, pickCover } from './cover.js';
import { uploadCover, errorKey as fileErrorKey } from '../../../lib/files/index.js';
import { confirmRedate, datesChanged } from './redate.js';
import { copyTrip, createTrip, currencyOps, errorKey } from './actions.js';
import { DEFAULT_DAYS, MAX_DAYS, isDated, reminderLabel } from './meta.js';

const REMINDERS = [0, 1, 2, 3, 7, 14, 30];
const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', JP: 'JPY', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', IN: 'INR', CN: 'CNY', BR: 'BRL', MX: 'MXN', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', KR: 'KRW', ZA: 'ZAR', SG: 'SGD', HK: 'HKD', TR: 'TRY', IL: 'ILS', AE: 'AED', TH: 'THB',
};
let currencyList;
function currencies() {
  if (!currencyList) {
    const names = new Intl.DisplayNames([displayLocale()], { type: 'currency' });
    currencyList = Intl.supportedValuesOf('currency').filter(isCurrency).map((code) => ({ value: code, label: `${code} · ${names.of(code) ?? code}` }));
  }
  return currencyList;
}
export function defaultCurrency() {
  const preferred = prefs().currency;
  if (isCurrency(preferred)) return preferred;
  return REGION_CURRENCY[localeRegion(displayLocale())] ?? 'EUR';
}
const STAGES = { preparing: 'trip.deployPreparing', creating: 'trip.deployCreating', updating: 'trip.deployUpdating', starting: 'trip.deployStarting' };

/** A tag editor: Enter or comma adds, duplicates are ignored without regard to case. */
function tagInput(initial = []) {
  let tags = [...initial];
  const list = el('div.tag-list', { role: 'list' });
  const input = field({ label: t('trip.tags'), hint: t('trip.tagsHint'), autocomplete: 'off', maxLength: 100 });
  function draw() {
    list.replaceChildren(...tags.map((tag) => el('span', { role: 'listitem' }, chip(tag, { onRemove: () => { tags = tags.filter((item) => item !== tag); draw(); input.input.focus(); } }))));
    list.hidden = !tags.length;
  }
  function commit() {
    const value = input.input.value.replace(/,/g, ' ').trim();
    if (value && !tags.some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase()) && tags.length < 100) tags = [...tags, value.slice(0, 100)];
    input.input.value = ''; draw();
  }
  input.input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(); }
    else if (event.key === 'Backspace' && !input.input.value && tags.length) { tags = tags.slice(0, -1); draw(); }
  });
  input.input.addEventListener('blur', commit);
  draw();
  return { element: el('div.tag-input', {}, input.element, list), value: () => { commit(); return tags; } };
}

/** Cover preview with a picker; `value()` is `{keep}`, `{value}`, `{file}` or `{remove}`. */
function coverInput({ session, puter, ref, initial, query }) {
  let state = { keep: true };
  let objectURL = null;
  const preview = el('div.cover-preview');
  const credit = el('p.field-hint');
  async function draw() {
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
    let src = null; let text = '';
    if (state.file) { objectURL = URL.createObjectURL(state.file); src = objectURL; }
    else if (state.value) { src = await coverURL(state.value, { session, puter, ref }); text = state.value.credit ?? ''; }
    else if (state.keep && initial) { src = await coverURL(initial, { session, puter, ref }); text = initial.credit ?? ''; }
    preview.replaceChildren(src ? el('img', { src, alt: '', referrerPolicy: 'no-referrer' }) : el('span.cover-empty', {}, t('trip.coverNone')));
    credit.textContent = text ? t('trip.coverCredit', { credit: text }) : '';
    remove.hidden = !(state.file || state.value || (state.keep && initial));
  }
  const choose = button(t('trip.coverChange'), { size: 'sm', onclick: async () => {
    const picked = await pickCover({ session, puter, query: query(), current: state.file || state.value || (state.keep && initial) });
    if (!picked) return;
    state = picked.remove ? { remove: true } : picked; void draw();
  } });
  const remove = button(t('trip.coverRemove'), { size: 'sm', variant: 'ghost', onclick: () => { state = { remove: true }; void draw(); } });
  void draw();
  return {
    element: el('div.field', {}, el('span.field-label', {}, t('trip.cover')), preview, credit, el('div.cover-actions', {}, choose, remove)),
    value: () => state,
    destroy: () => { if (objectURL) URL.revokeObjectURL(objectURL); },
  };
}

function progressLine() {
  const node = el('div.trip-progress', { role: 'status', hidden: true });
  return {
    node,
    set(key) { node.hidden = !key; node.replaceChildren(...(key ? [spinner(), el('span', {}, t(key))] : [])); },
  };
}

/**
 * Create (`space` omitted) or edit a trip. Resolves true when saved. `onCreated(ref)` runs after a create.
 * Editing needs an open space; dates go through `trip.redate` with an impact preview.
 */
export function openTripForm({ session, puter, space = null, onCreated, signal }) {
  const meta = space?.get('meta', 'meta') ?? null;
  const editing = Boolean(space);
  if (editing && !meta) return Promise.reject(new DomainError('trip_unavailable', 404));
  const ref = space?.ref ?? null;
  const formId = uid('trip-form');
  const title = field({ label: t('trip.title'), value: meta?.title ?? '', required: true, maxLength: 500, autocomplete: 'off' });
  const description = field({ label: t('trip.description'), type: 'textarea', value: meta?.description ?? '', hint: t('trip.markdownHint'), rows: 3, maxLength: 100_000 });
  const mode = segmented({ label: t('trip.datesMode'), value: !meta || isDated(meta) ? 'dated' : 'days', onChange: () => syncMode(),
    items: [{ value: 'dated', label: t('trip.withDates'), icon: 'calendar' }, { value: 'days', label: t('trip.withDays'), icon: 'clock' }] });
  const start = dateField({ label: t('trip.start'), value: isDated(meta) ? meta.start : '' });
  const end = dateField({ label: t('trip.end'), value: isDated(meta) ? meta.end : '' });
  const dayCount = field({ label: t('trip.dayCount'), type: 'number', min: 1, max: MAX_DAYS, step: 1, inputMode: 'numeric', value: String(meta?.dayCount ?? DEFAULT_DAYS) });
  const roughStart = dateField({ label: t('trip.roughStart'), hint: t('trip.roughStartHint'), value: !isDated(meta) ? meta?.start ?? meta?.end ?? '' : '' });
  const datedRow = el('div.field-row', {}, start.element, end.element);
  const daysRow = el('div.field-row', {}, dayCount.element, roughStart.element);
  let previousStart = start.input.value;
  start.input.addEventListener('change', () => {
    // Moving the start keeps the trip's length.
    const next = start.input.value;
    if (isDate(previousStart) && isDate(next) && isDate(end.input.value) && end.input.value >= previousStart) end.input.value = addDays(next, daysBetween(previousStart, end.input.value));
    else if (isDate(next) && (!isDate(end.input.value) || end.input.value < next)) end.input.value = next;
    previousStart = next; validateDates();
  });
  end.input.addEventListener('change', validateDates);
  function syncMode() { datedRow.hidden = mode.value !== 'dated'; daysRow.hidden = mode.value === 'dated'; }
  function validateDates() {
    end.setError(''); start.setError(''); dayCount.setError('');
    if (mode.value === 'dated') {
      if (!isDate(start.input.value)) { start.setError(t('trip.startRequired')); return false; }
      if (!isDate(end.input.value)) { end.setError(t('trip.endRequired')); return false; }
      const span = daysBetween(start.input.value, end.input.value);
      if (span < 0) { end.setError(t('trip.endBeforeStart')); return false; }
      if (span >= MAX_DAYS) { end.setError(t('trip.tooLong', { max: MAX_DAYS })); return false; }
      return true;
    }
    const count = Number(dayCount.input.value);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DAYS) { dayCount.setError(t('trip.dayCountInvalid', { max: MAX_DAYS })); return false; }
    return true;
  }
  const currency = field({ label: t('trip.currency'), type: 'select', options: currencies(), value: meta?.currency ?? defaultCurrency() });
  const currencyHint = el('p.field-hint', { hidden: true }, t('trip.currencyRebase'));
  currency.input.addEventListener('change', () => { currencyHint.hidden = !editing || currency.input.value === meta?.currency || !(space.query('exp').length || space.query('settle').length); });
  const tags = tagInput(meta?.tags ?? []);
  const reminders = new Set(meta?.reminderDays ?? []);
  const reminderGroup = el('fieldset.reminder-days', {}, el('legend.field-label', {}, t('trip.reminders')),
    el('div.reminder-options', {}, REMINDERS.map((days) => checkbox(reminderLabel(days), {
      checked: reminders.has(days), onChange: (checked) => { if (checked) reminders.add(days); else reminders.delete(days); },
    }))), el('p.field-hint', {}, t('trip.remindersHint')));
  const cover = coverInput({ session, puter, ref, initial: meta?.cover ?? null, query: () => title.input.value.trim() });
  const progress = progressLine();
  const alert = el('p.field-error', { role: 'alert', hidden: true });
  const submit = button(t(editing ? 'ui.save' : 'trip.create'), { type: 'submit', variant: 'primary', form: formId });
  let sid = newId();
  let saved = false;

  function target() {
    if (mode.value === 'dated') return { start: start.input.value, end: end.input.value };
    return { start: isDate(roughStart.input.value) ? roughStart.input.value : null, end: null, dayCount: Number(dayCount.input.value) };
  }
  function fail(error) {
    progress.set(null);
    alert.hidden = false; alert.textContent = t(errorKey(error));
    submit.setAttribute('aria-busy', 'false'); submit.textContent = t(editing ? 'ui.save' : 'trip.retryCreate');
  }
  // Sets `meta.cover` itself (files module).
  async function applyCover(target, state) {
    if (!state.file) return;
    progress.set('trip.coverUploading');
    try { await uploadCover(target, state.file); } catch (error) { toast(t(fileErrorKey(error))); }
  }
  async function save() {
    alert.hidden = true;
    const name = title.input.value.trim();
    if (!name) { title.setError(t('trip.titleRequired')); title.input.focus(); return; }
    title.setError('');
    if (!validateDates()) return;
    submit.setAttribute('aria-busy', 'true');
    const coverState = cover.value();
    const fields = {
      title: name, description: description.input.value, currency: currency.input.value, tags: tags.value(),
      reminderDays: [...reminders].sort((a, b) => a - b), ...target(),
      ...(coverState.value ? { cover: coverState.value } : {}),
    };
    try {
      if (!editing) {
        progress.set('trip.creating');
        const created = await createTrip(session, fields, { space: sid, onProgress: (stage) => progress.set(STAGES[stage] ?? 'trip.creating') });
        sid = newId();
        if (coverState.file) await applyCover(await session.openTrip(created).ready, coverState);
        saved = true; dialog.close('saved'); onCreated?.(created);
        return;
      }
      const current = space.get('meta', 'meta');
      if (datesChanged(current, target())) {
        const applied = await confirmRedate(space, target());
        if (!applied) { submit.setAttribute('aria-busy', 'false'); return; }
      }
      const set = {}; const unset = [];
      if (name !== current.title) set.title = name;
      if (fields.description !== (current.description ?? '')) { if (fields.description) set.description = fields.description; else unset.push('description'); }
      for (const key of ['tags', 'reminderDays']) {
        if (JSON.stringify(fields[key]) === JSON.stringify(current[key] ?? [])) continue;
        if (fields[key].length) set[key] = fields[key]; else unset.push(key);
      }
      if (coverState.value) set.cover = coverState.value;
      if (coverState.remove && current.cover) unset.push('cover');
      let extra = { ops: [], privatePatches: [] };
      if (fields.currency !== current.currency) {
        progress.set('trip.currencyLoading');
        extra = await currencyOps(space, session.services, current.currency, fields.currency);
        set.currency = fields.currency;
      }
      const ops = [...(Object.keys(set).length || unset.length ? [space.ops.patch('meta', 'meta', { set, unset })] : []), ...extra.ops];
      if (ops.length) await space.apply(ops);
      for (const patch of extra.privatePatches) await space.privateItems('exp').patch(patch.id, { rate: patch.rate }).catch(() => {});
      await applyCover(space, coverState);
      saved = true; dialog.close('saved');
    } catch (error) { fail(error); }
  }
  const form = el('form.trip-form', { id: formId, novalidate: true, onsubmit: (event) => { event.preventDefault(); void save(); } },
    title.element, el('div.field', {}, el('span.field-label', {}, t('trip.dates')), mode.element), datedRow, daysRow,
    currency.element, currencyHint, cover.element, description.element, tags.element, reminderGroup);
  syncMode();
  const dialog = openModal({
    title: t(editing ? 'trip.editTitle' : 'trip.newTitle'), wide: true, content: form,
    actions: [alert, progress.node, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), submit], initialFocus: title.input,
    onClose: () => cover.destroy(),
  });
  signal?.addEventListener('abort', () => dialog.close('navigation'), { once: true });
  return dialog.closed.then(() => saved);
}

/** Copy with a choice of what to bring along. Resolves the new trip's ref, or null. */
export function openCopyDialog({ session, ref, meta, onCopied, signal }) {
  const formId = uid('copy-form');
  const title = field({ label: t('trip.copyName'), value: t('trip.copyOf', { title: meta?.title ?? '' }).slice(0, 500), required: true, maxLength: 500 });
  const start = dateField({ label: t('trip.copyStart'), hint: t('trip.copyStartHint'), value: isDate(meta?.start) ? meta.start : '' });
  const chosen = new Set(['days', 'places', 'bookings', 'packing', 'todos']);
  const groups = el('fieldset.copy-groups', {}, el('legend.field-label', {}, t('trip.copyWhat')),
    COPY_GROUPS.map((group) => checkbox(t(`trip.copy_${group}`), { checked: chosen.has(group), onChange: (checked) => { if (checked) chosen.add(group); else chosen.delete(group); } })),
    el('p.field-hint', {}, t('trip.copyHint')));
  const progress = progressLine();
  const alert = el('p.field-error', { role: 'alert', hidden: true });
  const submit = button(t('trip.copyAction'), { type: 'submit', variant: 'primary', form: formId });
  let sid = newId();
  let result = null;
  const form = el('form.trip-form', { id: formId, novalidate: true, onsubmit: async (event) => {
    event.preventDefault();
    const name = title.input.value.trim();
    if (!name) { title.setError(t('trip.titleRequired')); return; }
    title.setError(''); alert.hidden = true; submit.setAttribute('aria-busy', 'true'); progress.set('trip.copying');
    try {
      result = await copyTrip(session, ref, { title: name, start: isDate(start.input.value) ? start.input.value : null, groups: [...chosen] },
        { space: sid, onProgress: (stage) => progress.set(STAGES[stage] ?? 'trip.copying') });
      sid = newId();
      dialog.close('copied'); onCopied?.(result);
    } catch (error) {
      progress.set(null); submit.setAttribute('aria-busy', 'false');
      alert.hidden = false; alert.textContent = t(errorKey(error));
    }
  } }, title.element, isDate(meta?.start) ? start.element : null, groups);
  const dialog = openModal({ title: t('trip.copyTitle'), content: form,
    actions: [alert, progress.node, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), submit], initialFocus: title.input });
  signal?.addEventListener('abort', () => dialog.close('navigation'), { once: true });
  return dialog.closed.then(() => result);
}

export function confirmDelete(meta) {
  return confirmDialog({ title: t('trip.deleteTitle', { title: meta?.title || t('trip.untitled') }), body: t('trip.deleteBody'), confirmLabel: t('trip.delete'), danger: true });
}
export function confirmLeave(meta) {
  return confirmDialog({ title: t('trip.leaveTitle', { title: meta?.title || t('trip.untitled') }), body: t('trip.leaveBody'), confirmLabel: t('trip.leave'), danger: true });
}
