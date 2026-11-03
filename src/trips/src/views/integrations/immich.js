// Immich photo picker: photos taken during the trip, chosen in a grid and handed to the normal upload path.
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../lib/format.js';
import { fileType } from '../../lib/files/types.js';
import { LIMITS } from '../../shared/limits.js';
import { addDays, isDate } from '../../shared/dates.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { immichClient, photoOriginal, photoThumbnail, searchPhotos } from '../../lib/integrations/immich.js';
import { errorLine, netAvailable, plural, progressLine, setupState, today } from './common.js';
import { pool } from '../../shared/pool.js';
import { icon } from './icons.js';

const MAX_SELECTED = 100;

/** Opens the picker; `onFiles(files)` gets the downloaded originals as `File`s. */
export function openImmichPicker(context, { onFiles } = {}) {
  const { space, app } = context;
  const puter = context.puter ?? globalThis.puter;
  const store = integrationStore(puter);
  const meta = space?.get?.('meta', 'meta') ?? {};
  const urls = new Map();
  const selected = new Map();
  const body = el('div.int-dialog');
  let client = null;
  let photos = [];
  let next = null;
  let observer = null;
  let generation = 0;
  const dialog = openModal({ title: t('integrations.immich.title'), content: body, wide: true, dismissOnBackdrop: false, onClose: () => {
    generation += 1; observer?.disconnect(); waiting.length = 0;
    for (const url of urls.values()) if (url) URL.revokeObjectURL(url);
    urls.clear();
  } });

  const end = isDate(meta.end) ? meta.end : isDate(meta.start) ? meta.start : today();
  const from = field({ label: t('integrations.from'), type: 'date', value: isDate(meta.start) ? meta.start : addDays(end, -30) });
  const to = field({ label: t('integrations.to'), type: 'date', value: end });
  const search = button(t('integrations.immich.search'), { type: 'submit', variant: 'outline' });
  const form = el('form.int-range', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void load(1); } }, from.element, to.element, search);
  const gridId = uid('int-photos');
  const grid = el('div.int-photo-groups', { id: gridId });
  const more = button(t('integrations.immich.more'), { variant: 'outline', hidden: true, onclick: () => void load(next) });
  const progress = progressLine();
  const error = errorLine('immich');
  const add = button('', { variant: 'primary', onclick: () => void download() });
  const live = el('p.sr-only', { role: 'status' });

  function sync() {
    add.textContent = selected.size ? plural(selected.size, 'addPhotos') : t('integrations.immich.choose');
    add.disabled = !selected.size;
  }
  // At most four thumbnail downloads at once; the rest wait their turn.
  const waiting = [];
  let active = 0;
  function pump() {
    while (active < 4 && waiting.length) {
      const task = waiting.shift();
      active += 1;
      void task().finally(() => { active -= 1; pump(); });
    }
  }
  function thumb(photo, holder) {
    if (urls.has(photo.id)) { if (urls.get(photo.id)) holder.replaceChildren(el('img', { src: urls.get(photo.id), alt: '' })); return; }
    urls.set(photo.id, null);
    const at = generation;
    waiting.push(() => (at !== generation ? Promise.resolve() : photoThumbnail(client, photo.id)).then((blob) => {
      if (at !== generation || !blob) { if (urls.get(photo.id) === null) urls.delete(photo.id); return; }
      const url = URL.createObjectURL(blob);
      urls.set(photo.id, url);
      if (holder.isConnected) holder.replaceChildren(el('img', { src: url, alt: '' }));
    }, () => { urls.delete(photo.id); }));
    pump();
  }
  function tile(photo) {
    const holder = el('span.int-photo-img', {}, icon('images', 22));
    const time = photo.time ? formatTime(photo.time) : '';
    const when = [photo.date && formatDate(photo.date), time].filter(Boolean).join(' ');
    const input = el('input.int-photo-check', { type: 'checkbox', checked: selected.has(photo.id), 'aria-label': [photo.name, when].filter(Boolean).join(', '),
      onchange: () => {
        if (input.checked && selected.size >= MAX_SELECTED) { input.checked = false; live.textContent = t('integrations.immich.limit', { max: MAX_SELECTED }); return; }
        if (input.checked) selected.set(photo.id, photo); else selected.delete(photo.id);
        sync();
      } });
    const node = el('label.int-photo', { title: photo.name }, input, holder, el('span.int-photo-time', { 'aria-hidden': 'true' }, time));
    if (observer) { holder.dataset.id = photo.id; observer.observe(holder); } else thumb(photo, holder);
    return node;
  }
  function render() {
    observer?.disconnect();
    observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const photo = photos.find((item) => item.id === entry.target.dataset.id);
        if (photo) thumb(photo, entry.target);
      }
    }, { root: dialog.panel.querySelector('.modal-body'), rootMargin: '200px' }) : null;
    if (!photos.length) { grid.replaceChildren(emptyState({ icon: 'search', title: t('integrations.immich.none'), body: t('integrations.immich.noneBody') })); return; }
    const byDate = new Map();
    for (const photo of photos) { const key = photo.date ?? ''; if (!byDate.has(key)) byDate.set(key, []); byDate.get(key).push(photo); }
    grid.replaceChildren(...[...byDate].map(([date, items]) => el('section.int-photo-group', {},
      el('h3.int-group-title', {}, date ? formatDate(date, { weekday: true }) : t('integrations.immich.undated')),
      el('div.int-photos', { role: 'group', 'aria-label': date ? formatDate(date, { weekday: true }) : t('integrations.immich.undated') }, items.map(tile)))));
  }
  async function load(page) {
    error.clear();
    const start = from.input.value; const stop = to.input.value;
    if (!isDate(start) || !isDate(stop) || stop < start) { to.setError(t('integrations.rangeInvalid')); return; }
    to.setError('');
    if (page === 1) { photos = []; generation += 1; grid.replaceChildren(el('div.int-loading', {}, spinner(), el('p', {}, t('integrations.immich.loading')))); }
    search.setAttribute('aria-busy', 'true'); more.setAttribute('aria-busy', 'true');
    try {
      const result = await searchPhotos(client, { from: start, to: stop, page });
      const known = new Set(photos.map((photo) => photo.id));
      photos.push(...result.photos.filter((photo) => !known.has(photo.id) && (!photo.date || (photo.date >= start && photo.date <= stop))));
      next = result.next;
      more.hidden = !next;
      render();
      live.textContent = plural(photos.length, 'photosFound');
    } catch (problem) {
      if (page === 1) grid.replaceChildren();
      error.show(problem, () => void load(page));
    } finally { search.setAttribute('aria-busy', 'false'); more.setAttribute('aria-busy', 'false'); }
  }
  async function download() {
    const chosen = [...selected.values()];
    const files = []; let skipped = 0; let failed = 0; let done = 0;
    add.setAttribute('aria-busy', 'true'); error.clear();
    progress.set(t('integrations.immich.downloading', { done: 0, total: chosen.length }), 0, chosen.length);
    const at = generation;
    await pool(chosen, 2, async (photo) => {
      if (at !== generation) return;
      if (!fileType(photo.name) || (photo.size != null && photo.size > LIMITS.fileBytes)) { skipped += 1; }
      else {
        try { files.push(await photoOriginal(client, photo)); } catch (problem) { if (problem?.code === 'too_large') skipped += 1; else failed += 1; }
      }
      done += 1;
      progress.set(t('integrations.immich.downloading', { done, total: chosen.length }), done, chosen.length);
    });
    add.setAttribute('aria-busy', 'false');
    if (at !== generation) return;
    if (!files.length) { progress.hide(); error.show(t(skipped ? 'integrations.immich.allSkipped' : 'integrations.immich.allFailed')); return; }
    dialog.close('done');
    const notes = [skipped && plural(skipped, 'photosSkipped'), failed && plural(failed, 'photosFailed')].filter(Boolean);
    if (notes.length) toast(notes.join(' '));
    onFiles?.(files);
  }

  async function start() {
    body.replaceChildren(el('div.int-loading', {}, spinner()));
    let config;
    try { config = (await store.load()).immich; } catch (problem) { error.show(problem, () => void start()); body.replaceChildren(error.node); return; }
    if (!netAvailable(puter)) { body.replaceChildren(el('p.int-note', {}, t('integrations.unavailable'))); return; }
    if (!config) { body.replaceChildren(setupState('immich', { app, close: () => dialog.close() })); return; }
    client = immichClient(puter, config);
    body.replaceChildren(el('p.int-muted', {}, t('integrations.immich.intro')), form, grid, more, live, progress.node, error.node,
      el('div.modal-actions', {}, button(t('integrations.cancel'), { onclick: () => dialog.close() }), add));
    sync();
    from.input.focus();
    void load(1);
  }
  void start();
  return dialog;
}
