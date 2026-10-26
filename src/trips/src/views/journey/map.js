// Journey map: numbered pins in story order joined by a dashed line, suggestions and linked trips' places as hollow
// points, optional GPX tracks from linked trips, a card carousel and a day scrubber.
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { toast } from '../../ui/toast.js';
import { isDark, onThemeChange } from '../../ui/theme.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../lib/format.js';
import { displayLocale, mapPrefs, prefersReducedMotion } from '../../lib/prefs.js';
import { fileBlob } from '../../lib/files/index.js';
import { createTripMap } from '../../map/index.js';
import { DEFAULT_CONFIG } from '../../services/core.js';
import { connector, isSuggestion, writtenEntries } from './model.js';
import { liveMedia, mediaTile } from './media.js';
import { peek } from './spaces.js';

const located = (entry) => Number.isFinite(entry?.loc?.lat) && Number.isFinite(entry?.loc?.lng);
const point = (id, lng, lat, properties) => ({ type: 'Feature', id, properties: { id, ...properties }, geometry: { type: 'Point', coordinates: [lng, lat] } });
const collection = (features) => ({ type: 'FeatureCollection', features });
const tracks = new Map();
const MAX_TRACKS = 10;

/** Line features from a gzipped GeoJSON track file. */
async function trackLines(blob) {
  const text = typeof DecompressionStream === 'function' ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text() : null;
  if (!text) return [];
  const data = JSON.parse(text);
  const features = data?.type === 'FeatureCollection' ? data.features : data?.type === 'Feature' ? [data] : [];
  return features.filter((feature) => ['LineString', 'MultiLineString'].includes(feature?.geometry?.type))
    .map((feature) => ({ type: 'Feature', properties: { tone: 'day-2' }, geometry: feature.geometry }));
}

/**
 * `ctx`: `{space, context, ui, onOpen(entry), signal}`. Returns `{render(), focus(id), destroy()}`.
 * `ui.hideSuggestions` hides suggestion points too.
 */
export function mountJourneyMap(container, ctx) {
  const { space, context, ui } = ctx;
  const services = context.session?.services ?? null;
  const controller = new AbortController();
  const canvas = el('div.jr-map-canvas');
  const loading = el('div.jr-map-loading', {}, spinner());
  const empty = el('p.jr-map-empty', { role: 'status', hidden: true }, t('journey.mapEmpty'));
  const scrubId = uid('jr-scrub');
  const scrubLabel = el('output.jr-scrub-value', { htmlFor: scrubId });
  const scrub = el('input.jr-scrub', { id: scrubId, type: 'range', min: 0, max: 0, value: 0, step: 1, 'aria-label': t('journey.scrubber') });
  const scrubber = el('div.jr-scrubber', {}, el('label.field-label', { htmlFor: scrubId }, t('journey.scrubber')), scrub, scrubLabel);
  const carousel = el('ul.jr-carousel', { 'aria-label': t('journey.mapCards') });
  const root = el('div.jr-map', {}, el('div.jr-map-stage', {}, canvas, loading, empty), scrubber, carousel);
  container.replaceChildren(root);
  const cleanups = [];
  let map = null;
  let framed = false;
  let selected = null;
  let dates = [];
  let pins = [];
  let destroyed = false;
  let tripPlaces = [];
  let trackFeatures = [];
  const motion = () => (prefersReducedMotion() ? 0 : 400);
  const theme = () => mapPrefs().theme ?? (isDark() ? 'dark' : 'light');

  async function start() {
    try {
      const config = services?.context?.loadConfig ? await services.context.loadConfig() : DEFAULT_CONFIG;
      if (controller.signal.aborted) return;
      map = await createTripMap(canvas, { t, theme: theme(), config, language: displayLocale(), signal: controller.signal,
        onError: (error) => { if (error instanceof Error) toast(t('journey.mapStyleFailed')); } });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      loading.remove();
      canvas.replaceChildren(emptyState({ title: t('journey.mapFailed'), body: t('journey.mapFailedBody'), icon: 'warning',
        action: button(t('journey.retry'), { variant: 'primary', onclick: () => { canvas.replaceChildren(); root.querySelector('.jr-map-stage').append(loading); void start(); } }) }));
      return;
    }
    loading.remove();
    cleanups.push(() => map?.destroy());
    cleanups.push(map.onClick('jr-entries', (feature) => select(String(feature.id), { fly: false })));
    cleanups.push(map.onClick('jr-suggest', (feature) => select(String(feature.id), { fly: false })));
    cleanups.push(onThemeChange(() => { if (map) void map.setTheme(theme()); }));
    draw();
    void loadLinked();
  }

  async function loadLinked() {
    const refs = space.get('meta', 'meta')?.trips ?? [];
    const places = [];
    const trackRefs = [];
    for (const ref of refs) {
      const found = await peek(context, ref, (trip) => trip.select.place.all().map((place) => ({ ...place, trip: ref }))).catch(() => null);
      for (const place of found ?? []) {
        if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) places.push(place);
        if (place.track?.fileId) trackRefs.push({ ref, fileId: place.track.fileId });
      }
    }
    if (destroyed) return;
    tripPlaces = places;
    if (space.get('meta', 'meta')?.showTracks && context.session?.api) {
      const lines = [];
      for (const { ref, fileId } of trackRefs.slice(0, MAX_TRACKS)) {
        const key = `${ref.w}/${ref.s}/${fileId}`;
        try {
          if (!tracks.has(key)) tracks.set(key, await trackLines(await fileBlob({ ...ref, k: 'trip' }, fileId, { api: context.session.api, signal: controller.signal })));
          lines.push(...tracks.get(key));
        } catch { /* a missing or unreadable track is skipped */ }
        if (destroyed) return;
      }
      trackFeatures = lines;
    } else trackFeatures = [];
    draw();
  }

  function draw() {
    if (destroyed) return;
    const entries = space.select.entry.all();
    pins = writtenEntries(entries).filter(located);
    const suggestions = ui.hideSuggestions ? [] : entries.filter((entry) => isSuggestion(entry) && !entry.dismissed && located(entry));
    dates = [...new Set(pins.map((entry) => entry.date))];
    renderCards();
    renderScrubber();
    if (!map) return;
    map.setTracks('jr-tracks', collection(trackFeatures));
    map.setPois('jr-trip-places', collection(tripPlaces.map((place) => point(`${place.trip.s}-${place.id}`, place.lng, place.lat, { tone: 'ink-3', title: place.name }))), { radius: 4, interactive: false });
    map.setPois('jr-suggest', collection(suggestions.map((entry) => point(entry.id, entry.loc.lng, entry.loc.lat, { tone: 'ink-2', title: entry.title }))), { radius: 6 });
    const line = connector(entries);
    map.setRoutes('jr-route', collection(line.length > 1 ? [{ type: 'Feature', properties: { tone: 'accent', estimated: true }, geometry: { type: 'LineString', coordinates: line } }] : []));
    map.setMarkers('jr-entries', collection(pins.map((entry, index) => point(entry.id, entry.loc.lng, entry.loc.lat, { tone: 'accent', order: index + 1, title: entry.title }))), { cluster: false, selected });
    const all = [...pins.map((entry) => [entry.loc.lng, entry.loc.lat]), ...suggestions.map((entry) => [entry.loc.lng, entry.loc.lat])];
    empty.hidden = all.length > 0;
    if (all.length && !framed) { map.fit(all, { padding: 48, duration: 0, maxZoom: 13 }); framed = true; }
  }

  function renderCards() {
    carousel.replaceChildren(...pins.map((entry, index) => {
      const media = liveMedia(space, entry);
      return el('li.jr-card', { dataset: { id: entry.id }, 'aria-current': entry.id === selected ? 'true' : null },
        el('button.jr-card-button', { type: 'button', onclick: () => select(entry.id), 'aria-label': t('journey.showOnMap', { title: entry.title }) },
          media[0] ? mediaTile(space, media[0]) : el('span.jr-card-num.num', { 'aria-hidden': 'true' }, formatNumber(index + 1)),
          el('span.jr-card-text', {}, el('span.jr-card-title', {}, entry.title), el('span.jr-muted', {}, [formatDate(entry.date, { year: false }), entry.loc.name].filter(Boolean).join(' · ')))),
        el('button.jr-link', { type: 'button', onclick: () => ctx.onOpen(entry) }, t('journey.openEntry')));
    }));
    carousel.hidden = !pins.length;
  }

  function renderScrubber() {
    scrubber.hidden = dates.length < 2;
    scrub.max = String(Math.max(0, dates.length - 1));
    const at = Math.max(0, dates.indexOf(space.get('entry', selected)?.date ?? dates[0]));
    scrub.value = String(at);
    setScrubLabel(at);
  }
  function setScrubLabel(index) {
    const text = dates[index] ? t('journey.scrubDay', { date: formatDate(dates[index], { weekday: true }), number: formatNumber(index + 1), count: formatNumber(dates.length) }) : '';
    scrubLabel.textContent = text;
    scrub.setAttribute('aria-valuetext', text);
  }
  scrub.addEventListener('input', () => {
    const index = Number(scrub.value);
    setScrubLabel(index);
    const day = pins.filter((entry) => entry.date === dates[index]);
    if (!day.length) return;
    selectQuiet(day[0].id);
    if (map) map.fit(day.map((entry) => [entry.loc.lng, entry.loc.lat]), { padding: 64, duration: motion(), maxZoom: 14 });
  });

  function selectQuiet(id) {
    selected = id;
    if (map && pins.some((entry) => entry.id === id)) map.setSelected('jr-entries', id);
    for (const card of carousel.children) card.toggleAttribute('aria-current', card.dataset.id === id);
    [...carousel.children].find((card) => card.dataset.id === id)?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: motion() ? 'smooth' : 'auto' });
  }
  function select(id, { fly = true } = {}) {
    const entry = space.get('entry', id);
    if (!entry) return;
    selectQuiet(id);
    if (isSuggestion(entry)) { ctx.onOpen(entry); return; }
    const index = dates.indexOf(entry.date);
    if (index >= 0) { scrub.value = String(index); setScrubLabel(index); }
    if (fly && map && located(entry)) map.fit([[entry.loc.lng, entry.loc.lat]], { padding: 80, duration: motion(), maxZoom: 15 });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    controller.abort();
    for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* keep tearing down */ } }
    container.replaceChildren();
  }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  void start();
  return { render: draw, focus: (id) => select(id), destroy, resize: () => map?.resize() };
}
