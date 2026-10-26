// The places pool pane of the Plan tab: list, filters, bulk actions, detail and the place form.
// Mounted by the plan view as `mountPlaces(container, {...context, plan})`; works alone at phone width too.
import './places.css';
import { el, uid, append, clear } from '../../../ui/dom.js';
import { button, iconButton, emptyState, skeleton, chip } from '../../../ui/bits.js';
import { segmented, checkbox } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t, strings } from '../../../lib/i18n/index.js';
import { formatNumber } from '../../../lib/format.js';
import { createCatalogStore } from '../../settings/data/catalog.js';
import { icon } from './icons.js';
import { allCategories, categoryOf } from '../../../lib/categories.js';
import { SCOPES, SORTS, coordText, filterPlaces, hasLocation, isVisited, plannedDays, sortPlaces, tagVocabulary } from './filter.js';
import { categoryOps, deletePlacesOps, linkedExpenses, ratingOp, tagsOp, visitedOps } from './actions.js';
import { followShortLink, parseLocation } from './parse.js';
import { dayLabels, placeRow, rowKey } from './list.js';
import { renderDetail } from './detail.js';
import { createDetailsSection } from './details/index.js';
import { openPlaceForm } from './form.js';
import { openCategoryManager } from './catmanager.js';
import { ioMenuItems, registerTripCommands } from '../../io/entry.js';
import { integrationMenuItems } from '../../integrations/entry.js';

const WATCHED = new Set(['place', 'visit', 'day', 'cat', 'meta', 'file', 'exp', 'res', 'member']);
const RATINGS = [0, 3, 4, 4.5];
// Long lists render this many rows at a time; more follow as the list scrolls near its end.
const PAGE = 100;
const label = (key, fallback) => (Object.hasOwn(strings, key) ? t(key) : fallback);

/** Restores focus to the "same" control after a re-render, matched by row and accessible name. */
function focusKey(node, root) {
  if (!node || !root.contains(node) || node === document.body) return null;
  const row = node.closest('[data-place-id]')?.dataset.placeId ?? '';
  return { key: `${row}|${node.tagName}|${node.getAttribute('aria-label') ?? node.textContent.trim().slice(0, 60)}`, value: node.value, start: node.selectionStart, end: node.selectionEnd };
}
function restoreFocus(saved, root) {
  if (!saved || root.contains(document.activeElement)) return;
  const match = [...root.querySelectorAll('button, input, a[href], select, textarea, [tabindex]')].find((node) => focusKey(node, root)?.key === saved.key);
  if (!match) return;
  match.focus({ preventScroll: true });
  if (match.tagName === 'INPUT' && typeof saved.value === 'string') {
    match.value = saved.value;
    try { match.setSelectionRange(saved.start, saved.end); } catch { /* not a text input */ }
  }
}

export function mountPlaces(container, context = {}) {
  const { space, plan } = context;
  const me = context.account?.uuid ?? context.session?.account?.uuid ?? space.store?.uid ?? '';
  const services = context.session?.services ?? context.services ?? null;
  const personal = context.personal ?? context.session?.personal ?? null;
  const catalog = personal ? createCatalogStore({ personal }) : null;
  const ui = { view: 'list', detailId: null, query: '', scope: 'all', cats: new Set(), minRating: 0, tag: null, sort: 'recent', selecting: false, selected: new Set() };
  const cleanups = [];
  const dialogs = new Set();
  const mine = new Set();
  const rows = new Map();
  let personalTags = [];
  let frame = 0;
  let destroyed = false;
  let ownSelection = null;
  let details = null;
  const dropDetails = () => { details?.destroy(); details = null; };
  const track = (dialog) => { dialogs.add(dialog); void dialog.closed.then(() => dialogs.delete(dialog)); };
  const canEdit = () => space.can('plan.edit');
  // `ids` null saves every place in the trip to a collection.
  const saveToCollection = (ids) => import('../../collections/save.js').then((module) => module.openSaveToCollection(context, { space, placeIds: ids })).catch(() => toast(t('places.saveFailed')));

  async function apply(ops, options) {
    if (!ops.length) return true;
    for (const op of ops) mine.add(op.opId);
    try { await space.apply(ops, options); return true; } catch { toast(t('places.saveFailed')); return false; }
  }

  // ---- DOM
  const titleId = uid('pl-title');
  const searchId = uid('pl-find');
  const count = el('span.pl-count.num');
  const addButton = button(t('places.add'), { icon: 'plus', size: 'sm', variant: 'primary', onclick: () => openForm() });
  const head = el('header.pl-head', {},
    el('div.pl-heading', {}, el('h2.pl-title', { id: titleId }, t('places.title')), count),
    el('div.pl-head-actions', {}, addButton, iconButton('more', t('places.paneMenu'), { onclick: (event) => paneMenu(event.currentTarget) })));
  const searchInput = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', enterKeyHint: 'search', placeholder: t('places.searchPlaceholder') });
  const search = el('div.pl-search', {}, el('label.sr-only', { htmlFor: searchId }, t('places.searchLabel')), el('div.input-prefix', {}, icon('search'), searchInput));
  const scope = segmented({ label: t('places.scopeLabel'), items: SCOPES.map((value) => ({ value, label: t(`places.scope.${value}`) })), value: ui.scope,
    onChange: (value) => { ui.scope = value; render(); } });
  const filterButton = button(t('places.filters'), { icon: 'filter', size: 'sm', variant: 'ghost', onclick: () => openFilters() });
  const filters = el('div.pl-filters', {}, scope.element, filterButton);
  const activeFilters = el('div.pl-active', { hidden: true });
  const suggestion = el('div.pl-suggestion', { hidden: true });
  const conflictBar = el('div.pl-notice', { hidden: true, role: 'status' });
  const bulk = el('div.pl-bulk', { hidden: true, role: 'toolbar', 'aria-label': t('places.bulkLabel') });
  const list = el('ul.pl-list', { 'aria-labelledby': titleId });
  const empty = el('div.pl-empty', { hidden: true });
  const listView = el('div.pl-list-view', {}, head, search, filters, activeFilters, suggestion, conflictBar, bulk, el('div.pl-scroll', {}, list, empty));
  const detailView = el('div.pl-detail-view', { hidden: true });
  const live = el('p.sr-only', { role: 'status', 'aria-live': 'polite' });
  const root = el('section.pl-pane', { 'aria-labelledby': titleId }, listView, detailView, live);
  container.replaceChildren(root);
  const announce = (text) => { live.textContent = ''; setTimeout(() => { if (!destroyed) live.textContent = text; }, 30); };

  // ---- reading
  function bias() {
    const located = space.select.place.all().filter(hasLocation);
    const day = plan.get().day;
    const visits = (space.select.visit.groupBy('dayId').get(day) ?? []).filter((visit) => !visit.alt);
    const ofDay = visits.map((visit) => space.get('place', visit.placeId)).filter(hasLocation);
    const points = ofDay.length ? ofDay : located;
    if (!points.length) return null;
    return { lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length, lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length, zoom: 12 };
  }
  const tagSuggestions = () => tagVocabulary(space.select.place.all(), me, personalTags);

  // ---- list
  const pageEnd = el('li.pl-page-end', { role: 'presentation', 'aria-hidden': 'true' });
  let limit = PAGE;
  let listKey = '';
  let shownCount = 0;
  const pager = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && shownCount > limit) { limit += PAGE; schedule(); }
  }, { rootMargin: '0px 0px 800px 0px' }) : null;
  cleanups.push(() => pager?.disconnect());

  function renderList() {
    const places = space.select.place.all();
    const visits = space.select.visit.groupBy('placeId');
    const labels = dayLabels(space);
    const editable = canEdit();
    const categories = new Map();
    const categoryFor = (id) => { if (!categories.has(id ?? '')) categories.set(id ?? '', categoryOf(space, id)); return categories.get(id ?? ''); };
    const shown = sortPlaces(filterPlaces(places, {
      query: ui.query, scope: ui.scope, day: plan.get().day, cats: ui.cats, minRating: ui.minRating, tag: ui.tag, uid: me, visitsByPlace: visits,
      categoryKey: (place) => categoryFor(place.cat).id, categoryName: (id) => categoryFor(id).name,
    }), ui.sort);
    for (const id of ui.selected) if (!space.get('place', id)) ui.selected.delete(id);
    const draggable = editable && labels.size > 0;
    const focus = focusKey(document.activeElement, list);
    const present = new Set();
    // A new search or filter starts at the first page; the selected place is always rendered.
    const filterKey = JSON.stringify([ui.query, ui.scope, plan.get().day, [...ui.cats], ui.minRating, ui.tag, ui.sort]);
    if (filterKey !== listKey) { listKey = filterKey; limit = PAGE; }
    const selectedAt = plan.get().place ? shown.findIndex((place) => place.id === plan.get().place) : -1;
    const rendered = pager ? Math.max(limit, selectedAt + 1) : shown.length;
    shownCount = shown.length;
    const nodes = shown.slice(0, rendered).map((place) => {
      present.add(place.id);
      const options = { category: categoryFor(place.cat), days: plannedDays(place.id, visits), dayLabels: labels, selecting: ui.selecting, checked: ui.selected.has(place.id),
        canEdit: editable, draggable, uid: me, on: rowActions };
      const key = rowKey(place, options);
      let entry = rows.get(place.id);
      if (!entry || entry.key !== key) { entry = { key, node: placeRow(place, options) }; rows.set(place.id, entry); }
      return entry.node;
    });
    for (const id of rows.keys()) if (!present.has(id)) rows.delete(id);
    list.replaceChildren(...nodes, ...(rendered < shown.length ? [pageEnd] : []));
    // Re-observing reports the sentinel's current state, so a still-visible end keeps loading.
    pager?.unobserve(pageEnd);
    if (rendered < shown.length) pager?.observe(pageEnd);
    restoreFocus(focus, list);
    highlight();
    const loading = !places.length && space.state.rev === 0 && ['idle', 'syncing'].includes(space.state.sync);
    count.textContent = shown.length === places.length ? formatNumber(places.length) : t('places.countFiltered', { shown: formatNumber(shown.length), total: formatNumber(places.length) });
    empty.hidden = shown.length > 0;
    if (loading) empty.replaceChildren(el('div.pl-skeletons', { 'aria-busy': 'true', 'aria-label': t('places.loading') }, skeleton(), skeleton('70%'), skeleton('85%')));
    else if (!places.length) empty.replaceChildren(emptyState({ title: t('places.emptyTitle'), body: t(editable ? 'places.emptyBody' : 'places.emptyBodyViewer'), icon: 'pin',
      action: editable && button(t('places.add'), { icon: 'plus', variant: 'primary', onclick: () => openForm() }) }));
    else if (!shown.length) empty.replaceChildren(emptyState({ title: t('places.noMatchTitle'), body: t('places.noMatchBody'), icon: 'search',
      action: button(t('places.clearFilters'), { variant: 'outline', onclick: clearFilters }) }));
    addButton.hidden = !editable;
    renderActiveFilters();
    renderSuggestion(shown.length);
    renderBulk(shown);
    renderConflicts();
  }

  function highlight() {
    const { place, hover } = plan.get();
    for (const [id, { node }] of rows) {
      node.classList.toggle('is-selected', id === place);
      node.querySelector('.pl-main')?.setAttribute('aria-current', id === place ? 'true' : 'false');
      node.classList.toggle('is-hover', hover?.t === 'place' && hover.id === id);
    }
  }

  function renderActiveFilters() {
    const items = [
      ...[...ui.cats].map((id) => chip(categoryOf(space, id).name, { onRemove: () => { ui.cats.delete(id); render(); } })),
      ui.minRating > 0 && chip(t('places.minRatingChip', { rating: formatNumber(ui.minRating, { digits: 1 }) }), { onRemove: () => { ui.minRating = 0; render(); } }),
      ui.tag && chip(t('places.tagChip', { name: ui.tag }), { onRemove: () => { ui.tag = null; render(); } }),
    ].filter(Boolean);
    activeFilters.hidden = !items.length;
    activeFilters.replaceChildren(...items, ...(items.length > 1 ? [button(t('places.clearFilters'), { size: 'sm', variant: 'ghost', onclick: clearFilters })] : []));
    filterButton.textContent = '';
    filterButton.append(icon('filter'), items.length ? t('places.filtersCount', { count: items.length }) : t('places.filters'));
  }
  function clearFilters() {
    ui.cats.clear(); ui.minRating = 0; ui.tag = null; ui.query = ''; searchInput.value = ''; ui.scope = 'all'; scope.setValue('all');
    render();
  }

  // Pasted coordinates or map links in the search box become an "add" suggestion; a search with no match offers the geocoder.
  function renderSuggestion(shownCount) {
    const text = ui.query.trim();
    const parsed = text ? parseLocation(text) : null;
    const editable = canEdit();
    let action = null;
    if (editable && parsed?.lat !== undefined) {
      action = button(parsed.name ? t('places.addNamed', { name: parsed.name }) : t('places.addAt', { coords: coordText(parsed) }),
        { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => usePasted(parsed) });
    } else if (editable && parsed?.short) action = button(t('places.readLink'), { icon: 'paste', size: 'sm', variant: 'outline', onclick: () => usePasted(parsed) });
    else if (editable && parsed?.query) action = button(t('places.findNamed', { name: parsed.query }), { icon: 'search', size: 'sm', variant: 'outline', onclick: () => usePasted(parsed) });
    else if (editable && text.length >= 2 && !shownCount && services?.geocode) action = button(t('places.findNamed', { name: text }), { icon: 'search', size: 'sm', variant: 'outline', onclick: () => openForm({ query: text }) });
    suggestion.hidden = !action;
    suggestion.replaceChildren(...(action ? [action] : []));
  }

  async function usePasted(parsed) {
    if (!canEdit()) return;
    if (parsed.short) {
      if (typeof context.puter?.net?.fetch !== 'function') { toast(t('places.linkNoFetch')); return; }
      announce(t('places.linkReading'));
      let found;
      try { found = await followShortLink(parsed.short, (target, init) => context.puter.net.fetch(target, init)); } catch { toast(t('places.linkFailed')); return; }
      if (!found || destroyed) { if (!found) toast(t('places.linkUnreadable')); return; }
      parsed = found;
    }
    if (parsed.lat !== undefined) openForm({ prefill: parsed, src: 'link' });
    else if (parsed.query) openForm({ query: parsed.query });
  }

  // ---- bulk
  function renderBulk(shown) {
    bulk.hidden = !ui.selecting;
    if (!ui.selecting) { bulk.replaceChildren(); return; }
    const ids = [...ui.selected];
    const editable = canEdit();
    const all = shown.length > 0 && shown.every((place) => ui.selected.has(place.id));
    const allVisited = ids.length > 0 && ids.every((id) => isVisited(space.get('place', id), me));
    const selectAll = checkbox(t('places.selectAll'), { checked: all, onChange: (checked) => {
      for (const place of shown) { if (checked) ui.selected.add(place.id); else ui.selected.delete(place.id); }
      render();
    } });
    bulk.replaceChildren(
      el('div.pl-bulk-row', {}, selectAll, el('span.pl-bulk-count', { role: 'status' }, t('places.selectedCount', { count: ids.length })),
        button(t('places.done'), { size: 'sm', variant: 'ghost', onclick: () => setSelecting(false) })),
      el('div.pl-bulk-row', {},
        editable && button(t('places.bulkCategory'), { size: 'sm', variant: 'outline', disabled: !ids.length, onclick: (event) => categoryMenu(event.currentTarget, ids) }),
        button(t(allVisited ? 'places.bulkUnvisited' : 'places.bulkVisited'), { icon: 'visited', size: 'sm', variant: 'outline', disabled: !ids.length,
          onclick: async () => { if (await apply(visitedOps(space, ids, me, !allVisited))) announce(t(allVisited ? 'places.bulkUnvisitedDone' : 'places.bulkVisitedDone', { count: ids.length })); } }),
        button(t('collections.saveToCollection'), { size: 'sm', variant: 'outline', disabled: !ids.length, onclick: () => void saveToCollection(ids) }),
        editable && button(t('places.delete'), { icon: 'trash', size: 'sm', variant: 'danger', disabled: !ids.length, onclick: () => confirmDelete(ids) })));
    const toggle = selectAll.querySelector('input');
    if (toggle) toggle.indeterminate = !all && shown.some((place) => ui.selected.has(place.id));
  }
  function setSelecting(on) {
    ui.selecting = on;
    if (!on) ui.selected.clear();
    render();
    (on ? bulk.querySelector('input') : searchInput)?.focus();
  }
  function categoryMenu(anchor, ids, after) {
    openMenu(anchor, [
      ...allCategories(space).map((category) => ({ label: category.name, icon: category.icon, onSelect: async () => {
        if (await apply(categoryOps(space, ids, category.id), { history: t('places.historyCategory') })) { announce(t('places.categorySet', { count: ids.length, name: category.name })); after?.(); }
      } })),
      { separator: true },
      { label: t('places.catManage'), icon: 'palette', onSelect: manageCategories },
      ...ioMenuItems(context),
      ...integrationMenuItems(context),
    ]);
  }

  // ---- conflicts on our own types and ops
  function relevantConflicts() {
    return space.conflicts().filter((conflict) => ['place', 'cat'].includes(conflict.op.t) || mine.has(conflict.op.opId));
  }
  function renderConflicts() {
    const conflicts = relevantConflicts();
    conflictBar.hidden = !conflicts.length;
    if (!conflicts.length) { conflictBar.replaceChildren(); return; }
    conflictBar.replaceChildren(icon('warning', 16), el('span', {}, t('places.conflicts', { count: conflicts.length })),
      button(t('places.review'), { size: 'sm', variant: 'outline', onclick: reviewConflicts }));
  }
  function reviewConflicts() {
    const [conflict] = relevantConflicts();
    if (!conflict) return;
    const dialog = openConflictDialog({ conflict,
      typeLabel: (type) => label(`places.type.${type}`, t('places.type.other')),
      fieldLabel: (_type, name) => label(`places.field.${name}`, t('places.field.other', { name })),
      onResolve: async (choice) => { await space.resolveConflict(conflict.op.opId, choice); setTimeout(() => { if (!destroyed && relevantConflicts().length) reviewConflicts(); }, 0); } });
    if (dialog?.closed) track(dialog);
  }

  // ---- detail
  function showDetail(id, { focus = true } = {}) {
    if (!space.get('place', id)) return;
    ui.view = 'detail'; ui.detailId = id;
    ownSelection = id; plan.set({ place: id });
    renderDetailView();
    listView.hidden = true; detailView.hidden = false;
    if (focus) detailView.querySelector('.pl-detail-title')?.focus();
  }
  function showList({ focusId = ui.detailId } = {}) {
    ui.view = 'list'; ui.detailId = null;
    dropDetails();
    detailView.hidden = true; detailView.replaceChildren(); listView.hidden = false;
    renderList();
    const row = focusId && list.querySelector(`[data-place-id="${focusId}"] .pl-main`);
    if (row) { row.focus(); row.scrollIntoView?.({ block: 'nearest' }); } else searchInput.focus();
  }
  function renderDetailView() {
    const place = space.get('place', ui.detailId);
    if (!place) { toast(t('places.goneNotice')); showList({ focusId: null }); return; }
    const focus = focusKey(document.activeElement, detailView);
    const id = place.id;
    if (details?.placeId !== id) { dropDetails(); details = createDetailsSection({ placeId: id, space, services, puter: context.puter, canEdit, track }); }
    details.update(place);
    const view = renderDetail({
      place, space, uid: me, canEdit: canEdit(), dayLabels: dayLabels(space), visitsByPlace: space.select.visit.groupBy('placeId'), tagSuggestions: tagSuggestions(), details: details.element,
      on: {
        back: () => showList({ focusId: id }),
        edit: () => openForm({ place: space.get('place', id) }),
        remove: () => confirmDelete([id]),
        locate: () => locate(id),
        addToDay: (anchor) => addToDayMenu(id, anchor),
        rate: (value) => { void apply([ratingOp(space, id, me, value)]); },
        tags: (list) => { void apply([tagsOp(space, id, me, list)]); rememberTags(list); },
        visited: (value) => { void apply(visitedOps(space, [id], me, value)); },
        openDay: (dayId) => plan.set({ day: dayId }),
        attach: space.can('files.edit') ? () => { void attachFiles(id); } : null,
        expense: space.can('costs.edit') && me ? () => { void createExpense(id); } : null,
      },
    });
    detailView.replaceChildren(view.element);
    restoreFocus(focus, detailView);
  }
  async function rememberTags(list) {
    if (!catalog) return;
    const known = new Set(personalTags.map((tag) => tag.toLocaleLowerCase()));
    for (const tag of list) {
      if (known.has(tag.toLocaleLowerCase())) continue;
      try { await catalog.addTag(tag); } catch { /* the tag stays on the place either way */ }
    }
  }

  // ---- actions
  async function attachFiles(id) {
    try { await (await import('../../../lib/files/picker.js')).openFilePicker(space, { link: { t: 'place', id } }); } catch { toast(t('places.saveFailed')); }
  }
  /** The costs form, prefilled with the place's name and a link to it; nothing is saved until the person saves it. */
  async function createExpense(id) {
    const place = space.get('place', id);
    if (!place) return;
    try {
      const [{ openExpenseForm }, shared] = await Promise.all([import('../costs/form.js'), import('../costs/shared.js'), import('../costs/costs.css')]);
      const people = shared.createPeople({ space, me });
      const currency = space.get('meta', 'meta')?.currency ?? 'EUR';
      const copy = { name: place.name, amount: null, currency, payers: [{ who: me, amount: null }], split: { mode: 'equal', parts: people.list.map((person) => ({ who: person.id })) }, links: [{ t: 'place', id }] };
      openExpenseForm({ space, model: shared.readModel(space, me), people, session: context.session, track: shared.dialogTracker(context.signal), copy, onSaved: () => toast(t('places.expenseSaved')) });
    } catch { toast(t('places.saveFailed')); }
  }
  function locate(id) { ownSelection = id; plan.set({ place: id }); plan.emit('locate', { t: 'place', id }); }
  function addToDayMenu(id, anchor) {
    const labels = dayLabels(space);
    const current = plan.get().day;
    const place = space.get('place', id);
    if (!place || !labels.size) return;
    // The day plan creates the visit and confirms it.
    const pick = (day) => plan.emit('addToDay', { placeId: id, dayId: day });
    openMenu(anchor, [...labels].map(([day, text]) => ({ label: day === current ? t('places.currentDay', { day: text }) : text, icon: 'calendar', onSelect: () => pick(day) })));
  }
  const rowActions = {
    open: (id) => showDetail(id),
    check: (id, checked) => { if (checked) ui.selected.add(id); else ui.selected.delete(id); render(); },
    hover: (id) => {
      const hover = plan.get().hover;
      if (id && !(hover?.t === 'place' && hover.id === id)) plan.set({ hover: { t: 'place', id } });
      else if (!id && hover?.t === 'place') plan.set({ hover: null });
    },
    menu: (id, anchor, daysOnly = false) => {
      const place = space.get('place', id);
      if (!place) return;
      if (daysOnly) { addToDayMenu(id, anchor); return; }
      const editable = canEdit();
      const visited = isVisited(place, me);
      openMenu(anchor, [
        { label: t('places.open'), icon: 'chevronRight', onSelect: () => showDetail(id) },
        hasLocation(place) && { label: t('places.showOnMap'), icon: 'locate', onSelect: () => locate(id) },
        editable && dayLabels(space).size > 0 && { label: t('places.addToDayMenu'), icon: 'addDay', onSelect: () => addToDayMenu(id, anchor) },
        editable && { label: t('places.edit'), icon: 'pencil', onSelect: () => openForm({ place }) },
        editable && { label: t('places.setCategory'), icon: 'palette', onSelect: () => categoryMenu(anchor, [id]) },
        { label: t(visited ? 'places.markUnvisited' : 'places.markVisited'), icon: 'visited', onSelect: () => apply(visitedOps(space, [id], me, !visited)) },
        { label: t('collections.saveToCollection'), icon: 'heart', onSelect: () => void saveToCollection([id]) },
        editable && { separator: true },
        editable && { label: t('places.delete'), icon: 'trash', danger: true, onSelect: () => confirmDelete([id]) },
      ].filter(Boolean));
    },
  };

  function openForm({ place = null, prefill = null, query = '', src } = {}) {
    if (!canEdit()) { toast(t('places.readOnly')); return; }
    void openPlaceForm({ space, services, puter: context.puter, catalog, place, prefill, query, bias: bias(), src, track }).then((id) => {
      if (!id || destroyed) return;
      ownSelection = id; plan.set({ place: id });
      if (ui.view === 'detail' && ui.detailId === id) renderDetailView();
      else {
        render();
        list.querySelector(`[data-place-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }

  function confirmDelete(ids) {
    const places = ids.map((id) => space.get('place', id)).filter(Boolean);
    if (!places.length || !canEdit()) return;
    const visitCount = places.reduce((sum, place) => sum + (space.select.visit.groupBy('placeId').get(place.id)?.length ?? 0), 0);
    const expenses = space.can('costs.edit') ? linkedExpenses(space, places.map((place) => place.id)) : [];
    const lastOnly = expenses.filter((entry) => entry.last);
    let deleteExpenses = false;
    const confirm = button(t('places.delete'), { variant: 'danger' });
    const dialog = openModal({
      title: places.length === 1 ? t('places.deleteTitle', { name: places[0].name }) : t('places.deleteManyTitle', { count: places.length }),
      content: el('div.pl-delete', {},
        el('p', {}, visitCount ? t('places.deleteBodyVisits', { count: visitCount }) : t('places.deleteBody')),
        expenses.length > 0 && el('p', {}, t('places.deleteExpenses', { count: expenses.length })),
        lastOnly.length > 0 && checkbox(t('places.deleteExpensesToo', { count: lastOnly.length }), { onChange: (checked) => { deleteExpenses = checked; } })),
      actions: [button(t('places.cancel'), { onclick: () => dialog.close('cancel') }), confirm],
    });
    track(dialog);
    confirm.addEventListener('click', async () => {
      dialog.close('confirm');
      const ops = deletePlacesOps(space, places.map((place) => place.id), { deleteExpenses: deleteExpenses ? new Set(lastOnly.map((entry) => entry.exp.id)) : new Set() });
      if (!await apply(ops)) return;
      for (const place of places) ui.selected.delete(place.id);
      if (places.some((place) => place.id === plan.get().place)) plan.set({ place: null });
      const message = places.length === 1 ? t('places.deleted', { name: places[0].name }) : t('places.deletedMany', { count: places.length });
      toast(message); announce(message);
      if (ui.view === 'detail' && places.some((place) => place.id === ui.detailId)) showList({ focusId: null });
    });
  }

  function manageCategories() { openCategoryManager({ space, catalog, canEdit: canEdit(), track }); }
  function paneMenu(anchor) {
    openMenu(anchor, [
      { label: t(ui.selecting ? 'places.selectStop' : 'places.selectStart'), icon: 'select', onSelect: () => setSelecting(!ui.selecting) },
      { label: t('places.catManage'), icon: 'palette', onSelect: manageCategories },
      ...ioMenuItems(context),
      ...integrationMenuItems(context),
      { label: t('collections.saveAllToCollection'), icon: 'heart', onSelect: () => void saveToCollection(null) },
    ]);
  }

  function openFilters() {
    const body = el('div.pl-filter-dialog');
    function draw() {
      const tags = tagSuggestions();
      const sortControl = segmented({ label: t('places.sortLabel'), items: SORTS.map((value) => ({ value, label: t(`places.sort.${value}`) })), value: ui.sort,
        onChange: (value) => { ui.sort = value; render(); } });
      const ratingControl = segmented({ label: t('places.ratingFilter'), value: ui.minRating,
        items: RATINGS.map((value) => ({ value, label: value ? t('places.minRating', { rating: formatNumber(value, { digits: 1 }) }) : t('places.anyRating') })),
        onChange: (value) => { ui.minRating = value; render(); } });
      const catTitle = uid('pl-filter');
      const tagTitle = uid('pl-filter');
      append(clear(body), [
        el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('places.sortLabel')), sortControl.element),
        el('fieldset.pl-fieldset', { 'aria-labelledby': catTitle }, el('legend.field-label', { id: catTitle }, t('places.categories')),
          el('div.pl-check-grid', {}, allCategories(space).map((category) => checkbox(category.name, { checked: ui.cats.has(category.id),
            onChange: (checked) => { if (checked) ui.cats.add(category.id); else ui.cats.delete(category.id); render(); } })))),
        el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('places.ratingFilter')), ratingControl.element),
        tags.length > 0 && el('fieldset.pl-fieldset', { 'aria-labelledby': tagTitle }, el('legend.field-label', { id: tagTitle }, t('places.tagsYours')),
          el('div.pl-tag-filter', {}, tags.map((tag) => button(tag, { size: 'sm', variant: ui.tag === tag ? 'primary' : 'outline', 'aria-pressed': String(ui.tag === tag),
            onclick: () => { ui.tag = ui.tag === tag ? null : tag; render(); draw(); } }))))]);
    }
    draw();
    const dialog = openModal({ title: t('places.filters'), content: body, actions: [
      button(t('places.clearFilters'), { variant: 'ghost', onclick: () => { clearFilters(); draw(); } }),
      button(t('places.done'), { variant: 'primary', onclick: () => dialog.close('done') }),
    ] });
    track(dialog);
  }

  // ---- render scheduling and wiring
  function render() {
    if (destroyed) return;
    cancelAnimationFrame(frame); frame = 0;
    if (ui.view === 'detail') renderDetailView(); else renderList();
  }
  function schedule() { if (!frame && !destroyed) frame = requestAnimationFrame(() => { frame = 0; render(); }); }

  searchInput.addEventListener('input', () => { ui.query = searchInput.value; render(); });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) { event.preventDefault(); event.stopPropagation(); searchInput.value = ''; ui.query = ''; render(); }
    else if (event.key === 'Enter') {
      const parsed = parseLocation(searchInput.value.trim());
      if (parsed) { event.preventDefault(); void usePasted(parsed); }
    }
  });
  // Pasting a location anywhere in the pane outside a text field opens the form.
  root.addEventListener('paste', (event) => {
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const parsed = parseLocation(event.clipboardData?.getData('text') ?? '');
    if (!parsed || !canEdit()) return;
    event.preventDefault();
    void usePasted(parsed);
  });

  cleanups.push(space.subscribe((event) => { if ([...event.types].some((type) => WATCHED.has(type))) schedule(); }));
  cleanups.push(space.onState(() => renderConflicts()));
  cleanups.push(plan.subscribe((state, patch) => {
    if ('day' in patch && ui.view === 'list') schedule();
    if ('place' in patch) {
      highlight();
      const external = state.place && state.place !== ownSelection;
      ownSelection = null;
      if (external && ui.view === 'list') {
        if (!rows.has(state.place)) renderList();
        list.querySelector(`[data-place-id="${state.place}"]`)?.scrollIntoView?.({ block: 'nearest' });
      }
      // An open detail follows a selection made elsewhere (a marker on the map).
      else if (external && ui.view === 'detail' && state.place !== ui.detailId) showDetail(state.place, { focus: false });
    }
    if ('hover' in patch) highlight();
  }));
  cleanups.push(plan.on('pickLocation', (detail) => {
    if (!detail || !Number.isFinite(detail.lat) || !Number.isFinite(detail.lng)) return;
    const { lat, lng, name, address, osm, wikidata, cat, source } = detail;
    openForm({ prefill: { lat, lng, name, address, osm, wikidata, cat }, src: typeof source === 'string' && /^[a-z-]{1,32}$/.test(source) ? source : 'map' });
  }));
  cleanups.push(plan.on('openPlace', (detail) => { if (detail?.id) showDetail(detail.id); }));
  if (catalog) {
    const loadTags = () => catalog.tags().then((tags) => { if (!destroyed) { personalTags = tags; if (ui.view === 'detail') schedule(); } }).catch(() => {});
    void loadTags();
    cleanups.push(catalog.subscribe(loadTags));
  }
  const commands = context.app?.commands;
  for (const command of [
    { id: 'places-new', labelKey: 'places.cmdNew', shortcut: 'n', run: () => openForm() },
    { id: 'places-search', labelKey: 'places.cmdSearch', shortcut: '/', run: () => { if (ui.view !== 'list') showList({ focusId: null }); searchInput.focus(); } },
  ]) {
    try { const off = commands?.register?.(command); if (typeof off === 'function') cleanups.push(off); } catch { /* already registered by another pane */ }
  }
  cleanups.push(registerTripCommands(context));

  renderList();
  const initial = plan.get().place;
  if (initial && rows.has(initial)) list.querySelector(`[data-place-id="${initial}"]`)?.scrollIntoView?.({ block: 'nearest' });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(frame);
    dropDetails();
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* keep tearing down */ } }
    for (const dialog of [...dialogs]) dialog.close('navigation');
    if (plan.get().hover?.t === 'place') plan.set({ hover: null });
    container.replaceChildren();
  };
  context.signal?.addEventListener('abort', destroy, { once: true });
  return destroy;
}

