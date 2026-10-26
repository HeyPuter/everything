import { el, uid } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { dedupeResults } from '../../../services/index.js';
import { coords } from '../../../lib/route-plan/index.js';
import { icon } from './icons.js';

const LOCAL_LIMIT = 5;
const REMOTE_LIMIT = 8;
const normalized = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const SOURCES = { trip: 'planMap.source.trip', photon: 'planMap.source.photon', nominatim: 'planMap.source.nominatim', geoapify: 'planMap.source.geoapify' };
export const sourceLabel = (source) => t(SOURCES[source] ?? 'planMap.source.other');

/**
 * Place search over the map: trip places first, then Photon autocomplete biased by `bias()`; Enter runs a full
 * search (Photon, then Nominatim). `onChoose(result)` gets `{source, name, address, lat, lng, osm?, wikidata?, kind?, placeId?}`.
 */
export function createSearch({ services, lang, bias, places, onChoose, announce }) {
  const listId = uid('planmap-results');
  const inputId = uid('planmap-search');
  let results = []; let active = -1; let controller = null; let closed = false; let query = '';
  const input = el('input.input', {
    id: inputId, type: 'search', autocomplete: 'off', spellcheck: false, placeholder: t('planMap.searchPlaceholder'),
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, enterKeyHint: 'search',
  });
  const list = el('ul.planmap-results', { id: listId, role: 'listbox', 'aria-label': t('planMap.searchResults'), hidden: true });
  const note = el('p.planmap-search-note', { hidden: true });
  const clearButton = el('button.icon-btn.icon-btn-sm.planmap-search-clear', { type: 'button', 'aria-label': t('planMap.clearSearch'), title: t('planMap.clearSearch'), hidden: true, onclick: () => { reset(); input.focus(); } }, icon('dismiss', 16));
  const element = el('div.planmap-search', { role: 'search' },
    el('label.sr-only', { for: inputId }, t('planMap.searchLabel')),
    el('div.input-prefix', {}, icon('find', 18), input, clearButton),
    list, note);

  function setNote(text) { note.textContent = text ?? ''; note.hidden = !text; }
  function local(q) {
    const needle = normalized(q);
    if (!needle) return [];
    return places().filter((place) => coords(place) && normalized(place.name).includes(needle)).slice(0, LOCAL_LIMIT)
      .map((place) => ({ source: 'trip', id: `trip:${place.id}`, placeId: place.id, name: place.name ?? '', address: place.address ?? '', lat: place.lat, lng: place.lng }));
  }
  function show(next) {
    results = next; active = -1;
    list.replaceChildren(...results.map((result, index) => el('li.planmap-result', {
      id: `${listId}-${index}`, role: 'option', 'aria-selected': 'false',
      onpointerdown: (event) => event.preventDefault(),
      onclick: () => choose(index),
    },
    el('span.planmap-result-name', {}, result.name || t('planMap.unnamedPlace')),
    result.address && el('span.planmap-result-address', {}, result.address),
    el('span.planmap-result-source', {}, sourceLabel(result.source)))));
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(results.length > 0));
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    active = index;
    list.querySelectorAll('[role=option]').forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) { input.setAttribute('aria-activedescendant', `${listId}-${index}`); list.children[index]?.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function merge(q, remote) {
    const own = local(q);
    const others = dedupeResults([...own, ...dedupeResults(remote ?? [])]).filter((result) => result.source !== 'trip').slice(0, REMOTE_LIMIT);
    return [...own, ...others];
  }
  async function lookup(q, full) {
    controller?.abort();
    const current = controller = new AbortController();
    const remote = services?.geocode;
    if (!remote || (!full && q.length < 3)) return;
    setNote(t('planMap.searching'));
    try {
      const options = { bias: bias(), lang, signal: current.signal };
      const response = full ? await remote.search(q, options) : await remote.autocomplete(q, options);
      if (closed || current !== controller || q !== query) return;
      if (!response) { setNote(navigator.onLine === false ? t('planMap.searchOffline') : t('planMap.searchUnavailable')); return; }
      const next = merge(q, response.data);
      show(next);
      const credit = (response.attribution ?? []).map((item) => item?.text).filter(Boolean).join(' · ');
      setNote(next.length ? credit : t('planMap.noResults'));
      if (full) announce(next.length ? t('planMap.resultsCount', { count: next.length }) : t('planMap.noResults'));
    } catch (error) {
      if (error?.name === 'AbortError' || closed || current !== controller) return;
      setNote(t('planMap.searchFailed'));
    }
  }
  function choose(index) {
    const result = results[index];
    if (!result) return;
    list.hidden = true; input.setAttribute('aria-expanded', 'false');
    onChoose(result);
  }
  function reset() {
    controller?.abort(); controller = null; query = '';
    input.value = ''; clearButton.hidden = true; show([]); setNote('');
  }
  input.addEventListener('input', () => {
    query = input.value.trim();
    clearButton.hidden = !input.value;
    show(local(query));
    setNote('');
    if (query.length >= 3) void lookup(query, false);
    else controller?.abort();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); list.hidden = false; highlight((active + 1) % results.length); }
    else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); highlight(active <= 0 ? results.length - 1 : active - 1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) choose(active);
      else if (query) void lookup(query, true);
    } else if (event.key === 'Escape') {
      if (!list.hidden) { event.preventDefault(); event.stopPropagation(); list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
      else if (input.value) { event.preventDefault(); event.stopPropagation(); reset(); }
    }
  });
  input.addEventListener('focus', () => { if (results.length) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
  input.addEventListener('blur', () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); highlight(-1); });

  return {
    element,
    focus: () => input.focus(),
    destroy() { closed = true; controller?.abort(); },
  };
}
