// Journey numbers: days, entries, places, countries, photos, words, distance, moods, weather and top tags.
import { el, uid, append, clear } from '../../ui/dom.js';
import { emptyState } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { formatDateRange, formatDistance, formatNumber } from '../../lib/format.js';
import { MOODS, WEATHER } from './constants.js';
import { icon } from './icons.js';
import { journeyStats } from './model.js';
import { fileOf, isImageFile, isVideoFile } from './media.js';

const countryName = (cc) => { try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };

function tile(labelKey, value, sub = '') {
  return el('div.jr-stat', {}, el('span.jr-stat-value.num', {}, value), el('span.jr-stat-label', {}, t(labelKey)), sub && el('span.jr-muted', {}, sub));
}

function bars(titleKey, counts, keys, labelPrefix) {
  const total = keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  if (!total) return null;
  const id = uid('jr-bars');
  return el('section.jr-stat-section', { 'aria-labelledby': id }, el('h3', { id }, t(titleKey)),
    el('ul.jr-bars', {}, keys.filter((key) => counts[key]).map((key) => {
      const share = Math.round((counts[key] / total) * 100);
      return el('li.jr-bar', {}, el('span.jr-bar-label', {}, icon(key, 16), t(`${labelPrefix}.${key}`)),
        el('span.jr-bar-track', { 'aria-hidden': 'true' }, el('span.jr-bar-fill', { style: { inlineSize: `${share}%` } })),
        el('span.jr-bar-value.num', {}, t('journey.statShare', { count: formatNumber(counts[key]), share: formatNumber(share) })));
    })));
}

/** `ctx`: `{space}`. Returns `{render(), destroy()}`. */
export function mountStats(container, { space }) {
  const root = el('div.jr-stats');
  container.replaceChildren(root);
  function render() {
    const stats = journeyStats(space.select.entry.all(), { isPhoto: (id) => { const file = fileOf(space, id); return isImageFile(file) || isVideoFile(file); } });
    if (!stats.entries) { root.replaceChildren(emptyState({ title: t('journey.statsEmpty'), body: t('journey.statsEmptyBody'), icon: 'pin' })); return; }
    const tagsId = uid('jr-tags');
    const countriesId = uid('jr-countries');
    append(clear(root), [
      el('p.jr-muted', {}, [formatDateRange(stats.first, stats.last, { style: 'long' }), t('journey.statsNote')].filter(Boolean).join(' · ')),
      el('div.jr-stat-grid', {},
        tile('journey.statDays', formatNumber(stats.days), stats.span > stats.days ? t('journey.statSpan', { count: formatNumber(stats.span) }) : ''),
        tile('journey.statEntries', formatNumber(stats.entries)),
        tile('journey.statPlaces', formatNumber(stats.places)),
        tile('journey.statCountries', formatNumber(stats.countries.length)),
        tile('journey.statPhotos', formatNumber(stats.photos)),
        tile('journey.statWords', formatNumber(stats.words)),
        tile('journey.statDistance', formatDistance(stats.meters), t('journey.statDistanceHint'))),
      stats.countries.length > 0 && el('section.jr-stat-section', { 'aria-labelledby': countriesId }, el('h3', { id: countriesId }, t('journey.statCountryList')),
        el('ul.jr-tags', {}, stats.countries.map((cc) => el('li.chip', {}, countryName(cc))))),
      bars('journey.statMoods', stats.moods, MOODS, 'journey.mood'),
      bars('journey.statWeather', stats.weather, WEATHER, 'journey.weather'),
      stats.tags.length > 0 && el('section.jr-stat-section', { 'aria-labelledby': tagsId }, el('h3', { id: tagsId }, t('journey.statTags')),
        el('ul.jr-tags', {}, stats.tags.map((item) => el('li.chip', {}, item.tag, el('span.jr-muted.num', {}, ` ${formatNumber(item.count)}`)))))]);
  }
  render();
  return { render, destroy() { container.replaceChildren(); } };
}
