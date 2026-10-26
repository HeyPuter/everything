// Journey numbers for stats elements.
import { t, strings } from '../../../lib/i18n/index.js';
import { formatDistance, formatNumber } from '../../../lib/format.js';
import { journeyStats, writtenEntries } from '../model.js';
import { isImageFile } from '../media.js';

/** Stats over the journey's written entries, counting photos that are live image files. */
export function bookStats(space) {
  return journeyStats(space.select.entry.all(), { isPhoto: (id) => isImageFile(space.get('file', id)) });
}

/** Written entries in story order, the order travel elements follow. */
export const storyEntries = (space) => writtenEntries(space.select.entry.all());

/** A count string, using the `<key>.one` variant for exactly one. */
export function countText(key, count, values = {}) {
  const one = `${key}.one`;
  return count === 1 && Object.hasOwn(strings, one) ? t(one, values) : t(key, { ...values, count: formatNumber(count) });
}

const ONE = Object.freeze({
  entries: (stats) => countText('book.stat.entries', stats.entries),
  days: (stats) => countText('book.stat.days', stats.days),
  places: (stats) => countText('book.stat.places', stats.places),
  countries: (stats) => countText('book.stat.countries', stats.countries.length),
  photos: (stats) => countText('book.stat.photos', stats.photos),
  distance: (stats) => formatDistance(stats.meters),
  words: (stats) => countText('book.stat.words', stats.words),
});

/** One stat, or a summary line of the main ones. */
export function statsText(stats, stat) {
  if (!stats) return '';
  if (Object.hasOwn(ONE, stat)) return ONE[stat](stats);
  return ['days', 'entries', 'countries', 'photos', ...(stats.meters > 0 ? ['distance'] : [])].map((key) => ONE[key](stats)).join(' · ');
}
