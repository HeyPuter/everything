import { el } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDistance } from '../../../lib/format.js';
import { CORRIDORS, detectLeg, project, slice, refillCategories } from '../../../lib/road/index.js';
import { CORRIDOR_CATEGORIES } from '../../../services/corridor.js';
import { icon } from './icons.js';

const joinLines = (lines) => lines.reduce((all, line) => (all.length ? [...all, ...line.slice(1)] : [...line]), []);

/** The line a search scope covers: the route, one leg, a range band or a spot. */
export function scopeLine(view, scope) {
  const lineOf = (key) => view.info.get(key)?.line ?? [];
  if (scope.kind === 'leg') return lineOf(scope.leg);
  if (scope.kind === 'band') return joinLines(scope.band.pieces.map((piece) => slice(lineOf(piece.leg), piece.from, piece.to)));
  if (scope.kind === 'point') return [scope.point, scope.point];
  if (scope.kind === 'day') return joinLines(view.chain.legs.filter((leg) => leg.kind === 'drive' && leg.dayIndex === scope.day).map((leg) => lineOf(leg.key)));
  return joinLines(view.chain.legs.filter((leg) => leg.kind === 'drive').map((leg) => lineOf(leg.key)));
}

/**
 * Search along the route: scope, corridor width and categories, results with "Add stop" (on the leg they are nearest),
 * and "Add manually" by name. Results are kept in the shared state so the map shows them.
 */
export function createSearch({ state, ops, getView, announce, lang, services, onLocate }) {
  let scope = { kind: 'route' };
  let width = state.prefs().corridor;
  const chosen = new Set(['fuel']);
  let controller = null;
  let manual = [];
  let manualStatus = '';

  const scopeText = el('p.road-search-scope');
  const widthChoice = segmented({ label: t('road.search.width'), radio: true, value: CORRIDORS.includes(width) ? width : 5,
    items: CORRIDORS.map((value) => ({ value, label: formatDistance(value * 1000) })), onChange: (value) => { width = value; } });
  const chips = el('div.road-chips', { role: 'group', 'aria-label': t('road.search.categories') });
  const progress = el('p.field-hint.road-search-progress', { role: 'status', 'aria-live': 'polite' });
  const results = el('ol.road-results', { 'aria-label': t('road.search.results') });
  const credits = el('p.field-hint.road-credits');
  const searchButton = button(t('road.search.go'), { variant: 'primary', size: 'sm', icon: 'search', onclick: () => run() });
  const cancelButton = button(t('road.search.cancel'), { size: 'sm', hidden: true, onclick: () => controller?.abort() });
  const manualInput = el('input.input', { type: 'search', placeholder: t('road.search.manualPlaceholder'), 'aria-label': t('road.search.manualLabel'), maxLength: 200,
    onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void findManual(); } } });
  const manualList = el('ol.road-results', { 'aria-label': t('road.search.manualResults') });
  const manualHint = el('p.field-hint', { 'aria-live': 'polite' });
  const element = el('section.road-search', { 'aria-label': t('road.search.title') },
    el('h3.road-section-title', {}, icon('find', 16), t('road.search.title')),
    scopeText, widthChoice.element, chips,
    el('div.road-search-actions', {}, searchButton, cancelButton), progress, results, credits,
    el('details.road-manual', {}, el('summary', {}, t('road.search.manual')),
      el('div.road-manual-body', {}, el('div.road-manual-row', {}, manualInput, button(t('road.search.find'), { size: 'sm', onclick: () => findManual() })), manualHint, manualList)));

  function renderChips() {
    chips.replaceChildren(...CORRIDOR_CATEGORIES.map((name) => el('button.chip.road-chip', { type: 'button', 'aria-pressed': String(chosen.has(name)),
      onclick: () => { if (chosen.has(name)) chosen.delete(name); else chosen.add(name); renderChips(); } }, icon(name, 15), t(`road.category.${name}`))));
  }

  function linesMap(view) { return new Map([...view.info].map(([key, value]) => [key, value.line])); }
  function nodeName(view, index) { return view.chain.nodes[index]?.name || t('road.untitled'); }

  function resultRow(view, item, { manualItem = false } = {}) {
    const near = detectLeg(view.chain, linesMap(view), [item.lng, item.lat], project);
    const leg = near?.leg ?? null;
    const canEdit = state.canEdit();
    const name = item.name || t(`road.category.${item.category ?? 'sights'}`);
    const meta = [];
    if (Number.isFinite(item.off)) meta.push(t('road.search.off', { distance: formatDistance(item.off) }));
    else if (near) meta.push(t('road.search.off', { distance: formatDistance(near.distance) }));
    if (leg) meta.push(t('road.search.after', { name: nodeName(view, leg.from) }));
    const add = async (via) => {
      if (!leg) { toast(t('road.search.noLeg')); return; }
      try {
        if (via) {
          const done = await ops.addVia(view.chain, leg, [item.lng, item.lat]);
          if (!done) { toast(t('road.search.viaNeedsVisit')); return; }
          announce(t('road.search.viaAdded', { name }));
        } else {
          const night = view.schedule.drives.get(leg.key)?.nights[0]?.at ?? null;
          await ops.insertStop(view.chain, leg, { result: { ...item, category: item.category ?? 'sights', name }, prefs: view.prefs, fraction: near.fraction, night });
          announce(t('road.search.added', { name, after: nodeName(view, leg.from) }));
          toast(t('road.search.added', { name, after: nodeName(view, leg.from) }));
        }
      } catch { toast(t('road.saveFailed')); }
    };
    return el('li.road-result', { dataset: { id: item.id ?? '' } },
      el('span.road-result-icon', { 'aria-hidden': 'true' }, icon(item.category ?? 'stop', 16)),
      el('div.road-result-body', {}, el('span.road-result-name', {}, name), meta.length ? el('span.road-result-meta', {}, meta.join(' · ')) : null, item.address && el('span.road-result-meta', {}, item.address)),
      el('div.road-result-actions', {},
        el('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': t('road.search.showOnMap', { name }), title: t('road.search.showOnMap', { name }), onclick: () => onLocate?.([item.lng, item.lat], item) }, icon('map', 16)),
        canEdit && button(t('road.search.addStop'), { size: 'sm', onclick: () => add(false) }),
        canEdit && manualItem && leg && view.chain.nodes[leg.from].kind === 'visit' && button(t('road.search.addVia'), { size: 'sm', variant: 'ghost', onclick: () => add(true) })));
  }

  function render() {
    const view = getView();
    const corridor = state.corridor;
    scopeText.textContent = t('road.search.scope', { scope: scope.label ?? t('road.search.wholeRoute') });
    searchButton.disabled = !chosen.size || !state.corridorService || corridor.status === 'loading';
    cancelButton.hidden = corridor.status !== 'loading';
    if (!state.corridorService) progress.textContent = t('road.search.unavailable');
    else if (corridor.status === 'loading') progress.textContent = t('road.search.progress', { done: corridor.done ?? 0, total: corridor.total ?? 0 });
    else if (corridor.status === 'offline') progress.textContent = t('road.search.offline');
    else if (corridor.status === 'ready') {
      const notes = [t('road.search.count', { count: corridor.results.length })];
      if (corridor.truncated) notes.push(t('road.search.truncated'));
      if (corridor.failed) notes.push(t('road.search.failed', { count: corridor.failed }));
      progress.textContent = notes.join(' ');
    } else progress.textContent = '';
    results.replaceChildren(...corridor.results.slice(0, 100).map((item) => resultRow(view, item)));
    credits.textContent = corridor.attribution.map((item) => item.text).join(' · ');
    manualList.replaceChildren(...manual.map((item) => resultRow(view, item, { manualItem: true })));
    manualHint.textContent = manualStatus;
  }

  async function run() {
    if (!state.corridorService || !chosen.size) return;
    controller?.abort();
    const current = controller = new AbortController();
    const view = getView();
    const line = scopeLine(view, scope);
    if (!line.length) { toast(t('road.search.noRoute')); return; }
    state.setCorridor({ status: 'loading', results: [], done: 0, total: 0, scope, attribution: [] });
    try {
      const found = await state.corridorService.search(line, {
        categories: [...chosen], widthKm: width, lang, signal: current.signal,
        onProgress: ({ done, total }) => { if (controller === current) state.setCorridor({ done, total }); },
      });
      if (controller !== current) return;
      state.setCorridor({ status: found.offline && !found.results.length ? 'offline' : 'ready', results: found.results, truncated: found.truncated, failed: found.failed, attribution: found.attribution });
      announce(t('road.search.count', { count: found.results.length }));
    } catch (error) {
      if (controller !== current) return;
      state.setCorridor({ status: error?.name === 'AbortError' ? 'idle' : 'error', results: [] });
      if (error?.name !== 'AbortError') toast(t('road.search.error'));
    } finally { if (controller === current) controller = null; }
  }

  async function findManual() {
    const query = manualInput.value.trim();
    if (!query || !services?.geocode) { manualStatus = services?.geocode ? '' : t('road.search.unavailable'); render(); return; }
    manualStatus = t('road.search.finding'); render();
    try {
      const view = getView();
      const first = view.chain.nodes[0]?.point;
      const response = await services.geocode.search(query, { lang, ...(first ? { bias: { lat: first[1], lng: first[0], zoom: 6 } } : {}) });
      manual = (response?.data ?? []).slice(0, 8).map((item) => ({ ...item, category: null }));
      manualStatus = response === null ? t('road.search.offline') : manual.length ? '' : t('road.search.none');
    } catch { manual = []; manualStatus = t('road.search.error'); }
    render();
  }

  renderChips();
  render();
  const off = state.subscribe(render);
  return {
    element,
    render,
    /** Opens the search on a scope, optionally with categories (`refill` picks the vehicle's own). */
    open(next, { categories, search = false } = {}) {
      scope = next;
      if (categories) { chosen.clear(); for (const name of categories === 'refill' ? refillCategories(state.prefs()) : categories) chosen.add(name); renderChips(); }
      render();
      element.scrollIntoView?.({ block: 'nearest' });
      if (search) void run();
      else searchButton.focus();
    },
    destroy() { off(); controller?.abort(); },
  };
}
