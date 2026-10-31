import './atlas.css';
import { el } from '../../ui/dom.js';
import { t } from '../../lib/i18n/index.js';
import { aggregateAtlas, localToday } from '../../lib/atlas/aggregate.js';
import { MARKS_KEY, loadTrips, normalizeMarks, tripInput } from '../../lib/atlas/data.js';
import { BUCKET_INDEX, bucketEntries } from '../../lib/atlas/bucket.js';
import { icon } from './icons.js';
import { nameOf, plural } from './text.js';

const RECENT = 5;

/**
 * Dashboard tile: countries and continents and a link to the atlas, from local data only (places without a stored
 * country code are left out; the atlas page resolves them). Returns a cleanup function.
 */
export function mountAtlasTile(container, context) {
  const session = context.session ?? null;
  const personal = session?.personal ?? context.personal;
  const self = context.account?.uuid ?? session?.account?.uuid ?? null;
  let closed = false;
  const body = el('div.atlas-tile-body', { 'aria-busy': 'true' });
  container.replaceChildren(el('section.atlas-tile', { 'aria-label': t('atlas.title') },
    el('h3.atlas-tile-title', {}, icon('globe', 16), t('atlas.title')), body,
    el('a.atlas-tile-link', { href: '#/atlas' }, t('atlas.tile.open'))));

  async function render() {
    try {
      const [items, marks, bucket] = await Promise.all([loadTrips({ personal, db: session?.db ?? null }), personal.get(MARKS_KEY).catch(() => null), personal.get(BUCKET_INDEX).catch(() => null)]);
      if (closed) return;
      const atlas = aggregateAtlas({ trips: items.map(({ entry, replica }) => tripInput(entry, replica)), marks: normalizeMarks(marks), bucket: bucketEntries(bucket), uid: self, today: localToday() });
      const recent = atlas.visited.slice(0, RECENT);
      body.replaceChildren(
        el('p.atlas-tile-count', {}, el('strong', {}, plural('atlas.tile.countries', atlas.stats.countries)), ' · ', plural('atlas.tile.continents', atlas.stats.continents)),
        recent.length ? el('div.atlas-tile-recent', {}, el('span.atlas-hint', {}, t('atlas.tile.recent')), el('ul.atlas-tile-list', {}, recent.map((code) => el('li', {}, nameOf(code)))))
          : el('p.atlas-hint', {}, t('atlas.tile.empty')));
    } catch {
      if (!closed) body.replaceChildren(el('p.atlas-hint', {}, t('atlas.loadError')));
    } finally { if (!closed) body.removeAttribute('aria-busy'); }
  }
  void render();
  const offs = [MARKS_KEY, BUCKET_INDEX].map((key) => personal.subscribe(key, () => { void render(); }));
  return () => { closed = true; for (const off of offs) off?.(); };
}
