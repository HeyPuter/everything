// `#/c/<worker>/<space>/<tab>`: one collection with its places as a list and a map, filters, bulk actions and sharing.
import { el, uid as uniqueId, safeURL, append, clear } from '../../ui/dom.js';
import { button, iconButton, emptyState, spinner } from '../../ui/bits.js';
import { checkbox, segmented } from '../../ui/fields.js';
import { makeSortable } from '../../ui/dnd.js';
import { markdown } from '../../ui/md.js';
import { openMenu } from '../../ui/menu.js';
import { openModal, confirmDialog, promptDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { openConflictDialog } from '../../ui/conflict.js';
import { t, strings } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { can } from '../../shared/perms.js';
import { spaceRoute } from '../../shared/protocol.js';
import { BUILTIN_CATEGORIES, categoryOf } from '../../lib/categories.js';
import { swatch } from '../trip/places/catmanager.js';
import { openPlaceForm } from '../trip/places/form.js';
import { photoFigure } from '../trip/places/detail.js';
import { roleIn } from '../trip/members/logic.js';
import { icon } from './icons.js';
import { SORTS, STATUSES, appendOrders, averageRating, filterSaved, isVisitedBy, moveOrder, myTags, sortSaved } from './model.js';
import { collectionBadge, colorValue, metaPatch, openMetaForm, placeCount } from './metaform.js';
import { openLabelManager } from './labels.js';
import { openSavedSheet, statusChip } from './sheet.js';
import { openSharing } from './sharing.js';
import { mountSavedMap } from './map.js';
import { chooseImport, exportCollection, importOps } from './io.js';
import { addToTrip, copyToCollection, markVisitedEverywhere, pickSpace, writableCollections, writableTrips } from './transfer.js';
import { createCollection, deleteCollection, errorText, openCollection, personalOf, uidOf } from './spaces.js';

export const FOCUS_KEY = 'trips:collections:focus';
const WIDE = 880;
const label = (key, fallback) => (Object.hasOwn(strings, key) ? t(key) : fallback);
const storageKey = (sid) => `trips:collection:${sid}`;
function readLocal(sid) {
  try { const value = JSON.parse(localStorage.getItem(storageKey(sid)) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function writeLocal(sid, value) { try { localStorage.setItem(storageKey(sid), JSON.stringify(value)); } catch { /* storage may be off */ } }
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const pendingCount = (state) => (Array.isArray(state?.pending) ? state.pending.length : Number(state?.pending) || 0);

export async function mountCollection(container, context) {
  const ref = context.route?.ref ?? context.ref;
  if (!ref || ref.k !== 'collection' || !context.session?.api) {
    container.replaceChildren(emptyState({ title: t('collections.title'), body: t('collections.unavailable'), icon: 'heart' }));
    return undefined;
  }
  container.replaceChildren(el('p.col-loading', { role: 'status' }, spinner(), t('collections.loading')));
  let view = null;
  let opened;
  try {
    opened = await openCollection(context, ref, { onError: (error) => view?.onError(error), onFlush: (result) => view?.onFlush(result) });
  } catch (error) {
    if (context.signal?.aborted) return undefined;
    container.replaceChildren(emptyState({ title: t('collections.loadFailed'), body: errorText(error), icon: 'warning',
      action: button(t('collections.back'), { variant: 'primary', onclick: () => context.app?.navigate('#/collections') }) }));
    return undefined;
  }
  if (context.signal?.aborted) { opened.close(); return undefined; }
  view = collectionView(container, { ...context, ref, space: opened.space, owned: opened.owned });
  return () => { view.destroy(); opened.close(); };
}

function collectionView(container, context) {
  const { space, ref, app, session, owned } = context;
  const me = uidOf(context);
  const personal = personalOf(context);
  const services = session?.services ?? null;
  const local = readLocal(ref.s);
  const ui = { query: '', statuses: new Set(), cats: new Set(), labels: new Set(), sort: SORTS.includes(local.sort) ? local.sort : 'order', view: local.view === 'map' ? 'map' : 'list', selecting: false, selected: new Set() };
  const offs = [];
  const dialogs = new Set();
  let shown = [];
  let frame = 0;
  let sortable = null;
  let map = null;
  let wide = false;
  let destroyed = false;
  let indexedTitle = null;
  const track = (dialog) => { dialogs.add(dialog); void dialog.closed.then(() => dialogs.delete(dialog)); return dialog; };

  const role = () => roleIn(space, me);
  const canEdit = () => can(role(), 'plan.edit');
  const canMeta = () => can(role(), 'trip.edit');
  const meta = () => space.get('meta', 'meta') ?? {};
  const name = () => meta().name || t('collections.untitled');
  const labelsById = () => new Map(space.select.label.all().map((item) => [item.id, item]));

  async function apply(ops, options) {
    if (!ops.length) return true;
    try { await space.apply(ops, options); return true; } catch (error) { toast(errorText(error)); return false; }
  }

  // ---- DOM
  const titleId = uniqueId('col-name');
  const badgeSlot = el('span.col-badge-slot');
  const heading = el('h2.col-detail-title', { id: titleId, tabIndex: -1 });
  const sub = el('p.col-sub');
  const addButton = button(t('collections.addPlace'), { icon: 'plus', variant: 'primary', size: 'sm', onclick: () => openForm() });
  const shareButton = button(t('collections.share'), { variant: 'outline', size: 'sm', onclick: () => track(openSharing({ space, context, ref, onLeft: () => app?.navigate('#/collections') })) });
  shareButton.prepend(icon('share', 16));
  const moreButton = iconButton('more', t('collections.moreCollection'), { onclick: () => collectionMenu(moreButton) });
  const about = el('div.col-about');
  const issue = el('div.col-issue', { hidden: true });
  const searchInput = el('input.input', { type: 'search', placeholder: t('collections.searchPlaceholder'), 'aria-label': t('collections.search'), autocomplete: 'off',
    oninput: () => { ui.query = searchInput.value; schedule(); } });
  const filterButton = button(t('collections.filters'), { size: 'sm', variant: 'outline', onclick: () => openFilters() });
  filterButton.prepend(icon('filter', 16));
  const sortSelect = el('select.select.col-sort', { 'aria-label': t('collections.sortLabel'), onchange: () => { ui.sort = sortSelect.value; writeLocal(ref.s, { ...readLocal(ref.s), sort: ui.sort }); schedule(); } },
    SORTS.map((value) => el('option', { value, selected: value === ui.sort }, t(`collections.sort.${value}`))));
  const statusBar = el('div.col-status-filter', { role: 'group', 'aria-label': t('collections.statusFilter') });
  const active = el('div.col-active');
  const bulk = el('div.col-bulk', { role: 'toolbar', 'aria-label': t('collections.bulkActions'), hidden: true });
  const switcher = segmented({ label: t('collections.viewLabel'), value: ui.view, items: [{ value: 'list', label: t('collections.viewList') }, { value: 'map', label: t('collections.viewMap') }],
    onChange: (value) => { ui.view = value; writeLocal(ref.s, { ...readLocal(ref.s), view: value }); layout(); } });
  const listId = uniqueId('col-list');
  const list = el('ul.col-rows', { id: listId, 'aria-labelledby': titleId });
  const empty = el('div.col-empty');
  const live = el('div.sr-only', { 'aria-live': 'polite' });
  const listPane = el('div.col-list-pane', {}, list, empty);
  const mapPane = el('div.col-map-pane');
  const root = el('section.col-view.col-detail', { 'aria-labelledby': titleId },
    el('header.col-detail-head', {},
      el('a.icon-btn.col-back', { href: '#/collections', 'aria-label': t('collections.back'), title: t('collections.back') }, icon('arrowLeft')),
      badgeSlot, el('div.col-title-block', {}, heading, sub),
      el('div.col-head-actions', {}, addButton, shareButton, moreButton)),
    about, issue,
    el('div.col-toolbar', {}, el('div.input-prefix.col-search', {}, icon('search'), searchInput), filterButton, sortSelect),
    statusBar, active, bulk, el('div.col-switch', {}, switcher.element),
    el('div.col-body', {}, listPane, mapPane), live);
  container.replaceChildren(root);
  const announce = (message) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = message; }); };

  // ---- header
  function renderHead() {
    const data = meta();
    badgeSlot.replaceChildren(collectionBadge(data, 44));
    heading.textContent = name();
    const count = space.select.saved.all().length;
    const people = space.members().filter((member) => member.role).length;
    const parts = [placeCount(count)];
    if (people > 1) parts.push(t('collections.sharedWith', { count: formatNumber(people - 1) }));
    if (role() && role() !== 'owner') parts.push(t(role() === 'editor' ? 'collections.roleEditor' : 'collections.roleViewer'));
    sub.textContent = parts.join(' · ');
    addButton.hidden = !canEdit();
    const links = (data.urls ?? []).map((link) => ({ ...link, url: safeURL(link.url) })).filter((link) => link.url);
    const cover = typeof data.cover === 'object' && data.cover?.url ? safeURL(data.cover.url) : null;
    append(clear(about), [
      cover ? el('figure.col-cover', {}, el('img', { src: cover, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (event) => event.target.closest('figure')?.remove() }),
        data.cover.credit && el('figcaption.col-hint', {}, data.cover.credit)) : typeof data.cover === 'string' ? photoFigure(space, data.cover, 'figure.col-cover') : null,
      data.desc ? el('div.col-desc', {}, markdown(data.desc)) : null,
      links.length ? el('ul.col-urls', { 'aria-label': t('collections.fieldLinks') }, links.map((link) => el('li', {},
        el('a.chip', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 14), link.title || hostOf(link.url), link.title && el('span.col-host', {}, hostOf(link.url)))))) : null]);
    about.hidden = !about.childElementCount;
    if (data.name && data.name !== indexedTitle) {
      indexedTitle = data.name;
      personal?.spaces.upsert({ ref, role: role() ?? 'viewer', title: data.name, opened: Date.now() }).catch(() => {});
    }
  }

  function renderIssue() {
    const state = space.state;
    const conflicts = space.conflicts();
    let content = null;
    if (state.issue === 'gone') {
      content = [el('span', {}, t('collections.issueGone')), button(t('collections.removeFromList'), { size: 'sm', variant: 'outline', onclick: async () => {
        await personal?.spaces.remove(ref).catch(() => {}); app?.navigate('#/collections');
      } })];
    } else if (state.issue === 'outdated') content = [el('span', {}, t(state.skipped ? 'collections.issueReload' : 'collections.issueOutdated'))];
    else if (state.issue === 'credit') content = [el('span', {}, t('collections.issueCredit'))];
    else if (conflicts.length) {
      content = [el('span', {}, t('collections.issueConflicts', { count: formatNumber(conflicts.length) })), button(t('collections.review'), { size: 'sm', variant: 'outline', onclick: () => reviewConflicts() })];
    }
    issue.hidden = !content;
    issue.replaceChildren(...(content ? [icon('warning', 16), ...content] : []));
  }
  function reviewConflicts() {
    const conflict = space.conflicts()[0];
    if (!conflict) return;
    track(openConflictDialog({ conflict,
      typeLabel: (type) => label(`collections.type.${type}`, t('collections.type.other')),
      fieldLabel: (_type, field) => label(`collections.field.${field}`, field),
      onResolve: async (choice) => { await space.resolveConflict(conflict.op.opId, choice); setTimeout(() => { if (!destroyed && space.conflicts().length) reviewConflicts(); }, 0); } }));
  }

  // ---- filters
  function filtersOn() { return Boolean(ui.query.trim() || ui.statuses.size || ui.cats.size || ui.labels.size); }
  function renderStatusBar(all) {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, all.filter((item) => item.status === status).length]));
    statusBar.replaceChildren(...STATUSES.map((status) => el('button.col-status-toggle', { type: 'button', 'aria-pressed': String(ui.statuses.has(status)), dataset: { status, focus: `status:${status}` },
      onclick: () => { if (ui.statuses.has(status)) ui.statuses.delete(status); else ui.statuses.add(status); schedule(); } },
    t(`collections.status.${status}`), el('span.col-status-count.num', {}, formatNumber(counts[status])))));
  }
  function renderActive() {
    const labels = labelsById();
    const chips = [
      ...[...ui.cats].map((id) => ({ key: `cat:${id}`, text: id ? categoryOf(space, id).name : t('collections.catNone'), remove: () => ui.cats.delete(id) })),
      ...[...ui.labels].map((id) => ({ key: `label:${id}`, text: labels.get(id)?.name ?? t('collections.labelMissing'), remove: () => ui.labels.delete(id) })),
    ];
    active.hidden = !chips.length;
    append(clear(active), [...chips.map((chip) => el('span.chip', {}, chip.text,
      iconButton('close', t('collections.removeFilter', { name: chip.text }), { dataset: { focus: `filter:${chip.key}` }, onclick: () => { chip.remove(); schedule(); filterButton.focus(); } }))),
    chips.length > 1 && button(t('collections.clearFilters'), { size: 'sm', variant: 'ghost', onclick: () => { ui.cats.clear(); ui.labels.clear(); schedule(); } })]);
    const count = ui.cats.size + ui.labels.size;
    filterButton.lastChild.textContent = count ? t('collections.filtersCount', { count: formatNumber(count) }) : t('collections.filters');
  }
  function openFilters() {
    const body = el('div.col-filters');
    function draw() {
      const used = new Set(space.select.saved.all().map((item) => item.cat ?? ''));
      const cats = [...BUILTIN_CATEGORIES.filter((entry) => used.has(entry.id)).map((entry) => ({ id: entry.id, name: categoryOf(space, entry.id).name })), ...(used.has('') ? [{ id: '', name: t('collections.catNone') }] : [])];
      const labels = space.select.label.all();
      body.replaceChildren(
        el('fieldset.col-field-group', {}, el('legend.field-label', {}, t('collections.filterCategory')),
          cats.length ? el('div.col-checks', {}, cats.map((cat) => checkbox(cat.name, { checked: ui.cats.has(cat.id), onChange: (on) => { if (on) ui.cats.add(cat.id); else ui.cats.delete(cat.id); schedule(); } }))) : el('p.col-hint', {}, t('collections.filterNoCategories'))),
        el('fieldset.col-field-group', {}, el('legend.field-label', {}, t('collections.filterLabel')),
          labels.length ? el('div.col-checks', {}, labels.map((item) => checkbox(item.name, { checked: ui.labels.has(item.id), onChange: (on) => { if (on) ui.labels.add(item.id); else ui.labels.delete(item.id); schedule(); } }))) : el('p.col-hint', {}, t('collections.labelsNone'))));
    }
    draw();
    const dialog = track(openModal({ title: t('collections.filters'), content: body, actions: [
      button(t('collections.clearFilters'), { variant: 'ghost', onclick: () => { ui.cats.clear(); ui.labels.clear(); ui.statuses.clear(); schedule(); draw(); } }),
      button(t('collections.done'), { variant: 'primary', onclick: () => dialog.close('done') })] }));
  }

  // ---- list
  function row(item, { labels, draggable }) {
    const category = categoryOf(space, item.cat);
    const own = (item.labels ?? []).map((id) => labels.get(id)).filter(Boolean);
    const avg = averageRating(item);
    const dataset = { id: item.id, label: item.name, ...(draggable ? { sortableItem: '' } : {}) };
    return el('li.col-row', { dataset, className: ui.selected.has(item.id) ? 'col-row is-selected' : 'col-row' },
      ui.selecting && el('input.col-check', { type: 'checkbox', checked: ui.selected.has(item.id), 'aria-label': t('collections.selectPlace', { name: item.name }), dataset: { focus: `check:${item.id}` },
        onchange: (event) => { if (event.target.checked) ui.selected.add(item.id); else ui.selected.delete(item.id); schedule(); } }),
      el('button.col-row-main', { type: 'button', dataset: { focus: `open:${item.id}` }, onclick: () => openSheet(item.id) },
        swatch(category, 18),
        el('span.col-row-text', {},
          el('span.col-row-name', {}, item.name),
          el('span.col-row-meta', {}, statusChip(item.status),
            avg > 0 && el('span.col-row-rating.num', {}, icon('star', 13), formatNumber(avg, { digits: 1 })),
            isVisitedBy(item, me) && el('span.col-row-visited', { title: t('collections.visitedByYou') }, icon('visited', 13), el('span.sr-only', {}, t('collections.visitedByYou'))),
            own.slice(0, 3).map((entry) => el('span.col-label-chip', { style: { '--col-color': colorValue(entry.color) } }, el('span.col-dot', { 'aria-hidden': 'true' }), entry.name)),
            own.length > 3 && el('span.col-hint', {}, `+${own.length - 3}`)),
          (item.address || myTags(item, me).length > 0) && el('span.col-row-sub', {}, [item.address, myTags(item, me).join(', ')].filter(Boolean).join(' · ')))),
      draggable && el('button.col-grip', { type: 'button', dataset: { sortableHandle: '' }, 'aria-label': t('collections.reorder', { name: item.name }) }, icon('grip', 16)),
      iconButton('more', t('collections.moreFor', { name: item.name }), { className: 'icon-btn col-row-menu', dataset: { focus: `menu:${item.id}` }, onclick: (event) => rowMenu(item.id, event.currentTarget) }));
  }
  function renderList(all) {
    sortable?.destroy(); sortable = null;
    const labels = labelsById();
    const draggable = ui.sort === 'order' && !filtersOn() && !ui.selecting && canEdit() && shown.length > 1;
    list.replaceChildren(...shown.map((item) => row(item, { labels, draggable })));
    list.hidden = !shown.length;
    empty.replaceChildren();
    if (!all.length) {
      empty.append(emptyState({ title: t('collections.placesEmpty'), body: t(canEdit() ? 'collections.placesEmptyBody' : 'collections.placesEmptyViewer'), icon: 'pin',
        action: canEdit() && button(t('collections.addPlace'), { icon: 'plus', variant: 'primary', onclick: () => openForm() }) }));
    } else if (!shown.length) {
      empty.append(emptyState({ title: t('collections.noMatches'), body: t('collections.noMatchesBody'), icon: 'search',
        action: button(t('collections.clearFilters'), { variant: 'outline', onclick: () => { ui.query = ''; searchInput.value = ''; ui.statuses.clear(); ui.cats.clear(); ui.labels.clear(); schedule(); } }) }));
    }
    if (draggable) {
      sortable = makeSortable(list, { onMove: ({ from, to }) => {
        const item = shown[from];
        if (!item) return;
        void apply([space.ops.patch('saved', item.id, { set: { order: moveOrder(shown, from, to) } })], { history: t('collections.historyReorder') });
      } });
    }
  }
  function renderBulk() {
    bulk.hidden = !ui.selecting;
    if (!ui.selecting) { bulk.replaceChildren(); return; }
    for (const id of [...ui.selected]) if (!space.get('saved', id)) ui.selected.delete(id);
    const ids = [...ui.selected];
    const editable = canEdit();
    const all = shown.length > 0 && shown.every((item) => ui.selected.has(item.id));
    const selectAll = checkbox(t('collections.selectAll'), { checked: all, dataset: { focus: 'bulk:all' }, onChange: (on) => { for (const item of shown) { if (on) ui.selected.add(item.id); else ui.selected.delete(item.id); } schedule(); } });
    const none = !ids.length;
    bulk.replaceChildren(
      el('div.col-bulk-row', {}, selectAll, el('span.col-bulk-count', { role: 'status' }, t('collections.selectedCount', { count: formatNumber(ids.length) })),
        button(t('collections.done'), { size: 'sm', variant: 'ghost', dataset: { focus: 'bulk:done' }, onclick: () => setSelecting(false) })),
      el('div.col-bulk-row', {},
        editable && button(t('collections.bulkStatus'), { size: 'sm', variant: 'outline', disabled: none, dataset: { focus: 'bulk:status' }, onclick: (event) => statusMenu(event.currentTarget, ids) }),
        editable && button(t('collections.bulkLabel'), { size: 'sm', variant: 'outline', disabled: none, dataset: { focus: 'bulk:labels' }, onclick: (event) => labelMenu(event.currentTarget, ids) }),
        button(t('collections.addToTrip'), { size: 'sm', variant: 'outline', disabled: none, onclick: () => void toTrip(ids) }),
        editable && button(t('collections.moveTo'), { size: 'sm', variant: 'outline', disabled: none, onclick: () => void transfer(ids, true) }),
        button(t('collections.copyTo'), { size: 'sm', variant: 'outline', disabled: none, onclick: () => void transfer(ids, false) }),
        editable && button(t('collections.delete'), { icon: 'trash', size: 'sm', variant: 'danger', disabled: none, onclick: () => void remove(ids) })));
    const toggle = selectAll.querySelector('input');
    if (toggle) toggle.indeterminate = !all && shown.some((item) => ui.selected.has(item.id));
  }
  function setSelecting(on) {
    ui.selecting = on;
    if (!on) ui.selected.clear();
    render();
    (on ? bulk.querySelector('input') : searchInput)?.focus();
  }

  function render() {
    cancelAnimationFrame(frame); frame = 0;
    if (destroyed) return;
    const all = space.select.saved.all();
    const focusKey = root.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    shown = sortSaved(filterSaved(all, { ...ui, uid: me }), ui.sort);
    renderHead(); renderIssue(); renderStatusBar(all); renderActive(); renderList(all); renderBulk();
    if (focusKey && !root.contains(document.activeElement)) [...root.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focusKey)?.focus({ preventScroll: true });
    map?.update();
  }
  function schedule() { if (!frame && !destroyed) frame = requestAnimationFrame(render); }

  function layout() {
    root.dataset.wide = String(wide);
    root.dataset.view = ui.view;
    const mapVisible = wide || ui.view === 'map';
    if (mapVisible && !map) map = mountSavedMap(mapPane, { space, services, items: () => shown, label: (item) => t(`collections.status.${item.status}`), onOpen: (id) => openSheet(id) });
    if (mapVisible) requestAnimationFrame(() => map?.resize());
  }

  // ---- actions on places
  function savedExtra(item) {
    const status = segmented({ label: t('collections.statusLabel'), radio: true, value: item?.status ?? 'want', items: STATUSES.map((value) => ({ value, label: t(`collections.status.${value}`) })) });
    const labels = space.select.label.all();
    const chosen = new Set(item?.labels ?? []);
    const element = el('div.col-form-extra', {},
      el('div.col-field-group', {}, el('span.field-label', {}, t('collections.statusLabel')), status.element),
      labels.length > 0 && el('fieldset.col-field-group', {}, el('legend.field-label', {}, t('collections.labels')),
        el('div.col-checks', {}, labels.map((entry) => checkbox(entry.name, { checked: chosen.has(entry.id), onChange: (on) => { if (on) chosen.add(entry.id); else chosen.delete(entry.id); } })))));
    return {
      element,
      values: (before) => {
        const ids = [...chosen].filter((id) => space.get('label', id));
        return { status: status.value, labels: ids.length ? ids : undefined, ...(before ? {} : { order: appendOrders(space.select.saved.all(), 1)[0] }) };
      },
    };
  }
  function openForm({ item = null } = {}) {
    if (!canEdit()) { toast(t('collections.readOnly')); return; }
    void openPlaceForm({ space, services, puter: context.puter, catalog: null, place: item, type: 'saved', extra: savedExtra(item), track }).then((id) => {
      if (!id || destroyed) return;
      render();
      list.querySelector(`[data-focus="open:${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
    });
  }
  function openSheet(id) {
    if (!space.get('saved', id)) return;
    track(openSavedSheet({ space, id, uid: me, canEdit: canEdit(), tagSuggestions: [...new Set(space.select.saved.all().flatMap((item) => myTags(item, me)))],
      onApply: (ops) => space.apply(ops),
      actions: { edit: (target) => openForm({ item: space.get('saved', target) }), addToTrip: (target) => void toTrip([target]), locate, menu: (target, anchor) => rowMenu(target, anchor) } }));
  }
  function locate(id) {
    if (!wide) { ui.view = 'map'; switcher.setValue('map'); layout(); }
    requestAnimationFrame(() => map?.focus(id));
  }
  function rowMenu(id, anchor) {
    const item = space.get('saved', id);
    if (!item) return;
    const editable = canEdit();
    const located = Number.isFinite(item.lat) && Number.isFinite(item.lng);
    openMenu(anchor, [
      { label: t('collections.open'), icon: 'chevronRight', onSelect: () => openSheet(id) },
      located && { label: t('collections.showOnMap'), icon: 'map', onSelect: () => locate(id) },
      editable && { label: t('collections.edit'), icon: 'pencil', onSelect: () => openForm({ item }) },
      editable && { separator: true },
      ...(editable ? STATUSES.map((status) => ({ label: t(`collections.status.${status}`), checked: item.status === status, onSelect: () => void apply([space.ops.patch('saved', id, { set: { status } })]) })) : []),
      { separator: true },
      { label: t('collections.addToTrip'), icon: 'plane', onSelect: () => void toTrip([id]) },
      editable && { label: t('collections.moveTo'), icon: 'arrowRight', onSelect: () => void transfer([id], true) },
      { label: t('collections.copyTo'), icon: 'copy', onSelect: () => void transfer([id], false) },
      { label: t('collections.visitedEverywhere'), icon: 'check', onSelect: () => void everywhere(id) },
      editable && { separator: true },
      editable && { label: t('collections.delete'), icon: 'trash', danger: true, onSelect: () => void remove([id]) },
    ].filter(Boolean));
  }
  function statusMenu(anchor, ids) {
    openMenu(anchor, STATUSES.map((status) => ({ label: t(`collections.status.${status}`), onSelect: async () => {
      const ops = ids.map((id) => space.get('saved', id)).filter((item) => item && item.status !== status).map((item) => space.ops.patch('saved', item.id, { set: { status } }));
      if (await apply(ops, { history: t('collections.historyStatus') })) announce(t('collections.bulkDone', { count: formatNumber(ids.length) }));
    } })));
  }
  function labelMenu(anchor, ids) {
    const labels = space.select.label.all();
    const items = ids.map((id) => space.get('saved', id)).filter(Boolean);
    openMenu(anchor, [
      ...labels.map((entry) => {
        const all = items.every((item) => item.labels?.includes(entry.id));
        return { label: t(all ? 'collections.labelRemove' : 'collections.labelApply', { name: entry.name }), checked: all, onSelect: async () => {
          const ops = items.map((item) => {
            const current = item.labels ?? [];
            const next = all ? current.filter((value) => value !== entry.id) : [...new Set([...current, entry.id])];
            return next.length === current.length && (all || current.includes(entry.id)) ? null : space.ops.patch('saved', item.id, next.length ? { set: { labels: next } } : { unset: ['labels'] });
          }).filter(Boolean);
          if (await apply(ops, { history: t('collections.historyLabels') })) announce(t('collections.bulkDone', { count: formatNumber(items.length) }));
        } };
      }),
      labels.length > 0 && { separator: true },
      { label: t('collections.labelsManage'), icon: 'pencil', onSelect: () => track(openLabelManager({ space, canEdit: canEdit() })) },
    ].filter(Boolean));
  }
  async function remove(ids) {
    const items = ids.map((id) => space.get('saved', id)).filter(Boolean);
    if (!items.length) return;
    const ok = await confirmDialog({ title: items.length === 1 ? t('collections.deletePlaceTitle', { name: items[0].name }) : t('collections.deletePlacesTitle', { count: formatNumber(items.length) }),
      body: t('collections.deletePlaceBody'), confirmLabel: t('collections.delete'), danger: true });
    if (!ok || !await apply(items.map((item) => space.ops.remove('saved', item.id)))) return;
    for (const item of items) ui.selected.delete(item.id);
    const message = items.length === 1 ? t('collections.deletedPlace', { name: items[0].name }) : t('collections.deletedPlaces', { count: formatNumber(items.length) });
    toast(message); announce(message);
  }
  async function toTrip(ids) {
    const items = ids.map((id) => space.get('saved', id)).filter(Boolean);
    if (!items.length) return;
    let entries;
    try { entries = await writableTrips(context); } catch (error) { toast(errorText(error)); return; }
    const trip = await pickSpace({ title: t('collections.addToTripTitle', { count: formatNumber(items.length) }), entries, kind: 'trip', emptyText: t('collections.noTrips') });
    if (!trip || destroyed) return;
    try {
      const result = await addToTrip(context, { items, trip: trip.ref, uid: me });
      const message = result.added ? t(result.queued ? 'collections.addedToTripQueued' : 'collections.addedToTrip', { count: formatNumber(result.added), name: trip.title || t('collections.untitledTrip') })
        : t('collections.alreadyInTrip', { name: trip.title || t('collections.untitledTrip') });
      toast(message, { action: app ? { label: t('collections.openTrip'), onClick: () => app.navigate(`${spaceRoute(trip.ref)}/plan`) } : undefined });
    } catch (error) { toast(errorText(error)); }
  }
  async function transfer(ids, move) {
    let entries;
    try { entries = await writableCollections(context, ref); } catch (error) { toast(errorText(error)); return; }
    let target = await pickSpace({ title: t(move ? 'collections.moveTitle' : 'collections.copyTitle', { count: formatNumber(ids.length) }), entries, allowNew: true, emptyText: t('collections.noOtherCollections') });
    if (!target || destroyed) return;
    try {
      if (target === 'new') {
        const value = await promptDialog({ title: t('collections.newTitle'), label: t('collections.fieldName'), confirmLabel: t('collections.create') });
        const trimmed = value?.replace(/\s+/g, ' ').trim();
        if (!trimmed) return;
        target = { ref: await createCollection(context, { name: trimmed.slice(0, 200), icon: 'bookmark' }), title: trimmed };
      }
      const result = await copyToCollection(context, { space, ids, target: target.ref, move, uid: me });
      for (const id of ids) if (result.moved) ui.selected.delete(id);
      const nameText = target.title || t('collections.untitled');
      let message = move && !result.moved ? t('collections.copiedNotMoved', { name: nameText }) : t(move ? 'collections.movedTo' : 'collections.copiedTo', { count: formatNumber(result.added), name: nameText });
      if (result.skipped) message = `${message} ${t('collections.skippedDupes', { count: formatNumber(result.skipped) })}`;
      toast(message, { action: app ? { label: t('collections.open'), onClick: () => app.navigate(`${spaceRoute(target.ref)}/places`) } : undefined });
    } catch (error) { toast(errorText(error)); }
  }
  async function everywhere(id) {
    const item = space.get('saved', id);
    if (!item) return;
    const notice = toast(t('collections.visitedWorking'), { duration: 0 });
    try {
      const changed = await markVisitedEverywhere(context, { item, current: space, uid: me });
      toast(t('collections.visitedDone', { count: formatNumber(changed) }));
    } catch (error) { toast(errorText(error)); } finally { notice.close(); }
  }

  // ---- collection actions
  function collectionMenu(anchor) {
    const owner = role() === 'owner';
    openMenu(anchor, [
      canMeta() && { label: t('collections.editDetails'), icon: 'pencil', onSelect: () => editMeta() },
      { label: t('collections.labelsManage'), icon: 'menu', onSelect: () => track(openLabelManager({ space, canEdit: canEdit() })) },
      { label: t(ui.selecting ? 'collections.selectStop' : 'collections.selectStart'), icon: 'check', onSelect: () => setSelecting(!ui.selecting) },
      { separator: true },
      canEdit() && { label: t('collections.importPlaces'), icon: 'plus', onSelect: () => void importInto() },
      { label: t('collections.exportJson'), icon: 'file', onSelect: () => exportAs('json') },
      { label: t('collections.exportGpx'), icon: 'map', onSelect: () => exportAs('gpx') },
      { separator: true },
      owner ? { label: t('collections.deleteCollection'), icon: 'trash', danger: true, onSelect: () => void removeCollection() }
        : { label: t('collections.leave'), icon: 'arrowRight', onSelect: () => track(openSharing({ space, context, ref, onLeft: () => app?.navigate('#/collections') })) },
    ].filter(Boolean));
  }
  function editMeta() {
    track(openMetaForm({ space, meta: meta(), title: t('collections.editTitle'), submitLabel: t('collections.save'), describeError: errorText,
      onSubmit: async (values) => {
        const { set, unset } = metaPatch(meta(), values);
        if (Object.keys(set).length || unset.length) await space.apply([space.ops.patch('meta', 'meta', { set, unset })], { history: t('collections.historyMeta') });
      } }));
  }
  async function importInto() {
    const choice = await chooseImport({ uid: me, target: space });
    if (!choice || destroyed) return;
    const result = importOps(space, choice.parsed, { status: choice.status });
    if (await apply(result.ops)) toast(t('collections.imported', { count: formatNumber(result.added) }));
  }
  function exportAs(format) {
    const result = exportCollection(space, { uid: me, format });
    if (format === 'gpx' && result.skipped) toast(t('collections.exportGpxSkipped', { count: formatNumber(result.skipped) }));
  }
  async function removeCollection() {
    const ok = await confirmDialog({ title: t('collections.deleteTitle', { name: name() }), body: t('collections.deleteBody', { count: formatNumber(space.select.saved.all().length) }), confirmLabel: t('collections.deleteCollection'), danger: true });
    if (!ok || destroyed) return;
    try { await deleteCollection(context, ref); } catch (error) { toast(errorText(error)); return; }
    toast(t('collections.deleted', { name: name() }));
    app?.navigate('#/collections');
  }

  // ---- wiring
  offs.push(space.subscribe(() => schedule()), space.onState(() => { renderIssue(); if (owned) { const state = space.state; app?.setSyncState?.(state.sync, { pending: pendingCount(state) }); } }));
  const measure = () => { const next = root.clientWidth >= WIDE; if (next !== wide) { wide = next; layout(); } };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    offs.push(() => observer.disconnect());
  } else {
    window.addEventListener('resize', measure);
    offs.push(() => window.removeEventListener('resize', measure));
  }
  space.setView?.('collection');
  wide = root.clientWidth >= WIDE;
  render();
  layout();
  try {
    const focus = sessionStorage.getItem(FOCUS_KEY);
    if (focus?.startsWith(`${ref.s}:`)) { sessionStorage.removeItem(FOCUS_KEY); const id = focus.slice(ref.s.length + 1); if (space.get('saved', id)) openSheet(id); }
  } catch { /* storage may be off */ }
  if (owned) { const state = space.state; app?.setSyncState?.(state.sync, { pending: pendingCount(state) }); }

  return {
    onError() { renderIssue(); },
    onFlush(result) { if (result?.status === 'rejected') toast(t('collections.rejected')); renderIssue(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(frame);
      sortable?.destroy();
      map?.destroy();
      for (const off of offs.splice(0)) off();
      for (const dialog of [...dialogs]) dialog.close('navigation');
      if (owned) app?.setSyncState?.('idle');
    },
  };
}

