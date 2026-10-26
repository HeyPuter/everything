import { el } from '../../ui/dom.js';
import { button, chip, emptyState } from '../../ui/bits.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatDate, formatDistance, formatNumber } from '../../lib/format.js';
import { spaceRoute } from '../../shared/protocol.js';
import { COUNTRY_CODES, continentOf, searchText } from '../../lib/atlas/countries.js';
import { icon } from './icons.js';
import { continentLabel, listText, nameOf, plural } from './text.js';

const MAX_RESULTS = 60;

// Kit buttons with an icon the kit may not carry.
function btn(label, iconName, attrs) {
  const node = button(label, attrs);
  if (iconName) node.prepend(icon(iconName, 16));
  return node;
}

function stat(label, value, sub, iconName) {
  return el('div.atlas-stat', {}, el('dt', {}, icon(iconName, 16), label), el('dd', {}, el('strong', {}, value), sub && el('span.atlas-stat-sub', {}, sub)));
}

/** Stat tiles; `atlas` is null while loading. `regions` is `regionTotals` output, `flights` is `flightStats` output. */
export function statsView(atlas, { showPlanned, regions = null, flights = null }) {
  if (!atlas) return Array.from({ length: 9 }, () => el('div.atlas-stat.atlas-stat-loading', { 'aria-hidden': 'true' }, el('div.skeleton'), el('div.skeleton')));
  const s = atlas.stats;
  return [
    stat(t('atlas.stat.countries'), formatNumber(s.countries), showPlanned && s.planned ? t('atlas.stat.planned', { count: formatNumber(s.planned) }) : null, 'flag'),
    stat(t('atlas.stat.continents'), formatNumber(s.continents), s.continentList.length ? listText(s.continentList.map(continentLabel)) : null, 'globe'),
    stat(t('atlas.stat.trips'), formatNumber(s.trips), showPlanned && s.plannedTrips ? t('atlas.stat.upcoming', { count: formatNumber(s.plannedTrips) }) : null, 'plane'),
    stat(t('atlas.stat.places'), formatNumber(s.places), null, 'pin'),
    stat(t('atlas.stat.travelDays'), formatNumber(s.travelDays), null, 'days'),
    stat(t('atlas.stat.streak'), formatNumber(s.streak), null, 'streak'),
    stat(t('atlas.stat.thisYear'), formatNumber(s.tripsThisYear), null, 'calendar'),
    stat(t('atlas.stat.regions'), formatNumber(regions?.regions ?? 0), regions?.countries ? plural('atlas.stat.regionsIn', regions.countries) : null, 'region'),
    stat(t('atlas.stat.distance'), flights?.flights ? formatDistance(flights.meters) : formatNumber(0), flights?.flights ? plural('atlas.stat.flights', flights.flights) : null, 'route'),
  ];
}

function subline(country) {
  if (!country) return t('atlas.status.none');
  if (country.status === 'planned') return t('atlas.nextTrip', { date: formatDate(country.next) });
  if (country.last) return t('atlas.lastVisited', { date: formatDate(country.last) });
  if (country.manual) return t('atlas.markedByYou');
  return t(`atlas.status.${country.status}`);
}

function row(code, country, onSelect) {
  return el('li', {}, el('button.atlas-row', { type: 'button', dataset: { focus: `row:${code}` }, onclick: () => onSelect(code) },
    el('span.atlas-row-text', {}, el('span.atlas-row-name', {}, nameOf(code)), el('span.atlas-row-sub', {}, subline(country))),
    country?.status === 'visited' ? el('span.atlas-row-mark', {}, icon('visited', 16)) : null));
}

function section(title, count, children, hint) {
  return el('section.atlas-section', {}, el('h3', {}, el('span', {}, title), el('span.atlas-count', {}, formatNumber(count))),
    hint && el('p.atlas-hint', {}, hint), el('ul.atlas-list', {}, children));
}

/** The default list: visited countries, most recent first, then planned and hidden ones. */
export function boardView({ atlas, showPlanned, warming, canWarm, onSelect, onShow, onWarm }) {
  const nodes = [];
  const countries = atlas.countries;
  if (!atlas.visited.length && !(showPlanned && atlas.planned.length) && !atlas.hidden.length && !atlas.uncached) {
    nodes.push(emptyState({ title: t('atlas.emptyTitle'), body: t('atlas.emptyBody'), icon: 'globe' }));
  }
  if (atlas.visited.length) nodes.push(section(t('atlas.visited'), atlas.visited.length, atlas.visited.map((code) => row(code, countries.get(code), onSelect))));
  if (showPlanned && atlas.planned.length) nodes.push(section(t('atlas.planned'), atlas.planned.length, atlas.planned.map((code) => row(code, countries.get(code), onSelect))));
  if (atlas.hidden.length) {
    nodes.push(section(t('atlas.hidden'), atlas.hidden.length, atlas.hidden.map((code) => el('li.atlas-hidden-row', {},
      el('button.atlas-row', { type: 'button', dataset: { focus: `row:${code}` }, onclick: () => onSelect(code) }, el('span.atlas-row-text', {}, el('span.atlas-row-name', {}, nameOf(code)))),
      btn(t('atlas.show'), 'show', { size: 'sm', variant: 'ghost', 'aria-label': t('atlas.showLabel', { country: nameOf(code) }), dataset: { focus: `show:${code}` }, onclick: () => onShow(code) }))), t('atlas.hiddenHint')));
  }
  if (atlas.uncached) {
    const note = el('div.atlas-note', { role: warming ? 'status' : null }, el('p', {}, warming ? t('atlas.loadingTrips', { done: formatNumber(warming.done), total: formatNumber(warming.total) }) : plural('atlas.uncached', atlas.uncached)));
    if (canWarm && !warming) note.append(button(t('atlas.loadTrips'), { size: 'sm', variant: 'outline', dataset: { focus: 'warm' }, onclick: onWarm }));
    nodes.push(note);
  }
  return nodes;
}

/** Search results over every country, by name (accent-insensitive) or ISO code. */
export function searchCountries(query) {
  const needle = searchText(query.trim(), locale);
  if (!needle) return [];
  const upper = query.trim().toUpperCase();
  return COUNTRY_CODES.map((code) => ({ code, name: nameOf(code) }))
    .filter(({ code, name }) => code === upper || searchText(name, locale).includes(needle))
    .sort((a, b) => Number(b.code === upper) - Number(a.code === upper) || Number(searchText(b.name, locale).startsWith(needle)) - Number(searchText(a.name, locale).startsWith(needle)) || a.name.localeCompare(b.name, locale))
    .slice(0, MAX_RESULTS);
}

export function resultsView({ atlas, query, results, onSelect }) {
  if (!results.length) return [el('p.atlas-hint.atlas-empty-results', {}, t('atlas.noResults', { query: query.trim() }))];
  return [el('ul.atlas-list', {}, results.map(({ code }) => row(code, atlas.countries.get(code), onSelect)))];
}

function tripHref(ref) {
  try { return `${spaceRoute(ref)}/plan`; } catch { return null; }
}

function placesView(country, trips) {
  const groups = new Map();
  for (const item of country?.items ?? []) {
    if (!item.tripKey) continue;
    const group = groups.get(item.tripKey) ?? new Map();
    group.set(`${item.kind}:${item.id}`, item);
    groups.set(item.tripKey, group);
  }
  if (!groups.size) return el('p.atlas-hint', {}, t('atlas.noPlaces'));
  return el('ul.atlas-trips', {}, [...groups].map(([tripKey, items]) => {
    const trip = trips.get(tripKey);
    const title = trip?.title || t('atlas.untitled');
    const planned = [...items.values()].every((item) => item.planned);
    const href = trip ? tripHref(trip.ref) : null;
    return el('li.atlas-trip', {},
      el('div.atlas-trip-head', {}, href ? el('a.atlas-trip-link', { href, 'aria-label': t('atlas.openTrip', { trip: title }) }, title) : el('span.atlas-trip-link', {}, title),
        planned && chip(t('atlas.upcoming'))),
      el('ul.atlas-items', {}, [...items.values()].map((item) => el('li.atlas-item', {},
        icon(item.kind === 'res' ? 'booking' : 'pin', 16),
        el('span.atlas-item-name', {}, item.name || (item.kind === 'res' ? t('atlas.booking') : '')),
        item.kind === 'res' && item.name ? el('span.sr-only', {}, ` (${t('atlas.booking')})`) : null,
        item.mine && chip(t('atlas.placeVisited'), { status: 'success' })))));
  }));
}

/**
 * One country: status, mark and hide actions, its regions (`regions`, nodes from `regionsSection`), its bucket-list
 * items (`bucket`, nodes) and the places trips have there.
 */
export function detailView({ code, atlas, trips, drawn, busy, regions = [], bucket = [], onBack, onMark, onHide }) {
  const country = atlas.countries.get(code) ?? null;
  const status = country?.status ?? 'none';
  const reasons = [];
  if (country?.manual) reasons.push(t('atlas.markedByYou'));
  if (country?.bucket) reasons.push(t('atlas.fromBucket'));
  if (country?.trips.size) reasons.push(plural('atlas.fromTrips', country.trips.size));
  const reachable = Boolean(country?.trips.size);
  const actions = el('div.atlas-actions', {},
    btn(t(country?.manual ? 'atlas.unmark' : 'atlas.mark'), country?.manual ? 'close' : 'check', { variant: country?.manual ? 'outline' : 'primary', size: 'sm', busy, dataset: { focus: 'mark' }, onclick: () => onMark(code, !country?.manual) }),
    reachable || country?.hidden ? btn(t(country?.hidden ? 'atlas.unhide' : 'atlas.hide'), country?.hidden ? 'show' : 'hide', { variant: 'ghost', size: 'sm', busy, dataset: { focus: 'hide' }, onclick: () => onHide(code, !country?.hidden) }) : null);
  return [el('div.atlas-detail', {},
    btn(t('atlas.back'), 'arrowLeft', { variant: 'ghost', size: 'sm', dataset: { focus: 'back' }, onclick: onBack }),
    el('h2.atlas-detail-title', { tabIndex: -1, dataset: { focus: 'title' } }, nameOf(code)),
    el('p.atlas-detail-meta', {}, continentLabel(continentOf(code))),
    el('p.atlas-status', { dataset: { status } }, icon(status === 'visited' ? 'visited' : status === 'hidden' ? 'hide' : status === 'planned' ? 'calendar' : 'flag', 16),
      el('strong', {}, t(`atlas.status.${status}`)), reasons.length ? el('span', {}, `· ${listText(reasons)}`) : null),
    country?.last ? el('p.atlas-hint', {}, t('atlas.lastVisited', { date: formatDate(country.last) })) : null,
    drawn ? null : el('p.atlas-hint', {}, t('atlas.notDrawn')),
    actions,
    reachable && !country?.hidden ? el('p.atlas-hint', {}, t('atlas.hideHint')) : null,
    ...regions,
    ...bucket,
    el('h3.atlas-subhead', {}, t('atlas.placesHeading')),
    placesView(country, trips))];
}
