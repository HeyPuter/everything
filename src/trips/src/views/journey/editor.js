// The entry editor: kind, title, story, date and time, place, mood, weather, tags, pros and cons, visibility and media.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton } from '../../ui/bits.js';
import { field, checkbox, segmented } from '../../ui/fields.js';
import { makeSortable } from '../../ui/dnd.js';
import { markdown } from '../../ui/md.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatTemperature } from '../../lib/format.js';
import { canUseDrive, chooseLocalFiles, pickFromDrive, setDescription } from '../../lib/files/index.js';
import { isDate, isTime } from '../../shared/dates.js';
import { orderBetween } from '../../shared/order.js';
import { ENTRY_LIMITS, MOODS, WEATHER, WRITABLE_TYPES } from './constants.js';
import { TYPE_ICONS, icon } from './icons.js';
import { cleanList, cleanTags, isSuggestion, lastOrders } from './model.js';
import { locationField, currentWeather } from './location.js';
import { fileOf, liveMedia, mediaAccept, mediaTile, removeMedia, reorderMedia, trashOrphans, uploadMedia } from './media.js';
import { canScanDrive, openNearby } from './nearby.js';
import { errorText } from './spaces.js';

const FIELDS = ['type', 'date', 'time', 'title', 'story', 'loc', 'mood', 'weather', 'tags', 'pros', 'cons', 'vis', 'excluded'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Set and unset paths that turn `before` into `after` for the editor's fields. */
export function entryPatch(before, after) {
  const set = {};
  const unset = [];
  for (const key of FIELDS) {
    if (same(before?.[key], after[key])) continue;
    if (after[key] === undefined) { if (before?.[key] !== undefined) unset.push(key); } else set[key] = after[key];
  }
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}

/**
 * Opens the editor for `entry` (an entity) or a new one (`draft` fields). Writing up a suggestion turns it into a
 * check-in. `context` gives services and the session; `fields` is meta `fields` (mood, weather, prosCons).
 */
export function openEntryEditor({ space, context, entry = null, draft = {}, onSaved }) {
  const services = context.session?.services ?? null;
  const meta = space.get('meta', 'meta') ?? {};
  const shown = { mood: meta.fields?.mood !== false, weather: meta.fields?.weather !== false, prosCons: meta.fields?.prosCons !== false };
  let current = entry ? space.get('entry', entry.id) ?? entry : null;
  const start = { ...draft, ...(current ?? {}) };
  let saving = false;
  let closed = false;
  let sortable = null;

  const type = segmented({ label: t('journey.fieldType'), value: WRITABLE_TYPES.includes(start.type) ? start.type : (isSuggestion(start) ? 'checkin' : 'moment'),
    items: WRITABLE_TYPES.map((value) => ({ value, label: t(`journey.type.${value}`) })) });
  const title = field({ label: t('journey.fieldTitle'), value: start.title ?? '', maxLength: ENTRY_LIMITS.title, required: true, autocomplete: 'off' });
  const date = field({ label: t('journey.fieldDate'), type: 'date', value: start.date ?? '', required: true });
  const time = field({ label: t('journey.fieldTime'), type: 'time', value: start.time ?? '' });
  const location = locationField({ services, value: start.loc ?? null });
  const storyId = uid('jr-story');
  const story = el('textarea.textarea.jr-story', { id: storyId, rows: 8, maxLength: 100_000, value: start.story ?? '', placeholder: t('journey.storyPlaceholder') });
  story.value = start.story ?? '';
  const preview = el('div.jr-preview', { hidden: true, 'aria-live': 'polite' });
  const previewToggle = button(t('journey.preview'), { size: 'sm', variant: 'ghost', 'aria-pressed': 'false', onclick: () => {
    const on = preview.hidden;
    preview.hidden = !on; story.hidden = on;
    previewToggle.setAttribute('aria-pressed', String(on));
    previewToggle.textContent = t(on ? 'journey.editText' : 'journey.preview');
    if (on) preview.replaceChildren(story.value.trim() ? markdown(story.value) : el('p.jr-muted', {}, t('journey.previewEmpty')));
  } });
  const mood = segmented({ label: t('journey.fieldMood'), value: start.mood ?? '', radio: true,
    items: [{ value: '', label: t('journey.none') }, ...MOODS.map((value) => ({ value, label: t(`journey.mood.${value}`) }))] });
  [...mood.element.children].slice(1).forEach((node, index) => node.prepend(icon(MOODS[index], 16)));
  const weather = field({ label: t('journey.fieldWeather'), type: 'select', value: start.weather ?? '',
    options: [{ value: '', label: t('journey.none') }, ...WEATHER.map((value) => ({ value, label: t(`journey.weather.${value}`) }))] });
  const weatherHint = el('span.field-hint', { role: 'status' });
  const weatherNow = button(t('journey.weatherNow'), { size: 'sm', variant: 'outline', onclick: () => void fillWeather() });
  weatherNow.hidden = !services?.weather;
  const tags = field({ label: t('journey.fieldTags'), value: (start.tags ?? []).join(', '), hint: t('journey.tagsHint'), autocomplete: 'off' });
  const pros = field({ label: t('journey.fieldPros'), type: 'textarea', value: (start.pros ?? []).join('\n'), hint: t('journey.listHint'), rows: 3 });
  const cons = field({ label: t('journey.fieldCons'), type: 'textarea', value: (start.cons ?? []).join('\n'), hint: t('journey.listHint'), rows: 3 });
  let members = start.vis === 'members';
  let excluded = start.excluded === true;
  const visibility = checkbox(t('journey.fieldMembersOnly'), { checked: members, onChange: (value) => { members = value; } });
  const exclude = checkbox(t('journey.fieldExcluded'), { checked: excluded, onChange: (value) => { excluded = value; } });
  const formError = el('p.jr-form-error', { role: 'alert', hidden: true });

  const mediaList = el('ul.jr-media-edit', { 'aria-label': t('journey.media') });
  const mediaStatus = el('p.field-hint', { role: 'status' });
  const addFiles = button(t('journey.addPhotos'), { size: 'sm', variant: 'outline', onclick: () => void pickLocal() });
  addFiles.prepend(icon('addPhoto', 16));
  const fromCamera = button(t('journey.takePhoto'), { size: 'sm', variant: 'outline', onclick: () => void pickCamera() });
  fromCamera.prepend(icon('camera', 16));
  const fromDrive = button(t('journey.fromDrive'), { size: 'sm', variant: 'outline', onclick: () => void pickDrive() });
  fromDrive.prepend(icon('drive', 16));
  fromDrive.hidden = !canUseDrive(context.puter);
  const nearby = button(t('journey.nearby'), { size: 'sm', variant: 'outline', onclick: () => void findNearby() });
  nearby.prepend(icon('nearby', 16));
  nearby.hidden = !canScanDrive(context.puter);
  const canUpload = space.can('files.upload');
  for (const control of [addFiles, fromCamera, fromDrive, nearby]) if (!canUpload) control.hidden = true;

  const section = (labelKey, ...children) => el('fieldset.jr-fieldset', {}, el('legend.field-label', {}, t(labelKey)), ...children);
  const content = el('form.jr-editor', { novalidate: true, onsubmit: (event) => { event.preventDefault(); void save(); } },
    current && isSuggestion(current) && el('p.jr-note', {}, icon('suggestion', 16), t('journey.suggestionNote')),
    el('div.jr-field-type', {}, el('span.field-label', {}, t('journey.fieldType')), type.element),
    title.element,
    el('div.jr-grid-2', {}, date.element, time.element),
    location.element,
    el('div.field', {}, el('div.jr-row.jr-row-between', {}, el('label.field-label', { htmlFor: storyId }, t('journey.fieldStory')), previewToggle), story, preview,
      el('span.field-hint', {}, t('journey.storyHint'))),
    shown.mood && el('div.field', {}, el('span.field-label', {}, t('journey.fieldMood')), mood.element),
    shown.weather && el('div.jr-weather', {}, weather.element, el('div.jr-row', {}, weatherNow, weatherHint)),
    tags.element,
    shown.prosCons && el('div.jr-grid-2', {}, pros.element, cons.element),
    section('journey.media', mediaList, el('div.jr-row.jr-wrap', {}, addFiles, fromCamera, fromDrive, nearby), mediaStatus),
    section('journey.fieldVisibility', visibility, el('span.field-hint', {}, t('journey.membersOnlyHint')), exclude),
    formError);

  const saveButton = button(t(current && !isSuggestion(current) ? 'journey.save' : 'journey.saveEntry'), { variant: 'primary', type: 'submit', onclick: () => void save() });
  const actions = [
    current && button(t('journey.deleteEntry'), { variant: 'danger', onclick: () => void remove() }),
    button(t('journey.cancel'), { onclick: () => dialog.close('cancel') }),
    saveButton,
  ].filter(Boolean);
  const dialog = openModal({
    title: t(current ? (isSuggestion(current) ? 'journey.writeUpTitle' : 'journey.editTitle') : 'journey.newTitle'), content, actions, wide: true,
    onClose: () => { closed = true; location.destroy(); sortable?.destroy(); off(); },
  });
  const off = space.subscribe('file', () => renderMedia());

  function values() {
    const loc = location.value();
    const out = {
      type: type.value, title: title.input.value.trim(), date: date.input.value, story: story.value.trim() || undefined,
      time: isTime(time.input.value) ? time.input.value : undefined,
      loc: loc && Object.keys(loc).length ? loc : undefined,
      mood: shown.mood ? (mood.value || undefined) : current?.mood,
      weather: shown.weather ? (weather.input.value || undefined) : current?.weather,
      tags: cleanTags(tags.input.value.split(',')),
      pros: shown.prosCons ? cleanList(pros.input.value.split('\n')) : current?.pros,
      cons: shown.prosCons ? cleanList(cons.input.value.split('\n')) : current?.cons,
      vis: members ? 'members' : undefined,
      excluded: excluded || undefined,
    };
    for (const key of ['tags', 'pros', 'cons']) if (!out[key]?.length) out[key] = undefined;
    return out;
  }
  function validate(next) {
    title.setError(next.title ? '' : t('journey.titleRequired'));
    date.setError(isDate(next.date) ? '' : t('journey.dateRequired'));
    return Boolean(next.title && isDate(next.date));
  }

  /** Creates the entry when it does not exist yet (media need an entry to link to). */
  async function ensureSaved() {
    current = current ? space.get('entry', current.id) ?? current : null;
    if (current) return current;
    const next = values();
    if (!validate(next)) { (next.title ? date.input : title.input).focus(); return null; }
    const orders = lastOrders(space.select.entry.all());
    const fields = Object.fromEntries(Object.entries({ ...next, order: orderBetween(orders.get(next.date) ?? null, null) }).filter(([, value]) => value !== undefined));
    const op = space.ops.create('entry', fields);
    await space.apply([op], { history: t('journey.historyAdd') });
    current = space.get('entry', op.id);
    saveButton.textContent = t('journey.save');
    return current;
  }

  async function save() {
    if (saving) return;
    const next = values();
    if (!validate(next)) { formError.hidden = true; return; }
    saving = true;
    saveButton.setAttribute('aria-busy', 'true');
    try {
      if (!current) {
        await ensureSaved();
      } else {
        const fresh = space.get('entry', current.id) ?? current;
        const patch = entryPatch(fresh, next);
        if (patch.set || patch.unset) await space.apply([space.ops.patch('entry', fresh.id, patch)], { history: t('journey.historyEdit') });
      }
      await saveCaptions();
      space.flush?.();
      onSaved?.(current?.id);
      dialog.close('saved');
    } catch (error) {
      formError.textContent = errorText(error);
      formError.hidden = false;
    } finally {
      saving = false;
      saveButton.setAttribute('aria-busy', 'false');
    }
  }

  async function remove() {
    if (!current) return;
    const ok = await confirmDialog({ title: t('journey.deleteTitle'), body: t('journey.deleteBody'), confirmLabel: t('journey.deleteEntry'), danger: true });
    if (!ok || closed) return;
    const gone = space.get('entry', current.id) ?? current;
    try {
      await space.apply([space.ops.remove('entry', gone.id)]);
      void trashOrphans(space, gone);
      toast(t('journey.deleted'));
      dialog.close('deleted');
    } catch (error) { toast(errorText(error)); }
  }

  // ---- weather
  async function fillWeather() {
    const loc = location.value();
    if (!Number.isFinite(loc?.lat)) { weatherHint.textContent = t('journey.weatherNeedsPlace'); return; }
    weatherNow.setAttribute('aria-busy', 'true');
    weatherHint.textContent = t('journey.weatherLoading');
    const found = await currentWeather(services, loc).catch(() => null);
    weatherNow.setAttribute('aria-busy', 'false');
    if (closed) return;
    if (!found) { weatherHint.textContent = t('journey.weatherUnavailable'); return; }
    weather.input.value = found.weather;
    weatherHint.textContent = Number.isFinite(found.temperatureC) ? t('journey.weatherNowIs', { temp: formatTemperature(found.temperatureC) }) : '';
  }

  // ---- media
  const captions = new Map();
  function renderMedia() {
    if (closed) return;
    sortable?.destroy(); sortable = null;
    const ids = current ? liveMedia(space, space.get('entry', current.id) ?? current) : [];
    mediaList.replaceChildren(...ids.map((id) => {
      const file = fileOf(space, id);
      const captionId = uid('jr-caption');
      const caption = el('input.input', { id: captionId, value: captions.get(id) ?? file?.desc ?? '', maxLength: 2000, placeholder: t('journey.captionPlaceholder'), disabled: !space.can('files.edit'),
        oninput: (event) => captions.set(id, event.target.value) });
      caption.value = captions.get(id) ?? file?.desc ?? '';
      return el('li.jr-media-row', { dataset: { sortableItem: '', id, label: file?.name ?? '' } },
        el('span.jr-grip', { dataset: { sortableHandle: '' }, role: 'button', tabIndex: 0, 'aria-label': t('journey.moveMedia', { name: file?.name ?? '' }) }, icon('grip', 16)),
        mediaTile(space, id),
        el('div.jr-media-caption', {}, el('label.sr-only', { htmlFor: captionId }, t('journey.caption', { name: file?.name ?? '' })), caption),
        space.can('plan.edit') && iconButton('trash', t('journey.removeMedia', { name: file?.name ?? '' }), { onclick: () => void dropMedia(id) }));
    }));
    if (!ids.length) mediaList.append(el('li.jr-muted', {}, t(canUpload ? 'journey.mediaEmpty' : 'journey.mediaEmptyViewer')));
    if (ids.length > 1 && space.can('plan.edit')) {
      sortable = makeSortable(mediaList, { onMove: ({ from, to }) => {
        const list = [...ids];
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        void reorderMedia(space, current.id, list).catch((error) => toast(errorText(error)));
      } });
    }
  }
  async function saveCaptions() {
    for (const [id, text] of captions) {
      const file = fileOf(space, id);
      if (file && (file.desc ?? '') !== text.trim() && space.can('files.edit')) await setDescription(space, id, text.trim());
    }
    captions.clear();
  }
  async function dropMedia(id) {
    try { await removeMedia(space, current.id, id); } catch (error) { toast(errorText(error)); }
    renderMedia();
  }
  async function addMedia(files) {
    if (!files.length || closed) return;
    const saved = await ensureSaved().catch((error) => { toast(errorText(error)); return null; });
    if (!saved) return;
    renderMedia();
    const { added, failed } = await uploadMedia(space, saved.id, files, { onProgress: ({ index, total, name }) => {
      if (!closed) mediaStatus.textContent = t('journey.uploading', { index: index + 1, total, name });
    } });
    if (closed) return;
    mediaStatus.textContent = failed.length ? failed.map((item) => t('journey.uploadFailed', { name: item.name, reason: item.message })).join(' ') : t('journey.uploaded', { count: added.length });
    renderMedia();
  }
  async function pickLocal() { addMedia(await chooseLocalFiles({ accept: await mediaAccept(space), multiple: true })); }
  async function pickCamera() {
    const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    input.addEventListener('change', () => { const files = [...(input.files ?? [])]; input.remove(); void addMedia(files); }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.append(input);
    input.click();
  }
  async function pickDrive() {
    try { addMedia(await pickFromDrive({ puter: context.puter })); } catch (error) { toast(errorText(error)); }
  }
  async function findNearby() {
    const next = values();
    if (!isDate(next.date)) { date.setError(t('journey.dateRequired')); date.input.focus(); return; }
    openNearby({ puter: context.puter, date: next.date, loc: next.loc ?? null, onAdd: (files) => addMedia(files) });
  }
  renderMedia();
  return dialog;
}

/** Restores a dismissed suggestion or dismisses one. */
export function setDismissed(space, entry, dismissed) {
  return space.apply([space.ops.patch('entry', entry.id, dismissed ? { set: { dismissed: true } } : { unset: ['dismissed'] })], { history: t(dismissed ? 'journey.historyDismiss' : 'journey.historyRestore') });
}

export { TYPE_ICONS };
