// The parts of a trip's public link that cover more than the trip (spec §9 and §22 [3]): its road trip, drawn with the
// road-trip view over the read-only projection, and its journey, a card that opens the journey's own public link.
import './combined.css';
import { el } from '../../../ui/dom.js';
import { spinner } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatDateRange } from '../../../lib/format.js';
import { fetchPublic } from '../../../lib/api.js';
import { isId } from '../../../shared/ids.js';
import { WORKER_PATTERN } from '../../../shared/protocol.js';

/** The `journey` field of a `/pub` body, checked as untrusted input. */
export const cleanJourneyLink = (value) => (value && typeof value === 'object' && WORKER_PATTERN.test(value.w ?? '') && isId(value.s) && /^[0-9a-f]{32}$/.test(value.token ?? '')
  ? Object.freeze({ w: value.w, s: value.s, token: value.token }) : null);

/** The hash route of a journey's public link. */
export const journeyRoute = (link) => `#/s/${link.w}/${link.s}/${link.token}`;

/**
 * Mounts the road-trip view, read-only, into `slot`. `services` are the viewer's anonymous services (routes stay
 * estimates without them). Returns the cleanup.
 */
export async function mountPublicRoad(slot, { space, plan, services, signal }) {
  slot.replaceChildren(el('div.public-loading', {}, spinner()));
  try {
    const [{ roadState }, { createRoadOps }, { mountRoadPanel }] = await Promise.all([
      import('../../trip/road/state.js'), import('../../trip/road/ops.js'), import('../../trip/road/panel.js'),
    ]);
    if (signal?.aborted) return () => {};
    const session = services ? { services } : null;
    const state = roadState(space, session);
    const release = state.retain();
    state.setActive(true);
    let lang = 'en';
    try { lang = new Intl.Locale(globalThis.navigator?.language ?? 'en').language; } catch { lang = 'en'; }
    const panel = mountRoadPanel(slot, { space, session, plan, state, ops: createRoadOps(space), lang, account: null, signal });
    return () => { state.setActive(false); panel?.destroy?.(); release(); };
  } catch {
    slot.replaceChildren(el('p.public-empty', { role: 'alert' }, t('publicLink.roadFailed')));
    return () => {};
  }
}

const statusKey = (status) => (['upcoming', 'ongoing', 'completed'].includes(status) ? `publicLink.journeyStatus.${status}` : null);

/**
 * A card for the attached journey: its title, status and latest entries from its own public link, and a link that
 * opens it. Loads once; a link that stopped working says so.
 */
export function journeyCard({ link, puter, signal }) {
  const root = el('section.public-card.public-journey', {}, el('div.public-loading', {}, spinner(), el('p', {}, t('publicLink.journeyLoading'))));
  const open = el('a.btn.btn-primary', { href: journeyRoute(link) }, t('publicLink.journeyOpen'));
  void (async () => {
    try {
      const result = await fetchPublic(puter, { worker: link.w, space: link.s, token: link.token }, { signal });
      if (signal?.aborted) return;
      if (result.data?.kind !== 'journey') throw Object.assign(new Error('not_journey'), { status: 404 });
      const { cleanJourneyProjection } = await import('../../journey/public/data.js');
      const journey = cleanJourneyProjection(result.data);
      const entries = [...journey.entries].filter((entry) => entry.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const dates = entries.length ? formatDateRange(entries.at(-1).date, entries[0].date) : '';
      const status = statusKey(journey.meta.status);
      const count = entries.length === 1 ? t('publicLink.journeyEntriesOne') : t('publicLink.journeyEntries', { count: new Intl.NumberFormat().format(entries.length) });
      root.replaceChildren(...[
        el('h3.public-card-title', {}, journey.meta.title || t('publicLink.journeyUntitled')),
        journey.meta.subtitle ? el('p.public-sub', {}, journey.meta.subtitle) : null,
        el('p.public-hint', {}, [status && t(status), count, dates].filter(Boolean).join(' · ')),
        entries.length ? el('ul.public-rows', {}, entries.slice(0, 5).map((entry) => el('li.public-row.public-line', {},
          el('span.public-row-title', {}, entry.title), el('span.public-row-meta', {}, formatDate(entry.date, { year: false }))))) : null,
        el('div.public-actions', {}, open)].filter(Boolean));
    } catch (error) {
      if (signal?.aborted) return;
      root.replaceChildren(el('p.public-empty', { role: 'alert' }, error?.status === 404 ? t('publicLink.journeyGone') : t('public.errorBody')), el('div.public-actions', {}, open));
    }
  })();
  return root;
}
