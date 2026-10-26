// Journey details: title, subtitle, status, cover, which entry fields are used and GPX tracks on the map.
import { el, uid, safeURL } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { field, checkbox } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { IMAGE_ACCEPT, chooseLocalFiles, coverUrl, errorKey, uploadCover } from '../../lib/files/index.js';
import { JOURNEY_STATUSES, META_LIMITS } from './constants.js';
import { errorText } from './spaces.js';

/** Fields of a new or edited journey from the form values; `undefined` means "leave out". */
export function metaValues({ title, subtitle, status, coverUrl: url, credit, fields, showTracks }) {
  const cover = safeURL(url.trim());
  return {
    title: title.trim().slice(0, META_LIMITS.title), subtitle: subtitle.trim().slice(0, META_LIMITS.subtitle) || undefined, status: status || undefined,
    cover: cover ? { url: cover, ...(credit.trim() ? { credit: credit.trim().slice(0, 500) } : {}) } : undefined, fields, showTracks: showTracks || undefined,
  };
}

/**
 * Create (`space` null: resolves the meta through `onSubmit`) or edit a journey. File covers are uploaded after
 * the journey exists; this form edits the web-image cover and uploads a new image cover directly when editing.
 */
export function openMetaForm({ space = null, initial = {}, title: dialogTitle, submitLabel, onSubmit }) {
  const meta = space?.get('meta', 'meta') ?? initial;
  const fileCover = typeof meta.cover === 'string' ? meta.cover : null;
  const name = field({ label: t('journey.fieldJourneyTitle'), value: meta.title ?? '', maxLength: META_LIMITS.title, required: true, autocomplete: 'off' });
  const subtitle = field({ label: t('journey.fieldSubtitle'), value: meta.subtitle ?? '', maxLength: META_LIMITS.subtitle, autocomplete: 'off' });
  const status = field({ label: t('journey.fieldStatus'), type: 'select', value: meta.status ?? '',
    options: [{ value: '', label: t('journey.none') }, ...JOURNEY_STATUSES.map((value) => ({ value, label: t(`journey.status.${value}`) }))] });
  const url = field({ label: t('journey.fieldCoverUrl'), type: 'url', value: typeof meta.cover === 'object' ? meta.cover?.url ?? '' : '', hint: t('journey.coverUrlHint'), autocomplete: 'off' });
  const credit = field({ label: t('journey.fieldCoverCredit'), value: typeof meta.cover === 'object' ? meta.cover?.credit ?? '' : '', maxLength: 500, autocomplete: 'off' });
  const fields = { mood: meta.fields?.mood !== false, weather: meta.fields?.weather !== false, prosCons: meta.fields?.prosCons !== false };
  let showTracks = meta.showTracks === true;
  const preview = el('img.jr-cover-preview', { alt: '', hidden: true });
  const coverStatus = el('p.field-hint', { role: 'status' });
  const upload = button(t('journey.coverUpload'), { size: 'sm', variant: 'outline', onclick: () => void uploadImage() });
  upload.hidden = !space || !space.can('trip.cover') || !space.can('files.upload');
  const clearCover = button(t('journey.coverRemove'), { size: 'sm', variant: 'ghost', onclick: () => void removeCover() });
  clearCover.hidden = !space || !meta.cover;
  if (space && fileCover) void coverUrl(space, fileCover, { thumb: true }).then((src) => { if (src) { preview.src = src; preview.hidden = false; } }).catch(() => {});
  const error = el('p.jr-form-error', { role: 'alert', hidden: true });
  const legend = uid('jr-fields');
  const form = el('form.jr-editor', { novalidate: true, onsubmit: (event) => { event.preventDefault(); void submit(); } },
    name.element, subtitle.element, status.element,
    el('fieldset.jr-fieldset', {}, el('legend.field-label', {}, t('journey.cover')), preview, el('div.jr-row', {}, upload, clearCover), coverStatus, url.element, credit.element),
    el('fieldset.jr-fieldset', { 'aria-labelledby': legend }, el('legend.field-label', { id: legend }, t('journey.fieldsUsed')),
      checkbox(t('journey.fieldMood'), { checked: fields.mood, onChange: (value) => { fields.mood = value; } }),
      checkbox(t('journey.fieldWeather'), { checked: fields.weather, onChange: (value) => { fields.weather = value; } }),
      checkbox(t('journey.fieldProsCons'), { checked: fields.prosCons, onChange: (value) => { fields.prosCons = value; } }),
      checkbox(t('journey.showTracks'), { checked: showTracks, onChange: (value) => { showTracks = value; } }),
      el('span.field-hint', {}, t('journey.showTracksHint'))),
    error);
  const save = button(submitLabel ?? t('journey.save'), { variant: 'primary', type: 'submit', onclick: () => void submit() });
  const dialog = openModal({ title: dialogTitle ?? t('journey.editJourney'), content: form, actions: [button(t('journey.cancel'), { onclick: () => dialog.close('cancel') }), save] });

  async function submit() {
    const values = metaValues({ title: name.input.value, subtitle: subtitle.input.value, status: status.input.value, coverUrl: url.input.value, credit: credit.input.value, fields: { ...fields }, showTracks });
    name.setError(values.title ? '' : t('journey.titleRequired'));
    url.setError(url.input.value.trim() && !values.cover ? t('journey.coverUrlInvalid') : '');
    if (!values.title || (url.input.value.trim() && !values.cover)) return;
    // An uploaded file cover stays unless a web image replaces it.
    if (!values.cover && fileCover && space?.get('meta', 'meta')?.cover === fileCover) values.cover = fileCover;
    save.setAttribute('aria-busy', 'true');
    error.hidden = true;
    try {
      await onSubmit(values);
      dialog.close('saved');
    } catch (failure) {
      error.textContent = errorText(failure);
      error.hidden = false;
    } finally { save.setAttribute('aria-busy', 'false'); }
  }
  async function uploadImage() {
    const [file] = await chooseLocalFiles({ accept: IMAGE_ACCEPT, multiple: false });
    if (!file) return;
    upload.setAttribute('aria-busy', 'true');
    coverStatus.textContent = t('journey.coverUploading');
    try {
      const { id } = await uploadCover(space, file);
      url.input.value = ''; credit.input.value = '';
      coverStatus.textContent = t('journey.coverSaved');
      const src = await coverUrl(space, id, { thumb: true }).catch(() => null);
      if (src) { preview.src = src; preview.hidden = false; }
      clearCover.hidden = false;
    } catch (failure) { coverStatus.textContent = t(errorKey(failure)); } finally { upload.setAttribute('aria-busy', 'false'); }
  }
  async function removeCover() {
    try {
      await space.apply([space.ops.patch('meta', 'meta', { unset: ['cover'] })]);
      url.input.value = ''; credit.input.value = ''; preview.hidden = true; clearCover.hidden = true;
      coverStatus.textContent = t('journey.coverRemoved');
    } catch (failure) { toast(errorText(failure)); }
  }
  return dialog;
}

/** The meta patch from edited values against the current meta. */
export function metaPatch(current, values) {
  const set = {};
  const unset = [];
  for (const key of ['title', 'subtitle', 'status', 'cover', 'fields', 'showTracks']) {
    const before = JSON.stringify(current?.[key] ?? null);
    if (values[key] === undefined) { if (current?.[key] !== undefined) unset.push(key); } else if (JSON.stringify(values[key]) !== before) set[key] = values[key];
  }
  return { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) };
}
