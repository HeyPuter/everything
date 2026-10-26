// Read-only viewer for a public collection link (`#/s/…` when the projection's kind is `collection`). No credentials.
import '../trip/places/places.css';
import './collections.css';
import '../public/public.css';
import { el, safeURL } from '../../ui/dom.js';
import { button, emptyState, iconButton, spinner } from '../../ui/bits.js';
import { markdown } from '../../ui/md.js';
import { t } from '../../lib/i18n/index.js';
import { fetchPublic } from '../../lib/api.js';
import { validateEntity } from '../../shared/schema/index.js';
import { isId } from '../../shared/ids.js';
import { categoryOf } from '../../lib/categories.js';
import { swatch } from '../trip/places/catmanager.js';
import { failure } from '../public/index.js';
import { icon as refreshIcon } from '../trip/members/icons.js';
import { collectionBadge, colorValue, placeCount } from './metaform.js';
import { statusChip } from './sheet.js';
import { sortSaved } from './model.js';

const TYPES = new Set(['saved', 'label']);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The `GET /pub` body of a collection, checked as untrusted input: schema-valid saved places and labels, http(s) cover. */
export function cleanCollectionProjection(data) {
  const value = data && typeof data === 'object' ? data : {};
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
  const ents = [];
  for (const entity of Array.isArray(value.ents) ? value.ents : []) {
    if (!entity || typeof entity !== 'object' || !TYPES.has(entity.t) || !isId(entity.id)) continue;
    const { t: type, id, cr, ...fields } = entity;
    try { validateEntity('collection', type, fields); } catch { continue; }
    ents.push(Object.freeze({ ...fields, t: type, id, ...(Number.isSafeInteger(cr) ? { cr } : {}) }));
  }
  const cover = safeURL(meta.cover?.url);
  return Object.freeze({
    meta: Object.freeze({
      name: text(meta.name, 200), desc: text(meta.desc, 100_000),
      color: Number.isInteger(meta.color) ? meta.color : undefined, icon: typeof meta.icon === 'string' ? meta.icon : undefined,
      ...(cover ? { cover: { url: cover, credit: text(meta.cover.credit, 500) } } : {}),
    }),
    saved: Object.freeze(ents.filter((entity) => entity.t === 'saved')),
    labels: new Map(ents.filter((entity) => entity.t === 'label').map((entity) => [entity.id, entity])),
  });
}

function placeRow(item, labels) {
  const category = categoryOf(null, item.cat);
  const own = (item.labels ?? []).map((id) => labels.get(id)).filter(Boolean);
  return el('li.col-row.col-public-row', { dataset: { id: item.id } },
    el('div.col-row-main', {}, swatch(category, 18),
      el('span.col-row-text', {},
        el('span.col-row-name', {}, item.name),
        el('span.col-row-meta', {}, statusChip(item.status), el('span.col-hint', {}, category.name),
          own.map((entry) => el('span.col-label-chip', { style: { '--col-color': colorValue(entry.color) } }, el('span.col-dot', { 'aria-hidden': 'true' }), entry.name))),
        item.address && el('span.col-row-sub', {}, item.address),
        item.desc && el('div.col-public-desc', {}, markdown(item.desc)))));
}

/** Mounts the viewer from a `fetchPublic` result already in hand. Returns a cleanup function. */
export function mountPublicCollection(container, { route, puter, signal, initial }) {
  const link = { worker: route.worker, space: route.space, token: route.token };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let etag = initial?.etag ?? null;
  let loading = false;

  const refresh = iconButton('more', t('public.refresh'), { onclick: () => void load() });
  refresh.replaceChildren(refreshIcon('refresh'));
  const live = el('p.sr-only', { role: 'status' });
  const body = el('main.public-body');
  container.replaceChildren(el('div.public-view.col-public', {},
    el('header.public-head', {},
      el('a.public-brand', { href: '#/' }, el('img', { src: new URL('icons/icon-192.png', document.baseURI).href, width: 28, height: 28, alt: '' }), el('span', {}, t('public.openApp'))),
      el('span.chip.public-badge', {}, t('collections.publicBadge')), el('span.public-spacer'), refresh),
    live, body, el('footer.public-foot', {}, el('p', {}, t('collections.publicFooter')))));

  function render(data) {
    const { meta, saved, labels } = cleanCollectionProjection(data);
    const places = sortSaved(saved, 'order');
    body.replaceChildren(
      el('section.public-hero', {},
        meta.cover && el('img.public-cover', { src: meta.cover.url, alt: '', referrerPolicy: 'no-referrer', decoding: 'async', onerror: (event) => { event.target.hidden = true; } }),
        el('div.public-hero-text', {},
          el('div.col-public-title', {}, collectionBadge(meta, 40), el('h1.public-title', { tabIndex: -1 }, meta.name || t('collections.untitled'))),
          el('p.public-sub', {}, placeCount(places.length)),
          meta.desc && el('div.public-description', {}, markdown(meta.desc)),
          meta.cover?.credit && el('p.public-sub', {}, t('public.coverCredit', { credit: meta.cover.credit })))),
      places.length
        ? el('section.col-public-places', { 'aria-label': t('collections.publicPlaces') }, el('ul.col-rows', {}, places.map((item) => placeRow(item, labels))))
        : el('div.public-state', {}, emptyState({ title: t('collections.allEmpty'), body: t('collections.placesEmptyViewer'), icon: 'pin' })));
  }
  function showFailure(error) {
    const info = failure(error);
    body.replaceChildren(el('div.public-state', { role: 'alert' }, emptyState({ title: info.title, body: info.body, icon: info.retry ? 'warning' : 'pin',
      action: info.retry ? button(t('public.retry'), { variant: 'primary', onclick: () => void load() }) : null })));
  }
  async function load() {
    if (loading || controller.signal.aborted) return;
    loading = true;
    refresh.setAttribute('aria-busy', 'true');
    try {
      const result = await fetchPublic(puter, link, { etag, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.notModified) { live.textContent = t('public.upToDate'); return; }
      etag = result.etag;
      render(result.data);
      live.textContent = t('public.refreshed');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error?.status === 404) showFailure(error);
      else live.textContent = failure(error).body;
    } finally {
      loading = false;
      refresh.setAttribute('aria-busy', 'false');
    }
  }

  if (initial?.data) render(initial.data);
  else body.replaceChildren(el('div.public-loading', {}, spinner(), el('p', {}, t('public.loading'))));
  container.querySelector('h1')?.focus({ preventScroll: true });
  return () => { stop(); signal?.removeEventListener('abort', stop); };
}
