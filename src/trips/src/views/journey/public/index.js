// Read-only viewer for a public journey link (`#/s/…` when the projection's kind is `journey`). No credentials.
import '../journey.css';
import { el, uid } from '../../../ui/dom.js';
import { button, iconButton, emptyState, spinner } from '../../../ui/bits.js';
import { tabs } from '../../../ui/tabs.js';
import { markdown } from '../../../ui/md.js';
import { openModal } from '../../../ui/modal.js';
import { isDark } from '../../../ui/theme.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatDateRange, formatInstant, formatNumber, formatTime } from '../../../lib/format.js';
import { fetchPublic } from '../../../lib/api.js';
import { browserTimeZone } from '../../../shared/dates.js';
import { createTripMap } from '../../../map/index.js';
import { DEFAULT_CONFIG } from '../../../services/core.js';
import { failure } from '../../public/index.js';
import { icon } from '../icons.js';
import { icon as refreshIcon } from '../../trip/members/icons.js';
import { compareEntries, connector, groupByDate } from '../model.js';
import { cleanJourneyProjection } from './data.js';
import { createImageLoader, lazyImage } from './images.js';

const REFRESH_AFTER = 60_000;
const PENDING_RETRIES = 10;
const located = (entry) => Number.isFinite(entry.loc?.lat) && Number.isFinite(entry.loc?.lng);
const countryName = (cc) => { try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };

/** Entries in display order: by day (newest days first when the owner chose so), then within the day. */
export function orderedEntries(entries, newestFirst) {
  const sorted = [...entries].filter((entry) => entry.date).sort(compareEntries);
  return newestFirst ? groupByDate(sorted).reverse().flatMap((group) => group.entries) : sorted;
}

/**
 * Mounts the viewer. `initial` is a `fetchPublic` result already in hand (from the trip viewer's first request).
 * Returns a cleanup function.
 */
export async function mountPublicJourney(container, { route, puter, signal, initial = null }) {
  const link = { worker: route.worker, space: route.space, token: route.token };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const images = createImageLoader({ puter, link, signal: controller.signal });
  let state = { etag: null, projection: null, fetchedAt: 0, loading: false, pendingTries: 0 };
  let selected = null;
  let teardown = [];
  let retryTimer = 0;

  const refresh = iconButton('more', t('public.refresh'), { onclick: () => void load({ manual: true }) });
  refresh.replaceChildren(refreshIcon('refresh'));
  const live = el('p.sr-only', { role: 'status' });
  const body = el('main.public-body');
  const root = el('div.public-view.jr-public', {},
    el('header.public-head', {},
      el('a.public-brand', { href: '#/' }, el('img', { src: new URL('icons/icon-192.png', document.baseURI).href, width: 28, height: 28, alt: '' }), el('span', {}, t('public.openApp'))),
      el('span.chip.public-badge', {}, t('journey.publicBadge')), el('span.public-spacer'), refresh),
    live, body, el('footer.public-foot', {}, el('p', {}, t('journey.publicFooter'))));
  container.replaceChildren(root);

  const clearView = () => { for (const off of teardown.splice(0)) { try { off(); } catch { /* keep tearing down */ } } };
  const showState = (node) => { clearView(); body.replaceChildren(node); };
  function showFailure(error) {
    const info = failure(error);
    showState(el('div.public-state', { role: 'alert' }, emptyState({ title: info.title, body: info.body, icon: info.retry ? 'warning' : 'pin',
      action: info.retry ? button(t('public.retry'), { variant: 'primary', onclick: () => void load({ manual: true }) }) : null })));
  }

  function photo(file, { large = false } = {}) {
    return el(`span.jr-tile${large ? '.jr-tile-large' : ''}`, {}, lazyImage(() => images.preview(file), { alt: file.desc ?? '' }));
  }
  function lightbox(list, index) {
    let at = index;
    const stage = el('div.jr-lightbox-stage');
    const caption = el('p.jr-lightbox-caption', { 'aria-live': 'polite' });
    const show = () => {
      const file = list[at];
      stage.replaceChildren(spinner());
      caption.textContent = [file.desc, t('journey.photoPosition', { index: formatNumber(at + 1), count: formatNumber(list.length) })].filter(Boolean).join(' · ');
      void images.full(file).then((src) => stage.replaceChildren(el('img', { src, alt: file.desc ?? '' }))).catch(() => stage.replaceChildren(el('p.public-empty', {}, t('public.downloadFailed'))));
    };
    const step = (delta) => { at = (at + delta + list.length) % list.length; show(); };
    const nav = list.length > 1 ? el('div.jr-row', {}, iconButton('chevronLeft', t('journey.previousPhoto'), { onclick: () => step(-1) }), iconButton('chevronRight', t('journey.nextPhoto'), { onclick: () => step(1) })) : null;
    const dialog = openModal({ title: t('journey.photo'), content: el('div.jr-lightbox', {}, stage, caption, nav), wide: true });
    dialog.panel.addEventListener('keydown', (event) => {
      const forward = getComputedStyle(dialog.panel).direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === forward) step(1); else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') step(-1);
    });
    show();
  }

  function entryNode(entry, projection, photos) {
    const titleId = uid('jr-pub');
    const meta = [];
    if (entry.time) meta.push(el('span.jr-time.num', {}, formatTime(entry.time)));
    if (entry.loc?.name || entry.loc?.cc) meta.push(el('span.jr-place', {}, icon('map-pin', 14), el('span', {}, [entry.loc.name, entry.loc.cc && !entry.loc.name ? countryName(entry.loc.cc) : ''].filter(Boolean).join(', '))));
    if (entry.mood) meta.push(el('span.jr-badge', { title: t(`journey.mood.${entry.mood}`) }, icon(entry.mood, 15), el('span.sr-only', {}, t(`journey.mood.${entry.mood}`))));
    if (entry.weather) meta.push(el('span.jr-badge', { title: t(`journey.weather.${entry.weather}`) }, icon(entry.weather, 15), el('span.sr-only', {}, t(`journey.weather.${entry.weather}`))));
    const files = (entry.media ?? []).map((id) => projection.files.get(id)).filter(Boolean);
    return el('article.jr-entry', { 'aria-labelledby': titleId, dataset: { id: entry.id } },
      el('div.jr-entry-main', {},
        el('h3.jr-entry-title', { id: titleId }, entry.title),
        meta.length && el('div.jr-entry-meta', {}, meta),
        entry.story && el('div.jr-story-text', {}, markdown(entry.story)),
        (entry.pros?.length || entry.cons?.length) && el('div.jr-proscons', {},
          entry.pros?.length && el('div', {}, el('h4.jr-mini', {}, icon('pro', 14), t('journey.pros')), el('ul', {}, entry.pros.map((item) => el('li', {}, item)))),
          entry.cons?.length && el('div', {}, el('h4.jr-mini', {}, icon('con', 14), t('journey.cons')), el('ul', {}, entry.cons.map((item) => el('li', {}, item))))),
        entry.tags?.length && el('ul.jr-tags', {}, entry.tags.map((tag) => el('li.chip', {}, tag))),
        files.length && el('ul.jr-strip', {}, files.map((file) => el('li', {}, el('button.jr-tile-button', { type: 'button', 'aria-label': t('journey.openPhoto', { name: file.desc || file.name }),
          onclick: () => lightbox(photos, photos.indexOf(file)) }, photo(file)))))));
  }

  function timeline(projection, entries, photos) {
    if (!entries.length) return el('p.public-empty', {}, t('journey.publicEmpty'));
    return el('div.jr-days', {}, groupByDate(entries).map((group) => {
      const headingId = uid('jr-pub-day');
      return el('section.jr-day', { 'aria-labelledby': headingId },
        el('h2.jr-day-head', { id: headingId }, el('span.jr-day-date', {}, formatDate(group.date, { weekday: true, style: 'long' }))),
        el('div.jr-day-entries', {}, group.entries.map((entry) => entryNode(entry, projection, photos))));
    }));
  }

  function gallery(projection, entries, photos) {
    if (!photos.length) return el('p.public-empty', {}, t('journey.galleryEmpty'));
    const byFile = new Map();
    for (const entry of entries) for (const id of entry.media ?? []) if (!byFile.has(id)) byFile.set(id, entry);
    return el('ul.jr-gallery-grid', {}, photos.map((file, index) => el('li.jr-gallery-item', {},
      el('button.jr-tile-button', { type: 'button', 'aria-label': t('journey.openPhotoFrom', { name: file.desc || file.name, entry: byFile.get(file.id)?.title ?? '' }), onclick: () => lightbox(photos, index) }, photo(file, { large: true })),
      el('p.jr-gallery-caption', {}, file.desc && el('span', {}, file.desc), byFile.get(file.id) && el('span.jr-muted', {}, [formatDate(byFile.get(file.id).date), byFile.get(file.id).title].join(' · '))))));
  }

  function mapPane(entries) {
    const slot = el('div.jr-map-canvas');
    const caption = el('p.jr-hint', { role: 'status' });
    const pane = el('div.jr-map.jr-public-map', {}, el('div.jr-map-stage', {}, slot), caption);
    let mounted = false;
    pane.start = async () => {
      if (mounted) return;
      mounted = true;
      const pins = entries.filter(located).sort(compareEntries);
      if (!pins.length) { slot.replaceChildren(el('p.public-empty', {}, t('journey.mapEmpty'))); return; }
      const mapController = new AbortController();
      teardown.push(() => mapController.abort());
      try {
        const map = await createTripMap(slot, { t, theme: isDark() ? 'dark' : 'light', config: DEFAULT_CONFIG, signal: mapController.signal });
        teardown.push(() => map.destroy());
        const line = connector(pins);
        map.setRoutes('jr-route', { type: 'FeatureCollection', features: line.length > 1 ? [{ type: 'Feature', properties: { tone: 'accent', estimated: true }, geometry: { type: 'LineString', coordinates: line } }] : [] });
        map.setMarkers('jr-entries', { type: 'FeatureCollection', features: pins.map((entry, index) => ({ type: 'Feature', id: entry.id, properties: { id: entry.id, tone: 'accent', order: index + 1 }, geometry: { type: 'Point', coordinates: [entry.loc.lng, entry.loc.lat] } })) }, { cluster: false });
        map.onClick('jr-entries', (feature) => {
          const entry = pins.find((item) => item.id === String(feature.id));
          if (!entry) return;
          map.setSelected('jr-entries', entry.id);
          caption.textContent = [formatDate(entry.date, { weekday: true }), entry.title, entry.loc?.name].filter(Boolean).join(' · ');
        });
        map.fit(pins.map((entry) => [entry.loc.lng, entry.loc.lat]), { padding: 48, duration: 0, maxZoom: 13 });
      } catch (error) { if (error?.name !== 'AbortError') slot.replaceChildren(el('p.public-empty', { role: 'alert' }, t('public.mapFailed'))); }
    };
    return pane;
  }

  function render(projection) {
    clearView();
    const { meta, share } = projection;
    const entries = orderedEntries(projection.entries, share.newestFirst);
    const photos = [];
    for (const entry of entries) for (const id of entry.media ?? []) { const file = projection.files.get(id); if (file && !photos.includes(file)) photos.push(file); }
    const dated = entries.map((entry) => entry.date).sort();
    let expiry = '';
    if (share.exp) { try { expiry = formatInstant(share.exp, browserTimeZone(), { style: 'medium' }); } catch { expiry = ''; } }
    const cover = typeof meta.cover === 'string' && projection.files.get(meta.cover)
      ? el('div.public-cover-wrap', {}, lazyImage(() => images.full(projection.files.get(meta.cover)), { className: 'public-cover' }))
      : meta.cover?.url ? el('img.public-cover', { src: meta.cover.url, alt: '', referrerPolicy: 'no-referrer', decoding: 'async', onerror: (event) => { event.target.hidden = true; } }) : null;
    const hero = el('section.public-hero', {}, cover,
      el('div.public-hero-text', {},
        el('h1.public-title', { tabIndex: -1 }, meta.title || t('journey.untitled')),
        meta.subtitle && el('p.public-description', {}, meta.subtitle),
        (dated.length || meta.status) && el('p.public-dates', {}, icon('day', 16), [dated.length ? formatDateRange(dated[0], dated.at(-1), { style: 'long' }) : '', meta.status ? t(`journey.status.${meta.status}`) : ''].filter(Boolean).join(' · ')),
        projection.members.length > 0 && el('p.public-travelers', {}, icon('users', 16), el('span', {}, projection.members.join(', '))),
        meta.cover?.credit && el('p.public-sub', {}, t('public.coverCredit', { credit: meta.cover.credit })),
        expiry && el('p.public-hint', {}, t('public.expires', { date: expiry }))));
    const sections = [
      share.timeline && { id: 'timeline', label: t('journey.tab.timeline'), icon: 'write', content: timeline(projection, entries, photos) },
      share.gallery && { id: 'gallery', label: t('journey.tab.gallery'), icon: 'photos', content: gallery(projection, entries, photos) },
      share.map && { id: 'map', label: t('journey.tab.map'), icon: 'map', content: mapPane(entries) },
    ].filter(Boolean);
    let view = null;
    if (sections.length) {
      view = tabs({ label: t('public.sections'), value: sections.some((item) => item.id === selected) ? selected : sections[0].id,
        items: sections.map(({ id, label, content }) => ({ id, label, content })),
        onChange: (id) => { selected = id; if (id === 'map') void sections.find((item) => item.id === 'map').content.start(); } });
      [...view.element.querySelectorAll('.tab')].forEach((node, index) => node.prepend(icon(sections[index].icon, 16)));
      selected = view.value;
      if (selected === 'map') void sections.find((item) => item.id === 'map').content.start();
    }
    body.replaceChildren(hero, view ? view.element : el('div.public-state', {}, emptyState({ title: t('public.nothingTitle'), body: t('public.nothingBody'), icon: 'pin' })));
  }

  async function load({ manual = false } = {}) {
    if (state.loading || controller.signal.aborted) return;
    clearTimeout(retryTimer);
    state.loading = true;
    refresh.setAttribute('aria-busy', 'true');
    if (!state.projection) showState(el('div.public-loading', {}, spinner(), el('p', {}, t(state.pendingTries ? 'public.preparing' : 'public.loading'))));
    try {
      const result = await fetchPublic(puter, link, { etag: state.projection ? state.etag : null, signal: controller.signal });
      if (controller.signal.aborted) return;
      state.fetchedAt = Date.now(); state.pendingTries = 0;
      if (result.notModified) { if (manual) live.textContent = t('public.upToDate'); return; }
      state.etag = result.etag;
      state.projection = cleanJourneyProjection(result.data);
      render(state.projection);
      if (manual) live.textContent = t('public.refreshed');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error?.code === 'snapshot_pending' && state.pendingTries < PENDING_RETRIES) {
        state.pendingTries++;
        retryTimer = setTimeout(() => void load(), Math.min(10, error.retryAfter ?? 2) * 1000);
        return;
      }
      if (!state.projection || error?.status === 404) { state.projection = null; showFailure(error); } else live.textContent = failure(error).body;
    } finally {
      state.loading = false;
      refresh.setAttribute('aria-busy', 'false');
    }
  }

  const visible = () => { if (document.visibilityState === 'visible' && Date.now() - state.fetchedAt > REFRESH_AFTER) void load(); };
  const online = () => { if (!state.projection) void load(); };
  document.addEventListener('visibilitychange', visible);
  globalThis.addEventListener?.('online', online);
  if (initial?.data) {
    state = { ...state, etag: initial.etag ?? null, fetchedAt: Date.now(), projection: cleanJourneyProjection(initial.data) };
    render(state.projection);
  } else await load();
  root.querySelector('h1')?.focus({ preventScroll: true });

  return () => {
    clearTimeout(retryTimer);
    stop();
    clearView();
    images.destroy();
    document.removeEventListener('visibilitychange', visible);
    globalThis.removeEventListener?.('online', online);
    signal?.removeEventListener('abort', stop);
  };
}
