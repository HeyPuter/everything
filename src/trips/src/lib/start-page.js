import { isDate } from '../shared/dates.js';
import { spaceRoute } from '../shared/protocol.js';
import { prefs } from './prefs.js';

/**
 * The hash to open at boot for the `startPage` preference, or null for the trips dashboard. `spaces` are `me:spaces`
 * entries. `last` is the trip opened most recently; `current` a trip whose dates include `today` (YYYY-MM-DD), the
 * most recently opened one when several do. The hash has no tab, so the router applies the default trip tab.
 */
export function resolveStartPage({ startPage, spaces, today }) {
  const trips = (Array.isArray(spaces) ? spaces : []).filter((entry) => entry?.ref?.k === 'trip');
  const opened = (entry) => (Number.isSafeInteger(entry.opened) ? entry.opened : -1);
  let candidates = [];
  if (startPage === 'last') candidates = trips.filter((entry) => opened(entry) >= 0);
  else if (startPage === 'current' && isDate(today)) {
    candidates = trips.filter((entry) => isDate(entry.start) && entry.start <= today && today <= (isDate(entry.end) ? entry.end : entry.start));
  }
  const [pick] = candidates.sort((a, b) => opened(b) - opened(a));
  if (!pick) return null;
  try { return spaceRoute(pick.ref); } catch { return null; }
}

const localDate = (now) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Reads the inputs for `resolveStartPage` once preferences are `ready`; null when unknown within `timeout` ms. */
export async function startPageHash({ personal, ready, now = new Date(), timeout = 1500 }) {
  let timer;
  const work = (async () => {
    await ready;
    const { startPage } = prefs();
    if (startPage !== 'last' && startPage !== 'current') return null;
    return resolveStartPage({ startPage, spaces: await personal.spaces.list(), today: localDate(now) });
  })().catch(() => null);
  try { return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, timeout, null); })]); }
  finally { clearTimeout(timer); }
}
