// Collection details form: name, description, color, icon, cover image and web links. Used for create and edit.
import { el, uid, safeURL } from '../../ui/dom.js';
import { button, iconButton } from '../../ui/bits.js';
import { field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { COLLECTION_ICONS, icon } from './icons.js';
import { IMAGE_ACCEPT, chooseLocalFiles, coverUrl, errorKey, uploadCover } from '../../lib/files/index.js';

export const COLORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
export const NAME_MAX = 200;
export const URLS_MAX = 50;
export const colorValue = (color) => (COLORS.includes(color) ? `var(--day-${color})` : 'var(--accent)');
const webValue = (text) => {
  const value = text.trim();
  if (!value) return undefined;
  return safeURL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`) ?? NaN;
};

/** The collection's swatch: its icon on its color. */
let plurals;
/** "1 place", "3 places". */
export function placeCount(count) {
  plurals ??= new Intl.PluralRules(locale);
  return t(plurals.select(count) === 'one' ? 'collections.placeCount.one' : 'collections.placeCount', { count: formatNumber(count) });
}

export function collectionBadge(meta, size = 40) {
  return el('span.col-badge', { style: { '--col-color': colorValue(meta?.color), '--col-size': `${size}px` }, 'aria-hidden': 'true' },
    icon(COLLECTION_ICONS.includes(meta?.icon) ? meta.icon : 'bookmark', Math.round(size * 0.5)));
}

function radioGrid({ label, name, items, value, render }) {
  const legendId = uid('col-legend');
  const inputs = [];
  const element = el('fieldset.col-picker', { 'aria-labelledby': legendId },
    el('legend.field-label', { id: legendId }, label),
    el('div.col-picker-grid', {}, items.map((item) => {
      const input = el('input.col-picker-input', { type: 'radio', name, value: String(item.value), checked: item.value === value, 'aria-label': item.label });
      inputs.push(input);
      return el('label.col-picker-option', { title: item.label }, input, render(item));
    })));
  return { element, get value() { return inputs.find((input) => input.checked)?.value ?? ''; } };
}

/** `{set, unset}` from stored meta to form values; only fields the form owns are compared. */
export function metaPatch(before, values) {
  const set = {}; const unset = [];
  for (const key of ['name', 'desc', 'color', 'icon', 'cover', 'urls']) {
    const next = values[key];
    if (next === undefined) { if (before?.[key] !== undefined && key !== 'name') unset.push(key); continue; }
    if (JSON.stringify(next) !== JSON.stringify(before?.[key])) set[key] = next;
  }
  return { set, unset };
}

/**
 * Opens the form. `onSubmit(values, {setProgress})` saves; a throw shows `describeError(error)` in the form. With
 * `space` (editing), the cover can also be an uploaded image, which is saved at once.
 */
export function openMetaForm({ space = null, meta = null, title, submitLabel, onSubmit, describeError }) {
  const name = field({ label: t('collections.fieldName'), value: meta?.name ?? '', maxLength: NAME_MAX, required: true, autocomplete: 'off' });
  const desc = field({ label: t('collections.fieldDesc'), type: 'textarea', value: meta?.desc ?? '', rows: 3, hint: t('collections.markdownHint') });
  const color = radioGrid({ label: t('collections.fieldColor'), name: uid('col-color'), value: meta?.color ?? 1,
    items: COLORS.map((value) => ({ value, label: t('collections.colorN', { n: value }) })),
    render: (item) => el('span.col-dot', { style: { '--col-color': colorValue(item.value) } }) });
  const iconPick = radioGrid({ label: t('collections.fieldIcon'), name: uid('col-icon'), value: meta?.icon ?? 'bookmark',
    items: COLLECTION_ICONS.map((value) => ({ value, label: t(`collections.icon.${value}`) })),
    render: (item) => el('span.col-icon-choice', {}, icon(item.value, 18)) });
  const cover = field({ label: t('collections.fieldCover'), type: 'url', value: typeof meta?.cover === 'object' ? meta.cover.url ?? '' : '', inputMode: 'url', autocomplete: 'off', hint: t('collections.fieldCoverHint') });
  const credit = field({ label: t('collections.fieldCoverCredit'), value: typeof meta?.cover === 'object' ? meta.cover.credit ?? '' : '', maxLength: 500, autocomplete: 'off' });
  const fileCover = () => { const value = space?.get('meta', 'meta')?.cover; return typeof value === 'string' ? value : null; };
  const preview = el('img.col-cover-preview', { alt: '', hidden: true });
  const coverStatus = el('p.field-hint', { role: 'status', 'aria-live': 'polite' });
  const showCover = (id) => {
    preview.hidden = true;
    if (id) coverUrl(space, id, { thumb: true }).then((src) => { if (src && fileCover() === id) { preview.src = src; preview.hidden = false; } }).catch(() => {});
  };
  const upload = button(t('collections.coverUpload'), { size: 'sm', variant: 'outline', onclick: async () => {
    const [file] = await chooseLocalFiles({ accept: IMAGE_ACCEPT, multiple: false });
    if (!file) return;
    upload.setAttribute('aria-busy', 'true');
    coverStatus.textContent = t('collections.coverUploading');
    try {
      const { id } = await uploadCover(space, file);
      cover.input.value = ''; credit.input.value = '';
      coverStatus.textContent = t('collections.coverSaved');
      showCover(id);
      clearCover.hidden = false;
    } catch (error) { coverStatus.textContent = t(errorKey(error)); } finally { upload.setAttribute('aria-busy', 'false'); }
  } });
  const clearCover = button(t('collections.coverRemove'), { size: 'sm', variant: 'ghost', onclick: async () => {
    try {
      await space.apply([space.ops.patch('meta', 'meta', { unset: ['cover'] })]);
      cover.input.value = ''; credit.input.value = ''; preview.hidden = true; clearCover.hidden = true;
      coverStatus.textContent = t('collections.coverRemoved');
    } catch (error) { coverStatus.textContent = describeError?.(error) ?? t('collections.errGeneric'); }
  } });
  upload.hidden = !space || !space.can('trip.cover') || !space.can('files.upload');
  clearCover.hidden = !space || !meta?.cover;
  const coverFiles = space ? el('div.col-cover-upload', {}, preview, el('div.col-cover-actions', {}, upload, clearCover), coverStatus) : null;
  if (space) showCover(fileCover());

  const linksId = uid('col-links');
  const linkRows = el('ul.col-link-rows', { 'aria-labelledby': linksId });
  const addLink = button(t('collections.addLink'), { size: 'sm', variant: 'ghost', icon: 'plus', onclick: () => { row(); linkRows.lastElementChild?.querySelector('input')?.focus(); } });
  function row(link = {}) {
    const url = el('input.input', { type: 'url', inputMode: 'url', value: link.url ?? '', autocomplete: 'off', 'aria-label': t('collections.linkUrl'), placeholder: t('collections.linkUrlPlaceholder') });
    const label = el('input.input', { value: link.title ?? '', maxLength: 500, autocomplete: 'off', 'aria-label': t('collections.linkTitle'), placeholder: t('collections.linkTitle') });
    const node = el('li.col-link-row', {}, url, label, iconButton('trash', t('collections.removeLink'), { onclick: () => { node.remove(); addLink.disabled = false; addLink.focus(); } }));
    linkRows.append(node);
    addLink.disabled = linkRows.children.length >= URLS_MAX;
  }
  for (const link of meta?.urls ?? []) row(link);

  const alert = el('p.col-alert', { role: 'alert', hidden: true });
  const status = el('p.col-progress', { role: 'status', hidden: true });
  const submit = button(submitLabel, { type: 'submit', variant: 'primary' });
  function collect() {
    let invalid = null;
    const flag = (control, message) => { control.setError?.(message); invalid ??= control.input ?? control; };
    name.setError(''); cover.setError('');
    const values = { name: name.input.value.replace(/\s+/g, ' ').trim() };
    if (!values.name) flag(name, t('collections.nameRequired'));
    if (desc.input.value.trim()) values.desc = desc.input.value.trim();
    const colorChoice = Number(color.value);
    if (COLORS.includes(colorChoice)) values.color = colorChoice;
    if (COLLECTION_ICONS.includes(iconPick.value)) values.icon = iconPick.value;
    const coverLink = webValue(cover.input.value);
    if (Number.isNaN(coverLink)) flag(cover, t('collections.urlInvalid'));
    else if (coverLink) values.cover = { url: coverLink, ...(credit.input.value.trim() ? { credit: credit.input.value.trim() } : {}) };
    // An uploaded cover stays unless a web image replaces it.
    else if (fileCover()) values.cover = fileCover();
    const urls = [];
    for (const node of linkRows.children) {
      const [urlInput, titleInput] = node.querySelectorAll('input');
      urlInput.removeAttribute('aria-invalid');
      const value = webValue(urlInput.value);
      if (value === undefined) continue;
      if (Number.isNaN(value)) { urlInput.setAttribute('aria-invalid', 'true'); invalid ??= urlInput; alert.textContent = t('collections.urlInvalid'); alert.hidden = false; continue; }
      if (urls.some((link) => link.url === value)) continue;
      urls.push({ url: value, ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}) });
    }
    if (urls.length) values.urls = urls;
    if (invalid) { invalid.focus(); return null; }
    return values;
  }
  let busy = false;
  const form = el('form.col-form', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    if (busy) return;
    alert.hidden = true;
    const values = collect();
    if (!values) return;
    busy = true; submit.setAttribute('aria-busy', 'true');
    try {
      await onSubmit(values, { setProgress: (text) => { status.textContent = text ?? ''; status.hidden = !text; } });
      dialog.close('saved');
    } catch (error) {
      status.hidden = true;
      alert.textContent = describeError?.(error) ?? t('collections.errGeneric');
      alert.hidden = false;
    } finally { busy = false; submit.setAttribute('aria-busy', 'false'); }
  } },
  name.element, desc.element, color.element, iconPick.element,
  el('details.col-more', { open: Boolean(meta?.cover || meta?.urls?.length) },
    el('summary', {}, t('collections.moreDetails')),
    coverFiles, cover.element, credit.element,
    el('div.col-links-field', {}, el('span.field-label', { id: linksId }, t('collections.fieldLinks')), linkRows, addLink)),
  alert, status,
  el('div.modal-actions', {}, button(t('collections.cancel'), { onclick: () => dialog.close('cancel') }), submit));
  const dialog = openModal({ title, content: form, wide: true });
  return dialog;
}
