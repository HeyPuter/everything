// Flights view: distance flown and the numbers behind it.
import { el } from '../../ui/dom.js';
import { emptyState } from '../../ui/bits.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatDistance, formatNumber } from '../../lib/format.js';
import { icon } from './icons.js';
import { plural } from './text.js';

const stopName = (stop) => stop.code || stop.name || '';
const yearLabel = (year) => { try { return new Intl.NumberFormat(locale, { useGrouping: false }).format(year); } catch { return String(year); } };

/** `stats` from `flightStats`; `uncached` is the number of trips not on this device. */
export function flightsView({ stats, uncached = 0 }) {
  const nodes = [el('h2.atlas-view-title', {}, t('atlas.view.flights'))];
  if (!stats?.flights) {
    nodes.push(emptyState({ title: t('atlas.flights.emptyTitle'), body: t('atlas.flights.emptyBody'), icon: 'plane' }));
  } else {
    const row = (label, value, iconName) => el('div.atlas-fact', {}, el('dt', {}, icon(iconName, 16), label), el('dd', {}, value));
    const longest = stats.longest;
    nodes.push(el('dl.atlas-facts', { 'aria-label': t('atlas.flights.summary') },
      row(t('atlas.flights.total'), formatDistance(stats.meters), 'route'),
      row(t('atlas.flights.count'), formatNumber(stats.flights), 'plane'),
      row(t('atlas.flights.airports'), formatNumber(stats.airports), 'pin'),
      row(t('atlas.flights.around'), t('atlas.flights.aroundValue', { count: formatNumber(stats.aroundEarth, { digits: stats.aroundEarth < 10 ? 2 : 1 }) }), 'earth'),
      longest ? row(t('atlas.flights.longest'), el('span.atlas-fact-stack', {},
        el('span', {}, t('atlas.flights.route', { from: stopName(longest.from), to: stopName(longest.to) })),
        el('span.atlas-row-sub', {}, formatDistance(longest.meters))), 'flag') : null));
    nodes.push(el('section.atlas-section', {}, el('h3', {}, el('span', {}, t('atlas.flights.byYear'))),
      el('ul.atlas-years', {}, stats.byYear.map((year) => el('li', {},
        el('span.atlas-year', {}, yearLabel(year.year)),
        el('span.atlas-row-sub', {}, t('atlas.flights.yearDetail', { distance: formatDistance(year.meters), flights: plural('atlas.stat.flights', year.flights) })))))));
    nodes.push(el('p.atlas-hint', {}, t('atlas.flights.hint')));
  }
  if (stats?.unresolved) nodes.push(el('p.atlas-hint', {}, plural('atlas.flights.unresolved', stats.unresolved)));
  if (uncached) nodes.push(el('p.atlas-hint', {}, plural('atlas.uncached', uncached)));
  return nodes;
}
