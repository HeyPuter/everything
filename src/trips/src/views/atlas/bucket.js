// Bucket list: the side-panel list and the add/edit dialog.
import { el, uid } from '../../ui/dom.js';
import { button, emptyState } from '../../ui/bits.js';
import { checkbox, field } from '../../ui/fields.js';
import { confirmDialog, openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../lib/format.js';
import { displayLocale } from '../../lib/prefs.js';
import { BUCKET_LIMITS, validateBucketItem } from '../../lib/atlas/bucket.js';
import { localToday } from '../../lib/atlas/aggregate.js';
import { COUNTRY_CODES } from '../../lib/atlas/countries.js';
import { dedupeResults } from '../../services/geocode.js';
import { parseCoordinates } from '../trip/places/parse.js';
import { icon } from './icons.js';
import { nameOf } from './text.js';

const MAX_RESULTS = 6;

/** Display name: the item's name, else its country's. */
export const bucketName = (entry) => entry.name || (entry.cc ? nameOf(entry.cc) : '');

/** Error message for a failed bucket-list write. */
export function bucketError(error) {
  if (globalThis.navigator?.onLine === false || error?.status === 0) return t('atlas.error.offline');
  if (error?.status === 402) return t('atlas.error.credit');
  if (error?.status === 401 || error?.status === 403) return t('atlas.error.forbidden');
  if (error?.code === 'bucket_full') return t('atlas.bucket.full', { count: formatNumber(BUCKET_LIMITS.items) });
  if (error?.code === 'gone' || error?.status === 404) return t('atlas.bucket.gone');
  return t('atlas.error.failed');
}

function subline(entry, country) {
  const parts = [];
  if (entry.name && country) parts.push(nameOf(country));
  else if (!entry.name) parts.push(t('atlas.bucket.wholeCountry'));
  if (entry.visitedAt) parts.push(t('atlas.bucket.visitedOn', { date: formatDate(entry.visitedAt) }));
  else if (entry.target) parts.push(t('atlas.bucket.by', { date: formatDate(entry.target) }));
  return parts.join(' · ');
}

/** One bucket-list row: open the item, and a visited toggle. */
export function bucketRow(entry, { country, busy, onOpen, onToggle }) {
  const name = bucketName(entry);
  return el('li.atlas-bucket-row', {},
    el('button.atlas-row', { type: 'button', dataset: { focus: `bucket:${entry.id}` }, onclick: () => onOpen(entry.id) },
      el('span.atlas-row-text', {}, el('span.atlas-row-name', {}, name), el('span.atlas-row-sub', {}, subline(entry, country)))),
    button(t('atlas.bucket.toggle'), { size: 'sm', variant: entry.visitedAt ? 'outline' : 'ghost', busy, 'aria-pressed': String(Boolean(entry.visitedAt)),
      'aria-label': t('atlas.bucket.toggleLabel', { name }), dataset: { focus: `bucket-done:${entry.id}` }, onclick: () => onToggle(entry.id, !entry.visitedAt) }));
}

/** The bucket-list view: wishes, then visited items. `countries` maps an item id to its country. */
export function bucketView({ entries, countries, busy, onAdd, onOpen, onToggle }) {
  const add = button(t('atlas.bucket.add'), { icon: 'plus', size: 'sm', variant: 'primary', 'aria-label': t('atlas.bucket.addLabel'), dataset: { focus: 'bucket-add' }, onclick: () => onAdd() });
  const head = el('div.atlas-bucket-head', {}, el('h2.atlas-view-title', {}, t('atlas.bucket.heading')), add);
  if (!entries.length) return [head, emptyState({ title: t('atlas.bucket.emptyTitle'), body: t('atlas.bucket.emptyBody'), icon: 'heart' })];
  const wishes = entries.filter((entry) => !entry.visitedAt);
  const done = entries.filter((entry) => entry.visitedAt);
  const list = (items) => el('ul.atlas-list', {}, items.map((entry) => bucketRow(entry, { country: countries.get(entry.id) ?? null, busy, onOpen, onToggle })));
  const section = (title, items) => el('section.atlas-section', {}, el('h3', {}, el('span', {}, title), el('span.atlas-count', {}, formatNumber(items.length))), list(items));
  return [head, wishes.length ? section(t('atlas.bucket.wishes'), wishes) : null, done.length ? section(t('atlas.bucket.done'), done) : null].filter(Boolean);
}

function countryOptions() {
  return [{ value: '', label: t('atlas.bucket.noCountry') },
    ...COUNTRY_CODES.map((code) => ({ value: code, label: nameOf(code) })).sort((a, b) => a.label.localeCompare(b.label, locale))];
}
const coordText = (lat, lng) => `${Number(lat.toFixed(6))}, ${Number(lng.toFixed(6))}`;

/**
 * Add or edit dialog. `item` is a full item (with `id` when editing) or defaults such as `{cc}`. `locatePlace(lat, lng)`
 * fills the country from coordinates; `geocode` (optional) searches places. Resolves when the dialog closes.
 */
export function openBucketDialog({ item = {}, store, geocode = null, locatePlace = null, online = () => globalThis.navigator?.onLine !== false }) {
  const editing = Boolean(item.id);
  const name = field({ label: t('atlas.bucket.name'), hint: t('atlas.bucket.nameHint'), value: item.name ?? '', maxLength: BUCKET_LIMITS.name, autocomplete: 'off' });
  const coords = field({ label: t('atlas.bucket.coordinates'), hint: t('atlas.bucket.coordinatesHint'), value: Number.isFinite(item.lat) ? coordText(item.lat, item.lng) : '', inputMode: 'decimal', autocomplete: 'off', spellcheck: false });
  const country = field({ label: t('atlas.bucket.country'), type: 'select', options: countryOptions(), value: item.cc ?? '' });
  const target = field({ label: t('atlas.bucket.target'), type: 'date', value: item.target ?? '' });
  const notes = field({ label: t('atlas.bucket.notes'), type: 'textarea', value: item.notes ?? '', maxLength: BUCKET_LIMITS.notes, rows: 3 });
  const visitedDate = field({ label: t('atlas.bucket.visitedDate'), type: 'date', value: item.visitedAt ?? localToday(), max: localToday() });
  visitedDate.element.hidden = !item.visitedAt;
  const visited = checkbox(t('atlas.bucket.visited'), { checked: Boolean(item.visitedAt), onChange: (on) => { visitedDate.element.hidden = !on; if (on && !visitedDate.input.value) visitedDate.input.value = localToday(); } });
  const status = el('p.atlas-hint', { role: 'status' });
  let countryTouched = Boolean(item.cc);
  country.input.addEventListener('change', () => { countryTouched = true; });

  let lookup = 0;
  async function fillCountry(lat, lng) {
    if (countryTouched || !locatePlace) return;
    const run = ++lookup;
    const found = await locatePlace(lat, lng).catch(() => null);
    if (run === lookup && !countryTouched && found?.cc) country.input.value = found.cc;
  }
  function readCoords() {
    const text = coords.input.value.trim();
    if (!text) return { lat: undefined, lng: undefined };
    const parsed = parseCoordinates(text);
    return parsed ? { lat: parsed.lat, lng: parsed.lng } : null;
  }
  coords.input.addEventListener('change', () => {
    coords.setError('');
    const value = readCoords();
    if (value === null) coords.setError(t('atlas.bucket.coordinatesInvalid'));
    else if (value.lat !== undefined) void fillCountry(value.lat, value.lng);
  });

  let search = null;
  if (geocode) {
    const queryId = uid('bucket-find');
    const query = el('input.input', { id: queryId, type: 'search', autocomplete: 'off', spellcheck: false });
    const results = el('ul.atlas-find-results', { 'aria-label': t('atlas.bucket.findResults'), hidden: true });
    let controller = null;
    const choose = (result) => {
      if (!name.input.value.trim()) name.input.value = result.name || '';
      coords.input.value = coordText(result.lat, result.lng); coords.setError('');
      const cc = typeof result.country === 'string' ? result.country.toUpperCase() : '';
      if (!countryTouched && COUNTRY_CODES.includes(cc)) country.input.value = cc;
      else void fillCountry(result.lat, result.lng);
      results.hidden = true; results.replaceChildren();
      status.textContent = t('atlas.bucket.chosen', { name: result.name || coords.input.value });
      name.input.focus();
    };
    const run = async () => {
      const text = query.value.trim();
      if (!text) return;
      if (!online()) { status.textContent = t('atlas.bucket.searchOffline'); return; }
      controller?.abort(); controller = new AbortController();
      status.textContent = t('atlas.bucket.searching');
      try {
        const answer = await geocode.search(text, { lang: displayLocale(), signal: controller.signal });
        const found = dedupeResults(answer?.data ?? []).filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng)).slice(0, MAX_RESULTS);
        results.replaceChildren(...found.map((entry) => el('li', {}, el('button.atlas-row', { type: 'button', onclick: () => choose(entry) },
          icon('pin', 16), el('span.atlas-row-text', {}, el('span.atlas-row-name', {}, entry.name || entry.address || coordText(entry.lat, entry.lng)), entry.address && entry.name ? el('span.atlas-row-sub', {}, entry.address) : null)))));
        results.hidden = !found.length;
        status.textContent = found.length ? '' : t('atlas.bucket.searchNone');
      } catch (error) {
        if (error?.name !== 'AbortError') status.textContent = t('atlas.bucket.searchFailed');
      }
    };
    query.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void run(); } });
    search = el('div.field.atlas-find', {}, el('label.field-label', { htmlFor: queryId }, t('atlas.bucket.find')),
      el('div.atlas-find-row', {}, query, button(t('atlas.bucket.findButton'), { size: 'sm', variant: 'outline', onclick: () => { void run(); } })), results);
  }

  return new Promise((resolve) => {
    let busy = false;
    const save = button(t('atlas.bucket.save'), { type: 'submit', variant: 'primary' });
    const actions = [button(t('atlas.bucket.cancel'), { onclick: () => dialog.close('cancel') })];
    if (editing) {
      actions.unshift(button(t('atlas.bucket.delete'), { variant: 'danger', icon: 'trash', onclick: async () => {
        const label = item.name || (item.cc ? nameOf(item.cc) : '');
        if (!await confirmDialog({ title: t('atlas.bucket.deleteTitle', { name: label }), body: t('atlas.bucket.deleteBody'), confirmLabel: t('atlas.bucket.delete'), danger: true })) return;
        if (!online()) { toast(t('atlas.error.offline')); return; }
        try { await store.remove(item.id); toast(t('atlas.bucket.deleted')); dialog.close('deleted'); }
        catch (error) { toast(bucketError(error)); }
      } }));
    }
    const form = el('form.atlas-bucket-form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      if (busy) return;
      name.setError(''); coords.setError('');
      const position = readCoords();
      if (position === null) { coords.setError(t('atlas.bucket.coordinatesInvalid')); coords.input.focus(); return; }
      const draft = { name: name.input.value, cc: country.input.value || undefined, ...position, notes: notes.input.value, target: target.input.value || undefined, visitedAt: visited.querySelector('input').checked ? (visitedDate.input.value || localToday()) : undefined };
      let clean;
      try { clean = validateBucketItem(draft); }
      catch (error) {
        if (error?.code === 'bucket_name_required') { name.setError(t('atlas.bucket.nameRequired')); name.input.focus(); }
        else status.textContent = t('atlas.bucket.invalid');
        return;
      }
      if (!online()) { toast(t('atlas.error.offline')); return; }
      busy = true; save.setAttribute('aria-busy', 'true');
      try {
        if (editing) await store.save(item.id, clean); else await store.create(clean);
        toast(t('atlas.bucket.saved'));
        dialog.close('saved');
      } catch (error) {
        toast(bucketError(error));
      } finally { busy = false; save.setAttribute('aria-busy', 'false'); }
    } },
    search, name.element, coords.element, country.element, target.element, notes.element, visited, visitedDate.element, status,
    el('div.modal-actions', {}, ...actions, save));
    const dialog = openModal({ title: t(editing ? 'atlas.bucket.editTitle' : 'atlas.bucket.newTitle'), content: form, onClose: (reason) => resolve(reason), initialFocus: name.input });
  });
}
