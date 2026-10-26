// "All saved": every place across the member's collections, read from local replicas, with filters and a map.
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, skeleton } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { spaceRoute } from '../../shared/protocol.js';
import { categoryOf } from '../../lib/categories.js';
import { swatch } from '../trip/places/catmanager.js';
import { icon } from './icons.js';
import { STATUSES, filterSaved, sortSaved } from './model.js';
import { collectionBadge } from './metaform.js';
import { statusChip } from './sheet.js';
import { mountSavedMap } from './map.js';
import { peek, uidOf } from './spaces.js';
import { FOCUS_KEY } from './detail.js';

const LIMIT = 60;
const NO_SPACE = Object.freeze({ get: () => null });

export function mountAllSaved(container, context) {
  const { app, collections: entries = [], onBack, session } = context;
  const me = uidOf(context);
  const ui = { query: '', statuses: new Set(), view: 'list' };
  let items = [];
  let missing = 0;
  let loading = true;
  let map = null;
  let destroyed = false;
  const titleId = uid('col-all');
  const search = el('input.input', { type: 'search', placeholder: t('collections.searchPlaceholder'), 'aria-label': t('collections.search'), oninput: () => { ui.query = search.value; render(); } });
  const statusBar = el('div.col-status-filter', { role: 'group', 'aria-label': t('collections.statusFilter') });
  const switcher = segmented({ label: t('collections.viewLabel'), value: 'list', items: [{ value: 'list', label: t('collections.viewList') }, { value: 'map', label: t('collections.viewMap') }],
    onChange: (value) => { ui.view = value; layout(); } });
  const list = el('ul.col-rows', { 'aria-labelledby': titleId });
  const note = el('p.col-hint', { role: 'status' });
  const listPane = el('div.col-list-pane', {}, list);
  const mapPane = el('div.col-map-pane');
  const root = el('section.col-view.col-detail.col-all-saved', { 'aria-labelledby': titleId, dataset: { view: 'list', wide: 'false' } },
    el('header.col-detail-head', {}, el('button.icon-btn.col-back', { type: 'button', 'aria-label': t('collections.back'), title: t('collections.back'), onclick: () => onBack?.() }, icon('arrowLeft')),
      el('span.col-badge.col-badge-all', { 'aria-hidden': 'true' }, icon('all', 20)),
      el('div.col-title-block', {}, el('h2.col-detail-title', { id: titleId, tabIndex: -1 }, t('collections.allSaved')), note)),
    el('div.col-toolbar', {}, el('div.input-prefix.col-search', {}, icon('search'), search)),
    statusBar, el('div.col-switch', {}, switcher.element), el('div.col-body', {}, listPane, mapPane));
  container.replaceChildren(root);
  root.querySelector('h2').focus({ preventScroll: true });

  function open(item) {
    try { sessionStorage.setItem(FOCUS_KEY, `${item.ref.s}:${item.savedId}`); } catch { /* storage may be off */ }
    app?.navigate(`${spaceRoute(item.ref)}/places`);
  }
  const shown = () => sortSaved(filterSaved(items, { ...ui, uid: me }), 'name');
  function render() {
    if (destroyed) return;
    if (loading) { list.replaceChildren(el('li', {}, skeleton('70%')), el('li', {}, skeleton('50%'))); return; }
    const visible = shown();
    note.textContent = [t('collections.allCount', { count: formatNumber(items.length), lists: formatNumber(entries.length) }), missing ? t('collections.allMissing', { count: formatNumber(missing) }) : ''].filter(Boolean).join(' · ');
    const focused = statusBar.contains(document.activeElement) ? document.activeElement.dataset.status : null;
    statusBar.replaceChildren(...STATUSES.map((status) => el('button.col-status-toggle', { type: 'button', 'aria-pressed': String(ui.statuses.has(status)), dataset: { status },
      onclick: () => { if (ui.statuses.has(status)) ui.statuses.delete(status); else ui.statuses.add(status); render(); } },
    t(`collections.status.${status}`), el('span.col-status-count.num', {}, formatNumber(items.filter((item) => item.status === status).length)))));
    if (focused) statusBar.querySelector(`[data-status="${focused}"]`)?.focus({ preventScroll: true });
    list.replaceChildren(...visible.map((item) => el('li.col-row', {},
      el('button.col-row-main', { type: 'button', onclick: () => open(item) },
        swatch(categoryOf(NO_SPACE, item.cat), 18),
        el('span.col-row-text', {}, el('span.col-row-name', {}, item.name),
          el('span.col-row-meta', {}, statusChip(item.status), el('span.col-row-list', {}, collectionBadge(item.meta, 16), item.listName)),
          item.address && el('span.col-row-sub', {}, item.address))))));
    if (!visible.length) list.replaceChildren(el('li', {}, emptyState({ title: t(items.length ? 'collections.noMatches' : 'collections.allEmpty'), body: items.length ? '' : t('collections.allEmptyBody'), icon: 'heart',
      action: !items.length && onBack ? button(t('collections.back'), { variant: 'outline', onclick: () => onBack() }) : null })));
    map?.update();
  }
  function layout() {
    root.dataset.view = ui.view;
    if (ui.view === 'map' && !map) {
      map = mountSavedMap(mapPane, { space: NO_SPACE, services: session?.services ?? null, items: shown, label: (item) => item.listName, onOpen: (id) => { const item = items.find((entry) => entry.id === id); if (item) open(item); } });
    }
    if (ui.view === 'map') requestAnimationFrame(() => map?.resize());
  }
  async function load() {
    const queue = entries.slice(0, LIMIT);
    const out = [];
    let unread = Math.max(0, entries.length - LIMIT);
    async function next() {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const result = await peek(context, entry.ref, (space) => ({ meta: space.get('meta', 'meta'), saved: space.select.saved.all() })).catch(() => null);
        if (!result?.meta) { unread++; continue; }
        for (const saved of result.saved) {
          out.push({ ...saved, id: `${entry.ref.s}:${saved.id}`, savedId: saved.id, ref: entry.ref, meta: result.meta, listName: result.meta.name || entry.title || t('collections.untitled') });
        }
      }
    }
    await Promise.all([next(), next(), next(), next()]);
    if (destroyed) return;
    items = out; missing = unread; loading = false;
    render();
  }
  render();
  void load();
  return () => { destroyed = true; map?.destroy(); };
}
