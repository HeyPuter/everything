import './public.css';
import { el } from '../../ui/dom.js';
import { button, emptyState, iconButton, spinner } from '../../ui/bits.js';
import { tabs } from '../../ui/tabs.js';
import { markdown } from '../../ui/md.js';
import { availableLocales, locale, setLocale, t } from '../../lib/i18n/index.js';
import { formatDateRange, formatInstant } from '../../lib/format.js';
import { fetchPublic } from '../../lib/api.js';
import { createServices } from '../../services/index.js';
import { createPlanState } from '../trip/plan/state.js';
import { icon } from '../trip/plan/icons.js';
import { icon as refreshIcon } from '../trip/members/icons.js';
import { cleanProjection, personName, readOnlySpace } from './data.js';
import { attachments, createFiles, filesByEntity, remoteImage } from './files.js';
import { renderItinerary } from './itinerary.js';
import { renderBookings } from './bookings.js';
import { renderPacking } from './packing.js';
import { renderCosts } from './costs.js';
import { renderChat } from './chat.js';
import { journeyCard, mountPublicRoad } from './combined/index.js';

const REFRESH_AFTER = 60_000;
const PENDING_RETRIES = 10;
const SECTIONS = Object.freeze([
  { id: 'plan', icon: 'calendar', when: (share) => share.plan },
  { id: 'map', icon: 'map', when: (share) => share.map },
  { id: 'bookings', icon: 'plane', when: (share) => share.bookings },
  { id: 'packing', icon: 'backpack', when: (share) => share.packing },
  { id: 'costs', icon: 'wallet', when: (share) => share.costs },
  { id: 'chat', icon: 'users', when: (share) => share.chat },
  { id: 'road', icon: 'map', label: 'publicLink.tabRoad', when: (share, projection) => share.road && projection.meta.settings?.addons?.roadtrip === true },
  { id: 'journey', icon: 'calendar', label: 'publicLink.tabJourney', when: (_share, projection) => Boolean(projection.journey) },
]);
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

/** Messages for a failed load: `{title, body, retry}`; `retry` is false when trying again cannot help. */
export function failure(error, { online = globalThis.navigator?.onLine !== false } = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (status === 404 || error?.code === 'invalid_public_link' || error?.code === 'untrusted_worker') return { title: t('public.goneTitle'), body: t('public.goneBody'), retry: false };
  if (status === 429) {
    const seconds = Number.isFinite(error?.retryAfter) && error.retryAfter > 0 ? Math.ceil(error.retryAfter) : 0;
    return { title: t('public.rateTitle'), body: seconds ? t('public.rateBodyIn', { seconds: new Intl.NumberFormat().format(seconds) }) : t('public.rateBody'), retry: true };
  }
  if (status === 402 || error?.code === 'owner_credit') return { title: t('public.creditTitle'), body: t('public.creditBody'), retry: true };
  if (!online || status === 0) return { title: t('public.offlineTitle'), body: t('public.offlineBody'), retry: true };
  return { title: t('public.errorTitle'), body: t('public.errorBody'), retry: true };
}

/** Read-only viewer for `#/s/<worker>/<space>/<token>`. Works signed out; never sends credentials. */
export async function mount(container, context) {
  const { route, signal } = context;
  const puter = context.puter;
  const link = { worker: route.worker, space: route.space, token: route.token };
  const ref = { w: route.worker, s: route.space, k: 'trip' };
  const win = globalThis.window;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const files = createFiles({ puter, link, signal: controller.signal });
  let services = null;
  try { services = createServices({ userId: 'public-viewer' }); } catch { /* Costs show trip amounts only and routes stay estimates. */ }
  const plan = createPlanState();
  let state = { etag: null, projection: null, fetchedAt: 0, loading: false, pendingTries: 0 };
  let selected = null;
  let teardown = [];
  let retryTimer = 0;
  // Journey and collection links get their own viewers (views/journey/public, views/collections/public.js).
  let journey = null;

  const refresh = iconButton('refresh', t('public.refresh'), { onclick: () => void load({ manual: true }) });
  refresh.replaceChildren(refreshIcon('refresh'));
  // Viewers have no account; the choice stays on this device and the shell redraws the page.
  const language = el('select.select.public-language', { 'aria-label': t('public.language'), onchange: () => void setLocale(language.value) },
    availableLocales().map((entry) => el('option', { value: entry.tag, lang: entry.tag }, entry.name)));
  language.value = locale;
  const live = el('p.sr-only', { role: 'status' });
  const body = el('div.public-body');
  const root = el('div.public-view', {},
    el('header.public-head', {},
      el('a.public-brand', { href: '#/' }, el('img', { src: new URL('icons/icon-192.png', document.baseURI).href, width: 28, height: 28, alt: '' }), el('span', {}, t('public.openApp'))),
      el('span.chip.public-badge', {}, t('public.badge')), el('span.public-spacer'), language, refresh),
    el('main.public-main', {}, live, body),
    el('footer.public-foot', {}, el('p', {}, t('public.footer'))));
  container.replaceChildren(root);

  function clearView() { for (const off of teardown.splice(0)) { try { off(); } catch { /* keep tearing down */ } } }

  function showState(node) { clearView(); body.replaceChildren(node); }
  function showLoading(key) { showState(el('div.public-loading', {}, spinner(), el('p', {}, t(key)))); }
  function showFailure(error) {
    const info = failure(error);
    const action = info.retry ? button(t('public.retry'), { variant: 'primary', onclick: () => void load({ manual: true }) }) : null;
    // Nothing else is on the page, so the state's title is its h1.
    const state = emptyState({ title: info.title, body: info.body, icon: info.retry ? 'warning' : 'pin', action });
    state.querySelector('h3')?.replaceWith(el('h1.public-state-title', {}, info.title));
    showState(el('div.public-state', { role: 'alert' }, state));
  }

  function hero(projection, space) {
    const { meta, share } = projection;
    const cover = typeof meta.cover === 'string'
      ? remoteImage(files, meta.cover, { className: 'public-cover' })
      : meta.cover?.url ? el('img.public-cover', { src: meta.cover.url, alt: '', referrerPolicy: 'no-referrer', decoding: 'async', onerror: (event) => { event.target.hidden = true; } }) : null;
    const dates = formatDateRange(meta.start, meta.end, { style: 'long' });
    const travelers = [...space.members().map((member) => member.name), ...space.select.guest.all().map((guest) => t('public.guestName', { name: guest.name }))];
    let expiry = '';
    if (share.exp) { try { expiry = formatInstant(share.exp, localZone(), { style: 'medium' }); } catch { expiry = ''; } }
    return el('section.public-hero', {},
      cover,
      el('div.public-hero-text', {},
        el('h1.public-title', { tabIndex: -1 }, meta.title || t('public.untitled')),
        dates && el('p.public-dates', {}, icon('calendar-range', 16), dates),
        travelers.length > 0 && el('p.public-travelers', {}, icon('users', 16), el('span', {}, travelers.join(', '))),
        meta.description && el('div.public-description', {}, markdown(meta.description)),
        meta.cover?.credit && el('p.public-sub', {}, t('public.coverCredit', { credit: meta.cover.credit })),
        expiry && el('p.public-hint', {}, t('public.expires', { date: expiry })),
        attachments(files, share.files ? filesByEntity(projection).get('meta:meta')?.filter((file) => file.id !== meta.cover) ?? [] : [])));
  }

  function render(projection) {
    clearView();
    const space = readOnlySpace(projection, ref);
    const byEntity = filesByEntity(projection);
    const people = (id) => personName(space, id, { former: t('public.formerMember'), guest: (name) => t('public.guestName', { name }) });
    const ctx = {
      space, share: projection.share, people, files, fx: services?.fx ?? null, signal: controller.signal,
      filesFor: (key) => (projection.share.files ? byEntity.get(key) ?? [] : []),
      onLocate: projection.share.map ? ({ id }) => { plan.set({ place: id }); view?.select('map'); } : null,
    };
    const items = SECTIONS.filter((section) => section.when(projection.share, projection));
    let mapMounted = false;
    const mapSlot = el('div.public-map');
    const renderers = { plan: renderItinerary, bookings: renderBookings, packing: renderPacking, costs: renderCosts, chat: renderChat };
    const roadSlot = el('div.public-road');
    let roadMounted = false;
    const mountRoadOnce = () => {
      if (roadMounted) return;
      roadMounted = true;
      const roadController = new AbortController();
      teardown.push(() => roadController.abort());
      void mountPublicRoad(roadSlot, { space, plan, services, signal: roadController.signal }).then((destroy) => teardown.push(destroy));
    };
    const content = (id) => {
      if (id === 'map') return mapSlot;
      if (id === 'road') return roadSlot;
      if (id === 'journey') return journeyCard({ link: projection.journey, puter, signal: controller.signal });
      try { return renderers[id](ctx); } catch { return el('p.public-empty', { role: 'alert' }, t('public.sectionError')); }
    };
    async function mountMapOnce() {
      if (mapMounted) return;
      mapMounted = true;
      const mapController = new AbortController();
      teardown.push(() => mapController.abort());
      try {
        const { mountMap } = await import('../trip/map/index.js');
        if (mapController.signal.aborted) return;
        const session = services ? { services: { route: services.route, context: services.context } } : null;
        const destroy = mountMap(mapSlot, { space, plan, session, ref, signal: mapController.signal });
        teardown.push(destroy);
      } catch { mapSlot.replaceChildren(el('p.public-empty', { role: 'alert' }, t('public.mapFailed'))); }
    }
    let view = null;
    if (items.length) {
      view = tabs({
        label: t('public.sections'), value: items.some((item) => item.id === selected) ? selected : items[0].id,
        // A hidden h2 per panel keeps the cards' h3 headings in order under the trip title.
        items: items.map((item) => {
          const label = t(item.label ?? `public.tab.${item.id}`);
          return { id: item.id, icon: item.icon, label, content: [el('h2.sr-only', {}, label), content(item.id)] };
        }),
        onChange: (id) => { selected = id; if (id === 'map') void mountMapOnce(); if (id === 'road') mountRoadOnce(); },
      });
      selected = view.value;
      if (selected === 'map') void mountMapOnce();
      if (selected === 'road') mountRoadOnce();
    }
    teardown.push(plan.on('openPlace', ({ id }) => {
      if (!view || !items.some((item) => item.id === 'plan')) return;
      view.select('plan');
      body.querySelector(`[data-place="${CSS.escape(String(id))}"]`)?.scrollIntoView?.({ block: 'center' });
    }));
    let nothing = null;
    if (!view) {
      nothing = emptyState({ title: t('public.nothingTitle'), body: t('public.nothingBody'), icon: 'pin' });
      nothing.querySelector('h3')?.replaceWith(el('h2.public-state-title', {}, t('public.nothingTitle')));
    }
    body.replaceChildren(hero(projection, space), view ? view.element : el('div.public-state', {}, nothing));
  }

  async function load({ manual = false } = {}) {
    if (state.loading || controller.signal.aborted) return;
    clearTimeout(retryTimer);
    state.loading = true;
    refresh.setAttribute('aria-busy', 'true');
    if (!state.projection) showLoading(state.pendingTries ? 'public.preparing' : 'public.loading');
    try {
      const result = await fetchPublic(puter, link, { etag: state.projection ? state.etag : null, signal: controller.signal });
      if (controller.signal.aborted) return;
      state.fetchedAt = Date.now(); state.pendingTries = 0;
      if (result.notModified) { if (manual) live.textContent = t('public.upToDate'); return; }
      state.etag = result.etag;
      if (result.data?.kind === 'journey') { journey = import('../journey/public/index.js').then((module) => module.mountPublicJourney(container, { ...context, initial: result })); return; }
      if (result.data?.kind === 'collection') { journey = import('../collections/public.js').then((module) => module.mountPublicCollection(container, { ...context, initial: result })); return; }
      state.projection = cleanProjection(result.data);
      render(state.projection);
      if (manual) live.textContent = t('public.refreshed');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error?.code === 'snapshot_pending' && state.pendingTries < PENDING_RETRIES) {
        state.pendingTries++;
        showLoading('public.preparing');
        retryTimer = setTimeout(() => void load(), Math.min(10, error.retryAfter ?? 2) * 1000);
        return;
      }
      // A link that stopped working replaces what was shown; other failures keep it.
      if (!state.projection || error?.status === 404) { state.projection = null; showFailure(error); }
      else live.textContent = failure(error).body;
    } finally {
      state.loading = false;
      refresh.setAttribute('aria-busy', 'false');
    }
  }

  const visible = () => { if (!journey && document.visibilityState === 'visible' && Date.now() - state.fetchedAt > REFRESH_AFTER) void load(); };
  const online = () => { if (!journey && !state.projection) void load(); };
  document.addEventListener('visibilitychange', visible);
  win?.addEventListener('online', online);
  await load();
  if (!journey) root.querySelector('h1')?.focus({ preventScroll: true });

  return () => {
    void journey?.then((cleanup) => cleanup?.()).catch(() => {});
    clearTimeout(retryTimer);
    stop();
    clearView();
    files.destroy();
    document.removeEventListener('visibilitychange', visible);
    win?.removeEventListener('online', online);
    signal?.removeEventListener('abort', stop);
  };
}
